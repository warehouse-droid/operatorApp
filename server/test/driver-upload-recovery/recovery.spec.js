import {expect, test} from "../mbt/e2e/mbt-e2e-test.js";
import {query} from "../../src/db.js";
import {readyGroupedDropoff} from "../support/driver-upload-stall-fixture.mjs";
import fs from "node:fs";

test.beforeEach(async ({page, browserName}) => {
  if (browserName === "chromium") await page.coverage.startJSCoverage({resetOnNavigation: false});
});

test.afterEach(async ({page, browserName}, testInfo) => {
  if (browserName !== "chromium") return;
  const coverage = (await page.coverage.stopJSCoverage()).filter(entry => /\/driver(?:-upload)?\.js\?/u.test(entry.url));
  fs.writeFileSync(testInfo.outputPath("driver-coverage.json"), JSON.stringify(coverage));
});

async function capture(page, testInfo, name) {
  const screenshot = testInfo.outputPath(`${name}.png`);
  await page.screenshot({path: screenshot, fullPage: true});
  await testInfo.attach(name, {path: screenshot, contentType: "image/png"});
  const state = await page.evaluate(() => ({
    jobId: currentJob?.jobId, jobStatus: currentJob?.status,
    progressHidden: document.querySelector("#driverUploadStatus").hidden,
    progressLabel: document.querySelector("[data-driver-upload-label]").textContent,
    percentage: document.querySelector("[data-driver-upload-current]").value,
    overall: document.querySelector("[data-driver-upload-overall]").textContent,
    mutationPending: Boolean(activeDriverMutationToken),
    reconciliationPending: driverUploadSaveChecks.size,
    photoPromptOpen, photoCount: photos.filter(Boolean).length
  }));
  await testInfo.attach(`${name}-state`, {body: JSON.stringify(state, null, 2), contentType: "application/json"});
  fs.writeFileSync(testInfo.outputPath(`${name}.json`), JSON.stringify(state, null, 2));
  console.log(JSON.stringify({case: testInfo.title, browser: testInfo.project.name, checkpoint: name, ...state}));
  return state;
}

test("lost save response automatically advances a confirmed grouped stop without resubmission", async ({page, browserName}, testInfo) => {
  const {job} = await readyGroupedDropoff(page, browserName);
  let submissions = 0;
  await page.route("**/api/driver/jobs/*/photos", async route => {
    submissions += 1;
    const response = await route.fetch();
    expect(response.status(), await response.text()).toBe(200);
    await route.abort("failed");
  });
  const logged = page.waitForResponse(response => response.url().endsWith("/api/driver/upload-failures"));
  await page.locator('.photo-modal [data-action="complete-job"]').click();
  expect((await logged).status()).toBe(200);
  const saved = (await query("SELECT status, jsonb_array_length(photo_data_urls) AS photos FROM driver_job_records WHERE job_id=$1", [job.jobId])).rows[0];
  expect(saved).toEqual({status: "complete", photos: 2});
  await expect(page.locator(".photo-modal")).toBeHidden();
  const state = await capture(page, testInfo, "lost-response-recovers-automatically");
  expect(state.jobId).not.toBe(job.jobId);
  expect(state.reconciliationPending).toBe(0);
  expect(state.photoCount).toBe(0);
  expect(submissions).toBe(1);
});

test("withheld save response advances automatically after the two minute client timeout", async ({page, browserName}, testInfo) => {
  const {job} = await readyGroupedDropoff(page, browserName);
  await page.clock.install();
  let saved = false;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route("**/api/driver/jobs/*/photos", async route => {
    const response = await route.fetch();
    expect(response.status(), await response.text()).toBe(200);
    saved = true;
    await held;
    await route.abort("failed").catch(() => {});
  });
  try {
    await page.locator('.photo-modal [data-action="complete-job"]').click();
    await expect.poll(() => saved).toBe(true);
    const state = await capture(page, testInfo, "100-percent-waiting-for-save-response");
    expect(state.percentage).toBe(100);
    expect(state.mutationPending).toBe(true);
    const logged = page.waitForResponse(response => response.url().endsWith("/api/driver/upload-failures"));
    await page.clock.fastForward(121000);
    expect((await logged).status()).toBe(200);
    await expect(page.locator(".photo-modal")).toBeHidden();
    const after = await capture(page, testInfo, "timeout-recovers-confirmed-stop");
    expect(after.jobId).not.toBe(job.jobId);
    expect(after.mutationPending).toBe(false);
    expect(after.reconciliationPending).toBe(0);
  } finally { release(); }
});

test("stalled local photo bookkeeping releases after five seconds and completes with both photos", async ({page, browserName}, testInfo) => {
  const {job} = await readyGroupedDropoff(page, browserName);
  await page.clock.install();
  await page.evaluate(() => {
    const original = window.DriverOfflineDB.markPhotoUploaded;
    let calls = 0;
    window.__stallBookkeepingReached = false;
    window.DriverOfflineDB.markPhotoUploaded = (...args) => {
      if (++calls !== 2) return original(...args);
      window.__stallBookkeepingReached = true;
      return new Promise(() => {});
    };
  });
  await page.locator('.photo-modal [data-action="complete-job"]').click();
  await expect.poll(() => page.evaluate(() => window.__stallBookkeepingReached)).toBe(true);
  await expect(page.locator("#driverUploadStatus")).toBeVisible();
  await expect(page.locator("[data-driver-upload-overall]")).toHaveText("Overall: 100%");
  await page.clock.fastForward(5100);
  await expect(page.locator(".photo-modal")).toBeHidden();
  const state = await capture(page, testInfo, "local-bookkeeping-timeout-recovers");
  expect(state.jobId).not.toBe(job.jobId);
  expect(state.mutationPending).toBe(false);
  const record = (await query("SELECT status, jsonb_array_length(photo_data_urls) AS photos FROM driver_job_records WHERE job_id=$1", [job.jobId])).rows[0];
  expect(record).toEqual({status: "complete", photos: 2});
});

test("stalled post-save draft deletion releases after five seconds", async ({page, browserName}, testInfo) => {
  const {job} = await readyGroupedDropoff(page, browserName);
  await page.clock.install();
  await page.evaluate(() => {
    window.__cleanupReached = false;
    window.DriverOfflineDB.deleteDraftPhoto = () => {
      window.__cleanupReached = true;
      return new Promise(() => {});
    };
  });
  await page.locator('.photo-modal [data-action="complete-job"]').click();
  await expect.poll(() => page.evaluate(() => window.__cleanupReached)).toBe(true);
  const record = (await query("SELECT status FROM driver_job_records WHERE job_id=$1", [job.jobId])).rows[0];
  expect(record.status).toBe("complete");
  await page.clock.fastForward(5100);
  await expect(page.locator(".photo-modal")).toBeHidden();
  const state = await capture(page, testInfo, "draft-cleanup-timeout-recovers");
  expect(state.jobId).not.toBe(job.jobId);
  expect(state.mutationPending).toBe(false);
});

test("an unsaved disconnected stop retains photos and permits an explicit retry", async ({page, browserName}, testInfo) => {
  const {job} = await readyGroupedDropoff(page, browserName);
  let submissions = 0;
  await page.route("**/api/driver/jobs/*/photos", async route => {
    submissions += 1;
    await route.abort("failed");
  });
  await page.locator('.photo-modal [data-action="complete-job"]').click();
  await expect(page.locator('.photo-modal [data-action="complete-job"]')).toBeEnabled();
  await expect(page.locator(".photo-modal")).toBeVisible();
  const state = await capture(page, testInfo, "unsaved-stop-retains-evidence");
  expect(state.jobId).toBe(job.jobId);
  expect(state.photoCount).toBe(2);
  expect(state.reconciliationPending).toBe(1);
  expect(submissions).toBe(1);
  const record = (await query("SELECT status FROM driver_job_records WHERE job_id=$1", [job.jobId])).rows[0];
  expect(record.status).toBe("in_progress");
  await page.unroute("**/api/driver/jobs/*/photos");
  await page.locator('.photo-modal [data-action="complete-job"]').click();
  await expect(page.locator(".photo-modal")).toBeHidden();
});

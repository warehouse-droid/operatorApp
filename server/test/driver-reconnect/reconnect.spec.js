import {expect, test} from "../mbt/e2e/mbt-e2e-test.js";
import {query} from "../../src/db.js";
import {readyGroupedDropoff} from "../support/driver-upload-stall-fixture.mjs";
import fs from "node:fs";

test.beforeEach(async ({page, browserName}) => {
  if (browserName === "chromium") await page.coverage.startJSCoverage({resetOnNavigation: false});
});
test.afterEach(async ({page, browserName}, testInfo) => {
  if (browserName !== "chromium") return;
  fs.writeFileSync(testInfo.outputPath("driver-coverage.json"), JSON.stringify(await page.coverage.stopJSCoverage()));
});

test("completion and next-job start take under five seconds despite slow billed-order cleanup", async ({page, browserName}, testInfo) => {
  const {job, next} = await readyGroupedDropoff(page, browserName, {withNext: true});
  const id = 9993000000 + Math.floor(Math.random() * 100000);
  const ref = `SO-LATENCY-${id}`;
  try {
    await query("INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,netsuite_active) VALUES ($1,$2,'G','Sales Order : Billed',true)", [id, ref]);
    await query("UPDATE dispatch_plan_snapshots SET orders=orders || $2::jsonb WHERE plan_id=$1", [job.planId, JSON.stringify([{id: ref, type: "SO"}])]);
    await query(`CREATE OR REPLACE FUNCTION reconnect_slow_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(6); RETURN NEW; END $$`);
    await query("CREATE TRIGGER reconnect_slow_cleanup BEFORE INSERT ON dispatch_plan_maintenance FOR EACH ROW EXECUTE FUNCTION reconnect_slow_cleanup()");
    let began;
    page.on("request", request => {if (request.url().includes(`/jobs/${encodeURIComponent(job.jobId)}/photos`)) began = performance.now();});
    const response = page.waitForResponse(result => result.url().includes(`/jobs/${encodeURIComponent(job.jobId)}/photos`));
    await page.locator('.photo-modal [data-action="complete-job"]').click();
    const received = await response;
    expect(received.status(), await received.text()).toBe(200);
    const body = await received.json();
    const elapsedMs = performance.now() - began;
    await testInfo.attach("completion-timing", {body: JSON.stringify({elapsedMs, status: body.record.status, nextStatus: body.nextJob?.status}), contentType: "application/json"});
    expect(body.record.status).toBe("complete");
    expect(body.nextJob?.status).toBe("in_progress");
    expect(elapsedMs).toBeLessThan(5000);
    expect((await next()).job?.status).toBe("in_progress");
  } finally {
    await query("DROP TRIGGER IF EXISTS reconnect_slow_cleanup ON dispatch_plan_maintenance");
    await query("DROP FUNCTION IF EXISTS reconnect_slow_cleanup()");
  }
});

test("lost upload acknowledgement and lost save/history responses reconnect automatically", async ({page, browserName}) => {
  const {job} = await readyGroupedDropoff(page, browserName);
  let uploads = 0;
  let writes = 0;
  let reads = 0;
  await page.route("**/upload", async route => {
    const response = await route.fetch();
    if (++uploads === 1) await route.abort("failed");
    else await route.fulfill({response});
  });
  await page.route("**/api/driver/jobs/*/photos", async route => {
    writes++;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort("failed");
  });
  await page.route("**/api/driver/history?*", async route => {
    if (++reads === 1) await route.abort("failed");
    else await route.continue();
  });
  await page.locator('.photo-modal [data-action="complete-job"]').click();
  await expect(page.locator(".photo-modal")).toBeHidden();
  expect(uploads).toBe(3);
  expect(writes).toBe(1);
  expect(reads).toBeGreaterThanOrEqual(2);
  const rows = (await query("SELECT status,photo_data_urls FROM driver_job_records WHERE job_id=$1", [job.jobId])).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("complete");
  expect(rows[0].photo_data_urls).toHaveLength(2);
  await expect.poll(async () => Number((await query("SELECT count(*) FROM delivery_audit_log WHERE action='driver.photo_upload.recovered' AND details->>'jobId'=$1", [job.jobId])).rows[0].count)).toBe(2);
  const diagnostics = (await query("SELECT action,details FROM delivery_audit_log WHERE details->>'jobId'=$1", [job.jobId])).rows;
  const saveFailure = diagnostics.find(value => value.action === "driver.photo_upload.failed" && value.details.stage === "saving");
  expect(saveFailure.details.requestId).toBeTruthy();
  const serverFinished = diagnostics.find(value => value.action === "driver.job.response_finished" && value.details.requestId === saveFailure.details.requestId);
  expect(serverFinished.details.clientAcknowledged).toBe(false);
  expect(serverFinished.details.steps.map(value => value.step)).toContain("evidence_committed");
});

test("request lost before save replays safely; recovery can be paused without losing photos", async ({page, browserName}) => {
  const {job} = await readyGroupedDropoff(page, browserName);
  let writes = 0;
  await page.route("**/api/driver/jobs/*/photos", async route => {writes++; await route.abort("failed");});
  await page.locator('.photo-modal [data-action="complete-job"]').click();
  await expect.poll(() => writes).toBeGreaterThanOrEqual(2);
  await page.locator("[data-driver-upload-pause]").click();
  await expect(page.locator('.photo-modal [data-action="complete-job"]')).toBeEnabled();
  expect(await page.evaluate(() => photos.filter(Boolean).length)).toBe(2);
  expect((await query("SELECT status FROM driver_job_records WHERE job_id=$1", [job.jobId])).rows[0].status).toBe("in_progress");
  await page.unroute("**/api/driver/jobs/*/photos");
  await page.locator('.photo-modal [data-action="complete-job"]').click();
  await expect(page.locator(".photo-modal")).toBeHidden();
  expect((await query("SELECT status FROM driver_job_records WHERE job_id=$1", [job.jobId])).rows[0].status).toBe("complete");
});

test("two simultaneous completion requests preserve one completion and one next-job start", async ({page, browserName}) => {
  const {job} = await readyGroupedDropoff(page, browserName, {withNext: true});
  let statuses;
  await page.route("**/api/driver/jobs/*/photos", async route => {
    const responses = await Promise.all([route.fetch(), route.fetch()]);
    statuses = responses.map(response => response.status()).sort();
    const accepted = responses.find(response => response.status() === 200);
    expect(accepted, JSON.stringify(statuses)).toBeTruthy();
    await route.fulfill({response: accepted});
  });
  await page.locator('.photo-modal [data-action="complete-job"]').click();
  await expect(page.locator(".photo-modal")).toBeHidden();
  expect(statuses).toEqual([200, 409]);
  const records = (await query("SELECT status,photo_data_urls FROM driver_job_records WHERE job_id=$1", [job.jobId])).rows;
  expect(records).toHaveLength(1);
  expect(records[0].status).toBe("complete");
  expect(records[0].photo_data_urls).toHaveLength(2);
  await expect.poll(async () => Number((await query("SELECT count(*) FROM delivery_audit_log WHERE action='driver.job.next_job_started' AND details->>'jobId'=$1", [job.jobId])).rows[0].count)).toBe(1);
});

test("a confirmed job advances immediately when local photo cleanup stalls", async ({page, browserName}) => {
  const {job} = await readyGroupedDropoff(page, browserName, {withNext: true});
  await page.evaluate(() => {
    offlineStorageAvailable = true;
    window.DriverOfflineDB.deleteDraftPhoto = () => new Promise(() => {});
  });
  const response = page.waitForResponse(result => result.url().includes(`/jobs/${encodeURIComponent(job.jobId)}/photos`));
  await page.locator('.photo-modal [data-action="complete-job"]').click();
  const received = await response;
  expect(received.status()).toBe(200);
  expect((await received.json()).nextJob.status).toBe("in_progress");
  await expect(page.locator(".photo-modal")).toBeHidden({timeout: 2000});
  expect(await page.evaluate(() => currentJob.jobId)).not.toBe(job.jobId);
});

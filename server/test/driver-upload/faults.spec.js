import crypto from "node:crypto";
import sharp from "sharp";
import {expect, test} from "../support/driver-upload-browser-fixture.mjs";
import {query} from "../../src/db.js";
import {driverCompanyDate} from "../../src/driver-plan-date-policy.js";
import {ce94489Replay} from "../support/dispatch-map-driver-replay-fixture.mjs";

async function control(page, settings = {}) {
  const response = await page.request.post("http://upload:3999/control", {data: {mode: "ok", remaining: 0, skip: 0, delayMs: 0, ...settings}});
  expect(response.ok()).toBe(true);
}
test.afterEach(async ({page}) => control(page));

async function readyPhotoStop(page, browserName) {
  expect(process.env.MBT_TEST_ISOLATED).toBe("1");
  const suffix = crypto.randomUUID().slice(0, 8);
  const login = `fault-${browserName}-${suffix}`;
  const source = structuredClone(ce94489Replay.plan);
  const order = source.orders[0];
  order.id = `SN${Math.floor(Math.random() * 90000000 + 10000000)}`;
  const loadId = `fault-load-${suffix}`;
  const trucks = [{id: `fault-truck-${suffix}`, plate: `FIX-${suffix}`, base: "3445", driverLogin: login, driver: login,
    loads: [{id: loadId, name: "Fault test load", driverLogin: login, truckId: `fault-truck-${suffix}`, truckPlate: `FIX-${suffix}`,
      stops: [{id: `fault-pick-${suffix}`, type: "pick", orderId: order.id, loadId, location: order.sourceYard},
        {id: `fault-drop-${suffix}`, type: "drop", orderId: order.id, loadId, location: "3445", dropLocation: "3445", dropAddress: order.address}]}]}];
  await query("INSERT INTO dispatch_drivers (name, login, active, samsara_enabled) VALUES ($1, $1, true, false)", [login]);
  const inserted = await query("INSERT INTO dispatch_plans (plan_date, status, revision, note, confirmed_at) VALUES ($1, 'confirmed', 1, 'upload-fault-tests', now()) ON CONFLICT (plan_date) DO UPDATE SET revision = dispatch_plans.revision + 1 RETURNING id", [driverCompanyDate()]);
  await query(`INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary, schema_version, plan_digest, order_count, truck_count, load_count, stop_count)
    VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, 2, 'upload-fault-tests', 1, 1, 1, 2)
    ON CONFLICT (plan_id) DO UPDATE SET orders = dispatch_plan_snapshots.orders || EXCLUDED.orders,
      trucks = dispatch_plan_snapshots.trucks || EXCLUDED.trucks`, [inserted.rows[0].id, JSON.stringify([order]), JSON.stringify(trucks), JSON.stringify({ownYardCodes: ["3445", "2967"]})]);
  await page.addInitScript(() => Object.defineProperty(navigator, "onLine", {configurable: true, get: () => true}));
  await page.goto("/driver");
  await page.locator("#driverLogin").fill(login);
  const signedIn = page.waitForResponse(response => response.url().endsWith("/api/driver/login"));
  await page.locator('[data-form="login"] button[type="submit"]').click();
  const signed = await signedIn;
  const token = (await signed.json()).token;
  const deviceId = signed.request().headers()["x-mbbs-driver-device"];
  const next = async () => {
    const response = await page.request.get("/api/driver/next-job", {headers: {authorization: `Bearer ${token}`, "x-mbbs-driver-device": deviceId, "x-mbbs-driver-version": "2026.08.12.3"}});
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  };
  let job;
  for (let step = 0; step < 5; step += 1) {
    job = (await next()).job;
    expect(job).toBeTruthy();
    if (job.status !== "in_progress") {
      await page.locator('[data-action="start-job"]').click();
      await expect.poll(async () => (await next()).job?.status).toBe("in_progress");
    }
    await query("UPDATE driver_job_records SET started_at = now() - interval '11 seconds' WHERE lower(driver_login) = $1 AND status = 'in_progress'", [login]);
    await page.locator('[data-action="refresh"]').last().click();
    const override = page.locator('[data-action="override-location"]');
    if (await override.isVisible()) await override.click();
    if (Number(job.requiredPhotos) > 0) break;
    const response = page.waitForResponse(result => result.url().includes(`/jobs/${encodeURIComponent(job.jobId)}/photos`));
    await page.locator('[data-action="complete-job"]').last().click();
    expect((await response).status()).toBe(200);
  }
  expect(Number(job.requiredPhotos)).toBeGreaterThan(0);
  await page.locator('[data-action="show-photo"]').click();
  const bytes = await sharp({create: {width: 120, height: 120, channels: 3, background: {r: 25, g: 125, b: 115}}}).jpeg().toBuffer();
  for (let index = 0; index < 2; index += 1) {
    await page.locator(`.photo-modal input[data-photo-index="${index}"][data-photo-source="gallery"]`).setInputFiles({name: `fault-${index}.jpg`, mimeType: "image/jpeg", buffer: bytes});
    await expect(page.locator(".photo-preview img")).toHaveCount(index + 1);
  }
  return {login, job, next};
}

test("measured percentages remain visible while storage confirms the bytes", async ({page, browserName}, testInfo) => {
  const {job} = await readyPhotoStop(page, browserName);
  await control(page, {delayMs: 800});
  const saved = page.waitForResponse(response => response.url().includes(`/jobs/${encodeURIComponent(job.jobId)}/photos`));
  await page.locator('.photo-modal [data-action="complete-job"]').click();
  await expect(page.locator("#driverUploadStatus")).toBeVisible();
  await expect(page.locator("[data-driver-upload-label]")).toContainText("Waiting for confirmation");
  await expect(page.locator("[data-driver-upload-current]")).toHaveAttribute("value", "100");
  await expect(page.locator("[data-driver-upload-overall]")).toHaveText("Overall: 50%");
  await testInfo.attach("upload-progress", {body: await page.screenshot(), contentType: "image/png"});
  expect((await saved).status()).toBe(200);
  await expect(page.locator("#driverUploadStatus")).toBeHidden();
});

for (const fault of [
  {mode: "reject", remaining: 1, status: 503, reason: "Fixture storage unavailable"},
  {mode: "disconnect", remaining: 1000, status: 0, reason: "The upload connection failed"}
]) {
test(`a partial ${fault.mode} failure preserves photos, records its reason and retries only unfinished evidence`, async ({page, browserName}) => {
  const {login, job} = await readyPhotoStop(page, browserName);
  await control(page, {mode: fault.mode, skip: 1, remaining: fault.remaining});
  const uploads = [];
  page.on("request", request => {if (request.url().endsWith("/upload") && request.method() === "POST") uploads.push(request);});
  const logged = page.waitForResponse(response => response.url().endsWith("/api/driver/upload-failures"));
  await page.locator('.photo-modal [data-action="complete-job"]').click();
  expect((await logged).status()).toBe(200);
  await expect(page.locator(".photo-preview img")).toHaveCount(2);
  await expect(page.locator('.photo-modal [data-action="complete-job"]')).toBeEnabled();
  const record = await query("SELECT details FROM delivery_audit_log WHERE details->>'driverLogin' = $1 AND action = 'driver.photo_upload.failed'", [login]);
  expect(record.rowCount).toBe(1);
  expect(record.rows[0].details.httpStatus).toBe(fault.status);
  expect(record.rows[0].details.message).toContain(fault.reason);
  await control(page);
  const saved = page.waitForResponse(response => response.url().includes(`/jobs/${encodeURIComponent(job.jobId)}/photos`));
  await page.locator('.photo-modal [data-action="complete-job"]').click();
  expect((await saved).status()).toBe(200);
  expect(uploads.length).toBe(3);
  expect((await query("SELECT photo_data_urls FROM driver_job_records WHERE job_id = $1", [job.jobId])).rows[0].photo_data_urls.length).toBe(2);
});
}

test("a saved stop whose response is lost cannot be submitted twice", async ({page, browserName}) => {
  const {login, job, next} = await readyPhotoStop(page, browserName);
  await control(page);
  let submissions = 0;
  await page.route("**/api/driver/jobs/*/photos", async route => {
    submissions += 1;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort("failed");
  });
  const logged = page.waitForResponse(response => response.url().endsWith("/api/driver/upload-failures"));
  await page.locator('.photo-modal [data-action="complete-job"]').click();
  expect((await logged).status()).toBe(200);
  const rows = await query("SELECT status, photo_data_urls FROM driver_job_records WHERE job_id = $1", [job.jobId]);
  expect(rows.rows[0].status).toBe("complete");
  expect(rows.rows[0].photo_data_urls.length).toBe(2);
  await expect.poll(async () => (await next()).job?.jobId).not.toBe(job.jobId);
  await expect(page.locator(".photo-modal")).toBeHidden();
  expect(submissions).toBe(1);
  const audit = await query("SELECT details FROM delivery_audit_log WHERE details->>'driverLogin' = $1 AND action = 'driver.photo_upload.failed'", [login]);
  expect(audit.rows.some(row => row.details.stage === "saving")).toBe(true);
});

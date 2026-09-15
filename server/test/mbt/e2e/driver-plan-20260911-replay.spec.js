import crypto from "node:crypto";

import { query } from "../../../src/db.js";
import { getDriverDayJobs } from "../../../src/driver-repository.js";
import { datedDriverReplay } from "../../support/dispatch-map-driver-replay-fixture.mjs";
import { expect, test } from "./mbt-e2e-test.js";

const replay = datedDriverReplay();
const driverNames = [...new Set(replay.plan.trucks.flatMap((truck) => (truck.loads || [])
  .map((load) => load.driverLogin || truck.driverLogin).filter(Boolean)))];
let plan;
let loginMap;

async function seedReplay() {
  if (process.env.MBT_TEST_ISOLATED !== "1" || !String(process.env.DATABASE_URL).includes("/mbt_test")) {
    throw new Error("Driver completion replay requires the isolated test database");
  }
  // Recover only a prior run's explicitly tagged test plan. Preserve completed
  // job/arrival audit rows; their foreign keys intentionally prohibit erasure.
  await query("DELETE FROM dispatch_plans WHERE plan_date = '2026-09-11' AND note = 'isolated-20260911-pwa-replay'");
  const existing = await query("SELECT id FROM dispatch_plans WHERE plan_date = '2026-09-11'");
  expect(existing.rowCount, "Use a dedicated empty replay database").toBe(0);
  const suffix = crypto.randomUUID().slice(0, 8);
  loginMap = new Map(driverNames.map((login) => [login, `replay-${suffix}-${login}`]));
  for (const [name, login] of loginMap) {
    await query("INSERT INTO dispatch_drivers (name, login, active, samsara_enabled) VALUES ($1, $2, true, false)", [`${name} isolated replay`, login]);
  }
  plan = structuredClone(replay.plan);
  for (const truck of plan.trucks) {
    truck.driverLogin = loginMap.get(truck.driverLogin) || truck.driverLogin;
    for (const load of truck.loads || []) {
      load.driverLogin = loginMap.get(load.driverLogin) || truck.driverLogin;
    }
  }
  const inserted = await query("INSERT INTO dispatch_plans (plan_date, status, revision, note, confirmed_at) VALUES ($1::date, 'confirmed', $2, 'isolated-20260911-pwa-replay', now()) RETURNING id", [plan.planDate, plan.revision]);
  plan.id = inserted.rows[0].id;
  await query(`INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary, schema_version, plan_digest, order_count, truck_count, load_count, stop_count)
    VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, 2, 'isolated-20260911-pwa-replay', $5, $6, $7, $8)`, [
    plan.id, JSON.stringify(plan.orders), JSON.stringify(plan.trucks), JSON.stringify(plan.summary), plan.orders.length, plan.trucks.length,
    plan.trucks.flatMap((truck) => truck.loads || []).length, plan.trucks.flatMap((truck) => (truck.loads || []).flatMap((load) => load.stops || [])).length
  ]);
  await query("UPDATE mbt_feature_flags SET enabled = false, revision = revision + 1 WHERE flag_key = 'driver_offline_mode'");
}

async function cleanReplay() {
  if (!plan?.id) { return; }
  await query("DELETE FROM dispatch_plans WHERE id = $1 AND note = 'isolated-20260911-pwa-replay'", [plan.id]);
  for (const login of loginMap.values()) {
    await query("DELETE FROM driver_sessions WHERE driver_login = $1", [login]);
    await query("DELETE FROM dispatch_drivers WHERE login = $1", [login]);
  }
}

test.beforeAll(seedReplay);
test.afterAll(cleanReplay);
test.use({ serviceWorkers: "block" });

async function approveLocation(page) {
  const override = page.locator('[data-action="override-location"]');
  await expect(override).toBeVisible();
  await override.click();
}

async function completeVisit(page, job, photo) {
  await approveLocation(page);
  if (Number(job.requiredPhotos) > 0) {
    await page.locator('[data-action="show-photo"]').click();
    const modal = page.locator(".photo-modal");
    await expect(modal).toBeVisible();
    await expect(modal.locator('[data-action="complete-job"]')).toBeDisabled();
    for (let index = 0; index < Math.max(2, Number(job.requiredPhotos)); index += 1) {
      await modal.locator(`input[data-photo-index="${index}"][data-photo-source="gallery"]`).setInputFiles({
        name: `isolated-evidence-${index}.jpg`, mimeType: "image/jpeg", buffer: photo
      });
      await expect(modal.locator(".photo-preview img")).toHaveCount(index + 1);
    }
    await modal.locator("[data-driver-photo-remark]").fill("Isolated 2026-09-11 completion replay; not live evidence.");
  }
  const complete = page.locator('[data-action="complete-job"]').last();
  await expect(complete).toBeEnabled();
  const saved = page.waitForResponse((response) => response.url().includes(`/jobs/${encodeURIComponent(job.jobId)}/photos`) && response.request().method() === "POST");
  await complete.click();
  const response = await saved;
  expect(response.status(), await response.text()).toBe(200);
}

for (const name of driverNames) {
  test(`2026-09-11 ${name}: complete every pickup/drop-off, retain evidence and advance without reset`, async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const login = loginMap.get(name);
    let deviceId = "";
    let token = "";
    const initial = await getDriverDayJobs(login, { date: plan.planDate });
    expect(initial.jobs.length).toBeGreaterThan(0);
    const expectedIds = initial.jobs.map((job) => job.jobId);
    const completed = new Set();
    const actions = [];
    const uploads = [];
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const pendingRequests = new Set();
    let lastNetworkActivity = Date.now();
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/driver/")) { pendingRequests.add(request); lastNetworkActivity = Date.now(); }
    });
    const finishRequest = (request) => {
      if (pendingRequests.delete(request)) { lastNetworkActivity = Date.now(); }
    };
    page.on("requestfinished", finishRequest);
    page.on("requestfailed", finishRequest);
    // Chromium does not consistently emit requestfinished for keepalive/204
    // telemetry. A received response plus the quiet interval also settles it.
    page.on("response", (response) => { finishRequest(response.request()); });
    const reloadSettledJob = async () => {
      await expect.poll(() => ({ pending: [...pendingRequests].map((request) => new URL(request.url()).pathname), quiet: Date.now() - lastNetworkActivity >= 200 }))
        .toEqual({ pending: [], quiet: true });
      await page.reload();
    };
    // Linux WebKit reports offline on Docker's internal-only network even
    // though the test app is reachable. Model the network signal explicitly;
    // every operational request still has to succeed against the real server.
    await page.addInitScript(() => {
      globalThis.__driverReplayOnline = true;
      Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, get: () => globalThis.__driverReplayOnline });
    });
    // Only the external photo-storage boundary is substituted. Authentication,
    // next-job decisions, starts, completion, and persistence use the real app.
    await page.route("**/test-driver-photo/upload", async (route) => {
      expect(route.request().headers().authorization).toMatch(/^Bearer .+/u);
      expect(route.request().postDataBuffer().length).toBeGreaterThan(100);
      const key = `isolated-driver-replay/${deviceId}/photo-${uploads.length + 1}.jpg`;
      uploads.push(key);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ key }) });
    });
    const nextJob = async () => {
      const response = await page.request.get("/api/driver/next-job", { headers: {
        authorization: `Bearer ${token}`, "x-mbbs-driver-device": deviceId, "x-mbbs-driver-version": "2026.08.12.3"
      } });
      expect(response.status(), await response.text()).toBe(200);
      return response.json();
    };
    await page.goto("/driver");
    await page.locator("#driverLogin").fill(login);
    const signIn = page.waitForResponse((response) => response.url().endsWith("/api/driver/login") && response.request().method() === "POST");
    await page.locator('[data-form="login"] button[type="submit"]').click();
    const signedIn = await signIn;
    expect(signedIn.status(), await signedIn.text()).toBe(200);
    token = (await signedIn.json()).token;
    deviceId = signedIn.request().headers()["x-mbbs-driver-device"];
    expect(deviceId).toBeTruthy();
    await expect(page.locator(".job-panel")).toBeVisible();
    expect((await nextJob()).job).toBeTruthy();
    await page.evaluate(() => {
      globalThis.__driverReplayOnline = false;
      globalThis.dispatchEvent(new globalThis.Event("offline"));
    });
    await expect(page.locator('[data-action="start-job"]')).toBeDisabled();
    await expect(page.locator("#driverRouteProtectionNotice")).toContainText("Reconnect to record an action");
    await page.evaluate(() => {
      globalThis.__driverReplayOnline = true;
      globalThis.dispatchEvent(new globalThis.Event("online"));
    });
    await expect(page.locator('[data-action="start-job"]')).toBeEnabled();
    const photo = await page.screenshot({ type: "jpeg", quality: 45 });
    for (let iteration = 0; iteration <= expectedIds.length; iteration += 1) {
      const current = await nextJob();
      const job = current.job;
      if (!job) {
        expect(current.state.allJobsComplete).toBe(true);
        break;
      }
      expect(expectedIds).toContain(job.jobId);
      expect(completed.has(job.jobId), "A completed earlier job must not reappear").toBe(false);
      await expect(page.locator(".plan-meta-row")).toContainText(job.truckPlate);
      await expect(page.locator(".address-block")).toContainText(job.address || job.location);
      if (job.stopType === "truck_switch") {
        await page.locator('[data-action="confirm-truck-switch"]').click();
        await expect.poll(async () => (await nextJob()).job?.jobId).not.toBe(job.jobId);
      } else {
        if (job.status !== "in_progress") {
          await expect(page.locator('[data-action="start-job"]')).toBeEnabled();
          await page.locator('[data-action="start-job"]').click();
          await expect.poll(async () => (await nextJob()).job?.status).toBe("in_progress");
        }
        // Skip wall-clock countdown only in isolated DB, then reload the real
        // PWA to prove started progress survives. No application function mock.
        await query("UPDATE driver_job_records SET started_at = now() - interval '11 seconds' WHERE job_id = $1 AND driver_login = $2 AND status = 'in_progress'", [job.jobId, login]);
        await reloadSettledJob();
        await expect(page.locator(".job-panel")).toBeVisible();
        expect((await nextJob()).job.jobId).toBe(job.jobId);
        await completeVisit(page, job, photo);
      }
      const physicalIds = job.physicalVisitJobIds?.length ? job.physicalVisitJobIds : [job.jobId];
      for (const id of physicalIds) { completed.add(id); }
      const records = await query("SELECT job_id, status, photo_data_urls FROM driver_job_records WHERE job_id = ANY($1::text[])", [physicalIds]);
      expect(records.rowCount).toBe(physicalIds.length);
      for (const record of records.rows) {
        expect(record.status).toBe("complete");
        if (["pickup", "dropoff"].includes(job.stopType)) {
          expect(record.photo_data_urls.length).toBeGreaterThanOrEqual(2);
          expect(record.photo_data_urls.every((ref) => ref.startsWith(`r2://isolated-driver-replay/${deviceId}/`))).toBe(true);
        }
      }
      actions.push({ jobId: job.jobId, load: job.loadName, plate: job.truckPlate, type: job.stopType, logicalJobs: physicalIds.length });
      await reloadSettledJob();
    }
    expect([...completed].sort()).toEqual([...expectedIds].sort());
    expect(errors).toEqual([]);
    await testInfo.attach("dated-plan-completion-results", { contentType: "application/json", body: JSON.stringify({ sourceDate: plan.planDate, sourceRevision: replay.plan.revision, driver: name, actions, logicalJobs: completed.size, photos: uploads.length, source: process.env.DRIVER_REPLAY_PLAN_FILE ? "read-only production snapshot" : "committed CE94489-derived fixture" }, null, 2) });
  });
}

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { before, after } from "node:test";
import { query, withTransaction } from "../../../src/db.js";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";
import { createDispatchPlan, saveDispatchPlanSnapshot, confirmDispatchPlan, getDispatchPlan } from "../../../src/dispatch-plan-repository.js";
import { setDispatchDriverActive } from "../../../src/dispatch-setup-repository.js";
import { startDriverJob, recordDriverJobPhotos, planJobsForDriver } from "../../../src/driver-repository.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../../../src/dispatch-fleet-status.js";
import { DRIVER_PWA_CURRENT_VERSION, DRIVER_PWA_VERSION_HEADER } from "../../../src/driver-client-version.js";
import { persistDriverOfflineManifest, authorizeDriverOfflineSync } from "../../../src/driver-offline-repository.js";
import { setTimeout as delay } from "node:timers/promises";

let http;
let fixtureIndex = 0;
before(async () => { http = await createDispatchV2Fixture(); });
after(async () => { await http?.close(); });

async function fixture({ planned = false, current = false } = {}) {
  const login = `inactive-${crypto.randomUUID()}`;
  const driver = (await query("INSERT INTO dispatch_drivers(name,login,active,samsara_enabled) VALUES($1,$1,true,false) RETURNING id", [login])).rows[0];
  const planDate = current
    ? (await query("SELECT (now() AT TIME ZONE 'America/Toronto')::date::text AS today")).rows[0].today
    : `2020-01-${String(++fixtureIndex).padStart(2, "0")}`;
  const job = { jobId: `inactive-job-${crypto.randomUUID()}`, driverLogin: login,
    planDate, stopId: "RETURN", stopType: "return", loadId: "inactive-load", loadName: "Unfinished load",
    truckId: "", truckPlate: "", orderRefs: [], requiredPhotos: 0 };
  if (!planned) { return { driver, login, job }; }
  const truck = (await query("INSERT INTO dispatch_trucks(plate,active) VALUES($1,true) RETURNING id::text,plate", [login])).rows[0];
  const plan = await createDispatchPlan({ planDate });
  const saved = await saveDispatchPlanSnapshot(plan.id, { planDate, baseRevision: plan.revision, orders: [],
    trucks: [{ ...truck, base: "150", driverLogin: login, loads: [{ id: job.loadId, name: job.loadName,
      driverLogin: login, truckId: truck.id, truckPlate: truck.plate, returnOnly: true,
      returnYard: "12441", plannedStartMinute: 480, plannedFinishMinute: 540, stops: [] }] }] });
  return { driver, login, truck, plan: saved, job: { ...job, planId: plan.id, truckId: truck.id, truckPlate: truck.plate } };
}

function inactiveError(error) { return error?.code === "DRIVER_INACTIVE" && error?.status === 409; }

test("S1: dispatch deactivates a driver with unfinished work and revokes the session without changing jobs", async () => {
  const f = await fixture({ planned: true, current: true });
  const login = await http.request("/api/driver/login", { method: "POST", body: { username: f.login } });
  assert.equal(login.response.status, 200);
  const manifest = await persistDriverOfflineManifest({ driverLogin: f.login, deviceId: "inactivation-device",
    plan: await confirmDispatchPlan(f.plan.id), jobs: [f.job] });
  assert.equal((await authorizeDriverOfflineSync({ manifestId: manifest.manifestId, deviceId: "inactivation-device",
    offlineGrant: manifest.offlineSyncGrant })).driverLogin, f.login);
  await startDriverJob(f.login, f.job.jobId, { job: f.job });
  const beforeJobs = (await query("SELECT * FROM driver_job_records WHERE driver_login=$1 ORDER BY id", [f.login])).rows;
  const disabled = await http.request(`/api/dispatch/setup/drivers/${f.driver.id}/active`, { method: "PATCH", body: { active: false } });
  assert.equal(disabled.response.status, 200, JSON.stringify(disabled.payload));
  assert.equal(disabled.payload.driver.active, false);
  assert.equal((await query("SELECT * FROM driver_sessions WHERE driver_login=$1 AND revoked_at IS NULL", [f.login])).rowCount, 0);
  assert.equal((await query("SELECT * FROM driver_offline_sync_grants WHERE driver_login=$1 AND revoked_at IS NULL", [f.login])).rowCount, 0);
  assert.deepEqual((await query("SELECT * FROM driver_job_records WHERE driver_login=$1 ORDER BY id", [f.login])).rows, beforeJobs);
  for (const path of ["/api/driver/me", `/api/driver/jobs/${encodeURIComponent(f.job.jobId)}/start`, `/api/driver/jobs/${encodeURIComponent(f.job.jobId)}/photos`]) {
    const response = await http.request(path, { token: login.payload.token,
      headers: { [DRIVER_PWA_VERSION_HEADER]: DRIVER_PWA_CURRENT_VERSION },
      ...(path.endsWith("/me") ? {} : { method: "POST", body: {} }) });
    assert.equal(response.response.status, 401);
  }
  const relogin = await http.request("/api/driver/login", { method: "POST", body: { username: f.login } });
  assert.equal(relogin.response.status, 401);
  const sync = await http.request("/api/driver/offline-sync", { token: "", method: "POST",
    headers: { "x-mbbs-driver-device": "inactivation-device", "x-mbbs-offline-grant": manifest.offlineSyncGrant },
    body: { manifestId: manifest.manifestId, events: [] } });
  assert.equal(sync.response.status, 401);
});

test("S3: inactive assignments do not block saving, editing, or confirming a plan", async () => {
  const f = await fixture({ planned: true });
  await setDispatchDriverActive(f.driver.id, false);
  const saved = await saveDispatchPlanSnapshot(f.plan.id, { ...f.plan, baseRevision: f.plan.revision, summary: { planningContinues: true } });
  assert.equal(saved.summary.planningContinues, true);
  assert.equal(saved.trucks[0].loads[0].driverLogin, f.login);
  const confirmed = await confirmDispatchPlan(f.plan.id);
  assert.equal(confirmed.status, "confirmed");
  const edited = await saveDispatchPlanSnapshot(f.plan.id, { ...confirmed, baseRevision: confirmed.revision, summary: { planningContinues: "after confirmation" } });
  assert.equal(edited.summary.planningContinues, "after confirmation");
});

test("S2: inactive driver cannot start a job through persistence", async () => {
  const f = await fixture();
  await setDispatchDriverActive(f.driver.id, false);
  await assert.rejects(startDriverJob(f.login, f.job.jobId, { job: f.job }), inactiveError);
  assert.equal((await query("SELECT * FROM driver_job_records WHERE job_id=$1", [f.job.jobId])).rowCount, 0);
});

for (const source of ["online", "offline", "dispatch_historical_assist"]) {
  test(`S2: inactive driver cannot complete an in-progress job via ${source}`, async () => {
    const f = await fixture();
    await startDriverJob(f.login, f.job.jobId, { job: f.job });
    await setDispatchDriverActive(f.driver.id, false);
    const beforeJob = (await query("SELECT * FROM driver_job_records WHERE job_id=$1", [f.job.jobId])).rows[0];
    await assert.rejects(recordDriverJobPhotos(f.login, f.job.jobId, { job: f.job,
      occurredAt: source === "offline" ? `${f.job.planDate}T18:00:00Z` : null,
      completionContext: { source } }), inactiveError);
    assert.deepEqual((await query("SELECT * FROM driver_job_records WHERE job_id=$1", [f.job.jobId])).rows[0], beforeJob);
  });
}

test("S4: an active login cannot bypass an inactive canonical load assignment", async () => {
  const f = await fixture({ planned: true });
  const active = await fixture();
  await setDispatchDriverActive(f.driver.id, false);
  const forgedJob = { ...f.job, driverLogin: active.login };
  await assert.rejects(recordDriverJobPhotos(active.login, f.job.jobId, { job: forgedJob }), inactiveError);
  await assert.rejects(startDriverJob(active.login, f.job.jobId, { job: forgedJob }), inactiveError);
});

test("S4: reassigned work can be completed by the active replacement driver", async () => {
  const f = await fixture({ planned: true });
  const replacement = await fixture();
  await setDispatchDriverActive(f.driver.id, false);
  const reassigned = await saveDispatchPlanSnapshot(f.plan.id, { ...f.plan, baseRevision: f.plan.revision,
    trucks: f.plan.trucks.map(truck => ({ ...truck, driverLogin: replacement.login,
      loads: truck.loads.map(load => ({ ...load, driverLogin: replacement.login, driverName: replacement.login })) })) });
  await confirmDispatchPlan(reassigned.id);
  const jobs = planJobsForDriver(await getDispatchPlan(reassigned.id), replacement.login);
  assert(jobs.length > 0);
  const job = { ...jobs[0], requiredPhotos: 0 };
  await startDriverJob(replacement.login, job.jobId, { job });
  const completed = await recordDriverJobPhotos(replacement.login, job.jobId, { job });
  assert.equal(completed.status, "complete");
  assert.equal(completed.driver_login, replacement.login);
});

for (const operation of ["start", "complete"]) {
  test(`S5: queued ${operation} observes committed inactivation`, async () => {
    const f = await fixture();
    let signalLocked;
    let unlock;
    const locked = new Promise(resolve => { signalLocked = resolve; });
    const release = new Promise(resolve => { unlock = resolve; });
    const deactivation = withTransaction(async () => {
      await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
      await setDispatchDriverActive(f.driver.id, false);
      signalLocked();
      await release;
    });
    await locked;
    const action = operation === "start" ? startDriverJob : recordDriverJobPhotos;
    let settled = false;
    const pending = action(f.login, f.job.jobId, { job: f.job }).finally(() => { settled = true; });
    const outcome = assert.rejects(pending, inactiveError);
    try {
      await delay(40);
      assert.equal(settled, false, "Execution must wait for the inactivation transaction.");
    } finally {
      unlock();
      await deactivation;
    }
    await outcome;
    assert.equal((await query("SELECT * FROM driver_job_records WHERE job_id=$1", [f.job.jobId])).rowCount, 0);
  });
}

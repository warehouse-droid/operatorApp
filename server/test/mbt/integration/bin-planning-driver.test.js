import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { closeDb, query } from "../../../src/db.js";
import { planJobsForDriver, getDriverDayJobs } from "../../../src/driver-repository.js";
import { authorizeMbtDriverBinProjection, assertMbtDriverBinProjectionScope } from "../../../src/mbt/driver-bin-authorization.js";
import { startMbtDriverBinJob, completeMbtDriverBinJob } from "../../../src/mbt/driver-bin-execution-service.js";
import { planningFixture, command, run, storedPlan, boundary } from "../support/bin-planning-fixtures.js";
import { availableDriverExecutionPlanDate, driverBinEvent, enabledDriverBinBoundary } from "../support/driver-bin-fixtures.js";
import { getMbtBinPlanning, runMbtBinPlanningCommand } from "../../../src/mbt/bin-planning-service.js";
import { assertPlanningCapacity } from "../../../src/mbt/bin-planning-capacity.js";
import { reserveResumedPlanningAsset } from "../../../src/mbt/bin-planning-reservations.js";
after(closeDb);
const driverBoundary = { capability: enabledDriverBinBoundary };
async function releasedFixture() {
  const f = await planningFixture(0, { planDate: await availableDriverExecutionPlanDate() });
  await run(f, "assign"); await run(f, "confirm");
  const jobs = (await getDriverDayJobs(f.driverLogin, { date: f.planDate, allowBin: true })).jobs.filter(j => j.mbt);
  return { ...f, jobs, manifest: { manifestId: crypto.randomUUID(), schemaVersion: 2, planId: f.planId,
    planRevision: (await storedPlan(f.planId)).revision } };
}
async function completeCollect(f) {
  const job = f.jobs[0];
  const event = driverBinEvent(f, job, "job_started", 1, {}, { manifestId: f.manifest.manifestId });
  await startMbtDriverBinJob({ event, job, manifest: f.manifest }, driverBoundary);
  const completeEvent = driverBinEvent(f, job, "job_completed", 2, { mbt: {
    schemaVersion: "mbt-driver-bin-event-v1", actionCode: "collect_empty_bin",
    scans: [{ evidenceCode: "outgoing_bin_scan", assetRole: "outgoing", assetId: f.assetId, scannedValue: f.assetCode }]
  } }, { manifestId: f.manifest.manifestId });
  const input = { event: completeEvent, job, manifest: f.manifest, photoReferences: [] };
  await completeMbtDriverBinJob(input, driverBoundary);
  return input;
}
async function completeDelivery(f, options = {}) {
  const job = f.jobs[1];
  await startMbtDriverBinJob({ event: driverBinEvent(f, job, "job_started", 3, {}, { manifestId: f.manifest.manifestId }), job, manifest: f.manifest }, driverBoundary);
  const ref = `r2://driver-stop-photo/bin-planning-${f.suffix}.jpg`;
  const event = driverBinEvent(f, job, "job_completed", 4, { mbt: {
    schemaVersion: "mbt-driver-bin-event-v1", actionCode: "deliver_bin", scans: [],
    photoEvidence: [{ evidenceCode: "placement_photo", ordinal: 0 }]
  } }, { manifestId: f.manifest.manifestId, photos: [{ photoId: crypto.randomUUID(), ordinal: 0,
    objectReference: ref, sha256: "a".repeat(64), mimeType: "image/jpeg", byteSize: 1024, durableReceipt: true }] });
  if (options.beforeComplete) {await options.beforeComplete();}
  return completeMbtDriverBinJob({ event, job, manifest: f.manifest, photoReferences: [ref] }, { ...driverBoundary, hooks: options.hooks || {} });
}
test("staged BIN work is absent from driver routes until whole-day confirmation authorizes its exact driver", async () => {
  const f = await planningFixture(1700);
  await run(f, "assign");
  assert.equal(planJobsForDriver(await storedPlan(f.planId), f.driverLogin).filter(j => j.mbt).length, 0);
  assert.equal(planJobsForDriver(await storedPlan(f.planId), f.driverLogin, { allowBin: true }).filter(j => j.mbt).length, 0);
  await run(f, "confirm");
  const jobs = planJobsForDriver(await storedPlan(f.planId), f.driverLogin, { allowBin: true });
  assert.equal(jobs.filter(j => j.mbt).length, 2);
  const auth = await authorizeMbtDriverBinProjection({ driverLogin: f.driverLogin, planDate: f.planDate,
    capabilityAuthorizer: async input => { assert.equal(input.pilotAuthorized, true); } });
  assert.equal(auth.scopes.length, 1); assert.equal(assertMbtDriverBinProjectionScope(jobs, auth), true);
  assert.throws(() => assertMbtDriverBinProjectionScope(jobs.map(j => ({ ...j, driverLogin: "wrong-driver" })), auth));
  await run(f, "cancel");
  const revoked = await authorizeMbtDriverBinProjection({ driverLogin: f.driverLogin, planDate: f.planDate,
    capabilityAuthorizer: async input => { assert.equal(input.pilotAuthorized, false); } });
  assert.equal(revoked.scopes.length, 0);
});
function gate() { let open; const promise = new Promise(resolve => {open = resolve;}); return { promise, open }; }
test("race: completed delivery wins over cancellation without losing evidence or publishing the successor", { timeout: 15000 }, async () => {
  const f = await releasedFixture(); await completeCollect(f);
  const reached = gate(); const finish = gate();
  const completing = completeDelivery(f, { hooks: { afterVisit: async () => {reached.open(); await finish.promise;} } });
  await reached.promise;
  const cancellation = run(f, "cancel");
  finish.open(); await completing;
  await assert.rejects(cancellation, e => e.status === 409);
  const visit = (await query("SELECT status,dispatch_plan_id FROM mbt_service_visits WHERE service_visit_id=$1", [f.frontVisitId])).rows[0];
  assert.equal(visit.status, "completed"); assert.equal(String(visit.dispatch_plan_id), f.planId);
  assert.equal((await query("SELECT count(*)::int n FROM mbt_evidence WHERE service_visit_id=$1", [f.frontVisitId])).rows[0].n, 2);
  assert.equal((await query("SELECT count(*)::int n FROM mbt_bin_planning_assignments WHERE service_visit_id=$1 AND withdrawn_at IS NOT NULL", [f.frontVisitId])).rows[0].n, 0);
});
test("race: cancellation wins over late completion, preserving the already collected bin", { timeout: 15000 }, async () => {
  const f = await releasedFixture(); await completeCollect(f);
  const started = gate(); const attempt = gate(); const withdrawing = gate(); const commit = gate();
  const completing = completeDelivery(f, { beforeComplete: async () => {started.open(); await attempt.promise;} });
  await started.promise;
  const before = (await query("SELECT * FROM mbt_bin_asset_state WHERE asset_id=$1", [f.assetId])).rows[0];
  const cancelling = runMbtBinPlanningCommand(await command(f, "cancel"), { ...boundary,
    hooks: { beforeCommit: async () => {withdrawing.open(); await commit.promise;} } });
  await withdrawing.promise; attempt.open(); commit.open();
  await cancelling;
  await assert.rejects(completing, e => e.code === "MBT_DRIVER_BIN_REVIEW_REQUIRED");
  assert.deepEqual((await query("SELECT * FROM mbt_bin_asset_state WHERE asset_id=$1", [f.assetId])).rows[0], before);
  assert.equal((await query("SELECT status FROM mbt_service_visits WHERE service_visit_id=$1", [f.successorVisitId])).rows[0].status, "tentative");
});
test("delivery completion releases its successor only to the pool and preserves its requested window", async () => {
  const f = await releasedFixture();
  const before = (await query("SELECT scheduled_start_at,scheduled_end_at FROM mbt_service_visits WHERE service_visit_id=$1", [f.successorVisitId])).rows[0];
  await completeCollect(f); await completeDelivery(f);
  const next = (await query("SELECT * FROM mbt_service_visits WHERE service_visit_id=$1", [f.successorVisitId])).rows[0];
  assert.equal(next.status, "ready");
  for (const field of ["dispatch_plan_id", "dispatch_load_id", "planned_driver_id", "planned_truck_id"]) {assert.equal(next[field], null);}
  assert.deepEqual({ scheduled_start_at: next.scheduled_start_at, scheduled_end_at: next.scheduled_end_at }, before);
  const pool = await getMbtBinPlanning({ planDate: f.planDate, search: f.contractNumber }, boundary);
  assert.deepEqual(pool.pool.items.map(v => v.mbt.visitId), [f.successorVisitId]);
  await assert.rejects(() => run(f, "cancel"), e => e.code === "MBT_BIN_VISIT_COMPLETE");
});
test("started cancellation preserves physical custody and completed evidence; replan resumes only remaining steps", async () => {
  const f = await releasedFixture(); const accepted = await completeCollect(f);
  const assetBefore = (await query("SELECT * FROM mbt_bin_asset_state WHERE asset_id=$1", [f.assetId])).rows[0];
  const evidenceBefore = (await query("SELECT * FROM mbt_evidence WHERE service_visit_id=$1 ORDER BY evidence_id", [f.frontVisitId])).rows;
  const wrongTruck = await storedPlan(f.planId); wrongTruck.trucks[0].id = f.flatbedTruckId;
  await assert.rejects(() => assertPlanningCapacity(wrongTruck), e => e.code === "MBT_BIN_CUSTODY_CONFLICT");
  const visitBefore = (await query("SELECT * FROM mbt_service_visits WHERE service_visit_id=$1", [f.frontVisitId])).rows[0];
  await assert.rejects(() => reserveResumedPlanningAsset(visitBefore, { assetId: f.assetId }, f.flatbedTruckId,
    { actor: f.actor }), e => e.code === "MBT_BIN_CUSTODY_CONFLICT");
  await run(f, "cancel");
  assert.deepEqual((await query("SELECT * FROM mbt_bin_asset_state WHERE asset_id=$1", [f.assetId])).rows[0], assetBefore);
  assert.deepEqual((await query("SELECT * FROM mbt_evidence WHERE service_visit_id=$1 ORDER BY evidence_id", [f.frontVisitId])).rows, evidenceBefore);
  const stale = driverBinEvent(f, f.jobs[1], "job_started", 5, {}, { manifestId: f.manifest.manifestId });
  await assert.rejects(() => startMbtDriverBinJob({ event: stale, job: f.jobs[1], manifest: f.manifest }, driverBoundary),
    e => e.code === "MBT_DRIVER_BIN_REVIEW_REQUIRED");
  assert.equal((await completeMbtDriverBinJob(accepted, driverBoundary)).replayed, true);
  await run(f, "assign", { assetAssignments: [] }); await run(f, "confirm");
  const jobs = (await getDriverDayJobs(f.driverLogin, { date: f.planDate, allowBin: true })).jobs.filter(j => j.mbt);
  assert.deepEqual(jobs.map(j => j.mbt.actionCode), ["deliver_bin"]);
  assert.notEqual(jobs[0].jobId, f.jobs[1].jobId);
});
test("a started visit with no completed steps can be cancelled and restarted from the yard", async () => {
  const f = await releasedFixture();
  await startMbtDriverBinJob({ event: driverBinEvent(f, f.jobs[0], "job_started", 1, {}, { manifestId: f.manifest.manifestId }),
    job: f.jobs[0], manifest: f.manifest }, driverBoundary);
  await run(f, "cancel"); await run(f, "assign", { assetAssignments: [] }); await run(f, "confirm");
  const jobs = (await getDriverDayJobs(f.driverLogin, { date: f.planDate, allowBin: true })).jobs.filter(j => j.mbt);
  assert.deepEqual(jobs.map(j => j.mbt.actionCode), ["collect_empty_bin", "deliver_bin"]);
  await startMbtDriverBinJob({ event: driverBinEvent(f, jobs[0], "job_started", 10, {}, { manifestId: f.manifest.manifestId }),
    job: jobs[0], manifest: f.manifest }, driverBoundary);
});

import assert from "node:assert/strict";
import test, { after } from "node:test";
import crypto from "node:crypto";
import { closeDb, query } from "../../../src/db.js";
import { runMbtBinPlanningCommand, getMbtBinPlanning, getMbtBinPlanningVisit } from "../../../src/mbt/bin-planning-service.js";
import { acquireDispatchPlanEditLease } from "../../../src/dispatch-plan-lease-repository.js";
import { createDispatchPlan } from "../../../src/dispatch-plan-repository.js";
import { planningFixture, boundary, command, run, storedPlan } from "../support/bin-planning-fixtures.js";
after(closeDb);

test("shared editor boundary requires the date lease and revision/digest before changing any BIN state", async () => {
  const f = await planningFixture(1500); const before = await storedPlan(f.planId);
  const input = await command(f, "assign");
  for (const changed of [
    { editLease: { ...f.editLease, token: "invalid-lease" } },
    { editLease: { ...f.editLease, sessionId: "other-tab" } },
    { baseRevision: before.revision + 1 }, { baseDigest: "0".repeat(64) }
  ]) {
    await assert.rejects(() => runMbtBinPlanningCommand({ ...input, ...changed }, boundary), e => e.status === 409);
    assert.deepEqual(await storedPlan(f.planId), before);
  }
  const result = await runMbtBinPlanningCommand(input, boundary);
  assert.equal(result.status, 201);
  const replay = await runMbtBinPlanningCommand(input, boundary);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, result.body);
  const afterPlan = await storedPlan(f.planId);
  const audit = (await query("SELECT revision_before::int,revision_after::int FROM mbt_audit_events WHERE idempotency_key=$1 AND source='mbt-bin-planning'", [input.idempotencyKey])).rows[0];
  assert.deepEqual(audit, { revision_before: before.revision, revision_after: afterPlan.revision });
  assert.deepEqual(afterPlan.trucks[1], before.trucks[1]);
  assert.equal(afterPlan.revision, before.revision + 1);
  assert.equal(result.body.plan.digest, afterPlan.digest);
  const reservations = await query("SELECT count(*)::int AS n FROM mbt_bin_asset_reservations WHERE visit_id=$1 AND released_at IS NULL", [f.frontVisitId]);
  assert.equal(reservations.rows[0].n, 1);
});
test("confirmation automatically releases the assigned driver; cancellation returns only that visit to pool", async () => {
  const f = await planningFixture(1501);
  await run(f, "assign"); await run(f, "confirm");
  const releases = await query("SELECT * FROM mbt_bin_planning_assignments WHERE service_visit_id=$1", [f.frontVisitId]);
  assert.equal(releases.rowCount, 1); assert.ok(releases.rows[0].released_at);
  assert.equal(String(releases.rows[0].driver_id), f.driverId);
  await run(f, "cancel");
  const visit = (await query("SELECT * FROM mbt_service_visits WHERE service_visit_id=$1", [f.frontVisitId])).rows[0];
  assert.equal(visit.status, "ready"); assert.equal(visit.dispatch_plan_id, null);
  assert.equal(visit.planned_driver_id, null); assert.equal(visit.planned_truck_id, null);
  const rows = await query("SELECT withdrawn_at FROM mbt_bin_planning_assignments WHERE service_visit_id=$1", [f.frontVisitId]);
  assert.ok(rows.rows[0].withdrawn_at);
  const pool = await getMbtBinPlanning({ planDate: f.planDate, search: f.contractNumber }, boundary);
  assert.deepEqual(pool.pool.items.map(v => v.mbt.visitId), [f.frontVisitId]);
  const detail = await getMbtBinPlanningVisit({ visitId: f.frontVisitId }, boundary);
  assert.ok(detail.history.some(h => h.action === "cancelled_assignment"));
});
test("cancel then replan on another date keeps requested dates and uses only each date's own lease", async () => {
  const f = await planningFixture(1502);
  const initial = (await query("SELECT scheduled_start_at,scheduled_end_at FROM mbt_service_visits WHERE service_visit_id=$1", [f.frontVisitId])).rows[0];
  await run(f, "assign"); await run(f, "cancel");
  const nextDate = new Date(`${f.planDate}T12:00:00Z`); nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const planDate = nextDate.toISOString().slice(0, 10);
  const nextPlan = await createDispatchPlan({ planDate });
  const leaseInput = { ...f.editLease, planDate, sessionId: crypto.randomUUID() };
  const lease = await acquireDispatchPlanEditLease(leaseInput);
  const next = { ...f, planDate, planId: nextPlan.id, editLease: { ...leaseInput, token: lease.token } };
  const load = await run(next, "save_load", { loadId: "", truckId: f.binTruckId, driverId: f.driverId, plannedStartMinute: 420, plannedFinishMinute: 480 });
  await run(next, "assign", { loadId: load.body.loadId, assetAssignments: [] });
  const saved = (await query("SELECT * FROM mbt_service_visits WHERE service_visit_id=$1", [f.frontVisitId])).rows[0];
  assert.equal(saved.dispatch_plan_id, String(next.planId));
  assert.deepEqual({ scheduled_start_at: saved.scheduled_start_at, scheduled_end_at: saved.scheduled_end_at }, initial);
  const detail = await getMbtBinPlanningVisit({ visitId: f.frontVisitId }, boundary);
  assert.equal(detail.assignments.length, 2);
  assert.ok(detail.assignments[0].withdrawn_at || detail.assignments[1].withdrawn_at);
});
test("an injected failure rolls back plan, reservations, assignment generation, audit and command receipt", async () => {
  const f = await planningFixture(1504); const before = await storedPlan(f.planId);
  const input = await command(f, "assign");
  await assert.rejects(() => runMbtBinPlanningCommand(input, { ...boundary,
    hooks: { beforeCommit: () => { throw new Error("injected planning rollback"); } } }), /injected planning rollback/);
  assert.deepEqual(await storedPlan(f.planId), before);
  const counts = (await query(`SELECT
    (SELECT count(*)::int FROM mbt_bin_asset_reservations WHERE visit_id=$1) AS reservations,
    (SELECT count(*)::int FROM mbt_bin_planning_assignments WHERE service_visit_id=$1) AS assignments,
    (SELECT count(*)::int FROM mbt_bin_dispatch_assignment_history WHERE service_visit_id=$1) AS history`, [f.frontVisitId])).rows[0];
  assert.deepEqual(counts, { reservations: 0, assignments: 0, history: 0 });
});
test("confirmation rechecks current yard and visit-step evidence requirements before releasing work", async () => {
  const f = await planningFixture(1505); await run(f, "assign");
  const before = await storedPlan(f.planId);
  await query("UPDATE mbt_yards SET active=false WHERE yard_id='00000000-0000-4000-8000-000000012441'");
  try { await assert.rejects(() => run(f, "confirm"), e => e.status === 409); }
  finally { await query("UPDATE mbt_yards SET active=true WHERE yard_id='00000000-0000-4000-8000-000000012441'"); }
  assert.deepEqual(await storedPlan(f.planId), before);
  await query("UPDATE mbt_visit_steps SET display_name='Changed required work' WHERE service_visit_id=$1", [f.frontVisitId]);
  await assert.rejects(() => run(f, "confirm"), e => e.status === 409);
  assert.deepEqual(await storedPlan(f.planId), before);
});

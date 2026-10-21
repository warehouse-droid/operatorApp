import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { closeDb, query } from "../../../src/db.js";
import { acquireDispatchPlanEditLease } from "../../../src/dispatch-plan-lease-repository.js";
import { runMbtBinPlanningCommand } from "../../../src/mbt/bin-planning-service.js";
import { planningFixture, command, boundary, storedPlan } from "../support/bin-planning-fixtures.js";
after(closeDb);

test("two commands from the same base serialize to one assignment and one conflict", async () => {
  const f = await planningFixture(2100); const first = await command(f, "assign");
  const second = { ...first, idempotencyKey: crypto.randomUUID() };
  const results = await Promise.allSettled([runMbtBinPlanningCommand(first, boundary), runMbtBinPlanningCommand(second, boundary)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.status, 409);
  const saved = await storedPlan(f.planId); assert.equal(saved.revision, first.baseRevision + 1);
  assert.equal((await query("SELECT count(*)::int n FROM mbt_bin_planning_assignments WHERE service_visit_id=$1", [f.frontVisitId])).rows[0].n, 1);
});
test("another session cannot acquire the Dispatch date being edited in MBT", async () => {
  const f = await planningFixture(2101);
  await assert.rejects(() => acquireDispatchPlanEditLease({ ...f.editLease, sessionId: crypto.randomUUID() }),
    e => e.status === 409);
  const wrongSession = await command(f, "save_load", { editLease: { ...f.editLease, sessionId: crypto.randomUUID() },
    loadId: "", truckId: f.binTruckId, driverId: f.driverId, plannedStartMinute: 800, plannedFinishMinute: 850 });
  await assert.rejects(() => runMbtBinPlanningCommand(wrongSession, boundary), e => e.status === 409);
});
test("a lease that expires before commit rolls back the assignment and emits no refresh", async () => {
  const f = await planningFixture(2102); const before = await storedPlan(f.planId); let events = 0;
  const input = await command(f, "assign");
  await assert.rejects(() => runMbtBinPlanningCommand(input, { ...boundary,
    onCommitted: () => {events++;}, hooks: { beforeCommit: () => query(
      "UPDATE dispatch_plan_edit_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE plan_date=$1", [f.planDate]) } }), e => e.status === 409);
  assert.deepEqual(await storedPlan(f.planId), before); assert.equal(events, 0);
  assert.equal((await query("SELECT count(*)::int n FROM mbt_bin_asset_reservations WHERE visit_id=$1", [f.frontVisitId])).rows[0].n, 0);
});

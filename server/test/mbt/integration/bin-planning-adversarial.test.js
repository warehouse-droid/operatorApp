import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { query, closeDb } from "../../../src/db.js";
import { runMbtBinPlanningCommand, getMbtBinPlanning, getMbtBinPlanningVisit } from "../../../src/mbt/bin-planning-service.js";
import { planningFixture, command, boundary, run, storedPlan } from "../support/bin-planning-fixtures.js";
import { stagePlanningAssignment } from "../../../src/mbt/bin-planning-assignments.js";
after(closeDb);

test("hostile inputs and disabled capabilities cannot change the shared day", async () => {
  const f = await planningFixture(2200); const input = await command(f, "assign"); const before = await storedPlan(f.planId);
  for (const overrides of [
    { action: "unknown" }, { actor: { operatorId: f.actor.operatorId, roles: ["driver"] } },
    { expectedVisitRevision: 0 }, { expectedVisitRevision: 900 }, { visitId: crypto.randomUUID() },
    { loadId: "missing" }, { action: "cancel" }, { action: "sequence" },
    { action: "advance", completedVisitId: f.frontVisitId, expectedCompletedVisitRevision: 1 },
    { action: "save_load", loadId: f.flatbedLoadId, truckId: f.binTruckId, driverId: f.driverId, plannedStartMinute: 800, plannedFinishMinute: 850 },
    { action: "save_load", plannedStartMinute: 1500, plannedFinishMinute: 1440 },
    { action: "delete_load", loadId: f.binLoadIds[1] },
    { planDate: "2026-02-30" }, { planDate: "garbage" }, { reason: "" }, { idempotencyKey: "" }
  ]) {
    await assert.rejects(() => runMbtBinPlanningCommand({ ...input, ...overrides }, boundary), e => [400, 403, 404, 409].includes(e.status));
    assert.deepEqual(await storedPlan(f.planId), before);
  }
  for (const field of ["environmentEnabled", "databaseEnabled", "pilotAuthorized"]) {
    await assert.rejects(() => runMbtBinPlanningCommand(input, { capability: { ...boundary.capability, [field]: false } }), e => e.code === "MBT_CAPABILITY_DISABLED");
  }
  await assert.rejects(() => getMbtBinPlanningVisit({ visitId: crypto.randomUUID() }, boundary), e => e.status === 404);
  const noPlan = await getMbtBinPlanning({ planDate: "2097-01-01", search: crypto.randomUUID(), offset: -10, limit: 500 }, boundary);
  assert.equal(noPlan.plan, null); assert.equal(noPlan.pool.total, 0); assert.equal(noPlan.pool.limit, 100);
});

test("load lifecycle validates time, fleet and ordinary boundaries; editing a released load requires confirmation", async () => {
  const f = await planningFixture(2201); const before = await storedPlan(f.planId);
  for (const loadId of [f.flatbedLoadId, f.binLoadIds[1]]) {
    const dirty = structuredClone(before);
    const load = dirty.trucks.flatMap(t => t.loads).find(l => l.id === loadId);
    if (loadId === f.flatbedLoadId) {load.stops = [{ id: "ordinary", type: "drop" }];}
    else {load.plannedStartMinute = null; load.plannedFinishMinute = null; delete load.startTime;}
    await query("UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1", [f.planId, JSON.stringify(dirty.trucks)]);
    await assert.rejects(() => run(f, "assign", { loadId }), e => ["MBT_BIN_LOAD_REQUIRED", "MBT_BIN_LOAD_TIME_REQUIRED"].includes(e.code));
  }
  await query("UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1", [f.planId, JSON.stringify(before.trucks)]);
  await assert.rejects(() => run(f, "save_load", { loadId: "", driverId: f.driverId, truckId: f.flatbedTruckId,
    plannedStartMinute: 800, plannedFinishMinute: 850 }), e => e.code === "MBT_BIN_TRUCK_REQUIRED");
  await run(f, "confirm");
  const created = await run(f, "save_load", { loadId: "", driverId: f.driverId, truckId: f.binTruckId,
    plannedStartMinute: 800, plannedFinishMinute: 850 });
  await run(f, "delete_load", { loadId: created.body.loadId });
  assert.equal((await storedPlan(f.planId)).trucks.flatMap(t => t.loads).some(l => l.id === created.body.loadId), false);
  await run(f, "assign"); await run(f, "confirm");
  await assert.rejects(() => run(f, "delete_load"), e => e.code === "MBT_BIN_LOAD_NOT_EMPTY");
  await run(f, "save_load", { driverId: f.driverId, truckId: f.binTruckId, plannedStartMinute: 420, plannedFinishMinute: 490 });
  const edited = await storedPlan(f.planId);
  assert.ok(edited.trucks[0].loads.find(l => l.id === f.binLoadIds[0]).stops.every(s => s.mbt.driverReleased === false));
  await run(f, "confirm");
});

test("stale assignment evidence, asset status and reservations prevent publication atomically", async () => {
  const f = await planningFixture(2202); await run(f, "assign"); const before = await storedPlan(f.planId);
  await query("UPDATE mbt_bin_assets SET under_maintenance=true WHERE asset_id=$1", [f.assetId]);
  await assert.rejects(() => run(f, "sequence", { direction: 1 }), e => e.code === "MBT_BIN_ASSET_UNAVAILABLE");
  assert.deepEqual(await storedPlan(f.planId), before);
  await query("UPDATE mbt_bin_assets SET under_maintenance=false WHERE asset_id=$1", [f.assetId]);
  await query("UPDATE mbt_bin_planning_assignments SET snapshot=snapshot||'{\"tampered\":true}'::jsonb WHERE service_visit_id=$1", [f.frontVisitId]);
  await assert.rejects(() => run(f, "confirm"), e => e.code === "MBT_BIN_CONFIRMATION_INVALID");
  await query("UPDATE mbt_bin_planning_assignments SET snapshot=snapshot-'tampered' WHERE service_visit_id=$1", [f.frontVisitId]);
  await query("UPDATE mbt_bin_asset_reservations SET released_at=now(),released_by='adversary',release_reason='test' WHERE visit_id=$1", [f.frontVisitId]);
  await assert.rejects(() => run(f, "confirm"), e => e.code === "MBT_BIN_CONFIRMATION_INVALID");
  assert.deepEqual(await storedPlan(f.planId), before);
  await query("UPDATE mbt_service_visits SET status='completed',actual_completed_at=now() WHERE service_visit_id=$1", [f.frontVisitId]);
  await assert.rejects(() => run(f, "confirm"), e => e.code === "MBT_BIN_CONFIRMATION_INVALID");
  const staging = await command(f, "assign");
  await assert.rejects(() => stagePlanningAssignment(f.frontVisitId, before, staging), e => e.code === "MBT_BIN_VISIT_COMPLETE");
  const completed = (await query("SELECT revision::int FROM mbt_service_visits WHERE service_visit_id=$1", [f.frontVisitId])).rows[0];
  await run(f, "advance", { completedVisitId: f.frontVisitId, expectedCompletedVisitRevision: completed.revision });
  const successor = (await query("SELECT status,dispatch_plan_id FROM mbt_service_visits WHERE service_visit_id=$1", [f.successorVisitId])).rows[0];
  assert.deepEqual(successor, { status: "ready", dispatch_plan_id: null });
});

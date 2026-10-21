import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { query, closeDb } from "../../../src/db.js";
import { assertPlanningCapacity } from "../../../src/mbt/bin-planning-capacity.js";
import { reserveResumedPlanningAsset } from "../../../src/mbt/bin-planning-reservations.js";
import { createLoadedDumpDriverBinFixture } from "../support/driver-bin-scenario-fixtures.js";
import { planningFixture, storedPlan } from "../support/bin-planning-fixtures.js";
after(closeDb);
test("loaded pickup, dump, and return occupancy fit one slot; unknown movement actions are rejected", async () => {
  const f = await createLoadedDumpDriverBinFixture(); const plan = await storedPlan(f.planId);
  assert.equal(await assertPlanningCapacity(plan), true);
  const visit = (await query("SELECT * FROM mbt_service_visits WHERE service_visit_id=$1", [f.frontVisitId])).rows[0];
  await assert.rejects(() => reserveResumedPlanningAsset({ ...visit, customer_site_profile_id: crypto.randomUUID() },
    { assetId: f.assetId }, f.binTruckId, {}), e => e.code === "MBT_BIN_CUSTODY_CONFLICT");
  const stop = plan.trucks[0].loads[0].stops[0];
  await query("UPDATE mbt_visit_steps SET action_code='unknown_movement' WHERE service_visit_id=$1 AND action_code=$2", [f.frontVisitId, stop.actionCode]);
  stop.actionCode = "unknown_movement";
  await assert.rejects(() => assertPlanningCapacity(plan), e => e.code === "MBT_BIN_ROUTE_INVALID");
});
test("an untouched yard bin cannot be presented as recorded resumed custody", async () => {
  const f = await planningFixture(2250);
  const visit = (await query("SELECT * FROM mbt_service_visits WHERE service_visit_id=$1", [f.frontVisitId])).rows[0];
  await assert.rejects(() => reserveResumedPlanningAsset(visit, { assetId: f.assetId }, f.binTruckId, {}), e => e.code === "MBT_BIN_CUSTODY_CONFLICT");
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { query, closeDb } from "../../../src/db.js";
import { getMbtBinPlanning } from "../../../src/mbt/bin-planning-service.js";
import { planningFixture, boundary, run, storedPlan } from "../support/bin-planning-fixtures.js";
after(closeDb);

test("pool searches before pagination, includes more than 100 visits and isolates blocked cards", async () => {
  const f = await planningFixture(1800);
  const marker = `page-${crypto.randomUUID()}`;
  const expected = new Set();
  for (let i = 0; i < 105; i++) {
    const contractId = crypto.randomUUID(); const visitId = crypto.randomUUID(); expected.add(visitId);
    await query(`INSERT INTO mbt_contracts SELECT (jsonb_populate_record(NULL::mbt_contracts,
      to_jsonb(c)||jsonb_build_object('contract_id',$2::text,'contract_number',$3::text))).*
      FROM mbt_contracts c WHERE contract_id=$1`, [f.contractId, contractId, `${marker}-${i}`]);
    await query(`INSERT INTO mbt_service_visits SELECT (jsonb_populate_record(NULL::mbt_service_visits,
      to_jsonb(v)||jsonb_build_object('contract_id',$2::text,'service_visit_id',$3::text,'visit_reference',$4::text))).*
      FROM mbt_service_visits v WHERE service_visit_id=$1`, [f.frontVisitId, contractId, visitId, `${marker}-${i}`]);
  }
  const seen = new Set(); let offset = 0;
  do {
    const page = await getMbtBinPlanning({ planDate: f.planDate, search: marker, offset, limit: 40 }, boundary);
    assert.equal(page.pool.total, 105);
    for (const card of page.pool.items) {assert.equal(seen.has(card.mbt.visitId), false); seen.add(card.mbt.visitId);}
    offset = page.pool.nextOffset;
  } while (offset !== null);
  assert.deepEqual(seen, expected);
  const searched = await getMbtBinPlanning({ planDate: f.planDate, search: `${marker}-104`, limit: 1 }, boundary);
  assert.equal(searched.pool.total, 1); assert.equal(searched.pool.items.length, 1);
  await query("UPDATE mbt_bin_assets SET under_maintenance=true WHERE asset_id=$1", [f.assetId]);
  const blocked = await getMbtBinPlanning({ planDate: f.planDate, search: marker, limit: 40 }, boundary);
  assert.equal(blocked.pool.items.length, 40);
  assert.ok(blocked.pool.items.every(card => card.blockedReason && !card.mbt.frontLeg.dispatchable));
});

test("BIN timing edits reject shared driver and truck conflicts and leave ordinary work untouched", async () => {
  const f = await planningFixture(1801);
  await run(f, "assign"); const before = await storedPlan(f.planId);
  await assert.rejects(() => run(f, "save_load", { loadId: "", truckId: f.binTruckId, driverId: f.driverId,
    plannedStartMinute: 430, plannedFinishMinute: 500 }), e => e.status === 409);
  assert.deepEqual(await storedPlan(f.planId), before);
  const created = await run(f, "save_load", { loadId: "", truckId: f.binTruckId, driverId: f.driverId,
    plannedStartMinute: 800, plannedFinishMinute: 860 });
  assert.deepEqual(created.body.plan.trucks[1], before.trucks[1]);
  await run(f, "move", { toLoadId: created.body.loadId });
  const moved = await storedPlan(f.planId);
  assert.equal(moved.trucks[0].loads.find(l => l.id === f.binLoadIds[0]).stops.length, 0);
  assert.equal(moved.trucks[0].loads.find(l => l.id === created.body.loadId).stops.length, 2);
});

test("sequential whole visits share one slot and can be sequenced without losing groups", async () => {
  const f = await planningFixture(1802); const second = await planningFixture(1803);
  await run(f, "assign");
  await run(f, "assign", { visitId: second.frontVisitId, expectedVisitRevision: 1, assetAssignments: [] });
  await run(f, "confirm");
  const before = await storedPlan(f.planId);
  assert.equal(before.trucks[0].loads[0].stops.length, 4);
  await run(f, "sequence", { direction: 1 });
  const sequenced = await storedPlan(f.planId);
  assert.deepEqual(sequenced.trucks[0].loads[0].stops.map(s => s.mbt.visitId),
    [second.frontVisitId, second.frontVisitId, f.frontVisitId, f.frontVisitId]);
  await run(f, "sequence", { beforeVisitId: second.frontVisitId });
  await run(f, "confirm");
  const afterPlan = await storedPlan(f.planId);
  assert.deepEqual(afterPlan.trucks[0].loads[0].stops.map(s => s.mbt.visitId),
    [f.frontVisitId, f.frontVisitId, second.frontVisitId, second.frontVisitId]);
  assert.ok(afterPlan.trucks[0].loads[0].stops.every(s => s.mbt.driverReleased));
  assert.deepEqual(afterPlan.trucks[1], before.trucks[1]);
});

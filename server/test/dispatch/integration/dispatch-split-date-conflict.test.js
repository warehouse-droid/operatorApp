import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";
import { query } from "../../../src/db.js";
import { syncDispatchPlanOrderAssignments } from "../../../src/dispatch-planner-v2-repository.js";

let fixture;
before(async () => {
  fixture = await createDispatchV2Fixture();
  await query("INSERT INTO dispatch_trucks (plate, active, capacity_lbs) VALUES ('SPLIT-HTTP-TRUCK', true, 80000)");
});
after(async () => { await fixture?.close(); });

const order = (id, parent = "") => ({ id, type: "SO", originalOrderId: parent,
  customer: "Split date test", address: "100 Isolated Test Road", sourceYard: "3445",
  pickupLocations: ["3445"], pallets: 1, weight: 10, salesQty: 1,
  items: [{ itemId: 1, lineId: 1, sku: "TEST-CARGO", quantity: 1, pallets: 1, unit: "EA" }] });
const trucks = ref => [{ id: "SPLIT-HTTP-TRUCK", plate: "SPLIT-HTTP-TRUCK", loads: [{
  id: "split-http-load", name: "Load 1", stops: [{ id: "split-http-drop", type: "drop", orderId: ref, location: "3445" }]
}] }];

async function seeded(date, orders, stopRef = "") {
  const plan = await fixture.seedPlan({ date, refs: [] });
  const board = stopRef ? trucks(stopRef) : [];
  await query("UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb WHERE plan_id=$1", [plan.id, JSON.stringify(orders), JSON.stringify(board)]);
  await syncDispatchPlanOrderAssignments({ id: plan.id, revision: plan.revision, planDate: date, orders, trucks: board });
  return { ...plan, orders, trucks: board };
}

async function save(plan, orders, ref, mode, key) {
  const sessionId = `split-date-${key}`;
  const lease = await fixture.acquireLease({ planDate: plan.plan_date, sessionId });
  const bootstrap = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${plan.id}&date=${plan.plan_date}`);
  assert.equal(bootstrap.response.status, 200, JSON.stringify(bootstrap.payload));
  const payload = { planDate: plan.plan_date, orders, trucks: trucks(ref), summary: {}, baseRevision: plan.revision,
    baseDigest: bootstrap.payload.plan.digest,
    editLeaseToken: lease, audit: { sessionId } };
  if (mode === "classic") { return fixture.request(`/api/dispatch/plans/${plan.id}`, { method: "PUT", body: payload, headers: { "x-dispatch-edit-lease": lease } }); }
  return fixture.request(`/api/dispatch/v2/plans/${plan.id}/commands`, { method: "POST", headers: { "x-dispatch-edit-lease": lease }, body: {
    commandId: `split-date-command-${key}`, commandType: "replace_plan", baseRevision: bootstrap.payload.plan.revision,
    baseDigest: bootstrap.payload.plan.digest, sessionId, payload: { ...payload, actionName: "split_date_regression" }
  } });
}

for (const [index, mode] of ["classic", "v2"].entries()) {
  test(`${mode} save accepts S2 on a later date and preserves S1's earlier saved route`, async () => {
    const parent = `SO-SPLIT-HTTP-${mode}`;
    const s1 = order(`${parent}-S1`, parent), s2 = order(`${parent}-S2`, parent);
    const owner = await seeded(`2096-11-${10 + index * 2}`, [s1, s2], s1.id);
    const ownerSnapshot = (await query("SELECT orders,trucks FROM dispatch_plan_snapshots WHERE plan_id=$1", [owner.id])).rows[0];
    const target = await seeded(`2096-11-${11 + index * 2}`, []);
    const result = await save(target, [s2], s2.id, mode, `${mode}-sibling`);
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    const assigned = (await query("SELECT order_ref,planned_order_ref FROM dispatch_plan_order_assignments WHERE plan_id=$1 AND order_ref=$2", [target.id, s2.id])).rows;
    assert.deepEqual(assigned, [{ order_ref: s2.id, planned_order_ref: s2.id }]);
    assert.deepEqual((await query("SELECT orders,trucks FROM dispatch_plan_snapshots WHERE plan_id=$1", [owner.id])).rows[0], ownerSnapshot);
  });
}

test("HTTP save rejects an exact duplicate split and retains the rejected draft", async () => {
  const parent = "SO-SPLIT-DUPLICATE-HTTP";
  const split = order(`${parent}-S2`, parent);
  await seeded("2096-11-20", [split], split.id);
  const target = await seeded("2096-11-21", []);
  const result = await save(target, [split], split.id, "classic", "duplicate");
  assert.equal(result.response.status, 202, JSON.stringify(result.payload));
  assert.equal(result.payload.code, "DISPATCH_PLAN_RECOVERY_SAVED");
  assert.equal(result.payload.applied, false);
  assert.equal(result.payload.validationIssues[0].code, "DISPATCH_ORDER_ALREADY_PLANNED");
  assert.equal((await query("SELECT revision::int AS revision FROM dispatch_plans WHERE id=$1", [target.id])).rows[0].revision, target.revision);
  assert.ok((await query("SELECT 1 FROM dispatch_plan_snapshot_history WHERE plan_id=$1 AND archive_reason='save_recovery'", [target.id])).rowCount);
});

test("HTTP save still rejects a split when its whole parent is planned elsewhere", async () => {
  const parent = "SO-WHOLE-HTTP";
  await seeded("2096-11-22", [order(parent)], parent);
  const target = await seeded("2096-11-23", []);
  const split = order(`${parent}-S2`, parent);
  const result = await save(target, [split], split.id, "classic", "whole-parent");
  assert.equal(result.response.status, 202, JSON.stringify(result.payload));
  assert.equal(result.payload.code, "DISPATCH_PLAN_RECOVERY_SAVED");
  assert.equal(result.payload.applied, false);
  assert.equal(result.payload.validationIssues[0].code, "DISPATCH_ORDER_ALREADY_PLANNED");
  assert.equal((await query("SELECT revision::int AS revision FROM dispatch_plans WHERE id=$1", [target.id])).rows[0].revision, target.revision);
});

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";
import { query } from "../../../src/db.js";
import { syncDispatchPlanOrderAssignments } from "../../../src/dispatch-planner-v2-repository.js";
import { dispatchOrderFromCustomOrder, getDispatchCustomOrder } from "../../../src/dispatch-custom-order-repository.js";

let fixture;
before(async () => {
  fixture = await createDispatchV2Fixture();
  await query("INSERT INTO dispatch_trucks (plate, active, capacity_lbs) VALUES ('SOR-DATE-TRUCK', true, 80000)");
});
after(async () => { await fixture?.close(); });

function order(id, isReturn = false) {
  return { id, type: isReturn ? "CUSTOM" : "SO", customOrder: isReturn,
    ...(isReturn ? { sourceTable: "dispatch_custom_orders", parentOrderRef: id.replace(/-Return$/, ""), orderKind: "sor_rental_return" } : {}),
    sourceYard: "3445", pickupLocations: ["3445"], address: "3445", totalWeightLbs: 100,
    status: "Pending Fulfillment", testOnly: true, items: [{ itemName: "Rental lift", quantity: 1, uom: "EA" }] };
}
function trucks(ref) {
  return [{ id: "SOR-DATE-TRUCK", plate: "SOR-DATE-TRUCK", loads: [{ id: "sor-date-load", name: "Load 1",
    stops: [{ id: "sor-date-drop", type: "drop", orderId: ref, location: "3445" }] }] }];
}
async function collectionOrder(delivery) {
  const sourceId = Number(delivery.id.replace(/\D/g, ""));
  await query("INSERT INTO sales_orders(netsuite_id,tranid,netsuite_active,sales_order_type,status_text) VALUES($1,$2,true,'Delivery','Pending Fulfillment')", [sourceId, delivery.id]);
  const result = await query(`INSERT INTO dispatch_custom_orders(ref_number,pickup_location,dropoff_location,order_details,weight_lbs,
    order_kind,system_managed,parent_sales_order_id,parent_order_ref,line_snapshot,sales_qty,billing_disposition)
    VALUES($1,'3445','3445','Synthetic rental return',100,'sor_rental_return',true,$2,$3,$4::jsonb,1,'linked_parent_no_charge') RETURNING id`,
  [`${delivery.id}-Return`, sourceId, delivery.id, JSON.stringify(delivery.items)]);
  return dispatchOrderFromCustomOrder(await getDispatchCustomOrder(result.rows[0].id));
}
async function seeded(date, orders, ref = "") {
  const plan = await fixture.seedPlan({ date, refs: [] });
  const board = ref ? trucks(ref) : [];
  await query("UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb WHERE plan_id=$1", [plan.id, JSON.stringify(orders), JSON.stringify(board)]);
  await syncDispatchPlanOrderAssignments({ id: plan.id, revision: plan.revision, planDate: date, orders, trucks: board });
  return plan;
}
async function savedSnapshot(id) {
  return (await query("SELECT orders,trucks FROM dispatch_plan_snapshots WHERE plan_id=$1", [id])).rows[0];
}
async function save(plan, orders, ref, mode, key) {
  const sessionId = `sor-date-${key}`;
  const lease = await fixture.acquireLease({ planDate: plan.plan_date, sessionId });
  const bootstrap = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${plan.id}&date=${plan.plan_date}`);
  assert.equal(bootstrap.response.status, 200, JSON.stringify(bootstrap.payload));
  const payload = { planDate: plan.plan_date, orders, trucks: trucks(ref), summary: {}, baseRevision: bootstrap.payload.plan.revision,
    baseDigest: bootstrap.payload.plan.digest, editLeaseToken: lease, audit: { sessionId } };
  if (mode === "classic") {
    return fixture.request(`/api/dispatch/plans/${plan.id}`, { method: "PUT", body: payload, headers: { "x-dispatch-edit-lease": lease } });
  }
  return fixture.request(`/api/dispatch/v2/plans/${plan.id}/commands`, { method: "POST", headers: { "x-dispatch-edit-lease": lease }, body: {
    commandId: `sor-date-command-${key}`, commandType: "replace_plan", baseRevision: bootstrap.payload.plan.revision,
    baseDigest: bootstrap.payload.plan.digest, sessionId, payload: { ...payload, actionName: "sor_date_regression" }
  } });
}

for (const [index, mode] of ["classic", "v2"].entries()) {
  test(`${mode}: save a rental return on a later date without changing the delivery route`, async () => {
    const delivery = order(`SOR9922${index}1`), collection = await collectionOrder(delivery);
    const earlier = await seeded(`2096-12-${String(1 + index * 2).padStart(2, "0")}`, [delivery, collection], delivery.id);
    const earlierSnapshot = await savedSnapshot(earlier.id);
    const target = await seeded(`2096-12-${String(2 + index * 2).padStart(2, "0")}`, []);
    const result = await save(target, [collection], collection.id, mode, `${mode}-independent`);
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.deepEqual((await query("SELECT order_ref,planned_order_ref,assignment_kind FROM dispatch_plan_order_assignments WHERE plan_id=$1 ORDER BY order_ref", [target.id])).rows,
      [{ order_ref: collection.id, planned_order_ref: collection.id, assignment_kind: "direct" }]);
    assert.deepEqual(await savedSnapshot(earlier.id), earlierSnapshot);
    assert.equal((await query("SELECT 1 FROM dispatch_plan_snapshot_history WHERE plan_id=$1 AND archive_reason='save_recovery'", [target.id])).rowCount, 0);
  });

  test(`${mode}: a return can be planned before its unfinished delivery`, async () => {
    const delivery = order(`SOR9922${index}2`), collection = await collectionOrder(delivery);
    const deliveryPlan = await seeded(`2096-11-${20 + index}`, [delivery], delivery.id);
    const deliverySnapshot = await savedSnapshot(deliveryPlan.id);
    const target = await seeded(`2096-11-${18 + index}`, []);
    const result = await save(target, [collection], collection.id, mode, `${mode}-return-before-delivery`);
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.deepEqual(await savedSnapshot(deliveryPlan.id), deliverySnapshot);
    assert.equal((await query("SELECT 1 FROM driver_job_records WHERE status='complete' AND order_refs @> $1::jsonb",
      [JSON.stringify([delivery.id])])).rowCount, 0);
  });
}

test("a duplicate return is rejected with a retained draft and unchanged active route", async () => {
  const collection = await collectionOrder(order("SOR992299"));
  const owner = await seeded("2096-12-10", [collection], collection.id);
  const ownerSnapshot = await savedSnapshot(owner.id);
  const target = await seeded("2096-12-11", []);
  const activeSnapshot = await savedSnapshot(target.id);
  const result = await save(target, [collection], collection.id, "classic", "duplicate");
  assert.equal(result.response.status, 202, JSON.stringify(result.payload));
  assert.equal(result.payload.code, "DISPATCH_PLAN_RECOVERY_SAVED");
  assert.equal(result.payload.applied, false);
  assert.equal(result.payload.validationIssues[0].code, "DISPATCH_ORDER_ALREADY_PLANNED");
  assert.equal(result.payload.validationIssues[0].conflicts[0].orderRef, collection.id);
  assert.deepEqual(await savedSnapshot(target.id), activeSnapshot);
  assert.deepEqual(await savedSnapshot(owner.id), ownerSnapshot);
  assert.equal((await query("SELECT revision::int AS revision FROM dispatch_plans WHERE id=$1", [target.id])).rows[0].revision, target.revision);
  assert.ok((await query("SELECT 1 FROM dispatch_plan_snapshot_history WHERE plan_id=$1 AND archive_reason='save_recovery'", [target.id])).rowCount);
});

test("a scheduled return does not reserve its linked delivery reference", async () => {
  const delivery = order("SOR992288"), collection = await collectionOrder(delivery);
  const owner = await seeded("2096-12-20", [collection], collection.id);
  const ownerSnapshot = await savedSnapshot(owner.id);
  const target = await seeded("2096-12-21", []);
  const result = await save(target, [delivery], delivery.id, "classic", "delivery-independent");
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.deepEqual(await savedSnapshot(owner.id), ownerSnapshot);
});

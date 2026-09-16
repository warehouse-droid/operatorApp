import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import fc from "fast-check";
import { query, closeDb } from "../../../src/db.js";
import { seedOperatorPickup } from "../../support/operator-ui-enhancements-fixture.mjs";
import { syncDispatchDeliveryGroupsFromPlan } from "../../../src/dispatch-delivery-group-repository.js";
import { getDeliveryOrder } from "../../../src/delivery-repository.js";
import { listConsolidationLoadOrders, readConsolidationOrders, createConsolidationLoadPreview, revalidateConsolidationLoad } from "../../../src/consolidation-load-repository.js";
import { submitConsolidatedLoad } from "../../../src/consolidation-load-service.js";

after(closeDb);
async function plan() {
  return (await query(`INSERT INTO dispatch_plans(plan_date,status)
    SELECT day::date,'confirmed' FROM generate_series(DATE '2098-01-01',DATE '2098-12-31',INTERVAL '1 day') day
    WHERE NOT EXISTS(SELECT 1 FROM dispatch_plans p WHERE p.plan_date=day::date) ORDER BY day LIMIT 1 RETURNING id,plan_date::text`)).rows[0];
}
async function fixture() {
  const first = await seedOperatorPickup(), second = await seedOperatorPickup(), schedule = await plan();
  const groupId = `GOA-GROUP-PLAN-${crypto.randomUUID()}`;
  const orders = [first, second], ids = orders.map((order) => order.orderId);
  const group = { id: groupId, type: "SO", childOrders: orders.map((order) => order.tranid),
    childOrderDetails: orders.map((order) => ({ id: order.tranid, type: "SO" })) };
  const truck = { id: "GROUP-TRUCK", plate: "GROUP-TRUCK", loads: [{ id: `load-${schedule.id}`, name: "Load 1", stops: [{ type: "drop", orderId: groupId }] }] };
  await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2,$3,'{}')", [schedule.id, JSON.stringify([group]), JSON.stringify([truck])]);
  await syncDispatchDeliveryGroupsFromPlan({ id: schedule.id, planDate: schedule.plan_date, status: "confirmed", orders: [group], trucks: [truck] });
  await query(`UPDATE sales_orders SET sales_order_type='Delivery',operator_status='packed',dispatch_planned=false,
    dispatch_plan_date=NULL,dispatch_truck_plate=NULL,dispatch_load_name=NULL WHERE netsuite_id=ANY($1::bigint[])`, [ids]);
  await query("UPDATE sales_order_lines SET packed_piece_qty=20,confirmed=true WHERE sales_order_id=ANY($1::bigint[])", [ids]);
  return { operator: first.operator, orders, ids, plan: schedule, group, groupId, truck };
}
async function listed(f) {
  return listConsolidationLoadOrders(f.operator, { locationId: 1, planDate: f.plan.plan_date });
}
async function updateTruck(f, trucks = [f.truck]) {
  await query("UPDATE dispatch_plan_snapshots SET trucks=$2 WHERE plan_id=$1", [f.plan.id, JSON.stringify(trucks)]);
}

test("group-only packed orders with blank child dispatch fields appear and resolve their current load", async () => {
  const f = await fixture();
  const result = await listed(f);
  assert.deepEqual(result.orders.map((order) => order.netsuite_id).sort(), [...f.ids].sort());
  for (const order of result.orders) {
    assert.equal(order.assignment.planDate, f.plan.plan_date);
    assert.equal(order.assignment.truckPlate, "GROUP-TRUCK");
    assert.equal(order.assignment.loadId, f.truck.loads[0].id);
  }
  const original = await getDeliveryOrder(f.ids[0]);
  assert.equal(original.dispatch_plan_date, null, "Listing must not change the source order's projection");
  assert.equal(Number(original.lines[0].packed_piece_qty), 20);
});

test("listed child IDs and group IDs preview identically; submit revalidates blank children and replays once", async () => {
  const f = await fixture();
  const children = await createConsolidationLoadPreview(f.operator, { locationId: 1, orderIds: f.ids });
  const group = await createConsolidationLoadPreview(f.operator, { locationId: 1, orderIds: [f.groupId] });
  assert.deepEqual(children.snapshot, group.snapshot);
  await revalidateConsolidationLoad(f.operator, children);
  const photos = [1, 2].map((n) => `r2://operator/operator-consolidation-load-photo/2026/09/16/${children.id}/${n}.jpg`);
  const complete = await submitConsolidatedLoad(f.operator, children.id, photos);
  assert.equal(complete.status, "completed");
  assert.equal((await submitConsolidatedLoad(f.operator, children.id, photos)).status, "completed");
  assert.equal((await query("SELECT count(*)::int AS n FROM operator_load_records WHERE order_id=ANY($1::bigint[])", [f.ids])).rows[0].n, 2);
  assert.equal((await query("SELECT 1 FROM operator_netsuite_posting_commands WHERE actor_operator_id=$1", [f.operator.id])).rowCount, 0);
});

test("group inheritance still rejects missing, return-only, ambiguous and changed loads", async () => {
  const f = await fixture();
  const batch = await createConsolidationLoadPreview(f.operator, { locationId: 1, orderIds: f.ids });
  for (const loads of [[], [{ ...f.truck.loads[0], returnOnly: true }], [f.truck.loads[0], { ...f.truck.loads[0], id: "competing-load" }]]) {
    await updateTruck(f, [{ ...f.truck, loads }]);
    assert.deepEqual((await listed(f)).orders, []);
    await assert.rejects(revalidateConsolidationLoad(f.operator, batch), { code: "CONSOLIDATION_LOAD_STALE" });
  }
  await updateTruck(f, [{ ...f.truck, plate: "DIFFERENT-TRUCK" }]);
  await assert.rejects(revalidateConsolidationLoad(f.operator, batch), { code: "CONSOLIDATION_LOAD_STALE" });
  assert.equal((await query("SELECT 1 FROM operator_load_records WHERE order_id=ANY($1::bigint[])", [f.ids])).rowCount, 0);
  await updateTruck(f);
  await query("UPDATE sales_orders SET outbound_location_id=28 WHERE netsuite_id=$1", [f.ids[1]]);
  assert.deepEqual((await listed(f)).orders.map((order) => order.netsuite_id), [f.ids[0]]);
  await assert.rejects(createConsolidationLoadPreview(f.operator, { locationId: 1, orderIds: [f.groupId] }), { code: "OPERATOR_YARD_FORBIDDEN" });
});

test("properties: group date fallback is family-scoped, active, unique and never overrides an existing date", async () => {
  const f = await fixture(), otherPlan = await plan(), otherGroup = `GOA-OTHER-${crypto.randomUUID()}`;
  await query(`INSERT INTO dispatch_delivery_groups(group_ref,plan_id,plan_date,order_type,active) VALUES($1,$2,$3,'sales_order',false)`, [otherGroup, otherPlan.id, otherPlan.plan_date]);
  await query("INSERT INTO dispatch_delivery_group_members(group_ref,member_order_ref,position) VALUES($1,$2,0)", [otherGroup, f.orders[0].tranid]);
  await fc.assert(fc.asyncProperty(fc.record({ ownDate: fc.boolean(), active: fc.boolean(), sameFamily: fc.boolean(), canceled: fc.boolean(), conflict: fc.boolean() }), async (state) => {
    await query("UPDATE sales_orders SET dispatch_plan_date=$2 WHERE netsuite_id=$1", [f.ids[0], state.ownDate ? f.plan.plan_date : null]);
    await query("UPDATE dispatch_delivery_groups SET active=$2,order_type=$3 WHERE group_ref=$1", [f.groupId, state.active, state.sameFamily ? "sales_order" : "transfer_order"]);
    await query("UPDATE dispatch_delivery_groups SET active=$2 WHERE group_ref=$1", [otherGroup, state.conflict]);
    await query("UPDATE dispatch_plans SET status=$2 WHERE id=$1", [f.plan.id, state.canceled ? "cancelled" : "confirmed"]);
    const eligible = !state.canceled && (state.ownDate || (state.active && state.sameFamily && !state.conflict));
    if (eligible) {
      const [order] = await readConsolidationOrders(f.operator, 1, [f.ids[0]]);
      assert.equal(order.assignment.planDate, f.plan.plan_date);
      assert.equal(order.assignment.loadId, f.truck.loads[0].id);
    } else {
      await assert.rejects(readConsolidationOrders(f.operator, 1, [f.ids[0]]), { code: "CONSOLIDATION_LOAD_STALE" });
    }
  }), { seed: 16092027, numRuns: 80 });
});

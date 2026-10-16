import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";
import {query, withTransaction, closeDb} from "../../../src/db.js";
import {listDispatchOrders} from "../../../src/dispatch-repository.js";
import {scrubBilledSalesOrderFamiliesFromPlan, applyDispatchSalesFamilyMaintenance, createDispatchPlan, getDispatchPlan,
  reconcileSalesOrderFamilyInDispatchPlans, cleanupBilledSalesOrderFamilyFromDispatchPlans,
  cleanupBilledSalesOrderFamiliesFromDispatchPlan} from "../../../src/dispatch-plan-repository.js";
import {acquireDispatchPlanEditLease} from "../../../src/dispatch-plan-lease-repository.js";
import {processDispatchPlanMaintenance} from "../../../src/dispatch-plan-maintenance.js";
import {createOperator} from "../../../src/auth-repository.js";
import {loadDispatchOrdersForResponse} from "../../../src/server.js";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
test.after(closeDb);

async function fixture(run) {
  return withTransaction(async () => {
    const id = 9996000000 + Math.floor(Math.random() * 100000);
    const ref = `SO-BILL-${randomUUID().slice(0, 8)}`;
    await query(`INSERT INTO sales_orders (netsuite_id,tranid,status,status_text,customer,outbound_location_id,
      outbound_location,sales_order_type,operator_status,local_yard_order_status,fulfillment_status,netsuite_active)
      VALUES ($1,$2,'G','Sales Order : Billed','Fixture',15,'12441','Delivery','open','Open','not_fulfilled',true)`, [id, ref]);
    await query(`INSERT INTO sales_order_lines (sales_order_id,line_id,item_id,item_name,item_type,quantity,unit,pallet_qty,netsuite_active)
      VALUES ($1,1,25,'Fixture','Assembly',10,'EA',1,true)`, [id]);
    const plan = {orders: [{id: ref, type: "SO"}], trucks: [{id: "fixture", loads: [{id: "fixture", orders: [ref], stops: [{id: "stop", orderId: ref, type: "drop"}]}]}]};
    return run({id, ref, plan});
  }, {rollback: true});
}

test("billing and unbilling do not change Dispatch order availability", async () => fixture(async ({id, ref}) => {
  const billed = await listDispatchOrders({type: "SO", exactOrderRefs: [ref], unboundedPerType: true});
  assert.ok(billed.some(order => order.id === ref), "Billed delivery must stay available");
  await query("UPDATE sales_orders SET status='B',status_text='Sales Order : Pending Fulfillment' WHERE netsuite_id=$1", [id]);
  const unbilled = await listDispatchOrders({type: "SO", exactOrderRefs: [ref], unboundedPerType: true});
  assert.ok(unbilled.some(order => order.id === ref));
  await query("UPDATE sales_orders SET status='H',status_text='Sales Order : Closed' WHERE netsuite_id=$1", [id]);
  assert.equal((await listDispatchOrders({type: "SO", exactOrderRefs: [ref], unboundedPerType: true})).some(order => order.id === ref), false);
}));

test("the Dispatch response retains billed orders with their independent hold restriction", async () => fixture(async ({id, ref}) => {
  const read = () => loadDispatchOrdersForResponse({type: "SO", exactOrderRefs: [ref]});
  await query("UPDATE sales_orders SET operator_status='hold',status='B',status_text='Sales Order : Pending Fulfillment' WHERE netsuite_id=$1", [id]);
  const unbilled = (await read()).find(order => order.id === ref);
  assert.ok(unbilled, "An unbilled held order remains visible for Dispatch review");
  assert.equal(unbilled.dispatchPlanningRestricted, true, "The hold still prevents planning");
  await query("UPDATE sales_orders SET status='G',status_text='Sales Order : Billed' WHERE netsuite_id=$1", [id]);
  const billed = (await read()).find(order => order.id === ref);
  assert.ok(billed, "Billing must not hide the same held order from the complete Dispatch response");
  assert.equal(billed.dispatchPlanningRestricted, true, "Ignoring billing must not bypass the hold");
  for (const [status, label] of [["H", "Sales Order : Closed"], ["", "Sales Order : Cancelled"]]) {
    await query("UPDATE sales_orders SET status=$2,status_text=$3 WHERE netsuite_id=$1", [id, status, label]);
    assert.equal((await read()).some(order => order.id === ref), false, `${label} remains excluded`);
  }
}));

test("billing does not hide a saved delivery group and cancelled plans cannot restore it", async () => fixture(async ({id, ref, plan}) => {
  await query("UPDATE sales_orders SET operator_status='hold',status='B',status_text='Pending Fulfillment' WHERE netsuite_id=$1", [id]);
  const groupRef = `GROUP-${ref}`;
  plan.orders = [{id: groupRef, type: "SO", childOrders: [ref], childOrderDetails: plan.orders}];
  const saved = await persistFixture(plan);
  const readGroup = async () => (await loadDispatchOrdersForResponse({type: "SO", search: ref})).find(order => order.id === groupRef);
  const unbilled = await readGroup();
  assert.ok(unbilled, "A saved group must enter the response through the snapshot-derived path");
  assert.equal(unbilled.dispatchSnapshotSourcePlanId, String(saved.id));
  assert.equal(unbilled.dispatchPlanningRestricted, true, "The child's hold still restricts its group");
  await query("UPDATE sales_orders SET status='G',status_text='Sales Order : Billed' WHERE netsuite_id=$1", [id]);
  const billed = await readGroup();
  assert.ok(billed, "Billing a child must not hide its saved delivery group");
  assert.deepEqual(billed.childOrders, [ref]);
  assert.equal(billed.dispatchPlanningRestricted, true, "Ignoring billing must preserve the child's hold");
  await query("UPDATE dispatch_plans SET status='cancelled' WHERE id=$1", [saved.id]);
  assert.equal(await readGroup(), undefined, "A cancelled plan must not restore its saved group into the response");
}));

test("billing never removes planned stops, including previously queued maintenance", async () => fixture(async ({id, ref, plan}) => {
  await query("UPDATE sales_orders SET operator_status='hold' WHERE netsuite_id=$1", [id]);
  assert.deepEqual(await scrubBilledSalesOrderFamiliesFromPlan(plan), plan);
  const result = await applyDispatchSalesFamilyMaintenance(plan, {kind: "sales_family", canonicalRef: ref, refs: [ref]});
  assert.equal(result.plan.orders.length, 1);
  assert.deepEqual(result.plan.trucks, plan.trucks);
}));

test("queued closed-order maintenance still removes closed stops", async () => fixture(async ({id, ref, plan}) => {
  await query("UPDATE sales_orders SET status='H',status_text='Sales Order : Closed' WHERE netsuite_id=$1", [id]);
  const result = await applyDispatchSalesFamilyMaintenance(plan, {kind: "sales_family", canonicalRef: ref, refs: [ref]});
  assert.equal(result.plan.orders.length, 0);
}));

async function persistFixture(plan) {
  const saved = await createDispatchPlan({planDate: "2033-10-16"});
  await query("UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb WHERE plan_id=$1",
    [saved.id, JSON.stringify(plan.orders), JSON.stringify(plan.trucks)]);
  return saved;
}

test("legacy billing cleanup callers neither modify a saved plan nor queue billing work", async () => fixture(async ({ref, plan}) => {
  const saved = await persistFixture(plan);
  assert.deepEqual(await cleanupBilledSalesOrderFamiliesFromDispatchPlan({planId: saved.id, queueOnly: true}),
    {changedPlans: [], deferredFamilies: [], familyCount: 0});
  assert.deepEqual(await cleanupBilledSalesOrderFamilyFromDispatchPlans({canonicalRef: ref, familyRefs: [ref]}),
    {changedPlans: [], deferred: false, familyRefs: [ref]});
  const result = await reconcileSalesOrderFamilyInDispatchPlans({canonicalRef: ref, familyRefs: [ref], billed: true});
  assert.equal(result.changedPlans.length, 0);
  assert.equal(result.deferred, false);
  assert.equal((await query("SELECT revision::int AS revision FROM dispatch_plans WHERE id=$1", [saved.id])).rows[0].revision, saved.revision);
  assert.equal((await query("SELECT 1 FROM dispatch_plan_maintenance WHERE plan_id=$1", [saved.id])).rowCount, 0);
  assert.ok((await getDispatchPlan(saved.id)).orders.some(order => order.id === ref));
}));

test("closed-family reconciliation archives the old plan before removing an unexecuted stop", async () => fixture(async ({id, ref, plan}) => {
  const saved = await persistFixture(plan);
  await query("UPDATE sales_orders SET status='H',status_text='Sales Order : Closed' WHERE netsuite_id=$1", [id]);
  const result = await reconcileSalesOrderFamilyInDispatchPlans({canonicalRef: ref, familyRefs: [ref], closed: true});
  assert.equal(result.changedPlans.length, 1);
  const current = (await query("SELECT orders,trucks FROM dispatch_plan_snapshots WHERE plan_id=$1", [saved.id])).rows[0];
  assert.equal(current.orders.length, 0);
  const history = (await query("SELECT orders,archive_reason FROM dispatch_plan_snapshot_history WHERE plan_id=$1", [saved.id])).rows;
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].orders, plan.orders);
  assert.equal(history[0].archive_reason, "before_closed_so_reconciliation");
}));

test("reading a grouped plan retains billed child deliveries", async () => fixture(async ({ref, plan}) => {
  plan.orders = [{id: "GROUP-BILL-TEST", type: "SO", childOrders: [ref], childOrderDetails: plan.orders}];
  const saved = await persistFixture(plan);
  const read = await getDispatchPlan(saved.id);
  assert.ok(read.orders.some(order => order.id === ref || order.childOrders?.includes(ref)), "Group refresh must retain the billed delivery");
}));

test("closed-order cleanup waits for the current editor before changing the saved plan", async () => fixture(async ({id, ref, plan}) => {
  const saved = await persistFixture(plan);
  await query("UPDATE sales_orders SET status='H',status_text='Sales Order : Closed' WHERE netsuite_id=$1", [id]);
  const operator = await createOperator({username: `reconnect-${randomUUID()}`, displayName: "Fixture dispatcher", password: randomUUID(), role: "dispatcher"});
  await acquireDispatchPlanEditLease({planDate: saved.planDate, operatorId: operator.id, sessionId: randomUUID()});
  const result = await reconcileSalesOrderFamilyInDispatchPlans({canonicalRef: ref, familyRefs: [ref], closed: true});
  assert.equal(result.deferred, true);
  assert.equal(result.deferredPlans[0].reason, "editing");
  assert.equal(result.changedPlans.length, 0);
  assert.deepEqual((await query("SELECT orders FROM dispatch_plan_snapshots WHERE plan_id=$1", [saved.id])).rows[0].orders, plan.orders);
  await query("DELETE FROM dispatch_plan_edit_leases WHERE plan_date=$1", [saved.planDate]);
  assert.equal((await processDispatchPlanMaintenance(saved.id)).changed, true);
  assert.equal((await query("SELECT orders FROM dispatch_plan_snapshots WHERE plan_id=$1", [saved.id])).rows[0].orders.length, 0);
}));

test("nonbilling group review refresh preserves deliveries and archives the previous metadata", async () => fixture(async ({id, ref, plan}) => {
  await query("UPDATE sales_orders SET status='B',status_text='Pending Fulfillment' WHERE netsuite_id=$1", [id]);
  plan.orders = [{id: "GROUP-REVIEW-TEST", type: "SO", childOrders: [ref], childOrderDetails: plan.orders}];
  const saved = await persistFixture(plan);
  const result = await reconcileSalesOrderFamilyInDispatchPlans({canonicalRef: ref, familyRefs: [ref], reconciliationStatus: "review", reconciliationReason: "Quantity changed"});
  assert.equal(result.changedPlans.length, 1);
  const current = (await query("SELECT orders FROM dispatch_plan_snapshots WHERE plan_id=$1", [saved.id])).rows[0].orders;
  assert.deepEqual(current[0].childOrders, [ref]);
  assert.equal(current[0].reconciliationBlocked, true);
  const archived = (await query("SELECT orders,archive_reason FROM dispatch_plan_snapshot_history WHERE plan_id=$1", [saved.id])).rows;
  assert.equal(archived.length, 1);
  assert.equal(archived[0].archive_reason, "before_grouped_so_reconciliation");
  assert.deepEqual(archived[0].orders, plan.orders);
}));

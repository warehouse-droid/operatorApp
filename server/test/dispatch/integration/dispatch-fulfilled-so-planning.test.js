import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeDb, query } from "../../../src/db.js";
import { loadDispatchOrdersForResponse } from "../../../src/server.js";
import { createDispatchPlan, getDispatchPlan, saveDispatchPlanSnapshot, reconcileSalesOrderFamilyInDispatchPlans } from "../../../src/dispatch-plan-repository.js";
import { assertNoDriverPwaCompletedDispatchRefs } from "../../../src/dispatch-history-mode.js";
import { listFulfilledSalesDeliveryStates, assertSalesDeliveryPlanningAllowed } from "../../../src/dispatch-fulfilled-so-repository.js";
import { getDispatchOrderCatalogOrder, upsertDispatchOrderCatalog } from "../../../src/dispatch-order-catalog-repository.js";
import { scenario, seedSalesOrder, completeDriver, splitSalesOrder } from "../support/fulfilled-so-fixture.js";

after(closeDb);
const search = (ref) => loadDispatchOrdersForResponse({ type: "SO", search: ref, includeCompletedScmSearch: true });

for (const [index, status] of ["F", "G"].entries()) {
  test(`${status}: NetSuite fulfilled Delivery is completed and planable in explicit search without changing cargo or history`, () => scenario(async () => {
    const ref = `SO-FULFILLED-${status}`;
    await seedSalesOrder(817150001 + index, ref, { status });
    const before = (await query("SELECT row_to_json(s) AS value FROM sales_orders s WHERE tranid=$1", [ref])).rows;
    const eventsBefore = (await query("SELECT * FROM dispatch_order_completion_events WHERE order_ref=$1", [ref])).rows;
    const order = (await search(ref)).find(row => row.id === ref);
    assert.ok(order, "Explicit search includes the fulfilled SO");
    assert.equal(order.dispatchFulfilledSalesPlanningEligible, true);
    assert.equal(order.dispatchCompletionStatus, "completed");
    assert.equal(order.scm.status, "Completed");
    assert.equal(order.dispatchPlanningRestricted, false);
    assert.equal(order.items[0].quantity, 4);
    assert.deepEqual((await query("SELECT row_to_json(s) AS value FROM sales_orders s WHERE tranid=$1", [ref])).rows, before);
    assert.deepEqual((await query("SELECT * FROM dispatch_order_completion_events WHERE order_ref=$1", [ref])).rows, eventsBefore);
  }));
}

test("billed delivery survives plan save, read and billed reconciliation", () => scenario(async () => {
  const ref = "SO-FULFILLED-PERSIST";
  await seedSalesOrder(817150003, ref, { status: "G" });
  await query("INSERT INTO dispatch_trucks (id,plate,active) VALUES (817159901,'FULFILLED',true)");
  const plan = await createDispatchPlan({ planDate: "2096-09-15" });
  const orders = [{ id: ref, type: "SO", sourceTable: "sales_orders", items: [{ itemId: 817159900, quantity: 4 }] }];
  const trucks = [{ id: "817159901", plate: "FULFILLED", loads: [{ id: "L-FULFILLED", orders: [ref], stops: [
    { id: "P-FULFILLED", type: "pickup", orderId: ref, yard: "3445" },
    { id: "D-FULFILLED", type: "drop", orderId: ref }
  ] }] }];
  const saved = await saveDispatchPlanSnapshot(plan.id, { orders, trucks, baseRevision: plan.revision });
  assert.ok(saved.orders.some(row => row.id === ref), "Save retains billed Delivery");
  assert.ok((await getDispatchPlan(plan.id)).orders.some(row => row.id === ref));
  await reconcileSalesOrderFamilyInDispatchPlans({ canonicalRef: ref, familyRefs: [ref], billed: true });
  assert.ok((await getDispatchPlan(plan.id)).orders.some(row => row.id === ref), "Reconciliation preserves physical delivery pending");
  assert.ok((await getDispatchPlan(plan.id)).trucks[0].loads[0].stops.some(stop => stop.orderId === ref));
}));

test("driver delivery blocks fulfilled SO; pickup completion alone keeps planning available", () => scenario(async () => {
  for (const [index, stopType] of ["pickup", "dropoff"].entries()) {
    const ref = `SO-FULFILLED-${stopType}`;
    await seedSalesOrder(817150004 + index, ref);
    await completeDriver(ref, { stopType });
    const order = (await search(ref)).find(row => row.id === ref);
    assert.ok(order, "Explicit search retains completed order for review");
    assert.equal(order.dispatchFulfilledSalesPlanningEligible, stopType === "pickup");
    assert.equal(order.dispatchPlanningRestricted, stopType === "dropoff");
    if (stopType === "dropoff") await assert.rejects(assertNoDriverPwaCompletedDispatchRefs([ref]), { code: "DISPATCH_ORDER_DRIVER_COMPLETED" });
    else await assertNoDriverPwaCompletedDispatchRefs([ref]);
  }
}));

test("active split inherits source fulfillment without inheriting sibling driver completion", () => scenario(async () => {
  const parent = "SO-FULFILLED-SPLITS";
  await seedSalesOrder(817150006, parent, { status: "G" });
  for (let index = 1; index <= 3; index++) {
    const ref = `${parent}-S${index}`;
    const active = index !== 3;
    await seedSalesOrder(-817150006 - index, ref, { status: "B", active });
    await splitSalesOrder(817150006, parent, -817150006 - index, ref, active ? "active" : "cancelled");
  }
  await completeDriver(`${parent}-S1`);
  const orders = await search(parent);
  assert.equal(orders.find(row => row.id === `${parent}-S1`)?.dispatchPlanningRestricted, true);
  assert.equal(orders.find(row => row.id === `${parent}-S2`)?.dispatchFulfilledSalesPlanningEligible, true);
  assert.equal(orders.some(row => row.id === `${parent}-S3` && row.dispatchFulfilledSalesPlanningEligible), false);
}));

test("target hydration includes inactive fulfilled cargo while the default pool omits historical billed SOs", () => scenario(async () => {
  const ref = "SO-FULFILLED-INACTIVE";
  await seedSalesOrder(817150020, ref, { status: "G", active: false });
  const defaultOrders = await loadDispatchOrdersForResponse({ type: "SO" });
  assert.equal(defaultOrders.some(order => order.id === ref), false);
  const targeted = await loadDispatchOrdersForResponse({ type: "SO", exactOrderRefs: [ref.toLowerCase()] });
  const order = targeted.find(order => order.id === ref);
  assert.ok(order);
  assert.equal(order.dispatchFulfilledSalesPlanningEligible, true);
  assert.equal(order.items[0].quantity, 4);
}));

test("unfinished and Pick-Up orders never gain the fulfilled delivery allowance", () => scenario(async () => {
  for (const [index, options] of [{ status: "B" }, { status: "E" }, { status: "G", method: "Pick-Up" }].entries()) {
    const ref = `SO-FULFILLED-CONTROL-${index}`;
    await seedSalesOrder(817150030 + index, ref, options);
    const states = await listFulfilledSalesDeliveryStates([ref]);
    assert.equal(states.get(ref.toLowerCase()).eligible, false);
    const order = (await search(ref)).find(row => row.id === ref);
    if (options.method === "Pick-Up") assert.equal(order, undefined);
    else {
      assert.ok(order);
      assert.equal(order.dispatchCompletionStatus === "completed", false);
      assert.equal(order.dispatchPlanningRestricted, false);
    }
  }
}));

test("authoritative restrictions deny fulfilled Hold, cancelled, missing, review and ambiguous identities", () => scenario(async () => {
  const cases = ["Hold", "Cancelled", "missing", "review", "duplicate", "reload", "manual"];
  for (const [index, kind] of cases.entries()) {
    const ref = `SO-FULFILLED-RESTRICT-${kind}`;
    const id = 817150040 + index;
    await seedSalesOrder(id, ref, { yard: ["Hold", "Cancelled"].includes(kind) ? kind : "Open" });
    if (kind === "missing") await query("UPDATE sales_orders SET netsuite_missing_at=now() WHERE netsuite_id=$1", [id]);
    if (kind === "duplicate") await seedSalesOrder(id + 100, ref);
    if (kind === "review") await query(`INSERT INTO scm_reconciliation_order_state
      (order_kind,source_order_netsuite_id,source_order_ref,reconciliation_status,application_status)
      VALUES ('SO',$1,$2,'review','Reconcile Review')`, [id, ref]);
    if (kind === "reload") await query(`INSERT INTO operator_reload_cycles (sales_order_id,order_ref,cycle_number,request_id,reason)
      VALUES ($1,$2,1,'20260915-0000-4000-8000-000000000001','Test reload')`, [id, ref]);
    if (kind === "manual") await query(`INSERT INTO dispatch_order_completion_events
      (order_kind,order_ref,dispatch_completed_at,completion_evidence_type,completion_evidence_id,actor_type,actor_id,reason)
      VALUES ('SO',$1,now(),'manual_dispatch',$1,'operator','test','Recovered delivery')`, [ref]);
    const states = await listFulfilledSalesDeliveryStates([ref]);
    assert.equal(states.get(ref.toLowerCase()).eligible, false, kind);
    await assert.rejects(assertSalesDeliveryPlanningAllowed([ref]), { code: "DISPATCH_SALES_DELIVERY_RESTRICTED" });
  }
}));

test("catalog hydration refreshes the allowance after a Driver delivery", () => scenario(async () => {
  const ref = "SO-FULFILLED-CATALOG";
  await seedSalesOrder(817150060, ref);
  const order = (await search(ref)).find(row => row.id === ref);
  await upsertDispatchOrderCatalog({ orders: [order], source: "fulfilled-so-test" });
  assert.equal((await getDispatchOrderCatalogOrder(ref)).dispatchFulfilledSalesPlanningEligible, true);
  await completeDriver(ref);
  const delivered = await getDispatchOrderCatalogOrder(ref);
  assert.equal(delivered.dispatchFulfilledSalesPlanningEligible, false);
  assert.equal(delivered.dispatchPlanningRestricted, true);
}));

test("the snapshot transaction rechecks local delivery rather than trusting an earlier admission check", () => scenario(async () => {
  const ref = "SO-FULFILLED-TRANSACTION";
  await seedSalesOrder(817150061, ref);
  const order = (await search(ref)).find(row => row.id === ref);
  await completeDriver(ref);
  const plan = await createDispatchPlan({ planDate: "2096-09-16" });
  await query("INSERT INTO dispatch_trucks (id,plate,active) VALUES (817159902,'FULFILLED-TX',true)");
  const trucks = [{ id: "817159902", plate: "FULFILLED-TX", loads: [{ id: "FULFILLED-TX-LOAD", orders: [ref],
    stops: [{ id: "FULFILLED-TX-DROP", type: "drop", orderId: ref }] }] }];
  await assert.rejects(saveDispatchPlanSnapshot(plan.id, { orders: [order], trucks, baseRevision: plan.revision }),
    { code: "DISPATCH_ORDER_DRIVER_COMPLETED" });
  assert.deepEqual((await getDispatchPlan(plan.id)).orders, []);
}));

test("saved SO group retains completion and pending delivery permission for all its fulfilled members", () => scenario(async () => {
  const refs = ["SO-FULFILLED-GROUP-A", "SO-FULFILLED-GROUP-B"];
  for (const [index, ref] of refs.entries()) await seedSalesOrder(817150070 + index, ref);
  const children = (await search("SO-FULFILLED-GROUP-")).filter(order => refs.includes(order.id));
  assert.equal(children.length, 2);
  const group = { id: "GOB-FULFILLED-GROUP", type: "SO", childOrders: refs, childOrderDetails: children,
    items: children.flatMap(order => order.items) };
  const plan = await createDispatchPlan({ planDate: "2096-09-17" });
  await saveDispatchPlanSnapshot(plan.id, { orders: [group], trucks: [], baseRevision: plan.revision });
  const retained = (await getDispatchPlan(plan.id)).orders.find(order => order.id === group.id);
  assert.equal(retained.dispatchFulfilledSalesPlanningEligible, true);
  assert.equal(retained.dispatchCompletionStatus, "completed");
  assert.deepEqual(retained.childOrders, refs);
}));

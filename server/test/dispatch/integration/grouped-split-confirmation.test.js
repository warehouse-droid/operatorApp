import assert from "node:assert/strict";
import test, { after } from "node:test";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { applyConfirmedDispatchPlanToDelivery } from "../../../src/delivery-repository.js";
import { syncDispatchDeliveryGroupsFromPlan } from "../../../src/dispatch-delivery-group-repository.js";
import { seedSplitAddress } from "../support/split-address-fixture.js";

after(closeDb);
async function isolated(run) {
  const rollback = await beginRollbackContext();
  try { await rollback.run(run); } finally { await rollback.rollback(); }
}

// Group after split: both sibling splits travel inside one plan-owned group.
function groupedPlan(plan, splits) {
  const group = { ...structuredClone(splits[0]), id: `GSO-${splits.map(split => split.id).join("-")}`,
    originalOrderId: "", isSplit: false, planOwned: true, childOrders: splits.map(split => split.id),
    childOrderDetails: structuredClone(splits), items: splits.flatMap(split => structuredClone(split.items)) };
  return { ...plan, orders: [group], trucks: [{ ...plan.trucks[0], loads: [{ ...plan.trucks[0].loads[0],
    stops: [{ id: `drop-${group.id}`, type: "drop", orderId: group.id, location: "2967" }] }] }] };
}

const splitRows = splits => query(`SELECT tranid, netsuite_active FROM sales_orders WHERE tranid = ANY($1::text[])
  ORDER BY tranid`, [splits.map(split => split.id)]).then(result => result.rows);

test("grouping already confirmed splits keeps their materialized orders active", () => isolated(async () => {
  const { plan, splits } = await seedSplitAddress({ planDate: "2096-11-14" });
  await applyConfirmedDispatchPlanToDelivery(plan);
  assert.deepEqual((await splitRows(splits)).map(row => row.netsuite_active), [true, true]);
  const grouped = groupedPlan(plan, splits);
  await syncDispatchDeliveryGroupsFromPlan(grouped);
  await applyConfirmedDispatchPlanToDelivery(grouped);
  assert.deepEqual(await splitRows(splits), splits.map(split => ({ tranid: split.id, netsuite_active: true })));
}));

test("confirming a group of never-confirmed splits materializes each split for Operator", () => isolated(async () => {
  const { plan, splits } = await seedSplitAddress({ planDate: "2096-11-15" });
  const grouped = groupedPlan(plan, splits);
  await syncDispatchDeliveryGroupsFromPlan(grouped);
  await applyConfirmedDispatchPlanToDelivery(grouped);
  assert.deepEqual(await splitRows(splits), splits.map(split => ({ tranid: split.id, netsuite_active: true })));
}));

test("a split omitted from the confirmed plan is still retired", () => isolated(async () => {
  const { plan, splits } = await seedSplitAddress({ planDate: "2096-11-16" });
  await applyConfirmedDispatchPlanToDelivery(plan);
  await applyConfirmedDispatchPlanToDelivery({ ...plan, orders: [splits[0]], trucks: [{ ...plan.trucks[0],
    loads: [{ ...plan.trucks[0].loads[0], stops: [plan.trucks[0].loads[0].stops[0]] }] }] });
  assert.deepEqual((await splitRows(splits)).map(row => row.netsuite_active), [true, false]);
}));

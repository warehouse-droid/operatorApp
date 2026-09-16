import assert from "node:assert/strict";
import test, { after } from "node:test";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { updateDispatchOrderDetails } from "../../../src/dispatch-repository.js";
import { applyConfirmedDispatchPlanToDelivery } from "../../../src/delivery-repository.js";
import { getDispatchOrderCatalogOrder, listDispatchOrderPool, upsertDispatchOrderCatalog } from "../../../src/dispatch-order-catalog-repository.js";
import { deactivateDispatchGlobalOrderDefinitions, reconcileDispatchPlanGlobalOrderDefinitions, syncDispatchDeliveryGroupsFromPlan } from "../../../src/dispatch-delivery-group-repository.js";
import { seedSplitAddress, mossbrook, heatherside, changedParentAddress } from "../support/split-address-fixture.js";

after(closeDb);
async function isolated(run) {
  const rollback = await beginRollbackContext();
  try { await rollback.run(run); } finally { await rollback.rollback(); }
}
function assertAddress(order, address) {
  for (const key of ["address", "destinationAddress", "defaultDestinationAddress"]) {assert.equal(order[key], address, key);}
}
const edit = address => ({ type: "SO", sourceTable: "sales_orders", address, pickupAddress: "Pickup override",
  expectedDeliveryDate: "2096-11-13", windowStart: "08:00", windowEnd: "10:00" });

test("saved split details survive catalog refresh, stale plan reconciliation, and repeated materialization", () => isolated(async () => {
  const { parent, parentRef, plan, splits } = await seedSplitAddress();
  await applyConfirmedDispatchPlanToDelivery(plan);
  const ack = await updateDispatchOrderDetails(splits[1].id, edit(heatherside));
  assert.equal(ack.dispatch_address, heatherside);
  assertAddress(await getDispatchOrderCatalogOrder(splits[1].id), heatherside);
  await upsertDispatchOrderCatalog({ orders: [{ ...parent, address: changedParentAddress,
    destinationAddress: changedParentAddress, defaultDestinationAddress: changedParentAddress,
    pickupLocations: ["12441"], sourceYard: "12441", raw: {},
    netsuiteStatusText: "Partially Fulfilled" }], source: "split-address-test-refresh" });
  const refreshed = await getDispatchOrderCatalogOrder(splits[1].id);
  assertAddress(refreshed, heatherside);
  assert.equal(refreshed.sourceYard, "12441");
  assert.equal(refreshed.netsuiteStatusText, "Partially Fulfilled");
  assert.equal(refreshed.pieces, 5);
  assert.equal(refreshed.pickupAddressOverride, "Pickup override");
  assert.equal(refreshed.expectedDeliveryDate, "2096-11-13");
  assert.equal(refreshed.windowStart, "08:00");
  assert.equal(refreshed.windowEnd, "10:00");
  assertAddress(await getDispatchOrderCatalogOrder(splits[0].id), changedParentAddress);
  const reconciled = await reconcileDispatchPlanGlobalOrderDefinitions(plan);
  assertAddress(reconciled.orders[1], heatherside);
  assert.deepEqual(reconciled.trucks, plan.trucks);
  await syncDispatchDeliveryGroupsFromPlan(reconciled);
  await applyConfirmedDispatchPlanToDelivery(plan); // Deliberately stale caller.
  const materialized = (await query("SELECT tranid,dispatch_address,dispatch_pickup_address,dispatch_window_start FROM sales_orders WHERE tranid=ANY($1::text[])", [[parentRef, ...splits.map(order => order.id)]])).rows;
  assert.equal(materialized.find(order => order.tranid === splits[1].id).dispatch_address, heatherside);
  assert.equal(materialized.find(order => order.tranid === splits[1].id).dispatch_pickup_address, "Pickup override");
  assert.equal(materialized.find(order => order.tranid === splits[1].id).dispatch_window_start, "08:00");
  assert.equal(materialized.find(order => order.tranid === parentRef).dispatch_address, mossbrook);
  const pool = await listDispatchOrderPool({ type: "SO", search: splits[1].id, limit: 10 });
  assert.equal(pool.orders.find(order => order.id === splits[1].id).address, heatherside);
}));

test("an existing explicit override survives source refresh before materialization", () => isolated(async () => {
  const { parent, splits } = await seedSplitAddress({ override: true });
  await upsertDispatchOrderCatalog({ orders: [parent], source: "repeat-parent" });
  assertAddress(await getDispatchOrderCatalogOrder(splits[1].id), heatherside);
}));

test("confirmation materializes a split at its explicit address", () => isolated(async () => {
  const { plan, splits } = await seedSplitAddress({ override: true });
  await applyConfirmedDispatchPlanToDelivery(plan);
  assert.equal((await query("SELECT dispatch_address FROM sales_orders WHERE tranid=$1", [splits[1].id])).rows[0].dispatch_address, heatherside);
}));

test("unmaterialized splits can save, replace, clear, and pin the parent address", () => isolated(async () => {
  const { parent, splits } = await seedSplitAddress();
  for (const address of [heatherside, "", mossbrook]) {
    const ack = await updateDispatchOrderDetails(splits[1].id, edit(address));
    assert.equal(ack.dispatch_address, address);
    await upsertDispatchOrderCatalog({ orders: [{ ...parent, address: changedParentAddress,
      destinationAddress: changedParentAddress, defaultDestinationAddress: changedParentAddress }], source: "edited-again" });
    assertAddress(await getDispatchOrderCatalogOrder(splits[1].id), address);
  }
}));

test("invalid dates roll back both definitions and materialized records", () => isolated(async () => {
  const { plan, splits } = await seedSplitAddress();
  await applyConfirmedDispatchPlanToDelivery(plan);
  await assert.rejects(updateDispatchOrderDetails(splits[1].id, { ...edit(heatherside), expectedDeliveryDate: "not-a-date" }));
  assertAddress(await getDispatchOrderCatalogOrder(splits[1].id), mossbrook);
  assert.equal((await query("SELECT dispatch_address FROM sales_orders WHERE tranid=$1", [splits[1].id])).rows[0].dispatch_address, mossbrook);
}));

test("retired split edits cannot change the materialized row or reactivate its definition", () => isolated(async () => {
  const { plan, splits } = await seedSplitAddress();
  await applyConfirmedDispatchPlanToDelivery(plan);
  await deactivateDispatchGlobalOrderDefinitions([splits[1].id]);
  await assert.rejects(updateDispatchOrderDetails(splits[1].id, edit(heatherside)), { code: "DISPATCH_DERIVED_ORDER_RETIRED" });
  assert.equal(await getDispatchOrderCatalogOrder(splits[1].id), null);
  assert.equal((await query("SELECT dispatch_address FROM sales_orders WHERE tranid=$1", [splits[1].id])).rows[0].dispatch_address, mossbrook);
}));

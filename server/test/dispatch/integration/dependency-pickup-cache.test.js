import assert from "node:assert/strict";
import test, { after } from "node:test";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { enrichDispatchOrdersWithDependencies } from "../../../src/order-dependency-repository.js";
import { getDispatchOrderCatalogOrder, listDispatchOrderPool, upsertDispatchOrderCatalog } from "../../../src/dispatch-order-catalog-repository.js";
import { getDispatchV2Bootstrap } from "../../../src/dispatch-planner-v2-repository.js";
import { cacheFixture, groupRef, splitRef } from "../../support/dependency-pickup-cache-fixture.mjs";
after(closeDb);

test("compact pool cards cannot reintroduce a cancelled pickup on a later search refresh", () => isolated(async () => {
  const { stale } = cacheFixture();
  stale.raw = { largeSourceDetail: "not-for-the-card".repeat(1000) };
  await upsertDispatchOrderCatalog({ orders: [stale], source: "synthetic-dependency-cache" });
  const result = await listDispatchOrderPool({ search: groupRef, limit: 1 });
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].id, groupRef);
  assert.deepEqual(result.orders[0].pickupLocations, ["3445"]);
  assert.equal(Boolean(result.orders[0].dependencyDirectPickup), false);
  assert.equal(result.orders[0].catalogHydrated, false);
  assert.equal(result.orders[0].childOrderDetails, undefined);
  assert.doesNotMatch(JSON.stringify(result), /not-for-the-card/);
}));

async function isolated(run) {
  const context = await beginRollbackContext();
  try { await context.run(run); } finally { await context.rollback(); }
}

test("cancelled nested transfer projections cannot survive feed refresh; PO and native cargo survive", () => isolated(async () => {
  const { stale } = cacheFixture();
  stale.poPickupManifest = [{ allocationId: 500, location: "150", items: [{ quantity: 2 }] }];
  stale.pickupLocations.push("150");
  stale.items[0].poAllocatedSalesQty = 2;
  const original = structuredClone(stale);
  const [fresh] = await enrichDispatchOrdersWithDependencies([stale]);
  assert.deepEqual(fresh.orderDependencies || [], []);
  assert.deepEqual(fresh.directPickupManifest || [], []);
  assert.deepEqual(fresh.childOrderDetails[0].orderDependencies || [], []);
  assert.deepEqual(fresh.childOrderDetails[0].directPickupManifest || [], []);
  assert.deepEqual(fresh.pickupLocations, ["3445", "150"]);
  assert.deepEqual(fresh.childOrderDetails[0].pickupLocations, ["3445"]);
  assert.deepEqual(fresh.poPickupManifest, stale.poPickupManifest);
  assert.deepEqual(fresh.items, stale.items);
  assert.deepEqual(stale, original);
  assert.deepEqual(await enrichDispatchOrdersWithDependencies([fresh]), [fresh]);
}));

test("plan bootstrap rebuilds a stored group's cancelled transfer pickup before the browser plans with it", () => isolated(async () => {
  const { before } = cacheFixture();
  const planId = (await query("INSERT INTO dispatch_plans(plan_date,status,revision) VALUES($1,'draft',1) RETURNING id",
    [before.planDate])).rows[0].id;
  await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2::jsonb,$3::jsonb,'{}')",
    [planId, JSON.stringify(before.orders), JSON.stringify(before.trucks)]);
  const { plan } = await getDispatchV2Bootstrap({ planId: String(planId) });
  const group = plan.assignedOrderSnapshots.find((order) => order.id === groupRef);
  assert.deepEqual(group.pickupLocations, ["3445"]);
  assert.deepEqual(group.orderDependencies || [], []);
  assert.deepEqual(group.directPickupManifest || [], []);
  assert.deepEqual(group.childOrderDetails[0].orderDependencies || [], []);
  assert.deepEqual(group.childOrderDetails[0].pickupLocations, ["3445"]);
  assert.equal((await query("SELECT orders->0->'orderDependencies'->0->>'status' AS status FROM dispatch_plan_snapshots WHERE plan_id=$1",
    [planId])).rows[0].status, "active");
}));

test("group catalogue hydration clears old split dependencies without rewriting stored structure", () => isolated(async () => {
  const { stale } = cacheFixture();
  await query(`INSERT INTO dispatch_global_order_groups(group_ref,order_type,source_plan_date,full_order,card,active)
    VALUES($1,'SO','2099-10-30',$2,$2,true)`, [groupRef, JSON.stringify(stale)]);
  const fresh = await getDispatchOrderCatalogOrder(groupRef);
  assert.deepEqual(fresh.orderDependencies || [], []);
  assert.deepEqual(fresh.childOrderDetails[0].orderDependencies || [], []);
  assert.deepEqual(fresh.pickupLocations, ["3445"]);
  assert.equal(fresh.childOrderDetails[0].originalOrderId, "SOA10878");
  assert.equal((await query("SELECT full_order->'childOrders' AS refs FROM dispatch_global_order_groups WHERE group_ref=$1", [groupRef])).rows[0].refs[0], splitRef);
}));

test("a current split dependency replaces stale nested data and survives repeated projection", () => isolated(async () => {
  const { stale } = cacheFixture();
  await query("INSERT INTO sales_orders(netsuite_id,tranid,status,netsuite_active) VALUES(8500101,'SOA10878','B',true)");
  const line = (await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,quantity,unit,netsuite_active)
    VALUES(8500101,1,8500100,'Synthetic',5,'EA',true) RETURNING id`)).rows[0].id;
  await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,from_location,to_location,netsuite_active)
    VALUES(8500102,'TOB01264','B','2967','3445',true)`);
  const id = (await query(`INSERT INTO order_dependencies(sales_order_id,sales_order_ref,transfer_order_id,transfer_order_ref,
    dispatch_target_ref,dispatch_target_kind,dependency_mode,source_location_id,source_location,accounting_destination_location_id,accounting_destination_location)
    VALUES(8500101,'SOA10878',8500102,'TOB01264',$1,'split','direct_to_customer',28,'2967',1,'3445') RETURNING id`, [splitRef])).rows[0].id;
  await query(`INSERT INTO order_dependency_lines(dependency_id,sales_line_id,item_id,item_name,unit,allocated_quantity,piece_qty)
    VALUES($1,$2,8500100,'Synthetic','EA',3,3)`, [id, line]);
  const [fresh] = await enrichDispatchOrdersWithDependencies([stale]);
  assert.deepEqual(fresh.orderDependencies.map(link => String(link.id)), [String(id)]);
  assert.deepEqual(fresh.childOrderDetails[0].orderDependencies.map(link => String(link.id)), [String(id)]);
  assert.deepEqual(fresh.childOrderDetails[0].directPickupManifest.map(link => String(link.dependencyId)), [String(id)]);
  assert.deepEqual(fresh.pickupLocations, ["3445", "2967"]);
  assert.deepEqual(await enrichDispatchOrdersWithDependencies([fresh]), [fresh]);
  await query("UPDATE order_dependencies SET status='cancelled' WHERE id=$1", [id]);
  const [cancelled] = await enrichDispatchOrdersWithDependencies([fresh]);
  assert.deepEqual(cancelled.pickupLocations, ["3445"]);
  assert.deepEqual(cancelled.childOrderDetails[0].orderDependencies || [], []);
}));

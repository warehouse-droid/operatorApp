import assert from "node:assert/strict";
import test, { after } from "node:test";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  enrichDispatchOrdersWithDependencies,
  getSalesOrderDependencyExecutionBlock,
  validateDispatchPlanDependencies
} from "../../../src/order-dependency-repository.js";

after(closeDb);
async function isolated(run) {
  const rollback = await beginRollbackContext();
  try { await rollback.run(run); } finally { await rollback.rollback(); }
}

const parentId = 8_600_000_001;
const parentRef = "SO-DEPSCOPE-1";
const transferRef = "TO-DEPSCOPE-1";
const inStockItem = 8_600_101;
const backorderedItem = 8_600_102;

// A replenishment TO linked to the whole SO before it was split covers only the
// backordered item. S1 carries the in-stock item, S2 the backordered one.
async function seed() {
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,status,status_text,fulfillment_status,
    outbound_location_id,outbound_location,sales_order_type,operator_status,local_yard_order_status,netsuite_active)
    VALUES($1,$2,'Dependency scope','B','Pending Fulfillment','not_fulfilled',1,'3445','Delivery','open','Open',true)`,
  [parentId, parentRef]);
  const line = async (lineId, itemId, quantity) => (await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,
    item_id,item_name,sku,quantity,unit,piece_qty,to_pcs,netsuite_active)
    VALUES($1,$2,$3,'Scope item','SCOPE',$4,'PC',$4,1,true) RETURNING id`, [parentId, lineId, itemId, quantity])).rows[0].id;
  await line(1, inStockItem, 5);
  const backorderedLine = await line(2, backorderedItem, 3);
  await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,from_location,to_location,netsuite_active)
    VALUES(8600201,$1,'B','2967','3445',true)`, [transferRef]);
  const dependencyId = (await query(`INSERT INTO order_dependencies(sales_order_id,sales_order_ref,transfer_order_id,
    transfer_order_ref,dispatch_target_ref,dispatch_target_kind,dependency_mode,source_location_id,source_location,
    accounting_destination_location_id,accounting_destination_location)
    VALUES($1,$2,8600201,$3,$2,'normal','yard_replenishment',28,'2967',1,'3445') RETURNING id`,
  [parentId, parentRef, transferRef])).rows[0].id;
  await query(`INSERT INTO order_dependency_lines(dependency_id,sales_line_id,item_id,item_name,unit,allocated_quantity,piece_qty)
    VALUES($1,$2,$3,'Scope item','PC',3,3)`, [dependencyId, backorderedLine, backorderedItem]);
  const split = (suffix, itemId, quantity) => ({ id: `${parentRef}-S${suffix}`, type: "SO", originalOrderId: parentRef,
    isSplit: true, planOwned: true, sourceYard: "3445", pickupLocations: ["3445"], address: "1 Scope Street",
    items: [{ itemId, sku: "SCOPE", quantity, pieces: quantity }] });
  return { dependencyId, s1: split(1, inStockItem, 5), s2: split(2, backorderedItem, 3) };
}

const planWith = (order) => ({ id: "9999901", planDate: "2097-01-05", orders: [order], trucks: [{ id: "SCOPE-TRUCK",
  plate: "SCOPE", loads: [{ id: "SCOPE-LOAD", name: "Load 1", stops: [
    { id: "pick", type: "pick", orderId: order.id, orderRefs: [order.id], location: "3445" },
    { id: "drop", type: "drop", orderId: order.id, location: order.address }] }] }] });

async function materialize(split, netsuiteId) {
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,status,status_text,fulfillment_status,
    outbound_location_id,outbound_location,sales_order_type,operator_status,local_yard_order_status,netsuite_active)
    VALUES($1,$2,'Dependency scope','B','Pending Fulfillment','not_fulfilled',1,'3445','Delivery','open','Open',true)`,
  [netsuiteId, split.id]);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,quantity,unit,piece_qty,to_pcs,
    netsuite_active) VALUES($1,1,$2,'Scope item','SCOPE',$3,'PC',$3,1,true)`,
  [netsuiteId, split.items[0].itemId, split.items[0].quantity]);
  await query(`INSERT INTO dispatch_scm_so_splits(source_so_id,source_so_ref,split_so_id,split_so_ref)
    VALUES($1,$2,$3,$4)`, [parentId, parentRef, netsuiteId, split.id]);
}

test("only the split carrying the linked item inherits the parent's transfer link", () => isolated(async () => {
  const { dependencyId, s1, s2 } = await seed();
  const [enriched1, enriched2] = await enrichDispatchOrdersWithDependencies([s1, s2]);
  assert.deepEqual(enriched1.orderDependencies || [], []);
  assert.deepEqual((enriched2.orderDependencies || []).map((link) => String(link.id)), [String(dependencyId)]);
}));

test("planning the in-stock split is not blocked by the backordered item's transfer", () => isolated(async () => {
  const { s1, s2 } = await seed();
  assert.deepEqual(await validateDispatchPlanDependencies(planWith(s1)), []);
  const blocked = await validateDispatchPlanDependencies(planWith(s2));
  assert.equal(blocked.length, 1);
  assert.match(blocked[0], new RegExp(`requires ${transferRef}`, "u"));
}));

test("a split whose items have no item identity stays gated", () => isolated(async () => {
  const { s1 } = await seed();
  const unknown = { ...s1, items: [{ sku: "SCOPE", quantity: 5 }] };
  assert.equal((await validateDispatchPlanDependencies(planWith(unknown))).length, 1);
}));

test("driver start waits for the transfer only on the split carrying the linked item", () => isolated(async () => {
  const { s1, s2 } = await seed();
  await materialize(s1, -8_600_301);
  await materialize(s2, -8_600_302);
  assert.equal(await getSalesOrderDependencyExecutionBlock([s1.id]), null);
  assert.equal((await getSalesOrderDependencyExecutionBlock([s2.id]))?.code, "DEPENDENT_TRANSFER_NOT_RECEIVED");
  assert.equal((await getSalesOrderDependencyExecutionBlock([parentRef]))?.code, "DEPENDENT_TRANSFER_NOT_RECEIVED");
}));

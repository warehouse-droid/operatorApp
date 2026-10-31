import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { query, withTransaction, closeDb } from "../../../src/db.js";
import { getSalesOrderPoAllocationOptions, createSalesOrderPoAllocation } from "../../../src/dispatch-repository.js";

after(closeDb);
const isolated = run => withTransaction(run, { rollback: true });

// One SO line of 10 can be reached through the SO itself, a group holding it,
// or its splits. PO links on any of those targets share the same 10.
async function seed() {
  const id = 8_995_100_000 + crypto.randomInt(1_000_000);
  const ref = `SO-XTARGET-${id}`;
  const plan = (await query("INSERT INTO dispatch_plans(plan_date,status) VALUES ('2095-11-02','draft') RETURNING id")).rows[0];
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,customer,sales_order_type,
    outbound_location_id,outbound_location,operator_status,local_yard_order_status,fulfillment_status,netsuite_active)
    VALUES($1,$2,'B','Sales Order : Pending Fulfillment','Cross target test','Delivery',28,'2967',
      'open','Open','not_fulfilled',true)`, [id, ref]);
  const line = (await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,item_description,
    item_type,item_type_text,unit,quantity,netsuite_backordered_qty,netsuite_active)
    VALUES($1,101,2055,'MBBS-Special Order','MBBS-Special Order','Cross slab','NonInvtPart','Non-inventory Item','PC',10,10,true)
    RETURNING *`, [id])).rows[0];
  const item = quantity => ({ lineRowId: line.id, lineId: line.line_id, itemId: 2055, sku: line.sku,
    description: line.item_description, quantity, unit: line.unit });
  const order = { id: ref, type: "SO", items: [item(10)] };
  const groupRef = `GO-XTARGET-${id}`;
  await query(`INSERT INTO dispatch_global_order_groups(group_ref,order_type,source_plan_id,source_plan_date,full_order,card)
    VALUES($1,'SO',$2,'2095-11-02',$3::jsonb,$3::jsonb)`, [groupRef, plan.id,
    JSON.stringify({ id: groupRef, type: "SO", childOrders: [ref], childOrderDetails: [order], items: order.items })]);
  const splits = [[`${ref}-S1`, 6], [`${ref}-S2`, 4]];
  for (const [splitRef, quantity] of splits) {
    const split = { id: splitRef, type: "SO", originalOrderId: ref, items: [item(quantity)] };
    await query(`INSERT INTO dispatch_global_order_splits(split_ref,order_type,parent_order_ref,source_plan_id,
      source_plan_date,full_order,card) VALUES($1,'SO',$2,$3,'2095-11-02',$4::jsonb,$4::jsonb)`,
    [splitRef, ref, plan.id, JSON.stringify(split)]);
  }
  const poId = id + 2;
  const poRef = `PO-XTARGET-${id}`;
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,vendor,dispatch_vendor_yard,
    dispatch_address,destination_location_id,destination_location,netsuite_active)
    VALUES($1,$2,'B','Purchase Order : Pending Receipt','Cross vendor','Cross Vendor Yard','100 Test Road',28,'2967',true)`,
  [poId, poRef]);
  const poLine = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,
    item_description,item_type,item_type_text,quantity,unit,netsuite_active)
    VALUES($1,201,2055,'MBBS-Special Order','MBBS-Special Order','Cross slab','NonInvtPart','Non-inventory Item',50,'PC',true)
    RETURNING id`, [poId])).rows[0];
  return { ref, groupRef, splitRefs: splits.map(([splitRef]) => splitRef), poRef, poLineId: poLine.id };
}

async function link(f, target, salesQty) {
  const options = await getSalesOrderPoAllocationOptions(target);
  const targetLine = options.salesLines[0];
  return createSalesOrderPoAllocation({ dispatchTargetRef: target, salesOrderRef: f.ref, targetLineKey: targetLine.targetLineKey,
    poLineId: f.poLineId, poRef: f.poRef, targetSignature: options.order.targetSignature,
    quantities: { salesQty }, createdBy: "cross-target-regression" });
}

test("a group cannot link again what its member order already linked", () => isolated(async () => {
  const f = await seed();
  await link(f, f.ref, 10);
  await assert.rejects(link(f, f.groupRef, 10), /open sales quantity is only 0/u);
}));

test("the member order cannot link again what its group already linked", () => isolated(async () => {
  const f = await seed();
  await link(f, f.groupRef, 7);
  await assert.rejects(link(f, f.ref, 4), /open sales quantity is only 3/u);
  await link(f, f.ref, 3);
}));

test("split siblings keep their own shares of one sales line", () => isolated(async () => {
  const f = await seed();
  await link(f, f.splitRefs[0], 6);
  await link(f, f.splitRefs[1], 4);
}));

test("a split cannot exceed what the shared sales line has left", () => isolated(async () => {
  const f = await seed();
  await link(f, f.ref, 8);
  await assert.rejects(link(f, f.splitRefs[0], 6), /open sales quantity is only 2/u);
}));

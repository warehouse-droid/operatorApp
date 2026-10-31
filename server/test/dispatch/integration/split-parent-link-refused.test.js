import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { query, withTransaction, closeDb } from "../../../src/db.js";
import { createSalesOrderPoAllocation, getSalesOrderPoAllocationOptions } from "../../../src/dispatch-repository.js";
import { createOrderDependency, getOrderDependencyOptions } from "../../../src/order-dependency-repository.js";

after(closeDb);
const isolated = run => withTransaction(run, { rollback: true });

// Splitting is refused while the SO has links, but a planner that has not yet
// seen the split still shows the parent. A link on that parent would apply to
// every split, so it is refused and the splits are named instead.
async function seed() {
  const id = 8_996_100_000 + crypto.randomInt(1_000_000);
  const ref = `SO-SPLITPARENT-${id}`;
  const plan = (await query("INSERT INTO dispatch_plans(plan_date,status) VALUES ('2095-11-03','draft') RETURNING id")).rows[0];
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,customer,sales_order_type,
    outbound_location_id,outbound_location,operator_status,local_yard_order_status,fulfillment_status,netsuite_active)
    VALUES($1,$2,'B','Sales Order : Pending Fulfillment','Split parent test','Delivery',28,'2967','open','Open','not_fulfilled',true)`,
  [id, ref]);
  const line = (await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,item_description,
    item_type,item_type_text,unit,quantity,netsuite_backordered_qty,netsuite_active)
    VALUES($1,101,2055,'MBBS-Special Order','MBBS-Special Order','Parent slab','NonInvtPart','Non-inventory Item','PC',10,10,true)
    RETURNING *`, [id])).rows[0];
  for (const [splitRef, quantity] of [[`${ref}-S1`, 6], [`${ref}-S2`, 4]]) {
    const split = { id: splitRef, type: "SO", originalOrderId: ref,
      items: [{ lineRowId: line.id, lineId: 101, itemId: 2055, sku: line.sku, quantity, unit: "PC" }] };
    await query(`INSERT INTO dispatch_global_order_splits(split_ref,order_type,parent_order_ref,source_plan_id,
      source_plan_date,full_order,card) VALUES($1,'SO',$2,$3,'2095-11-03',$4::jsonb,$4::jsonb)`,
    [splitRef, ref, plan.id, JSON.stringify(split)]);
  }
  const poId = id + 2;
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,vendor,dispatch_vendor_yard,
    dispatch_address,destination_location_id,destination_location,netsuite_active)
    VALUES($1,$2,'B','Purchase Order : Pending Receipt','Parent vendor','Parent Vendor Yard','100 Test Road',28,'2967',true)`,
  [poId, `PO-SPLITPARENT-${id}`]);
  const poLine = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,
    item_description,item_type,item_type_text,quantity,unit,netsuite_active)
    VALUES($1,201,2055,'MBBS-Special Order','MBBS-Special Order','Parent slab','NonInvtPart','Non-inventory Item',50,'PC',true)
    RETURNING id`, [poId])).rows[0];
  const toId = id + 3;
  await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,netsuite_active) VALUES($1,$2,'B',true)`,
    [toId, `TO-SPLITPARENT-${id}`]);
  return { ref, poRef: `PO-SPLITPARENT-${id}`, poLineId: poLine.id, transferRef: `TO-SPLITPARENT-${id}` };
}

const namesSplits = f => error => error.status === 409 && error.code === "DISPATCH_TARGET_SPLIT_PARENT"
  && error.message.includes(`${f.ref}-S1`) && error.message.includes(`${f.ref}-S2`);

test("a PO link on the parent of active splits is refused", () => isolated(async () => {
  const f = await seed();
  const options = await getSalesOrderPoAllocationOptions(f.ref);
  await assert.rejects(createSalesOrderPoAllocation({ dispatchTargetRef: f.ref, salesOrderRef: f.ref,
    targetLineKey: options.salesLines[0].targetLineKey, poLineId: f.poLineId, poRef: f.poRef,
    quantities: { salesQty: 1 }, createdBy: "split-parent-regression" }), namesSplits(f));
}));

test("a TO link on the parent of active splits is refused", () => isolated(async () => {
  const f = await seed();
  await assert.rejects(createOrderDependency({ dispatchTargetRef: f.ref, transferOrderRef: f.transferRef,
    mode: "direct_to_customer", allocations: [] }), namesSplits(f));
}));

test("Link TO options for the parent of active splits name the splits", () => isolated(async () => {
  const f = await seed();
  await assert.rejects(getOrderDependencyOptions({ dispatchTargetRef: f.ref, transferOrderRef: f.transferRef }), namesSplits(f));
}));

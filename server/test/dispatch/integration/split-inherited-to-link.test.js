import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { query, withTransaction, closeDb } from "../../../src/db.js";
import { createOrderDependency, getOrderDependencyOptions } from "../../../src/order-dependency-repository.js";

after(closeDb);
const isolated = run => withTransaction(run, { rollback: true });

// A link made on an SO before it was split still applies to its splits, and
// their cards say so. Each split's Link TO window must show that link, so it
// can be unlinked, and must not offer its quantity again.
async function seed({ legacyQuantity }) {
  const id = 8_996_300_000 + crypto.randomInt(1_000_000);
  const ref = `SO-INHERIT-${id}`;
  const plan = (await query("INSERT INTO dispatch_plans(plan_date,status) VALUES ('2095-11-04','draft') RETURNING id")).rows[0];
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,customer,sales_order_type,
    outbound_location_id,outbound_location,operator_status,local_yard_order_status,fulfillment_status,netsuite_active)
    VALUES($1,$2,'B','Sales Order : Pending Fulfillment','Inherited link test','Delivery',28,'2967','open','Open','not_fulfilled',true)`,
  [id, ref]);
  const line = (await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,item_description,
    item_type,item_type_text,unit,quantity,netsuite_backordered_qty,netsuite_active)
    VALUES($1,101,2055,'MBBS-Special Order','MBBS-Special Order','Parent slab','NonInvtPart','Non-inventory Item','PC',10,10,true)
    RETURNING *`, [id])).rows[0];
  for (const [splitRef, quantity] of [[`${ref}-S1`, 6], [`${ref}-S2`, 4]]) {
    const split = { id: splitRef, type: "SO", originalOrderId: ref,
      items: [{ lineRowId: line.id, lineId: 101, itemId: 2055, sku: line.sku, quantity, unit: "PC" }] };
    await query(`INSERT INTO dispatch_global_order_splits(split_ref,order_type,parent_order_ref,source_plan_id,
      source_plan_date,full_order,card) VALUES($1,'SO',$2,$3,'2095-11-04',$4::jsonb,$4::jsonb)`,
    [splitRef, ref, plan.id, JSON.stringify(split)]);
  }
  const poId = id + 2;
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,vendor,dispatch_vendor_yard,
    dispatch_address,destination_location_id,destination_location,netsuite_active)
    VALUES($1,$2,'B','Purchase Order : Pending Receipt','Parent vendor','Parent Vendor Yard','100 Test Road',28,'2967',true)`,
  [poId, `PO-INHERIT-${id}`]);
  const poLine = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,
    item_description,item_type,item_type_text,quantity,unit,netsuite_active)
    VALUES($1,201,2055,'MBBS-Special Order','MBBS-Special Order','Parent slab','NonInvtPart','Non-inventory Item',50,'PC',true)
    RETURNING id`, [poId])).rows[0];
  const toId = id + 3;
  await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,netsuite_active) VALUES($1,$2,'B',true)`,
    [toId, `TO-INHERIT-${id}`]);
  await query("UPDATE transfer_orders SET from_location_id=1, from_location='3445', to_location_id=28, to_location='2967' WHERE netsuite_id=$1", [toId]);
  await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_stage,line_id,item_id,item_name,item_type,quantity,unit,netsuite_active)
    VALUES($1,'outbound',1,2055,'MBBS-Special Order','NonInvtPart',20,'PC',true)`, [toId]);
  // A legacy replenishment link made on the SO before the split guard existed.
  const legacyToId = id + 4;
  await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,netsuite_active) VALUES($1,$2,'B',true)`, [legacyToId, `TO-LEGACY-${id}`]);
  const legacy = (await query(`INSERT INTO order_dependencies(sales_order_id,sales_order_ref,transfer_order_id,transfer_order_ref,
    source_location_id,source_location,accounting_destination_location_id,dependency_mode,status,dispatch_target_ref,dispatch_target_kind)
    VALUES($1,$2,$3,$4,1,'3445',28,'yard_replenishment','active',$2,'normal') RETURNING id`, [id, ref, legacyToId, `TO-LEGACY-${id}`])).rows[0];
  await query(`INSERT INTO order_dependency_lines(dependency_id,line_role,sales_line_id,item_id,item_name,unit,allocated_quantity,dispatch_target_line_key)
    VALUES($1,'sales_allocation',$2,2055,'MBBS-Special Order','PC',$3,$4)`, [legacy.id, line.id, legacyQuantity, `${ref}::${ref}::${line.id}`]);
  return { ref, legacyId: legacy.id, transferRef: `TO-INHERIT-${id}` };
}

const options = f => getOrderDependencyOptions({ dispatchTargetRef: `${f.ref}-S1`, transferOrderRef: f.transferRef });

test("a split's Link TO window lists the link made on its SO before the split", () => isolated(async () => {
  const f = await seed({ legacyQuantity: 10 });
  assert.ok((await options(f)).existingLinks.some(link => Number(link.id) === Number(f.legacyId)));
}));

test("a split cannot link again what its SO's link already covers", () => isolated(async () => {
  const f = await seed({ legacyQuantity: 10 });
  const result = await options(f);
  assert.deepEqual(result.matchingLines, []);
  assert.match(result.matchError, /no remaining quantity/u);
}));

test("a split may still link what its SO's link left uncovered", () => isolated(async () => {
  const f = await seed({ legacyQuantity: 7 });
  assert.deepEqual((await options(f)).matchingLines.map(line => line.suggestedQuantity), [3]);
}));

test("linking a split beyond what its SO's link left is refused", () => isolated(async () => {
  const f = await seed({ legacyQuantity: 7 });
  const result = await options(f);
  await assert.rejects(createOrderDependency({ dispatchTargetRef: `${f.ref}-S1`, transferOrderRef: f.transferRef,
    mode: "yard_replenishment", targetSignature: result.targetSignature,
    allocations: [{ targetLineKey: result.matchingLines[0].targetLineKey, quantities: { salesQty: 5 } }] }),
  /remaining quantity 3/u);
}));

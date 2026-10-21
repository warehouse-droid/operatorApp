import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { query, withTransaction, closeDb } from "../../../src/db.js";
import { getSalesOrderPoAllocationOptions, createSalesOrderPoAllocation } from "../../../src/dispatch-repository.js";
import { remapDispatchLinksToMaterializedSplit } from "../../../src/dispatch-order-target-repository.js";
import { deactivateDispatchGlobalOrderDefinitions } from "../../../src/dispatch-delivery-group-repository.js";

after(closeDb);
const isolated = run => withTransaction(run, { rollback: true });

async function seed() {
  const id = 8_994_800_000 + crypto.randomInt(1_000_000);
  const ref = `SO-IDENTITY-${id}`;
  const splitRef = `${ref}-S1`;
  const groupRef = `GO-IDENTITY-${id}`;
  const plan = (await query("INSERT INTO dispatch_plans(plan_date,status) VALUES ('2095-10-15','draft') RETURNING id")).rows[0];
  for (const [salesId, salesRef] of [[id, ref], [id + 1, splitRef]]) {
    await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,customer,sales_order_type,
      outbound_location_id,outbound_location,operator_status,local_yard_order_status,fulfillment_status,netsuite_active)
      VALUES($1,$2,'B','Sales Order : Pending Fulfillment','Line identity test','Delivery',28,'2967',
        'open','Open','not_fulfilled',true)`, [salesId, salesRef]);
  }
  const parent = [];
  const split = [];
  for (const [salesId, collection] of [[id, parent], [id + 1, split]]) {
    for (const [lineId, description, unit, quantity] of [[101, "BLU slab", "SQFT", 947.73], [102, "SIENASTONE coping", "PC", 11]]) {
      collection.push((await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,
        item_description,item_type,item_type_text,unit,quantity,netsuite_backordered_qty,netsuite_active)
        VALUES($1,$2,2055,'MBBS-Special Order','MBBS-Special Order',$3,'NonInvtPart','Non-inventory Item',$4,$5,$5,true)
        RETURNING *`, [salesId, lineId, description, unit, quantity])).rows[0]);
    }
  }
  const order = { id: splitRef, type: "SO", originalOrderId: ref, items: parent.map(line => ({
    lineRowId: line.id, lineId: line.line_id, itemId: 2055, sku: line.sku, description: line.item_description,
    quantity: Number(line.quantity), unit: line.unit
  })) };
  const group = { id: groupRef, type: "SO", childOrders: [splitRef], childOrderDetails: [order], items: order.items };
  await query(`INSERT INTO dispatch_global_order_splits(split_ref,order_type,parent_order_ref,source_plan_id,
    source_plan_date,full_order,card) VALUES($1,'SO',$2,$3,'2095-10-15',$4::jsonb,$4::jsonb)`,
    [splitRef, ref, plan.id, JSON.stringify(order)]);
  await query(`INSERT INTO dispatch_global_order_groups(group_ref,order_type,source_plan_id,source_plan_date,full_order,card)
    VALUES($1,'SO',$2,'2095-10-15',$3::jsonb,$3::jsonb)`, [groupRef, plan.id, JSON.stringify(group)]);
  const poId = id + 2;
  const poRef = `PO-IDENTITY-${id}`;
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,vendor,dispatch_vendor_yard,
    dispatch_address,destination_location_id,destination_location,netsuite_active)
    VALUES($1,$2,'B','Purchase Order : Pending Receipt','Identity vendor','Identity Vendor Yard','100 Test Road',28,'2967',true)`,
    [poId, poRef]);
  const poLines = [];
  for (const [lineId, unit, quantity, description] of [[201, "SQFT", 947.73, "BLU slab"], [202, "PC", 11, "SIENASTONE coping"]]) {
    poLines.push((await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,
      item_description,item_type,item_type_text,quantity,unit,netsuite_active)
      VALUES($1,$2,2055,'MBBS-Special Order','MBBS-Special Order',$3,'NonInvtPart','Non-inventory Item',$4,$5,true)
      RETURNING id`, [poId, lineId, description, quantity, unit])).rows[0]);
  }
  return { id, ref, splitRef, groupRef, parent, split, order, poId, poRef, poLines };
}

test("PO options preserve separate descriptions, UOMs and candidate lines for split and grouped repeated items", () => isolated(async () => {
  const f = await seed();
  for (const target of [f.splitRef, f.groupRef]) {
    const options = await getSalesOrderPoAllocationOptions(target);
    assert.deepEqual(options.salesLines.map(line => [line.id, line.description, line.required.unit, line.required.salesQty]), [
      [Number(f.split[0].id), "BLU slab", "SQFT", 947.73],
      [Number(f.split[1].id), "SIENASTONE coping", "PC", 11]
    ]);
    for (const [index, line] of options.salesLines.entries()) {
      assert.ok(line.poCandidates.some(candidate => Number(candidate.poLineId) === Number(f.poLines[index].id)));
      assert.ok(!line.poCandidates.some(candidate => Number(candidate.poLineId) === Number(f.poLines[1 - index].id)));
    }
  }
}));

test("connecting the second repeated item persists its correct sales row and rejects the wrong UOM without writes", () => isolated(async () => {
  const f = await seed();
  const options = await getSalesOrderPoAllocationOptions(f.groupRef);
  const second = options.salesLines[1];
  const command = { dispatchTargetRef: f.groupRef, targetLineKey: second.targetLineKey,
    targetSignature: options.order.targetSignature, quantities: { salesQty: 11 }, poRef: f.poRef };
  await assert.rejects(createSalesOrderPoAllocation({ ...command, poLineId: f.poLines[0].id }), /UOM|unit/i);
  assert.equal((await query("SELECT count(*)::int AS count FROM dispatch_so_po_allocations WHERE dispatch_target_ref=$1", [f.groupRef])).rows[0].count, 0);
  const linked = await createSalesOrderPoAllocation({ ...command, poLineId: f.poLines[1].id });
  const stored = (await query("SELECT sales_line_id,allocated_sales_qty FROM dispatch_so_po_allocations WHERE id=$1", [linked.id])).rows[0];
  assert.equal(Number(stored.sales_line_id), Number(f.split[1].id));
  assert.equal(Number(stored.allocated_sales_qty), 11);
}));

test("materializing repeated split items remaps each PO link to the matching child row", () => isolated(async () => {
  const f = await seed();
  const previousKeys = [];
  for (const [index, line] of f.parent.entries()) {
    const key = `${f.splitRef}::${f.ref}::${line.id}`;
    previousKeys.push(key);
    await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,
      po_order_id,po_order_ref,po_line_id,item_id,allocated_sales_qty,dispatch_target_ref,dispatch_target_kind,dispatch_target_line_key)
      VALUES($1,$2,$3,$4,$5,$6,2055,$7,$8,'split',$9)`,
      [f.id, f.ref, line.id, f.poId, f.poRef, f.poLines[index].id, line.quantity, f.splitRef, key]);
  }
  const result = await remapDispatchLinksToMaterializedSplit(f.order, f.id + 1);
  assert.equal(result.poAllocations, 2);
  const rows = (await query(`SELECT sales_line_id,dispatch_target_line_key,allocated_sales_qty
    FROM dispatch_so_po_allocations WHERE dispatch_target_ref=$1 ORDER BY po_line_id`, [f.splitRef])).rows;
  assert.deepEqual(rows.map(row => Number(row.sales_line_id)), f.split.map(line => Number(line.id)));
  assert.deepEqual(rows.map(row => row.dispatch_target_line_key), f.parent.map(line => `${f.splitRef}::${f.splitRef}::${line.id}`));
  assert.deepEqual(rows.map(row => Number(row.allocated_sales_qty)), [947.73, 11]);
  assert.ok(rows.every(row => !previousKeys.includes(row.dispatch_target_line_key)));
}));

test("materializing a repeated split item remaps its TO allocation to the correct child row", () => isolated(async () => {
  const f = await seed();
  const transferId = f.id + 3;
  const transferRef = `TO-IDENTITY-${f.id}`;
  await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,status_text,from_location_id,from_location,
    to_location_id,to_location,netsuite_active) VALUES($1,$2,'B','Transfer Order : Pending Fulfillment',1,'3445',28,'2967',true)`,
    [transferId, transferRef]);
  const dependency = (await query(`INSERT INTO order_dependencies(sales_order_id,sales_order_ref,transfer_order_id,
    transfer_order_ref,source_location_id,source_location,accounting_destination_location_id,accounting_destination_location,
    dispatch_target_ref,dispatch_target_kind) VALUES($1,$2,$3,$4,1,'3445',28,'2967',$5,'split') RETURNING id`,
    [f.id, f.ref, transferId, transferRef, f.splitRef])).rows[0];
  const line = (await query(`INSERT INTO order_dependency_lines(dependency_id,sales_line_id,item_id,unit,
    allocated_quantity,dispatch_target_line_key,line_role) VALUES($1,$2,2055,'PC',11,$3,'sales_allocation') RETURNING id`,
    [dependency.id, f.parent[1].id, `${f.splitRef}::${f.ref}::${f.parent[1].id}`])).rows[0];
  const result = await remapDispatchLinksToMaterializedSplit(f.order, f.id + 1);
  assert.equal(result.dependencies, 1);
  const stored = (await query("SELECT * FROM order_dependency_lines WHERE id=$1", [line.id])).rows[0];
  assert.equal(Number(stored.sales_line_id), Number(f.split[1].id));
  assert.equal(stored.dispatch_target_line_key, `${f.splitRef}::${f.splitRef}::${f.parent[1].id}`);
  assert.equal(Number(stored.allocated_quantity), 11);
  assert.equal(stored.unit, "PC");
}));

async function linkSecond(f, targetRef = f.groupRef, quantity = 5) {
  const options = await getSalesOrderPoAllocationOptions(targetRef);
  return createSalesOrderPoAllocation({ dispatchTargetRef: targetRef,
    targetLineKey: options.salesLines[1].targetLineKey, targetSignature: options.order.targetSignature,
    poLineId: f.poLines[1].id, poRef: f.poRef, quantities: { salesQty: quantity } });
}

test("retirement cancels the retired group's PO links and preserves active member links and history", () => isolated(async () => {
  const f = await seed();
  const retiredLink = await linkSecond(f);
  const memberLink = await linkSecond(f, f.splitRef);
  const before = (await query("SELECT * FROM dispatch_so_po_allocations WHERE id=$1", [retiredLink.id])).rows[0];
  await deactivateDispatchGlobalOrderDefinitions([f.groupRef]);
  const rows = (await query("SELECT * FROM dispatch_so_po_allocations WHERE id=ANY($1::bigint[]) ORDER BY id", [[retiredLink.id, memberLink.id]])).rows;
  const retired = rows.find(row => String(row.id) === String(retiredLink.id));
  assert.equal(retired.status, "cancelled");
  assert.ok(retired.cancelled_at);
  assert.equal(retired.cancelled_by, "dispatch-target-retired");
  assert.equal(retired.sales_line_id, before.sales_line_id);
  assert.equal(retired.allocated_sales_qty, before.allocated_sales_qty);
  assert.equal(rows.find(row => String(row.id) === String(memberLink.id)).status, "active");
  const events = (await query("SELECT details FROM dispatch_audit_log WHERE action='dispatch.po_links.target_retired' AND entity_id=$1", [f.groupRef])).rows;
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].details.allocationIds.map(String), [String(retiredLink.id)]);
}));

test("repeated retirement cleans an existing orphan once and ignores unknown and active targets", () => isolated(async () => {
  const f = await seed();
  const linked = await linkSecond(f);
  await query("UPDATE dispatch_global_order_groups SET active=false WHERE group_ref=$1", [f.groupRef]);
  await deactivateDispatchGlobalOrderDefinitions([`UNKNOWN-${f.id}`]);
  assert.equal((await query("SELECT status FROM dispatch_so_po_allocations WHERE id=$1", [linked.id])).rows[0].status, "active");
  await deactivateDispatchGlobalOrderDefinitions([f.groupRef.toLowerCase(), f.groupRef]);
  assert.equal((await query("SELECT status FROM dispatch_so_po_allocations WHERE id=$1", [linked.id])).rows[0].status, "cancelled");
  await deactivateDispatchGlobalOrderDefinitions([f.groupRef]);
  assert.equal((await query("SELECT count(*)::int AS count FROM dispatch_audit_log WHERE action='dispatch.po_links.target_retired' AND entity_id=$1", [f.groupRef])).rows[0].count, 1);
}));

test("retirement and PO unlink roll back together", () => isolated(async () => {
  const f = await seed();
  const linked = await linkSecond(f);
  await isolated(async () => {
    await deactivateDispatchGlobalOrderDefinitions([f.groupRef]);
    assert.equal((await query("SELECT status FROM dispatch_so_po_allocations WHERE id=$1", [linked.id])).rows[0].status, "cancelled");
  });
  assert.equal((await query("SELECT active FROM dispatch_global_order_groups WHERE group_ref=$1", [f.groupRef])).rows[0].active, true);
  assert.equal((await query("SELECT status FROM dispatch_so_po_allocations WHERE id=$1", [linked.id])).rows[0].status, "active");
  assert.equal((await query("SELECT count(*)::int AS count FROM dispatch_audit_log WHERE action='dispatch.po_links.target_retired' AND entity_id=$1", [f.groupRef])).rows[0].count, 0);
}));

test("unsplitting cancels only the retired split target's PO links", () => isolated(async () => {
  const f = await seed();
  const linked = await linkSecond(f, f.splitRef);
  await deactivateDispatchGlobalOrderDefinitions([f.splitRef]);
  assert.equal((await query("SELECT status FROM dispatch_so_po_allocations WHERE id=$1", [linked.id])).rows[0].status, "cancelled");
  assert.equal((await query("SELECT active FROM dispatch_global_order_groups WHERE group_ref=$1", [f.groupRef])).rows[0].active, true);
}));

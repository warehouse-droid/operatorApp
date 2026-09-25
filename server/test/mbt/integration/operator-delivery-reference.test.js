import assert from "node:assert/strict";
import test, { after } from "node:test";
import { query, withTransaction, closeDb } from "../../../src/db.js";
import { getDeliveryOrder, listDeliveryOrders, confirmDeliveryLine } from "../../../src/delivery-repository.js";
import { packingOrder, packingGroup, packingState } from "../../support/group-underpack-fixture.mjs";
import { specialLine, palletLine } from "../../support/operator-display-refresh-fixture.mjs";

after(closeDb);
const scenario = (run) => withTransaction(run, { rollback: true });
const actor = "display-reference-operator";

async function fixture() {
  await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,'Display test','test','test','operator',ARRAY['operator'],true)", [actor]);
  const children = [];
  for (const line of [specialLine, palletLine]) {
    const order = await packingOrder({ salesOnly: true, quantity: line.quantity, packed: 0 });
    await query("UPDATE sales_orders SET operator_status='open' WHERE netsuite_id=$1", [order.id]);
    await query(`UPDATE sales_order_lines SET item_id=$2,item_name=$3,sku=$3,item_type=$4,unit=$5,pallet_qty=$6,
      pack_quantity_source=$7,to_plt=0,to_lyr=0,to_sec=0,to_pcs=0 WHERE id=$1`,
    [order.lineId, line.item_id, line.item_name, line.item_type, line.unit, line.pallet_qty, line.pack_quantity_source]);
    children.push(order);
  }
  const groupId = await packingGroup(children);
  const poId = children[0].id + 100000;
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,trandate,vendor,status,status_text,destination_location_id,receipt_status,netsuite_active)
    VALUES($1,$2,current_date,'Display test vendor','B','Pending Receipt',1,'open',true)`, [poId, `PO-DISPLAY-${poId}`]);
  for (const [index, line] of [specialLine, palletLine].entries()) {
    const poLine = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,item_type,quantity,unit,netsuite_active)
      VALUES($1,$2,$3,$4,$5,$6,$7,true) RETURNING id`, [poId, index + 1, line.item_id, line.item_name, line.item_type, line.quantity, line.unit])).rows[0];
    const child = children[index];
    await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,item_name,sku,
      allocated_sales_qty,status,dispatch_target_ref,dispatch_target_kind,dispatch_target_line_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,'active',$10,'group',$11)`,
    [child.id, child.ref, child.lineId, poId, `PO-DISPLAY-${poId}`, poLine.id, line.item_id, line.item_name, line.quantity, groupId, `${groupId}::${child.ref}::${child.lineId}`]);
  }
  return { children, groupId };
}

test("L1/L2 planned fully linked group remains discoverable with two reference lines", () => scenario(async () => {
  const f = await fixture();
  const group = await getDeliveryOrder(f.groupId);
  assert.equal(group.lines.length, 2);
  assert.ok(group.lines.every((line) => line.no_yard_load_required));
  assert.deepEqual(group.lines.map((line) => line.original_quantity), [2332, 20]);
  const active = await listDeliveryOrders({ locationId: 1 });
  const card = active.find((order) => order.netsuite_id === f.groupId);
  assert.ok(card, "reference group must remain under Planned");
  assert.equal(card.has_open_qty, false, "references are not outstanding packing work");
  assert.ok(!(await listDeliveryOrders({ locationId: 1, status: "packed" })).some((order) => order.netsuite_id === f.groupId));
  await query("UPDATE sales_orders SET local_yard_order_status='Loaded',fulfillment_status='fulfilled' WHERE netsuite_id=ANY($1::bigint[])", [f.children.map((child) => child.id)]);
  assert.ok(!(await listDeliveryOrders({ locationId: 1 })).some((order) => order.netsuite_id === f.groupId));
}));

test("L3 reference confirmation is rejected on canonical and grouped lines without writes", () => scenario(async () => {
  const f = await fixture();
  const before = await Promise.all(f.children.map(packingState));
  const group = await getDeliveryOrder(f.groupId);
  const special = group.lines.find((line) => Number(line.item_id) === 2055);
  for (const [orderId, lineId] of [[f.children[0].id, f.children[0].lineId], [f.groupId, special.id]]) {
    await assert.rejects(confirmDeliveryLine(orderId, lineId, { pallets: 20, salesQty: 2332 }, actor), { code: "DELIVERY_NO_YARD_LOAD_REQUIRED" });
  }
  assert.deepEqual(await Promise.all(f.children.map(packingState)), before);
}));

test("L3 partial or cancelled PO links restore sales residual and over-allocation blocks", () => scenario(async () => {
  const f = await fixture();
  const child = f.children[0];
  await query("UPDATE dispatch_so_po_allocations SET allocated_sales_qty=2000 WHERE sales_line_id=$1", [child.lineId]);
  let group = await getDeliveryOrder(f.groupId);
  let special = group.lines.find((line) => Number(line.item_id) === 2055);
  assert.equal(special.quantity, 332);
  assert.equal(special.no_yard_load_required, false);
  await query("UPDATE dispatch_so_po_allocations SET status='cancelled' WHERE sales_line_id=$1", [child.lineId]);
  assert.equal((await getDeliveryOrder(child.id)).lines[0].quantity, 2332);
  await query("UPDATE dispatch_so_po_allocations SET status='active',allocated_sales_qty=2333 WHERE sales_line_id=$1", [child.lineId]);
  group = await getDeliveryOrder(f.groupId);
  special = group.lines.find((line) => Number(line.item_id) === 2055);
  assert.equal(special.linked_quantity_blocked, true);
  await assert.rejects(confirmDeliveryLine(f.groupId, special.id, { salesQty: 1 }, actor), { code: "DELIVERY_LINKED_QUANTITY_BLOCKED" });
}));

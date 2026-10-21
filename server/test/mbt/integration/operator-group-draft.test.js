import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";
import { query, closeDb, withTransaction } from "../../../src/db.js";
import { getDeliveryOrder, listDeliveryOrders, confirmDeliveryLines, updateDeliveryStatus,
  getCurrentOperatorDeliveryDraft, setDeliveryLinePackedQuantity } from "../../../src/delivery-repository.js";
import { packingOrder, packingGroup, packingState } from "../../support/group-underpack-fixture.mjs";

after(closeDb);
const rollback = run => withTransaction(run, { rollback: true });
const actor = "group-camera-regression";
async function fixture(transfer = false) {
  await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,$1,'test','test','operator',ARRAY['operator'],true)", [actor]);
  const first = await packingOrder({ transfer, quantity: 22, layers: 0, packed: 0, conversion: 0 });
  const second = await packingOrder({ transfer, quantity: 50, layers: 0, packed: 0, conversion: 0 });
  const table = first.lineTable, orderColumn = transfer ? "transfer_order_id" : "sales_order_id";
  await query(`UPDATE ${table} SET item_id=1228,item_name='UNI-PISAS-COP-CG',sku='UNI-PISAS-COP-CG',unit='PC',
    pallet_qty=CASE WHEN id=$1 THEN 0 ELSE 1 END,piece_qty=CASE WHEN id=$1 THEN 22 ELSE 14 END,
    packed_piece_qty=CASE WHEN id=$1 THEN 22 ELSE 0 END,to_plt=36,to_pcs=1,
    pack_quantity_source='netsuite_manual' WHERE id=ANY($2::bigint[])`, [first.lineId,[first.lineId,second.lineId]]);
  for (const [index, order] of [first, second].entries()) {
    await query(`INSERT INTO ${table}(${orderColumn},line_id,item_id,item_name,sku,item_type,quantity,unit,location_id,location,
      packed_sales_qty,netsuite_active,pack_quantity_source${transfer ? ",line_stage" : ""})
      VALUES($1,2,1784,'PALLET','PALLET','InvtPart',$2,'EACH',1,'3445',$3,true,'sales_only'${transfer ? ",'outbound'" : ""})`,
    [order.id,index ? 2 : 5,index ? 0 : 5]);
  }
  await query(`UPDATE ${transfer ? "transfer_orders" : "sales_orders"} SET ${transfer ? "outbound_operator_status" : "operator_status"}='open' WHERE netsuite_id=$1`, [second.id]);
  const group = await packingGroup([first, second]);
  return { first, second, group, transfer };
}
async function confirmRemaining(f) {
  const order = await getDeliveryOrder(f.group);
  const lines = order.lines.map(line => line.item_name === "PALLET"
    ? { lineId: line.id, salesQty: 2, pieces: 2 }
    : { lineId: line.id, pallets: 1, pieces: 14 });
  await confirmDeliveryLines(f.group, lines, actor);
}

test("mixed packed/open group keeps its preparing owner and current draft identity", () => rollback(async () => {
  const f = await fixture();
  await confirmRemaining(f);
  const order = await getDeliveryOrder(f.group);
  assert.equal(order.operator_status, "preparing");
  assert.equal(order.preparing_operator_id, actor, "Owner must come from the preparing child, not the first packed child");
  const row = (await listDeliveryOrders({ locationId: 1 })).find(row => row.netsuite_id === f.group);
  assert.equal(row?.preparing_operator_id, actor);
  const draft = await getCurrentOperatorDeliveryDraft(actor, { locationId: 1 });
  assert.equal(draft?.netsuite_id, f.group, "A grouped draft must not navigate to or release just one child");
}));

test("current draft returns the group even when its first child is already packed", () => rollback(async () => {
  const f = await fixture();
  await confirmRemaining(f);
  assert.equal((await getCurrentOperatorDeliveryDraft(actor, { locationId: 1 }))?.netsuite_id, f.group);
}));

test("standalone draft keeps its order identity and quantities", () => rollback(async () => {
  await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,$1,'test','test','operator',ARRAY['operator'],true)", [actor]);
  const order = await packingOrder({ salesOnly: true, quantity: 7, packed: 7 });
  await query("UPDATE sales_orders SET operator_status='preparing',preparing_operator_id=$2,preparing_started_at=now() WHERE netsuite_id=$1", [order.id, actor]);
  const before = await packingState(order);
  const draft = await getCurrentOperatorDeliveryDraft(actor, { locationId: 1 });
  assert.equal(String(draft.netsuite_id), String(order.id));
  assert.equal(draft.tranid, order.ref);
  assert.equal(draft.draft_line_count, 1);
  assert.equal(draft.preparing_operator_id, actor);
  assert.equal(draft.is_dispatch_group, undefined);
  assert.deepEqual(await packingState(order), before);
}));

for (const transfer of [false,true]) test(`${transfer ? "TO" : "SO"}: complete remaining group quantities and pack both children`, () => rollback(async () => {
  const f = await fixture(transfer);
  await confirmRemaining(f);
  await updateDeliveryStatus(f.group,"packed",actor);
  const order = await getDeliveryOrder(f.group);
  assert.equal(order.operator_status,"packed");
  assert.equal(order.underpack_count,0);
  assert.equal(Number(order.lines.find(l => l.item_name === "PALLET").packed_sales_qty),7);
  const paver = order.lines.find(l => l.item_name === "UNI-PISAS-COP-CG");
  assert.equal(Number(paver.packed_pallet_qty),1);
  assert.equal(Number(paver.packed_piece_qty),36);
  assert.equal(await getCurrentOperatorDeliveryDraft(actor,{locationId:1}),null);
  for (const child of [f.first,f.second]) {
    const state = await packingState(child);
    assert.equal(state.header[0][transfer ? "outbound_operator_status" : "operator_status"],"packed");
    assert.equal(state.header[0].preparing_operator_id,null);
    assert(state.lines.every(line => Number(line.loaded_qty || 0) === 0));
  }
}));

test("another operator cannot change a child-owned group and failed edit preserves quantities", () => rollback(async () => {
  const f = await fixture();
  await confirmRemaining(f);
  const before = await packingState(f.second);
  const line = (await getDeliveryOrder(f.group)).lines.find(l => l.item_name === "PALLET");
  await assert.rejects(setDeliveryLinePackedQuantity(f.group,line.id,{salesQty:7},"someone-else"),/another tablet/);
  assert.deepEqual(await packingState(f.second),before);
}));

test("property: member ordering does not change draft identity or ownership", () => rollback(async () => {
  const f = await fixture();
  await confirmRemaining(f);
  await fc.assert(fc.asyncProperty(fc.boolean(), async reverse => {
    // Position is unique within the group; move both fixture rows out of the
    // target range before swapping them, as a real reorder must do.
    await query("UPDATE dispatch_delivery_group_members SET position=position+2 WHERE group_ref=$1", [f.group]);
    await query("UPDATE dispatch_delivery_group_members SET position=CASE WHEN member_order_ref=$2 THEN $3::integer ELSE $4::integer END WHERE group_ref=$1",
      [f.group,f.first.ref,reverse ? 1 : 0,reverse ? 0 : 1]);
    const order = await getDeliveryOrder(f.group);
    assert.equal(order.preparing_operator_id,actor);
    assert.equal((await getCurrentOperatorDeliveryDraft(actor,{locationId:1})).netsuite_id,f.group);
    assert.equal(Number(order.lines.find(l => l.item_name === "PALLET").packed_sales_qty),7);
  }), {seed:20260929,numRuns:12});
}));

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { query } from "../../src/db.js";
import { resolveDispatchSalesTarget } from "../../src/dispatch-order-target-repository.js";
import { scmDependencyPayloadHash } from "../../src/scm-dependency-command-service.js";
import { upsertLocalCoOrder } from "../../src/dispatch-repository.js";
let sequence = 0;
export async function seed() {
  const base = 9_914_000_000 + (sequence += 10);
  const f = { salesId: base, salesRef: `SO-UNTOUCHED-${base}`, transferId: base + 1, transferRef: `TO-UNTOUCHED-${base}` };
  await query(`INSERT INTO sales_orders (netsuite_id,tranid,status,status_text,customer,sales_order_type,
    outbound_location_id,outbound_location,operator_status,local_yard_order_status,fulfillment_status,netsuite_active)
    VALUES ($1,$2,'B','Sales Order : Pending Fulfillment','Untouched regression','Delivery',26,'150',
      'packed','Open','not_fulfilled',true)`, [f.salesId, f.salesRef]);
  for (const [index, item, quantity, packed] of [[1, 1356, 52.25, 0], [2, 1784, 7, 5]]) {
    const line = (await query(`INSERT INTO sales_order_lines (sales_order_id,line_id,item_id,item_name,sku,
      item_type,item_type_text,quantity,unit,layer_qty,to_lyr,confirmed,confirmed_at,packed_sales_qty,
      netsuite_backordered_qty,netsuite_active)
      VALUES ($1,$2,$3,$4,$4,'InvtPart','Inventory Item',$5,$6,$7,$8,$9,
        CASE WHEN $9 THEN now() ELSE NULL END,$10,$11,true) RETURNING id`,
    [f.salesId, index, item, index === 1 ? "TREVISTA" : "PALLET", quantity,
      index === 1 ? "SQFT" : "EACH", index === 1 ? 5 : 0, index === 1 ? 10.45 : 0,
      packed > 0, packed, index === 1 ? quantity : 0])).rows[0];
    if (index === 1) {f.materialId = Number(line.id);}
    else {f.palletId = Number(line.id);}
  }
  await query(`INSERT INTO transfer_orders (netsuite_id,tranid,status,status_text,from_location_id,from_location,
    to_location_id,to_location,outbound_operator_status,local_yard_order_status,fulfillment_status,receiving_status,netsuite_active)
    VALUES ($1,$2,'B','Transfer Order : Pending Fulfillment',1,'3445',26,'150','open','Open','not_fulfilled','not_received',true)`,
  [f.transferId, f.transferRef]);
  for (const stage of ["outbound", "receiving"]) {
    await query(`INSERT INTO transfer_order_lines (transfer_order_id,line_id,line_stage,item_id,item_name,sku,
      item_type,item_type_text,quantity,unit,layer_qty,to_lyr,confirmed,netsuite_active)
      VALUES ($1,1,$2,1356,'TREVISTA','TREVISTA','InvtPart','Inventory Item',52.25,'SQFT',5,10.45,false,true),
        ($1,2,$2,1784,'PALLET','PALLET','InvtPart','Inventory Item',1,'EACH',0,0,false,true)`, [f.transferId, stage]);
  }
  return f;
}

export async function command(f, { mode = "direct_to_customer", quantity = 52.25, targetRef = f.salesRef } = {}) {
  const resolved = await resolveDispatchSalesTarget({ dispatchTargetRef: targetRef });
  const line = resolved.lines.find(row => row.salesLineId === f.materialId);
  assert.ok(line);
  const result = { requestId: crypto.randomUUID(), action: "link_to", targetRef,
    targetSignature: resolved.signature, payload: { transferOrderRef: f.transferRef, mode,
      allocations: [{ targetLineKey: line.targetLineKey, quantities: { salesQty: quantity } }] } };
  result.payloadHash = scmDependencyPayloadHash(result);
  return result;
}

export async function sources(f) {
  const state = {};
  for (const [name, sql, id] of [
    ["sales", "SELECT * FROM sales_orders WHERE netsuite_id=$1", f.salesId],
    ["salesLines", "SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY id", f.salesId],
    ["transfer", "SELECT * FROM transfer_orders WHERE netsuite_id=$1", f.transferId],
    ["transferLines", "SELECT * FROM transfer_order_lines WHERE transfer_order_id=$1 ORDER BY id", f.transferId]
  ]) {state[name] = (await query(sql, [id])).rows;}
  return state;
}

export async function sourceCo(f) {
  return upsertLocalCoOrder({ sourceOrderRef: f.salesRef, fromYard: "150", toYard: "3445",
    order: { id: f.salesRef, type: "SO", items: [
      { lineRowId: f.materialId, lineId: 1, itemId: 1356, itemName: "TREVISTA", quantity: 52.25, layers: 5, toLyr: 10.45, unit: "SQFT" },
      { lineRowId: f.palletId, lineId: 2, itemId: 1784, itemName: "PALLET", quantity: 7, unit: "EACH" }
    ] } });
}


import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createOperator } from "../../src/auth-repository.js";
import { query } from "../../src/db.js";

export const packedFields = ["packed_pallet_qty", "packed_layer_qty", "packed_section_qty", "packed_piece_qty", "packed_sales_qty"];
export const localFields = [...packedFields, "confirmed", "confirmed_at", "loaded_qty", "loaded_uom", "sync_exception", "sync_exception_at"];

export async function reopenFixture({ kind = "sales_order", loaded = 4, yard = 1 } = {}) {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  assert.match(process.env.DATABASE_URL, /\/mbt_test(?:[?#]|$)/u);
  const suffix = crypto.randomUUID();
  const actor = await createOperator({ username: `reopen-manager-${suffix}`, displayName: "Reopen Manager", password: suffix,
    role: "yard_manager", roles: ["yard_manager"], yardLocationIds: [yard], operatorYardLocationIds: [yard] });
  const packer = await createOperator({ username: `packer-${suffix}`, displayName: "Pat Packer", password: suffix,
    role: "operator", roles: ["operator"], yardLocationIds: [yard], operatorYardLocationIds: [yard] });
  const id = String(8_500_000_000 + crypto.randomInt(100_000_000));
  const target = {
    sales_order: { prefix: "SO", header: "sales_orders", table: "sales_order_lines", parent: "sales_order_id", status: "operator_status",
      location: "outbound_location_id,outbound_location,sales_order_type", locationStatus: "'Delivery'", stageColumn: "", stageValue: "" },
    transfer_order: { prefix: "TO", header: "transfer_orders", table: "transfer_order_lines", parent: "transfer_order_id", status: "outbound_operator_status",
      location: "from_location_id,from_location,receiving_status", locationStatus: "'pending'", stageColumn: ",line_stage", stageValue: ",'outbound'" }
  }[kind];
  const { header, table, parent, status, location } = target;
  const ref = `${target.prefix}-REOPEN-${suffix}`;
  await query(`INSERT INTO ${header}(netsuite_id,tranid,trandate,status,status_text,${location},${status},
    local_yard_order_status,fulfillment_status,netsuite_active,preparing_operator_id,preparing_started_at)
    VALUES($1,$2,current_date,'B','Pending Fulfillment',$3,'3445',${target.locationStatus},
      'packed','Packed','not_fulfilled',true,$4,now())`, [id, ref, yard, packer.id]);
  const line = (await query(`INSERT INTO ${table}(${parent},line_id,item_id,item_name,sku,item_type,quantity,unit,
    location_id,location,piece_qty,to_pcs,packed_pallet_qty,packed_layer_qty,packed_section_qty,packed_piece_qty,
    packed_sales_qty,confirmed,confirmed_at,loaded_qty,loaded_uom,netsuite_active${target.stageColumn})
    VALUES($1,1,889201,'Reopen Material','REOPEN-MATERIAL','InvtPart',20,'PC',$3,'3445',20,1,
      1,2,3,6,6,true,now(),$2,'PC',true${target.stageValue}) RETURNING *`, [id, loaded, yard])).rows[0];
  const photos = [`r2://reopen/${suffix}/one.jpg`, `r2://reopen/${suffix}/two.jpg`];
  const record = (await query(`INSERT INTO operator_load_records(load_type,order_family,order_id,order_ref,operator_id,
    photo_data_url,photo_data_urls,loaded_qty,line_snapshot) VALUES('delivery_load',$1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb) RETURNING *`,
  [kind, id, ref, packer.id, photos[0], JSON.stringify(photos), loaded, JSON.stringify([line])])).rows[0];
  await query(`INSERT INTO delivery_audit_log(actor_operator_id,action,order_id,details)
    VALUES($1,'delivery.order.status',$2,'{"status":"packed"}')`, [packer.id, id]);
  return { actor, packer, id, ref, kind, header, table, parent, status, line, photos, record, password: suffix };
}

export async function state(f) {
  return { header: (await query(`SELECT * FROM ${f.header} WHERE netsuite_id=$1`, [f.id])).rows[0],
    lines: (await query(`SELECT * FROM ${f.table} WHERE ${f.parent}=$1 ORDER BY id`, [f.id])).rows };
}

export function resetInput(f, preview, extra = {}) {
  return { orderRef: f.ref, actor: f.actor, expectedStateHash: preview.stateHash,
    reason: "Correct the Operator draft before relinking supply.", requestId: crypto.randomUUID(), ...extra };
}

export async function seedReopenGroup(groupRef, refs) {
  let plan = (await query("SELECT id FROM dispatch_plans WHERE plan_date='2079-02-03' AND status='draft' LIMIT 1")).rows[0];
  if (!plan) { plan = (await query("INSERT INTO dispatch_plans(plan_date,status) VALUES('2079-02-03','draft') RETURNING id")).rows[0]; }
  await query(`INSERT INTO dispatch_global_order_groups(group_ref,order_type,source_plan_id,source_plan_date,full_order,card,active)
    VALUES($1,'SO',$2,'2079-02-03',$3::jsonb,$4::jsonb,true)`,
  [groupRef, plan.id, JSON.stringify({ id: groupRef, type: "SO", childOrders: refs }), JSON.stringify({ id: groupRef, type: "SO" })]);
}

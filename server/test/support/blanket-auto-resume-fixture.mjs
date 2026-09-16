import crypto from "node:crypto";
import { query } from "../../src/db.js";

let sequence = 0;
const base = 8_410_000_000_000 + crypto.randomBytes(4).readUInt32BE() * 100;

export async function seedBlanketResume({
  flagged = false, quantity = 100, toPlt = 10, received = 0,
  closed = false, active = true, holdDate = "2020-01-01T00:00:00Z",
  flagDate = "2021-01-01T00:00:00Z"
} = {}) {
  const itemId = base + (++sequence * 10);
  const poId = itemId + 1;
  const lineId = itemId + 2;
  const itemName = `AUTO-RESUME-${itemId}`;
  const poRef = `PO-AUTO-RESUME-${poId}`;
  await query(`INSERT INTO inventory_items(item_id,item_name,stock_unit,to_plt,item_weight,vendor)
    VALUES($1,$2,'EA',10,100,'Resume Vendor')`, [itemId,itemName]);
  await query(`INSERT INTO scm_smart_item_policies(item_id,item_name,stock_unit,to_plt,
    pallet_weight_lbs,vendor,plant,planning_enabled,inactive,discontinued,lead_time_days)
    VALUES($1,$2,'EA',10,1000,'Resume Vendor','Resume Vendor Yard',true,false,false,7)`, [itemId,itemName]);
  await query(`INSERT INTO scm_smart_item_yard_policies(item_id,location_id,yard_code,eligible,
    capacity_pallets,service_quantile,minimum_safety_pallets)
    VALUES($1,1,'3445',true,80,0.9,2)`, [itemId]);
  await query(`INSERT INTO inventory_balances(item_id,location_id,location,quantity_on_hand,
    quantity_available,quantity_on_order) VALUES($1,1,'3445',0,0,$2)`, [itemId,quantity]);
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,trandate,vendor,status,status_text,
    netsuite_active,is_blanket_po,blanket_flagged_at,source_location,dispatch_vendor_yard,
    destination_location_id,destination_location)
    VALUES($1,$2,'2021-01-01','Resume Vendor','B','Purchase Order : Pending Receipt',true,
    $3,CASE WHEN $3 THEN $4::timestamptz ELSE NULL END,'Resume Vendor Yard','Resume Vendor Yard',1,'3445')`,
  [poId,poRef,flagged,flagDate]);
  await query(`INSERT INTO purchase_order_lines(id,purchase_order_id,line_id,item_id,item_name,sku,
    quantity,unit,pallet_qty,to_plt,item_weight,netsuite_active,netsuite_closed,
    netsuite_received_qty,netsuite_received_baseline_qty,location_id,location)
    VALUES($1,$2,1,$3,$4,$4,$5,'EA',0,$6,100,$7,$8,$9,$9,1,'3445')`,
  [lineId,poId,itemId,itemName,quantity,toPlt,active,closed,received]);
  const hold = await query(`INSERT INTO scm_smart_planning_exclusions(item_id,reason,created_at)
    VALUES($1,'Vendor out of stock',$2) RETURNING id`, [itemId,holdDate]);
  return { itemId,poId,lineId,itemName,poRef,holdId:Number(hold.rows[0].id) };
}

export async function holdState(fixture) {
  return (await query("SELECT * FROM scm_smart_planning_exclusions WHERE id=$1", [fixture.holdId])).rows[0];
}

export async function resumeAudits(fixture) {
  return (await query(`SELECT * FROM delivery_audit_log
    WHERE action='smart_scm.planning_exclusion.auto_resume_blanket'
      AND details->>'exclusionId'=$1 ORDER BY id`, [String(fixture.holdId)])).rows;
}

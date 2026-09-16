import assert from "node:assert/strict";
import { beginRollbackContext, query } from "../../src/db.js";

export const itemId = 892000001;
export const parentId = 892000002;
export const vendorId = 892000003;
export const itemName = "INBOUND-HUNT70S-RDM-CG";
export const conversion = 102.3;
let sequence = 0;

export async function isolated(operation) {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  const rollback = await beginRollbackContext();
  try { return await rollback.run(operation); }
  finally { await rollback.rollback(); }
}

export async function fixture({ blanket = true } = {}) {
  await query(`UPDATE scm_smart_settings SET inventory_planning_mode='po_then_transfer',skip_12441_enabled=false WHERE id=1`);
  await query(`INSERT INTO inventory_items(item_id,item_name,stock_unit,to_plt,item_weight,vendor_id,vendor)
    VALUES($1,$2,'SQFT',$3,30.94,$4,'Inbound Vendor')`, [itemId,itemName,conversion,vendorId]);
  await query(`INSERT INTO scm_smart_item_policies(item_id,item_name,stock_unit,to_plt,pallet_weight_lbs,
    vendor,plant,planning_enabled,inactive,discontinued,lead_time_days)
    VALUES($1,$2,'SQFT',$3,3165.162,'Inbound Vendor','Inbound Yard',true,false,false,7)`, [itemId,itemName,conversion]);
  await query(`INSERT INTO scm_smart_item_yard_policies(item_id,location_id,yard_code,eligible,capacity_pallets,
    service_quantile,minimum_safety_pallets) VALUES($1,1,'3445',true,160,0.9,2),($1,15,'12441',true,160,0.9,2)`, [itemId]);
  await query(`INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_order,quantity_backordered)
    VALUES($1,1,'3445',0,74679,1048.66),($1,15,'12441',0,0,0)`, [itemId]);
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status_text,destination_location_id,is_blanket_po,netsuite_active)
    VALUES($1,'POB-INBOUND-PARENT','Purchase Order : Pending Receipt',1,$2,true)`, [parentId,blanket]);
  const line = await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,
    quantity,unit,to_plt,location_id,netsuite_active) VALUES($1,701,$2,$3,$3,74679,'SQFT',$4,1,true) RETURNING id`,
  [parentId,itemId,itemName,conversion]);
  return { parentLineId: Number(line.rows[0].id) };
}

export async function child(f, { ref, quantity = 2455.2, locationId = 1, receipt = 'not_received',
  baseline = 0, latest = 0, pallets = 0, layers = 0, sections = 0, pieces = 0, sales = 0,
  confirmed = true, active = true, closed = false, status = 'Purchase Order : Pending Receipt', splitStatus = 'active' } = {}) {
  const id = -(892010000 + ++sequence);
  const splitRef = ref || `INBOUND-SPLIT-${sequence}`;
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status_text,destination_location_id,receipt_status,netsuite_active,received_at)
    VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $5 IN ('received','partial_received') THEN now() ELSE NULL END)`, [id,splitRef,status,locationId,receipt,active]);
  const line = await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,
    quantity,unit,to_plt,to_lyr,to_sec,to_pcs,location_id,netsuite_active,netsuite_closed,
    netsuite_received_baseline_qty,netsuite_received_qty,received_pallet_qty,received_layer_qty,
    received_section_qty,received_piece_qty,received_sales_qty,confirmed_at)
    VALUES($1,701,$2,$3,$3,$4,'SQFT',$5,10,2,1,$6,true,$7,$8,$9,$10,$11,$12,$13,$14,
      CASE WHEN $15 THEN now() ELSE NULL END) RETURNING id`,
  [id,itemId,itemName,quantity,conversion,locationId,closed,baseline,latest,pallets,layers,sections,pieces,sales,confirmed]);
  const lineId = Number(line.rows[0].id);
  const split = await query(`INSERT INTO dispatch_scm_po_splits(source_po_id,source_po_ref,split_po_id,split_po_ref,status)
    VALUES($1,'POB-INBOUND-PARENT',$2,$3,$4) RETURNING id`, [parentId,id,splitRef,splitStatus]);
  await query(`INSERT INTO dispatch_scm_po_split_lines(split_id,source_line_id,split_line_id,item_id,sales_qty)
    VALUES($1,$2,$3,$4,$5)`, [split.rows[0].id,f.parentLineId,lineId,itemId,quantity]);
  return { id,lineId,ref:splitRef };
}

export async function completed(ref, kind = 'PO') {
  await query(`INSERT INTO dispatch_order_completion_events(order_kind,order_ref,dispatch_completed_at,
    completion_evidence_type,completion_evidence_id) VALUES($1,$2,now(),'driver_job',$3)`, [kind,ref,`inbound-${++sequence}`]);
}

export async function phaseRun() {
  return Number((await query(`INSERT INTO scm_smart_planning_runs(status,plan_kind,planning_phase,settings_snapshot)
    SELECT 'ready','inventory','po_pending_approval',to_jsonb(settings) FROM scm_smart_settings settings WHERE id=1 RETURNING id`)).rows[0].id);
}

export async function vendorProposal(runId) {
  const proposal = (await query(`INSERT INTO scm_smart_proposals(run_id,proposal_key,proposal_type,phase,source_kind,
    source_name,destination_location_id,destination_name,vendor,status)
    VALUES($1,'inbound-alternatives','PO','direct_vendor','vendor','Inbound Vendor',1,'3445','Inbound Vendor','order_requested') RETURNING id`, [runId])).rows[0];
  await query(`INSERT INTO inventory_items(item_id,item_name,vendor_id,vendor) VALUES($1,'INBOUND-ORIGINAL',$2,'Inbound Vendor')`, [itemId+10,vendorId]);
  const line = (await query(`INSERT INTO scm_smart_proposal_lines(proposal_id,item_id,item_name,destination_location_id,destination_name,to_plt)
    VALUES($1,$2,'INBOUND-ORIGINAL',1,'3445',102.3) RETURNING id`, [proposal.id,itemId+10])).rows[0];
  return { id:Number(proposal.id),lineId:Number(line.id) };
}

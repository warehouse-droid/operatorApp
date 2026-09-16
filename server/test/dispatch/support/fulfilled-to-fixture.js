import { query } from "../../../src/db.js";
export async function seedTransfer(id, ref, { status = "G", receivingStatus = "not_received", scheduleStatus = "Completed", updatedBy = "reconciliation" } = {}) {
  const labels = { B: "Pending Fulfillment", D: "Partially Fulfilled", E: "Pending Receipt/Partially Fulfilled", F: "Pending Receipt", G: "Received", H: "Closed", C: "Rejected" };
  await query(`INSERT INTO transfer_orders (netsuite_id,tranid,status,status_text,netsuite_active,from_location_id,from_location,to_location_id,to_location,
    outbound_operator_status,receiving_status,local_yard_order_status,fulfillment_status,synced_at)
    VALUES ($1,$2,$3,$4,true,1,'3445',15,'12441','open',$5,'Open','not_fulfilled',now())`, [id, ref, status, `Transfer Order : ${labels[status]}`, receivingStatus]);
  await query(`INSERT INTO transfer_order_lines (line_stage,id,transfer_order_id,line_id,item_id,item_name,sku,item_type,quantity,unit,pallet_qty,to_plt,netsuite_active)
    SELECT stage,$1,$1,1,827159900,'Transfer cargo','TO-CLEANUP-TEST','InvtPart',40,'EA',4,10,true FROM unnest(ARRAY['outbound','receiving']) stage`, [id]);
  await query(`INSERT INTO scm_transport_schedule (order_kind,source_table,source_id,order_ref,method,status,updated_by,created_by)
    VALUES ('TO','transfer_orders',$1,$2,'MBT',$3,$4,$4)`, [id, ref, scheduleStatus, updatedBy]);
  if (status === "G") {
    await query(`INSERT INTO scm_reconciliation_order_state (order_kind,source_order_netsuite_id,source_order_ref,application_status,reconciliation_status,reconciled_at)
      VALUES ('TO',$1,$2,'Completed','ok',now())`, [id, ref]);
    await query(`INSERT INTO dispatch_order_completion_events (order_kind,order_ref,dispatch_completed_at,completion_evidence_type,completion_evidence_id,actor_type,reason)
      VALUES ('TO',$1,now(),'reconciliation',$1,'system','Verified receipt fixture')`, [ref]);
  }
}

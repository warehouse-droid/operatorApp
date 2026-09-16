import { query, withTransaction } from "../../../src/db.js";

export const scenario = (run) => withTransaction(run, { rollback: true });

export async function seedSalesOrder(id, ref, { status = "F", active = true, method = "Delivery", yard = "Open" } = {}) {
  const labels = { B: "Pending Fulfillment", E: "Pending Billing/Partially Fulfilled", F: "Pending Billing", G: "Billed", H: "Closed" };
  await query(`INSERT INTO sales_orders (netsuite_id,tranid,customer,status,status_text,fulfillment_status,
    outbound_location_id,outbound_location,sales_order_type,operator_status,local_yard_order_status,
    dispatch_address,netsuite_active,synced_at)
    VALUES ($1,$2,'Fulfilled planning test',$3,$4,'not_fulfilled',1,'3445',$5,'open',$6,'Test Road',$7,now())`,
  [id, ref, status, `Sales Order : ${labels[status] || status}`, method, yard, active]);
  await query(`INSERT INTO sales_order_lines (id,sales_order_id,line_id,item_id,item_name,sku,quantity,unit,item_weight,pallet_qty,netsuite_active)
    VALUES ($1,$1,1,817159900,'Test cargo','FULFILLED-TEST',4,'EA',1,1,$2)`, [id, active]);
}

export async function completeDriver(ref, { stopType = "dropoff", status = "complete" } = {}) {
  await query(`INSERT INTO driver_job_records (job_id,driver_login,stop_type,order_refs,status,started_at,completed_at)
    VALUES ($1,'fulfilled-so-driver',$2,$3::jsonb,$4,now(),now())`,
  [`fulfilled-so-${ref}-${stopType}`, stopType, JSON.stringify([ref]), status]);
}

export async function splitSalesOrder(sourceId, sourceRef, childId, childRef, status = "active") {
  await query(`INSERT INTO dispatch_scm_so_splits (source_so_id,source_so_ref,split_so_id,split_so_ref,status,cancelled_at)
    VALUES ($1,$2,$3,$4,$5,CASE WHEN $5='cancelled' THEN now() ELSE NULL END)`,
  [sourceId, sourceRef, childId, childRef, status]);
}

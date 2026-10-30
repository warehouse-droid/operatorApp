// @ts-check
import {query} from './db.js';

/** @param {string} message */
function invalid(message) {
  return Object.assign(new Error(message),{code:'DIRECT_PO_IR_EVIDENCE_INVALID',status:409,postingNotAttempted:true});
}

/** Read immutable pickup/delivery pairs by numeric PO identity, including renamed references.
 * @param {Record<string,any>} job
 * @returns {Promise<Record<string,any>[]>}
 */
export async function readAllocatedPoReceiptEvidence(job) {
  /** @type {Record<string,any>[]} */
  const rows=(await query(`SELECT delivered.id,delivered.allocation_id,delivered.po_line_id,
      delivered.allocated_sales_qty,delivered.allocation_snapshot,
      pickup.id AS pickup_id,pickup.allocated_sales_qty AS picked_quantity,pickup.driver_job_id AS pickup_job_id,
      delivery.job_id AS delivery_job_id,delivery.photo_data_urls,
      allocation.status AS allocation_status,allocation.item_id,line.item_id AS current_item_id,
      line.netsuite_active,line.quantity AS ordered_quantity,
      claim.job_id AS claimed_by,
      (pickup.po_line_id=delivered.po_line_id AND pickup.sales_line_id=delivered.sales_line_id
        AND pickup.plan_id IS NOT DISTINCT FROM delivered.plan_id AND pickup.load_id=delivered.load_id
        AND picked.status='complete' AND picked.stop_type='pickup' AND picked.completed_at<=delivery.completed_at
        AND delivery.status='complete' AND delivery.stop_type='dropoff' AND delivery.completed_at IS NOT NULL
        AND delivery.plan_id IS NOT DISTINCT FROM delivered.plan_id AND delivery.load_id=delivered.load_id
        AND NOT EXISTS(SELECT 1 FROM driver_job_corrections correction WHERE correction.action='reopen'
          AND (correction.job_id=delivery.job_id OR correction.result->'physicalVisitJobIds' ? delivery.job_id)
          AND correction.created_at>=delivery.completed_at)
        AND NOT EXISTS(SELECT 1 FROM driver_job_corrections correction WHERE correction.action='reopen'
          AND (correction.job_id=picked.job_id OR correction.result->'physicalVisitJobIds' ? picked.job_id)
          AND correction.created_at>=picked.completed_at)) AS valid_route
    FROM dispatch_so_po_allocation_execution_events delivered
    JOIN purchase_order_lines line ON line.id=delivered.po_line_id AND line.purchase_order_id=$1
    JOIN dispatch_so_po_allocations allocation ON allocation.id=delivered.allocation_id
      AND allocation.po_line_id=line.id AND allocation.po_order_id=line.purchase_order_id
    JOIN driver_job_records delivery ON delivery.id=delivered.driver_job_record_id AND delivery.job_id=delivered.driver_job_id
    LEFT JOIN dispatch_so_po_allocation_execution_events pickup
      ON pickup.id::text=delivered.allocation_snapshot->>'pickupExecutionEventId'
      AND pickup.phase='pickup' AND pickup.allocation_id=delivered.allocation_id
    LEFT JOIN driver_job_records picked ON picked.id=pickup.driver_job_record_id AND picked.job_id=pickup.driver_job_id
    LEFT JOIN dispatch_direct_po_ir_allocation_claims claim ON claim.allocation_id=delivered.allocation_id
    WHERE delivered.phase='delivered' AND delivered.driver_job_record_id=$2
    ORDER BY delivered.id`,[job.local_po_id,job.delivery_job_record_id])).rows;
  if(!rows.length) {throw invalid('Exact allocation pickup and delivery evidence is unavailable.');}
  for(const row of rows) {
    if(!row.valid_route || row.allocation_status!=='active' || !row.netsuite_active
      || Number(row.item_id)!==Number(row.current_item_id)
      || !Number.isFinite(Number(row.allocated_sales_qty)) || Number(row.allocated_sales_qty)<=0
      || Number(row.allocated_sales_qty)!==Number(row.picked_quantity)
      || Number(row.allocation_snapshot.allocatedSalesQty)!==Number(row.allocated_sales_qty)
      || String(row.allocation_snapshot.poLineId)!==String(row.po_line_id)) {
      throw invalid('The allocation quantity, item, or pickup and delivery evidence changed.');
    }
  }
  return rows.filter(row=>!row.claimed_by || row.claimed_by===job.id);
}

/** Reserve each physical allocation exactly once across all delivery jobs.
 * @param {Record<string,any>} job @param {Record<string,any>[]} rows
 */
export async function claimAllocatedPoReceiptEvidence(job,rows) {
  /** @type {Record<string,number>} */
  const quantities={};
  for(const row of rows) {
    const claimed=await query(`INSERT INTO dispatch_direct_po_ir_allocation_claims(allocation_id,job_id,execution_event_id,quantity)
      VALUES($1,$2,$3,$4) ON CONFLICT(allocation_id) DO NOTHING RETURNING job_id`,
    [row.allocation_id,job.id,row.id,row.allocated_sales_qty]);
    if(!claimed.rowCount && row.claimed_by!==job.id) {
      throw Object.assign(invalid('This allocation is already owned by another receipt job.'),{code:'OPERATOR_NETSUITE_POSTING_ORDER_CLAIMED'});
    }
    const key=String(row.po_line_id);
    quantities[key]=Number(((quantities[key]||0)+Number(row.allocated_sales_qty)).toFixed(6));
    if(quantities[key]>Number(row.ordered_quantity)+0.000001) {throw invalid('Allocated receipt quantity exceeds the PO line.');}
  }
  return quantities;
}

/** Last check before the remote mutation; recovery of an already saved IR uses its retained payload.
 * @param {Record<string,any>} step
 */
export async function assertAllocatedPoReceiptCurrent(step) {
  const ids=[...new Set((step.lineSnapshot||[]).map((/** @type {any} */ line)=>line.directReceiptJobId).filter(Boolean))];
  if(!ids.length) {return;}
  if(ids.length!==1) {throw invalid('One direct receipt must have one allocation job.');}
  const job=(await query('SELECT * FROM dispatch_direct_po_ir_jobs WHERE id=$1 AND allocation_scoped',[ids[0]])).rows[0];
  if(!job) {throw invalid('The allocation receipt job is unavailable.');}
  const rows=await readAllocatedPoReceiptEvidence(job);
  /** @type {Record<string,any>[]} */
  const expected=(await query('SELECT execution_event_id FROM dispatch_direct_po_ir_allocation_claims WHERE job_id=$1',[job.id])).rows;
  if(!expected.length || expected.some(row=>!rows.some(value=>String(value.id)===String(row.execution_event_id)))) {
    throw invalid('The receipt no longer has all its claimed delivery evidence.');
  }
}

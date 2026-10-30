// @ts-check
import {query} from '../db.js';
import {binWorkflowError} from './bin-order-workflow-repository.js';

/** All work on this rental must finish before its final Collection can be planned.
 * @param {string} kind @param {any[]} work */
export function finalCollectionHold(kind,work) {
  if (kind!=='collection') {return null;}
  const references=[...new Set(work.filter(row=>row.order_status!=='cancelled'
    && !['completed','cancelled'].includes(row.status)).map(row=>String(row.reference)))];
  if (!references.length) {return null;}
  return {references,reason:`Waiting for delivery and exchange work to complete: ${references.join(', ')}.`};
}

/** Existing assigned/started work retains its execution history.
 * @param {string} kind @param {string} serviceLineId @param {any} visit */
export async function readFinalCollectionHold(kind,serviceLineId,visit) {
  if (kind!=='collection' || !serviceLineId || visit.dispatch_plan_id || visit.actual_started_at
      || ['completed','cancelled'].includes(visit.status)) {return null;}
  const {rows}=await query(`SELECT root.status AS order_status,
      COALESCE(child.status,root.status) AS status,COALESCE(p.display_reference,o.display_reference) AS reference
    FROM mbt_bin_orders o JOIN mbt_service_visits root ON root.service_visit_id=o.order_id
    LEFT JOIN mbt_bin_order_parts p ON p.order_id=o.order_id
    LEFT JOIN mbt_service_visits child ON child.service_visit_id=p.visit_id
    WHERE o.service_line_id=$1 AND o.order_kind IN ('delivery','exchange')
    ORDER BY o.exchange_number,o.display_reference,p.part_role`,[serviceLineId]);
  return finalCollectionHold(kind,rows);
}

/** Called inside the planner's existing transaction and fleet fence.
 * @param {any} visit */
export async function assertFinalCollectionReady(visit) {
  const hold=await readFinalCollectionHold(visit.service_snapshot?.binWorkflow?.kind,visit.service_line_id,visit);
  if (hold) {throw binWorkflowError(409,hold.reason,'MBT_BIN_COLLECTION_WAITING');}
}

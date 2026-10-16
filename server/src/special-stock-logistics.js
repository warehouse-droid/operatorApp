import { query } from './db.js';

/** Read completed physical visits for exact linked references in one scoped query.
 * @param {number[]} requestIds */
export async function readSpecialDriverProgress(requestIds) {
  if (!requestIds.length) return new Map();
  const result = await query(`WITH refs AS MATERIALIZED (
    SELECT special.request_id,'SO'::text AS kind,special.sales_order_ref AS reference
      FROM sales_special_stock_cases special WHERE special.request_id=ANY($1::bigint[])
    UNION SELECT special.request_id,'PO',special.purchase_order_ref
      FROM sales_special_stock_cases special WHERE special.request_id=ANY($1::bigint[])
    UNION SELECT special.request_id,'PO',purchase.dispatch_ref
      FROM sales_special_stock_cases special JOIN purchase_orders purchase ON purchase.netsuite_id=special.purchase_order_netsuite_id
      WHERE special.request_id=ANY($1::bigint[])
  ), visits AS MATERIALIZED (
    SELECT job.stop_type,job.completed_at,job.order_refs,job.job_details FROM driver_job_records job
      WHERE job.status='complete' AND job.stop_type IN ('pickup','dropoff') AND job.completed_at IS NOT NULL
        AND job.order_refs ?| ARRAY(SELECT reference FROM refs WHERE NULLIF(btrim(reference),'') IS NOT NULL)
  ) SELECT refs.request_id,
      max(visits.completed_at) FILTER (WHERE refs.kind='SO' AND visits.stop_type='pickup') AS sales_pickup_at,
      max(visits.completed_at) FILTER (WHERE refs.kind='PO' AND visits.stop_type='pickup') AS purchase_pickup_at,
      max(visits.completed_at) FILTER (WHERE refs.kind='PO' AND visits.stop_type='dropoff') AS purchase_dropoff_at
    FROM refs JOIN visits ON visits.order_refs ? refs.reference
      AND dispatch_completion_driver_order_kind(refs.reference,visits.job_details)=refs.kind
    GROUP BY refs.request_id`, [requestIds]);
  return new Map(result.rows.map(/** @param {Record<string,any>} row */ row => [Number(row.request_id),row]));
}

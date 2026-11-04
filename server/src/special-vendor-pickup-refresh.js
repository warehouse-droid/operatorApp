import { query } from './db.js';
import { getSpecialStockCasesByIds } from './special-stock-request-repository.js';
import { refreshSpecialOrderStatusCache } from './special-stock-status-refresh.js';

/** Customer pickup at a vendor yard produces no MBBS dispatch, receipt or local
 * pickup event, so an open request depends on its linked SO status alone. */
export async function listOpenSpecialVendorPickupRequestIds() {
  const result = await query(`SELECT special.request_id
      FROM sales_special_stock_cases special
      JOIN sales_stock_requests request ON request.id=special.request_id
      LEFT JOIN special_stock_completion_evidence completion ON completion.request_id=special.request_id
     WHERE special.workflow_kind='special' AND special.fulfillment_method='vendor_pickup'
       AND special.close_status='active' AND request.status<>'cancelled'
       AND special.sales_order_netsuite_id IS NOT NULL AND NOT special.sales_order_skipped
       AND completion.completed IS NOT TRUE
     ORDER BY special.request_id`);
  return result.rows.map(row => Number(row.request_id));
}

/** Nightly step of the aggregate reconciliation: force-refresh the linked SO/PO
 * statuses of every open Special vendor pickup so a fulfilled or billed SO completes it.
 * @param {{listIds?:()=>Promise<number[]>,loadCases?:(ids:number[])=>Promise<Record<string,any>[]>,
 *   refresh?:(details:Record<string,any>[],options:{force:boolean})=>Promise<{attempted:number,updated:number,failed:number}>,
 *   listCompleted?:(ids:number[])=>Promise<number[]>,batchSize?:number,logger?:{error:(...args:any[])=>void}}} [dependencies] */
export async function refreshOpenSpecialVendorPickupOrders({
  listIds = listOpenSpecialVendorPickupRequestIds,
  loadCases = ids => getSpecialStockCasesByIds(ids, { audience: 'scm' }),
  refresh = refreshSpecialOrderStatusCache,
  listCompleted = completedRequestIds,
  batchSize = 50,
  logger = console
} = {}) {
  const ids = await listIds();
  const result = { requests: ids.length, attempted: 0, updated: 0, failed: 0, completedRequestIds: /** @type {number[]} */ ([]) };
  for (let index = 0; index < ids.length; index += batchSize) {
    const batch = ids.slice(index, index + batchSize);
    try {
      const outcome = await refresh(await loadCases(batch), { force: true });
      result.attempted += outcome.attempted; result.updated += outcome.updated; result.failed += outcome.failed;
    } catch (error) {
      result.failed += batch.length;
      logger.error('Nightly Special vendor pickup refresh failed', batch, String(error instanceof Error ? error.message : error));
    }
  }
  if (ids.length) result.completedRequestIds = await listCompleted(ids);
  return result;
}

/** @param {number[]} ids */
async function completedRequestIds(ids) {
  const result = await query(`SELECT request_id FROM special_stock_completion_evidence
    WHERE request_id=ANY($1::bigint[]) AND completed ORDER BY request_id`, [ids]);
  return result.rows.map(row => Number(row.request_id));
}

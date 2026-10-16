import { config } from './config.js';
import { query, withTransaction } from './db.js';
import { writeAudit } from './auth-repository.js';
import { enqueueNetSuiteMirrorOrderEvent } from './netsuite-mirror-repository.js';
import { fetchTransactionStatusesFromNetSuite } from './netsuite.js';

const MAX_AGE_MS = 5 * 60 * 1000;
const kinds = [
  { prefix: 'salesOrder', orderType: 'sales_order', recordType: 'SalesOrd', table: 'sales_orders', link: 'sales_order_netsuite_id' },
  { prefix: 'purchaseOrder', orderType: 'purchase_order', recordType: 'PurchOrd', table: 'purchase_orders', link: 'purchase_order_netsuite_id' }
];

/** @param {Record<string,any>} row */
export function specialOrderStatusFields(row) {
  const canonical = row.canonical_sales_status_text || row.canonical_sales_status;
  return {
    salesOrderStatus: canonical || row.sales_order_status || null,
    salesOrderApproved: canonical ? row.canonical_sales_active !== false
      && !['A', 'C', 'H'].includes(row.canonical_sales_status)
      && !/pending approval|closed|cancel/i.test(canonical) : row.sales_order_approved === true,
    salesOrderStatusSyncedAt: row.canonical_sales_synced_at || null,
    purchaseOrderReceiptStatus: row.canonical_purchase_receipt_status || null,
    purchaseOrderReceivedAt: row.canonical_purchase_received_at || null,
    purchaseOrderStatusSyncedAt: row.canonical_purchase_synced_at || null
  };
}

/** @param {unknown} value */
function identity(value) {
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** @param {Record<string,any>[]} details @param {string} prefix @param {Date} now @param {boolean} force */
function staleOrders(details, prefix, now, force) {
  /** @type {Map<number,{netsuiteOrderId:number,tranid:string,syncedAt:any}>} */
  const orders = new Map();
  for (const detail of details) {
    if (detail.salesOrderSkipped || detail.purchaseOrderSkipped) continue;
    const id = identity(detail[prefix + 'Id']), tranid = detail[prefix + 'Ref'];
    const syncedAt = detail[prefix + 'StatusSyncedAt'];
    const age = Number(now) - (syncedAt ? new Date(syncedAt).getTime() : NaN);
    if (!id || typeof tranid !== 'string' || !tranid.trim() || (!force && age >= 0 && age < MAX_AGE_MS)) continue;
    orders.set(id, { netsuiteOrderId: id, tranid, syncedAt: syncedAt && Number.isFinite(new Date(syncedAt).getTime()) ? syncedAt : null });
  }
  return [...orders.values()];
}

/** @param {any} row @param {{netsuiteOrderId:number,tranid:string}} order */
function verifiedStatus(row, order) {
  return row && identity(row.id) === order.netsuiteOrderId && row.tranid === order.tranid
    && typeof row.status === 'string' && /^[A-H]$/.test(row.status)
    && typeof row.status_text === 'string' && row.status_text.trim().length > 0
    && row.status_text.length <= 200 && !/[\u0000-\u001f\u007f]/.test(row.status_text);
}

/** @param {{orderType:string,netsuiteOrderId:number,tranid:string,status:string,statusText:string,syncedAt:any}} observation */
export async function persistSpecialOrderStatusObservation(observation) {
  const kind = kinds.find(value => value.orderType === observation.orderType);
  if (!kind || !verifiedStatus({ id: observation.netsuiteOrderId, tranid: observation.tranid,
    status: observation.status, status_text: observation.statusText }, observation)) throw Error('Invalid Special order status observation.');
  return withTransaction(async () => {
    const result = await query(`UPDATE ${kind.table} header
      SET status=$2, status_text=$3, synced_at=now(),
          status_updated_at=CASE WHEN status IS DISTINCT FROM $2 OR status_text IS DISTINCT FROM $3 THEN now() ELSE status_updated_at END
      WHERE netsuite_id=$1 AND tranid=$5 AND synced_at IS NOT DISTINCT FROM $4::timestamptz
        AND EXISTS (SELECT 1 FROM sales_special_stock_cases special WHERE special.${kind.link}=header.netsuite_id)
      RETURNING netsuite_id`, [observation.netsuiteOrderId, observation.status, observation.statusText, observation.syncedAt, observation.tranid]);
    if (!result.rowCount) return false;
    await enqueueNetSuiteMirrorOrderEvent(kind.orderType, observation.netsuiteOrderId, { changeType: 'status' });
    await writeAudit({ actorType: 'system', source: 'special-stock-request', action: 'special.order_status.refreshed',
      orderId: /** @type {any} */ (observation.netsuiteOrderId), details: { orderType: kind.orderType, tranid: observation.tranid,
        status: observation.status, statusText: observation.statusText } });
    return true;
  });
}

/** @param {{now?:()=>Date,fetchStatuses?:(ids:number[],type:string)=>Promise<any[]>,
 * persist?:(observation:any)=>Promise<boolean>,logger?:{error:(...args:any[])=>void}}} dependencies */
export function createSpecialOrderStatusCache(dependencies = {}) {
  const { now = () => new Date(), fetchStatuses = fetchTransactionStatusesFromNetSuite,
    persist = persistSpecialOrderStatusObservation, logger = console } = dependencies;
  /** @param {Record<string,any>[]} details @param {{force?:boolean}} options */
  return async (details, { force = false } = {}) => {
    const result = { attempted: 0, updated: 0, failed: 0 };
    for (const kind of kinds) {
      const orders = staleOrders(details, kind.prefix, now(), force);
      if (!orders.length) continue;
      result.attempted += orders.length;
      let rows;
      try { rows = await fetchStatuses(orders.map(order => order.netsuiteOrderId), kind.recordType); }
      catch (error) { result.failed += orders.length; logger.error('Special order status refresh failed', kind.orderType, String(error instanceof Error ? error.message : error)); continue; }
      for (const order of orders) {
        const matches = Array.isArray(rows) ? rows.filter(row => identity(row?.id) === order.netsuiteOrderId) : [];
        if (matches.length !== 1 || !verifiedStatus(matches[0], order)) {
          result.failed++; logger.error('Special order status response is missing or invalid', kind.orderType, order.netsuiteOrderId); continue;
        }
        try {
          if (await persist({ orderType: kind.orderType, ...order, status: matches[0].status, statusText: matches[0].status_text })) result.updated++;
        } catch (error) { result.failed++; logger.error('Special order status persistence failed', kind.orderType, String(error instanceof Error ? error.message : error)); }
      }
    }
    return result;
  };
}

const refresh = createSpecialOrderStatusCache();
/** @param {Record<string,any>[]} details @param {{force?:boolean}} options */
export function refreshSpecialOrderStatusCache(details, options = {}) {
  return config.netsuite?.directAccessEnabled ? refresh(details, options) : Promise.resolve({ attempted: 0, updated: 0, failed: 0 });
}

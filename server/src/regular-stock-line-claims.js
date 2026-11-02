// @ts-check
import {query} from './db.js';
import {classifyRegularStockLineClaim} from './regular-stock-line-claim-domain.js';

/**
 * @typedef {import('./regular-stock-line-claim-domain.js').LineClaim & import('./regular-stock-line-claim-domain.js').ClaimState & {
 *   requestedBy:string,destinationLocationId:number,regular:Record<string,any>,materialLineIds:number[]}} SalesOrderLineClaim
 */

const positive = (/** @type {unknown} */ value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

/**
 * Active line claims on one SO, classified from our webhook-synced SO lines,
 * request lines, local TO records and the TO mirror.
 * @param {number} salesOrderId @returns {Promise<SalesOrderLineClaim[]>}
 */
export async function loadSalesOrderLineClaims(salesOrderId) {
  const owners = (await query(`SELECT o.remote_line_id,o.request_id,o.item_id,r.request_ref,r.status,r.requested_by,
      r.destination_location_id,r.regular_details,h.plan,sol.id AS current_line_id,sol.item_id AS current_item_id,
      sol.netsuite_active AS current_line_active
    FROM regular_stock_so_line_owners o
    JOIN sales_stock_requests r ON r.id=o.request_id
    LEFT JOIN regular_stock_handoffs h ON h.request_id=o.request_id
    LEFT JOIN sales_order_lines sol ON sol.sales_order_id=o.sales_order_id AND sol.line_id=o.remote_line_id
    WHERE o.sales_order_id=$1 AND o.released_at IS NULL
    ORDER BY o.remote_line_id,o.request_id`, [salesOrderId])).rows;
  if (!owners.length) return [];
  const requestIds = [...new Set(owners.map((/** @type {any} */ row) => Number(row.request_id)))];
  const lines = new Map((await query(`SELECT l.id,l.status,t.status AS transfer_status,
      COALESCE(t.netsuite_transfer_order_ref,t.transfer_ref) AS transfer_ref,t.id AS transfer_id,
      tor.status AS mirror_status,tor.status_text AS mirror_status_text
    FROM sales_stock_request_lines l
    LEFT JOIN sales_stock_transfer_lines tl ON tl.request_line_id=l.id
    LEFT JOIN sales_stock_transfers t ON t.id=tl.transfer_id
    LEFT JOIN transfer_orders tor ON tor.netsuite_id=t.netsuite_transfer_order_id
    WHERE l.request_id=ANY($1::bigint[])`, [requestIds])).rows.map((/** @type {any} */ row) => [Number(row.id), row]));
  return owners.map((/** @type {any} */ row) => {
    const remoteLineId = Number(row.remote_line_id);
    const plan = row.plan || {};
    const mappings = (plan.mappings || []).filter((/** @type {any} */ mapping) => Number(mapping.remoteLineId) === remoteLineId);
    const snapshot = (plan.order?.lines || []).find((/** @type {any} */ line) => Number(line.remoteLineId) === remoteLineId);
    const requestLines = [...new Set(mappings.map((/** @type {any} */ mapping) => Number(mapping.requestLineId)))]
      .map(id => lines.get(id)).filter(Boolean).map(line => ({id:Number(line.id), status:line.status,
        transfer:line.transfer_id ? {ref:line.transfer_ref, status:line.transfer_status,
          mirrorStatus:line.mirror_status, mirrorStatusText:line.mirror_status_text} : null}));
    const claim = {remoteLineId, requestId:Number(row.request_id), requestRef:row.request_ref, requestStatus:row.status,
      deliveryApproval:row.regular_details?.deliveryApproval ?? null,
      claimedItemId:positive(row.item_id) ?? positive(mappings[0]?.itemId) ?? positive(snapshot?.itemId),
      currentItemId:row.current_line_id ? positive(row.current_item_id) : null,
      currentLineActive:row.current_line_id ? row.current_line_active !== false : null,
      lines:requestLines};
    return {...claim, ...classifyRegularStockLineClaim(claim), requestedBy:row.requested_by,
      destinationLocationId:Number(row.destination_location_id), regular:row.regular_details || {},
      materialLineIds:(plan.materialLineIds || []).map(Number)};
  });
}

/**
 * Take ownership of SO lines for a new request. Run under the SO advisory lock
 * after rejecting live claims; any remaining active claim on a line is spent
 * and is released with the evidence that freed it.
 * @param {number} salesOrderId @param {number} requestId
 * @param {{remoteLineId:number,itemId:number}[]} lines @param {SalesOrderLineClaim[]} claims
 */
export async function claimSalesOrderLines(salesOrderId, requestId, lines, claims) {
  const released = [];
  for (const line of lines) {
    for (const claim of claims.filter(entry => entry.remoteLineId === line.remoteLineId)) {
      if (claim.live) throw Error(`SO line ${line.remoteLineId} is still claimed by ${claim.requestRef}.`);
      const evidence = {reason:claim.reason, requestRef:claim.requestRef, claimedItemId:claim.claimedItemId,
        currentItemId:claim.currentItemId, transfers:claim.transfers};
      await query(`UPDATE regular_stock_so_line_owners SET released_at=now(),released_by_request_id=$4,release_evidence=$5::jsonb
        WHERE sales_order_id=$1 AND remote_line_id=$2 AND request_id=$3 AND released_at IS NULL`,
      [salesOrderId, line.remoteLineId, claim.requestId, requestId, JSON.stringify(evidence)]);
      released.push({remoteLineId:line.remoteLineId, previousRequestId:claim.requestId, ...evidence});
    }
    await query(`INSERT INTO regular_stock_so_line_owners(sales_order_id,remote_line_id,request_id,item_id) VALUES($1,$2,$3,$4)`,
      [salesOrderId, line.remoteLineId, requestId, line.itemId]);
  }
  return released;
}

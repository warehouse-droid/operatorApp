// @ts-check
import {regularError} from './regular-stock-domain.js';

/**
 * A regular stock request claims individual SO lines. A claim keeps blocking
 * new Delivery requests for its line only while it still describes real,
 * outstanding work: the SO line still holds the claimed item, the request was
 * not cancelled or rejected, and at least one of its TOs for that line is not
 * closed, cancelled or rejected. All inputs come from webhook-synced rows in
 * our database, never from a live NetSuite read.
 *
 * @typedef {{ref:string|null,status:string|null,mirrorStatus?:string|null,mirrorStatusText?:string|null}} ClaimTransfer
 * @typedef {{id:number,status:string,transfer:ClaimTransfer|null}} ClaimRequestLine
 * @typedef {{remoteLineId:number,requestId:number,requestRef:string,requestStatus:string,deliveryApproval?:string|null,
 *   claimedItemId:number|null,currentItemId:number|null,currentLineActive:boolean|null,lines:ClaimRequestLine[]}} LineClaim
 * @typedef {{live:boolean,reason:string,transfers:{ref:string|null,status:string|null}[]}} ClaimState
 */

// A request line without a TO is finished in these states; its claim is spent.
const FINISHED_LINE_STATUSES = new Set(['rejected', 'cancelled', 'closed', 'fulfilled']);

/** Closed, cancelled or rejected TOs no longer cover their SO lines.
 * The mirror status is checked as well, in case the request projection lags.
 * @param {ClaimTransfer} transfer @returns {'closed'|'cancelled'|'rejected'|null} */
export function releasedTransferState(transfer) {
  if (transfer.status === 'closed' || transfer.status === 'cancelled') return transfer.status;
  const status = String(transfer.mirrorStatus || '').trim();
  const code = status.replace(/^TrnfrOrd:/i, '').toUpperCase();
  const text = `${status} ${String(transfer.mirrorStatusText || '')}`;
  if (code === 'H' || /\bclosed\b/i.test(text)) return 'closed';
  if (code === 'C' || /\brejected\b/i.test(text)) return 'rejected';
  if (/\bcancel(?:led)?\b/i.test(text)) return 'cancelled';
  return null;
}

/** @param {LineClaim} claim @returns {ClaimState} */
export function classifyRegularStockLineClaim(claim) {
  const transfers = claim.lines.filter(line => line.transfer)
    .map(line => ({ref:line.transfer?.ref ?? null, status:line.transfer ? releasedTransferState(line.transfer) || line.transfer.status : null}));
  const released = (/** @type {string} */ reason) => ({live:false, reason, transfers});
  if (claim.requestStatus === 'cancelled') return released('request_cancelled');
  if (claim.deliveryApproval === 'rejected') return released('request_rejected');
  if (claim.currentLineActive === false) return released('so_line_removed');
  if (claim.claimedItemId && claim.currentItemId && Number(claim.claimedItemId) !== Number(claim.currentItemId)) return released('item_changed');
  // Unknown mappings keep the claim: blocking is safer than a duplicate TO.
  if (!claim.lines.length) return {live:true, reason:'unmapped', transfers};
  const open = claim.lines.filter(line => line.transfer
    ? !releasedTransferState(line.transfer) : !FINISHED_LINE_STATUSES.has(line.status));
  if (open.length) return {live:true, reason:open.some(line => line.transfer) ? 'transfer_open' : 'transfer_pending', transfers};
  return released(claim.lines.every(line => line.transfer) ? 'transfer_closed' : 'request_line_finished');
}

/** Lines a Delivery would select by default: backordered material lines at Base Yard.
 * @param {{lines?:{remoteLineId:number,ancillary?:boolean,closed?:boolean,backorderedQuantity?:number|null,locationId:number}[]}} order
 * @param {number} destination */
export function backorderedDeliveryLineIds(order, destination) {
  return (order?.lines || []).filter(line => !line.ancillary && !line.closed
    && Number(line.backorderedQuantity) > 0 && line.locationId === destination).map(line => line.remoteLineId);
}

const statusLabel = (/** @type {string|null} */ status) => String(status || '').replaceAll('_', ' ');

/** @param {LineClaim & ClaimState} claim */
export function describeLineClaim(claim) {
  const open = claim.transfers.filter(transfer => !['closed', 'cancelled', 'rejected'].includes(String(transfer.status)));
  if (!open.length) return `${claim.requestRef} (TO not created yet)`;
  return `${claim.requestRef} (${open.map(transfer => `${transfer.ref || 'TO'} ${statusLabel(transfer.status)}`).join(', ')})`;
}

/**
 * Reject selected lines that a live claim still covers.
 * @param {{ref:string,lines:{remoteLineId:number,itemId:number,itemName?:string}[]}} order
 * @param {number[]} lineIds
 * @param {(LineClaim & ClaimState)[]} claims
 * @param {(claim:LineClaim & ClaimState)=>boolean} isOwn same requester, route and Delivery workflow
 */
export function assertDeliveryLinesUnclaimed(order, lineIds, claims, isOwn) {
  const blocking = claims.filter(claim => claim.live && lineIds.includes(claim.remoteLineId));
  if (!blocking.length) return;
  const label = (/** @type {number} */ id) => {
    const line = order.lines.find(row => row.remoteLineId === id);
    return `${line?.itemName || line?.itemId || 'item'} (SO line ${id})`;
  };
  const detail = blocking.map(claim => `${label(claim.remoteLineId)} is already covered by ${describeLineClaim(claim)}`).join('; ');
  if (blocking.every(isOwn)) {
    throw regularError(`${order.ref}: ${detail}. Open that request to check progress, or select only the other lines.`, 'REGULAR_DELIVERY_SELECTION_CONFLICT');
  }
  throw regularError(`${order.ref}: ${detail}. Select other lines, or close or cancel that TO before requesting these lines again.`, 'REGULAR_SO_REUSED');
}

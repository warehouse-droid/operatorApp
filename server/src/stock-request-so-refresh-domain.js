// @ts-check
export const STOCK_REQUEST_SO_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
/** @typedef {Record<string,any>} Row */
/** @param {unknown} value */
function positiveId(value) {
  return /^(?:[1-9]\d*)$/.test(String(value)) && Number.isSafeInteger(Number(value));
}
/** @param {Row} line */
function observedLine(line) {
  const synthetic = Number.isSafeInteger(Number(line.item_id)) && Number(line.item_id)<0 && Number(line.quantity)===0;
  if (!positiveId(line.line_id) || !positiveId(line.item_id) && !synthetic || line.quantity === null || line.quantity === undefined || line.quantity === ''
    || !Number.isFinite(Number(line.quantity)) || line.netsuite_received_qty === null || line.netsuite_received_qty === undefined || line.netsuite_received_qty === ''
    || !Number.isFinite(Number(line.netsuite_received_qty)) || Number(line.netsuite_received_qty) < 0) {
    throw Error('NetSuite returned invalid or missing SO line progress.');
  }
  return { lineId:Number(line.line_id),itemId:Number(line.item_id),quantity:Math.abs(Number(line.quantity)),
    fulfilledQuantity:Number(line.netsuite_received_qty),itemType:String(line.item_type || '') };
}
/** Validate the read-only boundary before any local write. Header F/G is
 * authoritative even for non-inventory items; partial billing never is.
 * @param {{id:number,ref:string}} candidate @param {Row|null} remote */
export function stockRequestSalesOrderObservation(candidate, remote) {
  if (!remote || !positiveId(remote.id) || Number(remote.id) !== candidate.id || remote.tranid !== candidate.ref
    || !/^[A-H]$/.test(remote.status) || typeof remote.status_text !== 'string' || !remote.status_text.trim()
    || remote.status_text.length > 200 || /[\u0000-\u001f\u007f]/.test(remote.status_text)
    || !Array.isArray(remote.lines) || !remote.lines.length) throw Error('NetSuite SO progress is missing, invalid or does not match the linked order.');
  const lines = remote.lines.map(observedLine);
  if (new Set(lines.map(line=>line.lineId)).size !== lines.length) throw Error('NetSuite returned duplicate SO line identities.');
  const cargo = lines.filter(line=>line.quantity > 0 && !/^(?:OthCharge|Discount|Markup|Subtotal|Description|Payment|Service)$/i.test(line.itemType));
  const closed = ['C','H'].includes(remote.status);
  const completed = !closed && (['F','G'].includes(remote.status)
    || cargo.length > 0 && cargo.every(line=>line.fulfilledQuantity >= line.quantity));
  return {id:candidate.id,ref:candidate.ref,status:remote.status,statusText:remote.status_text.trim(),completed,
    terminal:closed || completed,fulfillmentStatus:completed?'fulfilled':cargo.some(line=>line.fulfilledQuantity>0)?'partial_fulfilled':'not_fulfilled',lines};
}

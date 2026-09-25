// @ts-check
// Successful local receipts are line-level completion evidence. Confirmed
// quantities are drafts and must never be used as receipt totals.
const CONFIRMED_FIELDS = ["received_pallet_qty", "received_layer_qty", "received_section_qty", "received_piece_qty", "received_sales_qty"];
const positive = (/** @type {unknown} */ value) => Math.max(Number(value) || 0, 0);
const round = (/** @type {number} */ value) => Math.round(value * 1e6) / 1e6;

/** @param {Function} runQuery @param {string|number} orderId */
export async function readReceivingReceiptProgress(runQuery, orderId) {
  const result = await runQuery(`SELECT id,item_receipt_id,payload,response,created_at
    FROM receiving_receipt_records WHERE order_id=$1
      AND receipt_status IN ('partial_received','received') ORDER BY created_at,id`, [orderId]);
  const lines = new Map();
  const seen = new Set();
  for (const record of result.rows) {
    const identity = record.item_receipt_id ? `ir:${record.item_receipt_id}`
      : record.response?.operatorNetSuitePosting?.commandId ? `command:${record.response.operatorNetSuitePosting.commandId}` : `record:${record.id}`;
    if (seen.has(identity)) {continue;}
    seen.add(identity);
    for (const item of record.payload?.item?.items || []) {
      if (item.itemReceive === false || item.itemreceive === false || positive(item.quantity) <= 0) {continue;}
      const key = String(item.orderLine);
      const previous = lines.get(key) || { quantity: 0, lastReceivedAt: null };
      lines.set(key, { quantity: round(previous.quantity + positive(item.quantity)), lastReceivedAt: record.created_at });
    }
  }
  return lines;
}

/** @param {Record<string,any>} line @param {Map<string,{quantity:number,lastReceivedAt:any}>} progress */
export function applyReceivingReceiptProgress(line, progress) {
  const receipt = progress.get(String(line.line_id));
  const received = positive(receipt?.quantity);
  const result = /** @type {Record<string,any>} */ ({ ...line, local_received_qty: received,
    receiving_completed_qty: Math.max(positive(line.netsuite_received_qty), positive(line.netsuite_received_baseline_qty) + received) });
  if (receipt && (!line.confirmed_at || new Date(line.confirmed_at) <= new Date(receipt.lastReceivedAt))) {
    for (const field of CONFIRMED_FIELDS) {result[field] = 0;}
  }
  return result;
}

/** @param {Record<string,any>} line @param {number} quantity */
export function receivingQuantityAfterReceipt(line, quantity) {
  const total = positive(line.original_quantity ?? line.quantity);
  const completed = Math.max(positive(line.netsuite_received_qty),
    positive(line.netsuite_received_baseline_qty) + positive(line.local_received_qty) + positive(quantity));
  return round(Math.max(total - completed, 0));
}

// Parent counters can lag a verified IR. Use its immutable posting evidence to
// omit completed static-sublist rows without adding live NetSuite calls.
/** @param {Function} runQuery @param {number} sourceId @param {Record<string,any>[]} rows */
export async function applyVerifiedPoReceiptProgress(runQuery, sourceId, rows) {
  const result = await runQuery(`SELECT step.netsuite_transaction_id,step.payload,
      command.input_snapshot->'lineReconciliation'->'lines' AS reconciliation
    FROM operator_netsuite_posting_steps step
    JOIN operator_netsuite_posting_commands command ON command.id=step.command_id
    WHERE step.source_order_kind='PO' AND step.source_netsuite_id=$1
      AND step.transaction_type='IR' AND step.status='posted' AND step.netsuite_transaction_id IS NOT NULL
    ORDER BY step.posted_at,step.id`, [sourceId]);
  const completed = verifiedPoReceiptTotals(sourceId, result.rows);
  return rows.map(row => ({ ...row, cached_completed_qty: Math.max(positive(row.cached_completed_qty),
    completed.get(String(row.source_line_key)) || 0) }));
}

/** @param {number} sourceId @param {Record<string,any>[]} receipts */
export function verifiedPoReceiptTotals(sourceId, receipts) {
  const completed = new Map();
  const seen = new Set();
  for (const receipt of receipts) {
    if (seen.has(String(receipt.netsuite_transaction_id))) {continue;}
    seen.add(String(receipt.netsuite_transaction_id));
    for (const line of receipt.reconciliation || []) {
      if (line.sourceOrderKind !== "PO" || String(line.sourceNetSuiteId) !== String(sourceId) || !line.sourceLineKey) {continue;}
      const posted = (receipt.payload?.item?.items || []).find((/** @type {Record<string,any>} */ item) => Number(item.orderLine) === Number(line.orderLine)
        && item.itemReceive !== false && item.itemreceive !== false);
      if (!posted || positive(posted.quantity) <= 0) {continue;}
      const key = String(line.sourceLineKey), previous = completed.get(key) || 0;
      const baseline = positive(line.completedQuantity);
      completed.set(key, round(line.authoritative === true
        ? Math.max(previous, baseline + positive(posted.quantity))
        : Math.max(previous, baseline) + positive(posted.quantity)));
    }
  }
  return completed;
}

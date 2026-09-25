// @ts-check
const positive = (/** @type {unknown} */ value) => Math.max(Number(value) || 0, 0);

/** @param {Function} runQuery @param {string|number} orderId */
export async function readReceivingPoSplitReservations(runQuery, orderId) {
  const result = await runQuery(`SELECT ledger.source_line_id, SUM(ledger.sales_qty) AS sales_qty
    FROM dispatch_scm_po_split_lines ledger
    JOIN dispatch_scm_po_splits split ON split.id = ledger.split_id
    JOIN purchase_order_lines source ON source.id = ledger.source_line_id
    WHERE split.source_po_id = $1 AND source.purchase_order_id = $1 AND split.status = 'active'
    GROUP BY ledger.source_line_id`, [orderId]);
  return new Map(result.rows.map((/** @type {{source_line_id:string|number,sales_qty:unknown}} */ row) =>
    [String(row.source_line_id), positive(row.sales_qty)]));
}

/** @param {Record<string,any>} line @param {Map<string,number>} reservations */
export function applyReceivingPoSplitReservations(line, reservations) {
  const reserved = reservations.get(String(line.id)) || 0;
  // A split owns its assigned capacity even after its child has been received.
  // The parent NetSuite counter can already include those child receipts, so
  // overlap recorded completion with reserved capacity instead of adding both.
  return { ...line, split_reserved_sales_qty: reserved,
    receiving_unavailable_qty: Math.max(positive(line.receiving_completed_qty),
      positive(line.netsuite_received_baseline_qty) + positive(line.local_received_qty) + reserved) };
}

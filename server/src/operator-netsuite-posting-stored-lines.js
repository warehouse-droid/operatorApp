// @ts-check

export const STORED_ORDER_LINE_STRATEGY = "stored_order_line_v1";

/** @param {string} message */
function unresolved(message) {
  return Object.assign(new Error(message), {
    status: 409, code: "OPERATOR_NETSUITE_POSTING_LINE_MAPPING_UNRESOLVED"
  });
}

/** @param {Record<string, any>[]} rows */
export function storedOperatorPostingLines(rows) {
  const seen = new Set();
  return rows.map(row => {
    const orderLine = Number(row.netsuite_order_line);
    const sourceLineKey = String(row.source_line_key || "");
    if (!sourceLineKey || !Number.isSafeInteger(orderLine) || orderLine <= 0 || seen.has(orderLine)) {
      throw unresolved("The stored NetSuite orderLine is missing or ambiguous. Refresh the order before posting.");
    }
    seen.add(orderLine);
    const quantity = Math.abs(Number(row.quantity || 0));
    const completed = Math.abs(Number(row.cached_completed_qty || 0));
    return {
      sourceLineKey,
      sourceLineAliases: [...new Set([sourceLineKey, row.local_line_key].filter(Boolean).map(String))],
      orderLine,
      itemId: Number(row.item_id),
      location: row.location_id === null || row.location_id === undefined ? null : Number(row.location_id),
      orderedQuantity: quantity,
      completedQuantity: completed,
      // A hint for deselecting unselected static-sublist rows only. NetSuite is
      // authoritative for acceptance of every explicitly confirmed quantity.
      remainingQuantity: row.cached_closed === true ? 0 : Math.max(quantity - completed, 0),
      linkedTransactions: []
    };
  }).sort((a, b) => a.orderLine - b.orderLine);
}

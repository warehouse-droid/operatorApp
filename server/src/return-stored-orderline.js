// @ts-check

import { readNetSuiteOrderLine } from "./netsuite-order-line.js";
import { STORED_ORDER_LINE_STRATEGY } from "./operator-netsuite-posting-stored-lines.js";

/** @param {string} message @param {string} [code] */
function conflict(message, code = "NETSUITE_ORDER_LINE_AMBIGUOUS") {
  return Object.assign(new Error(message), { status: 409, code });
}

/** @param {unknown} value @returns {number} */
function sourceId(value) {
  const id = Number(value);
  if (!["string", "number"].includes(typeof value) || !Number.isSafeInteger(id) || id <= 0) {
    throw conflict("A valid Sales Order and stable source-line identity are required.", "NETSUITE_ORDER_LINE_MISSING");
  }
  return id;
}

/** @param {Record<string, any>} row @returns {number | null} */
function savedRestId(row) {
  try {
    return readNetSuiteOrderLine({ netsuite_order_line: row.netsuite_order_line });
  } catch {
    throw conflict("The saved NetSuite orderLine is invalid. Refresh the Sales Order before returning it.", "NETSUITE_ORDER_LINE_MISSING");
  }
}

/**
 * The stable SuiteQL key identifies a local row; only its persisted REST
 * orderLine is a transform identifier. An incomplete cache requests the
 * existing REST fallback, while conflicting populated identities fail closed.
 * @param {Record<string, any>} order
 * @param {Record<string, any>[]} rows
 * @returns {Record<string, any> | null}
 */
export function mapStoredReturnSalesOrderLines(order, rows) {
  const orderId = sourceId(order.id);
  if (!Array.isArray(order.lines) || !order.lines.length) {
    throw conflict("Complete Sales Order lines are required for return mapping.", "NETSUITE_ORDER_LINE_MISSING");
  }
  const seenSources = new Set();
  const seenRestIds = new Set();
  let incomplete = false;
  const lines = order.lines.map((/** @type {Record<string, any>} */ line) => {
    const stableKey = sourceId(line.sourceLineId);
    if (seenSources.has(stableKey)) {throw conflict("The Sales Order contains duplicate stable source-line identities.");}
    seenSources.add(stableKey);
    const candidates = rows.filter(row => row.netsuite_active === true && Number(row.line_id) === stableKey);
    if (candidates.length > 1) {throw conflict("The saved Sales Order source-line mapping is ambiguous.");}
    const row = candidates[0];
    if (!row) {incomplete = true; return line;}
    if (Number(row.sales_order_id) !== orderId || sourceId(row.item_id) !== sourceId(line.itemId)) {
      throw conflict(`The saved Sales Order or item identity does not match ${line.itemName || stableKey}. Refresh the order before returning it.`);
    }
    const orderLine = savedRestId(row);
    if (orderLine === null) {incomplete = true; return line;}
    if (seenRestIds.has(orderLine)) {throw conflict("Multiple source lines share the same saved NetSuite orderLine.");}
    seenRestIds.add(orderLine);
    return { ...line, netSuiteOrderLine: orderLine, netSuiteOrderLineSource: STORED_ORDER_LINE_STRATEGY,
      netSuiteOrderLineSnapshot: { orderLine, item: { id: String(line.itemId) },
        sourceOrderId: orderId, sourceLineKey: String(stableKey), source: STORED_ORDER_LINE_STRATEGY } };
  });
  return incomplete ? null : { ...order, lines };
}

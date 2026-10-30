// @ts-check
import { isCompletedNetSuitePostingOrder } from './netsuite-fulfillable-items.js';
import { isSqftPostingUnit, netSuitePostingQuantity } from './operator-netsuite-posting-quantity.js';

/** @param {string} message @returns {never} */
function changed(message) {
  throw Object.assign(new Error(`${message} Refresh the order before posting.`), {
    code: 'OPERATOR_NETSUITE_POSTING_IF_SOURCE_CHANGED', status: 409, postingNotAttempted: true
  });
}

/** @param {Record<string,any>|null} source @param {Record<string,any>} step */
function currentLines(source, step) {
  if (!source || Number(source.id) !== Number(step.sourceNetSuiteId) || !Array.isArray(source.lines)
      || isCompletedNetSuitePostingOrder('SO', source)) {
    changed('The current Sales Order is complete or unavailable.');
  }
  const lines = new Map();
  for (const line of source.lines) {
    const orderLine = Number(line.orderLine);
    assertCurrentLine(line, orderLine);
    if (lines.has(orderLine)) { changed('The current Sales Order line evidence is ambiguous.'); }
    lines.set(orderLine, line);
  }
  return lines;
}

/** @param {Record<string,any>} line @param {number} orderLine */
function assertCurrentLine(line, orderLine) {
  if (!Number.isSafeInteger(orderLine) || orderLine <= 0
      || line.remainingQuantity === null || line.remainingQuantity === undefined
      || !Number.isFinite(Number(line.remainingQuantity)) || Number(line.remainingQuantity) < 0) {
    changed('The current Sales Order line evidence is invalid.');
  }
}

/** @param {Record<string,any>|undefined} line */
function openFulfillableLine(line) {
  return Boolean(line && line.canFulfill !== false && !line.lineClosed && Number(line.remainingQuantity) > 0);
}

/** @param {Record<string,any>} snapshot @param {Record<string,any>} line */
function assertDeferredQuantityUnit(snapshot, line) {
  if (snapshot.quantityCheckDeferred === true && (!isSqftPostingUnit(snapshot.salesUom) || !isSqftPostingUnit(line.unit))) {
    changed('The deferred SQFT check has missing or conflicting Sales Order unit evidence.');
  }
}

/** @param {Record<string,any>} step @param {Record<string,any>} item @param {Record<string,any>|undefined} line */
function assertSelectedLine(step, item, line) {
  if (!line || !openFulfillableLine(line)) {
    changed('A selected Sales Order line is missing, closed, or already fulfilled.');
  }
  if (Number(item.location) !== Number(line.location)) {
    changed('A selected Sales Order line location changed.');
  }
  for (const snapshot of step.lineSnapshot || []) {
    if (Number(snapshot.orderLine) !== Number(item.orderLine)) { continue; }
    if ((snapshot.sourceLineKey && String(snapshot.sourceLineKey) !== String(line.sourceLineKey))
        || (snapshot.itemId && Number(snapshot.itemId) !== Number(line.itemId))) {
      changed('A selected Sales Order line identity changed.');
    }
    assertDeferredQuantityUnit(snapshot, line);
  }
}

/** A durable marker retains the missing quantity check even if either gate is
 * disabled after admission. This is called only before a safe native fallback.
 * @param {Record<string,any>} step @param {Record<string,any>} payload @param {Record<string,any>|null} source */
export function prepareDeferredSalesOrderNativePayload(step, payload, source) {
  const deferred = (step.lineSnapshot || []).filter((/** @type {any} */ line) => line.quantityCheckDeferred === true);
  if (!deferred.length) { return payload; }
  const lines = currentLines(source, step);
  const items = payload.item.items.map((/** @type {any} */ item) => {
    if (!item.itemReceive || !deferred.some((/** @type {any} */ line) => Number(line.orderLine) === Number(item.orderLine))) { return item; }
    const line = lines.get(Number(item.orderLine));
    assertSelectedLine(step, item, line);
    const quantity = netSuitePostingQuantity(item.quantity, line.remainingQuantity, line.unit);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > Number(line.remainingQuantity)) {
      changed('The selected SQFT quantity exceeds the current remaining quantity.');
    }
    return { ...item, quantity };
  });
  return { ...payload, item: { ...payload.item, items } };
}

/** Keep selected values exact; remove only unavailable deselection rows from the
 * transport payload. The durable command and its verification evidence stay intact.
 * @param {Record<string,any>} step @param {Record<string,any>|null} source */
export function prepareSalesOrderFulfillmentPayload(step, source) {
  const lines = currentLines(source, step);
  const included = new Set(step.payload.item.items.map((/** @type {Record<string,any>} */ item) => Number(item.orderLine)));
  const items = step.payload.item.items.filter((/** @type {Record<string,any>} */ item) => {
    const line = lines.get(Number(item.orderLine));
    if (item.itemReceive === false || item.itemreceive === false) {
      return openFulfillableLine(line);
    }
    assertSelectedLine(step, item, line);
    return true;
  });
  for (const [orderLine, line] of lines) {
    if (!included.has(orderLine) && openFulfillableLine(line)) {
      items.push({ orderLine, itemReceive: false,
        ...(line.location === null || line.location === undefined ? {} : { location: line.location }) });
    }
  }
  return { ...step.payload, item: { ...step.payload.item, items } };
}

/** Read errors happen before the mutation and must not enter ambiguous recovery.
 * @param {Record<string,any>} step @param {Function} readSource */
export async function readSalesOrderFulfillmentSource(step, readSource) {
  try { return await readSource(step.sourceNetSuiteId); }
  catch (error) {
    throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
      code: 'OPERATOR_NETSUITE_POSTING_IF_SOURCE_UNAVAILABLE', status: 503, postingNotAttempted: true
    });
  }
}

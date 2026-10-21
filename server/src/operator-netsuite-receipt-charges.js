// @ts-check

import { verifyOperatorNetSuitePostingRecord } from './operator-netsuite-posting-adapter.js';

/** @param {string} message */
function mismatch(message) {
  return Object.assign(new Error(`The additional NetSuite purchase charge ${message}.`), {
    status: 409, code: 'OPERATOR_NETSUITE_POSTING_REMOTE_MISMATCH', ambiguous: true
  });
}

/** @param {any} value */
function finiteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') { return NaN; }
  return Number(value);
}

/** @param {any} value */
function positiveId(value) {
  const id = finiteNumber(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** @param {any} line */
function orderLine(line) {
  return Number(line.orderLine ?? line.orderline ?? line.line);
}

/** @param {any} line */
function received(line) {
  return line.itemReceive !== false && line.itemreceive !== false && Number(line.quantity) > 0;
}

/** @param {any} step @param {any} record @returns {any[]} */
function additionalCharges(step, record) {
  if (step.sourceOrderKind !== 'PO' || step.transactionType !== 'IR') { return []; }
  const requested = step.payload?.item?.items || [];
  if (!requested.some(received)) { return []; }
  const requestedLines = new Set(requested.map(orderLine));
  const items = record?.item?.items ?? record?.items ?? [];
  return items.filter((/** @type {any} */ line) => received(line) && !requestedLines.has(orderLine(line))
    && line.itemType === 'OthCharge' && line.itemSubtype === 'Purchase' && line.generateAccruals === false);
}

/** @param {any} step @param {any} record */
export function purchaseReceiptNeedsChargeSource(step, record) {
  return additionalCharges(step, record).length > 0;
}

/** @param {any} value */
function unit(value) { return String(value ?? '').trim().toUpperCase(); }

/** @param {any} step @param {any} actual @param {any} source */
function assertSourceDocument(step, actual, source) {
  const line = positiveId(orderLine(actual));
  if (!source || positiveId(source.id) !== positiveId(step.sourceNetSuiteId)
      || positiveId(actual.orderDoc?.id) !== positiveId(step.sourceNetSuiteId) || !line) {
    throw mismatch('has no matching source purchase order');
  }
  return line;
}

/** @param {any} step @param {any} actual @param {any} source */
function sourceChargeLine(step, actual, source) {
  const line = assertSourceDocument(step, actual, source);
  const matches = (source.lines || []).filter((/** @type {any} */ item) => Number(item.restLineId) === line);
  if (matches.length !== 1) { throw mismatch('has no unique source line'); }
  const expected = matches[0];
  if (expected.itemType !== 'OthCharge' || !positiveId(expected.lineId)
      || !positiveId(expected.itemId) || positiveId(actual.item?.id) !== positiveId(expected.itemId)) {
    throw mismatch('does not match the source charge item');
  }
  return expected;
}

/** @param {any} actual @param {any} expected */
function chargeAmounts(actual, expected) {
  const quantity = finiteNumber(actual.quantity), ordered = finiteNumber(expected.quantity);
  const rate = finiteNumber(expected.rate), actualRate = finiteNumber(actual.itemUnitPrice);
  const amount = finiteNumber(actual.itemFxAmount);
  if (![quantity, ordered, rate, actualRate, amount, quantity * rate].every(Number.isFinite)
      || quantity <= 0 || quantity > ordered + 0.000001) {
    throw mismatch('has an invalid source quantity or amount');
  }
  if (Math.abs(actualRate - rate) > 0.000001 || Math.abs(amount - quantity * rate) > 0.00500001) {
    throw mismatch('does not match the source rate and receipt amount');
  }
  return { quantity, rate, amount };
}

/** @param {any} step @param {any} actual @param {any} source */
function verifiedCharge(step, actual, source) {
  const expected = sourceChargeLine(step, actual, source);
  const location = positiveId(expected.locationId);
  const actualLocation = positiveId(actual.location?.id ?? actual.location);
  const units = unit(expected.unit);
  if (actualLocation !== location || unit(actual.unitsDisplay ?? actual.units?.refName) !== units) {
    throw mismatch('does not match the source location or units');
  }
  return { orderLine: orderLine(actual), sourceLineKey: String(expected.lineId), itemId: Number(expected.itemId),
    ...chargeAmounts(actual, expected), location, unit: units };
}

/**
 * Verify auto-included PO charges without changing the posted request or the
 * material quantities used by local finalization. The source is a separate,
 * trusted PO read; cumulative received quantities may lag a partial receipt.
 * @param {any} step @param {any} record @param {any} source
 */
export function verifyPurchaseReceiptWithCharges(step, record, source) {
  const additionalPurchaseCharges = additionalCharges(step, record).map(actual => verifiedCharge(step, actual, source));
  if (!additionalPurchaseCharges.length) { return verifyOperatorNetSuitePostingRecord(step, record); }
  const verificationStep = { ...step, payload: { ...step.payload, item: { ...step.payload.item,
    items: [...step.payload.item.items, ...additionalPurchaseCharges.map(charge => ({ orderLine: charge.orderLine,
      quantity: charge.quantity, location: charge.location, itemReceive: true }))] } },
  lineSnapshot: [...(step.lineSnapshot || []), ...additionalPurchaseCharges.map(charge => ({
    ...charge, salesUom: charge.unit }))] };
  return { ...verifyOperatorNetSuitePostingRecord(verificationStep, record), additionalPurchaseCharges };
}

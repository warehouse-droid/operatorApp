// @ts-check
export const NETSUITE_SQFT_VARIANCE_LIMIT = 0.01;
const EXACT_QUANTITY_EPSILON = 0.000001;

/** @param {unknown} value */
export function isSqftPostingUnit(value) {
  return String(value ?? '').trim().toUpperCase() === 'SQFT';
}

/** @param {unknown} local @param {unknown} netSuite @param {unknown} unit */
export function isSmallNetSuiteSqftVariance(local, netSuite, unit) {
  const left = Number(local), right = Number(netSuite);
  if (!isSqftPostingUnit(unit) || !Number.isFinite(left) || !Number.isFinite(right)
      || left <= 0 || right <= 0) {return false;}
  // Subtraction can place an exact 0.01 boundary a few machine bits below it.
  const roundoff = Math.min(0.00000001, Number.EPSILON * Math.max(1, left, right) * 2);
  return Math.abs(left - right) < NETSUITE_SQFT_VARIANCE_LIMIT - roundoff;
}

/** @param {unknown} local @param {unknown} netSuite @param {unknown} unit */
export function netSuitePostingQuantity(local, netSuite, unit) {
  return isSmallNetSuiteSqftVariance(local, netSuite, unit) ? Number(netSuite) : Number(local);
}

/** @param {unknown} local @param {unknown} netSuite @param {unknown} unit */
export function netSuitePostingQuantitiesMatch(local, netSuite, unit) {
  const left = Number(local), right = Number(netSuite);
  return Number.isFinite(left) && Number.isFinite(right) && left > 0 && right > 0
    && (Math.abs(left - right) <= EXACT_QUANTITY_EPSILON || isSmallNetSuiteSqftVariance(left, right, unit));
}

/** Map accepted accounting quantities back through saved stable local identities.
 * @param {any} payload @param {any[]} reconciliation @param {any[]} adjustments */
export function localReceiptNetSuiteQuantities(payload, reconciliation, adjustments) {
  if (!payload || !adjustments.length) {return payload;}
  const result = structuredClone(payload);
  for (const adjustment of adjustments) {
    const line = uniqueReceiptReconciliation(reconciliation, adjustment.orderLine);
    const item = uniqueLocalReceiptItem(result, line);
    if (!isSmallNetSuiteSqftVariance(item.quantity, adjustment.netSuiteQuantity, adjustment.salesUom)) {
      throw new Error('The NetSuite rounding quantity does not match the saved local receipt payload.');
    }
    item.quantity = Number(adjustment.netSuiteQuantity);
  }
  return result;
}

/** @param {any[]} reconciliation @param {unknown} orderLine */
function uniqueReceiptReconciliation(reconciliation, orderLine) {
  const lines = reconciliation.filter(line => Number(line.orderLine) === Number(orderLine));
  if (lines.length !== 1 || lines[0].localLines?.length !== 1) {
    throw new Error('The NetSuite rounding quantity has no unique local receipt line mapping.');
  }
  return lines[0];
}

/** @param {any} payload @param {any} line */
function uniqueLocalReceiptItem(payload, line) {
  const local = line.localLines[0];
  const aliases = new Set([String(local.sourceLineKey ?? ''), String(line.sourceLineKey ?? ''),
    ...(line.sourceLineAliases || []).map(String)]);
  const items = (payload.item?.items || []).filter((/** @type {any} */ item) =>
    aliases.has(String(item.orderLine)) && item.itemReceive !== false && item.itemreceive !== false && Number(item.quantity) > 0);
  if (items.length !== 1) {
    throw new Error('The NetSuite rounding quantity does not match the saved local receipt payload.');
  }
  return items[0];
}

/** @param {any} command @param {any} line */
function postedStepForLine(command, line) {
  return (command.steps || []).find((/** @type {any} */ step) => step.status === 'posted'
    && step.sourceOrderKind === line.sourceOrderKind && Number(step.sourceNetSuiteId) === Number(line.sourceNetSuiteId));
}

/** @param {any} line @param {any} step */
function stepQuantityEvidence(line, step) {
  const adjustment = (step.response?.quantityAdjustments || []).find((/** @type {any} */ item) => Number(item.orderLine) === Number(line.orderLine));
  const item = (step.payload?.item?.items || []).find((/** @type {any} */ candidate) => Number(candidate.orderLine) === Number(line.orderLine));
  return { quantity: adjustment?.netSuiteQuantity ?? item?.quantity, unit: adjustment?.salesUom ?? line.salesUom };
}

/** @param {any} line @param {any} step */
function verifiedLocalQuantity(line, step) {
  if (!step || line.localLines?.length !== 1) {return null;}
  const { quantity, unit } = stepQuantityEvidence(line, step);
  return isSmallNetSuiteSqftVariance(line.localLines[0].quantity, quantity, unit) ? Number(quantity) : null;
}

/** @param {any} command */
export function verifiedLocalNetSuiteSalesQuantities(command) {
  const quantities = {};
  for (const line of command.inputSnapshot?.lineReconciliation?.lines || []) {
    const quantity = verifiedLocalQuantity(line, postedStepForLine(command, line));
    if (quantity !== null) {
      /** @type {Record<string,number>} */ (quantities)[String(line.localLines[0].localLineId)] = quantity;
    }
  }
  return quantities;
}

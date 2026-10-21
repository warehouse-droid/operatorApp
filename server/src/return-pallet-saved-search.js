// The deployed report groups by customer, two mainline columns and phone.
// Pin the semantic columns so a report edit cannot silently change entitlement.
const COLUMN_SIGNATURES = [
  'entity||GROUP|', 'mainline||GROUP|', 'mainline||GROUP|',
  'phone|customerMain|GROUP|', 'quantity||SUM|'
].sort();

/** @param {string} reason */
function invalid(reason) {
  throw Object.assign(new Error(`NetSuite pallet report could not be verified: ${reason}. Refresh and try again.`),
    { status: 503, code: 'PALLET_SEARCH_INVALID' });
}

/** @param {any[]} columns */
function reportColumnIndices(columns) {
  const signatures = columns.map((column, index) => {
    if (!column || column.index !== index) { invalid('invalid column index'); }
    return [column.name, column.join, column.summary, column.formula].join('|');
  }).sort();
  if (JSON.stringify(signatures) !== JSON.stringify(COLUMN_SIGNATURES)) { invalid('report columns or grouping changed'); }
  const quantity = columns.findIndex(column => column.name === 'quantity');
  if (columns[quantity].label !== 'Returnable Quantity') { invalid('balance label changed'); }
  return { quantity, customer: columns.findIndex(column => column.name === 'entity') };
}

/** @param {unknown} value */
function reportQuantity(value) {
  if (!['string', 'number'].includes(typeof value) || !/^-?\d+(?:\.\d+)?$/.test(String(value))) {
    invalid('invalid returnable quantity');
  }
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || Math.abs(quantity) > Number.MAX_SAFE_INTEGER) {
    invalid('quantity outside numeric range');
  }
  return quantity;
}

/** @param {any} payload
 * @param {number} customerId
 */
function validateReportIdentity(payload, customerId) {
  if (!payload || payload.version !== 1 || payload.savedSearchId !== 'customsearch503'
    || payload.customerId !== String(customerId)) { invalid('search or customer identity mismatch'); }
  const stamp = typeof payload.generatedAt === 'string' ? Date.parse(payload.generatedAt) : NaN;
  const age = Date.now() - stamp;
  if (!Number.isFinite(stamp) || age < -30000 || age > 120000) { invalid('report timestamp is not current'); }
}

/** @param {any} payload */
function validateReportShape(payload) {
  if (!Array.isArray(payload.columns) || payload.columns.length !== 5
    || !Array.isArray(payload.rows) || payload.rows.length > 1
    || payload.rowCount !== payload.rows.length || payload.found !== (payload.rows.length === 1)) {
    invalid('missing or ambiguous customer result');
  }
}

/** Validate a network boundary without returning unrelated report data.
 * @param {any} payload
 * @param {number} customerId
 */
export function parsePalletSavedSearch(payload, customerId) {
  validateReportIdentity(payload, customerId);
  validateReportShape(payload);
  const indices = reportColumnIndices(payload.columns);
  const row = payload.rows[0];
  if (payload.found && (!Array.isArray(row) || row.length !== payload.columns.length
    || String(row[indices.customer]) !== String(customerId))) { invalid('result row does not match the customer'); }
  return {
    netBalance: row ? reportQuantity(row[indices.quantity]) : 0,
    balanceFound: payload.found,
    source: 'netsuite_saved_search',
    savedSearchId: 'customsearch503',
    lookedUpAt: payload.generatedAt
  };
}

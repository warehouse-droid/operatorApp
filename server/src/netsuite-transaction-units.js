// @ts-check
const QUANTITY_FIELDS = ['quantity', 'quantityshiprecv', 'netsuite_received_qty',
  'netsuite_committed_qty', 'netsuite_backordered_qty', 'fulfilled_quantity',
  'received_quantity', 'signed_quantity', 'ordered_quantity', 'progress_raw', 'cumulative_progress_quantity'];

/** @param {string} message */
function unresolved(message) {
  return Object.assign(new Error(message), { code: 'NETSUITE_TRANSACTION_UOM_UNRESOLVED', status: 409 });
}

/** SuiteQL quantities are base units; REST and webhook transaction values already
 * use native units and must not pass through this boundary.
 * @param {Record<string, any>} row */
export function normalizeNetSuiteTransactionUnits(row) {
  if (row.unit_id === null || row.unit_id === undefined || row.unit_id === '') {return row;}
  const factor = Number(row.unit_conversion_rate);
  if (!Number.isFinite(factor) || factor <= 0) {
    throw unresolved(`NetSuite unit ${row.unit_id} has no valid conversion rate. Refresh the Units access before syncing.`);
  }
  if (factor === 1) {return row;}
  const converted = { ...row };
  for (const field of [...QUANTITY_FIELDS, 'rate']) {
    if (row[field] === null || row[field] === undefined || row[field] === '') {continue;}
    const value = Number(row[field]);
    const native = field === 'rate' ? value * factor : value / factor;
    if (!Number.isFinite(native)) {throw unresolved(`NetSuite returned an invalid ${field} for unit ${row.unit_id}.`);}
    converted[field] = Number(native.toPrecision(12));
  }
  return converted;
}

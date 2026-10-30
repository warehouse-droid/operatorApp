// @ts-check
import { activeNetSuiteLocationDirectory, fetchReturnRestockingFeeFromNetSuite } from './netsuite.js';
import { specialDiscountLineAmount } from '../public/special-stock-pricing.js';

/** @param {Record<string, any>} line */
export function isQualityReturnLine(line) {
  return line.kind === 'stock' && [5, 6, 7, 8, 9].includes(Number(line.reasonId));
}

/** Resolve once at admission; retries use the immutable accounting snapshot.
 * @param {Record<string, any>} intent */
export async function prepareReturnAccounting(intent) {
  const needsChild = intent.lines.some(isQualityReturnLine);
  const needsFee = intent.transactionType === 'credit_memo'
    && intent.lines.some((/** @type {Record<string, any>} */ line) => line.kind === 'stock' && line.reasonId === 10);
  const [directory, fee] = await Promise.all([
    needsChild ? activeNetSuiteLocationDirectory() : Promise.resolve([]),
    needsFee ? fetchReturnRestockingFeeFromNetSuite() : Promise.resolve(null)
  ]);
  const names = new Map([[1, '3445 Return'], [28, '2967 Return'], [26, '150 Return'], [15, '12441 Return']]);
  const children = directory.filter(row => Number(row.parent) === intent.receivingLocationId
    && String(row.name).trim().toLowerCase() === names.get(intent.receivingLocationId)?.toLowerCase()
    && String(row.isinactive || 'F') === 'F');
  if (needsChild && (children.length !== 1 || !(Number(children[0].id) > 0))) {
    throw Object.assign(new Error('The active NetSuite Return location for this receiving yard could not be verified.'),
      { status: 409, code: 'RETURN_CHILD_LOCATION_MISSING' });
  }
  intent.lines = intent.lines.map((/** @type {Record<string, any>} */ line) => ({ ...line,
    locationId: isQualityReturnLine(line) ? Number(children[0].id) : intent.receivingLocationId }));
  if (fee) { intent.restockingFee = fee; }
  return intent;
}

/** @param {Record<string, any>} fee */
function verifiedFee(fee) {
  if (!fee || !Number.isSafeInteger(fee.itemId) || fee.itemId <= 0
    || fee.percent === null || fee.percent === '' || !Number.isFinite(Number(fee.percent)) || fee.percent < 0 || fee.percent > 100) {
    throw Object.assign(new Error('A verified NetSuite Restocking Fee is required for good-condition stock.'),
      { status: 409, code: 'RETURN_RESTOCKING_FEE_MISSING' });
  }
  return fee;
}

/** @param {Record<string, any>} intent @param {Record<string, any>} line @param {number} index */
export function returnRestockingRow(intent, line, index) {
  if (!(Number(intent.version) >= 4) || line.kind !== 'stock' || Number(line.reasonId) !== 10) { return null; }
  const fee = verifiedFee(intent.restockingFee);
  return { item: { id: String(fee.itemId) }, price: { id: '-1' },
    rate: specialDiscountLineAmount(line.returnedSalesQuantity, line.rate, fee.percent),
    location: { id: String(line.locationId || intent.receivingLocationId) },
    custcol_atlas_rc_so: { id: String(line.reasonId) },
    ...(Number(intent.version) >= 5 ? {} : { description: `Restocking Fee (${fee.percent}%) for stock row ${index + 1}` }) };
}

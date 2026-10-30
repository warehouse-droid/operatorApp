// @ts-check
import { inventoryDate, inventoryMonth, inventoryId, inventoryError } from './inventory-workflow-domain.js';

const YARDS = new Map([[1, '3445'], [28, '2967'], [26, '150']]);
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/** @param {Record<string, any>} input */
export function isStockExchange(input = {}) {
  return [input.returnMode, input.recordType, input.draftType].some(value => value === 'exchange');
}
/** @param {Record<string, any>} input */
export function assertStockExchange(input) {
  if (!YARDS.has(Number(input.receivingLocationId))) {throw inventoryError('Stock exchange is available at yards 3445, 2967 and 150.');}
  if (input.stockReturnType !== 'quality') {throw inventoryError('Stock exchange requires Quality Issue (R1–R5).');}
  if (Number(input.palletQuantity || 0) !== 0) {throw inventoryError('Submit PALLET returns separately from a stock exchange.');}
  if (!Array.isArray(input.lines) || !input.lines.length) {throw inventoryError('Add at least one stock exchange quantity.');}
}
/** @param {string | Date} submittedAt */
export function exchangeMonth(submittedAt) {
  const date = submittedAt instanceof Date ? submittedAt : new Date(submittedAt);
  if (Number.isNaN(date.getTime())) {throw inventoryError('Invalid exchange date.');}
  return inventoryMonth(inventoryDate(date).slice(0,7));
}
/** @param {number | string} locationId @param {string} month */
export function exchangeMemo(locationId, month) {
  const yard = YARDS.get(Number(locationId));
  if (!yard) {throw inventoryError('Select an exchange yard: 3445, 2967 or 150.');}
  const [year, part] = inventoryMonth(month).split('-');
  return `${yard} ${year} ${MONTHS[Number(part)-1]} Exchange`;
}
/** @param {Array<Record<string, any>>} directory @param {number | string} locationId */
export function exchangeDestination(directory, locationId) {
  const sourceId = inventoryId(locationId), code = YARDS.get(sourceId);
  const active = (/** @type {Record<string, any>} */ row) => !/^(T|true)$/i.test(String(row.isinactive));
  const root = directory.find(row => Number(row.id) === sourceId && active(row));
  const destinations = directory.filter(row => Number(row.parent) === sourceId && active(row)
    && String(row.name).trim().toLowerCase() === `${code} return`);
  if (!code || !root || destinations.length !== 1) {throw inventoryError('The yard must have exactly one active Return child location.', 409);}
  return { sourceId, destinationId: inventoryId(destinations[0].id), subsidiaryId: inventoryId(root.subsidiary) };
}
/** @param {{recordType: string, stockReturnType: string, receivingLocationId: number | string,
 * submittedAt: string | Date, sourceSalesOrderRef: string,
 * lines: Array<{itemId: number | string, returnedSalesQuantity: number, salesUomId: number | string | null, reasonId: number | string}>}} record */
export function buildExchangeIntent(record) {
  if (record.recordType !== 'exchange' || record.stockReturnType !== 'quality' || !record.lines?.length)
    {throw inventoryError('A quality stock exchange with quantities is required.');}
  const month = exchangeMonth(record.submittedAt);
  const so = String(record.sourceSalesOrderRef || '').trim();
  if (!/^SO[A-Z]?\d+$/i.test(so)) {throw inventoryError('The exchange needs its original SO number.');}
  const lines = record.lines.map(line => {
    const quantity = Number(line.returnedSalesQuantity), reason = inventoryId(line.reasonId);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1e12) {throw inventoryError('Invalid exchange quantity.');}
    if (![5,6,7,8,9].includes(reason)) {throw inventoryError('Stock exchange requires an R1–R5 reason.');}
    return { item: { id: String(inventoryId(line.itemId)) }, adjustQtyBy: quantity,
      units: String(inventoryId(line.salesUomId, 'sales unit')),
      custcol_atlas_rc_so: { id: String(reason) }, custcol_position: so };
  });
  return { month, locationId: Number(record.receivingLocationId),
    externalId: `mbbs-exchange-${record.receivingLocationId}-${month}`,
    memo: exchangeMemo(record.receivingLocationId, month),
    date: inventoryDate(record.submittedAt instanceof Date ? record.submittedAt : new Date(record.submittedAt)), lines };
}

import { isDeepStrictEqual as same } from 'node:util';

/**
 * @typedef {{memo:string,shipDate:string,deliverByDate:string}} Values
 * @typedef {{orderId:number,orderRef:string,locationId:number,deliveryMethodId:number,status:string}} Identity
 * @typedef {{identity:Identity,values:Values,editable:boolean,lockReason:string}} Snapshot
 * @typedef {{rest:(path:string,options?:{method?:string,body?:Record<string,string|null>})=>Promise<{data?:Record<string,any>}>}} Boundary
 */
/** @param {string} message @param {number} [status] */
function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status, code: 'DELIVERY_INSTRUCTION_NETSUITE' });
}
/** @param {unknown} value */
function orderId(value) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw invalid('A valid NetSuite Sales Order ID is required.');
  return Number(value);
}
/** @param {unknown} value @param {string} label */
function calendarDate(value, label) {
  if (value === '') return '';
  if (typeof value !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) throw invalid(`${label} must be a date in YYYY-MM-DD format, or blank.`);
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw invalid(`${label} is not a valid calendar date.`);
  return value;
}
/** @param {unknown} input @returns {Values} */
export function normalizeDeliveryNetSuiteValues(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 3 || !['memo', 'shipDate', 'deliverByDate'].every(key => Object.hasOwn(input, key))) {
    throw invalid('Only the NetSuite memo instruction, Ship Date and To be delivered by fields may be updated.');
  }
  const value = /** @type {Record<string,unknown>} */ (input);
  if (typeof value.memo !== 'string' || value.memo.length > 5000 || value.memo.includes('\0')) throw invalid('NetSuite memo instruction must be text of at most 5,000 characters.');
  return { memo: value.memo.replace(/\r\n?/g, '\n'), shipDate: calendarDate(value.shipDate, 'Ship Date'),
    deliverByDate: calendarDate(value.deliverByDate, 'To be delivered by') };
}
/** @param {number} id @param {Boundary} boundary @returns {Promise<Snapshot>} */
export async function readDeliveryNetSuite(id, boundary) {
  const { data: record } = await boundary.rest(`/record/v1/salesOrder/${orderId(id)}`);
  if (!record || Number(record.id) !== id || !record.tranId || !record.status?.id || !record.location?.id || !record.custbody3?.id) {
    throw invalid('NetSuite did not return the complete Sales Order identity. Reload the order before editing.', 502);
  }
  const identity = { orderId: id, orderRef: String(record.tranId), locationId: Number(record.location.id),
    deliveryMethodId: Number(record.custbody3.id), status: String(record.status.id) };
  const editable = identity.deliveryMethodId === 2 && ['A', 'B', 'D', 'E', 'F', 'G'].includes(identity.status);
  return { identity, values: normalizeDeliveryNetSuiteValues({ memo: record.custbody7 ?? '',
    shipDate: record.shipDate ?? '', deliverByDate: record.custbody4 ?? '' }), editable,
  lockReason: editable ? '' : 'This NetSuite Sales Order is closed, cancelled, or no longer a Delivery order.' };
}
/** @param {{orderId:number,expected:Snapshot,values:Values}} input @param {Boundary} boundary @returns {Promise<Snapshot>} */
export async function updateDeliveryNetSuite(input, boundary) {
  const id = orderId(input.orderId), target = normalizeDeliveryNetSuiteValues(input.values);
  const before = normalizeDeliveryNetSuiteValues(input.expected?.values);
  const current = await readDeliveryNetSuite(id, boundary);
  if (!current.editable || !same(current.identity, input.expected?.identity)
    || (!same(current.values, before) && !same(current.values, target))) {
    throw invalid('The Sales Order changed in NetSuite. Reload NetSuite values and review your changes before saving.', 409);
  }
  if (same(current.values, target)) return current;
  /** @type {Record<string,string|null>} */
  const body = {};
  for (const [key, field] of /** @type {Array<[keyof Values,string]>} */ ([['memo', 'custbody7'], ['shipDate', 'shipDate'], ['deliverByDate', 'custbody4']])) {
    if (current.values[key] !== target[key]) body[field] = target[key] || null;
  }
  let patchError;
  try { await boundary.rest(`/record/v1/salesOrder/${id}`, { method: 'PATCH', body }); }
  catch (error) { patchError = error; }
  let after;
  try { after = await readDeliveryNetSuite(id, boundary); }
  catch {
    throw invalid('NetSuite save could not be verified. Your input is retained. Retry the same save or reload NetSuite values to check the result.', 502);
  }
  if (same(after.identity, current.identity) && same(after.values, target)) return after;
  if (patchError && same(after.values, before)) {
    throw invalid('The changes were not saved in NetSuite. Check your access and try again; your input is retained.', 502);
  }
  throw invalid('NetSuite returned different values after saving. Reload NetSuite values and review the result before trying again.', 409);
}

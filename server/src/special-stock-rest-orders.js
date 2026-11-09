import { SPECIAL_PACK_FIELDS } from '../public/special-stock-line-details.js';
import { normalizePackQuantity } from '../public/order-pack-quantities.js';
import { sumSpecialAmounts } from './special-stock-discount-total.js';
import { specialRestUnitId } from './special-stock-netsuite-adapter.js';
import { prepareSpecialAdjustmentPlan, specialAdjustmentMatches } from './special-stock-adjustment-adapter.js';
import { specialLineSubtotal, specialQuantity, specialPalletQuantity } from '../public/special-stock-pricing.js';
import { buildSpecialPurchaseLinePayload } from './special-stock-request-netsuite.js';

/**
 * @typedef {Record<string, any>} Raw NetSuite JSON, validated at the boundary.
 * @typedef {import('./special-stock-adjustment-adapter.js').Snapshot} Snapshot
 * @typedef {import('./special-stock-adjustment-adapter.js').SnapshotLine} SnapshotLine
 * @typedef {import('./special-stock-adjustment-adapter.js').Identity} Identity
 * @typedef {import('./special-stock-adjustment-adapter.js').InputOrder} InputOrder
 * @typedef {import('./special-stock-adjustment-adapter.js').PreparedOrder} PreparedOrder
 * @typedef {import('./special-stock-adjustment-adapter.js').Boundary} Boundary
 * @typedef {{rest:(path:string,options?:{method?:string,body?:Raw})=>Promise<{data?:Raw,id?:number}>,queryAll:(sql:string)=>Promise<Raw[]>}} Transport
 */
/** @param {string} message */
const conflict = message => Object.assign(Error(message), { status: 409, code: 'SPECIAL_ADJUSTMENT_CONFLICT' });
/** @param {unknown} value */
const ref = value => ({ id: String(value) });
/** @param {unknown} value */
function id(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw conflict('The exact NetSuite order and line identities are required.');
  return result;
}
/** @param {Identity} order */
function recordPath(order) {
  if (!['sales_order', 'purchase_order'].includes(order.kind)) throw conflict('Unsupported order kind.');
  return `/record/v1/${order.kind === 'sales_order' ? 'salesOrder' : 'purchaseOrder'}/${id(order.id)}`;
}
/** @param {Raw} record @returns {Snapshot['header']} */
function header(record) {
  /** @type {Snapshot['header']} */
  const result = {};
  for (const field of ['entity', 'location', 'subsidiary', 'currency', 'exchangeRate', 'shipAddress',
    'shippingCost', 'handlingCost', 'discountItem', 'discountRate', 'memo']) {
    result[field] = String(record[field]?.id ?? record[field] ?? '');
  }
  if (!result.discountItem) result.discountRate = '';
  return result;
}
/** Subtotal and Description rows use NetSuite's non-positive item IDs; discount rows have no (or zero) quantity.
 * @param {Raw} line @returns {{itemId:number}|null} */
function summaryLine(line) {
  const raw = line.item?.id, item = Number(raw);
  if (raw === null || raw === undefined || String(raw).trim() === '' || !Number.isSafeInteger(item)) return null;
  const quantity = line.quantity === null || line.quantity === undefined ? '' : String(line.quantity).trim();
  return item <= 0 || !quantity || Number(quantity) === 0 ? { itemId: item } : null;
}
/** @param {Raw} line @param {Raw|undefined} row @param {{allowSummaryLines?:boolean}} [options] @returns {SnapshotLine} */
function snapshotLine(line, row, { allowSummaryLines = false } = {}) {
  const summary = allowSummaryLines ? summaryLine(line) : null;
  if (!row || Number(row.rest_line_id) !== id(line.line) || Number(row.item) !== (summary ? summary.itemId : id(line.item?.id))) {
    throw conflict('NetSuite returned inconsistent order line identities.');
  }
  if (line.lineUniqueKey != null && id(line.lineUniqueKey) !== id(row.uniquekey)) throw conflict('NetSuite returned inconsistent stable line keys.');
  if (!['A', 'B'].includes(row.status) || row.execution_quantity == null || Number(row.execution_quantity) !== 0
    || row.billed_quantity == null || Number(row.billed_quantity) !== 0 || !['F', false].includes(row.line_closed)
    || line.isClosed === true) throw conflict('Only pending, unfulfilled, unreceived, unbilled and open orders can be adjusted.');
  // Sales can add these rows to a manually created SO. A delivery-only update compares them and never rewrites them.
  if (summary) return { remoteLineId: id(row.uniquekey), itemId: summary.itemId, quantity: null, unitId: null,
    rate: line.rate === null || line.rate === undefined ? '' : String(line.rate), description: String(line.description || ''),
    locationId: line.location?.id ? id(line.location.id) : null, taxCode: String(line.taxCode?.id || ''), createdPoId: null, createPo: '' };
  if (line.rate == null || !Number.isFinite(Number(line.rate))) throw conflict('The complete remote rate is required.');
  const percentage = row.ratepercent == null ? null : Number(row.ratepercent);
  if (percentage !== null && !Number.isFinite(percentage)) throw conflict('The native discount rate could not be verified.');
  const unit = specialRestUnitId(line.units), discount = Number(line.item.id) === 10716;
  return { remoteLineId: id(row.uniquekey), itemId: id(line.item.id),
    quantity: discount ? null : specialQuantity(line.quantity), unitId: unit ? id(unit) : null,
    rate: percentage === null ? String(Number(line.rate)) : `${Number((percentage * 100).toPrecision(12))}%`,
    description: String(line.description || ''), locationId: line.location?.id ? id(line.location.id) : null,
    taxCode: String(line.taxCode?.id || ''), createdPoId: line.createdPo?.id ? id(line.createdPo.id) : null,
    createPo: String(line.createPo?.id ?? line.createPo ?? ''),
    ...(Number(line.item.id) === 2055 ? { pack: Object.fromEntries(Object.entries(SPECIAL_PACK_FIELDS).map(([field, native]) => [field, Number(line[native] ?? 0)])) } : {}) };
}
/** `allowSummaryLines` is for delivery-only header updates, which compare but never rewrite the item sublist.
 * @param {Identity} order @param {Transport} transport @param {{allowHeaderDiscount?:boolean,allowSummaryLines?:boolean}} options @returns {Promise<{record:Raw,snapshot:Snapshot}>} */
export async function readSpecialRestOrder(order, { rest, queryAll }, { allowHeaderDiscount = false, allowSummaryLines = false } = {}) {
  const [response, rows] = await Promise.all([
    rest(`${recordPath(order)}?expandSubResources=true`),
    queryAll(`SELECT tl.uniquekey, tl.id AS rest_line_id, tl.item, t.status,
      ABS(NVL(tl.quantityshiprecv,0)) AS execution_quantity,
      ABS(NVL(tl.quantitybilled,0)) AS billed_quantity, tl.isclosed AS line_closed, tl.ratepercent
      FROM transactionline tl JOIN transaction t ON t.id=tl.transaction
      WHERE tl.transaction=${id(order.id)} AND tl.mainline='F' AND tl.taxline='F' AND tl.item IS NOT NULL`)
  ]);
  const record = response.data;
  /** @type {Raw[]|undefined} */
  const source = record?.item?.items;
  // NetSuite exposes the native header discount as a query row, outside item.items.
  // Delivery-only edits preserve that header and never rewrite the item sublist.
  const headerDiscounts = allowHeaderDiscount && String(record?.discountItem?.id) === '10716' && Array.isArray(source)
    ? rows.filter(row => Number(row.item) === 10716 && !source.some(line => Number(line.line) === Number(row.rest_line_id))) : [];
  if (!record || !Array.isArray(source) || !source.length || source.length > 200 || headerDiscounts.length > 1
    || rows.length - headerDiscounts.length !== source.length
    || new Set(rows.map(row => String(row.uniquekey))).size !== rows.length) throw conflict('A complete, distinct NetSuite order is required.');
  const lines = source.map(line => snapshotLine(line, rows.find(row => Number(row.rest_line_id) === id(line.line)), { allowSummaryLines }));
  if (new Set(lines.map(line => line.remoteLineId)).size !== lines.length) throw conflict('NetSuite returned duplicate line identities.');
  return { record, snapshot: { header: header(record), lines } };
}

// Keyed REST replacements retain existing row positions and append new rows.
// Only unlinked ancillary rows may be recreated to keep a new discount adjacent.
/** @param {PreparedOrder} order */
function positionAdditions(order) {
  let append = false;
  for (const line of order.target.lines) {
    if (!line.remoteLineId) append = true;
    else if (append) {
      if (order.kind !== 'sales_order' || ![10716, 1784].includes(line.itemId) || line.createdPoId || line.createPo) {
        throw conflict('REST cannot insert this discount before a later linked material. Its existing material identities must be preserved.');
      }
      line.remoteLineId = null;
    }
  }
}
/** @type {(keyof SnapshotLine)[]} */
const immutable = ['itemId', 'unitId', 'description', 'locationId', 'taxCode', 'createdPoId', 'createPo'];
/** @param {PreparedOrder} order */
function assertAllowedChange(order) {
  const sales = order.kind === 'sales_order', { baseline, target } = order;
  const allowedHeader = { ...baseline.header };
  if (sales && target.header.discountItem === '10716') {
    const amount = Number(target.header.discountRate);
    const gross = sumSpecialAmounts(target.lines.filter(line => line.itemId === 2055).map(line => specialLineSubtotal(line.quantity, line.rate)));
    if (target.lines.some(line => line.itemId === 10716) || !Number.isFinite(amount) || amount > 0 || amount !== Number(amount.toFixed(2)) || -amount > gross
      || (baseline.header.discountItem && baseline.header.discountItem !== '10716')) throw conflict('The total discount must stay within the reviewed materials.');
    allowedHeader.discountItem = target.header.discountItem; allowedHeader.discountRate = target.header.discountRate;
  }
  if (!specialAdjustmentMatches({ header: allowedHeader, lines: [] }, { header: target.header, lines: [] })
    || !target.lines.length || target.lines.length > 200) throw conflict('The complete order header and lines must be preserved.');
  const keys = target.lines.filter(line => line.remoteLineId).map(line => line.remoteLineId);
  if (new Set(keys).size !== keys.length || target.lines.filter(line => line.itemId === 1784).length > 1) throw conflict('Duplicate adjustment lines are not allowed.');
  for (const before of baseline.lines) {
    const after = target.lines.find(line => line.remoteLineId === before.remoteLineId);
    if (!after) {
      if (!sales || ![10716, 1784].includes(before.itemId) || before.createdPoId || before.createPo) throw conflict('Linked material lines cannot be removed or recreated.');
      continue;
    }
    const mutableRate = sales ? [2055, 10716].includes(before.itemId) : before.itemId === 4981;
    const mutableQuantity = before.itemId === 2055 || (sales && before.itemId === 1784);
    const reviewed = before.itemId === 2055 ? order.reviewedFields?.find(line => line.remoteLineId === before.remoteLineId) : null;
    const allowedDescription = reviewed?.description ?? before.description;
    const allowedPack = { ...before.pack, ...reviewed?.pack };
    if (after.description !== allowedDescription || Object.keys(SPECIAL_PACK_FIELDS).some(field => Number(after.pack?.[field] ?? 0) !== Number(allowedPack[field] ?? 0))
      || immutable.some(field => field !== 'description' && before[field] !== after[field]) || (!mutableRate && before.rate !== after.rate)
      || (!mutableQuantity && before.quantity !== after.quantity)) throw conflict('Unreviewed fields and PO costs must remain unchanged.');
  }
  for (const [index, line] of target.lines.entries()) {
    if (line.remoteLineId && !baseline.lines.some(before => before.remoteLineId === line.remoteLineId)) throw conflict('Unknown remote line identity in the adjustment.');
    if (!line.remoteLineId && (!sales || ![10716, 1784].includes(line.itemId) || line.createdPoId || line.createPo)) throw conflict('Only unlinked discount or PALLET lines can be added.');
    if (line.itemId === 10716) {
      // A vendor's discount belongs to the PO, independently of the Sales discount.
      if (!sales && baseline.lines.some(before => before.remoteLineId === line.remoteLineId && before.rate === line.rate
        && before.quantity === line.quantity && immutable.every(field => before[field] === line[field]))) continue;
      const material = target.lines[index - 1], rate = Number(line.rate);
      const beforeIndex = baseline.lines.findIndex(before => before.remoteLineId === line.remoteLineId);
      const before = baseline.lines[beforeIndex], previousMaterial = baseline.lines[beforeIndex - 1];
      const nativeUnchanged = /^-\d+(?:\.\d+)?%$/.test(line.rate) && before?.rate === line.rate
        && material?.remoteLineId === previousMaterial?.remoteLineId && material?.quantity === previousMaterial?.quantity
        && material?.rate === previousMaterial?.rate;
      if (nativeUnchanged && sales && material?.itemId === 2055 && line.quantity === null && line.unitId === null) continue;
      if (!sales || material?.itemId !== 2055 || !Number.isFinite(rate) || rate > 0 || rate !== Number(rate.toFixed(2))
        || -rate > specialLineSubtotal(material.quantity, material.rate, 0) || line.quantity !== null || line.unitId !== null) {
        throw conflict('Each numeric discount must follow its material and stay within its gross amount.');
      }
    } else if (!sales && line.itemId === 4981) {
      const rate=Number(line.rate),gross=sumSpecialAmounts(target.lines.filter(l=>l.itemId===2055).map(l=>specialLineSubtotal(l.quantity,l.rate)));
      if (!line.remoteLineId || line.quantity!==1 || !Number.isFinite(rate) || rate>0 || rate!==Number(rate.toFixed(2)) || -rate>gross
        || line.createdPoId || line.createPo || !/^Vendor discount \| MBBS-SPECIAL-PO:\d+$/.test(line.description)
        // SCM-added PO items are appended after it; keyed REST updates keep its existing position.
        || target.lines.filter(l=>l.itemId===4981).length!==1) throw conflict('The vendor discount must remain one purchase discount within the gross total.');
    } else {
      specialQuantity(line.quantity);
      if (line.itemId === 1784) specialPalletQuantity(line.quantity);
      if (!Number.isFinite(Number(line.rate)) || Number(line.rate) < 0) throw conflict('A valid nonnegative order rate is required.');
      const pallet = !line.remoteLineId && line.itemId === 1784 ? baseline.lines.find(before => before.itemId === 1784) : null;
      if (pallet && (immutable.some(field => pallet[field] !== line[field]) || pallet.rate !== line.rate)) throw conflict('Repositioning PALLET must preserve its price and other fields.');
    }
  }
}
/** @param {SnapshotLine} line @param {Raw|undefined} source @param {boolean} sales @returns {Raw} */
function itemPayload(line, source, sales) {
  if (source) {
    /** @type {Raw} */
    const payload = { line: Number(source.line) };
    if (line.quantity !== null) payload.quantity = line.quantity;
    if (line.description !== String(source.description || '')) payload.description = line.description;
    for (const [field, native] of Object.entries(SPECIAL_PACK_FIELDS)) {
      if (line.pack && Number(line.pack[field] ?? 0) !== Number(source[native] ?? 0)) payload[native] = sales ? normalizePackQuantity(line.pack[field]) : line.pack[field] ?? 0;
    }
    if (!line.rate.endsWith('%') && (Number(source.rate) !== Number(line.rate) || line.itemId === 10716)) {
      payload.rate = Number(line.rate);
      if (sales) payload.price = ref(-1);
    }
    return payload;
  }
  /** @type {Raw} */
  const payload = { item: ref(line.itemId), rate: Number(line.rate), description: line.description,
    location: ref(line.locationId), price: ref(-1) };
  if (line.quantity !== null) payload.quantity = line.quantity;
  if (line.unitId) payload.units = String(line.unitId);
  if (line.taxCode) payload.taxCode = ref(line.taxCode);
  return payload;
}
/** @param {Transport} transport @returns {Boundary} */
export function createSpecialRestOrderBoundary(transport) {
  return {
    validate: plan => { for (const order of plan.orders) assertAllowedChange(order); },
    snapshot: async order => (await readSpecialRestOrder(order, transport)).snapshot,
    apply: async order => {
      assertAllowedChange(order);
      const current = await readSpecialRestOrder(order, transport);
      if (specialAdjustmentMatches(order.target, current.snapshot)) return;
      if (!specialAdjustmentMatches(order.baseline, current.snapshot)) throw conflict('NetSuite changed before the reviewed REST update.');
      const retained = order.baseline.lines.filter(line => order.target.lines.some(target => target.remoteLineId === line.remoteLineId));
      const expected = [...retained.map(line => line.remoteLineId), ...order.target.lines.filter(line => !line.remoteLineId).map(() => null)];
      if (JSON.stringify(expected) !== JSON.stringify(order.target.lines.map(line => line.remoteLineId))) throw conflict('The REST line position plan is not valid.');
      await transport.rest(`${recordPath(order)}?replace=item`, { method: 'PATCH', body: { ...(order.kind === 'sales_order' && order.target.header.discountItem === '10716' ? { discountItem: ref(10716), discountRate: Number(order.target.header.discountRate) } : {}), item: { items: order.target.lines.map(line =>
        itemPayload(line, current.record.item.items[current.snapshot.lines.findIndex(before => before.remoteLineId === line.remoteLineId)], order.kind === 'sales_order')) } } });
    }
  };
}
/** @param {{orders:InputOrder[]}} input @param {Transport} transport */
export async function prepareSpecialRestAdjustmentPlan(input, transport) {
  const plan = await prepareSpecialAdjustmentPlan(input, createSpecialRestOrderBoundary(transport));
  for (const order of plan.orders) { positionAdditions(order); assertAllowedChange(order); }
  return { ...plan, transport: 'restRecord', discountMode: 'amount' };
}

/** @param {Raw} payload */
export function assertSpecialRestSalesPayload(payload) {
  const items = payload?.item?.items;
  if (!Array.isArray(items) || !items.length || !/^MBBS-SPECIAL-SO:\d+$/.test(payload.externalId || '')) throw conflict('A complete SO payload and unique Special Item external ID are required.');
  if (payload.discountItem) {
    const gross = sumSpecialAmounts(items.filter(line => Number(line.item?.id) === 2055).map(line => specialLineSubtotal(line.quantity, line.rate)));
    const amount = payload.discountRate;
    if (String(payload.discountItem.id) !== '10716' || items.some(line => Number(line.item?.id) === 10716)
      || !Number.isFinite(amount) || amount > 0 || amount !== Number(amount.toFixed(2)) || -amount > gross) throw conflict('A single numeric total discount within the reviewed materials is required.');
  }
  for (const [index, line] of items.entries()) {
    if (!Number.isFinite(line.rate) || String(line.price?.id) !== '-1') throw conflict('REST sales rates must be numeric with Custom pricing.');
    if (Number(line.item.id) === 10716) {
      const material = items[index - 1];
      if (Number(material?.item?.id) !== 2055 || line.rate > 0 || -line.rate > specialLineSubtotal(material.quantity, material.rate)
        || line.rate !== Number(line.rate.toFixed(2))) throw conflict('Each discount amount must follow its reviewed material.');
    }
  }
}
/** @param {number} orderId @param {Raw} payload @param {Transport} transport */
export async function verifySpecialRestSalesOrder(orderId, payload, transport) {
  const {snapshot:current,record} = await readSpecialRestOrder({ id: orderId, kind: 'sales_order' }, transport);
  /** @type {Raw[]} */
  const expected = payload.item.items;
  if (String(payload.discountItem?.id || '') !== String(current.header.discountItem || '')
    || (payload.discountItem && Number(payload.discountRate) !== Number(current.header.discountRate))
    || current.header.entity !== String(payload.entity.id) || current.header.location !== String(payload.location.id)
    || current.lines.length !== expected.length || expected.some((line, index) => {
      const actual = current.lines[index], itemId = Number(line.item.id), unit = specialRestUnitId(line.units);
      return Object.values(SPECIAL_PACK_FIELDS).some(field => line[field] != null && Number(record.item.items[index][field] ?? 0) !== Number(line[field]))
        || actual.itemId !== itemId || actual.rate !== String(line.rate)
        || (itemId !== 10716 && (actual.quantity !== line.quantity || actual.unitId !== (unit == null ? null : Number(unit)) || actual.description !== line.description));
    })) throw Object.assign(Error('The existing SO does not match the reviewed items, quantities, UOM, prices and discount amounts.'), { status: 409, code: 'SPECIAL_SO_PRICE_CONFLICT' });
}

/**
 * Appending an SCM-added item to a PO this application created for the request.
 * The PATCH merges one new row into the item sublist; existing rows are never sent,
 * so they cannot be removed or rewritten. The baseline snapshot makes retries idempotent.
 * @typedef {{itemId:number,quantity:number,unitId:number|null,rate:number,description:string,pack?:Record<string,number>}} AppendedLine
 * @typedef {{version:1,kind:'purchase_item_append',purchaseOrderId:number,caseId:number,baseline:Snapshot,line:AppendedLine,payload:Raw}} PurchaseItemAppendPlan
 */
/** @param {string} message */
const appendConflict = message => Object.assign(Error(message), { status: 409, code: 'SPECIAL_PO_ITEM_CONFLICT' });
const APPEND_HEADER_FIELDS = ['entity', 'location', 'subsidiary', 'currency', 'memo'];
/** @type {(keyof SnapshotLine)[]} */
const APPEND_LINE_FIELDS = ['remoteLineId', 'itemId', 'quantity', 'unitId', 'rate', 'description', 'locationId', 'taxCode', 'createdPoId', 'createPo'];
/** @param {SnapshotLine} before @param {SnapshotLine|undefined} after */
function appendLineUnchanged(before, after) {
  return Boolean(after) && APPEND_LINE_FIELDS.every(field => before[field] === after?.[field])
    && Object.keys(SPECIAL_PACK_FIELDS).every(field => Number(before.pack?.[field] ?? 0) === Number(after?.pack?.[field] ?? 0));
}
/** @param {AppendedLine} expected @param {SnapshotLine|undefined} actual */
function appendedLineMatches(expected, actual) {
  return Boolean(actual) && actual?.itemId === expected.itemId && actual.quantity === expected.quantity
    && Number(actual.rate) === expected.rate && actual.description === expected.description
    && (expected.unitId === null || actual.unitId === expected.unitId)
    && Object.entries(expected.pack || {}).every(([field, value]) => Number(actual.pack?.[field] ?? 0) === Number(value ?? 0));
}
/** @param {PurchaseItemAppendPlan} plan @param {Snapshot} current @returns {'baseline'|'applied'|'changed'} */
export function specialPurchaseItemAppendState(plan, current) {
  if (APPEND_HEADER_FIELDS.some(field => plan.baseline.header[field] !== current.header[field])) return 'changed';
  if (!plan.baseline.lines.every((line, index) => appendLineUnchanged(line, current.lines[index]))) return 'changed';
  if (current.lines.length === plan.baseline.lines.length) return 'baseline';
  if (current.lines.length === plan.baseline.lines.length + 1 && appendedLineMatches(plan.line, current.lines.at(-1))) return 'applied';
  return 'changed';
}
/** @param {unknown} error */
function friendlyReadError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /^Only pending, unfulfilled, unreceived, unbilled and open orders/.test(message)
    ? appendConflict('NetSuite PO lines can be added only while the PO is pending approval or pending receipt, with nothing received or billed. Add the item in NetSuite, or keep it as a record only.')
    : error;
}
/** @param {{purchaseOrderId:number,caseId:number,line:Record<string,any>}} input @param {Transport} transport @returns {Promise<PurchaseItemAppendPlan>} */
export async function prepareSpecialPurchaseItemAppend({ purchaseOrderId, caseId, line }, transport) {
  let read;
  try { read = await readSpecialRestOrder({ id: id(purchaseOrderId), kind: 'purchase_order' }, transport); }
  catch (error) { throw friendlyReadError(error); }
  const { record, snapshot } = read;
  const marker = `MBBS-SPECIAL-PO:${id(caseId)}`;
  const markers = String(record.memo || '').match(/MBBS-SPECIAL-PO:\d+\b/g) || [];
  if (!markers.includes(marker) || markers.some(found => found !== marker)) {
    throw appendConflict('Only a PO created by this application for this request can be updated. Add the item in NetSuite instead.');
  }
  const location = snapshot.header.location;
  if (!location) throw appendConflict('The NetSuite PO location is required to add an item.');
  const itemId = id(line.itemId), unitId = line.unitId ? id(line.unitId) : null;
  const quantity = specialQuantity(line.quantity), rate = Number(line.unitPurchaseCost);
  if ([1784, 4981, 10716].includes(itemId) || !Number.isFinite(rate) || rate < 0) throw appendConflict('A valid PO item and unit cost are required.');
  const description = String(line.description || '').trim();
  /** @type {Record<string,number>} */
  const pack = {};
  for (const field of Object.keys(SPECIAL_PACK_FIELDS)) if (line[field] != null) pack[field] = Number(line[field]);
  const payload = buildSpecialPurchaseLinePayload({ ...line, itemId, unitId, quantity, unitPurchaseCost: rate, description }, location);
  return { version: 1, kind: 'purchase_item_append', purchaseOrderId: id(purchaseOrderId), caseId: id(caseId), baseline: snapshot,
    line: { itemId, quantity, unitId, rate, description, ...(itemId === 2055 && Object.keys(pack).length ? { pack } : {}) }, payload };
}
/** @param {PurchaseItemAppendPlan} plan @param {Transport} transport @returns {Promise<{remoteLineId:number}>} */
export async function applySpecialPurchaseItemAppend(plan, transport) {
  if (plan?.version !== 1 || plan.kind !== 'purchase_item_append' || !plan.baseline || !plan.payload) throw appendConflict('A saved PO update plan is required.');
  const order = { id: id(plan.purchaseOrderId), kind: 'purchase_order' };
  const read = async () => {
    try { return (await readSpecialRestOrder(order, transport)).snapshot; }
    catch (error) { throw friendlyReadError(error); }
  };
  let current = await read(), state = specialPurchaseItemAppendState(plan, current);
  if (state === 'baseline') {
    await transport.rest(recordPath(order), { method: 'PATCH', body: { item: { items: [plan.payload] } } });
    current = await read();
    state = specialPurchaseItemAppendState(plan, current);
  }
  if (state === 'baseline') throw appendConflict('NetSuite did not add the item to the PO. Retry the NetSuite update.');
  if (state !== 'applied') throw appendConflict('The NetSuite PO changed after this item was prepared. Check the PO in NetSuite, then retry or keep the item as a record only.');
  return { remoteLineId: id(current.lines.at(-1)?.remoteLineId) };
}

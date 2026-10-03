import { SPECIAL_PACK_FIELDS } from '../public/special-stock-line-details.js';
import { sumSpecialAmounts } from './special-stock-discount-total.js';
import { specialRestUnitId } from './special-stock-netsuite-adapter.js';
import { prepareSpecialAdjustmentPlan, specialAdjustmentMatches } from './special-stock-adjustment-adapter.js';
import { specialLineSubtotal, specialQuantity, specialPalletQuantity } from '../public/special-stock-pricing.js';

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
/** @param {Raw} line @param {Raw|undefined} row @returns {SnapshotLine} */
function snapshotLine(line, row) {
  if (!row || Number(row.rest_line_id) !== id(line.line) || Number(row.item) !== id(line.item?.id)) {
    throw conflict('NetSuite returned inconsistent order line identities.');
  }
  if (line.lineUniqueKey != null && id(line.lineUniqueKey) !== id(row.uniquekey)) throw conflict('NetSuite returned inconsistent stable line keys.');
  if (!['A', 'B'].includes(row.status) || row.execution_quantity == null || Number(row.execution_quantity) !== 0
    || row.billed_quantity == null || Number(row.billed_quantity) !== 0 || !['F', false].includes(row.line_closed)
    || line.isClosed === true) throw conflict('Only pending, unfulfilled, unreceived, unbilled and open orders can be adjusted.');
  if (line.rate == null || !Number.isFinite(Number(line.rate))) throw conflict('The complete remote rate is required.');
  const percentage = row.ratepercent == null ? null : Number(row.ratepercent);
  if (percentage !== null && !Number.isFinite(percentage)) throw conflict('The native discount rate could not be verified.');
  const unit = specialRestUnitId(line.units), discount = Number(line.item.id) === 10716;
  return { remoteLineId: id(row.uniquekey), itemId: id(line.item.id),
    quantity: discount ? null : specialQuantity(line.quantity), unitId: unit ? id(unit) : null,
    rate: percentage === null ? String(Number(line.rate)) : `${Number((percentage * 100).toPrecision(12))}%`,
    description: String(line.description || ''), locationId: line.location?.id ? id(line.location.id) : null,
    taxCode: String(line.taxCode?.id || ''), createdPoId: line.createdPo?.id ? id(line.createdPo.id) : null,
    createPo: String(line.createPo?.id ?? line.createPo ?? '') };
}
/** @param {Identity} order @param {Transport} transport @returns {Promise<{record:Raw,snapshot:Snapshot}>} */
export async function readSpecialRestOrder(order, { rest, queryAll }) {
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
  if (!record || !Array.isArray(source) || !source.length || source.length > 200 || rows.length !== source.length
    || new Set(rows.map(row => String(row.uniquekey))).size !== rows.length) throw conflict('A complete, distinct NetSuite order is required.');
  const lines = source.map(line => snapshotLine(line, rows.find(row => Number(row.rest_line_id) === id(line.line))));
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
    if (immutable.some(field => before[field] !== after[field]) || (!mutableRate && before.rate !== after.rate)
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
        || target.lines.filter(l=>l.itemId===4981).length!==1 || index!==target.lines.length-1) throw conflict('The vendor discount must remain one final purchase discount within the gross total.');
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
      const actual = current.lines[index], itemId = Number(line.item.id);
      return Object.values(SPECIAL_PACK_FIELDS).some(field => line[field] != null && Number(record.item.items[index][field] ?? 0) !== Number(line[field]))
        || actual.itemId !== itemId || actual.rate !== String(line.rate)
        || (itemId !== 10716 && (actual.quantity !== line.quantity || actual.unitId !== Number(line.units) || actual.description !== line.description));
    })) throw Object.assign(Error('The existing SO does not match the reviewed items, quantities, UOM, prices and discount amounts.'), { status: 409, code: 'SPECIAL_SO_PRICE_CONFLICT' });
}

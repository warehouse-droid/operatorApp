// A durable plan is saved by the service before either order is touched. Retries
// accept only the original or target quantity, and never apply a quantity delta.
import { specialRestUnitId } from './special-stock-netsuite-adapter.js';
/**
 * @typedef {{id:number,kind:string}} OrderIdentity
 * @typedef {{line:number,item:{id:string|number},quantity:number,units?:string|number|{id:string|number},rate?:string|number|null,description?:string}} RemoteLine
 * @typedef {{line:number,itemId:number,quantity:number,unitId:number|null,rate:number|null,description:string}} LineSnapshot
 * @typedef {{caseLineId:number,remoteLineId:number,itemId:number,quantity:number,toQuantity:number,unitId:number,rate:number,description:string,line?:number}} ExpectedLine
 * @typedef {{caseLineId:number,remoteLineId:number,line:number,toQuantity:number}} QuantityChange
 * @typedef {OrderIdentity & {baseline:LineSnapshot[],changes:QuantityChange[]}} PreparedOrder
 * @typedef {{uniquekey:number|string,rest_line_id:number|string,item:number|string,execution_quantity:number|string|null,billed_quantity:number|string|null,line_closed:string|boolean,status_text:string}} IdentityRow
 * @typedef {{rest:(path:string,options?:{method?:string,body?:{item:{items:{line:number,quantity:number}[]}}})=>Promise<{data?:{item?:{items?:RemoteLine[]}}}>,queryAll:(sql:string)=>Promise<IdentityRow[]>}} Boundary
 */
/** @param {string} message */
function conflict(message) {
  return Object.assign(new Error(message), { status: 409, code: 'SPECIAL_QUANTITY_REMOTE_CONFLICT' });
}
/** @param {unknown} value */
function id(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw conflict('The exact NetSuite order and line identities are required.');
  return result;
}
/** @param {unknown} value */
function quantity(value) {
  const result = Number(value);
  if (value === null || value === '' || !Number.isFinite(result) || result <= 0 || result > 1e9) throw conflict('A positive bounded quantity is required.');
  return result;
}
/** @param {OrderIdentity} order */
function recordPath(order) {
  if (!['sales_order', 'purchase_order'].includes(order.kind)) throw conflict('Unsupported order kind.');
  return `/record/v1/${order.kind === 'sales_order' ? 'salesOrder' : 'purchaseOrder'}/${id(order.id)}`;
}
/** @param {RemoteLine} line @returns {LineSnapshot} */
function snapshot(line) {
  const rate = line.rate == null || line.rate === '' ? null : Number(line.rate);
  if (rate !== null && !Number.isFinite(rate)) throw conflict('A remote rate could not be verified.');
  const unitId = specialRestUnitId(line.units);
  return { line: id(line.line), itemId: id(line.item?.id), quantity: Number(line.quantity),
    unitId: unitId ? id(unitId) : null, rate, description: String(line.description || '') };
}
/** @template {{remoteLineId:number,line?:number}} T
 * @param {OrderIdentity} order @param {T[]} changes @param {Boundary} boundary */
async function readOrder(order, changes, { rest, queryAll }) {
  const keys = changes.map(line => id(line.remoteLineId));
  if (!keys.length || new Set(keys).size !== keys.length) throw conflict('The changed order lines must have distinct identities.');
  const rows = await queryAll(`SELECT tl.uniquekey, tl.id AS rest_line_id, tl.item,
    ABS(NVL(tl.quantityshiprecv,0)) AS execution_quantity,
    ABS(NVL(tl.quantitybilled,0)) AS billed_quantity, tl.isclosed AS line_closed,
    BUILTIN.DF(t.status) AS status_text FROM transactionline tl
    JOIN transaction t ON t.id=tl.transaction
    WHERE tl.transaction = ${id(order.id)} AND tl.uniquekey IN (${keys.join(',')}) AND tl.mainline='F'`);
  const source = (await rest(`${recordPath(order)}?expandSubResources=true`)).data?.item?.items;
  if (!Array.isArray(source) || !source.length) throw conflict('The complete NetSuite order lines could not be read.');
  const lines = source.map(snapshot);
  if (new Set(lines.map(line => line.line)).size !== lines.length) throw conflict('NetSuite returned duplicate line identities.');
  const identities = changes.map(change => {
    const matches = rows.filter(row => Number(row.uniquekey) === id(change.remoteLineId));
    const row = matches[0];
    if (matches.length !== 1 || Number(row.item) !== 2055
      || !/^(?:Pending Approval|Pending Submission|Pending Fulfillment|Pending Receipt)$/i.test(String(row.status_text || '').trim().replace(/^(?:Sales Order|Purchase Order)\s*:\s*/i, ''))
      || row.execution_quantity == null || Number(row.execution_quantity) !== 0
      || row.billed_quantity == null || Number(row.billed_quantity) !== 0
      || !['F', false].includes(row.line_closed)) {
      throw conflict('Quantity changes require an open, unfulfilled, unreceived and unbilled MBBS-Special line.');
    }
    const line = id(row.rest_line_id);
    if (change.line && change.line !== line) throw conflict('The linked NetSuite line identity changed.');
    return { ...change, line };
  });
  return { lines, identities };
}
/** @param {PreparedOrder} order @param {LineSnapshot[]} current @param {{targetOnly?:boolean}} [options] */
function assertLines(order, current, { targetOnly = false } = {}) {
  if (current.length !== order.baseline.length) throw conflict('NetSuite order lines were added or removed.');
  for (const before of order.baseline) {
    const after = current.find(line => line.line === before.line);
    const change = order.changes.find(line => line.line === before.line);
    const allowed = change ? (targetOnly ? [change.toQuantity] : [before.quantity, change.toQuantity]) : [before.quantity];
    if (!after || !allowed.includes(after.quantity) || after.itemId !== before.itemId
      || after.unitId !== before.unitId || after.rate !== before.rate || after.description !== before.description) {
      throw conflict('NetSuite quantities, rates, units, descriptions or unrelated lines changed. Refresh and resolve the conflict.');
    }
  }
}
/** @param {{orders:(OrderIdentity & {lines:ExpectedLine[]})[]}} input @param {Boundary} dependencies */
export async function prepareSpecialQuantityPlan({ orders }, dependencies) {
  if (!Array.isArray(orders) || !orders.length || orders.length > 2
    || new Set(orders.map(order => id(order.id))).size !== orders.length) throw conflict('An exact SO/PO pair is required.');
  const prepared = [];
  for (const order of orders) {
    const { lines, identities } = await readOrder(order, order.lines, dependencies);
    const changes = identities.map(change => {
      const before = lines.find(line => line.line === change.line);
      if (!before || Number(change.itemId) !== 2055 || before.itemId !== 2055
        || before.quantity !== quantity(change.quantity) || before.unitId !== id(change.unitId)
        || before.rate !== Number(change.rate) || before.description !== String(change.description || '')) {
        throw conflict('The exact linked order line no longer matches the reviewed quantity, price or unit.');
      }
      return { caseLineId: id(change.caseLineId), remoteLineId: id(change.remoteLineId), line: change.line,
        toQuantity: quantity(change.toQuantity) };
    });
    if (new Set(changes.map(change => change.line)).size !== changes.length) throw conflict('A NetSuite line cannot be updated twice.');
    prepared.push({ id: id(order.id), kind: order.kind, baseline: lines, changes });
  }
  return { version: 1, orders: prepared };
}
/** @param {{version:number,orders:PreparedOrder[]}} plan @param {Boundary} dependencies */
export async function applySpecialQuantityPlan(plan, dependencies) {
  if (plan?.version !== 1 || !Array.isArray(plan.orders) || !plan.orders.length) throw conflict('A saved quantity review plan is required.');
  // Check both records before the first write, including on recovery.
  for (const order of plan.orders) assertLines(order, (await readOrder(order, order.changes, dependencies)).lines);
  for (const order of plan.orders) {
    const { lines } = await readOrder(order, order.changes, dependencies);
    assertLines(order, lines);
    const pending = order.changes.filter(change => lines.find(line => line.line === change.line)?.quantity !== change.toQuantity);
    if (pending.length) await dependencies.rest(recordPath(order), { method: 'PATCH', body: {
      item: { items: pending.map(change => ({ line: change.line, quantity: change.toQuantity })) }
    } });
    assertLines(order, (await readOrder(order, order.changes, dependencies)).lines, { targetOnly: true });
  }
  for (const order of plan.orders) assertLines(order, (await readOrder(order, order.changes, dependencies)).lines, { targetOnly: true });
  return { verifiedOrderIds: plan.orders.map(order => order.id) };
}

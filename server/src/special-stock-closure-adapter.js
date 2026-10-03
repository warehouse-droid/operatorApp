import { specialRestUnitId } from './special-stock-netsuite-adapter.js';
/** @typedef {{line:number,remoteLineId:number,itemId:number,closed:boolean,queryOnly?:boolean,queryFingerprint:string|null,quantity?:number|null,unitId?:string|number,rate?:string|null,description?:string}} ClosureLine */
/** @typedef {Record<string,any>} Raw */
/** @typedef {{id:number,kind:string}} Identity */
/** @typedef {Identity & {lines:{remoteLineId:number,itemId:number,quantity:number,unitId?:number,description?:string}[],discountCount?:number}} InputOrder */
/** @typedef {Identity & {lines:ClosureLine[]}} PreparedOrder */
/** @typedef {{rest:(path:string,options?:{method?:string,body?:Raw})=>Promise<{data?:Raw}>,queryAll:(sql:string)=>Promise<Raw[]>}} Boundary */
/** @param {string} message */
const conflict = message => Object.assign(Error(message), { status: 409, code: 'SPECIAL_CLOSURE_REMOTE_CONFLICT' });
/** @param {unknown} value */
function id(value) {
  const n = Number(value); if (!Number.isSafeInteger(n) || n <= 0) throw conflict('Exact NetSuite order and line identities are required.'); return n;
}
/** @param {Identity} order */
function path(order) {
  if (!['sales_order','purchase_order'].includes(order.kind)) throw conflict('Unsupported order kind.');
  return `/record/v1/${order.kind === 'sales_order' ? 'salesOrder' : 'purchaseOrder'}/${id(order.id)}`;
}
/** @param {Raw} line */
function snapshot(line) {
  return { line: id(line.line), itemId: id(line.item?.id), quantity: line.quantity == null ? null : Number(line.quantity),
    unitId: specialRestUnitId(line.units), rate: line.rate == null ? null : String(line.rate), description: String(line.description || '') };
}
/** @param {Raw} row */
function queryFingerprint(row) {
  const discount = Number(row.item) === 10716;
  if (row.line_rate == null || !Number.isFinite(Number(row.line_rate))
    || (!discount && (row.base_quantity == null || !Number.isFinite(Number(row.base_quantity)) || Number(row.base_quantity) === 0))
    || (row.line_rate_percent != null && !Number.isFinite(Number(row.line_rate_percent)))) return null;
  return JSON.stringify([discount ? null : Number(row.base_quantity), row.unit_id == null ? null : String(id(row.unit_id)),
    Number(row.line_rate), row.line_rate_percent == null ? null : Number(row.line_rate_percent), String(row.description || '')]);
}
/** @param {unknown} error */
function workflowLocked(error) {
  if (!error || typeof error !== 'object') return false;
  const cause = /** @type {Raw} */ (error);
  return cause.status === 400 && cause.netsuiteErrorCodes?.includes('USER_ERROR')
    && /record has been locked by a user defined workflow/i.test(cause.message);
}
/** @param {Raw[]} rows @returns {ClosureLine[]} */
function closedQueryLines(rows) {
  if (!rows.length || rows.length > 200) throw conflict('Complete closed-order evidence is required.');
  const lines = rows.map(row => {
    const fingerprint = queryFingerprint(row);
    if (!/^(?:Closed|Cancelled|Canceled)$/i.test(String(row.status_text || '').replace(/^(Sales Order|Purchase Order)\s*:\s*/i,''))
      || (Number(row.item) !== 10716 && !['T',true].includes(row.line_closed)) || row.execution_quantity == null || Number(row.execution_quantity) !== 0
      || row.billed_quantity == null || Number(row.billed_quantity) !== 0 || !fingerprint) {
      throw conflict('The workflow-locked order is not verified closed, unexecuted and unbilled.');
    }
    return { line: id(row.rest_line_id), remoteLineId: id(row.uniquekey), itemId: id(row.item),
      closed: true, queryOnly: true, queryFingerprint: fingerprint };
  });
  if (new Set(lines.map(line=>line.line)).size !== lines.length || new Set(lines.map(line=>line.remoteLineId)).size !== lines.length) {
    throw conflict('NetSuite returned inconsistent closed-order identities.');
  }
  return lines;
}
/** @param {Identity} order @param {Boundary} boundary @returns {Promise<ClosureLine[]>} */
async function read(order, { rest, queryAll }) {
  const sql = `SELECT tl.uniquekey,tl.id AS rest_line_id,tl.item,
    tl.quantity AS base_quantity,tl.rate AS line_rate,tl.ratepercent AS line_rate_percent,
    tl.units AS unit_id,tl.memo AS description,
    ABS(NVL(tl.quantityshiprecv,0)) AS execution_quantity,ABS(NVL(tl.quantitybilled,0)) AS billed_quantity,
    tl.isclosed AS line_closed,BUILTIN.DF(t.status) AS status_text
    FROM transactionline tl JOIN transaction t ON t.id=tl.transaction
    WHERE tl.transaction = ${id(order.id)} AND tl.mainline='F' AND tl.taxline='F' AND tl.item IS NOT NULL`;
  const rows = await queryAll(sql);
  let source;
  try { source = (await rest(`${path(order)}?expandSubResources=true`, { method: 'GET' })).data?.item?.items; }
  catch (error) {
    if (!workflowLocked(error)) throw error;
    // Closed-state workflows can prevent even GET. Fresh query evidence verifies
    // terminal state without reopening a record or changing workflow permissions.
    return closedQueryLines(await queryAll(sql));
  }
  if (!Array.isArray(source) || !source.length || !rows.length) throw conflict('The complete NetSuite order lines could not be verified.');
  const lines = source.map(line => {
    const matches = rows.filter(row => Number(row.rest_line_id) === id(line.line)), row = matches[0];
    if (matches.length !== 1 || Number(row.item) !== Number(line.item?.id)
      || row.execution_quantity == null || Number(row.execution_quantity) !== 0
      || row.billed_quantity == null || Number(row.billed_quantity) !== 0
      || !['T','F',true,false].includes(row.line_closed)
      || !/^(?:Pending Approval|Pending Submission|Pending Fulfillment|Pending Receipt|Closed|Cancelled|Canceled)$/i.test(String(row.status_text || '').replace(/^(Sales Order|Purchase Order)\s*:\s*/i,''))) {
      throw conflict('Closing requires unfulfilled, unreceived and unbilled order lines.');
    }
    const discount=Number(line.item?.id)===10716;
    const closed = discount || ['T',true].includes(row.line_closed);
    if (!discount && closed !== (line.isClosed === true)) throw conflict('NetSuite closure status is still synchronizing. Preview and retry.');
    return { ...snapshot(line), remoteLineId: id(row.uniquekey), closed, queryFingerprint: queryFingerprint(row) };
  });
  if (new Set(lines.map(line => line.line)).size !== lines.length || lines.length !== rows.length) throw conflict('NetSuite returned inconsistent order lines.');
  return lines;
}
/** @param {PreparedOrder} order @param {ClosureLine[]} current */
function assertBaseline(order, current) {
  if (current.length !== order.lines.length) throw conflict('NetSuite order lines were added or removed.');
  for (const before of order.lines) {
    const after = current.find(line => line.line === before.line);
    const queryOnly = before.queryOnly || after?.queryOnly;
    const fields = /** @type {(keyof ClosureLine)[]} */ (['quantity','unitId','rate','description']);
    if (!after || after.remoteLineId !== before.remoteLineId || after.itemId !== before.itemId || (before.closed && !after.closed)
      || (queryOnly ? !before.queryFingerprint || before.queryFingerprint !== after.queryFingerprint
        : fields.some(key => after[key] !== before[key]))) {
      throw conflict('NetSuite order lines changed after SCM confirmation. Resolve the difference before closing.');
    }
  }
}
/** @param {Identity[]} orders */
function assertClosureOrders(orders) {
  if (!Array.isArray(orders) || ![1, 2].includes(orders.length)
    || new Set(orders.map(o => id(o.id))).size !== orders.length
    || orders.filter(o => o.kind === 'sales_order').length !== 1
    || orders.filter(o => o.kind === 'purchase_order').length !== orders.length - 1) {
    throw conflict('The exact linked Sales Order and any linked Purchase Order are required.');
  }
}
/** @param {{orders:InputOrder[]}} input @param {Boundary} boundary */
export async function prepareSpecialClosurePlan({ orders }, boundary) {
  assertClosureOrders(orders);
  const prepared = [];
  for (const order of orders) {
    path(order);
    const lines = await read(order, boundary);
    const discounts=lines.filter(line=>line.itemId===10716);
    if (discounts.length !== (order.discountCount || 0) || order.lines.length !== lines.length-discounts.length) throw conflict('The complete NetSuite order must match this request.');
    for (const expected of order.lines) {
      const line = lines.find(row => row.remoteLineId === id(expected.remoteLineId));
      if (!line || line.itemId !== Number(expected.itemId) || (!line.queryOnly && (line.quantity !== Number(expected.quantity)
        || line.description !== String(expected.description || '') || Number(line.unitId) !== Number(expected.unitId)))) {
        throw conflict('The exact linked NetSuite lines no longer match this request.');
      }
    }
    prepared.push({ id: id(order.id), kind: order.kind, lines });
  }
  return { version: 1, orders: prepared.sort((a,b) => (a.kind === 'purchase_order' ? 0 : 1) - (b.kind === 'purchase_order' ? 0 : 1)) };
}
/** @param {{version:number,orders:PreparedOrder[]}} plan @param {Boundary} boundary */
export async function applySpecialClosurePlan(plan, boundary) {
  if (plan?.version !== 1) throw conflict('A saved closure plan is required.');
  assertClosureOrders(plan.orders);
  // Verify every linked order before the first write, and every readback.
  for (const order of plan.orders) assertBaseline(order, await read(order, boundary));
  for (const order of plan.orders) {
    const current = await read(order, boundary); assertBaseline(order, current);
    const open = current.filter(line => !line.closed);
    if (open.length) await boundary.rest(path(order), { method: 'PATCH', body: { item: { items: open.map(line => ({ line: line.line, isClosed: true })) } } });
    const after = await read(order,boundary); assertBaseline(order,after);
    if (after.some(line=>!line.closed)) throw conflict('NetSuite did not confirm this order closed. Retry closure.');
  }
  for (const order of plan.orders) {
    const current = await read(order, boundary); assertBaseline(order, current);
    if (current.some(line => !line.closed)) throw conflict('NetSuite has not confirmed the linked orders closed. Retry closure.');
  }
  return { verifiedOrderIds: plan.orders.map(order => order.id) };
}

/**
 * @typedef {{itemId:number,itemName?:string,uom:string,quantity:number,unitId?:number,remoteLineId?:number,caseLineId?:number,description?:string,previousDescription?:string,previousQuantity?:number,previousUnitId?:number,previousUom?:string,rate?:number}} SpecialLine
 * @typedef {{line:number,item:{id:string|number},quantity:number,units?:string|number|{id:string|number},description?:string,rate?:string|number,createdPo?:{id:string|number},createPo?:{id:string},quantityReceived?:number,quantityBilled?:number,isClosed?:boolean}} RemoteLine
 * @typedef {{internalId?:string|number,id?:string|number,abbreviation?:string,pluralAbbreviation?:string,unitName?:string,pluralName?:string}} RemoteUnit
 * @typedef {{unitstype?:string|number,stock_unit_id?:string|number,stock_unit?:string,sales_unit_id?:string|number,sales_unit?:string,purchase_unit_id?:string|number,purchase_unit?:string,uniquekey?:string|number,rest_line_id?:string|number,item?:string|number,execution_quantity?:number|string,billed_quantity?:number|string,line_closed?:boolean|string}} UnitMetadata
 * @typedef {{rest:(path:string,options?:{method?:string,body?:{discountItem?:{id:string},discountRate?:number,item:{items:{line:number,description:string,quantity?:number,units?:string,rate?:number}[]}}})=>Promise<{data?:{discountItem?:{id:string},discountRate?:number,item?:{items?:RemoteLine[]},uom?:{items?:RemoteUnit[]},createdFrom?:{id:string|number},entity?:{id:string|number},orderStatus?:{id:string}}}>,queryAll:(sql:string)=>Promise<UnitMetadata[]>}} Boundary
 */
/** @param {string} message @param {string} code */
function error(message, code = 'SPECIAL_SO_LINE_CONFLICT') {
  return Object.assign(new Error(message), { status: 409, code });
}
/** @param {unknown} value */
function id(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw error('A valid NetSuite identity is required.');
  return number;
}
/** @param {unknown} value */
const normalized = value => String(value || '').trim().toUpperCase();

/** REST transaction units are scalar IDs; retain compatibility with reference-shaped records.
 * @param {RemoteLine['units']} units */
export function specialRestUnitId(units) {
  return typeof units === 'object' ? units?.id : units;
}

/** @param {SpecialLine[]} lines @param {Boundary} dependencies */
export async function resolveSpecialUnits(lines, { rest, queryAll }) {
  const types = new Map();
  /** @type {Map<number, RemoteUnit[]>} */
  const units = new Map();
  const result = [];
  for (const line of lines) {
    const itemId = id(line.itemId);
    if (!types.has(itemId)) {
      const rows = await queryAll(`SELECT id, unitstype, stockunit AS stock_unit_id, BUILTIN.DF(stockunit) AS stock_unit,
        saleunit AS sales_unit_id, BUILTIN.DF(saleunit) AS sales_unit,
        purchaseunit AS purchase_unit_id, BUILTIN.DF(purchaseunit) AS purchase_unit
        FROM item WHERE id = ${itemId} AND isinactive = 'F'`);
      if (rows.length !== 1) throw error('This item has no active NetSuite units type.', 'SPECIAL_UOM_INVALID');
      types.set(itemId, rows[0]);
    }
    const metadata = types.get(itemId);
    if (!metadata.unitstype) {
      if (itemId === 1987 && !line.uom) { result.push({ ...line }); continue; }
      throw error('This item has no active NetSuite units type.', 'SPECIAL_UOM_INVALID');
    }
    // Configured item units carry native IDs and do not require permission to
    // read the separate Units list. Preserve the user's quantity without conversion.
    const configured = new Set([[metadata.stock_unit_id, metadata.stock_unit],
      [metadata.sales_unit_id, metadata.sales_unit], [metadata.purchase_unit_id, metadata.purchase_unit]]
      .filter(([unitId, label]) => unitId && label && normalized(label) === normalized(line.uom))
      .map(([unitId]) => id(unitId)));
    if (configured.size > 1) throw error('This item has ambiguous native unit labels.', 'SPECIAL_UOM_INVALID');
    if (configured.size === 1) {
      result.push({ ...line, unitId: [...configured][0] });
      continue;
    }
    const typeId = id(metadata.unitstype);
    if (!units.has(typeId)) {
      const response = await rest(`/record/v1/unitsType/${typeId}?expandSubResources=true`);
      units.set(typeId, response.data?.uom?.items || []);
    }
    const matches = (units.get(typeId) || []).filter(unit => [unit.abbreviation, unit.pluralAbbreviation, unit.unitName, unit.pluralName].some(name => normalized(name) === normalized(line.uom)));
    if (!line.uom || matches.length !== 1) throw error(`Select a native NetSuite UOM for ${line.itemName || line.itemId}: ${line.uom || '(empty)'}.`, 'SPECIAL_UOM_INVALID');
    result.push({ ...line, unitId: id(matches[0].internalId ?? matches[0].id) });
  }
  return result;
}

/** @param {{salesOrderId:number,vendorId?:number,discountTotal?:{before:number,after:number},changes:(SpecialLine & {remoteLineId:number,description:string,previousDescription:string})[]}} input @param {Boundary} dependencies */
export async function synchronizeSpecialDescriptions({ salesOrderId, vendorId, changes, discountTotal }, { rest, queryAll }) {
  const orderId = id(salesOrderId);
  if (!changes.length) return;
  const keys = changes.map(change => id(change.remoteLineId));
  if (new Set(keys).size !== keys.length) throw error('SO line identities must be distinct.');
  const rows = await queryAll(`SELECT tl.uniquekey, tl.id AS rest_line_id, tl.item,
    ABS(NVL(tl.quantityshiprecv,0)) AS execution_quantity, ABS(NVL(tl.quantitybilled,0)) AS billed_quantity,
    tl.isclosed AS line_closed FROM transactionline tl
    WHERE tl.transaction = ${orderId} AND tl.uniquekey IN (${keys.join(',')}) AND tl.mainline = 'F'`);
  const beforeRecord = (await rest(`/record/v1/salesOrder/${orderId}?expandSubResources=true`)).data;
  const before = beforeRecord?.item?.items;
  if (!Array.isArray(before)) throw error('NetSuite SO items could not be read.');
  const verified = changes.map(change => {
    const identity = rows.filter(row => Number(row.uniquekey) === Number(change.remoteLineId));
    if (identity.length !== 1 || Number(identity[0].item) !== 2055) throw error('The exact linked MBBS-Special SO line is missing.');
    const lineId = id(identity[0].rest_line_id);
    const matches = before.filter(line => Number(line.line) === lineId);
    const line = matches[0];
    /** @param {string} description @param {number} quantity @param {number|undefined} unitId */
    const tupleMatches = (description, quantity, unitId) => String(line?.description || '') === description
      && Number(line?.quantity) === Number(quantity) && (!unitId || Number(specialRestUnitId(line?.units)) === Number(unitId));
    const target = tupleMatches(change.description, change.quantity, change.unitId);
    const original = tupleMatches(change.previousDescription, change.previousQuantity ?? change.quantity, change.previousUnitId ?? change.unitId);
    const changesAmount = Number(change.previousQuantity ?? change.quantity) !== Number(change.quantity)
      || Number(change.previousUnitId ?? change.unitId) !== Number(change.unitId);
    if (matches.length !== 1 || Number(line.item?.id) !== 2055 || !(target || original)
        || (change.rate != null && Number(line.rate) !== Number(change.rate))
        || (changesAmount && (Number(identity[0].execution_quantity) !== 0 || Number(identity[0].billed_quantity) !== 0 || (identity[0].line_closed !== 'F' && identity[0].line_closed !== false)))) {
      throw error('The linked SO line changed in NetSuite; refresh and resolve the conflict before creating a PO.');
    }
    return { change, lineId, line, target, changesAmount };
  });
  const pending = verified.filter(({target}) => !target);
  const discountPending = discountTotal && Number(beforeRecord?.discountRate || 0) !== discountTotal.after;
  if (discountTotal && ((beforeRecord?.discountItem?.id && String(beforeRecord.discountItem.id) !== '10716')
    || ![discountTotal.before,discountTotal.after].includes(Number(beforeRecord?.discountRate || 0))
    || before.some(line => Number(line.item?.id) === 10716))) throw error('The SO total discount changed before the SCM review.');
  if ((pending.length || discountPending) && before.some(line => line.createPo?.id && !line.createdPo?.id)) {
    throw error('A native PO creation is already pending on this SO. Wait for its link before applying the SCM review.', 'SPECIAL_REMOTE_OUTCOME_UNCERTAIN');
  }
  for (const poId of new Set(pending.filter(({line}) => line.createdPo?.id).map(({line}) => id(line.createdPo?.id)))) {
    const po = (await rest(`/record/v1/purchaseOrder/${poId}?expandSubResources=true`)).data;
    if (Number(po?.createdFrom?.id) !== orderId || (vendorId && Number(po?.entity?.id) !== Number(vendorId))
      || !['A', 'B'].includes(po?.orderStatus?.id || '') || !po?.item?.items?.length
      || po.item.items.some(line => line.isClosed || Number(line.quantityReceived || 0) !== 0 || Number(line.quantityBilled || 0) !== 0)) {
      throw error('The existing linked PO must be open, unreceived, unbilled and for the reviewed vendor before correcting the SO.');
    }
  }
  if (pending.length || discountPending) await rest(`/record/v1/salesOrder/${orderId}`, { method: 'PATCH', body: {
    ...(discountPending ? { discountItem: { id: '10716' }, discountRate: discountTotal.after } : {}),
    item: { items: pending.map(({change,lineId,line,changesAmount}) => ({ line: lineId, description: change.description,
      ...(changesAmount ? { quantity: change.quantity, units: String(id(change.unitId)), rate: Number(line.rate) } : {}) })) }
  }});
  const afterRecord = (await rest(`/record/v1/salesOrder/${orderId}?expandSubResources=true`)).data;
  const after = afterRecord?.item?.items;
  if (discountTotal && (Number(afterRecord?.discountRate || 0) !== discountTotal.after
    || (discountTotal.after !== 0 && String(afterRecord?.discountItem?.id) !== '10716'))) throw error('SO total discount verification failed after the SCM review.');
  if (!Array.isArray(after) || after.length !== before.length) throw error('SO line verification failed after description update.');
  // Verify every original line, including prices and unrelated ancillary lines.
  for (const previous of before) {
    const current = after.filter(line => Number(line.line) === Number(previous.line));
    const change = verified.find(entry => entry.lineId === Number(previous.line))?.change;
    if (current.length !== 1 || Number(current[0].item?.id) !== Number(previous.item?.id)
      || Number(current[0].quantity ?? 0) !== Number((change ? change.quantity : previous.quantity) ?? 0)
      || String(specialRestUnitId(current[0].units) || '') !== String(change?.unitId || specialRestUnitId(previous.units) || '')
      || String(current[0].rate ?? '') !== String(previous.rate ?? '')
      || String(current[0].description || '') !== String(change ? change.description : previous.description || '')) {
      throw error('SO verification failed: quantities, rates, units or other lines changed.');
    }
  }
}

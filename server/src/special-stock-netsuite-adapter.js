/**
 * @typedef {{itemId:number,itemName?:string,uom:string,quantity:number,unitId?:number,remoteLineId?:number,caseLineId?:number,description?:string,previousDescription?:string}} SpecialLine
 * @typedef {{line:number,item:{id:string|number},quantity:number,units?:{id:string|number},description?:string,rate?:string|number}} RemoteLine
 * @typedef {{internalId?:string|number,id?:string|number,abbreviation?:string,pluralAbbreviation?:string,unitName?:string,pluralName?:string}} RemoteUnit
 * @typedef {{unitstype?:string|number,stock_unit_id?:string|number,stock_unit?:string,sales_unit_id?:string|number,sales_unit?:string,purchase_unit_id?:string|number,purchase_unit?:string,uniquekey?:string|number,rest_line_id?:string|number,item?:string|number}} UnitMetadata
 * @typedef {{rest:(path:string,options?:{method?:string,body?:{item:{items:{line:number,description:string}[]}}})=>Promise<{data?:{item?:{items?:RemoteLine[]},uom?:{items?:RemoteUnit[]}}}>,queryAll:(sql:string)=>Promise<UnitMetadata[]>}} Boundary
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
      if (rows.length !== 1 || !rows[0].unitstype) throw error('This item has no active NetSuite units type.', 'SPECIAL_UOM_INVALID');
      types.set(itemId, rows[0]);
    }
    const metadata = types.get(itemId);
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

/** @param {{salesOrderId:number,changes:(SpecialLine & {remoteLineId:number,description:string,previousDescription:string})[]}} input @param {Boundary} dependencies */
export async function synchronizeSpecialDescriptions({ salesOrderId, changes }, { rest, queryAll }) {
  const orderId = id(salesOrderId);
  if (!changes.length) return;
  const keys = changes.map(change => id(change.remoteLineId));
  if (new Set(keys).size !== keys.length) throw error('SO line identities must be distinct.');
  const rows = await queryAll(`SELECT tl.uniquekey, tl.id AS rest_line_id, tl.item FROM transactionline tl
    WHERE tl.transaction = ${orderId} AND tl.uniquekey IN (${keys.join(',')}) AND tl.mainline = 'F'`);
  const before = (await rest(`/record/v1/salesOrder/${orderId}?expandSubResources=true`)).data?.item?.items;
  if (!Array.isArray(before)) throw error('NetSuite SO items could not be read.');
  const verified = changes.map(change => {
    const identity = rows.filter(row => Number(row.uniquekey) === Number(change.remoteLineId));
    if (identity.length !== 1 || Number(identity[0].item) !== 2055) throw error('The exact linked MBBS-Special SO line is missing.');
    const lineId = id(identity[0].rest_line_id);
    const matches = before.filter(line => Number(line.line) === lineId);
    const line = matches[0];
    if (matches.length !== 1 || Number(line.item?.id) !== 2055 || Number(line.quantity) !== Number(change.quantity)
        || (change.unitId && Number(line.units?.id) !== Number(change.unitId))
        || ![change.previousDescription, change.description].includes(String(line.description || ''))) {
      throw error('The linked SO line changed in NetSuite; refresh and resolve the conflict before creating a PO.');
    }
    return { change, lineId, line };
  });
  const pending = verified.filter(({change,line}) => line.description !== change.description);
  if (pending.length) await rest(`/record/v1/salesOrder/${orderId}`, { method: 'PATCH', body: {
    item: { items: pending.map(({change,lineId}) => ({ line: lineId, description: change.description })) }
  }});
  const after = (await rest(`/record/v1/salesOrder/${orderId}?expandSubResources=true`)).data?.item?.items;
  if (!Array.isArray(after) || after.length !== before.length) throw error('SO line verification failed after description update.');
  // Verify every original line, including prices and unrelated ancillary lines.
  for (const previous of before) {
    const current = after.filter(line => Number(line.line) === Number(previous.line));
    const change = verified.find(entry => entry.lineId === Number(previous.line))?.change;
    if (current.length !== 1 || Number(current[0].item?.id) !== Number(previous.item?.id)
      || Number(current[0].quantity) !== Number(previous.quantity)
      || String(current[0].units?.id || '') !== String(previous.units?.id || '')
      || String(current[0].rate ?? '') !== String(previous.rate ?? '')
      || String(current[0].description || '') !== String(change ? change.description : previous.description || '')) {
      throw error('SO verification failed: quantities, rates, units or other lines changed.');
    }
  }
}

/** NetSuite item metadata is the authority for purchase units and eligibility.
 * @typedef {Record<string,any>} Raw
 * @typedef {{queryAll:(sql:string)=>Promise<Raw[]>,rest:(path:string)=>Promise<{data?:Raw}>}} Boundary
 */
/** @param {unknown} value */
const normalized = value => String(value ?? '').trim().toUpperCase();
/** @param {string} message */
function invalid(message, code = 'SPECIAL_UOM_INVALID') {
  return Object.assign(new Error(message), {status:400,code});
}
/** @param {unknown} value */
function identity(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw invalid('A valid NetSuite item or unit ID is required.');
  }
  return number;
}
/** @param {Raw} unit @param {number} typeId */
function unitChoice(unit, typeId) {
  const self = (/** @type {Raw[]} */ (unit.links || [])).filter(link => link.rel === 'self');
  const match = self.length === 1 ? String(self[0].href).match(/\/record\/v1\/unitstype\/(\d+)\/uom\/(\d+)\/?$/i) : null;
  const id = identity(unit.internalId ?? unit.id ?? (Number(match?.[1]) === typeId ? match?.[2] : null));
  const aliases = [...new Set([unit.abbreviation,unit.pluralAbbreviation,unit.unitName,unit.pluralName].map(normalized).filter(Boolean))];
  if (!aliases.length) {
    throw invalid('NetSuite returned a unit without a label.');
  }
  return {id,name:aliases[0],aliases};
}

/** @param {number} itemId @param {Boundary} boundary */
export async function listSpecialPurchaseUnits(itemId, {queryAll,rest}) {
  const rows = await queryAll(`SELECT id,itemtype,subtype,isinactive,unitstype,purchaseunit AS purchase_unit_id
    FROM item WHERE id=${identity(itemId)} AND isinactive='F'`);
  const row = rows[0];
  if (rows.length !== 1 || Number(row.id) !== Number(itemId) || row.isinactive === 'T' || row.isinactive === true
      || !['InvtPart','NonInvtPart','Service','OthCharge','Assembly'].includes(row.itemtype)
      || ['Sale','Sales'].includes(row.subtype)) {
    throw invalid('Select an active NetSuite item that can be purchased.', 'SPECIAL_PO_ITEM_INVALID');
  }
  if (!row.unitstype) {
    return {itemId:Number(itemId),units:[],noUnits:true,defaultUnitId:null};
  }
  const typeId = identity(row.unitstype);
  const response = await rest(`/record/v1/unitsType/${typeId}?expandSubResources=true`);
  const units = (/** @type {Raw[]} */ (response.data?.uom?.items || [])).map(unit => unitChoice(unit,typeId));
  if (!units.length || new Set(units.map(unit => unit.id)).size !== units.length) {
    throw invalid('The complete NetSuite units list could not be read. Reload the UOM options.');
  }
  return {itemId:Number(itemId),units,noUnits:false,
    defaultUnitId:units.find(unit => unit.id === Number(row.purchase_unit_id))?.id ?? units[0].id};
}

/** @param {Raw[]} lines @param {Boundary} boundary */
export async function resolveSpecialPurchaseUnits(lines, boundary) {
  /** @type {Map<number,Awaited<ReturnType<typeof listSpecialPurchaseUnits>>>} */
  const catalogs = new Map();
  const result = [];
  for (const line of lines) {
    const itemId = identity(line.itemId);
    if (!catalogs.has(itemId)) {
      catalogs.set(itemId,await listSpecialPurchaseUnits(itemId,boundary));
    }
    const catalog = /** @type {Awaited<ReturnType<typeof listSpecialPurchaseUnits>>} */ (catalogs.get(itemId));
    if (catalog.noUnits) {
      if (normalized(line.uom) || line.unitId) {
        throw invalid('This NetSuite item does not use a UOM. Choose No unit.');
      }
      result.push({...line,uom:'',unitId:null});
      continue;
    }
    const matches = catalog.units.filter(unit => unit.aliases.includes(normalized(line.uom))
      && (!line.unitId || unit.id === Number(line.unitId)));
    if (matches.length !== 1) {
      throw invalid('Select a valid UOM from this item’s NetSuite units list.');
    }
    result.push({...line,uom:matches[0].name,unitId:matches[0].id});
  }
  return result;
}

// @ts-check
export const INVENTORY_YARDS = Object.freeze([{id:1,name:'3445'},{id:28,name:'2967'},{id:15,name:'12441'},{id:26,name:'150'}]);
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export const PHYSICAL_UNITS = Object.freeze([
  {key:'pallets',label:'PLT',factor:'to_plt'}, {key:'layers',label:'LYR',factor:'to_lyr'},
  {key:'sections',label:'SEC',factor:'to_sec'}, {key:'pieces',label:'PCS',factor:'to_pcs'}
]);
/** @param {string} message @param {number} [status] @param {string} [code] */
export function inventoryError(message, status=400, code='INVENTORY_INVALID') { return Object.assign(new Error(message),{status,code}); }
/** @param {unknown} value @param {string} [label] */
export function inventoryId(value,label='ID') {
  if (!/^[1-9]\d*$/.test(String(value ?? '')) || !Number.isSafeInteger(Number(value))) {throw inventoryError(`A valid ${label} is required.`);}
  return Number(value);
}
/** @param {Date} [now] */
export function inventoryDate(now=new Date()) {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
/** @param {unknown} month */
export function inventoryMonth(month) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(String(month))) {throw inventoryError('Select a valid month.');}
  return String(month);
}
/** @param {number} yard @param {string} month */
export function damageMemo(yard,month) {
  const location=INVENTORY_YARDS.find(row=>row.id===Number(yard));
  if (!location) {throw inventoryError('Select a valid yard.');}
  const [year,part]=inventoryMonth(month).split('-');
  return `${location.name} ${year} ${MONTHS[Number(part)-1]} Damage`;
}
/** @param {unknown} memo */
export function damageMemoMonth(memo) {
  const text=String(memo || '');
  if (!/\bdamage\b/i.test(text)) {return null;}
  const numeric=text.match(/\b(20\d{2})-(0[1-9]|1[0-2])\b/);
  if (numeric) {return `${numeric[1]}-${numeric[2]}`;}
  const named=text.match(/\b(20\d{2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b/i);
  if (!named) {return null;}
  const index=MONTHS.findIndex(m=>m.toLowerCase()===(named[2] || '').slice(0,3).toLowerCase());
  return `${named[1]}-${String(index+1).padStart(2,'0')}`;
}
/** @param {any[]} directory @param {number} yard */
export function damageDestination(directory,yard) {
  const root=directory.find(row=>Number(row.id)===Number(yard) && !/^(T|true)$/i.test(String(row.isinactive)));
  const code=INVENTORY_YARDS.find(row=>row.id===Number(yard))?.name;
  const children=directory.filter(row=>Number(row.parent)===Number(yard) && !/^(T|true)$/i.test(String(row.isinactive)) && String(row.name).toLowerCase()===`${code} damage`);
  if (!root || !code || children.length!==1) {throw inventoryError('This yard needs exactly one active Damage child location.',409,'INVENTORY_DAMAGE_LOCATION');}
  return {sourceId:Number(yard),destinationId:inventoryId(children[0].id),subsidiaryId:inventoryId(root.subsidiary,'subsidiary')};
}
/** @param {any} actor @param {boolean} [management] */
export function inventoryYards(actor,management=false) {
  const roles=new Set([actor?.role,...(actor?.roles || [])]);
  if (roles.has('admin')) {return INVENTORY_YARDS.map(y=>y.id);}
  if (management ? !roles.has('yard_manager') : !roles.has('operator') && !roles.has('yard_manager')) {throw inventoryError('Inventory access is not assigned.',403,'INVENTORY_FORBIDDEN');}
  const assigned=management ? actor.yardLocationIds : actor.operatorYardLocationIds;
  return INVENTORY_YARDS.filter(y=>(assigned || []).map(Number).includes(y.id)).map(y=>y.id);
}
/** @param {any} actor @param {unknown} yard @param {boolean} [management] */
export function assertInventoryYard(actor,yard,management=false) {
  const id=inventoryId(yard,'yard');
  if (!inventoryYards(actor,management).includes(id)) {throw inventoryError('This yard is outside your assigned access.',403,'INVENTORY_FORBIDDEN');}
  return id;
}
/** @param {unknown} value */
function amount(value) {
  if ((typeof value!=='number' && typeof value!=='string') || String(value).trim()==='' || !Number.isFinite(Number(value)) || Number(value)<0 || Number(value)>1e12) {throw inventoryError('Quantities must be finite nonnegative numbers.');}
  return Number(value);
}
/** @param {any} item @param {any} input @param {{damage?:boolean}} [options] */
export function quantitySnapshot(item,input,{damage=false}={}) {
  const keys=[...PHYSICAL_UNITS.map(u=>u.key),'sales'];
  if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(key=>!keys.includes(key))) {throw inventoryError('Invalid quantity fields.');}
  const values=Object.fromEntries(keys.map(key=>[key,input[key]===undefined ? 0 : amount(input[key])]));
  const units=PHYSICAL_UNITS.filter(unit=>Number(item[unit.factor])>0);
  const fallback=damage ? 'sales' : 'pieces';
  const allowed=units.length ? units.map(unit=>unit.key) : [fallback];
  if (keys.some(key=>(values[key] ?? 0)>0 && !allowed.includes(key))) {throw inventoryError('This quantity unit is unavailable for the SKU.');}
  const quantity=Number((units.length ? units.reduce((total,unit)=>total+(values[unit.key] ?? 0)*Number(item[unit.factor]),0) : (values[fallback] ?? 0)).toFixed(6));
  if (!Number.isFinite(quantity) || quantity>1e12 || (damage && quantity<=0)) {throw inventoryError('Enter a valid positive damage quantity.');}
  const unit=damage ? item.sales_unit : item.stock_unit;
  const unitId=damage ? Number(item.sales_unit_id) : Number(item.stock_unit_id) || null;
  if (damage && (!unit || !Number.isSafeInteger(unitId) || Number(unitId)<=0)) {throw inventoryError('Sales UOM is unavailable. Refresh this SKU before reporting damage.',409);}
  return {quantity,unit:unit || 'Qty',unitId,values,conversions:Object.fromEntries(PHYSICAL_UNITS.map(u=>[u.factor,Number(item[u.factor]) || 0]))};
}
/** @param {any} sheet @param {any} actor @param {any} input @param {string} action */
export function countSheetCommand(sheet,actor,input,action) {
  if (sheet.status!=='in_progress' || sheet.owner_id!==actor.id) {throw inventoryError('This count sheet is not assigned to you.',409,'INVENTORY_SHEET_OWNER');}
  if (Number(input.attempt)!==Number(sheet.attempt) || Number(input.revision)!==Number(sheet.revision)) {throw inventoryError('This count sheet changed. Reload before continuing.',409,'INVENTORY_STALE');}
  if (!['line','submit'].includes(action)) {throw inventoryError('Invalid count sheet action.');}
}

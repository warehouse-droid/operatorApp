// @ts-check
import {MbtError} from './errors.js';
/** @param {string} message @param {string} [code] */
export function transportError(message,code='MBT_TRANSPORT_INVALID') {return new MbtError({status:409,code,message});}

/** Item identity is authoritative; names never infer BIN-only routing.
 * @param {any} order @param {Set<string>} aggregateIds */
export function transportSourceKind(order,aggregateIds) {
  if (order.type==='BIN') {return null;}
  if (order.mbtSource==='frontdesk_aggregate') {return 'frontdesk_aggregate';}
  if (order.orderKind==='sor_rental_return') {return 'sor_return';}
  if ((order.items || []).some((/** @type {any} */ item)=>aggregateIds.has(String(item.itemId)))) {return 'aggregate';}
  return /^SOR\d+(?:-S\d+)?$/iu.test(String(order.id || order.refNumber)) ? 'sor_delivery' : null;
}

/** Fixed six-place arithmetic prevents floating-point over-allocation.
 * @param {unknown} value @param {boolean} [allowZero] */
export function transportQuantity(value,allowZero=false) {
  const text=String(value);
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/u.test(text)) {throw allocationError('Use a valid quantity with at most six decimal places.');}
  const [whole='0',fraction='']=text.split('.');
  const result=BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));
  if (!allowZero && result===0n) {throw allocationError('Allocate a positive quantity.');}
  return result;
}
/** @param {bigint} value */
export function transportQuantityText(value) {
  return `${value/1000000n}.${String(value%1000000n).padStart(6,'0')}`.replace(/\.?0+$/u,'');
}
/** @param {string} message */
function allocationError(message) {return transportError(message,'MBT_TRANSPORT_ALLOCATION_INVALID');}

/** @param {any[]} lines @param {any[]} used @param {any[]} requested */
export function allocateTransportLines(lines,used,requested) {
  if (!Array.isArray(requested) || !requested.length || requested.length>500) {throw allocationError('Choose at least one item quantity for this trip.');}
  const source=new Map(lines.map(line=>[String(line.key),line]));
  if (source.size!==lines.length) {throw allocationError('Source line identities are not unique. Refresh the order.');}
  const allocated=new Map();
  for (const row of used) {allocated.set(row.lineKey,(allocated.get(row.lineKey) || 0n)+transportQuantity(row.quantity));}
  const seen=new Set();
  return requested.map(row=>{
    const line=source.get(String(row.lineKey));
    if (!line || seen.has(row.lineKey)) {throw allocationError('Choose each original order line at most once.');}
    seen.add(row.lineKey);
    const quantity=transportQuantity(row.quantity),total=transportQuantity(line.quantity);
    const remaining=total-(allocated.get(row.lineKey) || 0n)-quantity;
    if (remaining<0n) {throw allocationError('Trip quantities exceed the remaining order quantity. Refresh the order.');}
    return {...line,lineKey:String(line.key),sourceQuantity:transportQuantityText(total),quantity:transportQuantityText(quantity),remaining:transportQuantityText(remaining)};
  });
}

/** @param {any} input */
export function transportTripWeight({allocations,weightLbs,maximumPayloadLbs}) {
  const known=allocations.every((/** @type {any} */ row)=>Number(row.lineWeight)>0);
  const estimated=allocations.reduce((/** @type {number} */ sum,/** @type {any} */ row)=>sum+Math.max(0,Number(row.lineWeight) || 0)*Number(row.quantity)/Number(row.sourceQuantity),0);
  const entered=Number(weightLbs),weight=weightLbs===undefined || weightLbs===null || weightLbs==='' ? known?estimated:0 : entered;
  if (!Number.isFinite(weight) || weight<=0 || weight>1000000) {throw transportError('Enter the cargo weight for this trip.','MBT_TRANSPORT_WEIGHT_REQUIRED');}
  const maximum=Number(maximumPayloadLbs),format=(/** @type {number} */ value)=>value.toLocaleString('en-CA',{maximumFractionDigits:3});
  if (!Number.isFinite(maximum) || maximum<=0) {
    throw transportError('The selected bin type\'s maximum payload is not configured. Set its payload capacity before saving this route.','MBT_TRANSPORT_CAPACITY_REQUIRED');
  }
  if (weight<estimated) {
    throw transportError(`Cargo weight must be at least ${format(estimated)} lb for the selected item quantities.`,'MBT_TRANSPORT_CAPACITY');
  }
  if (weight>maximum) {
    throw transportError(`Cargo weight ${format(weight)} lb exceeds the bin payload capacity of ${format(maximum)} lb. Reduce the trip quantities or choose a bin with sufficient capacity.`,'MBT_TRANSPORT_CAPACITY');
  }
  return Math.ceil(weight*1000)/1000;
}

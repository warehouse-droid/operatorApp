/* global structuredClone */
import { sumSpecialAmounts } from './special-stock-discount-total.js';
import { normalizeSpecialDiscount, normalizeSpecialRate, specialPalletQuantity, specialQuantity, specialDiscountLineAmount } from '../public/special-stock-pricing.js';
/**
 * @typedef {{remoteLineId:number|null,itemId:number,quantity:number|null,unitId:number|null,rate:string,description:string,locationId:number|null,taxCode:string,createdPoId:number|null,createPo:string}} SnapshotLine
 * @typedef {{header:Record<string,string|number>,lines:SnapshotLine[]}} Snapshot
 * @typedef {{id:number,kind:string}} Identity
 * @typedef {{remoteLineId:number,itemId:number,quantity:number,rate:number,unitId:number,description:string,toQuantity:number,toRate?:number,nativeDiscountPercent?:number|null,toNativeDiscountPercent?:number|null}} Change
 * @typedef {{fromQuantity:number,toQuantity:number,rate:number,unitId?:number}} Pallets
 * @typedef {Identity & {lines:Change[],pallets?:Pallets,discountMode?:string,vendorDiscountTotal?:{before:number,after:number}}} InputOrder
 * @typedef {Identity & {baseline:Snapshot,target:Snapshot}} PreparedOrder
 * @typedef {{version:number,orders:PreparedOrder[]}} Plan
 * @typedef {{snapshot:(order:Identity)=>Promise<Snapshot>,apply:(order:PreparedOrder)=>Promise<unknown>,validate?:(plan:Plan)=>unknown}} Boundary
 */
/** @param {string} message */
const conflict=message=>Object.assign(Error(message),{status:409,code:'SPECIAL_ADJUSTMENT_CONFLICT'});
/** @param {Snapshot['header']} a @param {Snapshot['header']} b */
const equal=(a,b)=>Object.keys(a).length===Object.keys(b).length && Object.keys(a).every(key=>a[key]===b[key]);
/** @type {(keyof SnapshotLine)[]} */
const fields=['itemId','quantity','unitId','rate','description','locationId','taxCode','createdPoId','createPo'];

/** @param {Snapshot} expected @param {Snapshot} current */
export function specialAdjustmentMatches(expected,current) {
  return Boolean(current && equal(expected.header,current.header) && expected.lines.length===current.lines.length
    && expected.lines.every((line,index)=>{
      const actual=current.lines[index];
      return (!line.remoteLineId || line.remoteLineId===actual.remoteLineId)
        && fields.every(key=>line[key]===actual[key]);
    }));
}

/** @param {SnapshotLine} material @param {number} percent @param {SnapshotLine|null} existing @returns {SnapshotLine} */
function discountLine(material,percent,existing) {
  return {remoteLineId:existing?.remoteLineId ?? null,itemId:10716,quantity:null,unitId:null,rate:String(specialDiscountLineAmount(material.quantity, material.rate, percent)),
    description:existing?.description || '',locationId:material.locationId,taxCode:material.taxCode,createdPoId:null,createPo:''};
}

/** @param {InputOrder} order @param {Snapshot} baseline */
function materialTarget(order,baseline) {
  const target=structuredClone(baseline),seen=new Set();
  const totalDiscount = order.kind === 'sales_order' && (order.discountMode === 'total' || baseline.header.discountItem === '10716');
  if (totalDiscount && (baseline.lines.some(line => line.itemId === 10716)
    || (baseline.header.discountItem && baseline.header.discountItem !== '10716')
    || !Number.isFinite(Number(baseline.header.discountRate || 0)) || Number(baseline.header.discountRate || 0) > 0)) {
    throw conflict('The order-total discount no longer matches the review.');
  }
  for (const change of order.lines) {
    if (!change.remoteLineId || seen.has(change.remoteLineId)) throw conflict('The exact changed material lines must be distinct.');
    seen.add(change.remoteLineId);
    const index=target.lines.findIndex(line=>line.remoteLineId===change.remoteLineId),before=target.lines[index];
    if (!before || before.itemId!==2055 || before.quantity!==Number(change.quantity) || before.rate!==String(change.rate)
      || before.unitId!==Number(change.unitId) || before.description!==change.description) throw conflict('The issued material no longer matches its reviewed quantity, rate, UOM or description.');
    if (order.kind!=='sales_order' || change.toNativeDiscountPercent == null) {
      before.quantity=specialQuantity(change.toQuantity); continue;
    }
    if (totalDiscount) {
      const previous = specialDiscountLineAmount(before.quantity, before.rate, change.nativeDiscountPercent || 0);
      before.quantity = specialQuantity(change.toQuantity);
      before.rate = String(normalizeSpecialRate(change.toRate));
      const next = specialDiscountLineAmount(before.quantity, before.rate, change.toNativeDiscountPercent);
      const amount = sumSpecialAmounts([Number(target.header.discountRate || 0), -previous, next]);
      if (amount > 0) throw conflict('The reviewed discount exceeds the existing order discount.');
      target.header.discountItem = '10716';
      target.header.discountRate = String(amount);
      continue;
    }
    const next=target.lines[index+1],existing=next?.itemId===10716 ? next : null;
    const previous=normalizeSpecialDiscount(change.nativeDiscountPercent);
    const expectedAmount=String(specialDiscountLineAmount(before.quantity, before.rate, previous));
    if (previous>0 ? !existing || ![expectedAmount,`-${previous}%`].includes(existing.rate) : Boolean(existing)) throw conflict('The issued material discount no longer matches the review.');
    before.quantity=specialQuantity(change.toQuantity);
    before.rate=String(normalizeSpecialRate(change.toRate));
    const percent=normalizeSpecialDiscount(change.toNativeDiscountPercent);
    target.lines.splice(index+1,existing?1:0,...(percent ? [discountLine(before,percent,existing)] : []));
  }
  if (order.kind === 'purchase_order' && order.vendorDiscountTotal) {
    const matches=target.lines.filter(line=>line.itemId===4981),line=matches[0],total=order.vendorDiscountTotal;
    if (matches.length!==1 || line.quantity!==1 || line.rate!==String(-total.before)
      || !/^Vendor discount \| MBBS-SPECIAL-PO:\d+$/.test(line.description)
      || !Number.isFinite(total.after) || total.after<0 || total.after!==Number(total.after.toFixed(2))) {
      throw conflict('The PO vendor discount no longer matches the saved review.');
    }
    line.rate=String(-total.after);
  }
  return target;
}

/** @param {Snapshot} target @param {Pallets|undefined} pallets */
function palletTarget(target,pallets) {
  if (!pallets) return;
  const matches=target.lines.filter(line=>line.itemId===1784),before=matches[0];
  if (matches.length>1 || Number(before?.quantity || 0)!==pallets.fromQuantity
    || (before && before.rate!==String(pallets.rate))) throw conflict('The issued PALLET quantity or rate no longer matches the review.');
  const quantity=specialPalletQuantity(pallets.toQuantity);
  if (before) {
    if (quantity) before.quantity=quantity;
    else target.lines.splice(target.lines.indexOf(before),1);
  } else if (quantity) {
    if (!pallets.unitId || !target.lines[0]?.locationId) throw conflict('The native PALLET UOM and order location are required.');
    target.lines.push({remoteLineId:null,itemId:1784,quantity,rate:String(normalizeSpecialRate(pallets.rate)),description:'PALLET',
      unitId:Number(pallets.unitId),locationId:target.lines[0].locationId,taxCode:target.lines[0].taxCode,createdPoId:null,createPo:''});
  }
}

/** @param {{orders:InputOrder[]}} input @param {Boundary} boundary @returns {Promise<Plan>} */
export async function prepareSpecialAdjustmentPlan({orders},boundary) {
  if (!Array.isArray(orders) || !orders.length || orders.length>2 || new Set(orders.map(order=>order.id)).size!==orders.length
    || orders.some(order=>!Number.isSafeInteger(order.id) || order.id<=0 || !['sales_order','purchase_order'].includes(order.kind))) throw conflict('The exact issued order pair is required.');
  const prepared=[];
  for(const order of [...orders].sort((a,b)=>Number(a.kind==='purchase_order')-Number(b.kind==='purchase_order'))){
    const baseline=await boundary.snapshot(order),target=materialTarget(order,baseline);
    if(order.kind==='sales_order')palletTarget(target,order.pallets);
    prepared.push({id:order.id,kind:order.kind,baseline,target});
  }
  return {version:2,orders:prepared};
}

/** @param {PreparedOrder} order @param {Snapshot} current */
function assertCurrent(order,current) {
  if (!specialAdjustmentMatches(order.baseline,current) && !specialAdjustmentMatches(order.target,current)) {
    throw conflict('NetSuite has an unreviewed change. Resolve it before applying this adjustment.');
  }
}

/** @param {Plan} plan @param {Boundary} boundary */
export async function applySpecialAdjustmentPlan(plan,boundary) {
  if(plan?.version!==2 || !plan.orders?.length)throw conflict('A saved adjustment plan is required.');
  if(boundary.validate)await boundary.validate(plan);
  for(const order of plan.orders)assertCurrent(order,await boundary.snapshot(order));
  for(const order of plan.orders){
    const current=await boundary.snapshot(order);assertCurrent(order,current);
    if(!specialAdjustmentMatches(order.target,current))await boundary.apply(order);
    if(!specialAdjustmentMatches(order.target,await boundary.snapshot(order)))throw conflict('NetSuite did not confirm the complete order adjustment. Retry SCM confirmation.');
  }
  const verifiedOrders=[];
  for(const order of plan.orders){
    const current=await boundary.snapshot(order);
    if(!specialAdjustmentMatches(order.target,current))throw conflict('Both orders must remain verified before completing the review.');
    verifiedOrders.push({id:order.id,kind:order.kind,...current});
  }
  return {verifiedOrderIds:plan.orders.map(order=>order.id),verifiedOrders};
}

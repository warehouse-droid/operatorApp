import { isDeepStrictEqual } from 'node:util';
import { readSpecialRestOrder } from './special-stock-rest-orders.js';

/**
 * @typedef {import('./special-stock-rest-orders.js').Transport} Transport
 * @typedef {import('./special-stock-rest-orders.js').Snapshot} Snapshot
 * @typedef {import('./special-stock-rest-orders.js').Raw} Raw
 * @typedef {{salesOrderId:number,fulfillmentMethod:string,deliveryAddress?:string|null,deliveryDate?:string|null,windowStart?:string|null,windowEnd?:string|null,deliveryContactName?:string|null,deliveryContactPhone?:string|null,deliveryInstructions?:string|null}} Fulfillment
 * @typedef {{methodId:number,date:string,notes:string,address:string}} Delivery
 * @typedef {{delivery:Delivery,commercial:Snapshot}} State
 * @typedef {{version:number,id:number,delivery:boolean,before:State,target:Delivery}} Plan
 */
/** @param {string} message */
const conflict = message => Object.assign(new Error(message),{status:409,code:'SPECIAL_FULFILLMENT_CONFLICT'});
/** @param {unknown} value */
const text = value => String(value ?? '').replace(/\r\n/g,'\n').trim();
const same = isDeepStrictEqual;

/** @param {Raw} record @returns {Delivery} */
function deliveryFields(record) {
  return {methodId:Number(record.custbody3?.id || 0),date:text(record.custbody4).slice(0,10),notes:text(record.custbody7),
    address:text(record.shippingAddress?.addrText ?? record.shipAddress)};
}
/** @param {Snapshot} snapshot @returns {Snapshot} */
function commercial(snapshot) {
  const {shipAddress:_address,...header}=snapshot.header;
  return {header,lines:snapshot.lines};
}
/** @param {number} id @param {Transport} boundary @returns {Promise<State>} */
async function read(id,boundary) {
  const {record,snapshot}=await readSpecialRestOrder({id,kind:'sales_order'},boundary);
  return {delivery:deliveryFields(record),commercial:commercial(snapshot)};
}
/** @param {unknown} value */
function orderId(value) {
  const id=Number(value);
  if (!Number.isSafeInteger(id) || id<=0) throw conflict('A valid issued SO is required.');
  return id;
}
/** @param {Fulfillment} input @param {Transport & {config:{deliveryMethodId:string|number,pickupMethodId:string|number}}} boundary @returns {Promise<Plan>} */
export async function prepareSpecialFulfillmentPlan(input,boundary) {
  const id=orderId(input.salesOrderId),fields=input,delivery=fields.fulfillmentMethod==='mbt_delivery';
  if (!['vendor_pickup','yard_pickup','mbt_delivery'].includes(fields.fulfillmentMethod) || (delivery && !text(fields.deliveryAddress))) throw conflict('A valid delivery method and delivery address are required.');
  const methodId=Number(boundary.config[delivery?'deliveryMethodId':'pickupMethodId']);
  if (!Number.isSafeInteger(methodId) || methodId<=0) throw conflict('The NetSuite delivery-method mapping is missing.');
  const before=await read(id,boundary);
  const target={methodId,date:fields.deliveryDate || '',notes:delivery ? [
    `Delivery Address: ${fields.deliveryAddress}`,
    fields.deliveryDate ? `Delivery Date: ${fields.deliveryDate}` : null,
    fields.windowStart ? `Delivery Time: ${fields.windowStart}-${fields.windowEnd}` : null,
    `Contact: ${fields.deliveryContactName || ''} ${fields.deliveryContactPhone || ''}`,
    fields.deliveryInstructions ? `Drop-off Loc: ${fields.deliveryInstructions}` : null
  ].filter(Boolean).join('\n').trim() : '',address:delivery ? text(fields.deliveryAddress) : before.delivery.address};
  return {version:1,id,delivery,before,target};
}
/** @param {Plan} plan @param {Transport} boundary */
export async function applySpecialFulfillmentPlan(plan,boundary) {
  if (plan?.version!==1 || !plan.before?.commercial || !plan.target?.methodId) throw conflict('A saved delivery update is required.');
  const id=orderId(plan.id),current=await read(id,boundary);
  if (!same(current.commercial,plan.before.commercial) || (!same(current.delivery,plan.before.delivery) && !same(current.delivery,plan.target))) {
    throw conflict('NetSuite changed since this delivery update. Resolve the conflicting edit before retrying.');
  }
  if (!same(current.delivery,plan.target)) {
    const body={custbody3:{id:String(plan.target.methodId)},custbody4:plan.target.date || null,custbody7:plan.target.notes || null};
    if (plan.delivery) Object.assign(body,{shipOverride:true,shippingAddress:{override:true,addrText:plan.target.address}});
    await boundary.rest(`/record/v1/salesOrder/${id}`,{method:'PATCH',body});
  }
  const after=await read(id,boundary);
  if (!same(after.delivery,plan.target) || !same(after.commercial,plan.before.commercial)) throw conflict('NetSuite has not verified the delivery update with unchanged commercial lines. Retry the saved change.');
  return {deliveryMethodId:plan.target.methodId};
}

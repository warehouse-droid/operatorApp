/** @typedef {{salesOrderId?:number|null,salesOrderRef?:string|null,purchaseOrderId?:number|null,purchaseOrderRef?:string|null}} Detail */
/** @typedef {{remoteLineId:number,itemId:number,quantity:number,executedQuantity:number}} FulfilledLine */
/** @typedef {{id:number,kind:string,reference:string,type:string,status:string,statusText:string,fullyFulfilled?:boolean,fulfillmentLines?:FulfilledLine[]}} ClosedOrder */
/** @param {string} message */
const conflict=message=>Object.assign(Error(message),{status:409,code:'SPECIAL_CLOSURE_UNVERIFIED'});
/** @param {unknown} value */
const closedStatus=value=>/^(?:Closed|Cancelled|Canceled)$/i.test(String(value || '').replace(/^(Sales Order|Purchase Order)\s*:\s*/i,''));
/** @param {ClosedOrder} order */
const pendingBilling=order=>order.kind==='sales_order' && order.status==='F'
  && /^Pending Billing$/i.test(order.statusText.replace(/^Sales Order\s*:\s*/i,''));
/** @param {FulfilledLine[]|undefined} lines */
function allFulfilled(lines) {
  return Array.isArray(lines) && lines.length>0 && new Set(lines.map(line=>line.remoteLineId)).size===lines.length
    && lines.every(line=>Number.isSafeInteger(line.remoteLineId) && line.remoteLineId>0
      && Number.isSafeInteger(line.itemId) && line.itemId>0 && Number.isFinite(line.quantity) && line.quantity>0
      && Number.isFinite(line.executedQuantity) && line.executedQuantity>=line.quantity);
}
/** @param {Detail} detail @returns {Omit<ClosedOrder,'status'|'statusText'>[]} */
function linkedOrders(detail) {
  const orders=[];
  for(const [kind,value,reference,type] of [
    ['sales_order',detail.salesOrderId,detail.salesOrderRef,'SalesOrd'],
    ['purchase_order',detail.purchaseOrderId,detail.purchaseOrderRef,'PurchOrd']]) {
    if(value==null)continue;
    const id=Number(value);
    if(!Number.isSafeInteger(id) || id<=0 || typeof reference!=='string' || !reference.trim()) {
      throw conflict('Exact linked NetSuite order IDs and references are required.');
    }
    orders.push({id,kind:String(kind),reference,type:String(type)});
  }
  if(orders.length && (orders[0].kind!=='sales_order' || new Set(orders.map(o=>o.id)).size!==orders.length)) {
    throw conflict('The exact linked Sales Order and any Purchase Order are required.');
  }
  return orders;
}
/** @param {Detail} detail @param {{orders:ClosedOrder[]}} evidence @param {{allowFulfilledSalesOrder?:boolean}} options */
export function assertSpecialClosedOrderEvidence(detail,evidence,{allowFulfilledSalesOrder=false}={}) {
  const expected=linkedOrders(detail);
  if(!expected.length || !Array.isArray(evidence?.orders) || evidence.orders.length!==expected.length
    || new Set(evidence.orders.map(o=>o?.id)).size!==expected.length) {
    throw conflict('Every exact linked order must be verified closed before local closure.');
  }
  for(const order of expected) {
    const actual=evidence.orders.find(o=>o?.id===order.id);
    const terminal=actual && ((['H','C'].includes(actual.status) && closedStatus(actual.statusText))
      || (allowFulfilledSalesOrder && pendingBilling(actual) && actual.fullyFulfilled===true && allFulfilled(actual.fulfillmentLines)));
    if(!actual || actual.kind!==order.kind || actual.reference!==order.reference || actual.type!==order.type
      || !terminal) {
      throw conflict('The linked NetSuite order is not verified closed.');
    }
  }
  return evidence.orders;
}
/** @param {Detail} detail @param {{queryAll:(sql:string)=>Promise<Record<string,any>[]>}} boundary @param {{allowFulfilledSalesOrder?:boolean}} options */
export async function readSpecialClosedOrders(detail,{queryAll},{allowFulfilledSalesOrder=false}={}) {
  const expected=linkedOrders(detail);
  if(!expected.length)return null;
  const orders=[];
  for(const order of expected) {
    const rows=await queryAll(`SELECT t.id,t.tranid,t.type,t.status,BUILTIN.DF(t.status) AS status_text
      FROM transaction t WHERE t.id = ${order.id}`);
    const row=rows?.[0];
    if(!Array.isArray(rows) || rows.length!==1 || !row || Number(row.id)!==order.id
      || row.tranid!==order.reference || row.type!==order.type || typeof row.status_text!=='string' || !row.status_text.trim()) {
      throw conflict('The exact linked NetSuite order header could not be verified.');
    }
    const current={...order,status:String(row.status),statusText:row.status_text};
    if(!closedStatus(row.status_text)) {
      if(!allowFulfilledSalesOrder || !pendingBilling(current))return null;
      const material=await queryAll(`SELECT tl.uniquekey,tl.item,tl.quantity AS base_quantity,
        ABS(NVL(tl.quantityshiprecv,0)) AS execution_quantity FROM transactionline tl
        WHERE tl.transaction = ${order.id} AND tl.mainline='F' AND tl.taxline='F'
        AND tl.item IS NOT NULL AND tl.quantity IS NOT NULL AND tl.quantity <> 0`);
      const fulfillmentLines=material.map(line=>({remoteLineId:Number(line.uniquekey),itemId:Number(line.item),
        quantity:Math.abs(Number(line.base_quantity)),executedQuantity:Number(line.execution_quantity)}));
      if(!allFulfilled(fulfillmentLines))return null;
      orders.push({...current,fullyFulfilled:true,fulfillmentLines});
    } else orders.push(current);
  }
  const evidence={orders};
  assertSpecialClosedOrderEvidence(detail,evidence,{allowFulfilledSalesOrder});
  return evidence;
}

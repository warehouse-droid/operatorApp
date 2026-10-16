import {DeliveryRequestError} from './delivery-request-domain.js';
import {getDeliveryInstruction} from './delivery-instruction-repository.js';
import {previewDeliveryRequestTransferOrder} from './delivery-request-orders.js';

const failure=(code,message,status=400)=>new DeliveryRequestError(code,message,status);
export function normalizeDeliveryEstimateReference(value) {
  if(value===undefined || value===null || value==='') {return '';}
  if(typeof value!=='string') {throw failure('DELIVERY_REQUEST_INVALID','Quote (EST) number must be text.');}
  const reference=value.trim().toUpperCase();
  if(reference && !/^EST[A-Z0-9][A-Z0-9_-]{0,60}$/.test(reference)) {
    throw failure('DELIVERY_REQUEST_INVALID','Enter a valid Quote number starting with EST (maximum 64 characters).');
  }
  return reference;
}
function netSuiteDocuments(loadNetSuite) {
  return {
    async findEstimate(reference) {
      const {suiteql}=await loadNetSuite();
      const result=await suiteql(`SELECT t.id,t.tranid,COALESCE(t.location,tl.location) AS location FROM transaction t
        LEFT JOIN transactionline tl ON tl.transaction=t.id AND tl.mainline='T'
        WHERE t.type='Estimate' AND UPPER(t.tranid)='${reference}' ORDER BY t.id DESC FETCH FIRST 2 ROWS ONLY`);
      if(result.items?.length>1) {throw failure('DELIVERY_DOCUMENT_AMBIGUOUS','More than one estimate uses this number.',409);}
      return result.items?.[0] || null;
    },
    async readEstimate(id) {
      const remote=await loadNetSuite(),record=await remote.fetchEstimateRecordFromNetSuite(id);
      const unitKey=value=>/^\d+$/.test(String(value ?? ''))?String(value):'';
      if(!Array.isArray(record?.item?.items) || !record.item.items.some(line=>unitKey(line.units))) {return record;}
      const result=await remote.suiteql(`SELECT DISTINCT tl.units AS unit_id, BUILTIN.DF(tl.units) AS unit
        FROM transactionline tl WHERE tl.transaction=${id} AND tl.units IS NOT NULL`);
      const labels=new Map((result.items || []).map(row=>[String(row.unit_id),row.unit]));
      const items=record.item.items.map(line=>{
        const key=unitKey(line.units);
        if(!key) {return line;}
        const label=labels.get(key);
        if(!label) {throw failure('DELIVERY_DOCUMENT_UNAVAILABLE','An estimate unit could not be resolved.',502);}
        return {...line,units:{refName:label}};
      });
      return {...record,item:{...record.item,items}};
    },
    async fetchSalesOrderPdf(id) {return (await loadNetSuite()).fetchSalesOrderPdfFromNetSuite(id);}
  };
}
const refName=value=>typeof value==='object'?value?.refName || '':String(value ?? '');
function estimatePreview(record,reference) {
  if(!Array.isArray(record.item?.items)) {throw failure('DELIVERY_DOCUMENT_UNAVAILABLE','The estimate item list is unavailable.',502);}
  return {reference,customerName:refName(record.entity),date:record.tranDate || '',address:record.shippingAddress?.addrText || record.shipAddress || '',
    memo:record.memo || '',currency:'CAD',subtotal:record.subtotal,discount:record.discountTotal,shipping:record.shippingCost,
    handling:record.handlingCost,tax:record.taxTotal,tax2:record.tax2Total,total:record.total,
    lines:record.item.items.map(line=>({description:line.description || refName(line.item),quantity:line.quantity,
      unit:refName(line.units),pallets:line.custcol_plt ?? null,layers:line.custcol_lyr ?? null,
      sections:line.custcol_sec ?? null,pieces:line.custcol_pcs ?? null,rate:line.rate,amount:line.amount}))};
}
export function createDeliveryRequestDocuments(dependencies={}) {
  const loadNetSuite=dependencies.loadNetSuite || (()=>import('./netsuite.js'));
  const deps={...netSuiteDocuments(loadNetSuite),getSalesOrder:getDeliveryInstruction,...dependencies};
  async function validateEstimate(value,yard) {
    const reference=normalizeDeliveryEstimateReference(value);
    if(!reference) {return null;}
    const found=await deps.findEstimate(reference);
    if(!found) {throw failure('DELIVERY_DOCUMENT_NOT_FOUND','Quote (EST) not found.',404);}
    if(!Number.isSafeInteger(Number(found.id)) || Number(found.id)<1 || String(found.tranid).trim().toUpperCase()!==reference) {
      throw failure('DELIVERY_DOCUMENT_CHANGED','The estimate identity changed. Refresh and retry.',409);
    }
    if(Number(found.location)!==yard) {throw failure('DELIVERY_ACCESS_DENIED','This quote belongs to another requesting yard.',403);}
    return {reference,id:Number(found.id)};
  }
  return {
    validateEstimate,
    transferOrder:previewDeliveryRequestTransferOrder,
    async estimate(value,yard) {
      const identity=await validateEstimate(value,yard);
      if(!identity) {throw failure('DELIVERY_DOCUMENT_NOT_FOUND','This request has no attached Quote (EST).',404);}
      const record=await deps.readEstimate(identity.id);
      if(Number(record?.id)!==identity.id || String(record.tranId || record.tranid).trim().toUpperCase()!==identity.reference || Number(record.location?.id)!==yard) {
        throw failure('DELIVERY_DOCUMENT_CHANGED','The estimate identity or yard changed. Refresh and retry.',409);
      }
      return estimatePreview(record,identity.reference);
    },
    async salesOrder(reference,yard) {
      const order=await deps.getSalesOrder(reference,{authorizedOrderingLocationIds:[yard]});
      return deps.fetchSalesOrderPdf(order.orderId);
    }
  };
}

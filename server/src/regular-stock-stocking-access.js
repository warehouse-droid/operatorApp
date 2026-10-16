// @ts-check
import {assertStockRequestDestinationAccess,normalizeStockRequestYardId,STOCK_REQUEST_YARDS} from './stock-request-domain.js';

const supported=new Set(/** @type {number[]} */ (STOCK_REQUEST_YARDS.map(yard=>yard.locationId)));
/** @param {unknown} value */
const yardId=value=>['string','number'].includes(typeof value)&&/^\d+$/.test(String(value).trim())&&supported.has(Number(value))?Number(value):null;

/** @param {string|null|undefined} method @param {unknown} destination @param {unknown[]} authorized */
export function assertRegularStockingDestinationAccess(method,destination,authorized=[]) {
  if(method!=='stocking')return assertStockRequestDestinationAccess(destination,authorized);
  if(!yardId(destination))throw Object.assign(new Error('Select a valid supported destination yard.'),{status:400,code:'STOCK_REQUEST_INVALID'});
  if(!authorized.some(value=>yardId(value)))throw Object.assign(new Error('A supported Sales yard is required.'),{status:403,code:'STOCK_REQUEST_YARD_FORBIDDEN'});
  return normalizeStockRequestYardId(destination);
}

/** @param {{requestType?:string,workflowVersion?:number,regular?:{deliveryMethod?:string,requestingLocationId?:unknown,stockingSource?:{requestId?:unknown,lineId?:unknown,requestingLocationId?:unknown}}}} request @param {unknown[]} authorized */
export function canSalesAccessStockingRequest(request,authorized=[]) {
  const regular=request.regular,source=regular?.stockingSource;
  const positiveId=/** @param {unknown} value */ value=>['number','string'].includes(typeof value)&&/^\d+$/.test(String(value))&&Number.isSafeInteger(Number(value))&&Number(value)>0;
  const converted=Boolean(regular?.deliveryMethod==='waitlist'&&source&&positiveId(source.requestId)&&positiveId(source.lineId));
  const origin=yardId(converted?source?.requestingLocationId:regular?.requestingLocationId);
  return origin!==null&&request.requestType==='regular'&&request.workflowVersion===2&&(regular?.deliveryMethod==='stocking'||converted)
    &&authorized.some(value=>yardId(value)===origin);
}

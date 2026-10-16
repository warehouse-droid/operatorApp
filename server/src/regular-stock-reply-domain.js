// @ts-check
import {regularError} from './regular-stock-domain.js';

/** @param {unknown} value @param {string} label @param {number} limit @param {{required?:boolean,multiline?:boolean}} options */
function text(value,label,limit,{required=false,multiline=false}={}) {
  if(value===undefined||value===null)value='';
  if(typeof value!=='string')throw regularError(`${label} must be text.`,'REGULAR_REPLY_INVALID',400);
  const result=value.trim(),control=multiline?/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u:/[\u0000-\u001f\u007f]/u;
  if(required&&!result||result.length>limit||control.test(result))throw regularError(`Enter ${label.toLowerCase()} (at most ${limit} characters).`,'REGULAR_REPLY_INVALID',400);
  return result||null;
}

/** @param {{message?:unknown,eta?:unknown,salesOrderRef?:unknown,expectedRevision?:unknown}} input @param {string} audience */
export function normalizeStockingReply(input={},audience) {
  if(!['sales','scm'].includes(audience))throw regularError('Choose a valid reply audience.','REGULAR_REPLY_INVALID',400);
  const message=text(input.message,'Reply',2000,{required:true,multiline:true});
  const expectedRevision=Number(input.expectedRevision);
  if(!['number','string'].includes(typeof input.expectedRevision)||!Number.isSafeInteger(expectedRevision)||expectedRevision<=0)throw regularError('A valid request revision is required.','REGULAR_REPLY_INVALID',400);
  const eta=audience==='scm'?text(input.eta,'ETA',10):null;
  if(eta){
    const instant=Date.parse(eta+'T00:00:00Z');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(eta)||!Number.isFinite(instant)||new Date(instant).toISOString().slice(0,10)!==eta)throw regularError('Enter a valid ETA date.','REGULAR_REPLY_INVALID',400);
  }
  return {message,eta,salesOrderRef:audience==='sales'?text(input.salesOrderRef,'Sales order number',80):null,expectedRevision};
}

/** @param {{requestType?:string,workflowVersion?:number,bucket?:string,status:string,regular?:{deliveryMethod?:string,resolution?:unknown,pickupTransfer?:unknown,handoffStatus?:unknown,replyStatus?:string|null,stockingLines?:object,stockingType?:string},lines:{status:string,replyStatus?:string|null,resolution?:unknown,purchase?:{demandId?:unknown}}[]}} request */
export function stockingDisplayStatus(request) {
  const regular=request.regular||{},fallback=request.bucket||request.status;
  if(request.requestType!=='regular'||request.workflowVersion!==2||regular.deliveryMethod!=='stocking')return fallback;
  if(regular.resolution)return 'resolved';
  if(request.status==='completed'&&request.lines.length&&request.lines.every(line=>line.status==='closed'&&line.resolution))return 'resolved';
  if(['completed','cancelled'].includes(request.status))return request.status;
  const open=request.lines.filter(line=>!['closed','rejected','cancelled','received','fulfilled'].includes(line.status));
  for(const status of ['pending_scm','pending_update'])if(open.some(line=>line.replyStatus===status))return status;
  if(!regular.stockingLines&&regular.replyStatus&&['pending_update','pending_scm'].includes(regular.replyStatus))return regular.replyStatus;
  if(regular.pickupTransfer||regular.handoffStatus)return fallback;
  if(regular.stockingType==='purchase'&&request.lines.some(line=>line.purchase?.demandId&&line.status==='approved')){
    return request.lines.some(line=>['submitted','changes_requested'].includes(line.status))?'partially_proposed':'proposed';
  }
  return fallback;
}

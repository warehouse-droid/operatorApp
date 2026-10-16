// @ts-check
import {buildOperatorNetSuitePostingDraft} from './operator-netsuite-posting-domain.js';
import {netSuitePostingQuantity} from './operator-netsuite-posting-quantity.js';

/** @param {Record<string,any>} step @param {Record<string,any>} source */
export function assertTransferPostingSourceCurrent(step,source) {
  if(source.sourceOrderKind!=='TO' || Number(source.sourceNetSuiteId)!==Number(step.sourceNetSuiteId)
    || source.sourceOrderRef!==step.sourceOrderRef){throw invalid('The live transfer source identity changed before posting.');}
  const stage=step.transactionType==='IF'?'outbound':'receiving';
  for(const selected of step.lineSnapshot) {
    const matches=source.lines.filter((/** @type {Record<string,any>} */ line)=>line.stage===stage && Number(line.restOrderLine)===Number(selected.orderLine));
    if(matches.length!==1){throw invalid('The live transfer line identity is not unique.');}
    const line=matches[0];
    const payloadLine = (step.payload?.item?.items || []).find((/** @type {any} */ item) => Number(item.orderLine) === Number(selected.orderLine));
    const quantity = Number(payloadLine?.quantity ?? selected.quantity);
    if(line.identityStatus!=='exact' || Number(line.itemId)!==Number(selected.itemId)
      || !Number.isFinite(Number(line.remainingQuantity)) || Number(line.remainingQuantity)+0.000001<quantity) {
      throw invalid('The live transfer item or remaining quantity changed before posting.');
    }
  }
}

/** @param {string} message */
function invalid(message) {return Object.assign(new Error(message),{code:'TRANSFER_POSTING_EVIDENCE_INVALID',postingNotAttempted:true});}

/** @param {Record<string,any>} job @param {Record<string,any>} event */
function matchingDispatchScope(job,event) {
  return (!job.snapshot.planId || String(event.plan_id)===String(job.snapshot.planId))
    && (!job.snapshot.loadId || event.load_id===job.snapshot.loadId)
    && (!job.snapshot.planDate || String(event.plan_date).slice(0,10)===job.snapshot.planDate);
}

/** @param {Record<string,any>} job @param {Record<string,any>} other */
function samePhysicalScope(job,other) {
  return String(job.local_to_id)===String(other.local_to_id) && job.order_ref===other.order_ref
    && ['planId','loadId','planDate'].every(key=>String(job.snapshot[key] ?? '')===String(other.snapshot[key] ?? ''));
}

/** @param {Record<string,any>[]} jobs */
function itemQuantities(jobs) {
  /** @type {Map<string,number>} */ const quantities=new Map();
  for(const job of jobs) {
    for(const line of job.snapshot.lines || []) {
      const quantity=Number(line.quantity),itemId=Number(line.itemId);
      if(!Number.isFinite(quantity) || quantity<=0 || !Number.isSafeInteger(itemId) || itemId<=0) {
        throw invalid('The saved physical transfer quantity or item is invalid.');
      }
      const key=String(itemId);
      quantities.set(key,(quantities.get(key) || 0)+quantity);
    }
  }
  return quantities;
}

/** @param {Record<string,any>} job @param {Record<string,any>[]} evidence */
export function transferLoadEvidence(job,evidence) {
  return evidence.filter(other=>other.operator_record_valid && other.transaction_type==='IF' && samePhysicalScope(job,other));
}

/** @param {Record<string,any>[]} lines @param {Record<string,any>[]} loaded */
export function transferQuantitiesCovered(lines,loaded) {
  const required=itemQuantities([{snapshot:{lines}}]),available=itemQuantities([{snapshot:{lines:loaded}}]);
  return required.size>0 && [...required].every(([item,quantity])=>(available.get(item) || 0)+0.000001>=quantity);
}

/** Saved existing accounting was verified against REST and linked NetSuite lines.
 * @param {Record<string,any>} job @param {Record<string,any>[]} evidence */
export function transferVerifiedFulfillment(job,evidence) {
  const saved=job.snapshot.verifiedFulfillment,loads=transferLoadEvidence(job,evidence);
  const proof=saved || {lines:loads.flatMap(load=>load.snapshot.lines || []),transactions:loads.flatMap(load=>load.result?.transactions || [])};
  if(!saved && (!loads.length || loads.some(load=>load.status!=='completed' || !load.result?.transactions?.length))) {return null;}
  if(!proof.transactions?.length || !proof.lines?.length || proof.transactions.some((/** @type {Record<string,any>} */ transaction)=>
    transaction.transactionType!=='IF' || transaction.sourceOrderKind!=='TO'
    || Number(transaction.sourceNetSuiteId)!==Number(job.local_to_id) || transaction.sourceOrderRef!==job.order_ref
    || !Number.isSafeInteger(Number(transaction.transactionId)) || Number(transaction.transactionId)<=0)) {return null;}
  return transferQuantitiesCovered(job.snapshot.lines,proof.lines) ? proof : null;
}

/** @param {Record<string,any>} job @param {Record<string,any>[]} evidence */
function directTransferPhysicalStatus(job,evidence) {
  if(job.transaction_type==='IF'){return null;}
  if(!evidence.some(other=>other.id===job.id && other.operator_record_valid)){return 'waiting_receipt';}
  return transferVerifiedFulfillment(job,evidence) ? null : 'waiting_fulfillment';
}

/** @param {Record<string,any>} job */
function directTransferDraftEvidence(job) {
  if(job.transaction_type!=='IR' || !job.snapshot.driverTarget){return {};}
  return {directTransferEvidence:{sourceNetSuiteId:Number(job.local_to_id),driverOrderRefs:job.snapshot.driverTarget.orderRefs,
    fulfillmentTransactionIds:[...new Set(/** @type {number[]} */(job.snapshot.verifiedFulfillment?.transactions?.map((/** @type {Record<string,any>} */ t)=>Number(t.transactionId)) || []))].sort((a,b)=>a-b)}};
}

/** Durable records are joined by the repository; status alone is never physical evidence.
 * @param {Record<string,any>} job @param {Record<string,any>[]} evidence */
export function transferPostingPhysicalStatus(job,evidence) {
  // A direct receipt uses the linked customer drop and must still follow verified IF.
  if(job.snapshot.driverTarget){return directTransferPhysicalStatus(job,evidence);}
  const matching=evidence.filter(other=>other.operator_record_valid && samePhysicalScope(job,other));
  const loads=matching.filter(other=>other.transaction_type==='IF');
  if(!loads.length){return 'waiting_load';}
  if(!matching.some(other=>other.id===job.id)){return job.transaction_type==='IF'?'waiting_load':'waiting_receipt';}
  const receipts=matching.filter(other=>other.transaction_type==='IR');
  const loaded=itemQuantities(loads),received=itemQuantities(receipts);
  if(!loaded.size || !receipts.length || [...loaded].some(([item,quantity])=>(received.get(item) || 0)+0.000001<quantity)) {
    return 'waiting_receipt';
  }
  if(job.transaction_type==='IR' && loads.some(load=>load.status!=='completed'
    || !load.result?.transactions?.length || load.result.transactions.some((/** @type {Record<string,any>} */ transaction)=>
      transaction.transactionType!=='IF' || !(Number(transaction.transactionId)>0)))) {return 'waiting_fulfillment';}
  return null;
}

/** Effective events must come from dispatch_effective_order_completion_events. */
/** @param {Record<string,any>} job @param {Record<string,any>[]} events */
export function transferPostingCompletion(job, events) {
  if (!job.operator_record_id) {return null;}
  if (job.snapshot.linkError) {throw invalid(job.snapshot.linkError);}
  if (job.snapshot.assignmentAmbiguous) {throw invalid('The saved Operator completion has ambiguous dispatch assignments. Review the matching plan and load.');}
  const linked=job.snapshot.driverTarget;
  const refs=(linked?.orderRefs || [job.order_ref]).map((/** @type {unknown} */ ref)=>String(ref).toUpperCase());
  const matches=events.filter(event=>event.order_kind===(linked?'SO':'TO')
    && refs.includes(String(event.order_ref).toUpperCase())
    && event.completion_evidence_type==='driver_job' && event.driver_status==='complete'
    && event.stop_type==='dropoff' && event.completed_at
    && matchingDispatchScope(job,event));
  const scopes=new Set(matches.map(event=>`${event.plan_id}:${event.load_id}`));
  if(scopes.size>1){throw invalid('Driver completion is ambiguous across dispatch plans or loads.');}
  if (linked) {
    const selected=refs.map((/** @type {string} */ ref)=>matches.find(event=>String(event.order_ref).toUpperCase()===ref));
    if (!selected.length || selected.some((/** @type {unknown} */ event)=>!event)) {return null;}
    return {...selected[0],linkedEvents:selected};
  }
  return matches[0] || null;
}

/** @param {Record<string,any>} job @param {Record<string,any>} source @param {Record<string,any>} policy @param {Record<string,any>} event */
export function buildTransferPostingDraft(job,source,policy,event) {
  if(!transferPostingCompletion(job,event.linkedEvents || [event])){throw invalid('Both Operator and Driver completion evidence are required.');}
  if(source?.sourceOrderKind!=='TO' || !Number.isSafeInteger(Number(source.sourceNetSuiteId)) || Number(source.sourceNetSuiteId)<=0) {
    throw invalid('A valid NetSuite transfer source identity is required.');
  }
  const key=`transfer-background:${job.transaction_type}:${job.local_to_id}`;
  const selectedLines=job.snapshot.lines.map((/** @type {Record<string,any>} */ local)=>{
    const matches=source.availableLines.filter((/** @type {Record<string,any>} */ line)=>
      [line.sourceLineKey,...(line.sourceLineAliases || [])].map(String).includes(String(local.sourceLineKey)));
    if(matches.length!==1 || Number(matches[0].itemId)!==Number(local.itemId)){throw invalid('The saved transfer line identity no longer matches its unique source item.');}
    const live=matches[0],quantity=Number(local.quantity);
    const salesUom = live.salesUom || local.unit;
    const postingQuantity = netSuitePostingQuantity(quantity, live.remainingQuantity, salesUom);
    if(!Number.isFinite(quantity) || quantity<=0 || !Number.isFinite(Number(live.remainingQuantity))
      || postingQuantity>Number(live.remainingQuantity)+0.000001){throw invalid('The saved quantity exceeds the remaining NetSuite transfer quantity.');}
    return {orderLine:live.orderLine,quantity,location:live.location ?? null,itemId:local.itemId,
      ...(salesUom ? {salesUom} : {}),
      sourceLineKey:String(local.sourceLineKey),localLineId:String(local.lineId),localOrderKey:key};
  });
  return buildOperatorNetSuitePostingDraft({requestId:job.id,actorOperatorId:job.operator_id,
    functionKey:job.transaction_type==='IF'?'delivery_prep':'receiving',transactionType:job.transaction_type,
    policy,photoRefs:job.snapshot.photos || [],localOrderKeys:[key],
    localOperation:{kind:'transfer_background_posting',orderId:String(job.local_to_id),orderType:'transfer_order'},
    transferEvidence:{jobId:job.id,operatorRecordId:Number(job.operator_record_id),completionEventId:Number(event.id)},
    ...directTransferDraftEvidence(job),
    targets:[{...source,postingStrategy:'stored_order_line_v1',selectedLines}]});
}

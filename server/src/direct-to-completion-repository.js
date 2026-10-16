// @ts-check
import {query,withTransaction} from './db.js';
import {writeAudit} from './auth-repository.js';
import {linkedTransferDriverScope,transferPostingDate} from './transfer-order-posting-link-domain.js';
import {captureTransferPosting,readTransferDriverDependencies,readTransferCompletionEvents,readTransferPostingEvidence} from './transfer-order-posting-repository.js';
import {transferPostingCompletion,transferLoadEvidence,transferQuantitiesCovered,transferVerifiedFulfillment} from './transfer-order-posting-domain.js';

const unit=(/** @type {unknown} */ value)=>String(value || '').trim().toUpperCase();
const lineKey=(/** @type {Record<string,any>} */ line)=>`${line.item_id}:${unit(line.unit)}`;

/** @param {Record<string,any>[]} lines @param {Record<string,any>[]} allocations */
function completeMaterialCoverage(lines,allocations) {
  if(!allocations.length || allocations.some(line=>!(Number(line.allocated_quantity)>0)
    || Number(line.loaded_quantity)+0.000001<Number(line.allocated_quantity)
    || Number(line.locally_received_quantity)+0.000001<Number(line.allocated_quantity))) {return false;}
  const received=new Map();
  for(const line of allocations) {received.set(lineKey(line),(received.get(lineKey(line)) || 0)+Number(line.locally_received_quantity));}
  return lines.every(line=>unit(line.item_name)==='PALLET' && unit(line.unit)==='EACH'
    || (received.get(lineKey(line)) || 0)+0.000001>=Number(line.quantity));
}

/** @param {Record<string,any>[]} outbound @param {Record<string,any>[]} receiving */
function directReceiptLines(outbound,receiving) {
  const selected=[],used=new Set();
  for(const out of outbound) {
    const matches=receiving.filter(line=>!used.has(line.id) && lineKey(line)===lineKey(out)
      && Math.abs(Number(line.quantity)-Number(out.quantity))<=0.000001);
    if(matches.length!==1){return null;}
    const line=/** @type {Record<string,any>} */(matches[0]);used.add(line.id);
    selected.push({lineId:String(line.id),sourceLineKey:String(line.line_id),itemId:Number(line.item_id),
      quantity:Number(line.quantity),cumulativeQuantity:Number(line.quantity)});
  }
  return selected.length && used.size===receiving.length ? selected : null;
}

/** @param {Record<string,any>} scope @param {Record<string,any>[]} receipts @param {Record<string,any>} event */
function matchingDirectReceipt(scope,receipts,event) {
  const drops=new Set((event.linkedEvents || [event]).map((/** @type {Record<string,any>} */ e)=>e.completion_evidence_id));
  return receipts.find(receipt=>receipt.payload?.reason==='direct_so_delivery'
    && String(receipt.payload.planId)===String(scope.planId) && receipt.payload.loadId===scope.loadId
    && transferPostingDate(receipt.payload.planDate)===scope.planDate && drops.has(receipt.payload.driverJobId));
}

/** @param {Record<string,any>} order @param {Record<string,any>} job @param {Record<string,any>} event @param {unknown} proof */
async function saveDirectCompletion(order,job,event,proof) {
  const changed=order.outbound_operator_status!=='loaded' || order.receiving_status!=='received' || order.local_yard_order_status!=='Received';
  const completedAt=(event.linkedEvents || [event]).map((/** @type {Record<string,any>} */ e)=>e.completed_at)
    .sort((/** @type {any} */ a,/** @type {any} */ b)=>new Date(b).valueOf()-new Date(a).valueOf())[0];
  if(changed) {
    await query(`UPDATE transfer_orders SET outbound_operator_status='loaded',receiving_status='received',
      local_yard_order_status='Received',received_at=COALESCE(received_at,$2::timestamptz),status_updated_at=now() WHERE netsuite_id=$1`,[order.netsuite_id,completedAt]);
    await writeAudit({actorType:'system',source:'admin',action:'operator.to.direct_completion',orderId:order.netsuite_id,
      details:{orderRef:order.tranid,receiptId:job.operator_record_id,jobId:job.id,driverTarget:job.snapshot.driverTarget,
        completionEventIds:(event.linkedEvents || [event]).map((/** @type {Record<string,any>} */ e)=>e.id),verifiedFulfillment:proof || null,
        reason:'Completed linked customer delivery includes its loaded PALLET packaging.'}});
  }
  await query(`SELECT dispatch_record_order_completion('TO',$1,$2::timestamptz,'direct_dependency',$3,
    $4,$5::date,$6,'system','','Complete direct customer transfer',$7::jsonb)`,[order.tranid,completedAt,
    job.snapshot.directReceiptJobId,job.snapshot.planId,job.snapshot.planDate,job.snapshot.loadId,JSON.stringify({
      directShipCoverageVerified:true,wholeTransferCoverageVerified:true,receiptId:job.operator_record_id,
      dependencyIds:job.snapshot.driverTarget.dependencyIds,driverOrderRefs:job.snapshot.driverTarget.orderRefs})]);
  return changed;
}

/** @param {unknown} orderId @param {Record<string,any>|null} verifiedFulfillment @returns {Promise<Record<string,any>>} */
async function directCompletionState(orderId,verifiedFulfillment) {
    const order=(await query('SELECT * FROM transfer_orders WHERE netsuite_id=$1 FOR UPDATE',[orderId])).rows[0];
    if(!order){return {status:'missing'};}
    const dependencies=await readTransferDriverDependencies([orderId]),scope=linkedTransferDriverScope(dependencies);
    if(!scope || scope.linkError || dependencies.some(d=>d.status!=='received_local')){return {status:'waiting_dependency'};}
    /** @type {Record<string,any>[]} */
    const local=(await query(`SELECT * FROM transfer_order_lines WHERE transfer_order_id=$1 AND COALESCE(netsuite_active,true)
      AND COALESCE(item_type,'InvtPart') IN ('InvtPart','NonInvtPart') ORDER BY id`,[orderId])).rows;
    const outbound=local.filter(line=>line.line_stage==='outbound' && Number(line.quantity)>0),receiving=local.filter(line=>line.line_stage==='receiving' && Number(line.quantity)>0);
    const lines=directReceiptLines(outbound,receiving);
    if(!lines){return {status:'waiting_identity'};}
    const allocations=(await query(`SELECT dl.* FROM order_dependency_lines dl JOIN order_dependencies d ON d.id=dl.dependency_id
      WHERE d.transfer_order_id=$1 AND d.dependency_mode='direct_to_customer' AND d.status<>'cancelled'
        AND dl.allocated_quantity>0`,[orderId])).rows;
    if(!completeMaterialCoverage(outbound,allocations)){return {status:'waiting_material'};}
    const receipts=(await query("SELECT * FROM receiving_receipt_records WHERE order_id=$1 AND receipt_status='local_direct_receipt' ORDER BY id DESC",[orderId])).rows;
    if(!receipts.length){return {status:'waiting_receipt'};}
    const proposed={local_to_id:order.netsuite_id,order_ref:order.tranid,transaction_type:'IR',operator_record_id:receipts[0].id,
      snapshot:{...scope,lines,...(verifiedFulfillment ? {verifiedFulfillment} : {})}};
    const event=transferPostingCompletion(proposed,await readTransferCompletionEvents(proposed));
    if(!event){return {status:'waiting_driver'};}
    const receipt=matchingDirectReceipt(scope,receipts,event);
    if(!receipt){return {status:'waiting_receipt'};}
    return {order,receipt,event,proposed,lines};
}

/** @param {Record<string,any>} state @param {Record<string,any>[] } loads @param {Record<string,any>|null} verifiedFulfillment @returns {Promise<Record<string,any>>} */
async function directReceiptJob(state,loads,verifiedFulfillment) {
    const {order,receipt,lines}=state,orderId=order.netsuite_id;
    const existing=(await query("SELECT * FROM transfer_order_posting_jobs WHERE local_to_id=$1 AND transaction_type='IR' ORDER BY created_at,id",[orderId])).rows;
    if(existing.length>1){return {status:'attention'};}
    let job=existing[0];
    if(job && String(job.operator_record_id)!==String(receipt.id)){return {status:'attention'};}
    if(job){return {job};}
      job=await captureTransferPosting({order:{...order,destination_location_id:order.to_location_id},
        operatorId:loads.find(load=>load.operator_id)?.operator_id || null,recordId:receipt.id,transactionType:'IR',lines});
      if(!job){throw new Error('The direct transfer receipt job was concurrently captured.');}
      job=(await query(`UPDATE transfer_order_posting_jobs SET snapshot=snapshot||$2::jsonb WHERE id=$1 RETURNING *`,
        [job.id,JSON.stringify({directReceiptJobId:receipt.payload.driverJobId,...(verifiedFulfillment ? {verifiedFulfillment} : {})})])).rows[0];
    return {job};
}

/** @param {unknown} orderId @param {Record<string,any>} [options] */
export async function completeDirectTransfer(orderId,{verifiedFulfillment=null,apply=true}={}) {
  return withTransaction(async()=>{
    const state=await directCompletionState(orderId,verifiedFulfillment);
    if(state.status){return state;}
    const evidence=await readTransferPostingEvidence(state.proposed),loads=transferLoadEvidence(state.proposed,evidence);
    const loaded=verifiedFulfillment ? transferVerifiedFulfillment(state.proposed,evidence)?.lines : loads.flatMap(load=>load.snapshot.lines || []);
    if(!loaded || !transferQuantitiesCovered(state.lines,loaded)){return {status:'waiting_load'};}
    const captured=await directReceiptJob(state,loads,verifiedFulfillment);
    if(captured.status){return captured;}
    const changed=await saveDirectCompletion(state.order,captured.job,state.event,verifiedFulfillment);
    return {status:'completed_local',jobId:captured.job.id,receiptId:String(state.receipt.id),changed,applied:apply};
  },{rollback:!apply});
}

/** @param {Record<string,any>[]} dependencies */
export async function completeDirectTransfersForDependencies(dependencies) {
  for(const id of [...new Set(dependencies.map(row=>row.transfer_order_id))]) {await completeDirectTransfer(id);}
}

// @ts-check
import {query,withTransaction} from './db.js';
import {config} from './config.js';
import {outboundYardLocationId} from './outbound-location-domain.js';
import {getOperatorNetSuitePostingPolicy} from './operator-netsuite-posting-policy-repository.js';
import {createOperatorNetSuitePostingRealSourceResolver,fetchLiveSourceFromNetSuite} from './operator-netsuite-posting-targets.js';
import {createOrReplayOperatorNetSuitePostingCommand,getOperatorNetSuitePostingCommand} from './operator-netsuite-posting-repository.js';
import {buildTransferPostingDraft,transferPostingCompletion} from './transfer-order-posting-domain.js';
import {readTransferCompletionEvents,readTransferPhysicalStatus,readTransferFulfillmentEvidence} from './transfer-order-posting-repository.js';

const resolveStored=createOperatorNetSuitePostingRealSourceResolver({query,fetchLiveSource:fetchLiveSourceFromNetSuite,useStoredOrderLines:true});

/** @param {Record<string,any>} job @param {{readStored?:Function,readLive?:Function}} [dependencies] */
export async function resolveTransferSource(job,{readStored=resolveStored,readLive=fetchLiveSourceFromNetSuite}={}) {
  const functionKey=job.transaction_type==='IF'?'delivery_prep':'receiving';
  const source=await readStored({netsuite_id:job.local_to_id,tranid:job.order_ref,order_type:'transfer_order',
    lines:job.snapshot.lines.map((/** @type {Record<string,any>} */ line)=>({id:line.lineId,line_id:line.sourceLineKey,
      item_id:line.itemId,item_type:'InvtPart',netsuite_active:true}))},{functionKey});
  if(!source){throw new Error('The saved transfer has no valid NetSuite parent identity.');}
  const live=await readLive({sourceOrderKind:'TO',sourceNetSuiteId:source.sourceNetSuiteId});
  if(live.sourceOrderRef!==source.sourceOrderRef){throw new Error('The live NetSuite transfer reference does not match the saved source identity.');}
  const stage=job.transaction_type==='IF'?'outbound':'receiving';
  return {...source,availableLines:source.availableLines.map((/** @type {Record<string,any>} */ line)=>{
    const matches=live.lines.filter((/** @type {Record<string,any>} */ row)=>row.stage===stage && Number(row.restOrderLine)===Number(line.orderLine));
    if(matches.length!==1 || matches[0].identityStatus!=='exact' || Number(matches[0].itemId)!==Number(line.itemId)) {
      throw new Error('The live transfer source line identity does not match the saved item.');
    }
    return {...line,orderedQuantity:matches[0].orderedQuantity ?? matches[0].quantity,
      completedQuantity:matches[0].completedQuantity,remainingQuantity:matches[0].remainingQuantity,
      ...(matches[0].unit ? {salesUom:String(matches[0].unit).trim().toUpperCase()} : {})};
  })};
}

/** @param {string} id @param {string} status @param {string|null} [error] */
async function waitFor(id,status,error=null) {
  return (await query('UPDATE transfer_order_posting_jobs SET status=$2,last_error=$3,updated_at=now() WHERE id=$1 RETURNING *',[id,status,error])).rows[0];
}

/** @param {string|null} status @returns {status is string} */
function waitingForPhysicalRecord(status) {
  return Boolean(status && status!=='waiting_fulfillment');
}

/** @param {Record<string,any>} job @param {unknown} photos */
async function transferAdmissionInput(job,photos) {
  const proof=job.snapshot.driverTarget && job.transaction_type==='IR' ? await readTransferFulfillmentEvidence(job) : null;
  return {snapshot:{...job.snapshot,photos,...(proof ? {verifiedFulfillment:proof} : {})},
    serializedFulfillment:proof ? JSON.stringify(proof) : null};
}

/** @param {string} id @param {{resolveSource?:Function,getPolicy?:Function}} [dependencies] */
export async function prepareTransferPostingJob(id,{resolveSource=resolveTransferSource,getPolicy=getOperatorNetSuitePostingPolicy}={}) {
  try {
    return await withTransaction(async()=>{
      const job=(await query('SELECT * FROM transfer_order_posting_jobs WHERE id=$1 FOR UPDATE SKIP LOCKED',[id])).rows[0];
      if(!job){return null;}
      if(job.command_id){return {...job,command:await getOperatorNetSuitePostingCommand(job.command_id)};}
      if(['attention','completed'].includes(job.status)){return job;}
      const physicalStatus=await readTransferPhysicalStatus(job);
      if(waitingForPhysicalRecord(physicalStatus)){return waitFor(id,physicalStatus);}
      const event=transferPostingCompletion(job,await readTransferCompletionEvents(job));
      if(!event){return waitFor(id,'waiting_driver');}
      if(physicalStatus){return waitFor(id,physicalStatus);}
      const policy=await getPolicy({functionKey:job.transaction_type==='IF'?'delivery_prep':'receiving',
        locationId:outboundYardLocationId(job.snapshot.locationId),lock:true});
      if(!policy.effective){return waitFor(id,'gate_disabled','The yard posting gate is disabled.');}
      const record=(await query(job.transaction_type==='IF'
        ? 'SELECT photo_data_urls FROM operator_load_records WHERE id=$1 AND order_id=$2'
        : 'SELECT photo_data_urls FROM receiving_receipt_records WHERE id=$1 AND order_id=$2',[job.operator_record_id,job.local_to_id])).rows[0];
      if(!record){throw new Error('The saved Operator completion record is missing.');}
      const source=await resolveSource(job);
      const admission=await transferAdmissionInput(job,record.photo_data_urls);
      const draft=buildTransferPostingDraft({...job,snapshot:admission.snapshot},source,policy,event);
      const created=await createOrReplayOperatorNetSuitePostingCommand(draft);
      const completionIds=(event.linkedEvents || [event]).map((/** @type {Record<string,any>} */ e)=>String(e.id)).sort();
      await query(`UPDATE transfer_order_posting_jobs SET command_id=$2,completion_event_id=$3,status='admitted',last_error=NULL,
        snapshot=snapshot||jsonb_build_object('completionEventIds',$4::jsonb)
          ||CASE WHEN $5::jsonb IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('verifiedFulfillment',$5::jsonb) END,updated_at=now() WHERE id=$1`,
      [id,created.command.id,event.id,JSON.stringify(completionIds),admission.serializedFulfillment]);
      return {...job,status:'admitted',command:created.command};
    });
  } catch(error) {
    const details=/** @type {any} */(error);
    const status=details?.code==='OPERATOR_NETSUITE_POSTING_ORDER_CLAIMED'?'waiting_posting':'attention';
    await query('UPDATE transfer_order_posting_jobs SET status=$2,last_error=$3,updated_at=now() WHERE id=$1 AND command_id IS NULL',
      [id,status,error instanceof Error?error.message:String(error)]);
    if(status==='attention'){throw error;}
    return {id,status};
  }
}

/** Audited by the Admin route. The immutable command and external ID survive retries. */
/** @param {string} id */
export async function retryTransferPostingJob(id) {
  return withTransaction(async()=>{
    const job=(await query('SELECT * FROM transfer_order_posting_jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!job){throw Object.assign(new Error('Transfer posting job not found.'),{status:404});}
    if(job.status==='completed'){return job;}
    if(job.command_id) {
      const command=(await query('SELECT status FROM operator_netsuite_posting_commands WHERE id=$1 FOR UPDATE',[job.command_id])).rows[0];
      if(['failed','attention'].includes(command.status)) {
        await query('UPDATE operator_netsuite_posting_order_claims SET active=true,released_at=NULL WHERE command_id=$1',[job.command_id]);
        await query("UPDATE operator_netsuite_posting_commands SET status='queued',last_error=NULL,updated_at=now() WHERE id=$1",[job.command_id]);
      }
    } else {await waitFor(id,'waiting_driver');}
    return job;
  });
}

let ticking=false;
/** @param {{directAccessEnabled?:boolean,prepare?:Function,enqueue:Function}} dependencies */
export async function transferPostingTick({directAccessEnabled=config.netsuite.directAccessEnabled,prepare=prepareTransferPostingJob,enqueue}) {
  if(ticking || !directAccessEnabled){return {discovered:0};}
  ticking=true;
  try {
    const jobs=(await query(`SELECT id FROM transfer_order_posting_jobs
      WHERE command_id IS NULL AND status NOT IN ('completed','attention') ORDER BY updated_at,created_at LIMIT 10`)).rows;
    for(const job of jobs) {
      try {const ready=await prepare(job.id);if(ready?.command){void enqueue(ready.command.id);}}
      catch(error){console.error(`Transfer posting job ${job.id}:`,error instanceof Error?error.message:String(error));}
    }
    return {discovered:jobs.length};
  } finally {ticking=false;}
}

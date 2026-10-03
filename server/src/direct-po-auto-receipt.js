// @ts-check
import { config } from './config.js';
import { query,withTransaction } from './db.js';
import { fetchTransactionStatusFromNetSuite } from './netsuite.js';
import { outboundYardLocationId } from './outbound-location-domain.js';
import { getOperatorNetSuitePostingPolicy } from './operator-netsuite-posting-policy-repository.js';
import { createOrReplayOperatorNetSuitePostingCommand,getOperatorNetSuitePostingCommand } from './operator-netsuite-posting-repository.js';
import { operatorNetSuitePostingRuntime } from './operator-netsuite-posting-runtime.js';
import { fetchLiveSourceFromNetSuite } from './operator-netsuite-posting-targets.js';
import { isCompletedNetSuitePostingOrder } from './netsuite-fulfillable-items.js';
import { buildDirectPoReceiptDraft } from './direct-po-auto-receipt-domain.js';

/** @param {{fetchStatus?:Function,fetchSource?:Function}} [dependencies] */
export function createDirectPoSourceFetcher({fetchStatus=fetchTransactionStatusFromNetSuite,fetchSource=fetchLiveSourceFromNetSuite}={}) {
  return async (/** @type {{sourceOrderKind:string,sourceNetSuiteId:number}} */ input)=>{
    const header=await fetchStatus(input.sourceNetSuiteId,'PurchOrd');
    if(!header){throw new Error('The completed direct PO is absent from NetSuite.');}
    if(isCompletedNetSuitePostingOrder('PO',header)){return {...input,...header,lines:[]};}
    return fetchSource(input);
  };
}
const fetchDirectPoSource=createDirectPoSourceFetcher();


/** @param {Record<string,any>} order @param {Record<string,any>} job */
async function readDirectDeliveryProof(order,job) {
  const pickups=(await query(`SELECT DISTINCT pickup.driver_job_id FROM dispatch_so_po_allocation_execution_events delivered
    JOIN dispatch_so_po_allocation_execution_events pickup ON pickup.allocation_id=delivered.allocation_id AND pickup.phase='pickup'
  AND pickup.plan_id IS NOT DISTINCT FROM delivered.plan_id AND pickup.load_id=delivered.load_id
    WHERE delivered.phase='delivered' AND delivered.driver_job_id=$1 AND delivered.po_order_ref IN($2,$3)
    ORDER BY pickup.driver_job_id`,[job.completion_evidence_id,order.dispatch_ref || order.tranid,order.tranid])).rows;
  if(!pickups.length || job.metadata.directShipCoverageVerified!==true){throw new Error('Exact direct PO pickup and delivery evidence is unavailable.');}
  const proof=(await query('SELECT status,stop_type,completed_at,photo_data_urls FROM driver_job_records WHERE job_id=$1',[job.completion_evidence_id])).rows[0];
  if(!proof || proof.status!=='complete' || proof.stop_type!=='dropoff' || !proof.completed_at){throw new Error('The direct PO delivery job is incomplete.');}
  return {pickups,proof};
}

/** @param {string} id @param {{fetchSource?:Function,getPolicy?:Function}} [dependencies] */
export async function prepareDirectPoReceiptJob(id,{fetchSource=fetchDirectPoSource,getPolicy=getOperatorNetSuitePostingPolicy}={}) {
  try {
    return await withTransaction(async()=>{
      const job=(await query(`SELECT job.*,event.completion_evidence_id,event.metadata
        FROM dispatch_direct_po_ir_jobs job JOIN dispatch_effective_order_completion_events event ON event.id=job.completion_event_id
        WHERE job.id=$1 FOR UPDATE OF job SKIP LOCKED`,[id])).rows[0];
      if(!job){return null;}
      if(job.command_id){return {...job,command:await getOperatorNetSuitePostingCommand(job.command_id)};}
      if(['reconciled','attention'].includes(job.status)){return job;}
      const order=(await query(`SELECT po.*,COALESCE(split.source_po_id,po.netsuite_id) AS source_po_id,
          COALESCE(split.source_po_ref,po.tranid) AS source_po_ref,split.id AS split_ledger_id
        FROM purchase_orders po LEFT JOIN dispatch_scm_po_splits split ON split.split_po_id=po.netsuite_id AND split.status='active'
        WHERE po.netsuite_id=$1`,[job.local_po_id])).rows[0];
      if(!order || Number(order.source_po_id)<=0){throw new Error('The completed direct PO has no positive NetSuite parent.');}
      const policy=await getPolicy({functionKey:'receiving',locationId:outboundYardLocationId(order.destination_location_id),lock:true});
      if(!policy.effective){
        await query("UPDATE dispatch_direct_po_ir_jobs SET status='gate_disabled',last_error='The receiving IR gate is disabled.',updated_at=now() WHERE id=$1",[id]);
        return {...job,status:'gate_disabled'};
      }
      const source=await fetchSource({sourceOrderKind:'PO',sourceNetSuiteId:Number(order.source_po_id)});
      if(isCompletedNetSuitePostingOrder('PO',source)) {
        await query("UPDATE dispatch_direct_po_ir_jobs SET status='reconciled',last_error=NULL,result=$2::jsonb,updated_at=now() WHERE id=$1",
          [id,JSON.stringify({reason:'live_order_complete',status:source.status,statusText:source.statusText})]);
        return {...job,status:'reconciled'};
      }
      const lines=(await query(`SELECT local.*,
          COALESCE(parent.line_id,local.line_id)::text AS source_line_key
        FROM purchase_order_lines local
        LEFT JOIN dispatch_scm_po_split_lines ledger ON ledger.split_id=$2 AND ledger.split_line_id=local.id
        LEFT JOIN purchase_order_lines parent ON parent.id=ledger.source_line_id AND parent.purchase_order_id=$3
        WHERE local.purchase_order_id=$1 AND COALESCE(local.netsuite_active,true) AND local.quantity>0
        ORDER BY local.line_id,local.id`,[order.netsuite_id,order.split_ledger_id || null,order.source_po_id])).rows;
      const {pickups,proof}=await readDirectDeliveryProof(order,job);
      const draft=buildDirectPoReceiptDraft({requestId:job.id,order,lines,source,policy,photoRefs:proof.photo_data_urls,
        evidence:{completionEventId:Number(job.completion_event_id),sourcePoId:Number(order.source_po_id),
          pickupJobIds:pickups.map((/** @type {Record<string,any>} */ row)=>row.driver_job_id),deliveryJobId:job.completion_evidence_id}});
      if(!draft.steps.length) {
        await query("UPDATE dispatch_direct_po_ir_jobs SET status='reconciled',last_error=NULL,result=$2::jsonb,updated_at=now() WHERE id=$1",
          [id,JSON.stringify({reason:'no_live_line_remaining',lineReconciliation:draft.lineReconciliation})]);
        return {...job,status:'reconciled'};
      }
      const created=await createOrReplayOperatorNetSuitePostingCommand(draft);
      await query("UPDATE dispatch_direct_po_ir_jobs SET command_id=$2,status='admitted',last_error=NULL,updated_at=now() WHERE id=$1",[id,created.command.id]);
      return {...job,status:'admitted',command:created.command};
    });
  } catch(error) {
    await query("UPDATE dispatch_direct_po_ir_jobs SET status='attention',last_error=$2,updated_at=now() WHERE id=$1 AND command_id IS NULL",
      [id,error instanceof Error ? error.message : String(error)]);
    throw error;
  }
}

let ticking=false;
/** @param {{directAccessEnabled?:boolean,prepare?:Function,enqueue?:Function}} [dependencies] */
export async function directPoAutoReceiptTick({directAccessEnabled=config.netsuite.directAccessEnabled,
  prepare=prepareDirectPoReceiptJob,enqueue=(/** @type {string} */ id)=>operatorNetSuitePostingRuntime.enqueue(id)}={}) {
  if(ticking || !directAccessEnabled){return {discovered:0};}
  ticking=true;
  try {
    const jobs=(await query(`SELECT job.id FROM dispatch_direct_po_ir_jobs job JOIN purchase_orders po ON po.netsuite_id=job.local_po_id
      LEFT JOIN mbt_feature_flags flag ON flag.flag_key='operator_netsuite_receiving_ir_'||
        CASE po.destination_location_id WHEN 1 THEN '3445' WHEN 28 THEN '2967' WHEN 13 THEN '2967' WHEN 15 THEN '12441' WHEN 26 THEN '150' END
      WHERE job.command_id IS NULL AND (job.status='discovered' OR (job.status='gate_disabled' AND flag.enabled))
      ORDER BY job.created_at LIMIT 10`)).rows;
    for(const job of jobs) {
      try {const prepared=await prepare(job.id);if(prepared?.command){await enqueue(prepared.command.id);}}
      catch(error){console.error(`Direct PO receipt job ${job.id} failed:`,error instanceof Error?error.message:String(error));}
    }
    return {discovered:jobs.length};
  } finally {ticking=false;}
}

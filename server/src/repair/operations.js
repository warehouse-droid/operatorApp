import {query,withTransaction} from '../db.js';
import {requestRow} from './repository.js';
import * as d from '../../public/repair/domain.js';
import {lockRepairScope} from './locking.js';
export function createRepairOperations({repo,adapter,enabled=()=>true}){
 const office=actor=>d.requireAllowed(d.canViewCosts(actor));
 async function audit(actor,id,kind,data){await query('INSERT INTO repair_events(request_id,actor,kind,data) VALUES($1,$2,$3,$4)',[id,d.actorKey(actor),kind,data]);}
 async function execute(prepared,actor,id){
   let task=(await query('SELECT * FROM repair_postings WHERE id=$1',[prepared.id])).rows[0];
   if(task.state==='done')return {id:task.id,state:'done',result:task.result};
   const claimed=await query("UPDATE repair_postings SET payload=jsonb_set(payload,'{executing}','true') WHERE id=$1 AND lease_token=$2 AND state='working' AND payload->>'executing'='false' RETURNING *",[prepared.id,prepared.token]);
   if(!claimed.rowCount)throw d.fail('This posting is in progress or requires reconciliation.',409);task=claimed.rows[0];
   const heartbeat=setInterval(()=>{void query("UPDATE repair_postings SET lease_until=now()+interval '5 minutes' WHERE id=$1 AND lease_token=$2 AND state='working'",[task.id,prepared.token]).catch(()=>{});},30000);heartbeat.unref();
   const remember=async data=>{const saved=await query("UPDATE repair_requests SET data=data||$2::jsonb WHERE id=$1 AND EXISTS(SELECT 1 FROM repair_postings WHERE id=$3 AND lease_token=$4 AND state='working')",[task.request_id,data,task.id,prepared.token]);if(!saved.rowCount)throw d.fail('Posting lease lost. Reconcile NetSuite before retrying.',409);};
   try{
    const type=task.payload.documentType,s=type==='bill'?{settings:{mappings:await repo.directoryMappings()}}:await repo.manualSnapshot(id);let result;
    if(type==='wor')result=await adapter.postWor(s.job,s.settings.mappings,s.quotes.flatMap(q=>q.lines.map(line=>({...line,jobId:q.job_id}))),s.usages,s.work,remember);
    else if(type==='sos')result=await adapter.postSos(s.job,s.settings.mappings,s.quotes.flatMap(q=>q.lines),remember);
    else result=await adapter.bill(await repo.getPurchase(actor,task.purchase_id),s.settings.mappings);
    const at=new Date().toISOString();
    await withTransaction(async()=>{
     const saved=await query("UPDATE repair_postings SET state='done',result=$3,error=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2 AND state='working' RETURNING id",[task.id,prepared.token,result]);if(!saved.rowCount)throw d.fail('Posting lease lost. Reconcile NetSuite before retrying.',409);
     if(type==='bill')await query('UPDATE repair_purchases SET data=data||$2::jsonb,revision=revision+1 WHERE id=$1',[task.purchase_id,result]);
     else await query('UPDATE repair_requests SET data=data||$2::jsonb WHERE id=$1',[task.request_id,{...result,[`${type}PostedAt`]:at}]);
     await audit(actor,task.request_id,'manual_post_completed',{postingId:task.id,documentType:type,purchaseId:task.purchase_id});
    });return {id:task.id,state:'done',result};
   }catch(error){
    const uncertain=!error.status||error.status>=500,state=uncertain?'uncertain':'attention',message=error.code?.startsWith('REPAIR_')?error.message:uncertain?'NetSuite outcome is uncertain. Reconcile the linked records before retrying.':`NetSuite rejected the operation (${error.status}). Review mappings and linked records.`;
    await query("UPDATE repair_postings SET state=$3,error=$4,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2",[task.id,prepared.token,state,message]);return {id:task.id,state,error:message};
   }finally{clearInterval(heartbeat);}
 }
 return {
  async status(actor,id){office(actor);return {...await repo.postingStatus(actor,id),serverEnabled:enabled()};},
  async post(actor,id,input){
   office(actor);if(!enabled())throw d.fail('Manual NetSuite posting is disabled by the server configuration.',409);
   return execute(await repo.beginManualPosting(actor,id,input),actor,id);
  },
  async postBill(actor,id,input){office(actor);if(!enabled())throw d.fail('Manual NetSuite posting is disabled by the server configuration.',409);return execute(await repo.beginManualBill(actor,id,input),actor,null);},
  async link(actor,id,input){office(actor);const view=await repo.get(actor,id),job=view.request||view,jobId=view.id;id=job.id;const kind=d.choice(input.kind,['wor','sos'],'record type');const result=await adapter.link(kind,d.reference(input.netsuiteId),job);const reason=d.text(input.reason,'Link reason');
   return withTransaction(async()=>{await query("SELECT pg_advisory_xact_lock(hashtext('dispatch_fleet_planning_mutation'))");
    await lockRepairScope(query,[id]);
    const row=(await query('SELECT * FROM repair_requests WHERE id=$1 FOR UPDATE',[id])).rows[0];const child=(await query('SELECT revision FROM repair_jobs WHERE id=$1 FOR UPDATE',[jobId])).rows[0];if(row.revision!==job.revision||child.revision!==input.revision)throw d.fail('Repair changed. Refresh before linking.',409);
    if((await query("SELECT id FROM repair_requests WHERE id<>$1 AND data->>$2=$3",[id,`${kind}Id`,String(result.id)])).rowCount)throw d.fail('This NetSuite record is already linked to another repair.',409);
    if((await query("SELECT id FROM repair_postings WHERE request_id=$1 AND state='working'",[id])).rowCount)throw d.fail('A posting is in progress. Wait before changing links.',409);
    await query('UPDATE repair_requests SET data=data||$2::jsonb,revision=revision+1 WHERE id=$1',[id,{[`${kind}Id`]:String(result.id),[`${kind}Ref`]:result.tranId||result.name,manualLinks:true,...(kind==='sos'?{sosFingerprint:adapter.fingerprint(result)}:{})}]);
    await query("UPDATE repair_postings SET state='attention',error='Manual link added. Office must reconcile the existing inspection and quote lines before automatic posting.' WHERE request_id=$1 AND state='pending'",[id]);
    await query('UPDATE repair_jobs SET revision=revision+1 WHERE id=$1',[jobId]);await audit(actor,id,'netsuite_linked',{kind,id:String(result.id),reason});return repo.get(actor,jobId);
   });
  },
  async linkBill(actor,id,input){office(actor);const purchase=await repo.getPurchase(actor,id);const bill=await adapter.link('bill',d.reference(input.netsuiteId),null,purchase);const reason=d.text(input.reason,'Link reason');
   return withTransaction(async()=>{
    await lockRepairScope(query,[id]);
    const row=(await query('SELECT * FROM repair_purchases WHERE id=$1 FOR UPDATE',[id])).rows[0];if(row.revision!==input.revision)throw d.fail('Purchase changed. Refresh before linking.',409);
    if((await query("SELECT id FROM repair_postings WHERE purchase_id=$1 AND state='working'",[id])).rowCount)throw d.fail('A Bill posting is in progress.',409);
    await query('UPDATE repair_purchases SET data=data||$2::jsonb,revision=revision+1 WHERE id=$1',[id,{billId:String(bill.id),billRef:bill.tranId}]);await query("UPDATE repair_postings SET state='done',error=NULL,result=$2 WHERE purchase_id=$1",[id,{billId:String(bill.id),manual:true}]);await audit(actor,null,'bill_linked',{purchaseId:id,billId:String(bill.id),reason});return repo.getPurchase(actor,id);
   });
  },
  async retry(actor,id,input){office(actor);const reason=d.text(input.reason,'Reconciliation and retry reason');return withTransaction(async()=>{
   const row=(await query('SELECT * FROM repair_postings WHERE id=$1 FOR UPDATE',[d.uuid(id)])).rows[0];if(!row)throw d.fail('Posting not found.',404);if(!['attention','uncertain'].includes(row.state))throw d.fail('Only postings needing review can be retried.',409);
   if(row.request_id){const job=requestRow((await query('SELECT * FROM repair_requests WHERE id=$1',[row.request_id])).rows[0]);if(job.data.equipmentReconciliation)throw d.fail('Corrected equipment requires office reconciliation of its existing WOR/SOS. Automatic retry is blocked.',409);if(job.data.manualLinks&&row.payload.manual!==true)throw d.fail('Manually linked records require office reconciliation in NetSuite. Automatic replacement is blocked.',409);}
   if(row.payload.manual===true&&row.kind!=='bill')await query("UPDATE repair_postings SET state='done',error=NULL,result=result||'{\"reconciledForRetry\":true}'::jsonb WHERE id=$1",[id]);
   else
   await query("UPDATE repair_postings SET state='pending',error=NULL,next_attempt_at=now() WHERE id=$1",[id]);await audit(actor,row.request_id,'posting_retry',{postingId:id,reason});return {ok:true};
  });}
 };
}

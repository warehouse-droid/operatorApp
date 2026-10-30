import {randomUUID} from 'node:crypto';
import {query as dbQuery,withTransaction} from '../db.js';
import {requestRow} from './repository.js';
import {fail} from '../../public/repair/domain.js';
export function createRepairWorker({query=dbQuery,transaction=withTransaction,enabled,adapter,repo,logger=console}){
 let busy=false;
 async function tick(){
  if(!enabled())return {enabled:false};if(busy)return {busy:true};busy=true;
  let task,heartbeat,purchaseNumber;
  try{
   await query("UPDATE repair_postings SET state='uncertain',error='Worker lease expired; reconcile NetSuite before retrying.',lease_token=NULL WHERE state='working' AND lease_until<now()");
   const settings=(await query('SELECT data FROM repair_settings')).rows[0].data;if(!settings.postingEnabled)return {enabled:false};
   task=await transaction(async()=>{
    const row=(await query(`SELECT p.* FROM repair_postings p WHERE p.state='pending' AND p.next_attempt_at<=now() AND NOT EXISTS(SELECT 1 FROM repair_postings other WHERE other.id<>p.id AND ((other.request_id=p.request_id AND p.request_id IS NOT NULL) OR (other.purchase_id=p.purchase_id AND p.purchase_id IS NOT NULL)) AND (other.state IN ('working','uncertain','attention') OR other.state='pending' AND (other.created_at,other.id)<(p.created_at,p.id))) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
    if(!row)return null;row.lease_token=randomUUID();await query("UPDATE repair_postings SET state='working',attempt=attempt+1,lease_token=$2,lease_until=now()+interval '5 minutes' WHERE id=$1",[row.id,row.lease_token]);return row;
   });if(!task)return {idle:true};
   heartbeat=setInterval(()=>{void query("UPDATE repair_postings SET lease_until=now()+interval '5 minutes' WHERE id=$1 AND lease_token=$2 AND state='working'",[task.id,task.lease_token]).catch(()=>logger.error('[Repair] Posting lease heartbeat failed.'));},30000);heartbeat.unref();
   const remember=async data=>{
    const result=await query("UPDATE repair_requests SET data=data||$2::jsonb WHERE id=$1 AND EXISTS(SELECT 1 FROM repair_postings WHERE id=$3 AND lease_token=$4 AND state='working')",[task.request_id,JSON.stringify(data),task.id,task.lease_token]);
    if(!result.rowCount)throw fail('Posting lease lost; reconcile NetSuite before retry.',409);
   };
   let result;
   if(task.kind==='bill'){
    const purchase=await repo.getPurchase({role:'repair_office'},task.purchase_id);purchaseNumber=purchase.number;if(purchase.status!=='completed')throw fail('Purchase is not complete.',409);
    if(purchase.data.poNumber&&purchase.lines.some(l=>l.receivedMilli<l.quantityMilli))throw fail('Receive every PO part before posting the Bill.',409,'REPAIR_PARTS_NOT_RECEIVED');
    result=await adapter.bill(purchase,settings.mappings);await query('UPDATE repair_purchases SET data=data||$2::jsonb WHERE id=$1',[purchase.id,JSON.stringify(result)]);
   }else{
    const job=requestRow((await query('SELECT * FROM repair_requests WHERE id=$1',[task.request_id])).rows[0]);if(!job)throw fail('Repair request is missing.',409);
    if(job.data.manualLinks)throw fail('Manually linked orders require office reconciliation in NetSuite; automatic replacement is blocked.',409,'REPAIR_MANUAL_LINK');
    if(job.data.equipmentReconciliation)throw fail('Corrected equipment requires office reconciliation of the existing WOR/SOS before automatic posting.',409,'REPAIR_EQUIPMENT_RECONCILIATION');
    // Persist the attempted version for accounting and crash reconciliation.
    await query('UPDATE repair_postings SET payload=$2 WHERE id=$1 AND lease_token=$3',[task.id,{revision:job.revision,quoteId:job.data.quoteId||null},task.lease_token]);
    if(task.kind==='inspection')result=await adapter.inspection(job,settings.mappings,remember);
    else{
     const quotes=(await query("SELECT * FROM repair_quotes WHERE request_id=$1 AND status<>'superseded' ORDER BY scope_number,version",[job.id])).rows;if(!quotes.length||quotes.some(q=>q.status!=='decided')||job.data.quoteNeeded)throw fail('Current quote is awaiting decisions; office review required.',409);
     const usages=(await query('SELECT * FROM repair_part_usages WHERE request_id=$1',[job.id])).rows.map(row=>({quoteLineId:row.quote_line_id,kind:row.kind,quantityMilli:Number(row.quantity_milli)}));
     const work=(await query('SELECT * FROM repair_work_entries WHERE request_id=$1',[job.id])).rows;
     result=await adapter.complete(job,settings.mappings,quotes.flatMap(q=>q.lines),usages,work);
    }
    await remember(result);
   }
   await query("UPDATE repair_postings SET state='done',result=$3,error=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2",[task.id,task.lease_token,result]);return {id:task.id,state:'done'};
  }catch(error){
   if(!task)throw error;
   const ambiguous=!error.status||error.status>=500;const state=ambiguous?'uncertain':'attention';
   // Store a safe message, never a remote response that might contain supplier data.
   const message=error.code?.startsWith('REPAIR_')?error.message:ambiguous?'NetSuite outcome is uncertain. Reconcile the linked records before retrying.':`NetSuite rejected the operation (${error.status}). Review mappings, permissions, and linked records.`;
   await query('UPDATE repair_postings SET state=$3,error=$4,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2',[task.id,task.lease_token,state,message]);
   await query("INSERT INTO repair_notifications(id,recipient,request_id,kind,message) VALUES($1,'role:repair_office',$2,'posting_attention',$3)",[randomUUID(),task.request_id,purchaseNumber?`${purchaseNumber}: Vendor Bill posting needs office review.`:'A Repair NetSuite posting needs office review.']);return {id:task.id,state};
  }finally{if(heartbeat)clearInterval(heartbeat);busy=false;}
 }
 return {tick};
}

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test,{after} from 'node:test';
import {query,beginRollbackContext,closeDb} from '../../../src/db.js';
import {finalizeTransferPosting,assertTransferPostingStepReady} from '../../../src/transfer-order-posting-repository.js';
import {prepareTransferPostingJob,retryTransferPostingJob,transferPostingTick} from '../../../src/transfer-order-posting-service.js';
import * as p from '../../../src/operator-netsuite-posting-repository.js';
import {createOperatorNetSuitePostingProcessor} from '../../../src/operator-netsuite-posting-service.js';
import {createOperatorNetSuitePostingAdapter} from '../../../src/operator-netsuite-posting-netsuite-adapter.js';
import {getOperatorNetSuitePostingPolicy} from '../../../src/operator-netsuite-posting-policy-repository.js';
import {recordDeliveryLoad} from '../../../src/delivery-repository.js';

after(closeDb);
async function rollback(work){const c=await beginRollbackContext();try{return await c.run(work);}finally{await c.rollback();}}
async function seed(){
 const key=crypto.randomUUID(),id=8_967_000_000+Math.floor(Math.random()*100000),ref=`TO-${key}`,operator=`op-${key}`;
 await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt) VALUES($1,$1,$1,'test','test')`,[operator]);
 await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,status_text,from_location_id,from_location,to_location_id,to_location,netsuite_active,outbound_operator_status)
  VALUES($1,$2,'B','Pending Fulfillment',1,'3445',28,'2967',true,'packed')`,[id,ref]);
 for(const stage of ['outbound','receiving']){await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_stage,line_id,item_id,item_name,item_type,quantity,unit,
   piece_qty,to_pcs,packed_piece_qty,received_piece_qty,confirmed,netsuite_active,location_id)
  VALUES($1,$2,$3,2299,'Step','InvtPart',5,'PC',5,1,5,5,true,true,$4)`,[id,stage,stage==='outbound'?5073149:5073151,stage==='outbound'?1:28]);}
 await query("UPDATE mbt_feature_flags SET enabled=true,revision=revision+1 WHERE flag_key='operator_netsuite_delivery_prep_if_3445'");
 return {id,ref,operator};
}
async function loadJob(f){
 await recordDeliveryLoad(f.id,f.operator,{photoDataUrls:['r2://fixture/a','r2://fixture/b'],requestId:crypto.randomUUID()});
 return (await query("SELECT * FROM transfer_order_posting_jobs WHERE local_to_id=$1 AND transaction_type='IF'",[f.id])).rows[0];
}
const deps=(f,resolveSource)=>({getPolicy:input=>getOperatorNetSuitePostingPolicy({...input,directAccessEnabled:true}),
 resolveSource:resolveSource || (async()=>({sourceOrderKind:'TO',sourceNetSuiteId:f.id,sourceOrderRef:f.ref,
  availableLines:[{sourceLineKey:'5073149',orderLine:2,itemId:2299,location:null,orderedQuantity:5,remainingQuantity:5,completedQuantity:0}]}))});
const lockTimeout=async()=>{throw Object.assign(new Error('canceling statement due to lock timeout'),{code:'55P03'});};
const jobRow=async id=>(await query('SELECT * FROM transfer_order_posting_jobs WHERE id=$1',[id])).rows[0];
const commandRow=async id=>(await query('SELECT * FROM operator_netsuite_posting_commands WHERE id=$1',[id])).rows[0];
const secondsUntil=async at=>Number((await query('SELECT extract(epoch FROM $1::timestamptz-now()) AS s',[at])).rows[0].s);

test('a lock timeout while preparing a transfer posting waits and retries instead of stopping for Admin',()=>rollback(async()=>{
 const f=await seed(),job=await loadJob(f);
 const result=await prepareTransferPostingJob(job.id,deps(f,lockTimeout));
 assert.equal(result.status,'waiting_posting');assert.equal(result.autoRetryCount,1);
 const saved=await jobRow(job.id);
 assert.equal(saved.status,'waiting_posting');assert.equal(saved.auto_retry_count,1);assert.equal(saved.command_id,null);
 assert.match(saved.last_error,/lock timeout/);
 const wait=await secondsUntil(saved.next_retry_at);assert.ok(wait>50&&wait<=60,`first retry waits one minute (${wait}s)`);
 const audit=(await query(`SELECT details FROM delivery_audit_log WHERE action='transfer_order_posting.auto_retry_scheduled' AND details->>'jobId'=$1`,[job.id])).rows;
 assert.equal(audit.length,1);assert.equal(audit[0].details.autoRetry,1);assert.equal(audit[0].details.reason,'timeout_or_lost_connection');

 const picked=[];const tick=()=>transferPostingTick({directAccessEnabled:true,prepare:async id=>{picked.push(id);return null;},enqueue:()=>{}});
 await tick();assert.ok(!picked.includes(job.id),'a job is not prepared again before its retry time');
 await query("UPDATE transfer_order_posting_jobs SET next_retry_at=now()-interval '1 second' WHERE id=$1",[job.id]);
 await tick();assert.ok(picked.includes(job.id),'a due job is prepared again');

 const ready=await prepareTransferPostingJob(job.id,deps(f));
 assert.equal(ready.status,'admitted');assert.ok(ready.command);
 assert.equal((await jobRow(job.id)).next_retry_at,null);
}));

test('the second automatic retry waits five minutes, and after five the job goes to Admin attention',()=>rollback(async()=>{
 const f=await seed(),job=await loadJob(f);
 await prepareTransferPostingJob(job.id,deps(f,lockTimeout));
 await prepareTransferPostingJob(job.id,deps(f,lockTimeout));
 const second=await jobRow(job.id);assert.equal(second.auto_retry_count,2);
 const wait=await secondsUntil(second.next_retry_at);assert.ok(wait>290&&wait<=300,`second retry waits five minutes (${wait}s)`);
 await query("UPDATE transfer_order_posting_jobs SET auto_retry_count=5 WHERE id=$1",[job.id]);
 await assert.rejects(prepareTransferPostingJob(job.id,deps(f,lockTimeout)),/lock timeout/);
 const saved=await jobRow(job.id);assert.equal(saved.status,'attention');assert.equal(saved.auto_retry_count,5);
}));

test('an error that is not a timeout or lost connection still goes straight to Admin attention',()=>rollback(async()=>{
 const f=await seed(),job=await loadJob(f);
 await assert.rejects(prepareTransferPostingJob(job.id,deps(f,async()=>{throw new Error('Invalid NetSuite source line');})),/Invalid NetSuite/);
 const saved=await jobRow(job.id);assert.equal(saved.status,'attention');assert.equal(saved.auto_retry_count,0);assert.equal(saved.next_retry_at,null);
}));

test("a person's retry starts a fresh automatic-retry budget",()=>rollback(async()=>{
 const f=await seed(),job=await loadJob(f);
 await query("UPDATE transfer_order_posting_jobs SET status='attention',auto_retry_count=5,next_retry_at=now() WHERE id=$1",[job.id]);
 await retryTransferPostingJob(job.id);
 const saved=await jobRow(job.id);assert.equal(saved.status,'waiting_posting');assert.equal(saved.auto_retry_count,0);assert.equal(saved.next_retry_at,null);
}));

function engine(){
 const state={remote:null,transforms:0,mode:'timeout'};
 const adapter=createOperatorNetSuitePostingAdapter({checkTransferPosting:assertTransferPostingStepReady,
  findTransactionByExternalId:async()=>state.remote?{id:state.remote.id,record:state.remote}:null,
  transformSalesOrderToItemFulfillment:async()=>assert.fail(),transformPurchaseOrderToItemReceipt:async()=>assert.fail(),
  transformTransferOrderToItemReceipt:async()=>assert.fail(),
  transformTransferOrderToItemFulfillment:async()=>{
   state.transforms++;
   if(state.mode==='reject'){throw Object.assign(new Error('NetSuite REST failed: 400 invalid reference'),{status:400,netsuiteResponseReceived:true});}
   throw Object.assign(new Error('NetSuite request timed out after 120 seconds.'),{code:'NETSUITE_REQUEST_TIMEOUT'});
  },
  fetchItemFulfillment:async()=>state.remote,fetchItemReceipt:async()=>assert.fail()});
 const processor=createOperatorNetSuitePostingProcessor({workerId:'auto-retry-spec',adapter,finalize:finalizeTransferPosting,
  repository:{get:p.getOperatorNetSuitePostingCommand,claim:p.claimOperatorNetSuitePostingCommand,renew:p.renewOperatorNetSuitePostingLease,
   startAttempt:p.startOperatorNetSuitePostingAttempt,success:p.recordOperatorNetSuitePostingStepSuccess,failure:p.recordOperatorNetSuitePostingStepFailure,
   attention:p.markOperatorNetSuitePostingCommandAttention,fail:p.failOperatorNetSuitePostingCommand,complete:p.completeOperatorNetSuitePostingCommand,
   scheduleAutoRetry:p.scheduleOperatorNetSuitePostingAutoRetry}});
 return {state,processor};
}
async function admittedCommand(){
 const f=await seed(),job=await loadJob(f),ready=await prepareTransferPostingJob(job.id,deps(f));
 assert.ok(ready.command,'transfer job is admitted');return {f,job,id:ready.command.id};
}
const resumeDue=async id=>(await p.resumeDueOperatorNetSuitePostingAutoRetries({limit:100})).filter(r=>r.commandId===id);

test('a NetSuite timeout is verified automatically on schedule and never posted twice',()=>rollback(async()=>{
 const {id}=await admittedCommand(),worker=engine();
 let result=await worker.processor.process(id);
 assert.equal(result.status,'attention');assert.equal(worker.state.transforms,1);
 let saved=await commandRow(id);assert.equal(saved.auto_retry_count,0);
 let wait=await secondsUntil(saved.next_auto_retry_at);assert.ok(wait>50&&wait<=60,`verification waits one minute (${wait}s)`);
 assert.deepEqual(await resumeDue(id),[],'nothing resumes before its time');

 await query("UPDATE operator_netsuite_posting_commands SET next_auto_retry_at=now()-interval '1 second' WHERE id=$1",[id]);
 const resumed=await resumeDue(id);assert.equal(resumed.length,1);assert.equal(resumed[0].autoRetryCount,1);
 assert.match(resumed[0].previousError,/timed out/);
 saved=await commandRow(id);assert.equal(saved.status,'queued');assert.equal(saved.next_auto_retry_at,null);

 // NetSuite still shows nothing: verify again later, never transform a second time.
 result=await worker.processor.process(id);
 assert.equal(result.status,'attention');assert.equal(worker.state.transforms,1);
 saved=await commandRow(id);wait=await secondsUntil(saved.next_auto_retry_at);
 assert.ok(wait>290&&wait<=300,`second verification waits five minutes (${wait}s)`);

 // NetSuite created the record late; the next verification finds it and completes.
 const step=result.steps[0];
 worker.state.remote={id:123456,tranId:'IF-LATE',transactionType:'IF',createdFromId:step.sourceNetSuiteId,externalId:step.externalId,
  item:{items:step.payload.item.items.filter(i=>i.itemReceive).map(i=>({...i,item:{id:2299}}))}};
 await query("UPDATE operator_netsuite_posting_commands SET next_auto_retry_at=now()-interval '1 second' WHERE id=$1",[id]);
 assert.equal((await resumeDue(id)).length,1);
 result=await worker.processor.process(id);
 assert.equal(result.status,'completed',result.lastError);assert.equal(worker.state.transforms,1);
 assert.equal(result.steps[0].netSuiteTransactionRef,'IF-LATE');
}));

test('automatic verification stops after five retries and stays with Admin',()=>rollback(async()=>{
 const {id}=await admittedCommand(),worker=engine();
 await worker.processor.process(id);
 await query("UPDATE operator_netsuite_posting_commands SET status='queued',auto_retry_count=5,next_auto_retry_at=NULL WHERE id=$1",[id]);
 const result=await worker.processor.process(id);
 assert.equal(result.status,'attention');
 assert.equal((await commandRow(id)).next_auto_retry_at,null);
}));

test('a NetSuite rejection is not retried automatically',()=>rollback(async()=>{
 const {id}=await admittedCommand(),worker=engine();worker.state.mode='reject';
 const result=await worker.processor.process(id);
 assert.equal(result.status,'failed');assert.equal((await commandRow(id)).next_auto_retry_at,null);
}));

test("a person's Resume verification clears the schedule and starts a fresh budget",()=>rollback(async()=>{
 const {id}=await admittedCommand(),worker=engine();
 await worker.processor.process(id);
 await query("UPDATE operator_netsuite_posting_commands SET auto_retry_count=3 WHERE id=$1",[id]);
 await p.resumeOperatorNetSuitePostingCommand(id);
 const saved=await commandRow(id);
 assert.equal(saved.status,'queued');assert.equal(saved.auto_retry_count,0);assert.equal(saved.next_auto_retry_at,null);
}));

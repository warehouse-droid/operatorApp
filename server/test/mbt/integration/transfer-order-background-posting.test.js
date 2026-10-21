import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test,{after} from 'node:test';
import {query,beginRollbackContext,closeDb,withTransaction} from '../../../src/db.js';
import {finalizeTransferPosting,assertTransferPostingStepReady,listTransferPostingJobs} from '../../../src/transfer-order-posting-repository.js';
import {prepareTransferPostingJob as prepareTransferPostingJobRaw,retryTransferPostingJob,transferPostingTick,resolveTransferSource} from '../../../src/transfer-order-posting-service.js';
import * as postingRepository from '../../../src/operator-netsuite-posting-repository.js';
import {createOperatorNetSuitePostingProcessor} from '../../../src/operator-netsuite-posting-service.js';
import {createOperatorNetSuitePostingAdapter} from '../../../src/operator-netsuite-posting-netsuite-adapter.js';
import {getOperatorNetSuitePostingPolicy} from '../../../src/operator-netsuite-posting-policy-repository.js';
import {recordDeliveryLoad,getDeliveryOrder} from '../../../src/delivery-repository.js';
import {recordReceivingReceipt,getReceivingOrder} from '../../../src/receiving-repository.js';
import {config} from '../../../src/config.js';
import {app} from '../../../src/server.js';
after(closeDb);
async function rollback(work){const c=await beginRollbackContext();try{return await c.run(work);}finally{await c.rollback();}}
async function seed(){
 const key=crypto.randomUUID(),id=8_966_000_000+Math.floor(Math.random()*100000),ref=`TO-${key}`,operator=`op-${key}`;
 await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt) VALUES($1,$1,$1,'test','test')`,[operator]);
 await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,status_text,from_location_id,from_location,to_location_id,to_location,netsuite_active,outbound_operator_status)
  VALUES($1,$2,'B','Pending Fulfillment',1,'3445',28,'2967',true,'packed')`,[id,ref]);
 for(const stage of ['outbound','receiving'])await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_stage,line_id,item_id,item_name,item_type,quantity,unit,
   piece_qty,to_pcs,packed_piece_qty,received_piece_qty,confirmed,netsuite_active,location_id)
  VALUES($1,$2,$3,2299,'Step','InvtPart',5,'PC',5,1,5,5,true,true,$4)`,[id,stage,stage==='outbound'?5073149:5073151,stage==='outbound'?1:28]);
 for(const key of ['operator_netsuite_delivery_prep_if_3445','operator_netsuite_receiving_ir_2967'])await query('UPDATE mbt_feature_flags SET enabled=true,revision=revision+1 WHERE flag_key=$1',[key]);
 return {id,ref,operator,drop:`drop-${key}`,plan:id+1,load:'load'};
}
async function deliver(f){
 await query(`INSERT INTO dispatch_plans(id,plan_date,status,revision) VALUES($1,date '2045-01-01'+($1::bigint % 100000)::int,'confirmed',1)`,[f.plan]);
 await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,load_id,driver_login,stop_type,order_refs,status,completed_at,job_details)
  VALUES($1,$2,current_date,$3,'test','dropoff',$4::jsonb,'complete',now(),'{}')`,[f.drop,f.plan,f.load,JSON.stringify([f.ref])]);
}
const photos=['r2://fixture/a','r2://fixture/b'];
async function load(f){await recordDeliveryLoad(f.id,f.operator,{photoDataUrls:photos,requestId:crypto.randomUUID()});
 return (await query("SELECT * FROM transfer_order_posting_jobs WHERE local_to_id=$1 AND transaction_type='IF'",[f.id])).rows[0];}
async function receive(f){
 if(!(await query("SELECT id FROM operator_load_records WHERE order_id=$1 AND load_type='transfer_order_load'",[f.id])).rowCount)await load(f);
 const order=await getReceivingOrder(f.id),quantity=Number(order.lines[0]?.quantity || 0);
 await query("UPDATE transfer_order_lines SET received_piece_qty=$2 WHERE transfer_order_id=$1 AND line_stage='receiving'",[f.id,quantity]);
 await recordReceivingReceipt(f.id,f.operator,{photoDataUrls:photos,payload:{item:{items:[{orderLine:5073151,itemReceive:true,quantity}]}},response:{localOnly:true}});
 return (await query("SELECT * FROM transfer_order_posting_jobs WHERE local_to_id=$1 AND transaction_type='IR' ORDER BY created_at DESC,id DESC",[f.id])).rows[0];
}
// IR needs verified IF; IF now starts from loading alone. The yard-flow suite
// separately verifies missing physical records and failed IF receiving.
async function prepareCompletedYards(id,options){
 const job=(await query('SELECT * FROM transfer_order_posting_jobs WHERE id=$1',[id])).rows[0];
 if(!job)return prepareTransferPostingJobRaw(id,options);
 const f={id:Number(job.local_to_id),ref:job.order_ref,operator:job.operator_id};
 if(job.transaction_type==='IR'){
  const loaded=(await query("SELECT id FROM transfer_order_posting_jobs WHERE local_to_id=$1 AND transaction_type='IF' ORDER BY created_at LIMIT 1",[f.id])).rows[0];
  const ready=await prepareTransferPostingJobRaw(loaded.id,deps(f));
  if(ready?.command)await engine().processor.process(ready.command.id);
 }
 return prepareTransferPostingJobRaw(id,options);
}
function deps(f,type='IF'){return {getPolicy:input=>getOperatorNetSuitePostingPolicy({...input,directAccessEnabled:true}),
 resolveSource:async()=>({sourceOrderKind:'TO',sourceNetSuiteId:f.id,sourceOrderRef:f.ref,
 availableLines:[{sourceLineKey:type==='IF'?'5073149':'5073151',orderLine:type==='IF'?2:3,itemId:2299,location:null,orderedQuantity:5,remainingQuantity:5,completedQuantity:0}]})};}
for(const type of ['IF','IR'])for(const driverFirst of [true,false])test(`${type}: real local completion admits with ${driverFirst?'completed':'absent'} Driver work`,()=>rollback(async()=>{
 const f=await seed();if(driverFirst)await deliver(f);
 const job=await (type==='IF'?load(f):receive(f));assert.ok(job,'Local completion must atomically capture a durable job');
 const ready=await prepareCompletedYards(job.id,deps(f,type));assert.ok(ready.command,JSON.stringify(ready));assert.equal(ready.command.status,'queued');
 assert.equal(ready.command.steps[0].payload.item.items[0].quantity,5);
 const replay=await prepareCompletedYards(job.id,deps(f,type));assert.equal(replay.command.id,ready.command.id);
 assert.equal((await query('SELECT id FROM transfer_order_posting_jobs WHERE local_to_id=$1',[f.id])).rowCount,type==='IF'?1:2);
}));
test('bad NetSuite reference stays Admin attention while local load remains saved',()=>rollback(async()=>{
 const f=await seed();const job=await load(f);assert.ok(job);await deliver(f);
 await assert.rejects(prepareCompletedYards(job.id,{...deps(f),resolveSource:async()=>{throw new Error('Invalid NetSuite source line');}}),/Invalid NetSuite/);
 const saved=(await query('SELECT * FROM transfer_order_posting_jobs WHERE id=$1',[job.id])).rows[0];
 assert.equal(saved.status,'attention');assert.match(saved.last_error,/Invalid NetSuite/);
 assert.equal(Number((await getDeliveryOrder(f.id)).lines[0].loaded_qty),5);
}));
test('rollback leaves neither local load nor posting job',()=>rollback(async()=>{
 const f=await seed();await assert.rejects(withTransaction(async()=>{await load(f);throw new Error('rollback spec');}),/rollback spec/);
 assert.equal((await query('SELECT id FROM transfer_order_posting_jobs WHERE local_to_id=$1',[f.id])).rowCount,0);
 assert.equal(Number((await getDeliveryOrder(f.id)).lines[0].loaded_qty),0);
}));
test('locally received quantities cannot be received again while NetSuite waits',()=>rollback(async()=>{
 const f=await seed();await receive(f);const order=await getReceivingOrder(f.id);
 assert.equal(order.receipt_status,'received');
 assert.equal(order.lines.reduce((sum,line)=>sum+Number(line.quantity),0),0);
}));
test('background finalization attaches evidence without repeating the local receipt',()=>rollback(async()=>{
 const f=await seed();const job=await receive(f);await deliver(f);
 const ready=await prepareCompletedYards(job.id,deps(f,'IR'));
 const command={...ready.command,steps:ready.command.steps.map(step=>({...step,status:'posted',netSuiteTransactionId:12345,netSuiteTransactionRef:'IR-TEST'}))};
 await finalizeTransferPosting(command);await finalizeTransferPosting(command);
 assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=$1',[f.id])).rowCount,1);
 assert.equal((await query('SELECT item_receipt_id FROM receiving_receipt_records WHERE order_id=$1',[f.id])).rows[0].item_receipt_id,'12345');
 assert.equal((await query('SELECT status FROM transfer_order_posting_jobs WHERE id=$1',[job.id])).rows[0].status,'completed');
}));

test('partial loads retain independent immutable quantities and do not freeze further Operator work',()=>rollback(async()=>{
 const f=await seed();await query("UPDATE transfer_order_lines SET packed_piece_qty=2 WHERE transfer_order_id=$1 AND line_stage='outbound'",[f.id]);
 const first=await load(f);await deliver(f);await prepareCompletedYards(first.id,deps(f));
 await query("UPDATE transfer_orders SET outbound_operator_status='packed' WHERE netsuite_id=$1",[f.id]);
 await query("UPDATE transfer_order_lines SET packed_piece_qty=3,confirmed=true WHERE transfer_order_id=$1 AND line_stage='outbound'",[f.id]);
 await load(f);const jobs=(await query("SELECT * FROM transfer_order_posting_jobs WHERE local_to_id=$1 AND transaction_type='IF' ORDER BY created_at,id",[f.id])).rows;
 assert.deepEqual(jobs.map(j=>j.snapshot.lines[0].quantity).sort(),[2,3]);
 const second=jobs.find(j=>j.id!==first.id);
 assert.equal((await prepareCompletedYards(second.id,deps(f))).status,'waiting_posting');
 assert.equal(Number((await getDeliveryOrder(f.id)).lines[0].loaded_qty),5);
 assert.equal((await query("SELECT local_order_key FROM operator_netsuite_posting_order_claims WHERE local_order_key=$1 AND active",[`delivery_prep:transfer_order:${f.id}`])).rowCount,0);
}));

test('unrelated and withdrawn Driver completion do not block saved yard work',()=>rollback(async()=>{
 const f=await seed();const job=await load(f);await receive(f);await deliver(f);
 await query("UPDATE transfer_order_posting_jobs SET snapshot=snapshot||'{\"loadId\":\"other-load\"}'::jsonb WHERE local_to_id=$1",[f.id]);
 assert.equal((await prepareCompletedYards(job.id,deps(f))).status,'admitted');
 await query("UPDATE transfer_order_posting_jobs SET snapshot=snapshot||jsonb_build_object('loadId',$2::text) WHERE local_to_id=$1",[f.id,f.load]);
 const ready=await prepareCompletedYards(job.id,deps(f));
 await query("UPDATE driver_job_records SET mbt_assignment_withdrawn_at=now() WHERE job_id=$1",[f.drop]);
 assert.equal((await assertTransferPostingStepReady(ready.command.steps[0])).id,job.id);
}));

test('disabled gates and unfinished fulfillment retain receipt work for Admin',()=>rollback(async()=>{
 const f=await seed();const loaded=await load(f),received=await receive(f);await deliver(f);
 await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='operator_netsuite_delivery_prep_if_3445'");
 assert.equal((await prepareCompletedYards(loaded.id,deps(f))).status,'gate_disabled');
 assert.equal((await prepareTransferPostingJobRaw(received.id,deps(f,'IR'))).status,'waiting_fulfillment');
 const listed=await listTransferPostingJobs();assert.ok(listed.some(j=>j.id===loaded.id&&j.status==='gate_disabled'));
}));

function engine(mode='success') {
 let remote=null,transforms=0;const p=postingRepository;
 const adapter=createOperatorNetSuitePostingAdapter({checkTransferPosting:assertTransferPostingStepReady,
  findTransactionByExternalId:async()=>remote?{id:remote.id,record:remote}:null,
  transformSalesOrderToItemFulfillment:async()=>assert.fail(),transformPurchaseOrderToItemReceipt:async()=>assert.fail(),
  transformTransferOrderToItemReceipt:async()=>assert.fail(),
  transformTransferOrderToItemFulfillment:async(id,payload)=>{
   transforms++;
   if(mode==='unknown')throw Object.assign(new Error('Connection lost; remote result is unknown'),{code:'NETSUITE_REQUEST_TIMEOUT'});
   if(mode==='reject'&&transforms===1)throw Object.assign(new Error('NetSuite rejected source'),{status:400,netsuiteResponseReceived:true});
   remote={id:123456,tranId:'IF-TEST',transactionType:'IF',createdFromId:id,externalId:payload.externalId,
     item:{items:payload.item.items.filter(i=>i.itemReceive).map(i=>({...i,item:{id:2299}}))}};
   if(mode==='timeout'&&transforms===1)throw Object.assign(new Error('Connection lost after commit'),{code:'NETSUITE_REQUEST_TIMEOUT'});
   return {id:remote.id};},fetchItemFulfillment:async()=>remote,fetchItemReceipt:async()=>assert.fail()});
 const processor=createOperatorNetSuitePostingProcessor({workerId:'to-spec',adapter,finalize:finalizeTransferPosting,
   repository:{get:p.getOperatorNetSuitePostingCommand,claim:p.claimOperatorNetSuitePostingCommand,renew:p.renewOperatorNetSuitePostingLease,
   startAttempt:p.startOperatorNetSuitePostingAttempt,success:p.recordOperatorNetSuitePostingStepSuccess,failure:p.recordOperatorNetSuitePostingStepFailure,
   attention:p.markOperatorNetSuitePostingCommandAttention,fail:p.failOperatorNetSuitePostingCommand,complete:p.completeOperatorNetSuitePostingCommand}});
 return {processor,transforms:()=>transforms};
}
for(const mode of ['success','reject','timeout'])test(`real durable worker ${mode} preserves local quantities and external identity`,()=>rollback(async()=>{
 const f=await seed(),job=await load(f);await deliver(f);const ready=await prepareCompletedYards(job.id,deps(f));
 const worker=engine(mode);let result=await worker.processor.process(ready.command.id);
 if(mode==='reject'){
  assert.equal(result.status,'failed');assert.equal(Number((await getDeliveryOrder(f.id)).lines[0].loaded_qty),5);
  assert.ok((await listTransferPostingJobs()).some(j=>j.id===job.id&&j.command_status==='failed'));
  await retryTransferPostingJob(job.id);result=await worker.processor.process(ready.command.id);
 }
 assert.equal(result.status,'completed',result.lastError);assert.equal(worker.transforms(),mode==='reject'?2:1);
 assert.equal(result.steps[0].externalId,ready.command.steps[0].externalId);
 await worker.processor.process(ready.command.id);assert.equal(worker.transforms(),mode==='reject'?2:1);
 assert.equal((await query('SELECT id FROM operator_load_records WHERE order_id=$1',[f.id])).rowCount,1);
 assert.equal(Number((await getDeliveryOrder(f.id)).lines[0].loaded_qty),5);
}));

test('uncertain posting without visible remote evidence cannot transform again on an Admin retry',()=>rollback(async()=>{
 const f=await seed(),job=await load(f);await deliver(f);const ready=await prepareCompletedYards(job.id,deps(f));
 const worker=engine('unknown');let result=await worker.processor.process(ready.command.id);
 assert.equal(result.status,'attention');assert.equal(worker.transforms(),1);
 await retryTransferPostingJob(job.id);result=await worker.processor.process(ready.command.id);
 assert.equal(result.status,'attention');assert.equal(worker.transforms(),1);
 assert.equal(result.steps[0].externalId,ready.command.steps[0].externalId);
 assert.equal(Number((await getDeliveryOrder(f.id)).lines[0].loaded_qty),5);
}));

test('capture keeps the assigned plan, load and date without requiring the Driver load',()=>rollback(async()=>{
 const f=await seed();await deliver(f);
 await query(`INSERT INTO dispatch_plan_order_assignments(plan_id,plan_date,order_ref,planned_order_ref,load_id,stop_id)
   VALUES($1,current_date,$2,$2,$3,'drop')`,[f.plan,f.ref,'assigned-load']);
 const job=await load(f),today=(await query('SELECT current_date::text AS date')).rows[0].date;
 assert.equal(String(job.snapshot.planId),String(f.plan));assert.equal(job.snapshot.loadId,'assigned-load');assert.equal(job.snapshot.planDate,today);
 assert.equal((await prepareCompletedYards(job.id,deps(f))).status,'admitted');
 await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,load_id,driver_login,stop_type,order_refs,status,completed_at,job_details)
   SELECT $2,plan_id,plan_date,'assigned-load',driver_login,stop_type,order_refs,status,completed_at,job_details
   FROM driver_job_records WHERE job_id=$1`,[f.drop,`${f.drop}-assigned`]);
 assert.equal((await prepareCompletedYards(job.id,deps(f))).status,'admitted');
 assert.equal(await assertTransferPostingStepReady({commandId:crypto.randomUUID()}),undefined);
}));

test('queue migration can be reapplied and rolled back without losing existing local records',()=>rollback(async()=>{
 const f=await seed(),job=await load(f);
 const sql=(await readFile(new URL('../../../migrations/264_transfer_order_background_posting.sql',import.meta.url),'utf8'))
   .replace(/^BEGIN;\s*/u,'').replace(/COMMIT;\s*$/u,'');
 await withTransaction(async()=>{
  await query('DROP TABLE transfer_order_posting_jobs');await query(sql);await query(sql);
  assert.equal((await query('SELECT id FROM transfer_order_posting_jobs')).rowCount,0);
  assert.equal((await query('SELECT id FROM operator_load_records WHERE id=$1',[job.operator_record_id])).rowCount,1);
 },{rollback:true});
 assert.equal((await query('SELECT id FROM transfer_order_posting_jobs WHERE id=$1',[job.id])).rowCount,1);
 assert.equal(Number((await getDeliveryOrder(f.id)).lines[0].loaded_qty),5);
}));

test('multiple dispatch assignments do not block an independently recorded local load',()=>rollback(async()=>{
 const f=await seed();await deliver(f);
 await query("INSERT INTO dispatch_plans(id,plan_date,status,revision) SELECT id+1,plan_date+1,'confirmed',1 FROM dispatch_plans WHERE id=$1",[f.plan]);
 for(const plan of [f.plan,f.plan+1])await query(`INSERT INTO dispatch_plan_order_assignments(plan_id,plan_date,order_ref,planned_order_ref,load_id)
   VALUES($1,current_date,$2,$2,$3)`,[plan,f.ref,plan===f.plan?f.load:'other-load']);
 const job=await load(f);
 assert.equal((await prepareCompletedYards(job.id,deps(f))).status,'admitted');
 assert.equal((await query('SELECT status FROM transfer_order_posting_jobs WHERE id=$1',[job.id])).rows[0].status,'admitted');
 assert.equal(Number((await getDeliveryOrder(f.id)).lines[0].loaded_qty),5);
}));

test('pre-admission failures retry only through Admin and scheduler remains local-safe',()=>rollback(async()=>{
 const f=await seed(),job=await load(f);await deliver(f);
 await assert.rejects(prepareCompletedYards(job.id,{...deps(f),resolveSource:async()=>{throw new Error('Unavailable source');}}));
 assert.equal((await prepareCompletedYards(job.id,deps(f))).status,'attention');
 await retryTransferPostingJob(job.id);const enqueued=[];
 await transferPostingTick({directAccessEnabled:true,prepare:id=>id===job.id?prepareCompletedYards(id,deps(f)):null,enqueue:async id=>enqueued.push(id)});
 assert.equal(enqueued.length,1);
 assert.deepEqual(await transferPostingTick({directAccessEnabled:false,enqueue:async()=>assert.fail()}),{discovered:0});
}));

test('independent concurrent workers admit exactly one command',async()=>{
 const f=await seed(),job=await load(f);
 const results=await Promise.all([prepareCompletedYards(job.id,deps(f)),prepareCompletedYards(job.id,deps(f))]);
 const commands=results.filter(Boolean).map(r=>r.command.id);
 assert.equal(new Set(commands).size,1);
 assert.equal((await query('SELECT id FROM operator_netsuite_posting_commands WHERE request_id=$1',[job.id])).rowCount,1);
});

test('backend source resolution combines the stored physical identity with live remaining quantities',()=>rollback(async()=>{
 const f=await seed(),job=await load(f);
 const raw={identityStatus:'exact',physicalRows:[
  {id:String(f.id),item_id:'2299',source_line_key:'5073149',order_line_number:'1',signed_quantity:'-5',do_not_print_line:'F'},
  {id:String(f.id),item_id:'2299',source_line_key:'5073150',order_line_number:'2',signed_quantity:'-5',do_not_print_line:'T'}]};
 await query("UPDATE transfer_order_lines SET raw=$2::jsonb,netsuite_order_line=1 WHERE transfer_order_id=$1 AND line_stage='outbound'",[f.id,JSON.stringify(raw)]);
 const live={sourceOrderRef:f.ref,lines:[{stage:'outbound',restOrderLine:2,itemId:2299,identityStatus:'exact',quantity:5,completedQuantity:2,remainingQuantity:3}]};
 const result=await resolveTransferSource(job,{readLive:async()=>live});
 assert.equal(result.availableLines[0].orderLine,2);assert.equal(result.availableLines[0].remainingQuantity,3);
 await assert.rejects(resolveTransferSource(job,{readStored:async()=>null}),/parent identity/);
 await assert.rejects(resolveTransferSource(job,{readLive:async()=>({...live,sourceOrderRef:'wrong'})}),/source identity/);
 await assert.rejects(resolveTransferSource(job,{readLive:async()=>({...live,lines:[]})}),/line identity/);
}));

test('unverified or forged finalization cannot alter the locally saved record',()=>rollback(async()=>{
 const f=await seed(),job=await receive(f);await deliver(f);
 const ready=await prepareCompletedYards(job.id,deps(f,'IR'));
 await assert.rejects(finalizeTransferPosting(ready.command),/must be verified/);
 const forged=structuredClone(ready.command);forged.inputSnapshot.transferEvidence.operatorRecordId++;
 await assert.rejects(finalizeTransferPosting(forged),/does not match/);
 assert.equal((await query('SELECT item_receipt_id FROM receiving_receipt_records WHERE order_id=$1',[f.id])).rows[0].item_receipt_id,null);
 assert.equal(await prepareCompletedYards(crypto.randomUUID()),null);
 await assert.rejects(retryTransferPostingJob(crypto.randomUUID()),{status:404});
}));

test('real HTTP saves load and receipt with NetSuite unavailable, replays once, and restricts the queue to Admin',async()=>{
 const f=await seed(),token=crypto.randomUUID();
 await query('UPDATE operators SET operator_yard_location_ids=ARRAY[1,28],yard_location_ids=ARRAY[1,28] WHERE id=$1',[f.operator]);
 await query("INSERT INTO operator_sessions(token_hash,operator_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
  [crypto.createHash('sha256').update(token).digest('hex'),f.operator]);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base=`http://127.0.0.1:${server.address().port}`,before={...config.netsuite};
 Object.assign(config.netsuite,{directAccessEnabled:true,restBaseUrl:'http://127.0.0.1:9'});
 const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
 const body=locationId=>({requestId:crypto.randomUUID(),orderType:'transfer_order',locationId,destinationLocationId:locationId,
  backgroundPhotos:[1,2].map(()=>({id:crypto.randomUUID(),sha256:crypto.createHash('sha256').update('abc').digest('hex'),byteSize:3,mimeType:'image/jpeg'}))});
 try {
  const foreign=await seed();await query('UPDATE transfer_orders SET from_location_id=26 WHERE netsuite_id=$1',[foreign.id]);
  const forbidden=await fetch(`${base}/api/delivery/orders/${foreign.id}/load`,{method:'POST',headers,body:JSON.stringify(body(1))});
  assert.equal(forbidden.status,403);assert.equal((await query('SELECT id FROM operator_load_records WHERE order_id=$1',[foreign.id])).rowCount,0);
  const input=body(1),start=Date.now();
  const response=await fetch(`${base}/api/delivery/orders/${f.id}/load`,{method:'POST',headers,body:JSON.stringify(input)});
  const loaded=await response.json();assert.equal(response.status,200,JSON.stringify(loaded));assert.equal(loaded.localYardOrderStatus,'Loaded');
  assert.ok(Date.now()-start<5000,'Operator must not wait for the unavailable NetSuite service');
  const replay=await fetch(`${base}/api/delivery/orders/${f.id}/load`,{method:'POST',headers,body:JSON.stringify(input)});
  assert.deepEqual(await replay.json(),loaded);assert.equal((await query('SELECT id FROM operator_load_records WHERE order_id=$1',[f.id])).rowCount,1);
  const receipt=await fetch(`${base}/api/receiving/orders/${f.id}/receive`,{method:'POST',headers,body:JSON.stringify(body(28))});
  const received=await receipt.json();assert.equal(receipt.status,200,JSON.stringify(received));assert.equal(received.status,'complete');
  assert.equal(received.result.receiptStatus,'received');
  assert.equal((await query('SELECT id FROM transfer_order_posting_jobs WHERE local_to_id=$1',[f.id])).rowCount,2);
  assert.equal((await fetch(`${base}/api/admin/operator-netsuite-posting/attention`,{headers})).status,403);
  await query("UPDATE operators SET role='admin',roles=ARRAY['admin','operator'] WHERE id=$1",[f.operator]);
  const admin=await fetch(`${base}/api/admin/operator-netsuite-posting/attention`,{headers});assert.equal(admin.status,200);
  assert.equal((await admin.json()).transferJobs.filter(j=>j.order_ref===f.ref).length,2);
 }finally{Object.assign(config.netsuite,before);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

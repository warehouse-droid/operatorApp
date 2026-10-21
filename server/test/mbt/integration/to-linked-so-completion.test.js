import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test,{after} from 'node:test';
import {query,closeDb,beginRollbackContext} from '../../../src/db.js';
import {captureTransferPosting,readTransferCompletionEvents,listTransferPostingJobs,assertTransferPostingStepReady} from '../../../src/transfer-order-posting-repository.js';
import {prepareTransferPostingJob,retryTransferPostingJob} from '../../../src/transfer-order-posting-service.js';
after(closeDb);
async function rollback(work){const c=await beginRollbackContext();try{return await c.run(work);}finally{await c.rollback();}}
async function seed(group=true){
 const id=8_969_000_000+crypto.randomInt(100000),ref=`TO${id}`,so=`SO${id}`,second=`SO${id+1}`,operator=crypto.randomUUID();
 await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt) VALUES($1,$1,'test','test','test')",[operator]);
 await query("INSERT INTO transfer_orders(netsuite_id,tranid,status,from_location_id,to_location_id) VALUES($1,$2,'B',1,28)",[id,ref]);
 for(const [sid,sref] of [[id,so],[id+1,second]])await query("INSERT INTO sales_orders(netsuite_id,tranid,status) VALUES($1,$2,'B')",[sid,sref]);
 const plan=(await query("INSERT INTO dispatch_plans(plan_date,status,revision) VALUES(date '2070-01-01'+($1::bigint % 100000)::int,'confirmed',1) RETURNING id",[id])).rows[0].id;
 const dep=(await query(`INSERT INTO order_dependencies(sales_order_id,sales_order_ref,transfer_order_id,transfer_order_ref,dependency_mode,same_load_required,
  source_location_id,source_location,accounting_destination_location_id,planned_plan_id,planned_date,planned_load_id,dispatch_target_ref,dispatch_target_kind)
  VALUES($1,$2,$1,$3,'direct_to_customer',true,1,'3445',28,$4,'2026-10-03','load4',$5,$6) RETURNING id`,[id,so,ref,plan,group?'GO-TEST-'+id:so,group?'group':'normal'])).rows[0].id;
 if(group){const line=(await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_type,quantity) VALUES($1,4,1784,'PALLET','InvtPart',1) RETURNING id",[id+1])).rows[0].id;
  await query('INSERT INTO order_dependency_lines(dependency_id,sales_line_id,item_id,allocated_quantity) VALUES($1,$2,1784,1)',[dep,line]);}
 const record=(await query(`INSERT INTO operator_load_records(load_type,order_family,order_id,order_ref,operator_id,photo_data_urls,line_snapshot)
  VALUES('delivery','TO',$1,$2,$3,'[]','[]') RETURNING id`,[id,ref,operator])).rows[0].id;
 const job=await captureTransferPosting({order:{netsuite_id:id,tranid:ref,dispatch_plan_date:new Date('2026-10-03T00:00:00Z'),source_location_id:1},
  operatorId:operator,recordId:record,transactionType:'IF',lines:[{lineId:'10',sourceLineKey:'11',itemId:1188,quantity:51}]});
 return {id,ref,so,second,operator,plan,dep,job,group};
}
async function deliver(f,refs=[f.so,f.second],extra={}){
 const job=crypto.randomUUID();await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,load_id,driver_login,stop_type,order_refs,status,completed_at,job_details)
  VALUES($1,$2,$3,$4,'test',$5,$6::jsonb,$7,now(),'{}')`,[job,extra.plan??f.plan,extra.date??'2026-10-03',extra.load??'load4',extra.type??'dropoff',JSON.stringify(refs),extra.status??'complete']);return job;
}
const deps=f=>({getPolicy:async()=>({effective:true,functionKey:'delivery_prep',transactionType:'IF',gateKey:'operator_netsuite_delivery_prep_if_3445',revision:1,locationId:1,yardCode:'3445'}),
 resolveSource:async()=>({sourceOrderKind:'TO',sourceNetSuiteId:f.id,sourceOrderRef:f.ref,
 availableLines:[{sourceLineKey:'11',orderLine:2,itemId:1188,remainingQuantity:51,location:1}]})});
test('capture freezes linked group members, date and load; queue names their SOs',()=>rollback(async()=>{
 const f=await seed();assert.deepEqual(f.job.snapshot.driverTarget.orderRefs,[f.so,f.second]);
 assert.equal(f.job.snapshot.planDate,'2026-10-03');assert.equal(String(f.job.snapshot.planId),String(f.plan));assert.equal(f.job.snapshot.loadId,'load4');
 const listed=(await listTransferPostingJobs()).find(j=>j.id===f.job.id);assert.deepEqual(listed.driver_order_refs,[f.so,f.second]);
 assert.deepEqual(listed.driver_dispatch_refs,['GO-TEST-'+f.id]);
}));
test('linked SO drop-offs admit once and withdrawal of either group member blocks posting',()=>rollback(async()=>{
 const f=await seed();assert.equal((await prepareTransferPostingJob(f.job.id,deps(f))).status,'waiting_driver');
 const first=await deliver(f,[f.so]);assert.equal((await prepareTransferPostingJob(f.job.id,deps(f))).status,'waiting_driver');
 await deliver(f,[f.second]);const ready=await prepareTransferPostingJob(f.job.id,deps(f));assert.equal(ready.status,'admitted');
 assert.equal(ready.command.steps[0].payload.item.items[0].quantity,51);
 assert.equal((await prepareTransferPostingJob(f.job.id,deps(f))).command.id,ready.command.id);
 await assertTransferPostingStepReady(ready.command.steps[0]);
 await query('UPDATE driver_job_records SET mbt_assignment_withdrawn_at=now() WHERE job_id=$1',[first]);
 await assert.rejects(assertTransferPostingStepReady(ready.command.steps[0]),/no longer effective/);
}));
test('live completion reader rejects pickup, unrelated SO and wrong scope, then accepts exact evidence',()=>rollback(async()=>{
 const f=await seed(false);
 for(const extra of [{type:'pickup'},{load:'other'},{date:'2026-10-02'},{status:'pending'}])await deliver(f,[f.so],extra);
 await deliver(f,['SO-UNRELATED']);
 assert.equal((await prepareTransferPostingJob(f.job.id,deps(f))).status,'waiting_driver');
 await deliver(f,[f.so]);assert.equal((await prepareTransferPostingJob(f.job.id,deps(f))).status,'admitted');
}));
test('relinking or cancellation cannot borrow old Driver completion after Operator capture',()=>rollback(async()=>{
 const f=await seed(false);await deliver(f,[f.so]);
 await query("UPDATE order_dependencies SET planned_load_id='changed' WHERE id=$1",[f.dep]);
 await assert.rejects(prepareTransferPostingJob(f.job.id,deps(f)),/linked SO.*changed/i);
 await query("UPDATE order_dependencies SET status='cancelled' WHERE id=$1",[f.dep]);
 await assert.rejects(readTransferCompletionEvents(f.job),/linked SO.*changed/i);
 assert.equal((await query('SELECT id FROM operator_load_records WHERE id=$1',[f.job.operator_record_id])).rowCount,1);
}));
test('cancelling the linked plan after admission prevents the transform',()=>rollback(async()=>{
 const f=await seed(false);await deliver(f,[f.so]);const ready=await prepareTransferPostingJob(f.job.id,deps(f));
 await query("UPDATE dispatch_plans SET status='cancelled' WHERE id=$1",[f.plan]);
 await assert.rejects(assertTransferPostingStepReady(ready.command.steps[0]),/linked SO.*changed/i);
}));
test('missing linked assignment preserves local load and exposes an Admin error',()=>rollback(async()=>{
 const f=await seed(false);await query('UPDATE order_dependencies SET planned_load_id=NULL WHERE id=$1',[f.dep]);
 await assert.rejects(prepareTransferPostingJob(f.job.id,{...deps(f),resolveSource:async()=>assert.fail('No NetSuite read for missing scope')}),/linked SO/i);
 assert.equal((await query('SELECT id FROM operator_load_records WHERE id=$1',[f.job.operator_record_id])).rowCount,1);
 assert.equal((await query('SELECT status FROM transfer_order_posting_jobs WHERE id=$1',[f.job.id])).rows[0].status,'attention');
}));
test('a replacement completion for the second SO cannot replace the admitted evidence',()=>rollback(async()=>{
 const f=await seed();await deliver(f,[f.so]);const second=await deliver(f,[f.second]);
 const ready=await prepareTransferPostingJob(f.job.id,deps(f));
 await query('UPDATE driver_job_records SET mbt_assignment_withdrawn_at=now() WHERE job_id=$1',[second]);
 await deliver(f,[f.second]);
 await assert.rejects(assertTransferPostingStepReady(ready.command.steps[0]),/no longer effective/);
}));
test('a conflicting TO assignment cannot override the linked SO route during local capture',()=>rollback(async()=>{
 const f=await seed(false);
 await query(`INSERT INTO dispatch_plan_order_assignments(plan_id,plan_date,order_ref,planned_order_ref,load_id)
  VALUES($1,'2026-10-03',$2,$2,'different-load')`,[f.plan,f.ref]);
 await query('DELETE FROM transfer_order_posting_jobs WHERE id=$1',[f.job.id]);
 const job=await captureTransferPosting({order:{netsuite_id:f.id,tranid:f.ref,dispatch_plan_date:new Date('2026-10-03T00:00:00Z'),source_location_id:1},
  operatorId:f.operator,recordId:f.job.operator_record_id,transactionType:'IF',lines:f.job.snapshot.lines});
 assert.match(job.snapshot.linkError,/conflicts/);await deliver(f,[f.so]);
 await assert.rejects(prepareTransferPostingJob(job.id,deps(f)),/conflicts/);
 assert.equal((await query('SELECT id FROM operator_load_records WHERE id=$1',[job.operator_record_id])).rowCount,1);
}));
test('a reconciled existing IF stays terminal when a previously selected worker resumes',()=>rollback(async()=>{
 const f=await seed(false);await query("UPDATE transfer_order_posting_jobs SET status='completed',result='{\"existingIf\":true}' WHERE id=$1",[f.job.id]);
 const result=await prepareTransferPostingJob(f.job.id,{resolveSource:async()=>assert.fail('Completed work never reads NetSuite'),getPolicy:async()=>assert.fail()});
 assert.equal(result.status,'completed');assert.equal(result.command_id,null);assert.equal(result.result.existingIf,true);
}));
for(const change of ['order_refs','plan_date'])test(`stale completion cannot survive a Driver ${change} correction`,()=>rollback(async()=>{
 const f=await seed(false);const driver=await deliver(f,[f.so]);
 if(change==='order_refs')await query("UPDATE driver_job_records SET order_refs='[\"SO-UNRELATED\"]' WHERE job_id=$1",[driver]);
 else await query("UPDATE driver_job_records SET plan_date='2026-10-04' WHERE job_id=$1",[driver]);
 const result=await prepareTransferPostingJob(f.job.id,{...deps(f),resolveSource:async()=>assert.fail('Stale Driver row cannot read or post NetSuite')});
 assert.equal(result.status,'waiting_driver');
}));
test('a stale Admin retry cannot reopen a reconciled existing IF',()=>rollback(async()=>{
 const f=await seed(false);await query("UPDATE transfer_order_posting_jobs SET status='completed' WHERE id=$1",[f.job.id]);
 await retryTransferPostingJob(f.job.id);
 assert.equal((await query('SELECT status FROM transfer_order_posting_jobs WHERE id=$1',[f.job.id])).rows[0].status,'completed');
}));

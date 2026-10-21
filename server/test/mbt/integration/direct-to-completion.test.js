import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test,{after} from 'node:test';
import {query,closeDb,withTransaction} from '../../../src/db.js';
import {completeDirectTransfer} from '../../../src/direct-to-completion-repository.js';
import {prepareTransferPostingJob} from '../../../src/transfer-order-posting-service.js';
import {finalizeTransferPosting} from '../../../src/transfer-order-posting-repository.js';
import {buildOperatorNetSuitePostingDraft} from '../../../src/operator-netsuite-posting-domain.js';
import {completeDirectDependenciesForSalesOrderDrop} from '../../../src/order-dependency-repository.js';
import {seedYardTransfer,yardRollback,yardLoad,yardPostingDependencies} from '../../support/operator-to-yard-flow-fixture.mjs';
after(closeDb);

async function seedDirect({load=true,system=false}={}) {
  const f=await seedYardTransfer(),so=f.id+10;
  f.so=`SO-DIRECT-${so}`;f.day='2048-01-01';f.drop=crypto.randomUUID();
  await query("INSERT INTO sales_orders(netsuite_id,tranid,status) VALUES($1,$2,'B')",[so,f.so]);
  const sl=(await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_type,quantity,unit) VALUES($1,1,2299,'TEST','InvtPart',5,'PC') RETURNING id",[so])).rows[0].id;
  await query("INSERT INTO dispatch_plans(id,plan_date,status,revision) VALUES($1,date '2069-01-01'+($1::bigint % 100000)::int,'confirmed',1)",[f.plan]);
  const dep=(await query(`INSERT INTO order_dependencies(sales_order_id,sales_order_ref,transfer_order_id,transfer_order_ref,
    dependency_mode,same_load_required,status,source_location_id,source_location,accounting_destination_location_id,
    planned_plan_id,planned_date,planned_load_id,dispatch_target_ref,direct_receipt_job_id,direct_received_at,local_completed_at)
    VALUES($1,$2,$3,$4,'direct_to_customer',true,'received_local',1,'3445',28,$5,$6,$7,$2,$8,now(),now()) RETURNING id`,
  [so,f.so,f.id,f.ref,f.plan,f.day,f.load,f.drop])).rows[0].id;
  f.dep=dep;
  const lines=(await query('SELECT id,line_stage FROM transfer_order_lines WHERE transfer_order_id=$1',[f.id])).rows;
  await query(`INSERT INTO order_dependency_lines(dependency_id,sales_line_id,transfer_outbound_line_id,transfer_receiving_line_id,
    item_id,item_name,unit,allocated_quantity,loaded_quantity,delivered_quantity,locally_received_quantity)
    VALUES($1,$2,$3,$4,2299,'TEST','PC',5,5,5,5)`,[dep,sl,lines.find(l=>l.line_stage==='outbound').id,lines.find(l=>l.line_stage==='receiving').id]);
  for(const stage of ['outbound','receiving']) {
    await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_stage,line_id,item_id,item_name,item_type,quantity,
      unit,piece_qty,to_pcs,packed_piece_qty,received_piece_qty,confirmed,netsuite_active,location_id)
      VALUES($1,$2,$3,1784,'PALLET','InvtPart',1,'EACH',1,1,1,0,true,true,$4)`,
    [f.id,stage,stage==='outbound'?8000001:8000003,stage==='outbound'?1:28]);
  }
  await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,load_id,driver_login,stop_type,order_refs,status,completed_at,job_details)
    VALUES($1,$2,$3,$4,'test','dropoff',$5::jsonb,'complete',now(),'{}')`,[f.drop,f.plan,f.day,f.load,JSON.stringify([f.so])]);
  f.receipt=(await query(`INSERT INTO receiving_receipt_records(order_id,receipt_status,photo_data_urls,payload,response)
    VALUES($1,'local_direct_receipt','[]',$2::jsonb,'{"receivingStatus":"partial_received"}') RETURNING id`,[f.id,JSON.stringify({
      reason:'direct_so_delivery',driverJobId:f.drop,planId:f.plan,planDate:f.day,loadId:f.load,salesOrderRef:f.so})])).rows[0].id;
  if(load) {
    f.fulfillment=await yardLoad(f);
    if(system) {await query('UPDATE transfer_order_posting_jobs SET operator_id=NULL WHERE id=$1',[f.fulfillment.id]);}
  }
  return f;
}
async function finishIF(f) {
  await query("UPDATE transfer_order_posting_jobs SET status='completed',result=$2::jsonb WHERE id=$1",[f.fulfillment.id,JSON.stringify({transactions:[{
    transactionType:'IF',sourceOrderKind:'TO',sourceNetSuiteId:f.id,sourceOrderRef:f.ref,transactionId:901,transactionRef:'IF-DIRECT-TEST'}]})]);
}
test('retired zero-requirement allocations retain history without blocking current direct completion',()=>yardRollback(async()=>{
  const f=await seedDirect();
  const salesId=(await query('SELECT sales_order_id FROM order_dependencies WHERE id=$1',[f.dep])).rows[0].sales_order_id;
  const retired=(await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_type,quantity,unit,netsuite_active)
    VALUES($1,999,99999,'Retired source item','InvtPart',3,'PC',false) RETURNING id`,[salesId])).rows[0];
  const row=(await query(`INSERT INTO order_dependency_lines(dependency_id,sales_line_id,item_id,item_name,unit,
    allocated_quantity,loaded_quantity,delivered_quantity,locally_received_quantity)
    VALUES($1,$2,99999,'Retired source item','PC',0,3,3,3) RETURNING id`,[f.dep,retired.id])).rows[0];
  const result=await completeDirectTransfer(f.id);
  assert.equal(result.status,'completed_local');
  const retained=(await query('SELECT * FROM order_dependency_lines WHERE id=$1',[row.id])).rows[0];
  assert.equal(Number(retained.delivered_quantity),3);
  assert.equal(Number(retained.locally_received_quantity),3);
}));
function dependencies(f) {
  return {...yardPostingDependencies(f,'IR'),resolveSource:async()=>({sourceOrderKind:'TO',sourceNetSuiteId:f.id,sourceOrderRef:f.ref,
    availableLines:[{sourceLineKey:'5073151',orderLine:3,itemId:2299,remainingQuantity:5,location:28},
      {sourceLineKey:'8000003',orderLine:6,itemId:1784,remainingQuantity:1,location:28}]})};
}
test('full direct customer delivery closes loaded material and its pallet, and captures one receipt job',()=>yardRollback(async()=>{
  const f=await seedDirect(),before=(await query('SELECT * FROM receiving_receipt_records WHERE order_id=$1',[f.id])).rows;
  const first=await completeDirectTransfer(f.id);
  assert.equal(first.status,'completed_local');assert.ok(first.jobId);
  assert.deepEqual((await query('SELECT outbound_operator_status,receiving_status,local_yard_order_status FROM transfer_orders WHERE netsuite_id=$1',[f.id])).rows[0],
    {outbound_operator_status:'loaded',receiving_status:'received',local_yard_order_status:'Received'});
  const job=(await query("SELECT * FROM transfer_order_posting_jobs WHERE local_to_id=$1 AND transaction_type='IR'",[f.id])).rows[0];
  assert.equal(job.operator_record_id,f.receipt);assert.equal(job.snapshot.lines.length,2);
  assert.equal(job.snapshot.lines.find(l=>l.itemId===1784).quantity,1);
  assert.equal((await completeDirectTransfer(f.id)).jobId,first.jobId);
  assert.deepEqual((await query('SELECT * FROM receiving_receipt_records WHERE order_id=$1',[f.id])).rows,before);
  assert.equal((await query('SELECT id FROM operator_load_records WHERE order_id=$1',[f.id])).rowCount,1);
}));
test('direct IR waits for verified IF, then system admission retains real Driver and receipt identities',()=>yardRollback(async()=>{
  const f=await seedDirect({system:true}),done=await completeDirectTransfer(f.id);
  assert.equal((await prepareTransferPostingJob(done.jobId,dependencies(f))).status,'waiting_fulfillment');
  await finishIF(f);
  const ready=await prepareTransferPostingJob(done.jobId,dependencies(f));
  assert.equal(ready.status,'admitted');assert.equal(ready.command.actorOperatorId,null);
  assert.equal(ready.command.inputSnapshot.transferEvidence.operatorRecordId,Number(f.receipt));
  assert.deepEqual(ready.command.inputSnapshot.directTransferEvidence.fulfillmentTransactionIds,[901]);
  assert.equal(ready.command.steps[0].payload.item.items.length,2);
  const completed={...ready.command,steps:ready.command.steps.map(step=>({...step,status:'posted',netSuiteTransactionId:902,netSuiteTransactionRef:'IR-DIRECT-TEST'}))};
  await finalizeTransferPosting(completed);await finalizeTransferPosting(completed);
  const receipt=(await query('SELECT receipt_status,item_receipt_id,payload FROM receiving_receipt_records WHERE id=$1',[f.receipt])).rows[0];
  assert.equal(receipt.receipt_status,'local_direct_receipt');assert.equal(receipt.item_receipt_id,'902');assert.equal(receipt.payload.driverJobId,f.drop);
}));
for(const damage of ['residual','allocation','withdrawn','plan','receipt','load']) {test(`${damage} cannot authorize whole direct completion`,()=>yardRollback(async()=>{
  const f=await seedDirect({load:damage!=='load'});
  if(damage==='residual') {await query("UPDATE transfer_order_lines SET quantity=6 WHERE transfer_order_id=$1 AND item_id=2299",[f.id]);}
  if(damage==='allocation') {await query('UPDATE order_dependency_lines SET locally_received_quantity=4 WHERE dependency_id=$1',[f.dep]);}
  if(damage==='withdrawn') {await query('UPDATE driver_job_records SET mbt_assignment_withdrawn_at=now() WHERE job_id=$1',[f.drop]);}
  if(damage==='plan') {await query("UPDATE dispatch_plans SET status='cancelled' WHERE id=$1",[f.plan]);}
  if(damage==='receipt') {await query("UPDATE receiving_receipt_records SET payload=jsonb_set(payload,'{loadId}','\"other-load\"') WHERE id=$1",[f.receipt]);}
  const before=(await query('SELECT * FROM transfer_orders WHERE netsuite_id=$1',[f.id])).rows;
  const result=await completeDirectTransfer(f.id);
  assert.notEqual(result.status,'completed_local');assert.equal(result.jobId,undefined);
  assert.deepEqual((await query('SELECT * FROM transfer_orders WHERE netsuite_id=$1',[f.id])).rows,before);
  assert.equal((await query("SELECT id FROM transfer_order_posting_jobs WHERE local_to_id=$1 AND transaction_type='IR'",[f.id])).rowCount,0);
}));}
test('dry run rolls back the completion, receipt job, and operational audit',()=>yardRollback(async()=>{
  const f=await seedDirect(),before=(await query('SELECT * FROM transfer_orders WHERE netsuite_id=$1',[f.id])).rows;
  const planned=await completeDirectTransfer(f.id,{apply:false});assert.equal(planned.status,'completed_local');
  assert.deepEqual((await query('SELECT * FROM transfer_orders WHERE netsuite_id=$1',[f.id])).rows,before);
  assert.equal((await query("SELECT id FROM transfer_order_posting_jobs WHERE local_to_id=$1 AND transaction_type='IR'",[f.id])).rowCount,0);
  assert.equal((await query("SELECT id FROM delivery_audit_log WHERE order_id=$1 AND action='operator.to.direct_completion'",[f.id])).rowCount,0);
}));
test('a wrong-parent completed IF cannot release a direct receipt',()=>yardRollback(async()=>{
  const f=await seedDirect(),done=await completeDirectTransfer(f.id);await finishIF(f);
  await query("UPDATE transfer_order_posting_jobs SET result=jsonb_set(result,'{transactions,0,sourceNetSuiteId}',to_jsonb($2::bigint)) WHERE id=$1",[f.fulfillment.id,f.id+1]);
  assert.equal((await prepareTransferPostingJob(done.jobId,dependencies(f))).status,'waiting_fulfillment');
}));
test('ordinary receiving submissions cannot omit an Operator identity',()=>{
  assert.throws(()=>buildOperatorNetSuitePostingDraft({actorOperatorId:null,requestId:crypto.randomUUID(),
    localOperation:{kind:'receiving_receipt',orderId:'123',orderType:'transfer_order'}}),/Operator ID/iu);
});

test('system receipt evidence must keep its transfer identity, verified IF, and linked SO references',()=>{
  const requestId=crypto.randomUUID(),key='transfer-background:IR:42';
  const input={requestId,actorOperatorId:null,functionKey:'receiving',transactionType:'IR',
    policy:{effective:true,functionKey:'receiving',transactionType:'IR',gateKey:'operator_netsuite_receiving_ir_2967',revision:1,locationId:28,yardCode:'2967'},
    localOrderKeys:[key],localOperation:{kind:'transfer_background_posting',orderId:'42',orderType:'transfer_order'},
    transferEvidence:{jobId:requestId,operatorRecordId:1,completionEventId:2},
    directTransferEvidence:{sourceNetSuiteId:42,driverOrderRefs:['SO42'],fulfillmentTransactionIds:[901]},
    targets:[{sourceOrderKind:'TO',sourceNetSuiteId:42,sourceOrderRef:'TO42',postingStrategy:'stored_order_line_v1',
      availableLines:[{orderLine:3,sourceLineKey:'11',itemId:1256,location:28,remainingQuantity:26}],
      selectedLines:[{orderLine:3,sourceLineKey:'11',itemId:1256,location:28,quantity:26,localLineId:'33',localOrderKey:key}]}]};
  assert.equal(buildOperatorNetSuitePostingDraft(input).actorOperatorId,null);
  for(const [changed,pattern] of [
    [{directTransferEvidence:{...input.directTransferEvidence,fulfillmentTransactionIds:[]}},/verified IF evidence/iu],
    [{localOperation:{...input.localOperation,kind:'receiving_receipt'}},/saved transfer/iu],
    [{directTransferEvidence:{...input.directTransferEvidence,sourceNetSuiteId:43}},/source differs/iu],
    [{directTransferEvidence:{...input.directTransferEvidence,driverOrderRefs:['TO42']}},/linked Sales Orders/iu]
  ]) {assert.throws(()=>buildOperatorNetSuitePostingDraft({...input,...changed}),pattern);}
});

function existingIF(f,changes={}) {
  return {lines:[{itemId:2299,quantity:5},{itemId:1784,quantity:1}],transactions:[{
    transactionType:'IF',sourceOrderKind:'TO',sourceNetSuiteId:f.id,sourceOrderRef:f.ref,
    transactionId:901,transactionRef:'IF-EXISTING',...changes}]};
}
test('a verified existing IF recovers a completed legacy direct receipt without inventing an Operator load',()=>yardRollback(async()=>{
  const f=await seedDirect({load:false}),done=await completeDirectTransfer(f.id,{verifiedFulfillment:existingIF(f)});
  assert.equal(done.status,'completed_local');
  const ready=await prepareTransferPostingJob(done.jobId,dependencies(f));assert.equal(ready.status,'admitted');
  assert.equal(ready.command.actorOperatorId,null);assert.equal(ready.command.steps[0].payload.item.items[1].quantity,1);
  assert.equal((await query('SELECT id FROM operator_load_records WHERE order_id=$1',[f.id])).rowCount,0);
  assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=$1',[f.id])).rowCount,1);
  assert.equal((await query("SELECT id FROM dispatch_effective_order_completion_events WHERE order_kind='TO' AND order_ref=$1",[f.ref])).rowCount,1);
}));
test('foreign existing IF evidence cannot close a legacy direct receipt',()=>yardRollback(async()=>{
  const f=await seedDirect({load:false}),result=await completeDirectTransfer(f.id,{verifiedFulfillment:existingIF(f,{sourceNetSuiteId:f.id+1})});
  assert.equal(result.status,'waiting_load');assert.equal(result.jobId,undefined);
}));
test('Driver completion replay discovers the direct IR while keeping Sales Order records unchanged',()=>yardRollback(async()=>{
  const f=await seedDirect(),before=(await query('SELECT * FROM sales_orders WHERE tranid=$1',[f.so])).rows;
  const result=await completeDirectDependenciesForSalesOrderDrop({salesOrderRefs:[f.so],driverJobId:f.drop,planId:f.plan,planDate:f.day,loadId:f.load});
  assert.equal(result.alreadyCompleted.length,1);
  assert.equal((await query("SELECT id FROM transfer_order_posting_jobs WHERE local_to_id=$1 AND transaction_type='IR'",[f.id])).rowCount,1);
  assert.deepEqual((await query('SELECT * FROM sales_orders WHERE tranid=$1',[f.so])).rows,before);
}));
test('PostgreSQL rejects a system transfer command stripped of its verified IF evidence',()=>yardRollback(async()=>{
  const f=await seedDirect({system:true}),done=await completeDirectTransfer(f.id);await finishIF(f);
  const ready=await prepareTransferPostingJob(done.jobId,dependencies(f)),request=crypto.randomUUID();
  const snapshot={...ready.command.inputSnapshot,transferEvidence:{...ready.command.inputSnapshot.transferEvidence,jobId:request}};
  delete snapshot.directTransferEvidence;
  await assert.rejects(withTransaction(()=>query(`INSERT INTO operator_netsuite_posting_commands
    SELECT (jsonb_populate_record(NULL::operator_netsuite_posting_commands,to_jsonb(c)||$2::jsonb)).*
    FROM operator_netsuite_posting_commands c WHERE id=$1`,[ready.command.id,JSON.stringify({id:request,request_id:request,input_snapshot:snapshot})])),
  /operator_posting_actor_or_direct_receipt/iu);
}));
test('an audit failure rolls back the direct completion and its captured IR',()=>yardRollback(async()=>{
  const f=await seedDirect(),before=(await query('SELECT * FROM transfer_orders WHERE netsuite_id=$1',[f.id])).rows;
  await query("CREATE FUNCTION pg_temp.reject_direct_completion_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'direct completion audit failure'; END $$");
  await query(`CREATE TRIGGER reject_direct_completion_audit BEFORE INSERT ON delivery_audit_log FOR EACH ROW
    WHEN (NEW.order_id=${f.id} AND NEW.action='operator.to.direct_completion') EXECUTE FUNCTION pg_temp.reject_direct_completion_audit()`);
  await assert.rejects(completeDirectTransfer(f.id),/direct completion audit failure/iu);
  assert.deepEqual((await query('SELECT * FROM transfer_orders WHERE netsuite_id=$1',[f.id])).rows,before);
  assert.equal((await query("SELECT id FROM transfer_order_posting_jobs WHERE local_to_id=$1 AND transaction_type='IR'",[f.id])).rowCount,0);
}));
test('concurrent direct completion discovery captures exactly one receipt job',async()=>{
  const f=await seedDirect();
  const results=await Promise.all([completeDirectTransfer(f.id),completeDirectTransfer(f.id)]);
  assert.equal(results[0].jobId,results[1].jobId);
  assert.equal((await query("SELECT id FROM transfer_order_posting_jobs WHERE local_to_id=$1 AND transaction_type='IR'",[f.id])).rowCount,1);
  assert.equal((await query("SELECT id FROM delivery_audit_log WHERE order_id=$1 AND action='operator.to.direct_completion'",[f.id])).rowCount,1);
});

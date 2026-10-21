import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, {after} from 'node:test';
import {beginRollbackContext,closeDb,query,withTransaction} from '../../../src/db.js';
import {prepareSalesOrderAutoFulfillmentCandidate} from '../../../src/sales-order-auto-fulfillment-repository.js';
import {prepareDirectPoReceiptJob,directPoAutoReceiptTick} from '../../../src/direct-po-auto-receipt.js';
import {getOperatorNetSuitePostingPolicy} from '../../../src/operator-netsuite-posting-policy-repository.js';
import {createOrReplayOperatorNetSuitePostingCommand} from '../../../src/operator-netsuite-posting-repository.js';
import {buildOperatorNetSuitePostingDraft} from '../../../src/operator-netsuite-posting-domain.js';
import {buildDirectPoReceiptDraft} from '../../../src/direct-po-auto-receipt-domain.js';
import * as postingRepository from '../../../src/operator-netsuite-posting-repository.js';
import {createOperatorNetSuitePostingProcessor} from '../../../src/operator-netsuite-posting-service.js';
import {createOperatorNetSuitePostingAdapter} from '../../../src/operator-netsuite-posting-netsuite-adapter.js';
import {finalizeOperatorNetSuitePosting} from '../../../src/operator-netsuite-posting-finalizer.js';
after(closeDb);
async function rollback(work){const context=await beginRollbackContext();try{return await context.run(work);}finally{await context.rollback();}}

async function seed(){
  const id=9_876_000_000+Math.floor(Math.random()*100000),key=crypto.randomUUID(),so=`SO-DIRECT-${key}`,po=`PO-DIRECT-${key}`;
  for(const flag of ['dispatch_netsuite_sales_order_if_150','operator_netsuite_receiving_ir_150']) {await query('UPDATE mbt_feature_flags SET enabled=true,revision=revision+1 WHERE flag_key=$1',[flag]);}
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,outbound_location_id,outbound_location,sales_order_type,netsuite_active)
    VALUES($1,$2,'B',26,'150','Delivery',true)`,[id,so]);
  const sl=(await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,netsuite_order_line,item_id,item_name,sku,item_type,quantity,location_id,location,loaded_qty,netsuite_active)
    VALUES($1,5004139,1,2055,'MBBS-Special Order','MBBS-Special Order','NonInvtPart',270.78,26,'150',0,true) RETURNING id`,[id])).rows[0].id;
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,dispatch_ref,status,status_text,destination_location_id,destination_location,netsuite_active)
    VALUES($1,$2,$2,'B','Pending Receipt',26,'150',true)`,[id+1,po]);
  const pl=(await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,netsuite_order_line,item_id,item_name,sku,item_type,quantity,location_id,location,netsuite_active)
    VALUES($1,5004774,1,2055,'MBBS-Special Order','MBBS-Special Order','NonInvtPart',270.78,26,'150',true) RETURNING id`,[id+1])).rows[0].id;
  await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,item_name,sku,allocated_sales_qty,status,dispatch_target_ref,dispatch_target_line_key,details)
    VALUES($1,$2,$3,$4,$5,$6,2055,'MBBS-Special Order','MBBS-Special Order',270.78,'active',$2,$2||'::'||$2||'::'||$3::bigint::text,'{"poVendorYard":"DIRECT TEST Vendor"}')`,[id,so,sl,id+1,po,pl]);
  const plan=id+2,load=`LOAD-${key}`,pick=`PICK-${key}`,drop=`DROP-${key}`;
  await query(`INSERT INTO dispatch_plans(id,plan_date,status,revision) VALUES($1,date '2040-01-01'+($1::bigint % 100000)::int,'confirmed',1)`,[plan]);
  await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,load_id,driver_login,stop_type,order_refs,status,completed_at,job_details)
    VALUES($1,$2,current_date,$3,'direct-ship-test','pickup',$4::jsonb,'complete',now(),'{"pickupLocation":"DIRECT TEST Vendor","location":"DIRECT TEST Vendor"}')`,[pick,plan,load,JSON.stringify([po,so])]);
  return {id,so,po,pl,plan,load,pick,drop};
}
async function deliver(f){await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,load_id,driver_login,stop_type,order_refs,status,completed_at,job_details)
  VALUES($1,$2,current_date,$3,'direct-ship-test','dropoff',$4::jsonb,'complete',now(),$5::jsonb)`,[f.drop,f.plan,f.load,JSON.stringify([f.so]),JSON.stringify({orders:[{orderType:'SO',orderRef:f.so}],location:'Customer destination'})]);}
function source(f){return {sourceOrderKind:'PO',sourceNetSuiteId:f.id+1,sourceOrderRef:f.po,status:'B',statusText:'Pending Receipt',lines:[
  {sourceLineKey:'5004774',restOrderLine:1,itemId:2055,itemName:'MBBS-Special Order',itemType:'NonInvtPart',identityStatus:'exact',quantity:270.78,orderedQuantity:270.78,completedQuantity:0,remainingQuantity:270.78,location:26,linkedTransactions:[]}]};}
const dependencies=f=>({fetchSource:async()=>source(f),getPolicy:input=>getOperatorNetSuitePostingPolicy({...input,directAccessEnabled:true})});

test('fully direct special SO materializes its 270.78 delivered quantity with exact pickup/drop evidence',()=>rollback(async()=>{
  const f=await seed();await deliver(f);
  const candidate=(await query('SELECT id FROM dispatch_sales_order_if_candidates WHERE dispatch_order_ref=$1',[f.so])).rows[0];
  const prepared=await prepareSalesOrderAutoFulfillmentCandidate(candidate.id);
  assert.equal(prepared.status,'queued');assert.equal(prepared.lineSnapshot.length,1);
  assert.equal(prepared.lineSnapshot[0].deliveredQuantity,270.78);assert.equal(prepared.lineSnapshot[0].operatorLoadedQuantity,0);
  assert.equal(prepared.lineSnapshot[0].poEvidence[0].pickupJobId,f.pick);assert.equal(prepared.lineSnapshot[0].poEvidence[0].deliveryJobId,f.drop);
}));

test('migration queues one durable PO IR on delivery, never on pickup, and command replay is identical',()=>rollback(async()=>{
  assert.ok((await query("SELECT to_regclass('dispatch_direct_po_ir_jobs') AS name")).rows[0].name,'IR jobs migration must exist');
  const f=await seed();assert.equal((await query('SELECT id FROM dispatch_direct_po_ir_jobs')).rowCount,0);
  await deliver(f);
  const job=(await query('SELECT * FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[f.id+1])).rows[0];
  assert.ok(job);assert.equal(job.status,'discovered');
  const first=await prepareDirectPoReceiptJob(job.id,dependencies(f));assert.equal(first.command.status,'queued');
  assert.equal(first.command.actorOperatorId,null);assert.equal(first.command.steps[0].sourceNetSuiteId,f.id+1);
  const second=await prepareDirectPoReceiptJob(job.id,dependencies(f));assert.equal(second.command.id,first.command.id);
  assert.equal((await query('SELECT id FROM operator_netsuite_posting_commands WHERE id=$1',[first.command.id])).rowCount,1);
  await query("UPDATE driver_job_records SET status='complete' WHERE job_id=$1",[f.drop]);
  assert.equal((await query('SELECT id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[f.id+1])).rowCount,1);
}));

test('disabled receiving gate records a blocker and admits no automatic IR command',()=>rollback(async()=>{
  const f=await seed();await deliver(f);await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='operator_netsuite_receiving_ir_150'");
  const job=(await query('SELECT id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[f.id+1])).rows[0];
  const prepared=await prepareDirectPoReceiptJob(job.id,dependencies(f));assert.equal(prepared.status,'gate_disabled');assert.equal(prepared.command,undefined);
}));

test('automatic IR shares the normal receiving/source claims and cannot race another receipt admission',()=>rollback(async()=>{
  const f=await seed();await deliver(f);
  const job=(await query('SELECT id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[f.id+1])).rows[0];
  const admitted=await prepareDirectPoReceiptJob(job.id,dependencies(f));
  const policy=await dependencies(f).getPolicy({functionKey:'receiving',locationId:26});
  const draft=buildDirectPoReceiptDraft({requestId:crypto.randomUUID(),order:{netsuite_id:f.id+1,tranid:f.po,source_po_id:f.id+1,source_po_ref:f.po},
    policy,evidence:{completionEventId:123,sourcePoId:f.id+1,pickupJobIds:[f.pick],deliveryJobId:f.drop},
    lines:[{id:f.pl,line_id:5004774,source_line_key:'5004774',item_id:2055,item_type:'NonInvtPart',sku:'MBBS-Special Order',quantity:270.78,location_id:26}],source:source(f),photoRefs:[]});
  await assert.rejects(withTransaction(()=>createOrReplayOperatorNetSuitePostingCommand(draft)),/active.*posting command/iu);
  assert.equal((await query('SELECT id FROM operator_netsuite_posting_commands WHERE id=$1',[admitted.command.id])).rowCount,1);
}));

test('database refuses a missing Operator on an ordinary receiving command',()=>rollback(async()=>{
  const f=await seed();await deliver(f);const job=(await query('SELECT id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[f.id+1])).rows[0];
  const admitted=await prepareDirectPoReceiptJob(job.id,dependencies(f));
  await assert.rejects(withTransaction(()=>query(`UPDATE operator_netsuite_posting_commands SET input_snapshot=jsonb_set(input_snapshot,'{localOperation,kind}','"receiving_receipt"') WHERE id=$1`,[admitted.command.id])),/check constraint/iu);
  assert.throws(()=>buildOperatorNetSuitePostingDraft({actorOperatorId:null,requestId:crypto.randomUUID(),localOperation:{kind:'receiving_receipt',orderId:String(f.id+1),orderType:'purchase_order'}}),/Operator ID/iu);
}));

test('complete live PO and zero line remainder reconcile without creating an IR command',()=>rollback(async()=>{
  const f=await seed();await deliver(f);
  const job=(await query('SELECT id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[f.id+1])).rows[0];
  const prepared=await prepareDirectPoReceiptJob(job.id,{...dependencies(f),fetchSource:async()=>({...source(f),status:'F',lines:[]})});
  assert.equal(prepared.status,'reconciled');assert.equal(prepared.command,undefined);
  const other=await seed();await deliver(other);
  const second=(await query('SELECT id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[other.id+1])).rows[0];
  const live=source(other);live.lines[0].completedQuantity=270.78;live.lines[0].remainingQuantity=0;
  const reconciled=await prepareDirectPoReceiptJob(second.id,{...dependencies(other),fetchSource:async()=>live});
  assert.equal(reconciled.status,'reconciled');assert.equal(reconciled.command,undefined);
}));

test('verified IR completes real local receipt once; incomplete command cannot finalize received quantities',()=>rollback(async()=>{
  const f=await seed();await deliver(f);
  const job=(await query('SELECT id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[f.id+1])).rows[0];
  const admitted=await prepareDirectPoReceiptJob(job.id,dependencies(f));
  const p=postingRepository;
  const lease=await p.claimOperatorNetSuitePostingCommand({commandId:admitted.command.id,workerId:'direct-spec',leaseSeconds:180});
  await assert.rejects(p.completeOperatorNetSuitePostingCommand({commandId:lease.id,leaseToken:lease.leaseToken,
    finalize:()=>finalizeOperatorNetSuitePosting(lease)}),/must be verified/iu);
  assert.equal(Number((await query('SELECT netsuite_received_qty FROM purchase_order_lines WHERE id=$1',[f.pl])).rows[0].netsuite_received_qty),0);
  await query("UPDATE operator_netsuite_posting_commands SET status='queued',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[lease.id]);
  let transforms=0,remote=null;
  const adapter=createOperatorNetSuitePostingAdapter({findTransactionByExternalId:async()=>remote,
    transformSalesOrderToItemFulfillment:async()=>assert.fail('PO must create IR'),transformTransferOrderToItemFulfillment:async()=>assert.fail(),
    transformTransferOrderToItemReceipt:async()=>assert.fail(),
    fetchDirectReceiptSource:async()=>({status:'B',lines:[{restLineId:1,itemId:2055,quantity:270.78,receivedQuantity:0,locationId:26}]}),
    transformPurchaseOrderToItemReceipt:async(id,payload)=>{transforms++;remote={id:900010001,tranId:'IR-DIRECT-SPEC',transactionType:'IR',createdFromId:id,
      externalId:payload.externalId,item:{items:payload.item.items.filter(item=>item.itemReceive).map(item=>({...item,item:{id:2055}}))}};return {id:remote.id};},
    fetchItemFulfillment:async()=>assert.fail(),fetchItemReceipt:async()=>remote});
  const processor=createOperatorNetSuitePostingProcessor({workerId:'direct-spec',adapter,finalize:finalizeOperatorNetSuitePosting,
    repository:{get:p.getOperatorNetSuitePostingCommand,claim:p.claimOperatorNetSuitePostingCommand,renew:p.renewOperatorNetSuitePostingLease,
      startAttempt:p.startOperatorNetSuitePostingAttempt,success:p.recordOperatorNetSuitePostingStepSuccess,failure:p.recordOperatorNetSuitePostingStepFailure,
      attention:p.markOperatorNetSuitePostingCommandAttention,fail:p.failOperatorNetSuitePostingCommand,complete:p.completeOperatorNetSuitePostingCommand}});
  const completed=await processor.process(lease.id);assert.equal(completed.status,'completed',completed.lastError);assert.equal(transforms,1);
  assert.equal((await query('SELECT receipt_status,last_item_receipt_id FROM purchase_orders WHERE netsuite_id=$1',[f.id+1])).rows[0].receipt_status,'received');
  assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=$1',[f.id+1])).rowCount,1);
  await processor.process(lease.id);assert.equal(transforms,1);
  assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=$1',[f.id+1])).rowCount,1);
}));

test('scheduler admits a real durable receipt, suppresses overlapping ticks, and records invalid evidence',{timeout:5000},()=>rollback(async()=>{
  assert.equal(await prepareDirectPoReceiptJob(crypto.randomUUID(),{}),null);
  assert.deepEqual(await directPoAutoReceiptTick({directAccessEnabled:false}),{discovered:0});
  const f=await seed();await deliver(f);
  let release,entered;const started=new Promise(resolve=>{entered=resolve;}),waiting=new Promise(resolve=>{release=resolve;});
  const queued=[];
  const prepare=id=>prepareDirectPoReceiptJob(id,{...dependencies(f),fetchSource:async()=>{entered();await waiting;return source(f);}});
  const first=directPoAutoReceiptTick({directAccessEnabled:true,prepare,enqueue:async id=>queued.push(id)});
  await started;
  assert.deepEqual(await directPoAutoReceiptTick({directAccessEnabled:true}),{discovered:0});
  release();assert.deepEqual(await first,{discovered:1});assert.equal(queued.length,1);
  const job=(await query('SELECT * FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[f.id+1])).rows[0];
  assert.equal(job.command_id,queued[0]);assert.equal(job.status,'admitted');
}));

test('source validation errors persist attention, never silently enqueue a receipt',()=>rollback(async()=>{
  const f=await seed();await deliver(f);
  const job=(await query('SELECT id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[f.id+1])).rows[0];
  await assert.rejects(prepareDirectPoReceiptJob(job.id,{...dependencies(f),fetchSource:async()=>{throw new Error('NetSuite source unavailable');}}),/source unavailable/iu);
  const held=(await query('SELECT status,last_error,command_id FROM dispatch_direct_po_ir_jobs WHERE id=$1',[job.id])).rows[0];
  assert.equal(held.status,'attention');assert.match(held.last_error,/source unavailable/iu);assert.equal(held.command_id,null);
  const again=await prepareDirectPoReceiptJob(job.id,{fetchSource:async()=>assert.fail('attention must not retry automatically')});
  assert.equal(again.status,'attention');
  await query("UPDATE dispatch_direct_po_ir_jobs SET status='discovered' WHERE id=$1",[job.id]);
  await assert.rejects(prepareDirectPoReceiptJob(job.id,{...dependencies(f),fetchSource:async()=>{throw 'RPC closed';}}),error=>error==='RPC closed');
  assert.equal((await query('SELECT last_error FROM dispatch_direct_po_ir_jobs WHERE id=$1',[job.id])).rows[0].last_error,'RPC closed');
}));

test('scheduler retains a command when the remote posting boundary is unavailable',()=>rollback(async()=>{
  const f=await seed();await deliver(f);
  const tick=await directPoAutoReceiptTick({directAccessEnabled:true,prepare:id=>prepareDirectPoReceiptJob(id,dependencies(f))});
  assert.equal(tick.discovered,1);
  const job=(await query('SELECT command_id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[f.id+1])).rows[0];
  assert.ok(job.command_id);
  const command=await postingRepository.getOperatorNetSuitePostingCommand(job.command_id);
  assert.notEqual(command.status,'completed');assert.ok(command.lastError);
  assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=$1',[f.id+1])).rowCount,0);
}));

test('changed direct route identity is held with a persisted pickup-evidence error',()=>rollback(async()=>{
  const f=await seed();await deliver(f);
  await query("UPDATE purchase_orders SET tranid='CHANGED-'||tranid,dispatch_ref='CHANGED-'||dispatch_ref WHERE netsuite_id=$1",[f.id+1]);
  const job=(await query('SELECT id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[f.id+1])).rows[0];
  const tick=await directPoAutoReceiptTick({directAccessEnabled:true,prepare:id=>prepareDirectPoReceiptJob(id,dependencies(f)),enqueue:async()=>assert.fail('invalid proof cannot queue')});
  assert.equal(tick.discovered,1);
  const held=(await query('SELECT status,last_error,command_id FROM dispatch_direct_po_ir_jobs WHERE id=$1',[job.id])).rows[0];
  assert.equal(held.status,'attention');assert.match(held.last_error,/pickup and delivery evidence/iu);assert.equal(held.command_id,null);
}));

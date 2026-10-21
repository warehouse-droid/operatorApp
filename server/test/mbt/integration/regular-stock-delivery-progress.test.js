import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {enqueueDeliveryOperation,getDeliveryOperation,activeDeliveryOperation,runDeliveryOperation} from '../../../src/regular-stock-delivery-operations.js';
import {isOperatorNetSuiteRequest} from '../../../src/operator-netsuite-request-pool.js';
const actor='delivery-progress-'+randomUUID(),context={operatorId:actor,audience:'sales',authorizedDestinationLocationIds:[28]},itemId=9800000000181;
let seq=parseInt(randomUUID().replaceAll('-','').slice(0,10),16);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function fixture(){
 const id=++seq,order={id,ref:`SO-PROGRESS-${id}`,locationId:1,lines:[{remoteLineId:1,itemId,quantity:200,backorderedQuantity:20,uom:'EA',locationId:28,open:true}]};
 return {input:{salesOrderRef:order.ref,sourceLocationId:1,destinationLocationId:28},dependencies:{readOrder:async()=>order,refreshAvailability:async()=>{},hydrateOrder:async()=>{},linkTransferDependency:async()=>{},liveExecutionEnabled:false}};
}
const command=(action,input,requestId)=>({operationId:randomUUID(),action,input,requestId});
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');
 await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active,yard_location_ids) VALUES($1,$1,$1,'test','test','sales',ARRAY['sales'],true,ARRAY[28])",[actor]);
 await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt) VALUES($1,'DELIVERY PROGRESS','EA',1,100) ON CONFLICT DO NOTHING",[itemId]);
 await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,1,'3445',1000,1000,now()) ON CONFLICT(item_id,location_id) DO UPDATE SET quantity_available=1000",[itemId]);
});
after(closeDb);
test('slow SO lookup is accepted first, reports its stage, has interactive priority, and executes once',async()=>{
 const f=fixture(),cmd=command('preview',f.input),accepted=await enqueueDeliveryOperation(cmd,context);
 assert.equal(accepted.status,'queued');assert.equal(accepted.id,cmd.operationId);
 const entered=deferred(),release=deferred();let reads=0;
 const work=runDeliveryOperation(accepted.id,{...f.dependencies,readOrder:async()=>{reads++;entered.resolve();await release.promise;assert.equal(isOperatorNetSuiteRequest(),true);return f.dependencies.readOrder();}});
 await entered.promise;
 try{
  const running=await getDeliveryOperation(accepted.id,context);assert.equal(running.status,'running');assert.equal(running.phase,'checking_so');
  assert.equal((await enqueueDeliveryOperation(cmd,context)).id,accepted.id);
  await runDeliveryOperation(accepted.id,f.dependencies);assert.equal(reads,1);
  assert.equal((await activeDeliveryOperation(context)).id,accepted.id);
  await assert.rejects(()=>enqueueDeliveryOperation(command('preview',f.input),context),{code:'REGULAR_DELIVERY_BUSY'});
 }finally{release.resolve();await work;}
 const done=await getDeliveryOperation(accepted.id,context);assert.equal(done.status,'succeeded');assert.equal(done.result.baseLocationId,28);assert.equal(done.result.lines[0].salesQty,200);assert.equal(done.result.palletQuantity,2);
 assert.equal(await activeDeliveryOperation(context),null);
});
test('failed SO check can retry unchanged input with a new command; the old ID never reruns',async()=>{
 const f=fixture(),cmd=command('preview',f.input),op=await enqueueDeliveryOperation(cmd,context);
 await runDeliveryOperation(op.id,{...f.dependencies,readOrder:async()=>{throw new Error('NetSuite unavailable');}});
 const failed=await getDeliveryOperation(op.id,context);assert.equal(failed.status,'failed');assert.match(failed.error,/NetSuite unavailable/);
 assert.equal((await enqueueDeliveryOperation(cmd,context)).status,'failed');
 await runDeliveryOperation(op.id,f.dependencies);assert.equal((await getDeliveryOperation(op.id,context)).status,'failed');
 const retry=await enqueueDeliveryOperation(command('preview',f.input),context);await runDeliveryOperation(retry.id,f.dependencies);
 assert.equal((await getDeliveryOperation(retry.id,context)).status,'succeeded');
});
test('command ownership, immutable payload and manual approval cannot be bypassed',async()=>{
 const f=fixture(),cmd=command('submit',{...f.input,sourceLocationId:15}),op=await enqueueDeliveryOperation(cmd,context);
 await assert.rejects(()=>getDeliveryOperation(op.id,{...context,operatorId:'someone-else'}),{status:404});
 await assert.rejects(()=>enqueueDeliveryOperation({...cmd,input:{...cmd.input,salesOrderRef:'DIFFERENT'}},context),{code:'REGULAR_DELIVERY_OPERATION_CONFLICT'});
 await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,15,'12441',1000,1000,now()) ON CONFLICT DO NOTHING",[itemId]);
 await runDeliveryOperation(op.id,f.dependencies);const saved=(await getDeliveryOperation(op.id,context)).result;
 assert.equal(saved.regular.deliveryApproval,'pending');assert.equal(saved.transfers.length,0);
 const retry=await enqueueDeliveryOperation(command('retry',{},saved.id),context);await runDeliveryOperation(retry.id,f.dependencies);
 assert.equal((await getDeliveryOperation(retry.id,context)).code,'REGULAR_APPROVAL_REQUIRED');
 await assert.rejects(()=>enqueueDeliveryOperation(command('decision',{decision:'stock'},saved.id),context),{status:400});
});
test('orphaned running work becomes interrupted and retry finds the saved request',async()=>{
 const f=fixture(),op=await enqueueDeliveryOperation(command('submit',f.input),context);
 await runDeliveryOperation(op.id,f.dependencies);
 const saved=(await getDeliveryOperation(op.id,context)).result;assert.equal(saved.regular.handoffStatus,'attention');
 const retry=await enqueueDeliveryOperation(command('retry',{},saved.id),context);
 await query("UPDATE regular_stock_delivery_operations SET status='running',phase='creating_to' WHERE id=$1",[retry.id]);
 await runDeliveryOperation(retry.id,f.dependencies);
 assert.equal((await getDeliveryOperation(retry.id,context)).code,'REGULAR_DELIVERY_INTERRUPTED');
 const again=await enqueueDeliveryOperation(command('submit',f.input),context);await runDeliveryOperation(again.id,f.dependencies);
 assert.equal((await getDeliveryOperation(again.id,context)).result.id,saved.id);
});
test('revoked Sales permissions fail queued work before contacting NetSuite',async()=>{
 const f=fixture(),op=await enqueueDeliveryOperation(command('preview',f.input),context);let reads=0;
 await query('UPDATE operators SET active=false WHERE id=$1',[actor]);
 try{await runDeliveryOperation(op.id,{...f.dependencies,readOrder:async()=>{reads++;return f.dependencies.readOrder();}});}
 finally{await query('UPDATE operators SET active=true WHERE id=$1',[actor]);}
 assert.equal(reads,0);assert.equal((await getDeliveryOperation(op.id,context)).code,'REGULAR_DELIVERY_ACCESS');
});

test('loss of the processing DB session stops later stages and exposes an interrupted attempt',async()=>{
 const f=fixture(),op=await enqueueDeliveryOperation(command('preview',f.input),context);
 const entered=deferred(),release=deferred();
 const work=runDeliveryOperation(op.id,{...f.dependencies,readOrder:async()=>{entered.resolve();await release.promise;return f.dependencies.readOrder();}});
 await entered.promise;
 try{
  const lock=(await query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=((hashtextextended($1,0)>>32)&4294967295)::oid AND objid=(hashtextextended($1,0)&4294967295)::oid",[`regular-delivery-operation:${op.id}`])).rows[0];
  assert.ok(lock?.pid);await query('SELECT pg_terminate_backend($1)',[lock.pid]);
  await new Promise(resolve=>setTimeout(resolve,30));
 }finally{release.resolve();await work;}
 assert.equal((await getDeliveryOperation(op.id,context)).code,'REGULAR_DELIVERY_INTERRUPTED');
});
test('a completed paired Delivery preview remains readable with no Sales yard assignment',async()=>{
 const f=fixture(),op=await enqueueDeliveryOperation(command('preview',f.input),context);await runDeliveryOperation(op.id,f.dependencies);
 assert.equal((await getDeliveryOperation(op.id,{...context,authorizedDestinationLocationIds:[]})).status,'succeeded');
});

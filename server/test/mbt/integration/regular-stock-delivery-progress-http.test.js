import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {app} from '../../../src/server.js';
import {query,closeDb,withTransaction} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';
import {runDeliveryOperation,createDeliveryOperationRuntime} from '../../../src/regular-stock-delivery-operations.js';
const suffix=randomUUID(),tokens={},actors={};let server,base;
const path='/api/sales/stock-requests/delivery/operations';
async function http(url,role,body){
 const response=await fetch(base+url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(role?{Authorization:`Bearer ${tokens[role]}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,body:await response.json(),cache:response.headers.get('cache-control')};
}
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
 for(const role of ['sales','scm','dispatcher']){
  const username=`progress-${role}-${suffix}`;
  actors[role]=await createOperator({username,displayName:username,password:'Disposable-Regular-2026!',role,roles:[role],yardLocationIds:[28]});
  tokens[role]=(await http('/api/auth/login',null,{username,password:'Disposable-Regular-2026!'})).body.token;
 }
});
after(async()=>{await new Promise(resolve=>server.close(resolve));await closeDb();});
test('HTTP accepts before NetSuite starts, polls progress, and enforces actor and role isolation',async()=>{
 const command={operationId:randomUUID(),action:'preview',input:{salesOrderRef:'SOB121732'}};
 for(const role of [null,'dispatcher','scm'])assert.equal((await http(path,role,command)).status,role?403:401);
 const started=performance.now(),accepted=await http(path,'sales',command);assert.equal(accepted.status,202);assert.ok(performance.now()-started<1500);
 assert.match(accepted.cache,/no-store/);assert.equal(accepted.body.status,'queued');
 assert.equal((await http(path+'/active','sales')).body.operation.id,command.operationId);
 assert.equal((await http('/api/scm/stock-requests/delivery/operations/'+command.operationId,'scm')).status,404);
 let finish,entered;const blocked=new Promise(resolve=>{finish=resolve;}),reading=new Promise(resolve=>{entered=resolve;});
 const work=runDeliveryOperation(command.operationId,{readOrder:async()=>{entered();await blocked;return {id:1027913,ref:'SOB121732',locationId:1,lines:[{remoteLineId:5053322,itemId:8471,quantity:490,backorderedQuantity:490,uom:'SQFT',locationId:28,open:true}]};}});
 await reading;
 try{const progress=await http(path+'/'+command.operationId,'sales');assert.equal(progress.status,200);assert.equal(progress.body.phase,'checking_so');assert.equal(progress.body.status,'running');}
 finally{finish();await work;}
 const done=(await http(path+'/'+command.operationId,'sales')).body;assert.equal(done.result.baseName,'2967');assert.equal(done.status,'succeeded');
 assert.equal((await http(path,'sales',command)).body.status,'succeeded');
 assert.equal((await http(path+'/active','sales')).body.operation,null);
});
test('hostile commands, role escalation and unknown operation IDs return bounded errors',async()=>{
 for(const delta of [{operationId:'x'},{action:'decision'},{action:'delete'},{input:'not an object'},{input:{text:'x'.repeat(16385)}},{action:'retry',requestId:-1},{action:'retry',requestId:1.5},{requestId:10}]){
  assert.equal((await http(path,'sales',{operationId:randomUUID(),action:'preview',input:{},...delta})).status,400);
 }
 assert.equal((await http(path+'/not-a-uuid','sales')).status,404);
 assert.equal((await http(path+'/'+randomUUID(),'sales')).status,404);
 assert.equal((await http('/api/scm/stock-requests/delivery/operations','dispatcher',{operationId:randomUUID(),action:'retry',requestId:1})).status,403);
});
test('runtime resumes queued work, bounds parallel ticks, expires terminal records and preserves active records',async()=>{
 const command={operationId:randomUUID(),action:'preview',input:{salesOrderRef:'SO-QUEUED'}};
 await http(path,'sales',command);
 const old=randomUUID();await query("INSERT INTO regular_stock_delivery_operations(id,actor_id,audience,action,input,status,updated_at) VALUES($1,$2,'sales','preview','{}','failed',now()-interval '31 days')",[old,actors.sales.id]);
 let calls=0;
 const runtime=createDeliveryOperationRuntime({dependencies:{readOrder:async()=>{calls++;throw Error('retryable lookup failure');}}});
 await Promise.all([runtime.tick(),runtime.tick(),runtime.tick()]);assert.equal(calls,1);
 assert.equal((await query('SELECT 1 FROM regular_stock_delivery_operations WHERE id=$1',[old])).rowCount,0);
 assert.equal((await http(path+'/'+command.operationId,'sales')).body.status,'failed');
 runtime.start();runtime.start();runtime.wake();runtime.stop();
});
test('additive migration rollback rehearsal restores prior operation records',async()=>{
 const before=(await query('SELECT count(*)::int AS n FROM regular_stock_delivery_operations')).rows[0].n;
 assert.ok(before>0);
 await withTransaction(async()=>{
  await query('DROP TABLE regular_stock_delivery_operations');
  await query(await readFile('migrations/241_regular_stock_delivery_operations.sql','utf8'));
  assert.equal((await query('SELECT count(*)::int AS n FROM regular_stock_delivery_operations')).rows[0].n,0);
 },{rollback:true});
 assert.equal((await query('SELECT count(*)::int AS n FROM regular_stock_delivery_operations')).rows[0].n,before);
});

test('SCM asynchronous approval preserves its audit decision and exposes a retryable saved request',async()=>{
 const {submitDeliveryStockRequest}=await import('../../../src/regular-stock-delivery.js');
 const itemId=9800000000185,id=parseInt(randomUUID().replaceAll('-','').slice(0,10),16),ref=`SO-SCM-PROGRESS-${id}`;
 await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_plt) VALUES($1,'SCM PROGRESS','EA',100) ON CONFLICT DO NOTHING",[itemId]);
 await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,15,'12441',1000,1000,now()) ON CONFLICT DO NOTHING",[itemId]);
 const dependencies={readOrder:async()=>({id,ref,locationId:28,lines:[{remoteLineId:1,itemId,quantity:8,backorderedQuantity:2,uom:'EA',locationId:28,open:true}]}),refreshAvailability:async()=>{},liveExecutionEnabled:false};
 const saved=await submitDeliveryStockRequest({salesOrderRef:ref,sourceLocationId:15,destinationLocationId:28},{operatorId:actors.sales.id,authorizedDestinationLocationIds:[28]},dependencies);
 const command={operationId:randomUUID(),action:'decision',requestId:saved.id,input:{decision:'stock',expectedRevision:saved.revision}};
 const scmPath='/api/scm/stock-requests/delivery/operations';
 assert.equal((await http(scmPath,'sales',command)).status,403);
 assert.equal((await http(scmPath,'scm',command)).status,202);
 const events=[],runtime=createDeliveryOperationRuntime({dependencies,emit:id=>events.push(id)});await runtime.tick();
 const done=(await http(scmPath+'/'+command.operationId,'scm')).body;
 assert.equal(done.result.regular.deliveryApproval,'approved');assert.equal(done.result.regular.handoffStatus,'attention');assert.deepEqual(events,[saved.id]);
 assert.equal((await http(path+'/'+command.operationId,'sales')).status,404);
 assert.equal((await http(scmPath,'scm',command)).body.result.id,saved.id);
 const retry={operationId:randomUUID(),action:'retry',requestId:saved.id,input:{}};
 assert.equal((await http(scmPath,'scm',retry)).status,202);await runtime.tick();
 assert.equal((await http(scmPath+'/'+retry.operationId,'scm')).body.result.id,saved.id);
});

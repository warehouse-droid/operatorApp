import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, {after} from 'node:test';
import {query,withTransaction,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';
import {getDeliveryOrder,recordCustomerPickupLoad,recordDeliveryLoad} from '../../../src/delivery-repository.js';
import {buildOperatorNetSuitePostingDraft} from '../../../src/operator-netsuite-posting-domain.js';
import {createOrReplayOperatorNetSuitePostingCommand,claimOperatorNetSuitePostingCommand,startOperatorNetSuitePostingAttempt,recordOperatorNetSuitePostingStepFailure,markOperatorNetSuitePostingCommandAttention} from '../../../src/operator-netsuite-posting-repository.js';
import {packingOrder} from '../../support/group-underpack-fixture.mjs';
after(closeDb);
const photos=['r2://load-followup/one.jpg','r2://load-followup/two.jpg'];
async function fixture(run,pickup=true){
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');
 return withTransaction(async()=>{
  const order=await packingOrder({salesOnly:true,quantity:2,packed:2});
  await query('UPDATE sales_orders SET sales_order_type=$2 WHERE netsuite_id=$1',[order.id,pickup?'Pick-Up':'Delivery']);
  for(let index=2;index<=4;index++) await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,item_type,quantity,unit,location_id,location,packed_sales_qty,netsuite_active)
   VALUES($1,$2::bigint,602,'Fixture','ITEM-'||($2::bigint)::text,'InvtPart',2,'PC',1,'3445',$3,true)`,[order.id,index,index===4?0:2]);
  return run(order);
 },{rollback:true});
}
for(const pickup of [true,false])test(`${pickup?'pickup':'delivery'} load leaves one line available on a fresh local scan`,()=>fixture(async order=>{
 const before=await getDeliveryOrder(order.id);
 assert.equal(before.confirmationSummary.total,4);assert.equal(before.confirmationSummary.confirmed,3);
 const load=pickup?recordCustomerPickupLoad:recordDeliveryLoad;
 await load(order.id,null,{photoDataUrls:photos,requestId:crypto.randomUUID()});
 const remaining=await getDeliveryOrder(order.id);
 assert.equal(remaining.confirmationSummary.total,1);assert.equal(remaining.confirmationSummary.confirmed,0);
 assert.deepEqual(remaining.lines.map(line=>Number(line.loaded_qty)),[2,2,2,0]);
 await query('UPDATE sales_order_lines SET packed_sales_qty=2 WHERE sales_order_id=$1 AND line_id=4',[order.id]);
 // Delivery Prep requires the remaining confirmed balance to be marked packed.
 if(!pickup) await query("UPDATE sales_orders SET operator_status='packed' WHERE netsuite_id=$1",[order.id]);
 await load(order.id,null,{photoDataUrls:photos,requestId:crypto.randomUUID()});
 const done=await getDeliveryOrder(order.id);
 assert.equal(done.confirmationSummary.total,0);
 assert.deepEqual(done.lines.map(line=>Number(line.loaded_qty)),[2,2,2,2]);
 assert.equal((await query('SELECT count(*)::int n FROM operator_load_records WHERE order_id=$1',[order.id])).rows[0].n,2);
},pickup));
test('observed IF persists while the local order stays blocked and private command details stay hidden',()=>fixture(async order=>{
 const operator=await createOperator({username:`load-state-${crypto.randomUUID()}`,displayName:'Load test',password:'load-test-password',role:'operator',roles:['operator'],yardLocationIds:[1]});
 const requestId=crypto.randomUUID();
 const draft=buildOperatorNetSuitePostingDraft({requestId,actorOperatorId:operator.id,functionKey:'customer_pickup',transactionType:'IF',photoRefs:photos,
  policy:{gateKey:'operator_netsuite_customer_pickup_if_3445',revision:1,effective:true,functionKey:'customer_pickup',transactionType:'IF',locationId:1,yardCode:'3445'},
  localOrderKeys:[`customer_pickup:sales_order:${order.id}`],localOperation:{kind:'customer_pickup_load',orderId:String(order.id),orderType:'sales_order'},
  targets:[{sourceOrderKind:'SO',sourceNetSuiteId:order.id,sourceOrderRef:order.ref,selectedLines:[{orderLine:1,quantity:2,location:1,localLineId:String(order.lineId),localOrderKey:`customer_pickup:sales_order:${order.id}`}],availableLines:[{orderLine:1,location:1}]}]});
 const {command}=await createOrReplayOperatorNetSuitePostingCommand(draft);
 const queued=await getDeliveryOrder(order.id);
 assert.ok(queued.posting,'An active command must block another operator before posting starts');
 assert.equal(queued.posting.loadBlocked,true);assert.deepEqual(queued.posting.transactions,[]);
 const lease=await claimOperatorNetSuitePostingCommand({commandId:command.id,workerId:'load-followup'});
 const step=command.steps[0],attempt=await startOperatorNetSuitePostingAttempt({commandId:command.id,stepId:step.id,leaseToken:lease.leaseToken});
 await recordOperatorNetSuitePostingStepFailure({commandId:command.id,stepId:step.id,leaseToken:lease.leaseToken,attemptNumber:attempt.attemptNumber,uncertain:true,error:new Error('Unexpected line'),observedTransaction:{id:996410,tranId:'IF153890',externalId:step.externalId}});
 await markOperatorNetSuitePostingCommandAttention({commandId:command.id,leaseToken:lease.leaseToken,error:new Error('Unexpected line')});
 const detail=await getDeliveryOrder(order.id);
 assert.ok(detail.posting,'An uncertain IF must remain visibly held');
 assert.equal(detail.posting.jobId,command.id);assert.equal(detail.posting.status,'attention');assert.equal(detail.posting.loadBlocked,true);
 assert.deepEqual(detail.posting.transactions,[{id:996410,ref:'IF153890',verified:false}]);
 assert.ok(!JSON.stringify(detail.posting).includes('r2://'));assert.equal(detail.posting.actorOperatorId,undefined);
 assert.equal(detail.confirmationSummary.confirmed,3);
 await assert.rejects(createOrReplayOperatorNetSuitePostingCommand({...draft,requestId:crypto.randomUUID()}),{code:'OPERATOR_NETSUITE_POSTING_ORDER_CLAIMED'});
}));

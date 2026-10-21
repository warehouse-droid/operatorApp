import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {createSalesOrderAutoFulfillmentProcessor} from '../../../src/sales-order-auto-fulfillment-service.js';
import {salesOrderBillingExclusions} from '../../../src/netsuite-fulfillment-exclusions.js';
test('property: waiting and recovery never post, while prepared automatic work remains possible',async()=>{
 await fc.assert(fc.asyncProperty(fc.constantFrom('waiting_evidence','discovered','automatic','recover','lookup failed','missing payload'),
  fc.integer({min:1,max:10000}),async(mode,quantity)=>{
   const externalId='MBBS-SOIF-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
   const candidate={id:'test',status:['waiting_evidence','discovered'].includes(mode)?mode:'queued',sourceSalesOrderId:100,
    externalId,resolutionAction:mode==='automatic'?'automatic':'recover',lineSnapshot:[{orderLine:1,itemId:10,deliveredQuantity:quantity,location:1}],
    payload:mode==='missing payload'?{}:{externalId,item:{items:[{orderLine:1,quantity,itemReceive:true,location:1}]}}};
   let transforms=0,reads=0,claims=0;
   const repository={prepare:async()=>candidate,get:async()=>candidate,attention:async()=>({...candidate,status:'uncertain'}),
    claim:async()=>{claims++;return {...candidate,leaseToken:'lease'};},renew:async()=>true,startAttempt:async()=>({attemptNumber:1}),
    complete:async()=>({...candidate,status:'completed'}),failure:async()=>({...candidate,status:'failed'})};
   const processor=createSalesOrderAutoFulfillmentProcessor({repository,workerId:'test',
    fetchLiveOrder:async()=>{reads++;return {lines:[{orderLine:1,itemId:10,remainingQuantity:quantity,fulfilledQuantity:0,location:1}]};},
    adapter:{findByExternalId:async()=>{if(mode==='lookup failed')throw new Error('Lookup failed');return null;},
     transform:async()=>{transforms++;return {id:200};},fetchById:async()=>({id:200}),verify:()=>({id:200,transactionRef:'IF200'})}});
   const result=await processor.process('test');
   assert.equal(transforms,mode==='automatic'?1:0);assert.equal(claims,mode==='automatic'?1:0);assert.equal(reads,mode==='automatic'?1:0);
   if(['waiting_evidence','discovered'].includes(mode))assert.equal(result.status,mode);
   if(mode==='automatic')assert.equal(result.status,'completed');
  }),{seed:20261003,numRuns:60});
});
test('property: billing exclusions retain exact identities and never deselect stock items',()=>{
 fc.assert(fc.property(fc.integer({min:1,max:100000}),fc.constantFrom('Sales Credit - Hardscaping','Delivery Charge'),
  (line,name)=>{
   const row={item_type:'NonInvtPart',item_name:name,rest_order_line:line,item_id:4646,location_id:1};
   const source=[{line,item:{id:'4646'}}];
   assert.deepEqual(salesOrderBillingExclusions([row],source),[{orderLine:line,itemId:4646,location:1}]);
   assert.deepEqual(salesOrderBillingExclusions([{...row,item_type:'InvtPart'}],source),[]);
   assert.throws(()=>salesOrderBillingExclusions([row],[{line,item:{id:'999'}}]));
   assert.throws(()=>salesOrderBillingExclusions([row],[...source,...source]));
  }),{seed:20261003,numRuns:100});
});

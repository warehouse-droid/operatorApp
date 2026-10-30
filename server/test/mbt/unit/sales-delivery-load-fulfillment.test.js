// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {salesOrderLoadSnapshotLines} from '../../../src/sales-order-auto-fulfillment-loads.js';
import {createSalesOrderAutoFulfillmentProcessor} from '../../../src/sales-order-auto-fulfillment-service.js';

const source={outbound_location_id:15};
const line={local_line_id:'1',local_order_line:10,source_line_id:'1',source_order_line:10,item_id:101,item_type:'InvtPart',location_id:15};
const saved=quantity=>({operator_load_record_id:'7',operator_load_snapshot:[{lineId:10,itemId:101,quantity}]});

test('property: saved load quantities and identities survive arbitrary mutable loaded totals',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:1000000}),fc.integer({min:0,max:1000000}),(units,mutable)=>{
    const result=salesOrderLoadSnapshotLines(saved(units/100),source,[{...line,mutable_loaded_quantity:mutable}]);
    assert.equal(result.length,1);
    assert.equal(result[0].deliveredQuantity,undefined);
    assert.equal(result[0].targetQuantity,units/100);
    assert.equal(result[0].operatorLoadedQuantity,units/100);
    assert.equal(result[0].orderLine,10);
    assert.equal(result[0].operatorLoadRecordId,'7');
    assert.equal(result[0].completedPoQuantity+result[0].completedDirectToQuantity,0);
  }),{seed:20261021,numRuns:150});
});

test('saved loads reject hostile quantities and ambiguous or changed item identities',()=>{
  for(const amount of [-1,Infinity,NaN,'hostile']) {
    assert.throws(()=>salesOrderLoadSnapshotLines(saved(amount),source,[line]),/quantity is invalid/);
  }
  for(const lines of [[],[line,line],[{...line,item_id:999}]]) {
    assert.throws(()=>salesOrderLoadSnapshotLines(saved(4),source,lines),/one source item/);
  }
  assert.deepEqual(salesOrderLoadSnapshotLines(saved(0),source,[line]),[]);
  assert.deepEqual(salesOrderLoadSnapshotLines(saved(4),source,[{...line,item_type:'NonInvtPart'}]),[]);
});

test('partial load posts just its saved lines and quantity while other SO lines remain open',async()=>{
  const candidate={id:'12345678-1234-4234-8234-123456789012',status:'queued',operatorLoadRecordId:'7',
    externalId:'MBBS-SOIF-12345678-1234-4234-8234-123456789012',
    lineSnapshot:[{orderLine:10,itemId:101,deliveredQuantity:4,location:15}]};
  let payload;
  const repository={prepare:async()=>candidate,claim:async input=>{payload=input.payload;return {...candidate,leaseToken:'lease'};},
    renew:async()=>{},startAttempt:async()=>({attemptNumber:1}),complete:async()=>({status:'completed'}),
    attention:async details=>{throw new Error(JSON.stringify(details));},get:async()=>candidate};
  let transforms=0;
  const processor=createSalesOrderAutoFulfillmentProcessor({repository,workerId:'test',
    fetchLiveOrder:async()=>({lines:[{orderLine:10,itemId:101,remainingQuantity:10,fulfilledQuantity:0,location:15},
      {orderLine:20,itemId:102,remainingQuantity:6,fulfilledQuantity:0,location:15}]}),
    adapter:{findByExternalId:async()=>null,transform:async()=>{transforms++;return {id:9,record:{id:9,tranId:'IF9'}};},
      verify:(_candidate,record)=>record}});
  assert.equal((await processor.process(candidate.id)).status,'completed');
  assert.equal(transforms,1);
  assert.equal(payload.item.items.find(value=>value.orderLine===10).quantity,4);
  assert.equal(payload.item.items.find(value=>value.orderLine===20).itemReceive,false);
});

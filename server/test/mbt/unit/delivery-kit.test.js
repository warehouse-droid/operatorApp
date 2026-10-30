import assert from 'node:assert/strict';
import test from 'node:test';
import {readDeliveryFulfillmentSource,deliveryFulfillmentPostingPlan} from '../../../src/sales-order-auto-fulfillment-kits.js';
import {deliveryKitFixture as fixture,deliveryKitProcessor} from '../../support/delivery-kit-fixture.mjs';
import {kitFixture} from '../../support/operator-kit-fixture.mjs';
import fc from 'fast-check';
import {buildSalesOrderItemFulfillmentPayload} from '../../../src/sales-order-auto-fulfillment-domain.js';
import {fetchSalesOrderFulfillmentStateFromNetSuite} from '../../../src/netsuite.js';

test('delivery kit uses saved component evidence but posts only its exact parent',async()=>{
  const f=fixture();
  const live=await readDeliveryFulfillmentSource(f.candidate,{readSource:async(id,options)=>{
    assert.equal(id,997764);assert.equal(options.includeAllSourceLines,true);return f.source;
  },readKitSource:async()=>f.kitSource});
  assert.deepEqual(live.lines.map(line=>line.orderLine),[1,3]);
  const selected=f.candidate.lineSnapshot.map(line=>({orderLine:line.orderLine,itemId:line.itemId,quantity:line.deliveredQuantity,location:line.location}));
  const before=structuredClone(f.candidate);
  const plan=deliveryFulfillmentPostingPlan(f.candidate,selected,live);
  assert.deepEqual(plan.selectedLines.map(line=>[line.orderLine,line.itemId,line.quantity]),[[1,2141,95.6],[2,10126,1]]);
  assert.deepEqual(plan.availableLines.map(line=>line.orderLine),[1,2]);
  assert.equal(plan.liveOrder.kitPostingLines[1].kit.physicalLines[0].sourceLineKey,'4974658');
  assert.equal(plan.liveOrder.kitPostingLines[1].kit.physicalLines[0].itemId,599);
  assert.deepEqual(f.candidate,before);
});

test('ordinary-only loading on a kit order still resolves and deselects the unselected kit',async()=>{
  const f=fixture();f.candidate.lineSnapshot=f.candidate.lineSnapshot.slice(0,1);
  f.candidate.operatorLoadSnapshot=f.candidate.operatorLoadSnapshot.slice(0,1);
  f.source.lines[1].kitParent=true;
  const live=await readDeliveryFulfillmentSource(f.candidate,{readSource:async()=>f.source,readKitSource:async()=>f.kitSource});
  assert.deepEqual(live.lines.map(line=>line.orderLine),[1,3]);
  const plan=deliveryFulfillmentPostingPlan(f.candidate,[{orderLine:1,itemId:2141,quantity:95.6,location:1}],live);
  assert.deepEqual(plan.selectedLines.map(line=>line.orderLine),[1]);
  assert.deepEqual(plan.availableLines.map(line=>line.orderLine),[1,2]);
});

test('authoritative source reader marks kit parents without exposing component lines as REST lines',async()=>{
  const rows=[{id:'997764',tranid:'SO-TEST',status:'B',order_line:'4974657',rest_order_line:'2',item_id:'10126',item_type:'Kit',is_fulfillable:'T',quantity:'-1',fulfilled_quantity:'0',location_id:'1'},
    {id:'997764',tranid:'SO-TEST',status:'B',order_line:'4974658',rest_order_line:'3',item_id:'599',item_type:'InvtPart',is_fulfillable:'T',quantity:'-1',fulfilled_quantity:'0',location_id:'1'}];
  const live=await fetchSalesOrderFulfillmentStateFromNetSuite(997764,{includeAllSourceLines:true,query:async()=>({items:rows}),
    fetchItems:async()=>[{line:2,item:{id:'10126'},quantity:1}]});
  assert.equal(live.lines.length,1);assert.equal(live.lines[0].kitParent,true);
  assert.equal(live.lines[0].orderLine,2);
});

test('real delivery processor and native adapter post parent quantities once and retain physical evidence',async()=>{
  const f=fixture(),before=structuredClone(f.candidate.lineSnapshot),h=deliveryKitProcessor(f);
  const result=await h.processor.process(f.candidate.id);
  assert.equal(result.status,'completed',result.error);
  assert.deepEqual(result.payload.item.items,[{orderLine:1,quantity:95.6,itemReceive:true,location:1},{orderLine:2,quantity:1,itemReceive:true,location:1}]);
  assert.deepEqual(result.lineSnapshot,before);
  assert.equal(result.liveSnapshot.kitPostingLines[1].kit.physicalLines[0].itemId,599);
  await h.processor.process(f.candidate.id);assert.equal(h.posts(),1);
});

test('timeout recovery verifies the posted parent without another transform',async()=>{
  const f=fixture(),h=deliveryKitProcessor(f,undefined,{timeout:true});
  assert.equal((await h.processor.process(f.candidate.id)).status,'completed');
  assert.equal(f.candidate.result.recovered,true);assert.equal(h.posts(),1);
});

test('delivery kit reads back and verifies the exact IF when the transform returns only an ID',async()=>{
  const f=fixture(),h=deliveryKitProcessor(f,undefined,{fetchAfterPost:true});
  const result=await h.processor.process(f.candidate.id);assert.equal(result.status,'completed',result.error);
  assert.equal(result.result.transactionId,8800656);assert.equal(h.posts(),1);
});

test('resuming a durable location plan retains original kit posting evidence across a new source read',async()=>{
  const f=fixture(),live=await readDeliveryFulfillmentSource(f.candidate,{readSource:async()=>f.source,readKitSource:async()=>f.kitSource});
  const selected=f.candidate.lineSnapshot.map(line=>({orderLine:line.orderLine,itemId:line.itemId,quantity:line.deliveredQuantity,location:line.location}));
  const plan=deliveryFulfillmentPostingPlan(f.candidate,selected,live);
  f.candidate.status='uncertain';f.candidate.resolutionAction='recover';
  f.candidate.payload=buildSalesOrderItemFulfillmentPayload({selectedLines:plan.selectedLines,availableLines:plan.availableLines,externalId:f.candidate.externalId});
  f.candidate.liveSnapshot={...plan.liveOrder,selectedLines:plan.selectedLines};
  const evidence=structuredClone(f.candidate.liveSnapshot.kitPostingLines),h=deliveryKitProcessor(f,undefined,{splitPlan:true});
  const result=await h.processor.process(f.candidate.id);assert.equal(result.status,'completed',result.error);
  assert.deepEqual(result.liveSnapshot.kitPostingLines,evidence);assert.equal(h.posts(),1);
});

for(const variant of ['missing-member','fractional','different-count','changed-key','duplicate-load','missing-load','changed-item','changed-location']) {
  test(`delivery kit rejects ${variant} before a transform`,async()=>{
    const f=fixture(kitFixture({ordered:4,count:2,ratios:[1,2]}));
    if(variant==='missing-member') {f.candidate.lineSnapshot.pop();f.candidate.operatorLoadSnapshot.pop();}
    if(variant==='fractional') f.candidate.lineSnapshot.forEach(line=>{line.deliveredQuantity*=0.75;});
    if(variant==='different-count') f.candidate.lineSnapshot[1].deliveredQuantity=2;
    if(variant==='changed-key') f.candidate.operatorLoadSnapshot[0].lineId='123456';
    if(variant==='duplicate-load') f.candidate.operatorLoadSnapshot.push(f.candidate.operatorLoadSnapshot[0]);
    if(variant==='missing-load') f.candidate.operatorLoadSnapshot=[];
    if(variant==='changed-item') f.candidate.lineSnapshot[0].itemId=12345;
    if(variant==='changed-location') f.candidate.lineSnapshot[0].location=28;
    const h=deliveryKitProcessor(f),result=await h.processor.process(f.candidate.id);
    assert.equal(result.status,'attention',result.error);assert.equal(h.posts(),0);
  });
}

test('source read failure and definition drift at the final preflight cannot post',async()=>{
  for(const variant of ['read','definition','remaining']) {
    const f=fixture(),h=deliveryKitProcessor(f,undefined,variant==='read'?{readKitSource:async()=>{throw new Error('source unavailable');}}:
      {preflightSource:source=>{const copy=structuredClone(source);if(variant==='definition')copy.kitGroups[0].members[0].quantityPerKit=2;
        else copy.availableLines[1].remainingQuantity=0;return copy;}});
    assert(['attention','failed'].includes((await h.processor.process(f.candidate.id)).status));assert.equal(h.posts(),0);
  }
});

test('fulfilled sources reconcile without reading kit definitions or creating an IF',async()=>{
  const f=fixture();f.source={id:997764,status:'F',fulfillmentComplete:true,lines:[]};
  const h=deliveryKitProcessor(f);
  assert.equal((await h.processor.process(f.candidate.id)).status,'reconciled');
  assert.equal(h.posts(),0);assert.equal(h.kitReads(),0);
});

test('ordinary orders keep their direct source path and billing exclusions',async()=>{
  const f=fixture();f.candidate.lineSnapshot=f.candidate.lineSnapshot.slice(0,1);
  f.source.lines=f.source.lines.slice(0,1);f.source.lines.push({orderLine:8,canFulfill:false});
  f.source.excludedLines=[{orderLine:8,itemId:1987,location:1}];
  const live=await readDeliveryFulfillmentSource(f.candidate,{readSource:async()=>f.source,readKitSource:async()=>assert.fail('ordinary order must not read kits')});
  assert.deepEqual(live.lines.map(line=>line.orderLine),[1]);
  const selected=[{orderLine:1,itemId:2141,quantity:95.6,location:1}];
  assert.deepEqual(deliveryFulfillmentPostingPlan(f.candidate,selected,live),{selectedLines:selected,availableLines:live.lines,liveOrder:live});
});

test('missing and conflicting-yard sources stop safely',async()=>{
  for(const variant of ['missing','yard']) {
    const f=fixture();if(variant==='missing') f.source=null;else f.candidate.canonicalLocationId=28;
    const h=deliveryKitProcessor(f),result=await h.processor.process(f.candidate.id);
    assert.equal(result.status,variant==='missing'?'closed':'attention');assert.equal(h.posts(),0);
  }
});

test('property: complete physical kit counts produce exactly one parent with unchanged component evidence',async()=>{
  await fc.assert(fc.asyncProperty(fc.integer({min:1,max:30}),fc.array(fc.integer({min:1,max:5}),{minLength:1,maxLength:4}),async(count,ratios)=>{
    const f=fixture(kitFixture({ordered:count+2,count,ratios})),before=structuredClone(f.candidate.lineSnapshot),h=deliveryKitProcessor(f);
    const result=await h.processor.process(f.candidate.id);
    assert.equal(result.status,'completed',result.error);assert.equal(h.posts(),1);
    assert.deepEqual(result.payload.item.items,[{orderLine:2,quantity:count,itemReceive:true,location:1}]);
    assert.equal(result.liveSnapshot.kitPostingLines[0].itemId,10126);
    assert.equal(result.liveSnapshot.kitPostingLines[0].kit.physicalLines.length,ratios.length);
    assert.deepEqual(result.lineSnapshot,before);
    const invalid=fixture(kitFixture({ordered:count+2,count,ratios}));invalid.candidate.operatorLoadSnapshot[0].lineId='999999';
    const rejected=deliveryKitProcessor(invalid);assert.equal((await rejected.processor.process(invalid.candidate.id)).status,'attention');assert.equal(rejected.posts(),0);
  }),{numRuns:30,seed:20261029});
});

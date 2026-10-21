import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {readSpecialClosedOrders,assertSpecialClosedOrderEvidence} from '../../../src/special-stock-closed-orders.js';
import {createSpecialClosureService} from '../../../src/special-stock-closure-service.js';

const detail=()=>({id:67,revision:72,salesOrderId:1022888,salesOrderRef:'SOM06738',purchaseOrderId:1023378,
  purchaseOrderRef:'POB03960',closeStatus:'closure_pending',closureReview:{id:'review',status:'attention'}});
const rows=()=>new Map([[1022888,{id:'1022888',tranid:'SOM06738',type:'SalesOrd',status:'H',status_text:'Sales Order : Closed'}],
  [1023378,{id:'1023378',tranid:'POB03960',type:'PurchOrd',status:'H',status_text:'Purchase Order : Closed'}]]);
function boundary() {
  const records=rows(),reads=[];
  return {records,reads,queryAll:async sql=>{const id=Number(/t.id = (\d+)/.exec(sql)[1]);reads.push(id);return [records.get(id)];}};
}

test('already Closed linked orders verify through header queries without REST, lines or unit resolution',async()=>{
  const b=boundary(),evidence=await readSpecialClosedOrders(detail(),b);
  assert.deepEqual(b.reads,[1022888,1023378]);
  assert.deepEqual(evidence.orders.map(o=>[o.id,o.kind,o.reference,o.statusText]),[
    [1022888,'sales_order','SOM06738','Sales Order : Closed'],[1023378,'purchase_order','POB03960','Purchase Order : Closed']]);
  assert.doesNotThrow(()=>assertSpecialClosedOrderEvidence(detail(),JSON.parse(JSON.stringify(evidence))));
});

test('property: an open SO or PO never qualifies even when local cached statuses are Closed',async()=>{
  await fc.assert(fc.asyncProperty(fc.constantFrom(1022888,1023378),
    fc.constantFrom('Pending Fulfillment','Pending Billing','Pending Receipt','Billed','Partially Received',''),async(id,status)=>{
      const b=boundary();b.records.get(id).status_text=status;
      const d={...detail(),salesOrderStatus:'Closed',purchaseOrderStatus:'Closed'};
      if(status)assert.equal(await readSpecialClosedOrders(d,b),null);
      else await assert.rejects(readSpecialClosedOrders(d,b),{status:409});
    }),{seed:26093011,numRuns:45});
});

test('property: exact remote ID, type, reference and complete singleton header evidence are required',async()=>{
  await fc.assert(fc.asyncProperty(fc.constantFrom('id','type','tranid'),fc.constantFrom(1022888,1023378),async(field,id)=>{
    const b=boundary();b.records.get(id)[field]='wrong';
    await assert.rejects(readSpecialClosedOrders(detail(),b),{status:409});
  }),{seed:26093012,numRuns:25});
  for(const result of [[],[rows().get(1022888),rows().get(1022888)],[null]]) {
    await assert.rejects(readSpecialClosedOrders(detail(),{queryAll:async()=>result}),{status:409});
  }
  const d={...detail(),salesOrderId:0};
  await assert.rejects(readSpecialClosedOrders(d,boundary()),{status:409});
  await assert.rejects(readSpecialClosedOrders({...detail(),salesOrderId:null},boundary()),{status:409});
  await assert.rejects(readSpecialClosedOrders({...detail(),purchaseOrderId:1022888},boundary()),{status:409});
});

test('SO-only Closed and cancelled orders qualify; a case without orders makes no NetSuite call',async()=>{
  const b=boundary(),d={...detail(),purchaseOrderId:null,purchaseOrderRef:null};
  for(const status of ['Closed','Cancelled','Canceled']) {
    b.records.get(1022888).status_text=`Sales Order : ${status}`;
    assert.equal((await readSpecialClosedOrders(d,b)).orders.length,1);
  }
  assert.equal(await readSpecialClosedOrders({salesOrderId:null,purchaseOrderId:null},{queryAll:async()=>assert.fail('No order to query')}),null);
});

test('property: local finalization rejects partial, duplicate, reopened or unrelated evidence',async()=>{
  const evidence=await readSpecialClosedOrders(detail(),boundary());
  for(const orders of [[],evidence.orders.slice(0,1),[evidence.orders[0],evidence.orders[0]],
    evidence.orders.map(o=>({...o,statusText:'Pending Billing'})),evidence.orders.map(o=>({...o,statusText:null}))]) {
    assert.throws(()=>assertSpecialClosedOrderEvidence(detail(),{orders}),{status:409});
  }
  await fc.assert(fc.property(fc.constantFrom('id','kind','reference','type','status'),field=>{
    const changed=JSON.parse(JSON.stringify(evidence));changed.orders[0][field]='wrong';
    assert.throws(()=>assertSpecialClosedOrderEvidence(detail(),changed),{status:409});
  }),{seed:26093013,numRuns:25});
});

function serviceFixture({request=false}={}) {
  const d=detail(),events=[],b=boundary();
  const service=createSpecialClosureService({
    withReviewLock:async(_id,run)=>{events.push('lock');return run();},getCase:async()=>d,
    readClosedOrders:input=>readSpecialClosedOrders(input,b),
    closeLocalCase:async(id,input,context)=>{events.push({id,input,context});return {...d,closeStatus:'closed',status:'cancelled'};},
    claimReview:async()=>assert.fail('Already closed orders need no remote cancellation claim'),
    requestCaseClosure:async()=>assert.fail('Already closed orders need no remote cancellation request'),
    resolveOrderUnits:async()=>assert.fail('Closed headers require no units'),preparePlan:async()=>assert.fail('No remote plan'),
    applyPlan:async()=>assert.fail('No remote writes')
  });
  return {d,b,events,run:()=>request?service.requestClosure(67,{expectedRevision:72,reason:'Already closed'},{operatorId:'sales',authorizedStoreLocationIds:[1]}):
    service.reviewClosure(67,{expectedRevision:72,reviewId:'review',decision:'approve'},{operatorId:'scm'})};
}

for(const request of [false,true])test(`${request?'Sales':'SCM'} closes an already Closed pair locally and verifies again before finalization`,async()=>{
  const f=serviceFixture({request}),result=await f.run();
  assert.equal(result.closeStatus,'closed');assert.equal(result.status,'cancelled');
  assert.deepEqual(f.b.reads,[1022888,1023378,1022888,1023378]);
  assert.equal(f.events[0],'lock');assert.equal(f.events.length,2);
  assert.equal(f.events[1].input.expectedRevision,72);assert.equal(f.events[1].input.closedOrders.orders.length,2);
});

test('property: a reopened order between verification reads cannot close locally or trigger a remote write',async()=>{
  await fc.assert(fc.asyncProperty(fc.constantFrom(1022888,1023378),fc.constantFrom('Pending Billing','Pending Receipt','Cancelled'),async(id,status)=>{
    const f=serviceFixture(),original=f.b.queryAll;
    f.b.queryAll=async sql=>{if(f.b.reads.length===2)f.b.records.get(id).status_text=status;return original(sql);};
    await assert.rejects(f.run(),{status:409});assert.deepEqual(f.events,['lock']);
  }),{seed:26093014,numRuns:20});
});

test('SCM rejection retains the existing rejection path and performs no closed-order query',async()=>{
  const service=createSpecialClosureService({withReviewLock:async(_id,run)=>run(),
    readClosedOrders:async()=>assert.fail('Rejection must not read NetSuite'),rejectReview:async()=>({closeStatus:'active'})});
  assert.equal((await service.reviewClosure(67,{decision:'reject'})).closeStatus,'active');
});

test('property: explicit recovery requires Pending Billing and every material quantity fully fulfilled',async()=>{
  await fc.assert(fc.asyncProperty(fc.integer({min:0,max:20}),async(executed)=>{
    const b=boundary();b.records.get(1022888).status='F';b.records.get(1022888).status_text='Sales Order : Pending Billing';
    const original=b.queryAll;b.queryAll=async sql=>sql.includes('transactionline')?
      [{uniquekey:'5040543',item:'2055',base_quantity:'-10',execution_quantity:String(executed)}]:original(sql);
    assert.equal(await readSpecialClosedOrders(detail(),b),null);
    const evidence=await readSpecialClosedOrders(detail(),b,{allowFulfilledSalesOrder:true});
    if(executed>=10) {
      assert.equal(evidence.orders[0].status,'F');assert.equal(evidence.orders[0].fullyFulfilled,true);
      assert.throws(()=>assertSpecialClosedOrderEvidence(detail(),evidence),{status:409});
      assert.doesNotThrow(()=>assertSpecialClosedOrderEvidence(detail(),evidence,{allowFulfilledSalesOrder:true}));
    }else assert.equal(evidence,null);
  }),{seed:26093015,numRuns:30});
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpecialQuantityService } from '../../../src/special-stock-quantity-service.js';

function fixture({issued=true,po=true,skipped=false}={}) {
  const events=[];
  const review={id:'review-1',mode:issued?'issued':'draft',status:'pending',lines:[{caseLineId:1,fromQuantity:24,toQuantity:36,fromPurchaseQuantity:2,toPurchaseQuantity:3}]};
  const detail={id:7,revision:3,salesOrderId:issued&&!skipped?901:null,purchaseOrderId:issued&&po&&!skipped?902:null,
    salesOrderSkipped:skipped,quantityReview:review,quantityReviewPlan:null,
    salesOrderLines:[{caseLineId:1,remoteLineId:90101,itemId:2055,quantity:24,rate:9,uom:'PC',description:'Product'}],
    purchaseOrderLines:[{caseLineId:1,remoteLineId:90201,itemId:2055,quantity:2,rate:4,uom:'PLT',description:'Product'}]};
  const deps={
    withReviewLock:async(id,run)=>{events.push(['lock',id]);return run();},
    claimReview:async()=>{events.push(['claim']);review.status='applying';return detail;},
    rejectReview:async()=>{events.push(['reject']);return {...detail,quantityReview:{...review,status:'rejected'}};},
    savePlan:async(id,input)=>{events.push(['save',input.remoteStarted]);detail.quantityReviewPlan ||= input.plan;review.remoteStarted ||= input.remoteStarted;},
    preparePlan:async({orders})=>{events.push(['prepare',orders]);return {version:1,orders};},
    applyPlan:async(plan)=>{events.push(['apply']);if(deps.fail){deps.fail=false;throw new Error('PO unavailable');}return {verifiedOrderIds:plan.orders.map(order=>order.id)};},
    finishReview:async(id,input)=>{events.push(['finish',input.verifiedOrderIds]);review.status='approved';return detail;},
    failReview:async()=>{events.push(['attention']);review.status='attention';},
    resolveOrderUnits:async lines=>lines.map(line=>({...line,unitId:line.uom==='PC'?865:10}))
  };
  return {events,review,detail,deps,service:createSpecialQuantityService(deps)};
}
const input={reviewId:'review-1',expectedRevision:3,decision:'approve'};
test('SCM saves exact SO and proportional PO targets before remote writes and completes with verified receipts',async()=>{
  const f=fixture();await f.service.reviewQuantityChange(7,input,{operatorId:2});
  assert.deepEqual(f.events.map(e=>e[0]),['lock','claim','prepare','save','apply','finish']);
  assert.equal(f.events[2][1][0].lines[0].toQuantity,36);assert.equal(f.events[2][1][1].lines[0].toQuantity,3);
  assert.equal(f.events[3][1],true);assert.deepEqual(f.events[5][1],[901,902]);
});
test('partial failure retains the plan and retries without replacing its original baseline',async()=>{
  const f=fixture();f.deps.fail=true;
  await assert.rejects(()=>f.service.reviewQuantityChange(7,input),/PO unavailable/);
  assert.equal(f.review.status,'attention');assert.equal(f.review.remoteStarted,true);
  await f.service.reviewQuantityChange(7,input);
  assert.equal(f.events.filter(e=>e[0]==='prepare').length,1);assert.equal(f.review.status,'approved');
});
for(const [label,options]of [['pre-SO',{issued:false}],['test-skipped',{skipped:true}]])test(`${label} approval stays local`,async()=>{
  const f=fixture(options);await f.service.reviewQuantityChange(7,input);
  assert.deepEqual(f.events.map(e=>e[0]),['lock','claim','finish']);assert.deepEqual(f.events[2][1],[]);
});
test('SO without issued PO updates SO and lets the repository update the PO draft',async()=>{
  const f=fixture({po:false});await f.service.reviewQuantityChange(7,input);
  assert.deepEqual(f.events.at(-1),['finish',[901]]);
});
test('reject uses repository authorization and never claims or touches NetSuite',async()=>{
  const f=fixture();await f.service.reviewQuantityChange(7,{...input,decision:'reject'});
  assert.deepEqual(f.events.map(e=>e[0]),['lock','reject']);
});
test('invalid decisions and mixed simulated/live orders fail closed',async()=>{
  const f=fixture();await assert.rejects(()=>f.service.reviewQuantityChange(7,{...input,decision:'guess'}),{code:'SPECIAL_QUANTITY_DECISION_INVALID'});
  assert.deepEqual(f.events,[]);
  f.detail.salesOrderSkipped=true;
  await assert.rejects(()=>f.service.reviewQuantityChange(7,input),{code:'SPECIAL_TEST_ORDER_REMOTE_BLOCKED'});
  assert.ok(!f.events.some(e=>e[0]==='apply'));
});

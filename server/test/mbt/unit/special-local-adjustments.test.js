import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { planSpecialLocalAdjustment, specialAdjustmentIsLocal, specialLocalPurchaseDraft } from '../../../src/special-stock-local-adjustments.js';
import { createSpecialQuantityService } from '../../../src/special-stock-quantity-service.js';

const line = (id, extra = {}) => ({ id, productName: `Product ${id}`, salesDecision: 'accepted',
  packageQuantity: 2, quantity: 2, originalRate: 120, discountPercent: 10, conversionToPc: 12, rateUom: 'PLT',
  itemResolution: {salesQuantity: 24, purchaseQuantity: 2}, ...extra });
const detail = lines => ({lines, palletTotal: 0, palletRate: null});

test('removal preserves the other material quantity, conversion and price', () => {
  const d = detail([line(1), line(2)]);
  const result = planSpecialLocalAdjustment(d, {lines:[{caseLineId:1,remove:true},{caseLineId:2,quantity:2,discountPercent:10}]});
  assert.deepEqual(result.lines, [{caseLineId:1,productName:'Product 1',remove:true,
    fromPackageQuantity:2,packageUom:'PLT',fromQuantity:24,fromPurchaseQuantity:2}]);
  assert.equal(result.localOnly,true); assert.equal(result.pallets,undefined);
});
test('local proposals retain the current request basis and fixed original rate across repeated edits', () => {
  const d=detail([line(1,{packageQuantity:3,discountPercent:15,itemResolution:{salesQuantity:36,purchaseQuantity:3}})]);
  const result=planSpecialLocalAdjustment(d,{lines:[{caseLineId:1,quantity:4,discountPercent:20,color:'red'}]});
  const c=result.lines[0];
  assert.equal(c.fromQuantity,36); assert.equal(c.toQuantity,48); assert.equal(c.toPurchaseQuantity,4);
  assert.equal(c.fromDiscountPercent,15); assert.equal(c.toDiscountPercent,20);
  assert.equal(c.toConversion,12); assert.equal(c.toFields.color,'red');
  assert.equal(d.lines[0].originalRate,120);
});
test('removing every accepted line is a local proposal without cancelling an order', () => {
  const result=planSpecialLocalAdjustment(detail([line(1)]),{lines:[{caseLineId:1,remove:true}]});
  assert.equal(result.lines.length,1); assert.equal(result.lines[0].remove,true);
});
test('malformed removal flags, duplicate, missing and foreign IDs fail without changing the request', () => {
  const d=detail([line(1),line(2)]), before=JSON.stringify(d);
  for(const lines of [[],[{caseLineId:1,remove:true},{caseLineId:1,remove:true}],
    [{caseLineId:1,remove:true},{caseLineId:99,quantity:2}],
    [{caseLineId:1,remove:'true'},{caseLineId:2,quantity:2}],
    [null,{caseLineId:2,quantity:2}]]) {
    assert.throws(()=>planSpecialLocalAdjustment(d,{lines}),{code:'SPECIAL_QUANTITY_LINES_INVALID'});
    assert.equal(JSON.stringify(d),before);
  }
});
test('an unchanged request rejects the proposal; local pallet removal does not need remote verification', () => {
  assert.throws(()=>planSpecialLocalAdjustment(detail([line(1)]),{lines:[{caseLineId:1,quantity:2}]}),{code:'SPECIAL_QUANTITY_UNCHANGED'});
  const result=planSpecialLocalAdjustment({...detail([line(1)]),palletTotal:2,palletRate:40},
    {lines:[{caseLineId:1,quantity:2}],palletTotal:0});
  assert.deepEqual(result.pallets,{fromQuantity:2,toQuantity:0,rate:40});
});
test('property: a removal selects exactly those IDs and never changes the remaining materials', () => {
  fc.assert(fc.property(fc.array(fc.boolean(),{minLength:1,maxLength:40}).filter(flags=>flags.some(Boolean)),flags=>{
    const d=detail(flags.map((_,index)=>line(index+1))),before=JSON.stringify(d);
    const result=planSpecialLocalAdjustment(d,{lines:flags.map((remove,index)=>({caseLineId:index+1,remove,quantity:2}))});
    assert.deepEqual(result.lines.map(c=>c.caseLineId),flags.flatMap((remove,index)=>remove?[index+1]:[]));
    assert.ok(result.lines.every(c=>c.remove===true)); assert.equal(JSON.stringify(d),before);
  }),{seed:261013,numRuns:150});
});
test('unstarted issued adjustments stay local; an already-started legacy plan is recovered', () => {
  assert.equal(specialAdjustmentIsLocal({mode:'issued',status:'pending'}),true);
  assert.equal(specialAdjustmentIsLocal({mode:'issued',status:'attention',localOnly:true}),true);
  assert.equal(specialAdjustmentIsLocal({mode:'issued',remoteStarted:true}),false);
  assert.equal(specialAdjustmentIsLocal({mode:'draft'}),false);
});
test('a changed request UOM uses its new basis and new local pallets use the supplied fixed rate', () => {
  const result=planSpecialLocalAdjustment(detail([line(1)]),{lines:[{caseLineId:1,quantity:3,uom:'SQFT'}],palletTotal:2,palletRate:40});
  assert.equal(result.lines[0].toConversion,1);assert.equal(result.lines[0].toQuantity,3);
  assert.equal(result.lines[0].toFields.uom,'SQFT');assert.equal(result.lines[0].fromFields.uom,'PLT');
  assert.deepEqual(result.pallets,{fromQuantity:0,toQuantity:2,rate:40});
});
test('an unissued local PO draft preserves ancillary charges and issued PO snapshots while omitting archived material',()=>{
  const lines=[{caseLineId:1,quantity:7,description:'Old'},{caseLineId:2,quantity:2},{ancillary:true,itemId:1784,quantity:2}];
  const d={localAdjustedAt:'2026-10-13',lines:[{id:1,productName:'Current',color:'red'}],purchaseOrderLines:lines};
  const draft=specialLocalPurchaseDraft(d);
  assert.equal(draft.length,2);assert.equal(draft[0].quantity,7);assert.match(draft[0].description,/Current.*red/s);
  assert.equal(draft[1],lines[2]);assert.equal(lines[0].description,'Old');
  assert.equal(specialLocalPurchaseDraft({...d,purchaseOrderId:42}),lines);
  assert.equal(specialLocalPurchaseDraft({...d,purchaseOrderSkipped:true}),lines);
});
test('SCM approval of an issued request never invokes a NetSuite boundary', async () => {
  const calls=[];
  const d={salesOrderId:901,purchaseOrderId:902,quantityReview:{id:'r',mode:'issued',status:'applying',lines:[{caseLineId:1,remove:true}]}};
  const forbidden=async()=>{throw new Error('Unexpected NetSuite access');};
  const service=createSpecialQuantityService({withReviewLock:async(_id,run)=>run(),claimReview:async()=>d,
    resolveOrderUnits:forbidden,preparePlan:forbidden,applyPlan:forbidden,
    prepareAdjustmentPlan:forbidden,applyAdjustmentPlan:forbidden,savePlan:forbidden,
    finishReview:async(_id,input)=>{calls.push(input);return d;},failReview:forbidden});
  await service.reviewQuantityChange(1,{reviewId:'r',expectedRevision:1,decision:'approve'});
  assert.deepEqual(calls,[{reviewId:'r',verifiedOrderIds:[],verifiedOrders:[]}]);
});

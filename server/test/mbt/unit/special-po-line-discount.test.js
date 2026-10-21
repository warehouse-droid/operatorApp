import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import * as pricing from '../../../public/special-stock-purchase-pricing.js';
import { buildSpecialPurchaseOrderPayload } from '../../../src/special-stock-request-netsuite.js';

const review = lines => pricing.specialVendorLineDiscountReview ? pricing.specialVendorLineDiscountReview(lines) : pricing.specialVendorDiscountReview(lines,0);
const lines = () => [{caseLineId:1,itemId:2055,quantity:10,unitPurchaseCost:10,vendorDiscountPercent:10,discountPercent:90},
  {caseLineId:2,itemId:2055,quantity:5,unitPurchaseCost:20,vendorDiscountPercent:20,discountPercent:0}];
test('each vendor percentage stays private to its material, retaining gross costs and exact totals', () => {
  const r=review(lines());
  assert.equal(r.mode,'per_line');
  assert.deepEqual([r.grossTotal,r.amount,r.netTotal],[200,30,170]);
  assert.deepEqual(r.lines.map(l=>[l.unitPurchaseCost,l.grossUnitCost,l.vendorDiscountPercent,l.discountAmount,l.netTotal]),[[10,10,10,10,90],[20,20,20,20,80]]);
});
test('every material requires an explicit valid vendor percentage including zero', () => {
  for(const value of [undefined,null,'',false,' ',Infinity,-1,100.0001,'1.00001']) {
    assert.throws(()=>review([{...lines()[0],vendorDiscountPercent:value}]),{code:'SPECIAL_VENDOR_DISCOUNT_INVALID'});
  }
  assert.equal(review([{...lines()[0],vendorDiscountPercent:0}]).amount,0);
  assert.equal(review([{...lines()[0],vendorDiscountPercent:100}]).netTotal,0);
  assert.throws(()=>review([]),{code:'SPECIAL_VENDOR_DISCOUNT_INVALID'});
});
test('property: vendor percentages sum rounded cents exactly regardless of material order or SO percentages', () => {
  fc.assert(fc.property(fc.array(fc.record({gross:fc.integer({min:0,max:10000000}),pct:fc.integer({min:0,max:1000000})}),{minLength:1,maxLength:30}), entries=>{
    const source=entries.map((e,i)=>({caseLineId:i+1,quantity:1,unitPurchaseCost:e.gross/100,vendorDiscountPercent:e.pct/10000,discountPercent:99}));
    const discounts=entries.map(e=>Number((BigInt(e.gross)*BigInt(e.pct)+500000n)/1000000n));
    const total=entries.reduce((s,e)=>s+e.gross,0),discount=discounts.reduce((s,v)=>s+v,0),r=review(source);
    assert.equal(Math.round(r.amount*100),discount);
    assert.equal(Math.round(r.netTotal*100),total-discount);
    assert.deepEqual(r.lines.map(l=>Math.round(l.discountAmount*100)),discounts);
    assert.deepEqual(r.lines.map(l=>l.unitPurchaseCost),source.map(l=>l.unitPurchaseCost));
    assert.equal(review(source.toReversed()).amount,r.amount);
  }),{seed:2026092801,numRuns:300});
});
test('new PO payload appends one summed purchase discount; legacy net costs and zero discounts stay intact', () => {
  const input={caseId:67,vendorId:331,netsuiteLocationId:1,lines:lines()},r=review(input.lines);
  const p=buildSpecialPurchaseOrderPayload({...input,vendorDiscountReview:r});
  assert.equal(p.item.items.length,3);
  assert.deepEqual(p.item.items.map(l=>[Number(l.item.id),l.quantity,l.rate]),[[2055,10,10],[2055,5,20],[4981,1,-30]]);
  assert.match(p.item.items.at(-1).description,/MBBS-SPECIAL-PO:67/);
  assert.equal(buildSpecialPurchaseOrderPayload({...input,vendorDiscountReview:{amount:30}}).item.items.length,2);
  assert.equal(buildSpecialPurchaseOrderPayload({...input,vendorDiscountReview:review(input.lines.map(l=>({...l,vendorDiscountPercent:0})))}).item.items.length,2);
  assert.throws(()=>buildSpecialPurchaseOrderPayload({...input,vendorDiscountReview:{...r,lines:r.lines.slice(1)}}),{code:'SPECIAL_VENDOR_DISCOUNT_INVALID'});
});


test('property: a missing or out-of-range percentage never silently becomes a zero discount',()=>{
  fc.assert(fc.property(fc.oneof(fc.integer({min:-10000,max:-1}),fc.integer({min:101,max:10000}),fc.constantFrom(undefined,null,'',' ',false)),pct=>{
    assert.throws(()=>review([{...lines()[0],vendorDiscountPercent:pct}]),{code:'SPECIAL_VENDOR_DISCOUNT_INVALID'});
  }),{seed:2026092802,numRuns:100});
});

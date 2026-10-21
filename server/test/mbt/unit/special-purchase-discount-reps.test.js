import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { specialVendorDiscountReview } from '../../../public/special-stock-purchase-pricing.js';
import { createSpecialSalesRepDirectory } from '../../../src/special-stock-sales-reps.js';
import { specialLineSubtotal } from '../../../public/special-stock-pricing.js';

const lines = () => [{ caseLineId: 1, quantity: 10, unitPurchaseCost: 10 }, { caseLineId: 2, quantity: 5, unitPurchaseCost: 20 }];
test('vendor discount is explicit, independent of Sales, bounded and applied to net PO costs', () => {
  const review = specialVendorDiscountReview(lines(), '30.00');
  assert.deepEqual([review.amount,review.grossTotal,review.netTotal], [30,200,170]);
  assert.deepEqual(review.lines.map(l => [l.grossUnitCost,l.unitPurchaseCost,l.discountAmount]), [[10,8.5,15],[20,17,15]]);
  assert.deepEqual(specialVendorDiscountReview(lines(), 0).lines.map(l => l.unitPurchaseCost), [10,20]);
  assert.deepEqual(specialVendorDiscountReview(lines(), 200).lines.map(l => l.unitPurchaseCost), [0,0]);
  for (const amount of [undefined,null,'',false,-1,201,'1.001',Infinity]) assert.throws(() => specialVendorDiscountReview(lines(), amount), { code:'SPECIAL_VENDOR_DISCOUNT_INVALID' });
});
test('property: vendor allocation preserves the confirmed total to the cent, without negative costs', () => {
  fc.assert(fc.property(fc.array(fc.integer({min:1,max:100000}), {minLength:1,maxLength:20}), fc.integer({min:0,max:100}), (gross,percent) => {
    const totalCents = gross.reduce((sum,n) => sum+n,0), discount = Math.floor(totalCents*percent/100);
    const review = specialVendorDiscountReview(gross.map((cost,i) => ({caseLineId:i+1,quantity:1,unitPurchaseCost:cost/100})),discount/100);
    assert.equal(Math.round(review.netTotal*100), totalCents-discount);
    assert.equal(review.lines.reduce((sum,l)=>sum+Math.round(l.discountAmount*100),0),discount);
    assert.equal(review.lines.reduce((sum,l)=>sum+Math.round(specialLineSubtotal(l.quantity,l.unitPurchaseCost)*100),0),totalCents-discount);
    assert.ok(review.lines.every(l=>l.unitPurchaseCost>=0 && l.unitPurchaseCost<=l.grossUnitCost));
  }), {seed:20260928,numRuns:250});
});
test('vendor allocation rejects unrepresentable unit-cost rounding rather than changing the confirmed total', () => {
  assert.throws(()=>specialVendorDiscountReview([{caseLineId:1,quantity:1000000,unitPurchaseCost:1}],0.01),{code:'SPECIAL_VENDOR_DISCOUNT_ROUNDING'});
});
test('Sales Rep directory queries active NetSuite reps and rejects missing, unknown and inactive selections', async () => {
  let calls=0;
  const directory=createSpecialSalesRepDirectory({queryAll:async sql=>{
    calls++;assert.match(sql,/issalesrep\s*=\s*'T'/i);assert.match(sql,/isinactive\s*=\s*'F'/i);
    return [{id:'123',name:'TEST Rep A'},{id:'456',name:'TEST Rep B'}];
  }});
  assert.deepEqual(await directory.list(),[{id:123,name:'TEST Rep A'},{id:456,name:'TEST Rep B'}]);
  assert.deepEqual(await directory.select(456),{id:456,name:'TEST Rep B'});
  for(const value of [undefined,'',0,'123 OR 1=1',999]) await assert.rejects(directory.select(value),{code:'SPECIAL_SALES_REP_REQUIRED'});
  assert.ok(calls>=2);
});

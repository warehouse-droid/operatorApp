import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {purchaseReviewQuantity,allocatePurchaseQuantity} from '../../../src/regular-stock-purchase-domain.js';
test('upward rounding never loses requested quantity or adds an unnecessary whole pallet',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:100000}),fc.integer({min:1,max:1000}),(quantity,conversion)=>{
    const result=purchaseReviewQuantity(quantity,conversion);
    assert(result.approvedQuantity>=quantity);
    assert(result.approvedQuantity-quantity<conversion);
    assert(Number.isInteger(result.approvedPallets));
  }),{seed:20260930,numRuns:500});
});
test('allocation conserves both demand and actual receipt, including zero capacity',()=>{
  fc.assert(fc.property(fc.array(fc.integer({min:1,max:100}),{maxLength:20}),fc.integer({min:0,max:1000}),fc.integer({min:0,max:1000}),(quantities,capacity,received)=>{
    const result=allocatePurchaseQuantity(quantities.map((remaining,id)=>({id,remaining})),capacity,received);
    const total=Math.min(capacity,quantities.reduce((sum,q)=>sum+q,0));
    assert.equal(result.reduce((sum,row)=>sum+row.quantity,0),total);
    assert.equal(result.reduce((sum,row)=>sum+row.received,0),Math.min(total,received));
    for(const row of result) {
      assert(row.quantity<=quantities[row.demandId]);assert(row.received<=row.quantity);
      const earlier=quantities.slice(0,row.demandId).reduce((sum,q)=>sum+q,0);
      assert.equal(row.quantity,Math.min(quantities[row.demandId],Math.max(0,capacity-earlier)));
      assert.equal(row.received,Math.min(row.quantity,Math.max(0,received-earlier)));
    }
  }),{seed:20260930,numRuns:500});
});
test('a micro-unit above a pallet boundary still rounds upward',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:100}),fc.integer({min:1,max:1000}),(pallets,conversion)=>{
    const quantity=pallets*conversion+0.000001;
    assert.equal(purchaseReviewQuantity(quantity,conversion).approvedPallets,pallets+1);
  }),{seed:20260931,numRuns:500});
});
test('SCM review retains both independent quantities and rounds using the reviewed value',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:100000}),fc.integer({min:1,max:100000}),fc.integer({min:1,max:1000}),(requested,reviewed,conversion)=>{
    const result=purchaseReviewQuantity(requested,conversion,reviewed);
    assert.equal(result.requestedQuantity,requested);assert.equal(result.reviewedQuantity,reviewed);
    assert(result.approvedQuantity>=reviewed);assert(result.approvedQuantity-reviewed<conversion);
  }),{seed:20260932,numRuns:500});
});

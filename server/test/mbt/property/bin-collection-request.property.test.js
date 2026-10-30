import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {calculateBinOrderChange} from '../../../src/mbt/bin-order-change.js';
import {calculateGarbageDumpCharge} from '../../../src/mbt/customer-charge-calculator.js';
import {isBinOverdue} from '../../../src/mbt/frontdesk-bin-overdue.js';
function price(amount,deposit) {return {paymentCategory:'cash',requiredDepositMinor:deposit,lines:[{
  lineCode:'rental',lineType:'bin_rental',label:'Bin rental',configuredAmountMinor:amount,customerAmountMinor:amount,
  preTaxAmountMinor:amount,includedHstMinor:0,addedHstMinor:0}]};}
test('properties: price differences and deposit credits reverse exactly and preserve unrelated contract charges',()=>{
  fc.assert(fc.property(fc.integer({min:0,max:10000000}),fc.integer({min:0,max:10000000}),fc.integer({min:0,max:1000000}),
    fc.integer({min:0,max:1000000}),fc.integer({min:0,max:1000000}),(a,b,d,e,other)=>{
      const before=price(a,d),after=price(b,e),change=calculateBinOrderChange(before,after,a+other);
      assert.equal(change.newRequestChargeableMinor,b-a);assert.equal(change.resultingContractTotalMinor,b+other);
      assert.equal(change.dueNowMinor,b-a+e-d);assert.equal(change.depositCreditMinor,Math.max(0,d-e));
      const reversed=calculateBinOrderChange(after,before,change.resultingContractTotalMinor);
      assert.equal(reversed.newRequestChargeableMinor,a-b);
      assert.equal(reversed.dueNowMinor,a-b+d-e);
      assert.equal(reversed.dueNowMinor+change.dueNowMinor,0);
    }),{numRuns:400,examples:[[0,0,0,0,0]]});
});
test('properties: overdue requires a delivered open bin strictly past its expected date',()=>{
  fc.assert(fc.property(fc.integer({min:-1000000,max:1000000}),fc.boolean(),fc.constantFrom('scheduled','active','return_due','closed','cancelled'),(delta,available,status)=>{
    const now=new Date('2030-01-01T00:00:00Z');
    assert.equal(isBinOverdue({status,binAvailableForService:available,plannedReturnAt:new Date(now.getTime()+delta).toISOString()},now),
      available && !['closed','cancelled'].includes(status) && delta<0);
  }),{numRuns:400});
});
test('properties: actual garbage tonnes use exact half-up cents and payment tax conservation',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:999999999}),fc.integer({min:1,max:100000}),fc.boolean(),(micro,rate,cash)=>{
    const weight=`${Math.floor(micro/1000000)}.${String(micro%1000000).padStart(6,'0')}`;
    const result=calculateGarbageDumpCharge(weight,rate,cash?'cash':'card');
    const expected=Number((BigInt(micro)*BigInt(rate)+500000n)/1000000n);
    assert.equal(result.configuredAmountMinor,expected);
    assert.equal(result.customerAmountMinor,result.preTaxAmountMinor+result.includedHstMinor+result.addedHstMinor);
    assert.equal(result.customerAmountMinor,cash?expected:expected+Math.floor((expected*1300+5000)/10000));
  }),{numRuns:400});
  for(const invalid of ['0','-1','NaN','1e3','1.1234567','100000']) assert.throws(()=>calculateGarbageDumpCharge(invalid,12000,'cash'));
});

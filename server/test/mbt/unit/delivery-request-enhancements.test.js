import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {normalizeDeliveryPricing,calculateDeliveryQuote,transitionDeliveryRequest} from '../../../src/delivery-request-domain.js';
import {pricing,request,sales,dispatcher,clock,graph,window} from '../support/delivery-request-fixtures.js';

test('reply preserves every workflow field for either team in every request state',()=>{
  for(const status of ['submitted','proposed','preapproved','confirmed','expired','cancelled']) {
    for(const [actor,audience] of [[sales,'sales'],[dispatcher,'dispatch']]) {
      const row=request({status,confirmedWindow:window(),pendingWindow:window({start:'13:00',end:'15:00'}),
        salesOrderRefs:['SO123'],approvalExpiresAt:'2028-09-01T12:00:00Z',reminderAt:'2028-09-01T11:00:00Z'});
      const next=transitionDeliveryRequest(row,'reply',{expectedRevision:1,message:'Can the driver call first?'},actor,audience,clock);
      assert.deepEqual(next,{...row,revision:2});
    }
  }
});
test('reply rejects blank, nontext, oversized, stale and unauthorized submissions',()=>{
  for(const message of ['', '  \n ', 'x'.repeat(2001),{},1,null,undefined]) {
    assert.throws(()=>transitionDeliveryRequest(request(),'reply',{expectedRevision:1,message},sales,'sales',clock),{code:'DELIVERY_REQUEST_INVALID'});
  }
  assert.throws(()=>transitionDeliveryRequest(request(),'reply',{expectedRevision:0,message:'Hi'},sales,'sales',clock),{code:'DELIVERY_STALE_REVISION'});
  assert.throws(()=>transitionDeliveryRequest(request(),'reply',{expectedRevision:1,message:'Hi'},{...sales,yardLocationIds:[28]},'sales',clock),{status:403});
});
test('full and loose POS persist separately, sum for trips, and reject malformed or contradictory totals',()=>{
  const input=pricing({outbounds:[{originYardCode:'3445',fullPosQty:25,loosePosQty:2,totalUnits:27}]});
  assert.deepEqual(normalizeDeliveryPricing(input).outbounds,input.outbounds);
  assert.equal(calculateDeliveryQuote(input,graph(),20000,clock.settings).trips,2);
  for(const yard of [
    {fullPosQty:0,loosePosQty:0,totalUnits:0},{fullPosQty:-1,loosePosQty:2,totalUnits:1},
    {fullPosQty:0.5,loosePosQty:1,totalUnits:1.5},{fullPosQty:1,loosePosQty:1,totalUnits:1},
    {fullPosQty:1,loosePosQty:'1',totalUnits:2},{fullPosQty:1,totalUnits:2}
  ]) {
    assert.throws(()=>normalizeDeliveryPricing(pricing({outbounds:[{originYardCode:'3445',...yard}]})),{code:'DELIVERY_REQUEST_INVALID'});
  }
});
const binPricing=(yards=14,aggregate='Gravel')=>pricing({loadType:'bin',totalUnits:yards,binTypeCode:'14YD',quantityUnit:'yard',aggregate,binCapacityYards:14});
test('BIN yard quantities use nominal size and retain aggregate and units in pricing evidence',()=>{
  for(const aggregate of ['Gravel','HPE','Screening','Crusher Run']) {
    const input=binPricing(14.01,aggregate),normalized=normalizeDeliveryPricing(input);
    assert.equal(normalized.aggregate,aggregate);assert.equal(normalized.quantityUnit,'yard');assert.equal(normalized.binCapacityYards,14);
    const quote=calculateDeliveryQuote(input,graph('bin'),20000,clock.settings);
    assert.equal(quote.capacityPerTrip,14);assert.equal(quote.trips,2);assert.equal(quote.totalAmountMinor,20000);
    assert.equal(calculateDeliveryQuote(binPricing(),graph('bin'),20000,clock.settings).trips,1);
  }
  for(const input of [binPricing(0),binPricing(-1),binPricing(0.001),binPricing(1,'Sand'),{...binPricing(),binCapacityYards:0}]) {
    assert.throws(()=>normalizeDeliveryPricing(input),{code:'DELIVERY_REQUEST_INVALID'});
  }
});
test('generated POS and BIN quantities retain exact capacity boundaries and normalization is idempotent',()=>{
  fc.assert(fc.property(fc.integer({min:0,max:5000}),fc.integer({min:0,max:5000}),fc.integer({min:1,max:10000}),(full,loose,capacity)=>{
    fc.pre(full+loose>0);
    const input=pricing({outbounds:[{originYardCode:'3445',fullPosQty:full,loosePosQty:loose,totalUnits:full+loose}]});
    const normalized=normalizeDeliveryPricing(input);
    assert.equal(normalized.outbounds[0].fullPosQty,full);assert.equal(normalized.outbounds[0].loosePosQty,loose);
    assert.deepEqual(normalizeDeliveryPricing(normalized),normalized);
    assert.equal(calculateDeliveryQuote(input,graph(),20000,{pos:capacity,bin:1}).trips,Math.ceil((full+loose)/capacity));
  }),{numRuns:150});
  fc.assert(fc.property(fc.integer({min:1,max:100000}),fc.integer({min:1,max:20}),(cents,bins)=>{
    const input=binPricing(cents/100),normalized=normalizeDeliveryPricing(input);
    assert.deepEqual(normalizeDeliveryPricing(normalized),normalized);assert.equal(normalized.totalUnits,cents/100);
    assert.equal(calculateDeliveryQuote(input,graph('bin'),20000,{pos:26,bin:bins}).trips,Math.ceil(cents/(1400*bins)));
  }),{numRuns:150});
});
test('fractional Yard quantities from paired yards do not add a spurious trip at an exact capacity boundary',()=>{
  const input={...binPricing(0.3),binCapacityYards:0.3,outbounds:[{originYardCode:'3445',totalUnits:0.1},{originYardCode:'2967',totalUnits:0.2}]};
  const quote=calculateDeliveryQuote(input,graph('bin'),20000,clock.settings);
  assert.equal(quote.trips,1);assert.equal(quote.outbounds[0].totalUnits,0.3);
});

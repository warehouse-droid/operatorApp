import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {calculateDeliveryQuote,calculateConsolidatedDeliveryQuote,transitionDeliveryRequest,deliveryApprovalDue,assertDeliveryYard} from '../../../src/delivery-request-domain.js';
import {pricing,graph,request,sales,dispatcher,clock} from '../support/delivery-request-fixtures.js';
const options={seed:5102026,numRuns:200};
test('time change: arbitrary valid proposals switch scheduling only on Dispatch acceptance and always preserve approval state',()=>{
  const time=minutes=>`${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
  fc.assert(fc.property(fc.integer({min:0,max:1319}),fc.integer({min:1,max:100000}),
    fc.uniqueArray(fc.integer({min:1,max:999999}),{minLength:1,maxLength:50}),(start,revision,numbers)=>{
      const row=request({status:'confirmed',revision,salesOrderRefs:numbers.map(number=>`SO${number}`),securedAt:clock.now,
        confirmedWindow:{date:'2028-10-10',start:'08:00',end:'09:00'}});
      const window={date:'2028-10-12',start:time(start),end:time(start+120),timeZone:'America/Toronto'};
      const pending=transitionDeliveryRequest(row,'request-time-change',{expectedRevision:revision,window},sales,'sales',clock);
      assert.deepEqual(pending,{...row,revision:revision+1,pendingWindow:window});
      assert.throws(()=>transitionDeliveryRequest(row,'request-time-change',{expectedRevision:revision,window:{...window,end:time(start+119)}},sales,'sales',clock),{code:'DELIVERY_REQUEST_INVALID'});
      const input={expectedRevision:pending.revision};
      const accepted=transitionDeliveryRequest(pending,'accept-time-change',input,dispatcher,'dispatch',clock);
      assert.deepEqual(accepted,{...row,revision:revision+2,confirmedWindow:window,pendingWindow:null});
      assert.throws(()=>transitionDeliveryRequest(pending,'accept-time-change',input,sales,'sales',clock),{status:403});
      for(const [action,actor,audience] of [['decline-time-change',dispatcher,'dispatch'],['withdraw-time-change',sales,'sales']]) {
        assert.deepEqual(transitionDeliveryRequest(pending,action,input,actor,audience,clock),{...row,revision:revision+2,pendingWindow:null});
      }
      const cancelled=transitionDeliveryRequest(pending,'cancel',input,sales,'sales',clock);
      assert.deepEqual(cancelled.salesOrderRefs,[]);assert.equal(cancelled.pendingWindow,null);assert.equal(cancelled.status,'cancelled');
      assert.deepEqual(cancelled.confirmedWindow,row.confirmedWindow);
    }),options);
});
test('linkage: replacement normalizes exactly the requested set and preserves approval at every revision',()=>{
  fc.assert(fc.property(fc.array(fc.integer({min:1,max:999999}),{minLength:1,maxLength:50}),
    fc.integer({min:1,max:100000}), (numbers,revision)=>{
      const row=request({status:'confirmed',revision,salesOrderRefs:['SOOLD'],securedAt:clock.now,
        confirmedWindow:{date:'2028-10-10',start:'08:00',end:'09:00'}});
      const refs=numbers.map(number=>` so${number} `);
      const next=transitionDeliveryRequest(row,'relink',{expectedRevision:revision,salesOrderRefs:refs},sales,'sales',clock);
      assert.deepEqual(next,{...row,revision:revision+1,salesOrderRefs:[...new Set(numbers.map(number=>`SO${number}`))]});
      assert.throws(()=>transitionDeliveryRequest(row,'relink',{expectedRevision:revision-1,salesOrderRefs:refs},sales,'sales',clock),{code:'DELIVERY_STALE_REVISION'});
      assert.throws(()=>transitionDeliveryRequest(row,'relink',{expectedRevision:revision,salesOrderRefs:[]},sales,'sales',clock),{code:'DELIVERY_REQUEST_INVALID'});
      assert.throws(()=>transitionDeliveryRequest(row,'relink',{expectedRevision:revision,salesOrderRefs:refs},dispatcher,'dispatch',clock),{status:403});
    }),options);
});
function expectedUnit(metres) {
  if(metres<=30000) {return 23500;}
  if(metres<=50000) {return 28500;}
  if(metres<=65000) {return 33500;}
  if(metres<=75000) {return 38500;}
  return 38500+Number((BigInt(metres-75000)*700n+500n)/1000n);
}
test('trip rounding and integer-cent totals equal an independent integer oracle',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:1000000}),fc.integer({min:1,max:100}),fc.integer({min:0,max:1000000}),(quantity,capacity,metres)=>{
    const result=calculateDeliveryQuote(pricing({totalUnits:quantity}),graph(),metres,{pos:capacity,bin:1});
    const trips=Number((BigInt(quantity)+BigInt(capacity)-1n)/BigInt(capacity));
    assert.equal(result.trips,trips);assert.equal(result.totalAmountMinor,trips*expectedUnit(metres));
  }),options);
});
test('splitting quantities between 3445 and 2967 never adds trips or charges',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:100000}),fc.integer({min:1,max:100000}),fc.integer({min:0,max:1000000}),(one,two,metres)=>{
    const input=pricing({outbounds:[{originYardCode:'3445',totalUnits:one},{originYardCode:'2967',totalUnits:two}]});
    const split=calculateDeliveryQuote(input,graph(),metres,{pos:26,bin:1});
    const combined=calculateDeliveryQuote(pricing({totalUnits:one+two}),graph(),metres,{pos:26,bin:1});
    assert.equal(split.trips,combined.trips);assert.equal(split.totalAmountMinor,combined.totalAmountMinor);assert.equal(split.outbounds.length,1);
  }),options);
});
test('consolidation total equals the minimum of both independently priced transfer-plus-delivery options',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:1000}),fc.integer({min:1,max:1000}),
    fc.array(fc.integer({min:0,max:200000}),{minLength:4,maxLength:4}),(one,two,distances)=>{
    const input=pricing({outbounds:[{originYardCode:'3445',totalUnits:one},{originYardCode:'12441',totalUnits:two}]});
    const routes=Object.fromEntries(['3445>12441','12441>3445','3445>customer','12441>customer'].map((key,index)=>[key,{providerMetres:distances[index]}]));
    const result=calculateConsolidatedDeliveryQuote(input,graph(),routes,{pos:26,bin:1});
    const deliveryTrips=Math.ceil((one+two)/26);
    const at3445=Math.ceil(two/26)*expectedUnit(distances[1])+deliveryTrips*expectedUnit(distances[2]);
    const at12441=Math.ceil(one/26)*expectedUnit(distances[0])+deliveryTrips*expectedUnit(distances[3]);
    assert.equal(result.totalAmountMinor,Math.min(at3445,at12441));
    assert.equal(result.totalAmountMinor,result.transferAmountMinor+result.deliveryAmountMinor);
  }),options);
});
function expectedBinUnit(metres) {
  if(metres<=30000) {return 10000;}
  if(metres<=50000) {return 15000;}
  if(metres<=65000) {return 20000;}
  if(metres<=75000) {return 25000;}
  return Number((BigInt(metres)*700n+500n)/1000n);
}
test('BIN transfer and delivery totals match both independent MBT alternatives at editable capacity',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:1000}),fc.integer({min:1,max:1000}),fc.integer({min:1,max:10}),
    fc.array(fc.integer({min:0,max:1000000}),{minLength:4,maxLength:4}),(one,two,capacity,distances)=>{
    const input=pricing({loadType:'bin',binTypeCode:'14YD',outbounds:[{originYardCode:'3445',totalUnits:one},{originYardCode:'12441',totalUnits:two}]});
    const routes=Object.fromEntries(['3445>12441','12441>3445','3445>customer','12441>customer'].map((key,index)=>[key,{providerMetres:distances[index]}]));
    const result=calculateConsolidatedDeliveryQuote(input,graph('bin'),routes,{pos:26,bin:capacity});
    const trips=quantity=>Number((BigInt(quantity)+BigInt(capacity)-1n)/BigInt(capacity));
    const at3445=trips(two)*expectedBinUnit(distances[1])+trips(one+two)*expectedBinUnit(distances[2]);
    const at12441=trips(one)*expectedBinUnit(distances[0])+trips(one+two)*expectedBinUnit(distances[3]);
    assert.equal(result.totalAmountMinor,Math.min(at3445,at12441));
    assert.equal(result.deliveryTrips,trips(one+two));
  }),options);
});
test('secure before the exact deadline stops the clock; deadline equality always rejects',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:24}),fc.integer({min:0,max:3599999}),(hours,offset)=>{
    const row=transitionDeliveryRequest(request(),'confirm',{expectedRevision:1},dispatcher,'dispatch',{...clock,settings:{...clock.settings,approvalHours:hours,reminderHours:0}});
    assert.equal(new Date(row.approvalExpiresAt)-new Date(clock.now),hours*3600000);
    const instant=new Date(new Date(row.approvalExpiresAt).getTime()-1-offset).toISOString();
    const secured=transitionDeliveryRequest(row,'secure',{expectedRevision:2,salesOrderRefs:['SO123']},sales,'sales',{now:instant});
    assert.equal(secured.approvalExpiresAt,null);assert.equal(secured.reminderAt,null);
    assert.equal(deliveryApprovalDue(secured,'2099-01-01T00:00:00Z'),null);
    assert.throws(()=>transitionDeliveryRequest(row,'secure',{expectedRevision:2,salesOrderRefs:['SO123']},sales,'sales',{now:row.approvalExpiresAt}),{code:'DELIVERY_APPROVAL_EXPIRED'});
  }),options);
});
test('private Sales yard access admits exactly assigned yards and always rejects public identities',()=>{
  fc.assert(fc.property(fc.uniqueArray(fc.constantFrom(1,28,15,26),{minLength:1,maxLength:4}),fc.constantFrom(1,28,15,26),(yards,yard)=>{
    const actor={...sales,yardLocationIds:yards};
    if(yards.includes(yard)) {assert.equal(assertDeliveryYard(actor,yard,'sales'),yard);}
    else {assert.throws(()=>assertDeliveryYard(actor,yard,'sales'),{status:403});}
    assert.throws(()=>assertDeliveryYard({...actor,publicSales:true},yard,'sales'),{status:403});
  }),options);
});

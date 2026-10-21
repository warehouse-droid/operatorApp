import assert from 'node:assert/strict';
import test from 'node:test';
import {waitlistQuantity,waitlistPoolBalance,waitlistTotals,rankWaitlistRequests,assertWaitlistSelectionPriority,waitlistReleaseEligibility,normalizeWaitlistFulfillment} from '../../../src/regular-waitlist-domain.js';

test('local waitlist quantity accepts SQFT decimals and rejects invalid/overflow input',()=>{
  assert.equal(waitlistQuantity('600.125'),600.125);
  for(const value of [0,-1,NaN,Infinity,'',null,'no',1000000001,0.0000001])assert.throws(()=>waitlistQuantity(value),error=>error.status===400);
});
test('PO pool subtracts held and converted quantities once and ignores returned allocations',()=>{
  assert.deepEqual(waitlistPoolBalance(5000,[{quantity:600,status:'reserved'},{quantity:400,status:'converting'},{quantity:1200,status:'committed'},{quantity:300,status:'released'}]),
    {capacityQty:5000,heldQty:1000,convertedQty:1200,availableQty:2800,deficitQty:0});
  assert.equal(waitlistPoolBalance(500,[{quantity:600,status:'committed'}]).deficitQty,100);
});
test('partial conversion and closure keep original demand accounting',()=>{
  assert.deepEqual(waitlistTotals({requested:1000,held:0,committed:600,closed:false}),{requestedQty:1000,heldQty:0,convertedQty:600,remainingQty:400,waitingQty:400,closedQty:0});
  assert.deepEqual(waitlistTotals({requested:1000,held:0,committed:600,closed:true}),{requestedQty:1000,heldQty:0,convertedQty:600,remainingQty:0,waitingQty:0,closedQty:400});
});
const rows=[
  {id:1,destinationLocationId:28,createdAt:'2026-01-01T00:00:00Z',waitlist:{waitingQty:100}},
  {id:2,destinationLocationId:1,createdAt:'2026-02-01T00:00:00Z',waitlist:{waitingQty:100}},
  {id:3,destinationLocationId:1,createdAt:'2026-01-15T00:00:00Z',waitlist:{waitingQty:100}}
];
test('yard preference ranks UNI/BWS and PER/TH independently of receiving yard',()=>{
  for(const sku of ['UNI-A','BWS-A'])assert.deepEqual(rankWaitlistRequests(rows,sku).map(row=>row.id),[3,2,1]);
  for(const sku of ['PER-A','TH-A'])assert.deepEqual(rankWaitlistRequests(rows,sku).map(row=>row.id),[1,3,2]);
  assert.deepEqual(rankWaitlistRequests(rows,'OTHER-A').map(row=>row.id),[1,3,2]);
});
test('passing higher priority or incompletely serving it requires a recorded override',()=>{
  const ranked=rankWaitlistRequests(rows,'UNI-A');
  assert.throws(()=>assertWaitlistSelectionPriority(ranked,[{requestId:1,quantity:20}],''),error=>error.code==='WAITLIST_PRIORITY_OVERRIDE_REQUIRED');
  assert.throws(()=>assertWaitlistSelectionPriority(ranked,[{requestId:3,quantity:60},{requestId:2,quantity:40}],''),error=>error.code==='WAITLIST_PRIORITY_OVERRIDE_REQUIRED');
  assert.equal(assertWaitlistSelectionPriority(ranked,[{requestId:3,quantity:100},{requestId:2,quantity:40}],''),false);
  assert.equal(assertWaitlistSelectionPriority(ranked,[{requestId:1,quantity:20}],'Customer confirmed; older customer unavailable'),true);
});
test('SCM release begins at thirty minutes and automatic release requires competing demand after three hours',()=>{
  const allocation={status:'reserved',allocatedAt:'2026-10-02T09:00:00Z'};
  const at=(time,competing=true)=>waitlistReleaseEligibility(allocation,{now:new Date('2026-10-02T'+time+'Z'),hasCompetingDemand:competing});
  assert.equal(at('09:29:59').manualAllowed,false);
  assert.equal(at('09:30:00').manualAllowed,true);
  assert.equal(at('11:59:59').automaticAllowed,false);
  assert.equal(at('12:00:00').automaticAllowed,true);
  assert.equal(at('13:00:00',false).automaticAllowed,false);
  assert.equal(at('13:00:00',true).automaticAllowed,true);
  for(const status of ['converting','committed','released'])assert.equal(waitlistReleaseEligibility({...allocation,status},{now:new Date('2026-10-03'),hasCompetingDemand:true}).automaticAllowed,false);
});
test('Pickup and Delivery conversion require only method and a valid delivery date',()=>{
  assert.equal(normalizeWaitlistFulfillment({fulfillmentMethod:'pickup'}).fulfillmentMethod,'pickup');
  const details=normalizeWaitlistFulfillment({fulfillmentMethod:'delivery',deliveryDate:'2099-02-01',deliveryAddress:'Ignored',windowStart:'12:00',windowEnd:'09:00'});
  assert.deepEqual(details,{fulfillmentMethod:'delivery',deliveryDate:'2099-02-01'});
  assert.deepEqual(normalizeWaitlistFulfillment({fulfillmentMethod:'pickup',deliveryDate:'bad'}),{fulfillmentMethod:'pickup',deliveryDate:null});
  for(const input of [{fulfillmentMethod:'delivery'},{fulfillmentMethod:'delivery',deliveryDate:'2099-02-30'},
    {fulfillmentMethod:'delivery',deliveryDate:'bad'},{fulfillmentMethod:'unknown'}])assert.throws(()=>normalizeWaitlistFulfillment(input),error=>error.status===400);
});

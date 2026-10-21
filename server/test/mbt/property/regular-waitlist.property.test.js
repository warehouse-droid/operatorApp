import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {waitlistPoolBalance,waitlistTotals,rankWaitlistRequests,waitlistReleaseEligibility} from '../../../src/regular-waitlist-domain.js';
const options={seed:261002,numRuns:400};
test('property: pool accounting conserves both unused and consumed quantity',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:1000000}),fc.nat(1000000),fc.nat(1000000),(capacity,held,converted)=>{
    const result=waitlistPoolBalance(capacity,[{quantity:held,status:'reserved'},{quantity:converted,status:'committed'},{quantity:99,status:'released'}]);
    assert.equal(result.availableQty,Math.max(0,capacity-held-converted));
    assert.equal(result.heldQty,held);assert.equal(result.convertedQty,converted);
    assert.equal(result.deficitQty,Math.max(0,held+converted-capacity));
  }),options);
});
test('property: remaining demand survives partial conversion and closes without returning converted quantity',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:100000}),fc.nat(100000),(requested,number)=>{
    const committed=number%(requested+1),open=waitlistTotals({requested,held:0,committed,closed:false}),closed=waitlistTotals({requested,held:0,committed,closed:true});
    assert.equal(open.waitingQty+open.convertedQty,requested);
    assert.equal(closed.closedQty+closed.convertedQty,requested);assert.equal(closed.waitingQty,0);
  }),options);
});
test('property: automatic release is exactly the mature reserved competing-demand predicate',()=>{
  fc.assert(fc.property(fc.nat(25000000),fc.boolean(),fc.constantFrom('reserved','converting','committed','released'),(age,competitor,status)=>{
    const result=waitlistReleaseEligibility({status,allocatedAt:new Date(0).toISOString()},{now:new Date(age),hasCompetingDemand:competitor});
    assert.equal(result.manualAllowed,status==='reserved'&&age>=1800000);
    assert.equal(result.automaticAllowed,status==='reserved'&&age>=10800000&&competitor);
  }),options);
});
test('property: UNI sorting preserves age within each selling-yard priority group',()=>{
  fc.assert(fc.property(fc.array(fc.record({age:fc.nat(1000000),preferred:fc.boolean()}),{minLength:1,maxLength:30}),entries=>{
    const rows=entries.map((entry,index)=>({id:index+1,createdAt:new Date(entry.age).toISOString(),destinationLocationId:entry.preferred?1:28}));
    const result=rankWaitlistRequests(rows,'UNI-TEST');
    const expected=[...rows].sort((a,b)=>(a.destinationLocationId===1?0:1)-(b.destinationLocationId===1?0:1)||Date.parse(a.createdAt)-Date.parse(b.createdAt)||a.id-b.id);
    assert.deepEqual(result.map(row=>row.id),expected.map(row=>row.id));
  }),options);
});

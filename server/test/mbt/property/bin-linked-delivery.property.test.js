import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {expandLinkedBinLoads} from '../../../src/mbt/bin-linked-delivery-planning.js';
const link={collectionId:'collect',deliveryId:'deliver',collectionReference:'BIN1C',deliveryReference:'BIN2D',
  collectionAssetId:'same-bin',deliveryAssetId:'same-bin',deliveryRevision:7,deliveryStatus:'ready'};
test('linked property: expanding arbitrary surrounding visits preserves them and includes the receiving leg exactly once',()=>{
  fc.assert(fc.property(fc.uniqueArray(fc.integer({min:0,max:100}),{maxLength:20}),fc.nat(20),fc.boolean(),(numbers,index,explicit)=>{
    const visits=numbers.map(n=>({visitId:`other-${n}`,expectedVisitRevision:1,stopOverrides:[],stopTimings:[]}));
    const at=Math.min(index,visits.length);visits.splice(at,0,{visitId:'collect',expectedVisitRevision:3,stopOverrides:[],stopTimings:[]});
    if(explicit) visits.splice(at+1,0,{visitId:'deliver',expectedVisitRevision:7,stopOverrides:[{sequence:1,minutes:12}],stopTimings:[]});
    const input=[{id:'load',visits}],before=structuredClone(input),result=expandLinkedBinLoads(input,[link]);
    assert.deepEqual(input,before);assert.deepEqual(expandLinkedBinLoads(result,[link]),result);
    const ids=result[0].visits.map(v=>v.visitId);assert.equal(ids.filter(id=>id==='deliver').length,1);
    assert.equal(ids.indexOf('deliver'),ids.indexOf('collect')+1);
    assert.deepEqual(result[0].visits.filter(v=>v.visitId.startsWith('other-')),before[0].visits.filter(v=>v.visitId.startsWith('other-')));
    if(explicit) assert.deepEqual(result[0].visits.find(v=>v.visitId==='deliver'),before[0].visits.find(v=>v.visitId==='deliver'));
  }),{seed:3445,numRuns:150});
});
test('linked property: every receiving-first or split-load route is rejected',()=>{
  fc.assert(fc.property(fc.boolean(),fc.nat(30),(split,n)=>{
    const others=Array.from({length:n},(_,i)=>({visitId:`other-${i}`}));
    const input=split ? [{id:'a',visits:[{visitId:'collect'},...others]},{id:'b',visits:[{visitId:'deliver'}]}]
      : [{id:'a',visits:[{visitId:'deliver'},...others,{visitId:'collect'}]}];
    assert.throws(()=>expandLinkedBinLoads(input,[link]),/same load|after.*collection/i);
  }),{seed:150,numRuns:100});
});
test('linked route invariants reject a changed bin, unavailable receiving order or isolated delivery',()=>{
  const loads=[{id:'load',visits:[{visitId:'collect'}]}];
  for(const change of [{deliveryAssetId:'wrong-bin'},{deliveryStatus:'completed'},{deliveryStatus:'cancelled'}]) {
    assert.throws(()=>expandLinkedBinLoads(loads,[{...link,...change}]),/changed/i);
  }
  assert.throws(()=>expandLinkedBinLoads([{id:'load',visits:[{visitId:'deliver'}]}],[link]),/linked collection/i);
  assert.deepEqual(expandLinkedBinLoads(loads,[]),loads);
});

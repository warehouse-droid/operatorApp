import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {normalizeBinCargo,binCargoSteps} from '../../../src/mbt/bin-cargo-domain.js';
test('cargo property: every material is picked once before its drop, without losing weight or physical actions',()=>{
  fc.assert(fc.property(fc.array(fc.record({weightLbs:fc.integer({min:1,max:10000}),separate:fc.boolean()}),{minLength:1,maxLength:20}),rows=>{
    const destination={kind:'customer_site',id:'customer',address:'100 Main St'};
    const cargo=normalizeBinCargo({mode:'materials',materials:rows.map((row,i)=>({description:`Material ${i}`,weightLbs:row.weightLbs,
      pickup:{kind:'address',address:`${i+1} Quarry Rd`},dropoff:row.separate?{kind:'address',address:`${i+1} Drop Rd`}:{kind:'destination'}}))},
    {orderedMaterials:[],yards:[],destination});
    const base=[{actionCode:'collect_empty_bin',location:{address:'Yard'}},{actionCode:'deliver_bin',location:destination}];
    const steps=binCargoSteps(base,cargo);
    assert.equal(steps[0].actionCode,'collect_empty_bin');assert.equal(steps.at(-1).actionCode,'deliver_bin');
    assert.equal(cargo.totalWeightLbs,rows.reduce((sum,r)=>sum+r.weightLbs,0));
    let weight=0;
    rows.forEach((row,i)=>{
      const pick=steps.findIndex(s=>s.actionCode===`cargo_pickup_${i+1}`);
      const drop=row.separate?steps.findIndex(s=>s.actionCode===`cargo_dropoff_${i+1}`):steps.length-1;
      assert.ok(pick>0 && pick<drop);weight+=row.weightLbs;
      assert.equal(steps[pick].cargoWeightLbs,weight);
    });
    assert.equal(steps.at(-1).cargoWeightLbs,0);
    assert.equal(steps.filter(s=>s.actionCode.startsWith('cargo_dropoff_')).length+steps.at(-1).cargoDropoffs.length,rows.length);
    assert.deepEqual(binCargoSteps(steps,cargo),steps);
  }),{numRuns:200,seed:231026});
});

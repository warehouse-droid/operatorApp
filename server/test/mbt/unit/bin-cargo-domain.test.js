import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeBinCargo, binCargoSteps} from '../../../src/mbt/bin-cargo-domain.js';
const yard={kind:'yard',id:'yard150',name:'150',yardCode:'150',address:'150 Clark Blvd'};
const site={kind:'customer_site',id:'site',name:'Customer',address:'1 Main St'};
const materials=[{itemCode:'GRAVEL',displayName:'Gravel',quantityMilliYards:1000,derivedWeightLbs:2600}];
const context={orderedMaterials:materials,yards:[yard],destination:site};
const gravel={itemCode:'GRAVEL',pickup:{kind:'yard',id:yard.id},dropoff:{kind:'destination'}};
const base=[{actionCode:'collect_empty_bin',location:yard,reference:'BIN00003D',stopKind:'pickup'},
  {actionCode:'deliver_bin',location:site,reference:'BIN00003D',stopKind:'drop',displayName:'Deliver bin'}];

test('cargo: purchased Gravel uses order identity/weight and the selected yard',()=>{
  const cargo=normalizeBinCargo({mode:'materials',materials:[{...gravel,weightLbs:1,description:'fake'}]},context);
  assert.equal(cargo.materials[0].weightLbs,2600);
  assert.equal(cargo.materials[0].description,'Gravel');
  assert.equal(cargo.materials[0].pickup.address,yard.address);
  assert.equal(cargo.materials[0].dropoff.address,site.address);
  assert.equal(cargo.totalWeightLbs,2600);
});
test('cargo: multiple different Front Desk materials remain together in one bin',()=>{
  const orderedMaterials=[...materials,{itemCode:'SAND',displayName:'Sand',quantityMilliYards:2000,derivedWeightLbs:4000}];
  const cargo=normalizeBinCargo({mode:'materials',materials:[gravel,{...gravel,itemCode:'SAND',pickup:{kind:'address',address:'5 Quarry St'}}]},
    {...context,orderedMaterials});
  assert.deepEqual(cargo.materials.map(m=>m.description),['Gravel','Sand']);assert.equal(cargo.totalWeightLbs,6600);
  const steps=binCargoSteps(base,cargo);assert.equal(steps.at(-1).cargoDropoffs.length,2);
  assert.equal(steps.filter(s=>s.actionCode.startsWith('cargo_pickup_')).length,2);
});
test('cargo: materials require pickup and purchased materials cannot be removed or mixed',()=>{
  assert.throws(()=>normalizeBinCargo({mode:'materials',materials:[{...gravel,pickup:null}]},context),/pickup/i);
  assert.throws(()=>normalizeBinCargo({mode:'none'},context),/ordered|purchased/i);
  assert.throws(()=>normalizeBinCargo({mode:'custom',custom:{source:'one_off',description:'Pallet',weightLbs:10,pickup:gravel.pickup,dropoff:gravel.dropoff}},context),/material/i);
});
test('cargo: manual materials may use different pickups and separate drops',()=>{
  const cargo=normalizeBinCargo({mode:'materials',materials:[
    {...gravel,itemCode:undefined,description:'Gravel',weightLbs:100},
    {description:'Sand',weightLbs:200,pickup:{kind:'address',address:'2 Main St'},dropoff:{kind:'address',address:'3 Main St'}}
  ]},{...context,orderedMaterials:[]});
  const steps=binCargoSteps(base,cargo);
  assert.deepEqual(steps.map(s=>s.actionCode),['collect_empty_bin','cargo_pickup_1','cargo_pickup_2','cargo_dropoff_2','deliver_bin']);
  assert.deepEqual(steps.filter(s=>s.cargoWeightLbs!==undefined).map(s=>s.cargoWeightLbs),[100,300,100,0]);
  assert.equal(steps[1].location.address,yard.address);
  assert.equal(steps.at(-1).cargoDropoffs[0].description,'Gravel');
  assert.equal(base.length,2);
});
test('cargo: exactly one custom order, existing or one-off, excludes materials',()=>{
  const custom={source:'one_off',description:'Equipment',weightLbs:500,pickup:gravel.pickup,dropoff:gravel.dropoff};
  const empty={...context,orderedMaterials:[]};
  assert.equal(normalizeBinCargo({mode:'custom',custom},empty).totalWeightLbs,500);
  assert.throws(()=>normalizeBinCargo({mode:'custom',custom:[custom,custom]},empty),/one custom/i);
  assert.throws(()=>normalizeBinCargo({mode:'custom',custom,materials:[gravel]},empty),/material/i);
  assert.throws(()=>normalizeBinCargo({mode:'materials',materials:[gravel],custom},empty),/custom/i);
  const existing={id:'12',refNumber:'CUS12',orderDetails:'Machine',weightLbs:1000,pickupLocation:'4 Main St',dropoffLocation:'5 Main St'};
  const cargo=normalizeBinCargo({mode:'custom',custom:{...custom,source:'existing',orderId:'12'}},{...empty,customOrder:existing});
  assert.equal(cargo.custom.description,'CUS12 · Machine');assert.equal(cargo.totalWeightLbs,1000);
});
test('cargo: hostile and unbounded inputs fail closed',()=>{
  const empty={...context,orderedMaterials:[]};
  for(const weightLbs of [0,-1,Infinity,NaN,1000001]) assert.throws(()=>normalizeBinCargo({mode:'materials',materials:[{...gravel,itemCode:null,description:'Sand',weightLbs}]},empty),/weight/i);
  assert.throws(()=>normalizeBinCargo({mode:'materials',materials:[{...gravel,pickup:{kind:'address',address:'\u0000'}}]},context),/address/i);
  assert.throws(()=>normalizeBinCargo({mode:'materials',materials:[{...gravel,pickup:{kind:'yard',id:'missing'}}]},context),/yard/i);
  assert.throws(()=>normalizeBinCargo({mode:'materials',materials:Array(21).fill(gravel)},context),/20/i);
});
test('cargo: return pickups follow dumping and keep the physical bin actions',()=>{
  const cargo=normalizeBinCargo({mode:'materials',materials:[gravel]},context);
  const collect=[{actionCode:'pickup_bin',location:site},{actionCode:'dump_bin',location:yard},
    {actionCode:'return_bin',location:yard,reference:'BIN00003-R',displayName:'Return bin'}];
  const result=binCargoSteps(collect,cargo);
  assert.deepEqual(result.map(s=>s.actionCode),['pickup_bin','dump_bin','cargo_pickup_1','return_bin']);
  assert.throws(()=>binCargoSteps(collect.slice(0,2),cargo),/receiving delivery/i);
});

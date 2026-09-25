import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
const {WARDS,wardLabel,routeAdditions}=await import(process.env.FIELD_SALES_PLANNER_MODULE||'../../public/field-sales/planner-data.js');

test('ward names cover all 25 City wards and normalize existing ward numbers',()=>{
  assert.equal(WARDS.length,25);assert.equal(new Set(WARDS.map(([id])=>id)).size,25);
  assert.equal(wardLabel({ward:'1'}),'01 · Etobicoke North');assert.equal(wardLabel({ward:'25'}),'25 · Scarborough-Rouge Park');
  assert.equal(wardLabel({ward:'12'}),"12 · Toronto-St. Paul's");assert.equal(wardLabel({}), '');assert.equal(wardLabel({ward:'99'}),'Ward 99');assert.equal(wardLabel({ward_name:'Imported ward'}),'Imported ward');
});
test('bulk additions skip equivalent jobsite addresses and retain distinct application addresses',()=>{
  const before=[{jobsiteId:'a',address:'90 BELFIELD ROAD',status:'completed',visitId:'kept'}],snapshot=structuredClone(before);
  const input=[{id:'a',address:' 90  Belfield Road '},{id:'a',address:'100 Belfield Road'},{id:'a',address:'100 BELFIELD ROAD'},{id:'b',address:'90 Belfield Road'}];
  assert.deepEqual(routeAdditions(before,input),[input[1],input[3]]);assert.deepEqual(before,snapshot);assert.equal(input.length,4);
});
test('250 is inclusive and larger selections fail before changing route or input',()=>{
  const stops=Array.from({length:249},(_,i)=>({jobsiteId:`s${i}`,address:'A'})),site={id:'new',address:'B'};
  assert.deepEqual(routeAdditions(stops,[site]),[site]);assert.throws(()=>routeAdditions(stops,[site,{id:'extra',address:'C'}]),/250/);assert.equal(stops.length,249);
  assert.deepEqual(routeAdditions([...stops,{jobsiteId:site.id,address:site.address}],[site]),[]);
});
test('bulk selection is idempotent, preserves order and includes every missing jobsite',()=>{
  fc.assert(fc.property(fc.uniqueArray(fc.integer({min:0,max:1000}),{maxLength:100}),fc.uniqueArray(fc.integer({min:0,max:1000}),{maxLength:100}),(existing,selected)=>{
    const stops=existing.map(id=>({jobsiteId:String(id),address:`${id} Road`})),sites=selected.map(id=>({id:String(id),address:`${id} Road`}));
    const additions=routeAdditions(stops,sites);
    assert.deepEqual(additions.map(s=>Number(s.id)),selected.filter(id=>!existing.includes(id)));
    assert.deepEqual(routeAdditions([...stops,...additions.map(s=>({jobsiteId:s.id,address:s.address}))],sites),[]);
  }),{seed:20260919,numRuns:200});
});

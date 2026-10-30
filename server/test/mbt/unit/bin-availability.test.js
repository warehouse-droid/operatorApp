import test from 'node:test';
import assert from 'node:assert/strict';
import {plannedBinAvailability} from '../../../src/mbt/bin-availability-domain.js';

const yard={kind:'yard',id:'3445',address:'3445 Kennedy Road'};
const laterYard={kind:'yard',id:'150',address:'150 Yard'};
const actual={empty:true,location:yard};
const at=minute=>new Date(Date.UTC(2026,9,21,14,minute)).toISOString();
const work=(id,start,finish,release=null)=>({id,reference:`BIN${id}C`,start:at(start),finish:at(finish),release,truckId:'T1'});

test('projected bin: draft return makes a customer bin available at its planned yard and time',()=>{
  const result=plannedBinAvailability({actual:{empty:false,location:{kind:'customer_site',id:'customer'}},
    work:[work('first',0,30,laterYard)],at:at(40),until:at(55)});
  assert.equal(result.available,true);assert.equal(result.projected,true);
  assert.deepEqual(result.location,laterYard);assert.equal(result.predecessorId,'first');assert.equal(result.availableAt,at(30));
});
test('projected bin: an overlapping or too-early pickup remains unavailable',()=>{
  for(const minute of [0,10,29]) assert.equal(plannedBinAvailability({actual,work:[work('first',0,30,yard)],at:at(minute),until:at(45)}).available,false);
  assert.equal(plannedBinAvailability({actual,work:[work('first',20,30,yard)],at:at(10),until:at(25)}).available,false);
});
test('projected bin: exact return boundary is available, but a later reservation must not overlap',()=>{
  const jobs=[work('first',0,30,yard),work('second',50,60,null)];
  assert.equal(plannedBinAvailability({actual,work:jobs,at:at(30),until:at(50)}).available,true);
  assert.equal(plannedBinAvailability({actual,work:jobs,at:at(30),until:at(51)}).available,false);
  assert.equal(plannedBinAvailability({actual,work:jobs,at:at(61)}).available,false);
});
test('projected bin: unplanned/unknown release blocks and incompatible projected truck blocks',()=>{
  assert.equal(plannedBinAvailability({actual,work:[{id:'legacy',start:null,finish:null}],at:at(40)}).available,false);
  const jobs=[work('first',0,30,{kind:'truck',id:'T1',address:'Aboard T1'})];
  assert.equal(plannedBinAvailability({actual,work:jobs,at:at(40),truckId:'T2'}).available,false);
  assert.equal(plannedBinAvailability({actual,work:jobs,at:at(40),truckId:'T1'}).available,true);
});
test('projected bin: unrelated future customer placement blocks until a later planned collection returns',()=>{
  const jobs=[work('delivery',0,10,null),work('collection',30,40,yard)];
  assert.equal(plannedBinAvailability({actual,work:jobs,at:at(20)}).available,false);
  assert.equal(plannedBinAvailability({actual,work:jobs,at:at(40)}).available,true);
  assert.equal(plannedBinAvailability({actual:{empty:false,location:yard},work:[],at:at(40)}).available,false);
});
test('projected bin: inputs are immutable and permutation does not change chronology',()=>{
  const input={actual,work:[work('second',40,50,laterYard),work('first',0,20,yard)],at:at(55)};
  const before=structuredClone(input),result=plannedBinAvailability(input);
  assert.deepEqual(input,before);assert.equal(result.location.id,'150');
  assert.deepEqual(result,plannedBinAvailability({...input,work:[...input.work].reverse()}));
});
test('projected bin: selection may use a later return within the planning window, exact assignment still rejects early pickup',()=>{
  const input={actual:{empty:false,location:yard},work:[work('afternoon',60,120,laterYard)],at:at(0)};
  assert.equal(plannedBinAvailability({...input,latestPickupAt:at(150)}).available,true);
  assert.equal(plannedBinAvailability({...input,latestPickupAt:at(90)}).available,false);
  assert.equal(plannedBinAvailability({...input,at:at(119)}).available,false);
});
test('projected bin: unusable physical asset and overlapping saved work stay unavailable after projected return',()=>{
  assert.equal(plannedBinAvailability({actual:{...actual,unusable:true},work:[work('return',0,10,yard)],at:at(20)}).available,false);
  assert.equal(plannedBinAvailability({actual,work:[work('one',0,30,yard),work('two',20,40,laterYard)],at:at(50)}).available,false);
});

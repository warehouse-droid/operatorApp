import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {transportQuantity,transportQuantityText,allocateTransportLines,transportTripWeight,transportSourceKind} from '../../../src/mbt/bin-transport-domain.js';
import {plannedBinAvailability} from '../../../src/mbt/bin-availability-domain.js';
const options={numRuns:1000,seed:231026};
test('transport property: six-place quantities round-trip exactly, including zero and maximum',()=>{
  fc.assert(fc.property(fc.bigInt({min:0n,max:999999999999999n}),amount=>{
    const text=transportQuantityText(amount);
    assert.equal(transportQuantity(text,true),amount);
    if(amount>0n) assert.equal(transportQuantity(text),amount);else assert.throws(()=>transportQuantity(text));
  }),options);
});
test('transport property: every legal fractional allocation conserves quantity and every excess is rejected',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:100000}),fc.integer({min:1,max:100000}),fc.integer({min:0,max:100000}),(used,take,left)=>{
    const text=n=>transportQuantityText(BigInt(n)),total=used+take+left;
    const line={key:'a',quantity:text(total),itemId:'9909'};
    const result=allocateTransportLines([line],[{lineKey:'a',quantity:text(used)}],[{lineKey:'a',quantity:text(take)}])[0];
    assert.equal(result.quantity,text(take));assert.equal(result.remaining,text(left));assert.equal(result.sourceQuantity,text(total));
    assert.throws(()=>allocateTransportLines([line],[{lineKey:'a',quantity:text(used)}],[{lineKey:'a',quantity:text(take+left+1)}]));
    const exact=allocateTransportLines([line],[{lineKey:'a',quantity:text(used)}],[{lineKey:'a',quantity:text(take+left)}]);
    assert.equal(exact[0].remaining,'0');
  }),options);
});
test('transport property: known cargo is a lower bound, bin payload is an upper bound, and missing weight cannot be silently zero',()=>{
  fc.assert(fc.property(fc.integer({min:2,max:100000}),fc.integer({min:1,max:100000}),(known,extra)=>{
    const allocations=[{quantity:'1',sourceQuantity:'1',lineWeight:known},{quantity:'1',sourceQuantity:'1',lineWeight:0}];
    const capacity=known+extra;
    assert.equal(transportTripWeight({allocations,weightLbs:capacity,maximumPayloadLbs:capacity}),capacity);
    assert.throws(()=>transportTripWeight({allocations,weightLbs:known-1,maximumPayloadLbs:capacity}));
    assert.throws(()=>transportTripWeight({allocations,weightLbs:capacity+1,maximumPayloadLbs:capacity}));
    assert.throws(()=>transportTripWeight({allocations,maximumPayloadLbs:capacity}));
    assert.equal(transportTripWeight({allocations:allocations.slice(0,1),maximumPayloadLbs:capacity}),known);
  }),options);
});
test('transport property: saved return permits exactly later pickups and never mutates physical custody',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:600}),fc.integer({min:1,max:600}),(start,duration)=>{
    const at=minute=>new Date(Date.UTC(2026,9,21)+minute*60000).toISOString(),end=start+duration;
    const yard={kind:'yard',id:'3445'},actual={empty:false,location:{kind:'customer_site',id:'site'}};
    const work=[{id:'prior',reference:'BIN00002C',start:at(start),finish:at(end),release:yard}];
    const original=structuredClone({actual,work});
    for(const minute of [start-1,start,end-1]) assert.equal(plannedBinAvailability({actual,work,at:at(minute)}).available,false);
    const ready=plannedBinAvailability({actual,work,at:at(end),until:at(end+1)});
    assert.equal(ready.available,true);assert.equal(ready.projected,true);assert.equal(ready.predecessorId,'prior');assert.deepEqual(ready.location,yard);
    assert.equal(plannedBinAvailability({actual,work:[{...work[0],release:null}],at:at(end+1)}).available,false);
    assert.equal(plannedBinAvailability({actual:{...actual,unusable:true},work,at:at(end+1)}).available,false);
    assert.deepEqual({actual,work},original);
  }),options);
});
test('transport property: future collisions and wrong-truck custody reject while touching intervals remain legal',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:500}),fc.integer({min:1,max:500}),(start,length)=>{
    const at=n=>new Date(Date.UTC(2026,9,21)+n*60000).toISOString(),actual={empty:true,location:{kind:'truck',id:'truck-a'}};
    const work=[{id:'future',start:at(start),finish:at(start+length),release:{kind:'yard',id:'150'}}];
    assert.equal(plannedBinAvailability({actual,work,at:at(0),until:at(start),truckId:'truck-a'}).available,true);
    assert.equal(plannedBinAvailability({actual,work,at:at(0),until:at(start+1),truckId:'truck-a'}).available,false);
    assert.equal(plannedBinAvailability({actual,work:[],at:at(0),truckId:'truck-b'}).available,false);
    assert.equal(plannedBinAvailability({actual,work:[...work,{...work[0],id:'collision',start:at(start+length-1)}],at:at(start+length+1)}).available,false);
  }),options);
});
test('transport property: catalog identity controls loose material routing, independent of display names',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:999999}),fc.string({maxLength:80}),(id,name)=>{
    const order={id:'SO001',type:'SO',items:[{itemId:id,itemName:name}]};
    assert.equal(transportSourceKind(order,new Set([String(id)])),'aggregate');
    assert.equal(transportSourceKind(order,new Set([String(id+1)])),null);
    assert.equal(transportSourceKind({...order,type:'BIN'},new Set([String(id)])),null);
  }),options);
});

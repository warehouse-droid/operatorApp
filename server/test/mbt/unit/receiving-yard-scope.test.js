import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { receivingOrderYards, scopeReceivingOrderYard } from '../../../src/receiving-yard-scope.js';

const yards=[1,28,15,26];
const names={1:'3445',28:'2967',15:'12441',26:'150'};
const order={order_type:'purchase_order',destination_location_id:28,destination_location:'2967',
  lines:[{id:1,location_id:28,netsuite_active:true},{id:2,location_id:1,netsuite_active:true}]};

test('line yards determine scope while receipt builders retain rows to explicitly skip',()=>{
  assert.deepEqual(receivingOrderYards(order),[28,1]);
  const selected=scopeReceivingOrderYard({...order,receivableLines:order.lines},1);
  assert.equal(selected.destination_location_id,1);
  assert.equal(selected.destination_location,'3445');
  assert.deepEqual(selected.lines.map(line=>line.id),[2]);
  assert.deepEqual(selected.receivableLines.map(line=>line.id),[2]);
  const posting=scopeReceivingOrderYard({...order,receivableLines:order.lines},1,{keepAllLines:true});
  assert.deepEqual(posting.lines,order.lines);
  assert.deepEqual(posting.receivableLines.map(line=>line.id),[2]);
  assert.equal(order.destination_location_id,28);
});

test('missing locations inherit the header and overrides retain their authority',()=>{
  const legacy={...order,lines:[{id:3,location_id:null,netsuite_active:true}]};
  assert.deepEqual(receivingOrderYards(legacy),[28]);
  assert.equal(scopeReceivingOrderYard(legacy,28).lines.length,1);
  assert.deepEqual(receivingOrderYards({...order,destination_override:'3445'}),[1]);
  assert.equal(scopeReceivingOrderYard({...order,destination_override:'3445'},1).lines.length,2);
  assert.throws(()=>scopeReceivingOrderYard({...order,destination_override:'3445'},28),{status:403});
  assert.deepEqual(receivingOrderYards({...order,lines:[]}),[28]);
});

test('TOs retain their destination and inactive foreign lines cannot grant access',()=>{
  const transfer={...order,order_type:'transfer_order'};
  assert.deepEqual(receivingOrderYards(transfer),[28]);
  assert.throws(()=>scopeReceivingOrderYard(transfer,1),{status:403});
  assert.equal(scopeReceivingOrderYard(transfer,28).lines.length,2);
  assert.deepEqual(receivingOrderYards({...order,lines:[{id:1,location_id:28,netsuite_active:true},{id:2,location_id:1,netsuite_active:false}]}),[28]);
  for(const yard of [0,195,'1 OR 1=1',[1,28],{},null]) {
    assert.throws(()=>scopeReceivingOrderYard(order,yard),{status:403});
  }
});

test('property: selected yard partitions every active PO line without changing quantities or source',()=>{
  fc.assert(fc.property(fc.constantFrom(...yards),fc.array(fc.record({
    location_id:fc.option(fc.constantFrom(...yards),{nil:null}),quantity:fc.integer({min:1,max:10000}),netsuite_active:fc.boolean()
  }),{minLength:1,maxLength:30}),fc.option(fc.constantFrom(...yards),{nil:null}),
  (header,rows,override)=>{
    const source={order_type:'purchase_order',destination_location_id:header,destination_override:override===null?null:names[override],
      lines:rows.map((line,index)=>({...line,id:index+1})),receivableLines:rows.map((line,index)=>({...line,id:index+1}))};
    const before=JSON.stringify(source);
    const active=source.lines.filter(line=>line.netsuite_active);
    const expectedYards=active.length?[...new Set(active.map(line=>override??line.location_id??header))]:[override??header];
    assert.deepEqual(receivingOrderYards(source),expectedYards);
    for(const yard of yards) {
      if(!expectedYards.includes(yard)) {
        assert.throws(()=>scopeReceivingOrderYard(source,yard),{status:403});
      } else {
        const result=scopeReceivingOrderYard(source,yard);
        const expected=source.lines.filter(line=>line.netsuite_active && (override??line.location_id??header)===yard);
        assert.deepEqual(result.lines,expected);
        assert.deepEqual(result.receivableLines,expected);
        assert.equal(result.destination_location_id,yard);
        const posting=scopeReceivingOrderYard(source,yard,{keepAllLines:true});
        assert.deepEqual(posting.lines.map(line=>line.id),source.lines.map(line=>line.id));
        assert.deepEqual(posting.receivableLines,expected);
      }
    }
    assert.equal(JSON.stringify(source),before);
  }),{seed:20260930,numRuns:120});
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {deliveryMaterials} from '../../../src/regular-stock-delivery-domain.js';

const lines=[
  {remoteLineId:11,itemId:100,quantity:20,backorderedQuantity:5,uom:'EA',locationId:1,open:true},
  {remoteLineId:22,itemId:100,quantity:30,backorderedQuantity:10,uom:'EA',locationId:1,open:true},
  {remoteLineId:33,itemId:200,quantity:40,backorderedQuantity:0,uom:'EA',locationId:1,open:false}
];
const order=()=>({id:1000,ref:'SOA09883-fixture',locationId:1,lines:structuredClone(lines)});
test('checked SO line IDs select exactly those backordered lines even for repeated items',()=>{
  const so=order();
  assert.deepEqual(deliveryMaterials(so,1,[22]),[so.lines[1]]);
  assert.deepEqual(deliveryMaterials(so,1,[11]),[so.lines[0]]);
  assert.deepEqual(deliveryMaterials(so,1),so.lines.slice(0,2));
});
test('empty, malformed, duplicate, unknown and non-backordered selections are rejected',()=>{
  for(const selection of [[],null,{},'11',[11,11],[true],['11'],[0],[-1],[1.5],[NaN],[Infinity],[999],[33]]) {
    assert.throws(()=>deliveryMaterials(order(),1,selection),{code:'REGULAR_DELIVERY_SELECTION_INVALID',status:400});
  }
});
test('property: selected subsets preserve SO order and quantities without changing any unchecked line',()=>{
  fc.assert(fc.property(fc.uniqueArray(fc.integer({min:1,max:100}),{minLength:1,maxLength:20}),fc.nat(),(ids,seed)=>{
    const so=order();so.lines=ids.map(remoteLineId=>({...lines[0],remoteLineId}));
    const selection=ids.filter((_,index)=>index%2===seed%2);if(!selection.length)selection.push(ids[0]);
    const before=structuredClone(so),expected=so.lines.filter(line=>selection.includes(line.remoteLineId));
    assert.deepEqual(deliveryMaterials(so,1,[...selection].reverse()),expected);
    assert.deepEqual(so,before);
  }),{seed:9883,numRuns:500});
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {loadWaitlistList} from '../../support/regular-waitlist-list-harness.mjs';
const list=loadWaitlistList(),settings={seed:261002,numRuns:400};
const row=fc.record({sellingYardId:fc.constantFrom(1,28),itemId:fc.integer({min:1,max:3}),customerId:fc.integer({min:1,max:3}),
  vendorId:fc.integer({min:1,max:3}),waitingQty:fc.integer({min:0,max:9999}),age:fc.integer({min:0,max:999})});
const rows=fc.array(row,{maxLength:50}).map(values=>values.map((value,i)=>({...value,id:i+1,vendorKey:String(value.vendorId),
  requestRef:'STREQ-'+(i+1),createdAt:new Date(Date.UTC(2026,0,1)+value.age*1000).toISOString()})));
test('property: combined list filters return exactly matching rows without changing the source',()=>{
  fc.assert(fc.property(rows,fc.constantFrom('',1,28),fc.constantFrom('',1,2,3),fc.constantFrom('',1,2,3),fc.constantFrom('',1,2,3),(input,yard,vendor,item,customer)=>{
    const original=JSON.stringify(input),filters={sellingYardId:String(yard),vendorKey:String(vendor),itemId:String(item),customerId:String(customer)};
    const actual=list.select(input,{filters});
    const expected=input.filter(r=>(!yard||r.sellingYardId===yard)&&(!vendor||r.vendorId===vendor)&&(!item||r.itemId===item)&&(!customer||r.customerId===customer));
    assert.deepEqual(new Set(actual.map(r=>r.id)),new Set(expected.map(r=>r.id)));assert.equal(JSON.stringify(input),original);
  }),settings);
});
test('property: quantity sorting is numeric in both directions and preserves every request',()=>{
  fc.assert(fc.property(rows,fc.constantFrom('asc','desc'),(input,direction)=>{
    const actual=list.select(input,{sortBy:'waitingQty',direction});
    assert.deepEqual(new Set(actual.map(r=>r.id)),new Set(input.map(r=>r.id)));
    for(let i=1;i<actual.length;i++)assert(direction==='asc'?actual[i-1].waitingQty<=actual[i].waitingQty:actual[i-1].waitingQty>=actual[i].waitingQty);
    assert.equal(JSON.stringify(list.select([...input].reverse(),{sortBy:'waitingQty',direction})),JSON.stringify(actual));
  }),settings);
});
test('natural text sorting, FIFO ties, missing vendors and clear filters remain usable',()=>{
  const rows=[{id:1,requestRef:'STREQ-10',createdAt:'2026-01-02',vendorKey:'none',vendorName:'',sellingYardId:28,sellingYard:'2967',itemId:4,itemCode:'UNI-4',customerId:5,customerName:'A'},
    {id:2,requestRef:'STREQ-2',createdAt:'2026-01-01',vendorKey:'6',vendorName:'Vendor B',sellingYardId:1,sellingYard:'3445',itemId:4,itemCode:'UNI-4',customerId:5,customerName:'A'}];
  assert.deepEqual(list.select(rows,{sortBy:'requestRef'}).map(r=>r.id),[2,1]);
  assert.deepEqual(list.select(rows,{sortBy:'customerName',direction:'desc'}).map(r=>r.id),[2,1]);
  assert.deepEqual(list.select(rows,{filters:{vendorKey:'none'}}).map(r=>r.id),[1]);
  assert.equal(list.select(rows,{filters:{}}).length,2);
  const options=list.facets(rows);assert.equal(options.itemId.length,1);assert.equal(options.vendorKey.length,2);
  assert(options.vendorKey.some(o=>o.value==='none'&&o.label==='No vendor'));
});

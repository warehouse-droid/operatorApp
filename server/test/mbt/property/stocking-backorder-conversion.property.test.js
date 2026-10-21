import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {canConvertStockingToBackorder,stockingBackorderMaterials} from '../../../public/stocking-backorder-conversion.js';

const material=fc.record({item_id:fc.integer({min:800000,max:900000}),sales_qty:fc.integer({min:1,max:1000000}).map(n=>n/1000),sales_uom:fc.constantFrom('EA','BAG','Ton','PC'),piece_qty:fc.integer({min:0,max:1000}),destination_location_id:fc.constantFrom(1,28,15,26)});
const request=lines=>({requestType:'regular',workflowVersion:2,status:'submitted',regular:{deliveryMethod:'stocking'},transfers:[],lines:lines.map(line=>({id:line.id,status:'submitted'}))});
test('all saved materials, quantities, units, pack counts and yards survive conversion independently of current catalog factors',()=>{
  fc.assert(fc.property(fc.array(material,{minLength:1,maxLength:100}),values=>{
    const lines=values.map((line,index)=>({...line,id:index+1,item_name:'Saved '+index,item_description:'Saved description '+index,pallet_qty:null,layer_qty:2,section_qty:null}));
    const items=new Map(lines.map(line=>[line.item_id,{item_id:line.item_id,vendor:'Vendor '+line.item_id,vendor_id:123,stock_unit:'Changed unit',to_plt:999,to_pcs:999,item_description:'Changed description'}]));
    const converted=stockingBackorderMaterials(lines,items,{requiredDate:'2099-10-08'});assert.equal(converted.length,lines.length);
    assert.deepEqual(converted.map(line=>[line.regularItemId,line.quantity,line.uom,line.detailSpec,line.pieceQty,line.layerQty,line.destinationLocationId]),lines.map(line=>[line.item_id,line.sales_qty,line.sales_uom,line.item_description,line.piece_qty,line.layer_qty,line.destination_location_id]));
    assert.ok(converted.every(line=>line.rate===null&&line.discountPercent===0));assert.ok(canConvertStockingToBackorder(request(lines)));
  }),{numRuns:600,seed:610071});
});
test('conversion eligibility requires an entirely open, uncommitted Stocking request in both directions',()=>{
  fc.assert(fc.property(fc.array(fc.constantFrom('submitted','approved','changes_requested','closed','rejected','cancelled','received','fulfilled','converted'),{minLength:0,maxLength:105}),statuses=>{
    const d=request(statuses.map((_,id)=>({id})));d.lines=statuses.map((status,id)=>({id,status}));
    assert.equal(canConvertStockingToBackorder(d),statuses.length>=1&&statuses.length<=100&&statuses.every(status=>['submitted','approved','changes_requested'].includes(status)));
    for(const method of ['backorder','waitlist','pickup','delivery'])assert.equal(canConvertStockingToBackorder({...d,regular:{deliveryMethod:method}}),false);
    for(const status of ['completed','cancelled'])assert.equal(canConvertStockingToBackorder({...d,status}),false);
    assert.equal(canConvertStockingToBackorder({...d,transfers:[{id:1}]}),false);
  }),{numRuns:700,seed:610072});
});
test('a committed material blocks whole-request conversion wherever it occurs',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:100}),fc.nat(),(count,offset)=>{
    const d=request(Array.from({length:count},(_,id)=>({id:id+1}))),index=offset%count;
    for(const block of [{transferId:1},{purchase:{demandId:1}}]){const lines=d.lines.map((line,i)=>i===index?{...line,...block}:line);assert.equal(canConvertStockingToBackorder({...d,lines}),false);}
    assert.equal(canConvertStockingToBackorder({...d,regular:{...d.regular,stockingLines:{[d.lines[index].id]:{resolution:{purchaseOrderRef:'PO'}}}}}),false);
  }),{numRuns:400,seed:610073});
});

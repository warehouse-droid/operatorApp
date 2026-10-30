import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {listSpecialPurchaseUnits, resolveSpecialPurchaseUnits} from '../../../src/special-stock-purchase-units.js';
import {buildSpecialPurchaseOrderPayload} from '../../../src/special-stock-request-netsuite.js';
import {normalizeSpecialPurchaseLine} from '../../../src/special-stock-purchase-review.js';

const metadata = {id:2055,unitstype:10,itemtype:'NonInvtPart',subtype:'Resale',purchase_unit_id:2};
const units = [{internalId:1,unitName:'Piece',abbreviation:'PC',pluralAbbreviation:'PCS'},
  {internalId:2,unitName:'Pallet',abbreviation:'PLT'}];
const boundary = (row=metadata, rows=units) => ({queryAll:async()=>[row],rest:async()=>({data:{uom:{items:rows}}})});

test('purchase UOM dropdown uses exact NetSuite unit IDs and labels',async()=>{
  const result=await listSpecialPurchaseUnits(2055,boundary());
  assert.deepEqual(result.units.map(u=>[u.id,u.name]),[[1,'PC'],[2,'PLT']]);
  assert.equal(result.defaultUnitId,2);
  assert.equal(result.noUnits,false);
});
test('purchase UOM resolves selected native identity without converting reviewed quantities',async()=>{
  const result=await resolveSpecialPurchaseUnits([{itemId:2055,uom:'PLT',unitId:2,quantity:3.5}],boundary());
  assert.deepEqual(result,[{itemId:2055,uom:'PLT',unitId:2,quantity:3.5}]);
  assert.equal((await resolveSpecialPurchaseUnits([{itemId:2055,uom:'PCS',quantity:24}],boundary()))[0].unitId,1);
});
test('invalid UOM IDs, labels, inactive items and sales-only fees fail before purchase',async()=>{
  for(const line of [{uom:'MADE UP'},{uom:'PLT',unitId:99},{uom:'PC',unitId:2},{uom:''}]) {
    await assert.rejects(()=>resolveSpecialPurchaseUnits([{itemId:2055,quantity:1,...line}],boundary()),{code:'SPECIAL_UOM_INVALID'});
  }
  for(const row of [{...metadata,isinactive:'T'},{...metadata,subtype:'Sale'},{...metadata,itemtype:'Discount'}]) {
    await assert.rejects(()=>listSpecialPurchaseUnits(2055,boundary(row)),{code:'SPECIAL_PO_ITEM_INVALID'});
  }
});
test('purchase-only fees without a units type explicitly omit transaction units',async()=>{
  const b=boundary({id:9001,itemtype:'OthCharge',subtype:'Purchase',unitstype:null});
  const choice=await listSpecialPurchaseUnits(9001,b);
  assert.equal(choice.noUnits,true);assert.deepEqual(choice.units,[]);
  const [line]=await resolveSpecialPurchaseUnits([{itemId:9001,uom:'',quantity:1}],b);
  assert.equal(line.unitId,null);
  await assert.rejects(()=>resolveSpecialPurchaseUnits([{itemId:9001,uom:'PC',quantity:1}],b),{code:'SPECIAL_UOM_INVALID'});
});
test('unverifiable native unit catalogs and malformed PO entries fail closed',async()=>{
  for(const itemId of [0,-1,1.5,'no-id']) await assert.rejects(()=>listSpecialPurchaseUnits(itemId,boundary()),{code:'SPECIAL_UOM_INVALID'});
  for(const catalog of [[],[units[0],units[0]],[{internalId:1}],[{abbreviation:'PC',links:[{rel:'self',href:'/record/v1/unitsType/999/uom/1'}]}]]) {
    await assert.rejects(()=>listSpecialPurchaseUnits(2055,boundary(metadata,catalog)),{code:'SPECIAL_UOM_INVALID'});
  }
  const linked=await listSpecialPurchaseUnits(2055,boundary(metadata,[{abbreviation:'PC',links:[{rel:'self',href:'/record/v1/unitsType/10/uom/1'}]}]));
  assert.equal(linked.units[0].id,1);
  for(const line of [null,[],{itemId:0},{itemId:9001,description:'Fee',quantity:0,uom:'',unitPurchaseCost:10},
    {itemId:9001,description:'Fee',quantity:1,uom:'',unitPurchaseCost:-1},
    {itemId:9001,description:'Fee',quantity:1,uom:'',unitPurchaseCost:10,pieceQty:Infinity}]) {
    assert.throws(()=>normalizeSpecialPurchaseLine(line));
  }
});
test('PO payload carries all packing counts and added fees without a native SO link',()=>{
  const line={caseLineId:1,itemId:2055,description:'PO only',quantity:2,unitId:2,uom:'PLT',unitPurchaseCost:50,
    palletQty:2,sectionQty:3,layerQty:4,pieceQty:24};
  const payload=buildSpecialPurchaseOrderPayload({caseId:1,vendorId:331,netsuiteLocationId:1,salesOrderRef:'SO1',lines:[line,
    {itemId:9001,ancillary:true,description:'Vendor delivery fee',quantity:1,uom:'',unitPurchaseCost:25}],
    vendorDiscountReview:{mode:'per_line',lines:[{caseLineId:1,vendorDiscountPercent:10}]}});
  assert.deepEqual(Object.fromEntries(['custcol_plt','custcol_sec','custcol_lyr','custcol_pcs'].map(k=>[k,payload.item.items[0][k]])),
    {custcol_plt:2,custcol_sec:3,custcol_lyr:4,custcol_pcs:24});
  assert.deepEqual(payload.item.items.map(l=>[l.item.id,l.quantity,l.rate]),[['2055',2,50],['9001',1,25],['4981',1,-10]]);
  assert.equal(payload.createdFrom,undefined);assert.equal(payload.item.items[1].units,undefined);
});
test('property: independent PO packing and quantity survive without changing the input',()=>{
  fc.assert(fc.property(fc.record({quantity:fc.integer({min:1,max:10000}),palletQty:fc.integer({min:1,max:10000}),
    sectionQty:fc.integer({min:1,max:10000}),layerQty:fc.integer({min:1,max:10000}),pieceQty:fc.integer({min:1,max:10000})}),values=>{
    const line={...values,itemId:2055,description:'Independent',uom:'PC',unitId:1,unitPurchaseCost:5};
    const before=structuredClone(line);
    const actual=buildSpecialPurchaseOrderPayload({caseId:1,vendorId:331,netsuiteLocationId:1,lines:[line]}).item.items[0];
    assert.deepEqual(line,before);assert.equal(actual.quantity,values.quantity);
    assert.deepEqual([actual.custcol_plt,actual.custcol_sec,actual.custcol_lyr,actual.custcol_pcs],
      [values.palletQty,values.sectionQty,values.layerQty,values.pieceQty]);
  }),{seed:20261029,numRuns:100});
});

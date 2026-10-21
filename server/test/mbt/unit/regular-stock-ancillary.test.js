import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {readRegularSalesOrder,applyRegularSalesOrderLocation} from '../../../src/regular-stock-netsuite-adapter.js';
import {planRegularStockRouting} from '../../../src/regular-stock-domain.js';

function fixture({discount=false,discountType='Discount',discountQuantity,discountLocation=1,extra=false,quantity=523,pallets=10,rate='-25.00'}={}){
 const materials=[{id:4757,name:'Paver',quantity,uom:'SQFT'},{id:9736,name:'Wall',quantity:760,uom:'EACH'}];
 const lines=[...materials.map(line=>({...line,type:'InvtPart'})),{id:1784,name:'PALLET',quantity:pallets,uom:'EACH',type:'InvtPart'},
   ...(discount?[{id:discountType==='Subtotal'?-2:discountType==='OthCharge'?3013:10716,
     name:discountType==='OthCharge'?'Delivery Fee':discountType,type:discountType,quantity:discountQuantity}]:[]),
   ...(extra?[{id:777,name:'Extra stock',type:'InvtPart',quantity:5,uom:'EACH'}]:[])].map((line,index)=>({...line,
     remoteId:5001+index,restId:index+1,location:line.type==='Discount'?discountLocation:1,rate:line.type==='Discount'?rate:10}));
 const writes=[];
 const boundary={
  queryAll:async()=>lines.map(line=>({id:1024553,tranid:'SO-FIXTURE',order_location_id:1,customer_id:8444,status:'B',
   line_id:line.remoteId,rest_line_id:line.restId,item_id:line.id,item_name:line.name,item_type:line.type,
   quantity:line.quantity==null?line.quantity:-line.quantity,stock_unit:line.uom,location_id:line.location,
   fulfilled_quantity:0,billed_quantity:0,line_closed:'F'})),
  rest:async(_path,options={})=>{
   if(options.method){
    assert.equal(options.method,'PATCH');assert.deepEqual(Object.keys(options.body),['item']);
    for(const update of options.body.item.items){
     assert.deepEqual(Object.keys(update),['line','location']);
     lines.find(line=>line.restId===update.line).location=Number(update.location.id);
    }
    writes.push(structuredClone(options.body));
   }
   return{data:{id:1024553,tranId:'SO-FIXTURE',location:{id:1},entity:{id:8444},item:{items:lines.map(line=>({
    line:line.restId,item:{id:line.id},quantity:line.quantity,rate:line.rate,location:{id:line.location}}))}}};
  },
  resolveYards:async()=>[1,28,15,26].map(id=>({localLocationId:id,netsuiteLocationId:id}))
 };
 const request={destinationLocationId:1,lines:materials.map((line,index)=>({id:index+1,itemId:line.id,sourceLocationId:28,
   salesQty:line.quantity,salesUom:line.uom,decision:'stock'}))};
 return{boundary,request,lines,writes};
}

test('PALLET is excluded from requested stock and moves with both material lines to 2967',async()=>{
 const {boundary,request,lines,writes}=fixture();const order=await readRegularSalesOrder('SO-FIXTURE',boundary);
 const plan=planRegularStockRouting({request,salesOrder:order});
 assert.equal(plan.mode,'location');assert.equal(plan.sourceLocationId,28);assert.deepEqual(plan.groups,[]);
 assert.deepEqual(plan.materialLineIds,[5001,5002]);
 const after=await applyRegularSalesOrderLocation({order,plan},boundary);
 assert.deepEqual(writes[0].item.items.map(line=>line.line),[1,2,3]);assert(lines.every(line=>line.location===28));
 assert.equal(after.locationId,1);assert.equal(lines[2].quantity,10);
});

test('quantity-less discount moves with stock and PALLET without changing rates or creating a TO',async()=>{
 const {boundary,request,lines,writes}=fixture({discount:true});const order=await readRegularSalesOrder('SO-FIXTURE',boundary);
 const plan=planRegularStockRouting({request,salesOrder:order});
 assert.equal(plan.mode,'location');assert.deepEqual(plan.materialLineIds,[5001,5002]);assert.deepEqual(plan.groups,[]);
 await applyRegularSalesOrderLocation({order,plan},boundary);
 assert.deepEqual(writes[0].item.items.map(line=>line.line),[1,2,3,4]);assert(lines.every(line=>line.location===28));
 assert.equal(lines[3].rate,'-25.00');assert.equal(lines[3].quantity,undefined);
 await applyRegularSalesOrderLocation({order:JSON.parse(JSON.stringify(order)),plan},boundary);
 assert.equal(writes.length,1,'Persisted handoff retries must recognize the completed location change');
});

test('a discount rate changed after linking blocks every line write',async()=>{
 const {boundary,request,lines,writes}=fixture({discount:true,discountQuantity:0});
 const order=await readRegularSalesOrder('SO-FIXTURE',boundary),plan=planRegularStockRouting({request,salesOrder:order});
 lines[3].rate='-50.00';
 await assert.rejects(()=>applyRegularSalesOrderLocation({order,plan},boundary),error=>error.code==='REGULAR_SO_MISMATCH');
 assert.equal(writes.length,0);
});

test('subtotal, delivery charges, services, non-inventory and markup lines follow single-source stock',async()=>{
 for(const discountType of ['Subtotal','OthCharge','Service','NonInvtPart','Markup']){
  const {boundary,request,lines,writes}=fixture({discount:true,discountType});
  const order=await readRegularSalesOrder('SO-FIXTURE',boundary),plan=planRegularStockRouting({request,salesOrder:order});
  assert.equal(plan.mode,'location');assert.deepEqual(plan.materialLineIds,[5001,5002]);
  await applyRegularSalesOrderLocation({order:JSON.parse(JSON.stringify(order)),plan},boundary);
  assert.deepEqual(writes[0].item.items.map(line=>line.line),[1,2,3,4]);assert(lines.every(line=>line.location===28));
 }
});

test('an unknown item type cannot silently disappear from stock routing',async()=>{
 const {boundary,writes}=fixture({discount:true,discountType:'FutureInventoryType'});
 await assert.rejects(()=>readRegularSalesOrder('SO-FIXTURE',boundary),error=>error.code==='REGULAR_SO_MISMATCH');
 assert.equal(writes.length,0);
});

test('delivery fee retains its charge and quantity while following the stock to 2967',async()=>{
 const {boundary,request,lines,writes}=fixture({discount:true,discountType:'OthCharge',discountQuantity:1});
 const order=await readRegularSalesOrder('SO-FIXTURE',boundary),plan=planRegularStockRouting({request,salesOrder:order});
 assert.equal(plan.mode,'location');assert.deepEqual(plan.groups,[]);
 const fee=order.lines.find(line=>line.itemId===3013);assert.equal(fee.ancillary,true);
 await applyRegularSalesOrderLocation({order,plan},boundary);
 assert.equal(lines[3].location,28);assert.equal(lines[3].rate,10);assert.equal(lines[3].quantity,1);
 assert.deepEqual(writes[0].item.items[3],{line:4,location:{id:'28'}});
});

test('ancillary property: PALLET and discount never force a TO but extra material does',async()=>{
 await fc.assert(fc.asyncProperty(fc.integer({min:1,max:5000}),fc.integer({min:1,max:100}),
  fc.constantFrom(undefined,null,0),fc.constantFrom(null,1),fc.constantFrom('Discount','Subtotal','OthCharge','Service','NonInvtPart','Markup'),fc.boolean(),async(quantity,pallets,discountQuantity,discountLocation,discountType,extra)=>{
   const {boundary,request,lines,writes}=fixture({discount:true,discountType,discountQuantity,discountLocation,extra,quantity,pallets,rate:'-10%'});
   const order=await readRegularSalesOrder('SO-FIXTURE',boundary),plan=planRegularStockRouting({request,salesOrder:order});
   assert.equal(plan.mode,extra?'transfer':'location');assert.deepEqual(plan.materialLineIds,[5001,5002]);
   if(extra){assert.equal(plan.groups.length,1);assert.equal(writes.length,0);return;}
   assert.deepEqual(plan.groups,[]);
   await applyRegularSalesOrderLocation({order:JSON.parse(JSON.stringify(order)),plan},boundary);
   assert.deepEqual(writes[0].item.items.map(line=>line.line),[1,2,3,4]);assert(lines.every(line=>line.location===28));
   assert.equal(lines[3].rate,discountType==='Discount'?'-10%':10);assert.equal(lines[3].quantity,discountQuantity);
 }),{numRuns:150,seed:121632});
});

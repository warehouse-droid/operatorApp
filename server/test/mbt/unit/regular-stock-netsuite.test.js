import assert from 'node:assert/strict';
import test from 'node:test';
import { readRegularSalesOrder, applyRegularSalesOrderLocation } from '../../../src/regular-stock-netsuite-adapter.js';
function boundary() {
  let location=28,patches=0;
  const rows=[{id:101,tranid:'SOA101',order_location_id:28,customer_id:55,status:'B',line_id:5001,rest_line_id:1,item_id:10,item_name:'Paver',quantity:-200,backordered_quantity:20,stock_unit:'EA',item_type:'InvtPart',location_id:28,fulfilled_quantity:0,billed_quantity:0,line_closed:'F'}];
  const b={queryAll:async()=>rows.map(row=>({...row,location_id:location})),rest:async(_path,options={})=>{
    if(options.method==='PATCH'){patches++;assert.deepEqual(Object.keys(options.body),['item']);location=Number(options.body.item.items[0].location.id);return{};}
    return{data:{id:101,tranId:'SOA101',location:{id:28},entity:{id:55},item:{items:[{line:1,item:{id:10},quantity:200,location:{id:location},rate:1}]}}};},
    resolveYards:async()=>[1,28,15,26].map(id=>({localLocationId:id,netsuiteLocationId:id}))};
  return {b,rows,patches:()=>patches,setLocation:value=>{location=value;}};
}
test('SO reader returns exact remote identities, ordering yard and open material quantities',async()=>{
  const {b}=boundary();const order=await readRegularSalesOrder('SOA101',b);
  assert.equal(order.locationId,28);assert.equal(order.lines[0].remoteLineId,5001);assert.equal(order.lines[0].quantity,200);assert.equal(order.lines[0].open,true);
});
test('keyed location patch preserves header/quantity and retry recognizes applied target',async()=>{
  const {b,patches}=boundary();const order=await readRegularSalesOrder('SOA101',b);
  const plan={sourceLocationId:1,materialLineIds:[5001]};
  await applyRegularSalesOrderLocation({order,plan},b);await applyRegularSalesOrderLocation({order,plan},b);
  assert.equal(patches(),1);
});
test('remote quantity or fulfillment changes block location writes',async()=>{
  const {b,rows,patches}=boundary();const order=await readRegularSalesOrder('SOA101',b);
  rows[0].quantity=-201;
  await assert.rejects(()=>applyRegularSalesOrderLocation({order,plan:{sourceLocationId:1,materialLineIds:[5001]}},b),e=>e.status===409);
  assert.equal(patches(),0);
});
test('a new material line added during location patch prevents a false verified success',async()=>{
 const {b,rows}=boundary();const order=await readRegularSalesOrder('SOA101',b);
 const rest=b.rest;
 b.rest=async(path,options)=>{
   const result=await rest(path,options);
   if(options?.method==='PATCH')rows.push({...rows[0],line_id:5002,rest_line_id:2,item_id:11,item_name:'New material'});
   else if(rows.length===2)result.data.item.items.push({...result.data.item.items[0],line:2,item:{id:11}});
   return result;
 };
 await assert.rejects(()=>applyRegularSalesOrderLocation({order,plan:{sourceLocationId:1,materialLineIds:[5001]}},b),e=>e.status===409);
});
test('inconsistent REST/SuiteQL line locations cannot be treated as a safe snapshot',async()=>{
 const {b}=boundary();const rest=b.rest;
 b.rest=async(...args)=>{const result=await rest(...args);result.data.item.items[0].location.id=26;return result;};
 await assert.rejects(()=>readRegularSalesOrder('SOA101',b),e=>e.status===409);
});
test('SO boundary rejects invalid references, missing identities and incomplete snapshots',async()=>{
 for(const reference of ['',"\u0000bad",'x'.repeat(81)])await assert.rejects(()=>readRegularSalesOrder(reference,boundary().b),e=>e.status===409);
 const checks=[
  b=>{b.queryAll=async()=>[];},
  b=>{const read=b.rest;b.rest=async(...args)=>{const result=await read(...args);result.data.entity.id=99;return result;};},
  b=>{const read=b.rest;b.rest=async(...args)=>{const result=await read(...args);result.data.item.items=[];return result;};},
  b=>{const read=b.rest;b.rest=async(...args)=>{const result=await read(...args);result.data.item.items[0].item.id=99;return result;};}
 ];
 for(const change of checks){const {b}=boundary();change(b);await assert.rejects(()=>readRegularSalesOrder('SOA101',b),e=>e.status===409);}
 const {b,rows}=boundary();rows[0].line_id=0;await assert.rejects(()=>readRegularSalesOrder('SOA101',b),e=>e.status===409);
});
test('v2 TO payload has a stable external identity across revisions and retries',async()=>{
 const {buildStockRequestTransferPayload}=await import('../../../src/stock-request-service.js');
 const transfer={id:11,requestId:22,workflowVersion:2,lines:[{itemId:10,salesQty:200}],palletQuantity:0};
 const locations={source:{netsuiteLocationId:1,subsidiaryId:1},destination:{netsuiteLocationId:28,subsidiaryId:1}};
 const first=buildStockRequestTransferPayload({transfer,locations});
 assert.equal(first.externalId,'MBBS_REGULAR_STOCK_22_11');
 assert.equal(buildStockRequestTransferPayload({transfer:{...transfer,revision:2},locations}).externalId,first.externalId);
 assert.equal(buildStockRequestTransferPayload({transfer:{...transfer,workflowVersion:1},locations}).externalId,undefined);
});

test('SO reader carries authoritative backorders without replacing unknown values with zero',async()=>{
 const {b,rows}=boundary();
 assert.equal((await readRegularSalesOrder('SOA101',b)).lines[0].backorderedQuantity,20);
 rows[0].backordered_quantity=null;
 assert.equal((await readRegularSalesOrder('SOA101',b)).lines[0].backorderedQuantity,null);
});

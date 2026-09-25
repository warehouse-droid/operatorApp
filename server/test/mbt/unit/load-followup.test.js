import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { compareNetSuiteWebhookVersions } from '../../../src/netsuite-order-webhook-queue-policy.js';
import { deliveryLoadConfirmation, postingOrderKeys } from '../../../src/operator-load-state.js';
const line=(id,packed=0,extra={})=>({id,item_type:'InvtPart',sku:`ITEM-${id}`,quantity:2,loaded_qty:0,packed_sales_qty:packed,...extra});
test('3 of 4 includes fully confirmed lines in total and lists the unconfirmed pallet',()=>{
  const summary=deliveryLoadConfirmation({netsuite_id:1,tranid:'SO1',lines:[line(1,2),line(2,2),line(3,2),line(4,0,{sku:'PALLET'})]});
  assert.deepEqual(summary,{orderId:'1',orderRef:'SO1',total:4,confirmed:3,missing:[{id:'4',sku:'PALLET'}]});
});
test('remaining work excludes completed, charge, blocked and direct-supply lines',()=>{
  const lines=[line(1,0,{loaded_qty:2}),line(2,0,{sku:'DELIVERY CHARGE'}),line(3,0,{no_yard_load_required:true}),line(4,0,{linked_quantity_blocked:true}),line(5,0,{item_type:'Discount'}),line(6,0,{netsuite_active:false}),line(7,0,{sync_exception:'changed'}),line(8,0,{netsuite_closed:true}),line(9,1),line(10)];
  const result=deliveryLoadConfirmation({lines});
  assert.equal(result.total,2);assert.equal(result.confirmed,1);assert.equal(result.missing[0].id,'10');
});
test('unit conversion and a partly loaded balance remain confirmable',()=>{
  const result=deliveryLoadConfirmation({lines:[line(1,0,{quantity:0,pallet_qty:1,to_plt:10,loaded_qty:4}),line(2,0,{packed_pallet_qty:1})]});
  assert.equal(result.total,2);assert.equal(result.confirmed,1);
});
test('empty, invalid and legacy quantities produce bounded confirmation counts',()=>{
 assert.deepEqual(deliveryLoadConfirmation(null),{orderId:'',orderRef:'',total:0,confirmed:0,missing:[]});
 assert.deepEqual(postingOrderKeys(null),[]);
 const result=deliveryLoadConfirmation({lines:[line(1,-1,{quantity:'invalid',piece_qty:2,loaded_qty:-1}),line(2,0,{quantity:0,section_qty:3}),line(3,0,{quantity:0,layer_qty:2}),line(4,0,{quantity:0,pallet_qty:1}),line(5,0,{quantity:0}),line(6,0,{item_name:'Named item',sku:null,packed_piece_qty:1})]});
 assert.equal(result.total,5);assert.equal(result.confirmed,1);assert.equal(result.missing.length,4);
 assert.ok(postingOrderKeys({}).every(key=>!key.startsWith('source:')));
});
test('posting keys cover both functions, exact source and grouped children',()=>{
  const keys=postingOrderKeys({netsuite_id:'GOA-8601-8604',order_type:'group_order',child_orders:[{netsuite_id:123,order_type:'sales_order'},{netsuite_id:124,order_type:'transfer_order'}]});
  for(const key of ['delivery_prep:group_order:GOA-8601-8604','customer_pickup:sales_order:123','delivery_prep:sales_order:123','source:IF:SO:123','source:IF:TO:124']) assert.ok(keys.includes(key),key);
  assert.ok(!keys.includes('source:IF:SO:1234'));
});
test('property: confirmation totals partition unfinished eligible lines independently of pagination',()=>{
  fc.assert(fc.property(fc.array(fc.boolean(),{minLength:1,maxLength:50}),flags=>{
    const result=deliveryLoadConfirmation({lines:flags.map((packed,i)=>line(i,packed?2:0))});
    assert.equal(result.total,flags.length);assert.equal(result.confirmed,flags.filter(Boolean).length);
    assert.equal(result.missing.length+result.confirmed,result.total);
  }),{seed:17092026,numRuns:100});
});

test('property: hashes never order different payloads with equal source timestamps',()=>{
 fc.assert(fc.property(fc.string(),fc.string(),(left,right)=>{
  assert.equal(compareNetSuiteWebhookVersions({sourceModifiedAt:'2026-09-17T11:37:00Z',payloadHash:left},{sourceModifiedAt:'2026-09-17T11:37:00Z',payloadHash:right}),0);
 }),{seed:995451,numRuns:100});
});

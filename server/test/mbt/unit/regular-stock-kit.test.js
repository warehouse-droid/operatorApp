import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {readRegularSalesOrder,applyRegularSalesOrderLocation} from '../../../src/regular-stock-netsuite-adapter.js';
import {deliveryMaterials,deliveryBaseYard} from '../../../src/regular-stock-delivery-domain.js';
import {kitFixture} from '../fixtures/regular-stock-kit.js';

test('visible SO lines match exactly while hidden kit components retain their evidence',async()=>{
 const f=kitFixture(),order=await readRegularSalesOrder('SO-KIT',f.boundary);
 assert.equal(order.lines.length,4);
 assert.deepEqual(order.lines.map(line=>line.itemId),[1189,10126,599,1987]);
 const kit=order.lines[1];
 assert.equal(kit.itemType,'Kit');assert.equal(kit.ancillary,false);assert.equal(kit.uom,undefined);
 assert.deepEqual(kit.kitComponents.map(line=>[line.remoteLineId,line.itemId,line.quantity,line.backorderedQuantity,line.locationId]),[[5064230,599,16,0,28]]);
 assert.equal(f.writes.length,0);
});

test('fully committed kit without a stock unit does not block unrelated material backorders',async()=>{
 const f=kitFixture(),order=await readRegularSalesOrder('SO-KIT',f.boundary);
 assert.equal(deliveryBaseYard(order).locationId,28);
 assert.deepEqual(deliveryMaterials(order,28).map(line=>[line.itemId,line.quantity,line.backorderedQuantity]),[[1189,160,78]]);
 assert.equal(f.writes.length,0);
});

test('property: arbitrary kits, repeated component items and row ordering preserve every visible material',async()=>{
 await fc.assert(fc.asyncProperty(fc.integer({min:1,max:500}),fc.integer({min:1,max:6}),fc.integer({min:1,max:160}),fc.boolean(),
  async(kitQuantity,componentCount,backorder,reverse)=>{
   const f=kitFixture({kitQuantity,componentCount,backorder});
   if(reverse)f.rows.reverse();
   const order=await readRegularSalesOrder('SO-KIT',f.boundary);
   assert.equal(order.lines.length,4);
   const kit=order.lines.find(line=>line.itemId===10126);
   assert.equal(kit.kitComponents.length,componentCount);
   assert(kit.kitComponents.every(line=>line.quantity===kitQuantity&&line.backorderedQuantity===0));
   assert.equal(order.lines.filter(line=>line.itemId===599).length,1,'A separate line with the same component item must remain visible');
   assert.deepEqual(deliveryMaterials(order,28).map(line=>[line.itemId,line.backorderedQuantity]),[[1189,backorder]]);
  }),{seed:121863,numRuns:160});
});

test('kits with positive or unknown parent/component backorders receive a component-transfer error',async()=>{
 for(const change of [
  f=>{f.parent.backordered_quantity=1;},f=>{f.parent.backordered_quantity=null;},
  f=>{f.components[0].backordered_quantity=1;},f=>{f.components[0].backordered_quantity=null;}
 ]){
  const f=kitFixture();change(f);
  const order=await readRegularSalesOrder('SO-KIT',f.boundary);
  assert.throws(()=>deliveryMaterials(order,28),{code:'REGULAR_DELIVERY_KIT_BACKORDER'});
  assert.equal(f.writes.length,0);
 }
});

test('property: positive kit backorders and broken parent identities cannot be ignored',async()=>{
 await fc.assert(fc.asyncProperty(fc.integer({min:1,max:16}),fc.boolean(),async(quantity,component)=>{
  const f=kitFixture();
  (component?f.components[0]:f.parent).backordered_quantity=quantity;
  const order=await readRegularSalesOrder('SO-KIT',f.boundary);
  assert.throws(()=>deliveryMaterials(order,28),{code:'REGULAR_DELIVERY_KIT_BACKORDER'});
  f.components[0].kit_member_of=quantity+100;
  await assert.rejects(()=>readRegularSalesOrder('SO-KIT',f.boundary),{code:'REGULAR_SO_MISMATCH'});
  assert.equal(f.writes.length,0);
 }),{seed:121864,numRuns:80});
});

test('orphaned, nested, visible, duplicate and inconsistent kit component snapshots fail closed',async()=>{
 for(const change of [
  f=>{f.components[0].kit_member_of=999;},
  f=>{f.components[0].kit_member_of=f.rows[0].rest_line_id;},
  f=>{f.components[0].kit_member_of='invalid';},
  f=>{f.components[0].item_type='Kit';},
  f=>{f.components[0].item_type='FutureInventoryType';},
  f=>{f.components[0].location_id=1;},
  f=>{f.components[0].line_id=f.parent.line_id;},
  f=>{f.components[0].rest_line_id=f.parent.rest_line_id;},
  f=>{f.components[0].quantity=null;},
  f=>{f.components[0].quantity=-Infinity;},
  f=>{f.components[0].backordered_quantity=17;},
  f=>{f.components[0].fulfilled_quantity=-1;},
  f=>{f.rows.splice(f.rows.indexOf(f.components[0]),1);},
  f=>{const rest=f.boundary.rest;f.boundary.rest=async(...args)=>{const result=await rest(...args);const row=f.components[0];result.data.item.items.push({line:row.rest_line_id,item:{id:row.item_id},quantity:16,location:{id:28}});return result;};},
  f=>{const rest=f.boundary.rest;f.boundary.rest=async(...args)=>{const result=await rest(...args);result.data.item.items[0].lineUniqueKey='999999';return result;};}
 ]){
  const f=kitFixture();change(f);
  await assert.rejects(()=>readRegularSalesOrder('SO-KIT',f.boundary),{code:'REGULAR_SO_MISMATCH'});
  assert.equal(f.writes.length,0);
 }
});

test('missing or unexpected visible SO lines still fail despite valid hidden kit rows',async()=>{
 for(const modify of [
  lines=>lines.splice(0,1),
  lines=>lines.push({...lines[0],line:88}),
  lines=>{lines[0].item.id='999';},
  lines=>{lines[0].location.id='1';},
 ]){
  const f=kitFixture(),rest=f.boundary.rest;
  f.boundary.rest=async(...args)=>{const result=await rest(...args);modify(result.data.item.items);return result;};
  await assert.rejects(()=>readRegularSalesOrder('SO-KIT',f.boundary),{code:'REGULAR_SO_MISMATCH'});
  assert.equal(f.writes.length,0);
 }
});

test('persisted pickup location retries verify kit components and preserve SO quantities',async()=>{
 const f=kitFixture(),order=await readRegularSalesOrder('SO-KIT',f.boundary);
 const plan={sourceLocationId:1,materialLineIds:order.lines.filter(line=>!line.ancillary).map(line=>line.remoteLineId)};
 const after=await applyRegularSalesOrderLocation({order:JSON.parse(JSON.stringify(order)),plan},f.boundary);
 assert(after.lines.every(line=>line.locationId===1));
 assert.equal(after.lines[1].kitComponents[0].locationId,1);
 assert.equal(after.lines[1].quantity,16);assert.equal(after.lines[1].kitComponents[0].quantity,16);
 await applyRegularSalesOrderLocation({order:JSON.parse(JSON.stringify(order)),plan},f.boundary);
 assert.equal(f.writes.length,1);
});

test('changed hidden components block pickup location writes before any SO mutation',async()=>{
 for(const change of [
  f=>{f.components[0].quantity=-15;},f=>{f.components[0].item_id=600;},
  f=>{f.components[0].stock_unit='BOX';},f=>{f.components[0].backordered_quantity=1;},
  f=>{f.components[0].fulfilled_quantity=1;}
 ]){
  const f=kitFixture(),order=await readRegularSalesOrder('SO-KIT',f.boundary);
  change(f);
  await assert.rejects(()=>applyRegularSalesOrderLocation({order,plan:{sourceLocationId:1,materialLineIds:[order.lines[1].remoteLineId]}},f.boundary),{code:'REGULAR_SO_MISMATCH'});
  assert.equal(f.writes.length,0);
 }
});

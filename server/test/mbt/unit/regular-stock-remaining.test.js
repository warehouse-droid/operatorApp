import assert from 'node:assert/strict';
import test from 'node:test';
import {readRegularSalesOrder,applyRegularSalesOrderLocation,regularStockKitComponentsMatch} from '../../../src/regular-stock-netsuite-adapter.js';
import {planRegularStockRouting} from '../../../src/regular-stock-domain.js';
import {deliveryMaterials,deliveryQuantities} from '../../../src/regular-stock-delivery-domain.js';
import {kitFixture} from '../fixtures/regular-stock-kit.js';
import {regularStockConfirmationToken} from '../../../src/regular-stock-confirmation.js';

function fixture({quantity=100,fulfilled=40,billed=100,closed='F',status='D'}={}) {
  const f=kitFixture();
  Object.assign(f.rows[0],{quantity:-quantity,fulfilled_quantity:fulfilled,billed_quantity:billed,line_closed:closed,backordered_quantity:20});
  for(const row of f.rows)row.status=status;
  return f;
}
const read=f=>readRegularSalesOrder('SO-KIT',f.boundary);
const request=quantity=>({destinationLocationId:28,lines:[{id:1,itemId:1189,sourceLocationId:1,salesQty:quantity,salesUom:'PC',decision:'stock'}]});

test('billed open and partly fulfilled lines expose their physical remaining balance',async()=>{
  for(const [status,fulfilled,remaining] of [['B',0,100],['D',40,60],['E',40,60]]) {
    const order=await read(fixture({status,fulfilled}));
    assert.equal(order.lines[0].quantity,100);
    assert.equal(order.lines[0].fulfilledQuantity,fulfilled);
    assert.equal(order.lines[0].remainingQuantity,remaining);
    assert.equal(order.lines[0].open,true);
  }
});
test('closed and fully fulfilled lines have zero actionable balance',async()=>{
  for(const options of [{closed:'T'},{closed:true},{fulfilled:100},{fulfilled:101}]) {
    const line=(await read(fixture(options))).lines[0];
    assert.equal(line.remainingQuantity,0);assert.equal(line.open,false);
  }
});
test('terminal native SO statuses still prevent line operations',async()=>{
  for(const status of ['C','F','G','H'])assert.equal((await read(fixture({status,fulfilled:0}))).lines[0].open,false);
});
test('routing matches only the remaining balance even with an unrelated closed line',async()=>{
  const f=fixture();f.rows.find(row=>row.item_name==='Separately ordered component').line_closed='T';
  const order=await read(f);order.locationId=28;
  const plan=planRegularStockRouting({request:request(60),salesOrder:order});
  assert.deepEqual(plan.mappings.map(line=>[line.remoteLineId,line.quantity]),[[order.lines[0].remoteLineId,60]]);
  assert.throws(()=>planRegularStockRouting({request:request(100),salesOrder:order}),{code:'REGULAR_SO_MISMATCH'});
});
test('delivery ignores closed lines and caps transfer at the remaining quantity',async()=>{
  const f=fixture();const closed=f.rows.find(row=>row.item_name==='Separately ordered component');
  closed.line_closed='T';closed.backordered_quantity=10;
  const order=await read(f),materials=deliveryMaterials(order,28);
  assert.deepEqual(materials.map(line=>line.itemId),[1189]);
  assert.equal(deliveryQuantities(materials,[{itemId:1189,requestableAvailable:1000}])[0].quantity,60);
  assert.equal(deliveryQuantities(materials,[{itemId:1189,requestableAvailable:30}])[0].quantity,20);
  assert.throws(()=>deliveryMaterials(order,28,[closed.line_id]),{code:'REGULAR_DELIVERY_SELECTION_INVALID'});
});
test('backorders larger than unfulfilled balance are rejected',async()=>{
  const f=fixture();f.rows[0].backordered_quantity=61;
  const order=await read(f);
  assert.throws(()=>deliveryMaterials(order,28),{code:'REGULAR_SO_MISMATCH'});
});
test('billing-only kit changes do not invalidate the physical snapshot',async()=>{
  const f=fixture({status:'B',fulfilled:0,billed:0}),before=await read(f);
  f.parent.billed_quantity=16;f.components[0].billed_quantity=16;
  const after=await read(f);
  assert.equal(regularStockKitComponentsMatch(before.lines[1],after.lines[1]),true);
  await applyRegularSalesOrderLocation({order:before,plan:{sourceLocationId:1,materialLineIds:before.lines.filter(line=>!line.ancillary).map(line=>line.remoteLineId)}},f.boundary);
  assert.equal(f.writes.length,1);
});
test('confirmation remains valid across kit billing but changes when physical progress changes',async()=>{
  const f=fixture({status:'B',fulfilled:0,billed:0}),order=await read(f);
  const token=regularStockConfirmationToken(1,{order});
  f.components[0].billed_quantity=16;
  assert.equal(regularStockConfirmationToken(1,{order:await read(f)}),token);
  f.rows[0].fulfilled_quantity=1;
  assert.notEqual(regularStockConfirmationToken(1,{order:await read(f)}),token);
});
test('location patch permits an already billed partial line and preserves ordered quantity',async()=>{
  const f=fixture(),order=await read(f),plan={sourceLocationId:1,materialLineIds:[order.lines[0].remoteLineId]};
  await applyRegularSalesOrderLocation({order,plan},f.boundary);
  await applyRegularSalesOrderLocation({order:JSON.parse(JSON.stringify(order)),plan},f.boundary);
  assert.equal(f.writes.length,1);assert.equal(f.rows[0].quantity,-100);assert.equal(f.rows[0].fulfilled_quantity,40);
});
test('closed ancillary lines stay at their original location',async()=>{
  const f=fixture({status:'B',fulfilled:0,billed:0});f.rows.at(-1).line_closed='T';
  const order=await read(f);
  await applyRegularSalesOrderLocation({order,plan:{sourceLocationId:1,materialLineIds:[order.lines[0].remoteLineId]}},f.boundary);
  assert.deepEqual(f.writes[0].item.items.map(line=>line.line),[1]);
  assert.equal(f.rows.at(-1).location_id,28);
});
test('legacy unfulfilled snapshots cannot authorize a newly partial line',async()=>{
  const f=fixture({status:'B',fulfilled:0,billed:0}),order=await read(f);
  for(const line of order.lines){delete line.fulfilledQuantity;delete line.remainingQuantity;delete line.closed;}
  f.rows[0].fulfilled_quantity=1;
  await assert.rejects(()=>applyRegularSalesOrderLocation({order,plan:{sourceLocationId:1,materialLineIds:[order.lines[0].remoteLineId]}},f.boundary),{code:'REGULAR_SO_MISMATCH'});
  assert.equal(f.writes.length,0);
});
test('new fulfillment or closure blocks a previously approved location patch',async()=>{
  for(const change of [row=>{row.fulfilled_quantity=41;},row=>{row.line_closed='T';}]) {
    const f=fixture(),order=await read(f);change(f.rows[0]);
    await assert.rejects(()=>applyRegularSalesOrderLocation({order,plan:{sourceLocationId:1,materialLineIds:[order.lines[0].remoteLineId]}},f.boundary),{code:'REGULAR_SO_MISMATCH'});
    assert.equal(f.writes.length,0);
  }
});
test('malformed physical balances fail before an order can be approved',async()=>{
  for(const change of [row=>{row.fulfilled_quantity=null;},row=>{row.fulfilled_quantity=-1;},row=>{row.fulfilled_quantity='bad';},row=>{row.line_closed='unknown';}]) {
    const f=fixture();change(f.rows[0]);
    await assert.rejects(()=>read(f),{code:'REGULAR_SO_MISMATCH'});
  }
});
test('delivery rejects malformed fulfillment in a supplied physical snapshot',async()=>{
  for(const fulfilledQuantity of [null,NaN,-1,Infinity]) {
    const order=await read(fixture());order.lines[0].fulfilledQuantity=fulfilledQuantity;
    assert.throws(()=>deliveryMaterials(order,28),{code:'REGULAR_SO_MISMATCH'});
  }
});
test('decimal stock quantities retain the verified remaining balance',async()=>{
  const order=await read(fixture({quantity:313.5,fulfilled:125.4,billed:313.5}));
  assert.equal(order.lines[0].remainingQuantity,188.1);
  assert.equal(deliveryQuantities(deliveryMaterials(order,28),[{itemId:1189,requestableAvailable:500}])[0].quantity,188.1);
});

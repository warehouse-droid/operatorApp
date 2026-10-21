import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {readRegularSalesOrder,regularStockKitComponentsMatch,applyRegularSalesOrderLocation} from '../../../src/regular-stock-netsuite-adapter.js';
import {planRegularStockRouting} from '../../../src/regular-stock-domain.js';
import {deliveryMaterials,deliveryQuantities} from '../../../src/regular-stock-delivery-domain.js';
import {kitFixture} from '../fixtures/regular-stock-kit.js';

test('property: billing never changes physical eligibility, allocation or transfer limits',async()=>{
  await fc.assert(fc.asyncProperty(fc.integer({min:1,max:10000}),fc.integer({min:0,max:10000}),fc.integer({min:0,max:20000}),fc.boolean(),
    async(balance,fulfilled,billed,closed)=>{
      const f=kitFixture(),quantity=balance+fulfilled;
      Object.assign(f.rows[0],{quantity:-quantity,fulfilled_quantity:fulfilled,billed_quantity:billed,line_closed:closed?'T':'F',backordered_quantity:balance});
      for(const row of f.rows)row.status=fulfilled?'D':'B';
      const order=await readRegularSalesOrder('SO-KIT',f.boundary),line=order.lines[0];
      assert.equal(line.remainingQuantity,closed?0:balance);assert.equal(line.open,!closed);
      order.locationId=28;
      const request={destinationLocationId:28,lines:[{id:1,itemId:1189,sourceLocationId:1,salesQty:balance,salesUom:'PC',decision:'stock'}]};
      if(closed) {
        assert.throws(()=>planRegularStockRouting({request,salesOrder:order}),{code:'REGULAR_SO_MISMATCH'});
        assert.throws(()=>deliveryMaterials(order,28,[line.remoteLineId]));
      } else {
        assert.equal(planRegularStockRouting({request,salesOrder:order}).mappings.reduce((sum,row)=>sum+row.quantity,0),balance);
        assert.equal(deliveryQuantities(deliveryMaterials(order,28),[{itemId:1189,requestableAvailable:quantity*2}])[0].quantity,balance);
      }
    }),{seed:161026,numRuns:200});
});
test('property: kit billing-only changes preserve equality but physical changes do not',async()=>{
  await fc.assert(fc.asyncProperty(fc.integer({min:1,max:1000}),async(billed)=>{
    const f=kitFixture(),before=await readRegularSalesOrder('SO-KIT',f.boundary);
    f.components[0].billed_quantity=billed;
    const after=await readRegularSalesOrder('SO-KIT',f.boundary);
    assert.equal(regularStockKitComponentsMatch(before.lines[1],after.lines[1]),true);
    f.components[0].fulfilled_quantity=1;
    const changed=await readRegularSalesOrder('SO-KIT',f.boundary);
    assert.equal(regularStockKitComponentsMatch(before.lines[1],changed.lines[1]),false);
  }),{seed:161027,numRuns:40});
});
test('property: fulfillment after a saved approval prevents location writes',async()=>{
  await fc.assert(fc.asyncProperty(fc.integer({min:1,max:159}),async(fulfilled)=>{
    const f=kitFixture(),order=await readRegularSalesOrder('SO-KIT',f.boundary);
    f.rows[0].fulfilled_quantity=fulfilled;
    await assert.rejects(()=>applyRegularSalesOrderLocation({order,plan:{sourceLocationId:1,materialLineIds:[order.lines[0].remoteLineId]}},f.boundary),{code:'REGULAR_SO_MISMATCH'});
    assert.equal(f.writes.length,0);
  }),{seed:161028,numRuns:40});
});
test('property: backorders and available stock bound the remaining transfer in both directions',async()=>{
  await fc.assert(fc.asyncProperty(fc.integer({min:1,max:10000}),fc.integer({min:1,max:10000}),fc.integer({min:1,max:10000}),fc.integer({min:0,max:30000}),
    async(balance,fulfilled,seed,available)=>{
      const f=kitFixture(),backorder=1+(seed%balance);
      Object.assign(f.rows[0],{quantity:-(balance+fulfilled),fulfilled_quantity:fulfilled,billed_quantity:balance+fulfilled,backordered_quantity:balance+1});
      const bad=await readRegularSalesOrder('SO-KIT',f.boundary);
      assert.throws(()=>deliveryMaterials(bad,28),{code:'REGULAR_SO_MISMATCH'});
      f.rows[0].backordered_quantity=backorder;
      const materials=deliveryMaterials(await readRegularSalesOrder('SO-KIT',f.boundary),28);
      if(available<backorder)assert.throws(()=>deliveryQuantities(materials,[{itemId:1189,requestableAvailable:available}]),{code:'REGULAR_DELIVERY_STOCK_SHORTAGE'});
      else assert.equal(deliveryQuantities(materials,[{itemId:1189,requestableAvailable:available}])[0].quantity,available>=balance?balance:backorder);
    }),{seed:161029,numRuns:100});
});

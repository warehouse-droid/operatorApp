import assert from 'node:assert/strict';
import test from 'node:test';
import {buildWaitlistSalesOrder,prepareWaitlistSalesOrder,findWaitlistSalesOrder} from '../../../src/regular-waitlist-netsuite.js';
import {waitlistPoSalesQuantity,normalizedWaitlistUnit} from '../../../src/regular-waitlist-supply.js';
const operation={id:'1ad11c97-c8a8-428c-8ce2-ef4e1e6bfb52',requestRef:'STREQ-TEST',customerId:42,itemId:99,quantity:600,salesUom:'SQFT',sellingYardId:1,sellingYard:'3445',fulfillment:{fulfillmentMethod:'pickup'}};
const resolved={locationId:111,subsidiaryId:7,unitsId:3,fulfillmentValues:{pickup:1,delivery:2}};
test('native customer pricing, exact sales quantity and selling yard are sent without a custom rate',()=>{
  const payload=buildWaitlistSalesOrder(operation,resolved);
  assert.equal(payload.entity.id,'42');assert.equal(payload.location.id,'111');assert.equal(payload.subsidiary.id,'7');
  assert.equal(payload.item.items.length,1);const line=payload.item.items[0];
  assert.equal(line.item.id,'99');assert.equal(line.quantity,600);assert.equal(line.units,'3');assert.equal(line.location.id,'111');
  assert.equal(Object.hasOwn(line,'rate'),false);assert.equal(Object.hasOwn(line,'price'),false);
  assert.equal(payload.externalId,'MBBS-WAITLIST-SO:'+operation.id);assert.equal(payload.custbody3.id,'1');
});
test('Delivery maps only To be delivery by and method and preserves NetSuite address and notes',()=>{
  const payload=buildWaitlistSalesOrder({...operation,fulfillment:{fulfillmentMethod:'delivery',deliveryDate:'2026-10-10',deliveryAddress:'Ignored',deliveryInstructions:'Ignored'}},resolved);
  assert.equal(payload.custbody3.id,'2');assert.equal(payload.custbody4,'2026-10-10');
  assert.equal(Object.hasOwn(payload,'shippingAddress'),false);assert.equal(Object.hasOwn(payload,'custbody7'),false);
  const minimum=buildWaitlistSalesOrder({...operation,fulfillment:{fulfillmentMethod:'delivery',deliveryDate:'2026-10-11'}},resolved);
  assert.equal(minimum.custbody4,'2026-10-11');assert.equal(Object.hasOwn(minimum.item.items[0],'rate'),false);
  assert.throws(()=>buildWaitlistSalesOrder({...operation,fulfillment:{fulfillmentMethod:'delivery',deliveryDate:'2026-10-11'}},{...resolved,fulfillmentValues:{pickup:1}}),e=>e.code==='WAITLIST_SO_MAPPING_REQUIRED');
});
test('missing verified unit or sales-yard mapping blocks SO creation',()=>{
  assert.throws(()=>buildWaitlistSalesOrder(operation,{...resolved,unitsId:null}),error=>error.code==='WAITLIST_SO_MAPPING_REQUIRED');
  assert.throws(()=>buildWaitlistSalesOrder(operation,{...resolved,locationId:null}),error=>error.code==='WAITLIST_SO_MAPPING_REQUIRED');
});
test('uncertain conversion recovers only its unique external marker without modifying the SO',async()=>{
  const queries=[];const found=await findWaitlistSalesOrder(operation.id,{queryAll:async sql=>{queries.push(sql);return [{id:'501',tranid:'SO501'}];}});
  assert.deepEqual(found,{salesOrderId:501,salesOrderRef:'SO501'});assert.match(queries[0],/externalid/iu);assert.match(queries[0],/SalesOrd/);assert.match(queries[0],new RegExp(operation.id));
});
test('marker conflicts never guess which SO to use',async()=>{
  await assert.rejects(()=>findWaitlistSalesOrder(operation.id,{queryAll:async()=>[{id:'501',tranid:'SO501'},{id:'502',tranid:'SO502'}]}),error=>error.code==='WAITLIST_SO_MARKER_CONFLICT');
});
test('verified native mappings use the selling yard and preserve the allocated sales-unit quantity',async()=>{
  const payload=await prepareWaitlistSalesOrder(operation,{resolveYards:async rows=>{assert.deepEqual(rows,[{locationId:1,code:'3445'}]);return [{netsuiteLocationId:111,subsidiaryId:7}];},
    resolveUnits:async rows=>{assert.deepEqual(rows,[{itemId:99,itemName:undefined,uom:'SQFT',quantity:600}]);return [{unitId:3}];}});
  assert.equal(payload.item.items[0].quantity,600);assert.equal(payload.item.items[0].units,'3');assert.equal(payload.location.id,'111');
});
test('PO packing units convert to sales UOM while unknown conversions remain blocked',()=>{
  assert.equal(normalizedWaitlistUnit('Box'),'BOX');assert.equal(waitlistPoSalesQuantity({quantity:5,unit:'PLT',to_plt:100},'SQFT'),500);
  assert.equal(waitlistPoSalesQuantity({quantity:2,unit:'EA',to_pcs:3},'SQFT'),6);
  assert.throws(()=>waitlistPoSalesQuantity({quantity:1,unit:'UNKNOWN'},'SQFT'),error=>error.code==='WAITLIST_PO_UNIT_INVALID');
});

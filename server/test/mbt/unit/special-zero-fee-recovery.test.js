import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpecialStockRequestService} from '../../../src/special-stock-request-service.js';

test('a submitted legacy SO links its number without verifying its existing zero fee or changing NetSuite',async()=>{
  const detail={id:95,revision:3,netsuiteCustomerId:2008,operationalYardLocationId:1,fulfillmentMethod:'mbt_delivery',
    deliveryDate:'2099-02-01',salesOrderSubmissionStartedAt:'2026-10-06T00:00:00Z',salesDiscountMode:'total',
    salesOrderLines:[{itemId:2055,ancillary:false,description:'Reviewed material',quantity:98.08,uom:'SQFT',rate:6.4,nativeDiscountPercent:10},
      {itemId:1987,ancillary:true,description:'Delivery Charge',quantity:1,uom:null,rate:0}]};
  const calls=[],unexpected=async()=>{throw Error('Recovery must not create, submit or update an order');};
  const service=createSpecialStockRequestService({config:{deliveryMethodId:1,pickupMethodId:2},
    getCase:async()=>detail,claimOperation:async()=>detail,resolveLocations:async()=>[{netsuiteLocationId:1}],
    findMarkerOrders:async()=>[{id:1042000,entity_id:2008,location_id:1}],
    resolveOrderUnits:async lines=>lines.map(line=>({...line,unitId:line.itemId===2055?866:null})),
    fetchSalesOrderReference:async()=>({tranid:'TEST-SOB',status:'SalesOrd:B',status_text:'Pending Fulfillment'}),
    verifyDiscountSalesOrder:unexpected,
    linkSalesOrder:async()=>{calls.push('link');return detail;},markSubmitted:unexpected,createSalesOrder:unexpected,
    createDiscountSalesOrder:unexpected,failOperation:async()=>calls.push('failed'),sleep:async()=>{}});
  assert.equal(await service.createSalesOrder(95,{expectedRevision:3,operationId:'01911111-1111-7111-8111-111111111131'}),detail);
  assert.deepEqual(calls,['link']);
});

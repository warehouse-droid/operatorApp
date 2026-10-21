import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { fixture } from '../../support/operator-suiteql-fixture.mjs';
import { createSpecialStockRequestService } from '../../../src/special-stock-request-service.js';
import { buildSpecialPurchaseOrderPayload } from '../../../src/special-stock-request-netsuite.js';
import { specialVendorLineDiscountReview } from '../../../public/special-stock-purchase-pricing.js';

let transport;
before(async () => { transport = await fixture(); });
after(async () => { await transport.close(); });
const materials = () => [10,20].map((discount,index) => ({caseLineId:index+1,itemId:2055,quantity:1,uom:'PC',unitId:865,
  unitPurchaseCost:100,vendorDiscountPercent:discount,description:`Reviewed material ${index+1}`}));

test('standalone PO uses its stable case marker as externalId without an SO link', () => {
  const lines=materials();
  const payload=buildSpecialPurchaseOrderPayload({caseId:42,vendorId:331,netsuiteLocationId:1,lines,
    vendorDiscountReview:specialVendorLineDiscountReview(lines)});
  assert.equal(payload.externalId,'MBBS-SPECIAL-PO:42');
  assert.equal(payload.createdFrom,undefined);
});

for (const lostResponse of [false,true]) test(`default Special PO boundary posts standalone REST with one discount${lostResponse ? ' and recovers a lost response' : ''}`,async () => {
  const lines=materials(),calls=[],events=[];
  let posted=false;
  const detail={id:42,revision:7,salesOrderId:101,salesOrderRef:'TEST-SO101',salesOrderApproved:true,customerId:8444,vendorId:331,operationalYardLocationId:1,
    vendorDiscountReview:specialVendorLineDiscountReview(lines),purchaseOrderLines:lines,
    salesOrderLines:lines.map(line=>({...line,remoteLineId:9000+line.caseLineId,rate:200,nativeDiscountPercent:50}))};
  transport.state.handle=async request=>{
    calls.push(request);
    if(request.method!=='POST'||!request.url.pathname.endsWith('/record/v1/purchaseOrder')) return {status:400,data:{error:'Only standalone PO REST POST is permitted'}};
    posted=true;
    return lostResponse ? {status:400,data:{error:'Response lost after commit'}} : {status:204,headers:{location:'/services/rest/record/v1/purchaseOrder/303'}};
  };
  const service=createSpecialStockRequestService({getCase:async()=>detail,claimOperation:async()=>detail,
    markSubmitted:async()=>{events.push('submitted');return detail;},resolveLocations:async()=>[{netsuiteLocationId:1}],
    resolveOrderUnits:async lines=>lines,findMarkerOrders:async()=>posted?[{id:303,entity_id:331,location_id:1}]:[],
    findLinkedPurchaseOrder:async()=>null,
    assertPurchaseOrderReady:async()=>{throw Error('RESTlet readiness must not run');},
    finalizeLinkedPurchaseOrder:async()=>{throw Error('A standalone PO has no native finalization');},
    synchronizeSalesDescriptions:async()=>{throw Error('Unchanged SO must not be written');},
    fetchPurchaseOrderReference:async id=>{assert.equal(id,303);return{tranid:'TEST-PO303'};},
    recordPurchaseOrderCreation:async input=>{events.push('history');assert.equal(input.creationSnapshot.salesOrderId,101);},
    linkPurchaseOrder:async(_id,input)=>{events.push('link');return{...detail,purchaseOrderId:input.purchaseOrderId};},
    failOperation:async()=>events.push('failed'),sleep:async()=>{}});
  const result=await service.createPurchaseOrder(42,{expectedRevision:7,operationId:'01911111-1111-7111-8111-111111111142'});
  assert.equal(result.purchaseOrderId,303);
  assert.deepEqual(events,['submitted','history','link']);
  assert.equal(calls.length,1);
  const payload=calls[0].body;
  assert.equal(payload.createdFrom,undefined);
  assert.equal(payload.externalId,'MBBS-SPECIAL-PO:42');
  assert.deepEqual(payload.item.items.map(line=>[line.item.id,line.quantity,line.rate]),[['2055',1,100],['2055',1,100],['4981',1,-30]]);
  assert.equal(payload.item.items.at(-1).description,'Vendor discount | MBBS-SPECIAL-PO:42');
});

/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {createSpecialStockRequestService} from '../../../src/special-stock-request-service.js';

function fixture(quantity,discount=0,{draft=false,submitted=false,marker=false}={}) {
  const detail={id:42,requestRef:'SPREQ-000042',revision:8,vendorId:331,operationalYardLocationId:1,storeName:'3445',
    salesOrderSource:'manual_link',salesOrderId:101,salesOrderRef:'SO101',salesOrderApproved:false,
    purchaseOrderCustomLinkage:true,purchaseOrderSubmissionStartedAt:submitted?'2026-10-06T00:00:00Z':null,
    salesOrderLines:draft?[{caseLineId:1,itemId:2055,quantity:3,uom:'PC',description:'Old SO',rate:99,remoteLineId:7}]:[],
    purchaseOrderLines:[{caseLineId:1,itemId:2055,quantity,uom:'SQFT',description:'Request material',unitPurchaseCost:6}],
    vendorDiscountReview:{mode:'per_line',amount:Math.round(quantity*6*discount)/100,lines:[{caseLineId:1,vendorDiscountPercent:discount}]}};
  const calls=[];let posted=false;
  const forbidden=async()=>{throw Error('Manual SO must never be read, matched, synchronized or finalized');};
  const service=createSpecialStockRequestService({getCase:async()=>structuredClone(detail),preparePurchaseOrder:async()=>structuredClone(detail),
    claimOperation:async()=>structuredClone(detail),markSubmitted:async()=>{calls.push('mark');return {...structuredClone(detail),purchaseOrderSubmissionStartedAt:'2026-10-06T00:00:00Z'};},
    resolveLocations:async()=>[{netsuiteLocationId:1,subsidiaryId:2}],resolveOrderUnits:async lines=>lines.map(line=>({...line,unitId:865})),
    synchronizeSalesDescriptions:forbidden,recordDescriptionSync:forbidden,fetchSalesOrderReference:forbidden,
    findLinkedPurchaseOrder:forbidden,finalizeLinkedPurchaseOrder:forbidden,
    findMarkerOrders:async input=>{assert.equal(input.salesOrderId,null);return marker||posted?[{id:202,entity_id:331,location_id:1}]:[];},
    createPurchaseOrder:async payload=>{assert.ok(calls.includes('mark'));posted=true;calls.push(payload);return {id:202};},
    fetchPurchaseOrderReference:async()=>({tranid:'PO202',status_text:'Pending Receipt'}),recordPurchaseOrderCreation:async()=>{},
    linkPurchaseOrder:async(_id,input)=>input,failOperation:async()=>{},sleep:async()=>{}});
  return {service,detail,calls};
}
test('property: any manual SO creates a standalone PO from reviewed request values without SO access',async()=>{
  await fc.assert(fc.asyncProperty(fc.integer({min:1,max:100000}),fc.integer({min:0,max:100}),fc.boolean(),async(quantity,discount,draft)=>{
    const f=fixture(quantity,discount,{draft});const before=structuredClone(f.detail);
    const result=await f.service.createPurchaseOrder(42,{expectedRevision:8,operationId:'test'});
    assert.equal(result.purchaseOrderId,202);assert.deepEqual(f.detail,before);assert.equal(f.calls.length,2);
    const payload=f.calls[1];assert.equal(payload.custbody7,'for SO101');assert.equal(payload.createdFrom,undefined);
    assert.deepEqual([payload.item.items[0].item.id,payload.item.items[0].quantity,payload.item.items[0].units,payload.item.items[0].rate],['2055',quantity,'865',6]);
    assert.equal(payload.item.items[0].description,'Request material');
    assert.equal(payload.item.items.find(line=>line.item.id==='4981')?.rate ?? 0,-Math.round(quantity*6*discount)/100 || 0);
  }),{seed:26100638,numRuns:40});
});
test('manual SO marker recovery preserves the durable no-resubmission rule',async()=>{
  for(const submitted of [false,true]){
    const f=fixture(144,0,{submitted,marker:true});const result=await f.service.createPurchaseOrder(42,{expectedRevision:8,operationId:'test'});
    assert.equal(result.purchaseOrderId,202);assert.deepEqual(f.calls,[]);
  }
  const f=fixture(144,0,{submitted:true});await assert.rejects(f.service.createPurchaseOrder(42,{expectedRevision:8,operationId:'test'}),{code:'SPECIAL_REMOTE_OUTCOME_UNCERTAIN'});assert.deepEqual(f.calls,[]);
});

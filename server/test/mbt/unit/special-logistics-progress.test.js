import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { specialPlanningStatus } from '../../../public/special-stock-case-status.js';
const pickup = '2026-10-02T20:52:07.060Z', arrival = '2026-10-02T23:00:11.110Z', delivered = '2026-10-05T13:34:03.290Z';
const base = { id:95,salesOrderId:1033108,salesOrderRef:'SOB121882',purchaseOrderId:995310,purchaseOrderRef:'POB03883',
  purchaseOrderReference:'SN1400411',purchaseOrderApproved:true,fulfillmentMethod:'mbt_delivery',handoffRoute:'via_yard',
  salesOrderStatus:'Sales Order : Pending Billing',purchaseOrderStatus:'Purchase Order : Pending Bill',
  dispatchPlanning:{anyPlanned:true,salesOrder:{planned:true,plans:[{planDate:'2026-10-05',estimatedArrivalMinute:593}]},purchaseOrder:{planned:true,plans:[]}} };
for (const compact of [false,true]) {
  test(`Sales sees actual delivery and yard arrival times, compact=${compact}`,()=>{
    const html=specialPlanningStatus({...base,operationallyComplete:true,operationallyCompletedAt:delivered,
      purchaseOrderReceiptStatus:'received',purchaseOrderReceivedAt:'2026-10-02T22:48:02.339Z',purchaseOrderDropoffAt:arrival},compact,{audience:'sales',showOrderPreviews:!compact});
    assert.match(html,/SO delivery: Delivered/);assert.match(html,/PO receipt: Arrived at yard/);
    assert.match(html,/2026-10-05 09:34:03 EDT/);assert.match(html,/2026-10-02 19:00:11 EDT/);
    assert.doesNotMatch(html,/Pending Billing|Pending Bill|NetSuite:|Est\. arrival|18:48:02/);
    assert.match(html,/datetime="2026-10-05T13:34:03.290Z"/);
    if(!compact){assert.match(html,/data-special-document="sales_order"/);assert.doesNotMatch(html,/data-special-document="purchase_order"/);}
  });
}
test('driver pickup precedes planning while an in-progress job does not supply completed evidence',()=>{
 const html=specialPlanningStatus({...base,salesOrderPickedUpAt:'2026-10-05T11:01:47.688Z',purchaseOrderPickedUpAt:pickup},false,{audience:'sales'});
 assert.equal((html.match(/Picked up by driver/g)||[]).length,2);
 assert.match(html,/2026-10-05 07:01:47 EDT/);assert.match(html,/2026-10-02 16:52:07 EDT/);assert.doesNotMatch(html,/Planned|Delivered|Arrived at yard|Est\. arrival/);
});
test('yard receipt uses recorded receipt completion only when driver dropoff time is unavailable',()=>{
 const html=specialPlanningStatus({...base,purchaseOrderReceiptStatus:'received',purchaseOrderReceivedAt:'2026-10-02T22:48:02.339Z'},false,{audience:'sales'});
 assert.match(html,/PO receipt: Arrived at yard/);assert.match(html,/2026-10-02 18:48:02 EDT/);
});
test('direct delivery is Delivered and never described as a yard arrival',()=>{
 const html=specialPlanningStatus({...base,handoffRoute:'direct',operationallyComplete:true,operationallyCompletedAt:delivered,purchaseOrderDropoffAt:delivered},false,{audience:'sales'});
 assert.match(html,/PO delivery: Delivered/);assert.doesNotMatch(html,/Arrived at yard/);
});
test('partial yard receipt is not full arrival and missing or invalid actual times are not invented',()=>{
 for(const stamp of [null,'invalid']) {
  const html=specialPlanningStatus({...base,operationallyComplete:true,operationallyCompletedAt:stamp,purchaseOrderReceiptStatus:'partial_received'},false,{audience:'sales'});
  assert.match(html,/PO receipt: Partially arrived at yard/);assert.match(html,/SO delivery: Delivered/);
  assert.doesNotMatch(html,/<time|Invalid Date|Est\. arrival/);
 }
});
test('partial receipt remains partial after a completed driver dropoff',()=>{
 const html=specialPlanningStatus({...base,purchaseOrderDropoffAt:arrival,purchaseOrderReceiptStatus:'partial_received'},false,{audience:'sales'});
 assert.match(html,/PO receipt: Partially arrived at yard/);assert.doesNotMatch(html,/PO receipt: Arrived at yard|2026-10-02 19:00:11 EDT/);
});
test('winter completion uses EST and SCM retains the current NetSuite status',()=>{
 const html=specialPlanningStatus({...base,operationallyComplete:true,operationallyCompletedAt:'2026-01-15T14:34:03Z'},false,{audience:'scm',showOrderPreviews:true});
 assert.match(html,/2026-01-15 09:34:03 EST/);assert.match(html,/NetSuite: Sales Order : Pending Billing/);
});
test('customer yard pickup shows its actual collection time',()=>{
 const html=specialPlanningStatus({...base,fulfillmentMethod:'yard_pickup',salesOrderPickupCompletedAt:delivered},false,{audience:'sales'});
 assert.match(html,/SO pickup: Picked up by customer/);assert.match(html,/2026-10-05 09:34:03 EDT/);
 assert.doesNotMatch(html,/SO delivery: Delivered|SO planning:|NetSuite:/);
});
test('property: completion dates are the recorded instant converted to Toronto, never ETA or now',()=>{
 fc.assert(fc.property(fc.integer({min:0,max:59}),second=>{
  const stamp=`2026-10-05T13:34:${String(second).padStart(2,'0')}Z`;
  const html=specialPlanningStatus({...base,operationallyComplete:true,operationallyCompletedAt:stamp},false,{audience:'sales'});
  assert.match(html,new RegExp(`2026-10-05 09:34:${String(second).padStart(2,'0')} EDT`));
  assert.doesNotMatch(html,/Est\. arrival: 2026-10-05/);
 }),{seed:20261010,numRuns:100});
});

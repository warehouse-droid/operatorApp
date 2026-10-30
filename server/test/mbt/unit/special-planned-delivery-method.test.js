import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { canEditSpecialFulfillment, specialFulfillmentEditor } from '../../../public/special-stock-fulfillment.js';

test('property: Special planning flags leave an active unstarted fulfillment editor available', () => {
  fc.assert(fc.property(fc.boolean(),fc.boolean(),fc.constantFrom('ready','planned','waiting_route'),(so,po,status)=>{
    const detail={closeStatus:'active',stage:'dispatch_arrangement',dispatchPlanned:so,dispatchPlanning:{anyPlanned:po},handoff:{status},fulfillmentMethod:'yard_pickup',salesOrderId:1,purchaseOrderId:2};
    assert.equal(canEditSpecialFulfillment(detail),true);
    assert.match(specialFulfillmentEditor(detail),/data-special-fulfillment-form/);
    for (const change of [{closeStatus:'closed'},{operationallyComplete:true},{stage:'completed'},{handoff:{status:'in_progress'}},{handoff:{status:'completed'}},{fulfillmentExecutionStarted:true}]) {
      assert.equal(canEditSpecialFulfillment({...detail,...change}),false);
    }
    if(so||po||status==='planned')assert.equal(canEditSpecialFulfillment({...detail,workflowKind:'backorder'}),false);
  }),{seed:20261027,numRuns:60});
});

test('property: PO arrival offers exactly yard pickup and delivery without locking the inbound handoff',()=>{
 fc.assert(fc.property(fc.constantFrom('purchaseOrderReceivedAt','purchaseOrderDropoffAt'),fc.constantFrom('vendor_pickup','yard_pickup','mbt_delivery'),(arrival,method)=>{
  const d={closeStatus:'active',stage:'dispatch_arrangement',fulfillmentMethod:method,salesOrderId:1,purchaseOrderId:2,
   [arrival]:'2026-10-20T18:31:40Z',handoff:{route:'via_yard',status:'completed'}};
  assert.equal(canEditSpecialFulfillment(d),true);
  const html=specialFulfillmentEditor(d);
  assert.deepEqual([...html.matchAll(/<option value="([^"]+)"/g)].map(match=>match[1]),['yard_pickup','mbt_delivery']);
  assert.equal(canEditSpecialFulfillment({...d,salesOrderStatus:'Sales Order : Pending Billing'}),false);
 }),{seed:20261028,numRuns:60});
});

test('fulfilled SO status locks editing even when the local stage is stale',()=>{
 for(const status of ['Sales Order : Pending Billing','Fully Fulfilled','Billed']) {
  const d={closeStatus:'active',stage:'dispatch_arrangement',salesOrderStatus:status,fulfillmentMethod:'mbt_delivery'};
  assert.equal(canEditSpecialFulfillment(d),false);
  assert.doesNotMatch(specialFulfillmentEditor(d),/select name="fulfillmentMethod"/);
 }
});

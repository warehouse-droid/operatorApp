import assert from 'node:assert/strict';
import test from 'node:test';
import {specialStage,specialPurchaseOrderDispatchReady} from '../../../public/special-stock-workflow.js';
import {backorderStage,backorderBucket} from '../../../public/backorder-workflow.js';

const ordered={salesOrderId:51,purchaseOrderId:52,purchaseOrderApproved:true,fulfillmentMethod:'mbt_delivery',linesResolved:true,hasAcceptedLines:true};
const queued={...ordered,purchaseOrderReference:'VENDOR-REF-52',purchaseOrderDispatchStatus:'Queued'};

test('Special requires SO for Confirmed while Backorder requires accepted materials',()=>{
  for(const derive of [specialStage,backorderStage]) {
    for(const salesOrderId of [null,51]) for(const purchaseOrderId of [null,52]) {
      for(const purchaseOrderReference of [undefined,'','  ']) for(const purchaseOrderDispatchStatus of [undefined,'Hold','Queued','Planned']) {
        assert.equal(derive({...ordered,salesOrderId,purchaseOrderId,purchaseOrderReference,purchaseOrderDispatchStatus}),derive===specialStage&&!salesOrderId?'await_customer_confirmation':'confirmed');
      }
    }
  }
});

test('the canonical PO reference and Queued status are both required for dispatch',()=>{
  for(const derive of [specialStage,backorderStage]) {
    for(const status of [undefined,'','Hold','Cancelled','Surplus Only','Urgent','Priority','Book Appt']) {
      assert.equal(derive({...queued,purchaseOrderDispatchStatus:status}),'confirmed');
    }
    assert.equal(derive(queued),'dispatch_arrangement');
    assert.equal(derive({...queued,waitingForProduction:true}),'dispatch_arrangement');
    assert.equal(backorderBucket(derive(queued)),'pending');
  }
  assert.equal(specialPurchaseOrderDispatchReady({...queued,purchaseOrderReference:52}),false);
  assert.equal(specialPurchaseOrderDispatchReady({...queued,purchaseOrderDispatchStatus:' queued '}),true);
});

test('queued requests retain dispatch arrangement through planning and transport',()=>{
  for(const status of ['Planned','In Transit','Partially Done','Completed','Complete']) {
    for(const derive of [specialStage,backorderStage]) assert.equal(derive({...queued,purchaseOrderDispatchStatus:status}),'dispatch_arrangement');
  }
});

test('closure, actual completion and information requests retain precedence',()=>{
  for(const derive of [specialStage,backorderStage]) {
    assert.equal(derive({...queued,closed:true,operationallyComplete:true}),'closed');
    assert.equal(derive({...queued,cancelled:true}),'closed');
    assert.equal(derive({...queued,operationallyComplete:true,pendingUpdate:true}),'completed');
    assert.equal(derive({...queued,pendingUpdate:true}),'pending_update');
  }
  assert.equal(backorderStage({linesResolved:true,hasAcceptedLines:false,hasAlreadyOrderedLines:true}),'completed');
  assert.equal(backorderStage({linesResolved:true,hasAcceptedLines:false}),'closed');
});

test('Special approval and deliberate PO skips keep their existing rules',()=>{
  assert.equal(specialStage({...queued,purchaseOrderApproved:false}),'confirmed');
  assert.equal(backorderStage({...queued,purchaseOrderApproved:false}),'dispatch_arrangement');
  assert.equal(specialStage({salesOrderSkipped:true,purchaseOrderSkipped:true,fulfillmentMethod:'yard_pickup'}),'dispatch_arrangement');
  assert.equal(specialStage({salesOrderSkipped:true,purchaseOrderSkipped:true,fulfillmentMethod:'vendor_pickup'}),'waiting_customer_pickup');
});

test('customer pickup at the vendor yard waits for the customer once the PO reference is queued',()=>{
  const pickup={...queued,fulfillmentMethod:'vendor_pickup'};
  assert.equal(specialStage(pickup),'waiting_customer_pickup');
  assert.equal(specialStage({...pickup,purchaseOrderSentToVendorAt:'2099-01-01T00:00:00Z'}),'waiting_customer_pickup');
  for(const status of ['Planned','In Transit','Completed']) assert.equal(specialStage({...pickup,purchaseOrderDispatchStatus:status}),'waiting_customer_pickup');
  assert.equal(specialStage({...pickup,purchaseOrderDispatchStatus:'Hold',purchaseOrderSentToVendorAt:'2099-01-01T00:00:00Z'}),'waiting_vendor_confirmation');
  assert.equal(specialStage({...pickup,purchaseOrderReference:''}),'confirmed');
  assert.equal(specialStage({...pickup,purchaseOrderApproved:false}),'confirmed');
  assert.equal(specialStage({...pickup,operationallyComplete:true}),'completed');
  assert.equal(specialStage({...pickup,pendingUpdate:true}),'pending_update');
});

test('pickup at the inquired yard waits for the customer once the PO is received, before any dispatch reference',()=>{
  const yard={...ordered,fulfillmentMethod:'yard_pickup',purchaseOrderSentToVendorAt:'2099-01-01T00:00:00Z'};
  assert.equal(specialStage(yard),'waiting_vendor_confirmation');
  assert.equal(specialStage({...yard,purchaseOrderReceived:true}),'waiting_customer_pickup');
  assert.equal(specialStage({...yard,purchaseOrderReceived:true,purchaseOrderReference:'REF',purchaseOrderDispatchStatus:'Queued'}),'waiting_customer_pickup');
  assert.equal(specialStage({...yard,purchaseOrderReference:'REF',purchaseOrderDispatchStatus:'Queued'}),'dispatch_arrangement');
  assert.equal(specialStage({...yard,purchaseOrderReceived:true,operationallyComplete:true}),'completed');
  assert.equal(specialStage({...yard,purchaseOrderReceived:true,closed:true}),'closed');
  // Delivery still needs Dispatch after the PO arrives; backorders keep their own rules.
  assert.equal(specialStage({...queued,purchaseOrderReceived:true}),'dispatch_arrangement');
  assert.equal(backorderStage({...queued,fulfillmentMethod:'yard_pickup',purchaseOrderReceived:true}),'dispatch_arrangement');
});

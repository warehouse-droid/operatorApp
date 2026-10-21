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

test('Special approval, customer vendor pickup and deliberate PO skips keep their existing rules',()=>{
  assert.equal(specialStage({...queued,purchaseOrderApproved:false}),'confirmed');
  assert.equal(backorderStage({...queued,purchaseOrderApproved:false}),'dispatch_arrangement');
  assert.equal(specialStage({...queued,fulfillmentMethod:'vendor_pickup'}),'confirmed');
  assert.equal(specialStage({salesOrderSkipped:true,purchaseOrderSkipped:true,fulfillmentMethod:'yard_pickup'}),'dispatch_arrangement');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {SPECIAL_STAGES,specialStage,parseStages,stageFilterHtml} from '../../../public/special-stock-workflow.js';
import {createBackorderUI} from '../../../public/backorder-stock-requests.js';
import {backorderStage} from '../../../public/backorder-workflow.js';
const choices=fc.record({purchaseOrderId:fc.option(fc.integer({min:1,max:100000}),{nil:null}),waitingForProduction:fc.boolean(),purchaseOrderApproved:fc.boolean(),purchaseOrderReference:fc.constantFrom('',' REF '),purchaseOrderDispatchStatus:fc.constantFrom('Hold','Queued','Planned'),fulfillmentMethod:fc.constantFrom('mbt_delivery','yard_pickup','vendor_pickup'),purchaseOrderSentToVendorAt:fc.constantFrom(null,'2026-10-16T20:00:00.000Z')});
test('Special accepted stock and ETA decisions without SO keep Await Customer Confirmation',()=>{
  fc.assert(fc.property(choices,e=>assert.equal(specialStage({...e,linesResolved:true,hasAcceptedLines:true}),'await_customer_confirmation')),{numRuns:300,seed:20261016});
  assert.equal(specialStage({}),'new_enquiry');
  assert.equal(specialStage({purchaseOrderId:42}),'await_customer_confirmation');
});
test('sent linked PO waits for the vendor until its existing dispatch handoff',()=>{
  fc.assert(fc.property(choices,e=>{
    const input={...e,salesOrderId:1,purchaseOrderId:2,purchaseOrderReference:'',purchaseOrderSentToVendorAt:'2026-10-16T20:00:00Z'};
    assert.equal(specialStage(input),'waiting_vendor_confirmation');
    assert.equal(specialStage({...input,purchaseOrderSentToVendorAt:null}),'confirmed');
    assert.equal(specialStage({...input,purchaseOrderId:null}),'confirmed');
    const queued={...input,purchaseOrderApproved:true,purchaseOrderReference:'VENDOR-REF',purchaseOrderDispatchStatus:'Queued'};
    assert.equal(specialStage(queued),e.fulfillmentMethod==='vendor_pickup'?'waiting_vendor_confirmation':'dispatch_arrangement');
  }),{numRuns:200,seed:20261017});
});
test('terminal and pending-information states retain precedence over vendor acknowledgement',()=>{
  fc.assert(fc.property(choices,e=>{
    const input={...e,salesOrderId:1,purchaseOrderId:2,purchaseOrderSentToVendorAt:'2026-10-16T20:00:00Z'};
    assert.equal(specialStage({...input,closed:true}),'closed');
    assert.equal(specialStage({...input,cancelled:true}),'closed');
    assert.equal(specialStage({...input,operationallyComplete:true}),'completed');
    assert.equal(specialStage({...input,pendingUpdate:true}),'pending_update');
  }),{numRuns:100,seed:20261018});
});
test('vendor waiting label and filter are available to both Special queues',()=>{
  assert.equal(SPECIAL_STAGES.waiting_vendor_confirmation,'Waiting Vendor Confirmation');
  assert.deepEqual(parseStages('waiting_vendor_confirmation'),['waiting_vendor_confirmation']);
  assert.match(stageFilterHtml(['waiting_vendor_confirmation']),/value="waiting_vendor_confirmation" checked> Waiting Vendor Confirmation/);
});
test('regular Backorder confirmation and SO skips retain their existing milestones',()=>{
  fc.assert(fc.property(choices,e=>{
    const input={...e,purchaseOrderReference:'',linesResolved:true,hasAcceptedLines:true};
    assert.equal(backorderStage(input),'confirmed');
    assert.equal(specialStage({...input,salesOrderSkipped:true,purchaseOrderId:null}),'confirmed');
    assert.equal(specialStage({...input,salesOrderSkipped:true,purchaseOrderSkipped:true,purchaseOrderId:null,fulfillmentMethod:'yard_pickup'}),e.waitingForProduction?'confirmed':'dispatch_arrangement');
  }),{numRuns:100,seed:20261019});
});

test('the vendor waiting filter is limited to Special requests',()=>{
  globalThis.window ??= {};
  for(const audience of ['sales','scm']) {
    const ui=createBackorderUI({mount:{addEventListener(){}},audience,api:async()=>({vendors:[]}),getDetail:()=>null,setDetail(){},render(){}});
    assert.doesNotMatch(ui.filter('backorder','','data-filter'),/waiting_vendor_confirmation|Waiting Vendor Confirmation/);
    assert.match(ui.filter('backorder','','data-filter'),/Confirmed/);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {backorderStage,backorderPurchaseReady} from '../../../public/backorder-workflow.js';

test('property: completed materials never hold up PO readiness for the remaining accepted materials',()=>{
  fc.assert(fc.property(fc.array(fc.constantFrom('pending','accepted','request_update','declined','closed'),{minLength:1,maxLength:30}),decisions=>{
    const done=decisions.map(salesDecision=>({salesDecision,supplyStatus:'already_ordered',stockCheckedAt:'2026-10-08'}));
    const accepted={salesDecision:'accepted',supplyStatus:'in_stock',stockCheckedAt:'2026-10-08'};
    assert.equal(backorderPurchaseReady({lines:done}),false);
    assert.equal(backorderPurchaseReady({lines:[...done,accepted]}),true);
    assert.equal(backorderPurchaseReady({lines:[...done,{...accepted,salesDecision:'pending'}]}),false);
  }),{seed:8102026,numRuns:200});
});
test('property: all resolved Already Ordered cases complete before information and linking stages, with explicit closure respected',()=>{
  fc.assert(fc.property(fc.boolean(),fc.boolean(),fc.boolean(),fc.boolean(),(closed,pendingUpdate,purchase,sales)=>{
    const evidence={closed,pendingUpdate,hasAlreadyOrderedLines:true,linesResolved:true,hasAcceptedLines:false,purchaseOrderId:purchase?1:null,salesOrderId:sales?2:null};
    assert.equal(backorderStage(evidence),closed?'closed':'completed');
    assert.equal(backorderStage({...evidence,closed:false,hasAlreadyOrderedLines:false,salesOrderId:null}), 'closed');
  }),{seed:8102027,numRuns:100});
});

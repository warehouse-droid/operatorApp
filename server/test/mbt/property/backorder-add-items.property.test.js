import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {canAddBackorderItems,backorderAddItemsButton} from '../../../public/backorder-add-items.js';

const base=()=>({requestType:'regular',workflowKind:'backorder',status:'submitted',closeStatus:'active',stage:'new_enquiry',lines:[{}]});
test('Backorder Add item eligibility follows saved order, lifecycle and operation state',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:99}),fc.constantFrom('submitted','active'),fc.constantFrom('new_enquiry','await_customer_confirmation','confirmed','pending_update'),(count,status,stage)=>{
    const d={...base(),status,stage,lines:Array.from({length:count},()=>({}))};
    assert.equal(canAddBackorderItems(d),true);assert.match(backorderAddItemsButton(d,false),/special-add-item-button/);
    for(const patch of [{workflowKind:'special',requestType:'special'},{status:'cancelled'},{closeStatus:'closed'},{stage:'closed'},{stage:'completed'},{operationallyComplete:true},
      {salesOrderId:123},{purchaseOrderId:124},{salesOrderRef:'SO-X'},{purchaseOrderRef:'PO-X'},{alreadyOrderedSalesOrderRef:'SO-MANUAL'},
      {salesOrderSubmissionStartedAt:'today'},{purchaseOrderSubmissionStartedAt:'today'},{attention:true},{quantityReviewPending:true},
      {salesOrderOperationStatus:'creating'},{purchaseOrderOperationStatus:'attention'},{fulfillmentChange:{status:'pending'}},{lines:[]},{lines:Array(100).fill({})}]) {
      const blocked={...d,...patch};assert.equal(canAddBackorderItems(blocked),false,JSON.stringify(patch));assert.equal(backorderAddItemsButton(blocked,false),'');
    }
    assert.match(backorderAddItemsButton(d,true),/disabled/);
  }),{numRuns:200});
  assert.equal(canAddBackorderItems(null),false);
  assert.equal(canAddBackorderItems({...base(),lines:undefined}),false);
});

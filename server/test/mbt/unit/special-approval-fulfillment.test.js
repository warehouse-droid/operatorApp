import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {specialStage} from '../../../public/special-stock-workflow.js';
import {specialPlanningStatus} from '../../../public/special-stock-case-status.js';
import {specialDispatchPlanning} from '../../../src/special-stock-planning.js';
test('property: a real unapproved PO remains Confirmed until approval, except terminal stages',()=>{
 fc.assert(fc.property(fc.boolean(),fc.boolean(),fc.constantFrom('vendor_pickup','yard_pickup','mbt_delivery'),(waiting,approved,method)=>{
 const e={salesOrderId:11,purchaseOrderId:12,purchaseOrderApproved:approved,waitingForProduction:waiting,fulfillmentMethod:method};
 assert.equal(specialStage(e),!approved||waiting||method==='vendor_pickup'?'confirmed':'dispatch_arrangement');
 assert.equal(specialStage({...e,closed:true}),'closed');assert.equal(specialStage({...e,operationallyComplete:true}),'completed');
 }));
});
test('pending PO notice is visible with compact, detail and document planning displays',()=>{
 for(const compact of [false,true]) for(const showOrderPreviews of [false,true]) assert.match(specialPlanningStatus({purchaseOrderId:12,purchaseOrderApproved:false,purchaseOrderPendingApproval:true},compact,{showOrderPreviews}),/PO approval pending/i);
});
test('PO reference rename cannot bypass Special planning lock',()=>{
 const d={purchaseOrderId:12,purchaseOrderRef:'PO-NATIVE',purchaseOrderReference:'VENDOR-REF'};
 const plans=[{id:1,status:'draft',trucks:[{loads:[{stops:[{type:'pickup',orderId:'VENDOR-REF'}]}]}]}];
 assert.equal(specialDispatchPlanning(d,plans).anyPlanned,true);
});

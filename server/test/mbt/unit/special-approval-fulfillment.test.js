import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {specialStage} from '../../../public/special-stock-workflow.js';
import {specialPlanningStatus} from '../../../public/special-stock-case-status.js';
import {specialDispatchPlanning} from '../../../src/special-stock-planning.js';
test('property: real POs require approval and a queued reference before dispatch; terminal stages take precedence',()=>{
 fc.assert(fc.property(fc.boolean(),fc.boolean(),fc.boolean(),fc.boolean(),fc.constantFrom('vendor_pickup','yard_pickup','mbt_delivery'),(waiting,approved,reference,queued,method)=>{
 const e={salesOrderId:11,purchaseOrderId:12,purchaseOrderApproved:approved,waitingForProduction:waiting,fulfillmentMethod:method,
   purchaseOrderReference:reference?'TEST-REF':'',purchaseOrderDispatchStatus:queued?'Queued':'Hold'};
 assert.equal(specialStage(e),approved&&reference&&queued?'dispatch_arrangement':'confirmed');
 assert.equal(specialStage({...e,closed:true}),'closed');assert.equal(specialStage({...e,operationallyComplete:true}),'completed');
 }),{seed:20261030,numRuns:500});
});
test('pending PO notice is visible with compact, detail and document planning displays',()=>{
 for(const compact of [false,true]) for(const showOrderPreviews of [false,true]) assert.match(specialPlanningStatus({purchaseOrderId:12,purchaseOrderApproved:false,purchaseOrderPendingApproval:true},compact,{showOrderPreviews}),/PO approval pending/i);
});
test('PO reference rename cannot bypass Special planning lock',()=>{
 const d={purchaseOrderId:12,purchaseOrderRef:'PO-NATIVE',purchaseOrderReference:'VENDOR-REF'};
 const plans=[{id:1,status:'draft',trucks:[{loads:[{stops:[{type:'pickup',orderId:'VENDOR-REF'}]}]}]}];
 assert.equal(specialDispatchPlanning(d,plans).anyPlanned,true);
});

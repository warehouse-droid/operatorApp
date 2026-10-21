import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {isBackorder,backorderStage,backorderBucket,assertBackorderLocalAction,assertBackorderNoAncillary} from '../../../public/backorder-workflow.js';
import {assertRegularNotBackorder} from '../../../src/backorder-request-service.js';
import {stockCaseWorkflow,withBackorderWorkflow} from '../../../src/stock-case-workflow.js';

test('Backorder completes on operational evidence; linked orders stay in the pending bucket',()=>{
  fc.assert(fc.property(fc.boolean(),fc.boolean(),fc.boolean(),fc.boolean(),(sales,purchase,complete,closed)=>{
    const stage=backorderStage({salesOrderId:sales?1:null,purchaseOrderId:purchase?2:null,operationallyComplete:complete,closed});
    assert.equal(stage==='completed',!closed && complete);
    assert.equal(backorderBucket(stage),closed || complete?'completed':'pending');
  }),{numRuns:300,seed:107268});
});
test('Persisted Backorder capability blocks every remote mutation and allows only manual reference links',()=>{
  fc.assert(fc.property(fc.boolean(),fc.boolean(),(byKind,manual)=>{
    const detail=byKind?{workflowKind:'backorder'}:{regular:{deliveryMethod:'backorder'}};
    assert.equal(isBackorder(detail),true);assert.throws(()=>assertRegularNotBackorder(detail),{code:'BACKORDER_WORKFLOW_ONLY'});assert.doesNotThrow(()=>assertRegularNotBackorder({regular:{deliveryMethod:'stocking'}}));
    if(manual)assert.doesNotThrow(()=>assertBackorderLocalAction(detail,{manualReference:true}));
    else assert.throws(()=>assertBackorderLocalAction(detail),{code:'BACKORDER_REMOTE_BLOCKED'});
    assert.doesNotThrow(()=>assertBackorderLocalAction({workflowKind:'special'}));
  }),{numRuns:200,seed:107269});
});
test('Backorder rejects ancillary fields including zero while material quantity units remain independent',()=>{
  fc.assert(fc.property(fc.constantFrom('palletTotal','palletRate','deliveryFeeRate'),fc.integer({min:0,max:1000000}),(field,value)=>{
    assert.throws(()=>assertBackorderNoAncillary({[field]:value}),{code:'BACKORDER_ANCILLARY_BLOCKED'});
    assert.doesNotThrow(()=>assertBackorderNoAncillary({quantity:value,uom:'PLT'}));
  }),{numRuns:200,seed:107270});
});
test('Concurrent workflow contexts cannot change the default Special profile or another request',async()=>{
  const results=await Promise.all([withBackorderWorkflow(async()=>{await new Promise(r=>setTimeout(r,5));return stockCaseWorkflow();}),
    (async()=>{await new Promise(r=>setTimeout(r,1));return stockCaseWorkflow();})()]);
  assert.deepEqual(results,['backorder','special']);assert.equal(stockCaseWorkflow(),'special');
});

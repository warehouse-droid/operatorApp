import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {canSalesAccessStockingRequest} from '../../../src/regular-stock-stocking-access.js';
const yards=[1,28,15,26];
test('property: linked Waitlist origin access needs valid server lineage, the original yard and exact workflow',()=>{
  const identifier=fc.oneof(fc.integer({min:1,max:100000}),fc.integer({min:1,max:100000}).map(String),
    fc.constantFrom(null,undefined,false,true,0,-1,'1e3','',1.5));
  const validId=value=>['number','string'].includes(typeof value)&&/^\d+$/.test(String(value))&&Number.isSafeInteger(Number(value))&&Number(value)>0;
  fc.assert(fc.property(fc.constantFrom(...yards),fc.subarray(yards),identifier,identifier,
    fc.constantFrom('regular','special'),fc.constantFrom(1,2),fc.constantFrom('waitlist','pickup','delivery'),(origin,authorized,requestId,lineId,requestType,workflowVersion,deliveryMethod)=>{
      const request={requestType,workflowVersion,regular:{deliveryMethod,stockingSource:{requestId,lineId,requestingLocationId:origin}}};
      assert.equal(canSalesAccessStockingRequest(request,authorized),requestType==='regular'&&workflowVersion===2&&deliveryMethod==='waitlist'&&validId(requestId)&&validId(lineId)&&authorized.includes(origin));
    }),{numRuns:600,seed:20261006});
});
test('forged or incomplete lineage cannot turn an ordinary Waitlist into a cross-yard request',()=>{
  for(const invalid of [null,undefined,false,true,[],{},0,-1,'1e3','',1.5]){
    const request={requestType:'regular',workflowVersion:2,regular:{deliveryMethod:'waitlist',requestingLocationId:26,stockingSource:{requestId:invalid,lineId:1,requestingLocationId:26}}};
    assert.equal(canSalesAccessStockingRequest(request,[26]),false);
  }
  assert.equal(canSalesAccessStockingRequest({requestType:'regular',workflowVersion:2,regular:{deliveryMethod:'waitlist',requestingLocationId:26}},[26]),false);
});

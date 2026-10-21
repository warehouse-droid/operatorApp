import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {assertRegularStockingDestinationAccess,canSalesAccessStockingRequest} from '../../../src/regular-stock-stocking-access.js';
import {normalizeStockingReply,stockingDisplayStatus} from '../../../src/regular-stock-reply-domain.js';

const yards=[1,28,15,26];
const record=(regular={})=>({requestType:'regular',workflowVersion:2,status:'submitted',bucket:'pending',destinationLocationId:1,
  regular:{deliveryMethod:'stocking',requestingLocationId:26,...regular},lines:[{status:'submitted'}]});
test('property: Stocking accepts exactly supported destinations for Sales with a supported home yard',()=>{
  fc.assert(fc.property(fc.subarray(yards),fc.constantFrom(...yards),fc.constantFrom('stocking','pickup','delivery','waitlist'),(authorized,destination,method)=>{
    const allowed=method==='stocking'?authorized.length>0:authorized.includes(destination);
    if(allowed)assert.equal(assertRegularStockingDestinationAccess(method,destination,authorized),destination);
    else assert.throws(()=>assertRegularStockingDestinationAccess(method,destination,authorized),{status:403});
  }),{seed:1503445,numRuns:500});
});
test('property: requesting-yard visibility never extends to another method or another yard',()=>{
  fc.assert(fc.property(fc.subarray(yards),fc.constantFrom(...yards),fc.constantFrom('stocking','pickup','delivery','waitlist'),fc.constantFrom(1,2),fc.constantFrom('regular','special'),(authorized,origin,method,workflow,type)=>{
    const r=record({deliveryMethod:method,requestingLocationId:origin});r.workflowVersion=workflow;r.requestType=type;
    assert.equal(canSalesAccessStockingRequest(r,authorized),method==='stocking'&&workflow===2&&type==='regular'&&authorized.includes(origin));
  }),{seed:20261006,numRuns:800});
});
test('invalid destination and origin representations cannot activate new yard access',()=>{
  for(const bad of [null,[],[1],{},true,'1e0','3445',NaN,Infinity,-1,999]){
    assert.throws(()=>assertRegularStockingDestinationAccess('stocking',bad,[26]));
    assert.equal(canSalesAccessStockingRequest(record({requestingLocationId:bad}),[1,26]),false);
  }
});
test('SCM instructions require text, allow an omitted ETA and preserve newlines',()=>{
  assert.deepEqual(normalizeStockingReply({message:'  Use the next load.\nCall first.  ',expectedRevision:2},'scm'),
    {message:'Use the next load.\nCall first.',eta:null,salesOrderRef:null,expectedRevision:2});
  assert.equal(normalizeStockingReply({message:'Plan',eta:'2028-02-29',expectedRevision:'3'},'scm').eta,'2028-02-29');
  for(const eta of ['2026-02-29','2026-02-30','2026-13-01','2026-1-01','not-a-date',{},true])assert.throws(()=>normalizeStockingReply({message:'Plan',eta,expectedRevision:2},'scm'),{status:400});
});
test('Sales reply accepts an optional SO as information and rejects oversized or hostile control values',()=>{
  assert.equal(normalizeStockingReply({message:'Confirmed',salesOrderRef:' SO-123 ',expectedRevision:1},'sales').salesOrderRef,'SO-123');
  assert.equal(normalizeStockingReply({message:'Confirmed',expectedRevision:1},'sales').salesOrderRef,null);
  for(const change of [{message:''},{message:' '.repeat(3)},{message:'x'.repeat(2001)},{message:{}},{message:'a\u0000b'},
    {salesOrderRef:'x'.repeat(81)},{salesOrderRef:123},{expectedRevision:null},{expectedRevision:true},{expectedRevision:0},{expectedRevision:1.5}]){
    assert.throws(()=>normalizeStockingReply({message:'Reply',expectedRevision:1,...change},'sales'),{status:400});
  }
});
test('property: normalized valid messages round-trip, and blank optional fields stay blank',()=>{
  fc.assert(fc.property(fc.string({minLength:1,maxLength:100}).filter(s=>!!s.trim()&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(s)),fc.integer({min:1,max:10000}), (message,revision)=>{
    const input={message,expectedRevision:revision,eta:'',salesOrderRef:''};
    const normalized=normalizeStockingReply(input,'sales');assert.equal(normalized.message,message.trim());assert.equal(normalized.expectedRevision,revision);
    assert.equal(normalized.salesOrderRef,null);assert.equal(normalizeStockingReply(normalized,'sales').message,normalized.message);
  }),{seed:3445150,numRuns:400});
});
test('conversation and proposal statuses change without replacing operational progress',()=>{
  assert.equal(stockingDisplayStatus(record({replyStatus:'pending_update'})),'pending_update');
  assert.equal(stockingDisplayStatus(record({replyStatus:'pending_scm'})),'pending_scm');
  const partial=record({stockingType:'purchase'});partial.lines.push({status:'approved',purchase:{demandId:1}});
  assert.equal(stockingDisplayStatus(partial),'partially_proposed');partial.lines[0].status='rejected';assert.equal(stockingDisplayStatus(partial),'proposed');
  partial.regular.resolution={purchaseOrderRef:'PO-1'};partial.status='completed';assert.equal(stockingDisplayStatus(partial),'resolved');
  assert.equal(stockingDisplayStatus({...record({replyStatus:'pending_update'}),status:'cancelled'}),'cancelled');
  const pickup=record({deliveryMethod:'pickup',replyStatus:'pending_update'});assert.equal(stockingDisplayStatus(pickup),'pending');
});
test('a reply on an open Stocking TO still requests a Sales update while completed requests stay completed',()=>{
  const r=record({pickupTransfer:{status:'complete'},replyStatus:'pending_update'});r.status='active';r.bucket='accepted';
  assert.equal(stockingDisplayStatus(r),'pending_update');r.status='completed';assert.equal(stockingDisplayStatus(r),'completed');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {regularStockStatusSummary as summary,parseRegularStatusFilters as filters,matchesRegularStatusSummary as matches} from '../../../public/regular-stock-status.js';

const request=(method,lines=[{status:'submitted'}],extra={})=>({requestType:'regular',workflowVersion:2,status:'active',regular:{deliveryMethod:method},lines,...extra});
const backorder=(lines,extra={})=>request('backorder',lines,{workflowKind:'backorder',stage:'confirmed',...extra});
const now=Date.parse('2026-10-19T12:00:00Z');

test('Pickup distinguishes review, awaiting SO, and order processing',()=>{
  assert.equal(summary(request('pickup')).status,'pending_scm');
  assert.equal(summary(request('pickup',[{status:'approved'}])).status,'pending_sales');
  assert.equal(summary(request('pickup',[{status:'approved'}],{regular:{deliveryMethod:'pickup',handoffStatus:'executing'}})).status,'in_progress');
});
test('expired approvals require Sales action, while terminal and Stocking records never expire',()=>{
  const d=request('pickup',[{status:'approved'}],{regular:{deliveryMethod:'pickup',approvalExpiresAt:'2026-10-19T11:00:00Z'}});
  assert.equal(summary(d,now).status,'pending_sales');assert.equal(summary(d,now).detail,'approval_expired');assert.equal(summary(d,now).needsAttention,true);
  assert.equal(summary({...d,lines:[{status:'fulfilled'}]},now).status,'completed');
  assert.equal(summary({...d,lines:[{status:'fulfilled'}]},now).needsAttention,false);
  assert.equal(summary({...d,regular:{...d.regular,deliveryMethod:'stocking'}},now).needsAttention,false);
  assert.equal(summary({...d,regular:{...d.regular,handoffStatus:'executing'}},now).detail,'processing');
});
test('Delivery handoff completion keeps unreceived transfers in progress',()=>{
  const d=request('delivery',[{status:'pending_to'}],{regular:{deliveryMethod:'delivery',deliveryVersion:1,deliveryApproval:'approved',handoffStatus:'complete'},transfers:[{status:'pending_fulfillment'}]});
  assert.equal(summary(d).status,'in_progress');
  assert.equal(summary({...d,lines:[{status:'received'}],transfers:[{status:'received'}]}).status,'completed');
  assert.equal(summary({...d,lines:[{status:'rejected'}],regular:{...d.regular,deliveryApproval:'rejected'}}).status,'closed');
});
test('Stocking distinguishes replies, proposals and successful PO resolution',()=>{
  assert.equal(summary(request('stocking',[{status:'submitted',replyStatus:'pending_update'}])).status,'pending_sales');
  assert.equal(summary(request('stocking',[{status:'approved',purchase:{demandId:4}}])).status,'completed');
  assert.equal(summary(request('stocking',[{status:'closed',resolution:{purchaseOrderRef:'PO-1'}}])).status,'completed');
  assert.equal(summary(request('stocking',[{status:'closed',resolution:{purchaseOrderRef:'PO-1'}}])).detail,'resolved_po');
});
test('partial requests retain active priority and terminal line counts',()=>{
  const d=request('stocking',[{status:'submitted',replyStatus:'pending_update'},{status:'submitted'},{status:'received'}]);
  const s=summary(d);assert.equal(s.status,'pending_scm');assert.equal(s.counts.pending_scm,1);assert.equal(s.counts.pending_sales,1);assert.equal(s.counts.completed,1);
  assert.equal(summary({...d,lines:d.lines.filter((_,i)=>i!==1)}).status,'pending_sales');
});
test('closed outcomes remain distinct and mixed success completes without hiding rejection',()=>{
  for(const [status,outcome] of [['rejected','rejected'],['cancelled','cancelled'],['closed','closed_manually']]){
    const s=summary(request('stocking',[{status}]));assert.equal(s.status,'closed');assert(s.outcomes.includes(outcome));
  }
  const d=request('stocking',[{status:'received'},{status:'rejected'}]);assert.equal(summary(d).status,'completed');assert(summary(d).outcomes.includes('rejected'));
  assert.equal(summary({...d,status:'cancelled'}).status,'closed');
});
test('Waitlist allocation, partial conversion, release, success and rejection stay distinct',()=>{
  const d=request('waitlist');
  for(const [state,expected] of [['waiting','waiting_stock'],['partially_allocated','pending_sales'],['allocated','pending_sales'],['converting','in_progress'],['completed','completed'],['closed','closed']]){
    assert.equal(summary({...d,waitlist:{state,closureType:state==='closed'?'rejected':null}}).status,expected,state);
  }
  assert(summary({...d,status:'cancelled',waitlist:{state:'closed',closureType:'rejected'}}).outcomes.includes('rejected'));
});
test('Backorder review, Sales confirmation, shortages and Already Ordered use shared statuses',()=>{
  assert.equal(summary(backorder([{salesDecision:'pending',supplyStatus:null}])).status,'pending_scm');
  assert.equal(summary(backorder([{salesDecision:'pending',supplyStatus:'production'}])).status,'pending_sales');
  assert.equal(summary(backorder([{salesDecision:'accepted',supplyStatus:'production'}],{salesOrderId:2,purchaseOrderId:3})).status,'waiting_stock');
  assert.equal(summary(backorder([{salesDecision:'accepted',supplyStatus:'in_stock'}],{salesOrderId:2,purchaseOrderId:3})).status,'in_progress');
  assert.equal(summary(backorder([{salesDecision:'pending',supplyStatus:'already_ordered'}],{stage:'completed'})).status,'completed');
});
test('production and transfer badges coexist before Sales accepts without mutating input',()=>{
  const d=backorder([{supplyStatus:'production',salesDecision:'pending'},{supplyStatus:'vendor_transfer',salesDecision:'pending'}]);
  const before=structuredClone(d),s=summary(d);assert.equal(s.status,'pending_sales');assert.deepEqual(s.waitingReasons,['vendor_transfer','production']);assert.deepEqual(d,before);
});
test('terminal, removed and already-ordered materials cannot contribute waiting badges',()=>{
  const lines=['rejected','cancelled','closed','received','fulfilled'].map(status=>({status,supplyStatus:'production'}));
  lines.push({supplyStatus:'production',salesDecision:'declined'},{supplyStatus:'vendor_transfer',removedAt:'2026-10-19'},{supplyStatus:'already_ordered'});
  assert.deepEqual(summary(backorder(lines)).waitingReasons,[]);
  assert.deepEqual(summary(backorder([{supplyStatus:'no_stock',salesDecision:'accepted'}])).waitingReasons,[]);
});
test('dispatch readiness suppresses stale waiting badges, requiring both PO reference and readiness',()=>{
  const d=backorder([{supplyStatus:'production',salesDecision:'accepted'}],{purchaseOrderId:2,purchaseOrderReference:'VENDOR-REF',purchaseOrderDispatchStatus:'Hold'});
  assert.deepEqual(summary(d).waitingReasons,['production']);
  assert.deepEqual(summary({...d,purchaseOrderDispatchStatus:'Queued'}).waitingReasons,[]);
  assert.deepEqual(summary({...d,purchaseOrderReference:'',purchaseOrderDispatchStatus:'Queued'}).waitingReasons,['production']);
  for(const stage of ['dispatch_arrangement','completed','closed'])assert.deepEqual(summary({...d,stage}).waitingReasons,[]);
});
test('processing failure stays active and needs attention',()=>{
  const d=request('delivery',[{status:'approved'}],{regular:{deliveryMethod:'delivery',deliveryVersion:1,deliveryApproval:'approved',handoffStatus:'attention',handoffError:'Printer unavailable'}});
  assert.equal(summary(d).status,'in_progress');assert.equal(summary(d).needsAttention,true);
});
test('unified filters intersect main status, closure outcome and independent supply reason',()=>{
  const d=summary(backorder([{supplyStatus:'production',salesDecision:'pending'}]));
  assert(matches(d,filters({unifiedStatus:'pending_sales',waitingReason:'production'})));
  assert(!matches(d,filters({unifiedStatus:'pending_sales',waitingReason:'vendor_transfer'})));
  assert(!matches(d,filters({unifiedStatus:'pending_scm',waitingReason:'production'})));
  const closed=summary(request('stocking',[{status:'rejected'}]));
  assert(matches(closed,filters({unifiedStatus:'closed',outcome:'rejected'})));
  assert(!matches(closed,filters({unifiedStatus:'active'})));
  assert(matches(closed,filters({unifiedStatus:'all'})));
  assert.equal(filters({}).enabled,false);
});
test('hostile and unsupported filter values fail with a stable 400 error',()=>{
  for(const field of ['unifiedStatus','outcome','waitingReason'])for(const value of ['__proto__','invalid',[],{},'x'.repeat(10000)]){
    assert.throws(()=>filters({[field]:value}),e=>e.status===400&&e.code==='REGULAR_STATUS_FILTER_INVALID');
  }
});
test('compact Waitlist list records and full details expose identical summaries',()=>{
  for(const [state,status,closureType] of [['closed','closed','rejected'],['completed','fulfilled',null],['allocated','approved',null]]){
    const compact={regular:{deliveryMethod:'waitlist'},waitlist:{state,closureType}};
    assert.deepEqual(summary({...compact,lines:[{status}]}),summary(compact));
  }
});

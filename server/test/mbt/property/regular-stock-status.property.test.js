import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {regularStockStatusSummary as summary,parseRegularStatusFilters as filters,matchesRegularStatusSummary as matches} from '../../../public/regular-stock-status.js';
const make=lines=>({requestType:'regular',workflowVersion:2,status:'active',regular:{deliveryMethod:'stocking'},lines});
const terminal=fc.constantFrom('received','fulfilled','rejected','cancelled','closed');
test('any submitted material keeps mixed requests pending SCM regardless of terminal order',()=>{
  fc.assert(fc.property(fc.array(terminal,{maxLength:40}),fc.nat(),(statuses,index)=>{
    const lines=statuses.map(status=>({status}));lines.splice(index%(lines.length+1),0,{status:'submitted'});
    assert.equal(summary(make(lines)).status,'pending_scm');assert.equal(summary(make(lines.slice().reverse())).status,'pending_scm');
  }),{seed:197601,numRuns:150});
});
test('terminal outcomes preserve success versus entirely closed work',()=>{
  fc.assert(fc.property(fc.array(terminal,{minLength:1,maxLength:40}),statuses=>{
    const s=summary(make(statuses.map(status=>({status}))));
    assert.equal(s.status,statuses.some(v=>['received','fulfilled'].includes(v))?'completed':'closed');
    assert.equal(matches(s,filters({unifiedStatus:s.status})),true);assert.equal(matches(s,filters({unifiedStatus:'active'})),false);
  }),{seed:197602,numRuns:150});
});
test('supply badges are deduplicated, order independent and never guessed',()=>{
  fc.assert(fc.property(fc.array(fc.constantFrom('production','vendor_transfer','no_stock','in_stock','already_ordered'),{maxLength:40}),statuses=>{
    const request={...make(statuses.map(supplyStatus=>({supplyStatus,salesDecision:'pending'}))),workflowKind:'backorder',regular:{deliveryMethod:'backorder'}};
    const expected=['vendor_transfer','production'].filter(v=>statuses.includes(v));
    assert.deepEqual(summary(request).waitingReasons,expected);
    assert.deepEqual(summary({...request,lines:request.lines.slice().reverse()}).waitingReasons,expected);
  }),{seed:197603,numRuns:150});
});
test('existing statuses and input records are never rewritten by classification or filtering',()=>{
  fc.assert(fc.property(fc.array(fc.constantFrom('submitted','approved','received','closed'),{minLength:1,maxLength:20}),statuses=>{
    const d=make(statuses.map(status=>({status}))),before=structuredClone(d),s=summary(d);
    assert(matches(s,filters({unifiedStatus:'all'})));assert.deepEqual(d,before);
  }),{seed:197604,numRuns:100});
});
test('SCM action outranks Sales action in either line order',()=>{
  fc.assert(fc.property(fc.boolean(),fc.array(terminal,{maxLength:20}),(reverse,statuses)=>{
    const lines=[{status:'submitted'},{status:'submitted',replyStatus:'pending_update'},...statuses.map(status=>({status}))];
    assert.equal(summary(make(reverse?lines.reverse():lines)).status,'pending_scm');
  }),{seed:197605,numRuns:100});
});
test('supply filter matches exactly the independently visible waiting reasons',()=>{
  fc.assert(fc.property(fc.constantFrom('production','vendor_transfer','in_stock'),fc.constantFrom('production','vendor_transfer'),(supplyStatus,reason)=>{
    const s=summary({...make([{supplyStatus,salesDecision:'pending'}]),workflowKind:'backorder',regular:{deliveryMethod:'backorder'}});
    assert.equal(matches(s,filters({unifiedStatus:'pending_sales',waitingReason:reason})),supplyStatus===reason);
  }),{seed:197606,numRuns:100});
});

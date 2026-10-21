import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import * as model from '../../../public/regular-stock-status.js';
import {restoreSalesStockFilters,salesStockListFiltersHtml} from '../../../public/sales-stock-list-filters.js';
const {regularStockStatusSummary:summary,parseRegularStatusFilters:parse,matchesRegularStatusSummary:matches}=model;
const request=(lines,regular={deliveryMethod:'stocking',stockingType:'purchase'})=>({id:1,revision:2,status:'active',workflowVersion:2,regular,lines});

test('selected statuses match OR, deduplicate, and keep the other filters',()=>{
  const filters=parse({unifiedStatus:'pending_sales,completed,pending_sales'});
  for(const status of Object.keys(model.REGULAR_STATUSES))assert.equal(matches({status,outcomes:[],waitingReasons:[]},filters),['pending_sales','completed'].includes(status));
  assert.equal(parse({unifiedStatus:''}).unifiedStatus,'all');
  assert(!matches({status:'completed',outcomes:['received'],waitingReasons:[]},parse({unifiedStatus:'pending_sales,completed',outcome:'rejected'})));
  for(const value of ['all,closed','active,closed','closed,unknown','closed,',{},['closed'],'closed,'.repeat(100)])assert.throws(()=>parse({unifiedStatus:value}),{status:400});
});
test('generated multi-status selections match exactly their union',()=>{
  const statuses=Object.keys(model.REGULAR_STATUSES);
  fc.assert(fc.property(fc.array(fc.constantFrom(...statuses),{minLength:2,maxLength:20}),fc.constantFrom(...statuses),(selected,status)=>{
    const filters=parse({unifiedStatus:selected.join(',')});
    assert.equal(matches({status,outcomes:[],waitingReasons:[]},filters),selected.includes(status));
    assert.equal(parse(filters).unifiedStatus,filters.unifiedStatus);
  }),{seed:20102026,numRuns:200});
});
test('legacy Case stage preferences migrate into Status and the duplicate menu disappears',()=>{
  const restored=restoreSalesStockFilters(JSON.stringify({backorderStageFilter:['pending_update','completed'],requestTypeFilter:['backorder'],vendorFilter:[]}));
  assert.equal(restored.unifiedStatus,'pending_sales,completed');assert.deepEqual(restored.backorderStageFilter,[]);
  assert(!salesStockListFiltersHtml(restored).includes('Case stage'));
});
test('STREQ-000164 and STREQ-000120 count as Completed with released and ordered materials',()=>{
  const released={status:'closed',purchase:{demandId:13,releasedQuantity:380,approvedQuantity:380}};
  const ordered={status:'approved',purchase:{demandId:12,orderedQuantity:2432,approvedQuantity:2432,unorderedQuantity:0}};
  for(const lines of [[released,ordered],[released,released,{status:'received'},ordered]]){
    const s=summary(request(lines));assert.equal(s.status,'completed');assert.equal(s.counts.in_progress,0);
  }
  assert.equal(summary(request([released,ordered,{status:'submitted'}])).status,'pending_scm');
  assert.equal(summary(request([{status:'approved',purchase:{demandId:1}}])).status,'completed');
  assert.equal(summary(request([{status:'approved',replyStatus:'pending_update',purchase:{demandId:1}}])).status,'pending_sales');
});
test('Sales input includes mixed-line work, approvals, expiry, Backorder and Waitlist',()=>{
  assert.equal(typeof model.regularStockSalesAction,'function');
  const action=model.regularStockSalesAction;
  assert.equal(action(request([{status:'submitted'},{status:'submitted',replyStatus:'pending_update'}])).reason,'sales_reply');
  assert.equal(action(request([{status:'approved'}],{deliveryMethod:'pickup',approvalExpiresAt:'2099-01-01'})).reason,'awaiting_so');
  assert.equal(action(request([{status:'approved'}],{deliveryMethod:'pickup',approvalExpiresAt:'2000-01-01'})).reason,'approval_expired');
  assert.equal(action({...request([{supplyStatus:'production',salesDecision:'pending'}],{deliveryMethod:'backorder'}),workflowKind:'backorder'}).reason,'sales_confirmation');
  assert.equal(action({...request([],{deliveryMethod:'waitlist'}),waitlist:{state:'allocated'}}).reason,'allocation_ready');
  assert.equal(action(request([{status:'submitted'}])),null);
  assert.equal(action(request([{status:'closed'},{status:'received'}])),null);
});
test('legacy unconfirmed drafts stay active until explicitly closed',()=>{
  const d={...request([{id:1,status:'received'},{id:2,status:'converted',transferId:9}],{}),workflowVersion:1,
    transfers:[{id:9,status:'pending_local',lines:[{id:2}]}]};
  assert.equal(summary(d).status,'in_progress');
  assert.equal(summary({...d,transfers:[]}).status,'in_progress');
  assert.equal(summary({...d,transfers:[{id:9,status:'cancelled',lines:[{id:2}]}]}).status,'in_progress');
  assert.equal(summary({...d,workflowVersion:2,regular:{deliveryMethod:'delivery',deliveryVersion:1}}).status,'in_progress');
  assert.equal(summary({...d,lines:[{status:'received'},{status:'closed'}],transfers:[{id:9,status:'cancelled'}]}).status,'completed');
});
test('generated purchase handoffs complete unless every material was released',()=>{
  fc.assert(fc.property(fc.array(fc.boolean(),{minLength:1,maxLength:30}),released=>{
    const d=request(released.map(value=>value?{status:'closed',purchase:{demandId:1,releasedQuantity:2}}:{status:'approved',purchase:{demandId:1}}));
    assert.equal(summary(d).status,released.every(Boolean)?'closed':'completed');
    assert.equal(summary({...d,lines:[...d.lines,{status:'submitted'}]}).status,'pending_scm');
  }),{seed:20102027,numRuns:150});
});
test('generated mixed Sales replies remain actionable until all replies are resolved',()=>{
  fc.assert(fc.property(fc.array(fc.boolean(),{minLength:1,maxLength:30}),pending=>{
    const d=request(pending.map(value=>({status:'submitted',replyStatus:value?'pending_update':'pending_scm'})));
    assert.equal(model.regularStockSalesAction(d)?.reason||null,pending.some(Boolean)?'sales_reply':null);
    assert.equal(model.regularStockSalesAction({...d,lines:d.lines.map(()=>({status:'closed'}))}),null);
  }),{seed:20102028,numRuns:150});
});

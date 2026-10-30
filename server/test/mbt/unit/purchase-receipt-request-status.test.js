import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {regularStockStatusSummary} from '../../../public/regular-stock-status.js';
const request={workflowKind:'backorder',stage:'completed',status:'active',closeStatus:'active',salesOrderRef:'SOA10500',
  linkedSalesOrderProgress:{completed:false},alreadyOrderedArrival:{status:'arrived'},
  lines:[{id:1,supplyStatus:'already_ordered'},{id:2,supplyStatus:'already_ordered'}]};
test('STREQ-000163 is completed when every ordered PO arrived while its customer SO remains open',()=>{
  const before=structuredClone(request);
  const summary=regularStockStatusSummary(request);
  assert.equal(summary.status,'completed');assert.deepEqual(summary.waitingReasons,['arrived']);
  assert.deepEqual(request,before);
  assert.equal(regularStockStatusSummary({...request,alreadyOrderedArrival:{status:'arrival'}}).status,'in_progress');
  assert.equal(regularStockStatusSummary({...request,lines:[...request.lines,{id:3,supplyStatus:'production',salesDecision:'accepted',respondedAt:'2026-10-27',availableDate:'2099-01-01'}]}).status,'in_progress');
  assert.equal(regularStockStatusSummary({...request,closeStatus:'closed'}).status,'closed');
});
test('generated fully arrived ordered-only requests complete without changing linked SO or line state',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:15}),fc.boolean(),(count,arrived)=>{
    const value={...request,alreadyOrderedArrival:{status:arrived?'arrived':'arrival'},lines:Array.from({length:count},(_,id)=>({id,supplyStatus:'already_ordered'}))};
    const before=structuredClone(value);
    assert.equal(regularStockStatusSummary(value).status,arrived?'completed':'in_progress');
    assert.deepEqual(value,before);
  }),{seed:20261027,numRuns:100});
});

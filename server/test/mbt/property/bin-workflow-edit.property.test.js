import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {workflowEditPermissions,binWorkLocked} from '../../../src/mbt/bin-order-workflow-editing.js';

const root={order_kind:'exchange',status:'ready',rental_status:'active'};
const state=fc.record({planned:fc.boolean(),assigned:fc.boolean(),started:fc.boolean(),done:fc.boolean(),
  steps:fc.boolean(),incoming:fc.boolean(),historical:fc.boolean(),status:fc.constantFrom('ready','tentative','in_progress','evidence_pending','completed','cancelled')});
const visit=(role,s)=>({part_role:role,dispatch_plan_id:s.planned?'plan':null,active_assignment:s.assigned,
  actual_started_at:s.started?'2026-10-23':null,actual_completed_at:s.done?'2026-10-23':null,
  started_steps:s.steps,incoming_link:s.incoming,status:s.status,
  released_at:s.historical?'2026-10-22':null,withdrawn_at:s.historical?'2026-10-23':null});
const free=s=>!(s.planned||s.assigned||s.started||s.done||s.steps||s.incoming)
  && ['ready','tentative'].includes(s.status);

test('edit property: each leg controls its own route and either busy leg locks sequence',()=>{
  fc.assert(fc.property(state,state,(d,c)=>{
    const actual=workflowEditPermissions(root,[visit('delivery',d),visit('collection',c)]);
    assert.equal(actual.delivery,free(d));assert.equal(actual.collection,free(c));
    assert.equal(actual.sequence,free(d)&&free(c));
  }),{seed:3445,numRuns:500});
});
test('edit property: withdrawn history never locks a free leg, but each current work signal does',()=>{
  fc.assert(fc.property(fc.boolean(),fc.constantFrom('delivery','collection'),fc.constantFrom('dispatch_plan_id','active_assignment',
    'actual_started_at','actual_completed_at','started_steps'),(historical,role,signal)=>{
    const part={part_role:role,status:'ready',released_at:historical?'yesterday':null,withdrawn_at:historical?'today':null};
    assert.equal(binWorkLocked(part),false);
    assert.deepEqual([workflowEditPermissions(root,[part]).delivery,workflowEditPermissions(root,[part]).collection,
      workflowEditPermissions(root,[part]).sequence],[true,true,true]);
    const locked=workflowEditPermissions(root,[{...part,[signal]:true}]);
    assert.equal(binWorkLocked({...part,[signal]:true}),true);
    assert.equal(locked[role],false);assert.equal(locked.sequence,false);
    assert.equal(locked[role==='delivery'?'collection':'delivery'],true);
  }),{seed:2967,numRuns:150});
});
test('edit property: closed roots lock everything and single-role orders expose only their route',()=>{
  fc.assert(fc.property(fc.constantFrom('delivery','collection','exchange'),fc.constantFrom('completed','cancelled','closed'),(kind,status)=>{
    const closed=workflowEditPermissions({...root,order_kind:kind,...(status==='closed'?{rental_status:status}:{status})},[]);
    assert.deepEqual([closed.sequence,closed.delivery,closed.collection],[false,false,false]);
    const open=workflowEditPermissions({...root,order_kind:kind},[]);
    assert.equal(open.delivery,kind!=='collection');assert.equal(open.collection,kind!=='delivery');assert.equal(open.sequence,true);
  }),{seed:150,numRuns:100});
});

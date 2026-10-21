import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {transitionDeliveryRequest} from '../../../src/delivery-request-domain.js';
import {request,window,sales,dispatcher,clock} from '../support/delivery-request-fixtures.js';

const original=window({start:'08:00',end:'09:00',timeZone:'America/Toronto'});
const desired=window({start:'13:00',end:'15:00'});
const alternative=window({start:'15:00',end:'17:00'});
const secured=()=>request({status:'confirmed',confirmedWindow:original,salesOrderRefs:['SO123'],
  securedAt:clock.now,pendingWindow:desired,pendingWindowProposedBy:'sales'});
const act=(row,action,actor=dispatcher,audience='dispatch',fields={})=>transitionDeliveryRequest(
  row,action,{expectedRevision:row.revision,...fields},actor,audience,clock);

test('Dispatch counter retains the secured schedule and records a proposal for Sales',()=>{
  const row=secured(),next=act(row,'counter-time-change',dispatcher,'dispatch',{window:alternative});
  assert.deepEqual(next,{...row,revision:2,pendingWindow:{...alternative,timeZone:'America/Toronto'},pendingWindowProposedBy:'dispatch'});
  assert.deepEqual(row.pendingWindow,desired,'The input request is immutable.');
});
test('Sales acceptance of Dispatch counter updates the confirmed schedule and clears negotiation',()=>{
  const counter={...secured(),pendingWindow:alternative,pendingWindowProposedBy:'dispatch'};
  const next=act(counter,'accept-counter-time-change',sales,'sales');
  assert.deepEqual(next,{...counter,revision:2,confirmedWindow:{...alternative,timeZone:'America/Toronto'},pendingWindow:null,pendingWindowProposedBy:null});
});
test('each team can accept only the other team’s pending proposal including legacy Sales proposals',()=>{
  for(const action of ['accept-time-change','decline-time-change']) {
    assert.throws(()=>act({...secured(),pendingWindowProposedBy:'dispatch'},action),{code:'DELIVERY_STATE_CONFLICT'});
  }
  assert.throws(()=>act(secured(),'accept-counter-time-change',sales,'sales'),{code:'DELIVERY_STATE_CONFLICT'});
  const legacy=secured();delete legacy.pendingWindowProposedBy;
  assert.deepEqual(act(legacy,'accept-time-change').confirmedWindow,{...desired,timeZone:'America/Toronto'});
  for(const action of ['counter-time-change','withdraw-counter-time-change']) {
    assert.throws(()=>act(secured(),action,sales,'sales',{window:alternative}),{status:403});
  }
  assert.throws(()=>act(secured(),'accept-counter-time-change'),{status:403});
});
test('withdrawal or a new Sales proposal preserves the secured window and replaces the proposal owner',()=>{
  const counter={...secured(),pendingWindow:alternative,pendingWindowProposedBy:'dispatch'};
  for(const [action,actor,audience] of [['withdraw-time-change',sales,'sales'],['withdraw-counter-time-change',dispatcher,'dispatch']]) {
    assert.deepEqual(act(counter,action,actor,audience),{...counter,revision:2,pendingWindow:null,pendingWindowProposedBy:null});
  }
  assert.deepEqual(act(counter,'request-time-change',sales,'sales',{window:desired}),
    {...counter,revision:2,pendingWindow:{...desired,timeZone:'America/Toronto'},pendingWindowProposedBy:'sales'});
  assert.throws(()=>act(secured(),'withdraw-counter-time-change'),{code:'DELIVERY_STATE_CONFLICT'});
});
test('counter rejects missing negotiation, invalid windows, stale versions and nonsecured requests',()=>{
  assert.throws(()=>act({...secured(),pendingWindow:null},'counter-time-change',dispatcher,'dispatch',{window:alternative}),{code:'DELIVERY_STATE_CONFLICT'});
  assert.throws(()=>act({...secured(),status:'preapproved'},'counter-time-change',dispatcher,'dispatch',{window:alternative}),{code:'DELIVERY_STATE_CONFLICT'});
  assert.throws(()=>act(secured(),'counter-time-change',dispatcher,'dispatch',{window:window({start:'15:00',end:'16:00'})}),{code:'DELIVERY_REQUEST_INVALID'});
  assert.throws(()=>act(secured(),'counter-time-change',dispatcher,'dispatch',{window:alternative,expectedRevision:0}),{code:'DELIVERY_STALE_REVISION'});
});
test('generated negotiation never changes secured data before the receiving team accepts',()=>{
  fc.assert(fc.property(fc.integer({min:0,max:20}),fc.integer({min:2,max:3}),(hour,duration)=>{
    const start=String(hour).padStart(2,'0')+':00',end=String(hour+duration).padStart(2,'0')+':00';
    const row=secured(),next=act(row,'counter-time-change',dispatcher,'dispatch',{window:window({start,end})});
    assert.deepEqual(next.confirmedWindow,row.confirmedWindow);assert.deepEqual(next.salesOrderRefs,row.salesOrderRefs);
    assert.deepEqual(next.quote,row.quote);assert.equal(next.securedAt,row.securedAt);assert.equal(next.approvalExpiresAt,null);
    const accepted=act(next,'accept-counter-time-change',sales,'sales');
    assert.deepEqual(accepted.confirmedWindow,next.pendingWindow);assert.equal(accepted.pendingWindow,null);
  }),{numRuns:100,seed:14102026});
});

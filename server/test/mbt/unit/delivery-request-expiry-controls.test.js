import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {transitionDeliveryRequest,deliveryApprovalDue} from '../../../src/delivery-request-domain.js';
import {request,sales,dispatcher,clock,window} from '../support/delivery-request-fixtures.js';

const act=(row,action,fields={},actor=dispatcher,audience='dispatch',now=clock.now)=>transitionDeliveryRequest(row,action,
  {expectedRevision:row.revision,...fields},actor,audience,{...clock,now});
const approved=()=>act(request(),'confirm');

test('expiry override: free-text clock input replaces only this approval deadline',()=>{
  for(const expiryTime of ['530pm','5:30 PM','17:30','1730','until 05:30 pm']) {
    const row=act(request(),'confirm',{expiryTime});
    assert.equal(row.approvalExpiresAt,'2028-10-01T21:30:00.000Z');
    assert.equal(row.reminderAt,'2028-10-01T20:30:00.000Z');
    assert.equal(row.status,'preapproved');assert.equal(row.approvalSettings.approvalHours,3);
  }
  assert.equal(approved().approvalExpiresAt,'2028-10-01T15:00:00.000Z');
});
test('expiry override: next Toronto occurrence handles midnight, winter, summer and DST',()=>{
  for(const [now,expiryTime,expected] of [
    [clock.now,'7am','2028-10-02T11:00:00.000Z'],
    [clock.now,'12am','2028-10-02T04:00:00.000Z'],
    [clock.now,'12pm','2028-10-01T16:00:00.000Z'],
    ['2028-01-01T12:00:00Z','5pm','2028-01-01T22:00:00.000Z'],
    ['2028-03-12T06:00:00Z','3am','2028-03-12T07:00:00.000Z'],
    ['2028-11-05T05:45:00Z','130am','2028-11-05T06:30:00.000Z']
  ]) {assert.equal(act(request(),'confirm',{expiryTime},dispatcher,'dispatch',now).approvalExpiresAt,expected);}
  assert.throws(()=>act(request(),'confirm',{expiryTime:'230am'},dispatcher,'dispatch','2028-03-12T06:00:00Z'),{code:'DELIVERY_REQUEST_INVALID'});
});
test('expiry override: malformed, oversized and structured inputs are rejected',()=>{
  for(const expiryTime of ['25:00','0pm','13pm','5:99pm','99am','<script>','x'.repeat(10000),{},[],true,123,null]) {
    assert.throws(()=>act(request(),'confirm',{expiryTime}),{code:'DELIVERY_REQUEST_INVALID'});
  }
});
test('expiry override: generated clock values round-trip without changing the default',()=>{
  fc.assert(fc.property(fc.integer({min:0,max:1439}),minutes=>{
    const hours=Math.floor(minutes/60),minute=String(minutes%60).padStart(2,'0');
    const expiryTime=`until ${String(hours%12 || 12).padStart(2,'0')}:${minute} ${hours<12?'am':'pm'}`;
    const row=act(request(),'confirm',{expiryTime});
    const date=new Date(row.approvalExpiresAt);
    assert.equal(date.getUTCHours(),(hours+4)%24);assert.equal(date.getUTCMinutes(),minutes%60);
    assert.ok(date.getTime()>new Date(clock.now).getTime());
    assert.ok(date.getTime()<=new Date(clock.now).getTime()+86400000);
    assert.equal(row.approvalSettings.approvalHours,3);
  }),{seed:16102026,numRuns:200});
});
test('expiry override: updating and accepting preserve windows and quote; short reminders start now',()=>{
  const row=act(request(),'propose',{window:window(),expiryTime:'5pm'});
  const updated=act(row,'set-expiry',{expiryTime:'830am'});
  assert.equal(updated.approvalExpiresAt,'2028-10-01T12:30:00.000Z');assert.equal(updated.reminderAt,clock.now);
  assert.deepEqual(updated.proposedWindow,row.proposedWindow);assert.deepEqual(updated.quote,row.quote);assert.equal(updated.status,'proposed');
  const accepted=act(updated,'accept',{},sales,'sales');assert.equal(accepted.approvalExpiresAt,updated.approvalExpiresAt);
  assert.equal(deliveryApprovalDue(updated,'2028-10-01T12:30:00Z'),'expire');
});
test('manual expiry: Dispatch can expire every unsecured state without changing quotation',()=>{
  for(const row of [request(),approved(),act(request(),'propose',{window:window()})]) {
    const expired=act(row,'expire');assert.equal(expired.status,'expired');assert.equal(expired.approvalExpiresAt,null);
    assert.equal(expired.reminderAt,null);assert.equal(expired.revision,row.revision+1);assert.deepEqual(expired.quote,row.quote);
    assert.equal(deliveryApprovalDue(expired,'2028-10-02T12:00Z'),null);
  }
});
test('expiry controls: Sales cannot override or manually expire a request',()=>{
  for(const action of ['set-expiry','expire']) {assert.throws(()=>act(approved(),action,{expiryTime:'5pm'},sales,'sales'),{code:'DELIVERY_ACCESS_DENIED'});}
});
test('expiry controls: terminal states, stale commands and blank updates cannot change a deadline',()=>{
  for(const status of ['confirmed','expired','cancelled']) {
    for(const action of ['set-expiry','expire']) {assert.throws(()=>act(request({status}),action,{expiryTime:'5pm'}),{code:'DELIVERY_STATE_CONFLICT'});}
  }
  assert.throws(()=>act(request(),'set-expiry',{expiryTime:'5pm'}),{code:'DELIVERY_STATE_CONFLICT'});
  assert.throws(()=>act(approved(),'set-expiry',{expiryTime:''}),{code:'DELIVERY_REQUEST_INVALID'});
  assert.throws(()=>act(approved(),'expire',{expectedRevision:0}),{code:'DELIVERY_STALE_REVISION'});
  assert.throws(()=>act(approved(),'set-expiry',{expiryTime:'5pm'},dispatcher,'dispatch','2028-10-01T15:00Z'),{code:'DELIVERY_APPROVAL_EXPIRED'});
});

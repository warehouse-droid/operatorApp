import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {normalizeSalesOrderReferences,transitionDeliveryRequest} from '../../../src/delivery-request-domain.js';
import {request,window,sales,dispatcher,clock} from '../support/delivery-request-fixtures.js';

test('TO references: normalize SO-only, TO-only and mixed lists without losing order identity',()=>{
  assert.deepEqual(normalizeSalesOrderReferences([' to123 ','SO123','TO123','toother-2/1.1']),['TO123','SO123','TOOTHER-2/1.1']);
});
test('TO references: normalization preserves each valid mixed identity exactly once',()=>{
  fc.assert(fc.property(fc.array(fc.tuple(fc.constantFrom('SO','TO'),fc.integer({min:1,max:100000})),{minLength:1,maxLength:50}),entries=>{
    const refs=entries.map(([prefix,id])=>`${prefix}${id}`);
    const expected=[...new Set(refs)];
    assert.deepEqual(normalizeSalesOrderReferences(refs.map(ref=>` ${ref.toLowerCase()} `)),expected);
    assert.deepEqual(normalizeSalesOrderReferences(expected),expected);
  }),{seed:15102026,numRuns:100});
});
test('TO references: unsupported types, hostile input and limits fail closed',()=>{
  for(const refs of [[],null,['PO123'],['TO'],['TO<script>'],['TO1\nSO2'],[{}],[123],[{toString:()=> 'TO123'}],Array(51).fill('TO1')]) {
    assert.throws(()=>normalizeSalesOrderReferences(refs),{code:'DELIVERY_REQUEST_INVALID'});
  }
  assert.equal(normalizeSalesOrderReferences(Array.from({length:50},(_,i)=>`TO${i}`)).length,50);
});
test('TO approval: secure, relink and cancellation preserve the approved slot and quote',()=>{
  const submitted=request(),approved=transitionDeliveryRequest(submitted,'confirm',{expectedRevision:1},dispatcher,'dispatch',clock);
  const secured=transitionDeliveryRequest(approved,'secure',{expectedRevision:2,salesOrderRefs:['TO123']},sales,'sales',clock);
  assert.equal(secured.status,'confirmed');assert.equal(secured.approvalExpiresAt,null);
  assert.deepEqual(secured.confirmedWindow,window({timeZone:'America/Toronto'}));assert.deepEqual(secured.quote,submitted.quote);
  const changed=transitionDeliveryRequest(secured,'relink',{expectedRevision:3,salesOrderRefs:['SO123','TO124']},sales,'sales',clock);
  assert.deepEqual(changed.salesOrderRefs,['SO123','TO124']);assert.deepEqual(changed.confirmedWindow,secured.confirmedWindow);
  const cancelled=transitionDeliveryRequest(changed,'cancel',{expectedRevision:4},sales,'sales',clock);
  assert.equal(cancelled.status,'cancelled');assert.deepEqual(cancelled.salesOrderRefs,[]);
});

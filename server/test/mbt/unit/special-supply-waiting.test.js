import test from 'node:test';
import assert from 'node:assert/strict';
import {specialSupplyWaitingStatus} from '../../../public/special-stock-case-status.js';

const transfer={supplyStatus:'vendor_transfer',salesDecision:'accepted'};
const production={supplyStatus:'production',salesDecision:'pending'};
const request={stage:'confirmed',purchaseOrderId:12,lines:[transfer,production]};
const labels=detail=>[...specialSupplyWaitingStatus(detail).matchAll(/data-stock-request-waiting="[^"]+">([^<]+)<\/span>/g)].map(match=>match[1]);

test('each active waiting type adds one informational label, including before Sales accepts',()=>{
  assert.deepEqual(labels({lines:[transfer]}),['Waiting for Transfer']);
  assert.deepEqual(labels({lines:[production]}),['Waiting for Production']);
  assert.deepEqual(labels({lines:[transfer,{...transfer},production,{...production,salesDecision:'request_update'}]}),
    ['Waiting for Transfer','Waiting for Production']);
});

test('removed, declined/revoked and closed materials do not create waiting labels',()=>{
  assert.deepEqual(labels({lines:[{...transfer,salesDecision:'declined'},{...production,salesDecision:'closed'},
    {...transfer,removedAt:'2026-10-16T12:00:00Z'}]}),[]);
  assert.deepEqual(labels({lines:[{...transfer,salesDecision:'declined'},production]}),['Waiting for Production']);
  assert.deepEqual(labels({lines:[transfer,{...production,salesDecision:'declined'}]}),['Waiting for Transfer']);
});

test('ready materials and other supply responses do not imply transfer or production waiting',()=>{
  assert.deepEqual(labels({}),[]);
  assert.deepEqual(labels({lines:['in_stock','low_inventory','no_stock','allocation','already_ordered',null].map(supplyStatus=>({supplyStatus,salesDecision:'accepted'}))}),[]);
});

test('the linked PO needs both its vendor reference and Queued status before waiting labels clear',()=>{
  const waiting=['Waiting for Transfer','Waiting for Production'];
  assert.deepEqual(labels({...request,purchaseOrderRef:'PO-12345'}),waiting);
  assert.deepEqual(labels({...request,purchaseOrderReference:'VENDOR-REF',purchaseOrderDispatchStatus:'Hold'}),waiting);
  assert.deepEqual(labels({...request,purchaseOrderReference:'',purchaseOrderDispatchStatus:'Queued'}),waiting);
  assert.deepEqual(labels({...request,purchaseOrderReference:'  ',purchaseOrderDispatchStatus:'Queued'}),waiting);
  assert.deepEqual(labels({...request,purchaseOrderReference:'VENDOR-REF',purchaseOrderDispatchStatus:'Queued'}),[]);
});

test('labels remain dismissed as the PO advances beyond Queued or the request completes',()=>{
  for(const status of ['Queued','Planned','In Transit','Partially Done','Completed']) {
    assert.deepEqual(labels({...request,purchaseOrderReference:'VENDOR-REF',purchaseOrderDispatchStatus:status}),[]);
  }
  for(const stage of ['dispatch_arrangement','completed','closed'])assert.deepEqual(labels({...request,stage}),[]);
});

test('readiness and revocation updates change labels without changing the request or its stage',()=>{
  const detail=structuredClone(request),before=structuredClone(detail);
  assert.deepEqual(labels(detail),['Waiting for Transfer','Waiting for Production']);
  assert.deepEqual(detail,before);
  detail.lines[0].supplyStatus='in_stock';assert.deepEqual(labels(detail),['Waiting for Production']);
  detail.lines[1].salesDecision='declined';assert.deepEqual(labels(detail),[]);
  detail.lines[1].salesDecision='accepted';assert.deepEqual(labels(detail),['Waiting for Production']);
  assert.equal(detail.stage,'confirmed');
});

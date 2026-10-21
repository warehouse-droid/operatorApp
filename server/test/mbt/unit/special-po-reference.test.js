import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { specialPurchaseOrderDisplayRef, poReferenceAlertAudience } from '../../../public/special-stock-po-reference.js';
import * as poReference from '../../../public/special-stock-po-reference.js';

test('Sales delivery alert: fulfillment methods notify all intended audiences and no unsupported audience',()=>{
  assert.equal(typeof poReference.poReferenceAlertAudiences,'function');
  fc.assert(fc.property(fc.constantFrom('vendor_pickup','yard_pickup','mbt_delivery','',null,'__proto__'),method=>{
    const expected=method==='vendor_pickup'?['sales']:['yard_pickup','mbt_delivery'].includes(method)?['sales','dispatch']:[];
    assert.deepEqual(poReference.poReferenceAlertAudiences(method),expected);
  }),{seed:8102026,numRuns:200});
});

test('Sales PO labels keep the native number and SCM reference, trim empty input and avoid duplicate numbers', () => {
  for (const [detail, expected] of [
    [{ purchaseOrderRef: 'POB03976', purchaseOrderReference: 'SN1401857' }, 'POB03976 / SN1401857'],
    [{ purchaseOrderRef: 'POB03976', purchaseOrderReference: '  ' }, 'POB03976'],
    [{ purchaseOrderRef: 'POB03976', purchaseOrderReference: 'pob03976' }, 'POB03976'],
    [{ purchaseOrderRef: '', purchaseOrderReference: 'SN1401857' }, 'SN1401857'], [{}, '']
  ]) assert.equal(specialPurchaseOrderDisplayRef(detail), expected);
});
test('PO reference alerts route only the three supported fulfillment methods', () => {
  assert.equal(poReferenceAlertAudience('vendor_pickup'), 'sales');
  assert.equal(poReferenceAlertAudience('yard_pickup'), 'dispatch');
  assert.equal(poReferenceAlertAudience('mbt_delivery'), 'dispatch');
  for (const method of ['',null,undefined,'Vendor','__proto__']) assert.equal(poReferenceAlertAudience(method), null);
});
test('property: every distinct native PO and vendor reference uses one spaced slash and preserves both values', () => {
  fc.assert(fc.property(fc.nat(), fc.nat(), (native, vendor) => {
    assert.equal(specialPurchaseOrderDisplayRef({ purchaseOrderRef: 'POB'+native, purchaseOrderReference: 'SN'+vendor }), `POB${native} / SN${vendor}`);
  }), { seed: 2026100151, numRuns: 200 });
});
test('property: reference whitespace never leaks into the Sales label', () => {
  fc.assert(fc.property(fc.nat(), fc.nat(), fc.constantFrom(' ', '\t', '\n', '\r\n'), (native, vendor, pad) => {
    assert.equal(specialPurchaseOrderDisplayRef({ purchaseOrderRef: pad+'POB'+native+pad, purchaseOrderReference: pad+'SN'+vendor+pad }), `POB${native} / SN${vendor}`);
  }), { seed: 2026100152, numRuns: 200 });
});
test('property: delivery and either pickup method always reach their intended team', () => {
  fc.assert(fc.property(fc.constantFrom('vendor_pickup','mbt_delivery','yard_pickup'), method => {
    assert.equal(poReferenceAlertAudience(method), method === 'vendor_pickup' ? 'sales' : 'dispatch');
  }), { seed: 2026100153, numRuns: 200 });
});

import { specialQueueEventRelevant } from '../../../public/special-stock-queue.js';
test('SCM reference and schedule invalidations refresh the Sales queue even when the new dispatch ref does not match its old number', () => {
  assert.equal(specialQueueEventRelevant({type:'scm.schedule.updated'},[]),true);
  assert.equal(specialQueueEventRelevant({type:'dispatch.orders.updated',payload:{source:'scm-schedule',orderId:'SN1401857'}},[{purchaseOrderRef:'POB03976'}]),true);
  assert.equal(specialQueueEventRelevant({type:'dispatch.orders.updated',payload:{source:'scm-po-ref',orderId:'SN1401857'}},[{purchaseOrderRef:'POB03976'}]),true);
});

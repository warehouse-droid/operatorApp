import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { specialOrderBusyMessage, specialMutationMessage } from '../../../public/special-stock-busy.js';
import { canRequestSpecialClosure, specialClosureStatus, specialClosureNeedsScm } from '../../../public/special-stock-case-status.js';

test('property: only active NetSuite operations lock a case; pending and failed reviews remain actionable', () => {
  fc.assert(fc.property(fc.constantFrom('idle', 'pending', 'creating', 'applying', 'attention', 'linked', 'approved'), fc.constantFrom('sales', 'purchase', 'quantity', 'closure'), (status, kind) => {
    const detail = kind === 'sales' ? { salesOrderOperationStatus: status } : kind === 'purchase' ? { purchaseOrderOperationStatus: status }
      : kind === 'quantity' ? { quantityReview: { status } } : { closureReview: { status } };
    assert.equal(Boolean(specialOrderBusyMessage(detail)), status === (['sales', 'purchase'].includes(kind) ? 'creating' : 'applying'));
  }), { seed: 260927, numRuns: 120 });
  assert.equal(specialOrderBusyMessage(null), '');
  assert.match(specialOrderBusyMessage({ purchaseOrderId: 2, closureReview: { status: 'applying' } }), /Sales Order and Purchase Order/);
});

test('progress text distinguishes remote updates, SCM requests and local saves', () => {
  assert.match(specialMutationMessage('/sales-order/create', undefined, null), /Creating Sales Order/);
  assert.match(specialMutationMessage('/purchase-order/create', undefined, null), /Creating Purchase Order/);
  for (const path of ['/quantity-review', '/closure-review']) {
    assert.equal(specialMutationMessage(path, '{"decision":"reject"}', {}), 'Saving…');
    assert.match(specialMutationMessage(path, '{"decision":"approve"}', { purchaseOrderId: 2 }), /Sales Order and Purchase Order.*NetSuite/);
  }
  assert.match(specialMutationMessage('/close', undefined, {}), /Closing Sales Order/);
  assert.match(specialMutationMessage('/close', undefined, { purchaseOrderId: 2 }), /Requesting SCM/);
  assert.equal(specialMutationMessage('/sales-order-draft', '{}', {}), 'Saving…');
});

test('SO-only closure offers Sales recovery without misleading SCM alerts', () => {
  const detail = { salesOrderId: 1, closeStatus: 'closure_pending', closureReason: '<cancel>', closureReview: { id: 'c', requiresScm: false, status: 'attention', error: '<unavailable>' } };
  assert.equal(specialClosureNeedsScm(detail), false); assert.equal(canRequestSpecialClosure(detail), true);
  assert.match(specialClosureStatus(detail, 'sales'), /Sales can retry/);
  assert.match(specialClosureStatus(detail, 'scm'), /&lt;unavailable&gt;/);
  assert.doesNotMatch(specialClosureStatus(detail, 'scm'), /data-special-closure-review-form/);
  detail.closureReview.status = 'applying'; assert.equal(canRequestSpecialClosure(detail), false);
  assert.match(specialClosureStatus(detail, 'sales'), /Closing the linked Sales Order/);
  assert.equal(canRequestSpecialClosure({ ...detail, closureReview: null }), true);
  assert.equal(canRequestSpecialClosure({ ...detail, closureReview: null, purchaseOrderId: 2 }), false);
});

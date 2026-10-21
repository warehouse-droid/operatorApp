import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { cargoFunctions } from '../../support/sales-order-cargo-fixture.mjs';

function fixture(reviews = [], { planId = '1', loadedPlanId = planId, stored = '[]' } = {}) {
  let raw = stored;
  const api = cargoFunctions(process.env.DISPATCH_REVIEW_SOURCE || '../../public/dispatch.js', [
    'readDismissedExecutedOrderReviews', 'visibleExecutedOrderReviewHistory', 'dismissExecutedOrderReviewHistory'
  ], { currentPlan: { id: planId }, executedOrderReviewPlanId: loadedPlanId, executedOrderReviews: reviews,
    dismissedExecutedOrderReviews: new Set(JSON.parse(stored === 'invalid' ? '[]' : stored) || []),
    DISMISSED_SOURCE_REVIEWS_KEY: 'reviewed', dispatchStorageGet: () => raw,
    dispatchStorageSet: (_key, value) => { raw = value; } });
  return { api, readStored: () => raw };
}

test('corrupt or malformed browser history falls back safely and retains only bounded string keys', () => {
  for (const raw of ['invalid', 'null', '{}', '42']) {
    const api = cargoFunctions(process.env.DISPATCH_REVIEW_SOURCE || '../../public/dispatch.js', ['readDismissedExecutedOrderReviews'], {
      DISMISSED_SOURCE_REVIEWS_KEY: 'reviewed', dispatchStorageGet: () => raw
    });
    assert.deepEqual([...api.readDismissedExecutedOrderReviews()], []);
  }
  const values = Array.from({ length: 700 }, (_, i) => `plan:${i}`);
  const { api } = fixture([], { stored: JSON.stringify([null, 2, ...values]) });
  assert.deepEqual([...api.readDismissedExecutedOrderReviews()], values.slice(-500));
});

test('a stale response for another plan cannot be displayed or dismissed', () => {
  const { api, readStored } = fixture([{ token: 'one', acknowledged: true }], { loadedPlanId: 'old' });
  assert.deepEqual(api.visibleExecutedOrderReviewHistory(), []);
  api.dismissExecutedOrderReviewHistory();
  assert.equal(readStored(), '[]');
});

test('property: dismissal hides exactly reviewed tokens on this plan and persists no pending tokens', () => {
  fc.assert(fc.property(fc.uniqueArray(fc.record({ token: fc.uuid(), acknowledged: fc.boolean() }), {
    selector: row => row.token, minLength: 1, maxLength: 20
  }), reviews => {
    const original = reviews.map(row => Object.create(Object.getPrototypeOf(row), Object.getOwnPropertyDescriptors(row)));
    const current = [...reviews], { api, readStored } = fixture(current);
    const acknowledged = reviews.filter(row => row.acknowledged);
    assert.deepEqual(api.visibleExecutedOrderReviewHistory(), acknowledged);
    api.dismissExecutedOrderReviewHistory();
    assert.deepEqual(api.visibleExecutedOrderReviewHistory(), []);
    assert.deepEqual(JSON.parse(readStored()), acknowledged.map(row => `1:${row.token}`));
    const stored = readStored(); api.dismissExecutedOrderReviewHistory(); assert.equal(readStored(), stored);
    assert.deepEqual(fixture(reviews, { stored }).api.visibleExecutedOrderReviewHistory(), []);
    assert.deepEqual(fixture(reviews, { planId: '2', stored }).api.visibleExecutedOrderReviewHistory(), acknowledged);
    current.push({ token: 'new-change', acknowledged: true });
    assert.deepEqual(api.visibleExecutedOrderReviewHistory(), [current.at(-1)]);
    assert.deepEqual(current.slice(0, -1), original);
  }), { seed: 260926, numRuns: 40, endOnFailure: Boolean(process.env.DISPATCH_REVIEW_SOURCE) });
});

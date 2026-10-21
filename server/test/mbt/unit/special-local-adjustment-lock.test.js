import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import * as adjustments from '../../../src/special-stock-local-adjustments.js';

test('delivery failures before remote preparation permit only local adjustments', () => {
  for (const plan of [undefined, null]) {
    const change = { status: 'attention', plan };
    assert.equal(adjustments.specialFulfillmentBlocksAdjustment?.(change, { localOnly: true }), false);
    assert.equal(adjustments.specialFulfillmentBlocksAdjustment?.(change), true);
  }
});

test('applying deliveries and failed saved plans keep their adjustment locks', () => {
  for (const change of [
    { status: 'applying' }, { status: 'applying', plan: {} },
    { status: 'attention', plan: {} }, { status: 'attention', plan: { target: { methodId: 1 } } }
  ]) {
    assert.equal(adjustments.specialFulfillmentBlocksAdjustment?.(change, { localOnly: true }), true);
    assert.equal(adjustments.specialFulfillmentBlocksAdjustment?.(change), true);
  }
  for (const change of [undefined, null, {}, { status: 'complete' }, { status: 'complete', plan: {} }]) {
    assert.equal(adjustments.specialFulfillmentBlocksAdjustment?.(change, { localOnly: true }), false);
    assert.equal(adjustments.specialFulfillmentBlocksAdjustment?.(change), false);
  }
});

test('property: local-only permission changes only failed, unprepared delivery operations', () => {
  fc.assert(fc.property(fc.constantFrom('applying', 'attention', 'complete'), fc.boolean(), fc.jsonValue(),
    (status, saved, payload) => {
      const change = { status, ...(saved ? { plan: { payload } } : {}) };
      const before = structuredClone(change);
      const blocked = adjustments.specialFulfillmentBlocksAdjustment?.(change, { localOnly: true });
      assert.equal(blocked, status === 'applying' || (status === 'attention' && saved));
      assert.equal(adjustments.specialFulfillmentBlocksAdjustment?.(change), status !== 'complete');
      assert.deepEqual(change, before);
    }), { seed: 631016, numRuns: 150 });
});

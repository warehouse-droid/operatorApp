import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { normalizePurchaseOrderWeightLines } from '../../../src/purchase-order-weight-refresh.js';

test('PO weights property: exact identity, nonnegative decimal weight and isolation from quantity', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 1_000_000_000 }),
    fc.integer({ min: 1, max: 1_000_000_000 }), fc.integer({ min: 0, max: 100_000_000 }),
    fc.integer({ min: 0, max: 1_000_000 }), (lineId, itemId, scaledWeight, quantity) => {
      const weight = scaledWeight / 10_000;
      const input = { line_id: String(lineId), item_id: String(itemId), item_weight: String(weight), quantity };
      const expected = [{ line_id: lineId, item_id: itemId, item_weight: weight }];
      assert.deepEqual(normalizePurchaseOrderWeightLines([input]), expected);
      assert.deepEqual(normalizePurchaseOrderWeightLines(expected), expected);
      assert.equal(input.quantity, quantity);
    }), { numRuns: 150, seed: 3658 });
});

test('PO weights property: no negative value or duplicate unique line can enter an update', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 1_000_000 }), value => {
    const line = { line_id: value, item_id: value + 1, item_weight: value / 100 };
    assert.throws(() => normalizePurchaseOrderWeightLines([{ ...line, item_weight: -value / 100 }]), /weight/i);
    assert.throws(() => normalizePurchaseOrderWeightLines([line, { ...line, item_id: value + 2 }]), /duplicate/i);
  }), { numRuns: 100, seed: 3658 });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { destinationFunctions } from '../../support/dispatch-po-line-destination-functions.mjs';

const { allocatedDispatchPhysicalQuantity: allocated } = destinationFunctions('../../src/dispatch-repository.js',
  ['positiveQuantity', 'isMbbsSpecialLine', 'allocatedDispatchPhysicalQuantity'], { MBBS_SPECIAL_ITEM_ID: 2055 });

test('count UOM sales allocation consumes the same count of loose pieces', () => {
  for (const unit of ['EACH', 'EA', 'PCS', 'PC', 'PIECE', 'PIECES', ' each ']) {
    const item = { unit, quantity: 16, pieces: 16, itemId: 1784 };
    assert.equal(allocated(item, 'pieces', 0, 16), 16, unit);
    assert.equal(allocated(item, 'pieces', 0, 7), 7, unit);
    assert.equal(allocated(item, 'pieces', 0, 99), 16, unit);
    assert.equal(allocated(item, 'pieces', 8, 7), 8, 'explicit physical allocation is retained');
  }
});

test('unrelated units and independent packing do not acquire invented conversions', () => {
  for (const item of [
    { unit: 'SQFT', quantity: 16, pieces: 16 },
    { unit: 'BOX', quantity: 16, pieces: 16 },
    { unit: 'EACH', quantity: 16, pieces: 32 },
    { unit: 'EACH', quantity: 16, pieces: 16, pallets: 1 },
    { unit: 'EACH', quantity: 16, pieces: 16, toPcs: 2 },
    { unit: 'EACH', quantity: 0, pieces: 16 }
  ]) assert.equal(allocated(item, 'pieces', 0, 16), 0);
  assert.equal(allocated({ unit: 'EACH', quantity: 16, pallets: 16 }, 'pallets', 0, 16), 0);
});

test('count allocation conserves cargo for generated totals and partial links', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 100000 }), fc.nat(100000), (total, requested) => {
    const consumed = allocated({ unit: 'EACH', quantity: total, pieces: total }, 'pieces', 0, requested);
    assert.equal(consumed, Math.min(total, requested));
    assert.equal(consumed + (total - consumed), total);
  }), { seed: 302230158, numRuns: 300 });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { normalizeOperatorKitSource, mapOperatorKitSelections, assertOperatorKitStepCurrent } from '../../../src/operator-netsuite-posting-kits.js';
import { kitFixture, kitDraft } from '../../support/operator-kit-fixture.mjs';
import { kitServiceHarness, kitRemote } from '../../support/operator-kit-service-fixture.mjs';

test('property: every complete kit preserves both kit count and all physical member quantities', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 0, max: 20 }),
    fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 5 }), (count, extra, ratios) => {
      const f = kitFixture({ count, ordered: count + extra, ratios });
      const source = normalizeOperatorKitSource(f.evidence);
      const selected = mapOperatorKitSelections(source, [...f.selected].reverse());
      assert.equal(selected.length, 1);
      assert.equal(selected[0].orderLine, 2);
      assert.equal(selected[0].quantity, count);
      assert.deepEqual(selected[0].kit.physicalLines.map(line => line.quantity), ratios.map(ratio => ratio * count));
      const draft = kitDraft(source, selected);
      assert.equal(draft.steps[0].payload.item.items.length, 1);
      assert.equal(draft.steps[0].payload.item.items[0].quantity, count);
      assertOperatorKitStepCurrent(draft.steps[0], source);
      const stale = structuredClone(source); stale.availableLines[0].remainingQuantity = count - 1;
      assert.throws(() => assertOperatorKitStepCurrent(draft.steps[0], stale), { code: 'OPERATOR_NETSUITE_POSTING_KIT_INVALID' });
    }), { seed: 120656, numRuns: 120 });
});

test('property: verified existing kit transactions always recover; uncertain missing transactions never post again', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 8 }), fc.boolean(), async (attemptCount, exists) => {
    const h = kitServiceHarness({ attemptCount,
      find: step => exists ? { id: 8001, record: kitRemote(step) } : null });
    const result = await h.processor.process(h.command.id);
    const canPost = !exists && attemptCount === 0;
    assert.equal(result.status, exists || canPost ? 'completed' : 'attention');
    assert.equal(h.calls.filter(call => call === 'post').length, canPost ? 1 : 0);
    assert.equal(h.calls.filter(call => call === 'source').length, canPost ? 1 : 0);
    assert.equal(h.calls.filter(call => call === 'finalize').length, exists || canPost ? 1 : 0);
  }), { seed: 120658, numRuns: 32 });
});

test('property: prior fulfillment reduces available complete kits even while component progress lags', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 20 }),
    (remaining, completed) => {
      const f = kitFixture({ ordered: remaining + completed, count: remaining, ratios: [2, 3] });
      f.evidence.sourceItems[0].quantityFulfilled = completed;
      const source = normalizeOperatorKitSource(f.evidence);
      assert.equal(source.availableLines[0].remainingQuantity, remaining);
      assert.equal(mapOperatorKitSelections(source, f.selected)[0].quantity, remaining);
      f.selected.forEach((line, index) => { line.quantity = (remaining + 1) * (index + 2); });
      assert.throws(() => mapOperatorKitSelections(source, f.selected), { code: 'OPERATOR_NETSUITE_POSTING_KIT_INVALID' });
    }), { seed: 120659, numRuns: 60 });
});

test('property: a missing, unequal or fractional member never becomes a complete kit', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 2, max: 50 }),
    fc.constantFrom('missing', 'unequal', 'fractional', 'location', 'identity'), (count, ratio, mode) => {
      const f = kitFixture({ count, ordered: count + 5, ratios: [ratio, ratio + 1] });
      const source = normalizeOperatorKitSource(f.evidence);
      if (mode === 'missing') { f.selected.pop(); }
      if (mode === 'unequal') { f.selected[1].quantity += ratio + 1; }
      if (mode === 'fractional') { f.selected.forEach((line, i) => { line.quantity = (count - 0.5) * (ratio + i); }); }
      if (mode === 'location') { f.selected[0].location = 15; }
      if (mode === 'identity') { f.selected[0].itemId++; }
      assert.throws(() => mapOperatorKitSelections(source, f.selected), { code: 'OPERATOR_NETSUITE_POSTING_KIT_INVALID' });
    }), { seed: 120657, numRuns: 100 });
});

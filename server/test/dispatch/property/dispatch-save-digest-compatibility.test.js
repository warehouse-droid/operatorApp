import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fc from 'fast-check';
import { digestDispatchPlan } from '../../../src/dispatch-planner-performance.js';

// Independent compatibility oracle: this is the serializer used by retained
// production fences. A performance change cannot invalidate those receipts.
function retainedCanonical(value) {
  if (value instanceof Date) return value.toJSON();
  if (Array.isArray(value)) return value.map(retainedCanonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, candidate]) => candidate !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, candidate]) => [key, retainedCanonical(candidate)]));
}

test('Digest optimization preserves every canonical byte, including numeric and prototype-like keys', () => {
  fc.assert(fc.property(fc.jsonValue(), data => {
    const plan = { id: '1', planDate: '2027-09-17', status: 'draft', note: '', trucks: [], summary: {},
      orders: [{ id: 'SO-COMPAT-S2', planOwned: true, raw: data,
        special: JSON.parse('{"__proto__":{"zero":0},"constructor":0.125,"2":"two","10":"ten","Å":"unicode","a_b":null}'),
        missing: undefined, values: [undefined, null, 0, -0, 0.000000001], date: new Date('2026-09-17T00:00:00.000Z') }] };
    const expected = crypto.createHash('sha256').update(JSON.stringify(retainedCanonical(plan))).digest('hex');
    assert.equal(digestDispatchPlan(plan), expected);
  }), { seed: 9172026, numRuns: 2000 });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCompactDispatchSnapshot, digestDispatchPlan } from '../../../src/dispatch-planner-performance.js';

test('SAVE-PERF: compaction never traverses unassigned catalog payloads', () => {
  const unassigned = { id: 'CATALOG', type: 'SO' };
  Object.defineProperty(unassigned, 'raw', { enumerable: true, get() { throw new Error('Unassigned raw catalog data was traversed'); } });
  const assigned = { id: 'ASSIGNED', items: [{ quantity: 0 }], raw: { nested: { amount: 1.25 } } };
  const plan = { id: '1', planDate: '2027-01-01', note: '', status: 'draft', orders: [assigned, unassigned],
    trucks: [{ loads: [{ stops: [{ orderRefs: ['ASSIGNED'] }] }] }], summary: { label: 'preserve' } };
  const compact = buildCompactDispatchSnapshot(plan);
  assert.deepEqual(compact.orders, [assigned]);
  assert.equal(digestDispatchPlan(plan), digestDispatchPlan({ ...plan, orders: [assigned] }));
  compact.orders[0].raw.nested.amount = 2;
  compact.summary.label = 'changed';
  assert.equal(assigned.raw.nested.amount, 1.25);
  assert.equal(plan.summary.label, 'preserve');
});

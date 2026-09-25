import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { applyDispatchPlanCommand, assertDispatchPlanFence, createDispatchCommandReceiptStore, digestDispatchPlan } from '../../../src/dispatch-planner-performance.js';

test('SAVE-PROP: generated action sequences preserve fences, exact retries and source independence', () => {
  fc.assert(fc.property(fc.array(fc.record({
    quantity: fc.integer({ min: 0, max: 100000 }), fraction: fc.integer({ min: 0, max: 1000 }),
    note: fc.string({ maxLength: 24 }), overlay: fc.string({ maxLength: 24 })
  }), { minLength: 1, maxLength: 12 }), steps => {
    let plan = { id: '1', planDate: '2027-01-01', status: 'draft', revision: 0, note: '',
      orders: [{ id: 'SO-S2', isSplit: true, originalOrderId: 'SO', planOwned: true, items: [{ quantity: 0 }] }],
      trucks: [{ id: 'TRUCK', loads: [{ id: 'LOAD', stops: [{ id: 'STOP', type: 'delivery', orderRefs: ['SO-S2'] }] }] }], summary: {} };
    const receipts = createDispatchCommandReceiptStore();
    for (const [index, step] of steps.entries()) {
      const before = structuredClone(plan), fence = digestDispatchPlan(before);
      const enriched = { ...structuredClone(before), note: `${before.note}:live-source:${step.overlay}` };
      const nextOrder = { ...before.orders[0], items: [{ quantity: step.quantity, fraction: step.fraction / 1000 }], raw: { nested: { zero: 0, value: step.note } } };
      const command = { commandId: `generated:${index}`, commandType: 'replace_plan', baseRevision: before.revision, baseDigest: fence,
        payload: { orders: [nextOrder], trucks: before.trucks, summary: { note: step.note } } };
      assert.throws(() => assertDispatchPlanFence(before, { baseRevision: before.revision + 1, baseDigest: fence }, { required: true }), { code: 'STALE_DISPATCH_PLAN' });
      assert.throws(() => assertDispatchPlanFence(before, { baseRevision: before.revision, baseDigest: `different:${fence}` }, { required: true }), { code: 'STALE_DISPATCH_PLAN' });
      assert.throws(() => assertDispatchPlanFence(before, { baseRevision: before.revision }, { required: true }), { code: 'DISPATCH_PLAN_FENCE_REQUIRED' });
      const result = applyDispatchPlanCommand({ plan: enriched, persistedPlan: before, command, receiptStore: receipts });
      assert.equal(result.revision, before.revision + 1);
      assert.deepEqual(result.plan.orders[0].items, nextOrder.items);
      assert.deepEqual(result.plan.orders[0].raw, nextOrder.raw);
      assert.deepEqual(before, plan, 'caller-owned snapshot is never mutated');
      assert.equal(result.digest, digestDispatchPlan(result.plan));
      const replay = applyDispatchPlanCommand({ plan: result.plan, command, receiptStore: receipts });
      assert.equal(replay.replay, true);
      assert.equal(replay.revision, result.revision);
      assert.deepEqual(replay.plan, result.plan);
      assert.throws(() => applyDispatchPlanCommand({ plan: result.plan, command: { ...command, payload: { ...command.payload, summary: { hostileReuse: true } } }, receiptStore: receipts }), { code: 'DISPATCH_COMMAND_ID_REUSED' });
      const tampered = structuredClone(before); tampered.orders[0].items[0].quantity++;
      assert.throws(() => assertDispatchPlanFence(tampered, { baseRevision: before.revision, baseDigest: fence }, { required: true }), { code: 'STALE_DISPATCH_PLAN' });
      plan = result.plan;
    }
  }), { numRuns: 10000, seed: 9172026, endOnFailure: true });
});

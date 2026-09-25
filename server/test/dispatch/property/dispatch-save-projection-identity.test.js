import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { reconcileDependencyManagedPickups } from '../../../src/scm-dependency-plan-reconciler.js';

test('Source, sibling split, and group identities survive dependency refresh in every ordering', () => {
  fc.assert(fc.property(fc.shuffledSubarray([0, 1, 2, 3], { minLength: 4, maxLength: 4 }),
    fc.integer({ min: 0, max: 100000 }), (ordering, amount) => {
      const definitions = [
        { id: 'SO-SOURCE', type: 'SO', raw: { quantity: amount + 0.125 } },
        { id: 'SO-SOURCE-S1', type: 'SO', originalOrderId: 'SO-SOURCE', raw: { quantity: 0 } },
        { id: 'SO-SOURCE-S2', type: 'SO', originalOrderId: 'SO-SOURCE', raw: { quantity: amount + 0.25 } },
        { id: 'SO-GROUP', type: 'SO', childOrders: ['SO-SOURCE-S1', 'SO-SOURCE-S2'], raw: { quantity: amount + 0.25 } }
      ];
      const orders = ordering.map(i => definitions[i]);
      const enrichedOrders = orders.map(order => ({ ...order, pickupLocations: ['12441'], refreshed: true }));
      const next = reconcileDependencyManagedPickups({ plan: { orders, trucks: [] }, enrichedOrders });
      assert.deepEqual(next.orders, enrichedOrders);
      assert.equal(new Set(next.orders.map(order => order.id)).size, 4);
      assert.deepEqual(orders, ordering.map(i => definitions[i]), 'caller records remain unchanged');
    }), { seed: 9172026, numRuns: 2000 });
});

test('An aggregate projection cannot rename an existing member when its own projection is absent', () => {
  const member = { id: 'SO-MEMBER', type: 'SO', items: [{ quantity: 0.125 }] };
  const group = { id: 'SO-GROUP', type: 'SO', childOrders: ['SO-MEMBER', 'SO-OTHER'] };
  const next = reconcileDependencyManagedPickups({ plan: { orders: [member], trucks: [] }, enrichedOrders: [group] });
  assert.deepEqual(next.orders, [member, group]);
});

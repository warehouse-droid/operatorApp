// Read-only verification using the deployed pool module and actual legacy query.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { query, closeDb } from '/app/src/db.js';
import { listDispatchOrderPool, getDispatchOrderCatalogOrder } from '/app/src/dispatch-order-catalog-repository.js';
import { applyActiveTransitCoMetadata, clearCancelledTransitCoMetadata } from '/app/src/dispatch-planner-performance.js';

try {
  const source = await fs.readFile('/app/src/server.js', 'utf8');
  const context = vm.createContext({ query, isNetSuiteSandboxEnvironment: () => false,
    applyActiveTransitCoMetadata, clearCancelledTransitCoMetadata });
  for (const [start, end] of [
    ['function isSnapshotDerivedDispatchOrder(', 'async function listRestrictedScmDispatchOrderRefs('],
    ['function dispatchOrderLogicalRefs(', 'function dispatchOrderScmRestrictionRefs('],
    ['function snapshotDerivedGroupBelongsToPlan(', 'async function listDispatchSnapshotDerivedOrders('],
    ['async function listDispatchSnapshotDerivedOrders(', 'function mergeDispatchOrderFeedWithSnapshotDerivedOrders(']
  ]) {
    const left = source.indexOf(start), right = source.indexOf(end, left);
    assert.ok(left >= 0 && right > left);
    vm.runInContext(source.slice(left, right), context);
  }
  const pool = await listDispatchOrderPool({ type: 'SO', search: 'SOB120921' });
  const legacy = await context.listDispatchSnapshotDerivedOrders({ type: 'SO', search: 'SOB120921' });
  for (const orders of [pool.orders, legacy]) {
    assert.ok(!orders.some(row => row.id === 'SOB120921-S2'), 'Pick-Up split leaked into delivery pool');
  }
  const group = pool.orders.find(row => row.id.startsWith('GOB-120921'));
  assert.ok(group);
  const order = await getDispatchOrderCatalogOrder(group.id);
  assert.equal(order.pallets, 23);
  assert.deepEqual(order.childOrders, ['SOB120921-S1','SOB121097']);
  assert.equal((await query("SELECT sales_order_type FROM sales_orders WHERE tranid='SOB120921-S2'")).rows[0].sales_order_type, 'Pick-Up');
  console.log(JSON.stringify({ groupRef: order.id, pallets: 23, pickupExcludedFromPool: true,
    pickupExcludedFromLegacy: true, pickupMethod: 'Pick-Up', poolRefs: pool.orders.map(row => row.id) }));
} finally { await closeDb(); }

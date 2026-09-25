// Simulated source refreshes on retained identities, never claimed as recovered
// historical event payloads. Runs only in an isolated database; retained-history
// callers roll the event and save back together after checking their outcome.
import assert from 'node:assert/strict';
import { query } from '../../src/db.js';
import { reconcileDispatchGlobalOrderSources } from '../../src/dispatch-delivery-group-repository.js';

export async function simulateDispatchSourceEvent(plan, sequence) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const refs = new Set();
  function collect(order) {
    if (order?.id) refs.add(String(order.id).toLowerCase());
    for (const child of order?.childOrderDetails || []) collect(child);
  }
  for (const order of plan.orders || plan.assignedOrderSnapshots || []) collect(order);
  const candidates = await query(`SELECT split_ref,parent_order_ref,order_type,full_order
    FROM dispatch_global_order_splits WHERE active=true AND lower(split_ref)=ANY($1::text[])
      AND full_order->>'type' IN ('SO','PO','TO')
    ORDER BY split_ref LIMIT 1`, [[...refs]]);
  const definition = candidates.rows[0];
  if (!definition) return { simulated: false, reason: 'No retained active split source in this state; not counted as a source event.' };
  const current = definition.full_order;
  const table = { SO: 'sales_orders', PO: 'purchase_orders', TO: 'transfer_orders' }[current.type];
  if (!table) return { simulated: false, reason: 'Source is local CO/custom data, not a NetSuite refresh.' };
  const marker = `save-source-event-${sequence}`;
  const source = { ...current, id: definition.parent_order_ref, orderId: definition.parent_order_ref,
    originalOrderId: undefined, isSplit: false, sourceTable: table,
    instructions: marker, notes: marker,
    raw: { ...current.raw, saveSimulation: { sequence, zero: 0, fraction: 0.125 } } };
  const updated = await reconcileDispatchGlobalOrderSources({ orders: [source] });
  assert.ok(updated.splits.includes(definition.split_ref), 'the real source-refresh path must update the selected definition');
  const stored = (await query('SELECT full_order FROM dispatch_global_order_splits WHERE split_ref=$1', [definition.split_ref])).rows[0].full_order;
  assert.equal(stored.instructions, marker);
  assert.equal(stored.raw.saveSimulation.zero, 0);
  assert.equal(stored.raw.saveSimulation.fraction, 0.125);
  return { simulated: true, marker, sourceTable: table, splitRef: definition.split_ref,
    updatedSplits: updated.splits.length, updatedGroups: updated.groups.length };
}

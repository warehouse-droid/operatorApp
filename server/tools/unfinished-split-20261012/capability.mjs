import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { query, withTransaction, closeDb } from './src/db.js';
import { getNextDispatchSplitSuffix } from './src/delivery-repository.js';
import { assertSalesDeliveryPlanningAllowed } from './src/dispatch-fulfilled-so-repository.js';
import { getOperatorProgressDetails } from './src/operator-order-progress-repository.js';
import { buildSalesResplits } from './src/dispatch-sales-resplit-repository.js';
try {
  assert.equal((await fetch('http://127.0.0.1:3000/api/dispatch/split-orders/resplit', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  const page = await fetch('http://127.0.0.1:3000/dispatch/planning');
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('/dispatch.js?v=20261012-unfinished-resplit'));
  assert.ok(readFileSync('public/dispatch.js', 'utf8').includes('fetch("/api/dispatch/split-orders/resplit"'));
  const preview = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    await assertSalesDeliveryPlanningAllowed(['SOA09143-S2'], 'split its unfinished quantity');
    const progress = await getOperatorProgressDetails(['SOA09143-S2']);
    assert.equal(progress[0].status, 'open');
    assert.equal((await query("SELECT 1 FROM dispatch_plan_order_assignments WHERE order_ref='SOA09143-S2' OR planned_order_ref='SOA09143-S2'")).rowCount, 0);
    const source = (await query("SELECT full_order FROM dispatch_global_order_splits WHERE split_ref='SOA09143-S2' AND active=true")).rows[0].full_order;
    const seed = await getNextDispatchSplitSuffix({ originalOrderId: 'SOA09143-S2', orderType: 'SO' });
    const parts = [36, 35, 35].map(quantity => ({ items: [{ ...source.items[0], quantity }, { ...source.items[1], quantity: 1 }] }));
    const result = buildSalesResplits(source, parts, seed.nextSuffix);
    return { orderRefs: result.map(order => order.id), palletItemQuantities: result.map(order => order.items[0].quantity),
      chargeQuantities: result.map(order => order.items[1].quantity) };
  });
  console.log(JSON.stringify({ featureAvailable: true, unauthorizedBlocked: true, extraButtonAdded: false,
    readOnlySplitPreview: preview, actualOrderSplitPerformed: false }));
} finally { await closeDb(); }

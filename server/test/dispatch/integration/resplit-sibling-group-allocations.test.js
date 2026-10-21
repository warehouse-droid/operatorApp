import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import fc from 'fast-check';
import { query } from '../../../src/db.js';
import { resplitUnfinishedSalesOrder } from '../../../src/dispatch-sales-resplit-repository.js';
import { getDispatchSplitPreview } from '../../../src/dispatch-split-preview-repository.js';
import { getNextDispatchSplitSuffix } from '../../../src/delivery-repository.js';
import { createDispatchV2Fixture } from '../support/dispatch-v2-fixture.js';
import { scenario } from '../support/fulfilled-so-fixture.js';
import { seedUnfinishedSplit, seedResplitPoLink } from '../support/unfinished-sales-resplit-fixture.js';

let http;
before(async () => { http = await createDispatchV2Fixture(); });
after(async () => http?.close());
const request = f => ({ orderRef: f.source.id, planId: f.current.id, planDate: f.current.planDate,
  expectedItems: f.source.items, parts: f.parts });
const links = f => query(`SELECT to_jsonb(a) AS value FROM dispatch_so_po_allocations a
  WHERE po_order_ref=$1 ORDER BY id`, [`PO-${f.parent}`]).then(result => result.rows);
async function grouped(f, legacy = true, quantity = 30) {
  await seedResplitPoLink(f, f.first.id);
  await query(`UPDATE dispatch_so_po_allocations SET sales_order_ref=$1,dispatch_target_ref=$2,
    dispatch_target_kind='group',dispatch_target_line_key=$2||'::'||$1||'::1',
    allocated_sales_qty=$3 WHERE po_order_ref=$4`,
  [legacy ? f.parent : f.first.id, f.group.id, quantity, `PO-${f.parent}`]);
}

test('completed sibling group PO allocation using the root SO does not block resplitting the selected child', () => scenario(async () => {
  const f = await seedUnfinishedSplit(); await grouped(f);
  const before = await f.history(), allocation = await links(f);
  assert.equal((await getDispatchSplitPreview({ orderRef: f.source.id, type: 'SO' })).id, f.source.id);
  assert.equal((await getNextDispatchSplitSuffix({ originalOrderId: f.source.id, orderType: 'SO' })).nextSuffix, 3);
  await assert.rejects(getNextDispatchSplitSuffix({ originalOrderId: f.parent, orderType: 'SO' }),
    { code: 'DISPATCH_SPLIT_ALLOCATED' });
  const result = await resplitUnfinishedSalesOrder(request(f));
  assert.deepEqual(result.orders.map(order => order.id), [3, 4, 5].map(n => `${f.parent}-S${n}`));
  assert.equal(result.orders.reduce((sum, order) => sum + order.salesQty, 0), f.source.salesQty);
  assert.deepEqual(await links(f), allocation);
  assert.deepEqual(await f.history(), before);
}));

test('selected child allocation stays blocked and cannot be bypassed by sibling group links', () => scenario(async () => {
  const f = await seedUnfinishedSplit(); await grouped(f);
  await query(`UPDATE dispatch_so_po_allocations SET dispatch_target_ref=$1,dispatch_target_kind='split'
    WHERE po_order_ref=$2`, [f.source.id, `PO-${f.parent}`]);
  const allocation = await links(f), history = await f.history();
  await assert.rejects(getNextDispatchSplitSuffix({ originalOrderId: f.source.id, orderType: 'SO' }),
    { code: 'DISPATCH_SPLIT_ALLOCATED' });
  await assert.rejects(resplitUnfinishedSalesOrder(request(f)), { code: 'DISPATCH_SPLIT_RESERVED' });
  assert.deepEqual(await links(f), allocation);
  assert.deepEqual(await f.history(), history);
  assert.equal((await query('SELECT active FROM dispatch_global_order_splits WHERE split_ref=$1', [f.source.id])).rows[0].active, true);
}));

test('property: sibling group links never block a valid child, and moving the link to that child always blocks numbering', () => scenario(async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.integer({ min: 1, max: 30 }), async (legacy, quantity) => {
    await scenario(async () => {
      const f = await seedUnfinishedSplit(); await grouped(f, legacy, quantity);
      const allocation = await links(f), before = await f.history();
      const seed = await getNextDispatchSplitSuffix({ originalOrderId: f.source.id, orderType: 'SO' });
      assert.equal(seed.originalOrderId, f.parent);
      assert.equal(seed.nextSuffix, 3);
      const result = await resplitUnfinishedSalesOrder(request(f));
      assert.deepEqual(result.orders.map(order => order.id), [3, 4, 5].map(n => `${f.parent}-S${n}`));
      assert.deepEqual(await links(f), allocation);
      assert.deepEqual(await f.history(), before);
      await query(`UPDATE dispatch_so_po_allocations SET dispatch_target_ref=$1,dispatch_target_kind='split'
        WHERE po_order_ref=$2`, [result.orders[0].id, `PO-${f.parent}`]);
      await assert.rejects(getNextDispatchSplitSuffix({ originalOrderId: result.orders[0].id, orderType: 'SO' }),
        { code: 'DISPATCH_SPLIT_ALLOCATED' });
    });
  }), { seed: 20261020, numRuns: 12 });
}));

test('HTTP resplits an unallocated child with a completed sibling group PO link, preserves history, and retries safely', async () => {
  const f = await seedUnfinishedSplit({ date: '2098-10-24' }); await grouped(f);
  const allocation = await links(f), before = await f.history();
  const sessionId = `sibling-group-${f.id}`;
  const lease = await http.acquireLease({ planDate: f.current.planDate, sessionId });
  const body = { ...request(f), audit: { sessionId } };
  const submit = () => http.request('/api/dispatch/split-orders/resplit',
    { method: 'POST', headers: { 'x-dispatch-edit-lease': lease }, body });
  const result = await submit();
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.deepEqual(result.payload.orders.map(order => order.id), [3, 4, 5].map(n => `${f.parent}-S${n}`));
  assert.deepEqual(await links(f), allocation);
  assert.deepEqual(await f.history(), before);
  const replay = await submit();
  assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
  assert.deepEqual(replay.payload.orders.map(order => order.id), result.payload.orders.map(order => order.id));
  assert.equal((await query("SELECT count(*)::int AS count FROM dispatch_audit_log WHERE action='order_resplit' AND order_id=$1",
    [f.source.id])).rows[0].count, 1);
});

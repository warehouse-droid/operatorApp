import assert from "node:assert/strict";
import fc from "fast-check";
import { seedSalesOrder } from "../support/fulfilled-so-fixture.js";
import test, { before, after } from "node:test";
import { query, withTransaction } from "../../../src/db.js";
import { getDispatchSplitPreview } from "../../../src/dispatch-split-preview-repository.js";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";
import { seedUnfinishedSplit } from "../support/unfinished-sales-resplit-fixture.js";

let http, fixture;
before(async () => { http = await createDispatchV2Fixture(); fixture = await seedUnfinishedSplit({ date: '2097-10-20' }); });
after(async () => http?.close());
const preview = () => getDispatchSplitPreview({ orderRef: fixture.source.id, type: 'SO' });

test('compact exact S2 read retains its quantities and completed S1 history inside a READ ONLY transaction', async () => {
  const prior = await fixture.history();
  const result = await withTransaction(async () => { await query('SET TRANSACTION READ ONLY'); return preview(); });
  assert.equal(result.id, fixture.source.id);
  assert.equal(result.operatorStatus, 'open');
  assert.deepEqual(result.items.map(item => item.quantity), [106, 3]);
  assert.deepEqual(await fixture.history(), prior);
});

for (const [label, update, status] of [
  ['packed line with stale open header', 'UPDATE sales_order_lines SET packed_sales_qty=1 WHERE sales_order_id=$1', 'packed'],
  ['loaded line with stale open header', 'UPDATE sales_order_lines SET loaded_qty=1 WHERE sales_order_id=$1', 'loaded'],
  ['confirmed line with stale open header', 'UPDATE sales_order_lines SET confirmed=true WHERE sales_order_id=$1', 'packed'],
  ['confirmed timestamp', "UPDATE sales_order_lines SET confirmed_at=now() WHERE sales_order_id=$1", 'packed'],
  ['packed header', "UPDATE sales_orders SET operator_status='packed' WHERE netsuite_id=$1", 'packed'],
  ['loaded header', "UPDATE sales_orders SET local_yard_order_status='Loaded' WHERE netsuite_id=$1", 'loaded']
]) {
  test(`fresh compact preview detects ${label}`, async () => {
    await withTransaction(async () => { await query(update, [-fixture.id]); assert.equal((await preview()).operatorStatus, status); }, { rollback: true });
  });
}

test('native S2 progress does not inherit completed or packed parent/S1 progress', async () => {
  await withTransaction(async () => {
    await query("UPDATE sales_orders SET operator_status='packed',local_yard_order_status='Loaded' WHERE netsuite_id=$1", [fixture.id]);
    assert.equal((await preview()).operatorStatus, 'open');
  }, { rollback: true });
});

test('registered-only split keeps its own items and uses fresh parent packing protection', async () => {
  await withTransaction(async () => {
    await query('DELETE FROM sales_orders WHERE netsuite_id=$1', [-fixture.id]);
    await query("UPDATE sales_orders SET operator_status='packed' WHERE netsuite_id=$1", [fixture.id]);
    const result = await preview();
    assert.equal(result.operatorStatus, 'packed');
    assert.deepEqual(result.items.map(item => item.quantity), [106, 3]);
  }, { rollback: true });
});

test('first-level native preview refreshes current quantities and canonical conversion fields', async () => {
  const result = await getDispatchSplitPreview({ orderRef: fixture.parent, type: 'SO' });
  assert.deepEqual(result.items.map(item => item.quantity), [136, 4]);
  assert.equal(result.items[0].lineId, 1);
  assert.equal(result.items[0].itemId, 817159900);
});

test('inactive or retired split cannot use the active parent to bypass status verification', async () => {
  await withTransaction(async () => {
    await query('UPDATE dispatch_global_order_splits SET active=false WHERE split_ref=$1', [fixture.source.id]);
    await assert.rejects(preview(), { code: 'DISPATCH_DERIVED_ORDER_RETIRED' });
  }, { rollback: true });
  await withTransaction(async () => {
    await query('UPDATE sales_orders SET netsuite_active=false WHERE netsuite_id=$1', [-fixture.id]);
    await assert.rejects(preview(), { code: 'DISPATCH_SPLIT_NOT_AVAILABLE' });
  }, { rollback: true });
});

test('unknown references and unsupported types fail closed', async () => {
  await assert.rejects(getDispatchSplitPreview({ orderRef: 'SO-NOT-FOUND', type: 'SO' }), { code: 'DISPATCH_SPLIT_NOT_AVAILABLE' });
  await assert.rejects(getDispatchSplitPreview({ orderRef: fixture.source.id, type: 'PO' }), { code: 'DISPATCH_SPLIT_TYPE_INVALID' });
});

test('TO preview ignores receiving lines while checking outbound loaded/packed quantities', async () => {
  await withTransaction(async () => {
    const id = fixture.id + 5, ref = 'TO-COMPACT-PREVIEW';
    await query("INSERT INTO transfer_orders(netsuite_id,tranid,status,netsuite_active,outbound_operator_status,local_yard_order_status) VALUES($1,$2,'B',true,'open','Open')", [id, ref]);
    await query("INSERT INTO transfer_order_lines(transfer_order_id,line_stage,line_id,item_id,item_name,sku,quantity,netsuite_active,loaded_qty) VALUES($1,'outbound',1,817159900,'Cargo','Cargo',10,true,0),($1,'receiving',1,817159900,'Cargo','Cargo',10,true,10)", [id]);
    const result = await getDispatchSplitPreview({ orderRef: ref, type: 'TO' });
    assert.equal(result.operatorStatus, 'open'); assert.equal(result.items.length, 1);
    await query("UPDATE transfer_order_lines SET packed_piece_qty=1 WHERE transfer_order_id=$1 AND line_stage='outbound'", [id]);
    assert.equal((await getDispatchSplitPreview({ orderRef: ref, type: 'TO' })).operatorStatus, 'packed');
  }, { rollback: true });
});

test('exact preview endpoint is private, uncached and small without a full order-feed read', async () => {
  const path = `/api/dispatch/orders/${fixture.source.id}/split-preview?type=SO`;
  const result = await http.request(path);
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.match(result.response.headers.get('cache-control'), /no-store/u);
  assert.equal(result.payload.id, fixture.source.id);
  assert.ok(result.responseBytes < 8192);
  assert.ok(result.durationMs < 1000, `Compact read took ${result.durationMs}ms`);
  assert.equal((await http.request(path, { token: '' })).response.status, 401);
  const missing = await http.request('/api/dispatch/orders/SO-NOT-FOUND/split-preview?type=SO');
  assert.equal(missing.response.status, 404);
  assert.equal(missing.payload.code, 'DISPATCH_SPLIT_NOT_AVAILABLE');
});


test('ambiguous parent cannot supply the registered split status', async () => {
  await withTransaction(async () => {
    await query('DELETE FROM sales_orders WHERE netsuite_id=$1', [-fixture.id]);
    await seedSalesOrder(fixture.id + 8, fixture.parent, { status: 'B' });
    await assert.rejects(preview(), { code: 'DISPATCH_SPLIT_NOT_AVAILABLE' });
  }, { rollback: true });
});

test('loaded CO evidence remains a source-splitting protection', async () => {
  await withTransaction(async () => {
    await query(`INSERT INTO local_co_orders(co_ref,source_order_ref,from_location_id,from_location,to_location_id,to_location,status,loaded_at)
      VALUES('CO-FAST-PREVIEW',$1,1,'3445',26,'150','loaded',now())`, [fixture.source.id]);
    assert.equal((await preview()).operatorStatus, 'loaded');
  }, { rollback: true });
});

test('property: preview reflects fresh positive packed and loaded quantities across native line fields', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 200 }), fc.integer({ min: 0, max: 200 }), async (packed, loaded) => {
    await withTransaction(async () => {
      await query('UPDATE sales_order_lines SET packed_sales_qty=$2,loaded_qty=$3 WHERE sales_order_id=$1', [-fixture.id, packed, loaded]);
      assert.equal((await preview()).operatorStatus, loaded > 0 ? 'loaded' : packed > 0 ? 'packed' : 'open');
    }, { rollback: true });
  }), { seed: 20261012, numRuns: 15 });
});

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after } from 'node:test';
import { query, withTransaction, closeDb } from '../../../src/db.js';
import { createOperator } from '../../../src/auth-repository.js';
import { getDeliveryOrder } from '../../../src/delivery-repository.js';
import { finalizeOperatorNetSuitePosting } from '../../../src/operator-netsuite-posting-finalizer.js';
import { createOperatorNetSuitePostingProcessor } from '../../../src/operator-netsuite-posting-service.js';
import { createOperatorNetSuitePostingAdapter } from '../../../src/operator-netsuite-posting-netsuite-adapter.js';
import { createOperatorNetSuitePostingRealSourceResolver, createOperatorNetSuitePostingTargetResolver } from '../../../src/operator-netsuite-posting-targets.js';
import { normalizeOperatorKitSource } from '../../../src/operator-netsuite-posting-kits.js';
import * as repo from '../../../src/operator-netsuite-posting-repository.js';
import { sobFixture, kitDraft } from '../../support/operator-kit-fixture.mjs';
import { kitRemote } from '../../support/operator-kit-service-fixture.mjs';

after(closeDb);
const repository = { get: repo.getOperatorNetSuitePostingCommand, claim: repo.claimOperatorNetSuitePostingCommand,
  renew: repo.renewOperatorNetSuitePostingLease, startAttempt: repo.startOperatorNetSuitePostingAttempt,
  success: repo.recordOperatorNetSuitePostingStepSuccess, failure: repo.recordOperatorNetSuitePostingStepFailure,
  attention: repo.markOperatorNetSuitePostingCommandAttention, fail: repo.failOperatorNetSuitePostingCommand,
  complete: repo.completeOperatorNetSuitePostingCommand };

async function fixture(run, { kitOrdered = 1, kitConfirmed = 1 } = {}) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  return withTransaction(async () => {
    const actor = await createOperator({ username: `kit-${crypto.randomUUID()}`, displayName: 'Kit fulfillment test',
      password: 'test-only', role: 'operator', roles: ['operator'], yardLocationIds: [1] });
    await query(`INSERT INTO sales_orders(netsuite_id,tranid,outbound_location_id,netsuite_active,sales_order_type,
      operator_status,status,status_text) VALUES(997764,'SOB120656',1,true,'Pick-Up','packed','B','Pending Fulfillment')`);
    const f = sobFixture();
    f.evidence.sourceItems[1].quantity = kitOrdered;
    f.evidence.sourceRows[1].quantity = String(-kitOrdered);
    f.evidence.sourceRows[2].quantity = String(-kitOrdered);
    for (const row of f.evidence.sourceRows) {
      const quantity = Math.abs(Number(row.quantity));
      await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,netsuite_order_line,item_id,item_type,
        quantity,unit,location_id,netsuite_active,packed_sales_qty)
        VALUES(997764,$1,$2,$3,$4,$5,'EA',1,true,$6)`,
      [row.uniquekey, row.id, row.item, row.itemtype, quantity,
        row.itemtype === 'Kit' ? 0 : Number(row.item) === 599 ? kitConfirmed : quantity]);
    }
    const source = normalizeOperatorKitSource(f.evidence);
    const resolve = createOperatorNetSuitePostingTargetResolver({ getDeliveryOrder,
      resolveRealSource: createOperatorNetSuitePostingRealSourceResolver({ query, useStoredOrderLines: true, fetchKitSource: async () => source }) });
    const resolution = await resolve({ functionKey: 'customer_pickup', orderId: 997764, clientLocationId: 1 });
    const draft = kitDraft(source, resolution.targets[0].selectedLines, { requestId: crypto.randomUUID(),
      actorOperatorId: actor.id, photoRefs: ['r2://test-kit/one.jpg', 'r2://test-kit/two.jpg'] });
    return run({ source, draft });
  }, { rollback: true });
}

test('durable kit command retains component evidence and finalizes real physical quantities exactly once', async () => {
  await fixture(async ({ source, draft }) => {
    await repo.createOrReplayOperatorNetSuitePostingCommand(draft);
    let posts = 0;
    const adapter = createOperatorNetSuitePostingAdapter({ fetchKitSource: async () => source,
      findTransactionByExternalId: async () => null,
      transformSalesOrderToItemFulfillment: async (_id, payload) => {
        posts++;
        assert.deepEqual(payload.item.items.map(line => [line.orderLine, line.quantity]), [[1, 95.6], [2, 1]]);
        return { id: 8800656 };
      }, fetchItemFulfillment: async () => kitRemote(draft.steps[0], 8800656) });
    const processor = createOperatorNetSuitePostingProcessor({ repository, adapter, finalize: finalizeOperatorNetSuitePosting, workerId: 'kit-db' });
    const result = await processor.process(draft.requestId);
    assert.equal(result.status, 'completed', result.lastError);
    const persisted = await repo.getOperatorNetSuitePostingCommand(draft.requestId);
    assert.deepEqual(persisted.steps[0].lineSnapshot[1].kit, draft.steps[0].lineSnapshot[1].kit);
    await processor.process(draft.requestId);
    const quantities = (await query(`SELECT item_id, loaded_qty, packed_sales_qty FROM sales_order_lines
      WHERE sales_order_id=997764 ORDER BY netsuite_order_line`)).rows;
    assert.deepEqual(quantities.map(row => [Number(row.item_id), Number(row.loaded_qty), Number(row.packed_sales_qty)]),
      [[2141, 95.6, 0], [10126, 0, 0], [599, 1, 0]]);
    assert.equal(posts, 1);
    assert.equal(Number((await query(`SELECT count(*) FROM operator_load_records WHERE order_id=997764`)).rows[0].count), 1);
    assert.equal(persisted.activeClaims.length, 0);
    assert.equal(persisted.steps[0].attemptCount, 1);
    const status = (await query('SELECT operator_status, local_yard_order_status FROM sales_orders WHERE netsuite_id=997764')).rows[0];
    assert.deepEqual(status, { operator_status: 'loaded', local_yard_order_status: 'loaded' });
  });
});

test('fulfilling fewer complete kits keeps the remaining physical component quantity open', async () => {
  await fixture(async ({ source, draft }) => {
    await repo.createOrReplayOperatorNetSuitePostingCommand(draft);
    assert.equal(draft.steps[0].payload.item.items[1].quantity, 2);
    const adapter = createOperatorNetSuitePostingAdapter({ fetchKitSource: async () => source,
      findTransactionByExternalId: async () => null, transformSalesOrderToItemFulfillment: async () => ({ id: 8800657 }),
      fetchItemFulfillment: async () => kitRemote(draft.steps[0], 8800657) });
    const processor = createOperatorNetSuitePostingProcessor({ repository, adapter, finalize: finalizeOperatorNetSuitePosting, workerId: 'kit-db-partial' });
    const result = await processor.process(draft.requestId);
    assert.equal(result.status, 'completed', result.lastError);
    const row = (await query('SELECT quantity,loaded_qty FROM sales_order_lines WHERE sales_order_id=997764 AND item_id=599')).rows[0];
    assert.deepEqual([Number(row.quantity), Number(row.loaded_qty)], [3, 2]);
    assert.equal((await query('SELECT operator_status FROM sales_orders WHERE netsuite_id=997764')).rows[0].operator_status, 'partial_loaded');
  }, { kitOrdered: 3, kitConfirmed: 2 });
});

test('durable stale-kit rejection posts nothing, preserves physical stock and releases source claims', async () => {
  await fixture(async ({ source, draft }) => {
    await repo.createOrReplayOperatorNetSuitePostingCommand(draft);
    const current = structuredClone(source); current.availableLines[1].remainingQuantity = 0;
    let posts = 0;
    const adapter = createOperatorNetSuitePostingAdapter({ fetchKitSource: async () => current,
      findTransactionByExternalId: async () => null, transformSalesOrderToItemFulfillment: async () => { posts++; return { id: 9 }; } });
    const processor = createOperatorNetSuitePostingProcessor({ repository, adapter, finalize: finalizeOperatorNetSuitePosting, workerId: 'kit-db-stale' });
    const result = await processor.process(draft.requestId);
    assert.equal(result.status, 'failed');
    assert.equal(posts, 0);
    assert.equal(result.activeClaims.length, 0);
    const rows = (await query(`SELECT item_id, loaded_qty, packed_sales_qty FROM sales_order_lines
      WHERE sales_order_id=997764 ORDER BY netsuite_order_line`)).rows;
    assert.deepEqual(rows.map(row => [Number(row.item_id), Number(row.loaded_qty), Number(row.packed_sales_qty)]),
      [[2141, 0, 95.6], [10126, 0, 0], [599, 0, 1]]);
  });
});

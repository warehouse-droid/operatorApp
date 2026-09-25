import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after } from 'node:test';
import { query, closeDb, withTransaction } from '../../../src/db.js';
import { itemFulfillmentPartsRepository as repo } from '../../../src/item-fulfillment-parts-repository.js';
import { splitItemFulfillmentPayload } from '../../../src/item-fulfillment-parts-domain.js';

after(closeDb);
function source() {
  const externalId = `MBBS-TEST-${crypto.randomUUID()}`;
  return { externalId, sourceNetSuiteId: 996102, sourceOrderKind: 'SO', transactionType: 'IF',
    payload: { externalId, item: { items: [
      { orderLine: 1, location: 1, quantity: 2, itemReceive: true },
      { orderLine: 3, location: 14, quantity: 51.26, itemReceive: true }
    ] } } };
}
test('D1 durable plan is immutable and repeated creation preserves its parts', async () => {
  const step = source(), parts = splitItemFulfillmentPayload(step.payload);
  const plan = await repo.create(step, parts);
  assert.equal(plan.parts.length, 2);
  assert.deepEqual((await repo.create(step, parts)).parts.map(p => p.id), plan.parts.map(p => p.id));
  const changed = structuredClone(step); changed.payload.item.items[0].quantity = 7;
  await assert.rejects(repo.create(changed, splitItemFulfillmentPayload(changed.payload)), /immutable|conflict|changed/i);
  await assert.rejects(query('UPDATE netsuite_item_fulfillment_parts SET location_id=28 WHERE id=$1', [plan.parts[0].id]), /immutable/i);
});
test('D2 concurrent workers acquire only one fresh part attempt', async () => {
  const step = source();
  const plan = await repo.create(step, splitItemFulfillmentPayload(step.payload));
  const results = await Promise.all([repo.claim(plan.parts[0]), repo.claim(plan.parts[0])]);
  assert.equal(results.filter(r => r.fresh).length, 1);
  assert.equal((await repo.get(step)).parts[0].status, 'posting');
  const claimed = results.find(r => r.fresh);
  await repo.fail(claimed, new Error('timeout'), true);
  assert.equal((await repo.claim(plan.parts[0])).fresh, false);
});
test('D3 posted evidence survives retries and stale failure cannot erase it', async () => {
  const step = source();
  const plan = await repo.create(step, splitItemFulfillmentPayload(step.payload));
  const claimed = await repo.claim(plan.parts[0]);
  await repo.complete(claimed, { id: 77, tranId: 'IF77', externalId: claimed.externalId });
  await repo.fail(claimed, new Error('late timeout'), true);
  const retained = (await repo.get(step)).parts[0];
  assert.equal(retained.status, 'posted'); assert.equal(retained.transactionId, 77);
  assert.equal((await repo.claim(retained)).fresh, false);
});
test('D4 definitively rejected parts can retry with a new fenced attempt', async () => {
  const step = source();
  const plan = await repo.create(step, splitItemFulfillmentPayload(step.payload));
  const first = await repo.claim(plan.parts[1]);
  await repo.fail(first, new Error('stock validation'), false);
  const second = await repo.claim(plan.parts[1]);
  assert.equal(second.fresh, true); assert.notEqual(first.attemptToken, second.attemptToken);
  await repo.fail(first, new Error('stale failure'), true);
  assert.equal((await repo.get(step)).parts[1].status, 'posting');
});
test('D5 plan and parts creation roll back atomically', async () => {
  const step = source();
  await withTransaction(async () => {
    await repo.create(step, splitItemFulfillmentPayload(step.payload));
    assert.equal((await repo.get(step)).parts.length, 2);
  }, { rollback: true });
  assert.equal(await repo.get(step), null);
});

test('D6 a forged partition or unsupported source cannot admit durable posting work', async () => {
  const step = source(), parts = splitItemFulfillmentPayload(step.payload);
  const changed = structuredClone(parts); changed[0].payload.item.items[0].quantity = 99;
  for (const [candidate, partition] of [[step, []], [step, changed], [{ ...step, sourceOrderKind: 'TO' }, parts]]) {
    await assert.rejects(repo.create(candidate, partition), /exactly partition/);
    assert.equal(await repo.get(step), null);
  }
});

test('D7 the database forbids posted status without a verified NetSuite identity', async () => {
  const step = source(), plan = await repo.create(step, splitItemFulfillmentPayload(step.payload));
  await assert.rejects(query("UPDATE netsuite_item_fulfillment_parts SET status='posted' WHERE id=$1", [plan.parts[0].id]), /check constraint/);
  assert.equal((await repo.get(step)).parts[0].status, 'pending');
});

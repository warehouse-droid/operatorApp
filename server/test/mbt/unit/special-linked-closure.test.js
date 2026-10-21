import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { prepareSpecialClosurePlan, applySpecialClosurePlan } from '../../../src/special-stock-closure-adapter.js';
import { linkedOrders, linkedClosureBoundary } from '../../support/special-linked-closure-fixture.js';

test('linked closure closes all current SO and PO lines despite changed request snapshots', async () => {
  const b = linkedClosureBoundary();
  const before = JSON.stringify([...b.remote].map(([id, lines]) => [id, lines.map(({ closed: _closed, ...line }) => line)]));
  const plan = await prepareSpecialClosurePlan({ orders: linkedOrders() }, b);
  assert.equal(b.writes.length, 0);
  assert.deepEqual((await applySpecialClosurePlan(plan, b)).verifiedOrderIds, [8877702, 8877701]);
  assert.deepEqual(b.writes, [8877702, 8877701].map(id => ({ id, body: { item: { items: [{ line: 7, isClosed: true }, { line: 9, isClosed: true }] } } })));
  assert.equal(JSON.stringify([...b.remote].map(([id, lines]) => [id, lines.map(({ closed: _closed, ...line }) => line)])), before);
});

test('linked closure accepts order identities without a local line snapshot', async () => {
  const b = linkedClosureBoundary();
  const plan = await prepareSpecialClosurePlan({ orders: linkedOrders().map(({ id, kind }) => ({ id, kind })) }, b);
  assert.deepEqual((await applySpecialClosurePlan(plan, b)).verifiedOrderIds, [8877702, 8877701]);
});

test('property: edited orders close by current IDs, preserve values and recover lost responses', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 50000 }), fc.boolean(), fc.boolean(), async (quantity, removeLine, soOnly) => {
    const b = linkedClosureBoundary(quantity);
    if (removeLine) for (const lines of b.remote.values()) lines.splice(1, 1);
    const orders = linkedOrders().slice(0, soOnly ? 1 : 2);
    const plan = await prepareSpecialClosurePlan({ orders }, b);
    b.loseResponse = true;
    await assert.rejects(applySpecialClosurePlan(plan, b), /Lost close response/);
    assert.deepEqual((await applySpecialClosurePlan(plan, b)).verifiedOrderIds, soOnly ? [8877701] : [8877702, 8877701]);
    assert.deepEqual(b.writes.map(write => write.id), soOnly ? [8877701] : [8877702, 8877701]);
    assert.ok(b.remote.get(8877701).every(line => line.closed));
    assert.equal(b.remote.get(8877702)[0].closed, !soOnly);
    for (const lines of b.remote.values()) assert.equal(lines[0].quantity, quantity);
    for (const write of b.writes) assert.deepEqual(write.body.item.items.map(line => line.line), removeLine ? [7] : [7, 9]);
  }), { seed: 20261015, numRuns: 50 });
});

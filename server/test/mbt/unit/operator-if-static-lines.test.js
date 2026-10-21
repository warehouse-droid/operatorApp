import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { createOperatorNetSuitePostingAdapter } from '../../../src/operator-netsuite-posting-netsuite-adapter.js';
import { fetchSalesOrderFulfillmentStateFromNetSuite } from '../../../src/netsuite.js';
import { normalizeOperatorKitSource, mapOperatorKitSelections } from '../../../src/operator-netsuite-posting-kits.js';
import { sobFixture, kitDraft } from '../../support/operator-kit-fixture.mjs';

function fixture() {
  const step = { sourceNetSuiteId: 1054765, sourceOrderKind: 'SO', transactionType: 'IF',
    externalId: 'MBBS-OP-static-lines-test-1',
    lineSnapshot: [{ orderLine: 1, sourceLineKey: '5117884', quantity: 7, location: 1 }],
    payload: { externalId: 'MBBS-OP-static-lines-test-1', memo: 'confirmed pickup', item: { metadata: 'keep', items: [
      { orderLine: 1, itemReceive: true, location: 1, quantity: 7,
        custcol_plt: 0, custcol_lyr: 0, custcol_sec: 0, custcol_pcs: 7 },
      { orderLine: 2, itemReceive: false, location: 28 }
    ] } } };
  const source = { id: 1054765, status: 'D', lines: [
    { orderLine: 1, sourceLineKey: '5117884', itemId: 1260, remainingQuantity: 7, location: 1, lineClosed: false },
    { orderLine: 2, sourceLineKey: '5117885', itemId: 8794, remainingQuantity: 0, location: 28, lineClosed: false }
  ] };
  return { step, source };
}

function harness(source, overrides = {}) {
  const calls = { reads: 0, posts: [] };
  const adapter = createOperatorNetSuitePostingAdapter({
    findTransactionByExternalId: async () => null,
    transformSalesOrderToItemFulfillment: async (id, payload) => {
      calls.posts.push({ id, payload: structuredClone(payload) });
      return { id: 157623 };
    },
    transformTransferOrderToItemFulfillment: async () => ({ id: 2 }),
    transformPurchaseOrderToItemReceipt: async () => ({ id: 3 }),
    transformTransferOrderToItemReceipt: async () => ({ id: 4 }),
    fetchItemFulfillment: async () => null, fetchItemReceipt: async () => null,
    fetchSalesOrderFulfillmentSource: async id => { calls.reads++; assert.equal(id, source.id); return source; },
    ...overrides
  });
  return { adapter, calls };
}

test('S1 recorded SOA10159 posts only the loaded 3445 line with exactly 7 PCS', async () => {
  const { step, source } = fixture();
  let received;
  const h = harness(source, { transformSalesOrderToItemFulfillment: async (id, payload) => {
    assert.equal(id, 1054765);
    if (payload.item.items.some(item => item.orderLine === 2)) {
      throw Object.assign(new Error('Invalid static sublist operation on completed line 2'), { status: 400 });
    }
    received = payload;
    return { id: 157623 };
  } });
  const original = structuredClone(step);
  assert.deepEqual(await h.adapter.transform(step), { id: 157623 });
  assert.deepEqual(received, { ...step.payload, item: { ...step.payload.item, items: [step.payload.item.items[0]] } });
  assert.equal(h.calls.reads, 1);
  assert.deepEqual(step, original, 'Durable step and pack evidence stay immutable');
});

test('S2 all open other-yard and repeated-item lines stay explicitly deselected', async () => {
  const { step, source } = fixture();
  source.lines[1].remainingQuantity = 3;
  source.lines[1].itemId = source.lines[0].itemId;
  const h = harness(source);
  await h.adapter.transform(step);
  assert.deepEqual(h.calls.posts[0].payload, step.payload);
  assert.equal(h.calls.reads, 1);
});

test('S2 closed or absent unselected rows are omitted without touching selected metadata', async () => {
  for (const state of ['closed', 'absent']) {
    const { step, source } = fixture();
    if (state === 'closed') { source.lines[1].remainingQuantity = 1; source.lines[1].lineClosed = true; }
    else { source.lines.pop(); }
    const h = harness(source);
    await h.adapter.transform(step);
    assert.deepEqual(h.calls.posts[0].payload.item.items, [step.payload.item.items[0]]);
    assert.equal(h.calls.posts[0].payload.item.metadata, 'keep');
  }
});

test('S3 a smaller live positive remainder never changes the confirmed quantity or pack counts', async () => {
  const { step, source } = fixture(); source.lines[0].remainingQuantity = 3;
  const h = harness(source);
  await h.adapter.transform(step);
  assert.deepEqual(h.calls.posts[0].payload.item.items, [step.payload.item.items[0]]);
  assert.equal(h.calls.posts[0].payload.item.items[0].quantity, 7);
});

test('S2 new current open lines are explicitly deselected; completed and nonfulfillable rows are omitted', async () => {
  const { step, source } = fixture();
  source.lines.push({ orderLine: 24, location: 15, remainingQuantity: 3, canFulfill: true },
    { orderLine: 31, location: 28, remainingQuantity: 2, canFulfill: false },
    { orderLine: 34, location: 28, remainingQuantity: 0, canFulfill: true });
  const h = harness(source); await h.adapter.transform(step);
  assert.deepEqual(h.calls.posts[0].payload.item.items, [step.payload.item.items[0],
    { orderLine: 24, location: 15, itemReceive: false }]);
  source.lines[0].canFulfill = false;
  await assert.rejects(h.adapter.transform(step), error => error.postingNotAttempted === true);
  assert.equal(h.calls.posts.length, 1);
});

const invalidSources = [
  ['missing selected line', source => { source.lines.shift(); }],
  ['completed selected line', source => { source.lines[0].remainingQuantity = 0; }],
  ['closed selected line', source => { source.lines[0].lineClosed = true; }],
  ['changed stable identity', source => { source.lines[0].sourceLineKey = 'different'; }],
  ['moved selected location', source => { source.lines[0].location = 28; }],
  ['duplicate live orderLine', source => { source.lines.push({ ...source.lines[0] }); }],
  ['non-finite remaining', source => { source.lines[0].remainingQuantity = NaN; }],
  ['missing remaining', source => { delete source.lines[0].remainingQuantity; }],
  ['wrong source order', source => { source.id = 9999; }]
];
for (const [name, change] of invalidSources) {
  test(`S4 ${name} stops before NetSuite POST`, async () => {
    const { step, source } = fixture(); change(source);
    const h = harness(source, { fetchSalesOrderFulfillmentSource: async () => source });
    await assert.rejects(h.adapter.transform(step), error =>
      error.code === 'OPERATOR_NETSUITE_POSTING_IF_SOURCE_CHANGED' && error.postingNotAttempted === true);
    assert.equal(h.calls.posts.length, 0);
  });
}

test('S4 malformed and complete source evidence stops before POST', async () => {
  for (const source of [null, {}, { id: 1054765, lines: null }, { id: 1054765, fulfillmentComplete: true, lines: [] }]) {
    const { step } = fixture();
    const h = harness(source, { fetchSalesOrderFulfillmentSource: async () => source });
    await assert.rejects(h.adapter.transform(step), error => error.postingNotAttempted === true);
    assert.equal(h.calls.posts.length, 0);
  }
});

test('S4 unavailable source is classified as not attempted', async () => {
  const { step, source } = fixture();
  const h = harness(source, { fetchSalesOrderFulfillmentSource: async () => { throw new Error('read unavailable'); } });
  await assert.rejects(h.adapter.transform(step), error => error.postingNotAttempted === true && /read unavailable/u.test(error.message));
  assert.equal(h.calls.posts.length, 0);
});

test('S5 default native readers fail before POST when NetSuite reads are disabled', async () => {
  assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED, 'false');
  for (const dispatch of [false, true]) {
    const { step, source } = fixture(); step.dispatchAutoFulfillment = dispatch;
    const h = harness(source, { fetchSalesOrderFulfillmentSource: undefined, fetchDispatchFulfillmentSource: undefined });
    await assert.rejects(h.adapter.transform(step), error =>
      error.code === 'OPERATOR_NETSUITE_POSTING_IF_SOURCE_UNAVAILABLE' && error.postingNotAttempted === true);
    assert.equal(h.calls.posts.length, 0);
  }
});

test('S5 dispatch reuses current source for deselections and retains its remaining quantity guard', async () => {
  const { step, source } = fixture(); step.dispatchAutoFulfillment = true; step.lineSnapshot[0].itemId = 1260;
  const h = harness(source, { fetchDispatchFulfillmentSource: async () => source,
    fetchSalesOrderFulfillmentSource: async () => assert.fail('Dispatch source must be reused') });
  await h.adapter.transform(step);
  assert.deepEqual(h.calls.posts[0].payload.item.items, [step.payload.item.items[0]]);
  source.lines[0].remainingQuantity = 3;
  await assert.rejects(h.adapter.transform(step), { code: 'SALES_ORDER_IF_SOURCE_CHANGED' });
  assert.equal(h.calls.posts.length, 1);
});

test('S4 changed item identity is refused when the durable snapshot contains it', async () => {
  const { step, source } = fixture(); step.lineSnapshot[0].itemId = 999;
  const h = harness(source);
  await assert.rejects(h.adapter.transform(step), error => error.postingNotAttempted === true);
  assert.equal(h.calls.posts.length, 0);
});

test('S5 each retry rechecks and a location part validates only its selected subset', async () => {
  const { step, source } = fixture();
  step.lineSnapshot.push({ orderLine: 2, sourceLineKey: '5117885', itemId: 8794, location: 28, quantity: 1 });
  const h = harness(source);
  await h.adapter.transform(step);
  source.lines[0].remainingQuantity = 0;
  await assert.rejects(h.adapter.transform(step), error => error.postingNotAttempted === true);
  assert.equal(h.calls.reads, 2); assert.equal(h.calls.posts.length, 1);
});

test('S5 current kit availability omits completed unselected parents and preserves kit validation', async () => {
  const f = sobFixture(); const source = normalizeOperatorKitSource(f.evidence);
  const step = kitDraft(source, mapOperatorKitSelections(source, f.selected)).steps[0];
  source.availableLines.push({ orderLine: 31, sourceLineKey: '9000001', itemId: 10126, location: 28, remainingQuantity: 0 });
  step.payload.item.items.push({ orderLine: 31, itemReceive: false, location: 28 });
  const h = harness({ id: step.sourceNetSuiteId }, { fetchKitSource: async () => source,
    fetchSalesOrderFulfillmentSource: async () => assert.fail('Kit evidence must be reused') });
  await h.adapter.transform(step);
  assert.deepEqual(h.calls.posts[0].payload.item.items, step.payload.item.items.filter(item => item.itemReceive));
  source.availableLines[0].location = 28;
  await assert.rejects(h.adapter.transform(step), { code: 'OPERATOR_NETSUITE_POSTING_KIT_INVALID' });
  assert.equal(h.calls.posts.length, 1);
});

test('S2 source reader includes open kit parents and visible non-inventory rows when requested', async () => {
  const rows = [
    { id: '991', status: 'D', rest_order_line: '1', order_line: '111', item_id: '42', item_type: 'InvtPart', quantity: '-7', fulfilled_quantity: '0', location_id: '1' },
    { id: '991', status: 'D', rest_order_line: '24', order_line: '222', item_id: '99', item_type: 'Kit', quantity: '-2', fulfilled_quantity: '-1', location_id: '28' },
    { id: '991', status: 'D', rest_order_line: '34', order_line: '333', item_id: '2055', item_type: 'NonInvtPart', is_fulfillable: 'T', quantity: '-3', fulfilled_quantity: '-3', location_id: '28' }
  ];
  const dependencies = { query: async () => ({ items: rows }), fetchItems: async () => rows.map(row => ({ line: Number(row.rest_order_line), item: { id: row.item_id } })) };
  const live = await fetchSalesOrderFulfillmentStateFromNetSuite(991, { ...dependencies, includeAllSourceLines: true });
  assert.deepEqual(live.lines.map(line => [line.orderLine, line.remainingQuantity]), [[1, 7], [24, 1], [34, 0]]);
  const unchanged = await fetchSalesOrderFulfillmentStateFromNetSuite(991, dependencies);
  assert.deepEqual(unchanged.lines.map(line => line.orderLine), [1, 34]);
});

test('property: selected values survive and all and only open unselected lines remain', async () => {
  await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.record({
    orderLine: fc.integer({ min: 1, max: 1000 }), location: fc.constantFrom(1, 15, 28, 26),
    remainingQuantity: fc.integer({ min: 0, max: 100 }), closed: fc.boolean(), present: fc.boolean()
  }), { minLength: 1, maxLength: 20, selector: line => line.orderLine }),
  fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 0, max: 1000 }), async (rows, quantity, layers) => {
    const source = { id: 99, lines: rows.filter(row => row.present).map(row => ({ ...row, lineClosed: row.closed })) };
    const first = rows[0]; first.present = true; first.closed = false; first.remainingQuantity = 1;
    source.lines = rows.filter(row => row.present).map(row => ({ ...row, sourceLineKey: String(row.orderLine), lineClosed: row.closed }));
    const selected = { orderLine: first.orderLine, location: first.location, quantity, itemReceive: true, custcol_lyr: layers, custcol_pcs: 0 };
    const step = { sourceOrderKind: 'SO', transactionType: 'IF', sourceNetSuiteId: 99,
      lineSnapshot: [{ ...selected, sourceLineKey: String(first.orderLine) }],
      payload: { externalId: 'MBBS-OP-property', item: { items: [selected,
        ...rows.slice(1).map(row => ({ orderLine: row.orderLine, location: row.location, itemReceive: false }))] } } };
    const original = structuredClone(step);
    const h = harness(source); await h.adapter.transform(step);
    const expected = [selected, ...step.payload.item.items.slice(1).filter(item => {
      const row = rows.find(line => line.orderLine === item.orderLine);
      return row.present && !row.closed && row.remainingQuantity > 0;
    })];
    assert.deepEqual(h.calls.posts[0].payload.item.items, expected);
    assert.deepEqual(step, original); assert.equal(h.calls.reads, 1);
  }), { seed: 101592, numRuns: 150 });
});

test('property: stale selected identity and location always refuse a financial mutation', async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom('closed', 'completed', 'identity', 'location', 'missing'), async fault => {
    const { step, source } = fixture();
    const changes = Object.fromEntries(invalidSources.map(([name, change]) => [name, change]));
    changes[{ closed: 'closed selected line', completed: 'completed selected line', identity: 'changed stable identity',
      location: 'moved selected location', missing: 'missing selected line' }[fault]](source);
    const h = harness(source);
    await assert.rejects(h.adapter.transform(step), error => error.postingNotAttempted === true);
    assert.equal(h.calls.posts.length, 0);
  }), { seed: 101594, numRuns: 75 });
});

test('property: all visible REST parents retain current progress regardless of item type', async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom('InvtPart', 'Kit', 'NonInvtPart'),
    fc.integer({ min: 1, max: 500 }), fc.integer({ min: 0, max: 500 }), async (itemType, quantity, fulfilled) => {
      const live = await fetchSalesOrderFulfillmentStateFromNetSuite(99, { includeAllSourceLines: true,
        query: async () => ({ items: [{ id: '99', status: 'D', rest_order_line: '31', order_line: '5123000',
          item_id: '42', item_type: itemType, quantity: -quantity, fulfilled_quantity: -fulfilled, location_id: '28' }] }),
        fetchItems: async () => [{ line: 31, item: { id: '42' } }] });
      assert.equal(live.lines.length, 1);
      assert.equal(live.lines[0].orderLine, 31);
      assert.equal(live.lines[0].remainingQuantity, Math.max(0, quantity - fulfilled));
    }), { seed: 101596, numRuns: 75 });
});

test('property: new open fulfillable lines are always deselected and cannot enter the IF by default', async () => {
  await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.record({
    orderLine: fc.integer({ min: 3, max: 1000 }), location: fc.constantFrom(1, 15, 28),
    remainingQuantity: fc.integer({ min: 0, max: 100 }), lineClosed: fc.boolean(), canFulfill: fc.boolean()
  }), { minLength: 1, maxLength: 20, selector: line => line.orderLine }), async rows => {
    const { step, source } = fixture(); source.lines.push(...rows);
    const h = harness(source); await h.adapter.transform(step);
    const expected = [step.payload.item.items[0], ...rows.filter(row =>
      row.canFulfill && !row.lineClosed && row.remainingQuantity > 0).map(row =>
      ({ orderLine: row.orderLine, location: row.location, itemReceive: false }))];
    assert.deepEqual(h.calls.posts[0].payload.item.items, expected);
  }), { seed: 101598, numRuns: 100 });
});

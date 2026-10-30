import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { fetchSalesOrderFulfillmentStateFromNetSuite } from '../../../src/netsuite.js';
import { prepareSalesOrderFulfillmentPayload } from '../../../src/operator-netsuite-posting-fulfillment-lines.js';
import { createOperatorNetSuitePostingAdapter } from '../../../src/operator-netsuite-posting-netsuite-adapter.js';

function fixture({ sql = {}, rest = {} } = {}) {
  const row = { id: '1080114', tranid: 'SOB123167', status: 'B', order_line: '5171033',
    rest_order_line: '1', item_id: '2278', item_type: 'InvtPart', is_fulfillable: 'T',
    quantity: '-204.6', fulfilled_quantity: '0', location_id: '1', line_closed: 'F',
    unit_id: '854', unit_conversion_rate: '1', unit: 'SQFT', ...sql };
  const item = { line: 1, item: { id: '2278' }, units: '854', quantity: 204.6, ...rest };
  const calls = [];
  const read = () => fetchSalesOrderFulfillmentStateFromNetSuite(1080114, {
    includeAllSourceLines: true,
    query: async text => { calls.push({ kind: 'query', text }); return { items: [row] }; },
    fetchItems: async (kind, id) => { calls.push({ kind, id }); return [item]; }
  });
  const step = { sourceOrderKind: 'SO', transactionType: 'IF', sourceNetSuiteId: 1080114,
    payload: { externalId: 'regression-existing-request', item: { items: [
      { orderLine: 1, quantity: 204.6, itemReceive: true, location: 1 }
    ] } }, lineSnapshot: [{ orderLine: 1, itemId: 2278, sourceLineKey: '5171033',
      quantity: 204.6, salesUom: 'SQFT', quantityCheckDeferred: true }] };
  return { read, calls, step };
}

test('SOB123167 numeric REST unit retains authoritative SQFT and passes the real deferred guard', async () => {
  const f = fixture(), source = await f.read();
  assert.equal(source.lines[0].unit, 'SQFT');
  assert.equal(source.lines[0].remainingQuantity, 204.6);
  assert.deepEqual(prepareSalesOrderFulfillmentPayload(f.step, source), f.step.payload);
  assert.equal(f.calls.length, 2, 'Only the existing SuiteQL and source-item reads are used');
  assert.match(f.calls[0].text, /BUILTIN\.DF\(tl\.units\)\s+AS\s+unit\b/iu);
});

test('SO unit reference without refName retains label and native quantity conversion', async () => {
  const f = fixture({ sql: { unit_conversion_rate: '2', quantity: '-409.2' }, rest: { units: { id: '854' } } });
  const source = await f.read();
  assert.equal(source.lines[0].unit, 'SQFT');
  assert.equal(source.lines[0].remainingQuantity, 204.6);
  assert.doesNotThrow(() => prepareSalesOrderFulfillmentPayload(f.step, source));
});

test('conflicting SO unit labels stop before any posting', async () => {
  await assert.rejects(fixture({ rest: { unitsDisplay: 'EACH' } }).read(),
    error => error.code === 'SALES_ORDER_IF_UNIT_MAPPING_UNRESOLVED');
});

test('conflicting SO unit IDs stop even when both display labels say SQFT', async () => {
  await assert.rejects(fixture({ rest: { units: { id: '855', refName: 'SQFT' } } }).read(),
    error => error.code === 'SALES_ORDER_IF_UNIT_MAPPING_UNRESOLVED');
});

test('missing labels and genuinely different units still fail the deferred guard', async () => {
  for (const unit of [undefined, '', 'EACH']) {
    const f = fixture({ sql: { unit } }), source = await f.read();
    assert.throws(() => prepareSalesOrderFulfillmentPayload(f.step, source),
      error => error.postingNotAttempted === true && /unit evidence/u.test(error.message));
  }
});

test('existing REST label evidence remains valid when the query provides no label', async () => {
  const f = fixture({ sql: { unit: undefined }, rest: { units: { id: '854', refName: ' sqft ' } } });
  const source = await f.read();
  assert.equal(source.lines[0].unit, 'SQFT');
  assert.doesNotThrow(() => prepareSalesOrderFulfillmentPayload(f.step, source));
});

test('real SO reader feeds corrected native fallback after quantity gate is disabled', async () => {
  const f = fixture(), posted = [];
  f.step.payload.item.items[0].quantity = 204.6000001;
  const adapter = createOperatorNetSuitePostingAdapter({
    fetchSalesOrderFulfillmentSource: f.read,
    postIfirRestlet: async () => null,
    transformSalesOrderToItemFulfillment: async (_id, payload) => { posted.push(payload); return {}; }
  });
  await adapter.transform(f.step);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].item.items[0].quantity, 204.6);
  assert.equal(f.step.payload.item.items[0].quantity, 204.6000001);
  assert.equal(f.calls.length, 2);
});

test('property: matching authoritative unit IDs preserve labels through raw REST shapes', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 100000 }), fc.boolean(),
    fc.integer({ min: 1, max: 100 }), async (id, object, factor) => {
      const f = fixture({ sql: { unit_id: String(id), unit_conversion_rate: factor,
        quantity: -100 * factor, unit: ' sqft ' }, rest: { units: object ? { id: String(id) } : String(id) } });
      const source = await f.read();
      assert.equal(source.lines[0].unit, 'SQFT');
      assert.equal(source.lines[0].remainingQuantity, 100);
      assert.equal(f.calls.length, 2);
    }), { numRuns: 100, seed: 1080114 });
});

test('property: conflicting unit identities or labels never become posting evidence', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 100000 }), fc.boolean(),
    async (id, wrongId) => {
      const f = fixture({ sql: { unit_id: String(id) }, rest: {
        units: { id: String(wrongId ? id + 1 : id), refName: wrongId ? 'SQFT' : 'EACH' }
      } });
      await assert.rejects(f.read(), error => error.code === 'SALES_ORDER_IF_UNIT_MAPPING_UNRESOLVED');
    }), { numRuns: 100, seed: 5171033 });
});

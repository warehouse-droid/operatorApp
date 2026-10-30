import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { pathToFileURL } from 'node:url';

const root = process.env.SO_PACK_SOURCE_ROOT || '/app';
const ns = await import(pathToFileURL(`${root}/src/netsuite.js`));
const fields = ['custcol_plt', 'custcol_sec', 'custcol_lyr', 'custcol_pcs'];
const payload = values => ({ externalId: 'MBBS-SPECIAL-SO:9', entity: { id: '10' }, memo: 'Reviewed SO',
  discountItem: { id: '10716' }, discountRate: -12, item: { replaceAll: true, items: [
    { item: { id: '2055' }, quantity: 24, rate: 10, units: '865', price: { id: '-1' },
      ...Object.fromEntries(fields.map((field, i) => [field, values[i]])) },
    { item: { id: '1784' }, quantity: 2, rate: 40, price: { id: '-1' } }
  ] } });
const paths = [
  ['direct', (p, deps) => ns.createSalesOrderInNetSuite(p, deps), '/record/v1/salesOrder'],
  ['estimate', (p, deps) => ns.transformEstimateToSalesOrderInNetSuite(7, p, deps), '/record/v1/estimate/7/!transform/salesOrder?replace=item'],
  ['discount', (p, deps) => ns.createSpecialDiscountSalesOrderInNetSuite(p, deps), '/record/v1/salesOrder'],
  ['discount estimate', (p, deps) => ns.createSpecialDiscountSalesOrderInNetSuite(p, { ...deps, estimateId: 7 }), '/record/v1/estimate/7/!transform/salesOrder?replace=item']
];

for (const [name, create, path] of paths) {
  test(`${name}: zero pack fields serialize as null while all other SO data is preserved`, async () => {
    const input = payload([0, '0.00', 4, '-0']), before = structuredClone(input), writes = [];
    let queued = 0;
    const result = await create(input, { mutate: run => { queued++; return run(); }, rest: async (url, options) => {
      writes.push({ url, ...options }); return { id: 99 };
    } });
    const expected = structuredClone(input);
    Object.assign(expected.item.items[0], { custcol_plt: null, custcol_sec: null, custcol_lyr: 4, custcol_pcs: null });
    Object.assign(expected.item.items[1], Object.fromEntries(fields.map(field => [field, null])));
    assert.deepEqual(writes, [{ url: path, method: 'POST', body: expected }]);
    assert.equal(queued, 1);
    assert.equal(result.id, 99);
    assert.deepEqual(input, before);
  });
}

test('property: mixed blank and fractional pack counts remain independent and preserve every other field', async () => {
  const blanks = [null, undefined, '', ' \t ', 0, -0, '0', '0.00', '-0'];
  await fc.assert(fc.asyncProperty(fc.tuple(...fields.map(() => fc.oneof(
    fc.constantFrom(...blanks), fc.integer({ min: 1, max: 1000000000 }).map(n => n / 1000),
    fc.integer({ min: 1, max: 1000000 }).map(n => String(n / 10))
  ))), async values => {
    const input = payload(values), before = structuredClone(input);
    const expected = structuredClone(input);
    fields.forEach((field, i) => { expected.item.items[0][field] = Number(values[i]) > 0 ? Number(values[i]) : null; });
    fields.forEach(field => { expected.item.items[1][field] = null; });
    await ns.createSpecialDiscountSalesOrderInNetSuite(input, {
      mutate: run => run(), rest: async (_url, options) => {
        assert.deepEqual(JSON.parse(JSON.stringify(options.body)), expected); return { id: 99 };
      }
    });
    assert.deepEqual(input, before);
  }), { seed: 20261026, numRuns: 250 });
});

test('invalid pack values fail before queueing or posting, across all creation paths', async () => {
  for (const [, create] of paths) for (const value of [-1, true, false, [], {}, [1], 'bad', NaN, Infinity, -Infinity, 1000000001]) {
    for (const field of fields) {
      const input = payload([1, 2, 3, 4]); input.item.items[0][field] = value;
      let attempted = false;
      await assert.rejects(() => create(input, { mutate: () => { attempted = true; }, rest: () => { attempted = true; } }),
        { code: 'SPECIAL_PACK_QUANTITY_INVALID' });
      assert.equal(attempted, false);
    }
  }
});

test('missing item collection and repeated normalization preserve the transport contract', async () => {
  for (const input of [null, { memo: 'No items' }, { item: { items: [] } }, payload([1e-6, '2.5', 1e9, null])]) {
    const writes = [], deps = { mutate: run => run(), rest: async (_url, options) => { writes.push(options.body); return { id: 99 }; } };
    await ns.createSalesOrderInNetSuite(input, deps);
    await ns.createSalesOrderInNetSuite(writes[0], deps);
    assert.deepEqual(writes[0], writes[1]);
    if (Array.isArray(input?.item?.items) && input.item.items.length) {
      assert.deepEqual(fields.map(f => writes[0].item.items[0][f]), [1e-6, 2.5, 1e9, null]);
    } else assert.deepEqual(writes[0], input);
  }
});

test('named pack values normalize independently with the same rule as NetSuite columns', async () => {
  const { normalizePackQuantities } = await import(pathToFileURL(`${root}/public/order-pack-quantities.js`));
  const input = { palletQty: '1.5', sectionQty: '0', layerQty: '', pieceQty: 2, quantity: 100, rate: 8 };
  const before = structuredClone(input);
  const result = normalizePackQuantities(input);
  assert.deepEqual(result, { palletQty: 1.5, sectionQty: null, layerQty: null, pieceQty: 2 });
  assert.deepEqual(normalizePackQuantities(result), result);
  assert.deepEqual(input, before);
});

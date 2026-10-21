/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { assertSplitLineQuantities } from '../../../src/dispatch-split-quantity-domain.js';

const code = { code: 'DISPATCH_SPLIT_QUANTITY_MISMATCH', status: 409 };
const source = () => ({ id: 'SOA09140', items: [
  { lineId: 4997388, itemId: 2055, sku: 'MBBS-Special Order', unit: 'SQFT', quantity: 8432 }
] });
const parts = (values, parent = source()) => values.map((quantity, index) => ({
  id: `${parent.id}-S${index + 1}`, items: [{ ...parent.items[0], quantity }]
}));

test('SOA09140 shortage reports the source, expected quantity and missing 4216 SQFT', () => {
  assert.throws(() => assertSplitLineQuantities(source(), parts([1860, 2356])), error => {
    assert.equal(error.code, code.code);
    assert.equal(error.status, 409);
    assert.match(error.message, /SOA09140/u);
    assert.match(error.message.replaceAll(',', ''), /8432.*4216|4216.*8432/u);
    assert.match(error.message, /SQFT/u);
    return true;
  });
});

test('balanced source quantities and decimal rounding are accepted without mutation', () => {
  const parent = source(), children = parts([1860, 6572]);
  const before = structuredClone({ parent, children });
  assertSplitLineQuantities(parent, children);
  assert.deepEqual({ parent, children }, before);
  parent.items[0].quantity = 0.3;
  assertSplitLineQuantities(parent, parts([0.1, 0.2], parent));
});

test('transfer lines without a NetSuite line key use their stable local line row identity', () => {
  const parent = source();
  parent.id = 'TO-ROW-IDENTITY';
  parent.items[0].lineId = null;
  parent.items[0].lineRowId = 75;
  const children = parts([1860, 6572], parent);
  assertSplitLineQuantities(parent, children);
  children[0].items[0].lineRowId = 76;
  assert.throws(() => assertSplitLineQuantities(parent, children), code);
});

for (const [name, change] of [
  ['excess', children => { children[1].items[0].quantity += 1; }],
  ['negative', children => { children[0].items[0].quantity = -1; }],
  ['infinite', children => { children[0].items[0].quantity = Infinity; }],
  ['NaN', children => { children[0].items[0].quantity = NaN; }],
  ['missing quantity', children => { delete children[0].items[0].quantity; }],
  ['unknown source line', children => { children[0].items[0].lineId = 999; }],
  ['missing source line', children => { delete children[0].items[0].lineId; }],
  ['duplicate line within child', children => { children[0].items.push({ ...children[0].items[0] }); }],
  ['wrong item', children => { children[0].items[0].itemId = 1784; }],
  ['wrong unit', children => { children[0].items[0].unit = 'EACH'; }],
  ['empty child', children => { children[0].items = []; }],
  ['duplicate child', children => { children[1].id = children[0].id; }]
]) test(`reject ${name}`, () => {
  const children = parts([1860, 6572]); change(children);
  assert.throws(() => assertSplitLineQuantities(source(), children), code);
});

test('same SKU on different source lines cannot offset shortages and excesses', () => {
  const parent = source();
  parent.items.push({ ...parent.items[0], lineId: 4997389, quantity: 100 });
  const children = parts([1860, 6571], parent);
  children[0].items.push({ ...parent.items[1], quantity: 101 });
  assert.throws(() => assertSplitLineQuantities(parent, children), code);
  children[1].items[0].quantity = 6572;
  children[0].items[1].quantity = 100;
  assertSplitLineQuantities(parent, children);
});

test('omitted source lines, duplicate source identities and unsafe totals fail closed', () => {
  const parent = source();
  parent.items.push({ ...parent.items[0], lineId: 22, quantity: 3 });
  assert.throws(() => assertSplitLineQuantities(parent, parts([1860, 6572])), code);
  parent.items[1].lineId = 4997388;
  assert.throws(() => assertSplitLineQuantities(parent, parts([1860, 6572])), code);
  parent.items = [{ ...parent.items[0], quantity: Infinity }];
  assert.throws(() => assertSplitLineQuantities(parent, parts([1860, 6572])), code);
});

test('mixed packing units use authoritative conversion rates', () => {
  const parent = source();
  parent.items[0] = { ...parent.items[0], quantity: 121, toPlt: 50, toLyr: 10, toPcs: 1 };
  const children = parts([61, 60], parent);
  Object.assign(children[0].items[0], { pallets: 1, layers: 1, pieces: 1 });
  Object.assign(children[1].items[0], { pallets: 1, layers: 1 });
  assertSplitLineQuantities(parent, children);
  children[0].items[0].pallets = 2;
  children[0].items[0].toPlt = 25;
  assert.throws(() => assertSplitLineQuantities(parent, children), code);
});

test('missing sources, too few children, zero children and unsafe numeric input fail closed', () => {
  assert.throws(() => assertSplitLineQuantities({ id: 'MISSING', items: [] }, parts([1, 1])), code);
  assert.throws(() => assertSplitLineQuantities(source(), parts([8432])), code);
  assert.throws(() => assertSplitLineQuantities(source(), parts([0, 8432])), code);
  for (const invalid of [null, '', -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => assertSplitLineQuantities(source(), parts([invalid, 8432])), code);
  }
});

test('property: balanced partitions always pass; either sign of a one-cent difference fails', () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 1000000 }), { minLength: 2, maxLength: 10 }),
    values => {
      const parent = source();
      parent.items[0].quantity = values.reduce((sum, value) => sum + value, 0) / 100;
      const children = parts(values.map(value => value / 100), parent);
      assertSplitLineQuantities(parent, children);
      for (const delta of [-0.01, 0.01]) {
        const changed = structuredClone(children);
        changed[0].items[0].quantity += delta;
        assert.throws(() => assertSplitLineQuantities(parent, changed), code);
      }
    }), { seed: 20261020, numRuns: 150 });
});

/* global structuredClone */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import fc from 'fast-check';

const script = fs.readFileSync(new URL('../../../public/dispatch.js', import.meta.url), 'utf8');
function extract(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return script.slice(start, script.indexOf('\n}\n', start) + 3);
}
function fixture(items) {
  const order = { id: 'SOA09140-S4', type: 'SO', originalOrderId: 'SOA09140',
    salesQty: items.reduce((sum, item) => sum + item.quantity, 0), items };
  const context = vm.createContext({ order, splitParts: 2, splitDraft: { items: {} },
    qtyText: value => String(value) });
  const names = ['splitItemKey', 'conversionNumber', 'splitQuantityValue', 'splitNumberAcrossParts',
    'splitUnitDefinitions', 'splitPartTemplate', 'normalizeSplitPartValue', 'splitPartSalesQuantity',
    'splitPartLabel', 'specialOrderPalletItemQuantity', 'ensureSplitDraft', 'splitTotalsForPart',
    'splitQuantityValidationMessage'];
  vm.runInContext(names.map(extract).join('\n'), context);
  vm.runInContext('ensureSplitDraft(order, true)', context);
  return context;
}
const item = (lineId, quantity, lineRowId = 470031) => ({
  lineId, lineRowId, itemId: 2055, sku: 'MBBS-Special Order', unit: 'SQFT', quantity
});
function assign(context, index, quantities) {
  const key = vm.runInContext(`splitItemKey(order.items[${index}], ${index})`, context);
  context.splitDraft.items[key] = quantities.map(quantity => ({ quantity }));
}
const validate = context => vm.runInContext('splitQuantityValidationMessage(order)', context);
const total = (context, index) => vm.runInContext(`splitTotalsForPart(order, ${index})`, context);

for (const field of ['lineId', 'line_id']) {
  test(`2232 / 2356 draft survives a changed row ID using ${field}`, () => {
    const line = { ...item(4997388, 4588), [field]: 4997388 };
    if (field === 'line_id') delete line.lineId;
    const context = fixture([line]);
    assign(context, 0, [2232, 2356]);
    context.order.items[0].lineRowId = -133471750519201;
    assert.equal(validate(context), '');
    assert.deepEqual([total(context, 0).salesQty, total(context, 1).salesQty], [2232, 2356]);
  });
}

test('same-SKU lines retain independent quantities after row changes and reorder', () => {
  const context = fixture([item(101, 4588, 11), item(102, 40, 12)]);
  assign(context, 0, [2232, 2356]);
  assign(context, 1, [10, 30]);
  context.order.items = context.order.items.map((line, index) => ({ ...line, lineRowId: -100 - index })).reverse();
  assert.equal(validate(context), '');
  assert.deepEqual(Array.from(total(context, 0).items, line => [line.lineId, line.quantity]), [[102, 10], [101, 2232]]);
  assert.deepEqual(Array.from(total(context, 1).items, line => [line.lineId, line.quantity]), [[102, 30], [101, 2356]]);
  assign(context, 0, [10, 31]);
  assign(context, 1, [2232, 2355]);
  assert.match(validate(context), /1 SQFT over/u);
});

test('local lines without transaction IDs keep distinct row fallbacks', () => {
  const context = fixture([item(null, 10, 71), item(null, 20, 72)]);
  assign(context, 0, [4, 6]);
  assign(context, 1, [9, 11]);
  assert.equal(validate(context), '');
  assert.deepEqual(Array.from(total(context, 0).items, line => line.quantity), [4, 9]);
});

test('property: refreshed identities conserve each line and reject deficit, excess or invalid parts', () => {
  fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 1000000 }), { minLength: 2, maxLength: 2 }),
    fc.integer({ min: 1, max: 100000 }), fc.integer({ min: 1, max: 100000 }), (ids, a, b) => {
      const context = fixture([item(ids[0], (a + b) / 100, 9000001), item(ids[1], 10, 9000002)]);
      assign(context, 0, [a / 100, b / 100]);
      assign(context, 1, [3, 7]);
      context.order.items = structuredClone(context.order.items).map((line, index) => ({ ...line, lineRowId: -index - 1 }));
      assert.equal(validate(context), '');
      assert.equal(total(context, 0).items[0].quantity, a / 100);
      assert.equal(total(context, 1).items[0].quantity, b / 100);
      for (const value of [b / 100 - 0.01, b / 100 + 0.01, -1, NaN, undefined]) {
        assign(context, 0, [a / 100, value]);
        assert.notEqual(validate(context), '');
      }
    }), { seed: 20261020, numRuns: 50 });
});

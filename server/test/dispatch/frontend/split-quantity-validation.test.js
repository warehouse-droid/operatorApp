/* global structuredClone */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import fc from 'fast-check';

const script = fs.readFileSync(new URL('../../../public/dispatch.js', import.meta.url), 'utf8');
function extract(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing function ${name}`);
  const end = script.indexOf('\n}\n', start) + 3;
  return script.slice(start, end);
}
function fixture(total = 8432, values = [1860, 2356]) {
  const order = { id: 'SOA09140', type: 'SO', salesQty: total, pallets: 136, notes: '',
    items: [{ lineId: 4997388, itemId: 2055, sku: 'MBBS-Special Order', unit: 'SQFT', quantity: total }] };
  const context = vm.createContext({ orders: [structuredClone(order)], splitParts: 2,
    splitDraft: { orderId: order.id, parts: 2, items: {} }, selectedOrderId: order.id,
    selectedOrderIds: new Set([order.id]), activeOrderType: 'SO', routeNotice: '',
    qtyText: value => Number(value).toLocaleString('en-US', { maximumFractionDigits: 6 }) });
  const names = ['splitItemKey', 'conversionNumber', 'splitQuantityValue', 'splitNumberAcrossParts',
    'splitUnitDefinitions', 'splitPartTemplate', 'normalizeSplitPartValue', 'splitPartSalesQuantity',
    'splitPartLabel', 'specialOrderPalletItemQuantity', 'ensureSplitDraft', 'splitTotalsForPart', 'splitOrder'];
  if (script.includes('function splitQuantityValidationMessage(')) names.push('splitQuantityValidationMessage');
  vm.runInContext(names.map(extract).join('\n') +
    '\nfunction orderById(id) {return orders.find(order => order.id === id);}', context);
  context.order = context.orders[0];
  vm.runInContext('ensureSplitDraft(order, true)', context);
  const key = Object.keys(context.splitDraft.items)[0];
  context.splitDraft.items[key] = values.map(quantity => ({ quantity }));
  return context;
}

test('browser splitting 8432 into 1860 and 2356 keeps the source untouched', () => {
  const context = fixture();
  const before = JSON.stringify(context.orders);
  vm.runInContext("splitOrder('SOA09140',2,1)", context);
  assert.equal(JSON.stringify(context.orders), before);
  assert.match(context.routeNotice.replaceAll(',', ''), /4216/u);
});

test('browser rejects excess and allows an exactly balanced split', () => {
  const invalid = fixture(8432, [1860, 6573]);
  vm.runInContext("splitOrder('SOA09140',2,1)", invalid);
  assert.equal(invalid.orders.length, 1);
  const valid = fixture(8432, [1860, 6572]);
  vm.runInContext("splitOrder('SOA09140',2,1)", valid);
  assert.equal(valid.orders.length, 2);
  assert.deepEqual(Array.from(valid.orders, order => order.salesQty), [1860, 6572]);
});

test('property: client split preserves balanced decimals and refuses any deficit or excess', () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 100000 }), fc.integer({ min: 1, max: 100000 }),
    (a, b) => {
      for (const delta of [-0.01, 0, 0.01]) {
        const context = fixture((a + b) / 100, [a / 100, b / 100 + delta]);
        vm.runInContext("splitOrder('SOA09140',2,1)", context);
        assert.equal(context.orders.length, delta === 0 ? 2 : 1);
      }
    }), { seed: 20261020, numRuns: 40 });
});

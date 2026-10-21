import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import fc from 'fast-check';

const source = readFileSync(new URL('../../../public/operator.js', import.meta.url), 'utf8');
const start = source.indexOf('function isCustomerPickupMode');
const end = source.indexOf('function receivingRemainingSalesQty', start);
const ui = vm.createContext({ currentModule: 'customer-pickup', viewMode: 'active', selectedOrder: {},
  qty: value => Number(value) || 0, displayUnit: String });
vm.runInContext(source.slice(start, end), ui);

const line = (overrides = {}) => ({ quantity: 343, unit: 'PC', pallet_qty: 4, piece_qty: 55,
  to_plt: 72, to_pcs: 1, loaded_qty: 127, packed_pallet_qty: 0, packed_piece_qty: 0, ...overrides });

test('SOB122401: one pallet and 55 pieces collected leaves three pallets and zero loose pieces', () => {
  const remaining = line();
  assert.equal(ui.remainingValue(remaining, 'pallets'), 3);
  assert.equal(ui.remainingValue(remaining, 'pieces'), 0);
  assert.equal(ui.panelValue(remaining, 'pieces'), 0);
  assert.equal(ui.panelLimit(remaining, 'pieces'), 0);
  assert.equal(ui.lineRequiredSalesQty(remaining) - remaining.loaded_qty, 216);
});

test('confirmed loose pieces must not reappear while the pallets remain unconfirmed', () => {
  const draft = line({ loaded_qty: 0, packed_piece_qty: 55 });
  assert.equal(ui.remainingValue(draft, 'pallets'), 4);
  assert.equal(ui.remainingValue(draft, 'pieces'), 0);
  assert.equal(ui.panelValue(draft, 'pieces'), 55);
  assert.equal(ui.remainingValue(line({ packed_pallet_qty: 3 }), 'pallets'), 0);
  assert.equal(ui.remainingValue(line({ packed_pallet_qty: 3 }), 'pieces'), 0);
});

test('exhausted layers and sections are not regenerated from the remaining pallets', () => {
  for (const [field, conversion, unit] of [['layer_qty', 'to_lyr', 'layers'], ['section_qty', 'to_sec', 'sections']]) {
    const remaining = line({ quantity: 425, pallet_qty: 4, to_plt: 100, piece_qty: 0,
      [field]: 5, [conversion]: 5, loaded_qty: 125 });
    assert.equal(ui.remainingValue(remaining, 'pallets'), 3);
    assert.equal(ui.remainingValue(remaining, unit), 0);
  }
});

test('explicit mixed quantities conserve stock across generated partial pickups', () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 60 }), fc.integer({ min: 2, max: 100 }),
    fc.integer({ min: 1, max: 100 }), (pallets, perPallet, seed) => {
      const pieces = 1 + seed % (perPallet - 1);
      const loadedPallets = 1 + seed % (pallets - 1);
      const remaining = line({ quantity: pallets * perPallet + pieces, pallet_qty: pallets,
        piece_qty: pieces, to_plt: perPallet, loaded_qty: loadedPallets * perPallet + pieces });
      const physical = ui.remainingValue(remaining, 'pallets') * perPallet + ui.remainingValue(remaining, 'pieces');
      assert.equal(physical, remaining.quantity - remaining.loaded_qty);
      assert.equal(ui.remainingValue(remaining, 'pieces'), 0);
    }), { seed: 122401, numRuns: 250 });
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import fc from 'fast-check';
import { operatorLoadedUnitCount, operatorRoundedSalesQuantity } from '../../../src/operator-load-quantity.js';

const source = readFileSync(new URL('../../../public/operator.js', import.meta.url), 'utf8');
const start = source.indexOf('function isCustomerPickupMode');
const end = source.indexOf('function receivingRemainingSalesQty', start);
const ui = vm.createContext({ currentModule: 'customer-pickup', viewMode: 'active', selectedOrder: {},
  qty: value => Number(value) || 0, displayUnit: String });
vm.runInContext(source.slice(start, end), ui);
const rounded = value => Math.round(value * 100) / 100;
const kensington = (values = {}) => ({ quantity: 779.75, unit: 'SQFT', pallet_qty: 8, layer_qty: 5,
  to_plt: 91.14, to_lyr: 10.1267, loaded_qty: 779.75, ...values });

test('SOA10636: exact NetSuite rounded totals consume every required pallet and layer', () => {
  for (const line of [kensington(), kensington({ quantity: 111.39, loaded_qty: 111.39, pallet_qty: 1, layer_qty: 2 })]) {
    assert.equal(ui.loadedValue(line, 'layers'), line.layer_qty);
    assert.equal(ui.remainingValue(line, 'pallets'), 0);
    assert.equal(ui.remainingValue(line, 'layers'), 0);
    assert.equal(ui.panelLimit(line, 'layers'), 0);
    assert.equal(ui.hasRemainingQty(line), false);
  }
});

test('round the complete mixed line once, keeping conversion factors precise', () => {
  const line = kensington({ to_plt: 1.004, to_lyr: 0.004, to_sec: 2.004, to_pcs: 0.004 });
  assert.equal(ui.lineUnitsToSalesQty(line, { pallets: 1, layers: 1, sections: 1, pieces: 1 }), 3.02);
  assert.equal(ui.lineUnitsToSalesQty(kensington(), { pallets: 8, layers: 5 }), 779.75);
});

test('partial rounded and historical unrounded pickups preserve remaining units', () => {
  for (const loaded of [415.19, 415.1935]) {
    const line = kensington({ loaded_qty: loaded });
    assert.equal(ui.loadedValue(line, 'layers'), 5);
    assert.equal(ui.remainingValue(line, 'pallets'), 4);
    assert.equal(ui.remainingValue(line, 'layers'), 0);
  }
  const short = kensington({ loaded_qty: 769.63 });
  assert.equal(ui.remainingValue(short, 'layers'), 1);
  assert.equal(ui.hasRemainingQty(short), true);
});

test('a different rounded total cannot gain a layer through posting or packing tolerance', () => {
  for (const loaded of [779.74, 779.73, 779.65, 779.744]) {
    const line = kensington({ loaded_qty: loaded });
    assert.equal(ui.remainingValue(line, 'layers'), 0, 'a sub-layer sales remainder cannot offer a full extra layer');
    assert.equal(ui.hasRemainingQty(line), true, 'the outstanding sales balance stays open');
    assert.equal(ui.panelLimit(line, 'layers'), 0);
    assert.equal(operatorLoadedUnitCount(loaded, 8 * 91.14, 5, 10.1267, 'SQFT'), 4);
  }
  for (const unit of ['EACH', 'PC', 'TON']) {
    assert.equal(ui.remainingValue(kensington({ unit }), 'layers'), 0);
    assert.equal(operatorLoadedUnitCount(779.75, 8 * 91.14, 5, 10.1267, unit), 4);
    assert.equal(ui.lineUnitsToSalesQty(kensington({ unit }), { pallets: 8, layers: 5 }), 779.7535);
  }
  assert.equal(ui.loadedValue(kensington({ loaded_qty: 0 }), 'layers'), 0);
});

test('property: rounded cumulative mixed totals recover whole layers without hiding one missing layer', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 30 }), fc.integer({ min: 1, max: 8 }),
    fc.integer({ min: 10000, max: 300000 }), (pallets, layers, ticks) => {
      const toLayer = ticks / 10000, toPallet = rounded(toLayer * 12);
      const total = rounded(pallets * toPallet + layers * toLayer);
      const line = kensington({ pallet_qty: pallets, layer_qty: layers, to_plt: toPallet,
        to_lyr: toLayer, quantity: total, loaded_qty: total });
      assert.equal(ui.remainingValue(line, 'layers'), 0);
      assert.equal(ui.remainingValue(line, 'pallets'), 0);
      assert.equal(operatorLoadedUnitCount(total, pallets * toPallet, layers, toLayer, 'SQFT'), layers);
      const partial = rounded(pallets * toPallet + (layers - 1) * toLayer);
      assert.equal(ui.remainingValue({ ...line, loaded_qty: partial }, 'layers'), 1);
      assert.equal(operatorLoadedUnitCount(partial, pallets * toPallet, layers, toLayer, 'SQFT'), layers - 1);
      assert.equal(operatorLoadedUnitCount(rounded(total - 0.01), pallets * toPallet, layers, toLayer, 'SQFT'), layers - 1);
      const exactLoaded = pallets * toPallet + layers * toLayer;
      if (exactLoaded > total) {
        assert.equal(operatorLoadedUnitCount(total, pallets * toPallet, layers, toLayer, 'EACH'), layers - 1);
      }
    }), { seed: 10636, numRuns: 400 });
});

test('invalid, absent and ambiguous sub-cent conversions do not invent whole units', () => {
  for (const values of [[NaN, 0, 5, 1], [1, Infinity, 5, 1], [1, 0, NaN, 1], [1, 0, 5, Infinity],
    [0, 0, 5, 1], [-1, 0, 5, 1], [1, 0, 0, 1], [1, 0, 5, 0], [1, 0, 5, -1]]) {
    assert.equal(operatorLoadedUnitCount(...values, 'SQFT'), 0);
    assert.equal(ui.operatorLoadedUnitCount(...values, 'SQFT'), 0);
  }
  assert.equal(operatorLoadedUnitCount(0.001, 0, 1, 0.004, 'SQFT'), 0);
  assert.equal(operatorLoadedUnitCount(1, 2, 5, 1, 'SQFT'), 0);
  assert.equal(operatorRoundedSalesQuantity(1.234, ' sqft '), 1.23);
  assert.equal(operatorRoundedSalesQuantity(1.234, undefined), 1.234);
  assert.equal(operatorRoundedSalesQuantity(1.005, 'SQFT'), Math.round(1.005 * 100) / 100);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import fc from 'fast-check';
import { operatorPackUnitCapacity } from '../../../src/operator-load-quantity.js';
import { reloadPackedQuantities } from '../../../src/sales-order-reload.js';

const source = readFileSync(new URL('../../../public/operator.js', import.meta.url), 'utf8');
function screen(module = 'customer-pickup', mode = 'active') {
  const ui = vm.createContext({ currentModule: module, viewMode: mode, selectedOrder: {},
    qty: value => Number(value) || 0, displayUnit: String, displayQty: String, escapeHtml: String,
    t: (_key, fallback) => fallback, orderLocksCurrentOperator: () => true });
  vm.runInContext(source.slice(source.indexOf('function isCustomerPickupMode'),
    source.indexOf('function receivingRemainingSalesQty')), ui);
  vm.runInContext(source.slice(source.indexOf('function renderConvertedPackBalance'),
    source.indexOf('function renderLinkedSupplyBreakdown')), ui);
  return ui;
}
const item = values => ({ quantity: 25, unit: 'PC', pallet_qty: 1, piece_qty: 5,
  to_plt: 20, to_pcs: 1, loaded_qty: 0, ...values });

test('pickup and Delivery Prep share a 25 PCS balance and keep the ordered packing as defaults', () => {
  for (const module of ['customer-pickup', 'delivery']) {
    const ui = screen(module), line = item();
    assert.equal(ui.panelValue(line, 'pallets'), 1);
    assert.equal(ui.panelValue(line, 'pieces'), 5);
    assert.equal(ui.panelLimit(line, 'pieces', { pallets: 0 }), 25);
    assert.equal(ui.panelLimit(line, 'pieces', { pallets: 1 }), 5);
    assert.equal(ui.panelLimit(line, 'pallets', { pieces: 10 }), 0);
    assert.equal(ui.requiredValue(line, 'pieces'), 5, 'original order stays visible');
    assert.equal(ui.remainingValue(item({ packed_piece_qty: 10 }), 'pallets'), 0);
    assert.equal(ui.remainingValue(item({ packed_piece_qty: 10 }), 'pieces'), 15);
    assert.equal(ui.panelValue(item({ loaded_qty: 10 }), 'pallets'), 0);
    assert.equal(ui.panelValue(item({ loaded_qty: 10 }), 'pieces'), 15);
    assert.equal(ui.loadedValue(item({ loaded_qty: 10 }), 'pieces'), 10);
    assert.equal(ui.hasRemainingQty(item({ loaded_qty: 25 })), false);
  }
});

test('editing saved packing uses live companion fields without counting the draft twice', () => {
  for (const [module, mode] of [['customer-pickup', 'active'], ['delivery', 'active'], ['delivery', 'packed']]) {
    const ui = screen(module, mode), line = item({ loaded_qty: 10, packed_piece_qty: 5 });
    assert.equal(ui.panelLimit(line, 'pieces', { pallets: 0 }), 15);
    assert.equal(ui.panelValue(line, 'pieces'), 5);
    assert.equal(ui.remainingValue(line, 'pieces'), 10);
  }
});

test('all configured units can be exchanged, including units absent from the original packing', () => {
  const ui = screen(), line = item({ to_lyr: 5, to_sec: 10 });
  assert.deepEqual(Array.from(ui.deliveryLineUnits(line), unit => unit.key), ['pallets', 'layers', 'sections', 'pieces']);
  assert.equal(ui.panelLimit(line, 'layers', { pallets: 0, pieces: 0, sections: 0 }), 5);
  assert.equal(ui.panelLimit(line, 'sections', { pallets: 0, pieces: 5, layers: 0 }), 2);
  assert.equal(ui.panelLimit(line, 'pieces', { pallets: 0, layers: 1, sections: 1 }), 10);
  const palletOnly = item({ quantity: 20, piece_qty: 0 });
  assert.equal(ui.panelValue(palletOnly, 'pieces'), 0);
  assert.equal(ui.panelLimit(palletOnly, 'pieces', { pallets: 0 }), 20);
  assert.equal(ui.panelValue({ ...palletOnly, loaded_qty: 10 }, 'pieces'), 10);
});

test('sales-only items keep their existing quantity model', () => {
  const ui = screen(), line = item({ to_plt: 0, to_pcs: 0, packed_sales_qty: 10 });
  assert.equal(ui.panelValue(line, 'sales'), 10);
  assert.equal(ui.remainingValue(line, 'sales'), 15);
  assert.equal(ui.panelLimit(line, 'sales'), 25);
});

test('piece totals use the item conversion when the sales unit is SQFT', () => {
  const ui = screen(), line = item({ unit: 'SQFT', quantity: 62.5, to_plt: 50, to_pcs: 2.5,
    loaded_qty: 25, packed_piece_qty: 10 });
  assert.equal(ui.panelLimit(line, 'pieces', { pallets: 0 }), 15);
  assert.equal(ui.remainingValue(line, 'pieces'), 5);
  const html = ui.renderConvertedPackBalance(line);
  for (const [key, value] of Object.entries({ total: 25, loaded: 10, confirmed: 10, remaining: 5 })) {
    assert.match(html, new RegExp(`data-pack-balance="${key}"><span>[^<]+ PCS</span><b>${value}</b>`));
  }
});

test('generated partial pickups conserve the shared quantity in defaults and input limits', () => {
  const ui = screen();
  fc.assert(fc.property(fc.integer({ min: 2, max: 100 }), fc.integer({ min: 1, max: 30 }),
    fc.nat(1000), fc.nat(1000), (conversion, pallets, seed, packedSeed) => {
      const total = pallets * conversion + seed % conversion;
      const loaded = seed % (total + 1), packed = packedSeed % (total - loaded + 1);
      const line = item({ quantity: total, pallet_qty: pallets, piece_qty: total % conversion,
        to_plt: conversion, loaded_qty: loaded, packed_piece_qty: packed });
      assert.equal(ui.remainingValue(line, 'pallets') * conversion + ui.remainingValue(line, 'pieces'), total - loaded - packed);
      assert.equal(ui.panelLimit(line, 'pieces', { pallets: 0 }), total - loaded);
      assert.equal(ui.panelLimit(line, 'pallets', { pieces: packed }), Math.floor((total - loaded - packed) / conversion));
    }), { seed: 20261023, numRuns: 300 });
});

test('shared capacity rounds only the full SQFT total and matches browser arithmetic', () => {
  const ui = screen();
  for (const args of [[25, 10, 1, 'PC'], [111.39, 91.14, 10.1267, 'SQFT'],
    [779.75, 779.75, 10.1267, 'SQFT'], [25, 0, 0, 'PC'], [25, NaN, 1, 'PC']]) {
    assert.equal(ui.operatorPackUnitCapacity(...args), operatorPackUnitCapacity(...args));
  }
  assert.equal(operatorPackUnitCapacity(111.39, 91.14, 10.1267, 'SQFT'), 2);
  assert.equal(operatorPackUnitCapacity(111.38, 91.14, 10.1267, 'SQFT'), 1);
});

test('Delivery Prep re-loads also exchange pallets for pieces within the remaining authorized total', () => {
  const target = { targetSalesQty: 25, targetPalletQty: 1, targetPieceQty: 5, toPlt: 20, toPcs: 1 };
  const first = reloadPackedQuantities(target, {}, { pieces: 10 }, { absolute: true });
  assert.equal(first.packedPieceQty, 10);
  const second = reloadPackedQuantities(target, { reloadedSalesQty: 10, reloadedPieceQty: 10 },
    { pieces: 20 }, { absolute: true });
  assert.equal(second.packedPieceQty, 15);
  assert.equal(second.packedTotalSalesQty, 15);
  const mixed = reloadPackedQuantities(target, {}, { pallets: 1, pieces: 10 }, { absolute: true });
  assert.equal(mixed.packedPieceQty, 5);
  assert.equal(mixed.packedTotalSalesQty, 25);
});

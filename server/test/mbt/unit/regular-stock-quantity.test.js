import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {normalizeStockRequestQuantity} from '../../../src/stock-request-domain.js';

const context = {window: {}};
vm.runInNewContext(readFileSync(new URL('../../../public/regular-stock-quantity.js', import.meta.url), 'utf8'), context);
const {fromSales, toSales} = context.window.RegularStockQuantity;
const item = {salesUom: 'SQFT', toPlt: 120, toLyr: 12, toSec: 4, toPcs: 1};

test('sales quantities choose the nearest whole PLT/LYR combination, carry pallets and round ties up', () => {
  for (const [input, pallets, layers, salesQty] of [
    [2000, 16, 7, 2004], [1993, 16, 6, 1992], [2034, 17, 0, 2040],
    [2040, 17, 0, 2040], [0, 0, 0, 0], [2, 0, 1, 12]
  ]) {
    const packs = fromSales(item, input);
    assert.deepEqual({...packs}, {pallets, layers, sections: 0, pieces: 0});
    assert.equal(toSales(item, packs), salesQty);
    if (salesQty > 0) {
      assert.equal(normalizeStockRequestQuantity(packs, item).salesQty, salesQty);
    }
  }
});

test('forward conversion includes SEC/PCS and preserves supported fractional pack inputs', () => {
  assert.equal(toSales(item, {pallets: '1.5', layers: '2', sections: '.5', pieces: '3'}), 209);
  assert.equal(toSales(item, {pallets: '', layers: '', sections: '', pieces: ''}), null);
  assert.equal(toSales(item, {pallets: '0'}), 0);
  assert.equal(toSales(item, {layers: '1.5'}), null);
  assert.equal(toSales(item, {pieces: '-1'}), null);
});

test('decimal rates round cleanly and non-integral ratios compare with the next full pallet', () => {
  const decimal = {toPlt: 120.96, toLyr: 15.12};
  const packs = fromSales(decimal, 2000);
  assert.deepEqual({...packs}, {pallets: 16, layers: 4, sections: 0, pieces: 0});
  assert.equal(toSales(decimal, packs), 1995.84);
  assert.equal(toSales({toPlt: .1, toLyr: .01}, fromSales({toPlt: .1, toLyr: .01}, .3)), .3);
  assert.deepEqual({...fromSales({toPlt: 100, toLyr: 30}, 195)}, {pallets: 2, layers: 0, sections: 0, pieces: 0});
});

test('missing unit combinations use only the available conversion units', () => {
  assert.deepEqual({...fromSales({toPlt: 120}, 2000)}, {pallets: 17, layers: 0, sections: 0, pieces: 0});
  assert.deepEqual({...fromSales({toLyr: 12}, 2000)}, {pallets: 0, layers: 167, sections: 0, pieces: 0});
  assert.deepEqual({...fromSales({toPlt: 100, toSec: 10, toPcs: 2}, 117)}, {pallets: 1, layers: 0, sections: 1, pieces: 4});
  assert.deepEqual({...fromSales({toPcs: 2}, 5)}, {pallets: 0, layers: 0, sections: 0, pieces: 3});
  assert.equal(fromSales({}, 2000), null);
  for (const input of ['', null, undefined, -1, NaN, Infinity, 'invalid']) {
    assert.equal(fromSales(item, input), null);
  }
  assert.equal(fromSales({toPlt: Infinity, toLyr: -1, toPcs: 0}, 20), null);
});

test('a range of decimal sales inputs stays within half a layer and round-trips exactly', () => {
  const decimal = {toPlt: 120.96, toLyr: 15.12};
  for (let quantity = 8; quantity < 5000; quantity += 7.13) {
    const packs = fromSales(decimal, quantity), actual = toSales(decimal, packs);
    assert.ok(Math.abs(actual - quantity) <= 7.56 + 1e-8);
    assert.ok(Number.isInteger(packs.pallets) && Number.isInteger(packs.layers));
    assert.ok(packs.layers >= 0 && packs.layers < 8);
    assert.equal(toSales(decimal, fromSales(decimal, actual)), actual);
  }
});

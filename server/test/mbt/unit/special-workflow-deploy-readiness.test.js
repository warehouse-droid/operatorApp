import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSpecialUnits } from '../../../src/special-stock-netsuite-adapter.js';

test('configured item units resolve exactly without requiring the separate Units-list permission', async () => {
  let restCalls = 0;
  const rows = [
    {id: 2055, unitstype: 353, stock_unit_id: 700, stock_unit: 'PC', sales_unit_id: 700, sales_unit: 'PC'},
    {id: 1784, unitstype: 107, stock_unit_id: 800, stock_unit: 'EACH', sales_unit_id: 800, sales_unit: 'EACH'}
  ];
  const lines = await resolveSpecialUnits([{itemId: 2055, uom: 'PC', quantity: 1200}, {itemId: 1784, uom: 'EACH', quantity: 3}], {
    queryAll: async sql => [rows.find(row => sql.includes(`id = ${row.id} `))],
    rest: async () => { restCalls += 1; throw Object.assign(new Error('Lists -> Units permission required'), {status: 403}); }
  });
  assert.deepEqual(lines.map(line => [line.itemId, line.unitId, line.quantity]), [[2055, 700, 1200], [1784, 800, 3]]);
  assert.equal(restCalls, 0);
});

test('ambiguous configured unit labels never select an arbitrary native unit ID', async () => {
  await assert.rejects(() => resolveSpecialUnits([{itemId: 2055, uom: 'PC', quantity: 10}], {
    queryAll: async () => [{unitstype: 353, stock_unit_id: 700, stock_unit: 'PC', sales_unit_id: 701, sales_unit: 'PC'}],
    rest: async () => ({data: {uom: {items: [{internalId: 702, abbreviation: 'PC'}]}}})
  }), error => error.code === 'SPECIAL_UOM_INVALID');
});

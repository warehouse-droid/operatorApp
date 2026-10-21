// These acceptance tests intentionally stay red while the audited defects exist.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readRegularSalesOrder } from '/app/src/regular-stock-netsuite-adapter.js';
import { aggregateLine, supply, loadNetSuiteReaders, loadReturnReaders } from './reader-fixture.mjs';

const readers = loadNetSuiteReaders();
const ns = await readers.module;
const returns = await loadReturnReaders(readers.url);

test('regular-stock SO linking uses 4 Yard rather than 5.2 base units', async () => {
  const order = await readRegularSalesOrder('SOB121756', {
    queryAll: async () => [{ ...aggregateLine, order_location_id: 1, customer_id: 1,
      rest_line_id: 1, stock_unit: 'Yard', backordered_quantity: 0,
      fulfilled_quantity: 0, billed_quantity: 0, line_closed: 'F' }],
    rest: async () => ({ data: { location: { id: '1' }, entity: { id: '1' },
      item: { items: [{ line: 1, lineUniqueKey: 5054171, item: { id: '9912' },
        location: { id: '1' }, quantity: 4, rate: 45 }] } } }),
    resolveYards: async () => [{ netsuiteLocationId: 1, localLocationId: 1 }]
  });
  assert.equal(order.lines[0].quantity, 4);
});

function returnRows() {
  supply([{ ...aggregateLine, sales_quantity: 5.2, fulfilled_quantity: 1.3,
    sales_uom: 'Yard', sales_uom_id: 884, foreign_amount: 180 }]);
}

test('return lookup displays sales quantity in Yard', async () => {
  returnRows();
  const order = await returns.fetchReturnSalesOrderFromNetSuite('SOB121756', { includeRestLineMapping: false });
  assert.equal(order.lines[0].salesQuantity, 4);
});

test('return lookup quotes the native sales price of 45 per Yard', async () => {
  returnRows();
  const order = await returns.fetchReturnSalesOrderFromNetSuite('SOB121756', { includeRestLineMapping: false });
  assert.equal(order.lines[0].rate, 45);
});

test('Smart SCM demand uses stock Yard quantity rather than base Ton quantity', async () => {
  supply([{ ...aggregateLine, quantity: 5.2 }]);
  const rows = await ns.fetchSmartScmSalesHistoryFromNetSuite({ itemIds: [9912], startDate: '2026-09-30', endDate: '2026-09-30' });
  assert.equal(rows[0].quantity, 4);
});

test('SO line weight in pounds converts the configured 1300 kg per Yard', async () => {
  supply([aggregateLine]);
  const line = (await ns.fetchDeliveryOrderDetailsFromNetSuite(1028209))[0];
  assert.ok(Math.abs(Number(line.item_weight) - 1300 / 0.45359237) < 1e-6,
    `Expected ${1300 / 0.45359237} lb/Yard, received ${line.item_weight}`);
});

test('PO line weight uses the Ton basis as well as converting kg to pounds', async () => {
  supply([{ ...aggregateLine, quantity: 4, unit: 'Ton', unit_conversion_rate: 1 }]);
  const line = (await ns.fetchPurchaseOrderDetailsFromNetSuite(1028209))[0];
  assert.ok(Math.abs(Number(line.item_weight) - 1000 / 0.45359237) < 1e-6,
    `Expected ${1000 / 0.45359237} lb/Ton, received ${line.item_weight}`);
});

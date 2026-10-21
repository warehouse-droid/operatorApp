import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateLine, supply, loadNetSuiteReaders } from './reader-fixture.mjs';
import { AGGREGATE_MATERIALS, normalizeAggregateLoads, transitionAggregateRequest }
  from '/app/src/aggregate-request-domain.js';

const { normalizeNetSuiteTransactionUnits: normalize } = await import(
  process.env.AUDIT_UNITS_SOURCE || '/app/src/netsuite-transaction-units.js');
const ns = await loadNetSuiteReaders().module;

test('limestone and HPB: 5.2 base units are 4 Yard, with native price 45', () => {
  const result = normalize(aggregateLine);
  assert.equal(result.quantity, -4);
  assert.equal(result.rate, 45);
  assert.equal(result.quantity * result.rate, -180);
  assert.equal(result.netsuite_received_qty, 1);
  assert.equal(result.netsuite_committed_qty, 3);
});

test('Screening and Crusher Run use their own 1.35 factor', () => {
  const result = normalize({ unit_id: 880, unit_conversion_rate: 1.35, quantity: -6.75 });
  assert.equal(result.quantity, -5);
});

test('Ton quantities with factor 1 and native webhook values remain unchanged', () => {
  const ton = { unit_id: 883, unit_conversion_rate: 1, quantity: 12.5, unit: 'Ton' };
  const webhook = { quantity: 4, unit: 'Yard', quantityCommitted: 4 };
  assert.deepEqual(normalize(ton), ton);
  assert.deepEqual(normalize(webhook), webhook);
});

test('an identified unit with no valid conversion fails before persistence', () => {
  for (const factor of [null, undefined, 0, -1, 'invalid', Infinity]) {
    assert.throws(() => normalize({ ...aggregateLine, unit_conversion_rate: factor }),
      { code: 'NETSUITE_TRANSACTION_UOM_UNRESOLVED' });
  }
});

test('1,000 deterministic quantity and price round trips preserve signs and amounts', () => {
  let seed = 20261008;
  for (let index = 0; index < 1000; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const quantity = ((seed % 100000) + 1) / 100 * (index % 2 ? -1 : 1);
    const factor = [1, 1.3, 1.35, 0.5, 12][index % 5];
    const result = normalize({ unit_id: index + 1, unit_conversion_rate: factor, quantity, rate: 25 });
    assert.ok(Math.abs(result.quantity * factor - quantity) < 1e-7);
    assert.ok(Math.abs(result.quantity * result.rate - quantity * 25) < 1e-6);
    assert.equal(Math.sign(result.quantity), Math.sign(quantity));
  }
});

test('single and batch SO detail readers both return 4 Yard', async () => {
  supply([aggregateLine]);
  const single = await ns.fetchDeliveryOrderDetailsFromNetSuite(1028209);
  assert.equal(single[0].quantity, 4);
  const batch = await ns.fetchDeliveryOrderDetailsBatchFromNetSuite([1028209]);
  assert.equal(batch.get(1028209)[0].quantity, 4);
  assert.ok(globalThis.__aggregateAuditQueries.every(sql => sql.includes('unit_conversion_rate')));
});

test('progress reader returns 4 ordered and 1 fulfilled Yard', async () => {
  supply([aggregateLine]);
  const order = await ns.fetchTransactionProgressFromNetSuite(1028209, 'SalesOrd');
  assert.equal(order.lines[0].quantity, 4);
  assert.equal(order.lines[0].netsuite_received_qty, 1);
});

test('PO reader preserves Ton quantities and converts a Yard transaction independently', async () => {
  supply([{ ...aggregateLine, quantity: 5.2, unit: 'Ton', unit_conversion_rate: 1 }]);
  assert.equal((await ns.fetchPurchaseOrderDetailsFromNetSuite(1028209))[0].quantity, 5.2);
  supply([{ ...aggregateLine, quantity: 5.2 }]);
  assert.equal((await ns.fetchPurchaseOrderDetailsFromNetSuite(1028209))[0].quantity, 4);
});

test('fulfillment planning uses native ordered, fulfilled and remaining quantities', async () => {
  const result = await ns.fetchSalesOrderFulfillmentStateFromNetSuite(1028209, {
    query: async () => ({ items: [{ ...aggregateLine, order_line: 5054171, rest_order_line: 1,
      fulfilled_quantity: 1.3, is_fulfillable: 'T' }] }),
    fetchItems: async () => [{ line: 1, item: { id: 9912 } }]
  });
  assert.equal(result.lines[0].quantity, 4);
  assert.equal(result.lines[0].fulfilledQuantity, 1);
  assert.equal(result.lines[0].remainingQuantity, 3);
});

test('aggregate requests count whole loads without applying a Yard or Ton factor', () => {
  const loads = Object.fromEntries(AGGREGATE_MATERIALS.map(material => [material.code, 0]));
  loads.hpb = 2;
  assert.deepEqual(normalizeAggregateLoads(loads, { positive: true }), loads);
  for (const invalid of [-1, 1.3, NaN, Infinity, '2']) {
    assert.throws(() => normalizeAggregateLoads({ ...loads, hpb: invalid }), { status: 400 });
  }
});

test('aggregate load reporting preserves requested and confirmed counts and flags shortages', () => {
  const request = { id: 1, yardLocationId: 1, requestedBy: 'audit', serviceDate: '2026-10-08',
    reportDueDate: '2026-10-09', revision: 1, status: 'confirmed', remarks: '', needsReview: false,
    lines: AGGREGATE_MATERIALS.map(material => ({ materialCode: material.code,
      requestedLoads: material.code === 'hpb' ? 3 : 0,
      confirmedLoads: material.code === 'hpb' ? 2 : 0, actualLoads: null })) };
  const loads = Object.fromEntries(AGGREGATE_MATERIALS.map(material => [material.code, 0]));
  loads.hpb = 1;
  const result = transitionAggregateRequest(request, 'report', { expectedRevision: 1, loads },
    { id: 'audit', role: 'scm' }, new Date('2026-10-08T12:00:00Z'));
  const line = result.lines.find(candidate => candidate.materialCode === 'hpb');
  assert.deepEqual(line, { materialCode: 'hpb', requestedLoads: 3, confirmedLoads: 2, actualLoads: 1 });
  assert.equal(result.needsReview, true);
  assert.equal(request.lines.find(candidate => candidate.materialCode === 'hpb').actualLoads, null);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { isAggregateMaterial, aggregateNightlySchedule } from '../../../src/aggregate-reconciliation.js';
import { appliedSalesOrderBilledSql } from '../../../src/applied-sales-order-billing.js';

test('A2 catalog aggregate materials include bulk and bagged stock without substring false positives', () => {
  for (const name of ['Aggregate-Screening', '150-Aggregate-HPB', 'Aggregate-3/4 Clear Limestone', 'Aggregate-Concrete Sand', 'Aggregate-HL6', 'Brick Sand', 'River Rock', 'Bag Sand 25KG', 'Small Bag Gravel', 'Bulk Bag Crush Run']) {
    assert.equal(isAggregateMaterial(name), true, name);
  }
  for (const name of ['', 'ROOFING-Gravel Stop', 'Alliance Supersand Grey', 'Paving Black Limestone', 'BULK BAGS-PALLET', 'Sakrete Sand Mix 30KG', 'Aggregate-Delivery Charge']) {
    assert.equal(isAggregateMaterial(name), false, name);
  }
});

const settings = { aggregateNightlyEnabled: true, aggregateNightlyTime: '21:30', soInitialDryRunApprovedAt: '2026-10-22' };
test('S1/S2 Toronto schedule waits, catches up once, and moves to tomorrow after any attempt', () => {
  const now = new Date('2026-10-23T02:00:00Z');
  assert.equal(aggregateNightlySchedule(settings, null, now).reason, 'due');
  assert.equal(aggregateNightlySchedule({ ...settings, aggregateNightlyEnabled: false }, null, now).reason, 'disabled');
  assert.equal(aggregateNightlySchedule({ ...settings, soInitialDryRunApprovedAt: null }, null, now).reason, 'initial_so_not_approved');
  assert.deepEqual(aggregateNightlySchedule(settings, null, new Date('2026-10-23T01:00:00Z')).nextRun,
    { localDate: '2026-10-22', localTime: '21:30', timeZone: 'America/Toronto' });
  for (const status of ['succeeded', 'failed', 'interrupted', 'running']) {
    const result = aggregateNightlySchedule(settings, { scheduledLocalDate: '2026-10-22', status }, now);
    assert.equal(result.reason, 'already_attempted');
    assert.equal(result.nextRun.localDate, '2026-10-23');
  }
});

test('property: Toronto dates and once-per-date behavior survive both DST offsets and leap dates', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 730 }), fc.constantFrom('failed', 'interrupted', 'succeeded'), (days, status) => {
    const now = new Date(Date.UTC(2026, 0, 1 + days, 23));
    const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const current = { ...settings, aggregateNightlyTime: '00:01' };
    assert.equal(aggregateNightlySchedule(current, null, now).reason, 'due');
    const result = aggregateNightlySchedule(current, { scheduledLocalDate: localDate, status }, now);
    assert.equal(result.reason, 'already_attempted');
    assert.ok(result.nextRun.localDate > localDate);
  }), { seed: 20261022, numRuns: 120 });
});

test('property: material recognition ignores harmless spacing/case and rejects unrelated suffixes', () => {
  fc.assert(fc.property(fc.constantFrom('HPB', 'Screening', 'Crusher Run', 'Concrete Stone'), fc.integer({ min: 1, max: 9999 }), (material, yard) => {
    assert.equal(isAggregateMaterial(` ${yard}-Aggregate-${material.toUpperCase()} `), true);
    assert.equal(isAggregateMaterial(`Paving ${material}`), false);
    assert.equal(isAggregateMaterial(`Aggregate-${material} Delivery Charge`), false);
  }), { seed: 20261022, numRuns: 100 });
});

test('S1 schedule defaults stay disabled, and a clock rollback cannot repeat a future recorded date', () => {
  assert.equal(aggregateNightlySchedule({}, null).reason, 'disabled');
  const result = aggregateNightlySchedule({ aggregateNightlyEnabled: true, soInitialDryRunApprovedAt: 'approved' },
    { scheduledLocalDate: '2026-10-24' }, new Date('2026-10-23T02:00:00Z'));
  assert.equal(result.reason, 'already_attempted');
  assert.deepEqual(result.nextRun, { localDate: '2026-10-25', localTime: '21:30', timeZone: 'America/Toronto' });
});

test('O1 internal SQL aliases reject injection and accept normal repository aliases', () => {
  for (const alias of ['', 'orders; DROP TABLE sales_orders', 'o.status', '1order']) {
    assert.throws(() => appliedSalesOrderBilledSql(alias), TypeError);
  }
  assert.match(appliedSalesOrderBilledSql('sales_order'), /sales_order\.netsuite_id/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import fc from 'fast-check';
import { buildReturnBatchPayload, verifyReturnBatchSnapshot } from '../../../src/return-batch-ra-domain.js';

const intent = { transactionType: 'credit_memo', externalId: 'MBBS-RECONCILIATION-TEST', customerId: 30,
  receivingLocationId: 26, sourceSalesOrderId: 40, netSuiteTransactionId: 901,
  lines: [{ kind: 'stock', sourceSalesOrderLineId: 401, itemId: 60, returnedSalesQuantity: 7,
    rate: 19.98, reasonId: 10, salesUomId: 3 }] };
const snapshot = () => ({ ...buildReturnBatchPayload(intent), id: '901', tranId: 'CM901', status: { refName: 'Fully Applied' } });
const adjustments = () => [
  { item: { id: '-2' }, itemType: { id: 'Subtotal' }, amount: 139.86 },
  { item: { id: '3015' }, itemType: { id: 'Discount' }, rate: -35, amount: -48.95 }
];
const reconcile = value => verifyReturnBatchSnapshot(intent, value, { allowAccountingAdjustments: true });

test('S1 startup does not schedule the stale PO/TO refresh', () => {
  const source = readFileSync(new URL('../../../src/server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /set(?:Timeout|Interval)\([^\n]*scmScheduleStatusRefreshTick/);
  assert.match(source, /setInterval\(\(\) => void scmReconciliationScheduledTick\(\), 60000\)/);
});

test('R3 scheduled return reads defer until the active SCM reconciliation finishes', async () => {
  const source = readFileSync(new URL('../../../src/server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function returnReconciliationTick()');
  const end = source.indexOf('\nasync function returnCustomerDirectorySyncTick()', start);
  let active = true; let calls = 0;
  const context = vm.createContext({ returnReconciliationTickRunning: false,
    hasActiveScmReconciliationRun: async () => active,
    reconcileReturnRecords: async () => { calls++; }, console });
  vm.runInContext(source.slice(start, end), context);
  await context.returnReconciliationTick();
  assert.equal(calls, 0);
  active = false;
  await context.returnReconciliationTick();
  assert.equal(calls, 1);
});

test('C1 reconcile preserves material verification and accepts NetSuite subtotal/restocking rows', () => {
  const value = snapshot(); value.item.items.push(...adjustments());
  assert.equal(reconcile(value), value);
});

test('C2 new posting rejects accounting additions and reconciliation rejects changed material or unsafe additions', () => {
  const value = snapshot(); value.item.items.push(...adjustments());
  assert.throws(() => verifyReturnBatchSnapshot(intent, value), { code: 'RETURN_CM_VERIFICATION_FAILED' });
  for (const mutate of [
    s => { s.item.items[0].quantity++; }, s => { s.item.items[0].rate++; },
    s => { s.item.items[0].units = '7'; }, s => { s.item.items[0].description = 'wrong source'; },
    s => { s.item.items[0].custcol_atlas_rc_so.id = '7'; }, s => { s.entity.id = '31'; },
    s => { s.item.items[2].quantity = 1; }, s => { s.item.items[2].amount = 5; },
    s => { s.item.items[2].item.id = '60'; }, s => { s.item.items[2].itemType.id = 'Service'; },
    s => { s.item.items[1].item.id = '60'; }, s => { s.item.items[2].rate = null; },
    s => { s.item.items[2].amount = null; }, s => { s.item.items[2].rate = 10; }
  ]) {
    const bad = structuredClone(value); mutate(bad);
    assert.throws(() => reconcile(bad), { code: 'RETURN_CM_VERIFICATION_FAILED' });
  }
});

test('C1/C2 generated restocking adjustments never weaken material conservation', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 100 }), fc.boolean(), (percent, reverse) => {
    const value = snapshot();
    const extra = adjustments(); extra[1].rate = -percent; extra[1].amount = -139.86 * percent / 100;
    value.item.items.push(...extra);
    if (reverse) { value.item.items.reverse(); }
    assert.equal(reconcile(value), value);
    value.item.items.find(row => row.item.id === '60').quantity += 0.01;
    assert.throws(() => reconcile(value), { code: 'RETURN_CM_VERIFICATION_FAILED' });
  }), { seed: 20261022, numRuns: 100 });
});

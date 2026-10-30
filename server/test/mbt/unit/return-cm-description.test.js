import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { buildReturnBatchIntent, buildReturnBatchPayload, verifyReturnBatchSnapshot } from '../../../src/return-batch-ra-domain.js';
import { buildAdjustedReturnCreditMemoIntent, verifyReturnCreditMemoAdjustment } from '../../../src/return-credit-memo-adjustment.js';

const original = () => ({ version: 4, transactionType: 'credit_memo', batchId: 54, batchReference: 'RB-000040',
  recordIds: [65], externalId: 'MBBS-RB-000040', customerId: 30, receivingLocationId: 1,
  sourceSalesOrderId: 40, sourceSalesOrderRef: 'SOB40', submittedDate: '2026-10-28', memo: 'operator | RB-000040',
  restockingFee: { itemId: 3015, percent: 35 }, lines: [{ kind: 'stock', sourceSalesOrderLineId: 401,
    itemId: 60, netSuiteOrderLine: 1, returnedSalesQuantity: 11.66, rate: 0, reasonId: 10, salesUomId: 3, locationId: 1 }] });
const snapshot = intent => ({ ...buildReturnBatchPayload(intent), id: '901', tranId: 'CM901', status: { refName: 'Open' },
  item: { items: buildReturnBatchPayload(intent).item.items.map(row => ({ ...row,
    amount: row.quantity === undefined ? row.rate : Math.round(row.quantity * row.rate * 100) / 100 })) } });
const batch = () => ({ batch_id: 54, netsuite_transaction_id: 901, intent_snapshot: original(), netsuite_snapshot: snapshot(original()), draft_id: null });
const request = b => ({ version: 1, batchId: 54, creditMemoId: 901, baseIntent: structuredClone(b.intent_snapshot),
  useDefaultItemDescriptions: true, reason: 'User requested rate 1 restocking test',
  stockRates: [{ lineIndex: 0, fromRate: 0, rate: 1 }] });

test('D1 new admissions use version 5 for NetSuite default descriptions', () => {
  const source = original();
  const data = buildReturnBatchIntent([{ id: 65, batchId: 54, batchReference: 'RB-000040', recordReference: 'SR-000017',
    submittedDate: source.submittedDate, customerId: 30, receivingLocationId: 1, recordType: 'stock',
    sourceSalesOrderId: 40, sourceSalesOrderRef: 'SOB40', operatorAccount: 'operator', lines: source.lines }]);
  assert.equal(data.version, 5);
});

test('D2 version 5 omits all CM descriptions while historical intents and RA links remain explicit', () => {
  const data = original(); data.version = 5;
  data.lines.push({ kind: 'pallet', itemId: 70, returnedSalesQuantity: 1, rate: 40, reasonId: 10 });
  const payload = buildReturnBatchPayload(data);
  assert.equal(payload.item.items.length, 3);
  assert.ok(payload.item.items.every(row => !Object.hasOwn(row, 'description')));
  assert.equal(payload.otherRefNum, 'SOB40');
  assert.equal(payload.memo, data.memo);
  assert.match(buildReturnBatchPayload(original()).item.items[0].description, /source line 401/);
  assert.match(buildReturnBatchPayload(original()).item.items[1].description, /Restocking Fee/);
  data.transactionType = 'return_authorization'; data.lines.splice(1, 0, { ...data.lines[0], reasonId: 7 });
  assert.match(buildReturnBatchPayload(data).item.items[1].description, /source line 401/);
});

test('D3 NetSuite descriptions are accepted without weakening version 5 financial or identity verification', () => {
  const data = original(); data.version = 5; data.lines[0].rate = 1;
  const valid = snapshot(data);
  valid.item.items[0].description = 'NetSuite default product description';
  valid.item.items[1].description = '';
  assert.equal(verifyReturnBatchSnapshot(data, valid), valid);
  for (const mutate of [s => { s.externalId = 'foreign'; }, s => { s.item.items[0].rate = 2; },
    s => { s.item.items[0].quantity = 12; }, s => { s.item.items[0].units = '9'; },
    s => { s.item.items[0].location.id = '28'; }, s => { s.item.items[0].custcol_atlas_rc_so.id = '5'; },
    s => { s.item.items[1].rate = 0; }, s => { s.item.items.reverse(); }]) {
    const invalid = structuredClone(valid); mutate(invalid);
    assert.throws(() => verifyReturnBatchSnapshot(data, invalid), { code: 'RETURN_CM_VERIFICATION_FAILED' });
  }
});

test('A1 approved rate 1 gives 11.66 stock and -4.08 fee without mutating the original submission', () => {
  const b = batch(); const before = structuredClone(b);
  const effective = buildAdjustedReturnCreditMemoIntent(b, request(b));
  assert.equal(effective.version, 5);
  assert.equal(effective.lines[0].rate, 1);
  assert.deepEqual(b, before);
  assert.deepEqual({ ...effective, version: 4, lines: effective.lines.map(line => ({ ...line, rate: 0 })) }, original());
  const saved = snapshot(effective);
  assert.equal(saved.item.items[0].amount, 11.66);
  assert.equal(saved.item.items[1].amount, -4.08);
  assert.equal(verifyReturnCreditMemoAdjustment(b, request(b), saved).lines[0].rate, 1);
  assert.throws(() => verifyReturnBatchSnapshot(original(), saved), { code: 'RETURN_CM_VERIFICATION_FAILED' });
});

test('A2 adjustments reject foreign or stale intent, invalid rates, duplicate indices, and unverified batches', () => {
  for (const mutate of [r => { r.batchId = 55; }, r => { r.creditMemoId = 902; }, r => { r.baseIntent.memo = 'changed'; },
    r => { r.stockRates[0].rate = -1; }, r => { r.stockRates[0].rate = Infinity; }, r => { r.stockRates[0].rate = ''; },
    r => { r.stockRates[0].fromRate = 1; }, r => { r.stockRates[0].lineIndex = 1; },
    r => { r.stockRates.push({ ...r.stockRates[0] }); }, r => { r.useDefaultItemDescriptions = 'true'; },
    r => { r.reason = ''; }, r => { r.stockRates = []; }]) {
    const b = batch(); const r = request(b); mutate(r);
    assert.throws(() => buildAdjustedReturnCreditMemoIntent(b, r), { code: 'RETURN_CM_ADJUSTMENT_INVALID' });
  }
  for (const mutate of [b => { b.draft_id = 12; }, b => { b.netsuite_snapshot = {}; },
    b => { b.intent_snapshot.lines[0].kind = 'pallet'; }, b => { b.intent_snapshot.transactionType = 'return_authorization'; }]) {
    const b = batch(); mutate(b);
    assert.throws(() => buildAdjustedReturnCreditMemoIntent(b, request(b)), { code: 'RETURN_CM_ADJUSTMENT_INVALID' });
  }
});

test('A3 correction recording requires actual stock and fee amounts as well as exact rows', () => {
  const b = batch(); const r = request(b); const effective = buildAdjustedReturnCreditMemoIntent(b, r);
  for (const mutate of [s => { s.item.items[0].amount = 0; }, s => { s.item.items[1].amount = 0; },
    s => { delete s.item.items[1].amount; }, s => { s.id = '902'; }]) {
    const invalid = snapshot(effective); mutate(invalid);
    assert.throws(() => verifyReturnCreditMemoAdjustment(b, r, invalid));
  }
});

test('A4 generated authorized rates preserve quantities and calculate each fee; incorrect rates still fail', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 100000 }), cents => {
    const b = batch(); const r = request(b); r.stockRates[0].rate = cents / 100;
    const effective = buildAdjustedReturnCreditMemoIntent(b, r);
    assert.equal(effective.lines[0].returnedSalesQuantity, 11.66);
    const saved = snapshot(effective);
    const grossCents = (1166n * BigInt(cents) + 50n) / 100n;
    const expectedFeeCents = (grossCents * 35n + 50n) / 100n;
    assert.equal(Math.round(-saved.item.items[1].rate * 100) || 0, Number(expectedFeeCents));
    assert.equal(verifyReturnCreditMemoAdjustment(b, r, saved).lines[0].rate, cents / 100);
    saved.item.items[0].rate += 0.01;
    assert.throws(() => verifyReturnCreditMemoAdjustment(b, r, saved));
  }), { seed: 20261028, numRuns: 100 });
});

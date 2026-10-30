import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { buildReturnBatchIntent, buildReturnBatchPayload, verifyReturnBatchSnapshot } from '../../../src/return-batch-ra-domain.js';

const line = (reasonId = 10) => ({ kind: 'stock', sourceSalesOrderLineId: 401, netSuiteOrderLine: 2,
  itemId: 60, returnedSalesQuantity: 2, rate: 12.5, reasonId, salesUomId: 3, locationId: reasonId === 10 ? 1 : 9 });
const intent = () => ({ version: 4, transactionType: 'credit_memo', externalId: 'MBBS-RB-000001',
  customerId: 30, receivingLocationId: 1, sourceSalesOrderId: 40, sourceSalesOrderRef: 'SOB00040',
  operatorAccount: 'yard.operator', submittedDate: '2026-10-28', memo: 'yard.operator | SR-000001',
  restockingFee: { itemId: 3015, percent: 35 }, lines: [line(), line(5),
    { kind: 'pallet', itemId: 70, returnedSalesQuantity: 1, rate: 40, reasonId: 10, salesUomId: null }] });
const snapshot = data => ({ ...buildReturnBatchPayload(data), id: '901', tranId: 'CM901', status: { refName: 'Open' } });

test('E6/E7 a fee immediately follows each GD stock row; quality and pallets keep their own locations without fees', () => {
  const payload = buildReturnBatchPayload(intent());
  assert.deepEqual(payload.item.items.map(row => Number(row.item.id)), [60, 3015, 60, 70]);
  assert.equal(payload.item.items[1].rate, -8.75);
  assert.equal(payload.item.items[1].quantity, undefined);
  assert.equal(payload.item.items[2].location.id, '9');
  assert.equal(payload.item.items[3].location.id, '1');
});

test('E8 stock otherRefNum retains the Sales Order number', () => {
  assert.equal(buildReturnBatchPayload(intent()).otherRefNum, 'SOB00040');
});

test('E10 source SO custom rate is explicit on the CM stock row and prices its fee', () => {
  const data = intent();
  data.lines[0].rate = 7.123456;
  const rows = buildReturnBatchPayload(data).item.items;
  assert.deepEqual(rows[0].price, { id: '-1' });
  assert.equal(rows[0].rate, 7.123456);
  assert.equal(rows[0].units, '3');
  assert.equal(rows[1].rate, -4.99);
  const changed = snapshot(data); changed.item.items[0].rate = 12.5;
  assert.throws(() => verifyReturnBatchSnapshot(data, changed), { code: 'RETURN_CM_VERIFICATION_FAILED' });
});

test('E9 intent memo begins with the operator account for either return type', () => {
  for (const kind of ['stock', 'pallet']) {
    const record = { id: 1, batchId: 1, batchReference: 'RB-000001', recordReference: 'SR-000001',
      recordType: kind, submittedDate: '2026-10-28', customerId: 30, receivingLocationId: 1,
      operatorAccount: 'yard.operator', sourceSalesOrderId: 40, sourceSalesOrderRef: 'SOB00040',
      lines: [line()], palletItemId: 70, palletQuantity: 1 };
    assert.match(buildReturnBatchIntent([record]).memo, /^yard\.operator \| /);
  }
});

test('E6 generated per-line fees round half up, preserve gross prices, and never affect R1-R5 or pallets', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 10000 }), fc.integer({ min: 0, max: 100000 }),
    fc.integer({ min: 0, max: 10000 }), (quantity, cents, hundredthPercent) => {
      const data = intent();
      data.lines[0].returnedSalesQuantity = quantity;
      data.lines[0].rate = cents / 100;
      data.restockingFee.percent = hundredthPercent / 100;
      const rows = buildReturnBatchPayload(data).item.items;
      const expectedCents = (BigInt(quantity) * BigInt(cents) * BigInt(hundredthPercent) + 5000n) / 10000n;
      assert.equal(Math.round(-rows[1].rate * 100) || 0, Number(expectedCents));
      assert.equal(rows[0].rate, cents / 100);
      assert.equal(rows[0].quantity, quantity);
      assert.equal(rows.filter(row => row.item.id === '3015').length, 1);
    }), { numRuns: 150, seed: 20261028 });
});

test('E6/E7/E8 verification rejects wrong fee amount, missing/moved fee, parent location, reference and memo', () => {
  const data = intent();
  assert.equal(verifyReturnBatchSnapshot(data, snapshot(data)).id, '901');
  for (const change of [
    s => { s.item.items[1].rate = 8.75; },
    s => { s.item.items.splice(1, 1); },
    s => { [s.item.items[1], s.item.items[2]] = [s.item.items[2], s.item.items[1]]; },
    s => { s.item.items[2].location.id = '1'; },
    s => { s.otherRefNum = 'SOB999'; }, s => { s.memo = 'another.operator'; }
  ]) {
    const invalid = snapshot(data); change(invalid);
    assert.throws(() => verifyReturnBatchSnapshot(data, invalid), { code: 'RETURN_CM_VERIFICATION_FAILED' });
  }
});

test('E6 new stock CMs require a valid admitted fee while historical payloads stay unchanged', () => {
  for (const fee of [null, {}, { itemId: -1, percent: 35 }, { itemId: 3015, percent: -1 }, { itemId: 3015, percent: NaN }]) {
    assert.throws(() => buildReturnBatchPayload({ ...intent(), restockingFee: fee }), { code: 'RETURN_RESTOCKING_FEE_MISSING' });
  }
  const historical = { ...intent(), version: 3 };
  const payload = buildReturnBatchPayload(historical);
  assert.deepEqual(payload.item.items.map(row => Number(row.item.id)), [60, 60, 70]);
  assert.equal(payload.otherRefNum, undefined);
});

test('E6 verified accounting adjustments cannot hide, replace or alter the declared per-item restocking fee', () => {
  const data = intent();
  const valid = snapshot(data);
  valid.item.items.push({ item: { id: '-2' }, itemType: { id: 'Subtotal' }, amount: 65 },
    { item: { id: '10716' }, itemType: { id: 'Discount' }, rate: -5, amount: -5 });
  assert.throws(() => verifyReturnBatchSnapshot(data, valid), { code: 'RETURN_CM_VERIFICATION_FAILED' });
  assert.equal(verifyReturnBatchSnapshot(data, valid, { allowAccountingAdjustments: true }), valid);
  for (const change of [
    s => { s.item.items[1].rate = 0; },
    s => { s.item.items[1].quantity = 1; },
    s => { s.item.items.at(-1).item.id = '3015'; },
    s => { s.item.items.at(-1).rate = 5; },
    s => { s.item.items.at(-1).amount = 5; },
    s => { s.item.items.at(-1).quantity = 1; },
    s => { s.item.items.at(-1).itemType.id = 'OthCharge'; },
    s => { s.item.items.at(-2).amount = -1; }
  ]) {
    const invalid = structuredClone(valid); change(invalid);
    assert.throws(() => verifyReturnBatchSnapshot(data, invalid, { allowAccountingAdjustments: true }), { code: 'RETURN_CM_VERIFICATION_FAILED' });
  }
});

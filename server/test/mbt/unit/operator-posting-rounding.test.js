import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { verifyOperatorNetSuitePostingRecord } from '../../../src/operator-netsuite-posting-adapter.js';
import { buildOperatorNetSuitePostingDraft } from '../../../src/operator-netsuite-posting-domain.js';

const combinations = [['SO', 'IF'], ['TO', 'IF'], ['PO', 'IR'], ['TO', 'IR']];
const mismatch = error => error?.code === 'OPERATOR_NETSUITE_POSTING_REMOTE_MISMATCH';

function evidence(expected = 60.7602, actual = 60.76, kind = 'SO', type = 'IF', unit = 'SQFT') {
  const step = {
    sourceOrderKind: kind, transactionType: type, sourceNetSuiteId: 1051337,
    externalId: 'MBBS-OP-rounding-fixture-1',
    payload: { item: { items: [{ orderLine: 2, quantity: expected, itemReceive: true, location: 28 }] } },
    lineSnapshot: [{ orderLine: 2, itemId: 4767, salesUom: unit }]
  };
  const record = {
    id: 1051504, tranId: type === 'IF' ? 'IF157392' : 'IR-rounding-fixture',
    transactionType: type, createdFrom: { id: '1051337' }, externalId: step.externalId,
    item: { items: [{ orderLine: 2, quantity: actual, itemReceive: true,
      location: { id: '28' }, item: { id: '4767' }, unitsDisplay: unit }] }
  };
  return { step, record };
}

for (const [kind, type] of combinations) {
  test(`R1 ${kind} ${type} accepts SQFT variance strictly below 0.01 in both directions`, () => {
    for (const [expected, actual] of [[60.7602, 60.76], [60.76, 60.7602], [1, 1.009999], [1.009999, 1], [60.765, 60.76]]) {
      const { step, record } = evidence(expected, actual, kind, type);
      assert.equal(verifyOperatorNetSuitePostingRecord(step, record).id, record.id);
      assert.equal(step.payload.item.items[0].quantity, expected);
      assert.equal(record.item.items[0].quantity, actual);
    }
  });
}

test('R2 the complete IF157392 fixture verifies all three source lines', () => {
  const { step, record } = evidence();
  for (const [orderLine, quantity, itemId] of [[1, 91.14, 4765], [4, 21.26, 4754]]) {
    step.payload.item.items.push({ orderLine, quantity, itemReceive: true, location: 28 });
    step.lineSnapshot.push({ orderLine, itemId });
    record.item.items.push({ orderLine, quantity, itemReceive: true,
      location: { id: '28' }, item: { id: String(itemId) }, unitsDisplay: 'SQFT' });
  }
  const verified = verifyOperatorNetSuitePostingRecord(step, record);
  assert.equal(verified.id, 1051504);
  assert.equal(verified.transactionRef, 'IF157392');
  assert.deepEqual(verified.quantityAdjustments, [{ orderLine: 2, requestedQuantity: 60.7602,
    netSuiteQuantity: 60.76, salesUom: 'SQFT' }]);
});

test('R3 exactly 0.01 and larger SQFT differences remain held for every IF and IR source', () => {
  for (const [kind, type] of combinations) {
    for (const delta of [0.01, 0.010001, 0.02, 1]) {
      for (const sign of [-1, 1]) {
        const { step, record } = evidence(60.76, 60.76 + sign * delta, kind, type);
        assert.throws(() => verifyOperatorNetSuitePostingRecord(step, record), mismatch);
      }
    }
  }
});

test('R4 rounding never excuses wrong identity, item, yard, missing or duplicate lines', () => {
  const alterations = [
    record => { record.createdFrom.id = '999'; },
    record => { record.externalId = 'other-request'; },
    record => { record.transactionType = 'IR'; },
    record => { record.item.items[0].item.id = '999'; },
    record => { record.item.items[0].location.id = '1'; },
    record => { record.item.items[0].unitsDisplay = 'EACH'; },
    record => { delete record.item.items[0].unitsDisplay; },
    record => { record.item.items = []; },
    record => { record.item.items.push(structuredClone(record.item.items[0])); },
    record => { record.item.items.push({ ...record.item.items[0], orderLine: 3 }); }
  ];
  for (const alter of alterations) {
    const { step, record } = evidence();
    alter(record);
    assert.throws(() => verifyOperatorNetSuitePostingRecord(step, record), mismatch);
  }
});

test('R7 the SQFT allowance never applies to EACH, PC, M2 or absent units', () => {
  for (const unit of ['EACH', 'PC', 'M2', '']) {
    const { step, record } = evidence(60.7602, 60.76, 'SO', 'IF', unit);
    assert.throws(() => verifyOperatorNetSuitePostingRecord(step, record), mismatch);
  }
});

test('P5 property: other units retain strict verification for every IF and IR', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 100000 }), fc.integer({ min: 2, max: 9999 }),
    fc.constantFrom('EACH', 'PC', 'M2', ''), fc.constantFrom(-1, 1), fc.constantFrom(...combinations),
    (base, micros, unit, sign, [kind, type]) => {
      const { step, record } = evidence(base, base + sign * micros / 1000000, kind, type, unit);
      assert.throws(() => verifyOperatorNetSuitePostingRecord(step, record), mismatch);
    }), { seed: 157396, numRuns: 300 });
});

test('R4 invalid and absent positive quantities cannot complete a posting', () => {
  for (const value of [NaN, Infinity, -Infinity, 0, -1, null, undefined, 'bad']) {
    for (const side of ['expected', 'actual']) {
      const { step, record } = evidence();
      if (side === 'expected') { step.payload.item.items[0].quantity = value; }
      else { record.item.items[0].quantity = value; }
      assert.throws(() => verifyOperatorNetSuitePostingRecord(step, record), mismatch);
    }
  }
});

test('P1 property: every representable positive quantity within the allowance verifies', () => {
  fc.assert(fc.property(
    fc.integer({ min: 100, max: 100000000 }), fc.integer({ min: -9999, max: 9999 }),
    fc.constantFrom(...combinations), (base, micros, [kind, type]) => {
      const expected = base / 100;
      const actual = expected + micros / 1000000;
      const { step, record } = evidence(expected, actual, kind, type);
      assert.equal(verifyOperatorNetSuitePostingRecord(step, record).id, record.id);
    }), { seed: 157392, numRuns: 600 });
});

test('P2 property: the allowance is absolute and discrepancies outside it stay held', () => {
  fc.assert(fc.property(
    fc.integer({ min: 100, max: 1000000000 }), fc.integer({ min: 10000, max: 100000 }),
    fc.constantFrom(-1, 1), fc.constantFrom(...combinations), (base, micros, sign, [kind, type]) => {
      const expected = base / 100;
      const actual = expected + sign * micros / 1000000;
      const { step, record } = evidence(expected, actual, kind, type);
      assert.throws(() => verifyOperatorNetSuitePostingRecord(step, record), mismatch);
    }), { seed: 157393, numRuns: 600 });
});

test('P3 property: swapped identities stay invalid even with a matching rounded quantity', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 100000 }), fc.integer({ min: -9999, max: 9999 }),
    fc.integer({ min: 0, max: 4 }), (base, micros, target) => {
      const { step, record } = evidence(base, base + micros / 1000000);
      if (target === 0) { record.createdFrom.id = '999'; }
      if (target === 1) { record.externalId = 'other-request'; }
      if (target === 2) { record.transactionType = 'IR'; }
      if (target === 3) { record.item.items[0].item.id = '999'; }
      if (target === 4) { record.item.items[0].location.id = '1'; }
      assert.throws(() => verifyOperatorNetSuitePostingRecord(step, record), mismatch);
    }), { seed: 157394, numRuns: 300 });
});

function draft(localQuantity, netSuiteQuantity, kind = 'SO', type = 'IF', direct = true, unit = 'SQFT') {
  const key = `rounding:${kind}:${type}:1051337`;
  const functionKey = type === 'IF' ? kind === 'SO' ? 'customer_pickup' : 'delivery_prep' : 'receiving';
  const operationKinds = { SO: 'customer_pickup_load', TO: 'delivery_prep_load' };
  const orderTypes = { SO: 'sales_order', PO: 'purchase_order', TO: 'transfer_order' };
  return buildOperatorNetSuitePostingDraft({
    requestId: '12345678-1234-4234-8234-123456789abc', actorOperatorId: 'rounding-test',
    functionKey, transactionType: type, photoRefs: [], localOrderKeys: [key],
    policy: { gateKey: 'rounding-test', revision: 1, effective: true, functionKey,
      transactionType: type, locationId: 28, yardCode: '2967' },
    localOperation: { kind: type === 'IF' ? operationKinds[kind] : 'receiving_receipt',
      orderId: '1051337', orderType: orderTypes[kind] },
    ...(type === 'IR' ? { localPayload: { item: { items: [{ orderLine: 5110280, quantity: localQuantity, itemReceive: true }] } } } : {}),
    targets: [{ sourceOrderKind: kind, sourceNetSuiteId: 1051337, sourceOrderRef: 'ROUNDING-TEST',
      ...(direct ? { postingStrategy: 'stored_order_line_v1' } : {}),
      selectedLines: [{ orderLine: 2, quantity: localQuantity, location: 28, itemId: 4767,
        salesUom: unit, sourceLineKey: '5110280', localOrderKey: key, localLineId: '529848' }],
      availableLines: [{ orderLine: 2, orderedQuantity: netSuiteQuantity, completedQuantity: 0,
        remainingQuantity: netSuiteQuantity, location: 28, salesUom: unit, sourceLineKey: '5110280' }] }]
  });
}

test('R4 a changed NetSuite unit remains held even when the quantity matches exactly', () => {
  const { step, record } = evidence(60.76, 60.76);
  record.item.items[0].unitsDisplay = 'EACH';
  assert.throws(() => verifyOperatorNetSuitePostingRecord(step, record), /units/u);
});

test('R8 every IF/IR draft posts the NetSuite quantity for a nearly equal SQFT confirmation', () => {
  for (const [kind, type] of combinations) {
    for (const direct of [true, false]) {
      for (const localQuantity of [60.7602, 60.7598, 60.769999, 60.750001]) {
        const command = draft(localQuantity, 60.76, kind, type, direct);
        assert.equal(command.steps[0].payload.item.items[0].quantity, 60.76);
        assert.equal(command.steps[0].lineSnapshot[0].quantity, localQuantity);
        const reconciliation = command.inputSnapshot.lineReconciliation.lines[0];
        assert.equal(reconciliation.requestedQuantity, localQuantity);
        assert.equal(reconciliation.postedQuantity, 60.76);
        if (type === 'IR') { assert.equal(command.inputSnapshot.localPayload.item.items[0].quantity, 60.76); }
      }
    }
  }
});

test('R8 partial, other-unit and zero-availability postings do not acquire extra quantities', () => {
  for (const [kind, type] of combinations) {
    assert.equal(draft(40, 60.76, kind, type).steps[0].payload.item.items[0].quantity, 40);
    assert.equal(draft(60.750001, 60.76, kind, type, true, 'EACH').steps[0].payload.item.items[0].quantity, 60.750001);
    assert.throws(() => draft(0.0002, 0, kind, type, true));
  }
});

test('P4 property: a SQFT payload uses exactly NetSuite remaining quantity, preserving its local snapshot', () => {
  fc.assert(fc.property(fc.integer({ min: 100, max: 1000000 }), fc.integer({ min: -9999, max: 9999 }),
    fc.constantFrom(...combinations), (base, micros, [kind, type]) => {
      const ns = base / 100;
      const local = Number((ns + micros / 1000000).toFixed(6));
      const command = draft(local, ns, kind, type);
      assert.equal(command.steps[0].payload.item.items[0].quantity, ns);
      assert.equal(command.steps[0].lineSnapshot[0].quantity, local);
    }), { seed: 157395, numRuns: 300 });
});

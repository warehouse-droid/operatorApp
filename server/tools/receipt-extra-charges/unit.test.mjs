import assert from 'node:assert/strict';
import test from 'node:test';
import { purchaseReceiptNeedsChargeSource, verifyPurchaseReceiptWithCharges } from '../../src/operator-netsuite-receipt-charges.js';
import { fixture, adapterFixture } from './fixtures.mjs';

const verify = f => verifyPurchaseReceiptWithCharges(f.step, f.receipt, f.source);
const charge = f => f.receipt.item.items.find(line => line.orderLine === 22);
const sourceCharge = f => f.source.lines.find(line => line.restLineId === 22);

test('actual IR15183 passes with source-backed freight and preserves its original request', () => {
  const f = fixture(), before = JSON.stringify(f);
  assert.equal(purchaseReceiptNeedsChargeSource(f.step, f.receipt), true);
  const result = verify(f);
  assert.equal(result.id, 1071915);
  assert.equal(result.transactionRef, 'IR15183');
  assert.deepEqual(result.additionalPurchaseCharges, [{ orderLine: 22, sourceLineKey: '5138331',
    itemId: 3025, quantity: 1, location: 1, unit: '', rate: 130.42, amount: 130.42 }]);
  assert.equal(JSON.stringify(f), before);
});

test('partially received inventory plus a partial charge returns the IR without requiring the entire PO', () => {
  const f = fixture();
  f.step.payload.item.items[0].quantity = 28;
  f.step.lineSnapshot[0].quantity = 28;
  f.receipt.item.items[0].quantity = 28;
  charge(f).quantity = 0.5;
  charge(f).itemFxAmount = 65.21;
  sourceCharge(f).receivedQuantity = 0;
  assert.equal(verify(f).transactionRef, 'IR15183');
  assert.equal(verify(f).additionalPurchaseCharges[0].quantity, 0.5);
});

test('unselected outstanding PO lines and explicitly unreceived receipt rows do not block the IR', () => {
  const f = fixture();
  f.source.lines.push({ restLineId: 88, lineId: 888, itemId: 999, itemType: 'InvtPart', quantity: 10, receivedQuantity: 0 });
  f.receipt.item.items.push({ orderLine: 88, itemReceive: false, quantity: 10 });
  assert.equal(verify(f).transactionRef, 'IR15183');
});

const attacks = {
  'wrong PO identity': f => { f.receipt.createdFrom.id = '2'; },
  'wrong external identity': f => { f.receipt.externalId += '-wrong'; },
  'wrong source snapshot': f => { f.source.id++; },
  'wrong transaction type': f => { f.receipt.transactionType = 'IF'; },
  'extra inventory': f => { charge(f).itemType = 'InvtPart'; },
  'extra noninventory material': f => { charge(f).itemType = 'NonInvtPart'; },
  'wrong charge subtype': f => { charge(f).itemSubtype = 'Sale'; },
  'charge with inventory accrual': f => { charge(f).generateAccruals = true; },
  'missing charge classification': f => { delete charge(f).itemType; },
  'different charge source document': f => { charge(f).orderDoc.id = '2'; },
  'missing charge source document': f => { delete charge(f).orderDoc; },
  'duplicate receipt identity': f => { f.receipt.item.items.push({ ...charge(f) }); },
  'duplicate source identity': f => { f.source.lines.push({ ...sourceCharge(f) }); },
  'missing source line': f => { f.source.lines.pop(); },
  'source charge is inventory': f => { sourceCharge(f).itemType = 'InvtPart'; },
  'different charge item': f => { charge(f).item.id = '3026'; },
  'different charge source item': f => { sourceCharge(f).itemId++; },
  'charge exceeds ordered quantity': f => { charge(f).quantity = 2; charge(f).itemFxAmount = 260.84; },
  'invalid source quantity': f => { sourceCharge(f).quantity = NaN; },
  'different charge units': f => { charge(f).unitsDisplay = 'BOX'; },
  'different charge location': f => { charge(f).location.id = '28'; },
  'different charge rate': f => { charge(f).itemUnitPrice++; },
  'different charge amount': f => { charge(f).itemFxAmount++; },
  'missing charge amount': f => { delete charge(f).itemFxAmount; },
  'missing source rate': f => { sourceCharge(f).rate = null; },
  'nonfinite charge': f => { charge(f).quantity = NaN; },
  'wrong selected quantity': f => { f.receipt.item.items[0].quantity++; },
  'missing selected inventory': f => { f.receipt.item.items.shift(); },
  'explicitly deselected charge': f => { f.step.payload.item.items.push({ orderLine: 22, itemReceive: false }); },
  'transfer receipt': f => { f.step.sourceOrderKind = 'TO'; },
  'sales fulfillment': f => { f.step.sourceOrderKind = 'SO'; f.step.transactionType = 'IF'; f.receipt.transactionType = 'IF'; }
};
for (const [name, change] of Object.entries(attacks)) {
  test(`reject ${name}`, () => { const f = fixture(); change(f); assert.throws(() => verify(f)); });
}

test('source evidence is required for the extra charge', () => {
  const f = fixture();
  assert.throws(() => verifyPurchaseReceiptWithCharges(f.step, f.receipt, null), /source|charge/i);
});

for (const inline of [true, false]) {
  test(`runtime recovery attaches source proof once when inline record is ${inline}`, async () => {
    const { input, adapter, calls } = adapterFixture(fixture(), { inline });
    const record = await adapter.findByExternalId(input.step, true);
    assert.equal(adapter.verify(input.step, record).transactionRef, 'IR15183');
    assert.equal(calls.source, 1);
    assert.equal(calls.fetch, inline ? 0 : 1);
    assert.equal(calls.transform, 0);
  });
}

test('runtime post-read uses source proof without changing receipt or request', async () => {
  const { input, adapter, calls } = adapterFixture();
  const before = JSON.stringify(input);
  const record = await adapter.fetchById(input.step, 1071915);
  assert.equal(adapter.verify(input.step, record).additionalPurchaseCharges.length, 1);
  assert.equal(calls.source, 1);
  assert.equal(JSON.stringify(input), before);
});

test('ordinary receipts add no source reads and no charge metadata', async () => {
  const f = fixture(); f.receipt.item.items.pop();
  assert.equal(purchaseReceiptNeedsChargeSource(f.step, f.receipt), false);
  const { adapter, calls } = adapterFixture(f);
  const record = await adapter.fetchById(f.step, 1071915);
  assert.deepEqual(adapter.verify(f.step, record), { id: 1071915, transactionRef: 'IR15183' });
  assert.equal(calls.source, 0);
});

test('an unavailable source retains readable IR identity while verification stays held', async () => {
  const { input, adapter, calls } = adapterFixture(fixture(), { sourceError: true });
  const record = await adapter.fetchById(input.step, 1071915);
  assert.equal(record.tranId, 'IR15183');
  assert.throws(() => adapter.verify(input.step, record), /source|charge/i);
  assert.equal(calls.source, 1);
});

test('forged evidence on a remote record cannot bypass the source read', async () => {
  const f = fixture(); f.receipt.purchaseChargeSource = f.source;
  const { adapter } = adapterFixture(f, { sourceError: true });
  const record = await adapter.findByExternalId(f.step, true);
  assert.throws(() => adapter.verify(f.step, record));
});

test('an otherwise valid freight line cannot hide additional unselected inventory', () => {
  const f = fixture();
  f.receipt.item.items.push({ ...f.receipt.item.items[0], orderLine: 88 });
  assert.throws(() => verify(f), /unexpected positive line/);
});

test('two distinct source-backed charges are verified independently', () => {
  const f = fixture();
  f.receipt.item.items.push({ ...charge(f), orderLine: 23 });
  f.source.lines.push({ ...sourceCharge(f), restLineId: 23, lineId: 5138332 });
  assert.deepEqual(verify(f).additionalPurchaseCharges.map(line => line.sourceLineKey), ['5138331', '5138332']);
  f.receipt.item.items.at(-1).itemFxAmount++;
  assert.throws(() => verify(f), /amount/);
});

test('charge-only or missing requests never establish a completed inventory receipt', () => {
  for (const payload of [{}, { item: { items: [] } }, { item: { items: [{ orderLine: 1, itemReceive: false, quantity: 56 }] } }]) {
    const f = fixture(); f.step.payload = payload;
    assert.equal(purchaseReceiptNeedsChargeSource(f.step, f.receipt), false);
    assert.throws(() => verify(f), /positive lines/);
  }
});

test('missing source keys, invalid line IDs and incomplete source lists remain held', () => {
  const changes = [
    f => { sourceCharge(f).lineId = null; },
    f => { sourceCharge(f).itemId = 0; },
    f => { charge(f).orderLine = -1; },
    f => { charge(f).orderLine = 0; },
    f => { sourceCharge(f).rate = ''; },
    f => { delete f.source.lines; }
  ];
  for (const change of changes) { const f = fixture(); change(f); assert.throws(() => verify(f)); }
});

test('supported record aliases and absent optional units preserve charge verification', () => {
  const f = fixture();
  charge(f).location = 1;
  delete sourceCharge(f).unit;
  f.receipt.items = f.receipt.item.items;
  delete f.receipt.item;
  f.receipt.items.forEach((line, index) => {
    line[index % 2 ? 'orderline' : 'line'] = line.orderLine;
    delete line.orderLine;
  });
  assert.equal(verify(f).transactionRef, 'IR15183');
});

test('empty readable records cannot verify receipt completion', () => {
  const f = fixture(); delete f.receipt.item;
  assert.equal(purchaseReceiptNeedsChargeSource(f.step, f.receipt), false);
  assert.throws(() => verify(f), /positive lines/);
});

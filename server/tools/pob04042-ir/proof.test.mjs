import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { verifyReceiptRecovery } from './proof.mjs';

export const fixture = () => JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));

test('source-backed freight permits recovering IR15183 with all five confirmed inventory lines', () => {
  const input = fixture(), before = JSON.stringify(input);
  const proof = verifyReceiptRecovery(input);
  assert.equal(proof.id, 1071915);
  assert.equal(proof.transactionRef, 'IR15183');
  assert.deepEqual(proof.freight, { orderLine: 22, sourceLineKey: '5138331', itemId: 3025, quantity: 1, amount: 130.42, location: 1 });
  assert.equal(JSON.stringify(input), before, 'The original posting request is immutable');
});

const attacks = {
  'different command': f => { f.command.id = 'different'; },
  'different receipt': f => { f.receipt.id = '1071916'; },
  'different receipt reference': f => { f.receipt.tranId = 'IR15184'; },
  'different external identity': f => { f.receipt.externalId += '-other'; },
  'different PO': f => { f.receipt.createdFrom.id = '1059323'; },
  'different source snapshot': f => { f.source.id++; },
  'different local order': f => { f.command.inputSnapshot.localOperation.orderId = '1059323'; },
  'different local quantity': f => { f.command.inputSnapshot.localPayload.item.items[0].quantity++; },
  'different selected quantity': f => { f.command.steps[0].payload.item.items[0].quantity++; },
  'different inventory quantity': f => { f.receipt.item.items[0].quantity++; },
  'different inventory item': f => { f.receipt.item.items[0].item.id = '4042'; },
  'different units': f => { f.receipt.item.items[0].unitsDisplay = 'BOX'; },
  'different location': f => { f.receipt.item.items[0].location.id = '28'; },
  'missing inventory': f => { f.receipt.item.items.splice(0, 1); },
  'unreceived inventory': f => { f.receipt.item.items[0].itemReceive = false; },
  'additional inventory': f => { f.receipt.item.items.push({ ...f.receipt.item.items[0], orderLine: 23 }); },
  'duplicate receipt line': f => { f.receipt.item.items[5].orderLine = 1; },
  'duplicate source line': f => { f.source.lines.push({ ...f.source.lines[5] }); },
  'freight inventory type': f => { f.receipt.item.items[5].itemType = 'InvtPart'; },
  'freight source inventory type': f => { f.source.lines[5].itemType = 'InvtPart'; },
  'freight sales subtype': f => { f.receipt.item.items[5].itemSubtype = 'Sale'; },
  'freight accruals': f => { f.receipt.item.items[5].generateAccruals = true; },
  'freight amount mismatch': f => { f.receipt.item.items[5].itemFxAmount++; },
  'freight source amount mismatch': f => { f.source.lines[5].amount++; },
  'freight rate mismatch': f => { f.receipt.item.items[5].itemUnitPrice++; },
  'freight source rate mismatch': f => { f.source.lines[5].rate++; },
  'freight item mismatch': f => { f.receipt.item.items[5].item.id = '3026'; },
  'freight source item mismatch': f => { f.source.lines[5].itemId++; },
  'freight quantity mismatch': f => { f.receipt.item.items[5].quantity++; },
  'freight source quantity mismatch': f => { f.source.lines[5].quantity++; },
  'unreceived source freight': f => { f.source.lines[5].receivedQuantity = 0; },
  'freight location mismatch': f => { f.source.lines[5].locationId = 28; },
  'nonfinite quantity': f => { f.receipt.item.items[5].quantity = NaN; },
  'missing source freight': f => { f.source.lines.pop(); }
};
for (const [name, mutate] of Object.entries(attacks)) {
  test(`reject ${name}`, () => { const f = fixture(); mutate(f); assert.throws(() => verifyReceiptRecovery(f)); });
}

test('line ordering does not affect recovery and arbitrary quantity changes are rejected', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const f = fixture(), n = seed % 6;
    f.receipt.item.items = [...f.receipt.item.items.slice(n), ...f.receipt.item.items.slice(0, n)];
    f.source.lines.reverse();
    assert.equal(verifyReceiptRecovery(f).transactionRef, 'IR15183');
    f.receipt.item.items[seed % 6].quantity += seed / 100;
    assert.throws(() => verifyReceiptRecovery(f));
  }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import fc from 'fast-check';
import { verifyReceiptRecovery } from './proof.mjs';

const fixture = () => JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
const settings = { seed: 404215183, numRuns: 100 };
test('property: every permutation retains the same proven receipt', () => {
  fc.assert(fc.property(fc.shuffledSubarray([0, 1, 2, 3, 4, 5], { minLength: 6, maxLength: 6 }), order => {
    const f = fixture();
    f.receipt.item.items = order.map(i => f.receipt.item.items[i]);
    f.source.lines = order.map(i => f.source.lines[i]);
    assert.equal(verifyReceiptRecovery(f).id, 1071915);
    assert.equal(verifyReceiptRecovery(f).transactionRef, 'IR15183');
  }), settings);
});
test('property: altered material quantity and identity are always rejected', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 4 }), fc.integer({ min: 1, max: 10000 }), (index, difference) => {
    const quantity = fixture(), item = fixture();
    quantity.receipt.item.items[index].quantity += difference / 100;
    item.receipt.item.items[index].item.id = String(Number(item.receipt.item.items[index].item.id) + difference);
    assert.throws(() => verifyReceiptRecovery(quantity));
    assert.throws(() => verifyReceiptRecovery(item));
  }), settings);
});
test('property: changed command identity and freight type or amount are always rejected', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 10000 }), difference => {
    const command = fixture(), type = fixture(), amount = fixture();
    command.command.id += difference;
    type.receipt.item.items[5].itemType = `unexpected-${difference}`;
    amount.receipt.item.items[5].itemFxAmount += difference / 100;
    for (const f of [command, type, amount]) { assert.throws(() => verifyReceiptRecovery(f)); }
  }), settings);
});

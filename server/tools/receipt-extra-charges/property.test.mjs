import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { verifyPurchaseReceiptWithCharges, purchaseReceiptNeedsChargeSource } from '../../src/operator-netsuite-receipt-charges.js';
import { fixture } from './fixtures.mjs';

const config = { seed: 404215183, numRuns: 100 };
const verify = f => verifyPurchaseReceiptWithCharges(f.step, f.receipt, f.source);
const charge = f => f.receipt.item.items.find(line => line.orderLine === 22);
const sourceCharge = f => f.source.lines.find(line => line.restLineId === 22);

function generated(material, cents, fraction, reversed) {
  const f = fixture();
  f.step.payload.item.items[0].quantity = material;
  f.step.lineSnapshot[0].quantity = material;
  f.receipt.item.items[0].quantity = material;
  const rate = cents / 100, quantity = fraction / 100;
  Object.assign(charge(f), { quantity, itemUnitPrice: rate, itemFxAmount: Math.round(quantity * rate * 100) / 100 });
  Object.assign(sourceCharge(f), { rate, amount: rate, receivedQuantity: 0 });
  if (reversed) { f.receipt.item.items.reverse(); f.source.lines.reverse(); }
  return f;
}
const arbitraries = [fc.integer({ min: 1, max: 56 }), fc.integer({ min: 0, max: 100000 }),
  fc.integer({ min: 1, max: 100 }), fc.boolean()];

test('generated partial charges accept exactly the selected materials regardless of row order', () => {
  fc.assert(fc.property(...arbitraries, (...args) => {
    const f = generated(...args), original = JSON.stringify(f);
    const result = verify(f);
    assert.equal(purchaseReceiptNeedsChargeSource(f.step, f.receipt), true);
    assert.equal(result.id, Number(f.receipt.id));
    assert.equal(result.transactionRef, f.receipt.tranId);
    assert.equal(result.additionalPurchaseCharges[0].quantity, charge(f).quantity);
    assert.equal(result.additionalPurchaseCharges[0].amount, charge(f).itemFxAmount);
    assert.equal(JSON.stringify(f), original);
  }), config);
});

test('generated receipts reject changed source, inventory, charge, and financial evidence', () => {
  fc.assert(fc.property(...arbitraries, (...args) => {
    const valid = generated(...args);
    const invalid = [
      f => { charge(f).itemType = 'InvtPart'; },
      f => { charge(f).itemSubtype = 'Sale'; },
      f => { charge(f).generateAccruals = true; },
      f => { f.source.id++; },
      f => { charge(f).orderDoc.id = '9'; },
      f => { sourceCharge(f).itemType = 'InvtPart'; },
      f => { sourceCharge(f).itemId++; },
      f => { sourceCharge(f).lineId = null; },
      f => { charge(f).quantity = 2; charge(f).itemFxAmount = 2 * sourceCharge(f).rate; },
      f => { charge(f).itemFxAmount += 1; },
      f => { charge(f).itemUnitPrice += 1; },
      f => { charge(f).unitsDisplay = 'BOX'; },
      f => { charge(f).location.id = '28'; },
      f => { f.receipt.item.items.find(line => line.orderLine === 1).quantity++; },
      f => { f.receipt.externalId += '-other'; },
      f => { f.receipt.item.items.push({ ...charge(f) }); },
      f => { f.source.lines.push({ ...sourceCharge(f) }); },
      f => { f.step.payload.item.items.push({ orderLine: 22, itemReceive: false }); },
      f => { f.source = null; }
    ];
    for (const mutate of invalid) {
      const f = structuredClone(valid); mutate(f);
      assert.throws(() => verify(f));
    }
  }), config);
});

test('ordinary generated partial receipts require no charge proof', () => {
  fc.assert(fc.property(...arbitraries, (...args) => {
    const f = generated(...args);
    f.receipt.item.items = f.receipt.item.items.filter(line => line.orderLine !== 22);
    assert.equal(purchaseReceiptNeedsChargeSource(f.step, f.receipt), false);
    assert.deepEqual(verifyPurchaseReceiptWithCharges(f.step, f.receipt, null),
      { id: Number(f.receipt.id), transactionRef: f.receipt.tranId });
  }), config);
});

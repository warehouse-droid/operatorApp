import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { transferPostingPhysicalStatus } from '../../../src/transfer-order-posting-domain.js';
import { applyTransferLoadedQuantities } from '../../../src/transfer-order-posting-repository.js';

function physicalJob(type, quantity, extra = {}) {
  return { id: type, transaction_type: type, local_to_id: 44, order_ref: 'TO-PROPERTY', operator_record_id: 5,
    operator_record_valid: true, status: 'completed', result: { transactions: [{ transactionType: 'IF', transactionId: 77 }] },
    snapshot: { planId: 88, loadId: 'load', planDate: '2026-10-09', lines: [{ itemId: 2299, quantity }] }, ...extra };
}
test('property: IF needs its load; any saved receipt can post IR after verified fulfillment', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 100000 }), fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(),
    (n, loadRecord, receiptRecord, received, verified) => {
      const quantity = n / 1000, loaded = physicalJob('IF', quantity, { operator_record_valid: loadRecord, status: verified ? 'completed' : 'admitted' });
      const receipt = physicalJob('IR', received ? quantity : quantity / 2, { operator_record_valid: receiptRecord });
      const evidence = [loaded, receipt];
      assert.equal(transferPostingPhysicalStatus(loaded, evidence), !loadRecord ? 'waiting_load' : null);
      assert.equal(transferPostingPhysicalStatus(receipt, evidence), !loadRecord ? 'waiting_load' : !receiptRecord ? 'waiting_receipt' : !verified ? 'waiting_fulfillment' : null);
    }), { seed: 20261009, numRuns: 200 });
});
test('property: another transfer or dispatch scope cannot supply receiving evidence', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 100000 }), fc.constantFrom('local_to_id', 'order_ref', 'planId', 'loadId', 'planDate'), (quantity, field) => {
    const loaded = physicalJob('IF', quantity), receipt = physicalJob('IR', quantity);
    if (field === 'local_to_id') { receipt.local_to_id = 45; }
    else if (field === 'order_ref') { receipt.order_ref = 'TO-OTHER'; }
    else { receipt.snapshot[field] = 'other'; }
    assert.equal(transferPostingPhysicalStatus(loaded, [loaded, receipt]), null);
    assert.equal(transferPostingPhysicalStatus(receipt, [loaded, receipt]), 'waiting_load');
  }), { seed: 20261010, numRuns: 100 });
});
test('property: receiving capacity across repeated item rows never exceeds local loaded quantity', () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 8 }), fc.integer({ min: 0, max: 10000 }), (quantities, loaded) => {
    const lines = quantities.map(quantity => ({ item_id: 2299, quantity, receiving_completed_qty: 0 }));
    const projected = applyTransferLoadedQuantities(lines, new Map([['2299', loaded]]));
    assert.equal(projected.reduce((sum, line) => sum + line.quantity - line.receiving_unavailable_qty, 0), Math.min(loaded, quantities.reduce((a, b) => a + b, 0)));
    assert.deepEqual(lines.map(line => line.quantity), quantities);
  }), { seed: 20261011, numRuns: 150 });
});
test('adversarial malformed physical quantities and unverified IF result cannot admit posting', () => {
  for (const quantity of [0, -1, NaN, Infinity]) {
    const loaded = physicalJob('IF', quantity), receipt = physicalJob('IR', 5);
    assert.throws(() => transferPostingPhysicalStatus(loaded, [loaded, receipt]), { code: 'TRANSFER_POSTING_EVIDENCE_INVALID' });
  }
  for (const transactions of [[], [{ transactionType: 'IR', transactionId: 77 }], [{ transactionType: 'IF', transactionId: null }]]) {
    const loaded = physicalJob('IF', 5, { result: { transactions } }), receipt = physicalJob('IR', 5);
    assert.equal(transferPostingPhysicalStatus(receipt, [loaded, receipt]), 'waiting_fulfillment');
  }
  for (const lines of [undefined, []]) {
    const loaded = physicalJob('IF', 5), receipt = physicalJob('IR', 5);
    loaded.snapshot.lines = lines;
    assert.equal(transferPostingPhysicalStatus(loaded, [loaded, receipt]), 'waiting_load');
  }
  const loaded = physicalJob('IF', 5), wrongItem = physicalJob('IR', 5);
  wrongItem.snapshot.lines[0].itemId = 2300;
  assert.equal(transferPostingPhysicalStatus(loaded, [loaded, wrongItem]), null);
  assert.equal(transferPostingPhysicalStatus(wrongItem, [loaded, wrongItem]), 'waiting_load');
});
test('another saved job cannot replace this command\'s missing Operator record', () => {
  const loaded = physicalJob('IF', 5, { operator_record_valid: false });
  const other = physicalJob('IF', 5, { id: 'other-load' });
  const receipt = physicalJob('IR', 5);
  assert.equal(transferPostingPhysicalStatus(loaded, [loaded, other, receipt]), 'waiting_load');
});

test('property: total saved receipts cannot exceed the matching loaded quantities', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 100000 }), fc.integer({ min: 1, max: 100000 }), (loadedQty, receiptQty) => {
    const loaded = physicalJob('IF', loadedQty), receipt = physicalJob('IR', receiptQty);
    assert.equal(transferPostingPhysicalStatus(receipt, [loaded, receipt]), receiptQty <= loadedQty ? null : 'waiting_load');
  }), { seed: 20261021, numRuns: 200 });
});

import assert from 'node:assert/strict';
import fc from 'fast-check';
import { harness, order, job } from '../test/support/receipt-confirmation-client.mjs';

// Fuzz untrusted receipt references through the actual HTML renderer.
fc.assert(fc.property(fc.string({ maxLength: 80 }), text => {
  const h = harness();
  h.context.receiptOrder = { ...order };
  h.context.receiptRequestId = 'saved-request';
  const hostile = `<img src=x onerror="${text}">`;
  const pending = job('attention');
  pending.steps[0].transactionRef = hostile;
  h.context.observeReceiptPostingJob(pending);
  const html = h.context.renderReceiptScreen();
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x'));
  assert.equal(h.context.receiptResult, null);
}), { seed: 1401278, numRuns: 100 });

for (const invalid of ['{', 'null', '[]', '{"requestId":{}}', '{"requestId":""}']) {
  const h = harness([{ order, job: job() }]);
  h.storage.set(h.context.receiptPostingJournalKey(order), invalid);
  assert.equal(await h.context.restoreReceiptPosting(), true);
  assert.equal(h.context.receiptResult.itemReceiptTranid, 'IR14813');
  assert.ok(h.calls.every(call => call.method === 'GET'));
}
const absent = harness();
absent.context.receivingSelectedId = null;
assert.equal(await absent.context.restoreReceiptPosting(), false);
assert.equal(absent.calls.length, 0);

const unavailable = harness([{ order, job: job() }]);
unavailable.context.window.localStorage = { getItem() { throw new Error('storage disabled'); }, setItem() { throw new Error('storage disabled'); } };
assert.equal(await unavailable.context.restoreReceiptPosting(), true);
assert.match(unavailable.context.renderReceiptScreen(), /IR14813/u);

// Some old successful responses carry only the direct IR fields.
const direct = harness();
direct.context.receiptOrder = { ...order };
direct.context.receiptRequestId = 'saved-request';
direct.context.receiptResult = { itemReceiptId: 1013762, itemReceiptTranid: 'IR14813' };
direct.context.rememberReceiptPosting({ status: 'completed', transactions: [] });
assert.equal(direct.context.readReceiptPostingJournal(order).transactions[0].ref, 'IR14813');
console.log(JSON.stringify({ escapedReferenceExamples: 100, invalidJournalCases: 5, unavailableStorage: true, emptySelection: true, legacyDirectResult: true }));

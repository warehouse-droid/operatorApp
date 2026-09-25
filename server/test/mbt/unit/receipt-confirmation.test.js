import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { harness, order, job } from '../../support/receipt-confirmation-client.mjs';

test('legacy direct PO search recovers the completed IR from the server without a journal or POST', async () => {
  const h = harness([{ order, job: job() }]);
  assert.equal(await h.context.restoreReceiptPosting?.(), true);
  assert.equal(h.context.currentModule, 'receiving-receipt');
  assert.equal(h.context.receiptResult.itemReceiptTranid, 'IR14813');
  assert.match(h.context.renderReceiptScreen(), /IR14813/u);
  assert.deepEqual(h.calls.map(call => call.method), ['GET']);
});

test('restoration uses the saved actual order type even when the receiving menu was Transfer Order', async () => {
  const h = harness([job()], { receiptRecovery: { orderId: order.netsuite_id, orderType: 'purchase_order', orderRef: order.tranid } });
  h.context.receivingOrderType = 'transfer_order';
  h.storage.set(h.context.receiptPostingJournalKey(order), JSON.stringify({ requestId: 'saved-request', jobId: 'saved-request', orderRef: order.tranid, status: 'posting', receiveBlocked: true }));
  assert.equal(await h.context.restoreReceiptPosting?.(), true);
  assert.ok(h.context.receiptOrder, 'The saved receipt must remain open');
  assert.equal(h.context.receiptOrder.order_type, 'purchase_order');
  assert.equal(h.context.receiptResult.itemReceiptTranid, 'IR14813');
  assert.equal(h.calls[0].url, '/api/operator/netsuite-posting-jobs/saved-request');
});

test('a new ordinary receiving view does not recover an already acknowledged receipt', async () => {
  const h = harness([], { receiptRecovery: null });
  assert.equal(await h.context.restoreReceiptPosting?.(), false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.context.receiptOrder, null);
});

test('an interrupted legacy lookup remains pending and later recovers the same IR', async () => {
  const h = harness([new TypeError('offline'), { order, job: job() }]);
  assert.equal(await h.context.restoreReceiptPosting?.(), true);
  assert.equal(h.context.currentModule, 'receiving-receipt');
  assert.equal(h.context.receiptResult, null);
  assert.equal(h.context.receiptOrder.posting.receiveBlocked, true);
  await h.context.refreshReceiptPostingStatus();
  assert.equal(h.context.receiptResult.itemReceiptTranid, 'IR14813');
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(call => call.method === 'GET'));
});

test('late legacy recovery cannot replace the order or screen opened by the operator', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness([() => pending]);
  const restoring = h.context.restoreReceiptPosting?.();
  for (let attempt = 0; attempt < 3 && !h.calls.length; attempt += 1) await Promise.resolve();
  assert.equal(h.calls.length, 1);
  h.context.receiptOrder = { ...order, netsuite_id: 'another' };
  h.context.receiptRequestId = 'another-request';
  h.context.currentModule = 'menu';
  release({ order, job: job() });
  await restoring;
  assert.equal(h.context.receiptResult, null);
  assert.equal(h.context.receiptRequestId, 'another-request');
  assert.equal(h.context.currentModule, 'menu');
});

test('legacy lookup with no job returns to ordinary receiving without a fabricated result', async () => {
  const h = harness([{ order, job: null }]);
  assert.equal(await h.context.restoreReceiptPosting?.(), true);
  assert.equal(h.context.currentModule, 'receiving');
  assert.equal(h.context.receiptOrder, null);
  assert.equal(h.context.receiptResult, null);
});

test('legacy recovery keeps a known IR visible while local verification is pending', async () => {
  const h = harness([{ order, job: job('attention') }]);
  assert.equal(await h.context.restoreReceiptPosting?.(), true);
  assert.equal(h.context.receiptResult, null);
  assert.match(h.context.renderReceiptScreen(), /IR14813/u);
  assert.match(h.context.renderReceiptScreen(), /verification.*review/iu);
});

test('legacy recovery does not display a failed job as successful', async () => {
  const h = harness([{ order, job: { ...job('failed'), steps: [], lastError: 'Rejected' } }]);
  assert.equal(await h.context.restoreReceiptPosting?.(), true);
  assert.equal(h.context.receiptResult, null);
  assert.notEqual(h.context.receiptOrder?.posting?.status, 'completed');
});

test('a known completed IR remains visible if the status GET fails after reopening', async () => {
  const h = harness([new TypeError('offline')]);
  h.context.receiptOrder = { ...order };
  h.context.receiptRequestId = 'saved-request';
  h.context.observeReceiptPostingJob(job());
  const saved = h.context.readReceiptPostingJournal(order);
  assert.equal(saved.transactions[0].ref, 'IR14813');
  await h.context.resumeReceiptPosting(order);
  assert.match(h.context.renderReceiptScreen(), /IR14813/u);
  assert.equal(h.context.receiptResult, null);
});

test('browser state storage failure cannot hide a confirmed IR', () => {
  const h = harness();
  h.context.receiptOrder = { ...order };
  h.context.receiptRequestId = 'saved-request';
  h.context.saveOperatorState = () => { throw new Error('Storage quota exceeded'); };
  assert.doesNotThrow(() => h.context.observeReceiptPostingJob(job()));
  assert.equal(h.context.receiptResult.itemReceiptTranid, 'IR14813');
  assert.match(h.context.renderReceiptScreen(), /IR14813/u);
});

test('automatic update waits for receipt acknowledgement and then reloads after state is cleared', async () => {
  const h = harness();
  h.context.currentModule = 'receiving-receipt';
  h.context.receiptOrder = { ...order };
  assert.equal(typeof h.context.requestOperatorServiceWorkerReload, 'function');
  h.context.requestOperatorServiceWorkerReload();
  assert.equal(h.reloads.length, 0);
  assert.equal(h.context.receiptServiceWorkerReloadPending, true);
  h.context.observeReceiptPostingJob({ ...job(), id: '' });
  await h.context.finishReceipt();
  assert.equal(h.context.receiptOrder, null);
  assert.equal(h.context.receivingSelectedId, null);
  assert.equal(h.reloads.length, 1);
});

test('automatic updates still reload an ordinary receiving list', () => {
  const h = harness();
  assert.equal(typeof h.context.requestOperatorServiceWorkerReload, 'function');
  h.context.requestOperatorServiceWorkerReload();
  assert.equal(h.reloads.length, 1);
});

test('a deferred update preserves local CO navigation to packed Transfer Orders', async () => {
  const h = harness();
  h.context.currentModule = 'receiving-receipt';
  h.context.receiptOrder = { ...order, order_type: 'co_order' };
  h.context.localStorage = h.context.window.localStorage;
  h.context.requestOperatorServiceWorkerReload();
  await h.context.finishReceipt();
  assert.equal(h.context.currentModule, 'delivery');
  assert.equal(h.context.deliveryOrderType, 'transfer_order');
  assert.equal(h.context.viewMode, 'packed');
  assert.equal(h.reloads.length, 1);
});

test('property: recovery across menu types and repeated lookup outages never submits or changes receipt identity', async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom('purchase_order', 'transfer_order', 'co_order'),
    fc.integer({ min: 0, max: 5 }), async (menuType, outages) => {
      const h = harness([...Array.from({ length: outages }, () => new TypeError('offline')), { order, job: job() }]);
      h.context.receivingOrderType = menuType;
      assert.equal(await h.context.restoreReceiptPosting?.(), true);
      for (let i = 0; i < outages; i += 1) await h.context.refreshReceiptPostingStatus();
      assert.equal(h.context.receiptResult.itemReceiptTranid, 'IR14813');
      assert.equal(h.context.receiptOrder.order_type, 'purchase_order');
      assert.equal(h.context.receiptOrder.netsuite_id, order.netsuite_id);
      assert.ok(h.calls.every(call => call.method === 'GET'));
    }), { seed: 1401278, numRuns: 40 });
});

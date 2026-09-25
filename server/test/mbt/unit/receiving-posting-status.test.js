import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { parse } from 'espree';
import fc from 'fast-check';

const filename = path.resolve('public/operator.js');
const source = fs.readFileSync(process.env.RECEIPT_STATUS_SOURCE || filename, 'utf8');
const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true });
// Execute the real browser functions, preserving source coordinates for coverage.
let cursor = 0;
let functions = '';
for (const node of tree.body.filter(node => node.type === 'FunctionDeclaration')) {
  functions += source.slice(cursor, node.start).replace(/[^\n]/gu, ' ') + source.slice(node.start, node.end);
  cursor = node.end;
}
functions += source.slice(cursor).replace(/[^\n]/gu, ' ');
const result = { receiptStatus: 'received', itemReceiptId: 1007837, itemReceiptTranid: 'IR14775',
  operatorNetSuitePosting: { transactions: [{ transactionType: 'IR', transactionRef: 'IR14775', transactionId: 1007837 }] } };
function job(status, ref = 'IR14775') {
  return { id: 'receipt-request', functionKey: 'receiving', status, lastError: 'Unexpected surcharge line',
    steps: [{ transactionType: 'IR', status: status === 'completed' ? 'posted' : 'uncertain',
      observedTransaction: { id: 1007837, tranId: ref } }],
    result: status === 'completed' ? { localFinalization: result } : {} };
}

function harness(responses = [], storage = new Map()) {
  const calls = [];
  const context = vm.createContext({ console, Date, Math, Set, Map, JSON, Promise,
    setTimeout: callback => { callback(); return 1; }, clearTimeout() {},
    operatorPostingPollWakeups: new Map(),
    window: { clearInterval() {}, clearTimeout() {}, setTimeout, setInterval: () => 1, localStorage: {
      getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)
    } },
    operator: { id: 'operator-a', display_name: 'Operator' }, locationId: 1,
    receiptOrder: { netsuite_id: 1002959, tranid: 'POB03903', order_type: 'purchase_order', lines: [] },
    receiptPhotoDataUrls: ['photo-one', 'photo-two'], receiptSubmitting: false, receiptResult: null,
    receiptStatusText: '', receiptJobStage: '', receiptStartedAt: 0, receiptProgressTimer: null,
    receiptRequestId: 'receipt-request', receiptNetSuitePolicy: { effective: true, gateKey: 'receiving', revision: 1 },
    receiptNetSuitePolicyError: '', receiptPostingRefresh: null, receiptServiceWorkerReloadPending: false, currentModule: 'receiving-receipt',
    receivingOrderType: 'purchase_order', receivingSelectedSourceId: null, receivingSelectedOrder: null,
    receiptCameraActive: false, receiptCameraStream: null, receiptActivePhotoSlot: 0, operatorPhotoCamera: {},
    app: { innerHTML: '' }, document: { querySelector: () => null }
  });
  vm.runInContext(functions, context, { filename });
  Object.assign(context, {
    api: async (url, options) => {
      calls.push({ url, method: options?.method || 'GET', body: options?.body });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (typeof response === 'function') return response();
      assert.ok(response, `Unexpected request ${url}`);
      return response;
    },
    loadOperatorNetSuitePostingPolicy: async () => ({ effective: true, gateKey: 'receiving', revision: 1 }),
    stopReceiptCamera() {}, selectRearCamera() {}, render() {}, showToast() {},
    prepareOperatorBackgroundPhotos: async () => ({ backgroundPhotos: [{ id: 'photo-one' }, { id: 'photo-two' }] }),
    resumeOperatorBackgroundPhotos() {}, createOperatorUuid: () => 'next-request',
    confirmMissingReceivingLines: async () => true,
    shell: (_title, _subtitle, body, actions = '') => body + actions,
    t: (_key, fallback) => fallback, tf: (_key, fallback) => fallback,
    localizeMessage: value => value, currentLocation: () => ({ text: 'Yard' }),
    escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    renderCameraSwitchButton: () => '', renderPhotoPreview: () => '',
    invalidateReceivingRequests() {}, saveOperatorState() {}, loadReceivingOrders: async () => {}
  });
  return { context, calls, storage };
}

test('known IR remains visible when receiving verification needs attention', async () => {
  const h = harness([{ status: 'running', posting: true, jobId: 'receipt-request' }, job('attention')]);
  await h.context.confirmReceipt();
  assert.notEqual(h.context.receiptJobStage, 'Receiving failed');
  assert.equal(h.context.receiptResult, null);
  const html = h.context.renderReceiptScreen();
  assert.match(html, /IR14775/u);
  assert.match(html, /NetSuite receipt created/u);
  assert.match(html, /verification.*review/iu);
  assert.doesNotMatch(html, /data-action="confirm-receive"/u);
  assert.match(html, /data-action="refresh-receipt-posting"/u);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
});

test('lost admission response recovers the completed IR by request ID without reposting', async () => {
  const h = harness([new TypeError('Failed to fetch'), job('completed')]);
  await h.context.confirmReceipt();
  assert.equal(h.context.receiptResult?.itemReceiptTranid, 'IR14775');
  assert.equal(h.context.receiptStatusText, '');
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(h.calls[1]?.url, '/api/operator/netsuite-posting-jobs/receipt-request');
});

test('polling outage retains the same job and a repeated Receive checks status only', async () => {
  const h = harness([{ status: 'running', posting: true, jobId: 'receipt-request' },
    new TypeError('Failed to fetch'), new TypeError('Still offline'), job('completed')]);
  await h.context.confirmReceipt();
  assert.notEqual(h.context.receiptJobStage, 'Receiving failed');
  await h.context.confirmReceipt();
  assert.equal(h.context.receiptResult?.itemReceiptTranid, 'IR14775');
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
});

test('completed receiving cannot submit a second receipt', async () => {
  const h = harness([{ status: 'complete', result }, { status: 'complete', result }]);
  await h.context.confirmReceipt();
  await h.context.confirmReceipt();
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
});

test('successful receipt copy uses recorded evidence when the current gate is off', async () => {
  const h = harness();
  h.context.receiptResult = result;
  h.context.receiptNetSuitePolicy = { effective: false };
  assert.match(h.context.renderReceiptScreen(), /Receiving posted to NetSuite and verified/u);
  assert.doesNotMatch(h.context.renderReceiptScreen(), /No NetSuite Item Receipt was created/u);
});

test('authoritative rejected admission still reports failure and does not look for an IR', async () => {
  const h = harness([Object.assign(new Error('No confirmed quantities'), { status: 400 })]);
  await h.context.confirmReceipt();
  assert.equal(h.context.receiptJobStage, 'Receiving failed');
  assert.equal(h.context.receiptStatusText, 'No confirmed quantities');
  assert.equal(h.context.receiptResult, null);
  assert.equal(h.calls.length, 1);
});

test('definitively failed job remains failed without fabricated completion', async () => {
  const failed = { ...job('failed'), steps: [], lastError: 'NetSuite rejected this receipt' };
  const h = harness([{ status: 'running', posting: true, jobId: 'receipt-request' }, failed]);
  await h.context.confirmReceipt();
  assert.equal(h.context.receiptJobStage, 'Receiving failed');
  assert.equal(h.context.receiptStatusText, failed.lastError);
  assert.equal(h.context.receiptResult, null);
});

test('local-only receipts retain the existing submission and do not create a journal', async () => {
  const h = harness([{ status: 'complete', result: { receiptStatus: 'received' } }]);
  h.context.loadOperatorNetSuitePostingPolicy = async () => ({ effective: false, gateKey: 'receiving', revision: 1 });
  await h.context.confirmReceipt();
  assert.equal(h.context.receiptResult?.receiptStatus, 'received');
  assert.equal(h.calls.length, 1);
  assert.equal(h.storage.size, 0);
});

test('reopening restores the pending receipt and then shows its completed IR', async () => {
  const original = harness([{ status: 'running', posting: true, jobId: 'receipt-request' }, job('attention')]);
  await original.context.confirmReceipt();
  assert.ok(original.storage.size > 0);
  const reloaded = harness([job('completed')], original.storage);
  reloaded.context.receivingSelectedOrder = reloaded.context.receiptOrder;
  reloaded.context.confirmMissingReceivingLines = async () => { throw new Error('Recovery must not reconfirm quantities'); };
  await reloaded.context.startReceipt();
  assert.equal(reloaded.context.receiptRequestId, 'receipt-request');
  assert.equal(reloaded.context.receiptResult?.itemReceiptTranid, 'IR14775');
  assert.equal(reloaded.calls.filter(call => call.method === 'POST').length, 0);
  await reloaded.context.finishReceipt();
  assert.equal(reloaded.storage.size, 0);
});

test('concurrent status checks coalesce and late responses cannot replace another order', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness([{ status: 'running', posting: true, jobId: 'receipt-request' }, job('attention'), () => pending]);
  await h.context.confirmReceipt();
  const first = h.context.refreshReceiptPostingStatus?.();
  const second = h.context.refreshReceiptPostingStatus?.();
  assert.equal(h.calls.filter(call => call.method === 'GET').length, 2);
  h.context.receiptOrder = { netsuite_id: 998205, order_type: 'purchase_order' };
  h.context.receiptRequestId = 'different-request';
  release(job('completed'));
  await Promise.all([first, second]);
  assert.equal(h.context.receiptResult, null);
  assert.equal(h.context.receiptRequestId, 'different-request');
});

test('property: any number of attention recoveries preserves the IR and submits once', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 12 }), async count => {
    const h = harness([{ status: 'running', posting: true, jobId: 'receipt-request' },
      ...Array.from({ length: count }, () => job('attention')), job('completed')]);
    await h.context.confirmReceipt();
    for (let index = 1; index < count; index += 1) {
      await h.context.confirmReceipt();
      assert.equal(h.context.receiptResult, null);
      assert.match(h.context.renderReceiptScreen(), /IR14775/u);
    }
    await h.context.confirmReceipt();
    assert.equal(h.context.receiptResult?.itemReceiptTranid, 'IR14775');
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  }), { seed: 14775, numRuns: 20 });
});

test('a polling authorization error retains the admitted job for recovery', async () => {
  const unauthorized = Object.assign(new Error('Session expired'), { status: 401 });
  const h = harness([{ status: 'running', posting: true, jobId: 'receipt-request' }, unauthorized, unauthorized, job('completed')]);
  await h.context.confirmReceipt();
  assert.equal(h.context.receiptOrder.posting?.receiveBlocked, true);
  await h.context.confirmReceipt();
  assert.equal(h.context.receiptResult?.itemReceiptTranid, 'IR14775');
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
});

test('receipt references are escaped while an existing verified IR awaits local finalization', async () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const pending = { ...job('attention'), steps: [{ transactionType: 'IR', status: 'posted', transactionId: 1007837, transactionRef: malicious }] };
  const h = harness([{ status: 'running', posting: true, jobId: 'receipt-request' }, pending]);
  await h.context.confirmReceipt();
  assert.match(h.context.renderReceiptScreen(), /&lt;img/u);
  assert.doesNotMatch(h.context.renderReceiptScreen(), /<img src=x/u);
  assert.equal(h.context.receiptResult, null);
});

test('receipt journals isolate accounts and orders and tolerate invalid or unavailable storage', async () => {
  const h = harness([{ status: 'running', posting: true, jobId: 'receipt-request' }, job('attention')]);
  await h.context.confirmReceipt();
  const current = h.context.receiptOrder;
  assert.equal(h.context.readReceiptPostingJournal?.({ ...current, netsuite_id: 998205 }), null);
  h.context.operator = { id: 'operator-b' };
  assert.equal(h.context.readReceiptPostingJournal?.(current), null);
  h.storage.set(h.context.receiptPostingJournalKey(current), '{broken');
  assert.equal(h.context.readReceiptPostingJournal(current), null);
  h.context.window.localStorage.getItem = () => { throw new Error('Denied'); };
  assert.equal(h.context.readReceiptPostingJournal(current), null);
  h.context.window.localStorage.setItem = () => { throw new Error('Quota'); };
  h.context.rememberReceiptPosting({ jobId: 'receipt-request', receiveBlocked: true });
  assert.equal(h.context.receiptOrder.posting.receiveBlocked, true);
});

test('an unrelated job cannot finalize the selected receipt', async () => {
  const h = harness([{ status: 'running', posting: true, jobId: 'receipt-request' }, job('attention')]);
  await h.context.confirmReceipt();
  h.context.observeReceiptPostingJob?.({ ...job('completed'), id: 'unrelated' });
  h.context.observeReceiptPostingJob?.({ ...job('completed'), functionKey: 'customer_pickup' });
  assert.equal(h.context.receiptResult, null);
  assert.equal(h.context.receiptOrder.posting?.receiveBlocked, true);
});

for (const stage of ['admission', 'polling']) {
  test(`leaving receiving during ${stage} cannot put the old receipt on another order`, async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const h = harness(stage === 'admission' ? [() => pending]
      : [{ status: 'running', posting: true, jobId: 'receipt-request' }, () => pending]);
    const submission = h.context.confirmReceipt();
    while (h.calls.length < (stage === 'admission' ? 1 : 2)) await new Promise(resolve => setImmediate(resolve));
    h.context.receiptOrder = { netsuite_id: 998205, order_type: 'purchase_order' };
    h.context.receiptRequestId = 'different-request';
    h.context.receiptStatusText = 'New order';
    h.context.receiptSubmitting = true;
    release(stage === 'admission' ? { status: 'complete', result } : job('completed'));
    await submission;
    assert.equal(h.context.receiptResult, null);
    assert.equal(h.context.receiptStatusText, 'New order');
    assert.equal(h.context.receiptSubmitting, true);
  });
}

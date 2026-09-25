import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { normalizePurchaseOrderWeightLines } from '../../../src/purchase-order-weight-refresh.js';
import { createDelayedStatusRefreshWorker } from '../../../src/netsuite-delayed-status-refresh-service.js';

const lines = [{ line_id: '4725001', item_id: '5169', item_weight: '36.6459', quantity: 6038.4 }];
const job = { jobId: 71, netsuiteOrderId: 936958, tranid: 'POB03658', orderType: 'purchase_order',
  attemptNumber: 1, leaseToken: 'po-weight-test-lease' }; // secret-scan: allow deterministic lease fixture

function harness(overrides = {}) {
  const calls = [];
  const worker = createDelayedStatusRefreshWorker({
    claimJobs: async () => [], lockLease: async () => true, renewLease: async () => true,
    finishAttempt: async value => { calls.push(['finish', value]); return true; },
    fetchTransactionStatus: async () => ({ status: 'B', status_text: 'Purchase Order : Pending Receipt' }),
    fetchSalesOrderLines: async () => [], applySalesOrderLines: async () => {},
    fetchPurchaseOrderLines: async id => { calls.push(['read', id]); return lines; },
    applyPurchaseOrderWeights: async value => calls.push(['weights', value]),
    applyStatus: async () => calls.push(['status']), withTransaction: async operation => operation(),
    writeAudit: async () => {}, emitEvents: () => calls.push(['event']),
    logger: { error() {} }, ...overrides
  });
  return { worker, calls };
}

test('PO weights: normalize fresh decimals and explicit zero/unavailable weights', () => {
  assert.deepEqual(normalizePurchaseOrderWeightLines(lines), [{ line_id: 4725001, item_id: 5169, item_weight: 36.6459 }]);
  for (const value of [0, '0', null, '', undefined]) {
    const result = normalizePurchaseOrderWeightLines([{ ...lines[0], item_weight: value }]);
    assert.equal(result[0].item_weight, value === 0 || value === '0' ? 0 : null);
  }
  assert.deepEqual(normalizePurchaseOrderWeightLines([]), []);
});

test('PO weights: reject ambiguous identities and invalid weights before writes', () => {
  assert.throws(() => normalizePurchaseOrderWeightLines([lines[0], lines[0]]), /duplicate/i);
  assert.throws(() => normalizePurchaseOrderWeightLines(null), /array/i);
  for (const value of [-1, Infinity, NaN, 'bad']) {
    assert.throws(() => normalizePurchaseOrderWeightLines([{ ...lines[0], item_weight: value }]), /weight/i);
  }
  for (const field of ['line_id', 'item_id']) {
    for (const value of [0, -1, 1.5, 'bad', Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => normalizePurchaseOrderWeightLines([{ ...lines[0], [field]: value }]), /identity/i);
    }
  }
});

test('PO weights: delayed PO check reads current source and commits metadata before acknowledging', async () => {
  const { worker, calls } = harness();
  assert.equal((await worker.processJob(job)).outcome, 'succeeded');
  assert.deepEqual(calls.map(call => call[0]), ['read', 'status', 'weights', 'finish', 'event']);
  assert.deepEqual(calls[2][1], { netsuiteOrderId: 936958, lines });
});

test('PO weights: failed source read retries without a local weight/status write or event', async () => {
  const { worker, calls } = harness({ fetchPurchaseOrderLines: async () => { throw new Error('weight read unavailable'); } });
  assert.equal((await worker.processJob(job)).outcome, 'retry');
  assert.deepEqual(calls.map(call => call[0]), ['finish']);
  assert.match(calls[0][1].error, /weight read unavailable/);
  assert.equal((await worker.processJob({ ...job, attemptNumber: 8 })).outcome, 'failed');
});

test('PO weights: fenced lease cannot apply a fresh weight', async () => {
  const { worker, calls } = harness({ lockLease: async () => false });
  assert.equal((await worker.processJob(job)).outcome, 'stale');
  assert.deepEqual(calls.map(call => call[0]), ['read']);
});

test('PO weights: write failure remains retryable and never emits a success event', async () => {
  const { worker, calls } = harness({ applyPurchaseOrderWeights: async () => { throw new Error('weight write unavailable'); } });
  assert.equal((await worker.processJob(job)).outcome, 'retry');
  assert.equal(calls.filter(call => call[0] === 'event').length, 0);
  assert.match(calls.find(call => call[0] === 'finish')[1].error, /weight write unavailable/);
});

test('PO weights: SO/TO jobs never read or apply purchase weights; empty PO reads are harmless', async () => {
  for (const orderType of ['sales_order', 'transfer_order']) {
    const { worker, calls } = harness();
    await worker.processJob({ ...job, orderType });
    assert.equal(calls.some(call => ['read', 'weights'].includes(call[0])), false);
  }
  const { worker, calls } = harness({ fetchPurchaseOrderLines: async () => [] });
  assert.equal((await worker.processJob(job)).outcome, 'succeeded');
  assert.equal(calls.some(call => call[0] === 'weights'), false);
});

test('PO weights: production worker wires the fresh reader and metadata writer', () => {
  const server = readFileSync(new URL('../../../src/server.js', import.meta.url), 'utf8');
  const start = server.indexOf('const delayedStatusRefreshWorker = createDelayedStatusRefreshWorker(');
  const end = server.indexOf('export async function delayedStatusRefreshTick', start);
  const wiring = server.slice(start, end);
  assert.match(wiring, /fetchPurchaseOrderLines: fetchPurchaseOrderDetailsFromNetSuite/);
  assert.match(wiring, /applyPurchaseOrderWeights: applyPurchaseOrderItemWeights/);
});

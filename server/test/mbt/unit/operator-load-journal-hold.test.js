import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { parse } from 'espree';

// SOA10852: the browser lost the first Load's response while the server was still
// checking NetSuite. "Check status" (or reopening the order) got a 404 for the
// job, unblocked the order, and the same Load was submitted again.
const source = readFileSync('public/operator.js', 'utf8');
const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true });
/** @param {string} name */
function declaration(name) {
  const node = tree.body.find(item => (item.type === 'FunctionDeclaration' && item.id?.name === name)
    || (item.type === 'VariableDeclaration' && item.declarations.some(entry => entry.id.type === 'Identifier' && entry.id.name === name)));
  assert.ok(node, `${name} is declared at the top level of operator.js`);
  return source.slice(node.range[0], node.range[1]);
}
const code = ['LOAD_SUBMIT_JOURNAL_HOLD_MS', 'recentLoadSubmitHold', 'postingSummaryFromJob', 'resumePreviousLoadJournal',
  'refreshLoadPostingStatus'].map(declaration).join('\n');
const NOW = 1_800_000_000_000;
const REQUEST_ID = 'd9071ed9-bc51-41e0-a565-2b4f77033d57';
const notFound = () => Object.assign(new Error('Operator record not found.'), { status: 404 });
const submitting = (/** @type {number} */ ageMs) => ({ requestId: REQUEST_ID, status: 'submitting', loadBlocked: true, submittedAt: NOW - ageMs });

/** @param {{journal: any, job?: any, globals?: Record<string, any>}} options */
function harness({ journal, job = notFound(), globals = {} }) {
  const removed = [];
  const context = vm.createContext({
    Date: { now: () => NOW }, encodeURIComponent, t: (_key, fallback) => fallback,
    loadPostingJournal: () => journal, loadPostingJournalKey: () => 'journal-key',
    window: { localStorage: { removeItem: key => removed.push(key) } },
    api: async (/** @type {string} */ path) => {
      if (path.startsWith('/api/delivery/orders/')) {return { netsuite_id: 1090414, order_type: 'sales_order', lines: [] };}
      if (job instanceof Error) {throw job;}
      return job;
    },
    render: () => {}, rememberFulfillmentPosting: () => {}, hasDraftPackedQty: () => true,
    finishFulfillment: () => { context.finished = true; },
    ...globals
  });
  vm.runInContext(code, context);
  return { context, removed };
}

/** @param {{journal: any, job?: any}} options */
async function resume(options) {
  const { context, removed } = harness(options);
  const order = { netsuite_id: 1090414, order_type: 'sales_order' };
  await context.resumePreviousLoadJournal(order);
  return { order, removed };
}

/** @param {{journal: any, job?: any}} options */
async function checkStatus(options) {
  const fulfillmentOrder = { netsuite_id: 1090414, order_type: 'sales_order', loadConfirmationAcknowledged: 'ack',
    posting: { status: 'submitting', loadBlocked: true } };
  const { context } = harness({ ...options, globals: { fulfillmentOrder, selectedOrder: null,
    fulfillmentLoadRequestId: REQUEST_ID, fulfillmentResult: null } });
  await context.refreshLoadPostingStatus();
  return context.fulfillmentOrder;
}

test('reopening: a recent Load submit with no job yet keeps the order held', async () => {
  const { order } = await resume({ journal: submitting(60_000) });
  assert.equal(order.posting?.loadBlocked, true);
  assert.equal(order.posting?.status, 'submitting');
  assert.match(order.posting?.reason, /still being processed/u);
});

test('reopening: an old, undated or non-submitting journal with no job does not hold the order', async () => {
  assert.equal((await resume({ journal: submitting(3 * 60 * 1000 + 1) })).order.posting, undefined);
  assert.equal((await resume({ journal: { requestId: REQUEST_ID, status: 'submitting', loadBlocked: true } })).order.posting, undefined);
  assert.equal((await resume({ journal: submitting(-60_000) })).order.posting, undefined);
  assert.equal((await resume({ journal: { ...submitting(1000), status: 'posting' } })).order.posting, undefined);
});

test('reopening: a found job still decides the order state', async () => {
  const running = await resume({ journal: submitting(1000), job: { id: 'job-1', status: 'running', steps: [] } });
  assert.equal(running.order.posting.jobId, 'job-1');
  assert.equal(running.order.posting.loadBlocked, true);
  const completed = await resume({ journal: submitting(1000), job: { id: 'job-1', status: 'completed', steps: [] } });
  assert.equal(completed.order.posting, undefined);
  assert.deepEqual(completed.removed, ['journal-key']);
});

test('Check status: a recent unanswered Load stays held while its job is not found yet', async () => {
  const order = await checkStatus({ journal: submitting(12_000) });
  assert.equal(order.posting?.loadBlocked, true);
  assert.equal(order.loadConfirmationAcknowledged, 'ack');
});

test('Check status: an old unanswered Load is released', async () => {
  const order = await checkStatus({ journal: submitting(3 * 60 * 1000 + 1) });
  assert.equal(order.posting, undefined);
});

test('Check status: a found job replaces the hold', async () => {
  const order = await checkStatus({ journal: submitting(12_000), job: { id: REQUEST_ID, status: 'running', steps: [] } });
  assert.equal(order.posting.jobId, REQUEST_ID);
  assert.equal(order.posting.loadBlocked, true);
});

test('a Load submit records when it was sent', () => {
  assert.match(source, /rememberFulfillmentPosting\(\{ status: "submitting", loadBlocked: true, submittedAt: Date\.now\(\) \}\);/u);
});

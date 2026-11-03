// @ts-check
// SOA10852 (2026-11-03): a repeated Customer Pickup Load with the same request ID
// waited for the order lock, then re-ran NetSuite validation while holding it.
// Finalization of the first submit had already locked the command row and was
// waiting for that same order lock, so Postgres aborted the repeat with 40P01.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after } from 'node:test';
import { closeDb, query, withTransaction } from '../../../src/db.js';
import { createOperator } from '../../../src/auth-repository.js';
import { getDeliveryOrder, recordCustomerPickupLoad } from '../../../src/delivery-repository.js';
import * as locks from '../../../src/consolidation-load-locks.js';
import { createOperatorNetSuitePostingRealSourceResolver, createOperatorNetSuitePostingTargetResolver } from '../../../src/operator-netsuite-posting-targets.js';
import { createPickupExistingFulfillmentReader } from '../../../src/operator-pickup-existing-if-source.js';
import { createOperatorNetSuitePostingAdmission } from '../../../src/operator-netsuite-posting-admission.js';
import { createOperatorNetSuitePostingProcessor } from '../../../src/operator-netsuite-posting-service.js';
import * as finalizer from '../../../src/operator-netsuite-posting-finalizer.js';
import * as controller from '../../../src/operator-netsuite-posting-controller.js';
import * as repo from '../../../src/operator-netsuite-posting-repository.js';
import { pickupEvidence } from '../../support/pickup-existing-if-fixture.mjs';

after(closeDb);

const ORDER_ID = 963502;
const repository = { get: repo.getOperatorNetSuitePostingCommand, claim: repo.claimOperatorNetSuitePostingCommand,
  renew: repo.renewOperatorNetSuitePostingLease, startAttempt: repo.startOperatorNetSuitePostingAttempt,
  success: repo.recordOperatorNetSuitePostingStepSuccess, failure: repo.recordOperatorNetSuitePostingStepFailure,
  attention: repo.markOperatorNetSuitePostingCommandAttention, fail: repo.failOperatorNetSuitePostingCommand,
  complete: repo.completeOperatorNetSuitePostingCommand };
const policy = { gateKey: 'operator_netsuite_customer_pickup_if_3445', revision: 1, effective: true,
  functionKey: 'customer_pickup', transactionType: 'IF', locationId: 1, yardCode: '3445' };
const photos = ['r2://pickup-test/one.jpg', 'r2://pickup-test/two.jpg'];
const readOrder = () => getDeliveryOrder(ORDER_ID, { includeNetSuiteClosed: true });

function deferred() {
  /** @type {(value?: unknown) => void} */ let resolve = () => {};
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

/** @param {() => Promise<boolean>} condition */
async function waitFor(condition, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!await condition()) {
    if (Date.now() > deadline) {throw new Error('Timed out waiting for the expected lock state.');}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

const advisoryWaiters = async () => Number((await query(
  "SELECT count(*)::integer AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rows[0].count);

/** @param {(context: Record<string, any>) => Promise<void>} run */
async function fixture(run) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const actor = await createOperator({ username: `load-duplicate-${crypto.randomUUID()}`, displayName: 'Load duplicate test',
    password: 'test-only', role: 'operator', yardLocationIds: [1] });
  const e = pickupEvidence({ confirmed: 109 });
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,outbound_location_id,netsuite_active,sales_order_type,
    operator_status,status,status_text) VALUES($1,'SOA07444',1,true,'Pick-Up','packed','B','Sales Order : Pending Fulfillment')`, [ORDER_ID]);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_type,quantity,unit,location_id,
    netsuite_active,packed_sales_qty,loaded_qty) VALUES($1,4828215,2875,'InvtPart',109,'SQFT',1,true,109,0)`, [ORDER_ID]);
  /** @type {{calls: number, gate: null | {entered: ReturnType<typeof deferred>, release: ReturnType<typeof deferred>}}} */
  const remote = { calls: 0, gate: null };
  const reader = createPickupExistingFulfillmentReader({
    fetchStatuses: async () => { remote.calls++; return [{ id: ORDER_ID, tranid: 'SOA07444', status_text: 'Sales Order : Billed' }]; },
    fetchSourceItems: async () => { remote.calls++; return e.sourceItems; },
    // The slow linked-transaction SuiteQL from the incident; a gate holds it open.
    fetchLinkedTransactions: async () => {
      remote.calls++;
      const gate = remote.gate;
      if (gate) { gate.entered.resolve(); await gate.release.promise; }
      return e.links;
    },
    fetchFulfillment: async (/** @type {number} */ id) => { remote.calls++; return e.records.find(r => Number(r.id) === id); }
  });
  const resolveTargets = createOperatorNetSuitePostingTargetResolver({ getDeliveryOrder, getReceivableReceivingOrder: async () => null,
    resolveRealSource: createOperatorNetSuitePostingRealSourceResolver({ query, useStoredOrderLines: true, fetchPickupSource: reader }) });
  const admit = createOperatorNetSuitePostingAdmission({ resolveTargets, getPolicy: async () => policy,
    createCommand: repo.createOrReplayOperatorNetSuitePostingCommand, onAccepted: async () => {},
    preflight: (/** @type {any} */ input, /** @type {any} */ resolution) => withTransaction(() => recordCustomerPickupLoad(ORDER_ID,
      input.actorOperatorId, { photoDataUrls: input.photoRefs, allowNetSuiteCompleted: resolution.allowNetSuiteCompleted }), { rollback: true }) });
  const input = (/** @type {Record<string, any>} */ overrides = {}) => ({ functionKey: 'customer_pickup', orderId: ORDER_ID,
    orderType: 'sales_order', clientLocationId: 1, expectedPolicy: policy, actorOperatorId: actor.id,
    requestId: crypto.randomUUID(), photoRefs: photos, ...overrides });
  const adapter = Object.fromEntries(['findByExternalId', 'verify', 'transform', 'fetchById'].map(name => [name, async () => {
    assert.fail(`Zero-step reconciliation called ${name}`);
  }]));
  const processor = () => createOperatorNetSuitePostingProcessor({ repository, adapter,
    finalize: finalizer.finalizeOperatorNetSuitePosting, workerId: crypto.randomUUID(),
    lockFinalization: finalizer.lockOperatorNetSuitePostingFinalization });
  const submission = (/** @type {Record<string, any>} */ options = {}) => controller.createOperatorNetSuitePostingSubmission({
    admit, findReplay: repo.findReplayableOperatorNetSuitePostingCommand, readDeliveryOrder: getDeliveryOrder, ...options });
  const loadRecords = async () => Number((await query('SELECT count(*)::integer AS count FROM operator_load_records WHERE order_id=$1',
    [String(ORDER_ID)])).rows[0].count);
  try { await run({ actor, admit, input, processor, remote, submission, loadRecords }); }
  finally {
    if (remote.gate) {remote.gate.release.resolve();}
    await query('DELETE FROM operator_netsuite_posting_commands WHERE actor_operator_id=$1', [actor.id]);
    await query('DELETE FROM operator_load_records WHERE order_id=$1', [String(ORDER_ID)]);
    await query('DELETE FROM sales_order_lines WHERE sales_order_id=$1', [ORDER_ID]);
    await query('DELETE FROM sales_orders WHERE netsuite_id=$1', [ORDER_ID]);
  }
}

test('SOA10852: finalizing the first Load does not deadlock with a repeat that holds the order lock', async () => {
  await fixture(async ({ admit, input, processor, remote, loadRecords }) => {
    const request = input();
    const first = await locks.withConsolidatedLoadMutation(readOrder, () => admit(request));
    assert.equal(first.command.steps.length, 0);
    // The repeat reaches NetSuite validation while holding the order lock (the incident's submit path).
    remote.gate = { entered: deferred(), release: deferred() };
    const repeat = locks.withConsolidatedLoadMutation(readOrder, () => admit(request));
    await remote.gate.entered.promise;
    const finalizing = processor().process(first.command.id);
    await waitFor(async () => await advisoryWaiters() > 0);
    remote.gate.release.resolve();
    const [repeated, finalized] = await Promise.allSettled([repeat, finalizing]);
    assert.equal(repeated.status, 'fulfilled', repeated.status === 'rejected' ? String(repeated.reason?.message) : '');
    assert.equal(repeated.value.replayed, true);
    assert.equal(finalized.status, 'fulfilled');
    assert.equal(finalized.value.status, 'completed', finalized.value.lastError);
    assert.equal(await loadRecords(), 1);
    assert.equal(Number((await getDeliveryOrder(ORDER_ID)).lines[0].loaded_qty), 109);
  });
});

test('a repeated Load with the same request ID replays the job without new NetSuite calls', async () => {
  await fixture(async ({ input, processor, remote, submission, loadRecords }) => {
    const submit = submission();
    const request = input();
    const first = await submit(request);
    assert.equal(first.mode, 'netsuite');
    assert.equal(first.replayed, false);
    const callsAfterFirst = remote.calls;
    assert.ok(callsAfterFirst > 0);
    const repeat = await submit(request);
    assert.equal(repeat.mode, 'netsuite');
    assert.equal(repeat.replayed, true);
    assert.equal(repeat.command.id, first.command.id);
    assert.equal(remote.calls, callsAfterFirst);
    const done = await processor().process(first.command.id);
    assert.equal(done.status, 'completed', done.lastError);
    const afterCompletion = await submit(request);
    assert.equal(afterCompletion.replayed, true);
    assert.equal(afterCompletion.command.status, 'completed');
    assert.equal(remote.calls, callsAfterFirst);
    assert.equal(await loadRecords(), 1);
  });
});

test('a repeat with different photos is not replayed and still fails as an idempotency conflict', async () => {
  await fixture(async ({ input, remote, submission }) => {
    const submit = submission();
    const request = input();
    await submit(request);
    const callsAfterFirst = remote.calls;
    await assert.rejects(submit({ ...request, photoRefs: ['r2://pickup-test/other.jpg'] }),
      { code: 'OPERATOR_NETSUITE_POSTING_IDEMPOTENCY_CONFLICT' });
    assert.ok(remote.calls > callsAfterFirst, 'a non-matching repeat must go through full admission');
  });
});

test('a repeat while the first Load still holds the order fails fast as in progress', async () => {
  await fixture(async ({ input, remote, submission }) => {
    const submit = submission({ lockTimeoutMs: 200 });
    const request = input();
    remote.gate = { entered: deferred(), release: deferred() };
    const first = submit(request);
    await remote.gate.entered.promise;
    const started = Date.now();
    await assert.rejects(submit(request), { code: 'OPERATOR_NETSUITE_POSTING_IN_PROGRESS', status: 409 });
    assert.ok(Date.now() - started < 3000, 'the repeat must not wait for NetSuite validation to finish');
    remote.gate.release.resolve();
    const accepted = await first;
    assert.equal(accepted.replayed, false);
    const callsAfterFirst = remote.calls;
    const repeat = await submit(request);
    assert.equal(repeat.replayed, true);
    assert.equal(remote.calls, callsAfterFirst);
  });
});

test('the Load lock timeout applies only while acquiring the order lock', async () => {
  await withTransaction(async () => {
    const before = (await query('SHOW lock_timeout')).rows[0].lock_timeout;
    await locks.lockConsolidatedLoadOrders(['lock-timeout-probe'], { lockTimeoutMs: 250 });
    assert.equal((await query('SHOW lock_timeout')).rows[0].lock_timeout, before);
  }, { rollback: true });
});

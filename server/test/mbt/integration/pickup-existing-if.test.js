import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after } from 'node:test';
import { query, withTransaction, closeDb } from '../../../src/db.js';
import { createOperator } from '../../../src/auth-repository.js';
import { getDeliveryOrder, recordCustomerPickupLoad } from '../../../src/delivery-repository.js';
import { createOperatorNetSuitePostingRealSourceResolver, createOperatorNetSuitePostingTargetResolver } from '../../../src/operator-netsuite-posting-targets.js';
import { createPickupExistingFulfillmentReader } from '../../../src/operator-pickup-existing-if-source.js';
import { createOperatorNetSuitePostingAdmission } from '../../../src/operator-netsuite-posting-admission.js';
import { createOperatorNetSuitePostingProcessor } from '../../../src/operator-netsuite-posting-service.js';
import { finalizeOperatorNetSuitePosting } from '../../../src/operator-netsuite-posting-finalizer.js';
import * as repo from '../../../src/operator-netsuite-posting-repository.js';
import { pickupEvidence } from '../../support/pickup-existing-if-fixture.mjs';

after(closeDb);
const repository = { get: repo.getOperatorNetSuitePostingCommand, claim: repo.claimOperatorNetSuitePostingCommand,
  renew: repo.renewOperatorNetSuitePostingLease, startAttempt: repo.startOperatorNetSuitePostingAttempt,
  success: repo.recordOperatorNetSuitePostingStepSuccess, failure: repo.recordOperatorNetSuitePostingStepFailure,
  attention: repo.markOperatorNetSuitePostingCommandAttention, fail: repo.failOperatorNetSuitePostingCommand,
  complete: repo.completeOperatorNetSuitePostingCommand };
const policy = { gateKey: 'operator_netsuite_customer_pickup_if_3445', revision: 1, effective: true,
  functionKey: 'customer_pickup', transactionType: 'IF', locationId: 1, yardCode: '3445' };
const photos = ['r2://pickup-test/one.jpg', 'r2://pickup-test/two.jpg'];

async function fixture(run, { confirmed = 109 } = {}) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const actor = await createOperator({ username: `pickup-if-${crypto.randomUUID()}`, displayName: 'Pickup existing IF test',
    password: 'test-only', role: 'operator', yardLocationIds: [1] });
  const e = pickupEvidence({ confirmed });
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,outbound_location_id,netsuite_active,sales_order_type,
    operator_status,status,status_text) VALUES(963502,'SOA07444',1,true,'Pick-Up','packed','B','Sales Order : Pending Fulfillment')`);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_type,quantity,unit,location_id,
    netsuite_active,packed_sales_qty,loaded_qty) VALUES(963502,4828215,2875,'InvtPart',109,'SQFT',1,true,$1,0)`, [confirmed]);
  const remote = createPickupExistingFulfillmentReader({
    fetchStatuses: async () => [{ id: 963502, tranid: 'SOA07444', status_text: 'Sales Order : Billed' }],
    fetchSourceItems: async () => e.sourceItems, fetchLinkedTransactions: async () => e.links,
    fetchFulfillment: async id => e.records.find(r => Number(r.id) === id)
  });
  const resolveTargets = createOperatorNetSuitePostingTargetResolver({ getDeliveryOrder, getReceivableReceivingOrder: async () => null,
    resolveRealSource: createOperatorNetSuitePostingRealSourceResolver({ query, useStoredOrderLines: true, fetchPickupSource: remote }) });
  const admit = createOperatorNetSuitePostingAdmission({ resolveTargets, getPolicy: async () => policy,
    createCommand: repo.createOrReplayOperatorNetSuitePostingCommand, onAccepted: async () => {},
    preflight: (input, resolution) => withTransaction(() => recordCustomerPickupLoad(963502, input.actorOperatorId,
      { photoDataUrls: input.photoRefs, allowNetSuiteCompleted: resolution.allowNetSuiteCompleted }), { rollback: true }) });
  const input = requestId => ({ functionKey: 'customer_pickup', orderId: 963502, clientLocationId: 1,
    expectedPolicy: policy, actorOperatorId: actor.id, requestId: requestId || crypto.randomUUID(), photoRefs: photos });
  let remoteMutations = 0;
  const adapter = Object.fromEntries(['findByExternalId', 'verify', 'transform', 'fetchById'].map(name => [name, async () => {
    remoteMutations++; assert.fail(`Zero-step reconciliation called ${name}`);
  }]));
  const processor = (finalize = finalizeOperatorNetSuitePosting, workerId = crypto.randomUUID()) =>
    createOperatorNetSuitePostingProcessor({ repository, adapter, finalize, workerId });
  try { return await run({ actor, e, admit, input, processor, remoteMutations: () => remoteMutations }); }
  finally {
    await query('DELETE FROM operator_netsuite_posting_commands WHERE actor_operator_id=$1', [actor.id]);
    await query('DELETE FROM operator_load_records WHERE order_id=963502');
    await query('DELETE FROM sales_order_lines WHERE sales_order_id=963502');
    await query('DELETE FROM sales_orders WHERE netsuite_id=963502');
  }
}

test('real pickup admission and finalization reuse IF151113 once with no new NetSuite transaction', async () => {
  await fixture(async ({ admit, input, processor, remoteMutations }) => {
    const accepted = await admit(input());
    assert.equal(accepted.command.steps.length, 0);
    assert.ok(accepted.command.activeClaims.includes('source:IF:SO:963502'));
    const worker = processor(); const completed = await worker.process(accepted.command.id);
    assert.equal(completed.status, 'completed', completed.lastError);
    assert.equal((await worker.process(accepted.command.id)).status, 'completed');
    const order = await getDeliveryOrder(963502);
    assert.equal(order.operator_status, 'loaded'); assert.equal(Number(order.lines[0].loaded_qty), 109);
    assert.equal(Number(order.lines[0].packed_sales_qty), 0);
    const records = (await query('SELECT response FROM operator_load_records WHERE order_id=963502')).rows;
    assert.equal(records.length, 1);
    assert.equal(records[0].response.operatorNetSuitePosting.transactions[0].transactionRef, 'IF151113');
    assert.equal(completed.result.localFinalization.operatorNetSuitePosting.transactions[0].reused, true);
    assert.equal(completed.result.transactions[0].transactionRef, 'IF151113');
    assert.equal(remoteMutations(), 0);
  });
});

test('partial pickup stays open and the remaining confirmation can reuse the same existing IF', async () => {
  await fixture(async ({ admit, input, processor, remoteMutations }) => {
    const first = await admit(input()); const done = await processor().process(first.command.id);
    assert.equal(done.status, 'completed', done.lastError);
    let order = await getDeliveryOrder(963502);
    assert.equal(order.operator_status, 'partial_loaded'); assert.equal(Number(order.lines[0].loaded_qty), 40);
    await query('UPDATE sales_order_lines SET packed_sales_qty=69 WHERE sales_order_id=963502');
    const second = await admit(input()); const final = await processor().process(second.command.id);
    assert.equal(final.status, 'completed', final.lastError);
    order = await getDeliveryOrder(963502);
    assert.equal(order.operator_status, 'loaded'); assert.equal(Number(order.lines[0].loaded_qty), 109);
    assert.equal(Number((await query('SELECT count(*) AS count FROM operator_load_records WHERE order_id=963502')).rows[0].count), 2);
    assert.equal(remoteMutations(), 0);
  }, { confirmed: 40 });
});

test('concurrent pickup requests and workers commit only one local load', async () => {
  await fixture(async ({ admit, input, processor, remoteMutations }) => {
    const results = await Promise.allSettled([admit(input()), admit(input())]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'OPERATOR_NETSUITE_POSTING_ORDER_CLAIMED');
    const accepted = results.find(result => result.status === 'fulfilled').value;
    await Promise.all([processor().process(accepted.command.id), processor().process(accepted.command.id)]);
    const stored = await repo.getOperatorNetSuitePostingCommand(accepted.command.id);
    assert.equal(stored.status, 'completed', stored.lastError);
    assert.equal(Number((await query('SELECT count(*) AS count FROM operator_load_records WHERE order_id=963502')).rows[0].count), 1);
    assert.equal(Number((await getDeliveryOrder(963502)).lines[0].loaded_qty), 109);
    assert.equal(remoteMutations(), 0);
  });
});

test('failed local finalization rolls back load quantity and load evidence together', async () => {
  await fixture(async ({ admit, input, processor, remoteMutations }) => {
    const accepted = await admit(input());
    const failed = await processor(async command => {
      await finalizeOperatorNetSuitePosting(command);
      throw new Error('simulated local commit failure');
    }).process(accepted.command.id);
    assert.notEqual(failed.status, 'completed');
    const order = await getDeliveryOrder(963502);
    assert.equal(Number(order.lines[0].loaded_qty), 0); assert.equal(Number(order.lines[0].packed_sales_qty), 109);
    assert.equal(Number((await query('SELECT count(*) AS count FROM operator_load_records WHERE order_id=963502')).rows[0].count), 0);
    assert.equal(remoteMutations(), 0);
  });
});

test('wrong IF evidence preserves the pickup draft and photos without accepting a command', async () => {
  await fixture(async ({ e, admit, input, actor }) => {
    e.records[0].item.items[0].location.id = '28';
    await assert.rejects(admit(input()), { code: 'OPERATOR_PICKUP_EXISTING_IF_UNVERIFIED' });
    assert.equal(Number((await getDeliveryOrder(963502)).lines[0].packed_sales_qty), 109);
    assert.equal(Number((await query('SELECT count(*) AS count FROM operator_netsuite_posting_commands WHERE actor_operator_id=$1', [actor.id])).rows[0].count), 0);
  });
});

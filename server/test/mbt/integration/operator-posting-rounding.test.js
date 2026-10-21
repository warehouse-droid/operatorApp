import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { query, closeDb } from '../../../src/db.js';
import { createOperator } from '../../../src/auth-repository.js';
import { buildOperatorNetSuitePostingDraft } from '../../../src/operator-netsuite-posting-domain.js';
import { verifyOperatorNetSuitePostingRecord } from '../../../src/operator-netsuite-posting-adapter.js';
import { createOperatorNetSuitePostingProcessor } from '../../../src/operator-netsuite-posting-service.js';
import { finalizeOperatorNetSuitePosting } from '../../../src/operator-netsuite-posting-finalizer.js';
import * as repo from '../../../src/operator-netsuite-posting-repository.js';

after(closeDb);
const repository = { get: repo.getOperatorNetSuitePostingCommand, claim: repo.claimOperatorNetSuitePostingCommand,
  renew: repo.renewOperatorNetSuitePostingLease, startAttempt: repo.startOperatorNetSuitePostingAttempt,
  success: repo.recordOperatorNetSuitePostingStepSuccess, failure: repo.recordOperatorNetSuitePostingStepFailure,
  attention: repo.markOperatorNetSuitePostingCommandAttention, fail: repo.failOperatorNetSuitePostingCommand,
  complete: repo.completeOperatorNetSuitePostingCommand };
let sequence = 0;

async function fixture({ local = 60.7602, required = 60.76, legacy = true } = {}) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const id = 998000001 + sequence++;
  const actor = await createOperator({ username: `rounding-${randomUUID()}`, displayName: 'Rounding test',
    password: 'test-only-rounding', role: 'operator', roles: ['operator'], yardLocationIds: [1] });
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,outbound_location_id,netsuite_active,sales_order_type,
    operator_status,status,status_text) VALUES($1,$2,1,true,'Pick-Up','packed','B','Pending Fulfillment')`, [id, `ROUNDING-${id}`]);
  const row = (await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,netsuite_order_line,item_id,item_type,
    quantity,unit,location_id,netsuite_active,packed_sales_qty,loaded_qty)
    VALUES($1,$2,2,4767,'InvtPart',$3,'SQFT',1,true,$4,0) RETURNING id`, [id, id + 5000000, required, local])).rows[0];
  const key = `customer_pickup:sales_order:${id}`;
  const draft = buildOperatorNetSuitePostingDraft({ requestId: randomUUID(), actorOperatorId: actor.id,
    functionKey: 'customer_pickup', transactionType: 'IF', photoRefs: ['r2://rounding-test/pickup.jpg'],
    policy: { gateKey: 'operator_netsuite_customer_pickup_if_3445', revision: 1, effective: true,
      functionKey: 'customer_pickup', transactionType: 'IF', locationId: 1, yardCode: '3445' },
    localOrderKeys: [key], localOperation: { kind: 'customer_pickup_load', orderId: String(id), orderType: 'sales_order' },
    targets: [{ sourceOrderKind: 'SO', sourceNetSuiteId: id, sourceOrderRef: `ROUNDING-${id}`, postingStrategy: 'stored_order_line_v1',
      selectedLines: [{ orderLine: 2, quantity: local, location: 1, itemId: 4767, sourceLineKey: String(id + 5000000),
        localOrderKey: key, localLineId: String(row.id), ...(legacy ? {} : { salesUom: 'SQFT' }) }],
      availableLines: [{ orderLine: 2, location: 1, sourceLineKey: String(id + 5000000), orderedQuantity: 60.76,
        remainingQuantity: 60.76, completedQuantity: 0, ...(legacy ? {} : { salesUom: 'SQFT' }) }] }] });
  const accepted = await repo.createOrReplayOperatorNetSuitePostingCommand(draft);
  const record = { id: 1051504, tranId: 'IF157392', externalId: draft.steps[0].externalId,
    transactionType: 'IF', createdFrom: { id: String(id) }, item: { items: [{ orderLine: 2, itemReceive: true,
      quantity: 60.76, unitsDisplay: 'SQFT', item: { id: '4767' }, location: { id: '1' } }] } };
  return { id, local, lineId: row.id, command: accepted.command, record };
}

async function holdOriginalAttempt(f) {
  const command = await repo.claimOperatorNetSuitePostingCommand({ commandId: f.command.id, workerId: 'old-verifier', leaseSeconds: 180 });
  const step = command.steps[0];
  const attempt = await repo.startOperatorNetSuitePostingAttempt({ commandId: command.id, stepId: step.id, leaseToken: command.leaseToken });
  const error = new Error('The recovered NetSuite quantity for line 2 does not match.');
  await repo.recordOperatorNetSuitePostingStepFailure({ commandId: command.id, stepId: step.id, leaseToken: command.leaseToken,
    attemptNumber: attempt.attemptNumber, uncertain: true, error,
    observedTransaction: { id: f.record.id, tranId: f.record.tranId, externalId: f.record.externalId } });
  await repo.markOperatorNetSuitePostingCommandAttention({ commandId: command.id, leaseToken: command.leaseToken, error });
  await repo.resumeOperatorNetSuitePostingCommand(command.id);
}

function processor(f, { fresh = false, failFinalization = false } = {}) {
  const calls = { transforms: 0, finalized: 0, reads: 0 };
  const adapter = { findByExternalId: async () => { calls.reads++; return structuredClone(f.record); },
    fetchById: async () => { calls.reads++; return structuredClone(f.record); },
    verify: verifyOperatorNetSuitePostingRecord,
    transform: async step => {
      calls.transforms++;
      assert.equal(fresh, true, 'Recovery must not create a second fulfillment');
      assert.equal(step.payload.item.items[0].quantity, 60.76);
      return { id: f.record.id };
    } };
  const worker = createOperatorNetSuitePostingProcessor({ repository, adapter, workerId: `rounding-${randomUUID()}`,
    finalize: async command => {
      calls.finalized++;
      const result = await finalizeOperatorNetSuitePosting(command);
      if (failFinalization) { throw new Error('test-only finalization rollback'); }
      return result;
    } });
  return { worker, calls };
}

async function assertLocalCompletion(f) {
  const order = (await query('SELECT operator_status FROM sales_orders WHERE netsuite_id=$1', [f.id])).rows[0];
  const line = (await query('SELECT loaded_qty,packed_sales_qty FROM sales_order_lines WHERE id=$1', [f.lineId])).rows[0];
  assert.equal(order.operator_status, 'loaded');
  assert.equal(Number(line.loaded_qty), 60.76);
  assert.equal(Number(line.packed_sales_qty), 0);
  assert.equal((await query('SELECT id FROM operator_load_records WHERE order_id=$1', [f.id])).rowCount, 1);
  const command = await repo.getOperatorNetSuitePostingCommand(f.command.id);
  assert.equal(command.status, 'completed', command.lastError);
  assert.equal(command.steps[0].netSuiteTransactionRef, 'IF157392');
  assert.equal(command.activeClaims.length, 0);
}

test('R5/R9 legacy IF157392 is recovered once with NetSuite quantities and its immutable old request', async () => {
  const f = await fixture();
  const original = JSON.stringify(f.command.inputSnapshot);
  await holdOriginalAttempt(f);
  const { worker, calls } = processor(f);
  await worker.process(f.command.id);
  await assertLocalCompletion(f);
  await worker.process(f.command.id);
  await assertLocalCompletion(f);
  assert.equal(calls.transforms, 0);
  assert.equal(calls.finalized, 1);
  const stored = await repo.getOperatorNetSuitePostingCommand(f.command.id);
  assert.equal(JSON.stringify(stored.inputSnapshot), original);
  assert.equal(stored.steps[0].payload.item.items[0].quantity, 60.7602);
  assert.equal(stored.steps[0].response.quantityAdjustments[0].netSuiteQuantity, 60.76);
  const attempts = (await query('SELECT outcome FROM operator_netsuite_posting_attempts WHERE step_id=$1 ORDER BY attempt_number', [stored.steps[0].id])).rows;
  assert.deepEqual(attempts.map(row => row.outcome), ['uncertain', 'recovered']);
});

test('R9 a slightly lower local pickup completes using the larger NetSuite quantity', async () => {
  const f = await fixture({ local: 60.7598, required: 60.7598, legacy: false });
  const { worker, calls } = processor(f, { fresh: true });
  await worker.process(f.command.id);
  await assertLocalCompletion(f);
  assert.equal(calls.transforms, 1);
  assert.equal(calls.finalized, 1);
});

test('R9 a cached local total slightly above NetSuite does not leave a rounding-only pickup remainder', async () => {
  const f = await fixture({ local: 60.765, required: 60.765 });
  await holdOriginalAttempt(f);
  await processor(f).worker.process(f.command.id);
  await assertLocalCompletion(f);
});

test('R3 a 0.01 SQFT discrepancy remains held and preserves the local draft', async () => {
  const f = await fixture({ local: 60.77, required: 60.77 });
  await holdOriginalAttempt(f);
  const { worker, calls } = processor(f);
  const held = await worker.process(f.command.id);
  assert.equal(held.status, 'attention');
  assert.match(held.lastError, /quantity/u);
  assert.equal(calls.transforms, 0);
  assert.equal(calls.finalized, 0);
  assert.equal((await query('SELECT id FROM operator_load_records WHERE order_id=$1', [f.id])).rowCount, 0);
  const line = (await query('SELECT loaded_qty,packed_sales_qty FROM sales_order_lines WHERE id=$1', [f.lineId])).rows[0];
  assert.equal(Number(line.loaded_qty), 0);
  assert.equal(Number(line.packed_sales_qty), 60.77);
});

test('R5 concurrent recovery workers release one claim and commit one local pickup', async () => {
  const f = await fixture();
  await holdOriginalAttempt(f);
  const a = processor(f), b = processor(f);
  await Promise.all([a.worker.process(f.command.id), b.worker.process(f.command.id)]);
  await assertLocalCompletion(f);
  assert.equal(a.calls.transforms + b.calls.transforms, 0);
  assert.equal(a.calls.finalized + b.calls.finalized, 1);
});

test('R5 a failed local finalization rolls back quantity, load evidence and claim release together', async () => {
  const f = await fixture();
  await holdOriginalAttempt(f);
  const { worker, calls } = processor(f, { failFinalization: true });
  const failed = await worker.process(f.command.id);
  assert.equal(failed.status, 'attention');
  assert.equal(calls.transforms, 0);
  assert.equal((await query('SELECT id FROM operator_load_records WHERE order_id=$1', [f.id])).rowCount, 0);
  const line = (await query('SELECT loaded_qty,packed_sales_qty FROM sales_order_lines WHERE id=$1', [f.lineId])).rows[0];
  assert.equal(Number(line.loaded_qty), 0);
  assert.equal(Number(line.packed_sales_qty), 60.7602);
  assert.ok(failed.activeClaims.length > 0);
});

async function receiptFixture(local, required, direct = false) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const id = 998000001 + sequence++;
  const actor = await createOperator({ username: `rounding-ir-${randomUUID()}`, displayName: 'Receipt rounding test',
    password: 'test-only-rounding', role: 'operator', roles: ['operator'], yardLocationIds: [1] });
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,destination_location_id,netsuite_active)
    VALUES($1,$2,'B','Pending Receipt',1,true)`, [id, `ROUNDING-IR-${id}`]);
  const line = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,netsuite_order_line,item_id,item_type,
    quantity,unit,location_id,received_sales_qty,netsuite_received_qty,netsuite_received_baseline_qty,netsuite_active,confirmed_at)
    VALUES($1,$2,2,4767,'InvtPart',$3,'SQFT',1,$4,0,0,true,now()) RETURNING id`, [id, id + 5000000, required, local])).rows[0];
  const key = `receiving:purchase_order:${id}`;
  const localPayload = { item: { items: [{ orderLine: id + 5000000, quantity: local, itemReceive: true, location: 1 }] } };
  const draft = buildOperatorNetSuitePostingDraft({ requestId: randomUUID(), actorOperatorId: actor.id,
    functionKey: 'receiving', transactionType: 'IR', photoRefs: ['r2://rounding-test/unloaded.jpg', 'r2://rounding-test/received.jpg'],
    policy: { gateKey: 'operator_netsuite_receiving_ir_3445', revision: 1, effective: true,
      functionKey: 'receiving', transactionType: 'IR', locationId: 1, yardCode: '3445' },
    localOrderKeys: [key], localOperation: { kind: direct ? 'direct_po_receipt' : 'receiving_receipt', orderId: String(id), orderType: 'purchase_order' }, localPayload,
    ...(direct ? { directDeliveryEvidence: { completionEventId: 1, sourcePoId: id,
      pickupJobIds: ['test-only-pickup'], deliveryJobId: 'test-only-delivery' } } : {}),
    targets: [{ sourceOrderKind: 'PO', sourceNetSuiteId: id, sourceOrderRef: `ROUNDING-IR-${id}`, postingStrategy: 'stored_order_line_v1',
      selectedLines: [{ orderLine: 2, quantity: local, location: 1, itemId: 4767, sourceLineKey: String(id + 5000000),
        localOrderKey: key, localLineId: String(line.id) }],
      availableLines: [{ orderLine: 2, location: 1, sourceLineKey: String(id + 5000000), orderedQuantity: 60.76,
        remainingQuantity: 60.76, completedQuantity: 0 }] }] });
  const accepted = await repo.createOrReplayOperatorNetSuitePostingCommand(draft);
  const record = { id: 1051504, tranId: 'IR-ROUNDING', externalId: draft.steps[0].externalId,
    transactionType: 'IR', createdFrom: { id: String(id) }, item: { items: [{ orderLine: 2, itemReceive: true,
      quantity: 60.76, unitsDisplay: 'SQFT', item: { id: '4767' }, location: { id: '1' } }] } };
  return { id, lineId: line.id, command: accepted.command, record };
}

test('R9 direct PO recovery stores the actual NetSuite completed counter', async () => {
  const f = await receiptFixture(60.765, 60.765, true);
  await holdOriginalAttempt(f);
  const result = await processor(f).worker.process(f.command.id);
  assert.equal(result.status, 'completed', result.lastError);
  const line = (await query('SELECT netsuite_received_qty FROM purchase_order_lines WHERE id=$1', [f.lineId])).rows[0];
  assert.equal(Number(line.netsuite_received_qty), 60.76);
  const order = (await query('SELECT receipt_status FROM purchase_orders WHERE netsuite_id=$1', [f.id])).rows[0];
  assert.equal(order.receipt_status, 'received');
});

for (const [local, required] of [[60.7598, 60.76], [60.765, 60.765]]) {
  test(`R9 recovered IR completes locally at NetSuite 60.76 SQFT when the local quantity was ${local}`, async () => {
    const f = await receiptFixture(local, required);
    const original = JSON.stringify(f.command.inputSnapshot);
    await holdOriginalAttempt(f);
    const { worker, calls } = processor(f);
    await worker.process(f.command.id);
    const completed = await repo.getOperatorNetSuitePostingCommand(f.command.id);
    assert.equal(completed.status, 'completed', completed.lastError);
    assert.equal(completed.activeClaims.length, 0);
    assert.equal(JSON.stringify(completed.inputSnapshot), original);
    const order = (await query('SELECT receipt_status,last_item_receipt_tranid FROM purchase_orders WHERE netsuite_id=$1', [f.id])).rows[0];
    assert.equal(order.receipt_status, 'received');
    assert.equal(order.last_item_receipt_tranid, 'IR-ROUNDING');
    const receipts = (await query('SELECT payload,receipt_status FROM receiving_receipt_records WHERE order_id=$1', [f.id])).rows;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].payload.item.items[0].quantity, 60.76);
    assert.equal(receipts[0].receipt_status, 'received');
    await worker.process(f.command.id);
    assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=$1', [f.id])).rowCount, 1);
    assert.equal(calls.transforms, 0);
    assert.equal(calls.finalized, 1);
  });
}

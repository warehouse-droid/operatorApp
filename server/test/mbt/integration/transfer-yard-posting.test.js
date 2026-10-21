import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { query, closeDb } from '../../../src/db.js';
import { prepareTransferPostingJob, retryTransferPostingJob } from '../../../src/transfer-order-posting-service.js';
import { finalizeTransferPosting, assertTransferPostingStepReady } from '../../../src/transfer-order-posting-repository.js';
import { getReceivingOrder, listReceivingOrders } from '../../../src/receiving-repository.js';
import { movementRecordEvidence } from '../../../src/movement-record-evidence.js';
import * as repository from '../../../src/operator-netsuite-posting-repository.js';
import { createOperatorNetSuitePostingAdapter } from '../../../src/operator-netsuite-posting-netsuite-adapter.js';
import { createOperatorNetSuitePostingProcessor } from '../../../src/operator-netsuite-posting-service.js';
import { seedYardTransfer, yardRollback, yardLoad, yardReceive, yardPostingDependencies } from '../../support/operator-to-yard-flow-fixture.mjs';

after(closeDb);

function worker({ rejectFirstIF = false } = {}) {
  const remote = new Map(), calls = [];
  const transform = type => async (id, payload) => {
    calls.push(type);
    if (rejectFirstIF && calls.length === 1 && type === 'IF') {
      throw Object.assign(new Error('NetSuite rejected IF'), { status: 400, netsuiteResponseReceived: true });
    }
    const record = { id: 123450 + calls.length, tranId: `${type}-YARD`, transactionType: type,
      createdFromId: id, externalId: payload.externalId,
      item: { items: payload.item.items.filter(i => i.itemReceive).map(i => ({ ...i, item: { id: 2299 } })) } };
    remote.set(payload.externalId, record);
    return { id: record.id };
  };
  const fetchRecord = async id => [...remote.values()].find(record => Number(record.id) === Number(id));
  const adapter = createOperatorNetSuitePostingAdapter({ checkTransferPosting: assertTransferPostingStepReady,
    findTransactionByExternalId: async externalId => {
      const record = remote.get(externalId); return record ? { id: record.id, record } : null;
    },
    transformTransferOrderToItemFulfillment: transform('IF'), transformTransferOrderToItemReceipt: transform('IR'),
    transformSalesOrderToItemFulfillment: async () => assert.fail('Unexpected SO transform'),
    transformPurchaseOrderToItemReceipt: async () => assert.fail('Unexpected PO transform'),
    fetchItemFulfillment: fetchRecord, fetchItemReceipt: fetchRecord });
  const processor = createOperatorNetSuitePostingProcessor({ workerId: 'yard-milestones', adapter, finalize: finalizeTransferPosting,
    repository: { get: repository.getOperatorNetSuitePostingCommand, claim: repository.claimOperatorNetSuitePostingCommand,
      renew: repository.renewOperatorNetSuitePostingLease, startAttempt: repository.startOperatorNetSuitePostingAttempt,
      success: repository.recordOperatorNetSuitePostingStepSuccess, failure: repository.recordOperatorNetSuitePostingStepFailure,
      attention: repository.markOperatorNetSuitePostingCommandAttention, fail: repository.failOperatorNetSuitePostingCommand,
      complete: repository.completeOperatorNetSuitePostingCommand } });
  return { process: id => processor.process(id), calls };
}

test('outbound loading posts IF before any receiving or driver work', () => yardRollback(async () => {
  const f = await seedYardTransfer(), loaded = await yardLoad(f);
  assert.equal(loaded.status, 'waiting_posting');
  const ready = await prepareTransferPostingJob(loaded.id, yardPostingDependencies(f));
  assert.equal(ready.command?.status, 'queued');
  assert.equal(ready.command.inputSnapshot.transferEvidence.completionEventId, null);
  assert.equal(ready.command.inputSnapshot.transferEvidence.operatorRecordId, Number(loaded.operator_record_id));
  const engine = worker();
  assert.equal((await engine.process(ready.command.id)).status, 'completed');
  assert.deepEqual(engine.calls, ['IF']);
  assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=$1', [f.id])).rowCount, 0);
  const history = await movementRecordEvidence({ loadIds: [loaded.operator_record_id] });
  assert.equal(history.get(`load-${loaded.operator_record_id}`).waitingForDriverCompletion, false);
}));

test('failed IF leaves receiving available; retry posts IF then the saved IR exactly once', () => yardRollback(async () => {
  const f = await seedYardTransfer(), loaded = await yardLoad(f);
  const ready = await prepareTransferPostingJob(loaded.id, yardPostingDependencies(f));
  assert.ok(ready.command, 'Loading alone must admit IF');
  const engine = worker({ rejectFirstIF: true });
  assert.equal((await engine.process(ready.command.id)).status, 'failed');
  assert.ok((await listReceivingOrders({ orderType: 'transfer_order', destinationLocationId: 28 })).some(o => Number(o.netsuite_id) === f.id));
  assert.equal(Number((await getReceivingOrder(f.id)).lines[0].quantity), 5);
  const received = await yardReceive(f);
  assert.equal((await getReceivingOrder(f.id)).receipt_status, 'received');
  await assert.rejects(yardReceive(f), /quantity|selected|loaded/i);
  const pending = await prepareTransferPostingJob(received.id, { ...yardPostingDependencies(f, 'IR'),
    resolveSource: async () => assert.fail('IR must wait for verified IF without consulting NetSuite') });
  assert.equal(pending.status, 'waiting_fulfillment');
  await retryTransferPostingJob(loaded.id);
  assert.equal((await engine.process(ready.command.id)).status, 'completed');
  const ir = await prepareTransferPostingJob(received.id, yardPostingDependencies(f, 'IR'));
  assert.equal(ir.command?.status, 'queued');
  assert.equal((await engine.process(ir.command.id)).status, 'completed');
  await engine.process(ir.command.id);
  await engine.process(ready.command.id);
  assert.deepEqual(engine.calls, ['IF', 'IF', 'IR']);
  assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=$1', [f.id])).rowCount, 1);
  assert.equal((await repository.getOperatorNetSuitePostingCommand(ready.command.id)).steps[0].externalId, ready.command.steps[0].externalId);
}));

test('each partial receipt posts IR without waiting for the rest of the shipment', () => yardRollback(async () => {
  const f = await seedYardTransfer(), loaded = await yardLoad(f), engine = worker();
  const ready = await prepareTransferPostingJob(loaded.id, yardPostingDependencies(f));
  assert.ok(ready.command, 'Loading alone must admit IF');
  assert.equal((await engine.process(ready.command.id)).status, 'completed');
  for (const quantity of [2, 3]) {
    const received = await yardReceive(f, quantity);
    const ir = await prepareTransferPostingJob(received.id, yardPostingDependencies(f, 'IR'));
    assert.equal(ir.command?.steps[0].payload.item.items[0].quantity, quantity);
    assert.equal((await engine.process(ir.command.id)).status, 'completed');
  }
  assert.deepEqual(engine.calls, ['IF', 'IR', 'IR']);
  assert.equal((await getReceivingOrder(f.id)).receipt_status, 'received');
}));

test('legacy waiting jobs advance and the transform boundary still requires the actual local record', () => yardRollback(async () => {
  const f = await seedYardTransfer(), loaded = await yardLoad(f);
  await query("UPDATE transfer_order_posting_jobs SET status='waiting_driver' WHERE id=$1", [loaded.id]);
  const ready = await prepareTransferPostingJob(loaded.id, yardPostingDependencies(f));
  assert.equal(ready.command?.status, 'queued');
  assert.equal((await prepareTransferPostingJob(loaded.id, yardPostingDependencies(f))).command.id, ready.command.id);
  await query('DELETE FROM operator_load_records WHERE id=$1', [loaded.operator_record_id]);
  await assert.rejects(assertTransferPostingStepReady(ready.command.steps[0]), /waiting_load/);
}));

test('IR transform rechecks the saved receipt even after admission', () => yardRollback(async () => {
  const f = await seedYardTransfer(), loaded = await yardLoad(f), engine = worker();
  const ready = await prepareTransferPostingJob(loaded.id, yardPostingDependencies(f));
  assert.ok(ready.command, 'Loading alone must admit IF');
  await engine.process(ready.command.id);
  const received = await yardReceive(f), ir = await prepareTransferPostingJob(received.id, yardPostingDependencies(f, 'IR'));
  await query('DELETE FROM receiving_receipt_records WHERE id=$1', [received.operator_record_id]);
  await assert.rejects(assertTransferPostingStepReady(ir.command.steps[0]), /waiting_receipt/);
}));

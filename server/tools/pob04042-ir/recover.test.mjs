import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before, beforeEach } from 'node:test';
import { query, closeDb } from '../../src/db.js';
import { createOperator } from '../../src/auth-repository.js';
import * as repo from '../../src/operator-netsuite-posting-repository.js';
import { finalizeOperatorNetSuitePosting } from '../../src/operator-netsuite-posting-finalizer.js';
import { recoverReceipt } from './recover.mjs';
import { commandId } from './proof.mjs';

let evidence, actor;
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED, 'false');
  actor = await createOperator({ username: 'pob04042-test', displayName: 'Receipt repair test',
    password: 'isolated-test-only', role: 'operator', yardLocationIds: [1] });
});
after(closeDb);
beforeEach(async () => {
  evidence = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
  await query('DELETE FROM receiving_receipt_records WHERE order_id=1059322');
  await query('DELETE FROM operator_netsuite_posting_commands WHERE id=$1', [commandId]);
  await query('DELETE FROM purchase_order_lines WHERE purchase_order_id=1059322');
  await query('DELETE FROM purchase_orders WHERE netsuite_id=1059322');
  await query("DELETE FROM delivery_audit_log WHERE action='receiving.ir.reconcile_existing' AND order_id=1059322");
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,destination_location_id,receipt_status,netsuite_active)
    VALUES(1059322,'POB04042','B','Purchase Order : Pending Receipt',1,'not_received',true)`);
  for (const line of evidence.command.steps[0].lineSnapshot) {
    const source = evidence.source.lines.find(s => s.restLineId === line.orderLine);
    await query(`INSERT INTO purchase_order_lines(id,purchase_order_id,line_id,netsuite_order_line,item_id,item_type,
      quantity,unit,location_id,netsuite_active,netsuite_received_qty,netsuite_received_baseline_qty,confirmed_at,received_sales_qty)
      VALUES($1,1059322,$2,$3,$4,'InvtPart',$5,'EACH',1,true,0,0,now(),$5)`,
    [line.localLineId, line.sourceLineKey, line.orderLine, source.itemId, line.quantity]);
  }
  const saved = evidence.command;
  const draft = { ...saved.inputSnapshot, actorOperatorId: actor.id, inputHash: saved.inputHash,
    inputSnapshot: saved.inputSnapshot, photoRefs: saved.photoRefs, steps: saved.steps };
  const created = await repo.createOrReplayOperatorNetSuitePostingCommand(draft);
  const command = await repo.claimOperatorNetSuitePostingCommand({ commandId: created.command.id, workerId: 'original-test-worker', leaseSeconds: 180 });
  const step = command.steps[0];
  const attempt = await repo.startOperatorNetSuitePostingAttempt({ commandId, stepId: step.id, leaseToken: command.leaseToken });
  const error = new Error('The recovered NetSuite transaction contains an unexpected positive line.');
  await repo.recordOperatorNetSuitePostingStepFailure({ commandId, stepId: step.id, leaseToken: command.leaseToken,
    attemptNumber: attempt.attemptNumber, uncertain: true, error,
    observedTransaction: { id: 1071915, tranId: 'IR15183', externalId: evidence.receipt.externalId } });
  await repo.markOperatorNetSuitePostingCommandAttention({ commandId, leaseToken: command.leaseToken, error });
});

async function assertHeld() {
  const command = await repo.getOperatorNetSuitePostingCommand(commandId);
  assert.equal(command.status, 'attention');
  assert.equal(command.steps[0].status, 'uncertain');
  assert.equal(command.steps[0].attemptCount, 1);
  assert.equal(command.activeClaims.length, 2);
  assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=1059322')).rowCount, 0);
  assert.equal((await query('SELECT receipt_status FROM purchase_orders WHERE netsuite_id=1059322')).rows[0].receipt_status, 'not_received');
}

test('commits the existing receipt, reference, original request, photos, recovery attempt and audit', async () => {
  const before = await repo.getOperatorNetSuitePostingCommand(commandId);
  const result = await recoverReceipt({ evidence });
  assert.equal(result.status, 'completed');
  assert.equal(result.result.localFinalization.itemReceiptTranid, 'IR15183');
  assert.deepEqual(result.inputSnapshot, before.inputSnapshot);
  assert.deepEqual(result.steps[0].payload, before.steps[0].payload);
  assert.equal(result.steps[0].netSuiteTransactionId, 1071915);
  assert.equal(result.steps[0].response.recovery.freight.amount, 130.42);
  assert.equal(result.activeClaims.length, 0);
  const rows = (await query('SELECT * FROM receiving_receipt_records WHERE order_id=1059322')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item_receipt_tranid, 'IR15183');
  assert.equal(rows[0].receipt_status, 'received');
  assert.deepEqual(rows[0].photo_data_urls, before.photoRefs);
  assert.equal(rows[0].payload.item.items.length, 5);
  const order = (await query('SELECT receipt_status,last_item_receipt_tranid FROM purchase_orders WHERE netsuite_id=1059322')).rows[0];
  assert.deepEqual(order, { receipt_status: 'received', last_item_receipt_tranid: 'IR15183' });
  assert.deepEqual((await query('SELECT outcome FROM operator_netsuite_posting_attempts WHERE step_id=$1 ORDER BY attempt_number', [before.steps[0].id])).rows.map(r => r.outcome), ['uncertain', 'recovered']);
  assert.equal((await query("SELECT id FROM delivery_audit_log WHERE action='receiving.ir.reconcile_existing' AND order_id=1059322")).rowCount, 1);
});

test('dry run rolls back every receipt and command state change', async () => {
  const result = await recoverReceipt({ evidence, rollback: true });
  assert.equal(result.status, 'completed');
  await assertHeld();
});

test('failure after real finalization rolls back history, attempts and order state', async () => {
  await assert.rejects(recoverReceipt({ evidence, finalize: async command => {
    await finalizeOperatorNetSuitePosting(command);
    throw new Error('injected finalization failure');
  } }), /injected finalization failure/);
  await assertHeld();
});

test('rejects remote mismatch without changing the held command', async () => {
  evidence.receipt.item.items[0].quantity++;
  await assert.rejects(recoverReceipt({ evidence }));
  await assertHeld();
});

test('simultaneous and repeated recovery returns one completed receipt', async () => {
  const results = await Promise.all([recoverReceipt({ evidence }), recoverReceipt({ evidence })]);
  assert.deepEqual(results.map(r => r.status), ['completed', 'completed']);
  assert.equal((await recoverReceipt({ evidence })).status, 'completed');
  assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=1059322')).rowCount, 1);
  assert.equal((await repo.getOperatorNetSuitePostingCommand(commandId)).steps[0].attemptCount, 2);
});

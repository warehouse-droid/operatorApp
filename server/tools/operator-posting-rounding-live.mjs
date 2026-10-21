// Run inside the live app environment. Its default mode is read-only inspection.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { query, withTransaction, closeDb } from '../src/db.js';
import { writeAudit } from '../src/auth-repository.js';
import * as repo from '../src/operator-netsuite-posting-repository.js';
import { operatorNetSuitePostingAdapter } from '../src/operator-netsuite-posting-netsuite-adapter.js';
import { createOperatorNetSuitePostingProcessor } from '../src/operator-netsuite-posting-service.js';
import { finalizeOperatorNetSuitePosting } from '../src/operator-netsuite-posting-finalizer.js';
import { suiteql } from '../src/netsuite.js';

const commandId = 'e7790160-40e2-4cbb-a259-d21f29460ca4';
const mode = globalThis.roundingLiveMode || 'inspect';
assert.ok(['inspect', 'recover', 'verify'].includes(mode));
const fingerprint = command => createHash('sha256').update(JSON.stringify({
  inputSnapshot: command.inputSnapshot, photoRefs: command.photoRefs,
  steps: command.steps.map(step => ({ id: step.id, payload: step.payload, lineSnapshot: step.lineSnapshot }))
})).digest('hex');

async function localEvidence() {
  return {
    order: (await query('SELECT netsuite_id,tranid,status,status_text,operator_status FROM sales_orders WHERE netsuite_id=1051337')).rows[0],
    lines: (await query(`SELECT id,line_id,item_id,quantity,unit,packed_sales_qty,loaded_qty
      FROM sales_order_lines WHERE sales_order_id=1051337 ORDER BY id`)).rows,
    loads: (await query('SELECT * FROM operator_load_records WHERE order_id=1051337 ORDER BY id')).rows,
    attempts: (await query(`SELECT * FROM operator_netsuite_posting_attempts WHERE step_id=1257 ORDER BY attempt_number`)).rows
  };
}

async function verifiedExisting(command) {
  assert.equal(command.functionKey, 'customer_pickup');
  assert.equal(command.inputSnapshot.postingStrategy, 'stored_order_line_v1');
  assert.equal(command.steps.length, 1);
  const step = command.steps[0];
  assert.equal(step.id, 1257);
  assert.equal(step.sourceOrderKind, 'SO');
  assert.equal(step.sourceNetSuiteId, 1051337);
  assert.equal(step.sourceOrderRef, 'SOB122432');
  assert.equal(step.transactionType, 'IF');
  assert.equal(step.externalId, `MBBS-OP-${commandId}-1`);
  assert.ok(step.attemptCount >= 1, 'Only an existing attempted posting may be recovered');
  assert.equal(await operatorNetSuitePostingAdapter.hasSplitPlan(step), false);
  const record = await operatorNetSuitePostingAdapter.findByExternalId(step, true);
  assert.ok(record, 'The existing fulfillment must be visible before recovery');
  assert.equal(Number(record.id), 1051504);
  assert.equal(record.tranId, 'IF157392');
  const headers = (await suiteql(`SELECT id,tranid,type,status,BUILTIN.DF(status) AS status_text
    FROM transaction WHERE id IN (1051337,1051504)`)).items;
  const fulfillment = headers.find(row => Number(row.id) === 1051504);
  assert.equal(fulfillment?.type, 'ItemShip');
  assert.equal(fulfillment?.status, 'C', 'The fulfillment must still be shipped in NetSuite');
  const positive = record.item.items.filter(item => item.itemReceive !== false && Number(item.quantity) > 0);
  const expected = new Map([[1, [4765, 91.14]], [2, [4767, 60.76]], [4, [4754, 21.26]]]);
  assert.equal(positive.length, expected.size);
  for (const item of positive) {
    const identity = expected.get(Number(item.orderLine));
    assert.ok(identity);
    assert.equal(Number(item.item.id), identity[0]);
    assert.equal(Number(item.quantity), identity[1]);
    assert.equal(String(item.unitsDisplay ?? item.units?.refName).toUpperCase(), 'SQFT');
    assert.equal(Number(item.location.id), 28);
  }
  return { record, headers, verified: operatorNetSuitePostingAdapter.verify(step, record) };
}

try {
  const before = await repo.getOperatorNetSuitePostingCommand(commandId);
  assert.ok(before);
  const immutableBefore = fingerprint(before);
  const localBefore = await localEvidence();
  const external = await verifiedExisting(before);
  let transforms = 0;
  if (mode === 'recover') {
    assert.equal(before.status, 'attention');
    await withTransaction(async () => {
      await repo.resumeOperatorNetSuitePostingCommand(commandId);
      await writeAudit({ actorType: 'system', source: 'admin', action: 'operator.posting.sqft_rounding_recovery_requested',
        orderId: 1051337, details: { commandId, netSuiteTransactionId: 1051504, netSuiteTransactionRef: 'IF157392',
          varianceLimitSqft: 0.01, reason: 'User authorized the general strictly under 0.01 SQFT NetSuite quantity rule and recovery of IF157392.',
          verified: external.verified, immutableFingerprint: immutableBefore } });
    });
    const repository = { get: repo.getOperatorNetSuitePostingCommand, claim: repo.claimOperatorNetSuitePostingCommand,
      renew: repo.renewOperatorNetSuitePostingLease, startAttempt: repo.startOperatorNetSuitePostingAttempt,
      success: repo.recordOperatorNetSuitePostingStepSuccess, failure: repo.recordOperatorNetSuitePostingStepFailure,
      attention: repo.markOperatorNetSuitePostingCommandAttention, fail: repo.failOperatorNetSuitePostingCommand,
      complete: repo.completeOperatorNetSuitePostingCommand };
    const processor = createOperatorNetSuitePostingProcessor({ repository,
      adapter: { ...operatorNetSuitePostingAdapter, transform: async () => {
        transforms++; throw new Error('Recovery is limited to the existing IF157392; no new transform is authorized here.');
      } }, finalize: finalizeOperatorNetSuitePosting, workerId: 'sqft-rounding-recovery-20261010' });
    await processor.process(commandId);
  }
  const after = await repo.getOperatorNetSuitePostingCommand(commandId);
  assert.equal(fingerprint(after), immutableBefore);
  const localAfter = await localEvidence();
  if (mode !== 'inspect') {
    assert.equal(after.status, 'completed', after.lastError);
    assert.equal(after.steps[0].status, 'posted');
    assert.equal(after.steps[0].netSuiteTransactionId, 1051504);
    assert.equal(after.steps[0].netSuiteTransactionRef, 'IF157392');
    assert.equal(after.activeClaims.length, 0);
    assert.equal(localAfter.order.operator_status, 'loaded');
    assert.equal(localAfter.loads.length, 1);
    const line = localAfter.lines.find(row => Number(row.id) === 529848);
    assert.ok(line);
    assert.equal(Number(line.loaded_qty), 60.76);
    assert.equal(Number(line.packed_sales_qty), 0);
    assert.equal(transforms, 0);
  }
  const quantityHolds = (await query(`SELECT id,function_key,input_snapshot->'localOrderKeys' AS local_order_keys,last_error FROM operator_netsuite_posting_commands
    WHERE status='attention' AND last_error ILIKE '%quantity%' ORDER BY created_at`)).rows;
  console.log(JSON.stringify({ at: new Date().toISOString(), mode, before, after, localBefore, localAfter, external,
    immutableFingerprint: immutableBefore, transforms, quantityHolds,
    summary: { commandId, order: 'SOB122432', fulfillment: 'IF157392', status: after.status,
      localStatus: localAfter.order.operator_status, netSuiteQuantity: 60.76, immutableRequestPreserved: true,
      loadRecords: localAfter.loads.length, transforms } }));
} finally { await closeDb(); }

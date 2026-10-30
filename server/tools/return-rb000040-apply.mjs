// Operational script for the user's explicit CMB26105 rate-1 request.
// Run via stdin with cwd=/app in the live app; never in a test container.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { query, withTransaction, closeDb } from './src/db.js';
import { fetchCreditMemoFromNetSuite, createOrUpdateCreditMemoInNetSuite,
  fetchReturnRestockingFeeFromNetSuite, suiteqlAll } from './src/netsuite.js';
import { buildReturnCreditMemoPayload, verifyReturnCreditMemoSnapshot } from './src/return-credit-memo.js';
import { buildAdjustedReturnCreditMemoIntent, verifyReturnCreditMemoAdjustment,
  recordVerifiedReturnCreditMemoAdjustment } from './src/return-credit-memo-adjustment.js';
import { synchronizeReturnBatchAuthorization } from './src/return-batch-ra-service.js';

const batchId = 54;
const creditMemoId = 1098335;
const directory = '/app/data/return-operations';
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const auditPath = `${directory}/rb000040-rate-one-${Date.now()}.json`;
const audit = { startedAt: new Date().toISOString(), batchId, creditMemoId, creditMemoReference: 'CMB26105',
  userRequest: 'Apply rate 1 and calculated restocking fee; use NetSuite default item descriptions.',
  stage: 'checking', notificationRequested: false };
function save() { fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2) + '\n', { mode: 0o600 }); }
save();
let committed = false;
try {
  await withTransaction(async () => {
    await query("SET LOCAL lock_timeout='10s'");
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`return-batch-ra:${batchId}`]);
    const batch = (await query('SELECT * FROM return_batch_authorizations WHERE batch_id=$1', [batchId])).rows[0];
    assert.equal(Number(batch.netsuite_transaction_id), creditMemoId);
    assert.equal(batch.netsuite_transaction_ref, 'CMB26105');
    assert.equal(batch.intent_snapshot.sourceSalesOrderRef, 'SOB122269');
    assert.equal(batch.intent_snapshot.lines.length, 1);
    assert.equal(batch.intent_snapshot.lines[0].rate, 0);
    assert.equal(batch.intent_snapshot.lines[0].returnedSalesQuantity, 11.66);
    const existing = await query("SELECT e.id FROM return_sync_events e JOIN return_records r ON r.id=e.return_record_id WHERE r.batch_id=$1 AND e.event_type='credit_memo_adjustment' AND e.status='succeeded'", [batchId]);
    assert.equal(existing.rowCount, 0, 'This one-time adjustment already has a verified event; inspect instead of applying again.');
    const before = await fetchCreditMemoFromNetSuite(creditMemoId, { strictMissing: true });
    verifyReturnCreditMemoSnapshot({ ...batch.intent_snapshot, netSuiteTransactionId: creditMemoId }, before);
    assert.equal(before.tranId, 'CMB26105');
    assert.deepEqual(before.item.items.map(row => [row.line, row.item.id]), [[1, '4794'], [4, '3015']]);
    assert.equal(Number(before.total), 0);
    const defaults = await suiteqlAll('SELECT id,itemid,itemtype,description FROM item WHERE id IN (4794,3015)');
    assert.equal(defaults.length, 2);
    const descriptions = new Map(defaults.map(row => [String(row.id), row.description || '']));
    assert.ok(descriptions.get('4794'));
    const fee = await fetchReturnRestockingFeeFromNetSuite();
    assert.deepEqual(fee, batch.intent_snapshot.restockingFee);
    const request = { version: 1, batchId, creditMemoId, baseIntent: structuredClone(batch.intent_snapshot),
      useDefaultItemDescriptions: true, stockRates: [{ lineIndex: 0, fromRate: 0, rate: 1 }],
      reason: 'User explicitly requested the rate-1 test on CMB26105 and NetSuite default item descriptions.' };
    const effective = buildAdjustedReturnCreditMemoIntent(batch, request);
    const payload = { item: { items: buildReturnCreditMemoPayload(effective).item.items.map((row, index) => ({
      ...row, line: before.item.items[index].line, description: descriptions.get(row.item.id) })) } };
    assert.equal(payload.item.items[0].rate, 1);
    assert.equal(payload.item.items[1].rate, -4.08);
    const rollback = { item: { items: before.item.items.map(row => ({ line: row.line, item: { id: row.item.id },
      price: { id: '-1' }, rate: row.rate, description: row.description || '',
      ...(row.quantity === undefined ? {} : { quantity: row.quantity }) })) } };
    Object.assign(audit, { stage: 'prepared', originalIntent: batch.intent_snapshot, before, request, payload, rollback, defaults });
    save();
    let verified = false;
    try {
      audit.stage = 'patching'; save();
      await createOrUpdateCreditMemoInNetSuite({ creditMemoId, payload });
      const after = await fetchCreditMemoFromNetSuite(creditMemoId, { strictMissing: true });
      verifyReturnCreditMemoAdjustment(batch, request, after);
      assert.deepEqual(after.item.items.map(row => [row.line, row.lineUniqueKey]),
        before.item.items.map(row => [row.line, row.lineUniqueKey]));
      assert.deepEqual(after.item.items.map(row => row.description || ''), ['4794', '3015'].map(id => descriptions.get(id)));
      assert.equal(Number(after.subtotal), 7.58);
      const result = await recordVerifiedReturnCreditMemoAdjustment({ batchId, request, snapshot: after });
      Object.assign(audit, { stage: 'verified', after, adjustmentEventId: result.eventId }); save();
      verified = true;
    } finally {
      if (!verified) {
        audit.stage = 'restoring-after-failure'; save();
        await createOrUpdateCreditMemoInNetSuite({ creditMemoId, payload: rollback });
        const restored = await fetchCreditMemoFromNetSuite(creditMemoId, { strictMissing: true });
        verifyReturnCreditMemoSnapshot({ ...batch.intent_snapshot, netSuiteTransactionId: creditMemoId }, restored);
        assert.equal(Number(restored.total), 0);
        Object.assign(audit, { stage: 'restored-after-failure', restored }); save();
      }
    }
  });
  committed = true;
  const batch = await synchronizeReturnBatchAuthorization({ batchId, reconcile: true });
  assert.equal(batch.sync_status, 'succeeded');
  assert.equal(batch.intent_snapshot.lines[0].rate, 0);
  Object.assign(audit, { stage: 'complete', completedAt: new Date().toISOString(), reconciliation: batch.sync_status,
    originalIntentPreserved: true }); save();
  console.log('RETURN_RATE_RESULT=' + JSON.stringify({ auditPath, creditMemoId, reference: audit.after.tranId,
    lines: audit.after.item.items.map(row => ({ line: row.line, itemId: row.item.id, description: row.description || '',
      quantity: row.quantity ?? null, rate: row.rate, amount: row.amount })), subtotal: audit.after.subtotal,
    taxTotal: audit.after.taxTotal, total: audit.after.total, reconciliation: audit.reconciliation,
    adjustmentEventId: audit.adjustmentEventId, originalIntentPreserved: true }));
} catch (error) {
  // A database commit error can happen after the remote save and verification.
  // Confirm whether the event committed before deciding if restoration is needed.
  if (!committed && audit.stage === 'verified') {
    try {
      const recorded = await query("SELECT id FROM return_sync_events WHERE id=$1 AND event_type='credit_memo_adjustment' AND status='succeeded'", [audit.adjustmentEventId]);
      if (!recorded.rowCount) {
        await withTransaction(async () => {
          await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`return-batch-ra:${batchId}`]);
          audit.stage = 'restoring-after-commit-failure'; save();
          await createOrUpdateCreditMemoInNetSuite({ creditMemoId, payload: audit.rollback });
          const restored = await fetchCreditMemoFromNetSuite(creditMemoId, { strictMissing: true });
          verifyReturnCreditMemoSnapshot({ ...audit.originalIntent, netSuiteTransactionId: creditMemoId }, restored);
          assert.equal(Number(restored.total), 0);
          Object.assign(audit, { stage: 'restored-after-commit-failure', restored }); save();
        });
      }
    } catch (recoveryError) { audit.recoveryError = String(recoveryError.message || recoveryError); }
  }
  audit.error = String(error.message || error); save();
  console.error('RETURN_RATE_FAILURE=' + JSON.stringify({ auditPath, stage: audit.stage, error: audit.error }));
  process.exitCode = 1;
} finally { await closeDb(); }

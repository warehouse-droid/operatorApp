import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { closeDb, query } from '../../../src/db.js';
import { submitReturnBatch, syncReturnRecord, processPendingReturnSyncs, getReturnRecordDetail } from '../../../src/return-repository.js';
import { synchronizeReturnBatchAuthorization } from '../../../src/return-batch-ra-service.js';
import { fixture, submitInput, actor } from '../../support/return-batch-ra-fixture.js';
after(closeDb);

async function creditFixture(t) {
  const remote = await fixture(t);
  const before = await query("SELECT * FROM mbt_feature_flags WHERE flag_key='operator_netsuite_stock_return_cm_3445'");
  t.after(async () => {
    for (const row of before.rows) { await query('UPDATE mbt_feature_flags SET enabled=$2,revision=$3 WHERE flag_key=$1', [row.flag_key,row.enabled,row.revision]); }
  });
  await query("UPDATE mbt_feature_flags SET enabled=true,revision=revision+1 WHERE flag_key='operator_netsuite_stock_return_cm_3445'");
  return remote;
}
const submit = async () => submitReturnBatch({ operatorId: actor, input: await submitInput(), autoSync: true });
const creates = remote => remote.requests.filter(row => row.method === 'POST' && /\/record\//.test(row.address)).length;
const addFee = remote => remote.created.values().next().value.item.items.push(
  { item: { id: '-2' }, itemType: { id: 'Subtotal' }, amount: 12.5 },
  { item: { id: '3016' }, itemType: { id: 'Discount' }, rate: -35, amount: -4.38 }
);

test('C1 verified CM with accounting additions recovers the same transaction without a remote write', async t => {
  const remote = await creditFixture(t); const result = await submit(); addFee(remote);
  await query("UPDATE return_batch_authorizations SET sync_status='failed',sync_error='Credit Memo verification failed: item rows were added, removed or merged.' WHERE batch_id=$1", [result.stockReturn.batchId]);
  await synchronizeReturnBatchAuthorization({ recordId: result.stockReturn.id, reconcile: true });
  const record = await getReturnRecordDetail(result.stockReturn.id);
  assert.equal(record.netSuiteSyncStatus, 'succeeded');
  assert.equal(record.netSuiteTransactionId, result.stockReturn.netSuiteTransactionId);
  await synchronizeReturnBatchAuthorization({ recordId: result.stockReturn.id, reconcile: true });
  assert.equal(creates(remote), 1);
});

test('R1 permanent material mismatch stops automatic retries; manual recovery reuses the CM', async t => {
  const remote = await creditFixture(t); const result = await submit();
  const line = remote.created.values().next().value.item.items[0]; line.quantity++;
  await assert.rejects(synchronizeReturnBatchAuthorization({ recordId: result.stockReturn.id, reconcile: true }), { code: 'RETURN_CM_VERIFICATION_FAILED' });
  const calls = remote.requests.length;
  assert.deepEqual(await processPendingReturnSyncs(), { queued: 0, succeeded: 0, failed: 0 });
  assert.deepEqual(await processPendingReturnSyncs(), { queued: 0, succeeded: 0, failed: 0 });
  assert.equal(remote.requests.length, calls);
  assert.equal((await getReturnRecordDetail(result.stockReturn.id)).netSuiteSyncStatus, 'failed');
  line.quantity--;
  assert.equal((await syncReturnRecord({ recordId: result.stockReturn.id })).netSuiteSyncStatus, 'succeeded');
  const saved = (await query('SELECT automatic_retry_blocked,sync_error_code FROM return_batch_authorizations WHERE batch_id=$1', [result.stockReturn.batchId])).rows[0];
  assert.deepEqual(saved, { automatic_retry_blocked: false, sync_error_code: null });
  assert.equal(creates(remote), 1);
});

test('R1 RA verification failures also wait for manual correction', async t => {
  const remote = await fixture(t); const result = await submit();
  const line = remote.created.values().next().value.item.items[0]; line.quantity++;
  await assert.rejects(synchronizeReturnBatchAuthorization({ recordId: result.stockReturn.id, reconcile: true }), { code: 'RETURN_RA_VERIFICATION_FAILED' });
  const calls = remote.requests.length;
  assert.deepEqual(await processPendingReturnSyncs(), { queued: 0, succeeded: 0, failed: 0 });
  assert.equal(remote.requests.length, calls);
  line.quantity--;
  assert.equal((await syncReturnRecord({ recordId: result.stockReturn.id })).netSuiteSyncStatus, 'succeeded');
  assert.equal(creates(remote), 1);
});

test('C2/R1 accounting additions cannot finalize a new draft and do not cause an automatic retry loop', async t => {
  const remote = await creditFixture(t);
  let admittedRows;
  remote.control.alter = () => {
    admittedRows = structuredClone(remote.created.values().next().value.item.items);
    addFee(remote);
  };
  const input = await submitInput();
  await assert.rejects(submitReturnBatch({ operatorId: actor, input, autoSync: true }), { code: 'RETURN_SUBMISSION_DRAFT' });
  const calls = remote.requests.length;
  assert.deepEqual(await processPendingReturnSyncs(), { queued: 0, succeeded: 0, failed: 0 });
  assert.equal(remote.requests.length, calls);
  assert.equal((await query('SELECT id FROM return_records WHERE operator_id=$1', [actor])).rowCount, 0);
  remote.created.values().next().value.item.items = admittedRows;
  const result = await submitReturnBatch({ operatorId: actor, input, autoSync: true });
  assert.equal(result.stockReturn.netSuiteSyncStatus, 'succeeded');
  assert.equal(creates(remote), 1);
});

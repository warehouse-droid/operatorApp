import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { query, closeDb } from '../../../src/db.js';
import { submitReturnBatch } from '../../../src/return-repository.js';
import { findReturnBatchAuthorization, synchronizeReturnBatchAuthorization } from '../../../src/return-batch-ra-service.js';
import { recordVerifiedReturnCreditMemoAdjustment } from '../../../src/return-credit-memo-adjustment.js';
import { fixture, submitInput, actor } from '../../support/return-batch-ra-fixture.js';
after(closeDb);

async function setup(t) {
  const remote = await fixture(t, { enabled: false });
  const flags = (await query("SELECT flag_key,enabled,revision FROM mbt_feature_flags WHERE flag_key LIKE 'operator_netsuite_%return_cm_%'")).rows;
  t.after(async () => {
    for (const row of flags) { await query('UPDATE mbt_feature_flags SET enabled=$2,revision=$3 WHERE flag_key=$1', [row.flag_key, row.enabled, row.revision]); }
  });
  await query("UPDATE mbt_feature_flags SET enabled=true,revision=revision+1 WHERE flag_key LIKE 'operator_netsuite_%return_cm_%'");
  remote.remoteLines[0].rate = 0;
  remote.remoteLines[0].fulfilled_quantity = 20;
  remote.remoteLines[0].sales_quantity = 20;
  remote.control.alter = data => {
    for (const row of data.item.items) {
      row.description = row.item.id === '3015' ? '' : 'NetSuite default product description';
      row.amount = row.quantity === undefined ? row.rate : Math.round(row.quantity * row.rate * 100) / 100;
    }
  };
  const result = await submitReturnBatch({ operatorId: actor, input: await submitInput({ quantity: 11.66 }), autoSync: true });
  const batch = await findReturnBatchAuthorization(result.stockReturn.id);
  const request = { version: 1, batchId: Number(batch.batch_id), creditMemoId: Number(batch.netsuite_transaction_id),
    baseIntent: structuredClone(batch.intent_snapshot), useDefaultItemDescriptions: true,
    stockRates: [{ lineIndex: 0, fromRate: 0, rate: 1 }], reason: 'Explicit authorized test correction' };
  return { remote, result, batch, request };
}

test('D4 real submission keeps NetSuite defaults and still reconciles its split source audit', async t => {
  const { remote, result, batch } = await setup(t);
  assert.equal(batch.sync_status, 'succeeded');
  const post = remote.requests.find(r => r.method === 'POST' && /creditMemo$/.test(r.address));
  assert.ok(post.body.item.items.every(row => !Object.hasOwn(row, 'description')));
  assert.equal(batch.intent_snapshot.lines[0].sourceSalesOrderLineId, 99091703);
  assert.equal((await synchronizeReturnBatchAuthorization({ recordId: result.stockReturn.id, reconcile: true })).sync_status, 'succeeded');
});

test('A5 verified price event preserves immutable intent and successful reconciliation without another CM', async t => {
  const { remote, result, batch, request } = await setup(t);
  const saved = remote.created.get(String(batch.netsuite_transaction_id));
  saved.item.items[0].rate = 1; saved.item.items[0].amount = 11.66;
  saved.item.items[1].rate = -4.08; saved.item.items[1].amount = -4.08;
  await assert.rejects(synchronizeReturnBatchAuthorization({ recordId: result.stockReturn.id, reconcile: true }), { code: 'RETURN_CM_VERIFICATION_FAILED' });
  await recordVerifiedReturnCreditMemoAdjustment({ batchId: batch.batch_id, request, snapshot: saved, actorOperatorId: actor });
  assert.equal((await synchronizeReturnBatchAuthorization({ recordId: result.stockReturn.id, reconcile: true })).sync_status, 'succeeded');
  const reconciled = await findReturnBatchAuthorization(result.stockReturn.id);
  assert.deepEqual(reconciled.intent_snapshot, batch.intent_snapshot);
  assert.equal(reconciled.netsuite_snapshot.item.items[0].rate, 1);
  assert.equal(remote.requests.filter(r => r.method === 'POST' && /creditMemo$/.test(r.address)).length, 1);
  saved.item.items[0].quantity = 12;
  await assert.rejects(synchronizeReturnBatchAuthorization({ recordId: result.stockReturn.id, reconcile: true }), { code: 'RETURN_CM_VERIFICATION_FAILED' });
});

test('A6 failed correction readback creates no verified event; pending records cannot authorize a rate change', async t => {
  const { remote, result, batch, request } = await setup(t);
  const saved = remote.created.get(String(batch.netsuite_transaction_id));
  saved.item.items[0].rate = 1; saved.item.items[0].amount = 11.66;
  saved.item.items[1].rate = -4.08; saved.item.items[1].amount = 0;
  await assert.rejects(recordVerifiedReturnCreditMemoAdjustment({ batchId: batch.batch_id, request, snapshot: saved, actorOperatorId: actor }));
  assert.equal((await query("SELECT count(*)::int AS count FROM return_sync_events WHERE return_record_id=$1 AND event_type='credit_memo_adjustment'", [result.stockReturn.id])).rows[0].count, 0);
  await query("INSERT INTO return_sync_events(return_record_id,event_type,status,request_snapshot,response_snapshot) VALUES($1,'credit_memo_adjustment','pending',$2,$3)",
    [result.stockReturn.id, request, saved]);
  saved.item.items[1].amount = -4.08;
  await assert.rejects(synchronizeReturnBatchAuthorization({ recordId: result.stockReturn.id, reconcile: true }), { code: 'RETURN_CM_VERIFICATION_FAILED' });
});

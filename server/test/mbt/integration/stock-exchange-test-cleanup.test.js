import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { query, withTransaction, closeDb } from '../../../src/db.js';
import { submitReturnBatch, localStockReserved } from '../../../src/return-repository.js';
import { getOperatorNetSuitePostingPolicy } from '../../../src/operator-netsuite-posting-policy-repository.js';
import { fixture, submitInput, actor } from '../../support/return-batch-ra-fixture.js';
const { cleanupDeletedExchange } = await import(process.env.EXCHANGE_CLEANUP_MODULE || '../../../tools/stock-exchange-deleted-test-cleanup.mjs');
after(closeDb);

async function admitted() {
  const input = await submitInput({ quantity: 2 });
  input.returnMode = 'exchange'; input.stockReturnType = 'quality'; input.lines[0].reasonId = 5;
  input.lines[0].photos = input.photos;
  input.expectedPostingPolicies = { stock_exchange: await getOperatorNetSuitePostingPolicy({ functionKey: 'stock_exchange', locationId: 1 }) };
  return (await submitReturnBatch({ operatorId: actor, input, autoSync: false })).stockExchange;
}
async function setup(t) {
  await fixture(t, { enabled: false });
  await query('DELETE FROM return_exchange_months WHERE id NOT IN (SELECT month_id FROM return_exchange_postings)');
  const record = await admitted();
  const month = (await query('SELECT m.* FROM return_exchange_months m JOIN return_exchange_postings p ON p.month_id=m.id WHERE p.record_id=$1', [record.id])).rows[0];
  const transferId = 99110582;
  await query("UPDATE return_records SET netsuite_transaction_id=$2,netsuite_transaction_ref='IT-TEST',netsuite_transaction_status='Posted',netsuite_sync_status='succeeded' WHERE id=$1", [record.id, transferId]);
  await query("UPDATE return_exchange_months SET transfer_id=$2,transfer_ref='IT-TEST' WHERE id=$1", [month.id, transferId]);
  await query("UPDATE return_exchange_postings SET attempted_at=now(),safe_to_retry=false,proof='{}',confirmed_lines='[{\"quantity\":2}]' WHERE record_id=$1", [record.id]);
  const target = { recordId: Number(record.id), reference: record.reference, monthId: Number(month.id), locationId: 1,
    month: month.month, transferId, transferRef: 'IT-TEST', sourceLineId: 99091703, quantity: 2 };
  const calls = [];
  const remote = { get: async id => { calls.push(id); throw Object.assign(new Error(`The inventoryTransfer instance for ID '${id}' does not exist.`), { status: 404, netsuiteResponseReceived: true }); } };
  return { target, remote, calls };
}
async function state(target) {
  return {
    record: (await query('SELECT status,netsuite_sync_status,netsuite_transaction_id,netsuite_transaction_ref,netsuite_transaction_status,voided_at FROM return_records WHERE id=$1', [target.recordId])).rows[0],
    month: (await query('SELECT * FROM return_exchange_months WHERE id=$1', [target.monthId])).rows[0],
    posting: (await query('SELECT * FROM return_exchange_postings WHERE record_id=$1', [target.recordId])).rows[0],
    reserved: (await localStockReserved([target.sourceLineId])).get(String(target.sourceLineId)) || 0,
    events: (await query('SELECT id FROM return_sync_events WHERE return_record_id=$1 ORDER BY id', [target.recordId])).rows
  };
}

test('deleted test cleanup previews without writes, releases only its quantity, preserves history and is idempotent', async t => {
  const input = await setup(t), before = await state(input.target);
  const plan = await cleanupDeletedExchange(input);
  assert.equal(plan.ready, true); assert.equal(plan.releasedQuantity, 2);
  assert.deepEqual(await state(input.target), before);
  const result = await cleanupDeletedExchange({ ...input, apply: true });
  assert.equal(result.applied, true); assert.equal(result.netSuiteWrites, 0);
  const after = await state(input.target);
  assert.equal(after.record.status, 'voided'); assert.equal(after.record.netsuite_sync_status, 'cancelled');
  assert.equal(after.record.netsuite_transaction_ref, 'IT-TEST');
  assert.equal(after.month.transfer_id, null); assert.equal(after.month.transfer_ref, null);
  assert.equal(after.month.external_id, before.month.external_id);
  assert.equal(before.reserved - after.reserved, 2);
  for (const key of ['intent', 'proof', 'confirmed_lines', 'attempted_at']) assert.deepEqual(after.posting[key], before.posting[key]);
  const replay = await cleanupDeletedExchange({ ...input, apply: true });
  assert.equal(replay.alreadyCompleted, true); assert.deepEqual(await state(input.target), after);
  assert.deepEqual(input.calls, [input.target.transferId, input.target.transferId]);
  const next = await admitted();
  assert.equal(next.recordType, 'exchange');
  assert.equal((await localStockReserved([input.target.sourceLineId])).get(String(input.target.sourceLineId)), 2);
});

test('existing transfer, ambiguous missing responses and changed quantities preserve all local state', async t => {
  const input = await setup(t), before = await state(input.target);
  const invalidReads = [async () => ({ id: input.target.transferId }),
    ...[{ status: 404 }, { status: 500, netsuiteResponseReceived: true }, { status: 404, netsuiteResponseReceived: true }]
      .map(fields => async () => { throw Object.assign(new Error('Different or incomplete failure'), fields); })];
  for (const get of invalidReads) {
    await assert.rejects(cleanupDeletedExchange({ ...input, remote: { get }, apply: true }));
    assert.deepEqual(await state(input.target), before);
  }
  await assert.rejects(cleanupDeletedExchange({ ...input, target: { ...input.target, quantity: 3 }, apply: true }), /quantity changed/);
  assert.deepEqual(await state(input.target), before);
});

test('another exchange in the same month blocks test-only cleanup', async t => {
  const input = await setup(t);
  await admitted();
  const before = await state(input.target);
  await assert.rejects(cleanupDeletedExchange({ ...input, apply: true }), /Another exchange/);
  assert.deepEqual(await state(input.target), before);
});

test('audit failure rolls back the void, released quantity and cleared monthly link together', async t => {
  const input = await setup(t), before = await state(input.target);
  await withTransaction(async () => {
    await query(`CREATE FUNCTION reject_test_cleanup_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='deleted_test_exchange_cleanup' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF;
      RETURN NEW; END $$`);
    await query('CREATE TRIGGER reject_test_cleanup BEFORE INSERT ON return_sync_events FOR EACH ROW EXECUTE FUNCTION reject_test_cleanup_event()');
    await assert.rejects(cleanupDeletedExchange({ ...input, apply: true }), /synthetic audit failure/);
    assert.deepEqual(await state(input.target), before);
  }, { rollback: true });
});

test('concurrent cleanup requests release once and write one cleanup event', async t => {
  const input = await setup(t);
  const results = await Promise.all([cleanupDeletedExchange({ ...input, apply: true }), cleanupDeletedExchange({ ...input, apply: true })]);
  assert.equal(results.filter(r => r.applied).length, 1);
  assert.equal(results.filter(r => r.alreadyCompleted).length, 1);
  assert.equal((await state(input.target)).reserved, 0);
  assert.equal((await query("SELECT count(*)::int n FROM return_sync_events WHERE return_record_id=$1 AND event_type='deleted_test_exchange_cleanup'", [input.target.recordId])).rows[0].n, 1);
});

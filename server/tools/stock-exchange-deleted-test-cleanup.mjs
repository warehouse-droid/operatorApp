import assert from 'node:assert/strict';
import { query, withTransaction, closeDb } from '../src/db.js';
import { localStockReserved, voidReturnRecord } from '../src/return-repository.js';
import { stockExchangeNetSuite } from '../src/stock-exchange-netsuite.js';

export const approvedTest = Object.freeze({ recordId: 70, reference: 'SE-000001', monthId: 1,
  locationId: 1, month: '2026-10', transferId: 1101179, transferRef: 'IT00582',
  sourceLineId: 5022059, quantity: 10.21 });
const reason = 'User approved system-maintenance cleanup of the successful test exchange after deleting IT00582 in NetSuite. Original submitting operator is retained for required void attribution; maintenance execution is recorded separately.';

export async function cleanupDeletedExchange({ target = approvedTest, remote = stockExchangeNetSuite, apply = false } = {}) {
  return withTransaction(async () => {
    await query("SET LOCAL lock_timeout='5s'");
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`return-sync:${target.recordId}`]);
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`stock-exchange-month:${target.monthId}`]);
    const record = (await query('SELECT * FROM return_records WHERE id=$1 FOR UPDATE', [target.recordId])).rows[0];
    const month = (await query('SELECT * FROM return_exchange_months WHERE id=$1 FOR UPDATE', [target.monthId])).rows[0];
    assert.ok(record && month, 'Expected exchange and month must exist');
    assert.equal(record.record_reference, target.reference);
    assert.equal(record.record_type, 'exchange');
    assert.equal(Number(record.netsuite_transaction_id), target.transferId);
    assert.equal(record.netsuite_transaction_ref, target.transferRef);
    assert.equal(Number(month.location_id), target.locationId);
    assert.equal(month.month, target.month);
    const prior = await query("SELECT id FROM return_sync_events WHERE return_record_id=$1 AND event_type='deleted_test_exchange_cleanup' AND status='succeeded'", [target.recordId]);
    if (prior.rowCount) {
      assert.equal(record.status, 'voided');
      assert.equal(record.netsuite_sync_status, 'cancelled');
      assert.equal(month.transfer_id, null);
      return { applied: false, alreadyCompleted: true, recordId: target.recordId, reference: target.reference };
    }
    assert.equal(record.status, 'accepted');
    assert.equal(record.netsuite_sync_status, 'succeeded');
    assert.equal(Number(month.transfer_id), target.transferId);
    assert.equal(month.transfer_ref, target.transferRef);
    const postings = await query('SELECT * FROM return_exchange_postings WHERE month_id=$1 ORDER BY record_id FOR UPDATE', [target.monthId]);
    assert.deepEqual(postings.rows.map(row => Number(row.record_id)), [target.recordId], 'Another exchange now uses this month; inspect before cleanup');
    const lines = await query('SELECT source_sales_order_line_id,returned_sales_quantity FROM return_record_lines WHERE return_record_id=$1', [target.recordId]);
    assert.deepEqual(lines.rows.map(row => [Number(row.source_sales_order_line_id), Number(row.returned_sales_quantity)]),
      [[target.sourceLineId, target.quantity]], 'Test quantity changed');
    let missing = false;
    try { await remote.get(target.transferId); }
    catch (error) {
      if (error.status !== 404 || error.netsuiteResponseReceived !== true || !String(error.message).includes(`ID '${target.transferId}' does not exist`)) throw error;
      missing = true;
    }
    assert.ok(missing, 'Inventory Transfer still exists; cleanup refused');
    const key = String(target.sourceLineId);
    const before = (await localStockReserved([target.sourceLineId])).get(key) || 0;
    assert.ok(before >= target.quantity, 'Expected test reservation is missing');
    const plan = { recordId: target.recordId, reference: target.reference, transferRef: target.transferRef,
      transferId: target.transferId, monthId: target.monthId, sourceLineId: target.sourceLineId,
      releasedQuantity: target.quantity, reservationBefore: before, retainedHistory: true, netSuiteWrites: 0,
      executionActor: 'system-maintenance', originalOperatorId: record.operator_id };
    if (!apply) return { ...plan, applied: false, ready: true };
    await query("UPDATE return_exchange_postings SET safe_to_retry=true,updated_at=now() WHERE record_id=$1", [target.recordId]);
    // Existing void safeguards require confirmation that the remote transaction is gone.
    await query("UPDATE return_records SET netsuite_transaction_status='Voided (deleted in NetSuite)',netsuite_sync_status='cancelled' WHERE id=$1", [target.recordId]);
    await voidReturnRecord({ recordId: target.recordId, reason, actorOperatorId: record.operator_id });
    await query('UPDATE return_exchange_months SET transfer_id=NULL,transfer_ref=NULL WHERE id=$1', [target.monthId]);
    const after = (await localStockReserved([target.sourceLineId])).get(key) || 0;
    assert.ok(Math.abs(before - after - target.quantity) < .000001, 'Unexpected reservation change');
    const audit = await query(`INSERT INTO return_sync_events(return_record_id,event_type,status,request_snapshot,response_snapshot)
      VALUES($1,'deleted_test_exchange_cleanup','succeeded',$2::jsonb,$3::jsonb) RETURNING id`,
      [target.recordId, JSON.stringify({ reason, target, previousMonth: month, previousPosting: postings.rows[0] }),
        JSON.stringify({ ...plan, reservationAfter: after, recordStatus: 'voided', monthTransferCleared: true })]);
    return { ...plan, applied: true, reservationAfter: after, auditEventId: Number(audit.rows[0].id) };
  });
}

if (process.argv[1] === '-') {
  try { console.log(JSON.stringify(await cleanupDeletedExchange({ apply: process.argv.includes('--apply') }))); }
  finally { await closeDb(); }
}

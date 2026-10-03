// @ts-check
import { query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";

/** @param {string} message */
function blocked(message) {
  return Object.assign(new Error(message), { status: 409, code: "RETURN_RA_CREATION_UNCERTAIN" });
}

/** @param {string | null | undefined} draftId */
export async function assertReturnDraftMutable(draftId) {
  if (!draftId || !/^[0-9a-f-]{36}$/i.test(String(draftId))) { return; }
  const result = await query("SELECT batch_id FROM return_batch_authorizations WHERE draft_id=$1::uuid", [draftId]);
  if (result.rowCount) { throw blocked("This draft has a NetSuite posting or unconfirmed RA. Retry it before changing or discarding it."); }
}

/** @param {number} batchId @param {string} draftId */
export async function stageReturnBatchRecords(batchId, draftId) {
  const result = await query(`SELECT jsonb_build_object(
    'records',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM return_records r WHERE r.batch_id=$1),
    'lines',(SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb) FROM return_record_lines l
      JOIN return_records r ON r.id=l.return_record_id WHERE r.batch_id=$1),
    'photos',(SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM return_photos p
      JOIN return_records r ON r.id=p.return_record_id WHERE r.batch_id=$1)) AS snapshot`, [batchId]);
  const snapshot = result.rows[0].snapshot;
  if (!snapshot.records?.length) { throw blocked("The return submission could not be staged."); }
  const staged = await query(`UPDATE return_batch_authorizations SET draft_id=$2::uuid,staged_records=$3::jsonb
    WHERE batch_id=$1 AND attempted_at IS NULL AND netsuite_transaction_id IS NULL`, [batchId, draftId, JSON.stringify(snapshot)]);
  if (staged.rowCount !== 1) { throw blocked("The return already has a NetSuite posting attempt."); }
  await query("DELETE FROM return_records WHERE batch_id=$1", [batchId]);
}

/** @param {Record<string, any>} batch */
export async function assertStagedReturnBatch(batch) {
  const result = await query(`SELECT d.id FROM return_drafts d JOIN return_batches b ON b.id=$1
    WHERE d.id=$2::uuid AND d.operator_id=b.operator_id AND d.receiving_location_id=b.receiving_location_id`,
  [batch.batch_id, batch.draft_id]);
  const ids = (batch.staged_records?.records || []).map((/** @type {Record<string, any>} */ row) => Number(row.id))
    .sort((/** @type {number} */ a, /** @type {number} */ b) => a - b);
  const members = await query("SELECT id FROM return_records WHERE batch_id=$1", [batch.batch_id]);
  if (!result.rowCount || members.rowCount || JSON.stringify(ids) !== JSON.stringify(batch.intent_snapshot.recordIds)) {
    throw blocked("The staged return does not match its NetSuite posting intent.");
  }
}

/** @param {Record<string, any>} batch */
export async function finalizeStagedReturnBatch(batch) {
  if (!batch.draft_id) { return; }
  const current = await query("SELECT * FROM return_batch_authorizations WHERE batch_id=$1", [batch.batch_id]);
  const saved = current.rows[0];
  if (!saved?.draft_id) { return; }
  if (!["succeeded", "manual_linked"].includes(saved.sync_status)) { throw blocked("NetSuite must verify this RA before the return can be recorded."); }
  await assertStagedReturnBatch(saved);
  for (const [table, key] of [["return_records", "records"], ["return_record_lines", "lines"], ["return_photos", "photos"]]) {
    await query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,
      [JSON.stringify(saved.staged_records[key])]);
  }
  await query(`UPDATE return_records r SET netsuite_sync_status=a.sync_status,netsuite_sync_error=a.sync_error,
    netsuite_transaction_ref=a.netsuite_transaction_ref,netsuite_transaction_status=a.netsuite_transaction_status,
    netsuite_stage='return_authorization',netsuite_snapshot=a.netsuite_snapshot,
    netsuite_sync_attempts=a.sync_attempts,netsuite_last_synced_at=a.last_synced_at,updated_at=now()
    FROM return_batch_authorizations a WHERE a.batch_id=$1 AND r.batch_id=a.batch_id`, [batch.batch_id]);
  await query(`INSERT INTO return_sync_events(return_record_id,event_type,status,response_snapshot)
    SELECT id,'batch_return_authorization','succeeded',jsonb_build_object('reference',$2::text)
    FROM return_records WHERE batch_id=$1`, [batch.batch_id, saved.netsuite_transaction_ref]);
  await query("UPDATE return_batch_authorizations SET draft_id=NULL,staged_records=NULL WHERE batch_id=$1", [batch.batch_id]);
  await query("DELETE FROM return_drafts WHERE id=$1::uuid", [saved.draft_id]);
}

/** @param {number} batchId @param {string | null} actorOperatorId @param {string} message */
export async function retainFailedReturnDraft(batchId, actorOperatorId, message) {
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [`return-batch-ra:${batchId}`]);
    const result = await query("SELECT * FROM return_batch_authorizations WHERE batch_id=$1 FOR UPDATE", [batchId]);
    const batch = result.rows[0];
    if (!batch?.draft_id) { return null; }
    await query(`UPDATE return_drafts SET updated_at=now(),expires_at=now()+interval '7 days',
      payload=payload || jsonb_build_object('submissionError',$2::text) WHERE id=$1::uuid`, [batch.draft_id, message]);
    // A definitive rejection is the only case where the admitted attempt may be discarded.
    if (batch.sync_status === "failed" && !batch.attempted_at && !batch.netsuite_transaction_id) {
      await writeAudit({ actorOperatorId, source: "returns", action: "returns.submission.rejected",
        details: { batchId: Number(batchId), externalId: batch.external_id, draftId: batch.draft_id, error: message } });
      await query("DELETE FROM return_batches WHERE id=$1", [batchId]);
    }
    return batch.draft_id;
  });
}

// @ts-check
import crypto from "node:crypto";
import { query, withTransaction } from "./db.js";
import { postingPhotoIdentity, replacePostingPhoto } from "./operator-netsuite-posting-photos.js";
import { normalizeR2Key } from "./photo-upload.js";

/** @param {{commandId?: string, batchId?: string, photos: string[]}} input */
export async function enqueuePostingPhotos({ commandId, batchId, photos }) {
  for (const [index, ref] of photos.entries()) {
    if (!ref.startsWith("data:")) {continue;}
    await query(`INSERT INTO operator_posting_photo_uploads(command_id,batch_id,photo_index,photo_identity)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [commandId || null, batchId || null, index, postingPhotoIdentity(ref)]);
  }
}

/** @param {{ownerId?: string}} [options] */
export async function claimPostingPhoto({ ownerId } = {}) {
  return withTransaction(async () => {
    const result = await query(`SELECT p.*,coalesce(c.actor_operator_id,b.operator_id) AS actor,
        coalesce(c.function_key,'delivery_prep') AS function_key,coalesce(c.transaction_type,'IF') AS transaction_type,
        coalesce(c.photo_refs,b.photo_refs)->>p.photo_index AS photo_ref,
        coalesce(c.input_snapshot->'localOperation',jsonb_build_object('kind','delivery_consolidation_load','orderId',b.id,'orderType','consolidation_load')) AS operation,
        coalesce(c.result->'localFinalization',b.result) AS local_result
      FROM operator_posting_photo_uploads p
      LEFT JOIN operator_netsuite_posting_commands c ON c.id=p.command_id
      LEFT JOIN operator_consolidated_loads b ON b.id=p.batch_id
      WHERE ((p.status='pending' AND p.next_attempt_at<=now()) OR (p.status='uploading' AND p.lease_expires_at<=now()))
        AND coalesce(c.status,b.status)='completed'
        AND ($1::uuid IS NULL OR coalesce(p.command_id,p.batch_id)=$1)
      ORDER BY p.next_attempt_at,p.id LIMIT 1 FOR UPDATE OF p SKIP LOCKED`, [ownerId || null]);
    const row = result.rows[0];
    if (!row) {return null;}
    const leaseToken = crypto.randomUUID();
    await query(`UPDATE operator_posting_photo_uploads SET status='uploading',lease_token=$2,
      lease_expires_at=now()+interval '120 seconds',attempt_count=attempt_count+1 WHERE id=$1`, [row.id, leaseToken]);
    return { id: String(row.id), commandId: row.command_id, batchId: row.batch_id,
      photoIndex: row.photo_index, photoRef: row.photo_ref, photoIdentity: row.photo_identity,
      actorOperatorId: row.actor, functionKey: row.function_key, transactionType: row.transaction_type,
      operation: row.operation, localResult: row.local_result, leaseToken, attemptCount: row.attempt_count + 1 };
  });
}

/** @param {any} value @returns {string[]} */
function loadIds(value) {
  const own = /^\d+$/.test(String(value?.id)) ? [String(value.id)] : [];
  return [...new Set([...own, ...(value?.sourceLoadRecords || []).flatMap(loadIds)])];
}

/** @param {Record<string,any>} job @param {string} ref */
async function replaceLocalProof(job, ref) {
  const records = await query(`SELECT id,photo_data_url,photo_data_urls FROM operator_load_records
    WHERE id=ANY($1::bigint[]) OR ($2::text IS NOT NULL AND response->'operatorNetSuitePosting'->>'commandId'=$2)
    FOR UPDATE`, [job.transactionType === "IF" ? loadIds(job.localResult) : [], job.commandId]);
  for (const row of records.rows) {
    await query("UPDATE operator_load_records SET photo_data_url=$2,photo_data_urls=$3 WHERE id=$1", [row.id,
      row.photo_data_url === job.photoRef ? ref : row.photo_data_url,
      JSON.stringify(replacePostingPhoto(row.photo_data_urls, job.photoRef, ref))]);
  }
  if (job.commandId) {
    const receipts = await query(`SELECT id,photo_data_urls FROM receiving_receipt_records
      WHERE response->'operatorNetSuitePosting'->>'commandId'=$1 FOR UPDATE`, [job.commandId]);
    for (const row of receipts.rows) {
      await query("UPDATE receiving_receipt_records SET photo_data_urls=$2 WHERE id=$1", [row.id, JSON.stringify(replacePostingPhoto(row.photo_data_urls, job.photoRef, ref))]);
    }
  }
  const batches = await query("SELECT id,photo_refs FROM operator_consolidated_loads WHERE id=$1 OR command_id=$2 FOR UPDATE", [job.batchId, job.commandId]);
  for (const row of batches.rows) {
    await query("UPDATE operator_consolidated_loads SET photo_refs=$2 WHERE id=$1", [row.id, JSON.stringify(replacePostingPhoto(row.photo_refs, job.photoRef, ref))]);
  }
}

/** @param {Record<string,any>} job @param {string} ref */
export async function completePostingPhoto(job, ref) {
  if (!ref.startsWith("r2://") || !normalizeR2Key(ref)) {throw new Error("A valid uploaded photo reference is required.");}
  return withTransaction(async () => {
    const active = await query(`SELECT id FROM operator_posting_photo_uploads
      WHERE id=$1 AND status='uploading' AND lease_token=$2 AND lease_expires_at>now() FOR UPDATE`, [job.id, job.leaseToken]);
    if (!active.rowCount) {return false;}
    if (postingPhotoIdentity(job.photoRef) !== job.photoIdentity) {throw new Error("Staged photo identity changed.");}
    if (job.commandId) {
      const command = (await query("SELECT photo_refs FROM operator_netsuite_posting_commands WHERE id=$1 AND status='completed' FOR UPDATE", [job.commandId])).rows[0];
      if (!command || command.photo_refs[job.photoIndex] !== job.photoRef) {throw new Error("Staged photo reference changed.");}
      await query("UPDATE operator_netsuite_posting_commands SET photo_refs=$2 WHERE id=$1", [job.commandId, JSON.stringify(replacePostingPhoto(command.photo_refs, job.photoRef, ref))]);
    }
    if (job.batchId) {
      const batch = (await query("SELECT photo_refs FROM operator_consolidated_loads WHERE id=$1 AND status='completed' FOR UPDATE", [job.batchId])).rows[0];
      if (!batch || batch.photo_refs[job.photoIndex] !== job.photoRef) {throw new Error("Staged photo reference changed.");}
    }
    await replaceLocalProof(job, ref);
    await query(`UPDATE operator_posting_photo_uploads SET status='uploaded',r2_ref=$3,uploaded_at=now(),
      lease_token=NULL,lease_expires_at=NULL,last_error=NULL WHERE id=$1 AND lease_token=$2`, [job.id, job.leaseToken, ref]);
    return true;
  });
}

/** @param {Record<string,any>} job @param {any} error */
export async function failPostingPhoto(job, error) {
  const code = String(error?.code || "PHOTO_UPLOAD_FAILED");
  const delaySeconds = Math.min(3600, 10 * 2 ** Math.min(job.attemptCount, 9));
  await query(`UPDATE operator_posting_photo_uploads SET status='pending',lease_token=NULL,lease_expires_at=NULL,
    next_attempt_at=now()+($3::integer*interval '1 second'),last_error=$4
    WHERE id=$1 AND status='uploading' AND lease_token=$2`, [job.id, job.leaseToken, delaySeconds,
    /^[A-Z0-9_]{1,80}$/.test(code) ? code : "PHOTO_UPLOAD_FAILED"]);
}

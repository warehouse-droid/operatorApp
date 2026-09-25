// @ts-check
import crypto from "node:crypto";
import { query, withTransaction } from "./db.js";
import { assertOperatorYard } from "./operator-yard-access.js";
import { normalizeR2Key } from "./photo-upload.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** @param {string} message @param {number} [status] */
function invalid(message, status = 400) { return Object.assign(new Error(message), { status, code: "OPERATOR_BACKGROUND_PHOTO_INVALID" }); }
/** @param {unknown} value */
export function isBackgroundPhotoReference(value) {
  return typeof value === "string" && value.startsWith("operator-photo://") && UUID.test(value.slice(17));
}
/** @param {any} values @param {number} [minimum] */
export function validateBackgroundPhotoManifest(values, minimum = 2) {
  if (!Array.isArray(values) || values.length < minimum || values.length > 20) throw invalid(`At least ${minimum} photos are required (maximum 20).`);
  let total = 0; const ids = new Set();
  return values.map(value => {
    if (!value || !UUID.test(value.id) || ids.has(value.id) || !/^[0-9a-f]{64}$/.test(value.sha256)
        || !Number.isInteger(value.byteSize) || value.byteSize < 1 || value.byteSize > 10 * 1024 * 1024
        || !/^image\/(jpeg|png|webp|heic|heif)$/.test(value.mimeType)) throw invalid("Photo identity, size or type is invalid.");
    ids.add(value.id); total += value.byteSize;
    if (total > 16 * 1024 * 1024) throw invalid("Photos are too large. Retake fewer or smaller photos.");
    return { id: value.id, sha256: value.sha256, byteSize: value.byteSize, mimeType: value.mimeType };
  });
}

/** @param {any} input @param {(refs: string[]) => Promise<any>} run */
export async function withOperatorPhotoAction(input, run) {
  if (input.backgroundPhotos === undefined) return run(input.legacyPhotos);
  const photos = validateBackgroundPhotoManifest(input.backgroundPhotos, input.minimum ?? 2);
  if (!UUID.test(input.requestId)) throw invalid("A valid photo request ID is required.");
  const locationId = assertOperatorYard(input.actor, input.locationId);
  const identity = [input.actor.id, locationId, input.functionKey, String(input.orderId), input.orderType || "", photos];
  const inputHash = crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return withTransaction(async () => {
    // Serialize retries before invoking any quantity-changing work.
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`operator-photo-action:${input.requestId}`]);
    const existing = (await query("SELECT input_hash,result FROM operator_photo_actions WHERE id=$1", [input.requestId])).rows[0];
    if (existing) {
      if (existing.input_hash !== inputHash) throw invalid("This confirmation already has different photos or an order.", 409);
      return existing.result;
    }
    await query(`INSERT INTO operator_photo_actions(id,operator_id,location_id,function_key,order_id,order_type,input_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [input.requestId, input.actor.id, locationId, input.functionKey, String(input.orderId), input.orderType || "", inputHash]);
    for (const [index, photo] of photos.entries()) {
      await query(`INSERT INTO operator_background_photos(id,action_id,photo_index,sha256,byte_size,mime_type)
        VALUES($1,$2,$3,$4,$5,$6)`, [photo.id, input.requestId, index, photo.sha256, photo.byteSize, photo.mimeType]);
    }
    const result = await run(photos.map(photo => `operator-photo://${photo.id}`));
    await query("UPDATE operator_photo_actions SET result=$2 WHERE id=$1", [input.requestId, JSON.stringify(result)]);
    return result;
  });
}

/** @param {string} id */
export async function getBackgroundPhoto(id) {
  if (!UUID.test(id)) throw invalid("Photo not found.", 404);
  const photo = (await query(`SELECT p.*,a.operator_id,a.location_id,a.function_key,a.order_id,a.order_type
    FROM operator_background_photos p JOIN operator_photo_actions a ON a.id=p.action_id WHERE p.id=$1`, [id])).rows[0];
  if (!photo) throw invalid("Photo not found.", 404);
  return photo;
}
/** @param {any} actor @param {string} id */
export async function getBackgroundPhotoAction(actor, id) {
  if (!UUID.test(id)) throw invalid("Photo confirmation not found.", 404);
  const action = (await query("SELECT location_id FROM operator_photo_actions WHERE id=$1 AND operator_id=$2", [id, actor.id])).rows[0];
  if (!action) throw invalid("Photo confirmation not found.", 404);
  assertOperatorYard(actor, action.location_id);
  const photos = (await query("SELECT id,sha256,status FROM operator_background_photos WHERE action_id=$1 ORDER BY photo_index", [id])).rows;
  return { id, photos };
}
/** @param {any} actor @param {string} id @param {Buffer} bytes */
export async function receiveBackgroundPhoto(actor, id, bytes) {
  const photo = await getBackgroundPhoto(id);
  if (photo.operator_id !== actor.id) throw invalid("Photo not found.", 404);
  assertOperatorYard(actor, photo.location_id);
  if (!Buffer.isBuffer(bytes) || bytes.length !== photo.byte_size
      || crypto.createHash("sha256").update(bytes).digest("hex") !== photo.sha256) throw invalid("Photo bytes do not match the accepted photo.");
  // The hash fixes identity across concurrent transfers and lost acknowledgments.
  await query(`UPDATE operator_background_photos SET bytes=$2,status='pending',received_at=now()
    WHERE id=$1 AND status='waiting'`, [id, bytes]);
  return { id, sha256: photo.sha256, stored: true };
}
/** @param {{actionId?: string}} [options] */
export async function claimBackgroundPhoto({ actionId } = {}) {
  return withTransaction(async () => {
    const photo = (await query(`SELECT p.*,a.operator_id,a.function_key,a.order_id,a.order_type
      FROM operator_background_photos p JOIN operator_photo_actions a ON a.id=p.action_id
      WHERE ((p.status='pending' AND p.next_attempt_at<=now()) OR (p.status='uploading' AND p.lease_expires_at<=now()))
        AND ($1::uuid IS NULL OR p.action_id=$1)
      ORDER BY p.next_attempt_at,p.id LIMIT 1 FOR UPDATE OF p SKIP LOCKED`, [actionId || null])).rows[0];
    if (!photo) return null;
    const leaseToken = crypto.randomUUID();
    await query(`UPDATE operator_background_photos SET status='uploading',lease_token=$2,
      lease_expires_at=now()+interval '120 seconds',attempt_count=attempt_count+1 WHERE id=$1`, [photo.id, leaseToken]);
    return { id: photo.id, commandId: photo.action_id, actorOperatorId: photo.operator_id, functionKey: photo.function_key,
      transactionType: photo.function_key === "receiving" ? "IR" : "IF", attemptCount: photo.attempt_count + 1, leaseToken,
      operation: { orderId: photo.order_id, orderType: photo.order_type,
        kind: photo.order_type === "consolidation_load" ? "delivery_consolidation_load" : photo.function_key },
      photoRef: `data:${photo.mime_type};base64,${photo.bytes.toString("base64")}` };
  });
}
/** @param {any} job @param {string} ref */
export async function completeBackgroundPhoto(job, ref) {
  if (!ref.startsWith("r2://") || normalizeR2Key(ref) !== ref.slice(5)) throw invalid("Invalid uploaded photo reference.");
  const result = await query(`UPDATE operator_background_photos SET status='uploaded',r2_ref=$3,uploaded_at=now(),bytes=NULL,
    lease_token=NULL,lease_expires_at=NULL,last_error=NULL WHERE id=$1 AND status='uploading' AND lease_token=$2 AND lease_expires_at>now()`, [job.id, job.leaseToken, ref]);
  return result.rowCount === 1;
}
/** @param {any} job @param {any} error */
export async function failBackgroundPhoto(job, error) {
  const code = /^[A-Z0-9_]{1,80}$/.test(error?.code) ? error.code : "PHOTO_UPLOAD_FAILED";
  const delay = Math.min(3600, 10 * 2 ** Math.min(job.attemptCount, 9));
  await query(`UPDATE operator_background_photos SET status='pending',lease_token=NULL,lease_expires_at=NULL,
    next_attempt_at=now()+($3::integer*interval '1 second'),last_error=$4
    WHERE id=$1 AND status='uploading' AND lease_token=$2`, [job.id, job.leaseToken, delay, code]);
}

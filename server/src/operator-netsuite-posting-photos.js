// @ts-check
import crypto from "node:crypto";
import { createPhotoUploadToken, normalizeR2Key } from "./photo-upload.js";
import { operatorPostingTelemetry } from "./operator-netsuite-posting-telemetry.js";

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
/** @param {string} message */
function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: "OPERATOR_PHOTO_INVALID" });
}
/** @param {unknown} value @param {{maxBytes?: number}} [options] */
export function parsePostingPhoto(value, { maxBytes = MAX_PHOTO_BYTES } = {}) {
  const ref = String(value || "");
  if (ref.startsWith("r2://")) {return null;}
  if (ref.length > Math.ceil(maxBytes / 3) * 4 + 80) {throw invalid("Photo is too large.");}
  const match = /^data:(image\/(?:jpeg|png|webp|heic|heif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(ref);
  if (!match) {throw invalid("Photo must contain supported base64 image data.");}
  const encoded = /** @type {string} */ (match[2]);
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.toString("base64") !== encoded) {throw invalid("Photo base64 data is invalid.");}
  if (bytes.length > maxBytes) {throw invalid("Photo is too large.");}
  return { bytes, mimeType: /** @type {string} */ (match[1]), sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}
/** @param {string} ref */
export function postingPhotoIdentity(ref) {
  if (!ref.startsWith("data:")) {return ref;}
  parsePostingPhoto(ref);
  return `sha256:${crypto.createHash("sha256").update(ref).digest("hex")}`;
}
/** @param {string[]} photos */
export function validatePostingPhotos(photos) {
  let total = 0;
  for (const ref of photos) {
    if (ref.startsWith("data:")) {total += parsePostingPhoto(ref)?.bytes.length || 0;}
  }
  if (total > 16 * 1024 * 1024 || photos.length > 20) {throw invalid("Photos are too large. Retake fewer or smaller photos.");}
}
/** @param {string[]} photos @param {string} original @param {string} replacement */
export function replacePostingPhoto(photos, original, replacement) {
  return photos.map((ref) => ref === original ? replacement : ref);
}

/** @param {Record<string, any>} job */
function photoRecordType(job) {
  if (job.operation?.kind === "delivery_consolidation_load" || job.batchId) {return "operator-consolidation-load-photo";}
  if (job.functionKey === "receiving") {return "operator-receiving-photo";}
  return job.functionKey === "customer_pickup" ? "operator-customer-pickup-photo" : "operator-load-photo";
}
/** @param {Record<string, any>} job @param {NonNullable<ReturnType<typeof parsePostingPhoto>>} image */
function ticketInput(job, image) {
  return { actor: { id: job.actorOperatorId, role: "operator" }, source: "operator", recordType: photoRecordType(job),
    metadata: { orderId: job.operation?.orderId || job.batchId, orderType: job.operation?.orderType,
      jobId: job.commandId || job.batchId, photoId: String(job.id), sha256: image.sha256, byteSize: image.bytes.length, mimeType: image.mimeType } };
}
/** @param {string} text @param {string | undefined} prefix */
function uploadedPhotoKey(text, prefix) {
  let key;
  try {key = JSON.parse(text)?.key;} catch {throw invalid("Photo upload returned no valid object key.");}
  if (typeof key !== "string" || normalizeR2Key(key) !== key || !key || (prefix && !key.startsWith(`${prefix}/`))) {
    throw invalid("Photo upload returned an invalid object key.");
  }
  return `r2://${key}`;
}

/** @param {Record<string, any>} job @param {{ticket?: Function, fetch?: typeof fetch}} [dependencies] */
export async function uploadPostingPhoto(job, { ticket = createPhotoUploadToken, fetch: transport = fetch } = {}) {
  const image = parsePostingPhoto(job.photoRef);
  if (!image) {return job.photoRef;}
  const credentials = ticket(ticketInput(job, image));
  const body = new FormData();
  body.append("file", new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), `photo-${job.id}.${image.mimeType.split("/")[1]}`);
  const result = await operatorPostingTelemetry.time({ operation: "photo.r2", method: "POST", path: "/upload", attempt: job.attemptCount, photoId: String(job.id) }, async () => {
    const response = await transport(credentials.uploadUrl, {
      method: "POST", headers: { Authorization: `Bearer ${credentials.token}` }, body, signal: AbortSignal.timeout(60000)
    });
    return { response, text: await response.text() };
  });
  if (!result.response.ok) {
    throw Object.assign(new Error(`Photo upload failed (HTTP ${result.response.status}).`), { status: result.response.status, code: "PHOTO_UPLOAD_FAILED" });
  }
  return uploadedPhotoKey(result.text, credentials.metadata?.keyPrefix);
}

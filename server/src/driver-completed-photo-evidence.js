import crypto from "node:crypto";

import { normalizeR2Key } from "./photo-upload.js";

export const DRIVER_COMPLETED_VISIT_MAX_PHOTOS = 20;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

function evidenceError(message, code = "DRIVER_COMPLETED_PHOTO_INVALID", status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function boundedText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function enumValue(value, aliases, fallback) {
  const key = String(value || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  return aliases.get(key) || fallback;
}

export function normalizeDriverCompletedVisitFilters(value = {}) {
  return {
    status: enumValue(value.status, new Map([
      ["complete", "complete"], ["completed", "complete"],
      ["in_progress", "in_progress"], ["inprogress", "in_progress"],
      ["all", "all"]
    ]), "all"),
    driverLogin: boundedText(value.driverLogin, 240).toLowerCase(),
    stopType: enumValue(value.stopType, new Map([
      ["pickup", "pickup"], ["pick", "pickup"],
      ["dropoff", "dropoff"], ["drop", "dropoff"],
      ["all", "all"]
    ]), "all"),
    photoState: enumValue(value.photoState, new Map([
      ["none", "none"],
      ["below_required", "below_required"],
      ["below_requirement", "below_required"],
      ["has_photos", "has_photos"],
      ["at_limit", "at_limit"],
      ["all", "all"]
    ]), "all"),
    completionSource: enumValue(value.completionSource, new Map([
      ["driver_online", "driver_online"],
      ["driver_offline", "driver_offline"],
      ["dispatch_historical_assist", "dispatch_historical_assist"],
      ["legacy_unknown", "legacy_unknown"],
      ["mixed", "mixed"],
      ["all", "all"]
    ]), "all"),
    q: boundedText(value.q, 240),
    cursor: Math.max(0, Number.isSafeInteger(Number(value.cursor)) ? Number(value.cursor) : 0),
    limit: Math.min(200, Math.max(1, Number.isSafeInteger(Number(value.limit)) ? Number(value.limit) : 50))
  };
}

function recordCompletionSource(record = {}) {
  const details = record.job_details && typeof record.job_details === "object" ? record.job_details : {};
  if (details.completionSource === "dispatch_historical_assist") {
    return "dispatch_historical_assist";
  }
  if (record.source_offline_event_id) {
    return "driver_offline";
  }
  if (Number(details.schemaVersion || 0) >= 1) {
    return "driver_online";
  }
  return "legacy_unknown";
}

export function driverCompletedVisitSource(records = []) {
  const sources = new Set((Array.isArray(records) ? records : []).map(recordCompletionSource));
  if (!sources.size) {
    return "legacy_unknown";
  }
  return sources.size === 1 ? [...sources][0] : "mixed";
}

export function physicalVisitMemberJobIds(record = {}) {
  const jobId = boundedText(record.job_id ?? record.jobId, 1000);
  if (!jobId) {
    throw evidenceError("Driver job ID is required.", "DRIVER_COMPLETED_VISIT_DECLARATION_INVALID");
  }
  const details = record.job_details && typeof record.job_details === "object"
    ? record.job_details
    : record.jobDetails && typeof record.jobDetails === "object"
      ? record.jobDetails
      : {};
  if (!Array.isArray(details.physicalVisitJobIds) || !details.physicalVisitJobIds.length) {
    return [jobId];
  }
  const seen = new Set();
  const jobIds = details.physicalVisitJobIds
    .map((value) => boundedText(value, 1000))
    .filter((value) => value && !seen.has(value) && seen.add(value))
    .slice(0, 500);
  if (!jobIds.includes(jobId)) {
    throw evidenceError(
      "The physical-visit declaration does not contain its own Driver job.",
      "DRIVER_COMPLETED_VISIT_DECLARATION_INVALID",
      409
    );
  }
  return jobIds;
}

export function uniqueDriverPhotoReferences(values = []) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter((value) => value.startsWith("r2://") && normalizeR2Key(value))
    .filter((value) => !seen.has(value) && seen.add(value));
}

export function mergeDriverCompletedVisitPhotos({ existing = [], added = [] } = {}) {
  const merged = uniqueDriverPhotoReferences([
    ...uniqueDriverPhotoReferences(existing),
    ...uniqueDriverPhotoReferences(added)
  ]);
  if (merged.length > DRIVER_COMPLETED_VISIT_MAX_PHOTOS) {
    throw evidenceError(
      `A physical visit can contain at most ${DRIVER_COMPLETED_VISIT_MAX_PHOTOS} photos.`,
      "DRIVER_COMPLETED_PHOTO_LIMIT",
      409
    );
  }
  return merged;
}

function canonicalValue(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  return value;
}

function memberRecordSortKey(record = {}) {
  const id = record?.id ?? "";
  const jobId = record?.jobId ?? record?.job_id ?? "";
  return `${String(id).padStart(24, "0")}|${jobId}`;
}

export function driverCompletedVisitStateHash(value = {}) {
  const memberRecords = (Array.isArray(value.memberRecords) ? value.memberRecords : [])
    .map(canonicalValue)
    .sort((left, right) => memberRecordSortKey(left).localeCompare(memberRecordSortKey(right)));
  return crypto.createHash("sha256").update(JSON.stringify(canonicalValue({
    ...value,
    memberRecords,
    photos: uniqueDriverPhotoReferences(value.photos)
  }))).digest("hex");
}

function requiredUuid(value, label) {
  const text = boundedText(value, 64).toLowerCase();
  if (!UUID_PATTERN.test(text)) {
    throw evidenceError(`${label} must be a UUID.`, "DRIVER_COMPLETED_PHOTO_ID_INVALID");
  }
  return text;
}

function descriptorOrdinal(raw) {
  const ordinal = Number(raw?.ordinal);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > DRIVER_COMPLETED_VISIT_MAX_PHOTOS) {
    throw evidenceError("Photo ordinal is invalid.", "DRIVER_COMPLETED_PHOTO_ORDINAL_INVALID");
  }
  return ordinal;
}

function descriptorByteSize(raw) {
  const byteSize = Number(raw?.byteSize);
  if (!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > MAX_PHOTO_BYTES) {
    throw evidenceError(
      "Each compressed photo must be between 1 byte and 2 MB.",
      "DRIVER_COMPLETED_PHOTO_SIZE_INVALID"
    );
  }
  return byteSize;
}

function descriptorSha256(raw) {
  const sha256 = String(raw?.sha256 || "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) {
    throw evidenceError("Photo SHA-256 is invalid.", "DRIVER_COMPLETED_PHOTO_SHA_INVALID");
  }
  return sha256;
}

function descriptorMimeType(raw) {
  const mimeType = String(raw?.mimeType || "").trim().toLowerCase();
  if (mimeType !== "image/jpeg") {
    throw evidenceError(
      "Completed-stop evidence accepts compressed JPEG photos only.",
      "DRIVER_COMPLETED_PHOTO_MIME_INVALID"
    );
  }
  return mimeType;
}

function descriptorObjectReference(raw, requireReferences) {
  const objectReference = String(raw?.objectReference || "").trim();
  if (requireReferences && !objectReference) {
    throw evidenceError("Uploaded photo reference is required.", "DRIVER_COMPLETED_PHOTO_REFERENCE_REQUIRED");
  }
  return objectReference;
}

function descriptor(raw, requireReferences) {
  return {
    photoId: requiredUuid(raw?.photoId, "Photo ID"),
    ordinal: descriptorOrdinal(raw),
    byteSize: descriptorByteSize(raw),
    sha256: descriptorSha256(raw),
    mimeType: descriptorMimeType(raw),
    objectReference: descriptorObjectReference(raw, requireReferences)
  };
}

export function normalizeDriverCompletedPhotoDescriptors(value, { requireReferences = false } = {}) {
  if (!Array.isArray(value)) {
    throw evidenceError("Photos must be an array.");
  }
  if (value.length > DRIVER_COMPLETED_VISIT_MAX_PHOTOS) {
    throw evidenceError(
      `A physical visit can contain at most ${DRIVER_COMPLETED_VISIT_MAX_PHOTOS} photos.`,
      "DRIVER_COMPLETED_PHOTO_LIMIT"
    );
  }
  const photoIds = new Set();
  const ordinals = new Set();
  return value.map((raw) => descriptor(raw, requireReferences)).map((photo) => {
    if (photoIds.has(photo.photoId) || ordinals.has(photo.ordinal)) {
      throw evidenceError("Photo IDs and ordinals must be unique.", "DRIVER_COMPLETED_PHOTO_DUPLICATE");
    }
    photoIds.add(photo.photoId);
    ordinals.add(photo.ordinal);
    return photo;
  }).sort((left, right) => left.ordinal - right.ordinal);
}

export function driverCompletedPhotoReferenceMatches(value, { requestId = "", photoId = "", recordType = "" } = {}) {
  const original = String(value || "").trim();
  if (!original.startsWith("r2://")) {
    return false;
  }
  const key = normalizeR2Key(original);
  const parts = key ? key.split("/") : [];
  return [
    parts.length >= 7,
    parts[0] === "dispatch-stop-evidence",
    parts[1] === String(recordType || ""),
    /^\d{4}$/.test(parts[2] || ""),
    /^(0[1-9]|1[0-2])$/.test(parts[3] || ""),
    /^(0[1-9]|[12]\d|3[01])$/.test(parts[4] || ""),
    parts[5] === `${requestId}-${photoId}`
  ].every(Boolean);
}

export function retainedDriverPhotoRequirement({
  configuredRequiredPhotos = 0,
  retainedPhotos = [],
  minimumRequiredPhotos = 2
} = {}) {
  const configured = Math.max(0, Math.floor(Number(configuredRequiredPhotos) || 0));
  const minimum = Math.max(0, Math.floor(Number(minimumRequiredPhotos) || 0));
  const requiredPhotos = configured === 0 ? 0 : Math.max(minimum, configured);
  const retainedPhotoCount = uniqueDriverPhotoReferences(retainedPhotos).length;
  return {
    requiredPhotos,
    retainedPhotoCount,
    remainingRequiredPhotos: Math.max(0, requiredPhotos - retainedPhotoCount),
    maxPhotos: DRIVER_COMPLETED_VISIT_MAX_PHOTOS
  };
}

import crypto from "node:crypto";

import { HISTORICAL_ASSIST_MAX_PHOTOS } from "./driver-historical-assist-policy.js";
import { normalizeR2Key } from "./photo-upload.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

function evidenceError(message) {
  return Object.assign(new Error(message), {
    status: 400,
    code: "HISTORICAL_ASSIST_INVALID"
  });
}

function requiredText(value, label, maxLength = 2000) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw evidenceError(`${label} is required.`);
  }
  if (text.length > maxLength) {
    throw evidenceError(`${label} is too long.`);
  }
  return text;
}

function uuidValue(value, label) {
  const text = requiredText(value, label, 64).toLowerCase();
  if (!UUID_PATTERN.test(text)) {
    throw evidenceError(`${label} must be a UUID.`);
  }
  return text;
}

function integerInRange(value, minimum, maximum, message) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw evidenceError(message);
  }
  return number;
}

function normalizedSha256(value) {
  const sha256 = String(value || "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) {
    throw evidenceError("Photo SHA-256 is invalid.");
  }
  return sha256;
}

function normalizedMimeType(value) {
  const mimeType = String(value || "").trim().toLowerCase();
  if (mimeType !== "image/jpeg") {
    throw evidenceError("Historical completion accepts compressed JPEG photos only.");
  }
  return mimeType;
}

function normalizedObjectReference(value, requireReferences) {
  const objectReference = String(value || "").trim();
  if (requireReferences && !objectReference) {
    throw evidenceError("Uploaded photo reference is required.");
  }
  return objectReference;
}

function normalizedDescriptor(raw, requireReferences) {
  return {
    photoId: uuidValue(raw?.photoId, "Photo ID"),
    ordinal: integerInRange(
      raw?.ordinal,
      1,
      HISTORICAL_ASSIST_MAX_PHOTOS,
      "Photo ordinal is invalid."
    ),
    byteSize: integerInRange(
      raw?.byteSize,
      1,
      MAX_PHOTO_BYTES,
      "Each compressed photo must be between 1 byte and 2 MB."
    ),
    sha256: normalizedSha256(raw?.sha256),
    mimeType: normalizedMimeType(raw?.mimeType),
    objectReference: normalizedObjectReference(raw?.objectReference, requireReferences)
  };
}

function assertUniqueDescriptor(descriptor, photoIds, ordinals) {
  if (photoIds.has(descriptor.photoId) || ordinals.has(descriptor.ordinal)) {
    throw evidenceError("Photo IDs and ordinals must be unique.");
  }
  photoIds.add(descriptor.photoId);
  ordinals.add(descriptor.ordinal);
  return descriptor;
}

export function normalizeHistoricalAssistPhotoDescriptors(value, { requireReferences = false } = {}) {
  if (!Array.isArray(value)) {
    throw evidenceError("Photos must be an array.");
  }
  if (value.length > HISTORICAL_ASSIST_MAX_PHOTOS) {
    throw evidenceError(`A stop can contain at most ${HISTORICAL_ASSIST_MAX_PHOTOS} photos.`);
  }
  const photoIds = new Set();
  const ordinals = new Set();
  return value
    .map((raw) => normalizedDescriptor(raw, requireReferences))
    .map((descriptor) => assertUniqueDescriptor(descriptor, photoIds, ordinals))
    .sort((left, right) => left.ordinal - right.ordinal);
}

function validHistoricalReferenceParts(parts, expectedSubject, recordType) {
  return [
    parts.length >= 7,
    parts[0] === "dispatch-assist",
    parts[1] === String(recordType || ""),
    /^\d{4}$/.test(parts[2] || ""),
    /^(0[1-9]|1[0-2])$/.test(parts[3] || ""),
    /^(0[1-9]|[12]\d|3[01])$/.test(parts[4] || ""),
    parts[5] === expectedSubject
  ].every(Boolean);
}

export function historicalAssistPhotoReferenceMatches(value, { requestId = "", photoId, recordType } = {}) {
  const original = String(value || "").trim();
  if (!original.startsWith("r2://")) {
    return false;
  }
  const key = normalizeR2Key(original);
  if (!key) {
    return false;
  }
  const expectedSubject = requestId ? `${requestId}-${photoId}` : String(photoId || "");
  return validHistoricalReferenceParts(key.split("/"), expectedSubject, recordType);
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

export function historicalAssistStateHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

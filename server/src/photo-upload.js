import crypto from "node:crypto";
import { config } from "./config.js";

const DEFAULT_ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf"
];

const RECORD_TYPES = new Set([
  "operator-load-photo",
  "operator-receiving-photo",
  "operator-co-receiving-photo",
  "operator-customer-pickup-photo",
  "operator-return-photo",
  "driver-dvir-pre-photo",
  "driver-dvir-post-photo",
  "driver-stop-photo",
  "driver-pickup-photo",
  "driver-dropoff-photo",
  "test-upload"
]);

export function photoUploadSettings() {
  const workerUrl = String(config.photoUpload?.workerUrl || "").replace(/\/+$/, "");
  return {
    provider: config.photoUpload?.provider || "local_data_url",
    workerUrl,
    uploadUrl: workerUrl ? `${workerUrl}/upload` : "",
    healthUrl: workerUrl ? `${workerUrl}/health` : "",
    tokenTtlMinutes: saneNumber(config.photoUpload?.tokenTtlMinutes, 45, 1, 60),
    maxMb: saneNumber(config.photoUpload?.maxMb, 10, 1, 50),
    maxBytes: saneNumber(config.photoUpload?.maxMb, 10, 1, 50) * 1024 * 1024,
    publicBaseUrl: String(config.photoUpload?.publicBaseUrl || "").replace(/\/+$/, ""),
    allowedTypes: DEFAULT_ALLOWED_TYPES
  };
}

export function createPhotoUploadToken({ actor, source, recordType, metadata = {}, options = {} } = {}) {
  const settings = photoUploadSettings();
  const secret = config.photoUpload?.tokenSecret || "";
  if (!settings.uploadUrl) throw httpError(503, "PHOTO_UPLOAD_WORKER_URL is not configured.");
  if (!secret) throw httpError(503, "PHOTO_UPLOAD_TOKEN_SECRET is not configured.");

  const normalizedRecordType = cleanValue(recordType || metadata.recordType || "operator-load-photo", 80);
  if (!RECORD_TYPES.has(normalizedRecordType)) throw httpError(400, "Unsupported upload record type.");

  const role = cleanValue(actor?.role || source || "operator", 40);
  const subject = cleanValue(actor?.id || actor?.login || actor?.username || "unknown", 120);
  const ttlMinutes = saneNumber(options.ttlMinutes || settings.tokenTtlMinutes, settings.tokenTtlMinutes, 1, 60);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlMinutes * 60;
  const maxBytes = Math.min(settings.maxBytes, saneNumber(options.maxBytes || settings.maxBytes, settings.maxBytes, 1, settings.maxBytes));
  const allowedTypes = Array.isArray(options.allowedTypes)
    ? [...new Set(options.allowedTypes
        .map((value) => cleanValue(value, 120).toLowerCase())
        .filter((value) => settings.allowedTypes.includes(value)))]
    : settings.allowedTypes;
  if (!allowedTypes.length) throw httpError(400, "At least one supported upload MIME type is required.");

  const claims = compactClaims({
    aud: "mbbs-r2-upload",
    scope: "photo-upload",
    iss: "mbbs-node-server",
    sub: subject,
    role,
    source: cleanValue(source || role, 40),
    recordType: normalizedRecordType,
    operatorId: actor?.operatorId || (role === "operator" || role === "admin" ? actor?.id : ""),
    driverId: actor?.driverId || actor?.login || "",
    orderType: metadata.orderType,
    orderId: metadata.orderId,
    orderRef: metadata.orderRef,
    lineId: metadata.lineId,
    stopId: metadata.stopId,
    planId: metadata.planId,
    loadId: metadata.loadId,
    jobId: metadata.jobId,
    dvirType: metadata.dvirType,
    manifestId: metadata.manifestId,
    eventId: metadata.eventId,
    photoId: metadata.photoId,
    deviceId: metadata.deviceId,
    sha256: metadata.sha256,
    declaredByteSize: metadata.byteSize,
    declaredMimeType: metadata.mimeType,
    keyPrefix: buildKeyPrefix({ source: source || role, recordType: normalizedRecordType, actor, metadata }),
    allowedTypes,
    maxBytes,
    iat: now,
    nbf: now - 5,
    exp: expiresAt,
    jti: crypto.randomUUID()
  });

  const token = signJwt(claims, secret);
  return {
    provider: "r2_worker",
    uploadUrl: settings.uploadUrl,
    token,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    ttlSeconds: ttlMinutes * 60,
    maxBytes,
    maxMb: Math.floor(maxBytes / 1024 / 1024),
    allowedTypes,
    publicBaseUrl: settings.publicBaseUrl,
    metadata: {
      recordType: claims.recordType,
      keyPrefix: claims.keyPrefix,
      source: claims.source,
      manifestId: claims.manifestId || "",
      eventId: claims.eventId || "",
      photoId: claims.photoId || ""
    }
  };
}

export function isJpegEvidenceBytes(value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array
      ? value
      : null;
  if (
    !bytes
    || bytes.length < 12
    || bytes[0] !== 0xff
    || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff
    || bytes[bytes.length - 1] !== 0xd9
  ) {
    return false;
  }

  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3,
    0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb,
    0xcd, 0xce, 0xcf
  ]);
  let offset = 2;
  let foundStartOfFrame = false;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return false;
    while (offset < bytes.length - 2 && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length - 2) return false;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length - 2) return false;
    if (startOfFrameMarkers.has(marker)) foundStartOfFrame = true;
    if (marker === 0xda) {
      return foundStartOfFrame && offset + segmentLength < bytes.length - 2;
    }
    offset += segmentLength;
  }
  return false;
}

export function createPhotoReadToken({ actor, key, options = {} } = {}) {
  const settings = photoUploadSettings();
  const secret = config.photoUpload?.tokenSecret || "";
  if (!settings.workerUrl) throw httpError(503, "PHOTO_UPLOAD_WORKER_URL is not configured.");
  if (!secret) throw httpError(503, "PHOTO_UPLOAD_TOKEN_SECRET is not configured.");
  const cleanKey = normalizeR2Key(key);
  if (!cleanKey) throw httpError(400, "R2 object key is required.");

  const ttlMinutes = saneNumber(options.ttlMinutes || 10, 10, 1, 60);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlMinutes * 60;
  const claims = compactClaims({
    aud: "mbbs-r2-upload",
    scope: "photo-read",
    iss: "mbbs-node-server",
    sub: cleanValue(actor?.id || actor?.login || actor?.username || "unknown", 120),
    role: cleanValue(actor?.role || "viewer", 40),
    key: cleanKey,
    iat: now,
    nbf: now - 5,
    exp: expiresAt,
    jti: crypto.randomUUID()
  });

  return {
    objectUrl: `${settings.workerUrl}/object?key=${encodeURIComponent(cleanKey)}`,
    token: signJwt(claims, secret),
    key: cleanKey,
    expiresAt: new Date(expiresAt * 1000).toISOString()
  };
}

export function createPhotoDeleteToken({ actor, key, options = {} } = {}) {
  const settings = photoUploadSettings();
  const secret = config.photoUpload?.tokenSecret || "";
  if (!settings.workerUrl) throw httpError(503, "PHOTO_UPLOAD_WORKER_URL is not configured.");
  if (!secret) throw httpError(503, "PHOTO_UPLOAD_TOKEN_SECRET is not configured.");
  const cleanKey = normalizeR2Key(key);
  if (!cleanKey) throw httpError(400, "R2 object key is required.");

  const ttlMinutes = saneNumber(options.ttlMinutes || 10, 10, 1, 60);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlMinutes * 60;
  const claims = compactClaims({
    aud: "mbbs-r2-upload",
    scope: "photo-delete",
    iss: "mbbs-node-server",
    sub: cleanValue(actor?.id || actor?.login || actor?.username || "unknown", 120),
    role: cleanValue(actor?.role || "system", 40),
    key: cleanKey,
    iat: now,
    nbf: now - 5,
    exp: expiresAt,
    jti: crypto.randomUUID()
  });

  return {
    objectUrl: `${settings.workerUrl}/object?key=${encodeURIComponent(cleanKey)}`,
    token: signJwt(claims, secret),
    key: cleanKey,
    expiresAt: new Date(expiresAt * 1000).toISOString()
  };
}

export function normalizeR2Key(value) {
  const text = String(value || "").replace(/^r2:\/\//, "").trim();
  if (!text || text.includes("..") || text.startsWith("/") || text.includes("\\")) return "";
  return text;
}

export function isR2PhotoReference(value) {
  return String(value || "").startsWith("r2://");
}

export function isOperatorReturnPhotoForActor(value, actorId) {
  const parts = normalizeR2Key(value).split("/");
  return parts.length >= 7
    && parts[0] === "operator"
    && parts[1] === "operator-return-photo"
    && /^\d{4}$/.test(parts[2])
    && /^(0[1-9]|1[0-2])$/.test(parts[3])
    && /^(0[1-9]|[12]\d|3[01])$/.test(parts[4])
    && parts[5] === safePathSegment(actorId);
}

export function publicPhotoUploadConfig() {
  const settings = photoUploadSettings();
  return {
    provider: config.photoUpload?.provider || "local_data_url",
    workerConfigured: Boolean(settings.uploadUrl),
    uploadUrl: settings.uploadUrl,
    tokenTtlMinutes: settings.tokenTtlMinutes,
    maxBytes: settings.maxBytes,
    maxMb: settings.maxMb,
    allowedTypes: settings.allowedTypes,
    publicBaseUrl: settings.publicBaseUrl
  };
}

function buildKeyPrefix({ source, recordType, actor, metadata }) {
  const date = new Date();
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const subject = metadata.photoId
    || metadata.orderRef
    || metadata.orderId
    || metadata.jobId
    || actor?.id
    || actor?.login
    || "general";
  if (recordType === "operator-return-photo") {
    return [
      safePathSegment(source || "app"),
      safePathSegment(recordType),
      yyyy,
      mm,
      dd,
      safePathSegment(actor?.id || actor?.login || "unknown"),
      safePathSegment(subject)
    ].filter(Boolean).join("/");
  }
  return [
    safePathSegment(source || "app"),
    safePathSegment(recordType || "photo"),
    yyyy,
    mm,
    dd,
    safePathSegment(subject)
  ].filter(Boolean).join("/");
}

function signJwt(claims, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = crypto.createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function cleanValue(value, maxLength = 512) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function compactClaims(values) {
  const claims = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && !value.length) continue;
    claims[key] = value;
  }
  return claims;
}

function safePathSegment(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function saneNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

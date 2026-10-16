/** @typedef {"authorizing" | "uploading" | "confirming" | "saving" | "reconciling" | "signature"} UploadStage */
/** @type {Set<UploadStage>} */
const STAGES = new Set(["authorizing", "uploading", "confirming", "saving", "reconciling", "signature"]);

/** @param {string} field */
function badField(field) {
  return Object.assign(new Error(`Invalid upload diagnostic ${field}.`), {status: 400, code: "DRIVER_UPLOAD_DIAGNOSTIC_INVALID"});
}

/** @param {unknown} value @param {number} limit */
function text(value, limit) {
  return redact(String(value || "")).slice(0, limit);
}

/** @param {unknown} value @param {string} field @param {number} max */
function integer(value, field, max) {
  const number = Number(value ?? 0);
  if (!Number.isInteger(number) || number < 0 || number > max) throw badField(field);
  return number;
}

/** @param {string} value */
function redact(value) {
  return value
    .replace(/\bBearer\s+[^\s]+/giu, "Bearer [redacted]")
    .replace(/\b(?:token|access_token|secret|signature|authorization|api[_-]?key)\s*[=:]\s*[^\s&;,]+/giu, "credential=[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted]")
    .replace(/data:[^\s,]*,[^\s]+/giu, "[image omitted]");
}

/** @param {unknown} value */
export function safeUploadFailureMessage(value) {
  return text(value || "Upload failed.", 1000);
}

/** @param {unknown} raw */
export function normalizeUploadFailure(raw) {
  const value = /** @type {Record<string, unknown>} */ (raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badField("body");
  const failureId = text(value.failureId, 100);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(failureId)) throw badField("failureId");
  const stage = /** @type {UploadStage} */ (text(value.stage, 20));
  if (!STAGES.has(stage)) throw badField("stage");
  const occurredAt = text(value.occurredAt, 40);
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(occurredAt) || !Number.isFinite(Date.parse(occurredAt))) throw badField("occurredAt");
  const planDate = text(value.planDate, 10);
  if (planDate && (!/^\d{4}-\d{2}-\d{2}$/u.test(planDate) || !Number.isFinite(Date.parse(`${planDate}T00:00:00Z`)))) throw badField("planDate");
  const byteSize = integer(value.byteSize, "byteSize", 50 * 1024 * 1024);
  const transferredBytes = integer(value.transferredBytes, "transferredBytes", byteSize);
  const outcome = text(value.outcome || "failed", 12);
  if (!["failed", "recovered"].includes(outcome)) throw badField("outcome");
  return {
    outcome, recoveryId: text(value.recoveryId, 100), requestId: text(value.requestId, 100),
    browserOnline: typeof value.browserOnline === "boolean" ? value.browserOnline : null,
    visibilityState: ["visible", "hidden", "prerender"].includes(String(value.visibilityState)) ? String(value.visibilityState) : "unknown",
    timeoutMs: integer(value.timeoutMs, "timeoutMs", 86400000), timerDelayMs: integer(value.timerDelayMs, "timerDelayMs", 86400000),
    failureId: failureId.toLowerCase(), stage, occurredAt: new Date(occurredAt).toISOString(),
    jobId: text(value.jobId, 1000), photoId: text(value.photoId, 160), planDate, recordType: text(value.recordType, 80),
    clientVersion: text(value.clientVersion, 80), assetVersion: text(value.assetVersion, 80),
    attempt: integer(value.attempt, "attempt", 1000000), byteSize, transferredBytes,
    percentage: value.percentage === null ? null : integer(value.percentage, "percentage", 100),
    elapsedMs: integer(value.elapsedMs, "elapsedMs", 24 * 60 * 60 * 1000),
    httpStatus: integer(value.httpStatus, "httpStatus", 599), errorCode: text(value.errorCode, 160),
    message: safeUploadFailureMessage(value.message), droppedLogCount: integer(value.droppedLogCount, "droppedLogCount", 1000000000)
  };
}

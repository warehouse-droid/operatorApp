import crypto from "node:crypto";

const RECORD_TYPES = new Map([
  ["salesorder", "sales_order"],
  ["sales_order", "sales_order"],
  ["salesord", "sales_order"],
  ["purchaseorder", "purchase_order"],
  ["purchase_order", "purchase_order"],
  ["purchord", "purchase_order"],
  ["transferorder", "transfer_order"],
  ["transfer_order", "transfer_order"],
  ["trnfrord", "transfer_order"]
]);

function text(value) {
  return String(value ?? "").trim();
}

function canonicalRecordType(value) {
  const key = text(value).toLowerCase().replace(/[\s-]+/gu, "_");
  return RECORD_TYPES.get(key) || RECORD_TYPES.get(key.replaceAll("_", "")) || "";
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, candidate]) => candidate !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, candidate]) => [key, stableValue(candidate)]));
}

function sanitizedPayload(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("NetSuite order webhook payload must be an object.");
  }
  const clean = structuredClone(payload);
  for (const key of Object.keys(clean)) {
    if (/^(?:secret|authorization|token|password|signature)$/iu.test(key)) delete clean[key];
  }
  return clean;
}

export function netSuiteWebhookPayloadHash(payload = {}) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(stableValue(sanitizedPayload(payload))))
    .digest("hex");
}

export function netSuiteWebhookEntityKey(payload = {}) {
  const recordType = canonicalRecordType(payload.recordType || payload.type || payload.orderType);
  if (!recordType) throw new TypeError("A supported NetSuite order webhook record type is required.");
  const id = text(payload.id || payload.netsuiteOrderId || payload.netsuite_id);
  if (!id) throw new TypeError("A NetSuite order webhook ID is required.");
  if (id.length > 120) throw new TypeError("NetSuite order webhook ID is too long.");
  return `${recordType}:${id.toLowerCase()}`;
}

function sourceModifiedAt(payload = {}) {
  const candidate = text(
    payload.lastModifiedDate
    || payload.lastModifiedAt
    || payload.last_modified_date
    || payload.last_modified_at
  );
  if (!candidate) return null;
  const parsed = new Date(candidate);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError("NetSuite order webhook modification time is invalid.");
  }
  return parsed.toISOString();
}

export function normalizeNetSuiteWebhookEnvelope({ payload = {}, rawBody = "" } = {}) {
  const cleanPayload = sanitizedPayload(payload);
  const entityKey = netSuiteWebhookEntityKey(cleanPayload);
  const recordType = entityKey.split(":", 1)[0];
  const payloadHash = netSuiteWebhookPayloadHash(cleanPayload);
  const canonicalRawBody = JSON.stringify(stableValue(cleanPayload));
  return {
    entityKey,
    recordType,
    netsuiteOrderId: text(cleanPayload.id || cleanPayload.netsuiteOrderId || cleanPayload.netsuite_id),
    eventType: text(cleanPayload.eventType || cleanPayload.event_type).toLowerCase(),
    sourceModifiedAt: sourceModifiedAt(cleanPayload),
    payloadHash,
    payload: cleanPayload,
    // The exact request bytes may contain a legacy body secret. Store the full
    // semantic document in canonical form after credential removal instead.
    rawBody: canonicalRawBody,
    receivedBytes: Buffer.byteLength(text(rawBody) || canonicalRawBody, "utf8")
  };
}

export function compareNetSuiteWebhookVersions(left = {}, right = {}) {
  const leftTime = Date.parse(left.sourceModifiedAt || "") || 0;
  const rightTime = Date.parse(right.sourceModifiedAt || "") || 0;
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  const leftHash = text(left.payloadHash);
  const rightHash = text(right.payloadHash);
  return leftHash === rightHash ? 0 : leftHash < rightHash ? -1 : 1;
}

export function webhookRetryDelayMs(attemptNumber) {
  const attempt = Math.max(1, Math.floor(Number(attemptNumber) || 1));
  return Math.min(300_000, 1_000 * (2 ** Math.min(attempt - 1, 18)));
}

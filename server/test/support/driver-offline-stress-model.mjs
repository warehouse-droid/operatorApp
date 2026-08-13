// @ts-check

import { createHash } from "node:crypto";

/** @typedef {Record<string, unknown> & { eventId: string }} LogicalEventInput */
/** @typedef {{ eventId: string, payload: unknown, sealedPayload: string, status: string }} LedgerEvent */
/**
 * @typedef {{
 *   photoId: string,
 *   blob?: Blob | undefined,
 *   blobBytes: ArrayBuffer | null,
 *   objectUrl?: string | undefined,
 *   sha256: string,
 *   committed?: boolean,
 *   durable?: boolean,
 *   objectReference?: string
 * }} PhotoRecord
 */
/**
 * @typedef {{
 *   events: Map<string, LedgerEvent>,
 *   photos: Map<string, PhotoRecord>,
 *   objects: Map<string, string>,
 *   durableReceipts: Set<string>,
 *   activeLease: string,
 *   clickKeys: Set<string>,
 *   checkpoints: string[]
 * }} OfflineLedger
 */

export const NORMAL_CAPTURE_POLICY = Object.freeze({
  maxEdge: 2048,
  targetBytes: 1024 * 1024,
  minimumQuality: 0.6
});
export const PRESSURE_CAPTURE_POLICY = Object.freeze({
  maxEdge: 1600,
  targetBytes: 750 * 1024,
  minimumQuality: 0.6
});
export const EVIDENCE_BUDGET_BYTES = 250 * 1024 * 1024;
export const REQUIRED_HEADROOM_RATIO = 0.1;

/**
 * @param {{
 *   retainedEvidenceBytes?: number,
 *   optionalCacheBytes?: number,
 *   remainingPhotoCount?: number,
 *   expectedBytesPerPhoto?: number,
 *   budgetBytes?: number
 * }} [options]
 */
export function adaptiveCapturePolicy({
  retainedEvidenceBytes = 0,
  optionalCacheBytes = 0,
  remainingPhotoCount = 0,
  expectedBytesPerPhoto = NORMAL_CAPTURE_POLICY.targetBytes,
  budgetBytes = EVIDENCE_BUDGET_BYTES
} = {}) {
  const requiredBytes = Math.max(0, Number(remainingPhotoCount)) * Math.max(1, Number(expectedBytesPerPhoto));
  const reserveBytes = Math.ceil(Math.max(0, Number(budgetBytes)) * REQUIRED_HEADROOM_RATIO);
  const availableAfterEvidence = Math.max(0, Number(budgetBytes) - Math.max(0, Number(retainedEvidenceBytes)));
  const pressure = availableAfterEvidence < requiredBytes + reserveBytes;
  return {
    ...(pressure ? PRESSURE_CAPTURE_POLICY : NORMAL_CAPTURE_POLICY),
    pressure,
    requiredBytes,
    reserveBytes,
    optionalCacheEvictionBytes: pressure ? Math.max(0, Number(optionalCacheBytes)) : 0,
    appliesTo: "new-captures-only"
  };
}

/** @returns {OfflineLedger} */
export function createLedger() {
  return {
    events: new Map(),
    photos: new Map(),
    objects: new Map(),
    durableReceipts: new Set(),
    activeLease: "",
    clickKeys: new Set(),
    checkpoints: []
  };
}

/** @param {unknown} value @returns {unknown} */
function stableValue(value) {
  if (value === undefined) {return null;}
  if (Array.isArray(value)) {return value.map(stableValue);}
  if (value && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableValue(record[key])]));
  }
  return value;
}

/** @param {unknown} value @returns {string} */
export function stableJson(value) {
  return JSON.stringify(stableValue(value)) ?? "null";
}

/** @param {unknown} value @returns {string} */
export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

/** @param {OfflineLedger} ledger @param {string} clickKey @param {LogicalEventInput} event @param {string} [mutation] */
export function registerLogicalClick(ledger, clickKey, event, mutation = "") {
  if (mutation !== "missing-click-mutex" && ledger.clickKeys.has(clickKey)) {return false;}
  ledger.clickKeys.add(clickKey);
  const payload = structuredClone(event);
  ledger.events.set(event.eventId, {
    eventId: event.eventId,
    payload,
    sealedPayload: stableJson(payload),
    status: "pending"
  });
  return true;
}

/** @param {OfflineLedger} ledger @param {PhotoRecord} photo @param {string} [mutation] */
export function persistPhoto(ledger, photo, mutation = "") {
  const persisted = mutation === "blob-persistence"
    ? { ...photo }
    : { ...photo, blob: undefined, objectUrl: undefined };
  ledger.photos.set(photo.photoId, {
    ...persisted,
    blobBytes: photo.blobBytes,
    committed: Boolean(photo.committed),
    durable: false
  });
  return ledger.photos.get(photo.photoId);
}

/** @param {OfflineLedger} ledger @param {string} eventId @param {unknown} proposedPayload @param {string} [mutation] */
export function replayEvent(ledger, eventId, proposedPayload, mutation = "") {
  const event = ledger.events.get(eventId);
  if (!event) {throw new Error("Event is missing.");}
  if (mutation === "changed-replay-payload") {event.payload = structuredClone(proposedPayload);}
  return mutation === "changed-replay-payload" ? stableJson(event.payload) : event.sealedPayload;
}

/** @param {OfflineLedger} ledger @param {string} photoId @param {string} [mutation] */
export function uploadPhoto(ledger, photoId, mutation = "") {
  const photo = ledger.photos.get(photoId);
  if (!photo) {throw new Error("Photo is missing.");}
  const objectReference = `r2://synthetic/${photoId}`;
  ledger.objects.set(photoId, objectReference);
  photo.objectReference = objectReference;
  if (mutation === "premature-byte-deletion") {photo.blobBytes = null;}
  return objectReference;
}

/** @param {OfflineLedger} ledger @param {string} photoId @param {string} [mutation] */
export function markDurable(ledger, photoId, mutation = "") {
  const photo = ledger.photos.get(photoId);
  if (!photo) {throw new Error("Photo is missing.");}
  photo.durable = true;
  photo.blobBytes = null;
  ledger.durableReceipts.add(photoId);
  if (mutation !== "skipped-durable-checkpoint") {ledger.checkpoints.push(`durable:${photoId}`);}
}

/** @param {OfflineLedger} ledger @param {string} photoId @param {string} [mutation] */
export function recompressPhoto(ledger, photoId, mutation = "") {
  const photo = ledger.photos.get(photoId);
  if (!photo) {throw new Error("Photo is missing.");}
  if (photo.committed && mutation !== "committed-photo-recompression") {
    throw new Error("Committed evidence is immutable.");
  }
  photo.sha256 = sha256(`${photo.sha256}:recompressed`);
  return photo;
}

/** @param {OfflineLedger} ledger @param {string} owner @param {string} [mutation] */
export function acquireLease(ledger, owner, mutation = "") {
  if (mutation === "lost-sync-lease") {return true;}
  if (ledger.activeLease && ledger.activeLease !== owner) {return false;}
  ledger.activeLease = owner;
  return true;
}

/**
 * @param {{nextBytes: number, budgetBytes: number, remainingPhotoCount: number}} input
 * @param {string} [mutation]
 */
export function admissionAllowed({ nextBytes, budgetBytes, remainingPhotoCount }, mutation = "") {
  if (mutation === "ignored-quota-headroom") {return nextBytes <= budgetBytes;}
  const reserve = Math.ceil(budgetBytes * REQUIRED_HEADROOM_RATIO);
  const remaining = Math.max(0, Number(remainingPhotoCount)) * PRESSURE_CAPTURE_POLICY.targetBytes;
  return nextBytes + remaining + reserve <= budgetBytes;
}

/** @param {OfflineLedger} ledger @param {number} expectedClicks @returns {string[]} */
function verifyEventLedger(ledger, expectedClicks) {
  const defects = [];
  const events = [...ledger.events.values()];
  if (events.length !== expectedClicks) {defects.push(`expected ${expectedClicks} event(s), received ${events.length}`);}
  for (const event of events) {
    if (stableJson(event.payload) !== event.sealedPayload) {defects.push(`event ${event.eventId} payload changed`);}
  }
  return defects;
}

/** @param {OfflineLedger} ledger @returns {string[]} */
function verifyPhotoLedger(ledger) {
  const defects = [];
  for (const photo of ledger.photos.values()) {
    if (photo.blob instanceof Blob) {defects.push(`photo ${photo.photoId} persisted Blob`);}
    if (String(photo.objectUrl || "").startsWith("blob:")) {defects.push(`photo ${photo.photoId} persisted object URL`);}
    if (!photo.durable && !photo.blobBytes) {defects.push(`photo ${photo.photoId} lost bytes before durability`);}
    if (photo.durable && !ledger.checkpoints.includes(`durable:${photo.photoId}`)) {
      defects.push(`photo ${photo.photoId} durability was not checkpointed`);
    }
  }
  return defects;
}

/** @param {OfflineLedger} ledger @param {{expectedClicks?: number}} [options] @returns {string[]} */
export function verifyLedger(ledger, { expectedClicks = 1 } = {}) {
  return [
    ...verifyEventLedger(ledger, expectedClicks),
    ...verifyPhotoLedger(ledger)
  ];
}

/** @param {string} mutation @returns {OfflineLedger} */
function baseProbe(mutation) {
  const ledger = createLedger();
  const event = { eventId: "event-a", details: { result: "saved" } };
  registerLogicalClick(ledger, "job-a:complete", event, mutation);
  registerLogicalClick(ledger, "job-a:complete", { ...event, eventId: "event-b" }, mutation);
  persistPhoto(ledger, {
    photoId: "photo-a",
    blob: new Blob([new Uint8Array([1, 2, 3])]),
    blobBytes: new Uint8Array([1, 2, 3]).buffer,
    objectUrl: "blob:synthetic",
    sha256: sha256("photo-a"),
    committed: true
  }, mutation);
  return ledger;
}

/** @param {string} name @returns {string[]} */
export function mutationProbe(name) {
  const ledger = baseProbe(name);
  if (name === "changed-replay-payload") {replayEvent(ledger, "event-a", { eventId: "event-a", changed: true }, name);}
  if (name === "premature-byte-deletion") {uploadPhoto(ledger, "photo-a", name);}
  if (name === "skipped-durable-checkpoint") {markDurable(ledger, "photo-a", name);}
  if (name === "committed-photo-recompression") {
    recompressPhoto(ledger, "photo-a", name);
    ledger.checkpoints.push("committed-recompressed");
  }
  if (name === "lost-sync-lease") {
    acquireLease(ledger, "tab-a", name);
    if (acquireLease(ledger, "tab-b", name)) {ledger.checkpoints.push("dual-lease");}
  }
  if (name === "ignored-quota-headroom" && admissionAllowed({
    nextBytes: 230 * 1024 * 1024,
    budgetBytes: EVIDENCE_BUDGET_BYTES,
    remainingPhotoCount: 8
  }, name)) {ledger.checkpoints.push("unsafe-admission");}
  const defects = verifyLedger(ledger, { expectedClicks: 1 });
  if (ledger.checkpoints.includes("dual-lease")) {defects.push("two tabs acquired the same lease");}
  if (ledger.checkpoints.includes("unsafe-admission")) {defects.push("quota headroom was ignored");}
  if (ledger.checkpoints.includes("committed-recompressed")) {defects.push("committed evidence was recompressed");}
  return defects;
}

/** @template T @param {T} value @returns {T} */
export function sanitizeDiagnostic(value) {
  const secretKey = /(authorization|cookie|password|secret|token|grant)/iu;
  /** @param {unknown} item @param {string} [key] @returns {unknown} */
  const visit = (item, key = "") => {
    if (secretKey.test(key)) {return "[REDACTED]";}
    if (Array.isArray(item)) {return item.slice(0, 100).map((entry) => visit(entry));}
    if (item && typeof item === "object") {
      const record = /** @type {Record<string, unknown>} */ (item);
      return Object.fromEntries(Object.entries(record).slice(0, 100).map(([entryKey, entry]) => (
        [entryKey, visit(entry, entryKey)]
      )));
    }
    if (typeof item === "string") {return item.slice(0, 2000);}
    return item;
  };
  return /** @type {T} */ (visit(value));
}

/** @param {string} name */
export function networkWaveform(name) {
  if (name === "online-1s-offline-10s") {
    return [
      { online: true, durationMs: 1000 },
      { online: false, durationMs: 10000 },
      { online: true, durationMs: 1000 },
      { online: false, durationMs: 10000 },
      { online: true, durationMs: 1000 }
    ];
  }
  return [
    { online: false, durationMs: 10000 },
    { online: true, durationMs: 1000 }
  ];
}

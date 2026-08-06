// @ts-check

import crypto from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import { MbtError } from "./errors.js";

export const MBT_DRIVER_BIN_JOB_SCHEMA = "mbt-driver-bin-job-v1";
export const MBT_DRIVER_BIN_EVENT_SCHEMA = "mbt-driver-bin-event-v1";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACTION_PATTERN = /^[a-z][a-z0-9_]*$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/u;
const ASSET_ROLES = new Set(["expected", "outgoing", "incoming"]);

/** @param {string} message @param {Record<string, unknown>} [details] */
function invalid(message, details = {}) {
  throw new MbtError({
    status: 400,
    code: "MBT_DRIVER_BIN_EVENT_INVALID",
    message,
    details
  });
}

/** @param {unknown} value @param {string} label @param {number} maxLength */
function text(value, label, maxLength) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maxLength) {
    invalid(`A valid ${label} is required.`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function uuid(value, label) {
  const normalized = text(value, label, 64).toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {invalid(`The ${label} is invalid.`);}
  return normalized;
}

/** @param {unknown} value @param {string} label */
function action(value, label) {
  const normalized = text(value, label, 80);
  if (!ACTION_PATTERN.test(normalized)) {invalid(`The ${label} is invalid.`);}
  return normalized;
}

/** @param {unknown} value @param {string} label @param {number} [minimum] */
function safeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    invalid(`The ${label} must be a safe integer.`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} label */
function decimal(value, label) {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    invalid(`The ${label} must be a non-negative decimal string with at most six decimal places.`);
  }
  return value;
}

/** @param {unknown} value @param {readonly string[]} fields @param {string} label */
function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`The ${label} must be an object.`);
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  const unknown = Object.keys(record).filter((key) => !fields.includes(key));
  if (unknown.length) {invalid(`The ${label} contains unsupported fields.`, { fields: unknown });}
  return record;
}

/** @param {unknown} value @param {string} label @param {number} maximum @returns {unknown[]} */
function boundedArray(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) {
    invalid(`The ${label} must be an array containing at most ${maximum} rows.`);
  }
  return /** @type {unknown[]} */ (value);
}

/** @param {unknown} value */
function normalizeScan(value) {
  const scan = exactObject(value, [
    "evidenceCode", "assetRole", "assetId", "scannedValue"
  ], "BIN scan");
  const assetRole = text(scan.assetRole, "scan asset role", 20);
  if (!ASSET_ROLES.has(assetRole)) {invalid("The scan asset role is invalid.");}
  return {
    evidenceCode: action(scan.evidenceCode, "scan evidence code"),
    assetRole,
    assetId: uuid(scan.assetId, "scan asset ID"),
    scannedValue: text(scan.scannedValue, "scanned asset value", 200)
  };
}

/** @param {unknown} value */
function normalizePhotoEvidence(value) {
  const photo = exactObject(value, ["evidenceCode", "ordinal"], "photo evidence mapping");
  return {
    evidenceCode: action(photo.evidenceCode, "photo evidence code"),
    ordinal: safeInteger(photo.ordinal, "photo ordinal")
  };
}

/** @param {unknown} value */
function normalizeNote(value) {
  const note = exactObject(value, ["evidenceCode", "text"], "note evidence");
  return {
    evidenceCode: action(note.evidenceCode, "note evidence code"),
    text: text(note.text, "note", 2_000)
  };
}

/** @param {unknown} value */
function normalizeSignature(value) {
  const signature = exactObject(value, ["evidenceCode", "signedBy", "signaturePhotoOrdinal"], "signature evidence");
  return {
    evidenceCode: action(signature.evidenceCode, "signature evidence code"),
    signedBy: text(signature.signedBy, "signer name", 300),
    signaturePhotoOrdinal: safeInteger(signature.signaturePhotoOrdinal, "signature photo ordinal")
  };
}

/** @param {unknown} value */
function normalizeReceipt(value) {
  const receipt = exactObject(value, [
    "dumpSiteId", "materialId", "ticketNumber", "weight", "quantity",
    "unitOfMeasure", "subtotalMinor", "taxMinor", "totalMinor", "currency",
    "receiptPhotoOrdinal"
  ], "dump receipt");
  const weight = receipt.weight === undefined || receipt.weight === null || receipt.weight === ""
    ? null
    : decimal(receipt.weight, "receipt weight");
  const quantity = receipt.quantity === undefined || receipt.quantity === null || receipt.quantity === ""
    ? null
    : decimal(receipt.quantity, "receipt quantity");
  if (weight === null && quantity === null) {invalid("A dump receipt requires a weight or quantity.");}
  const subtotalMinor = safeInteger(receipt.subtotalMinor, "receipt subtotal");
  const taxMinor = safeInteger(receipt.taxMinor, "receipt tax");
  const totalMinor = safeInteger(receipt.totalMinor, "receipt total");
  if (subtotalMinor + taxMinor !== totalMinor) {invalid("The dump receipt total must equal subtotal plus tax.");}
  const currency = text(receipt.currency, "receipt currency", 3).toUpperCase();
  if (currency !== "CAD") {invalid("Phase 3 dump receipts must use CAD.");}
  return {
    dumpSiteId: uuid(receipt.dumpSiteId, "dump-site ID"),
    materialId: uuid(receipt.materialId, "material ID"),
    ticketNumber: text(receipt.ticketNumber, "dump ticket number", 200),
    weight,
    quantity,
    unitOfMeasure: text(receipt.unitOfMeasure, "receipt unit of measure", 40).toUpperCase(),
    subtotalMinor,
    taxMinor,
    totalMinor,
    currency,
    receiptPhotoOrdinal: safeInteger(receipt.receiptPhotoOrdinal, "receipt photo ordinal")
  };
}

/** @param {Array<Record<string, any>>} rows @param {(row: Record<string, any>) => string} identity @param {string} label */
function assertUnique(rows, identity, label) {
  const identities = rows.map(identity);
  if (new Set(identities).size !== identities.length) {invalid(`The ${label} contains duplicate evidence identities.`);}
}

/**
 * Strictly normalize the BIN-specific portion of a local Driver completion.
 * The normalized order is canonical so retries cannot vary by browser array
 * order. The input object is never mutated.
 *
 * @param {unknown} value
 */
export function normalizeMbtDriverEventDetails(value) {
  const source = exactObject(value, [
    "schemaVersion", "actionCode", "scans", "photoEvidence", "notes",
    "signatures", "receipt"
  ], "BIN event details");
  const schemaVersion = source.schemaVersion === undefined
    ? MBT_DRIVER_BIN_EVENT_SCHEMA
    : text(source.schemaVersion, "BIN event schema version", 80);
  if (schemaVersion !== MBT_DRIVER_BIN_EVENT_SCHEMA) {invalid("The BIN event schema version is unsupported.");}
  /** @type {Array<ReturnType<typeof normalizeScan>>} */
  const scans = boundedArray(source.scans ?? [], "BIN scans", 8).map(normalizeScan)
    .sort((left, right) => `${left.evidenceCode}:${left.assetRole}`.localeCompare(`${right.evidenceCode}:${right.assetRole}`));
  /** @type {Array<ReturnType<typeof normalizePhotoEvidence>>} */
  const photoEvidence = boundedArray(source.photoEvidence ?? [], "photo evidence", 100).map(normalizePhotoEvidence)
    .sort((left, right) => left.ordinal - right.ordinal || left.evidenceCode.localeCompare(right.evidenceCode));
  /** @type {Array<ReturnType<typeof normalizeNote>>} */
  const notes = boundedArray(source.notes ?? [], "note evidence", 20).map(normalizeNote)
    .sort((left, right) => left.evidenceCode.localeCompare(right.evidenceCode));
  /** @type {Array<ReturnType<typeof normalizeSignature>>} */
  const signatures = boundedArray(source.signatures ?? [], "signature evidence", 8).map(normalizeSignature)
    .sort((left, right) => left.evidenceCode.localeCompare(right.evidenceCode));
  assertUnique(scans, (row) => `${row.evidenceCode}:${row.assetRole}`, "BIN scans");
  assertUnique(photoEvidence, (row) => `${row.evidenceCode}:${row.ordinal}`, "photo evidence");
  assertUnique(notes, (row) => row.evidenceCode, "note evidence");
  assertUnique(signatures, (row) => row.evidenceCode, "signature evidence");
  return {
    schemaVersion,
    actionCode: action(source.actionCode, "BIN action code"),
    scans,
    photoEvidence,
    notes,
    signatures,
    receipt: source.receipt === undefined || source.receipt === null
      ? null
      : normalizeReceipt(source.receipt)
  };
}

/** @param {unknown} value */
export function hashMbtDriverCanonical(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

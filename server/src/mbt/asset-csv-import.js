// @ts-check

import { createHash } from "node:crypto";

import { canonicalSha256 } from "./canonical-json.js";
import { parseBoundedCsv, serializeCsv } from "./bounded-csv.js";
import { MbtError } from "./errors.js";

export const MBT_BIN_ASSET_CSV_HEADERS = Object.freeze([
  "asset_code",
  "item_code",
  "current_address",
  "active",
  "under_maintenance",
  "occurred_at"
]);

const LEGACY_MBT_BIN_ASSET_CSV_HEADERS = Object.freeze([
  "asset_code", "qr_code", "barcode", "bin_type_code", "home_yard_code",
  "tare_weight_kg", "condition_code", "operational_notes", "active",
  "under_maintenance", "initial_lifecycle_status", "initial_location_kind",
  "initial_location_identity", "initial_location_reference", "occurred_at"
]);

const ASSET_STATUSES = new Set([
  "available",
  "reserved",
  "on_truck",
  "at_customer",
  "at_dump",
  "maintenance",
  "lost",
  "retired"
]);
const LOCATION_KINDS = new Set([
  "yard",
  "customer_site",
  "dump_site",
  "truck",
  "unknown"
]);
const STATUS_LOCATION_KINDS = new Map([
  ["available", new Set(["yard"])],
  ["reserved", new Set(["yard", "truck"])],
  ["on_truck", new Set(["truck"])],
  ["at_customer", new Set(["customer_site"])],
  ["at_dump", new Set(["dump_site"])],
  ["maintenance", new Set(["yard", "unknown"])],
  ["lost", new Set(["unknown"])],
  ["retired", new Set(["yard", "unknown"])]
]);

/** @param {string} code @param {string} message @param {Record<string, unknown>} [details] @returns {never} */
function csvError(code, message, details = {}) {
  throw new MbtError({ status: 400, code, message, details });
}

/** @param {unknown} value @param {string} field @param {number} rowNumber */
function requiredText(value, field, rowNumber) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return csvError(
      "MBT_ASSET_CSV_ROW_INVALID",
      "A required asset CSV value is missing.",
      { rowNumber, field }
    );
  }
  return normalized;
}

/** @param {unknown} value */
function optionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

/** @param {unknown} value @param {string} field @param {number} rowNumber */
function strictBoolean(value, field, rowNumber) {
  const normalized = String(value ?? "").trim();
  if (normalized !== "true" && normalized !== "false") {
    return csvError(
      "MBT_ASSET_CSV_ROW_INVALID",
      "Asset CSV booleans must be true or false.",
      { rowNumber, field }
    );
  }
  return normalized === "true";
}

/** @param {unknown} value @param {number} rowNumber */
function tareWeight(value, rowNumber) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return null;
  }
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/u.test(normalized)) {
    return csvError(
      "MBT_ASSET_CSV_ROW_INVALID",
      "Asset tare weight must be a non-negative decimal with at most three decimal places.",
      { rowNumber, field: "tare_weight_kg" }
    );
  }
  return normalized;
}

/** @param {unknown} value @param {number} rowNumber */
function occurredAt(value, rowNumber) {
  const normalized = requiredText(value, "occurred_at", rowNumber);
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return csvError(
      "MBT_ASSET_CSV_ROW_INVALID",
      "Asset opening time must be a valid timestamp.",
      { rowNumber, field: "occurred_at" }
    );
  }
  return parsed.toISOString();
}

/** @param {Record<string, string>} values @param {number} rowNumber */
function normalizedRow(values, rowNumber) {
  const lifecycleStatus = requiredText(
    values.initial_lifecycle_status,
    "initial_lifecycle_status",
    rowNumber
  );
  const locationKind = requiredText(
    values.initial_location_kind,
    "initial_location_kind",
    rowNumber
  );
  if (!ASSET_STATUSES.has(lifecycleStatus)) {
    return csvError(
      "MBT_ASSET_CSV_ROW_INVALID",
      "The initial asset lifecycle status is not supported.",
      { rowNumber, field: "initial_lifecycle_status" }
    );
  }
  if (!LOCATION_KINDS.has(locationKind)) {
    return csvError(
      "MBT_ASSET_CSV_ROW_INVALID",
      "The initial asset location kind is not supported.",
      { rowNumber, field: "initial_location_kind" }
    );
  }
  if (!STATUS_LOCATION_KINDS.get(lifecycleStatus)?.has(locationKind)) {
    return csvError(
      "MBT_ASSET_CSV_ROW_INVALID",
      "The initial asset status and location are incompatible.",
      { rowNumber, field: "initial_location_kind" }
    );
  }
  const locationIdentity = optionalText(values.initial_location_identity);
  if ((locationKind === "unknown" && locationIdentity)
      || (locationKind !== "unknown" && !locationIdentity)) {
    return csvError(
      "MBT_ASSET_CSV_ROW_INVALID",
      "A physical location requires one exact identity and an unknown location requires none.",
      { rowNumber, field: "initial_location_identity" }
    );
  }
  return {
    rowNumber,
    assetCode: requiredText(values.asset_code, "asset_code", rowNumber),
    qrCode: optionalText(values.qr_code),
    barcode: optionalText(values.barcode),
    binTypeCode: requiredText(values.bin_type_code, "bin_type_code", rowNumber),
    homeYardCode: requiredText(values.home_yard_code, "home_yard_code", rowNumber),
    tareWeightKg: tareWeight(values.tare_weight_kg, rowNumber),
    conditionCode: optionalText(values.condition_code),
    operationalNotes: String(values.operational_notes ?? "").trim(),
    active: strictBoolean(values.active, "active", rowNumber),
    underMaintenance: strictBoolean(values.under_maintenance, "under_maintenance", rowNumber),
    initialState: {
      lifecycleStatus,
      locationKind,
      locationIdentity,
      locationReference: optionalText(values.initial_location_reference),
      occurredAt: occurredAt(values.occurred_at, rowNumber)
    }
  };
}

/** @param {Record<string, string>} values @param {number} rowNumber */
function normalizedCurrentAddressRow(values, rowNumber) {
  return {
    rowNumber,
    assetCode: requiredText(values.asset_code, "asset_code", rowNumber),
    itemCode: requiredText(values.item_code, "item_code", rowNumber).toUpperCase(),
    currentAddress: requiredText(values.current_address, "current_address", rowNumber),
    active: strictBoolean(values.active, "active", rowNumber),
    underMaintenance: strictBoolean(values.under_maintenance, "under_maintenance", rowNumber),
    occurredAt: occurredAt(values.occurred_at, rowNumber)
  };
}

/** @param {readonly Record<string, any>[]} rows */
function rejectDuplicateIdentities(rows) {
  /** @type {readonly ["assetCode" | "qrCode" | "barcode", string][]} */
  const identities = [
    ["assetCode", "asset_code"],
    ["qrCode", "qr_code"],
    ["barcode", "barcode"]
  ];
  for (const [property, field] of identities) {
    const seen = new Set();
    for (const row of rows) {
      const identity = row[property];
      if (!identity) {
        continue;
      }
      if (seen.has(identity)) {
        return csvError(
          "MBT_ASSET_CSV_DUPLICATE_IDENTITY",
          "The asset CSV repeats an asset identity.",
          { rowNumber: row.rowNumber, field, identity }
        );
      }
      seen.add(identity);
    }
  }
}

/** @param {unknown} value */
function directBytes(value) {
  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  return null;
}

/** @param {unknown} value */
function safeFileName(value) {
  const normalized = String(value ?? "mbt-bin-assets-v2.csv").trim();
  if (!normalized || normalized.length > 255 || !/^[^/\\\u0000-\u001f]+\.csv$/iu.test(normalized)) {
    return csvError(
      "MBT_ASSET_CSV_FILENAME_INVALID",
      "A safe CSV source filename is required."
    );
  }
  return normalized;
}

export function getMbtBinAssetCsvTemplate() {
  return {
    schemaVersion: "mbt-bin-assets-csv-v2",
    fileName: "mbt-bin-assets-v2.csv",
    content: serializeCsv({ headers: MBT_BIN_ASSET_CSV_HEADERS, rows: [] })
  };
}

/**
 * @param {unknown} content
 * @param {{fileName?: unknown, limits?: Partial<typeof import("./bounded-csv.js").DEFAULT_IMPORT_LIMITS>}} [options]
 */
export async function parseMbtBinAssetCsv(content, options = {}) {
  const parsed = await parseBoundedCsv(content, {
    requiredHeaders: [],
    optionalHeaders: [...MBT_BIN_ASSET_CSV_HEADERS, ...LEGACY_MBT_BIN_ASSET_CSV_HEADERS],
    ...(options.limits === undefined ? {} : { limits: options.limits })
  });
  /** @param {readonly string[]} expected */
  const exactHeaders = (expected) => (
    parsed.headers.length === expected.length
    && expected.every((header) => parsed.headers.includes(header))
  );
  const currentSchema = exactHeaders(MBT_BIN_ASSET_CSV_HEADERS);
  const legacySchema = exactHeaders(LEGACY_MBT_BIN_ASSET_CSV_HEADERS);
  if (!currentSchema && !legacySchema) {
    return csvError(
      "MBT_ASSET_CSV_SCHEMA_INVALID",
      "Use the current asset CSV template; mixed legacy and current columns are not supported."
    );
  }
  const rows = parsed.rows.map(({ values, rowNumber }) => currentSchema
    ? normalizedCurrentAddressRow(values, rowNumber)
    : normalizedRow(values, rowNumber));
  rejectDuplicateIdentities(rows);
  const bytes = directBytes(content);
  if (!bytes) {
    return csvError(
      "MBT_ASSET_CSV_INPUT_INVALID",
      "Asset CSV input must be provided as bounded text or bytes."
    );
  }
  const fileHash = createHash("sha256").update(bytes).digest("hex");
  const normalizedHash = canonicalSha256(rows);
  return {
    schemaVersion: currentSchema ? "mbt-bin-assets-csv-v2" : "mbt-bin-assets-csv-v1",
    fileName: safeFileName(options.fileName),
    fileHash,
    normalizedHash,
    summary: { rowCount: rows.length },
    rows
  };
}

// @ts-check

import crypto from "node:crypto";

import { parseBoundedCsv } from "./bounded-csv.js";
import { canonicalSha256 } from "./canonical-json.js";
import { MbtError } from "./errors.js";
import { normalizeLocalRateCardGraph } from "./rate-card-configuration-service.js";
import {
  DEFAULT_MBBS_RATE_CARD_POLICY,
  isMbbsCrossChargeGraph
} from "./mbbs-rate-card-policy.js";

/** @typedef {"rate_cards" | "distance_bands" | "components" | "dump_tariffs" | "deposit_rules"} RateCardFileKey */

/** @type {readonly RateCardFileKey[]} */
const FILE_ORDER = Object.freeze([
  "rate_cards",
  "distance_bands",
  "components",
  "dump_tariffs",
  "deposit_rules"
]);
/** @type {Readonly<Record<RateCardFileKey, string>>} */
const FILE_NAMES = Object.freeze({
  rate_cards: "rate_cards.csv",
  distance_bands: "distance_bands.csv",
  components: "components.csv",
  dump_tariffs: "dump_tariffs.csv",
  deposit_rules: "deposit_rules.csv"
});
/** @type {Readonly<Record<RateCardFileKey, readonly string[]>>} */
const HEADERS = Object.freeze({
  rate_cards: Object.freeze([
    "rate_card_code", "display_name", "description", "customer_netsuite_id",
    "subsidiary_netsuite_id", "service_template_code", "currency", "active",
    "version_number", "effective_from", "effective_to",
    "default_rental_calendar_days", "calculation_notes"
  ]),
  distance_bands: Object.freeze([
    "service_code", "bin_type_code", "sequence_number", "minimum_metres",
    "maximum_metres", "amount_minor", "downtown_surcharge_minor", "currency",
    "description"
  ]),
  components: Object.freeze([
    "component_code", "component_kind", "service_code", "bin_type_code",
    "rate_basis", "amount_minor", "percentage_basis_points", "default_quantity",
    "currency", "taxable", "active", "description"
  ]),
  dump_tariffs: Object.freeze([
    "dump_site_code", "material_code", "tariff_code", "pricing_basis",
    "unit_of_measure", "amount_minor", "minimum_amount_minor", "currency",
    "active", "description"
  ]),
  deposit_rules: Object.freeze([
    "rule_code", "rule_type", "bin_type_code", "service_code",
    "fixed_amount_minor", "percentage_basis_points", "currency",
    "liability_account_mapping_key", "active", "description"
  ])
});
const MAX_BYTES_PER_FILE = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 15 * 1024 * 1024;

/** @param {string} code @param {string} message @param {Record<string, unknown>} [details] @returns {never} */
function importError(code, message, details = {}) {
  throw new MbtError({ status: 400, code, message, details });
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** @param {unknown} value */
function contentBuffer(value) {
  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  return importError("MBT_RATE_CSV_CONTENT_REQUIRED", "Every rate-card CSV file requires text content.");
}

/** @param {unknown} value @param {number} maximum @param {string} name */
function boundedLimit(value, maximum, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    return importError("MBT_IMPORT_LIMIT_INVALID", "Rate-card CSV limits may only be configured downward.", { limit: name });
  }
  return Number(value);
}

/** @param {unknown} value */
function importLimits(value) {
  if (value === undefined) {
    return { maxBytesPerFile: MAX_BYTES_PER_FILE, maxTotalBytes: MAX_TOTAL_BYTES };
  }
  if (!isRecord(value) || Object.keys(value).some(
    (key) => key !== "maxBytesPerFile" && key !== "maxTotalBytes"
  )) {
    return importError("MBT_IMPORT_LIMIT_INVALID", "Rate-card CSV limits are invalid.");
  }
  return {
    maxBytesPerFile: value.maxBytesPerFile === undefined
      ? MAX_BYTES_PER_FILE
      : boundedLimit(value.maxBytesPerFile, MAX_BYTES_PER_FILE, "maxBytesPerFile"),
    maxTotalBytes: value.maxTotalBytes === undefined
      ? MAX_TOTAL_BYTES
      : boundedLimit(value.maxTotalBytes, MAX_TOTAL_BYTES, "maxTotalBytes")
  };
}

/** @param {unknown} value */
function exactFiles(value) {
  if (!isRecord(value)) {
    return importError("MBT_RATE_CSV_FILES_REQUIRED", "All five rate-card CSV files are required.");
  }
  const keys = Object.keys(value).sort();
  const expected = [...FILE_ORDER].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return importError("MBT_RATE_CSV_FILES_REQUIRED", "Exactly five named rate-card CSV files are required.");
  }
  return /** @type {Record<RateCardFileKey, Record<string, unknown>>} */ (value);
}

/** @param {string} file @param {number} rowNumber @param {string} field @param {string} message @returns {never} */
function rowError(file, rowNumber, field, message) {
  return importError("MBT_RATE_CSV_ROW_INVALID", message, { file, rowNumber, field });
}

/**
 * parseBoundedCsv materializes every exact required header as a string, even
 * when the source row omits its trailing cell.
 *
 * @param {Record<string, string>} row
 * @param {string} field
 */
function csvCell(row, field) {
  return /** @type {string} */ (row[field]);
}

/** @param {Record<string, string>} row @param {string} field @param {string} file @param {number} rowNumber */
function requiredText(row, field, file, rowNumber) {
  const value = csvCell(row, field).trim();
  if (!value) {
    return rowError(file, rowNumber, field, "A required rate-card CSV value is blank.");
  }
  return value;
}

/** @param {Record<string, string>} row @param {string} field */
function nullableText(row, field) {
  const value = csvCell(row, field).trim();
  return value || null;
}

/**
 * @param {Record<string, string>} row
 * @param {string} field
 * @param {string} file
 * @param {number} rowNumber
 * @param {{nullable?: boolean, minimum?: number}} [options]
 */
function integer(row, field, file, rowNumber, { nullable = false, minimum = 0 } = {}) {
  const value = csvCell(row, field).trim();
  if (nullable && !value) {
    return null;
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    return rowError(file, rowNumber, field, "Rate-card integers must use non-negative whole-number text.");
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    return rowError(file, rowNumber, field, "A rate-card integer is outside its safe range.");
  }
  return number;
}

/** @param {Record<string, string>} row @param {string} field @param {string} file @param {number} rowNumber */
function booleanValue(row, field, file, rowNumber) {
  const value = csvCell(row, field).trim();
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return rowError(file, rowNumber, field, "Rate-card booleans must be exactly true or false.");
}

/** @param {Record<string, string>} row @param {string} field @param {string} file @param {number} rowNumber */
function positiveDecimal(row, field, file, rowNumber) {
  const value = csvCell(row, field).trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,4})?$/u.test(value)
      || !Number.isFinite(Number(value)) || Number(value) <= 0) {
    return rowError(file, rowNumber, field, "Rate-card quantities must be positive decimals with at most four places.");
  }
  return value;
}

/** @param {Record<string, string>} row @param {string} field @param {string} file @param {number} rowNumber @param {boolean} [nullable] */
function isoTime(row, field, file, rowNumber, nullable = false) {
  const value = csvCell(row, field).trim();
  if (nullable && !value) {
    return null;
  }
  if (!value || Number.isNaN(Date.parse(value))) {
    return rowError(file, rowNumber, field, "Rate-card dates must be ISO date-times.");
  }
  return value;
}

/** @param {{rowNumber: number, values: Record<string, string>}} source */
function cardRow(source) {
  const file = FILE_NAMES.rate_cards;
  const row = source.values;
  return {
    rateCard: {
      rateCardCode: requiredText(row, "rate_card_code", file, source.rowNumber),
      displayName: requiredText(row, "display_name", file, source.rowNumber),
      description: csvCell(row, "description").trim(),
      customerNetSuiteId: integer(row, "customer_netsuite_id", file, source.rowNumber, { nullable: true, minimum: 1 }),
      subsidiaryNetSuiteId: integer(row, "subsidiary_netsuite_id", file, source.rowNumber, { nullable: true, minimum: 1 }),
      serviceTemplateCode: nullableText(row, "service_template_code"),
      currency: requiredText(row, "currency", file, source.rowNumber),
      active: booleanValue(row, "active", file, source.rowNumber)
    },
    version: {
      versionNumber: integer(row, "version_number", file, source.rowNumber, { minimum: 1 }),
      effectiveFrom: isoTime(row, "effective_from", file, source.rowNumber),
      effectiveTo: isoTime(row, "effective_to", file, source.rowNumber, true),
      defaultRentalCalendarDays: integer(
        row,
        "default_rental_calendar_days",
        file,
        source.rowNumber,
        { minimum: 1 }
      ),
      calculationNotes: csvCell(row, "calculation_notes").trim()
    }
  };
}

/** @param {{rowNumber: number, values: Record<string, string>}} source */
function bandRow(source) {
  const file = FILE_NAMES.distance_bands;
  const row = source.values;
  return {
    serviceCode: requiredText(row, "service_code", file, source.rowNumber),
    binTypeCode: nullableText(row, "bin_type_code"),
    sequenceNumber: integer(row, "sequence_number", file, source.rowNumber),
    minimumMetres: integer(row, "minimum_metres", file, source.rowNumber),
    maximumMetres: integer(row, "maximum_metres", file, source.rowNumber, { nullable: true }),
    amountMinor: integer(row, "amount_minor", file, source.rowNumber),
    downtownSurchargeMinor: integer(row, "downtown_surcharge_minor", file, source.rowNumber),
    currency: requiredText(row, "currency", file, source.rowNumber),
    description: csvCell(row, "description").trim()
  };
}

/** @param {{rowNumber: number, values: Record<string, string>}} source */
function componentRow(source) {
  const file = FILE_NAMES.components;
  const row = source.values;
  return {
    componentCode: requiredText(row, "component_code", file, source.rowNumber),
    componentKind: requiredText(row, "component_kind", file, source.rowNumber),
    serviceCode: nullableText(row, "service_code"),
    binTypeCode: nullableText(row, "bin_type_code"),
    rateBasis: requiredText(row, "rate_basis", file, source.rowNumber),
    amountMinor: integer(row, "amount_minor", file, source.rowNumber, { nullable: true }),
    percentageBasisPoints: integer(row, "percentage_basis_points", file, source.rowNumber, { nullable: true }),
    defaultQuantity: positiveDecimal(row, "default_quantity", file, source.rowNumber),
    currency: requiredText(row, "currency", file, source.rowNumber),
    taxable: booleanValue(row, "taxable", file, source.rowNumber),
    active: booleanValue(row, "active", file, source.rowNumber),
    description: csvCell(row, "description").trim()
  };
}

/** @param {{rowNumber: number, values: Record<string, string>}} source */
function tariffRow(source) {
  const file = FILE_NAMES.dump_tariffs;
  const row = source.values;
  return {
    dumpSiteCode: requiredText(row, "dump_site_code", file, source.rowNumber),
    materialCode: nullableText(row, "material_code"),
    tariffCode: requiredText(row, "tariff_code", file, source.rowNumber),
    pricingBasis: requiredText(row, "pricing_basis", file, source.rowNumber),
    unitOfMeasure: nullableText(row, "unit_of_measure"),
    amountMinor: integer(row, "amount_minor", file, source.rowNumber),
    minimumAmountMinor: integer(row, "minimum_amount_minor", file, source.rowNumber),
    currency: requiredText(row, "currency", file, source.rowNumber),
    active: booleanValue(row, "active", file, source.rowNumber),
    description: csvCell(row, "description").trim()
  };
}

/** @param {{rowNumber: number, values: Record<string, string>}} source */
function depositRow(source) {
  const file = FILE_NAMES.deposit_rules;
  const row = source.values;
  return {
    ruleCode: requiredText(row, "rule_code", file, source.rowNumber),
    ruleType: requiredText(row, "rule_type", file, source.rowNumber),
    binTypeCode: nullableText(row, "bin_type_code"),
    serviceCode: nullableText(row, "service_code"),
    fixedAmountMinor: integer(row, "fixed_amount_minor", file, source.rowNumber, { nullable: true }),
    percentageBasisPoints: integer(row, "percentage_basis_points", file, source.rowNumber, { nullable: true }),
    currency: requiredText(row, "currency", file, source.rowNumber),
    liabilityAccountMappingKey: csvCell(row, "liability_account_mapping_key").trim(),
    active: booleanValue(row, "active", file, source.rowNumber),
    description: csvCell(row, "description").trim()
  };
}

/** @param {Record<string, any>[]} rows @param {(row: Record<string, any>) => string} identity */
function sortRows(rows, identity) {
  return rows.sort((left, right) => identity(left).localeCompare(identity(right)));
}

/**
 * Parse a complete five-file bundle into the one canonical graph accepted by
 * manual configuration. Raw CSV bytes are not retained in the result.
 *
 * @param {unknown} filesValue
 * @param {{limits?: unknown}} [options]
 */
export async function parseRateCardCsvBundle(filesValue, options = {}) {
  const files = exactFiles(filesValue);
  const limits = importLimits(options.limits);
  /** @type {Record<RateCardFileKey, Buffer>} */
  const contents = /** @type {Record<RateCardFileKey, Buffer>} */ ({});
  let totalBytes = 0;
  for (const key of FILE_ORDER) {
    const file = files[key];
    if (!isRecord(file) || Object.keys(file).some((field) => field !== "fileName" && field !== "content")) {
      return importError("MBT_RATE_CSV_CONTENT_REQUIRED", "Every rate-card CSV file requires a name and content.");
    }
    if (String(file.fileName || "") !== FILE_NAMES[key]) {
      return importError("MBT_RATE_CSV_FILENAME_INVALID", "A rate-card CSV filename is invalid.", { file: key });
    }
    const content = contentBuffer(file.content);
    if (content.length > limits.maxBytesPerFile) {
      return importError("MBT_IMPORT_FILE_TOO_LARGE", "A rate-card CSV file exceeds the byte limit.", { file: key });
    }
    contents[key] = content;
    totalBytes += content.length;
  }
  if (totalBytes > limits.maxTotalBytes) {
    return importError("MBT_RATE_CSV_TOTAL_TOO_LARGE", "The five-file rate-card bundle exceeds the total byte limit.");
  }

  const parsedEntries = await Promise.all(FILE_ORDER.map(async (key) => [
    key,
    await parseBoundedCsv(contents[key], {
      requiredHeaders: HEADERS[key],
      limits: { maxBytes: limits.maxBytesPerFile }
    })
  ]));
  const parsed = /** @type {Record<RateCardFileKey, {rows: Array<{rowNumber: number, values: Record<string, string>}>, rowCount: number}>} */ (
    Object.fromEntries(parsedEntries)
  );
  if (parsed.rate_cards.rowCount !== 1 || parsed.distance_bands.rowCount < 1) {
    return importError(
      "MBT_RATE_CSV_ROW_COUNT_INVALID",
      "Rate-card CSV requires one header row and at least one distance-band row."
    );
  }

  const headerSource = /** @type {{rowNumber: number, values: Record<string, string>}} */ (
    parsed.rate_cards.rows[0]
  );
  const header = cardRow(headerSource);
  const rawGraph = /** @type {Record<string, any>} */ ({
    ...header,
    distanceBands: sortRows(parsed.distance_bands.rows.map(bandRow), (row) => (
      `${row.serviceCode}\u0000${row.binTypeCode || ""}\u0000${String(row.minimumMetres).padStart(16, "0")}\u0000${String(row.sequenceNumber).padStart(16, "0")}`
    )),
    components: sortRows(parsed.components.rows.map(componentRow), (row) => row.componentCode),
    dumpTariffs: sortRows(parsed.dump_tariffs.rows.map(tariffRow), (row) => (
      `${row.dumpSiteCode}\u0000${row.materialCode || ""}\u0000${row.tariffCode}`
    )),
    depositRules: sortRows(parsed.deposit_rules.rows.map(depositRow), (row) => row.ruleCode)
  });
  if (isMbbsCrossChargeGraph(rawGraph)) {
    rawGraph.mbbsChargingPolicy = { ...DEFAULT_MBBS_RATE_CARD_POLICY };
  }
  const graph = normalizeLocalRateCardGraph(rawGraph, { sourceKind: "csv" });
  const fileEvidence = FILE_ORDER.map((key) => ({
    key,
    fileName: FILE_NAMES[key],
    byteLength: contents[key].length,
    sha256: crypto.createHash("sha256").update(contents[key]).digest("hex")
  }));
  return {
    schemaVersion: "mbt-rate-card-csv-v1",
    fileHash: canonicalSha256({ files: fileEvidence }),
    normalizedHash: canonicalSha256(graph),
    summary: {
      fileCount: FILE_ORDER.length,
      totalRows: FILE_ORDER.reduce((total, key) => total + parsed[key].rowCount, 0),
      rowsByFile: Object.fromEntries(FILE_ORDER.map((key) => [key, parsed[key].rowCount]))
    },
    fileEvidence,
    graph
  };
}

export const rateCardCsvImportDefinition = Object.freeze({
  fileOrder: FILE_ORDER,
  fileNames: FILE_NAMES,
  headers: HEADERS,
  maxBytesPerFile: MAX_BYTES_PER_FILE,
  maxTotalBytes: MAX_TOTAL_BYTES
});

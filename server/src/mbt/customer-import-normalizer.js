// @ts-check

import { canonicalSha256 } from "./canonical-json.js";
import { MbtError } from "./errors.js";

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const CLOSED_WON_STATUS = "CUSTOMER-Closed Won";

/** @typedef {{rowNumber: number, values: Record<string, unknown>}} RawCustomerImportRow */
/** @typedef {{totalRows: number, eligibleRows: number, skippedRows: number, skippedSubsidiaryRows: number, skippedStatusRows: number, incompleteEntityNumberRows: number, blankEmailRows: number, blankPhoneRows: number}} CustomerImportSummary */

/** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
function importError(code, message, details = {}) {
  return new MbtError({ status: 400, code, message, details });
}

/** @param {unknown} value @param {string} field */
function requiredDefault(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw importError(
      "MBT_IMPORT_DEFAULT_REQUIRED",
      "An explicit customer import default is required.",
      { field }
    );
  }
  return value;
}

/** @param {unknown} defaults */
function normalizeDefaults(defaults) {
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    throw importError("MBT_IMPORT_DEFAULT_REQUIRED", "Customer import defaults are required.");
  }
  const source = /** @type {Record<string, unknown>} */ (defaults);
  const sourceAccountId = requiredDefault(source.sourceAccountId, "sourceAccountId");
  const approvedSubsidiary = requiredDefault(source.approvedSubsidiary, "approvedSubsidiary");
  const defaultCurrency = requiredDefault(source.defaultCurrency, "defaultCurrency");
  const exportedAt = requiredDefault(source.exportedAt, "exportedAt");
  const sourceVersion = requiredDefault(source.sourceVersion, "sourceVersion");
  if (!/^[A-Z]{3}$/u.test(defaultCurrency)) {
    throw importError("MBT_IMPORT_DEFAULT_INVALID", "The default currency must be an ISO currency code.");
  }
  const exportedDate = new Date(exportedAt);
  if (!Number.isFinite(exportedDate.getTime())) {
    throw importError("MBT_IMPORT_DEFAULT_INVALID", "The export time is invalid.");
  }
  return {
    sourceAccountId,
    approvedSubsidiary,
    defaultCurrency,
    exportedAt: exportedDate.toISOString(),
    sourceVersion
  };
}

/** @param {unknown} value @param {number} rowNumber */
function customerInternalId(value, rowNumber) {
  const rendered = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string"
      ? value
      : "";
  if (!/^[0-9]+$/u.test(rendered)) {
    throw importError("MBT_IMPORT_CUSTOMER_ID_INVALID", "A positive customer internal ID is required.", {
      rowNumber
    });
  }
  const parsed = BigInt(rendered);
  if (parsed < 1n || parsed > MAX_POSTGRES_BIGINT) {
    throw importError("MBT_IMPORT_CUSTOMER_ID_INVALID", "A positive customer internal ID is required.", {
      rowNumber
    });
  }
  return String(parsed);
}

/** @param {unknown} value @param {number} rowNumber */
function customerName(value, rowNumber) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw importError("MBT_IMPORT_CUSTOMER_NAME_INVALID", "A customer name is required.", { rowNumber });
  }
  return value;
}

/** @param {unknown} value */
function optionalText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    throw importError("MBT_IMPORT_CUSTOMER_FIELD_INVALID", "A customer field must be text.");
  }
  return value;
}

/** @param {string} name @param {string} internalId */
function entityIdentity(name, internalId) {
  const matched = /^([0-9]{6})(?=\s|$)/u.exec(name);
  return matched
    ? { entityNumber: matched[1], entityNumberIncomplete: false }
    : { entityNumber: `NSID-${internalId}`, entityNumberIncomplete: true };
}

/** @param {Record<string, unknown>} values @param {number} rowNumber */
function sourceFields(values, rowNumber) {
  return {
    customerInternalId: customerInternalId(values["Internal ID"], rowNumber),
    name: customerName(values.Name, rowNumber),
    primarySubsidiary: optionalText(values["Primary Subsidiary"]),
    status: optionalText(values.Status),
    phone: optionalText(values.Phone),
    email: optionalText(values.Email)
  };
}

/** @param {ReturnType<typeof sourceFields>} source @param {ReturnType<typeof normalizeDefaults>} defaults @param {number} rowNumber */
function normalizedCustomer(source, defaults, rowNumber) {
  const identity = entityIdentity(source.name, source.customerInternalId);
  const payload = {
    customerInternalId: source.customerInternalId,
    entityNumber: identity.entityNumber,
    legalName: source.name,
    displayName: source.name,
    currency: defaults.defaultCurrency,
    email: source.email,
    phone: source.phone,
    active: true,
    sourceModifiedAt: defaults.exportedAt,
    sourceVersion: defaults.sourceVersion,
    sourceAccountId: defaults.sourceAccountId,
    sourceKind: "csv_bootstrap"
  };
  return {
    rowNumber,
    ...payload,
    ...identity,
    primarySubsidiary: source.primarySubsidiary,
    payloadHash: canonicalSha256(payload)
  };
}

/** @param {readonly Record<string, unknown>[]} rows */
function normalizedHash(rows) {
  const semanticRows = rows.map(({ rowNumber: _rowNumber, ...row }) => row)
    .sort((left, right) => {
      const leftId = BigInt(String(left.customerInternalId));
      const rightId = BigInt(String(right.customerInternalId));
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
  return canonicalSha256(semanticRows);
}

/** @param {RawCustomerImportRow} rawRow @param {Set<string>} seenIds */
function validatedSourceRow(rawRow, seenIds) {
  if (!rawRow || !Number.isSafeInteger(rawRow.rowNumber) || rawRow.rowNumber < 2
      || !rawRow.values || typeof rawRow.values !== "object" || Array.isArray(rawRow.values)) {
    throw importError("MBT_IMPORT_ROWS_INVALID", "A customer import row is malformed.");
  }
  const source = sourceFields(rawRow.values, rawRow.rowNumber);
  if (seenIds.has(source.customerInternalId)) {
    throw importError("MBT_IMPORT_DUPLICATE_ID", "The import contains a duplicate customer ID.", {
      rowNumber: rawRow.rowNumber
    });
  }
  seenIds.add(source.customerInternalId);
  return source;
}

/** @param {ReturnType<typeof sourceFields>} source @param {ReturnType<typeof normalizeDefaults>} defaults @param {number} rowNumber */
function customerOutcome(source, defaults, rowNumber) {
  if (source.primarySubsidiary !== defaults.approvedSubsidiary) {
    return { kind: "skipped_subsidiary", source, row: null };
  }
  if (source.status !== CLOSED_WON_STATUS) {
    return { kind: "skipped_status", source, row: null };
  }
  return { kind: "eligible", source, row: normalizedCustomer(source, defaults, rowNumber) };
}

/**
 * @param {ReturnType<typeof customerOutcome>} outcome
 * @param {CustomerImportSummary} summary
 * @param {Record<string, unknown>[]} rows
 */
function recordOutcome(outcome, summary, rows) {
  if (outcome.kind === "skipped_subsidiary") {
    summary.skippedRows += 1;
    summary.skippedSubsidiaryRows += 1;
    return;
  }
  if (outcome.kind === "skipped_status") {
    summary.skippedRows += 1;
    summary.skippedStatusRows += 1;
    return;
  }
  const row = /** @type {Record<string, unknown>} */ (outcome.row);
  rows.push(row);
  summary.eligibleRows += 1;
  summary.incompleteEntityNumberRows += row.entityNumberIncomplete === true ? 1 : 0;
  summary.blankEmailRows += outcome.source.email.length === 0 ? 1 : 0;
  summary.blankPhoneRows += outcome.source.phone.length === 0 ? 1 : 0;
}

/**
 * Normalize the shared customer-row shape emitted by CSV and SpreadsheetML
 * adapters. Identity is always the positive NetSuite internal ID; names never
 * participate in matching or de-duplication.
 *
 * @param {readonly RawCustomerImportRow[]} rawRows
 * @param {unknown} defaultsInput
 */
export function normalizeCustomerImportRows(rawRows, defaultsInput) {
  if (!Array.isArray(rawRows)) {
    throw importError("MBT_IMPORT_ROWS_INVALID", "Customer import rows are required.");
  }
  const defaults = normalizeDefaults(defaultsInput);
  const seenIds = new Set();
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  /** @type {CustomerImportSummary} */
  const summary = {
    totalRows: rawRows.length,
    eligibleRows: 0,
    skippedRows: 0,
    skippedSubsidiaryRows: 0,
    skippedStatusRows: 0,
    incompleteEntityNumberRows: 0,
    blankEmailRows: 0,
    blankPhoneRows: 0
  };

  for (const rawRow of rawRows) {
    const source = validatedSourceRow(rawRow, seenIds);
    recordOutcome(customerOutcome(source, defaults, rawRow.rowNumber), summary, rows);
  }

  return {
    rows,
    summary,
    normalizedHash: normalizedHash(rows)
  };
}

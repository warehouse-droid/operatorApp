// @ts-check

import { canonicalJson } from "./canonical-json.js";
import { projectObservedNetSuiteRecord } from "./netsuite-readonly-adapter.js";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const EXCLUDED_EVIDENCE_KEY = /(?:password|secret|token|credential|rawpayload|rawresponse|links?)/i;
const CSV_HEADERS = Object.freeze([
  "run_id",
  "account_id",
  "environment_name",
  "configuration_hash",
  "run_status",
  "generated_at",
  "current",
  "signoff_status",
  "sequence_number",
  "check_code",
  "mapping_type",
  "local_key",
  "required",
  "severity",
  "check_status",
  "expected_json",
  "observed_json",
  "message"
]);

/** @template T @param {T} value @param {Set<object>} [seen] @returns {Readonly<T>} */
function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

/** @param {unknown} value */
function text(value) {
  return String(value ?? "");
}

/** @param {unknown} value @returns {unknown} */
function safeScalar(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

/** @param {unknown} value @param {WeakSet<object>} seen @returns {unknown} */
function safeEvidenceValue(value, seen) {
  if (!value || typeof value !== "object") {
    return safeScalar(value);
  }
  if (seen.has(value)) {
    return null;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => safeEvidenceValue(entry, seen));
  }
  /** @type {Record<string, unknown>} */
  const projected = {};
  for (const [key, child] of Object.entries(value)) {
    if (!DANGEROUS_KEYS.has(key) && !EXCLUDED_EVIDENCE_KEY.test(key)) {
      projected[key] = safeEvidenceValue(child, seen);
    }
  }
  return projected;
}

/** @param {unknown} value */
function safeEvidence(value) {
  return safeEvidenceValue(value, new WeakSet());
}

/** @param {unknown} value */
function observedEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value === null || value === undefined ? null : safeEvidence(value);
  }
  const observed = /** @type {Record<string, unknown>} */ (value);
  const recordType = text(observed.recordType);
  return recordType
    ? projectObservedNetSuiteRecord(recordType, observed)
    : safeEvidence(observed);
}

/** @param {unknown} value */
function projectSignoff(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const signoff = /** @type {Record<string, unknown>} */ (value);
  return {
    status: text(signoff.status || "signed"),
    signoffId: text(signoff.signoffId),
    actor: text(signoff.actor),
    note: text(signoff.note),
    signedAt: text(signoff.signedAt),
    configurationHash: text(signoff.configurationHash)
  };
}

/** @param {unknown} value */
function projectCheck(value) {
  const check = value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
  return {
    sequenceNumber: Number(check.sequenceNumber),
    checkCode: text(check.checkCode),
    mappingType: text(check.mappingType),
    localKey: text(check.localKey),
    required: check.required === true,
    severity: text(check.severity),
    status: text(check.status),
    expected: safeEvidence(check.expected),
    observed: observedEvidence(check.observed),
    message: text(check.message)
  };
}

/** @param {ReturnType<typeof projectCheck>} left @param {ReturnType<typeof projectCheck>} right */
function compareChecks(left, right) {
  const sequenceDifference = left.sequenceNumber - right.sequenceNumber;
  return sequenceDifference || left.checkCode.localeCompare(right.checkCode);
}

/**
 * @param {unknown} value
 * @returns {Readonly<{
 *   schemaVersion: number,
 *   runId: string,
 *   accountId: string,
 *   environmentName: string,
 *   configurationHash: string,
 *   status: string,
 *   generatedAt: string,
 *   current: boolean,
 *   signoff: ReturnType<typeof projectSignoff>,
 *   checks: ReturnType<typeof projectCheck>[]
 * }>}
 */
export function buildPreflightReport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("A persisted NetSuite preflight run is required.");
  }
  const run = /** @type {Record<string, unknown>} */ (value);
  const checks = Array.isArray(run.checks)
    ? run.checks.map(projectCheck).sort(compareChecks)
    : [];
  return deepFreeze({
    schemaVersion: 1,
    runId: text(run.runId),
    accountId: text(run.accountId),
    environmentName: text(run.environmentName),
    configurationHash: text(run.configurationHash),
    status: text(run.status),
    generatedAt: text(run.generatedAt),
    current: run.current === true,
    signoff: projectSignoff(run.signoff),
    checks
  });
}

/** @param {unknown} report */
export function serializePreflightJson(report) {
  return `${canonicalJson(report)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")}\n`;
}

/** @param {unknown} value */
function csvCell(value) {
  let rendered = text(value);
  if (/^[\u0000-\u0020]*[=+@-]/.test(rendered)) {
    rendered = `'${rendered}`;
  }
  if (/[",\r\n]/.test(rendered)) {
    return `"${rendered.replaceAll("\"", "\"\"")}"`;
  }
  return rendered;
}

/** @param {unknown} signoff */
function signoffStatus(signoff) {
  return signoff && typeof signoff === "object" && !Array.isArray(signoff)
    ? text(/** @type {{status?: unknown}} */ (signoff).status || "signed")
    : "not_signed";
}

/** @param {Record<string, unknown>} report @param {Record<string, unknown>} check */
function csvRow(report, check) {
  return [
    report.runId,
    report.accountId,
    report.environmentName,
    report.configurationHash,
    report.status,
    report.generatedAt,
    report.current,
    signoffStatus(report.signoff),
    check.sequenceNumber,
    check.checkCode,
    check.mappingType,
    check.localKey,
    check.required,
    check.severity,
    check.status,
    canonicalJson(check.expected),
    canonicalJson(check.observed),
    check.message
  ].map(csvCell).join(",");
}

/** @param {unknown} value */
export function serializePreflightCsv(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("A NetSuite preflight report is required.");
  }
  const report = /** @type {Record<string, unknown>} */ (value);
  const checks = Array.isArray(report.checks)
    ? report.checks.map((check) => /** @type {Record<string, unknown>} */ (check))
    : [];
  return `${[CSV_HEADERS.join(","), ...checks.map((check) => csvRow(report, check))].join("\r\n")}\r\n`;
}

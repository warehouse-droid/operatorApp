// @ts-check

import { canonicalSha256 } from "./canonical-json.js";
import { MbtError } from "./errors.js";

/** @typedef {{mappingType?: unknown, localKey?: unknown, externalId?: unknown, revision?: unknown, [key: string]: unknown}} Mapping */
/** @typedef {{checkType?: unknown, status?: unknown, [key: string]: unknown}} PreflightCheck */

/** @param {unknown} value */
function text(value) {
  return String(value ?? "").trim();
}

/** @param {unknown} mappings */
export function configurationHash(mappings) {
  if (!Array.isArray(mappings) || !mappings.every((mapping) => mapping && typeof mapping === "object" && !Array.isArray(mapping))) {
    throw new TypeError("NetSuite mappings must be an array.");
  }
  const normalized = /** @type {Mapping[]} */ (mappings).map((mapping) => ({ ...mapping }));
  normalized.sort((left, right) => {
    const leftKey = [left.mappingType, left.localKey, left.externalId, left.revision]
      .map(text).join("\u0000");
    const rightKey = [right.mappingType, right.localKey, right.externalId, right.revision]
      .map(text).join("\u0000");
    return leftKey.localeCompare(rightKey);
  });
  return canonicalSha256(normalized);
}

/** @param {PreflightCheck[]} checks */
function checksByType(checks) {
  /** @type {Map<string, PreflightCheck>} */
  const byType = new Map();
  for (const check of checks) {
    const checkType = text(check?.checkType);
    if (checkType && !byType.has(checkType)) {
      byType.set(checkType, check);
    }
  }
  return byType;
}

/** @param {PreflightCheck | undefined} check @param {string} checkType */
function failedCheckReason(check, checkType) {
  if (!check) {
    return `missing:${checkType}`;
  }
  const status = text(check.status).toLowerCase();
  return status === "passed" ? null : `${status || "invalid"}:${checkType}`;
}

/**
 * @param {object} [input]
 * @param {string} [input.currentConfigurationHash]
 * @param {string} [input.runConfigurationHash]
 * @param {unknown[]} [input.requiredChecks]
 * @param {PreflightCheck[]} [input.checks]
 */
export function evaluatePreflightReadiness({
  currentConfigurationHash,
  runConfigurationHash,
  requiredChecks = [],
  checks = []
} = {}) {
  const reasons = [];
  if (!text(currentConfigurationHash) || currentConfigurationHash !== runConfigurationHash) {
    reasons.push("configuration_changed");
  }

  const byType = checksByType(Array.isArray(checks) ? checks : []);
  for (const requiredCheck of Array.isArray(requiredChecks) ? requiredChecks : []) {
    const checkType = text(requiredCheck);
    const reason = failedCheckReason(byType.get(checkType), checkType);
    if (reason) {
      reasons.push(reason);
    }
  }
  return { ready: reasons.length === 0, reasons };
}

/**
 * @param {object} [input]
 * @param {(type: string, id: string) => unknown | Promise<unknown>} [input.readRecord]
 */
export function createPhaseOneNetSuiteAdapter({ readRecord } = {}) {
  if (typeof readRecord !== "function") {
    throw new TypeError("A NetSuite read adapter is required.");
  }
  /** @returns {Promise<never>} */
  const rejectWrite = async () => {
    throw new MbtError({
      status: 409,
      code: "MBT_NETSUITE_WRITE_DISABLED",
      message: "NetSuite operational writes are disabled in MBT Phase 1."
    });
  };
  return Object.freeze({
    readRecord,
    createSalesOrder: rejectWrite,
    createDeposit: rejectWrite,
    updateSalesOrder: rejectWrite,
    deleteRecord: rejectWrite
  });
}

// @ts-check

import { createHash } from "node:crypto";

const INVALID_JSON_MESSAGE = "Canonical JSON accepts only JSON values.";

/** @typedef {null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue}} JsonValue */

/** @returns {TypeError} */
function invalidJson() {
  return new TypeError(INVALID_JSON_MESSAGE);
}

/**
 * @param {number} value
 * @returns {number}
 */
function canonicalizeNumber(value) {
  if (!Number.isFinite(value)) {
    throw invalidJson();
  }
  return Object.is(value, -0) ? 0 : value;
}

/**
 * @param {object} value
 * @param {Set<object>} ancestors
 * @returns {JsonValue[] | {[key: string]: JsonValue}}
 */
function canonicalizeObject(value, ancestors) {
  if (ancestors.has(value)) {
    throw invalidJson();
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw invalidJson();
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => canonicalizeValue(entry, ancestors));
    }
    const record = /** @type {Record<string, unknown>} */ (value);
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalizeValue(record[key], ancestors)])
    );
  } finally {
    ancestors.delete(value);
  }
}

/**
 * @param {unknown} value
 * @param {Set<object>} ancestors
 * @returns {JsonValue}
 */
function canonicalizeValue(value, ancestors) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return canonicalizeNumber(value);
  }
  if (typeof value !== "object") {
    throw invalidJson();
  }
  return canonicalizeObject(value, ancestors);
}

/** @param {unknown} value @returns {JsonValue} */
export function canonicalize(value) {
  return canonicalizeValue(value, new Set());
}

/** @param {unknown} value @returns {string} */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

/** @param {unknown} value @returns {string} */
export function canonicalSha256(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

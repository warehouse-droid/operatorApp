// @ts-check

import { MbtError } from "./errors.js";

const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 1_000;

/** @param {string} code @param {string} message */
function sourceError(code, message) {
  return new MbtError({ status: 502, code, message });
}

/** @param {unknown} value */
function pageSize(value) {
  const normalized = value === undefined ? DEFAULT_PAGE_SIZE : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > MAX_PAGE_SIZE) {
    throw new TypeError(`Customer source page size must be between 1 and ${MAX_PAGE_SIZE}.`);
  }
  return normalized;
}

/** @param {unknown} value */
function positiveInternalId(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError("Customer source cursor internalId must be a positive integer.");
    }
    return value;
  }
  const normalized = String(value ?? "").trim();
  if (!/^[1-9]\d*$/u.test(normalized)
      || BigInt(normalized) > 9_223_372_036_854_775_807n) {
    throw new TypeError("Customer source cursor internalId must be a positive bigint.");
  }
  return BigInt(normalized).toString();
}

/** @param {unknown} value */
function cursor(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Customer source cursor must be an object or null.");
  }
  const candidate = /** @type {{modifiedAt?: unknown, internalId?: unknown}} */ (value);
  const modifiedAt = String(candidate.modifiedAt ?? "");
  if (!Number.isFinite(Date.parse(modifiedAt))) {
    throw new TypeError("Customer source cursor modifiedAt must be a valid timestamp.");
  }
  return {
    modifiedAt: new Date(modifiedAt).toISOString(),
    internalId: positiveInternalId(candidate.internalId)
  };
}

/** @param {unknown} value */
function sourcePage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw sourceError("MBT_CUSTOMER_SOURCE_INVALID", "Customer source returned an invalid page.");
  }
  const page = /** @type {{records?: unknown, nextCursor?: unknown, complete?: unknown, snapshotComplete?: unknown}} */ (value);
  if (!Array.isArray(page.records)) {
    throw sourceError(
      "MBT_CUSTOMER_SOURCE_INVALID",
      "Customer source page records must be an array."
    );
  }
  return {
    records: structuredClone(page.records),
    nextCursor: cursor(page.nextCursor),
    complete: page.complete === true,
    snapshotComplete: page.snapshotComplete === true
  };
}

/**
 * Build the deliberately capability-limited NetSuite customer source. The
 * adapter receives one query function; mutation clients are neither retained
 * nor exposed, so sync orchestration cannot create/update/delete records.
 *
 * @param {{queryCustomers?: (input: Record<string, unknown>) => Promise<unknown>}} [options]
 */
export function createReadOnlyNetSuiteCustomerSource(options = {}) {
  const queryCustomers = options.queryCustomers;
  if (typeof queryCustomers !== "function") {
    throw new TypeError("A read-only customer query function is required.");
  }
  return Object.freeze({
    /** @param {Record<string, unknown>} [input] */
    async fetchPage(input = {}) {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new TypeError("Customer source page input must be an object.");
      }
      const request = {
        ...input,
        cursor: cursor(input.cursor),
        limit: pageSize(input.limit)
      };
      return sourcePage(await queryCustomers(request));
    }
  });
}

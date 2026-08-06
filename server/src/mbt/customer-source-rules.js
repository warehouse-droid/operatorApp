// @ts-check

const AUTHORITATIVE_SOURCES = new Set(["netsuite_read", "customer_master_event"]);
const SOURCE_ORDER = Object.freeze({
  csv_bootstrap: 0,
  customer_master_event: 1,
  netsuite_read: 2
});

/** @param {unknown} value @param {string} field */
function positiveIntegerText(value, field) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${field} must be a positive integer.`);
    }
    return String(value);
  }
  const normalized = String(value ?? "").trim();
  if (!/^[1-9]\d*$/u.test(normalized)) {
    throw new TypeError(`${field} must be a positive integer.`);
  }
  const canonical = BigInt(normalized).toString();
  if (BigInt(canonical) > 9_223_372_036_854_775_807n) {
    throw new TypeError(`${field} exceeds the PostgreSQL bigint range.`);
  }
  return canonical;
}

/** @param {unknown} value @param {string} field */
function timestamp(value, field) {
  const milliseconds = Date.parse(String(value ?? ""));
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError(`${field} must be a valid timestamp.`);
  }
  return milliseconds;
}

/** @param {unknown} value */
function sourceKind(value) {
  const normalized = String(value ?? "");
  if (!Object.hasOwn(SOURCE_ORDER, normalized)) {
    throw new TypeError("Customer source kind is not supported.");
  }
  return normalized;
}

/** @param {unknown} value */
function sourceRank(value) {
  const normalized = sourceKind(value);
  if (normalized === "netsuite_read") {
    return 2;
  }
  return normalized === "customer_master_event" ? 1 : 0;
}

/** @param {unknown} value @param {string} field */
function requiredText(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new TypeError(`${field} is required.`);
  }
  return normalized;
}

/**
 * @typedef {object} CustomerCursor
 * @property {string} modifiedAt
 * @property {number | string} internalId
 */

/**
 * @typedef {object} CustomerObservation
 * @property {number | string} netsuiteId
 * @property {string} sourceKind
 * @property {string} sourceModifiedAt
 * @property {string} sourceVersion
 * @property {string} payloadHash
 * @property {unknown} [displayName]
 * @property {unknown} [key]
 */

/** @param {CustomerCursor} left @param {CustomerCursor} right */
export function compareCustomerCursor(left, right) {
  const timeDifference = timestamp(left?.modifiedAt, "Customer cursor modifiedAt")
    - timestamp(right?.modifiedAt, "Customer cursor modifiedAt");
  if (timeDifference !== 0) {
    return timeDifference;
  }
  const leftId = BigInt(positiveIntegerText(left?.internalId, "Customer cursor internalId"));
  const rightId = BigInt(positiveIntegerText(right?.internalId, "Customer cursor internalId"));
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

/** @param {CustomerCursor} candidate @param {CustomerCursor} current */
export function customerIsAfterCursor(candidate, current) {
  return compareCustomerCursor(candidate, current) > 0;
}

/** @param {CustomerObservation} observation */
function validateObservation(observation) {
  positiveIntegerText(observation?.netsuiteId, "Customer NetSuite ID");
  sourceKind(observation?.sourceKind);
  timestamp(observation?.sourceModifiedAt, "Customer sourceModifiedAt");
  requiredText(observation?.sourceVersion, "Customer sourceVersion");
  requiredText(observation?.payloadHash, "Customer payloadHash");
}

/** @param {CustomerObservation} observation */
function isAuthoritative(observation) {
  return AUTHORITATIVE_SOURCES.has(sourceKind(observation.sourceKind));
}

/**
 * @param {CustomerObservation} current
 * @param {CustomerObservation} incoming
 * @returns {{action: "apply" | "unchanged" | "conflict", reason: string} | null}
 */
function sourceAuthorityDecision(current, incoming) {
  const currentAuthoritative = isAuthoritative(current);
  const incomingAuthoritative = isAuthoritative(incoming);
  if (!currentAuthoritative && incomingAuthoritative) {
    return { action: "apply", reason: "authoritative_source_supersedes_csv" };
  }
  if (currentAuthoritative && !incomingAuthoritative) {
    return current.payloadHash === incoming.payloadHash
      ? { action: "unchanged", reason: "csv_matches_authoritative_source" }
      : { action: "conflict", reason: "csv_cannot_overwrite_authoritative_source" };
  }
  return null;
}

/**
 * Decide one source-owned customer observation without mutating either input.
 * Local site profiles are deliberately absent from this boundary.
 *
 * @param {CustomerObservation | null | undefined} current
 * @param {CustomerObservation} incoming
 * @returns {{action: "apply" | "ignore" | "unchanged" | "conflict", reason: string}}
 */
export function decideCustomerObservation(current, incoming) {
  validateObservation(incoming);
  if (!current) {
    return { action: "apply", reason: "customer_not_observed" };
  }
  validateObservation(current);
  if (positiveIntegerText(current.netsuiteId, "Customer NetSuite ID")
      !== positiveIntegerText(incoming.netsuiteId, "Customer NetSuite ID")) {
    throw new TypeError("Customer observations must share one NetSuite internal ID.");
  }

  const authorityDecision = sourceAuthorityDecision(current, incoming);
  if (authorityDecision) {
    return authorityDecision;
  }

  const currentTime = timestamp(current.sourceModifiedAt, "Customer sourceModifiedAt");
  const incomingTime = timestamp(incoming.sourceModifiedAt, "Customer sourceModifiedAt");
  if (incomingTime < currentTime) {
    return { action: "ignore", reason: "older_source_observation" };
  }
  if (incomingTime > currentTime) {
    return { action: "apply", reason: "newer_source_observation" };
  }
  if (current.sourceVersion === incoming.sourceVersion
      && current.payloadHash === incoming.payloadHash) {
    return { action: "unchanged", reason: "exact_source_observation" };
  }
  if (current.payloadHash === incoming.payloadHash) {
    return { action: "unchanged", reason: "equivalent_source_payload" };
  }
  return { action: "conflict", reason: "equal_time_different_payload" };
}

/** @param {CustomerObservation} left @param {CustomerObservation} right */
function deterministicObservationOrder(left, right) {
  const leftId = BigInt(positiveIntegerText(left.netsuiteId, "Customer NetSuite ID"));
  const rightId = BigInt(positiveIntegerText(right.netsuiteId, "Customer NetSuite ID"));
  const idDifference = leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  if (idDifference !== 0) {
    return idDifference;
  }
  const timeDifference = timestamp(left.sourceModifiedAt, "Customer sourceModifiedAt")
    - timestamp(right.sourceModifiedAt, "Customer sourceModifiedAt");
  if (timeDifference !== 0) {
    return timeDifference;
  }
  const sourceDifference = sourceRank(left.sourceKind) - sourceRank(right.sourceKind);
  if (sourceDifference !== 0) {
    return sourceDifference;
  }
  const versionDifference = String(left.sourceVersion).localeCompare(String(right.sourceVersion));
  return versionDifference || String(left.payloadHash).localeCompare(String(right.payloadHash));
}

/**
 * Deterministically reduce an unordered batch. This pure reducer is also the
 * property-test oracle used by database-backed application code.
 *
 * @param {CustomerObservation[]} existing
 * @param {CustomerObservation[]} incoming
 */
export function reconcileCustomerObservations(existing, incoming) {
  if (!Array.isArray(existing) || !Array.isArray(incoming)) {
    throw new TypeError("Customer observation collections must be arrays.");
  }
  /** @type {Map<string, CustomerObservation>} */
  const customers = new Map();
  for (const observation of [...existing].sort(deterministicObservationOrder)) {
    validateObservation(observation);
    customers.set(positiveIntegerText(observation.netsuiteId, "Customer NetSuite ID"), observation);
  }
  /** @type {Array<{netsuiteId: number | string, current: CustomerObservation, incoming: CustomerObservation, reason: string}>} */
  const conflicts = [];
  for (const observation of [...incoming].sort(deterministicObservationOrder)) {
    validateObservation(observation);
    const id = positiveIntegerText(observation.netsuiteId, "Customer NetSuite ID");
    const current = customers.get(id);
    const decision = decideCustomerObservation(current, observation);
    if (decision.action === "apply") {
      customers.set(id, observation);
    } else if (decision.action === "conflict" && current) {
      conflicts.push({
        netsuiteId: observation.netsuiteId,
        current,
        incoming: observation,
        reason: decision.reason
      });
    }
  }
  return {
    customers: [...customers.values()].sort(deterministicObservationOrder),
    conflicts
  };
}

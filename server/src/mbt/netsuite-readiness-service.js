// @ts-check

import { canonicalJson } from "./canonical-json.js";
import { NETSUITE_READINESS_REQUIREMENTS } from "./netsuite-readiness-catalog.js";
import {
  claimNetSuitePreflightRun,
  completeNetSuitePreflightRun
} from "./netsuite-readiness-repository.js";

const SUBSIDIARY_FIELDS = new Set(["subsidiaryId", "subsidiaryIds"]);
const PASSED_MESSAGE = "Verified with read-only NetSuite sandbox metadata access.";
const MAX_CONCURRENT_NETSUITE_READS = 4;
const NULLABLE_REQUIRED_EXPECTED_FIELDS = new Set(["taxItemId", "termsId"]);
/** @type {Readonly<Record<string, string>>} */
const STATUS_MESSAGES = Object.freeze({
  missing: "The required NetSuite mapping or record is missing.",
  inactive: "The required NetSuite mapping or record is inactive.",
  invalid: "The NetSuite metadata does not match the configured expectation.",
  wrong_subsidiary: "The NetSuite record does not belong to the configured MBT subsidiary.",
  permission_denied: "The integration role cannot read the required NetSuite metadata.",
  unable_to_verify: "The required NetSuite metadata could not be verified."
});

/** @typedef {null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue}} JsonValue */

/** @param {unknown} value */
function text(value) {
  return String(value ?? "").trim();
}

/** @param {unknown} value */
function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  return isRecord(value) ? /** @type {Record<string, unknown>} */ (value) : {};
}

/** @param {unknown} value @returns {JsonValue} */
function safeJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map(safeJsonValue);
  }
  if (!isRecord(value)) {
    return null;
  }
  return /** @type {{[key: string]: JsonValue}} */ (Object.fromEntries(Object.entries(record(value)).map(([key, child]) => [
    key,
    safeJsonValue(child)
  ])));
}

/** @param {unknown} value @param {boolean} caseInsensitive @returns {JsonValue} */
function comparable(value, caseInsensitive) {
  if (typeof value === "string") {
    return caseInsensitive ? value.toLocaleLowerCase("en-CA") : value;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => comparable(entry, caseInsensitive))
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  }
  if (isRecord(value)) {
    return /** @type {{[key: string]: JsonValue}} */ (Object.fromEntries(Object.entries(record(value))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, comparable(child, caseInsensitive)])));
  }
  return value === undefined ? null : safeJsonValue(value);
}

/** @param {unknown} left @param {unknown} right @param {boolean} caseInsensitive */
function semanticallyEqual(left, right, caseInsensitive) {
  return canonicalJson(comparable(left, caseInsensitive))
    === canonicalJson(comparable(right, caseInsensitive));
}

/** @param {Record<string, unknown>} mapping */
function mappingConfiguration(mapping) {
  return record(mapping.configuration);
}

/** @param {Record<string, unknown>} mapping */
function caseInsensitiveFields(mapping) {
  const fields = mappingConfiguration(mapping).caseInsensitiveFields;
  return new Set(Array.isArray(fields) ? fields.map(text).filter(Boolean) : []);
}

/** @param {Record<string, unknown>} requirement @param {Record<string, unknown>} mapping */
function expectedEvidence(requirement, mapping) {
  const configured = record(mappingConfiguration(mapping).expected);
  /** @type {Record<string, unknown>} */
  const expected = {
    ...configured,
    ...record(requirement.expected),
    recordType: text(mapping.externalRecordType)
  };
  if (text(requirement.readStrategy) === "metadata_catalog") {
    expected.scriptId = text(mapping.externalScriptId);
    expected.appliesTo = [text(mapping.externalRecordType)];
  }
  if (requirement.requiresSubsidiaryNetSuiteId === true) {
    delete expected.subsidiaryIds;
    expected.subsidiaryId = text(mapping.subsidiaryNetSuiteId);
  }
  return expected;
}

/** @param {Record<string, unknown>} mapping */
function mappingIdentity(mapping) {
  return `${text(mapping.mappingType)}\u0000${text(mapping.localKey)}`;
}

/** @param {Record<string, unknown>[]} mappings */
function mappingIndex(mappings) {
  return new Map(mappings.map((mapping) => [mappingIdentity(mapping), mapping]));
}

/** @param {Record<string, unknown>} requirement */
function requirementIdentity(requirement) {
  return `${text(requirement.mappingType)}\u0000${text(requirement.localKey)}`;
}

/** @param {string} checkCode @param {string} status @param {Record<string, unknown> | null} observed */
function checkResult(checkCode, status, observed) {
  return {
    checkCode,
    status,
    observed,
    message: status === "passed" ? PASSED_MESSAGE : STATUS_MESSAGES[status] || STATUS_MESSAGES.unable_to_verify
  };
}

/** @param {Record<string, unknown>} requirement @param {Record<string, unknown>} mapping */
function remoteMappingInvalid(requirement, mapping) {
  const strategy = text(requirement.readStrategy);
  const allowedRecordTypes = Array.isArray(requirement.allowedRecordTypes)
    ? requirement.allowedRecordTypes.map(text)
    : [];
  if (["record_by_id", "metadata_catalog"].includes(strategy)
      && !allowedRecordTypes.includes(text(mapping.externalRecordType))) {
    return true;
  }
  return strategy === "metadata_catalog" && !text(mapping.externalScriptId);
}

/** @param {string} field @param {Record<string, unknown>} configuredExpected */
function missingRequiredExpectedValue(field, configuredExpected) {
  if (!Object.hasOwn(configuredExpected, field)) {
    return true;
  }
  const value = configuredExpected[field];
  if (value === null) {
    return !NULLABLE_REQUIRED_EXPECTED_FIELDS.has(field);
  }
  return typeof value === "string" && !value.trim();
}

/** @param {Record<string, unknown>} requirement @param {Record<string, unknown>} mapping */
function semanticMappingInvalid(requirement, mapping) {
  const configuredExpected = record(mappingConfiguration(mapping).expected);
  const requiredExpectedFields = Array.isArray(requirement.requiredExpectedFields)
    ? requirement.requiredExpectedFields.map(text)
    : [];
  if (requiredExpectedFields.some((field) => missingRequiredExpectedValue(field, configuredExpected))) {
    return true;
  }
  const allowedAccountTypes = Array.isArray(requirement.allowedAccountTypes)
    ? requirement.allowedAccountTypes.map(text)
    : [];
  return allowedAccountTypes.length > 0
    && !allowedAccountTypes.includes(text(configuredExpected.accountType));
}

/**
 * @param {Record<string, unknown>} requirement
 * @param {Record<string, unknown>} mapping
 * @param {string} mbtSubsidiaryId
 */
function mappingFailure(requirement, mapping, mbtSubsidiaryId) {
  if (mapping.active !== true || mapping.isCurrent === false) {
    return "inactive";
  }
  if (remoteMappingInvalid(requirement, mapping)) {
    return "invalid";
  }
  if (text(requirement.checkCode) === "customer_33" && text(mapping.externalId) !== "33") {
    return "invalid";
  }
  if (semanticMappingInvalid(requirement, mapping)) {
    return "invalid";
  }
  if (requirement.requiresSubsidiaryNetSuiteId === true
      && (!mbtSubsidiaryId || text(mapping.subsidiaryNetSuiteId) !== mbtSubsidiaryId)) {
    return "wrong_subsidiary";
  }
  return null;
}

/** @param {Record<string, unknown>} requirement */
function dependencyCheckCodes(requirement) {
  const dependencies = record(requirement.expected).derivedFromCheckCodes;
  return Array.isArray(dependencies) ? dependencies.map(text).filter(Boolean) : [];
}

/**
 * @param {Record<string, unknown>} requirement
 * @param {Map<string, Record<string, unknown>>} priorChecks
 */
function derivedPermissionResult(requirement, priorChecks) {
  const checkCode = text(requirement.checkCode);
  const dependencies = dependencyCheckCodes(requirement);
  const evidenceStatuses = Object.fromEntries(dependencies.map((dependency) => [
    dependency,
    text(priorChecks.get(dependency)?.status || "unable_to_verify")
  ]));
  const statuses = Object.values(evidenceStatuses);
  const status = statuses.length > 0 && statuses.every((candidate) => candidate === "passed")
    ? "passed"
    : statuses.includes("permission_denied") ? "permission_denied" : "unable_to_verify";
  return checkResult(checkCode, status, {
    permissionLevel: "view",
    derivedFromCheckCodes: dependencies,
    evidenceStatuses
  });
}

/** @param {Record<string, unknown>} requirement */
function configuredPermissionResult(requirement) {
  return checkResult(text(requirement.checkCode), "passed", {
    permissionLevel: "configured_unproven"
  });
}

/** @param {unknown} error */
function adapterFailureStatus(error) {
  const status = Number(record(error).status);
  if (status === 403) {
    return "permission_denied";
  }
  if (status === 404) {
    return "missing";
  }
  return "unable_to_verify";
}

/**
 * @param {Record<string, unknown>} observed
 * @param {Record<string, unknown>} expected
 */
function boundedObserved(observed, expected) {
  const allowed = new Set([
    "id",
    "active",
    "recordType",
    "subsidiaryId",
    "subsidiaryIds",
    ...Object.keys(expected).filter((key) => key !== "externalId")
  ]);
  return Object.fromEntries([...allowed]
    .filter((key) => observed[key] !== undefined)
    .map((key) => [key, safeJsonValue(observed[key])]));
}

/**
 * @param {Record<string, unknown>} requirement
 * @param {Record<string, unknown>} mapping
 * @param {Record<string, unknown>} observed
 */
function observedRecordIdInvalid(requirement, mapping, observed) {
  return text(requirement.readStrategy) === "record_by_id"
    && (!Object.hasOwn(observed, "id") || text(observed.id) !== text(mapping.externalId));
}

/** @param {Record<string, unknown>} observed */
function observedSubsidiaryMembership(observed) {
  return new Set([
    ...(Array.isArray(observed.subsidiaryIds) ? observed.subsidiaryIds : []),
    ...(Object.hasOwn(observed, "subsidiaryId") ? [observed.subsidiaryId] : [])
  ].map(text).filter(Boolean));
}

/**
 * @param {Record<string, unknown>} requirement
 * @param {Record<string, unknown>} mapping
 * @param {Record<string, unknown>} observed
 * @param {Record<string, unknown>} expected
 */
function expectedFieldFailure(requirement, mapping, observed, expected) {
  const insensitive = caseInsensitiveFields(mapping);
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (requirement.requiresSubsidiaryMembership === true && SUBSIDIARY_FIELDS.has(field)) {
      continue;
    }
    if (field === "externalId") {
      if (text(mapping.externalId) !== text(expectedValue)
        || text(observed.id) !== text(expectedValue)) {
        return "invalid";
      }
      continue;
    }
    if (!Object.hasOwn(observed, field) || observed[field] === undefined) {
      return "invalid";
    }
    const compareCaseInsensitive = field !== "accountType" && insensitive.has(field);
    if (!semanticallyEqual(observed[field], expectedValue, compareCaseInsensitive)) {
      return SUBSIDIARY_FIELDS.has(field) ? "wrong_subsidiary" : "invalid";
    }
  }
  return null;
}

/**
 * @param {Record<string, unknown>} requirement
 * @param {Record<string, unknown>} mapping
 * @param {Record<string, unknown>} observed
 * @param {Record<string, unknown>} expected
 * @param {string} mbtSubsidiaryId
 */
function observedFailure(requirement, mapping, observed, expected, mbtSubsidiaryId) {
  if (observed.active === false) {
    return "inactive";
  }
  if (observedRecordIdInvalid(requirement, mapping, observed)) {
    return "invalid";
  }
  if (requirement.requiresSubsidiaryMembership === true) {
    if (!observedSubsidiaryMembership(observed).has(mbtSubsidiaryId)) {
      return "wrong_subsidiary";
    }
  }
  return expectedFieldFailure(requirement, mapping, observed, expected);
}

/**
 * @param {Record<string, unknown>} requirement
 * @param {Record<string, unknown> | undefined} mapping
 * @param {{readRecord: (recordType: string, externalId: string, descriptor?: {readStrategy?: "record_by_id" | "metadata_catalog", scriptId?: string}) => Promise<unknown>}} adapter
 * @param {Map<string, Record<string, unknown>>} priorChecks
 * @param {string} mbtSubsidiaryId
 */
async function evaluateRequirement(requirement, mapping, adapter, priorChecks, mbtSubsidiaryId) {
  const checkCode = text(requirement.checkCode);
  if (!mapping) {
    return checkResult(checkCode, "missing", null);
  }
  const ineligible = mappingFailure(requirement, mapping, mbtSubsidiaryId);
  if (ineligible) {
    return checkResult(checkCode, ineligible, null);
  }
  const strategy = text(requirement.readStrategy);
  if (strategy === "unsupported") {
    return checkResult(checkCode, "unable_to_verify", null);
  }
  if (strategy === "configured_unproven") {
    return configuredPermissionResult(requirement);
  }
  if (strategy === "derived_permission") {
    return derivedPermissionResult(requirement, priorChecks);
  }
  if (strategy !== "record_by_id" && strategy !== "metadata_catalog") {
    return checkResult(checkCode, "unable_to_verify", null);
  }
  let observedValue;
  try {
    observedValue = await adapter.readRecord(
      text(mapping.externalRecordType),
      text(mapping.externalId),
      {
        readStrategy: strategy,
        ...(strategy === "metadata_catalog"
          ? { scriptId: text(mapping.externalScriptId) }
          : {})
      }
    );
  } catch (error) {
    return checkResult(checkCode, adapterFailureStatus(error), null);
  }
  if (!isRecord(observedValue)) {
    return checkResult(checkCode, "unable_to_verify", null);
  }
  const observed = record(observedValue);
  const expected = expectedEvidence(requirement, mapping);
  const persistedObserved = boundedObserved(observed, expected);
  const failure = observedFailure(requirement, mapping, observed, expected, mbtSubsidiaryId);
  return checkResult(checkCode, failure || "passed", persistedObserved);
}

/**
 * Preserve input order while allowing a small, fixed number of independent
 * evidence reads to overlap. A fixed ceiling protects both the NetSuite
 * sandbox and the finite preflight lease.
 *
 * @template T
 * @template U
 * @param {T[]} values
 * @param {number} concurrency
 * @param {(value: T) => Promise<U>} project
 * @returns {Promise<U[]>}
 */
async function mapWithConcurrency(values, concurrency, project) {
  /** @type {U[]} */
  const projected = new Array(values.length);
  let nextIndex = 0;
  const consume = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      projected[index] = await project(/** @type {T} */ (values[index]));
    }
  };
  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, consume));
  return projected;
}

/**
 * Evaluate evidence-producing checks before permission checks whose result is
 * derived from that evidence. The returned order still exactly matches the
 * immutable server catalog.
 *
 * @param {Record<string, unknown>[]} requirements
 * @param {Map<string, Record<string, unknown>>} byIdentity
 * @param {{readRecord: (recordType: string, externalId: string, descriptor?: {readStrategy?: "record_by_id" | "metadata_catalog", scriptId?: string}) => Promise<unknown>}} adapter
 */
async function evaluateRequirements(requirements, byIdentity, adapter) {
  /** @type {Map<string, Record<string, unknown>>} */
  const checksByCode = new Map();
  const mbtSubsidiaryId = text(byIdentity.get("subsidiary\u0000mbt")?.externalId);
  const evidenceRequirements = requirements.filter(({ readStrategy }) => (
    text(readStrategy) !== "derived_permission"
  ));
  const evidenceChecks = await mapWithConcurrency(
    evidenceRequirements,
    MAX_CONCURRENT_NETSUITE_READS,
    async (requirement) => evaluateRequirement(
      requirement,
      byIdentity.get(requirementIdentity(requirement)),
      adapter,
      checksByCode,
      mbtSubsidiaryId
    )
  );
  for (const check of evidenceChecks) {
    checksByCode.set(text(check.checkCode), check);
  }
  for (const requirement of requirements.filter(({ readStrategy }) => (
    text(readStrategy) === "derived_permission"
  ))) {
    const check = await evaluateRequirement(
      requirement,
      byIdentity.get(requirementIdentity(requirement)),
      adapter,
      checksByCode,
      mbtSubsidiaryId
    );
    checksByCode.set(text(check.checkCode), check);
  }
  return requirements.map((requirement) => (
    checksByCode.get(text(requirement.checkCode))
  )).filter((check) => check !== undefined);
}

/**
 * @typedef {object} ReadinessRepository
 * @property {(input: Record<string, unknown>) => Promise<Record<string, unknown>>} claimNetSuitePreflightRun
 * @property {(input: {preflightRunId: string, leaseToken: string, checks: Record<string, unknown>[]}) => Promise<Record<string, unknown>>} completeNetSuitePreflightRun
 */

const DEFAULT_REPOSITORY = Object.freeze({
  claimNetSuitePreflightRun,
  completeNetSuitePreflightRun
});

/** @param {unknown} adapter @param {unknown} repository */
function assertPreflightCollaborators(adapter, repository) {
  if (!adapter || typeof record(adapter).readRecord !== "function") {
    throw new TypeError("A read-only NetSuite adapter is required.");
  }
  const repositoryValue = record(repository);
  if (typeof repositoryValue.claimNetSuitePreflightRun !== "function"
    || typeof repositoryValue.completeNetSuitePreflightRun !== "function") {
    throw new TypeError("A NetSuite readiness repository is required.");
  }
}

/** @param {Record<string, unknown>} claim */
function claimedMappings(claim) {
  return Array.isArray(claim.mappings)
    ? claim.mappings.filter(isRecord).map(record)
    : [];
}

/** @param {Record<string, unknown>} claim */
function claimedRequirements(claim) {
  return Array.isArray(claim.requirements) && claim.requirements.length > 0
    ? claim.requirements.filter(isRecord).map(record)
    : NETSUITE_READINESS_REQUIREMENTS.map(record);
}

/**
 * Run one complete read-only sandbox readiness check. Requirements are sourced
 * from the server catalog/claim and are never accepted from an HTTP request.
 *
 * @param {object} input
 * @param {{readRecord: (recordType: string, externalId: string, descriptor?: {readStrategy?: "record_by_id" | "metadata_catalog", scriptId?: string}) => Promise<unknown>}} input.adapter
 * @param {ReadinessRepository} [input.repository]
 * @param {string} input.accountId
 * @param {string} [input.runtimeAccountId]
 * @param {string} [input.environmentName]
 * @param {string} input.restBaseUrl
 * @param {string} input.requestedBy
 * @param {string} input.correlationId
 * @param {string} input.leaseOwner
 * @param {number} [input.leaseSeconds]
 * @param {boolean} input.directAccessEnabled
 * @param {readonly string[]} input.sandboxAccountAllowlist
 * @param {number} input.readTimeoutMs
 */
export async function runNetSuiteSandboxPreflight({
  adapter,
  repository = DEFAULT_REPOSITORY,
  accountId,
  runtimeAccountId = accountId,
  environmentName = "sandbox",
  restBaseUrl,
  requestedBy,
  correlationId,
  leaseOwner,
  leaseSeconds = 30,
  directAccessEnabled = true,
  sandboxAccountAllowlist,
  readTimeoutMs = 10_000
}) {
  assertPreflightCollaborators(adapter, repository);
  const claim = await repository.claimNetSuitePreflightRun({
    adapterKind: "read_only_sandbox",
    accountId: text(accountId),
    runtimeAccountId: text(runtimeAccountId),
    environmentName: text(environmentName),
    restBaseUrl: text(restBaseUrl),
    requestedBy: text(requestedBy),
    correlationId: text(correlationId),
    leaseOwner: text(leaseOwner),
    leaseSeconds,
    directAccessEnabled,
    sandboxAccountAllowlist: Array.isArray(sandboxAccountAllowlist)
      ? sandboxAccountAllowlist
      : [text(accountId)],
    readTimeoutMs,
    preflightLeaseSeconds: leaseSeconds
  });
  const mappings = claimedMappings(claim);
  const byIdentity = mappingIndex(mappings);
  /** @type {Record<string, unknown>[]} */
  const requirements = claimedRequirements(claim);
  const checks = await evaluateRequirements(requirements, byIdentity, adapter);
  const completion = await repository.completeNetSuitePreflightRun({
    preflightRunId: text(claim.preflightRunId),
    leaseToken: text(claim.leaseToken),
    checks
  });
  return { claim, completion, checks };
}

// @ts-check

import crypto from "node:crypto";

import { query, withTransaction } from "../db.js";
import { MbtError } from "./errors.js";
import { configurationHash, evaluatePreflightReadiness } from "./preflight.js";

/**
 * @typedef {object} CurrentMapping
 * @property {string} mappingId
 * @property {string} mappingType
 * @property {string} localKey
 * @property {string} externalId
 * @property {string | null} externalScriptId
 * @property {string} externalName
 * @property {string} externalRecordType
 * @property {number | null} subsidiaryNetSuiteId
 * @property {Record<string, unknown>} configuration
 * @property {boolean} active
 * @property {boolean} isCurrent
 * @property {string} validationStatus
 * @property {string} validationMessage
 * @property {number} revision
 */

/**
 * @typedef {object} CurrentConfiguration
 * @property {CurrentMapping[]} mappings
 * @property {string} configurationHash
 */

/**
 * @typedef {object} MappingRequirement
 * @property {string} checkType
 * @property {string} mappingType
 * @property {string} localKey
 * @property {boolean} [required]
 * @property {number} [expectedSubsidiaryId]
 */

/**
 * @typedef {object} ReadOnlyAdapter
 * @property {(recordType: string, externalId: string) => Promise<Record<string, unknown>>} readRecord
 */

/**
 * @typedef {object} PreflightCheck
 * @property {string} checkType
 * @property {boolean} required
 * @property {string} mappingType
 * @property {string} localKey
 * @property {string | null} externalRecordType
 * @property {string | null} externalId
 * @property {Record<string, unknown>} expectedSnapshot
 * @property {Record<string, unknown> | null} observedSnapshot
 * @property {string} status
 * @property {string} message
 */

/**
 * @typedef {object} PersistedCheck
 * @property {string} checkType
 * @property {boolean} required
 * @property {string} status
 */

/**
 * @typedef {object} PersistRunInput
 * @property {string} preflightRunId
 * @property {CurrentConfiguration} configuration
 * @property {string} adapterKind
 * @property {string} accountId
 * @property {string} environmentName
 * @property {string} requestedBy
 * @property {string} correlationId
 * @property {string} status
 * @property {{required: number, passedRequired: number, failedRequired: number, optional: number, passedOptional: number}} counts
 * @property {PreflightCheck[]} checks
 */

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new TypeError(`A preflight ${label} is required.`);
  }
  return normalized;
}

/** @param {Record<string, unknown>} row @returns {CurrentMapping} */
function mappingRow(row) {
  return {
    mappingId: String(row.mapping_id),
    mappingType: String(row.mapping_type),
    localKey: String(row.local_key),
    externalId: String(row.external_id),
    externalScriptId: row.external_script_id === null ? null : String(row.external_script_id),
    externalName: String(row.external_name),
    externalRecordType: String(row.external_record_type),
    subsidiaryNetSuiteId: row.subsidiary_netsuite_id === null
      ? null
      : Number(row.subsidiary_netsuite_id),
    configuration: /** @type {Record<string, unknown>} */ (row.configuration),
    active: row.active === true,
    isCurrent: row.is_current === true,
    validationStatus: String(row.validation_status),
    validationMessage: String(row.validation_message),
    revision: Number(row.revision)
  };
}

/** @returns {Promise<CurrentConfiguration>} */
export async function getCurrentNetSuiteConfiguration() {
  const result = await query(
    `SELECT mapping_id, mapping_type, local_key, external_id,
            external_script_id, external_name, external_record_type,
            subsidiary_netsuite_id, configuration, active, is_current,
            validation_status, validation_message, revision
       FROM mbt_netsuite_mappings
      WHERE is_current
      ORDER BY mapping_type, local_key, revision, mapping_id`
  );
  const mappings = result.rows.map(mappingRow);
  return { mappings, configurationHash: configurationHash(mappings) };
}

/** @param {CurrentMapping[]} mappings */
function mappingIndex(mappings) {
  return new Map(mappings.map((mapping) => [
    `${mapping.mappingType}\u0000${mapping.localKey}`,
    mapping
  ]));
}

/** @param {MappingRequirement} requirement */
function normalizedRequirement(requirement) {
  return {
    checkType: requiredText(requirement?.checkType, "check type"),
    mappingType: requiredText(requirement?.mappingType, "mapping type"),
    localKey: requiredText(requirement?.localKey, "mapping local key"),
    required: requirement?.required !== false,
    expectedSubsidiaryId: requirement?.expectedSubsidiaryId === undefined
      ? null
      : Number(requirement.expectedSubsidiaryId)
  };
}

/** @param {MappingRequirement[]} requirements */
function normalizeRequirements(requirements) {
  if (!Array.isArray(requirements) || requirements.length === 0) {
    throw new TypeError("At least one preflight mapping requirement is required.");
  }
  const normalized = requirements.map(normalizedRequirement);
  const identities = new Set(normalized.map(({ checkType, mappingType, localKey }) => (
    `${checkType}\u0000${mappingType}\u0000${localKey}`
  )));
  if (identities.size !== normalized.length) {
    throw new TypeError("Preflight mapping requirements must be unique.");
  }
  return normalized;
}

/**
 * @param {string} adapterKind
 * @param {string} environmentName
 * @param {string} accountId
 * @param {string} expectedAccountId
 */
function contextFailure(adapterKind, environmentName, accountId, expectedAccountId) {
  if (adapterKind !== "phase1_read_only_fake") {
    return "Phase 1 accepts only the injected read-only fake adapter.";
  }
  if (environmentName.toLowerCase() === "production") {
    return "Phase 1 cannot verify production NetSuite configuration.";
  }
  if (accountId !== expectedAccountId) {
    return "The configured NetSuite account does not match the expected account.";
  }
  return null;
}

/**
 * @param {ReturnType<typeof normalizedRequirement>} requirement
 * @param {CurrentMapping | undefined} mapping
 * @param {string} status
 * @param {string} message
 * @param {Record<string, unknown> | null} [observedSnapshot]
 * @returns {PreflightCheck}
 */
function checkResult(requirement, mapping, status, message, observedSnapshot = null) {
  return {
    checkType: requirement.checkType,
    required: requirement.required,
    mappingType: requirement.mappingType,
    localKey: requirement.localKey,
    externalRecordType: mapping?.externalRecordType || null,
    externalId: mapping?.externalId || null,
    expectedSnapshot: {
      accountVerified: true,
      expectedSubsidiaryId: requirement.expectedSubsidiaryId
    },
    observedSnapshot,
    status,
    message
  };
}

/** @param {unknown} error */
function adapterFailureStatus(error) {
  const candidate = /** @type {{status?: unknown, code?: unknown}} */ (error);
  if (Number(candidate?.status) === 403 || /permission/i.test(String(candidate?.code || ""))) {
    return "permission_denied";
  }
  return "unable_to_verify";
}

/**
 * @param {ReturnType<typeof normalizedRequirement>} requirement
 * @param {CurrentMapping | undefined} mapping
 * @param {ReadOnlyAdapter} adapter
 * @param {string | null} contextIssue
 */
async function evaluateMapping(requirement, mapping, adapter, contextIssue) {
  const ineligible = mappingEligibility(requirement, mapping, contextIssue);
  if (ineligible) {
    return ineligible;
  }
  const eligibleMapping = /** @type {CurrentMapping} */ (mapping);
  let observed;
  try {
    observed = await adapter.readRecord(eligibleMapping.externalRecordType, eligibleMapping.externalId);
  } catch (error) {
    return checkResult(
      requirement,
      eligibleMapping,
      adapterFailureStatus(error),
      "The mapping could not be verified with read-only access."
    );
  }
  if (!observed || typeof observed !== "object" || Array.isArray(observed)) {
    return checkResult(requirement, eligibleMapping, "unable_to_verify", "The read-only adapter returned no verifiable record.");
  }
  if (observed.active === false) {
    return checkResult(requirement, eligibleMapping, "inactive", "The NetSuite record is inactive.", observed);
  }
  const expectedSubsidiaryId = requirement.expectedSubsidiaryId;
  if (expectedSubsidiaryId !== null
    && Number(observed.subsidiaryId) !== expectedSubsidiaryId) {
    return checkResult(
      requirement,
      eligibleMapping,
      "wrong_subsidiary",
      "The NetSuite record belongs to a different subsidiary.",
      observed
    );
  }
  return checkResult(requirement, eligibleMapping, "passed", "Verified with read-only access.", observed);
}

/**
 * @param {ReturnType<typeof normalizedRequirement>} requirement
 * @param {CurrentMapping | undefined} mapping
 * @param {string | null} contextIssue
 * @returns {PreflightCheck | null}
 */
function mappingEligibility(requirement, mapping, contextIssue) {
  if (contextIssue) {
    return checkResult(requirement, mapping, "unable_to_verify", contextIssue);
  }
  if (!mapping) {
    return checkResult(requirement, mapping, "missing", "The required mapping is missing.");
  }
  if (!mapping.active) {
    return checkResult(requirement, mapping, "inactive", "The required mapping is inactive.");
  }
  if (mapping.validationStatus === "valid") {
    return null;
  }
  const status = mapping.validationStatus === "unable_to_verify"
    ? "unable_to_verify"
    : mapping.validationStatus === "inactive" ? "inactive" : "invalid";
  return checkResult(
    requirement,
    mapping,
    status,
    mapping.validationMessage || `The mapping validation status is ${mapping.validationStatus}.`
  );
}

/** @param {PreflightCheck[]} checks */
function runStatus(checks) {
  const requiredFailures = checks.filter((check) => check.required && check.status !== "passed");
  if (!requiredFailures.length) {
    return "passed";
  }
  if (requiredFailures.some(({ status }) => (
    status === "unable_to_verify" || status === "permission_denied"
  ))) {
    return "unable_to_verify";
  }
  return "failed";
}

/** @param {PreflightCheck[]} checks */
function checkCounts(checks) {
  const requiredChecks = checks.filter((check) => check.required);
  const optionalChecks = checks.filter((check) => !check.required);
  return {
    required: requiredChecks.length,
    passedRequired: requiredChecks.filter(({ status }) => status === "passed").length,
    failedRequired: requiredChecks.filter(({ status }) => status !== "passed").length,
    optional: optionalChecks.length,
    passedOptional: optionalChecks.filter(({ status }) => status === "passed").length
  };
}

/**
 * @param {object} input
 * @param {ReadOnlyAdapter} input.adapter
 * @param {string} input.adapterKind
 * @param {string} input.accountId
 * @param {string} input.expectedAccountId
 * @param {string} input.environmentName
 * @param {string} input.requestedBy
 * @param {string} input.correlationId
 * @param {MappingRequirement[]} input.requiredMappings
 */
export async function runNetSuitePreflight({
  adapter,
  adapterKind,
  accountId,
  expectedAccountId,
  environmentName,
  requestedBy,
  correlationId,
  requiredMappings
}) {
  if (!adapter || typeof adapter.readRecord !== "function") {
    throw new TypeError("An injected read-only NetSuite adapter is required.");
  }
  const normalizedAdapterKind = requiredText(adapterKind, "adapter kind");
  const normalizedAccountId = requiredText(accountId, "account ID");
  const normalizedExpectedAccountId = requiredText(expectedAccountId, "expected account ID");
  const normalizedEnvironment = requiredText(environmentName, "environment name");
  const normalizedRequestedBy = requiredText(requestedBy, "requester");
  const normalizedCorrelationId = requiredText(correlationId, "correlation ID");
  const requirements = normalizeRequirements(requiredMappings);
  const configuration = await getCurrentNetSuiteConfiguration();
  const byIdentity = mappingIndex(configuration.mappings);
  const contextIssue = contextFailure(
    normalizedAdapterKind,
    normalizedEnvironment,
    normalizedAccountId,
    normalizedExpectedAccountId
  );
  const checks = [];
  for (const requirement of requirements) {
    const mapping = byIdentity.get(`${requirement.mappingType}\u0000${requirement.localKey}`);
    checks.push(await evaluateMapping(requirement, mapping, adapter, contextIssue));
  }
  const status = runStatus(checks);
  const counts = checkCounts(checks);
  const preflightRunId = crypto.randomUUID();
  await persistRun({
    preflightRunId,
    configuration,
    adapterKind: normalizedAdapterKind,
    accountId: normalizedAccountId,
    environmentName: normalizedEnvironment,
    requestedBy: normalizedRequestedBy,
    correlationId: normalizedCorrelationId,
    status,
    counts,
    checks
  });
  const readiness = await getNetSuitePreflightReadiness(preflightRunId);
  return {
    preflightRunId,
    configurationHash: configuration.configurationHash,
    status,
    checks,
    ready: readiness.ready,
    reasons: readiness.reasons
  };
}

/** @param {PersistRunInput} input */
async function persistRun({
  preflightRunId,
  configuration,
  adapterKind,
  accountId,
  environmentName,
  requestedBy,
  correlationId,
  status,
  counts,
  checks
}) {
  await withTransaction(async () => {
    await query(
      `INSERT INTO mbt_netsuite_preflight_runs (
         preflight_run_id, configuration_hash, mapping_snapshot,
         adapter_kind, account_id, environment_name, status,
         required_check_count, passed_required_count, failed_required_count,
         optional_check_count, passed_optional_count, requested_by,
         correlation_id, started_at, completed_at, error_code, error_message
       ) VALUES (
         $1, $2, $3::jsonb, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13, $14,
         clock_timestamp(), clock_timestamp(), $15, $16
       )`,
      [
        preflightRunId,
        configuration.configurationHash,
        JSON.stringify(configuration.mappings),
        adapterKind,
        accountId,
        environmentName,
        status,
        counts.required,
        counts.passedRequired,
        counts.failedRequired,
        counts.optional,
        counts.passedOptional,
        requestedBy,
        correlationId,
        status === "unable_to_verify" ? "MBT_PREFLIGHT_UNABLE_TO_VERIFY" : null,
        status === "unable_to_verify" ? "One or more required checks could not be verified." : null
      ]
    );
    for (let index = 0; index < checks.length; index += 1) {
      const check = checks[index];
      if (!check) {
        throw new TypeError("A persisted preflight check is required.");
      }
      await insertCheck(preflightRunId, index, check);
    }
  });
}

/** @param {string} runId @param {number} index @param {PreflightCheck} check */
async function insertCheck(runId, index, check) {
  await query(
    `INSERT INTO mbt_netsuite_preflight_checks (
       preflight_check_id, preflight_run_id, sequence_number, check_type,
       required, mapping_type, local_key, external_record_type, external_id,
       expected_snapshot, observed_snapshot, status, message
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       $10::jsonb, $11::jsonb, $12, $13
     )`,
    [
      crypto.randomUUID(),
      runId,
      index,
      check.checkType,
      check.required,
      check.mappingType,
      check.localKey,
      check.externalRecordType,
      check.externalId,
      JSON.stringify(check.expectedSnapshot),
      check.observedSnapshot === null ? null : JSON.stringify(check.observedSnapshot),
      check.status,
      check.message
    ]
  );
}

/** @param {Record<string, unknown>} row @returns {PersistedCheck} */
function persistedCheck(row) {
  return {
    checkType: String(row.check_type),
    required: row.required === true,
    status: String(row.status)
  };
}

/** @param {string} preflightRunId */
export async function getNetSuitePreflightReadiness(preflightRunId) {
  const normalizedRunId = requiredText(preflightRunId, "run ID");
  const run = await query(
    `SELECT preflight_run_id, configuration_hash, status
       FROM mbt_netsuite_preflight_runs
      WHERE preflight_run_id = $1`,
    [normalizedRunId]
  );
  if (!run.rowCount) {
    throw new MbtError(/** @type {any} */ ({
      status: 404,
      code: "MBT_PREFLIGHT_NOT_FOUND",
      message: "The NetSuite preflight run was not found."
    }));
  }
  const checksResult = await query(
    `SELECT check_type, required, status
       FROM mbt_netsuite_preflight_checks
      WHERE preflight_run_id = $1
      ORDER BY sequence_number`,
    [normalizedRunId]
  );
  /** @type {PersistedCheck[]} */
  const checks = checksResult.rows.map(
    /** @param {Record<string, unknown>} row */
    (row) => persistedCheck(row)
  );
  const requiredChecks = checks
    .filter((check) => check.required)
    .map((check) => check.checkType);
  const configuration = await getCurrentNetSuiteConfiguration();
  const evaluated = evaluatePreflightReadiness({
    currentConfigurationHash: configuration.configurationHash,
    runConfigurationHash: run.rows[0].configuration_hash,
    requiredChecks,
    checks
  });
  const status = String(run.rows[0].status);
  return {
    ready: status === "passed" && evaluated.ready,
    reasons: evaluated.reasons,
    status,
    configurationHash: String(run.rows[0].configuration_hash),
    currentConfigurationHash: configuration.configurationHash
  };
}

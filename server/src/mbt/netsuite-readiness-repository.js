import crypto from "node:crypto";

import { query, withTransaction } from "../db.js";
import { canonicalSha256 } from "./canonical-json.js";
import { executeMbtCommand } from "./command-repository.js";
import { MbtError } from "./errors.js";
import { NETSUITE_READINESS_REQUIREMENTS } from "./netsuite-readiness-catalog.js";

const CONFIGURATION_LOCK = "mbt.netsuite.readiness.configuration";
const ACTIVE_STATUSES = Object.freeze(["pending", "running"]);
const CHECK_STATUSES = new Set([
  "passed",
  "missing",
  "invalid",
  "inactive",
  "wrong_subsidiary",
  "permission_denied",
  "unable_to_verify",
  "not_applicable"
]);
const UNVERIFIABLE_STATUSES = new Set(["permission_denied", "unable_to_verify"]);
const MAX_MAPPING_CONFIGURATION_BYTES = 32 * 1024;
const MAX_MAPPING_CONFIGURATION_NODES = 256;
const MAX_MAPPING_CONFIGURATION_DEPTH = 8;
const SENSITIVE_CONFIGURATION_KEY = /(?:secret|password|credential|authorization|oauth|access.?token|refresh.?token|api.?key|private.?key)/i;
const SAFE_SCRIPT_ID = /^[A-Za-z][A-Za-z0-9_]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNTIME_FINGERPRINT_SCHEMA = "mbt-netsuite-readiness-runtime-v3";
const CONFIGURATION_KEYS = new Set(["expected", "caseInsensitiveFields"]);
const EXPECTED_EVIDENCE_FIELDS = new Set([
  "accountType",
  "active",
  "appliesTo",
  "baseCurrency",
  "baseCurrencyId",
  "baseCurrencyName",
  "companyName",
  "creditHold",
  "currencyId",
  "customerType",
  "entityId",
  "externalId",
  "fieldType",
  "folderPath",
  "legalName",
  "name",
  "permissionLevel",
  "recordType",
  "scriptId",
  "subsidiaryId",
  "subsidiaryIds",
  "taxItemId",
  "termsId"
]);
const NULLABLE_REQUIRED_EXPECTED_FIELDS = new Set(["taxItemId", "termsId"]);
const SENSITIVE_EVIDENCE_TEXT = /(?:-----BEGIN[^\r\n]{0,40}(?:PRIVATE KEY|SECRET)|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:access.?token|refresh.?token|client.?secret|password|authorization)\s*[:=])/i;

function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new TypeError(`${label} is required.`);
  }
  return normalized;
}

function requiredPreflightRunId(value) {
  const runId = requiredText(value, "Preflight run ID");
  if (!UUID.test(runId)) {
    throw new MbtError({
      status: 400,
      code: "MBT_NETSUITE_PREFLIGHT_RUN_INVALID",
      message: "A valid preflight run ID is required."
    });
  }
  return runId;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return Number(value);
}

function expectedRevision(value) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new MbtError({
      status: 400,
      code: "MBT_REVISION_REQUIRED",
      message: "Expected revision must be zero for create or a positive integer for update."
    });
  }
  return Number(value);
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  canonicalSha256(value);
  return structuredClone(value);
}

function invalidMappingConfiguration(message) {
  return new MbtError({
    status: 400,
    code: "MBT_NETSUITE_MAPPING_CONFIGURATION_INVALID",
    message
  });
}

function assertEvidenceText(value, label) {
  const normalized = requiredText(value, label);
  if (SENSITIVE_EVIDENCE_TEXT.test(normalized)) {
    throw new MbtError({
      status: 400,
      code: "MBT_EVIDENCE_TEXT_INVALID",
      message: `${label} must not contain credentials or secrets.`
    });
  }
  return normalized;
}

function validateExpectedScalar(value) {
  if (value === null) {
    return;
  }
  if (typeof value === "string") {
    if (value.length > 1024 || SENSITIVE_EVIDENCE_TEXT.test(value)) {
      throw invalidMappingConfiguration("NetSuite expected evidence contains unsafe text.");
    }
    return;
  }
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    return;
  }
  throw invalidMappingConfiguration("NetSuite expected evidence must use bounded scalar values or scalar arrays.");
}

function assertBoundedConfigurationShape(configuration) {
  let nodes = 0;
  const visit = (value, depth) => {
    nodes += 1;
    if (nodes > MAX_MAPPING_CONFIGURATION_NODES || depth > MAX_MAPPING_CONFIGURATION_DEPTH) {
      throw invalidMappingConfiguration("NetSuite verification configuration is too complex.");
    }
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, depth + 1));
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_CONFIGURATION_KEY.test(key)) {
        throw invalidMappingConfiguration(
          "Credentials and secrets are not permitted in NetSuite verification configuration."
        );
      }
      visit(child, depth + 1);
    }
  };
  visit(configuration, 0);
}

function assertAllowedConfigurationKeys(configuration) {
  for (const key of Object.keys(configuration)) {
    if (!CONFIGURATION_KEYS.has(key)) {
      throw invalidMappingConfiguration(`Unsupported NetSuite verification configuration field: ${key}.`);
    }
  }
}

function validateConfiguredExpected(value) {
  const configuredExpected = value ?? {};
  if (!configuredExpected || typeof configuredExpected !== "object" || Array.isArray(configuredExpected)) {
    throw invalidMappingConfiguration("NetSuite verification expected evidence must be an object.");
  }
  for (const [field, expectedValue] of Object.entries(configuredExpected)) {
    if (!EXPECTED_EVIDENCE_FIELDS.has(field)) {
      throw invalidMappingConfiguration(`Unsupported NetSuite expected evidence field: ${field}.`);
    }
    if (Array.isArray(expectedValue)) {
      if (expectedValue.length > 100) {
        throw invalidMappingConfiguration("NetSuite expected evidence arrays may contain at most 100 values.");
      }
      expectedValue.forEach(validateExpectedScalar);
    } else {
      validateExpectedScalar(expectedValue);
    }
  }
  return configuredExpected;
}

function validateCaseInsensitiveFields(value, configuredExpected, requirement) {
  const insensitive = value ?? [];
  if (!Array.isArray(insensitive)
      || insensitive.some((field) => typeof field !== "string" || !EXPECTED_EVIDENCE_FIELDS.has(field))
      || new Set(insensitive).size !== insensitive.length) {
    throw invalidMappingConfiguration("Case-insensitive evidence fields must be a unique array of supported names.");
  }
  const availableExpectedFields = new Set([
    ...Object.keys(configuredExpected),
    ...Object.keys(requirement.expected || {}),
    "recordType",
    ...(requirement.readStrategy === "metadata_catalog" ? ["scriptId"] : [])
  ]);
  if (insensitive.some((field) => !availableExpectedFields.has(field))) {
    throw invalidMappingConfiguration("Every case-insensitive field must be present in expected evidence.");
  }
  if (Array.isArray(requirement.allowedAccountTypes)
      && requirement.allowedAccountTypes.length > 0
      && insensitive.includes("accountType")) {
    throw invalidMappingConfiguration("NetSuite accountType evidence must use the exact Oracle ID.");
  }
}

function validateRequiredExpectedFields(configuredExpected, requirement) {
  const requiredFields = Array.isArray(requirement.requiredExpectedFields)
    ? requirement.requiredExpectedFields
    : [];
  const missing = requiredFields.filter((field) => {
    if (!Object.hasOwn(configuredExpected, field)) {
      return true;
    }
    const value = configuredExpected[field];
    if (value === null) {
      return !NULLABLE_REQUIRED_EXPECTED_FIELDS.has(field);
    }
    return typeof value === "string" && !value.trim();
  });
  if (missing.length > 0) {
    throw invalidMappingConfiguration(
      `Missing required NetSuite expected evidence: ${missing.join(", ")}.`
    );
  }
  const allowedAccountTypes = Array.isArray(requirement.allowedAccountTypes)
    ? requirement.allowedAccountTypes
    : [];
  if (allowedAccountTypes.length > 0
      && !allowedAccountTypes.includes(String(configuredExpected.accountType ?? ""))) {
    throw invalidMappingConfiguration(
      `NetSuite expected accountType must be one of: ${allowedAccountTypes.join(", ")}.`
    );
  }
}

function validateMappingConfiguration(configuration, requirement) {
  const serialized = JSON.stringify(configuration);
  if (Buffer.byteLength(serialized, "utf8") > MAX_MAPPING_CONFIGURATION_BYTES) {
    throw invalidMappingConfiguration("NetSuite verification configuration is too large.");
  }
  assertBoundedConfigurationShape(configuration);
  assertAllowedConfigurationKeys(configuration);
  const configuredExpected = validateConfiguredExpected(configuration.expected);
  validateRequiredExpectedFields(configuredExpected, requirement);
  validateCaseInsensitiveFields(configuration.caseInsensitiveFields, configuredExpected, requirement);
  return configuration;
}

function normalizeRestBaseUrl(value, required) {
  const raw = String(value ?? "").trim();
  if (!raw && !required) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(requiredText(raw, "NetSuite REST base URL"));
  } catch {
    if (!required) {
      return null;
    }
    throw new TypeError("NetSuite REST base URL must be a valid URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    if (!required) {
      return null;
    }
    throw new TypeError("NetSuite REST base URL must be an HTTPS URL without credentials, query, or fragment.");
  }
  return parsed.href.replace(/\/+$/, "");
}

function canonicalRuntimeAllowlist(value, required) {
  if (!Array.isArray(value)) {
    if (required) {
      throw new TypeError("A NetSuite sandbox account allowlist is required.");
    }
    return null;
  }
  const normalized = [...new Set(value.map((accountId) => String(accountId).trim()).filter(Boolean))]
    .sort();
  if (required && normalized.length === 0) {
    throw new TypeError("A non-empty NetSuite sandbox account allowlist is required.");
  }
  return normalized;
}

function boundedRuntimeInteger(value, label, minimum, maximum, required) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    if (required) {
      throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
    }
    return null;
  }
  return Number(value);
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function runtimeLeaseValue(runtime) {
  return runtime.preflightLeaseSeconds ?? runtime.effectivePreflightLeaseSeconds;
}

function normalizedRuntimeIdentity(value, { required = false } = {}) {
  const runtime = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const adapterKind = String(runtime.adapterKind ?? "").trim();
  const accountId = String(runtime.accountId ?? "").trim();
  const runtimeAccountId = String(runtime.runtimeAccountId ?? accountId).trim();
  const environmentName = String(runtime.environmentName ?? "").trim().toLowerCase();
  const restBaseUrl = normalizeRestBaseUrl(runtime.restBaseUrl, required);
  const directAccessEnabled = booleanOrNull(runtime.directAccessEnabled);
  const sandboxAccountAllowlist = canonicalRuntimeAllowlist(
    runtime.sandboxAccountAllowlist,
    required
  );
  const readTimeoutMs = boundedRuntimeInteger(
    runtime.readTimeoutMs,
    "NetSuite read timeout",
    1,
    60_000,
    required
  );
  const preflightLeaseSeconds = boundedRuntimeInteger(
    runtimeLeaseValue(runtime),
    "NetSuite preflight lease",
    15,
    900,
    required
  );
  const complete = [
    adapterKind,
    accountId,
    runtimeAccountId,
    environmentName,
    restBaseUrl,
    directAccessEnabled !== null,
    sandboxAccountAllowlist,
    readTimeoutMs,
    preflightLeaseSeconds
  ].every(Boolean);
  if (!complete) {
    if (required) {
      throw new TypeError("A complete NetSuite readiness runtime identity is required.");
    }
    return null;
  }
  const identityValue = {
    adapterKind,
    accountId,
    runtimeAccountId,
    environmentName,
    restBaseUrl,
    directAccessEnabled,
    sandboxAccountAllowlist,
    readTimeoutMs,
    preflightLeaseSeconds
  };
  return {
    ...identityValue,
    runtimeFingerprint: canonicalSha256({
      schema: RUNTIME_FINGERPRINT_SCHEMA,
      ...identityValue
    })
  };
}

function optionalText(value, label) {
  if (value === null || value === undefined) {
    return null;
  }
  return requiredText(value, label);
}

function optionalPositiveInteger(value, label) {
  if (value === null || value === undefined) {
    return null;
  }
  return positiveInteger(value, label);
}

function isoTimestamp(value) {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError("A valid persisted timestamp is required.");
  }
  return parsed.toISOString();
}

function identity(mappingType, localKey) {
  return `${mappingType}\u0000${localKey}`;
}

function publicMapping(row) {
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
    configuration: row.configuration,
    active: row.active === true,
    isCurrent: row.is_current === true,
    validationStatus: String(row.validation_status),
    validationMessage: String(row.validation_message),
    revision: Number(row.revision)
  };
}

function mappingHashProjection(mapping) {
  return {
    mappingType: mapping.mappingType,
    localKey: mapping.localKey,
    externalId: mapping.externalId,
    externalScriptId: mapping.externalScriptId,
    externalName: mapping.externalName,
    externalRecordType: mapping.externalRecordType,
    subsidiaryNetSuiteId: mapping.subsidiaryNetSuiteId,
    configuration: mapping.configuration,
    active: mapping.active,
    revision: mapping.revision
  };
}

function requirementHashProjection(requirement) {
  return {
    checkCode: requirement.checkCode,
    mappingType: requirement.mappingType,
    localKey: requirement.localKey,
    expectedRecordType: requirement.expectedRecordType,
    verificationKind: requirement.verificationKind,
    required: requirement.required,
    requiredStatus: requirement.requiredStatus,
    severity: requirement.severity,
    expected: requirement.expected,
    readStrategy: requirement.readStrategy,
    allowedRecordTypes: requirement.allowedRecordTypes,
    requiredExpectedFields: requirement.requiredExpectedFields,
    requiresSubsidiaryNetSuiteId: requirement.requiresSubsidiaryNetSuiteId,
    requiresSubsidiaryMembership: requirement.requiresSubsidiaryMembership,
    allowedAccountTypes: requirement.allowedAccountTypes
  };
}

function currentHash(mappings) {
  return canonicalSha256({
    schema: "mbt-netsuite-readiness-v2",
    requirements: NETSUITE_READINESS_REQUIREMENTS.map(requirementHashProjection),
    mappings: mappings.map(mappingHashProjection)
  });
}

function catalogIdentitySet() {
  return new Set(NETSUITE_READINESS_REQUIREMENTS.map((requirement) => (
    identity(requirement.mappingType, requirement.localKey)
  )));
}

async function selectMappingRows() {
  const result = await query(
    `SELECT mapping_id, mapping_type, local_key, external_id,
            external_script_id, external_name, external_record_type,
            subsidiary_netsuite_id, configuration, active, is_current,
            validation_status, validation_message, revision
       FROM mbt_netsuite_mappings
      ORDER BY mapping_type, local_key, revision DESC, mapping_id DESC`
  );
  const accepted = catalogIdentitySet();
  return result.rows
    .filter((row) => accepted.has(identity(row.mapping_type, row.local_key)))
    .map(publicMapping);
}

function orderedCurrentMappings(rows) {
  const current = new Map(rows
    .filter(({ isCurrent }) => isCurrent)
    .map((mapping) => [identity(mapping.mappingType, mapping.localKey), mapping]));
  return NETSUITE_READINESS_REQUIREMENTS
    .map((requirement) => current.get(identity(requirement.mappingType, requirement.localKey)))
    .filter(Boolean);
}

async function currentConfiguration() {
  const rows = await selectMappingRows();
  const mappings = orderedCurrentMappings(rows);
  return {
    mappings,
    configurationHash: currentHash(mappings)
  };
}

async function lockConfiguration() {
  await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [CONFIGURATION_LOCK]);
}

function requirementFor(mappingType, localKey) {
  return NETSUITE_READINESS_REQUIREMENTS.find((requirement) => (
    requirement.mappingType === mappingType && requirement.localKey === localKey
  ));
}

function staleRevision() {
  return new MbtError({
    status: 409,
    code: "MBT_STALE_REVISION",
    message: "This NetSuite mapping changed. Refresh it before saving again."
  });
}

function requireAdmin(actor) {
  const roles = Array.isArray(actor?.roles)
    ? actor.roles.map((role) => String(role).trim().toLowerCase())
    : [];
  if (!roles.includes("admin")) {
    throw new MbtError({
      status: 403,
      code: "MBT_ADMIN_REQUIRED",
      message: "Admin account required."
    });
  }
  return actor;
}

function recordTypeAllowedForRequirement(requirement, externalRecordType) {
  const remoteStrategy = ["record_by_id", "metadata_catalog"].includes(requirement.readStrategy);
  const allowedRecordTypes = Array.isArray(requirement.allowedRecordTypes)
    ? requirement.allowedRecordTypes
    : [];
  return remoteStrategy
    ? allowedRecordTypes.includes(externalRecordType)
    : externalRecordType === requirement.expectedRecordType;
}

function validateMetadataScriptId(requirement, externalScriptId) {
  if (requirement.readStrategy !== "metadata_catalog") {
    return;
  }
  if (!externalScriptId || !SAFE_SCRIPT_ID.test(externalScriptId)) {
    throw new MbtError({
      status: 400,
      code: "MBT_NETSUITE_MAPPING_SCRIPT_ID_INVALID",
      message: "Metadata mappings require a safe NetSuite script ID."
    });
  }
}

function validateRequiredSubsidiaryId(requirement, subsidiaryNetSuiteId) {
  if (requirement.requiresSubsidiaryNetSuiteId !== true || subsidiaryNetSuiteId !== null) {
    return;
  }
  throw new MbtError({
    status: 400,
    code: "MBT_NETSUITE_MAPPING_SUBSIDIARY_REQUIRED",
    message: "This NetSuite mapping requires the dedicated MBT subsidiary internal ID."
  });
}

function normalizedMappingInput(mapping, requirement) {
  const value = plainObject(mapping, "NetSuite mapping");
  const externalRecordType = requiredText(value.externalRecordType, "NetSuite record type");
  if (!recordTypeAllowedForRequirement(requirement, externalRecordType)) {
    throw new MbtError({
      status: 400,
      code: "MBT_NETSUITE_MAPPING_RECORD_TYPE_INVALID",
      message: "The NetSuite record type does not match the server-owned requirement."
    });
  }
  const externalScriptId = optionalText(value.externalScriptId, "NetSuite script ID");
  validateMetadataScriptId(requirement, externalScriptId);
  if (typeof value.active !== "boolean") {
    throw new TypeError("NetSuite mapping active state must be boolean.");
  }
  const subsidiaryNetSuiteId = optionalPositiveInteger(
    value.subsidiaryNetSuiteId,
    "NetSuite subsidiary internal ID"
  );
  validateRequiredSubsidiaryId(requirement, subsidiaryNetSuiteId);
  return {
    externalId: requiredText(value.externalId, "NetSuite internal ID"),
    externalScriptId,
    externalName: String(value.externalName ?? ""),
    externalRecordType,
    subsidiaryNetSuiteId,
    configuration: validateMappingConfiguration(
      plainObject(value.configuration ?? {}, "NetSuite mapping configuration"),
      requirement
    ),
    active: value.active
  };
}

function persistedExpectedSnapshot(requirement, mapping) {
  if (!mapping) {
    return requirement.expected;
  }
  const configuration = mapping.configuration
    && typeof mapping.configuration === "object"
    && !Array.isArray(mapping.configuration)
    ? mapping.configuration
    : {};
  const configured = configuration.expected
    && typeof configuration.expected === "object"
    && !Array.isArray(configuration.expected)
    ? configuration.expected
    : {};
  const expected = {
    ...configured,
    ...requirement.expected,
    recordType: mapping.externalRecordType,
    ...(requirement.readStrategy === "metadata_catalog"
      ? {
          scriptId: mapping.externalScriptId,
          appliesTo: [mapping.externalRecordType]
        }
      : {})
  };
  if (requirement.requiresSubsidiaryNetSuiteId === true) {
    delete expected.subsidiaryIds;
    expected.subsidiaryId = String(mapping.subsidiaryNetSuiteId ?? "");
  }
  return expected;
}

function mappingPayload(input, mappingType, localKey, mapping, revision) {
  return {
    mappingType,
    localKey,
    mapping,
    expectedRevision: revision,
    reason: input.reason
  };
}

async function selectCurrentMapping(mappingType, localKey) {
  const selected = await query(
    `SELECT mapping_id, mapping_type, local_key, external_id,
            external_script_id, external_name, external_record_type,
            subsidiary_netsuite_id, configuration, active, is_current,
            validation_status, validation_message, revision
       FROM mbt_netsuite_mappings
      WHERE mapping_type = $1
        AND local_key = $2
        AND is_current
      FOR UPDATE`,
    [mappingType, localKey]
  );
  return selected.rowCount ? publicMapping(selected.rows[0]) : null;
}

async function assertCurrentSubsidiaryMapping(requirement, mapping) {
  if (requirement.requiresSubsidiaryNetSuiteId !== true) {
    return;
  }
  const subsidiary = await selectCurrentMapping("subsidiary", "mbt");
  if (!subsidiary) {
    throw new MbtError({
      status: 400,
      code: "MBT_NETSUITE_MAPPING_SUBSIDIARY_NOT_CONFIGURED",
      message: "Configure the current MBT subsidiary mapping before saving a subsidiary-scoped mapping."
    });
  }
  if (String(mapping.subsidiaryNetSuiteId) !== String(subsidiary.externalId)) {
    throw new MbtError({
      status: 400,
      code: "MBT_NETSUITE_MAPPING_SUBSIDIARY_MISMATCH",
      message: "The mapping subsidiary must match the current MBT subsidiary mapping."
    });
  }
}

async function retireMapping(mappingId) {
  await query(
    `UPDATE mbt_netsuite_mappings
        SET active = false,
            is_current = false,
            updated_at = clock_timestamp()
      WHERE mapping_id = $1`,
    [mappingId]
  );
}

async function insertMapping({ mappingType, localKey, mapping, revision, actorOperatorId }) {
  const mappingId = crypto.randomUUID();
  const inserted = await query(
    `INSERT INTO mbt_netsuite_mappings (
       mapping_id, mapping_type, local_key, external_id,
       external_script_id, external_name, external_record_type,
       subsidiary_netsuite_id, configuration, active, is_current,
       validation_status, validation_message, revision, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, true,
       'unverified', '', $11, $12
     )
     RETURNING mapping_id, mapping_type, local_key, external_id,
               external_script_id, external_name, external_record_type,
               subsidiary_netsuite_id, configuration, active, is_current,
               validation_status, validation_message, revision`,
    [
      mappingId,
      mappingType,
      localKey,
      mapping.externalId,
      mapping.externalScriptId,
      mapping.externalName,
      mapping.externalRecordType,
      mapping.subsidiaryNetSuiteId,
      JSON.stringify(mapping.configuration),
      mapping.active,
      revision,
      actorOperatorId
    ]
  );
  return publicMapping(inserted.rows[0]);
}

function mappingMutationAudit(before, after, reason) {
  const created = before === null;
  return {
    action: created ? "mbt.netsuite_mapping.created" : "mbt.netsuite_mapping.updated",
    entityType: "mbt_netsuite_mapping",
    entityId: `${after.mappingType}:${after.localKey}`,
    beforeState: before || {},
    afterState: after,
    reason,
    revisionBefore: before?.revision || 1,
    revisionAfter: after.revision
  };
}

export async function listNetSuiteMappings() {
  const rows = await selectMappingRows();
  const mappings = orderedCurrentMappings(rows);
  return {
    configurationHash: currentHash(mappings),
    requirements: NETSUITE_READINESS_REQUIREMENTS.map((requirement) => {
      const history = rows.filter((mapping) => (
        mapping.mappingType === requirement.mappingType
          && mapping.localKey === requirement.localKey
      ));
      return {
        ...requirement,
        currentMapping: history.find(({ isCurrent }) => isCurrent) || null,
        history
      };
    })
  };
}

export async function putNetSuiteMapping(input) {
  const actor = requireAdmin(input?.actor);
  const mappingType = requiredText(input?.mappingType, "NetSuite mapping type");
  const localKey = requiredText(input?.localKey, "NetSuite mapping local key");
  const requirement = requirementFor(mappingType, localKey);
  if (!requirement) {
    throw new MbtError({
      status: 404,
      code: "MBT_NETSUITE_MAPPING_REQUIREMENT_NOT_FOUND",
      message: "The server-owned NetSuite mapping requirement was not found."
    });
  }
  const mapping = normalizedMappingInput(input.mapping, requirement);
  const revision = expectedRevision(input.expectedRevision);
  const reason = assertEvidenceText(input.reason, "NetSuite mapping audit reason");
  const payload = mappingPayload(input, mappingType, localKey, mapping, revision);
  try {
    return await executeMbtCommand({
      actor,
      commandName: "mbt.netsuite_mapping.put",
      idempotencyKey: input.idempotencyKey,
      payload,
      correlationId: input.correlationId,
      requestId: input.requestId,
      mutation: async () => {
        await lockConfiguration();
        await assertCurrentSubsidiaryMapping(requirement, mapping);
        const before = await selectCurrentMapping(mappingType, localKey);
        if ((!before && revision !== 0) || (before && before.revision !== revision)) {
          throw staleRevision();
        }
        if (before) {
          await retireMapping(before.mappingId);
        }
        const after = await insertMapping({
          mappingType,
          localKey,
          mapping,
          revision: before ? before.revision + 1 : 1,
          actorOperatorId: actor.operatorId
        });
        const configuration = await currentConfiguration();
        return {
          status: 200,
          body: {
            mapping: after,
            configurationHash: configuration.configurationHash
          },
          audit: mappingMutationAudit(before, after, reason)
        };
      }
    });
  } catch (error) {
    if (error?.code === "23505") {
      throw staleRevision();
    }
    throw error;
  }
}

function preflightRunning() {
  return new MbtError({
    status: 409,
    code: "MBT_NETSUITE_PREFLIGHT_RUNNING",
    message: "A NetSuite readiness preflight is already running."
  });
}

function normalizedClaim(input) {
  const runtime = normalizedRuntimeIdentity(input, { required: true });
  const adapterKind = runtime.adapterKind;
  const environmentName = runtime.environmentName;
  if (adapterKind !== "read_only_sandbox" || environmentName.toLowerCase() !== "sandbox") {
    throw new MbtError({
      status: 409,
      code: "MBT_NETSUITE_SANDBOX_REQUIRED",
      message: "Phase 2 preflight accepts the read-only sandbox adapter only."
    });
  }
  const leaseSeconds = positiveInteger(input.leaseSeconds, "Preflight lease duration");
  if (runtime.preflightLeaseSeconds !== leaseSeconds) {
    throw new TypeError("The effective preflight lease must match the claimed lease duration.");
  }
  return {
    adapterKind,
    accountId: runtime.accountId,
    environmentName: "sandbox",
    restBaseUrl: runtime.restBaseUrl,
    runtimeFingerprint: runtime.runtimeFingerprint,
    requestedBy: requiredText(input.requestedBy, "Preflight requester"),
    correlationId: requiredText(input.correlationId, "Preflight correlation ID"),
    leaseOwner: requiredText(input.leaseOwner, "Preflight lease owner"),
    leaseSeconds
  };
}

function countRequirements(requirements) {
  const required = requirements.filter((requirement) => requirement.required).length;
  return { required, optional: requirements.length - required };
}

function mappingIndex(mappings) {
  return new Map(mappings.map((mapping) => [
    identity(mapping.mappingType, mapping.localKey),
    mapping
  ]));
}

async function insertPersistedCheck(runId, sequenceNumber, requirement, result, mappings) {
  const mapping = mappings.get(identity(requirement.mappingType, requirement.localKey));
  await query(
    `INSERT INTO mbt_netsuite_preflight_checks (
       preflight_check_id, preflight_run_id, sequence_number, check_type,
       required, severity, mapping_type, local_key, external_record_type,
       external_id, expected_snapshot, observed_snapshot, status, message
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11::jsonb, $12::jsonb, $13, $14
     )`,
    [
      crypto.randomUUID(),
      runId,
      sequenceNumber,
      requirement.checkCode,
      requirement.required,
      requirement.severity,
      requirement.mappingType,
      requirement.localKey,
      mapping?.externalRecordType || requirement.expectedRecordType,
      mapping?.externalId || null,
      JSON.stringify(persistedExpectedSnapshot(requirement, mapping)),
      result.observed === null ? null : JSON.stringify(result.observed),
      result.status,
      result.message
    ]
  );
}

async function recoverExpiredRun(run) {
  const mappings = Array.isArray(run.mapping_snapshot) ? run.mapping_snapshot : [];
  const byIdentity = mappingIndex(mappings);
  const results = NETSUITE_READINESS_REQUIREMENTS.map(() => ({
    status: "unable_to_verify",
    observed: null,
    message: "The prior preflight lease expired before this check could be verified."
  }));
  for (let index = 0; index < NETSUITE_READINESS_REQUIREMENTS.length; index += 1) {
    await insertPersistedCheck(
      String(run.preflight_run_id),
      index,
      NETSUITE_READINESS_REQUIREMENTS[index],
      results[index],
      byIdentity
    );
  }
  const counts = countRequirements(NETSUITE_READINESS_REQUIREMENTS);
  await query(
    `UPDATE mbt_netsuite_preflight_runs
        SET status = 'unable_to_verify',
            required_check_count = $2,
            passed_required_count = 0,
            failed_required_count = $2,
            optional_check_count = $3,
            passed_optional_count = 0,
            completed_at = clock_timestamp(),
            error_code = 'MBT_NETSUITE_PREFLIGHT_LEASE_EXPIRED',
            error_message = 'The preflight lease expired before completion.',
            lease_token = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = clock_timestamp()
      WHERE preflight_run_id = $1`,
    [run.preflight_run_id, counts.required, counts.optional]
  );
}

async function selectActiveRun() {
  const selected = await query(
    `SELECT preflight_run_id, mapping_snapshot, lease_expires_at,
            lease_expires_at <= clock_timestamp() AS lease_expired
       FROM mbt_netsuite_preflight_runs
      WHERE status = ANY($1::text[])
      ORDER BY created_at, preflight_run_id
      LIMIT 1
      FOR UPDATE`,
    [ACTIVE_STATUSES]
  );
  return selected.rowCount ? selected.rows[0] : null;
}

async function insertClaim(claim, configuration) {
  const preflightRunId = crypto.randomUUID();
  const leaseToken = crypto.randomUUID();
  const counts = countRequirements(NETSUITE_READINESS_REQUIREMENTS);
  const inserted = await query(
    `INSERT INTO mbt_netsuite_preflight_runs (
       preflight_run_id, configuration_hash, mapping_snapshot,
       adapter_kind, account_id, environment_name, status,
       runtime_fingerprint,
       required_check_count, passed_required_count, failed_required_count,
       optional_check_count, passed_optional_count, requested_by,
       correlation_id, started_at, lease_token, lease_owner, lease_expires_at
     ) VALUES (
       $1, $2, $3::jsonb, $4, $5, $6, 'running', $7,
       $8, 0, 0, $9, 0, $10, $11, clock_timestamp(),
       $12, $13, clock_timestamp() + ($14 * interval '1 second')
     )
     RETURNING lease_expires_at`,
    [
      preflightRunId,
      configuration.configurationHash,
      JSON.stringify(configuration.mappings),
      claim.adapterKind,
      claim.accountId,
      claim.environmentName,
      claim.runtimeFingerprint,
      counts.required,
      counts.optional,
      claim.requestedBy,
      claim.correlationId,
      leaseToken,
      claim.leaseOwner,
      claim.leaseSeconds
    ]
  );
  return {
    preflightRunId,
    configurationHash: configuration.configurationHash,
    accountId: claim.accountId,
    environmentName: claim.environmentName,
    runtimeFingerprint: claim.runtimeFingerprint,
    leaseToken,
    leaseOwner: claim.leaseOwner,
    leaseExpiresAt: isoTimestamp(inserted.rows[0].lease_expires_at),
    mappings: configuration.mappings,
    requirements: NETSUITE_READINESS_REQUIREMENTS
  };
}

export async function claimNetSuitePreflightRun(input) {
  const claim = normalizedClaim(input);
  try {
    return await withTransaction(async () => {
      await lockConfiguration();
      const active = await selectActiveRun();
      let recoveredRunId = null;
      if (active && active.lease_expired !== true) {
        throw preflightRunning();
      }
      if (active) {
        recoveredRunId = String(active.preflight_run_id);
        await recoverExpiredRun(active);
      }
      const configuration = await currentConfiguration();
      const created = await insertClaim(claim, configuration);
      return { ...created, recoveredRunId };
    });
  } catch (error) {
    if (error?.code === "23505") {
      throw preflightRunning();
    }
    throw error;
  }
}

function normalizedCompletedChecks(checks) {
  if (!Array.isArray(checks)) {
    throw new TypeError("Preflight checks must be an array.");
  }
  const byCode = new Map();
  for (const candidate of checks) {
    const check = plainObject(candidate, "Preflight check");
    const checkCode = requiredText(check.checkCode, "Preflight check code");
    const status = requiredText(check.status, "Preflight check status");
    if (!CHECK_STATUSES.has(status)) {
      throw new TypeError(`Unsupported preflight check status: ${status}.`);
    }
    if (byCode.has(checkCode)) {
      throw new TypeError(`Duplicate preflight check code: ${checkCode}.`);
    }
    byCode.set(checkCode, {
      status,
      observed: check.observed === null || check.observed === undefined
        ? null
        : plainObject(check.observed, "Preflight observed value"),
      message: requiredText(check.message, "Preflight check message")
    });
  }
  if (byCode.size !== NETSUITE_READINESS_REQUIREMENTS.length) {
    throw new TypeError("Completion must include every server-owned preflight requirement exactly once.");
  }
  return NETSUITE_READINESS_REQUIREMENTS.map((requirement) => {
    const result = byCode.get(requirement.checkCode);
    if (!result) {
      throw new TypeError(`Missing preflight check: ${requirement.checkCode}.`);
    }
    if (requirement.required && result.status === "not_applicable") {
      throw new TypeError(`Required preflight check cannot be not_applicable: ${requirement.checkCode}.`);
    }
    return result;
  });
}

function terminalStatus(requirements, checks) {
  const failures = checks.filter((check, index) => (
    requirements[index].required && check.status !== "passed"
  ));
  if (!failures.length) {
    return "passed";
  }
  return failures.some(({ status }) => UNVERIFIABLE_STATUSES.has(status))
    ? "unable_to_verify"
    : "failed";
}

function completionCounts(requirements, checks) {
  const requiredChecks = checks.filter((_check, index) => requirements[index].required);
  const optionalChecks = checks.filter((_check, index) => !requirements[index].required);
  return {
    required: requiredChecks.length,
    passedRequired: requiredChecks.filter(({ status }) => status === "passed").length,
    failedRequired: requiredChecks.filter(({ status }) => status !== "passed").length,
    optional: optionalChecks.length,
    passedOptional: optionalChecks.filter(({ status }) => status === "passed").length
  };
}

function alreadyCompleted() {
  return new MbtError({
    status: 409,
    code: "MBT_NETSUITE_PREFLIGHT_ALREADY_COMPLETED",
    message: "The NetSuite readiness preflight is already complete."
  });
}

async function selectClaimForCompletion(runId) {
  const selected = await query(
    `SELECT preflight_run_id, configuration_hash, mapping_snapshot, status,
            lease_token, lease_expires_at,
            lease_expires_at <= clock_timestamp() AS lease_expired
       FROM mbt_netsuite_preflight_runs
      WHERE preflight_run_id = $1
      FOR UPDATE`,
    [runId]
  );
  if (!selected.rowCount) {
    throw new MbtError({
      status: 404,
      code: "MBT_NETSUITE_PREFLIGHT_NOT_FOUND",
      message: "The NetSuite readiness preflight was not found."
    });
  }
  return selected.rows[0];
}

function assertCompletionLease(run, leaseToken) {
  if (!ACTIVE_STATUSES.includes(String(run.status))) {
    throw alreadyCompleted();
  }
  if (String(run.lease_token) !== leaseToken || run.lease_expired === true) {
    throw new MbtError({
      status: 409,
      code: "MBT_NETSUITE_PREFLIGHT_LEASE_INVALID",
      message: "The preflight lease is invalid or expired."
    });
  }
}

async function finalizeRun(runId, status, counts) {
  const errorCode = status === "passed"
    ? null
    : status === "unable_to_verify"
      ? "MBT_NETSUITE_PREFLIGHT_UNABLE_TO_VERIFY"
      : "MBT_NETSUITE_PREFLIGHT_FAILED";
  const updated = await query(
    `UPDATE mbt_netsuite_preflight_runs
        SET status = $2,
            required_check_count = $3,
            passed_required_count = $4,
            failed_required_count = $5,
            optional_check_count = $6,
            passed_optional_count = $7,
            completed_at = clock_timestamp(),
            error_code = $8,
            error_message = CASE WHEN $8::text IS NULL THEN NULL
                                 ELSE 'One or more NetSuite readiness checks did not pass.' END,
            lease_token = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = clock_timestamp()
      WHERE preflight_run_id = $1
      RETURNING completed_at`,
    [
      runId,
      status,
      counts.required,
      counts.passedRequired,
      counts.failedRequired,
      counts.optional,
      counts.passedOptional,
      errorCode
    ]
  );
  return updated.rows[0].completed_at;
}

export async function completeNetSuitePreflightRun(input) {
  const preflightRunId = requiredText(input?.preflightRunId, "Preflight run ID");
  const leaseToken = requiredText(input?.leaseToken, "Preflight lease token");
  const checks = normalizedCompletedChecks(input?.checks);
  return withTransaction(async () => {
    const run = await selectClaimForCompletion(preflightRunId);
    assertCompletionLease(run, leaseToken);
    const mappings = mappingIndex(Array.isArray(run.mapping_snapshot) ? run.mapping_snapshot : []);
    for (let index = 0; index < NETSUITE_READINESS_REQUIREMENTS.length; index += 1) {
      await insertPersistedCheck(
        preflightRunId,
        index,
        NETSUITE_READINESS_REQUIREMENTS[index],
        checks[index],
        mappings
      );
    }
    const status = terminalStatus(NETSUITE_READINESS_REQUIREMENTS, checks);
    const counts = completionCounts(NETSUITE_READINESS_REQUIREMENTS, checks);
    const completedAt = await finalizeRun(preflightRunId, status, counts);
    return {
      preflightRunId,
      configurationHash: String(run.configuration_hash),
      status,
      counts,
      completedAt: isoTimestamp(completedAt)
    };
  });
}

function publicRun(row, current) {
  return {
    preflightRunId: String(row.preflight_run_id),
    configurationHash: String(row.configuration_hash),
    adapterKind: String(row.adapter_kind),
    accountId: String(row.account_id),
    environmentName: String(row.environment_name),
    runtimeFingerprint: String(row.runtime_fingerprint),
    status: String(row.status),
    counts: {
      required: Number(row.required_check_count),
      passedRequired: Number(row.passed_required_count),
      failedRequired: Number(row.failed_required_count),
      optional: Number(row.optional_check_count),
      passedOptional: Number(row.passed_optional_count)
    },
    requestedBy: String(row.requested_by),
    correlationId: String(row.correlation_id),
    startedAt: row.started_at === null ? null : isoTimestamp(row.started_at),
    completedAt: row.completed_at === null ? null : isoTimestamp(row.completed_at),
    errorCode: row.error_code === null ? null : String(row.error_code),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    current
  };
}

function publicCheck(row) {
  return {
    sequenceNumber: Number(row.sequence_number),
    checkCode: String(row.check_type),
    required: row.required === true,
    severity: String(row.severity),
    mappingType: String(row.mapping_type),
    localKey: String(row.local_key),
    externalRecordType: row.external_record_type === null ? null : String(row.external_record_type),
    externalId: row.external_id === null ? null : String(row.external_id),
    expected: row.expected_snapshot,
    observed: row.observed_snapshot,
    status: String(row.status),
    message: String(row.message),
    checkedAt: isoTimestamp(row.checked_at)
  };
}

function publicSignoff(row, current) {
  if (!row) {
    return null;
  }
  return {
    signoffId: String(row.signoff_id),
    preflightRunId: String(row.preflight_run_id),
    configurationHash: String(row.configuration_hash),
    signedBy: String(row.signed_by),
    auditNote: String(row.audit_note),
    signedAt: isoTimestamp(row.signed_at),
    current
  };
}

async function selectRun(runId, { lock = false } = {}) {
  const selected = await query(
    `SELECT preflight_run_id, configuration_hash, adapter_kind, account_id,
            environment_name, runtime_fingerprint, status, required_check_count,
            passed_required_count, failed_required_count, optional_check_count,
            passed_optional_count, requested_by, correlation_id, started_at,
            completed_at, error_code, error_message
       FROM mbt_netsuite_preflight_runs
      WHERE preflight_run_id = $1
      ${lock ? "FOR UPDATE" : ""}`,
    [runId]
  );
  return selected.rowCount ? selected.rows[0] : null;
}

async function selectChecks(runId) {
  const selected = await query(
    `SELECT sequence_number, check_type, required, severity, mapping_type,
            local_key, external_record_type, external_id, expected_snapshot,
            observed_snapshot, status, message, checked_at
       FROM mbt_netsuite_preflight_checks
      WHERE preflight_run_id = $1
      ORDER BY sequence_number`,
    [runId]
  );
  return selected.rows.map(publicCheck);
}

async function selectSignoff(runId) {
  const selected = await query(
    `SELECT signoff_id, preflight_run_id, configuration_hash, signed_by,
            audit_note, signed_at
       FROM mbt_netsuite_preflight_signoffs
      WHERE preflight_run_id = $1`,
    [runId]
  );
  return selected.rowCount ? selected.rows[0] : null;
}

function runMatchesCurrentRuntime(row, configurationHash, runtime) {
  return Boolean(runtime)
    && String(row.configuration_hash) === configurationHash
    && String(row.adapter_kind) === runtime.adapterKind
    && String(row.account_id) === runtime.accountId
    && String(row.environment_name).toLowerCase() === runtime.environmentName
    && String(row.runtime_fingerprint) === runtime.runtimeFingerprint;
}

export async function getNetSuitePreflightRun(runId, runtimeValue) {
  const normalizedRunId = requiredPreflightRunId(runId);
  const runtime = normalizedRuntimeIdentity(runtimeValue);
  return withTransaction(async () => {
    await lockConfiguration();
    const row = await selectRun(normalizedRunId);
    if (!row) {
      throw new MbtError({
        status: 404,
        code: "MBT_NETSUITE_PREFLIGHT_NOT_FOUND",
        message: "The NetSuite readiness preflight was not found."
      });
    }
    const configuration = await currentConfiguration();
    const current = runMatchesCurrentRuntime(row, configuration.configurationHash, runtime);
    const checks = await selectChecks(normalizedRunId);
    const signoffRow = await selectSignoff(normalizedRunId);
    return {
      run: publicRun(row, current),
      checks,
      signoff: publicSignoff(signoffRow, current),
      current
    };
  });
}

async function selectLatestRun(runtime) {
  if (!runtime) {
    return null;
  }
  const selected = await query(
    `SELECT preflight_run_id, configuration_hash, adapter_kind, account_id,
            environment_name, runtime_fingerprint, status, required_check_count,
            passed_required_count, failed_required_count, optional_check_count,
            passed_optional_count, requested_by, correlation_id, started_at,
            completed_at, error_code, error_message
       FROM mbt_netsuite_preflight_runs
      WHERE adapter_kind = $1
        AND lower(environment_name) = $2
        AND account_id = $3
      ORDER BY COALESCE(completed_at, started_at, created_at) DESC,
               created_at DESC,
               preflight_run_id DESC
      LIMIT 1`,
    [runtime.adapterKind, runtime.environmentName, runtime.accountId]
  );
  return selected.rowCount ? selected.rows[0] : null;
}

export async function getCurrentNetSuiteReadiness(runtimeValue) {
  const runtime = normalizedRuntimeIdentity(runtimeValue);
  return withTransaction(async () => {
    await lockConfiguration();
    const configuration = await currentConfiguration();
    const row = await selectLatestRun(runtime);
    if (!row) {
      return {
        ready: false,
        currentConfigurationHash: configuration.configurationHash,
        run: null,
        signoff: null
      };
    }
    const current = runMatchesCurrentRuntime(row, configuration.configurationHash, runtime);
    const signoffRow = await selectSignoff(String(row.preflight_run_id));
    const signoff = publicSignoff(signoffRow, current);
    const run = publicRun(row, current);
    return {
      ready: run.status === "passed" && current && signoff?.current === true,
      currentConfigurationHash: configuration.configurationHash,
      run,
      signoff
    };
  });
}

function signoffNotAllowed(code, message) {
  return new MbtError({ status: 409, code, message });
}

export async function signoffNetSuitePreflightRun(input) {
  const actor = requireAdmin(input?.actor);
  const preflightRunId = requiredPreflightRunId(input?.preflightRunId);
  const reason = assertEvidenceText(input?.reason, "Preflight signoff audit note");
  const runtime = normalizedRuntimeIdentity(input?.runtime, { required: true });
  const payload = { preflightRunId, reason, runtimeFingerprint: runtime.runtimeFingerprint };
  const result = await executeMbtCommand({
    actor,
    commandName: "mbt.netsuite_preflight.signoff",
    idempotencyKey: input.idempotencyKey,
    payload,
    correlationId: input.correlationId,
    requestId: input.requestId,
    mutation: async () => {
      await lockConfiguration();
      const run = await selectRun(preflightRunId, { lock: true });
      if (!run) {
        throw new MbtError({
          status: 404,
          code: "MBT_NETSUITE_PREFLIGHT_NOT_FOUND",
          message: "The NetSuite readiness preflight was not found."
        });
      }
      if (String(run.status) !== "passed") {
        throw signoffNotAllowed(
          "MBT_NETSUITE_PREFLIGHT_NOT_SIGNABLE",
          "Only a passing preflight may be signed off."
        );
      }
      if (!runMatchesCurrentRuntime(run, String(run.configuration_hash), runtime)) {
        throw signoffNotAllowed(
          "MBT_NETSUITE_PREFLIGHT_RUNTIME_NOT_CURRENT",
          "The passing preflight does not match the current NetSuite sandbox runtime."
        );
      }
      const configuration = await currentConfiguration();
      if (String(run.configuration_hash) !== configuration.configurationHash) {
        throw signoffNotAllowed(
          "MBT_NETSUITE_PREFLIGHT_NOT_CURRENT",
          "The passing preflight does not match the current mapping configuration."
        );
      }
      if (await selectSignoff(preflightRunId)) {
        throw signoffNotAllowed(
          "MBT_NETSUITE_PREFLIGHT_ALREADY_SIGNED",
          "The preflight already has an immutable signoff."
        );
      }
      const inserted = await query(
        `INSERT INTO mbt_netsuite_preflight_signoffs (
           signoff_id, preflight_run_id, configuration_hash, runtime_fingerprint, signed_by,
           audit_note, idempotency_key, correlation_id, request_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING signoff_id, preflight_run_id, configuration_hash,
                   signed_by, audit_note, signed_at`,
        [
          crypto.randomUUID(),
          preflightRunId,
          configuration.configurationHash,
          runtime.runtimeFingerprint,
          actor.operatorId,
          reason,
          input.idempotencyKey,
          input.correlationId,
          input.requestId
        ]
      );
      const signoff = publicSignoff(inserted.rows[0], true);
      return {
        status: 200,
        body: { signoff },
        audit: {
          action: "mbt.netsuite_preflight.signed_off",
          entityType: "mbt_netsuite_preflight_run",
          entityId: preflightRunId,
          beforeState: {},
          afterState: signoff,
          reason,
          revisionBefore: 1,
          revisionAfter: 1
        }
      };
    }
  });
  const detail = await getNetSuitePreflightRun(preflightRunId, runtime);
  return {
    ...result,
    body: {
      ...result.body,
      signoff: detail.signoff || result.body.signoff
    }
  };
}

// @ts-check

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TARGET_TESTS = Object.freeze([
  "test/mbt/unit/pure-contracts.test.js",
  "test/mbt/unit/foundation-services.test.js",
  "test/mbt/unit/dispatch-bin-safety.test.js"
]);

const PREDEPLOY_TARGET_TESTS = Object.freeze([
  "test/mbt/integration/predeploy-readiness.test.js"
]);

const P3_PREDEPLOY_TARGET_TESTS = Object.freeze([
  "test/mbt/integration/predeploy-readiness.test.js",
  "test/mbt/integration/p3-predeploy-readiness.test.js",
  "test/mbt/infrastructure/p3-gauntlet-contract.test.js"
]);

const P3_IMPORT_PURE_TARGET_TESTS = Object.freeze([
  "test/mbt/unit/master-data-csv.test.js",
  "test/mbt/unit/customer-spreadsheetml.test.js",
  "test/mbt/property/master-data-import.property.test.js"
]);

const P3_ASSET_TARGET_TESTS = Object.freeze([
  "test/mbt/integration/asset-registration.test.js",
  "test/mbt/concurrency/asset-registration-races.test.js"
]);

const P3_RATE_PURE_TARGET_TESTS = Object.freeze([
  "test/mbt/unit/local-rate-calculator.test.js",
  "test/mbt/unit/local-rate-calculator-hardening.test.js",
  "test/mbt/property/local-rate-calculator.property.test.js"
]);

const P3_RATE_SERVICE_TARGET_TESTS = Object.freeze([
  "test/mbt/integration/rate-card-configuration.test.js",
  "test/mbt/integration/rate-card-configuration-hardening.test.js",
  "test/mbt/concurrency/rate-card-configuration-races.test.js"
]);

const P3_RATE_CSV_PURE_TARGET_TESTS = Object.freeze([
  "test/mbt/unit/rate-card-csv-import.test.js",
  "test/mbt/unit/rate-card-csv-import-hardening.test.js",
  "test/mbt/property/rate-card-csv-import.property.test.js"
]);

const P3_RATE_CSV_SERVICE_TARGET_TESTS = Object.freeze([
  "test/mbt/integration/rate-card-csv-import.test.js",
  "test/mbt/integration/rate-card-csv-import-hardening.test.js",
  "test/mbt/concurrency/rate-card-csv-import-races.test.js"
]);

const P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS = Object.freeze([
  "test/mbt/unit/mbbs-driver-billing-planner.red.test.js",
  "test/mbt/unit/mbbs-rate-card-charging-policy.red.test.js",
  "test/mbt/unit/mbbs-order-billing-v3.contract.test.js",
  "test/mbt/property/mbbs-rate-card-charging-policy.property.test.js",
  "test/mbt/integration/mbbs-billing-candidates.test.js",
  "test/mbt/integration/mbbs-rate-card-charging-policy.test.js",
  "test/mbt/concurrency/mbbs-billing-address-override-races.test.js",
  "test/mbt/integration/mbbs-order-billing-v3.red.test.js"
]);

const READ_STRATEGY_TARGET_TESTS = Object.freeze([
  "test/mbt/unit/netsuite-read-strategies-p2.test.js"
]);

const READINESS_SERVICE_TARGET_TESTS = Object.freeze([
  "test/mbt/unit/netsuite-readiness-service-p2.test.js"
]);

const READINESS_REPORT_TARGET_TESTS = Object.freeze([
  "test/mbt/unit/netsuite-readiness-p2.test.js",
  "test/mbt/property/netsuite-readiness-p2.property.test.js"
]);

const READ_PROJECTION_TARGET_TESTS = Object.freeze([
  "test/mbt/unit/netsuite-readiness-p2.test.js",
  "test/mbt/property/netsuite-readiness-p2.property.test.js"
]);

const P2_R7_ACCOUNT_TARGET_TESTS = Object.freeze([
  "test/mbt/unit/p2-r7-account-evidence-red.test.js"
]);

const P2_R7_RUNTIME_TARGET_TESTS = Object.freeze([
  "test/mbt/integration/p2-r7-http-runtime-identity-red.test.js"
]);

const P2_R7_CONFIG_TARGET_TESTS = Object.freeze([
  "test/mbt/unit/config-legacy-seams.test.js"
]);

const P2_R7_SUBSIDIARY_TARGET_TESTS = Object.freeze([
  "test/mbt/integration/p2-r7-subsidiary-mapping-red.test.js"
]);

const P2_R7_REPOSITORY_TARGET_TESTS = Object.freeze([
  "test/mbt/integration/p2-netsuite-readiness-repository.test.js"
]);

const LOCAL_ITEM_TARGET_TESTS = Object.freeze([
  "test/mbt/unit/local-item-settings.test.js",
  "test/mbt/property/local-item-settings.property.test.js"
]);

const LOCAL_ITEM_REPOSITORY_TARGET_TESTS = Object.freeze([
  "test/mbt/integration/local-item-settings.test.js"
]);

const BILLING_APPROVAL_TARGET_TESTS = Object.freeze([
  "test/mbt/integration/outbox-preflight.test.js"
]);

const P1_MUTANTS = Object.freeze([
  {
    name: "global capability guard removed",
    file: "capabilities.js",
    from: "if (mbtEnabled !== true) {",
    to: "if (false && mbtEnabled !== true) {"
  },
  {
    name: "database capability guard removed",
    file: "capabilities.js",
    from: "if (capabilityEnabled !== true) {",
    to: "if (false && capabilityEnabled !== true) {"
  },
  {
    name: "NetSuite write capability guard removed",
    file: "capabilities.js",
    from: "requiresNetSuiteWrite === true && netSuiteWritesEnabled !== true",
    to: "requiresNetSuiteWrite === true && false && netSuiteWritesEnabled !== true"
  },
  {
    name: "canonical object keys reversed",
    file: "canonical-json.js",
    from: ".sort()\n        .map((key)",
    to: ".reverse()\n        .map((key)"
  },
  {
    name: "non-finite canonical number accepted",
    file: "canonical-json.js",
    from: "if (!Number.isFinite(value)) {",
    to: "if (false && !Number.isFinite(value)) {"
  },
  {
    name: "idempotency comparison inverted",
    file: "idempotency.js",
    from: "if (normalizedStoredHash === candidatePayloadHash) {",
    to: "if (normalizedStoredHash !== candidatePayloadHash) {"
  },
  {
    name: "revision comparison inverted",
    file: "revisions.js",
    from: "if (actualRevision !== expectedRevision) {",
    to: "if (actualRevision === expectedRevision) {"
  },
  {
    name: "rate bands may start away from zero",
    file: "rate-bands.js",
    from: "if (rateBands[0]?.minimumMetres !== 0) {",
    to: "if (rateBands[0]?.minimumMetres === 0) {"
  },
  {
    name: "rate maximum made inclusive",
    file: "rate-bands.js",
    from: "distanceMetres < band.maximumMetres",
    to: "distanceMetres <= band.maximumMetres"
  },
  {
    name: "secret-key redaction removed",
    file: "redaction.js",
    from: "result[key] = isSecretKey(key) ? REDACTED : redact(child);",
    to: "result[key] = redact(child);"
  },
  {
    name: "stale preflight hash accepted",
    file: "preflight.js",
    from: "currentConfigurationHash !== runConfigurationHash",
    to: "currentConfigurationHash === runConfigurationHash"
  },
  {
    name: "outbox acknowledgement guard removed",
    file: "outbox-state.js",
    from: "if (to === \"sent\" && !evidence.externalAcknowledgedAt) {",
    to: "if (false && to === \"sent\" && !evidence.externalAcknowledgedAt) {"
  },
  {
    name: "MBT identity can be hidden by changing dispatch type",
    file: "dispatch-bin-safety.js",
    from: "|| objectRecord(order.mbt);",
    to: "|| false;"
  },
  {
    name: "disabled BIN dispatch capability accepted",
    file: "dispatch-bin-safety.js",
    from: "if (environmentEnabled === true && databaseEnabled === true) {",
    to: "if (true || (environmentEnabled === true && databaseEnabled === true)) {"
  },
  {
    name: "deployment preflight snapshot page made unbounded",
    path: "tools/mbt-predeploy-readiness.mjs",
    targetTests: PREDEPLOY_TARGET_TESTS,
    from: "const SNAPSHOT_SCAN_PAGE_SIZE = 1;",
    to: "const SNAPSHOT_SCAN_PAGE_SIZE = 1000;"
  },
  {
    name: "deployment preflight current keyset ordered by text alias",
    path: "tools/mbt-predeploy-readiness.mjs",
    targetTests: PREDEPLOY_TARGET_TESTS,
    from: "ORDER BY snapshot.plan_id ASC",
    to: "ORDER BY plan_id ASC"
  },
  {
    name: "deployment preflight current keyset predicate removed",
    path: "tools/mbt-predeploy-readiness.mjs",
    targetTests: PREDEPLOY_TARGET_TESTS,
    from: "WHERE ($1::bigint IS NULL OR snapshot.plan_id > $1::bigint)",
    to: "WHERE ($1::bigint IS NULL)"
  }
]);

const P2_MUTANTS = Object.freeze([
  {
    name: "server catalog defaults no longer use record-by-ID reads",
    file: "netsuite-readiness-catalog.js",
    targetTests: READ_STRATEGY_TARGET_TESTS,
    from: "readStrategy = \"record_by_id\",",
    to: "readStrategy = \"unsupported\","
  },
  {
    name: "metadata catalog requests advertise generic JSON",
    file: "netsuite-readonly-adapter.js",
    targetTests: READ_STRATEGY_TARGET_TESTS,
    from: "headers: Object.freeze({ Accept: \"application/schema+json\" })",
    to: "headers: Object.freeze({ Accept: \"application/json\" })"
  },
  {
    name: "Oracle direct metadata properties are ignored",
    file: "netsuite-readonly-adapter.js",
    targetTests: READ_STRATEGY_TARGET_TESTS,
    from: "if (Object.keys(directField).length > 0) {",
    to: "if (false && Object.keys(directField).length > 0) {"
  },
  {
    name: "unsupported setup evidence is reported as passed",
    file: "netsuite-readiness-service.js",
    targetTests: READ_STRATEGY_TARGET_TESTS,
    from: "if (strategy === \"unsupported\") {\n    return checkResult(checkCode, \"unable_to_verify\", null);\n  }",
    to: "if (strategy === \"unsupported\") {\n    return checkResult(checkCode, \"passed\", null);\n  }"
  },
  {
    name: "failed derived permission evidence is reported as passed",
    file: "netsuite-readiness-service.js",
    targetTests: READ_STRATEGY_TARGET_TESTS,
    from: ": statuses.includes(\"permission_denied\") ? \"permission_denied\" : \"unable_to_verify\";",
    to: ": \"passed\";"
  },
  {
    name: "Admin semantic configuration overrides the server catalog",
    file: "netsuite-readiness-service.js",
    targetTests: READINESS_SERVICE_TARGET_TESTS,
    from: "...configured,\n    ...record(requirement.expected),",
    to: "...record(requirement.expected),\n    ...configured,"
  },
  {
    name: "spreadsheet formula neutralization removed",
    file: "netsuite-readiness-report.js",
    targetTests: READINESS_REPORT_TARGET_TESTS,
    from: "if (/^[\\u0000-\\u0020]*[=+@-]/.test(rendered)) {",
    to: "if (false && /^[\\u0000-\\u0020]*[=+@-]/.test(rendered)) {"
  },
  {
    name: "reference objects are coerced to object strings",
    file: "netsuite-readonly-adapter.js",
    targetTests: READ_PROJECTION_TARGET_TESTS,
    from: "return referenceName(value) ?? referenceId(value);",
    to: "return value === null || value === undefined ? null : String(value);"
  },
  {
    name: "singular nested item subsidiary collection is ignored",
    file: "netsuite-readonly-adapter.js",
    targetTests: READ_PROJECTION_TARGET_TESTS,
    from: "const nested = referenceCollection(payload.subsidiaries)\n    ?? referenceCollection(payload.subsidiary);",
    to: "const nested = referenceCollection(payload.subsidiaries);"
  },
  {
    name: "direct item subsidiary reference array is ignored",
    file: "netsuite-readonly-adapter.js",
    targetTests: READ_PROJECTION_TARGET_TESTS,
    from: "const direct = Array.isArray(payload.subsidiaryIds) ? payload.subsidiaryIds : null;",
    to: "const direct = null;"
  },
  {
    name: "base currency reference ID and name evidence is dropped",
    file: "netsuite-readonly-adapter.js",
    targetTests: P2_R7_ACCOUNT_TARGET_TESTS,
    from: "projectBaseCurrency(\n    projected,\n    recordType === \"subsidiary\" ? payload.currency ?? payload.baseCurrency : payload.baseCurrency\n  );",
    to: "assignReferenceText(\n    projected,\n    \"baseCurrency\",\n    recordType === \"subsidiary\" ? payload.currency ?? payload.baseCurrency : payload.baseCurrency\n  );"
  },
  {
    name: "account subsidiary membership proof is bypassed",
    file: "netsuite-readiness-service.js",
    targetTests: P2_R7_ACCOUNT_TARGET_TESTS,
    from: "if (requirement.requiresSubsidiaryMembership === true) {\n    if (!observedSubsidiaryMembership(observed).has(mbtSubsidiaryId)) {",
    to: "if (false && requirement.requiresSubsidiaryMembership === true) {\n    if (!observedSubsidiaryMembership(observed).has(mbtSubsidiaryId)) {"
  },
  {
    name: "official account type uses its display label instead of exact ID",
    file: "netsuite-readonly-adapter.js",
    targetTests: P2_R7_ACCOUNT_TARGET_TESTS,
    from: "? referenceId(payload.acctType)\n    : referenceText(payload.accountType);",
    to: "? referenceText(payload.acctType)\n    : referenceText(payload.accountType);"
  },
  {
    name: "runtime account is omitted from the readiness fingerprint",
    file: "netsuite-readiness-repository.js",
    targetTests: P2_R7_RUNTIME_TARGET_TESTS,
    from: "const identityValue = {\n    adapterKind,\n    accountId,\n    runtimeAccountId,\n    environmentName,",
    to: "const identityValue = {\n    adapterKind,\n    accountId,\n    environmentName,"
  },
  {
    name: "router hardcodes the readiness environment name",
    file: "router.js",
    targetTests: P2_R7_RUNTIME_TARGET_TESTS,
    from: "environmentName: environment.environmentName,",
    to: "environmentName: \"sandbox\","
  },
  {
    name: "env replacement retains omitted file-owned runtime values",
    path: "src/config.js",
    targetTests: P2_R7_CONFIG_TARGET_TESTS,
    from: "const nextEnv = { ...process.env };\n  for (const key of Object.keys(activeEnvValues)) {",
    to: "const nextEnv = { ...process.env };\n  for (const key of []) {"
  },
  {
    name: "subsidiary-scoped mapping can precede the MBT subsidiary",
    file: "netsuite-readiness-repository.js",
    targetTests: P2_R7_SUBSIDIARY_TARGET_TESTS,
    from: "if (!subsidiary) {",
    to: "if (false && !subsidiary) {"
  },
  {
    name: "missing observed semantics are treated like explicit null",
    file: "netsuite-readiness-service.js",
    targetTests: READINESS_SERVICE_TARGET_TESTS,
    from: "if (!Object.hasOwn(observed, field) || observed[field] === undefined) {",
    to: "if (!Object.hasOwn(observed, field)) {"
  },
  {
    name: "subsidiary membership policy is omitted from configuration hash",
    file: "netsuite-readiness-repository.js",
    targetTests: P2_R7_REPOSITORY_TARGET_TESTS,
    from: "requiresSubsidiaryMembership: requirement.requiresSubsidiaryMembership,",
    to: "requiresSubsidiaryMembership: false,"
  },
  {
    name: "preflight claim omits its runtime account identity",
    file: "netsuite-readiness-service.js",
    targetTests: READINESS_SERVICE_TARGET_TESTS,
    from: "runtimeAccountId: text(runtimeAccountId),",
    to: ""
  }
]);

const LOCAL_ITEM_MUTANTS = Object.freeze([
  {
    name: "extra local item fields are accepted",
    file: "local-item-settings.js",
    targetTests: LOCAL_ITEM_TARGET_TESTS,
    from: "if (keys.length !== EDITABLE_FIELDS.length\n      || !EDITABLE_FIELDS.every((field) => Object.hasOwn(input, field))) {",
    to: "if (!EDITABLE_FIELDS.every((field) => Object.hasOwn(input, field))) {"
  },
  {
    name: "blank local item display names are accepted",
    file: "local-item-settings.js",
    targetTests: LOCAL_ITEM_TARGET_TESTS,
    from: "displayName: boundedText(input.displayName, 160, false),",
    to: "displayName: boundedText(input.displayName, 160, true),"
  },
  {
    name: "local item description limit is widened by one",
    file: "local-item-settings.js",
    targetTests: LOCAL_ITEM_TARGET_TESTS,
    from: "description: boundedText(input.description, 2000, true),",
    to: "description: boundedText(input.description, 2001, true),"
  },
  {
    name: "nonboolean local item active state is accepted",
    file: "local-item-settings.js",
    targetTests: LOCAL_ITEM_TARGET_TESTS,
    from: "if (input.active !== true && input.active !== false) {",
    to: "if (false && input.active !== true && input.active !== false) {"
  },
  {
    name: "delivery cross-charge loses VRMA applicability",
    file: "local-item-settings.js",
    targetTests: LOCAL_ITEM_TARGET_TESTS,
    from: "applicableSourceTypes: [\"SO\", \"TO\", \"PO\", \"VRMA\"],",
    to: "applicableSourceTypes: [\"SO\", \"TO\", \"PO\"],"
  },
  {
    name: "DUMP is assigned a fake NetSuite item mapping",
    file: "local-item-settings.js",
    targetTests: LOCAL_ITEM_TARGET_TESTS,
    from: "netSuiteMappingLocalKey: null",
    to: "netSuiteMappingLocalKey: \"dump\""
  },
  {
    name: "local item readiness polarity is inverted",
    file: "local-item-settings-repository.js",
    targetTests: LOCAL_ITEM_REPOSITORY_TARGET_TESTS,
    from: "localReady: row.active === true,",
    to: "localReady: row.active !== true,"
  }
]);

const BILLING_APPROVAL_MUTANTS = Object.freeze([
  {
    name: "billing approval retains caller-owned snapshot references",
    file: "billing-approval-repository.js",
    targetTests: BILLING_APPROVAL_TARGET_TESTS,
    from: "const snapshot = canonicalize(value);",
    to: "const snapshot = value;"
  },
  {
    name: "non-final billing replay checks identity before final status",
    file: "billing-approval-repository.js",
    targetTests: BILLING_APPROVAL_TARGET_TESTS,
    from: "      assertFinalApprovalRow(existing.rows[0]);\n      const existingPostingMode",
    to: "      const existingPostingMode"
  },
  {
    name: "billing replay ignores the caller's expected revision",
    file: "billing-approval-repository.js",
    targetTests: BILLING_APPROVAL_TARGET_TESTS,
    from: "expectedRevision: input.expectedRevision,",
    to: "expectedRevision: Number(stored.billing_case_revision_before),"
  },
  {
    name: "billing audit identities coerce non-text values",
    file: "billing-approval-repository.js",
    targetTests: BILLING_APPROVAL_TARGET_TESTS,
    from: "  if (typeof value !== \"string\") {\n    throw new TypeError(`${label} must be text.`);\n  }\n  const normalized = value.trim();",
    to: "  const normalized = String(value ?? \"\").trim();"
  }
]);

const P3_MUTANTS = Object.freeze([
  {
    name: "P3 predeploy no longer requires migration 110",
    path: "tools/mbt-predeploy-readiness.mjs",
    targetTests: P3_PREDEPLOY_TARGET_TESTS,
    from: "  \"110_mbt_p3_feature_gates_imports.sql\"",
    to: "  \"109_mbt_local_first_configuration.sql\""
  },
  {
    name: "P3 predeploy omits the asset-management database gate",
    path: "tools/mbt-predeploy-readiness.mjs",
    targetTests: P3_PREDEPLOY_TARGET_TESTS,
    from: "  \"mbt_asset_management\",",
    to: "  \"mbt_asset_management_missing\","
  },
  {
    name: "P3 production smoke accepts an open asset-management environment gate",
    path: "tools/mbt-predeploy-readiness.mjs",
    targetTests: P3_PREDEPLOY_TARGET_TESTS,
    from: "  Object.freeze([\"MBT_ASSET_MANAGEMENT_ENABLED\", \"false\"]),",
    to: "  Object.freeze([\"MBT_ASSET_MANAGEMENT_ENABLED\", \"true\"]),"
  },
  {
    name: "P3 production smoke ignores operational state mutation",
    path: "tools/mbt-predeploy-readiness.mjs",
    targetTests: P3_PREDEPLOY_TARGET_TESTS,
    from: "    || !operationalStateUnchanged) {\n      throw new Error(\"The Phase 3 production runtime endpoint smoke did not fail closed.\");",
    to: "    || false) {\n      throw new Error(\"The Phase 3 production runtime endpoint smoke did not fail closed.\");"
  },
  {
    name: "P3 bounded CSV accepts a direct input beyond the byte limit",
    file: "bounded-csv.js",
    targetTests: P3_IMPORT_PURE_TARGET_TESTS,
    from: "    if (buffer.length > maxBytes) {",
    to: "    if (false && buffer.length > maxBytes) {"
  },
  {
    name: "P3 customer import accepts duplicate internal IDs",
    file: "customer-import-normalizer.js",
    targetTests: P3_IMPORT_PURE_TARGET_TESTS,
    from: "  if (seenIds.has(source.customerInternalId)) {",
    to: "  if (false && seenIds.has(source.customerInternalId)) {"
  },
  {
    name: "P3 SpreadsheetML accepts executable formulas",
    file: "customer-spreadsheetml.js",
    targetTests: P3_IMPORT_PURE_TARGET_TESTS,
    from: "  if (/(?:\\bFormula\\s*=|<(?:[\\w.-]+:)?Formula\\b)/iu.test(xml)) {",
    to: "  if (false && /(?:\\bFormula\\s*=|<(?:[\\w.-]+:)?Formula\\b)/iu.test(xml)) {"
  },
  {
    name: "P3 SpreadsheetML repairs bare ampersands outside Data nodes",
    file: "customer-spreadsheetml.js",
    targetTests: P3_IMPORT_PURE_TARGET_TESTS,
    from: "  if (SAFE_ENTITY.test(repaired)) {",
    to: "  if (false && SAFE_ENTITY.test(repaired)) {"
  },
  {
    name: "P3 SpreadsheetML rejects the observed benign Company metadata",
    file: "customer-spreadsheetml.js",
    targetTests: P3_IMPORT_PURE_TARGET_TESTS,
    from: "\"Workbook\", \"DocumentProperties\", \"Author\", \"LastAuthor\", \"Company\", \"Created\", \"Version\"",
    to: "\"Workbook\", \"DocumentProperties\", \"Author\", \"LastAuthor\", \"Created\", \"Version\""
  },
  {
    name: "P3 SpreadsheetML accepts Company metadata outside DocumentProperties",
    file: "customer-spreadsheetml.js",
    targetTests: P3_IMPORT_PURE_TARGET_TESTS,
    from: "  if (!element.closing\n      && element.name === \"Company\"\n      && structure.stack.at(-1) !== \"DocumentProperties\") {",
    to: "  if (false && !element.closing\n      && element.name === \"Company\"\n      && structure.stack.at(-1) !== \"DocumentProperties\") {"
  },
  {
    name: "P3 asset registration skips the transactional rollback hook",
    file: "asset-registry-service.js",
    targetTests: P3_ASSET_TARGET_TESTS,
    from: "        if (options.afterAssetInsert) {",
    to: "        if (false && options.afterAssetInsert) {"
  },
  {
    name: "P3 asset registration no longer maps duplicate identities",
    file: "asset-registry-service.js",
    targetTests: P3_ASSET_TARGET_TESTS,
    from: "      || /** @type {{code?: unknown}} */ (error).code !== \"23505\") {",
    to: "      || /** @type {{code?: unknown}} */ (error).code !== \"23506\") {"
  },
  {
    name: "P3 asset registration corrupts the sequence-1 ledger event",
    file: "asset-registry-service.js",
    targetTests: P3_ASSET_TARGET_TESTS,
    from: "$1, $2, 1, 'asset_registered', NULL, $3, NULL,",
    to: "$1, $2, 1, 'asset_registration_missing', NULL, $3, NULL,"
  },
  {
    name: "P3 asset comparison hides an open movement variance",
    file: "asset-registry-service.js",
    targetTests: P3_ASSET_TARGET_TESTS,
    from: "          status: mismatch.length ? \"open_variance\" : \"matched\",",
    to: "          status: \"matched\","
  },
  {
    name: "P3 local rates accept an unsafe accumulated subtotal",
    file: "local-rate-calculator.js",
    targetTests: P3_RATE_PURE_TARGET_TESTS,
    from: "  if (!Number.isSafeInteger(result)) {\n    invalid(\"MBT_RATE_MONEY_OVERFLOW\", \"The calculated subtotal exceeds safe integer cents.\");",
    to: "  if (false && !Number.isSafeInteger(result)) {\n    invalid(\"MBT_RATE_MONEY_OVERFLOW\", \"The calculated subtotal exceeds safe integer cents.\");"
  },
  {
    name: "P3 dump customer charge silently includes actual receipt cost",
    file: "local-rate-calculator.js",
    targetTests: P3_RATE_PURE_TARGET_TESTS,
    from: "  const customerChargeMinor = Math.max(calculatedTariffMinor, minimumAmountMinor);",
    to: "  const customerChargeMinor = Math.max(calculatedTariffMinor, minimumAmountMinor) + actualCostMinor;"
  },
  {
    name: "P3 rate-card configuration accepts non-allowlisted pricing fields",
    file: "rate-card-configuration-service.js",
    targetTests: P3_RATE_SERVICE_TARGET_TESTS,
    from: "  if (Object.keys(value).some((key) => !accepted.has(key))) {",
    to: "  if (false && Object.keys(value).some((key) => !accepted.has(key))) {"
  },
  {
    name: "P3 rate-card activation ignores an existing active version",
    file: "rate-card-configuration-service.js",
    targetTests: P3_RATE_SERVICE_TARGET_TESTS,
    from: "  if (active.rowCount) {\n    throw new MbtError({\n      status: 409,\n      code: \"MBT_RATE_ACTIVE_CONFLICT\",",
    to: "  if (false && active.rowCount) {\n    throw new MbtError({\n      status: 409,\n      code: \"MBT_RATE_ACTIVE_CONFLICT\","
  },
  {
    name: "P3 rate-card CSV accepts an extra sixth file",
    file: "rate-card-csv-import.js",
    targetTests: P3_RATE_CSV_PURE_TARGET_TESTS,
    from: "if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {",
    to: "if (false && (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))) {"
  },
  {
    name: "P3 rate-card CSV ignores the aggregate byte ceiling",
    file: "rate-card-csv-import.js",
    targetTests: P3_RATE_CSV_PURE_TARGET_TESTS,
    from: "if (totalBytes > limits.maxTotalBytes) {",
    to: "if (false && totalBytes > limits.maxTotalBytes) {"
  },
  {
    name: "P3 rate-card CSV apply ignores preview ownership",
    file: "rate-card-csv-import-service.js",
    targetTests: P3_RATE_CSV_SERVICE_TARGET_TESTS,
    from: "        AND actor_operator_id = $2",
    to: "        AND $2 = $2"
  },
  {
    name: "P3 rate-card CSV apply skips the transactional rollback hook",
    file: "rate-card-csv-import-service.js",
    targetTests: P3_RATE_CSV_SERVICE_TARGET_TESTS,
    from: "      await input.hooks?.afterDraftApply?.();",
    to: "      if (false) await input.hooks?.afterDraftApply?.();"
  },
  {
    name: "P3 MBBS PO billing regresses from business-route grouping to per-reference grouping",
    scope: "mbbs_billing",
    file: "mbbs-driver-billing-planner.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "    const groupKey = text(canonicalOrder.billingGroupKey) || routeKey;",
    to: "    const groupKey = text(canonicalOrder.billingGroupKey) || `${routeKey}|${occurrence.rootReference}`;"
  },
  {
    name: "P3 MBBS PO billing charges the first drop twice",
    scope: "mbbs_billing",
    file: "mbbs-driver-billing-planner.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "      ? Math.max(0, dropCount - 1)",
    to: "      ? dropCount"
  },
  {
    name: "P3 MBBS direct TO incorrectly includes a full route charge",
    scope: "mbbs_billing",
    file: "mbbs-driver-billing-planner.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "  const distanceBandAmountMinor = directTransfer ? 0 : rateAmount;",
    to: "  const distanceBandAmountMinor = rateAmount;"
  },
  {
    name: "P3 MBBS direct TO uses the PO additional-drop price",
    scope: "mbbs_billing",
    file: "mbbs-driver-billing-planner.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "    ? policy.directPickupUnitAmountMinor",
    to: "    ? policy.poAdditionalDropUnitAmountMinor"
  },
  {
    name: "P3 MBBS PO additional drops use the direct-TO price",
    scope: "mbbs_billing",
    file: "mbbs-driver-billing-planner.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "      ? policy.poAdditionalDropUnitAmountMinor",
    to: "      ? policy.directPickupUnitAmountMinor"
  },
  {
    name: "P3 MBBS policy accepts a negative unit price",
    scope: "mbbs_billing",
    file: "mbbs-rate-card-policy.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "  if (typeof value !== \"number\" || !Number.isSafeInteger(value) || value < 0) {",
    to: "  if (typeof value !== \"number\" || !Number.isSafeInteger(value)) {"
  },
  {
    name: "P3 MBBS policy accepts a changed hidden charging rule",
    scope: "mbbs_billing",
    file: "mbbs-rate-card-policy.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "    if (input[field] !== expected) {",
    to: "    if (false && input[field] !== expected) {"
  },
  {
    name: "P3 MBBS missing policy loses its fail-closed error boundary",
    scope: "mbbs_billing",
    file: "mbbs-rate-card-policy.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "  if (value === null || value === undefined) {",
    to: "  if (false && (value === null || value === undefined)) {"
  },
  {
    name: "P3 MBBS rate-card detail hides an existing version policy",
    scope: "mbbs_billing",
    file: "rate-card-configuration-service.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "      mbbsChargingPolicy: header.rows[0].policySchemaVersion === null",
    to: "      mbbsChargingPolicy: header.rows[0].policySchemaVersion !== null"
  },
  {
    name: "P3 MBBS durable billing evidence drops the selected version policy",
    scope: "mbbs_billing",
    file: "shadow-billing-service.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "      mbbsChargingPolicy: selected.mbbsChargingPolicy,",
    to: "      mbbsChargingPolicy: null,"
  },
  {
    name: "P3 MBBS manual final charge no longer has to match calculation plus adjustment",
    scope: "mbbs_billing",
    file: "mbbs-driver-billing-planner.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "  if (finalAmountMinor !== expectedFinal) {",
    to: "  if (false && finalAmountMinor !== expectedFinal) {"
  },
  {
    name: "P3 MBBS explicit Sales Order group is charged per child",
    scope: "mbbs_billing",
    file: "mbbs-driver-billing-planner.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "    if (occurrence.sourceType === \"SO\" && retainExplicitGroup(explicitSalesGroups, occurrence, canonicalOrder)) {",
    to: "    if (false && occurrence.sourceType === \"SO\" && retainExplicitGroup(explicitSalesGroups, occurrence, canonicalOrder)) {"
  },
  {
    name: "P3 MBBS explicit Purchase Order group is charged per child",
    scope: "mbbs_billing",
    file: "mbbs-driver-billing-planner.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "    if (occurrence.sourceType === \"PO\" && retainExplicitGroup(explicitPurchaseGroups, occurrence, canonicalOrder)) {",
    to: "    if (false && occurrence.sourceType === \"PO\" && retainExplicitGroup(explicitPurchaseGroups, occurrence, canonicalOrder)) {"
  },
  {
    name: "P3 MBBS selected historical candidate falls back to the latest page",
    scope: "mbbs_billing",
    file: "mbbs-billing-candidate-service.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "    candidateIdentities: identities",
    to: "    candidateIdentities: []"
  },
  {
    name: "P3 MBBS unavailable automatic route rejects manual billing",
    scope: "mbbs_billing",
    file: "mbbs-billing-candidate-service.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "    return manualRateCalculation(candidate, graph, automaticRate);",
    to: "    throw error;"
  },
  {
    name: "P3 MBBS conversion ignores unchecked calculation rows",
    scope: "mbbs_billing",
    path: "public/mbt-billing.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "      && state.selectedMbbsBatchResultIds.has(result.candidateId))",
    to: "      && true)"
  },
  {
    name: "P3 MBBS manual-rate rows are selected without operator consent",
    scope: "mbbs_billing",
    path: "public/mbt-billing.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "      .filter((entry) => entry.status === \"calculated\")",
    to: "      .filter((entry) => entry.status !== \"failed\")"
  },
  {
    name: "P3 MBBS UI labels metres as kilometres without conversion",
    scope: "mbbs_billing",
    path: "public/mbt-billing.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "  }).format(metres / 1000)} km`;",
    to: "  }).format(metres)} km`;"
  },
  {
    name: "P3 MBBS candidate list regresses to a 200-order ceiling",
    scope: "mbbs_billing",
    file: "mbbs-billing-candidate-service.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "const MAX_CANDIDATES = 1000;",
    to: "const MAX_CANDIDATES = 200;"
  },
  {
    name: "P3 MBBS batch accepts a 101st order",
    scope: "mbbs_billing",
    file: "mbbs-billing-candidate-service.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "const MAX_BATCH_CANDIDATES = 100;",
    to: "const MAX_BATCH_CANDIDATES = 101;"
  },
  {
    name: "P3 MBBS batch starts unbounded distance work",
    scope: "mbbs_billing",
    file: "mbbs-billing-candidate-service.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "const BATCH_DISTANCE_CONCURRENCY = 5;",
    to: "const BATCH_DISTANCE_CONCURRENCY = 100;"
  },
  {
    name: "P3 MBBS two-address routes regress to origin-yard-only eligibility",
    scope: "mbbs_billing",
    file: "mbbs-billing-candidate-service.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "  if (!candidate.chargeable) {",
    to: "  if (!candidate.chargeable || (graph.originYardCodes.size && !graph.originYardCodes.has(candidate.originYardCode))) {"
  },
  {
    name: "P3 MBBS durable conversion skips immutable candidate snapshots",
    scope: "mbbs_billing",
    file: "mbbs-billing-candidate-service.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "        const snapshotId = await freezeCandidateCalculation(calculation, actor);",
    to: "        const snapshotId = crypto.randomUUID();"
  },
  {
    name: "P3 MBBS durable conversion skips atomic failure hook",
    scope: "mbbs_billing",
    file: "shadow-billing-service.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "      await dependencies.hooks.afterCaseInsert({ calculatedCase, durable });",
    to: "      if (false) await dependencies.hooks.afterCaseInsert({ calculatedCase, durable });"
  },
  {
    name: "P3 MBBS durable conversion excludes explicitly searched Pick-Up",
    scope: "mbbs_billing",
    file: "mbbs-billing-candidate-service.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "    includeAllSalesMethods: true,",
    to: "    includeAllSalesMethods: false,"
  },
  {
    name: "P3 MBBS address override ignores optimistic revision",
    scope: "mbbs_billing",
    file: "mbbs-billing-candidate-service.js",
    targetTests: P3_MBBS_BILLING_CANDIDATE_TARGET_TESTS,
    from: "      if (currentRevision !== expectedRevision) {",
    to: "      if (currentRevision === expectedRevision) {"
  }
]);

/** @param {string | Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {readonly string[]} targetTests @returns {Promise<number>} */
function runTargetTests(targetTests = TARGET_TESTS) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=spec",
      ...targetTests
    ], {
      env: process.env,
      stdio: "ignore"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Mutation test process exited on signal ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Mutation tests may run only in the explicitly ephemeral MBT test image.");
}
if (P1_MUTANTS.length !== 17) {
  throw new Error(`The frozen Phase 1 mutation set must contain exactly 17 mutants, found ${P1_MUTANTS.length}.`);
}
if (P2_MUTANTS.length !== 20) {
  throw new Error(`The frozen Phase 2 mutation set must contain exactly 20 mutants, found ${P2_MUTANTS.length}.`);
}
if (LOCAL_ITEM_MUTANTS.length !== 7) {
  throw new Error(`The frozen local-item mutation set must contain exactly 7 mutants, found ${LOCAL_ITEM_MUTANTS.length}.`);
}
if (BILLING_APPROVAL_MUTANTS.length !== 4) {
  throw new Error(`The frozen billing-approval mutation set must contain exactly 4 mutants, found ${BILLING_APPROVAL_MUTANTS.length}.`);
}
if (P3_MUTANTS.length !== 48) {
  throw new Error(`The frozen Phase 3 mutation set must contain exactly 48 mutants, found ${P3_MUTANTS.length}.`);
}
const mutationPhase = String(process.env.MBT_MUTATION_PHASE || "P1").toUpperCase();
if (mutationPhase !== "P1" && mutationPhase !== "P2" && mutationPhase !== "P3") {
  throw new Error(`Unsupported MBT mutation phase: ${mutationPhase}.`);
}
const mutationScope = String(process.env.MBT_MUTATION_SCOPE || "").trim().toUpperCase();
if (mutationScope && mutationScope !== "MBBS_BILLING") {
  throw new Error(`Unsupported MBT mutation scope: ${mutationScope}.`);
}
if (mutationScope && mutationPhase !== "P3") {
  throw new Error("The MBBS Billing mutation scope requires Phase 3.");
}
const scopedP3Mutants = P3_MUTANTS.filter((mutant) => (
  "scope" in mutant && mutant.scope === "mbbs_billing"
));
if (scopedP3Mutants.length !== 26) {
  throw new Error(`The MBBS Billing mutation scope must contain exactly 26 mutants, found ${scopedP3Mutants.length}.`);
}
const MUTANTS = mutationScope === "MBBS_BILLING"
  ? Object.freeze([...scopedP3Mutants])
  : mutationPhase === "P3"
  ? Object.freeze([
    ...P1_MUTANTS,
    ...P2_MUTANTS,
    ...LOCAL_ITEM_MUTANTS,
    ...BILLING_APPROVAL_MUTANTS,
    ...P3_MUTANTS
  ])
  : mutationPhase === "P2"
  ? Object.freeze([
    ...P1_MUTANTS,
    ...P2_MUTANTS,
    ...LOCAL_ITEM_MUTANTS,
    ...BILLING_APPROVAL_MUTANTS
  ])
  : P1_MUTANTS;

let killed = 0;
for (const mutant of MUTANTS) {
  const mutantPath = "path" in mutant ? mutant.path : "";
  const mutantFile = "file" in mutant ? mutant.file : "";
  const relativeTarget = mutantPath
    || (typeof mutantFile === "string" ? path.join("src/mbt", mutantFile) : "");
  if (!relativeTarget) {
    throw new Error(`${mutant.name}: a mutation target path is required.`);
  }
  const target = path.resolve(relativeTarget);
  const original = await readFile(target, "utf8");
  const originalHash = sha256(original);
  if (occurrenceCount(original, mutant.from) !== 1) {
    throw new Error(`${mutant.name}: expected exactly one mutation target in ${relativeTarget}.`);
  }
  const mutated = original.replace(mutant.from, mutant.to);
  try {
    await writeFile(target, mutated, "utf8");
    const targetTests = "targetTests" in mutant ? mutant.targetTests : TARGET_TESTS;
    const exitCode = await runTargetTests(targetTests || TARGET_TESTS);
    if (exitCode === 0) {
      throw new Error(`${mutant.name}: survived the frozen ${mutationPhase} test suite.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
  } finally {
    await writeFile(target, original, "utf8");
    const restoredHash = sha256(await readFile(target));
    if (restoredHash !== originalHash) {
      throw new Error(`${mutant.name}: source restoration hash mismatch.`);
    }
  }
}

if (mutationPhase === "P3") {
  console.log(`Phase 3 mutation score: ${killed}/${MUTANTS.length} killed (100%).`);
} else if (mutationPhase === "P2") {
  console.log(`Phase 2 mutation score: ${killed}/${MUTANTS.length} killed (100%).`);
} else {
  console.log(`Phase 1 mutation score: ${killed}/${MUTANTS.length} killed (100%).`);
}

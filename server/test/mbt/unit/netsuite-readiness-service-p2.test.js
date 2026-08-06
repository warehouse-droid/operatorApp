import assert from "node:assert/strict";
import { test } from "node:test";

import { getNetSuiteReadinessCatalog } from "../../../src/mbt/netsuite-readiness-catalog.js";
import { runNetSuiteSandboxPreflight } from "../../../src/mbt/netsuite-readiness-service.js";

const CATALOG = getNetSuiteReadinessCatalog();
const PREFLIGHT_RUN_ID = "a1111111-2222-4333-8444-555555555555";
const LEASE_ID = "b1111111-2222-4333-8444-555555555555";
const CONFIGURATION_HASH = "c".repeat(64);
const ACCOUNT_ID = "1234567_SB1";
const REST_BASE_URL = "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1";

function requirement(checkCode) {
  const found = CATALOG.find((candidate) => candidate.checkCode === checkCode);
  assert.ok(found, `Missing catalog fixture ${checkCode}.`);
  return found;
}

function declaredCaseInsensitiveFields(requirementValue) {
  if (requirementValue.mappingType === "custom_field") {
    return ["fieldType", "appliesTo"];
  }
  if (requirementValue.mappingType === "subsidiary") {
    return ["baseCurrency"];
  }
  if (requirementValue.mappingType === "intercompany_customer") {
    return ["customerType"];
  }
  return [];
}

function remoteRecordType(requirementValue) {
  return requirementValue.allowedRecordTypes[0] || requirementValue.expectedRecordType;
}

function isRemoteRequirement(requirementValue) {
  return requirementValue.readStrategy === "record_by_id"
    || requirementValue.readStrategy === "metadata_catalog";
}

const REMOTE_REQUIREMENT_COUNT = CATALOG.filter(isRemoteRequirement).length;

function semanticExpected(requirementValue) {
  const externalRecordType = remoteRecordType(requirementValue);
  const expected = {
    ...requirementValue.expected,
    recordType: externalRecordType
  };
  if (requirementValue.mappingType === "subsidiary") {
    expected.baseCurrency = "CAD";
    expected.legalName = "MBT Sandbox";
  }
  if (requirementValue.mappingType === "intercompany_customer") {
    expected.externalId = "33";
    expected.entityId = "CUSTOMER-33";
    expected.companyName = "MBT Intercompany Customer";
    expected.currencyId = "1";
    expected.termsId = "2";
    expected.taxItemId = "3";
    expected.creditHold = "OFF";
    expected.subsidiaryId = "5";
    expected.customerType = "COMPANY";
  }
  if (requirementValue.mappingType === "sales_order_item") {
    expected.subsidiaryIds = ["5"];
  }
  if (requirementValue.mappingType === "custom_field") {
    expected.fieldType = "TEXT";
    expected.appliesTo = [externalRecordType];
  }
  if (requirementValue.mappingType === "income_account"
      || requirementValue.mappingType === "liability_account") {
    expected.accountType = requirementValue.mappingType === "income_account"
      ? "Income"
      : "OthCurrLiab";
    expected.name = `Configured ${requirementValue.checkCode}`;
    expected.subsidiaryIds = ["5"];
  }
  return expected;
}

function mappingFor(requirementValue, index) {
  const externalId = requirementValue.mappingType === "intercompany_customer"
    ? "33"
    : requirementValue.mappingType === "subsidiary"
      ? "5"
      : String(10_000 + index);
  return {
    mappingId: `d${String(index).padStart(7, "0")}-2222-4333-8444-555555555555`,
    mappingType: requirementValue.mappingType,
    localKey: requirementValue.localKey,
    externalId,
    externalScriptId: requirementValue.readStrategy === "metadata_catalog"
      ? `custbody_mbt_${requirementValue.localKey}`
      : null,
    externalName: `Configured ${requirementValue.checkCode}`,
    externalRecordType: remoteRecordType(requirementValue),
    subsidiaryNetSuiteId: [
      "subsidiary",
      "intercompany_customer",
      "sales_order_item"
    ].includes(requirementValue.mappingType) ? 5 : null,
    configuration: {
      expected: semanticExpected(requirementValue),
      caseInsensitiveFields: declaredCaseInsensitiveFields(requirementValue)
    },
    active: true,
    isCurrent: true,
    validationStatus: "unverified",
    validationMessage: "",
    revision: 1
  };
}

function completeMappings() {
  return CATALOG.map(mappingFor);
}

function observedFor(requirementValue, mapping) {
  const expected = semanticExpected(requirementValue);
  const { externalId: _externalId, ...directExpected } = expected;
  return {
    id: mapping.externalId,
    ...(mapping.externalScriptId ? { scriptId: mapping.externalScriptId } : {}),
    ...directExpected
  };
}

function baselineStatus(requirementValue, sourceStatuses = new Map()) {
  if (sourceStatuses.has(requirementValue.checkCode)) {
    return sourceStatuses.get(requirementValue.checkCode);
  }
  if (requirementValue.readStrategy === "unsupported") {
    return "unable_to_verify";
  }
  if (requirementValue.readStrategy !== "derived_permission") {
    return "passed";
  }
  const dependencies = requirementValue.expected.derivedFromCheckCodes || [];
  const statuses = dependencies.map((checkCode) => sourceStatuses.get(checkCode) || (
    baselineStatus(requirement(checkCode), sourceStatuses)
  ));
  if (statuses.every((status) => status === "passed")) {
    return "passed";
  }
  return statuses.includes("permission_denied") ? "permission_denied" : "unable_to_verify";
}

function terminalStatus(checks) {
  if (checks.every(({ status }) => status === "passed")) {
    return "passed";
  }
  return checks.some(({ status }) => (
    status === "permission_denied" || status === "unable_to_verify"
  )) ? "unable_to_verify" : "failed";
}

function repositoryFixture(mappings) {
  const evidence = { claims: [], completions: [] };
  const claim = {
    preflightRunId: PREFLIGHT_RUN_ID,
    configurationHash: CONFIGURATION_HASH,
    accountId: ACCOUNT_ID,
    restBaseUrl: REST_BASE_URL,
    environmentName: "sandbox",
    leaseToken: LEASE_ID,
    leaseOwner: "p2-unit-worker",
    leaseExpiresAt: "2026-08-03T13:00:30.000Z",
    mappings,
    requirements: CATALOG,
    recoveredRunId: null
  };
  const collaborator = Object.freeze({
    async claimNetSuitePreflightRun(input) {
      evidence.claims.push(input);
      return claim;
    },
    async completeNetSuitePreflightRun(input) {
      evidence.completions.push(input);
      const requiredCount = CATALOG.filter(({ required }) => required).length;
      const passedCount = input.checks.filter(({ status }) => status === "passed").length;
      return {
        preflightRunId: PREFLIGHT_RUN_ID,
        configurationHash: CONFIGURATION_HASH,
        status: terminalStatus(input.checks),
        counts: {
          required: requiredCount,
          passedRequired: passedCount,
          failedRequired: requiredCount - passedCount,
          optional: 0,
          passedOptional: 0
        },
        completedAt: "2026-08-03T13:00:01.000Z"
      };
    }
  });
  return { collaborator, evidence, claim };
}

function adapterFixture(mappings, behaviors = new Map()) {
  const evidence = { reads: [], forbiddenCapabilities: [] };
  const mappingByIdentity = new Map(mappings.map((mapping) => [
    `${mapping.externalRecordType}\u0000${mapping.externalId}`,
    mapping
  ]));
  const target = Object.freeze({
    async readRecord(recordType, externalId, descriptor) {
      evidence.reads.push({ recordType, externalId, descriptor });
      const mapping = mappingByIdentity.get(`${recordType}\u0000${externalId}`);
      if (!mapping) {
        throw Object.assign(new Error("Unexpected mapping read."), { status: 404 });
      }
      const requirementValue = CATALOG.find(({ mappingType, localKey }) => (
        mappingType === mapping.mappingType && localKey === mapping.localKey
      ));
      assert.ok(requirementValue);
      const behavior = behaviors.get(requirementValue.checkCode);
      if (behavior?.error) {
        throw behavior.error;
      }
      if (behavior?.malformed === true) {
        return behavior.value;
      }
      return {
        ...observedFor(requirementValue, mapping),
        ...(behavior?.observed || {})
      };
    }
  });
  const collaborator = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === "string" && property !== "readRecord") {
        evidence.forbiddenCapabilities.push(property);
        throw new Error(`The readiness service attempted forbidden adapter capability ${property}.`);
      }
      return Reflect.get(object, property, receiver);
    }
  });
  return { collaborator, evidence };
}

async function runScenario({ mappings = completeMappings(), behaviors = new Map() } = {}) {
  const repository = repositoryFixture(mappings);
  const adapter = adapterFixture(mappings, behaviors);
  const result = await runNetSuiteSandboxPreflight({
    adapter: adapter.collaborator,
    repository: repository.collaborator,
    accountId: ACCOUNT_ID,
    restBaseUrl: REST_BASE_URL,
    requestedBy: "p2-unit-admin",
    correlationId: "p2-unit-correlation",
    leaseOwner: "p2-unit-worker",
    leaseSeconds: 45
  });
  return { result, repository, adapter };
}

function checkByCode(result, checkCode) {
  const check = result.checks.find((candidate) => candidate.checkCode === checkCode);
  assert.ok(check, `Missing result for ${checkCode}.`);
  return check;
}

test("P2-F03 service claims from the server catalog and honestly completes unsupported proof", async () => {
  const scenario = await runScenario({ mappings: completeMappings().reverse() });
  const passedCount = scenario.result.checks.filter(({ status }) => status === "passed").length;

  assert.deepEqual(scenario.repository.evidence.claims, [{
    adapterKind: "read_only_sandbox",
    accountId: ACCOUNT_ID,
    runtimeAccountId: ACCOUNT_ID,
    environmentName: "sandbox",
    restBaseUrl: REST_BASE_URL,
    requestedBy: "p2-unit-admin",
    correlationId: "p2-unit-correlation",
    leaseOwner: "p2-unit-worker",
    leaseSeconds: 45,
    directAccessEnabled: true,
    sandboxAccountAllowlist: [ACCOUNT_ID],
    readTimeoutMs: 10_000,
    preflightLeaseSeconds: 45
  }]);
  assert.deepEqual(scenario.result, {
    claim: scenario.repository.claim,
    completion: scenario.repository.evidence.completions.length === 1
      ? {
          preflightRunId: PREFLIGHT_RUN_ID,
          configurationHash: CONFIGURATION_HASH,
          status: "unable_to_verify",
          counts: {
            required: CATALOG.length,
            passedRequired: passedCount,
            failedRequired: CATALOG.length - passedCount,
            optional: 0,
            passedOptional: 0
          },
          completedAt: "2026-08-03T13:00:01.000Z"
        }
      : null,
    checks: scenario.result.checks
  });
  assert.equal(scenario.result.checks.length, CATALOG.length);
  assert.deepEqual(
    scenario.result.checks.map(({ checkCode }) => checkCode),
    CATALOG.map(({ checkCode }) => checkCode),
    "check order is owned by the server catalog, not mapping presentation order"
  );
  for (const requirementValue of CATALOG) {
    assert.equal(
      checkByCode(scenario.result, requirementValue.checkCode).status,
      baselineStatus(requirementValue),
      requirementValue.checkCode
    );
  }
  assert.equal(scenario.adapter.evidence.reads.length, REMOTE_REQUIREMENT_COUNT);
  assert.deepEqual(scenario.adapter.evidence.forbiddenCapabilities, []);
});

test("P2-F03 service emits the stable bounded completion check shape", async () => {
  const { result, repository } = await runScenario();
  for (const check of result.checks) {
    assert.deepEqual(Object.keys(check), ["checkCode", "status", "observed", "message"]);
    assert.match(check.checkCode, /^[a-z][a-z0-9_]*$/);
    assert.equal(check.status, baselineStatus(requirement(check.checkCode)), check.checkCode);
    if (requirement(check.checkCode).readStrategy === "unsupported") {
      assert.equal(check.observed, null);
    } else {
      assert.ok(check.observed && typeof check.observed === "object");
    }
    assert.ok(check.message);
  }
  assert.deepEqual(repository.evidence.completions, [{
    preflightRunId: PREFLIGHT_RUN_ID,
    leaseToken: LEASE_ID,
    checks: result.checks
  }]);
});

test("P2-F03 every server-required mapping missing one-at-a-time fails its own check without hiding baseline proof limits", {
  timeout: 30_000
}, async () => {
  for (const missingRequirement of CATALOG) {
    const mappings = completeMappings().filter(({ mappingType, localKey }) => !(
      mappingType === missingRequirement.mappingType && localKey === missingRequirement.localKey
    ));
    const { result, adapter } = await runScenario({ mappings });
    const statuses = new Map([[missingRequirement.checkCode, "missing"]]);
    if (missingRequirement.checkCode === "mbt_subsidiary") {
      for (const related of CATALOG.filter(({ requiresSubsidiaryMembership }) => (
        requiresSubsidiaryMembership
      ))) {
        statuses.set(related.checkCode, "wrong_subsidiary");
      }
    }
    for (const requirementValue of CATALOG) {
      assert.equal(
        checkByCode(result, requirementValue.checkCode).status,
        baselineStatus(requirementValue, statuses),
        `${missingRequirement.checkCode} -> ${requirementValue.checkCode}`
      );
    }
    assert.equal(result.completion.status, "unable_to_verify");
    const skippedRemoteCount = CATALOG.filter((requirementValue) => (
      isRemoteRequirement(requirementValue)
        && (requirementValue.checkCode === missingRequirement.checkCode
          || (missingRequirement.checkCode === "mbt_subsidiary"
            && requirementValue.requiresSubsidiaryNetSuiteId))
    )).length;
    assert.equal(adapter.evidence.reads.length, REMOTE_REQUIREMENT_COUNT - skippedRemoteCount);
  }
});

test("P2-F03 inactive subsidiary, customer, and item records independently fail readiness", async () => {
  for (const checkCode of ["mbt_subsidiary", "customer_33", "item_initial_service"]) {
    const behaviors = new Map([[checkCode, { observed: { active: false } }]]);
    const { result } = await runScenario({ behaviors });
    assert.equal(checkByCode(result, checkCode).status, "inactive", checkCode);
    assert.equal(result.completion.status, "unable_to_verify");
  }
});

test("P2-F03 an inactive local mapping fails before any remote read for that mapping", async () => {
  const target = requirement("item_rental");
  const mappings = completeMappings().map((mapping) => (
    mapping.mappingType === target.mappingType && mapping.localKey === target.localKey
      ? { ...mapping, active: false }
      : mapping
  ));
  const { result, adapter } = await runScenario({ mappings });
  assert.equal(checkByCode(result, target.checkCode).status, "inactive");
  assert.equal(adapter.evidence.reads.length, REMOTE_REQUIREMENT_COUNT - 1);
});

test("P2-F03 wrong item/customer subsidiary relationships fail with the stable status", async () => {
  for (const [checkCode, observed] of [
    ["customer_33", { subsidiaryId: "999" }],
    ["item_initial_service", { subsidiaryIds: ["999"] }]
  ]) {
    const { result } = await runScenario({
      behaviors: new Map([[checkCode, { observed }]])
    });
    assert.equal(checkByCode(result, checkCode).status, "wrong_subsidiary");
    assert.equal(result.completion.status, "unable_to_verify");
  }
});

test("P2-R6 catalog declares every required configurable semantic field", async (t) => {
  const cases = [
    ["mbt_subsidiary", ["legalName", "baseCurrency"]],
    ["customer_33", [
      "entityId",
      "companyName",
      "currencyId",
      "termsId",
      "taxItemId",
      "creditHold"
    ]],
    ["custom_field_local_contract_uuid", ["fieldType"]],
    ["account_transport_revenue", ["accountType", "name"]],
    ["account_deposit_liability", ["accountType", "name"]]
  ];
  for (const [checkCode, requiredExpectedFields] of cases) {
    await t.test(checkCode, () => {
      assert.deepEqual(requirement(checkCode).requiredExpectedFields, requiredExpectedFields);
    });
  }
});

test("P2-R6 catalog requires a dedicated MBT subsidiary ID only for customer and item mappings", () => {
  assert.equal(requirement("customer_33").requiresSubsidiaryNetSuiteId, true);
  assert.equal(requirement("item_initial_service").requiresSubsidiaryNetSuiteId, true);
  assert.equal(requirement("mbt_subsidiary").requiresSubsidiaryNetSuiteId, false);
  assert.equal(requirement("account_transport_revenue").requiresSubsidiaryNetSuiteId, false);
  assert.equal(requirement("custom_field_local_contract_uuid").requiresSubsidiaryNetSuiteId, false);
});

test("P2-R6 item readiness uses MBT membership instead of exact subsidiary-array equality", async () => {
  const member = await runScenario({
    behaviors: new Map([["item_initial_service", {
      observed: { subsidiaryIds: ["7", "5"] }
    }]])
  });
  const nonMember = await runScenario({
    behaviors: new Map([["item_initial_service", {
      observed: { subsidiaryIds: ["7"] }
    }]])
  });

  assert.equal(checkByCode(member.result, "item_initial_service").status, "passed");
  assert.equal(checkByCode(nonMember.result, "item_initial_service").status, "wrong_subsidiary");
});

test("P2-R6 customer readiness accepts MBT among multiple subsidiaries and rejects a non-member", async () => {
  const member = await runScenario({
    behaviors: new Map([["customer_33", {
      observed: { subsidiaryId: undefined, subsidiaryIds: ["7", "5"] }
    }]])
  });
  const nonMember = await runScenario({
    behaviors: new Map([["customer_33", {
      observed: { subsidiaryId: undefined, subsidiaryIds: ["7"] }
    }]])
  });

  assert.equal(checkByCode(member.result, "customer_33").status, "passed");
  assert.equal(checkByCode(nonMember.result, "customer_33").status, "wrong_subsidiary");
});

test("P2-R6 a configured subsidiary mismatch fails before its remote record read", async () => {
  const target = requirement("item_initial_service");
  const mappings = completeMappings().map((mapping) => (
    mapping.mappingType === target.mappingType && mapping.localKey === target.localKey
      ? { ...mapping, subsidiaryNetSuiteId: 7 }
      : mapping
  ));
  const { result, adapter } = await runScenario({ mappings });

  const check = checkByCode(result, target.checkCode);
  assert.equal(check.status, "wrong_subsidiary");
  assert.equal(check.observed, null);
  assert.equal(adapter.evidence.reads.length, REMOTE_REQUIREMENT_COUNT - 1);
  assert.equal(
    adapter.evidence.reads.some(({ externalId }) => externalId === mappings.find((mapping) => (
      mapping.mappingType === target.mappingType && mapping.localKey === target.localKey
    )).externalId),
    false
  );
});

test("P2-R6 a direct record response without the requested ID cannot pass readiness", async () => {
  const { result } = await runScenario({
    behaviors: new Map([["item_rental", { observed: { id: undefined } }]])
  });
  assert.equal(checkByCode(result, "item_rental").status, "invalid");
});

test("P2-R6 nullable customer semantics distinguish an explicit null from missing evidence", async () => {
  const nullableMappings = completeMappings().map((mapping) => (
    mapping.mappingType === "intercompany_customer"
      ? {
          ...mapping,
          configuration: {
            ...mapping.configuration,
            expected: {
              ...mapping.configuration.expected,
              termsId: null,
              taxItemId: null
            }
          }
        }
      : mapping
  ));
  const explicitNull = await runScenario({
    mappings: nullableMappings,
    behaviors: new Map([["customer_33", {
      observed: { termsId: null, taxItemId: null }
    }]])
  });
  const absent = await runScenario({
    mappings: nullableMappings,
    behaviors: new Map([["customer_33", {
      observed: { termsId: undefined, taxItemId: undefined }
    }]])
  });

  assert.equal(checkByCode(explicitNull.result, "customer_33").status, "passed");
  assert.equal(checkByCode(absent.result, "customer_33").status, "invalid");
});

test("P2-F03 customer 33 is an immutable identity, not an Admin-selectable customer", async () => {
  const customer = requirement("customer_33");
  assert.equal(customer.expected.externalId, "33");

  const wrongMapping = completeMappings().map((mapping) => (
    mapping.mappingType === customer.mappingType && mapping.localKey === customer.localKey
      ? { ...mapping, externalId: "34" }
      : mapping
  ));
  const mappedResult = await runScenario({ mappings: wrongMapping });
  assert.equal(checkByCode(mappedResult.result, "customer_33").status, "invalid");

  const observedResult = await runScenario({
    behaviors: new Map([["customer_33", { observed: { id: "34" } }]])
  });
  assert.equal(checkByCode(observedResult.result, "customer_33").status, "invalid");
});

test("P2-F03 incompatible record type, account type, currency, field type, and applicability each fail", async () => {
  const cases = [
    ["item_dump", { recordType: "inventory_item" }],
    ["account_transport_revenue", { accountType: "liability" }],
    ["customer_33", { currencyId: "2" }],
    ["custom_field_local_contract_uuid", { fieldType: "INTEGER" }],
    ["custom_field_billing_version_id", { appliesTo: ["SALES_ORDER"] }]
  ];
  for (const [checkCode, observed] of cases) {
    const { result } = await runScenario({
      behaviors: new Map([[checkCode, { observed }]])
    });
    assert.equal(checkByCode(result, checkCode).status, "invalid", checkCode);
    assert.equal(result.completion.status, "unable_to_verify");
  }
});

test("P2-R4 configured semantic evidence is validated while server catalog expectations override policy fields", async () => {
  const subsidiaryMismatch = await runScenario({
    behaviors: new Map([["mbt_subsidiary", { observed: { baseCurrency: "USD" } }]])
  });
  assert.equal(checkByCode(subsidiaryMismatch.result, "mbt_subsidiary").status, "invalid");

  const itemRequirement = requirement("item_rental");
  const attemptedPolicyOverride = completeMappings().map((mapping) => (
    mapping.mappingType === itemRequirement.mappingType
      && mapping.localKey === itemRequirement.localKey
      ? {
          ...mapping,
          configuration: {
            ...mapping.configuration,
            expected: { ...mapping.configuration.expected, active: false }
          }
        }
      : mapping
  ));
  const serverPolicyWins = await runScenario({ mappings: attemptedPolicyOverride });
  assert.equal(checkByCode(serverPolicyWins.result, "item_rental").status, "passed");

  const accountRequirement = requirement("account_transport_revenue");
  const attemptedDowngrade = completeMappings().map((mapping) => (
    mapping.mappingType === accountRequirement.mappingType
      && mapping.localKey === accountRequirement.localKey
      ? {
          ...mapping,
          configuration: {
            ...mapping.configuration,
            expected: {
              ...mapping.configuration.expected,
              active: false,
              accountType: "asset",
              recordType: "logical_pseudo_type"
            }
          }
        }
      : mapping
  ));
  const rejectedAccountCategory = await runScenario({ mappings: attemptedDowngrade });
  assert.equal(
    checkByCode(rejectedAccountCategory.result, "account_transport_revenue").status,
    "invalid"
  );
});

test("P2-F03 semantic comparison case-normalizes only explicitly declared fields", async () => {
  const declared = await runScenario({
    behaviors: new Map([
      ["custom_field_local_contract_uuid", {
        observed: { fieldType: "text", appliesTo: ["salesorder"] }
      }]
    ])
  });
  assert.equal(declared.result.completion.status, "unable_to_verify");
  assert.equal(checkByCode(declared.result, "custom_field_local_contract_uuid").status, "passed");

  const exactAccountType = await runScenario({
    behaviors: new Map([["account_transport_revenue", {
      observed: { accountType: "INCOME" }
    }]])
  });
  assert.equal(checkByCode(exactAccountType.result, "account_transport_revenue").status, "invalid");

  const undeclared = await runScenario({
    behaviors: new Map([["customer_33", { observed: { currencyId: "01" } }]])
  });
  assert.equal(checkByCode(undeclared.result, "customer_33").status, "invalid");
});

test("P2-F03 adapter 403, 404, network failure, and malformed payload map to bounded outcomes", async () => {
  const behaviors = new Map([
    ["customer_33", {
      error: Object.assign(new Error("forbidden raw payload"), { status: 403, code: "NS_PERMISSION" })
    }],
    ["item_pickup", {
      error: Object.assign(new Error("not found raw payload"), { status: 404, code: "NS_NOT_FOUND" })
    }],
    ["item_exchange", {
      error: new Error("socket included credential=do-not-persist")
    }],
    ["item_extension", { malformed: true, value: null }]
  ]);
  const { result } = await runScenario({ behaviors });
  assert.equal(checkByCode(result, "customer_33").status, "permission_denied");
  assert.equal(checkByCode(result, "permission_read_customer").status, "permission_denied");
  assert.equal(checkByCode(result, "item_pickup").status, "missing");
  assert.equal(checkByCode(result, "item_exchange").status, "unable_to_verify");
  assert.equal(checkByCode(result, "item_extension").status, "unable_to_verify");
  assert.equal(result.completion.status, "unable_to_verify");
  assert.doesNotMatch(JSON.stringify(result.checks), /raw payload|credential|do-not-persist|socket/i);
});

test("P2-F03 future write permission checks remain configured-unproven metadata reads with no write capability", async () => {
  const { result, adapter } = await runScenario();
  const future = CATALOG.filter(({ localKey }) => localKey.startsWith("future_"));
  assert.equal(future.length, 3);
  for (const requirementValue of future) {
    assert.equal(requirementValue.requiredStatus, "configured_unproven");
    assert.deepEqual(requirementValue.expected, { permissionLevel: "configured_unproven" });
    const check = checkByCode(result, requirementValue.checkCode);
    assert.equal(check.status, "passed");
    assert.equal(check.observed.permissionLevel, "configured_unproven");
  }
  assert.equal(Object.keys(adapter.collaborator).join(","), "readRecord");
  assert.deepEqual(adapter.evidence.forbiddenCapabilities, []);
  const futureExternalIds = new Set(future.map((requirementValue) => (
    mappingFor(requirementValue, CATALOG.indexOf(requirementValue)).externalId
  )));
  assert.equal(
    adapter.evidence.reads.some(({ externalId }) => futureExternalIds.has(externalId)),
    false,
    "configured-unproven permission checks never issue a request"
  );
  assert.equal(adapter.evidence.reads.length, REMOTE_REQUIREMENT_COUNT);
});

function defensiveRequirement(overrides = {}) {
  return {
    checkCode: "defensive_check",
    mappingType: "defensive_mapping",
    localKey: "defensive_key",
    expectedRecordType: "customer",
    readStrategy: "record_by_id",
    allowedRecordTypes: ["customer"],
    expected: { active: true },
    required: true,
    ...overrides
  };
}

function defensiveMapping(requirementValue, overrides = {}) {
  return {
    mappingType: requirementValue.mappingType,
    localKey: requirementValue.localKey,
    externalId: "901",
    externalScriptId: null,
    externalRecordType: "customer",
    active: true,
    isCurrent: true,
    configuration: { expected: {}, caseInsensitiveFields: [] },
    ...overrides
  };
}

async function runDefensiveScenario({ requirements, mappings, readRecord }) {
  const completions = [];
  const reads = [];
  const adapter = {
    async readRecord(recordType, externalId, descriptor) {
      reads.push({ recordType, externalId, descriptor });
      return readRecord
        ? readRecord(recordType, externalId, descriptor)
        : { id: externalId, recordType, active: true };
    }
  };
  const repository = {
    async claimNetSuitePreflightRun() {
      return {
        preflightRunId: PREFLIGHT_RUN_ID,
        leaseToken: LEASE_ID,
        ...(requirements === undefined ? {} : { requirements }),
        ...(mappings === undefined ? {} : { mappings })
      };
    },
    async completeNetSuitePreflightRun(input) {
      completions.push(input);
      return { status: "captured" };
    }
  };
  const result = await runNetSuiteSandboxPreflight({
    adapter,
    repository,
    accountId: ACCOUNT_ID,
    restBaseUrl: REST_BASE_URL,
    requestedBy: "defensive-admin",
    correlationId: "defensive-correlation",
    leaseOwner: "defensive-worker"
  });
  return { result, reads, completions };
}

test("P2-F03 malformed service collaborators fail before claim or adapter activity", async () => {
  const repository = {
    async claimNetSuitePreflightRun() {
      throw new Error("must not claim");
    },
    async completeNetSuitePreflightRun() {
      throw new Error("must not complete");
    }
  };
  const input = {
    accountId: ACCOUNT_ID,
    restBaseUrl: REST_BASE_URL,
    requestedBy: "defensive-admin",
    correlationId: "defensive-correlation",
    leaseOwner: "defensive-worker"
  };
  for (const adapter of [null, {}]) {
    await assert.rejects(
      () => runNetSuiteSandboxPreflight({ ...input, adapter, repository }),
      (error) => error instanceof TypeError
        && error.message === "A read-only NetSuite adapter is required."
    );
  }
  for (const invalidRepository of [
    null,
    { claimNetSuitePreflightRun: async () => ({}) },
    { completeNetSuitePreflightRun: async () => ({}) }
  ]) {
    await assert.rejects(
      () => runNetSuiteSandboxPreflight({
        ...input,
        adapter: { readRecord: async () => ({}) },
        repository: invalidRepository
      }),
      (error) => error instanceof TypeError
        && error.message === "A NetSuite readiness repository is required."
    );
  }
});

test("P2-F03 malformed claimed collections fail closed or fall back to the server catalog", async () => {
  const fallback = await runDefensiveScenario({
    requirements: undefined,
    mappings: undefined
  });
  assert.equal(fallback.result.checks.length, CATALOG.length);
  assert.equal(fallback.result.checks.every(({ status }) => status === "missing"), true);
  assert.deepEqual(fallback.reads, []);

  const requirementValue = defensiveRequirement();
  const mapping = defensiveMapping(requirementValue);
  const filtered = await runDefensiveScenario({
    requirements: [null, "not-a-requirement", requirementValue],
    mappings: [false, [], mapping]
  });
  assert.deepEqual(filtered.result.checks.map(({ checkCode, status }) => ({ checkCode, status })), [{
    checkCode: requirementValue.checkCode,
    status: "passed"
  }]);
  assert.equal(filtered.reads.length, 1);
});

test("P2-F03 invalid route strategies and mappings issue zero remote reads", async () => {
  const scenarios = [
    {
      requirement: defensiveRequirement({ allowedRecordTypes: null }),
      mapping: {},
      expectedStatus: "invalid"
    },
    {
      requirement: defensiveRequirement({
        checkCode: "metadata_without_script",
        localKey: "metadata_without_script",
        readStrategy: "metadata_catalog",
        allowedRecordTypes: ["salesOrder"]
      }),
      mapping: { externalRecordType: "salesOrder", externalScriptId: "" },
      expectedStatus: "invalid"
    },
    {
      requirement: defensiveRequirement({
        checkCode: "unknown_strategy",
        localKey: "unknown_strategy",
        readStrategy: "unconfigured_strategy",
        allowedRecordTypes: []
      }),
      mapping: {},
      expectedStatus: "unable_to_verify"
    }
  ];
  for (const scenario of scenarios) {
    const mapping = defensiveMapping(scenario.requirement, scenario.mapping);
    const outcome = await runDefensiveScenario({
      requirements: [scenario.requirement],
      mappings: [mapping]
    });
    assert.equal(outcome.result.checks[0].status, scenario.expectedStatus);
    assert.deepEqual(outcome.reads, []);
  }
});

test("P2-F03 derived permissions fail closed for malformed or absent dependency evidence", async () => {
  const malformed = defensiveRequirement({
    checkCode: "derived_malformed",
    localKey: "derived_malformed",
    readStrategy: "derived_permission",
    allowedRecordTypes: [],
    expected: { derivedFromCheckCodes: "not-an-array" }
  });
  const absent = defensiveRequirement({
    checkCode: "derived_absent",
    localKey: "derived_absent",
    readStrategy: "derived_permission",
    allowedRecordTypes: [],
    expected: { derivedFromCheckCodes: ["not_present"] }
  });
  const outcome = await runDefensiveScenario({
    requirements: [malformed, absent],
    mappings: [defensiveMapping(malformed), defensiveMapping(absent)]
  });
  assert.deepEqual(outcome.result.checks.map(({ checkCode, status, observed }) => ({
    checkCode,
    status,
    observed
  })), [
    {
      checkCode: "derived_malformed",
      status: "unable_to_verify",
      observed: {
        permissionLevel: "view",
        derivedFromCheckCodes: [],
        evidenceStatuses: {}
      }
    },
    {
      checkCode: "derived_absent",
      status: "unable_to_verify",
      observed: {
        permissionLevel: "view",
        derivedFromCheckCodes: ["not_present"],
        evidenceStatuses: { not_present: "unable_to_verify" }
      }
    }
  ]);
  assert.deepEqual(outcome.reads, []);
});

test("P2-F03 bounded completion evidence sanitizes malformed adapter values deterministically", async () => {
  const requirementValue = defensiveRequirement({
    expected: { active: true }
  });
  const malformedFunction = () => "must-not-persist";
  const mapping = defensiveMapping(requirementValue, {
    configuration: {
      expected: {
        nonFinite: Number.POSITIVE_INFINITY,
        nested: { z: "last", a: "first" },
        list: [undefined, { safe: "value" }, malformedFunction],
        nullableValue: null
      },
      caseInsensitiveFields: null
    }
  });
  const outcome = await runDefensiveScenario({
    requirements: [requirementValue],
    mappings: [mapping],
    readRecord: async (recordType, externalId) => ({
      id: externalId,
      recordType,
      active: true,
      nonFinite: Number.POSITIVE_INFINITY,
      nested: { a: "first", z: "last" },
      list: [undefined, { safe: "value" }, malformedFunction],
      nullableValue: null,
      rawPayload: { secret: true }
    })
  });
  assert.equal(outcome.result.checks[0].status, "passed");
  assert.deepEqual(outcome.result.checks[0].observed, {
    id: "901",
    active: true,
    recordType: "customer",
    nonFinite: null,
    nested: { a: "first", z: "last" },
    list: [null, { safe: "value" }, null],
    nullableValue: null
  });
  assert.doesNotMatch(JSON.stringify(outcome.completions), /rawPayload|must-not-persist|secret/);
});

test("P2-F03 configured external identity mismatch is invalid even when the remote ID matches its mapping", async () => {
  const requirementValue = defensiveRequirement({
    expected: { active: true, externalId: "expected-id" }
  });
  const mapping = defensiveMapping(requirementValue, { externalId: "mapped-id" });
  const outcome = await runDefensiveScenario({
    requirements: [requirementValue],
    mappings: [mapping],
    readRecord: async (recordType, externalId) => ({
      id: externalId,
      recordType,
      active: true
    })
  });
  assert.equal(outcome.result.checks[0].status, "invalid");
});

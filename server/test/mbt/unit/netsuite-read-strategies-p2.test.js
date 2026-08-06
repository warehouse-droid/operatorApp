import assert from "node:assert/strict";
import { test } from "node:test";

import { getNetSuiteReadinessCatalog } from "../../../src/mbt/netsuite-readiness-catalog.js";
import { createReadOnlyNetSuiteAdapter } from "../../../src/mbt/netsuite-readonly-adapter.js";
import { runNetSuiteSandboxPreflight } from "../../../src/mbt/netsuite-readiness-service.js";

const CATALOG = getNetSuiteReadinessCatalog();
const RUN_ID = "e1111111-2222-4333-8444-555555555555";
const LEASE_ID = "f1111111-2222-4333-8444-555555555555";
const SANDBOX_ENVIRONMENT = Object.freeze({
  directAccessEnabled: true,
  configuredAccountId: "1234567_SB1",
  runtimeAccountId: "1234567_SB1",
  sandboxAccountAllowlist: Object.freeze(["1234567_SB1"]),
  restBaseUrl: "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1"
});

function catalogEntry(checkCode) {
  const found = CATALOG.find((entry) => entry.checkCode === checkCode);
  assert.ok(found, checkCode);
  return found;
}

test("P2-R3 catalog owns a deeply frozen read strategy and official endpoint allowlist", () => {
  const strategies = new Set([
    "record_by_id",
    "metadata_catalog",
    "derived_permission",
    "configured_unproven",
    "unsupported"
  ]);
  for (const requirement of CATALOG) {
    assert.equal(strategies.has(requirement.readStrategy), true, requirement.checkCode);
    assert.equal(Object.isFrozen(requirement.allowedRecordTypes), true, requirement.checkCode);
    assert.ok(Array.isArray(requirement.allowedRecordTypes));
    assert.equal(
      requirement.allowedRecordTypes.every((recordType) => /^[A-Za-z][A-Za-z0-9]*$/.test(recordType)),
      true,
      requirement.checkCode
    );
  }

  assert.deepEqual(catalogEntry("mbt_subsidiary").allowedRecordTypes, ["subsidiary"]);
  assert.deepEqual(catalogEntry("customer_33").allowedRecordTypes, ["customer"]);
  assert.deepEqual(catalogEntry("default_tax_mapping").allowedRecordTypes, ["salesTaxItem"]);
  assert.deepEqual(catalogEntry("account_transport_revenue").allowedRecordTypes, ["account"]);

  for (const checkCode of [
    "customer_sales_order_form",
    "sot_sales_order_form",
    "customer_deposit_form",
    "receipt_file_cabinet_folder"
  ]) {
    assert.equal(catalogEntry(checkCode).readStrategy, "unsupported");
    assert.deepEqual(catalogEntry(checkCode).allowedRecordTypes, []);
  }
});

test("P2-R3 item mappings permit official REST record variants and never the logical pseudo type", () => {
  const regularItemTypes = ["servicesaleitem", "noninventorySaleItem", "otherChargeSaleItem"];
  for (const requirement of CATALOG.filter(({ mappingType }) => mappingType === "sales_order_item")) {
    assert.equal(requirement.readStrategy, "record_by_id");
    assert.equal(requirement.allowedRecordTypes.includes("sales_order_item"), false);
    assert.deepEqual(
      requirement.allowedRecordTypes,
      requirement.localKey === "discount" ? ["discountItem"] : regularItemTypes,
      requirement.checkCode
    );
  }
});

test("P2-R3 custom fields use metadata-catalog against only approved parent record types", () => {
  for (const requirement of CATALOG.filter(({ mappingType }) => mappingType === "custom_field")) {
    assert.equal(requirement.readStrategy, "metadata_catalog");
    assert.deepEqual(requirement.allowedRecordTypes, ["salesOrder", "customerDeposit"]);
  }
});

test("P2-R3 adapter reads each official item variant from its exact record-by-ID endpoint", async () => {
  const calls = [];
  const adapter = createReadOnlyNetSuiteAdapter({
    environment: SANDBOX_ENVIRONMENT,
    async transport(url, init) {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        redirected: false,
        async json() {
          return { id: "88", name: "Configured MBT item", isInactive: false };
        }
      };
    }
  });

  for (const recordType of [
    "servicesaleitem",
    "noninventorySaleItem",
    "otherChargeSaleItem",
    "discountItem"
  ]) {
    await adapter.readRecord(recordType, "88", { readStrategy: "record_by_id" });
  }

  assert.deepEqual(calls.map(({ url, init }) => ({
    url,
    method: init.method,
    accept: init.headers?.Accept || null
  })), [
    "servicesaleitem",
    "noninventorySaleItem",
    "otherChargeSaleItem",
    "discountItem"
  ].map((recordType) => ({
    url: `${SANDBOX_ENVIRONMENT.restBaseUrl}/${recordType}/88`,
    method: "GET",
    accept: null
  })));
  assert.deepEqual(Object.keys(adapter), ["readRecord"]);
});

test("P2-R3 metadata read performs one schema GET and returns only the configured field projection", async () => {
  const calls = [];
  const adapter = createReadOnlyNetSuiteAdapter({
    environment: SANDBOX_ENVIRONMENT,
    async transport(url, init) {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        redirected: false,
        async json() {
          return {
            openapi: "3.0.1",
            links: [{ href: "https://attacker.invalid/raw-schema" }],
            components: {
              schemas: {
                salesOrder: {
                  properties: {
                    custbody_mbt_contract_uuid: {
                      type: "string",
                      title: "<img src=x onerror=alert(1)>",
                      links: [{ href: "https://attacker.invalid/field" }]
                    },
                    custbody_unrelated_secret: {
                      type: "string",
                      default: "must-not-persist"
                    }
                  }
                }
              }
            }
          };
        }
      };
    }
  });

  const observed = await adapter.readRecord("salesOrder", "941", {
    readStrategy: "metadata_catalog",
    scriptId: "custbody_mbt_contract_uuid"
  });

  assert.deepEqual(calls.map(({ url, init }) => ({
    url,
    method: init.method,
    redirect: init.redirect,
    accept: init.headers?.Accept,
    hasBody: init.body !== undefined
  })), [{
    url: `${SANDBOX_ENVIRONMENT.restBaseUrl}/metadata-catalog/salesOrder`,
    method: "GET",
    redirect: "error",
    accept: "application/schema+json",
    hasBody: false
  }]);
  assert.deepEqual(observed, {
    recordType: "salesOrder",
    scriptId: "custbody_mbt_contract_uuid",
    fieldType: "string",
    appliesTo: ["salesOrder"],
    active: true
  });
  assert.doesNotMatch(JSON.stringify(observed), /attacker|unrelated|must-not-persist|links|raw-schema/i);
  assert.deepEqual(Object.keys(adapter), ["readRecord"]);
});

test("P2-R3 metadata extractor supports Oracle's direct schema properties document", async () => {
  const adapter = createReadOnlyNetSuiteAdapter({
    environment: SANDBOX_ENVIRONMENT,
    async transport() {
      return {
        ok: true,
        status: 200,
        redirected: false,
        async json() {
          return {
            type: "object",
            properties: {
              custbody_mbt_billing_version: {
                type: "integer",
                description: "Configured billing version"
              }
            },
            links: [{ href: "https://attacker.invalid/schema" }]
          };
        }
      };
    }
  });

  assert.deepEqual(await adapter.readRecord("salesOrder", "942", {
    readStrategy: "metadata_catalog",
    scriptId: "custbody_mbt_billing_version"
  }), {
    recordType: "salesOrder",
    scriptId: "custbody_mbt_billing_version",
    fieldType: "integer",
    appliesTo: ["salesOrder"],
    active: true
  });
  assert.deepEqual(await adapter.readRecord("salesOrder", "943", {
    readStrategy: "metadata_catalog",
    scriptId: "custbody_mbt_missing"
  }), {
    recordType: "salesOrder",
    scriptId: "custbody_mbt_missing",
    active: false
  });
});

test("P2-R3 metadata catalogs are fetched once per parent type and project each script independently", async () => {
  const calls = [];
  const adapter = createReadOnlyNetSuiteAdapter({
    environment: SANDBOX_ENVIRONMENT,
    async transport(url, init) {
      calls.push({ url, init });
      const recordType = url.endsWith("/salesOrder") ? "salesOrder" : "customerDeposit";
      return {
        ok: true,
        status: 200,
        redirected: false,
        async json() {
          return {
            components: {
              schemas: {
                [recordType]: {
                  properties: recordType === "salesOrder" ? {
                    custbody_mbt_first: { type: "string" },
                    custbody_mbt_second: { type: "integer" }
                  } : {
                    custbody_mbt_deposit: { type: "number" }
                  }
                }
              }
            }
          };
        }
      };
    }
  });

  const [first, second, deposit] = await Promise.all([
    adapter.readRecord("salesOrder", "100", {
      readStrategy: "metadata_catalog",
      scriptId: "custbody_mbt_first"
    }),
    adapter.readRecord("salesOrder", "101", {
      readStrategy: "metadata_catalog",
      scriptId: "custbody_mbt_second"
    }),
    adapter.readRecord("customerDeposit", "102", {
      readStrategy: "metadata_catalog",
      scriptId: "custbody_mbt_deposit"
    })
  ]);

  assert.deepEqual(calls.map(({ url }) => url).sort(), [
    `${SANDBOX_ENVIRONMENT.restBaseUrl}/metadata-catalog/customerDeposit`,
    `${SANDBOX_ENVIRONMENT.restBaseUrl}/metadata-catalog/salesOrder`
  ]);
  assert.deepEqual(first, {
    recordType: "salesOrder",
    scriptId: "custbody_mbt_first",
    fieldType: "string",
    appliesTo: ["salesOrder"],
    active: true
  });
  assert.deepEqual(second, {
    recordType: "salesOrder",
    scriptId: "custbody_mbt_second",
    fieldType: "integer",
    appliesTo: ["salesOrder"],
    active: true
  });
  assert.deepEqual(deposit, {
    recordType: "customerDeposit",
    scriptId: "custbody_mbt_deposit",
    fieldType: "number",
    appliesTo: ["customerDeposit"],
    active: true
  });
});

test("P2-R3 a failed metadata-catalog request is evicted so a later read can retry", async () => {
  let attempts = 0;
  const adapter = createReadOnlyNetSuiteAdapter({
    environment: SANDBOX_ENVIRONMENT,
    async transport() {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary sandbox outage");
      }
      return {
        ok: true,
        status: 200,
        redirected: false,
        async json() {
          return {
            type: "object",
            properties: {
              custbody_mbt_retry: { type: "string" }
            }
          };
        }
      };
    }
  });

  await assert.rejects(
    () => adapter.readRecord("salesOrder", "retry-1", {
      readStrategy: "metadata_catalog",
      scriptId: "custbody_mbt_retry"
    }),
    (error) => error?.code === "MBT_NETSUITE_UNABLE_TO_VERIFY"
  );
  assert.deepEqual(await adapter.readRecord("salesOrder", "retry-2", {
    readStrategy: "metadata_catalog",
    scriptId: "custbody_mbt_retry"
  }), {
    recordType: "salesOrder",
    scriptId: "custbody_mbt_retry",
    fieldType: "string",
    appliesTo: ["salesOrder"],
    active: true
  });
  assert.equal(attempts, 2);
});

function strategyExternalId(requirement, index) {
  if (requirement.checkCode === "customer_33") {
    return "33";
  }
  return requirement.mappingType === "subsidiary" ? "5" : String(20_000 + index);
}

function strategyExpected(requirement, externalRecordType) {
  const expected = {
    ...requirement.expected,
    recordType: externalRecordType
  };
  if (requirement.mappingType === "sales_order_item") {
    expected.subsidiaryIds = ["5"];
  }
  if (requirement.mappingType === "subsidiary") {
    expected.legalName = "MBT Sandbox";
    expected.baseCurrency = "CAD";
  }
  if (requirement.mappingType === "intercompany_customer") {
    Object.assign(expected, {
      entityId: "CUSTOMER-33",
      companyName: "MBT Intercompany Customer",
      currencyId: "1",
      termsId: "2",
      taxItemId: "3",
      creditHold: "OFF",
      subsidiaryId: "5"
    });
  }
  if (requirement.mappingType === "income_account"
      || requirement.mappingType === "liability_account") {
    expected.accountType = requirement.mappingType === "income_account"
      ? "Income"
      : "OthCurrLiab";
    expected.name = `Configured ${requirement.checkCode}`;
    expected.subsidiaryIds = ["5"];
  }
  if (requirement.mappingType === "custom_field") {
    expected.fieldType = "string";
    expected.appliesTo = [externalRecordType];
  }
  return expected;
}

function strategyMapping(requirement, index) {
  const externalRecordType = requirement.allowedRecordTypes?.[0] || requirement.expectedRecordType;
  const externalId = strategyExternalId(requirement, index);
  const expected = strategyExpected(requirement, externalRecordType);
  return {
    mappingType: requirement.mappingType,
    localKey: requirement.localKey,
    externalId,
    externalScriptId: requirement.mappingType === "custom_field"
      ? `custbody_mbt_${requirement.localKey}`
      : null,
    externalRecordType,
    subsidiaryNetSuiteId: requirement.requiresSubsidiaryNetSuiteId ? 5 : null,
    active: true,
    isCurrent: true,
    configuration: {
      expected,
      caseInsensitiveFields: requirement.mappingType === "custom_field"
        ? ["fieldType", "appliesTo"]
        : []
    },
    revision: 1
  };
}

function strategyRepository(mappings) {
  const evidence = { completions: [] };
  return {
    evidence,
    collaborator: Object.freeze({
      async claimNetSuitePreflightRun() {
        return {
          preflightRunId: RUN_ID,
          configurationHash: "1".repeat(64),
          accountId: "1234567_SB1",
          environmentName: "sandbox",
          leaseToken: LEASE_ID,
          leaseOwner: "p2-r3-worker",
          leaseExpiresAt: "2026-08-03T14:00:30.000Z",
          mappings,
          requirements: CATALOG,
          recoveredRunId: null
        };
      },
      async completeNetSuitePreflightRun(input) {
        evidence.completions.push(input);
        const status = input.checks.some((check) => check.status === "unable_to_verify")
          ? "unable_to_verify"
          : input.checks.every((check) => check.status === "passed") ? "passed" : "failed";
        return {
          preflightRunId: RUN_ID,
          configurationHash: "1".repeat(64),
          status,
          counts: {},
          completedAt: "2026-08-03T14:00:01.000Z"
        };
      }
    })
  };
}

function strategyAdapter(mappings, overrides = new Map()) {
  const calls = [];
  const byIdentity = new Map(mappings.map((mapping) => [
    `${mapping.externalRecordType}\u0000${mapping.externalId}`,
    mapping
  ]));
  return {
    calls,
    collaborator: Object.freeze({
      async readRecord(recordType, externalId, descriptor) {
        calls.push({ recordType, externalId, descriptor });
        const mapping = byIdentity.get(`${recordType}\u0000${externalId}`);
        assert.ok(mapping, `${recordType}/${externalId}`);
        const requirement = CATALOG.find(({ mappingType, localKey }) => (
          mappingType === mapping.mappingType && localKey === mapping.localKey
        ));
        assert.ok(requirement);
        const override = overrides.get(requirement.checkCode);
        if (override?.error) {
          throw override.error;
        }
        const expected = mapping.configuration.expected;
        return {
          id: mapping.externalId,
          ...expected,
          ...(mapping.externalScriptId ? { scriptId: mapping.externalScriptId } : {}),
          ...(override?.observed || {})
        };
      }
    })
  };
}

async function runStrategyScenario(overrides = new Map()) {
  const mappings = CATALOG.map(strategyMapping);
  const repository = strategyRepository(mappings);
  const adapter = strategyAdapter(mappings, overrides);
  const result = await runNetSuiteSandboxPreflight({
    adapter: adapter.collaborator,
    repository: repository.collaborator,
    accountId: "1234567_SB1",
    restBaseUrl: "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1",
    requestedBy: "p2-r3-admin",
    correlationId: "p2-r3-correlation",
    leaseOwner: "p2-r3-worker",
    leaseSeconds: 30
  });
  return { result, repository, adapter };
}

test("P2-R3 full catalog fails honestly while every supported check still passes", async () => {
  const { result, adapter } = await runStrategyScenario();
  const statuses = new Map(result.checks.map(({ checkCode, status }) => [checkCode, status]));
  for (const requirement of CATALOG) {
    if (requirement.readStrategy === "unsupported") {
      assert.equal(statuses.get(requirement.checkCode), "unable_to_verify", requirement.checkCode);
    } else if (requirement.readStrategy === "derived_permission") {
      const dependencies = requirement.expected.derivedFromCheckCodes || [];
      const expectedStatus = dependencies.every((checkCode) => statuses.get(checkCode) === "passed")
        ? "passed"
        : "unable_to_verify";
      assert.equal(statuses.get(requirement.checkCode), expectedStatus, requirement.checkCode);
    } else {
      assert.equal(statuses.get(requirement.checkCode), "passed", requirement.checkCode);
    }
  }
  assert.equal(result.completion.status, "unable_to_verify");
  assert.equal(
    adapter.calls.length,
    CATALOG.filter(({ readStrategy }) => (
      readStrategy === "record_by_id" || readStrategy === "metadata_catalog"
    )).length
  );
});

test("P2-R3 future permissions and unsupported proof issue zero adapter requests", async () => {
  const { result, adapter } = await runStrategyScenario();
  const requestedTypes = new Set(adapter.calls.map(({ recordType }) => recordType));
  for (const requirement of CATALOG.filter(({ readStrategy }) => (
    readStrategy === "configured_unproven" || readStrategy === "unsupported"
  ))) {
    const mapping = strategyMapping(requirement, CATALOG.indexOf(requirement));
    assert.equal(requestedTypes.has(mapping.externalRecordType), false, requirement.checkCode);
    const check = result.checks.find(({ checkCode }) => checkCode === requirement.checkCode);
    assert.ok(check);
    assert.equal(
      check.status,
      requirement.readStrategy === "configured_unproven" ? "passed" : "unable_to_verify"
    );
  }
});

test("P2-R3 derived read permissions depend only on their representative check evidence", async () => {
  const source = catalogEntry("customer_33");
  const denied = Object.assign(new Error("forbidden"), { status: 403 });
  const { result, adapter } = await runStrategyScenario(new Map([[source.checkCode, { error: denied }]]));
  const derived = catalogEntry("permission_read_customer");
  assert.deepEqual(derived.expected.derivedFromCheckCodes, ["customer_33"]);
  assert.equal(
    result.checks.find(({ checkCode }) => checkCode === source.checkCode)?.status,
    "permission_denied"
  );
  assert.equal(
    result.checks.find(({ checkCode }) => checkCode === derived.checkCode)?.status,
    "permission_denied"
  );
  assert.equal(
    adapter.calls.some(({ recordType }) => recordType === derived.expectedRecordType),
    false,
    "a derived permission is never a remote record probe"
  );
});

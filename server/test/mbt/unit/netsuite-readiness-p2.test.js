import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NETSUITE_READINESS_REQUIREMENTS,
  getNetSuiteReadinessCatalog
} from "../../../src/mbt/netsuite-readiness-catalog.js";
import {
  assertSandboxNetSuiteEnvironment,
  createReadOnlyNetSuiteAdapter,
  projectObservedNetSuiteRecord
} from "../../../src/mbt/netsuite-readonly-adapter.js";
import {
  buildPreflightReport,
  serializePreflightCsv,
  serializePreflightJson
} from "../../../src/mbt/netsuite-readiness-report.js";
import { configurationHash } from "../../../src/mbt/preflight.js";

const SANDBOX_ENVIRONMENT = Object.freeze({
  directAccessEnabled: true,
  configuredAccountId: "1234567_SB1",
  runtimeAccountId: "1234567_SB1",
  sandboxAccountAllowlist: Object.freeze(["1234567_SB1"]),
  restBaseUrl: "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1"
});

const EXPECTED_CATALOG_IDENTITIES = Object.freeze([
  "subsidiary:mbt",
  "intercompany_customer:customer_33",
  "sales_order_form:customer",
  "sales_order_form:sot_cross_charge",
  "customer_deposit_form:customer_deposit",
  "sales_order_item:initial_service",
  "sales_order_item:rental",
  "sales_order_item:extension",
  "sales_order_item:exchange",
  "sales_order_item:pickup",
  "sales_order_item:dump",
  "sales_order_item:downtown_surcharge",
  "sales_order_item:discount",
  "sales_order_item:cross_charge",
  "tax_code:default",
  "income_account:transport_revenue",
  "income_account:dump_revenue",
  "income_account:rental_revenue",
  "liability_account:deposit",
  "file_cabinet_folder:receipt",
  "integration_permission:read_subsidiary",
  "integration_permission:read_customer",
  "integration_permission:read_forms",
  "integration_permission:read_items",
  "integration_permission:read_accounts_tax",
  "integration_permission:read_custom_fields",
  "integration_permission:read_file_cabinet_folder",
  "integration_permission:future_sales_order_write",
  "integration_permission:future_customer_deposit_write",
  "integration_permission:future_file_cabinet_write",
  "custom_field:local_contract_uuid",
  "custom_field:contract_sequence",
  "custom_field:predecessor_sales_order",
  "custom_field:billing_version_id",
  "custom_field:billing_line_uuid",
  "custom_field:external_idempotency_key",
  "custom_field:physical_load",
  "custom_field:plan_date",
  "custom_field:truck",
  "custom_field:driver",
  "custom_field:source_references",
  "custom_field:raw_distance_metres",
  "custom_field:display_distance_kilometres",
  "custom_field:rate_band_reference",
  "custom_field:downtown_surcharge",
  "custom_field:allocation_evidence"
]);

const HOSTILE_NAME = "<img src=x onerror=alert(1)> & \"Customer 33\"";

function assertDeepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  assert.equal(Object.isFrozen(value), true, "catalog values must be immutable");
  for (const child of Object.values(value)) {
    assertDeepFrozen(child, seen);
  }
}

function safeRemoteRecord(overrides = {}) {
  return {
    id: 33,
    scriptId: "custentity_mbt_customer",
    name: HOSTILE_NAME,
    entityId: "CUSTOMER-33",
    companyName: HOSTILE_NAME,
    isInactive: false,
    subsidiary: { id: 5, refName: "MBT", accessToken: "mbt-test-nested-sensitive-value" },
    subsidiaries: { items: [{ id: 7, refName: "Second yard" }, { id: 5, refName: "MBT" }] },
    currency: { id: 1, refName: "CAD" },
    terms: { id: 2, refName: "Net 30" },
    taxItem: { id: 3, refName: "HST" },
    creditHoldOverride: "OFF",
    accountType: "Income",
    fieldType: "TEXT",
    appliesTo: ["SALE", "CUSTOMER_DEPOSIT"],
    permissionLevel: "VIEW",
    path: "/MBT/Receipts",
    accessToken: "mbt-test-top-level-sensitive-value",
    clientSecret: "mbt-test-another-sensitive-value",
    links: [{ rel: "self", href: "https://untrusted.invalid/raw" }],
    rawPayload: { unrestricted: true },
    ...overrides
  };
}

function reportInput(checks) {
  return {
    runId: "a1111111-2222-4333-8444-555555555555",
    accountId: "1234567_SB1",
    environmentName: "sandbox",
    configurationHash: "a".repeat(64),
    status: "failed",
    generatedAt: "2026-08-03T12:34:56.000Z",
    current: false,
    checks,
    signoff: null,
    oauthToken: "mbt-test-report-sensitive-value",
    rawPayload: { shouldNeverAppear: true }
  };
}

function checksFixture() {
  return [
    {
      sequenceNumber: 20,
      checkCode: "customer_33",
      mappingType: "intercompany_customer",
      localKey: "customer_33",
      required: true,
      severity: "error",
      status: "inactive",
      expected: { active: true, subsidiaryId: "5" },
      observed: projectObservedNetSuiteRecord("customer", safeRemoteRecord()),
      message: "=HYPERLINK(\"https://attacker.invalid\",\"open\")\r\nSecond line, \"quoted\""
    },
    {
      sequenceNumber: 10,
      checkCode: "mbt_subsidiary",
      mappingType: "subsidiary",
      localKey: "mbt",
      required: true,
      severity: "error",
      status: "passed",
      expected: { active: true },
      observed: projectObservedNetSuiteRecord("subsidiary", {
        id: 5,
        name: "MBT > Toronto",
        isInactive: false
      }),
      message: "Verified with read-only access."
    }
  ];
}

test("P2-F03 catalog is server-owned, complete, stable, unique, and deeply immutable", () => {
  assert.equal(getNetSuiteReadinessCatalog(), NETSUITE_READINESS_REQUIREMENTS);
  assert.equal(getNetSuiteReadinessCatalog.length, 0, "the browser cannot submit its own catalog");
  assertDeepFrozen(NETSUITE_READINESS_REQUIREMENTS);

  const identities = NETSUITE_READINESS_REQUIREMENTS.map(({ mappingType, localKey }) => (
    `${mappingType}:${localKey}`
  ));
  assert.deepEqual(identities, EXPECTED_CATALOG_IDENTITIES);
  assert.equal(new Set(identities).size, identities.length);
  assert.equal(
    new Set(NETSUITE_READINESS_REQUIREMENTS.map(({ checkCode }) => checkCode)).size,
    NETSUITE_READINESS_REQUIREMENTS.length
  );

  for (const requirement of NETSUITE_READINESS_REQUIREMENTS) {
    assert.deepEqual(Object.keys(requirement).sort(), [
      "allowedAccountTypes",
      "allowedRecordTypes",
      "checkCode",
      "display",
      "expected",
      "expectedRecordType",
      "localKey",
      "mappingType",
      "readStrategy",
      "required",
      "requiredExpectedFields",
      "requiredStatus",
      "requiresSubsidiaryMembership",
      "requiresSubsidiaryNetSuiteId",
      "severity",
      "verificationKind"
    ]);
    assert.match(requirement.checkCode, /^[a-z][a-z0-9_]*$/);
    assert.match(requirement.localKey, /^[a-z][a-z0-9_.:-]*$/);
    assert.equal(requirement.required, true);
    assert.equal(requirement.severity, "error");
    assert.ok(requirement.expectedRecordType);
    assert.ok(requirement.verificationKind);
    assert.ok(requirement.display?.label);
  }
});

test("P2-F03 future write permissions are evidence-only and can never imply a write probe", () => {
  const futurePermissions = NETSUITE_READINESS_REQUIREMENTS.filter(({ localKey }) => (
    localKey.startsWith("future_")
  ));

  assert.deepEqual(futurePermissions.map(({ localKey }) => localKey), [
    "future_sales_order_write",
    "future_customer_deposit_write",
    "future_file_cabinet_write"
  ]);
  for (const permission of futurePermissions) {
    assert.equal(permission.mappingType, "integration_permission");
    assert.equal(permission.requiredStatus, "configured_unproven");
    assert.equal(permission.verificationKind, "metadata_read");
    assert.deepEqual(permission.expected, { permissionLevel: "configured_unproven" });
  }
});

test("P2-F01 environment guard accepts only the exact configured and allowlisted sandbox", () => {
  assert.deepEqual(assertSandboxNetSuiteEnvironment(SANDBOX_ENVIRONMENT), {
    accountId: "1234567_SB1",
    environmentName: "sandbox",
    restBaseUrl: SANDBOX_ENVIRONMENT.restBaseUrl
  });
});

test("P2-F01 direct access, exact allowlist, production, URL, and runtime-account guards fail closed", () => {
  const scenarios = [
    {
      patch: { directAccessEnabled: false },
      code: "MBT_NETSUITE_DIRECT_ACCESS_REQUIRED"
    },
    {
      patch: { sandboxAccountAllowlist: [] },
      code: "MBT_NETSUITE_SANDBOX_NOT_ALLOWED"
    },
    {
      patch: { sandboxAccountAllowlist: ["1234567_SB2"] },
      code: "MBT_NETSUITE_SANDBOX_NOT_ALLOWED"
    },
    {
      patch: {
        configuredAccountId: "1234567",
        runtimeAccountId: "1234567",
        sandboxAccountAllowlist: ["1234567"],
        restBaseUrl: "https://1234567.suitetalk.api.netsuite.com/services/rest/record/v1",
        allowProduction: true
      },
      code: "MBT_NETSUITE_PRODUCTION_REFUSED"
    },
    {
      patch: {
        restBaseUrl: "https://1234567.suitetalk.api.netsuite.com/services/rest/record/v1",
        allowProduction: true
      },
      code: "MBT_NETSUITE_PRODUCTION_REFUSED"
    },
    {
      patch: { runtimeAccountId: "1234567_SB2" },
      code: "MBT_NETSUITE_ACCOUNT_MISMATCH"
    }
  ];

  for (const { patch, code } of scenarios) {
    assert.throws(
      () => assertSandboxNetSuiteEnvironment({ ...SANDBOX_ENVIRONMENT, ...patch }),
      (error) => error?.status === 409 && error?.code === code,
      code
    );
  }
});

test("P2-F01 invalid environments fail before adapter construction can call transport", () => {
  let transportCalls = 0;
  assert.throws(
    () => createReadOnlyNetSuiteAdapter({
      environment: { ...SANDBOX_ENVIRONMENT, directAccessEnabled: false },
      transport: async () => {
        transportCalls += 1;
      }
    }),
    (error) => error?.code === "MBT_NETSUITE_DIRECT_ACCESS_REQUIRED"
  );
  assert.equal(transportCalls, 0);
});

test("P2-F01 malformed sandbox URLs fail closed across every URL authority component", () => {
  const invalidRestBaseUrls = [
    "not-a-url",
    "http://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1",
    "https://user@1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1",
    "https://:secret@1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1",
    "https://1234567-sb1.suitetalk.api.netsuite.com:8443/services/rest/record/v1",
    "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1?expand=true",
    "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1#fragment"
  ];
  for (const restBaseUrl of invalidRestBaseUrls) {
    assert.throws(
      () => assertSandboxNetSuiteEnvironment({ ...SANDBOX_ENVIRONMENT, restBaseUrl }),
      (error) => error?.code === "MBT_NETSUITE_PRODUCTION_REFUSED",
      restBaseUrl
    );
  }
});

test("P2-F01 adapter rejects invalid construction and read descriptors before transport", async () => {
  assert.throws(
    () => createReadOnlyNetSuiteAdapter({ environment: SANDBOX_ENVIRONMENT, transport: null }),
    (error) => error instanceof TypeError && error.message === "A NetSuite GET transport is required."
  );
  for (const timeoutMs of [0, 60_001, 1.5]) {
    assert.throws(
      () => createReadOnlyNetSuiteAdapter({
        environment: SANDBOX_ENVIRONMENT,
        transport: async () => null,
        timeoutMs
      }),
      (error) => error instanceof TypeError
        && error.message === "The NetSuite read timeout must be an integer from 1 to 60000 milliseconds."
    );
  }

  let transportCalls = 0;
  const adapter = createReadOnlyNetSuiteAdapter({
    environment: SANDBOX_ENVIRONMENT,
    transport: async () => {
      transportCalls += 1;
      return null;
    }
  });
  await assert.rejects(
    () => adapter.readRecord("customer", ""),
    (error) => error instanceof TypeError && error.message === "A NetSuite internal ID is required."
  );
  await assert.rejects(
    () => adapter.readRecord("customer", "33", { readStrategy: "suiteql" }),
    (error) => error instanceof TypeError
      && error.message === "A supported NetSuite read strategy is required."
  );
  await assert.rejects(
    () => adapter.readRecord("salesOrder", "33", {
      readStrategy: "metadata_catalog",
      scriptId: "custbody field?expand=true"
    }),
    (error) => error instanceof TypeError
      && error.message === "A safe NetSuite custom-field script ID is required."
  );
  assert.equal(transportCalls, 0);
});

test("P2-F01 adapter exposes one frozen read capability and records only encoded GET requests", async () => {
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
          return safeRemoteRecord();
        }
      };
    }
  });

  assert.equal(Object.isFrozen(adapter), true);
  assert.deepEqual(Object.keys(adapter), ["readRecord"]);
  for (const forbidden of [
    "request",
    "suiteql",
    "post",
    "put",
    "patch",
    "delete",
    "createSalesOrder",
    "createDeposit",
    "updateSalesOrder",
    "deleteRecord"
  ]) {
    assert.equal(adapter[forbidden], undefined, `${forbidden} must be unreachable`);
  }

  const observed = await adapter.readRecord("customer", "33 /../../?");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `${SANDBOX_ENVIRONMENT.restBaseUrl}/customer/33%20%2F..%2F..%2F%3F`
  );
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(observed, projectObservedNetSuiteRecord("customer", safeRemoteRecord()));
});

test("P2-F01 preflight transport rejects redirects and never retries with a non-GET method", async () => {
  const methods = [];
  const adapter = createReadOnlyNetSuiteAdapter({
    environment: SANDBOX_ENVIRONMENT,
    async transport(_url, init) {
      methods.push(init.method);
      return {
        ok: true,
        status: 200,
        redirected: true,
        url: "https://attacker.invalid/collect",
        async json() {
          return safeRemoteRecord();
        }
      };
    }
  });

  await assert.rejects(
    () => adapter.readRecord("customer", "33"),
    (error) => error?.status === 502 && error?.code === "MBT_NETSUITE_REDIRECT_REFUSED"
  );
  assert.deepEqual(methods, ["GET"]);
});

test("P2-F01 transport, HTTP, JSON, and metadata-shape failures stay bounded", async () => {
  const scenarios = [
    {
      transport: async () => {
        throw new Error("socket credential=must-not-leak");
      },
      code: "MBT_NETSUITE_UNABLE_TO_VERIFY"
    },
    {
      transport: async () => ({ ok: false, status: 500, async json() { return {}; } }),
      code: "MBT_NETSUITE_UNABLE_TO_VERIFY"
    },
    {
      transport: async () => null,
      code: "MBT_NETSUITE_UNABLE_TO_VERIFY"
    },
    {
      transport: async () => ({
        ok: true,
        status: 200,
        redirected: false,
        async json() {
          throw new Error("malformed response secret=must-not-leak");
        }
      }),
      code: "MBT_NETSUITE_UNABLE_TO_VERIFY"
    }
  ];
  for (const scenario of scenarios) {
    const adapter = createReadOnlyNetSuiteAdapter({
      environment: SANDBOX_ENVIRONMENT,
      transport: scenario.transport
    });
    await assert.rejects(
      () => adapter.readRecord("customer", "33"),
      (error) => error?.status === 502
        && error?.code === scenario.code
        && !/credential|secret/i.test(error.message)
    );
  }

  const malformedMetadata = createReadOnlyNetSuiteAdapter({
    environment: SANDBOX_ENVIRONMENT,
    transport: async () => ({
      ok: true,
      status: 200,
      redirected: false,
      async json() {
        return null;
      }
    })
  });
  await assert.rejects(
    () => malformedMetadata.readRecord("salesOrder", "33", {
      readStrategy: "metadata_catalog",
      scriptId: "custbody_mbt_contract_uuid"
    }),
    (error) => error instanceof TypeError
      && error.message === "A NetSuite metadata catalog object is required."
  );
});

test("P2-F01 observed projection persists only bounded verification fields", () => {
  const projected = projectObservedNetSuiteRecord("customer", safeRemoteRecord());
  assert.deepEqual(projected, {
    recordType: "customer",
    id: "33",
    scriptId: "custentity_mbt_customer",
    name: HOSTILE_NAME,
    entityId: "CUSTOMER-33",
    companyName: HOSTILE_NAME,
    active: true,
    subsidiaryId: "5",
    subsidiaryIds: ["5", "7"],
    currencyId: "1",
    termsId: "2",
    taxItemId: "3",
    creditHold: "OFF",
    accountType: "Income",
    fieldType: "TEXT",
    appliesTo: ["CUSTOMER_DEPOSIT", "SALE"],
    permissionLevel: "VIEW",
    folderPath: "/MBT/Receipts"
  });
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /sensitive-value|accessToken|clientSecret|links|rawPayload|untrusted\.invalid/);
  assert.equal({}.polluted, undefined);
});

test("P2-F01 projection normalizes reference-valued semantic fields to bounded scalar evidence", () => {
  assert.deepEqual(projectObservedNetSuiteRecord("subsidiary", {
    id: 5,
    isInactive: false,
    baseCurrency: {
      id: 1,
      refName: "CAD",
      links: [{ href: "https://attacker.invalid/currency" }],
      accessToken: "must-not-persist"
    }
  }), {
    recordType: "subsidiary",
    id: "5",
    active: true,
    baseCurrency: "CAD",
    baseCurrencyId: "1",
    baseCurrencyName: "CAD"
  });
  assert.deepEqual(projectObservedNetSuiteRecord("account", {
    id: 81,
    isInactive: false,
    accountType: { id: "Income", refName: "Income", links: [] }
  }), {
    recordType: "account",
    id: "81",
    active: true,
    accountType: "Income"
  });
  assert.deepEqual(projectObservedNetSuiteRecord("customer", {
    id: 33,
    isInactive: false,
    customerType: { id: "COMPANY", refName: "Company", rawPayload: true }
  }), {
    recordType: "customer",
    id: "33",
    active: true,
    customerType: "Company"
  });
  assert.deepEqual(projectObservedNetSuiteRecord("customer", {
    id: 34,
    customerType: { id: "COMPANY", refName: "" }
  }), {
    recordType: "customer",
    id: "34",
    customerType: "COMPANY"
  });
});

test("P2-R6 explicit null customer references remain evidence instead of becoming absence", () => {
  assert.deepEqual(projectObservedNetSuiteRecord("customer", {
    id: "33",
    isInactive: false,
    terms: null,
    taxItem: null
  }), {
    recordType: "customer",
    id: "33",
    active: true,
    termsId: null,
    taxItemId: null
  });
});

test("P2-F01 item subsidiary collections accept nested and direct reference shapes", () => {
  assert.deepEqual(projectObservedNetSuiteRecord("serviceSaleItem", {
    id: 88,
    subsidiary: {
      items: [
        { id: 7, refName: "Yard 7" },
        { id: "5", refName: "Yard 5" },
        { id: 7, refName: "Duplicate yard" },
        { refName: "No ID" }
      ],
      links: [{ href: "https://attacker.invalid/subsidiaries" }]
    }
  }), {
    recordType: "serviceSaleItem",
    id: "88",
    subsidiaryIds: ["5", "7"]
  });
  assert.deepEqual(projectObservedNetSuiteRecord("nonInventorySaleItem", {
    id: 89,
    subsidiaryIds: [{ id: "9" }, "5", { id: 9 }, {}, null]
  }), {
    recordType: "nonInventorySaleItem",
    id: "89",
    subsidiaryIds: ["5", "9"]
  });
});

test("P2-F01 unusable reference objects are omitted instead of becoming object string evidence", () => {
  const projected = projectObservedNetSuiteRecord("customer", {
    id: 33,
    accountType: { links: [] },
    baseCurrency: { accessToken: "must-not-persist" },
    customerType: { refName: { raw: true } },
    subsidiaries: { items: { raw: true } },
    subsidiaryIds: [{}],
    appliesTo: [{}]
  });
  assert.deepEqual(projected, {
    recordType: "customer",
    id: "33",
    subsidiaryIds: []
  });
  assert.doesNotMatch(JSON.stringify(projected), /\[object Object\]|accessToken|raw/i);
});

test("P2-F01 projection rejects malformed remote data instead of persisting an unrestricted payload", () => {
  for (const payload of [null, [], "record", 42]) {
    assert.throws(
      () => projectObservedNetSuiteRecord("customer", payload),
      (error) => error instanceof TypeError
        && error.message === "A NetSuite record object is required."
    );
  }
  assert.throws(
    () => projectObservedNetSuiteRecord("../customer", safeRemoteRecord()),
    (error) => error instanceof TypeError
      && error.message === "A safe NetSuite record type is required."
  );
});

test("P2-F04 configuration hash is stable for P2 mapping order and changes for semantic edits", () => {
  const mappings = [
    {
      mappingType: "subsidiary",
      localKey: "mbt",
      externalId: "5",
      externalRecordType: "subsidiary",
      revision: 1,
      configuration: { baseCurrencyId: "1", depositLimitCents: 125_000 }
    },
    {
      mappingType: "intercompany_customer",
      localKey: "customer_33",
      externalId: "33",
      externalRecordType: "customer",
      revision: 2,
      configuration: { expectedSubsidiaryId: "5" }
    }
  ];
  const reordered = [
    {
      configuration: { expectedSubsidiaryId: "5" },
      revision: 2,
      externalRecordType: "customer",
      externalId: "33",
      localKey: "customer_33",
      mappingType: "intercompany_customer"
    },
    {
      revision: 1,
      mappingType: "subsidiary",
      configuration: { depositLimitCents: 125_000, baseCurrencyId: "1" },
      externalRecordType: "subsidiary",
      localKey: "mbt",
      externalId: "5"
    }
  ];

  const hash = configurationHash(mappings);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(configurationHash(reordered), hash);
  assert.notEqual(
    configurationHash([{ ...mappings[0], configuration: { ...mappings[0].configuration, depositLimitCents: 125_001 } }, mappings[1]]),
    hash
  );
  assert.notEqual(
    configurationHash([{ ...mappings[0], configuration: { ...mappings[0].configuration, depositLimitCents: "125000" } }, mappings[1]]),
    hash,
    "integer currency evidence must not hash like a string"
  );
});

test("P2-F05 report projection is deterministic, ordered, immutable, and excludes raw evidence", () => {
  const checks = checksFixture();
  const report = buildPreflightReport(reportInput(checks));
  const reordered = buildPreflightReport(reportInput([...checks].reverse()));

  assert.deepEqual(report, reordered);
  assert.equal(Object.isFrozen(report), true);
  assertDeepFrozen(report);
  assert.deepEqual(report.checks.map(({ checkCode }) => checkCode), [
    "mbt_subsidiary",
    "customer_33"
  ]);
  assert.deepEqual(Object.keys(report), [
    "schemaVersion",
    "runId",
    "accountId",
    "environmentName",
    "configurationHash",
    "status",
    "generatedAt",
    "current",
    "signoff",
    "checks"
  ]);
  assert.doesNotMatch(
    JSON.stringify(report),
    /report-sensitive-value|top-level-sensitive-value|nested-sensitive-value|oauthToken|clientSecret|rawPayload/
  );
});

test("P2-F05 JSON export is canonical, HTML-safe, newline-terminated, and round-trips hostile text", () => {
  const report = buildPreflightReport(reportInput(checksFixture()));
  const json = serializePreflightJson(report);
  const second = serializePreflightJson(buildPreflightReport(reportInput([...checksFixture()].reverse())));

  assert.equal(json, second);
  assert.equal(json.endsWith("\n"), true);
  assert.doesNotMatch(json, /[<>&\u2028\u2029]/u);
  assert.deepEqual(JSON.parse(json), report);
  assert.match(json, /\\u003cimg src=x onerror=alert\(1\)\\u003e/);
  assert.doesNotMatch(json, /sensitive-value|oauthToken|clientSecret|rawPayload/);
});

test("P2-F05 CSV export has a fixed order, RFC 4180 quoting, and formula neutralization", () => {
  const report = buildPreflightReport(reportInput(checksFixture()));
  const csv = serializePreflightCsv(report);
  const second = serializePreflightCsv(buildPreflightReport(reportInput([...checksFixture()].reverse())));

  assert.equal(csv, second);
  assert.equal(csv.endsWith("\r\n"), true);
  assert.equal(csv.split("\r\n", 1)[0], [
    "run_id",
    "account_id",
    "environment_name",
    "configuration_hash",
    "run_status",
    "generated_at",
    "current",
    "signoff_status",
    "sequence_number",
    "check_code",
    "mapping_type",
    "local_key",
    "required",
    "severity",
    "check_status",
    "expected_json",
    "observed_json",
    "message"
  ].join(","));
  assert.match(
    csv,
    /"'=HYPERLINK\(""https:\/\/attacker\.invalid"",""open""\)\r\nSecond line, ""quoted"""/
  );
  assert.doesNotMatch(csv, /sensitive-value|oauthToken|clientSecret|rawPayload/);
  assert.ok(
    csv.indexOf(",10,mbt_subsidiary,") < csv.indexOf(",20,customer_33,"),
    "checks must use persisted sequence order"
  );
});

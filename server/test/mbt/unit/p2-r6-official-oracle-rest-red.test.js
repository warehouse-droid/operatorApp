import assert from "node:assert/strict";
import { test } from "node:test";

import { getNetSuiteReadinessCatalog } from "../../../src/mbt/netsuite-readiness-catalog.js";
import {
  createReadOnlyNetSuiteAdapter,
  projectObservedNetSuiteRecord
} from "../../../src/mbt/netsuite-readonly-adapter.js";
import { runNetSuiteSandboxPreflight } from "../../../src/mbt/netsuite-readiness-service.js";

const ACCOUNT_ID = "1234567_SB1";
const REST_BASE_URL = "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1";
const CATALOG = getNetSuiteReadinessCatalog();

const OFFICIAL_ITEM_FIXTURES = Object.freeze([
  Object.freeze({
    checkCode: "item_initial_service",
    recordType: "servicesaleitem",
    internalId: "501"
  }),
  Object.freeze({
    checkCode: "item_rental",
    recordType: "noninventorySaleItem",
    internalId: "502"
  })
]);

function requirement(checkCode) {
  const found = CATALOG.find((candidate) => candidate.checkCode === checkCode);
  assert.ok(found, `Missing catalog requirement ${checkCode}.`);
  return found;
}

function mappingFor(requirementValue, {
  recordType,
  internalId,
  expected = {},
  caseInsensitiveFields = []
}) {
  return {
    mappingId: `p2-r6-${requirementValue.checkCode}`,
    mappingType: requirementValue.mappingType,
    localKey: requirementValue.localKey,
    externalId: internalId,
    externalScriptId: null,
    externalName: `P2-R6 ${requirementValue.checkCode}`,
    externalRecordType: recordType,
    subsidiaryNetSuiteId: 5,
    configuration: { expected, caseInsensitiveFields },
    active: true,
    isCurrent: true,
    validationStatus: "unverified",
    validationMessage: "",
    revision: 1
  };
}

function repositoryFixture(requirementValue, mapping) {
  const subsidiaryMapping = {
    mappingType: "subsidiary",
    localKey: "mbt",
    externalId: "5",
    externalRecordType: "subsidiary",
    active: true,
    isCurrent: true,
    configuration: {
      expected: { legalName: "MBT Sandbox", baseCurrency: "CAD" }
    }
  };
  return Object.freeze({
    async claimNetSuitePreflightRun() {
      return {
        preflightRunId: "9672d32d-c28c-455e-80db-c73974ad6497",
        configurationHash: "6".repeat(64),
        accountId: ACCOUNT_ID,
        environmentName: "sandbox",
        leaseToken: "test-p2-r6-lease-token",
        mappings: [subsidiaryMapping, mapping],
        requirements: [requirementValue]
      };
    },
    async completeNetSuitePreflightRun({ checks }) {
      return {
        preflightRunId: "9672d32d-c28c-455e-80db-c73974ad6497",
        configurationHash: "6".repeat(64),
        status: checks.every(({ status }) => status === "passed") ? "passed" : "failed"
      };
    }
  });
}

async function runOfficialRecord({
  checkCode,
  recordType,
  internalId,
  payload,
  expected = {},
  caseInsensitiveFields = []
}) {
  const requirementValue = requirement(checkCode);
  const mapping = mappingFor(requirementValue, {
    recordType,
    internalId,
    expected,
    caseInsensitiveFields
  });
  const calls = [];
  const adapter = createReadOnlyNetSuiteAdapter({
    environment: {
      directAccessEnabled: true,
      configuredAccountId: ACCOUNT_ID,
      runtimeAccountId: ACCOUNT_ID,
      sandboxAccountAllowlist: [ACCOUNT_ID],
      restBaseUrl: REST_BASE_URL
    },
    async transport(url, init) {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        redirected: false,
        async json() {
          return payload;
        }
      };
    }
  });
  const result = await runNetSuiteSandboxPreflight({
    adapter,
    repository: repositoryFixture(requirementValue, mapping),
    accountId: ACCOUNT_ID,
    restBaseUrl: REST_BASE_URL,
    requestedBy: "p2-r6-admin",
    correlationId: `p2-r6-${checkCode}`,
    leaseOwner: "p2-r6-official-oracle-red",
    leaseSeconds: 30
  });
  return { calls, result };
}

test("P2-R6 catalog freezes Oracle's exact service and non-inventory sale item record IDs", () => {
  for (const checkCode of ["item_initial_service", "item_rental"]) {
    assert.deepEqual(
      requirement(checkCode).allowedRecordTypes,
      ["servicesaleitem", "noninventorySaleItem", "otherChargeSaleItem"],
      checkCode
    );
  }
});

for (const fixture of OFFICIAL_ITEM_FIXTURES) {
  test(`P2-R6 ${fixture.recordType} uses the exact official GET record path`, async () => {
    const { calls, result } = await runOfficialRecord({
      ...fixture,
      expected: { subsidiaryIds: ["5"] },
      payload: {
        id: fixture.internalId,
        isInactive: false,
        subsidiary: { items: [{ id: "5" }] }
      }
    });
    assert.equal(result.checks[0].status, "passed");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(
      calls[0].url,
      `${REST_BASE_URL}/${fixture.recordType}/${fixture.internalId}`
    );
  });
}

test("P2-R6 subsidiary projection consumes Oracle legalName and currency fields", () => {
  assert.deepEqual(projectObservedNetSuiteRecord("subsidiary", {
    id: "5",
    isInactive: false,
    legalName: "MBT Sandbox Legal Name",
    currency: { id: "1", refName: "CAD" }
  }), {
    recordType: "subsidiary",
    id: "5",
    legalName: "MBT Sandbox Legal Name",
    active: true,
    currencyId: "1",
    baseCurrency: "CAD",
    baseCurrencyId: "1",
    baseCurrencyName: "CAD"
  });
});

test("P2-R6 account projection consumes Oracle acctName, acctType, and subsidiary.items", () => {
  assert.deepEqual(projectObservedNetSuiteRecord("account", {
    id: "81",
    isInactive: false,
    acctName: "Transport Revenue",
    acctType: { id: "Income", refName: "Income" },
    subsidiary: { items: [{ id: "5" }, { id: "7" }] }
  }), {
    recordType: "account",
    id: "81",
    name: "Transport Revenue",
    active: true,
    subsidiaryIds: ["5", "7"],
    accountType: "Income"
  });
});

test("P2-R6 an official Income acctType passes the revenue-account requirement", async () => {
  const { calls, result } = await runOfficialRecord({
    checkCode: "account_transport_revenue",
    recordType: "account",
    internalId: "81",
    expected: { accountType: "Income", name: "Transport Revenue" },
    payload: {
      id: "81",
      isInactive: false,
      acctName: "Transport Revenue",
      acctType: { id: "Income", refName: "Income" },
      subsidiary: { items: [{ id: "5" }] }
    }
  });
  assert.equal(result.checks[0].status, "passed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${REST_BASE_URL}/account/81`);
});

test("P2-R6 a wrong official acctType fails the revenue-account requirement", async () => {
  const { result } = await runOfficialRecord({
    checkCode: "account_transport_revenue",
    recordType: "account",
    internalId: "82",
    expected: { accountType: "Income", name: "Not Revenue" },
    payload: {
      id: "82",
      isInactive: false,
      acctName: "Not Revenue",
      acctType: { id: "OthCurrAsset", refName: "Other Current Asset" },
      subsidiary: { items: [{ id: "5" }] }
    }
  });
  assert.equal(result.checks[0].status, "invalid");
});

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import { getNetSuiteReadinessCatalog } from "../../../src/mbt/netsuite-readiness-catalog.js";
import { runNetSuiteSandboxPreflight } from "../../../src/mbt/netsuite-readiness-service.js";

const CATALOG = getNetSuiteReadinessCatalog();
const ACCOUNT_ID = "1234567_SB1";
const REST_BASE_URL = "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1";
const REMOTE_STRATEGIES = new Set(["record_by_id", "metadata_catalog"]);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function latencyExternalId(requirement, index) {
  if (requirement.checkCode === "customer_33") {
    return "33";
  }
  return requirement.mappingType === "subsidiary" ? "5" : String(30_000 + index);
}

function latencyExpected(requirement, externalRecordType) {
  const expected = {
    ...requirement.expected,
    recordType: externalRecordType
  };
  if (requirement.mappingType === "custom_field") {
    expected.fieldType = "string";
    expected.appliesTo = [externalRecordType];
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
  if (requirement.mappingType === "sales_order_item") {
    expected.subsidiaryIds = ["5"];
  }
  if (requirement.mappingType === "income_account"
      || requirement.mappingType === "liability_account") {
    expected.accountType = requirement.mappingType === "income_account"
      ? "Income"
      : "OthCurrLiab";
    expected.name = `Configured ${requirement.checkCode}`;
    expected.subsidiaryIds = ["5"];
  }
  return expected;
}

function mappingFor(requirement, index) {
  const externalRecordType = requirement.allowedRecordTypes[0] || requirement.expectedRecordType;
  const externalId = latencyExternalId(requirement, index);
  const expected = latencyExpected(requirement, externalRecordType);
  return {
    mappingType: requirement.mappingType,
    localKey: requirement.localKey,
    externalId,
    externalScriptId: requirement.readStrategy === "metadata_catalog"
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

function readinessFixture({ readDelay }) {
  const mappings = CATALOG.map(mappingFor);
  const mappingByIdentity = new Map(mappings.map((mapping, index) => [
    `${mapping.externalRecordType}\u0000${mapping.externalId}`,
    { mapping, requirement: CATALOG[index] }
  ]));
  const evidence = {
    activeReads: 0,
    maxActiveReads: 0,
    requestedCheckCodes: [],
    completedCheckCodes: [],
    completionChecks: []
  };
  const repository = Object.freeze({
    async claimNetSuitePreflightRun() {
      return {
        preflightRunId: "91111111-2222-4333-8444-555555555555",
        configurationHash: "9".repeat(64),
        accountId: ACCOUNT_ID,
        restBaseUrl: REST_BASE_URL,
        environmentName: "sandbox",
        leaseToken: "mbt-test-latency-lease",
        leaseOwner: "p2-latency-worker",
        leaseExpiresAt: "2026-08-03T15:02:00.000Z",
        mappings,
        requirements: CATALOG,
        recoveredRunId: null
      };
    },
    async completeNetSuitePreflightRun(input) {
      evidence.completionChecks = input.checks;
      return {
        preflightRunId: input.preflightRunId,
        configurationHash: "9".repeat(64),
        status: "unable_to_verify",
        counts: {},
        completedAt: "2026-08-03T15:00:01.000Z"
      };
    }
  });
  const adapter = Object.freeze({
    async readRecord(recordType, externalId) {
      const fixture = mappingByIdentity.get(`${recordType}\u0000${externalId}`);
      assert.ok(fixture, `Unexpected readiness read ${recordType}/${externalId}.`);
      evidence.activeReads += 1;
      evidence.maxActiveReads = Math.max(evidence.maxActiveReads, evidence.activeReads);
      evidence.requestedCheckCodes.push(fixture.requirement.checkCode);
      try {
        await readDelay(fixture.requirement, evidence.requestedCheckCodes.length - 1);
        evidence.completedCheckCodes.push(fixture.requirement.checkCode);
        return {
          id: fixture.mapping.externalId,
          ...(fixture.mapping.externalScriptId
            ? { scriptId: fixture.mapping.externalScriptId }
            : {}),
          ...fixture.mapping.configuration.expected
        };
      } finally {
        evidence.activeReads -= 1;
      }
    }
  });
  return { adapter, repository, evidence };
}

async function runFixture(fixture) {
  return runNetSuiteSandboxPreflight({
    adapter: fixture.adapter,
    repository: fixture.repository,
    accountId: ACCOUNT_ID,
    restBaseUrl: REST_BASE_URL,
    requestedBy: "p2-latency-admin",
    correlationId: "p2-latency-correlation",
    leaseOwner: "p2-latency-worker",
    leaseSeconds: 120
  });
}

test("P2-R3 readiness bounds remote reads at four while preserving catalog result order", async () => {
  const remoteRequirements = CATALOG.filter(({ readStrategy }) => REMOTE_STRATEGIES.has(readStrategy));
  const fixture = readinessFixture({
    async readDelay(_requirement, startIndex) {
      await delay(8 + ((remoteRequirements.length - startIndex) % 4) * 7);
    }
  });

  const result = await runFixture(fixture);

  assert.equal(fixture.evidence.maxActiveReads, 4);
  assert.deepEqual(
    result.checks.map(({ checkCode }) => checkCode),
    CATALOG.map(({ checkCode }) => checkCode)
  );
  assert.deepEqual(
    fixture.evidence.completionChecks.map(({ checkCode }) => checkCode),
    CATALOG.map(({ checkCode }) => checkCode)
  );
  assert.notDeepEqual(
    fixture.evidence.completedCheckCodes,
    fixture.evidence.requestedCheckCodes,
    "the fixture must actually complete requests out of order"
  );
  assert.deepEqual(
    new Set(fixture.evidence.requestedCheckCodes),
    new Set(remoteRequirements.map(({ checkCode }) => checkCode))
  );
  for (const requirement of CATALOG.filter(({ readStrategy }) => (
    readStrategy === "unsupported" || readStrategy === "configured_unproven"
  ))) {
    assert.equal(
      fixture.evidence.requestedCheckCodes.includes(requirement.checkCode),
      false,
      `${requirement.checkCode} must remain a zero-request check`
    );
  }
});

test("P2-R3 slow in-timeout reads complete within the readiness lease budget", { timeout: 5_000 }, async () => {
  const fixture = readinessFixture({
    async readDelay() {
      await delay(60);
    }
  });
  const startedAt = performance.now();

  await runFixture(fixture);

  const elapsedMs = performance.now() - startedAt;
  assert.equal(fixture.evidence.maxActiveReads, 4);
  assert.ok(
    elapsedMs < 1_200,
    `bounded parallel readiness should finish below 1200ms; observed ${Math.round(elapsedMs)}ms`
  );
});

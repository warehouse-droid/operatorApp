import assert from "node:assert/strict";
import { test } from "node:test";

import { getNetSuiteReadinessCatalog } from "../../../src/mbt/netsuite-readiness-catalog.js";
import { runNetSuiteSandboxPreflight } from "../../../src/mbt/netsuite-readiness-service.js";
import { projectObservedNetSuiteRecord } from "../../../src/mbt/netsuite-readonly-adapter.js";

const CATALOG = getNetSuiteReadinessCatalog();
const MBT_SUBSIDIARY_ID = "5";
const WRONG_SUBSIDIARY_ID = "999";
const ACCOUNT_CASES = Object.freeze([
  Object.freeze(["account_transport_revenue", "Income"]),
  Object.freeze(["account_dump_revenue", "Income"]),
  Object.freeze(["account_rental_revenue", "Income"]),
  Object.freeze(["account_deposit_liability", "OthCurrLiab"])
]);

function catalogRequirement(checkCode) {
  const requirement = CATALOG.find((candidate) => candidate.checkCode === checkCode);
  assert.ok(requirement, `Missing server catalog requirement ${checkCode}.`);
  return requirement;
}

function subsidiaryMapping() {
  return {
    mappingType: "subsidiary",
    localKey: "mbt",
    externalId: MBT_SUBSIDIARY_ID,
    externalScriptId: null,
    externalName: "MBT Sandbox",
    externalRecordType: "subsidiary",
    subsidiaryNetSuiteId: null,
    configuration: {
      expected: {
        legalName: "MBT Sandbox",
        baseCurrency: "CAD"
      },
      caseInsensitiveFields: ["baseCurrency"]
    },
    active: true,
    isCurrent: true
  };
}

function accountMapping(requirement, accountType) {
  return {
    mappingType: requirement.mappingType,
    localKey: requirement.localKey,
    externalId: `account-${requirement.localKey}`,
    externalScriptId: null,
    externalName: requirement.display.label,
    externalRecordType: "account",
    subsidiaryNetSuiteId: null,
    configuration: {
      expected: {
        accountType,
        name: requirement.display.label
      },
      caseInsensitiveFields: []
    },
    active: true,
    isCurrent: true
  };
}

async function accountMembershipOutcome(checkCode, accountType) {
  const requirement = catalogRequirement(checkCode);
  const account = accountMapping(requirement, accountType);
  const reads = [];
  const repository = {
    async claimNetSuitePreflightRun() {
      return {
        preflightRunId: "a1111111-2222-4333-8444-555555555555",
        leaseToken: "test-p2-r7-account-lease-token",
        requirements: [requirement],
        mappings: [subsidiaryMapping(), account]
      };
    },
    async completeNetSuitePreflightRun({ checks }) {
      return { status: checks[0].status };
    }
  };
  const adapter = {
    async readRecord(recordType, externalId) {
      reads.push({ recordType, externalId });
      return {
        id: externalId,
        recordType,
        active: true,
        name: requirement.display.label,
        accountType,
        subsidiaryIds: [WRONG_SUBSIDIARY_ID]
      };
    }
  };
  const result = await runNetSuiteSandboxPreflight({
    adapter,
    repository,
    accountId: "1234567_SB1",
    restBaseUrl: "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1",
    requestedBy: "p2-r7-account-admin",
    correlationId: `p2-r7-account-${checkCode}`,
    leaseOwner: `p2-r7-account-worker-${checkCode}`,
    leaseSeconds: 45
  });
  return { requirement, account, reads, check: result.checks[0] };
}

for (const [checkCode, accountType] of ACCOUNT_CASES) {
  test(`P2-R7 ${checkCode} proves MBT subsidiary membership without a dedicated subsidiary input`, async () => {
    const outcome = await accountMembershipOutcome(checkCode, accountType);

    assert.equal(outcome.requirement.requiresSubsidiaryNetSuiteId, false);
    assert.equal(outcome.account.subsidiaryNetSuiteId, null);
    assert.deepEqual(outcome.reads, [{
      recordType: "account",
      externalId: outcome.account.externalId
    }]);
    assert.deepEqual(outcome.check, {
      checkCode,
      status: "wrong_subsidiary",
      observed: {
        id: outcome.account.externalId,
        active: true,
        recordType: "account",
        subsidiaryIds: [WRONG_SUBSIDIARY_ID],
        accountType,
        name: outcome.requirement.display.label
      },
      message: "The NetSuite record does not belong to the configured MBT subsidiary."
    });
  });
}

test("P2-R7 official account evidence takes the exact acctType ID when its display name differs", () => {
  const projected = projectObservedNetSuiteRecord("account", {
    id: "456",
    acctName: "Transport Revenue",
    acctType: {
      id: "Income",
      refName: "Revenue account"
    },
    isInactive: false,
    subsidiary: {
      items: [{ id: MBT_SUBSIDIARY_ID, refName: "MBT" }]
    }
  });

  assert.deepEqual(projected, {
    recordType: "account",
    id: "456",
    name: "Transport Revenue",
    active: true,
    subsidiaryIds: [MBT_SUBSIDIARY_ID],
    accountType: "Income"
  });
});

test("P2-R7 official lowercase subsidiary fields project and pass without compatibility aliases", async () => {
  const officialRecord = {
    id: MBT_SUBSIDIARY_ID,
    name: "MBT",
    legalname: "MBT Sandbox",
    isinactive: false,
    currency: { id: "1", refName: "CAD" }
  };
  for (const compatibilityAlias of ["legalName", "isInactive", "active", "baseCurrency"]) {
    assert.equal(Object.hasOwn(officialRecord, compatibilityAlias), false);
  }
  const projected = projectObservedNetSuiteRecord("subsidiary", officialRecord);
  assert.deepEqual(projected, {
    recordType: "subsidiary",
    id: MBT_SUBSIDIARY_ID,
    name: "MBT",
    legalName: "MBT Sandbox",
    active: true,
    currencyId: "1",
    baseCurrency: "CAD",
    baseCurrencyId: "1",
    baseCurrencyName: "CAD"
  });

  const requirement = catalogRequirement("mbt_subsidiary");
  const mapping = subsidiaryMapping();
  const result = await runNetSuiteSandboxPreflight({
    adapter: { async readRecord() { return projected; } },
    repository: {
      async claimNetSuitePreflightRun() {
        return {
          preflightRunId: "c1111111-2222-4333-8444-555555555555",
          leaseToken: "test-p2-r7-subsidiary-lease-token",
          requirements: [requirement],
          mappings: [mapping]
        };
      },
      async completeNetSuitePreflightRun({ checks }) {
        return { status: checks[0].status };
      }
    },
    accountId: "1234567_SB1",
    restBaseUrl: "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1",
    requestedBy: "p2-r7-subsidiary-admin",
    correlationId: "p2-r7-official-subsidiary",
    leaseOwner: "p2-r7-official-subsidiary-worker",
    leaseSeconds: 45
  });

  assert.deepEqual(result.checks, [{
    checkCode: "mbt_subsidiary",
    status: "passed",
    observed: {
      id: MBT_SUBSIDIARY_ID,
      active: true,
      recordType: "subsidiary",
      baseCurrency: "CAD",
      legalName: "MBT Sandbox"
    },
    message: "Verified with read-only NetSuite sandbox metadata access."
  }]);
});

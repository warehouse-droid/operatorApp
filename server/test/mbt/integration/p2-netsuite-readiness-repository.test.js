import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import {
  beginRollbackContext,
  closeDb,
  query,
  withTransaction
} from "../../../src/db.js";
import { MbtError } from "../../../src/mbt/errors.js";
import {
  claimNetSuitePreflightRun,
  completeNetSuitePreflightRun,
  getCurrentNetSuiteReadiness,
  getNetSuitePreflightRun,
  listNetSuiteMappings,
  putNetSuiteMapping,
  signoffNetSuitePreflightRun
} from "../../../src/mbt/netsuite-readiness-repository.js";

import { canonicalSha256 } from "../../../src/mbt/canonical-json.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const ACTOR = Object.freeze({
  operatorId: `p2-db-admin-${RUN_ID}`,
  roles: Object.freeze(["admin"])
});
const SUBSIDIARY_KEY = Object.freeze({
  checkCode: "mbt_subsidiary",
  mappingType: "subsidiary",
  localKey: "mbt",
  expectedRecordType: "subsidiary"
});
const NETSUITE_RUNTIME = Object.freeze({
  adapterKind: "read_only_sandbox",
  accountId: "1234567_SB1",
  environmentName: "sandbox",
  restBaseUrl: "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1",
  directAccessEnabled: true,
  sandboxAccountAllowlist: Object.freeze(["1234567_SB1"]),
  readTimeoutMs: 10_000,
  preflightLeaseSeconds: 30
});
let sequence = 0;

function identity(label) {
  sequence += 1;
  const suffix = `${RUN_ID}-${sequence}`;
  return {
    correlationId: `p2-db-corr-${label}-${suffix}`,
    idempotencyKey: `p2-db-idem-${label}-${suffix}`,
    requestId: `p2-db-req-${label}-${suffix}`
  };
}

async function inRollback(callback) {
  const context = await beginRollbackContext();
  try {
    return await context.run(callback);
  } finally {
    await context.rollback();
  }
}

function assertUuid(value, label) {
  assert.match(String(value), /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, label);
}

function mappingValues(version) {
  const internalId = 80_000_000 + Number(version);
  return {
    externalId: String(internalId),
    externalScriptId: null,
    externalName: `P2 DB Sandbox Subsidiary v${version}`,
    externalRecordType: SUBSIDIARY_KEY.expectedRecordType,
    subsidiaryNetSuiteId: internalId,
    configuration: {
      expected: {
        baseCurrency: "CAD",
        legalName: `P2 DB Fixture v${version}`
      },
      caseInsensitiveFields: ["baseCurrency"]
    },
    active: true
  };
}

function semanticMappingFixture(checkCode) {
  const fixtures = {
    mbt_subsidiary: {
      externalId: "5",
      externalScriptId: null,
      externalName: "MBT Sandbox",
      externalRecordType: "subsidiary",
      subsidiaryNetSuiteId: 5,
      configuration: {
        expected: { legalName: "MBT Sandbox", baseCurrency: "CAD" },
        caseInsensitiveFields: ["baseCurrency"]
      },
      active: true
    },
    customer_33: {
      externalId: "33",
      externalScriptId: null,
      externalName: "MBT Intercompany Customer",
      externalRecordType: "customer",
      subsidiaryNetSuiteId: 5,
      configuration: {
        expected: {
          entityId: "CUSTOMER-33",
          companyName: "MBT Intercompany Customer",
          currencyId: "1",
          termsId: "2",
          taxItemId: "3",
          creditHold: "OFF",
          customerType: "COMPANY"
        },
        caseInsensitiveFields: ["customerType"]
      },
      active: true
    },
    custom_field_local_contract_uuid: {
      externalId: "salesOrder",
      externalScriptId: "custbody_mbt_local_contract_uuid",
      externalName: "Local contract UUID",
      externalRecordType: "salesOrder",
      subsidiaryNetSuiteId: null,
      configuration: {
        expected: { fieldType: "string" },
        caseInsensitiveFields: ["fieldType"]
      },
      active: true
    },
    account_transport_revenue: {
      externalId: "81",
      externalScriptId: null,
      externalName: "Transport Revenue",
      externalRecordType: "account",
      subsidiaryNetSuiteId: null,
      configuration: {
        expected: { accountType: "Income", name: "Transport Revenue" },
        caseInsensitiveFields: []
      },
      active: true
    },
    account_deposit_liability: {
      externalId: "82",
      externalScriptId: null,
      externalName: "Customer Deposits",
      externalRecordType: "account",
      subsidiaryNetSuiteId: null,
      configuration: {
        expected: { accountType: "OthCurrLiab", name: "Customer Deposits" },
        caseInsensitiveFields: []
      },
      active: true
    },
    item_initial_service: {
      externalId: "83",
      externalScriptId: null,
      externalName: "Initial Service",
      externalRecordType: "servicesaleitem",
      subsidiaryNetSuiteId: 5,
      configuration: { expected: { subsidiaryIds: ["5"] } },
      active: true
    }
  };
  const fixture = fixtures[checkCode];
  assert.ok(fixture, `Missing P2-R6 mapping fixture ${checkCode}.`);
  return structuredClone(fixture);
}

function expectedConfigurationHash(listed) {
  const mappings = listed.requirements
    .map(({ currentMapping }) => currentMapping)
    .filter(Boolean)
    .map((mapping) => ({
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
    }));
  const requirements = listed.requirements.map((requirement) => ({
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
    ...(requirement.requiredExpectedFields === undefined
      ? {}
      : { requiredExpectedFields: requirement.requiredExpectedFields }),
    ...(requirement.requiresSubsidiaryNetSuiteId === undefined
      ? {}
      : { requiresSubsidiaryNetSuiteId: requirement.requiresSubsidiaryNetSuiteId }),
    ...(requirement.requiresSubsidiaryMembership === undefined
      ? {}
      : { requiresSubsidiaryMembership: requirement.requiresSubsidiaryMembership }),
    ...(requirement.allowedAccountTypes === undefined
      ? {}
      : { allowedAccountTypes: requirement.allowedAccountTypes })
  }));
  return canonicalSha256({
    schema: "mbt-netsuite-readiness-v2",
    requirements,
    mappings
  });
}

function expectedSnapshot(requirement, mappings) {
  const mapping = mappings.find((candidate) => (
    candidate.mappingType === requirement.mappingType
      && candidate.localKey === requirement.localKey
  ));
  if (!mapping) {
    return requirement.expected;
  }
  const expected = {
    ...(mapping.configuration.expected || {}),
    ...requirement.expected,
    recordType: mapping.externalRecordType,
    ...(requirement.readStrategy === "metadata_catalog"
      ? {
          scriptId: mapping.externalScriptId,
          appliesTo: [mapping.externalRecordType]
        }
      : {})
  };
  if (requirement.requiresSubsidiaryNetSuiteId) {
    delete expected.subsidiaryIds;
    expected.subsidiaryId = String(mapping.subsidiaryNetSuiteId);
  }
  return expected;
}

function mappingCommand(version, expectedRevision, commandIdentity = identity(`mapping-v${version}`)) {
  return {
    actor: ACTOR,
    mappingType: SUBSIDIARY_KEY.mappingType,
    localKey: SUBSIDIARY_KEY.localKey,
    mapping: mappingValues(version),
    expectedRevision,
    reason: `P2 repository mapping revision ${version}`,
    ...commandIdentity
  };
}

function assertMapping(mapping, valueVersion, revision, mappingId = mapping.mappingId) {
  assertUuid(mappingId, "A mapping UUID is required.");
  assert.deepEqual(mapping, {
    mappingId,
    mappingType: SUBSIDIARY_KEY.mappingType,
    localKey: SUBSIDIARY_KEY.localKey,
    ...mappingValues(valueVersion),
    isCurrent: true,
    validationStatus: "unverified",
    validationMessage: "",
    revision
  });
}

async function createMapping() {
  const listed = await listNetSuiteMappings();
  const requirement = listed.requirements.find(({ checkCode }) => (
    checkCode === SUBSIDIARY_KEY.checkCode
  ));
  assert.ok(requirement);
  const baselineRevision = requirement.currentMapping?.revision || 0;
  const valueVersion = baselineRevision + 1;
  const command = mappingCommand(valueVersion, baselineRevision);
  const result = await putNetSuiteMapping(command);
  assert.equal(result.status, 200);
  assert.equal(result.replayed, false);
  assert.deepEqual(Object.keys(result.body).sort(), ["configurationHash", "mapping"]);
  assert.match(result.body.configurationHash, /^[0-9a-f]{64}$/);
  assertMapping(result.body.mapping, valueVersion, baselineRevision + 1);
  return { baselineRevision, command, result, valueVersion };
}

function claimInput(label = "claim") {
  return {
    ...NETSUITE_RUNTIME,
    requestedBy: ACTOR.operatorId,
    correlationId: identity(label).correlationId,
    leaseOwner: `p2-db-worker-${RUN_ID}-${sequence}`,
    leaseSeconds: 30
  };
}

function assertClaimShape(claim) {
  assert.deepEqual(Object.keys(claim).sort(), [
    "accountId",
    "configurationHash",
    "environmentName",
    "leaseExpiresAt",
    "leaseOwner",
    "leaseToken",
    "mappings",
    "preflightRunId",
    "recoveredRunId",
    "requirements",
    "runtimeFingerprint"
  ]);
  assertUuid(claim.preflightRunId, "A preflight run UUID is required.");
  assertUuid(claim.leaseToken, "A preflight lease UUID is required.");
  assert.match(claim.configurationHash, /^[0-9a-f]{64}$/);
  assert.equal(claim.accountId, NETSUITE_RUNTIME.accountId);
  assert.equal(claim.environmentName, "sandbox");
  assert.match(claim.runtimeFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(claim.recoveredRunId, null);
  assert.ok(Number.isFinite(Date.parse(claim.leaseExpiresAt)));
  assert.ok(Array.isArray(claim.mappings));
  assert.ok(Array.isArray(claim.requirements) && claim.requirements.length > 0);
  const subsidiary = claim.requirements.find(({ checkCode }) => checkCode === SUBSIDIARY_KEY.checkCode);
  assert.ok(subsidiary, "The server-owned MBT subsidiary requirement is mandatory.");
  assert.deepEqual(
    {
      checkCode: subsidiary.checkCode,
      mappingType: subsidiary.mappingType,
      localKey: subsidiary.localKey,
      expectedRecordType: subsidiary.expectedRecordType
    },
    SUBSIDIARY_KEY
  );
}

function passingChecks(claim) {
  return claim.requirements.map((requirement) => ({
    checkCode: requirement.checkCode,
    status: "passed",
    observed: {
      active: true,
      fixture: `p2-db-observed-${requirement.checkCode}`
    },
    message: `Verified ${requirement.checkCode} through read-only sandbox access.`
  }));
}

async function createPassingRun(label = "passing-run") {
  const claim = await claimNetSuitePreflightRun(claimInput(label));
  assertClaimShape(claim);
  const completed = await completeNetSuitePreflightRun({
    preflightRunId: claim.preflightRunId,
    leaseToken: claim.leaseToken,
    checks: passingChecks(claim)
  });
  assert.deepEqual(Object.keys(completed).sort(), [
    "completedAt",
    "configurationHash",
    "counts",
    "preflightRunId",
    "status"
  ]);
  assert.deepEqual(
    {
      preflightRunId: completed.preflightRunId,
      configurationHash: completed.configurationHash,
      status: completed.status
    },
    {
      preflightRunId: claim.preflightRunId,
      configurationHash: claim.configurationHash,
      status: "passed"
    }
  );
  assert.ok(Number.isFinite(Date.parse(completed.completedAt)));
  return { claim, completed };
}

async function signoff(run, label = "signoff") {
  const command = identity(label);
  const result = await signoffNetSuitePreflightRun({
    actor: ACTOR,
    preflightRunId: run.claim.preflightRunId,
    reason: `P2 sandbox signoff ${label}`,
    runtime: NETSUITE_RUNTIME,
    ...command
  });
  assert.equal(result.status, 200);
  assert.equal(result.replayed, false);
  assert.deepEqual(Object.keys(result.body), ["signoff"]);
  const record = result.body.signoff;
  assertUuid(record.signoffId, "A signoff UUID is required.");
  assert.deepEqual(
    {
      preflightRunId: record.preflightRunId,
      configurationHash: record.configurationHash,
      signedBy: record.signedBy,
      auditNote: record.auditNote,
      current: record.current
    },
    {
      preflightRunId: run.claim.preflightRunId,
      configurationHash: run.claim.configurationHash,
      signedBy: ACTOR.operatorId,
      auditNote: `P2 sandbox signoff ${label}`,
      current: true
    }
  );
  assert.ok(Number.isFinite(Date.parse(record.signedAt)));
  return { command, result };
}

after(async () => {
  await closeDb();
});

test("P2-F02: expected revision 0 creates revision 1; exact retry replays and update appends revision 2", async () => {
  await inRollback(async () => {
    const initial = await listNetSuiteMappings();
    assert.deepEqual(Object.keys(initial).sort(), ["configurationHash", "requirements"]);
    assert.match(initial.configurationHash, /^[0-9a-f]{64}$/);
    assert.equal(initial.configurationHash, expectedConfigurationHash(initial));
    const initialRequirement = initial.requirements.find(({ checkCode }) => (
      checkCode === SUBSIDIARY_KEY.checkCode
    ));
    assert.ok(initialRequirement);
    const initialRevision = initialRequirement.currentMapping?.revision || 0;
    if (initialRevision === 0) {
      assert.equal(initialRequirement.currentMapping, null);
      assert.deepEqual(initialRequirement.history, []);
    }

    const created = await createMapping();
    assert.equal(created.baselineRevision, initialRevision);
    assert.equal(created.command.expectedRevision, initialRevision);
    assert.equal(created.result.body.mapping.revision, initialRevision + 1);
    assert.notEqual(created.result.body.configurationHash, initial.configurationHash);

    const replay = await putNetSuiteMapping(created.command);
    assert.deepEqual(replay, {
      status: 200,
      body: created.result.body,
      replayed: true
    });

    const updateValueVersion = created.valueVersion + 1;
    const updateCommand = mappingCommand(updateValueVersion, initialRevision + 1);
    const updated = await putNetSuiteMapping(updateCommand);
    assert.equal(updated.status, 200);
    assert.equal(updated.replayed, false);
    assertMapping(updated.body.mapping, updateValueVersion, initialRevision + 2);
    assert.notEqual(updated.body.mapping.mappingId, created.result.body.mapping.mappingId);
    assert.notEqual(updated.body.configurationHash, created.result.body.configurationHash);

    const listed = await listNetSuiteMappings();
    assert.equal(listed.configurationHash, expectedConfigurationHash(listed));
    const requirement = listed.requirements.find(({ checkCode }) => (
      checkCode === SUBSIDIARY_KEY.checkCode
    ));
    assert.ok(requirement);
    assert.deepEqual(requirement.currentMapping, updated.body.mapping);
    assert.equal(requirement.history.length, initialRequirement.history.length + 2);
    assert.deepEqual(
      requirement.history.slice(0, 2).map(({ mappingId, revision, isCurrent }) => ({
        mappingId,
        revision,
        isCurrent
      })),
      [
        {
          mappingId: updated.body.mapping.mappingId,
          revision: initialRevision + 2,
          isCurrent: true
        },
        {
          mappingId: created.result.body.mapping.mappingId,
          revision: initialRevision + 1,
          isCurrent: false
        }
      ]
    );

    const evidence = await query(
      `SELECT
         (SELECT count(*)::int
            FROM mbt_command_receipts
           WHERE actor_operator_id = $1
             AND command_name = 'mbt.netsuite_mapping.put') AS receipts,
         (SELECT count(*)::int
            FROM mbt_audit_events
           WHERE actor_operator_id = $1
             AND entity_type = 'mbt_netsuite_mapping') AS audits`,
      [ACTOR.operatorId]
    );
    assert.deepEqual(evidence.rows[0], { receipts: 2, audits: 2 });

    const audits = await query(
      `SELECT action, reason, revision_before::int AS revision_before,
              revision_after::int AS revision_after, idempotency_key,
              before_state, after_state
         FROM mbt_audit_events
        WHERE actor_operator_id = $1
          AND entity_type = 'mbt_netsuite_mapping'
        ORDER BY revision_after, action, audit_event_id`,
      [ACTOR.operatorId]
    );
    assert.deepEqual(audits.rows.map((row) => ({
      action: row.action,
      reason: row.reason,
      revisionBefore: row.revision_before,
      revisionAfter: row.revision_after,
      idempotencyKey: row.idempotency_key
    })), [
      {
        action: initialRevision === 0
          ? "mbt.netsuite_mapping.created"
          : "mbt.netsuite_mapping.updated",
        reason: created.command.reason,
        revisionBefore: initialRevision || 1,
        revisionAfter: initialRevision + 1,
        idempotencyKey: created.command.idempotencyKey
      },
      {
        action: "mbt.netsuite_mapping.updated",
        reason: updateCommand.reason,
        revisionBefore: initialRevision + 1,
        revisionAfter: initialRevision + 2,
        idempotencyKey: updateCommand.idempotencyKey
      }
    ]);
    if (initialRevision === 0) {
      assert.deepEqual(audits.rows[0].before_state, {});
    } else {
      assert.equal(audits.rows[0].before_state.revision, initialRevision);
    }
    assert.equal(audits.rows[0].after_state.revision, initialRevision + 1);
    assert.equal(audits.rows[1].before_state.revision, initialRevision + 1);
    assert.equal(audits.rows[1].after_state.revision, initialRevision + 2);
  });
});

test("P2-R3/P2-R4: mappings accept only strategy allowlisted record types and reject credential-shaped configuration", async () => {
  await inRollback(async () => {
    const listed = await listNetSuiteMappings();
    const item = listed.requirements.find(({ checkCode }) => checkCode === "item_initial_service");
    assert.ok(item);
    const subsidiary = listed.requirements.find(({ checkCode }) => checkCode === "mbt_subsidiary");
    assert.ok(subsidiary);
    await putNetSuiteMapping({
      actor: ACTOR,
      mappingType: subsidiary.mappingType,
      localKey: subsidiary.localKey,
      expectedRevision: subsidiary.currentMapping?.revision || 0,
      reason: "Establish the MBT subsidiary before validating subsidiary-scoped item types.",
      ...identity("allowlisted-record-type-subsidiary"),
      mapping: semanticMappingFixture("mbt_subsidiary")
    });
    assert.equal(item.expectedRecordType, "sales_order_item");
    assert.ok(item.allowedRecordTypes.includes("servicesaleitem"));
    const currentRevision = item.currentMapping?.revision || 0;
    const base = {
      actor: ACTOR,
      mappingType: item.mappingType,
      localKey: item.localKey,
      expectedRevision: currentRevision,
      reason: "Use an official allowlisted Record REST item type.",
      ...identity("allowlisted-record-type")
    };
    const accepted = await putNetSuiteMapping({
      ...base,
      mapping: {
        externalId: "12345",
        externalScriptId: null,
        externalName: "P2 service item",
        externalRecordType: "servicesaleitem",
        subsidiaryNetSuiteId: 5,
        configuration: {
          expected: { subsidiaryIds: ["5"] },
          caseInsensitiveFields: []
        },
        active: true
      }
    });
    assert.equal(accepted.body.mapping.externalRecordType, "servicesaleitem");

    await assert.rejects(
      () => putNetSuiteMapping({
        ...base,
        expectedRevision: accepted.body.mapping.revision,
        ...identity("disallowed-record-type"),
        mapping: {
          ...accepted.body.mapping,
          externalRecordType: "inventoryItem"
        }
      }),
      (error) => error instanceof MbtError
        && error.status === 400
        && error.code === "MBT_NETSUITE_MAPPING_RECORD_TYPE_INVALID"
    );

    await assert.rejects(
      () => putNetSuiteMapping({
        actor: ACTOR,
        mappingType: subsidiary.mappingType,
        localKey: subsidiary.localKey,
        expectedRevision: subsidiary.currentMapping?.revision || 0,
        reason: "Credential-bearing metadata must fail closed.",
        ...identity("secret-configuration"),
        mapping: {
          externalId: "5",
          externalScriptId: null,
          externalName: "MBT",
          externalRecordType: "subsidiary",
          subsidiaryNetSuiteId: 5,
          configuration: {
            expected: { baseCurrency: "CAD" },
            credentials: { clientSecret: "must-not-be-stored" }
          },
          active: true
        }
      }),
      (error) => error instanceof MbtError
        && error.status === 400
        && error.code === "MBT_NETSUITE_MAPPING_CONFIGURATION_INVALID"
    );

    const customField = listed.requirements.find(({ checkCode }) => (
      checkCode === "custom_field_local_contract_uuid"
    ));
    assert.ok(customField);
    await assert.rejects(
      () => putNetSuiteMapping({
        actor: ACTOR,
        mappingType: customField.mappingType,
        localKey: customField.localKey,
        expectedRevision: customField.currentMapping?.revision || 0,
        reason: "Unsafe metadata script IDs must fail before a preflight request.",
        ...identity("unsafe-script-id"),
        mapping: {
          externalId: "salesOrder",
          externalScriptId: "custbody_mbt field?expand=true",
          externalName: "Local contract UUID",
          externalRecordType: "salesOrder",
          subsidiaryNetSuiteId: null,
          configuration: { expected: { fieldType: "TEXT" } },
          active: true
        }
      }),
      (error) => error instanceof MbtError
        && error.status === 400
        && error.code === "MBT_NETSUITE_MAPPING_SCRIPT_ID_INVALID"
    );

    const invalidConfigurations = [
      { source: "raw_payload", expected: { baseCurrency: "CAD" } },
      { expected: { unrestrictedRemoteBranch: "must-not-persist" } },
      { expected: { name: "Bearer abcdefghijklmnopqrstuvwxyz" } },
      { expected: { baseCurrency: "CAD" }, caseInsensitiveFields: ["notExpected"] },
      { expected: { baseCurrency: { id: "1", raw: true } } }
    ];
    for (let index = 0; index < invalidConfigurations.length; index += 1) {
      await assert.rejects(
        () => putNetSuiteMapping({
          actor: ACTOR,
          mappingType: subsidiary.mappingType,
          localKey: subsidiary.localKey,
          expectedRevision: subsidiary.currentMapping?.revision || 0,
          reason: `Reject invalid semantic verification configuration ${index}`,
          ...identity(`invalid-semantic-configuration-${index}`),
          mapping: {
            externalId: "5",
            externalScriptId: null,
            externalName: "MBT",
            externalRecordType: "subsidiary",
            subsidiaryNetSuiteId: 5,
            configuration: invalidConfigurations[index],
            active: true
          }
        }),
        (error) => error instanceof MbtError
          && error.status === 400
          && error.code === "MBT_NETSUITE_MAPPING_CONFIGURATION_INVALID",
        JSON.stringify(invalidConfigurations[index])
      );
    }
  });
});

test("P2-R6: every required semantic field is mandatory at mapping persistence", async (t) => {
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

  for (const [checkCode, requiredFields] of cases) {
    for (const missingField of requiredFields) {
      await t.test(`${checkCode} requires ${missingField}`, async () => {
        await inRollback(async () => {
          const listed = await listNetSuiteMappings();
          const requirement = listed.requirements.find((candidate) => (
            candidate.checkCode === checkCode
          ));
          assert.ok(requirement);
          const mapping = semanticMappingFixture(checkCode);
          delete mapping.configuration.expected[missingField];
          mapping.configuration.caseInsensitiveFields = (
            mapping.configuration.caseInsensitiveFields || []
          ).filter((field) => field !== missingField);

          await assert.rejects(
            () => putNetSuiteMapping({
              actor: ACTOR,
              mappingType: requirement.mappingType,
              localKey: requirement.localKey,
              mapping,
              expectedRevision: requirement.currentMapping?.revision || 0,
              reason: `Reject incomplete ${checkCode} semantics without ${missingField}.`,
              ...identity(`required-${checkCode}-${missingField}`)
            }),
            (error) => error instanceof MbtError
              && error.status === 400
              && error.code === "MBT_NETSUITE_MAPPING_CONFIGURATION_INVALID"
              && error.message.includes(missingField)
              && error.message.length <= 240
          );
        });
      });
    }
  }
});

test("P2-R6: identity, currency, type, and name semantics cannot be null", async (t) => {
  const cases = [
    ["mbt_subsidiary", "legalName"],
    ["mbt_subsidiary", "baseCurrency"],
    ["customer_33", "entityId"],
    ["customer_33", "companyName"],
    ["customer_33", "currencyId"],
    ["customer_33", "creditHold"],
    ["custom_field_local_contract_uuid", "fieldType"],
    ["account_transport_revenue", "accountType"],
    ["account_transport_revenue", "name"]
  ];
  for (const [checkCode, field] of cases) {
    await t.test(`${checkCode} rejects null ${field}`, async () => {
      await inRollback(async () => {
        const listed = await listNetSuiteMappings();
        const requirement = listed.requirements.find((candidate) => (
          candidate.checkCode === checkCode
        ));
        assert.ok(requirement);
        const mapping = semanticMappingFixture(checkCode);
        mapping.configuration.expected[field] = null;
        await assert.rejects(
          () => putNetSuiteMapping({
            actor: ACTOR,
            mappingType: requirement.mappingType,
            localKey: requirement.localKey,
            mapping,
            expectedRevision: requirement.currentMapping?.revision || 0,
            reason: `Reject null required ${checkCode} ${field}.`,
            ...identity(`null-required-${checkCode}-${field}`)
          }),
          (error) => error instanceof MbtError
            && error.code === "MBT_NETSUITE_MAPPING_CONFIGURATION_INVALID"
            && error.message.includes(field)
        );
      });
    });
  }
});

test("P2-R6: customer and item mappings require an explicit dedicated subsidiary ID", async (t) => {
  for (const checkCode of ["customer_33", "item_initial_service"]) {
    await t.test(checkCode, async () => {
      await inRollback(async () => {
        const listed = await listNetSuiteMappings();
        const requirement = listed.requirements.find((candidate) => (
          candidate.checkCode === checkCode
        ));
        assert.ok(requirement);
        const mapping = semanticMappingFixture(checkCode);
        mapping.subsidiaryNetSuiteId = null;

        await assert.rejects(
          () => putNetSuiteMapping({
            actor: ACTOR,
            mappingType: requirement.mappingType,
            localKey: requirement.localKey,
            mapping,
            expectedRevision: requirement.currentMapping?.revision || 0,
            reason: `Reject ${checkCode} without a dedicated MBT subsidiary ID.`,
            ...identity(`subsidiary-required-${checkCode}`)
          }),
          (error) => error instanceof MbtError
            && error.status === 400
            && error.code === "MBT_NETSUITE_MAPPING_SUBSIDIARY_REQUIRED"
            && /subsidiary/i.test(error.message)
            && error.message.length <= 240
        );
      });
    });
  }
});

test("P2-R6: customer and item subsidiary IDs must equal the current MBT subsidiary mapping", async (t) => {
  for (const checkCode of ["customer_33", "item_initial_service"]) {
    await t.test(checkCode, async () => {
      await inRollback(async () => {
        const initial = await listNetSuiteMappings();
        const subsidiary = initial.requirements.find(({ checkCode: code }) => (
          code === "mbt_subsidiary"
        ));
        assert.ok(subsidiary);
        await putNetSuiteMapping({
          actor: ACTOR,
          mappingType: subsidiary.mappingType,
          localKey: subsidiary.localKey,
          mapping: semanticMappingFixture("mbt_subsidiary"),
          expectedRevision: subsidiary.currentMapping?.revision || 0,
          reason: "Establish the current MBT subsidiary identity for semantic validation.",
          ...identity(`subsidiary-baseline-${checkCode}`)
        });

        const listed = await listNetSuiteMappings();
        const requirement = listed.requirements.find((candidate) => (
          candidate.checkCode === checkCode
        ));
        assert.ok(requirement);
        const mapping = semanticMappingFixture(checkCode);
        mapping.subsidiaryNetSuiteId = 7;
        await assert.rejects(
          () => putNetSuiteMapping({
            actor: ACTOR,
            mappingType: requirement.mappingType,
            localKey: requirement.localKey,
            mapping,
            expectedRevision: requirement.currentMapping?.revision || 0,
            reason: `Reject ${checkCode} for the wrong subsidiary.`,
            ...identity(`subsidiary-mismatch-${checkCode}`)
          }),
          (error) => error instanceof MbtError
            && error.status === 400
            && error.code === "MBT_NETSUITE_MAPPING_SUBSIDIARY_MISMATCH"
            && /subsidiary/i.test(error.message)
            && error.message.length <= 240
        );
      });
    });
  }
});

test("P2-R4: repository mapping and runtime boundaries fail closed without durable evidence", async () => {
  await inRollback(async () => {
    const listed = await listNetSuiteMappings();
    const subsidiary = listed.requirements.find(({ checkCode }) => checkCode === "mbt_subsidiary");
    assert.ok(subsidiary);
    const baselineRevision = subsidiary.currentMapping?.revision || 0;
    const validMapping = {
      externalId: `boundary-${RUN_ID}`,
      externalScriptId: null,
      externalName: "P2 boundary fixture",
      externalRecordType: "subsidiary",
      subsidiaryNetSuiteId: 5,
      configuration: {
        expected: { baseCurrency: "CAD", legalName: "P2 boundary fixture" }
      },
      active: true
    };
    const command = (label, overrides = {}) => ({
      actor: ACTOR,
      mappingType: subsidiary.mappingType,
      localKey: subsidiary.localKey,
      mapping: validMapping,
      expectedRevision: baselineRevision,
      reason: `P2 fail-closed boundary ${label}`,
      ...identity(`boundary-${label}`),
      ...overrides
    });

    await assert.rejects(
      () => putNetSuiteMapping(command("missing-role", {
        actor: { operatorId: ACTOR.operatorId }
      })),
      (error) => error instanceof MbtError
        && error.status === 403
        && error.code === "MBT_ADMIN_REQUIRED"
    );
    await assert.rejects(
      () => putNetSuiteMapping(command("missing-type", { mappingType: undefined })),
      /NetSuite mapping type is required/
    );
    await assert.rejects(
      () => putNetSuiteMapping(command("unknown-requirement", {
        mappingType: "subsidiary",
        localKey: "not_in_server_catalog"
      })),
      (error) => error instanceof MbtError
        && error.status === 404
        && error.code === "MBT_NETSUITE_MAPPING_REQUIREMENT_NOT_FOUND"
    );
    await assert.rejects(
      () => putNetSuiteMapping(command("array-mapping", { mapping: [] })),
      /NetSuite mapping must be an object/
    );
    await assert.rejects(
      () => putNetSuiteMapping(command("invalid-revision", { expectedRevision: -1 })),
      (error) => error instanceof MbtError
        && error.status === 400
        && error.code === "MBT_REVISION_REQUIRED"
    );
    await assert.rejects(
      () => putNetSuiteMapping(command("invalid-active", {
        mapping: { ...validMapping, active: "true" }
      })),
      /active state must be boolean/
    );

    await assert.rejects(
      () => putNetSuiteMapping(command("array-configuration", {
        mapping: { ...validMapping, configuration: [] }
      })),
      /NetSuite mapping configuration must be an object/
    );
    const invalidConfigurations = [
      { expected: { subsidiaryIds: Array.from({ length: 101 }, () => "5") } },
      { expected: { name: "x".repeat(33 * 1024) } },
      { expected: { name: [[[[[[[[[["too-deep"]]]]]]]]]] } },
      {
        expected: { baseCurrency: "CAD" },
        caseInsensitiveFields: ["legalName"]
      }
    ];
    for (let index = 0; index < invalidConfigurations.length; index += 1) {
      await assert.rejects(
        () => putNetSuiteMapping(command(`invalid-shape-${index}`, {
          mapping: { ...validMapping, configuration: invalidConfigurations[index] }
        })),
        (error) => error instanceof MbtError
          && error.status === 400
          && error.code === "MBT_NETSUITE_MAPPING_CONFIGURATION_INVALID",
        `configuration ${index} must fail closed`
      );
    }
    await assert.rejects(
      () => putNetSuiteMapping(command("non-json-number", {
        mapping: {
          ...validMapping,
          configuration: { expected: { baseCurrencyId: Number.POSITIVE_INFINITY } }
        }
      })),
      /Canonical JSON accepts only JSON values/
    );

    const defaults = await putNetSuiteMapping(command("safe-defaults", {
      mapping: {
        externalId: `defaults-${RUN_ID}`,
        externalRecordType: "subsidiary",
        configuration: {
          expected: { baseCurrency: "CAD", legalName: "P2 defaults fixture" }
        },
        active: true
      }
    }));
    assert.equal(defaults.body.mapping.externalName, "");
    assert.equal(defaults.body.mapping.subsidiaryNetSuiteId, null);
    assert.deepEqual(defaults.body.mapping.configuration, {
      expected: { baseCurrency: "CAD", legalName: "P2 defaults fixture" }
    });

    const numericExpected = await putNetSuiteMapping(command("finite-number", {
      expectedRevision: defaults.body.mapping.revision,
      mapping: {
        ...validMapping,
        externalId: `numeric-${RUN_ID}`,
        configuration: {
          expected: {
            baseCurrency: "CAD",
            legalName: "P2 boundary fixture",
            baseCurrencyId: 1
          }
        }
      }
    }));
    assert.deepEqual(numericExpected.body.mapping.configuration, {
      expected: {
        baseCurrency: "CAD",
        legalName: "P2 boundary fixture",
        baseCurrencyId: 1
      }
    });

    const noRuntime = await getCurrentNetSuiteReadiness();
    assert.equal(noRuntime.ready, false);
    assert.equal(noRuntime.run, null);
    const malformedRuntime = await getCurrentNetSuiteReadiness({
      ...NETSUITE_RUNTIME,
      restBaseUrl: "not-a-url"
    });
    assert.equal(malformedRuntime.run, null);
    const insecureRuntime = await getCurrentNetSuiteReadiness({
      ...NETSUITE_RUNTIME,
      restBaseUrl: "http://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1"
    });
    assert.equal(insecureRuntime.run, null);

    await assert.rejects(
      () => claimNetSuitePreflightRun({ ...claimInput("missing-runtime-url"), restBaseUrl: undefined }),
      /NetSuite REST base URL/
    );
    await assert.rejects(
      () => claimNetSuitePreflightRun({ ...claimInput("invalid-lease"), leaseSeconds: 0 }),
      /positive safe integer/
    );
    await assert.rejects(
      () => claimNetSuitePreflightRun({
        ...claimInput("production-adapter"),
        adapterKind: "read_only_production"
      }),
      (error) => error instanceof MbtError
        && error.status === 409
        && error.code === "MBT_NETSUITE_SANDBOX_REQUIRED"
    );

    const evidence = await query(
      `SELECT
         (SELECT count(*)::int
            FROM mbt_command_receipts
           WHERE actor_operator_id = $1
             AND command_name = 'mbt.netsuite_mapping.put') AS receipts,
         (SELECT count(*)::int
            FROM mbt_audit_events
           WHERE actor_operator_id = $1
             AND entity_type = 'mbt_netsuite_mapping') AS audits`,
      [ACTOR.operatorId]
    );
    assert.deepEqual(evidence.rows, [{ receipts: 2, audits: 2 }]);
  });
});

test("P2-R3/P2-R4: catalog strategy defaults and required runtime identity stay fail closed", async () => {
  await inRollback(async () => {
    const listed = await listNetSuiteMappings();
    const byCode = (checkCode) => {
      const found = listed.requirements.find((requirement) => requirement.checkCode === checkCode);
      assert.ok(found, `Missing server-owned requirement ${checkCode}.`);
      return found;
    };
    const putRequirement = (requirement, label, mapping) => putNetSuiteMapping({
      actor: ACTOR,
      mappingType: requirement.mappingType,
      localKey: requirement.localKey,
      mapping,
      expectedRevision: requirement.currentMapping?.revision || 0,
      reason: `Exercise the ${label} server-owned read strategy.`,
      ...identity(`strategy-${label}`)
    });

    const transactionForm = byCode("customer_sales_order_form");
    const formMapping = await putRequirement(transactionForm, "local-form", {
      externalId: `form-${RUN_ID}`,
      externalScriptId: null,
      externalName: "Customer Sales Order form",
      externalRecordType: transactionForm.expectedRecordType,
      subsidiaryNetSuiteId: null,
      configuration: {},
      active: true
    });
    assert.equal(formMapping.body.mapping.externalRecordType, "sales_order_form");

    const customField = byCode("custom_field_local_contract_uuid");
    const metadataMapping = await putRequirement(customField, "metadata-catalog", {
      externalId: "salesOrder",
      externalScriptId: "custbody_mbt_contract_uuid",
      externalName: "Local contract UUID",
      externalRecordType: "salesOrder",
      subsidiaryNetSuiteId: null,
      configuration: {
        expected: { fieldType: "string" },
        caseInsensitiveFields: ["scriptId"]
      },
      active: true
    });
    assert.equal(metadataMapping.body.mapping.externalScriptId, "custbody_mbt_contract_uuid");

    const subsidiary = byCode("mbt_subsidiary");
    await assert.rejects(
      () => putRequirement(subsidiary, "array-expected-evidence", {
        externalId: "5",
        externalScriptId: null,
        externalName: "MBT",
        externalRecordType: "subsidiary",
        subsidiaryNetSuiteId: 5,
        configuration: { expected: [] },
        active: true
      }),
      (error) => error instanceof MbtError
        && error.status === 400
        && error.code === "MBT_NETSUITE_MAPPING_CONFIGURATION_INVALID"
    );
    await assert.rejects(
      () => claimNetSuitePreflightRun({
        ...claimInput("insecure-required-runtime"),
        restBaseUrl: "http://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1"
      }),
      /must be an HTTPS URL/
    );
    await assert.rejects(
      () => claimNetSuitePreflightRun({
        ...claimInput("incomplete-required-runtime"),
        adapterKind: ""
      }),
      /complete NetSuite readiness runtime identity/
    );
  });
});

test("P2-F03: an active lease blocks overlap, expiry recovers evidence, and unverifiable completion is terminal", async () => {
  await inRollback(async () => {
    await createMapping();
    const abandoned = await claimNetSuitePreflightRun(claimInput("lease-abandoned"));
    await assert.rejects(
      () => claimNetSuitePreflightRun(claimInput("lease-overlap")),
      (error) => error instanceof MbtError
        && error.status === 409
        && error.code === "MBT_NETSUITE_PREFLIGHT_RUNNING"
    );

    await query(
      `UPDATE mbt_netsuite_preflight_runs
          SET lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE preflight_run_id = $1`,
      [abandoned.preflightRunId]
    );
    const recovered = await claimNetSuitePreflightRun(claimInput("lease-recovered"));
    assert.equal(recovered.recoveredRunId, abandoned.preflightRunId);

    const abandonedDetail = await getNetSuitePreflightRun(
      abandoned.preflightRunId,
      NETSUITE_RUNTIME
    );
    assert.equal(abandonedDetail.run.status, "unable_to_verify");
    assert.equal(abandonedDetail.run.errorCode, "MBT_NETSUITE_PREFLIGHT_LEASE_EXPIRED");
    assert.match(abandonedDetail.run.errorMessage, /lease expired/i);
    assert.equal(abandonedDetail.checks.length, abandoned.requirements.length);
    assert.ok(abandonedDetail.checks.every((check) => check.observed === null));

    const checks = passingChecks(recovered);
    checks[0] = {
      checkCode: checks[0].checkCode,
      status: "unable_to_verify",
      message: "The sandbox read could not be verified."
    };
    const completed = await completeNetSuitePreflightRun({
      preflightRunId: recovered.preflightRunId,
      leaseToken: recovered.leaseToken,
      checks
    });
    assert.equal(completed.status, "unable_to_verify");

    await assert.rejects(
      () => completeNetSuitePreflightRun({
        preflightRunId: recovered.preflightRunId,
        leaseToken: recovered.leaseToken,
        checks
      }),
      (error) => error instanceof MbtError
        && error.status === 409
        && error.code === "MBT_NETSUITE_PREFLIGHT_ALREADY_COMPLETED"
    );
    const completedDetail = await getNetSuitePreflightRun(
      recovered.preflightRunId,
      NETSUITE_RUNTIME
    );
    assert.equal(completedDetail.run.errorCode, "MBT_NETSUITE_PREFLIGHT_UNABLE_TO_VERIFY");
    assert.match(completedDetail.run.errorMessage, /did not pass/i);
    assert.equal(completedDetail.checks[0].observed, null);
  });
});

test("P2-F03/P2-F04: malformed completion, lookup, lease, and duplicate signoff paths fail closed", async () => {
  await inRollback(async () => {
    await createMapping();
    const claim = await claimNetSuitePreflightRun(claimInput("completion-boundaries"));
    const validChecks = passingChecks(claim);

    const running = await getNetSuitePreflightRun(claim.preflightRunId, NETSUITE_RUNTIME);
    assert.equal(running.run.status, "running");
    assert.equal(running.run.completedAt, null);

    await assert.rejects(
      () => completeNetSuitePreflightRun({
        preflightRunId: claim.preflightRunId,
        leaseToken: claim.leaseToken,
        checks: null
      }),
      /Preflight checks must be an array/
    );
    await assert.rejects(
      () => completeNetSuitePreflightRun({
        preflightRunId: claim.preflightRunId,
        leaseToken: claim.leaseToken,
        checks: validChecks.map((check, index) => (
          index === 0 ? { ...check, status: "unexpected" } : check
        ))
      }),
      /Unsupported preflight check status/
    );
    await assert.rejects(
      () => completeNetSuitePreflightRun({
        preflightRunId: claim.preflightRunId,
        leaseToken: claim.leaseToken,
        checks: validChecks.map((check, index) => (
          index === 1 ? { ...check, checkCode: validChecks[0].checkCode } : check
        ))
      }),
      /Duplicate preflight check code/
    );
    await assert.rejects(
      () => completeNetSuitePreflightRun({
        preflightRunId: claim.preflightRunId,
        leaseToken: claim.leaseToken,
        checks: validChecks.slice(1)
      }),
      /every server-owned preflight requirement exactly once/
    );
    await assert.rejects(
      () => completeNetSuitePreflightRun({
        preflightRunId: claim.preflightRunId,
        leaseToken: claim.leaseToken,
        checks: validChecks.map((check, index) => (
          index === validChecks.length - 1
            ? { ...check, checkCode: "unknown_server_check" }
            : check
        ))
      }),
      /Missing preflight check/
    );
    await assert.rejects(
      () => completeNetSuitePreflightRun({
        preflightRunId: claim.preflightRunId,
        leaseToken: claim.leaseToken,
        checks: validChecks.map((check, index) => (
          index === 0 ? { ...check, status: "not_applicable" } : check
        ))
      }),
      /Required preflight check cannot be not_applicable/
    );
    await assert.rejects(
      () => completeNetSuitePreflightRun({
        preflightRunId: crypto.randomUUID(),
        leaseToken: claim.leaseToken,
        checks: validChecks
      }),
      (error) => error instanceof MbtError
        && error.status === 404
        && error.code === "MBT_NETSUITE_PREFLIGHT_NOT_FOUND"
    );
    await assert.rejects(
      () => completeNetSuitePreflightRun({
        preflightRunId: claim.preflightRunId,
        leaseToken: crypto.randomUUID(),
        checks: validChecks
      }),
      (error) => error instanceof MbtError
        && error.status === 409
        && error.code === "MBT_NETSUITE_PREFLIGHT_LEASE_INVALID"
    );

    await completeNetSuitePreflightRun({
      preflightRunId: claim.preflightRunId,
      leaseToken: claim.leaseToken,
      checks: validChecks
    });

    const missingRunId = crypto.randomUUID();
    await assert.rejects(
      () => getNetSuitePreflightRun(missingRunId, NETSUITE_RUNTIME),
      (error) => error instanceof MbtError
        && error.status === 404
        && error.code === "MBT_NETSUITE_PREFLIGHT_NOT_FOUND"
    );
    await assert.rejects(
      () => getNetSuitePreflightRun("not-a-uuid", NETSUITE_RUNTIME),
      (error) => error instanceof MbtError
        && error.status === 400
        && error.code === "MBT_NETSUITE_PREFLIGHT_RUN_INVALID"
    );
    await assert.rejects(
      () => signoffNetSuitePreflightRun({
        actor: ACTOR,
        preflightRunId: missingRunId,
        reason: "Unknown preflight runs cannot be signed.",
        runtime: NETSUITE_RUNTIME,
        ...identity("unknown-run-signoff")
      }),
      (error) => error instanceof MbtError
        && error.status === 404
        && error.code === "MBT_NETSUITE_PREFLIGHT_NOT_FOUND"
    );

    const signed = await signoff({ claim }, "completion-boundaries");
    await assert.rejects(
      () => signoffNetSuitePreflightRun({
        actor: ACTOR,
        preflightRunId: claim.preflightRunId,
        reason: "A second signoff must be rejected even with a new command identity.",
        runtime: NETSUITE_RUNTIME,
        ...identity("duplicate-signoff")
      }),
      (error) => error instanceof MbtError
        && error.status === 409
        && error.code === "MBT_NETSUITE_PREFLIGHT_ALREADY_SIGNED"
    );
    assert.ok(signed.result.body.signoff.signoffId);

    const unrelatedRuntime = await getCurrentNetSuiteReadiness({
      ...NETSUITE_RUNTIME,
      accountId: "7654321_SB1",
      restBaseUrl: "https://7654321-sb1.suitetalk.api.netsuite.com/services/rest/record/v1"
    });
    assert.equal(unrelatedRuntime.ready, false);
    assert.equal(unrelatedRuntime.run, null);
  });
});

test("P2-F02: stale revision and changed-payload retry are stable 409s with no durable mutation", async () => {
  await inRollback(async () => {
    const created = await createMapping();
    const createdRevision = created.result.body.mapping.revision;
    const successfulValueVersion = created.valueVersion + 1;
    const successfulUpdate = mappingCommand(successfulValueVersion, createdRevision);
    await putNetSuiteMapping(successfulUpdate);
    const before = await query(
      `SELECT
         (SELECT count(*)::int FROM mbt_netsuite_mappings
           WHERE mapping_type = $1 AND local_key = $2) AS mappings,
         (SELECT count(*)::int FROM mbt_audit_events
           WHERE actor_operator_id = $3) AS audits,
         (SELECT count(*)::int FROM mbt_command_receipts
           WHERE actor_operator_id = $3) AS receipts`,
      [SUBSIDIARY_KEY.mappingType, SUBSIDIARY_KEY.localKey, ACTOR.operatorId]
    );

    const stale = mappingCommand(successfulValueVersion + 1, createdRevision);
    await assert.rejects(
      () => putNetSuiteMapping(stale),
      (error) => error instanceof MbtError
        && error.status === 409
        && error.code === "MBT_STALE_REVISION"
    );
    const changedRetry = {
      ...created.command,
      mapping: mappingValues(99)
    };
    await assert.rejects(
      () => putNetSuiteMapping(changedRetry),
      (error) => error instanceof MbtError
        && error.status === 409
        && error.code === "MBT_IDEMPOTENCY_CONFLICT"
    );

    const afterEvidence = await query(
      `SELECT
         (SELECT count(*)::int FROM mbt_netsuite_mappings
           WHERE mapping_type = $1 AND local_key = $2) AS mappings,
         (SELECT count(*)::int FROM mbt_audit_events
           WHERE actor_operator_id = $3) AS audits,
         (SELECT count(*)::int FROM mbt_command_receipts
           WHERE actor_operator_id = $3) AS receipts`,
      [SUBSIDIARY_KEY.mappingType, SUBSIDIARY_KEY.localKey, ACTOR.operatorId]
    );
    assert.deepEqual(afterEvidence.rows[0], before.rows[0]);
    const current = await query(
      `SELECT external_id, revision::int AS revision
         FROM mbt_netsuite_mappings
        WHERE mapping_type = $1 AND local_key = $2 AND is_current`,
      [SUBSIDIARY_KEY.mappingType, SUBSIDIARY_KEY.localKey]
    );
    assert.deepEqual(current.rows, [{
      external_id: mappingValues(successfulValueVersion).externalId,
      revision: createdRevision + 1
    }]);
  });
});

test("P2-F03: completion atomically persists one ordered result for every server-owned requirement", async () => {
  await inRollback(async () => {
    await createMapping();
    const run = await createPassingRun("complete");
    assert.deepEqual(run.completed.counts, {
      required: run.claim.requirements.filter(({ required }) => required).length,
      passedRequired: run.claim.requirements.filter(({ required }) => required).length,
      failedRequired: 0,
      optional: run.claim.requirements.filter(({ required }) => !required).length,
      passedOptional: run.claim.requirements.filter(({ required }) => !required).length
    });

    const persistedRun = await query(
      `SELECT configuration_hash, mapping_snapshot, adapter_kind, account_id,
              environment_name, status, required_check_count::int,
              passed_required_count::int, failed_required_count::int,
              optional_check_count::int, passed_optional_count::int,
              lease_token, lease_owner, lease_expires_at, completed_at
         FROM mbt_netsuite_preflight_runs
        WHERE preflight_run_id = $1`,
      [run.claim.preflightRunId]
    );
    assert.equal(persistedRun.rowCount, 1);
    assert.equal(persistedRun.rows[0].configuration_hash, run.claim.configurationHash);
    assert.deepEqual(persistedRun.rows[0].mapping_snapshot, run.claim.mappings);
    assert.equal(persistedRun.rows[0].adapter_kind, "read_only_sandbox");
    assert.equal(persistedRun.rows[0].account_id, run.claim.accountId);
    assert.equal(persistedRun.rows[0].environment_name, run.claim.environmentName);
    assert.equal(persistedRun.rows[0].status, "passed");
    assert.equal(persistedRun.rows[0].lease_token, null);
    assert.equal(persistedRun.rows[0].lease_owner, null);
    assert.equal(persistedRun.rows[0].lease_expires_at, null);
    assert.ok(persistedRun.rows[0].completed_at);

    const checks = await query(
      `SELECT sequence_number::int, check_type, required, severity,
              mapping_type, local_key, expected_snapshot, observed_snapshot,
              status, message
         FROM mbt_netsuite_preflight_checks
        WHERE preflight_run_id = $1
        ORDER BY sequence_number`,
      [run.claim.preflightRunId]
    );
    assert.equal(checks.rowCount, run.claim.requirements.length);
    assert.deepEqual(
      checks.rows.map(({ sequence_number: sequenceNumber, check_type: checkCode }) => ({
        sequenceNumber,
        checkCode
      })),
      run.claim.requirements.map(({ checkCode }, index) => ({ sequenceNumber: index, checkCode }))
    );
    for (let index = 0; index < checks.rows.length; index += 1) {
      const stored = checks.rows[index];
      const requirement = run.claim.requirements[index];
      assert.equal(stored.required, requirement.required);
      assert.equal(stored.severity, requirement.severity);
      assert.equal(stored.mapping_type, requirement.mappingType);
      assert.equal(stored.local_key, requirement.localKey);
      assert.deepEqual(stored.expected_snapshot, expectedSnapshot(requirement, run.claim.mappings));
      assert.equal(stored.status, "passed");
      assert.deepEqual(stored.observed_snapshot, {
        active: true,
        fixture: `p2-db-observed-${requirement.checkCode}`
      });
      assert.match(stored.message, /^Verified /);
    }

    const detail = await getNetSuitePreflightRun(run.claim.preflightRunId, NETSUITE_RUNTIME);
    assert.deepEqual(Object.keys(detail).sort(), ["checks", "current", "run", "signoff"]);
    assert.equal(detail.current, true);
    assert.equal(detail.run.preflightRunId, run.claim.preflightRunId);
    assert.equal(detail.run.status, "passed");
    assert.equal(detail.checks.length, run.claim.requirements.length);
    assert.equal(detail.signoff, null);
  });
});

test("P2-F04: a current pass signs off once; a mapping revision immediately invalidates readiness", async () => {
  await inRollback(async () => {
    const mapping = await createMapping();
    const run = await createPassingRun("signoff-current");
    await assert.rejects(
      () => signoffNetSuitePreflightRun({
        actor: ACTOR,
        preflightRunId: run.claim.preflightRunId,
        reason: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        runtime: NETSUITE_RUNTIME,
        ...identity("secret-signoff-note")
      }),
      (error) => error instanceof MbtError
        && error.status === 400
        && error.code === "MBT_EVIDENCE_TEXT_INVALID"
    );
    const changedRuntime = {
      ...NETSUITE_RUNTIME,
      restBaseUrl: "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1-alt"
    };
    const wrongRuntimeReadiness = await getCurrentNetSuiteReadiness(changedRuntime);
    assert.equal(wrongRuntimeReadiness.ready, false);
    assert.equal(wrongRuntimeReadiness.run.current, false);
    await assert.rejects(
      () => signoffNetSuitePreflightRun({
        actor: ACTOR,
        preflightRunId: run.claim.preflightRunId,
        reason: "A different REST root must not reuse readiness.",
        runtime: changedRuntime,
        ...identity("wrong-runtime-signoff")
      }),
      (error) => error instanceof MbtError
        && error.status === 409
        && error.code === "MBT_NETSUITE_PREFLIGHT_RUNTIME_NOT_CURRENT"
    );
    const signed = await signoff(run, "current-pass");
    const replay = await signoffNetSuitePreflightRun({
      actor: ACTOR,
      preflightRunId: run.claim.preflightRunId,
      reason: signed.result.body.signoff.auditNote,
      runtime: NETSUITE_RUNTIME,
      ...signed.command
    });
    assert.deepEqual(replay, {
      status: 200,
      body: signed.result.body,
      replayed: true
    });

    const current = await getCurrentNetSuiteReadiness(NETSUITE_RUNTIME);
    assert.deepEqual(Object.keys(current).sort(), [
      "currentConfigurationHash",
      "ready",
      "run",
      "signoff"
    ]);
    assert.equal(current.ready, true);
    assert.equal(current.currentConfigurationHash, run.claim.configurationHash);
    assert.equal(current.run.preflightRunId, run.claim.preflightRunId);
    assert.equal(current.run.current, true);
    assert.equal(current.signoff.signoffId, signed.result.body.signoff.signoffId);
    assert.equal(current.signoff.current, true);

    await putNetSuiteMapping(mappingCommand(
      mapping.valueVersion + 1,
      mapping.result.body.mapping.revision
    ));
    const invalidated = await getCurrentNetSuiteReadiness(NETSUITE_RUNTIME);
    assert.equal(invalidated.ready, false);
    assert.notEqual(invalidated.currentConfigurationHash, run.claim.configurationHash);
    assert.equal(invalidated.run.preflightRunId, run.claim.preflightRunId);
    assert.equal(invalidated.run.current, false);
    assert.equal(invalidated.signoff.signoffId, signed.result.body.signoff.signoffId);
    assert.equal(invalidated.signoff.current, false);

    const staleReplay = await signoffNetSuitePreflightRun({
      actor: ACTOR,
      preflightRunId: run.claim.preflightRunId,
      reason: signed.result.body.signoff.auditNote,
      runtime: NETSUITE_RUNTIME,
      ...signed.command
    });
    assert.equal(staleReplay.replayed, true);
    assert.equal(staleReplay.body.signoff.signoffId, signed.result.body.signoff.signoffId);
    assert.equal(staleReplay.body.signoff.current, false);

    const retained = await getNetSuitePreflightRun(run.claim.preflightRunId, NETSUITE_RUNTIME);
    assert.equal(retained.current, false);
    assert.equal(retained.run.status, "passed");
    assert.equal(retained.signoff.signoffId, signed.result.body.signoff.signoffId);
    assert.equal(retained.signoff.current, false);
  });
});

test("P2-F04: failed, stale, and unsigned runs cannot be signed off", async () => {
  await inRollback(async () => {
    const mapping = await createMapping();
    const claim = await claimNetSuitePreflightRun(claimInput("failed-signoff"));
    const checks = passingChecks(claim);
    checks[0] = {
      ...checks[0],
      status: "invalid",
      message: "P2 deliberate required-check failure."
    };
    const failed = await completeNetSuitePreflightRun({
      preflightRunId: claim.preflightRunId,
      leaseToken: claim.leaseToken,
      checks
    });
    assert.equal(failed.status, "failed");
    await assert.rejects(
      () => signoffNetSuitePreflightRun({
        actor: ACTOR,
        preflightRunId: claim.preflightRunId,
        reason: "A failed run must not sign off.",
        runtime: NETSUITE_RUNTIME,
        ...identity("failed-signoff-command")
      }),
      (error) => error instanceof MbtError
        && error.status === 409
        && error.code === "MBT_NETSUITE_PREFLIGHT_NOT_SIGNABLE"
    );

    const passing = await createPassingRun("stale-signoff");
    await putNetSuiteMapping(mappingCommand(
      mapping.valueVersion + 1,
      mapping.result.body.mapping.revision
    ));
    await assert.rejects(
      () => signoffNetSuitePreflightRun({
        actor: ACTOR,
        preflightRunId: passing.claim.preflightRunId,
        reason: "A stale run must not sign off.",
        runtime: NETSUITE_RUNTIME,
        ...identity("stale-signoff-command")
      }),
      (error) => error instanceof MbtError
        && error.status === 409
        && error.code === "MBT_NETSUITE_PREFLIGHT_NOT_CURRENT"
    );
  });
});

test("P2-F04: the database rejects signoff inserts for non-passing or mismatched run evidence", async () => {
  await inRollback(async () => {
    await createMapping();
    const failedClaim = await claimNetSuitePreflightRun(claimInput("db-failed-signoff"));
    const failedChecks = passingChecks(failedClaim);
    failedChecks[0] = {
      ...failedChecks[0],
      status: "invalid",
      message: "Deliberate database signoff-guard failure."
    };
    await completeNetSuitePreflightRun({
      preflightRunId: failedClaim.preflightRunId,
      leaseToken: failedClaim.leaseToken,
      checks: failedChecks
    });

    const insertSignoff = (run, configurationHash, runtimeFingerprint) => withTransaction(() => query(
      `INSERT INTO mbt_netsuite_preflight_signoffs (
         signoff_id, preflight_run_id, configuration_hash, runtime_fingerprint,
         signed_by, audit_note, idempotency_key, correlation_id, request_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        crypto.randomUUID(),
        run.preflightRunId,
        configurationHash,
        runtimeFingerprint,
        ACTOR.operatorId,
        "Direct signoff guard test",
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID()
      ]
    ));
    await assert.rejects(
      () => insertSignoff(
        failedClaim,
        failedClaim.configurationHash,
        failedClaim.runtimeFingerprint
      ),
      (error) => error?.code === "55000"
    );

    const passing = await createPassingRun("db-mismatched-signoff");
    await assert.rejects(
      () => insertSignoff(
        passing.claim,
        "f".repeat(64),
        passing.claim.runtimeFingerprint
      ),
      (error) => error?.code === "55000"
    );
    await assert.rejects(
      () => insertSignoff(
        passing.claim,
        passing.claim.configurationHash,
        "e".repeat(64)
      ),
      (error) => error?.code === "55000"
    );

    const retained = await query(
      "SELECT count(*)::int AS count FROM mbt_netsuite_preflight_signoffs WHERE preflight_run_id = ANY($1::uuid[])",
      [[failedClaim.preflightRunId, passing.claim.preflightRunId]]
    );
    assert.deepEqual(retained.rows, [{ count: 0 }]);
  });
});

test("P2-F04: historical mappings and all terminal evidence reject UPDATE and DELETE", async () => {
  await inRollback(async () => {
    const created = await createMapping();
    await putNetSuiteMapping(mappingCommand(
      created.valueVersion + 1,
      created.result.body.mapping.revision
    ));
    const run = await createPassingRun("immutable");
    const signed = await signoff(run, "immutable");
    const checks = await query(
      `SELECT preflight_check_id
         FROM mbt_netsuite_preflight_checks
        WHERE preflight_run_id = $1
        ORDER BY sequence_number
        LIMIT 1`,
      [run.claim.preflightRunId]
    );
    assert.equal(checks.rowCount, 1);

    const statements = [
      {
        sql: "UPDATE mbt_netsuite_mappings SET external_name = 'rewritten' WHERE mapping_id = $1",
        parameters: [created.result.body.mapping.mappingId]
      },
      {
        sql: "DELETE FROM mbt_netsuite_mappings WHERE mapping_id = $1",
        parameters: [created.result.body.mapping.mappingId]
      },
      {
        sql: "UPDATE mbt_netsuite_preflight_runs SET account_id = 'rewritten' WHERE preflight_run_id = $1",
        parameters: [run.claim.preflightRunId]
      },
      {
        sql: "DELETE FROM mbt_netsuite_preflight_runs WHERE preflight_run_id = $1",
        parameters: [run.claim.preflightRunId]
      },
      {
        sql: "UPDATE mbt_netsuite_preflight_checks SET message = 'rewritten' WHERE preflight_check_id = $1",
        parameters: [checks.rows[0].preflight_check_id]
      },
      {
        sql: "DELETE FROM mbt_netsuite_preflight_checks WHERE preflight_check_id = $1",
        parameters: [checks.rows[0].preflight_check_id]
      },
      {
        sql: `INSERT INTO mbt_netsuite_preflight_checks (
                preflight_check_id, preflight_run_id, sequence_number,
                check_type, required, severity, expected_snapshot,
                observed_snapshot, status, message
              ) VALUES ($1, $2, 999, 'injected_after_completion', false,
                        'error', '{}'::jsonb, NULL, 'passed', 'must be rejected')`,
        parameters: [crypto.randomUUID(), run.claim.preflightRunId]
      },
      {
        sql: "UPDATE mbt_netsuite_preflight_signoffs SET audit_note = 'rewritten' WHERE signoff_id = $1",
        parameters: [signed.result.body.signoff.signoffId]
      },
      {
        sql: "DELETE FROM mbt_netsuite_preflight_signoffs WHERE signoff_id = $1",
        parameters: [signed.result.body.signoff.signoffId]
      }
    ];
    for (const statement of statements) {
      await assert.rejects(
        () => withTransaction(() => query(statement.sql, statement.parameters)),
        (error) => error?.code === "55000",
        statement.sql
      );
    }
  });
});

test("P2-F04: mapping, preflight, and signoff leave operational tables, flags, and outbox unchanged", async () => {
  await inRollback(async () => {
    const snapshot = async () => {
      const result = await query(
        `SELECT
           (SELECT count(*)::int FROM mbt_contracts) AS contracts,
           (SELECT count(*)::int FROM mbt_service_visits) AS visits,
           (SELECT count(*)::int FROM mbt_bin_asset_reservations) AS reservations,
           (SELECT count(*)::int FROM mbt_bin_movements) AS movements,
           (SELECT count(*)::int FROM mbt_billing_cases) AS billing_cases,
           (SELECT count(*)::int FROM mbt_billing_versions) AS billing_versions,
           (SELECT count(*)::int FROM mbt_deposit_records) AS deposits,
           (SELECT count(*)::int FROM mbt_netsuite_outbox) AS outbox_rows,
           (SELECT count(*)::int FROM mbt_netsuite_outbox_attempts) AS outbox_attempts,
           (SELECT COALESCE(jsonb_agg(
                     jsonb_build_object(
                       'flagKey', flag_key,
                       'enabled', enabled,
                       'revision', revision
                     ) ORDER BY flag_key
                   ), '[]'::jsonb)
              FROM mbt_feature_flags) AS flags`
      );
      return result.rows[0];
    };

    const before = await snapshot();
    await createMapping();
    const run = await createPassingRun("side-effects");
    await signoff(run, "side-effects");
    const afterSnapshot = await snapshot();
    assert.deepEqual(afterSnapshot, before);
    assert.ok(
      afterSnapshot.flags.every(({ enabled }) => enabled === false),
      JSON.stringify(afterSnapshot.flags)
    );
  });
});

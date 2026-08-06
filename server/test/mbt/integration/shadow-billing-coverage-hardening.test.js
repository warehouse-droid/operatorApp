// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import pg from "pg";

import { canonicalSha256 } from "../../../src/mbt/canonical-json.js";
import { MbtError } from "../../../src/mbt/errors.js";
import {
  approveLocalBillingVersion,
  calculateMbtBillingCase,
  generateMbbsShadowBilling,
  generateMbbsShadowBillingFromSnapshots,
  getLocalBillingCase,
  listLocalBillingCases
} from "../../../src/mbt/shadow-billing-service.js";
import {
  billingActor,
  billingCalculationCommand,
  createBillingFixture
} from "../support/billing-fixtures.js";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });

after(async () => {
  await pool.end();
});

async function isolatedFixture() {
  const client = await pool.connect();
  try {
    return await createBillingFixture(client);
  } finally {
    client.release();
  }
}

function identity(label) {
  return `${label}-${crypto.randomUUID()}`;
}

/** @param {unknown} error @param {number} status @param {string} code @param {string} message */
function exactFailure(error, status, code, message) {
  return error instanceof MbtError
    && error.status === status
    && error.code === code
    && error.message === message;
}

/** @param {unknown} action @param {number} status @param {string} code @param {string} message */
async function rejectsExactly(action, status, code, message) {
  await assert.rejects(
    /** @type {() => Promise<unknown>} */ (action),
    (error) => exactFailure(error, status, code, message)
  );
}

/** @param {string} billingCaseId */
async function billingFootprint(billingCaseId) {
  const result = await pool.query(
    `SELECT
       (SELECT jsonb_build_object(
          'status', status,
          'postingMode', posting_mode,
          'currentVersionNumber', current_version_number,
          'revision', revision
        ) FROM mbt_billing_cases WHERE billing_case_id = $1) AS billing_case,
       (SELECT count(*)::int FROM mbt_billing_versions WHERE billing_case_id = $1) AS versions,
       (SELECT count(*)::int
          FROM mbt_billing_lines line
          JOIN mbt_billing_versions version USING (billing_version_id)
         WHERE version.billing_case_id = $1) AS lines,
       (SELECT count(*)::int
          FROM mbt_audit_events
         WHERE entity_type = 'mbt_billing_case' AND entity_id = $1::text) AS audits`,
    [billingCaseId]
  );
  return result.rows[0];
}

/**
 * @param {Record<string, any>} fixture
 * @param {string} label
 * @param {Record<string, unknown>} [overrides]
 */
function calculationCommand(fixture, label, overrides = {}) {
  return {
    ...billingCalculationCommand(fixture, identity(label)),
    ...overrides
  };
}

/**
 * @param {Record<string, any>} fixture
 * @param {string} label
 * @param {Record<string, unknown>} [overrides]
 */
function crossChargeCommand(fixture, label, overrides = {}) {
  const commandIdentity = identity(label);
  return {
    actor: billingActor(commandIdentity),
    customerNetsuiteId: fixture.customerNetsuiteId,
    rateCardVersionId: fixture.rateCardVersionId,
    rateDistanceBandId: fixture.rateDistanceBandId,
    currency: "CAD",
    loads: [{
      physicalLoadId: `P310-COVERAGE-${commandIdentity}`,
      planDate: "2038-08-01",
      completedAt: "2038-08-01T12:00:00.000Z",
      truckId: fixture.truckId,
      driverId: fixture.driverId,
      calculatedMetres: 12_500,
      sharedTotalMinor: 10_001,
      references: [{ sourceType: "PO", rootReference: `PO-${commandIdentity}` }]
    }],
    reason: `Coverage generation ${commandIdentity}`,
    idempotencyKey: `coverage-generation-${commandIdentity}`,
    correlationId: `coverage-generation-correlation-${commandIdentity}`,
    requestId: `coverage-generation-request-${commandIdentity}`,
    ...overrides
  };
}

/** @param {Record<string, any>} fixture @param {string} label @param {number} revision @param {string} versionId */
function approvalCommand(fixture, label, revision, versionId) {
  const commandIdentity = identity(label);
  return {
    actor: billingActor(commandIdentity),
    billingCaseId: fixture.billingCaseId,
    billingVersionId: versionId,
    expectedRevision: revision,
    reason: `Coverage approval ${commandIdentity}`,
    idempotencyKey: `coverage-approval-${commandIdentity}`,
    correlationId: `coverage-approval-correlation-${commandIdentity}`,
    requestId: `coverage-approval-request-${commandIdentity}`
  };
}

/** @param {string} billingCaseId @param {() => Promise<unknown>} action @param {number} status @param {string} code @param {string} message */
async function rejectsWithoutBillingWrites(billingCaseId, action, status, code, message) {
  const before = await billingFootprint(billingCaseId);
  await rejectsExactly(action, status, code, message);
  assert.deepEqual(await billingFootprint(billingCaseId), before);
}

test("P3 billing coverage: public commands reject malformed and unauthorized envelopes before durable work", async () => {
  const fixture = await isolatedFixture();
  const before = await billingFootprint(fixture.billingCaseId);
  const invalidActor = calculationCommand(fixture, "roles-not-array", {
    actor: { operatorId: "coverage-roles-not-array", roles: "mbt_billing" }
  });
  const missingActorId = calculationCommand(fixture, "missing-actor-id", {
    actor: { operatorId: "", roles: ["admin"] }
  });

  await rejectsExactly(
    () => calculateMbtBillingCase(null),
    400,
    "MBT_BILLING_INPUT_INVALID",
    "Billing calculation is required."
  );
  await rejectsExactly(
    () => calculateMbtBillingCase(invalidActor),
    403,
    "MBT_BILLING_FORBIDDEN",
    "An MBT Billing or Admin actor is required."
  );
  await rejectsExactly(
    () => calculateMbtBillingCase(missingActorId),
    400,
    "MBT_BILLING_INPUT_INVALID",
    "Actor ID is required."
  );
  await rejectsExactly(
    () => calculateMbtBillingCase(calculationCommand(fixture, "bad-case-id", {
      billingCaseId: "not-a-uuid"
    })),
    400,
    "MBT_BILLING_INPUT_INVALID",
    "Billing-case ID must be a UUID."
  );
  await rejectsExactly(
    () => approveLocalBillingVersion(null),
    400,
    "MBT_BILLING_INPUT_INVALID",
    "Local billing approval is required."
  );
  await rejectsExactly(
    () => generateMbbsShadowBilling({
      actor: billingActor(identity("missing-loads")),
      loads: null
    }),
    400,
    "MBT_BILLING_INPUT_INVALID",
    "Completed MBBS loads are required."
  );
  await rejectsExactly(
    () => listLocalBillingCases(null),
    400,
    "MBT_BILLING_INPUT_INVALID",
    "Billing queue request is required."
  );
  assert.deepEqual(await billingFootprint(fixture.billingCaseId), before);
});

test("P3 billing coverage: selection, currency, quantity, and custom-price failures preserve the case", async () => {
  const fixture = await isolatedFixture();
  const other = await isolatedFixture();

  await rejectsWithoutBillingWrites(
    fixture.billingCaseId,
    () => calculateMbtBillingCase(calculationCommand(fixture, "missing-case", {
      billingCaseId: crypto.randomUUID()
    })),
    404,
    "MBT_BILLING_CASE_NOT_FOUND",
    "The local billing case was not found."
  );
  await rejectsWithoutBillingWrites(
    fixture.billingCaseId,
    () => calculateMbtBillingCase(calculationCommand(fixture, "missing-revision", {
      expectedRevision: null
    })),
    400,
    "MBT_REVISION_REQUIRED",
    "A positive integer expected revision is required."
  );

  await pool.query(
    "UPDATE mbt_billing_cases SET posting_mode = 'netsuite_future' WHERE billing_case_id = $1",
    [fixture.billingCaseId]
  );
  await rejectsWithoutBillingWrites(
    fixture.billingCaseId,
    () => calculateMbtBillingCase(calculationCommand(fixture, "posting-mode")),
    409,
    "MBT_BILLING_POSTING_MODE_INVALID",
    "P3.10 can calculate only local-only billing cases."
  );
  await pool.query(
    "UPDATE mbt_billing_cases SET posting_mode = 'local_only' WHERE billing_case_id = $1",
    [fixture.billingCaseId]
  );

  const scenarios = [
    {
      label: "missing-distance",
      overrides: { distanceSnapshotId: crypto.randomUUID() },
      status: 404,
      code: "MBT_BILLING_DISTANCE_NOT_FOUND",
      message: "The immutable billing distance was not found."
    },
    {
      label: "mismatched-distance",
      overrides: { distanceSnapshotId: other.distanceSnapshotId },
      status: 409,
      code: "MBT_BILLING_DISTANCE_MISMATCH",
      message: "The distance snapshot does not match the visit and locked rate version."
    },
    {
      label: "component-quantity-format",
      overrides: { componentQuantities: { rental_daily: "1.0000001" } },
      status: 422,
      code: "MBT_BILLING_QUANTITY_INVALID",
      message: "Quantity for rental_daily must have at most six decimal places."
    },
    {
      label: "component-quantity-overflow",
      overrides: { componentQuantities: { rental_daily: "9007199254740992" } },
      status: 422,
      code: "MBT_BILLING_QUANTITY_INVALID",
      message: "Quantity for rental_daily exceeds the safe quantity range."
    },
    {
      label: "custom-prices-array",
      overrides: { customPrices: {} },
      status: 400,
      code: "MBT_BILLING_INPUT_INVALID",
      message: "Custom prices must be an array."
    },
    {
      label: "custom-price-item",
      overrides: {
        customPrices: [{
          localItemCode: "20YD",
          localItemRevision: 1,
          lineCode: "invalid-custom-item",
          amountMinor: 1
        }]
      },
      status: 409,
      code: "MBT_BILLING_CUSTOM_PRICE_ITEM_INVALID",
      message: "Custom price evidence does not match an active locked local item."
    },
    {
      label: "receipt-mismatch",
      overrides: { dumpReceiptId: crypto.randomUUID() },
      status: 409,
      code: "MBT_BILLING_RECEIPT_MISMATCH",
      message: "The dump receipt does not belong to the selected visit."
    }
  ];
  for (const scenario of scenarios) {
    await rejectsWithoutBillingWrites(
      fixture.billingCaseId,
      () => calculateMbtBillingCase(calculationCommand(fixture, scenario.label, scenario.overrides)),
      scenario.status,
      scenario.code,
      scenario.message
    );
  }

  await pool.query(
    "UPDATE mbt_billing_cases SET currency = 'USD' WHERE billing_case_id = $1",
    [fixture.billingCaseId]
  );
  await rejectsWithoutBillingWrites(
    fixture.billingCaseId,
    () => calculateMbtBillingCase(calculationCommand(fixture, "case-currency")),
    409,
    "MBT_BILLING_CURRENCY_MISMATCH",
    "P3.10 local billing requires CAD evidence."
  );
  await pool.query(
    "UPDATE mbt_billing_cases SET currency = 'CAD' WHERE billing_case_id = $1",
    [fixture.billingCaseId]
  );
});

test("P3 billing coverage: a late version hook rolls back and the exact retry produces a complete queryable draft", async () => {
  const fixture = await isolatedFixture();
  const command = calculationCommand(fixture, "version-hook");
  const before = await billingFootprint(fixture.billingCaseId);

  await assert.rejects(
    () => calculateMbtBillingCase(command, {
      hooks: {
        afterVersionInsert: async () => {
          throw new Error("coverage version rollback");
        }
      }
    }),
    /coverage version rollback/u
  );
  assert.deepEqual(await billingFootprint(fixture.billingCaseId), before);

  const calculated = await calculateMbtBillingCase(command);
  assert.equal(calculated.replayed, false);
  assert.equal(calculated.body.status, "draft");
  assert.equal(calculated.body.postingMode, "local_only");
  assert.equal(calculated.body.lines.length, 3);
  assert.equal(
    calculated.body.lines.reduce((sum, line) => sum + line.totalAmountMinor, 0),
    calculated.body.totalMinor
  );

  const detail = await getLocalBillingCase(fixture.billingCaseId, billingActor(identity("detail")));
  assert.equal(detail.versions.length, 1);
  assert.equal(detail.versions[0].billingVersionId, calculated.body.billingVersionId);
  assert.equal(detail.versions[0].approvedAt, null);
  assert.deepEqual(
    detail.versions[0].lines.map((line) => line.lineType),
    ["transport", "rental", "dump"]
  );
});

test("P3 billing coverage: approval rejects missing, non-ready, and non-current evidence without mutation", async () => {
  const fixture = await isolatedFixture();
  const calculated = await calculateMbtBillingCase(calculationCommand(fixture, "approval-source"));

  await rejectsWithoutBillingWrites(
    fixture.billingCaseId,
    () => approveLocalBillingVersion({
      ...approvalCommand(fixture, "approval-missing-case", 2, calculated.body.billingVersionId),
      billingCaseId: crypto.randomUUID()
    }),
    404,
    "MBT_BILLING_CASE_NOT_FOUND",
    "The local billing case was not found."
  );

  await pool.query(
    "UPDATE mbt_billing_cases SET status = 'open' WHERE billing_case_id = $1",
    [fixture.billingCaseId]
  );
  await rejectsWithoutBillingWrites(
    fixture.billingCaseId,
    () => approveLocalBillingVersion(
      approvalCommand(fixture, "approval-not-ready", 2, calculated.body.billingVersionId)
    ),
    409,
    "MBT_BILLING_NOT_APPROVABLE",
    "Only a ready local-only billing case can be approved."
  );
  await pool.query(
    "UPDATE mbt_billing_cases SET status = 'ready' WHERE billing_case_id = $1",
    [fixture.billingCaseId]
  );

  await rejectsWithoutBillingWrites(
    fixture.billingCaseId,
    () => approveLocalBillingVersion(
      approvalCommand(fixture, "approval-wrong-version", 2, crypto.randomUUID())
    ),
    409,
    "MBT_BILLING_DRAFT_NOT_CURRENT",
    "Approval requires the complete current local draft."
  );

  const approvedCommand = approvalCommand(
    fixture,
    "approval-admin",
    2,
    calculated.body.billingVersionId
  );
  approvedCommand.actor = {
    operatorId: `coverage-admin-${crypto.randomUUID()}`,
    roles: ["admin"],
    actorType: "service"
  };
  const approved = await approveLocalBillingVersion(approvedCommand);
  assert.equal(approved.body.status, "approved");
  assert.equal(approved.body.caseRevision, 3);
  assert.equal(approved.body.externalWork, null);

  const detail = await getLocalBillingCase(fixture.billingCaseId, approvedCommand.actor);
  assert.equal(detail.status, "approved");
  assert.equal(detail.versions[0].status, "approved");
  assert.notEqual(detail.versions[0].approvedAt, null);
});

test("P3 billing coverage: approved cases require valid current amendment lineage", async () => {
  const fixture = await isolatedFixture();
  const original = await calculateMbtBillingCase(calculationCommand(fixture, "amendment-original"));
  await approveLocalBillingVersion(
    approvalCommand(fixture, "amendment-original", 2, original.body.billingVersionId)
  );

  const scenarios = [
    {
      label: "amendment-required",
      overrides: { expectedRevision: 3 },
      code: "MBT_BILLING_AMENDMENT_REQUIRED",
      message: "An approved case requires explicit amendment lineage."
    },
    {
      label: "amendment-kind",
      overrides: {
        expectedRevision: 3,
        amendsBillingVersionId: original.body.billingVersionId,
        amendmentKind: "rewrite"
      },
      code: "MBT_BILLING_AMENDMENT_KIND_INVALID",
      message: "The amendment kind is not supported.",
      status: 400
    },
    {
      label: "amendment-original",
      overrides: {
        expectedRevision: 3,
        amendsBillingVersionId: crypto.randomUUID(),
        amendmentKind: "correction"
      },
      code: "MBT_BILLING_AMENDMENT_ORIGINAL_INVALID",
      message: "The amendment original must be an approved version in this case."
    }
  ];
  for (const scenario of scenarios) {
    await rejectsWithoutBillingWrites(
      fixture.billingCaseId,
      () => calculateMbtBillingCase(calculationCommand(fixture, scenario.label, scenario.overrides)),
      scenario.status ?? 409,
      scenario.code,
      scenario.message
    );
  }

  await pool.query(
    "UPDATE mbt_billing_cases SET current_version_number = 2 WHERE billing_case_id = $1",
    [fixture.billingCaseId]
  );
  await rejectsWithoutBillingWrites(
    fixture.billingCaseId,
    () => calculateMbtBillingCase(calculationCommand(fixture, "amendment-not-current", {
      expectedRevision: 3,
      amendsBillingVersionId: original.body.billingVersionId,
      amendmentKind: "correction"
    })),
    409,
    "MBT_BILLING_AMENDMENT_NOT_CURRENT",
    "Only the current approved version can be amended."
  );
  await pool.query(
    "UPDATE mbt_billing_cases SET current_version_number = 1 WHERE billing_case_id = $1",
    [fixture.billingCaseId]
  );
});

test("P3 billing coverage: generation validates rate and customer authority and rolls back late failure", async () => {
  const fixture = await isolatedFixture();
  const invalidRate = crossChargeCommand(fixture, "invalid-rate", {
    rateCardVersionId: crypto.randomUUID()
  });
  const invalidCustomer = crossChargeCommand(fixture, "invalid-customer", {
    customerNetsuiteId: "999999999999"
  });

  await rejectsExactly(
    () => generateMbbsShadowBilling(invalidRate),
    409,
    "MBT_CROSS_CHARGE_RATE_INVALID",
    "The active cross-charge rate version and distance band must match the billing currency."
  );
  await rejectsExactly(
    () => generateMbbsShadowBilling(invalidCustomer),
    409,
    "MBT_CROSS_CHARGE_CUSTOMER_INVALID",
    "The cross-charge customer is not in the canonical customer master."
  );

  const command = crossChargeCommand(fixture, "generation-hook");
  const physicalLoadId = command.loads[0].physicalLoadId;
  await assert.rejects(
    () => generateMbbsShadowBilling(command, {
      hooks: {
        afterCaseInsert: async () => {
          throw new Error("coverage cross-charge rollback");
        }
      }
    }),
    /coverage cross-charge rollback/u
  );
  const rolledBack = await pool.query(
    "SELECT count(*)::int AS count FROM mbt_cross_charge_cases WHERE physical_load_id = $1",
    [physicalLoadId]
  );
  assert.equal(rolledBack.rows[0].count, 0);

  const generated = await generateMbbsShadowBilling(command);
  assert.equal(generated.replayed, false);
  assert.equal(generated.body.cases.length, 1);
  assert.equal(generated.body.cases[0].allocatedAmountMinor, 10_001);

  const independentReplay = {
    ...command,
    actor: billingActor(identity("generation-independent-replay")),
    idempotencyKey: `coverage-independent-${crypto.randomUUID()}`,
    correlationId: `coverage-independent-correlation-${crypto.randomUUID()}`,
    requestId: `coverage-independent-request-${crypto.randomUUID()}`
  };
  const replayedEvidence = await generateMbbsShadowBilling(independentReplay);
  assert.equal(replayedEvidence.replayed, false);
  assert.deepEqual(replayedEvidence.body.cases, generated.body.cases);

  const durable = await pool.query(
    `SELECT count(DISTINCT cross_charge.cross_charge_case_id)::int AS cases,
            count(DISTINCT version.billing_version_id)::int AS versions,
            count(DISTINCT line.billing_line_id)::int AS lines
       FROM mbt_cross_charge_cases cross_charge
       JOIN mbt_billing_cases billing_case USING (cross_charge_case_id)
       JOIN mbt_billing_versions version USING (billing_case_id)
       JOIN mbt_billing_lines line USING (billing_version_id)
      WHERE cross_charge.physical_load_id = $1`,
    [physicalLoadId]
  );
  assert.deepEqual(durable.rows, [{ cases: 1, versions: 1, lines: 1 }]);
});

/** @param {Record<string, any>} _fixture */
async function createCompletedLoadSnapshot(_fixture) {
  const snapshotId = crypto.randomUUID();
  const snapshotIdentity = crypto.randomUUID();
  const physicalLoadId = `P311-COVERAGE-${snapshotIdentity}`;
  const completedAt = "2038-09-01T12:00:00.000Z";
  const sourceSnapshot = {
    schemaVersion: "mbbs-completed-load-snapshot-v1",
    completed: true,
    physicalLoadId,
    completedAt,
    evidenceIdentity: snapshotIdentity
  };
  const references = [{
    sourceType: "PO",
    rootReference: `PO-P311-COVERAGE-${snapshotIdentity}`
  }];
  await pool.query(
    `INSERT INTO mbt_mbbs_completed_load_snapshots (
       completed_load_snapshot_id, source_system, source_plan_id,
       source_plan_revision, plan_date, physical_load_id, completed_at,
       truck_id, driver_id, calculated_metres, shared_total_minor, currency,
       source_references, source_snapshot, source_snapshot_hash, created_by
     ) VALUES (
       $1, 'dispatch', $2, 1, '2038-09-01', $3, $4::timestamptz,
       NULL, NULL, 12500, 4321, 'CAD', $5::jsonb, $6::jsonb, $7, $8
     )`,
    [
      snapshotId,
      `P311-COVERAGE-PLAN-${snapshotIdentity}`,
      physicalLoadId,
      completedAt,
      JSON.stringify(references),
      JSON.stringify(sourceSnapshot),
      canonicalSha256(sourceSnapshot),
      `p311-coverage-${snapshotIdentity}`
    ]
  );
  return { snapshotId, physicalLoadId };
}

/** @param {Record<string, any>} fixture @param {string} snapshotId @param {string} label */
function snapshotCommand(fixture, snapshotId, label) {
  const commandIdentity = identity(label);
  return {
    actor: billingActor(commandIdentity),
    customerNetsuiteId: fixture.customerNetsuiteId,
    rateCardVersionId: fixture.rateCardVersionId,
    rateDistanceBandId: fixture.rateDistanceBandId,
    completedLoadSnapshotIds: [snapshotId],
    currency: "CAD",
    reason: `Coverage snapshot generation ${commandIdentity}`,
    idempotencyKey: `coverage-snapshot-${commandIdentity}`,
    correlationId: `coverage-snapshot-correlation-${commandIdentity}`,
    requestId: `coverage-snapshot-request-${commandIdentity}`
  };
}

test("P3 billing coverage: snapshot generation rejects caller authority, invalid sets, and currency drift", async () => {
  const fixture = await isolatedFixture();
  const snapshot = await createCompletedLoadSnapshot(fixture);
  const base = snapshotCommand(fixture, snapshot.snapshotId, "snapshot-validation");

  await rejectsExactly(
    () => generateMbbsShadowBillingFromSnapshots({ ...base, loads: [] }),
    400,
    "MBT_CROSS_CHARGE_SNAPSHOT_INPUT_INVALID",
    "Public cross-charge generation accepts completed-load snapshot IDs, not caller-authored load evidence."
  );
  for (const invalidIds of [null, [], Array.from({ length: 101 }, () => crypto.randomUUID())]) {
    await rejectsExactly(
      () => generateMbbsShadowBillingFromSnapshots({
        ...base,
        completedLoadSnapshotIds: invalidIds
      }),
      400,
      "MBT_CROSS_CHARGE_SNAPSHOT_IDS_INVALID",
      "Provide between 1 and 100 completed-load snapshot IDs."
    );
  }
  await rejectsExactly(
    () => generateMbbsShadowBillingFromSnapshots({
      ...base,
      completedLoadSnapshotIds: [snapshot.snapshotId, snapshot.snapshotId]
    }),
    409,
    "MBT_CROSS_CHARGE_SNAPSHOT_IDS_DUPLICATE",
    "Completed-load snapshot IDs must be unique."
  );
  await rejectsExactly(
    () => generateMbbsShadowBillingFromSnapshots({
      ...base,
      completedLoadSnapshotIds: [crypto.randomUUID()]
    }),
    404,
    "MBT_CROSS_CHARGE_SNAPSHOT_NOT_FOUND",
    "One or more completed-load snapshots are unavailable."
  );
  await rejectsExactly(
    () => generateMbbsShadowBillingFromSnapshots({ ...base, currency: "USD" }),
    409,
    "MBT_BILLING_CURRENCY_MISMATCH",
    "P3.10 local billing requires CAD evidence."
  );

  const generated = await generateMbbsShadowBillingFromSnapshots(
    snapshotCommand(fixture, snapshot.snapshotId, "snapshot-success")
  );
  assert.equal(generated.body.cases.length, 1);
  assert.equal(generated.body.cases[0].physicalLoadId, snapshot.physicalLoadId);
  const evidence = await pool.query(
    `SELECT source_snapshot->>'completedLoadSnapshotId' AS snapshot_id,
            source_snapshot->>'truckId' AS truck_id,
            source_snapshot->>'driverId' AS driver_id
       FROM mbt_cross_charge_cases
      WHERE physical_load_id = $1`,
    [snapshot.physicalLoadId]
  );
  assert.deepEqual(evidence.rows, [{
    snapshot_id: snapshot.snapshotId,
    truck_id: null,
    driver_id: null
  }]);
});

test("P3 billing coverage: recovery reads enforce filters and expose deterministic pagination", async () => {
  const actor = billingActor(identity("queue"));
  const cases = [
    {
      input: { actor, status: "unknown" },
      message: "The billing queue status filter is invalid."
    },
    {
      input: { actor, caseType: "sales_order" },
      message: "The billing queue case-type filter is invalid."
    },
    {
      input: { actor, limit: 0 },
      message: "Billing queue limit must be an integer from 1 through 100."
    },
    {
      input: { actor, limit: 1.5 },
      message: "Billing queue limit must be an integer from 1 through 100."
    },
    {
      input: { actor, limit: 101 },
      message: "Billing queue limit must be an integer from 1 through 100."
    },
    {
      input: { actor, cursor: "not-a-uuid" },
      message: "Billing queue cursor must be a UUID."
    }
  ];
  for (const scenario of cases) {
    await rejectsExactly(
      () => listLocalBillingCases(scenario.input),
      400,
      "MBT_BILLING_INPUT_INVALID",
      scenario.message
    );
  }

  await rejectsExactly(
    () => getLocalBillingCase(crypto.randomUUID(), actor),
    404,
    "MBT_BILLING_CASE_NOT_FOUND",
    "The local billing case was not found."
  );

  const firstPage = await listLocalBillingCases({
    actor: { ...actor, roles: ["admin"] },
    status: "",
    caseType: null,
    limit: 1
  });
  assert.equal(firstPage.items.length, 1);
  assert.notEqual(firstPage.nextCursor, null);
  const secondPage = await listLocalBillingCases({
    actor,
    cursor: firstPage.nextCursor,
    limit: 1
  });
  assert.equal(secondPage.items.length, 1);
  assert.notEqual(secondPage.items[0].billingCaseId, firstPage.items[0].billingCaseId);

  const defaultPage = await listLocalBillingCases({ actor });
  assert.equal(defaultPage.schemaVersion, "mbt-local-billing-queue-v1");
  assert.equal(defaultPage.postingMode, "local_only");
  assert.ok(defaultPage.items.length >= 1);
});

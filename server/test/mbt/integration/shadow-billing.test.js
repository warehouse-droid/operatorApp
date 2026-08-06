// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import pg from "pg";

import {
  billingActor,
  billingCalculationCommand,
  createBillingFixture
} from "../support/billing-fixtures.js";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const SERVICE_PATH = "../../../src/mbt/" + "shadow-billing-service.js";
const serviceModule = /** @type {Record<string, Function>} */ (await import(SERVICE_PATH)
  .catch((importError) => ({ importError })));

let fixture;

/** @param {string} name */
function requiredOperation(name) {
  const operation = serviceModule[name];
  assert.equal(typeof operation, "function", `P3.10 requires shadow-billing-service.${name}.`);
  return operation;
}

before(async () => {
  const client = await pool.connect();
  try {
    fixture = await createBillingFixture(client);
  } finally {
    client.release();
  }
});

after(async () => {
  await pool.end();
});

async function externalArtifactCounts() {
  const result = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM mbt_netsuite_sales_order_chain) AS chains,
       (SELECT count(*)::int FROM mbt_deposit_records) AS deposits,
       (SELECT count(*)::int FROM mbt_netsuite_outbox) AS outbox,
       (SELECT count(*)::int FROM mbt_netsuite_outbox_attempts) AS attempts`
  );
  return result.rows[0];
}

/** @param {any} activeFixture @param {string} identity @param {number} expectedRevision @param {string} billingVersionId */
function approvalCommand(activeFixture, identity, expectedRevision, billingVersionId) {
  return {
    actor: billingActor(identity),
    billingCaseId: activeFixture.billingCaseId,
    billingVersionId,
    expectedRevision,
    reason: `Synthetic local approval ${identity}`,
    idempotencyKey: `p3.10-approve-${identity}`,
    correlationId: `p3.10-approve-correlation-${identity}`,
    requestId: `p3.10-approve-request-${identity}`
  };
}

test("P3-F25/P3-F27 calculation atomically writes one complete local-only draft and approval creates zero external work", async () => {
  const calculateMbtBillingCase = requiredOperation("calculateMbtBillingCase");
  const approveLocalBillingVersion = requiredOperation("approveLocalBillingVersion");
  let transportCalls = 0;
  const dependencies = {
    transport: async () => {
      transportCalls += 1;
      throw new Error("P3.10 local billing must never call transport.");
    }
  };
  const externalBefore = await externalArtifactCounts();
  const calculated = await calculateMbtBillingCase(
    billingCalculationCommand(fixture, "atomic"),
    dependencies
  );

  assert.equal(calculated.status, 201);
  assert.equal(calculated.replayed, false);
  assert.equal(calculated.body.schemaVersion, "mbt-local-billing-draft-v1");
  assert.equal(calculated.body.status, "draft");
  assert.equal(calculated.body.postingMode, "local_only");
  assert.equal(calculated.body.versionNumber, 1);
  assert.deepEqual(calculated.body.lines.map((line) => line.lineType), ["transport", "rental", "dump"]);
  assert.deepEqual(calculated.body.dumpEconomics, {
    customerChargeMinor: 5_000,
    actualCostMinor: 4_200,
    marginMinor: 800,
    currency: "CAD"
  });

  const durableDraft = await pool.query(
    `SELECT version.status, version.posting_mode,
            version.subtotal_minor::int AS subtotal_minor,
            version.estimated_tax_minor::int AS estimated_tax_minor,
            version.total_minor::int AS total_minor,
            billing_case.status AS case_status,
            billing_case.current_version_number,
            billing_case.revision::int AS case_revision,
            count(line.billing_line_id)::int AS line_count,
            sum(line.net_amount_minor)::int AS line_subtotal,
            sum(line.estimated_tax_minor)::int AS line_tax,
            sum(line.total_amount_minor)::int AS line_total
       FROM mbt_billing_versions version
       JOIN mbt_billing_cases billing_case USING (billing_case_id)
       JOIN mbt_billing_lines line USING (billing_version_id)
      WHERE version.billing_version_id = $1
      GROUP BY version.billing_version_id, billing_case.billing_case_id`,
    [calculated.body.billingVersionId]
  );
  assert.deepEqual(durableDraft.rows, [{
    status: "draft",
    posting_mode: "local_only",
    subtotal_minor: calculated.body.subtotalMinor,
    estimated_tax_minor: calculated.body.estimatedTaxMinor,
    total_minor: calculated.body.totalMinor,
    case_status: "ready",
    current_version_number: 1,
    case_revision: 2,
    line_count: 3,
    line_subtotal: calculated.body.subtotalMinor,
    line_tax: calculated.body.estimatedTaxMinor,
    line_total: calculated.body.totalMinor
  }]);

  const approved = await approveLocalBillingVersion(
    approvalCommand(fixture, "atomic", 2, calculated.body.billingVersionId),
    dependencies
  );
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, "approved");
  assert.equal(approved.body.postingMode, "local_only");
  assert.equal(approved.body.caseRevision, 3);
  assert.deepEqual(await externalArtifactCounts(), externalBefore);
  assert.equal(transportCalls, 0);
  await assert.rejects(
    () => pool.query(
      `INSERT INTO mbt_billing_lines (
         billing_line_id, billing_version_id, sequence_number, line_type,
         description, quantity, unit_of_measure, unit_amount_minor,
         net_amount_minor, estimated_tax_minor, total_amount_minor, currency,
         revenue_class, source_entity_type, source_entity_id,
         local_item_code, local_item_revision, calculation_detail
       ) VALUES (
         $1, $2, 99, 'other', 'Late line', 1, 'EA', 1,
         1, 0, 1, 'CAD', 'other', 'contract', $3,
         '20YD', 1, '{}'::jsonb
       )`,
      [crypto.randomUUID(), calculated.body.billingVersionId, fixture.contractId]
    ),
    (error) => error?.code === "55000"
  );
});

test("P3-F27 injected failure after a draft line rolls back version, every line, case, receipt, and audit", async () => {
  const calculateMbtBillingCase = requiredOperation("calculateMbtBillingCase");
  const client = await pool.connect();
  let isolated;
  try {
    isolated = await createBillingFixture(client);
  } finally {
    client.release();
  }
  const beforeFailure = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM mbt_billing_versions WHERE billing_case_id = $1) AS versions,
       (SELECT count(*)::int FROM mbt_billing_lines line JOIN mbt_billing_versions version USING (billing_version_id) WHERE version.billing_case_id = $1) AS lines,
       (SELECT count(*)::int FROM mbt_command_receipts WHERE command_name = 'mbt.billing.calculate') AS receipts,
       (SELECT count(*)::int FROM mbt_audit_events WHERE action = 'mbt.billing.calculated') AS audits`,
    [isolated.billingCaseId]
  );
  await assert.rejects(
    () => calculateMbtBillingCase(
      billingCalculationCommand(isolated, "rollback"),
      { hooks: { afterLineInsert: async () => { throw new Error("synthetic P3.10 rollback"); } } }
    ),
    /synthetic P3\.10 rollback/
  );
  const afterResult = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM mbt_billing_versions WHERE billing_case_id = $1) AS versions,
       (SELECT count(*)::int FROM mbt_billing_lines line JOIN mbt_billing_versions version USING (billing_version_id) WHERE version.billing_case_id = $1) AS lines,
       (SELECT count(*)::int FROM mbt_command_receipts WHERE command_name = 'mbt.billing.calculate') AS receipts,
       (SELECT count(*)::int FROM mbt_audit_events WHERE action = 'mbt.billing.calculated') AS audits,
       (SELECT jsonb_build_object('status', status, 'revision', revision, 'currentVersion', current_version_number)
          FROM mbt_billing_cases WHERE billing_case_id = $1) AS billing_case`,
    [isolated.billingCaseId]
  );
  assert.equal(afterResult.rows[0].versions, beforeFailure.rows[0].versions);
  assert.equal(afterResult.rows[0].lines, beforeFailure.rows[0].lines);
  assert.equal(afterResult.rows[0].receipts, beforeFailure.rows[0].receipts);
  assert.equal(afterResult.rows[0].audits, beforeFailure.rows[0].audits);
  assert.deepEqual(afterResult.rows[0].billing_case, { status: "open", revision: 1, currentVersion: 0 });
});

test("P3-F28 correction appends an amendment and new version while the approved original remains queryable", async () => {
  const calculateMbtBillingCase = requiredOperation("calculateMbtBillingCase");
  const approveLocalBillingVersion = requiredOperation("approveLocalBillingVersion");
  const client = await pool.connect();
  let isolated;
  try {
    isolated = await createBillingFixture(client);
  } finally {
    client.release();
  }
  const first = await calculateMbtBillingCase(billingCalculationCommand(isolated, "amend-original"));
  await approveLocalBillingVersion(
    approvalCommand(isolated, "amend-original", 2, first.body.billingVersionId)
  );
  const originalBefore = await pool.query(
    `SELECT to_jsonb(version.*) AS version,
            jsonb_agg(to_jsonb(line.*) ORDER BY line.sequence_number) AS lines
       FROM mbt_billing_versions version
       JOIN mbt_billing_lines line USING (billing_version_id)
      WHERE version.billing_version_id = $1
      GROUP BY version.billing_version_id`,
    [first.body.billingVersionId]
  );
  const second = await calculateMbtBillingCase({
    ...billingCalculationCommand(isolated, "amend-correction"),
    expectedRevision: 3,
    componentQuantities: { rental_daily: "4.000000" },
    amendsBillingVersionId: first.body.billingVersionId,
    amendmentKind: "correction",
    reason: "Correct the retained rental quantity with manual evidence."
  });
  assert.equal(second.body.versionNumber, 2);
  assert.equal(second.body.status, "draft");
  assert.equal(second.body.amendsBillingVersionId, first.body.billingVersionId);
  assert.notEqual(second.body.subtotalMinor, first.body.subtotalMinor);

  const lineage = await pool.query(
    `SELECT original_billing_version_id::text AS original_id,
            amended_billing_version_id::text AS amended_id,
            amendment_kind, reason
       FROM mbt_billing_version_amendments
      WHERE amended_billing_version_id = $1`,
    [second.body.billingVersionId]
  );
  assert.deepEqual(lineage.rows, [{
    original_id: first.body.billingVersionId,
    amended_id: second.body.billingVersionId,
    amendment_kind: "correction",
    reason: "Correct the retained rental quantity with manual evidence."
  }]);
  const originalAfter = await pool.query(
    `SELECT to_jsonb(version.*) AS version,
            jsonb_agg(to_jsonb(line.*) ORDER BY line.sequence_number) AS lines
       FROM mbt_billing_versions version
       JOIN mbt_billing_lines line USING (billing_version_id)
      WHERE version.billing_version_id = $1
      GROUP BY version.billing_version_id`,
    [first.body.billingVersionId]
  );
  assert.deepEqual(originalAfter.rows, originalBefore.rows);
});

test("P3-F26 representative MBBS physical loads generate exact deduped draft cases and conserved allocations", async () => {
  const generateMbbsShadowBilling = requiredOperation("generateMbbsShadowBilling");
  const externalBefore = await externalArtifactCounts();
  const input = {
    actor: billingActor("mbbs"),
    customerNetsuiteId: fixture.customerNetsuiteId,
    rateCardVersionId: fixture.rateCardVersionId,
    rateDistanceBandId: fixture.rateDistanceBandId,
    currency: "CAD",
    loads: [{
      physicalLoadId: "P310-LOAD-A",
      planDate: "2038-01-01",
      completedAt: "2038-01-01T12:00:00.000Z",
      truckId: fixture.truckId,
      driverId: fixture.driverId,
      calculatedMetres: 12_500,
      sharedTotalMinor: 1_001,
      references: [
        { sourceType: "SO", rootReference: "SO-P310", childReference: "SO-P310-A" },
        { sourceType: "SO", rootReference: "SO-P310", childReference: "SO-P310-B" },
        { sourceType: "TO", rootReference: "TO-P310" },
        { sourceType: "PO", rootReference: "PO-P310" },
        { sourceType: "VRMA", rootReference: "VRMA-P310" }
      ]
    }, {
      physicalLoadId: "P310-LOAD-B",
      planDate: "2038-01-02",
      completedAt: "2038-01-02T12:00:00.000Z",
      truckId: fixture.truckId,
      driverId: fixture.driverId,
      calculatedMetres: 10_000,
      sharedTotalMinor: 501,
      references: [{ sourceType: "TO", rootReference: "TO-P310" }]
    }],
    reason: "Synthetic representative MBBS cross-charge generation",
    idempotencyKey: "p3.10-mbbs-generate",
    correlationId: "p3.10-mbbs-correlation",
    requestId: "p3.10-mbbs-request"
  };
  const generated = await generateMbbsShadowBilling(input);
  assert.equal(generated.status, 201);
  assert.deepEqual(generated.body.cases.map((entry) => ({
    deduplicationKey: entry.deduplicationKey,
    allocatedAmountMinor: entry.allocatedAmountMinor,
    versionStatus: entry.versionStatus,
    postingMode: entry.postingMode
  })), [
    { deduplicationKey: "SO|SO-P310|P310-LOAD-A", allocatedAmountMinor: 1_001, versionStatus: "draft", postingMode: "local_only" },
    { deduplicationKey: "TO|TO-P310", allocatedAmountMinor: 1_001, versionStatus: "draft", postingMode: "local_only" },
    { deduplicationKey: "PO|PO-P310|P310-LOAD-A", allocatedAmountMinor: 500, versionStatus: "draft", postingMode: "local_only" },
    { deduplicationKey: "VRMA|VRMA-P310|P310-LOAD-A", allocatedAmountMinor: 501, versionStatus: "draft", postingMode: "local_only" }
  ]);
  const allocation = await pool.query(
    `SELECT allocation_group_id::text AS group_id,
            max(shared_total_minor)::int AS shared_total_minor,
            sum(allocated_amount_minor)::int AS allocated_amount_minor,
            array_agg(root_reference ORDER BY sorted_ordinal) AS roots
       FROM mbt_cross_charge_allocations
      WHERE allocation_group_id = $1
      GROUP BY allocation_group_id`,
    [generated.body.allocationGroups[0].allocationGroupId]
  );
  assert.deepEqual(allocation.rows, [{
    group_id: generated.body.allocationGroups[0].allocationGroupId,
    shared_total_minor: 1_001,
    allocated_amount_minor: 1_001,
    roots: ["PO-P310", "VRMA-P310"]
  }]);
  assert.deepEqual(await externalArtifactCounts(), externalBefore);

  const replay = await generateMbbsShadowBilling(input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, generated.body);
});

test("P3-F27 unresolved blocking billing variance prevents local approval", async () => {
  const calculateMbtBillingCase = requiredOperation("calculateMbtBillingCase");
  const approveLocalBillingVersion = requiredOperation("approveLocalBillingVersion");
  const client = await pool.connect();
  let isolated;
  try {
    isolated = await createBillingFixture(client);
  } finally {
    client.release();
  }
  const calculated = await calculateMbtBillingCase(billingCalculationCommand(isolated, "blocked"));
  const line = await pool.query(
    `SELECT billing_line_id::text AS billing_line_id,
            quantity::text, unit_amount_minor::int, net_amount_minor::int,
            estimated_tax_minor::int, total_amount_minor::int,
            line_key, deduplication_key
       FROM mbt_billing_lines
      WHERE billing_version_id = $1
      ORDER BY sequence_number
      LIMIT 1`,
    [calculated.body.billingVersionId]
  );
  const batchId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO mbt_pilot_reconciliation_batches (
       reconciliation_batch_id, batch_reference, manual_source,
       created_by, reason
     ) VALUES ($1, $2, 'synthetic_manual_ledger', 'p3.10-test', 'Blocking billing variance')`,
    [batchId, `P310-BLOCK-${batchId}`]
  );
  await pool.query(
    `INSERT INTO mbt_pilot_reconciliation_rows (
       reconciliation_row_id, reconciliation_batch_id, comparison_kind,
       application_evidence_id, manual_reference, application_snapshot,
       manual_snapshot, application_snapshot_hash, manual_snapshot_hash,
       comparison_result, differences, blocking, requires_audit_note
     ) VALUES (
       $1, $2, 'billing_line', $3, 'MANUAL-BILLING-LINE', $4::jsonb,
       $5::jsonb, $6, $7, 'open_variance', $8::jsonb, true, false
     )`,
    [
      crypto.randomUUID(),
      batchId,
      line.rows[0].billing_line_id,
      JSON.stringify(line.rows[0]),
      JSON.stringify({ ...line.rows[0], total_amount_minor: Number(line.rows[0].total_amount_minor) + 1 }),
      "a".repeat(64),
      "b".repeat(64),
      JSON.stringify([{ field: "totalAmountMinor", category: "money" }])
    ]
  );
  await assert.rejects(
    () => approveLocalBillingVersion(
      approvalCommand(isolated, "blocked", 2, calculated.body.billingVersionId)
    ),
    (error) => error?.code === "MBT_BILLING_OPEN_VARIANCE"
  );
  const retained = await pool.query(
    "SELECT status FROM mbt_billing_versions WHERE billing_version_id = $1",
    [calculated.body.billingVersionId]
  );
  assert.deepEqual(retained.rows, [{ status: "draft" }]);
});

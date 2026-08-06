// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import pg from "pg";

import {
  comparePilotEvidence,
  createPilotReconciliationBatch,
  getPilotReconciliationBatch,
  listPilotReconciliationBatches,
  resolvePilotVariance
} from "../../../src/mbt/pilot-reconciliation-service.js";
import { billingActor, createBillingFixture } from "../support/billing-fixtures.js";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });

let fixture;
let billingLineId;
let crossChargeAllocationId;

before(async () => {
  const client = await pool.connect();
  try {
    fixture = await createBillingFixture(client);
    billingLineId = crypto.randomUUID();
    const billingVersionId = crypto.randomUUID();
    await client.query(
      `INSERT INTO mbt_billing_versions (
         billing_version_id, billing_case_id, version_number, status,
         rate_card_version_id, calculation_snapshot, source_revision_snapshot,
         subtotal_minor, estimated_tax_minor, total_minor, currency,
         correlation_id, idempotency_key, posting_mode,
         billing_case_revision_before, calculated_by, calculation_reason,
         calculated_at
       ) VALUES (
         $1, $2, 1, 'draft', $3, '{}'::jsonb, '{}'::jsonb,
         1000, 130, 1130, 'CAD', $4, $5, 'local_only', 1,
         'p3.10-hardening', 'Synthetic reconciliation evidence', now()
       )`,
      [
        billingVersionId,
        fixture.billingCaseId,
        fixture.rateCardVersionId,
        `p3.10-hard-version-${billingVersionId}`,
        `p3.10-hard-version-idempotency-${billingVersionId}`
      ]
    );
    await client.query(
      `INSERT INTO mbt_billing_lines (
         billing_line_id, billing_version_id, sequence_number, line_type,
         description, quantity, unit_of_measure, unit_amount_minor,
         net_amount_minor, estimated_tax_minor, total_amount_minor, currency,
         revenue_class, distance_snapshot_id, source_entity_type,
         source_entity_id, netsuite_item_mapping_key, calculation_detail,
         evidence_references, line_key, deduplication_key
       ) VALUES (
         $1, $2, 0, 'transport', 'Synthetic reconciliation line',
         1.000000, 'EA', 1000, 1000, 130, 1130, 'CAD',
         'transport', $3, 'service_visit', $4, 'local.delivery_charge',
         '{}'::jsonb, ARRAY[]::uuid[], 'transport:synthetic', 'transport:synthetic'
       )`,
      [billingLineId, billingVersionId, fixture.distanceSnapshotId, fixture.visitId]
    );

    const crossChargeCaseId = crypto.randomUUID();
    const allocationGroupId = crypto.randomUUID();
    crossChargeAllocationId = crypto.randomUUID();
    const rootReference = `PO-P310-HARD-${crypto.randomUUID()}`;
    await client.query(
      `INSERT INTO mbt_cross_charge_cases (
         cross_charge_case_id, source_type, root_reference, physical_load_id,
         allocation_group_id, plan_date, rate_card_version_id,
         calculated_metres, base_amount_minor, downtown_surcharge_minor,
         allocated_amount_minor, currency, status, source_snapshot,
         calculation_snapshot, completed_load_at, deduplication_key
       ) VALUES (
         $1, 'PO', $2, $3, $4, DATE '2038-01-01', $5,
         12500, 1001, 0, 1001, 'CAD', 'pending', '{}'::jsonb,
         '{}'::jsonb, '2038-01-01T12:00:00Z', $6
       )`,
      [
        crossChargeCaseId,
        rootReference,
        `LOAD-P310-HARD-${crossChargeCaseId}`,
        allocationGroupId,
        fixture.rateCardVersionId,
        `PO|${rootReference}|LOAD-P310-HARD-${crossChargeCaseId}`
      ]
    );
    await client.query(
      `INSERT INTO mbt_cross_charge_allocations (
         cross_charge_allocation_id, cross_charge_case_id,
         allocation_group_id, source_type, root_reference, sorted_ordinal,
         eligible_reference_count, shared_total_minor, allocated_amount_minor,
         remainder_minor, currency, allocation_snapshot
       ) VALUES ($1, $2, $3, 'PO', $4, 0, 1, 1001, 1001, 0, 'CAD', '{}'::jsonb)`,
      [crossChargeAllocationId, crossChargeCaseId, allocationGroupId, rootReference]
    );
  } finally {
    client.release();
  }
});

after(async () => {
  await pool.end();
});

/** @param {string} identity @param {object[]} comparisons @param {string[]} [roles] */
function command(identity, comparisons, roles = ["mbt_billing"]) {
  return {
    actor: billingActor(identity, roles),
    batchReference: `P3.10-HARD-${identity}-${crypto.randomUUID()}`,
    manualSource: "synthetic_manual_ledger",
    comparisons,
    reason: `Hardening reconciliation ${identity}`,
    idempotencyKey: `p3.10-hard-${identity}-${crypto.randomUUID()}`,
    correlationId: `p3.10-hard-correlation-${identity}`,
    requestId: `p3.10-hard-request-${identity}`
  };
}

/** @param {object} manualSnapshot @param {string} [reference] */
function distanceComparison(manualSnapshot, reference = "MANUAL-HARD-DISTANCE") {
  return {
    comparisonKind: "distance",
    applicationEvidenceId: fixture.distanceSnapshotId,
    manualReference: reference,
    manualSnapshot
  };
}

test("P3-F23 hardening: a non-billing actor cannot create reconciliation evidence", async () => {
  const beforeCount = await pool.query("SELECT count(*)::int AS count FROM mbt_pilot_reconciliation_batches");
  await assert.rejects(
    () => createPilotReconciliationBatch(command(
      "forbidden",
      [distanceComparison(structuredClone(fixture.distanceManualSnapshot))],
      ["driver"]
    )),
    (error) => error?.code === "MBT_RECONCILIATION_FORBIDDEN"
  );
  const afterCount = await pool.query("SELECT count(*)::int AS count FROM mbt_pilot_reconciliation_batches");
  assert.deepEqual(afterCount.rows, beforeCount.rows);
});

test("P3-F24 hardening: hostile distance types are rejected atomically", async () => {
  const beforeCount = await pool.query("SELECT count(*)::int AS count FROM mbt_pilot_reconciliation_batches");
  await assert.rejects(
    () => createPilotReconciliationBatch(command("distance-type", [distanceComparison({
      ...fixture.distanceManualSnapshot,
      rawMetres: String(fixture.distanceManualSnapshot.rawMetres)
    })])),
    (error) => error?.code === "MBT_RECONCILIATION_SNAPSHOT_VALUE_INVALID"
  );
  const afterCount = await pool.query("SELECT count(*)::int AS count FROM mbt_pilot_reconciliation_batches");
  assert.deepEqual(afterCount.rows, beforeCount.rows);
});

test("P3-F24 hardening: the distance audit-note threshold is strictly greater than max(2km, 5%)", async () => {
  const boundary = await createPilotReconciliationBatch(command("distance-boundary", [distanceComparison({
    ...fixture.distanceManualSnapshot,
    rawMetres: fixture.distanceManualSnapshot.rawMetres + 2_000
  }, "MANUAL-HARD-BOUNDARY")]));
  const above = await createPilotReconciliationBatch(command("distance-above", [distanceComparison({
    ...fixture.distanceManualSnapshot,
    rawMetres: fixture.distanceManualSnapshot.rawMetres + 2_001
  }, "MANUAL-HARD-ABOVE")]));

  assert.equal(boundary.body.rows[0].distanceAuditThresholdMetres, 2_000);
  assert.equal(boundary.body.rows[0].requiresAuditNote, false);
  assert.equal(above.body.rows[0].requiresAuditNote, true);
});

test("P3-F23 hardening: a missing evidence item rolls back the complete comparison batch", async () => {
  const beforeCount = await pool.query("SELECT count(*)::int AS count FROM mbt_pilot_reconciliation_batches");
  await assert.rejects(
    () => createPilotReconciliationBatch(command("atomic-missing", [
      distanceComparison(structuredClone(fixture.distanceManualSnapshot)),
      {
        comparisonKind: "movement",
        applicationEvidenceId: crypto.randomUUID(),
        manualReference: "MANUAL-HARD-MISSING",
        manualSnapshot: structuredClone(fixture.movementManualSnapshot)
      }
    ])),
    (error) => error?.code === "MBT_RECONCILIATION_EVIDENCE_NOT_FOUND"
  );
  const afterCount = await pool.query("SELECT count(*)::int AS count FROM mbt_pilot_reconciliation_batches");
  assert.deepEqual(afterCount.rows, beforeCount.rows);
});

test("P3-F23 hardening: exact create retries replay and changed payloads conflict", async () => {
  const references = ["H", "G", "F", "E", "D", "C", "B", "A"];
  const input = command("create-replay", references.map((suffix) => (
    distanceComparison(
      structuredClone(fixture.distanceManualSnapshot),
      `MANUAL-HARD-SORT-${suffix}`
    )
  )));
  const created = await createPilotReconciliationBatch(input);
  assert.deepEqual(
    created.body.rows.map((row) => row.manualReference),
    [...references].sort().map((suffix) => `MANUAL-HARD-SORT-${suffix}`)
  );
  const replayed = await createPilotReconciliationBatch(structuredClone(input));
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.body, created.body);

  const changed = structuredClone(input);
  changed.comparisons[0].manualReference = "MANUAL-HARD-CHANGED";
  await assert.rejects(
    () => createPilotReconciliationBatch(changed),
    (error) => error?.code === "MBT_IDEMPOTENCY_CONFLICT"
  );
});

test("P3-F23 hardening: retained batches are authorized, bounded, and cursor-paginated", async () => {
  const created = await createPilotReconciliationBatch(command(
    "list-retained",
    [distanceComparison(structuredClone(fixture.distanceManualSnapshot))]
  ));
  const first = await listPilotReconciliationBatches({
    actor: billingActor("list-retained"),
    limit: 1
  });
  assert.equal(first.schemaVersion, "mbt-pilot-reconciliation-list-v1");
  assert.equal(first.items.length, 1);
  assert.match(first.items[0].batchId, /^[0-9a-f-]{36}$/u);
  assert.equal(typeof first.items[0].openVarianceCount, "number");
  assert.notEqual(first.nextCursor, null);
  const second = await listPilotReconciliationBatches({
    actor: billingActor("list-retained"),
    cursor: first.nextCursor,
    limit: 1
  });
  assert.notEqual(second.items[0].batchId, first.items[0].batchId);
  const defaultPage = await listPilotReconciliationBatches({ actor: billingActor("list-default") });
  assert.equal(defaultPage.items.length > 0, true);
  const completePage = await listPilotReconciliationBatches({
    actor: billingActor("list-complete"),
    limit: 100
  });
  assert.equal(completePage.nextCursor, null);
  const fetched = await getPilotReconciliationBatch(
    created.body.batchId,
    billingActor("list-retained")
  );
  assert.equal(fetched.batchId, created.body.batchId);
  await assert.rejects(
    () => listPilotReconciliationBatches({ actor: billingActor("list-forbidden", ["driver"]) }),
    (error) => error?.code === "MBT_RECONCILIATION_FORBIDDEN"
  );
  await assert.rejects(
    () => listPilotReconciliationBatches({ actor: billingActor("list-limit"), limit: 0 }),
    (error) => error?.code === "MBT_RECONCILIATION_INPUT_INVALID"
  );
});

test("P3-F23/P3-F24 hardening: billing-line and allocation evidence use the same exact immutable comparator", async () => {
  const created = await createPilotReconciliationBatch(command("financial-evidence", [{
    comparisonKind: "billing_line",
    applicationEvidenceId: billingLineId,
    manualReference: "MANUAL-HARD-BILLING-LINE",
    manualSnapshot: {
      quantity: "1.000000",
      unitAmountMinor: 1000,
      netAmountMinor: 1000,
      estimatedTaxMinor: 130,
      totalAmountMinor: 1130,
      lineKey: "transport:synthetic",
      deduplicationKey: "transport:synthetic"
    }
  }, {
    comparisonKind: "cross_charge_allocation",
    applicationEvidenceId: crossChargeAllocationId,
    manualReference: "MANUAL-HARD-ALLOCATION",
    manualSnapshot: {
      rootReference: null,
      sharedTotalMinor: 1001,
      allocatedAmountMinor: 1001,
      sortedOrdinal: 0,
      deduplicationKey: null
    }
  }]));
  const allocation = created.body.rows.find((row) => row.comparisonKind === "cross_charge_allocation");
  allocation.manualSnapshot.rootReference = allocation.applicationSnapshot.rootReference;
  allocation.manualSnapshot.deduplicationKey = allocation.applicationSnapshot.deduplicationKey;
  const fetched = await getPilotReconciliationBatch(created.body.batchId);
  const retainedAllocation = fetched.rows.find((row) => row.comparisonKind === "cross_charge_allocation");
  assert.equal(created.body.rows[0].comparisonKind, "billing_line");
  assert.equal(created.body.rows[0].comparisonResult, "matched");
  assert.equal(retainedAllocation.comparisonResult, "open_variance");
  assert.equal(retainedAllocation.manualSnapshot.rootReference, null);
  assert.deepEqual(retainedAllocation.differences.map((entry) => entry.field), ["rootReference", "deduplicationKey"]);
});

test("P3-F23/P3-F28 hardening: malformed commands and impossible resolution targets fail closed", async () => {
  await assert.rejects(
    () => createPilotReconciliationBatch(null),
    (error) => error?.code === "MBT_RECONCILIATION_INPUT_INVALID"
  );
  await assert.rejects(
    () => createPilotReconciliationBatch(command("empty", [])),
    (error) => error?.code === "MBT_RECONCILIATION_INPUT_INVALID"
  );
  await assert.rejects(
    () => createPilotReconciliationBatch({ ...command("blank", []), batchReference: " " }),
    (error) => error?.code === "MBT_RECONCILIATION_INPUT_INVALID"
  );
  await assert.rejects(
    () => createPilotReconciliationBatch({ ...command("null-reference", []), batchReference: null }),
    (error) => error?.code === "MBT_RECONCILIATION_INPUT_INVALID"
  );
  const missingRoles = command("missing-roles", [
    distanceComparison(structuredClone(fixture.distanceManualSnapshot))
  ]);
  missingRoles.actor.roles = null;
  await assert.rejects(
    () => createPilotReconciliationBatch(missingRoles),
    (error) => error?.code === "MBT_RECONCILIATION_FORBIDDEN"
  );
  await assert.rejects(
    () => createPilotReconciliationBatch(command("kind", [{
      comparisonKind: "remote_record",
      applicationEvidenceId: crypto.randomUUID(),
      manualReference: "MANUAL-HARD-UNSUPPORTED",
      manualSnapshot: {}
    }])),
    (error) => error?.code === "MBT_RECONCILIATION_KIND_INVALID"
  );
  for (const [identity, manualSnapshot] of [
    ["receipt-decimal", { ...fixture.receiptManualSnapshot, quantity: 2 }],
    ["receipt-measurement", { ...fixture.receiptManualSnapshot, weight: null, quantity: null }],
    ["receipt-overflow", {
      ...fixture.receiptManualSnapshot,
      subtotalMinor: Number.MAX_SAFE_INTEGER,
      taxMinor: 1,
      totalMinor: Number.MAX_SAFE_INTEGER
    }]
  ]) {
    await assert.rejects(
      () => createPilotReconciliationBatch(command(String(identity), [{
        comparisonKind: "receipt",
        applicationEvidenceId: fixture.dumpReceiptId,
        manualReference: `MANUAL-HARD-${identity}`,
        manualSnapshot
      }])),
      (error) => error?.code === "MBT_RECONCILIATION_SNAPSHOT_VALUE_INVALID"
    );
  }
  await assert.rejects(
    () => getPilotReconciliationBatch(crypto.randomUUID()),
    (error) => error?.code === "MBT_RECONCILIATION_BATCH_NOT_FOUND"
  );
  await assert.rejects(
    () => getPilotReconciliationBatch("not-a-uuid"),
    (error) => error?.code === "MBT_RECONCILIATION_INPUT_INVALID"
  );
  assert.throws(
    () => comparePilotEvidence("distance", {
      origin: {}, destination: {}, provider: "synthetic", rawMetres: -1,
      selectedBandId: null, calculatedAmountMinor: 0, currency: "CAD"
    }, {
      origin: {}, destination: {}, provider: "synthetic", rawMetres: 0,
      selectedBandId: null, amountMinor: 0, currency: "CAD"
    }),
    (error) => error?.code === "MBT_RECONCILIATION_DISTANCE_INVALID"
  );
  const resolutionBase = {
    actor: billingActor("invalid-resolution"),
    reconciliationRowId: crypto.randomUUID(),
    note: "Synthetic invalid resolution.",
    correctionReference: null,
    idempotencyKey: `p3.10-hard-invalid-resolution-${crypto.randomUUID()}`,
    correlationId: "p3.10-hard-invalid-resolution-correlation",
    requestId: "p3.10-hard-invalid-resolution-request"
  };
  await assert.rejects(
    () => resolvePilotVariance({ ...resolutionBase, decision: "erase" }),
    (error) => error?.code === "MBT_RECONCILIATION_DECISION_INVALID"
  );
  await assert.rejects(
    () => resolvePilotVariance({ ...resolutionBase, decision: "evidence_only" }),
    (error) => error?.code === "MBT_RECONCILIATION_ROW_NOT_FOUND"
  );
  await assert.rejects(
    () => resolvePilotVariance({ ...resolutionBase, decision: "corrected_manual" }),
    (error) => error?.code === "MBT_RECONCILIATION_CORRECTION_REQUIRED"
  );
});

test("P3-F28 hardening: a matched comparison cannot receive a variance decision", async () => {
  const created = await createPilotReconciliationBatch(command("matched-resolution", [
    distanceComparison(structuredClone(fixture.distanceManualSnapshot))
  ]));
  await assert.rejects(
    () => resolvePilotVariance({
      actor: billingActor("matched-resolution"),
      reconciliationRowId: created.body.rows[0].reconciliationRowId,
      decision: "evidence_only",
      note: "A matched comparison is not a variance.",
      correctionReference: null,
      idempotencyKey: `p3.10-hard-matched-resolution-${crypto.randomUUID()}`,
      correlationId: "p3.10-hard-matched-resolution-correlation",
      requestId: "p3.10-hard-matched-resolution-request"
    }),
    (error) => error?.code === "MBT_RECONCILIATION_NOT_VARIANCE"
  );
});

test("P3-F28 hardening: a correction reference has an explicit kind and UUID entity", async () => {
  const created = await createPilotReconciliationBatch(command("correction-shape", [distanceComparison({
    ...fixture.distanceManualSnapshot,
    amountMinor: fixture.distanceManualSnapshot.amountMinor + 1
  })]));
  await assert.rejects(
    () => resolvePilotVariance({
      actor: billingActor("correction-shape"),
      reconciliationRowId: created.body.rows[0].reconciliationRowId,
      decision: "corrected_application",
      note: "Synthetic correction shape test.",
      correctionReference: {},
      idempotencyKey: `p3.10-hard-resolve-shape-${crypto.randomUUID()}`,
      correlationId: "p3.10-hard-resolve-shape-correlation",
      requestId: "p3.10-hard-resolve-shape-request"
    }),
    (error) => error?.code === "MBT_RECONCILIATION_CORRECTION_INVALID"
  );
  await assert.rejects(
    () => resolvePilotVariance({
      actor: billingActor("correction-kind"),
      reconciliationRowId: created.body.rows[0].reconciliationRowId,
      decision: "corrected_application",
      note: "Synthetic correction kind test.",
      correctionReference: { kind: "bad kind", entityId: crypto.randomUUID() },
      idempotencyKey: `p3.10-hard-resolve-kind-${crypto.randomUUID()}`,
      correlationId: "p3.10-hard-resolve-kind-correlation",
      requestId: "p3.10-hard-resolve-kind-request"
    }),
    (error) => error?.code === "MBT_RECONCILIATION_CORRECTION_INVALID"
  );
});

test("P3-F28 hardening: independent concurrent resolutions append exactly one immutable decision", async () => {
  const created = await createPilotReconciliationBatch(command("resolution-race", [distanceComparison({
    ...fixture.distanceManualSnapshot,
    amountMinor: fixture.distanceManualSnapshot.amountMinor + 1
  })]));
  const reconciliationRowId = created.body.rows[0].reconciliationRowId;
  const raceIdentity = crypto.randomUUID();
  const attempts = await Promise.allSettled(Array.from({ length: 15 }, (_entry, index) => (
    resolvePilotVariance({
      actor: billingActor(`resolution-race-${index}`),
      reconciliationBatchId: created.body.batchId,
      reconciliationRowId,
      decision: "evidence_only",
      note: `Synthetic concurrent resolution ${index}.`,
      correctionReference: null,
      idempotencyKey: `p3.10-hard-resolution-race-${raceIdentity}-${index}`,
      correlationId: `p3.10-hard-resolution-race-correlation-${raceIdentity}-${index}`,
      requestId: `p3.10-hard-resolution-race-request-${raceIdentity}-${index}`
    })
  )));
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  const expectedRejections = attempts.filter((attempt) => (
    attempt.status === "rejected"
    && attempt.reason?.code === "MBT_RECONCILIATION_ALREADY_RESOLVED"
  ));
  const unexpectedRejections = attempts.filter((attempt) => (
    attempt.status === "rejected"
    && attempt.reason?.code !== "MBT_RECONCILIATION_ALREADY_RESOLVED"
  ));
  assert.deepEqual(
    unexpectedRejections.map((attempt) => ({
      code: attempt.reason?.code || null,
      message: String(attempt.reason?.message || attempt.reason)
    })),
    []
  );
  assert.equal(expectedRejections.length, 14);
  const stored = await pool.query(
    "SELECT count(*)::int AS count FROM mbt_pilot_reconciliation_resolutions WHERE reconciliation_row_id = $1",
    [reconciliationRowId]
  );
  assert.deepEqual(stored.rows, [{ count: 1 }]);
});

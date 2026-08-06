// @ts-check

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import pg from "pg";

import { billingActor, createBillingFixture } from "../support/billing-fixtures.js";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const SERVICE_PATH = "../../../src/mbt/" + "pilot-reconciliation-service.js";
const serviceModule = /** @type {Record<string, Function>} */ (await import(SERVICE_PATH)
  .catch((importError) => ({ importError })));

let fixture;

/** @param {string} name */
function requiredOperation(name) {
  const operation = serviceModule[name];
  assert.equal(typeof operation, "function", `P3.10 requires pilot-reconciliation-service.${name}.`);
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

/** @param {string} identity @param {object[]} comparisons */
function batchCommand(identity, comparisons) {
  return {
    actor: billingActor(identity),
    batchReference: `P3.10-${identity}`,
    manualSource: "synthetic_manual_ledger",
    comparisons,
    reason: `Synthetic reconciliation ${identity}`,
    idempotencyKey: `p3.10-reconcile-${identity}`,
    correlationId: `p3.10-correlation-${identity}`,
    requestId: `p3.10-request-${identity}`
  };
}

function exactComparisons() {
  return [{
    comparisonKind: "movement",
    applicationEvidenceId: fixture.movementId,
    manualReference: "MANUAL-MOVEMENT-1",
    manualSnapshot: structuredClone(fixture.movementManualSnapshot)
  }, {
    comparisonKind: "receipt",
    applicationEvidenceId: fixture.dumpReceiptId,
    manualReference: "MANUAL-RECEIPT-1",
    manualSnapshot: structuredClone(fixture.receiptManualSnapshot)
  }, {
    comparisonKind: "distance",
    applicationEvidenceId: fixture.distanceSnapshotId,
    manualReference: "MANUAL-DISTANCE-1",
    manualSnapshot: structuredClone(fixture.distanceManualSnapshot)
  }];
}

test("P3-F23/P3-F24 exact application and manual evidence is stored separately and immutable", async () => {
  const createPilotReconciliationBatch = requiredOperation("createPilotReconciliationBatch");
  const beforeMovement = await pool.query(
    "SELECT to_jsonb(movement.*) AS row FROM mbt_bin_movements movement WHERE movement_id = $1",
    [fixture.movementId]
  );
  const result = await createPilotReconciliationBatch(batchCommand("exact", exactComparisons()));

  assert.equal(result.status, 201);
  assert.equal(result.replayed, false);
  assert.equal(result.body.schemaVersion, "mbt-pilot-reconciliation-v1");
  assert.deepEqual(result.body.rows.map((row) => ({
    comparisonKind: row.comparisonKind,
    comparisonResult: row.comparisonResult,
    blocking: row.blocking,
    requiresAuditNote: row.requiresAuditNote
  })), [
    { comparisonKind: "distance", comparisonResult: "matched", blocking: false, requiresAuditNote: false },
    { comparisonKind: "movement", comparisonResult: "matched", blocking: false, requiresAuditNote: false },
    { comparisonKind: "receipt", comparisonResult: "matched", blocking: false, requiresAuditNote: false }
  ]);
  for (const row of result.body.rows) {
    assert.match(row.applicationSnapshotHash, /^[0-9a-f]{64}$/);
    assert.match(row.manualSnapshotHash, /^[0-9a-f]{64}$/);
    assert.notStrictEqual(row.applicationSnapshot, row.manualSnapshot);
  }

  const stored = await pool.query(
    `SELECT reconciliation_row_id
       FROM mbt_pilot_reconciliation_rows
      WHERE reconciliation_batch_id = $1
      ORDER BY reconciliation_row_id
      LIMIT 1`,
    [result.body.batchId]
  );
  await assert.rejects(
    () => pool.query(
      "UPDATE mbt_pilot_reconciliation_rows SET manual_reference = 'rewritten' WHERE reconciliation_row_id = $1",
      [stored.rows[0].reconciliation_row_id]
    ),
    (error) => error?.code === "55000"
  );
  const afterMovement = await pool.query(
    "SELECT to_jsonb(movement.*) AS row FROM mbt_bin_movements movement WHERE movement_id = $1",
    [fixture.movementId]
  );
  assert.deepEqual(afterMovement.rows, beforeMovement.rows);
});

test("P3-F24 money/band differences block and a >max(2km,5%) distance delta requires a note", async () => {
  const createPilotReconciliationBatch = requiredOperation("createPilotReconciliationBatch");
  const comparisons = exactComparisons();
  comparisons[1].manualSnapshot = {
    ...comparisons[1].manualSnapshot,
    totalMinor: fixture.receiptManualSnapshot.totalMinor + 1
  };
  comparisons[2].manualSnapshot = {
    ...comparisons[2].manualSnapshot,
    rawMetres: fixture.distanceManualSnapshot.rawMetres + 2_501
  };
  const result = await createPilotReconciliationBatch(batchCommand("variance", comparisons));
  const receipt = result.body.rows.find((row) => row.comparisonKind === "receipt");
  const distance = result.body.rows.find((row) => row.comparisonKind === "distance");

  assert.equal(receipt.comparisonResult, "open_variance");
  assert.equal(receipt.blocking, true);
  assert.deepEqual(receipt.differences, [{
    field: "totalMinor",
    application: 4_200,
    manual: 4_201,
    category: "money"
  }]);
  assert.equal(distance.comparisonResult, "open_variance");
  assert.equal(distance.blocking, true);
  assert.equal(distance.requiresAuditNote, true);
  assert.equal(distance.distanceDeltaMetres, 2_501);
  assert.equal(distance.distanceAuditThresholdMetres, 2_000);
  assert.deepEqual(distance.differences.map((entry) => entry.field), ["rawMetres"]);
});

test("P3-F23 movement mismatch opens a variance and its resolution cannot rewrite the ledger", async () => {
  const createPilotReconciliationBatch = requiredOperation("createPilotReconciliationBatch");
  const resolvePilotVariance = requiredOperation("resolvePilotVariance");
  const getPilotReconciliationBatch = requiredOperation("getPilotReconciliationBatch");
  const comparison = exactComparisons()[0];
  comparison.manualSnapshot = {
    ...comparison.manualSnapshot,
    afterLocationReference: "MANUAL-OTHER-YARD"
  };
  const created = await createPilotReconciliationBatch(batchCommand("movement-variance", [comparison]));
  const row = created.body.rows[0];
  const movementBefore = await pool.query(
    "SELECT to_jsonb(movement.*) AS row FROM mbt_bin_movements movement WHERE movement_id = $1",
    [fixture.movementId]
  );
  const resolved = await resolvePilotVariance({
    actor: billingActor("movement-resolution"),
    reconciliationRowId: row.reconciliationRowId,
    decision: "evidence_only",
    note: "Synthetic manual location was independently reviewed.",
    correctionReference: null,
    idempotencyKey: "p3.10-resolution-movement",
    correlationId: "p3.10-resolution-correlation",
    requestId: "p3.10-resolution-request"
  });

  assert.equal(resolved.body.decision, "evidence_only");
  assert.equal(resolved.body.applicationSnapshotHash, row.applicationSnapshotHash);
  assert.equal(resolved.body.manualSnapshotHash, row.manualSnapshotHash);
  const fetched = await getPilotReconciliationBatch(created.body.batchId);
  assert.equal(fetched.rows[0].effectiveResult, "evidence_only");
  assert.equal(fetched.rows[0].resolution.note, "Synthetic manual location was independently reviewed.");
  const movementAfter = await pool.query(
    "SELECT to_jsonb(movement.*) AS row FROM mbt_bin_movements movement WHERE movement_id = $1",
    [fixture.movementId]
  );
  assert.deepEqual(movementAfter.rows, movementBefore.rows);
  await assert.rejects(
    () => pool.query(
      "UPDATE mbt_pilot_reconciliation_resolutions SET note = 'rewritten' WHERE reconciliation_resolution_id = $1",
      [resolved.body.resolutionId]
    ),
    (error) => error?.code === "55000"
  );
});

test("P3-F28 corrected decisions require append-only correction lineage and retain both originals", async () => {
  const createPilotReconciliationBatch = requiredOperation("createPilotReconciliationBatch");
  const resolvePilotVariance = requiredOperation("resolvePilotVariance");
  const comparisons = exactComparisons();
  comparisons[2].manualSnapshot = {
    ...comparisons[2].manualSnapshot,
    selectedBandId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    amountMinor: 12_001
  };
  const created = await createPilotReconciliationBatch(batchCommand("corrected", [comparisons[2]]));
  const row = created.body.rows[0];
  const command = {
    actor: billingActor("corrected-resolution"),
    reconciliationRowId: row.reconciliationRowId,
    decision: "corrected_application",
    note: "A new local billing version carries the correction.",
    correctionReference: null,
    idempotencyKey: "p3.10-resolution-corrected",
    correlationId: "p3.10-resolution-corrected-correlation",
    requestId: "p3.10-resolution-corrected-request"
  };
  await assert.rejects(
    () => resolvePilotVariance(command),
    (error) => error?.code === "MBT_RECONCILIATION_CORRECTION_REQUIRED"
  );
  const correctionReference = {
    kind: "billing_version",
    entityId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
  };
  const resolved = await resolvePilotVariance({ ...command, correctionReference });
  assert.deepEqual(resolved.body.correctionReference, correctionReference);
  const originals = await pool.query(
    `SELECT application_snapshot, manual_snapshot,
            application_snapshot_hash, manual_snapshot_hash
       FROM mbt_pilot_reconciliation_rows
      WHERE reconciliation_row_id = $1`,
    [row.reconciliationRowId]
  );
  assert.equal(originals.rows[0].application_snapshot_hash, row.applicationSnapshotHash);
  assert.equal(originals.rows[0].manual_snapshot_hash, row.manualSnapshotHash);
  assert.equal(originals.rows[0].application_snapshot.calculatedAmountMinor, 12_000);
  assert.equal(originals.rows[0].manual_snapshot.amountMinor, 12_001);
});

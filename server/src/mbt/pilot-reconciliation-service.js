// @ts-check

import crypto from "node:crypto";

import { query } from "../db.js";
import { canonicalSha256, canonicalize } from "./canonical-json.js";
import { executeMbtCommand } from "./command-repository.js";
import { MbtError } from "./errors.js";

/** @typedef {"movement" | "receipt" | "distance" | "billing_line" | "cross_charge_allocation"} ComparisonKind */
/** @typedef {import("./audit-repository.js").MbtActor} MbtActor */

const FIELD_RULES = Object.freeze({
  movement: Object.freeze([
    ["assetId", "assetId", "evidence"],
    ["assetSequence", "assetSequence", "evidence"],
    ["beforeStatus", "beforeStatus", "evidence"],
    ["afterStatus", "afterStatus", "evidence"],
    ["beforeLocationKind", "beforeLocationKind", "evidence"],
    ["beforeLocationReference", "beforeLocationReference", "evidence"],
    ["afterLocationKind", "afterLocationKind", "evidence"],
    ["afterLocationReference", "afterLocationReference", "evidence"],
    ["truckId", "truckId", "evidence"],
    ["driverId", "driverId", "evidence"],
    ["visitId", "visitId", "evidence"],
    ["occurredAt", "occurredAt", "evidence"]
  ]),
  receipt: Object.freeze([
    ["ticketNumber", "ticketNumber", "evidence"],
    ["dumpSiteId", "dumpSiteId", "evidence"],
    ["materialId", "materialId", "evidence"],
    ["weight", "weight", "quantity"],
    ["quantity", "quantity", "quantity"],
    ["unitOfMeasure", "unitOfMeasure", "quantity"],
    ["subtotalMinor", "subtotalMinor", "money"],
    ["taxMinor", "taxMinor", "money"],
    ["totalMinor", "totalMinor", "money"],
    ["currency", "currency", "money"]
  ]),
  distance: Object.freeze([
    ["origin", "origin", "route"],
    ["destination", "destination", "route"],
    ["provider", "provider", "route"],
    ["rawMetres", "rawMetres", "distance"],
    ["selectedBandId", "selectedBandId", "band"],
    ["calculatedAmountMinor", "amountMinor", "money"],
    ["currency", "currency", "money"]
  ]),
  billing_line: Object.freeze([
    ["quantity", "quantity", "quantity"],
    ["unitAmountMinor", "unitAmountMinor", "money"],
    ["netAmountMinor", "netAmountMinor", "money"],
    ["estimatedTaxMinor", "estimatedTaxMinor", "money"],
    ["totalAmountMinor", "totalAmountMinor", "money"],
    ["lineKey", "lineKey", "evidence"],
    ["deduplicationKey", "deduplicationKey", "dedupe"]
  ]),
  cross_charge_allocation: Object.freeze([
    ["rootReference", "rootReference", "evidence"],
    ["sharedTotalMinor", "sharedTotalMinor", "money"],
    ["allocatedAmountMinor", "allocatedAmountMinor", "allocation"],
    ["sortedOrdinal", "sortedOrdinal", "allocation"],
    ["deduplicationKey", "deduplicationKey", "dedupe"]
  ])
});

/** @param {number} status @param {string} code @param {string} message */
function failure(status, code, message) {
  return new MbtError({ status, code, message });
}

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw failure(400, "MBT_RECONCILIATION_INPUT_INVALID", `${label} is required.`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw failure(400, "MBT_RECONCILIATION_INPUT_INVALID", `${label} is required.`);
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} value @param {string} label */
function uuid(value, label) {
  const normalized = requiredText(value, label).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)) {
    throw failure(400, "MBT_RECONCILIATION_INPUT_INVALID", `${label} must be a UUID.`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function snapshot(value, label) {
  const normalized = canonicalize(requiredObject(value, label));
  return /** @type {Record<string, any>} */ (normalized);
}

/** @param {Record<string, any>} actor */
function assertBillingActor(actor) {
  const roles = Array.isArray(actor.roles)
    ? actor.roles.map((role) => String(role).trim().toLowerCase()).filter(Boolean)
    : [];
  if (!roles.includes("admin") && !roles.includes("mbt_billing")) {
    throw failure(403, "MBT_RECONCILIATION_FORBIDDEN", "An MBT Billing or Admin actor is required.");
  }
}

/** @param {unknown} value @param {string} label @param {number} [minimum] */
function snapshotInteger(value, label, minimum = 0) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw failure(
      400,
      "MBT_RECONCILIATION_SNAPSHOT_VALUE_INVALID",
      `${label} must be a safe integer of at least ${minimum}.`
    );
  }
  return value;
}

/** @param {unknown} value @param {string} label */
function snapshotDecimal(value, label) {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/u.test(value)) {
    throw failure(
      400,
      "MBT_RECONCILIATION_SNAPSHOT_VALUE_INVALID",
      `${label} must be a non-negative decimal string with no more than six places.`
    );
  }
  return value;
}

/** @param {Record<string, any>} manual */
function validateReceiptSnapshot(manual) {
  const weight = snapshotDecimal(manual.weight, "Manual receipt weight");
  const quantity = snapshotDecimal(manual.quantity, "Manual receipt quantity");
  if (weight === null && quantity === null) {
    throw failure(400, "MBT_RECONCILIATION_SNAPSHOT_VALUE_INVALID", "Manual receipt weight or quantity is required.");
  }
  const subtotal = snapshotInteger(manual.subtotalMinor, "Manual receipt subtotal");
  const tax = snapshotInteger(manual.taxMinor, "Manual receipt tax");
  const total = snapshotInteger(manual.totalMinor, "Manual receipt total");
  if (!Number.isSafeInteger(subtotal + tax) || !Number.isSafeInteger(total)) {
    throw failure(400, "MBT_RECONCILIATION_SNAPSHOT_VALUE_INVALID", "Manual receipt money exceeds the safe-integer range.");
  }
}

/** @param {string} kind @param {Record<string, any>} manual */
function validateManualSnapshot(kind, manual) {
  if (kind === "receipt") {
    validateReceiptSnapshot(manual);
  } else if (kind === "distance") {
    snapshotInteger(manual.rawMetres, "Manual raw distance");
    snapshotInteger(manual.amountMinor, "Manual distance amount");
  } else if (kind === "movement") {
    snapshotInteger(manual.assetSequence, "Manual asset sequence", 1);
  }
}

/** @param {Record<string, any>} reference */
function correctionReference(reference) {
  const keys = Object.keys(reference).sort();
  if (keys.length !== 2 || keys[0] !== "entityId" || keys[1] !== "kind") {
    throw failure(
      400,
      "MBT_RECONCILIATION_CORRECTION_INVALID",
      "A correction reference must contain exactly kind and entityId."
    );
  }
  const kind = requiredText(reference.kind, "Correction reference kind").toLowerCase();
  if (!/^[a-z][a-z0-9_]*$/u.test(kind)) {
    throw failure(400, "MBT_RECONCILIATION_CORRECTION_INVALID", "The correction reference kind is invalid.");
  }
  return { kind, entityId: uuid(reference.entityId, "Correction reference entity ID") };
}

/** @param {unknown} value @returns {ComparisonKind} */
function comparisonKind(value) {
  const kind = requiredText(value, "Comparison kind");
  if (!Object.hasOwn(FIELD_RULES, kind)) {
    throw failure(400, "MBT_RECONCILIATION_KIND_INVALID", "The comparison kind is not supported.");
  }
  return /** @type {ComparisonKind} */ (kind);
}

/** @param {unknown} value */
function databaseIso(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

/** @param {unknown} value */
function nullableText(value) {
  return value === null || value === undefined ? null : String(value);
}

/** @param {string} kind @param {string} evidenceId */
async function loadApplicationEvidence(kind, evidenceId) {
  let result;
  if (kind === "movement") {
    result = await query(
      `SELECT asset_id::text AS "assetId", asset_sequence::int AS "assetSequence",
              before_status AS "beforeStatus", after_status AS "afterStatus",
              before_location_kind AS "beforeLocationKind",
              before_location_reference AS "beforeLocationReference",
              after_location_kind AS "afterLocationKind",
              after_location_reference AS "afterLocationReference",
              truck_id::text AS "truckId", driver_id::text AS "driverId",
              service_visit_id::text AS "visitId", occurred_at AS "occurredAt"
         FROM mbt_bin_movements
        WHERE movement_id = $1`,
      [evidenceId]
    );
  } else if (kind === "receipt") {
    result = await query(
      `SELECT ticket_number AS "ticketNumber", dump_site_id::text AS "dumpSiteId",
              material_id::text AS "materialId", weight::text AS weight,
              quantity::text AS quantity, unit_of_measure AS "unitOfMeasure",
              subtotal_minor::int AS "subtotalMinor", tax_minor::int AS "taxMinor",
              total_minor::int AS "totalMinor", currency
         FROM mbt_dump_receipts
        WHERE dump_receipt_id = $1`,
      [evidenceId]
    );
  } else if (kind === "distance") {
    result = await query(
      `SELECT distance_snapshot_id::text AS "distanceSnapshotId",
              origin_snapshot AS origin, destination_snapshot AS destination,
              provider, provider_metres::int AS "rawMetres",
              rate_distance_band_id::text AS "selectedBandId",
              calculated_amount_minor::int AS "calculatedAmountMinor", currency
         FROM mbt_distance_snapshots
        WHERE distance_snapshot_id = $1`,
      [evidenceId]
    );
  } else if (kind === "billing_line") {
    result = await query(
      `SELECT quantity::text AS quantity,
              unit_amount_minor::int AS "unitAmountMinor",
              net_amount_minor::int AS "netAmountMinor",
              estimated_tax_minor::int AS "estimatedTaxMinor",
              total_amount_minor::int AS "totalAmountMinor",
              line_key AS "lineKey", deduplication_key AS "deduplicationKey"
         FROM mbt_billing_lines
        WHERE billing_line_id = $1`,
      [evidenceId]
    );
  } else {
    result = await query(
      `SELECT allocation.root_reference AS "rootReference",
              allocation.shared_total_minor::int AS "sharedTotalMinor",
              allocation.allocated_amount_minor::int AS "allocatedAmountMinor",
              allocation.sorted_ordinal AS "sortedOrdinal",
              cross_charge.deduplication_key AS "deduplicationKey"
         FROM mbt_cross_charge_allocations allocation
         JOIN mbt_cross_charge_cases cross_charge USING (cross_charge_case_id)
        WHERE allocation.cross_charge_allocation_id = $1`,
      [evidenceId]
    );
  }
  if (!result.rowCount) {
    throw failure(404, "MBT_RECONCILIATION_EVIDENCE_NOT_FOUND", "Application comparison evidence was not found.");
  }
  const row = { ...result.rows[0] };
  if (kind === "movement") {
    row.truckId = nullableText(row.truckId);
    row.driverId = nullableText(row.driverId);
    row.visitId = nullableText(row.visitId);
    row.occurredAt = databaseIso(row.occurredAt);
  }
  return snapshot(row, "Application snapshot");
}

/** @param {unknown} left @param {unknown} right */
function equalEvidence(left, right) {
  return canonicalSha256(left) === canonicalSha256(right);
}

/**
 * @param {readonly (readonly string[])[]} rules
 * @param {Record<string, any>} application
 * @param {Record<string, any>} manual
 */
function evidenceDifferences(rules, application, manual) {
  const differences = [];
  for (const rule of rules) {
    const applicationField = rule[0];
    const manualField = rule[1];
    const category = rule[2];
    if (!applicationField || !manualField || !category) {
      throw new TypeError("A pilot reconciliation field rule is incomplete.");
    }
    if (!equalEvidence(application[applicationField], manual[manualField])) {
      differences.push({
        field: manualField,
        application: application[applicationField] ?? null,
        manual: manual[manualField] ?? null,
        category
      });
    }
  }
  return differences;
}

/**
 * @param {string} kind
 * @param {Record<string, any>} application
 * @param {Record<string, any>} manual
 */
function distanceComparison(kind, application, manual) {
  if (kind !== "distance") {
    return {
      requiresAuditNote: false,
      distanceDeltaMetres: null,
      distanceAuditThresholdMetres: null
    };
  }
  const applicationMetres = Number(application.rawMetres);
  const manualMetres = Number(manual.rawMetres);
  if (!Number.isSafeInteger(applicationMetres) || applicationMetres < 0
      || !Number.isSafeInteger(manualMetres) || manualMetres < 0) {
    throw failure(400, "MBT_RECONCILIATION_DISTANCE_INVALID", "Distance evidence must use non-negative integer metres.");
  }
  const distanceDeltaMetres = Math.abs(applicationMetres - manualMetres);
  const distanceAuditThresholdMetres = Math.max(2_000, Math.ceil(applicationMetres * 0.05));
  return {
    requiresAuditNote: distanceDeltaMetres > distanceAuditThresholdMetres,
    distanceDeltaMetres,
    distanceAuditThresholdMetres
  };
}

/**
 * Pure exact comparison used by the batch service and focused mutation tests.
 *
 * @param {string} kind
 * @param {Record<string, any>} application
 * @param {Record<string, any>} manual
 */
export function comparePilotEvidence(kind, application, manual) {
  const rules = FIELD_RULES[comparisonKind(kind)];
  const differences = evidenceDifferences(rules, application, manual);
  const distance = distanceComparison(kind, application, manual);
  return {
    comparisonResult: differences.length === 0 ? "matched" : "open_variance",
    differences,
    blocking: differences.length > 0,
    ...distance
  };
}

/** @param {Record<string, any>} row */
function publicRow(row) {
  return {
    reconciliationRowId: String(row.reconciliation_row_id),
    comparisonKind: String(row.comparison_kind),
    applicationEvidenceId: String(row.application_evidence_id),
    manualReference: String(row.manual_reference),
    applicationSnapshot: row.application_snapshot,
    manualSnapshot: row.manual_snapshot,
    applicationSnapshotHash: String(row.application_snapshot_hash),
    manualSnapshotHash: String(row.manual_snapshot_hash),
    comparisonResult: String(row.comparison_result),
    effectiveResult: row.decision ? String(row.decision) : String(row.comparison_result),
    differences: row.differences,
    blocking: row.blocking === true,
    requiresAuditNote: row.requires_audit_note === true,
    distanceDeltaMetres: row.distance_delta_metres === null ? null : Number(row.distance_delta_metres),
    distanceAuditThresholdMetres: row.distance_audit_threshold_metres === null
      ? null
      : Number(row.distance_audit_threshold_metres),
    resolution: row.decision ? {
      resolutionId: String(row.reconciliation_resolution_id),
      decision: String(row.decision),
      note: String(row.note),
      decidedBy: String(row.decided_by),
      decidedAt: databaseIso(row.decided_at),
      correctionReference: row.correction_reference
    } : null
  };
}

const RECONCILIATION_ROW_COLUMNS = `
  reconciliation_row.reconciliation_row_id,
  reconciliation_row.comparison_kind,
  reconciliation_row.application_evidence_id,
  reconciliation_row.manual_reference,
  reconciliation_row.application_snapshot,
  reconciliation_row.manual_snapshot,
  reconciliation_row.application_snapshot_hash,
  reconciliation_row.manual_snapshot_hash,
  reconciliation_row.comparison_result,
  reconciliation_row.differences,
  reconciliation_row.blocking,
  reconciliation_row.requires_audit_note,
  reconciliation_row.distance_delta_metres,
  reconciliation_row.distance_audit_threshold_metres,
  resolution.reconciliation_resolution_id,
  resolution.decision,
  resolution.note,
  resolution.decided_by,
  resolution.decided_at,
  resolution.correction_reference`;

/** @param {string} batchId */
async function selectedBatchRows(batchId) {
  const result = await query(
    `SELECT ${RECONCILIATION_ROW_COLUMNS}
       FROM mbt_pilot_reconciliation_rows reconciliation_row
       LEFT JOIN mbt_pilot_reconciliation_resolutions resolution
         USING (reconciliation_row_id)
      WHERE reconciliation_row.reconciliation_batch_id = $1
      ORDER BY reconciliation_row.comparison_kind,
               reconciliation_row.application_evidence_id,
               reconciliation_row.manual_reference,
               reconciliation_row.reconciliation_row_id`,
    [batchId]
  );
  return result.rows.map(publicRow);
}

/**
 * @param {unknown} rawInput
 */
export async function createPilotReconciliationBatch(rawInput) {
  const input = requiredObject(rawInput, "Reconciliation batch");
  const actor = /** @type {MbtActor} */ (requiredObject(input.actor, "Reconciliation actor"));
  assertBillingActor(actor);
  const batchReference = requiredText(input.batchReference, "Batch reference");
  const manualSource = requiredText(input.manualSource, "Manual source");
  const reason = requiredText(input.reason, "Reconciliation reason");
  if (!Array.isArray(input.comparisons) || input.comparisons.length === 0) {
    throw failure(400, "MBT_RECONCILIATION_INPUT_INVALID", "At least one comparison is required.");
  }
  const comparisons = input.comparisons.map((comparison) => {
    const row = requiredObject(comparison, "Comparison");
    const kind = comparisonKind(row.comparisonKind);
    const manualSnapshot = snapshot(row.manualSnapshot, "Manual snapshot");
    validateManualSnapshot(kind, manualSnapshot);
    return {
      comparisonKind: kind,
      applicationEvidenceId: uuid(row.applicationEvidenceId, "Application evidence ID"),
      manualReference: requiredText(row.manualReference, "Manual reference"),
      manualSnapshot
    };
  }).sort((left, right) => left.comparisonKind.localeCompare(right.comparisonKind)
    || left.applicationEvidenceId.localeCompare(right.applicationEvidenceId)
    || left.manualReference.localeCompare(right.manualReference));
  const payload = { batchReference, manualSource, comparisons, reason };
  return executeMbtCommand({
    actor: /** @type {import("./audit-repository.js").MbtActor} */ (actor),
    commandName: "mbt.reconciliation.batch.create",
    idempotencyKey: requiredText(input.idempotencyKey, "Idempotency key"),
    payload,
    correlationId: requiredText(input.correlationId, "Correlation ID"),
    requestId: requiredText(input.requestId, "Request ID"),
    mutation: async () => {
      const batchId = crypto.randomUUID();
      await query(
        `INSERT INTO mbt_pilot_reconciliation_batches (
           reconciliation_batch_id, batch_reference, manual_source,
           created_by, reason
         ) VALUES ($1, $2, $3, $4, $5)`,
        [batchId, batchReference, manualSource, requiredText(actor.operatorId, "Actor ID"), reason]
      );
      for (const comparison of comparisons) {
        const applicationSnapshot = await loadApplicationEvidence(
          comparison.comparisonKind,
          comparison.applicationEvidenceId
        );
        const compared = comparePilotEvidence(
          comparison.comparisonKind,
          applicationSnapshot,
          comparison.manualSnapshot
        );
        await query(
          `INSERT INTO mbt_pilot_reconciliation_rows (
             reconciliation_row_id, reconciliation_batch_id, comparison_kind,
             application_evidence_id, manual_reference, application_snapshot,
             manual_snapshot, application_snapshot_hash, manual_snapshot_hash,
             comparison_result, differences, blocking, requires_audit_note,
             distance_delta_metres, distance_audit_threshold_metres
           ) VALUES (
             $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9,
             $10, $11::jsonb, $12, $13, $14, $15
           )`,
          [
            crypto.randomUUID(),
            batchId,
            comparison.comparisonKind,
            comparison.applicationEvidenceId,
            comparison.manualReference,
            JSON.stringify(applicationSnapshot),
            JSON.stringify(comparison.manualSnapshot),
            canonicalSha256(applicationSnapshot),
            canonicalSha256(comparison.manualSnapshot),
            compared.comparisonResult,
            JSON.stringify(compared.differences),
            compared.blocking,
            compared.requiresAuditNote,
            compared.distanceDeltaMetres,
            compared.distanceAuditThresholdMetres
          ]
        );
      }
      const rows = await selectedBatchRows(batchId);
      return {
        status: 201,
        body: {
          schemaVersion: "mbt-pilot-reconciliation-v1",
          batchId,
          batchReference,
          manualSource,
          rows
        },
        audit: {
          action: "mbt.reconciliation.batch.created",
          entityType: "mbt_pilot_reconciliation_batch",
          entityId: batchId,
          beforeState: { exists: false },
          afterState: { batchReference, manualSource, rowCount: rows.length },
          reason,
          revisionBefore: 1,
          revisionAfter: 1,
          source: "p3_local_reconciliation"
        }
      };
    }
  });
}

/** @param {unknown} value */
function reconciliationListLimit(value) {
  const normalized = value === undefined ? 50 : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > 100) {
    throw failure(400, "MBT_RECONCILIATION_INPUT_INVALID", "Reconciliation list limit must be an integer from 1 through 100.");
  }
  return normalized;
}

/**
 * List retained comparison batches without consulting the operational gate.
 * Closing creation/resolution must not hide already captured pilot evidence.
 *
 * @param {unknown} [rawInput]
 */
export async function listPilotReconciliationBatches(rawInput = {}) {
  const input = requiredObject(rawInput, "Reconciliation list request");
  const actor = requiredObject(input.actor, "Reconciliation actor");
  assertBillingActor(actor);
  requiredText(actor.operatorId, "Actor ID");
  const cursor = input.cursor === undefined || input.cursor === null || input.cursor === ""
    ? null
    : uuid(input.cursor, "Reconciliation cursor");
  const limit = reconciliationListLimit(input.limit);
  const result = await query(
    `SELECT batch.reconciliation_batch_id, batch.batch_reference,
            batch.manual_source, batch.created_by, batch.reason,
            batch.created_at,
            count(reconciliation_row.reconciliation_row_id)::int AS row_count,
            count(*) FILTER (
              WHERE reconciliation_row.comparison_result = 'open_variance'
                AND reconciliation_row.blocking
                AND resolution.reconciliation_resolution_id IS NULL
            )::int AS open_variance_count
       FROM mbt_pilot_reconciliation_batches batch
       LEFT JOIN mbt_pilot_reconciliation_rows reconciliation_row
         USING (reconciliation_batch_id)
       LEFT JOIN mbt_pilot_reconciliation_resolutions resolution
         USING (reconciliation_row_id)
      WHERE ($1::uuid IS NULL OR batch.reconciliation_batch_id > $1)
      GROUP BY batch.reconciliation_batch_id
      ORDER BY batch.reconciliation_batch_id
      LIMIT $2`,
    [cursor, limit + 1]
  );
  const hasMore = result.rows.length > limit;
  const items = result.rows.slice(0, limit).map((/** @type {Record<string, any>} */ row) => ({
    batchId: String(row.reconciliation_batch_id),
    batchReference: String(row.batch_reference),
    manualSource: String(row.manual_source),
    createdBy: String(row.created_by),
    reason: String(row.reason),
    createdAt: databaseIso(row.created_at),
    rowCount: Number(row.row_count),
    openVarianceCount: Number(row.open_variance_count)
  }));
  return {
    schemaVersion: "mbt-pilot-reconciliation-list-v1",
    items,
    nextCursor: hasMore ? items.at(-1)?.batchId ?? null : null
  };
}

/** @param {string} batchId @param {unknown} [actor] */
export async function getPilotReconciliationBatch(batchId, actor) {
  if (actor !== undefined) {
    const suppliedActor = requiredObject(actor, "Reconciliation actor");
    assertBillingActor(suppliedActor);
    requiredText(suppliedActor.operatorId, "Actor ID");
  }
  const normalizedBatchId = uuid(batchId, "Reconciliation batch ID");
  const batch = await query(
    `SELECT reconciliation_batch_id, batch_reference, manual_source,
            created_by, reason, created_at
       FROM mbt_pilot_reconciliation_batches
      WHERE reconciliation_batch_id = $1`,
    [normalizedBatchId]
  );
  if (!batch.rowCount) {
    throw failure(404, "MBT_RECONCILIATION_BATCH_NOT_FOUND", "The reconciliation batch was not found.");
  }
  return {
    schemaVersion: "mbt-pilot-reconciliation-v1",
    batchId: String(batch.rows[0].reconciliation_batch_id),
    batchReference: String(batch.rows[0].batch_reference),
    manualSource: String(batch.rows[0].manual_source),
    createdBy: String(batch.rows[0].created_by),
    reason: String(batch.rows[0].reason),
    createdAt: databaseIso(batch.rows[0].created_at),
    rows: await selectedBatchRows(normalizedBatchId)
  };
}

/** @param {unknown} rawInput */
export async function resolvePilotVariance(rawInput) {
  const input = requiredObject(rawInput, "Variance resolution");
  const actor = /** @type {MbtActor} */ (requiredObject(input.actor, "Resolution actor"));
  assertBillingActor(actor);
  const reconciliationRowId = uuid(input.reconciliationRowId, "Reconciliation row ID");
  const reconciliationBatchId = input.reconciliationBatchId === undefined
    ? null
    : uuid(input.reconciliationBatchId, "Reconciliation batch ID");
  const decision = requiredText(input.decision, "Resolution decision");
  const allowed = new Set([
    "accepted_application",
    "accepted_manual",
    "corrected_application",
    "corrected_manual",
    "evidence_only"
  ]);
  if (!allowed.has(decision)) {
    throw failure(400, "MBT_RECONCILIATION_DECISION_INVALID", "The variance decision is not supported.");
  }
  const note = requiredText(input.note, "Resolution note");
  const normalizedCorrectionReference = input.correctionReference === null || input.correctionReference === undefined
    ? null
    : correctionReference(snapshot(input.correctionReference, "Correction reference"));
  if ((decision === "corrected_application" || decision === "corrected_manual") && !normalizedCorrectionReference) {
    throw failure(409, "MBT_RECONCILIATION_CORRECTION_REQUIRED", "A corrected decision needs append-only correction evidence.");
  }
  const payload = {
    reconciliationBatchId,
    reconciliationRowId,
    decision,
    note,
    correctionReference: normalizedCorrectionReference
  };
  return executeMbtCommand({
    actor: /** @type {import("./audit-repository.js").MbtActor} */ (actor),
    commandName: "mbt.reconciliation.variance.resolve",
    idempotencyKey: requiredText(input.idempotencyKey, "Idempotency key"),
    payload,
    correlationId: requiredText(input.correlationId, "Correlation ID"),
    requestId: requiredText(input.requestId, "Request ID"),
    mutation: async () => {
      const selected = await query(
        `SELECT reconciliation_row_id, comparison_result,
                application_snapshot_hash, manual_snapshot_hash
           FROM mbt_pilot_reconciliation_rows
          WHERE reconciliation_row_id = $1
            AND ($2::uuid IS NULL OR reconciliation_batch_id = $2)
          FOR UPDATE`,
        [reconciliationRowId, reconciliationBatchId]
      );
      if (!selected.rowCount) {
        throw failure(404, "MBT_RECONCILIATION_ROW_NOT_FOUND", "The reconciliation variance was not found.");
      }
      if (String(selected.rows[0].comparison_result) !== "open_variance") {
        throw failure(409, "MBT_RECONCILIATION_NOT_VARIANCE", "A matched comparison cannot be resolved as a variance.");
      }
      const resolutionId = crypto.randomUUID();
      try {
        await query(
          `INSERT INTO mbt_pilot_reconciliation_resolutions (
             reconciliation_resolution_id, reconciliation_row_id, decision,
             note, decided_by, application_snapshot_hash,
             manual_snapshot_hash, correction_reference
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [
            resolutionId,
            reconciliationRowId,
            decision,
            note,
            requiredText(actor.operatorId, "Actor ID"),
            selected.rows[0].application_snapshot_hash,
            selected.rows[0].manual_snapshot_hash,
            normalizedCorrectionReference === null ? null : JSON.stringify(normalizedCorrectionReference)
          ]
        );
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "23505") {
          throw failure(409, "MBT_RECONCILIATION_ALREADY_RESOLVED", "The variance already has an immutable decision.");
        }
        throw error;
      }
      const body = {
        schemaVersion: "mbt-pilot-reconciliation-resolution-v1",
        resolutionId,
        reconciliationRowId,
        decision,
        note,
        decidedBy: requiredText(actor.operatorId, "Actor ID"),
        applicationSnapshotHash: String(selected.rows[0].application_snapshot_hash),
        manualSnapshotHash: String(selected.rows[0].manual_snapshot_hash),
        correctionReference: normalizedCorrectionReference
      };
      return {
        status: 201,
        body,
        audit: {
          action: "mbt.reconciliation.variance.resolved",
          entityType: "mbt_pilot_reconciliation_row",
          entityId: reconciliationRowId,
          beforeState: { result: "open_variance" },
          afterState: { result: decision, resolutionId, correctionReference: normalizedCorrectionReference },
          reason: note,
          revisionBefore: 1,
          revisionAfter: 1,
          source: "p3_local_reconciliation"
        }
      };
    }
  });
}

// @ts-check

import crypto from "node:crypto";

import { query, withTransaction } from "./db.js";
import { stableCanonicalJson } from "./operator-netsuite-posting-domain.js";
import { buildSalesOrderCompletionSnapshot } from "./sales-order-auto-fulfillment-domain.js";

const TERMINAL_STATUSES = new Set(["historical", "gate_disabled", "completed", "reconciled", "closed", "skipped"]);
/** @typedef {Record<string, any>} LooseRecord */

/** @param {string} code @param {string} message @param {number} [status] */
function failure(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

/** @param {unknown} value */
function text(value) {
  return String(value ?? "").trim();
}

/** @param {unknown} value */
function number(value) {
  const retained = Number(value ?? 0);
  return Number.isFinite(retained) ? Number(retained.toFixed(6)) : 0;
}

/** @param {unknown} error */
function errorText(error) {
  return error instanceof Error ? error.message : String(error || "Sales Order fulfillment failed.");
}

/** @param {unknown} value */
function hash(value) {
  return crypto.createHash("sha256").update(stableCanonicalJson(value)).digest("hex");
}

// This is the single snake_case-to-public candidate serialization boundary.
/** @param {LooseRecord | null | undefined} row */
// eslint-disable-next-line complexity
function publicCandidate(row) {
  if (!row) {return null;}
  return {
    id: row.id,
    completionEventId: text(row.completion_event_id),
    dispatchOrderRef: row.dispatch_order_ref,
    sourceSalesOrderId: row.source_sales_order_id === null ? null : Number(row.source_sales_order_id),
    sourceSalesOrderRef: row.source_sales_order_ref,
    canonicalLocationId: row.canonical_location_id === null ? null : Number(row.canonical_location_id),
    gateKey: row.gate_key,
    gateRevision: row.gate_revision === null ? null : Number(row.gate_revision),
    activationEventId: row.activation_event_id === null ? null : text(row.activation_event_id),
    externalId: row.external_id,
    snapshotHash: row.snapshot_hash,
    lineSnapshot: row.line_snapshot || [],
    liveSnapshot: row.live_snapshot || {},
    payloadHash: row.payload_hash,
    payload: row.payload || {},
    status: row.status,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    attemptCount: Number(row.attempt_count || 0),
    netSuiteTransactionId: row.netsuite_transaction_id === null ? null : Number(row.netsuite_transaction_id),
    netSuiteTransactionRef: row.netsuite_transaction_ref,
    lastError: row.last_error,
    result: row.result || {},
    resolutionAction: row.resolution_action,
    resolutionLines: row.resolution_lines || [],
    customLines: row.resolution_lines || [],
    resolutionReason: row.resolution_reason,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    isSplit: Boolean(row.source_sales_order_ref && text(row.source_sales_order_ref).toLowerCase() !== text(row.dispatch_order_ref).toLowerCase()),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    completionEvidenceType: row.completion_evidence_type || null,
    completionEvidenceId: row.completion_evidence_id || null,
    dispatchCompletedAt: row.evidence_completed_at || null,
    planDate: row.evidence_plan_date || null,
    loadId: row.evidence_load_id || null
  };
}

/** @param {unknown} candidateId @param {{lock?: boolean}} [options] */
async function candidateRow(candidateId, { lock = false } = {}) {
  const result = await query(
    `SELECT * FROM dispatch_sales_order_if_candidates
      WHERE id = $1
      ${lock ? "FOR UPDATE" : ""}`,
    [text(candidateId)]
  );
  return result.rows[0] || null;
}

/** @param {unknown} candidateId */
export async function getSalesOrderAutoFulfillmentCandidate(candidateId) {
  return publicCandidate(await candidateRow(candidateId));
}

/** @param {unknown} locationId */
function yardCode(locationId) {
  return ({ 1: "3445", 28: "2967", 15: "12441", 26: "150" })[Number(locationId)] || "";
}

/** @param {LooseRecord} row */
async function completionSource(row) {
  const result = await query(
    `SELECT event.*,
            local_order.netsuite_id AS local_order_id,
            local_order.tranid AS local_order_ref,
            local_order.outbound_location_id,
            local_order.outbound_location,
            COALESCE(split.source_so_id, local_order.netsuite_id) AS source_order_id,
            COALESCE(split.source_so_ref, local_order.tranid) AS source_order_ref,
            split.id AS split_ledger_id
       FROM dispatch_order_completion_events event
       LEFT JOIN sales_orders local_order
         ON lower(btrim(local_order.tranid)) = lower(btrim(event.order_ref))
       LEFT JOIN dispatch_scm_so_splits split
         ON split.split_so_id = local_order.netsuite_id
        AND split.status = 'active'
      WHERE event.id = $1
        AND event.order_kind = 'SO'
      LIMIT 1
      FOR SHARE OF event`,
    [row.completion_event_id]
  );
  return result.rows[0] || null;
}

/** @param {LooseRecord} source */
async function gateDecision(source) {
  const code = yardCode(source.outbound_location_id);
  if (!code) {return { status: "attention", error: "The completed SO has no supported outbound yard." };}
  const gateKey = `dispatch_netsuite_sales_order_if_${code}`;
  const result = await query(
    `SELECT flag.enabled, flag.revision,
            watermark.activation_event_id, watermark.activated_at,
            event.created_at AS completion_created_at
       FROM mbt_feature_flags flag
       LEFT JOIN dispatch_sales_order_if_gate_watermarks watermark
         ON watermark.gate_key = flag.flag_key
       JOIN dispatch_order_completion_events event ON event.id = $2
      WHERE flag.flag_key = $1`,
    [gateKey, source.id]
  );
  const row = result.rows[0];
  if (!row || row.enabled !== true || row.activation_event_id === null) {
    return { status: "gate_disabled", gateKey, gateRevision: row?.revision || null };
  }
  // The immutable event sequence is the activation boundary. PostgreSQL now()
  // is transaction-scoped, so timestamp comparison can incorrectly classify an
  // event inserted after a gate update in the same transaction as historical.
  const afterWatermark = Number(source.id) > Number(row.activation_event_id);
  if (!afterWatermark) {
    return {
      status: "historical",
      gateKey,
      gateRevision: row.revision,
      activationEventId: row.activation_event_id
    };
  }
  return {
    status: "eligible",
    gateKey,
    gateRevision: row.revision,
    activationEventId: row.activation_event_id
  };
}

/** @param {LooseRecord} source @returns {Promise<LooseRecord[]>} */
async function sourceLines(source) {
  const result = await query(
    `SELECT local_line.id AS local_line_id,
            local_line.line_id AS local_order_line,
            local_line.item_id,
            local_line.item_name,
            local_line.sku,
            local_line.item_type,
            local_line.quantity AS target_quantity,
            local_line.loaded_qty AS mutable_loaded_quantity,
            local_line.location_id,
            source_line.id AS source_line_id,
            source_line.line_id AS source_order_line
       FROM sales_order_lines local_line
       JOIN LATERAL (
         SELECT retained.*
           FROM sales_order_lines retained
          WHERE retained.sales_order_id = $2
            AND (
              retained.id = local_line.id
              OR (
                retained.line_id IS NOT DISTINCT FROM local_line.line_id
                AND retained.item_id IS NOT DISTINCT FROM local_line.item_id
              )
            )
          ORDER BY CASE WHEN retained.id = local_line.id THEN 0 ELSE 1 END, retained.id
          LIMIT 1
       ) source_line ON true
      WHERE local_line.sales_order_id = $1
        AND COALESCE(local_line.netsuite_active, true)
        AND COALESCE(local_line.item_type, '') IN ('InvtPart', 'NonInvtPart')
        AND UPPER(COALESCE(NULLIF(local_line.sku, ''), local_line.item_name, '')) NOT LIKE 'DELIVERY CHARGE%'
        AND UPPER(COALESCE(NULLIF(local_line.sku, ''), local_line.item_name, '')) NOT LIKE 'SALES CREDIT%'
        AND COALESCE(local_line.quantity, 0) > 0
      ORDER BY local_line.line_id NULLS LAST, local_line.id`,
    [source.local_order_id, source.source_order_id]
  );
  return result.rows;
}

/** @param {LooseRecord} source @param {LooseRecord[]} lines @returns {Promise<Map<string, LooseRecord>>} */
async function operatorLoadedEvidence(source, lines) {
  const records = await query(
    `SELECT id, line_snapshot, created_at
       FROM operator_load_records
      WHERE load_type = 'sales_order_delivery_load'
        AND (
          order_id = $1
          OR lower(btrim(order_ref)) = lower(btrim($2))
        )
      ORDER BY created_at, id`,
    [source.local_order_id, source.local_order_ref]
  );
  /** @type {Map<string, {loadedQuantity: number, loadRecordId: string}>} */
  const byOrderLine = new Map();
  for (const record of records.rows) {
    for (const retained of Array.isArray(record.line_snapshot) ? record.line_snapshot : []) {
      const key = text(retained.lineId);
      if (!key) {continue;}
      const current = byOrderLine.get(key);
      const loadedQuantity = number(retained.loadedQty);
      if (!current || loadedQuantity >= current.loadedQuantity) {
        byOrderLine.set(key, { loadedQuantity, loadRecordId: text(record.id) });
      }
    }
  }
  return new Map(lines.map((line) => {
    const evidence = byOrderLine.get(text(line.local_order_line));
    return [text(line.local_line_id), {
      loadedQuantity: evidence ? evidence.loadedQuantity : number(line.mutable_loaded_quantity),
      loadRecordId: evidence?.loadRecordId || null,
      immutable: Boolean(evidence) || number(line.mutable_loaded_quantity) <= 0
    }];
  }));
}

/** @param {LooseRecord} source @param {LooseRecord[]} lines @returns {Promise<Map<string, LooseRecord[]>>} */
async function poExecutionEvidence(source, lines) {
  const lineIds = lines.map((line) => Number(line.source_line_id));
  if (!lineIds.length) {return new Map();}
  const result = await query(
    `SELECT DISTINCT ON (pickup.allocation_id)
            pickup.allocation_id AS id,
            pickup.sales_line_id,
            pickup.allocated_sales_qty,
            pickup.driver_job_id AS pickup_job_id,
            pickup.plan_id AS pickup_plan_id,
            pickup.load_id AS pickup_load_id,
            delivered.driver_job_id AS delivery_job_id,
            delivered.plan_id AS delivery_plan_id,
            delivered.load_id AS delivery_load_id
       FROM dispatch_so_po_allocation_execution_events pickup
       LEFT JOIN LATERAL (
         SELECT event.driver_job_id, event.plan_id, event.load_id
           FROM dispatch_so_po_allocation_execution_events event
          WHERE event.allocation_id = pickup.allocation_id
            AND event.phase = 'delivered'
            AND event.plan_id IS NOT DISTINCT FROM pickup.plan_id
            AND event.load_id = pickup.load_id
            AND ($3 <> 'driver_job' OR event.driver_job_id = $4)
          ORDER BY event.created_at DESC, event.id DESC
          LIMIT 1
       ) delivered ON true
      WHERE pickup.phase = 'pickup'
        AND pickup.sales_line_id = ANY($1::bigint[])
        AND (
          lower(btrim(pickup.dispatch_target_ref)) = lower(btrim($2))
          OR lower(btrim(pickup.sales_order_ref)) = lower(btrim($2))
        )
      ORDER BY pickup.allocation_id, pickup.created_at DESC, pickup.id DESC`,
    [lineIds, source.order_ref, source.completion_evidence_type, source.completion_evidence_id]
  );
  /** @type {Map<string, LooseRecord[]>} */
  const map = new Map();
  for (const row of result.rows) {
    const key = text(row.sales_line_id);
    if (!map.has(key)) {map.set(key, []);}
    const retained = map.get(key);
    if (!retained) {continue;}
    retained.push({
      allocationId: text(row.id),
      quantity: number(row.allocated_sales_qty),
      pickupJobId: text(row.pickup_job_id),
      deliveryJobId: source.completion_evidence_type === "manual_dispatch"
        ? `manual-dispatch:${text(source.completion_evidence_id)}`
        : text(row.delivery_job_id),
      pickupPlanId: row.pickup_plan_id === null ? null : Number(row.pickup_plan_id),
      pickupLoadId: text(row.pickup_load_id),
      deliveryPlanId: row.delivery_plan_id === null ? null : Number(row.delivery_plan_id),
      deliveryLoadId: text(row.delivery_load_id)
    });
  }
  return map;
}

/** @param {LooseRecord} source @param {LooseRecord[]} lines @returns {Promise<Map<string, LooseRecord[]>>} */
async function directToExecutionEvidence(source, lines) {
  const lineIds = lines.map((line) => Number(line.source_line_id));
  if (!lineIds.length) {return new Map();}
  const result = await query(
    `SELECT dependency.id, dependency.transfer_order_ref,
            line.sales_line_id, line.allocated_quantity,
            dependency.status, dependency.direct_receipt_job_id,
            dependency.planned_plan_id, dependency.planned_load_id,
            pickup.job_id AS pickup_job_id
       FROM order_dependencies dependency
       JOIN order_dependency_lines line ON line.dependency_id = dependency.id
       LEFT JOIN LATERAL (
         SELECT job.job_id
           FROM driver_job_records job
          WHERE job.stop_type = 'pickup'
            AND job.status = 'complete'
            AND job.completed_at IS NOT NULL
            AND job.order_refs ? dependency.transfer_order_ref
            AND (job.plan_id IS NOT DISTINCT FROM dependency.planned_plan_id)
            AND COALESCE(job.load_id, '') = COALESCE(dependency.planned_load_id, '')
            AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(COALESCE(job.job_details, '{}'::jsonb)->'orders') = 'array'
                    THEN COALESCE(job.job_details, '{}'::jsonb)->'orders' ELSE '[]'::jsonb END
                ) retained(value)
               WHERE retained.value->>'source' = 'direct_dependency'
                 AND lower(btrim(retained.value->>'orderRef')) = lower(btrim(dependency.transfer_order_ref))
            )
          ORDER BY job.completed_at DESC, job.id DESC LIMIT 1
       ) pickup ON true
      WHERE dependency.dependency_mode = 'direct_to_customer'
        AND dependency.status <> 'cancelled'
        AND ($3 <> 'driver_job' OR dependency.direct_receipt_job_id = $4)
        AND line.line_role = 'sales_allocation'
        AND line.sales_line_id = ANY($1::bigint[])
        AND (
          lower(btrim(dependency.dispatch_target_ref)) = lower(btrim($2))
          OR lower(btrim(dependency.sales_order_ref)) = lower(btrim($2))
        )
      ORDER BY dependency.id`,
    [lineIds, source.order_ref, source.completion_evidence_type, source.completion_evidence_id]
  );
  /** @type {Map<string, LooseRecord[]>} */
  const map = new Map();
  for (const row of result.rows) {
    const key = text(row.sales_line_id);
    if (!map.has(key)) {map.set(key, []);}
    const retained = map.get(key);
    if (!retained) {continue;}
    retained.push({
      dependencyId: text(row.id),
      quantity: number(row.allocated_quantity),
      pickupJobId: text(row.pickup_job_id),
      deliveryJobId: row.status === "received_local" ? text(row.direct_receipt_job_id) : "",
      planId: row.planned_plan_id === null ? null : Number(row.planned_plan_id),
      loadId: text(row.planned_load_id)
    });
  }
  return map;
}

/** @param {LooseRecord} row @param {LooseRecord} source @param {LooseRecord} decision */
async function materializeCandidate(row, source, decision) {
  const lines = await sourceLines(source);
  if (!lines.length) {throw failure("SALES_ORDER_IF_LINES_UNAVAILABLE", "No fulfillable Sales Order lines belong to this completed Dispatch target.");}
  const operatorEvidence = await operatorLoadedEvidence(source, lines);
  const poEvidence = await poExecutionEvidence(source, lines);
  const toEvidence = await directToExecutionEvidence(source, lines);
  const snapshotLines = lines.map((line) => {
    const operator = operatorEvidence.get(text(line.local_line_id));
    if (!operator?.immutable) {
      throw failure("SALES_ORDER_IF_DIRECT_EVIDENCE_INCOMPLETE", `Operator load evidence is unavailable for ${line.sku || line.item_name || line.local_order_line}.`);
    }
    const poRows = poEvidence.get(text(line.source_line_id)) || [];
    const toRows = toEvidence.get(text(line.source_line_id)) || [];
    return {
      localLineId: text(line.local_line_id),
      sourceLineId: text(line.source_line_id),
      orderLine: Number(line.source_order_line),
      itemId: Number(line.item_id),
      location: Number(line.location_id || source.outbound_location_id),
      targetQuantity: number(line.target_quantity),
      operatorLoadedQuantity: operator.loadedQuantity,
      operatorLoadRecordId: operator.loadRecordId,
      completedPoQuantity: poRows.reduce((sum, evidence) => sum + (evidence.pickupJobId && evidence.deliveryJobId ? evidence.quantity : 0), 0),
      completedDirectToQuantity: toRows.reduce((sum, evidence) => sum + (evidence.pickupJobId && evidence.deliveryJobId ? evidence.quantity : 0), 0),
      poEvidence: poRows,
      toEvidence: toRows
    };
  });
  const snapshot = buildSalesOrderCompletionSnapshot({
    candidateId: row.id,
    dispatchOrderRef: source.order_ref,
    sourceSalesOrderId: Number(source.source_order_id),
    sourceSalesOrderRef: source.source_order_ref,
    locationId: Number(source.outbound_location_id),
    lines: snapshotLines
  });
  for (const line of snapshot.lines) {
    const claimed = await query(
      `INSERT INTO dispatch_sales_order_if_line_claims (
         candidate_id, source_sales_order_id, source_line_id, order_line, claimed_quantity
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source_sales_order_id, source_line_id) WHERE active = true
       DO NOTHING
       RETURNING candidate_id`,
      [row.id, snapshot.sourceSalesOrderId, Number(line.sourceLineId), line.orderLine, line.deliveredQuantity]
    );
    if (!claimed.rowCount) {
      await query(
        `DELETE FROM dispatch_sales_order_if_line_claims
          WHERE candidate_id = $1`,
        [row.id]
      );
      throw failure(
        "SALES_ORDER_IF_LINE_BUSY",
        `NetSuite line ${line.orderLine} is already reserved by another completed Dispatch target.`
      );
    }
  }
  await query(
    `UPDATE dispatch_sales_order_if_candidates
        SET source_sales_order_id = $2,
            source_sales_order_ref = $3,
            canonical_location_id = $4,
            gate_key = $5,
            gate_revision = $6,
            activation_event_id = $7,
            snapshot_hash = $8,
            line_snapshot = $9::jsonb,
            status = 'queued',
            resolution_action = COALESCE(resolution_action, 'automatic'),
            last_error = NULL,
            updated_at = now()
      WHERE id = $1`,
    [
      row.id,
      snapshot.sourceSalesOrderId,
      snapshot.sourceSalesOrderRef,
      snapshot.locationId,
      decision.gateKey,
      decision.gateRevision,
      decision.activationEventId,
      snapshot.snapshotHash,
      JSON.stringify(snapshot.lines)
    ]
  );
  await query(
    `INSERT INTO dispatch_sales_order_if_audit_events (candidate_id, action, details)
     VALUES ($1, 'materialized', $2::jsonb)`,
    [row.id, JSON.stringify({ snapshotHash: snapshot.snapshotHash, completionEventId: row.completion_event_id })]
  );
}

/** @param {unknown} candidateId */
export async function prepareSalesOrderAutoFulfillmentCandidate(candidateId) {
  // Materialization keeps gate, lineage, evidence, claims, and audit changes atomic.
  // eslint-disable-next-line complexity
  return withTransaction(async () => {
    let row = await candidateRow(candidateId, { lock: true });
    if (!row || TERMINAL_STATUSES.has(row.status) || ["attention", "posting", "failed"].includes(row.status)) {
      return publicCandidate(row);
    }
    const alreadyMaterialized = row.status === "queued";
    const source = await completionSource(row);
    if (!source?.local_order_id || Number(source.source_order_id) <= 0) {
      await query(
        `UPDATE dispatch_sales_order_if_candidates
            SET status = 'attention', last_error = $2, updated_at = now()
          WHERE id = $1`,
        [row.id, "The completed Dispatch SO cannot be mapped to one positive NetSuite Sales Order parent."]
      );
      return publicCandidate(await candidateRow(row.id));
    }
    const decision = await gateDecision(source);
    if (decision.status === "historical" && row.resolution_action === "historical_backfill") {
      decision.status = "eligible";
    }
    if (decision.status !== "eligible") {
      await query(
        `UPDATE dispatch_sales_order_if_candidates
            SET status = $2, gate_key = $3, gate_revision = $4,
                activation_event_id = $5, updated_at = now()
          WHERE id = $1`,
        [row.id, decision.status, decision.gateKey || null, decision.gateRevision || null, decision.activationEventId || null]
      );
      return publicCandidate(await candidateRow(row.id));
    }
    if (alreadyMaterialized) {
      return publicCandidate(row);
    }
    try {
      await materializeCandidate(row, source, decision);
    } catch (error) {
      const errorCode = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
      const waiting = [
        "SALES_ORDER_IF_DIRECT_EVIDENCE_INCOMPLETE",
        "SALES_ORDER_IF_CONSERVATION_FAILED",
        "SALES_ORDER_IF_LINE_BUSY"
      ].includes(errorCode);
      await query(
        `UPDATE dispatch_sales_order_if_candidates
            SET status = $2, last_error = $3,
                gate_key = $4, gate_revision = $5, activation_event_id = $6,
                updated_at = now()
          WHERE id = $1`,
        [row.id, waiting ? "waiting_evidence" : "attention", errorText(error), decision.gateKey, decision.gateRevision, decision.activationEventId]
      );
    }
    row = await candidateRow(row.id);
    return publicCandidate(row);
  });
}

/** @param {{candidateId: unknown, workerId: unknown, payload: LooseRecord, liveOrder: LooseRecord, selectedLines: any[]}} input */
export async function claimSalesOrderAutoFulfillmentCandidate({ candidateId, workerId, payload, liveOrder, selectedLines }) {
  return withTransaction(async () => {
    const leaseToken = crypto.randomUUID();
    const result = await query(
      `UPDATE dispatch_sales_order_if_candidates candidate
          SET status = 'posting', lease_owner = $2, lease_token = $3,
              lease_expires_at = now() + interval '180 seconds',
              payload = $4::jsonb, payload_hash = $5,
              live_snapshot = $6::jsonb, updated_at = now()
        WHERE candidate.id = $1
          AND candidate.status IN ('queued', 'uncertain')
          AND (candidate.lease_expires_at IS NULL OR candidate.lease_expires_at <= now())
          AND EXISTS (
            SELECT 1
              FROM mbt_feature_flags flag
              JOIN dispatch_sales_order_if_gate_watermarks watermark
                ON watermark.gate_key = flag.flag_key
             WHERE flag.flag_key = candidate.gate_key
               AND flag.enabled = true
               AND (
                 candidate.resolution_action IN (
                   'snapshot', 'all_live_remaining', 'custom', 'recover', 'historical_backfill'
                 )
                 OR (
                   candidate.completion_event_id > watermark.activation_event_id
                   AND candidate.gate_revision = flag.revision
                   AND candidate.activation_event_id = watermark.activation_event_id
                 )
               )
          )
      RETURNING candidate.*`,
      [candidateId, text(workerId), leaseToken, JSON.stringify(payload), hash(payload), JSON.stringify({ ...liveOrder, selectedLines })]
    );
    return publicCandidate(result.rows[0]);
  });
}

/**
 * Extend only the exact, unexpired posting lease. A worker that has lost its
 * token can neither revive the candidate nor extend another worker's claim.
 *
 * @param {{ candidateId: string, leaseToken: string, leaseSeconds?: number }} input
 */
export async function renewSalesOrderAutoFulfillmentCandidateLease(input) {
  const candidateId = text(input?.candidateId);
  const leaseToken = text(input?.leaseToken);
  const leaseSeconds = Number(input?.leaseSeconds ?? 180);
  if (!candidateId || !leaseToken || !Number.isSafeInteger(leaseSeconds)
      || leaseSeconds < 1 || leaseSeconds > 3600) {
    throw failure(
      "SALES_ORDER_IF_INPUT_INVALID",
      "Sales Order fulfillment lease input is invalid.",
      400
    );
  }
  const result = await query(
    `UPDATE dispatch_sales_order_if_candidates
        SET lease_expires_at = now() + ($3::integer * interval '1 second'),
            updated_at = now()
      WHERE id = $1
        AND status = 'posting'
        AND lease_token = $2
        AND lease_expires_at > now()
    RETURNING *`,
    [candidateId, leaseToken, leaseSeconds]
  );
  if (!result.rows[0]) {
    throw failure(
      "SALES_ORDER_IF_LEASE_LOST",
      "The Sales Order fulfillment lease is missing, expired, or owned by another worker."
    );
  }
  return publicCandidate(result.rows[0]);
}

/** @param {{candidateId: unknown, leaseToken: unknown}} input */
export async function startSalesOrderAutoFulfillmentAttempt({ candidateId, leaseToken }) {
  return withTransaction(async () => {
    const row = await candidateRow(candidateId, { lock: true });
    if (!row || row.status !== "posting" || row.lease_token !== leaseToken || new Date(row.lease_expires_at) <= new Date()) {
      throw failure("SALES_ORDER_IF_LEASE_LOST", "The Sales Order fulfillment lease was lost.");
    }
    const attemptNumber = Number(row.attempt_count || 0) + 1;
    await query(
      `UPDATE dispatch_sales_order_if_candidates SET attempt_count = $2, updated_at = now() WHERE id = $1`,
      [candidateId, attemptNumber]
    );
    await query(
      `INSERT INTO dispatch_sales_order_if_attempts (candidate_id, attempt_number, outcome)
       VALUES ($1, $2, 'posting')`,
      [candidateId, attemptNumber]
    );
    return { attemptNumber };
  });
}

/** @param {unknown} candidateId */
async function releaseClaims(candidateId) {
  await query(
    `UPDATE dispatch_sales_order_if_line_claims
        SET active = false, released_at = now()
      WHERE candidate_id = $1 AND active = true`,
    [candidateId]
  );
}

/** @param {LooseRecord} input */
export async function completeSalesOrderAutoFulfillmentCandidate(input) {
  return withTransaction(async () => {
    const row = await candidateRow(input.candidateId, { lock: true });
    if (!row || row.status !== "posting" || row.lease_token !== input.leaseToken
        || new Date(row.lease_expires_at) <= new Date()) {
      throw failure("SALES_ORDER_IF_LEASE_LOST", "The Sales Order fulfillment lease was lost before finalization.");
    }
    await query(
      `UPDATE dispatch_sales_order_if_attempts
          SET outcome = $3, details = $4::jsonb, finished_at = now()
        WHERE candidate_id = $1 AND attempt_number = $2 AND outcome = 'posting'`,
      [input.candidateId, input.attemptNumber, input.recovered ? "recovered" : "posted", JSON.stringify(input.response || {})]
    );
    await query(
      `UPDATE dispatch_sales_order_if_candidates
          SET status = 'completed', netsuite_transaction_id = $2,
              netsuite_transaction_ref = $3, result = $4::jsonb,
              lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
              last_error = NULL, completed_at = now(), updated_at = now()
        WHERE id = $1`,
      [input.candidateId, input.transactionId, input.transactionRef || null, JSON.stringify({
        response: input.response,
        selectedLines: input.selectedLines,
        recovered: input.recovered === true
      })]
    );
    await releaseClaims(input.candidateId);
    await query(
      `INSERT INTO dispatch_sales_order_if_audit_events (candidate_id, action, details)
       VALUES ($1, $2, $3::jsonb)`,
      [input.candidateId, input.recovered ? "recovered_completed" : "completed", JSON.stringify(input.response || {})]
    );
    return publicCandidate(await candidateRow(input.candidateId));
  });
}

/** @param {LooseRecord} input */
export async function failSalesOrderAutoFulfillmentCandidate(input) {
  return withTransaction(async () => {
    const row = await candidateRow(input.candidateId, { lock: true });
    if (!row || row.status !== "posting" || row.lease_token !== input.leaseToken
        || new Date(row.lease_expires_at) <= new Date()) {
      throw failure("SALES_ORDER_IF_LEASE_LOST", "The Sales Order fulfillment lease was lost before failure handling.");
    }
    await query(
      `UPDATE dispatch_sales_order_if_attempts
          SET outcome = $3, error = $4, finished_at = now()
        WHERE candidate_id = $1 AND attempt_number = $2 AND outcome = 'posting'`,
      [input.candidateId, input.attemptNumber, input.uncertain ? "uncertain" : "failed", errorText(input.error)]
    );
    const result = await query(
      `UPDATE dispatch_sales_order_if_candidates
          SET status = $3, last_error = $4,
              lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
              updated_at = now()
        WHERE id = $1 AND lease_token = $2
          AND status = 'posting'
          AND lease_expires_at > now()
      RETURNING *`,
      [input.candidateId, input.leaseToken, input.uncertain ? "uncertain" : "failed", errorText(input.error)]
    );
    return publicCandidate(result.rows[0]);
  });
}

/** @param {{candidateId: unknown, status: string, action: string, details?: any, error?: string | null}} input */
async function setTerminalState({ candidateId, status, action, details = {}, error = null }) {
  return withTransaction(async () => {
    const completed = ["reconciled"].includes(status);
    await query(
      `UPDATE dispatch_sales_order_if_candidates
          SET status = $2, last_error = $3,
              completed_at = CASE WHEN $4 THEN now() ELSE NULL END,
              lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
              updated_at = now()
        WHERE id = $1`,
      [candidateId, status, error, completed]
    );
    if (["closed", "reconciled", "skipped"].includes(status)) {await releaseClaims(candidateId);}
    await query(
      `INSERT INTO dispatch_sales_order_if_audit_events (candidate_id, action, details)
       VALUES ($1, $2, $3::jsonb)`,
      [candidateId, action, JSON.stringify(details)]
    );
    return publicCandidate(await candidateRow(candidateId));
  });
}

export const markSalesOrderAutoFulfillmentAttention = (/** @type {LooseRecord} */ input) => setTerminalState({
  candidateId: input.candidateId,
  status: "attention",
  action: "drift_attention",
  details: { issues: input.issues, liveOrder: input.liveOrder },
  error: "Live NetSuite Sales Order lines differ from the delivered snapshot."
});
export const markSalesOrderAutoFulfillmentClosed = (/** @type {LooseRecord} */ input) => setTerminalState({
  candidateId: input.candidateId,
  status: "closed",
  action: "source_closed",
  details: { issues: input.issues, liveOrder: input.liveOrder },
  error: "The NetSuite Sales Order is closed."
});
export const markSalesOrderAutoFulfillmentReconciled = (/** @type {LooseRecord} */ input) => setTerminalState({
  candidateId: input.candidateId,
  status: "reconciled",
  action: "already_fulfilled",
  details: { liveOrder: input.liveOrder }
});

/** @param {{limit?: number}} [input] @returns {Promise<string[]>} */
export async function listRunnableSalesOrderAutoFulfillmentCandidateIds({ limit = 25 } = {}) {
  await query(
    `UPDATE dispatch_sales_order_if_candidates
        SET status = 'uncertain', last_error = 'Worker lease expired; external-ID recovery is required.',
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE status = 'posting' AND lease_expires_at <= now()`
  );
  const result = await query(
    `SELECT id
       FROM dispatch_sales_order_if_candidates
      WHERE status IN ('discovered', 'waiting_evidence', 'queued')
      ORDER BY created_at, id
      LIMIT $1`,
    [Math.max(1, Math.min(Number(limit) || 25, 100))]
  );
  return result.rows.map((/** @type {LooseRecord} */ row) => String(row.id));
}

/** @param {{statuses?: any[], limit?: number}} [input] */
export async function listSalesOrderAutoFulfillmentCandidates({ statuses = [], limit = 100 } = {}) {
  const retained = (Array.isArray(statuses) ? statuses : []).map(text).filter(Boolean);
  const result = await query(
    `SELECT candidate.*,
            event.completion_evidence_type,
            event.completion_evidence_id,
            event.dispatch_completed_at AS evidence_completed_at,
            event.plan_date AS evidence_plan_date,
            event.load_id AS evidence_load_id
       FROM dispatch_sales_order_if_candidates candidate
       JOIN dispatch_order_completion_events event ON event.id = candidate.completion_event_id
      WHERE ($1::text[] = '{}'::text[] OR candidate.status = ANY($1::text[]))
      ORDER BY candidate.created_at DESC, candidate.id DESC
      LIMIT $2`,
    [retained, Math.max(1, Math.min(Number(limit) || 100, 500))]
  );
  return result.rows.map(publicCandidate);
}

/** @param {any} values */
function historicalEventIds(values) {
  const retained = [...new Set((Array.isArray(values) ? values : []).map((value) => text(value)).filter(Boolean))];
  if (retained.length > 100 || retained.some((value) => !/^\d+$/u.test(value) || value === "0")) {
    throw failure("SALES_ORDER_IF_HISTORICAL_SELECTION_INVALID", "Select at most 100 positive completion event IDs.", 400);
  }
  return retained;
}

/** @param {any} values */
function historicalOrderRefs(values) {
  const retained = [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))];
  if (retained.length > 100 || retained.some((value) => value.length > 160)) {
    throw failure("SALES_ORDER_IF_HISTORICAL_SELECTION_INVALID", "Select at most 100 valid Sales Order references.", 400);
  }
  return retained;
}

/** @param {{search?: unknown, limit?: number}} [input] */
export async function previewHistoricalSalesOrderAutoFulfillmentEvents({ search, limit = 50 } = {}) {
  const normalizedSearch = text(search);
  if (normalizedSearch.length < 2 || normalizedSearch.length > 160) {
    throw failure("SALES_ORDER_IF_HISTORICAL_SEARCH_INVALID", "Enter at least two characters of a Sales Order reference.", 400);
  }
  const result = await query(
    `SELECT event.id, event.order_ref, event.dispatch_completed_at,
            event.completion_evidence_type, event.completion_evidence_id,
            event.plan_id, event.plan_date, event.load_id,
            candidate.id AS candidate_id, candidate.status AS candidate_status,
            local_order.netsuite_id AS local_order_id,
            local_order.outbound_location_id,
            COALESCE(split.source_so_id, local_order.netsuite_id) AS source_order_id,
            COALESCE(split.source_so_ref, local_order.tranid) AS source_order_ref
       FROM dispatch_order_completion_events event
       LEFT JOIN dispatch_sales_order_if_candidates candidate
         ON candidate.completion_event_id = event.id
       LEFT JOIN sales_orders local_order
         ON lower(btrim(local_order.tranid)) = lower(btrim(event.order_ref))
       LEFT JOIN dispatch_scm_so_splits split
         ON split.split_so_id = local_order.netsuite_id
        AND split.status = 'active'
      WHERE event.order_kind = 'SO'
        AND event.completion_evidence_type IN ('driver_job', 'manual_dispatch')
        AND lower(event.order_ref) LIKE '%' || lower($1) || '%'
      ORDER BY event.dispatch_completed_at DESC, event.id DESC
      LIMIT $2`,
    [normalizedSearch, Math.max(1, Math.min(Number(limit) || 50, 100))]
  );
  return result.rows.map((/** @type {LooseRecord} */ row) => ({
    eventId: text(row.id),
    orderRef: text(row.order_ref),
    dispatchCompletedAt: row.dispatch_completed_at,
    completionEvidenceType: text(row.completion_evidence_type),
    completionEvidenceId: text(row.completion_evidence_id),
    planId: row.plan_id === null ? null : Number(row.plan_id),
    planDate: row.plan_date,
    loadId: row.load_id,
    candidateId: row.candidate_id || null,
    candidateStatus: row.candidate_status || null,
    sourceSalesOrderId: row.source_order_id === null ? null : Number(row.source_order_id),
    sourceSalesOrderRef: row.source_order_ref || null,
    locationId: row.outbound_location_id === null ? null : Number(row.outbound_location_id),
    supported: Number(row.source_order_id) > 0 && Boolean(yardCode(row.outbound_location_id))
  }));
}

/** @param {{completionEventIds?: any[], orderRefs?: any[], reason?: unknown, actorId?: unknown}} [input] */
export async function queueHistoricalSalesOrderAutoFulfillmentCandidates({
  completionEventIds = [],
  orderRefs = [],
  reason,
  actorId
} = {}) {
  const ids = historicalEventIds(completionEventIds);
  const refs = historicalOrderRefs(orderRefs);
  const normalizedReason = text(reason);
  const normalizedActorId = text(actorId);
  if (!ids.length && !refs.length) {
    throw failure("SALES_ORDER_IF_HISTORICAL_SELECTION_REQUIRED", "Select at least one historical completion event.", 400);
  }
  if (!normalizedReason || !normalizedActorId) {
    throw failure("SALES_ORDER_IF_REASON_REQUIRED", "An Admin actor and audit reason are required.", 400);
  }
  return withTransaction(async () => {
    const selected = await query(
      `SELECT event.id, event.order_ref
         FROM dispatch_order_completion_events event
        WHERE event.order_kind = 'SO'
          AND event.completion_evidence_type IN ('driver_job', 'manual_dispatch')
          AND (
            (cardinality($1::bigint[]) > 0 AND event.id = ANY($1::bigint[]))
            OR (cardinality($2::text[]) > 0 AND lower(btrim(event.order_ref)) = ANY($2::text[]))
          )
        ORDER BY event.id
        LIMIT 100`,
      [ids, refs.map((value) => value.toLowerCase())]
    );
    if (!selected.rowCount) {
      throw failure("SALES_ORDER_IF_HISTORICAL_NOT_FOUND", "No eligible historical SO completion was found.", 404);
    }
    const candidates = [];
    for (const event of selected.rows) {
      const candidateId = crypto.randomUUID();
      await query(
        `INSERT INTO dispatch_sales_order_if_candidates (
           id, completion_event_id, dispatch_order_ref, external_id,
           status, resolution_action, resolution_reason, resolved_by, resolved_at
         ) VALUES (
           $1, $2, $3, $4, 'discovered', 'historical_backfill', $5, $6, now()
         )
         ON CONFLICT (completion_event_id) DO NOTHING`,
        [candidateId, event.id, event.order_ref, `MBBS-SOIF-${candidateId}`, normalizedReason, normalizedActorId]
      );
      const existing = await query(
        `SELECT *
           FROM dispatch_sales_order_if_candidates
          WHERE completion_event_id = $1
          FOR UPDATE`,
        [event.id]
      );
      const row = existing.rows[0];
      if (!["completed", "reconciled", "closed"].includes(row.status)) {
        await query(
          `UPDATE dispatch_sales_order_if_candidates
              SET status = CASE WHEN snapshot_hash IS NULL THEN 'discovered' ELSE 'queued' END,
                  resolution_action = 'historical_backfill', resolution_reason = $2,
                  resolved_by = $3, resolved_at = now(), last_error = NULL, updated_at = now()
            WHERE id = $1`,
          [row.id, normalizedReason, normalizedActorId]
        );
        await query(
          `INSERT INTO dispatch_sales_order_if_audit_events (
             candidate_id, action, actor_id, reason, details
           ) VALUES ($1, 'admin_historical_backfill', $2, $3, $4::jsonb)`,
          [row.id, normalizedActorId, normalizedReason, JSON.stringify({ completionEventId: text(event.id), orderRef: event.order_ref })]
        );
      }
      candidates.push(publicCandidate(await candidateRow(row.id)));
    }
    return candidates;
  });
}

/** @param {{candidateId: unknown, action: unknown, lines?: any[], reason?: unknown, actorId?: unknown}} input */
export async function resolveSalesOrderAutoFulfillmentCandidate({ candidateId, action, lines = [], reason, actorId }) {
  const normalizedAction = text(action).toLowerCase();
  const normalizedReason = text(reason);
  if (!["recheck", "snapshot", "all_live_remaining", "custom", "recover", "skip", "historical_backfill"].includes(normalizedAction)) {
    throw failure("SALES_ORDER_IF_ADMIN_ACTION_INVALID", "Choose a supported Sales Order fulfillment action.", 400);
  }
  if (!normalizedReason) {
    throw failure("SALES_ORDER_IF_REASON_REQUIRED", "An audit reason is required.", 400);
  }
  return withTransaction(async () => {
    const row = await candidateRow(candidateId, { lock: true });
    if (!row) {throw failure("SALES_ORDER_IF_CANDIDATE_NOT_FOUND", "The fulfillment candidate was not found.", 404);}
    if (["completed", "reconciled", "closed"].includes(row.status)) {
      throw failure("SALES_ORDER_IF_CANDIDATE_TERMINAL", "A completed/reconciled/closed candidate cannot be changed.");
    }
    if (row.status === "uncertain" && !["recover", "skip"].includes(normalizedAction)) {
      throw failure(
        "SALES_ORDER_IF_RECOVERY_REQUIRED",
        "An uncertain NetSuite post can only be recovered by external ID or skipped with an audit reason."
      );
    }
    if (normalizedAction === "skip") {
      await query(
        `UPDATE dispatch_sales_order_if_candidates
            SET status = 'skipped', resolution_action = 'skip', resolution_reason = $2,
                resolved_by = $3, resolved_at = now(), updated_at = now()
          WHERE id = $1`,
        [candidateId, normalizedReason, text(actorId)]
      );
      await releaseClaims(candidateId);
    } else {
      await query(
        `UPDATE dispatch_sales_order_if_candidates
            SET status = CASE WHEN snapshot_hash IS NULL THEN 'discovered' ELSE 'queued' END,
                resolution_action = $2, resolution_lines = $3::jsonb,
                resolution_reason = $4, resolved_by = $5, resolved_at = now(),
                last_error = NULL, updated_at = now()
          WHERE id = $1`,
        [candidateId, normalizedAction, JSON.stringify(lines || []), normalizedReason || null, text(actorId)]
      );
    }
    await query(
      `INSERT INTO dispatch_sales_order_if_audit_events (candidate_id, action, actor_id, reason, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [candidateId, `admin_${normalizedAction}`, text(actorId), normalizedReason, JSON.stringify({ lines: lines || [] })]
    );
    return publicCandidate(await candidateRow(candidateId));
  });
}

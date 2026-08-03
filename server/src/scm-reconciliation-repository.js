import crypto from "node:crypto";
import { query, withTransaction } from "./db.js";
import {
  allocateReconciliationProgress,
  classifyNetSuiteLifecycle,
  derivePoToReconciliationState,
  reconciliationQuantity,
  roundReconciliationQuantity
} from "./scm-reconciliation.js";
import { syncOrderDependenciesForTransferOrder } from "./order-dependency-repository.js";

const EPSILON = 0.000001;
const RECONCILIATION_SCHEMA_VERSION = "mbbs.ifir.reconciliation.v1";
const REVIEW_DECISIONS = new Set(["skip", "accept_current", "keep_review"]);
const SCM_RECONCILIATION_RUN_ADVISORY_LOCK = 741_906_12;

function text(value) {
  return String(value ?? "").trim();
}

function textList(value, fallback = []) {
  const values = Array.isArray(value) ? value : fallback;
  return [...new Set(values.map(text).filter(Boolean))];
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function dateValue(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function timestampValue(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function bool(value) {
  return value === true || /^(1|true|yes|on)$/i.test(text(value));
}

export function scmScheduleEffectiveReconciliationStatus({
  scheduleStatus = "Queued",
  scheduleId = 0,
  scheduleUpdatedAt = null,
  reconciliationStatus = "",
  reconciliationReconciledAt = null,
  reconciliationApplicationStatus = "",
  blockingReview = false
} = {}) {
  const currentScheduleStatus = text(scheduleStatus) || "Queued";
  const currentReconciliationStatus = text(reconciliationStatus).toLowerCase();
  if (blockingReview || currentReconciliationStatus === "review") return "Reconcile Review";
  if (currentReconciliationStatus === "pending") return currentScheduleStatus;

  const scheduleUpdatedTimestamp = timestampValue(scheduleUpdatedAt);
  const reconciliationTimestamp = timestampValue(reconciliationReconciledAt);
  const scheduleIsNewer = Number(scheduleId) > 0
    && scheduleUpdatedTimestamp !== null
    && (reconciliationTimestamp === null || scheduleUpdatedTimestamp > reconciliationTimestamp);
  if (scheduleIsNewer) return currentScheduleStatus;
  return text(reconciliationApplicationStatus) || currentScheduleStatus;
}

export function scmReconciliationProposedOutcome(proposal = {}) {
  const explicit = text(
    proposal.authoritativeApplicationStatus
    || proposal.calculatedApplicationStatus
  );
  if (explicit) return explicit;
  const current = text(proposal.applicationStatus);
  if (current && current !== "Reconcile Review") return current;
  const quantities = proposal.quantities && typeof proposal.quantities === "object"
    ? proposal.quantities
    : {};
  const ordered = reconciliationQuantity(quantities.ordered);
  const fulfilled = reconciliationQuantity(quantities.fulfilled);
  const received = reconciliationQuantity(quantities.received);
  const abandoned = reconciliationQuantity(quantities.abandoned);
  const kind = text(proposal.orderKind).toUpperCase();
  if (
    ordered > EPSILON
    && received + abandoned + EPSILON >= ordered
    && (kind !== "TO" || fulfilled + abandoned + EPSILON >= ordered)
  ) {
    return "Completed";
  }
  return "";
}

export function scmReconciliationReviewFingerprint(
  proposal = {},
  {
    includeReason = true,
    evidenceVersion = Number(proposal.evidenceVersion || 1)
  } = {}
) {
  const quantities = proposal.quantities && typeof proposal.quantities === "object"
    ? proposal.quantities
    : {};
  const lines = (Array.isArray(proposal.lines) ? proposal.lines : [])
    .map((line) => ({
      lineKey: text(line.lineKey || line.sourceLineKey),
      itemId: positiveId(line.itemId),
      itemName: text(line.itemName || line.sku),
      unit: text(line.unit),
      ordered: roundReconciliationQuantity(line.ordered),
      fulfilled: roundReconciliationQuantity(line.fulfilled),
      received: roundReconciliationQuantity(line.received),
      remaining: roundReconciliationQuantity(line.remaining),
      identityStatus: text(line.identityStatus),
      allocationQuality: text(line.allocationQuality),
      ...(evidenceVersion >= 2 ? {
        stage: text(line.stage),
        logicalLineIdentity: text(line.logicalLineIdentity),
        identityIssue: text(line.identityIssue),
        locationId: positiveId(line.locationId)
      } : {})
    }))
    .sort((left, right) =>
      left.lineKey.localeCompare(right.lineKey)
      || Number(left.itemId || 0) - Number(right.itemId || 0)
      || left.itemName.localeCompare(right.itemName)
    );
  const targets = Object.entries(
    proposal.targets && typeof proposal.targets === "object"
      ? proposal.targets
      : {}
  )
    .map(([key, target = {}]) => ({
      orderRef: text(target.orderRef || key).toUpperCase(),
      orderId: positiveId(target.orderId),
      targetKind: text(target.targetKind),
      ordered: roundReconciliationQuantity(target.ordered),
      fulfilled: roundReconciliationQuantity(target.fulfilled),
      received: roundReconciliationQuantity(target.received),
      abandoned: roundReconciliationQuantity(target.abandoned),
      remaining: roundReconciliationQuantity(target.remaining),
      destinationRemaining: roundReconciliationQuantity(
        target.destinationRemaining
      ),
      exactAllocation: target.exactAllocation === true,
      hidden: target.hidden === true,
      hasActivePlan: target.hasActivePlan === true,
      allocationMethods: textList(target.allocationMethods).sort(),
      ...(includeReason ? {
        applicationStatus: text(target.applicationStatus),
        reconciliationStatus: text(target.reconciliationStatus)
      } : {})
    }))
    .sort((left, right) =>
      left.orderRef.localeCompare(right.orderRef)
      || Number(left.orderId || 0) - Number(right.orderId || 0)
    );
  const canonical = {
    orderKind: text(proposal.orderKind).toUpperCase(),
    sourceOrderId: positiveId(proposal.sourceOrderId),
    sourceOrderRef: text(proposal.sourceOrderRef).toUpperCase(),
    ...(includeReason ? { reason: text(proposal.reason) } : {}),
    outcome: scmReconciliationProposedOutcome(proposal),
    quantities: {
      ordered: roundReconciliationQuantity(quantities.ordered),
      fulfilled: roundReconciliationQuantity(quantities.fulfilled),
      received: roundReconciliationQuantity(quantities.received),
      abandoned: roundReconciliationQuantity(quantities.abandoned),
      remaining: roundReconciliationQuantity(quantities.remaining),
      destinationRemaining: roundReconciliationQuantity(
        quantities.destinationRemaining
      )
    },
    exactAllocation: proposal.exactAllocation === true,
    targets,
    lines
  };
  if (evidenceVersion >= 2) {
    const evidence = proposal.evidence && typeof proposal.evidence === "object"
      ? proposal.evidence
      : {};
    canonical.evidenceVersion = 2;
    canonical.evidence = {
      statusCode: text(evidence.statusCode),
      statusText: text(evidence.statusText),
      lifecycle: text(evidence.lifecycle),
      lastModifiedAt: dateValue(evidence.lastModifiedAt),
      sourceLocationId: positiveId(evidence.sourceLocationId),
      destinationLocationId: positiveId(evidence.destinationLocationId),
      dispatchPlanned: evidence.dispatchPlanned === true,
      dispatchPlanDate: dateValue(evidence.dispatchPlanDate),
      dispatchPlannedAt: dateValue(evidence.dispatchPlannedAt),
      linkedTransactions: (
        Array.isArray(evidence.linkedTransactions)
          ? evidence.linkedTransactions
          : []
      )
        .map((transaction = {}) => ({
          transactionType: text(transaction.transactionType),
          transactionId: positiveId(transaction.transactionId),
          transactionRef: text(transaction.transactionRef),
          statusText: text(transaction.statusText),
          transactionLineKey: text(transaction.transactionLineKey),
          sourceOrderLineKey: text(transaction.sourceOrderLineKey),
          itemId: positiveId(transaction.itemId),
          quantity: roundReconciliationQuantity(transaction.quantity),
          unit: text(transaction.unit),
          actualLocationId: positiveId(transaction.actualLocationId),
          identityIssue: text(transaction.identityIssue)
        }))
        .sort((left, right) =>
          left.transactionType.localeCompare(right.transactionType)
          || Number(left.transactionId || 0) - Number(right.transactionId || 0)
          || left.transactionLineKey.localeCompare(right.transactionLineKey)
        )
    };
  }
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

function webhookRecordType(value) {
  const normalized = text(value).toLowerCase().replaceAll("_", "").replaceAll("-", "");
  if (["itemfulfillment", "itemship", "if"].includes(normalized)) return "IF";
  if (["itemreceipt", "itemrcpt", "ir"].includes(normalized)) return "IR";
  return "";
}

function webhookOrderKind(value, orderRef = "") {
  const normalized = text(value).toLowerCase().replaceAll("_", "").replaceAll("-", "");
  if (["purchaseorder", "purchord", "po"].includes(normalized)) return "PO";
  if (["transferorder", "trnfrord", "to"].includes(normalized)) return "TO";
  const ref = text(orderRef).toUpperCase();
  if (ref.startsWith("PO")) return "PO";
  if (ref.startsWith("TO")) return "TO";
  return "";
}

function webhookAction(value, tombstone = false) {
  if (tombstone) return "delete";
  const normalized = text(value).toLowerCase();
  if (["create", "edit", "delete"].includes(normalized)) return normalized;
  if (normalized === "xedit") return "edit";
  return "edit";
}

function objectId(value) {
  if (value && typeof value === "object") return positiveId(value.id ?? value.value ?? value.internalId);
  return positiveId(value);
}

function objectText(value) {
  if (value && typeof value === "object") {
    return text(value.text ?? value.ref ?? value.reference ?? value.tranid ?? value.name);
  }
  return text(value);
}

function normalizedWebhookLine(line = {}, index = 0) {
  const item = line.item || {};
  const location = line.actualLocation || line.location || {};
  const sourceLocation = line.sourceLocation || {};
  const destinationLocation = line.destinationLocation || {};
  const transactionLineKey = text(
    line.lineUniqueKey
      ?? line.lineuniquekey
      ?? line.transactionLineKey
      ?? line.transaction_line_key
      ?? line.uniqueKey
      ?? line.uniquekey
      ?? line.line
      ?? line.id
      ?? index + 1
  );
  const sourceLineKey = text(
    line.sourceLineKey
      ?? line.sourceOrderLineKey
      ?? line.source_order_line_key
      ?? line.orderLineUniqueKey
      ?? line.orderlineuniquekey
      ?? line.orderLine
      ?? line.orderline
  );
  return {
    transactionLineKey,
    sourceLineKey,
    orderLine: text(line.orderLine ?? line.orderline),
    itemId: objectId(item) || positiveId(line.itemId ?? line.item_id),
    itemName: objectText(item) || text(line.itemName ?? line.item_name),
    sku: text(line.sku ?? line.itemSku ?? line.item_sku),
    quantity: roundReconciliationQuantity(line.quantity ?? line.qty),
    unit: objectText(line.units ?? line.unit ?? line.uom),
    sourceLocationId: objectId(sourceLocation) || positiveId(line.sourceLocationId ?? line.source_location_id),
    destinationLocationId: objectId(destinationLocation) || positiveId(line.destinationLocationId ?? line.destination_location_id),
    actualLocationId: objectId(location) || positiveId(line.actualLocationId ?? line.locationId ?? line.location_id),
    reconciliationRelevant: line.reconciliationRelevant !== false && line.isIncluded !== false,
    snapshot: line
  };
}

export function normalizeScmIfIrWebhook(payload = {}, {
  eventId = "",
  timestamp = ""
} = {}) {
  const record = payload.record && typeof payload.record === "object" ? payload.record : payload;
  const tombstone = Boolean(payload.tombstone) || bool(record.tombstone) || record.deleted === true;
  const transactionType = webhookRecordType(
    record.recordType ?? record.type ?? payload.recordType ?? payload.type
  );
  if (!transactionType) throw Object.assign(new Error("The IF/IR webhook record type is unsupported."), { status: 400 });

  const transactionId = positiveId(record.id ?? record.internalId ?? payload.id);
  if (!transactionId) throw Object.assign(new Error("The IF/IR webhook requires a positive transaction internal ID."), { status: 400 });

  const createdFrom = record.createdFrom ?? record.createdfrom ?? payload.createdFrom ?? {};
  const sourceOrderId = objectId(createdFrom)
    || positiveId(record.sourceOrderId ?? record.source_order_id ?? payload.sourceOrderId);
  const sourceOrderRef = objectText(createdFrom)
    || text(record.sourceOrderRef ?? record.source_order_ref ?? payload.sourceOrderRef);
  const sourceOrderKind = webhookOrderKind(
    createdFrom?.recordType
      ?? createdFrom?.type
      ?? record.sourceOrderType
      ?? record.source_order_type
      ?? payload.sourceOrderType,
    sourceOrderRef
  );
  const action = webhookAction(payload.action ?? payload.eventType ?? record.action, tombstone);
  const eventTime = dateValue(payload.eventTime ?? payload.occurredAt ?? record.lastModifiedAt)
    || (timestamp && /^\d+$/.test(String(timestamp))
      ? new Date(Number(timestamp) * 1000).toISOString()
      : new Date().toISOString());
  const transactionRef = text(record.tranid ?? record.transactionRef ?? record.ref);
  const lines = (Array.isArray(record.lines) ? record.lines : [])
    .map(normalizedWebhookLine)
    .filter((line) => line.transactionLineKey && line.reconciliationRelevant);
  const sourceLocation = record.sourceLocation || record.locations?.source || {};
  const destinationLocation = record.destinationLocation || record.locations?.destination || record.locations?.transfer || {};
  const actualLocation = record.actualLocation || record.locations?.actual || record.location || {};
  const status = record.status && typeof record.status === "object" ? record.status : {};
  return {
    schemaVersion: text(payload.schemaVersion || payload.schema_version),
    eventId: text(payload.eventId ?? payload.event_id ?? eventId)
      || `${transactionType}:${transactionId}:${action}:${eventTime}`,
    eventTime,
    action,
    tombstone: action === "delete" || tombstone,
    transactionType,
    transactionId,
    transactionRef,
    statusCode: text(record.statusCode ?? status.value ?? record.status),
    statusText: text(record.statusText ?? record.status_text ?? status.text),
    lastModifiedAt: dateValue(record.lastModifiedAt ?? record.lastModifiedDate ?? record.lastmodifieddate ?? eventTime),
    sourceOrderKind,
    sourceOrderId,
    sourceOrderRef,
    sourceLocationId: objectId(sourceLocation) || positiveId(record.sourceLocationId),
    sourceLocation: objectText(sourceLocation) || text(record.sourceLocationText),
    destinationLocationId: objectId(destinationLocation) || positiveId(record.destinationLocationId),
    destinationLocation: objectText(destinationLocation) || text(record.destinationLocationText),
    actualLocationId: objectId(actualLocation) || positiveId(record.actualLocationId ?? record.locationId),
    actualLocation: objectText(actualLocation) || text(record.actualLocationText ?? record.locationText),
    lines,
    raw: payload
  };
}

export function verifyScmIfIrWebhookSignature({
  rawBody = "",
  eventId = "",
  timestamp = "",
  signature = "",
  secret = "",
  now = Date.now(),
  maxAgeSeconds = 300
} = {}) {
  if (!secret) return { ok: false, status: 503, error: "NETSUITE_IFIR_WEBHOOK_SECRET is not configured." };
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return { ok: false, status: 401, error: "Invalid IF/IR webhook timestamp." };
  if (Math.abs(now - (seconds * 1000)) > Math.max(30, Number(maxAgeSeconds) || 300) * 1000) {
    return { ok: false, status: 401, error: "Expired IF/IR webhook timestamp." };
  }
  if (!text(eventId)) return { ok: false, status: 401, error: "Missing IF/IR webhook event ID." };
  const unsigned = `${timestamp}\n${eventId}\n${rawBody}`;
  const expected = crypto.createHmac("sha256", secret).update(unsigned).digest("hex");
  const provided = text(signature).replace(/^sha256=/i, "").toLowerCase();
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (
    providedBuffer.length !== expectedBuffer.length
    || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return { ok: false, status: 401, error: "Invalid IF/IR webhook signature." };
  }
  return { ok: true };
}

function mapSettings(row = {}) {
  return {
    nightlyEnabled: row.nightly_enabled === true,
    nightlyTime: row.nightly_time || "21:30",
    timeZone: row.time_zone || "America/Toronto",
    netSuiteRequestConcurrency: Number(row.netsuite_request_concurrency || 1),
    yieldToOperationalRequests: row.yield_to_operational_requests !== false,
    autoApplyUnambiguous: row.auto_apply_unambiguous === true,
    initialDryRunApproved: Boolean(row.initial_dry_run_approved_at),
    initialDryRunApprovedAt: row.initial_dry_run_approved_at || null,
    initialDryRunApprovedBy: row.initial_dry_run_approved_by || "",
    initialBackfillModifiedSince: row.initial_backfill_modified_since || "2026-01-01",
    lastNightlyLocalDate: row.last_nightly_local_date || null,
    updatedBy: row.updated_by || "",
    updatedAt: row.updated_at || null
  };
}

export async function getScmReconciliationSettings() {
  const result = await query(
    `SELECT *
       FROM scm_reconciliation_settings
      WHERE singleton_id = 1`
  );
  return mapSettings(result.rows[0]);
}

export async function updateScmReconciliationSettings(patch = {}, actor = "") {
  const current = await getScmReconciliationSettings();
  const nightlyTime = text(patch.nightlyTime ?? patch.nightly_time ?? current.nightlyTime);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(nightlyTime)) {
    throw Object.assign(new Error("Nightly reconciliation time must use HH:MM."), { status: 400 });
  }
  const timeZone = text(patch.timeZone ?? patch.timezone ?? patch.time_zone ?? current.timeZone);
  if (timeZone !== "America/Toronto") {
    throw Object.assign(new Error("PO/TO reconciliation uses the America/Toronto company time zone."), { status: 400 });
  }
  const modifiedSince = text(
    patch.initialBackfillModifiedSince
      ?? patch.initial_backfill_modified_since
      ?? current.initialBackfillModifiedSince
  );
  if (!/^\d{4}-\d{2}-\d{2}$/.test(modifiedSince)) {
    throw Object.assign(new Error("Initial backfill date must use YYYY-MM-DD."), { status: 400 });
  }
  const result = await query(
    `UPDATE scm_reconciliation_settings
        SET nightly_enabled = $1,
            nightly_time = $2,
            time_zone = $3,
            initial_backfill_modified_since = $4::date,
            updated_by = $5,
            updated_at = now()
      WHERE singleton_id = 1
      RETURNING *`,
    [
      patch.nightlyEnabled === undefined ? current.nightlyEnabled : bool(patch.nightlyEnabled),
      nightlyTime,
      timeZone,
      modifiedSince,
      text(actor) || null
    ]
  );
  return mapSettings(result.rows[0]);
}

export async function getScmReconciliationPreference(operatorId) {
  const id = text(operatorId);
  if (!id) return { showDetails: false };
  const result = await query(
    `SELECT show_reconciliation_details
       FROM scm_reconciliation_user_preferences
      WHERE operator_id = $1`,
    [id]
  );
  return { showDetails: result.rows[0]?.show_reconciliation_details === true };
}

export async function updateScmReconciliationPreference(operatorId, showDetails) {
  const id = text(operatorId);
  if (!id) throw Object.assign(new Error("A staff account is required."), { status: 401 });
  const result = await query(
    `INSERT INTO scm_reconciliation_user_preferences (
       operator_id, show_reconciliation_details, updated_at
     ) VALUES ($1, $2, now())
     ON CONFLICT (operator_id) DO UPDATE SET
       show_reconciliation_details = EXCLUDED.show_reconciliation_details,
       updated_at = now()
     RETURNING show_reconciliation_details`,
    [id, bool(showDetails)]
  );
  return { showDetails: result.rows[0]?.show_reconciliation_details === true };
}

function mapRun(row = {}) {
  const checkpoint = row.checkpoint || {};
  const failedTargetCount = Number(row.failed_target_count || 0);
  const resumeAllowed = row.resume_allowed === undefined
    ? (
      row.status === "interrupted"
      || (
        row.status === "failed"
        && text(checkpoint.phase).toLowerCase() !== "complete"
        && failedTargetCount === 0
      )
    )
    : row.resume_allowed === true;
  return {
    id: Number(row.id),
    runKey: row.run_key || "",
    triggerSource: row.trigger_source || "",
    scope: row.scope_kind || "all",
    targetOrderKind: row.target_order_kind || "",
    targetOrderId: row.target_order_netsuite_id || null,
    targetOrderRef: row.target_order_ref || "",
    includeTerminalOrders: row.include_terminal_orders === true,
    cancelRequestedAt: row.cancel_requested_at || null,
    cancelRequestedBy: row.cancel_requested_by || "",
    cancelRequestNote: row.cancel_request_note || "",
    dryRun: row.dry_run === true,
    applyUnambiguous: row.apply_unambiguous === true,
    status: row.status || "",
    resumeOfRunId: row.resume_of_run_id ? Number(row.resume_of_run_id) : null,
    requestedBy: row.requested_by || "",
    approvedBy: row.approved_by || "",
    approvedAt: row.approved_at || null,
    checkpoint,
    summary: row.summary || {},
    error: row.error || "",
    apiRequestCount: Number(row.api_request_count || 0),
    resumeAllowed,
    resumeCount: Number(checkpoint.resumeCount || 0),
    reviewDecisionSummary: {
      reviewTargets: Number(row.review_target_count || 0),
      decidedTargets: Number(row.decided_target_count || 0),
      pendingTargets: Number(row.pending_decision_count || 0),
      skippedTargets: Number(row.skip_decision_count || 0),
      acceptedTargets: Number(row.accept_current_decision_count || 0),
      keptReviewTargets: Number(row.keep_review_decision_count || 0)
    },
    createdAt: row.created_at || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null
  };
}

export async function listScmReconciliationRuns({ limit = 30 } = {}) {
  const result = await query(
    `SELECT run.*,
            COALESCE(decisions.review_target_count, 0)::int AS review_target_count,
            COALESCE(decisions.decided_target_count, 0)::int AS decided_target_count,
            COALESCE(decisions.pending_decision_count, 0)::int AS pending_decision_count,
            COALESCE(decisions.skip_decision_count, 0)::int AS skip_decision_count,
            COALESCE(decisions.accept_current_decision_count, 0)::int AS accept_current_decision_count,
            COALESCE(decisions.keep_review_decision_count, 0)::int AS keep_review_decision_count,
            COALESCE(decisions.failed_target_count, 0)::int AS failed_target_count,
            (
              run.status = 'interrupted'
              OR (
                run.status = 'failed'
                AND COALESCE(run.checkpoint->>'phase', '') <> 'complete'
                AND COALESCE(decisions.failed_target_count, 0) = 0
              )
            ) AS resume_allowed
       FROM scm_reconciliation_runs run
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (WHERE target.status = 'review') AS review_target_count,
                COUNT(*) FILTER (
                  WHERE target.status = 'review'
                    AND target.review_decision IS NOT NULL
                ) AS decided_target_count,
                COUNT(*) FILTER (
                  WHERE target.status = 'review'
                    AND target.review_decision IS NULL
                ) AS pending_decision_count,
                COUNT(*) FILTER (WHERE target.review_decision = 'skip') AS skip_decision_count,
                COUNT(*) FILTER (WHERE target.review_decision = 'accept_current') AS accept_current_decision_count,
                COUNT(*) FILTER (WHERE target.review_decision = 'keep_review') AS keep_review_decision_count,
                COUNT(*) FILTER (WHERE target.status = 'failed') AS failed_target_count
           FROM scm_reconciliation_run_targets target
          WHERE target.run_id = run.id
       ) decisions ON true
      ORDER BY run.created_at DESC, run.id DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 30, 1), 200)]
  );
  return result.rows.map(mapRun);
}

function mapRunTarget(row = {}) {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    orderKind: row.order_kind || "",
    orderId: row.netsuite_order_id || null,
    orderRef: row.order_ref || "",
    status: row.status || "",
    attempts: Number(row.attempts || 0),
    checkpoint: row.checkpoint || {},
    proposedChange: row.proposed_change || {},
    result: row.result || {},
    error: row.error || "",
    reviewDecision: row.review_decision || "",
    reviewDecisionNote: row.review_decision_note || "",
    reviewDecisionFingerprint: row.review_decision_fingerprint || "",
    reviewDecidedBy: row.review_decided_by || "",
    reviewDecidedAt: row.review_decided_at || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    updatedAt: row.updated_at || null
  };
}

export async function getScmReconciliationRunDetails(runId, {
  limit = 100,
  offset = 0
} = {}) {
  const id = positiveId(runId);
  if (!id) throw Object.assign(new Error("A valid reconciliation run ID is required."), { status: 400 });
  const pageLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const pageOffset = Math.max(Number(offset) || 0, 0);
  const [runResult, countResult, targetResult] = await Promise.all([
    query(
      `SELECT run.*,
              COALESCE(decisions.review_target_count, 0)::int AS review_target_count,
              COALESCE(decisions.decided_target_count, 0)::int AS decided_target_count,
              COALESCE(decisions.pending_decision_count, 0)::int AS pending_decision_count,
              COALESCE(decisions.skip_decision_count, 0)::int AS skip_decision_count,
              COALESCE(decisions.accept_current_decision_count, 0)::int AS accept_current_decision_count,
              COALESCE(decisions.keep_review_decision_count, 0)::int AS keep_review_decision_count,
              COALESCE(decisions.failed_target_count, 0)::int AS failed_target_count,
              (
                run.status = 'interrupted'
                OR (
                  run.status = 'failed'
                  AND COALESCE(run.checkpoint->>'phase', '') <> 'complete'
                  AND COALESCE(decisions.failed_target_count, 0) = 0
                )
              ) AS resume_allowed
         FROM scm_reconciliation_runs run
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE target.status = 'review') AS review_target_count,
                  COUNT(*) FILTER (
                    WHERE target.status = 'review'
                      AND target.review_decision IS NOT NULL
                  ) AS decided_target_count,
                  COUNT(*) FILTER (
                    WHERE target.status = 'review'
                      AND target.review_decision IS NULL
                  ) AS pending_decision_count,
                  COUNT(*) FILTER (WHERE target.review_decision = 'skip') AS skip_decision_count,
                  COUNT(*) FILTER (WHERE target.review_decision = 'accept_current') AS accept_current_decision_count,
                  COUNT(*) FILTER (WHERE target.review_decision = 'keep_review') AS keep_review_decision_count,
                  COUNT(*) FILTER (WHERE target.status = 'failed') AS failed_target_count
             FROM scm_reconciliation_run_targets target
            WHERE target.run_id = run.id
         ) decisions ON true
        WHERE run.id = $1`,
      [id]
    ),
    query(
      `SELECT COUNT(*)::int AS count
         FROM scm_reconciliation_run_targets
        WHERE run_id = $1`,
      [id]
    ),
    query(
      `SELECT *
         FROM scm_reconciliation_run_targets
        WHERE run_id = $1
        ORDER BY
          CASE status
            WHEN 'review' THEN 0
            WHEN 'failed' THEN 1
            WHEN 'running' THEN 2
            WHEN 'pending' THEN 3
            WHEN 'succeeded' THEN 4
            ELSE 5
          END,
          order_kind,
          COALESCE(order_ref, ''),
          netsuite_order_id
        LIMIT $2 OFFSET $3`,
      [id, pageLimit, pageOffset]
    )
  ]);
  if (!runResult.rows[0]) {
    throw Object.assign(new Error("The PO/TO reconciliation run was not found."), { status: 404 });
  }
  const targetCount = Number(countResult.rows[0]?.count || 0);
  const targets = targetResult.rows.map(mapRunTarget);
  return {
    run: mapRun(runResult.rows[0]),
    targets,
    targetCount,
    limit: pageLimit,
    offset: pageOffset,
    hasMore: pageOffset + targets.length < targetCount
  };
}

export async function listScmReconciliationRunTargetsForResume(runId) {
  const id = positiveId(runId);
  if (!id) return [];
  const result = await query(
    `SELECT *
       FROM scm_reconciliation_run_targets
      WHERE run_id = $1
      ORDER BY order_kind, netsuite_order_id`,
    [id]
  );
  return result.rows.map(mapRunTarget);
}

export async function queueScmReconciliationRunResume(
  runId,
  actor = ""
) {
  const id = positiveId(runId);
  const cleanActor = text(actor);
  if (!id) {
    throw Object.assign(
      new Error("A valid reconciliation run ID is required."),
      { status: 400 }
    );
  }
  if (!cleanActor) {
    throw Object.assign(new Error("Admin identity is required."), { status: 401 });
  }

  return withTransaction(async () => {
    await query(
      "SELECT pg_advisory_xact_lock($1)",
      [SCM_RECONCILIATION_RUN_ADVISORY_LOCK]
    );
    const selected = await query(
      `SELECT *
         FROM scm_reconciliation_runs
        WHERE id = $1
        FOR UPDATE`,
      [id]
    );
    if (!selected.rows[0]) {
      throw Object.assign(
        new Error("The PO/TO reconciliation run was not found."),
        { status: 404 }
      );
    }
    const failedTargets = await query(
      `SELECT COUNT(*)::int AS count
         FROM scm_reconciliation_run_targets
        WHERE run_id = $1
          AND status = 'failed'`,
      [id]
    );
    const row = {
      ...selected.rows[0],
      failed_target_count: Number(failedTargets.rows[0]?.count || 0)
    };
    if (
      ["queued", "running"].includes(row.status)
      && row.checkpoint?.resumeRequestedAt
    ) {
      return mapRun(row);
    }
    const legacyGlobalFailure = row.status === "failed"
      && text(row.checkpoint?.phase).toLowerCase() !== "complete"
      && Number(row.failed_target_count || 0) === 0;
    if (row.status !== "interrupted" && !legacyGlobalFailure) {
      throw Object.assign(
        new Error(
          "Only an interrupted run, or a legacy global failure with no failed order targets, can resume."
        ),
        { status: 409, code: "SCM_RECONCILIATION_NOT_RESUMABLE" }
      );
    }
    const otherActive = await query(
      `SELECT id
         FROM scm_reconciliation_runs
        WHERE id <> $1
          AND status IN ('queued', 'running')
        ORDER BY created_at
        LIMIT 1`,
      [id]
    );
    if (otherActive.rows[0]) {
      throw Object.assign(
        new Error(
          `Wait for reconciliation run #${otherActive.rows[0].id} to finish before resuming this run.`
        ),
        { status: 409, code: "SCM_RECONCILIATION_ALREADY_ACTIVE" }
      );
    }

    // A stale process can leave a target marked running even though its
    // transaction rolled back. Legacy stale recovery used a specific failed
    // marker; only that marker is safe to return to the pending queue.
    await query(
      `UPDATE scm_reconciliation_run_targets
          SET status = 'pending',
              error = NULL,
              completed_at = NULL,
              updated_at = now()
        WHERE run_id = $1
          AND (
            status = 'running'
            OR (
              status = 'failed'
              AND error = 'The reconciliation worker stopped before this target completed.'
            )
          )`,
      [id]
    );

    const resumedAt = new Date().toISOString();
    const checkpoint = {
      ...(row.checkpoint || {}),
      resumeRequested: true,
      resumeRequestedAt: resumedAt,
      resumeRequestedBy: cleanActor,
      resumedFromPhase: text(row.checkpoint?.phase) || "unknown",
      resumeCount: Math.max(0, Number(row.checkpoint?.resumeCount || 0)) + 1,
      previousInterruption: {
        status: row.status,
        error: text(row.error),
        completedAt: row.completed_at || null,
        apiRequestCount: Number(row.api_request_count || 0),
        phase: text(row.checkpoint?.phase) || "unknown"
      },
      ...(row.cancel_requested_at ? {
        lastStopRequestedAt: row.cancel_requested_at,
        lastStopRequestedBy: text(row.cancel_requested_by),
        lastStopRequestNote: text(row.cancel_request_note)
      } : {})
    };
    const updated = await query(
      `UPDATE scm_reconciliation_runs
          SET status = 'queued',
              checkpoint = $2::jsonb,
              error = NULL,
              cancel_requested_at = NULL,
              cancel_requested_by = NULL,
              cancel_request_note = NULL,
              completed_at = NULL,
              heartbeat_at = NULL,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, JSON.stringify(checkpoint)]
    );
    await insertReconciliationAuditEvent({
      eventKey: `manual:run-resume:${id}:${checkpoint.resumeCount}:${crypto.randomUUID()}`,
      runId: id,
      source: "manual",
      eventType: "run.resume_requested",
      recordType: "SYSTEM",
      action: "resume",
      occurredAt: resumedAt,
      payload: {
        resumeCount: checkpoint.resumeCount,
        resumedFromPhase: checkpoint.resumedFromPhase,
        previousStatus: row.status,
        previousError: text(row.error),
        previousCompletedAt: row.completed_at || null,
        apiRequestCount: Number(row.api_request_count || 0)
      },
      actor: cleanActor
    });
    return mapRun({
      ...updated.rows[0],
      failed_target_count: 0,
      resume_allowed: false
    });
  });
}

export async function createScmReconciliationRun({
  triggerSource = "manual",
  scope = "all",
  targetOrderKind = null,
  targetOrderId = null,
  targetOrderRef = "",
  includeTerminalOrders = false,
  dryRun = true,
  applyUnambiguous = false,
  requestedBy = ""
} = {}) {
  const cleanScope = ["all", "PO", "TO", "order_family"].includes(scope) ? scope : "all";
  const kind = ["PO", "TO"].includes(text(targetOrderKind).toUpperCase())
    ? text(targetOrderKind).toUpperCase()
    : null;
  if (cleanScope === "order_family" && !kind) {
    throw Object.assign(new Error("Select PO or TO for an order-family reconciliation."), { status: 400 });
  }
  const runKey = `${triggerSource}:${crypto.randomUUID()}`;
  return withTransaction(async () => {
    await query(
      "SELECT pg_advisory_xact_lock($1)",
      [SCM_RECONCILIATION_RUN_ADVISORY_LOCK]
    );
    const active = await query(
      `SELECT id
         FROM scm_reconciliation_runs
        WHERE status IN ('queued', 'running')
        ORDER BY created_at, id
        LIMIT 1`
    );
    // Webhooks have already been accepted and stored before they reach this
    // point. Keep their targeted work durable behind the active worker instead
    // of dropping the event with a conflict. Interactive/nightly runs still
    // fail fast so an operator cannot accidentally build a long manual queue.
    if (active.rows[0] && triggerSource !== "webhook") {
      throw Object.assign(
        new Error(
          `Reconciliation run #${active.rows[0].id} is already queued or running.`
        ),
        { status: 409, code: "SCM_RECONCILIATION_ALREADY_ACTIVE" }
      );
    }
    try {
      const result = await query(
        `INSERT INTO scm_reconciliation_runs (
           run_key, trigger_source, scope_kind, target_order_kind,
           target_order_netsuite_id, target_order_ref, dry_run,
           apply_unambiguous, include_terminal_orders, status, requested_by
         ) VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), $7, $8, $9, 'queued', $10)
         RETURNING *`,
        [
          runKey,
          triggerSource,
          cleanScope,
          kind,
          positiveId(targetOrderId),
          text(targetOrderRef).toUpperCase(),
          bool(dryRun),
          bool(applyUnambiguous),
          bool(includeTerminalOrders),
          text(requestedBy) || null
        ]
      );
      return mapRun(result.rows[0]);
    } catch (error) {
      if (error.code === "23505") {
        throw Object.assign(
          new Error("Another PO/TO reconciliation is already running."),
          { status: 409 }
        );
      }
      throw error;
    }
  });
}

export async function markScmReconciliationRunRunning(runId) {
  const workerLeaseToken = crypto.randomUUID();
  const result = await query(
    `UPDATE scm_reconciliation_runs
        SET status = 'running',
            checkpoint = checkpoint || jsonb_build_object(
              'workerLeaseToken', $2::text,
              'workerLeaseStartedAt', now()::text
            ),
            started_at = COALESCE(started_at, now()),
            heartbeat_at = now(),
            updated_at = now()
      WHERE id = $1
        AND status IN ('queued', 'interrupted')
      RETURNING *`,
    [Number(runId), workerLeaseToken]
  );
  if (!result.rows[0]) throw Object.assign(new Error("Reconciliation run is not available to start."), { status: 409 });
  return mapRun(result.rows[0]);
}

export async function finishScmReconciliationRun(runId, {
  status = "succeeded",
  summary = {},
  checkpoint = {},
  error = "",
  apiRequestCount = 0,
  expectedWorkerLeaseToken = ""
} = {}) {
  const finalStatus = ["awaiting_approval", "succeeded", "failed", "cancelled", "interrupted"].includes(status)
    ? status
    : "failed";
  return withTransaction(async () => {
    const result = await query(
      `UPDATE scm_reconciliation_runs
          SET status = CASE
                WHEN cancel_requested_at IS NOT NULL AND status = 'running'
                  THEN 'interrupted'
                ELSE $2
              END,
              summary = $3::jsonb,
              checkpoint = $4::jsonb,
              error = CASE
                WHEN cancel_requested_at IS NOT NULL
                  THEN COALESCE(
                    NULLIF(cancel_request_note, ''),
                    'Stopped by an administrator.'
                  )
                ELSE NULLIF($5, '')
              END,
              api_request_count = GREATEST(api_request_count, $6),
              heartbeat_at = now(),
              completed_at = now(),
              updated_at = now()
        WHERE id = $1
          AND (
            (
              status = 'queued'
              AND NULLIF($7, '') IS NULL
            )
            OR (
              status = 'running'
              AND NULLIF($7, '') IS NOT NULL
              AND checkpoint->>'workerLeaseToken' = $7
            )
          )
        RETURNING *`,
      [
        Number(runId),
        finalStatus,
        JSON.stringify(summary || {}),
        JSON.stringify(checkpoint || {}),
        text(error),
        Math.max(0, Number(apiRequestCount) || 0),
        text(expectedWorkerLeaseToken)
      ]
    );
    const row = result.rows[0];
    if (
      row?.status === "succeeded"
      && row.dry_run === false
      && row.scope_kind === "all"
      && row.apply_unambiguous === true
      && positiveId(row.resume_of_run_id)
    ) {
      const approvalActor = text(row.requested_by) || "system";
      const approvedProposal = await query(
        `UPDATE scm_reconciliation_runs
            SET approved_by = $2,
                approved_at = now(),
                status = 'succeeded',
                updated_at = now()
          WHERE id = $1
            AND dry_run = true
            AND scope_kind = 'all'
            AND status = 'awaiting_approval'
          RETURNING id`,
        [positiveId(row.resume_of_run_id), approvalActor]
      );
      if (approvedProposal.rows[0]) {
        await query(
          `UPDATE scm_reconciliation_settings
              SET initial_dry_run_approved_at = now(),
                  initial_dry_run_approved_by = $1,
                  auto_apply_unambiguous = true,
                  updated_by = $1,
                  updated_at = now()
            WHERE singleton_id = 1`,
          [approvalActor]
        );
      }
    }
    if (row?.status === "succeeded" && row.trigger_source === "nightly") {
      await query(
        `UPDATE scm_reconciliation_settings
            SET last_nightly_local_date = GREATEST(
                  last_nightly_local_date,
                  (timezone(time_zone, $1::timestamptz))::date
                ),
                updated_by = COALESCE(NULLIF($2, ''), updated_by),
                updated_at = now()
          WHERE singleton_id = 1`,
        [row.created_at, text(row.requested_by) || "nightly"]
      );
    }
    if (row?.cancel_requested_at) {
      const reason = text(row.cancel_request_note || error)
        || "Stopped by an administrator.";
      const stoppedAt = new Date().toISOString();
      if (row.status === "cancelled") {
        await query(
          `UPDATE scm_reconciliation_run_targets
              SET status = 'skipped',
                  result = result || jsonb_build_object(
                    'reason', $2::text,
                    'stoppedBy', COALESCE($3::text, ''),
                    'stoppedAt', $4::text
                  ),
                  completed_at = now(),
                  updated_at = now()
            WHERE run_id = $1
              AND status IN ('pending', 'running')`,
          [
            Number(runId),
            reason,
            text(row.cancel_requested_by),
            stoppedAt
          ]
        );
      }
      await insertReconciliationAuditEvent({
        eventKey: `manual:run-stop-acknowledged:${Number(runId)}:${crypto.randomUUID()}`,
        runId: Number(runId),
        source: "manual",
        eventType: row.status === "interrupted"
          ? "run.interrupted"
          : "run.stopped",
        recordType: "SYSTEM",
        action: "stop",
        occurredAt: stoppedAt,
        payload: { note: reason, resumable: row.status === "interrupted" },
        actor: text(row.cancel_requested_by) || "system"
      });
    }
    if (row) return mapRun(row);
    const current = await query(
      `SELECT *
         FROM scm_reconciliation_runs
        WHERE id = $1`,
      [Number(runId)]
    );
    return current.rows[0] ? mapRun(current.rows[0]) : null;
  });
}

export async function cancelScmReconciliationRun(runId, actor = "", note = "") {
  const id = positiveId(runId);
  const cleanActor = text(actor);
  const cleanNote = text(note) || "Stopped by an administrator.";
  if (!id) {
    throw Object.assign(
      new Error("A valid reconciliation run ID is required."),
      { status: 400 }
    );
  }
  if (!cleanActor) {
    throw Object.assign(new Error("Admin identity is required."), { status: 401 });
  }
  return withTransaction(async () => {
    const selected = await query(
      `SELECT *
         FROM scm_reconciliation_runs
        WHERE id = $1
        FOR UPDATE`,
      [id]
    );
    if (!selected.rows[0]) {
      throw Object.assign(
        new Error("The PO/TO reconciliation run was not found."),
        { status: 404 }
      );
    }
    if (!["queued", "running"].includes(selected.rows[0].status)) {
      return {
        stopped: false,
        alreadyStopped: selected.rows[0].status === "cancelled",
        stopRequested: false,
        run: mapRun(selected.rows[0])
      };
    }
    if (
      selected.rows[0].status === "running"
      && selected.rows[0].cancel_requested_at
    ) {
      return {
        stopped: false,
        stopRequested: true,
        run: mapRun(selected.rows[0])
      };
    }
    const stoppedAt = new Date().toISOString();
    const queued = selected.rows[0].status === "queued";
    const stopped = await query(
      `UPDATE scm_reconciliation_runs
          SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
              cancel_requested_at = COALESCE(cancel_requested_at, $3::timestamptz),
              cancel_requested_by = COALESCE(cancel_requested_by, $2),
              cancel_request_note = COALESCE(cancel_request_note, $4),
              checkpoint = checkpoint || jsonb_build_object(
                'stopRequestedAt', $3::text,
                'stopRequestedBy', $2::text
              ),
              error = CASE WHEN status = 'queued' THEN $4 ELSE error END,
              heartbeat_at = now(),
              completed_at = CASE WHEN status = 'queued' THEN now() ELSE completed_at END,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, cleanActor, stoppedAt, cleanNote]
    );
    if (queued) {
      await query(
        `UPDATE scm_reconciliation_run_targets
            SET status = 'skipped',
                result = result || jsonb_build_object(
                  'reason', $2::text,
                  'stoppedBy', $3::text,
                  'stoppedAt', $4::text
                ),
                completed_at = now(),
                updated_at = now()
          WHERE run_id = $1
            AND status IN ('pending', 'running')`,
        [id, cleanNote, cleanActor, stoppedAt]
      );
    }
    await insertReconciliationAuditEvent({
      eventKey: `manual:run-${queued ? "stop" : "stop-request"}:${id}:${crypto.randomUUID()}`,
      runId: id,
      source: "manual",
      eventType: queued ? "run.stopped" : "run.stop_requested",
      recordType: "SYSTEM",
      action: queued ? "stop" : "stop_request",
      occurredAt: stoppedAt,
      payload: { note: cleanNote },
      actor: cleanActor
    });
    return {
      stopped: queued,
      stopRequested: !queued,
      run: mapRun(stopped.rows[0])
    };
  });
}

export async function approveInitialScmReconciliationRun(runId, actor = "") {
  const cleanActor = text(actor);
  if (!cleanActor) throw Object.assign(new Error("Admin identity is required."), { status: 401 });
  return withTransaction(async () => {
    const run = await query(
      `UPDATE scm_reconciliation_runs
          SET approved_by = $2,
              approved_at = now(),
              status = 'succeeded',
              updated_at = now()
        WHERE id = $1
          AND dry_run = true
          AND scope_kind = 'all'
          AND status = 'awaiting_approval'
        RETURNING *`,
      [Number(runId), cleanActor]
    );
    if (!run.rows[0]) {
      const alreadyApproved = await query(
        `SELECT *
           FROM scm_reconciliation_runs
          WHERE id = $1
            AND dry_run = true
            AND scope_kind = 'all'
            AND status = 'succeeded'
            AND approved_at IS NOT NULL`,
        [Number(runId)]
      );
      if (alreadyApproved.rows[0]) return mapRun(alreadyApproved.rows[0]);
      throw Object.assign(
        new Error("Only an awaiting initial dry run can be applied."),
        { status: 409 }
      );
    }
    await query(
      `UPDATE scm_reconciliation_settings
          SET initial_dry_run_approved_at = now(),
              initial_dry_run_approved_by = $1,
              auto_apply_unambiguous = true,
              updated_by = $1,
              updated_at = now()
        WHERE singleton_id = 1`,
      [cleanActor]
    );
    return mapRun(run.rows[0]);
  });
}

async function insertReconciliationAuditEvent({
  eventKey,
  runId = null,
  source = "system",
  eventType,
  recordType,
  action,
  validationStatus = "accepted",
  transactionId = null,
  transactionRef = "",
  parentOrderKind = null,
  parentOrderId = null,
  parentOrderRef = "",
  occurredAt = null,
  payloadHash = "",
  payload = {},
  actor = ""
}) {
  const result = await query(
    `INSERT INTO scm_reconciliation_audit_events (
       event_key, run_id, source, event_type, record_type, action,
       validation_status, netsuite_transaction_id, transaction_ref,
       parent_order_kind, parent_order_netsuite_id, parent_order_ref,
       occurred_at, payload_hash, payload, actor
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, NULLIF($9, ''),
       $10, $11, NULLIF($12, ''), $13, NULLIF($14, ''), $15::jsonb,
       NULLIF($16, '')
     )
     ON CONFLICT (event_key) DO NOTHING
     RETURNING *`,
    [
      text(eventKey),
      runId ? Number(runId) : null,
      source,
      text(eventType),
      recordType,
      text(action),
      validationStatus,
      positiveId(transactionId),
      text(transactionRef),
      parentOrderKind,
      positiveId(parentOrderId),
      text(parentOrderRef),
      occurredAt,
      text(payloadHash),
      JSON.stringify(payload || {}),
      text(actor)
    ]
  );
  if (result.rows[0]) return { event: result.rows[0], duplicate: false };
  const existing = await query(
    `SELECT *
       FROM scm_reconciliation_audit_events
      WHERE event_key = $1`,
    [text(eventKey)]
  );
  return { event: existing.rows[0] || null, duplicate: true };
}

async function storeCurrentTransactionSnapshot(normalized, auditEventId, payloadHash) {
  const isDeleted = normalized.tombstone === true;
  const result = await query(
    `INSERT INTO scm_reconciliation_transaction_snapshots (
       transaction_type, netsuite_transaction_id, transaction_ref,
       source_order_kind, source_order_netsuite_id, source_order_ref,
       status_code, status_text, last_action, source_location_id,
       source_location, destination_location_id, destination_location,
       actual_location_id, actual_location, is_deleted, deleted_at,
       netsuite_modified_at, observed_at, latest_event_id, payload_hash,
       snapshot, created_at, updated_at
     ) VALUES (
       $1, $2, NULLIF($3, ''), $4, $5, NULLIF($6, ''),
       NULLIF($7, ''), NULLIF($8, ''), $9, $10,
       NULLIF($11, ''), $12, NULLIF($13, ''), $14,
       NULLIF($15, ''), $16, CASE WHEN $16 THEN $17::timestamptz ELSE NULL END,
       $18::timestamptz, $17::timestamptz, $19, NULLIF($20, ''),
       $21::jsonb, now(), now()
     )
     ON CONFLICT (transaction_type, netsuite_transaction_id) DO UPDATE SET
       transaction_ref = EXCLUDED.transaction_ref,
       source_order_kind = EXCLUDED.source_order_kind,
       source_order_netsuite_id = EXCLUDED.source_order_netsuite_id,
       source_order_ref = EXCLUDED.source_order_ref,
       status_code = EXCLUDED.status_code,
       status_text = EXCLUDED.status_text,
       last_action = EXCLUDED.last_action,
       source_location_id = EXCLUDED.source_location_id,
       source_location = EXCLUDED.source_location,
       destination_location_id = EXCLUDED.destination_location_id,
       destination_location = EXCLUDED.destination_location,
       actual_location_id = EXCLUDED.actual_location_id,
       actual_location = EXCLUDED.actual_location,
       is_deleted = EXCLUDED.is_deleted,
       deleted_at = EXCLUDED.deleted_at,
       netsuite_modified_at = EXCLUDED.netsuite_modified_at,
       observed_at = EXCLUDED.observed_at,
       latest_event_id = EXCLUDED.latest_event_id,
       payload_hash = EXCLUDED.payload_hash,
       snapshot = EXCLUDED.snapshot,
       updated_at = now()
     WHERE COALESCE(
             scm_reconciliation_transaction_snapshots.netsuite_modified_at,
             scm_reconciliation_transaction_snapshots.observed_at
           ) <= COALESCE(EXCLUDED.netsuite_modified_at, EXCLUDED.observed_at)
     RETURNING id`,
    [
      normalized.transactionType,
      normalized.transactionId,
      normalized.transactionRef,
      normalized.sourceOrderKind,
      normalized.sourceOrderId,
      normalized.sourceOrderRef,
      normalized.statusCode,
      normalized.statusText,
      normalized.action === "delete" ? "delete" : normalized.action || "snapshot",
      normalized.sourceLocationId,
      normalized.sourceLocation,
      normalized.destinationLocationId,
      normalized.destinationLocation,
      normalized.actualLocationId,
      normalized.actualLocation,
      isDeleted,
      normalized.eventTime,
      normalized.lastModifiedAt || normalized.eventTime,
      Number(auditEventId),
      payloadHash,
      JSON.stringify(normalized.raw || {})
    ]
  );
  const snapshotId = Number(result.rows[0]?.id);
  if (!snapshotId) return { applied: false, stale: true };

  await query(
    `DELETE FROM scm_reconciliation_transaction_snapshot_lines
      WHERE transaction_snapshot_id = $1`,
    [snapshotId]
  );
  if (!isDeleted) {
    for (const line of normalized.lines) {
      await query(
        `INSERT INTO scm_reconciliation_transaction_snapshot_lines (
           transaction_snapshot_id, netsuite_line_key, source_order_line_key,
           item_id, item_name, sku, quantity, unit, source_location_id,
           destination_location_id, actual_location_id, is_deleted, deleted_at,
           latest_event_id, snapshot, created_at, updated_at
         ) VALUES (
           $1, $2, NULLIF($3, ''), $4, NULLIF($5, ''), NULLIF($6, ''),
           $7, NULLIF($8, ''), $9, $10, $11, false, null, $12,
           $13::jsonb, now(), now()
         )`,
        [
          snapshotId,
          line.transactionLineKey,
          line.sourceLineKey || line.orderLine,
          line.itemId,
          line.itemName,
          line.sku,
          line.quantity,
          line.unit,
          line.sourceLocationId || normalized.sourceLocationId,
          line.destinationLocationId || normalized.destinationLocationId,
          line.actualLocationId || normalized.actualLocationId,
          Number(auditEventId),
          JSON.stringify(line.snapshot || {})
        ]
      );
    }
  }
  return { applied: true, snapshotId, stale: false };
}

export async function storeScmIfIrWebhook(payload = {}, metadata = {}) {
  const normalized = normalizeScmIfIrWebhook(payload, metadata);
  const payloadText = metadata.rawBody || JSON.stringify(payload || {});
  const payloadHash = crypto.createHash("sha256").update(payloadText).digest("hex");
  const relevant = Boolean(normalized.sourceOrderKind && normalized.sourceOrderId);
  return withTransaction(async () => {
    const recorded = await insertReconciliationAuditEvent({
      eventKey: `webhook:${normalized.eventId}`,
      source: "webhook",
      eventType: `if_ir.${normalized.action}`,
      recordType: normalized.transactionType,
      action: normalized.action,
      validationStatus: relevant ? "accepted" : "not_applicable",
      transactionId: normalized.transactionId,
      transactionRef: normalized.transactionRef,
      parentOrderKind: normalized.sourceOrderKind || null,
      parentOrderId: normalized.sourceOrderId,
      parentOrderRef: normalized.sourceOrderRef,
      occurredAt: normalized.eventTime,
      payloadHash,
      payload,
      actor: "netsuite"
    });
    if (recorded.duplicate) {
      return {
        ok: true,
        duplicate: true,
        ignored: !relevant,
        eventId: normalized.eventId,
        sourceOrderKind: normalized.sourceOrderKind,
        sourceOrderId: normalized.sourceOrderId
      };
    }
    if (!relevant) {
      return {
        ok: true,
        ignored: true,
        reason: "source_order_not_po_or_to",
        eventId: normalized.eventId
      };
    }
    const stored = await storeCurrentTransactionSnapshot(
      normalized,
      recorded.event.id,
      payloadHash
    );
    return {
      ok: true,
      duplicate: false,
      stale: stored.stale,
      eventId: normalized.eventId,
      eventDbId: Number(recorded.event.id),
      snapshotId: stored.snapshotId || null,
      sourceOrderKind: normalized.sourceOrderKind,
      sourceOrderId: normalized.sourceOrderId,
      sourceOrderRef: normalized.sourceOrderRef
    };
  });
}

export async function storeLinkedScmReconciliationTransactions({
  order,
  transactions = [],
  source = "manual",
  runId = null,
  authoritativeObservedBefore = null
} = {}) {
  const kind = text(order?.kind).toUpperCase();
  const sourceOrderId = positiveId(order?.id);
  if (!["PO", "TO"].includes(kind) || !sourceOrderId) return { stored: 0, deleted: 0 };
  const grouped = new Map();
  for (const row of transactions || []) {
    if (positiveId(row.sourceOrderId) !== sourceOrderId) continue;
    const type = webhookRecordType(row.transactionType);
    const transactionId = positiveId(row.transactionId);
    if (!type || !transactionId) continue;
    const key = `${type}:${transactionId}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        schemaVersion: RECONCILIATION_SCHEMA_VERSION,
        eventId: `${source}:${key}:${text(row.lastModifiedAt || row.transactionDate || "snapshot")}`,
        eventTime: dateValue(row.lastModifiedAt || row.transactionDate) || new Date().toISOString(),
        action: "edit",
        transactionType: type,
        transactionId,
        transactionRef: row.transactionRef || "",
        statusCode: row.status || "",
        statusText: row.statusText || "",
        lastModifiedAt: dateValue(row.lastModifiedAt || row.transactionDate) || new Date().toISOString(),
        sourceOrderKind: kind,
        sourceOrderId,
        sourceOrderRef: order.tranid || row.sourceOrderRef || "",
        sourceLocationId: order.sourceLocationId || null,
        sourceLocation: order.sourceLocation || "",
        destinationLocationId: order.destinationLocationId || null,
        destinationLocation: order.destinationLocation || "",
        actualLocationId: row.locationId || null,
        actualLocation: row.location || "",
        lines: [],
        raw: {}
      });
    }
    const snapshot = grouped.get(key);
    snapshot.lines.push({
      transactionLineKey: text(row.transactionLineKey || row.transactionLine),
      sourceLineKey: text(row.sourceLineKey || row.sourceOrderLine),
      orderLine: text(row.sourceOrderLine),
      itemId: positiveId(row.itemId),
      itemName: row.itemName || "",
      sku: "",
      quantity: roundReconciliationQuantity(row.quantity),
      unit: row.unit || "",
      sourceLocationId: order.sourceLocationId || null,
      destinationLocationId: order.destinationLocationId || null,
      actualLocationId: row.locationId || null,
      snapshot: row
    });
  }

  let stored = 0;
  const currentIds = { IF: new Set(), IR: new Set() };
  for (const normalized of grouped.values()) {
    currentIds[normalized.transactionType].add(normalized.transactionId);
    normalized.raw = {
      source: "suiteql",
      order: { id: sourceOrderId, kind, tranid: order.tranid || "" },
      lines: normalized.lines.map((line) => line.snapshot)
    };
    const payloadHash = crypto.createHash("sha256").update(JSON.stringify(normalized.raw)).digest("hex");
    const applied = await withTransaction(async () => {
      const recorded = await insertReconciliationAuditEvent({
        eventKey: `${source}:snapshot:${normalized.transactionType}:${normalized.transactionId}:${normalized.lastModifiedAt}:${payloadHash}`,
        runId,
        source,
        eventType: "if_ir.snapshot",
        recordType: normalized.transactionType,
        action: "snapshot",
        transactionId: normalized.transactionId,
        transactionRef: normalized.transactionRef,
        parentOrderKind: kind,
        parentOrderId: sourceOrderId,
        parentOrderRef: order.tranid || "",
        occurredAt: normalized.eventTime,
        payloadHash,
        payload: normalized.raw,
        actor: source
      });
      normalized.action = "snapshot";
      return storeCurrentTransactionSnapshot(normalized, recorded.event.id, payloadHash);
    });
    if (applied.applied) stored += 1;
  }

  const cutoff = dateValue(authoritativeObservedBefore);
  const active = await query(
    `SELECT id, transaction_type, netsuite_transaction_id, transaction_ref,
            source_order_ref, snapshot, latest_event_id
       FROM scm_reconciliation_transaction_snapshots
      WHERE source_order_kind = $1
        AND source_order_netsuite_id = $2
        AND is_deleted = false
        AND ($3::timestamptz IS NULL OR updated_at <= $3::timestamptz)`,
    [kind, sourceOrderId, cutoff]
  );
  let deleted = 0;
  for (const existing of active.rows) {
    if (currentIds[existing.transaction_type]?.has(Number(existing.netsuite_transaction_id))) continue;
    const eventKey = `${source}:tombstone:${existing.transaction_type}:${existing.netsuite_transaction_id}:${runId || Date.now()}`;
    const tombstoned = await withTransaction(async () => {
      const recorded = await insertReconciliationAuditEvent({
        eventKey,
        runId,
        source,
        eventType: "if_ir.missing_from_authoritative_snapshot",
        recordType: existing.transaction_type,
        action: "delete",
        transactionId: existing.netsuite_transaction_id,
        transactionRef: existing.transaction_ref,
        parentOrderKind: kind,
        parentOrderId: sourceOrderId,
        parentOrderRef: existing.source_order_ref,
        occurredAt: new Date().toISOString(),
        payload: {
          previousSnapshot: existing.snapshot,
          reason: "Absent from a successful full linked-transaction query."
        },
        actor: source
      });
      const updated = await query(
        `UPDATE scm_reconciliation_transaction_snapshots
            SET last_action = 'delete',
                is_deleted = true,
                deleted_at = now(),
                observed_at = now(),
                latest_event_id = $2,
                updated_at = now()
          WHERE id = $1
            AND is_deleted = false
            AND ($3::timestamptz IS NULL OR updated_at <= $3::timestamptz)`,
        [existing.id, recorded.event.id, cutoff]
      );
      if (!updated.rowCount) return false;
      await query(
        `UPDATE scm_reconciliation_transaction_snapshot_lines
            SET is_deleted = true,
                deleted_at = now(),
                latest_event_id = $2,
                updated_at = now()
          WHERE transaction_snapshot_id = $1`,
        [existing.id, recorded.event.id]
      );
      return true;
    });
    if (tombstoned) deleted += 1;
  }
  return { stored, deleted };
}

export async function loadLocalScmReconciliationOrder(kind, sourceOrderId) {
  const orderKind = text(kind).toUpperCase();
  const id = positiveId(sourceOrderId);
  if (!["PO", "TO"].includes(orderKind) || !id) return null;
  if (orderKind === "PO") {
    const header = await query(
      `SELECT po.netsuite_id, po.tranid, po.dispatch_ref, po.trandate,
              po.status, po.status_text, po.vendor_id, po.vendor, po.memo,
              po.foreign_total, po.source_location_id, po.source_location,
              po.destination_location_id, po.destination_location,
              po.expected_delivery_date, po.receipt_status, po.netsuite_active,
              po.status_updated_at, po.synced_at,
              schedule.id AS schedule_id,
              schedule.status AS schedule_status,
              schedule.eta_date AS schedule_eta_date,
              schedule.updated_at AS schedule_updated_at
         FROM purchase_orders po
         LEFT JOIN LATERAL (
           SELECT candidate.id,
                  CASE
                    WHEN active_group.id IS NOT NULL
                     AND group_schedule.id IS NOT NULL
                     AND (
                       group_schedule.status IN (
                         'Planned', 'Partially Done', 'In Transit',
                         'Completed', 'Reconcile Review'
                       )
                       OR group_schedule.eta_date IS NOT NULL
                     )
                    THEN group_schedule.status
                    ELSE candidate.status
                  END AS status,
                  CASE
                    WHEN active_group.id IS NOT NULL
                     AND group_schedule.id IS NOT NULL
                     AND (
                       group_schedule.status IN (
                         'Planned', 'Partially Done', 'In Transit',
                         'Completed', 'Reconcile Review'
                       )
                       OR group_schedule.eta_date IS NOT NULL
                     )
                    THEN group_schedule.eta_date
                    ELSE candidate.eta_date
                  END AS eta_date,
                  GREATEST(
                    candidate.updated_at,
                    CASE WHEN active_group.id IS NOT NULL
                      THEN group_schedule.updated_at
                    END
                  ) AS updated_at
             FROM scm_transport_schedule candidate
             LEFT JOIN scm_schedule_groups active_group
               ON active_group.status = 'active'
              AND lower(active_group.group_ref) = lower(
                COALESCE(candidate.group_ref, '')
              )
             LEFT JOIN scm_transport_schedule group_schedule
               ON group_schedule.order_kind = 'PO'
              AND lower(group_schedule.order_ref) = lower(active_group.group_ref)
            WHERE candidate.order_kind = 'PO'
              AND (
                candidate.source_id = po.netsuite_id
                OR (
                  candidate.source_id IS NULL
                  AND lower(candidate.order_ref) = lower(
                    COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid)
                  )
                )
              )
            ORDER BY
              CASE WHEN candidate.source_id = po.netsuite_id THEN 0 ELSE 1 END,
              candidate.updated_at DESC,
              candidate.id DESC
            LIMIT 1
         ) schedule ON true
        WHERE po.netsuite_id = $1`,
      [id]
    );
    if (!header.rows[0]) return null;
    const lines = await query(
      `SELECT *
         FROM purchase_order_lines
        WHERE purchase_order_id = $1
        ORDER BY line_id NULLS LAST, id`,
      [id]
    );
    const row = header.rows[0];
    const mappedLines = lines.rows.map((line) => ({
      localLineId: Number(line.id),
      netsuiteActive: line.netsuite_active !== false,
      sourceLineKey: text(line.line_id || line.id),
      sourceLineAliases: textList(
        line.raw?.sourceLineAliases,
        [line.line_id || line.id]
      ),
      orderLine: text(line.raw?.orderLine ?? line.raw?.order_line ?? line.line_id),
      orderLineAliases: textList(
        line.raw?.orderLineAliases,
        [line.raw?.orderLine ?? line.raw?.order_line ?? line.line_id]
      ),
      identityStatus: text(line.raw?.identityStatus || "exact"),
      identityIssue: text(line.raw?.identityIssue),
      logicalLineIdentity: text(line.raw?.logicalLineIdentity),
      stage: "receiving",
      itemId: positiveId(line.item_id),
      itemName: line.item_name || "",
      sku: line.sku || "",
      quantity: roundReconciliationQuantity(line.quantity),
      cumulativeProgressQuantity: roundReconciliationQuantity(
        line.netsuite_received_qty
      ),
      unit: line.unit || "",
      locationId: line.location_id || row.destination_location_id || null,
      location: line.location || row.destination_location || "",
      itemWeight: line.item_weight,
      palletQty: reconciliationQuantity(line.pallet_qty),
      layerQty: reconciliationQuantity(line.layer_qty),
      sectionQty: reconciliationQuantity(line.section_qty),
      pieceQty: reconciliationQuantity(line.piece_qty),
      toPlt: reconciliationQuantity(line.to_plt),
      toLyr: reconciliationQuantity(line.to_lyr),
      toSec: reconciliationQuantity(line.to_sec),
      toPcs: reconciliationQuantity(line.to_pcs),
      raw: line.raw || {}
    }));
    const plannedScheduleStatuses = new Set([
      "Planned",
      "Partially Done",
      "In Transit",
      "Completed",
      "Reconcile Review"
    ]);
    return {
      id,
      kind: "PO",
      tranid: row.tranid || "",
      scheduleRef: row.dispatch_ref || row.tranid || "",
      trandate: row.trandate,
      status: row.status || "",
      statusText: row.status_text || "",
      entityId: row.vendor_id || null,
      entity: row.vendor || "",
      memo: row.memo || "",
      foreignTotal: row.foreign_total,
      sourceLocationId: row.source_location_id || null,
      sourceLocation: row.source_location || "",
      destinationLocationId: row.destination_location_id || null,
      destinationLocation: row.destination_location || "",
      expectedDeliveryDate: row.expected_delivery_date,
      localStatus: row.receipt_status || "Queued",
      dispatchPlanned: Boolean(row.schedule_id) && (
        plannedScheduleStatuses.has(text(row.schedule_status))
        || Boolean(row.schedule_eta_date)
      ),
      dispatchPlanDate: row.schedule_eta_date || null,
      dispatchPlannedAt: row.schedule_updated_at || null,
      lastModifiedAt: row.status_updated_at || row.synced_at || null,
      lines: mappedLines.filter((line) => line.netsuiteActive),
      historicalLines: mappedLines.filter((line) => !line.netsuiteActive)
    };
  }

  const header = await query(
    `SELECT netsuite_id, tranid, trandate, status, status_text,
            from_location_id, from_location, to_location_id, to_location,
            memo, expected_delivery_date, fulfillment_status, receiving_status,
            netsuite_active, dispatch_planned, dispatch_plan_date,
            dispatch_planned_at, status_updated_at, synced_at
       FROM transfer_orders
      WHERE netsuite_id = $1`,
    [id]
  );
  if (!header.rows[0]) return null;
  const lines = await query(
    `SELECT *
       FROM transfer_order_lines
      WHERE transfer_order_id = $1
      ORDER BY line_stage, line_id NULLS LAST, id`,
    [id]
  );
  const row = header.rows[0];
  const mappedLines = lines.rows.map((line) => ({
    localLineId: Number(line.id),
    netsuiteActive: line.netsuite_active !== false,
    sourceLineKey: text(line.line_id || line.id),
    sourceLineAliases: textList(
      line.raw?.sourceLineAliases,
      [line.line_id || line.id]
    ),
    orderLine: text(line.raw?.orderLine ?? line.raw?.order_line ?? line.line_id),
    orderLineAliases: textList(
      line.raw?.orderLineAliases,
      [line.raw?.orderLine ?? line.raw?.order_line ?? line.line_id]
    ),
    identityStatus: text(line.raw?.identityStatus || "exact"),
    identityIssue: text(line.raw?.identityIssue),
    logicalLineIdentity: text(line.raw?.logicalLineIdentity),
    stage: line.line_stage || "outbound",
    itemId: positiveId(line.item_id),
    itemName: line.item_name || "",
    sku: line.sku || "",
    quantity: roundReconciliationQuantity(line.quantity),
    cumulativeProgressQuantity: roundReconciliationQuantity(
      line.line_stage === "outbound"
        ? line.loaded_qty
        : line.netsuite_received_qty
    ),
    unit: line.unit || "",
    locationId: line.location_id || null,
    location: line.location || "",
    itemWeight: line.item_weight,
    palletQty: reconciliationQuantity(line.pallet_qty),
    layerQty: reconciliationQuantity(line.layer_qty),
    sectionQty: reconciliationQuantity(line.section_qty),
    pieceQty: reconciliationQuantity(line.piece_qty),
    toPlt: reconciliationQuantity(line.to_plt),
    toLyr: reconciliationQuantity(line.to_lyr),
    toSec: reconciliationQuantity(line.to_sec),
    toPcs: reconciliationQuantity(line.to_pcs),
    raw: line.raw || {}
  }));
  return {
    id,
    kind: "TO",
    tranid: row.tranid || "",
    scheduleRef: row.tranid || "",
    trandate: row.trandate,
    status: row.status || "",
    statusText: row.status_text || "",
    memo: row.memo || "",
    sourceLocationId: row.from_location_id || null,
    sourceLocation: row.from_location || "",
    destinationLocationId: row.to_location_id || null,
    destinationLocation: row.to_location || "",
    expectedDeliveryDate: row.expected_delivery_date,
    localStatus: row.receiving_status || row.fulfillment_status || "Queued",
    dispatchPlanned: row.dispatch_planned === true,
    dispatchPlanDate: row.dispatch_plan_date || null,
    dispatchPlannedAt: row.dispatch_planned_at || null,
    lastModifiedAt: row.status_updated_at || row.synced_at || null,
    lines: mappedLines.filter((line) => line.netsuiteActive),
    historicalLines: mappedLines.filter((line) => !line.netsuiteActive)
  };
}

async function currentTransactionProgress(sourceOrderKind, sourceOrderId) {
  const [result, observed] = await Promise.all([
    query(
    `SELECT snapshot.transaction_type,
            snapshot.netsuite_transaction_id,
            snapshot.transaction_ref,
            snapshot.status_text,
            snapshot.actual_location_id,
            snapshot.actual_location,
            line.id AS transaction_line_state_id,
            line.netsuite_line_key,
            line.source_order_line_key,
            line.item_id,
            line.quantity,
            line.unit,
            line.actual_location_id AS line_actual_location_id,
            line.snapshot,
            line.latest_event_id
       FROM scm_reconciliation_transaction_snapshots snapshot
       JOIN scm_reconciliation_transaction_snapshot_lines line
         ON line.transaction_snapshot_id = snapshot.id
        AND line.is_deleted = false
      WHERE snapshot.source_order_kind = $1
        AND snapshot.source_order_netsuite_id = $2
        AND snapshot.is_deleted = false
        AND UPPER(COALESCE(snapshot.status_text, '')) NOT LIKE '%VOID%'
        AND UPPER(COALESCE(snapshot.status_text, '')) NOT LIKE '%CANCEL%'
        AND UPPER(COALESCE(snapshot.status_text, '')) NOT LIKE '%REJECT%'
      ORDER BY snapshot.transaction_type, snapshot.netsuite_transaction_id,
               line.netsuite_line_key`,
    [sourceOrderKind, sourceOrderId]
    ),
    query(
      `SELECT DISTINCT transaction_type
         FROM scm_reconciliation_transaction_snapshots
        WHERE source_order_kind = $1
          AND source_order_netsuite_id = $2`,
      [sourceOrderKind, sourceOrderId]
    )
  ]);
  const deduped = new Map();
  for (const row of result.rows) {
    const key = [
      row.transaction_type,
      row.netsuite_transaction_id,
      row.netsuite_line_key
    ].join("|");
    deduped.set(key, row);
  }
  return {
    rows: [...deduped.values()],
    observedTypes: new Set(observed.rows.map((row) => row.transaction_type))
  };
}

function salesQuantityFromPack(line = {}, prefix = "") {
  const value = (name) => reconciliationQuantity(line[`${prefix}${name}`]);
  const converted = (value("pallet_qty") * reconciliationQuantity(line.to_plt))
    + (value("layer_qty") * reconciliationQuantity(line.to_lyr))
    + (value("section_qty") * reconciliationQuantity(line.to_sec))
    + (value("piece_qty") * reconciliationQuantity(line.to_pcs));
  return roundReconciliationQuantity(converted);
}

async function loadSplitLineTargets(order, sourceLine) {
  if (order.kind === "PO") {
    const result = await query(
      `SELECT split_line.id AS ledger_line_id,
              split_header.split_po_ref AS target_order_ref,
              split_header.split_po_id AS target_order_id,
              split_header.created_at,
              split_line.split_line_id AS target_local_line_id,
              split_line.sales_qty,
              split_line.requested_sales_qty,
              child_line.netsuite_received_qty,
              child_line.received_sales_qty,
              child_line.received_pallet_qty,
              child_line.received_layer_qty,
              child_line.received_section_qty,
              child_line.received_piece_qty,
              child_line.to_plt, child_line.to_lyr, child_line.to_sec, child_line.to_pcs,
              schedule.eta_date,
              schedule.status AS schedule_status,
              schedule.updated_at AS schedule_updated_at
         FROM dispatch_scm_po_split_lines split_line
         JOIN dispatch_scm_po_splits split_header
           ON split_header.id = split_line.split_id
          AND split_header.status = 'active'
         JOIN purchase_order_lines child_line ON child_line.id = split_line.split_line_id
         JOIN purchase_orders child ON child.netsuite_id = split_header.split_po_id
         LEFT JOIN scm_transport_schedule schedule
           ON schedule.order_kind = 'PO'
          AND lower(schedule.order_ref) = lower(split_header.split_po_ref)
        WHERE split_line.source_line_id = $1
        ORDER BY schedule.updated_at,
                 schedule.eta_date,
                 split_header.created_at, split_header.id`,
      [sourceLine.localLineId]
    );
    return result.rows.map((row) => ({
      targetKind: "po_split",
      ledgerLineId: Number(row.ledger_line_id),
      targetOrderRef: row.target_order_ref,
      targetOrderId: Number(row.target_order_id),
      targetLocalLineId: Number(row.target_local_line_id),
      requestedQty: roundReconciliationQuantity(row.requested_sales_qty ?? row.sales_qty),
      currentQty: roundReconciliationQuantity(row.sales_qty),
      exactReceivedQty: Math.max(
        reconciliationQuantity(row.netsuite_received_qty),
        reconciliationQuantity(row.received_sales_qty),
        salesQuantityFromPack(row, "received_")
      ),
      exactFulfilledQty: 0,
      actualDispatchAt: ["Planned", "Partially Done", "In Transit", "Completed"].includes(row.schedule_status)
        ? row.schedule_updated_at
        : null,
      plannedEta: row.eta_date,
      createdAt: row.created_at
    }));
  }
  const result = await query(
    `SELECT split_line.id AS ledger_line_id,
            split_header.split_to_ref AS target_order_ref,
            split_header.split_to_id AS target_order_id,
            split_header.created_at,
            split_line.split_line_id AS target_local_line_id,
            split_line.sales_qty,
            split_line.requested_sales_qty,
            child_line.loaded_qty,
            child_line.netsuite_received_qty,
            child_line.received_sales_qty,
            child_line.fulfilled_pallet_qty,
            child_line.fulfilled_layer_qty,
            child_line.fulfilled_section_qty,
            child_line.fulfilled_piece_qty,
            child_line.received_pallet_qty,
            child_line.received_layer_qty,
            child_line.received_section_qty,
            child_line.received_piece_qty,
            child_line.to_plt, child_line.to_lyr, child_line.to_sec, child_line.to_pcs,
            child.dispatch_planned_at,
            child.fulfilled_at,
            child.dispatch_plan_date,
            schedule.eta_date,
            schedule.updated_at AS schedule_updated_at
       FROM dispatch_scm_to_split_lines split_line
       JOIN dispatch_scm_to_splits split_header
         ON split_header.id = split_line.split_id
        AND split_header.status = 'active'
       JOIN transfer_order_lines child_line
         ON child_line.line_stage = split_line.split_line_stage
        AND child_line.id = split_line.split_line_id
       JOIN transfer_orders child ON child.netsuite_id = split_header.split_to_id
       LEFT JOIN scm_transport_schedule schedule
         ON schedule.order_kind = 'TO'
        AND lower(schedule.order_ref) = lower(split_header.split_to_ref)
      WHERE split_line.source_line_stage = 'outbound'
        AND split_line.source_line_id = $1
      ORDER BY COALESCE(child.dispatch_planned_at, schedule.updated_at),
               COALESCE(child.dispatch_plan_date, schedule.eta_date),
               split_header.created_at, split_header.id`,
    [sourceLine.localLineId]
  );
  return result.rows.map((row) => ({
    targetKind: "to_split",
    ledgerLineId: Number(row.ledger_line_id),
    targetOrderRef: row.target_order_ref,
    targetOrderId: Number(row.target_order_id),
    targetLocalLineId: Number(row.target_local_line_id),
    requestedQty: roundReconciliationQuantity(row.requested_sales_qty ?? row.sales_qty),
    currentQty: roundReconciliationQuantity(row.sales_qty),
    exactFulfilledQty: Math.max(
      reconciliationQuantity(row.loaded_qty),
      salesQuantityFromPack(row, "fulfilled_")
    ),
    exactReceivedQty: Math.max(
      reconciliationQuantity(row.netsuite_received_qty),
      reconciliationQuantity(row.received_sales_qty),
      salesQuantityFromPack(row, "received_")
    ),
    actualDispatchAt: row.fulfilled_at || row.dispatch_planned_at,
    plannedEta: row.dispatch_plan_date || row.eta_date,
    createdAt: row.created_at
  }));
}

async function loadActiveToSplitIntegrity(order) {
  if (order.kind !== "TO") return [];
  const result = await query(
    `SELECT split.id AS split_id,
            split.split_to_ref AS target_order_ref,
            split.split_to_id AS target_order_id,
            split.created_at,
            child.dispatch_planned_at,
            child.dispatch_plan_date,
            schedule.eta_date,
            schedule.status AS schedule_status,
            COALESCE(ledger.ledger_line_count, 0)::int AS ledger_line_count,
            COALESCE(ledger.active_mapped_line_count, 0)::int AS active_mapped_line_count,
            COALESCE(child_lines.active_child_line_count, 0)::int AS active_child_line_count
       FROM dispatch_scm_to_splits split
       LEFT JOIN transfer_orders child
         ON child.netsuite_id = split.split_to_id
       LEFT JOIN scm_transport_schedule schedule
         ON schedule.order_kind = 'TO'
        AND lower(schedule.order_ref) = lower(split.split_to_ref)
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS ledger_line_count,
                COUNT(*) FILTER (
                  WHERE mapped_child.id IS NOT NULL
                    AND mapped_child.netsuite_active = true
                ) AS active_mapped_line_count
           FROM dispatch_scm_to_split_lines split_line
           LEFT JOIN transfer_order_lines mapped_child
             ON mapped_child.line_stage = split_line.split_line_stage
            AND mapped_child.id = split_line.split_line_id
          WHERE split_line.split_id = split.id
       ) ledger ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS active_child_line_count
           FROM transfer_order_lines child_line
          WHERE child_line.transfer_order_id = split.split_to_id
            AND child_line.line_stage = 'outbound'
            AND child_line.netsuite_active = true
       ) child_lines ON true
      WHERE split.source_to_id = $1
        AND split.status = 'active'
      ORDER BY split.created_at, split.id`,
    [order.id]
  );
  return result.rows.map((row) => {
    const ledgerLineCount = Number(row.ledger_line_count || 0);
    const activeMappedLineCount = Number(row.active_mapped_line_count || 0);
    const activeChildLineCount = Number(row.active_child_line_count || 0);
    return {
      splitId: Number(row.split_id),
      targetOrderRef: row.target_order_ref || "",
      targetOrderId: Number(row.target_order_id),
      createdAt: row.created_at,
      hasActivePlan: Boolean(
        row.dispatch_planned_at
        || row.dispatch_plan_date
        || row.eta_date
        || ["Planned", "Partially Done", "In Transit", "Completed"].includes(row.schedule_status)
      ),
      ledgerLineCount,
      activeMappedLineCount,
      activeChildLineCount,
      integrityOk: ledgerLineCount > 0
        && activeMappedLineCount === ledgerLineCount
        && activeChildLineCount === ledgerLineCount
    };
  });
}

async function loadActiveSplitLineReferences(order, sourceLine) {
  const localLineId = positiveId(sourceLine.localLineId);
  if (!localLineId) return [];
  if (order.kind === "PO") {
    const result = await query(
      `SELECT split_line.id AS ledger_line_id,
              split.split_po_ref AS target_order_ref
         FROM dispatch_scm_po_split_lines split_line
         JOIN dispatch_scm_po_splits split
           ON split.id = split_line.split_id
          AND split.status = 'active'
        WHERE split_line.source_line_id = $1
        ORDER BY split.id, split_line.id`,
      [localLineId]
    );
    return result.rows;
  }
  const result = await query(
    `SELECT split_line.id AS ledger_line_id,
            split.split_to_ref AS target_order_ref
       FROM dispatch_scm_to_split_lines split_line
       JOIN dispatch_scm_to_splits split
         ON split.id = split_line.split_id
        AND split.status = 'active'
      WHERE split_line.source_line_stage = 'outbound'
        AND split_line.source_line_id = $1
      ORDER BY split.id, split_line.id`,
    [localLineId]
  );
  return result.rows;
}

function uniqueLineIndex(lines, field) {
  const index = new Map();
  for (const line of lines) {
    const key = text(line[field]);
    if (!key) continue;
    if (index.has(key)) index.set(key, null);
    else index.set(key, line);
  }
  return index;
}

function uniqueLineAliasIndex(lines, fields) {
  const index = new Map();
  for (const line of lines) {
    const aliases = new Set();
    for (const field of fields) {
      const value = line[field];
      if (Array.isArray(value)) {
        for (const alias of value) {
          const key = text(alias);
          if (key) aliases.add(key);
        }
      } else {
        const key = text(value);
        if (key) aliases.add(key);
      }
    }
    for (const alias of aliases) {
      if (index.has(alias) && index.get(alias) !== line) index.set(alias, null);
      else if (!index.has(alias)) index.set(alias, line);
    }
  }
  return index;
}

export function matchCurrentProgress(order, current) {
  const byStage = {
    outbound: (order.lines || []).filter((line) => line.stage === "outbound"),
    receiving: (order.lines || []).filter((line) => line.stage === "receiving")
  };
  const indexes = {};
  for (const stage of ["outbound", "receiving"]) {
    indexes[stage] = {
      sourceLineKey: uniqueLineAliasIndex(
        byStage[stage],
        ["sourceLineKey", "sourceLineAliases"]
      ),
      orderLine: uniqueLineAliasIndex(
        byStage[stage],
        ["orderLine", "orderLineAliases"]
      )
    };
  }
  const lineProgress = new Map((order.lines || []).map((line) => [
    `${line.stage}:${line.localLineId || line.sourceLineKey}`,
    { fulfilled: 0, received: 0, exact: true }
  ]));
  const unmatched = [];
  const matchedRows = [];
  const seen = new Set();
  for (const row of current.rows || []) {
    const stage = row.transaction_type === "IF" ? "outbound" : "receiving";
    if (order.kind === "PO" && stage !== "receiving") continue;
    const sourceKey = text(row.source_order_line_key);
    let line = indexes[stage].sourceLineKey.get(sourceKey);
    if (line === undefined) line = indexes[stage].orderLine.get(sourceKey);
    const dedupeKey = [
      row.transaction_type,
      row.netsuite_transaction_id,
      row.netsuite_line_key,
      sourceKey
    ].join("|");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    if (!line) {
      unmatched.push(row);
      continue;
    }
    const key = `${line.stage}:${line.localLineId || line.sourceLineKey}`;
    const progress = lineProgress.get(key);
    const quantity = roundReconciliationQuantity(row.quantity);
    if (row.transaction_type === "IF") progress.fulfilled = roundReconciliationQuantity(progress.fulfilled + quantity);
    else progress.received = roundReconciliationQuantity(progress.received + quantity);
    matchedRows.push({ ...row, matchedLine: line });
  }
  return { byStage, lineProgress, unmatched, matchedRows };
}

export function scmReconciliationLineIdentityIssues(lines = []) {
  return (lines || [])
    .filter((line) => text(line.identityStatus || "exact") !== "exact")
    .map((line) =>
      text(line.identityIssue)
      || `NetSuite line ${line.sourceLineKey || line.orderLine || "unknown"} has ambiguous identity.`
    );
}

function currentLifecycleTerminal(statusText) {
  const lifecycle = classifyNetSuiteLifecycle(statusText);
  if (lifecycle.cancelled) return lifecycle.text.includes("void") ? "voided" : "cancelled";
  if (lifecycle.closed) return "closed";
  return "open";
}

async function orderPreviousState(kind, sourceOrderId) {
  const result = await query(
    `SELECT *
       FROM scm_reconciliation_order_state
      WHERE order_kind = $1
        AND source_order_netsuite_id = $2`,
    [kind, sourceOrderId]
  );
  return result.rows[0] || null;
}

async function upsertOrderState({
  order,
  derived,
  reconciliationReason,
  reconciliationSource,
  exactAllocation,
  runId,
  lastEventId,
  recovered,
  targetStates,
  lineSummary,
  dryRun
}) {
  const proposed = {
    applicationStatus: derived.applicationStatus,
    reconciliationStatus: reconciliationReason ? "review" : derived.reconciliationStatus,
    reason: reconciliationReason || derived.reason,
    quantities: derived.quantities,
    exactAllocation,
    targets: targetStates,
    lines: lineSummary
  };
  const result = await query(
    `INSERT INTO scm_reconciliation_order_state (
       order_kind, source_order_netsuite_id, source_order_ref,
       netsuite_status_code, netsuite_status_text, netsuite_terminal_state,
       application_status, reconciliation_status, reconciliation_reason,
       reconciliation_source, is_recovered, recovered_at,
       source_location_id, source_location, destination_location_id,
       destination_location, ordered_qty, fulfilled_qty, received_qty,
       abandoned_qty, remaining_qty, destination_remaining_qty,
       exact_allocation, last_netsuite_modified_at, last_event_id, last_run_id,
       quantity_summary, order_snapshot, proposed_state, reconciled_at,
       completed_at, cancelled_at, status_changed_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), $6,
       CASE WHEN $29 THEN 'Queued' ELSE $7 END,
       CASE WHEN $29 THEN 'pending' ELSE $8 END,
       CASE WHEN $29 THEN NULL ELSE NULLIF($9, '') END,
       $10, $11,
       CASE WHEN $11 THEN now() ELSE NULL END,
       $12, NULLIF($13, ''), $14, NULLIF($15, ''),
       $16, $17, $18, $19, $20, $21,
       $22, $23, $24, $25,
       $26::jsonb, $27::jsonb, $28::jsonb,
       CASE WHEN $29 THEN NULL ELSE now() END,
       CASE WHEN NOT $29 AND $7 = 'Completed' THEN now() ELSE NULL END,
       CASE WHEN NOT $29 AND $7 = 'Cancelled' THEN now() ELSE NULL END,
       now(), now(), now()
     )
     ON CONFLICT (order_kind, source_order_netsuite_id) DO UPDATE SET
       source_order_ref = EXCLUDED.source_order_ref,
       netsuite_status_code = EXCLUDED.netsuite_status_code,
       netsuite_status_text = EXCLUDED.netsuite_status_text,
       netsuite_terminal_state = EXCLUDED.netsuite_terminal_state,
       application_status = CASE
         WHEN $29 THEN scm_reconciliation_order_state.application_status
         ELSE EXCLUDED.application_status
       END,
       reconciliation_status = CASE
         WHEN $29 THEN 'pending'
         ELSE EXCLUDED.reconciliation_status
       END,
       reconciliation_reason = CASE
         WHEN $29 THEN scm_reconciliation_order_state.reconciliation_reason
         ELSE EXCLUDED.reconciliation_reason
       END,
       reconciliation_source = EXCLUDED.reconciliation_source,
       is_recovered = scm_reconciliation_order_state.is_recovered OR EXCLUDED.is_recovered,
       recovered_at = CASE
         WHEN scm_reconciliation_order_state.is_recovered THEN scm_reconciliation_order_state.recovered_at
         WHEN EXCLUDED.is_recovered THEN now()
         ELSE NULL
       END,
       source_location_id = EXCLUDED.source_location_id,
       source_location = EXCLUDED.source_location,
       destination_location_id = EXCLUDED.destination_location_id,
       destination_location = EXCLUDED.destination_location,
       ordered_qty = CASE WHEN $29 THEN scm_reconciliation_order_state.ordered_qty ELSE EXCLUDED.ordered_qty END,
       fulfilled_qty = CASE WHEN $29 THEN scm_reconciliation_order_state.fulfilled_qty ELSE EXCLUDED.fulfilled_qty END,
       received_qty = CASE WHEN $29 THEN scm_reconciliation_order_state.received_qty ELSE EXCLUDED.received_qty END,
       abandoned_qty = CASE WHEN $29 THEN scm_reconciliation_order_state.abandoned_qty ELSE EXCLUDED.abandoned_qty END,
       remaining_qty = CASE WHEN $29 THEN scm_reconciliation_order_state.remaining_qty ELSE EXCLUDED.remaining_qty END,
       destination_remaining_qty = CASE WHEN $29 THEN scm_reconciliation_order_state.destination_remaining_qty ELSE EXCLUDED.destination_remaining_qty END,
       exact_allocation = CASE WHEN $29 THEN scm_reconciliation_order_state.exact_allocation ELSE EXCLUDED.exact_allocation END,
       last_netsuite_modified_at = EXCLUDED.last_netsuite_modified_at,
       last_event_id = COALESCE(EXCLUDED.last_event_id, scm_reconciliation_order_state.last_event_id),
       last_run_id = COALESCE(EXCLUDED.last_run_id, scm_reconciliation_order_state.last_run_id),
       quantity_summary = CASE WHEN $29 THEN scm_reconciliation_order_state.quantity_summary ELSE EXCLUDED.quantity_summary END,
       order_snapshot = EXCLUDED.order_snapshot,
       proposed_state = EXCLUDED.proposed_state,
       reconciled_at = CASE WHEN $29 THEN scm_reconciliation_order_state.reconciled_at ELSE now() END,
       completed_at = CASE
         WHEN NOT $29 AND EXCLUDED.application_status = 'Completed'
         THEN COALESCE(scm_reconciliation_order_state.completed_at, now())
         WHEN NOT $29 THEN NULL
         ELSE scm_reconciliation_order_state.completed_at
       END,
       cancelled_at = CASE
         WHEN NOT $29 AND EXCLUDED.application_status = 'Cancelled'
         THEN COALESCE(scm_reconciliation_order_state.cancelled_at, now())
         WHEN NOT $29 THEN NULL
         ELSE scm_reconciliation_order_state.cancelled_at
       END,
       status_changed_at = CASE
         WHEN NOT $29
          AND scm_reconciliation_order_state.application_status IS DISTINCT FROM EXCLUDED.application_status
         THEN now()
         ELSE scm_reconciliation_order_state.status_changed_at
       END,
       updated_at = now()
     RETURNING *`,
    [
      order.kind,
      order.id,
      order.tranid,
      order.status,
      order.statusText,
      currentLifecycleTerminal(order.statusText),
      derived.applicationStatus,
      reconciliationReason ? "review" : derived.reconciliationStatus,
      reconciliationReason || derived.reason,
      reconciliationSource,
      recovered === true,
      order.sourceLocationId,
      order.sourceLocation,
      order.destinationLocationId,
      order.destinationLocation,
      derived.quantities.ordered,
      derived.quantities.fulfilled,
      derived.quantities.received,
      derived.quantities.abandoned,
      derived.quantities.remaining,
      derived.quantities.destinationRemaining,
      exactAllocation,
      order.lastModifiedAt,
      lastEventId ? Number(lastEventId) : null,
      runId ? Number(runId) : null,
      JSON.stringify({ family: derived.quantities, targets: targetStates }),
      JSON.stringify(order),
      JSON.stringify(proposed),
      dryRun === true
    ]
  );
  return result.rows[0];
}

async function upsertOrderLineState({
  orderStateId,
  order,
  line,
  fulfilledQty,
  receivedQty,
  identityStatus,
  allocationQuality,
  runId,
  lastEventId,
  dryRun
}) {
  const ordered = roundReconciliationQuantity(line.quantity);
  const progress = order.kind === "TO" ? fulfilledQty : receivedQty;
  const lifecycle = classifyNetSuiteLifecycle(order.statusText);
  const abandoned = lifecycle.closed ? Math.max(ordered - receivedQty, 0) : 0;
  const remaining = lifecycle.closed || lifecycle.cancelled ? 0 : Math.max(ordered - progress, 0);
  const lineStatus = ["ambiguous", "missing"].includes(text(identityStatus).toLowerCase())
    ? "review"
    : lifecycle.cancelled && progress <= EPSILON
      ? "cancelled"
      : receivedQty + EPSILON >= ordered && ordered > EPSILON
        ? "completed"
        : progress > EPSILON
          ? "partial"
          : "open";
  const result = await query(
    `INSERT INTO scm_reconciliation_order_line_state (
       order_state_id, netsuite_line_key, local_line_id, local_line_stage,
       item_id, item_name, sku, unit, source_location_id,
       destination_location_id, current_ordered_qty, fulfilled_qty,
       received_qty, abandoned_qty, remaining_qty, line_status,
       identity_status, allocation_quality, netsuite_active,
       last_event_id, last_run_id, line_snapshot, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''),
       $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, true,
       $19, $20, $21::jsonb, now(), now()
     )
     ON CONFLICT (order_state_id, netsuite_line_key) DO UPDATE SET
       local_line_id = EXCLUDED.local_line_id,
       local_line_stage = EXCLUDED.local_line_stage,
       item_id = EXCLUDED.item_id,
       item_name = EXCLUDED.item_name,
       sku = EXCLUDED.sku,
       unit = EXCLUDED.unit,
       source_location_id = EXCLUDED.source_location_id,
       destination_location_id = EXCLUDED.destination_location_id,
       current_ordered_qty = CASE WHEN $22 THEN scm_reconciliation_order_line_state.current_ordered_qty ELSE EXCLUDED.current_ordered_qty END,
       fulfilled_qty = CASE WHEN $22 THEN scm_reconciliation_order_line_state.fulfilled_qty ELSE EXCLUDED.fulfilled_qty END,
       received_qty = CASE WHEN $22 THEN scm_reconciliation_order_line_state.received_qty ELSE EXCLUDED.received_qty END,
       abandoned_qty = CASE WHEN $22 THEN scm_reconciliation_order_line_state.abandoned_qty ELSE EXCLUDED.abandoned_qty END,
       remaining_qty = CASE WHEN $22 THEN scm_reconciliation_order_line_state.remaining_qty ELSE EXCLUDED.remaining_qty END,
       line_status = CASE WHEN $22 THEN scm_reconciliation_order_line_state.line_status ELSE EXCLUDED.line_status END,
       identity_status = EXCLUDED.identity_status,
       allocation_quality = CASE WHEN $22 THEN scm_reconciliation_order_line_state.allocation_quality ELSE EXCLUDED.allocation_quality END,
       netsuite_active = true,
       last_event_id = COALESCE(EXCLUDED.last_event_id, scm_reconciliation_order_line_state.last_event_id),
       last_run_id = COALESCE(EXCLUDED.last_run_id, scm_reconciliation_order_line_state.last_run_id),
       line_snapshot = EXCLUDED.line_snapshot,
       updated_at = now()
     RETURNING *`,
    [
      orderStateId,
      line.sourceLineKey,
      line.localLineId,
      line.stage,
      line.itemId,
      line.itemName,
      line.sku,
      line.unit,
      order.sourceLocationId,
      order.destinationLocationId,
      ordered,
      roundReconciliationQuantity(fulfilledQty),
      roundReconciliationQuantity(receivedQty),
      roundReconciliationQuantity(abandoned),
      roundReconciliationQuantity(remaining),
      lineStatus,
      identityStatus,
      allocationQuality,
      lastEventId ? Number(lastEventId) : null,
      runId ? Number(runId) : null,
      JSON.stringify(line),
      dryRun === true
    ]
  );
  return result.rows[0];
}

async function pinnedAllocationsForOrder(order) {
  const result = await query(
    `SELECT line.netsuite_line_key,
            allocation.progress_kind,
            allocation.target_kind,
            allocation.po_split_line_id,
            allocation.to_split_line_id,
            allocation.target_order_ref,
            allocation.quantity,
            allocation.pinned_by,
            allocation.pinned_at,
            allocation.pin_note
       FROM scm_reconciliation_order_state state
       JOIN scm_reconciliation_order_line_state line
         ON line.order_state_id = state.id
       JOIN scm_reconciliation_allocations allocation
         ON allocation.order_line_state_id = line.id
        AND allocation.active = true
        AND allocation.allocation_method = 'pinned'
      WHERE state.order_kind = $1
        AND state.source_order_netsuite_id = $2`,
    [order.kind, order.id]
  );
  const pinned = new Map();
  for (const row of result.rows) {
    const key = [
      row.netsuite_line_key,
      row.progress_kind,
      row.target_kind,
      row.po_split_line_id || row.to_split_line_id || row.target_order_ref || ""
    ].join("|");
    pinned.set(key, row);
  }
  return pinned;
}

function pinnedTargetQuantity(pinned, line, progressKind, target) {
  const sourceLineAliases = textList(
    line.sourceLineAliases,
    [line.sourceLineKey]
  );
  const row = sourceLineAliases
    .map((sourceLineKey) => pinned.get([
      sourceLineKey,
      progressKind,
      target.targetKind,
      target.ledgerLineId || target.targetOrderRef || ""
    ].join("|")))
    .find(Boolean) || (
    target.targetKind === "source_residual"
      ? [...pinned.values()].find((candidate) =>
        sourceLineAliases.includes(text(candidate.netsuite_line_key))
        && candidate.progress_kind === progressKind
        && candidate.target_kind === "source_residual"
      )
      : null
  );
  return row ? reconciliationQuantity(row.quantity) : 0;
}

async function persistLineAllocations({
  lineState,
  line,
  progressKind,
  allocations,
  runId,
  lastEventId
}) {
  await query(
    `UPDATE scm_reconciliation_allocations
        SET active = false,
            updated_at = now()
      WHERE order_line_state_id = $1
        AND progress_kind = $2
        AND allocation_method <> 'pinned'`,
    [lineState.id, progressKind]
  );
  for (const allocation of allocations) {
    if (allocation.allocatedQty <= EPSILON) continue;
    if (allocation.allocationMethod === "pinned") continue;
    const targetKind = allocation.targetKind || "source_residual";
    const ledgerId = allocation.ledgerLineId || null;
    const allocationKey = [
      lineState.id,
      progressKind,
      targetKind,
      ledgerId || allocation.targetOrderRef || "source"
    ].join(":");
    await query(
      `INSERT INTO scm_reconciliation_allocations (
         allocation_key, order_line_state_id, progress_kind, target_kind,
         po_split_line_id, to_split_line_id, target_order_ref,
         target_line_ref, quantity, allocation_method, active,
         last_event_id, last_run_id, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4,
         CASE WHEN $4 = 'po_split' THEN $5::bigint ELSE NULL::bigint END,
         CASE WHEN $4 = 'to_split' THEN $5::bigint ELSE NULL::bigint END,
         NULLIF($6, ''), NULLIF($7, ''), $8, $9, true,
         $10, $11, now(), now()
       )
       ON CONFLICT (allocation_key) DO UPDATE SET
         quantity = EXCLUDED.quantity,
         allocation_method = EXCLUDED.allocation_method,
         active = true,
         last_event_id = COALESCE(EXCLUDED.last_event_id, scm_reconciliation_allocations.last_event_id),
         last_run_id = COALESCE(EXCLUDED.last_run_id, scm_reconciliation_allocations.last_run_id),
         updated_at = now()`,
      [
        allocationKey,
        lineState.id,
        progressKind,
        targetKind,
        ledgerId,
        allocation.targetOrderRef || "",
        String(allocation.targetLocalLineId || line.localLineId || ""),
        allocation.allocatedQty,
        allocation.allocationMethod === "exact" ? "exact" : "inferred",
        lastEventId ? Number(lastEventId) : null,
        runId ? Number(runId) : null
      ]
    );
  }
}

function addTargetProgress(targets, allocation, progressKind, lineIdentity = "") {
  const ref = text(allocation.targetOrderRef);
  if (!ref) return;
  if (!targets.has(ref)) {
    targets.set(ref, {
      orderRef: ref,
      orderId: allocation.targetOrderId || null,
      targetKind: allocation.targetKind || "source_residual",
      ordered: 0,
      fulfilled: 0,
      received: 0,
      exactAllocation: true,
      hidden: false,
      hasActivePlan: Boolean(allocation.actualDispatchAt || allocation.plannedEta),
      allocationMethods: new Set(),
      lineIdentities: new Set()
    });
  }
  const target = targets.get(ref);
  const identity = text(lineIdentity) || String(allocation.targetLocalLineId || allocation.ledgerLineId || "");
  if (!target.lineIdentities.has(identity)) {
    target.lineIdentities.add(identity);
    target.ordered = roundReconciliationQuantity(
      target.ordered + reconciliationQuantity(allocation.currentQty ?? allocation.requestedQty)
    );
  }
  target[progressKind] = roundReconciliationQuantity(
    target[progressKind] + reconciliationQuantity(allocation.allocatedQty)
  );
  if (allocation.allocationMethod) target.allocationMethods.add(allocation.allocationMethod);
  if (allocation.allocationMethod === "inferred") target.exactAllocation = false;
}

async function targetPreviousStatuses(kind, refs) {
  if (!refs.length) return new Map();
  const result = await query(
    `SELECT order_ref, status, reconciliation_blocked, eta_date, updated_at
       FROM scm_transport_schedule
      WHERE order_kind = $1
        AND lower(order_ref) = ANY($2::text[])`,
    [kind, refs.map((ref) => ref.toLowerCase())]
  );
  return new Map(result.rows.map((row) => [text(row.order_ref).toLowerCase(), row]));
}

async function upsertBlockingReview({
  orderStateId,
  order,
  reason,
  details,
  runId,
  eventId
}) {
  const caseKey = `${order.kind}:${order.id}:reconciliation_conflict`;
  if (reason) {
    const result = await query(
      `INSERT INTO scm_reconciliation_review_cases (
         case_key, order_state_id, review_code, severity, dismissible,
         status, reason, details, detected_run_id, detected_event_id,
         first_detected_at, last_detected_at, updated_at
       ) VALUES (
         $1, $2, 'reconciliation_conflict', 'blocking', false,
         'open', $3, $4::jsonb, $5, $6, now(), now(), now()
       )
       ON CONFLICT (case_key) DO UPDATE SET
         order_state_id = EXCLUDED.order_state_id,
         status = 'open',
         reason = EXCLUDED.reason,
         details = EXCLUDED.details,
         detected_run_id = COALESCE(EXCLUDED.detected_run_id, scm_reconciliation_review_cases.detected_run_id),
         detected_event_id = COALESCE(EXCLUDED.detected_event_id, scm_reconciliation_review_cases.detected_event_id),
         last_detected_at = now(),
         resolved_at = null,
         resolved_by = null,
         resolution_action = null,
         resolution_note = null,
         updated_at = now()
       RETURNING *`,
      [
        caseKey,
        orderStateId,
        reason,
        JSON.stringify(details || {}),
        runId ? Number(runId) : null,
        eventId ? Number(eventId) : null
      ]
    );
    return result.rows[0];
  }
  const open = await query(
    `SELECT *
       FROM scm_reconciliation_review_cases
      WHERE case_key = $1
        AND status = 'open'
      FOR UPDATE`,
    [caseKey]
  );
  if (!open.rows[0]) return null;
  const resolved = await query(
    `UPDATE scm_reconciliation_review_cases
        SET status = 'resolved',
            resolved_at = now(),
            resolved_by = 'system',
            resolution_action = 'auto_resolve',
            resolution_note = 'New NetSuite evidence resolved the reconciliation conflict.',
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [open.rows[0].id]
  );
  await query(
    `INSERT INTO scm_reconciliation_review_resolutions (
       review_case_id, action, actor, actor_role, note, details
     ) VALUES (
       $1, 'auto_resolve', 'system', 'system',
       'New NetSuite evidence resolved the reconciliation conflict.',
       $2::jsonb
     )`,
    [open.rows[0].id, JSON.stringify({ orderKind: order.kind, sourceOrderId: order.id })]
  );
  return resolved.rows[0];
}

async function applyTargetScheduleStates(order, orderStateId, targetStates, blocked) {
  for (const state of Object.values(targetStates)) {
    if (!state.orderRef) continue;
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, status, reconciliation_order_state_id,
         reconciliation_blocked, last_reconciled_at, created_by, updated_by,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, now(), 'reconciliation', 'reconciliation',
         now(), now()
       )
       ON CONFLICT (order_kind, order_ref) DO UPDATE SET
         status = EXCLUDED.status,
         reconciliation_order_state_id = EXCLUDED.reconciliation_order_state_id,
         reconciliation_blocked = EXCLUDED.reconciliation_blocked,
         last_reconciled_at = now(),
         updated_by = 'reconciliation',
         updated_at = now()`,
      [order.kind, state.orderRef, state.applicationStatus, orderStateId, blocked]
    );
  }
  const family = Object.values(targetStates).reduce((sum, state) => ({
    ordered: sum.ordered + reconciliationQuantity(state.ordered),
    fulfilled: sum.fulfilled + reconciliationQuantity(state.fulfilled),
    received: sum.received + reconciliationQuantity(state.received),
    abandoned: sum.abandoned + reconciliationQuantity(state.abandoned)
  }), { ordered: 0, fulfilled: 0, received: 0, abandoned: 0 });
  if (order.kind === "PO") {
    await query(
      `UPDATE purchase_orders
          SET receipt_status = CASE
                WHEN $2::numeric > 0
                 AND $3::numeric > 0
                 AND $3::numeric + $4::numeric + $5::numeric >= $2::numeric
                THEN 'received'
                WHEN $3::numeric > 0 THEN 'partial_received'
                ELSE 'not_received'
              END,
              received_at = CASE WHEN $3::numeric > 0 THEN COALESCE(received_at, now()) ELSE received_at END,
              status_updated_at = now()
        WHERE netsuite_id = $1`,
      [
        order.id,
        family.ordered,
        family.received,
        family.abandoned,
        EPSILON
      ]
    );
  } else {
    await query(
      `UPDATE transfer_orders
          SET fulfillment_status = CASE
                WHEN $2::numeric > 0 AND $3::numeric + $5::numeric >= $2::numeric THEN 'fulfilled'
                WHEN $3::numeric > 0 THEN 'partial_fulfilled'
                ELSE 'not_fulfilled'
              END,
              receiving_status = CASE
                WHEN $2::numeric > 0 AND $4::numeric + $5::numeric >= $2::numeric THEN 'received'
                WHEN $4::numeric > 0 THEN 'partial_received'
                ELSE 'not_received'
              END,
              fulfilled_at = CASE WHEN $3::numeric > 0 THEN COALESCE(fulfilled_at, now()) ELSE fulfilled_at END,
              received_at = CASE WHEN $4::numeric > 0 THEN COALESCE(received_at, now()) ELSE received_at END,
              status_updated_at = now()
        WHERE netsuite_id = $1`,
      [
        order.id,
        family.ordered,
        family.fulfilled,
        family.received,
        family.abandoned
      ]
    );
    await syncOrderDependenciesForTransferOrder(order.id);
  }
}

function plainTargetState(target) {
  const {
    allocationMethods,
    lineIdentities,
    ...plain
  } = target;
  return {
    ...plain,
    allocationMethods: [...(allocationMethods || [])]
  };
}

function reconciliationOrderWithAuthoritativeSnapshot(localOrder, authoritativeOrder) {
  if (!authoritativeOrder) return localOrder;
  const kind = text(authoritativeOrder.kind || localOrder?.kind).toUpperCase();
  const id = positiveId(authoritativeOrder.id || localOrder?.id);
  if (!["PO", "TO"].includes(kind) || !id) return localOrder;
  const localLines = localOrder?.lines || [];
  const historicalLines = localOrder?.historicalLines || [];
  const localByStage = new Map();
  for (const stage of ["outbound", "receiving"]) {
    const activeStageLines = localLines.filter((line) => line.stage === stage);
    const historicalStageLines = historicalLines.filter((line) => line.stage === stage);
    localByStage.set(stage, {
      active: {
        source: uniqueLineAliasIndex(activeStageLines, ["sourceLineKey", "sourceLineAliases"]),
        order: uniqueLineAliasIndex(activeStageLines, ["orderLine", "orderLineAliases"])
      },
      historical: {
        source: uniqueLineAliasIndex(historicalStageLines, ["sourceLineKey", "sourceLineAliases"]),
        order: uniqueLineAliasIndex(historicalStageLines, ["orderLine", "orderLineAliases"])
      }
    });
  }
  const matchedLocalLines = new Set();
  const authoritativeLines = (authoritativeOrder.lines || []).map((line) => {
    const stage = line.stage || (kind === "PO" ? "receiving" : "outbound");
    const indexes = localByStage.get(stage);
    const samePhysicalIdentity = (candidate) => {
      if (!candidate) return false;
      const authoritativeItemId = positiveId(line.itemId);
      const candidateItemId = positiveId(candidate.itemId);
      if (
        authoritativeItemId
        && candidateItemId
        && authoritativeItemId !== candidateItemId
      ) return false;
      const authoritativeUnit = text(line.unit).toLowerCase();
      const candidateUnit = text(candidate.unit).toLowerCase();
      if (
        authoritativeUnit
        && candidateUnit
        && authoritativeUnit !== candidateUnit
      ) return false;
      const authoritativeLogicalIdentity = text(line.logicalLineIdentity);
      const candidateLogicalIdentity = text(candidate.logicalLineIdentity);
      return !(
        authoritativeLogicalIdentity
        && candidateLogicalIdentity
        && authoritativeLogicalIdentity !== candidateLogicalIdentity
      );
    };
    const candidatesFor = (candidateIndexes) => {
      const candidates = new Set();
      let aliasObserved = false;
      for (const alias of textList(line.sourceLineAliases, [line.sourceLineKey])) {
        if (candidateIndexes?.source.has(alias)) aliasObserved = true;
        const candidate = candidateIndexes?.source.get(alias);
        if (samePhysicalIdentity(candidate)) candidates.add(candidate);
      }
      for (const alias of textList(line.orderLineAliases, [line.orderLine])) {
        if (candidateIndexes?.order.has(alias)) aliasObserved = true;
        const candidate = candidateIndexes?.order.get(alias);
        if (samePhysicalIdentity(candidate)) candidates.add(candidate);
      }
      return { candidates, aliasObserved };
    };
    const activeMatch = candidatesFor(indexes?.active);
    const exactCandidates = activeMatch.aliasObserved
      ? activeMatch.candidates
      : candidatesFor(indexes?.historical).candidates;
    const local = exactCandidates.size === 1 ? [...exactCandidates][0] : {};
    if (local.localLineId) matchedLocalLines.add(local);
    return {
      ...local,
      ...line,
      localLineId: local.localLineId || line.localLineId || null,
      authoritativeLocalLineMatched: Boolean(local.localLineId),
      localOrderedQuantityBeforeAuthoritative: local.localLineId
        ? roundReconciliationQuantity(local.quantity)
        : null,
      sourceLineKey: text(line.sourceLineKey || line.orderLine || local.sourceLineKey),
      sourceLineAliases: textList(
        line.sourceLineAliases,
        [line.sourceLineKey || line.orderLine || local.sourceLineKey]
      ),
      orderLine: text(line.orderLine ?? local.orderLine),
      orderLineAliases: textList(
        line.orderLineAliases,
        [line.orderLine ?? local.orderLine]
      ),
      stage,
      quantity: roundReconciliationQuantity(line.quantity),
      cumulativeProgressQuantity: roundReconciliationQuantity(line.cumulativeProgressQuantity)
    };
  });
  const sourceStage = kind === "PO" ? "receiving" : "outbound";
  const orphanedLocalSourceLines = localLines.filter((line) =>
    line.stage === sourceStage
    && positiveId(line.localLineId)
    && !matchedLocalLines.has(line)
  );
  return {
    ...(localOrder || {}),
    ...authoritativeOrder,
    id,
    kind,
    tranid: authoritativeOrder.tranid || localOrder?.tranid || "",
    scheduleRef: localOrder?.scheduleRef || authoritativeOrder.scheduleRef || authoritativeOrder.tranid || "",
    localStatus: localOrder?.localStatus || "Queued",
    dispatchPlanned: localOrder?.dispatchPlanned === true,
    dispatchPlanDate: localOrder?.dispatchPlanDate || null,
    dispatchPlannedAt: localOrder?.dispatchPlannedAt || null,
    localSourceLocationIdBeforeAuthoritative: localOrder?.sourceLocationId || null,
    localDestinationLocationIdBeforeAuthoritative: localOrder?.destinationLocationId || null,
    orphanedLocalSourceLines,
    lines: authoritativeLines
  };
}

export async function reconcileScmOrderFamily({
  kind,
  sourceOrderId,
  source = "manual",
  runId = null,
  dryRun = false,
  recovered = false,
  authoritativeOrder = null,
  explicitReviewReason = ""
} = {}) {
  const localOrder = await loadLocalScmReconciliationOrder(kind, sourceOrderId);
  const order = reconciliationOrderWithAuthoritativeSnapshot(localOrder, authoritativeOrder);
  if (!order) {
    throw Object.assign(new Error("The PO/TO source order is not available locally for reconciliation."), {
      status: 404,
      code: "SCM_RECONCILIATION_SOURCE_MISSING"
    });
  }
  const previous = await orderPreviousState(order.kind, order.id);
  const current = await currentTransactionProgress(order.kind, order.id);
  const matched = matchCurrentProgress(order, current);
  const sourceLines = order.kind === "PO"
    ? matched.byStage.receiving
    : matched.byStage.outbound;
  const receivingLines = matched.byStage.receiving;
  const receivingBySourceKey = uniqueLineAliasIndex(
    receivingLines,
    ["sourceLineKey", "sourceLineAliases"]
  );
  const receivingByOrderLine = uniqueLineAliasIndex(
    receivingLines,
    ["orderLine", "orderLineAliases"]
  );
  const receivingByLogicalIdentity = uniqueLineIndex(
    receivingLines,
    "logicalLineIdentity"
  );
  const authoritativeProgress = Boolean(
    authoritativeOrder
    && Array.isArray(authoritativeOrder.lines)
    && authoritativeOrder.lines.length
    && authoritativeOrder.lines.every((line) =>
      line.cumulativeProgressObserved !== false
    )
  );
  const observedFulfillment = current.observedTypes.has("IF");
  const observedReceipt = current.observedTypes.has("IR");
  const eventFulfilledTotal = roundReconciliationQuantity(
    current.rows
      .filter((row) => row.transaction_type === "IF")
      .reduce((sum, row) => sum + reconciliationQuantity(row.quantity), 0)
  );
  const eventReceivedTotal = roundReconciliationQuantity(
    current.rows
      .filter((row) => row.transaction_type === "IR")
      .reduce((sum, row) => sum + reconciliationQuantity(row.quantity), 0)
  );
  const orderedTotal = roundReconciliationQuantity(
    sourceLines.reduce((sum, line) => sum + reconciliationQuantity(line.quantity), 0)
  );
  const fulfilledTotal = order.kind === "TO"
    ? authoritativeProgress
      ? roundReconciliationQuantity(
        sourceLines.reduce((sum, line) => sum + reconciliationQuantity(line.cumulativeProgressQuantity), 0)
      )
      : observedFulfillment
        ? eventFulfilledTotal
        : roundReconciliationQuantity(
          sourceLines.reduce((sum, line) => sum + reconciliationQuantity(line.cumulativeProgressQuantity), 0)
        )
    : 0;
  const receivedTotal = authoritativeProgress
    ? roundReconciliationQuantity(
      receivingLines.reduce((sum, line) => sum + reconciliationQuantity(line.cumulativeProgressQuantity), 0)
    )
    : observedReceipt
      ? eventReceivedTotal
      : roundReconciliationQuantity(
        receivingLines.reduce((sum, line) => sum + reconciliationQuantity(line.cumulativeProgressQuantity), 0)
      );

  const previousTargets = previous?.quantity_summary?.targets || {};
  const [pinned, activeToSplits] = await Promise.all([
    pinnedAllocationsForOrder(order),
    loadActiveToSplitIntegrity(order)
  ]);
  const incompleteActiveToSplits = activeToSplits.filter((split) => !split.integrityOk);
  const targets = new Map();
  const linePlans = [];
  const reasons = [text(explicitReviewReason)].filter(Boolean);
  let exactAllocation = true;
  let anyPlannedTarget = order.dispatchPlanned === true;

  const activeSourceLineKeys = new Set(
    sourceLines.flatMap((line) =>
      textList(line.sourceLineAliases, [line.sourceLineKey])
    )
  );
  for (const pin of pinned.values()) {
    if (!activeSourceLineKeys.has(text(pin.netsuite_line_key))) {
      reasons.push(
        `A pinned ${pin.progress_kind} allocation references NetSuite line ${pin.netsuite_line_key}, which is no longer active on the source order.`
      );
    }
  }
  for (const orphanedLine of order.orphanedLocalSourceLines || []) {
    const splitReferences = await loadActiveSplitLineReferences(order, orphanedLine);
    const aliases = textList(
      orphanedLine.sourceLineAliases,
      [orphanedLine.sourceLineKey]
    );
    const hasPinnedAllocation = [...pinned.values()].some((pin) =>
      aliases.includes(text(pin.netsuite_line_key))
    );
    if (splitReferences.length || order.dispatchPlanned || hasPinnedAllocation) {
      const operationalReference = splitReferences.length
        ? `active split ${splitReferences.map((row) => row.target_order_ref).filter(Boolean).join(", ")}`
        : hasPinnedAllocation
          ? "a pinned progress allocation"
          : "an active dispatch plan";
      reasons.push(
        `NetSuite source line ${orphanedLine.sourceLineKey || orphanedLine.orderLine}`
        + `${orphanedLine.itemName || orphanedLine.sku ? ` (${orphanedLine.itemName || orphanedLine.sku}, ${orphanedLine.quantity} ${orphanedLine.unit || "units"})` : ""}`
        + ` was removed or replaced while ${operationalReference} still references its exact local line.`
      );
    }
  }
  if (authoritativeOrder && order.dispatchPlanned) {
    const localSourceId = positiveId(order.localSourceLocationIdBeforeAuthoritative);
    const authoritativeSourceId = positiveId(order.sourceLocationId);
    if (
      localSourceId
      && authoritativeSourceId
      && localSourceId !== authoritativeSourceId
    ) {
      reasons.push(
        "The NetSuite source location changed after the parent order was planned or became operational."
      );
    }
    const localDestinationId = positiveId(order.localDestinationLocationIdBeforeAuthoritative);
    const authoritativeDestinationId = positiveId(order.destinationLocationId);
    if (
      localDestinationId
      && authoritativeDestinationId
      && localDestinationId !== authoritativeDestinationId
    ) {
      reasons.push(
        "The NetSuite destination changed after the parent order was planned or became operational."
      );
    }
    for (const line of sourceLines) {
      if (!line.authoritativeLocalLineMatched) {
        reasons.push(
          `NetSuite added source line ${line.sourceLineKey || line.orderLine}`
          + `${line.itemName || line.sku ? ` (${line.itemName || line.sku}, ${line.quantity} ${line.unit || "units"})` : ""}`
          + " after the parent order was planned or became operational."
        );
        continue;
      }
      if (
        Math.abs(
          reconciliationQuantity(line.localOrderedQuantityBeforeAuthoritative)
            - reconciliationQuantity(line.quantity)
        ) > EPSILON
      ) {
        reasons.push(
          `NetSuite changed planned source line ${line.sourceLineKey || line.orderLine}`
          + `${line.itemName || line.sku ? ` (${line.itemName || line.sku})` : ""}`
          + ` from ${reconciliationQuantity(line.localOrderedQuantityBeforeAuthoritative)}`
          + ` to ${reconciliationQuantity(line.quantity)} ${line.unit || "units"}.`
        );
      }
    }
  }
  const identityIssues = scmReconciliationLineIdentityIssues(order.lines);
  const linkedIdentityIssues = matched.matchedRows
    .map((row) => text(row.snapshot?.sourceIdentityIssue))
    .filter(Boolean);
  const identityDiagnostics = [
    ...identityIssues,
    ...linkedIdentityIssues,
    ...(matched.unmatched.length
      ? [`${matched.unmatched.length} IF/IR line(s) could not be matched to an exact NetSuite source line.`]
      : [])
  ];
  let exactIdentityRequired = !sourceLines.length && identityDiagnostics.length > 0;
  const incorrectReceiptLocations = current.rows.filter((row) =>
    row.transaction_type === "IR"
    && positiveId(row.line_actual_location_id || row.actual_location_id)
    && positiveId(order.destinationLocationId)
    && positiveId(row.line_actual_location_id || row.actual_location_id) !== positiveId(order.destinationLocationId)
  );
  if (incorrectReceiptLocations.length) {
    reasons.push("One or more Item Receipts use a location different from the order's current destination.");
  }
  if (
    previous
    && positiveId(previous.destination_location_id)
    && positiveId(order.destinationLocationId)
    && positiveId(previous.destination_location_id) !== positiveId(order.destinationLocationId)
    && (
      reconciliationQuantity(previous.fulfilled_qty) > EPSILON
      || reconciliationQuantity(previous.received_qty) > EPSILON
      || order.dispatchPlanned
    )
  ) {
    reasons.push("The destination changed after planning or operational progress.");
  }

  const receiptLineForOutbound = (outboundLine) => {
    const logicalIdentity = text(outboundLine.logicalLineIdentity);
    if (logicalIdentity) {
      const logicalMatch = receivingByLogicalIdentity.get(logicalIdentity);
      if (logicalMatch) return { line: logicalMatch, matchQuality: "exact" };
    }
    const sourceAliases = textList(
      outboundLine.sourceLineAliases,
      [outboundLine.sourceLineKey]
    );
    const orderAliases = textList(
      outboundLine.orderLineAliases,
      [outboundLine.orderLine]
    );
    let receiptLine;
    for (const alias of sourceAliases) {
      const candidate = receivingBySourceKey.get(alias);
      if (candidate) {
        receiptLine = candidate;
        break;
      }
    }
    if (!receiptLine) {
      for (const alias of orderAliases) {
        const candidate = receivingByOrderLine.get(alias);
        if (candidate) {
          receiptLine = candidate;
          break;
        }
      }
    }
    if (receiptLine) return { line: receiptLine, matchQuality: "exact" };
    if (!receiptLine && positiveId(outboundLine.itemId)) {
      const sameItemAndQuantity = (candidate) =>
        positiveId(candidate.itemId) === positiveId(outboundLine.itemId)
        && Math.abs(
          reconciliationQuantity(candidate.quantity)
            - reconciliationQuantity(outboundLine.quantity)
        ) <= EPSILON
        && (
          !text(candidate.unit)
          || !text(outboundLine.unit)
          || text(candidate.unit).toLowerCase() === text(outboundLine.unit).toLowerCase()
        );
      const outboundCandidates = sourceLines.filter(sameItemAndQuantity);
      const receiptCandidates = receivingLines.filter(sameItemAndQuantity);
      if (outboundCandidates.length === 1 && receiptCandidates.length === 1) {
        return { line: receiptCandidates[0], matchQuality: "inferred" };
      }
    }
    return null;
  };

  const sourceItemIdentityCounts = new Map();
  const sourceItemIdentity = (line) => [
    positiveId(line.itemId) || "",
    roundReconciliationQuantity(line.quantity),
    text(line.unit).toLowerCase()
  ].join("|");
  for (const line of sourceLines) {
    const key = sourceItemIdentity(line);
    sourceItemIdentityCounts.set(key, (sourceItemIdentityCounts.get(key) || 0) + 1);
  }

  for (const line of sourceLines) {
    const sourceProgress = matched.lineProgress.get(`${line.stage}:${line.localLineId || line.sourceLineKey}`) || {
      fulfilled: 0,
      received: 0
    };
    const fulfilled = order.kind === "TO"
      ? authoritativeProgress
        ? reconciliationQuantity(line.cumulativeProgressQuantity)
        : observedFulfillment
          ? sourceProgress.fulfilled
          : reconciliationQuantity(line.cumulativeProgressQuantity)
      : 0;
    let received = 0;
    let receiptIdentityStatus = text(line.identityStatus || "exact") === "exact"
      ? "exact"
      : "ambiguous";
    if (order.kind === "PO") {
      received = authoritativeProgress
        ? reconciliationQuantity(line.cumulativeProgressQuantity)
        : observedReceipt
          ? sourceProgress.received
          : reconciliationQuantity(line.cumulativeProgressQuantity);
    } else {
      const receiptMatch = receiptLineForOutbound(line);
      const receiptLine = receiptMatch?.line || null;
      if (receiptLine) {
        const progress = matched.lineProgress.get(
          `${receiptLine.stage}:${receiptLine.localLineId || receiptLine.sourceLineKey}`
        ) || { received: 0 };
        received = authoritativeProgress
          ? reconciliationQuantity(receiptLine.cumulativeProgressQuantity)
          : observedReceipt
            ? progress.received
            : reconciliationQuantity(receiptLine.cumulativeProgressQuantity);
        if (
          receiptMatch.matchQuality === "inferred"
          && receiptIdentityStatus === "exact"
        ) {
          receiptIdentityStatus = "inferred";
        }
      } else if (receivedTotal > EPSILON) {
        receiptIdentityStatus = receivingLines.length > 1 ? "ambiguous" : "missing";
        identityDiagnostics.push(
          `Destination receipt could not be linked exactly to ${line.sku || line.itemName || line.sourceLineKey}.`
        );
      }
    }

    const splitTargets = await loadSplitLineTargets(order, line);
    if (splitTargets.some((target) => target.actualDispatchAt || target.plannedEta)) anyPlannedTarget = true;
    const splitCurrent = splitTargets.reduce((sum, target) => sum + reconciliationQuantity(target.currentQty), 0);
    const sourceLineAliases = textList(
      line.sourceLineAliases,
      [line.sourceLineKey]
    );
    const pinnedForLine = [...pinned.values()].filter((pin) =>
      sourceLineAliases.includes(text(pin.netsuite_line_key))
    );
    const lineHasPinnedAllocation = pinnedForLine.length > 0;
    const lineHasAmbiguousIdentity = ["ambiguous", "missing"].includes(
      text(receiptIdentityStatus).toLowerCase()
    );
    const repeatedItemIdentity = (sourceItemIdentityCounts.get(sourceItemIdentity(line)) || 0) > 1;
    const lineNeedsExactIdentity = lineHasAmbiguousIdentity && (
      repeatedItemIdentity
      || splitTargets.length > 0
      || lineHasPinnedAllocation
      || order.dispatchPlanned
    );
    if (lineNeedsExactIdentity) exactIdentityRequired = true;
    else if (lineHasAmbiguousIdentity) receiptIdentityStatus = "inferred";
    const allocationTargetForPin = (pin) => {
      if (pin.target_kind === "source_residual") {
        return {
          targetKind: "source_residual",
          currentQty: Math.max(reconciliationQuantity(line.quantity) - splitCurrent, 0)
        };
      }
      const ledgerLineId = Number(pin.po_split_line_id || pin.to_split_line_id);
      return splitTargets.find((target) =>
        target.targetKind === pin.target_kind
        && Number(target.ledgerLineId) === ledgerLineId
      ) || null;
    };
    for (const pin of pinnedForLine) {
      const pinnedTarget = allocationTargetForPin(pin);
      if (!pinnedTarget) {
        reasons.push(
          `A pinned ${pin.progress_kind} allocation for ${line.sku || line.itemName || line.sourceLineKey} references a split that is cancelled or missing.`
        );
      } else if (
        reconciliationQuantity(pin.quantity)
          > reconciliationQuantity(pinnedTarget.currentQty) + EPSILON
      ) {
        reasons.push(
          `A pinned ${pin.progress_kind} allocation for ${line.sku || line.itemName || line.sourceLineKey} exceeds the target's current quantity.`
        );
      }
    }
    if (
      splitCurrent > reconciliationQuantity(line.quantity) + EPSILON
      && (
        lineHasPinnedAllocation
        || splitTargets.some((target) => target.actualDispatchAt || target.plannedEta)
      )
    ) {
      reasons.push(
        `The NetSuite quantity decrease would alter a planned, operational, or pinned split for ${line.sku || line.itemName || line.sourceLineKey}.`
      );
    }
    const parentResidual = Math.max(reconciliationQuantity(line.quantity) - splitCurrent, 0);
    const allocationTargets = [
      ...splitTargets.map((target) => ({
        ...target,
        requestedQty: reconciliationQuantity(target.currentQty),
        exactFulfilledQty: Math.min(reconciliationQuantity(target.exactFulfilledQty), reconciliationQuantity(target.currentQty)),
        exactReceivedQty: Math.min(reconciliationQuantity(target.exactReceivedQty), reconciliationQuantity(target.currentQty))
      })),
      {
        targetKind: "source_residual",
        ledgerLineId: null,
        targetOrderRef: order.scheduleRef,
        targetOrderId: order.id,
        targetLocalLineId: line.localLineId,
        requestedQty: parentResidual,
        currentQty: parentResidual,
        exactFulfilledQty: 0,
        exactReceivedQty: 0,
        isParent: true,
        createdAt: "9999-12-31T23:59:59.999Z"
      }
    ];
    for (const target of allocationTargets) {
      const pinnedFulfilled = pinnedTargetQuantity(pinned, line, "fulfilled", target);
      const pinnedReceived = pinnedTargetQuantity(pinned, line, "received", target);
      if (pinnedFulfilled > 0) {
        target.pinnedFulfilled = true;
        target.exactFulfilledQty = pinnedFulfilled;
      }
      if (pinnedReceived > 0) {
        target.pinnedReceived = true;
        target.exactReceivedQty = pinnedReceived;
      }
    }

    const fulfilledAllocation = order.kind === "TO"
      ? allocateReconciliationProgress(fulfilled, allocationTargets.map((target) => ({
        ...target,
        pinned: target.pinnedFulfilled
      })), { exactField: "exactFulfilledQty", parentRef: order.scheduleRef })
      : { allocations: allocationTargets.map((target) => ({ ...target, allocatedQty: 0, allocationMethod: "" })), conflict: false, overflowQty: 0 };
    const receivedAllocation = allocateReconciliationProgress(received, allocationTargets.map((target) => ({
      ...target,
      pinned: target.pinnedReceived
    })), { exactField: "exactReceivedQty", parentRef: order.scheduleRef });
    if (
      fulfilledAllocation.conflict
      || receivedAllocation.conflict
      || fulfilledAllocation.overflowQty > EPSILON
      || receivedAllocation.overflowQty > EPSILON
    ) {
      reasons.push(`Progress allocation exceeds current capacity for ${line.sku || line.itemName || line.sourceLineKey}.`);
    }
    for (const allocation of fulfilledAllocation.allocations) {
      addTargetProgress(targets, allocation, "fulfilled", line.sourceLineKey);
      if (allocation.allocationMethod === "inferred") exactAllocation = false;
    }
    for (const allocation of receivedAllocation.allocations) {
      addTargetProgress(targets, allocation, "received", line.sourceLineKey);
      if (allocation.allocationMethod === "inferred") exactAllocation = false;
    }
    const allocationMethods = new Set([
      ...fulfilledAllocation.allocations.map((allocation) => allocation.allocationMethod),
      ...receivedAllocation.allocations.map((allocation) => allocation.allocationMethod)
    ].filter(Boolean));
    linePlans.push({
      line,
      fulfilled,
      received,
      identityStatus: receiptIdentityStatus,
      allocationQuality: allocationMethods.size > 1
        ? "mixed"
        : allocationMethods.has("pinned")
          ? "pinned"
          : allocationMethods.has("exact")
            ? "exact"
            : allocationMethods.has("inferred")
              ? "inferred"
              : "unallocated",
      fulfilledAllocations: fulfilledAllocation.allocations,
      receivedAllocations: receivedAllocation.allocations
    });
  }

  if (exactIdentityRequired && identityDiagnostics.length) {
    reasons.push(...identityDiagnostics);
  }

  if (
    previous
    && reconciliationQuantity(previous.ordered_qty) > orderedTotal + EPSILON
    && anyPlannedTarget
  ) {
    reasons.push("The NetSuite quantity decrease would alter a split that is already planned or operational.");
  }

  const familyDerived = derivePoToReconciliationState({
    kind: order.kind,
    statusText: order.statusText,
    orderedQty: orderedTotal,
    fulfilledQty: fulfilledTotal,
    receivedQty: receivedTotal,
    previousStatus: previous?.application_status || "Queued",
    previousReceivedQty: previous?.received_qty || 0,
    hasActivePlan: anyPlannedTarget,
    hasOperationalActivity: fulfilledTotal > EPSILON || receivedTotal > EPSILON
  });
  if (familyDerived.reconciliationStatus === "review" && familyDerived.reason) reasons.push(familyDerived.reason);
  const inheritIncompleteSplitCompletion = incompleteActiveToSplits.length > 0
    && familyDerived.applicationStatus === "Completed"
    && familyDerived.reconciliationStatus === "ok"
    && reasons.length === 0;
  for (const split of incompleteActiveToSplits) {
    if (!split.targetOrderRef) continue;
    if (!targets.has(split.targetOrderRef)) {
      targets.set(split.targetOrderRef, {
        orderRef: split.targetOrderRef,
        orderId: split.targetOrderId,
        targetKind: "to_split",
        ordered: 0,
        fulfilled: 0,
        received: 0,
        exactAllocation: false,
        hidden: false,
        hasActivePlan: split.hasActivePlan,
        allocationMethods: new Set(),
        lineIdentities: new Set()
      });
    }
    Object.assign(targets.get(split.targetOrderRef), {
      missingSplitLineLedger: true,
      forceVisible: true,
      inheritedFamilyCompletion: inheritIncompleteSplitCompletion,
      splitIntegrity: {
        ledgerLineCount: split.ledgerLineCount,
        activeMappedLineCount: split.activeMappedLineCount,
        activeChildLineCount: split.activeChildLineCount
      }
    });
  }
  if (incompleteActiveToSplits.length && !inheritIncompleteSplitCompletion) {
    reasons.push(
      "At least one active TO split has an incomplete line ledger: "
      + incompleteActiveToSplits.map((split) =>
        `${split.targetOrderRef || split.targetOrderId}`
        + ` (ledger ${split.ledgerLineCount}, mapped ${split.activeMappedLineCount}, child ${split.activeChildLineCount})`
      ).join(", ")
      + "."
    );
  }
  const reconciliationReason = [...new Set(reasons.filter(Boolean))].join(" ");

  const previousStatusByRef = await targetPreviousStatuses(order.kind, [...targets.keys()]);
  const targetStates = {};
  for (const target of targets.values()) {
    const previousTarget = previousTargets[target.orderRef] || {};
    const previousSchedule = previousStatusByRef.get(target.orderRef.toLowerCase()) || {};
    const inheritedFamilyCompletion = target.inheritedFamilyCompletion === true;
    const hidden = target.forceVisible === true ? false : target.ordered <= EPSILON;
    const derived = derivePoToReconciliationState({
      kind: order.kind,
      statusText: order.statusText,
      orderedQty: target.ordered,
      fulfilledQty: target.fulfilled,
      receivedQty: target.received,
      previousStatus: previousSchedule.status || previousTarget.applicationStatus || "Queued",
      previousReceivedQty: previousTarget.received || 0,
      hasActivePlan: target.hasActivePlan,
      hasOperationalActivity: target.fulfilled > EPSILON || target.received > EPSILON
    });
    const applicationStatus = inheritedFamilyCompletion
      ? "Completed"
      : reconciliationReason && !hidden
        ? "Reconcile Review"
        : hidden
          ? "Cancelled"
          : derived.applicationStatus;
    targetStates[target.orderRef] = {
      ...plainTargetState(target),
      hidden,
      applicationStatus,
      reconciliationStatus: inheritedFamilyCompletion
        ? "ok"
        : reconciliationReason
          ? "review"
          : derived.reconciliationStatus,
      reason: inheritedFamilyCompletion
        ? "Completed from the fully received source TO; the active split line ledger is incomplete."
        : reconciliationReason || derived.reason,
      abandoned: derived.quantities.abandoned,
      remaining: derived.quantities.remaining,
      destinationRemaining: derived.quantities.destinationRemaining
    };
  }

  const lastEventId = current.rows.reduce(
    (max, row) => Math.max(max, Number(row.latest_event_id || 0)),
    0
  ) || null;
  const lineSummary = linePlans.map((plan) => ({
    lineKey: plan.line.sourceLineKey,
    itemId: plan.line.itemId,
    itemName: plan.line.itemName,
    sku: plan.line.sku,
    unit: plan.line.unit,
    stage: plan.line.stage,
    logicalLineIdentity: plan.line.logicalLineIdentity,
    identityIssue: plan.line.identityIssue,
    locationId: plan.line.locationId,
    ordered: plan.line.quantity,
    fulfilled: plan.fulfilled,
    received: plan.received,
    remaining: Math.max(
      reconciliationQuantity(plan.line.quantity)
        - (order.kind === "TO" ? plan.fulfilled : plan.received),
      0
    ),
    identityStatus: plan.identityStatus,
    allocationQuality: plan.allocationQuality
  }));

  const state = await upsertOrderState({
    order,
    derived: familyDerived,
    reconciliationReason,
    reconciliationSource: source,
    exactAllocation,
    runId,
    lastEventId,
    recovered,
    targetStates,
    lineSummary,
    dryRun
  });

  for (const plan of linePlans) {
    const lineState = await upsertOrderLineState({
      orderStateId: state.id,
      order,
      line: plan.line,
      fulfilledQty: plan.fulfilled,
      receivedQty: plan.received,
      identityStatus: plan.identityStatus,
      allocationQuality: plan.allocationQuality,
      runId,
      lastEventId,
      dryRun
    });
    if (!dryRun) {
      if (order.kind === "TO") {
        await persistLineAllocations({
          lineState,
          line: plan.line,
          progressKind: "fulfilled",
          allocations: plan.fulfilledAllocations,
          runId,
          lastEventId
        });
      }
      await persistLineAllocations({
        lineState,
        line: plan.line,
        progressKind: "received",
        allocations: plan.receivedAllocations,
        runId,
        lastEventId
      });
    }
  }

  if (!dryRun) {
    await query(
      `UPDATE scm_reconciliation_order_line_state
          SET netsuite_active = false,
              updated_at = now()
        WHERE order_state_id = $1
          AND netsuite_active = true
          AND netsuite_line_key <> ALL($2::text[])`,
      [state.id, linePlans.map((plan) => text(plan.line.sourceLineKey))]
    );
    await upsertBlockingReview({
      orderStateId: state.id,
      order,
      reason: reconciliationReason,
      details: {
        unmatchedLines: matched.unmatched.map((row) => ({
          transactionType: row.transaction_type,
          transactionId: row.netsuite_transaction_id,
          transactionLineKey: row.netsuite_line_key,
          sourceOrderLineKey: row.source_order_line_key,
          itemId: row.item_id,
          quantity: row.quantity
        })),
        incorrectReceiptLocations: incorrectReceiptLocations.map((row) => ({
          transactionId: row.netsuite_transaction_id,
          transactionRef: row.transaction_ref,
          actualLocationId: row.line_actual_location_id || row.actual_location_id
        }))
      },
      runId,
      eventId: lastEventId
    });
    await applyTargetScheduleStates(order, state.id, targetStates, Boolean(reconciliationReason));
  }

  const result = {
    evidenceVersion: 2,
    orderKind: order.kind,
    sourceOrderId: order.id,
    sourceOrderRef: order.tranid,
    dryRun: dryRun === true,
    recovered: recovered === true,
    applicationStatus: reconciliationReason ? "Reconcile Review" : familyDerived.applicationStatus,
    calculatedApplicationStatus: familyDerived.applicationStatus,
    reconciliationStatus: reconciliationReason ? "review" : familyDerived.reconciliationStatus,
    reason: reconciliationReason || familyDerived.reason,
    exactAllocation,
    quantities: familyDerived.quantities,
    targets: targetStates,
    lines: lineSummary,
    evidence: {
      statusCode: order.status,
      statusText: order.statusText,
      lifecycle: currentLifecycleTerminal(order.statusText),
      lastModifiedAt: order.lastModifiedAt || null,
      sourceLocationId: order.sourceLocationId || null,
      destinationLocationId: order.destinationLocationId || null,
      dispatchPlanned: order.dispatchPlanned === true,
      dispatchPlanDate: order.dispatchPlanDate || null,
      dispatchPlannedAt: order.dispatchPlannedAt || null,
      linkedTransactions: current.rows.map((row) => ({
        transactionType: row.transaction_type,
        transactionId: row.netsuite_transaction_id,
        transactionRef: row.transaction_ref,
        statusText: row.status_text,
        transactionLineKey: row.netsuite_line_key,
        sourceOrderLineKey: row.source_order_line_key,
        itemId: row.item_id,
        quantity: row.quantity,
        unit: row.unit,
        actualLocationId: row.line_actual_location_id || row.actual_location_id,
        identityIssue: row.snapshot?.sourceIdentityIssue || ""
      }))
    }
  };
  await insertReconciliationAuditEvent({
    eventKey: `reconcile:${runId || "targeted"}:${order.kind}:${order.id}:${dryRun ? "proposal" : "apply"}:${crypto.randomUUID()}`,
    runId,
    source: ["webhook", "nightly", "manual", "backfill", "system"].includes(source) ? source : "system",
    eventType: dryRun ? "order.proposed" : "order.applied",
    recordType: order.kind,
    action: dryRun ? "propose" : "apply",
    parentOrderKind: order.kind,
    parentOrderId: order.id,
    parentOrderRef: order.tranid,
    occurredAt: new Date().toISOString(),
    payload: result,
    actor: source
  });
  return result;
}

export async function listLocalScmReconciliationSources({
  kind = "",
  includeTerminalOrders = false
} = {}) {
  const cleanKind = text(kind).toUpperCase();
  const result = await query(
    `SELECT 'PO'::text AS order_kind, po.netsuite_id, po.tranid
       FROM purchase_orders po
       LEFT JOIN scm_reconciliation_order_state state
         ON state.order_kind = 'PO'
        AND state.source_order_netsuite_id = po.netsuite_id
      WHERE po.netsuite_id > 0
        AND ($1 = '' OR $1 = 'PO')
        AND ($2::boolean OR NOT (
          po.netsuite_active = false
          AND state.netsuite_terminal_state = 'deleted'
          AND state.reconciliation_status = 'current'
          AND state.application_status = 'Cancelled'
        ))
     UNION ALL
     SELECT 'TO'::text AS order_kind, netsuite_id, tranid
       FROM transfer_orders
      WHERE netsuite_id > 0
        AND ($1 = '' OR $1 = 'TO')
     ORDER BY order_kind, netsuite_id`,
    [
      ["PO", "TO"].includes(cleanKind) ? cleanKind : "",
      bool(includeTerminalOrders)
    ]
  );
  return result.rows.map((row) => ({
    kind: row.order_kind,
    id: Number(row.netsuite_id),
    tranid: row.tranid || ""
  }));
}

export async function listScmReconciliationBroadExcludedSources({ kind = "" } = {}) {
  const cleanKind = text(kind).toUpperCase();
  const result = await query(
    `WITH local_source AS (
       SELECT 'PO'::text AS order_kind,
              po.netsuite_id,
              po.tranid,
              COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid) AS schedule_ref
         FROM purchase_orders po
        WHERE po.netsuite_id > 0
          AND ($1 = '' OR $1 = 'PO')
       UNION ALL
       SELECT 'TO'::text AS order_kind,
              transfer.netsuite_id,
              transfer.tranid,
              transfer.tranid AS schedule_ref
         FROM transfer_orders transfer
        WHERE transfer.netsuite_id > 0
          AND ($1 = '' OR $1 = 'TO')
       UNION ALL
       SELECT state.order_kind,
              state.source_order_netsuite_id AS netsuite_id,
              state.source_order_ref AS tranid,
              state.source_order_ref AS schedule_ref
         FROM scm_reconciliation_order_state state
        WHERE state.source_order_netsuite_id > 0
          AND ($1 = '' OR $1 = state.order_kind)
          AND NOT EXISTS (
            SELECT 1
              FROM purchase_orders po
             WHERE state.order_kind = 'PO'
               AND po.netsuite_id = state.source_order_netsuite_id
          )
          AND NOT EXISTS (
            SELECT 1
              FROM transfer_orders transfer
             WHERE state.order_kind = 'TO'
               AND transfer.netsuite_id = state.source_order_netsuite_id
          )
     )
     SELECT source.order_kind,
            source.netsuite_id,
            source.tranid,
            CASE
              WHEN state.broad_reconciliation_skipped = true
                THEN 'saved_skip'
              WHEN state.application_status = 'Completed'
                THEN 'completed'
              WHEN state.application_status = 'Cancelled'
                THEN 'closed'
              WHEN state.application_status = 'Hold'
                THEN 'hold'
              WHEN schedule.status = 'Completed'
                THEN 'completed'
              WHEN schedule.status = 'Cancelled'
                THEN 'closed'
              WHEN schedule.status = 'Hold'
                THEN 'hold'
              ELSE 'terminal'
            END AS exclusion_reason
       FROM local_source source
       LEFT JOIN scm_reconciliation_order_state state
         ON state.order_kind = source.order_kind
        AND state.source_order_netsuite_id = source.netsuite_id
       LEFT JOIN LATERAL (
         SELECT CASE
                  WHEN active_group.id IS NOT NULL
                   AND group_schedule.id IS NOT NULL
                   AND (
                     group_schedule.status IN (
                       'Planned', 'Partially Done', 'In Transit',
                       'Completed', 'Reconcile Review'
                     )
                     OR group_schedule.eta_date IS NOT NULL
                   )
                  THEN group_schedule.status
                  ELSE candidate.status
                END AS status
           FROM scm_transport_schedule candidate
           LEFT JOIN scm_schedule_groups active_group
             ON active_group.status = 'active'
            AND lower(active_group.group_ref) = lower(
              COALESCE(candidate.group_ref, '')
            )
           LEFT JOIN scm_transport_schedule group_schedule
             ON group_schedule.order_kind = source.order_kind
            AND lower(group_schedule.order_ref) = lower(active_group.group_ref)
          WHERE candidate.order_kind = source.order_kind
            AND (
              candidate.source_id = source.netsuite_id
              OR (
                candidate.source_id IS NULL
                AND lower(candidate.order_ref) = lower(source.schedule_ref)
              )
            )
          ORDER BY
            CASE WHEN candidate.source_id = source.netsuite_id THEN 0 ELSE 1 END,
            candidate.updated_at DESC,
            candidate.id DESC
          LIMIT 1
       ) schedule ON true
      WHERE state.broad_reconciliation_skipped = true
         OR state.application_status IN ('Completed', 'Cancelled', 'Hold')
         OR schedule.status IN ('Completed', 'Cancelled', 'Hold')
      ORDER BY source.order_kind, source.netsuite_id`,
    [["PO", "TO"].includes(cleanKind) ? cleanKind : ""]
  );
  return result.rows.map((row) => ({
    kind: row.order_kind,
    id: Number(row.netsuite_id),
    tranid: row.tranid || "",
    reason: row.exclusion_reason || "terminal"
  }));
}

export async function findScmReconciliationSource({
  kind = "",
  orderId = null,
  orderRef = ""
} = {}) {
  const cleanKind = text(kind).toUpperCase();
  const id = Number(orderId);
  const ref = text(orderRef);
  if (!["PO", "TO"].includes(cleanKind)) return null;
  const result = cleanKind === "PO"
    ? await query(
      `SELECT 'PO'::text AS order_kind,
              candidate.source_order_id,
              candidate.source_order_ref
         FROM (
           SELECT ledger.source_po_id AS source_order_id,
                  ledger.source_po_ref AS source_order_ref,
                  0 AS priority,
                  ledger.created_at
             FROM dispatch_scm_po_splits ledger
            WHERE ($2 <> '' AND lower(ledger.split_po_ref) = lower($2))
               OR ($1::bigint IS NOT NULL AND ledger.split_po_id = $1)
           UNION ALL
           SELECT po.netsuite_id, po.tranid, 1, po.synced_at
             FROM purchase_orders po
            WHERE (
              ($1::bigint IS NOT NULL AND po.netsuite_id = $1)
              OR ($2 <> '' AND (
                lower(po.tranid) = lower($2)
                OR lower(COALESCE(po.dispatch_ref, '')) = lower($2)
              ))
            )
              AND po.netsuite_id > 0
         ) candidate
        ORDER BY candidate.priority, candidate.created_at DESC NULLS LAST
        LIMIT 1`,
      [Number.isSafeInteger(id) ? id : null, ref]
    )
    : await query(
      `SELECT 'TO'::text AS order_kind,
              candidate.source_order_id,
              candidate.source_order_ref
         FROM (
           SELECT ledger.source_to_id AS source_order_id,
                  ledger.source_to_ref AS source_order_ref,
                  0 AS priority,
                  ledger.created_at
             FROM dispatch_scm_to_splits ledger
            WHERE ($2 <> '' AND lower(ledger.split_to_ref) = lower($2))
               OR ($1::bigint IS NOT NULL AND ledger.split_to_id = $1)
           UNION ALL
           SELECT transfer.netsuite_id, transfer.tranid, 1, transfer.synced_at
             FROM transfer_orders transfer
            WHERE (
              ($1::bigint IS NOT NULL AND transfer.netsuite_id = $1)
              OR ($2 <> '' AND lower(transfer.tranid) = lower($2))
            )
              AND transfer.netsuite_id > 0
         ) candidate
        ORDER BY candidate.priority, candidate.created_at DESC NULLS LAST
        LIMIT 1`,
      [Number.isSafeInteger(id) ? id : null, ref]
    );
  const row = result.rows[0];
  return row ? {
    kind: row.order_kind,
    id: Number(row.source_order_id),
    tranid: row.source_order_ref || ""
  } : null;
}

export async function initializeScmReconciliationRunTargets(
  runId,
  sources = [],
  {
    replacePendingManifest = false,
    workerLeaseToken = ""
  } = {}
) {
  return withTransaction(async () => {
    const owner = await query(
      `SELECT id
         FROM scm_reconciliation_runs
        WHERE id = $1
          AND (
            (
              NULLIF($2, '') IS NULL
              AND status IN ('queued', 'running')
            )
            OR (
              NULLIF($2, '') IS NOT NULL
              AND status = 'running'
              AND checkpoint->>'workerLeaseToken' = $2
            )
          )
        FOR SHARE`,
      [Number(runId), text(workerLeaseToken)]
    );
    if (!owner.rows[0]) {
      const error = new Error("The reconciliation worker no longer owns this run.");
      error.code = "SCM_RECONCILIATION_LEASE_LOST";
      throw error;
    }
    if (replacePendingManifest) {
      const poIds = (sources || [])
        .filter((source) => source.kind === "PO")
        .map((source) => Number(source.id));
      const toIds = (sources || [])
        .filter((source) => source.kind === "TO")
        .map((source) => Number(source.id));
      await query(
        `DELETE FROM scm_reconciliation_run_targets
          WHERE run_id = $1
            AND status IN ('pending', 'running')
            AND NOT (
              (order_kind = 'PO' AND netsuite_order_id = ANY($2::bigint[]))
              OR
              (order_kind = 'TO' AND netsuite_order_id = ANY($3::bigint[]))
            )`,
        [Number(runId), poIds, toIds]
      );
    }
    for (const source of sources || []) {
      await query(
        `INSERT INTO scm_reconciliation_run_targets (
           run_id, order_kind, netsuite_order_id, order_ref, status, updated_at
         ) VALUES ($1, $2, $3, NULLIF($4, ''), 'pending', now())
         ON CONFLICT (run_id, order_kind, netsuite_order_id) DO UPDATE SET
           order_ref = COALESCE(EXCLUDED.order_ref, scm_reconciliation_run_targets.order_ref),
           updated_at = now()`,
        [Number(runId), source.kind, Number(source.id), source.tranid || ""]
      );
    }
    return (sources || []).length;
  });
}

export async function updateScmReconciliationRunTarget(runId, source, {
  status = "succeeded",
  proposedChange = {},
  result = {},
  checkpoint = {},
  error = "",
  workerLeaseToken = ""
} = {}) {
  const targetStatus = ["pending", "running", "succeeded", "review", "skipped", "failed"].includes(status)
    ? status
    : "failed";
  await query(
    `UPDATE scm_reconciliation_run_targets
        SET status = $4,
            attempts = attempts + CASE WHEN $4 = 'running' THEN 1 ELSE 0 END,
            proposed_change = $5::jsonb,
            result = $6::jsonb,
            checkpoint = $7::jsonb,
            error = NULLIF($8, ''),
            started_at = CASE WHEN $4 = 'running' THEN COALESCE(started_at, now()) ELSE started_at END,
            completed_at = CASE WHEN $4 IN ('succeeded', 'review', 'skipped', 'failed') THEN now() ELSE completed_at END,
            updated_at = now()
      WHERE run_id = $1
        AND order_kind = $2
        AND netsuite_order_id = $3
        AND EXISTS (
          SELECT 1
           FROM scm_reconciliation_runs run
           WHERE run.id = scm_reconciliation_run_targets.run_id
             AND (
               (
                 NULLIF($9, '') IS NULL
                 AND run.status IN ('queued', 'running')
               )
               OR (
                 NULLIF($9, '') IS NOT NULL
                 AND run.status = 'running'
                 AND run.checkpoint->>'workerLeaseToken' = $9
               )
             )
        )`,
    [
      Number(runId),
      source.kind,
      Number(source.id),
      targetStatus,
      JSON.stringify(proposedChange || {}),
      JSON.stringify(result || {}),
      JSON.stringify(checkpoint || {}),
      text(error),
      text(workerLeaseToken)
    ]
  );
}

export async function getScmReconciliationRunDecisionSummary(runId) {
  const id = positiveId(runId);
  if (!id) {
    throw Object.assign(
      new Error("A valid reconciliation run ID is required."),
      { status: 400 }
    );
  }
  const result = await query(
    `SELECT COUNT(*) FILTER (WHERE status = 'review')::int AS review_targets,
            COUNT(*) FILTER (
              WHERE status = 'review'
                AND review_decision IS NOT NULL
            )::int AS decided_targets,
            COUNT(*) FILTER (
              WHERE status = 'review'
                AND review_decision IS NULL
            )::int AS pending_targets,
            COUNT(*) FILTER (WHERE review_decision = 'skip')::int AS skipped_targets,
            COUNT(*) FILTER (
              WHERE review_decision = 'accept_current'
            )::int AS accepted_targets,
            COUNT(*) FILTER (
              WHERE review_decision = 'keep_review'
            )::int AS kept_review_targets
       FROM scm_reconciliation_run_targets
      WHERE run_id = $1`,
    [id]
  );
  const row = result.rows[0] || {};
  return {
    reviewTargets: Number(row.review_targets || 0),
    decidedTargets: Number(row.decided_targets || 0),
    pendingTargets: Number(row.pending_targets || 0),
    skippedTargets: Number(row.skipped_targets || 0),
    acceptedTargets: Number(row.accepted_targets || 0),
    keptReviewTargets: Number(row.kept_review_targets || 0)
  };
}

export async function listScmReconciliationRunTargetDecisions(runId) {
  const id = positiveId(runId);
  if (!id) return [];
  const result = await query(
    `SELECT *
       FROM scm_reconciliation_run_targets
      WHERE run_id = $1
        AND status = 'review'
        AND review_decision IS NOT NULL
      ORDER BY order_kind, netsuite_order_id`,
    [id]
  );
  return result.rows.map(mapRunTarget);
}

export async function assertScmReconciliationRunReadyToApply(runId) {
  const id = positiveId(runId);
  if (!id) {
    throw Object.assign(
      new Error("A valid reconciliation run ID is required."),
      { status: 400 }
    );
  }
  const unresolved = await query(
    `SELECT order_ref
       FROM scm_reconciliation_run_targets
      WHERE run_id = $1
        AND status = 'review'
        AND review_decision IS NULL
      ORDER BY order_kind, COALESCE(order_ref, ''), netsuite_order_id
      LIMIT 20`,
    [id]
  );
  if (unresolved.rowCount) {
    const refs = unresolved.rows.map((row) => text(row.order_ref)).filter(Boolean);
    throw Object.assign(
      new Error(
        `Choose an action for every reviewed order before applying this dry run.`
        + (refs.length ? ` Pending: ${refs.join(", ")}.` : "")
      ),
      {
        status: 409,
        code: "SCM_RECONCILIATION_REVIEW_DECISIONS_REQUIRED",
        pendingOrderRefs: refs
      }
    );
  }
  return getScmReconciliationRunDecisionSummary(id);
}

export async function updateScmReconciliationRunTargetDecision({
  runId,
  targetId,
  decision,
  note = "",
  actor = "",
  expectedUpdatedAt = null
} = {}) {
  const id = positiveId(runId);
  const target = positiveId(targetId);
  const cleanDecision = text(decision).toLowerCase();
  const cleanNote = text(note);
  const cleanActor = text(actor);
  const expected = dateValue(expectedUpdatedAt);
  if (!id || !target) {
    throw Object.assign(
      new Error("A valid reconciliation run and target are required."),
      { status: 400 }
    );
  }
  if (!REVIEW_DECISIONS.has(cleanDecision)) {
    throw Object.assign(
      new Error("Choose Keep in Review, Skip this order, or Accept NetSuite outcome."),
      { status: 400 }
    );
  }
  if (!cleanActor) {
    throw Object.assign(new Error("Admin identity is required."), { status: 401 });
  }
  if (["skip", "accept_current"].includes(cleanDecision) && !cleanNote) {
    throw Object.assign(
      new Error("Enter an audit note for Skip or Accept NetSuite outcome."),
      { status: 400 }
    );
  }
  if (!expected) {
    throw Object.assign(
      new Error("Refresh the dry-run target before saving its decision."),
      { status: 409, code: "SCM_RECONCILIATION_TARGET_STALE" }
    );
  }

  return withTransaction(async () => {
    const selected = await query(
      `SELECT target.*,
              run.dry_run,
              run.status AS run_status
         FROM scm_reconciliation_run_targets target
         JOIN scm_reconciliation_runs run ON run.id = target.run_id
        WHERE target.id = $1
          AND target.run_id = $2
        FOR UPDATE OF target, run`,
      [target, id]
    );
    const row = selected.rows[0];
    if (!row) {
      throw Object.assign(
        new Error("The dry-run order target was not found."),
        { status: 404 }
      );
    }
    if (
      row.dry_run !== true
      || !["succeeded", "awaiting_approval"].includes(text(row.run_status))
      || row.status !== "review"
    ) {
      throw Object.assign(
        new Error("Only a reviewed order in a completed dry run can receive a decision."),
        { status: 409 }
      );
    }
    if (dateValue(row.updated_at) !== expected) {
      throw Object.assign(
        new Error("This review changed after it was opened. Refresh it before deciding."),
        { status: 409, code: "SCM_RECONCILIATION_TARGET_STALE" }
      );
    }
    const linkedApply = await query(
      `SELECT id, status
         FROM scm_reconciliation_runs
        WHERE resume_of_run_id = $1
          AND dry_run = false
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [id]
    );
    if (linkedApply.rows[0]) {
      throw Object.assign(
        new Error("This dry run already has a linked apply run; its decisions are locked."),
        { status: 409 }
      );
    }
    const proposal = row.proposed_change || {};
    const outcome = scmReconciliationProposedOutcome(proposal);
    if (
      cleanDecision === "accept_current"
      && (
        !outcome
        || text(proposal.reconciliationStatus).toLowerCase() === "missing"
      )
    ) {
      throw Object.assign(
        new Error("This proposal has no authoritative NetSuite outcome to accept. Skip it or keep it in review."),
        { status: 409 }
      );
    }
    const decisionNote = cleanNote || "Keep this order in Reconcile Review during apply.";
    const fingerprint = scmReconciliationReviewFingerprint(proposal);
    const updated = await query(
      `UPDATE scm_reconciliation_run_targets
          SET review_decision = $2,
              review_decision_note = $3,
              review_decision_fingerprint = $4,
              review_decided_by = $5,
              review_decided_at = clock_timestamp(),
              updated_at = clock_timestamp()
        WHERE id = $1
        RETURNING *`,
      [target, cleanDecision, decisionNote, fingerprint, cleanActor]
    );
    if (cleanDecision === "skip") {
      await query(
        `INSERT INTO scm_reconciliation_order_state (
           order_kind, source_order_netsuite_id, source_order_ref,
           broad_reconciliation_skipped, broad_reconciliation_skipped_at,
           broad_reconciliation_skipped_by, broad_reconciliation_skip_note,
           updated_at
         ) VALUES (
           $1, $2, $3, true, now(), $4, $5, now()
         )
         ON CONFLICT (order_kind, source_order_netsuite_id) DO UPDATE SET
           broad_reconciliation_skipped = true,
           broad_reconciliation_skipped_at = now(),
           broad_reconciliation_skipped_by = EXCLUDED.broad_reconciliation_skipped_by,
           broad_reconciliation_skip_note = EXCLUDED.broad_reconciliation_skip_note,
           updated_at = now()`,
        [
          row.order_kind,
          row.netsuite_order_id,
          text(row.order_ref) || String(row.netsuite_order_id),
          cleanActor,
          decisionNote
        ]
      );
    } else {
      await query(
        `UPDATE scm_reconciliation_order_state
            SET broad_reconciliation_skipped = false,
                broad_reconciliation_skipped_at = NULL,
                broad_reconciliation_skipped_by = NULL,
                broad_reconciliation_skip_note = NULL,
                updated_at = now()
          WHERE order_kind = $1
            AND source_order_netsuite_id = $2`,
        [row.order_kind, row.netsuite_order_id]
      );
    }
    await insertReconciliationAuditEvent({
      eventKey: `manual:dry-run-decision:${id}:${target}:${crypto.randomUUID()}`,
      runId: id,
      source: "manual",
      eventType: "dry_run.review_decision",
      recordType: row.order_kind,
      action: cleanDecision,
      parentOrderKind: row.order_kind,
      parentOrderId: row.netsuite_order_id,
      parentOrderRef: row.order_ref,
      occurredAt: new Date().toISOString(),
      payload: {
        targetId: target,
        decision: cleanDecision,
        note: decisionNote,
        excludeFromBroadReconciliation: cleanDecision === "skip",
        proposalFingerprint: fingerprint,
        proposedOutcome: outcome
      },
      actor: cleanActor
    });
    return {
      target: mapRunTarget(updated.rows[0]),
      decisionSummary: await getScmReconciliationRunDecisionSummary(id)
    };
  });
}

export async function recordScmReconciliationMissingLookup(source, {
  sourceName = "manual",
  runId = null
} = {}) {
  const kind = text(source.kind).toUpperCase();
  const id = positiveId(source.id);
  if (!["PO", "TO"].includes(kind) || !id) {
    throw Object.assign(new Error("A valid PO/TO source is required."), { status: 400 });
  }
  const local = await loadLocalScmReconciliationOrder(kind, id);
  if (!local) throw Object.assign(new Error("The local PO/TO source was not found."), { status: 404 });
  const cleanSource = ["nightly", "manual", "backfill", "webhook", "system"].includes(sourceName)
    ? sourceName
    : "manual";
  const reason = "The order was absent from two successful direct NetSuite lookups.";
  return withTransaction(async () => {
    const stateResult = await query(
      `INSERT INTO scm_reconciliation_order_state (
         order_kind, source_order_netsuite_id, source_order_ref,
         netsuite_terminal_state, application_status, reconciliation_status,
         reconciliation_source, source_location_id, source_location,
         destination_location_id, destination_location, missing_success_count,
         last_direct_lookup_at, last_run_id, order_snapshot, created_at, updated_at
       ) VALUES (
         $1, $2, $3, 'open', 'Queued', 'pending', $4,
         $5, NULLIF($6, ''), $7, NULLIF($8, ''),
         1, now(), $9, $10::jsonb, now(), now()
       )
       ON CONFLICT (order_kind, source_order_netsuite_id) DO UPDATE SET
         missing_success_count = scm_reconciliation_order_state.missing_success_count + 1,
         last_direct_lookup_at = now(),
         netsuite_terminal_state = CASE
           WHEN scm_reconciliation_order_state.missing_success_count + 1 >= 2 THEN 'missing'
           ELSE scm_reconciliation_order_state.netsuite_terminal_state
         END,
         application_status = CASE
           WHEN scm_reconciliation_order_state.missing_success_count + 1 >= 2 THEN 'Reconcile Review'
           ELSE scm_reconciliation_order_state.application_status
         END,
         reconciliation_status = CASE
           WHEN scm_reconciliation_order_state.missing_success_count + 1 >= 2 THEN 'missing'
           ELSE scm_reconciliation_order_state.reconciliation_status
         END,
         reconciliation_reason = CASE
           WHEN scm_reconciliation_order_state.missing_success_count + 1 >= 2 THEN $11
           ELSE scm_reconciliation_order_state.reconciliation_reason
         END,
         reconciliation_source = $4,
         last_run_id = $9,
         order_snapshot = $10::jsonb,
         updated_at = now()
       RETURNING *`,
      [
        kind,
        id,
        local.tranid,
        cleanSource,
        local.sourceLocationId,
        local.sourceLocation,
        local.destinationLocationId,
        local.destinationLocation,
        runId ? Number(runId) : null,
        JSON.stringify(local),
        reason
      ]
    );
    const state = stateResult.rows[0];
    if (Number(state.missing_success_count) >= 2) {
      await query(
        `INSERT INTO scm_reconciliation_review_cases (
           case_key, order_state_id, review_code, severity, dismissible,
           status, reason, details, detected_run_id,
           first_detected_at, last_detected_at, updated_at
         ) VALUES (
           $1, $2, 'source_missing', 'blocking', false,
           'open', $3, $4::jsonb, $5, now(), now(), now()
         )
         ON CONFLICT (case_key) DO UPDATE SET
           status = 'open',
           reason = EXCLUDED.reason,
           details = EXCLUDED.details,
           detected_run_id = COALESCE(EXCLUDED.detected_run_id, scm_reconciliation_review_cases.detected_run_id),
           last_detected_at = now(),
           resolved_at = null,
           resolved_by = null,
           resolution_action = null,
           resolution_note = null,
           updated_at = now()`,
        [
          `${kind}:${id}:source_missing`,
          state.id,
          reason,
          JSON.stringify({ lookupCount: Number(state.missing_success_count) }),
          runId ? Number(runId) : null
        ]
      );
      await query(
        `UPDATE scm_transport_schedule
            SET status = 'Reconcile Review',
                reconciliation_order_state_id = $1,
                reconciliation_blocked = true,
                last_reconciled_at = now(),
                updated_by = 'reconciliation',
                updated_at = now()
          WHERE order_kind = $2
            AND (
              lower(order_ref) = lower($3)
              OR lower(order_ref) IN (
                SELECT lower(split_po_ref)
                  FROM dispatch_scm_po_splits
                 WHERE $2 = 'PO' AND source_po_id = $4
                UNION ALL
                SELECT lower(split_to_ref)
                  FROM dispatch_scm_to_splits
                 WHERE $2 = 'TO' AND source_to_id = $4
              )
            )`,
        [state.id, kind, local.scheduleRef || local.tranid, id]
      );
    }
    return {
      missing_success_count: Number(state.missing_success_count),
      reconciliation_status: state.reconciliation_status,
      reconciliation_reason: state.reconciliation_reason || ""
    };
  });
}

export async function clearScmReconciliationMissingLookup(source) {
  await withTransaction(async () => {
    const stateResult = await query(
      `UPDATE scm_reconciliation_order_state
          SET missing_success_count = 0,
              last_direct_lookup_at = now(),
              netsuite_terminal_state = CASE WHEN netsuite_terminal_state = 'missing' THEN 'open' ELSE netsuite_terminal_state END,
              reconciliation_status = CASE WHEN reconciliation_status = 'missing' THEN 'pending' ELSE reconciliation_status END,
              reconciliation_reason = CASE WHEN reconciliation_status = 'missing' THEN null ELSE reconciliation_reason END,
              updated_at = now()
        WHERE order_kind = $1
          AND source_order_netsuite_id = $2
        RETURNING id`,
      [source.kind, Number(source.id)]
    );
    const stateId = stateResult.rows[0]?.id;
    if (!stateId) return;
    const reviews = await query(
      `UPDATE scm_reconciliation_review_cases
          SET status = 'resolved',
              resolved_at = now(),
              resolved_by = 'system',
              resolution_action = 'auto_resolve',
              resolution_note = 'The source order was found by a later successful NetSuite lookup.',
              updated_at = now()
        WHERE order_state_id = $1
          AND review_code = 'source_missing'
          AND status = 'open'
        RETURNING id`,
      [stateId]
    );
    for (const review of reviews.rows) {
      await query(
        `INSERT INTO scm_reconciliation_review_resolutions (
           review_case_id, action, actor, actor_role, note, details
         ) VALUES (
           $1, 'auto_resolve', 'system', 'system',
           'The source order was found by a later successful NetSuite lookup.',
           '{"reason":"source-found"}'::jsonb
         )`,
        [review.id]
      );
    }
  });
}

export async function cancelMissingScmPurchaseOrderLocally({
  sourceOrderId,
  sourceOrderRef = "",
  reviewCaseId,
  expectedLastDetectedAt,
  verification = {},
  note = "",
  actor = "",
  actorRole = "admin"
} = {}) {
  const orderId = positiveId(sourceOrderId);
  const caseId = positiveId(reviewCaseId);
  const orderRef = text(sourceOrderRef).toUpperCase();
  const cleanActor = text(actor);
  const cleanNote = text(note);
  const expectedDetectedAt = dateValue(expectedLastDetectedAt);
  const verifiedAt = dateValue(verification.verifiedAt);
  if (!orderId || !caseId || !orderRef) {
    throw Object.assign(
      new Error("A valid missing Purchase Order and review case are required."),
      { status: 400 }
    );
  }
  if (!cleanActor || !cleanNote) {
    throw Object.assign(
      new Error("An admin and audit note are required to cancel a missing Purchase Order."),
      { status: cleanActor ? 400 : 401 }
    );
  }
  if (!expectedDetectedAt) {
    throw Object.assign(
      new Error("Refresh the source-missing review before cancelling this Purchase Order."),
      { status: 409, code: "SCM_RECONCILIATION_REVIEW_STALE" }
    );
  }
  const verificationAgeMs = verifiedAt ? Date.now() - new Date(verifiedAt).getTime() : Infinity;
  const verificationMatches = verification.orderKind === "PO"
    && positiveId(verification.sourceOrderId) === orderId
    && text(verification.sourceOrderRef).toUpperCase() === orderRef
    && verification.lineQueryFound === false
    && verification.headerQueryFound === false
    && verification.referenceQueryFound === false
    && verificationAgeMs >= -30_000
    && verificationAgeMs <= 5 * 60_000;
  if (!verificationMatches) {
    throw Object.assign(
      new Error("Fresh NetSuite ID, header, and transaction-number verification is required."),
      { status: 409, code: "SCM_RECONCILIATION_NETSUITE_VERIFICATION_REQUIRED" }
    );
  }

  return withTransaction(async () => {
    const activeRun = await query(
      `SELECT id
         FROM scm_reconciliation_runs
        WHERE status = 'running'
        LIMIT 1`
    );
    if (activeRun.rows[0]) {
      throw Object.assign(
        new Error("Wait for the active PO/TO reconciliation run to finish, then verify this order again."),
        { status: 409, code: "SCM_RECONCILIATION_RUN_ACTIVE" }
      );
    }

    const stateResult = await query(
      `SELECT state.*,
              po.tranid AS local_order_ref,
              po.dispatch_ref,
              po.status AS local_status_code,
              po.status_text AS local_status_text,
              po.receipt_status,
              po.received_at AS local_received_at,
              po.last_item_receipt_id,
              po.netsuite_active AS local_netsuite_active,
              po.netsuite_missing_at
         FROM scm_reconciliation_order_state state
         JOIN purchase_orders po
           ON po.netsuite_id = state.source_order_netsuite_id
        WHERE state.order_kind = 'PO'
          AND state.source_order_netsuite_id = $1
          AND lower(state.source_order_ref) = lower($2)
        FOR UPDATE OF state, po`,
      [orderId, orderRef]
    );
    const state = stateResult.rows[0];
    if (!state) {
      throw Object.assign(
        new Error("The source-missing Purchase Order review is no longer available."),
        { status: 409, code: "SCM_RECONCILIATION_REVIEW_STALE" }
      );
    }

    const reviewResult = await query(
      `SELECT *
         FROM scm_reconciliation_review_cases
        WHERE id = $1
          AND order_state_id = $2
          AND review_code = 'source_missing'
          AND status = 'open'
          AND date_trunc('milliseconds', last_detected_at)
              = date_trunc('milliseconds', $3::timestamptz)
        FOR UPDATE`,
      [caseId, state.id, expectedDetectedAt]
    );
    const review = reviewResult.rows[0];
    if (!review) {
      throw Object.assign(
        new Error("This source-missing review changed after it was opened. Refresh it and verify again."),
        { status: 409, code: "SCM_RECONCILIATION_REVIEW_STALE" }
      );
    }
    if (
      Number(state.missing_success_count || 0) < 2
      || !["missing", "review"].includes(text(state.reconciliation_status))
    ) {
      throw Object.assign(
        new Error("Two successful missing lookups are required before local cancellation."),
        { status: 409, code: "SCM_RECONCILIATION_MISSING_NOT_CONFIRMED" }
      );
    }

    const otherCases = await query(
      `SELECT id, review_code
         FROM scm_reconciliation_review_cases
        WHERE order_state_id = $1
          AND status = 'open'
          AND id <> $2
        ORDER BY id`,
      [state.id, review.id]
    );
    if (otherCases.rows[0]) {
      throw Object.assign(
        new Error("Resolve the order's other reconciliation review before cancelling the missing Purchase Order."),
        {
          status: 409,
          code: "SCM_RECONCILIATION_OTHER_REVIEW_OPEN",
          reviewCodes: otherCases.rows.map((row) => row.review_code)
        }
      );
    }

    const referenceValues = [...new Set([
      orderRef,
      state.source_order_ref,
      state.local_order_ref,
      state.dispatch_ref
    ].map((value) => text(value).toLowerCase()).filter(Boolean))];
    const activityResult = await query(
      `SELECT
         (SELECT COUNT(*)::int
            FROM dispatch_scm_po_splits split
           WHERE split.source_po_id = $1) AS split_count,
         (SELECT COUNT(*)::int
            FROM scm_schedule_group_members member
           WHERE member.order_kind = 'PO'
             AND lower(member.order_ref) = ANY($2::text[])) AS group_membership_count,
         (SELECT COUNT(*)::int
            FROM receiving_receipt_records receipt
           WHERE receipt.order_id = $1) AS receipt_record_count,
         (SELECT COUNT(*)::int
            FROM scm_reconciliation_transaction_snapshots snapshot
           WHERE snapshot.source_order_kind = 'PO'
             AND snapshot.source_order_netsuite_id = $1) AS linked_transaction_count,
         (SELECT COUNT(*)::int
            FROM scm_transport_schedule schedule
           WHERE schedule.order_kind = 'PO'
             AND (
               schedule.source_id = $1
               OR lower(schedule.order_ref) = ANY($2::text[])
             )
             AND (
               schedule.status IN (
                 'Planned', 'Partially Done', 'In Transit', 'Completed'
               )
               OR schedule.eta_date IS NOT NULL
               OR NULLIF(BTRIM(COALESCE(schedule.eta_time, '')), '') IS NOT NULL
               OR NULLIF(BTRIM(COALESCE(schedule.driver, '')), '') IS NOT NULL
             )) AS operational_schedule_count,
         (SELECT COUNT(*)::int
            FROM purchase_order_lines line
           WHERE line.purchase_order_id = $1
             AND (
               GREATEST(
                 COALESCE(line.netsuite_received_qty, 0),
               COALESCE(line.netsuite_received_baseline_qty, 0)
               ) > $3
               OR COALESCE(line.received_sales_qty, 0) > $3
               OR COALESCE(line.received_pallet_qty, 0)
                  + COALESCE(line.received_layer_qty, 0)
                  + COALESCE(line.received_section_qty, 0)
                  + COALESCE(line.received_piece_qty, 0) > $3
               OR line.confirmed_at IS NOT NULL
             )) AS progressed_line_count,
         (SELECT COUNT(*)::int
            FROM scm_reconciliation_allocations allocation
            JOIN scm_reconciliation_order_line_state line_state
              ON line_state.id = allocation.order_line_state_id
           WHERE line_state.order_state_id = $4
             AND allocation.active = true
             AND allocation.quantity > $3) AS allocation_count`,
      [orderId, referenceValues, EPSILON, state.id]
    );
    const activityRow = activityResult.rows[0] || {};
    const activity = {
      splits: Number(activityRow.split_count || 0),
      groupMemberships: Number(activityRow.group_membership_count || 0),
      receiptRecords: Number(activityRow.receipt_record_count || 0),
      linkedTransactions: Number(activityRow.linked_transaction_count || 0),
      operationalSchedules: Number(activityRow.operational_schedule_count || 0),
      progressedLines: Number(activityRow.progressed_line_count || 0),
      allocations: Number(activityRow.allocation_count || 0),
      headerReceipt: Boolean(
        state.local_received_at
        || positiveId(state.last_item_receipt_id)
        || ["partial_received", "received"].includes(text(state.receipt_status).toLowerCase())
      )
    };
    if (
      Object.entries(activity).some(([, value]) =>
        typeof value === "boolean" ? value : Number(value) > 0)
    ) {
      throw Object.assign(
        new Error("This Purchase Order has local planning, split, receipt, or IF/IR activity and cannot be cancelled automatically."),
        {
          status: 409,
          code: "SCM_RECONCILIATION_MISSING_PO_HAS_ACTIVITY",
          activity
        }
      );
    }

    const lineTotals = await query(
      `SELECT COALESCE(
                SUM(GREATEST(COALESCE(quantity, 0), 0))
                  FILTER (WHERE netsuite_active = true),
                SUM(GREATEST(COALESCE(quantity, 0), 0)),
                0
              ) AS ordered_qty
         FROM purchase_order_lines
        WHERE purchase_order_id = $1`,
      [orderId]
    );
    const ordered = roundReconciliationQuantity(lineTotals.rows[0]?.ordered_qty);
    const localRef = text(state.local_order_ref || state.source_order_ref || orderRef).toUpperCase();
    const scheduleRef = text(state.dispatch_ref || localRef).toUpperCase();
    const family = {
      ordered,
      fulfilled: 0,
      received: 0,
      abandoned: 0,
      remaining: 0,
      destinationRemaining: 0
    };
    const acceptedTargets = {
      [localRef]: {
        orderRef: localRef,
        orderId,
        targetKind: "source_residual",
        ...family,
        exactAllocation: true,
        hidden: ordered <= EPSILON,
        hasActivePlan: false,
        allocationMethods: [],
        applicationStatus: "Cancelled",
        reconciliationStatus: "current",
        reason: ""
      }
    };
    const quantitySummary = { family, targets: acceptedTargets };
    const proposedState = {
      applicationStatus: "Cancelled",
      reconciliationStatus: "current",
      reason: "",
      quantities: family,
      exactAllocation: true,
      targets: acceptedTargets,
      resolution: "cancel_missing"
    };
    const audit = await insertReconciliationAuditEvent({
      eventKey: `manual:cancel-missing:${orderId}:${caseId}:${crypto.randomUUID()}`,
      source: "manual",
      eventType: "review.resolution",
      recordType: "PO",
      action: "cancel_missing",
      parentOrderKind: "PO",
      parentOrderId: orderId,
      parentOrderRef: localRef,
      occurredAt: verifiedAt,
      payload: {
        resolution: "cancel_missing",
        note: cleanNote,
        reviewCaseId: caseId,
        verification,
        activity,
        previousState: {
          netsuiteTerminalState: state.netsuite_terminal_state,
          applicationStatus: state.application_status,
          reconciliationStatus: state.reconciliation_status,
          localNetSuiteActive: state.local_netsuite_active,
          localStatusCode: state.local_status_code,
          localStatusText: state.local_status_text,
          missingLookupCount: Number(state.missing_success_count || 0)
        },
        localOutcome: {
          netsuiteTerminalState: "deleted",
          applicationStatus: "Cancelled",
          ordered
        }
      },
      actor: cleanActor
    });
    const resolutionResult = await query(
      `INSERT INTO scm_reconciliation_review_resolutions (
         review_case_id, action, actor, actor_role, note, details, audit_event_id
       ) VALUES (
         $1, 'cancel_missing', $2, $3, $4, $5::jsonb, $6
       )
       RETURNING *`,
      [
        review.id,
        cleanActor,
        text(actorRole) || "admin",
        cleanNote,
        JSON.stringify({
          orderKind: "PO",
          sourceOrderId: orderId,
          sourceOrderRef: localRef,
          verification,
          activity
        }),
        audit.event.id
      ]
    );
    await query(
      `UPDATE scm_reconciliation_review_cases
          SET status = 'resolved',
              resolved_at = now(),
              resolved_by = $2,
              resolution_action = 'cancel_missing',
              resolution_note = $3,
              updated_at = now()
        WHERE id = $1`,
      [review.id, cleanActor, cleanNote]
    );
    await query(
      `UPDATE purchase_orders
          SET netsuite_active = false,
              netsuite_missing_at = COALESCE(netsuite_missing_at, $2::timestamptz),
              synced_at = now()
        WHERE netsuite_id = $1`,
      [orderId, verifiedAt]
    );
    await query(
      `UPDATE scm_reconciliation_order_state
          SET netsuite_terminal_state = 'deleted',
              application_status = 'Cancelled',
              reconciliation_status = 'current',
              reconciliation_reason = null,
              reconciliation_source = 'manual',
              ordered_qty = $2,
              fulfilled_qty = 0,
              received_qty = 0,
              abandoned_qty = 0,
              remaining_qty = 0,
              destination_remaining_qty = 0,
              exact_allocation = true,
              last_direct_lookup_at = $3::timestamptz,
              quantity_summary = $4::jsonb,
              proposed_state = $5::jsonb,
              reconciled_at = now(),
              completed_at = null,
              cancelled_at = COALESCE(cancelled_at, now()),
              status_changed_at = CASE
                WHEN application_status IS DISTINCT FROM 'Cancelled' THEN now()
                ELSE status_changed_at
              END,
              updated_at = now()
        WHERE id = $1`,
      [
        state.id,
        ordered,
        verifiedAt,
        JSON.stringify(quantitySummary),
        JSON.stringify(proposedState)
      ]
    );
    const updatedSchedules = await query(
      `UPDATE scm_transport_schedule
          SET status = 'Cancelled',
              reconciliation_order_state_id = $1,
              reconciliation_blocked = false,
              last_reconciled_at = now(),
              updated_by = $3,
              updated_at = now()
        WHERE order_kind = 'PO'
          AND (
            source_id = $2
            OR lower(order_ref) = ANY($4::text[])
          )
       RETURNING id`,
      [state.id, orderId, cleanActor, referenceValues]
    );
    if (!updatedSchedules.rows.length) {
      await query(
        `INSERT INTO scm_transport_schedule (
           order_kind, source_table, source_id, order_ref, status,
           reconciliation_order_state_id, reconciliation_blocked,
           last_reconciled_at, created_by, updated_by, created_at, updated_at
         ) VALUES (
           'PO', 'purchase_orders', $1, $2, 'Cancelled',
           $3, false, now(), $4, $4, now(), now()
         )
         ON CONFLICT (order_kind, order_ref) DO UPDATE SET
           source_table = COALESCE(scm_transport_schedule.source_table, EXCLUDED.source_table),
           source_id = COALESCE(scm_transport_schedule.source_id, EXCLUDED.source_id),
           status = 'Cancelled',
           reconciliation_order_state_id = EXCLUDED.reconciliation_order_state_id,
           reconciliation_blocked = false,
           last_reconciled_at = now(),
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
        [orderId, scheduleRef, state.id, cleanActor]
      );
    }
    return {
      ok: true,
      action: "cancel_missing",
      orderKind: "PO",
      sourceOrderId: orderId,
      sourceOrderRef: localRef,
      reviewCaseId: Number(review.id),
      resolutionId: Number(resolutionResult.rows[0].id),
      auditEventId: Number(audit.event.id),
      applicationStatus: "Cancelled",
      netsuiteTerminalState: "deleted",
      verification,
      activity
    };
  });
}

export async function markScmReconciliationNightlyRun(localDate) {
  await query(
    `UPDATE scm_reconciliation_settings
        SET last_nightly_local_date = $1::date,
            updated_at = now()
      WHERE singleton_id = 1`,
    [localDate]
  );
}

function numericJson(value) {
  return roundReconciliationQuantity(value);
}

export async function enrichScmScheduleWithReconciliation(rows = [], {
  includeDetails = false,
  view = "",
  reviewOnly = false
} = {}) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  if (!sourceRows.length) return [];
  const kinds = [...new Set(sourceRows.map((row) => text(row.orderKind).toUpperCase()).filter((kind) => ["PO", "TO"].includes(kind)))];
  if (!kinds.length) return reviewOnly ? [] : sourceRows;
  const statesResult = await query(
    `SELECT state.*,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', review.id,
                'code', review.review_code,
                'severity', review.severity,
                'dismissible', review.dismissible,
                'reason', review.reason,
                'details', review.details,
                'firstDetectedAt', review.first_detected_at,
                'lastDetectedAt', review.last_detected_at
              ) ORDER BY review.first_detected_at, review.id)
              FROM scm_reconciliation_review_cases review
             WHERE review.order_state_id = state.id
               AND review.status = 'open'
            ), '[]'::jsonb) AS review_cases
       FROM scm_reconciliation_order_state state
      WHERE state.order_kind = ANY($1::text[])`,
    [kinds]
  );
  const states = statesResult.rows;
  const direct = new Map(states.map((state) => [
    `${state.order_kind}:${Number(state.source_order_netsuite_id)}`,
    state
  ]));
  const byTarget = new Map();
  for (const state of states) {
    const targets = state.quantity_summary?.targets || {};
    for (const [ref, target] of Object.entries(targets)) {
      byTarget.set(`${state.order_kind}:${text(ref).toLowerCase()}`, { state, target });
    }
    byTarget.set(`${state.order_kind}:${text(state.source_order_ref).toLowerCase()}`, {
      state,
      target: targets[state.source_order_ref] || null
    });
  }
  const groupRefs = sourceRows
    .filter((row) => text(row.orderKind).toUpperCase() === "PO")
    .map((row) => text(row.orderRef).toLowerCase())
    .filter(Boolean);
  const groupMembersResult = groupRefs.length
    ? await query(
      `SELECT lower(group_header.group_ref) AS group_ref,
              member.order_ref
         FROM scm_schedule_groups group_header
         JOIN scm_schedule_group_members member ON member.group_id = group_header.id
        WHERE group_header.status = 'active'
          AND lower(group_header.group_ref) = ANY($1::text[])
        ORDER BY group_header.group_ref, member.id`,
      [[...new Set(groupRefs)]]
    )
    : { rows: [] };
  const groupMatches = new Map();
  for (const member of groupMembersResult.rows) {
    const match = byTarget.get(`PO:${text(member.order_ref).toLowerCase()}`);
    if (!match) continue;
    if (!groupMatches.has(member.group_ref)) groupMatches.set(member.group_ref, []);
    groupMatches.get(member.group_ref).push(match);
  }
  const stateIds = [...new Set(states.map((state) => Number(state.id)))];
  const [linesResult, allocationResult] = includeDetails && stateIds.length
    ? await Promise.all([
      query(
        `SELECT line.*
           FROM scm_reconciliation_order_line_state line
          WHERE line.order_state_id = ANY($1::bigint[])
            AND line.netsuite_active = true
          ORDER BY line.order_state_id, line.id`,
        [stateIds]
      ),
      query(
        `WITH active_lines AS (
           SELECT line.*, state.order_kind
             FROM scm_reconciliation_order_line_state line
             JOIN scm_reconciliation_order_state state ON state.id = line.order_state_id
            WHERE line.order_state_id = ANY($1::bigint[])
              AND line.netsuite_active = true
         ),
         split_candidates AS (
           SELECT line.order_state_id,
                  line.id AS order_line_state_id,
                  line.netsuite_line_key,
                  line.item_name,
                  line.sku,
                  'received'::text AS progress_kind,
                  split.split_po_ref AS target_order_ref,
                  line.netsuite_line_key AS target_line_ref,
                  COALESCE(allocation.quantity, 0) AS quantity,
                  COALESCE(allocation.allocation_method, '') AS allocation_method,
                  split_line.requested_sales_qty AS maximum
             FROM active_lines line
             JOIN dispatch_scm_po_split_lines split_line
               ON line.order_kind = 'PO'
              AND split_line.source_line_id = line.local_line_id
             JOIN dispatch_scm_po_splits split
               ON split.id = split_line.split_id
              AND split.status = 'active'
             LEFT JOIN scm_reconciliation_allocations allocation
               ON allocation.order_line_state_id = line.id
              AND allocation.po_split_line_id = split_line.id
              AND allocation.progress_kind = 'received'
              AND allocation.active = true
           UNION ALL
           SELECT line.order_state_id,
                  line.id AS order_line_state_id,
                  line.netsuite_line_key,
                  line.item_name,
                  line.sku,
                  progress.progress_kind,
                  split.split_to_ref AS target_order_ref,
                  line.netsuite_line_key AS target_line_ref,
                  COALESCE(allocation.quantity, 0) AS quantity,
                  COALESCE(allocation.allocation_method, '') AS allocation_method,
                  split_line.requested_sales_qty AS maximum
             FROM active_lines line
             JOIN dispatch_scm_to_split_lines split_line
               ON line.order_kind = 'TO'
              AND line.local_line_stage = split_line.source_line_stage
              AND split_line.source_line_id = line.local_line_id
             JOIN dispatch_scm_to_splits split
               ON split.id = split_line.split_id
              AND split.status = 'active'
            CROSS JOIN (VALUES ('fulfilled'::text), ('received'::text)) progress(progress_kind)
             LEFT JOIN scm_reconciliation_allocations allocation
               ON allocation.order_line_state_id = line.id
              AND allocation.to_split_line_id = split_line.id
              AND allocation.progress_kind = progress.progress_kind
              AND allocation.active = true
           UNION ALL
           SELECT line.order_state_id,
                  line.id AS order_line_state_id,
                  line.netsuite_line_key,
                  line.item_name,
                  line.sku,
                  allocation.progress_kind,
                  allocation.target_order_ref,
                  allocation.target_line_ref,
                  allocation.quantity,
                  allocation.allocation_method,
                  line.current_ordered_qty AS maximum
             FROM active_lines line
             JOIN scm_reconciliation_allocations allocation
               ON allocation.order_line_state_id = line.id
              AND allocation.target_kind = 'source_residual'
              AND allocation.active = true
         )
         SELECT *
           FROM split_candidates
          ORDER BY order_state_id, order_line_state_id, progress_kind,
                   target_order_ref`,
        [stateIds]
      )
    ])
    : [{ rows: [] }, { rows: [] }];
  const linesByState = new Map();
  for (const line of linesResult.rows) {
    if (!linesByState.has(Number(line.order_state_id))) linesByState.set(Number(line.order_state_id), []);
    linesByState.get(Number(line.order_state_id)).push({
      lineKey: line.netsuite_line_key,
      itemName: line.item_name || "",
      sku: line.sku || "",
      unit: line.unit || "",
      ordered: numericJson(line.current_ordered_qty),
      fulfilled: numericJson(line.fulfilled_qty),
      received: numericJson(line.received_qty),
      abandoned: numericJson(line.abandoned_qty),
      remaining: numericJson(line.remaining_qty),
      lineStatus: line.line_status,
      matchType: line.allocation_quality,
      exact: line.identity_status === "exact" && !["inferred", "mixed"].includes(line.allocation_quality)
    });
  }
  const allocationsByState = new Map();
  for (const allocation of allocationResult.rows) {
    if (!allocationsByState.has(Number(allocation.order_state_id))) allocationsByState.set(Number(allocation.order_state_id), []);
    allocationsByState.get(Number(allocation.order_state_id)).push({
      splitRef: allocation.target_order_ref || "",
      targetOrderRef: allocation.target_order_ref || "",
      lineKey: allocation.netsuite_line_key,
      targetLineRef: allocation.target_line_ref || "",
      itemName: allocation.item_name || "",
      sku: allocation.sku || "",
      progressKind: allocation.progress_kind,
      quantity: numericJson(allocation.quantity),
      maximum: numericJson(allocation.maximum),
      allocationMethod: allocation.allocation_method
    });
  }

  const completedView = text(view).toLowerCase() === "completed";
  const enriched = [];
  for (const row of sourceRows) {
    const kind = text(row.orderKind).toUpperCase();
    if (!["PO", "TO"].includes(kind)) {
      if (!reviewOnly) enriched.push(row);
      continue;
    }
    let match = Number(row.sourceId) > 0
      ? { state: direct.get(`${kind}:${Number(row.sourceId)}`), target: null }
      : null;
    match ||= byTarget.get(`${kind}:${text(row.orderRef).toLowerCase()}`)
      || byTarget.get(`${kind}:${text(row.sourceRef).toLowerCase()}`);
    if (!match && kind === "PO") {
      const members = groupMatches.get(text(row.orderRef).toLowerCase()) || [];
      if (members.length) {
        const memberStates = members.map((member) => member.state);
        const memberTargets = members.map((member) =>
          member.target || member.state.quantity_summary?.family || {});
        const reviewReasons = [...new Set(memberStates
          .filter((state) =>
            state.reconciliation_status === "review"
            || state.reconciliation_status === "missing"
            || (state.review_cases || []).some((item) => item.severity === "blocking"))
          .map((state) => state.reconciliation_reason)
          .filter(Boolean))];
        const aggregate = (field, fallbackField = field) => roundReconciliationQuantity(
          memberTargets.reduce((sum, target, index) =>
            sum + reconciliationQuantity(target[field] ?? memberStates[index][fallbackField]), 0)
        );
        match = {
          state: {
            ...memberStates[0],
            application_status: reviewReasons.length ? "Reconcile Review" : row.status,
            reconciliation_status: reviewReasons.length ? "review" : "current",
            reconciliation_reason: reviewReasons.join(" "),
            exact_allocation: memberStates.every((state) => state.exact_allocation === true),
            review_cases: memberStates.flatMap((state) => state.review_cases || []),
            reconciled_at: memberStates
              .map((state) => state.reconciled_at)
              .filter(Boolean)
              .sort()
              .at(-1) || null
          },
          target: {
            orderRef: row.orderRef,
            applicationStatus: reviewReasons.length ? "Reconcile Review" : row.status,
            ordered: aggregate("ordered", "ordered_qty"),
            fulfilled: aggregate("fulfilled", "fulfilled_qty"),
            received: aggregate("received", "received_qty"),
            abandoned: aggregate("abandoned", "abandoned_qty"),
            remaining: aggregate("remaining", "remaining_qty"),
            destinationRemaining: aggregate("destinationRemaining", "destination_remaining_qty")
          }
        };
      }
    }
    const state = match?.state;
    if (!state) {
      const next = {
        ...row,
        reconciliationStatus: "unreconciled",
        reconciliationReason: ""
      };
      if (!reviewOnly) enriched.push(next);
      continue;
    }
    const target = match.target
      || state.quantity_summary?.targets?.[row.orderRef]
      || state.quantity_summary?.family
      || {};
    if (target.hidden === true && !completedView) continue;
    const cases = Array.isArray(state.review_cases) ? state.review_cases : [];
    const isReview = state.reconciliation_status === "review" || cases.some((item) => item.severity === "blocking");
    const isPending = state.reconciliation_status === "pending";
    if (reviewOnly && !isReview) continue;
    const quantities = {
      ordered: numericJson(target.ordered ?? state.ordered_qty),
      fulfilled: numericJson(target.fulfilled ?? state.fulfilled_qty),
      received: numericJson(target.received ?? state.received_qty),
      abandoned: numericJson(target.abandoned ?? state.abandoned_qty),
      remaining: numericJson(target.remaining ?? state.remaining_qty),
      destinationRemaining: numericJson(target.destinationRemaining ?? state.destination_remaining_qty)
    };
    const currentTargetStatus = target.applicationStatus === "Reconcile Review"
      ? state.application_status
      : target.applicationStatus;
    const effectiveStatus = scmScheduleEffectiveReconciliationStatus({
      scheduleStatus: row.status,
      scheduleId: row.scheduleId,
      scheduleUpdatedAt: row.updatedAt,
      reconciliationStatus: state.reconciliation_status,
      reconciliationReconciledAt: state.reconciled_at,
      reconciliationApplicationStatus: currentTargetStatus || state.application_status,
      blockingReview: isReview
    });
    const displayedReason = isReview
      ? state.reconciliation_reason || target.reason || ""
      : "";
    enriched.push({
      ...row,
      status: effectiveStatus,
      reconciliationApplicationStatus: effectiveStatus,
      reconciliationStatus: isReview ? "review" : isPending ? "unreconciled" : "ok",
      reconciliationReason: isPending ? "" : displayedReason,
      lastReconciledAt: state.reconciled_at,
      reconciliation: includeDetails ? {
        status: isReview ? "review" : isPending ? "unreconciled" : "ok",
        reason: isPending ? "" : displayedReason,
        source: state.reconciliation_source || "",
        lastReconciledAt: state.reconciled_at,
        recovered: state.is_recovered === true,
        exactAllocation: target.exactAllocation ?? state.exact_allocation,
        quantities,
        lines: linesByState.get(Number(state.id)) || [],
        allocationTargets: allocationsByState.get(Number(state.id)) || [],
        reviewCases: cases,
        dismissible: cases.length > 0 && cases.every((item) => item.dismissible === true)
      } : undefined
    });
  }
  return enriched;
}

export async function assertScmReconciliationOrderEditable({
  kind = "",
  orderRef = "",
  orderRefs = []
} = {}) {
  const refs = [...new Set([orderRef, ...(Array.isArray(orderRefs) ? orderRefs : [])]
    .map(text)
    .filter(Boolean)
    .map((value) => value.toLowerCase()))];
  if (!refs.length) return true;
  const cleanKind = text(kind).toUpperCase();
  const result = await query(
    `WITH blocked_schedule AS (
       SELECT schedule.order_kind,
              schedule.order_ref,
              schedule.display_ref,
              COALESCE(state.source_order_netsuite_id, schedule.source_id) AS source_order_id
         FROM scm_transport_schedule schedule
         LEFT JOIN scm_reconciliation_order_state state
           ON state.id = schedule.reconciliation_order_state_id
        WHERE schedule.reconciliation_blocked = true
          AND ($2 = '' OR schedule.order_kind = $2)
     )
     SELECT blocked.order_kind, blocked.order_ref
       FROM blocked_schedule blocked
      WHERE lower(blocked.order_ref) = ANY($1::text[])
         OR lower(COALESCE(blocked.display_ref, '')) = ANY($1::text[])
         OR COALESCE(blocked.source_order_id, 0)::text = ANY($1::text[])
         OR (
           blocked.order_kind = 'PO'
           AND EXISTS (
             SELECT 1
               FROM purchase_orders po
              WHERE po.netsuite_id = blocked.source_order_id
                AND (
                  lower(po.tranid) = ANY($1::text[])
                  OR lower(COALESCE(po.dispatch_ref, '')) = ANY($1::text[])
                )
           )
         )
         OR (
           blocked.order_kind = 'TO'
           AND EXISTS (
             SELECT 1
               FROM transfer_orders transfer
              WHERE transfer.netsuite_id = blocked.source_order_id
                AND lower(transfer.tranid) = ANY($1::text[])
           )
         )
     UNION ALL
     SELECT member.order_kind, member.order_ref
       FROM scm_transport_schedule grouped
       JOIN scm_transport_schedule member
         ON lower(member.group_ref) = lower(grouped.order_ref)
        AND member.reconciliation_blocked = true
      WHERE lower(grouped.order_ref) = ANY($1::text[])
        AND ($2 = '' OR member.order_kind = $2)
      LIMIT 1`,
    [refs, ["PO", "TO"].includes(cleanKind) ? cleanKind : ""]
  );
  if (result.rows[0]) {
    throw Object.assign(
      new Error(`${result.rows[0].order_ref} requires NetSuite reconciliation review before it can be changed.`),
      { status: 409, code: "SCM_RECONCILIATION_REVIEW_REQUIRED" }
    );
  }
  return true;
}

function canonicalReconciliationUnit(value) {
  const unit = text(value).toUpperCase().replaceAll(/\s+/g, "");
  if (["EA", "EACH"].includes(unit)) return "EACH";
  if (["PC", "PCS", "PIECE", "PIECES"].includes(unit)) return "PCS";
  return unit;
}

function poLineReceivedQuantity(row = {}, prefix = "") {
  const field = (name) => reconciliationQuantity(row[`${prefix}${name}`]);
  const packed = (field("received_pallet_qty") * field("to_plt"))
    + (field("received_layer_qty") * field("to_lyr"))
    + (field("received_section_qty") * field("to_sec"))
    + (field("received_piece_qty") * field("to_pcs"));
  return roundReconciliationQuantity(Math.max(
    field("netsuite_received_qty"),
    field("received_sales_qty"),
    packed
  ));
}

function poSplitCandidatePreview(ledger, candidate) {
  const requestedQty = reconciliationQuantity(
    ledger.requested_sales_qty ?? ledger.sales_qty
  );
  const orderedQty = reconciliationQuantity(candidate.quantity);
  const linkedSalesQty = reconciliationQuantity(candidate.linked_sales_qty);
  const existingSplitQty = reconciliationQuantity(
    candidate.active_split_requested_qty
  );
  const baselineQty = reconciliationQuantity(
    candidate.netsuite_received_baseline_qty
      ?? candidate.netsuite_received_qty
  );
  const exactReceivedQty = poLineReceivedQuantity(candidate);
  const maximumBaselineQty = roundReconciliationQuantity(Math.max(
    orderedQty - linkedSalesQty - existingSplitQty - requestedQty,
    0
  ));
  const recommendedBaselineQty = roundReconciliationQuantity(Math.min(
    baselineQty,
    maximumBaselineQty
  ));
  const baselineReductionQty = roundReconciliationQuantity(Math.max(
    baselineQty - recommendedBaselineQty,
    0
  ));
  const requestedPackFields = [
    ["requested_pallet_qty", "to_plt"],
    ["requested_layer_qty", "to_lyr"],
    ["requested_section_qty", "to_sec"],
    ["requested_piece_qty", "to_pcs"]
  ];
  const compatiblePack = requestedPackFields.every(([quantityField, conversionField]) => {
    if (reconciliationQuantity(ledger[quantityField]) <= EPSILON) return true;
    return Math.abs(
      reconciliationQuantity(ledger[`old_${conversionField}`])
        - reconciliationQuantity(candidate[conversionField])
    ) <= EPSILON;
  });
  const canFit = (
    orderedQty + EPSILON
      >= linkedSalesQty + existingSplitQty + requestedQty
  );
  const evidenceSufficient = (
    baselineReductionQty <= EPSILON
    || exactReceivedQty + EPSILON >= baselineReductionQty
  );
  return {
    localLineId: Number(candidate.id),
    lineKey: candidate.line_id === null ? "" : String(candidate.line_id),
    itemName: candidate.item_name || "",
    sku: candidate.sku || "",
    unit: candidate.unit || "",
    orderedQty,
    receivedQty: exactReceivedQty,
    baselineQty,
    linkedSalesQty,
    existingSplitQty,
    maximumBaselineQty,
    recommendedBaselineQty,
    baselineReductionQty,
    requiresBaselineReduction: baselineReductionQty > EPSILON,
    canReassign: canFit && compatiblePack && evidenceSufficient
  };
}

async function loadScmPoSplitLineAdjustmentRows(sourceOrderId, {
  lock = false
} = {}) {
  const ledgerResult = await query(
    `SELECT split_line.*,
            split_header.source_po_id,
            split_header.source_po_ref,
            split_header.split_po_id,
            split_header.split_po_ref,
            old_source.line_id AS old_line_key,
            old_source.quantity AS old_ordered_qty,
            old_source.netsuite_received_qty AS old_netsuite_received_qty,
            old_source.received_sales_qty AS old_received_sales_qty,
            old_source.received_pallet_qty AS old_received_pallet_qty,
            old_source.received_layer_qty AS old_received_layer_qty,
            old_source.received_section_qty AS old_received_section_qty,
            old_source.received_piece_qty AS old_received_piece_qty,
            old_source.netsuite_received_baseline_qty AS old_baseline_qty,
            old_source.to_plt AS old_to_plt,
            old_source.to_lyr AS old_to_lyr,
            old_source.to_sec AS old_to_sec,
            old_source.to_pcs AS old_to_pcs,
            child_line.line_id AS child_line_key,
            child_line.raw AS child_raw
       FROM dispatch_scm_po_split_lines split_line
       JOIN dispatch_scm_po_splits split_header
         ON split_header.id = split_line.split_id
        AND split_header.status = 'active'
       JOIN purchase_order_lines old_source
         ON old_source.id = split_line.source_line_id
       JOIN purchase_order_lines child_line
         ON child_line.id = split_line.split_line_id
      WHERE split_header.source_po_id = $1
      ORDER BY split_header.created_at, split_header.id, split_line.id
      ${lock ? "FOR UPDATE OF split_line, split_header, old_source, child_line" : ""}`,
    [Number(sourceOrderId)]
  );
  const candidateResult = await query(
    `SELECT candidate.*,
            COALESCE((
              SELECT SUM(allocation.allocated_sales_qty)
                FROM dispatch_so_po_allocations allocation
               WHERE allocation.po_line_id = candidate.id
                 AND allocation.status = 'active'
            ), 0) AS linked_sales_qty,
            COALESCE((
              SELECT SUM(other_split.requested_sales_qty)
                FROM dispatch_scm_po_split_lines other_split
                JOIN dispatch_scm_po_splits other_header
                  ON other_header.id = other_split.split_id
                 AND other_header.status = 'active'
               WHERE other_split.source_line_id = candidate.id
            ), 0) AS active_split_requested_qty
       FROM purchase_order_lines candidate
      WHERE candidate.purchase_order_id = $1
        AND candidate.netsuite_active = true
        AND candidate.line_id IS NOT NULL
      ORDER BY candidate.line_id, candidate.id
      ${lock ? "FOR UPDATE OF candidate" : ""}`,
    [Number(sourceOrderId)]
  );
  return {
    ledgers: ledgerResult.rows,
    candidates: candidateResult.rows
  };
}

export async function listScmPoSplitLineAdjustmentOptions({
  orderRef = "",
  orderId = null
} = {}) {
  const source = await findScmReconciliationSource({
    kind: "PO",
    orderRef,
    orderId
  });
  if (!source) {
    throw Object.assign(new Error("The source Purchase Order was not found."), {
      status: 404
    });
  }
  const { ledgers, candidates } = await loadScmPoSplitLineAdjustmentRows(
    source.id
  );
  const adjustments = ledgers.map((ledger) => {
    const ledgerUnit = canonicalReconciliationUnit(ledger.unit);
    const compatible = candidates
      .filter((candidate) =>
        Number(candidate.id) !== Number(ledger.source_line_id)
        && Number(candidate.item_id) === Number(ledger.item_id)
        && canonicalReconciliationUnit(candidate.unit) === ledgerUnit
      )
      .map((candidate) => poSplitCandidatePreview(ledger, candidate))
      .filter((candidate) => candidate.canReassign);
    return {
      ledgerLineId: Number(ledger.id),
      targetOrderRef: ledger.split_po_ref,
      targetOrderId: Number(ledger.split_po_id),
      itemName: ledger.item_name || "",
      sku: ledger.sku || "",
      unit: ledger.unit || "",
      requestedQty: reconciliationQuantity(
        ledger.requested_sales_qty ?? ledger.sales_qty
      ),
      currentSource: {
        localLineId: Number(ledger.source_line_id),
        lineKey: ledger.old_line_key === null ? "" : String(ledger.old_line_key),
        orderedQty: reconciliationQuantity(ledger.old_ordered_qty),
        receivedQty: poLineReceivedQuantity(ledger, "old_"),
        baselineQty: reconciliationQuantity(
          ledger.old_baseline_qty ?? ledger.old_netsuite_received_qty
        )
      },
      candidates: compatible
    };
  }).filter((adjustment) => adjustment.candidates.length > 0);
  return {
    order: {
      kind: "PO",
      id: source.id,
      ref: source.tranid
    },
    adjustments
  };
}

export async function reassignScmPoSplitLineSource({
  ledgerLineId,
  expectedSourceLineId,
  newSourceLineId,
  note,
  allowBaselineReduction = false,
  expectedBaselineQty = null,
  actor
} = {}) {
  const ledgerId = positiveId(ledgerLineId);
  const expectedSourceId = positiveId(expectedSourceLineId);
  const candidateId = positiveId(newSourceLineId);
  const cleanNote = text(note);
  const cleanActor = text(actor);
  if (!ledgerId || !expectedSourceId || !candidateId) {
    throw Object.assign(
      new Error("Select a valid split line and source line."),
      { status: 400 }
    );
  }
  if (!cleanActor || !cleanNote) {
    throw Object.assign(
      new Error("An admin identity and audit note are required."),
      { status: 400 }
    );
  }
  if (expectedSourceId === candidateId) {
    throw Object.assign(
      new Error("Select a different NetSuite source line."),
      { status: 400 }
    );
  }

  return withTransaction(async () => {
    const ledgerResult = await query(
      `SELECT split_line.*,
              split_header.source_po_id,
              split_header.source_po_ref,
              split_header.split_po_id,
              split_header.split_po_ref,
              split_header.status AS split_status,
              old_source.line_id AS old_line_key,
              old_source.item_id AS old_item_id,
              old_source.unit AS old_unit,
              old_source.to_plt AS old_to_plt,
              old_source.to_lyr AS old_to_lyr,
              old_source.to_sec AS old_to_sec,
              old_source.to_pcs AS old_to_pcs,
              child_line.line_id AS child_line_key,
              child_line.raw AS child_raw
         FROM dispatch_scm_po_split_lines split_line
         JOIN dispatch_scm_po_splits split_header
           ON split_header.id = split_line.split_id
         JOIN purchase_order_lines old_source
           ON old_source.id = split_line.source_line_id
         JOIN purchase_order_lines child_line
           ON child_line.id = split_line.split_line_id
        WHERE split_line.id = $1
        FOR UPDATE OF split_line, split_header, old_source, child_line`,
      [ledgerId]
    );
    const ledger = ledgerResult.rows[0];
    if (!ledger || ledger.split_status !== "active") {
      throw Object.assign(
        new Error("This active split line no longer exists."),
        { status: 409, code: "SCM_SPLIT_LINE_STALE" }
      );
    }
    if (Number(ledger.source_line_id) !== expectedSourceId) {
      throw Object.assign(
        new Error("The split line source changed. Reload and review it again."),
        { status: 409, code: "SCM_SPLIT_LINE_STALE" }
      );
    }
    await query(
      `SELECT netsuite_id
         FROM purchase_orders
        WHERE netsuite_id = $1
        FOR UPDATE`,
      [Number(ledger.source_po_id)]
    );
    const candidateResult = await query(
      `SELECT candidate.*,
              COALESCE((
                SELECT SUM(allocation.allocated_sales_qty)
                  FROM dispatch_so_po_allocations allocation
                 WHERE allocation.po_line_id = candidate.id
                   AND allocation.status = 'active'
              ), 0) AS linked_sales_qty,
              COALESCE((
                SELECT SUM(other_split.requested_sales_qty)
                  FROM dispatch_scm_po_split_lines other_split
                  JOIN dispatch_scm_po_splits other_header
                    ON other_header.id = other_split.split_id
                   AND other_header.status = 'active'
                 WHERE other_split.source_line_id = candidate.id
                   AND other_split.id <> $2
              ), 0) AS active_split_requested_qty
         FROM purchase_order_lines candidate
        WHERE candidate.id = $1
        FOR UPDATE OF candidate`,
      [candidateId, ledgerId]
    );
    const candidate = candidateResult.rows[0];
    if (
      !candidate
      || Number(candidate.purchase_order_id) !== Number(ledger.source_po_id)
      || candidate.netsuite_active !== true
      || candidate.line_id === null
    ) {
      throw Object.assign(
        new Error("The replacement must be an active line on the same source PO."),
        { status: 409, code: "SCM_SPLIT_LINE_CANDIDATE_INVALID" }
      );
    }
    if (
      Number(candidate.item_id) !== Number(ledger.item_id)
      || canonicalReconciliationUnit(candidate.unit)
        !== canonicalReconciliationUnit(ledger.unit)
    ) {
      throw Object.assign(
        new Error("The replacement line must have the same item and unit."),
        { status: 409, code: "SCM_SPLIT_LINE_CANDIDATE_INCOMPATIBLE" }
      );
    }
    const preview = poSplitCandidatePreview(ledger, candidate);
    if (!preview.canReassign) {
      throw Object.assign(
        new Error("The replacement line lacks compatible capacity or exact receipt evidence."),
        { status: 409, code: "SCM_SPLIT_LINE_CAPACITY_EXCEEDED" }
      );
    }
    const duplicateChild = await query(
      `SELECT other.id
         FROM dispatch_scm_po_split_lines other
         JOIN purchase_order_lines other_child
           ON other_child.id = other.split_line_id
        WHERE other.split_id = $1
          AND other.id <> $2
          AND other_child.line_id = $3
        LIMIT 1`,
      [Number(ledger.split_id), ledgerId, candidate.line_id]
    );
    if (duplicateChild.rows[0]) {
      throw Object.assign(
        new Error("This split already contains a child for the replacement NetSuite line."),
        { status: 409, code: "SCM_SPLIT_LINE_DUPLICATE_CHILD" }
      );
    }
    const pinned = await query(
      `SELECT allocation.id
         FROM scm_reconciliation_allocations allocation
         JOIN scm_reconciliation_order_line_state line_state
           ON line_state.id = allocation.order_line_state_id
         JOIN scm_reconciliation_order_state order_state
           ON order_state.id = line_state.order_state_id
        WHERE allocation.active = true
          AND allocation.allocation_method = 'pinned'
          AND order_state.order_kind = 'PO'
          AND order_state.source_order_netsuite_id = $1
          AND (
            allocation.po_split_line_id = $2
            OR line_state.local_line_id IN ($3, $4)
          )
        LIMIT 1
        FOR UPDATE OF allocation`,
      [
        Number(ledger.source_po_id),
        ledgerId,
        expectedSourceId,
        candidateId
      ]
    );
    if (pinned.rows[0]) {
      throw Object.assign(
        new Error("Remove the pinned reconciliation allocation before changing this source line."),
        { status: 409, code: "SCM_SPLIT_LINE_PINNED" }
      );
    }
    const currentBaseline = reconciliationQuantity(
      candidate.netsuite_received_baseline_qty
        ?? candidate.netsuite_received_qty
    );
    if (preview.requiresBaselineReduction) {
      const expectedBaseline = Number(expectedBaselineQty);
      if (
        allowBaselineReduction !== true
        || !Number.isFinite(expectedBaseline)
        || Math.abs(currentBaseline - expectedBaseline) > EPSILON
      ) {
        throw Object.assign(
          new Error(
            `Confirm reducing the replacement line baseline from ${currentBaseline} `
            + `to ${preview.recommendedBaselineQty}.`
          ),
          {
            status: 409,
            code: "SCM_SPLIT_LINE_BASELINE_CONFIRMATION_REQUIRED"
          }
        );
      }
    }

    const before = {
      sourceLocalLineId: Number(ledger.source_line_id),
      sourceLineKey: ledger.old_line_key === null
        ? ""
        : String(ledger.old_line_key),
      childLineKey: ledger.child_line_key === null
        ? ""
        : String(ledger.child_line_key),
      candidateBaselineQty: currentBaseline
    };
    const childAdjustment = {
      actor: cleanActor,
      note: cleanNote,
      adjustedAt: new Date().toISOString(),
      previousSourceLineId: String(ledger.source_line_id),
      previousLineKey: before.sourceLineKey,
      sourceLineId: String(candidate.id),
      lineKey: String(candidate.line_id)
    };
    await query(
      `UPDATE dispatch_scm_po_split_lines
          SET source_line_id = $2,
              item_id = $3,
              sku = NULLIF($4, ''),
              item_name = NULLIF($5, ''),
              unit = NULLIF($6, ''),
              pallet_qty = requested_pallet_qty,
              layer_qty = requested_layer_qty,
              section_qty = requested_section_qty,
              piece_qty = requested_piece_qty,
              sales_qty = requested_sales_qty
        WHERE id = $1`,
      [
        ledgerId,
        candidate.id,
        candidate.item_id,
        text(candidate.sku),
        text(candidate.item_name),
        text(candidate.unit)
      ]
    );
    await query(
      `UPDATE purchase_order_lines
          SET line_id = $2,
              item_id = $3,
              item_name = NULLIF($4, ''),
              sku = NULLIF($5, ''),
              unit = NULLIF($6, ''),
              to_plt = $7,
              to_lyr = $8,
              to_sec = $9,
              to_pcs = $10,
              quantity = $11,
              pallet_qty = $12,
              layer_qty = $13,
              section_qty = $14,
              piece_qty = $15,
              netsuite_active = true,
              raw = jsonb_set(
                jsonb_set(
                  COALESCE(raw, '{}'::jsonb),
                  '{sourceLineId}',
                  to_jsonb($16::text),
                  true
                ),
                '{manualSourceLineAdjustment}',
                $17::jsonb,
                true
              ),
              synced_at = now()
        WHERE id = $1`,
      [
        Number(ledger.split_line_id),
        candidate.line_id,
        candidate.item_id,
        text(candidate.item_name),
        text(candidate.sku),
        text(candidate.unit),
        reconciliationQuantity(candidate.to_plt),
        reconciliationQuantity(candidate.to_lyr),
        reconciliationQuantity(candidate.to_sec),
        reconciliationQuantity(candidate.to_pcs),
        reconciliationQuantity(ledger.requested_sales_qty ?? ledger.sales_qty),
        reconciliationQuantity(ledger.requested_pallet_qty),
        reconciliationQuantity(ledger.requested_layer_qty),
        reconciliationQuantity(ledger.requested_section_qty),
        reconciliationQuantity(ledger.requested_piece_qty),
        String(candidate.id),
        JSON.stringify(childAdjustment)
      ]
    );
    if (preview.requiresBaselineReduction) {
      await query(
        `UPDATE purchase_order_lines
            SET netsuite_received_baseline_qty = $2,
                synced_at = now()
          WHERE id = $1`,
        [candidate.id, preview.recommendedBaselineQty]
      );
    }
    const deactivated = await query(
      `UPDATE scm_reconciliation_allocations allocation
          SET active = false,
              updated_at = now()
         FROM scm_reconciliation_order_line_state line_state,
              scm_reconciliation_order_state order_state
        WHERE line_state.id = allocation.order_line_state_id
          AND order_state.id = line_state.order_state_id
          AND order_state.order_kind = 'PO'
          AND order_state.source_order_netsuite_id = $1
          AND line_state.local_line_id IN ($2, $3)
          AND allocation.active = true
          AND allocation.allocation_method <> 'pinned'
      RETURNING allocation.id`,
      [Number(ledger.source_po_id), expectedSourceId, candidateId]
    );
    const stateResult = await query(
      `UPDATE scm_reconciliation_order_state
          SET reconciliation_status = 'pending',
              reconciliation_reason = 'Admin changed a PO split source line; targeted reconciliation is pending.',
              exact_allocation = false,
              reconciled_at = NULL,
              updated_at = now()
        WHERE order_kind = 'PO'
          AND source_order_netsuite_id = $1
      RETURNING id`,
      [Number(ledger.source_po_id)]
    );
    const stateId = stateResult.rows[0]?.id || null;
    const familyRefs = await query(
      `SELECT split_po_ref
         FROM dispatch_scm_po_splits
        WHERE source_po_id = $1
          AND status = 'active'`,
      [Number(ledger.source_po_id)]
    );
    const blockedRefs = [
      ledger.source_po_ref,
      ...familyRefs.rows.map((row) => row.split_po_ref)
    ].map((value) => text(value).toLowerCase()).filter(Boolean);
    await query(
      `UPDATE scm_transport_schedule
          SET status = 'Reconcile Review',
              reconciliation_blocked = true,
              reconciliation_order_state_id = COALESCE($2, reconciliation_order_state_id),
              updated_by = $3,
              updated_at = now()
        WHERE order_kind = 'PO'
          AND (
            source_id = $1
            OR lower(order_ref) = ANY($4::text[])
          )`,
      [
        Number(ledger.source_po_id),
        stateId,
        cleanActor,
        blockedRefs
      ]
    );
    const after = {
      sourceLocalLineId: Number(candidate.id),
      sourceLineKey: String(candidate.line_id),
      childLineKey: String(candidate.line_id),
      candidateBaselineQty: preview.recommendedBaselineQty
    };
    const audit = await insertReconciliationAuditEvent({
      eventKey: `manual:po-split-source-reassigned:${ledgerId}:${crypto.randomUUID()}`,
      source: "manual",
      eventType: "split_line.source_reassigned",
      recordType: "PO",
      action: "reassign_source_line",
      parentOrderKind: "PO",
      parentOrderId: Number(ledger.source_po_id),
      parentOrderRef: ledger.source_po_ref,
      payload: {
        ledgerLineId: ledgerId,
        splitOrderRef: ledger.split_po_ref,
        requestedQty: reconciliationQuantity(
          ledger.requested_sales_qty ?? ledger.sales_qty
        ),
        before,
        after,
        capacity: preview,
        deactivatedAllocationIds: deactivated.rows.map((row) => Number(row.id)),
        note: cleanNote
      },
      actor: cleanActor
    });
    return {
      ok: true,
      orderKind: "PO",
      sourceOrderId: Number(ledger.source_po_id),
      sourceOrderRef: ledger.source_po_ref,
      targetOrderRef: ledger.split_po_ref,
      ledgerLineId: ledgerId,
      before,
      after,
      auditEventId: Number(audit.event.id),
      pendingReconciliation: true
    };
  });
}

export async function resolveScmReconciliationReview({
  kind,
  orderRef,
  resolution,
  note,
  allocations = [],
  actor,
  actorRole = "admin",
  reviewCode = ""
} = {}) {
  const cleanActor = text(actor);
  const cleanNote = text(note);
  const cleanResolution = text(resolution);
  const cleanReviewCode = text(reviewCode);
  if (!cleanActor || !cleanNote) {
    throw Object.assign(new Error("An admin and audit note are required."), { status: 400 });
  }
  const action = cleanResolution === "accept_current"
    ? "accept"
    : cleanResolution === "dismiss_info"
      ? "dismiss"
      : cleanResolution === "allocate"
        ? "allocate"
        : "";
  if (!action) throw Object.assign(new Error("Select a valid reconciliation resolution."), { status: 400 });
  const source = await findScmReconciliationSource({ kind, orderRef });
  if (!source) throw Object.assign(new Error("The PO/TO source order was not found."), { status: 404 });

  return withTransaction(async () => {
    const stateResult = await query(
      `SELECT *
         FROM scm_reconciliation_order_state
        WHERE order_kind = $1
          AND source_order_netsuite_id = $2
        FOR UPDATE`,
      [source.kind, source.id]
    );
    const state = stateResult.rows[0];
    if (!state) throw Object.assign(new Error("This order has no reconciliation state."), { status: 404 });
    const caseResult = await query(
      `SELECT *
         FROM scm_reconciliation_review_cases
        WHERE order_state_id = $1
          AND status = 'open'
          AND ($2 = '' OR review_code = $2)
        ORDER BY severity = 'blocking' DESC, first_detected_at, id
        LIMIT 1
        FOR UPDATE`,
      [state.id, cleanReviewCode]
    );
    const review = caseResult.rows[0];
    if (!review) throw Object.assign(new Error("This reconciliation review is no longer open."), { status: 409 });
    if (review.review_code === "source_missing" && action === "accept") {
      throw Object.assign(
        new Error(
          "A source-missing Purchase Order must be retried or use the controlled NetSuite verification and local-cancellation action."
        ),
        {
          status: 409,
          code: "SCM_RECONCILIATION_SOURCE_MISSING_CONTROLLED_ACTION_REQUIRED"
        }
      );
    }
    if (action === "dismiss" && review.dismissible !== true) {
      throw Object.assign(new Error("A blocking reconciliation review cannot be dismissed."), { status: 409 });
    }
    const requested = Array.isArray(allocations) ? allocations : [];
    if (action === "allocate" && !requested.length) {
      throw Object.assign(new Error("Enter at least one split allocation."), { status: 400 });
    }
    const audit = await insertReconciliationAuditEvent({
      eventKey: `manual:resolution:${crypto.randomUUID()}`,
      source: "manual",
      eventType: "review.resolution",
      recordType: source.kind,
      action,
      parentOrderKind: source.kind,
      parentOrderId: source.id,
      parentOrderRef: source.tranid,
      payload: { resolution: cleanResolution, note: cleanNote, allocations: requested },
      actor: cleanActor
    });
    const resolutionResult = await query(
      `INSERT INTO scm_reconciliation_review_resolutions (
         review_case_id, action, actor, actor_role, note, details, audit_event_id
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING *`,
      [
        review.id,
        action,
        cleanActor,
        text(actorRole) || "admin",
        cleanNote,
        JSON.stringify({ orderKind: source.kind, orderRef, allocations: requested }),
        audit.event.id
      ]
    );
    const resolutionRow = resolutionResult.rows[0];
    if (action === "allocate") {
      const lineStates = await query(
        `SELECT *
           FROM scm_reconciliation_order_line_state
          WHERE order_state_id = $1
            AND netsuite_active = true`,
        [state.id]
      );
      const byLineKey = new Map(lineStates.rows.map((line) => [text(line.netsuite_line_key), line]));
      const parentRefs = new Set([
        source.tranid,
        state.source_order_ref,
        state.order_snapshot?.scheduleRef,
        state.order_snapshot?.schedule_ref,
        state.quantity_summary?.family?.orderRef
      ].map((value) => text(value).toLowerCase()).filter(Boolean));
      const sums = new Map();
      for (const allocation of requested) {
        const lineKey = text(allocation.lineKey ?? allocation.line_key);
        const splitRef = text(allocation.splitRef ?? allocation.targetOrderRef ?? allocation.target_order_ref);
        const rawQuantity = Number(String(allocation.quantity ?? "").replaceAll(",", ""));
        const quantity = roundReconciliationQuantity(rawQuantity);
        const line = byLineKey.get(lineKey);
        if (!line || !splitRef || !Number.isFinite(rawQuantity) || rawQuantity <= 0) {
          throw Object.assign(new Error("Every manual allocation must identify a valid line and split with a quantity above zero."), { status: 400 });
        }
        const requestedProgressKind = text(
          allocation.progressKind ?? allocation.progress_kind
        ).toLowerCase();
        const progressKind = source.kind === "PO" ? "received" : requestedProgressKind;
        if (
          (source.kind === "PO" && requestedProgressKind && requestedProgressKind !== "received")
          || (source.kind === "TO" && !["fulfilled", "received"].includes(progressKind))
        ) {
          throw Object.assign(
            new Error(`Select whether ${lineKey} allocates fulfilled or received quantity.`),
            { status: 400 }
          );
        }
        const available = progressKind === "received"
          ? reconciliationQuantity(line.received_qty)
          : reconciliationQuantity(line.fulfilled_qty);
        const sumKey = `${line.id}:${progressKind}`;
        sums.set(sumKey, roundReconciliationQuantity((sums.get(sumKey) || 0) + quantity));
        if (sums.get(sumKey) > available + EPSILON) {
          throw Object.assign(new Error(`Pinned allocation exceeds ${lineKey} ${progressKind} quantity.`), { status: 400 });
        }
        let targetKind = "source_residual";
        let ledgerLineId = null;
        if (source.kind === "PO" && !parentRefs.has(splitRef.toLowerCase())) {
          const ledger = await query(
            `SELECT split_line.id, split_line.requested_sales_qty
               FROM dispatch_scm_po_split_lines split_line
               JOIN dispatch_scm_po_splits split ON split.id = split_line.split_id
              WHERE split_line.source_line_id = $1
                AND lower(split.split_po_ref) = lower($2)
                AND split.status = 'active'
              LIMIT 1`,
            [line.local_line_id, splitRef]
          );
          if (!ledger.rows[0] || quantity > reconciliationQuantity(ledger.rows[0].requested_sales_qty) + EPSILON) {
            throw Object.assign(new Error(`Allocation target ${splitRef} is invalid or above its requested quantity.`), { status: 400 });
          }
          targetKind = "po_split";
          ledgerLineId = Number(ledger.rows[0].id);
        } else if (source.kind === "TO" && !parentRefs.has(splitRef.toLowerCase())) {
          const ledger = await query(
            `SELECT split_line.id, split_line.requested_sales_qty
               FROM dispatch_scm_to_split_lines split_line
              JOIN dispatch_scm_to_splits split ON split.id = split_line.split_id
              WHERE split_line.source_line_id = $1
                AND split_line.source_line_stage = $3
                AND lower(split.split_to_ref) = lower($2)
                AND split.status = 'active'
              LIMIT 1`,
            [line.local_line_id, splitRef, line.local_line_stage || "outbound"]
          );
          if (!ledger.rows[0] || quantity > reconciliationQuantity(ledger.rows[0].requested_sales_qty) + EPSILON) {
            throw Object.assign(new Error(`Allocation target ${splitRef} is invalid or above its requested quantity.`), { status: 400 });
          }
          targetKind = "to_split";
          ledgerLineId = Number(ledger.rows[0].id);
        }
        const allocationKey = [
          line.id,
          progressKind,
          targetKind,
          ledgerLineId || splitRef
        ].join(":");
        await query(
          `INSERT INTO scm_reconciliation_allocations (
             allocation_key, order_line_state_id, progress_kind, target_kind,
             po_split_line_id, to_split_line_id, target_order_ref,
             target_line_ref, quantity, allocation_method, pin_resolution_id,
             pinned_by, pinned_at, pin_note, active, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4,
             CASE WHEN $4 = 'po_split' THEN $5::bigint ELSE NULL::bigint END,
             CASE WHEN $4 = 'to_split' THEN $5::bigint ELSE NULL::bigint END,
             $6, $7, $8, 'pinned', $9,
             $10, now(), $11, true, now(), now()
           )
           ON CONFLICT (allocation_key) DO UPDATE SET
             quantity = EXCLUDED.quantity,
             allocation_method = 'pinned',
             pin_resolution_id = EXCLUDED.pin_resolution_id,
             pinned_by = EXCLUDED.pinned_by,
             pinned_at = now(),
             pin_note = EXCLUDED.pin_note,
             active = true,
             updated_at = now()`,
          [
            allocationKey,
            line.id,
            progressKind,
            targetKind,
            ledgerLineId,
            splitRef,
            lineKey,
            quantity,
            resolutionRow.id,
            cleanActor,
            cleanNote
          ]
        );
      }
    }
    await query(
      `UPDATE scm_reconciliation_review_cases
          SET status = $2,
              resolved_at = now(),
              resolved_by = $3,
              resolution_action = $4,
              resolution_note = $5,
              updated_at = now()
        WHERE id = $1`,
      [review.id, action === "dismiss" ? "dismissed" : "resolved", cleanActor, action, cleanNote]
    );
    const remainingCases = await query(
      `SELECT COUNT(*)::int AS count
         FROM scm_reconciliation_review_cases
        WHERE order_state_id = $1
          AND status = 'open'`,
      [state.id]
    );
    if (action !== "allocate" && Number(remainingCases.rows[0]?.count || 0) === 0) {
      const quantitySummary = state.quantity_summary
        && typeof state.quantity_summary === "object"
        ? structuredClone(state.quantity_summary)
        : {};
      const acceptedTargets = quantitySummary.targets
        && typeof quantitySummary.targets === "object"
        ? quantitySummary.targets
        : {};
      for (const [targetRef, target] of Object.entries(acceptedTargets)) {
        const ordered = reconciliationQuantity(target.ordered);
        const fulfilled = reconciliationQuantity(target.fulfilled);
        const received = reconciliationQuantity(target.received);
        const derived = derivePoToReconciliationState({
          kind: source.kind,
          statusText: state.netsuite_status_text,
          orderedQty: ordered,
          fulfilledQty: fulfilled,
          receivedQty: received,
          previousStatus: state.application_status || "Queued",
          previousReceivedQty: received,
          hasActivePlan: target.hasActivePlan === true,
          hasOperationalActivity: fulfilled > EPSILON || received > EPSILON
        });
        target.applicationStatus = target.hidden === true
          ? "Cancelled"
          : derived.applicationStatus;
        target.reconciliationStatus = derived.reconciliationStatus;
        target.reason = derived.reason || "";
        target.abandoned = derived.quantities.abandoned;
        target.remaining = derived.quantities.remaining;
        target.destinationRemaining = derived.quantities.destinationRemaining;
        await query(
          `UPDATE scm_transport_schedule
              SET reconciliation_blocked = false,
                  status = $3,
                  updated_by = $4,
                  updated_at = now()
            WHERE reconciliation_order_state_id = $1
              AND lower(order_ref) = lower($2)`,
          [state.id, target.orderRef || targetRef, target.applicationStatus, cleanActor]
        );
      }
      quantitySummary.targets = acceptedTargets;
      const proposedState = state.proposed_state
        && typeof state.proposed_state === "object"
        ? structuredClone(state.proposed_state)
        : {};
      proposedState.applicationStatus = state.application_status;
      proposedState.reconciliationStatus = "current";
      proposedState.reason = "";
      proposedState.targets = acceptedTargets;
      await query(
        `UPDATE scm_reconciliation_order_state
            SET reconciliation_status = 'current',
                reconciliation_reason = null,
                quantity_summary = $2::jsonb,
                proposed_state = $3::jsonb,
                updated_at = now()
          WHERE id = $1`,
        [
          state.id,
          JSON.stringify(quantitySummary),
          JSON.stringify(proposedState)
        ]
      );
      await query(
        `UPDATE scm_transport_schedule
            SET reconciliation_blocked = false,
                status = CASE WHEN status = 'Reconcile Review' THEN $2 ELSE status END,
                updated_by = $3,
                updated_at = now()
          WHERE reconciliation_order_state_id = $1`,
        [state.id, state.application_status, cleanActor]
      );
    }
    return {
      ok: true,
      action,
      orderKind: source.kind,
      sourceOrderId: source.id,
      sourceOrderRef: source.tranid,
      resolutionId: Number(resolutionRow.id),
      rerunRequired: action === "allocate",
      remainingOpenCases: Number(remainingCases.rows[0]?.count || 0)
    };
  });
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [server, service, repository, control, schedule, scopeMigration, safeStopMigration] = await Promise.all([
  "server.js",
  "scm-reconciliation-service.js",
  "scm-reconciliation-repository.js",
  "../public/control.js",
  "../public/scm-schedule.js",
  "../migrations/080_scm_reconciliation_scope_controls.sql",
  "../migrations/081_scm_reconciliation_safe_stop.sql"
].map((file) => readFile(new URL(file, import.meta.url), "utf8")));

function includesAll(source, values, label) {
  for (const value of values) {
    assert.ok(source.includes(value), `${label} is missing: ${value}`);
  }
}

includesAll(server, [
  'app.post("/api/webhooks/netsuite/if-ir"',
  "verifyScmIfIrWebhookSignature",
  "storeScmIfIrWebhook",
  "processScmIfIrWebhookResult",
  "res.status(202)",
  "operationalSyncRunning: anyNetSuiteSyncRunning"
], "signed prompt IF/IR webhook");

includesAll(server, [
  'app.post("/api/control/scm-reconciliation/run"',
  'app.post("/api/control/scm-reconciliation/runs/:id/apply"',
  'app.post("/api/scm/reconciliation/retry"',
  'app.post("/api/scm/reconciliation/close-missing-po"',
  'app.get("/api/scm/reconciliation/po-split-line-options"',
  'app.post("/api/scm/reconciliation/po-split-lines/:ledgerLineId/reassign"',
  'app.post("/api/scm/reconciliation/resolve"',
  'app.get("/api/scm/reconciliation/runs/:id"'
], "manual reconciliation APIs");

includesAll(server, [
  "listScmPoSplitLineAdjustmentOptions",
  "reassignScmPoSplitLineSource",
  "expectedSourceLineId: req.body?.expectedSourceLineId",
  "allowBaselineReduction: req.body?.allowBaselineReduction === true",
  "includeTerminalOrders: true",
  "allowInitialApply: true",
  "rerunError"
], "admin split-source correction API and targeted rerun");

includesAll(repository, [
  "export async function listScmPoSplitLineAdjustmentOptions",
  "export async function reassignScmPoSplitLineSource",
  "SCM_SPLIT_LINE_PINNED",
  "SCM_SPLIT_LINE_BASELINE_CONFIRMATION_REQUIRED",
  "split_line.source_reassigned",
  "manualSourceLineAdjustment"
], "auditable PO split-source correction repository");

includesAll(server, [
  "targetOrderRef: req.body?.orderRef ?? req.body?.targetOrderRef",
  "targetOrderRefs: req.body?.orderRefs ?? req.body?.targetOrderRefs",
  "const targetedScope = /^order[_ -]?family$/i.test(requestedScope)",
  "includeTerminalOrders: targetedScope",
  "req.body?.includeTerminalOrders ?? req.body?.include_terminal_orders",
  '"/api/control/scm-reconciliation/runs/:id/stop"',
  '"/api/control/scm-reconciliation/runs/:id/resume"',
  "cancelScmReconciliationRun(",
  "resumeScmReconciliationRun(",
  'source: "scm-reconciliation-stop"'
], "multi-family, terminal-order override, and run-stop API");

includesAll(service, [
  "SCM_RECONCILIATION_LINKED_BATCH_SIZE = 15",
  "fetchScmReconciliationLinkedTransactionsInBatches",
  "NETSUITE_REQUEST_TIMEOUT",
  "SCM_RECONCILIATION_LINKED_TIMEOUT",
  "onAttempt:",
  "onBatch:",
  "reconcileFetchedOrder(",
  "listScmReconciliationRunTargetsForResume",
  "export async function resumeScmReconciliationRun"
], "bounded linked-evidence retries and durable run resume");

includesAll(repository, [
  "resumeAllowed",
  "export async function queueScmReconciliationRunResume",
  "resumeRequestedAt",
  "run.resume_requested",
  "Only an interrupted run, or a legacy global failure",
  "status = 'pending'"
], "audited unfinished-target resume ledger");

includesAll(control, [
  "scmReconciliationRunCanResume",
  "Resume remaining orders",
  "resumeScmReconciliationRun",
  "/resume",
  "Only unfinished orders will continue",
  "linkedBatchAttempt",
  "retrying after timeout"
], "Admin resume and retry progress controls");

const resumeRouteStart = server.indexOf(
  'app.post(\n  "/api/control/scm-reconciliation/runs/:id/resume"'
);
const resumeRouteEnd = server.indexOf(
  'app.post("/api/control/scm-reconciliation/runs/:id/apply"',
  resumeRouteStart
);
assert.ok(
  resumeRouteStart >= 0 && resumeRouteEnd > resumeRouteStart,
  "The dedicated reconciliation resume endpoint is missing."
);
const resumeRoute = server.slice(resumeRouteStart, resumeRouteEnd);
includesAll(resumeRoute, [
  "requireOperator",
  "requireAdmin",
  "resumeScmReconciliationRun(",
  "req.params.id",
  "req.operator?.id",
  "background: true",
  "operationalSyncRunning: anyNetSuiteSyncRunning",
  'source: "scm-reconciliation-resume"',
  "res.status(202).json({ started: true, run })"
], "admin-only asynchronous reconciliation resume endpoint");

const queueResumeStart = repository.indexOf(
  "export async function queueScmReconciliationRunResume"
);
const queueResumeEnd = repository.indexOf(
  "export async function createScmReconciliationRun",
  queueResumeStart
);
assert.ok(
  queueResumeStart >= 0 && queueResumeEnd > queueResumeStart,
  "The durable run-resume transaction is missing."
);
const queueResume = repository.slice(queueResumeStart, queueResumeEnd);
includesAll(queueResume, [
  "failed_target_count",
  'row.status === "failed"',
  'text(row.checkpoint?.phase).toLowerCase() !== "complete"',
  "Number(row.failed_target_count || 0) === 0",
  'row.status !== "interrupted" && !legacyGlobalFailure',
  "SCM_RECONCILIATION_NOT_RESUMABLE",
  "id <> $1",
  "status IN ('queued', 'running')",
  "SCM_RECONCILIATION_ALREADY_ACTIVE",
  "status = 'running'",
  "status = 'failed'",
  "error = 'The reconciliation worker stopped before this target completed.'",
  "SET status = 'pending'",
  "error = NULL",
  "completed_at = NULL",
  "SET status = 'queued'",
  "heartbeat_at = NULL",
  "resumeRequestedAt",
  "resumeCount",
  'eventType: "run.resume_requested"'
], "resume eligibility, stale-target reset, and audit semantics");
assert.ok(
  !queueResume.includes("status IN ('failed', 'running')"),
  "Resume must not broadly reset genuine per-order failures."
);
assert.match(
  queueResume,
  /status = 'running'\s+OR\s+\(\s*status = 'failed'\s+AND error = 'The reconciliation worker stopped before this target completed\.'/,
  "Only an in-flight target or the legacy stale-worker marker may return to pending."
);
assert.match(
  queueResume,
  /SET status = 'pending',\s+error = NULL,\s+completed_at = NULL/,
  "A reset stale target must clear its stale completion/error state before retry."
);

const executeResumeStart = service.indexOf(
  "const resumeRequested = run.checkpoint?.resumeRequested === true;"
);
const executeResumeEnd = service.indexOf(
  "const stopRunHeartbeat = startRunHeartbeat(run.id, workerLeaseToken);",
  executeResumeStart
);
assert.ok(
  executeResumeStart >= 0 && executeResumeEnd > executeResumeStart,
  "The worker's resume target partition is missing."
);
const executeResume = service.slice(executeResumeStart, executeResumeEnd);
includesAll(executeResume, [
  "listScmReconciliationRunTargetsForResume(run.id)",
  'new Set(["succeeded", "review", "skipped"])',
  'text(target.status).toLowerCase() === "failed"',
  '["pending", "running"].includes(text(target.status).toLowerCase())',
  "processed: completedTargets.length + failedTargets.length",
  "total: reusableTargets.length",
  "targetManifestComplete",
  "targetManifestCount"
], "resume target partition and saved-progress accounting");
assert.ok(
  !executeResume.includes("completedTargets.map"),
  "Terminal target rows must be counted as progress, not queued for reprocessing."
);

const resumeServiceStart = service.indexOf(
  "export async function resumeScmReconciliationRun"
);
const resumeServiceEnd = service.indexOf(
  "export async function applyScmReconciliationRun",
  resumeServiceStart
);
assert.ok(
  resumeServiceStart >= 0 && resumeServiceEnd > resumeServiceStart,
  "The reconciliation resume service entry point is missing."
);
const resumeService = service.slice(resumeServiceStart, resumeServiceEnd);
includesAll(resumeService, [
  "queueScmReconciliationRunResume(runId, actor)",
  'run.status === "queued"',
  "executeScmReconciliationRun(",
  "executionOptions"
], "same-run resume execution");
assert.ok(
  !resumeService.includes("createScmReconciliationRun("),
  "Resume must continue the same durable run instead of creating a duplicate run."
);

includesAll(service, [
  "export function normalizeScmReconciliationTargetRefs",
  "const MAX_TARGET_ORDER_REFS = 100",
  "const MAX_TARGET_ORDER_REF_LENGTH = 64",
  ".split(/[\\r\\n,]+/)",
  "input.targetOrderRefs ?? input.orderRefs",
  "input.targetOrderRef ?? input.orderRef",
  "includeTerminalOrders,",
  "listScmReconciliationBroadExcludedSources",
  "run.includeTerminalOrders"
], "target-reference normalization and broad-run filtering");

includesAll(repository, [
  "includeTerminalOrders: row.include_terminal_orders === true",
  "apply_unambiguous, include_terminal_orders, status, requested_by",
  "bool(includeTerminalOrders)",
  "export async function listScmReconciliationBroadExcludedSources",
  "state.broad_reconciliation_skipped = true",
  "state.application_status IN ('Completed', 'Cancelled', 'Hold')",
  "schedule.status IN ('Completed', 'Cancelled', 'Hold')",
  "export async function cancelScmReconciliationRun",
  "cancel_requested_at",
  "stopRequested: !queued",
  "status IN ('pending', 'running')",
  'eventType: queued ? "run.stopped" : "run.stop_requested"'
], "persisted broad-scope controls and safe cancellation");

includesAll(scopeMigration, [
  "include_terminal_orders boolean NOT NULL DEFAULT false",
  "broad_reconciliation_skipped boolean NOT NULL DEFAULT false",
  "idx_scm_reconciliation_order_state_broad_skip",
  "latest.review_decision = 'skip'"
], "scope-control migration");

includesAll(safeStopMigration, [
  "cancel_requested_at timestamptz",
  "idx_scm_reconciliation_runs_cancel_requested",
  "INSERT INTO scm_reconciliation_order_state",
  "ON CONFLICT (order_kind, source_order_netsuite_id) DO UPDATE"
], "safe-stop and durable Skip migration");

includesAll(service, [
  "assertScmReconciliationMutationAllowed",
  "FOR SHARE",
  "SCM_RECONCILIATION_CANCEL_REQUESTED",
  "current.cancelRequestedAt"
], "worker-acknowledged cancellation safety");

includesAll(server, [
  'app.post("/api/scm/reconciliation/close-missing-po"',
  'operatorHasAnyRole(req.operator, ["admin"])',
  "cancelMissingScmPurchaseOrder",
  "reviewCaseId: req.body?.reviewCaseId",
  "expectedLastDetectedAt: req.body?.expectedLastDetectedAt",
  "confirmed: req.body?.confirm === true",
  "operationalSyncRunning: anyNetSuiteSyncRunning",
  "scm-reconciliation-cancel-missing-po"
], "admin-only controlled missing-PO cancellation API");

includesAll(service, [
  "export async function verifyMissingScmPurchaseOrderInNetSuite",
  "fetchPoToReconciliationOrdersFromNetSuite",
  "fetchTransactionStatusFromNetSuite",
  "fetchTransactionReferenceByTranidFromNetSuite",
  "lineQueryFound",
  "headerQueryFound",
  "referenceQueryFound",
  "SCM_RECONCILIATION_SOURCE_VISIBLE",
  "export async function cancelMissingScmPurchaseOrder",
  "confirmed !== true",
  "cancelMissingScmPurchaseOrderLocally"
], "fresh NetSuite verification before local missing-PO cancellation");

includesAll(repository, [
  "export async function cancelMissingScmPurchaseOrderLocally",
  "review_code = 'source_missing'",
  "date_trunc('milliseconds', last_detected_at)",
  "missing_success_count",
  "dispatch_scm_po_splits",
  "scm_schedule_group_members",
  "receiving_receipt_records",
  "scm_reconciliation_transaction_snapshots",
  "operational_schedule_count",
  "progressed_line_count",
  "SCM_RECONCILIATION_MISSING_PO_HAS_ACTIVITY",
  'action: "cancel_missing"',
  "netsuite_terminal_state = 'deleted'",
  "application_status = 'Cancelled'",
  "netsuite_active = false"
], "transactional guarded source-missing PO cancellation");

includesAll(repository, [
  "po.netsuite_active = false",
  "state.netsuite_terminal_state = 'deleted'",
  "state.reconciliation_status = 'current'",
  "state.application_status = 'Cancelled'"
], "broad reconciliation suppression for accepted deleted POs");

includesAll(server, [
  '"/api/control/scm-reconciliation/runs/:runId/targets/:targetId/decision"',
  "requireOperator",
  "requireAdmin",
  "updateScmReconciliationRunTargetDecision",
  "expectedUpdatedAt: req.body?.expectedUpdatedAt ?? req.body?.expected_updated_at",
  "actor: req.operator?.id"
], "admin dry-run review decision API");

includesAll(server, [
  "getScmReconciliationRunDetails",
  "limit: req.query.limit",
  "offset: req.query.offset"
], "paginated order-by-order dry-run review API");

includesAll(server, [
  "recoverStaleScmReconciliationRuns",
  "scmReconciliationScheduledTick",
  "scmReconciliationNightlyTick",
  "setInterval(() => void scmReconciliationScheduledTick(), 60000)"
], "nightly scheduling and stale-run recovery");

includesAll(server, [
  "dispatchPlacedScmRefs(planForConfirm)",
  "listScmPurchaseOrdersForResponse",
  "canSeeReconciliationDetails && reconciliationPreference.showDetails",
  "filterRestrictedScmOrders(reconciled"
], "review enforcement and reconciled schedule metadata");

includesAll(service, [
  "export async function applyScmReconciliationRun",
  "options.background === true",
  "pending: true",
  "allowInitialApply: true",
  "targetOrderKind: proposalRun.targetOrderKind",
  "targetOrderId: proposalRun.targetOrderId",
  "targetOrderRef: proposalRun.targetOrderRef",
  "await approveInitialScmReconciliationRun(runId, actor)"
], "truthful scoped dry-run apply execution");

includesAll(service, [
  "await assertScmReconciliationRunReadyToApply(proposalRun.id)",
  "listScmReconciliationRunTargetDecisions(run.resumeOfRunId)",
  'reviewDecision?.reviewDecision === "skip"',
  "local order data was not changed",
  'reviewDecision?.reviewDecision === "accept_current"',
  "scmReconciliationReviewFingerprint(preflight, {",
  "decisionEvidenceChanged = true",
  "resolveScmReconciliationReview",
  'resolution: "accept_current"'
], "reviewed dry-run decision enforcement");

includesAll(server, [
  "applyScmReconciliationRun",
  "if (!result.applied)",
  "The reconciliation apply did not succeed."
], "scoped dry-run apply API");

includesAll(repository, [
  "export async function getScmReconciliationRunDecisionSummary",
  "export async function listScmReconciliationRunTargetDecisions",
  "export async function assertScmReconciliationRunReadyToApply",
  "export async function updateScmReconciliationRunTargetDecision",
  "AND status = 'review'",
  "AND review_decision IS NULL",
  "FOR UPDATE OF target, run",
  "This dry run already has a linked apply run; its decisions are locked.",
  'eventType: "dry_run.review_decision"'
], "dry-run review decision persistence and apply gate");

includesAll(repository, [
  "blocked_schedule",
  "lower(COALESCE(po.dispatch_ref, ''))",
  "reconciliation_blocked = true"
], "PO alias-aware review blocking");

includesAll(control, [
  "payload?.pending === true",
  "Progress will update in the run history"
], "Admin pending apply feedback");

includesAll(schedule, [
  "waitForScmScheduleReconciliationRerun",
  "targeted reconciliation is running",
  "The schedule will remain blocked until it finishes"
], "allocation rerun progress feedback");

console.log("SCM reconciliation server integration harness passed.");

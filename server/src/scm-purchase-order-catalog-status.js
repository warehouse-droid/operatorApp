import { scmScheduleEffectiveReconciliationStatus } from "./scm-reconciliation-repository.js";
import { scmManualSplitHasOperationalStatusAuthority } from "./scm-manual-split-authority.js";

const MANUALLY_PRESERVED_STATUSES = new Set([
  "complete",
  "completed",
  "cancelled",
  "canceled",
  "hold",
  "in transit",
  "partially done",
  "reconcile review"
]);

function text(value) {
  return String(value ?? "").trim();
}

export function storedScmPurchaseOrderCatalogStatus(order = {}) {
  return text(order.scm?.status) || "Hold";
}

export function operationalScmPurchaseOrderCatalogStatus(order = {}, evidence = {}) {
  const saved = text(evidence.schedule_status);
  const sourceInitial = text(evidence.source_initial_status);
  const baseline = saved || sourceInitial || storedScmPurchaseOrderCatalogStatus(order);
  if (MANUALLY_PRESERVED_STATUSES.has(baseline.toLowerCase())) {
    return ["complete", "completed"].includes(baseline.toLowerCase()) ? "Completed" : baseline;
  }
  return order.dispatchPlanned === true ? "Planned" : baseline;
}

export function effectiveScmPurchaseOrderCatalogStatus(order = {}, evidence = {}) {
  const stored = storedScmPurchaseOrderCatalogStatus(order);
  if (evidence.completion_event_id || order.dispatchCompleted === true) return "Completed";
  if (!evidence.schedule_id && !text(evidence.source_initial_status)) return stored;
  if (!evidence.schedule_id) return operationalScmPurchaseOrderCatalogStatus(order, evidence);
  const preserveOperationalStatus = order.isScmSplit === true
    && scmManualSplitHasOperationalStatusAuthority(evidence.schedule_status, {
      hasActivePlan: order.dispatchPlanned === true,
      derivedStatus: evidence.reconciliation_application_status
    });
  return scmScheduleEffectiveReconciliationStatus({
    scheduleStatus: preserveOperationalStatus
      ? evidence.schedule_status
      : operationalScmPurchaseOrderCatalogStatus(order, evidence),
    scheduleId: evidence.schedule_id,
    scheduleUpdatedAt: evidence.schedule_updated_at,
    reconciliationStatus: evidence.reconciliation_status,
    reconciliationReconciledAt: evidence.reconciled_at,
    reconciliationApplicationStatus: evidence.reconciliation_application_status,
    blockingReview: evidence.reconciliation_blocked === true,
    preserveOperationalStatus
  });
}

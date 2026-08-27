const EPSILON = 0.000001;
const SPLIT_TARGET_KINDS = new Set(["po_split", "to_split"]);
const SPLIT_NON_PROGRESS_STATUSES = new Set([
  "Queued",
  "Planned",
  "Urgent",
  "Hold",
  "Priority",
  "Surplus Only",
  "Book Appt"
]);
const LOST_COMPLETION_EVIDENCE_REASON =
  "A previously completed order lost destination receipt evidence.";

function quantity(value) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function fallbackStatus(previousStatus, hasActivePlan) {
  const previous = String(previousStatus || "").trim();
  if (SPLIT_NON_PROGRESS_STATUSES.has(previous)) return previous;
  return hasActivePlan ? "Planned" : "Queued";
}

/**
 * Keeps ambiguous family-level allocation useful as quantity evidence without
 * allowing it to masquerade as exact operational progress on one split child.
 */
export function applySplitTargetEvidencePrecedence({
  targetKind = "",
  previousStatus = "Queued",
  hasActivePlan = false,
  evidencedFulfilledQty = 0,
  evidencedReceivedQty = 0,
  derivedState = {}
} = {}) {
  if (!SPLIT_TARGET_KINDS.has(String(targetKind || "").trim().toLowerCase())) {
    return derivedState;
  }

  const lifecycle = derivedState.lifecycle || {};
  if (lifecycle.closed || lifecycle.cancelled) return derivedState;

  const applicationStatus = String(derivedState.applicationStatus || "").trim();
  const previousCompleted = ["complete", "completed"].includes(
    String(previousStatus || "").trim().toLowerCase()
  );
  const inferredCompletionLoss = applicationStatus === "Reconcile Review"
    && String(derivedState.reason || "").trim() === LOST_COMPLETION_EVIDENCE_REASON;
  if (
    previousCompleted
    && (
      inferredCompletionLoss
      || ["Queued", "Partially Done", "In Transit"].includes(applicationStatus)
    )
  ) {
    return {
      ...derivedState,
      applicationStatus: "Completed",
      reconciliationStatus: "ok",
      reason: ""
    };
  }

  const hasEvidencedProgress = quantity(evidencedFulfilledQty) > EPSILON
    || quantity(evidencedReceivedQty) > EPSILON;
  if (
    !hasEvidencedProgress
    && ["Partially Done", "In Transit"].includes(applicationStatus)
  ) {
    return {
      ...derivedState,
      applicationStatus: fallbackStatus(previousStatus, hasActivePlan),
      reconciliationStatus: "ok",
      reason: ""
    };
  }

  return derivedState;
}

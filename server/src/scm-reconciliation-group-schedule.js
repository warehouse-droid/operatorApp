const BLOCKING_RECONCILIATION_STATUSES = new Set(["review", "missing", "error"]);

function text(value) {
  return String(value ?? "").trim();
}

export function deriveScmGroupSchedulePersistence({
  currentStatus = "Queued",
  applicationStatus = "Queued",
  reconciliationStatus = "pending"
} = {}) {
  const current = text(currentStatus) || "Queued";
  const application = text(applicationStatus) || "Queued";
  const reconciliation = text(reconciliationStatus).toLowerCase() || "pending";
  const reconciliationBlocked = BLOCKING_RECONCILIATION_STATUSES.has(reconciliation);
  const clearedLegacyReview = current.toLowerCase() === "reconcile review"
    && !reconciliationBlocked;
  return {
    applicationStatus: application,
    reconciliationStatus: reconciliation,
    reconciliationBlocked,
    persistedStatus: clearedLegacyReview ? application : current
  };
}

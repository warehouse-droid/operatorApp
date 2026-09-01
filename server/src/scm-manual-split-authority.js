const OPERATOR_CONTROLLED_STATUSES = new Set([
  "queued",
  "urgent",
  "cancelled",
  "canceled",
  "hold",
  "priority",
  "surplus only",
  "book appt"
]);

export function scmManualSplitHasOperatorStatusAuthority(status = "") {
  return OPERATOR_CONTROLLED_STATUSES.has(String(status || "").trim().toLowerCase());
}

export function scmManualSplitHasOperationalStatusAuthority(status = "", {
  hasActivePlan = false,
  derivedStatus = ""
} = {}) {
  const normalized = String(status || "").trim().toLowerCase();
  const normalizedDerived = String(derivedStatus || "").trim().toLowerCase();
  return OPERATOR_CONTROLLED_STATUSES.has(normalized)
    || (
      normalized === "planned"
      && hasActivePlan === true
      && !["complete", "completed", "cancelled", "canceled"].includes(normalizedDerived)
    );
}

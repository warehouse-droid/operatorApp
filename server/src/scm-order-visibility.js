const RESTRICTED_SCM_STATUSES = new Set([
  "hold",
  "complete",
  "completed",
  "cancelled",
  "canceled"
]);

const RESTRICTED_SCM_VIEW_ROLES = new Set([
  "admin",
  "scm",
  "scm_staff"
]);

const CURRENT_SCM_STATUSES = new Set([
  ...RESTRICTED_SCM_STATUSES,
  "queued",
  "planned",
  "urgent",
  "priority",
  "surplus only",
  "book appt",
  "partially done",
  "in transit",
  "reconcile review"
]);

function normalizedVisibilityValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("-", "_")
    .replaceAll(" ", "_");
}

function truthyFlag(value) {
  if (value === true) return true;
  return ["true", "1", "yes"].includes(String(value || "").trim().toLowerCase());
}

export function canViewRestrictedScmOrders(operator = null) {
  const roles = [
    ...(Array.isArray(operator?.roles) ? operator.roles : []),
    operator?.role
  ]
    .map(normalizedVisibilityValue)
    .filter(Boolean);
  return roles.some((role) => RESTRICTED_SCM_VIEW_ROLES.has(role));
}

export function isRestrictedScmOrder(row = {}) {
  if ([
    row.isBlanket,
    row.is_blanket,
    row.isBlanketPo,
    row.is_blanket_po,
    row.raw?.isBlanket,
    row.raw?.is_blanket_po
  ].some(truthyFlag)) {
    return true;
  }

  const currentStatuses = [
    row.reconciliationApplicationStatus,
    row.reconciliation_application_status,
    row.scm?.reconciliationApplicationStatus,
    row.scm?.reconciliation_application_status,
    row.scm?.status,
    row.scmStatus,
    row.scm_status,
    row.raw?.scm_status
  ]
    .map((status) => String(status || "").trim().toLowerCase())
    .filter(Boolean);
  const rowStatus = String(row.status || "").trim().toLowerCase();
  if (CURRENT_SCM_STATUSES.has(rowStatus)) currentStatuses.push(rowStatus);
  const initialStatuses = [
    row.initialScmStatus,
    row.initial_scm_status,
    row.raw?.initial_scm_status
  ]
    .map((status) => String(status || "").trim().toLowerCase())
    .filter(Boolean);
  const effectiveStatus = currentStatuses[0] || initialStatuses[0] || rowStatus;
  return RESTRICTED_SCM_STATUSES.has(effectiveStatus);
}

export function filterRestrictedScmOrders(rows = [], { includeRestricted = false } = {}) {
  const source = Array.isArray(rows) ? rows : [];
  return includeRestricted ? [...source] : source.filter((row) => !isRestrictedScmOrder(row));
}

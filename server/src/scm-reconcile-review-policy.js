const EPSILON = 0.000001;
const OPERATIONAL_SCHEDULE_STATUSES = new Set([
  "Planned",
  "Partially Done",
  "In Transit",
  "Completed"
]);

function text(value) {
  return String(value ?? "").trim();
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function validDate(value) {
  if (!value) {
    return false;
  }
  return Number.isFinite(new Date(value).getTime());
}

function quantity(value) {
  const parsed = Number(String(value ?? 0).replaceAll(",", ""));
  return Number.isFinite(parsed) ? Math.max(parsed, 0) : 0;
}

export function scmScheduleHasOperationalPlanningEvidence({
  sourceDispatchPlanned = false,
  scheduleId = 0,
  scheduleStatus = "",
  scheduleEtaDate = null,
  scheduleDispatchPlanId = 0
} = {}) {
  if (sourceDispatchPlanned === true) {
    return true;
  }
  if (!positiveId(scheduleId)) {
    return false;
  }
  return positiveId(scheduleDispatchPlanId) !== null
    || validDate(scheduleEtaDate)
    || OPERATIONAL_SCHEDULE_STATUSES.has(text(scheduleStatus));
}

export function scmPlannedQuantityChangeRequiresReview({
  orderKind = "",
  localOrderedQuantity = 0,
  authoritativeOrderedQuantity = 0
} = {}) {
  const local = quantity(localOrderedQuantity);
  const authoritative = quantity(authoritativeOrderedQuantity);
  return text(orderKind).toUpperCase() === "TO"
    ? authoritative > local + EPSILON
    : Math.abs(authoritative - local) > EPSILON;
}

export function scmActiveSplitExceedsSource({
  activeSplitQuantity = 0,
  authoritativeSourceQuantity = 0
} = {}) {
  return quantity(activeSplitQuantity) > quantity(authoritativeSourceQuantity) + EPSILON;
}

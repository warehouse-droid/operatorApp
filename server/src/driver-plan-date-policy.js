export const DRIVER_COMPANY_TIME_ZONE = "America/Toronto";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizedPlanDate(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : "";
  }
  const text = String(value ?? "").trim();
  if (!ISO_DATE_PATTERN.test(text)) return "";
  const [year, month, day] = text.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) return "";
  return text;
}

export function driverCompanyDate(now = new Date()) {
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) {
    throw new TypeError("Driver company date requires a valid instant.");
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DRIVER_COMPANY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(instant);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function driverPlanExecutionDecision(planDateValue, { now = new Date() } = {}) {
  const companyDate = driverCompanyDate(now);
  const planDate = normalizedPlanDate(planDateValue);
  if (!planDate) {
    return {
      allowed: false,
      code: "DRIVER_PLAN_DATE_INVALID",
      message: "Driver work requires a valid YYYY-MM-DD plan date.",
      planDate: "",
      companyDate,
      timeZone: DRIVER_COMPANY_TIME_ZONE
    };
  }
  if (planDate > companyDate) {
    return {
      allowed: false,
      code: "DRIVER_PLAN_NOT_STARTED",
      message: `This route is scheduled for ${planDate} and cannot start before that date in Toronto.`,
      planDate,
      companyDate,
      timeZone: DRIVER_COMPANY_TIME_ZONE
    };
  }
  return {
    allowed: true,
    code: "",
    message: "",
    planDate,
    companyDate,
    timeZone: DRIVER_COMPANY_TIME_ZONE
  };
}

export function assertDriverPlanExecutionDate(planDate, options = {}) {
  const decision = driverPlanExecutionDecision(planDate, options);
  if (decision.allowed) return decision;
  throw Object.assign(new Error(decision.message), {
    status: 409,
    code: decision.code,
    planDate: decision.planDate,
    companyDate: decision.companyDate,
    timeZone: decision.timeZone
  });
}

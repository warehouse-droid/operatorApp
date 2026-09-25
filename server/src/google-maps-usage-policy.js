import crypto from "node:crypto";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

export const GOOGLE_MAPS_USAGE_LIMITS = Object.freeze({
  windowDays: 30,
  dailyLimit: 150,
  alertLimit: 3_000,
  conserveLimit: 3_500,
  normalLimit: 4_000,
  hardLimit: 4_500,
  consoleTarget: 5_000,
  subsystemLimits: Object.freeze({
    dispatch_route: 1_200,
    monitor_eta: 600,
    driver_geocode: 800,
    support_route: 400
  })
});

const RESERVE_REASONS = new Set(["confirm", "manual_refresh", "driver_location_check"]);

function finiteNonnegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(maximum, Math.max(minimum, Math.trunc(number)))
    : fallback;
}

export function normalizeGoogleMapsMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["disabled", "conserve", "normal"].includes(normalized) ? normalized : "conserve";
}

export function googleMapsBudgetState(rollingUsage, limits = GOOGLE_MAPS_USAGE_LIMITS) {
  const usage = finiteNonnegative(rollingUsage);
  if (usage >= limits.hardLimit) return "exhausted";
  if (usage >= limits.normalLimit) return "reserve";
  if (usage >= limits.conserveLimit) return "conserve";
  return "normal";
}

export function googleMapsDailyCapacity({
  day, resetsAt, dailyUsage = 0, dailyExtraUnits = 0, rollingUsage = 0,
  limits = GOOGLE_MAPS_USAGE_LIMITS
} = {}) {
  const baseLimit = limits.dailyLimit ?? GOOGLE_MAPS_USAGE_LIMITS.dailyLimit;
  const used = finiteNonnegative(dailyUsage);
  const extraUnits = finiteNonnegative(dailyExtraUnits);
  const limit = baseLimit + extraUnits;
  const reopenUnits = Math.min(baseLimit, Math.max(0, limits.hardLimit - finiteNonnegative(rollingUsage)));
  return { day, resetsAt, used, baseLimit, extraUnits, limit,
    remaining: Math.max(0, limit - used), reopenUnits, canReopen: used >= limit && reopenUnits > 0 };
}

export function googleMapsAdmissionDecision({
  mode = "normal",
  rollingUsage = 0,
  dailyUsage = 0,
  dailyExtraUnits = 0,
  subsystemUsage = 0,
  subsystem = "support_route",
  units = 1,
  automatic = false,
  reason = "manual_refresh",
  limits = GOOGLE_MAPS_USAGE_LIMITS
} = {}) {
  const normalizedMode = normalizeGoogleMapsMode(mode);
  const usage = finiteNonnegative(rollingUsage);
  const requestedUnits = boundedInteger(units, 1, 1, 1_000);
  const afterUsage = usage + requestedUnits;
  const budgetState = googleMapsBudgetState(usage, limits);
  if (normalizedMode === "disabled") return { admitted: false, reason: "disabled", budgetState, units: requestedUnits };
  if (afterUsage > limits.hardLimit) return { admitted: false, reason: "hard_limit", budgetState: "exhausted", units: requestedUnits };
  const daily = googleMapsDailyCapacity({ dailyUsage, dailyExtraUnits, rollingUsage, limits });
  if (daily.used + requestedUnits > daily.limit) {
    return { admitted: false, reason: "daily_limit", budgetState, units: requestedUnits };
  }
  if (automatic && (normalizedMode === "conserve" || usage >= limits.conserveLimit)) {
    return { admitted: false, reason: "automatic_disabled", budgetState, units: requestedUnits };
  }
  const subsystemLimit = Number(limits.subsystemLimits?.[subsystem] || 0);
  const usesSharedReserve = subsystemLimit > 0 && finiteNonnegative(subsystemUsage) + requestedUnits > subsystemLimit;
  if (automatic && usesSharedReserve) {
    return { admitted: false, reason: "subsystem_limit", budgetState, units: requestedUnits };
  }
  if (usage >= limits.normalLimit && !RESERVE_REASONS.has(String(reason || ""))) {
    return { admitted: false, reason: "reserve_restricted", budgetState, units: requestedUnits };
  }
  return {
    admitted: true,
    reason: usesSharedReserve ? "shared_reserve" : usage >= limits.normalLimit ? "break_glass_reserve" : "within_budget",
    budgetState: googleMapsBudgetState(afterUsage, limits),
    units: requestedUnits,
    usesSharedReserve
  };
}

function normalizedLocation(value) {
  if (value && typeof value === "object") {
    const latitude = Number(value.latitude ?? value.lat);
    const longitude = Number(value.longitude ?? value.lng);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      return `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
    }
    value = value.location ?? value.address ?? value.routeLocation ?? "";
  }
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function routeStopLocation(stop = {}) {
  return stop.location ?? stop.routeLocation ?? stop.address ?? stop.dropAddress ?? stop.dropLocation ?? stop;
}

export function googleMapsRouteFingerprint({
  stops = [],
  stayMinutes = [],
  departureTime = null,
  allowTolls = false,
  travelMode = "DRIVE",
  trafficAware = false,
  travelTimePercent = 0
} = {}) {
  const departureEpoch = Date.parse(departureTime || "");
  const departureBucket = Number.isFinite(departureEpoch)
    ? Math.floor(departureEpoch / FIFTEEN_MINUTES_MS)
    : null;
  const canonical = JSON.stringify({
    stops: (stops || []).map((stop, index) => ({
      location: normalizedLocation(routeStopLocation(stop)),
      stayMinutes: finiteNonnegative(stayMinutes?.[index] ?? stop?.stayMinutes)
    })),
    departureBucket,
    allowTolls: Boolean(allowTolls),
    travelMode: String(travelMode || "DRIVE").toUpperCase(),
    trafficAware: Boolean(trafficAware),
    travelTimePercent: boundedInteger(travelTimePercent, 0, 0, 200)
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function buildFallbackRoutePreview({
  stops = [],
  fallbackLegMinutes = [],
  travelTimePercent = 0,
  allowTolls = false,
  defaultLegMinutes = 30
} = {}) {
  const routeStops = Array.isArray(stops) ? stops : [];
  const adjustment = boundedInteger(travelTimePercent, 0, 0, 200);
  const defaultMinutes = boundedInteger(defaultLegMinutes, 30, 1, 1_440);
  const rawLegMinutes = routeStops.slice(1).map((stop, index) => {
    const previous = routeStops[index];
    if (normalizedLocation(routeStopLocation(previous)) === normalizedLocation(routeStopLocation(stop))) return 0;
    const supplied = Number(fallbackLegMinutes?.[index]);
    return Number.isFinite(supplied) && supplied >= 0 ? Math.round(supplied) : defaultMinutes;
  });
  const legMinutes = rawLegMinutes.map((minutes) =>
    minutes === 0 ? 0 : Math.max(1, Math.round(minutes * (1 + (adjustment / 100))))
  );
  const rawDriveMinutes = rawLegMinutes.reduce((sum, minutes) => sum + minutes, 0);
  const driveMinutes = legMinutes.reduce((sum, minutes) => sum + minutes, 0);
  const stayMinutes = routeStops.reduce((sum, stop) => sum + finiteNonnegative(stop?.stayMinutes), 0);
  return {
    source: "fallback",
    rawDriveMinutes,
    driveMinutes,
    stayMinutes,
    totalMinutes: driveMinutes + stayMinutes,
    rawLegMinutes,
    legMinutes,
    allowTolls: Boolean(allowTolls),
    travelTimePercent: adjustment,
    googleAttempted: false
  };
}

export function validateRoutePreview(preview = {}, { stopCount = null } = {}) {
  const issues = [];
  const legs = Array.isArray(preview?.legMinutes) ? preview.legMinutes : [];
  if (Number.isInteger(stopCount) && legs.length !== Math.max(0, stopCount - 1)) issues.push("leg_count_mismatch");
  legs.forEach((minutes, index) => {
    if (!Number.isFinite(Number(minutes)) || Number(minutes) < 0) issues.push(`leg_${index + 1}_invalid`);
  });
  for (const field of ["driveMinutes", "stayMinutes", "totalMinutes"]) {
    if (!Number.isFinite(Number(preview?.[field])) || Number(preview[field]) < 0) issues.push(`${field}_invalid`);
  }
  if (
    Number.isFinite(Number(preview?.driveMinutes))
    && legs.every((minutes) => Number.isFinite(Number(minutes)))
    && Number(preview.driveMinutes) !== legs.reduce((sum, minutes) => sum + Number(minutes), 0)
  ) issues.push("drive_total_mismatch");
  if (
    Number.isFinite(Number(preview?.totalMinutes))
    && Number.isFinite(Number(preview?.driveMinutes))
    && Number.isFinite(Number(preview?.stayMinutes))
    && Number(preview.totalMinutes) !== Number(preview.driveMinutes) + Number(preview.stayMinutes)
  ) issues.push("route_total_mismatch");
  return { valid: issues.length === 0, issues };
}

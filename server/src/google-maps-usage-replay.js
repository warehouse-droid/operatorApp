import {
  buildFallbackRoutePreview,
  googleMapsRouteFingerprint,
  validateRoutePreview
} from "./google-maps-usage-policy.js";

const LEGACY_MONITOR_REFRESH_MS = 45_000;

function epoch(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function mergedActiveMilliseconds(intervals = []) {
  const byTruck = new Map();
  for (const interval of intervals || []) {
    const start = epoch(interval.startedAt);
    const end = epoch(interval.completedAt);
    if (start === null || end === null || end <= start || end - start > 24 * 60 * 60 * 1000) continue;
    const key = String(interval.truckKey || "unknown");
    if (!byTruck.has(key)) byTruck.set(key, []);
    byTruck.get(key).push([start, end]);
  }
  let total = 0;
  for (const ranges of byTruck.values()) {
    ranges.sort((left, right) => left[0] - right[0]);
    let current = null;
    for (const range of ranges) {
      if (!current || range[0] > current[1]) {
        if (current) total += current[1] - current[0];
        current = [...range];
      } else {
        current[1] = Math.max(current[1], range[1]);
      }
    }
    if (current) total += current[1] - current[0];
  }
  return total;
}

export function replayGoogleMapsUsage({
  windowDays = 7,
  snapshots = [],
  activeTruckIntervals = [],
  completedJobs = 0,
  uniqueUnresolvedDestinations = 0,
  dependencySuggestions = 0,
  browserMapSessions = 0
} = {}) {
  const previews = {
    total: 0,
    valid: 0,
    invalid: 0,
    google: 0,
    fallback: 0,
    issues: {},
    sourceInvalid: 0,
    sourceIssues: {},
    repairedWithFallback: 0,
    fingerprints: { total: 0, stable: 0, unstable: 0 }
  };
  const legacyDispatchRouteCalls = new Map();
  const controlledConfirmedFingerprints = new Set();
  for (const snapshot of snapshots || []) {
    for (const load of snapshot.loads || []) {
      const stops = Array.isArray(load.stops) ? load.stops : [];
      const supplied = load?.routeEstimate && typeof load.routeEstimate === "object"
        ? load.routeEstimate
        : null;
      const sourceValidation = supplied
        ? validateRoutePreview(supplied, { stopCount: stops.length })
        : null;
      if (sourceValidation && !sourceValidation.valid) {
        previews.sourceInvalid += 1;
        previews.repairedWithFallback += 1;
        for (const issue of sourceValidation.issues) {
          previews.sourceIssues[issue] = Number(previews.sourceIssues[issue] || 0) + 1;
        }
      }
      const existing = sourceValidation?.valid ? supplied : null;
      const preview = existing || buildFallbackRoutePreview({
        stops,
        fallbackLegMinutes: load.fallbackLegMinutes || [],
        travelTimePercent: load.travelTimePercent || 0,
        allowTolls: load.allowTolls
      });
      const validation = validateRoutePreview(preview, { stopCount: stops.length });
      previews.total += 1;
      if (validation.valid) previews.valid += 1;
      else {
        previews.invalid += 1;
        for (const issue of validation.issues) {
          previews.issues[issue] = Number(previews.issues[issue] || 0) + 1;
        }
      }
      if (existing && ["google", "google_routes_v2"].includes(String(existing.source || ""))) previews.google += 1;
      else previews.fallback += 1;
      const derivedFingerprint = googleMapsRouteFingerprint({
        stops,
        departureTime: load.departureTime,
        travelTimePercent: load.travelTimePercent || 0,
        allowTolls: load.allowTolls
      });
      const repeatedFingerprint = googleMapsRouteFingerprint({
        stops,
        departureTime: load.departureTime,
        travelTimePercent: load.travelTimePercent || 0,
        allowTolls: load.allowTolls
      });
      previews.fingerprints.total += 1;
      if (derivedFingerprint === repeatedFingerprint) previews.fingerprints.stable += 1;
      else previews.fingerprints.unstable += 1;
      const routeIdentity = String(load.routeFingerprint || derivedFingerprint);
      if (!existing && stops.length > 1 && !legacyDispatchRouteCalls.has(routeIdentity)) {
        legacyDispatchRouteCalls.set(routeIdentity, stops.length);
      }
      const existingGoogleEstimate = existing
        && ["google", "google_routes_v2"].includes(String(existing.source || ""));
      if (snapshot.confirmed && stops.length > 1 && !existingGoogleEstimate) {
        controlledConfirmedFingerprints.add(routeIdentity);
      }
    }
  }
  const activeMs = mergedActiveMilliseconds(activeTruckIntervals);
  const legacyMonitorEta = Math.ceil(activeMs / LEGACY_MONITOR_REFRESH_MS);
  const unresolved = Math.max(0, Math.trunc(Number(uniqueUnresolvedDestinations) || 0));
  const suggestions = Math.max(0, Math.trunc(Number(dependencySuggestions) || 0));
  const mapSessions = Math.max(0, Math.trunc(Number(browserMapSessions) || 0));
  const current = {
    dispatchRoutes: [...legacyDispatchRouteCalls.values()].reduce((sum, calls) => sum + calls, 0),
    monitorEta: legacyMonitorEta,
    // The legacy process-level geocode cache normally prevents the photo step
    // from producing a second paid lookup, so do not claim speculative savings.
    driverGeocoding: unresolved,
    dependencyRoutes: suggestions * 3,
    dynamicMaps: mapSessions
  };
  current.total = Object.values(current).reduce((sum, value) => sum + value, 0);
  const controlled = {
    dispatchRoutes: controlledConfirmedFingerprints.size,
    monitorEta: 0,
    driverGeocoding: unresolved,
    dependencyRoutes: 0,
    dynamicMaps: 0
  };
  controlled.total = Object.values(controlled).reduce((sum, value) => sum + value, 0);
  const days = Math.max(1, Number(windowDays) || 7);
  controlled.projected30Day = Math.ceil((controlled.total / days) * 30);
  current.projected30Day = Math.ceil((current.total / days) * 30);
  return {
    windowDays: days,
    sourceEvents: {
      snapshots: snapshots.length,
      activeTruckIntervals: activeTruckIntervals.length,
      completedJobs: Math.max(0, Math.trunc(Number(completedJobs) || 0)),
      uniqueUnresolvedDestinations: unresolved,
      dependencySuggestions: suggestions,
      browserMapSessions: mapSessions
    },
    previews,
    current,
    controlled,
    reductionPercent: current.total > 0
      ? Number((((current.total - controlled.total) / current.total) * 100).toFixed(2))
      : 0
  };
}

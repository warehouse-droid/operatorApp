import {
  buildFallbackRoutePreview,
  googleMapsRouteFingerprint,
  validateRoutePreview
} from "./google-maps-usage-policy.js";

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const GEOCODING_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RECENT_ROUTE_LIMIT = 500;
const MAX_STANDARD_ROUTE_STOPS = 12;
const MAX_ROUTE_PATH_POINTS = 5000;

function durationSeconds(value) {
  const match = String(value || "").match(/^([0-9]+(?:\.[0-9]+)?)s$/u);
  return match ? Number(match[1]) : Number.NaN;
}

function validCoordinate(latitude, longitude) {
  return Number.isFinite(latitude)
    && latitude >= -90
    && latitude <= 90
    && Number.isFinite(longitude)
    && longitude >= -180
    && longitude <= 180;
}

function routeMapGeometry(route, legs) {
  const line = route?.polyline?.geoJsonLinestring;
  const coordinates = line?.coordinates;
  const validPath = line?.type === "LineString"
    && Array.isArray(coordinates)
    && coordinates.length >= 2 && coordinates.length <= MAX_ROUTE_PATH_POINTS
    && coordinates.every((point) => Array.isArray(point) && point.length === 2 && validCoordinate(point[1], point[0]));
  const locations = [legs[0]?.startLocation, ...legs.map((leg) => leg.endLocation)];
  const validPins = locations.every((point) => validCoordinate(point?.latLng?.latitude, point?.latLng?.longitude));
  return {
    routePath: validPath ? coordinates.map(([lng, lat]) => ({ lat, lng })) : [],
    stopCoordinates: validPins ? locations.map(({ latLng }) => ({ lat: latLng.latitude, lng: latLng.longitude })) : []
  };
}

function routeWaypoint(stop = {}) {
  const latitude = Number(stop.latitude ?? stop.lat);
  const longitude = Number(stop.longitude ?? stop.lng);
  if (validCoordinate(latitude, longitude)) {
    return { location: { latLng: { latitude, longitude } } };
  }
  const address = String(stop.location ?? stop.routeLocation ?? stop.address ?? "").trim();
  return address ? { address } : null;
}

function fallbackResult(fallback, { budgetState = "normal", reason, attempted = false } = {}) {
  return {
    ...(fallback || buildFallbackRoutePreview({ stops: [] })),
    source: "fallback",
    budgetState,
    fallbackReason: reason || "unavailable",
    googleAttempted: attempted
  };
}

function roundedMinutes(seconds) {
  return Math.max(1, Math.round(Number(seconds) / 60));
}

function waypointKey(waypoint) {
  return JSON.stringify(waypoint || null);
}

function normalizedRouteStops(stops = [], explicitStayMinutes = []) {
  return (Array.isArray(stops) ? stops : []).map((rawStop, index) => {
    const stop = rawStop && typeof rawStop === "object"
      ? rawStop
      : { location: String(rawStop || "") };
    const stayMinutes = Number(explicitStayMinutes?.[index] ?? stop.stayMinutes);
    return {
      ...stop,
      stayMinutes: Number.isFinite(stayMinutes)
        ? Math.min(1_440, Math.max(0, stayMinutes))
        : 0
    };
  });
}

function futureDepartureTime(value, current) {
  const currentDate = current instanceof Date ? current : new Date(current);
  const nowEpoch = Number.isFinite(currentDate.getTime()) ? currentDate.getTime() : Date.now();
  const requestedEpoch = Date.parse(value || "");
  return new Date(Math.max(Number.isFinite(requestedEpoch) ? requestedEpoch : 0, nowEpoch + (5 * 60 * 1000))).toISOString();
}

export function createGoogleMapsGateway({
  apiKey = "",
  mode = "conserve",
  transport = globalThis.fetch,
  admitUsage = async () => ({ admitted: false, reason: "accounting_unavailable", budgetState: "exhausted" }),
  recordOutcome = async () => {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  recentRouteLimit = DEFAULT_RECENT_ROUTE_LIMIT,
  now = () => new Date()
} = {}) {
  const inFlight = new Map();
  const recentRoutes = new Map();

  function resolvedApiKey() {
    return String((typeof apiKey === "function" ? apiKey() : apiKey) || "").trim();
  }

  function resolvedMode() {
    return String((typeof mode === "function" ? mode() : mode) || "conserve");
  }

  function currentEpoch() {
    const value = now();
    const epoch = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(epoch) ? epoch : Date.now();
  }

  function pruneRecentRoutes(epoch = currentEpoch()) {
    for (const [key, entry] of recentRoutes) {
      if (!entry || entry.expiresAt <= epoch) recentRoutes.delete(key);
    }
    const maximum = Math.max(1, Math.trunc(Number(recentRouteLimit) || DEFAULT_RECENT_ROUTE_LIMIT));
    while (recentRoutes.size > maximum) recentRoutes.delete(recentRoutes.keys().next().value);
  }

  function retainRecentRoute(fingerprint, result) {
    pruneRecentRoutes();
    const maximum = Math.max(1, Math.trunc(Number(recentRouteLimit) || DEFAULT_RECENT_ROUTE_LIMIT));
    if (!recentRoutes.has(fingerprint) && recentRoutes.size >= maximum) {
      recentRoutes.delete(recentRoutes.keys().next().value);
    }
    recentRoutes.set(fingerprint, { result, expiresAt: currentEpoch() + 15 * 60 * 1000 });
  }

  async function performRouteEstimate(input, fingerprint, fallback) {
    const requestApiKey = resolvedApiKey();
    if (!requestApiKey || typeof transport !== "function") return fallbackResult(fallback, { reason: "not_configured" });
    let admission;
    try {
      admission = await admitUsage({
        subsystem: input.subsystem || "support_route",
        api: "routes_v2_compute_routes",
        reason: input.reason || "manual_refresh",
        fingerprint,
        automatic: Boolean(input.automatic),
        units: 1,
        actorId: input.actorId || "",
        sessionId: input.sessionId || "",
        mode: resolvedMode()
      });
    } catch {
      admission = { admitted: false, reason: "accounting_unavailable", budgetState: "exhausted" };
    }
    if (!admission?.admitted) {
      return fallbackResult(fallback, {
        budgetState: admission?.budgetState || "exhausted",
        reason: admission?.reason || "budget_denied"
      });
    }
    const waypoints = input.waypoints;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const startedAt = Date.now();
    try {
      const response = await transport(ROUTES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": requestApiKey,
          "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.legs.duration,routes.legs.distanceMeters,routes.polyline.geoJsonLinestring,routes.legs.startLocation,routes.legs.endLocation"
        },
        body: JSON.stringify({
          origin: waypoints[0],
          destination: waypoints[waypoints.length - 1],
          intermediates: waypoints.slice(1, -1),
          travelMode: "DRIVE",
          polylineEncoding: "GEO_JSON_LINESTRING",
          polylineQuality: "OVERVIEW",
          routingPreference: input.trafficAware ? "TRAFFIC_AWARE" : "TRAFFIC_UNAWARE",
          ...(input.trafficAware ? { departureTime: futureDepartureTime(input.departureTime, now()) } : {}),
          routeModifiers: { avoidTolls: !Boolean(input.allowTolls) },
          languageCode: "en-CA",
          units: "METRIC"
        }),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      const route = payload?.routes?.[0];
      const legs = Array.isArray(route?.legs) ? route.legs : [];
      const rawLegMinutes = legs.map((leg, index) => waypointKey(waypoints[index]) === waypointKey(waypoints[index + 1])
        ? 0
        : roundedMinutes(durationSeconds(leg.duration)));
      if (!response.ok || legs.length !== input.stops.length - 1 || rawLegMinutes.some((minutes) => !Number.isFinite(minutes))) {
        await recordOutcome({
          ledgerId: admission.ledgerId,
          outcome: "invalid_response",
          httpStatus: Number(response.status || 0),
          latencyMs: Date.now() - startedAt
        }).catch(() => null);
        return fallbackResult(fallback, { budgetState: admission.budgetState, reason: "invalid_response", attempted: true });
      }
      const travelTimePercent = Math.min(200, Math.max(0, Math.trunc(Number(input.travelTimePercent) || 0)));
      const legMinutes = rawLegMinutes.map((minutes) => minutes === 0
        ? 0
        : Math.max(1, Math.round(minutes * (1 + travelTimePercent / 100))));
      const rawDriveMinutes = rawLegMinutes.reduce((sum, minutes) => sum + minutes, 0);
      const driveMinutes = legMinutes.reduce((sum, minutes) => sum + minutes, 0);
      const stayMinutes = input.stops.map((stop) => stop.stayMinutes || 0)
        .reduce((sum, minutes) => sum + Math.max(0, Number(minutes) || 0), 0);
      const result = {
        source: "google_routes_v2",
        ...routeMapGeometry(route, legs),
        rawDriveMinutes,
        driveMinutes,
        stayMinutes,
        totalMinutes: driveMinutes + stayMinutes,
        rawLegMinutes,
        legMinutes,
        legDistanceMeters: legs.map((leg) => Math.max(0, Number(leg.distanceMeters) || 0)),
        distanceMeters: Math.max(0, Number(route.distanceMeters) || 0),
        allowTolls: Boolean(input.allowTolls),
        travelTimePercent,
        routeSignature: input.routeSignature || fingerprint,
        routeEstimateId: input.routeEstimateId || fingerprint,
        budgetState: admission.budgetState || "normal",
        googleAttempted: true,
        asOf: now().toISOString()
      };
      if (!validateRoutePreview(result, { stopCount: input.stops.length }).valid) {
        await recordOutcome({ ledgerId: admission.ledgerId, outcome: "invalid_response" }).catch(() => null);
        return fallbackResult(fallback, { budgetState: admission.budgetState, reason: "invalid_response", attempted: true });
      }
      await recordOutcome({
        ledgerId: admission.ledgerId,
        outcome: "succeeded",
        httpStatus: Number(response.status || 200),
        latencyMs: Date.now() - startedAt
      }).catch(() => null);
      if (input.subsystem === "monitor_eta") {
        retainRecentRoute(fingerprint, result);
      }
      return result;
    } catch (error) {
      await recordOutcome({
        ledgerId: admission.ledgerId,
        outcome: error?.name === "AbortError" ? "timeout" : "failed",
        latencyMs: Date.now() - startedAt
      }).catch(() => null);
      return fallbackResult(fallback, {
        budgetState: admission.budgetState,
        reason: error?.name === "AbortError" ? "timeout" : "request_failed",
        attempted: true
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function estimateRoute(input = {}) {
    const stops = normalizedRouteStops(input.stops, input.stayMinutes);
    const fallback = input.fallback || buildFallbackRoutePreview({
      stops,
      fallbackLegMinutes: input.fallbackLegMinutes,
      travelTimePercent: input.travelTimePercent,
      allowTolls: input.allowTolls
    });
    if (stops.length < 2) return fallbackResult(fallback, { reason: "insufficient_stops" });
    if (stops.length > MAX_STANDARD_ROUTE_STOPS && !input.trafficAware) {
      return fallbackResult(fallback, { reason: "waypoint_cost_guard" });
    }
    const waypoints = stops.map(routeWaypoint);
    if (waypoints.some((waypoint) => !waypoint)) {
      return fallbackResult(fallback, { reason: "invalid_stops" });
    }
    const fingerprint = input.fingerprint || googleMapsRouteFingerprint({ ...input, stops });
    pruneRecentRoutes();
    const recent = recentRoutes.get(fingerprint);
    if (recent && recent.expiresAt > currentEpoch()) {
      return { ...recent.result, googleAttempted: false, fallbackReason: "cooldown_reuse" };
    }
    if (recent) recentRoutes.delete(fingerprint);
    if (inFlight.has(fingerprint)) return inFlight.get(fingerprint);
    const promise = performRouteEstimate({ ...input, stops, waypoints }, fingerprint, fallback)
      .finally(() => inFlight.delete(fingerprint));
    inFlight.set(fingerprint, promise);
    return promise;
  }

  async function geocode({
    subsystem = "driver_geocode",
    reason = "driver_location_check",
    address = "",
    automatic = false,
    actorId = "",
    sessionId = ""
  } = {}) {
    const retained = String(address || "").trim();
    const requestApiKey = resolvedApiKey();
    if (!retained || !requestApiKey || typeof transport !== "function") return null;
    const fingerprint = googleMapsRouteFingerprint({ stops: [{ location: retained }] });
    let admission;
    try {
      admission = await admitUsage({
        subsystem,
        api: "geocoding",
        reason,
        fingerprint,
        automatic,
        units: 1,
        actorId,
        sessionId,
        mode: resolvedMode()
      });
    } catch {
      return null;
    }
    if (!admission?.admitted) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const startedAt = Date.now();
    try {
      const url = new URL(GEOCODING_URL);
      url.searchParams.set("address", retained);
      url.searchParams.set("region", "ca");
      url.searchParams.set("components", "country:CA");
      url.searchParams.set("key", requestApiKey);
      const response = await transport(url, { signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      const point = payload?.results?.[0]?.geometry?.location;
      const latitude = Number(point?.lat);
      const longitude = Number(point?.lng);
      const valid = response.ok && validCoordinate(latitude, longitude);
      await recordOutcome({
        ledgerId: admission.ledgerId,
        outcome: valid ? "succeeded" : "invalid_response",
        httpStatus: Number(response.status || 0),
        latencyMs: Date.now() - startedAt
      }).catch(() => null);
      return valid ? { latitude, longitude, source: "google_geocode", budgetState: admission.budgetState } : null;
    } catch (error) {
      await recordOutcome({
        ledgerId: admission.ledgerId,
        outcome: error?.name === "AbortError" ? "timeout" : "failed",
        latencyMs: Date.now() - startedAt
      }).catch(() => null);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({ estimateRoute, geocode });
}

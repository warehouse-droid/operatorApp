// @ts-check

export const DISPATCH_ACTUAL_ARRIVAL_ALGORITHM_VERSION = "terminal-cluster-v1";
export const DISPATCH_ACTUAL_ARRIVAL_PRIMARY_RADIUS_METERS = 150;
export const DISPATCH_ACTUAL_ARRIVAL_FALLBACK_RADIUS_METERS = 250;
export const DISPATCH_ACTUAL_ARRIVAL_MAX_POINT_GAP_MS = 2 * 60 * 1000;
export const DISPATCH_ACTUAL_ARRIVAL_PRIMARY_DWELL_MS = 60 * 1000;
export const DISPATCH_ACTUAL_ARRIVAL_FALLBACK_DWELL_MS = 2 * 60 * 1000;
export const DISPATCH_ACTUAL_ARRIVAL_SLOW_KMH = 5;
export const DISPATCH_ACTUAL_ARRIVAL_INITIAL_WINDOW_MS = 30 * 60 * 1000;

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") {return null;}
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function epoch(value) {
  if (value instanceof Date) {return Number.isFinite(value.getTime()) ? value.getTime() : null;}
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function pointValue(point = {}) {
  return point?.value && typeof point.value === "object" ? point.value : point;
}

/**
 * Normalize Samsara history, live-history, and retained local-history shapes.
 * Speed is returned in km/h even though Samsara normally reports mph.
 */
export function normalizeActualArrivalPoint(point = {}) {
  const value = pointValue(point);
  const latitude = finiteNumber(
    value.latitude
    ?? value.lat
    ?? value.latitudeDegrees
    ?? point.latitude
    ?? point.lat
  );
  const longitude = finiteNumber(
    value.longitude
    ?? value.lng
    ?? value.longitudeDegrees
    ?? point.longitude
    ?? point.lng
  );
  const timestamp = epoch(
    point.time
    ?? point.timestamp
    ?? point.locationTime
    ?? point.location_time
    ?? value.time
    ?? value.locatedAtTime
  );
  const explicitKmh = finiteNumber(value.speedKilometersPerHour ?? value.speedKmh ?? point.speedKmh);
  const mph = finiteNumber(
    value.speedMilesPerHour
    ?? value.speedMph
    ?? point.speedMilesPerHour
    ?? point.speed_miles_per_hour
  );
  const genericSpeed = finiteNumber(value.speed ?? point.speed);
  if (latitude === null || longitude === null || timestamp === null) {return null;}
  return {
    latitude,
    longitude,
    timestamp,
    time: new Date(timestamp).toISOString(),
    speedKmh: explicitKmh ?? (mph === null ? genericSpeed : mph * 1.609344),
    raw: point
  };
}

export function actualArrivalDistanceMeters(left = {}, right = {}) {
  const leftLatitude = finiteNumber(left.latitude ?? left.lat);
  const leftLongitude = finiteNumber(left.longitude ?? left.lng);
  const rightLatitude = finiteNumber(right.latitude ?? right.lat);
  const rightLongitude = finiteNumber(right.longitude ?? right.lng);
  if (
    leftLatitude === null
    || leftLongitude === null
    || rightLatitude === null
    || rightLongitude === null
  ) {return Number.POSITIVE_INFINITY;}
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(rightLatitude - leftLatitude);
  const longitudeDelta = radians(rightLongitude - leftLongitude);
  const startLatitude = radians(leftLatitude);
  const endLatitude = radians(rightLatitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function terminalClusters(points = [], destination = {}) {
  const clusters = [];
  let active = [];
  for (const point of points) {
    const distanceMeters = actualArrivalDistanceMeters(point, destination);
    if (distanceMeters > DISPATCH_ACTUAL_ARRIVAL_FALLBACK_RADIUS_METERS) {
      if (active.length) {clusters.push(active);}
      active = [];
      continue;
    }
    const annotated = { ...point, distanceMeters };
    const previous = active[active.length - 1];
    if (previous && annotated.timestamp - previous.timestamp > DISPATCH_ACTUAL_ARRIVAL_MAX_POINT_GAP_MS) {
      clusters.push(active);
      active = [];
    }
    active.push(annotated);
  }
  if (active.length) {clusters.push(active);}
  return clusters;
}

function qualifyCluster(points = []) {
  if (points.length < 2) {return null;}
  const clusterStart = points[0].timestamp;
  const clusterEnd = points[points.length - 1].timestamp;
  const spanMs = clusterEnd - clusterStart;
  const primaryPoints = points.filter((point) => point.distanceMeters <= DISPATCH_ACTUAL_ARRIVAL_PRIMARY_RADIUS_METERS);
  const slowPointCount = points.filter((point) =>
    point.speedKmh !== null
    && Number.isFinite(point.speedKmh)
    && point.speedKmh <= DISPATCH_ACTUAL_ARRIVAL_SLOW_KMH
  ).length;
  if (primaryPoints.length >= 2) {
    const primarySpanMs = primaryPoints[primaryPoints.length - 1].timestamp - primaryPoints[0].timestamp;
    if (primarySpanMs >= DISPATCH_ACTUAL_ARRIVAL_PRIMARY_DWELL_MS) {
      const minimumDistanceMeters = Math.min(...primaryPoints.map((point) => point.distanceMeters));
      return {
        arrival: primaryPoints[0],
        confidence: minimumDistanceMeters <= 100 ? "high" : "medium",
        radiusMeters: DISPATCH_ACTUAL_ARRIVAL_PRIMARY_RADIUS_METERS,
        clusterStart,
        clusterEnd,
        spanMs,
        pointCount: points.length,
        primaryPointCount: primaryPoints.length,
        slowPointCount,
        minimumDistanceMeters
      };
    }
  }
  if (spanMs < DISPATCH_ACTUAL_ARRIVAL_FALLBACK_DWELL_MS || slowPointCount === 0) {return null;}
  return {
    arrival: points[0],
    confidence: "medium",
    radiusMeters: DISPATCH_ACTUAL_ARRIVAL_FALLBACK_RADIUS_METERS,
    clusterStart,
    clusterEnd,
    spanMs,
    pointCount: points.length,
    primaryPointCount: primaryPoints.length,
    slowPointCount,
    minimumDistanceMeters: Math.min(...points.map((point) => point.distanceMeters))
  };
}

/**
 * Select the final sustained on-site cluster for one physical stop.
 * Earlier pass-bys are intentionally ignored even when they satisfy dwell rules.
 */
export function findFinalDestinationCluster({
  points = [],
  destination = {},
  windowStart,
  windowEnd
} = {}) {
  const start = epoch(windowStart);
  const end = epoch(windowEnd);
  if (start === null || end === null || end <= start) {
    return { status: "unresolved", reason: "invalid_time_window" };
  }
  if (
    finiteNumber(destination?.latitude ?? destination?.lat) === null
    || finiteNumber(destination?.longitude ?? destination?.lng) === null
  ) {
    return { status: "unresolved", reason: "destination_coordinates_unavailable" };
  }
  const normalized = points
    .map(normalizeActualArrivalPoint)
    .filter(Boolean)
    .filter((point) => point.timestamp >= start && point.timestamp <= end)
    .sort((left, right) => left.timestamp - right.timestamp);
  const qualified = terminalClusters(normalized, destination)
    .map(qualifyCluster)
    .filter(Boolean)
    .sort((left, right) => left.clusterEnd - right.clusterEnd);
  const selected = qualified[qualified.length - 1];
  if (!selected) {
    return {
      status: "unresolved",
      reason: normalized.length ? "no_sustained_destination_cluster" : "no_gps_points",
      pointCount: normalized.length
    };
  }
  return {
    status: "resolved",
    arrivalAt: selected.arrival.time,
    confidence: selected.confidence,
    radiusMeters: selected.radiusMeters,
    pointCount: normalized.length,
    clusterPointCount: selected.pointCount,
    primaryPointCount: selected.primaryPointCount,
    slowPointCount: selected.slowPointCount,
    minimumDistanceMeters: Math.round(selected.minimumDistanceMeters),
    clusterStartAt: new Date(selected.clusterStart).toISOString(),
    clusterEndAt: new Date(selected.clusterEnd).toISOString(),
    clusterSpanSeconds: Math.round(selected.spanMs / 1000)
  };
}

/** Build a bounded 30-minute first request and one non-overlapping fallback. */
export function actualArrivalHistoryWindows({ windowStart, windowEnd } = {}) {
  const start = epoch(windowStart);
  const end = epoch(windowEnd);
  if (start === null || end === null || end <= start) {return [];}
  const primaryStart = Math.max(start, end - DISPATCH_ACTUAL_ARRIVAL_INITIAL_WINDOW_MS);
  const windows = [{
    startTime: new Date(primaryStart).toISOString(),
    endTime: new Date(end).toISOString(),
    kind: "primary"
  }];
  if (primaryStart > start) {
    windows.push({
      startTime: new Date(start).toISOString(),
      endTime: new Date(primaryStart).toISOString(),
      kind: "expanded"
    });
  }
  return windows;
}

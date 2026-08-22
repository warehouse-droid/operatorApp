// @ts-check

import { performance } from "node:perf_hooks";
import { config } from "./config.js";
import {
  actualArrivalDistanceMeters,
  actualArrivalHistoryWindows,
  findFinalDestinationCluster
} from "./dispatch-actual-arrival-policy.js";
import {
  actualArrivalStateHash,
  applyActualArrivalRun,
  claimNextActualArrivalRun,
  getActualArrivalRun,
  listActualArrivalRouteRecords,
  localActualArrivalPoints,
  markActualArrivalRun,
  replaceActualArrivalRunResults
} from "./dispatch-actual-arrival-repository.js";
import { dispatchLocationsShareYard } from "./dispatch-location.js";
import { getDispatchPlan } from "./dispatch-plan-repository.js";
import {
  findSamsaraVehicleByPlate,
  listSamsaraVehicleGpsHistory,
  listSamsaraVehicleTrips
} from "./samsara.js";

const GOOGLE_GEOCODE_TIMEOUT_MS = 5_000;
const SAMSARA_STOP_HISTORY_BUDGET_MS = 10_000;

function text(value) {
  return String(value ?? "").trim();
}

function normalizedPlate(value) {
  return text(value).replace(/\s+/g, "").toUpperCase();
}

function iso(value) {
  if (!value) {return null;}
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function epoch(value) {
  const retained = iso(value);
  return retained ? new Date(retained).getTime() : null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") {return null;}
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function unique(values = []) {
  return [...new Set(values.map(text).filter(Boolean))];
}

function physicalJobIds(record = {}) {
  const values = record?.job_details?.physicalVisitJobIds;
  return Array.isArray(values) ? unique(values) : [];
}

function visitKey(record = {}) {
  const physical = physicalJobIds(record);
  const retained = physical.length ? physical : [record.job_id];
  return [
    record.plan_id || "legacy",
    text(record.driver_login).toLowerCase(),
    record.load_id || "",
    ...retained
  ].map((value) => encodeURIComponent(text(value))).join(":");
}

function destinationAddress(records = []) {
  for (const record of records) {
    const details = record.job_details || {};
    const dropoff = text(record.stop_type).toLowerCase() === "dropoff";
    const candidates = dropoff
      ? [details.dropAddress, details.address, details.dropLocation, details.location]
      : [details.address, details.pickupAddress, details.pickupLocation, details.location];
    const retained = candidates.map(text).find(Boolean);
    if (retained) {return retained;}
  }
  return "";
}

function buildPhysicalVisits(records = []) {
  const groups = new Map();
  for (const record of records) {
    const key = visitKey(record);
    if (!groups.has(key)) {groups.set(key, []);}
    groups.get(key).push(record);
  }
  return [...groups.entries()].map(([key, grouped]) => {
    const ordered = [...grouped].sort((left, right) => Number(left.id) - Number(right.id));
    const starts = ordered.map((row) => epoch(row.started_at)).filter(Number.isFinite);
    const completions = ordered.map((row) => epoch(row.completed_at)).filter(Number.isFinite);
    const arrivals = ordered.map((row) => epoch(row.actual_arrival_at)).filter(Number.isFinite);
    return {
      visitKey: key,
      records: ordered,
      recordIds: ordered.map((row) => Number(row.id)),
      jobIds: unique(ordered.map((row) => row.job_id)),
      planId: ordered.find((row) => row.plan_id !== null)?.plan_id || null,
      loadId: text(ordered[0]?.load_id),
      loadName: text(ordered[0]?.load_name),
      stopIds: unique(ordered.map((row) => row.stop_id)),
      orderRefs: unique(ordered.flatMap((row) => Array.isArray(row.order_refs) ? row.order_refs : [])),
      truckPlate: text(ordered.find((row) => text(row.truck_plate))?.truck_plate),
      destinationAddress: destinationAddress(ordered),
      pwaStartedAt: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
      completedAt: completions.length ? new Date(Math.max(...completions)).toISOString() : null,
      existingArrivalAt: arrivals.length ? new Date(Math.min(...arrivals)).toISOString() : null
    };
  }).filter((visit) => visit.completedAt)
    .sort((left, right) =>
      epoch(left.completedAt) - epoch(right.completedAt)
      || epoch(left.pwaStartedAt) - epoch(right.pwaStartedAt)
      || left.recordIds[0] - right.recordIds[0]
    );
}

function pointFromObject(value = {}) {
  if (!value || typeof value !== "object") {return null;}
  const latitude = finiteNumber(
    value.latitude
    ?? value.lat
    ?? value.latitudeDegrees
    ?? value.geometry?.location?.lat
  );
  const longitude = finiteNumber(
    value.longitude
    ?? value.lng
    ?? value.longitudeDegrees
    ?? value.geometry?.location?.lng
  );
  return latitude === null || longitude === null ? null : { latitude, longitude };
}

function pointFromRecordEvidence(visit = {}) {
  for (const record of visit.records || []) {
    const details = record.location_details || {};
    const point = pointFromObject({
      latitude: details.expectedLatitude ?? details.expected?.latitude,
      longitude: details.expectedLongitude ?? details.expected?.longitude
    });
    if (point) {return { ...point, source: "driver_location_evidence" };}
  }
  return null;
}

async function planStopPoints(visits = []) {
  const planIds = unique(visits.map((visit) => visit.planId));
  const byVisit = new Map();
  for (const planId of planIds) {
    const plan = await getDispatchPlan(planId).catch(() => null);
    if (!plan) {continue;}
    for (const truck of plan.trucks || []) {
      for (const load of truck.loads || []) {
        for (const stop of load.stops || []) {
          const point = pointFromObject(stop.routeLocation)
            || pointFromObject(stop)
            || pointFromObject(stop.coordinates);
          if (!point) {continue;}
          byVisit.set(`${planId}|${text(load.id)}|${text(stop.id)}`, {
            ...point,
            source: "dispatch_plan_snapshot"
          });
        }
      }
    }
  }
  return byVisit;
}

function normalizedPlace(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function ownYardPoint(visit = {}, ownYards = []) {
  const candidates = [visit.destinationAddress, ...visit.records.flatMap((record) => {
    const details = record.job_details || {};
    return [details.location, details.pickupLocation, details.dropLocation, details.address, details.dropAddress];
  })].map(text).filter(Boolean);
  for (const yard of ownYards || []) {
    const point = pointFromObject(yard);
    if (!point) {continue;}
    const yardCandidates = [yard.code, yard.name, yard.address].map(text).filter(Boolean);
    if (candidates.some((candidate) => yardCandidates.some((yardValue) =>
      normalizedPlace(candidate) === normalizedPlace(yardValue)
      || dispatchLocationsShareYard(candidate, yardValue)
    ))) {
      return { ...point, source: "dispatch_own_yard" };
    }
  }
  return null;
}

const geocodeCache = new Map();

async function geocodeAddress(address) {
  const retained = text(address);
  const key = normalizedPlace(retained);
  if (!key || !config.googleMapsApiKey) {return null;}
  if (geocodeCache.has(key)) {return geocodeCache.get(key);}
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_GEOCODE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", retained);
    url.searchParams.set("key", config.googleMapsApiKey);
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {throw new Error(`Google geocode returned HTTP ${response.status}.`);}
    const payload = await response.json();
    const point = pointFromObject(payload.results?.[0]);
    const resolved = point ? { ...point, source: "google_geocode" } : null;
    geocodeCache.set(key, resolved);
    return resolved;
  } finally {
    clearTimeout(timer);
  }
}

async function destinationPoint(visit, planPoints, ownYards) {
  const evidence = pointFromRecordEvidence(visit);
  if (evidence) {return evidence;}
  for (const stopId of visit.stopIds || []) {
    const point = planPoints.get(`${visit.planId}|${visit.loadId}|${stopId}`);
    if (point) {return point;}
  }
  const yard = ownYardPoint(visit, ownYards);
  if (yard) {return yard;}
  const geocoded = await geocodeAddress(visit.destinationAddress).catch(() => null);
  return geocoded || null;
}

function samePhysicalPlace(previous, current, previousPoint, currentPoint) {
  if (
    previous.destinationAddress
    && current.destinationAddress
    && (
      normalizedPlace(previous.destinationAddress) === normalizedPlace(current.destinationAddress)
      || dispatchLocationsShareYard(previous.destinationAddress, current.destinationAddress)
    )
  ) {return true;}
  return previousPoint && currentPoint
    ? actualArrivalDistanceMeters(previousPoint, currentPoint) <= 50
    : false;
}

function nextTorontoElevenPm(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const desired = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 23, 0, 0, 0);
  let candidate = desired;
  for (let pass = 0; pass < 3; pass += 1) {
    const represented = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
    const representedEpoch = Date.UTC(
      Number(represented.year),
      Number(represented.month) - 1,
      Number(represented.day),
      Number(represented.hour),
      Number(represented.minute),
      Number(represented.second)
    );
    candidate += desired - representedEpoch;
  }
  if (candidate > now.getTime()) {return new Date(candidate).toISOString();}
  const tomorrow = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1));
  return nextTorontoElevenPm(new Date(tomorrow.getTime() + 12 * 60 * 60 * 1000));
}

function tripEndPoint(trip = {}) {
  return pointFromObject(
    trip.endLocation
    || trip.end?.location
    || trip.endAddress
    || trip.end
    || {}
  );
}

function tripEndEpoch(trip = {}) {
  const raw = trip.endMs ?? trip.endTimeMs ?? trip.endTime ?? trip.end?.time;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {return numeric < 10_000_000_000 ? numeric * 1000 : numeric;}
  return epoch(raw);
}

function matchingTripHints(trips = [], destination, windowStart, windowEnd) {
  const start = epoch(windowStart);
  const end = epoch(windowEnd);
  return trips.filter((trip) => {
    const endedAt = tripEndEpoch(trip);
    const point = tripEndPoint(trip);
    return Number.isFinite(endedAt)
      && endedAt >= start
      && endedAt <= end
      && point
      && actualArrivalDistanceMeters(point, destination) <= 500;
  }).length;
}

function unresolvedResult(visit, previous, sequence, reason, details = {}) {
  return {
    visitKey: visit.visitKey,
    sequence,
    planId: visit.planId,
    loadId: visit.loadId,
    loadName: visit.loadName,
    stopIds: visit.stopIds,
    orderRefs: visit.orderRefs,
    driverJobRecordIds: visit.recordIds,
    truckPlate: visit.truckPlate,
    destinationAddress: visit.destinationAddress,
    destinationLatitude: details.destination?.latitude ?? null,
    destinationLongitude: details.destination?.longitude ?? null,
    previousCompletedAt: previous?.completedAt || null,
    pwaStartedAt: visit.pwaStartedAt,
    completedAt: visit.completedAt,
    existingArrivalAt: visit.existingArrivalAt,
    proposedArrivalAt: null,
    resolutionStatus: "unresolved",
    source: "",
    confidence: "",
    stateHash: actualArrivalStateHash(visit.records),
    evidence: details.evidence || {},
    error: reason
  };
}

async function resolveVisit({
  visit,
  previous,
  sequence,
  destination,
  previousDestination,
  samsaraContext
}) {
  const base = {
    visitKey: visit.visitKey,
    sequence,
    planId: visit.planId,
    loadId: visit.loadId,
    loadName: visit.loadName,
    stopIds: visit.stopIds,
    orderRefs: visit.orderRefs,
    driverJobRecordIds: visit.recordIds,
    truckPlate: visit.truckPlate,
    destinationAddress: visit.destinationAddress,
    destinationLatitude: destination?.latitude ?? null,
    destinationLongitude: destination?.longitude ?? null,
    previousCompletedAt: previous?.completedAt || null,
    pwaStartedAt: visit.pwaStartedAt,
    completedAt: visit.completedAt,
    existingArrivalAt: visit.existingArrivalAt,
    stateHash: actualArrivalStateHash(visit.records)
  };
  if (!previous) {
    return {
      ...base,
      proposedArrivalAt: null,
      resolutionStatus: "first_stop",
      source: "pwa_started_at",
      confidence: "explicit",
      evidence: { reason: "first_physical_stop_of_driver_day" },
      error: ""
    };
  }
  const start = epoch(previous.completedAt);
  const end = epoch(visit.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return unresolvedResult(visit, previous, sequence, "invalid_time_window", { destination });
  }
  if (!destination) {
    return unresolvedResult(visit, previous, sequence, "destination_coordinates_unavailable");
  }
  if (samePhysicalPlace(previous, visit, previousDestination, destination)) {
    return {
      ...base,
      proposedArrivalAt: previous.completedAt,
      resolutionStatus: "same_site",
      source: "same_site_sequence",
      confidence: "high",
      evidence: { distanceMeters: previousDestination ? Math.round(actualArrivalDistanceMeters(previousDestination, destination)) : 0 },
      error: ""
    };
  }

  const localStarted = performance.now();
  const localPoints = await localActualArrivalPoints({
    truckPlate: visit.truckPlate,
    startTime: previous.completedAt,
    endTime: visit.completedAt
  });
  const localResolution = findFinalDestinationCluster({
    points: localPoints,
    destination,
    windowStart: previous.completedAt,
    windowEnd: visit.completedAt
  });
  const localCalculationMs = performance.now() - localStarted;
  if (localResolution.status === "resolved") {
    return {
      ...base,
      proposedArrivalAt: localResolution.arrivalAt,
      resolutionStatus: "resolved",
      source: "dispatch_location_history",
      confidence: localResolution.confidence,
      evidence: {
        destinationSource: destination.source || "",
        localPointCount: localPoints.length,
        calculationMs: Number(localCalculationMs.toFixed(3)),
        ...localResolution
      },
      error: ""
    };
  }
  if (!visit.truckPlate) {
    return unresolvedResult(visit, previous, sequence, "truck_plate_unavailable", {
      destination,
      evidence: { localPointCount: localPoints.length }
    });
  }

  const plate = normalizedPlate(visit.truckPlate);
  let vehiclePromise = samsaraContext.vehicles.get(plate);
  if (!vehiclePromise) {
    vehiclePromise = findSamsaraVehicleByPlate(visit.truckPlate);
    samsaraContext.vehicles.set(plate, vehiclePromise);
  }
  let vehicle;
  try {
    vehicle = await vehiclePromise;
  } catch (error) {
    return unresolvedResult(visit, previous, sequence, "samsara_vehicle_lookup_failed", {
      destination,
      evidence: { message: text(error?.message || error), localPointCount: localPoints.length }
    });
  }
  if (!vehicle?.id) {
    return unresolvedResult(visit, previous, sequence, "samsara_vehicle_not_found", {
      destination,
      evidence: { localPointCount: localPoints.length }
    });
  }

  const tripCacheKey = `${vehicle.id}|${visit.records[0]?.plan_date || ""}`;
  let tripPromise = samsaraContext.trips.get(tripCacheKey);
  if (!tripPromise) {
    const routeStart = samsaraContext.routeStart;
    const routeEnd = samsaraContext.routeEnd;
    tripPromise = listSamsaraVehicleTrips({ vehicleId: vehicle.id, startTime: routeStart, endTime: routeEnd });
    samsaraContext.trips.set(tripCacheKey, tripPromise);
  }
  const windows = actualArrivalHistoryWindows({
    windowStart: previous.completedAt,
    windowEnd: visit.completedAt
  });
  const points = [];
  const requestEvidence = [];
  const historyDeadlineAt = Date.now() + SAMSARA_STOP_HISTORY_BUDGET_MS;
  const primaryPromise = windows[0]
    ? listSamsaraVehicleGpsHistory({
        vehicleId: vehicle.id,
        ...windows[0],
        deadlineAt: historyDeadlineAt
      })
    : Promise.resolve({ points: [], requestCount: 0, durationMs: 0 });
  const [tripOutcome, primaryOutcome] = await Promise.allSettled([tripPromise, primaryPromise]);
  if (primaryOutcome.status === "fulfilled") {
    points.push(...primaryOutcome.value.points);
    requestEvidence.push({
      kind: windows[0]?.kind || "primary",
      requestCount: primaryOutcome.value.requestCount,
      pointCount: primaryOutcome.value.points.length,
      durationMs: primaryOutcome.value.durationMs,
      truncated: primaryOutcome.value.truncated === true
    });
  } else {
    requestEvidence.push({ kind: "primary", error: text(primaryOutcome.reason?.message || primaryOutcome.reason) });
  }
  let calculationStarted = performance.now();
  let resolution = findFinalDestinationCluster({
    points,
    destination,
    windowStart: previous.completedAt,
    windowEnd: visit.completedAt
  });
  let calculationMs = performance.now() - calculationStarted;
  if (resolution.status !== "resolved" && windows[1]) {
    try {
      const expanded = await listSamsaraVehicleGpsHistory({
        vehicleId: vehicle.id,
        ...windows[1],
        deadlineAt: historyDeadlineAt
      });
      points.push(...expanded.points);
      requestEvidence.push({
        kind: windows[1].kind,
        requestCount: expanded.requestCount,
        pointCount: expanded.points.length,
        durationMs: expanded.durationMs,
        truncated: expanded.truncated === true
      });
      calculationStarted = performance.now();
      resolution = findFinalDestinationCluster({
        points,
        destination,
        windowStart: previous.completedAt,
        windowEnd: visit.completedAt
      });
      calculationMs += performance.now() - calculationStarted;
    } catch (error) {
      requestEvidence.push({ kind: "expanded", error: text(error?.message || error) });
    }
  }
  const tripHints = tripOutcome.status === "fulfilled"
    ? matchingTripHints(tripOutcome.value.trips, destination, previous.completedAt, visit.completedAt)
    : 0;
  const evidence = {
    destinationSource: destination.source || "",
    vehicleId: text(vehicle.id),
    vehicleName: text(vehicle.name),
    localPointCount: localPoints.length,
    tripHintCount: tripHints,
    tripLookupMs: tripOutcome.status === "fulfilled" ? tripOutcome.value.durationMs : null,
    tripError: tripOutcome.status === "rejected" ? text(tripOutcome.reason?.message || tripOutcome.reason) : "",
    requests: requestEvidence,
    historyBudgetMs: SAMSARA_STOP_HISTORY_BUDGET_MS,
    calculationMs: Number(calculationMs.toFixed(3)),
    ...resolution
  };
  if (resolution.status !== "resolved") {
    return unresolvedResult(visit, previous, sequence, resolution.reason || "samsara_arrival_unresolved", {
      destination,
      evidence
    });
  }
  return {
    ...base,
    proposedArrivalAt: resolution.arrivalAt,
    resolutionStatus: "resolved",
    source: "samsara_gps_history",
    confidence: resolution.confidence,
    evidence,
    error: ""
  };
}

export async function executeActualArrivalRun(run, {
  ownYards = [],
  isGateEnabled = async () => true
} = {}) {
  const current = run?.runId ? run : await getActualArrivalRun(run);
  if (!current) {throw Object.assign(new Error("Arrival calculation run was not found."), { status: 404 });}
  const records = await listActualArrivalRouteRecords({
    planDate: current.planDate,
    driverLogin: current.driverLogin
  });
  const visits = buildPhysicalVisits(records);
  if (!visits.length) {
    return markActualArrivalRun(current.runId, "failed", {
      error: "No completed physical stops remain for this driver and date."
    });
  }
  const planPoints = await planStopPoints(visits);
  const destinations = new Map();
  for (const visit of visits) {
    destinations.set(visit.visitKey, await destinationPoint(visit, planPoints, ownYards));
  }
  let selected = visits;
  if (current.mode === "automatic") {
    selected = visits.filter((visit) => visit.recordIds.includes(Number(current.triggerJobRecordId)));
    if (!selected.length) {
      return markActualArrivalRun(current.runId, "failed", {
        error: "The completed physical visit for this automatic calculation was not found."
      });
    }
  }
  const samsaraContext = {
    vehicles: new Map(),
    trips: new Map(),
    routeStart: visits[0]?.pwaStartedAt || visits[0]?.completedAt,
    routeEnd: visits[visits.length - 1]?.completedAt
  };
  const results = [];
  for (const visit of selected) {
    const sequence = visits.indexOf(visit);
    const previous = sequence > 0 ? visits[sequence - 1] : null;
    results.push(await resolveVisit({
      visit,
      previous,
      sequence,
      destination: destinations.get(visit.visitKey),
      previousDestination: previous ? destinations.get(previous.visitKey) : null,
      samsaraContext
    }));
  }
  if (!(await isGateEnabled())) {
    return markActualArrivalRun(current.runId, "suppressed_gate_off", {
      error: "Actual stop arrival calculation was disabled before results could be retained."
    });
  }
  if (current.mode === "historical") {
    return replaceActualArrivalRunResults(current.runId, results, { status: "preview_ready" });
  }
  const unresolved = results.some((result) => result.resolutionStatus === "unresolved");
  if (unresolved) {
    const exhausted = Number(current.attemptCount) >= 2;
    return replaceActualArrivalRunResults(current.runId, results, {
      status: exhausted ? "needs_review" : "retry_wait",
      nextAttemptAt: exhausted ? null : nextTorontoElevenPm(),
      error: exhausted
        ? "Samsara did not produce a qualified destination cluster after the nightly retry."
        : "Samsara did not produce a qualified destination cluster; retry scheduled for 11:00 PM Toronto time."
    });
  }
  await replaceActualArrivalRunResults(current.runId, results, { status: "running" });
  if (!(await isGateEnabled())) {
    return markActualArrivalRun(current.runId, "suppressed_gate_off", {
      error: "Actual stop arrival calculation was disabled before apply."
    });
  }
  return applyActualArrivalRun(current.runId, {
    appliedBy: "system:actual-arrival-worker",
    automatic: true
  });
}

export async function actualArrivalWorkerTick({
  workerId,
  ownYards = [],
  isGateEnabled = async () => false
} = {}) {
  const run = await claimNextActualArrivalRun({ workerId });
  if (!run) {return { claimed: false, run: null };}
  if (!(await isGateEnabled())) {
    const suppressed = await markActualArrivalRun(run.runId, "suppressed_gate_off", {
      error: "Actual stop arrival calculation is disabled."
    });
    return { claimed: true, run: suppressed };
  }
  try {
    return {
      claimed: true,
      run: await executeActualArrivalRun(run, { ownYards, isGateEnabled })
    };
  } catch (error) {
    const automatic = run.mode === "automatic";
    const exhausted = automatic && Number(run.attemptCount) >= 2;
    const status = exhausted ? "needs_review" : automatic ? "retry_wait" : "failed";
    const failed = await markActualArrivalRun(run.runId, status, {
      error: text(error?.message || error),
      nextAttemptAt: status === "retry_wait" ? nextTorontoElevenPm() : null
    });
    return { claimed: true, run: failed, error };
  }
}

export const actualArrivalServiceInternals = {
  buildPhysicalVisits,
  nextTorontoElevenPm,
  samePhysicalPlace
};

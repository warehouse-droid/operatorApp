import {
  dispatchLoadAssignment,
  dispatchMinute,
  dispatchPhysicalStopVisits
} from "./dispatch-load-assignment.js";
import { planJobsForDriver, samePhysicalAddress as sameDriverPhysicalAddress } from "./driver-repository.js";

export const DISPATCH_FORECAST_TIME_ZONE = "America/Toronto";

const MINUTE_MS = 60 * 1000;
const YARD_ADDRESSES = {
  "3445": "3445 Kennedy Road, Toronto, ON",
  "2967": "2967 Kennedy Road, Toronto, ON",
  "12441": "12441 Woodbine Avenue, Whitchurch-Stouffville, ON",
  "150": "150 Clark Blvd, Brampton, ON L6T 4Y8, Canada"
};

function text(value) {
  return String(value ?? "").trim();
}

function driverKey(value) {
  return text(value).toLowerCase();
}

function finiteMinute(value) {
  const minute = dispatchMinute(value);
  return Number.isFinite(minute) ? minute : null;
}

function dateValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function epochValue(value) {
  return dateValue(value)?.getTime() ?? null;
}

function isoValue(value) {
  const epoch = typeof value === "number" ? value : epochValue(value);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

function torontoParts(epoch) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPATCH_FORECAST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(epoch));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

/** Convert a plan-date minute boundary to its absolute Toronto instant. */
export function dispatchTorontoMinuteEpoch(planDate, minuteValue) {
  const match = text(planDate).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const minute = Number(minuteValue);
  if (!match || !Number.isFinite(minute)) return null;
  const totalMinutes = Math.round(minute);
  const desiredLocalEpoch = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    0,
    totalMinutes,
    0,
    0
  );
  let result = desiredLocalEpoch;
  // Resolve the Toronto UTC offset at the desired civil time. Repeating also
  // handles an offset transition between the initial guess and final instant.
  for (let pass = 0; pass < 3; pass += 1) {
    const parts = torontoParts(result);
    const representedLocalEpoch = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    const adjusted = result + (desiredLocalEpoch - representedLocalEpoch);
    if (adjusted === result) break;
    result = adjusted;
  }
  return result;
}

export function dispatchTorontoMinuteIso(planDate, minuteValue) {
  return isoValue(dispatchTorontoMinuteEpoch(planDate, minuteValue));
}

function recordValue(record = {}, snake, camel) {
  return record?.[snake] ?? record?.[camel];
}

function recordStatus(record = {}) {
  return text(record?.status).toLowerCase();
}

function recordStartedEpoch(record = {}) {
  return epochValue(recordValue(record, "started_at", "startedAt"));
}

function recordCompletedEpoch(record = {}) {
  return epochValue(recordValue(record, "completed_at", "completedAt"));
}

function normalizedPlace(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function orderByRef(plan = {}, orderRef = "") {
  const wanted = text(orderRef);
  if (!wanted) return null;
  const find = (order = {}) => {
    if (text(order.id) === wanted || text(order.originalOrderId) === wanted) return order;
    for (const child of order.childOrderDetails || []) {
      const match = find(child);
      if (match) return match;
    }
    return null;
  };
  for (const order of plan.orders || []) {
    const match = find(order);
    if (match) return match;
  }
  return null;
}

function stopLocation(plan = {}, stop = {}) {
  const order = orderByRef(plan, stop.orderId) || {};
  if (["pick", "pickup"].includes(text(stop.type).toLowerCase())) {
    return text(stop.location || stop.yard || order.sourceYard || order.source_yard);
  }
  return text(
    stop.dropLocation
    || stop.drop_location
    || stop.destinationYard
    || stop.destination_yard
    || order.destinationYard
    || order.destination_yard
    || order.toLocation
    || order.to_location
    || order.address
    || order.dropAddress
    || stop.location
    || stop.orderId
  );
}

function stopAddress(plan = {}, stop = {}) {
  const order = orderByRef(plan, stop.orderId) || {};
  if (["pick", "pickup"].includes(text(stop.type).toLowerCase())) {
    const location = stopLocation(plan, stop);
    return text(
      stop.address
      || order.pickupAddressOverride
      || order.pickup_address_override
      || YARD_ADDRESSES[location]
      || order.sourceAddress
      || order.source_address
      || order.defaultSourceAddress
      || location
    );
  }
  const location = stopLocation(plan, stop);
  return text(
    stop.dropAddress
    || stop.drop_address
    || stop.address
    || order.destinationAddress
    || order.destination_address
    || order.dropAddress
    || order.drop_address
    || order.address
    || YARD_ADDRESSES[location]
    || location
  );
}

function recordForStop(records = [], assignment = {}, load = {}, stop = {}) {
  const loadId = text(load.id);
  const stopId = text(stop.id);
  const expectedType = ["pick", "pickup"].includes(text(stop.type).toLowerCase()) ? "pickup" : "dropoff";
  const exact = records.find((record) =>
    text(recordValue(record, "load_id", "loadId")) === loadId
    && text(recordValue(record, "stop_id", "stopId")) === stopId
    && (!assignment.driverLogin || driverKey(recordValue(record, "driver_login", "driverLogin")) === assignment.driverLogin)
  );
  if (exact) return exact;
  // Legacy records may not have retained a stop ID. Keep this fallback narrow
  // to the same load, physical type, and order reference.
  return records.find((record) => {
    if (text(recordValue(record, "load_id", "loadId")) !== loadId) return false;
    if (text(recordValue(record, "stop_id", "stopId"))) return false;
    const type = text(recordValue(record, "stop_type", "stopType")).toLowerCase();
    if (type !== expectedType && type !== text(stop.type).toLowerCase()) return false;
    const refs = recordValue(record, "order_refs", "orderRefs");
    return Array.isArray(refs) && refs.map(String).includes(String(stop.orderId || ""));
  }) || null;
}

function physicalVisitActuals(visit = {}, records = [], assignment = {}, load = {}) {
  const matched = visit.entries.map((entry) => recordForStop(records, assignment, load, entry.stop));
  const active = matched.filter((record) => ["in_progress", "complete"].includes(recordStatus(record)));
  const starts = active.map(recordStartedEpoch).filter(Number.isFinite);
  const allComplete = matched.length > 0 && matched.every((record) => recordStatus(record) === "complete");
  const completions = allComplete ? matched.map(recordCompletedEpoch).filter(Number.isFinite) : [];
  return {
    actualStart: starts.length ? Math.min(...starts) : null,
    actualEnd: allComplete && completions.length === matched.length ? Math.max(...completions) : null,
    status: allComplete && completions.length === matched.length
      ? "complete"
      : active.length ? "in_progress" : "pending"
  };
}

function sortedLaneEntries(plan = {}) {
  const lanes = new Map();
  let ordinal = 0;
  for (const parentTruck of plan.trucks || []) {
    for (const [loadIndex, load] of (parentTruck.loads || []).entries()) {
      const assignment = dispatchLoadAssignment(parentTruck, load, { driverSequence: loadIndex });
      const laneKey = assignment.driverLogin || `unassigned:${text(parentTruck.id || parentTruck.plate)}:${loadIndex}`;
      if (!lanes.has(laneKey)) lanes.set(laneKey, []);
      lanes.get(laneKey).push({ parentTruck, load, assignment, loadIndex, ordinal: ordinal++ });
    }
  }
  for (const entries of lanes.values()) {
    entries.sort((left, right) =>
      left.assignment.driverSequence - right.assignment.driverSequence
      || (left.assignment.plannedStartMinute ?? Number.MAX_SAFE_INTEGER) - (right.assignment.plannedStartMinute ?? Number.MAX_SAFE_INTEGER)
      || left.ordinal - right.ordinal
    );
  }
  return lanes;
}

function visitMinute(visit = {}, field = "arrival") {
  const values = visit.entries
    .map((entry) => finiteMinute(entry.stop?.timing?.[field]))
    .filter(Number.isFinite);
  if (!values.length) return null;
  return field === "arrival" ? Math.min(...values) : Math.max(...values);
}

function laneVisitRows(plan, laneEntries, records, planningProfiles = new Map()) {
  const rows = [];
  for (const entry of laneEntries) {
    const { parentTruck, load, assignment } = entry;
    if (load.returnOnly) continue;
    const visits = dispatchPhysicalStopVisits(plan, parentTruck, load, {
      planningProfile: planningProfiles.get(assignment.driverLogin) || null
    });
    let correctedCursor = assignment.plannedStartMinute;
    let previousRawDepart = null;
    for (const [visitIndex, visit] of visits.entries()) {
      const rawArrival = visitMinute(visit, "arrival");
      const rawDepart = visitMinute(visit, "depart");
      let plannedArrivalMinute;
      if (visitIndex === 0) {
        plannedArrivalMinute = rawArrival
          ?? (rawDepart === null ? null : rawDepart - Number(visit.plannedMinutes || 0))
          ?? correctedCursor
          ?? 0;
      } else {
        // Preserve only the route/travel gap from the old logical schedule.
        // Rebuilding from the corrected physical-visit cursor removes duplicate
        // per-order dwell time that an older grouped-stop plan may contain.
        const travelGap = rawArrival !== null && previousRawDepart !== null
          ? Math.max(0, rawArrival - previousRawDepart)
          : 0;
        plannedArrivalMinute = Number(correctedCursor ?? rawArrival ?? 0) + travelGap;
      }
      const plannedLeaveMinute = plannedArrivalMinute + Math.max(0, Number(visit.plannedMinutes || 0));
      correctedCursor = plannedLeaveMinute;
      previousRawDepart = rawDepart ?? rawArrival ?? plannedLeaveMinute;
      const firstStop = visit.entries[0]?.stop || {};
      const actual = physicalVisitActuals(visit, records, assignment, load);
      rows.push({
        internalId: `visit:${text(load.id)}:${visit.id}`,
        laneKey: assignment.driverLogin,
        loadId: text(load.id),
        load,
        assignment,
        visit,
        firstStop,
        lastStop: visit.entries[visit.entries.length - 1]?.stop || firstStop,
        from: stopLocation(plan, firstStop) || visit.address,
        address: stopAddress(plan, firstStop) || visit.address,
        addressKey: normalizedPlace(stopAddress(plan, firstStop) || visit.address),
        plannedStart: dispatchTorontoMinuteEpoch(plan.planDate, plannedArrivalMinute),
        plannedEnd: dispatchTorontoMinuteEpoch(plan.planDate, plannedLeaveMinute),
        ...actual,
        kind: "visit"
      });
    }
  }
  return rows;
}

function expectedLaneJobs(plan, laneKey) {
  if (!laneKey || laneKey.startsWith("unassigned:")) return [];
  return planJobsForDriver(plan, laneKey);
}

function expectedTravelJobs(plan, laneKey) {
  return expectedLaneJobs(plan, laneKey).filter((job) => job.stopType === "travel");
}

function explicitRecordForJob(records, expectedJob) {
  if (!expectedJob) return null;
  return records.find((record) => text(recordValue(record, "job_id", "jobId")) === text(expectedJob.jobId))
    || records.find((record) =>
      text(recordValue(record, "load_id", "loadId")) === text(expectedJob.loadId)
      && text(recordValue(record, "stop_id", "stopId")) === text(expectedJob.stopId)
      && text(recordValue(record, "stop_type", "stopType")).toLowerCase() === "travel"
    )
    || null;
}

function exactRecordForTimelineJob(records = [], expectedJob = null) {
  if (!expectedJob?.jobId) return null;
  const exact = records.filter((record) =>
    text(recordValue(record, "job_id", "jobId")) === text(expectedJob.jobId)
  );
  if (!exact.length) return null;
  // A retry must keep the durable completed result authoritative even if a
  // caller supplied an unordered status collection containing an older row.
  return exact.sort((left, right) => {
    const leftComplete = recordStatus(left) === "complete" ? 1 : 0;
    const rightComplete = recordStatus(right) === "complete" ? 1 : 0;
    return rightComplete - leftComplete
      || (recordCompletedEpoch(right) ?? -Infinity) - (recordCompletedEpoch(left) ?? -Infinity)
      || (recordStartedEpoch(right) ?? -Infinity) - (recordStartedEpoch(left) ?? -Infinity);
  })[0];
}

function travelInterval({
  plan,
  loadId,
  kind,
  from,
  to,
  plannedStartMinute,
  plannedEndMinute,
  expectedJob = null,
  explicitRecord = null,
  inferredStart = null,
  inferredEnd = null,
  ordinal = 0
}) {
  const actualStart = explicitRecord ? recordStartedEpoch(explicitRecord) : inferredStart;
  const actualEnd = explicitRecord ? recordCompletedEpoch(explicitRecord) : inferredEnd;
  const explicitStatus = explicitRecord ? recordStatus(explicitRecord) : "";
  const status = explicitRecord
    ? (explicitStatus || (actualEnd ? "complete" : actualStart ? "in_progress" : "pending"))
    : actualEnd ? "complete" : actualStart ? "in_progress" : "pending";
  const jobId = expectedJob?.jobId || null;
  return {
    internalId: `travel:${jobId || `${loadId}:${kind}:${ordinal}`}`,
    laneKey: expectedJob?.driverLogin || "",
    loadId: text(loadId),
    kind,
    from: text(from),
    to: text(to),
    plannedStart: dispatchTorontoMinuteEpoch(plan.planDate, plannedStartMinute),
    plannedEnd: dispatchTorontoMinuteEpoch(plan.planDate, plannedEndMinute),
    actualStart,
    actualEnd,
    status,
    expectedJob,
    jobId,
    source: explicitRecord ? "explicit" : "inferred"
  };
}

function buildLaneTravelRows(plan, laneEntries, visits, records, laneKey) {
  const expected = expectedTravelJobs(plan, laneKey);
  const usedJobs = new Set();
  const travelRows = [];
  let ordinal = 0;
  const visitsByLoad = new Map();
  for (const visit of visits) {
    if (!visitsByLoad.has(visit.loadId)) visitsByLoad.set(visit.loadId, []);
    visitsByLoad.get(visit.loadId).push(visit);
  }

  const useExpected = (predicate) => {
    const job = expected.find((candidate) => !usedJobs.has(candidate.jobId) && predicate(candidate)) || null;
    if (job) usedJobs.add(job.jobId);
    return job;
  };

  for (const laneEntry of laneEntries) {
    const { load, assignment } = laneEntry;
    const loadId = text(load.id);
    const loadVisits = visitsByLoad.get(loadId) || [];
    const handoffJobs = expected.filter((job) =>
      !usedJobs.has(job.jobId) && text(job.loadId) === loadId && job.handoffTravel === true
    );
    for (const job of handoffJobs) {
      usedJobs.add(job.jobId);
      travelRows.push(travelInterval({
        plan,
        loadId,
        kind: "handoff",
        from: job.fromLocation,
        to: job.toLocation,
        plannedStartMinute: finiteMinute(job.plannedStartMinute) ?? assignment.plannedStartMinute ?? 0,
        plannedEndMinute: finiteMinute(job.plannedFinishMinute) ?? assignment.plannedStartMinute ?? 0,
        expectedJob: job,
        explicitRecord: explicitRecordForJob(records, job),
        ordinal: ordinal++
      }));
    }

    if (load.returnOnly) {
      const job = useExpected((candidate) =>
        text(candidate.loadId) === loadId && text(candidate.stopId).startsWith("return-")
      );
      if (!job) continue;
      travelRows.push(travelInterval({
        plan,
        loadId,
        kind: "return",
        from: job.fromLocation,
        to: job.toLocation,
        plannedStartMinute: assignment.plannedStartMinute ?? finiteMinute(load.timing?.start) ?? 0,
        plannedEndMinute: assignment.plannedFinishMinute ?? finiteMinute(load.timing?.finish) ?? assignment.plannedStartMinute ?? 0,
        expectedJob: job,
        explicitRecord: explicitRecordForJob(records, job),
        ordinal: ordinal++
      }));
      continue;
    }

    const firstVisit = loadVisits[0];
    if (firstVisit) {
      const job = useExpected((candidate) =>
        text(candidate.loadId) === loadId
        && candidate.handoffTravel !== true
        && !text(candidate.stopId).startsWith("return-")
        && Number(candidate.sequence?.stopIndex ?? -1) < 0
      );
      if (job) {
        travelRows.push(travelInterval({
          plan,
          loadId,
          kind: "start",
          from: job.fromLocation,
          to: job.toLocation,
          plannedStartMinute: assignment.plannedStartMinute ?? finiteMinute(load.timing?.start) ?? 0,
          plannedEndMinute: (firstVisit.plannedStart - dispatchTorontoMinuteEpoch(plan.planDate, 0)) / MINUTE_MS,
          expectedJob: job,
          explicitRecord: explicitRecordForJob(records, job),
          ordinal: ordinal++
        }));
      }
    }

    for (let index = 1; index < loadVisits.length; index += 1) {
      const previous = loadVisits[index - 1];
      const current = loadVisits[index];
      if (
        (previous.addressKey && current.addressKey && previous.addressKey === current.addressKey)
        || sameDriverPhysicalAddress(previous.address, current.address)
      ) continue;
      const lastStopId = text(previous.lastStop?.id);
      const firstStopId = text(current.firstStop?.id);
      const expectedStopId = `travel-${lastStopId}-${firstStopId}`;
      const job = useExpected((candidate) =>
        text(candidate.loadId) === loadId && text(candidate.stopId) === expectedStopId
      );
      const baseEpoch = dispatchTorontoMinuteEpoch(plan.planDate, 0);
      travelRows.push(travelInterval({
        plan,
        loadId,
        kind: "inter_stop",
        from: previous.from,
        to: current.from,
        plannedStartMinute: (previous.plannedEnd - baseEpoch) / MINUTE_MS,
        plannedEndMinute: (current.plannedStart - baseEpoch) / MINUTE_MS,
        expectedJob: job,
        explicitRecord: explicitRecordForJob(records, job),
        inferredStart: previous.actualEnd,
        inferredEnd: current.actualStart,
        ordinal: ordinal++
      }));
    }
  }
  return travelRows;
}

function timelineInterval({
  plan,
  laneKey,
  load,
  kind,
  plannedStartMinute,
  plannedEndMinute,
  expectedJob = null,
  explicitRecord = null,
  previousEntry = null
}) {
  const loadId = text(load?.id);
  const actualStart = explicitRecord ? recordStartedEpoch(explicitRecord) : null;
  const actualEnd = explicitRecord ? recordCompletedEpoch(explicitRecord) : null;
  const explicitStatus = explicitRecord ? recordStatus(explicitRecord) : "";
  return {
    internalId: `timeline:${expectedJob?.jobId || `${loadId}:${kind}`}`,
    laneKey,
    loadId,
    load,
    kind,
    plannedStart: dispatchTorontoMinuteEpoch(plan.planDate, plannedStartMinute),
    plannedEnd: dispatchTorontoMinuteEpoch(plan.planDate, plannedEndMinute),
    actualStart,
    actualEnd,
    status: explicitRecord
      ? (explicitStatus || (actualEnd ? "complete" : actualStart ? "in_progress" : "pending"))
      : "pending",
    source: explicitRecord ? "explicit" : "planned",
    expectedJob,
    jobId: expectedJob?.jobId || null,
    fromTruckPlate: text(previousEntry?.assignment?.truckPlate),
    toTruckPlate: text(expectedJob?.nextTruckPlate || expectedJob?.truckPlate || load?.truckPlate || load?.truck_plate),
    switchYard: text(expectedJob?.switchYard || load?.switchYard || load?.switch_yard)
  };
}

function buildLaneTimelineRows(plan, laneEntries, records, laneKey) {
  const rows = [];
  const expectedJobs = expectedLaneJobs(plan, laneKey);
  for (let index = 1; index < laneEntries.length; index += 1) {
    const previousEntry = laneEntries[index - 1];
    const entry = laneEntries[index];
    const { load, assignment } = entry;
    const loadId = text(load.id);
    const timing = load.timing || {};
    const previousFinish = finiteMinute(timing.previousFinish)
      ?? previousEntry.assignment.plannedFinishMinute;
    const restMinutes = Math.max(0, finiteMinute(timing.restBefore) ?? 0);
    if (Number.isFinite(previousFinish) && restMinutes > 0) {
      rows.push(timelineInterval({
        plan,
        laneKey,
        load,
        kind: "rest",
        plannedStartMinute: previousFinish,
        plannedEndMinute: previousFinish + restMinutes,
        previousEntry
      }));
    }

    const changedTruck = Boolean(
      previousEntry.assignment.truckPlate
      && assignment.truckPlate
      && previousEntry.assignment.truckPlate !== assignment.truckPlate
    );
    if (!changedTruck) continue;
    const expectedJob = expectedJobs.find((job) =>
      text(job.loadId) === loadId && text(job.stopType).toLowerCase() === "truck_switch"
    ) || null;
    const switchMinutes = Math.max(0, finiteMinute(
      load.truckSwitchMinutes
      ?? load.truck_switch_minutes
      ?? expectedJob?.truckSwitchMinutes
    ) ?? 10);
    const switchStart = finiteMinute(timing.switchStart)
      ?? finiteMinute(expectedJob?.plannedSwitchMinute)
      ?? (assignment.plannedStartMinute === null ? null : assignment.plannedStartMinute - switchMinutes);
    if (!Number.isFinite(switchStart)) continue;
    rows.push(timelineInterval({
      plan,
      laneKey,
      load,
      kind: "truck_switch",
      plannedStartMinute: switchStart,
      plannedEndMinute: switchStart + switchMinutes,
      expectedJob,
      explicitRecord: exactRecordForTimelineJob(records, expectedJob),
      previousEntry
    }));
  }
  return rows;
}

function loadStartMode(load = {}) {
  const configured = text(load.startMode || load.start_mode).toLowerCase();
  if (["auto", "fixed"].includes(configured)) return configured;
  return text(load.start) ? "fixed" : "auto";
}

function loadRawBoundary(plan, assignment = {}, load = {}, field, events = []) {
  const assignedMinute = field === "start"
    ? assignment.plannedStartMinute
    : assignment.plannedFinishMinute;
  const persistedMinute = finiteMinute(load.timing?.[field]);
  const epoch = dispatchTorontoMinuteEpoch(plan.planDate, assignedMinute ?? persistedMinute);
  if (Number.isFinite(epoch)) return epoch;
  const boundaries = events
    .map((event) => field === "start" ? event.plannedStart : event.plannedEnd)
    .filter(Number.isFinite);
  if (!boundaries.length) return null;
  return field === "start" ? Math.min(...boundaries) : Math.max(...boundaries);
}

function loadCanonicalDurationCorrection(plan, visits = []) {
  const lastVisit = visits[visits.length - 1];
  if (!lastVisit) return 0;
  const rawDepartMinute = visitMinute(lastVisit.visit, "depart");
  const rawDepart = dispatchTorontoMinuteEpoch(plan.planDate, rawDepartMinute);
  if (!Number.isFinite(rawDepart) || !Number.isFinite(lastVisit.plannedEnd)) return 0;
  return lastVisit.plannedEnd - rawDepart;
}

/**
 * Rebase automatic loads on the corrected finish of the previous lane load.
 *
 * The raw start-to-previous-finish gap remains intact. Fixed loads keep their
 * published baseline. Every event belonging to an inherited load moves as one
 * unit, including handoff/start/return travel, so its internal timing remains
 * coherent after an earlier legacy dwell correction.
 */
function rebaseLaneAutoLoads(plan, laneEntries, visits, events) {
  const visitsByLoad = new Map();
  const eventsByLoad = new Map();
  for (const visit of visits) {
    if (!visitsByLoad.has(visit.loadId)) visitsByLoad.set(visit.loadId, []);
    visitsByLoad.get(visit.loadId).push(visit);
  }
  for (const event of events) {
    if (!eventsByLoad.has(event.loadId)) eventsByLoad.set(event.loadId, []);
    eventsByLoad.get(event.loadId).push(event);
  }

  let previous = null;
  for (const { load, assignment } of laneEntries) {
    const loadId = text(load.id);
    const loadEvents = eventsByLoad.get(loadId) || [];
    const loadVisits = visitsByLoad.get(loadId) || [];
    const rawStart = loadRawBoundary(plan, assignment, load, "start", loadEvents);
    const rawFinish = loadRawBoundary(plan, assignment, load, "finish", loadEvents);
    let baselineShift = 0;
    if (
      previous
      && loadStartMode(load) === "auto"
      && Number.isFinite(rawStart)
      && Number.isFinite(previous.rawFinish)
      && Number.isFinite(previous.correctedFinish)
    ) {
      const originalInterLoadGap = rawStart - previous.rawFinish;
      baselineShift = (previous.correctedFinish + originalInterLoadGap) - rawStart;
    }
    if (baselineShift) {
      for (const event of loadEvents) {
        if (Number.isFinite(event.plannedStart)) event.plannedStart += baselineShift;
        if (Number.isFinite(event.plannedEnd)) event.plannedEnd += baselineShift;
      }
    }

    const durationCorrection = loadCanonicalDurationCorrection(plan, loadVisits);
    const shiftedEventEnds = loadEvents.map((event) => event.plannedEnd).filter(Number.isFinite);
    const correctedFromPublishedFinish = Number.isFinite(rawFinish)
      ? rawFinish + baselineShift + durationCorrection
      : null;
    const correctedFinish = [
      correctedFromPublishedFinish,
      ...shiftedEventEnds
    ].filter(Number.isFinite).reduce((latest, value) => Math.max(latest, value), -Infinity);
    previous = {
      rawFinish,
      correctedFinish: Number.isFinite(correctedFinish) ? correctedFinish : rawFinish
    };
  }
  return events;
}

function applyLaneForecast(events) {
  const ordered = [...events].sort((left, right) =>
    (left.plannedStart ?? Number.MAX_SAFE_INTEGER) - (right.plannedStart ?? Number.MAX_SAFE_INTEGER)
    || (left.kind === "visit" ? 1 : 0) - (right.kind === "visit" ? 1 : 0)
    || left.internalId.localeCompare(right.internalId)
  );
  let shift = 0;
  for (const event of ordered) {
    const duration = Math.max(0, Number(event.plannedEnd || 0) - Number(event.plannedStart || 0));
    const shiftedStart = Number(event.plannedStart || 0) + shift;
    const shiftedEnd = Number(event.plannedEnd || 0) + shift;
    if (Number.isFinite(event.actualEnd)) {
      event.forecastStart = Number.isFinite(event.actualStart) ? event.actualStart : shiftedStart;
      event.forecastEnd = event.actualEnd;
      event.basis = "actual";
      shift = event.actualEnd - Number(event.plannedEnd || event.actualEnd);
    } else if (Number.isFinite(event.actualStart)) {
      event.forecastStart = event.actualStart;
      // An arrival timestamp is the driver's last explicit update. Keep the
      // moving plan anchored to that action plus the planned service duration;
      // wall-clock polling must not silently move the route every 15 seconds.
      event.forecastEnd = event.actualStart + duration;
      event.basis = "actual_arrival";
      shift = event.forecastEnd - Number(event.plannedEnd || event.forecastEnd);
    } else {
      event.forecastStart = shiftedStart;
      event.forecastEnd = shiftedEnd;
      event.basis = shift ? "shifted_plan" : "plan";
    }
  }
  return ordered;
}

function publicStop(row) {
  return {
    loadId: row.loadId,
    stopId: text(row.firstStop?.id || row.visit.id),
    visitStopIds: row.visit.stopIds,
    plannedArrival: isoValue(row.plannedStart),
    plannedLeave: isoValue(row.plannedEnd),
    forecastArrival: isoValue(row.forecastStart),
    forecastLeave: isoValue(row.forecastEnd),
    actualArrival: isoValue(row.actualStart),
    actualLeave: isoValue(row.actualEnd),
    status: row.status,
    basis: row.basis
  };
}

function publicTravel(row) {
  return {
    legId: row.jobId || row.internalId,
    jobId: row.jobId,
    loadId: row.loadId,
    kind: row.kind,
    from: row.from,
    to: row.to,
    plannedLeave: isoValue(row.plannedStart),
    plannedArrival: isoValue(row.plannedEnd),
    forecastLeave: isoValue(row.forecastStart),
    forecastArrival: isoValue(row.forecastEnd),
    actualLeave: isoValue(row.actualStart),
    actualArrival: isoValue(row.actualEnd),
    status: row.status,
    source: row.source
  };
}

function publicTimeline(row) {
  return {
    eventId: row.jobId || row.internalId,
    jobId: row.jobId,
    loadId: row.loadId,
    kind: row.kind,
    plannedStart: isoValue(row.plannedStart),
    plannedEnd: isoValue(row.plannedEnd),
    forecastStart: isoValue(row.forecastStart),
    forecastEnd: isoValue(row.forecastEnd),
    actualStart: isoValue(row.actualStart),
    actualEnd: isoValue(row.actualEnd),
    status: row.status,
    basis: row.basis,
    source: row.source,
    fromTruckPlate: row.fromTruckPlate,
    toTruckPlate: row.toTruckPlate,
    switchYard: row.switchYard
  };
}

export function buildDispatchForecast(plan, driverJobStatuses = [], {
  now = new Date(),
  driverProfiles = []
} = {}) {
  const generatedAt = dateValue(now) || new Date();
  if (!plan) {
    return {
      planId: null,
      planRevision: 0,
      planDate: "",
      generatedAt: generatedAt.toISOString(),
      timeZone: DISPATCH_FORECAST_TIME_ZONE,
      loads: [],
      stops: [],
      travelLegs: [],
      timelineEvents: []
    };
  }
  const records = Array.isArray(driverJobStatuses) ? driverJobStatuses : [];
  const planningProfiles = new Map((Array.isArray(driverProfiles) ? driverProfiles : [])
    .map((profile) => [driverKey(profile?.login || profile?.driverLogin || profile?.driver_login), profile])
    .filter(([login]) => login));
  const allStops = [];
  const allTravel = [];
  const allTimeline = [];
  const allEvents = [];
  const loadEntries = [];
  for (const [laneKey, laneEntries] of sortedLaneEntries(plan)) {
    const visits = laneVisitRows(plan, laneEntries, records, planningProfiles);
    const travel = buildLaneTravelRows(plan, laneEntries, visits, records, laneKey);
    const timeline = buildLaneTimelineRows(plan, laneEntries, records, laneKey);
    const rebasedEvents = rebaseLaneAutoLoads(plan, laneEntries, visits, [...visits, ...travel, ...timeline]);
    const forecasted = applyLaneForecast(rebasedEvents);
    allEvents.push(...forecasted);
    allStops.push(...forecasted.filter((event) => event.kind === "visit"));
    allTravel.push(...forecasted.filter((event) => event.internalId.startsWith("travel:")));
    allTimeline.push(...forecasted.filter((event) => event.internalId.startsWith("timeline:")));
    loadEntries.push(...laneEntries);
  }

  const loads = loadEntries.map(({ load, assignment }) => {
    const loadId = text(load.id);
    // Timeline helpers participate in chronological shifting, but a rest/wait
    // interval belongs between loads and must not redefine the established
    // public load start/finish boundary.
    const events = allEvents.filter((event) =>
      event.loadId === loadId && !event.internalId.startsWith("timeline:")
    );
    const forecastStarts = events.map((event) => event.forecastStart).filter(Number.isFinite);
    const forecastEnds = events.map((event) => event.forecastEnd).filter(Number.isFinite);
    return {
      loadId,
      forecastStart: forecastStarts.length
        ? isoValue(Math.min(...forecastStarts))
        : dispatchTorontoMinuteIso(plan.planDate, assignment.plannedStartMinute),
      forecastFinish: forecastEnds.length
        ? isoValue(Math.max(...forecastEnds))
        : dispatchTorontoMinuteIso(plan.planDate, assignment.plannedFinishMinute)
    };
  });

  return {
    planId: String(plan.id ?? plan.planId ?? ""),
    planRevision: Number(plan.revision || 0),
    planDate: text(plan.planDate || plan.plan_date).slice(0, 10),
    generatedAt: generatedAt.toISOString(),
    timeZone: DISPATCH_FORECAST_TIME_ZONE,
    loads,
    stops: allStops.map(publicStop),
    travelLegs: allTravel.map(publicTravel),
    timelineEvents: allTimeline.map(publicTimeline)
  };
}

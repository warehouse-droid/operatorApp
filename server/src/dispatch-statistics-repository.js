import { query } from "./db.js";
import {
  dispatchLoadAssignment,
  dispatchOwnYardCodes,
  dispatchPhysicalStopVisits
} from "./dispatch-load-assignment.js";
import { listDispatchDrivers } from "./dispatch-setup-repository.js";

function todayLocalDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function daysAgo(days = 0) {
  const date = new Date();
  date.setDate(date.getDate() - Number(days || 0));
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function cleanDate(value, fallback) {
  const text = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
}

function numberValue(value) {
  return Number(value || 0) || 0;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(numberValue(value) * factor) / factor;
}

function minutesBetween(startedAt, completedAt) {
  if (!startedAt || !completedAt) return 0;
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 60000);
}

function secondsBetween(startedAt, completedAt) {
  if (!startedAt || !completedAt) return 0;
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return (end - start) / 1000;
}

function orderByRef(plan, ref) {
  const id = String(ref || "");
  const direct = (plan.orders || []).find((order) => String(order?.id || "") === id);
  if (direct) return direct;
  for (const order of plan.orders || []) {
    const child = (order.childOrderDetails || []).find((item) => String(item?.id || "") === id);
    if (child) return child;
  }
  return null;
}

function normalizedPlate(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

function findTruck(plan, { truckId = "", truckPlate = "" } = {}) {
  const id = String(truckId || "");
  const plate = normalizedPlate(truckPlate);
  return (plan.trucks || []).find((truck) =>
    (id && String(truck?.id || "") === id)
    || (plate && normalizedPlate(truck?.plate) === plate)
  ) || {};
}

function findLoadContext(plan, row) {
  const loadId = String(row.load_id || "");
  const stopId = String(row.stop_id || "");
  for (const truck of plan.trucks || []) {
    const load = (truck.loads || []).find((candidate) =>
      (loadId && String(candidate?.id || "") === loadId)
      || (!loadId && stopId && (candidate?.stops || []).some((stop) => String(stop?.id || "") === stopId))
    );
    if (load) return { parentTruck: truck, load };
  }
  return { parentTruck: {}, load: {} };
}

function findStop(load, row) {
  const stopId = String(row.stop_id || "");
  return (load.stops || []).find((stop) => String(stop?.id || "") === stopId) || {};
}

function orderRefs(row) {
  return Array.isArray(row.order_refs) ? row.order_refs.map(String).filter(Boolean) : [];
}

function primaryOrder(plan, row) {
  for (const ref of orderRefs(row)) {
    const order = orderByRef(plan, ref);
    if (order) return order;
  }
  return null;
}

function requiredPickupLocations(order) {
  if (Array.isArray(order?.pickupLocations) && order.pickupLocations.length) return order.pickupLocations.map(String);
  if (order?.sourceYard) return [String(order.sourceYard)];
  return ["3445"];
}

function orderFootprintPallets(order, lineRowIds = []) {
  if (!order) return 0;
  if (Array.isArray(order.items) && order.items.length) {
    const selectedIds = new Set((lineRowIds || []).map(String));
    const items = selectedIds.size
      ? order.items.filter((item) => selectedIds.has(String(item?.lineRowId ?? item?.line_row_id ?? item?.id ?? "")))
      : order.items;
    return items.reduce((sum, item) => (
      sum
      + numberValue(item?.splitQty ?? item?.pallets)
      + (numberValue(item?.layers) > 0 ? 1 : 0)
    ), 0);
  }
  return numberValue(order.pallets) + (numberValue(order.layers) > 0 ? 1 : 0);
}

function pickupFootprintForLocation(plan, load, location) {
  const pickupLocation = String(location || "");
  const countedOrders = new Set();
  let total = 0;
  for (const stop of load.stops || []) {
    if (stop?.type !== "drop" || countedOrders.has(stop.orderId)) continue;
    const order = orderByRef(plan, stop.orderId);
    if (!order) continue;
    if (!requiredPickupLocations(order).includes(pickupLocation)) continue;
    countedOrders.add(stop.orderId);
    total += orderFootprintPallets(order);
  }
  return total;
}

function isLocalVrmaOrder(order = {}) {
  return String(order.sourceTable || order.source_table || "") === "scm_vrma_orders"
    || String(order.parseSource || order.parse_source || "") === "scm-vrma";
}

function customOrderStopMinutes(order = {}) {
  const isCustomOrder = String(order.type || "").trim().toUpperCase() === "CUSTOM"
    || order.customOrder === true
    || String(order.sourceTable || order.source_table || "").trim().toLowerCase() === "dispatch_custom_orders";
  if (!isCustomOrder) return null;
  const value = order.stopMinutes ?? order.stop_minutes ?? order.raw?.stop_minutes;
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440 ? minutes : null;
}

function stopClass(plan, row, stop, order) {
  const type = String(row.stop_type || "");
  if (type === "travel") return "travel";
  if (type === "truck_switch") return "truck_switch";
  const ownYards = new Set(dispatchOwnYardCodes(plan));
  if (type === "pickup") {
    const location = String(stop?.location || row.location || "");
    return ownYards.has(location) ? "own_yard" : "vendor_yard";
  }
  if (type === "dropoff") {
    const destination = String(stop?.dropLocation || stop?.destinationYard || order?.destinationYard || stop?.location || "");
    if (ownYards.has(destination)) return "own_yard";
    return isLocalVrmaOrder(order) ? "vendor_yard" : "delivery";
  }
  return "unknown";
}

function plannedStopMinutes(stopClassValue, planningProfile, palletCount) {
  if (stopClassValue === "travel") return 0;
  if (stopClassValue === "truck_switch") return Math.round(numberValue(planningProfile.truckSwitchMinutes || 10));
  if (stopClassValue === "own_yard") return Math.round(numberValue(planningProfile.ownYardFixedMinutes || planningProfile.loadMinutes || 40));
  if (stopClassValue === "vendor_yard") return Math.round(numberValue(planningProfile.vendorFixedMinutes || planningProfile.outsideFixedMinutes || planningProfile.unloadMinutes || 35));
  if (stopClassValue === "delivery") {
    return Math.round(numberValue(planningProfile.deliveryFixedMinutes || planningProfile.outsideFixedMinutes || planningProfile.unloadMinutes || 35)
      + (numberValue(palletCount) * numberValue(planningProfile.minutesPerPallet || 1)));
  }
  return 0;
}

function makeEmptyAggregate(key, label = key) {
  return {
    key,
    label,
    completedStops: 0,
    inProgressStops: 0,
    ownYardStops: 0,
    vendorStops: 0,
    deliveryStops: 0,
    travelStops: 0,
    truckSwitchStops: 0,
    actualMinutes: 0,
    grossMinutes: 0,
    restMinutes: 0,
    plannedMinutes: 0,
    overrunMinutes: 0,
    deliveryPallets: 0,
    deliveryMinutes: 0,
    photoStops: 0
  };
}

function addStop(aggregate, stop) {
  if (stop.status === "in_progress") aggregate.inProgressStops += 1;
  if (stop.status === "complete") aggregate.completedStops += 1;
  if (stop.stopClass === "own_yard") aggregate.ownYardStops += 1;
  if (stop.stopClass === "vendor_yard") aggregate.vendorStops += 1;
  if (stop.stopClass === "delivery") aggregate.deliveryStops += 1;
  if (stop.stopClass === "travel") aggregate.travelStops += 1;
  if (stop.stopClass === "truck_switch") aggregate.truckSwitchStops += 1;
  if (stop.photoCount > 0) aggregate.photoStops += 1;
  aggregate.actualMinutes += stop.actualMinutes;
  aggregate.grossMinutes += stop.grossMinutes;
  aggregate.restMinutes += stop.restMinutes;
  aggregate.plannedMinutes += stop.plannedMinutes;
  aggregate.overrunMinutes += stop.overrunMinutes;
  if (stop.stopClass === "delivery") {
    aggregate.deliveryPallets += stop.pallets;
    aggregate.deliveryMinutes += stop.actualMinutes;
  }
}

function finalizeAggregate(aggregate) {
  return {
    ...aggregate,
    averageStopMinutes: aggregate.completedStops ? round(aggregate.actualMinutes / aggregate.completedStops) : 0,
    averagePlannedMinutes: aggregate.completedStops ? round(aggregate.plannedMinutes / aggregate.completedStops) : 0,
    averageOverrunMinutes: aggregate.completedStops ? round(aggregate.overrunMinutes / aggregate.completedStops) : 0,
    deliveryMinutesPerPallet: aggregate.deliveryPallets ? round(aggregate.deliveryMinutes / aggregate.deliveryPallets) : 0,
    photoRate: aggregate.completedStops ? round((aggregate.photoStops / aggregate.completedStops) * 100) : 0
  };
}

function classLabel(stopClassValue) {
  if (stopClassValue === "own_yard") return "Own Yard";
  if (stopClassValue === "vendor_yard") return "Vendor Yard";
  if (stopClassValue === "delivery") return "Delivery";
  if (stopClassValue === "travel") return "Travel";
  if (stopClassValue === "truck_switch") return "Truck Switch";
  return "Unknown";
}

export function dispatchStatisticStopFromRow(row, { driverProfile = null } = {}) {
  const plan = {
    id: row.plan_id,
    planDate: String(row.plan_date || "").slice(0, 10),
    orders: Array.isArray(row.orders) ? row.orders : [],
    trucks: Array.isArray(row.trucks) ? row.trucks : [],
    summary: row.summary || {}
  };
  const { parentTruck, load } = findLoadContext(plan, row);
  const assignment = dispatchLoadAssignment(parentTruck, load);
  const assignedTruck = findTruck(plan, {
    truckId: row.truck_id || assignment.truckId,
    truckPlate: row.truck_plate || assignment.truckPlate
  });
  const planningProfile = { ...assignedTruck, ...parentTruck, ...load, ...(driverProfile || {}) };
  const stop = findStop(load, row);
  const order = primaryOrder(plan, row);
  const physicalVisit = dispatchPhysicalStopVisits(plan, planningProfile, load, { planningProfile: driverProfile })
    .find((visit) => visit.stopIds.includes(String(stop?.id || row.stop_id || ""))) || null;
  const currentClass = physicalVisit?.serviceType || stopClass(plan, row, stop, order);
  const pallets = row.stop_type === "pickup"
    ? pickupFootprintForLocation(plan, load, stop?.location)
    : currentClass === "delivery"
      ? orderFootprintPallets(order, stop?.lineRowIds)
      : orderFootprintPallets(order, stop?.lineRowIds);
  const customDropMinutes = row.stop_type === "dropoff" ? customOrderStopMinutes(order) : null;
  const plannedMinutes = physicalVisit?.plannedMinutes
    ?? customDropMinutes
    ?? plannedStopMinutes(currentClass, planningProfile, pallets);
  const grossSeconds = row.status === "complete" ? secondsBetween(row.started_at, row.completed_at) : 0;
  const restSeconds = row.status === "complete"
    ? Math.min(grossSeconds, Math.max(0, numberValue(row.rest_seconds)))
    : 0;
  const grossMinutes = row.status === "complete" ? Math.round(grossSeconds / 60) : 0;
  const restMinutes = row.status === "complete" ? round(restSeconds / 60) : 0;
  const actualMinutes = row.status === "complete" ? Math.max(0, Math.round((grossSeconds - restSeconds) / 60)) : 0;
  return {
    jobId: row.job_id || "",
    planId: String(row.plan_id || ""),
    planDate: String(row.plan_date || "").slice(0, 10),
    driverLogin: row.driver_login || "",
    truckPlate: row.truck_plate || assignment.truckPlate || assignedTruck.plate || parentTruck.plate || "",
    loadName: row.load_name || load.name || "",
    stopId: row.stop_id || "",
    stopIds: physicalVisit?.stopIds || [row.stop_id || ""].filter(Boolean),
    stopType: row.stop_type || "",
    stopClass: currentClass,
    stopClassLabel: classLabel(currentClass),
    status: row.status || "",
    startedAt: row.started_at,
    completedAt: row.completed_at,
    actualMinutes,
    grossMinutes,
    restMinutes,
    plannedMinutes,
    overrunMinutes: row.status === "complete" ? Math.max(actualMinutes - plannedMinutes, 0) : 0,
    pallets,
    orderRefs: orderRefs(row),
    photoCount: Array.isArray(row.photo_data_urls) ? row.photo_data_urls.filter(Boolean).length : 0,
    physicalVisitKey: physicalVisit
      ? `${String(row.plan_id || "")}|${String(load.id || row.load_id || "")}|${physicalVisit.id}`
      : "",
    physicalVisitStopIds: physicalVisit?.stopIds || [],
    physicalVisitFirstIndex: physicalVisit?.firstIndex ?? null,
    physicalVisitLastIndex: physicalVisit?.lastIndex ?? null,
    physicalVisitPlannedMinutes: physicalVisit?.plannedMinutes ?? null,
    stopIndex: (load.stops || []).findIndex((candidate) => String(candidate?.id || "") === String(row.stop_id || ""))
  };
}

function firstDateValue(values = []) {
  const dates = values.map((value) => value ? new Date(value) : null)
    .filter((value) => value && Number.isFinite(value.getTime()))
    .sort((left, right) => left.getTime() - right.getTime());
  return dates[0]?.toISOString() || null;
}

function lastDateValue(values = []) {
  const dates = values.map((value) => value ? new Date(value) : null)
    .filter((value) => value && Number.isFinite(value.getTime()))
    .sort((left, right) => right.getTime() - left.getTime());
  return dates[0]?.toISOString() || null;
}

/**
 * Collapse logical Driver PWA jobs that belong to one planned physical visit.
 * This keeps stop statistics from applying the same grouped visit duration once
 * per order while preserving every order and photo reference in the result.
 */
export function dispatchStatisticStopsFromRows(rows = [], { driverProfiles = [] } = {}) {
  const profileByLogin = new Map((driverProfiles || []).map((driver) => [String(driver?.login || "").trim().toLowerCase(), driver]));
  const mapped = (rows || []).map((row) => dispatchStatisticStopFromRow(row, {
    driverProfile: profileByLogin.get(String(row?.driver_login || "").trim().toLowerCase()) || null
  }));
  const groups = [];
  const groupByKey = new Map();
  for (const stop of mapped) {
    const key = stop.physicalVisitKey || `job:${stop.jobId || `${stop.planId}|${stop.loadName}|${stop.stopId}`}`;
    if (!groupByKey.has(key)) {
      const group = { key, members: [] };
      groupByKey.set(key, group);
      groups.push(group);
    }
    groupByKey.get(key).members.push(stop);
  }
  return groups.map(({ members }) => {
    if (members.length === 1 && !members[0].physicalVisitKey) return members[0];
    const ordered = [...members].sort((left, right) => left.stopIndex - right.stopIndex);
    const representative = ordered[0];
    const expectedStopIds = representative.physicalVisitStopIds || [];
    const recordedStopIds = new Set(members.map((member) => String(member.stopId || "")).filter(Boolean));
    const complete = expectedStopIds.length > 0
      && expectedStopIds.every((stopId) => recordedStopIds.has(String(stopId)))
      && members.every((member) => member.status === "complete");
    const actualMinutes = members.reduce((sum, member) => sum + numberValue(member.actualMinutes), 0);
    const grossMinutes = members.reduce((sum, member) => sum + numberValue(member.grossMinutes), 0);
    const restMinutes = members.reduce((sum, member) => sum + numberValue(member.restMinutes), 0);
    const plannedMinutes = numberValue(representative.physicalVisitPlannedMinutes ?? representative.plannedMinutes);
    const pallets = members.reduce((sum, member) => sum + numberValue(member.pallets), 0);
    return {
      ...representative,
      status: complete ? "complete" : "in_progress",
      startedAt: firstDateValue(members.map((member) => member.startedAt)),
      completedAt: complete ? lastDateValue(members.map((member) => member.completedAt)) : null,
      actualMinutes,
      grossMinutes,
      restMinutes,
      plannedMinutes,
      overrunMinutes: complete ? Math.max(actualMinutes - plannedMinutes, 0) : 0,
      pallets,
      photoCount: members.reduce((sum, member) => sum + numberValue(member.photoCount), 0),
      stopIds: expectedStopIds.length ? expectedStopIds : ordered.map((member) => member.stopId).filter(Boolean),
      orderRefs: [...new Set(members.flatMap((member) => member.orderRefs || []))]
    };
  });
}

function aggregateBy(stops, keyFn, labelFn = keyFn) {
  const map = new Map();
  for (const stop of stops) {
    const key = keyFn(stop);
    if (!key) continue;
    if (!map.has(key)) map.set(key, makeEmptyAggregate(key, labelFn(stop)));
    addStop(map.get(key), stop);
  }
  return [...map.values()].map(finalizeAggregate);
}

async function dvirSummary(fromDate, toDate) {
  const result = await query(
    `SELECT driver_login,
            COUNT(*)::int AS day_count,
            COUNT(*) FILTER (WHERE pre_dvir_completed_at IS NOT NULL)::int AS pre_complete,
            COUNT(*) FILTER (WHERE post_dvir_completed_at IS NOT NULL)::int AS post_complete
       FROM driver_day_records
      WHERE plan_date BETWEEN $1::date AND $2::date
      GROUP BY driver_login
      ORDER BY driver_login`,
    [fromDate, toDate]
  );
  return result.rows.map((row) => ({
    driverLogin: row.driver_login || "",
    dayCount: Number(row.day_count || 0),
    preComplete: Number(row.pre_complete || 0),
    postComplete: Number(row.post_complete || 0),
    preRate: row.day_count ? round((Number(row.pre_complete || 0) / Number(row.day_count)) * 100) : 0,
    postRate: row.day_count ? round((Number(row.post_complete || 0) / Number(row.day_count)) * 100) : 0
  }));
}

async function driverList(fromDate, toDate) {
  const result = await query(
    `SELECT DISTINCT driver_login
       FROM (
         SELECT driver_login FROM driver_job_records WHERE plan_date BETWEEN $1::date AND $2::date
         UNION
         SELECT driver_login FROM driver_day_records WHERE plan_date BETWEEN $1::date AND $2::date
       ) drivers
      WHERE COALESCE(driver_login, '') <> ''
      ORDER BY driver_login`,
    [fromDate, toDate]
  );
  return result.rows.map((row) => row.driver_login || "").filter(Boolean);
}

export async function getDispatchStatistics({ from = "", to = "", driver = "" } = {}) {
  const toDate = cleanDate(to, todayLocalDate());
  const fromDate = cleanDate(from, daysAgo(13));
  const params = [fromDate, toDate];
  const driverClause = driver ? `AND r.driver_login = $3` : "";
  if (driver) params.push(String(driver).trim().toLowerCase());
  const [result, driverProfiles] = await Promise.all([query(
    `SELECT r.job_id, r.plan_id, r.plan_date::text AS plan_date,
            r.driver_login, r.truck_id, r.truck_plate, r.load_id, r.load_name,
            r.stop_id, r.stop_type, COALESCE(r.order_refs, '[]'::jsonb) AS order_refs,
            COALESCE(r.photo_data_urls, '[]'::jsonb) AS photo_data_urls,
            r.status, r.started_at, r.completed_at,
            COALESCE((
              SELECT SUM(EXTRACT(EPOCH FROM (
                LEAST(COALESCE(rr.ended_at, now()), r.completed_at)
                - GREATEST(rr.started_at, r.started_at)
              )))
                FROM driver_rest_records rr
               WHERE rr.driver_login = r.driver_login
                 AND r.completed_at IS NOT NULL
                 AND rr.started_at < r.completed_at
                 AND COALESCE(rr.ended_at, now()) > r.started_at
            ), 0) AS rest_seconds,
            COALESCE(s.orders, '[]'::jsonb) AS orders,
            COALESCE(s.trucks, '[]'::jsonb) AS trucks,
            COALESCE(s.summary, '{}'::jsonb) AS summary
       FROM driver_job_records r
       LEFT JOIN dispatch_plan_snapshots s ON s.plan_id::text = r.plan_id::text
      WHERE r.plan_date BETWEEN $1::date AND $2::date
        AND r.status IN ('in_progress', 'complete')
        ${driverClause}
      ORDER BY r.plan_date DESC, r.driver_login, r.started_at DESC NULLS LAST`,
    params
  ), listDispatchDrivers({ activeOnly: false })]);
  const stops = dispatchStatisticStopsFromRows(result.rows, { driverProfiles });
  const completed = stops.filter((stop) => stop.status === "complete");
  const byDriver = aggregateBy(stops, (stop) => stop.driverLogin || "unknown");
  const byStopClass = aggregateBy(completed, (stop) => stop.stopClass, (stop) => stop.stopClassLabel)
    .sort((left, right) => ["own_yard", "vendor_yard", "delivery", "travel", "truck_switch", "unknown"].indexOf(left.key) - ["own_yard", "vendor_yard", "delivery", "travel", "truck_switch", "unknown"].indexOf(right.key));
  const daily = aggregateBy(stops, (stop) => stop.planDate)
    .sort((left, right) => left.key.localeCompare(right.key));
  const total = finalizeAggregate(stops.reduce((aggregate, stop) => {
    addStop(aggregate, stop);
    return aggregate;
  }, makeEmptyAggregate("total", "Total")));

  const own = byStopClass.find((item) => item.key === "own_yard") || finalizeAggregate(makeEmptyAggregate("own_yard", "Own Yard"));
  const vendor = byStopClass.find((item) => item.key === "vendor_yard") || finalizeAggregate(makeEmptyAggregate("vendor_yard", "Vendor Yard"));
  const delivery = byStopClass.find((item) => item.key === "delivery") || finalizeAggregate(makeEmptyAggregate("delivery", "Delivery"));
  const [dvir, drivers] = await Promise.all([
    dvirSummary(fromDate, toDate),
    driverList(fromDate, toDate)
  ]);

  return {
    filters: { from: fromDate, to: toDate, driver: driver || "" },
    drivers,
    summary: {
      completedStops: total.completedStops,
      inProgressStops: total.inProgressStops,
      averageOwnYardStopMinutes: own.averageStopMinutes,
      averageVendorYardStopMinutes: vendor.averageStopMinutes,
      deliveryMinutesPerPallet: delivery.deliveryMinutesPerPallet,
      totalOverrunMinutes: total.overrunMinutes,
      averageOverrunMinutes: total.averageOverrunMinutes,
      totalRestMinutes: round(total.restMinutes),
      photoRate: total.photoRate
    },
    byDriver: byDriver.sort((left, right) => right.completedStops - left.completedStops || right.overrunMinutes - left.overrunMinutes),
    byStopClass,
    daily,
    dvir,
    recentStops: stops.slice(0, 80)
  };
}

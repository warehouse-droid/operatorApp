import { query } from "./db.js";

const OWN_YARD_CODES = new Set(["3445", "2967", "12441", "150"]);

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

function findTruck(plan, row) {
  const truckId = String(row.truck_id || "");
  const plate = String(row.truck_plate || "").replace(/\s+/g, "").toUpperCase();
  return (plan.trucks || []).find((truck) =>
    String(truck?.id || "") === truckId
    || String(truck?.plate || "").replace(/\s+/g, "").toUpperCase() === plate
  ) || {};
}

function findLoad(truck, row) {
  const loadId = String(row.load_id || "");
  return (truck.loads || []).find((load) => String(load?.id || "") === loadId) || {};
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

function orderFootprintPallets(order) {
  if (!order) return 0;
  if (Array.isArray(order.items) && order.items.length) {
    return order.items.reduce((sum, item) => (
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

function stopClass(plan, row, stop, order) {
  const type = String(row.stop_type || "");
  if (type === "travel") return "travel";
  if (type === "pickup") {
    const location = String(stop?.location || row.location || "");
    return OWN_YARD_CODES.has(location) ? "own_yard" : "vendor_yard";
  }
  if (type === "dropoff") {
    const destination = String(order?.destinationYard || stop?.location || "");
    return OWN_YARD_CODES.has(destination) ? "own_yard" : "delivery";
  }
  return "unknown";
}

function plannedStopMinutes(stopClassValue, truck, palletCount) {
  if (stopClassValue === "travel") return 0;
  if (stopClassValue === "own_yard") return Math.round(numberValue(truck.ownYardFixedMinutes || truck.loadMinutes || 40));
  if (stopClassValue === "vendor_yard") return Math.round(numberValue(truck.vendorFixedMinutes || truck.outsideFixedMinutes || truck.unloadMinutes || 35));
  if (stopClassValue === "delivery") {
    return Math.round(numberValue(truck.deliveryFixedMinutes || truck.outsideFixedMinutes || truck.unloadMinutes || 35)
      + (numberValue(palletCount) * numberValue(truck.minutesPerPallet || 1)));
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
    actualMinutes: 0,
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
  if (stop.photoCount > 0) aggregate.photoStops += 1;
  aggregate.actualMinutes += stop.actualMinutes;
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
  return "Unknown";
}

function rowToStop(row) {
  const plan = {
    id: row.plan_id,
    planDate: String(row.plan_date || "").slice(0, 10),
    orders: Array.isArray(row.orders) ? row.orders : [],
    trucks: Array.isArray(row.trucks) ? row.trucks : []
  };
  const truck = findTruck(plan, row);
  const load = findLoad(truck, row);
  const stop = findStop(load, row);
  const order = primaryOrder(plan, row);
  const currentClass = stopClass(plan, row, stop, order);
  const pallets = row.stop_type === "pickup"
    ? pickupFootprintForLocation(plan, load, stop?.location)
    : currentClass === "delivery"
      ? orderFootprintPallets(order)
      : orderFootprintPallets(order);
  const plannedMinutes = plannedStopMinutes(currentClass, truck, pallets);
  const actualMinutes = row.status === "complete" ? minutesBetween(row.started_at, row.completed_at) : 0;
  return {
    jobId: row.job_id || "",
    planId: String(row.plan_id || ""),
    planDate: String(row.plan_date || "").slice(0, 10),
    driverLogin: row.driver_login || "",
    truckPlate: row.truck_plate || truck.plate || "",
    loadName: row.load_name || load.name || "",
    stopId: row.stop_id || "",
    stopType: row.stop_type || "",
    stopClass: currentClass,
    stopClassLabel: classLabel(currentClass),
    status: row.status || "",
    startedAt: row.started_at,
    completedAt: row.completed_at,
    actualMinutes,
    plannedMinutes,
    overrunMinutes: row.status === "complete" ? Math.max(actualMinutes - plannedMinutes, 0) : 0,
    pallets,
    orderRefs: orderRefs(row),
    photoCount: Array.isArray(row.photo_data_urls) ? row.photo_data_urls.filter(Boolean).length : 0
  };
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
  const result = await query(
    `SELECT r.job_id, r.plan_id, r.plan_date::text AS plan_date,
            r.driver_login, r.truck_id, r.truck_plate, r.load_id, r.load_name,
            r.stop_id, r.stop_type, COALESCE(r.order_refs, '[]'::jsonb) AS order_refs,
            COALESCE(r.photo_data_urls, '[]'::jsonb) AS photo_data_urls,
            r.status, r.started_at, r.completed_at,
            COALESCE(s.orders, '[]'::jsonb) AS orders,
            COALESCE(s.trucks, '[]'::jsonb) AS trucks
       FROM driver_job_records r
       LEFT JOIN dispatch_plan_snapshots s ON s.plan_id::text = r.plan_id::text
      WHERE r.plan_date BETWEEN $1::date AND $2::date
        AND r.status IN ('in_progress', 'complete')
        ${driverClause}
      ORDER BY r.plan_date DESC, r.driver_login, r.started_at DESC NULLS LAST`,
    params
  );
  const stops = result.rows.map(rowToStop);
  const completed = stops.filter((stop) => stop.status === "complete");
  const byDriver = aggregateBy(stops, (stop) => stop.driverLogin || "unknown");
  const byStopClass = aggregateBy(completed, (stop) => stop.stopClass, (stop) => stop.stopClassLabel)
    .sort((left, right) => ["own_yard", "vendor_yard", "delivery", "travel", "unknown"].indexOf(left.key) - ["own_yard", "vendor_yard", "delivery", "travel", "unknown"].indexOf(right.key));
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
      photoRate: total.photoRate
    },
    byDriver: byDriver.sort((left, right) => right.completedStops - left.completedStops || right.overrunMinutes - left.overrunMinutes),
    byStopClass,
    daily,
    dvir,
    recentStops: stops.slice(0, 80)
  };
}

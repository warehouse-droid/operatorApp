import crypto from "node:crypto";
import { query, withTransaction } from "./db.js";
import { config } from "./config.js";
import { createSamsaraDriverVehicleAssignment, createSamsaraMechanicDvir, findSamsaraDvirForVehicle, setSamsaraDriverDutyStatus } from "./samsara.js";
import { dispatchLoadAssignment, dispatchOwnYardCodes, flattenDispatchPlanLoads, normalizeDispatchPlanLoadAssignments } from "./dispatch-load-assignment.js";

const YARD_ADDRESSES = {
  "3445": "3445 Kennedy Road, Toronto, ON",
  "2967": "2967 Kennedy Road, Toronto, ON",
  "12441": "12441 Woodbine Avenue, Whitchurch-Stouffville, ON",
  "150": "150 Clark Blvd, Brampton, ON L6T 4Y8, Canada"
};
const SAMSARA_ACCOUNT_LIMIT_MS = 8 * 60 * 60 * 1000;

function ownYardCodeSet(plan = {}) {
  const planHasOwnYards = [
    plan.ownYardCodes,
    plan.ownYards,
    plan.summary?.ownYardCodes,
    plan.summary?.ownYards,
    plan.summary?.dispatchPlanFormat?.ownYardCodes
  ].some((candidate) => Array.isArray(candidate) && candidate.length);
  const configuredOwnYards = planHasOwnYards ? null : config.dispatch?.ownYardCodes;
  return new Set(dispatchOwnYardCodes(plan, configuredOwnYards));
}

function isOwnYard(plan = {}, value = "") {
  return ownYardCodeSet(plan).has(String(value || "").trim());
}

function isPhotoReference(value) {
  const text = String(value || "");
  return text.startsWith("data:image/") || text.startsWith("r2://");
}

function driverKey(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeSamsaraAccounts({ primaryUsername = "", secondaryUsername = "" } = {}) {
  return {
    primaryUsername: String(primaryUsername || "").trim(),
    secondaryUsername: String(secondaryUsername || "").trim()
  };
}

function samsaraAccountsFromLegacy(samsaraUsername = "", samsaraAccounts = {}) {
  const normalized = normalizeSamsaraAccounts(samsaraAccounts);
  if (!normalized.primaryUsername) normalized.primaryUsername = String(samsaraUsername || "").trim();
  return normalized;
}

function samsaraUsernameForAccount(accounts = {}, account = "primary") {
  return account === "secondary" ? accounts.secondaryUsername : accounts.primaryUsername;
}

function shouldSwitchToSecondary(row) {
  if (!row?.on_duty_at || row?.secondary_on_duty_at) return false;
  if (String(row?.samsara_active_account || "primary") === "secondary") return false;
  const started = new Date(row.on_duty_at).getTime();
  return Number.isFinite(started) && Date.now() - started >= SAMSARA_ACCOUNT_LIMIT_MS;
}

function mapRestRecord(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    restId: row.rest_id,
    planId: row.plan_id,
    planDate: row.plan_date,
    driverLogin: row.driver_login,
    truckId: row.truck_id || "",
    truckPlate: row.truck_plate || "",
    loadId: row.load_id || "",
    loadName: row.load_name || "",
    previousJobId: row.previous_job_id || "",
    nextJobId: row.next_job_id || "",
    status: row.status || "",
    startedAt: row.started_at || null,
    endedAt: row.ended_at || null
  };
}

function planDateValue(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value || "").slice(0, 10);
}

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

function requiredPickupLocations(order) {
  if (Array.isArray(order?.pickupLocations) && order.pickupLocations.length) return order.pickupLocations.map(String);
  if (order?.sourceYard) return [String(order.sourceYard)];
  return ["3445"];
}

function jobId(plan, truck, load, stop) {
  return [plan.id, truck.id || truck.plate, load.id, stop.id].map((part) => encodeURIComponent(String(part || ""))).join(":");
}

function travelJobId(plan, truck, load, from, to, legKey = "") {
  return [plan.id, truck.id || truck.plate, load.id, "TRAVEL", from, to, legKey].map((part) => encodeURIComponent(String(part || ""))).join(":");
}

function returnJobId(plan, truck, load, from, to) {
  return [plan.id, truck.id || truck.plate, load.id, "RETURN", from, to].map((part) => encodeURIComponent(String(part || ""))).join(":");
}

function truckSwitchJobId(plan, driverLogin, nextLoad) {
  return [plan.id, driverKey(driverLogin), nextLoad.id, "TRUCK_SWITCH"]
    .map((part) => encodeURIComponent(String(part || "")))
    .join(":");
}

function sortedPlans(rows) {
  return rows.map((row) => normalizeDispatchPlanLoadAssignments({
    id: row.id,
    planDate: planDateValue(row.plan_date),
    status: row.status,
    summary: row.summary || {},
    ownYardCodes: Array.isArray(row.own_yard_codes) ? row.own_yard_codes : undefined,
    orders: Array.isArray(row.orders) ? row.orders : [],
    trucks: Array.isArray(row.trucks) ? row.trucks : []
  }));
}

function assignedTruckForLoad(truck = {}, load = {}) {
  const assignment = dispatchLoadAssignment(truck, load);
  return {
    ...truck,
    id: assignment.truckId || truck.id || "",
    plate: assignment.truckPlate || truck.plate || "",
    driverLogin: assignment.driverLogin,
    driver: assignment.driverName || truck.driver || "",
    parkingSpot: assignment.parkingSpot,
    base: assignment.switchYard || truck.base || ""
  };
}

function driverLoadAssignments(plan, driverLogin) {
  const login = driverKey(driverLogin);
  return flattenDispatchPlanLoads(plan)
    .filter((row) => row.driverLogin === login)
    .map((row) => ({ ...row, truck: assignedTruckForLoad(row.truck, row.load) }))
    .sort((left, right) => {
      const leftStart = left.plannedStartMinute ?? Number.MAX_SAFE_INTEGER;
      const rightStart = right.plannedStartMinute ?? Number.MAX_SAFE_INTEGER;
      return leftStart - rightStart
        || left.driverSequence - right.driverSequence
        || left.truckIndex - right.truckIndex
        || left.loadIndex - right.loadIndex;
    });
}

function orderByRef(plan, ref) {
  const direct = (plan.orders || []).find((order) => String(order.id) === String(ref));
  if (direct) return direct;
  for (const order of plan.orders || []) {
    const child = (order.childOrderDetails || []).find((item) => String(item.id) === String(ref));
    if (child) return child;
  }
  return null;
}

function expandOrderRefs(plan, refs) {
  const expanded = [];
  const seen = new Set();
  const append = (ref) => {
    const id = String(ref || "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    expanded.push(id);
  };
  refs.forEach((ref) => {
    const order = orderByRef(plan, ref);
    const children = Array.isArray(order?.childOrders) ? order.childOrders : [];
    if (children.length) {
      children.forEach(append);
      return;
    }
    append(ref);
  });
  return expanded;
}

function yardAddress(value) {
  return YARD_ADDRESSES[String(value || "")] || value || "";
}

function numberValue(value) {
  return Number(value || 0) || 0;
}

function positiveBalance(value, allocated) {
  return Math.max(numberValue(value) - numberValue(allocated), 0);
}

async function locationAddress(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (YARD_ADDRESSES[text]) return YARD_ADDRESSES[text];
  const result = await query(
    `SELECT address
       FROM dispatch_vendor_yards
      WHERE LOWER(yard) = LOWER($1)
        AND COALESCE(address, '') <> ''
      ORDER BY active DESC, id
      LIMIT 1`,
    [text]
  );
  return result.rows[0]?.address || text;
}

function dropStopsForPickup(plan, load, location) {
  return (load.stops || []).filter((stop) => {
    if (stop.type !== "drop" || !stop.orderId) return false;
    const order = orderByRef(plan, stop.orderId);
    return requiredPickupLocations(order).map(String).includes(String(location));
  });
}

function firstPickupStop(load) {
  return (load.stops || []).find((stop) => stop.type === "pick") || null;
}

function lastRoutedStop(load) {
  const stops = Array.isArray(load?.stops) ? load.stops : [];
  for (let index = stops.length - 1; index >= 0; index -= 1) {
    if (["pick", "drop"].includes(stops[index]?.type)) return stops[index];
  }
  return null;
}

function scopedPurchaseOrderDropLocation(stop = {}, order = {}) {
  const orderType = String(order.type || order.orderType || order.order_type || "").trim().toUpperCase();
  const purchaseOrder = orderType === "PO" || orderType === "PURCHASE_ORDER";
  const lineScoped = Array.isArray(stop.lineRowIds) && stop.lineRowIds.length > 0;
  const dropoffScoped = Boolean(String(stop.dropoffKey || stop.dropoff_key || "").trim());
  return purchaseOrder && (lineScoped || dropoffScoped) ? String(stop.location || "") : "";
}

function dropLocationForStop(stop = {}, order = {}) {
  return String(
    stop.dropLocation
    || stop.drop_location
    || stop.destinationYard
    || stop.destination_yard
    || scopedPurchaseOrderDropLocation(stop, order)
    || order.destinationYard
    || order.destination_yard
    || order.toLocation
    || order.to_location
    || order.address
    || order.id
    || stop.orderId
    || ""
  );
}

function dropAddressForStop(stop = {}, order = {}) {
  const location = dropLocationForStop(stop, order);
  return String(
    stop.dropAddress
    || yardAddress(location)
    || order.address
    || order.dropAddress
    || order.destinationYard
    || location
  );
}

function stopLocationLabel(plan, stop) {
  if (!stop) return "";
  if (stop.type === "pick") return String(stop.location || "");
  const order = orderByRef(plan, stop.orderId) || {};
  return dropLocationForStop(stop, order);
}

function pickupAddressForStop(plan, stop) {
  const order = orderByRef(plan, stop?.orderId) || {};
  return String(
    order.pickupAddressOverride
    || order.sourceAddress
    || yardAddress(stop?.location)
    || ""
  );
}

function stopAddressLabel(plan, stop) {
  if (!stop) return "";
  if (stop.type === "pick") return pickupAddressForStop(plan, stop);
  const order = orderByRef(plan, stop.orderId) || {};
  return dropAddressForStop(stop, order);
}

function loadEndPoint(plan, truck, load) {
  if (!load) return null;
  if (load.returnOnly) {
    const yard = String(load.returnYard || "12441");
    return { location: yard, address: yardAddress(yard) };
  }
  const stop = lastRoutedStop(load);
  if (!stop) return null;
  return {
    location: stopLocationLabel(plan, stop),
    address: stopAddressLabel(plan, stop)
  };
}

function loadEndOwnYard(plan, load) {
  if (!load) return "";
  if (load.returnOnly) {
    const yard = String(load.returnYard || "");
    return isOwnYard(plan, yard) ? yard : "";
  }
  const stop = lastRoutedStop(load);
  if (!stop) return "";
  if (stop.type === "pick") {
    const yard = String(stop.location || "");
    return isOwnYard(plan, yard) ? yard : "";
  }
  const order = orderByRef(plan, stop.orderId) || {};
  const location = dropLocationForStop(stop, order).trim();
  return isOwnYard(plan, location) ? location : "";
}

function buildTruckSwitchApproachJob(plan, previousAssignment, nextAssignment, sequenceIndex) {
  const load = nextAssignment.load;
  const switchYard = String(load.switchYard || load.switch_yard || nextAssignment.truck?.base || "");
  if (!switchYard) return null;
  if (loadEndOwnYard(plan, previousAssignment.load) === switchYard) return null;
  const from = loadEndPoint(plan, previousAssignment.truck, previousAssignment.load);
  if (!from?.location) return null;
  const normalizedFromAddress = String(from.address || "").trim().toLowerCase();
  const normalizedSwitchAddress = String(yardAddress(switchYard) || "").trim().toLowerCase();
  if (normalizedFromAddress && normalizedFromAddress === normalizedSwitchAddress) return null;
  const parsedMinutes = Number(
    load.handoffTravelMinutes
    ?? load.handoff_travel_minutes
    ?? load.timing?.handoffTravel?.minutes
    ?? 30
  );
  const handoffMinutes = Math.max(1, Math.round(Number.isFinite(parsedMinutes) ? parsedMinutes : 30));
  const parsedSwitchMinutes = Number(load.truckSwitchMinutes ?? load.truck_switch_minutes ?? 10);
  const switchMinutes = Math.max(0, Math.round(Number.isFinite(parsedSwitchMinutes) ? parsedSwitchMinutes : 10));
  const plannedFinishMinute = Number.isFinite(Number(nextAssignment.plannedStartMinute))
    ? Number(nextAssignment.plannedStartMinute) - switchMinutes
    : null;
  const plannedStartMinute = plannedFinishMinute === null ? null : plannedFinishMinute - handoffMinutes;
  return {
    jobId: travelJobId(
      plan,
      previousAssignment.truck,
      load,
      from.location,
      switchYard,
      "TRUCK_SWITCH_APPROACH"
    ),
    planId: plan.id,
    planDate: plan.planDate,
    driverLogin: nextAssignment.driverLogin,
    driverName: nextAssignment.driverName || previousAssignment.driverName || "",
    truckId: previousAssignment.truck?.id || "",
    truckPlate: previousAssignment.truck?.plate || "",
    parkingSpot: previousAssignment.parkingSpot || previousAssignment.truck?.parkingSpot || "",
    loadId: load.id || "",
    loadName: load.name || "",
    stopId: `travel-switch-${load.id || sequenceIndex}`,
    stopType: "travel",
    location: `${from.location} to ${switchYard}`,
    address: yardAddress(switchYard),
    fromLocation: from.location,
    fromAddress: from.address || yardAddress(from.location),
    toLocation: switchYard,
    toAddress: yardAddress(switchYard),
    windowStart: "",
    windowEnd: "",
    instructions: `Travel to ${switchYard} before switching from ${previousAssignment.truck?.plate || "the current truck"} to ${nextAssignment.truck?.plate || "the next truck"}.`,
    orderRefs: [],
    orderTypes: [],
    requiredPhotos: 0,
    handoffTravel: true,
    plannedStartMinute,
    plannedFinishMinute,
    sequence: { truckIndex: previousAssignment.truckIndex, loadIndex: sequenceIndex, stopIndex: -3 }
  };
}

function startTravelForLoad(plan, truck, load, loadIndex, previousAssignment = null) {
  const firstPickup = firstPickupStop(load);
  if (!firstPickup?.location) return null;
  const toAddress = stopAddressLabel(plan, firstPickup);
  let from = null;
  if (previousAssignment) {
    if (String(previousAssignment.truck?.plate || "") !== String(truck?.plate || "")) {
      const switchYard = String(load.switchYard || load.switch_yard || truck.base || "");
      from = switchYard ? { location: switchYard, address: yardAddress(switchYard) } : null;
    } else {
      from = loadEndPoint(plan, previousAssignment.truck, previousAssignment.load);
    }
  } else if (loadIndex <= 0) {
    if (!truck?.base) return null;
    from = { location: String(truck.base), address: yardAddress(truck.base) };
  } else {
    from = loadEndPoint(plan, truck, (truck.loads || [])[loadIndex - 1]);
  }
  if (!from?.location) return null;
  const sameLocation = String(from.location) === String(firstPickup.location);
  const sameAddress = String(from.address || "").trim().toLowerCase() === String(toAddress || "").trim().toLowerCase();
  if (sameLocation && sameAddress) return null;
  return {
    from: from.location,
    fromAddress: from.address || yardAddress(from.location),
    to: String(firstPickup.location),
    toAddress
  };
}

function buildTravelJob(plan, truck, load, truckIndex, loadIndex, previousAssignment = null) {
  const travel = startTravelForLoad(plan, truck, load, loadIndex, previousAssignment);
  if (!travel) return null;
  return {
    jobId: travelJobId(plan, truck, load, travel.from, travel.to),
    planId: plan.id,
    planDate: plan.planDate,
    driverLogin: driverKey(truck.driverLogin || truck.driver),
    driverName: truck.driver || "",
    truckId: truck.id || "",
    truckPlate: truck.plate || "",
    parkingSpot: truck.parkingSpot || "",
    loadId: load.id || "",
    loadName: load.name || "",
    stopId: `travel-${travel.from}-${travel.to}`,
    stopType: "travel",
    location: `${travel.from} to ${travel.to}`,
    address: travel.toAddress,
    fromLocation: travel.from,
    fromAddress: travel.fromAddress,
    toLocation: travel.to,
    toAddress: travel.toAddress,
    windowStart: "",
    windowEnd: "",
    instructions: "Travel to the pickup yard before loading.",
    orderRefs: [],
    orderTypes: [],
    requiredPhotos: 0,
    sequence: { truckIndex, loadIndex, stopIndex: -1 }
  };
}

function loadHasDirectDependency(plan, load) {
  return (load.stops || []).some((stop) => {
    if (stop.type !== "drop") return false;
    return (orderByRef(plan, stop.orderId)?.directPickupManifest || []).length > 0;
  });
}

function buildInterStopTravelJob(plan, truck, load, previousStop, stop, truckIndex, loadIndex, stopIndex) {
  if (!previousStop || !stop) return null;
  const from = stopLocationLabel(plan, previousStop);
  const to = stopLocationLabel(plan, stop);
  const fromAddress = stopAddressLabel(plan, previousStop);
  const toAddress = stopAddressLabel(plan, stop);
  if (!from || !to || (String(from) === String(to) && String(fromAddress) === String(toAddress))) return null;
  const legKey = `${previousStop.id || stopIndex - 1}-${stop.id || stopIndex}`;
  return {
    jobId: travelJobId(plan, truck, load, from, to, legKey),
    planId: plan.id,
    planDate: plan.planDate,
    driverLogin: driverKey(truck.driverLogin || truck.driver),
    driverName: truck.driver || "",
    truckId: truck.id || "",
    truckPlate: truck.plate || "",
    parkingSpot: truck.parkingSpot || "",
    loadId: load.id || "",
    loadName: load.name || "",
    stopId: `travel-${legKey}`,
    stopType: "travel",
    location: `${from} to ${to}`,
    address: toAddress,
    fromLocation: from,
    fromAddress,
    toLocation: to,
    toAddress,
    windowStart: "",
    windowEnd: "",
    instructions: "Travel to the next required stop.",
    orderRefs: [],
    orderTypes: [],
    requiredPhotos: 0,
    sequence: { truckIndex, loadIndex, stopIndex: stopIndex - 0.5 }
  };
}

function buildReturnJob(plan, truck, load, truckIndex, loadIndex, previousAssignment = null) {
  const changedTruck = previousAssignment
    && String(previousAssignment.truck?.plate || "") !== String(truck?.plate || "");
  const switchYard = String(load.switchYard || load.switch_yard || truck.base || "");
  const previous = changedTruck
    ? { location: switchYard, address: yardAddress(switchYard) }
    : previousAssignment
      ? loadEndPoint(plan, previousAssignment.truck, previousAssignment.load)
    : loadEndPoint(plan, truck, (truck.loads || [])[loadIndex - 1]);
  const to = String(load.returnYard || "12441");
  const from = previous?.location || String(truck.base || "");
  if (!from || String(from) === to) return null;
  return {
    jobId: returnJobId(plan, truck, load, from, to),
    planId: plan.id,
    planDate: plan.planDate,
    driverLogin: driverKey(truck.driverLogin || truck.driver),
    driverName: truck.driver || "",
    truckId: truck.id || "",
    truckPlate: truck.plate || "",
    parkingSpot: truck.parkingSpot || "",
    loadId: load.id || "",
    loadName: load.name || "Return Load",
    stopId: `return-${from}-${to}`,
    stopType: "travel",
    location: `${from} to ${to}`,
    address: yardAddress(to),
    fromLocation: from,
    fromAddress: previous?.address || yardAddress(from),
    toLocation: to,
    toAddress: yardAddress(to),
    windowStart: "",
    windowEnd: "",
    instructions: "Return to yard.",
    orderRefs: [],
    orderTypes: [],
    requiredPhotos: 0,
    sequence: { truckIndex, loadIndex, stopIndex: -1 }
  };
}

function buildTruckSwitchJob(plan, previousAssignment, nextAssignment, sequenceIndex) {
  const load = nextAssignment.load;
  const truck = nextAssignment.truck;
  const switchYard = String(load.switchYard || load.switch_yard || truck.base || "");
  const parsedSwitchMinutes = Number(load.truckSwitchMinutes ?? load.truck_switch_minutes ?? 10);
  const switchMinutes = Math.max(0, Math.round(Number.isFinite(parsedSwitchMinutes) ? parsedSwitchMinutes : 10));
  return {
    jobId: truckSwitchJobId(plan, nextAssignment.driverLogin, load),
    planId: plan.id,
    planDate: plan.planDate,
    driverLogin: nextAssignment.driverLogin,
    driverName: nextAssignment.driverName || truck.driver || "",
    truckId: truck.id || "",
    truckPlate: truck.plate || "",
    fromTruckId: previousAssignment.truck?.id || "",
    fromTruckPlate: previousAssignment.truck?.plate || "",
    nextTruckId: truck.id || "",
    nextTruckPlate: truck.plate || "",
    parkingSpot: nextAssignment.parkingSpot || truck.parkingSpot || "",
    switchYard,
    plannedSwitchMinute: Number.isFinite(Number(nextAssignment.plannedStartMinute))
      ? Number(nextAssignment.plannedStartMinute) - switchMinutes
      : null,
    truckSwitchMinutes: switchMinutes,
    loadId: load.id || "",
    loadName: load.name || "",
    stopId: `truck-switch-${load.id || sequenceIndex}`,
    stopType: "truck_switch",
    location: switchYard,
    address: yardAddress(switchYard),
    windowStart: "",
    windowEnd: "",
    instructions: `Switch from ${previousAssignment.truck?.plate || "previous truck"} to ${truck.plate || "next truck"}.`,
    orderRefs: [],
    orderTypes: [],
    requiredPhotos: 0,
    sequence: { truckIndex: nextAssignment.truckIndex, loadIndex: sequenceIndex, stopIndex: -2 }
  };
}

function buildJob(plan, truck, load, stop, truckIndex, loadIndex, stopIndex) {
  const isPickup = stop.type === "pick";
  const relatedStops = isPickup ? dropStopsForPickup(plan, load, stop.location) : [stop];
  const stopOrderRefs = [...new Set(relatedStops.map((item) => String(item.orderId || "")).filter(Boolean))];
  const dependencyPickupManifests = isPickup
    ? relatedStops.flatMap((relatedStop) => {
        const order = orderByRef(plan, relatedStop.orderId) || {};
        return (order.directPickupManifest || [])
          .filter((entry) => String(entry.location || "") === String(stop.location || ""))
          .map((entry) => ({ ...entry, salesOrderRef: entry.salesOrderRef || String(relatedStop.orderId || "") }));
      })
    : [];
  const directTransferRefs = dependencyPickupManifests.map((entry) => String(entry.transferOrderRef || "")).filter(Boolean);
  const ordinaryStopRefs = isPickup
    ? stopOrderRefs.filter((ref) => {
        const order = orderByRef(plan, ref) || {};
        const hasDirectHere = (order.directPickupManifest || []).some((entry) => String(entry.location || "") === String(stop.location || ""));
        return !hasDirectHere || String(order.sourceYard || order.outboundLocation || "") === String(stop.location || "");
      })
    : stopOrderRefs;
  const orderRefs = [...new Set([...expandOrderRefs(plan, ordinaryStopRefs), ...directTransferRefs])];
  const firstOrder = orderByRef(plan, stopOrderRefs[0]) || orderByRef(plan, orderRefs[0]) || {};
  const dropLocation = isPickup ? "" : dropLocationForStop(stop, firstOrder);
  const dropAddress = isPickup ? "" : dropAddressForStop(stop, firstOrder);
  return {
    jobId: jobId(plan, truck, load, stop),
    planId: plan.id,
    planDate: plan.planDate,
    driverLogin: driverKey(truck.driverLogin || truck.driver),
    driverName: truck.driver || "",
    truckId: truck.id || "",
    truckPlate: truck.plate || "",
    parkingSpot: truck.parkingSpot || "",
    loadId: load.id || "",
    loadName: load.name || "",
    stopId: stop.id || "",
    stopType: isPickup ? "pickup" : "dropoff",
    location: isPickup ? stop.location : dropLocation,
    address: isPickup
      ? (firstOrder.pickupAddressOverride || firstOrder.sourceAddress || pickupAddressForStop(plan, stop))
      : dropAddress,
    dropLocation,
    dropAddress,
    destinationLocationId: stop.destinationLocationId ?? null,
    lineRowIds: (stop.lineRowIds || []).map(String),
    windowStart: isPickup ? "" : (firstOrder.windowStart || ""),
    windowEnd: isPickup ? "" : (firstOrder.windowEnd || ""),
    instructions: firstOrder.notes || firstOrder.dispatchInstructions || "",
    orderRefs,
    orderTypes: [...new Set(orderRefs.map((ref) => directTransferRefs.includes(ref) ? "TO" : orderByRef(plan, ref)?.type).filter(Boolean))],
    dependencyPickupManifests,
    requiredPhotos: 2,
    sequence: { truckIndex, loadIndex, stopIndex }
  };
}

async function completedJobIds(jobIds) {
  if (!jobIds.length) return new Set();
  const result = await query(
    `SELECT job_id
       FROM driver_job_records
      WHERE job_id = ANY($1::text[])
        AND status = 'complete'`,
    [jobIds]
  );
  return new Set(result.rows.map((row) => row.job_id));
}

async function jobStatusMap(jobIds) {
  if (!jobIds.length) return new Map();
  const result = await query(
    `SELECT DISTINCT ON (job_id)
            job_id, status, started_at, completed_at
       FROM driver_job_records
      WHERE job_id = ANY($1::text[])
      ORDER BY job_id, completed_at DESC NULLS LAST, started_at DESC NULLS LAST, created_at DESC`,
    [jobIds]
  );
  return new Map(result.rows.map((row) => [row.job_id, row]));
}

async function confirmedPlans() {
  const result = await query(
    `SELECT p.id, p.plan_date, p.status, s.orders, s.trucks, s.summary
       FROM dispatch_plans p
       INNER JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.status = 'confirmed'
      ORDER BY p.plan_date ASC, p.updated_at ASC`
  );
  return sortedPlans(result.rows);
}

function planJobsForTruck(plan, truck, truckIndex) {
  const jobs = [];
  (truck.loads || []).forEach((load, loadIndex) => {
    if (load.returnOnly) {
      const returnJob = buildReturnJob(plan, truck, load, truckIndex, loadIndex);
      if (returnJob) jobs.push(returnJob);
      return;
    }
    const travelJob = buildTravelJob(plan, truck, load, truckIndex, loadIndex);
    if (travelJob) jobs.push(travelJob);
    const requireInterStopTravel = loadHasDirectDependency(plan, load);
    let previousRoutedStop = null;
    (load.stops || []).forEach((stop, stopIndex) => {
      if (!["pick", "drop"].includes(stop.type)) return;
      if (requireInterStopTravel && previousRoutedStop) {
        const legJob = buildInterStopTravelJob(plan, truck, load, previousRoutedStop, stop, truckIndex, loadIndex, stopIndex);
        if (legJob) jobs.push(legJob);
      }
      jobs.push(buildJob(plan, truck, load, stop, truckIndex, loadIndex, stopIndex));
      previousRoutedStop = stop;
    });
  });
  return jobs;
}

async function refreshProjectedLoadExecution(job = {}) {
  if (!job.planId || !job.loadId || !job.driverLogin) return;
  const planResult = await query(
    `SELECT p.id, p.plan_date, p.status, s.orders, s.trucks
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.id = $1
      LIMIT 1`,
    [job.planId]
  );
  if (!planResult.rowCount) return;
  const plan = sortedPlans(planResult.rows)[0];
  const expected = planJobsForDriver(plan, job.driverLogin).filter((item) => String(item.loadId) === String(job.loadId));
  if (!expected.length) return;
  const statuses = await jobStatusMap(expected.map((item) => item.jobId));
  const started = expected.some((item) => ["in_progress", "complete"].includes(statuses.get(item.jobId)?.status));
  const completed = expected.every((item) => statuses.get(item.jobId)?.status === "complete");
  await query(
    `UPDATE dispatch_plan_load_assignments
        SET started = $3, completed = $4, updated_at = now()
      WHERE plan_id = $1 AND load_id = $2`,
    [job.planId, job.loadId, started, completed]
  ).catch(() => null);
}

export function planJobsForDriver(plan, driverLogin) {
  const assignments = driverLoadAssignments(plan, driverLogin);
  const jobs = [];
  assignments.forEach((assignment, assignmentIndex) => {
    const { truck, load, truckIndex } = assignment;
    const previousAssignment = assignmentIndex > 0 ? assignments[assignmentIndex - 1] : null;
    if (previousAssignment && previousAssignment.truck.plate !== truck.plate) {
      const approachJob = buildTruckSwitchApproachJob(plan, previousAssignment, assignment, assignmentIndex);
      if (approachJob) jobs.push(approachJob);
      jobs.push(buildTruckSwitchJob(plan, previousAssignment, assignment, assignmentIndex));
    }
    if (load.returnOnly) {
      const returnJob = buildReturnJob(plan, truck, load, truckIndex, assignmentIndex, previousAssignment);
      if (returnJob) jobs.push(returnJob);
      return;
    }
    const travelJob = buildTravelJob(plan, truck, load, truckIndex, assignmentIndex, previousAssignment);
    if (travelJob) jobs.push(travelJob);
    const requireInterStopTravel = loadHasDirectDependency(plan, load);
    let previousRoutedStop = null;
    (load.stops || []).forEach((stop, stopIndex) => {
      if (!["pick", "drop"].includes(stop.type)) return;
      if (requireInterStopTravel && previousRoutedStop) {
        const legJob = buildInterStopTravelJob(plan, truck, load, previousRoutedStop, stop, truckIndex, assignmentIndex, stopIndex);
        if (legJob) jobs.push(legJob);
      }
      jobs.push(buildJob(plan, truck, load, stop, truckIndex, assignmentIndex, stopIndex));
      previousRoutedStop = stop;
    });
  });
  return jobs;
}

async function activeDriverAssignment(driverLogin) {
  const login = driverKey(driverLogin);
  const today = todayLocalDate();
  const matches = [];
  for (const plan of await confirmedPlans()) {
    if (plan.planDate < today) continue;
    const assignments = driverLoadAssignments(plan, login);
    if (!assignments.length) continue;
    matches.push({
      plan,
      assignments,
      truck: assignments[0].truck,
      truckIndex: assignments[0].truckIndex,
      initialTruck: assignments[0].truck,
      finalTruck: assignments[assignments.length - 1].truck
    });
  }
  if (!matches.length) return null;
  return matches[0];
}

function dvirStatus(row, type) {
  if (!row) return "required";
  return type === "post"
    ? row.post_dvir_completed_at ? "complete" : "required"
    : row.pre_dvir_completed_at ? "complete" : "required";
}

function normalizedPlate(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

function isSamsaraOnDutyConfirmed(row) {
  const response = row?.samsara_on_duty_response || {};
  const clock = response.clock || {};
  return Boolean(
    row?.on_duty_at
    && response.responseStatus === 200
    && clock.currentDutyStatus?.hosStatusType === "onDuty"
    && clock.currentVehicle?.id
  );
}

function isSamsaraDvirConfirmed(row, type = "pre") {
  const key = type === "post" ? "samsara_off_duty_response" : "samsara_on_duty_response";
  const response = row?.[key] || {};
  const dvir = response.dvir || response.verifiedDvir || {};
  const dvirVehicleId = String(dvir.vehicle?.id || "");
  const dvirPlate = normalizedPlate(dvir.licensePlate || dvir.vehicle?.licensePlate || response.dvir?.licensePlate || "");
  const currentPlate = normalizedPlate(type === "pre"
    ? row?.initial_truck_plate || row?.truck_plate || ""
    : row?.current_truck_plate || row?.truck_plate || "");
  if (!(dvir.id || response.dvirId)) return false;
  if (currentPlate && dvirPlate !== currentPlate) return false;
  if (type === "post" && row?.samsara_vehicle_id && dvirVehicleId && dvirVehicleId !== String(row.samsara_vehicle_id)) return false;
  return true;
}

function isSamsaraOffDutyConfirmed(row) {
  const response = row?.samsara_off_duty_response || {};
  const clock = response.clock || {};
  return Boolean(
    row?.off_duty_at
    && response.responseStatus === 200
    && clock.currentDutyStatus?.hosStatusType === "offDuty"
  );
}

async function upsertDriverDayBase({ driverLogin, plan, truck, samsaraUsername = "", samsaraAccounts = {} }) {
  const normalizedSamsaraAccounts = samsaraAccountsFromLegacy(samsaraUsername, samsaraAccounts);
  const login = driverKey(driverLogin);
  const planDate = plan?.planDate || todayLocalDate();
  const result = await query(
    `INSERT INTO driver_day_records (
       driver_login, plan_id, plan_date, truck_id, truck_plate,
       initial_truck_id, initial_truck_plate, current_truck_id, current_truck_plate,
       samsara_username, samsara_secondary_username
     ) VALUES ($1, $2, $3::date, $4, $5, $4, $5, $4, $5, $6, $7)
     ON CONFLICT (driver_login, plan_date) DO UPDATE SET
       plan_id = EXCLUDED.plan_id,
       initial_truck_id = COALESCE(NULLIF(driver_day_records.initial_truck_id, ''), EXCLUDED.initial_truck_id),
       initial_truck_plate = COALESCE(NULLIF(driver_day_records.initial_truck_plate, ''), EXCLUDED.initial_truck_plate),
       current_truck_id = COALESCE(NULLIF(driver_day_records.current_truck_id, ''), EXCLUDED.current_truck_id),
       current_truck_plate = COALESCE(NULLIF(driver_day_records.current_truck_plate, ''), EXCLUDED.current_truck_plate),
       truck_id = COALESCE(NULLIF(driver_day_records.current_truck_id, ''), EXCLUDED.truck_id),
       truck_plate = COALESCE(NULLIF(driver_day_records.current_truck_plate, ''), EXCLUDED.truck_plate),
       samsara_username = COALESCE(NULLIF(EXCLUDED.samsara_username, ''), driver_day_records.samsara_username),
       samsara_secondary_username = COALESCE(NULLIF(EXCLUDED.samsara_secondary_username, ''), driver_day_records.samsara_secondary_username),
       updated_at = now()
     RETURNING *`,
    [
      login,
      plan?.id || null,
      planDate,
      truck?.id || "",
      truck?.plate || "",
      normalizedSamsaraAccounts.primaryUsername || "",
      normalizedSamsaraAccounts.secondaryUsername || ""
    ]
  );
  return result.rows[0];
}

async function clearUnconfirmedDvirIfNeeded(row) {
  const clearPre = Boolean(row?.pre_dvir_completed_at && !isSamsaraDvirConfirmed(row, "pre"));
  const clearPost = Boolean(row?.post_dvir_completed_at && !isSamsaraDvirConfirmed(row, "post"));
  if (!clearPre && !clearPost) return row;
  const result = await query(
    `UPDATE driver_day_records
        SET pre_dvir_photo_data_urls = CASE WHEN $2 = true THEN '[]'::jsonb ELSE pre_dvir_photo_data_urls END,
            pre_dvir_completed_at = CASE WHEN $2 = true THEN NULL ELSE pre_dvir_completed_at END,
            on_duty_at = CASE WHEN $2 = true THEN NULL ELSE on_duty_at END,
            samsara_driver_id = CASE WHEN $2 = true THEN NULL ELSE samsara_driver_id END,
            samsara_vehicle_id = CASE WHEN $2 = true THEN NULL ELSE samsara_vehicle_id END,
            samsara_assignment_response = CASE WHEN $2 = true THEN '{}'::jsonb ELSE samsara_assignment_response END,
            samsara_on_duty_response = CASE WHEN $2 = true THEN '{}'::jsonb ELSE samsara_on_duty_response END,
            post_dvir_photo_data_urls = CASE WHEN $3 = true THEN '[]'::jsonb ELSE post_dvir_photo_data_urls END,
            post_dvir_completed_at = CASE WHEN $3 = true THEN NULL ELSE post_dvir_completed_at END,
            off_duty_at = CASE WHEN $3 = true THEN NULL ELSE off_duty_at END,
            samsara_active_account = CASE WHEN $2 = true THEN 'primary' ELSE samsara_active_account END,
            primary_off_duty_at = CASE WHEN $2 = true THEN NULL ELSE primary_off_duty_at END,
            secondary_on_duty_at = CASE WHEN $2 = true THEN NULL ELSE secondary_on_duty_at END,
            secondary_off_duty_at = CASE WHEN $2 = true THEN NULL ELSE secondary_off_duty_at END,
            samsara_off_duty_response = CASE WHEN $3 = true THEN '{}'::jsonb ELSE samsara_off_duty_response END,
            samsara_secondary_driver_id = CASE WHEN $2 = true THEN NULL ELSE samsara_secondary_driver_id END,
            samsara_secondary_vehicle_id = CASE WHEN $2 = true THEN NULL ELSE samsara_secondary_vehicle_id END,
            samsara_secondary_assignment_response = CASE WHEN $2 = true THEN '{}'::jsonb ELSE samsara_secondary_assignment_response END,
            samsara_secondary_on_duty_response = CASE WHEN $2 = true THEN '{}'::jsonb ELSE samsara_secondary_on_duty_response END,
            samsara_secondary_off_duty_response = CASE WHEN $3 = true OR $2 = true THEN '{}'::jsonb ELSE samsara_secondary_off_duty_response END,
            samsara_handoff_response = CASE WHEN $2 = true THEN '{}'::jsonb ELSE samsara_handoff_response END,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [row.id, clearPre, clearPost || clearPre]
  );
  return result.rows[0] || row;
}

export async function getDriverDayState(driverLogin, { samsaraUsername = "", samsaraAccounts = {} } = {}) {
  const normalizedSamsaraAccounts = samsaraAccountsFromLegacy(samsaraUsername, samsaraAccounts);
  const assignment = await activeDriverAssignment(driverLogin);
  const plan = assignment?.plan || { id: null, planDate: todayLocalDate() };
  const initialTruck = assignment?.initialTruck || assignment?.truck || {};
  let row = await upsertDriverDayBase({ driverLogin, plan, truck: initialTruck, samsaraAccounts: normalizedSamsaraAccounts });
  row = await clearUnconfirmedDvirIfNeeded(row);
  const jobs = assignment ? planJobsForDriver(plan, driverLogin) : [];
  const jobIds = jobs.map((job) => job.jobId);
  const completed = await completedJobIds(jobIds);
  const allJobsComplete = jobs.length > 0 && jobs.every((job) => completed.has(job.jobId));
  const currentTruck = assignment?.assignments?.find((item) =>
    normalizedPlate(item.truck.plate) === normalizedPlate(row.current_truck_plate || row.truck_plate)
  )?.truck || initialTruck;
  const nextPendingJob = jobs.find((job) => !completed.has(job.jobId)) || null;
  const nextTruck = nextPendingJob
    ? assignment?.assignments?.find((item) => normalizedPlate(item.truck.plate) === normalizedPlate(nextPendingJob.truckPlate))?.truck || null
    : null;
  const truckSegments = [];
  for (const item of assignment?.assignments || []) {
    const previous = truckSegments[truckSegments.length - 1];
    if (previous && normalizedPlate(previous.truckPlate) === normalizedPlate(item.truck.plate)) {
      previous.loadIds.push(String(item.load.id || ""));
      previous.finishMinute = item.plannedFinishMinute;
      continue;
    }
    truckSegments.push({
      truckId: item.truck.id || "",
      truckPlate: item.truck.plate || "",
      parkingSpot: item.parkingSpot || item.truck.parkingSpot || "",
      switchYard: item.switchYard || item.truck.base || "",
      startMinute: item.plannedStartMinute,
      finishMinute: item.plannedFinishMinute,
      loadIds: [String(item.load.id || "")]
    });
  }
  const switchAttentionResult = await query(
    `SELECT job_id, from_truck_plate, to_truck_plate, switch_yard, parking_spot,
            next_load_id, samsara_error, updated_at
       FROM driver_truck_switch_records
      WHERE driver_login = $1
        AND plan_date = $2::date
        AND status = 'attention'
      ORDER BY updated_at DESC`,
    [driverKey(driverLogin), plan?.planDate || todayLocalDate()]
  ).catch(() => ({ rows: [] }));
  return {
    planId: plan?.id || null,
    planDate: plan?.planDate || todayLocalDate(),
    truckId: currentTruck?.id || "",
    truckPlate: currentTruck?.plate || "",
    parkingSpot: currentTruck?.parkingSpot || "",
    initialTruck: { id: initialTruck?.id || "", plate: initialTruck?.plate || "", parkingSpot: initialTruck?.parkingSpot || "" },
    currentTruck: { id: currentTruck?.id || "", plate: currentTruck?.plate || "", parkingSpot: currentTruck?.parkingSpot || "" },
    nextTruck: nextTruck ? { id: nextTruck.id || "", plate: nextTruck.plate || "", parkingSpot: nextTruck.parkingSpot || "" } : null,
    truckSegments,
    truckSwitchAttention: switchAttentionResult.rows.map((item) => ({
      jobId: item.job_id,
      fromTruckPlate: item.from_truck_plate,
      toTruckPlate: item.to_truck_plate,
      switchYard: item.switch_yard,
      parkingSpot: item.parking_spot,
      nextLoadId: item.next_load_id,
      error: item.samsara_error,
      updatedAt: item.updated_at
    })),
    samsaraUsername: row.samsara_username || normalizedSamsaraAccounts.primaryUsername || "",
    samsaraSecondaryUsername: row.samsara_secondary_username || normalizedSamsaraAccounts.secondaryUsername || "",
    samsaraActiveAccount: row.samsara_active_account || "primary",
    preDvirStatus: dvirStatus(row, "pre") === "complete" && isSamsaraDvirConfirmed(row, "pre") ? "complete" : "required",
    postDvirStatus: dvirStatus(row, "post") === "complete" && isSamsaraDvirConfirmed(row, "post") ? "complete" : "required",
    preDvirCompletedAt: row.pre_dvir_completed_at || null,
    postDvirCompletedAt: row.post_dvir_completed_at || null,
    onDutyAt: row.on_duty_at || null,
    offDutyAt: row.off_duty_at || null,
    primaryOffDutyAt: row.primary_off_duty_at || null,
    secondaryOnDutyAt: row.secondary_on_duty_at || null,
    secondaryOffDutyAt: row.secondary_off_duty_at || null,
    samsaraOnDutyConfirmed: isSamsaraOnDutyConfirmed(row),
    samsaraOffDutyConfirmed: isSamsaraOffDutyConfirmed(row),
    samsaraPreDvirConfirmed: isSamsaraDvirConfirmed(row, "pre"),
    samsaraPostDvirConfirmed: isSamsaraDvirConfirmed(row, "post"),
    samsaraOnDutyError: row.samsara_on_duty_response?.error || row.samsara_on_duty_response?.clockError || "",
    samsaraOffDutyError: row.samsara_off_duty_response?.error || row.samsara_off_duty_response?.clockError || "",
    allJobsComplete,
    jobCount: jobs.length,
    completedJobCount: completed.size
  };
}

export async function submitDriverDvir(driverLogin, { type = "pre", photoDataUrls = [], samsaraUsername = "", samsaraAccounts = {}, samsaraDvirAuthorId = "" } = {}) {
  const normalizedSamsaraAccounts = samsaraAccountsFromLegacy(samsaraUsername, samsaraAccounts);
  const assignment = await activeDriverAssignment(driverLogin);
  const plan = assignment?.plan || { id: null, planDate: todayLocalDate() };
  const initialTruck = assignment?.initialTruck || assignment?.truck || {};
  if (!initialTruck?.plate) throw new Error("No assigned truck was found in the confirmed dispatch plan.");
  let row = await upsertDriverDayBase({ driverLogin, plan, truck: initialTruck, samsaraAccounts: normalizedSamsaraAccounts });
  const currentTruck = assignment?.assignments?.find((item) =>
    normalizedPlate(item.truck.plate) === normalizedPlate(row.current_truck_plate || row.truck_plate)
  )?.truck;
  const truck = type === "post"
    ? currentTruck || assignment?.finalTruck || initialTruck
    : initialTruck;
  const photos = Array.isArray(photoDataUrls) ? photoDataUrls.filter(isPhotoReference) : [];
  if (photos.length < 4) throw new Error("4 inspection photos are required.");
  let samsaraAssignment = null;
  let samsaraDuty = null;
  let samsaraDvir = null;
  let verifiedDvir = null;
  let samsaraError = "";
  const activeAccount = type === "post" && row.samsara_active_account === "secondary" ? "secondary" : "primary";
  const selectedUsername = type === "post"
    ? samsaraUsernameForAccount(normalizedSamsaraAccounts, activeAccount)
    : normalizedSamsaraAccounts.primaryUsername;
  const selectedVehicleId = activeAccount === "secondary"
    ? row.samsara_secondary_vehicle_id || row.samsara_vehicle_id || ""
    : row.samsara_vehicle_id || "";
  try {
    if (type === "pre" && selectedUsername) {
      samsaraAssignment = await createSamsaraDriverVehicleAssignment({
        username: selectedUsername,
        vehiclePlate: truck.plate
      });
      samsaraDuty = await setSamsaraDriverDutyStatus({
        username: selectedUsername,
        vehicleId: samsaraAssignment.vehicle?.id || "",
        dutyStatus: "ON_DUTY",
        remark: `MBBS pre-DVIR complete with ${truck.plate}`
      });
      samsaraDvir = await createSamsaraMechanicDvir({
        authorId: samsaraDvirAuthorId || config.samsara.dvirAuthorId || "",
        vehicleId: samsaraAssignment.vehicle?.id || "",
        licensePlate: truck.plate,
        location: truck.base || truck.parkingSpot || "",
        safetyStatus: "safe",
        mechanicNotes: `MBBS pre-trip inspection submitted from Driver PWA by ${selectedUsername}. Four photos are stored in MBBS.`
      });
      verifiedDvir = await findSamsaraDvirForVehicle({
        vehicleId: samsaraAssignment.vehicle?.id || "",
        sinceTime: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        type: "mechanic"
      });
      if (!verifiedDvir && !samsaraDvir?.dvir?.id) {
        throw new Error("Samsara DVIR was not found after submission. Please redo the inspection in MBBS.");
      }
    }
    if (type === "post" && selectedUsername) {
      samsaraDuty = await setSamsaraDriverDutyStatus({
        username: selectedUsername,
        vehicleId: selectedVehicleId,
        dutyStatus: "OFF_DUTY",
        remark: `MBBS post-DVIR complete with ${truck.plate} (${activeAccount} account)`
      });
      samsaraDvir = await createSamsaraMechanicDvir({
        authorId: samsaraDvirAuthorId || config.samsara.dvirAuthorId || "",
        vehicleId: selectedVehicleId,
        licensePlate: truck.plate,
        location: truck.base || truck.parkingSpot || "",
        safetyStatus: "safe",
        mechanicNotes: `MBBS post-trip inspection submitted from Driver PWA by ${selectedUsername}. Four photos are stored in MBBS.`
      });
      verifiedDvir = await findSamsaraDvirForVehicle({
        vehicleId: selectedVehicleId,
        sinceTime: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        type: "mechanic"
      });
      if (!verifiedDvir && !samsaraDvir?.dvir?.id) {
        throw new Error("Samsara DVIR was not found after submission. Please redo the inspection in MBBS.");
      }
    }
  } catch (error) {
    samsaraError = error.message;
  }
  const samsaraConfirmed = Boolean(samsaraDuty && !samsaraError && (verifiedDvir || samsaraDvir?.dvir?.id));
  const dvirPayload = {
    ...(samsaraDuty || {}),
    ...(samsaraError ? { error: samsaraError } : {}),
    dvir: samsaraDvir?.dvir || null,
    dvirId: samsaraDvir?.dvir?.id || verifiedDvir?.id || "",
    verifiedDvir: verifiedDvir || null
  };
  const result = await query(
    type === "post"
      ? `UPDATE driver_day_records
            SET post_dvir_photo_data_urls = CASE WHEN $4 = true THEN $2::jsonb ELSE post_dvir_photo_data_urls END,
                post_dvir_completed_at = CASE WHEN $4 = true THEN now() ELSE post_dvir_completed_at END,
                off_duty_at = CASE WHEN $4 = true THEN now() ELSE off_duty_at END,
                secondary_off_duty_at = CASE WHEN $4 = true AND $5 = 'secondary' THEN now() ELSE secondary_off_duty_at END,
                samsara_off_duty_response = $3::jsonb,
                samsara_secondary_off_duty_response = CASE WHEN $5 = 'secondary' THEN $3::jsonb ELSE samsara_secondary_off_duty_response END,
                updated_at = now()
          WHERE id = $1
          RETURNING *`
      : `UPDATE driver_day_records
            SET pre_dvir_photo_data_urls = CASE WHEN $7 = true THEN $2::jsonb ELSE '[]'::jsonb END,
                pre_dvir_completed_at = CASE WHEN $7 = true THEN now() ELSE NULL END,
                on_duty_at = CASE WHEN $7 = true THEN now() ELSE NULL END,
                samsara_active_account = CASE WHEN $7 = true THEN 'primary' ELSE samsara_active_account END,
                samsara_username = COALESCE(NULLIF($8, ''), samsara_username),
                samsara_secondary_username = COALESCE(NULLIF($9, ''), samsara_secondary_username),
                samsara_driver_id = COALESCE(NULLIF($4, ''), samsara_driver_id),
                samsara_vehicle_id = COALESCE(NULLIF($5, ''), samsara_vehicle_id),
                samsara_assignment_response = $6::jsonb,
                samsara_on_duty_response = $3::jsonb,
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
    type === "post"
      ? [
          row.id,
          JSON.stringify(photos),
          JSON.stringify(dvirPayload),
          samsaraConfirmed,
          activeAccount
        ]
      : [
          row.id,
          JSON.stringify(photos),
          JSON.stringify(dvirPayload),
          samsaraAssignment?.driver?.id || "",
          samsaraAssignment?.vehicle?.id || "",
          JSON.stringify(samsaraAssignment || (samsaraError ? { error: samsaraError } : {})),
          samsaraConfirmed,
          normalizedSamsaraAccounts.primaryUsername || "",
          normalizedSamsaraAccounts.secondaryUsername || ""
        ]
  );
  row = result.rows[0];
  return {
    state: await getDriverDayState(driverLogin, { samsaraAccounts: normalizedSamsaraAccounts }),
    samsaraError,
    samsaraAssignment,
    samsaraDuty,
    samsaraDvir,
    verifiedDvir,
    samsaraAccount: type === "post" ? activeAccount : "primary",
    samsaraUsername: selectedUsername,
    recordId: row.id
  };
}

export async function ensureDriverSamsaraDutyForJob(driverLogin, { samsaraUsername = "", samsaraAccounts = {}, job = null } = {}) {
  const normalizedSamsaraAccounts = samsaraAccountsFromLegacy(samsaraUsername, samsaraAccounts);
  const assignment = await activeDriverAssignment(driverLogin);
  if (!assignment) return { switched: false, reason: "no_assignment" };
  const plan = assignment.plan;
  const truck = job?.truckPlate
    ? {
        id: job.truckId || "",
        plate: job.truckPlate,
        base: job.switchYard || job.location || "",
        parkingSpot: job.parkingSpot || ""
      }
    : assignment.truck || {};
  if (!truck?.plate) return { switched: false, reason: "no_truck" };
  const row = await upsertDriverDayBase({ driverLogin, plan, truck, samsaraAccounts: normalizedSamsaraAccounts });
  if (!row.pre_dvir_completed_at || !row.on_duty_at) return { switched: false, reason: "pre_dvir_not_complete" };
  if (!shouldSwitchToSecondary(row)) return { switched: false, account: row.samsara_active_account || "primary" };

  if (!normalizedSamsaraAccounts.secondaryUsername) {
    throw new Error("Secondary Samsara username is required after 8 hours on duty.");
  }

  let secondaryAssignment = null;
  let secondaryDuty = null;
  let primaryOffDuty = null;
  try {
    secondaryAssignment = await createSamsaraDriverVehicleAssignment({
      username: normalizedSamsaraAccounts.secondaryUsername,
      vehiclePlate: truck.plate
    });
    secondaryDuty = await setSamsaraDriverDutyStatus({
      username: normalizedSamsaraAccounts.secondaryUsername,
      vehicleId: secondaryAssignment.vehicle?.id || row.samsara_vehicle_id || "",
      dutyStatus: "ON_DUTY",
      remark: `MBBS automatic 8-hour handoff to secondary account with ${truck.plate}`
    });
    primaryOffDuty = await setSamsaraDriverDutyStatus({
      username: normalizedSamsaraAccounts.primaryUsername,
      driverId: row.samsara_driver_id || "",
      vehicleId: row.samsara_vehicle_id || "",
      dutyStatus: "OFF_DUTY",
      remark: `MBBS automatic 8-hour handoff from primary account with ${truck.plate}`
    });
  } catch (error) {
    await query(
      `UPDATE driver_day_records
          SET samsara_handoff_response = $2::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [row.id, JSON.stringify({
        error: error.message,
        secondaryAssignment,
        secondaryDuty,
        primaryOffDuty
      })]
    );
    throw error;
  }

  await query(
    `UPDATE driver_day_records
        SET samsara_active_account = 'secondary',
            samsara_secondary_username = COALESCE(NULLIF($2, ''), samsara_secondary_username),
            samsara_secondary_driver_id = COALESCE(NULLIF($3, ''), samsara_secondary_driver_id),
            samsara_secondary_vehicle_id = COALESCE(NULLIF($4, ''), samsara_secondary_vehicle_id),
            primary_off_duty_at = now(),
            secondary_on_duty_at = now(),
            samsara_secondary_assignment_response = $5::jsonb,
            samsara_secondary_on_duty_response = $6::jsonb,
            samsara_handoff_response = $7::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [
      row.id,
      normalizedSamsaraAccounts.secondaryUsername,
      secondaryAssignment?.driver?.id || "",
      secondaryAssignment?.vehicle?.id || row.samsara_vehicle_id || "",
      JSON.stringify(secondaryAssignment || {}),
      JSON.stringify(secondaryDuty || {}),
      JSON.stringify({
        switchedAt: new Date().toISOString(),
        from: normalizedSamsaraAccounts.primaryUsername,
        to: normalizedSamsaraAccounts.secondaryUsername,
        primaryOffDuty,
        secondaryAssignment,
        secondaryDuty
      })
    ]
  );
  return {
    switched: true,
    account: "secondary",
    primaryUsername: normalizedSamsaraAccounts.primaryUsername,
    secondaryUsername: normalizedSamsaraAccounts.secondaryUsername,
    primaryOffDuty,
    secondaryAssignment,
    secondaryDuty
  };
}

export async function skipDriverDvirForTesting(driverLogin, { type = "pre", samsaraUsername = "" } = {}) {
  const assignment = await activeDriverAssignment(driverLogin);
  const plan = assignment?.plan || { id: null, planDate: todayLocalDate() };
  const initialTruck = assignment?.initialTruck || assignment?.truck || {};
  const currentResult = await query(
    `SELECT current_truck_plate, current_truck_id
       FROM driver_day_records
      WHERE driver_login = $1 AND plan_date = $2::date
      LIMIT 1`,
    [driverKey(driverLogin), plan.planDate]
  );
  const currentRow = currentResult.rows[0] || {};
  const currentTruck = assignment?.assignments?.find((item) =>
    normalizedPlate(item.truck.plate) === normalizedPlate(currentRow.current_truck_plate)
  )?.truck;
  const truck = type === "post" ? currentTruck || assignment?.finalTruck || initialTruck : initialTruck;
  if (!truck?.plate) throw new Error("No assigned truck was found in the confirmed dispatch plan.");
  const row = await upsertDriverDayBase({ driverLogin, plan, truck, samsaraUsername });
  const fakeDvir = {
    responseStatus: 200,
    skippedForTesting: true,
    dvirId: `MBBS-SKIP-${type}-${Date.now()}`,
    dvir: {
      id: `MBBS-SKIP-${type}-${Date.now()}`,
      licensePlate: truck.plate,
      vehicle: {
        id: "mbbs-test-skip",
        licensePlate: truck.plate
      }
    },
    verifiedDvir: {
      id: `MBBS-SKIP-${type}-${Date.now()}`,
      licensePlate: truck.plate,
      vehicle: {
        id: "mbbs-test-skip",
        licensePlate: truck.plate
      }
    },
    clock: {
      currentDutyStatus: {
        hosStatusType: type === "post" ? "offDuty" : "onDuty"
      },
      currentVehicle: {
        id: "mbbs-test-skip"
      }
    }
  };
  const photos = JSON.stringify([]);
  const result = type === "post"
    ? await query(
        `UPDATE driver_day_records
            SET samsara_username = COALESCE(NULLIF($2, ''), samsara_username),
                post_dvir_photo_data_urls = $3::jsonb,
                post_dvir_completed_at = now(),
                off_duty_at = now(),
                samsara_vehicle_id = 'mbbs-test-skip',
                samsara_off_duty_response = $4::jsonb,
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [row.id, samsaraUsername || "", photos, JSON.stringify(fakeDvir)]
      )
    : await query(
        `UPDATE driver_day_records
            SET samsara_username = COALESCE(NULLIF($2, ''), samsara_username),
                pre_dvir_photo_data_urls = $3::jsonb,
                pre_dvir_completed_at = now(),
                on_duty_at = now(),
                samsara_driver_id = COALESCE(samsara_driver_id, 'mbbs-test-skip'),
                samsara_vehicle_id = 'mbbs-test-skip',
                samsara_assignment_response = $4::jsonb,
                samsara_on_duty_response = $4::jsonb,
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [row.id, samsaraUsername || "", photos, JSON.stringify(fakeDvir)]
      );
  return {
    state: await getDriverDayState(driverLogin, { samsaraUsername }),
    recordId: result.rows[0]?.id || row.id,
    skippedForTesting: true
  };
}

async function detailsFromDelivery(orderRef, typeHint = "", context = {}) {
  const typeClause = typeHint === "TO" ? "AND o.order_type = 'transfer_order'" : typeHint === "SO" ? "AND o.order_type = 'sales_order'" : "";
  const order = await query(
    `WITH delivery_order_source AS (
       SELECT netsuite_id, tranid, 'sales_order'::text AS order_type, customer AS party,
              dispatch_address, dispatch_window_start, dispatch_window_end,
              NULL::text AS destination_location, outbound_location, synced_at
       FROM sales_orders
       UNION ALL
       SELECT netsuite_id, tranid, 'transfer_order'::text AS order_type, to_location AS party,
              dispatch_address, dispatch_window_start, dispatch_window_end,
              to_location AS destination_location, from_location AS outbound_location, synced_at
       FROM transfer_orders
       WHERE from_location_id IS NOT NULL
     )
     SELECT o.netsuite_id, o.tranid, o.order_type, o.party,
            o.dispatch_address, o.dispatch_window_start, o.dispatch_window_end, o.destination_location,
            o.outbound_location
       FROM delivery_order_source o
      WHERE o.tranid = $1 ${typeClause}
      ORDER BY o.synced_at DESC
      LIMIT 1`,
    [orderRef]
  );
  if (!order.rowCount) return null;
  const pickupLocation = String(context.pickupLocation || "").trim();
  const lines = await query(
    `WITH alloc_total AS (
       SELECT sales_line_id,
              SUM(allocated_pallet_qty) AS allocated_pallet_qty,
              SUM(allocated_layer_qty) AS allocated_layer_qty,
              SUM(allocated_section_qty) AS allocated_section_qty,
              SUM(allocated_piece_qty) AS allocated_piece_qty,
              SUM(allocated_sales_qty) AS allocated_sales_qty
         FROM dispatch_so_po_allocations
        WHERE status = 'active'
        GROUP BY sales_line_id
     ),
     alloc_location AS (
       SELECT a.sales_line_id,
              SUM(a.allocated_pallet_qty) AS allocated_pallet_qty,
              SUM(a.allocated_layer_qty) AS allocated_layer_qty,
              SUM(a.allocated_section_qty) AS allocated_section_qty,
              SUM(a.allocated_piece_qty) AS allocated_piece_qty,
              SUM(a.allocated_sales_qty) AS allocated_sales_qty
         FROM dispatch_so_po_allocations a
         JOIN purchase_orders po ON po.netsuite_id = a.po_order_id
        WHERE a.status = 'active'
          AND $2 <> ''
          AND LOWER(COALESCE(NULLIF(po.dispatch_vendor_yard, ''), NULLIF(po.source_location, ''), NULLIF(po.vendor, ''))) = LOWER($2)
        GROUP BY a.sales_line_id
     )
     SELECT l.item_name, l.sku, l.item_description, l.item_type, l.quantity, l.unit,
            l.pallet_qty, l.layer_qty, l.section_qty, l.piece_qty,
            COALESCE(at.allocated_pallet_qty, 0) AS total_allocated_pallet_qty,
            COALESCE(at.allocated_layer_qty, 0) AS total_allocated_layer_qty,
            COALESCE(at.allocated_section_qty, 0) AS total_allocated_section_qty,
            COALESCE(at.allocated_piece_qty, 0) AS total_allocated_piece_qty,
            COALESCE(at.allocated_sales_qty, 0) AS total_allocated_sales_qty,
            COALESCE(al.allocated_pallet_qty, 0) AS location_allocated_pallet_qty,
            COALESCE(al.allocated_layer_qty, 0) AS location_allocated_layer_qty,
            COALESCE(al.allocated_section_qty, 0) AS location_allocated_section_qty,
            COALESCE(al.allocated_piece_qty, 0) AS location_allocated_piece_qty,
            COALESCE(al.allocated_sales_qty, 0) AS location_allocated_sales_qty
       FROM (
         SELECT sales_order_id AS order_id, id, line_id, item_name, sku, item_description, item_type,
                quantity, unit, pallet_qty, layer_qty, section_qty, piece_qty, netsuite_active
         FROM sales_order_lines
         UNION ALL
         SELECT transfer_order_id AS order_id, id, line_id, item_name, sku, item_description, item_type,
                quantity, unit, pallet_qty, layer_qty, section_qty, piece_qty, netsuite_active
         FROM transfer_order_lines
         WHERE line_stage = 'outbound'
       ) l
       LEFT JOIN alloc_total at ON at.sales_line_id = l.id
       LEFT JOIN alloc_location al ON al.sales_line_id = l.id
      WHERE order_id = $1
        AND netsuite_active = true
      ORDER BY line_id NULLS LAST, id`,
    [order.rows[0].netsuite_id, pickupLocation]
  );
  if (context.stopType !== "pickup" || order.rows[0].order_type !== "sales_order") {
    return { ...order.rows[0], source: "delivery", lines: lines.rows };
  }
  const ownPickup = !pickupLocation || isOwnYard(context.plan, pickupLocation) || String(order.rows[0].outbound_location || "") === pickupLocation;
  const adjustedLines = lines.rows.map((line) => ownPickup
    ? {
        ...line,
        pallet_qty: positiveBalance(line.pallet_qty, line.total_allocated_pallet_qty),
        layer_qty: positiveBalance(line.layer_qty, line.total_allocated_layer_qty),
        section_qty: positiveBalance(line.section_qty, line.total_allocated_section_qty),
        piece_qty: positiveBalance(line.piece_qty, line.total_allocated_piece_qty),
        quantity: positiveBalance(line.quantity, line.total_allocated_sales_qty)
      }
    : {
        ...line,
        pallet_qty: numberValue(line.location_allocated_pallet_qty),
        layer_qty: numberValue(line.location_allocated_layer_qty),
        section_qty: numberValue(line.location_allocated_section_qty),
        piece_qty: numberValue(line.location_allocated_piece_qty),
        quantity: numberValue(line.location_allocated_sales_qty)
      })
    .filter((line) => numberValue(line.pallet_qty) || numberValue(line.layer_qty) || numberValue(line.section_qty) || numberValue(line.piece_qty) || numberValue(line.quantity));
  return { ...order.rows[0], source: "delivery", lines: adjustedLines };
}

async function detailsFromReceiving(orderRef, typeHint = "", context = {}) {
  const typeClause = typeHint === "TO" ? "AND o.order_type = 'transfer_order'" : typeHint === "PO" ? "AND o.order_type = 'purchase_order'" : "";
  const order = await query(
    `WITH receiving_order_source AS (
       SELECT netsuite_id, COALESCE(NULLIF(dispatch_ref, ''), tranid) AS tranid, tranid AS original_tranid,
              'purchase_order'::text AS order_type, vendor AS party,
              dispatch_address, dispatch_window_start, dispatch_window_end, destination_location, synced_at
       FROM purchase_orders
       UNION ALL
       SELECT netsuite_id, tranid, tranid AS original_tranid, 'transfer_order'::text AS order_type, from_location AS party,
              dispatch_address, dispatch_window_start, dispatch_window_end, to_location AS destination_location, synced_at
       FROM transfer_orders
       WHERE to_location_id IS NOT NULL
     )
     SELECT o.netsuite_id, o.tranid, o.order_type, o.party,
            o.dispatch_address, o.dispatch_window_start, o.dispatch_window_end, o.destination_location
       FROM receiving_order_source o
      WHERE (o.tranid = $1 OR o.original_tranid = $1) ${typeClause}
      ORDER BY o.synced_at DESC
      LIMIT 1`,
    [orderRef]
  );
  if (!order.rowCount) return null;
  const lines = await query(
    `SELECT id AS line_row_id, line_id, location_id, location,
            item_name, sku, item_description, item_type, quantity, unit, pallet_qty, layer_qty, section_qty, piece_qty
       FROM (
         SELECT purchase_order_id AS order_id, line_id, id, item_name, sku, item_description, item_type,
                quantity, unit, pallet_qty, layer_qty, section_qty, piece_qty, location_id, location, netsuite_active
         FROM purchase_order_lines
         UNION ALL
         SELECT transfer_order_id AS order_id, line_id, id, item_name, sku, item_description, item_type,
                quantity, unit, pallet_qty, layer_qty, section_qty, piece_qty, location_id, location, netsuite_active
         FROM transfer_order_lines
         WHERE line_stage = 'receiving'
       ) receiving_lines
      WHERE order_id = $1
        AND netsuite_active = true
      ORDER BY line_id NULLS LAST, id`,
    [order.rows[0].netsuite_id]
  );
  const requestedLineRowIds = new Set((context.lineRowIds || []).map(String));
  const scopedLines = typeHint === "PO" && context.stopType === "dropoff" && requestedLineRowIds.size
    ? lines.rows.filter((line) => requestedLineRowIds.has(String(line.line_row_id)))
    : lines.rows;
  return { ...order.rows[0], source: "receiving", lines: scopedLines };
}

async function detailsFromLocalCo(orderRef) {
  const order = await query(
    `SELECT id, co_ref AS tranid, 'co_order' AS order_type,
            COALESCE(details->>'customer', 'Transit Depot') AS party,
            details->>'notes' AS dispatch_instructions,
            to_location AS destination_location
       FROM co_orders
      WHERE co_ref = $1
      LIMIT 1`,
    [orderRef]
  );
  if (!order.rowCount) return null;
  const lines = await query(
    `SELECT item_name, sku, item_description, item_type, quantity, unit,
            pallet_qty, layer_qty, section_qty, piece_qty
       FROM co_order_lines
      WHERE co_id = $1
      ORDER BY line_id NULLS LAST, id`,
    [order.rows[0].id]
  );
  return { ...order.rows[0], source: "local_co", lines: lines.rows };
}

function visibleUnits(line) {
  const values = [
    ["PLT", line.pallet_qty],
    ["LYR", line.layer_qty],
    ["SEC", line.section_qty],
    ["PCS", line.piece_qty]
  ].filter(([, value]) => Number(value || 0) > 0);
  if (values.length) return values.map(([unit, value]) => ({ unit, value: Number(value) }));
  return [{ unit: line.unit || "UOM", value: Number(line.quantity || 0), fallback: true }];
}

function visibleUnitsFromPlanItem(item) {
  const values = [
    ["PLT", item.pallets ?? item.pallet_qty],
    ["LYR", item.layers ?? item.layer_qty],
    ["SEC", item.sections ?? item.section_qty],
    ["PCS", item.pieces ?? item.piece_qty]
  ].filter(([, value]) => Number(value || 0) > 0);
  if (values.length) return values.map(([unit, value]) => ({ unit, value: Number(value) }));
  return [{ unit: item.unit || "UOM", value: Number(item.quantity || item.salesQty || 0), fallback: true }];
}

function planItemForPickup(item, context = {}) {
  if (context.stopType !== "pickup") return item;
  const pickupLocation = String(context.pickupLocation || "").trim();
  const ownPickup = !pickupLocation || isOwnYard(context.plan, pickupLocation);
  if (ownPickup) {
    return {
      ...item,
      pallets: positiveBalance(item.pallets, item.poAllocatedPallets),
      layers: positiveBalance(item.layers, item.poAllocatedLayers),
      sections: positiveBalance(item.sections, item.poAllocatedSections),
      pieces: positiveBalance(item.pieces, item.poAllocatedPieces),
      quantity: positiveBalance(item.quantity ?? item.salesQty, item.poAllocatedSalesQty),
      salesQty: positiveBalance(item.salesQty ?? item.quantity, item.poAllocatedSalesQty)
    };
  }
  return {
    ...item,
    pallets: numberValue(item.poAllocatedPallets),
    layers: numberValue(item.poAllocatedLayers),
    sections: numberValue(item.poAllocatedSections),
    pieces: numberValue(item.poAllocatedPieces),
    quantity: numberValue(item.poAllocatedSalesQty),
    salesQty: numberValue(item.poAllocatedSalesQty)
  };
}

function planItemHasQuantity(item) {
  return numberValue(item.pallets ?? item.pallet_qty)
    || numberValue(item.layers ?? item.layer_qty)
    || numberValue(item.sections ?? item.section_qty)
    || numberValue(item.pieces ?? item.piece_qty)
    || numberValue(item.quantity || item.salesQty);
}

function isMaterialLine(line) {
  const itemType = String(line.item_type || "").trim();
  if (!itemType) return true;
  return ["InvtPart", "NonInvtPart"].includes(itemType);
}

function orderDetailsFromPlan(orderRef, planOrder = null, context = {}) {
  const requestedLineRowIds = new Set((context.lineRowIds || []).map(String));
  const sourceItems = context.stopType === "dropoff" && requestedLineRowIds.size
    ? (planOrder?.items || []).filter((item) => requestedLineRowIds.has(String(item.lineRowId)))
    : (planOrder?.items || []);
  const items = sourceItems
    .map((item) => planItemForPickup(item, context))
    .filter(planItemHasQuantity);
  return {
    orderRef,
    party: planOrder?.customer || planOrder?.vendor || planOrder?.party || "",
    source: "dispatch_plan",
    items: items.map((item) => ({
      itemName: item.itemName || item.name || item.sku || "",
      sku: item.sku || item.itemName || item.name || "",
      description: item.description || item.itemDescription || "",
      units: visibleUnitsFromPlanItem(item)
    }))
  };
}

async function orderDetails(orderRef, typeHint = "", planOrder = null, context = {}) {
  const detail = typeHint === "PO"
    ? await detailsFromReceiving(orderRef, "PO", context)
    : typeHint === "CO"
      ? await detailsFromLocalCo(orderRef)
      : typeHint === "TO"
        ? await detailsFromDelivery(orderRef, "TO", context) || await detailsFromReceiving(orderRef, "TO")
        : await detailsFromDelivery(orderRef, "SO", context) || await detailsFromReceiving(orderRef) || await detailsFromLocalCo(orderRef);
  if (!detail) return orderDetailsFromPlan(orderRef, planOrder, context);
  const items = (detail.lines || []).filter(isMaterialLine).map((line) => ({
    itemName: line.item_name || line.sku || "",
    sku: line.sku || line.item_name || "",
    description: line.item_description || "",
    units: visibleUnits(line)
  }));
  if (!items.length && planOrder?.items?.length) return orderDetailsFromPlan(orderRef, planOrder, context);
  return {
    orderRef,
    party: detail.party || "",
    source: detail.source,
    items
  };
}

export async function getNextDriverJob(driverLogin) {
  const assignment = await activeDriverAssignment(driverLogin);
  if (!assignment) return null;
  const jobs = planJobsForDriver(assignment.plan, driverLogin);
  const jobIds = jobs.map((job) => job.jobId);
  const completed = await completedJobIds(jobIds);
  const statuses = await jobStatusMap(jobIds);
  const next = jobs.find((job) => !completed.has(job.jobId));
  if (!next) return null;
  const status = statuses.get(next.jobId);
  next.status = status?.status || "pending";
  next.startedAt = status?.started_at || null;
  next.completedAt = status?.completed_at || null;
  if (next.stopType === "travel") {
    next.address = await locationAddress(next.toLocation || next.address);
    next.fromAddress = await locationAddress(next.fromLocation || next.fromAddress);
  } else if (next.stopType === "pickup") {
    next.address = await locationAddress(next.location || next.address);
  }
  const details = await Promise.all(next.orderRefs.map((ref) => {
    const dependencyManifest = (next.dependencyPickupManifests || []).find((entry) => String(entry.transferOrderRef || "") === String(ref));
    if (dependencyManifest) {
      return {
        orderRef: dependencyManifest.transferOrderRef,
        party: dependencyManifest.salesOrderRef || "",
        source: "direct_dependency",
        items: (dependencyManifest.items || []).map((item) => ({
          itemName: item.itemName || item.sku || "",
          sku: item.sku || item.itemName || "",
          description: item.description || "",
          units: visibleUnitsFromPlanItem({
            pallets: item.palletQty,
            layers: item.layerQty,
            sections: item.sectionQty,
            pieces: item.pieceQty,
            quantity: item.quantity,
            unit: item.unit
          })
        }))
      };
    }
    const hint = orderByRef(assignment.plan, ref)?.type || (next.orderTypes.length === 1 ? next.orderTypes[0] : "");
    return orderDetails(ref, hint, orderByRef(assignment.plan, ref), {
      plan: assignment.plan,
      stopType: next.stopType,
      pickupLocation: next.stopType === "pickup" ? next.location : "",
      dropLocation: next.stopType === "dropoff" ? next.dropLocation || next.location : "",
      destinationLocationId: next.destinationLocationId ?? null,
      lineRowIds: next.stopType === "dropoff" ? next.lineRowIds || [] : []
    });
  }));
  return { ...next, orders: details };
}

export async function startDriverJob(driverLogin, jobIdValue, { job = null } = {}) {
  if (!job) throw new Error("Driver job is no longer available.");
  const result = await query(
    `INSERT INTO driver_job_records (
       job_id, plan_id, plan_date, driver_login, truck_id, truck_plate, load_id, load_name,
       stop_id, stop_type, order_refs, photo_data_urls, status, started_at, completed_at, job_details
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11::jsonb, '[]'::jsonb, 'in_progress', now(), NULL, $12::jsonb
     )
     ON CONFLICT (job_id) DO UPDATE SET
       status = CASE WHEN driver_job_records.status = 'complete' THEN driver_job_records.status ELSE 'in_progress' END,
       started_at = COALESCE(driver_job_records.started_at, now()),
       plan_id = EXCLUDED.plan_id,
       plan_date = EXCLUDED.plan_date,
       driver_login = EXCLUDED.driver_login,
       truck_id = EXCLUDED.truck_id,
       truck_plate = EXCLUDED.truck_plate,
       load_id = EXCLUDED.load_id,
       load_name = EXCLUDED.load_name,
       stop_id = EXCLUDED.stop_id,
       stop_type = EXCLUDED.stop_type,
       order_refs = EXCLUDED.order_refs,
       job_details = EXCLUDED.job_details
     RETURNING *`,
    [
      jobIdValue,
      job?.planId || null,
      job?.planDate || null,
      driverKey(driverLogin),
      job?.truckId || "",
      job?.truckPlate || "",
      job?.loadId || "",
      job?.loadName || "",
      job?.stopId || "",
      job?.stopType || "",
      JSON.stringify(job?.orderRefs || []),
      JSON.stringify({
        fromTruckPlate: job?.fromTruckPlate || "",
        nextTruckPlate: job?.nextTruckPlate || "",
        switchYard: job?.switchYard || "",
        parkingSpot: job?.parkingSpot || ""
      })
    ]
  );
  await query(
    `UPDATE dispatch_plan_load_assignments
        SET started = true, updated_at = now()
      WHERE plan_id = $1 AND load_id = $2`,
    [job?.planId || null, job?.loadId || ""]
  ).catch(() => null);
  await query(
    `UPDATE driver_day_records
        SET truck_id = $3,
            truck_plate = $4,
            current_truck_id = $3,
            current_truck_plate = $4,
            current_load_id = $5,
            updated_at = now()
      WHERE driver_login = $1 AND plan_date = $2::date`,
    [driverKey(driverLogin), job?.planDate || null, job?.truckId || "", job?.truckPlate || "", job?.loadId || ""]
  ).catch(() => null);
  return result.rows[0];
}

export async function getActiveDriverRest(driverLogin) {
  const result = await query(
    `SELECT *
       FROM driver_rest_records
      WHERE driver_login = $1
        AND status = 'active'
        AND ended_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1`,
    [driverKey(driverLogin)]
  );
  return mapRestRecord(result.rows[0]);
}

export async function getDriverRestSummary(driverLogin, { planDate = "" } = {}) {
  const login = driverKey(driverLogin);
  const date = planDateValue(planDate) || todayLocalDate();
  const result = await query(
    `SELECT COUNT(*)::int AS session_count,
            COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at))), 0) AS total_seconds,
            COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)))
              FILTER (WHERE ended_at IS NOT NULL), 0) AS completed_seconds,
            COALESCE(SUM(EXTRACT(EPOCH FROM (now() - started_at)))
              FILTER (WHERE status = 'active' AND ended_at IS NULL), 0) AS active_seconds
       FROM driver_rest_records
      WHERE driver_login = $1
        AND COALESCE(plan_date, (started_at AT TIME ZONE 'America/Toronto')::date) = $2::date`,
    [login, date]
  );
  const row = result.rows[0] || {};
  return {
    planDate: date,
    sessionCount: Number(row.session_count || 0),
    totalSeconds: Math.max(0, Math.floor(Number(row.total_seconds || 0))),
    completedSeconds: Math.max(0, Math.floor(Number(row.completed_seconds || 0))),
    activeSeconds: Math.max(0, Math.floor(Number(row.active_seconds || 0))),
    calculatedAt: new Date().toISOString()
  };
}

export async function startDriverRest(driverLogin, { nextJob = null } = {}) {
  if (!nextJob) throw new Error("No next job is available for rest.");
  const login = driverKey(driverLogin);
  const active = await getActiveDriverRest(login);
  if (active) return active;
  const previous = await query(
    `SELECT job_id
       FROM driver_job_records
      WHERE driver_login = $1
        AND status = 'complete'
      ORDER BY completed_at DESC NULLS LAST, started_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    [login]
  );
  const inserted = await query(
    `INSERT INTO driver_rest_records (
       rest_id, plan_id, plan_date, driver_login, truck_id, truck_plate,
       load_id, load_name, previous_job_id, next_job_id, status, started_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, 'active', now()
     )
     RETURNING *`,
    [
      crypto.randomUUID(),
      nextJob.planId || null,
      nextJob.planDate || null,
      login,
      nextJob.truckId || "",
      nextJob.truckPlate || "",
      nextJob.loadId || "",
      nextJob.loadName || "",
      previous.rows[0]?.job_id || "",
      nextJob.jobId || ""
    ]
  );
  return mapRestRecord(inserted.rows[0]);
}

export async function endDriverRest(driverLogin) {
  const result = await query(
    `UPDATE driver_rest_records
        SET status = 'complete',
            ended_at = now(),
            updated_at = now()
      WHERE id = (
        SELECT id
          FROM driver_rest_records
         WHERE driver_login = $1
           AND status = 'active'
           AND ended_at IS NULL
         ORDER BY started_at DESC
         LIMIT 1
      )
      RETURNING *`,
    [driverKey(driverLogin)]
  );
  return mapRestRecord(result.rows[0]);
}

export async function recordDriverJobPhotos(driverLogin, jobIdValue, { photoDataUrls = [], job = null } = {}) {
  const photos = Array.isArray(photoDataUrls) ? photoDataUrls.filter(isPhotoReference) : [];
  const requiredPhotos = job && Number(job.requiredPhotos) === 0
    ? 0
    : Math.max(2, Number(job?.requiredPhotos || 2));
  if (photos.length < requiredPhotos) throw new Error(`${requiredPhotos} photo${requiredPhotos > 1 ? "s are" : " is"} required.`);
  const result = await query(
    `INSERT INTO driver_job_records (
       job_id, plan_id, plan_date, driver_login, truck_id, truck_plate, load_id, load_name,
       stop_id, stop_type, order_refs, photo_data_urls, status, started_at, completed_at, job_details
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11::jsonb, $12::jsonb, 'complete', COALESCE($13::timestamptz, now()), now(), $14::jsonb
     )
     ON CONFLICT (job_id) DO UPDATE SET
       photo_data_urls = EXCLUDED.photo_data_urls,
       status = 'complete',
       started_at = COALESCE(driver_job_records.started_at, EXCLUDED.started_at, now()),
       completed_at = now(),
       job_details = EXCLUDED.job_details
     RETURNING *`,
    [
      jobIdValue,
      job?.planId || null,
      job?.planDate || null,
      driverKey(driverLogin),
      job?.truckId || "",
      job?.truckPlate || "",
      job?.loadId || "",
      job?.loadName || "",
      job?.stopId || "",
      job?.stopType || "",
      JSON.stringify(job?.orderRefs || []),
      JSON.stringify(photos),
      job?.startedAt || null,
      JSON.stringify({
        fromTruckPlate: job?.fromTruckPlate || "",
        nextTruckPlate: job?.nextTruckPlate || "",
        switchYard: job?.switchYard || "",
        parkingSpot: job?.parkingSpot || ""
      })
    ]
  );
  await refreshProjectedLoadExecution({ ...job, driverLogin: driverKey(driverLogin) });
  return result.rows[0];
}

async function writeTruckSwitchFailure(driverLogin, job, error) {
  await query(
    `INSERT INTO driver_truck_switch_records (
       job_id, plan_id, plan_date, driver_login,
       from_truck_id, from_truck_plate, to_truck_id, to_truck_plate,
       switch_yard, parking_spot, next_load_id, planned_switch_minute,
       status, samsara_error, updated_at
     ) VALUES (
       $1, $2, $3::date, $4,
       $5, $6, $7, $8,
       $9, $10, $11, $12,
       'attention', $13, now()
     )
     ON CONFLICT (job_id) DO UPDATE SET
       status = 'attention',
       samsara_error = EXCLUDED.samsara_error,
       updated_at = now()`,
    [
      job.jobId,
      job.planId || null,
      job.planDate,
      driverKey(driverLogin),
      job.fromTruckId || "",
      job.fromTruckPlate || "",
      job.nextTruckId || job.truckId || "",
      job.nextTruckPlate || job.truckPlate || "",
      job.switchYard || "",
      job.parkingSpot || "",
      job.loadId || "",
      job.plannedSwitchMinute,
      error?.message || String(error || "Samsara truck reassignment failed.")
    ]
  );
}

export async function confirmDriverTruckSwitch(driverLogin, job, { samsaraUsername = "", samsaraAccounts = {} } = {}) {
  if (!job || job.stopType !== "truck_switch") throw new Error("This is not an active truck-switch job.");
  const normalizedAccounts = samsaraAccountsFromLegacy(samsaraUsername, samsaraAccounts);
  const assignment = await activeDriverAssignment(driverLogin);
  if (!assignment || String(assignment.plan.id) !== String(job.planId)) throw new Error("The driver assignment changed. Refresh and try again.");
  const initialTruck = assignment.initialTruck || assignment.truck || {};
  let row = await upsertDriverDayBase({ driverLogin, plan: assignment.plan, truck: initialTruck, samsaraAccounts: normalizedAccounts });
  let samsaraHandoff = null;
  try {
    samsaraHandoff = await ensureDriverSamsaraDutyForJob(driverLogin, {
      samsaraAccounts: normalizedAccounts,
      job
    });
    if (samsaraHandoff?.switched) {
      const refreshed = await query("SELECT * FROM driver_day_records WHERE id = $1", [row.id]);
      row = refreshed.rows[0] || row;
    }
  } catch (error) {
    await writeTruckSwitchFailure(driverLogin, job, error);
    throw error;
  }
  const activeAccount = row.samsara_active_account === "secondary" ? "secondary" : "primary";
  const username = samsaraUsernameForAccount(normalizedAccounts, activeAccount);
  if (!username) {
    const error = new Error(`The ${activeAccount} Samsara username is not configured.`);
    await writeTruckSwitchFailure(driverLogin, job, error);
    throw error;
  }

  let samsaraAssignment = samsaraHandoff?.switched ? samsaraHandoff.secondaryAssignment : null;
  let samsaraDuty = samsaraHandoff?.switched ? samsaraHandoff.secondaryDuty : null;
  try {
    if (!samsaraAssignment) {
      samsaraAssignment = await createSamsaraDriverVehicleAssignment({
        username,
        vehiclePlate: job.nextTruckPlate || job.truckPlate
      });
      samsaraDuty = await setSamsaraDriverDutyStatus({
        username,
        vehicleId: samsaraAssignment.vehicle?.id || "",
        dutyStatus: "ON_DUTY",
        remark: `MBBS truck switch to ${job.nextTruckPlate || job.truckPlate} at ${job.switchYard || "yard"}`
      });
    }
  } catch (error) {
    await writeTruckSwitchFailure(driverLogin, job, error);
    throw error;
  }

  return withTransaction(async () => {
    await query(
      `INSERT INTO driver_truck_switch_records (
         job_id, plan_id, plan_date, driver_login,
         from_truck_id, from_truck_plate, to_truck_id, to_truck_plate,
         switch_yard, parking_spot, next_load_id, planned_switch_minute,
         status, samsara_username, samsara_driver_id, samsara_vehicle_id,
         samsara_response, samsara_error, confirmed_at, updated_at
       ) VALUES (
         $1, $2, $3::date, $4,
         $5, $6, $7, $8,
         $9, $10, $11, $12,
         'complete', $13, $14, $15,
         $16::jsonb, '', now(), now()
       )
       ON CONFLICT (job_id) DO UPDATE SET
         status = 'complete',
         samsara_username = EXCLUDED.samsara_username,
         samsara_driver_id = EXCLUDED.samsara_driver_id,
         samsara_vehicle_id = EXCLUDED.samsara_vehicle_id,
         samsara_response = EXCLUDED.samsara_response,
         samsara_error = '',
         confirmed_at = now(),
         updated_at = now()`,
      [
        job.jobId,
        job.planId || null,
        job.planDate,
        driverKey(driverLogin),
        job.fromTruckId || "",
        job.fromTruckPlate || "",
        job.nextTruckId || job.truckId || "",
        job.nextTruckPlate || job.truckPlate || "",
        job.switchYard || "",
        job.parkingSpot || "",
        job.loadId || "",
        job.plannedSwitchMinute,
        username,
        samsaraAssignment.driver?.id || "",
        samsaraAssignment.vehicle?.id || "",
        JSON.stringify({ assignment: samsaraAssignment, duty: samsaraDuty })
      ]
    );
    const completedJob = await recordDriverJobPhotos(driverLogin, job.jobId, { photoDataUrls: [], job });
    await query(
      `UPDATE driver_day_records
          SET truck_id = $2,
              truck_plate = $3,
              current_truck_id = $2,
              current_truck_plate = $3,
              current_load_id = $4,
              samsara_driver_id = CASE WHEN samsara_active_account = 'primary' THEN COALESCE(NULLIF($5, ''), samsara_driver_id) ELSE samsara_driver_id END,
              samsara_vehicle_id = CASE WHEN samsara_active_account = 'primary' THEN COALESCE(NULLIF($6, ''), samsara_vehicle_id) ELSE samsara_vehicle_id END,
              samsara_secondary_driver_id = CASE WHEN samsara_active_account = 'secondary' THEN COALESCE(NULLIF($5, ''), samsara_secondary_driver_id) ELSE samsara_secondary_driver_id END,
              samsara_secondary_vehicle_id = CASE WHEN samsara_active_account = 'secondary' THEN COALESCE(NULLIF($6, ''), samsara_secondary_vehicle_id) ELSE samsara_secondary_vehicle_id END,
              samsara_assignment_response = CASE WHEN samsara_active_account = 'primary' THEN $7::jsonb ELSE samsara_assignment_response END,
              samsara_secondary_assignment_response = CASE WHEN samsara_active_account = 'secondary' THEN $7::jsonb ELSE samsara_secondary_assignment_response END,
              updated_at = now()
        WHERE id = $1`,
      [
        row.id,
        job.nextTruckId || job.truckId || "",
        job.nextTruckPlate || job.truckPlate || "",
        job.loadId || "",
        samsaraAssignment.driver?.id || "",
        samsaraAssignment.vehicle?.id || "",
        JSON.stringify(samsaraAssignment || {})
      ]
    );
    return { record: completedJob, switchRecord: { jobId: job.jobId, status: "complete" }, samsaraAssignment, samsaraDuty, samsaraHandoff };
  });
}

async function finalizeDriverTruckSwitchWithoutSamsara(row) {
  const job = {
    jobId: row.job_id,
    planId: row.plan_id,
    planDate: planDateValue(row.plan_date),
    driverLogin: row.driver_login,
    truckId: row.to_truck_id,
    truckPlate: row.to_truck_plate,
    fromTruckId: row.from_truck_id,
    fromTruckPlate: row.from_truck_plate,
    nextTruckId: row.to_truck_id,
    nextTruckPlate: row.to_truck_plate,
    switchYard: row.switch_yard,
    parkingSpot: row.parking_spot,
    loadId: row.next_load_id,
    loadName: "",
    stopId: `truck-switch-${row.next_load_id}`,
    stopType: "truck_switch",
    orderRefs: [],
    requiredPhotos: 0
  };
  const completedJob = await recordDriverJobPhotos(row.driver_login, row.job_id, { photoDataUrls: [], job });
  await query(
    `UPDATE driver_day_records
        SET truck_id = $3,
            truck_plate = $4,
            current_truck_id = $3,
            current_truck_plate = $4,
            current_load_id = $5,
            updated_at = now()
      WHERE driver_login = $1 AND plan_date = $2::date`,
    [row.driver_login, row.plan_date, row.to_truck_id, row.to_truck_plate, row.next_load_id]
  );
  return { switchRecord: row, record: completedJob };
}

async function completeDriverTruckSwitchWithoutSamsara(jobIdValue, {
  actor = "",
  reason = "",
  driverLogin = "",
  status = "override",
  missingMessage = "A failed truck switch was not found for override."
} = {}) {
  return withTransaction(async () => {
    const result = await query(
      `UPDATE driver_truck_switch_records
          SET status = $2,
              overridden_at = now(),
              overridden_by = $3,
              override_reason = $4,
              updated_at = now()
        WHERE job_id = $1
          AND status = 'attention'
          AND ($5 = '' OR lower(driver_login) = lower($5))
        RETURNING *`,
      [
        jobIdValue,
        String(status || "override"),
        String(actor || ""),
        String(reason || ""),
        driverKey(driverLogin || "")
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error(missingMessage);
    return finalizeDriverTruckSwitchWithoutSamsara(row);
  });
}

export async function overrideDriverTruckSwitch(jobIdValue, { actor = "", reason = "" } = {}) {
  return completeDriverTruckSwitchWithoutSamsara(jobIdValue, {
    actor,
    reason,
    status: "override"
  });
}

export async function skipDriverTruckSwitchSamsara(jobIdValue, driverLogin, {
  reason = "Driver skipped Samsara truck assignment.",
  job = null
} = {}) {
  const login = driverKey(driverLogin);
  if (!job || job.stopType !== "truck_switch" || String(job.jobId || "") !== String(jobIdValue || "")) {
    throw new Error("This is not an active truck-switch job.");
  }
  return withTransaction(async () => {
    const result = await query(
      `INSERT INTO driver_truck_switch_records (
         job_id, plan_id, plan_date, driver_login,
         from_truck_id, from_truck_plate, to_truck_id, to_truck_plate,
         switch_yard, parking_spot, next_load_id, planned_switch_minute,
         status, overridden_at, overridden_by, override_reason, updated_at
       ) VALUES (
         $1, $2, $3::date, $4,
         $5, $6, $7, $8,
         $9, $10, $11, $12,
         'skipped', now(), $13, $14, now()
       )
       ON CONFLICT (job_id) DO UPDATE SET
         status = 'skipped',
         overridden_at = now(),
         overridden_by = EXCLUDED.overridden_by,
         override_reason = EXCLUDED.override_reason,
         updated_at = now()
       WHERE lower(driver_truck_switch_records.driver_login) = lower(EXCLUDED.driver_login)
         AND driver_truck_switch_records.status IN ('pending', 'attention')
       RETURNING *`,
      [
        jobIdValue,
        job.planId || null,
        job.planDate,
        login,
        job.fromTruckId || "",
        job.fromTruckPlate || "",
        job.nextTruckId || job.truckId || "",
        job.nextTruckPlate || job.truckPlate || "",
        job.switchYard || "",
        job.parkingSpot || "",
        job.loadId || "",
        job.plannedSwitchMinute,
        login,
        String(reason || "Driver skipped Samsara truck assignment.")
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error("This truck switch can no longer be skipped. Refresh and try again.");
    return finalizeDriverTruckSwitchWithoutSamsara(row);
  });
}

export async function listDriverTruckSwitchAttention({ planId = null } = {}) {
  const result = await query(
    `SELECT *
       FROM driver_truck_switch_records
      WHERE status = 'attention'
        AND ($1::bigint IS NULL OR plan_id = $1)
      ORDER BY updated_at DESC`,
    [planId]
  );
  return result.rows;
}

export async function listDriverJobStatuses({ planId = null, planDate = null } = {}) {
  const params = [];
  const clauses = [];
  if (planId) {
    params.push(planId);
    clauses.push(`plan_id = $${params.length}`);
  }
  if (planDate) {
    params.push(planDate);
    clauses.push(`plan_date = $${params.length}::date`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await query(
    `SELECT job_id, plan_id, plan_date, driver_login, truck_id, truck_plate, load_id, load_name,
            stop_id, stop_type, order_refs, status, started_at, completed_at, job_details
       FROM driver_job_records
      ${where}
      ORDER BY plan_date DESC NULLS LAST, started_at DESC NULLS LAST, completed_at DESC NULLS LAST, id DESC
      LIMIT 1000`,
    params
  );
  return result.rows;
}

export async function listDriverHistory(driverLogin, { date = "", limit = 100 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const login = driverKey(driverLogin);
  const records = [];

  const dayParams = [login];
  const dayDateClause = date ? " AND plan_date = $2::date" : "";
  if (date) dayParams.push(String(date).slice(0, 10));
  const dayResult = await query(
    `SELECT id, driver_login, plan_id, plan_date::text AS plan_date,
            truck_id, truck_plate, samsara_username,
            COALESCE(pre_dvir_photo_data_urls, '[]'::jsonb) AS pre_photos,
            COALESCE(post_dvir_photo_data_urls, '[]'::jsonb) AS post_photos,
            pre_dvir_completed_at, post_dvir_completed_at,
            COALESCE(samsara_on_duty_response, '{}'::jsonb) AS samsara_on_response,
            COALESCE(samsara_off_duty_response, '{}'::jsonb) AS samsara_off_response,
            updated_at
       FROM driver_day_records
      WHERE driver_login = $1
        ${dayDateClause}
      ORDER BY COALESCE(post_dvir_completed_at, pre_dvir_completed_at, updated_at) DESC
      LIMIT ${safeLimit}`,
    dayParams
  );
  for (const row of dayResult.rows) {
    const prePhotos = Array.isArray(row.pre_photos) ? row.pre_photos.filter(Boolean) : [];
    if (row.pre_dvir_completed_at || prePhotos.length) {
      records.push({
        id: `dvir-pre-${row.id}`,
        type: "pre_dvir",
        title: "Pre-Trip DVIR",
        reference: row.truck_plate || "",
        planDate: row.plan_date || "",
        truckPlate: row.truck_plate || "",
        status: row.pre_dvir_completed_at ? "complete" : "photos saved",
        createdAt: row.pre_dvir_completed_at || row.updated_at,
        photos: prePhotos,
        details: {
          planId: row.plan_id,
          samsaraUsername: row.samsara_username,
          samsaraDvirId: row.samsara_on_response?.dvirId || row.samsara_on_response?.dvir?.id || row.samsara_on_response?.verifiedDvir?.id || "",
          samsaraError: row.samsara_on_response?.error || row.samsara_on_response?.clockError || ""
        }
      });
    }
    const postPhotos = Array.isArray(row.post_photos) ? row.post_photos.filter(Boolean) : [];
    if (row.post_dvir_completed_at || postPhotos.length) {
      records.push({
        id: `dvir-post-${row.id}`,
        type: "post_dvir",
        title: "Post-Trip DVIR",
        reference: row.truck_plate || "",
        planDate: row.plan_date || "",
        truckPlate: row.truck_plate || "",
        status: row.post_dvir_completed_at ? "complete" : "photos saved",
        createdAt: row.post_dvir_completed_at || row.updated_at,
        photos: postPhotos,
        details: {
          planId: row.plan_id,
          samsaraUsername: row.samsara_username,
          samsaraDvirId: row.samsara_off_response?.dvirId || row.samsara_off_response?.dvir?.id || row.samsara_off_response?.verifiedDvir?.id || "",
          samsaraError: row.samsara_off_response?.error || row.samsara_off_response?.clockError || ""
        }
      });
    }
  }

  const jobParams = [login];
  const jobDateClause = date ? " AND plan_date = $2::date" : "";
  if (date) jobParams.push(String(date).slice(0, 10));
  const jobResult = await query(
    `SELECT id, job_id, plan_id, plan_date::text AS plan_date,
            truck_id, truck_plate, load_id, load_name, stop_id, stop_type,
            COALESCE(order_refs, '[]'::jsonb) AS order_refs,
            COALESCE(photo_data_urls, '[]'::jsonb) AS photos,
            status, started_at, completed_at, created_at
       FROM driver_job_records
      WHERE driver_login = $1
        AND (status = 'complete' OR photo_data_urls::text LIKE '%r2://%')
        ${jobDateClause}
      ORDER BY COALESCE(completed_at, started_at, created_at) DESC, id DESC
      LIMIT ${safeLimit}`,
    jobParams
  );
  for (const row of jobResult.rows) {
    const photos = Array.isArray(row.photos) ? row.photos.filter(Boolean) : [];
    records.push({
      id: `job-${row.id}`,
      type: "stop",
      title: row.stop_type === "pickup" ? "Pickup Stop" : row.stop_type === "dropoff" ? "Drop Off Stop" : "Travel Stop",
      reference: Array.isArray(row.order_refs) ? row.order_refs.join(", ") : "",
      planDate: row.plan_date || "",
      truckPlate: row.truck_plate || "",
      status: row.status || "",
      createdAt: row.completed_at || row.started_at || row.created_at,
      photos,
      details: {
        jobId: row.job_id,
        planId: row.plan_id,
        loadName: row.load_name,
        stopType: row.stop_type,
        orderRefs: row.order_refs || [],
        startedAt: row.started_at,
        completedAt: row.completed_at
      }
    });
  }

  return records
    .sort((left, right) => new Date(left.createdAt || 0) - new Date(right.createdAt || 0))
    .slice(0, safeLimit);
}

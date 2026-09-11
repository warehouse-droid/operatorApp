import crypto from "node:crypto";

import { dispatchLocationKey } from "./dispatch-location.js";
import { dispatchRequiredPickupLocations } from "./dispatch-load-assignment.js";

const PICKUP_TYPES = new Set(["pick", "pickup"]);
const DELIVERY_TYPES = new Set(["drop", "dropoff", "delivery"]);
const EXECUTED_STATUSES = new Set(["in_progress", "complete", "completed"]);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function text(value) {
  return String(value ?? "").trim();
}

function stopType(stop = {}) {
  return text(stop.type || stop.stopType || stop.stop_type).toLowerCase();
}

function pickupStop(stop = {}) {
  return PICKUP_TYPES.has(stopType(stop));
}

function deliveryStop(stop = {}) {
  return DELIVERY_TYPES.has(stopType(stop));
}

function unique(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const clean = text(value);
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
  }
  return result;
}

function locationKey(value) {
  return dispatchLocationKey(text(value));
}

function orderRef(order = {}) {
  return text(order.id || order.orderId || order.orderRef || order.tranid || order.refNumber);
}

function visitStopId(stop = {}) {
  return text(stop.id || stop.stopId || stop.stop_id);
}

function loadId(load = {}) {
  return text(load.id || load.loadId || load.load_id);
}

function planOrders(plan = {}) {
  const indexed = new Map();
  const visit = (order) => {
    if (!order || typeof order !== "object") return;
    const ref = orderRef(order);
    if (ref && !indexed.has(ref.toLowerCase())) indexed.set(ref.toLowerCase(), order);
    for (const child of Array.isArray(order.childOrderDetails) ? order.childOrderDetails : []) visit(child);
  };
  for (const order of Array.isArray(plan.orders) ? plan.orders : []) visit(order);
  for (const order of Array.isArray(plan.assignedOrderSnapshots) ? plan.assignedOrderSnapshots : []) visit(order);
  return indexed;
}

function orderByRef(plan = {}, ref = "") {
  return planOrders(plan).get(text(ref).toLowerCase()) || null;
}

function manifestPickupLocations(order = {}) {
  return [
    ...(Array.isArray(order.poPickupManifest) ? order.poPickupManifest : []),
    ...(Array.isArray(order.directPickupManifest) ? order.directPickupManifest : [])
  ].map((entry) => text(entry?.location)).filter(Boolean);
}

function configuredPickupVisitLocations(order = {}) {
  const configured = Array.isArray(order.pickupLocations) && order.pickupLocations.length
    ? order.pickupLocations
    : [order.sourceYard || order.outboundLocation || "3445"];
  const seen = new Set();
  return [...configured, ...manifestPickupLocations(order)].filter((location) => {
    const key = locationKey(location);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(text);
}

export function dispatchRequiredPickupVisitLocations(order = {}, plan = {}) {
  const pickupLocations = configuredPickupVisitLocations(order);
  // Missing legacy item details are unknown, not evidence that a pickup is
  // empty. Detailed orders use the same location-scoped cargo rule as the UI.
  if (!Array.isArray(order.items)) return pickupLocations;
  return dispatchRequiredPickupLocations(plan, { ...order, pickupLocations });
}

function orderRequiresLocation(order = {}, location = "") {
  const wanted = locationKey(location);
  // A configured visit already in the route remains valid even if its current
  // cargo is empty; only the missing-pickup check requires nonempty visits.
  return Boolean(wanted && configuredPickupVisitLocations(order)
    .some((candidate) => locationKey(candidate) === wanted));
}

function directDeliveryRefs(stop = {}) {
  return unique([
    stop.orderId,
    stop.order_id,
    stop.orderRef,
    ...(Array.isArray(stop.orderRefs) ? stop.orderRefs : [])
  ]);
}

function loadDeliveryRefs(plan = {}, load = {}, location = "") {
  const wanted = locationKey(location);
  const refs = [];
  for (const stop of Array.isArray(load.stops) ? load.stops : []) {
    if (!deliveryStop(stop)) continue;
    for (const ref of directDeliveryRefs(stop)) {
      const order = orderByRef(plan, ref);
      if (order && orderRequiresLocation(order, wanted)) refs.push(ref);
    }
  }
  return unique(refs);
}

function matchingPickupStops(load = {}, location = "") {
  const wanted = locationKey(location);
  return (Array.isArray(load.stops) ? load.stops : [])
    .filter((stop) => pickupStop(stop) && locationKey(stop.location || stop.yard) === wanted);
}

function findPlanLoad(plan = {}, wantedLoadId = "") {
  const wanted = text(wantedLoadId);
  for (const truck of Array.isArray(plan.trucks) ? plan.trucks : []) {
    for (const load of Array.isArray(truck?.loads) ? truck.loads : []) {
      if (loadId(load) === wanted) return { truck, load };
    }
  }
  return null;
}

function previousLoadFor(previousPlan = {}, currentLoad = {}) {
  return findPlanLoad(previousPlan, loadId(currentLoad))?.load || null;
}

function explicitPickupRefs(stop = {}) {
  return Array.isArray(stop.orderRefs) ? unique(stop.orderRefs) : null;
}

function pickupVisitLoadOptedIn(load = {}) {
  return Number(load.pickupVisitSchemaVersion || 0) >= 1;
}

function resolvePreviousPickupRefs({ previousPlan, load, stop }) {
  const previousLoad = previousLoadFor(previousPlan, load);
  if (!previousLoad) return null;
  const previousStop = (previousLoad.stops || [])
    .find((candidate) => visitStopId(candidate) === visitStopId(stop));
  if (!previousStop || !pickupStop(previousStop)) return null;
  const explicit = explicitPickupRefs(previousStop);
  if (explicit) return explicit;
  if (matchingPickupStops(previousLoad, previousStop.location || previousStop.yard).length !== 1) return null;
  return loadDeliveryRefs(previousPlan, previousLoad, previousStop.location || previousStop.yard);
}

export function resolveDispatchPickupVisit({ plan = {}, load = {}, stop = {}, previousPlan = null } = {}) {
  if (!pickupStop(stop)) {
    return { orderRefs: [], source: "not_pickup", ambiguous: false };
  }
  const explicit = explicitPickupRefs(stop);
  if (explicit) {
    return { orderRefs: explicit, source: "explicit", ambiguous: false };
  }
  const sameLocation = matchingPickupStops(load, stop.location || stop.yard);
  if (sameLocation.length === 1) {
    return {
      orderRefs: loadDeliveryRefs(plan, load, stop.location || stop.yard),
      source: "legacy_single",
      ambiguous: false
    };
  }
  if (previousPlan) {
    const previousRefs = resolvePreviousPickupRefs({ previousPlan, load, stop });
    if (previousRefs) {
      const currentRefs = new Set(loadDeliveryRefs(plan, load, stop.location || stop.yard).map((ref) => ref.toLowerCase()));
      return {
        orderRefs: previousRefs.filter((ref) => currentRefs.has(ref.toLowerCase())),
        source: "legacy_previous",
        ambiguous: false
      };
    }
  }
  return { orderRefs: [], source: "ambiguous", ambiguous: true };
}

function conflict(code, message, details = {}) {
  return { code, message, ...details };
}

function pickupAmbiguityConflicts(plan = {}, previousPlan = null, { allowLegacyPassthrough = false } = {}) {
  const conflicts = [];
  for (const truck of Array.isArray(plan.trucks) ? plan.trucks : []) {
    for (const load of Array.isArray(truck?.loads) ? truck.loads : []) {
      if (allowLegacyPassthrough && !pickupVisitLoadOptedIn(load)) continue;
      for (const stop of Array.isArray(load.stops) ? load.stops : []) {
        if (!pickupStop(stop)) continue;
        const resolved = resolveDispatchPickupVisit({ plan, load, stop, previousPlan });
        if (!resolved.ambiguous) continue;
        conflicts.push(conflict(
          "DISPATCH_PICKUP_VISIT_AMBIGUOUS",
          "Two legacy pickup visits share a yard without an authoritative order allocation.",
          { loadId: loadId(load), stopId: visitStopId(stop), location: text(stop.location || stop.yard) }
        ));
      }
    }
  }
  return conflicts;
}

function validateMaterializedPickupVisits(plan = {}, { allowLegacyPassthrough = false } = {}) {
  const conflicts = [];
  for (const truck of Array.isArray(plan.trucks) ? plan.trucks : []) {
    for (const load of Array.isArray(truck?.loads) ? truck.loads : []) {
      if (load.returnOnly === true) continue;
      if (allowLegacyPassthrough && !pickupVisitLoadOptedIn(load)) continue;
      const allocations = new Map();
      const stops = Array.isArray(load.stops) ? load.stops : [];
      const strictPickupVisits = allowLegacyPassthrough
        ? pickupVisitLoadOptedIn(load)
        : Number(plan.pickupVisitSchemaVersion || 0) >= 1
          || pickupVisitLoadOptedIn(load)
          || stops.some(pickupStop);
      if (!strictPickupVisits) continue;
      const deliveryIndexes = new Map();
      for (const [index, stop] of stops.entries()) {
        if (!deliveryStop(stop)) continue;
        for (const ref of directDeliveryRefs(stop)) {
          if (!deliveryIndexes.has(ref.toLowerCase())) deliveryIndexes.set(ref.toLowerCase(), index);
        }
      }
      for (const [index, stop] of stops.entries()) {
        if (!pickupStop(stop)) continue;
        const refs = explicitPickupRefs(stop) || [];
        if (!refs.length) {
          conflicts.push(conflict(
            "DISPATCH_PICKUP_VISIT_EMPTY",
            "A pickup visit must contain at least one whole order.",
            { loadId: loadId(load), stopId: visitStopId(stop) }
          ));
          continue;
        }
        for (const ref of refs) {
          const refKey = ref.toLowerCase();
          const order = orderByRef(plan, ref);
          if (!deliveryIndexes.has(refKey) || !order) {
            conflicts.push(conflict(
              "DISPATCH_PICKUP_ORDER_NOT_IN_LOAD",
              `${ref} is allocated to a pickup visit but has no delivery in this load.`,
              { loadId: loadId(load), stopId: visitStopId(stop), orderRef: ref }
            ));
            continue;
          }
          if (!orderRequiresLocation(order, stop.location || stop.yard)) {
            conflicts.push(conflict(
              "DISPATCH_PICKUP_ORDER_WRONG_YARD",
              `${ref} does not require pickup at ${text(stop.location || stop.yard)}.`,
              { loadId: loadId(load), stopId: visitStopId(stop), orderRef: ref }
            ));
            continue;
          }
          const allocationKey = `${refKey}|${locationKey(stop.location || stop.yard)}`;
          if (allocations.has(allocationKey)) {
            conflicts.push(conflict(
              "DISPATCH_PICKUP_ORDER_DUPLICATE",
              `${ref} is allocated to more than one pickup visit at ${text(stop.location || stop.yard)}.`,
              {
                loadId: loadId(load),
                stopId: visitStopId(stop),
                otherStopId: allocations.get(allocationKey).stopId,
                orderRef: ref
              }
            ));
          } else {
            allocations.set(allocationKey, { stopId: visitStopId(stop), index });
          }
          if (index >= deliveryIndexes.get(refKey)) {
            conflicts.push(conflict(
              "DISPATCH_PICKUP_AFTER_DELIVERY",
              `${ref} must be picked up before its first delivery in this load.`,
              { loadId: loadId(load), stopId: visitStopId(stop), orderRef: ref }
            ));
          }
        }
      }
      for (const [refKey, firstDeliveryIndex] of deliveryIndexes) {
        const order = orderByRef(plan, refKey);
        if (!order) continue;
        for (const location of dispatchRequiredPickupVisitLocations(order, plan)) {
          const allocationKey = `${refKey}|${locationKey(location)}`;
          if (allocations.has(allocationKey)) continue;
          conflicts.push(conflict(
            "DISPATCH_PICKUP_ORDER_MISSING",
            `${orderRef(order)} requires pickup at ${location} before delivery.`,
            { loadId: loadId(load), orderRef: orderRef(order), location, firstDeliveryIndex }
          ));
        }
      }
    }
  }
  return conflicts;
}

export function materializeDispatchPickupVisits(
  plan = {},
  { previousPlan = null, allowLegacyPassthrough = false } = {}
) {
  const next = clone(plan) || {};
  const ambiguity = pickupAmbiguityConflicts(next, previousPlan, { allowLegacyPassthrough });
  if (ambiguity.length) return { plan: next, conflicts: ambiguity, migratedStopIds: [] };
  const migratedStopIds = [];
  for (const truck of Array.isArray(next.trucks) ? next.trucks : []) {
    for (const load of Array.isArray(truck?.loads) ? truck.loads : []) {
      if (allowLegacyPassthrough && !pickupVisitLoadOptedIn(load)) continue;
      const allocatedByLocation = new Map();
      for (const stop of Array.isArray(load.stops) ? load.stops : []) {
        if (!pickupStop(stop)) continue;
        const explicit = explicitPickupRefs(stop);
        if (!explicit) continue;
        const key = locationKey(stop.location || stop.yard);
        if (!allocatedByLocation.has(key)) allocatedByLocation.set(key, new Set());
        explicit.forEach((ref) => allocatedByLocation.get(key).add(ref.toLowerCase()));
      }
      for (const stop of Array.isArray(load.stops) ? load.stops : []) {
        if (!pickupStop(stop) || explicitPickupRefs(stop)) continue;
        const resolved = resolveDispatchPickupVisit({ plan: next, load, stop, previousPlan });
        const key = locationKey(stop.location || stop.yard);
        const allocated = allocatedByLocation.get(key) || new Set();
        const refs = resolved.orderRefs.filter((ref) => !allocated.has(ref.toLowerCase()));
        stop.orderRefs = refs;
        if (!text(stop.orderId) && refs.length) stop.orderId = refs[0];
        refs.forEach((ref) => allocated.add(ref.toLowerCase()));
        allocatedByLocation.set(key, allocated);
        migratedStopIds.push(visitStopId(stop));
      }
    }
  }
  const conflicts = validateMaterializedPickupVisits(next, { allowLegacyPassthrough });
  const fullyMaterialized = (next.trucks || []).every((truck) => (truck.loads || []).every((load) => {
    if (load.returnOnly === true) return true;
    const stops = Array.isArray(load.stops) ? load.stops : [];
    return !stops.some(deliveryStop)
      || (pickupVisitLoadOptedIn(load) && stops.some(pickupStop));
  }));
  if (!conflicts.length && fullyMaterialized) next.pickupVisitSchemaVersion = 1;
  return { plan: next, conflicts, migratedStopIds };
}

export function validateDispatchPickupVisits(plan = {}, { previousPlan = null } = {}) {
  const materialized = materializeDispatchPickupVisits(plan, { previousPlan });
  return materialized.conflicts;
}

function recordStatus(record = {}) {
  return text(record.status).toLowerCase();
}

function recordLoadId(record = {}) {
  return text(record.loadId || record.load_id);
}

function recordStopId(record = {}) {
  return text(record.stopId || record.stop_id);
}

function recordJobDetails(record = {}) {
  const value = record.jobDetails || record.job_details || {};
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(text(value) || "{}");
  } catch {
    return {};
  }
}

function activityForLoad(activity = [], load = {}) {
  const wanted = loadId(load);
  return (Array.isArray(activity) ? activity : [])
    .filter((record) => EXECUTED_STATUSES.has(recordStatus(record)) && recordLoadId(record) === wanted);
}

function travelTargetIndex(load = {}, record = {}) {
  const stops = Array.isArray(load.stops) ? load.stops : [];
  const details = recordJobDetails(record);
  const explicitTarget = text(details.toStopId || details.to_stop_id || record.toStopId || record.to_stop_id);
  if (explicitTarget) {
    const index = stops.findIndex((stop) => visitStopId(stop) === explicitTarget);
    if (index >= 0) return index;
  }
  const id = recordStopId(record);
  const candidates = stops
    .map((stop, index) => ({ id: visitStopId(stop), index }))
    .filter((candidate) => candidate.id && id.endsWith(`-${candidate.id}`))
    .sort((left, right) => right.id.length - left.id.length);
  return candidates[0]?.index ?? -1;
}

export function dispatchLoadProtectedBoundary(load = {}, activity = []) {
  const stops = Array.isArray(load.stops) ? load.stops : [];
  let boundary = -1;
  for (const record of activityForLoad(activity, load)) {
    const type = stopType(record);
    if (type === "travel") {
      if (recordStatus(record) === "in_progress") boundary = Math.max(boundary, travelTargetIndex(load, record));
      continue;
    }
    if (!PICKUP_TYPES.has(type) && !DELIVERY_TYPES.has(type)) continue;
    const index = stops.findIndex((stop) => visitStopId(stop) === recordStopId(record));
    boundary = Math.max(boundary, index >= 0 ? index : stops.length - 1);
  }
  return boundary;
}

function normalizedAddress(value = "") {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

function deliveryAddress(plan = {}, stop = {}) {
  const order = orderByRef(plan, directDeliveryRefs(stop)[0]);
  return text(
    stop.dropAddress
    || stop.drop_address
    || order?.address
    || order?.dropAddress
    || stop.dropLocation
    || stop.destinationYard
    || stop.location
  );
}

function lateOrderAddress(order = {}) {
  return text(order.address || order.dropAddress || order.destinationYard || order.toLocation);
}

function nextOpaqueStopId(kind = "visit") {
  return `stop-${kind}-${crypto.randomUUID()}`;
}

function makeId(factory, kind, ordinal = 0) {
  const candidate = typeof factory === "function" ? text(factory(kind, ordinal)) : "";
  return candidate || nextOpaqueStopId(kind);
}

function throwConflict(entry) {
  throw Object.assign(new Error(entry.message), { status: 409, ...entry });
}

function assertValidMaterialization(result) {
  if (result.conflicts.length) throwConflict(result.conflicts[0]);
  return result.plan;
}

function upsertOrder(plan = {}, order = {}) {
  const ref = orderRef(order);
  if (!ref) throw Object.assign(new Error("A late order reference is required."), {
    status: 400,
    code: "DISPATCH_COMMAND_INVALID"
  });
  const orders = Array.isArray(plan.orders) ? plan.orders : (plan.orders = []);
  const index = orders.findIndex((candidate) => orderRef(candidate).toLowerCase() === ref.toLowerCase());
  if (index >= 0) orders[index] = clone(order);
  else orders.push(clone(order));
  return ref;
}

function matchingFutureDeliveryGroup(plan, load, order, boundary) {
  const key = normalizedAddress(lateOrderAddress(order));
  if (!key) return null;
  const stops = Array.isArray(load.stops) ? load.stops : [];
  const indexes = stops
    .map((stop, index) => ({ stop, index }))
    .filter(({ stop, index }) => deliveryStop(stop) && index > boundary && normalizedAddress(deliveryAddress(plan, stop)) === key)
    .map(({ index }) => index);
  if (!indexes.length) return null;
  let first = indexes[0];
  let last = first;
  while (
    first - 1 > boundary
    && deliveryStop(stops[first - 1])
    && normalizedAddress(deliveryAddress(plan, stops[first - 1])) === key
  ) first -= 1;
  while (
    last + 1 < stops.length
    && deliveryStop(stops[last + 1])
    && normalizedAddress(deliveryAddress(plan, stops[last + 1])) === key
  ) last += 1;
  return { first, last, stopIds: stops.slice(first, last + 1).map(visitStopId) };
}

export function insertDispatchLateOrder({
  plan = {},
  loadId: requestedLoadId = "",
  order = {},
  activity = [],
  makeStopId = null
} = {}) {
  const stagedPlan = clone(plan) || {};
  const stagedLoad = findPlanLoad(stagedPlan, requestedLoadId);
  if (!stagedLoad) throw Object.assign(new Error("The target Dispatch load no longer exists."), {
    status: 404,
    code: "DISPATCH_LOAD_NOT_FOUND"
  });
  stagedLoad.load.pickupVisitSchemaVersion = 1;
  const materializedSource = materializeDispatchPickupVisits(stagedPlan, { allowLegacyPassthrough: true });
  const next = assertValidMaterialization(materializedSource);
  const found = findPlanLoad(next, requestedLoadId);
  const { load } = found;
  const ref = upsertOrder(next, order);
  if ((load.stops || []).some((stop) => deliveryStop(stop) && directDeliveryRefs(stop)
    .some((candidate) => candidate.toLowerCase() === ref.toLowerCase()))) {
    throw Object.assign(new Error(`${ref} is already planned in this load.`), {
      status: 409,
      code: "DISPATCH_ORDER_ALREADY_PLANNED"
    });
  }

  const boundary = dispatchLoadProtectedBoundary(load, activity);
  const matchingCustomer = matchingFutureDeliveryGroup(next, load, order, boundary);
  const hadMatchingCustomer = (load.stops || []).some((stop) =>
    deliveryStop(stop)
    && normalizedAddress(deliveryAddress(next, stop)) === normalizedAddress(lateOrderAddress(order))
  );
  const lowerInsertionIndex = boundary + 1;
  const pickupAnchor = matchingCustomer ? matchingCustomer.first : load.stops.length;
  const createdPickupStopIds = [];
  const reusedPickupStopIds = [];

  for (const [ordinal, location] of dispatchRequiredPickupVisitLocations(order, next).entries()) {
    const candidates = (load.stops || [])
      .map((stop, index) => ({ stop, index }))
      .filter(({ stop, index }) =>
        pickupStop(stop)
        && locationKey(stop.location || stop.yard) === locationKey(location)
        && index >= lowerInsertionIndex
        && index < pickupAnchor
      );
    const reusable = candidates.at(-1);
    if (reusable) {
      reusable.stop.orderRefs = unique([...(reusable.stop.orderRefs || []), ref]);
      if (!text(reusable.stop.orderId)) reusable.stop.orderId = ref;
      reusedPickupStopIds.push(visitStopId(reusable.stop));
      continue;
    }
    const pickup = {
      id: makeId(makeStopId, "pick", ordinal),
      loadId: loadId(load),
      type: "pick",
      location: text(location),
      orderId: ref,
      orderRefs: [ref]
    };
    const currentAnchor = matchingCustomer
      ? Math.max(lowerInsertionIndex, (load.stops || []).findIndex((stop) => visitStopId(stop) === matchingCustomer.stopIds[0]))
      : load.stops.length;
    load.stops.splice(currentAnchor < 0 ? load.stops.length : currentAnchor, 0, pickup);
    createdPickupStopIds.push(pickup.id);
  }

  const newDrop = {
    id: makeId(makeStopId, "drop", 0),
    loadId: loadId(load),
    type: "drop",
    orderId: ref,
    orderRefs: [ref],
    location: text(order.pickupLocations?.[0] || order.sourceYard || "3445")
  };
  if (matchingCustomer) {
    const finalMatchIndex = Math.max(...matchingCustomer.stopIds
      .map((id) => load.stops.findIndex((stop) => visitStopId(stop) === id)));
    load.stops.splice(finalMatchIndex + 1, 0, newDrop);
  } else {
    load.stops.push(newDrop);
  }

  const validated = materializeDispatchPickupVisits(next, { allowLegacyPassthrough: true });
  if (validated.conflicts.length) throwConflict(validated.conflicts[0]);
  return {
    plan: validated.plan,
    orderRef: ref,
    protectedBoundary: boundary,
    createdPickupStopIds,
    reusedPickupStopIds,
    dropStopId: newDrop.id,
    secondDeliveryVisit: hadMatchingCustomer && !matchingCustomer
  };
}

function pickupVisitById(load = {}, stopId = "") {
  const index = (load.stops || []).findIndex((stop) => visitStopId(stop) === text(stopId));
  const stop = index >= 0 ? load.stops[index] : null;
  return stop && pickupStop(stop) ? { stop, index } : null;
}

export function splitDispatchPickupVisit({
  plan = {},
  loadId: requestedLoadId = "",
  stopId = "",
  orderRefs = [],
  insertIndex = null,
  targetStopId = "",
  activity = [],
  makeStopId = null
} = {}) {
  const stagedPlan = clone(plan) || {};
  const stagedLoad = findPlanLoad(stagedPlan, requestedLoadId);
  if (!stagedLoad) throw Object.assign(new Error("The pickup load no longer exists."), {
    status: 404,
    code: "DISPATCH_LOAD_NOT_FOUND"
  });
  stagedLoad.load.pickupVisitSchemaVersion = 1;
  const next = assertValidMaterialization(materializeDispatchPickupVisits(
    stagedPlan,
    { allowLegacyPassthrough: true }
  ));
  const found = findPlanLoad(next, requestedLoadId);
  const { load } = found;
  const source = pickupVisitById(load, stopId);
  if (!source) throw Object.assign(new Error("The pickup visit no longer exists."), {
    status: 404,
    code: "DISPATCH_PICKUP_VISIT_NOT_FOUND"
  });
  const boundary = dispatchLoadProtectedBoundary(load, activity);
  if (source.index <= boundary) {
    throwConflict(conflict(
      "DISPATCH_ACTIVE_LOAD_LOCKED",
      "Driver activity protects this pickup visit and its order allocation.",
      { loadId: loadId(load), stopId: visitStopId(source.stop), throughStopIndex: boundary }
    ));
  }
  const sourceRefs = explicitPickupRefs(source.stop) || [];
  const requested = unique(orderRefs);
  const sourceKeys = new Set(sourceRefs.map((ref) => ref.toLowerCase()));
  if (!requested.length || requested.some((ref) => !sourceKeys.has(ref.toLowerCase()))) {
    throw Object.assign(new Error("Select one or more whole orders from this pickup visit."), {
      status: 400,
      code: "DISPATCH_PICKUP_SPLIT_INVALID"
    });
  }
  const requestedKeys = new Set(requested.map((ref) => ref.toLowerCase()));
  if (requested.length >= sourceRefs.length) {
    throw Object.assign(new Error("Leave at least one whole order in the original pickup visit."), {
      status: 400,
      code: "DISPATCH_PICKUP_SPLIT_INVALID"
    });
  }
  const earliestDelivery = Math.min(...(load.stops || [])
    .map((stop, index) => ({ stop, index }))
    .filter(({ stop }) => deliveryStop(stop) && directDeliveryRefs(stop)
      .some((ref) => requestedKeys.has(ref.toLowerCase())))
    .map(({ index }) => index));
  const lowerInsertionIndex = Math.max(boundary + 1, source.index + 1);
  const requestedInsertion = Number.isInteger(insertIndex) ? insertIndex : earliestDelivery;
  if (requestedInsertion < lowerInsertionIndex || requestedInsertion > earliestDelivery) {
    throw Object.assign(new Error("Choose a route gap after completed work and before the selected deliveries."), {
      status: 409,
      code: "DISPATCH_PICKUP_SPLIT_POSITION_INVALID",
      lowerInsertionIndex,
      earliestDeliveryIndex: earliestDelivery
    });
  }

  const target = targetStopId ? pickupVisitById(load, targetStopId) : null;
  if (target) {
    if (
      target.stop === source.stop
      || target.index <= boundary
      || target.index <= source.index
      || target.index >= earliestDelivery
      || locationKey(target.stop.location || target.stop.yard) !== locationKey(source.stop.location || source.stop.yard)
    ) {
      throw Object.assign(new Error("The target pickup visit is not a legal future visit for these orders."), {
        status: 409,
        code: "DISPATCH_PICKUP_SPLIT_TARGET_INVALID"
      });
    }
    target.stop.orderRefs = unique([...(target.stop.orderRefs || []), ...requested]);
  }

  source.stop.orderRefs = sourceRefs.filter((ref) => !requestedKeys.has(ref.toLowerCase()));
  const insertion = requestedInsertion;
  let createdStopId = "";
  if (!target) {
    const newPickup = {
      id: makeId(makeStopId, "pick", 0),
      loadId: loadId(load),
      type: "pick",
      location: text(source.stop.location || source.stop.yard),
      orderId: requested[0],
      orderRefs: requested
    };
    load.stops.splice(insertion, 0, newPickup);
    createdStopId = newPickup.id;
  }
  const validated = materializeDispatchPickupVisits(next, { allowLegacyPassthrough: true });
  if (validated.conflicts.length) throwConflict(validated.conflicts[0]);
  return {
    plan: validated.plan,
    sourceStopId: visitStopId(source.stop),
    targetStopId: target ? visitStopId(target.stop) : createdStopId,
    createdStopId,
    movedOrderRefs: requested,
    protectedBoundary: boundary,
    insertIndex: insertion
  };
}

function structuralLocation(plan = {}, stop = {}) {
  if (pickupStop(stop)) return locationKey(stop.location || stop.yard);
  if (deliveryStop(stop)) return normalizedAddress(deliveryAddress(plan, stop));
  return locationKey(stop.location || stop.address);
}

export function dispatchExecutedStopFingerprint(plan = {}, load = {}, stop = {}, { previousPlan = null } = {}) {
  const refs = pickupStop(stop)
    ? resolveDispatchPickupVisit({ plan, load, stop, previousPlan }).orderRefs
    : directDeliveryRefs(stop);
  return JSON.stringify({
    id: visitStopId(stop),
    type: stopType(stop),
    location: structuralLocation(plan, stop),
    orderRefs: [...refs].map((ref) => ref.toLowerCase()).sort()
  });
}

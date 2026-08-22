import { dispatchDependencyOrderRefs } from "./yard-dependency-structure.js";

function text(value) {
  return String(value ?? "").trim();
}

function locationKey(value) {
  return text(value).toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

function leadingSiteNumber(value) {
  return text(value).match(/^\s*(\d{2,6})\b/u)?.[1] || "";
}

function samePlace(left, right) {
  const leftKey = locationKey(left);
  const rightKey = locationKey(right);
  if (!leftKey || !rightKey) {return false;}
  if (leftKey === rightKey) {return true;}
  const leftNumber = leadingSiteNumber(left);
  const rightNumber = leadingSiteNumber(right);
  if (leftNumber && rightNumber) {return leftNumber === rightNumber;}
  return Math.min(leftKey.length, rightKey.length) >= 8
    && (leftKey.startsWith(rightKey) || rightKey.startsWith(leftKey));
}

function uniqueLocations(values = []) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const location = text(value);
    if (location && !result.some((existing) => samePlace(existing, location))) {result.push(location);}
  }
  return result;
}

function orderIndex(orders = []) {
  const byRef = new Map();
  for (const order of orders) {
    for (const ref of dispatchDependencyOrderRefs(order)) {byRef.set(ref.toLowerCase(), order);}
  }
  return byRef;
}

function targetRefForDrop(drop = {}, order = {}) {
  return text(order.id || drop.orderId);
}

function requirementsForStops(stops = [], ordersByRef = new Map()) {
  const requirements = [];
  for (const stop of stops) {
    if (stop?.type !== "drop" || !text(stop.orderId)) {continue;}
    const order = ordersByRef.get(text(stop.orderId).toLowerCase());
    if (!order) {continue;}
    const targetRef = targetRefForDrop(stop, order);
    for (const location of uniqueLocations(order.pickupLocations?.length
      ? order.pickupLocations
      : [order.sourceYard || order.outboundLocation].filter(Boolean))) {
      requirements.push({ targetRef, location, dropId: text(stop.id), dropOrderId: text(stop.orderId) });
    }
  }
  return requirements;
}

function refs(value = []) {
  return [...new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean))];
}

function safeIdPart(value) {
  return text(value).toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-").replaceAll(/^-|-$/gu, "").slice(0, 48) || "target";
}

function reconcileLoad(load = {}, ordersByRef, affected) {
  let stops = Array.isArray(load.stops) ? load.stops.map((stop) => ({ ...stop })) : [];
  const requirements = requirementsForStops(stops, ordersByRef);

  stops = stops.filter((stop) => {
    if (stop?.type !== "pick" || stop.dependencyManaged !== true) {return true;}
    const stillRequired = requirements.some((entry) => samePlace(entry.location, stop.location));
    if (stillRequired) {
      stop.dependencyTargetRefs = refs(requirements
        .filter((entry) => samePlace(entry.location, stop.location))
        .map((entry) => entry.targetRef));
      return true;
    }
    const managedTargets = refs(stop.dependencyTargetRefs);
    if (!managedTargets.length) {return true;}
    return !managedTargets.every((targetRef) => affected.has(targetRef.toLowerCase()));
  });

  for (let index = 0; index < stops.length; index += 1) {
    const drop = stops[index];
    if (drop?.type !== "drop" || !text(drop.orderId)) {continue;}
    const order = ordersByRef.get(text(drop.orderId).toLowerCase());
    if (!order) {continue;}
    const targetRef = targetRefForDrop(drop, order);
    if (!affected.has(targetRef.toLowerCase())
      && !dispatchDependencyOrderRefs(order).some((ref) => affected.has(ref.toLowerCase()))) {continue;}
    const locations = uniqueLocations(order.pickupLocations?.length
      ? order.pickupLocations
      : [order.sourceYard || order.outboundLocation].filter(Boolean));
    for (const location of locations) {
      const priorPickup = stops.slice(0, index).find((stop) => stop?.type === "pick" && samePlace(stop.location, location));
      if (priorPickup) {
        if (priorPickup.dependencyManaged === true) {
          priorPickup.dependencyTargetRefs = refs([...(priorPickup.dependencyTargetRefs || []), targetRef]);
        }
        continue;
      }
      const inserted = {
        id: `scm-dependency-pick-${safeIdPart(targetRef)}-${safeIdPart(location)}-${index}`,
        type: "pick",
        orderId: targetRef,
        location,
        dependencyManaged: true,
        dependencySource: "scm-dependency-management",
        dependencyTargetRefs: [targetRef]
      };
      stops.splice(index, 0, inserted);
      index += 1;
    }
  }
  return { ...load, stops };
}

export function reconcileDependencyManagedPickups({
  plan = {},
  enrichedOrders = [],
  affectedTargetRefs = []
} = {}) {
  const enrichedByRef = orderIndex(enrichedOrders);
  const orders = (plan.orders || []).map((order) => {
    const enriched = dispatchDependencyOrderRefs(order)
      .map((ref) => enrichedByRef.get(ref.toLowerCase()))
      .find(Boolean);
    return enriched ? { ...order, ...enriched } : order;
  });
  for (const enriched of enrichedOrders) {
    if (!orders.some((order) => text(order.id).toLowerCase() === text(enriched.id).toLowerCase())) {
      orders.push(enriched);
    }
  }
  const ordersByRef = orderIndex(orders);
  const affected = new Set(affectedTargetRefs.map((value) => text(value).toLowerCase()).filter(Boolean));
  return {
    ...plan,
    orders,
    trucks: (plan.trucks || []).map((truck) => ({
      ...truck,
      loads: (truck.loads || []).map((load) => reconcileLoad(load, ordersByRef, affected))
    }))
  };
}

export const scmDependencyLocationsMatch = samePlace;

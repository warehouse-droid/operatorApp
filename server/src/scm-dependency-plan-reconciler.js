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

function purchaseOrderRouteProjection(order = {}) {
  const projection = order.poRouteProjection;
  return text(order.type).toUpperCase() === "PO"
    && projection
    && Number(projection.version || 0) >= 1
    ? projection
    : null;
}

function dropStop(stop = {}) {
  return ["drop", "dropoff"].includes(text(stop.type).toLowerCase());
}

function stopOrderRefMatches(stop = {}, values = []) {
  const wanted = text(stop.orderId).toLowerCase();
  return Boolean(wanted && values.some((value) => text(value).toLowerCase() === wanted));
}

function routeDropoffMatchesStop(dropoff = {}, stop = {}, dropoffCount = 0) {
  const dropoffKey = text(dropoff.key);
  const stopKey = text(stop.dropoffKey ?? stop.dropoff_key);
  if (dropoffKey && stopKey) {return dropoffKey === stopKey;}
  const dropoffLocation = text(dropoff.destinationYard ?? dropoff.destination_yard ?? dropoff.address);
  const stopLocation = text(
    stop.dropLocation
    ?? stop.drop_location
    ?? stop.destinationYard
    ?? stop.destination_yard
    ?? stop.location
  );
  return samePlace(dropoffLocation, stopLocation) || dropoffCount === 1;
}

function projectedResidualStop(stop = {}, order = {}, dropoff = {}, { managed = false } = {}) {
  const targetRefs = refs(order.poRouteProjection?.targetRefs);
  const destinationYard = text(dropoff.destinationYard ?? dropoff.destination_yard);
  const address = text(dropoff.address || dropoff.defaultAddress || destinationYard);
  return {
    ...stop,
    type: "drop",
    orderId: text(order.id),
    location: destinationYard || address,
    dropoffKey: text(dropoff.key),
    dropLocation: destinationYard,
    dropAddress: address,
    destinationLocationId: dropoff.destinationLocationId ?? dropoff.destination_location_id ?? null,
    lineRowIds: (dropoff.lineRowIds ?? dropoff.line_row_ids ?? []).map(text).filter(Boolean),
    dropPallets: Number(dropoff.pallets || 0),
    dropLayers: Number(dropoff.layers || 0),
    dropSections: Number(dropoff.sections || 0),
    dropPieces: Number(dropoff.pieces || 0),
    dropSalesQty: Number(dropoff.salesQty ?? dropoff.sales_qty ?? 0),
    dropWeight: Number(dropoff.weight || 0),
    dependencyResidualManaged: managed || stop.dependencyResidualManaged === true,
    dependencyResidualProjected: true,
    dependencySource: stop.dependencySource || "scm-dependency-management",
    dependencyTargetRefs: targetRefs
  };
}

function mutableLoads(trucks = []) {
  return (trucks || []).map((truck) => ({
    ...truck,
    loads: (truck.loads || []).map((load) => ({
      ...load,
      stops: (load.stops || []).map((stop) => ({ ...stop }))
    }))
  }));
}

function flatLoads(trucks = []) {
  return trucks.flatMap((truck) => truck.loads || []);
}

function targetInsertionLoad(loads = [], targetRefs = [], affected = new Set()) {
  const preferred = targetRefs.filter((targetRef) => affected.has(text(targetRef).toLowerCase()));
  const candidates = preferred.length ? preferred : targetRefs;
  for (const targetRef of candidates) {
    const load = loads.find((candidate) => (candidate.stops || [])
      .some((stop) => dropStop(stop) && stopOrderRefMatches(stop, [targetRef])));
    if (load) {return { load, targetRef };}
  }
  const affectedRefs = [...affected];
  const load = loads.find((candidate) => (candidate.stops || [])
    .some((stop) => dropStop(stop) && stopOrderRefMatches(stop, affectedRefs)));
  return load ? { load, targetRef: "" } : { load: null, targetRef: "" };
}

function insertionIndexForTarget(load = {}, targetRefs = []) {
  let index = -1;
  for (const [candidateIndex, stop] of (load.stops || []).entries()) {
    if (dropStop(stop) && stopOrderRefMatches(stop, targetRefs)) {index = candidateIndex;}
  }
  return index >= 0 ? index + 1 : (load.stops || []).length;
}

function reconcilePurchaseOrderResidualDrops({ trucks = [], orders = [], affected = new Set() } = {}) {
  const nextTrucks = mutableLoads(trucks);
  const loads = flatLoads(nextTrucks);
  const uniqueOrders = [...new Map(orders.map((order) => [text(order.id).toLowerCase(), order])).values()];
  const projectedPurchaseOrders = uniqueOrders.filter((order) => {
    const projection = purchaseOrderRouteProjection(order);
    if (!projection) {return false;}
    const orderRefs = dispatchDependencyOrderRefs(order).map((value) => text(value).toLowerCase());
    const targetRefs = refs(projection.targetRefs).map((value) => value.toLowerCase());
    return [...orderRefs, ...targetRefs].some((value) => affected.has(value));
  });

  for (const order of projectedPurchaseOrders) {
    const orderRefs = dispatchDependencyOrderRefs(order);
    const projection = purchaseOrderRouteProjection(order);
    const dropoffs = Array.isArray(projection.dropoffs) ? projection.dropoffs : [];
    const existing = [];
    for (const load of loads) {
      for (const [index, stop] of (load.stops || []).entries()) {
        if (dropStop(stop) && stopOrderRefMatches(stop, orderRefs)) {existing.push({ load, index, stop });}
      }
    }

    let ownerLoad = existing[0]?.load || null;
    const claimedDropoffs = new Set();
    const removalsByLoad = new Map();
    for (const entry of existing) {
      const dropoffIndex = dropoffs.findIndex((dropoff, index) =>
        !claimedDropoffs.has(index) && routeDropoffMatchesStop(dropoff, entry.stop, dropoffs.length)
      );
      if (dropoffIndex < 0) {
        if (!removalsByLoad.has(entry.load)) {removalsByLoad.set(entry.load, new Set());}
        removalsByLoad.get(entry.load).add(entry.index);
        continue;
      }
      claimedDropoffs.add(dropoffIndex);
      entry.load.stops[entry.index] = projectedResidualStop(entry.stop, order, dropoffs[dropoffIndex]);
    }
    for (const [load, removals] of removalsByLoad) {
      load.stops = load.stops.filter((_, index) => !removals.has(index));
    }

    const missingDropoffs = dropoffs.filter((_, index) => !claimedDropoffs.has(index));
    if (!missingDropoffs.length) {continue;}
    const targetRefs = refs(projection.targetRefs);
    if (!ownerLoad) {ownerLoad = targetInsertionLoad(loads, targetRefs, affected).load;}
    if (!ownerLoad) {continue;}
    let insertIndex = existing.some((entry) => entry.load === ownerLoad)
      ? Math.max(...existing.filter((entry) => entry.load === ownerLoad).map((entry) =>
          ownerLoad.stops.findIndex((stop) => text(stop.id) === text(entry.stop.id))
        ), -1) + 1
      : insertionIndexForTarget(ownerLoad, targetRefs);
    for (const dropoff of missingDropoffs) {
      const inserted = projectedResidualStop({
        id: `scm-dependency-po-residual-${safeIdPart(order.id)}-${safeIdPart(dropoff.key || dropoff.destinationYard)}`
      }, order, dropoff, { managed: true });
      ownerLoad.stops.splice(Math.max(0, insertIndex), 0, inserted);
      insertIndex += 1;
    }
  }
  return nextTrucks;
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
  const residualTrucks = reconcilePurchaseOrderResidualDrops({
    trucks: plan.trucks || [],
    orders,
    affected
  });
  return {
    ...plan,
    orders,
    trucks: residualTrucks.map((truck) => ({
      ...truck,
      loads: (truck.loads || []).map((load) => reconcileLoad(load, ordersByRef, affected))
    }))
  };
}

export const scmDependencyLocationsMatch = samePlace;

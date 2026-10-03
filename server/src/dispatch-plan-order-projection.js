import {
  reconcileDependencyManagedPickups,
  scmDependencyLocationsMatch
} from "./scm-dependency-plan-reconciler.js";
import { dispatchDependencyOrderRefs } from "./yard-dependency-structure.js";

const RELATIONSHIP_ORDER_FIELDS = Object.freeze([
  "poPickupManifest",
  "directPickupManifest",
  "orderDependencies",
  "orderDependency",
  "dependencyDirectPickup",
  "dependencyWaitingForTransfer",
  "dependencyAttention",
  "dependencyUncovered",
  "dependencyUncoveredQuantity",
  "dependencyHidden",
  "dependentSalesOrderRef",
  "dependencyLabels",
  "poRouteProjection",
  "toRouteProjection",
  "po_route_projection"
]);

const PO_ITEM_PROJECTION_FIELDS = Object.freeze([
  "dispatchServiceFee",
  "poAllocatedPallets",
  "poAllocatedLayers",
  "poAllocatedSections",
  "poAllocatedPieces",
  "poAllocatedSalesQty"
]);

const INVALID_ROUTE_LOAD_FIELDS = Object.freeze([
  "routeEstimate",
  "routeEstimateId",
  "routeSignature",
  "plannedFinishMinute",
  "finish",
  "finishTime",
  "timing"
]);

const INVALID_ROUTE_STOP_FIELDS = Object.freeze([
  "arriveTime",
  "departTime",
  "plannedArrive",
  "plannedDepart",
  "plannedArrival",
  "plannedDeparture",
  "timing"
]);

function text(value) {
  return String(value ?? "").trim();
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function nativePickupLocations(order = {}) {
  const raw = order.raw && typeof order.raw === "object" && !Array.isArray(order.raw)
    ? order.raw
    : {};
  return [
    order.sourceYard,
    order.pickupLocation,
    order.transitOriginalSourceYard,
    ...(Array.isArray(order.transitOriginalPickupLocations) ? order.transitOriginalPickupLocations : []),
    raw.pickup_location,
    raw.outbound_location,
    raw.source_location,
    ...(Array.isArray(raw.allocation_pickup_locations) ? raw.allocation_pickup_locations : [])
  ].map(text).filter(Boolean);
}

function relationshipPickupLocations(order = {}) {
  return [
    ...(Array.isArray(order.poPickupManifest) ? order.poPickupManifest : []),
    ...(Array.isArray(order.directPickupManifest) ? order.directPickupManifest : [])
  ].map((entry) => text(entry?.location)).filter(Boolean);
}

function stripPoItemProjection(item = {}) {
  const next = clone(item) || {};
  for (const field of PO_ITEM_PROJECTION_FIELDS) delete next[field];
  return next;
}

/**
 * Remove values that are projections of mutable PO/TO relationships. Native
 * source locations and plan-owned group/split structure deliberately survive.
 */
export function stripDispatchRelationshipProjection(order = {}) {
  const projectedLocations = relationshipPickupLocations(order);
  const nativeLocations = nativePickupLocations(order);
  const next = clone(order) || {};
  next.pickupLocations = (Array.isArray(order.pickupLocations) ? order.pickupLocations : [])
    .filter((location) => {
      const wasProjected = projectedLocations.some((candidate) => (
        scmDependencyLocationsMatch(candidate, location)
      ));
      if (!wasProjected) return true;
      return nativeLocations.some((candidate) => scmDependencyLocationsMatch(candidate, location));
    });
  next.items = (Array.isArray(order.items) ? order.items : []).map(stripPoItemProjection);
  next.childOrderDetails = (Array.isArray(order.childOrderDetails) ? order.childOrderDetails : [])
    .map(stripDispatchRelationshipProjection);
  for (const field of RELATIONSHIP_ORDER_FIELDS) delete next[field];
  return next;
}

export function stripDispatchRelationshipProjections(orders = []) {
  return (Array.isArray(orders) ? orders : []).map(stripDispatchRelationshipProjection);
}

export function dispatchRelationshipProjectionContext(orders = []) {
  const purchaseOrderRefs = [];
  const releasedTargetRefs = [];
  for (const order of Array.isArray(orders) ? orders : []) {
    if (text(order?.type).toUpperCase() === "PO" && order?.poRouteProjection) {
      purchaseOrderRefs.push(
        order.id,
        order.originalPoRef,
        order.dispatchRef,
        order.sourcePoRef
      );
      releasedTargetRefs.push(...(order.poRouteProjection.targetRefs || []));
    }
  }
  return {
    projectUnallocatedPoRefs: [...new Set(purchaseOrderRefs.map(text).filter(Boolean))],
    releasedTargetRefs: [...new Set(releasedTargetRefs.map(text).filter(Boolean))]
  };
}

function projectedItemEvidence(item = {}) {
  return Object.fromEntries(PO_ITEM_PROJECTION_FIELDS
    .filter((field) => Object.prototype.hasOwnProperty.call(item, field))
    .map((field) => [field, item[field]]));
}

function relationshipProjectionEvidence(order = {}) {
  return {
    pickupLocations: order.pickupLocations || [],
    poPickupManifest: order.poPickupManifest || [],
    directPickupManifest: order.directPickupManifest || [],
    orderDependencies: order.orderDependencies || [],
    orderDependency: order.orderDependency || null,
    dependencyDirectPickup: order.dependencyDirectPickup ?? null,
    dependencyWaitingForTransfer: order.dependencyWaitingForTransfer ?? null,
    dependencyAttention: order.dependencyAttention ?? null,
    dependencyUncovered: order.dependencyUncovered ?? null,
    dependencyUncoveredQuantity: order.dependencyUncoveredQuantity ?? null,
    dependencyHidden: order.dependencyHidden ?? null,
    dependentSalesOrderRef: order.dependentSalesOrderRef || "",
    dependencyLabels: order.dependencyLabels || [],
    poRouteProjection: order.poRouteProjection || null,
    toRouteProjection: order.toRouteProjection || null,
    items: (order.items || []).map(projectedItemEvidence),
    childOrderDetails: (order.childOrderDetails || []).map(relationshipProjectionEvidence)
  };
}

function routeManifestEvidence(entries = []) {
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    location: text(entry?.location),
    address: text(entry?.address),
    sourceAddress: text(entry?.sourceAddress ?? entry?.source_address),
    pickupAddress: text(entry?.pickupAddress ?? entry?.pickup_address)
  }));
}

function routeMetadataProjectionEvidence(order = {}) {
  const dropoffs = Array.isArray(order.poRouteProjection?.dropoffs)
    ? order.poRouteProjection.dropoffs
    : [];
  return {
    poPickupManifest: routeManifestEvidence(order.poPickupManifest),
    directPickupManifest: routeManifestEvidence(order.directPickupManifest),
    poRouteDropoffs: dropoffs.map((dropoff) => ({
      key: text(dropoff?.key),
      destinationYard: text(dropoff?.destinationYard ?? dropoff?.destination_yard),
      address: text(dropoff?.address),
      defaultAddress: text(dropoff?.defaultAddress ?? dropoff?.default_address),
      destinationLocationId: text(
        dropoff?.destinationLocationId ?? dropoff?.destination_location_id
      )
    })),
    childOrderDetails: (order.childOrderDetails || []).map(routeMetadataProjectionEvidence)
  };
}

function orderByIdentity(orders = []) {
  return new Map((Array.isArray(orders) ? orders : [])
    .map((order) => [text(order?.id).toLowerCase(), order])
    .filter(([identity]) => identity));
}

function changedProjectionOrderRefs(beforeOrders = [], projectedOrders = []) {
  const projectedByRef = orderByIdentity(projectedOrders);
  const changed = [];
  for (const order of Array.isArray(beforeOrders) ? beforeOrders : []) {
    const ref = text(order?.id);
    const projected = projectedByRef.get(ref.toLowerCase());
    if (!ref || !projected) continue;
    if (stableJson(relationshipProjectionEvidence(order)) !== stableJson(relationshipProjectionEvidence(projected))) {
      changed.push(ref);
    }
  }
  return [...new Set(changed)];
}

function changedRouteMetadataOrderRefs(beforeOrders = [], projectedOrders = []) {
  const projectedByRef = orderByIdentity(projectedOrders);
  const changed = [];
  for (const order of Array.isArray(beforeOrders) ? beforeOrders : []) {
    const ref = text(order?.id);
    const projected = projectedByRef.get(ref.toLowerCase());
    if (!ref || !projected) continue;
    if (stableJson(routeMetadataProjectionEvidence(order)) !== stableJson(routeMetadataProjectionEvidence(projected))) {
      changed.push(ref);
    }
  }
  return [...new Set(changed)];
}

function affectedLogicalRefs(orders = [], changedOrderRefs = []) {
  const changed = new Set(changedOrderRefs.map((ref) => text(ref).toLowerCase()).filter(Boolean));
  const refs = [];
  for (const order of Array.isArray(orders) ? orders : []) {
    if (!changed.has(text(order?.id).toLowerCase())) continue;
    refs.push(...dispatchDependencyOrderRefs(order));
  }
  return [...new Set([...changedOrderRefs, ...refs].map(text).filter(Boolean))];
}

function allLogicalRefs(orders = []) {
  return [...new Set((Array.isArray(orders) ? orders : [])
    .flatMap((order) => dispatchDependencyOrderRefs(order))
    .map(text)
    .filter(Boolean))];
}

function stopTouchesAffectedOrder(stop = {}, affectedRefs = new Set()) {
  return [
    stop.orderId,
    stop.orderRef,
    ...(Array.isArray(stop.orderRefs) ? stop.orderRefs : []),
    ...(Array.isArray(stop.groupedOrderRefs) ? stop.groupedOrderRefs : []),
    ...(Array.isArray(stop.dependencyTargetRefs) ? stop.dependencyTargetRefs : [])
  ].map((value) => text(value).toLowerCase()).some((ref) => affectedRefs.has(ref));
}

export function invalidateLoadRoute(load = {}) {
  const next = { ...load, routeProjectionRefreshRequired: true };
  for (const field of INVALID_ROUTE_LOAD_FIELDS) delete next[field];
  next.stops = (Array.isArray(load.stops) ? load.stops : []).map((stop) => {
    const clean = { ...stop };
    for (const field of INVALID_ROUTE_STOP_FIELDS) delete clean[field];
    return clean;
  });
  return next;
}

function loadKey(load = {}, truckIndex = 0, loadIndex = 0) {
  return text(load.id || load.loadId) || `${truckIndex}:${loadIndex}`;
}

function physicalRouteEvidence(load = {}) {
  return (Array.isArray(load.stops) ? load.stops : []).map((stop) => ({
    id: text(stop.id || stop.stopId),
    type: text(stop.type || stop.stopType).toLowerCase(),
    orderId: text(stop.orderId || stop.orderRef),
    orderRefs: stop.orderRefs || [],
    groupedOrderRefs: stop.groupedOrderRefs || [],
    location: text(stop.location),
    dropLocation: text(stop.dropLocation ?? stop.drop_location),
    dropAddress: text(stop.dropAddress ?? stop.drop_address),
    dropoffKey: text(stop.dropoffKey ?? stop.dropoff_key),
    dependencyTargetRefs: stop.dependencyTargetRefs || []
  }));
}

function changedRouteLoadKeys(beforePlan = {}, afterPlan = {}) {
  const before = new Map();
  for (const [truckIndex, truck] of (beforePlan.trucks || []).entries()) {
    for (const [loadIndex, load] of (truck.loads || []).entries()) {
      before.set(loadKey(load, truckIndex, loadIndex), physicalRouteEvidence(load));
    }
  }
  const changed = new Set();
  for (const [truckIndex, truck] of (afterPlan.trucks || []).entries()) {
    for (const [loadIndex, load] of (truck.loads || []).entries()) {
      const key = loadKey(load, truckIndex, loadIndex);
      if (stableJson(before.get(key) || []) !== stableJson(physicalRouteEvidence(load))) changed.add(key);
    }
  }
  return changed;
}

function invalidateAffectedRoutes(plan = {}, affectedOrderRefs = [], changedLoadKeys = new Set()) {
  if (!affectedOrderRefs.length && !changedLoadKeys.size) return plan;
  const affected = new Set(affectedOrderRefs.map((ref) => text(ref).toLowerCase()).filter(Boolean));
  return {
    ...plan,
    trucks: (Array.isArray(plan.trucks) ? plan.trucks : []).map((truck, truckIndex) => ({
      ...truck,
      loads: (Array.isArray(truck.loads) ? truck.loads : []).map((load, loadIndex) => (
        changedLoadKeys.has(loadKey(load, truckIndex, loadIndex))
          || (load.stops || []).some((stop) => stopTouchesAffectedOrder(stop, affected))
          ? invalidateLoadRoute(load)
          : load
      ))
    }))
  };
}

function clearResolvedRouteRefreshFlags(plan = {}) {
  return {
    ...plan,
    trucks: (Array.isArray(plan.trucks) ? plan.trucks : []).map((truck) => ({
      ...truck,
      loads: (Array.isArray(truck.loads) ? truck.loads : []).map((load) => {
        if (load.routeProjectionRefreshRequired !== true || !load.routeEstimate) return load;
        const next = { ...load };
        delete next.routeProjectionRefreshRequired;
        return next;
      })
    }))
  };
}

/**
 * Merge a freshly read relationship projection and make the route match it.
 * The function is pure so the same invariant is exercised by unit/property
 * tests and the transactional repository boundary.
 */
export function reconcileAuthoritativeDispatchOrderProjection({
  plan = {},
  projectedOrders = [],
  comparisonOrders = plan.orders || [],
  preservedPoOrderRefs = new Set(),
  activity = []
} = {}) {
  const candidatePlan = clearResolvedRouteRefreshFlags(plan);
  const changedOrderRefs = changedProjectionOrderRefs(comparisonOrders, projectedOrders);
  const affectedOrderRefs = affectedLogicalRefs(projectedOrders, changedOrderRefs);
  const changedRouteMetadataRefs = changedRouteMetadataOrderRefs(comparisonOrders, projectedOrders);
  const routeMetadataAffectedRefs = affectedLogicalRefs(projectedOrders, changedRouteMetadataRefs);
  const reconciled = reconcileDependencyManagedPickups({
    plan: candidatePlan,
    enrichedOrders: projectedOrders,
    affectedTargetRefs: allLogicalRefs(projectedOrders),
    preservedPoOrderRefs,
    activity
  });
  const changedLoadKeys = changedRouteLoadKeys(candidatePlan, reconciled);
  return {
    plan: invalidateAffectedRoutes(reconciled, routeMetadataAffectedRefs, changedLoadKeys),
    changedOrderRefs,
    affectedOrderRefs,
    changedRouteMetadataRefs,
    changedLoadIds: [...changedLoadKeys]
  };
}

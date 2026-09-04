import assert from "node:assert/strict";
import test from "node:test";

import {
  dispatchRelationshipProjectionContext,
  reconcileAuthoritativeDispatchOrderProjection,
  stripDispatchRelationshipProjection,
  stripDispatchRelationshipProjections
} from "../../../src/dispatch-plan-order-projection.js";

const GROUP_REF = "GOB-118968-119023";
const TECHO = "TECHO BLOC Vaughan";

function manifest(location = TECHO) {
  return [{
    poOrderRef: "LOINC-030542",
    location,
    address: "720 Arrow Rd. North York, ON M9M 2M1",
    items: [{ itemId: "2055", sku: "MBBS-Special Order", quantity: 81.38 }]
  }];
}

function stalePlan() {
  return {
    id: "267",
    planDate: "2026-09-03",
    orders: [{
      id: GROUP_REF,
      type: "SO",
      sourceYard: "12441",
      pickupLocations: ["12441"],
      poPickupManifest: manifest(),
      childOrders: ["SOB118968", "SOB119023"],
      childOrderDetails: [{ id: "SOB118968" }, { id: "SOB119023" }]
    }],
    trucks: [{
      id: "BC71838",
      plate: "BC71838",
      loads: [{
        id: "dao-load-1",
        plannedStartMinute: 480,
        plannedFinishMinute: 620,
        routeEstimate: { routeSignature: "stale", totalMinutes: 140 },
        stops: [
          { id: "shared-12441", type: "pick", orderId: "SOB119213", location: "12441" },
          { id: "manual", type: "pick", location: "Oakville Stone", note: "dispatcher-entered" },
          { id: "gob-drop", type: "drop", orderId: GROUP_REF, location: "27 John Rolph St" }
        ]
      }]
    }]
  };
}

test("the current PO projection repairs the GOB route before its delivery", () => {
  const plan = stalePlan();
  const projectedOrders = [{
    ...plan.orders[0],
    pickupLocations: ["12441", TECHO],
    poPickupManifest: manifest()
  }];

  const result = reconcileAuthoritativeDispatchOrderProjection({ plan, projectedOrders });
  const order = result.plan.orders[0];
  const load = result.plan.trucks[0].loads[0];
  const techoIndex = load.stops.findIndex((stop) => stop.type === "pick" && stop.location === TECHO);
  const dropIndex = load.stops.findIndex((stop) => stop.id === "gob-drop");

  assert.deepEqual(order.pickupLocations, ["12441", TECHO]);
  assert.ok(techoIndex >= 0 && techoIndex < dropIndex, "Techo pickup must precede the GOB delivery");
  assert.equal(load.stops.find((stop) => stop.id === "manual")?.note, "dispatcher-entered");
  assert.equal(load.routeEstimate, undefined, "a route estimate for the old stop sequence cannot survive");
  assert.equal(load.routeProjectionRefreshRequired, true);
  assert.deepEqual(result.changedOrderRefs, [GROUP_REF]);

  assert.deepEqual(
    reconcileAuthoritativeDispatchOrderProjection({ plan: result.plan, projectedOrders }).plan,
    result.plan,
    "reapplying the same committed projection must be idempotent"
  );
});

test("unlink removes only the orphaned managed pickup", () => {
  const plan = stalePlan();
  plan.orders[0].pickupLocations = ["12441", TECHO];
  plan.trucks[0].loads[0].stops.splice(2, 0, {
    id: "managed-techo",
    type: "pick",
    orderId: GROUP_REF,
    location: TECHO,
    dependencyManaged: true,
    dependencyTargetRefs: [GROUP_REF]
  });
  const authoritative = [{
    ...stripDispatchRelationshipProjection(plan.orders[0]),
    pickupLocations: ["12441"]
  }];

  const result = reconcileAuthoritativeDispatchOrderProjection({
    plan,
    projectedOrders: authoritative
  }).plan;
  const stops = result.trucks[0].loads[0].stops;

  assert.deepEqual(result.orders[0].pickupLocations, ["12441"]);
  assert.equal(stops.some((stop) => stop.id === "managed-techo"), false);
  assert.equal(stops.find((stop) => stop.id === "manual")?.note, "dispatcher-entered");
});

test("projection stripping keeps a native source pickup even when a manifest shares it", () => {
  const stripped = stripDispatchRelationshipProjection({
    id: "SO-NATIVE",
    type: "SO",
    sourceYard: "Vendor Native",
    transitOriginalPickupLocations: ["Transit Native"],
    pickupLocations: ["Vendor Native", "Transit Native", "Allocated Native", TECHO],
    raw: {
      outbound_location: "Vendor Native",
      allocation_pickup_locations: ["Allocated Native"]
    },
    poPickupManifest: [...manifest("Vendor Native"), ...manifest(TECHO)],
    directPickupManifest: [{ location: TECHO }],
    items: [undefined, {
      itemId: "2055",
      dispatchServiceFee: true,
      poAllocatedSalesQty: 12,
      quantity: 12
    }]
  });

  assert.deepEqual(stripped.pickupLocations, ["Vendor Native", "Transit Native", "Allocated Native"]);
  assert.equal(stripped.poPickupManifest, undefined);
  assert.equal(stripped.directPickupManifest, undefined);
  assert.deepEqual(stripped.items[0], {});
  assert.equal(stripped.items[1].dispatchServiceFee, undefined);
  assert.equal(stripped.items[1].poAllocatedSalesQty, undefined);
  assert.equal(stripped.items[1].quantity, 12);
});

test("a current projection still repairs a missing pickup, then preserves a matching route estimate", () => {
  const plan = stalePlan();
  plan.orders[0].pickupLocations = ["12441", TECHO];
  const projectedOrders = [structuredClone(plan.orders[0])];

  const repaired = reconcileAuthoritativeDispatchOrderProjection({
    plan,
    projectedOrders,
    comparisonOrders: projectedOrders
  });
  assert.deepEqual(repaired.changedOrderRefs, []);
  assert.deepEqual(repaired.changedLoadIds, ["dao-load-1"]);
  assert.ok(repaired.plan.trucks[0].loads[0].stops.some((stop) => stop.location === TECHO));
  assert.equal(repaired.plan.trucks[0].loads[0].routeEstimate, undefined);

  const recalculated = structuredClone(repaired.plan);
  recalculated.trucks[0].loads[0].routeEstimate = {
    routeSignature: "current-techo-route",
    totalMinutes: 155
  };
  recalculated.trucks[0].loads[0].plannedFinishMinute = 635;
  const stable = reconcileAuthoritativeDispatchOrderProjection({
    plan: recalculated,
    projectedOrders,
    comparisonOrders: projectedOrders
  });

  assert.deepEqual(stable.changedOrderRefs, []);
  assert.deepEqual(stable.changedLoadIds, []);
  assert.equal(stable.plan.trucks[0].loads[0].routeEstimate.routeSignature, "current-techo-route");
  assert.equal(stable.plan.trucks[0].loads[0].plannedFinishMinute, 635);
  assert.equal(stable.plan.trucks[0].loads[0].routeProjectionRefreshRequired, undefined);
});

test("projection helpers preserve PO residual context and tolerate absent collections", () => {
  assert.deepEqual(stripDispatchRelationshipProjections(null), []);
  assert.deepEqual(dispatchRelationshipProjectionContext(null), {
    projectUnallocatedPoRefs: [],
    releasedTargetRefs: []
  });

  const context = dispatchRelationshipProjectionContext([
    {
      id: "PO-CURRENT",
      type: "po",
      originalPoRef: "PO-CURRENT",
      dispatchRef: "DSP-PO-CURRENT",
      sourcePoRef: "",
      poRouteProjection: { targetRefs: ["SO-1", "SO-1", ""] }
    },
    {
      id: "PO-WITHOUT-TARGETS",
      type: "PO",
      poRouteProjection: {}
    },
    { id: "SO-IGNORED", type: "SO", poRouteProjection: { targetRefs: ["SO-2"] } },
    null
  ]);

  assert.deepEqual(context, {
    projectUnallocatedPoRefs: ["PO-CURRENT", "DSP-PO-CURRENT", "PO-WITHOUT-TARGETS"],
    releasedTargetRefs: ["SO-1"]
  });
});

test("a changed projection invalidates timing even when its required stop is already present", () => {
  const plan = stalePlan();
  plan.orders[0].pickupLocations = ["12441", TECHO];
  plan.orders[0].items = [{
    itemId: "2055",
    quantity: 81.38,
    poAllocatedSalesQty: 40
  }];
  plan.trucks[0].loads.unshift({
    stops: [{ id: "unrelated", type: "drop", orderId: "SO-OTHER", timing: { arrive: 1 } }],
    routeEstimate: { routeSignature: "unrelated" }
  });
  const affectedLoad = plan.trucks[0].loads[1];
  affectedLoad.stops.splice(2, 0, {
    id: "manual-techo",
    type: "pick",
    location: TECHO,
    timing: { arrive: 500 },
    plannedArrival: "08:20"
  });
  affectedLoad.stops.at(-1).arriveTime = "10:00";
  delete affectedLoad.stops.at(-1).orderId;
  affectedLoad.stops.at(-1).orderRefs = [GROUP_REF];
  affectedLoad.stops.at(-1).groupedOrderRefs = ["SOB118968", "SOB119023"];
  affectedLoad.stops.at(-1).dependencyTargetRefs = [GROUP_REF];

  const projectedOrders = [{
    ...structuredClone(plan.orders[0]),
    poPickupManifest: manifest().map((entry) => ({ ...entry, address: "CURRENT ADDRESS" })),
    items: [{
      itemId: "2055",
      quantity: 81.38,
      poAllocatedSalesQty: 81.38
    }]
  }];
  const result = reconcileAuthoritativeDispatchOrderProjection({ plan, projectedOrders });
  const [unrelatedLoad, refreshedLoad] = result.plan.trucks[0].loads;

  assert.deepEqual(result.changedOrderRefs, [GROUP_REF]);
  assert.deepEqual(result.changedLoadIds, []);
  assert.equal(unrelatedLoad.routeEstimate.routeSignature, "unrelated");
  assert.deepEqual(unrelatedLoad.stops[0].timing, { arrive: 1 });
  assert.equal(refreshedLoad.routeProjectionRefreshRequired, true);
  assert.equal(refreshedLoad.routeEstimate, undefined);
  assert.equal(refreshedLoad.plannedFinishMinute, undefined);
  assert.equal(refreshedLoad.stops.find((stop) => stop.id === "manual-techo")?.timing, undefined);
  assert.equal(refreshedLoad.stops.find((stop) => stop.id === "manual-techo")?.plannedArrival, undefined);
  assert.equal(refreshedLoad.stops.at(-1).arriveTime, undefined);
});

test("pickup freshness preserves timing when an equivalent physical route already exists", () => {
  const plan = stalePlan();
  plan.trucks[0].loads[0].stops.splice(2, 0, {
    id: "shared-techo",
    type: "pick",
    orderId: "SO-OTHER",
    location: TECHO
  });
  const projectedOrders = [{
    ...structuredClone(plan.orders[0]),
    pickupLocations: ["12441", TECHO]
  }];

  const result = reconcileAuthoritativeDispatchOrderProjection({ plan, projectedOrders });
  const load = result.plan.trucks[0].loads[0];

  assert.deepEqual(result.changedOrderRefs, [GROUP_REF]);
  assert.deepEqual(result.changedRouteMetadataRefs, []);
  assert.deepEqual(result.changedLoadIds, []);
  assert.equal(load.routeEstimate.routeSignature, "stale");
  assert.equal(load.plannedFinishMinute, 620);
  assert.equal(load.routeProjectionRefreshRequired, undefined);
  assert.equal(load.stops.filter((stop) => stop.location === TECHO).length, 1);
});

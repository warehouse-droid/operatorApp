import assert from "node:assert/strict";
import test from "node:test";

import {
  dispatchLoadProtectedBoundary,
  dispatchRequiredPickupVisitLocations,
  insertDispatchLateOrder,
  materializeDispatchPickupVisits,
  resolveDispatchPickupVisit,
  splitDispatchPickupVisit,
  validateDispatchPickupVisits
} from "../../../src/dispatch-pickup-visits.js";

function order(id, location = "3445", address = `${id} customer`) {
  return {
    id,
    type: "SO",
    pickupLocations: [location],
    address,
    items: [{ lineRowId: `${id}-line`, pallets: 1 }]
  };
}

function pickup(id, refs, location = "3445", extra = {}) {
  return {
    id,
    loadId: "L",
    type: "pick",
    location,
    orderId: refs[0],
    orderRefs: refs,
    ...extra
  };
}

function drop(id, ref, extra = {}) {
  return { id, loadId: "L", type: "drop", orderId: ref, orderRefs: [ref], ...extra };
}

function plan(orders, stops, extra = {}) {
  return {
    id: "PLAN",
    planDate: "2026-09-03",
    pickupVisitSchemaVersion: 1,
    orders,
    trucks: [{ id: "T", driverLogin: "driver", loads: [{ id: "L", stops }] }],
    ...extra
  };
}

test("RP-06 previous authoritative allocations disambiguate a legacy repeat pickup", () => {
  const orders = [order("A"), order("B")];
  const previousPlan = plan(orders, [
    pickup("P-A", ["A"]),
    drop("D-A", "A"),
    pickup("P-B", ["B"]),
    drop("D-B", "B")
  ]);
  const legacy = plan(orders, [
    { id: "P-A", loadId: "L", type: "pick", location: "3445", orderId: "A" },
    drop("D-A", "A"),
    { id: "P-B", loadId: "L", type: "pick", location: "3445", orderId: "B" },
    drop("D-B", "B")
  ]);
  const result = materializeDispatchPickupVisits(legacy, { previousPlan });
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.plan.trucks[0].loads[0].stops.filter((stop) => stop.type === "pick")
    .map((stop) => stop.orderRefs), [["A"], ["B"]]);
  assert.equal(resolveDispatchPickupVisit({ plan: legacy, load: legacy.trucks[0].loads[0], stop: drop("D", "A") }).source, "not_pickup");
});

test("RP-06 malformed empty and unknown allocations fail closed", () => {
  const sourceOrder = order("A");
  const empty = plan([sourceOrder], [pickup("P", [], "3445", { orderId: "" }), drop("D", "A")]);
  assert.deepEqual(new Set(validateDispatchPickupVisits(empty).map((entry) => entry.code)), new Set([
    "DISPATCH_PICKUP_VISIT_EMPTY",
    "DISPATCH_PICKUP_ORDER_MISSING"
  ]));
  const unknown = plan([sourceOrder], [pickup("P", ["UNKNOWN"]), drop("D", "A")]);
  assert.deepEqual(new Set(validateDispatchPickupVisits(unknown).map((entry) => entry.code)), new Set([
    "DISPATCH_PICKUP_ORDER_NOT_IN_LOAD",
    "DISPATCH_PICKUP_ORDER_MISSING"
  ]));
  const returnOnly = plan([sourceOrder], [], {});
  returnOnly.trucks[0].loads[0].returnOnly = true;
  assert.deepEqual(validateDispatchPickupVisits(returnOnly), []);
});

test("RP-06 untouched legacy loads pass through saves, while opted-in loads fail closed", () => {
  const legacy = plan([order("A")], [pickup("P", [], "3445", { orderId: "" }), drop("D", "A")]);
  const passthrough = materializeDispatchPickupVisits(legacy, { allowLegacyPassthrough: true });
  assert.deepEqual(passthrough.conflicts, []);
  assert.deepEqual(passthrough.plan.trucks[0].loads[0].stops, legacy.trucks[0].loads[0].stops);
  assert.equal(passthrough.plan.pickupVisitSchemaVersion, 1);

  const optedIn = structuredClone(legacy);
  optedIn.trucks[0].loads[0].pickupVisitSchemaVersion = 1;
  const rejected = materializeDispatchPickupVisits(optedIn, { allowLegacyPassthrough: true });
  assert.ok(rejected.conflicts.some((entry) => entry.code === "DISPATCH_PICKUP_VISIT_EMPTY"));
});

test("RP-02 activity boundary accepts JSON metadata, legacy travel IDs, and fails safe for unknown physical stops", () => {
  const load = { id: "L", stops: [pickup("P1", ["A"]), pickup("P2", ["B"])] };
  assert.equal(dispatchLoadProtectedBoundary(load, [{
    loadId: "L",
    stopType: "travel",
    status: "in_progress",
    jobDetails: JSON.stringify({ toStopId: "P2" })
  }]), 1);
  assert.equal(dispatchLoadProtectedBoundary(load, [{
    load_id: "L",
    stop_id: "travel-P1-P2",
    stop_type: "travel",
    status: "in_progress",
    job_details: "{"
  }]), 1);
  assert.equal(dispatchLoadProtectedBoundary(load, [{
    load_id: "L",
    stop_id: "missing",
    stop_type: "pickup",
    status: "completed"
  }]), 1);
  assert.equal(dispatchLoadProtectedBoundary(load, [{
    load_id: "L",
    stop_id: "P2",
    stop_type: "travel",
    status: "complete"
  }, {
    load_id: "OTHER",
    stop_id: "P2",
    stop_type: "pickup",
    status: "complete"
  }]), -1);
});

test("RP-01 late-order insertion rejects invalid commands and creates opaque IDs without a factory", () => {
  const source = plan([order("A", "3445", "Same Customer")], [pickup("P", ["A"]), drop("D", "A")]);
  assert.throws(
    () => insertDispatchLateOrder({ plan: source, loadId: "missing", order: order("B") }),
    (error) => error.code === "DISPATCH_LOAD_NOT_FOUND"
  );
  assert.throws(
    () => insertDispatchLateOrder({ plan: source, loadId: "L", order: {} }),
    (error) => error.code === "DISPATCH_COMMAND_INVALID"
  );
  assert.throws(
    () => insertDispatchLateOrder({ plan: source, loadId: "L", order: order("A") }),
    (error) => error.code === "DISPATCH_ORDER_ALREADY_PLANNED"
  );
  const inserted = insertDispatchLateOrder({
    plan: source,
    loadId: "L",
    order: order("B", "3445", "Same Customer")
  });
  assert.match(inserted.dropStopId, /^stop-drop-/u);
  assert.deepEqual(validateDispatchPickupVisits(inserted.plan), []);
});

test("RP-01 a reusable future pickup receives its first representative order ID", () => {
  const source = plan([
    order("A", "3445", "A customer"),
    order("B", "3445", "B customer")
  ], [
    pickup("P", ["A"], "3445", { orderId: "" }),
    drop("D-A", "A")
  ]);
  const inserted = insertDispatchLateOrder({
    plan: source,
    loadId: "L",
    order: order("B", "3445", "B customer"),
    makeStopId: (kind) => `NEW-${kind}`
  });
  const pickupStop = inserted.plan.trucks[0].loads[0].stops.find((stop) => stop.id === "P");
  assert.equal(pickupStop.orderId, "B");
  assert.deepEqual(pickupStop.orderRefs, ["A", "B"]);
  assert.deepEqual(inserted.reusedPickupStopIds, ["P"]);
});

test("RP-04 manual split validates commands and can merge into one legal future pickup", () => {
  const source = plan([order("A"), order("B"), order("C")], [
    pickup("P0", ["A", "B"]),
    drop("D-A", "A"),
    pickup("P1", ["C"]),
    drop("D-B", "B"),
    drop("D-C", "C")
  ]);
  assert.throws(
    () => splitDispatchPickupVisit({ plan: source, loadId: "missing", stopId: "P0", orderRefs: ["B"] }),
    (error) => error.code === "DISPATCH_LOAD_NOT_FOUND"
  );
  assert.throws(
    () => splitDispatchPickupVisit({ plan: source, loadId: "L", stopId: "missing", orderRefs: ["B"] }),
    (error) => error.code === "DISPATCH_PICKUP_VISIT_NOT_FOUND"
  );
  for (const refs of [[], ["C"]]) {
    assert.throws(
      () => splitDispatchPickupVisit({ plan: source, loadId: "L", stopId: "P0", orderRefs: refs }),
      (error) => error.code === "DISPATCH_PICKUP_SPLIT_INVALID"
    );
  }
  assert.throws(
    () => splitDispatchPickupVisit({ plan: source, loadId: "L", stopId: "P0", orderRefs: ["B"], insertIndex: 0 }),
    (error) => error.code === "DISPATCH_PICKUP_SPLIT_POSITION_INVALID"
  );
  assert.throws(
    () => splitDispatchPickupVisit({ plan: source, loadId: "L", stopId: "P0", orderRefs: ["B"], targetStopId: "P0" }),
    (error) => error.code === "DISPATCH_PICKUP_SPLIT_TARGET_INVALID"
  );
  const merged = splitDispatchPickupVisit({
    plan: source,
    loadId: "L",
    stopId: "P0",
    orderRefs: ["B"],
    targetStopId: "P1"
  });
  const pickups = merged.plan.trucks[0].loads[0].stops.filter((stop) => stop.type === "pick");
  assert.deepEqual(pickups.map((stop) => stop.orderRefs), [["A"], ["C", "B"]]);
  assert.equal(merged.createdStopId, "");
  assert.equal(merged.targetStopId, "P1");
});

test("RP-01 required pickup locations include relationship yards once and preserve fallback order", () => {
  assert.deepEqual(dispatchRequiredPickupVisitLocations({
    sourceYard: "3445",
    poPickupManifest: [{ location: "Vendor A" }, { location: "vendor a" }],
    directPickupManifest: [{ location: "Vendor B" }, { location: "" }]
  }), ["3445", "Vendor A", "Vendor B"]);
  assert.deepEqual(dispatchRequiredPickupVisitLocations({ outboundLocation: "2967" }), ["2967"]);
  assert.deepEqual(dispatchRequiredPickupVisitLocations({}), ["3445"]);
});

test("RP-06 legacy aliases and sparse planner shapes normalize without losing allocation identity", () => {
  const legacyOrder = {
    orderId: "A",
    outboundLocation: "3445",
    childOrderDetails: [{ tranid: "A-CHILD", pickupLocations: ["2967"] }]
  };
  const legacyLoad = {
    load_id: "L",
    stops: [{
      stopId: "P",
      stopType: "pickup",
      yard: "3445"
    }, {
      stop_id: "D",
      stop_type: "delivery",
      orderRef: "A"
    }]
  };
  const legacyPlan = {
    orders: null,
    assignedOrderSnapshots: [legacyOrder],
    trucks: [{ loads: [legacyLoad] }]
  };
  const allocation = resolveDispatchPickupVisit({
    plan: legacyPlan,
    load: legacyLoad,
    stop: legacyLoad.stops[0]
  });
  assert.deepEqual(allocation.orderRefs, ["A"]);
  const normalized = materializeDispatchPickupVisits(legacyPlan);
  assert.deepEqual(normalized.conflicts, []);
  assert.deepEqual(normalized.plan.trucks[0].loads[0].stops[0].orderRefs, ["A"]);
  assert.deepEqual(materializeDispatchPickupVisits({ orders: [], trucks: [{ loads: null }] }).conflicts, []);
});

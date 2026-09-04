import assert from "node:assert/strict";
import test from "node:test";

import {
  dispatchExecutedStopFingerprint,
  dispatchLoadProtectedBoundary,
  insertDispatchLateOrder,
  materializeDispatchPickupVisits,
  resolveDispatchPickupVisit,
  splitDispatchPickupVisit,
  validateDispatchPickupVisits
} from "../../../src/dispatch-pickup-visits.js";
import { dispatchPhysicalStopVisits } from "../../../src/dispatch-load-assignment.js";
import { evaluateExecutedPrefixPolicy } from "../../../src/dispatch-planner-performance.js";

function order(id, {
  pickupLocations = ["3445"],
  address = `${id} customer`,
  pallets = 1,
  items = [{ lineRowId: `${id}-line`, pallets: 1 }],
  ...extra
} = {}) {
  return { id, type: "SO", pickupLocations, address, pallets, items, ...extra };
}

function planWith({ orders, stops }) {
  return {
    id: 71,
    planDate: "2026-09-02",
    revision: 8,
    pickupVisitSchemaVersion: 1,
    orders,
    trucks: [{
      id: "truck-1",
      plate: "TRUCK-1",
      driver: "Driver One",
      driverLogin: "driver-one",
      base: "3445",
      loads: [{ id: "load-1", name: "Load 1", stops }]
    }]
  };
}

function pickup(id, ref, location = "3445", extras = {}) {
  return { id, loadId: "load-1", type: "pick", location, orderId: ref, orderRefs: [ref], ...extras };
}

function drop(id, ref, location = "", extras = {}) {
  return { id, loadId: "load-1", type: "drop", orderId: ref, orderRefs: [ref], location, ...extras };
}

function activity(stopId, stopType, status = "complete", extras = {}) {
  return {
    load_id: "load-1",
    stop_id: stopId,
    stop_type: stopType,
    status,
    ...extras
  };
}

test("RP-01 normal automatic grouping keeps one unstarted pickup visit", () => {
  const first = order("SO-A", { address: "55 Customer Road, Milton" });
  const late = order("SO-B", { address: first.address });
  const source = planWith({
    orders: [first],
    stops: [pickup("pick-a", first.id), drop("drop-a", first.id)]
  });

  const result = insertDispatchLateOrder({
    plan: source,
    loadId: "load-1",
    order: late,
    activity: [],
    makeStopId: (kind) => `new-${kind}`
  });
  const load = result.plan.trucks[0].loads[0];
  assert.deepEqual(load.stops.map((stop) => stop.id), ["pick-a", "drop-a", "new-drop"]);
  assert.deepEqual(load.stops[0].orderRefs, ["SO-A", "SO-B"]);
  assert.equal(load.stops.filter((stop) => stop.type === "pick").length, 1);
  assert.deepEqual(validateDispatchPickupVisits(result.plan), []);
});

test("RP-02 a complete 3445 pickup plus active vendor travel creates a scoped revisit", () => {
  const first = order("SO-A", { address: "55 Customer Road, Milton" });
  const vendor = order("SO-VENDOR", {
    pickupLocations: ["Vendor Yard"],
    address: "77 Other Customer Road",
    directPickupManifest: [{ location: "Vendor Yard", transferOrderRef: "TO-VENDOR" }]
  });
  const late = order("SO-B", { address: first.address });
  const source = planWith({
    orders: [first, vendor],
    stops: [
      pickup("pick-a", first.id),
      pickup("pick-vendor", vendor.id, "Vendor Yard"),
      drop("drop-vendor", vendor.id),
      drop("drop-a", first.id)
    ]
  });
  const originalCompletedPickup = structuredClone(source.trucks[0].loads[0].stops[0]);
  const result = insertDispatchLateOrder({
    plan: source,
    loadId: "load-1",
    order: late,
    activity: [
      activity("pick-a", "pickup", "complete", { order_refs: ["SO-A"] }),
      activity("travel-pick-a-pick-vendor", "travel", "in_progress", {
        job_details: { fromStopId: "pick-a", toStopId: "pick-vendor" }
      })
    ],
    makeStopId: (kind) => `repeat-${kind}`
  });
  const load = result.plan.trucks[0].loads[0];
  assert.deepEqual(load.stops[0], originalCompletedPickup);
  assert.deepEqual(load.stops.map((stop) => stop.id), [
    "pick-a", "pick-vendor", "drop-vendor", "repeat-pick", "drop-a", "repeat-drop"
  ]);
  assert.deepEqual(load.stops.find((stop) => stop.id === "repeat-pick").orderRefs, ["SO-B"]);
  assert.equal(result.createdPickupStopIds.length, 1);
  assert.equal(result.reusedPickupStopIds.length, 0);
  assert.equal(dispatchLoadProtectedBoundary(load, [
    activity("travel-pick-a-pick-vendor", "travel", "in_progress", {
      job_details: { toStopId: "pick-vendor" }
    })
  ]), 1);
  assert.deepEqual(validateDispatchPickupVisits(result.plan), []);
});

test("RP-03 a completed matching delivery appends a second customer visit", () => {
  const first = order("SO-A", { address: "55 Customer Road, Milton" });
  const late = order("SO-B", { address: first.address });
  const source = planWith({
    orders: [first],
    stops: [pickup("pick-a", first.id), drop("drop-a", first.id)]
  });
  const result = insertDispatchLateOrder({
    plan: source,
    loadId: "load-1",
    order: late,
    activity: [
      activity("pick-a", "pickup"),
      activity("drop-a", "dropoff")
    ],
    makeStopId: (kind) => `second-${kind}`
  });
  assert.deepEqual(result.plan.trucks[0].loads[0].stops.map((stop) => stop.id), [
    "pick-a", "drop-a", "second-pick", "second-drop"
  ]);
  assert.equal(result.secondDeliveryVisit, true);
  assert.deepEqual(validateDispatchPickupVisits(result.plan), []);
});

test("RP-04 a five-order pickup splits into immutable whole-order 3+2 visits", () => {
  const refs = ["SO-1", "SO-2", "SO-3", "SO-4", "SO-5"];
  const sourceOrders = refs.map((ref) => order(ref, { address: `${ref} delivery` }));
  const source = planWith({
    orders: sourceOrders,
    stops: [
      pickup("pick-all", refs[0], "3445", { orderRefs: refs }),
      ...refs.map((ref) => drop(`drop-${ref}`, ref))
    ]
  });
  const itemsBefore = structuredClone(source.orders.map((entry) => entry.items));
  const result = splitDispatchPickupVisit({
    plan: source,
    loadId: "load-1",
    stopId: "pick-all",
    orderRefs: ["SO-4", "SO-5"],
    activity: [],
    makeStopId: () => "pick-later"
  });
  const stops = result.plan.trucks[0].loads[0].stops;
  assert.deepEqual(stops.map((stop) => stop.id), [
    "pick-all", "drop-SO-1", "drop-SO-2", "drop-SO-3", "pick-later", "drop-SO-4", "drop-SO-5"
  ]);
  assert.deepEqual(stops[0].orderRefs, ["SO-1", "SO-2", "SO-3"]);
  assert.deepEqual(stops[4].orderRefs, ["SO-4", "SO-5"]);
  assert.deepEqual(result.plan.orders.map((entry) => entry.items), itemsBefore);
  assert.deepEqual(validateDispatchPickupVisits(result.plan), []);
});

test("RP-04 manual split must leave one whole order in the original visit", () => {
  const source = planWith({
    orders: [order("SO-A"), order("SO-B")],
    stops: [
      pickup("pick-all", "SO-A", "3445", { orderRefs: ["SO-A", "SO-B"] }),
      drop("drop-a", "SO-A"),
      drop("drop-b", "SO-B")
    ]
  });
  assert.throws(
    () => splitDispatchPickupVisit({
      plan: source,
      loadId: "load-1",
      stopId: "pick-all",
      orderRefs: ["SO-A", "SO-B"],
      activity: []
    }),
    (error) => error.code === "DISPATCH_PICKUP_SPLIT_INVALID"
  );
});

test("RP-05 activity freezes structural pickup fields but ignores derived timing", () => {
  const source = planWith({
    orders: [order("SO-A")],
    stops: [pickup("pick-a", "SO-A"), drop("drop-a", "SO-A")]
  });
  const original = source.trucks[0].loads[0].stops[0];
  const timingOnly = { ...original, timing: { arrival: 700, depart: 740 }, plannedArrive: "11:40" };
  assert.equal(
    dispatchExecutedStopFingerprint(source, source.trucks[0].loads[0], original),
    dispatchExecutedStopFingerprint(source, source.trucks[0].loads[0], timingOnly)
  );
  for (const changed of [
    { ...original, location: "2967" },
    { ...original, orderRefs: ["SO-A", "SO-B"] },
    { ...original, type: "drop" }
  ]) {
    assert.notEqual(
      dispatchExecutedStopFingerprint(source, source.trucks[0].loads[0], original),
      dispatchExecutedStopFingerprint(source, source.trucks[0].loads[0], changed)
    );
  }

  assert.throws(
    () => splitDispatchPickupVisit({
      plan: source,
      loadId: "load-1",
      stopId: "pick-a",
      orderRefs: ["SO-A"],
      activity: [activity("pick-a", "pickup", "in_progress")]
    }),
    (error) => error.code === "DISPATCH_ACTIVE_LOAD_LOCKED"
  );
});

test("RP-05 active travel protects its destination while allowing work after it", () => {
  const source = planWith({
    orders: [order("SO-A"), order("SO-V", { pickupLocations: ["Vendor"] })],
    stops: [
      pickup("pick-a", "SO-A"),
      pickup("pick-v", "SO-V", "Vendor"),
      drop("drop-v", "SO-V"),
      drop("drop-a", "SO-A")
    ]
  });
  const activityRows = [activity("travel-pick-a-pick-v", "travel", "in_progress", {
    job_details: { fromStopId: "pick-a", toStopId: "pick-v" }
  })];
  const unsafe = structuredClone(source);
  unsafe.trucks[0].loads[0].stops.splice(1, 0, pickup("inserted-too-early", "SO-A"));
  assert.equal(evaluateExecutedPrefixPolicy({ previousPlan: source, nextPlan: unsafe, activity: activityRows }).allowed, false);

  const safe = structuredClone(source);
  safe.trucks[0].loads[0].stops.splice(2, 0, pickup("later", "SO-A"));
  assert.equal(evaluateExecutedPrefixPolicy({ previousPlan: source, nextPlan: safe, activity: activityRows }).allowed, true);
});

test("RP-06 one legacy pickup materializes while duplicate legacy pickups fail closed", () => {
  const source = planWith({
    orders: [order("SO-A"), order("SO-B")],
    stops: [
      { id: "legacy-pick", loadId: "load-1", type: "pick", location: "3445", orderId: "SO-A" },
      drop("drop-a", "SO-A"),
      drop("drop-b", "SO-B")
    ]
  });
  const migrated = materializeDispatchPickupVisits(source);
  assert.deepEqual(migrated.conflicts, []);
  assert.deepEqual(migrated.plan.trucks[0].loads[0].stops[0].orderRefs, ["SO-A", "SO-B"]);
  assert.deepEqual(migrated.migratedStopIds, ["legacy-pick"]);
  assert.deepEqual(resolveDispatchPickupVisit({
    plan: migrated.plan,
    load: migrated.plan.trucks[0].loads[0],
    stop: migrated.plan.trucks[0].loads[0].stops[0]
  }).orderRefs, ["SO-A", "SO-B"]);

  const ambiguous = structuredClone(source);
  ambiguous.trucks[0].loads[0].stops.splice(1, 0, {
    id: "legacy-pick-2",
    loadId: "load-1",
    type: "pick",
    location: "3445",
    orderId: "SO-B"
  });
  const rejected = materializeDispatchPickupVisits(ambiguous);
  assert.equal(rejected.conflicts[0].code, "DISPATCH_PICKUP_VISIT_AMBIGUOUS");
  assert.deepEqual(validateDispatchPickupVisits(ambiguous).map((entry) => entry.code), [
    "DISPATCH_PICKUP_VISIT_AMBIGUOUS",
    "DISPATCH_PICKUP_VISIT_AMBIGUOUS"
  ]);
});

test("invalid duplicate, missing, wrong-yard, and late allocations are rejected", () => {
  const orders = [order("SO-A")];
  const cases = [
    {
      expected: "DISPATCH_PICKUP_ORDER_DUPLICATE",
      stops: [pickup("p1", "SO-A"), pickup("p2", "SO-A"), drop("d1", "SO-A")]
    },
    {
      expected: "DISPATCH_PICKUP_ORDER_MISSING",
      stops: [drop("d1", "SO-A")]
    },
    {
      expected: "DISPATCH_PICKUP_ORDER_WRONG_YARD",
      stops: [pickup("p1", "SO-A", "2967"), drop("d1", "SO-A")]
    },
    {
      expected: "DISPATCH_PICKUP_AFTER_DELIVERY",
      stops: [drop("d1", "SO-A"), pickup("p1", "SO-A")]
    }
  ];
  for (const fixture of cases) {
    const conflicts = validateDispatchPickupVisits(planWith({ orders, stops: fixture.stops }));
    assert.ok(conflicts.some((entry) => entry.code === fixture.expected), JSON.stringify(conflicts));
  }
});

test("RP-08 timing and capacity footprints are scoped to each pickup occurrence", () => {
  const source = planWith({
    orders: [
      order("SO-A", { pallets: 3, items: [{ lineRowId: "A", pallets: 3 }] }),
      order("SO-B", { pallets: 2, items: [{ lineRowId: "B", pallets: 2 }] })
    ],
    stops: [
      pickup("pick-a", "SO-A"),
      drop("drop-a", "SO-A"),
      pickup("pick-b", "SO-B"),
      drop("drop-b", "SO-B")
    ]
  });
  const truck = source.trucks[0];
  const load = truck.loads[0];
  const pickupVisits = dispatchPhysicalStopVisits(source, truck, load)
    .filter((visit) => visit.type === "pick");
  assert.deepEqual(pickupVisits.map((visit) => visit.pallets), [3, 2]);
});

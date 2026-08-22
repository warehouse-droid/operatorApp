import assert from "node:assert/strict";
import test from "node:test";

import { reconcileDependencyManagedPickups } from "../../../src/scm-dependency-plan-reconciler.js";

test("pickup reconciliation adds required stops and removes only orphaned managed stops", () => {
  const plan = {
    id: "91",
    planDate: "2026-08-19",
    orders: [
      { id: "SO-A", type: "SO", pickupLocations: ["3445", "2967"] },
      { id: "SO-B", type: "SO", pickupLocations: ["2967"] }
    ],
    trucks: [{
      id: "truck-1",
      loads: [{
        id: "load-1",
        stops: [
          { id: "manual", type: "pick", location: "Vendor A", note: "dispatcher-entered" },
          {
            id: "managed-3445",
            type: "pick",
            location: "3445 Kennedy Road, Toronto, ON",
            dependencyManaged: true,
            dependencyTargetRefs: ["SO-A"]
          },
          {
            id: "managed-2967",
            type: "pick",
            location: "2967 Kennedy Road, Toronto, ON",
            dependencyManaged: true,
            dependencyTargetRefs: ["SO-A"]
          },
          { id: "drop-a", type: "drop", orderId: "SO-A", location: "Customer A" },
          { id: "drop-b", type: "drop", orderId: "SO-B", location: "Customer B" }
        ]
      }]
    }]
  };
  const enrichedOrders = [
    { id: "SO-A", type: "SO", pickupLocations: ["12441 Woodbine Avenue, Whitchurch-Stouffville, ON"] },
    { id: "SO-B", type: "SO", pickupLocations: ["2967 Kennedy Road, Toronto, ON"] }
  ];

  const next = reconcileDependencyManagedPickups({
    plan,
    enrichedOrders,
    affectedTargetRefs: ["SO-A"]
  });
  const stops = next.trucks[0].loads[0].stops;
  assert.equal(stops.find((stop) => stop.id === "manual")?.note, "dispatcher-entered");
  assert.equal(stops.some((stop) => stop.id === "managed-3445"), false);
  assert.equal(stops.some((stop) => stop.id === "managed-2967"), true, "shared pickup remains for SO-B");
  const insertedIndex = stops.findIndex((stop) => stop.dependencyManaged && /12441/.test(stop.location));
  const dropIndex = stops.findIndex((stop) => stop.id === "drop-a");
  assert.ok(insertedIndex >= 0 && insertedIndex < dropIndex, "new managed pickup precedes its drop");
  assert.deepEqual(stops[insertedIndex].dependencyTargetRefs, ["SO-A"]);
});

test("a matching manual or shared pickup is reused instead of duplicated", () => {
  const plan = {
    orders: [{ id: "SO-A", type: "SO", pickupLocations: [] }],
    trucks: [{ loads: [{ stops: [
      { id: "shared", type: "pick", location: "12441" },
      { id: "drop", type: "drop", orderId: "SO-A", location: "Customer" }
    ] }] }]
  };
  const next = reconcileDependencyManagedPickups({
    plan,
    enrichedOrders: [{ id: "SO-A", type: "SO", pickupLocations: ["12441 Woodbine Avenue"] }],
    affectedTargetRefs: ["SO-A"]
  });
  assert.equal(next.trucks[0].loads[0].stops.filter((stop) => stop.type === "pick").length, 1);
  assert.equal(next.trucks[0].loads[0].stops[0].id, "shared");
});

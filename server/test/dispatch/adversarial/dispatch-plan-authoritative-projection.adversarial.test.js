import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcileAuthoritativeDispatchOrderProjection,
  stripDispatchRelationshipProjection
} from "../../../src/dispatch-plan-order-projection.js";

test("a stale client cannot retain or inject a relationship-derived pickup", () => {
  const orderRef = "GOB-ADVERSARIAL";
  const stale = {
    id: orderRef,
    type: "SO",
    sourceYard: "12441",
    raw: { outbound_location: "12441" },
    pickupLocations: ["12441", "OBSOLETE VENDOR", "INJECTED VENDOR"],
    poPickupManifest: [
      { poOrderRef: "PO-OLD", location: "OBSOLETE VENDOR", items: [] },
      { poOrderRef: "PO-SPOOF", location: "INJECTED VENDOR", items: [] }
    ]
  };
  const stripped = stripDispatchRelationshipProjection(stale);
  const current = {
    ...stripped,
    pickupLocations: ["12441", "TECHO BLOC Vaughan"],
    poPickupManifest: [{
      poOrderRef: "LOINC-CURRENT",
      location: "TECHO BLOC Vaughan",
      address: "720 Arrow Rd. North York, ON M9M 2M1",
      items: []
    }]
  };
  const plan = {
    orders: [stale],
    trucks: [{ loads: [{ id: "adversarial-load", stops: [
      {
        id: "manual-techo",
        type: "pick",
        location: "TECHO BLOC Vaughan",
        note: "keep dispatcher evidence",
        operatorSequence: 17
      },
      { id: "drop", type: "drop", orderId: orderRef, location: "Customer" }
    ] }] }]
  };

  const result = reconcileAuthoritativeDispatchOrderProjection({
    plan,
    projectedOrders: [current]
  }).plan;
  const pickups = result.trucks[0].loads[0].stops.filter((stop) => stop.type === "pick");

  assert.deepEqual(result.orders[0].pickupLocations, ["12441", "TECHO BLOC Vaughan"]);
  assert.doesNotMatch(JSON.stringify(result), /OBSOLETE VENDOR|INJECTED VENDOR/u);
  assert.equal(pickups.filter((stop) => stop.location === "TECHO BLOC Vaughan").length, 1);
  assert.equal(pickups.find((stop) => stop.id === "manual-techo")?.note, "keep dispatcher evidence");
  assert.equal(pickups.find((stop) => stop.id === "manual-techo")?.operatorSequence, 17);
});
test("malformed optional projection fields fail safely without erasing the native yard", () => {
  const stripped = stripDispatchRelationshipProjection({
    id: "SO-MALFORMED",
    type: "SO",
    sourceYard: "12441",
    pickupLocations: ["12441"],
    poPickupManifest: { location: "not-an-array" },
    directPickupManifest: "not-an-array",
    items: null,
    childOrderDetails: null
  });

  assert.deepEqual(stripped.pickupLocations, ["12441"]);
  assert.deepEqual(stripped.items, []);
  assert.deepEqual(stripped.childOrderDetails, []);
  assert.equal(stripped.poPickupManifest, undefined);
  assert.equal(stripped.directPickupManifest, undefined);
});

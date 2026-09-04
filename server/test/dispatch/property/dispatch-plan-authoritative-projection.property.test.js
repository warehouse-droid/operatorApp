import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcileAuthoritativeDispatchOrderProjection,
  stripDispatchRelationshipProjection
} from "../../../src/dispatch-plan-order-projection.js";

const SEED = 20_260_903;

function pseudoRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function locations(random, minimum = 0) {
  const count = minimum + Math.floor(random() * (6 - minimum));
  const values = new Set();
  while (values.size < count) {
    values.add(`YARD${Math.floor(random() * 40)}`);
  }
  return [...values];
}

test("the final committed relationship projection wins over every stale pickup history", () => {
  const random = pseudoRandom(SEED);
  for (let run = 0; run < 300; run += 1) {
    const nativeLocations = locations(random, 1);
    const staleDerived = locations(random);
    const currentDerived = locations(random);
    const orderRef = "SO-PROPERTY-FRESH";
    const stale = {
      id: orderRef,
      type: "SO",
      sourceYard: nativeLocations[0],
      raw: { outbound_location: nativeLocations[0] },
      pickupLocations: [...new Set([...nativeLocations, ...staleDerived])],
      poPickupManifest: staleDerived.map((location, index) => ({
        poOrderRef: `PO-OLD-${index}`,
        location,
        items: []
      }))
    };
    const stripped = stripDispatchRelationshipProjection(stale);
    const finalLocations = [...new Set([...stripped.pickupLocations, ...currentDerived])];
    const projected = [{
      ...stripped,
      pickupLocations: finalLocations,
      poPickupManifest: currentDerived.map((location, index) => ({
        poOrderRef: `PO-NOW-${index}`,
        location,
        items: []
      }))
    }];
    const plan = {
      orders: [stale],
      trucks: [{ loads: [{ id: "load", stops: [
        { id: "drop", type: "drop", orderId: orderRef, location: "CUSTOMER" }
      ] }] }]
    };

    const result = reconcileAuthoritativeDispatchOrderProjection({ plan, projectedOrders: projected });
    const stops = result.plan.trucks[0].loads[0].stops;
    const dropIndex = stops.findIndex((stop) => stop.id === "drop");

    assert.deepEqual(result.plan.orders[0].pickupLocations, finalLocations);
    for (const location of finalLocations) {
      assert.ok(stops.findIndex((stop) => stop.type === "pick" && stop.location === location) < dropIndex);
    }
    assert.deepEqual(
      reconcileAuthoritativeDispatchOrderProjection({
        plan: result.plan,
        projectedOrders: projected
      }).plan,
      result.plan
    );
  }
});

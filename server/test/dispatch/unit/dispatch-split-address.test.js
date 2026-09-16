import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { cargoFunctions } from "../../support/sales-order-cargo-fixture.mjs";
import { compactDispatchOrderCard } from "../../../src/dispatch-planner-optimization.js";

const { applySplitDispatchDetails } = cargoFunctions("../../src/dispatch-delivery-group-repository.js", ["applySplitDispatchDetails", "text"]);
test("explicit details are idempotent, retain cargo and identity, and survive compact-card serialization", () => {
  fc.assert(fc.property(fc.string({ maxLength: 150 }), fc.string({ maxLength: 150 }),
    fc.integer({ min: 0, max: 100 }), (address, pickupAddress, pieces) => {
      const order = { id: "SOA08748-S2", originalOrderId: "SOA08748", type: "SO", address: "parent",
        defaultSourceAddress: "yard", pieces, items: [{ pieces }], dispatchDetailsOverride: {
          address, pickupAddress, windowStart: "08:00", windowEnd: "", expectedDeliveryDate: "2096-11-13" } };
      const before = structuredClone(order);
      const applied = applySplitDispatchDetails(order);
      for (const field of ["address", "destinationAddress", "defaultDestinationAddress"]) {assert.equal(applied[field], address.trim());}
      assert.equal(applied.sourceAddress, pickupAddress.trim() || "yard");
      assert.equal(applied.pieces, pieces);
      assert.equal(applied.id, order.id);
      assert.deepEqual(applied.items, order.items);
      assert.deepEqual(order, before);
      assert.deepEqual(applySplitDispatchDetails(applied), applied);
      const card = JSON.parse(JSON.stringify(compactDispatchOrderCard(applied)));
      assert.deepEqual(card.dispatchDetailsOverride, order.dispatchDetailsOverride);
      assert.equal(applySplitDispatchDetails(card).destinationAddress, address.trim());
    }), { seed: 8748, numRuns: 150 });
});

test("unmarked, partial, or malformed overrides preserve inherited fields", () => {
  for (const details of [undefined, null, [], "bad", 42]) {
    const order = { address: "parent", destinationAddress: "parent", dispatchDetailsOverride: details };
    assert.deepEqual(applySplitDispatchDetails(order), order);
  }
  const order = { address: "parent", destinationAddress: "parent", sourceAddress: "pickup", windowEnd: "10:00",
    dispatchDetailsOverride: { address: "" } };
  assert.deepEqual(applySplitDispatchDetails(order), { ...order, address: "", destinationAddress: "", defaultDestinationAddress: "" });
});

test("the refreshed split address produces two physical visits for Mossbrook and Heatherside", () => {
  const orders = [
    { id: "SOA08751", address: "94 Mossbrook Crescent", destinationAddress: "94 Mossbrook Crescent" },
    { id: "SOA08748-S1", address: "94 Mossbrook Crescent", destinationAddress: "94 Mossbrook Crescent" },
    applySplitDispatchDetails({ id: "SOA08748-S2", address: "94 Mossbrook Crescent", destinationAddress: "94 Mossbrook Crescent",
      dispatchDetailsOverride: { address: "76 Heatherside Dr" } })
  ];
  const route = cargoFunctions("../../public/dispatch.js", ["dropLocationForStop", "dropAddressForStop",
    "physicalDropVisitKey", "physicalVisitsForLoad", "consecutiveExactDropVisits"], {
    HUBS: {}, dispatchLocationHierarchyRoot: value => value, dropoffForStop: () => null,
    stopOrder: stop => orders.find(order => order.id === stop.orderId),
    stopAddress: (stop, order) => route.dropAddressForStop(stop, order), normalizedPlaceKey: value => value.toLowerCase() });
  const stops = orders.map(order => ({ id: `drop-${order.id}`, orderId: order.id, type: "drop" }));
  const before = structuredClone(stops);
  const visits = route.consecutiveExactDropVisits(stops);
  assert.equal(visits.length, 2);
  assert.deepEqual(visits.map(visit => visit.entries.map(entry => entry.order.id)), [["SOA08751", "SOA08748-S1"], ["SOA08748-S2"]]);
  assert.deepEqual(stops, before);
});

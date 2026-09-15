import assert from "node:assert/strict";
import test from "node:test";
import { sovBrowser } from "../../support/sov-dispatch-browser.mjs";
import { cargoFunctions } from "../../support/sales-order-cargo-fixture.mjs";
import { VOYAGE_DISPATCH_YARD } from "../../../src/dispatch-sales-order-locations.js";

const order = { id: "SOV02345", type: "SO", pickupLocations: ["195"], sourceYard: "195",
  address: "20 Test Customer Road", items: [{ itemId: 2836, itemType: "InvtPart", quantity: 39 }] };
const drop = { id: "drop", type: "drop", orderId: order.id, location: "195" };

test("SOV-11 browser creates the native pickup and resolves the Milner address", () => {
  const browser = sovBrowser([order], [drop]);
  browser.syncPickupStops();
  assert.deepEqual(browser.load.stops.map(stop => stop.type), ["pick", "drop"]);
  assert.deepEqual(browser.load.stops[0].orderRefs, [order.id]);
  const place = browser.resolveStopPlace(browser.load.stops[0], order);
  assert.equal(place.kind, "own");
  assert.equal(place.address, "195 Milner Ave Unit 5, Scarborough, ON M1S 4P4");
  assert.equal(place.routeLocation, place.address);
  const before = structuredClone(browser.load);
  browser.syncPickupStops();
  assert.deepEqual(browser.load, before);
});

test("SOV-12 browser never repairs before a started delivery or its active travel", () => {
  for (const record of [
    { stop_id: "drop", status: "in_progress", stop_type: "dropoff" },
    { stop_id: "drop", status: "complete", stop_type: "dropoff" },
    { stop_id: "travel", status: "in_progress", stop_type: "travel", job_details: { toStopId: "drop" } },
    { stop_id: "unknown-travel", status: "in_progress", stop_type: "travel" }
  ]) {
    // Use a known existing yard in RED too: this proves the activity guard
    // independently of whether the new Voyage catalog entry is installed.
    const native = { ...order, sourceYard: "3445", pickupLocations: ["3445"] };
    const browser = sovBrowser([native], [drop], [record]);
    browser.syncPickupStops();
    assert.deepEqual(browser.load.stops, [drop]);
  }
});

test("SOV-13 ordinary SO discovery includes Voyage without expanding other feeds", async () => {
  const calls = [];
  const record = family => async (location, options = {}) => {
    calls.push([family, location, options.orderType]);
    return {};
  };
  const api = cargoFunctions("../../src/server.js", ["syncDispatchOrderFeed"], {
    deliveryLocations: [1, 28, 15, 26], SALES_ORDER_SYNC_LOCATIONS: [1, 28, 15, 26, 4],
    assertDispatchSyncCanContinue: () => {},
    syncDeliveryLocation: record("delivery"),
    syncPurchaseReceiving: async options => calls.push(["purchase", options.locationId]),
    syncTransferReceiving: async options => calls.push(["receiving", options.destinationLocationId])
  });
  await api.syncDispatchOrderFeed();
  assert.deepEqual(calls.filter(call => call[2] === "sales_order").map(call => call[1]), [1, 28, 15, 26, 4]);
  assert.equal(calls.filter(call => call[1] === 4).length, 1);
  assert.equal(calls.filter(call => call[0] === "purchase").length, 4);
  assert.equal(calls.filter(call => call[2] === "transfer_order").length, 4);
});

test("SOV-23 dispatch projection maps Voyage's code and internal location ID", () => {
  const api = cargoFunctions("../../src/dispatch-repository.js", ["locationIdFromText", "locationTextFromId"], { VOYAGE_DISPATCH_YARD });
  assert.equal(api.locationIdFromText("195"), 4);
  assert.equal(api.locationTextFromId(4), "195");
});

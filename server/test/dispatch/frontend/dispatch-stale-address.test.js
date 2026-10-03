import assert from "node:assert/strict";
import fs from "node:fs";
import { compileFunction } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { cargoFunctions } from "../../support/sales-order-cargo-fixture.mjs";

const oldAddress = "39 Estoril St, Richmond Hill, ON L4C 0B6";
const newAddress = "145 Valleymede Dr, Richmond Hill, ON L4B 1T3";
const source = fs.readFileSync(new URL("../../../public/dispatch.js", import.meta.url), "utf8");

function saveAcknowledgement(order, payload, data) {
  // Execute the real successful-save callback, up to the existing merge boundary.
  const start = source.indexOf("saveDetails.then((payload) => {") + "saveDetails.then((payload) => {".length;
  const body = source.slice(start, source.indexOf("mergeTargetedDispatchMutationOrders(payload);", start));
  assert.ok(start > 30 && body.includes("pickupAddress"));
  const deps = { order, payload, data, windowStart: "08:00", windowEnd: "10:00",
    isPurchaseOrderDeliveryOverride: order.type === "PO" && order.sourceTable === "purchase_orders" };
  compileFunction(source.slice(0, start).replace(/[^\n\r]/gu, " ") + body, Object.keys(deps), {
    filename: fileURLToPath(new URL("../../../public/dispatch.js", import.meta.url))
  })(...Object.values(deps));
}

function visitsFor(orders, stops) {
  const functions = cargoFunctions("../../public/dispatch.js", [
    "dropLocationForStop", "dropAddressForStop", "physicalDropVisitKey", "physicalVisitsForLoad", "consecutiveExactDropVisits"
  ], { HUBS: {}, dispatchLocationHierarchyRoot: value => value,
    dropoffForStop: () => null, stopOrder: stop => orders.find(order => order.id === stop.orderId),
    stopAddress: (stop, order) => functions.dropAddressForStop(stop, order),
    normalizedPlaceKey: value => value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim() });
  return functions.consecutiveExactDropVisits(stops);
}

test("SA-1 the actual details acknowledgement separates Valleymede from Estoril", () => {
  const order = { id: "GOA-8353-8354", type: "SO", address: oldAddress, destinationAddress: oldAddress,
    defaultDestinationAddress: oldAddress, items: [{ itemId: 123, quantity: 2 }] };
  saveAcknowledgement(order, { updated: { dispatch_address: newAddress } }, { address: ` ${newAddress}` });
  for (const field of ["address", "destinationAddress", "defaultDestinationAddress"]) {assert.equal(order[field], newAddress);}
  const other = { id: "SOB120030", type: "SO", address: oldAddress, destinationAddress: oldAddress };
  const stops = [other, order].map(item => ({ id: item.id, orderId: item.id, type: "drop" }));
  assert.equal(visitsFor([order, other], stops).length, 2);
  assert.deepEqual(order.items, [{ itemId: 123, quantity: 2 }]);
  other.destinationAddress = newAddress;
  assert.equal(visitsFor([order, other], stops).length, 1);
});

test("SA-1 valid edits replace aliases and an empty acknowledgement preserves the known address", () => {
  for (const [payload, entered, expected] of [[{}, newAddress, newAddress], [{ updated: { dispatch_address: "" } }, oldAddress, oldAddress]]) {
    const order = { type: "SO", address: oldAddress, destinationAddress: oldAddress, defaultDestinationAddress: oldAddress };
    saveAcknowledgement(order, payload, { address: entered });
    for (const field of ["address", "destinationAddress", "defaultDestinationAddress"]) {assert.equal(order[field], expected);}
  }
});

test("SA-3 PO details keep pickup/destination projection until the targeted response is merged", () => {
  const order = { type: "PO", sourceTable: "purchase_orders", address: "Vendor pickup", destinationAddress: "Mapped yard" };
  saveAcknowledgement(order, { updated: { dispatch_address: newAddress } }, { address: newAddress });
  assert.equal(order.address, "Vendor pickup");
  assert.equal(order.destinationAddress, "Mapped yard");
});

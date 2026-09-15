import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import fc from "fast-check";
import { cargoFunctions } from "../../support/sales-order-cargo-fixture.mjs";

export const oldAddress = "39 Estoril St, Richmond Hill, ON L4C 0B6";
export const newAddress = "145 Valleymede Dr, Richmond Hill, ON L4B 1T3";
const member = (id, address) => ({ id, type: "SO", sourceTable: "sales_orders", address,
  destinationAddress: address, defaultDestinationAddress: address, pickupLocations: ["3445"],
  items: [{ itemId: 123, quantity: 2 }], pallets: 1 });
const group = (address = oldAddress) => ({ ...member("GOA-8353-8354", address), groupKey: "SOA08353",
  childOrders: ["SOA08353", "SOA08354"], childOrderDetails: [member("SOA08353", address), member("SOA08354", newAddress)] });

function aggregate(order, children) {
  const source = fs.readFileSync(new URL("../../../src/dispatch-delivery-group-repository.js", import.meta.url), "utf8");
  const names = ["text", "locationKey", "aggregateGlobalGroup"];
  if (source.includes("function groupedSalesOrderDeliveryFields(")) {names.push("groupedSalesOrderDeliveryFields");}
  return cargoFunctions("../../src/dispatch-delivery-group-repository.js", names).aggregateGlobalGroup(order, children);
}

test("SA-2 a source refresh repairs every grouped routing address", () => {
  const before = group();
  const result = aggregate(before, before.childOrderDetails.map(child => ({ ...child,
    address: newAddress, destinationAddress: newAddress, defaultDestinationAddress: newAddress })));
  for (const field of ["address", "destinationAddress", "defaultDestinationAddress"]) {assert.equal(result[field], newAddress);}
  assert.equal(before.address, oldAddress);
  assert.deepEqual(result.childOrders, before.childOrders);
  assert.deepEqual(result.items, before.childOrderDetails.flatMap(child => child.items));
});

test("SA-2 the reported mismatched group is repaired even when its members are already fresh", () => {
  const before = group(newAddress);
  before.address = ` ${newAddress}`;
  before.destinationAddress = oldAddress;
  before.defaultDestinationAddress = oldAddress;
  const result = aggregate(before, before.childOrderDetails);
  assert.equal(result.address, newAddress);
  assert.equal(result.destinationAddress, newAddress);
  assert.equal(result.defaultDestinationAddress, newAddress);
});

test("SA-2 reordered members retain their representative and manual group address", () => {
  const before = group();
  const children = [member("SOA08354", "9 Another Street"), member("SOA08353", newAddress)];
  assert.equal(aggregate(before, children).address, newAddress);
  before.address = "77 Manual Delivery Street";
  const manual = aggregate(before, children);
  assert.equal(manual.address, before.address);
  assert.equal(manual.destinationAddress, before.address);
  assert.equal(manual.defaultDestinationAddress, newAddress);
});

test("SA-3 clearing a source address cannot preserve the previous routing address", () => {
  const before = group();
  const result = aggregate(before, [member("SOA08353", ""), before.childOrderDetails[1]]);
  assert.equal(result.address, "");
  assert.equal(result.destinationAddress, "");
  assert.equal(result.defaultDestinationAddress, "");
});

test("SA-3 non-SO destination and direct CO cargo semantics are preserved", () => {
  for (const type of ["PO", "TO", "CO"]) {
    const before = { ...group(), type, sourceTable: type === "CO" ? "local_co_orders" : "purchase_orders", sourceOrderId: "SO-SOURCE" };
    const result = aggregate(before, [member("SOA08353", newAddress), before.childOrderDetails[1]]);
    assert.equal(result.destinationAddress, oldAddress);
    if (type === "CO") {assert.deepEqual(result, before);}
  }
  assert.equal(aggregate({ type: "SO", address: "manual" }, []).address, "manual");
});

test("SA-2 source projection is idempotent, immutable and preserves arbitrary explicit destinations", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 99999 }), fc.integer({ min: 1, max: 99999 }), (a, b) => {
    const before = group(`${a} Old Street`);
    const children = [member("SOA08353", `${b} New Street`), before.childOrderDetails[1]];
    const original = structuredClone({ before, children });
    const once = aggregate(before, children);
    assert.equal(once.address, children[0].address);
    assert.deepEqual(aggregate(once, children), once);
    assert.deepEqual({ before, children }, original);
    const manual = aggregate({ ...before, address: `${a} Manual Street` }, children);
    assert.equal(manual.destinationAddress, `${a} Manual Street`);
  }), { seed: 20260912, numRuns: 100 });
});

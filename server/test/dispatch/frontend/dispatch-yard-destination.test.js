import assert from "node:assert/strict";
import test from "node:test";
import { cargoFunctions } from "../../support/sales-order-cargo-fixture.mjs";
import { compactDispatchOrderCard } from "../../../src/dispatch-planner-optimization.js";

const { hasUsableDispatchAddress } = cargoFunctions("../../public/dispatch.js", ["hasUsableDispatchAddress"]);

test("SO deliveries to a yard remain valid in full orders and compact pool cards", () => {
  for (const address of [
    "2967 Kennedy Rd, Scarborough, ON M1V 1S9",
    "3445 Kennedy Road, Toronto, ON",
    "12441 Woodbine Avenue, Whitchurch-Stouffville, ON",
    "150 Clark Blvd, Brampton, ON L6T 4Y8",
    "145 Valleymede Dr, Richmond Hill, ON L4B 1T3"
  ]) {
    const order = { id: "SOA08768", type: "SO", address,
      pickupAddressOverride: "145 Valleymede Dr, Richmond Hill, ON L4B 1T3",
      parseSource: "manual-dispatch-details" };
    assert.equal(hasUsableDispatchAddress(order), true, address);
    assert.equal(hasUsableDispatchAddress(compactDispatchOrderCard(order)), true, `pool card: ${address}`);
    assert.equal(hasUsableDispatchAddress({ ...order, parseSource: "label-parser" }), true, `memo: ${address}`);
  }
});

test("a pickup address cannot substitute for a missing SO delivery address", () => {
  for (const address of [undefined, null, "", " \t\r\n "]) {
    assert.equal(hasUsableDispatchAddress({ type: "SO", address,
      pickupAddressOverride: "145 Valleymede Dr, Richmond Hill, ON L4B 1T3" }), false);
  }
});

test("the SO delivery-address check does not change other order types", () => {
  for (const type of ["PO", "TO", "CO", "VRMA", "CUSTOM"]) {
    assert.equal(hasUsableDispatchAddress({ type, address: "" }), true);
  }
});

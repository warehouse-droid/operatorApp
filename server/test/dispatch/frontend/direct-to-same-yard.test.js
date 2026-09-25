import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { dispatchPhysicalStopVisits, dispatchRequiredPickupLocations } from "../../../src/dispatch-load-assignment.js";
import { dispatchRequiredPickupVisitLocations, validateDispatchPickupVisits } from "../../../src/dispatch-pickup-visits.js";
import { pickupUi, orderFixture, routeFor } from "../../support/direct-to-same-yard-fixture.mjs";

const ui = pickupUi();
const quantity = (items, id) => items.filter(item => String(item.itemId) === String(id))
  .reduce((sum, item) => sum + Number(item.quantity || 0), 0);

test("SOA08838 pickup retains both CO cargo and the five TOB01102 Trevista layers", () => {
  const order = orderFixture();
  const before = structuredClone(order);
  const items = ui.tooltipItemsForOrder(order, { pickupLocation: "3445" });
  assert.equal(quantity(items, 1356), 52.25);
  assert.equal(quantity(items, 1193), 60);
  assert.equal(items.reduce((sum, item) => sum + Number(item.layers || 0), 0), 5);
  assert.equal(items.length, 2);
  assert.equal(ui.pickupWeightForOrderLocation(order, "3445"), 1374);
  assert.deepEqual(order, before);
});

for (const includeOrderHeader of [false, true]) {
  test(`pickup detail labels TOB01102 once and keeps SO rows (SO header ${includeOrderHeader})`, () => {
    const html = ui.tooltipItemRowsForOrder(orderFixture(), { pickupLocation: "3445", includeOrderHeader });
    assert.equal((html.match(/<b>TOB01102<\/b>/gu) || []).length, 1);
    assert.match(html, /For SOA08838/u);
    assert.equal((html.match(/<b>BWS-TRE50S-RDM-CAR<\/b>/gu) || []).length, 1);
    assert.match(html, /5 LYR/u);
    assert.match(html, /PACKED-SO-CARGO/u);
    assert.doesNotMatch(html, /Delivery Charge/u);
  });
}

test("a fully direct same-yard order has a pickup and footprint in browser and server", () => {
  const base = orderFixture();
  const order = { ...base, items: [base.items[0]], weight: 1254 };
  assert.deepEqual(ui.requiredPickupLocations(order), ["3445"]);
  assert.deepEqual(dispatchRequiredPickupLocations({}, order), ["3445"]);
  assert.deepEqual(dispatchRequiredPickupVisitLocations(order), ["3445"]);
  const { plan, truck, load } = routeFor(order);
  assert.equal(ui.pickupFootprintForOrderLocation(order, "3445"), 1);
  assert.equal(dispatchPhysicalStopVisits(plan, truck, load)[0].pallets, 1);
  assert.deepEqual(validateDispatchPickupVisits(plan), []);
  assert.equal(ui.pickupWeightForOrderLocation(order, "3445"), 1254);
});

test("fully direct detail has no empty SO heading and escapes its TO label", () => {
  const base = orderFixture();
  const order = { ...base, items: [base.items[0]], directPickupManifest: [
    { ...base.directPickupManifest[0], transferOrderRef: 'TO<unsafe>&"' }
  ] };
  const html = ui.tooltipItemRowsForOrder(order, { pickupLocation: "3445", includeOrderHeader: true });
  assert.match(html, /TO&lt;unsafe&gt;&amp;&quot;/u);
  assert.doesNotMatch(html, /<b>SOA08838<\/b>/u);
  assert.match(html, /5 LYR/u);
});

test("same-yard labels normalize sublocations without duplicating the direct quantity", () => {
  const order = orderFixture({ sourceYard: "3445 : Loading", pickupLocations: ["3445 : Loading", "3445"] });
  assert.equal(quantity(ui.tooltipItemsForOrder(order, { pickupLocation: "3445 : Storage" }), 1356), 52.25);
  assert.deepEqual(ui.requiredPickupLocations(order), ["3445 : Loading"]);
  assert.deepEqual(dispatchRequiredPickupLocations({}, order), ["3445 : Loading"]);
});

test("multiple TOs at the same yard appear alongside the unallocated SO remainder", () => {
  const order = orderFixture({
    items: [{ itemId: 1356, sku: "TREVISTA", itemType: "InvtPart", quantity: 100, pieces: 100, unit: "PC" }],
    directPickupManifest: [
      { transferOrderRef: "TO-A", location: "3445", items: [{ itemId: 1356, itemName: "TREVISTA", quantity: 20, pieceQty: 20 }] },
      { transferOrderRef: "TO-B", location: "3445", items: [{ itemId: 1356, itemName: "TREVISTA", quantity: 30, pieceQty: 30 }] },
      { transferOrderRef: "TO-C", location: "2967", items: [{ itemId: 1356, itemName: "TREVISTA", quantity: 10, pieceQty: 10 }] }
    ], pickupLocations: ["3445", "2967"]
  });
  const items = ui.tooltipItemsForOrder(order, { pickupLocation: "3445" });
  assert.deepEqual(items.map(item => item.quantity).sort((a, b) => a - b), [20, 30, 40]);
  assert.equal(quantity(items, 1356), 90);
  const html = ui.tooltipItemRowsForOrder(order, { pickupLocation: "3445", includeOrderHeader: true });
  for (const ref of ["SOA08838", "TO-A", "TO-B"]) {assert.match(html, new RegExp(`<b>${ref}</b>`, "u"));}
  assert.doesNotMatch(html, /TO-C/u);
  assert.match(html, /40 PCS/u);
  assert.equal(quantity(ui.tooltipItemsForOrder(order, { pickupLocation: "2967" }), 1356), 10);
});

test("drop detail retains the ordered quantity and no pickup-only TO header", () => {
  const order = orderFixture();
  const items = ui.tooltipItemsForOrder(order, { stop: { type: "drop" } });
  assert.equal(quantity(items, 1356), 52.25);
  assert.equal(quantity(items, 1193), 60);
  const html = ui.tooltipItemRowsForOrder(order, { stop: { type: "drop" }, includeOrderHeader: true });
  assert.match(html, /SOA08838/u);
  assert.doesNotMatch(html, /TOB01102|Delivery Charge/u);
});

test("separate-yard direct pickups and nonlinked SO pickups keep their existing scopes", () => {
  const base = orderFixture();
  const order = { ...base, sourceYard: "150", pickupLocations: ["150", "3445"] };
  assert.equal(quantity(ui.tooltipItemsForOrder(order, { pickupLocation: "150" }), 1356), 0);
  assert.equal(quantity(ui.tooltipItemsForOrder(order, { pickupLocation: "150" }), 1193), 60);
  assert.equal(quantity(ui.tooltipItemsForOrder(order, { pickupLocation: "3445" }), 1356), 52.25);
  assert.equal(quantity(ui.tooltipItemsForOrder(order, { pickupLocation: "3445" }), 1193), 0);
  assert.doesNotMatch(ui.tooltipItemRowsForOrder(order, { pickupLocation: "3445" }), /PACKED-SO-CARGO/u);
  const unlinked = { ...base, directPickupManifest: [] };
  assert.equal(quantity(ui.tooltipItemsForOrder(unlinked, { pickupLocation: "3445" }), 1356), 52.25);
  assert.doesNotMatch(ui.tooltipItemRowsForOrder(unlinked, { pickupLocation: "3445" }), /TOB01102/u);
});

test("generated allocations conserve pickup quantity, weight, and footprint across yards", () => {
  fc.assert(fc.property(fc.record({
    local: fc.integer({ min: 1, max: 500 }), remote: fc.integer({ min: 0, max: 500 }),
    residual: fc.integer({ min: 0, max: 500 }), itemWeight: fc.integer({ min: 1, max: 100 })
  }), ({ local, remote, residual, itemWeight }) => {
    const total = local + remote + residual;
    const order = orderFixture({
      items: [{ itemId: 1356, sku: "CARGO", itemType: "InvtPart", quantity: total, pallets: total, itemWeight }],
      pickupLocations: ["3445", "2967"],
      directPickupManifest: [
        { transferOrderRef: "TO-LOCAL", location: "3445", items: [{ itemId: 1356, itemName: "CARGO", quantity: local, palletQty: local, itemWeight }] },
        { transferOrderRef: "TO-REMOTE", location: "2967", items: [{ itemId: 1356, itemName: "CARGO", quantity: remote, palletQty: remote, itemWeight }] }
      ]
    });
    const here = ui.tooltipItemsForOrder(order, { pickupLocation: "3445" });
    const there = ui.tooltipItemsForOrder(order, { pickupLocation: "2967" });
    assert.equal(quantity(here, 1356), local + residual);
    assert.equal(quantity(there, 1356), remote);
    assert.equal(quantity(here, 1356) + quantity(there, 1356), total);
    assert.equal(ui.pickupWeightForOrderLocation(order, "3445"), (local + residual) * itemWeight);
    const { plan, truck, load } = routeFor(order);
    assert.equal(dispatchPhysicalStopVisits(plan, truck, load)[0].pallets, local + residual);
    assert.equal(ui.pickupFootprintForOrderLocation(order, "3445"), local + residual);
    const html = ui.tooltipItemRowsForOrder(order, { pickupLocation: "3445", includeOrderHeader: true });
    assert.match(html, /<b>TO-LOCAL<\/b>/u);
    assert.doesNotMatch(html, /TO-REMOTE/u);
  }), { seed: 88381102, numRuns: 150 });
});

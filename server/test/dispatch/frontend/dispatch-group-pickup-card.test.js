import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { pickupCardGroup, pickupCardPlanner } from "../../support/dispatch-group-pickup-card-fixture.mjs";

test("assignment refresh cannot invent a 3445 pickup from missing group member details", () => {
  const app = pickupCardPlanner(pickupCardGroup());
  assert.deepEqual(app.requiredPickupLocations(app.order()), ["2967"]);
  app.refresh();
  assert.deepEqual(app.requiredPickupLocations(app.order()), ["2967"]);
  assert.equal(app.order().childOrderDetails[0].sourceYard, "");
  assert.equal(app.order().childOrderDetails[0].catalogHydrated, false);
});

test("an explicitly configured 3445 group pickup remains required after assignment refresh", () => {
  const app = pickupCardPlanner(pickupCardGroup("3445"));
  app.refresh();
  assert.deepEqual(app.requiredPickupLocations(app.order()), ["3445"]);
});

test("missing group member details cannot replace the reported pallet total with zero", () => {
  const group = pickupCardGroup();
  group.pallets = 3;
  group.childOrderDetails[0].pallets = 3;
  group.items[0].pallets = 3;
  const app = pickupCardPlanner(group);
  assert.equal(app.order().pallets, 3);
  app.refresh();
  assert.equal(app.order().pallets, 3);
  assert.deepEqual(app.requiredPickupLocations(app.order()), ["2967"]);
});

test("real 3445 child cargo remains required when a group has another primary yard", () => {
  const group = pickupCardGroup();
  group.childOrderDetails[0].sourceYard = "3445";
  group.childOrderDetails[0].pickupLocations = ["3445"];
  group.pickupLocations.push("3445");
  const app = pickupCardPlanner(group, { compact: false });
  app.refresh();
  assert.deepEqual(app.requiredPickupLocations(app.order()), ["3445"]);
  assert.equal(app.order().childOrderDetails[0].sourceYard, "3445");
});

test("the existing 3445 default remains available to full legacy sales orders", () => {
  const app = pickupCardPlanner(pickupCardGroup());
  const legacy = app.normalizeOrder({ id: "SO-LEGACY", type: "SO", items: [{ sku: "PAVERS", quantity: 2, pieces: 2 }] });
  assert.equal(legacy.sourceYard, "3445");
  assert.deepEqual(app.requiredPickupLocations(legacy), ["3445"]);
});

test("property: compact-group assignment refresh preserves native pickups across yards and repeated refreshes", () => {
  fc.assert(fc.property(fc.constantFrom("3445", "2967", "12441", "150"), fc.integer({ min: 1, max: 4 }), (yard, count) => {
    const app = pickupCardPlanner(pickupCardGroup(yard));
    for (let index = 0; index < count; index += 1) { app.refresh(); }
    assert.deepEqual(app.requiredPickupLocations(app.order()), [yard]);
    assert.equal(app.order().sourceYard, yard);
  }), { seed: 99483445, numRuns: 40 });
});

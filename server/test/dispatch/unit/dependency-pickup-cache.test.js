import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { stripDispatchTransferDependencyProjection } from "../../../src/dispatch-plan-order-projection.js";

test("transfer cache cleanup preserves every independently required yard and is idempotent", () => {
  fc.assert(fc.property(fc.constantFrom("2967", "150", "12441"), fc.boolean(), fc.boolean(), fc.boolean(),
    (yard, nativeChild, poPickup, manifest) => {
      const child = { id: "SO-CHILD", sourceYard: nativeChild ? yard : "3445", pickupLocations: [yard],
        orderDependencies: [{ id: 300, mode: "direct_to_customer", sourceLocation: yard }],
        ...(manifest ? { directPickupManifest: [{ dependencyId: 300, location: yard }] } : {}),
        items: [{ quantity: 5, poAllocatedSalesQty: 2 }] };
      const source = { id: "GROUP", sourceYard: "3445", pickupLocations: ["3445", yard],
        childOrderDetails: [{ id: "NESTED", childOrderDetails: [child] }],
        ...(poPickup ? { poPickupManifest: [{ location: yard, items: [{ quantity: 2 }] }] } : {}),
        toRouteProjection: { hasResidual: false }, dependencyHidden: true };
      const original = structuredClone(source);
      const clean = stripDispatchTransferDependencyProjection(source);
      assert.deepEqual(clean.pickupLocations, nativeChild || poPickup ? ["3445", yard] : ["3445"]);
      assert.deepEqual(clean.poPickupManifest, source.poPickupManifest);
      const leaf = clean.childOrderDetails[0].childOrderDetails[0];
      assert.equal(leaf.orderDependencies, undefined);
      assert.equal(leaf.directPickupManifest, undefined);
      assert.deepEqual(leaf.items, child.items);
      assert.equal(clean.toRouteProjection, undefined);
      assert.equal(clean.dependencyHidden, undefined);
      assert.deepEqual(stripDispatchTransferDependencyProjection(clean), clean);
      assert.deepEqual(source, original);
    }), { numRuns: 120, seed: 1072410878 });
});

test("an order without a cached dependency keeps its pickup, PO projection and cargo", () => {
  const source = { id: "TO-NATIVE", type: "TO", pickupLocations: ["2967"], items: [{ quantity: 5 }],
    poRouteProjection: { items: [{ quantity: 2 }] }, po_route_projection: { version: 1 } };
  assert.deepEqual(stripDispatchTransferDependencyProjection(source), source);
});

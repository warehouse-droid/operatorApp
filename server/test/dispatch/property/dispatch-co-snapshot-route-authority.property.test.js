import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import { applyActiveLocalCoOrderRoute } from "../../../src/dispatch-co-lifecycle.js";

const YARDS = Object.freeze([
  { code: "3445", locationId: 1, address: "3445 Kennedy Road, Toronto, ON" },
  { code: "2967", locationId: 28, address: "2967 Kennedy Road, Toronto, ON" },
  { code: "12441", locationId: 15, address: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON" },
  { code: "150", locationId: 26, address: "150 Clark Blvd, Brampton, ON L6T 4Y8, Canada" }
]);

test("every active local CO route authoritatively repairs an immutable stale card", () => {
  fc.assert(fc.property(
    fc.integer({ min: 0, max: YARDS.length - 1 }),
    fc.integer({ min: 1, max: YARDS.length - 1 }),
    fc.integer({ min: 1, max: YARDS.length - 1 }),
    fc.constantFrom("pending_load", "loaded", "completed"),
    fc.uniqueArray(fc.stringMatching(/^SO[A-Z][0-9]{5}$/), { minLength: 1, maxLength: 5 }),
    (fromIndex, toOffset, staleOffset, status, childOrders) => {
      const from = YARDS[fromIndex];
      const to = YARDS[(fromIndex + toOffset) % YARDS.length];
      const stale = YARDS[(YARDS.indexOf(to) + staleOffset) % YARDS.length];
      const sourceOrderRef = "GOA-PROPERTY-CO-ROUTE";
      const coRef = `CO-${sourceOrderRef}`;
      const existing = {
        id: coRef,
        type: "CO",
        sourceYard: from.code,
        pickupLocations: [from.code],
        destinationYard: stale.code,
        destinationLocationId: stale.locationId,
        address: stale.address,
        destinationAddress: stale.address,
        childOrders,
        arbitraryPlanEvidence: { childOrders, keep: true }
      };
      const before = structuredClone(existing);
      const repaired = applyActiveLocalCoOrderRoute(existing, {
        coRef,
        sourceOrderRef,
        fromLocationId: from.locationId,
        fromYard: from.code,
        toLocationId: to.locationId,
        toYard: to.code,
        status
      });

      assert.equal(repaired.sourceYard, from.code);
      assert.deepEqual(repaired.pickupLocations, [from.code]);
      assert.equal(repaired.destinationYard, to.code);
      assert.equal(repaired.destinationLocationId, to.locationId);
      assert.equal(repaired.address, to.address);
      assert.equal(repaired.destinationAddress, to.address);
      assert.equal(repaired.sourceOrderId, sourceOrderRef);
      assert.equal(repaired.localYardOrderStatus, status);
      assert.deepEqual(repaired.childOrders, childOrders);
      assert.deepEqual(repaired.arbitraryPlanEvidence, existing.arbitraryPlanEvidence);
      assert.deepEqual(existing, before);
      assert.deepEqual(applyActiveLocalCoOrderRoute(repaired, {
        coRef,
        sourceOrderRef,
        fromLocationId: from.locationId,
        fromYard: from.code,
        toLocationId: to.locationId,
        toYard: to.code,
        status
      }), repaired);
    }
  ), { numRuns: 250 });
});

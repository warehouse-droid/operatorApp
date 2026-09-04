import assert from "node:assert/strict";
import { test } from "node:test";

import fc from "fast-check";

import { netSuiteDispatchSourceSnapshot } from "../../../src/dispatch-delivery-group-repository.js";
import {
  applyActiveTransitCoMetadata,
  clearCancelledTransitCoMetadata
} from "../../../src/dispatch-planner-performance.js";

const SEED = 20_260_901;
const RUNS = 500;
const YARDS = ["150", "2967", "3445", "12441"];
const VENDOR_PICKUPS = [
  "TECHO BLOC Vaughan",
  "Direct Vendor Yard",
  "PERMACON Milton",
  "Oakville Stone"
];

function nextDifferentYard(yard) {
  return YARDS[(YARDS.indexOf(yard) + 1) % YARDS.length];
}

test("NetSuite route refresh wins after an active CO is cancelled", () => {
  fc.assert(fc.property(
    fc.constantFrom(...YARDS),
    fc.constantFrom(...YARDS),
    fc.constantFrom(...YARDS),
    fc.uniqueArray(fc.constantFrom(...YARDS), { minLength: 0, maxLength: YARDS.length }),
    (previousYard, currentYard, candidateDestination, allocationYards) => {
      const destinationYard = candidateDestination === currentYard
        ? nextDifferentYard(currentYard)
        : candidateDestination;
      const staleOverlay = {
        id: "GOA-PROPERTY-FRESHNESS",
        type: "SO",
        sourceTable: "sales_orders",
        sourceYard: destinationYard,
        pickupLocations: [destinationYard],
        raw: {
          outbound_location: currentYard,
          allocation_pickup_locations: allocationYards
        },
        transitCo: {
          id: "CO-GOA-PROPERTY-FRESHNESS",
          fromYard: previousYard,
          toYard: destinationYard
        },
        transitOriginalPickupLocations: [previousYard],
        transitOriginalSourceYard: previousYard,
        arbitraryEvidence: { keep: true }
      };
      const expectedBase = [...new Set([currentYard, ...allocationYards])];

      const currentSource = netSuiteDispatchSourceSnapshot(staleOverlay);
      const active = applyActiveTransitCoMetadata(currentSource, [{
        coRef: staleOverlay.transitCo.id,
        sourceOrderRef: staleOverlay.id,
        fromYard: previousYard,
        toYard: destinationYard,
        status: "pending_load"
      }]);
      const restored = clearCancelledTransitCoMetadata(active, [{
        coRef: staleOverlay.transitCo.id,
        fromYard: previousYard,
        toYard: destinationYard
      }]);

      assert.deepEqual(currentSource.pickupLocations, expectedBase);
      assert.equal(currentSource.sourceYard, currentYard);
      assert.equal(currentSource.transitCo, null);
      assert.deepEqual(active.pickupLocations, [destinationYard]);
      assert.equal(active.sourceYard, destinationYard);
      assert.deepEqual(active.transitOriginalPickupLocations, expectedBase);
      assert.deepEqual(restored.pickupLocations, expectedBase);
      assert.equal(restored.sourceYard, currentYard);
      assert.equal(restored.transitCo, null);
      assert.deepEqual(restored.arbitraryEvidence, staleOverlay.arbitraryEvidence);
      assert.deepEqual(
        netSuiteDispatchSourceSnapshot(active),
        currentSource,
        "Repeated source reconciliation must be idempotent even with an active overlay."
      );
    }
  ), { seed: SEED, numRuns: RUNS });
});

test("active CO overlays preserve every current manifest-derived pickup", () => {
  fc.assert(fc.property(
    fc.constantFrom(...YARDS),
    fc.constantFrom(...YARDS),
    fc.uniqueArray(fc.constantFrom(...VENDOR_PICKUPS), { minLength: 0, maxLength: VENDOR_PICKUPS.length }),
    fc.integer({ min: 0, max: VENDOR_PICKUPS.length }),
    (sourceYard, candidateDestination, vendorPickups, poCountCandidate) => {
      const destinationYard = candidateDestination === sourceYard
        ? nextDifferentYard(sourceYard)
        : candidateDestination;
      const poCount = Math.min(poCountCandidate, vendorPickups.length);
      const poPickups = vendorPickups.slice(0, poCount);
      const directPickups = vendorPickups.slice(poCount);
      const order = {
        id: "GOB-PROPERTY-PO-CO",
        type: "SO",
        sourceYard,
        pickupLocations: [sourceYard, ...vendorPickups],
        poPickupManifest: poPickups.map((location, index) => ({
          poOrderRef: `LOINC-PROPERTY-${index}`,
          location
        })),
        directPickupManifest: directPickups.map((location, index) => ({
          dependencyId: index + 1,
          location
        }))
      };
      const active = [{
        coRef: "CO-GOB-PROPERTY-PO-CO",
        sourceOrderRef: order.id,
        fromYard: sourceYard,
        toYard: destinationYard,
        status: "pending_load"
      }];

      const hydrated = applyActiveTransitCoMetadata(order, active);

      assert.deepEqual(hydrated.pickupLocations, [destinationYard, ...vendorPickups]);
      assert.deepEqual(hydrated.transitOriginalPickupLocations, [sourceYard]);
      assert.deepEqual(applyActiveTransitCoMetadata(hydrated, active), hydrated);
    }
  ), { seed: SEED + 2, numRuns: RUNS });
});

test("the last simulated NetSuite refresh converges regardless of stale CO history", () => {
  fc.assert(fc.property(
    fc.array(fc.constantFrom(...YARDS), { minLength: 1, maxLength: 30 }),
    fc.constantFrom(...YARDS),
    (yardHistory, destinationYard) => {
      let order = {
        id: "SOA-PROPERTY-FRESHNESS",
        type: "SO",
        sourceTable: "sales_orders",
        sourceYard: yardHistory[0],
        pickupLocations: [yardHistory[0]],
        raw: { outbound_location: yardHistory[0] }
      };

      for (let index = 0; index < yardHistory.length; index += 1) {
        const yard = yardHistory[index];
        order = netSuiteDispatchSourceSnapshot({
          ...order,
          raw: { ...order.raw, outbound_location: yard }
        });
        if (index < yardHistory.length - 1) {
          order = applyActiveTransitCoMetadata(order, [{
            coRef: "CO-SOA-PROPERTY-FRESHNESS",
            sourceOrderRef: order.id,
            fromYard: yard,
            toYard: destinationYard
          }]);
        }
      }

      assert.deepEqual(order.pickupLocations, [yardHistory.at(-1)]);
      assert.equal(order.sourceYard, yardHistory.at(-1));
      assert.equal(order.transitCo, null);
    }
  ), { seed: SEED + 1, numRuns: RUNS });
});

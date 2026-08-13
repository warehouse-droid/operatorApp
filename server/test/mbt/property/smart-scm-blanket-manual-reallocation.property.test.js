import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";

import { planSmartScmBlanketManualReallocation } from "../../../src/smart-scm-blanket-repository.js";

test("manual Blanket reallocation conserves the open source ceiling for randomized competing loads", () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 200 }),
    fc.nat({ max: 1000 }),
    fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 0, maxLength: 12 }),
    (openPallets, requestedSeed, quantities) => {
      const requestedPallets = (requestedSeed % openPallets) + 1;
      const allocations = quantities.map((plannedPallets, index) => ({ id: index + 1, plannedPallets }));
      const result = planSmartScmBlanketManualReallocation({ openPallets, requestedPallets, allocations });
      const before = quantities.reduce((sum, quantity) => sum + quantity, 0);
      const after = result.allocations.reduce((sum, allocation) => sum + allocation.afterPallets, 0);
      const expectedReduction = Math.max(0, requestedPallets + before - openPallets);

      assert.equal(result.possible, true);
      assert.equal(result.reducedPallets, expectedReduction);
      assert.equal(before - after, expectedReduction);
      assert(requestedPallets + after <= openPallets,
        "The edited quantity plus every surviving sibling allocation must fit the open Blanket balance.");
      result.allocations.forEach((allocation, index) => {
        assert(allocation.afterPallets >= 0);
        assert(allocation.afterPallets <= quantities[index]);
        assert.equal(quantities[index] - allocation.afterPallets, allocation.reducedPallets);
      });
      assert.deepEqual(
        planSmartScmBlanketManualReallocation({ openPallets, requestedPallets, allocations }),
        result,
        "The same locked allocation order must always produce the same donors."
      );
    }
  ), { numRuns: 1000 });
});

test("manual Blanket reallocation refuses a target above the physical open balance", () => {
  fc.assert(fc.property(
    fc.integer({ min: 0, max: 200 }),
    fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 0, maxLength: 12 }),
    (openPallets, quantities) => {
      const result = planSmartScmBlanketManualReallocation({
        openPallets,
        requestedPallets: openPallets + 1,
        allocations: quantities.map((plannedPallets) => ({ plannedPallets }))
      });
      assert.equal(result.possible, false);
      assert.equal(result.reducedPallets, 0);
      assert.deepEqual(result.allocations.map((allocation) => allocation.afterPallets), quantities);
    }
  ), { numRuns: 500 });
});

test("manual Blanket reallocation rejects non-whole or zero targets", () => {
  for (const requestedPallets of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => planSmartScmBlanketManualReallocation({ openPallets: 40, requestedPallets }),
      /positive whole-pallet quantity/
    );
  }
});

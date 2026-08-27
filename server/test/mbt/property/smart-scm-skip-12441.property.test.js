import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";

import { smartScmBuild12441DemandProjection } from "../../../src/smart-scm-skip-12441.js";

test("randomized 12441 projections conserve every item's demand", () => {
  fc.assert(fc.property(
    fc.array(fc.record({
      itemId: fc.integer({ min: 1, max: 12 }),
      prefix: fc.constantFrom("SOB", "SOA", "SOM", "OTHER"),
      quantity: fc.integer({ min: 0, max: 100000 })
    }), { minLength: 1, maxLength: 120 }),
    (rows) => {
      const facts = rows.map((row, index) => ({
        itemId: row.itemId,
        locationId: 15,
        documentRef: `${row.prefix}-${index}`,
        deliveryMethod: "delivery",
        quantity: row.quantity,
        weekStart: "2026-08-03"
      }));
      const result = smartScmBuild12441DemandProjection({ enabled: true, facts });
      const expected = new Map();
      for (const row of facts) {
        expected.set(row.itemId, (expected.get(row.itemId) || 0) + row.quantity);
      }
      for (const [itemId, quantity] of expected) {
        const projected = result.facts
          .filter((row) => Number(row.itemId) === itemId)
          .reduce((sum, row) => sum + Number(row.quantity || 0), 0);
        assert.ok(Math.abs(projected - quantity) <= 0.000001, `${itemId}: ${projected} != ${quantity}`);
      }
      assert.equal(result.facts.some((row) => Number(row.locationId) === 15), false);
      assert.equal(result.facts.every((row) => [1, 28].includes(Number(row.locationId))), true);
    }
  ), { numRuns: 1000 });
});

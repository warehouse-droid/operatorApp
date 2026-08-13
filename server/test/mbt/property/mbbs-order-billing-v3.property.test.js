import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import { calculateMbbsCrossCharges } from "../../../src/mbt/local-billing-calculator.js";

test("S5/S9 property: 300 custom-order batches retain one exact-cent case per unique physical load", () => {
  fc.assert(fc.property(
    fc.uniqueArray(fc.record({
      key: fc.uuid(),
      amountMinor: fc.integer({ min: 0, max: 10_000_000 }),
      calculatedMetres: fc.integer({ min: 0, max: 2_000_000 })
    }), { minLength: 1, maxLength: 20, selector: (entry) => entry.key }),
    (entries) => {
      const loads = entries.map((entry) => ({
        physicalLoadId: `CUSTOM-LOAD-${entry.key}`,
        completedAt: "2039-07-11T16:00:00.000Z",
        planDate: "2039-07-11",
        calculatedMetres: entry.calculatedMetres,
        sharedTotalMinor: entry.amountMinor,
        references: [{ sourceType: "CUSTOM", rootReference: `CUSTOM-${entry.key}` }]
      }));
      const result = calculateMbbsCrossCharges({ currency: "CAD", loads });
      assert.equal(result.cases.length, entries.length);
      assert.equal(result.allocationGroups.length, 0);
      assert.equal(new Set(result.cases.map((entry) => entry.deduplicationKey)).size, entries.length);
      const expectedByLoad = new Map(loads.map((entry) => [entry.physicalLoadId, entry.sharedTotalMinor]));
      for (const calculatedCase of result.cases) {
        assert.equal(calculatedCase.sourceType, "CUSTOM");
        assert.equal(calculatedCase.allocatedAmountMinor, expectedByLoad.get(calculatedCase.physicalLoadId));
        assert.equal(
          calculatedCase.deduplicationKey,
          `CUSTOM|${calculatedCase.rootReference}|${calculatedCase.physicalLoadId}`
        );
      }
    }
  ), { numRuns: 300 });
});

// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { calculateDistanceBandChargeMinor } from "../../../src/mbt/distance-band-pricing.js";
import { calculateMbbsCrossCharges } from "../../../src/mbt/local-billing-calculator.js";

const EXCESS_BAND = Object.freeze({
  pricingBasis: "per_km",
  amountMinor: 700,
  baseAmountMinor: 38_500,
  includedMetres: 75_000
});

/** @param {number} seed */
function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = ((state * 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

test("base-plus-excess distance pricing is exact, monotone, and charges no included metres", () => {
  const next = generator(0x20260820);
  let priorDistance = 75_000;
  let priorAmount = calculateDistanceBandChargeMinor(EXCESS_BAND, priorDistance);
  assert.equal(priorAmount, 38_500);

  const distances = Array.from({ length: 1_000 }, () => 75_001 + (next() % 2_000_000))
    .sort((left, right) => left - right);
  for (const distanceMetres of distances) {
    const expected = 38_500 + Math.floor((((distanceMetres - 75_000) * 700) + 500) / 1000);
    const actual = calculateDistanceBandChargeMinor(EXCESS_BAND, distanceMetres);
    assert.equal(actual, expected);
    assert.ok(distanceMetres >= priorDistance);
    assert.ok(actual >= priorAmount);
    priorDistance = distanceMetres;
    priorAmount = actual;
  }
});

test("every shared multi-drop TO allocation conserves the single charge to the cent", () => {
  const next = generator(0x53544f50);
  for (let iteration = 0; iteration < 250; iteration += 1) {
    const referenceCount = 2 + (next() % 19);
    const totalMinor = next() % 2_000_001;
    const references = Array.from({ length: referenceCount }, (_, index) => ({
      sourceType: "TO",
      rootReference: `TO-PROPERTY-${iteration}-${String(index).padStart(2, "0")}`
    }));
    const result = calculateMbbsCrossCharges({
      currency: "CAD",
      loads: [{
        physicalLoadId: `PROPERTY-LOAD-${iteration}`,
        completedAt: "2026-08-18T22:17:18.674Z",
        planDate: "2026-08-18",
        calculatedMetres: next() % 500_000,
        sharedTotalMinor: totalMinor,
        billingEvidence: { billingRule: "to_replenishment_multi_drop" },
        references: iteration % 2 === 0 ? references : references.toReversed()
      }]
    });

    assert.equal(result.cases.length, referenceCount);
    assert.equal(result.allocationGroups.length, 1);
    assert.equal(
      result.cases.reduce((sum, entry) => sum + entry.allocatedAmountMinor, 0),
      totalMinor
    );
    assert.ok(result.cases.every((entry) => entry.allocatedAmountMinor >= 0));
    const amounts = result.cases.map((entry) => entry.allocatedAmountMinor);
    assert.ok(Math.max(...amounts) - Math.min(...amounts) <= 1);
  }
});

test("ordinary TO references retain independent full-route charging semantics", () => {
  const result = calculateMbbsCrossCharges({
    currency: "CAD",
    loads: [{
      physicalLoadId: "INDEPENDENT-TO-LOAD",
      completedAt: "2026-08-18T22:17:18.674Z",
      sharedTotalMinor: 33_500,
      references: [
        { sourceType: "TO", rootReference: "TO-INDEPENDENT-A" },
        { sourceType: "TO", rootReference: "TO-INDEPENDENT-B" }
      ]
    }]
  });
  assert.deepEqual(result.cases.map((entry) => entry.allocatedAmountMinor), [33_500, 33_500]);
  assert.equal(result.allocationGroups.length, 0);
});

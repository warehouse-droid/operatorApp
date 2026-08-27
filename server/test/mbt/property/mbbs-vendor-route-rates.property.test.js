// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";

import {
  calculateMbbsPurchaseRouteAmount,
  selectMbbsVendorRouteRate
} from "../../../src/mbt/mbbs-vendor-route-rates.js";

/** @param {number} additionalStopUnitAmountMinor @param {2 | 3} schemaVersion */
function policy(additionalStopUnitAmountMinor, schemaVersion) {
  return {
    schemaVersion,
    currency: "CAD",
    poVrmaAdditionalStopUnitAmountMinor: additionalStopUnitAmountMinor
  };
}

/** @param {{localVendorId: number, baseAmountMinor: number, vendorYardName?: string}} input */
function rate({ localVendorId, baseAmountMinor, vendorYardName = "Generated vendor yard" }) {
  return {
    rateName: "Generated vendor route",
    displayName: "Generated vendor route",
    localVendorId,
    localVendorName: "Generated vendor",
    vendorYardName,
    vendorYardAddress: "1 Generated Road, Toronto, ON",
    destinationYardCode: "12441",
    baseAmountMinor,
    currency: "CAD"
  };
}

test("M3-M4 property: schemas 2 and 3 each conserve exact cents across 1,000 generated PO/VRMA routes", () => {
  for (const schemaVersion of /** @type {const} */ ([2, 3])) {
    fc.assert(fc.property(
      fc.constantFrom("vendor_yard_flat", "distance_band"),
      fc.integer({ min: 0, max: 10_000_000 }),
      fc.integer({ min: 0, max: 1_000_000 }),
      fc.integer({ min: 2, max: 100 }),
      (pricingMethod, baseAmountMinor, additionalStopUnitAmountMinor, routeStopCount) => {
        const result = calculateMbbsPurchaseRouteAmount({
          pricingMethod,
          vendorRouteAmountMinor: pricingMethod === "vendor_yard_flat" ? baseAmountMinor : 0,
          distanceBandAmountMinor: pricingMethod === "distance_band" ? baseAmountMinor : 0,
          routeStopCount,
          mbbsChargingPolicy: policy(additionalStopUnitAmountMinor, schemaVersion)
        });
        const expectedAdditionalStopCount = routeStopCount - 2;
        const expectedAdditionalStopFeeMinor = expectedAdditionalStopCount * additionalStopUnitAmountMinor;
        assert.equal(result.baseAmountMinor, baseAmountMinor);
        assert.equal(result.additionalStopCount, expectedAdditionalStopCount);
        assert.equal(result.additionalStopFeeMinor, expectedAdditionalStopFeeMinor);
        assert.equal(result.calculatedAmountMinor, baseAmountMinor + expectedAdditionalStopFeeMinor);
        assert.ok(Number.isSafeInteger(result.calculatedAmountMinor));
      }
    ), { numRuns: 1_000 });
  }
});

test("M2-M3 property: 1,000 generated exact pairs are direction-symmetric and partial yard names never match", () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 2_000_000_000 }),
    fc.integer({ min: 0, max: 10_000_000 }),
    fc.stringMatching(/^[A-Za-z0-9]{1,20}$/u),
    (localVendorId, baseAmountMinor, suffix) => {
      const vendorYardName = `Generated Yard ${suffix}`;
      const rates = [rate({ localVendorId, baseAmountMinor, vendorYardName })];
      const identity = {
        localVendorId,
        vendorYardName: `  ${vendorYardName.toUpperCase()}  `,
        vendorYardAliases: [],
        mbbsYardCode: "12441"
      };
      const purchase = selectMbbsVendorRouteRate(rates, { ...identity, sourceType: "PO" });
      const returnAuthorization = selectMbbsVendorRouteRate(rates, { ...identity, sourceType: "VRMA" });
      assert.equal(purchase?.baseAmountMinor, baseAmountMinor);
      assert.deepEqual(returnAuthorization, purchase);
      assert.equal(selectMbbsVendorRouteRate(rates, {
        ...identity,
        sourceType: "PO",
        vendorYardName: vendorYardName.slice(0, -1),
        vendorYardAliases: []
      }), null);
    }
  ), { numRuns: 1_000 });
});

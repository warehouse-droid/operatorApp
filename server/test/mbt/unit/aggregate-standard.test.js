// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { calculateCustomerCharge } from "../../../src/mbt/customer-charge-calculator.js";
import { normalizeLocalMasterDataRow } from "../../../src/mbt/local-master-data-service.js";

function aggregateItem(densityLbsPerYard) {
  return { itemCode: "GRAVEL", displayName: "Gravel", description: "", itemType: "aggregate",
    chargeBasis: "per_yard", densityLbsPerYard, rentalPeriodDays: null,
    applicableServiceTypes: ["delivery"], applicableLegacySourceTypes: [],
    binTypeCode: null, netSuiteMappingLocalKey: null, active: true };
}

function charge(itemCode, quantityMilliYards = 2000, densityLbsPerYard = 2600) {
  return { kind: "aggregate_order", paymentMethod: "cash", currentContractTotalMinor: 0,
    orderFrom150: true, currency: "CAD", taxRateBasisPoints: 1300,
    aggregateLines: [{ itemCode, displayName: "Gravel", quantityMilliYards, unitAmountMinor: 6000, densityLbsPerYard }],
    aggregateDistanceBands: [{ bandCode: "AGG_0_30", minimumMetres: 0, maximumMetres: 30000, amountMinor: 15000 }],
    distanceMetres: 10000, loadingFeeMinor: 5000 };
}

test("aggregate density is automatic for missing, null, and historical values", () => {
  for (const density of [undefined, null, 1300, 2750]) {
    const normalized = normalizeLocalMasterDataRow("local_items", aggregateItem(density));
    assert.equal(normalized.densityLbsPerYard, 2600);
  }
});

test("configured GRAVEL calculates CAD 120 and 5200 lb for two cubic yards", () => {
  const result = calculateCustomerCharge(charge("GRAVEL"));
  const material = result.lines.find((line) => line.lineType === "aggregate_material");
  assert.equal(material.itemCode, "GRAVEL");
  assert.equal(material.configuredAmountMinor, 12000);
  assert.equal(material.derivedWeightLbs, 5200);
});

test("local aggregate codes and fractional quantities preserve exact price and weight arithmetic", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 1000000 }), fc.integer({ min: 0, max: 999999 }), (quantity, suffix) => {
    const result = calculateCustomerCharge(charge(`GRAVEL_${suffix}`, quantity));
    const material = result.lines.find((line) => line.lineType === "aggregate_material");
    assert.equal(material.configuredAmountMinor, quantity * 6);
    assert.equal(material.derivedWeightLbs, Math.round(quantity * 2600 / 1000));
  }), { numRuns: 100, seed: 2600 });
});

test("aggregate identities reject punctuation, oversized codes, and duplicates", () => {
  for (const code of ["", "_GRAVEL", "GRAVEL-1", "GRAVEL'", "G".repeat(65)]) {
    assert.throws(() => calculateCustomerCharge(charge(code)), { code: "MBT_CHARGE_AGGREGATE_INVALID" });
  }
  const input = charge("GRAVEL");
  input.aggregateLines.push({ ...input.aggregateLines[0] });
  assert.throws(() => calculateCustomerCharge(input), { code: "MBT_CHARGE_AGGREGATE_INVALID" });
});

test("explicit historical density can still replay a previously captured charge", () => {
  const result = calculateCustomerCharge(charge("AGG_LEGACY", 2000, 2750));
  const material = result.lines.find((line) => line.lineType === "aggregate_material");
  assert.equal(material.configuredAmountMinor, 12000);
  assert.equal(material.derivedWeightLbs, 5500);
});

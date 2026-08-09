// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import { calculateCustomerCharge } from "../../../src/mbt/customer-charge-calculator.js";

/** @param {number} amountMinor @param {number} numerator @param {number} denominator */
function roundedRatio(amountMinor, numerator, denominator) {
  return Number((BigInt(amountMinor) * BigInt(numerator) + (BigInt(denominator) / 2n)) / BigInt(denominator));
}

/** @param {Record<string, any>} input */
function configuredPositiveLines(input) {
  return input.lines.filter((line) => line.configuredAmountMinor >= 0);
}

test("customer-charge property: cash extracts HST while non-cash adds HST exactly once (1,000 cases)", () => {
  fc.assert(fc.property(
    fc.integer({ min: 0, max: 1_000_000 }),
    fc.integer({ min: 0, max: 1_000_000 }),
    fc.integer({ min: 0, max: 100_000 }),
    fc.integer({ min: 1, max: 100_000 }),
    fc.integer({ min: 1, max: 25_000 }),
    (rentalMinor, transportMinor, depositMinor, aggregateUnitMinor, quantityMilliYards) => {
      const shared = {
        kind: "initial_bin",
        currentContractTotalMinor: 0,
        orderFrom150: true,
        currency: "CAD",
        taxRateBasisPoints: 1_300,
        bin: {
          incomingContentCode: "garbage",
          incomingBinSizeYards: 14,
          rentalMinor,
          transportMinor,
          fixedDumpMinor: 0,
          depositMinor,
          discountMinor: 0
        },
        aggregateLines: [{
          itemCode: "AGG_HPB",
          displayName: "HPB",
          quantityMilliYards,
          unitAmountMinor: aggregateUnitMinor,
          densityLbsPerYard: 2_600
        }],
        loadingFeeMinor: 5_000
      };
      const cash = calculateCustomerCharge({ ...shared, paymentMethod: "cash" });
      const card = calculateCustomerCharge({ ...shared, paymentMethod: "card" });
      const configuredTotal = cash.lines.reduce((sum, line) => sum + line.configuredAmountMinor, 0);
      const expectedCashHst = configuredPositiveLines(cash)
        .reduce((sum, line) => sum + roundedRatio(line.configuredAmountMinor, 1_300, 11_300), 0);
      const expectedCardHst = configuredPositiveLines(card)
        .reduce((sum, line) => sum + roundedRatio(line.configuredAmountMinor, 1_300, 10_000), 0);

      assert.equal(cash.newRequestChargeableMinor, configuredTotal);
      assert.equal(cash.includedHstMinor, expectedCashHst);
      assert.equal(cash.addedHstMinor, 0);
      assert.equal(cash.netsuiteReadySnapshot, null);
      assert.equal(cash.netsuiteExportPolicy, "excluded_cash");
      assert.equal(card.preTaxRevenueMinor, configuredTotal);
      assert.equal(card.addedHstMinor, expectedCardHst);
      assert.equal(card.newRequestChargeableMinor, configuredTotal + expectedCardHst);
      assert.equal(card.netsuiteReadySnapshot.includesTaxChargeLine, false);
      assert.equal(card.netsuiteReadySnapshot.lines.some((line) => line.lineType === "tax"), false);
      assert.equal(card.netsuiteExportPolicy, "eligible_non_cash");
      assert.equal(cash.requiredDepositMinor, depositMinor);
      assert.equal(card.requiredDepositMinor, depositMinor);
    }
  ), { numRuns: 1_000 });
});

test("customer-charge property: resulting totals and payment timing conserve every cent (1,000 cases)", () => {
  fc.assert(fc.property(
    fc.constantFrom("garbage", "soil", "asphalt", "concrete"),
    fc.constantFrom("cash", "card", "debit", "e_transfer", "cheque", "account"),
    fc.integer({ min: 0, max: 10_000_000 }),
    fc.integer({ min: 1, max: 1_000_000 }),
    fc.integer({ min: 1, max: 1_000_000 }),
    fc.integer({ min: 1, max: 1_000_000 }),
    fc.integer({ min: 0, max: 100_000 }),
    (content, paymentMethod, currentTotal, rentalMinor, transportMinor, dumpMinor, depositMinor) => {
      const nonGarbage = content !== "garbage";
      const result = calculateCustomerCharge({
        kind: "add_bin",
        paymentMethod,
        currentContractTotalMinor: currentTotal,
        orderFrom150: false,
        bin: {
          incomingContentCode: content,
          incomingBinSizeYards: 14,
          rentalMinor,
          transportMinor,
          fixedDumpMinor: nonGarbage ? dumpMinor : 0,
          depositMinor,
          discountMinor: 0
        },
        aggregateLines: [],
        loadingFeeMinor: 5_000,
        taxRateBasisPoints: 1_300,
        currency: "CAD"
      });

      assert.equal(result.resultingContractTotalMinor, currentTotal + result.newRequestChargeableMinor);
      assert.equal(result.preTaxRevenueMinor, result.lines.reduce((sum, line) => sum + line.preTaxAmountMinor, 0));
      assert.equal(result.includedHstMinor, result.lines.reduce((sum, line) => sum + line.includedHstMinor, 0));
      assert.equal(result.addedHstMinor, result.lines.reduce((sum, line) => sum + line.addedHstMinor, 0));
      assert.equal(result.newRequestChargeableMinor, result.lines.reduce((sum, line) => sum + line.customerAmountMinor, 0));
      assert.equal(result.requiredDepositMinor, nonGarbage ? 0 : depositMinor);
      const dueRevenue = result.lines
        .filter((line) => line.paymentTiming === "due_now")
        .reduce((sum, line) => sum + line.customerAmountMinor, 0);
      assert.equal(result.dueNowMinor, dueRevenue + result.requiredDepositMinor);
      assert.ok(result.lines.every((line) => Number.isSafeInteger(line.customerAmountMinor)));
    }
  ), { numRuns: 1_000 });
});

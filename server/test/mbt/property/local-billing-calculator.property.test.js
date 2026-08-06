// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

const CALCULATOR_PATH = "../../../src/mbt/" + "local-billing-calculator.js";
const calculatorModule = /** @type {Record<string, Function>} */ (await import(CALCULATOR_PATH)
  .catch((importError) => ({ importError })));

/** @param {string} name */
function requiredOperation(name) {
  const operation = calculatorModule[name];
  assert.equal(typeof operation, "function", `P3.10 requires local-billing-calculator.${name}.`);
  return operation;
}

/** @param {number[]} amounts @param {number} taxBasisPoints */
function generatedBillingInput(amounts, taxBasisPoints) {
  const lineTypes = ["rental", "extension", "exchange", "pickup"];
  return {
    rateCardVersionId: "10000000-0000-4000-8000-000000000001",
    currency: "CAD",
    taxBasisPoints,
    contractSnapshot: { contractId: "20000000-0000-4000-8000-000000000001", revision: 1 },
    visitSnapshot: { serviceVisitId: "30000000-0000-4000-8000-000000000001", revision: 1 },
    distanceSnapshot: {
      distanceSnapshotId: "40000000-0000-4000-8000-000000000001",
      provider: "property",
      rawMetres: 1,
      selectedBandId: "50000000-0000-4000-8000-000000000001",
      amountMinor: 101,
      currency: "CAD",
      origin: { kind: "yard" },
      destination: { kind: "site" }
    },
    localItem: { code: "14YD", revision: 1 },
    components: amounts.map((amountMinor, index) => ({
      componentId: `60000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      lineCode: `generated_${String(index).padStart(3, "0")}`,
      lineType: lineTypes[index % lineTypes.length],
      rateBasis: "per_unit",
      amountMinor,
      quantityMicrounits: ((index % 5) + 1) * 250_000,
      taxable: index % 2 === 0
    })),
    customPrices: [],
    dump: null
  };
}

test("P3-F25 property: component permutation is deterministic and input stays immutable (1,000 cases)", () => {
  const calculateMbtLocalBilling = requiredOperation("calculateMbtLocalBilling");
  fc.assert(fc.property(
    fc.array(fc.integer({ min: 0, max: 100_000 }), { minLength: 0, maxLength: 20 }),
    fc.integer({ min: 0, max: 2_500 }),
    (amounts, taxBasisPoints) => {
      const forward = generatedBillingInput(amounts, taxBasisPoints);
      const reverse = structuredClone(forward);
      reverse.components.reverse();
      const before = structuredClone(forward);
      assert.deepEqual(calculateMbtLocalBilling(reverse), calculateMbtLocalBilling(forward));
      assert.deepEqual(forward, before);
    }
  ), { numRuns: 1_000 });
});

test("P3-F25 property: every version and line conserves exact subtotal, tax, and total cents (1,000 cases)", () => {
  const calculateMbtLocalBilling = requiredOperation("calculateMbtLocalBilling");
  fc.assert(fc.property(
    fc.array(fc.integer({ min: 0, max: 50_000 }), { minLength: 0, maxLength: 25 }),
    fc.integer({ min: 0, max: 2_500 }),
    (amounts, taxBasisPoints) => {
      const result = calculateMbtLocalBilling(generatedBillingInput(amounts, taxBasisPoints));
      for (const line of result.lines) {
        assert.equal(line.totalAmountMinor, line.netAmountMinor + line.estimatedTaxMinor);
        assert.ok(Number.isSafeInteger(line.netAmountMinor));
        assert.ok(Number.isSafeInteger(line.estimatedTaxMinor));
      }
      assert.equal(result.subtotalMinor, result.lines.reduce((sum, line) => sum + line.netAmountMinor, 0));
      assert.equal(result.estimatedTaxMinor, result.lines.reduce((sum, line) => sum + line.estimatedTaxMinor, 0));
      assert.equal(result.totalMinor, result.lines.reduce((sum, line) => sum + line.totalAmountMinor, 0));
    }
  ), { numRuns: 1_000 });
});

test("P3-F25 property: dump tariff, receipt cost, and signed margin remain independent (1,000 cases)", () => {
  const calculateMbtLocalBilling = requiredOperation("calculateMbtLocalBilling");
  fc.assert(fc.property(
    fc.integer({ min: 0, max: 100_000 }),
    fc.integer({ min: 0, max: 20_000_000 }),
    fc.integer({ min: 0, max: 500_000 }),
    fc.integer({ min: 0, max: 500_000 }),
    (unitMinor, quantityMicrounits, minimumMinor, actualCostMinor) => {
      const input = generatedBillingInput([], 0);
      input.dump = {
        receiptSnapshot: {
          dumpReceiptId: "70000000-0000-4000-8000-000000000001",
          dumpSiteId: "80000000-0000-4000-8000-000000000001",
          materialId: "90000000-0000-4000-8000-000000000001",
          ticketNumber: "PROPERTY",
          quantityMicrounits,
          unitOfMeasure: "KG",
          subtotalMinor: actualCostMinor,
          taxMinor: 0,
          totalMinor: actualCostMinor,
          currency: "CAD"
        },
        tariff: {
          dumpTariffId: "a0000000-0000-4000-8000-000000000001",
          pricingBasis: "per_quantity",
          unitOfMeasure: "KG",
          amountMinor: unitMinor,
          minimumAmountMinor: minimumMinor,
          currency: "CAD"
        },
        localItem: { code: "DUMP", revision: 1 }
      };
      const result = calculateMbtLocalBilling(input);
      const multiplied = Math.floor(((unitMinor * quantityMicrounits) + 500_000) / 1_000_000);
      const expectedCharge = Math.max(multiplied, minimumMinor);
      assert.equal(result.dumpEconomics.customerChargeMinor, expectedCharge);
      assert.equal(result.dumpEconomics.actualCostMinor, actualCostMinor);
      assert.equal(result.dumpEconomics.marginMinor, expectedCharge - actualCostMinor);
    }
  ), { numRuns: 1_000 });
});

test("P3-F26 property: permutation preserves dedupe and every non-SO pool conserves cents (1,000 cases)", () => {
  const calculateMbbsCrossCharges = requiredOperation("calculateMbbsCrossCharges");
  fc.assert(fc.property(
    fc.integer({ min: 0, max: 1_000_000 }),
    fc.uniqueArray(fc.stringMatching(/^[A-Z0-9]{1,8}$/), { minLength: 1, maxLength: 20 }),
    (sharedTotalMinor, roots) => {
      const references = roots.flatMap((rootReference, index) => [
        { sourceType: index % 2 === 0 ? "PO" : "VRMA", rootReference },
        { sourceType: index % 2 === 0 ? "PO" : "VRMA", rootReference }
      ]);
      const input = {
        currency: "CAD",
        loads: [{
          physicalLoadId: "PROPERTY-LOAD",
          completedAt: "2038-01-01T00:00:00.000Z",
          sharedTotalMinor,
          references
        }]
      };
      const reversed = structuredClone(input);
      reversed.loads[0].references.reverse();
      const forwardResult = calculateMbbsCrossCharges(input);
      assert.deepEqual(calculateMbbsCrossCharges(reversed), forwardResult);
      assert.equal(forwardResult.cases.length, roots.length);
      assert.equal(
        forwardResult.allocationGroups[0].allocations.reduce(
          (sum, allocation) => sum + allocation.allocatedAmountMinor,
          0
        ),
        sharedTotalMinor
      );
    }
  ), { numRuns: 1_000 });
});

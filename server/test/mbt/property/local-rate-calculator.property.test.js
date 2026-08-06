// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";

const CALCULATOR_PATH = "../../../src/mbt/" + "local-rate-calculator.js";
const calculatorModule = /** @type {Record<string, Function>} */ (await import(CALCULATOR_PATH)
  .catch(() => ({})));

/** @param {string} name */
function requiredOperation(name) {
  const operation = calculatorModule[name];
  assert.equal(typeof operation, "function", `P3.6 requires local-rate-calculator.${name}.`);
  return operation;
}

/** @param {Record<string, unknown>} overrides */
function calculationInput(overrides) {
  return {
    rateCardVersionId: "60000000-0000-4000-8000-000000000001",
    serviceCode: "delivery",
    binTypeCode: "14YD",
    rawDistanceMetres: 0,
    downtown: false,
    currency: "CAD",
    distanceBands: [],
    components: [],
    componentQuantities: {},
    ...overrides
  };
}

test("P3-F12 property: 1,000 generated raw-metre boundaries are minimum-inclusive and maximum-exclusive", () => {
  const calculateLocalRate = requiredOperation("calculateLocalRate");
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 2_000_000 }),
    fc.integer({ min: 1, max: 2_000_000 }),
    fc.tuple(
      fc.integer({ min: 0, max: 10_000_000 }),
      fc.integer({ min: 0, max: 10_000_000 }),
      fc.integer({ min: 0, max: 10_000_000 })
    ),
    (firstCut, width, amounts) => {
      const secondCut = firstCut + width;
      const bands = [
        {
          rateDistanceBandId: "band-a",
          serviceCode: "delivery",
          binTypeCode: "14YD",
          sequenceNumber: 0,
          minimumMetres: 0,
          maximumMetres: firstCut,
          amountMinor: amounts[0],
          downtownSurchargeMinor: 0,
          currency: "CAD"
        },
        {
          rateDistanceBandId: "band-b",
          serviceCode: "delivery",
          binTypeCode: "14YD",
          sequenceNumber: 1,
          minimumMetres: firstCut,
          maximumMetres: secondCut,
          amountMinor: amounts[1],
          downtownSurchargeMinor: 0,
          currency: "CAD"
        },
        {
          rateDistanceBandId: "band-c",
          serviceCode: "delivery",
          binTypeCode: "14YD",
          sequenceNumber: 2,
          minimumMetres: secondCut,
          maximumMetres: null,
          amountMinor: amounts[2],
          downtownSurchargeMinor: 0,
          currency: "CAD"
        }
      ];
      const probes = [
        [firstCut - 1, "band-a", amounts[0]],
        [firstCut, "band-b", amounts[1]],
        [secondCut - 1, "band-b", amounts[1]],
        [secondCut, "band-c", amounts[2]]
      ];
      for (const [rawDistanceMetres, expectedBand, expectedAmount] of probes) {
        const result = calculateLocalRate(calculationInput({ rawDistanceMetres, distanceBands: bands }));
        assert.equal(result.selectedDistanceBandId, expectedBand);
        assert.equal(result.subtotalMinor, expectedAmount);
        assert.equal(result.calculationExplanation.roundedKilometresUsed, false);
      }
    }
  ), { numRuns: 1_000 });
});

test("P3-F25 property: 1,000 generated component graphs conserve cents and ignore input order", () => {
  const calculateLocalRate = requiredOperation("calculateLocalRate");
  fc.assert(fc.property(
    fc.integer({ min: 0, max: 10_000_000 }),
    fc.array(fc.tuple(
      fc.integer({ min: 0, max: 1_000_000 }),
      fc.integer({ min: 1, max: 100 })
    ), { minLength: 1, maxLength: 8 }),
    (baseAmountMinor, entries) => {
      const components = entries.map(([amountMinor], index) => ({
        componentCode: `generated_${String(index).padStart(2, "0")}`,
        componentKind: "service",
        serviceCode: null,
        binTypeCode: null,
        rateBasis: "per_unit",
        amountMinor,
        currency: "CAD",
        taxable: index % 2 === 0,
        active: true
      }));
      const componentQuantities = Object.fromEntries(entries.map(([, quantity], index) => [
        `generated_${String(index).padStart(2, "0")}`,
        quantity
      ]));
      const distanceBands = [{
        rateDistanceBandId: "all-distance",
        serviceCode: "delivery",
        binTypeCode: "14YD",
        sequenceNumber: 0,
        minimumMetres: 0,
        maximumMetres: null,
        amountMinor: baseAmountMinor,
        downtownSurchargeMinor: 0,
        currency: "CAD"
      }];
      const input = calculationInput({
        rawDistanceMetres: 123_456,
        distanceBands,
        components,
        componentQuantities
      });
      const before = structuredClone(input);
      const forward = calculateLocalRate(input);
      const reversed = calculateLocalRate(calculationInput({
        rawDistanceMetres: 123_456,
        distanceBands: [...distanceBands].reverse(),
        components: [...components].reverse(),
        componentQuantities: { ...componentQuantities }
      }));
      const expected = baseAmountMinor + entries.reduce(
        (sum, [amountMinor, quantity]) => sum + (amountMinor * quantity),
        0
      );
      assert.equal(forward.subtotalMinor, expected);
      assert.equal(forward.lines.reduce((sum, line) => sum + line.netAmountMinor, 0), expected);
      assert.deepEqual(reversed, forward);
      assert.deepEqual(input, before);
      assert.ok(Number.isSafeInteger(forward.subtotalMinor));
    }
  ), { numRuns: 1_000 });
});

test("P3-F25 property: 1,000 generated dump rates keep customer charge, actual cost, and margin exact", () => {
  const calculateDumpRate = requiredOperation("calculateDumpRate");
  fc.assert(fc.property(
    fc.integer({ min: 0, max: 1_000_000 }),
    fc.integer({ min: 1, max: 100 }),
    fc.integer({ min: 0, max: 100_000_000 }),
    fc.integer({ min: 0, max: 100_000_000 }),
    (unitAmountMinor, quantity, minimumAmountMinor, actualCostMinor) => {
      const calculatedTariffMinor = unitAmountMinor * quantity;
      const customerChargeMinor = Math.max(calculatedTariffMinor, minimumAmountMinor);
      const result = calculateDumpRate({
        currency: "CAD",
        dumpSiteId: "dump-generated",
        materialId: "material-generated",
        quantity,
        unitOfMeasure: "TONNE",
        actualCostMinor,
        tariffs: [{
          dumpTariffId: "tariff-generated",
          dumpSiteId: "dump-generated",
          materialId: "material-generated",
          tariffCode: "generated_tonne",
          pricingBasis: "per_quantity",
          unitOfMeasure: "TONNE",
          amountMinor: unitAmountMinor,
          minimumAmountMinor,
          currency: "CAD",
          active: true
        }]
      });
      assert.equal(result.calculatedTariffMinor, calculatedTariffMinor);
      assert.equal(result.customerChargeMinor, customerChargeMinor);
      assert.equal(result.actualCostMinor, actualCostMinor);
      assert.equal(result.marginMinor, customerChargeMinor - actualCostMinor);
      assert.equal(
        result.customerChargeMinor - result.actualCostMinor,
        result.marginMinor,
        "Actual receipt cost must never be folded into the customer charge."
      );
    }
  ), { numRuns: 1_000 });
});

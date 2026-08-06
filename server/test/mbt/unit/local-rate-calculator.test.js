// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

const DISTANCE_BANDS = Object.freeze([
  Object.freeze({
    rateDistanceBandId: "10000000-0000-4000-8000-000000000001",
    serviceCode: "delivery",
    binTypeCode: "14YD",
    sequenceNumber: 0,
    minimumMetres: 0,
    maximumMetres: 10_000,
    amountMinor: 12_000,
    downtownSurchargeMinor: 1_500,
    currency: "CAD"
  }),
  Object.freeze({
    rateDistanceBandId: "10000000-0000-4000-8000-000000000002",
    serviceCode: "delivery",
    binTypeCode: "14YD",
    sequenceNumber: 1,
    minimumMetres: 10_000,
    maximumMetres: null,
    amountMinor: 18_000,
    downtownSurchargeMinor: 2_500,
    currency: "CAD"
  })
]);
const COMPONENTS = Object.freeze([
  Object.freeze({
    componentCode: "rental_daily",
    componentKind: "rental",
    serviceCode: "delivery",
    binTypeCode: "14YD",
    rateBasis: "per_day",
    amountMinor: 700,
    currency: "CAD",
    taxable: true,
    active: true
  }),
  Object.freeze({
    componentCode: "permit_fee",
    componentKind: "service",
    serviceCode: null,
    binTypeCode: null,
    rateBasis: "flat",
    amountMinor: 900,
    currency: "CAD",
    taxable: false,
    active: true
  }),
  Object.freeze({
    componentCode: "inactive_fee",
    componentKind: "other",
    serviceCode: null,
    binTypeCode: null,
    rateBasis: "flat",
    amountMinor: 99_999,
    currency: "CAD",
    taxable: true,
    active: false
  }),
  Object.freeze({
    componentCode: "pickup_only",
    componentKind: "pickup",
    serviceCode: "final_pickup",
    binTypeCode: "14YD",
    rateBasis: "flat",
    amountMinor: 8_000,
    currency: "CAD",
    taxable: true,
    active: true
  })
]);

const CALCULATOR_PATH = "../../../src/mbt/" + "local-rate-calculator.js";
const calculatorModule = /** @type {Record<string, Function>} */ (await import(CALCULATOR_PATH)
  .catch((importError) => ({ importError })));

/** @param {string} name */
function requiredOperation(name) {
  const operation = calculatorModule[name];
  assert.equal(
    typeof operation,
    "function",
    `P3.6 requires local-rate-calculator.${name}.`
  );
  return operation;
}

function rateInput(overrides = {}) {
  return {
    rateCardVersionId: "20000000-0000-4000-8000-000000000001",
    serviceCode: "delivery",
    binTypeCode: "14YD",
    rawDistanceMetres: 10_000,
    downtown: true,
    currency: "CAD",
    distanceBands: DISTANCE_BANDS.map((band) => ({ ...band })),
    components: COMPONENTS.map((component) => ({ ...component })),
    componentQuantities: { rental_daily: 3 },
    ...overrides
  };
}

test("P3-F12 calculator: raw metres select one half-open band and exact deterministic cent lines", () => {
  const calculateLocalRate = requiredOperation("calculateLocalRate");
  const input = rateInput();
  const before = structuredClone(input);
  const result = calculateLocalRate(input);

  assert.deepEqual(result, {
    schemaVersion: "mbt-local-rate-v1",
    rateCardVersionId: input.rateCardVersionId,
    serviceCode: "delivery",
    binTypeCode: "14YD",
    rawDistanceMetres: 10_000,
    currency: "CAD",
    selectedDistanceBandId: DISTANCE_BANDS[1].rateDistanceBandId,
    lines: [
      {
        lineCode: "transport",
        lineType: "transport",
        quantity: 1,
        unitOfMeasure: "TRIP",
        unitAmountMinor: 18_000,
        netAmountMinor: 18_000,
        currency: "CAD",
        source: {
          type: "distance_band",
          id: DISTANCE_BANDS[1].rateDistanceBandId
        }
      },
      {
        lineCode: "downtown_surcharge",
        lineType: "surcharge",
        quantity: 1,
        unitOfMeasure: "TRIP",
        unitAmountMinor: 2_500,
        netAmountMinor: 2_500,
        currency: "CAD",
        source: {
          type: "distance_band",
          id: DISTANCE_BANDS[1].rateDistanceBandId
        }
      },
      {
        lineCode: "permit_fee",
        lineType: "service",
        quantity: 1,
        unitOfMeasure: "EA",
        unitAmountMinor: 900,
        netAmountMinor: 900,
        currency: "CAD",
        source: { type: "rate_component", code: "permit_fee" }
      },
      {
        lineCode: "rental_daily",
        lineType: "rental",
        quantity: 3,
        unitOfMeasure: "DAY",
        unitAmountMinor: 700,
        netAmountMinor: 2_100,
        currency: "CAD",
        source: { type: "rate_component", code: "rental_daily" }
      }
    ],
    subtotalMinor: 23_500,
    calculationExplanation: {
      arithmetic: "integer_minor_units",
      distanceSelection: "raw_metres_minimum_inclusive_maximum_exclusive",
      roundedKilometresUsed: false,
      selectedBand: { minimumMetres: 10_000, maximumMetres: null }
    }
  });
  assert.deepEqual(input, before, "A pure calculator must not rewrite frozen rate evidence.");
});

test("P3-F24 calculator: adjacent metre values never round across a band boundary", () => {
  const calculateLocalRate = requiredOperation("calculateLocalRate");
  const lower = calculateLocalRate(rateInput({
    rawDistanceMetres: 9_999,
    downtown: false,
    components: [],
    componentQuantities: {}
  }));
  const upper = calculateLocalRate(rateInput({
    rawDistanceMetres: 10_000,
    downtown: false,
    components: [],
    componentQuantities: {}
  }));
  assert.equal(lower.selectedDistanceBandId, DISTANCE_BANDS[0].rateDistanceBandId);
  assert.equal(lower.subtotalMinor, 12_000);
  assert.equal(upper.selectedDistanceBandId, DISTANCE_BANDS[1].rateDistanceBandId);
  assert.equal(upper.subtotalMinor, 18_000);
  assert.equal(lower.calculationExplanation.roundedKilometresUsed, false);
  assert.equal(upper.calculationExplanation.roundedKilometresUsed, false);
});

test("2026 tariff calculator charges over 75 km at CAD 7 per actual kilometre", () => {
  const calculateLocalRate = requiredOperation("calculateLocalRate");
  const bands = [
    {
      rateDistanceBandId: "quoted-flat",
      serviceCode: "mbbs_cross_charge",
      binTypeCode: null,
      sequenceNumber: 0,
      minimumMetres: 0,
      maximumMetres: 75_000,
      amountMinor: 38_500,
      pricingBasis: "flat",
      boundaryRule: "upper_inclusive",
      downtownSurchargeMinor: 0,
      currency: "CAD"
    },
    {
      rateDistanceBandId: "quoted-per-km",
      serviceCode: "mbbs_cross_charge",
      binTypeCode: null,
      sequenceNumber: 1,
      minimumMetres: 75_000,
      maximumMetres: null,
      amountMinor: 700,
      pricingBasis: "per_km",
      boundaryRule: "upper_inclusive",
      downtownSurchargeMinor: 0,
      currency: "CAD"
    }
  ];

  const exactBoundary = calculateLocalRate(rateInput({
    serviceCode: "mbbs_cross_charge",
    binTypeCode: null,
    rawDistanceMetres: 75_000,
    downtown: false,
    distanceBands: bands,
    components: [],
    componentQuantities: {}
  }));
  assert.equal(exactBoundary.selectedDistanceBandId, "quoted-flat");
  assert.equal(exactBoundary.subtotalMinor, 38_500);

  const overBoundary = calculateLocalRate(rateInput({
    serviceCode: "mbbs_cross_charge",
    binTypeCode: null,
    rawDistanceMetres: 75_500,
    downtown: false,
    distanceBands: bands,
    components: [],
    componentQuantities: {}
  }));
  assert.equal(overBoundary.selectedDistanceBandId, "quoted-per-km");
  assert.equal(overBoundary.subtotalMinor, 52_850);
  assert.deepEqual(overBoundary.lines[0], {
    lineCode: "transport",
    lineType: "transport",
    quantity: 75.5,
    unitOfMeasure: "KM",
    unitAmountMinor: 700,
    netAmountMinor: 52_850,
    currency: "CAD",
    source: { type: "distance_band", id: "quoted-per-km" }
  });
});

test("P3-F25 calculator: dump customer tariff, actual receipt cost, and margin remain separate", () => {
  const calculateDumpRate = requiredOperation("calculateDumpRate");
  const result = calculateDumpRate({
    currency: "CAD",
    dumpSiteId: "30000000-0000-4000-8000-000000000001",
    materialId: "40000000-0000-4000-8000-000000000001",
    quantity: 6,
    unitOfMeasure: "TONNE",
    actualCostMinor: 12_750,
    tariffs: [{
      dumpTariffId: "50000000-0000-4000-8000-000000000001",
      dumpSiteId: "30000000-0000-4000-8000-000000000001",
      materialId: "40000000-0000-4000-8000-000000000001",
      tariffCode: "clean_fill_tonne",
      pricingBasis: "per_quantity",
      unitOfMeasure: "TONNE",
      amountMinor: 2_500,
      minimumAmountMinor: 16_000,
      currency: "CAD",
      active: true
    }]
  });
  assert.deepEqual(result, {
    schemaVersion: "mbt-dump-rate-v1",
    currency: "CAD",
    dumpTariffId: "50000000-0000-4000-8000-000000000001",
    pricingBasis: "per_quantity",
    quantity: 6,
    unitOfMeasure: "TONNE",
    unitAmountMinor: 2_500,
    calculatedTariffMinor: 15_000,
    minimumAmountMinor: 16_000,
    customerChargeMinor: 16_000,
    actualCostMinor: 12_750,
    marginMinor: 3_250,
    calculationExplanation: {
      arithmetic: "integer_minor_units",
      customerCharge: "max(quantity_x_unit_amount, minimum_amount)",
      actualCostIncludedInCustomerCharge: false
    }
  });
});

test("P3-F12 calculator: row order cannot change a scoped calculation", () => {
  const calculateLocalRate = requiredOperation("calculateLocalRate");
  const forward = rateInput({ downtown: false });
  const reversed = rateInput({
    downtown: false,
    distanceBands: [...DISTANCE_BANDS].reverse().map((band) => ({ ...band })),
    components: [...COMPONENTS].reverse().map((component) => ({ ...component }))
  });
  assert.deepEqual(calculateLocalRate(reversed), calculateLocalRate(forward));
});

test("P3-F12 calculator: fractional, unsafe, mismatched, or overflowing evidence fails closed", () => {
  const calculateDumpRate = requiredOperation("calculateDumpRate");
  const calculateLocalRate = requiredOperation("calculateLocalRate");
  const cases = [
    {
      run: () => calculateLocalRate(rateInput({ rawDistanceMetres: 9_999.5 })),
      code: "MBT_RATE_DISTANCE_INVALID"
    },
    {
      run: () => calculateLocalRate(rateInput({ rawDistanceMetres: Number.MAX_SAFE_INTEGER + 1 })),
      code: "MBT_RATE_DISTANCE_INVALID"
    },
    {
      run: () => calculateLocalRate(rateInput({
        distanceBands: [{ ...DISTANCE_BANDS[1], minimumMetres: 0, amountMinor: Number.MAX_SAFE_INTEGER }],
        components: [{ ...COMPONENTS[1], amountMinor: 1 }],
        componentQuantities: {},
        downtown: false
      })),
      code: "MBT_RATE_MONEY_OVERFLOW"
    },
    {
      run: () => calculateLocalRate(rateInput({
        distanceBands: DISTANCE_BANDS.map((band) => ({ ...band, currency: "USD" }))
      })),
      code: "MBT_RATE_CURRENCY_MISMATCH"
    },
    {
      run: () => calculateDumpRate({
        currency: "CAD",
        dumpSiteId: "30000000-0000-4000-8000-000000000001",
        materialId: "40000000-0000-4000-8000-000000000001",
        quantity: 1,
        unitOfMeasure: "TONNE",
        actualCostMinor: 1,
        tariffs: [{
          dumpTariffId: "50000000-0000-4000-8000-000000000001",
          dumpSiteId: "30000000-0000-4000-8000-000000000001",
          materialId: "40000000-0000-4000-8000-000000000001",
          tariffCode: "wrong_unit",
          pricingBasis: "per_quantity",
          unitOfMeasure: "KG",
          amountMinor: 1,
          minimumAmountMinor: 0,
          currency: "CAD",
          active: true
        }]
      }),
      code: "MBT_DUMP_TARIFF_UNIT_MISMATCH"
    }
  ];
  for (const scenario of cases) {
    assert.throws(
      scenario.run,
      (error) => error?.status === 400 && error?.code === scenario.code,
      scenario.code
    );
  }
});

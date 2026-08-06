// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateMbbsCrossCharges,
  calculateMbtLocalBilling
} from "../../../src/mbt/local-billing-calculator.js";
import { MbtError } from "../../../src/mbt/errors.js";

function billingInput(overrides = {}) {
  return {
    rateCardVersionId: "10000000-0000-4000-8000-000000000001",
    currency: "CAD",
    taxBasisPoints: 0,
    contractSnapshot: { contractId: "20000000-0000-4000-8000-000000000001", revision: 1 },
    visitSnapshot: { serviceVisitId: "30000000-0000-4000-8000-000000000001", revision: 1 },
    distanceSnapshot: {
      distanceSnapshotId: "40000000-0000-4000-8000-000000000001",
      selectedBandId: "50000000-0000-4000-8000-000000000001",
      rawMetres: 1_000,
      amountMinor: 1_000,
      currency: "CAD"
    },
    localItem: { code: "14YD", revision: 1 },
    components: [],
    customPrices: [],
    dump: null,
    ...overrides
  };
}

/** @param {unknown} error @param {number} status @param {string} code @param {string} message */
function exactFailure(error, status, code, message) {
  return error instanceof MbtError
    && error.status === status
    && error.code === code
    && error.message === message;
}

/**
 * @param {unknown} input
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
function assertBillingRejected(input, status, code, message) {
  const before = structuredClone(input);
  assert.throws(
    () => calculateMbtLocalBilling(input),
    (error) => exactFailure(error, status, code, message)
  );
  assert.deepEqual(input, before, "rejected immutable billing evidence must not be rewritten");
}

test("P3 billing coverage: malformed top-level, money, currency, and collection evidence has exact failures", () => {
  const cases = [
    {
      input: null,
      status: 422,
      code: "MBT_BILLING_INPUT_INVALID",
      message: "Local billing evidence is required."
    },
    {
      input: billingInput({ currency: "" }),
      status: 422,
      code: "MBT_BILLING_INPUT_INVALID",
      message: "Currency is required."
    },
    {
      input: billingInput({ currency: "USD" }),
      status: 422,
      code: "MBT_BILLING_CURRENCY_MISMATCH",
      message: "P3.10 local billing requires CAD evidence."
    },
    {
      input: billingInput({ taxBasisPoints: -1 }),
      status: 422,
      code: "MBT_BILLING_MONEY_INVALID",
      message: "Tax basis points must be a non-negative safe integer."
    },
    {
      input: billingInput({ taxBasisPoints: 1.5 }),
      status: 422,
      code: "MBT_BILLING_MONEY_INVALID",
      message: "Tax basis points must be a non-negative safe integer."
    },
    {
      input: billingInput({ distanceSnapshot: null }),
      status: 422,
      code: "MBT_BILLING_INPUT_INVALID",
      message: "Distance snapshot is required."
    },
    {
      input: billingInput({
        distanceSnapshot: { ...billingInput().distanceSnapshot, currency: "USD" }
      }),
      status: 422,
      code: "MBT_BILLING_CURRENCY_MISMATCH",
      message: "P3.10 local billing requires CAD evidence."
    },
    {
      input: billingInput({ localItem: null }),
      status: 422,
      code: "MBT_BILLING_INPUT_INVALID",
      message: "Local-item evidence is required."
    },
    {
      input: billingInput({ localItem: { code: "14YD", revision: 0 } }),
      status: 422,
      code: "MBT_BILLING_INPUT_INVALID",
      message: "Local-item revision must be positive."
    },
    {
      input: billingInput({ components: null }),
      status: 422,
      code: "MBT_BILLING_INPUT_INVALID",
      message: "Rate components are required."
    },
    {
      input: billingInput({ customPrices: null }),
      status: 422,
      code: "MBT_BILLING_INPUT_INVALID",
      message: "Custom prices are required."
    },
    {
      input: billingInput({
        taxBasisPoints: Number.MAX_SAFE_INTEGER,
        distanceSnapshot: {
          ...billingInput().distanceSnapshot,
          amountMinor: Number.MAX_SAFE_INTEGER
        }
      }),
      status: 422,
      code: "MBT_BILLING_MONEY_OVERFLOW",
      message: "Line tax exceeds safe integer cents."
    }
  ];
  for (const scenario of cases) {
    assertBillingRejected(scenario.input, scenario.status, scenario.code, scenario.message);
  }
});

test("P3 billing coverage: component and custom-price evidence rejects exact unsupported boundaries", () => {
  const component = {
    componentId: "60000000-0000-4000-8000-000000000001",
    lineCode: "rental_week",
    lineType: "rental",
    rateBasis: "per_week",
    amountMinor: 500,
    taxable: true
  };
  const cases = [
    {
      input: billingInput({ components: [null] }),
      code: "MBT_BILLING_INPUT_INVALID",
      message: "Rate component is required."
    },
    {
      input: billingInput({ components: [{ ...component, lineType: "dump" }] }),
      code: "MBT_BILLING_LINE_TYPE_INVALID",
      message: "Unsupported local billing line type: dump."
    },
    {
      input: billingInput({ components: [{ ...component, rateBasis: "per_mile" }] }),
      code: "MBT_BILLING_RATE_BASIS_INVALID",
      message: "Unsupported component rate basis: per_mile."
    },
    {
      input: billingInput({ components: [{ ...component, quantityMicrounits: 0 }] }),
      code: "MBT_BILLING_QUANTITY_INVALID",
      message: "Component quantity must be positive."
    },
    {
      input: billingInput({ components: [{ ...component, currency: "USD" }] }),
      code: "MBT_BILLING_CURRENCY_MISMATCH",
      message: "P3.10 local billing requires CAD evidence."
    },
    {
      input: billingInput({
        components: [{
          ...component,
          lineType: "surcharge",
          rateBasis: "percentage",
          percentageBasisPoints: -1,
          amountMinor: undefined
        }]
      }),
      code: "MBT_BILLING_MONEY_INVALID",
      message: "Component percentage basis points must be a non-negative safe integer."
    },
    {
      input: billingInput({ customPrices: [null] }),
      code: "MBT_BILLING_INPUT_INVALID",
      message: "Custom price is required."
    },
    {
      input: billingInput({
        customPrices: [{ lineCode: "custom", amountMinor: 1, localItemCode: "CUSTOM", localItemRevision: 0 }]
      }),
      code: "MBT_BILLING_INPUT_INVALID",
      message: "Local-item revision must be positive."
    }
  ];
  for (const scenario of cases) {
    assertBillingRejected(scenario.input, 422, scenario.code, scenario.message);
  }
});

function dumpEvidence(overrides = {}) {
  return {
    receiptSnapshot: {
      dumpReceiptId: "70000000-0000-4000-8000-000000000001",
      quantityMicrounits: 2_000_000,
      unitOfMeasure: "TONNE",
      subtotalMinor: 400,
      taxMinor: 20,
      totalMinor: 420,
      currency: "CAD"
    },
    tariff: {
      dumpTariffId: "80000000-0000-4000-8000-000000000001",
      pricingBasis: "per_quantity",
      unitOfMeasure: "TONNE",
      amountMinor: 300,
      minimumAmountMinor: 0,
      currency: "CAD"
    },
    localItem: { code: "DUMP", revision: 1 },
    ...overrides
  };
}

test("P3 billing coverage: receipt and tariff mismatches fail before producing customer charges", () => {
  const cases = [
    {
      dump: { ...dumpEvidence(), receiptSnapshot: null },
      code: "MBT_BILLING_INPUT_INVALID",
      message: "Dump receipt snapshot is required."
    },
    {
      dump: { ...dumpEvidence(), tariff: null },
      code: "MBT_BILLING_INPUT_INVALID",
      message: "Dump tariff is required."
    },
    {
      dump: {
        ...dumpEvidence(),
        receiptSnapshot: { ...dumpEvidence().receiptSnapshot, currency: "USD" }
      },
      code: "MBT_BILLING_CURRENCY_MISMATCH",
      message: "P3.10 local billing requires CAD evidence."
    },
    {
      dump: {
        ...dumpEvidence(),
        receiptSnapshot: { ...dumpEvidence().receiptSnapshot, totalMinor: 421 }
      },
      code: "MBT_BILLING_RECEIPT_TOTAL_INVALID",
      message: "Receipt subtotal plus tax must equal total."
    },
    {
      dump: {
        ...dumpEvidence(),
        tariff: { ...dumpEvidence().tariff, unitOfMeasure: "KG" }
      },
      code: "MBT_BILLING_DUMP_UNIT_MISMATCH",
      message: "Dump tariff and receipt units do not match."
    },
    {
      dump: {
        ...dumpEvidence(),
        tariff: { ...dumpEvidence().tariff, pricingBasis: "per_trip" }
      },
      code: "MBT_BILLING_RATE_BASIS_INVALID",
      message: "Unsupported dump pricing basis: per_trip."
    }
  ];
  for (const scenario of cases) {
    assertBillingRejected(billingInput({ dump: scenario.dump }), 422, scenario.code, scenario.message);
  }
});

test("P3 billing coverage: defaults, fixed minimums, units, and optional custom fields remain exact", () => {
  const input = billingInput({
    taxBasisPoints: undefined,
    distanceSnapshot: {
      ...billingInput().distanceSnapshot,
      taxable: false
    },
    localItem: { code: "14YD", revision: 1, currency: "CAD" },
    components: [
      {
        componentId: "60000000-0000-4000-8000-000000000010",
        lineCode: "rental_week",
        lineType: "rental",
        rateBasis: "per_week",
        amountMinor: 500,
        currency: "CAD",
        taxable: true
      },
      {
        componentId: "60000000-0000-4000-8000-000000000011",
        lineCode: "tonnage",
        lineType: "surcharge",
        rateBasis: "per_unit",
        amountMinor: 101,
        quantityMicrounits: 1_500_000,
        unitOfMeasure: "TONNE",
        taxable: false
      }
    ],
    customPrices: [{
      lineCode: "custom_gate",
      amountMinor: 275,
      taxable: true,
      localItemCode: "CUSTOM_GATE",
      localItemRevision: 3,
      currency: "CAD"
    }],
    dump: dumpEvidence({
      tariff: {
        dumpTariffId: "80000000-0000-4000-8000-000000000001",
        pricingBasis: "fixed",
        amountMinor: 300,
        minimumAmountMinor: 500,
        currency: "CAD",
        taxable: false
      }
    })
  });
  const before = structuredClone(input);
  const result = calculateMbtLocalBilling(input);

  assert.deepEqual(result.lines.map((line) => ({
    key: line.lineKey,
    quantity: line.quantityMicrounits,
    unit: line.unitOfMeasure,
    net: line.netAmountMinor,
    tax: line.estimatedTaxMinor,
    description: line.description
  })), [
    { key: "transport", quantity: 1_000_000, unit: "TRIP", net: 1_000, tax: 0, description: "Transport" },
    { key: "rental_week", quantity: 1_000_000, unit: "WEEK", net: 500, tax: 0, description: "rental_week" },
    { key: "tonnage", quantity: 1_500_000, unit: "TONNE", net: 152, tax: 0, description: "tonnage" },
    { key: "dump", quantity: 1_000_000, unit: "EA", net: 500, tax: 0, description: "Dump customer tariff" },
    { key: "custom_gate", quantity: 1_000_000, unit: "EA", net: 275, tax: 0, description: "custom_gate" }
  ]);
  assert.deepEqual(result.dumpEconomics, {
    customerChargeMinor: 500,
    actualCostMinor: 420,
    marginMinor: 80,
    currency: "CAD"
  });
  assert.equal(result.totalMinor, 2_427);
  assert.deepEqual(input, before);
});

/**
 * @param {unknown} input
 * @param {string} code
 * @param {string} message
 */
function assertCrossChargeRejected(input, code, message) {
  const before = structuredClone(input);
  assert.throws(
    () => calculateMbbsCrossCharges(input),
    (error) => exactFailure(error, 422, code, message)
  );
  assert.deepEqual(input, before);
}

test("P3 billing coverage: completed-load validation rejects malformed identities, chronology, references, and duplicates", () => {
  const validLoad = {
    physicalLoadId: "LOAD-A",
    completedAt: "2038-01-01T12:00:00.000Z",
    sharedTotalMinor: 100,
    references: [{ sourceType: "SO", rootReference: "SO-1" }]
  };
  const cases = [
    {
      input: null,
      code: "MBT_BILLING_INPUT_INVALID",
      message: "MBBS cross-charge evidence is required."
    },
    {
      input: { currency: "CAD", loads: null },
      code: "MBT_BILLING_LOAD_INVALID",
      message: "Completed physical loads are required."
    },
    {
      input: { currency: "CAD", loads: [{ ...validLoad, physicalLoadId: "" }] },
      code: "MBT_BILLING_INPUT_INVALID",
      message: "Physical-load ID is required."
    },
    {
      input: { currency: "CAD", loads: [{ ...validLoad, completedAt: "not-a-date" }] },
      code: "MBT_BILLING_LOAD_INVALID",
      message: "Completed-load time must be ISO-compatible."
    },
    {
      input: { currency: "CAD", loads: [{ ...validLoad, references: [] }] },
      code: "MBT_BILLING_LOAD_INVALID",
      message: "A completed physical load needs source references."
    },
    {
      input: { currency: "CAD", loads: [{ ...validLoad, references: [null] }] },
      code: "MBT_BILLING_INPUT_INVALID",
      message: "Cross-charge reference is required."
    },
    {
      input: {
        currency: "CAD",
        loads: [{ ...validLoad, references: [{ sourceType: "WO", rootReference: "WO-1" }] }]
      },
      code: "MBT_BILLING_SOURCE_TYPE_INVALID",
      message: "Unsupported cross-charge source type: WO."
    },
    {
      input: {
        currency: "CAD",
        loads: [{ ...validLoad, references: [{ sourceType: "SO", rootReference: "" }] }]
      },
      code: "MBT_BILLING_INPUT_INVALID",
      message: "Cross-charge root reference is required."
    },
    {
      input: { currency: "CAD", loads: [validLoad, { ...validLoad, completedAt: "2038-01-02T12:00:00Z" }] },
      code: "MBT_BILLING_LOAD_DUPLICATE",
      message: "Physical-load IDs must be unique."
    }
  ];
  for (const scenario of cases) {
    assertCrossChargeRejected(scenario.input, scenario.code, scenario.message);
  }
});

test("P3 billing coverage: load defaults, explicit operational identity, empty pools, and child dedupe remain observable", () => {
  assert.deepEqual(calculateMbbsCrossCharges({ currency: "CAD", loads: [] }), {
    schemaVersion: "mbbs-local-cross-charge-v1",
    currency: "CAD",
    cases: [],
    allocationGroups: [],
    calculationExplanation: {
      soDeduplication: "root_and_physical_load",
      toDeduplication: "root_globally_first_stable_load",
      poVrmaDeduplication: "type_root_and_physical_load",
      allocation: "sorted_equal_integer_cents_final_root_receives_remainder"
    }
  });

  const result = calculateMbbsCrossCharges({
    currency: "CAD",
    loads: [{
      physicalLoadId: "LOAD-DEFAULTS",
      completedAt: "2038-02-03T04:05:06.000Z",
      truckId: 42,
      driverId: 84,
      calculatedMetres: 9_999,
      sharedTotalMinor: 0,
      references: [
        { sourceType: "SO", rootReference: "SO-DEFAULT", childReference: "SO-DEFAULT-1" },
        { sourceType: "SO", rootReference: "SO-DEFAULT", childReference: "SO-DEFAULT-2" }
      ]
    }]
  });
  assert.deepEqual(result.cases.map((entry) => ({
    planDate: entry.planDate,
    truckId: entry.truckId,
    driverId: entry.driverId,
    metres: entry.calculatedMetres,
    amount: entry.allocatedAmountMinor,
    dedupe: entry.deduplicationKey
  })), [{
    planDate: "2038-02-03",
    truckId: 42,
    driverId: 84,
    metres: 9_999,
    amount: 0,
    dedupe: "SO|SO-DEFAULT|LOAD-DEFAULTS"
  }]);
  assert.deepEqual(result.allocationGroups, []);
});

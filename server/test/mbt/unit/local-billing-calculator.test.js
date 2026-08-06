// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

const CALCULATOR_PATH = "../../../src/mbt/" + "local-billing-calculator.js";
const calculatorModule = /** @type {Record<string, Function>} */ (await import(CALCULATOR_PATH)
  .catch((importError) => ({ importError })));

/** @param {string} name */
function requiredOperation(name) {
  const operation = calculatorModule[name];
  assert.equal(
    typeof operation,
    "function",
    `P3.10 requires local-billing-calculator.${name}.`
  );
  return operation;
}

function exactBillingInput(overrides = {}) {
  return {
    rateCardVersionId: "10000000-0000-4000-8000-000000000001",
    currency: "CAD",
    taxBasisPoints: 1_300,
    contractSnapshot: {
      contractId: "20000000-0000-4000-8000-000000000001",
      revision: 3
    },
    visitSnapshot: {
      serviceVisitId: "30000000-0000-4000-8000-000000000001",
      revision: 4,
      serviceAction: "delivery"
    },
    distanceSnapshot: {
      distanceSnapshotId: "40000000-0000-4000-8000-000000000001",
      provider: "synthetic_route_engine",
      rawMetres: 12_500,
      selectedBandId: "50000000-0000-4000-8000-000000000001",
      amountMinor: 12_000,
      currency: "CAD",
      origin: { kind: "yard", code: "12441" },
      destination: { kind: "customer", code: "SYNTHETIC" }
    },
    localItem: { code: "14YD", revision: 1 },
    components: [
      {
        componentId: "60000000-0000-4000-8000-000000000001",
        lineCode: "rental_daily",
        lineType: "rental",
        rateBasis: "per_day",
        amountMinor: 700,
        quantityMicrounits: 3_000_000,
        taxable: true
      },
      {
        componentId: "60000000-0000-4000-8000-000000000002",
        lineCode: "extension",
        lineType: "extension",
        rateBasis: "flat",
        amountMinor: 1_000,
        taxable: true
      },
      {
        componentId: "60000000-0000-4000-8000-000000000003",
        lineCode: "exchange",
        lineType: "exchange",
        rateBasis: "flat",
        amountMinor: 2_000,
        taxable: true
      },
      {
        componentId: "60000000-0000-4000-8000-000000000004",
        lineCode: "pickup",
        lineType: "pickup",
        rateBasis: "flat",
        amountMinor: 3_000,
        taxable: true
      },
      {
        componentId: "60000000-0000-4000-8000-000000000005",
        lineCode: "fuel_surcharge",
        lineType: "surcharge",
        rateBasis: "percentage",
        percentageBasisPoints: 500,
        taxable: true
      },
      {
        componentId: "60000000-0000-4000-8000-000000000006",
        lineCode: "pilot_discount",
        lineType: "discount",
        rateBasis: "percentage",
        percentageBasisPoints: 1_000,
        taxable: true
      }
    ],
    customPrices: [{
      lineCode: "custom_wash",
      description: "Synthetic custom wash",
      amountMinor: 333,
      taxable: false,
      localItemCode: "CUSTOM_WASH",
      localItemRevision: 2
    }],
    dump: {
      receiptSnapshot: {
        dumpReceiptId: "70000000-0000-4000-8000-000000000001",
        dumpSiteId: "80000000-0000-4000-8000-000000000001",
        materialId: "90000000-0000-4000-8000-000000000001",
        ticketNumber: "SYNTHETIC-1",
        quantityMicrounits: 2_000_000,
        unitOfMeasure: "TONNE",
        subtotalMinor: 4_000,
        taxMinor: 200,
        totalMinor: 4_200,
        currency: "CAD"
      },
      tariff: {
        dumpTariffId: "a0000000-0000-4000-8000-000000000001",
        pricingBasis: "per_quantity",
        unitOfMeasure: "TONNE",
        amountMinor: 2_500,
        minimumAmountMinor: 0,
        currency: "CAD"
      },
      localItem: { code: "DUMP", revision: 1 }
    },
    ...overrides
  };
}

test("P3-F25 calculates every local MBT charge kind in deterministic exact cents", () => {
  const calculateMbtLocalBilling = requiredOperation("calculateMbtLocalBilling");
  const input = exactBillingInput();
  const before = structuredClone(input);
  const result = calculateMbtLocalBilling(input);

  assert.deepEqual(result.lines.map((line) => ({
    lineKey: line.lineKey,
    lineType: line.lineType,
    netAmountMinor: line.netAmountMinor,
    estimatedTaxMinor: line.estimatedTaxMinor,
    totalAmountMinor: line.totalAmountMinor
  })), [
    { lineKey: "transport", lineType: "transport", netAmountMinor: 12_000, estimatedTaxMinor: 1_560, totalAmountMinor: 13_560 },
    { lineKey: "rental_daily", lineType: "rental", netAmountMinor: 2_100, estimatedTaxMinor: 273, totalAmountMinor: 2_373 },
    { lineKey: "extension", lineType: "extension", netAmountMinor: 1_000, estimatedTaxMinor: 130, totalAmountMinor: 1_130 },
    { lineKey: "exchange", lineType: "exchange", netAmountMinor: 2_000, estimatedTaxMinor: 260, totalAmountMinor: 2_260 },
    { lineKey: "pickup", lineType: "pickup", netAmountMinor: 3_000, estimatedTaxMinor: 390, totalAmountMinor: 3_390 },
    { lineKey: "fuel_surcharge", lineType: "surcharge", netAmountMinor: 1_255, estimatedTaxMinor: 163, totalAmountMinor: 1_418 },
    { lineKey: "pilot_discount", lineType: "discount", netAmountMinor: -2_510, estimatedTaxMinor: -326, totalAmountMinor: -2_836 },
    { lineKey: "dump", lineType: "dump", netAmountMinor: 5_000, estimatedTaxMinor: 650, totalAmountMinor: 5_650 },
    { lineKey: "custom_wash", lineType: "custom_price", netAmountMinor: 333, estimatedTaxMinor: 0, totalAmountMinor: 333 }
  ]);
  assert.equal(result.subtotalMinor, 24_178);
  assert.equal(result.estimatedTaxMinor, 3_100);
  assert.equal(result.totalMinor, 27_278);
  assert.equal(result.dumpEconomics.customerChargeMinor, 5_000);
  assert.equal(result.dumpEconomics.actualCostMinor, 4_200);
  assert.equal(result.dumpEconomics.marginMinor, 800);
  assert.equal(result.calculationExplanation.arithmetic, "integer_minor_units_and_quantity_microunits");
  assert.deepEqual(input, before, "The calculator cannot rewrite frozen source evidence.");
});

test("P3-F25 fixed, per-unit, percentage, and signed discount arithmetic has one exact rule", () => {
  const calculateMbtLocalBilling = requiredOperation("calculateMbtLocalBilling");
  const result = calculateMbtLocalBilling(exactBillingInput({
    taxBasisPoints: 0,
    dump: null,
    customPrices: [],
    components: [{
      componentId: "60000000-0000-4000-8000-000000000010",
      lineCode: "half_unit",
      lineType: "rental",
      rateBasis: "per_unit",
      amountMinor: 101,
      quantityMicrounits: 500_000,
      taxable: false
    }, {
      componentId: "60000000-0000-4000-8000-000000000011",
      lineCode: "small_discount",
      lineType: "discount",
      rateBasis: "percentage",
      percentageBasisPoints: 3_330,
      taxable: false
    }]
  }));
  assert.deepEqual(result.lines.map(({ lineKey, netAmountMinor }) => ({ lineKey, netAmountMinor })), [
    { lineKey: "transport", netAmountMinor: 12_000 },
    { lineKey: "half_unit", netAmountMinor: 51 },
    { lineKey: "small_discount", netAmountMinor: -4_013 }
  ]);
  assert.equal(result.subtotalMinor, 8_038);
});

test("P3-F25 rejects fractional cents, unsafe arithmetic, currency drift, duplicates, and negative totals", () => {
  const calculateMbtLocalBilling = requiredOperation("calculateMbtLocalBilling");
  const cases = [
    exactBillingInput({ distanceSnapshot: { ...exactBillingInput().distanceSnapshot, amountMinor: 1.5 } }),
    exactBillingInput({ distanceSnapshot: { ...exactBillingInput().distanceSnapshot, amountMinor: Number.MAX_SAFE_INTEGER } }),
    exactBillingInput({ distanceSnapshot: { ...exactBillingInput().distanceSnapshot, currency: "USD" } }),
    exactBillingInput({ customPrices: [{ lineCode: "transport", amountMinor: 1, taxable: false, localItemCode: "DUP", localItemRevision: 1 }] }),
    exactBillingInput({
      dump: null,
      customPrices: [],
      components: [{
        componentId: "60000000-0000-4000-8000-000000000012",
        lineCode: "impossible_discount",
        lineType: "discount",
        rateBasis: "flat",
        amountMinor: 99_999,
        taxable: false
      }]
    })
  ];
  for (const input of cases) {
    assert.throws(
      () => calculateMbtLocalBilling(input),
      (error) => typeof error?.code === "string" && error.code.startsWith("MBT_BILLING_")
    );
  }
});

test("P3-F26 SO, split-SO, TO, PO, and VRMA rules produce stable dedupe and cent-conserving allocation", () => {
  const calculateMbbsCrossCharges = requiredOperation("calculateMbbsCrossCharges");
  const loads = [{
    physicalLoadId: "LOAD-A",
    completedAt: "2038-01-01T12:00:00.000Z",
    sharedTotalMinor: 1_001,
    references: [
      { sourceType: "SO", rootReference: "SO-1", childReference: "SO-1-A" },
      { sourceType: "SO", rootReference: "SO-1", childReference: "SO-1-B" },
      { sourceType: "TO", rootReference: "TO-1" },
      { sourceType: "PO", rootReference: "PO-1" },
      { sourceType: "VRMA", rootReference: "VRMA-1" }
    ]
  }, {
    physicalLoadId: "LOAD-B",
    completedAt: "2038-01-02T12:00:00.000Z",
    sharedTotalMinor: 501,
    references: [{ sourceType: "TO", rootReference: "TO-1" }]
  }];
  const result = calculateMbbsCrossCharges({ currency: "CAD", loads });

  assert.deepEqual(result.cases.map(({ deduplicationKey, allocatedAmountMinor }) => ({
    deduplicationKey,
    allocatedAmountMinor
  })), [
    { deduplicationKey: "SO|SO-1|LOAD-A", allocatedAmountMinor: 1_001 },
    { deduplicationKey: "TO|TO-1", allocatedAmountMinor: 1_001 },
    { deduplicationKey: "PO|PO-1|LOAD-A", allocatedAmountMinor: 500 },
    { deduplicationKey: "VRMA|VRMA-1|LOAD-A", allocatedAmountMinor: 501 }
  ]);
  assert.equal(result.cases.filter((entry) => entry.sourceType === "SO").length, 1);
  assert.equal(result.cases.filter((entry) => entry.sourceType === "TO").length, 1);
  assert.deepEqual(result.allocationGroups.map((group) => ({
    allocationKey: group.allocationKey,
    sharedTotalMinor: group.sharedTotalMinor,
    allocatedMinor: group.allocations.reduce((sum, allocation) => sum + allocation.allocatedAmountMinor, 0),
    remainderRecipient: group.allocations.at(-1)?.rootReference
  })), [{
    allocationKey: "NON_SO|LOAD-A",
    sharedTotalMinor: 1_001,
    allocatedMinor: 1_001,
    remainderRecipient: "VRMA-1"
  }]);
});

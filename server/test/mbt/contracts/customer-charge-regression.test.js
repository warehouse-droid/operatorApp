// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  CUSTOMER_CHARGE_SCENARIOS,
  REAL_RATE_CATALOG,
  generateOneHundredContractOrders
} from "./customer-charge-scenario-catalog.js";

const MODULE_PATH = "../../../src/mbt/" + "customer-charge-calculator.js";
const calculatorModule = /** @type {Record<string, any>} */ (await import(MODULE_PATH).catch(() => ({})));

function calculator() {
  assert.equal(
    typeof calculatorModule.calculateCustomerCharge,
    "function",
    "The real MBT customer-charge calculator must exist before this regression contract can pass."
  );
  return calculatorModule.calculateCustomerCharge;
}

/**
 * This intentionally does not import any production pricing helpers. It is a
 * compact accounting oracle for the fixed test catalog, so a production line
 * omission or tax/deposit regression cannot validate itself.
 *
 * @param {number} amountMinor
 * @param {number} numerator
 * @param {number} denominator
 */
function oracleRoundedRatio(amountMinor, numerator, denominator) {
  const sign = amountMinor < 0 ? -1n : 1n;
  const absoluteProduct = BigInt(Math.abs(amountMinor)) * BigInt(numerator);
  return Number(sign * ((absoluteProduct + (BigInt(denominator) / 2n)) / BigInt(denominator)));
}

/** @param {number} configuredAmountMinor @param {boolean} cash */
function oracleTaxedAmount(configuredAmountMinor, cash) {
  const includedHstMinor = cash
    ? oracleRoundedRatio(configuredAmountMinor, REAL_RATE_CATALOG.hstBasisPoints, 11_300)
    : 0;
  const addedHstMinor = cash
    ? 0
    : oracleRoundedRatio(configuredAmountMinor, REAL_RATE_CATALOG.hstBasisPoints, 10_000);
  return {
    configuredAmountMinor,
    preTaxAmountMinor: cash ? configuredAmountMinor - includedHstMinor : configuredAmountMinor,
    includedHstMinor,
    addedHstMinor,
    customerAmountMinor: cash ? configuredAmountMinor : configuredAmountMinor + addedHstMinor
  };
}

/** @param {Record<string, any>} bin */
function oracleBinLines(bin) {
  if (!bin) {
    return [];
  }
  const catalogRate = REAL_RATE_CATALOG.binRates[bin.incomingContentCode]?.[bin.incomingBinSizeYards];
  assert.ok(catalogRate, `Missing oracle rate for ${bin.incomingContentCode} ${bin.incomingBinSizeYards}YD.`);
  assert.deepEqual({
    rentalMinor: bin.rentalMinor,
    transportMinor: bin.transportMinor,
    fixedDumpMinor: bin.fixedDumpMinor,
    depositMinor: bin.depositMinor
  }, catalogRate);
  const paymentTiming = bin.incomingContentCode === "garbage" ? "contract_balance" : "due_now";
  const lines = [];
  if (catalogRate.rentalMinor > 0) {
    lines.push({ lineType: "bin_rental", amountMinor: catalogRate.rentalMinor, paymentTiming });
  }
  if (catalogRate.fixedDumpMinor > 0) {
    lines.push({ lineType: "fixed_dump", amountMinor: catalogRate.fixedDumpMinor, paymentTiming });
  }
  if (catalogRate.transportMinor > 0) {
    lines.push({ lineType: "bin_transport", amountMinor: catalogRate.transportMinor, paymentTiming });
  }
  if (bin.discountMinor > 0) {
    lines.push({ lineType: "bin_discount", amountMinor: -bin.discountMinor, paymentTiming });
  }
  return lines;
}

/** @param {Record<string, any>} rawRequest @param {number} currentContractTotalMinor */
function independentExpectedCharge(rawRequest, currentContractTotalMinor) {
  const cash = rawRequest.paymentMethod === "cash";
  /** @type {Array<Record<string, any>>} */
  const lines = oracleBinLines(rawRequest.bin);
  const bin = rawRequest.bin;
  for (const aggregate of rawRequest.aggregateLines) {
    const catalogRate = REAL_RATE_CATALOG.aggregateRates[aggregate.itemCode];
    assert.ok(catalogRate, `Missing oracle rate for ${aggregate.itemCode}.`);
    assert.deepEqual({
      displayName: aggregate.displayName,
      unitAmountMinor: aggregate.unitAmountMinor,
      densityLbsPerYard: aggregate.densityLbsPerYard
    }, catalogRate);
    lines.push({
      lineType: "aggregate_material",
      amountMinor: oracleRoundedRatio(catalogRate.unitAmountMinor, aggregate.quantityMilliYards, 1_000),
      paymentTiming: "due_now"
    });
  }
  if (rawRequest.kind === "aggregate_order") {
    assert.deepEqual(rawRequest.aggregateDistanceBands, REAL_RATE_CATALOG.aggregateDistanceBands);
    const band = REAL_RATE_CATALOG.aggregateDistanceBands.find((candidate, index) => (
      (index === 0
        ? rawRequest.distanceMetres >= candidate.minimumMetres
        : rawRequest.distanceMetres > candidate.minimumMetres)
      && (candidate.maximumMetres === null || rawRequest.distanceMetres <= candidate.maximumMetres)
    ));
    assert.ok(band, `No oracle delivery band covers ${rawRequest.distanceMetres}m.`);
    lines.push({ lineType: "aggregate_delivery", amountMinor: band.amountMinor, paymentTiming: "due_now" });
  } else if (rawRequest.aggregateLines.length > 0) {
    assert.equal(rawRequest.loadingFeeMinor, REAL_RATE_CATALOG.loadingFeeMinor);
    lines.push({
      lineType: "aggregate_loading_fee",
      amountMinor: REAL_RATE_CATALOG.loadingFeeMinor,
      paymentTiming: "due_now"
    });
  }
  const taxedLines = lines.map((line) => ({
    lineType: line.lineType,
    paymentTiming: line.paymentTiming,
    ...oracleTaxedAmount(line.amountMinor, cash)
  }));
  const sum = (field) => taxedLines.reduce((total, line) => total + line[field], 0);
  const requiredDepositMinor = bin?.incomingContentCode === "garbage" ? bin.depositMinor : 0;
  const dueRevenueMinor = taxedLines
    .filter((line) => line.paymentTiming === "due_now")
    .reduce((total, line) => total + line.customerAmountMinor, 0);
  const newRequestChargeableMinor = sum("customerAmountMinor");
  return {
    lines: taxedLines,
    preTaxRevenueMinor: sum("preTaxAmountMinor"),
    includedHstMinor: sum("includedHstMinor"),
    addedHstMinor: sum("addedHstMinor"),
    newRequestChargeableMinor,
    currentContractTotalMinor,
    resultingContractTotalMinor: currentContractTotalMinor + newRequestChargeableMinor,
    requiredDepositMinor,
    dueNowMinor: dueRevenueMinor + requiredDepositMinor
  };
}

test("customer charge scenario catalog records every currently supported request family", () => {
  assert.deepEqual(CUSTOMER_CHARGE_SCENARIOS, [
    "initial_garbage_14_cash",
    "initial_garbage_20_card",
    "initial_garbage_40_cash_with_discount",
    "initial_soil_14_card",
    "initial_asphalt_14_cash",
    "initial_concrete_14_card",
    "add_garbage_cash",
    "add_garbage_card_with_aggregate",
    "add_soil_cash",
    "add_asphalt_card",
    "add_concrete_cash_with_aggregate",
    "exchange_garbage_to_garbage_same_size_cash",
    "exchange_garbage_to_garbage_upgrade_card",
    "exchange_garbage_to_garbage_downgrade_cash_with_aggregate",
    "exchange_garbage_to_soil_card",
    "exchange_garbage_to_asphalt_cash_with_aggregate",
    "exchange_garbage_to_concrete_card",
    "exchange_soil_to_garbage_cash",
    "exchange_asphalt_to_garbage_card_with_aggregate",
    "exchange_concrete_to_garbage_card",
    "exchange_soil_to_asphalt_cash",
    "exchange_asphalt_to_concrete_card_with_aggregate",
    "exchange_concrete_to_soil_cash",
    "standalone_aggregate_cash_within_30km",
    "standalone_aggregate_card_exactly_30km",
    "standalone_aggregate_card_over_30km",
    "standalone_aggregate_cash_multiple_materials",
    "mixed_payment_cash_initial_card_exchange_with_aggregate"
  ]);
});

test("cash CAD 100 is tax-included while card CAD 100 adds HST exactly once", () => {
  const calculate = calculator();
  const common = {
    kind: "add_bin",
    currentContractTotalMinor: 50_000,
    orderFrom150: false,
    currency: "CAD",
    taxRateBasisPoints: 1_300,
    bin: {
      incomingContentCode: "garbage",
      incomingBinSizeYards: 14,
      outgoingContentCode: null,
      outgoingBinSizeYards: null,
      rentalMinor: 10_000,
      transportMinor: 0,
      fixedDumpMinor: 0,
      depositMinor: 2_500,
      discountMinor: 0,
      discountReason: null
    },
    aggregateLines: [],
    loadingFeeMinor: 5_000
  };
  const cash = calculate({ ...common, paymentMethod: "cash" });
  assert.deepEqual({
    preTaxRevenueMinor: cash.preTaxRevenueMinor,
    includedHstMinor: cash.includedHstMinor,
    addedHstMinor: cash.addedHstMinor,
    newRequestChargeableMinor: cash.newRequestChargeableMinor,
    resultingContractTotalMinor: cash.resultingContractTotalMinor,
    requiredDepositMinor: cash.requiredDepositMinor,
    dueNowMinor: cash.dueNowMinor,
    exportPolicy: cash.netsuiteExportPolicy
  }, {
    preTaxRevenueMinor: 8_850,
    includedHstMinor: 1_150,
    addedHstMinor: 0,
    newRequestChargeableMinor: 10_000,
    resultingContractTotalMinor: 60_000,
    requiredDepositMinor: 2_500,
    dueNowMinor: 2_500,
    exportPolicy: "excluded_cash"
  });
  const card = calculate({ ...common, paymentMethod: "card" });
  assert.deepEqual({
    preTaxRevenueMinor: card.preTaxRevenueMinor,
    includedHstMinor: card.includedHstMinor,
    addedHstMinor: card.addedHstMinor,
    newRequestChargeableMinor: card.newRequestChargeableMinor,
    resultingContractTotalMinor: card.resultingContractTotalMinor,
    requiredDepositMinor: card.requiredDepositMinor,
    dueNowMinor: card.dueNowMinor,
    exportPolicy: card.netsuiteExportPolicy,
    futureLineTaxAmounts: card.netsuiteReadySnapshot.lines.map((line) => line.taxAmountMinor)
  }, {
    preTaxRevenueMinor: 10_000,
    includedHstMinor: 0,
    addedHstMinor: 1_300,
    newRequestChargeableMinor: 11_300,
    resultingContractTotalMinor: 61_300,
    requiredDepositMinor: 2_500,
    dueNowMinor: 2_500,
    exportPolicy: "eligible_non_cash",
    futureLineTaxAmounts: [undefined]
  });
});

test("cash first request and card exchange with aggregate keep independent locked tax treatments", () => {
  const calculate = calculator();
  const [history] = generateOneHundredContractOrders();
  const first = calculate(history.requests[0]);
  const secondInput = {
    ...history.requests[1],
    paymentMethod: "card",
    currentContractTotalMinor: first.resultingContractTotalMinor
  };
  const second = calculate(secondInput);
  assert.equal(first.paymentCategory, "cash");
  assert.equal(first.addedHstMinor, 0);
  assert.equal(first.netsuiteExportPolicy, "excluded_cash");
  assert.equal(second.paymentCategory, "non_cash");
  assert.equal(second.includedHstMinor, 0);
  assert.equal(second.addedHstMinor > 0, true);
  assert.equal(second.netsuiteExportPolicy, "eligible_non_cash");
  assert.equal(second.currentContractTotalMinor, first.resultingContractTotalMinor);
  assert.equal(
    second.resultingContractTotalMinor,
    first.resultingContractTotalMinor + second.newRequestChargeableMinor
  );
});

test("every incoming garbage exchange collects its configured deposit while non-garbage exchange revenue is fully due", () => {
  const calculate = calculator();
  const common = {
    kind: "exchange_bin",
    currentContractTotalMinor: 50_000,
    orderFrom150: false,
    currency: "CAD",
    taxRateBasisPoints: 1_300,
    aggregateLines: [],
    loadingFeeMinor: 5_000
  };
  const garbage = calculate({
    ...common,
    paymentMethod: "cash",
    bin: {
      incomingContentCode: "garbage",
      incomingBinSizeYards: 20,
      outgoingContentCode: "garbage",
      outgoingBinSizeYards: 14,
      rentalMinor: 45_000,
      transportMinor: 19_000,
      fixedDumpMinor: 0,
      depositMinor: 12_500,
      discountMinor: 0
    }
  });
  assert.equal(garbage.requiredDepositMinor, 12_500);
  assert.equal(garbage.dueNowMinor, 12_500);

  const soil = calculate({
    ...common,
    paymentMethod: "card",
    bin: {
      incomingContentCode: "soil",
      incomingBinSizeYards: 14,
      outgoingContentCode: "garbage",
      outgoingBinSizeYards: 20,
      rentalMinor: 35_000,
      transportMinor: 12_500,
      fixedDumpMinor: 85_000,
      depositMinor: 12_500,
      discountMinor: 0
    }
  });
  assert.equal(soil.requiredDepositMinor, 0);
  assert.equal(soil.newRequestChargeableMinor, 149_725);
  assert.equal(soil.dueNowMinor, 149_725);
});

test("standalone aggregate enforces the CAD 150 through-30km standard and increasing later bands", () => {
  const calculate = calculator();
  const request = {
    kind: "aggregate_order",
    paymentMethod: "card",
    currentContractTotalMinor: 0,
    orderFrom150: true,
    distanceMetres: 30_000,
    aggregateLines: [{
      itemCode: "AGG_HPB",
      displayName: "HPB",
      quantityMilliYards: 1_000,
      unitAmountMinor: 6_500,
      densityLbsPerYard: 2_600
    }],
    loadingFeeMinor: 5_000,
    taxRateBasisPoints: 1_300,
    currency: "CAD"
  };
  assert.throws(() => calculate({
    ...request,
    aggregateDistanceBands: [
      { bandCode: "WRONG_BASE", minimumMetres: 0, maximumMetres: 30_000, amountMinor: 14_999 },
      { bandCode: "NEXT", minimumMetres: 30_000, maximumMetres: null, amountMinor: 20_000 }
    ]
  }), (error) => error?.code === "MBT_CHARGE_AGGREGATE_DISTANCE_BANDS_INVALID");
  assert.throws(() => calculate({
    ...request,
    aggregateDistanceBands: [
      { bandCode: "BASE", minimumMetres: 0, maximumMetres: 30_000, amountMinor: 15_000 },
      { bandCode: "NOT_INCREASING", minimumMetres: 30_000, maximumMetres: null, amountMinor: 15_000 }
    ]
  }), (error) => error?.code === "MBT_CHARGE_AGGREGATE_DISTANCE_BANDS_INVALID");
});

test("seed 20260809 calculates 100 real-rate contract histories and covers the entire scenario catalog", () => {
  const calculate = calculator();
  const histories = generateOneHundredContractOrders(20_260_809);
  assert.equal(histories.length, 100);
  assert.deepEqual(
    [...new Set(histories.map((history) => history.scenarioCode))].sort(),
    [...CUSTOMER_CHARGE_SCENARIOS].sort()
  );
  let requestCount = 0;
  let cashCount = 0;
  let nonCashCount = 0;
  let aggregateCount = 0;
  let exchangeCount = 0;
  for (const history of histories) {
    let committedTotalMinor = 0;
    for (const rawRequest of history.requests) {
      const request = calculate({ ...rawRequest, currentContractTotalMinor: committedTotalMinor });
      const expected = independentExpectedCharge(rawRequest, committedTotalMinor);
      requestCount += 1;
      cashCount += request.paymentCategory === "cash" ? 1 : 0;
      nonCashCount += request.paymentCategory === "non_cash" ? 1 : 0;
      aggregateCount += request.lines.some((line) => line.lineType === "aggregate_material") ? 1 : 0;
      exchangeCount += request.kind === "exchange_bin" ? 1 : 0;
      assert.equal(request.currentContractTotalMinor, committedTotalMinor);
      assert.equal(
        request.resultingContractTotalMinor,
        request.currentContractTotalMinor + request.newRequestChargeableMinor
      );
      assert.equal(
        request.newRequestChargeableMinor,
        request.lines.reduce((total, line) => total + line.customerAmountMinor, 0)
      );
      assert.equal(request.requiredDepositMinor >= 0, true);
      assert.equal(request.dueNowMinor >= request.requiredDepositMinor, true);
      assert.equal(Number.isSafeInteger(request.resultingContractTotalMinor), true);
      assert.deepEqual({
        lines: request.lines.map((line) => ({
          lineType: line.lineType,
          paymentTiming: line.paymentTiming,
          configuredAmountMinor: line.configuredAmountMinor,
          preTaxAmountMinor: line.preTaxAmountMinor,
          includedHstMinor: line.includedHstMinor,
          addedHstMinor: line.addedHstMinor,
          customerAmountMinor: line.customerAmountMinor
        })),
        preTaxRevenueMinor: request.preTaxRevenueMinor,
        includedHstMinor: request.includedHstMinor,
        addedHstMinor: request.addedHstMinor,
        newRequestChargeableMinor: request.newRequestChargeableMinor,
        currentContractTotalMinor: request.currentContractTotalMinor,
        resultingContractTotalMinor: request.resultingContractTotalMinor,
        requiredDepositMinor: request.requiredDepositMinor,
        dueNowMinor: request.dueNowMinor
      }, expected, `${history.contractNumber} ${rawRequest.kind} must match the independent rate oracle.`);
      if (request.paymentCategory === "cash") {
        assert.equal(request.addedHstMinor, 0);
        assert.equal(request.netsuiteReadySnapshot, null);
      } else {
        assert.equal(request.includedHstMinor, 0);
        assert.equal(request.netsuiteReadySnapshot.taxMode, "netsuite_calculated");
        assert.equal(request.netsuiteReadySnapshot.lines.some((line) => line.lineType === "tax"), false);
        assert.equal(
          request.netsuiteReadySnapshot.lines.reduce((sum, line) => sum + line.amountExcludingTaxMinor, 0),
          request.preTaxRevenueMinor
        );
      }
      committedTotalMinor = request.resultingContractTotalMinor;
    }
  }
  assert.equal(requestCount, 234);
  assert.equal(cashCount > 50, true);
  assert.equal(nonCashCount > 50, true);
  assert.equal(aggregateCount > 20, true);
  assert.equal(exchangeCount > 40, true);
});

test("the generated mixed-payment history is cash first then card exchange with aggregate", () => {
  const history = generateOneHundredContractOrders(20_260_809).find(
    (candidate) => candidate.scenarioCode === "mixed_payment_cash_initial_card_exchange_with_aggregate"
  );
  assert.ok(history);
  assert.deepEqual(history.requests.slice(0, 2).map((request) => request.paymentMethod), ["cash", "card"]);
  assert.equal(history.requests[1].kind, "exchange_bin");
  assert.equal(history.requests[1].aggregateLines.length > 0, true);
});

test("non-garbage bins reject every size except 14YD and aggregate combinations require Order from 150", () => {
  const calculate = calculator();
  assert.throws(() => calculate({
    kind: "add_bin",
    paymentMethod: "card",
    currentContractTotalMinor: 0,
    orderFrom150: false,
    currency: "CAD",
    taxRateBasisPoints: 1_300,
    bin: {
      incomingContentCode: "soil",
      incomingBinSizeYards: 20,
      rentalMinor: 10_000,
      transportMinor: 10_000,
      fixedDumpMinor: 50_000,
      depositMinor: 0,
      discountMinor: 0
    },
    aggregateLines: [],
    loadingFeeMinor: 5_000
  }), (error) => error?.code === "MBT_CHARGE_BIN_CONTENT_SIZE_INVALID");
  assert.throws(() => calculate({
    kind: "add_bin",
    paymentMethod: "cash",
    currentContractTotalMinor: 0,
    orderFrom150: false,
    currency: "CAD",
    taxRateBasisPoints: 1_300,
    bin: {
      incomingContentCode: "garbage",
      incomingBinSizeYards: 14,
      rentalMinor: 10_000,
      transportMinor: 10_000,
      fixedDumpMinor: 0,
      depositMinor: 2_500,
      discountMinor: 0
    },
    aggregateLines: [{
      itemCode: "AGG_HPB",
      displayName: "HPB",
      quantityMilliYards: 1_000,
      unitAmountMinor: 6_500,
      densityLbsPerYard: 2_600
    }],
    loadingFeeMinor: 5_000
  }), (error) => error?.code === "MBT_CHARGE_AGGREGATE_ORIGIN_REQUIRED");
});

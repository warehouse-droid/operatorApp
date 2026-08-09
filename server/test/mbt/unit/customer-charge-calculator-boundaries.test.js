// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { calculateCustomerCharge } from "../../../src/mbt/customer-charge-calculator.js";

const MAX_CENTS = Number.MAX_SAFE_INTEGER;

const BASE_BIN = Object.freeze({
  incomingContentCode: "garbage",
  incomingBinSizeYards: 14,
  rentalMinor: 10_000,
  transportMinor: 2_500,
  fixedDumpMinor: 0,
  depositMinor: 5_000,
  discountMinor: 0,
  discountReason: null
});

const BASE_CHARGE = Object.freeze({
  kind: "add_bin",
  paymentMethod: "cash",
  currentContractTotalMinor: 50_000,
  orderFrom150: false,
  currency: "CAD",
  taxRateBasisPoints: 1_300,
  bin: BASE_BIN,
  aggregateLines: [],
  loadingFeeMinor: 5_000
});

const BASE_AGGREGATE_LINE = Object.freeze({
  itemCode: "AGG_HPB",
  displayName: "HPB",
  quantityMilliYards: 1_000,
  unitAmountMinor: 6_500,
  densityLbsPerYard: 2_600
});

const BASE_BANDS = Object.freeze([
  Object.freeze({ bandCode: "AGG_0_30", minimumMetres: 0, maximumMetres: 30_000, amountMinor: 15_000 }),
  Object.freeze({ bandCode: "AGG_30_PLUS", minimumMetres: 30_000, maximumMetres: null, amountMinor: 20_000 })
]);

/** @param {Record<string, any>} [patch] */
function binCharge(patch = {}) {
  return {
    ...structuredClone(BASE_CHARGE),
    ...patch,
    bin: Object.hasOwn(patch, "bin") ? patch.bin : structuredClone(BASE_BIN),
    aggregateLines: Object.hasOwn(patch, "aggregateLines") ? patch.aggregateLines : []
  };
}

/** @param {Record<string, any>} [patch] */
function aggregateCharge(patch = {}) {
  return {
    kind: "aggregate_order",
    paymentMethod: "card",
    currentContractTotalMinor: 0,
    orderFrom150: true,
    currency: "CAD",
    taxRateBasisPoints: 1_300,
    aggregateLines: [structuredClone(BASE_AGGREGATE_LINE)],
    aggregateDistanceBands: structuredClone(BASE_BANDS),
    distanceMetres: 30_000,
    loadingFeeMinor: 5_000,
    ...patch
  };
}

/** @param {unknown} input @param {string} code */
function rejectsCharge(input, code) {
  assert.throws(
    () => calculateCustomerCharge(input),
    (error) => error?.code === code && Number(error?.status) >= 400
  );
}

test("customer-charge calculator rejects every malformed money, bin, and payment boundary", () => {
  const cases = [
    [null, "MBT_CHARGE_INPUT_INVALID"],
    [[], "MBT_CHARGE_INPUT_INVALID"],
    [binCharge({ kind: "" }), "MBT_CHARGE_INPUT_INVALID"],
    [binCharge({ kind: "collection" }), "MBT_CHARGE_REQUEST_KIND_INVALID"],
    [binCharge({ paymentMethod: "" }), "MBT_CHARGE_INPUT_INVALID"],
    [binCharge({ paymentMethod: "bitcoin" }), "MBT_CHARGE_PAYMENT_METHOD_INVALID"],
    [binCharge({ currency: "USD" }), "MBT_CHARGE_CURRENCY_INVALID"],
    [binCharge({ taxRateBasisPoints: 1_299 }), "MBT_CHARGE_TAX_CONFIGURATION_INVALID"],
    [binCharge({ currentContractTotalMinor: -1 }), "MBT_CHARGE_INPUT_INVALID"],
    [binCharge({ bin: null }), "MBT_CHARGE_INPUT_INVALID"],
    [binCharge({ bin: [] }), "MBT_CHARGE_INPUT_INVALID"],
    [binCharge({ bin: { ...BASE_BIN, incomingContentCode: "" } }), "MBT_CHARGE_INPUT_INVALID"],
    [binCharge({ bin: { ...BASE_BIN, incomingContentCode: "wood" } }), "MBT_CHARGE_CONTENT_INVALID"],
    [binCharge({ bin: { ...BASE_BIN, incomingBinSizeYards: 0 } }), "MBT_CHARGE_INPUT_INVALID"],
    [binCharge({ bin: { ...BASE_BIN, incomingBinSizeYards: 15 } }), "MBT_CHARGE_BIN_SIZE_INVALID"],
    [binCharge({ bin: { ...BASE_BIN, incomingContentCode: "soil", incomingBinSizeYards: 20,
      fixedDumpMinor: 85_000 } }), "MBT_CHARGE_BIN_CONTENT_SIZE_INVALID"],
    [binCharge({ kind: "exchange_bin", bin: { ...BASE_BIN, outgoingContentCode: "",
      outgoingBinSizeYards: 14 } }), "MBT_CHARGE_INPUT_INVALID"],
    [binCharge({ kind: "exchange_bin", bin: { ...BASE_BIN, outgoingContentCode: "soil",
      outgoingBinSizeYards: 20 } }), "MBT_CHARGE_BIN_CONTENT_SIZE_INVALID"],
    [binCharge({ bin: { ...BASE_BIN, rentalMinor: 0.5 } }), "MBT_CHARGE_INPUT_INVALID"],
    [binCharge({ bin: { ...BASE_BIN, rentalMinor: MAX_CENTS, transportMinor: 1 } }),
      "MBT_CHARGE_MONEY_OVERFLOW"],
    [binCharge({ bin: { ...BASE_BIN, fixedDumpMinor: 1 } }), "MBT_CHARGE_GARBAGE_DUMP_FEE_FORBIDDEN"],
    [binCharge({ bin: { ...BASE_BIN, incomingContentCode: "soil", fixedDumpMinor: 0 } }),
      "MBT_CHARGE_FIXED_DUMP_RATE_REQUIRED"],
    [binCharge({ bin: { ...BASE_BIN, discountMinor: 20_000 } }), "MBT_CHARGE_DISCOUNT_EXCEEDS_BIN"],
    [binCharge({ bin: { ...BASE_BIN, discountMinor: 1, discountReason: "" } }),
      "MBT_CHARGE_DISCOUNT_REASON_REQUIRED"]
  ];
  for (const [input, code] of cases) {
    rejectsCharge(input, code);
  }
});

test("customer-charge calculator rejects malformed aggregate and distance-band evidence", () => {
  const aggregate = structuredClone(BASE_AGGREGATE_LINE);
  const cases = [
    [aggregateCharge({ aggregateLines: "HPB" }), "MBT_CHARGE_AGGREGATE_INVALID"],
    [aggregateCharge({ aggregateLines: Array.from({ length: 5 }, (_, index) => ({
      ...aggregate, itemCode: `AGG_${index}`
    })) }), "MBT_CHARGE_AGGREGATE_INVALID"],
    [aggregateCharge({ aggregateLines: [null] }), "MBT_CHARGE_INPUT_INVALID"],
    [aggregateCharge({ aggregateLines: [{ ...aggregate, itemCode: "HPB" }] }), "MBT_CHARGE_AGGREGATE_INVALID"],
    [aggregateCharge({ aggregateLines: [aggregate, aggregate] }), "MBT_CHARGE_AGGREGATE_INVALID"],
    [aggregateCharge({ aggregateLines: [{ ...aggregate, quantityMilliYards: 0 }] }), "MBT_CHARGE_INPUT_INVALID"],
    [aggregateCharge({ aggregateLines: [{ ...aggregate, unitAmountMinor: 0 }] }), "MBT_CHARGE_INPUT_INVALID"],
    [aggregateCharge({ aggregateLines: [{ ...aggregate, densityLbsPerYard: 0 }] }), "MBT_CHARGE_INPUT_INVALID"],
    [aggregateCharge({ aggregateLines: [{ ...aggregate, unitAmountMinor: MAX_CENTS,
      quantityMilliYards: 2_000 }] }), "MBT_CHARGE_MONEY_OVERFLOW"],
    [aggregateCharge({ aggregateLines: [{ ...aggregate, densityLbsPerYard: MAX_CENTS,
      quantityMilliYards: 2_000 }] }), "MBT_CHARGE_MONEY_OVERFLOW"],
    [aggregateCharge({ aggregateDistanceBands: null }), "MBT_CHARGE_AGGREGATE_DISTANCE_RATE_REQUIRED"],
    [aggregateCharge({ aggregateDistanceBands: [] }), "MBT_CHARGE_AGGREGATE_DISTANCE_RATE_REQUIRED"],
    [aggregateCharge({ aggregateDistanceBands: [null] }), "MBT_CHARGE_INPUT_INVALID"],
    [aggregateCharge({ aggregateDistanceBands: [{ ...BASE_BANDS[0], bandCode: "" }] }),
      "MBT_CHARGE_AGGREGATE_DISTANCE_BANDS_INVALID"],
    [aggregateCharge({ aggregateDistanceBands: [{ ...BASE_BANDS[0], maximumMetres: 0 }] }),
      "MBT_CHARGE_AGGREGATE_DISTANCE_BANDS_INVALID"],
    [aggregateCharge({ aggregateDistanceBands: [{ ...BASE_BANDS[0], minimumMetres: 1 }] }),
      "MBT_CHARGE_AGGREGATE_DISTANCE_BANDS_INVALID"],
    [aggregateCharge({ aggregateDistanceBands: [{ ...BASE_BANDS[0], maximumMetres: 29_999 }] }),
      "MBT_CHARGE_AGGREGATE_DISTANCE_BANDS_INVALID"],
    [aggregateCharge({ aggregateDistanceBands: [{ ...BASE_BANDS[0], amountMinor: 14_999 }] }),
      "MBT_CHARGE_AGGREGATE_DISTANCE_BANDS_INVALID"],
    [aggregateCharge({ aggregateDistanceBands: [BASE_BANDS[0], { ...BASE_BANDS[1], minimumMetres: 30_001 }] }),
      "MBT_CHARGE_AGGREGATE_DISTANCE_BANDS_INVALID"],
    [aggregateCharge({ aggregateDistanceBands: [BASE_BANDS[0], { ...BASE_BANDS[1], amountMinor: 15_000 }] }),
      "MBT_CHARGE_AGGREGATE_DISTANCE_BANDS_INVALID"],
    [aggregateCharge({ aggregateDistanceBands: [BASE_BANDS[0]], distanceMetres: 30_001 }),
      "MBT_CHARGE_AGGREGATE_DISTANCE_OUT_OF_RANGE"],
    [aggregateCharge({ aggregateLines: [] }), "MBT_CHARGE_AGGREGATE_REQUIRED"],
    [binCharge({ orderFrom150: false, aggregateLines: [aggregate] }), "MBT_CHARGE_AGGREGATE_ORIGIN_REQUIRED"],
    [binCharge({ orderFrom150: true, aggregateLines: [aggregate], loadingFeeMinor: -1 }),
      "MBT_CHARGE_INPUT_INVALID"]
  ];
  for (const [input, code] of cases) {
    rejectsCharge(input, code);
  }
});

test("customer-charge calculator covers zero-line defaults and every safe-cent overflow seam", () => {
  const defaults = calculateCustomerCharge({
    ...binCharge({ paymentMethod: "debit", currentContractTotalMinor: 0 }),
    currency: undefined,
    taxRateBasisPoints: undefined,
    bin: { ...BASE_BIN, rentalMinor: 0, transportMinor: 0, depositMinor: 0 }
  });
  assert.equal(defaults.lines.length, 0);
  assert.equal(defaults.currency, "CAD");
  assert.equal(defaults.taxRateBasisPoints, 1_300);

  rejectsCharge(
    binCharge({ currentContractTotalMinor: MAX_CENTS }),
    "MBT_CHARGE_MONEY_OVERFLOW"
  );
  rejectsCharge(
    binCharge({
      orderFrom150: true,
      aggregateLines: [BASE_AGGREGATE_LINE],
      bin: { ...BASE_BIN, depositMinor: MAX_CENTS }
    }),
    "MBT_CHARGE_MONEY_OVERFLOW"
  );
  rejectsCharge(
    aggregateCharge({
      aggregateLines: [
        { ...BASE_AGGREGATE_LINE, itemCode: "AGG_ONE", unitAmountMinor: MAX_CENTS,
          quantityMilliYards: 600 },
        { ...BASE_AGGREGATE_LINE, itemCode: "AGG_TWO", unitAmountMinor: MAX_CENTS,
          quantityMilliYards: 600 }
      ]
    }),
    "MBT_CHARGE_MONEY_OVERFLOW"
  );
});

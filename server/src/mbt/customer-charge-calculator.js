// @ts-check

import { MbtError } from "./errors.js";

export const CUSTOMER_CHARGE_REQUEST_KINDS = Object.freeze([
  "initial_bin",
  "add_bin",
  "exchange_bin",
  "aggregate_order"
]);

export const CUSTOMER_CHARGE_PAYMENT_METHODS = Object.freeze([
  "cash",
  "card",
  "debit",
  "e_transfer",
  "cheque",
  "account",
  "non_cash"
]);

export const CUSTOMER_CHARGE_CONTENT_CODES = Object.freeze([
  "garbage",
  "soil",
  "asphalt",
  "concrete"
]);

const NON_CASH_METHODS = new Set(CUSTOMER_CHARGE_PAYMENT_METHODS.filter((method) => method !== "cash"));
const BIN_KINDS = new Set(["initial_bin", "add_bin", "exchange_bin"]);
const NON_GARBAGE_CONTENTS = new Set(["soil", "asphalt", "concrete"]);

/** @param {number} status @param {string} code @param {string} message @returns {never} */
function invalid(status, code, message) {
  throw new MbtError({ status, code, message });
}

/** @param {unknown} value @param {string} label */
function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(400, "MBT_CHARGE_INPUT_INVALID", `${label} is required.`);
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} value @param {string} label */
function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    invalid(400, "MBT_CHARGE_INPUT_INVALID", `${label} must be a non-negative integer number of cents.`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} label */
function positiveInteger(value, label) {
  const normalized = nonnegativeInteger(value, label);
  if (normalized === 0) {
    invalid(400, "MBT_CHARGE_INPUT_INVALID", `${label} must be greater than zero.`);
  }
  return normalized;
}

/** @param {number} left @param {number} right @param {string} label */
function safeAdd(left, right, label) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    invalid(422, "MBT_CHARGE_MONEY_OVERFLOW", `${label} exceeds safe integer cents.`);
  }
  return result;
}

/**
 * Symmetric half-up integer rounding. BigInt prevents an otherwise-valid
 * quantity/rate product from losing precision before the safe-cent check.
 *
 * @param {number} value
 * @param {number} numerator
 * @param {number} denominator
 * @param {string} label
 */
function roundedRatio(value, numerator, denominator, label) {
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(numerator)
      || !Number.isSafeInteger(denominator) || denominator <= 0) {
    invalid(422, "MBT_CHARGE_CONFIGURATION_INVALID", `${label} has invalid integer evidence.`);
  }
  const negative = value < 0;
  const absoluteProduct = BigInt(Math.abs(value)) * BigInt(numerator);
  const divisor = BigInt(denominator);
  const rounded = (absoluteProduct + (divisor / 2n)) / divisor;
  const signed = negative ? -rounded : rounded;
  const result = Number(signed);
  if (!Number.isSafeInteger(result)) {
    invalid(422, "MBT_CHARGE_MONEY_OVERFLOW", `${label} exceeds safe integer cents.`);
  }
  return result;
}

/** @param {unknown} value @param {string} label */
function normalizedCode(value, label) {
  const code = String(value ?? "").trim().toLowerCase();
  if (!code) {
    invalid(400, "MBT_CHARGE_INPUT_INVALID", `${label} is required.`);
  }
  return code;
}

/** @param {unknown} value @returns {{paymentMethod: string, paymentCategory: "cash" | "non_cash"}} */
function paymentEvidence(value) {
  const paymentMethod = normalizedCode(value, "Payment method");
  if (!CUSTOMER_CHARGE_PAYMENT_METHODS.includes(paymentMethod)) {
    invalid(400, "MBT_CHARGE_PAYMENT_METHOD_INVALID", "Payment method must be cash or a supported non-cash method.");
  }
  return {
    paymentMethod,
    paymentCategory: NON_CASH_METHODS.has(paymentMethod) ? "non_cash" : "cash"
  };
}

/** @param {unknown} value @param {string} label */
function contentCode(value, label) {
  const code = normalizedCode(value, label);
  if (!CUSTOMER_CHARGE_CONTENT_CODES.includes(code)) {
    invalid(400, "MBT_CHARGE_CONTENT_INVALID", `${label} is not supported.`);
  }
  return code;
}

/** @param {unknown} value @param {string} label */
function binSize(value, label) {
  const size = positiveInteger(value, label);
  if (![14, 20, 40].includes(size)) {
    invalid(400, "MBT_CHARGE_BIN_SIZE_INVALID", `${label} must be 14, 20, or 40 yards.`);
  }
  return size;
}

/** @param {string} content @param {number} size @param {string} direction */
function assertContentSize(content, size, direction) {
  if (NON_GARBAGE_CONTENTS.has(content) && size !== 14) {
    invalid(
      400,
      "MBT_CHARGE_BIN_CONTENT_SIZE_INVALID",
      `${direction} ${content} bins are available only in 14YD.`
    );
  }
}

/** @param {unknown} value */
function normalizedTaxRate(value) {
  const rate = nonnegativeInteger(value ?? 1_300, "HST basis points");
  if (rate !== 1_300) {
    invalid(422, "MBT_CHARGE_TAX_CONFIGURATION_INVALID", "Customer charge requests require Ontario HST at 13%." );
  }
  return rate;
}

/** @param {unknown} value */
function normalizedCurrency(value) {
  const currency = String(value || "CAD").trim().toUpperCase();
  if (currency !== "CAD") {
    invalid(422, "MBT_CHARGE_CURRENCY_INVALID", "Customer charge requests require CAD pricing evidence.");
  }
  return currency;
}

/** @param {number} configuredAmountMinor @param {boolean} taxable @param {"cash" | "non_cash"} paymentCategory @param {number} taxRateBasisPoints */
function lineTaxEvidence(configuredAmountMinor, taxable, paymentCategory, taxRateBasisPoints) {
  const includedHstMinor = paymentCategory === "cash" && taxable
    ? roundedRatio(configuredAmountMinor, taxRateBasisPoints, 10_000 + taxRateBasisPoints, "Included HST")
    : 0;
  const addedHstMinor = paymentCategory === "non_cash" && taxable
    ? roundedRatio(configuredAmountMinor, taxRateBasisPoints, 10_000, "Added HST")
    : 0;
  const preTaxAmountMinor = paymentCategory === "cash"
    ? safeAdd(configuredAmountMinor, -includedHstMinor, "Pre-tax amount")
    : configuredAmountMinor;
  const customerAmountMinor = paymentCategory === "cash"
    ? configuredAmountMinor
    : safeAdd(configuredAmountMinor, addedHstMinor, "Customer line total");
  return { includedHstMinor, addedHstMinor, preTaxAmountMinor, customerAmountMinor };
}

/** @param {Record<string, any>} raw @param {"cash" | "non_cash"} paymentCategory @param {number} taxRateBasisPoints @param {string} currency */
function pricedLine(raw, paymentCategory, taxRateBasisPoints, currency) {
  const configuredAmountMinor = raw.configuredAmountMinor;
  if (!Number.isSafeInteger(configuredAmountMinor)) {
    invalid(422, "MBT_CHARGE_CONFIGURATION_INVALID", "A configured price line must use integer cents.");
  }
  const taxable = raw.taxable !== false;
  const tax = lineTaxEvidence(configuredAmountMinor, taxable, paymentCategory, taxRateBasisPoints);
  return {
    lineCode: String(raw.lineCode),
    lineType: String(raw.lineType),
    label: String(raw.label),
    itemCode: raw.itemCode ? String(raw.itemCode) : null,
    quantityMilliUnits: Number(raw.quantityMilliUnits ?? 1_000),
    unitOfMeasure: String(raw.unitOfMeasure || "EA"),
    unitAmountMinor: Number(raw.unitAmountMinor ?? Math.abs(configuredAmountMinor)),
    configuredAmountMinor,
    taxable,
    ...tax,
    paymentTiming: String(raw.paymentTiming),
    currency,
    source: raw.source || {},
    ...(raw.derivedWeightLbs === undefined ? {} : { derivedWeightLbs: Number(raw.derivedWeightLbs) })
  };
}

/** @param {Record<string, any>} bin @param {string} kind */
function normalizedOutgoingBin(bin, kind) {
  if (kind !== "exchange_bin") {
    return { outgoingContentCode: null, outgoingBinSizeYards: null };
  }
  const outgoingContentCode = contentCode(bin.outgoingContentCode, "Outgoing bin content");
  const outgoingBinSizeYards = binSize(bin.outgoingBinSizeYards, "Outgoing bin size");
  assertContentSize(outgoingContentCode, outgoingBinSizeYards, "Outgoing");
  return { outgoingContentCode, outgoingBinSizeYards };
}

/** @param {string} incomingContentCode @param {number} fixedDumpMinor */
function assertFixedDumpConfiguration(incomingContentCode, fixedDumpMinor) {
  if (incomingContentCode === "garbage" && fixedDumpMinor !== 0) {
    invalid(422, "MBT_CHARGE_GARBAGE_DUMP_FEE_FORBIDDEN", "Garbage requests cannot show a dumping fee.");
  }
  if (NON_GARBAGE_CONTENTS.has(incomingContentCode) && fixedDumpMinor === 0) {
    invalid(422, "MBT_CHARGE_FIXED_DUMP_RATE_REQUIRED", `${incomingContentCode} requires one fixed per-bin dump charge.`);
  }
}

/** @param {Record<string, any>} bin @param {number} eligibleDiscountMinor */
function normalizedDiscount(bin, eligibleDiscountMinor) {
  const discountMinor = nonnegativeInteger(bin.discountMinor ?? 0, "Bin discount");
  if (discountMinor > eligibleDiscountMinor) {
    invalid(400, "MBT_CHARGE_DISCOUNT_EXCEEDS_BIN", "A per-bin discount cannot exceed that bin's eligible charges.");
  }
  const discountReason = String(bin.discountReason ?? "").trim();
  if (discountMinor > 0 && !discountReason) {
    invalid(400, "MBT_CHARGE_DISCOUNT_REASON_REQUIRED", "A per-bin discount requires a reason.");
  }
  return { discountMinor, discountReason };
}

/** @param {Record<string, any>} input @param {string} kind */
function normalizedBin(input, kind) {
  if (!BIN_KINDS.has(kind)) {
    return null;
  }
  const bin = requiredObject(input.bin, "Bin pricing evidence");
  const incomingContentCode = contentCode(bin.incomingContentCode, "Incoming bin content");
  const incomingBinSizeYards = binSize(bin.incomingBinSizeYards, "Incoming bin size");
  assertContentSize(incomingContentCode, incomingBinSizeYards, "Incoming");
  const { outgoingContentCode, outgoingBinSizeYards } = normalizedOutgoingBin(bin, kind);
  const rentalMinor = nonnegativeInteger(bin.rentalMinor, "Bin rental");
  const transportMinor = nonnegativeInteger(bin.transportMinor, "Bin transport");
  const fixedDumpMinor = nonnegativeInteger(bin.fixedDumpMinor ?? 0, "Fixed dump charge");
  const depositMinor = nonnegativeInteger(bin.depositMinor ?? 0, "Bin deposit");
  assertFixedDumpConfiguration(incomingContentCode, fixedDumpMinor);
  const eligibleDiscountMinor = safeAdd(
    safeAdd(rentalMinor, transportMinor, "Bin discount basis"),
    fixedDumpMinor,
    "Bin discount basis"
  );
  const { discountMinor, discountReason } = normalizedDiscount(bin, eligibleDiscountMinor);
  return {
    incomingContentCode,
    incomingBinSizeYards,
    outgoingContentCode,
    outgoingBinSizeYards,
    rentalMinor,
    transportMinor,
    fixedDumpMinor,
    depositMinor,
    discountMinor,
    discountReason
  };
}

/** @param {Record<string, any>} bin */
function requiredDepositMinor(bin) {
  if (bin.incomingContentCode !== "garbage") {
    return 0;
  }
  return bin.depositMinor;
}

/** @param {Record<string, any>} bin @param {string} kind */
function rawBinLines(bin, kind) {
  const dueNow = bin.incomingContentCode !== "garbage";
  const paymentTiming = dueNow ? "due_now" : "contract_balance";
  /** @type {Array<Record<string, any>>} */
  const lines = [];
  if (bin.rentalMinor > 0) {
    lines.push({
      lineCode: `${kind}_bin_rental`, lineType: "bin_rental", label: `${bin.incomingBinSizeYards}YD bin`,
      itemCode: `${bin.incomingBinSizeYards}YD`, configuredAmountMinor: bin.rentalMinor,
      taxable: true, paymentTiming, source: { type: "mbt_bin_rate" }
    });
  }
  if (bin.fixedDumpMinor > 0) {
    lines.push({
      lineCode: `${kind}_${bin.incomingContentCode}_fixed_dump`, lineType: "fixed_dump",
      label: `${bin.incomingContentCode} fixed dump charge`, itemCode: `DUMP_${bin.incomingContentCode.toUpperCase()}`,
      configuredAmountMinor: bin.fixedDumpMinor, taxable: true, paymentTiming,
      source: { type: "mbt_fixed_dump_rate", contentCode: bin.incomingContentCode }
    });
  }
  if (bin.transportMinor > 0) {
    lines.push({
      lineCode: `${kind}_bin_transport`, lineType: "bin_transport", label: "One-way bin transport",
      itemCode: "BIN_DELIVERY", configuredAmountMinor: bin.transportMinor, taxable: true,
      paymentTiming, source: { type: "mbt_distance_rate" }
    });
  }
  if (bin.discountMinor > 0) {
    lines.push({
      lineCode: `${kind}_bin_discount`, lineType: "bin_discount", label: "Per-bin discount",
      itemCode: null, configuredAmountMinor: -bin.discountMinor, taxable: true, paymentTiming,
      source: { type: "frontdesk_discount", reason: bin.discountReason }
    });
  }
  return lines;
}

/** @param {unknown} value */
function aggregateEvidence(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    invalid(400, "MBT_CHARGE_AGGREGATE_INVALID", "Aggregate lines must be an array.");
  }
  if (value.length > 4) {
    invalid(400, "MBT_CHARGE_AGGREGATE_INVALID", "A request can contain at most four distinct aggregate materials.");
  }
  const itemCodes = new Set();
  return value.map((entry, index) => {
    const line = requiredObject(entry, `Aggregate line ${index + 1}`);
    const itemCode = String(line.itemCode || "").trim().toUpperCase();
    if (!/^AGG_[A-Z0-9_]+$/u.test(itemCode) || itemCodes.has(itemCode)) {
      invalid(400, "MBT_CHARGE_AGGREGATE_INVALID", "Aggregate item codes must be distinct configured AGG_ items.");
    }
    itemCodes.add(itemCode);
    const displayName = String(line.displayName || itemCode).trim();
    const quantityMilliYards = positiveInteger(line.quantityMilliYards, `Aggregate line ${index + 1} quantity`);
    const unitAmountMinor = positiveInteger(line.unitAmountMinor, `Aggregate line ${index + 1} unit price`);
    const densityLbsPerYard = positiveInteger(line.densityLbsPerYard, `Aggregate line ${index + 1} density`);
    const amountMinor = roundedRatio(unitAmountMinor, quantityMilliYards, 1_000, `Aggregate line ${index + 1} extension`);
    const derivedWeightLbs = roundedRatio(densityLbsPerYard, quantityMilliYards, 1_000, `Aggregate line ${index + 1} weight`);
    return {
      lineCode: `aggregate_${itemCode.toLowerCase()}`,
      lineType: "aggregate_material",
      label: displayName,
      itemCode,
      quantityMilliUnits: quantityMilliYards,
      unitOfMeasure: "YARD",
      unitAmountMinor,
      configuredAmountMinor: amountMinor,
      taxable: true,
      paymentTiming: "due_now",
      derivedWeightLbs,
      source: { type: "mbt_aggregate_rate", itemCode, densityLbsPerYard }
    };
  });
}

/** @param {Record<string, any>} band */
function aggregateBandRangeInvalid(band) {
  return !band.bandCode
    || (band.maximumMetres !== null && band.maximumMetres <= band.minimumMetres);
}

/** @param {Record<string, any>} band @param {number} index */
function aggregateBaseBandInvalid(band, index) {
  return index === 0
    && (band.minimumMetres !== 0 || band.maximumMetres !== 30_000 || band.amountMinor !== 15_000);
}

/** @param {Record<string, any>} band @param {number} index @param {Record<string, any> | undefined} previous */
function aggregateLaterBandInvalid(band, index, previous) {
  return index > 0
    && (!previous || previous.maximumMetres !== band.minimumMetres || band.amountMinor <= previous.amountMinor);
}

/** @param {Record<string, any>} band @param {number} index @param {Record<string, any> | undefined} previous */
function assertAggregateDistanceBand(band, index, previous) {
  if ([
    aggregateBandRangeInvalid(band),
    aggregateBaseBandInvalid(band, index),
    aggregateLaterBandInvalid(band, index, previous)
  ].some(Boolean)) {
    invalid(422, "MBT_CHARGE_AGGREGATE_DISTANCE_BANDS_INVALID", "Aggregate distance bands must be contiguous upper-inclusive ranges from zero.");
  }
}

/** @param {unknown} value */
function normalizedAggregateDistanceBands(value) {
  if (!Array.isArray(value) || value.length === 0) {
    invalid(422, "MBT_CHARGE_AGGREGATE_DISTANCE_RATE_REQUIRED", "Aggregate distance bands are required.");
  }
  const bands = value.map((entry, index) => {
    const band = requiredObject(entry, `Aggregate distance band ${index + 1}`);
    return {
      bandCode: String(band.bandCode || "").trim(),
      minimumMetres: nonnegativeInteger(band.minimumMetres, "Aggregate band minimum"),
      maximumMetres: band.maximumMetres === null
        ? null
        : nonnegativeInteger(band.maximumMetres, "Aggregate band maximum"),
      amountMinor: nonnegativeInteger(band.amountMinor, "Aggregate delivery amount")
    };
  }).sort((left, right) => left.minimumMetres - right.minimumMetres);
  for (const [index, band] of bands.entries()) {
    assertAggregateDistanceBand(band, index, bands[index - 1]);
  }
  return bands;
}

/** @param {Record<string, any>} input */
function standaloneAggregateDeliveryLine(input) {
  const distanceMetres = nonnegativeInteger(input.distanceMetres, "Aggregate delivery distance");
  const bands = normalizedAggregateDistanceBands(input.aggregateDistanceBands);
  const selected = bands.find((band, index) => (
    (index === 0 ? distanceMetres >= band.minimumMetres : distanceMetres > band.minimumMetres)
      && (band.maximumMetres === null || distanceMetres <= band.maximumMetres)
  ));
  if (!selected) {
    invalid(422, "MBT_CHARGE_AGGREGATE_DISTANCE_OUT_OF_RANGE", "No configured aggregate delivery band covers this distance.");
  }
  return {
    lineCode: "aggregate_delivery",
    lineType: "aggregate_delivery",
    label: "Aggregate delivery",
    itemCode: "AGG_DELIVERY",
    configuredAmountMinor: selected.amountMinor,
    taxable: true,
    paymentTiming: "due_now",
    source: {
      type: "mbt_aggregate_distance_band",
      bandCode: selected.bandCode,
      distanceMetres,
      minimumMetres: selected.minimumMetres,
      maximumMetres: selected.maximumMetres
    }
  };
}

/** @param {string} kind @param {Array<Record<string, any>>} aggregateLines @param {unknown} orderFrom150 */
function assertRequestComposition(kind, aggregateLines, orderFrom150) {
  if (kind === "aggregate_order" && aggregateLines.length === 0) {
    invalid(400, "MBT_CHARGE_AGGREGATE_REQUIRED", "An Aggregate Order requires at least one material.");
  }
  if (aggregateLines.length > 0 && orderFrom150 !== true) {
    invalid(400, "MBT_CHARGE_AGGREGATE_ORIGIN_REQUIRED", "Aggregate requests require Order from 150 pricing.");
  }
}

/** @param {Record<string, any> | null} bin @param {string} kind @param {Array<Record<string, any>>} aggregateLines @param {Record<string, any>} input */
function rawChargeLines(bin, kind, aggregateLines, input) {
  /** @type {Array<Record<string, any>>} */
  const lines = bin ? rawBinLines(bin, kind) : [];
  lines.push(...aggregateLines);
  if (kind === "aggregate_order") {
    lines.push(standaloneAggregateDeliveryLine(input));
  }
  if (kind !== "aggregate_order" && aggregateLines.length > 0) {
    lines.push({
      lineCode: "aggregate_loading_fee",
      lineType: "aggregate_loading_fee",
      label: "Aggregate loading fee",
      itemCode: "AGG_LOADING",
      configuredAmountMinor: nonnegativeInteger(input.loadingFeeMinor, "Aggregate loading fee"),
      taxable: true,
      paymentTiming: "due_now",
      source: { type: "mbt_loading_rate" }
    });
  }
  return lines;
}

/** @param {{preTaxRevenueMinor: number, includedHstMinor: number, addedHstMinor: number, newRequestChargeableMinor: number}} totals */
function assertNonnegativeTotals(totals) {
  if (Object.values(totals).some((total) => total < 0)) {
    invalid(422, "MBT_CHARGE_TOTAL_INVALID", "Customer request totals cannot be negative.");
  }
}

/** @param {Array<Record<string, any>>} lines @param {string} field @param {string} label */
function sumLineField(lines, field, label) {
  return lines.reduce((sum, line) => safeAdd(sum, Number(line[field]), label), 0);
}

/** @param {Array<Record<string, any>>} lines @param {number} taxRateBasisPoints @param {string} currency */
function netSuiteReadySnapshot(lines, taxRateBasisPoints, currency) {
  return {
    schemaVersion: "mbt-netsuite-ready-customer-charge-v1",
    taxMode: "netsuite_calculated",
    taxCodeMappingKey: "on_hst_13",
    taxRateBasisPoints,
    currency,
    lines: lines.map((line) => ({
      lineCode: line.lineCode,
      lineType: line.lineType,
      itemCode: line.itemCode,
      quantityMilliUnits: line.quantityMilliUnits,
      unitOfMeasure: line.unitOfMeasure,
      amountExcludingTaxMinor: line.preTaxAmountMinor,
      source: line.source
    })),
    includesTaxChargeLine: false
  };
}

/**
 * Calculate one immutable customer-facing request from concrete MBT rate
 * evidence. Configured amounts are gross for cash and tax-exclusive for all
 * non-cash methods. The function is pure and does not contact NetSuite.
 *
 * @param {unknown} value
 */
export function calculateCustomerCharge(value) {
  const input = requiredObject(value, "Customer charge request");
  const kind = normalizedCode(input.kind, "Request kind");
  if (!CUSTOMER_CHARGE_REQUEST_KINDS.includes(kind)) {
    invalid(400, "MBT_CHARGE_REQUEST_KIND_INVALID", "Customer charge request kind is not supported.");
  }
  const { paymentMethod, paymentCategory } = paymentEvidence(input.paymentMethod);
  const currency = normalizedCurrency(input.currency);
  const taxRateBasisPoints = normalizedTaxRate(input.taxRateBasisPoints);
  const currentContractTotalMinor = nonnegativeInteger(input.currentContractTotalMinor ?? 0, "Current contract total");
  const bin = normalizedBin(input, kind);
  const aggregateLines = aggregateEvidence(input.aggregateLines);
  assertRequestComposition(kind, aggregateLines, input.orderFrom150);
  const rawLines = rawChargeLines(bin, kind, aggregateLines, input);
  const lines = rawLines.map((line) => pricedLine(line, paymentCategory, taxRateBasisPoints, currency));
  const preTaxRevenueMinor = sumLineField(lines, "preTaxAmountMinor", "Pre-tax request total");
  const includedHstMinor = sumLineField(lines, "includedHstMinor", "Included HST total");
  const addedHstMinor = sumLineField(lines, "addedHstMinor", "Added HST total");
  const newRequestChargeableMinor = sumLineField(lines, "customerAmountMinor", "Customer request total");
  assertNonnegativeTotals({ preTaxRevenueMinor, includedHstMinor, addedHstMinor, newRequestChargeableMinor });
  const depositMinor = bin ? requiredDepositMinor(bin) : 0;
  const dueRevenueMinor = lines
    .filter((line) => line.paymentTiming === "due_now")
    .reduce((sum, line) => safeAdd(sum, line.customerAmountMinor, "Amount due now"), 0);
  const dueNowMinor = safeAdd(dueRevenueMinor, depositMinor, "Amount due now");
  const resultingContractTotalMinor = safeAdd(
    currentContractTotalMinor,
    newRequestChargeableMinor,
    "Resulting contract total"
  );
  const netsuiteExportPolicy = paymentCategory === "cash" ? "excluded_cash" : "eligible_non_cash";
  return {
    schemaVersion: "mbt-customer-charge-v1",
    kind,
    paymentMethod,
    paymentCategory,
    taxMode: paymentCategory === "cash" ? "included" : "exclusive",
    taxRateBasisPoints,
    currency,
    orderFrom150: input.orderFrom150 === true,
    currentContractTotalMinor,
    preTaxRevenueMinor,
    includedHstMinor,
    addedHstMinor,
    newRequestChargeableMinor,
    resultingContractTotalMinor,
    requiredDepositMinor: depositMinor,
    dueNowMinor,
    lines,
    netsuiteExportPolicy,
    netsuiteReadySnapshot: paymentCategory === "cash"
      ? null
      : netSuiteReadySnapshot(lines, taxRateBasisPoints, currency),
    taxExplanation: paymentCategory === "cash"
      ? "Configured prices are final; HST is extracted with rate / (100% + rate) and nothing is added."
      : "Configured prices are before tax; local HST is expected evidence and NetSuite must calculate tax once from pre-tax lines."
  };
}

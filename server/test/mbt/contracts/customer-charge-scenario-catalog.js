// @ts-check

/**
 * Append new scenarios here before changing pricing behavior. The deterministic
 * 100-contract regression test below walks every entry before repeating any,
 * so this array is the durable, reviewable list of supported Front Desk cases.
 */
export const CUSTOMER_CHARGE_SCENARIOS = Object.freeze([
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

export const REAL_RATE_CATALOG = Object.freeze({
  currency: "CAD",
  hstBasisPoints: 1_300,
  loadingFeeMinor: 5_000,
  binRates: Object.freeze({
    garbage: Object.freeze({
      14: Object.freeze({ rentalMinor: 35_000, transportMinor: 12_500, fixedDumpMinor: 0, depositMinor: 10_000 }),
      20: Object.freeze({ rentalMinor: 45_000, transportMinor: 19_000, fixedDumpMinor: 0, depositMinor: 12_500 }),
      40: Object.freeze({ rentalMinor: 65_000, transportMinor: 27_500, fixedDumpMinor: 0, depositMinor: 15_000 })
    }),
    soil: Object.freeze({
      14: Object.freeze({ rentalMinor: 35_000, transportMinor: 12_500, fixedDumpMinor: 85_000, depositMinor: 0 })
    }),
    asphalt: Object.freeze({
      14: Object.freeze({ rentalMinor: 35_000, transportMinor: 12_500, fixedDumpMinor: 72_500, depositMinor: 0 })
    }),
    concrete: Object.freeze({
      14: Object.freeze({ rentalMinor: 35_000, transportMinor: 12_500, fixedDumpMinor: 92_500, depositMinor: 0 })
    })
  }),
  aggregateRates: Object.freeze({
    AGG_CLEAR_LIMESTONE_34: Object.freeze({ displayName: "3/4 Clear Limestone", unitAmountMinor: 5_250, densityLbsPerYard: 2_700 }),
    AGG_CRUSHER_RUN: Object.freeze({ displayName: "Crusher Run", unitAmountMinor: 4_800, densityLbsPerYard: 2_850 }),
    AGG_HPB: Object.freeze({ displayName: "HPB", unitAmountMinor: 6_500, densityLbsPerYard: 2_600 }),
    AGG_SCREENING: Object.freeze({ displayName: "Screening", unitAmountMinor: 4_200, densityLbsPerYard: 2_750 })
  }),
  aggregateDistanceBands: Object.freeze([
    Object.freeze({ bandCode: "AGG_0_30", minimumMetres: 0, maximumMetres: 30_000, amountMinor: 15_000 }),
    Object.freeze({ bandCode: "AGG_30_50", minimumMetres: 30_000, maximumMetres: 50_000, amountMinor: 20_000 }),
    Object.freeze({ bandCode: "AGG_50_75", minimumMetres: 50_000, maximumMetres: 75_000, amountMinor: 27_500 })
  ])
});

/** @param {number} seed */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

/** @param {() => number} random @param {readonly any[]} values */
function pick(random, values) {
  return values[Math.floor(random() * values.length)];
}

/** @param {string} contentCode @param {number} binSizeYards */
function binRate(contentCode, binSizeYards) {
  const contentRates = REAL_RATE_CATALOG.binRates[contentCode];
  const rate = contentRates?.[binSizeYards];
  if (!rate) {
    throw new Error(`Scenario catalog has no ${contentCode} ${binSizeYards}YD rate.`);
  }
  return rate;
}

/** @param {() => number} random @param {number} count */
function aggregates(random, count = 1) {
  const codes = Object.keys(REAL_RATE_CATALOG.aggregateRates);
  const shuffled = [...codes].sort(() => random() - 0.5).slice(0, count);
  return shuffled.map((itemCode) => {
    const rate = REAL_RATE_CATALOG.aggregateRates[itemCode];
    return {
      itemCode,
      displayName: rate.displayName,
      quantityMilliYards: pick(random, [500, 1_000, 1_500, 2_000, 3_250, 5_000]),
      unitAmountMinor: rate.unitAmountMinor,
      densityLbsPerYard: rate.densityLbsPerYard
    };
  });
}

/**
 * @param {object} input
 * @param {string} input.kind
 * @param {string} input.paymentMethod
 * @param {string} input.incomingContentCode
 * @param {number} input.incomingBinSizeYards
 * @param {string | null} [input.outgoingContentCode]
 * @param {number | null} [input.outgoingBinSizeYards]
 * @param {number} [input.discountMinor]
 * @param {Array<Record<string, unknown>>} [input.aggregateLines]
 */
function binRequest(input) {
  const rate = binRate(input.incomingContentCode, input.incomingBinSizeYards);
  return {
    kind: input.kind,
    paymentMethod: input.paymentMethod,
    currentContractTotalMinor: 0,
    orderFrom150: Boolean(input.aggregateLines?.length),
    bin: {
      incomingContentCode: input.incomingContentCode,
      incomingBinSizeYards: input.incomingBinSizeYards,
      outgoingContentCode: input.outgoingContentCode ?? null,
      outgoingBinSizeYards: input.outgoingBinSizeYards ?? null,
      rentalMinor: rate.rentalMinor,
      transportMinor: rate.transportMinor,
      fixedDumpMinor: rate.fixedDumpMinor,
      depositMinor: rate.depositMinor,
      discountMinor: input.discountMinor || 0,
      discountReason: input.discountMinor ? "Scenario catalog loyalty discount" : null
    },
    aggregateLines: input.aggregateLines || [],
    loadingFeeMinor: REAL_RATE_CATALOG.loadingFeeMinor,
    taxRateBasisPoints: REAL_RATE_CATALOG.hstBasisPoints,
    currency: REAL_RATE_CATALOG.currency
  };
}

/** @param {() => number} random @param {string} scenarioCode */
function standaloneDistance(random, scenarioCode) {
  if (scenarioCode.includes("exactly_30km")) {
    return 30_000;
  }
  if (scenarioCode.includes("over_30km")) {
    return 30_001;
  }
  return pick(random, [0, 12_345, 29_999]);
}

/** @param {() => number} random @param {string} scenarioCode @param {string} paymentMethod */
function standaloneScenarioRequest(random, scenarioCode, paymentMethod) {
  return {
    kind: "aggregate_order",
    paymentMethod,
    currentContractTotalMinor: 0,
    orderFrom150: true,
    distanceMetres: standaloneDistance(random, scenarioCode),
    aggregateLines: aggregates(random, scenarioCode.includes("multiple_materials") ? 4 : pick(random, [1, 2])),
    aggregateDistanceBands: REAL_RATE_CATALOG.aggregateDistanceBands,
    loadingFeeMinor: REAL_RATE_CATALOG.loadingFeeMinor,
    taxRateBasisPoints: REAL_RATE_CATALOG.hstBasisPoints,
    currency: REAL_RATE_CATALOG.currency
  };
}

/** @param {string} scenarioCode @param {string} paymentMethod @param {Array<Record<string, unknown>>} aggregateLines */
function initialScenarioRequest(scenarioCode, paymentMethod, aggregateLines) {
  const content = scenarioCode.split("_")[1];
  const size = content === "garbage" ? Number(scenarioCode.split("_")[2]) : 14;
  return binRequest({
    kind: "initial_bin",
    paymentMethod,
    incomingContentCode: content,
    incomingBinSizeYards: size,
    discountMinor: scenarioCode.includes("with_discount") ? 2_500 : 0,
    aggregateLines
  });
}

/** @param {() => number} random @param {string} scenarioCode @param {string} paymentMethod @param {Array<Record<string, unknown>>} aggregateLines */
function addScenarioRequest(random, scenarioCode, paymentMethod, aggregateLines) {
  const content = scenarioCode.split("_")[1];
  return binRequest({
    kind: "add_bin",
    paymentMethod,
    incomingContentCode: content,
    incomingBinSizeYards: content === "garbage" ? pick(random, [14, 20, 40]) : 14,
    aggregateLines
  });
}

/** @param {() => number} random @param {string} scenarioCode @param {string} paymentMethod @param {Array<Record<string, unknown>>} aggregateLines */
function exchangeScenarioRequest(random, scenarioCode, paymentMethod, aggregateLines) {
  const transition = scenarioCode.match(/^exchange_(garbage|soil|asphalt|concrete)_to_(garbage|soil|asphalt|concrete)/u);
  if (!transition) {
    throw new Error(`Unhandled scenario ${scenarioCode}.`);
  }
  const outgoing = transition[1];
  const incoming = transition[2];
  let incomingSize = incoming === "garbage" ? pick(random, [14, 20, 40]) : 14;
  let outgoingSize = outgoing === "garbage" ? 20 : 14;
  if (scenarioCode.includes("same_size")) {
    incomingSize = outgoingSize;
  }
  if (scenarioCode.includes("upgrade")) {
    [outgoingSize, incomingSize] = [14, 40];
  }
  if (scenarioCode.includes("downgrade")) {
    [outgoingSize, incomingSize] = [40, 14];
  }
  return binRequest({
    kind: "exchange_bin",
    paymentMethod,
    incomingContentCode: incoming,
    incomingBinSizeYards: incomingSize,
    outgoingContentCode: outgoing,
    outgoingBinSizeYards: outgoingSize,
    aggregateLines
  });
}

/** @param {() => number} random */
function mixedPaymentScenarioRequest(random) {
  return binRequest({
    kind: "exchange_bin",
    paymentMethod: "card",
    incomingContentCode: "garbage",
    incomingBinSizeYards: 20,
    outgoingContentCode: "garbage",
    outgoingBinSizeYards: 14,
    aggregateLines: aggregates(random, 2)
  });
}

/** @param {() => number} random @param {string} scenarioCode */
function scenarioRequest(random, scenarioCode) {
  const paymentMethod = scenarioCode.includes("_cash") ? "cash" : "card";
  const withAggregate = scenarioCode.includes("with_aggregate");
  const aggregateLines = withAggregate ? aggregates(random, pick(random, [1, 2, 3])) : [];
  if (scenarioCode.startsWith("standalone_aggregate")) {
    return standaloneScenarioRequest(random, scenarioCode, paymentMethod);
  }
  if (scenarioCode.startsWith("initial_")) {
    return initialScenarioRequest(scenarioCode, paymentMethod, aggregateLines);
  }
  if (scenarioCode.startsWith("add_")) {
    return addScenarioRequest(random, scenarioCode, paymentMethod, aggregateLines);
  }
  if (scenarioCode === "mixed_payment_cash_initial_card_exchange_with_aggregate") {
    return mixedPaymentScenarioRequest(random);
  }
  return exchangeScenarioRequest(random, scenarioCode, paymentMethod, aggregateLines);
}

/**
 * Produce exactly 100 deterministic customer histories. Every history starts
 * with a real garbage-bin contract request; its next request walks the named
 * scenario catalog. Additional generated requests make payment changes within
 * the same contract commonplace instead of testing payment as contract state.
 *
 * @param {number} [seed]
 */
export function generateOneHundredContractOrders(seed = 20_260_809) {
  const random = seededRandom(seed);
  return Array.from({ length: 100 }, (_, index) => {
    const scenarioCode = CUSTOMER_CHARGE_SCENARIOS[index % CUSTOMER_CHARGE_SCENARIOS.length];
    const initialPaymentMethod = scenarioCode === "mixed_payment_cash_initial_card_exchange_with_aggregate"
      ? "cash"
      : index % 2 === 0 ? "cash" : "card";
    const initial = binRequest({
      kind: "initial_bin",
      paymentMethod: initialPaymentMethod,
      incomingContentCode: "garbage",
      incomingBinSizeYards: pick(random, [14, 20, 40]),
      discountMinor: index % 11 === 0 ? 1_000 : 0,
      aggregateLines: index % 13 === 0 ? aggregates(random, 1) : []
    });
    const requests = [initial, scenarioRequest(random, scenarioCode)];
    if (index % 3 === 0) {
      requests.push(binRequest({
        kind: "exchange_bin",
        paymentMethod: initial.paymentMethod === "cash" ? "card" : "cash",
        incomingContentCode: "garbage",
        incomingBinSizeYards: pick(random, [14, 20, 40]),
        outgoingContentCode: "garbage",
        outgoingBinSizeYards: initial.bin.incomingBinSizeYards,
        aggregateLines: index % 2 === 0 ? aggregates(random, 2) : []
      }));
    }
    return { contractNumber: `REG-${String(index + 1).padStart(3, "0")}`, scenarioCode, requests };
  });
}

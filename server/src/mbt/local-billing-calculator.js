// @ts-check

import { MbtError } from "./errors.js";

const QUANTITY_SCALE = 1_000_000;
const BASIS_POINT_SCALE = 10_000;
const COMPONENT_TYPE_ORDER = Object.freeze({
  rental: 10,
  extension: 20,
  exchange: 30,
  pickup: 40,
  surcharge: 50,
  discount: 60
});
const CROSS_CHARGE_TYPE_ORDER = Object.freeze({ SO: 10, TO: 20, PO: 30, VRMA: 40 });

/** @param {Date} instant @returns {[number, number, number, number, number, number]} */
function torontoCalendarParts(instant) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
  return [
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  ];
}

/**
 * Number of chargeable extension days after the fixed 14 Toronto calendar
 * days. Comparing local calendar fields (rather than UTC milliseconds) keeps
 * the rule stable through daylight-saving transitions; any partial extra day
 * is rounded up.
 *
 * @param {unknown} deliveredAt
 * @param {unknown} throughAt
 * @param {number} [includedCalendarDays]
 */
export function calculateTorontoRentalExtensionDays(deliveredAt, throughAt, includedCalendarDays = 14) {
  const delivery = new Date(String(deliveredAt));
  const through = new Date(String(throughAt));
  if (Number.isNaN(delivery.getTime()) || Number.isNaN(through.getTime()) || through < delivery
      || !Number.isSafeInteger(includedCalendarDays) || includedCalendarDays < 1) {
    invalid("MBT_BILLING_RENTAL_PERIOD_INVALID", "Rental dates and the included calendar-day period are invalid.");
  }
  const start = Date.UTC(...torontoCalendarParts(delivery));
  const end = Date.UTC(...torontoCalendarParts(through));
  const elapsedDays = Math.ceil((end - start) / 86_400_000);
  return Math.max(0, elapsedDays - includedCalendarDays);
}

/** @param {string} code @param {string} message @returns {never} */
function invalid(code, message) {
  throw new MbtError({ status: 422, code, message });
}

/** @param {unknown} value @param {string} label */
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("MBT_BILLING_INPUT_INVALID", `${label} is required.`);
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    invalid("MBT_BILLING_INPUT_INVALID", `${label} is required.`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    invalid("MBT_BILLING_MONEY_INVALID", `${label} must be a non-negative safe integer.`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} label */
function positiveInteger(value, label) {
  const normalized = nonnegativeInteger(value, label);
  if (normalized === 0) {
    invalid("MBT_BILLING_INPUT_INVALID", `${label} must be positive.`);
  }
  return normalized;
}

/** @param {unknown} value */
function currency(value) {
  const normalized = requiredText(value, "Currency").toUpperCase();
  if (normalized !== "CAD") {
    invalid("MBT_BILLING_CURRENCY_MISMATCH", "P3.10 local billing requires CAD evidence.");
  }
  return normalized;
}

/** @param {number} value @param {string} label */
function safeResult(value, label) {
  if (!Number.isSafeInteger(value)) {
    invalid("MBT_BILLING_MONEY_OVERFLOW", `${label} exceeds safe integer cents.`);
  }
  return value;
}

/** @param {number} left @param {number} right @param {string} label */
function safeAdd(left, right, label) {
  return safeResult(left + right, label);
}

/**
 * Round an exact signed integer ratio half away from zero without converting
 * the multiplication to floating point.
 *
 * @param {number} left
 * @param {number} right
 * @param {number} denominator
 * @param {string} label
 */
function roundedProduct(left, right, denominator, label) {
  const numerator = BigInt(left) * BigInt(right);
  const divisor = BigInt(denominator);
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  const rounded = ((absolute + (divisor / 2n)) / divisor) * sign;
  const number = Number(rounded);
  return safeResult(number, label);
}

/** @param {unknown} value @param {string} label */
function quantityMicrounits(value, label) {
  const normalized = value === undefined ? QUANTITY_SCALE : nonnegativeInteger(value, label);
  if (normalized === 0) {
    invalid("MBT_BILLING_QUANTITY_INVALID", `${label} must be positive.`);
  }
  return normalized;
}

/** @param {Record<string, any>} value @param {string} expectedCurrency */
function localItem(value, expectedCurrency) {
  const item = object(value, "Local-item evidence");
  if (item.currency !== undefined && currency(item.currency) !== expectedCurrency) {
    invalid("MBT_BILLING_CURRENCY_MISMATCH", "Local-item currency does not match billing evidence.");
  }
  return {
    code: requiredText(item.code, "Local-item code"),
    revision: positiveInteger(item.revision, "Local-item revision")
  };
}

/** @param {string} lineType */
function componentOrder(lineType) {
  const result = /** @type {Record<string, number>} */ (COMPONENT_TYPE_ORDER)[lineType];
  if (result === undefined) {
    invalid("MBT_BILLING_LINE_TYPE_INVALID", `Unsupported local billing line type: ${lineType}.`);
  }
  return result;
}

/** @param {Record<string, any>} component */
function componentUnit(component) {
  const units = /** @type {Record<string, string>} */ ({
    flat: "EA",
    per_day: "DAY",
    per_week: "WEEK",
    per_unit: requiredText(component.unitOfMeasure || "EA", "Component unit"),
    percentage: "PERCENT"
  });
  return units[String(component.rateBasis)];
}

/**
 * @param {Record<string, any>} component
 * @param {number} percentageBaseMinor
 */
function componentNet(component, percentageBaseMinor) {
  const lineType = requiredText(component.lineType, "Component line type");
  componentOrder(lineType);
  const basis = requiredText(component.rateBasis, "Component rate basis");
  let amount;
  if (basis === "percentage") {
    const basisPoints = nonnegativeInteger(
      component.percentageBasisPoints,
      "Component percentage basis points"
    );
    amount = roundedProduct(
      percentageBaseMinor,
      basisPoints,
      BASIS_POINT_SCALE,
      "Percentage component"
    );
  } else if (new Set(["flat", "per_day", "per_week", "per_unit"]).has(basis)) {
    const unitAmountMinor = nonnegativeInteger(component.amountMinor, "Component amount");
    const quantity = basis === "flat"
      ? QUANTITY_SCALE
      : quantityMicrounits(component.quantityMicrounits, "Component quantity");
    amount = roundedProduct(unitAmountMinor, quantity, QUANTITY_SCALE, "Component amount");
  } else {
    invalid("MBT_BILLING_RATE_BASIS_INVALID", `Unsupported component rate basis: ${basis}.`);
  }
  return lineType === "discount" ? -amount : amount;
}

/** @param {Record<string, any>} component @param {number} percentageBaseMinor */
function calculatedComponent(component, percentageBaseMinor) {
  const lineType = requiredText(component.lineType, "Component line type");
  const lineKey = requiredText(component.lineCode, "Component line code");
  const rateBasis = requiredText(component.rateBasis, "Component rate basis");
  const netAmountMinor = componentNet(component, percentageBaseMinor);
  const quantity = rateBasis === "flat" || rateBasis === "percentage"
    ? QUANTITY_SCALE
    : quantityMicrounits(component.quantityMicrounits, "Component quantity");
  const unsignedUnitAmount = rateBasis === "percentage"
    ? Math.abs(netAmountMinor)
    : nonnegativeInteger(component.amountMinor, "Component amount");
  return {
    lineKey,
    lineType,
    description: String(component.description || lineKey),
    quantityMicrounits: quantity,
    unitOfMeasure: componentUnit(component),
    unitAmountMinor: lineType === "discount" ? -unsignedUnitAmount : unsignedUnitAmount,
    netAmountMinor,
    taxable: component.taxable === true,
    localItem: component.localItem === undefined ? null : component.localItem,
    source: {
      type: "rate_component",
      id: requiredText(component.componentId, "Rate-component ID"),
      rateBasis,
      percentageBaseMinor: rateBasis === "percentage" ? percentageBaseMinor : null
    },
    customerChargeMinor: null,
    actualCostMinor: null,
    marginMinor: null
  };
}

/** @param {unknown} value @param {string} expectedCurrency */
function rateComponent(value, expectedCurrency) {
  const component = object(value, "Rate component");
  if (component.currency !== undefined && currency(component.currency) !== expectedCurrency) {
    invalid("MBT_BILLING_CURRENCY_MISMATCH", "Rate-component currency does not match billing evidence.");
  }
  return component;
}

/** @param {Record<string, any>} rawDump @param {string} expectedCurrency */
function calculatedDump(rawDump, expectedCurrency) {
  const dump = object(rawDump, "Dump evidence");
  const receipt = object(dump.receiptSnapshot, "Dump receipt snapshot");
  const tariff = object(dump.tariff, "Dump tariff");
  if (currency(receipt.currency) !== expectedCurrency || currency(tariff.currency) !== expectedCurrency) {
    invalid("MBT_BILLING_CURRENCY_MISMATCH", "Dump evidence currency does not match the billing case.");
  }
  const subtotalMinor = nonnegativeInteger(receipt.subtotalMinor, "Receipt subtotal");
  const receiptTaxMinor = nonnegativeInteger(receipt.taxMinor, "Receipt tax");
  const actualCostMinor = nonnegativeInteger(receipt.totalMinor, "Receipt total");
  if (safeAdd(subtotalMinor, receiptTaxMinor, "Receipt total") !== actualCostMinor) {
    invalid("MBT_BILLING_RECEIPT_TOTAL_INVALID", "Receipt subtotal plus tax must equal total.");
  }
  const pricingBasis = requiredText(tariff.pricingBasis, "Dump pricing basis");
  const unitAmountMinor = nonnegativeInteger(tariff.amountMinor, "Dump tariff amount");
  const minimumAmountMinor = nonnegativeInteger(
    tariff.minimumAmountMinor ?? 0,
    "Dump tariff minimum"
  );
  const receiptQuantity = nonnegativeInteger(
    receipt.quantityMicrounits,
    "Dump receipt quantity"
  );
  const unitOfMeasure = requiredText(receipt.unitOfMeasure, "Dump receipt unit");
  if (pricingBasis !== "fixed" && requiredText(tariff.unitOfMeasure, "Dump tariff unit") !== unitOfMeasure) {
    invalid("MBT_BILLING_DUMP_UNIT_MISMATCH", "Dump tariff and receipt units do not match.");
  }
  const calculatedMinor = pricingBasis === "fixed"
    ? unitAmountMinor
    : new Set(["per_quantity", "per_weight"]).has(pricingBasis)
      ? roundedProduct(unitAmountMinor, receiptQuantity, QUANTITY_SCALE, "Dump tariff")
      : invalid("MBT_BILLING_RATE_BASIS_INVALID", `Unsupported dump pricing basis: ${pricingBasis}.`);
  const customerChargeMinor = Math.max(calculatedMinor, minimumAmountMinor);
  return {
    line: {
      lineKey: "dump",
      lineType: "dump",
      description: String(tariff.description || "Dump customer tariff"),
      quantityMicrounits: pricingBasis === "fixed" ? QUANTITY_SCALE : receiptQuantity,
      unitOfMeasure: pricingBasis === "fixed" ? "EA" : unitOfMeasure,
      unitAmountMinor,
      netAmountMinor: customerChargeMinor,
      taxable: tariff.taxable !== false,
      localItem: localItem(dump.localItem, expectedCurrency),
      source: {
        type: "dump_tariff",
        id: requiredText(tariff.dumpTariffId, "Dump-tariff ID"),
        receiptId: requiredText(receipt.dumpReceiptId, "Dump-receipt ID"),
        pricingBasis
      },
      customerChargeMinor,
      actualCostMinor,
      marginMinor: customerChargeMinor - actualCostMinor
    },
    economics: {
      customerChargeMinor,
      actualCostMinor,
      marginMinor: customerChargeMinor - actualCostMinor,
      currency: expectedCurrency
    }
  };
}

/** @param {Record<string, any>} customPrice @param {string} expectedCurrency */
function calculatedCustomPrice(customPrice, expectedCurrency) {
  const lineKey = requiredText(customPrice.lineCode, "Custom-price line code");
  const amountMinor = nonnegativeInteger(customPrice.amountMinor, "Custom price");
  const item = localItem({
    code: customPrice.localItemCode,
    revision: customPrice.localItemRevision,
    currency: customPrice.currency
  }, expectedCurrency);
  return {
    lineKey,
    lineType: "custom_price",
    description: String(customPrice.description || lineKey),
    quantityMicrounits: QUANTITY_SCALE,
    unitOfMeasure: String(customPrice.unitOfMeasure || "EA"),
    unitAmountMinor: amountMinor,
    netAmountMinor: amountMinor,
    taxable: customPrice.taxable === true,
    localItem: item,
    source: { type: "local_custom_price", code: item.code },
    customerChargeMinor: null,
    actualCostMinor: null,
    marginMinor: null
  };
}

/** @param {Record<string, any>} waiver @param {string} expectedCurrency */
function calculatedWaiver(waiver, expectedCurrency) {
  const amountMinor = nonnegativeInteger(waiver.amountMinor, "Waiver amount");
  if (amountMinor === 0) {
    invalid("MBT_BILLING_WAIVER_INVALID", "A billing waiver must reduce the charge by at least one cent.");
  }
  const item = localItem(waiver.localItem, expectedCurrency);
  return {
    lineKey: `waiver:${requiredText(waiver.reason, "Waiver audit reason")}`.slice(0, 160),
    lineType: "discount",
    description: String(waiver.description || "Audited billing waiver"),
    quantityMicrounits: QUANTITY_SCALE,
    unitOfMeasure: "EA",
    unitAmountMinor: -amountMinor,
    netAmountMinor: -amountMinor,
    taxable: waiver.taxable === true,
    localItem: item,
    source: { type: "billing_waiver", reason: requiredText(waiver.reason, "Waiver audit reason") },
    customerChargeMinor: null,
    actualCostMinor: null,
    marginMinor: null
  };
}

/** @param {Array<Record<string, any>>} lines */
function assertUniqueLineKeys(lines) {
  const keys = new Set();
  for (const line of lines) {
    if (keys.has(line.lineKey)) {
      invalid("MBT_BILLING_DUPLICATE_LINE_KEY", `Duplicate billing line key: ${line.lineKey}.`);
    }
    keys.add(line.lineKey);
  }
}

/** @param {unknown} value @param {string} label */
function requiredArray(value, label) {
  if (!Array.isArray(value)) {
    invalid("MBT_BILLING_INPUT_INVALID", `${label} are required.`);
  }
  return value;
}

/** @param {unknown} value @param {string} billingCurrency */
function billingDistance(value, billingCurrency) {
  const distance = object(value, "Distance snapshot");
  if (currency(distance.currency) !== billingCurrency) {
    invalid("MBT_BILLING_CURRENCY_MISMATCH", "Distance currency does not match billing evidence.");
  }
  return distance;
}

/**
 * Calculate a complete deterministic local MBT billing version from immutable
 * evidence. All money remains integer cents and all quantities are exact
 * millionths of a unit.
 *
 * @param {unknown} value
 */
export function calculateMbtLocalBilling(value) {
  const input = object(value, "Local billing evidence");
  const billingCurrency = currency(input.currency);
  const taxBasisPoints = nonnegativeInteger(input.taxBasisPoints ?? 0, "Tax basis points");
  const distance = billingDistance(input.distanceSnapshot, billingCurrency);
  const transportAmount = nonnegativeInteger(distance.amountMinor, "Transport amount");
  const defaultLocalItem = localItem(input.localItem, billingCurrency);
  /** @type {Array<Record<string, any>>} */
  const lines = [{
    lineKey: "transport",
    lineType: "transport",
    description: "Transport",
    quantityMicrounits: QUANTITY_SCALE,
    unitOfMeasure: "TRIP",
    unitAmountMinor: transportAmount,
    netAmountMinor: transportAmount,
    taxable: distance.taxable !== false,
    localItem: defaultLocalItem,
    source: {
      type: "distance_snapshot",
      id: requiredText(distance.distanceSnapshotId, "Distance-snapshot ID"),
      selectedBandId: requiredText(distance.selectedBandId, "Selected distance-band ID"),
      rawMetres: nonnegativeInteger(distance.rawMetres, "Raw distance metres")
    },
    customerChargeMinor: null,
    actualCostMinor: null,
    marginMinor: null
  }];

  const components = requiredArray(input.components, "Rate components")
    .map((component) => rateComponent(component, billingCurrency));
  const nonPercentage = components
    .filter((component) => component.rateBasis !== "percentage")
    .sort((left, right) => componentOrder(String(left.lineType)) - componentOrder(String(right.lineType))
      || String(left.lineCode).localeCompare(String(right.lineCode)));
  const percentage = components
    .filter((component) => component.rateBasis === "percentage")
    .sort((left, right) => componentOrder(String(left.lineType)) - componentOrder(String(right.lineType))
      || String(left.lineCode).localeCompare(String(right.lineCode)));
  const fixedComponentLines = nonPercentage.map((component) => calculatedComponent(component, 0));
  lines.push(...fixedComponentLines);

  const dump = input.dump === null || input.dump === undefined
    ? null
    : calculatedDump(input.dump, billingCurrency);
  const percentageBaseMinor = [...lines, ...(dump ? [dump.line] : [])]
    .filter((line) => line.lineType !== "discount")
    .reduce((sum, line) => safeAdd(sum, Math.max(0, line.netAmountMinor), "Percentage base"), 0);
  lines.push(...percentage.map((component) => calculatedComponent(component, percentageBaseMinor)));
  if (dump) {
    lines.push(dump.line);
  }
  lines.push(...requiredArray(input.customPrices, "Custom prices")
    .map((customPrice) => calculatedCustomPrice(object(customPrice, "Custom price"), billingCurrency))
    .sort((left, right) => left.lineKey.localeCompare(right.lineKey)));
  lines.push(...requiredArray(input.waivers ?? [], "Billing waivers")
    .map((waiver) => calculatedWaiver(object(waiver, "Billing waiver"), billingCurrency))
    .sort((left, right) => left.lineKey.localeCompare(right.lineKey)));
  assertUniqueLineKeys(lines);

  const finalizedLines = /** @type {Array<Record<string, any>>} */ (lines.map((line, sequenceNumber) => {
    const estimatedTaxMinor = line.taxable
      ? roundedProduct(line.netAmountMinor, taxBasisPoints, BASIS_POINT_SCALE, "Line tax")
      : 0;
    return {
      ...line,
      sequenceNumber,
      estimatedTaxMinor,
      totalAmountMinor: safeAdd(line.netAmountMinor, estimatedTaxMinor, "Billing line total")
    };
  }));
  const subtotalMinor = finalizedLines.reduce(
    (sum, line) => safeAdd(sum, line.netAmountMinor, "Billing subtotal"),
    0
  );
  const estimatedTaxMinor = finalizedLines.reduce(
    (sum, line) => safeAdd(sum, line.estimatedTaxMinor, "Billing tax"),
    0
  );
  const totalMinor = safeAdd(subtotalMinor, estimatedTaxMinor, "Billing total");
  if (subtotalMinor < 0 || totalMinor < 0) {
    invalid("MBT_BILLING_NEGATIVE_TOTAL", "Discounts cannot make the local billing subtotal or total negative.");
  }
  return {
    schemaVersion: "mbt-local-billing-v1",
    rateCardVersionId: requiredText(input.rateCardVersionId, "Rate-card version ID"),
    currency: billingCurrency,
    contractSnapshot: structuredClone(object(input.contractSnapshot, "Contract snapshot")),
    visitSnapshot: structuredClone(object(input.visitSnapshot, "Visit snapshot")),
    distanceSnapshot: structuredClone(distance),
    receiptSnapshot: dump
      ? structuredClone(object(input.dump.receiptSnapshot, "Dump receipt snapshot"))
      : null,
    taxBasisPoints,
    lines: finalizedLines,
    subtotalMinor,
    estimatedTaxMinor,
    totalMinor,
    dumpEconomics: dump?.economics ?? null,
    calculationExplanation: {
      arithmetic: "integer_minor_units_and_quantity_microunits",
      quantityScale: QUANTITY_SCALE,
      rounding: "nearest_cent_half_away_from_zero",
      tax: "per_line_from_immutable_basis_points",
      percentageBase: "positive_non_percentage_rate_lines_plus_transport_and_dump",
      actualDumpCostIncludedInCustomerCharge: false
    }
  };
}

/** @param {Record<string, any>} load */
function normalizedLoad(load) {
  const physicalLoadId = requiredText(load.physicalLoadId, "Physical-load ID");
  const completedAt = requiredText(load.completedAt, "Completed-load time");
  if (!Number.isFinite(Date.parse(completedAt))) {
    invalid("MBT_BILLING_LOAD_INVALID", "Completed-load time must be ISO-compatible.");
  }
  if (!Array.isArray(load.references) || load.references.length === 0) {
    invalid("MBT_BILLING_LOAD_INVALID", "A completed physical load needs source references.");
  }
  return {
    physicalLoadId,
    completedAt: new Date(completedAt).toISOString(),
    planDate: load.planDate === undefined ? completedAt.slice(0, 10) : requiredText(load.planDate, "Plan date"),
    truckId: load.truckId ?? null,
    driverId: load.driverId ?? null,
    calculatedMetres: nonnegativeInteger(load.calculatedMetres ?? 0, "Cross-charge distance"),
    sharedTotalMinor: nonnegativeInteger(load.sharedTotalMinor, "Shared cross-charge total"),
    references: load.references.map((reference) => {
      const row = object(reference, "Cross-charge reference");
      const sourceType = requiredText(row.sourceType, "Cross-charge source type").toUpperCase();
      if (!Object.hasOwn(CROSS_CHARGE_TYPE_ORDER, sourceType)) {
        invalid("MBT_BILLING_SOURCE_TYPE_INVALID", `Unsupported cross-charge source type: ${sourceType}.`);
      }
      return {
        sourceType,
        rootReference: requiredText(row.rootReference, "Cross-charge root reference"),
        childReference: row.childReference === undefined ? null : String(row.childReference)
      };
    })
  };
}

/** @param {string} sourceType */
function sourceOrder(sourceType) {
  return /** @type {Record<string, number>} */ (CROSS_CHARGE_TYPE_ORDER)[sourceType] ?? 999;
}

/**
 * Apply the source-design physical-load dedupe rules and exact-cent allocation
 * without reading or writing any operational table.
 *
 * @param {unknown} value
 */
export function calculateMbbsCrossCharges(value) {
  const input = object(value, "MBBS cross-charge evidence");
  const crossChargeCurrency = currency(input.currency);
  if (!Array.isArray(input.loads)) {
    invalid("MBT_BILLING_LOAD_INVALID", "Completed physical loads are required.");
  }
  const loads = input.loads.map((load) => normalizedLoad(object(load, "Physical load")))
    .sort((left, right) => left.physicalLoadId.localeCompare(right.physicalLoadId)
      || left.completedAt.localeCompare(right.completedAt));
  if (new Set(loads.map((load) => load.physicalLoadId)).size !== loads.length) {
    invalid("MBT_BILLING_LOAD_DUPLICATE", "Physical-load IDs must be unique.");
  }

  /** @type {Array<Record<string, any>>} */
  const cases = [];
  /** @type {Array<Record<string, any>>} */
  const allocationGroups = [];
  const globalToRoots = new Set();
  for (const load of loads) {
    const references = [...new Map(load.references
      .sort((left, right) => sourceOrder(left.sourceType) - sourceOrder(right.sourceType)
        || left.rootReference.localeCompare(right.rootReference)
        || String(left.childReference).localeCompare(String(right.childReference)))
      .map((reference) => [`${reference.sourceType}|${reference.rootReference}`, reference])).values()];

    for (const reference of references.filter(({ sourceType }) => sourceType === "SO")) {
      cases.push({
        ...load,
        references: undefined,
        sourceType: "SO",
        rootReference: reference.rootReference,
        deduplicationKey: `SO|${reference.rootReference}|${load.physicalLoadId}`,
        allocatedAmountMinor: load.sharedTotalMinor,
        allocationKey: null,
        currency: crossChargeCurrency
      });
    }
    for (const reference of references.filter(({ sourceType }) => sourceType === "TO")) {
      if (globalToRoots.has(reference.rootReference)) {
        continue;
      }
      globalToRoots.add(reference.rootReference);
      cases.push({
        ...load,
        references: undefined,
        sourceType: "TO",
        rootReference: reference.rootReference,
        deduplicationKey: `TO|${reference.rootReference}`,
        allocatedAmountMinor: load.sharedTotalMinor,
        allocationKey: null,
        currency: crossChargeCurrency
      });
    }
    const sharedReferences = references.filter(({ sourceType }) => sourceType === "PO" || sourceType === "VRMA");
    if (sharedReferences.length > 0) {
      const allocationKey = `NON_SO|${load.physicalLoadId}`;
      const base = Math.floor(load.sharedTotalMinor / sharedReferences.length);
      const remainder = load.sharedTotalMinor - (base * sharedReferences.length);
      const allocations = sharedReferences.map((reference, index) => {
        const allocatedAmountMinor = index === sharedReferences.length - 1 ? base + remainder : base;
        const allocation = {
          sourceType: reference.sourceType,
          rootReference: reference.rootReference,
          sortedOrdinal: index,
          eligibleReferenceCount: sharedReferences.length,
          sharedTotalMinor: load.sharedTotalMinor,
          allocatedAmountMinor,
          remainderMinor: index === sharedReferences.length - 1 ? remainder : 0
        };
        cases.push({
          ...load,
          references: undefined,
          sourceType: reference.sourceType,
          rootReference: reference.rootReference,
          deduplicationKey: `${reference.sourceType}|${reference.rootReference}|${load.physicalLoadId}`,
          allocatedAmountMinor,
          allocationKey,
          currency: crossChargeCurrency
        });
        return allocation;
      });
      allocationGroups.push({
        allocationKey,
        physicalLoadId: load.physicalLoadId,
        sharedTotalMinor: load.sharedTotalMinor,
        currency: crossChargeCurrency,
        allocations
      });
    }
  }
  cases.sort((left, right) => sourceOrder(left.sourceType) - sourceOrder(right.sourceType)
    || left.rootReference.localeCompare(right.rootReference)
    || left.physicalLoadId.localeCompare(right.physicalLoadId));
  return {
    schemaVersion: "mbbs-local-cross-charge-v1",
    currency: crossChargeCurrency,
    cases,
    allocationGroups,
    calculationExplanation: {
      soDeduplication: "root_and_physical_load",
      toDeduplication: "root_globally_first_stable_load",
      poVrmaDeduplication: "type_root_and_physical_load",
      allocation: "sorted_equal_integer_cents_final_root_receives_remainder"
    }
  };
}

// @ts-check

import { MbtError } from "./errors.js";
import { selectRateBand, validateRateBands } from "./rate-bands.js";
import {
  calculateDistanceBandChargeMinor,
  DISTANCE_BOUNDARY_RULES,
  DISTANCE_PRICING_BASES,
  normalizedBoundaryRule,
  normalizedDistancePricingBasis
} from "./distance-band-pricing.js";

/** @param {string} code @param {string} message @returns {never} */
function invalid(code, message) {
  throw new MbtError({ status: 400, code, message });
}

/** @param {unknown} value @param {string} code @param {string} label */
function safeNonnegativeInteger(value, code, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    invalid(code, `${label} must be a non-negative safe integer.`);
  }
  return Number(value);
}

/** @param {number} left @param {number} right */
function safeMultiply(left, right) {
  const result = left * right;
  if (!Number.isSafeInteger(result)) {
    invalid("MBT_RATE_MONEY_OVERFLOW", "The calculated amount exceeds safe integer cents.");
  }
  return result;
}

/** @param {number} left @param {number} right */
function safeAdd(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    invalid("MBT_RATE_MONEY_OVERFLOW", "The calculated subtotal exceeds safe integer cents.");
  }
  return result;
}

/** @param {unknown} value @param {string} label */
function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("MBT_RATE_INPUT_INVALID", `${label} is required.`);
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} value */
function normalizedCurrency(value) {
  const currency = String(value || "").trim().toUpperCase();
  if (currency !== "CAD") {
    invalid("MBT_RATE_CURRENCY_MISMATCH", "Local rate calculations require CAD evidence.");
  }
  return currency;
}

/** @param {Record<string, any>} component */
function componentUnit(component) {
  return ({
    flat: "EA",
    per_day: "DAY",
    per_week: "WEEK",
    per_unit: "EA"
  })[String(component.rateBasis || "")] || null;
}

/** @param {Record<string, any>} input @param {Record<string, any>} component */
function componentQuantity(input, component) {
  if (component.rateBasis === "flat") {
    return 1;
  }
  const supplied = input.componentQuantities?.[component.componentCode] ?? 1;
  if (!Number.isSafeInteger(supplied) || Number(supplied) < 0) {
    invalid("MBT_RATE_QUANTITY_INVALID", "Rate component quantities must be non-negative safe integers.");
  }
  return Number(supplied);
}

/** @param {Record<string, any>} input @param {string} currency */
function scopedBands(input, currency) {
  if (!Array.isArray(input.distanceBands)) {
    invalid("MBT_RATE_BANDS_INVALID", "Distance bands are required.");
  }
  const bands = input.distanceBands
    .filter((band) => band?.serviceCode === input.serviceCode
      && (band?.binTypeCode === null
        || band?.binTypeCode === undefined
        || band.binTypeCode === input.binTypeCode))
    .map((band) => ({ ...band }))
    .sort((left, right) => left.minimumMetres - right.minimumMetres
      || left.sequenceNumber - right.sequenceNumber
      || String(left.rateDistanceBandId).localeCompare(String(right.rateDistanceBandId)));
  for (const band of bands) {
    safeNonnegativeInteger(band.minimumMetres, "MBT_RATE_DISTANCE_INVALID", "Band minimum metres");
    if (band.maximumMetres !== null) {
      safeNonnegativeInteger(band.maximumMetres, "MBT_RATE_DISTANCE_INVALID", "Band maximum metres");
    }
    safeNonnegativeInteger(band.amountMinor, "MBT_RATE_MONEY_INVALID", "Band amount");
    normalizedDistancePricingBasis(band.pricingBasis);
    normalizedBoundaryRule(band.boundaryRule);
    safeNonnegativeInteger(
      band.downtownSurchargeMinor ?? 0,
      "MBT_RATE_MONEY_INVALID",
      "Downtown surcharge"
    );
    if (String(band.currency || "").toUpperCase() !== currency) {
      invalid("MBT_RATE_CURRENCY_MISMATCH", "Distance-band currency does not match the calculation.");
    }
  }
  const validation = validateRateBands(bands);
  if (!validation.valid) {
    invalid("MBT_RATE_BANDS_INVALID", "The scoped distance bands are invalid.");
  }
  return bands;
}

/** @param {Record<string, any>} input @param {string} currency */
function scopedComponents(input, currency) {
  if (!Array.isArray(input.components)) {
    invalid("MBT_RATE_COMPONENTS_INVALID", "Rate components are required.");
  }
  return input.components
    .filter((component) => component?.active === true
      && (component.serviceCode === null
        || component.serviceCode === undefined
        || component.serviceCode === input.serviceCode)
      && (component.binTypeCode === null
        || component.binTypeCode === undefined
        || component.binTypeCode === input.binTypeCode))
    .sort((left, right) => String(left.componentCode).localeCompare(String(right.componentCode)))
    .map((component) => {
      if (String(component.currency || "").toUpperCase() !== currency) {
        invalid("MBT_RATE_CURRENCY_MISMATCH", "Component currency does not match the calculation.");
      }
      const amountMinor = safeNonnegativeInteger(
        component.amountMinor,
        "MBT_RATE_MONEY_INVALID",
        "Component amount"
      );
      const unitOfMeasure = componentUnit(component);
      if (!unitOfMeasure) {
        invalid("MBT_RATE_COMPONENT_BASIS_INVALID", "This component basis is not supported by the pure calculator.");
      }
      const quantity = componentQuantity(input, component);
      return {
        lineCode: String(component.componentCode),
        lineType: String(component.componentKind),
        quantity,
        unitOfMeasure,
        unitAmountMinor: amountMinor,
        netAmountMinor: safeMultiply(amountMinor, quantity),
        currency,
        source: { type: "rate_component", code: String(component.componentCode) }
      };
    });
}

/**
 * Calculate deterministic local shadow-rate lines from immutable evidence.
 * Distance is selected from raw metres; no kilometre rounding is permitted.
 *
 * @param {unknown} value
 */
// eslint-disable-next-line complexity -- One deterministic calculator validates each optional rate component before composing exact-cent lines.
export function calculateLocalRate(value) {
  const input = requiredObject(value, "A local-rate calculation");
  const rawDistanceMetres = safeNonnegativeInteger(
    input.rawDistanceMetres,
    "MBT_RATE_DISTANCE_INVALID",
    "Distance"
  );
  const currency = normalizedCurrency(input.currency);
  const bands = scopedBands(input, currency);
  // A validated band group always starts at zero and has an open final band,
  // so every non-negative distance has exactly one result.
  const selectedBand = /** @type {Record<string, any>} */ (
    selectRateBand(bands, rawDistanceMetres)
  );
  const unitAmountMinor = safeNonnegativeInteger(
    selectedBand.amountMinor,
    "MBT_RATE_MONEY_INVALID",
    "Transport amount"
  );
  const pricingBasis = normalizedDistancePricingBasis(selectedBand.pricingBasis);
  const basePlusExcess = pricingBasis === DISTANCE_PRICING_BASES.PER_KM
    && selectedBand.baseAmountMinor !== null
    && selectedBand.baseAmountMinor !== undefined
    && selectedBand.includedMetres !== null
    && selectedBand.includedMetres !== undefined;
  const amountMinor = calculateDistanceBandChargeMinor({
    amountMinor: selectedBand.amountMinor,
    pricingBasis: selectedBand.pricingBasis,
    baseAmountMinor: selectedBand.baseAmountMinor,
    includedMetres: selectedBand.includedMetres
  }, rawDistanceMetres);
  /** @type {Array<Record<string, any>>} */
  const lines = [{
    lineCode: "transport",
    lineType: "transport",
    quantity: basePlusExcess
      ? 1
      : pricingBasis === DISTANCE_PRICING_BASES.PER_KM
      ? Math.max(0, rawDistanceMetres - Number(selectedBand.includedMetres || 0)) / 1000
      : 1,
    unitOfMeasure: pricingBasis === DISTANCE_PRICING_BASES.PER_KM && !basePlusExcess ? "KM" : "TRIP",
    unitAmountMinor: basePlusExcess ? amountMinor : unitAmountMinor,
    netAmountMinor: amountMinor,
    currency,
    source: { type: "distance_band", id: String(selectedBand.rateDistanceBandId) }
  }];
  const surchargeMinor = safeNonnegativeInteger(
    selectedBand.downtownSurchargeMinor ?? 0,
    "MBT_RATE_MONEY_INVALID",
    "Downtown surcharge"
  );
  if (input.downtown === true && surchargeMinor > 0) {
    lines.push({
      lineCode: "downtown_surcharge",
      lineType: "surcharge",
      quantity: 1,
      unitOfMeasure: "TRIP",
      unitAmountMinor: surchargeMinor,
      netAmountMinor: surchargeMinor,
      currency,
      source: { type: "distance_band", id: String(selectedBand.rateDistanceBandId) }
    });
  }
  lines.push(...scopedComponents(input, currency));
  const subtotalMinor = lines.reduce(
    (subtotal, line) => safeAdd(subtotal, line.netAmountMinor),
    0
  );
  return {
    schemaVersion: "mbt-local-rate-v1",
    rateCardVersionId: String(input.rateCardVersionId),
    serviceCode: String(input.serviceCode),
    binTypeCode: String(input.binTypeCode),
    rawDistanceMetres,
    currency,
    selectedDistanceBandId: String(selectedBand.rateDistanceBandId),
    lines,
    subtotalMinor,
    calculationExplanation: {
      arithmetic: "integer_minor_units",
      distanceSelection: normalizedBoundaryRule(selectedBand.boundaryRule)
        === DISTANCE_BOUNDARY_RULES.QUOTED_UPPER_INCLUSIVE
        ? "raw_metres_first_minimum_inclusive_then_minimum_exclusive_maximum_inclusive"
        : "raw_metres_minimum_inclusive_maximum_exclusive",
      roundedKilometresUsed: false,
      selectedBand: {
        minimumMetres: Number(selectedBand.minimumMetres),
        maximumMetres: selectedBand.maximumMetres === null
          ? null
          : Number(selectedBand.maximumMetres)
      },
      ...(pricingBasis === DISTANCE_PRICING_BASES.PER_KM
        ? { distancePricing: "actual_metres_x_cents_per_km_rounded_once_to_cent" }
        : {})
    }
  };
}

/** @param {Record<string, any>} input @param {string} currency */
function selectedDumpTariff(input, currency) {
  if (!Array.isArray(input.tariffs)) {
    invalid("MBT_DUMP_TARIFF_INVALID", "Dump tariff evidence is required.");
  }
  const tariff = input.tariffs
    .filter((candidate) => candidate?.active === true
      && candidate.dumpSiteId === input.dumpSiteId
      && (candidate.materialId === null
        || candidate.materialId === undefined
        || candidate.materialId === input.materialId))
    .sort((left, right) => String(left.tariffCode).localeCompare(String(right.tariffCode)))[0];
  if (!tariff) {
    invalid("MBT_DUMP_TARIFF_NOT_FOUND", "No active dump tariff matches this receipt.");
  }
  if (String(tariff.currency || "").toUpperCase() !== currency) {
    invalid("MBT_RATE_CURRENCY_MISMATCH", "Dump-tariff currency does not match the calculation.");
  }
  if (tariff.pricingBasis !== "fixed" && tariff.unitOfMeasure !== input.unitOfMeasure) {
    invalid("MBT_DUMP_TARIFF_UNIT_MISMATCH", "Dump-tariff unit does not match the receipt unit.");
  }
  return tariff;
}

/**
 * Keep configured customer tariff, actual receipt cost, and margin as three
 * independent exact-cent values.
 *
 * @param {unknown} value
 */
export function calculateDumpRate(value) {
  const input = requiredObject(value, "A dump-rate calculation");
  const currency = normalizedCurrency(input.currency);
  const quantity = safeNonnegativeInteger(
    input.quantity,
    "MBT_RATE_QUANTITY_INVALID",
    "Dump quantity"
  );
  const actualCostMinor = safeNonnegativeInteger(
    input.actualCostMinor,
    "MBT_RATE_MONEY_INVALID",
    "Actual dump cost"
  );
  const tariff = selectedDumpTariff(input, currency);
  const unitAmountMinor = safeNonnegativeInteger(
    tariff.amountMinor,
    "MBT_RATE_MONEY_INVALID",
    "Dump tariff amount"
  );
  const minimumAmountMinor = safeNonnegativeInteger(
    tariff.minimumAmountMinor ?? 0,
    "MBT_RATE_MONEY_INVALID",
    "Dump tariff minimum"
  );
  const calculatedTariffMinor = tariff.pricingBasis === "fixed"
    ? unitAmountMinor
    : safeMultiply(unitAmountMinor, quantity);
  const customerChargeMinor = Math.max(calculatedTariffMinor, minimumAmountMinor);
  const marginMinor = customerChargeMinor - actualCostMinor;
  return {
    schemaVersion: "mbt-dump-rate-v1",
    currency,
    dumpTariffId: String(tariff.dumpTariffId),
    pricingBasis: String(tariff.pricingBasis),
    quantity,
    unitOfMeasure: String(input.unitOfMeasure),
    unitAmountMinor,
    calculatedTariffMinor,
    minimumAmountMinor,
    customerChargeMinor,
    actualCostMinor,
    marginMinor,
    calculationExplanation: {
      arithmetic: "integer_minor_units",
      customerCharge: "max(quantity_x_unit_amount, minimum_amount)",
      actualCostIncludedInCustomerCharge: false
    }
  };
}

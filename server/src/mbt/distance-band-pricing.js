// @ts-check

import { MbtError } from "./errors.js";

export const DISTANCE_BOUNDARY_RULES = Object.freeze({
  LEGACY_LOWER_INCLUSIVE: "lower_inclusive",
  QUOTED_UPPER_INCLUSIVE: "upper_inclusive"
});

export const DISTANCE_PRICING_BASES = Object.freeze({
  FLAT: "flat",
  PER_KM: "per_km"
});

/** @param {unknown} value @returns {"lower_inclusive" | "upper_inclusive"} */
export function normalizedBoundaryRule(value) {
  const rule = String(value || DISTANCE_BOUNDARY_RULES.LEGACY_LOWER_INCLUSIVE);
  if (rule !== DISTANCE_BOUNDARY_RULES.LEGACY_LOWER_INCLUSIVE
      && rule !== DISTANCE_BOUNDARY_RULES.QUOTED_UPPER_INCLUSIVE) {
    throw new MbtError({
      status: 400,
      code: "MBT_RATE_BOUNDARY_RULE_INVALID",
      message: "The distance-band boundary rule is invalid."
    });
  }
  return /** @type {"lower_inclusive" | "upper_inclusive"} */ (rule);
}

/** @param {unknown} value @returns {"flat" | "per_km"} */
export function normalizedDistancePricingBasis(value) {
  const basis = String(value || DISTANCE_PRICING_BASES.FLAT);
  if (basis !== DISTANCE_PRICING_BASES.FLAT && basis !== DISTANCE_PRICING_BASES.PER_KM) {
    throw new MbtError({
      status: 400,
      code: "MBT_RATE_PRICING_BASIS_INVALID",
      message: "The distance-band pricing basis is invalid."
    });
  }
  return /** @type {"flat" | "per_km"} */ (basis);
}

/**
 * Legacy bands are [minimum, maximum). The printed MBT quotation uses the
 * opposite shared-boundary ownership: the first range starts at zero and each
 * finite maximum is inclusive, so exactly 30 km remains in "Within 30 km".
 *
 * @param {{minimumMetres: number, maximumMetres: number | null, boundaryRule?: unknown}} band
 * @param {number} distanceMetres
 */
export function distanceBandContains(band, distanceMetres) {
  const rule = normalizedBoundaryRule(band.boundaryRule);
  if (rule === DISTANCE_BOUNDARY_RULES.QUOTED_UPPER_INCLUSIVE) {
    const aboveMinimum = band.minimumMetres === 0
      ? distanceMetres >= band.minimumMetres
      : distanceMetres > band.minimumMetres;
    return aboveMinimum
      && (band.maximumMetres === null || distanceMetres <= band.maximumMetres);
  }
  return distanceMetres >= band.minimumMetres
    && (band.maximumMetres === null || distanceMetres < band.maximumMetres);
}

/**
 * Return exact cents for a selected distance band. Per-kilometre prices use
 * the unrounded integer metre distance and round once to the nearest cent.
 *
 * A per-kilometre band may additionally own an exact base amount and included
 * metre threshold. Both fields are required together so an incomplete rate
 * graph can never silently fall back to charging the full distance.
 *
 * @param {{amountMinor: unknown, pricingBasis?: unknown, baseAmountMinor?: unknown, includedMetres?: unknown}} band
 * @param {number} rawDistanceMetres
 */
// eslint-disable-next-line complexity -- Fail-closed validation keeps legacy, flat, per-km, and paired base/excess evidence in one money boundary.
export function calculateDistanceBandChargeMinor(band, rawDistanceMetres) {
  if (!Number.isSafeInteger(rawDistanceMetres) || rawDistanceMetres < 0) {
    throw new MbtError({
      status: 400,
      code: "MBT_RATE_DISTANCE_INVALID",
      message: "Distance must be a non-negative integer number of metres."
    });
  }
  if (!Number.isSafeInteger(band.amountMinor) || Number(band.amountMinor) < 0) {
    throw new MbtError({
      status: 400,
      code: "MBT_RATE_MONEY_INVALID",
      message: "Band amount must be a non-negative safe integer."
    });
  }
  const unitAmountMinor = Number(band.amountMinor);
  if (normalizedDistancePricingBasis(band.pricingBasis) === DISTANCE_PRICING_BASES.FLAT) {
    if ((band.baseAmountMinor !== undefined && band.baseAmountMinor !== null)
        || (band.includedMetres !== undefined && band.includedMetres !== null)) {
      throw new MbtError({
        status: 400,
        code: "MBT_RATE_EXCESS_CONFIGURATION_INVALID",
        message: "Base-plus-excess fields may only be used with per-kilometre pricing."
      });
    }
    return unitAmountMinor;
  }
  const hasBase = band.baseAmountMinor !== undefined && band.baseAmountMinor !== null;
  const hasIncluded = band.includedMetres !== undefined && band.includedMetres !== null;
  if (hasBase !== hasIncluded) {
    throw new MbtError({
      status: 400,
      code: "MBT_RATE_EXCESS_CONFIGURATION_INVALID",
      message: "Base amount and included metres must be configured together."
    });
  }
  let baseAmountMinor = 0;
  let chargeableMetres = rawDistanceMetres;
  if (hasBase && hasIncluded) {
    if (!Number.isSafeInteger(band.baseAmountMinor) || Number(band.baseAmountMinor) < 0
        || !Number.isSafeInteger(band.includedMetres) || Number(band.includedMetres) < 0) {
      throw new MbtError({
        status: 400,
        code: "MBT_RATE_EXCESS_CONFIGURATION_INVALID",
        message: "Base amount and included metres must be non-negative safe integers."
      });
    }
    baseAmountMinor = Number(band.baseAmountMinor);
    chargeableMetres = Math.max(0, rawDistanceMetres - Number(band.includedMetres));
  }
  const excessAmount = ((BigInt(chargeableMetres) * BigInt(unitAmountMinor)) + 500n) / 1000n;
  const rounded = BigInt(baseAmountMinor) + excessAmount;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MbtError({
      status: 400,
      code: "MBT_RATE_MONEY_OVERFLOW",
      message: "The calculated amount exceeds safe integer cents."
    });
  }
  return Number(rounded);
}

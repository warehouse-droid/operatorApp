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
 * @param {{amountMinor: unknown, pricingBasis?: unknown}} band
 * @param {number} rawDistanceMetres
 */
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
    return unitAmountMinor;
  }
  const rounded = ((BigInt(rawDistanceMetres) * BigInt(unitAmountMinor)) + 500n) / 1000n;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MbtError({
      status: 400,
      code: "MBT_RATE_MONEY_OVERFLOW",
      message: "The calculated amount exceeds safe integer cents."
    });
  }
  return Number(rounded);
}

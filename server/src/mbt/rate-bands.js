// @ts-check

import { MbtError } from "./errors.js";
import { distanceBandContains, normalizedBoundaryRule } from "./distance-band-pricing.js";

/** @typedef {{minimumMetres: number, maximumMetres: number | null, [key: string]: unknown}} RateBand */
/** @typedef {{code: string, message: string}} RateBandIssue */

/** @param {string} code @param {string} message @returns {RateBandIssue} */
function issue(code, message) {
  return { code, message };
}

/** @param {unknown} value @param {{allowNull?: boolean}} [options] */
function validBoundary(value, { allowNull = false } = {}) {
  return (allowNull && value === null)
    || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

/** @param {RateBand} band @param {RateBandIssue[]} issues */
function validateBandBoundaries(band, issues) {
  if (!band || !validBoundary(band.minimumMetres) || !validBoundary(band.maximumMetres, { allowNull: true })) {
    issues.push(issue(
      "MBT_RATE_BAND_METRES",
      "Rate band boundaries must be non-negative integer metres or a final null maximum."
    ));
    return;
  }
  if (band.maximumMetres !== null && band.maximumMetres <= band.minimumMetres) {
    issues.push(issue(
      "MBT_RATE_BAND_RANGE",
      "A rate band maximum must be greater than its minimum."
    ));
  }
}

/**
 * @param {RateBand} previous
 * @param {RateBand} current
 * @param {number} index
 * @param {RateBandIssue[]} issues
 */
function validateAdjacentBands(previous, current, index, issues) {
  if (!previous || !current) {
    return;
  }
  if (previous.maximumMetres === null) {
    issues.push(issue(
      "MBT_RATE_BAND_OPEN_NOT_LAST",
      "Only the final rate band may have an open maximum."
    ));
    return;
  }
  if (!Number.isInteger(previous.maximumMetres) || !Number.isInteger(current.minimumMetres)) {
    return;
  }
  if (current.minimumMetres > previous.maximumMetres) {
    issues.push(issue(
      "MBT_RATE_BAND_GAP",
      `Rate bands must be contiguous; band ${index + 1} begins after band ${index} ends.`
    ));
  } else if (current.minimumMetres < previous.maximumMetres) {
    issues.push(issue(
      "MBT_RATE_BAND_OVERLAP",
      `Rate bands must not overlap; band ${index + 1} begins before band ${index} ends.`
    ));
  }
}

/** @param {RateBand[]} rateBands @param {RateBandIssue[]} issues */
function validateBoundaryRules(rateBands, issues) {
  const boundaryRules = new Set();
  for (const band of rateBands) {
    if (!band || typeof band !== "object") {
      continue;
    }
    try {
      boundaryRules.add(normalizedBoundaryRule(band.boundaryRule));
    } catch {
      issues.push(issue(
        "MBT_RATE_BAND_BOUNDARY_RULE",
        "Every rate band must use a supported boundary rule."
      ));
    }
  }
  if (boundaryRules.size > 1) {
    issues.push(issue(
      "MBT_RATE_BAND_BOUNDARY_MIXED",
      "Every band in one distance series must use the same boundary rule."
    ));
  }
}

/** @param {unknown} bands @returns {{valid: boolean, issues: RateBandIssue[]}} */
export function validateRateBands(bands) {
  if (!Array.isArray(bands) || bands.length === 0) {
    return {
      valid: false,
      issues: [issue("MBT_RATE_BANDS_EMPTY", "At least one rate band is required.")]
    };
  }

  const rateBands = /** @type {RateBand[]} */ (bands);
  /** @type {RateBandIssue[]} */
  const issues = [];

  for (const band of rateBands) {
    validateBandBoundaries(band, issues);
  }
  validateBoundaryRules(rateBands, issues);

  if (rateBands[0]?.minimumMetres !== 0) {
    issues.push(issue("MBT_RATE_BAND_START", "The first rate band must begin at 0 metres."));
  }

  for (let index = 1; index < rateBands.length; index += 1) {
    const previous = rateBands[index - 1];
    const current = rateBands[index];
    if (!previous || !current) {
      continue;
    }
    validateAdjacentBands(previous, current, index, issues);
  }

  if (rateBands.at(-1)?.maximumMetres !== null) {
    issues.push(issue("MBT_RATE_BAND_FINAL_OPEN", "The final rate band must have an open maximum."));
  }

  return {
    valid: issues.length === 0,
    issues
  };
}

/**
 * @param {unknown} bands
 * @param {unknown} distanceMetres
 * @returns {RateBand | undefined}
 */
export function selectRateBand(bands, distanceMetres) {
  if (typeof distanceMetres !== "number" || !Number.isInteger(distanceMetres) || distanceMetres < 0) {
    throw new MbtError({
      status: 400,
      code: "MBT_RATE_DISTANCE_INVALID",
      message: "Distance must be a non-negative integer number of metres."
    });
  }

  const validation = validateRateBands(bands);
  if (!validation.valid) {
    throw new MbtError({
      status: 400,
      code: "MBT_RATE_BANDS_INVALID",
      message: "Rate bands are invalid.",
      details: { issues: validation.issues }
    });
  }

  const rateBands = /** @type {RateBand[]} */ (bands);
  return rateBands.find((band) => distanceBandContains(band, distanceMetres));
}

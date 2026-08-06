// @ts-check

import { MbtError } from "./errors.js";

/** @param {unknown} value @returns {value is number} */
function positiveRevision(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * @param {unknown} actualRevision
 * @param {unknown} expectedRevision
 * @returns {number}
 */
export function assertExpectedRevision(actualRevision, expectedRevision) {
  if (!positiveRevision(expectedRevision)) {
    throw new MbtError({
      status: 400,
      code: "MBT_REVISION_REQUIRED",
      message: "A positive integer expected revision is required."
    });
  }
  if (!positiveRevision(actualRevision)) {
    throw new TypeError("The stored revision must be a positive integer.");
  }
  if (actualRevision !== expectedRevision) {
    throw new MbtError({
      status: 409,
      code: "MBT_STALE_REVISION",
      message: "This MBT record changed. Refresh it before saving again."
    });
  }
  return actualRevision;
}

/** @param {unknown} revision @returns {number} */
export function nextRevision(revision) {
  if (!positiveRevision(revision)) {
    throw new TypeError("The current revision must be a positive revision integer.");
  }
  if (revision >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("The current revision exceeds the safe integer range.");
  }
  return revision + 1;
}

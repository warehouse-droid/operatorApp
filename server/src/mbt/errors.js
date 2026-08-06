// @ts-check

/**
 * @typedef {object} MbtErrorOptions
 * @property {number} [status]
 * @property {string} [code]
 * @property {string} [message]
 * @property {Record<string, unknown>} [details]
 * @property {unknown} [cause]
 */

/** @param {unknown} value */
function normalizedStatus(value) {
  return Number.isInteger(value) && Number(value) >= 400 && Number(value) <= 599
    ? Number(value)
    : 500;
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function normalizedDetails(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {unknown} cause @returns {{cause: unknown} | undefined} */
function causeOptions(cause) {
  return cause === undefined ? undefined : { cause };
}

export class MbtError extends Error {
  /** @param {MbtErrorOptions} [options] */
  constructor(options = {}) {
    super(options.message || "An unexpected error occurred.", causeOptions(options.cause));
    this.name = "MbtError";
    this.status = normalizedStatus(options.status);
    this.code = String(options.code || "MBT_INTERNAL_ERROR");
    this.details = normalizedDetails(options.details);
  }
}

/**
 * @param {unknown} error
 * @param {{correlationId?: string}} [options]
 */
export function toErrorEnvelope(error, { correlationId = "" } = {}) {
  const mbtError = error instanceof MbtError
    ? error
    : new MbtError();

  return {
    status: mbtError.status,
    body: {
      error: mbtError.message,
      code: mbtError.code,
      details: mbtError.details,
      correlationId: String(correlationId)
    }
  };
}

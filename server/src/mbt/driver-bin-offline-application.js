// @ts-check

import { MBT_DRIVER_BIN_JOB_SCHEMA } from "./driver-bin-contract.js";
import {
  completeMbtDriverBinJob,
  startMbtDriverBinJob
} from "./driver-bin-execution-service.js";
import { MbtError } from "./errors.js";

/** @param {string} code @param {string} message */
function unsupported(code, message) {
  return new MbtError({ status: 409, code, message });
}

/** @param {unknown} value */
function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/**
 * Apply only the versioned BIN portion of the established offline queue.
 * Returning null is the explicit signal that the ordinary Driver handler owns
 * the event. Once a job carries MBT identity, unsupported schemas and event
 * types fail closed instead of falling through to generic order side effects.
 *
 * @param {Record<string, any>} context
 * @param {object} [operations]
 * @param {typeof startMbtDriverBinJob} [operations.startOperation]
 * @param {typeof completeMbtDriverBinJob} [operations.completeOperation]
 */
export async function applyMbtDriverBinOfflineEvent(context, {
  startOperation = startMbtDriverBinJob,
  completeOperation = completeMbtDriverBinJob
} = {}) {
  const job = objectValue(context.job);
  const mbt = objectValue(job.mbt);
  if (!Object.keys(mbt).length) {
    return null;
  }
  if (mbt.schemaVersion !== MBT_DRIVER_BIN_JOB_SCHEMA) {
    throw unsupported(
      "MBT_DRIVER_BIN_JOB_UNSUPPORTED",
      "The saved BIN Driver job version is unsupported. Close and reopen the Driver PWA."
    );
  }
  const capability = { issuedManifestAuthorized: true };
  const operationInput = /** @type {any} */ (context);
  let application;
  if (context.event?.eventType === "job_started") {
    application = await startOperation(operationInput, { capability });
  } else if (context.event?.eventType === "job_completed") {
    application = await completeOperation(operationInput, { capability });
  } else {
    throw unsupported(
      "MBT_DRIVER_BIN_EVENT_UNSUPPORTED",
      "This event type is not valid for a BIN Driver job."
    );
  }
  return {
    ...objectValue(application.body),
    replayed: application.replayed === true
  };
}

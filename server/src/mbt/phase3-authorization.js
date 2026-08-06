// @ts-check

import { config } from "../config.js";
import { query } from "../db.js";
import { MbtError } from "./errors.js";
import {
  evaluateMbtPhase3Capability,
  MBT_PHASE3_CAPABILITY_DEFINITIONS
} from "./phase3-capabilities.js";

/**
 * Load Phase 3 gates at the command boundary. Environment and database gates
 * are deliberately independent; a missing row therefore fails closed.
 */
async function phase3DatabaseFlags() {
  const result = await query(
    `SELECT flag_key, enabled
       FROM mbt_feature_flags
      WHERE flag_key = ANY($1::text[])`,
    [[
      "mbt_enabled",
      ...Object.values(MBT_PHASE3_CAPABILITY_DEFINITIONS)
        .map(({ databaseFlag }) => databaseFlag)
    ]]
  );
  return Object.fromEntries(result.rows.map((/** @type {Record<string, unknown>} */ row) => [
    String(row.flag_key),
    row.enabled === true
  ]));
}

/**
 * Assert a server-derived Phase 3 capability. Configuration commands use the
 * authenticated Admin boundary as their pilot scope; later operational
 * callers must pass their independently derived pilot authorization.
 *
 * @param {object} input
 * @param {string} input.capability
 * @param {boolean} [input.pilotAuthorized]
 */
export async function authorizeMbtPhase3Capability({
  capability,
  pilotAuthorized = true
}) {
  const definition = MBT_PHASE3_CAPABILITY_DEFINITIONS[capability];
  if (!definition) {
    throw new MbtError({
      status: 400,
      code: "MBT_CAPABILITY_INVALID",
      message: "This MBT capability is not recognized."
    });
  }
  const result = evaluateMbtPhase3Capability({
    capability,
    environment: {
      enabled: config.mbt.enabled,
      netSuiteWritesEnabled: config.mbt.netSuiteWritesEnabled,
      ...config.mbtPhase3
    },
    databaseFlags: await phase3DatabaseFlags(),
    pilotAuthorized
  });
  if (!result.enabled) {
    throw new MbtError({
      status: 409,
      code: result.code || "MBT_CAPABILITY_DISABLED",
      message: "This MBT capability is disabled.",
      details: {
        capability: definition.databaseFlag.replace(/^mbt_/u, ""),
        reason: result.reason
      }
    });
  }
  return result;
}

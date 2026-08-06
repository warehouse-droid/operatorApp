// @ts-check

import { query } from "../db.js";
import { evaluateCapability } from "./capabilities.js";

/** @typedef {{flagKey: string, enabled: boolean, description: string, revision: number, updatedBy: unknown, createdAt: unknown, updatedAt: unknown}} MbtFeatureFlag */

export const MBT_CAPABILITY_FLAGS = Object.freeze({
  frontdesk: "mbt_frontdesk_operations",
  binDispatch: "mbt_bin_dispatch",
  driverBin: "mbt_driver_execution",
  billing: "mbt_billing_operations",
  netSuiteWrites: "mbt_netsuite_writes"
});

const PUBLIC_MBT_FEATURE_FLAGS = Object.freeze([
  "mbt_enabled",
  ...Object.values(MBT_CAPABILITY_FLAGS)
]);

/** @param {Record<string, unknown>} row @returns {MbtFeatureFlag} */
function featureFlag(row) {
  return {
    flagKey: String(row.flag_key),
    enabled: row.enabled === true,
    description: String(row.description || ""),
    revision: Number(row.revision),
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** @returns {Promise<MbtFeatureFlag[]>} */
export async function listMbtFeatureFlags() {
  const result = await query(
    `SELECT flag_key, enabled, description, revision,
            updated_by, created_at, updated_at
       FROM mbt_feature_flags
      WHERE flag_key = ANY($1::text[])
      ORDER BY flag_key`,
    [PUBLIC_MBT_FEATURE_FLAGS]
  );
  return /** @type {Record<string, unknown>[]} */ (result.rows).map(featureFlag);
}

/** @param {{environmentEnabled?: boolean, netSuiteWritesEnabled?: boolean}} [options] */
export async function getMbtStatus({
  environmentEnabled = false,
  netSuiteWritesEnabled = false
} = {}) {
  const flags = await listMbtFeatureFlags();
  const enabledByKey = new Map(flags.map((flag) => [flag.flagKey, flag.enabled]));
  const databaseRootEnabled = enabledByKey.get("mbt_enabled") === true;
  /** @type {Record<string, ReturnType<typeof evaluateCapability>>} */
  const capabilities = {};
  for (const [name, flagKey] of Object.entries(MBT_CAPABILITY_FLAGS)) {
    capabilities[name] = evaluateCapability({
      mbtEnabled: environmentEnabled === true,
      capabilityEnabled: databaseRootEnabled && enabledByKey.get(flagKey) === true,
      requiresNetSuiteWrite: name === "netSuiteWrites",
      netSuiteWritesEnabled: netSuiteWritesEnabled === true
    });
  }
  return {
    schemaVersion: "mbt-v1",
    phase: 1,
    foundationEnabled: environmentEnabled === true,
    operational: Object.values(capabilities).some((capability) => capability.enabled),
    capabilities
  };
}

/** @param {string} capability @param {{environmentEnabled?: boolean, netSuiteWritesEnabled?: boolean}} [options] */
export async function assertMbtCapability(capability, {
  environmentEnabled = false,
  netSuiteWritesEnabled = false
} = {}) {
  const status = await getMbtStatus({ environmentEnabled, netSuiteWritesEnabled });
  const result = status.capabilities[capability];
  if (!result) {
    throw new TypeError(`Unknown MBT capability: ${String(capability)}.`);
  }
  return result;
}

// @ts-check

const CAPABILITY_DISABLED = "MBT_CAPABILITY_DISABLED";

/**
 * @typedef {object} MbtPhase3CapabilityDefinition
 * @property {string} databaseFlag
 * @property {string} environmentProperty
 * @property {string} environmentVariable
 * @property {boolean} [phase3Forbidden]
 */

/** @type {Record<string, MbtPhase3CapabilityDefinition>} */
const definitions = {
  customerSync: {
    databaseFlag: "mbt_customer_sync",
    environmentProperty: "customerSyncEnabled",
    environmentVariable: "MBT_CUSTOMER_SYNC_ENABLED"
  },
  masterData: {
    databaseFlag: "mbt_master_data",
    environmentProperty: "masterDataEnabled",
    environmentVariable: "MBT_MASTER_DATA_ENABLED"
  },
  assetManagement: {
    databaseFlag: "mbt_asset_management",
    environmentProperty: "assetManagementEnabled",
    environmentVariable: "MBT_ASSET_MANAGEMENT_ENABLED"
  },
  frontdeskOperations: {
    databaseFlag: "mbt_frontdesk_operations",
    environmentProperty: "frontdeskOperationsEnabled",
    environmentVariable: "MBT_FRONTDESK_OPERATIONS_ENABLED"
  },
  binDispatch: {
    databaseFlag: "mbt_bin_dispatch",
    environmentProperty: "binDispatchEnabled",
    environmentVariable: "MBT_BIN_DISPATCH_ENABLED"
  },
  driverExecution: {
    databaseFlag: "mbt_driver_execution",
    environmentProperty: "driverExecutionEnabled",
    environmentVariable: "MBT_DRIVER_EXECUTION_ENABLED"
  },
  billingOperations: {
    databaseFlag: "mbt_billing_operations",
    environmentProperty: "billingOperationsEnabled",
    environmentVariable: "MBT_BILLING_OPERATIONS_ENABLED"
  },
  netSuiteWrites: {
    databaseFlag: "mbt_netsuite_writes",
    environmentProperty: "netSuiteWritesEnabled",
    environmentVariable: "MBT_NETSUITE_WRITES_ENABLED",
    phase3Forbidden: true
  }
};

for (const definition of Object.values(definitions)) {
  Object.freeze(definition);
}

export const MBT_PHASE3_CAPABILITY_DEFINITIONS = Object.freeze(definitions);

/** @param {string} reason */
function denied(reason) {
  return {
    enabled: false,
    code: CAPABILITY_DISABLED,
    reason
  };
}

/** @param {Record<string, unknown>} environment @returns {string | null} */
function environmentRootDenialReason(environment) {
  if (environment.enabled !== true) {
    return "environment_root_disabled";
  }
  return null;
}

/**
 * @param {MbtPhase3CapabilityDefinition} definition
 * @param {Record<string, unknown>} environment
 * @returns {string | null}
 */
function environmentCapabilityDenialReason(definition, environment) {
  if (environment[definition.environmentProperty] !== true) {
    return "environment_capability_disabled";
  }
  return null;
}

/** @param {Record<string, unknown>} databaseFlags @returns {string | null} */
function databaseRootDenialReason(databaseFlags) {
  if (!Object.hasOwn(databaseFlags, "mbt_enabled")) {
    return "database_root_missing";
  }
  if (databaseFlags.mbt_enabled !== true) {
    return "database_root_disabled";
  }
  return null;
}

/**
 * @param {MbtPhase3CapabilityDefinition} definition
 * @param {Record<string, unknown>} databaseFlags
 * @returns {string | null}
 */
function databaseCapabilityDenialReason(definition, databaseFlags) {
  if (!Object.hasOwn(databaseFlags, definition.databaseFlag)) {
    return "database_capability_missing";
  }
  if (databaseFlags[definition.databaseFlag] !== true) {
    return "database_capability_disabled";
  }
  return null;
}

/**
 * Evaluate one Phase 3 command boundary. Callers must supply the independently
 * loaded environment, database, and pilot facts; omission always fails closed.
 *
 * @param {object} input
 * @param {string} input.capability
 * @param {Record<string, unknown>} [input.environment]
 * @param {Record<string, unknown>} [input.databaseFlags]
 * @param {boolean} [input.pilotAuthorized]
 */
export function evaluateMbtPhase3Capability({
  capability,
  environment = {},
  databaseFlags = {},
  pilotAuthorized = false
} = /** @type {any} */ ({})) {
  const definition = MBT_PHASE3_CAPABILITY_DEFINITIONS[capability];
  if (!definition) {
    throw new TypeError(`Unknown MBT Phase 3 capability: ${String(capability)}.`);
  }
  if (definition.phase3Forbidden === true) {
    return denied("phase3_netsuite_writes_forbidden");
  }

  const environmentRootReason = environmentRootDenialReason(environment);
  if (environmentRootReason !== null) {
    return denied(environmentRootReason);
  }

  const databaseRootReason = databaseRootDenialReason(databaseFlags);
  if (databaseRootReason !== null) {
    return denied(databaseRootReason);
  }

  const environmentCapabilityReason = environmentCapabilityDenialReason(definition, environment);
  if (environmentCapabilityReason !== null) {
    return denied(environmentCapabilityReason);
  }

  const databaseCapabilityReason = databaseCapabilityDenialReason(definition, databaseFlags);
  if (databaseCapabilityReason !== null) {
    return denied(databaseCapabilityReason);
  }
  if (pilotAuthorized !== true) {
    return denied("pilot_scope_denied");
  }
  return { enabled: true, code: null, reason: null };
}

/**
 * @param {object} input
 * @param {Record<string, unknown>} [input.environment]
 * @param {Record<string, unknown>} [input.databaseFlags]
 * @param {boolean} [input.pilotAuthorized]
 */
export function evaluateMbtPhase3Capabilities(input = {}) {
  return Object.fromEntries(Object.keys(MBT_PHASE3_CAPABILITY_DEFINITIONS).map((capability) => [
    capability,
    evaluateMbtPhase3Capability({ ...input, capability })
  ]));
}

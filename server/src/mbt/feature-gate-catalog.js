// @ts-check

/**
 * The Admin page owns local operational gates. Live customer synchronization
 * and NetSuite posting remain deployment-owned boundaries.
 */
export const MBT_ADMIN_GATE_DEFINITIONS = Object.freeze([
  Object.freeze({
    flagKey: "driver_offline_mode",
    label: "Driver PWA offline mode",
    description: "Allow Driver devices to save routes, actions, and photo evidence for use without a live connection. When off, Driver actions require internet; retained evidence can still synchronize.",
    environmentProperty: null,
    independent: true,
    locked: false,
    lockReason: null
  }),
  Object.freeze({
    flagKey: "driver_yard_dependency_soft_mode",
    label: "Driver soft yard dependency (testing)",
    description: "Allow Driver PWA start/completion to show a warning instead of blocking on ordinary yard-replenishment Transfer Orders. Dispatch planning and direct-linked/same-truck Transfer Orders always remain hard.",
    environmentProperty: null,
    independent: true,
    locked: false,
    lockReason: null
  }),
  Object.freeze({
    flagKey: "operator_customer_pickup_photo_required",
    label: "Operator Customer Pickup photo requirement",
    description: "Require one photo before Operator completes a Customer Pickup load. When off, Customer Pickup can be completed without photo evidence; optional photos are still saved.",
    environmentProperty: null,
    independent: true,
    locked: false,
    lockReason: null
  }),
  Object.freeze({
    flagKey: "sales_stock_request_over_availability",
    label: "Sales stock request over availability",
    description: "Allow Sales to request more than the selected source yard's current availability for SCM review. SCM can intentionally convert the full demand; any shortage is shown and retained as a Transfer Order backorder.",
    environmentProperty: null,
    independent: true,
    locked: false,
    lockReason: null
  }),
  Object.freeze({
    flagKey: "special_stock_request_workflow",
    label: "Special Item stock requests",
    description: "Enable the guarded multi-line Sales, SCM, and Dispatch workflow, including explicit NetSuite Sales Order and Purchase Order actions.",
    environmentProperty: null,
    independent: true,
    locked: false,
    lockReason: null
  }),
  Object.freeze({
    flagKey: "mbt_enabled",
    label: "MBT local modules",
    description: "Global database gate for every MBT local workflow.",
    environmentProperty: null,
    locked: false,
    lockReason: null
  }),
  Object.freeze({
    flagKey: "mbt_master_data",
    label: "Local master data",
    description: "Customer file imports, local items, materials, dump sites, templates, and rate cards.",
    environmentProperty: "masterDataEnabled",
    locked: false,
    lockReason: null
  }),
  Object.freeze({
    flagKey: "mbt_asset_management",
    label: "BIN asset management",
    description: "Local BIN asset imports, registration, movements, reservations, and reconciliation.",
    environmentProperty: "assetManagementEnabled",
    locked: false,
    lockReason: null
  }),
  Object.freeze({
    flagKey: "mbt_frontdesk_operations",
    label: "Front Desk",
    description: "Local customer sites, quotes, contracts, and current front-leg records.",
    environmentProperty: "frontdeskOperationsEnabled",
    locked: false,
    lockReason: null
  }),
  Object.freeze({
    flagKey: "mbt_bin_dispatch",
    label: "BIN dispatch",
    description: "Local BIN planning, save, restore, and confirmation workflows.",
    environmentProperty: "binDispatchEnabled",
    locked: false,
    lockReason: null
  }),
  Object.freeze({
    flagKey: "mbt_driver_execution",
    label: "Driver BIN workflow",
    description: "Driver PWA BIN projection, offline evidence, and local execution.",
    environmentProperty: "driverExecutionEnabled",
    locked: false,
    lockReason: null
  }),
  Object.freeze({
    flagKey: "mbt_billing_operations",
    label: "Local billing",
    description: "Local distance, receipt, cross-charge, and contract-billing calculations without posting.",
    environmentProperty: "billingOperationsEnabled",
    locked: false,
    lockReason: null
  }),
  Object.freeze({
    flagKey: "mbt_customer_sync",
    label: "Live customer sync",
    description: "Direct customer synchronization from NetSuite.",
    environmentProperty: "customerSyncEnabled",
    locked: true,
    lockReason: "Live customer synchronization remains closed during local testing."
  }),
  Object.freeze({
    flagKey: "mbt_netsuite_writes",
    label: "NetSuite posting",
    description: "Operational MBT writes to NetSuite.",
    environmentProperty: "netSuiteWritesEnabled",
    locked: true,
    lockReason: "NetSuite posting is forbidden in the current non-posting phase."
  })
]);

export const MBT_ADMIN_GATE_KEYS = Object.freeze(
  MBT_ADMIN_GATE_DEFINITIONS.map(({ flagKey }) => flagKey)
);

export const MBT_ADMIN_WRITABLE_GATE_KEYS = Object.freeze(
  MBT_ADMIN_GATE_DEFINITIONS
    .filter(({ locked }) => !locked)
    .map(({ flagKey }) => flagKey)
);

/** @param {Record<string, unknown>} definition @param {Record<string, unknown>} environment */
function environmentAllows(definition, environment) {
  if (definition.independent === true) {
    return true;
  }
  if (environment.enabled !== true) {
    return false;
  }
  const property = definition.environmentProperty;
  return property === null || environment[String(property)] === true;
}

/** @param {Record<string, unknown>} definition @param {boolean} environmentAllowed @param {boolean} configured @param {boolean} databaseRootConfigured */
function effectiveState(definition, environmentAllowed, configured, databaseRootConfigured) {
  if (definition.flagKey === "mbt_netsuite_writes") {
    return false;
  }
  if (!environmentAllowed || !configured) {
    return false;
  }
  if (definition.independent === true) {
    return true;
  }
  return definition.flagKey === "mbt_enabled" || databaseRootConfigured;
}

/** @param {Record<string, unknown> | undefined} flag */
function optionalUpdatedBy(flag) {
  if (flag?.updatedBy === null || flag?.updatedBy === undefined) {
    return null;
  }
  return String(flag.updatedBy);
}

/** @param {Record<string, unknown>} definition @param {Record<string, unknown> | undefined} flag @param {Record<string, unknown>} environment @param {boolean} databaseRootConfigured */
function materializedGate(definition, flag, environment, databaseRootConfigured) {
  const present = Boolean(flag);
  const configured = flag?.enabled === true;
  const environmentAllowed = environmentAllows(definition, environment);
  return {
    flagKey: definition.flagKey,
    label: definition.label,
    description: definition.description,
    independent: definition.independent === true,
    present,
    configured,
    environmentAllowed,
    effective: effectiveState(definition, environmentAllowed, configured, databaseRootConfigured),
    locked: definition.locked === true || !present,
    lockReason: definition.lockReason
      || (present ? null : "The database gate is missing; apply the required migration."),
    revision: present ? Number(flag?.revision) : null,
    updatedBy: present ? optionalUpdatedBy(flag) : null,
    updatedAt: present ? (flag?.updatedAt ?? null) : null
  };
}

/**
 * Materialize the exact Admin inventory. Missing database rows are shown but
 * fail closed, so an incomplete migration cannot silently become operational.
 *
 * @param {object} input
 * @param {readonly Record<string, unknown>[]} input.flags
 * @param {Record<string, unknown>} input.environment
 */
export function materializeMbtAdminGates({ flags, environment }) {
  const byKey = new Map(flags.map((flag) => [String(flag.flagKey), flag]));
  const root = byKey.get("mbt_enabled");
  const databaseRootConfigured = root?.enabled === true;
  return MBT_ADMIN_GATE_DEFINITIONS.map((definition) => materializedGate(
    definition,
    byKey.get(definition.flagKey),
    environment,
    databaseRootConfigured
  ));
}

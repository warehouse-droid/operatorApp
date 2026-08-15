import assert from "node:assert/strict";
import test from "node:test";

import {
  materializeMbtAdminGates,
  MBT_ADMIN_GATE_KEYS,
  MBT_ADMIN_WRITABLE_GATE_KEYS
} from "../../../src/mbt/feature-gate-catalog.js";

const environmentOpen = Object.freeze({
  enabled: true,
  masterDataEnabled: true,
  assetManagementEnabled: true,
  frontdeskOperationsEnabled: true,
  binDispatchEnabled: true,
  driverExecutionEnabled: true,
  billingOperationsEnabled: true,
  customerSyncEnabled: true,
  netSuiteWritesEnabled: true
});

function flags(enabled = []) {
  const enabledKeys = new Set(enabled);
  return MBT_ADMIN_GATE_KEYS.map((flagKey, index) => ({
    flagKey,
    enabled: enabledKeys.has(flagKey),
    revision: index + 1,
    updatedBy: null,
    updatedAt: null
  }));
}

function gate(gates, flagKey) {
  const selected = gates.find((candidate) => candidate.flagKey === flagKey);
  assert.ok(selected, `Missing gate ${flagKey}`);
  return selected;
}

test("P3-F29 Admin catalog exposes four independent operational controls, seven writable MBT gates, and two locked integration gates", () => {
  assert.deepEqual(MBT_ADMIN_GATE_KEYS, [
    "driver_offline_mode",
    "driver_yard_dependency_soft_mode",
    "operator_customer_pickup_photo_required",
    "sales_stock_request_over_availability",
    "mbt_enabled",
    "mbt_master_data",
    "mbt_asset_management",
    "mbt_frontdesk_operations",
    "mbt_bin_dispatch",
    "mbt_driver_execution",
    "mbt_billing_operations",
    "mbt_customer_sync",
    "mbt_netsuite_writes"
  ]);
  assert.deepEqual(MBT_ADMIN_WRITABLE_GATE_KEYS, MBT_ADMIN_GATE_KEYS.slice(0, 11));
});

test("P3-F29 effective state requires both deployment and database root/specific gates", () => {
  const allEnabled = flags(MBT_ADMIN_GATE_KEYS);
  const open = materializeMbtAdminGates({ flags: allEnabled, environment: environmentOpen });
  assert.equal(gate(open, "mbt_enabled").effective, true);
  assert.equal(gate(open, "mbt_master_data").effective, true);
  assert.equal(gate(open, "mbt_customer_sync").effective, true);
  assert.equal(gate(open, "mbt_netsuite_writes").effective, false);
  assert.equal(gate(open, "mbt_customer_sync").locked, true);
  assert.equal(gate(open, "mbt_netsuite_writes").locked, true);

  const databaseRootClosed = materializeMbtAdminGates({
    flags: flags(MBT_ADMIN_GATE_KEYS.filter((flagKey) => flagKey !== "mbt_enabled")),
    environment: environmentOpen
  });
  assert.equal(gate(databaseRootClosed, "mbt_master_data").configured, true);
  assert.equal(gate(databaseRootClosed, "mbt_master_data").effective, false);

  const environmentRootClosed = materializeMbtAdminGates({
    flags: allEnabled,
    environment: { ...environmentOpen, enabled: false }
  });
  assert.equal(gate(environmentRootClosed, "driver_offline_mode").effective, true);
  assert.equal(gate(environmentRootClosed, "driver_offline_mode").environmentAllowed, true);
  assert.equal(gate(environmentRootClosed, "driver_yard_dependency_soft_mode").effective, true);
  assert.equal(gate(environmentRootClosed, "driver_yard_dependency_soft_mode").environmentAllowed, true);
  assert.equal(gate(environmentRootClosed, "operator_customer_pickup_photo_required").effective, true);
  assert.equal(gate(environmentRootClosed, "operator_customer_pickup_photo_required").environmentAllowed, true);
  assert.equal(gate(environmentRootClosed, "sales_stock_request_over_availability").effective, true);
  assert.equal(gate(environmentRootClosed, "sales_stock_request_over_availability").environmentAllowed, true);
  assert.ok(environmentRootClosed
    .filter((candidate) => candidate.independent !== true)
    .every((candidate) => candidate.effective === false));
  assert.ok(environmentRootClosed
    .filter((candidate) => candidate.independent !== true)
    .every((candidate) => candidate.environmentAllowed === false));

  const capabilityClosed = materializeMbtAdminGates({
    flags: allEnabled,
    environment: { ...environmentOpen, masterDataEnabled: false }
  });
  assert.equal(gate(capabilityClosed, "mbt_enabled").effective, true);
  assert.equal(gate(capabilityClosed, "mbt_master_data").effective, false);
});

test("P3-F29 a missing database row remains visible, inactive, locked, and revisionless", () => {
  const gates = materializeMbtAdminGates({
    flags: flags(["mbt_enabled"]).filter(({ flagKey }) => flagKey !== "mbt_asset_management"),
    environment: environmentOpen
  });
  const missing = gate(gates, "mbt_asset_management");
  assert.deepEqual({
    present: missing.present,
    configured: missing.configured,
    effective: missing.effective,
    locked: missing.locked,
    revision: missing.revision
  }, {
    present: false,
    configured: false,
    effective: false,
    locked: true,
    revision: null
  });
  assert.match(missing.lockReason, /migration/i);
});

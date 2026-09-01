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
  netSuiteWritesEnabled: true,
  netSuiteDirectAccessEnabled: true,
  dispatchOrderPoolMode: "on",
  dispatchOrderPoolReady: true,
  dispatchOrderPoolActivationReady: true,
  dispatchOrderPoolActivationBlockReason: "ready",
  dispatchOrderPoolStatus: "ready",
  dispatchOrderPoolCatalogReady: true,
  dispatchOrderPoolAssignmentsReady: true,
  dispatchOrderPoolCatalogCount: 2400,
  dispatchOrderPoolLegacyCount: 2400,
  dispatchOrderPoolPendingRefreshCount: 0,
  dispatchOrderPoolShadowMatchCount: 3,
  dispatchOrderPoolShadowMismatchCount: 0,
  dispatchOrderPoolRequiredShadowMatchCount: 3,
  dispatchOrderPoolGeneration: 8,
  dispatchOrderPoolLastShadowComparisonAt: "2026-08-27T12:01:00.000Z",
  dispatchOrderPoolLastFullRefreshAt: "2026-08-27T12:00:00.000Z",
  dispatchOrderPoolLastError: ""
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

test("Admin catalog exposes four default-off completion-owned SO IF gates", () => {
  assert.deepEqual(MBT_ADMIN_GATE_KEYS, [
    "driver_offline_mode",
    "driver_yard_dependency_soft_mode",
    "operator_customer_pickup_photo_required",
    "sales_stock_request_over_availability",
    "special_stock_request_workflow",
    "dispatch_optimized_order_pool",
    "operator_netsuite_customer_pickup_if_3445",
    "operator_netsuite_receiving_ir_3445",
    "operator_netsuite_delivery_prep_if_3445",
    "operator_netsuite_customer_pickup_if_2967",
    "operator_netsuite_receiving_ir_2967",
    "operator_netsuite_delivery_prep_if_2967",
    "operator_netsuite_customer_pickup_if_12441",
    "operator_netsuite_receiving_ir_12441",
    "operator_netsuite_delivery_prep_if_12441",
    "operator_netsuite_customer_pickup_if_150",
    "operator_netsuite_receiving_ir_150",
    "operator_netsuite_delivery_prep_if_150",
    "dispatch_netsuite_sales_order_if_3445",
    "dispatch_netsuite_sales_order_if_2967",
    "dispatch_netsuite_sales_order_if_12441",
    "dispatch_netsuite_sales_order_if_150",
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
  assert.deepEqual(MBT_ADMIN_WRITABLE_GATE_KEYS, MBT_ADMIN_GATE_KEYS.slice(0, 29));
  for (const flagKey of MBT_ADMIN_GATE_KEYS.filter((key) => key.startsWith("dispatch_netsuite_sales_order_if_"))) {
    const selected = gate(materializeMbtAdminGates({ flags: flags([]), environment: environmentOpen }), flagKey);
    assert.equal(selected.gateGroup, "dispatch_sales_order_fulfillment");
    assert.equal(selected.transactionType, "IF");
    assert.equal(selected.configured, false);
    assert.equal(selected.effective, false);
  }
  const optimizedPool = gate(
    materializeMbtAdminGates({ flags: flags([]), environment: environmentOpen }),
    "dispatch_optimized_order_pool"
  );
  assert.equal(optimizedPool.configured, false);
  assert.equal(optimizedPool.environmentAllowed, true);
  assert.equal(optimizedPool.activationReady, true);
  assert.equal(optimizedPool.effective, false);
  assert.equal(optimizedPool.deploymentGuarded, true);
  assert.deepEqual(optimizedPool.dispatchOrderPool, {
    deploymentMode: "on",
    status: "ready",
    ready: true,
    activationReady: true,
    activationBlockReason: "ready",
    catalogReady: true,
    assignmentsReady: true,
    catalogCount: 2400,
    legacyCount: 2400,
    pendingRefreshCount: 0,
    shadowMatchCount: 3,
    shadowMismatchCount: 0,
    requiredShadowMatchCount: 3,
    generation: 8,
    lastShadowComparisonAt: "2026-08-27T12:01:00.000Z",
    lastFullRefreshAt: "2026-08-27T12:00:00.000Z",
    lastError: ""
  });
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
  assert.equal(gate(environmentRootClosed, "special_stock_request_workflow").effective, true);
  assert.equal(gate(environmentRootClosed, "special_stock_request_workflow").environmentAllowed, true);
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

  const directAccessClosed = materializeMbtAdminGates({
    flags: allEnabled,
    environment: { ...environmentOpen, netSuiteDirectAccessEnabled: false }
  });
  assert.equal(gate(directAccessClosed, "operator_netsuite_delivery_prep_if_12441").configured, true);
  assert.equal(gate(directAccessClosed, "operator_netsuite_delivery_prep_if_12441").environmentAllowed, false);
  assert.equal(gate(directAccessClosed, "operator_netsuite_delivery_prep_if_12441").effective, false);
  assert.equal(gate(directAccessClosed, "dispatch_netsuite_sales_order_if_12441").configured, true);
  assert.equal(gate(directAccessClosed, "dispatch_netsuite_sales_order_if_12441").environmentAllowed, false);
  assert.equal(gate(directAccessClosed, "dispatch_netsuite_sales_order_if_12441").effective, false);
  assert.equal(gate(directAccessClosed, "driver_offline_mode").effective, true);

  const dispatchReadModelClosed = materializeMbtAdminGates({
    flags: allEnabled,
    environment: {
      ...environmentOpen,
      dispatchOrderPoolAssignmentsReady: false,
      dispatchOrderPoolReady: false,
      dispatchOrderPoolActivationReady: false
    }
  });
  assert.equal(gate(dispatchReadModelClosed, "dispatch_optimized_order_pool").configured, true);
  assert.equal(gate(dispatchReadModelClosed, "dispatch_optimized_order_pool").environmentAllowed, false);
  assert.equal(gate(dispatchReadModelClosed, "dispatch_optimized_order_pool").effective, false);
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

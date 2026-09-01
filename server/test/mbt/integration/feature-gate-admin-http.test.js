import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { createOperator } from "../../../src/auth-repository.js";
import { closeDb, query } from "../../../src/db.js";
import {
  DRIVER_PWA_CURRENT_VERSION,
  DRIVER_PWA_VERSION_HEADER
} from "../../../src/driver-client-version.js";
import { getDriverYardDependencyMode } from "../../../src/driver-yard-dependency-mode.js";
import { getOperatorCustomerPickupPhotoRequirement } from "../../../src/operator-customer-pickup-photo-policy.js";
import { app } from "../../../src/server.js";
import { getSalesStockRequestAvailabilityPolicy } from "../../../src/stock-request-policy.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const LOGIN_PHRASE = "mbt-gate-admin-http";
const USERS = Object.freeze({
  admin: `mbt-gates-admin-${RUN_ID}`,
  dispatcher: `mbt-gates-dispatcher-${RUN_ID}`
});
const EXPECTED_FLAGS = Object.freeze([
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

let baseUrl;
let server;
const tokens = new Map();

async function request(path, { token, method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function login(username) {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: { username, password: LOGIN_PHRASE }
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  return result.payload.token;
}

function gate(payload, flagKey) {
  const selected = payload.gates.find((candidate) => candidate.flagKey === flagKey);
  assert.ok(selected, `Missing gate ${flagKey}`);
  return selected;
}

before(async () => {
  for (const [role, username] of Object.entries(USERS)) {
    await createOperator({
      username,
      displayName: username,
      password: LOGIN_PHRASE,
      role,
      roles: [role]
    });
  }
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const [role, username] of Object.entries(USERS)) {
    tokens.set(role, await login(username));
  }
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await closeDb();
});

test("P3-F29 Admin gate inventory is private, complete, and keeps live integrations locked", async () => {
  const anonymous = await request("/api/mbt/config/gates");
  assert.equal(anonymous.response.status, 401);

  const denied = await request("/api/mbt/config/gates", {
    token: tokens.get("dispatcher")
  });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.payload.error, "Admin account required");

  const allowed = await request("/api/mbt/config/gates", {
    token: tokens.get("admin")
  });
  assert.equal(allowed.response.status, 200, JSON.stringify(allowed.payload));
  assert.equal(allowed.response.headers.get("cache-control"), "no-store");
  assert.equal(allowed.payload.schemaVersion, "mbt-admin-gates-v1");
  assert.deepEqual(allowed.payload.gates.map(({ flagKey }) => flagKey), EXPECTED_FLAGS);
  assert.equal(gate(allowed.payload, "driver_offline_mode").environmentAllowed, true);
  assert.equal(gate(allowed.payload, "operator_customer_pickup_photo_required").environmentAllowed, true);
  assert.equal(gate(allowed.payload, "special_stock_request_workflow").environmentAllowed, true);
  assert.equal(gate(allowed.payload, "dispatch_optimized_order_pool").configured, false);
  assert.equal(gate(allowed.payload, "dispatch_optimized_order_pool").effective, false);
  assert.equal(gate(allowed.payload, "dispatch_optimized_order_pool").deploymentGuarded, true);
  assert.ok(gate(allowed.payload, "dispatch_optimized_order_pool").dispatchOrderPool);
  assert.equal(gate(allowed.payload, "operator_netsuite_delivery_prep_if_12441").configured, false);
  assert.equal(gate(allowed.payload, "operator_netsuite_delivery_prep_if_12441").environmentAllowed, false);
  assert.equal(gate(allowed.payload, "operator_netsuite_delivery_prep_if_12441").effective, false);
  assert.equal(gate(allowed.payload, "operator_netsuite_delivery_prep_if_12441").locationId, 15);
  assert.equal(gate(allowed.payload, "operator_netsuite_delivery_prep_if_12441").yardCode, "12441");
  assert.equal(gate(allowed.payload, "operator_netsuite_delivery_prep_if_12441").operatorFunction, "delivery_prep");
  assert.equal(gate(allowed.payload, "operator_netsuite_delivery_prep_if_12441").transactionType, "IF");
  assert.equal(gate(allowed.payload, "dispatch_netsuite_sales_order_if_12441").configured, false);
  assert.equal(gate(allowed.payload, "dispatch_netsuite_sales_order_if_12441").environmentAllowed, false);
  assert.equal(gate(allowed.payload, "dispatch_netsuite_sales_order_if_12441").gateGroup, "dispatch_sales_order_fulfillment");
  assert.equal(gate(allowed.payload, "dispatch_netsuite_sales_order_if_12441").transactionType, "IF");
  assert.equal(gate(allowed.payload, "mbt_enabled").environmentAllowed, true);
  assert.equal(gate(allowed.payload, "mbt_master_data").environmentAllowed, false);
  assert.equal(gate(allowed.payload, "mbt_customer_sync").locked, true);
  assert.equal(gate(allowed.payload, "mbt_netsuite_writes").locked, true);
  assert.equal(gate(allowed.payload, "mbt_master_data").locked, false);
  assert.doesNotMatch(JSON.stringify(allowed.payload), /password|client.?secret|access.?token/i);
});

test("P3-F29 Admin gate commands are audited, revision-guarded, idempotent, and reversible", async () => {
  const initial = await request("/api/mbt/config/gates", { token: tokens.get("admin") });
  assert.equal(initial.response.status, 200, JSON.stringify(initial.payload));
  const original = gate(initial.payload, "mbt_master_data");
  assert.equal(original.configured, false);
  const commandKey = `mbt-gate-on-${RUN_ID}`;
  const command = {
    enabled: true,
    expectedRevision: original.revision,
    reason: "Open local master data for the isolated Admin gate test"
  };
  const headers = { "idempotency-key": commandKey };

  const first = await request("/api/mbt/config/gates/mbt_master_data", {
    token: tokens.get("admin"),
    method: "PUT",
    headers,
    body: command
  });
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(first.response.headers.get("x-mbt-idempotent-replay"), "false");
  assert.equal(first.payload.flag.enabled, true);
  assert.equal(first.payload.flag.revision, original.revision + 1);

  const configuredInventory = await request("/api/mbt/config/gates", {
    token: tokens.get("admin")
  });
  const configuredGate = gate(configuredInventory.payload, "mbt_master_data");
  assert.equal(configuredGate.configured, true);
  assert.equal(configuredGate.effective, false, "The disabled environment ceiling must still win.");

  const replay = await request("/api/mbt/config/gates/mbt_master_data", {
    token: tokens.get("admin"),
    method: "PUT",
    headers,
    body: command
  });
  assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
  assert.equal(replay.response.headers.get("x-mbt-idempotent-replay"), "true");
  assert.deepEqual(replay.payload, first.payload);

  const reused = await request("/api/mbt/config/gates/mbt_master_data", {
    token: tokens.get("admin"),
    method: "PUT",
    headers,
    body: { ...command, enabled: false }
  });
  assert.equal(reused.response.status, 409);
  assert.equal(reused.payload.code, "MBT_IDEMPOTENCY_CONFLICT");

  const stale = await request("/api/mbt/config/gates/mbt_master_data", {
    token: tokens.get("admin"),
    method: "PUT",
    headers: { "idempotency-key": `mbt-gate-stale-${RUN_ID}` },
    body: { ...command, reason: "Exercise stale browser protection" }
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.payload.code, "MBT_STALE_REVISION");

  const disabled = await request("/api/mbt/config/gates/mbt_master_data", {
    token: tokens.get("admin"),
    method: "PUT",
    headers: { "idempotency-key": `mbt-gate-off-${RUN_ID}` },
    body: {
      enabled: false,
      expectedRevision: first.payload.flag.revision,
      reason: "Restore the local master data gate after the isolated test"
    }
  });
  assert.equal(disabled.response.status, 200, JSON.stringify(disabled.payload));
  assert.equal(disabled.payload.flag.enabled, false);
  assert.equal(disabled.payload.flag.revision, first.payload.flag.revision + 1);

  const evidence = await query(
    `SELECT
       (SELECT count(*)::int
          FROM mbt_audit_events
         WHERE action = 'mbt.feature_flag.state_updated'
           AND entity_id = 'mbt_master_data'
           AND idempotency_key = ANY($1::text[])) AS audits,
       (SELECT count(*)::int
          FROM mbt_command_receipts
         WHERE command_name = 'mbt.feature_flag.state_updated'
           AND entity_id = 'mbt_master_data'
           AND idempotency_key = ANY($1::text[])) AS receipts`,
    [[commandKey, `mbt-gate-off-${RUN_ID}`]]
  );
  assert.deepEqual(evidence.rows[0], { audits: 2, receipts: 2 });
});

test("Dispatch optimized pool gate rejects activation until its rollout ceiling is ready", async () => {
  const initial = await request("/api/mbt/config/gates", { token: tokens.get("admin") });
  assert.equal(initial.response.status, 200, JSON.stringify(initial.payload));
  const original = gate(initial.payload, "dispatch_optimized_order_pool");
  assert.equal(original.configured, false);
  assert.equal(original.environmentAllowed, false);
  assert.equal(original.effective, false);

  const blocked = await request("/api/mbt/config/gates/dispatch_optimized_order_pool", {
    token: tokens.get("admin"),
    method: "PUT",
    headers: { "idempotency-key": `dispatch-order-pool-gate-on-${RUN_ID}` },
    body: {
      enabled: true,
      expectedRevision: original.revision,
      reason: "Verify the optimized pool Admin cutover remains behind its deployment and readiness ceiling"
    }
  });
  assert.equal(blocked.response.status, 409, JSON.stringify(blocked.payload));
  assert.equal(blocked.payload.code, "DISPATCH_ORDER_POOL_NOT_READY");

  const unchanged = await request("/api/mbt/config/gates", { token: tokens.get("admin") });
  const unchangedGate = gate(unchanged.payload, "dispatch_optimized_order_pool");
  assert.equal(unchangedGate.configured, false);
  assert.equal(unchangedGate.effective, false);
});

test("Admin independently controls the Driver PWA offline mode advertised to devices", async () => {
  const currentClientHeaders = {
    [DRIVER_PWA_VERSION_HEADER]: DRIVER_PWA_CURRENT_VERSION
  };
  const initial = await request("/api/mbt/config/gates", { token: tokens.get("admin") });
  assert.equal(initial.response.status, 200, JSON.stringify(initial.payload));
  const original = gate(initial.payload, "driver_offline_mode");
  assert.equal(original.configured, false);
  assert.equal(original.effective, false);

  const advertisedInitial = await request("/api/driver/client-version", {
    headers: currentClientHeaders
  });
  assert.equal(advertisedInitial.response.status, 200, JSON.stringify(advertisedInitial.payload));
  assert.equal(advertisedInitial.payload.currentVersion, DRIVER_PWA_CURRENT_VERSION);
  assert.equal(advertisedInitial.payload.minimumVersion, DRIVER_PWA_CURRENT_VERSION);
  assert.equal(advertisedInitial.payload.isCurrent, true);
  assert.equal(advertisedInitial.payload.updateRequired, false);
  assert.equal(advertisedInitial.payload.reopenRequired, false);
  assert.equal(advertisedInitial.payload.offlineEnabled, false);
  assert.equal(advertisedInitial.payload.offlineModeRevision, original.revision);

  const enabled = await request("/api/mbt/config/gates/driver_offline_mode", {
    token: tokens.get("admin"),
    method: "PUT",
    headers: { "idempotency-key": `driver-offline-on-${RUN_ID}` },
    body: {
      enabled: true,
      expectedRevision: original.revision,
      reason: "Exercise the isolated Driver offline-mode control"
    }
  });
  assert.equal(enabled.response.status, 200, JSON.stringify(enabled.payload));
  assert.equal(enabled.payload.flag.enabled, true);

  const advertisedEnabled = await request("/api/driver/client-version", {
    headers: currentClientHeaders
  });
  assert.equal(advertisedEnabled.response.status, 200, JSON.stringify(advertisedEnabled.payload));
  assert.equal(advertisedEnabled.payload.currentVersion, DRIVER_PWA_CURRENT_VERSION);
  assert.equal(advertisedEnabled.payload.minimumVersion, DRIVER_PWA_CURRENT_VERSION);
  assert.equal(advertisedEnabled.payload.isCurrent, true);
  assert.equal(advertisedEnabled.payload.updateRequired, false);
  assert.equal(advertisedEnabled.payload.reopenRequired, false);
  assert.equal(advertisedEnabled.payload.offlineEnabled, true);
  assert.equal(advertisedEnabled.payload.offlineModeRevision, enabled.payload.flag.revision);

  const disabled = await request("/api/mbt/config/gates/driver_offline_mode", {
    token: tokens.get("admin"),
    method: "PUT",
    headers: { "idempotency-key": `driver-offline-off-${RUN_ID}` },
    body: {
      enabled: false,
      expectedRevision: enabled.payload.flag.revision,
      reason: "Restore online-only Driver mode after the isolated test"
    }
  });
  assert.equal(disabled.response.status, 200, JSON.stringify(disabled.payload));
  assert.equal(disabled.payload.flag.enabled, false);

  const advertisedDisabled = await request("/api/driver/client-version", {
    headers: currentClientHeaders
  });
  assert.equal(advertisedDisabled.response.status, 200, JSON.stringify(advertisedDisabled.payload));
  assert.equal(advertisedDisabled.payload.currentVersion, DRIVER_PWA_CURRENT_VERSION);
  assert.equal(advertisedDisabled.payload.minimumVersion, DRIVER_PWA_CURRENT_VERSION);
  assert.equal(advertisedDisabled.payload.isCurrent, true);
  assert.equal(advertisedDisabled.payload.updateRequired, false);
  assert.equal(advertisedDisabled.payload.reopenRequired, false);
  assert.equal(advertisedDisabled.payload.offlineEnabled, false);
  assert.equal(advertisedDisabled.payload.offlineModeRevision, disabled.payload.flag.revision);
});

test("Admin persists and audits the Driver yard-dependency Soft mode independently", async () => {
  const initial = await request("/api/mbt/config/gates", { token: tokens.get("admin") });
  assert.equal(initial.response.status, 200, JSON.stringify(initial.payload));
  const original = gate(initial.payload, "driver_yard_dependency_soft_mode");
  assert.equal(original.configured, false);
  assert.deepEqual(await getDriverYardDependencyMode(), {
    mode: "hard",
    soft: false,
    revision: original.revision,
    updatedAt: original.updatedAt
  });

  const onKey = `driver-yard-soft-on-${RUN_ID}`;
  const enabled = await request("/api/mbt/config/gates/driver_yard_dependency_soft_mode", {
    token: tokens.get("admin"),
    method: "PUT",
    headers: { "idempotency-key": onKey },
    body: {
      enabled: true,
      expectedRevision: original.revision,
      reason: "Exercise Driver ordinary yard dependency Soft testing mode"
    }
  });
  assert.equal(enabled.response.status, 200, JSON.stringify(enabled.payload));
  assert.equal(enabled.payload.flag.enabled, true);
  const enabledMode = await getDriverYardDependencyMode();
  assert.deepEqual({
    mode: enabledMode.mode,
    soft: enabledMode.soft,
    revision: enabledMode.revision
  }, {
    mode: "soft",
    soft: true,
    revision: enabled.payload.flag.revision
  });
  assert.match(enabledMode.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);

  const offKey = `driver-yard-soft-off-${RUN_ID}`;
  const disabled = await request("/api/mbt/config/gates/driver_yard_dependency_soft_mode", {
    token: tokens.get("admin"),
    method: "PUT",
    headers: { "idempotency-key": offKey },
    body: {
      enabled: false,
      expectedRevision: enabled.payload.flag.revision,
      reason: "Restore Driver yard dependency Hard mode after the isolated test"
    }
  });
  assert.equal(disabled.response.status, 200, JSON.stringify(disabled.payload));
  assert.equal((await getDriverYardDependencyMode()).mode, "hard");

  const evidence = await query(
    `SELECT
       (SELECT count(*)::int
          FROM mbt_audit_events
         WHERE action = 'mbt.feature_flag.state_updated'
           AND entity_id = 'driver_yard_dependency_soft_mode'
           AND idempotency_key = ANY($1::text[])) AS audits,
       (SELECT count(*)::int
          FROM mbt_command_receipts
         WHERE command_name = 'mbt.feature_flag.state_updated'
           AND entity_id = 'driver_yard_dependency_soft_mode'
           AND idempotency_key = ANY($1::text[])) AS receipts`,
    [[onKey, offKey]]
  );
  assert.deepEqual(evidence.rows[0], { audits: 2, receipts: 2 });
});

test("S6: Admin independently controls the live Operator Customer Pickup photo requirement", async () => {
  const initial = await request("/api/mbt/config/gates", { token: tokens.get("admin") });
  assert.equal(initial.response.status, 200, JSON.stringify(initial.payload));
  const original = gate(initial.payload, "operator_customer_pickup_photo_required");
  assert.equal(original.configured, true);
  assert.equal(original.effective, true);
  assert.equal((await getOperatorCustomerPickupPhotoRequirement()).requiredPhotoCount, 1);

  const advertisedInitial = await request("/api/customer-pickup/config", {
    token: tokens.get("admin")
  });
  assert.equal(advertisedInitial.response.status, 200, JSON.stringify(advertisedInitial.payload));
  assert.equal(advertisedInitial.response.headers.get("cache-control"), "no-store");
  assert.equal(advertisedInitial.payload.required, true);
  assert.equal(advertisedInitial.payload.requiredPhotoCount, 1);
  assert.equal(advertisedInitial.payload.revision, original.revision);

  const offKey = `operator-customer-pickup-photo-off-${RUN_ID}`;
  const disabled = await request(
    "/api/mbt/config/gates/operator_customer_pickup_photo_required",
    {
      token: tokens.get("admin"),
      method: "PUT",
      headers: { "idempotency-key": offKey },
      body: {
        enabled: false,
        expectedRevision: original.revision,
        reason: "Exercise photo-optional Customer Pickup completion"
      }
    }
  );
  assert.equal(disabled.response.status, 200, JSON.stringify(disabled.payload));
  assert.equal(disabled.payload.flag.enabled, false);
  const advertisedDisabled = await request("/api/customer-pickup/config", {
    token: tokens.get("admin")
  });
  assert.equal(advertisedDisabled.response.status, 200, JSON.stringify(advertisedDisabled.payload));
  assert.equal(advertisedDisabled.payload.required, false);
  assert.equal(advertisedDisabled.payload.requiredPhotoCount, 0);
  assert.equal(advertisedDisabled.payload.revision, disabled.payload.flag.revision);

  const onKey = `operator-customer-pickup-photo-on-${RUN_ID}`;
  const restored = await request(
    "/api/mbt/config/gates/operator_customer_pickup_photo_required",
    {
      token: tokens.get("admin"),
      method: "PUT",
      headers: { "idempotency-key": onKey },
      body: {
        enabled: true,
        expectedRevision: disabled.payload.flag.revision,
        reason: "Restore required Customer Pickup photo evidence after the isolated test"
      }
    }
  );
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.equal(restored.payload.flag.enabled, true);
  assert.equal((await getOperatorCustomerPickupPhotoRequirement()).requiredPhotoCount, 1);

  const evidence = await query(
    `SELECT
       (SELECT count(*)::int
          FROM mbt_audit_events
         WHERE action = 'mbt.feature_flag.state_updated'
           AND entity_id = 'operator_customer_pickup_photo_required'
           AND idempotency_key = ANY($1::text[])) AS audits,
       (SELECT count(*)::int
          FROM mbt_command_receipts
         WHERE command_name = 'mbt.feature_flag.state_updated'
           AND entity_id = 'operator_customer_pickup_photo_required'
           AND idempotency_key = ANY($1::text[])) AS receipts`,
    [[offKey, onKey]]
  );
  assert.deepEqual(evidence.rows[0], { audits: 2, receipts: 2 });
});

test("Admin independently controls Sales stock requests above yard availability", async () => {
  const initial = await request("/api/mbt/config/gates", { token: tokens.get("admin") });
  assert.equal(initial.response.status, 200, JSON.stringify(initial.payload));
  const original = gate(initial.payload, "sales_stock_request_over_availability");
  assert.equal(original.configured, false);
  assert.equal((await getSalesStockRequestAvailabilityPolicy()).allowOverAvailability, false);

  const enabled = await request("/api/mbt/config/gates/sales_stock_request_over_availability", {
    token: tokens.get("admin"),
    method: "PUT",
    headers: { "idempotency-key": `sales-stock-over-availability-on-${RUN_ID}` },
    body: {
      enabled: true,
      expectedRevision: original.revision,
      reason: "Exercise Sales demand requests above current yard availability"
    }
  });
  assert.equal(enabled.response.status, 200, JSON.stringify(enabled.payload));
  assert.equal(enabled.payload.flag.enabled, true);
  const enabledPolicy = await getSalesStockRequestAvailabilityPolicy();
  assert.equal(enabledPolicy.allowOverAvailability, true);
  assert.equal(enabledPolicy.revision, enabled.payload.flag.revision);
  assert.match(enabledPolicy.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);

  const disabled = await request("/api/mbt/config/gates/sales_stock_request_over_availability", {
    token: tokens.get("admin"),
    method: "PUT",
    headers: { "idempotency-key": `sales-stock-over-availability-off-${RUN_ID}` },
    body: {
      enabled: false,
      expectedRevision: enabled.payload.flag.revision,
      reason: "Restore bounded Sales stock requests after the isolated test"
    }
  });
  assert.equal(disabled.response.status, 200, JSON.stringify(disabled.payload));
  assert.equal((await getSalesStockRequestAvailabilityPolicy()).allowOverAvailability, false);
});

test("P3-F29 live customer sync and NetSuite posting cannot be enabled through Admin", async () => {
  const inventory = await request("/api/mbt/config/gates", { token: tokens.get("admin") });
  for (const flagKey of ["mbt_customer_sync", "mbt_netsuite_writes"]) {
    const selected = gate(inventory.payload, flagKey);
    const idempotencyKey = `mbt-locked-${flagKey}-${RUN_ID}`;
    const result = await request(`/api/mbt/config/gates/${flagKey}`, {
      token: tokens.get("admin"),
      method: "PUT",
      headers: { "idempotency-key": idempotencyKey },
      body: {
        enabled: true,
        expectedRevision: selected.revision,
        reason: "This locked command must be rejected"
      }
    });
    assert.equal(result.response.status, 409);
    assert.equal(result.payload.code, "MBT_FEATURE_FLAG_LOCKED");
    const evidence = await query(
      `SELECT
         (SELECT count(*)::int FROM mbt_audit_events WHERE idempotency_key = $1) AS audits,
         (SELECT count(*)::int FROM mbt_command_receipts WHERE idempotency_key = $1) AS receipts`,
      [idempotencyKey]
    );
    assert.deepEqual(evidence.rows[0], { audits: 0, receipts: 0 });
  }
});

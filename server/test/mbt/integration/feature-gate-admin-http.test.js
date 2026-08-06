import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { createOperator } from "../../../src/auth-repository.js";
import { closeDb, query } from "../../../src/db.js";
import { app } from "../../../src/server.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const LOGIN_PHRASE = "mbt-gate-admin-http";
const USERS = Object.freeze({
  admin: `mbt-gates-admin-${RUN_ID}`,
  dispatcher: `mbt-gates-dispatcher-${RUN_ID}`
});
const EXPECTED_FLAGS = Object.freeze([
  "driver_offline_mode",
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

test("Admin independently controls the Driver PWA offline mode advertised to devices", async () => {
  const initial = await request("/api/mbt/config/gates", { token: tokens.get("admin") });
  assert.equal(initial.response.status, 200, JSON.stringify(initial.payload));
  const original = gate(initial.payload, "driver_offline_mode");
  assert.equal(original.configured, false);
  assert.equal(original.effective, false);

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

  const advertisedEnabled = await request("/api/driver/client-version");
  assert.equal(advertisedEnabled.response.status, 200, JSON.stringify(advertisedEnabled.payload));
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

  const advertisedDisabled = await request("/api/driver/client-version");
  assert.equal(advertisedDisabled.response.status, 200, JSON.stringify(advertisedDisabled.payload));
  assert.equal(advertisedDisabled.payload.offlineEnabled, false);
  assert.equal(advertisedDisabled.payload.offlineModeRevision, disabled.payload.flag.revision);
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

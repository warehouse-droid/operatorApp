import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { createOperator } from "../../../src/auth-repository.js";
import { config } from "../../../src/config.js";
import { closeDb, query } from "../../../src/db.js";
import { app } from "../../../src/server.js";

const HTTP_RUN_ID = crypto.randomUUID().replaceAll("-", "");
const HTTP_FLAG_KEY = `p1_http_command_${HTTP_RUN_ID}`;

const USERS = Object.freeze({
  admin: { username: "mbt-p1-http-admin", role: "admin" },
  dispatcher: { username: "mbt-p1-http-dispatch", role: "dispatcher" }
});
const PASSWORD = "phase-one-http";
const tokens = new Map();
let baseUrl;
let server;

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
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  return { response, payload };
}

async function login(username) {
  const { response, payload } = await request("/api/auth/login", {
    method: "POST",
    body: { username, password: PASSWORD }
  });
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload.token;
}

async function rowCounts() {
  const result = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_command_receipts) AS receipts,
       (SELECT count(*)::int FROM mbt_audit_events) AS audit_events,
       (SELECT count(*)::int FROM mbt_bin_asset_reservations) AS reservations,
       (SELECT count(*)::int FROM mbt_netsuite_outbox) AS outbox`
  );
  return result.rows[0];
}

before(async () => {
  const usernames = Object.values(USERS).map(({ username }) => username);
  await query("DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operators WHERE username = ANY($1::text[]))", [usernames]);
  await query("DELETE FROM operators WHERE username = ANY($1::text[])", [usernames]);
  for (const user of Object.values(USERS)) {
    await createOperator({
      username: user.username,
      displayName: user.username,
      password: PASSWORD,
      role: user.role,
      roles: [user.role]
    });
  }
  await query(
    `INSERT INTO mbt_feature_flags (
       flag_key, enabled, description, revision, updated_by
     ) VALUES ($1, false, 'HTTP initial', 1, NULL)
     ON CONFLICT (flag_key) DO UPDATE
       SET enabled = false,
           description = EXCLUDED.description,
           revision = 1,
           updated_by = NULL,
           updated_at = now()`,
    [HTTP_FLAG_KEY]
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  for (const user of Object.values(USERS)) {
    tokens.set(user.role, await login(user.username));
  }
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  const usernames = Object.values(USERS).map(({ username }) => username);
  await query("DELETE FROM mbt_command_receipts WHERE entity_type = 'mbt_feature_flag' AND entity_id = $1", [HTTP_FLAG_KEY]).catch(() => null);
  await query("DELETE FROM mbt_audit_events WHERE entity_type = 'mbt_feature_flag' AND entity_id = $1", [HTTP_FLAG_KEY]).catch(() => null);
  await query("DELETE FROM mbt_feature_flags WHERE flag_key = $1", [HTTP_FLAG_KEY]).catch(() => null);
  await query("DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operators WHERE username = ANY($1::text[]))", [usernames]).catch(() => null);
  await query("DELETE FROM operators WHERE username = ANY($1::text[])", [usernames]).catch(() => null);
  await closeDb();
});

test("F01/F16: MBT status is authenticated, fail-closed, and reports the Phase 1 safety boundary", async () => {
  const anonymous = await request("/api/mbt/status");
  assert.equal(anonymous.response.status, 401);
  assert.deepEqual(anonymous.payload, { error: "Login required" });

  const admin = await request("/api/mbt/status", { token: tokens.get("admin") });
  assert.equal(admin.response.status, 200, JSON.stringify(admin.payload));
  assert.equal(admin.payload.schemaVersion, "mbt-v1");
  assert.equal(admin.payload.phase, 1);
  assert.equal(admin.payload.foundationEnabled, true);
  assert.equal(admin.payload.operational, false);
  for (const name of ["frontdesk", "binDispatch", "driverBin", "billing", "netSuiteWrites"]) {
    assert.deepEqual(admin.payload.capabilities[name], {
      enabled: false,
      code: "MBT_CAPABILITY_DISABLED",
      reason: "capability_disabled"
    });
  }
});

test("F01: the database cannot enable NetSuite writes while the environment write gate is false", async () => {
  await query(
    `UPDATE mbt_feature_flags
        SET enabled = true,
            revision = revision + 1
      WHERE flag_key = ANY($1::text[])`,
    [["mbt_enabled", "mbt_netsuite_writes"]]
  );
  try {
    const result = await request("/api/mbt/status", { token: tokens.get("admin") });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.deepEqual(result.payload.capabilities.netSuiteWrites, {
      enabled: false,
      code: "MBT_CAPABILITY_DISABLED",
      reason: "netsuite_writes_disabled"
    });
  } finally {
    await query(
      `UPDATE mbt_feature_flags
          SET enabled = false,
              revision = revision + 1
        WHERE flag_key = ANY($1::text[])`,
      [["mbt_enabled", "mbt_netsuite_writes"]]
    );
  }
});

test("F01: a disabled live MBT root gate wins over a true write gate and false database flags", async () => {
  await query(
    `UPDATE mbt_feature_flags
        SET enabled = false,
            revision = revision + 1
      WHERE flag_key = ANY($1::text[])`,
    [["mbt_enabled", "mbt_netsuite_writes"]]
  );
  const previousMbtConfig = { ...config.mbt };
  try {
    config.mbt = {
      enabled: false,
      netSuiteWritesEnabled: true
    };
    const result = await request("/api/mbt/status", { token: tokens.get("admin") });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(result.payload.foundationEnabled, false);
    assert.equal(result.payload.operational, false);
    for (const capability of Object.values(result.payload.capabilities)) {
      assert.deepEqual(capability, {
        enabled: false,
        code: "MBT_CAPABILITY_DISABLED",
        reason: "mbt_disabled"
      });
    }
  } finally {
    config.mbt = previousMbtConfig;
  }
});

test("F02: MBT configuration reads require live Admin authority", async () => {
  const denied = await request("/api/mbt/config", { token: tokens.get("dispatcher") });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.payload.error, "Admin account required");
  assert.equal(JSON.stringify(denied.payload).includes("mbt_feature_flags"), false);

  const allowed = await request("/api/mbt/config", { token: tokens.get("admin") });
  assert.equal(allowed.response.status, 200, JSON.stringify(allowed.payload));
  assert.equal(allowed.payload.schemaVersion, "mbt-v1");
  assert.deepEqual(
    allowed.payload.flags.map(({ flagKey, enabled }) => [flagKey, enabled]),
    [
      ["mbt_billing_operations", false],
      ["mbt_bin_dispatch", false],
      ["mbt_driver_execution", false],
      ["mbt_enabled", false],
      ["mbt_frontdesk_operations", false],
      ["mbt_netsuite_writes", false]
    ]
  );
  assert.doesNotMatch(JSON.stringify(allowed.payload), /password|client.?secret|access.?token/i);
});

test("F03/F04/F05: the Admin description command enforces revision and HTTP idempotency atomically", async () => {
  const path = `/api/mbt/config/flags/${HTTP_FLAG_KEY}/description`;
  const headers = {
    "idempotency-key": `p1-http-description-once-${HTTP_RUN_ID}`,
    "x-correlation-id": `corr-p1-http-description-${HTTP_RUN_ID}`,
    "x-request-id": `req-p1-http-description-${HTTP_RUN_ID}`
  };
  const body = {
    description: "HTTP updated once",
    expectedRevision: 1,
    reason: "Verify the Phase 1 HTTP command boundary"
  };

  const denied = await request(path, {
    token: tokens.get("dispatcher"),
    method: "PATCH",
    headers,
    body
  });
  assert.equal(denied.response.status, 403);

  const first = await request(path, {
    token: tokens.get("admin"),
    method: "PATCH",
    headers,
    body
  });
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(first.response.headers.get("x-mbt-idempotent-replay"), "false");
  assert.equal(first.payload.flag.revision, 2);

  const replay = await request(path, {
    token: tokens.get("admin"),
    method: "PATCH",
    headers,
    body
  });
  assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
  assert.equal(replay.response.headers.get("x-mbt-idempotent-replay"), "true");
  assert.deepEqual(replay.payload, first.payload);

  const conflict = await request(path, {
    token: tokens.get("admin"),
    method: "PATCH",
    headers,
    body: { ...body, description: "A different command" }
  });
  assert.equal(conflict.response.status, 409, JSON.stringify(conflict.payload));
  assert.equal(conflict.payload.code, "MBT_IDEMPOTENCY_CONFLICT");

  const stale = await request(path, {
    token: tokens.get("admin"),
    method: "PATCH",
    headers: {
      ...headers,
      "idempotency-key": `p1-http-description-stale-${HTTP_RUN_ID}`
    },
    body: { ...body, description: "Stale overwrite" }
  });
  assert.equal(stale.response.status, 409, JSON.stringify(stale.payload));
  assert.equal(stale.payload.code, "MBT_STALE_REVISION");

  const evidence = await query(
    `SELECT
       (SELECT count(*)::int
          FROM mbt_command_receipts
         WHERE entity_type = 'mbt_feature_flag'
           AND entity_id = $1) AS receipts,
       (SELECT count(*)::int
          FROM mbt_audit_events
         WHERE entity_type = 'mbt_feature_flag'
           AND entity_id = $1) AS audit_events`,
    [HTTP_FLAG_KEY]
  );
  assert.deepEqual(evidence.rows[0], { receipts: 1, audit_events: 1 });
});

test("F01/F14/F15: disabled BIN reservation rejects before any durable side effect", async () => {
  const beforeCounts = await rowCounts();
  const result = await request(
    "/api/mbt/bin-assets/00000000-0000-4000-8000-000000000001/reservations",
    {
      token: tokens.get("admin"),
      method: "POST",
      headers: {
        "idempotency-key": "p1-disabled-reservation",
        "x-correlation-id": "corr-p1-disabled"
      },
      body: {
        visitId: "00000000-0000-4000-8000-000000000002",
        reservationSlot: 1
      }
    }
  );
  assert.equal(result.response.status, 409, JSON.stringify(result.payload));
  assert.deepEqual(result.payload, {
    error: "This MBT capability is disabled.",
    code: "MBT_CAPABILITY_DISABLED",
    details: { capability: "bin_dispatch" },
    correlationId: "corr-p1-disabled"
  });
  assert.deepEqual(await rowCounts(), beforeCounts);
});

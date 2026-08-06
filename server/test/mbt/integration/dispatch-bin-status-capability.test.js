import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { createOperator } from "../../../src/auth-repository.js";
import { config } from "../../../src/config.js";
import { closeDb, query } from "../../../src/db.js";
import { app } from "../../../src/server.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const PASSWORD = "dispatch-bin-status-gate"; // secret-scan: allow synthetic isolated credential
const USERS = Object.freeze([
  { key: "admin", username: `mbt-status-admin-${RUN_ID}`, role: "admin" },
  { key: "dispatcher", username: `mbt-status-dispatcher-${RUN_ID}`, role: "dispatcher" },
  { key: "operator", username: `mbt-status-operator-${RUN_ID}`, role: "operator" }
]);
const FEATURE_FLAGS = Object.freeze([
  "mbt_enabled",
  "mbt_frontdesk_operations",
  "mbt_bin_dispatch",
  "mbt_driver_execution",
  "mbt_billing_operations",
  "mbt_netsuite_writes"
]);
const LEGACY_CAPABILITIES = Object.freeze([
  "billing",
  "binDispatch",
  "driverBin",
  "frontdesk",
  "netSuiteWrites"
]);

const tokens = new Map();
const originalEnvironment = {
  rootEnabled: config.mbt.enabled,
  netSuiteWritesEnabled: config.mbt.netSuiteWritesEnabled,
  phase3: { ...config.mbtPhase3 }
};
let baseUrl = "";
let server;

async function requestStatus(key) {
  const response = await fetch(`${baseUrl}/api/mbt/status`, {
    headers: { authorization: `Bearer ${tokens.get(key)}` }
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(response.headers.get("cache-control"), "no-store");
  return payload;
}

async function login(user) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user.username, password: PASSWORD })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload.token;
}

async function setDatabaseGates({ root, binDispatch }) {
  await query(
    `UPDATE mbt_feature_flags
        SET enabled = CASE
          WHEN flag_key = 'mbt_enabled' THEN $1
          WHEN flag_key = 'mbt_bin_dispatch' THEN $2
          ELSE false
        END,
            revision = revision + 1
      WHERE flag_key = ANY($3::text[])`,
    [root, binDispatch, FEATURE_FLAGS]
  );
}

function setEnvironmentGates({ root, binDispatch }) {
  config.mbt.enabled = root;
  config.mbt.netSuiteWritesEnabled = false;
  Object.assign(config.mbtPhase3, {
    customerSyncEnabled: false,
    masterDataEnabled: false,
    assetManagementEnabled: false,
    frontdeskOperationsEnabled: false,
    binDispatchEnabled: binDispatch,
    driverExecutionEnabled: false,
    billingOperationsEnabled: false
  });
}

before(async () => {
  const usernames = USERS.map(({ username }) => username);
  await query(
    "DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operators WHERE username = ANY($1::text[]))",
    [usernames]
  );
  await query("DELETE FROM operators WHERE username = ANY($1::text[])", [usernames]);
  for (const user of USERS) {
    await createOperator({
      username: user.username,
      displayName: user.username,
      password: PASSWORD,
      role: user.role,
      roles: [user.role]
    });
  }
  await setDatabaseGates({ root: false, binDispatch: false });
  setEnvironmentGates({ root: true, binDispatch: false });

  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  for (const user of USERS) {
    tokens.set(user.key, await login(user));
  }
});

after(async () => {
  config.mbt.enabled = originalEnvironment.rootEnabled;
  config.mbt.netSuiteWritesEnabled = originalEnvironment.netSuiteWritesEnabled;
  Object.assign(config.mbtPhase3, originalEnvironment.phase3);
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  const usernames = USERS.map(({ username }) => username);
  await query(
    "DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operators WHERE username = ANY($1::text[]))",
    [usernames]
  ).catch(() => null);
  await query("DELETE FROM operators WHERE username = ANY($1::text[])", [usernames]).catch(() => null);
  await setDatabaseGates({ root: false, binDispatch: false }).catch(() => null);
  await closeDb();
});

test("P3 Dispatch BIN discovery composes environment, database, and caller pilot gates without changing the legacy status contract", async (t) => {
  await t.test("legacy closed defaults retain the authenticated mbt-v1 response", async () => {
    await setDatabaseGates({ root: false, binDispatch: false });
    setEnvironmentGates({ root: true, binDispatch: false });

    const status = await requestStatus("admin");
    assert.equal(status.schemaVersion, "mbt-v1");
    assert.equal(status.phase, 1);
    assert.equal(status.foundationEnabled, true);
    assert.equal(status.operational, false);
    assert.deepEqual(Object.keys(status.capabilities).sort(), LEGACY_CAPABILITIES);
    for (const capability of LEGACY_CAPABILITIES) {
      assert.deepEqual(status.capabilities[capability], {
        enabled: false,
        code: "MBT_CAPABILITY_DISABLED",
        reason: "capability_disabled"
      });
    }
  });

  await t.test("a true database root and BIN flag cannot bypass a false BIN environment gate", async () => {
    await setDatabaseGates({ root: true, binDispatch: true });
    setEnvironmentGates({ root: true, binDispatch: false });

    const status = await requestStatus("dispatcher");
    assert.deepEqual(status.capabilities.binDispatch, {
      enabled: false,
      code: "MBT_CAPABILITY_DISABLED",
      reason: "environment_capability_disabled"
    });
    assert.equal(status.operational, false);
  });

  await t.test("environment and database gates enable discovery for both Dispatcher and Admin", async () => {
    await setDatabaseGates({ root: true, binDispatch: true });
    setEnvironmentGates({ root: true, binDispatch: true });

    for (const role of ["dispatcher", "admin"]) {
      const status = await requestStatus(role);
      assert.deepEqual(status.capabilities.binDispatch, {
        enabled: true,
        code: null,
        reason: null
      });
      assert.equal(status.operational, true);
    }
  });

  await t.test("an authenticated non-Dispatch role remains outside the BIN pilot", async () => {
    await setDatabaseGates({ root: true, binDispatch: true });
    setEnvironmentGates({ root: true, binDispatch: true });

    const status = await requestStatus("operator");
    assert.deepEqual(status.capabilities.binDispatch, {
      enabled: false,
      code: "MBT_CAPABILITY_DISABLED",
      reason: "pilot_scope_denied"
    });
    assert.equal(status.operational, false);
  });
});

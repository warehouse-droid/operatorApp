import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createOperator } from "../../../src/auth-repository.js";
import { closeDb, query } from "../../../src/db.js";
import { app } from "../../../src/server.js";

const PASSWORD = "phase-one-roles";
const USERS = Object.freeze([
  { key: "admin", username: "mbt-role-admin", role: "admin", roles: ["admin"] },
  { key: "mbt_frontdesk", username: "mbt-role-frontdesk", role: "mbt_frontdesk", roles: ["mbt_frontdesk"] },
  { key: "mbt_billing", username: "mbt-role-billing", role: "mbt_billing", roles: ["mbt_billing"] },
  { key: "dispatcher", username: "mbt-role-dispatcher", role: "dispatcher", roles: ["dispatcher"] },
  {
    key: "secondary_frontdesk",
    username: "mbt-role-secondary-frontdesk",
    role: "operator",
    roles: ["operator", "mbt_frontdesk"],
    homeRoute: "/mbt/frontdesk"
  },
  {
    key: "secondary_billing",
    username: "mbt-role-secondary-billing",
    role: "operator",
    roles: ["operator", "mbt_billing"],
    homeRoute: "/mbt/billing"
  }
]);
const tokens = new Map();
let baseUrl;
let server;

async function request(path, { role, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      ...(role ? { authorization: `Bearer ${tokens.get(role)}` } : {}),
      ...headers
    }
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

before(async () => {
  const usernames = USERS.map(({ username }) => username);
  await query("DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operators WHERE username = ANY($1::text[]))", [usernames]);
  await query("DELETE FROM operators WHERE username = ANY($1::text[])", [usernames]);
  for (const user of USERS) {
    await createOperator({
      username: user.username,
      displayName: user.username,
      password: PASSWORD,
      role: user.role,
      roles: user.roles
    });
  }
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const user of USERS) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: user.username, password: PASSWORD })
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.operator.homeRoute, user.homeRoute || (user.role === "mbt_frontdesk"
      ? "/mbt/frontdesk"
      : user.role === "mbt_billing"
        ? "/mbt/billing"
        : payload.operator.homeRoute));
    assert.deepEqual(payload.operator.roles, user.roles);
    tokens.set(user.key, payload.token);
  }
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  const usernames = USERS.map(({ username }) => username);
  await query("DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operators WHERE username = ANY($1::text[]))", [usernames]).catch(() => null);
  await query("DELETE FROM operators WHERE username = ANY($1::text[])", [usernames]).catch(() => null);
  await closeDb();
});

test("F02/F15: Front Desk sees its exact controlled server gate state", async () => {
  const own = await request("/api/mbt/frontdesk/status", { role: "mbt_frontdesk" });
  assert.equal(own.response.status, 200, JSON.stringify(own.payload));
  assert.deepEqual(own.payload, {
    schemaVersion: "mbt-frontdesk-status-v1",
    phase: 3,
    surface: "frontdesk",
    enabled: false,
    code: "MBT_CAPABILITY_DISABLED",
    message: "Front Desk is disabled by the server environment setting.",
    commandState: {
      enabled: false,
      reason: "environment_capability_disabled"
    }
  });

  const billing = await request("/api/mbt/billing/status", { role: "mbt_frontdesk" });
  assert.equal(billing.response.status, 403);
  assert.equal(billing.payload.error, "MBT Billing account required");
});

test("F02/F15: Billing sees only its controlled Phase 1 surface", async () => {
  const own = await request("/api/mbt/billing/status", { role: "mbt_billing" });
  assert.equal(own.response.status, 200, JSON.stringify(own.payload));
  assert.deepEqual(own.payload, {
    schemaVersion: "mbt-v1",
    phase: 1,
    surface: "billing",
    enabled: false,
    code: "MBT_CAPABILITY_DISABLED",
    message: "Billing operations are not enabled in Phase 1."
  });

  const frontdesk = await request("/api/mbt/frontdesk/status", { role: "mbt_billing" });
  assert.equal(frontdesk.response.status, 403);
  assert.equal(frontdesk.payload.error, "MBT Front Desk account required");
});

test("F02: Admin can read both controlled surfaces", async () => {
  for (const surface of ["frontdesk", "billing"]) {
    const result = await request(`/api/mbt/${surface}/status`, { role: "admin" });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.surface, surface);
    assert.equal(result.payload.enabled, false);
  }
});

test("F02: secondary MBT authorities work through login and direct HTTP authorization", async () => {
  const frontdesk = await request("/api/mbt/frontdesk/status", { role: "secondary_frontdesk" });
  assert.equal(frontdesk.response.status, 200, JSON.stringify(frontdesk.payload));
  assert.equal(frontdesk.payload.surface, "frontdesk");

  const billing = await request("/api/mbt/billing/status", { role: "secondary_billing" });
  assert.equal(billing.response.status, 200, JSON.stringify(billing.payload));
  assert.equal(billing.payload.surface, "billing");

  const denied = await request("/api/mbt/config", { role: "secondary_frontdesk" });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.payload.error, "Admin account required");
  assert.equal(denied.payload.redirect, "/mbt/frontdesk");
});

test("F02: client-asserted roles never grant direct API authority", async () => {
  for (const path of ["/api/mbt/config", "/api/mbt/frontdesk/status", "/api/mbt/billing/status"]) {
    const result = await request(path, {
      role: "dispatcher",
      headers: {
        "x-mbbs-role": "admin",
        "x-mbbs-roles": "admin,mbt_frontdesk,mbt_billing"
      }
    });
    assert.equal(result.response.status, 403, `${path}: ${JSON.stringify(result.payload)}`);
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import test, { after, before } from "node:test";
import express from "express";
import { query, closeDb } from "../../../src/db.js";
import { createOperator, loginOperator, getOperatorByToken, operatorHomeRoute } from "../../../src/auth-repository.js";
import { createOperatorPreferencesRouter } from "../../../src/operator-preferences-router.js";
import { normalizeOperatorPreferences } from "../../../src/operator-preferences-policy.js";

if (process.env.MBT_TEST_ISOLATED !== "1" || !/\/mbt_test(?:[?#]|$)/.test(process.env.DATABASE_URL || "")) {
  throw new Error("Preferences tests require the disposable test database.");
}

// Execute the existing production authentication/role middleware, without starting
// the production app or its background workers.
const source = readFileSync(new URL("../../../src/server.js", import.meta.url), "utf8");
const scope = vm.createContext({ getOperatorByToken, operatorHomeRoute });
for (const name of ["bearerToken", "requireOperator", "normalizedOperatorRoles", "operatorHasAnyRole", "roleHomeRoute", "sendRoleForbidden", "requireOperatorAccess"]) {
  const marker = source.includes(`async function ${name}(`) ? `async function ${name}(` : `function ${name}(`;
  const start = source.indexOf(marker);
  const end = source.indexOf("\n}", start) + 2;
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), scope);
}
assert.ok(source.includes('app.use("/api/operator/preferences", requireOperator, requireOperatorAccess, createOperatorPreferencesRouter())'));
let server, base;
const accounts = [];
const credentials = [];
before(async () => {
  for (const role of ["operator", "operator", "sales"]) {
    const username = `display-${role}-${crypto.randomUUID()}`;
    const password = crypto.randomUUID();
    credentials.push({ username, password });
    await createOperator({ username, displayName: "Display test", password, role, operatorYardLocationIds: [1] });
    accounts.push(await loginOperator(username, password));
  }
  const app = express();
  app.use(express.json());
  app.use("/api/operator/preferences", scope.requireOperator, scope.requireOperatorAccess, createOperatorPreferencesRouter());
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  base = `http://127.0.0.1:${server.address().port}/api/operator/preferences`;
});
after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  for (const account of accounts) {
    await query("DELETE FROM operators WHERE id = $1", [account.operator.id]);
  }
  await closeDb();
});
function request(index, { body, suffix = "", token } = {}) {
  return fetch(base + suffix, {
    method: body === undefined ? "GET" : "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token ?? accounts[index]?.token ?? ""}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

test("fresh migrated preferences default without creating account rows", async () => {
  const response = await request(0);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), normalizeOperatorPreferences());
  const count = await query("SELECT count(*)::int AS count FROM operator_ui_preferences WHERE operator_id=$1", [accounts[0].operator.id]);
  assert.equal(count.rows[0].count, 0);
});

test("HTTP saves survive a new login and stay isolated from other accounts", async () => {
  const value = normalizeOperatorPreferences();
  value.styles.detail.itemNames = { fontSizePx: 29, color: "#abcdef" };
  value.spacing.detail = "spacious";
  value.useDeviceKeyboard = true;
  assert.equal((await request(0, { body: value })).status, 200);
  const secondLogin = await loginOperator(credentials[0].username, credentials[0].password);
  assert.notEqual(secondLogin.token, accounts[0].token);
  assert.deepEqual(await (await request(0, { token: secondLogin.token })).json(), value);
  assert.deepEqual(await (await request(1, { suffix: `?operatorId=${accounts[0].operator.id}` })).json(), normalizeOperatorPreferences());
  assert.equal((await request(1, { body: { ...value, operatorId: accounts[0].operator.id } })).status, 400);
  assert.deepEqual(await (await request(0)).json(), value);
});

test("authentication, role checks and input validation reject invalid writes", async () => {
  assert.equal((await request(0, { token: "invalid" })).status, 401);
  assert.equal((await request(2)).status, 403);
  assert.equal((await request(2, { body: normalizeOperatorPreferences() })).status, 403);
  const previous = await (await request(0)).json();
  for (const body of [
    { styles: { detail: { quantities: { fontSizePx: 49 } } } },
    { styles: { general: { headings: { color: "#fff;display:none" } } } },
    { useDeviceKeyboard: "false" }, { spacing: { detail: "custom" } }
  ]) {
    assert.equal((await request(0, { body })).status, 400);
  }
  assert.deepEqual(await (await request(0)).json(), previous);
});

test("reset persists empty style overrides while retaining keyboard preference", async () => {
  const reset = normalizeOperatorPreferences({ useDeviceKeyboard: true });
  assert.deepEqual(await (await request(0, { body: reset })).json(), reset);
  assert.deepEqual(await (await request(0)).json(), reset);
});

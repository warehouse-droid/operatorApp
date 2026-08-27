// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { createOperator } from "../../../src/auth-repository.js";
import { closeDb, query } from "../../../src/db.js";
import { app } from "../../../src/server.js";
import {
  createSalesOrderReattemptCorrectionFixture,
  removeSalesOrderReattemptCorrectionFixtures
} from "../../support/sales-order-reattempt-correction-fixture.mjs";

const runId = crypto.randomUUID().replaceAll("-", "");
const password = `reattempt-http-${runId}`;
const users = {
  admin: `reattempt-http-admin-${runId}`,
  dispatcher: `reattempt-http-dispatcher-${runId}`
};
const tokens = new Map();
let fixture;
let baseUrl = "";
let server;

async function request(path, { method = "GET", token = "", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, payload: await response.json().catch(() => ({})) };
}

async function login(username) {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: { username, password }
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  return result.payload.token;
}

before(async () => {
  const admin = await createOperator({
    username: users.admin,
    displayName: "Re-attempt HTTP Admin",
    password,
    role: "admin",
    roles: ["admin"]
  });
  await createOperator({
    username: users.dispatcher,
    displayName: "Re-attempt HTTP Dispatcher",
    password,
    role: "dispatcher",
    roles: ["dispatcher"]
  });
  fixture = await createSalesOrderReattemptCorrectionFixture({ actorId: admin.id, label: "http" });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  tokens.set("admin", await login(users.admin));
  tokens.set("dispatcher", await login(users.dispatcher));
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await removeSalesOrderReattemptCorrectionFixtures(fixture ? [fixture] : []).catch(() => null);
  await query(
    "DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operators WHERE username = $1)",
    [users.dispatcher]
  ).catch(() => null);
  await query("DELETE FROM operators WHERE username = $1", [users.dispatcher]).catch(() => null);
  await closeDb();
});

test("correction preview and command are Admin-only and stale requests do not mutate", async () => {
  const path = `/api/control/sales-order-reattempts/${encodeURIComponent(fixture.childRef)}`;
  const anonymous = await request(`${path}/current-item-correction-preview`);
  assert.equal(anonymous.response.status, 401);

  const forbiddenPreview = await request(`${path}/current-item-correction-preview`, {
    token: tokens.get("dispatcher")
  });
  assert.equal(forbiddenPreview.response.status, 403);

  const preview = await request(`${path}/current-item-correction-preview`, {
    token: tokens.get("admin")
  });
  assert.equal(preview.response.status, 200, JSON.stringify(preview.payload));
  assert.equal(preview.response.headers.get("cache-control"), "no-store");
  assert.equal(preview.payload.preview.lines[0].afterSku, "CURRENT-GN");
  assert.equal(preview.payload.preview.lines[0].historicalSku, "HISTORICAL-CG");

  const body = {
    idempotencyKey: crypto.randomUUID(),
    netsuiteLineId: fixture.netsuiteLineId,
    expectedStateFingerprint: "a".repeat(64),
    reason: "Stale HTTP command must be rejected",
    physicallyDeliveredCurrentItem: true
  };
  const forbiddenApply = await request(`${path}/current-item-corrections`, {
    method: "POST",
    token: tokens.get("dispatcher"),
    body
  });
  assert.equal(forbiddenApply.response.status, 403);

  const stale = await request(`${path}/current-item-corrections`, {
    method: "POST",
    token: tokens.get("admin"),
    body
  });
  assert.equal(stale.response.status, 409, JSON.stringify(stale.payload));
  assert.equal(stale.payload.code, "REATTEMPT_CORRECTION_STALE");
  assert.equal(Number((await query(
    "SELECT count(*)::int AS count FROM sales_order_reattempt_item_corrections WHERE reattempt_order_id = $1",
    [fixture.childId]
  )).rows[0].count), 0);
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";
import { createOperator } from "../../../src/auth-repository.js";
import { config } from "../../../src/config.js";
import { closeDb, query } from "../../../src/db.js";
import { googleMapsUsageRepository } from "../../../src/google-maps-service.js";
import { app } from "../../../src/server.js";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
let server;
let baseUrl;
const tokens = {};
const post = async (token, body) => fetch(`${baseUrl}/api/admin/maps-usage/reopen-daily`, {
  method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body)
});
before(async () => {
  config.googleMaps.mode = "normal";
  await query("DELETE FROM google_maps_usage_ledger");
  await query("DELETE FROM google_maps_daily_reopens");
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const role of ["admin", "dispatcher"]) {
    const username = `maps-daily-${role}-${crypto.randomUUID()}`;
    const password = crypto.randomUUID();
    await createOperator({ username, displayName: username, password, role, roles: [role] });
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password })
    });
    assert.equal(response.status, 200);
    tokens[role] = (await response.json()).token;
  }
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDb();
});

test("real admin endpoint rejects anonymous and dispatcher requests and preserves usage on reopening", async () => {
  await googleMapsUsageRepository.admit({ subsystem: "dynamic_map", units: 150, mode: "normal" });
  const summary = await googleMapsUsageRepository.summary();
  const body = { requestId: crypto.randomUUID(), day: summary.dailyCapacity.day, expectedLimit: 150, addedUnits: 99999 };
  assert.equal((await post(null, body)).status, 401);
  assert.equal((await post(tokens.dispatcher, body)).status, 403);
  assert.equal(Number((await query("SELECT count(*) FROM google_maps_daily_reopens")).rows[0].count), 0);
  const response = await post(tokens.admin, body);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = await response.json();
  assert.equal(payload.dailyCapacity.used, 150);
  assert.equal(payload.dailyCapacity.limit, 300);
  assert.equal(payload.rolling30Day, 150);
  assert.equal(payload.reopen.addedUnits, 150);
  assert.doesNotMatch(JSON.stringify(payload), /apiKey|actor_id|test-admin/u);
  const retry = await post(tokens.admin, body);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).dailyCapacity.limit, 300);
  const invalid = await post(tokens.admin, { ...body, requestId: "<script>" });
  assert.equal(invalid.status, 400);
});

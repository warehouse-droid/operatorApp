import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { createOperator } from "../../../src/auth-repository.js";
import { closeDb, query } from "../../../src/db.js";
import { app } from "../../../src/server.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const PASSWORD = "test-scm-custom-orders";
const USERS = Object.freeze([
  { key: "admin", username: `scm-co-admin-${RUN_ID}`, role: "admin" },
  { key: "scm", username: `scm-co-staff-${RUN_ID}`, role: "scm" },
  { key: "dispatcher", username: `scm-co-dispatch-${RUN_ID}`, role: "dispatcher" },
  { key: "yard", username: `scm-co-yard-${RUN_ID}`, role: "yard_manager" },
  { key: "sales", username: `scm-co-sales-${RUN_ID}`, role: "sales" }
]);
const REF = `SCM-CO-${RUN_ID}`;
const tokens = new Map();
let baseUrl = "";
let server;

async function request(path, { role = "", method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(role ? { authorization: `Bearer ${tokens.get(role)}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

before(async () => {
  for (const user of USERS) {
    await createOperator({
      username: user.username,
      displayName: user.username,
      password: PASSWORD,
      role: user.role,
      roles: [user.role]
    });
  }
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const user of USERS) {
    const login = await request("/api/auth/login", {
      method: "POST",
      body: { username: user.username, password: PASSWORD }
    });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));
    tokens.set(user.key, login.payload.token);
  }
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await query("DELETE FROM dispatch_custom_orders WHERE ref_number = $1", [REF]).catch(() => null);
  const usernames = USERS.map(({ username }) => username);
  await query("DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operators WHERE username = ANY($1::text[]))", [usernames]).catch(() => null);
  await query("DELETE FROM operators WHERE username = ANY($1::text[])", [usernames]).catch(() => null);
  await closeDb();
});

test("SCM Custom Order read authority is scoped independently from Dispatch", async () => {
  for (const role of ["admin", "scm"]) {
    const allowed = await request("/api/scm/custom-orders", { role });
    assert.equal(allowed.response.status, 200, `${role}: ${JSON.stringify(allowed.payload)}`);
  }

  const dispatcher = await request("/api/dispatch/custom-orders", { role: "dispatcher" });
  assert.equal(dispatcher.response.status, 200, JSON.stringify(dispatcher.payload));
  const dispatcherCannotUseScmWriteSurface = await request("/api/scm/custom-orders", { role: "dispatcher" });
  assert.equal(
    dispatcherCannotUseScmWriteSurface.response.status,
    403,
    JSON.stringify(dispatcherCannotUseScmWriteSurface.payload)
  );

  for (const role of ["yard", "sales"]) {
    const denied = await request("/api/scm/custom-orders", { role });
    assert.equal(denied.response.status, 403, `${role}: ${JSON.stringify(denied.payload)}`);
  }
  const anonymous = await request("/api/scm/custom-orders");
  assert.equal(anonymous.response.status, 401, JSON.stringify(anonymous.payload));

  const scmCannotCrossIntoDispatch = await request("/api/dispatch/custom-orders", { role: "scm" });
  assert.equal(scmCannotCrossIntoDispatch.response.status, 403, JSON.stringify(scmCannotCrossIntoDispatch.payload));
});

test("the SCM Custom Order page alias serves the shared cache-busted frontend", async () => {
  const response = await fetch(`${baseUrl}/scm/custom-orders`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  assert.match(html, /id="customOrdersApp"/);
  assert.match(html, /dispatch-custom-orders\.js\?v=20260819-scm-menu-v1/);
});

test("SCM CRUD and Dispatch reads share one Custom Order record", async () => {
  const created = await request("/api/scm/custom-orders", {
    role: "scm",
    method: "POST",
    body: {
      refNumber: REF,
      pickupLocation: "SCM test vendor, 1 Origin Road, Toronto, ON",
      dropoffLocation: "2967 Kennedy Road, Toronto, ON",
      orderDetails: "SCM menu authorization contract",
      weightLbs: 1200,
      stopMinutes: 35
    }
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const id = String(created.payload.order?.id || "");
  assert.match(id, /^\d+$/);

  const updated = await request(`/api/scm/custom-orders/${id}`, {
    role: "scm",
    method: "PATCH",
    body: {
      pickupLocation: "SCM test vendor, 1 Origin Road, Toronto, ON",
      dropoffLocation: "12441 McCowan Road, Whitchurch-Stouffville, ON",
      orderDetails: "Updated through SCM",
      weightLbs: 1250,
      stopMinutes: 40
    }
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assert.equal(updated.payload.order?.orderDetails, "Updated through SCM");

  const dispatchView = await request(`/api/dispatch/custom-orders?search=${encodeURIComponent(REF)}`, {
    role: "dispatcher"
  });
  assert.equal(dispatchView.response.status, 200, JSON.stringify(dispatchView.payload));
  assert.ok(Array.isArray(dispatchView.payload), "The existing Custom Order API response must remain an array.");
  assert.equal(dispatchView.payload.length, 1);
  assert.equal(String(dispatchView.payload[0].id), id);
  assert.equal(dispatchView.payload[0].orderDetails, "Updated through SCM");

  const cancelled = await request(`/api/scm/custom-orders/${id}`, {
    role: "scm",
    method: "DELETE"
  });
  assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.payload));
  assert.equal(cancelled.payload.order?.status, "cancelled");
});

// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { createOperator } from "../../../src/auth-repository.js";
import { closeDb, query } from "../../../src/db.js";
import { app } from "../../../src/server.js";

const suffix = crypto.randomUUID().replaceAll("-", "");
const dispatcherUsername = `completion-dispatcher-${suffix}`;
const salesUsername = `completion-sales-${suffix}`;
const password = `completion-${suffix}`;
const orderRef = `SO-COMPLETION-HTTP-${suffix.toUpperCase()}`;
const orderId = 8_950_000_000_000 + Number.parseInt(suffix.slice(0, 8), 16);
const completedAt = "2001-02-03T15:45:00.000Z";
let baseUrl = "";
let dispatcherToken = "";
let salesToken = "";
let server;

async function request(path, { method = "GET", body, token = "" } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const responseText = await response.text();
  let payload = null;
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = { raw: responseText };
    }
  }
  return { response, payload };
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
  await createOperator({
    username: dispatcherUsername,
    displayName: dispatcherUsername,
    password,
    role: "dispatcher",
    roles: ["dispatcher"]
  });
  await createOperator({
    username: salesUsername,
    displayName: salesUsername,
    password,
    role: "sales",
    roles: ["sales"]
  });
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, customer, fulfillment_status,
       outbound_location_id, outbound_location, sales_order_type,
       dispatch_address, dispatch_planned, netsuite_active, synced_at
     ) VALUES (
       $1, $2, 'HTTP manual completion customer', 'not_fulfilled',
       28, '2967', 'Delivery',
       '8 HTTP Recovery Road, Toronto, ON', true, true, now()
     )`,
    [orderId, orderRef]
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  dispatcherToken = await login(dispatcherUsername);
  salesToken = await login(salesUsername);
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await query(
    "DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operators WHERE username = ANY($1::text[]))",
    [[dispatcherUsername, salesUsername]]
  ).catch(() => null);
  await query("DELETE FROM operators WHERE username = ANY($1::text[])", [
    [dispatcherUsername, salesUsername]
  ]).catch(() => null);
  await query("DELETE FROM sales_orders WHERE netsuite_id = $1", [orderId]).catch(() => null);
  await closeDb();
});

test("U4 HTTP: only Dispatch/Admin can record a confirmed, reasoned manual completion", async () => {
  const body = {
    orderKind: "SO",
    orderRef,
    completedAt,
    reason: "Driver confirmed delivery but forgot to submit the PWA stop.",
    confirm: true
  };
  const forbidden = await request("/api/dispatch/order-completions", {
    method: "POST",
    token: salesToken,
    body
  });
  assert.equal(forbidden.response.status, 403, JSON.stringify(forbidden.payload));

  const missingConfirmation = await request("/api/dispatch/order-completions", {
    method: "POST",
    token: dispatcherToken,
    body: { ...body, confirm: false }
  });
  assert.equal(missingConfirmation.response.status, 400, JSON.stringify(missingConfirmation.payload));
  assert.equal(missingConfirmation.payload.code, "DISPATCH_COMPLETION_CONFIRMATION_REQUIRED");

  const completed = await request("/api/dispatch/order-completions", {
    method: "POST",
    token: dispatcherToken,
    body
  });
  assert.equal(completed.response.status, 200, JSON.stringify(completed.payload));
  assert.equal(completed.payload.completion.orderKind, "SO");
  assert.equal(completed.payload.completion.orderRef, orderRef);
  assert.equal(completed.payload.completion.dispatchCompletionStatus, "completed");
  assert.equal(completed.payload.completion.dispatchCompletedAt, completedAt);
  assert.equal(completed.payload.completion.completionEvidenceType, "manual_dispatch");

  const repeated = await request("/api/dispatch/order-completions", {
    method: "POST",
    token: dispatcherToken,
    body
  });
  assert.equal(repeated.response.status, 200, JSON.stringify(repeated.payload));
  assert.equal(repeated.payload.completion.completionEventId, completed.payload.completion.completionEventId);
  const feed = await request(`/api/dispatch/orders?search=${encodeURIComponent(orderRef)}`, {
    token: dispatcherToken
  });
  assert.equal(feed.response.status, 200, JSON.stringify(feed.payload));
  const retainedOrder = feed.payload.find((order) => order.id === orderRef);
  assert.ok(retainedOrder, "the manually completed order must remain discoverable in Dispatch");
  assert.equal(retainedOrder.dispatchCompletionStatus, "completed");
  assert.equal(retainedOrder.dispatchCompletedAt, completedAt);
  assert.equal(retainedOrder.completionEvidenceType, "manual_dispatch");
  assert.equal(
    Number((await query(
      `SELECT count(*)::int AS count
         FROM dispatch_order_completion_events
        WHERE order_kind = 'SO'
          AND lower(order_ref) = lower($1)
          AND completion_evidence_type = 'manual_dispatch'`,
      [orderRef]
    )).rows[0].count),
    1
  );
});

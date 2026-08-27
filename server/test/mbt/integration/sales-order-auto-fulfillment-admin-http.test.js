// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { createOperator } from "../../../src/auth-repository.js";
import { closeDb, query } from "../../../src/db.js";
import { app } from "../../../src/server.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const PASSWORD = "test-sales-order-if-admin-http";
const USERS = Object.freeze({
  admin: `so-if-admin-${RUN_ID}`,
  dispatcher: `so-if-dispatcher-${RUN_ID}`
});

let baseUrl = "";
let server;
const tokens = new Map();
let fixture;

async function request(path, { token, method = "GET", body } = {}) {
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
    body: { username, password: PASSWORD }
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  return result.payload.token;
}

async function seedHistoricalCompletion() {
  const salesOrderId = 9_840_000_000 + Math.floor(Math.random() * 100_000);
  const orderRef = `SO-IF-HTTP-${RUN_ID.slice(0, 10).toUpperCase()}`;
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       outbound_location_id, outbound_location, sales_order_type,
       operator_status, local_yard_order_status, fulfillment_status,
       netsuite_active, is_test_fixture
     ) VALUES (
       $1, $2, current_date, 'SO IF HTTP customer', 'B', 'Pending Fulfillment',
       15, '12441', 'Delivery', 'loaded', 'Loaded', 'not_fulfilled', true, false
     )`,
    [salesOrderId, orderRef]
  );
  await query(
    `INSERT INTO sales_order_lines (
       sales_order_id, line_id, item_id, item_name, sku, item_type,
       quantity, unit, location_id, location, piece_qty, to_pcs,
       loaded_qty, netsuite_active
     ) VALUES (
       $1, 881001, 992001, 'SO IF HTTP item', 'SO-IF-HTTP', 'InvtPart',
       5, 'EA', 15, '12441', 5, 1, 5, true
     )`,
    [salesOrderId]
  );
  await query(
    `INSERT INTO operator_load_records (
       load_type, order_family, order_id, order_ref, line_snapshot, response
     ) VALUES (
       'sales_order_delivery_load', 'sales_order', $1, $2, $3::jsonb, '{}'::jsonb
     )`,
    [salesOrderId, orderRef, JSON.stringify([{ lineId: 881001, loadedQty: 5 }])]
  );
  const event = await query(
    `INSERT INTO dispatch_order_completion_events (
       order_kind, order_ref, dispatch_completed_at,
       completion_evidence_type, completion_evidence_id,
       actor_type, actor_id, reason
     ) VALUES (
       'SO', $1, now(), 'driver_job', $2, 'driver', 'http-driver', ''
     ) RETURNING id`,
    [orderRef, `SO-IF-HTTP-JOB-${RUN_ID}`]
  );
  return { orderRef, completionEventId: String(event.rows[0].id) };
}

before(async () => {
  for (const [role, username] of Object.entries(USERS)) {
    await createOperator({
      username,
      displayName: username,
      password: PASSWORD,
      role,
      roles: [role]
    });
  }
  fixture = await seedHistoricalCompletion();
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

test("L9/L11 completion-owned SO fulfillment Admin HTTP is private and audit-reasoned", async () => {
  const anonymous = await request("/api/admin/sales-order-fulfillment/candidates");
  assert.equal(anonymous.response.status, 401);
  const denied = await request("/api/admin/sales-order-fulfillment/candidates", {
    token: tokens.get("dispatcher")
  });
  assert.equal(denied.response.status, 403);

  const preview = await request(`/api/admin/sales-order-fulfillment/historical?search=${encodeURIComponent(fixture.orderRef)}`, {
    token: tokens.get("admin")
  });
  assert.equal(preview.response.status, 200, JSON.stringify(preview.payload));
  assert.equal(preview.response.headers.get("cache-control"), "no-store");
  assert.equal(preview.payload.events[0].eventId, fixture.completionEventId);

  const missingReason = await request("/api/admin/sales-order-fulfillment/historical", {
    token: tokens.get("admin"),
    method: "POST",
    body: { completionEventIds: [fixture.completionEventId] }
  });
  assert.equal(missingReason.response.status, 400);
  assert.equal(missingReason.payload.code, "SALES_ORDER_IF_REASON_REQUIRED");

  const queued = await request("/api/admin/sales-order-fulfillment/historical", {
    token: tokens.get("admin"),
    method: "POST",
    body: {
      completionEventIds: [fixture.completionEventId],
      reason: "HTTP Admin reviewed the selected immutable completion"
    }
  });
  assert.equal(queued.response.status, 202, JSON.stringify(queued.payload));
  assert.equal(queued.payload.candidates.length, 1);

  const candidateId = queued.payload.candidates[0].id;
  const unreasonedSkip = await request(`/api/admin/sales-order-fulfillment/${candidateId}/resolve`, {
    token: tokens.get("admin"),
    method: "POST",
    body: { action: "skip" }
  });
  assert.equal(unreasonedSkip.response.status, 400);
  assert.equal(unreasonedSkip.payload.code, "SALES_ORDER_IF_REASON_REQUIRED");

  const skipped = await request(`/api/admin/sales-order-fulfillment/${candidateId}/resolve`, {
    token: tokens.get("admin"),
    method: "POST",
    body: { action: "skip", reason: "This isolated completion is test evidence only" }
  });
  assert.equal(skipped.response.status, 200, JSON.stringify(skipped.payload));
  assert.equal(skipped.payload.candidate.status, "skipped");
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { createOperator } from "../../../src/auth-repository.js";
import { closeDb, query } from "../../../src/db.js";
import { updateScmScheduleEntry } from "../../../src/dispatch-repository.js";
import { app } from "../../../src/server.js";

const suffix = crypto.randomUUID().replaceAll("-", "");
const username = `scm-status-http-${suffix}`;
const password = `status-${suffix}`;
const orderRef = `SCM-STATUS-HTTP-${suffix}`;
const purchaseOrderId = 8_830_000_000_000 + Number.parseInt(suffix.slice(0, 8), 16);
let baseUrl = "";
let token = "";
let server;

async function request(path, { method = "GET", body, authenticated = true } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(authenticated && token ? { authorization: `Bearer ${token}` } : {})
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

before(async () => {
  await createOperator({
    username,
    displayName: username,
    password,
    role: "scm",
    roles: ["scm"]
  });
  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
       foreign_total, destination_location_id, destination_location,
       source_location_id, source_location, dispatch_vendor_yard,
       receipt_status, netsuite_active, synced_at
     ) VALUES (
       $1, $2, current_date, $3, 'HTTP Vendor', 'pendingReceipt', 'Pending Receipt',
       100, 1, '3445', 15, '12441', 'HTTP Vendor Yard',
       'not_received', true, now()
     )`,
    [purchaseOrderId, orderRef, purchaseOrderId + 1]
  );
  await updateScmScheduleEntry({
    orderKind: "PO",
    orderRef,
    patch: { status: "Queued" },
    updatedBy: "status-http-initial"
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  const login = await request("/api/auth/login", {
    method: "POST",
    authenticated: false,
    body: { username, password }
  });
  assert.equal(login.response.status, 200, JSON.stringify(login.payload));
  token = login.payload.token;
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await query("DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operators WHERE username = $1)", [username]).catch(() => null);
  await query("DELETE FROM operators WHERE username = $1", [username]).catch(() => null);
  await query("DELETE FROM scm_transport_schedule WHERE order_kind = 'PO' AND order_ref = $1", [orderRef]).catch(() => null);
  await query("DELETE FROM purchase_orders WHERE netsuite_id = $1", [purchaseOrderId]).catch(() => null);
  await closeDb();
});

async function loadedRow() {
  const listed = await request(`/api/scm/schedule?search=${encodeURIComponent(orderRef)}`);
  assert.equal(listed.response.status, 200, JSON.stringify(listed.payload));
  const row = listed.payload.find((candidate) => candidate.orderRef === orderRef);
  assert.ok(row);
  assert.match(row.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
    "the browser must receive the exact PostgreSQL revision without millisecond truncation");
  return row;
}

test("the authenticated HTTP save rejects missing and stale revisions, then accepts a refreshed retry", async () => {
  const original = await loadedRow();
  const saved = await request(`/api/scm/schedule/${encodeURIComponent(orderRef)}?includeSchedule=false`, {
    method: "PUT",
    body: { orderKind: "PO", status: "Hold", expectedUpdatedAt: original.updatedAt }
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.row.status, "Hold");
  assert.notEqual(saved.payload.row.updatedAt, original.updatedAt);

  const stale = await request(`/api/scm/schedule/${encodeURIComponent(orderRef)}?includeSchedule=false`, {
    method: "PUT",
    body: { orderKind: "PO", status: "Queued", expectedUpdatedAt: original.updatedAt }
  });
  assert.equal(stale.response.status, 409, JSON.stringify(stale.payload));
  assert.equal(stale.payload.code, "SCM_SCHEDULE_STALE");

  const missing = await request(`/api/scm/schedule/${encodeURIComponent(orderRef)}?includeSchedule=false`, {
    method: "PUT",
    body: { orderKind: "PO", status: "Queued" }
  });
  assert.equal(missing.response.status, 409, JSON.stringify(missing.payload));
  assert.equal(missing.payload.code, "SCM_SCHEDULE_STALE");
  assert.equal((await loadedRow()).status, "Hold");

  const retried = await request(`/api/scm/schedule/${encodeURIComponent(orderRef)}?includeSchedule=false`, {
    method: "PUT",
    body: { orderKind: "PO", status: "Priority", expectedUpdatedAt: saved.payload.row.updatedAt }
  });
  assert.equal(retried.response.status, 200, JSON.stringify(retried.payload));
  assert.equal(retried.payload.row.status, "Priority");
});

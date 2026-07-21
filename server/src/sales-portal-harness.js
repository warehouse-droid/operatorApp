import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const { app } = await import("./server.js");
const { createOperator } = await import("./auth-repository.js");
const { config } = await import("./config.js");
const { closeDb, query } = await import("./db.js");
const { getSalesOrderPrintCandidate } = await import("./sales-repository.js");

const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const username = `sales_access_${runId}`;
let account = null;
let server = null;
let testPrintJobId = null;
let testPrintPath = "";

async function requestJson(baseUrl, path, { method = "GET", token = "", body = null } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return { response, payload };
}

try {
  account = await createOperator({
    username,
    displayName: "Sales Portal Harness",
    password: "Rollback123",
    role: "sales",
    roles: ["sales"],
    yardLocationIds: [1]
  });
  assert.deepEqual(account.yardLocationIds, [1]);

  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const login = await requestJson(baseUrl, "/api/auth/login", {
    method: "POST",
    body: { username, password: "Rollback123" }
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.payload.operator.role, "sales");
  assert.deepEqual(login.payload.operator.yardLocationIds, [1]);
  const token = login.payload.token;

  const dispatchRead = await requestJson(baseUrl, "/api/dispatch/config", { token });
  assert.equal(dispatchRead.response.status, 200, "Sales should receive dispatch read access");

  const dispatchWrite = await requestJson(baseUrl, "/api/dispatch/sync", { method: "POST", token, body: {} });
  assert.equal(dispatchWrite.response.status, 403, "Sales must not receive dispatch write access");
  assert.equal(dispatchWrite.payload.redirect, "/sales");

  const admin = await requestJson(baseUrl, "/api/operators", { token });
  assert.equal(admin.response.status, 403);
  assert.equal(admin.payload.redirect, "/sales");

  const printers = await requestJson(baseUrl, "/api/sales/printers", { token });
  assert.equal(printers.response.status, 200);
  assert.deepEqual(printers.payload.map((printer) => printer.locationId), [1, 28, 15, 26]);

  const presets = await requestJson(baseUrl, "/api/sales/schedule-presets", { token });
  assert.equal(presets.response.status, 200);
  assert.deepEqual(new Set(presets.payload.map((preset) => String(preset.name).toLowerCase())), new Set(["yard manager", "completed"]));

  const schedule = await requestJson(baseUrl, "/api/sales/schedule?view=yard%20manager", { token });
  assert.equal(schedule.response.status, 200);
  assert.ok(schedule.payload.every((row) => /(^|[^0-9])3445([^0-9]|$)/.test(`${row.pickupPoint || ""} ${row.dropoffPoint || ""}`)));

  const orders = await requestJson(baseUrl, "/api/sales/sales-orders?limit=10", { token });
  assert.equal(orders.response.status, 200);
  assert.ok(orders.payload.every((order) => Number(order.orderingLocationId) === 1));
  assert.ok(orders.payload.every((order) => /^SOB/i.test(String(order.orderRef || ""))));
  assert.ok(orders.payload.every((order) => String(order.salesOrderType).toLowerCase() === "delivery"));
  assert.ok(orders.payload.every((order) => order.lineYards.length > 0));
  assert.ok(orders.payload.every((order) => order.lineYards.every((yard) => [1, 28, 15, 26].includes(Number(yard.printerLocationId)))));
  assert.ok(orders.payload.every((order) => Array.isArray(order.itemLines) && order.itemLines.length === order.lineCount));
  assert.ok(orders.payload.every((order) => order.itemLines.every((line) => line.itemName && line.quantity !== null)));

  if (orders.payload.length) {
    const order = orders.payload[0];
    const lineYard = order.lineYards[0];
    const snapshot = Buffer.from("%PDF-1.4\n% MBBS Sales history harness\n%%EOF\n");
    testPrintPath = path.join(config.smartScm.printDir, `sales-history-harness-${runId}.pdf`);
    await fs.mkdir(config.smartScm.printDir, { recursive: true });
    await fs.writeFile(testPrintPath, snapshot);
    const insertedJob = await query(
      `INSERT INTO scm_print_jobs (
         job_key, location_id, document_type, document_name, document_path, document_sha256,
         status, queued_at, printed_at, source_order_id, source_order_ref, line_location_id,
         queued_by_operator_id
       ) VALUES ($1,$2,'sales_order_picking_ticket',$3,$4,$5,'printed',now(),now(),$6,$7,$8,$9)
       RETURNING id`,
      [
        `sales-history-harness:${runId}`,
        lineYard.printerLocationId,
        `${order.orderRef}-history-harness.pdf`,
        testPrintPath,
        crypto.createHash("sha256").update(snapshot).digest("hex"),
        order.orderId,
        order.orderRef,
        lineYard.locationId,
        account.id
      ]
    );
    testPrintJobId = Number(insertedJob.rows[0].id);
    const history = await requestJson(baseUrl, `/api/sales/sales-orders/${order.orderId}/print-history`, { token });
    assert.equal(history.response.status, 200);
    assert.equal(history.payload.order.orderId, order.orderId);
    assert.ok(Array.isArray(history.payload.history));
    const testEntry = history.payload.history.find((entry) => entry.jobId === testPrintJobId);
    assert.equal(testEntry.requestedBy, "Sales Portal Harness");
    assert.equal(testEntry.lineLocationId, lineYard.locationId);
    assert.equal(testEntry.printerLocationId, lineYard.printerLocationId);

    const defaultAfterPrint = await requestJson(baseUrl, "/api/sales/sales-orders?limit=2500", { token });
    assert.equal(defaultAfterPrint.response.status, 200);
    assert.ok(!defaultAfterPrint.payload.some((candidate) => candidate.orderId === order.orderId), "Printed Sales Orders must leave the default list");

    const searchedAfterPrint = await requestJson(
      baseUrl,
      `/api/sales/sales-orders?limit=2500&search=${encodeURIComponent(order.orderRef)}`,
      { token }
    );
    assert.equal(searchedAfterPrint.response.status, 200);
    assert.ok(searchedAfterPrint.payload.some((candidate) => candidate.orderId === order.orderId), "Search must include Sales Orders that were printed before");

    const otherYard = [1, 28, 15, 26].find((locationId) => locationId !== Number(lineYard.locationId));
    const changedDestination = await requestJson(baseUrl, `/api/sales/sales-orders/${order.orderId}/print`, {
      method: "POST",
      token,
      body: { lineLocationId: otherYard }
    });
    assert.equal(changedDestination.response.status, 400, "Sales cannot override the inventory line yard printer");

    const snapshotResponse = await requestJson(
      baseUrl,
      `/api/sales/sales-orders/${order.orderId}/print-history/${testPrintJobId}/snapshot`,
      { token }
    );
    assert.equal(snapshotResponse.response.status, 200);
    assert.match(snapshotResponse.response.headers.get("content-type") || "", /application\/pdf/);
    assert.match(String(snapshotResponse.payload), /MBBS Sales history harness/);
  }

  const som05174 = await query("SELECT netsuite_id FROM sales_orders WHERE upper(tranid) = 'SOM05174' LIMIT 1");
  if (som05174.rowCount) {
    const candidate = await getSalesOrderPrintCandidate({
      orderId: som05174.rows[0].netsuite_id,
      allowedOrderingLocationIds: [1, 28, 15, 26]
    });
    assert.deepEqual(candidate.lineYards.map((yard) => yard.locationId), [15], "Subtotal and Discount lines must not redirect SOM05174 away from 12441");
    assert.ok(!/subtotal|discount/i.test(candidate.items), "Accounting lines must not appear in inventory item details");
    assert.equal(candidate.itemLines.length, 5, "SOM05174 must expose its five inventory lines separately");
    assert.ok(candidate.itemLines.every((line) => line.itemName && line.quantity !== null), "Every inventory line must include item name and quantity");
  }

  const pickupOrder = await query(
    `SELECT netsuite_id
       FROM sales_orders
      WHERE netsuite_active = true
        AND lower(trim(COALESCE(sales_order_type, ''))) = 'pick-up'
        AND COALESCE(order_location_id, CASE LEFT(UPPER(COALESCE(tranid, '')), 3) WHEN 'SOB' THEN 1 END) = 1
      ORDER BY trandate DESC NULLS LAST
      LIMIT 1`
  );
  if (pickupOrder.rowCount) {
    const pickupHistory = await requestJson(baseUrl, `/api/sales/sales-orders/${pickupOrder.rows[0].netsuite_id}/print-history`, { token });
    assert.equal(pickupHistory.response.status, 404, "Pickup orders must not enter Sales printing or history");
  }

  const jobs = await requestJson(baseUrl, "/api/sales/print-jobs?limit=10", { token });
  assert.equal(jobs.response.status, 200);
  assert.ok(jobs.payload.every((job) => [1, 28, 15, 26].includes(Number(job.locationId)) && job.documentType === "sales_order_picking_ticket"));

  const invalidPrinter = await requestJson(baseUrl, "/api/sales/sales-orders/1/print", {
    method: "POST",
    token,
    body: { lineLocationId: 0 }
  });
  assert.equal(invalidPrinter.response.status, 400, "Sales must only queue tickets to the four configured yard destinations");

  console.log("Sales portal access checks passed.");
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (testPrintJobId) await query("DELETE FROM scm_print_jobs WHERE id = $1", [testPrintJobId]).catch(() => null);
  if (testPrintPath) await fs.unlink(testPrintPath).catch(() => null);
  if (account) {
    await query("DELETE FROM operator_sessions WHERE operator_id = $1", [account.id]).catch(() => null);
    await query("DELETE FROM delivery_audit_log WHERE actor_operator_id = $1 OR details->>'username' = $2", [account.id, username]).catch(() => null);
    await query("DELETE FROM operators WHERE id = $1", [account.id]).catch(() => null);
  }
  await closeDb();
}

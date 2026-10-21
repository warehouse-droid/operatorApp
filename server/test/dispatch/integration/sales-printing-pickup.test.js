import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import test, { before, after } from "node:test";

assert.equal(process.env.MBT_TEST_ISOLATED, "1", "Use the disposable test database.");
const { app } = await import("../../../src/server.js");
const { config } = await import("../../../src/config.js");
const { createOperator } = await import("../../../src/auth-repository.js");
const { query, closeDb } = await import("../../../src/db.js");
const { listSalesOrderPrintCandidates, getSalesOrderPrintCandidate } = await import("../../../src/sales-repository.js");

const suffix = crypto.randomBytes(5).toString("hex");
const baseId = 9_850_000_000 + Number.parseInt(suffix.slice(0, 7), 16);
const fixtures = [];
const ticket = Buffer.from("%PDF-1.4\n% Disposable pickup printing test\n%%EOF\n");
const restletRequests = [];
const originalEndpoint = config.smartScm.pickingTicketRestletUrl;
const originalDirectAccess = config.netsuite.directAccessEnabled;
let server, restlet, baseUrl, account, token;

async function request(path, options = {}) {
  return fetch(baseUrl + path, {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
}

async function seed(type, options = {}) {
  const id = baseId + fixtures.length;
  const ref = `SOB-PICKUP-PRINT-${suffix}-${fixtures.length}`;
  fixtures.push({ id, ref, type });
  await query(`INSERT INTO sales_orders (netsuite_id, tranid, trandate, customer,
    status, status_text, sales_order_type, order_location_id, outbound_location_id, netsuite_active)
    VALUES ($1, $2, CURRENT_DATE, 'Printing Test Customer', 'B', 'Pending Fulfillment', $3, $4, 15, $5)`,
  [id, ref, type, options.orderingYard ?? 1, options.active ?? true]);
  await query(`INSERT INTO sales_order_lines (sales_order_id, line_id, item_id, item_name,
    sku, item_type, quantity, unit, location_id, netsuite_active) VALUES
    ($1, 1, 2055, 'Test Product', 'TEST-PICKUP-PRINT', 'InvtPart', 4, 'EA', 15, $2),
    ($1, 2, 1987, 'Delivery Charge', 'TEST-CHARGE', 'OthCharge', 1, '', 28, true)`,
  [id, options.lineActive ?? true]);
  return fixtures.at(-1);
}

before(async () => {
  account = await createOperator({ username: `pickup_print_${suffix}`, displayName: "Pickup print test",
    password: "PickupPrintTest123", role: "sales", roles: ["sales"], yardLocationIds: [1] });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await request("/api/auth/login", { method: "POST",
    body: { username: `pickup_print_${suffix}`, password: "PickupPrintTest123" } });
  assert.equal(login.status, 200);
  token = (await login.json()).token;
  for (const type of ["Delivery", "Pick-Up", "Pickup", "  pIcK uP  ", "Other", "", null]) await seed(type);
  await seed("Pick-Up", { orderingYard: 28 });
  await seed("Pick-Up", { active: false });
  await seed("Pick-Up", { lineActive: false });

  // All PDF traffic stays on loopback with a synthetic token; no printer agent runs.
  restlet = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    restletRequests.push(payload);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ entityId: payload.entityId, locationId: payload.location,
      locationApplied: true, contentBase64: ticket.toString("base64") }));
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => restlet.once("listening", resolve));
  config.smartScm.pickingTicketRestletUrl = `http://127.0.0.1:${restlet.address().port}/ticket`;
  config.netsuite.directAccessEnabled = true;
  await query("INSERT INTO netsuite_tokens (id, access_token) VALUES (1, 'disposable-print-test')");
  await query(`UPDATE scm_yard_printers SET enabled = true, printer_name = 'Disposable test printer',
    agent_token_hash = 'disposable-test-hash', settings = '{}'::jsonb WHERE location_id = 15`);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (restlet) await new Promise((resolve) => restlet.close(resolve));
  config.smartScm.pickingTicketRestletUrl = originalEndpoint;
  config.netsuite.directAccessEnabled = originalDirectAccess;
  const ids = fixtures.map((row) => row.id);
  try {
    const jobs = await query("DELETE FROM scm_print_jobs WHERE source_order_id = ANY($1::bigint[]) RETURNING document_path", [ids]);
    for (const job of jobs.rows) await fs.unlink(job.document_path).catch(() => {});
    await query("DELETE FROM sales_print_history_baseline WHERE order_id = ANY($1::bigint[])", [ids]);
    await query("DELETE FROM sales_order_lines WHERE sales_order_id = ANY($1::bigint[])", [ids]);
    await query("DELETE FROM sales_orders WHERE netsuite_id = ANY($1::bigint[])", [ids]);
    await query("DELETE FROM netsuite_tokens WHERE access_token = 'disposable-print-test'");
    if (account) {
      await query("DELETE FROM operator_sessions WHERE operator_id = $1", [account.id]);
      await query("DELETE FROM delivery_audit_log WHERE actor_operator_id = $1", [account.id]);
      await query("DELETE FROM operators WHERE id = $1", [account.id]);
    }
  } finally {
    await closeDb();
  }
});

test("delivery and pickup orders appear with the same product lines and yard routing", async () => {
  const expected = fixtures.slice(0, 4);
  const rows = await listSalesOrderPrintCandidates({ orderingLocationIds: [1], limit: 5000 });
  assert.deepEqual(rows.filter((row) => row.orderRef.includes(suffix)).map((row) => row.orderId).sort(),
    expected.map((row) => row.id).sort());
  for (const fixture of expected) {
    const candidate = await getSalesOrderPrintCandidate({ orderId: fixture.id, allowedOrderingLocationIds: [1] });
    assert.equal(candidate.salesOrderType, fixture.type);
    assert.deepEqual(candidate.lineYards, [{ locationId: 15, yardCode: "12441", printerLocationId: 15 }]);
    assert.equal(candidate.lineCount, 1, "Charge lines must not determine the printer yard");
    const response = await request(`/api/sales/sales-orders?search=${encodeURIComponent(fixture.ref)}`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).map((row) => row.orderId), [fixture.id]);
  }
});

test("unsupported, inactive, and unassigned-yard orders stay excluded", async () => {
  for (const fixture of fixtures.slice(4)) {
    await assert.rejects(getSalesOrderPrintCandidate({ orderId: fixture.id, allowedOrderingLocationIds: [1] }),
      { status: 404 });
    const search = await request(`/api/sales/sales-orders?search=${encodeURIComponent(fixture.ref)}`);
    assert.deepEqual(await search.json(), []);
    for (const path of ["print-history", "picking-ticket-preview"]) {
      assert.equal((await request(`/api/sales/sales-orders/${fixture.id}/${path}`)).status, 404);
    }
    assert.equal((await request(`/api/sales/sales-orders/${fixture.id}/print`, { method: "POST", body: {} })).status, 404);
  }
});

test("pickup preview queues the exact PDF to its line yard and retains searchable history", async () => {
  const fixture = fixtures[1];
  const root = `/api/sales/sales-orders/${fixture.id}`;
  const wrongYard = await request(`${root}/print`, { method: "POST", body: { lineLocationId: 28 } });
  assert.equal(wrongYard.status, 400);
  const preview = await request(`${root}/picking-ticket-preview?lineLocationId=15`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("x-mbbs-print-yard"), "12441");
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), ticket);
  const previewToken = preview.headers.get("x-mbbs-print-preview-token");
  assert.ok(previewToken);
  assert.deepEqual(restletRequests, [{ action: "pickingTicket", entityId: fixture.id, includeContent: true, location: 15 }]);
  const queued = await request(`${root}/print`, { method: "POST", body: { lineLocationId: 15, previewToken } });
  assert.equal(queued.status, 200);
  const result = await queued.json();
  assert.equal(result.printJob.locationId, 15);
  assert.equal(result.printJob.status, "queued");
  assert.equal(restletRequests.length, 1, "Printing must reuse the previewed snapshot");
  const history = await request(`${root}/print-history`);
  assert.equal(history.status, 200);
  assert.equal((await history.json()).history[0].jobId, result.printJob.id);
  const snapshot = await request(`${root}/print-history/${result.printJob.id}/snapshot`);
  assert.equal(snapshot.status, 200);
  assert.deepEqual(Buffer.from(await snapshot.arrayBuffer()), ticket);
  await query("UPDATE scm_print_jobs SET status = 'printed', printed_at = now() WHERE id = $1", [result.printJob.id]);
  const defaultList = await request("/api/sales/sales-orders?limit=5000");
  assert.ok(!(await defaultList.json()).some((row) => row.orderId === fixture.id));
  const searched = await request(`/api/sales/sales-orders?search=${encodeURIComponent(fixture.ref)}`);
  const found = await searched.json();
  assert.equal(found[0].orderId, fixture.id);
  assert.equal(found[0].printHistoryCount, 1);
});

test("previously handled pickup orders stay searchable and keep baseline print history", async () => {
  const fixture = fixtures[2];
  await query("INSERT INTO sales_print_history_baseline (order_id, order_ref) VALUES ($1, $2)", [fixture.id, fixture.ref]);
  const defaultList = await listSalesOrderPrintCandidates({ orderingLocationIds: [1], limit: 5000 });
  assert.ok(!defaultList.some((row) => row.orderId === fixture.id));
  const search = await request(`/api/sales/sales-orders?search=${encodeURIComponent(fixture.ref)}`);
  assert.equal((await search.json())[0].orderId, fixture.id);
  const history = await request(`/api/sales/sales-orders/${fixture.id}/print-history`);
  assert.equal(history.status, 200);
  assert.equal((await history.json()).history[0].historicalBaseline, true);
});

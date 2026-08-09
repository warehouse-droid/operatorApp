import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

process.env.SALES_PUBLIC_ACCESS_ENABLED = "true";

const { app, salesPrintRequestIp } = await import("./server.js");
const { createOperator } = await import("./auth-repository.js");
const { config } = await import("./config.js");
const { closeDb, query } = await import("./db.js");
const { getSalesOrderPrintCandidate, listSalesOrderPrintCandidates } = await import("./sales-repository.js");
const { getSalesPortalSettings } = await import("./sales-settings-repository.js");
const salesPrintingSource = await fs.readFile(new URL("../public/sales-printing.js", import.meta.url), "utf8");

assert.match(salesPrintingSource, /response\.headers\.get\("x-mbbs-print-preview-token"\)/);
assert.match(salesPrintingSource, /previewToken:\s*preview\.previewToken/);
assert.match(salesPrintingSource, /class="sales-preview-error"/);
assert.match(salesPrintingSource, /ready && !salesPrintBusy/);
assert.doesNotMatch(salesPrintingSource, /ready && salesPrintCompanyName && !salesPrintBusy/);
assert.doesNotMatch(salesPrintingSource, /data-sales-company-name|Enter your company name/);
assert.match(salesPrintingSource, /function captureSalesPrintSearchFocus/);
assert.match(salesPrintingSource, /function restoreSalesPrintSearchFocus/);
assert.match(salesPrintingSource, /input\.setSelectionRange/);
assert.match(salesPrintingSource, /if \(!quiet\) \{\s*salesPrintBusy = "loading";\s*renderSalesPrinting\(\);/);
assert.match(salesPrintingSource, /entry\.historicalBaseline/);
assert.match(salesPrintingSource, /No stored snapshot/);

const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const username = `sales_access_${runId}`;
const adminUsername = `sales_admin_${runId}`;
let account = null;
let adminAccount = null;
let server = null;
let testPrintJobId = null;
let testPrintPath = "";
let originalPublicSalesSettings = null;
let specialOrderId = null;

async function requestJson(baseUrl, path, { method = "GET", token = "", body = null, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
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
  adminAccount = await createOperator({
    username: adminUsername,
    displayName: "Sales Admin Harness",
    password: "Rollback123",
    role: "admin",
    roles: ["admin"]
  });
  originalPublicSalesSettings = await getSalesPortalSettings({ fresh: true });

  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  assert.equal(salesPrintRequestIp({
    get: (header) => header === "cf-connecting-ip" ? "198.51.100.27" : "",
    ip: "172.18.0.1",
    socket: { remoteAddress: "172.18.0.1" }
  }), "198.51.100.27");
  assert.equal(salesPrintRequestIp({
    get: () => "not-an-ip",
    ip: "::ffff:127.0.0.1"
  }), "127.0.0.1");

  const adminLogin = await requestJson(baseUrl, "/api/auth/login", {
    method: "POST",
    body: { username: adminUsername, password: "Rollback123" }
  });
  assert.equal(adminLogin.response.status, 200);
  const adminToken = adminLogin.payload.token;

  const adminPublicSettings = await requestJson(baseUrl, "/api/admin/public-sales", { token: adminToken });
  assert.equal(adminPublicSettings.response.status, 200);
  assert.equal(typeof adminPublicSettings.payload.enabled, "boolean");

  const publicDisabled = await requestJson(baseUrl, "/api/admin/public-sales", {
    method: "PUT",
    token: adminToken,
    body: { enabled: false }
  });
  assert.equal(publicDisabled.response.status, 200);
  assert.equal(publicDisabled.payload.enabled, false);

  const disabledPublicAccess = await requestJson(baseUrl, "/api/sales/public-access");
  assert.equal(disabledPublicAccess.response.status, 200);
  assert.equal(disabledPublicAccess.payload.enabled, false);
  assert.equal(disabledPublicAccess.payload.operator, null);
  const disabledPublicPrinters = await requestJson(baseUrl, "/api/sales/printers");
  assert.equal(disabledPublicPrinters.response.status, 401);

  const publicEnabled = await requestJson(baseUrl, "/api/admin/public-sales", {
    method: "PUT",
    token: adminToken,
    body: { enabled: true }
  });
  assert.equal(publicEnabled.response.status, 200);
  assert.equal(publicEnabled.payload.enabled, true);

  const publicAccess = await requestJson(baseUrl, "/api/sales/public-access");
  assert.equal(publicAccess.response.status, 200);
  assert.equal(publicAccess.payload.enabled, true);
  assert.equal(publicAccess.payload.operator.publicSales, true);
  assert.deepEqual(publicAccess.payload.operator.yardLocationIds, [1, 28, 15, 26]);

  const publicPrinters = await requestJson(baseUrl, "/api/sales/printers");
  assert.equal(publicPrinters.response.status, 200);
  assert.deepEqual(publicPrinters.payload.map((printer) => printer.locationId), [1, 28, 15, 26]);

  const privateDispatchRead = await requestJson(baseUrl, "/api/dispatch/config");
  assert.equal(privateDispatchRead.response.status, 401, "Dispatch APIs stay private without a Sales-page request marker");

  const publicDispatchRead = await requestJson(baseUrl, "/api/dispatch/config", {
    headers: { "x-mbbs-sales-public": "1" }
  });
  assert.equal(publicDispatchRead.response.status, 200, "Public Sales planning can read dispatch data");

  const publicDispatchWrite = await requestJson(baseUrl, "/api/dispatch/sync", {
    method: "POST",
    body: {},
    headers: { "x-mbbs-sales-public": "1" }
  });
  assert.equal(publicDispatchWrite.response.status, 401, "Public Sales access cannot mutate dispatch data");

  const login = await requestJson(baseUrl, "/api/auth/login", {
    method: "POST",
    body: { username, password: "Rollback123" }
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.payload.operator.role, "sales");
  assert.deepEqual(login.payload.operator.yardLocationIds, [1]);
  const token = login.payload.token;

  specialOrderId = 9750000000 + Number(String(runId).slice(-7));
  const specialOrderRef = `SOBSP${String(runId).slice(-9)}`;
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       outbound_location_id, outbound_location, sales_order_type, netsuite_active
     ) VALUES ($1, $2, CURRENT_DATE, 'MBBS-Special Print Harness', 'B',
       'Sales Order : Pending Fulfillment', 15, '12441', 'Delivery', true)`,
    [specialOrderId, specialOrderRef]
  );
  await query(
    `INSERT INTO sales_order_lines (
       sales_order_id, line_id, item_id, item_name, sku, item_description,
       item_type, item_type_text, quantity, unit, location_id, location, netsuite_active
     ) VALUES
       ($1, $2, 2055, 'MBBS-Special Order', 'MBBS-Special Order', 'Custom coping',
        'NonInvtPart', 'Non-inventory Item', 22, 'PC', 15, '12441', true),
       ($1, $3, 1987, 'Delivery Charge', 'Delivery Charge', '',
        'OthCharge', 'Other Charge', 1, '', 15, '12441', true)`,
    [specialOrderId, specialOrderId + 1, specialOrderId + 2]
  );
  const specialCandidates = await listSalesOrderPrintCandidates({
    search: specialOrderRef,
    orderingLocationIds: [1],
    limit: 20
  });
  assert.equal(specialCandidates.length, 1, "A Delivery Sales Order containing MBBS-Special must appear in Sales Printing.");
  assert.deepEqual(specialCandidates[0].lineYards.map((yard) => yard.locationId), [15],
    "MBBS-Special must route its picking ticket to the product line yard.");
  assert.deepEqual(specialCandidates[0].itemLines.map((line) => line.itemName), ["MBBS-Special Order"],
    "Charges must remain excluded from printable product details and yard routing.");
  const specialCandidate = await getSalesOrderPrintCandidate({
    orderId: specialOrderId,
    allowedOrderingLocationIds: [1]
  });
  assert.equal(specialCandidate.orderRef, specialOrderRef,
    "MBBS-Special must remain eligible when Sales Printing reloads it for preview or history.");

  const publicInOutbound = await requestJson(
    baseUrl,
    "/api/sales/in-outbound-records?from=2000-01-01&to=2099-12-31&yard=all"
  );
  assert.equal(publicInOutbound.response.status, 403, "Public Sales must not receive driver delivery records.");

  const salesInOutbound = await requestJson(
    baseUrl,
    "/api/sales/in-outbound-records?from=2000-01-01&to=2099-12-31&yard=all",
    { token }
  );
  assert.equal(salesInOutbound.response.status, 200);
  assert.ok(salesInOutbound.payload.every((row) => {
    if (row.order_type !== "sales_order") return Number(row.yard_location_id) === 1;
    return /^SOB/i.test(String(row.tranid || ""));
  }), "Sales In/Outbound access must use SOB store ownership for Sales Orders and physical Yard ownership for other records.");

  const forbiddenYardList = await requestJson(
    baseUrl,
    "/api/sales/in-outbound-records?from=2000-01-01&to=2099-12-31&yard=28",
    { token }
  );
  assert.equal(forbiddenYardList.response.status, 200);
  assert.deepEqual(forbiddenYardList.payload, []);

  if (salesInOutbound.payload.length) {
    const record = salesInOutbound.payload[0];
    const recordQuery = new URLSearchParams({
      direction: record.direction,
      orderType: record.order_type,
      orderId: record.order_id,
      from: "2000-01-01",
      to: "2099-12-31"
    });
    const detail = await requestJson(
      baseUrl,
      `/api/sales/in-outbound-records/detail?${recordQuery}`,
      { token }
    );
    assert.equal(detail.response.status, 200);
    assert.ok(Array.isArray(detail.payload.driverRecords));
    assert.ok(Array.isArray(detail.payload.driverPhotos));
  }

  const adminOtherYard = await requestJson(
    baseUrl,
    "/api/sales/in-outbound-records?from=2000-01-01&to=2099-12-31&yard=28",
    { token: adminToken }
  );
  assert.equal(adminOtherYard.response.status, 200);
  if (adminOtherYard.payload.length) {
    const record = adminOtherYard.payload[0];
    const recordQuery = new URLSearchParams({
      direction: record.direction,
      orderType: record.order_type,
      orderId: record.order_id,
      from: "2000-01-01",
      to: "2099-12-31"
    });
    const forbiddenDetail = await requestJson(
      baseUrl,
      `/api/sales/in-outbound-records/detail?${recordQuery}`,
      { token }
    );
    assert.equal(forbiddenDetail.response.status, 404, "Sales detail must enforce assigned-yard scope.");
  }

  const scopedCsv = await requestJson(
    baseUrl,
    "/api/sales/in-outbound-records/export.csv?from=2000-01-01&to=2099-12-31&yard=all",
    { token }
  );
  assert.equal(scopedCsv.response.status, 200);
  assert.match(scopedCsv.response.headers.get("content-disposition") || "", /in-outbound-record-/);

  const baselineRows = await query(
    `SELECT baseline.order_id, baseline.order_ref
       FROM sales_print_history_baseline baseline
       JOIN sales_orders so ON so.netsuite_id = baseline.order_id
      WHERE so.netsuite_active = true
        AND lower(trim(COALESCE(so.sales_order_type, ''))) = 'delivery'
        AND COALESCE(
          so.order_location_id,
          CASE LEFT(UPPER(COALESCE(so.tranid, '')), 3)
            WHEN 'SOB' THEN 1
            WHEN 'SOA' THEN 28
            WHEN 'SOM' THEN 26
          END
        ) = 1
        AND EXISTS (
          SELECT 1
            FROM sales_order_lines line
           WHERE line.sales_order_id = so.netsuite_id
             AND line.netsuite_active = true
             AND (
               UPPER(TRIM(COALESCE(line.item_type, ''))) IN ('INVTPART', 'NONINVTPART', 'KIT', 'ASSEMBLY')
               OR UPPER(TRIM(COALESCE(line.item_type_text, ''))) IN (
                 'INVENTORY ITEM', 'INVTPART', 'KIT/PACKAGE', 'KIT',
                 'ASSEMBLY ITEM', 'ASSEMBLY/BILL OF MATERIALS'
               )
               OR (
                 COALESCE(line.item_id, 0) > 0
                 AND TRIM(COALESCE(line.item_type, '')) = ''
                 AND TRIM(COALESCE(line.item_type_text, '')) = ''
               )
             )
        )
      ORDER BY baseline.marked_at DESC, baseline.order_id DESC`
  );
  const baselineIds = new Set(baselineRows.rows.map((row) => Number(row.order_id)));
  const unsearchedCandidates = await listSalesOrderPrintCandidates({ orderingLocationIds: [1], limit: 5000 });
  assert.ok(unsearchedCandidates.every((candidate) => !baselineIds.has(candidate.orderId)), "Baseline-printed Sales Orders must stay out of the default list.");
  if (baselineRows.rowCount) {
    const baselineOrder = baselineRows.rows[0];
    const baselineSearch = await requestJson(
      baseUrl,
      `/api/sales/sales-orders?limit=20&search=${encodeURIComponent(baselineOrder.order_ref)}`,
      { token }
    );
    assert.equal(baselineSearch.response.status, 200);
    assert.ok(baselineSearch.payload.some((candidate) => candidate.orderId === Number(baselineOrder.order_id)), "Search must still return a baseline-printed Sales Order.");
    const baselineHistory = await requestJson(
      baseUrl,
      `/api/sales/sales-orders/${baselineOrder.order_id}/print-history`,
      { token }
    );
    assert.equal(baselineHistory.response.status, 200);
    assert.ok(baselineHistory.payload.history.some((entry) => entry.historicalBaseline), "Baseline history must explain that the order was printed by another method.");
  }

  const dispatchRead = await requestJson(baseUrl, "/api/dispatch/config", { token });
  assert.equal(dispatchRead.response.status, 200, "Sales should receive dispatch read access");

  const dispatchWrite = await requestJson(baseUrl, "/api/dispatch/sync", { method: "POST", token, body: {} });
  assert.equal(dispatchWrite.response.status, 403, "Sales must not receive dispatch write access");
  assert.equal(dispatchWrite.payload.redirect, "/sales");

  const admin = await requestJson(baseUrl, "/api/operators", { token });
  assert.equal(admin.response.status, 403);
  assert.equal(admin.payload.redirect, "/sales");
  const forbiddenPublicSettings = await requestJson(baseUrl, "/api/admin/public-sales", { token });
  assert.equal(forbiddenPublicSettings.response.status, 403);
  assert.equal(forbiddenPublicSettings.payload.redirect, "/sales");

  const printers = await requestJson(baseUrl, "/api/sales/printers", { token });
  assert.equal(printers.response.status, 200);
  assert.deepEqual(printers.payload.map((printer) => printer.locationId), [1, 28, 15, 26]);

  const presets = await requestJson(baseUrl, "/api/sales/schedule-presets", { token });
  assert.equal(presets.response.status, 200);
  assert.deepEqual(new Set(presets.payload.map((preset) => String(preset.name).toLowerCase())), new Set(["yard manager"]));

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
    const order = orders.payload.find((candidate) => candidate.lineYards.length === 1)
      || orders.payload[0];
    const lineYard = order.lineYards[0];
    const readyPrinterIds = new Set(publicPrinters.payload
      .filter((printer) => printer.salesOrderReady)
      .map((printer) => Number(printer.locationId)));
    const previewTokenOrder = orders.payload.find((candidate) => candidate.lineYards.length === 1
      && candidate.lineYards.some((yard) => readyPrinterIds.has(Number(yard.printerLocationId))));
    if (previewTokenOrder) {
      const previewTokenYard = previewTokenOrder.lineYards
        .find((yard) => readyPrinterIds.has(Number(yard.printerLocationId)));
      const expiredPreview = await requestJson(baseUrl, `/api/sales/sales-orders/${previewTokenOrder.orderId}/print`, {
        method: "POST",
        token,
        body: {
          lineLocationId: previewTokenYard.locationId,
          previewToken: "expired-preview-token"
        }
      });
      assert.equal(expiredPreview.response.status, 409);
      assert.match(expiredPreview.payload.error, /preview expired/i);
    }
    const snapshot = Buffer.from("%PDF-1.4\n% MBBS Sales history harness\n%%EOF\n");
    testPrintPath = path.join(config.smartScm.printDir, `sales-history-harness-${runId}.pdf`);
    await fs.mkdir(config.smartScm.printDir, { recursive: true });
    await fs.writeFile(testPrintPath, snapshot);
    const insertedJob = await query(
      `INSERT INTO scm_print_jobs (
         job_key, location_id, document_type, document_name, document_path, document_sha256,
         status, queued_at, printed_at, source_order_id, source_order_ref, line_location_id,
         queued_by_operator_id, requested_company_name, requested_ip_address
       ) VALUES ($1,$2,'sales_order_picking_ticket',$3,$4,$5,'printed',now(),now(),$6,$7,$8,$9,$10,$11)
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
        account.id,
        "Harness Company",
        "203.0.113.55"
      ]
    );
    testPrintJobId = Number(insertedJob.rows[0].id);
    const history = await requestJson(baseUrl, `/api/sales/sales-orders/${order.orderId}/print-history`, { token });
    assert.equal(history.response.status, 200);
    assert.equal(history.payload.order.orderId, order.orderId);
    assert.ok(Array.isArray(history.payload.history));
    const testEntry = history.payload.history.find((entry) => entry.jobId === testPrintJobId);
    assert.equal(testEntry.requestedBy, "Sales Portal Harness");
    assert.equal(testEntry.requestedCompanyName, "Harness Company");
    assert.equal(testEntry.requestedIpAddress, "203.0.113.55");
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

    if (order.lineYards.length === 1) {
      const otherYard = [1, 28, 15, 26].find((locationId) => locationId !== Number(lineYard.locationId));
      const changedDestination = await requestJson(baseUrl, `/api/sales/sales-orders/${order.orderId}/print`, {
        method: "POST",
        token,
        body: { lineLocationId: otherYard, companyName: "Harness Company" }
      });
      assert.equal(changedDestination.response.status, 400, "Sales cannot override the inventory line yard printer");
    }

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
    body: { lineLocationId: 0, companyName: "Harness Company" }
  });
  assert.equal(invalidPrinter.response.status, 400, "Sales must only queue tickets to the four configured yard destinations");

  console.log("Sales portal access checks passed.");
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (testPrintJobId) await query("DELETE FROM scm_print_jobs WHERE id = $1", [testPrintJobId]).catch(() => null);
  if (testPrintPath) await fs.unlink(testPrintPath).catch(() => null);
  if (specialOrderId) {
    await query("DELETE FROM sales_order_lines WHERE sales_order_id = $1", [specialOrderId]).catch(() => null);
    await query("DELETE FROM sales_orders WHERE netsuite_id = $1", [specialOrderId]).catch(() => null);
  }
  if (originalPublicSalesSettings) {
    await query(
      `UPDATE sales_portal_settings
          SET public_access_enabled = $1,
              updated_by = $2,
              updated_at = $3
        WHERE id = 1`,
      [
        originalPublicSalesSettings.enabled,
        originalPublicSalesSettings.updatedBy,
        originalPublicSalesSettings.updatedAt
      ]
    ).catch(() => null);
  }
  for (const testAccount of [account, adminAccount].filter(Boolean)) {
    const testUsername = testAccount.id === account?.id ? username : adminUsername;
    await query("DELETE FROM operator_sessions WHERE operator_id = $1", [testAccount.id]).catch(() => null);
    await query("DELETE FROM delivery_audit_log WHERE actor_operator_id = $1 OR details->>'username' = $2", [testAccount.id, testUsername]).catch(() => null);
    await query("DELETE FROM operators WHERE id = $1", [testAccount.id]).catch(() => null);
  }
  await closeDb();
}

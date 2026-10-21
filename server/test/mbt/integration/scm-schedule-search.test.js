import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { before, after } from "node:test";
import { createOperator } from "../../../src/auth-repository.js";
import { closeDb, query } from "../../../src/db.js";
import { app } from "../../../src/server.js";
import { SALES_YARDS } from "../../../src/sales-repository.js";
import { chromium } from "playwright";

const suffix = crypto.randomBytes(5).toString("hex").toUpperCase();
const prefix = `SCHEDULE-SEARCH-${suffix}`;
const password = `SearchTest-${suffix}`;
const baseId = 9_910_000_000 + Number.parseInt(suffix.slice(0, 7), 16);
const tokens = {};
const operators = [];
const fixtures = [];
let baseUrl;
let server;

async function request(path, role = "dispatcher", { method = "GET", body } = {}) {
  const response = await fetch(baseUrl + path, {
    method, headers: { ...(tokens[role] ? { authorization: `Bearer ${tokens[role]}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { response, payload: await response.json() };
}

async function seed(kind, status, extra = {}) {
  let id = baseId + fixtures.length;
  const ref = `${prefix}-${kind}-${fixtures.length}`;
  const yard = extra.yard || "3445";
  const yardId = SALES_YARDS.find((entry) => entry.yardCode === yard)?.locationId || 1;
  const item = extra.item || `${prefix} Cement`;
  if (kind === "PO") {
    await query(`INSERT INTO purchase_orders (netsuite_id, tranid, vendor, status, status_text,
      destination_location_id, destination_location, dispatch_vendor_yard, initial_scm_status,
      receipt_status, netsuite_active, is_blanket_po)
      VALUES ($1, $2, $3, $4, $5, $9, $6, 'Search Vendor Yard', 'Queued', 'not_received', $7, $8)`,
    [id, ref, `${prefix} Vendor`, extra.closed ? "closed" : "pendingReceipt",
      extra.closed ? "Purchase Order : Closed" : "Pending Receipt", yard, !extra.inactive, !!extra.blanket, yardId]);
    await query(`INSERT INTO purchase_order_lines (purchase_order_id, line_id, item_id, item_name, sku,
      quantity, unit, piece_qty, to_pcs, location_id, location, netsuite_active)
      VALUES ($1, 1, 5055, $2, $2, 10, 'EA', 10, 1, $4, $3, true)`, [id, item, yard, yardId]);
  } else if (kind === "TO") {
    await query(`INSERT INTO transfer_orders (netsuite_id, tranid, status, status_text,
      from_location_id, from_location, to_location_id, to_location, fulfillment_status,
      receiving_status, netsuite_active)
      VALUES ($1, $2, $3, $4, 15, '12441', $7, $5, 'not_fulfilled', 'not_received', $6)`,
    [id, ref, extra.closed ? "closed" : "B", extra.closed ? "Transfer Order : Closed" : "Pending Fulfillment", yard, !extra.inactive, yardId]);
    await query(`INSERT INTO transfer_order_lines (line_stage, transfer_order_id, line_id,
      item_id, item_name, sku, quantity, unit, piece_qty, to_pcs, location_id, location, netsuite_active)
      VALUES ('outbound', $1, 1, 5055, $2, $2, 10, 'EA', 10, 1, 15, '12441', true)`, [id, item]);
  } else {
    id = (await query(`INSERT INTO scm_vrma_orders (vrma_ref, vendor, pickup_location, dropoff_location, status)
      VALUES ($1, $2, $3, 'Search Vendor Yard', $4) RETURNING id`, [ref, `${prefix} Vendor`, yard, status])).rows[0].id;
  }
  await query(`INSERT INTO scm_transport_schedule (order_kind, source_table, source_id, order_ref,
    method, pickup_point, dropoff_point, status, is_special_order)
    VALUES ($1, $2, $3, $4, $5, 'Search Vendor Yard', $6, $7, $8)`,
  [kind, { PO: "purchase_orders", TO: "transfer_orders", VRMA: "scm_vrma_orders" }[kind], id, ref, extra.method || "MBT", yard, status, !!extra.special]);
  const fixture = { id, ref, kind, status, ...extra };
  fixtures.push(fixture);
  return fixture;
}

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const role of ["dispatcher", "sales", "admin", "scm", "yard_manager", "operator"]) {
    const username = `schedule-search-${role}-${suffix}`;
    const operator = await createOperator({ username, displayName: username, password, role,
      roles: [role], yardLocationIds: role === "sales" ? [1] : [] });
    operators.push(operator.id);
    const login = await request("/api/auth/login", "unauthenticated", { method: "POST", body: { username, password } });
    assert.equal(login.response.status, 200);
    tokens[role] = login.payload.token;
  }
  for (const kind of ["PO", "TO"]) {
    for (const status of ["Queued", "Hold", "Completed", "Cancelled", "Priority"]) {
      await seed(kind, status, { method: status === "Cancelled" ? "Vendor" : "MBT" });
    }
    await seed(kind, "Completed", { inactive: true });
    await seed(kind, "Completed", { closed: true });
    await seed(kind, "Completed", { yard: "2967" });
  }
  await seed("PO", "Queued", { blanket: true, method: "Vendor" });
  await seed("PO", "Cancelled", { special: true, method: "Customer Pickup" });
  await seed("PO", "Completed", { yard: "12441 + 3445" });
  await seed("VRMA", "Completed");
  await seed("VRMA", "Hold");
  const cancelledSplit = await seed("PO", "Cancelled", { cancelledSplit: true });
  const sourcePo = fixtures.find((row) => row.kind === "PO" && row.status === "Queued");
  await query(`INSERT INTO dispatch_scm_po_splits (source_po_id, source_po_ref, split_po_id, split_po_ref, status)
    VALUES ($1, $2, $3, $4, 'cancelled')`, [sourcePo.id, sourcePo.ref, cancelledSplit.id, cancelledSplit.ref]);
  const held = await seed("PO", "Queued", { heldByReconciliation: true });
  const state = (await query(`INSERT INTO scm_reconciliation_order_state (order_kind,
    source_order_netsuite_id, source_order_ref, application_status, reconciliation_status,
    quantity_summary, reconciled_at)
    VALUES ('PO', $1, $2, 'Hold', 'current', $3::jsonb, now()) RETURNING id`,
  [held.id, held.ref, JSON.stringify({ targets: { [held.ref]: { applicationStatus: "Hold" } } })])).rows[0].id;
  await query(`UPDATE scm_transport_schedule SET reconciliation_order_state_id = $1,
    last_reconciled_at = now() WHERE order_ref = $2`, [state, held.ref]);
  await seed("TO", "Queued", { item: "EKO70S" });
  for (const yard of ["2967", "150", "12441"]) {
    for (const status of ["Queued", "Completed", "Cancelled", "Hold"]) {
      await seed("PO", status, { item: "EKO70S", yard });
    }
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await query("DELETE FROM scm_transport_schedule WHERE order_ref LIKE $1", [`${prefix}%`]);
  await query("DELETE FROM scm_reconciliation_order_state WHERE source_order_ref LIKE $1", [`${prefix}%`]);
  await query("DELETE FROM purchase_orders WHERE tranid LIKE $1", [`${prefix}%`]);
  await query("DELETE FROM transfer_orders WHERE tranid LIKE $1", [`${prefix}%`]);
  await query("DELETE FROM scm_vrma_orders WHERE vrma_ref LIKE $1", [`${prefix}%`]);
  await query("DELETE FROM operator_sessions WHERE operator_id = ANY($1::text[])", [operators]);
  await query("DELETE FROM operators WHERE id = ANY($1::text[])", [operators]);
  await closeDb();
});

function refs(payload) {
  return payload.map((row) => row.orderRef).filter((ref) => ref.startsWith(prefix)).sort();
}
function expected() {
  return fixtures.filter((fixture) => fixture.status !== "Hold" && !fixture.heldByReconciliation)
    .map((fixture) => fixture.ref).sort();
}
function expectedEko70s() {
  return fixtures.filter((fixture) => fixture.item === "EKO70S" && fixture.status !== "Hold")
    .map((fixture) => fixture.ref).sort();
}

for (const [role, path] of [["sales", "/api/sales/schedule"], ["dispatcher", "/api/scm/schedule"],
  ["admin", "/api/scm/schedule"], ["scm", "/api/scm/schedule"]]) {
  test(`${role} global search spans statuses and types despite conflicting view and column filters`, async () => {
    const params = new URLSearchParams({ search: `  ${prefix.toLowerCase()}  `, surface: "dispatch",
      view: "completed", status: "Urgent", kind: "VRMA", method: "Customer Pickup", dropoffPoint: "150",
      brand: "different", from: "2099-01-01", queuedFrom: "2099-01-01", contentSearch: "different",
      weightMin: "invalid", reconciliationStatus: "review" });
    const result = await request(`${path}?${params}`, role);
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.deepEqual(refs(result.payload), expected());
    assert.ok(result.payload.every((row) => !String(row.reconciliationApplicationStatus || row.calculatedStatus || row.status).toLowerCase().includes("hold")));
    if (role === "sales") assert.ok(result.payload.every((row) => !row.reconciliation));
  });
}

test("Sales global search spans all yards and includes combined yards", async () => {
  const result = await request(`/api/sales/schedule?search=${prefix}`, "sales");
  assert.equal(result.response.status, 200);
  assert.deepEqual(refs(result.payload), expected());
  const outside = fixtures.find((fixture) => fixture.yard === "2967");
  const targeted = await request(`/api/sales/schedule?search=${outside.ref}`, "sales");
  assert.equal(targeted.response.status, 200);
  assert.deepEqual(refs(targeted.payload), [outside.ref]);
});

test("3445 Sales EKO70S search returns the local TO and POs to 2967, 150 and 12441, excluding Hold", async () => {
  for (const role of ["sales", "dispatcher"]) {
    const path = role === "sales" ? "/api/sales/schedule" : "/api/scm/schedule";
    const params = new URLSearchParams({ search: "  eko70s  ", status: "Queued", kind: "TO", dropoffPoint: "3445" });
    const result = await request(`${path}?${params}`, role);
    assert.equal(result.response.status, 200);
    assert.deepEqual(refs(result.payload), expectedEko70s());
    assert.deepEqual([...new Set(result.payload.map((row) => row.dropoffPoint))].sort(), ["12441", "150", "2967", "3445"]);
    assert.ok(result.payload.every((row) => !row.reconciliation));
  }
});

test("3445 Sales browsing remains restricted to its yard with empty or whitespace search", async () => {
  const local = fixtures.find((fixture) => fixture.kind === "PO" && fixture.status === "Queued" && !fixture.yard);
  const outside = fixtures.filter((fixture) => fixture.item === "EKO70S" && fixture.kind === "PO" && fixture.status === "Queued");
  assert.equal(outside.length, 3);
  for (const search of ["", " ", "\t\n "]) {
    const result = await request(`/api/sales/schedule?${new URLSearchParams({ search })}`, "sales");
    assert.equal(result.response.status, 200);
    const found = new Set(refs(result.payload));
    assert.ok(found.has(local.ref));
    for (const fixture of outside) assert.equal(found.has(fixture.ref), false, fixture.yard);
  }
});

test("blank and whitespace search cannot bypass ordinary browsing visibility", async () => {
  for (const role of ["sales", "dispatcher"]) {
    const path = role === "sales" ? "/api/sales/schedule" : "/api/scm/schedule";
    for (const search of ["", " \t "]) {
      const params = new URLSearchParams({ search, surface: "dispatch", includeRestricted: "true", searchAllOrders: "true" });
      const result = await request(`${path}?${params}`, role);
      assert.equal(result.response.status, 200);
      const found = new Set(refs(result.payload));
      for (const fixture of fixtures.filter((row) => ["Hold", "Completed", "Cancelled"].includes(row.status) || row.blanket || row.heldByReconciliation)) {
        assert.equal(found.has(fixture.ref), false, `${role} leaked ${fixture.ref} without a search`);
      }
    }
  }
});

test("search requires authentication and the existing API role; Yard Manager cannot opt into Dispatch policy", async () => {
  for (const path of ["/api/sales/schedule", "/api/scm/schedule"]) {
    assert.equal((await request(`${path}?search=${prefix}`, "unauthenticated")).response.status, 401);
    assert.equal((await request(`${path}?search=${prefix}`, "operator")).response.status, 403);
  }
  const yard = await request(`/api/scm/schedule?search=${prefix}&surface=dispatch&includeRestricted=true`, "yard_manager");
  assert.equal(yard.response.status, 200);
  assert.ok(yard.payload.every((row) => !row.isBlanket && !["Hold", "Completed", "Cancelled"].includes(row.calculatedStatus || row.status)));
});

test("SCM's existing structured-search behavior is preserved without the Dispatch surface", async () => {
  const result = await request(`/api/scm/schedule?search=${prefix}&kind=TO&method=Vendor`, "scm");
  assert.equal(result.response.status, 200);
  assert.deepEqual(refs(result.payload), fixtures.filter((fixture) => fixture.kind === "TO"
    && fixture.method === "Vendor").map((fixture) => fixture.ref).sort());
});

test("partial references match case-insensitively and unmatched searches return no rows", async () => {
  const fixture = fixtures.find((row) => row.kind === "TO" && row.status === "Completed" && !row.closed && !row.inactive);
  const result = await request(`/api/scm/schedule?search=${fixture.ref.toLowerCase()}&kind=PO&status=Queued`);
  assert.equal(result.response.status, 200);
  assert.deepEqual(refs(result.payload), [fixture.ref]);
  assert.deepEqual((await request(`/api/scm/schedule?search=NO-MATCH-${suffix}`)).payload, []);
});

test("search does not grant Sales permission to write schedules or Dispatch permission to complete vendor orders", async () => {
  const fixture = fixtures.find((row) => row.status === "Completed");
  const sales = await request(`/api/scm/schedule/${fixture.ref}`, "sales", {
    method: "PUT", body: { orderKind: fixture.kind, status: "Queued" }
  });
  assert.equal(sales.response.status, 403);
  const dispatch = await request(`/api/scm/schedule/${fixture.ref}/complete-vendor`, "dispatcher", {
    method: "POST", body: { orderKind: fixture.kind }
  });
  assert.equal(dispatch.response.status, 403);
});

test("real Sales and Dispatch browser search renders every non-Hold match and restores saved filters", async () => {
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  try {
    for (const [role, path] of [["sales", "/sales/schedule"], ["dispatcher", "/dispatch/po-to-schedule"]]) {
      const context = await browser.newContext();
      try {
        await context.addInitScript((token) => localStorage.setItem("mbbs.staff.token", token), tokens[role]);
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(baseUrl + path);
        await page.waitForFunction(() => typeof scmScheduleLoading !== "undefined" && !scmScheduleLoading && scmScheduleOperator);
        const saved = await page.evaluate(() => {
          scmScheduleFilters.kind = ["PO"];
          scmScheduleFilters.status = ["Queued"];
          saveLocalScmScheduleFilterPreference();
          renderScmSchedule();
          return localStorage.getItem(scmScheduleFilterPreferenceKey());
        });
        const response = page.waitForResponse((response) => response.url().includes("/schedule?") && response.url().includes(prefix.toLowerCase()));
        await page.locator('[data-filter="search"]').fill(prefix.toLowerCase());
        assert.equal((await response).status(), 200);
        await page.waitForFunction(() => !scmScheduleLoading);
        const rendered = await page.locator(".scm-sheet-row").evaluateAll((elements) => elements.map((element) => element.dataset.rowRef).sort());
        assert.deepEqual(rendered, expected());
        assert.equal(await page.locator('[data-action="save-row"]').count(), 0);
        const ekoResponse = page.waitForResponse((response) => response.url().includes("/schedule?") && response.url().includes("search=eko70s"));
        await page.locator('[data-filter="search"]').fill("eko70s");
        assert.equal((await ekoResponse).status(), 200);
        await page.waitForFunction(() => !scmScheduleLoading);
        assert.deepEqual(await page.locator(".scm-sheet-row").evaluateAll((elements) => elements.map((element) => element.dataset.rowRef).sort()), expectedEko70s());
        const artifactDir = process.env.SCM_SCHEDULE_SEARCH_ARTIFACT_DIR || "/app/test-artifacts/scm-schedule-search-20261014";
        await page.screenshot({ path: `${artifactDir}/${role}-eko70s-search.png`, fullPage: true });
        const cleared = page.waitForResponse((response) => response.url().includes("/schedule?") && !response.url().includes("search="));
        await page.locator('[data-filter="search"]').fill("");
        assert.equal((await cleared).status(), 200);
        await page.waitForFunction(() => !scmScheduleLoading);
        const restored = await page.locator(".scm-sheet-row").evaluateAll((elements) => elements.map((element) => element.dataset.rowRef).filter((ref) => ref.startsWith("SCHEDULE-SEARCH-")).sort());
        assert.deepEqual(restored, fixtures.filter((fixture) => fixture.kind === "PO" && fixture.status === "Queued"
          && !fixture.blanket && !fixture.heldByReconciliation
          && (role !== "sales" || !fixture.yard || fixture.yard.includes("3445"))).map((fixture) => fixture.ref).sort());
        assert.equal(await page.evaluate(() => localStorage.getItem(scmScheduleFilterPreferenceKey())), saved);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
});

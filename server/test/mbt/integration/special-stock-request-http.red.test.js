import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { createOperator } from "../../../src/auth-repository.js";
import { closeDb, query } from "../../../src/db.js";
import { app } from "../../../src/server.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const PASSWORD = "special-http-test";
const USERS = Object.freeze({
  sales: `special-sales-${RUN_ID}`,
  scm: `special-scm-${RUN_ID}`,
  dispatcher: `special-dispatch-${RUN_ID}`
});

let server;
let baseUrl;
let originalGate;
const tokens = new Map();

async function request(path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, payload: await response.json().catch(() => ({})) };
}

async function login(username) {
  const result = await request("/api/auth/login", { method: "POST", body: { username, password: PASSWORD } });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  return result.payload.token;
}

before(async () => {
  originalGate = (await query(
    "SELECT enabled, revision FROM mbt_feature_flags WHERE flag_key = 'special_stock_request_workflow'"
  )).rows[0];
  await query("UPDATE mbt_feature_flags SET enabled = false WHERE flag_key = 'special_stock_request_workflow'");
  await createOperator({ username: USERS.sales, displayName: "Special HTTP Sales", password: PASSWORD, role: "sales", roles: ["sales"], yardLocationIds: [15] });
  await createOperator({ username: USERS.scm, displayName: "Special HTTP SCM", password: PASSWORD, role: "scm", roles: ["scm"] });
  await createOperator({ username: USERS.dispatcher, displayName: "Special HTTP Dispatch", password: PASSWORD, role: "dispatcher", roles: ["dispatcher"] });
  await query(
    `INSERT INTO inventory_items (item_id, item_name, display_name, item_description, item_type, stock_unit, raw, synced_at)
     VALUES (8890002, 'SPECIAL-HTTP', 'Special HTTP', 'Special HTTP item', 'InvtPart', 'PC', '{}'::jsonb, now())
     ON CONFLICT (item_id) DO NOTHING`
  );
  await query(
    `INSERT INTO netsuite_customers (
       netsuite_id, entity_number, legal_name, display_name, phone, currency, active,
       source_modified_at, source_version, payload_hash
     ) VALUES (8899002,'8899002','HTTP Autocomplete Customer','HTTP Autocomplete Customer',
               '416-555-0199','CAD',true,now(),'test',repeat('d',64))
     ON CONFLICT (netsuite_id) DO NOTHING`
  );
  await query(
    `INSERT INTO dispatch_vendor_mappings (
       netsuite_vendor_id, netsuite_vendor_name, local_vendor, active, last_po_ref
     ) VALUES ('8899003','HTTP Autocomplete Vendor','HTTP Autocomplete Vendor',true,'HTTP-AUTO')
     ON CONFLICT DO NOTHING`
  );
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
  if (originalGate) {
    await query(
      `UPDATE mbt_feature_flags SET enabled = $1, revision = $2
        WHERE flag_key = 'special_stock_request_workflow'`,
      [originalGate.enabled, originalGate.revision]
    );
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await closeDb();
});

test("HTTP workflow is fail-closed, role-separated, and keeps SCM costs private", async () => {
  const anonymous = await request("/api/sales/special-stock-requests/policy");
  assert.equal(anonymous.response.status, 401);
  const policy = await request("/api/sales/special-stock-requests/policy", { token: tokens.get("sales") });
  assert.equal(policy.response.status, 200);
  assert.equal(policy.payload.enabled, false);
  const disabled = await request("/api/sales/special-stock-requests", {
    token: tokens.get("sales"), method: "POST", body: {}
  });
  assert.equal(disabled.response.status, 404);
  assert.equal(disabled.payload.code, "SPECIAL_STOCK_DISABLED");

  await query("UPDATE mbt_feature_flags SET enabled = true WHERE flag_key = 'special_stock_request_workflow'");
  const customers = await request("/api/sales/special-stock-requests/customers?search=HTTP%20Autocomplete", {
    token: tokens.get("sales")
  });
  assert.equal(customers.response.status, 200, JSON.stringify(customers.payload));
  assert.equal(customers.payload.customers[0].phone, "416-555-0199");
  const vendors = await request("/api/sales/special-stock-requests/vendors?search=HTTP%20Autocomplete", {
    token: tokens.get("sales")
  });
  assert.equal(vendors.response.status, 200, JSON.stringify(vendors.payload));
  assert.deepEqual(vendors.payload.vendors[0], { id: 8899003, name: "HTTP Autocomplete Vendor" });
  const scmCannotUseSales = await request("/api/sales/special-stock-requests", { token: tokens.get("scm") });
  assert.equal(scmCannotUseSales.response.status, 403);
  const salesCannotUseScm = await request("/api/scm/special-stock-requests", { token: tokens.get("sales") });
  assert.equal(salesCannotUseScm.response.status, 403);

  const created = await request("/api/sales/special-stock-requests", {
    token: tokens.get("sales"),
    method: "POST",
    body: {
      storeLocationId: 15,
      inquiryDate: "2099-08-21",
      customerName: "HTTP Special Customer",
      vendorName: "HTTP Special Vendor",
      lines: [
        { productName: "HTTP multi-line A", quantity: 2, uom: "PLT", requiredDate: "2099-09-01" },
        { productName: "HTTP multi-line B", quantity: 1, uom: "PLT", requiredDate: "2099-09-01" }
      ]
    }
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.lines.length, 2);
  const responded = await request(`/api/scm/special-stock-requests/${created.payload.id}/lines/${created.payload.lines[0].id}/response`, {
    token: tokens.get("scm"),
    method: "POST",
    body: {
      expectedRevision: created.payload.revision,
      supplyStatus: "in_stock",
      availabilityMode: "dated",
      availableDate: "2099-08-23",
      vendorId: 8880002,
      vendorName: "HTTP Special Vendor",
      vendorYard: "HTTP Vendor Yard",
      unitPurchaseCost: 12.5,
      currency: "CAD"
    }
  });
  assert.equal(responded.response.status, 200, JSON.stringify(responded.payload));
  assert.equal(responded.payload.lines[0].unitPurchaseCost, 12.5);
  assert.equal(responded.payload.lines[0].itemResolution, null);

  const salesView = await request(`/api/sales/special-stock-requests/${created.payload.id}`, { token: tokens.get("sales") });
  assert.equal(salesView.response.status, 200, JSON.stringify(salesView.payload));
  assert.equal(Object.hasOwn(salesView.payload.lines[0], "unitPurchaseCost"), false);
  assert.equal(Object.hasOwn(salesView.payload.lines[0], "scmInternalNote"), false);
  assert.equal(salesView.response.headers.get("cache-control"), "private, no-store");

  const dispatchView = await request("/api/dispatch/special-stock-handoffs", { token: tokens.get("dispatcher") });
  assert.equal(dispatchView.response.status, 200, JSON.stringify(dispatchView.payload));
  assert.doesNotMatch(JSON.stringify(dispatchView.payload), /unitPurchaseCost|scmInternalNote/u);
});

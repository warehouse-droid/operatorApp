import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { before, after } from "node:test";
import fc from "fast-check";
import { app } from "../../../src/server.js";
import { createOperator, loginOperator } from "../../../src/auth-repository.js";
import { query, closeDb } from "../../../src/db.js";

let server, base, assigned, foreign;
const vendor = "VRMA encoding fixture vendor", yard = "VRMA encoding vendor yard";
async function account(grants) {
  const username = `vrma-encoding-${crypto.randomUUID()}`, password = crypto.randomUUID();
  await createOperator({ username, displayName: "VRMA encoding test", password, role: "operator", operatorYardLocationIds: grants });
  return loginOperator(username, password);
}
async function request(session, path, method = "GET", body) {
  const response = await fetch(`${base}${path}`, { method,
    headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
async function seed(ref) {
  const order = (await query("INSERT INTO scm_vrma_orders(vrma_ref,local_vendor,pickup_location,dropoff_location) VALUES($1,$2,'3445',$3) RETURNING id", [ref, vendor, yard])).rows[0];
  const lines = (await query(`INSERT INTO scm_vrma_order_lines(vrma_order_id,item_id,item_name,quantity,unit)
    VALUES($1,998170001,'VRMA encoding item',20,'EACH'),($1,998170001,'VRMA encoding second item',30,'EACH') RETURNING id`, [order.id])).rows;
  return { id: order.id, key: `VRMA:${ref}`, lines: lines.map(row => ({ id: row.id, key: `VRMALINE:${row.id}` })) };
}
async function stored(id) {
  return { order: (await query("SELECT * FROM scm_vrma_orders WHERE id=$1", [id])).rows,
    lines: (await query("SELECT * FROM scm_vrma_order_lines WHERE vrma_order_id=$1 ORDER BY id", [id])).rows,
    inventory: (await query("SELECT * FROM inventory_balances WHERE item_id=998170001 ORDER BY location_id")).rows };
}
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  assigned = await account([1]); foreign = await account([28]);
  await query("INSERT INTO dispatch_local_vendors(name) VALUES($1)", [vendor]);
  await query("INSERT INTO dispatch_vendor_yards(vendor,yard,address,active) VALUES($1,$2,'Fixture Road',true)", [vendor, yard]);
  await query("INSERT INTO inventory_items(item_id,item_name,item_type,stock_unit) VALUES(998170001,'VRMA encoding item','InvtPart','EACH')");
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) {await new Promise(resolve => server.close(resolve));} await closeDb(); });

test("encoded reported VRMA supports line confirmation, page confirmation and packed quantity adjustment", async () => {
  const order = await seed("RP-UNI-AYR-3445-0914-1"), path = `/api/delivery/orders/${encodeURIComponent(order.key)}`;
  const beforeState = await stored(order.id);
  const detail = await request(assigned, path);
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  assert.equal(detail.data.netsuite_id, order.key);
  const first = await request(assigned, `${path}/lines/${encodeURIComponent(order.lines[0].key)}/confirm`, "POST", { salesQty: 4 });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(Number(first.data.order.lines[0].packed_sales_qty), 4);
  const page = await request(assigned, `${path}/lines/confirm-page`, "POST", { lines: [{ lineId: order.lines[1].key, values: { salesQty: 7 } }] });
  assert.equal(page.status, 200, JSON.stringify(page.data)); assert.equal(page.data.confirmed, 1); assert.deepEqual(page.data.failures, []);
  const adjustment = await request(assigned, `${path}/lines/${encodeURIComponent(order.lines[0].key)}/packed-quantity`, "POST", { salesQty: 6 });
  assert.equal(adjustment.status, 200, JSON.stringify(adjustment.data));
  assert.equal(Number(adjustment.data.order.lines[0].packed_sales_qty), 6);
  const afterState = await stored(order.id);
  assert.deepEqual(afterState.lines.map(line => Number(line.packed_sales_qty)), [6, 7]);
  assert.deepEqual(afterState.inventory, beforeState.inventory);
  assert.equal(afterState.order[0].loaded_at, null);
});

test("encoded VRMA requests from a foreign yard remain forbidden with no order, line or inventory changes", async () => {
  const order = await seed("RP-ENCODING-FOREIGN"), path = `/api/delivery/orders/${encodeURIComponent(order.key)}`, beforeState = await stored(order.id);
  for (const [suffix, body] of [[`/lines/${encodeURIComponent(order.lines[0].key)}/confirm`, { salesQty: 4 }],
    ["/lines/confirm-page", { lines: [{ lineId: order.lines[0].key, values: { salesQty: 4 } }] }],
    [`/lines/${encodeURIComponent(order.lines[0].key)}/packed-quantity`, { salesQty: 4 }]]) {
    const result = await request(foreign, `${path}${suffix}?locationId=28`, "POST", { ...body, locationId: 28 });
    assert.equal(result.status, 403, JSON.stringify(result.data));
  }
  assert.deepEqual(await stored(order.id), beforeState);
});

test("property: reserved characters stay inside the checked VRMA identifier and both yard outcomes agree", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom(":", "/lines/", "?", "#", "%3A", "%2F", "+", "é"), fc.integer({ min: 1, max: 999999 }), async (reserved, value) => {
    const ref = `RP-ENCODING-${value}-${reserved}-${crypto.randomUUID()}`, order = await seed(ref);
    const path = `/api/delivery/orders/${encodeURIComponent(order.key)}?locationId=1`;
    const allowed = await request(assigned, path);
    assert.equal(allowed.status, 200, JSON.stringify(allowed.data)); assert.equal(allowed.data.netsuite_id, order.key);
    const denied = await request(foreign, `/api/delivery/orders/${encodeURIComponent(order.key)}?locationId=28`);
    assert.equal(denied.status, 403, JSON.stringify(denied.data));
    const saved = await request(assigned, "/api/delivery/saved-orders", "POST", { locationId: 1, orderId: order.key });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal((await query("SELECT 1 FROM operator_saved_delivery_orders WHERE operator_id=$1 AND order_key=$2", [assigned.operator.id, order.key])).rowCount, 1);
  }), { seed: 20260915, numRuns: 32 });
});

test("malformed URL identifiers return 400 before confirmation changes any data", async () => {
  const order = await seed("RP-ENCODING-MALFORMED"), beforeState = await stored(order.id);
  for (const suffix of ["%", "%G0", "%C0%AF", "%E0%A4"]) {
    const result = await request(assigned, `/api/delivery/orders/VRMA%3ARP${suffix}/lines/confirm-page`, "POST", { lines: [] });
    assert.equal(result.status, 400, JSON.stringify(result.data));
  }
  assert.deepEqual(await stored(order.id), beforeState);
});

test("saved-order authorization preserves literal percent sequences supplied in JSON", async () => {
  const order = await seed("RP-ENCODING-BODY%3A-LITERAL");
  const result = await request(assigned, "/api/delivery/saved-orders", "POST", { locationId: 1, orderId: order.key });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const saved = await query("SELECT order_key FROM operator_saved_delivery_orders WHERE operator_id=$1 AND order_key=$2", [assigned.operator.id, order.key]);
  assert.equal(saved.rowCount, 1); assert.equal(saved.rows[0].order_key, order.key);
});

test("encoded saved VRMA removal checks the same stored order before deleting only its saved selection", async () => {
  const order = await seed("RP-ENCODING-SAVED%3A-LITERAL"), beforeState = await stored(order.id);
  const saved = await request(assigned, "/api/delivery/saved-orders", "POST", { locationId: 1, orderId: order.key });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const path = `/api/delivery/saved-orders/${encodeURIComponent(order.key)}`;
  const denied = await request(foreign, `${path}?locationId=28`, "DELETE");
  assert.equal(denied.status, 403, JSON.stringify(denied.data));
  assert.equal((await query("SELECT 1 FROM operator_saved_delivery_orders WHERE operator_id=$1 AND order_key=$2", [assigned.operator.id, order.key])).rowCount, 1);
  const removed = await request(assigned, `${path}?locationId=1`, "DELETE");
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal((await query("SELECT 1 FROM operator_saved_delivery_orders WHERE operator_id=$1 AND order_key=$2", [assigned.operator.id, order.key])).rowCount, 0);
  assert.deepEqual(await stored(order.id), beforeState);
});

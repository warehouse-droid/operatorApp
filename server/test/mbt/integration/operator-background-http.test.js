import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { before, after } from "node:test";
import { app } from "../../../src/server.js";
import { query, closeDb } from "../../../src/db.js";
import { createOperator, loginOperator } from "../../../src/auth-repository.js";

let server, base, owner, other, foreign;
const orderIds = [], groups = [];
const purchaseIds = [];
const bytes = Buffer.from("immutable-proof");
function manifest() { return [0, 1].map(() => ({ id: crypto.randomUUID(), sha256: crypto.createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length, mimeType: "image/jpeg" })); }
async function account(yards) {
  const username = crypto.randomUUID(), password = crypto.randomUUID();
  await createOperator({ username, password, displayName: "Photo HTTP test", role: "operator", operatorYardLocationIds: yards });
  return loginOperator(username, password);
}
async function request(actor, path, body, method = "POST") {
  const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${actor.token}`,
    "Content-Type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json" },
    ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }) });
  const contentType = response.headers.get("content-type") || "";
  return { status: response.status, contentType, body: contentType.includes("application/json") ? await response.json() : Buffer.from(await response.arrayBuffer()) };
}
async function order({ overpacked = false, pickup = false } = {}) {
  const id = 9_973_000_000 + crypto.randomInt(1_000_000);
  orderIds.push(id);
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,trandate,status,status_text,outbound_location_id,outbound_location,
    sales_order_type,customer,operator_status,local_yard_order_status,netsuite_active,fulfillment_status)
    VALUES($1,$2,current_date,'B','Pending Fulfillment',1,'3445',$3,'Photo test','packed','Packed',true,'not_fulfilled')`, [id, `SOB${id}`, pickup ? "Pick-Up" : "Delivery"]);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_type,quantity,unit,location_id,
    location,packed_sales_qty,piece_qty,packed_piece_qty,to_pcs,netsuite_active,confirmed,confirmed_at)
    VALUES($1,1,778881,'Proof fixture','InvtPart',5,'PC',1,'3445',$2,5,$2,1,true,true,now())`, [id, overpacked ? 6 : 5]);
  return id;
}
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  owner = await account([1]); other = await account([1]); foreign = await account([28]);
  server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
  if (owner) {
    await query("DELETE FROM delivery_audit_log WHERE actor_operator_id=$1", [owner.operator.id]);
    await query("DELETE FROM operator_load_records WHERE operator_id=$1", [owner.operator.id]);
    await query("DELETE FROM customer_pickup_load_records WHERE operator_id=$1", [owner.operator.id]);
    await query("DELETE FROM receiving_receipt_records WHERE operator_id=$1", [owner.operator.id]);
    await query("DELETE FROM operator_background_photos WHERE action_id IN (SELECT id FROM operator_photo_actions WHERE operator_id=$1)", [owner.operator.id]);
    await query("DELETE FROM operator_photo_actions WHERE operator_id=$1", [owner.operator.id]);
    await query("DELETE FROM dispatch_delivery_groups WHERE group_ref=ANY($1::text[])", [groups]);
    await query("DELETE FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[])", [orderIds]);
    await query("DELETE FROM sales_orders WHERE netsuite_id=ANY($1::bigint[])", [orderIds]);
    await query("DELETE FROM purchase_order_lines WHERE purchase_order_id=ANY($1::bigint[])", [purchaseIds]);
    await query("DELETE FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[])", [purchaseIds]);
  }
  await closeDb();
});

test("actual grouped Load returns with pending photos, retries once, and preserves authenticated history", async () => {
  const orders = [await order(), await order()]; const group = `GRP-PHOTO-${crypto.randomUUID()}`;
  groups.push(group);
  const plan = (await query("INSERT INTO dispatch_plans(plan_date) VALUES('2099-12-01') ON CONFLICT(plan_date) DO UPDATE SET plan_date=excluded.plan_date RETURNING id")).rows[0];
  await query("INSERT INTO dispatch_delivery_groups(group_ref,plan_id,plan_date,order_type) VALUES($1,$2,'2099-12-01','sales_order')", [group, plan.id]);
  for (const [position, id] of orders.entries()) await query("INSERT INTO dispatch_delivery_group_members(group_ref,member_order_ref,position) VALUES($1,$2,$3)", [group, `SOB${id}`, position]);
  const backgroundPhotos = manifest(), requestId = crypto.randomUUID();
  const body = { backgroundPhotos, requestId, orderType: "sales_order", locationId: 1 };
  const path = `/api/delivery/orders/${group}/load`;
  const responses = await Promise.all([request(owner, path, body), request(owner, path, body)]);
  assert.equal(responses[0].status, 200, JSON.stringify(responses[0].body));
  assert.deepEqual(responses[0], responses[1]);
  const records = (await query("SELECT photo_data_urls FROM operator_load_records WHERE order_id=ANY($1::bigint[])", [orders])).rows;
  assert.equal(records.length, 2);
  assert.ok(records.every(row => JSON.stringify(row.photo_data_urls) === JSON.stringify(backgroundPhotos.map(photo => `operator-photo://${photo.id}`))));
  const photo = backgroundPhotos[0];
  const preview = `/api/photo-upload/preview?ref=${encodeURIComponent(`operator-photo://${photo.id}`)}`;
  assert.match((await request(owner, preview, undefined, "GET")).body.toString(), /Photo upload pending/);
  assert.equal((await request(foreign, preview, undefined, "GET")).status, 403);
  assert.equal((await request(other, `/api/operator/background-photos/${photo.id}`, bytes, "PUT")).status, 404);
  assert.equal((await request(owner, `/api/operator/background-photos/${photo.id}`, Buffer.alloc(bytes.length, 1), "PUT")).status, 400);
  for (let attempt = 0; attempt < 2; attempt++) assert.equal((await request(owner, `/api/operator/background-photos/${photo.id}`, bytes, "PUT")).status, 200);
  assert.deepEqual((await request(owner, preview, undefined, "GET")).body, bytes);
  assert.equal((await request(other, `/api/operator/photo-actions/${requestId}`, undefined, "GET")).status, 404);
  assert.equal((await request(owner, path, { ...body, backgroundPhotos: manifest() })).status, 409);
});
test("invalid quantities, forged aliases and missing photos leave no reservation or local mutation", async () => {
  const id = await order({ overpacked: true }); const requestId = crypto.randomUUID();
  const result = await request(owner, `/api/delivery/orders/${id}/load`, { requestId, locationId: 1, orderType: "sales_order", backgroundPhotos: manifest() });
  assert.equal(result.status, 409);
  assert.equal((await query("SELECT count(*)::int AS n FROM operator_photo_actions WHERE id=$1", [requestId])).rows[0].n, 0);
  assert.equal((await query("SELECT count(*)::int AS n FROM operator_load_records WHERE order_id=$1", [id])).rows[0].n, 0);
  for (const photoDataUrls of [[], manifest().map(photo => `operator-photo://${photo.id}`)]) {
    assert.equal((await request(owner, `/api/delivery/orders/${id}/load`, { requestId, photoDataUrls, locationId: 1, orderType: "sales_order" })).status, 400);
  }
});
test("Customer Pickup accepts reserved proof while keeping its photo requirement", async () => {
  const id = await order({ pickup: true });
  const result = await request(owner, `/api/customer-pickup/orders/${id}/load`, { requestId: crypto.randomUUID(), backgroundPhotos: manifest().slice(0, 1), locationId: 1 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((await query("SELECT count(*)::int AS n FROM operator_load_records WHERE order_id=$1", [id])).rows[0].n, 1);
});

test("local Receiving commits reserved proof with the receipt and replays its completed result", async () => {
  const id = 9_974_000_000 + crypto.randomInt(1_000_000); purchaseIds.push(id);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,destination_location_id,netsuite_active) VALUES($1,$2,'B','Pending Receipt',1,true)", [id, `POB${id}`]);
  await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,netsuite_order_line,item_id,item_type,quantity,unit,
    location_id,netsuite_active,to_pcs,received_piece_qty,received_sales_qty,confirmed_at)
    VALUES($1,1,1,778881,'InvtPart',5,'PC',1,true,1,5,5,now())`, [id]);
  const body = { requestId: crypto.randomUUID(), backgroundPhotos: manifest(), orderType: "purchase_order", destinationLocationId: 1 };
  const path = `/api/receiving/orders/${id}/receive`;
  const result = await request(owner, path, body);
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.status, "complete");
  assert.deepEqual(await request(owner, path, body), result);
  const records = (await query("SELECT photo_data_urls FROM receiving_receipt_records WHERE order_id=$1", [id])).rows;
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].photo_data_urls, body.backgroundPhotos.map(photo => `operator-photo://${photo.id}`));
});

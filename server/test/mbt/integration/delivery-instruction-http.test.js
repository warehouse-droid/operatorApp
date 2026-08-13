import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test, { after, before } from "node:test";

import { createOperator } from "../../../src/auth-repository.js";
import { closeDb, query } from "../../../src/db.js";
import { DRIVER_PWA_CURRENT_VERSION } from "../../../src/driver-client-version.js";
import { DEFAULT_PHOTO_ARCHIVE_ROOT } from "../../../src/photo-archive-repository.js";
import { app } from "../../../src/server.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const LOGIN_FIXTURE = "delivery-instruction-http";
const USERS = Object.freeze({
  salesOne: `di-sales-one-${RUN_ID}`,
  salesTwo: `di-sales-two-${RUN_ID}`,
  dispatcher: `di-dispatch-${RUN_ID}`
});
const BASE_ID = 9_860_000_000_000 + Number.parseInt(RUN_ID.slice(0, 8), 16) * 10;
const ORDERS = Object.freeze({
  one: { id: BASE_ID + 1, ref: `DIHTTP-${RUN_ID.slice(0, 12)}-A`, yard: 1 },
  two: { id: BASE_ID + 2, ref: `DIHTTP-${RUN_ID.slice(0, 12)}-B`, yard: 28 }
});
const MEDIA_ID = crypto.randomUUID();
const DRIVER_LOGIN = `di-driver-${RUN_ID}`;
const R2_KEY = `sales/sales-delivery-instruction-media/2026/08/11/${MEDIA_ID}/proof.jpg`;
const ARCHIVE_RELATIVE_PATH = `delivery-instruction-tests/${MEDIA_ID}.jpg`;
const ARCHIVE_PATH = path.join(DEFAULT_PHOTO_ARCHIVE_ROOT, ARCHIVE_RELATIVE_PATH);
const MEDIA_BYTES = Buffer.from([0xff, 0xd8, 0x44, 0x49, 0x48, 0x54, 0x54, 0x50, 0xff, 0xd9]);

let baseUrl = "";
let server;
const tokens = new Map();

async function request(urlPath, { token = "", method = "GET", body, headers = {}, raw = false } = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = raw
    ? Buffer.from(await response.arrayBuffer())
    : await response.json().catch(() => ({}));
  return { response, payload };
}

async function loginOperator(username) {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: { username, password: LOGIN_FIXTURE }
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  return result.payload.token;
}

before(async () => {
  await Promise.all([
    createOperator({
      username: USERS.salesOne,
      displayName: "Delivery Instruction Sales Yard One",
      password: LOGIN_FIXTURE,
      role: "sales",
      yardLocationIds: [1]
    }),
    createOperator({
      username: USERS.salesTwo,
      displayName: "Delivery Instruction Sales Yard Two",
      password: LOGIN_FIXTURE,
      role: "sales",
      yardLocationIds: [28]
    }),
    createOperator({
      username: USERS.dispatcher,
      displayName: "Delivery Instruction Dispatcher",
      password: LOGIN_FIXTURE,
      role: "dispatcher"
    })
  ]);
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       order_location_id, sales_order_type, memo, netsuite_active, synced_at
     ) VALUES
       ($1,$2,current_date,'HTTP Yard One','Pending Fulfillment','Pending Fulfillment',$3,'Delivery',
        'Delivery Address: planned elsewhere\nTel: 416-555-0101\nUse rear gate.',true,now()),
       ($4,$5,current_date,'HTTP Yard Two','Pending Fulfillment','Pending Fulfillment',$6,'Delivery',
        'Call 416-555-0202.',true,now())`,
    [ORDERS.one.id, ORDERS.one.ref, ORDERS.one.yard, ORDERS.two.id, ORDERS.two.ref, ORDERS.two.yard]
  );
  await query(
    `INSERT INTO sales_order_delivery_instructions (
       sales_order_id, additional_text, revision, created_source, updated_source
     ) VALUES ($1,'Initial HTTP instruction',1,'sales','sales')`,
    [ORDERS.one.id]
  );
  await query(
    `INSERT INTO sales_order_delivery_instruction_media (
       id, sales_order_id, object_reference, media_kind, mime_type,
       original_file_name, byte_size, position, instruction_revision, uploaded_source
     ) VALUES ($1,$2,$3,'image','image/jpeg','proof.jpg',$4,1,1,'sales')`,
    [MEDIA_ID, ORDERS.one.id, `r2://${R2_KEY}`, MEDIA_BYTES.length]
  );
  await fs.mkdir(path.dirname(ARCHIVE_PATH), { recursive: true });
  await fs.writeFile(ARCHIVE_PATH, MEDIA_BYTES, { flag: "wx" });
  await query(
    `INSERT INTO photo_archive_objects (
       r2_key, local_path, content_type, byte_size, sha256, r2_deleted_at
     ) VALUES ($1,$2,'image/jpeg',$3,$4,now())`,
    [R2_KEY, ARCHIVE_RELATIVE_PATH, MEDIA_BYTES.length, crypto.createHash("sha256").update(MEDIA_BYTES).digest("hex")]
  );
  await query(
    `INSERT INTO dispatch_drivers (name, login, active)
     VALUES ('Unassigned Delivery Instruction Driver',$1,true)`,
    [DRIVER_LOGIN]
  );

  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const username of Object.values(USERS)) {
    tokens.set(username, await loginOperator(username));
  }
  const driverLogin = await request("/api/driver/login", {
    method: "POST",
    body: { login: DRIVER_LOGIN, password: "", deviceId: `device-${RUN_ID}` }
  });
  assert.equal(driverLogin.response.status, 200, JSON.stringify(driverLogin.payload));
  tokens.set(DRIVER_LOGIN, driverLogin.payload.token);
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await query("DELETE FROM delivery_audit_log WHERE order_id = ANY($1::bigint[])", [[ORDERS.one.id, ORDERS.two.id]]).catch(() => null);
  await query("DELETE FROM photo_archive_objects WHERE r2_key = $1", [R2_KEY]).catch(() => null);
  await query("DELETE FROM sales_orders WHERE netsuite_id = ANY($1::bigint[])", [[ORDERS.one.id, ORDERS.two.id]]).catch(() => null);
  await query("DELETE FROM driver_sessions WHERE lower(driver_login) = lower($1)", [DRIVER_LOGIN]).catch(() => null);
  await query("DELETE FROM dispatch_drivers WHERE lower(login) = lower($1)", [DRIVER_LOGIN]).catch(() => null);
  await query("DELETE FROM operators WHERE username = ANY($1::text[])", [Object.values(USERS)]).catch(() => null);
  await fs.unlink(ARCHIVE_PATH).catch(() => null);
  await closeDb();
});

test("Delivery Instruction APIs fail closed and Sales searches only authorized yards", async () => {
  const anonymous = await request("/api/sales/delivery-instructions/orders");
  assert.equal(anonymous.response.status, 401);

  const own = await request(`/api/sales/delivery-instructions/orders?search=${encodeURIComponent(ORDERS.one.ref)}`, {
    token: tokens.get(USERS.salesOne)
  });
  assert.equal(own.response.status, 200, JSON.stringify(own.payload));
  assert.equal(own.response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(own.payload.map((order) => order.orderRef), [ORDERS.one.ref]);

  const hiddenSearch = await request(`/api/sales/delivery-instructions/orders?search=${encodeURIComponent(ORDERS.two.ref)}`, {
    token: tokens.get(USERS.salesOne)
  });
  assert.equal(hiddenSearch.response.status, 200);
  assert.deepEqual(hiddenSearch.payload, []);

  const hiddenDetail = await request(`/api/sales/delivery-instructions/orders/${ORDERS.two.id}`, {
    token: tokens.get(USERS.salesOne)
  });
  assert.equal(hiddenDetail.response.status, 403);

  const dispatchDetail = await request(`/api/dispatch/orders/${ORDERS.two.id}/delivery-instructions`, {
    token: tokens.get(USERS.dispatcher)
  });
  assert.equal(dispatchDetail.response.status, 200, JSON.stringify(dispatchDetail.payload));
});

test("text mutation is revision-safe, no-store, and audited without changing a Dispatch plan", async () => {
  const saved = await request(`/api/sales/delivery-instructions/orders/${ORDERS.one.id}`, {
    token: tokens.get(USERS.salesOne),
    method: "PUT",
    body: { expectedRevision: 1, additionalText: "Updated through authenticated Sales HTTP." }
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.response.headers.get("cache-control"), "private, no-store");
  assert.equal(saved.payload.revision, 2);
  assert.equal(saved.payload.additionalText, "Updated through authenticated Sales HTTP.");

  const stale = await request(`/api/dispatch/orders/${ORDERS.one.id}/delivery-instructions`, {
    token: tokens.get(USERS.dispatcher),
    method: "PUT",
    body: { expectedRevision: 1, additionalText: "A stale dispatcher must not overwrite Sales." }
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.payload.code, "DELIVERY_INSTRUCTION_REVISION_CONFLICT");

  const audit = await query(
    `SELECT action, actor_operator_id, details
       FROM delivery_audit_log
      WHERE order_id = $1 AND action = 'delivery.instructions.text.updated'`,
    [ORDERS.one.id]
  );
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].details.orderRef, ORDERS.one.ref);
  assert.equal(Number(audit.rows[0].details.revision), 2);
});

test("instruction media enforces authentication, yard scope, Driver route scope, stored MIME, and byte ranges", async () => {
  const contentPath = `/api/delivery-instruction-media/${MEDIA_ID}/content`;
  const anonymous = await request(contentPath);
  assert.equal(anonymous.response.status, 401);

  const wrongYard = await request(contentPath, { token: tokens.get(USERS.salesTwo) });
  assert.equal(wrongYard.response.status, 403);

  const unassignedDriver = await request(contentPath, {
    token: tokens.get(DRIVER_LOGIN),
    headers: { "x-mbbs-driver-version": DRIVER_PWA_CURRENT_VERSION }
  });
  assert.equal(unassignedDriver.response.status, 403);

  const allowed = await request(contentPath, { token: tokens.get(USERS.salesOne), raw: true });
  assert.equal(allowed.response.status, 200);
  assert.deepEqual(allowed.payload, MEDIA_BYTES);
  assert.equal(allowed.response.headers.get("content-type"), "image/jpeg");
  assert.equal(allowed.response.headers.get("cache-control"), "private, no-store");
  assert.equal(allowed.response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(allowed.response.headers.get("cross-origin-resource-policy"), "same-origin");

  const range = await request(`${contentPath}?token=${encodeURIComponent(tokens.get(USERS.salesOne))}`, {
    headers: { range: "bytes=2-5" },
    raw: true
  });
  assert.equal(range.response.status, 206);
  assert.deepEqual(range.payload, MEDIA_BYTES.subarray(2, 6));
  assert.equal(range.response.headers.get("content-range"), `bytes 2-5/${MEDIA_BYTES.length}`);
});

test("the narrow Driver instruction endpoint still requires a current client and authenticated current drop-off", async () => {
  const staleAnonymous = await request("/api/driver/jobs/not-current/delivery-instructions");
  assert.equal(staleAnonymous.response.status, 426);
  const currentAnonymous = await request("/api/driver/jobs/not-current/delivery-instructions", {
    headers: { "x-mbbs-driver-version": DRIVER_PWA_CURRENT_VERSION }
  });
  assert.equal(currentAnonymous.response.status, 401);
  const unassigned = await request("/api/driver/jobs/not-current/delivery-instructions", {
    token: tokens.get(DRIVER_LOGIN),
    headers: { "x-mbbs-driver-version": DRIVER_PWA_CURRENT_VERSION }
  });
  assert.equal(unassigned.response.status, 404);
});

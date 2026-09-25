/* global window, localStorage, selectedOrder, selectedId, currentModule, viewMode, render,
 fulfillmentPhotoDataUrls, fulfillmentActivePhotoSlot, fulfillmentSubmitting, fulfillmentResult */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import http from "node:http";
import { chromium, expect } from "@playwright/test";
import { app } from "../src/server.js";
import { query, closeDb } from "../src/db.js";
import { createOperator, loginOperator } from "../src/auth-repository.js";
import { config } from "../src/config.js";
import { describeIsolatedTestDatabase } from "../test/support/test-database-isolation.mjs";

describeIsolatedTestDatabase(process.env.DATABASE_URL);
const folder = "test-artifacts/local-load-performance/replay";
const snapshot = JSON.parse(readFileSync(`${folder}/orders.json`, "utf8"));
const photoFixture = JSON.parse(readFileSync(`${folder}/photos-private.json`, "utf8"));
const runName = process.env.LOCAL_LOAD_REPLAY_RUN || "deployed-normal";
const groupId = snapshot.group.group_ref;
const timings = [], screens = [], requests = [], errors = [], uploadedKeys = [];
let browser, server, photoServer, startedAt;
const elapsed = () => startedAt ? Number((performance.now() - startedAt).toFixed(2)) : 0;

async function insertRow(table, row) {
  const columns = (await query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", [table])).rows.map(value => value.column_name);
  const names = Object.keys(row).filter(name => columns.includes(name));
  await query(`INSERT INTO ${table} (${names.map(name => `"${name}"`).join(",")}) VALUES (${names.map((_, index) => `$${index + 1}`).join(",")})`,
    names.map(name => row[name] !== null && typeof row[name] === "object" ? JSON.stringify(row[name]) : row[name]));
}

async function seed() {
  // No production operator/session or integrations are copied.
  const username = `load-replay-${crypto.randomUUID()}`, password = crypto.randomUUID();
  await createOperator({ username, password, displayName: "Isolated load replay", role: "operator", yardLocationIds: [1], operatorYardLocationIds: [1] });
  const session = await loginOperator(username, password);
  await insertRow("dispatch_plans", snapshot.plan);
  for (const order of snapshot.orders) {
    await insertRow("sales_orders", { ...order, dispatch_instruction_details: {}, operator_status: "packed", local_yard_order_status: "Packed",
      preparing_operator_id: null, preparing_started_at: null });
  }
  for (const line of snapshot.lines) {
    const loaded = Number(line.loaded_qty || 0), pickable = ["InvtPart", "NonInvtPart"].includes(line.item_type);
    const hasConversion = ["to_plt", "to_lyr", "to_sec", "to_pcs"].some(key => Number(line[key]) > 0);
    await insertRow("sales_order_lines", { ...line, loaded_qty: 0,
      packed_pallet_qty: pickable ? Number(line.pallet_qty || 0) : 0,
      packed_layer_qty: pickable ? Number(line.layer_qty || 0) : 0,
      packed_section_qty: pickable ? Number(line.section_qty || 0) : 0,
      packed_piece_qty: pickable ? Number(line.piece_qty || 0) : 0,
      packed_sales_qty: pickable && !hasConversion ? loaded : 0,
      confirmed: pickable, confirmed_at: pickable ? new Date().toISOString() : null });
  }
  await insertRow("dispatch_delivery_groups", snapshot.group);
  for (const member of snapshot.members) {await insertRow("dispatch_delivery_group_members", member);}
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,netsuite_active)
    SELECT 997000000+n,'PERF-SO-'||n,true FROM generate_series(1,13000) n`);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_description,item_type,
    quantity,unit,netsuite_active,packed_sales_qty,sync_exception)
    SELECT 997000001+(n%13000),n,1784,'Unrelated cargo',repeat('Unrelated cargo ',12),'InvtPart',20,'PC',true,5,'unrelated'
    FROM generate_series(1,30000) n`);
  await query(`INSERT INTO transfer_orders(netsuite_id,tranid,from_location_id,netsuite_active)
    SELECT 996000000+n,'PERF-TO-'||n,1,true FROM generate_series(1,2000) n`);
  await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_id,line_stage,item_id,item_name,item_description,
    item_type,quantity,unit,netsuite_active,packed_sales_qty,sync_exception)
    SELECT 996000001+(n%2000),n,CASE WHEN n%2=0 THEN 'outbound' ELSE 'inbound' END,1784,'Unrelated transfer',
    repeat('Unrelated cargo ',12),'InvtPart',20,'PC',true,5,'unrelated' FROM generate_series(1,6800) n`);
  for (const table of ["sales_orders", "sales_order_lines", "transfer_orders", "transfer_order_lines"]) {await query(`ANALYZE ${table}`);}
  return session;
}

try {
  const session = await seed();
  photoServer = http.createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    if (request.method === "OPTIONS") {response.writeHead(204).end(); return;}
    if (request.method !== "POST" || request.url !== "/upload") {response.writeHead(404).end(); return;}
    let byteSize = 0;
    request.on("data", chunk => {byteSize += chunk.length;});
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ key: `test-only/load-replay/${crypto.randomUUID()}.jpg`, byteSize }));
    });
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => photoServer.once("listening", resolve));
  config.photoUpload = { ...config.photoUpload, workerUrl: `http://127.0.0.1:${photoServer.address().port}`,
    tokenSecret: "isolated-photo-ticket-placeholder" };
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, serviceWorkers: "block",
    recordVideo: { dir: `${folder}/video-${runName}`, size: { width: 1024, height: 768 } } });
  // All application/auth/database calls are real; external photo storage is
  // replaced by a local service. Never send the copied evidence off the host.
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1") {await route.abort(); return;}
    await route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  const begins = new Map();
  page.on("request", request => {
    if (startedAt) {begins.set(request, { start: performance.now(), atMs: elapsed(), method: request.method(), path: new URL(request.url()).pathname });}
  });
  page.on("requestfinished", async request => {
    const start = begins.get(request);
    if (!start) {return;}
    const response = await request.response();
    const entry = { atMs: start.atMs, method: start.method, path: start.path,
      durationMs: Number((performance.now() - start.start).toFixed(2)), status: response?.status() };
    requests.push(entry);
    if (start.path === "/upload" && response?.ok()) {
      try {uploadedKeys.push((await response.json()).key);} catch { /* Recorded as a failed upload by the real UI. */ }
    }
  });
  await page.addInitScript(({ token, accountId, sessionKey }) => {
    localStorage.setItem("mbbs.staff.token", token);
    localStorage.setItem("mbbs.operator.token", token);
    localStorage.setItem("mbbs.operator.locationId", "1");
    localStorage.setItem("mbbs.ui.language", "en");
    localStorage.setItem("mbbs.operator.state", JSON.stringify({ locationId: 1, currentModule: "delivery", viewMode: "packed",
      accountId, sessionKey }));
  }, { token: session.token, accountId: session.operator.id, sessionKey: crypto.createHash("sha256").update(session.token).digest("hex") });
  await page.goto(`${base}/operator`);
  await page.waitForFunction(() => typeof render === "function" && document.querySelector("[data-action='logout']"));
  // Select the exact group through the real API, preserving its full data.
  await page.evaluate(async id => {
    selectedOrder = await api(`/api/delivery/orders/${id}`);
    selectedId = id;
    currentModule = "delivery";
    viewMode = "packed";
    render();
  }, groupId);
  await page.locator('[data-action="start-fulfill"]').click();
  await expect(page.locator('[data-action="confirm-fulfill"]')).toBeVisible();
  // These are the actual two photo bytes already taken by the operator.
  await page.evaluate(photos => {
    fulfillmentPhotoDataUrls = photos;
    fulfillmentActivePhotoSlot = 0;
    render();
  }, photoFixture.photos.map(photo => photo.dataUrl));
  await page.screenshot({ path: `${folder}/${runName}-before.png`, fullPage: true });
  const uploadKbps = Number(process.env.LOCAL_LOAD_REPLAY_UPLOAD_KBPS || 0);
  if (uploadKbps) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 50, downloadThroughput: 12500000,
      uploadThroughput: uploadKbps * 1000 / 8 });
  }
  startedAt = performance.now();
  await page.locator('[data-action="confirm-fulfill"]').click();
  for (let sample = 0; sample < 180; sample += 1) {
    const state = await page.evaluate(() => ({ submitting: fulfillmentSubmitting, done: Boolean(fulfillmentResult),
      stage: document.querySelector(".selected-actions .sync-alert")?.innerText || "",
      result: document.querySelector(".fulfillment-card.success")?.innerText || "" }));
    screens.push({ atMs: elapsed(), ...state });
    if ([0, 5, 15, 30, 60].includes(sample)) {await page.screenshot({ path: `${folder}/${runName}-${sample}s.png`, fullPage: true });}
    if (state.done || !state.submitting) {break;}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const totalMs = elapsed();
  await page.screenshot({ path: `${folder}/${runName}-after.png`, fullPage: true });
  const state = await page.evaluate(() => ({ result: fulfillmentResult, submitting: fulfillmentSubmitting }));
  const rows = (await query("SELECT order_id,order_ref,jsonb_array_length(photo_data_urls) AS photos FROM operator_load_records WHERE order_id=ANY($1::bigint[]) ORDER BY order_id", [snapshot.orders.map(row => row.netsuite_id)])).rows;
  timings.push({ totalMs, uploadKbps, photoService: "local test substitute", photoBytes: photoFixture.photos.map(photo => photo.byteSize), result: state.result,
    records: rows, productionDataWritten: false });
  assert.ok(state.result, `Load did not complete: ${JSON.stringify(screens.at(-1))}`);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.photos === 2));
  assert.deepEqual(errors, []);
  await context.close();
} finally {
  writeFileSync(`${folder}/${runName}.json`, JSON.stringify({ timings, screens, requests, errors, uploadedKeys }, null, 2));
  console.log(JSON.stringify({ runName, timings, screens, requests, errors, diagnosticPhotoObjects: uploadedKeys.length }));
  await browser?.close();
  if (server) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
  if (photoServer) {photoServer.closeAllConnections(); await new Promise(resolve => photoServer.close(resolve));}
  await closeDb();
}

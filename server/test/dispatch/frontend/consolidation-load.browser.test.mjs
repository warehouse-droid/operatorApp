import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { before, after } from "node:test";
import { chromium, webkit } from "playwright";

let server, base;
before(async () => {
  server = createServer(async (req, res) => {
    const name = new URL(req.url, "http://test").pathname;
    const file = name === "/operator" ? "operator.html" : name.slice(1);
    if (file.includes("..")) return res.writeHead(404).end();
    try {
      const bytes = await readFile(path.resolve("public", file));
      res.writeHead(200, { "content-type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(file)] || "application/octet-stream" }).end(bytes);
    }
    catch { res.writeHead(404).end(); }
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); });
const assignment = { planId: "7", loadId: "load-7", planDate: "2026-09-10", truckPlate: "TRUCK-A", sequence: 2, loadName: "Load 2" };
const packed = { id: "line-1", item_id: "99", item_name: "Paver", packed_pallet_qty: 3, packed_layer_qty: 2, to_plt: 100, to_lyr: 10 };
const first = { netsuite_id: "11", tranid: "SOB12345", order_type: "sales_order", assignment, lines: [packed, { ...packed, id: "line-2", packed_pallet_qty: 1, packed_layer_qty: 0 }] };
const second = { netsuite_id: "12", tranid: "SOV02222", order_type: "sales_order", assignment, lines: [
  { id: "line-3", item_id: "98", item_name: "Bag", packed_sales_qty: 12, unit: "EA" },
  { id: "pallet-line", item_id: "1784", item_name: "PALLET", sku: "PALLET", packed_sales_qty: 4, unit: "EACH" }
] };
const third = { netsuite_id: "13", tranid: "SOM11111", order_type: "sales_order", assignment: { ...assignment, loadId: "other-load", truckPlate: "TRUCK-B" } };
const id = "7f0a2c64-e613-44aa-a008-1302cd501f81";

async function browserCoverage(context, page, enabled = true) {
  if (!enabled || process.env.CONSOLIDATION_BROWSER_COVERAGE !== "1") return async () => {};
  const profiler = await context.newCDPSession(page);
  await profiler.send("Profiler.enable");
  await profiler.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  return async () => {
    const { result } = await profiler.send("Profiler.takePreciseCoverage");
    const directory = "test-artifacts/consolidation-load/coverage-tmp";
    await mkdir(directory, { recursive: true });
    const scripts = result.filter((entry) => /\/(operator(?:-load-summary)?|i18n)\.js(?:\?|$)/.test(entry.url))
      .map((entry) => ({ ...entry, url: `file:///app/public${new URL(entry.url).pathname}` }));
    await writeFile(`${directory}/coverage-browser-${randomUUID()}.json`, JSON.stringify({ result: scripts }));
  };
}

for (const [name, engine, viewport] of [["desktop Chromium", chromium, { width: 1200, height: 900 }], ["mobile Chromium", chromium, { width: 390, height: 844 }], ["mobile WebKit", webkit, { width: 390, height: 844 }]]) {
  test(`${name}: select one truck load, retain filters on refresh, preview compact quantities and save shared evidence`, async () => {
    const browser = await engine.launch({ headless: true, args: engine === chromium ? ["--no-sandbox"] : [] });
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    const page = await context.newPage();
    const captureCoverage = await browserCoverage(context, page, engine === chromium);
    await page.clock.setSystemTime(new Date("2026-09-10T16:00:00Z"));
    page.setDefaultTimeout(6000);
    const calls = [], errors = [];
    const planned = [first, second].map((order, index) => ({ ...order,
      netsuite_id: ["986223", "986352"][index], tranid: ["SOB119935", "SOB119962"][index],
      operator_status: "packed", underpack_count: 1, dispatch_planned: true,
      expected_delivery_date: "2026-09-10T00:00:00.000Z", dispatch_plan_date: "2026-09-10T00:00:00.000Z",
      dispatch_truck_plate: "TRUCK-A", dispatch_load_name: "Load 2" }));
    let revision = 0, failPreview = true;
    let batch = { id, locationId: 1, status: "draft", photoRefs: [], snapshot: { assignment, orders: [first, second] } };
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("mbbs.staff.token", "consolidation-browser-test");
      window.EventSource = class { constructor() { window.consolidationTestEvents = this; this.listeners = {}; } addEventListener(name, callback) { this.listeners[name] = callback; } close() {} };
    });
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      calls.push({ path: url.pathname, body: route.request().postDataJSON() });
      let data = [];
      if (url.pathname === "/api/auth/me") data = { operator: { id: "consolidation-test", display_name: "Operator", role: "operator", roles: ["operator"], operatorYardLocationIds: [1] } };
      else if (url.pathname === "/api/delivery/bootstrap") data = { orders: { salesOrder: planned }, notifications: { total: 0, items: [], salesOrder: {}, transferOrder: {} } };
      else if (url.pathname.startsWith("/api/delivery/orders/")) data = planned.find((order) => url.pathname.endsWith(`/${order.netsuite_id}`));
      else if (url.pathname === "/api/delivery/orders") data = url.searchParams.get("orderType") === "sales_order" ? planned : [];
      else if (url.pathname.endsWith("/notifications")) data = { total: 0, items: [], salesOrder: {}, transferOrder: {} };
      else if (url.pathname.endsWith("/current-draft")) data = null;
      else if (url.pathname.endsWith("/consolidation-loads/orders")) data = { orders: [{ ...first, customer: `Customer ${revision++}` }, second, third], dates: [assignment.planDate], trucks: ["TRUCK-A", "TRUCK-B"] };
      else if (url.pathname.endsWith("/consolidation-loads/preview")) {
        if (failPreview) { failPreview = false; return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Packed order changed; review selection" }) }); }
        data = batch;
      }
      else if (url.pathname.endsWith(`/${id}/submit`)) { batch = { ...batch, status: "completed", photoRefs: route.request().postDataJSON().photoRefs, result: { localYardOrderStatus: "Loaded" } }; data = batch; }
      else if (url.pathname.endsWith(`/${id}`)) data = batch;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    try {
      await page.goto(`${base}/operator`);
      await page.locator('[data-action="open-module"][data-module="delivery"]').click();
      await page.locator('[data-action="select-delivery-type"]').click();
      for (const order of planned) {
        const card = page.locator(`.order-card[data-order="${order.netsuite_id}"]`);
        await card.waitFor();
        assert.match(await card.locator(".planned-line").innerText(), /10-Sep/);
        assert.match(await card.locator(".order-schedule-line").innerText(), /10-Sep/);
        assert.doesNotMatch(await card.innerText(), /09-Sep/);
      }
      await page.getByRole("button", { name: "Consolidation Load", exact: false }).click();
      assert.match(await page.locator('[data-consolidation-order="11"]').locator("..").innerText(), /2026-09-10/);
      await page.locator('[data-consolidation-order="11"]').check();
      await page.locator('[data-consolidation-order="11"]').uncheck();
      assert.equal(await page.locator('[data-consolidation-order="13"]').isDisabled(), false);
      await page.locator('[data-consolidation-order="11"]').check();
      await page.locator('[data-consolidation-order="12"]').check();
      assert.equal(await page.locator('[data-consolidation-order="13"]').isDisabled(), true);
      await page.selectOption('[data-input="consolidation-load-truck"]', "TRUCK-A");
      await page.locator('[data-consolidation-order="11"]').focus();
      await page.evaluate(() => window.consolidationTestEvents.listeners["app-event"]({ data: JSON.stringify({ type: "delivery.order.updated", payload: {} }) }));
      await page.waitForTimeout(900);
      assert.equal(await page.locator('[data-input="consolidation-load-truck"]').inputValue(), "TRUCK-A");
      assert.equal(await page.locator('[data-consolidation-order="11"]').isChecked(), true);
      assert.equal(await page.locator('[data-consolidation-order="11"]').evaluate((element) => document.activeElement === element), true);
      await page.locator('[data-action="preview-consolidation-load"]').click();
      await page.getByText("Packed order changed; review selection", { exact: true }).waitFor();
      assert.equal(await page.locator('[data-consolidation-order="11"]').isChecked(), true);
      await page.locator('[data-action="preview-consolidation-load"]').click();
      await page.locator(".consolidation-load-summary").waitFor();
      const summary = await page.locator(".consolidation-load-summary").innerText();
      assert.match(summary, /SOB12345[\s\S]*Paver[\s\S]*4 plt 2 lyr/);
      assert.match(summary, /SOV02222[\s\S]*Bag[\s\S]*12 EA/);
      assert.match(summary, /PALLET[\s\S]*4 EACH/);
      assert.doesNotMatch(summary, /4 PALLET/);
      assert.doesNotMatch(summary, /0 plt|0 lyr|0 sec|0 pcs|Remaining/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      await mkdir("test-artifacts/consolidation-load/screenshots", { recursive: true });
      await page.screenshot({ path: `test-artifacts/consolidation-load/screenshots/${name.replaceAll(" ", "-")}-preview.png`, fullPage: true });
      // Camera and object-storage boundaries: completed captures are supplied as
      // uploaded references; all selection, formatting and submission code is real.
      await page.evaluate((batchId) => {
        fulfillmentPhotoDataUrls = [1, 2].map((n) => `r2://operator/operator-consolidation-load-photo/2026/09/15/${batchId}/photo-${n}.jpg`);
        render();
      }, id);
      await page.locator('[data-action="confirm-fulfill"]').click();
      await page.getByRole("heading", { name: "Load Complete", exact: true }).waitFor();
      const submitted = calls.filter((call) => call.path.endsWith("/submit"));
      assert.equal(submitted.length, 1);
      assert.equal(submitted[0].body.photoRefs.length, 2);
      assert.equal(calls.some((call) => call.path.includes("netsuite-posting") || /\/orders\/[^/]+\/(load|fulfill)$/.test(call.path)), false);
      assert.deepEqual(errors, []);
    } finally { await captureCoverage(); await context.close(); await browser.close(); }
  });
}

test("camera captures survive updates and submission retry without R2; a pending load resumes after refresh", async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const captureCoverage = await browserCoverage(context, page);
  await page.clock.setSystemTime(new Date("2026-09-10T16:00:00Z"));
  page.setDefaultTimeout(6000);
  let batch = { id, locationId: 1, status: "draft", photoRefs: [], snapshot: { assignment, orders: [first, second] } };
  const uploads = [], submits = [], errors = [];
  let failUpload = true, failSubmit = true, ticket = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("mbbs.staff.token", "consolidation-browser-test");
    window.EventSource = class { constructor() { window.consolidationTestEvents = this; this.listeners = {}; } addEventListener(name, callback) { this.listeners[name] = callback; } close() {} };
    const track = { stop() {}, getSettings: () => ({}), getCapabilities: () => ({}), applyConstraints: async () => {} };
    const stream = new MediaStream();
    stream.getTracks = stream.getVideoTracks = () => [track];
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { enumerateDevices: async () => [], getUserMedia: async () => stream } });
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 1280 });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 720 });
    HTMLMediaElement.prototype.play = async () => {};
    let capture = 0;
    window.ImageCapture = class { async takePhoto() { return new Blob([new Uint8Array([255, 216, ++capture, 255, 217])], { type: "image/jpeg" }); } };
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let data = [];
    if (url.pathname === "/api/auth/me") data = { operator: { id: "consolidation-test", display_name: "Operator", role: "operator", roles: ["operator"], operatorYardLocationIds: [1] } };
    else if (url.pathname.endsWith("/notifications")) data = { total: 0, items: [], salesOrder: {}, transferOrder: {} };
    else if (url.pathname.endsWith("/current-draft")) data = null;
    else if (url.pathname.endsWith("/consolidation-loads/orders")) data = { orders: [first, second, third] };
    else if (url.pathname.endsWith("/consolidation-loads/preview")) data = batch;
    else if (url.pathname.endsWith("/consolidation-loads/pending")) data = batch.status === "pending" ? [batch] : [];
    else if (url.pathname.endsWith("/photo-upload-token")) {
      const body = route.request().postDataJSON();
      assert.equal(body.recordType, "operator-consolidation-load-photo");
      assert.equal(body.orderRef, id);
      data = { uploadUrl: `${base}/api/test-photo/${++ticket}`, token: "test-upload" };
    } else if (url.pathname.includes("/test-photo/")) {
      const n = Number(url.pathname.split("/").at(-1));
      uploads.push(n);
      if (n === 2 && failUpload) { failUpload = false; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary upload failure" }) }); }
      data = { key: `operator/operator-consolidation-load-photo/2026/09/15/${id}/photo-${n}.jpg` };
    } else if (url.pathname.endsWith(`/${id}/submit`)) {
      submits.push(route.request().postDataJSON());
      if (failSubmit) { failSubmit = false; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary submission failure" }) }); }
      batch = { ...batch, status: "pending", photoRefs: submits[0].photoRefs, error: "Second order needs retry" }; data = batch;
    } else if (url.pathname.endsWith(`/${id}/resume`)) { batch = { ...batch, status: "completed", error: "", result: { localYardOrderStatus: "Loaded" } }; data = batch; }
    else if (url.pathname.endsWith(`/${id}`)) data = batch;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
  });
  try {
    await page.goto(`${base}/operator`);
    await page.locator('[data-action="open-module"][data-module="delivery"]').click();
    await page.getByRole("button", { name: "Consolidation Load", exact: false }).click();
    await page.locator('[data-consolidation-order="11"]').check();
    await page.locator('[data-consolidation-order="12"]').check();
    await page.locator('[data-action="preview-consolidation-load"]').click();
    assert.equal(await page.locator('[data-action="confirm-fulfill"]').isDisabled(), true);
    await page.locator("#fulfillmentCamera").waitFor();
    await page.locator('[data-action="capture-photo"]').click();
    assert.equal(await page.locator('[data-action="confirm-fulfill"]').isDisabled(), true);
    await page.locator('[data-action="capture-photo"]').click();
    await page.locator('[data-action="stop-camera"]').click();
    const captures = await page.evaluate(() => [...fulfillmentPhotoDataUrls]);
    await page.evaluate(() => window.consolidationTestEvents.listeners["app-event"]({ data: JSON.stringify({ type: "delivery.order.updated", payload: {} }) }));
    await page.waitForTimeout(900);
    assert.deepEqual(await page.evaluate(() => [...fulfillmentPhotoDataUrls]), captures);
    await page.locator('[data-action="confirm-fulfill"]').click();
    await page.getByText("Load failed", { exact: true }).waitFor();
    assert.equal(submits.length, 1);
    assert.deepEqual(submits[0].photoRefs, captures);
    await page.locator('[data-action="confirm-fulfill"]').click();
    await page.getByRole("heading", { name: "Pending load", exact: true }).waitFor();
    assert.equal(uploads.length, 0, "R2 uploads run on the server after completion");
    assert.equal(ticket, 0);
    assert.deepEqual(submits[1].photoRefs, captures);
    batch = { ...batch, error: "Retry is available" };
    await page.evaluate(() => window.consolidationTestEvents.listeners["app-event"]({ data: JSON.stringify({ type: "delivery.order.updated", payload: {} }) }));
    await page.getByText("Retry is available", { exact: true }).waitFor();
    await captureCoverage();
    await page.reload();
    await page.getByRole("heading", { name: "Pending load", exact: true }).waitFor();
    assert.equal(await page.locator(".consolidation-load-photos img").count(), 2);
    await page.locator('[data-action="retry-consolidation-load"]').click();
    await page.getByRole("heading", { name: "Load Complete", exact: true }).waitFor();
    assert.equal(uploads.length, 0);
    assert.equal(submits.length, 2);
    await page.locator('[data-action="finish-fulfill"]').first().click();
    await page.locator(".consolidation-load-orders").waitFor();
    assert.equal(await page.locator('[data-consolidation-order="11"]').isChecked(), false);
    await page.locator('[data-action="consolidation-load-back"]').click();
    await page.locator('[data-action="select-delivery-type"]').click();
    await page.locator('[data-action="open-consolidation-load"]').click();
    await page.locator(".consolidation-load-orders").waitFor();
    await page.locator('[data-consolidation-date-part="day"]').click();
    await page.locator('[data-consolidation-date-option="16"][data-date-part="day"]').click();
    assert.equal(await page.locator('[data-consolidation-order="11"]').count(), 0);
    await page.locator('[data-action="reset-consolidation-load-filters"]').click();
    await page.locator('[data-consolidation-order="11"]').check();
    await page.locator('[data-action="clear-consolidation-load"]').click();
    assert.equal(await page.locator('[data-consolidation-order="11"]').isChecked(), false);
    assert.deepEqual(errors, []);
  } finally { await captureCoverage(); await context.close(); await browser.close(); }
});

test("a late completed load response cannot overwrite a newly opened preview", async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ serviceWorkers: "block" }), page = await context.newPage();
  const captureCoverage = await browserCoverage(context, page);
  await page.clock.setSystemTime(new Date("2026-09-10T16:00:00Z"));
  page.setDefaultTimeout(6000);
  const nextId = "8f0a2c64-e613-44aa-a008-1302cd501f81";
  const firstBatch = { id, locationId: 1, status: "draft", photoRefs: [], snapshot: { assignment, orders: [first] } };
  const nextBatch = { ...firstBatch, id: nextId, snapshot: { assignment: third.assignment, orders: [{ ...third, lines: [packed] }] } };
  let previewCount = 0, release;
  const delayed = new Promise((resolve) => { release = resolve; });
  await page.addInitScript(() => {
    localStorage.setItem("mbbs.staff.token", "test-consolidation-browser");
    window.EventSource = class { addEventListener() {} close() {} };
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let data = [];
    if (url.pathname === "/api/auth/me") data = { operator: { id: "consolidation-test", display_name: "Operator", role: "operator", roles: ["operator"], operatorYardLocationIds: [1] } };
    else if (url.pathname.endsWith("/notifications")) data = { total: 0, items: [], salesOrder: {}, transferOrder: {} };
    else if (url.pathname.endsWith("/current-draft")) data = null;
    else if (url.pathname.endsWith("/consolidation-loads/orders")) data = { orders: [first, third] };
    else if (url.pathname.endsWith("/consolidation-loads/preview")) data = ++previewCount === 1 ? firstBatch : nextBatch;
    else if (url.pathname.endsWith(`/${id}/submit`)) { await delayed; data = { ...firstBatch, status: "completed", result: { localYardOrderStatus: "Loaded" } }; }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
  });
  try {
    await page.goto(`${base}/operator`);
    await page.locator('[data-action="open-module"][data-module="delivery"]').click();
    await page.locator('[data-action="open-consolidation-load"]').click();
    await page.locator('[data-consolidation-order="11"]').check();
    await page.locator('[data-action="preview-consolidation-load"]').click();
    await page.locator(".consolidation-load-summary").waitFor();
    await page.evaluate((batchId) => { fulfillmentPhotoDataUrls = [1, 2].map((n) => `r2://operator/operator-consolidation-load-photo/2026/09/15/${batchId}/${n}.jpg`); render(); }, id);
    const sent = page.waitForRequest((request) => request.url().endsWith(`/${id}/submit`));
    await page.locator('[data-action="confirm-fulfill"]').click(); await sent;
    await page.locator('[data-action="cancel-fulfill"]').click();
    await page.locator('[data-action="clear-consolidation-load"]').click();
    await page.locator('[data-consolidation-order="13"]').check();
    await page.locator('[data-action="preview-consolidation-load"]').click();
    await page.getByRole("rowheader", { name: "SOM11111", exact: true }).waitFor();
    release();
    await page.waitForTimeout(500);
    assert.equal(await page.getByRole("heading", { name: "Load Complete", exact: true }).count(), 0);
    assert.equal(await page.getByRole("rowheader", { name: "SOM11111", exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => consolidationLoadState.batch.id), nextId);
  } finally { release(); await captureCoverage(); await context.close(); await browser.close(); }
});

for (const [name, engine, mobile] of [["desktop", chromium, false], ["touch", webkit, true]]) {
  test(`${name}: five-row pagination retains selection; quick dates and dropdown/numeric dates filter correctly`, async () => {
    const browser = await engine.launch({ headless: true, args: engine === chromium ? ["--no-sandbox"] : [] });
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1200, height: 900 }, hasTouch: mobile, isMobile: mobile, serviceWorkers: "block" });
    const page = await context.newPage();
    await page.clock.setSystemTime(new Date("2026-09-17T01:00:00Z")); // Still Sep-16 in Toronto.
    page.setDefaultTimeout(6000);
    const makeOrder = (number, date, truck = "TRUCK-A") => ({ ...first, netsuite_id: String(number), tranid: `ORDER-${number}`,
      assignment: { ...assignment, planDate: date, truckPlate: truck, loadId: `${date}-${truck}` } });
    let available = [...Array.from({ length: 12 }, (_, i) => makeOrder(100 + i, "2026-09-16")),
      ...Array.from({ length: 3 }, (_, i) => makeOrder(200 + i, "2026-09-17", "TRUCK-B")),
      makeOrder(300, "2026-09-15"), makeOrder(301, "2026-09-18")];
    const errors = [], previews = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("mbbs.staff.token", "consolidation-pagination-test");
      window.EventSource = class { constructor() { window.consolidationTestEvents = this; this.listeners = {}; } addEventListener(name, callback) { this.listeners[name] = callback; } close() {} };
    });
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      let data = [];
      if (url.pathname === "/api/auth/me") data = { operator: { id: "pagination-test", display_name: "Operator", roles: ["operator"], role: "operator", operatorYardLocationIds: [1] } };
      else if (url.pathname.endsWith("/notifications")) data = { total: 0, items: [], salesOrder: {}, transferOrder: {} };
      else if (url.pathname.endsWith("/current-draft")) data = null;
      else if (url.pathname.endsWith("/consolidation-loads/orders")) data = { orders: available };
      else if (url.pathname.endsWith("/consolidation-loads/preview")) {
        const body = route.request().postDataJSON(); previews.push(body);
        const selected = available.filter((order) => body.orderIds.includes(order.netsuite_id));
        data = { id, locationId: 1, status: "draft", photoRefs: [], snapshot: { assignment: selected[0].assignment, orders: selected } };
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    const tap = async (locator) => mobile ? locator.tap() : locator.click();
    const input = (part) => page.locator(`[data-consolidation-date-part="${part}"]`);
    const typePart = async (part, value) => {
      const field = input(part);
      await tap(field);
      assert.equal(await field.getAttribute("aria-expanded"), "true");
      assert.equal(await field.evaluate((element) => element.readOnly), true);
      await tap(field);
      assert.equal(await field.getAttribute("aria-expanded"), "false");
      assert.equal(await field.evaluate((element) => !element.readOnly && element.inputMode === "numeric" && document.activeElement === element), true);
      await field.fill(value); await field.press("Enter");
    };
    const refresh = async () => page.evaluate(() => window.consolidationTestEvents.listeners["app-event"]({ data: JSON.stringify({ type: "delivery.order.updated", payload: {} }) }));
    try {
      await page.goto(`${base}/operator`);
      await page.locator('[data-action="open-module"][data-module="delivery"]').click();
      await page.locator('[data-action="open-consolidation-load"]').click();
      await page.locator('[data-consolidation-order="100"]').waitFor();
      assert.equal(await page.locator(".consolidation-load-order").count(), 5);
      assert.equal(await page.locator('[data-preset="both"]').getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator(".consolidation-load-date-range").innerText(), "2026-09-16 – 2026-09-17");
      assert.equal(await page.locator(".consolidation-load-pagination strong").innerText(), "1 / 3");
      assert.equal(await page.locator('[data-action="consolidation-load-prev"]').isDisabled(), true);
      await mkdir("test-artifacts/consolidation-pagination", { recursive: true });
      await page.screenshot({ path: `test-artifacts/consolidation-pagination/${name}-page.png`, fullPage: true });
      await page.locator(".consolidation-load-pagination").scrollIntoViewIfNeeded();
      assert.equal(await page.locator(".consolidation-load-orders").evaluate((element) => element.scrollHeight > element.clientHeight), false);
      assert.equal(await page.locator('[data-action="consolidation-load-next"]').evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }), true, "The page controls must stay visible above the selection tray.");
      await page.screenshot({ path: `test-artifacts/consolidation-pagination/${name}-pagination.png`, fullPage: true });
      await page.locator('[data-consolidation-order="100"]').check();
      await page.locator('[data-action="consolidation-load-next"]').click();
      await page.locator('[data-consolidation-order="105"]').check();
      await page.locator('[data-action="consolidation-load-next"]').click();
      await page.locator('[data-consolidation-order="110"]').check();
      assert.equal(await page.locator(".consolidation-load-order").count(), 5);
      assert.equal(await page.locator('[data-action="consolidation-load-next"]').isDisabled(), true);
      assert.equal(await page.locator('[data-consolidation-order="200"]').isDisabled(), true);
      await page.reload();
      await page.locator('[data-consolidation-order="110"]').waitFor();
      assert.equal(await page.locator(".consolidation-load-pagination strong").innerText(), "3 / 3");
      assert.equal(await page.locator('[data-consolidation-order="110"]').isChecked(), true);
      await page.locator('[data-action="consolidation-load-prev"]').click();
      assert.equal(await page.locator('[data-consolidation-order="105"]').isChecked(), true);
      await page.locator('[data-action="consolidation-load-prev"]').click();
      assert.equal(await page.locator('[data-consolidation-order="100"]').isChecked(), true);
      await page.locator('[data-action="preview-consolidation-load"]').click();
      await page.locator(".consolidation-load-summary").waitFor();
      assert.deepEqual(previews[0].orderIds, ["100", "105", "110"]);
      await page.locator('[data-action="cancel-fulfill"]').click();
      await page.locator('[data-action="clear-consolidation-load"]').click();
      await page.locator('[data-preset="today"]').click();
      assert.equal(await page.locator(".consolidation-load-pagination small").innerText(), "12 Orders");
      await page.locator('[data-preset="tomorrow"]').click();
      assert.equal(await page.locator(".consolidation-load-order").count(), 3);
      assert.equal(await page.locator(".consolidation-load-pagination strong").innerText(), "1 / 1");
      await page.locator('[data-preset="both"]').click();
      await tap(input("day"));
      await page.screenshot({ path: `test-artifacts/consolidation-pagination/${name}-dropdown.png`, fullPage: true });
      await tap(page.locator('[data-consolidation-date-option="18"][data-date-part="day"]'));
      assert.equal(await page.locator('[data-consolidation-order="301"]').count(), 1);
      assert.equal(await page.locator('[data-preset][aria-pressed="true"]').count(), 0);
      await tap(input("year")); await tap(input("year"));
      await input("year").fill("20");
      await refresh(); await page.waitForTimeout(900);
      assert.equal(await input("year").inputValue(), "20");
      assert.equal(await input("year").evaluate((element) => !element.readOnly && document.activeElement === element), true);
      await input("year").fill("2028"); await input("year").press("Enter");
      await typePart("month", "2"); await typePart("day", "29");
      assert.equal(await page.locator(".consolidation-load-date-range").innerText(), "2028-02-29");
      await tap(input("day"));
      assert.equal(await page.locator('[data-consolidation-date-option="29"][data-date-part="day"]').count(), 1);
      assert.equal(await page.locator('[data-consolidation-date-option="30"][data-date-part="day"]').count(), 0);
      await input("day").press("Escape");
      await tap(input("year"));
      await tap(page.locator('[data-consolidation-date-option="2027"][data-date-part="year"]'));
      assert.equal(await page.locator(".consolidation-load-date-range").innerText(), "2027-02-28");
      await typePart("day", "31");
      assert.equal(await input("day").getAttribute("aria-invalid"), "true");
      assert.equal(await page.locator(".consolidation-load-date-range").innerText(), "2027-02-28");
      await input("day").press("Escape");
      assert.equal(await input("day").inputValue(), "28");
      assert.deepEqual(await page.evaluate(() => [
        consolidationLoadRelativeDate(1, new Date("2026-12-31T17:00:00Z")),
        consolidationLoadRelativeDate(1, new Date("2028-02-28T17:00:00Z")),
        consolidationLoadRelativeDate(0, new Date("2026-03-08T04:00:00Z"))
      ]), ["2027-01-01", "2028-02-29", "2026-03-07"]);
      await page.locator('[data-action="reset-consolidation-load-filters"]').click();
      await page.locator('[data-action="consolidation-load-next"]').click();
      await page.selectOption('[data-input="consolidation-load-truck"]', "TRUCK-B");
      assert.equal(await page.locator(".consolidation-load-pagination strong").innerText(), "1 / 1");
      assert.equal(await page.locator(".consolidation-load-order").count(), 3);
      await page.selectOption('[data-input="consolidation-load-truck"]', "");
      await page.locator('[data-action="consolidation-load-next"]').click();
      await page.locator('[data-action="consolidation-load-next"]').click();
      available = available.slice(0, 3);
      await refresh();
      await page.locator(".consolidation-load-pagination").getByText("1 / 1", { exact: true }).waitFor();
      assert.equal(await page.locator(".consolidation-load-order").count(), 3);
      available = []; await refresh();
      await page.locator(".consolidation-load-pagination").getByText("0 / 0", { exact: true }).waitFor();
      assert.equal(await page.locator('[data-action="consolidation-load-prev"]').isDisabled(), true);
      assert.equal(await page.locator('[data-action="consolidation-load-next"]').isDisabled(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      await page.locator('[data-action="set-language"][data-language="zh-CN"]').click();
      assert.equal(await page.locator('[data-preset="both"]').innerText(), "今天和明天");
      assert.equal(await page.locator('label[for="consolidation-date-year"]').innerText(), "年");
      assert.equal(await page.locator("#consolidation-date-hint").innerText(), "点一下选择，再点一下输入。");
      assert.deepEqual(errors, []);
    } finally { await context.close(); await browser.close(); }
  });
}

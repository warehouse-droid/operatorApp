import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
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
    } catch { res.writeHead(404).end(); }
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); });

async function setup(engine, mobile) {
  const browser = await engine.launch({ headless: true, args: engine === chromium ? ["--no-sandbox"] : [] });
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1200, height: 900 }, isMobile: mobile, hasTouch: mobile, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(6000);
  await page.addInitScript(() => {
    localStorage.setItem("mbbs.staff.token", "auto-camera-test");
    window.EventSource = class { addEventListener() {} close() {} };
    window.cameraTest = { calls: [], streams: [], pending: [], mode: "success" };
    const makeStream = () => {
      const entry = { stopped: false };
      const track = { stop() { entry.stopped = true; }, getSettings: () => ({}), getCapabilities: () => ({}), applyConstraints: async () => {} };
      const stream = new MediaStream();
      stream.getTracks = stream.getVideoTracks = () => [track];
      window.cameraTest.streams.push(entry);
      return stream;
    };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      enumerateDevices: async () => [],
      getUserMedia: async (constraints) => {
        const state = window.cameraTest;
        state.calls.push(constraints);
        if (state.mode === "denied") throw new DOMException("Denied", "NotAllowedError");
        if (state.mode === "pending") return new Promise((resolve, reject) => state.pending.push({ resolve: () => resolve(makeStream()), reject: () => reject(new DOMException("No matching device", "OverconstrainedError")) }));
        return makeStream();
      }
    } });
    HTMLMediaElement.prototype.play = async () => {};
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 1280 });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 720 });
    window.ImageCapture = class { async takePhoto() {
      const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 32;
      canvas.getContext("2d").fillRect(0, 0, 64, 32);
      return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg"));
    } };
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let data = [];
    if (url.pathname === "/api/auth/me") data = { operator: { id: "camera-test", display_name: "Camera Test", role: "operator", roles: ["operator"], operatorYardLocationIds: [1] } };
    else if (url.pathname.endsWith("/notifications")) data = { total: 0, items: [], salesOrder: {}, transferOrder: {} };
    else if (url.pathname.endsWith("/current-draft")) data = null;
    else if (url.pathname.includes("photo-requirement")) data = { required: true, requiredPhotoCount: 1 };
    else if (url.pathname.includes("netsuite-posting-policy")) data = { effective: false, transactionType: "IF", revision: 1 };
    else if (url.pathname === "/api/delivery/orders/camera-order") data = { netsuite_id: "camera-order", tranid: "SOB-CAMERA", order_type: "sales_order", operator_status: "loaded", reload_authorized: true, reload_cycle: { status: "packed" }, lines: [] };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.goto(`${base}/operator`);
  await page.locator('[data-action="open-module"][data-module="delivery"]').waitFor();
  assert.equal(await page.evaluate(() => window.cameraTest.calls.length), 0, "Menu and order lookup do not open a photo camera.");
  return { browser, context, page, errors, close: async () => { await context.close(); await browser.close(); } };
}

async function enter(page, kind) {
  await page.evaluate(async (kind) => {
    const order = { netsuite_id: "camera-order", tranid: "SOB-CAMERA", order_type: "sales_order", operator_status: "packed", lines: [] };
    if (kind.startsWith("return")) {
      resetReturnWorkflow(kind === "return-pallet" ? "pallet" : "stock");
      currentModule = kind === "return-pallet" ? "pallet-return" : "stock-return";
      returnSelectedCustomer = { id: "customer-1", name: "Test Customer" };
      returnPalletBalance = { available: 10 };
      returnVehiclePlate = "TEST";
      if (kind === "return-pallet") returnPalletQuantity = 1;
      else {
        returnType = kind === "return-quality" ? "quality" : "normal";
        const line = { id: "line-1", itemName: "Paver", remainingReturnable: 10, returnPolicy: { effective: "ALLOWED" }, entryMode: "sales_uom", salesUom: "EA" };
        returnLookupData = { order, lines: [line] };
        Object.assign(ensureReturnLineValue(line), { salesQuantity: 1, reasonId: "5" });
      }
      returnStage = "form"; render();
    } else if (kind.startsWith("receipt")) {
      receivingSelectedOrder = { ...order, order_type: kind === "receipt-to" ? "transfer_order" : "purchase_order" };
      currentModule = "receiving"; await startReceipt();
    } else if (kind === "consolidation") {
      prepareConsolidationLoadProof({ id: "camera-batch", status: "draft", photoRefs: [], snapshot: {
        assignment: { planDate: "2026-09-16", truckPlate: "TEST", loadName: "Load 1" }, orders: [order]
      } });
    } else {
      selectedOrder = { ...order, reload_authorized: kind === "reload" };
      currentModule = kind === "pickup" ? "customer-pickup" : "delivery";
      await startFulfillment();
    }
  }, kind);
  if (kind.startsWith("return")) await page.locator('[data-action="return-open-review"]').click();
}

for (const [name, engine, mobile] of [["desktop", chromium, false], ["touch", webkit, true]]) {
  test(`${name}: every required photo screen opens once, captures, preserves manual close and releases its camera`, async () => {
    const run = await setup(engine, mobile), { page } = run;
    try {
      for (const kind of ["delivery", "pickup", "reload", "consolidation", "receipt-po", "receipt-to", "return-pallet", "return-stock", "return-quality"]) {
        const receipt = kind.startsWith("receipt"), returns = kind.startsWith("return");
        const camera = receipt ? "receiptCamera" : returns ? "returnCamera" : "fulfillmentCamera";
        const capture = receipt ? "capture-receipt-photo" : returns ? "return-capture-photo" : "capture-photo";
        const close = receipt ? "stop-receipt-camera" : returns ? "return-close-camera" : "stop-camera";
        const open = receipt ? "start-receipt-camera" : returns ? "return-start-camera" : "start-camera";
        const back = receipt ? "cancel-receive" : returns ? "return-back-to-form" : "cancel-fulfill";
        const before = await page.evaluate(() => window.cameraTest.calls.length);
        await enter(page, kind);
        await page.locator(`#${camera}`).waitFor();
        assert.equal(await page.evaluate(() => window.cameraTest.calls.length), before + 1, kind);
        assert.equal(await page.evaluate(() => window.cameraTest.calls.at(-1).video.facingMode.exact), "environment", kind);
        await page.evaluate(() => { render(); render(); });
        await page.locator(`[data-action="${capture}"]`).click();
        await page.waitForFunction((kind) => (kind.startsWith("return") ? returnTargetPhotos() : kind.startsWith("receipt") ? receiptPhotoDataUrls : fulfillmentPhotoDataUrls).filter(Boolean).length === 1, kind);
        assert.equal(await page.evaluate(() => window.cameraTest.calls.length), before + 1);
        if (kind === "receipt-po") {
          await mkdir("test-artifacts/operator-auto-camera", { recursive: true });
          await page.screenshot({ path: `test-artifacts/operator-auto-camera/${name}-receipt.png`, fullPage: true });
        }
        await page.locator(`[data-action="${close}"]`).click();
        await page.evaluate(() => { render(); render(); });
        assert.equal(await page.locator(`#${camera}`).count(), 0);
        assert.equal(await page.evaluate(() => window.cameraTest.calls.length), before + 1);
        assert.equal(await page.evaluate(() => window.cameraTest.streams.every((stream) => stream.stopped)), true);
        await page.locator(`[data-action="${open}"]`).click();
        await page.locator(`#${camera}`).waitFor();
        await page.locator(`[data-action="${back}"]`).click();
        assert.equal(await page.evaluate(() => window.cameraTest.streams.every((stream) => stream.stopped)), true);
      }
      assert.deepEqual(run.errors, []);
    } finally { await run.close(); }
  });

  test(`${name}: denied/pending requests never loop or attach after closing, navigation, switching, or completion`, async () => {
    const run = await setup(engine, mobile), { page } = run;
    try {
      await page.evaluate(() => { window.cameraTest.mode = "denied"; });
      await enter(page, "receipt-po");
      await page.locator("#toast").getByText(/Camera permission is required/).waitFor();
      await page.evaluate(() => { render(); render(); });
      assert.equal(await page.evaluate(() => window.cameraTest.calls.length), 1);
      assert.equal(await page.locator('[data-action="start-receipt-camera"]').isEnabled(), true);
      await page.evaluate(() => { window.cameraTest.mode = "success"; });
      await page.locator('[data-action="start-receipt-camera"]').click();
      await page.locator("#receiptCamera").waitFor();
      await page.locator('[data-action="cancel-receive"]').click();

      await page.evaluate(() => { window.cameraTest.mode = "pending"; });
      await enter(page, "delivery");
      assert.equal(await page.locator('[data-action="start-camera"]').isDisabled(), true);
      await page.locator('[data-action="cancel-fulfill"]').click();
      await page.evaluate(() => window.cameraTest.pending.shift().resolve());
      await page.waitForFunction(() => window.cameraTest.streams.every((stream) => stream.stopped));
      assert.equal(await page.locator("#fulfillmentCamera").count(), 0);

      await enter(page, "receipt-po");
      const calls = await page.evaluate(() => window.cameraTest.calls.length);
      await page.locator('[data-action="cancel-receive"]').click();
      await page.evaluate(() => window.cameraTest.pending.shift().reject());
      await page.waitForTimeout(50);
      assert.equal(await page.evaluate(() => window.cameraTest.calls.length), calls, "No device fallback after leaving.");

      await enter(page, "delivery");
      await page.locator('[data-action="stop-camera"]').click();
      await page.evaluate(() => window.cameraTest.pending.shift().resolve());
      await page.waitForFunction(() => window.cameraTest.streams.every((stream) => stream.stopped));
      assert.equal(await page.locator("#fulfillmentCamera").count(), 0);

      await page.locator('[data-action="start-camera"]').click();
      await page.locator('[data-action="switch-fulfillment-camera"]').click();
      await page.evaluate(() => window.cameraTest.pending.pop().resolve());
      await page.locator("#fulfillmentCamera").waitFor();
      await page.evaluate(() => window.cameraTest.pending.shift().resolve());
      await page.waitForFunction(() => window.cameraTest.streams.at(-1).stopped);
      assert.equal(await page.evaluate(() => window.cameraTest.streams.filter((stream) => !stream.stopped).length), 1);
      assert.equal(await page.evaluate(() => window.cameraTest.calls.at(-1).video.facingMode.exact), "user");
      await page.evaluate(() => { fulfillmentSubmitting = true; render(); });
      assert.equal(await page.evaluate(() => window.cameraTest.streams.every((stream) => stream.stopped)), true);
      await page.evaluate(() => { fulfillmentResult = { localYardOrderStatus: "Loaded" }; fulfillmentSubmitting = false; render(); });
      const doneCalls = await page.evaluate(() => window.cameraTest.calls.length);
      await page.evaluate(() => render());
      assert.equal(await page.evaluate(() => window.cameraTest.calls.length), doneCalls);
      assert.equal(await page.locator("#fulfillmentCamera").count(), 0);
      await page.route("**/api/customer-pickup/config", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
        schemaVersion: "operator-customer-pickup-photo-requirement-v1", flagKey: "operator_customer_pickup_photo_required", revision: 1, required: false, requiredPhotoCount: 0
      }) }));
      await page.evaluate(() => { window.cameraTest.mode = "success"; });
      await enter(page, "pickup");
      assert.equal(await page.evaluate(() => window.cameraTest.calls.length), doneCalls, "No camera request when Customer Pickup photo evidence is off.");
      await page.locator('[data-action="start-camera"]').click();
      await page.locator("#fulfillmentCamera").waitFor();
      await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
      assert.equal(await page.evaluate(() => window.cameraTest.streams.every((stream) => stream.stopped)), true);
      assert.deepEqual(run.errors, []);
    } finally { await run.close(); }
  });
}

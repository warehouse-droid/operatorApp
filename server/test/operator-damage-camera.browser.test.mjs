// Damage stock camera on a Windows touch tablet: it must open the rear camera and switch
// cameras through the same camera selection as Customer Pickup.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test, { before, after } from "node:test";
import { chromium } from "playwright";

const publicDir = process.env.OPERATOR_DAMAGE_CAMERA_PUBLIC || "public";
const sku = { item_id: 980401, item_name: "Windows Paver", item_description: "Damage camera", item_type: "InvtPart", sales_unit: "PCS", sales_unit_id: 191, to_pcs: 1 };
const windowsUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
let server, base, browser;

before(async () => {
  server = createServer(async (req, res) => {
    const name = new URL(req.url, "http://test").pathname;
    const file = name === "/operator" ? "operator.html" : name.slice(1);
    if (file.includes("..")) return res.writeHead(404).end();
    try {
      const bytes = await readFile(path.resolve(publicDir, file));
      res.writeHead(200, { "content-type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(file)] || "application/octet-stream" }).end(bytes);
    } catch { res.writeHead(404).end(); }
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

/** Windows Chrome commonly exposes cameras without a facingMode, so exact facing requests fail. */
async function openDamage(devices) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true, userAgent: windowsUserAgent, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(6000);
  await page.addInitScript((devices) => {
    localStorage.setItem("mbbs.staff.token", "damage-camera-test");
    window.EventSource = class { addEventListener() {} close() {} };
    Object.defineProperty(navigator, "userAgentData", { configurable: true, get: () => ({ platform: "Windows", mobile: false, brands: [] }) });
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, get: () => 10 });
    const state = window.cameraTest = { calls: [], streams: [] };
    const open = (device) => {
      const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 240;
      const paint = () => { const g = canvas.getContext("2d"); g.fillStyle = device.color; g.fillRect(0, 0, 320, 240); };
      paint();
      const entry = { deviceId: device.deviceId, stopped: false, timer: setInterval(paint, 50) };
      const stream = canvas.captureStream(20), track = stream.getVideoTracks()[0], stop = track.stop.bind(track), settings = track.getSettings.bind(track);
      track.getSettings = () => ({ ...settings(), deviceId: device.deviceId });
      track.stop = () => { entry.stopped = true; clearInterval(entry.timer); stop(); };
      state.streams.push(entry); state.last = stream;
      return stream;
    };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      enumerateDevices: async () => devices.map(({ deviceId, label }) => ({ kind: "videoinput", deviceId, label, groupId: deviceId })),
      getUserMedia: async (constraints) => {
        state.calls.push(JSON.parse(JSON.stringify(constraints)));
        const video = constraints.video || {};
        if (video.facingMode?.exact) throw new DOMException("No camera reports a facing mode", "OverconstrainedError");
        const wanted = video.deviceId?.exact;
        const device = wanted ? devices.find((row) => row.deviceId === wanted) : devices[0];
        if (!device) throw new DOMException("Camera not found", "NotFoundError");
        return open(device);
      }
    } });
  }, devices);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let data = [];
    if (url.pathname === "/api/auth/me") data = { operator: { id: "damage-camera", display_name: "Damage Camera", role: "operator", roles: ["operator"], operatorYardLocationIds: [1] } };
    else if (url.pathname.endsWith("/notifications")) data = { total: 0, items: [], salesOrder: {}, transferOrder: {} };
    else if (url.pathname.endsWith("/current-draft")) data = null;
    else if (url.pathname === "/api/inventory/damage/config") data = { reasons: [{ id: 7, label: "R7 - Broken" }], month: "2026-11" };
    else if (url.pathname === "/api/inventory/damage/items") data = [sku];
    else if (url.pathname === `/api/inventory/damage/items/${sku.item_id}`) data = sku;
    else if (url.pathname === "/api/inventory/damage/reports") data = { reports: [], transfers: [] };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.goto(`${base}/operator`);
  assert.equal(await page.evaluate(() => useBasicCameraCapture()), false, "A Windows touch tablet uses the live camera path");
  await page.locator('button[data-module="inventory"]').click();
  await page.locator('button[data-module="damage"]').click();
  await page.locator("#damageSearch").fill("Windows");
  await page.locator(`[data-inv-action="damage-item"][data-id="${sku.item_id}"]`).click();
  await page.locator('[data-inv-action="camera"]:not([disabled])').waitFor();
  return { page, context, errors };
}

/** Waits for the newest camera stream to be playing in the preview and returns its device. */
async function newestPreview(page) {
  await page.waitForFunction(() => {
    const video = document.getElementById("damageCamera");
    return video?.videoWidth > 0 && video.srcObject === window.cameraTest.last;
  });
  return page.evaluate(() => document.getElementById("damageCamera").srcObject.getVideoTracks()[0].getSettings().deviceId);
}
async function switchCamera(page) {
  const opened = await page.evaluate(() => window.cameraTest.streams.length);
  await page.locator('[data-inv-action="flip"]').click();
  await page.waitForFunction((count) => window.cameraTest.streams.length > count, opened);
  return newestPreview(page);
}
async function photoColors(page) {
  return page.evaluate(() => Promise.all([...document.querySelectorAll(".damage-photos img")].map((img) => new Promise((resolve, reject) => {
    const probe = new Image();
    probe.onload = () => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const g = canvas.getContext("2d"); g.drawImage(probe, 0, 0, 1, 1);
      const [r, , b] = g.getImageData(0, 0, 1, 1).data;
      resolve(r > 200 && b < 80 ? "rear" : b > 200 && r < 80 ? "front" : `other(${r},${b})`);
    };
    probe.onerror = reject; probe.src = img.currentSrc || img.src;
  }))));
}

for (const [name, devices, firstId, secondId] of [
  ["labelled Microsoft Front/Rear cameras", [
    { deviceId: "front-id", label: "Microsoft Camera Front", color: "#0000ff" },
    { deviceId: "rear-id", label: "Microsoft Camera Rear", color: "#ff0000" }
  ], "rear-id", "front-id"],
  ["unlabelled USB cameras", [
    { deviceId: "cam-a", label: "USB2.0 HD UVC WebCam", color: "#ff0000" },
    { deviceId: "cam-b", label: "Integrated Camera", color: "#0000ff" }
  ], "cam-a", "cam-b"]
]) {
  test(`Windows tablet damage camera with ${name}: switch camera changes camera`, async () => {
    const { page, context, errors } = await openDamage(devices);
    try {
      await page.locator('[data-inv-action="camera"]').click();
      const started = await newestPreview(page);
      const switched = await switchCamera(page);
      assert.notEqual(switched, started, `Switch camera must open the other camera (started ${started}, after switch ${switched})`);
      assert.deepEqual([started, switched], [firstId, secondId], "Starts on the rear camera, then switches to the front camera");
      assert.equal(await page.evaluate((id) => window.cameraTest.streams.filter((row) => row.deviceId === id).every((row) => row.stopped), started), true,
        "The previous camera is released before switching");
      await expectLabel(page, "Front");
      assert.equal(await switchCamera(page), firstId, "Switching again returns to the rear camera");
      await expectLabel(page, "Back");

      await page.locator('[data-inv-action="capture"]').click();
      await page.waitForFunction(() => document.querySelectorAll(".damage-photos img").length === 1);
      await switchCamera(page);
      await page.locator('[data-inv-action="capture"]').click();
      await page.waitForFunction(() => document.querySelectorAll(".damage-photos img").length === 2);
      assert.deepEqual(await photoColors(page), ["rear", "front"], "Each photo comes from the camera shown when it was captured");

      await page.locator('[data-inv-action="camera"]').click();
      assert.equal(await page.locator("#damageCamera").count(), 0);
      assert.equal(await page.evaluate(() => window.cameraTest.streams.every((row) => row.stopped)), true, "Stop camera releases every stream");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("Windows tablet damage camera releases a stream that opens after the operator leaves", async () => {
  const devices = [{ deviceId: "rear-id", label: "Microsoft Camera Rear", color: "#ff0000" }];
  const { page, context, errors } = await openDamage(devices);
  try {
    await page.evaluate(() => {
      // The first request (exact rear facing) resolves only after the operator has left.
      const media = navigator.mediaDevices, original = media.getUserMedia;
      media.getUserMedia = () => new Promise((resolve, reject) => { window.releaseCamera = () => original({ video: { deviceId: { exact: "rear-id" } } }).then(resolve, reject); });
    });
    await page.locator('[data-inv-action="camera"]').click();
    await page.waitForFunction(() => typeof window.releaseCamera === "function");
    assert.equal(await page.locator('[data-inv-action="camera"]').isDisabled(), true, "The camera button cannot queue a second request while opening");
    await page.locator('[data-inv-action="menu"]').click();
    await page.evaluate(() => window.releaseCamera());
    await page.waitForFunction(() => window.cameraTest.streams.length > 0 && window.cameraTest.streams.every((row) => row.stopped));
    assert.equal(await page.locator("#damageCamera").count(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const [name, viewport] of [["desktop", { width: 1280, height: 800 }], ["narrow", { width: 600, height: 900 }]]) {
  test(`Take photo sits at the bottom right of the live camera preview (${name})`, async () => {
    const { page, context, errors } = await openDamage([{ deviceId: "rear-id", label: "Microsoft Camera Rear", color: "#ff0000" }]);
    try {
      await page.setViewportSize(viewport);
      const shutter = page.locator('.damage-camera-view > [data-inv-action="capture"]');
      assert.equal(await shutter.count(), 1, "Take photo is inside the camera preview container");
      assert.equal(await shutter.isDisabled(), true, "Take photo waits for the camera");
      assert.equal(await page.locator('.inventory-actions [data-inv-action="capture"]').count(), 0, "Take photo is no longer in the action row");
      await page.locator('[data-inv-action="camera"]').click();
      await newestPreview(page);
      assert.equal(await shutter.isEnabled(), true);
      const [box, frame] = await Promise.all([shutter.boundingBox(), page.locator(".damage-camera-view").boundingBox()]);
      const right = frame.x + frame.width - (box.x + box.width), bottom = frame.y + frame.height - (box.y + box.height);
      assert.ok(right >= 0 && right <= 16 && bottom >= 0 && bottom <= 16, `Bottom-right inset ${right.toFixed(1)}px/${bottom.toFixed(1)}px`);
      assert.ok(box.x > frame.x + frame.width / 2 && box.y > frame.y + frame.height / 2, "Button is in the bottom-right quadrant");
      const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-inv-action]")?.dataset.invAction, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
      assert.equal(hit, "capture", "Nothing covers the button");
      if (process.env.OPERATOR_DAMAGE_CAMERA_SCREENSHOTS) await page.screenshot({ path: `${process.env.OPERATOR_DAMAGE_CAMERA_SCREENSHOTS}/damage-camera-${name}.png` });
      await shutter.click();
      await page.waitForFunction(() => document.querySelectorAll(".damage-photos img").length === 1);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

async function expectLabel(page, facing) {
  const label = await page.locator('[data-inv-action="flip"]').textContent();
  assert.match(label, new RegExp(`\\(${facing}\\)`), `Switch button shows the ${facing} camera`);
}

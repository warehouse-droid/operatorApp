import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import test, { before, after } from "node:test";
import { chromium } from "playwright";

const art = "test-artifacts/operator-camera-rollback";
const root = process.env.OPERATOR_CAMERA_PUBLIC || "public";
const baseline = process.env.OPERATOR_CAMERA_BASELINE === "1";
let server, origin;
before(async () => {
  await mkdir(art, { recursive: true });
  server = createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = pathname === "/operator" ? "operator.html" : pathname.slice(1);
    if (file.includes("..")) return res.writeHead(404).end();
    try {
      const folder = baseline && ["operator.js", "operator.html", "service-worker.js"].includes(file) ? `${art}/baseline` : root;
      const bytes = await readFile(path.join(folder, file));
      res.writeHead(200, { "content-type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(file)] || "application/octet-stream" }).end(bytes);
    } catch { res.writeHead(404).end(); }
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

async function setup(android = true, stall = false) {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, serviceWorkers: "block", permissions: ["camera"],
    userAgent: android ? "Mozilla/5.0 (Linux; Android 14; Tablet) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36" : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.coverage.startJSCoverage({ includeRawScriptCoverage: true });
  await page.addInitScript(stall => {
    localStorage.setItem("mbbs.staff.token", "camera-isolated-fixture");
    window.EventSource = class { addEventListener() {} close() {} };
    window.cameraCheck = { tracks: [], calls: [], constraints: [], stalled: [], failures: {} };
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.cameraCheck.calls.push(constraints);
      const failure = window.cameraCheck.failures[window.cameraCheck.calls.length];
      if (failure) throw new DOMException("Camera boundary failure", failure);
      const stream = await original(constraints);
      const track = stream.getVideoTracks()[0];
      window.cameraCheck.tracks.push(track);
      const apply = track.applyConstraints.bind(track);
      if (stall) track.getCapabilities = () => ({ width: { max: 1920 }, height: { max: 1080 } });
      track.applyConstraints = value => {
        window.cameraCheck.constraints.push(value);
        return stall ? new Promise(resolve => window.cameraCheck.stalled.push(resolve)) : apply(value);
      };
      return stream;
    };
  }, stall);
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    let data = [];
    if (url.pathname === "/api/auth/me") data = { operator: { id: "camera-check", display_name: "Camera Check", role: "operator", roles: ["operator"], operatorYardLocationIds: [1] } };
    else if (url.pathname.endsWith("/notifications")) data = { total: 0, items: [], salesOrder: {}, transferOrder: {} };
    else if (url.pathname.endsWith("/current-draft")) data = null;
    else if (url.pathname.includes("photo-requirement")) data = { required: true, requiredPhotoCount: 1 };
    else if (url.pathname.includes("netsuite-posting-policy")) data = { effective: false, transactionType: "IF", revision: 1 };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.goto(origin + "/operator");
  await page.locator('[data-action="open-module"][data-module="delivery"]').waitFor();
  assert.equal(await page.evaluate(() => window.cameraCheck.calls.length), 0);
  return { page, errors, close: async () => {
    const coverage = (await page.coverage.stopJSCoverage()).filter(entry => entry.url.includes("/operator.js?"));
    await writeFile(`${art}/browser-coverage-${baseline ? "baseline" : "candidate"}-${Date.now()}.json`, JSON.stringify(coverage));
    await browser.close();
  } };
}

async function enter(page, kind) {
  await page.evaluate(async kind => {
    const order = { netsuite_id: "camera-fixture", tranid: "SOB-CAMERA", order_type: "sales_order", operator_status: "packed", lines: [] };
    if (kind === "receipt") {
      receivingSelectedOrder = { ...order, order_type: "purchase_order" }; currentModule = "receiving"; await startReceipt();
    } else if (kind === "return") {
      resetReturnWorkflow("pallet"); currentModule = "pallet-return"; returnSelectedCustomer = { id: "customer", name: "Test" };
      returnPalletBalance = { available: 10 }; returnVehiclePlate = "TEST"; returnPalletQuantity = 1; returnStage = "form"; render();
    } else { selectedOrder = order; currentModule = "delivery"; await startFulfillment(); }
  }, kind);
  if (kind === "return") await page.locator('[data-action="return-open-review"]').click();
}
async function frames(page) {
  await page.waitForFunction(() => {
    const video = document.querySelector("video.camera-preview");
    return video?.readyState >= 2 && video.videoWidth > 0 && !video.paused;
  });
  return page.evaluate(() => {
    const video = document.querySelector("video.camera-preview");
    const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 24;
    const context = canvas.getContext("2d"); context.drawImage(video, 0, 0, 32, 24);
    const pixels = context.getImageData(0, 0, 32, 24).data;
    const brightness = Array.from(pixels).some((value, index) => index % 4 !== 3 && value > 30);
    return { brightness, width: video.videoWidth, height: video.videoHeight };
  });
}

test("native camera is released while resolution setup is still pending", async () => {
  const run = await setup(false, true), { page } = run;
  try {
    await enter(page, "receipt");
    await page.waitForFunction(() => window.cameraCheck.stalled.length === 1);
    await page.evaluate(() => { currentModule = "menu"; render(); });
    assert.equal(await page.evaluate(() => window.cameraCheck.tracks[0].readyState), "ended");
    await page.evaluate(() => window.cameraCheck.stalled.splice(0).forEach(resolve => resolve()));
    await page.waitForFunction(() => operatorPhotoCamera.pending === null && operatorPhotoCamera.opening === "");
    assert.deepEqual(run.errors, []);
  } finally { await run.close(); }
});

test("background releases native photo tracks and hidden renders do not reacquire them", async () => {
  const run = await setup(), { page } = run;
  try {
    await enter(page, "receipt");
    assert((await frames(page)).brightness);
    const requestsBefore = await page.evaluate(() => window.cameraCheck.calls.length);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange")); render(); render();
    });
    assert.equal(await page.evaluate(() => window.cameraCheck.tracks.every(track => track.readyState === "ended")), true);
    assert.equal(await page.evaluate(() => window.cameraCheck.calls.length), requestsBefore);
    await page.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event("visibilitychange")); });
    assert((await frames(page)).brightness);
    assert.equal(await page.evaluate(() => window.cameraCheck.calls.length), requestsBefore * 2);
    assert.equal(await page.evaluate(() => window.cameraCheck.tracks.filter(track => track.readyState === "live").length), 1);
    assert.deepEqual(run.errors, []);
  } finally { await run.close(); }
});

test("device failures stop the full screen after the first error, including device-selection fallback", async () => {
  for (const fallback of [false, true]) {
    const run = await setup(), { page } = run;
    try {
      await page.evaluate(fallback => {
        window.cameraCheck.failures = fallback ? { 1: "OverconstrainedError", 2: "NotReadableError" } : { 1: "NotReadableError" };
      }, fallback);
      await enter(page, "receipt");
      await page.locator("#toast").getByText(/camera is in use/i).waitFor();
      await page.evaluate(() => { render(); render(); });
      assert.equal(await page.evaluate(() => window.cameraCheck.calls.length), fallback ? 2 : 1);
      assert.equal(await page.evaluate(() => operatorPhotoCamera.opening), "");
      assert.equal(await page.locator("#receiptCamera").count(), 0);
      assert.deepEqual(run.errors, []);
    } finally { await run.close(); }
  }
});

for (const android of [true, false]) test(`${android ? "Android" : "Windows"} mode: real frames, still photos and reopen in all photo flows`, async () => {
  const run = await setup(android), { page } = run;
  try {
    for (const kind of ["delivery", "receipt", "return"]) {
      await enter(page, kind);
      assert((await frames(page)).brightness);
      const action = kind === "receipt" ? "capture-receipt-photo" : kind === "return" ? "return-capture-photo" : "capture-photo";
      await page.locator(`[data-action="${action}"]`).click();
      await page.waitForFunction(kind => (kind === "receipt" ? receiptPhotoDataUrls : kind === "return" ? returnTargetPhotos() : fulfillmentPhotoDataUrls).some(value => value?.startsWith("data:image/")), kind);
      const stop = kind === "receipt" ? "stop-receipt-camera" : kind === "return" ? "return-close-camera" : "stop-camera";
      const start = kind === "receipt" ? "start-receipt-camera" : kind === "return" ? "return-start-camera" : "start-camera";
      await page.locator(`[data-action="${stop}"]`).click();
      assert.equal(await page.evaluate(() => window.cameraCheck.tracks.every(track => track.readyState === "ended")), true);
      await page.locator(`[data-action="${start}"]`).click();
      assert((await frames(page)).brightness);
      await page.locator(`[data-action="${stop}"]`).click();
    }
    const requests = await page.evaluate(() => window.cameraCheck.calls);
    assert(requests.every(call => android ? !call.video.width && !call.video.height : call.video.width.ideal === 4096));
    if (android) assert.equal(await page.evaluate(() => window.cameraCheck.constraints.length), 0);
    assert.deepEqual(run.errors, []);
    await page.screenshot({ path: `${art}/${android ? "android" : "windows"}-capture.png`, fullPage: true });
  } finally { await run.close(); }
});

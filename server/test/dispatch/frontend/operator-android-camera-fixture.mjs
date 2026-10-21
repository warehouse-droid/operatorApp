import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import test, { before, after } from "node:test";
import { chromium } from "playwright";

const art = "test-artifacts/operator-android-camera-release";
const root = process.env.OPERATOR_ANDROID_PUBLIC || "public";
const baseline = process.env.OPERATOR_ANDROID_BASELINE === "1";
let server, origin;
before(async () => {
  await mkdir(art, { recursive: true });
  server = createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = pathname === "/operator" ? "operator.html" : pathname.slice(1);
    if (file.includes("..")) return res.writeHead(404).end();
    try {
      const folder = baseline && ["operator.js", "operator.css", "operator-inventory.js", "operator.html", "service-worker.js"].includes(file) ? `${art}/baseline` : root;
      const bytes = await readFile(path.join(folder, file));
      res.writeHead(200, { "content-type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(file)] || "application/octet-stream" }).end(bytes);
    } catch { res.writeHead(404).end(); }
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

export async function setup(android = true, stall = false) {
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
    const coverage = (await page.coverage.stopJSCoverage()).filter(entry => /\/(operator|operator-inventory)\.js\?/.test(entry.url));
    await writeFile(`${art}/browser-coverage-${baseline ? "baseline" : "candidate"}-${Date.now()}.json`, JSON.stringify(coverage));
    await browser.close();
  } };
}

export async function enter(page, kind) {
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
export async function frames(page) {
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


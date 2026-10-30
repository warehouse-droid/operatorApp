import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import {chromium, webkit} from "playwright";

let scenario;
const sockets = new Set();
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const server = http.createServer((request, response) => {
  if (request.url === "/") {
    // A fresh upload socket avoids the browser's transparent stale-keepalive replay.
    response.setHeader("connection", "close");
    response.end("<!doctype html><title>Disposable driver upload fixture</title>"); return;
  }
  if (request.url !== "/upload") {response.writeHead(404).end(); return;}
  const attempt = {received: 0, chunks: []};
  scenario.attempts.push(attempt);
  const first = scenario.attempts.length === 1;
  request.on("error", () => {});
  request.on("data", chunk => {
    attempt.received += chunk.length;
    attempt.chunks.push(chunk);
    if (first && scenario.mode === "disconnect") request.socket.destroy();
  });
  request.on("end", () => {
    const body = Buffer.concat(attempt.chunks);
    const boundary = String(request.headers["content-type"]).split("boundary=")[1];
    const start = body.indexOf(Buffer.from("\r\n\r\n")) + 4;
    const end = body.lastIndexOf(Buffer.from(`\r\n--${boundary}`));
    attempt.hash = hash(body.subarray(start, end));
    if (first && scenario.mode === "confirm") return;
    response.writeHead(200, {"content-type": "application/json"});
    response.end(JSON.stringify({key: "fixture/acknowledged.jpg"}));
  });
});
server.on("connection", socket => {sockets.add(socket); socket.on("close", () => sockets.delete(socket));});

const results = [];
async function exerciseBrowser(browser, name, mode, url) {
  scenario = {mode, attempts: []};
  const page = await browser.newPage({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
  try {
    await page.goto(url);
    await page.addScriptTag({path: process.env.DRIVER_UPLOAD_MODULE_FILE || "public/driver-upload.js"});
    const result = await page.evaluate(async uploadUrl => {
      const bytes = new Uint8Array(2 * 1024 * 1024).fill(123);
      const photo = {photoId: "synthetic-browser-photo", blob: new Blob([bytes], {type: "image/jpeg"})};
      const original = photo.blob;
      const failures = [];
      const phases = [];
      const started = performance.now();
      const reference = await globalThis.DriverUpload.reconnect(() => globalThis.DriverUpload.upload(photo, {
        ticket: async () => ({uploadUrl, token: "fixture-only"}), // secret-scan: allow -- synthetic ticket for the local disposable server.
        onFailure: value => failures.push(value), onProgress: value => phases.push(value.phase)
      }));
      return {reference, failures, phases, elapsedMs: performance.now() - started,
        samePhoto: photo.blob === original, attempts: photo.uploadAttemptCount};
    }, `${url}/upload`);
    assert.equal(result.reference, "r2://fixture/acknowledged.jpg");
    assert.equal(result.samePhoto, true);
    assert.equal(result.attempts, 2, JSON.stringify({browser: name, mode, result, requests: scenario.attempts.length}));
    assert.equal(result.failures.length, 1);
    assert.equal(result.phases.filter(value => value === "uploaded").length, 1);
    assert.equal(scenario.attempts.length, 2);
    const expectedHash = hash(Buffer.alloc(2 * 1024 * 1024, 123));
    assert.equal(scenario.attempts[1].hash, expectedHash);
    if (mode === "confirm") {
      assert.equal(result.failures[0].stage, "confirming");
      assert.equal(result.failures[0].timeoutMs, 15000);
      assert.equal(scenario.attempts[0].hash, expectedHash);
      assert.ok(result.elapsedMs >= 15000 && result.elapsedMs < 22000, `Confirmation recovery took ${result.elapsedMs} ms`);
    } else {
      assert.equal(result.failures[0].errorCode, "driver_photo_upload_network_error");
      assert.ok(scenario.attempts[0].received < 2 * 1024 * 1024);
      assert.ok(result.elapsedMs < 10000);
    }
    results.push({browser: name, version: browser.version(), mode, elapsedMs: Math.round(result.elapsedMs),
      attempts: result.attempts, failureStage: result.failures[0].stage, samePhotoBytes: true});
  } finally {await page.close();}
}
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const [name, browserType] of Object.entries({chromium, webkit})) {
    const browser = await browserType.launch({headless: true});
    try {
      for (const mode of ["confirm", "disconnect"]) {
        await exerciseBrowser(browser, name, mode, url);
      }
    } finally {await browser.close();}
  }
  fs.writeFileSync("test-artifacts/upload-wait-browser.json", JSON.stringify(results, null, 2));
  console.log(JSON.stringify({browserChecks: results}));
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}

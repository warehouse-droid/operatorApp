import fs from "node:fs";
import assert from "node:assert/strict";
import {chromium, webkit} from "playwright";
import crypto from "node:crypto";

const out = "/evidence";
const journalFile = `${out}/objects.json`;
const journal = fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile)) : [];
const saveJournal = () => fs.writeFileSync(journalFile, JSON.stringify(journal, null, 2));
const phase = process.argv[2];
// Keep failed transport-fixture objects visible in the cleanup manifest.
for (const entry of journal) {
  if (entry.key.startsWith("driver-reconnect-test/test-upload/2026/10/16/reconnect-1f51729e-885c-4534-a056-0a388b393480/") && entry.readBackByteSize === 0) {
    entry.supersededHarnessRun = "Playwright route.fetch omitted WebKit multipart File bytes; failed replay retained, excluded from native-XHR acceptance.";
  }
}
if (["cleanup", "verify"].includes(phase)) {
  const credentials = JSON.parse(fs.readFileSync("/tickets/objects.json"));
  const errors = [];
  for (const entry of journal) {
    const ticket = credentials.find(value => value.key === entry.key);
    assert.ok(ticket, "Each synthetic object needs scoped cleanup authorization");
    try {
      const read = await fetch(ticket.read.objectUrl, {headers: {authorization: `Bearer ${ticket.read.token}`}, signal: AbortSignal.timeout(15000)});
      if (read.status === 200) {
        const bytes = Buffer.from(await read.arrayBuffer());
        entry.readBackByteSize = bytes.length;
        entry.readBackSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
        entry.readBackVerified = entry.readBackSha256 === entry.sha256;
        if (!entry.supersededHarnessRun) assert.equal(entry.readBackVerified, true, `Read-back hash mismatch: ${entry.engine}`);
      } else assert.equal(read.status, 404);
    } catch (error) {
      entry.verificationError = error.message;
      errors.push({key: entry.key, stage: "read_back", error: error.message});
    } finally {
      saveJournal();
    }
    if (phase === "verify") {
      entry.manualDeletionRequested = true;
      saveJournal();
      continue;
    }
    try {
      const removed = await fetch(ticket.remove.objectUrl, {method: "DELETE", headers: {authorization: `Bearer ${ticket.remove.token}`}, signal: AbortSignal.timeout(15000)});
      assert.ok(removed.ok || removed.status === 404, `Synthetic object deletion returned ${removed.status}`);
      entry.deleteStatus = removed.status;
      entry.deleteResult = await removed.text();
      saveJournal();
      const absent = await fetch(`${ticket.read.objectUrl}&replayVerify=${crypto.randomUUID()}`, {headers: {authorization: `Bearer ${ticket.read.token}`, "cache-control": "no-cache"}, signal: AbortSignal.timeout(15000)});
      assert.equal(absent.status, 404);
      entry.deleted = true;
      entry.absenceStatus = absent.status;
      saveJournal();
    } catch (error) {
      entry.deletionError = error.message;
      errors.push({key: entry.key, stage: "delete", error: error.message});
      saveJournal();
    }
  }
  console.log(JSON.stringify({objects: journal.length, readBackVerified: journal.every(value => value.readBackVerified),
    deleted: journal.every(value => value.deleted), manualDeletionRequested: phase === "verify", prefix: "driver-reconnect-test/", errors}));
  assert.equal(errors.length, 0, "Storage verification/cleanup failed; exact object results retained in objects.json");
} else {
  const tickets = JSON.parse(fs.readFileSync("/tickets/upload.json"));
  saveJournal(); // Cleanup is registered by the shell before any upload.
  const results = process.env.R2_ENGINE && fs.existsSync(`${out}/replay.json`) ? JSON.parse(fs.readFileSync(`${out}/replay.json`)) : [];
  for (const [index, engine] of [chromium, webkit].entries()) {
    const engineName = index === 0 ? "chromium" : "webkit";
    if (process.env.R2_ENGINE && process.env.R2_ENGINE !== engineName) continue;
    const browser = await engine.launch({headless: true, args: index === 0 ? ["--no-sandbox"] : []});
    try {
      const page = await browser.newPage();
      page.on("requestfailed", request => console.log(JSON.stringify({engine: engineName, networkFailure: request.failure()?.errorText})));
      page.on("pageerror", error => console.log(JSON.stringify({engine: engineName, browserError: error.message})));
      await page.exposeFunction("recordReplayFailure", failure => console.log(JSON.stringify({engine: engineName, failure})));
      const fixtureUrl = `${new URL(tickets[0].uploadUrl).origin}/__synthetic_reconnect_fixture__`;
      await page.route(fixtureUrl, route => route.fulfill({contentType: "text/html", body: "<title>Synthetic R2 replay</title>"}));
      await page.goto(fixtureUrl);
      await page.addScriptTag({path: "/public/driver-upload.js"});
      await page.addScriptTag({path: "/public/driver-photo-hash.js"});
      await page.addScriptTag({path: "/public/driver-offline-photos.js"});
      await page.exposeFunction("recordStoredR2Object", async (payload, sha256, attempt) => {
        assert.ok(payload.key.startsWith(tickets[index * 3].metadata.keyPrefix + "/"));
        if (!journal.some(value => value.key === payload.key)) journal.push({key: payload.key, sha256, nativeTransfer: true,
          engine: index === 0 ? "chromium" : "webkit", lostAt: attempt === 2 ? "storage_confirmation" : "none"});
        saveJournal();
      });
      const result = await page.evaluate(async authorization => {
        // Native browser multipart transport is essential: Playwright route.fetch
        // does not preserve WebKit File parts and produced empty test objects.
        const NativeXHR = XMLHttpRequest;
        let transfers = 0;
        window.XMLHttpRequest = class extends NativeXHR {
          set onload(callback) {
            super.onload = callback && (async event => {
              if (this.status === 200) {
                await window.recordStoredR2Object(JSON.parse(this.responseText), window.fixtureSha256, this.fixtureAttempt);
                if (this.fixtureAttempt === 2) {this.onerror?.(new Event("error")); return;}
              }
              callback.call(this, event);
            });
          }
          send(body) {
            this.fixtureAttempt = ++transfers;
            if (this.fixtureAttempt === 1) {queueMicrotask(() => this.onerror?.(new Event("error"))); return;}
            super.send(body);
          }
        };
        const canvas = document.createElement("canvas");
        canvas.width = 4096; canvas.height = 3072;
        const ctx = canvas.getContext("2d");
        for (let y = 0; y < canvas.height; y += 16) for (let x = 0; x < canvas.width; x += 16) {
          ctx.fillStyle = `rgb(${x % 255},${y % 255},${(x + y) % 255})`;
          ctx.fillRect(x, y, 16, 16);
        }
        const input = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.95));
        const compressed = await DriverOfflinePhotos.compress(new File([input], "synthetic.jpg", {type: "image/jpeg"}));
        const bytes = await compressed.blob.arrayBuffer();
        window.fixtureSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(value => value.toString(16).padStart(2, "0")).join("");
        const failures = [];
        let ticketIndex = 0;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 90000);
        let reference;
        try {
          reference = await DriverUpload.reconnect(() => DriverUpload.upload(compressed, {
            signal: controller.signal, ticket: async () => {
              if (ticketIndex >= authorization.length) throw Object.assign(new Error("Replay exhausted its scoped tickets"), {status: 400});
              return authorization[ticketIndex++];
            }, onFailure: value => {failures.push(value); void window.recordReplayFailure({stage:value.stage, status:value.httpStatus, code:value.errorCode, message:value.message});}, context: {recordType: "test-upload"}
          }), {signal: controller.signal});
        } finally {clearTimeout(timeout);}
        return {width: compressed.width, height: compressed.height, byteSize: compressed.blob.size, reference,
          failures: failures.map(value => ({stage: value.stage, httpStatus: value.httpStatus, errorCode: value.errorCode})), attempts: ticketIndex};
      }, tickets.slice(index * 3, index * 3 + 3));
      assert.ok(Math.max(result.width, result.height) <= 2048);
      assert.ok(result.byteSize <= 2 * 1024 * 1024);
      assert.equal(result.attempts, 3);
      assert.equal(result.failures.length, 2);
      results.push({engine: index === 0 ? "chromium" : "webkit", ...result});
      fs.writeFileSync(`${out}/replay.json`, JSON.stringify(results, null, 2));
      console.log(JSON.stringify({...results.at(-1), reference: "stored synthetic test object"}));
    } finally {await browser.close();}
  }
}

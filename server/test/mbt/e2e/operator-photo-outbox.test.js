import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import test, { before, after } from "node:test";
import { chromium, expect } from "@playwright/test";

let browser, server, base;
before(async () => {
  const script = readFileSync(new URL("../../../public/operator-photo-outbox.js", import.meta.url));
  server = http.createServer((req, res) => {
    if (req.url === "/outbox.js") res.setHeader("Content-Type", "text/javascript");
    res.end(req.url === "/outbox.js" ? script : '<!doctype html><script src="/outbox.js"></script>');
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
after(async () => { await browser?.close(); server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); });

async function setup(context) {
  const page = await context.newPage(); await page.goto(base);
  await page.evaluate(() => {
    // The container has no external network; exercise an online browser with
    // the fake transport below, then control connectivity explicitly in tests.
    Object.defineProperty(navigator, "onLine", { get: () => true, configurable: true });
    window.readStore = store => new Promise((resolve, reject) => {
      const open = indexedDB.open("mbbs-operator-photo-outbox", 1);
      open.onsuccess = () => { const db = open.result; const req = db.transaction(store).objectStore(store).getAll(); req.onsuccess = () => { db.close(); resolve(req.result); }; req.onerror = () => reject(req.error); };
    });
    window.expireLeases = () => new Promise(resolve => {
      const open = indexedDB.open("mbbs-operator-photo-outbox", 1);
      open.onsuccess = () => { const db = open.result, tx = db.transaction("photos", "readwrite"), cursor = tx.objectStore("photos").openCursor();
        cursor.onsuccess = () => { const row = cursor.result; if (!row) return; row.update({ ...row.value, leaseUntil: 0, nextAttemptAt: 0 }); row.continue(); };
        tx.oncomplete = () => { db.close(); resolve(); }; };
    });
    window.testActor = "account-a"; window.transfers = []; window.resolvers = [];
    window.configureQueue = (manifest, fail = false) => window.OperatorPhotoOutbox.configure({ actorId: () => window.testActor,
      request: async (path, options) => {
        if (!options) return { photos: manifest };
        const id = path.split("/").at(-1); const photo = manifest.find(row => row.id === id);
        window.transfers.push({ id, bytes: [...new Uint8Array(await options.body.arrayBuffer())] });
        if (fail) throw new Error("Lost upload acknowledgement");
        await new Promise(resolve => window.resolvers.push(resolve));
        return { id, sha256: photo.sha256, stored: true };
      }
    });
  });
  return page;
}
const photos = ["data:image/jpeg;base64,YWJj", "data:image/jpeg;base64,ZGVm"];
async function prepare(page, actorId = "account-a") {
  return page.evaluate(({ actorId, photos }) => window.OperatorPhotoOutbox.prepare({ actorId, requestId: crypto.randomUUID(), photos }), { actorId, photos });
}

test("quota failure rolls back the entire device reservation before Load can proceed", async () => {
  const context = await browser.newContext();
  try {
    const page = await setup(context);
    const message = await page.evaluate(async photos => {
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (...args) { if (this.name === "photos") throw new DOMException("Device full", "QuotaExceededError"); return add.apply(this, args); };
      try { await window.OperatorPhotoOutbox.prepare({ actorId: "account-a", requestId: crypto.randomUUID(), photos }); return "unexpected success"; }
      catch (error) { return error.message; }
      finally { IDBObjectStore.prototype.add = add; }
    }, photos);
    assert.match(message, /Device full/);
    await expect.poll(() => page.evaluate(async () => (await window.readStore("actions")).length)).toBe(0);
    assert.equal(await page.evaluate(async () => (await window.readStore("photos")).length), 0);
  } finally { await context.close(); }
});

test("lost acknowledgements retain bytes across reopening and account switching", async () => {
  const context = await browser.newContext();
  try {
    let page = await setup(context); const manifest = (await prepare(page)).backgroundPhotos;
    await page.evaluate(manifest => window.configureQueue(manifest, true), manifest);
    await expect.poll(() => page.evaluate(() => window.transfers.length)).toBe(2);
    assert.equal(await page.evaluate(async () => (await window.readStore("photos")).length), 2);
    await page.close(); page = await setup(context);
    await page.evaluate(manifest => { window.testActor = "account-b"; window.configureQueue(manifest); }, manifest);
    await page.evaluate(() => window.expireLeases());
    await page.evaluate(() => window.OperatorPhotoOutbox.resume());
    assert.equal(await page.evaluate(() => window.transfers.length), 0);
    await page.evaluate(() => { window.testActor = "account-a"; window.OperatorPhotoOutbox.resume(); });
    await expect.poll(() => page.evaluate(() => window.resolvers.length)).toBe(1);
    await page.evaluate(() => window.resolvers.shift()());
    await expect.poll(() => page.evaluate(() => window.resolvers.length)).toBe(1);
    await page.evaluate(() => window.resolvers.shift()());
    await expect.poll(() => page.evaluate(async () => (await window.readStore("photos")).length)).toBe(0);
    assert.deepEqual(await page.evaluate(() => window.transfers.map(photo => photo.bytes).sort((a,b) => a[0]-b[0])), [[97,98,99], [100,101,102]]);
  } finally { await context.close(); }
});

test("multiple tabs claim each photo once while network transfers are stalled", async () => {
  const context = await browser.newContext();
  try {
    const first = await setup(context), second = await setup(context);
    const manifest = (await prepare(first)).backgroundPhotos;
    await Promise.all([first, second].map(page => page.evaluate(manifest => window.configureQueue(manifest), manifest)));
    await expect.poll(async () => (await Promise.all([first, second].map(page => page.evaluate(() => window.transfers.length)))).reduce((a,b) => a+b)).toBe(2);
    const ids = (await Promise.all([first, second].map(page => page.evaluate(() => window.transfers.map(photo => photo.id))))).flat();
    assert.equal(new Set(ids).size, 2);
    await Promise.all([first, second].map(page => page.evaluate(() => window.resolvers.splice(0).forEach(resolve => resolve()))));
    await expect.poll(() => first.evaluate(async () => (await window.readStore("photos")).length)).toBe(0);
  } finally { await context.close(); }
});

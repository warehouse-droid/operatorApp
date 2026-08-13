/* global Headers, Request, Response */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, "../../../public");
const DRIVER_SOURCE = fs.readFileSync(path.join(PUBLIC, "driver.js"), "utf8");
const WORKER_SOURCE = fs.readFileSync(path.join(PUBLIC, "driver-service-worker.js"), "utf8");
const ORIGIN = "https://driver-cache.test";
const ACTIVE_CACHE = "mbbs-driver-shell-v28";
const REFRESH_CACHE = "mbbs-driver-shell-refresh-v28";
const OFFLINE_MODE_URL = `${ORIGIN}/__mbbs_driver_offline_mode__`;

function requestUrl(input) {
  const value = typeof input === "string" ? input : input?.url;
  return new URL(String(value || ""), ORIGIN).href;
}

class MemoryCache {
  constructor(storage, name) {
    this.storage = storage;
    this.name = name;
    this.entries = new Map();
  }

  async addAll(requests) {
    if (this.storage.failStaging && this.name === REFRESH_CACHE) {
      throw new TypeError("simulated iPhone staging failure");
    }
    for (const request of requests) {
      this.storage.networkRequests.push(request);
      const url = requestUrl(request);
      this.entries.set(url, new Response(`network:${url}`, {
        status: 200,
        headers: { "content-type": "application/octet-stream" }
      }));
    }
  }

  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }

  async match(input) {
    return this.entries.get(requestUrl(input))?.clone();
  }

  async put(input, response) {
    this.entries.set(requestUrl(input), response.clone());
  }

  async delete(input) {
    return this.entries.delete(requestUrl(input));
  }
}

class MemoryCacheStorage {
  constructor({ failStaging = false } = {}) {
    this.failStaging = failStaging;
    this.networkRequests = [];
    this.caches = new Map();
  }

  async open(name) {
    if (!this.caches.has(name)) {
      this.caches.set(name, new MemoryCache(this, name));
    }
    return this.caches.get(name);
  }

  async keys() {
    return [...this.caches.keys()];
  }

  async delete(name) {
    return this.caches.delete(name);
  }
}

async function seed(cacheStorage, cacheName, url, body) {
  const cache = await cacheStorage.open(cacheName);
  await cache.put(url, new Response(body));
}

async function readBody(cacheStorage, cacheName, url) {
  const response = await (await cacheStorage.open(cacheName)).match(url);
  return response ? response.text() : null;
}

function createWorker(cacheStorage) {
  const listeners = new Map();
  const workerGlobal = {
    location: { origin: ORIGIN },
    clients: {
      claim: async () => {},
      matchAll: async () => []
    },
    skipWaiting: () => {}
  };
  workerGlobal.addEventListener = (type, listener) => listeners.set(type, listener);
  const context = {
    caches: cacheStorage,
    console,
    DriverOfflineSync: {
      syncAll: async () => {},
      cancelPartition: () => {}
    },
    Headers,
    importScripts: () => {},
    Request,
    Response,
    self: workerGlobal,
    Set,
    URL
  };
  vm.runInNewContext(WORKER_SOURCE, context, { filename: "driver-service-worker.js" });
  return listeners;
}

async function sendRepair(listeners) {
  let completion;
  let reply;
  listeners.get("message")({
    data: { type: "DRIVER_REPAIR_SHELL", requestId: "repair-test" },
    ports: [{ postMessage: (value) => { reply = value; } }],
    source: { postMessage: (value) => { reply = value; } },
    waitUntil: (promise) => { completion = promise; }
  });
  assert.ok(completion, "The repair message must extend the service-worker event lifetime.");
  await completion;
  return reply;
}

async function installWorker(listeners) {
  let completion;
  listeners.get("install")({
    waitUntil: (promise) => { completion = promise; }
  });
  assert.ok(completion, "The install event must wait for the complete Driver shell.");
  await completion;
}

test("a fresh Driver worker reloads every v28 shell asset and initializes only its scoped sentinel", async () => {
  const cacheStorage = new MemoryCacheStorage();
  await installWorker(createWorker(cacheStorage));

  assert.equal(cacheStorage.networkRequests.length, 15);
  assert.ok(cacheStorage.networkRequests.every((request) => request.cache === "reload"));
  assert.equal(await readBody(cacheStorage, ACTIVE_CACHE, OFFLINE_MODE_URL), "false");
  assert.deepEqual(await cacheStorage.keys(), [ACTIVE_CACHE]);
});

test("the Driver UI exposes a data-preserving scoped repair in normal and update-required states", () => {
  assert.match(DRIVER_SOURCE, /data-offline-action="repair-cache"/u);
  assert.match(DRIVER_SOURCE, /data-action="repair-driver-pwa"/u);
  assert.match(DRIVER_SOURCE, /async function repairDriverAppCache/u);
  assert.match(DRIVER_SOURCE, /new MessageChannel\(\)/u);
  assert.match(DRIVER_SOURCE, /type: "DRIVER_REPAIR_SHELL"/u);
  assert.match(DRIVER_SOURCE, /response\.version !== DRIVER_PWA_CLIENT_VERSION/u);
  assert.match(DRIVER_SOURCE, /location\.replace\(`\/driver\?cache-repair=/u);

  const repairSource = DRIVER_SOURCE.slice(
    DRIVER_SOURCE.indexOf("async function repairDriverAppCache"),
    DRIVER_SOURCE.indexOf("function staffHomeRoute")
  );
  assert.match(repairSource, /\/api\/driver\/network-health\?cacheRepair=/u);
  assert.match(repairSource, /cache: "no-store"[\s\S]*networkResponse\?\.ok/u);
  assert.match(repairSource, /activeRest[\s\S]*photoInteractionActive\(\)[\s\S]*activeForegroundEventIds/u);
  assert.match(repairSource, /saved route[\s\S]*photos[\s\S]*pending submissions[\s\S]*login/u);
  assert.doesNotMatch(
    repairSource,
    /indexedDB|deleteDatabase|DriverOfflineDB\.(?:delete|clear)|localStorage\.clear|sessionStorage\.clear|serviceWorker.*unregister/u
  );
});

test("a successful repair replaces only the complete Driver shell and preserves offline data sentinels", async () => {
  const cacheStorage = new MemoryCacheStorage();
  await seed(cacheStorage, ACTIVE_CACHE, "/driver", "stale-driver-shell");
  await seed(cacheStorage, ACTIVE_CACHE, "/unexpected-driver-entry", "stale-extra");
  await seed(cacheStorage, ACTIVE_CACHE, OFFLINE_MODE_URL, "true");
  await seed(cacheStorage, "mbbs-driver-shell-v26", "/driver", "older-driver-shell");
  await seed(cacheStorage, "mbbs-yard-operator-v99", "/operator", "operator-shell");

  const reply = await sendRepair(createWorker(cacheStorage));

  assert.deepEqual(
    JSON.parse(JSON.stringify(reply)),
    {
      type: "DRIVER_REPAIR_SHELL_RESULT",
      requestId: "repair-test",
      ok: true,
      version: "2026.08.12.3",
      cacheName: ACTIVE_CACHE,
      refreshedAssetCount: 15
    }
  );
  assert.equal(await readBody(cacheStorage, ACTIVE_CACHE, "/driver"), `network:${ORIGIN}/driver`);
  assert.equal(await readBody(cacheStorage, ACTIVE_CACHE, "/unexpected-driver-entry"), null);
  assert.equal(await readBody(cacheStorage, ACTIVE_CACHE, OFFLINE_MODE_URL), "true");
  assert.equal(await readBody(cacheStorage, "mbbs-yard-operator-v99", "/operator"), "operator-shell");
  assert.deepEqual((await cacheStorage.keys()).sort(), [ACTIVE_CACHE, "mbbs-yard-operator-v99"]);
  assert.equal(cacheStorage.networkRequests.length, 15);
  assert.ok(cacheStorage.networkRequests.every((request) => request.cache === "reload"));
});

test("a failed staging download leaves the active and non-Driver caches byte-for-byte unchanged", async () => {
  const cacheStorage = new MemoryCacheStorage({ failStaging: true });
  await seed(cacheStorage, ACTIVE_CACHE, "/driver", "known-good-driver-shell");
  await seed(cacheStorage, ACTIVE_CACHE, "/unexpected-driver-entry", "known-good-extra");
  await seed(cacheStorage, ACTIVE_CACHE, OFFLINE_MODE_URL, "true");
  await seed(cacheStorage, "mbbs-driver-shell-v26", "/driver", "older-driver-shell");
  await seed(cacheStorage, "mbbs-yard-operator-v99", "/operator", "operator-shell");

  const reply = await sendRepair(createWorker(cacheStorage));

  assert.equal(reply.type, "DRIVER_REPAIR_SHELL_RESULT");
  assert.equal(reply.requestId, "repair-test");
  assert.equal(reply.ok, false);
  assert.equal(reply.version, "2026.08.12.3");
  assert.match(reply.error, /simulated iPhone staging failure/u);
  assert.equal(await readBody(cacheStorage, ACTIVE_CACHE, "/driver"), "known-good-driver-shell");
  assert.equal(await readBody(cacheStorage, ACTIVE_CACHE, "/unexpected-driver-entry"), "known-good-extra");
  assert.equal(await readBody(cacheStorage, ACTIVE_CACHE, OFFLINE_MODE_URL), "true");
  assert.equal(await readBody(cacheStorage, "mbbs-driver-shell-v26", "/driver"), "older-driver-shell");
  assert.equal(await readBody(cacheStorage, "mbbs-yard-operator-v99", "/operator"), "operator-shell");
  assert.deepEqual((await cacheStorage.keys()).sort(), [
    "mbbs-driver-shell-v26",
    ACTIVE_CACHE,
    "mbbs-yard-operator-v99"
  ]);
});

/* global DriverOfflineSync */
"use strict";

importScripts("/driver-offline-db.js?v=20260819-driver-route-readiness-v1");
importScripts("/driver-photo-hash.js?v=20260819-driver-route-readiness-v1");
importScripts("/driver-offline-sync.js?v=20260819-driver-route-readiness-v1");

const DRIVER_PWA_CLIENT_VERSION = "2026.08.12.3";
const DRIVER_CACHE_PREFIX = "mbbs-driver-shell-";
const DRIVER_CACHE_NAME = `${DRIVER_CACHE_PREFIX}v37`;
const DRIVER_REFRESH_CACHE_NAME = `${DRIVER_CACHE_PREFIX}refresh-v37`;
const DRIVER_OFFLINE_MODE_REQUEST = "/__mbbs_driver_offline_mode__";
const DRIVER_SHELL = [
  "/driver",
  "/driver.html",
  "/driver.css?v=20260819-driver-route-readiness-v1",
  "/i18n.css?v=20260819-driver-route-readiness-v1",
  "/i18n.js?v=20260819-driver-route-readiness-v1",
  "/driver-offline-db.js?v=20260819-driver-route-readiness-v1",
  "/driver-photo-hash.js?v=20260819-driver-route-readiness-v1",
  "/driver-offline-photos.js?v=20260819-driver-route-readiness-v1",
  "/driver-offline-sync.js?v=20260819-driver-route-readiness-v1",
  "/driver-bin-ui.js?v=20260819-driver-route-readiness-v1",
  "/driver-location-override.js?v=20260819-driver-route-readiness-v1",
  "/driver.js?v=20260819-driver-route-readiness-v1",
  "/driver-manifest.webmanifest",
  "/icons/mbbs-yard-192.png",
  "/icons/mbbs-yard-512.png",
  "/icons/mbbs-yard.svg"
];
const DRIVER_SHELL_URLS = new Set(DRIVER_SHELL.map((value) => new URL(value, self.location.origin).href));
let driverShellRepairPromise = null;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(DRIVER_CACHE_NAME).then(async (cache) => {
    await cache.addAll(DRIVER_SHELL.map((url) => new Request(
      new URL(url, self.location.origin),
      { cache: "reload" }
    )));
    await cache.put(DRIVER_OFFLINE_MODE_REQUEST, new Response("false", {
      headers: { "content-type": "text/plain", "cache-control": "no-store" }
    }));
  }));
  self.skipWaiting();
});

async function driverOfflineModeEnabled() {
  const cache = await caches.open(DRIVER_CACHE_NAME);
  const response = await cache.match(DRIVER_OFFLINE_MODE_REQUEST);
  return response ? (await response.text()) === "true" : false;
}

async function saveDriverOfflineMode(enabled) {
  const cache = await caches.open(DRIVER_CACHE_NAME);
  await cache.put(DRIVER_OFFLINE_MODE_REQUEST, new Response(String(enabled === true), {
    headers: { "content-type": "text/plain", "cache-control": "no-store" }
  }));
}

async function snapshotDriverCache(cache) {
  const snapshot = [];
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    if (response) snapshot.push([request, response]);
  }
  return snapshot;
}

async function restoreDriverCache(cache, snapshot) {
  for (const request of await cache.keys()) await cache.delete(request);
  for (const [request, response] of snapshot) await cache.put(request, response);
}

async function repairDriverShellCache() {
  const offlineModeEnabled = await driverOfflineModeEnabled();
  await caches.delete(DRIVER_REFRESH_CACHE_NAME);
  try {
    const staging = await caches.open(DRIVER_REFRESH_CACHE_NAME);
    await staging.addAll(DRIVER_SHELL.map((url) => new Request(
      new URL(url, self.location.origin),
      { cache: "reload" }
    )));

    const stagedEntries = [];
    for (const url of DRIVER_SHELL) {
      const request = new Request(new URL(url, self.location.origin));
      const response = await staging.match(request);
      if (!response || !response.ok) {
        throw new Error(`Driver shell staging incomplete: ${request.url}`);
      }
      stagedEntries.push([request, response]);
    }

    const active = await caches.open(DRIVER_CACHE_NAME);
    const previousEntries = await snapshotDriverCache(active);
    try {
      for (const [request, response] of stagedEntries) await active.put(request, response);
      const retainedUrls = new Set([
        ...DRIVER_SHELL_URLS,
        new URL(DRIVER_OFFLINE_MODE_REQUEST, self.location.origin).href
      ]);
      for (const request of await active.keys()) {
        if (!retainedUrls.has(request.url)) await active.delete(request);
      }
      await saveDriverOfflineMode(offlineModeEnabled);
    } catch (error) {
      await restoreDriverCache(active, previousEntries);
      throw error;
    }

    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(DRIVER_CACHE_PREFIX) && name !== DRIVER_CACHE_NAME)
      .map((name) => caches.delete(name)));
    return {
      cacheName: DRIVER_CACHE_NAME,
      refreshedAssetCount: stagedEntries.length
    };
  } finally {
    await caches.delete(DRIVER_REFRESH_CACHE_NAME);
  }
}

function currentDriverShellRepair() {
  if (driverShellRepairPromise) return driverShellRepairPromise;
  const operation = repairDriverShellCache();
  driverShellRepairPromise = operation;
  void operation.then(
    () => {
      if (driverShellRepairPromise === operation) driverShellRepairPromise = null;
    },
    () => {
      if (driverShellRepairPromise === operation) driverShellRepairPromise = null;
    }
  );
  return operation;
}

function replyToDriverMessage(event, payload) {
  if (event.ports?.[0]) event.ports[0].postMessage(payload);
  else event.source?.postMessage(payload);
}

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(DRIVER_CACHE_PREFIX) && name !== DRIVER_CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      client.postMessage({ type: "DRIVER_VERSION", version: DRIVER_PWA_CLIENT_VERSION });
    }
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "DRIVER_VERSION_REQUEST") {
    event.source?.postMessage({ type: "DRIVER_VERSION", version: DRIVER_PWA_CLIENT_VERSION });
  }
  if (event.data?.type === "DRIVER_OFFLINE_MODE") {
    event.waitUntil(saveDriverOfflineMode(event.data.enabled === true));
  }
  if (event.data?.type === "DRIVER_SYNC_NOW") {
    event.waitUntil(DriverOfflineSync.syncAll());
  }
  if (event.data?.type === "DRIVER_LOCK_PARTITION" && event.data.partitionKey) {
    DriverOfflineSync.cancelPartition(event.data.partitionKey);
  }
  if (event.data?.type === "DRIVER_REFRESH_SHELL") {
    event.waitUntil(currentDriverShellRepair());
  }
  if (event.data?.type === "DRIVER_REPAIR_SHELL") {
    const requestId = String(event.data.requestId || "");
    event.waitUntil(currentDriverShellRepair()
      .then((result) => replyToDriverMessage(event, {
        type: "DRIVER_REPAIR_SHELL_RESULT",
        requestId,
        ok: true,
        version: DRIVER_PWA_CLIENT_VERSION,
        ...result
      }))
      .catch((error) => replyToDriverMessage(event, {
        type: "DRIVER_REPAIR_SHELL_RESULT",
        requestId,
        ok: false,
        version: DRIVER_PWA_CLIENT_VERSION,
        error: String(error?.message || error || "Driver shell repair failed.")
      })));
  }
});

self.addEventListener("sync", (event) => {
  if (event.tag === "driver-offline-sync") {
    event.waitUntil(DriverOfflineSync.syncAll());
  }
});

self.addEventListener("push", (event) => {
  let requestId = "";
  try {
    const payload = event.data?.json?.() || {};
    if (/^[0-9a-f-]{36}$/iu.test(String(payload.requestId || ""))) {
      requestId = String(payload.requestId);
    }
  } catch {
    requestId = "";
  }
  const routeUrl = `/driver?route-change=${encodeURIComponent(requestId)}`;
  event.waitUntil(self.registration.showNotification("Route update needs your attention", {
    body: "Open MBBS Driver and confirm readiness.",
    tag: requestId ? `driver-route-${requestId}` : "driver-route-update",
    renotify: true,
    requireInteraction: true,
    icon: "/icons/mbbs-yard-192.png",
    badge: "/icons/mbbs-yard-192.png",
    data: { routeUrl }
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const routeUrl = String(event.notification.data?.routeUrl || "/driver");
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).pathname.startsWith("/driver"));
    if (existing) {
      await existing.navigate(routeUrl);
      return existing.focus();
    }
    return self.clients.openWindow(routeUrl);
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (
    request.mode === "navigate"
    && ["/driver", "/driver.html"].includes(url.pathname)
  ) {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(DRIVER_CACHE_NAME);
            await cache.put("/driver", response.clone());
          }
          return response;
        })
        .catch(async () => {
          if (!(await driverOfflineModeEnabled())) return Response.error();
          const cache = await caches.open(DRIVER_CACHE_NAME);
          return (await cache.match("/driver")) || (await cache.match("/driver.html"));
        })
    );
    return;
  }

  if (!DRIVER_SHELL_URLS.has(url.href)) return;
  event.respondWith(
    caches.open(DRIVER_CACHE_NAME)
      .then((cache) => cache.match(request))
      .then((cached) => cached || fetch(request))
  );
});

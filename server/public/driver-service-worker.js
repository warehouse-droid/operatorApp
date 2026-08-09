/* global DriverOfflineSync */
"use strict";

importScripts("/driver-offline-db.js?v=20260808-yard-dependency-v1");
importScripts("/driver-photo-hash.js?v=20260808-yard-dependency-v1");
importScripts("/driver-offline-sync.js?v=20260808-yard-dependency-v1");

const DRIVER_PWA_CLIENT_VERSION = "2026.08.08.1";
const DRIVER_CACHE_PREFIX = "mbbs-driver-shell-";
const DRIVER_CACHE_NAME = `${DRIVER_CACHE_PREFIX}v20`;
const DRIVER_REFRESH_CACHE_NAME = `${DRIVER_CACHE_PREFIX}refresh-v20`;
const DRIVER_OFFLINE_MODE_REQUEST = "/__mbbs_driver_offline_mode__";
const DRIVER_SHELL = [
  "/driver",
  "/driver.html",
  "/driver.css?v=20260808-yard-dependency-v1",
  "/i18n.css?v=20260701-i18n-v2",
  "/i18n.js?v=20260803-bin-pwa-v1",
  "/driver-offline-db.js?v=20260808-yard-dependency-v1",
  "/driver-photo-hash.js?v=20260808-yard-dependency-v1",
  "/driver-offline-photos.js?v=20260808-yard-dependency-v1",
  "/driver-offline-sync.js?v=20260808-yard-dependency-v1",
  "/driver-bin-ui.js?v=20260803-bin-pwa-v1",
  "/driver.js?v=20260808-yard-dependency-v1",
  "/driver-manifest.webmanifest",
  "/icons/mbbs-yard-192.png",
  "/icons/mbbs-yard-512.png",
  "/icons/mbbs-yard.svg"
];
const DRIVER_SHELL_URLS = new Set(DRIVER_SHELL.map((value) => new URL(value, self.location.origin).href));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(DRIVER_CACHE_NAME).then(async (cache) => {
    await cache.addAll(DRIVER_SHELL);
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
    event.waitUntil((async () => {
      await caches.delete(DRIVER_REFRESH_CACHE_NAME);
      const cache = await caches.open(DRIVER_REFRESH_CACHE_NAME);
      await cache.addAll(DRIVER_SHELL.map((url) => new Request(
        new URL(url, self.location.origin),
        { cache: "reload" }
      )));
      const active = await caches.open(DRIVER_CACHE_NAME);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        if (response) await active.put(request, response);
      }
      await caches.delete(DRIVER_REFRESH_CACHE_NAME);
      const names = await caches.keys();
      await Promise.all(names
        .filter((name) => name.startsWith(DRIVER_CACHE_PREFIX) && name !== DRIVER_CACHE_NAME)
        .map((name) => caches.delete(name)));
    })());
  }
});

self.addEventListener("sync", (event) => {
  if (event.tag === "driver-offline-sync") event.waitUntil(DriverOfflineSync.syncAll());
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

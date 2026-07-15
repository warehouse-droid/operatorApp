const CACHE_NAME = "mbbs-yard-operator-v103-batch-switch";
const APP_SHELL = [
  "/operator",
  "/operator.html",
  "/operator.css?v=20260713-consolidation-review-v3",
  "/i18n.css?v=20260701-i18n-v2",
  "/i18n.js?v=20260713-consolidation-review-v3",
  "/operator.js?v=20260715-batch-switch-v1",
  "/driver",
  "/driver.html",
  "/driver.css?v=20260702-camera-v3",
  "/driver.js?v=20260707-rest-after-v1",
  "/manifest.webmanifest",
  "/driver-manifest.webmanifest",
  "/icons/mbbs-yard-192.png",
  "/icons/mbbs-yard-512.png",
  "/icons/mbbs-yard.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "SHOW_NOTIFICATION") {
    event.waitUntil(self.registration.showNotification(
      event.data.title || "Delivery Prep",
      event.data.options || {}
    ));
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/operator";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => {
      try {
        return new URL(client.url).pathname === targetUrl;
      } catch {
        return false;
      }
    });
    if (existing) {
      existing.postMessage({ type: "OPEN_URGENT_DELIVERY_ALERT" });
      return existing.focus();
    }
    return self.clients.openWindow(targetUrl);
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match(url.pathname.startsWith("/driver") ? "/driver" : "/operator")))
  );
});

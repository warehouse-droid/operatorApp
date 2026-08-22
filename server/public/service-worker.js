const CACHE_NAME = "mbbs-yard-operator-v141-page-confirm-v1";
const OPERATOR_CACHE_PREFIX = "mbbs-yard-operator-";
const APP_SHELL = [
  "/operator",
  "/operator.html",
  "/operator.css?v=20260815-page-confirm-v1",
  "/i18n.css?v=20260701-i18n-v2",
  "/vendor/quagga2/quagga.min.js?v=1.12.1",
  "/i18n.js?v=20260815-customer-pickup-photo-gate-v1",
  "/operator.js?v=20260815-operator-page-confirm-v1",
  "/manifest.webmanifest",
  "/icons/mbbs-yard-192.png",
  "/icons/mbbs-yard-512.png",
  "/icons/mbbs-yard.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL.map((url) => new Request(
    new URL(url, self.location.origin),
    { cache: "reload" }
  )))));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(OPERATOR_CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
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
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  const driverAsset = url.pathname === "/driver"
    || url.pathname === "/driver.html"
    || url.pathname === "/driver.css"
    || url.pathname === "/driver.js"
    || url.pathname === "/driver-manifest.webmanifest"
    || url.pathname === "/driver-service-worker.js"
    || url.pathname.startsWith("/driver-");
  if (event.request.method !== "GET" || url.pathname.startsWith("/api/") || driverAsset) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => undefined);
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/operator")))
  );
});

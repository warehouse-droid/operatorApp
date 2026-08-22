import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, client, css, worker, server, repository, service, packageJson] = await Promise.all([
  "../../../public/driver.html",
  "../../../public/driver.js",
  "../../../public/driver.css",
  "../../../public/driver-service-worker.js",
  "../../../src/server.js",
  "../../../src/driver-offline-repository.js",
  "../../../src/driver-route-change-service.js",
  "../../../package.json"
].map((path) => readFile(new URL(path, import.meta.url), "utf8")));

test("Driver route changes use a visible heartbeat and an explicit readiness acknowledgement", () => {
  assert.match(html, /id="driverRouteChangeStatus"/u);
  assert.match(css, /driver-route-change-status/u);
  assert.match(client, /DRIVER_ROUTE_PRESENCE_INTERVAL_MS\s*=\s*10_000/u);
  assert.match(client, /\/api\/driver\/route-presence/u);
  assert.match(client, /\/api\/driver\/route-change-requests/u);
  assert.match(client, /data-action="acknowledge-driver-route-change"/u);
  assert.match(client, /document\.visibilityState\s*===\s*"visible"/u);
  assert.match(client, /pendingEventCount/u);
  assert.match(client, /pendingPhotoCount/u);
  assert.match(client, /activeJobId/u);
  assert.match(client, /manifestId/u);
  assert.doesNotMatch(client, /auto(?:matically)?(?:Apply|Acknowledge)RouteChange/iu);
});

test("Driver readiness endpoints derive identity from the authenticated session and device header", () => {
  assert.match(server, /app\.post\("\/api\/driver\/route-presence", requireDriver/u);
  assert.match(server, /app\.get\("\/api\/driver\/route-change-requests", requireDriver/u);
  assert.match(server, /app\.post\("\/api\/driver\/route-change-requests\/:requestId\/ready", requireDriver/u);
  assert.match(server, /assertAuthenticatedDriverDevice/u);
  assert.match(service, /DRIVER_ROUTE_READINESS_TTL_MS\s*=\s*2\s*\*\s*60\s*\*\s*1000/u);
  assert.match(service, /DRIVER_ROUTE_DEVICE_NOT_VISIBLE/u);
  assert.match(service, /DRIVER_ROUTE_SYNC_NOT_CLEAN/u);
  assert.match(service, /DRIVER_ROUTE_ACTIVITY_ACTIVE/u);
  assert.match(service, /DRIVER_ROUTE_MANIFEST_MISMATCH/u);
  assert.match(service, /acknowledgeScmDependencyChangeRequest/u);
});

test("Web Push is optional, visible, generic, and never installs a route silently", () => {
  const parsed = JSON.parse(packageJson);
  assert.equal(parsed.dependencies["web-push"], "3.6.7");
  assert.match(server, /\/api\/driver\/route-push\/public-key/u);
  assert.match(server, /\/api\/driver\/route-push\/subscription/u);
  assert.match(worker, /addEventListener\("push"/u);
  assert.match(worker, /showNotification/u);
  assert.match(worker, /addEventListener\("notificationclick"/u);
  assert.match(worker, /\/driver\?route-change=/u);
  assert.doesNotMatch(worker, /customer|address|orderRef|orderNumber/iu);
});

test("superseded manifests are a hard operational fence while preserving review evidence", () => {
  assert.match(repository, /supersededAt:\s*row\.superseded_at/u);
  assert.match(repository, /m\.superseded_at IS NULL/u);
  assert.match(repository, /Route superseded[\s\S]{0,260}operational effects are blocked/u);
  assert.match(server, /DRIVER_ROUTE_SUPERSEDED/u);
});

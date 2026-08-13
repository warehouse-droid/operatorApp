import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import {
  DRIVER_PWA_CURRENT_VERSION,
  DRIVER_PWA_MINIMUM_VERSION,
  DRIVER_PWA_VERSION_HEADER,
  compareDriverPwaVersions,
  driverPwaVersionDetails,
  driverPwaVersionGate,
  driverPwaVersionIsSupported
} from "./driver-client-version.js";

assert.equal(DRIVER_PWA_VERSION_HEADER, "X-MBBS-Driver-Version");
assert.equal(DRIVER_PWA_CURRENT_VERSION, "2026.08.12.3");
assert.equal(DRIVER_PWA_MINIMUM_VERSION, DRIVER_PWA_CURRENT_VERSION);
assert.equal(compareDriverPwaVersions("2026.08.12.3", "2026.08.12.3"), 0);
assert.equal(compareDriverPwaVersions("2026.08.12.4", "2026.08.12.3"), 1);
assert.equal(compareDriverPwaVersions("2026.08.12.2", "2026.08.12.3"), -1);
assert.equal(compareDriverPwaVersions("not-a-version", "2026.08.12.3"), null);
assert.equal(compareDriverPwaVersions("999999999999999999999.1", "2026.08.12.3"), null);
assert.equal(driverPwaVersionIsSupported(DRIVER_PWA_CURRENT_VERSION), true);
assert.equal(driverPwaVersionIsSupported("2026.08.11.4"), false);
assert.equal(driverPwaVersionIsSupported("2026.08.03.1"), false);
assert.equal(driverPwaVersionIsSupported(""), false);
assert.deepEqual(driverPwaVersionDetails(""), {
  currentVersion: DRIVER_PWA_CURRENT_VERSION,
  minimumVersion: DRIVER_PWA_MINIMUM_VERSION,
  clientVersion: null,
  isCurrent: false,
  supported: false,
  updateRequired: true,
  reopenRequired: true,
  headerName: DRIVER_PWA_VERSION_HEADER
});

function runGate(path, version) {
  const response = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    }
  };
  let nextCalled = false;
  driverPwaVersionGate({
    path,
    headers: version ? { "x-mbbs-driver-version": version } : {},
    get(name) {
      return name.toLowerCase() === "x-mbbs-driver-version" ? version : undefined;
    }
  }, response, () => {
    nextCalled = true;
  });
  return { response, nextCalled };
}

for (const path of [
  "/client-version",
  "/network-health",
  "/login",
  "/me",
  "/logout",
  "/sync-status",
  "/offline-sync",
  "/photo-upload-token"
]) {
  const result = runGate(path, undefined);
  assert.equal(result.nextCalled, true, `${path} must remain available without a client version.`);
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.response.headers["X-MBBS-Driver-Current-Version"], DRIVER_PWA_CURRENT_VERSION);
  assert.equal(result.response.headers["X-MBBS-Driver-Minimum-Version"], DRIVER_PWA_MINIMUM_VERSION);
}

for (const path of [
  "/day-plan",
  "/day-state",
  "/history",
  "/next-job",
  "/jobs/job-1/delivery-instructions",
  "/dvir",
  "/rest/start",
  "/jobs/job-1/start",
  "/jobs/job-1/photos",
  "/offline-events/event-1/reconcile-duty"
]) {
  const missing = runGate(path, undefined);
  assert.equal(missing.nextCalled, false, `${path} must reject a missing version.`);
  assert.equal(missing.response.statusCode, 426);
  assert.equal(missing.response.body.code, "DRIVER_PWA_UPDATE_REQUIRED");
  assert.equal(missing.response.body.currentVersion, DRIVER_PWA_CURRENT_VERSION);
  assert.equal(missing.response.body.minimumVersion, DRIVER_PWA_MINIMUM_VERSION);
  assert.equal(missing.response.body.reopenRequired, true);
  assert.equal(missing.response.body.preserveLocalEvidence, true);
  assert.match(missing.response.body.guidance, /Do not clear browser data/);

  const old = runGate(path, "2026.08.03.0");
  assert.equal(old.nextCalled, false, `${path} must reject an old version.`);
  assert.equal(old.response.statusCode, 426);

  const current = runGate(path, DRIVER_PWA_CURRENT_VERSION);
  assert.equal(current.nextCalled, true, `${path} must accept the current version.`);
  assert.equal(current.response.statusCode, 200);
}

const serverSource = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");
assert.match(serverSource, /app\.use\("\/api\/driver", driverPwaVersionGate\);/);
assert.match(serverSource, /app\.get\("\/api\/driver\/client-version"/);
assert.match(serverSource, /res\.setHeader\("Cache-Control", "no-store"\)/);
assert.ok(
  serverSource.indexOf('app.use("/api/driver", driverPwaVersionGate);')
    < serverSource.indexOf('app.post("/api/driver/offline-sync"'),
  "The version middleware must run before offline synchronization so it can advertise the current version."
);
assert.ok(
  serverSource.indexOf('app.use("/api/driver", driverPwaVersionGate);')
    < serverSource.indexOf('app.post("/api/driver/photo-upload-token"'),
  "The version middleware must run before photo-token issuance so it can advertise the current version."
);

const driverSource = fs.readFileSync(new URL("../public/driver.js", import.meta.url), "utf8");
const offlineSyncSource = fs.readFileSync(new URL("../public/driver-offline-sync.js", import.meta.url), "utf8");
const workerSource = fs.readFileSync(new URL("../public/driver-service-worker.js", import.meta.url), "utf8");
const driverHtml = fs.readFileSync(new URL("../public/driver.html", import.meta.url), "utf8");
const driverCss = fs.readFileSync(new URL("../public/driver.css", import.meta.url), "utf8");

for (const source of [driverSource, offlineSyncSource, workerSource]) {
  assert.match(source, /DRIVER_PWA_CLIENT_VERSION\s*=\s*"2026\.08\.12\.3"/);
}
assert.match(driverSource, /DRIVER_PWA_VERSION_HEADER\s*=\s*"X-MBBS-Driver-Version"/);
assert.match(
  driverSource,
  /async function request[\s\S]*\[DRIVER_PWA_VERSION_HEADER\]: DRIVER_PWA_CLIENT_VERSION/
);
assert.match(driverSource, /response\.status === 426[\s\S]*requireDriverPwaUpdate/);
assert.match(driverSource, /DRIVER_PWA_UPDATE_MARKER_KEY[\s\S]*localStorage\.setItem/);
assert.match(driverSource, /driver\.pwaUpdateTitle[\s\S]*driver\.pwaUpdateEvidenceProtected/);
const updateLatchSource = driverSource.slice(
  driverSource.indexOf("function requireDriverPwaUpdate"),
  driverSource.indexOf("async function checkDriverPwaVersion")
);
assert.doesNotMatch(
  updateLatchSource,
  /clearDriverSessionMemory|lockPartition|lockActivePartition|clearSavedRouteCache|DriverOfflineDB\.delete/,
  "A required update must block new actions without clearing, locking, or deleting saved evidence."
);
assert.match(driverSource, /checkDriverPwaVersion\(\{ force: true, reason: source \}\)/);
assert.match(driverSource, /window\.addEventListener\("pageshow"[\s\S]*resumeOnlineDriver\("pageshow"\)/);
assert.match(driverSource, /document\.addEventListener\("visibilitychange"[\s\S]*resumeOnlineDriver\("visibility"\)/);
assert.match(driverSource, /navigator\.serviceWorker\.addEventListener\("controllerchange"/);
assert.match(driverSource, /updateViaCache: "none"/);
assert.match(driverSource, /String\(savedJob\.fingerprint\) !== currentFingerprint/);
assert.match(offlineSyncSource, /\[DRIVER_PWA_VERSION_HEADER\]: DRIVER_PWA_CLIENT_VERSION/);
assert.match(workerSource, /DRIVER_CACHE_NAME = `\$\{DRIVER_CACHE_PREFIX\}v27`/);
assert.match(workerSource, /DRIVER_REFRESH_CACHE_NAME = `\$\{DRIVER_CACHE_PREFIX\}refresh-v27`/);
assert.match(workerSource, /DRIVER_VERSION_REQUEST/);
assert.match(workerSource, /type: "DRIVER_VERSION", version: DRIVER_PWA_CLIENT_VERSION/);
for (const asset of [
  "driver.css",
  "i18n.css",
  "i18n.js",
  "driver-offline-db.js",
  "driver-photo-hash.js",
  "driver-offline-photos.js",
  "driver-offline-sync.js",
  "driver-bin-ui.js",
  "driver.js"
]) {
  assert.ok(
    workerSource.includes(`/${asset}?v=20260812-driver-pwa-v3`),
    `${asset} must use the atomic v3 token in the worker shell.`
  );
  assert.ok(
    driverHtml.includes(`/${asset}?v=20260812-driver-pwa-v3`),
    `${asset} must use the atomic v3 token in the Driver page.`
  );
}
assert.match(
  driverSource,
  /serviceWorker\.register\("\/driver-service-worker\.js\?v=20260812-driver-pwa-v3"/
);
assert.match(driverCss, /\.driver-pwa-update-screen[\s\S]*\.driver-pwa-update-card/);

const mountedApp = express();
mountedApp.use("/api/driver", driverPwaVersionGate);
mountedApp.get("/api/driver/client-version", (_req, res) => res.json({ ok: true }));
mountedApp.get("/api/driver/next-job", (_req, res) => res.json({ ok: true }));
mountedApp.post("/api/driver/offline-sync", (_req, res) => res.json({ ok: true }));
const listener = await new Promise((resolve) => {
  const candidate = mountedApp.listen(0, "127.0.0.1", () => resolve(candidate));
});
try {
  const origin = `http://127.0.0.1:${listener.address().port}`;
  let response = await fetch(`${origin}/api/driver/client-version`);
  assert.equal(response.status, 200, "The mounted version endpoint must remain public.");

  response = await fetch(`${origin}/api/driver/next-job`);
  assert.equal(response.status, 426, "A mounted operational route must reject a missing version.");
  const rejected = await response.json();
  assert.equal(rejected.code, "DRIVER_PWA_UPDATE_REQUIRED");

  response = await fetch(`${origin}/api/driver/next-job`, {
    headers: { [DRIVER_PWA_VERSION_HEADER]: DRIVER_PWA_CURRENT_VERSION }
  });
  assert.equal(response.status, 200, "A mounted operational route must accept the current version.");

  response = await fetch(`${origin}/api/driver/offline-sync`, { method: "POST" });
  assert.equal(response.status, 200, "An old worker must still be able to drain saved offline evidence.");
  assert.equal(response.headers.get("x-mbbs-driver-current-version"), DRIVER_PWA_CURRENT_VERSION);
} finally {
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
}

console.log("Driver PWA client version gate harness passed.");

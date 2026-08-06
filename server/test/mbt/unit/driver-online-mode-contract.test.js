import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  DRIVER_OFFLINE_MODE_FLAG_KEY,
  getDriverOfflineMode
} from "../../../src/driver-mode-repository.js";
import { materializeMbtAdminGates } from "../../../src/mbt/feature-gate-catalog.js";

const publicSource = fs.readFileSync(new URL("../../../public/driver.js", import.meta.url), "utf8");
const workerSource = fs.readFileSync(new URL("../../../public/driver-service-worker.js", import.meta.url), "utf8");
const serverSource = fs.readFileSync(new URL("../../../src/server.js", import.meta.url), "utf8");
const migrationSource = fs.readFileSync(
  new URL("../../../migrations/133_driver_pwa_offline_mode.sql", import.meta.url),
  "utf8"
);

test("Driver offline mode is an Admin-owned, fail-closed setting independent of MBT deployment gates", async () => {
  assert.equal(DRIVER_OFFLINE_MODE_FLAG_KEY, "driver_offline_mode");
  assert.match(migrationSource, /'driver_offline_mode'\s*,\s*false/u);

  const missing = await getDriverOfflineMode({
    queryFn: async () => ({ rowCount: 0, rows: [] })
  });
  assert.deepEqual(missing, {
    enabled: false,
    revision: null,
    updatedAt: null
  });

  const enabled = await getDriverOfflineMode({
    queryFn: async () => ({
      rowCount: 1,
      rows: [{ enabled: true, revision: "7", updated_at: "2026-08-05T12:00:00.000Z" }]
    })
  });
  assert.deepEqual(enabled, {
    enabled: true,
    revision: 7,
    updatedAt: "2026-08-05T12:00:00.000Z"
  });

  const gates = materializeMbtAdminGates({
    flags: [{
      flagKey: DRIVER_OFFLINE_MODE_FLAG_KEY,
      enabled: true,
      revision: 7,
      updatedBy: "admin",
      updatedAt: "2026-08-05T12:00:00.000Z"
    }],
    environment: { enabled: false }
  });
  const gate = gates.find((candidate) => candidate.flagKey === DRIVER_OFFLINE_MODE_FLAG_KEY);
  assert.equal(gate?.configured, true);
  assert.equal(gate?.environmentAllowed, true);
  assert.equal(gate?.effective, true);
  assert.equal(gate?.locked, false);
});

test("server advertises and enforces online-only mode without blocking recovery sync", () => {
  assert.match(
    serverSource,
    /app\.get\("\/api\/driver\/client-version"[\s\S]*getDriverOfflineMode[\s\S]*offlineEnabled/u
  );
  assert.match(
    serverSource,
    /app\.get\("\/api\/driver\/day-plan"[\s\S]*DRIVER_OFFLINE_MODE_DISABLED/u
  );
  assert.match(serverSource, /app\.post\("\/api\/driver\/jobs\/:jobId\/bin\/start"/u);
  assert.match(serverSource, /app\.post\("\/api\/driver\/jobs\/:jobId\/bin\/complete"/u);
  const onlineBinApplication = serverSource.match(
    /async function applyDriverOnlineBinEvent[\s\S]*?\n\}/u
  )?.[0] || "";
  assert.match(
    onlineBinApplication,
    /verifyDriverOfflinePhotoObject[\s\S]*applyMbtDriverBinOfflineEvent/u
  );
  assert.match(
    onlineBinApplication,
    /mbt_driver_bin_event_applications[\s\S]*existing\.device_occurred_at[\s\S]*existing\.server_received_at/u
  );
  assert.match(onlineBinApplication, /manifestId:\s*eventId/u);
  assert.match(
    serverSource,
    /app\.post\("\/api\/driver\/jobs\/:jobId\/bin\/complete"[\s\S]*applyDriverOnlineBinEvent\(req, "job_completed"\)/u
  );

  const syncRoute = serverSource.match(
    /app\.post\("\/api\/driver\/offline-sync"[\s\S]*?\n\}\);/u
  )?.[0] || "";
  assert.ok(syncRoute, "The retained-evidence recovery endpoint must remain present.");
  assert.doesNotMatch(syncRoute, /DRIVER_OFFLINE_MODE_DISABLED/u);
});

test("online-only client records no new route or photo evidence in IndexedDB", () => {
  assert.match(publicSource, /let driverOfflineModeEnabled = false/u);
  assert.match(
    publicSource,
    /function driverActionProtectionState\(\)[\s\S]*!driverOfflineModeEnabled[\s\S]*navigator\.onLine/u
  );
  assert.match(
    publicSource,
    /function canUseOfflineLedger\(\)[\s\S]*driverOfflineModeEnabled[\s\S]*offlineStorageAvailable/u
  );
  assert.match(
    publicSource,
    /if \(driverOfflineModeEnabled && offlineStorageAvailable && capturePartitionKey\)[\s\S]*captureAndStore[\s\S]*else \{[\s\S]*DriverOfflinePhotos\.compress/u
  );
  assert.match(publicSource, /\/jobs\/\$\{encodeURIComponent\(startedJob\.jobId\)\}\/bin\/start/u);
  assert.match(publicSource, /\/jobs\/\$\{encodeURIComponent\(completedJob\.jobId\)\}\/bin\/complete/u);
});

test("service worker serves a saved Driver route only when the last server mode enables it", () => {
  assert.match(workerSource, /DRIVER_OFFLINE_MODE/u);
  assert.match(workerSource, /async function driverOfflineModeEnabled/u);
  assert.match(
    workerSource,
    /catch\(async \(\) => \{[\s\S]*driverOfflineModeEnabled\(\)[\s\S]*return Response\.error\(\)/u
  );
});

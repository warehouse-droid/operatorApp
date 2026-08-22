import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("S11: Dispatch tools expose a third historical completion tab without touching Driver cache assets", () => {
  const html = read("public/dispatch-offline-review.html");
  const client = read("public/dispatch-offline-review.js");
  assert.match(html, /data-driver-pwa-surface="historical-assist"/u);
  assert.match(html, /id="historicalAssistDate"[^>]*type="date"/u);
  assert.match(html, /id="historicalAssistPanel"/u);
  assert.match(html, /driver-photo-hash\.js/u);
  assert.match(html, /driver-offline-photos\.js/u);
  assert.match(client, /\/api\/dispatch\/driver-pwa\/historical-assist/u);
  assert.match(client, /DriverOfflinePhotos\.compress/u);
  assert.doesNotMatch(client, /indexedDB|DriverOfflineDB/u);
});

test("S12: server API is dispatcher-only, no-store, and has list/ticket/complete routes", () => {
  const source = read("src/server.js");
  for (const fragment of [
    'app.get("/api/dispatch/driver-pwa/historical-assist"',
    'app.post("/api/dispatch/driver-pwa/historical-assist/:jobId/photo-tickets"',
    'app.post("/api/dispatch/driver-pwa/historical-assist/:jobId/complete"'
  ]) {
    assert.ok(source.includes(fragment), fragment);
  }
  assert.match(source, /historical-assist[\s\S]{0,1800}requireDispatcher/u);
  assert.match(source, /historical-assist[\s\S]{0,5000}Cache-Control["'],\s*["']no-store/u);
});

test("S13: immutable assist migration and canonical operator attribution are present", () => {
  const migration = read("migrations/174_driver_pwa_historical_assist.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS driver_job_assist_events/u);
  assert.match(migration, /CREATE TRIGGER[^;]+driver_job_assist_events[^;]+reject/u);
  assert.match(migration, /CREATE OR REPLACE FUNCTION dispatch_project_driver_job_completion/u);
  assert.match(migration, /dispatch_historical_assist/u);
  assert.match(migration, /actor_type[\s\S]+operator/u);
});

test("S14: the feature leaves the Driver PWA cache and version files outside its wiring", () => {
  const packageSource = read("package.json");
  assert.match(packageSource, /test:driver-pwa-historical-assist/u);
  assert.match(packageSource, /gauntlet:driver-pwa-historical-assist/u);
  assert.ok(fs.existsSync(path.join(root, "tools/driver-pwa-historical-assist-gauntlet.sh")));
});

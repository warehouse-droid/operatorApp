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

test("S31: Historical completion and completed-stop append expose the same accessible drop-zone contract", () => {
  const client = read("public/dispatch-offline-review.js");
  const styles = read("public/dispatch-offline-review.css");
  assert.match(client, /data-photo-drop-zone=["']historical-assist["']/u);
  assert.match(client, /data-photo-drop-zone=["']completed-stop["']/u);
  assert.match(client, /addEventListener\(["']dragover["']/u);
  assert.match(client, /addEventListener\(["']dragleave["']/u);
  assert.match(client, /addEventListener\(["']drop["']/u);
  assert.match(client, /historicalAssistAddPhotoFiles/u);
  assert.match(client, /driverPwaAddCompletedPhotoFiles/u);
  assert.match(styles, /\.driver-photo-drop-zone\.drag-active/u);
});

test("S32: completed physical-visit routes and immutable addition ledger are wired without replacing legacy stop APIs", () => {
  const source = read("src/server.js");
  const archive = read("src/photo-archive-repository.js");
  const migrationPath = path.join(root, "migrations/194_driver_completed_stop_photo_evidence.sql");
  assert.ok(fs.existsSync(migrationPath), "Migration 194 must exist.");
  const migration = read("migrations/194_driver_completed_stop_photo_evidence.sql");
  for (const fragment of [
    'app.get("/api/dispatch/driver-pwa/visits"',
    'app.get("/api/dispatch/driver-pwa/visits/:recordId"',
    'app.get("/api/dispatch/driver-pwa/visits/:recordId/photos/:ordinal"',
    'app.post("/api/dispatch/driver-pwa/visits/:recordId/photo-tickets"',
    'app.post("/api/dispatch/driver-pwa/visits/:recordId/photos"'
  ]) {
    assert.ok(source.includes(fragment), fragment);
  }
  assert.ok(source.includes('app.get("/api/dispatch/driver-pwa/stops"'), "Legacy stop list must remain.");
  assert.match(source, /source:\s*["']dispatch-stop-evidence["']/u);
  assert.match(source, /emitAppEvent\(["']driver\.stop\.photos_added["']/u);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS driver_job_photo_addition_events/u);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON driver_job_photo_addition_events/u);
  assert.match(archive, /driver_job_photo_addition_events["'],\s*column:\s*["']photo_references/u);
});

test("S33: reopened photos are retained, exposed to Driver online/offline jobs, and count toward completion", () => {
  const stopRepository = read("src/driver-pwa-repository.js");
  const driverRepository = read("src/driver-repository.js");
  const offlineRepository = read("src/driver-offline-repository.js");
  const driverClient = read("public/driver.js");
  const driverServer = read("src/server.js");
  const reopenSection = stopRepository.slice(stopRepository.indexOf("export async function reopenDriverPwaStop"));
  assert.doesNotMatch(reopenSection, /photo_data_urls\s*=\s*'\[\]'::jsonb/u);
  assert.match(reopenSection, /physicalVisitJobIds/u);
  assert.match(driverRepository, /retainedPhotoReferences/u);
  assert.match(driverRepository, /remainingRequiredPhotos/u);
  assert.match(offlineRepository, /retainedPhotoReferences/u);
  assert.match(driverClient, /Retained from previous completion/u);
  assert.match(driverClient, /remainingRequiredPhotos/u);
  assert.match(driverClient, /prepareRetainedCompletionPhotos/u);
  assert.match(driverClient, /cacheInstructionMedia/u);
  assert.match(driverClient, /driverRetainedPhotoPreview/u);
  assert.match(driverServer, /\/api\/driver\/jobs\/:jobId\/retained-photos\/:ordinal/u);
});

test("S42: completed-stop evidence UI is filterable, append-only, stale-safe, and uses bounded uploads", () => {
  const client = read("public/dispatch-offline-review.js");
  for (const fragment of [
    "driverPwaCompletedFilters",
    'name="driverLogin"',
    'name="status"',
    'name="stopType"',
    'name="photoState"',
    'name="completionSource"',
    'name="q"',
    "driverPwaCompletedCaptureVisibleDraft",
    "driverPwaRevalidateCompletedDraft",
    "expectedStateHash",
    "additionEventId",
    "historicalAssistMapConcurrency(pending, 2",
    "Photos already committed are read only"
  ]) {
    assert.ok(client.includes(fragment), fragment);
  }
  assert.match(client, /data-form=["']completed-stop-photo-append["']/u);
  assert.match(client, /name=["']reason["'][^>]*required/u);
  assert.match(client, /name=["']confirmAddition["'][^>]*required/u);
  assert.match(client, /DRIVER_PWA_VISITS_ENDPOINT/u);
  assert.match(client, /driver\.stop\.photos_added/u);
});

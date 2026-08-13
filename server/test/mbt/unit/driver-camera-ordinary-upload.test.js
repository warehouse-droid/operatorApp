import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (relativePath) => fs.readFileSync(
  new URL(`../../../${relativePath}`, import.meta.url),
  "utf8"
);

const driver = read("public/driver.js");
const driverHtml = read("public/driver.html");
const worker = read("public/driver-service-worker.js");
const offlineDb = read("public/driver-offline-db.js");
const server = read("src/server.js");
const featureCatalog = read("src/mbt/feature-gate-catalog.js");

test("Driver retains ordinary Camera and Gallery evidence inputs", () => {
  assert.match(driver, /data-photo-source="camera"[^>]*capture="\$\{cameraCaptureMode\(\)\}"/u);
  assert.match(driver, /data-photo-source="gallery"[^>]*type="file" accept="image\/\*"/u);
  assert.match(driver, /data-dvir-photo-index="\$\{index\}" data-photo-source="camera"/u);
  assert.match(driver, /data-dvir-photo-index="\$\{index\}" data-photo-source="gallery"/u);

  const changeHandler = driver.slice(
    driver.indexOf('app.addEventListener("change"'),
    driver.indexOf('app.addEventListener("submit"')
  );
  assert.match(changeHandler, /const selectedInput = dvirInput \|\| input/u);
  assert.match(changeHandler, /DriverOfflinePhotos\.captureAndStore|DriverOfflinePhotos\.compress/u);
  assert.doesNotMatch(changeHandler, /cameraDeviceCopy|CameraOriginal|showDirectoryPicker|\.download\s*=/u);
});

test("Driver shell has no copy, folder picker, download, or original-backup path", () => {
  const source = [driver, driverHtml, worker, offlineDb, server, featureCatalog].join("\n");
  assert.doesNotMatch(source, /DriverDevicePhotoCopy|driver-device-photo-copy|showDirectoryPicker/u);
  assert.doesNotMatch(source, /DriverCameraOriginalBackup|driver-camera-original-backup|cameraOriginals/u);
  assert.doesNotMatch(source, /cameraDeviceCopyEnabled|driver_camera_device_copy/u);
  assert.doesNotMatch(driver, /createElement\(["']a["']\)|\.download\s*=/u);
  assert.match(offlineDb, /const DB_VERSION = 3;/u);
});

test("a fresh Driver shell version evicts older copy-enabled cached assets", () => {
  assert.match(driver, /const DRIVER_PWA_CLIENT_VERSION = "2026\.08\.12\.3";/u);
  assert.match(worker, /const DRIVER_PWA_CLIENT_VERSION = "2026\.08\.12\.3";/u);
  assert.match(worker, /DRIVER_CACHE_NAME = `\$\{DRIVER_CACHE_PREFIX\}v27`/u);
  assert.match(driverHtml, /driver\.js\?v=20260812-driver-pwa-v3/u);
  assert.match(worker, /driver\.js\?v=20260812-driver-pwa-v3/u);
});

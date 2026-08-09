import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, "../../../public");
const read = (name) => fs.readFileSync(path.join(PUBLIC, name), "utf8");
const DRIVER_RECOVERY_VERSION = "20260808-yard-dependency-v1";
const DISPATCH_REVIEW_VERSION = "20260805-online-mode-v3";

test("the installed Driver shell cannot mix old DB/route code with photo recovery code", () => {
  const html = read("driver.html");
  const worker = read("driver-service-worker.js");
  const changedAssets = [
    "driver-offline-db.js",
    "driver-photo-hash.js",
    "driver-offline-photos.js",
    "driver-offline-sync.js",
    "driver.js"
  ];

  for (const asset of changedAssets) {
    const versionedPath = `/${asset}?v=${DRIVER_RECOVERY_VERSION}`;
    assert.ok(html.includes(versionedPath), `${asset} must be versioned in driver.html.`);
    assert.ok(worker.includes(versionedPath), `${asset} must be versioned in the shell cache.`);
  }
  assert.match(worker, /DRIVER_CACHE_NAME = `\$\{DRIVER_CACHE_PREFIX\}v20`/u);
});

test("Dispatch receives the photo-failure diagnostics renderer without a stale asset", () => {
  const html = read("dispatch-offline-review.html");
  assert.ok(html.includes(`/dispatch-offline-review.css?v=${DISPATCH_REVIEW_VERSION}`));
  assert.ok(html.includes(`/dispatch-offline-review.js?v=${DISPATCH_REVIEW_VERSION}`));
});

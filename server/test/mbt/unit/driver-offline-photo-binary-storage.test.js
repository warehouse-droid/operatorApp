import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const DB_SOURCE = fs.readFileSync(
  new URL("../../../public/driver-offline-db.js", import.meta.url),
  "utf8"
);

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing source section: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing source section terminator: ${end}`);
  return source.slice(startIndex, endIndex);
}

function buildPhotoStorageHarness() {
  const source = sourceSection(
    DB_SOURCE,
    "function photoHasLocalBytes(",
    "function eventRequiresOnlineReconciliation("
  );
  return new Function(
    `${source}\nreturn { photoHasLocalBytes, photoRecordForStorage, photoRecordForRuntime };`
  )();
}

function buildAdmissionHarness() {
  const source = sourceSection(
    DB_SOURCE,
    "function nonNegativeInteger(",
    "function photoHasLocalBytes("
  );
  return new Function(
    "MAX_EVIDENCE_BYTES",
    "MAX_UNSYNCED_PHOTOS",
    "EVIDENCE_RESERVE_RATIO",
    "PRESSURE_CAPTURE_TARGET_BYTES",
    `${source}\nreturn photoAdmissionForHealth;`
  )(250 * 1024 * 1024, 192, 0.1, 750 * 1024);
}

test("route admission retains p99 photos, three-stop margin, and a ten-percent byte reserve", () => {
  assert.match(DB_SOURCE, /const P99_ROUTE_PHOTOS = 21 \* 8;/u);
  assert.match(DB_SOURCE, /const PHOTO_SAFETY_MARGIN = 3 \* 8;/u);
  assert.match(DB_SOURCE, /const MAX_UNSYNCED_PHOTOS = P99_ROUTE_PHOTOS \+ PHOTO_SAFETY_MARGIN;/u);
  const admission = buildAdmissionHarness();
  const decision = admission({ evidenceBytes: 0, unsyncedPhotoCount: 167 }, 750 * 1024, {
    remainingPhotoCount: 24,
    expectedBytesPerPhoto: 750 * 1024,
    browserStorageEstimate: { usage: 0, quota: 250 * 1024 * 1024 }
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.projectedRoutePhotoCount, 192);
  assert.equal(decision.reserveBytes, 25 * 1024 * 1024);

  const noQuota = admission({ evidenceBytes: 100 * 1024 * 1024, unsyncedPhotoCount: 96 }, 1024, {
    remainingPhotoCount: 72,
    expectedBytesPerPhoto: 750 * 1024,
    browserStorageEstimate: { usage: 1, quota: 1 }
  });
  assert.equal(noQuota.allowed, false);
  assert.match(noQuota.reason, /headroom/iu);
});

test("WebKit-safe photo persistence stores exact ArrayBuffer bytes and no Blob/File value", async () => {
  const { photoHasLocalBytes, photoRecordForStorage, photoRecordForRuntime } = buildPhotoStorageHarness();
  const originalBytes = Uint8Array.from([0xff, 0xd8, 0x10, 0x20, 0xff, 0xd9]);
  const original = {
    photoId: "photo-webkit-regression",
    mimeType: "image/jpeg",
    byteSize: originalBytes.byteLength,
    blob: new Blob([originalBytes], { type: "image/jpeg" }),
    objectUrl: "blob:must-never-be-persisted"
  };

  const persisted = await photoRecordForStorage(original);

  assert.equal("blob" in persisted, false, "IndexedDB records must not contain a Blob/File value.");
  assert.equal("objectUrl" in persisted, false, "Ephemeral blob URLs must not enter IndexedDB.");
  assert.ok(persisted.blobBytes instanceof ArrayBuffer);
  assert.deepEqual(new Uint8Array(persisted.blobBytes), originalBytes);
  assert.equal(photoHasLocalBytes(persisted), true);

  const restored = photoRecordForRuntime(persisted);
  assert.ok(restored.blob instanceof Blob, "Upload and preview boundaries still receive a Blob.");
  assert.equal(restored.blob.type, "image/jpeg");
  assert.deepEqual(new Uint8Array(await restored.blob.arrayBuffer()), originalBytes);
});

test("legacy Blob records upgrade without dropping evidence and binary records round-trip idempotently", async () => {
  const { photoHasLocalBytes, photoRecordForStorage, photoRecordForRuntime } = buildPhotoStorageHarness();
  const bytes = Uint8Array.from({ length: 257 }, (_, index) => index % 251);
  const legacy = {
    photoId: "legacy-photo",
    mimeType: "image/jpeg",
    byteSize: bytes.byteLength,
    blob: new Blob([bytes], { type: "image/jpeg" }),
    status: "local"
  };

  const upgraded = await photoRecordForStorage(legacy);
  const persistedAgain = await photoRecordForStorage(photoRecordForRuntime(upgraded));

  assert.equal(photoHasLocalBytes(legacy), true);
  assert.equal(photoHasLocalBytes(upgraded), true);
  assert.equal("blob" in persistedAgain, false);
  assert.deepEqual(new Uint8Array(persistedAgain.blobBytes), bytes);
  assert.equal(persistedAgain.photoId, legacy.photoId);
  assert.equal(persistedAgain.status, legacy.status);
});

test("every photo write crosses the Blob-stripping persistence boundary", () => {
  const directNamedPhotoWrites = DB_SOURCE.match(/photosStore\.put\(/gu) || [];
  assert.equal(
    directNamedPhotoWrites.length,
    0,
    "Photo object stores must use the centralized persistence helper, never put spread records directly."
  );
  for (const [start, end] of [
    ["async function saveDraftPhoto(", "async function getDraftPhotos("],
    ["async function markPhotoAttempt(", "async function releaseForegroundEvent("]
  ]) {
    const section = sourceSection(DB_SOURCE, start, end);
    assert.doesNotMatch(section, /\bstore\.put\(/u);
  }
  assert.match(DB_SOURCE, /await putPhotoRecord\(photosStore,/u);
  assert.match(DB_SOURCE, /await putPhotoRecord\(store,/u);
});

test("durable receipt clears binary evidence only after explicit durability", () => {
  const responseSource = sourceSection(
    DB_SOURCE,
    "async function applySyncResponse(",
    "async function recordSyncError("
  );
  assert.match(responseSource, /blobBytes:\s*durable\s*\?\s*null\s*:\s*existing\.blobBytes/u);
  const durablePredicate = sourceSection(responseSource, "const durable = Boolean(", "const verificationFailed");
  assert.doesNotMatch(durablePredicate, /status\s*===\s*"received"/u);
});

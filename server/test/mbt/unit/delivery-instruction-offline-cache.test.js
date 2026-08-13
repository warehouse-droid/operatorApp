import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(
  new URL("../../../public/driver-offline-db.js", import.meta.url),
  "utf8"
);
const driverSource = fs.readFileSync(
  new URL("../../../public/driver.js", import.meta.url),
  "utf8"
);

function sourceSection(value, start, end) {
  const startIndex = value.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing source section: ${start}`);
  const endIndex = value.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing source terminator: ${end}`);
  return value.slice(startIndex, endIndex);
}

function cachePolicyHarness() {
  const helpers = sourceSection(
    source,
    "function instructionMediaBinaryBuffer(",
    "function photoHasLocalBytes("
  );
  return new Function(
    "MAX_INSTRUCTION_MEDIA_BYTES",
    `${helpers}\nreturn { instructionMediaRecordForStorage, instructionMediaRecordForRuntime, selectInstructionMediaEvictions };`
  )(250 * 1024 * 1024);
}

test("instruction images use their own 250 MB IndexedDB store and preserve exact bytes", async () => {
  assert.match(source, /const DB_VERSION = 3;/u);
  assert.match(source, /const MAX_EVIDENCE_BYTES = 250 \* 1024 \* 1024;/u);
  assert.match(source, /const MAX_INSTRUCTION_MEDIA_BYTES = 250 \* 1024 \* 1024;/u);
  assert.match(source, /createObjectStore\("instructionMedia", \{ keyPath: "key" \}\)/u);
  assert.match(source, /cacheInstructionMedia/u);
  assert.doesNotMatch(
    sourceSection(source, "async function cacheInstructionMedia(", "async function getCachedInstructionMedia("),
    /objectStore\("photos"\)/u,
    "instruction-image eviction must never touch required Driver photo evidence"
  );

  const { instructionMediaRecordForStorage, instructionMediaRecordForRuntime } = cachePolicyHarness();
  const bytes = Uint8Array.from([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]);
  const stored = await instructionMediaRecordForStorage({
    mediaId: "media-1",
    mimeType: "image/jpeg",
    blob: new Blob([bytes], { type: "image/jpeg" }),
    objectUrl: "blob:must-not-persist"
  });
  assert.equal("blob" in stored, false);
  assert.equal("objectUrl" in stored, false);
  assert.deepEqual(new Uint8Array(stored.blobBytes), bytes);
  const restored = instructionMediaRecordForRuntime(stored);
  assert.ok(restored.blob instanceof Blob);
  assert.deepEqual(new Uint8Array(await restored.blob.arrayBuffer()), bytes);
});

test("instruction image LRU evicts low-priority stale data before current/next images", () => {
  const { selectInstructionMediaEvictions } = cachePolicyHarness();
  const records = [
    { mediaId: "stale-old", byteSize: 100, priority: 0, lastAccessedAt: "2026-01-01" },
    { mediaId: "stale-new", byteSize: 100, priority: 0, lastAccessedAt: "2026-02-01" },
    { mediaId: "next", byteSize: 100, priority: 1, lastAccessedAt: "2026-01-01" },
    { mediaId: "current", byteSize: 100, priority: 2, lastAccessedAt: "2026-01-01" }
  ];
  const result = selectInstructionMediaEvictions(records, 250, ["current"]);
  assert.deepEqual(result.evictedMediaIds, ["stale-old", "stale-new"]);
  assert.equal(result.retainedBytes, 200);
});

test("evidence headroom eviction is partition-scoped and cannot touch required evidence", () => {
  const eviction = sourceSection(
    source,
    "async function evictInstructionMediaForEvidence(",
    "async function acquireLease("
  );
  assert.match(eviction, /db\.transaction\(\["profiles", "instructionMedia"\], "readwrite"\)/u);
  assert.match(eviction, /store\.index\("byPartition"\), normalizedPartition/u);
  assert.match(eviction, /profile\.locked/u);
  assert.doesNotMatch(eviction, /photos|events|manifests/u);
});

test("randomized cache eviction conserves byte accounting and always reaches its cap", () => {
  const { selectInstructionMediaEvictions } = cachePolicyHarness();
  let seed = 0x116758;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let run = 0; run < 500; run += 1) {
    const records = Array.from({ length: 1 + Math.floor(random() * 30) }, (_, index) => ({
      mediaId: `media-${run}-${index}`,
      byteSize: 1 + Math.floor(random() * 1000),
      priority: Math.floor(random() * 3),
      lastAccessedAt: new Date(1_700_000_000_000 + Math.floor(random() * 1_000_000)).toISOString()
    }));
    const total = records.reduce((sum, record) => sum + record.byteSize, 0);
    const limit = Math.floor(random() * Math.max(1, total));
    const result = selectInstructionMediaEvictions(records, limit, [records.at(-1).mediaId]);
    const removed = new Set(result.evictedMediaIds);
    const retained = records
      .filter((record) => !removed.has(record.mediaId))
      .reduce((sum, record) => sum + record.byteSize, 0);
    assert.equal(result.retainedBytes, retained);
    assert.ok(retained <= limit);
    assert.equal(new Set(result.evictedMediaIds).size, result.evictedMediaIds.length);
  }
});

test("Driver prefetches only images, prioritizes current/next jobs, and patches media without rerendering the stop", () => {
  const preparation = sourceSection(
    driverSource,
    "async function prepareDeliveryInstructionMedia(",
    "function driverDeliveryInstructionMediaUrl("
  );
  assert.match(preparation, /currentMediaIds/u);
  assert.match(preparation, /nextMediaIds/u);
  assert.match(preparation, /priority: 2/u);
  assert.match(preparation, /priority: 1/u);
  assert.match(preparation, /patchDriverInstructionMedia/u);
  assert.doesNotMatch(preparation, /renderJob\(/u);
  assert.match(driverSource, /media\?\.mediaKind !== "image"/u);
  assert.match(driverSource, /Video requires an internet connection/u);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash, webcrypto } from "node:crypto";

const readPublic = (name) => fs.readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
const hashSource = readPublic("driver-photo-hash.js");
const photosSource = readPublic("driver-offline-photos.js");
const syncSource = readPublic("driver-offline-sync.js");
const driverHtml = readPublic("driver.html");
const driverWorker = readPublic("driver-service-worker.js");

function browserContext(overrides = {}) {
  const context = {
    AbortController,
    ArrayBuffer,
    Blob,
    DataView,
    Map,
    Promise,
    Set,
    Uint8Array,
    Uint32Array,
    URL,
    ...overrides
  };
  context.self = context;
  context.window = context;
  return vm.createContext(context);
}

function load(source, context, filename) {
  vm.runInContext(source, context, { filename });
}

const knownDigest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const abcBlob = new Blob([new TextEncoder().encode("abc")], { type: "image/jpeg" });

{
  const context = browserContext({ crypto: undefined });
  load(hashSource, context, "driver-photo-hash.js");
  assert.equal(
    await context.DriverPhotoHash.sha256(abcBlob),
    knownDigest,
    "The shared photo hasher must hash retained Blobs without Web Crypto."
  );

  const largeBytes = new Uint8Array(1024 * 1024 + 17);
  for (let index = 0; index < largeBytes.length; index += 1) largeBytes[index] = index % 251;
  assert.equal(
    await context.DriverPhotoHash.sha256(new Blob([largeBytes], { type: "image/jpeg" })),
    createHash("sha256").update(largeBytes).digest("hex"),
    "The fallback must produce an exact digest for a photo-sized payload."
  );
}

{
  const context = browserContext({
    crypto: { subtle: { digest: async () => { throw new Error("WebKit digest unavailable"); } } }
  });
  load(hashSource, context, "driver-photo-hash.js");
  assert.equal(
    await context.DriverPhotoHash.sha256(abcBlob),
    knownDigest,
    "A rejected Web Crypto digest must fall back to the pure-JavaScript implementation."
  );
}

{
  const originalBytes = new Uint8Array([0, 1, 2, 3, 254, 255]);
  const retainedBlob = new Blob([originalBytes], { type: "image/jpeg" });
  const context = browserContext({
    crypto: undefined,
    DriverOfflineDB: { createUuid: () => "sync-owner" }
  });
  load(hashSource, context, "driver-photo-hash.js");
  const expectedHash = await context.DriverPhotoHash.sha256(retainedBlob);
  const instrumentedSyncSource = syncSource.replace(
    "global.DriverOfflineSync = {",
    "global.__verifyLocalPhotoBlob = verifyLocalPhotoBlob;\n  global.DriverOfflineSync = {"
  );
  assert.notEqual(instrumentedSyncSource, syncSource, "The sync verifier test hook must be injected.");
  load(instrumentedSyncSource, context, "driver-offline-sync.js");

  const result = await context.__verifyLocalPhotoBlob({
    blob: retainedBlob,
    byteSize: retainedBlob.size,
    sha256: expectedHash
  });
  assert.equal(result.actualSha256, expectedHash);
  assert.deepEqual(
    new Uint8Array(await retainedBlob.arrayBuffer()),
    originalBytes,
    "Verification must not recompress or otherwise modify an already-sealed retained Blob."
  );
}

{
  const encodedSizes = [];
  const context = browserContext({
    crypto: webcrypto,
    createImageBitmap: async () => ({
      width: 2048,
      height: 1024,
      close() {}
    }),
    document: {
      createElement(name) {
        assert.equal(name, "canvas");
        return {
          width: 0,
          height: 0,
          getContext: () => ({
            fillStyle: "",
            fillRect() {},
            drawImage() {}
          }),
          toBlob(callback, type, quality) {
            const size = quality === 0.86
              ? Math.floor(1.5 * 1024 * 1024)
              : 900 * 1024;
            encodedSizes.push(size);
            callback(new Blob([new Uint8Array(size)], { type }));
          }
        };
      }
    }
  });
  load(hashSource, context, "driver-photo-hash.js");
  load(photosSource, context, "driver-offline-photos.js");

  assert.equal(context.DriverOfflinePhotos.SOFT_TARGET_BYTES, 1024 * 1024);
  assert.equal(context.DriverOfflinePhotos.MAX_BYTES, 2 * 1024 * 1024);
  const captured = await context.DriverOfflinePhotos.compress(
    new Blob([new Uint8Array([1])], { type: "image/jpeg" })
  );
  assert.ok(encodedSizes.length >= 2, "A 1.5 MiB encoding must be retried toward the soft target.");
  assert.ok(captured.byteSize <= context.DriverOfflinePhotos.SOFT_TARGET_BYTES);
}

{
  const context = browserContext({
    crypto: webcrypto,
    createImageBitmap: async () => ({ width: 640, height: 480, close() {} }),
    document: {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ fillStyle: "", fillRect() {}, drawImage() {} }),
        toBlob: (callback, type) => callback(new Blob([
          new Uint8Array(Math.floor(1.5 * 1024 * 1024))
        ], { type }))
      })
    }
  });
  load(hashSource, context, "driver-photo-hash.js");
  load(photosSource, context, "driver-offline-photos.js");
  const captured = await context.DriverOfflinePhotos.compress(
    new Blob([new Uint8Array([1])], { type: "image/jpeg" })
  );
  assert.ok(captured.byteSize > context.DriverOfflinePhotos.SOFT_TARGET_BYTES);
  assert.ok(
    captured.byteSize <= context.DriverOfflinePhotos.MAX_BYTES,
    "The 1 MiB target must remain soft when the browser cannot encode below it."
  );
}

const recoveryAssetVersion = "20260805-online-mode-v3";
const htmlHashIndex = driverHtml.indexOf(`/driver-photo-hash.js?v=${recoveryAssetVersion}`);
const htmlPhotosIndex = driverHtml.indexOf(`/driver-offline-photos.js?v=${recoveryAssetVersion}`);
const htmlSyncIndex = driverHtml.indexOf(`/driver-offline-sync.js?v=${recoveryAssetVersion}`);
assert.ok(
  htmlHashIndex >= 0 && htmlHashIndex < htmlPhotosIndex && htmlPhotosIndex < htmlSyncIndex,
  "The page must load the shared hasher before capture and sync code."
);
assert.match(
  driverWorker,
  /importScripts\("\/driver-photo-hash\.js\?v=20260805-online-mode-v3"\);[\s\S]*importScripts\("\/driver-offline-sync\.js\?v=20260805-online-mode-v3"\);/,
  "Background sync must import the shared hasher before sync code."
);
assert.match(
  driverWorker,
  /DRIVER_CACHE_NAME = `\$\{DRIVER_CACHE_PREFIX\}v19`/,
  "The recovery shell must use a new cache generation."
);
for (const asset of ["driver-photo-hash.js", "driver-offline-photos.js", "driver-offline-sync.js"]) {
  assert.ok(
    driverWorker.includes(`/${asset}?v=${recoveryAssetVersion}`),
    `${asset} must be precached at the recovery asset version.`
  );
}

assert.match(
  syncSource,
  /async function verifyLocalPhotoBlob\(photo\)[\s\S]*global\.DriverPhotoHash\.sha256\(photo\.blob\)/,
  "Sync verification must use the same fallback-capable hasher as capture."
);
assert.doesNotMatch(
  syncSource.slice(
    syncSource.indexOf("async function verifyLocalPhotoBlob(photo)"),
    syncSource.indexOf("async function uploadPhoto(")
  ),
  /DriverOfflinePhotos|\.compress\(|canvas|\.slice\(/,
  "A retained sealed Blob must be verified and uploaded without a capture-time transform."
);

console.log("Driver photo integrity harness passed.");

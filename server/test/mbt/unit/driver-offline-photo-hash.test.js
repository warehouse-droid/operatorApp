import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, "../../../public");

function loadOfflinePhotosWithoutWebCrypto() {
  const browser = {
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    createImageBitmap: async () => ({
      width: 1,
      height: 1,
      close() {}
    })
  };
  const document = {
    createElement(tagName) {
      assert.equal(tagName, "canvas");
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            fillStyle: "",
            fillRect() {},
            drawImage() {}
          };
        },
        toBlob(callback) {
          callback(new Blob(["abc"], { type: "image/jpeg" }));
        }
      };
    }
  };
  const context = {
    self: browser,
    window: browser,
    document,
    Blob,
    URL,
    Image: class {},
    ArrayBuffer,
    DataView,
    Uint8Array,
    Uint32Array
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(PUBLIC, "driver-photo-hash.js"), "utf8"),
    context,
    { filename: "driver-photo-hash.js" }
  );
  vm.runInNewContext(
    fs.readFileSync(path.join(PUBLIC, "driver-offline-photos.js"), "utf8"),
    context,
    { filename: "driver-offline-photos.js" }
  );
  return browser.DriverOfflinePhotos;
}

function loadOfflinePhotosWithoutAnImageDecoder() {
  const browser = {
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    createImageBitmap: async () => {
      throw new Error("synthetic decoder outage");
    },
    FileReader: class {
      readAsDataURL() {
        this.onerror?.();
      }
    }
  };
  class BrokenImage {
    set src(_value) {
      this.onerror?.();
    }
  }
  const context = {
    self: browser,
    window: browser,
    document: {},
    Blob,
    Image: BrokenImage,
    ArrayBuffer,
    DataView,
    Uint8Array,
    Uint32Array,
    URL: {
      createObjectURL() { return "blob:synthetic"; },
      revokeObjectURL() {}
    }
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(PUBLIC, "driver-photo-hash.js"), "utf8"),
    context,
    { filename: "driver-photo-hash.js" }
  );
  vm.runInNewContext(
    fs.readFileSync(path.join(PUBLIC, "driver-offline-photos.js"), "utf8"),
    context,
    { filename: "driver-offline-photos.js" }
  );
  return browser.DriverOfflinePhotos;
}

test("P3-F19: compressed evidence keeps an exact SHA-256 digest when Web Crypto is unavailable", async () => {
  const photos = loadOfflinePhotosWithoutWebCrypto();
  const result = await photos.compress(new Blob(["synthetic image"], { type: "image/png" }));

  assert.equal(result.mimeType, "image/jpeg");
  assert.equal(result.byteSize, 3);
  assert.deepEqual(new Uint8Array(result.blobBytes), Uint8Array.from([0x61, 0x62, 0x63]));
  assert.equal(result.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("P3-F19: an already-small JPEG remains capturable when Safari's offline decoder is unavailable", async () => {
  const photos = loadOfflinePhotosWithoutAnImageDecoder();
  const jpeg = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x08, 0x00, 0x08, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9
  ]);

  const result = await photos.compress(new Blob([jpeg], { type: "image/jpeg" }));

  assert.equal(result.mimeType, "image/jpeg");
  assert.equal(result.width, 8);
  assert.equal(result.height, 8);
  assert.equal(result.byteSize, jpeg.byteLength);
  assert.deepEqual(new Uint8Array(result.blobBytes), jpeg);
  assert.match(result.sha256, /^[a-f0-9]{64}$/u);
});

test("P3-F19: byte-backed evidence previews without creating a WebKit blob URL", () => {
  const photos = loadOfflinePhotosWithoutWebCrypto();
  const blobBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer;
  const hydrated = photos.hydrate({
    photoId: "byte-backed-preview",
    mimeType: "image/jpeg",
    blobBytes,
    blob: new Blob([blobBytes], { type: "image/jpeg" })
  });

  assert.match(hydrated.objectUrl, /^data:image\/jpeg;base64,/u);
  photos.revokePhoto(hydrated);
});

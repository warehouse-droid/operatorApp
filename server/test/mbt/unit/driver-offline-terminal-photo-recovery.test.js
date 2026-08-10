import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

/* global Response */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readPublic = (name) => fs.readFileSync(
  path.resolve(HERE, `../../../public/${name}`),
  "utf8"
);
const HASH_SOURCE = readPublic("driver-photo-hash.js");
const SYNC_SOURCE = readPublic("driver-offline-sync.js");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("six retained photos upload after their duplicate events are closed as evidence only", async () => {
  const partitionKey = "sety::current-device";
  const profile = {
    partitionKey,
    deviceId: "current-device",
    sessionGeneration: "generation"
  };
  const manifest = { manifestId: "current-manifest", offlineSyncGrant: "grant" };
  const events = [
    {
      eventId: "terminal-pickup",
      partitionKey,
      manifestId: manifest.manifestId,
      eventType: "job_completed",
      jobId: "pickup",
      status: "evidence_only"
    },
    {
      eventId: "terminal-dropoff",
      partitionKey,
      manifestId: manifest.manifestId,
      eventType: "job_completed",
      jobId: "dropoff",
      status: "evidence_only"
    }
  ];
  const photos = Array.from({ length: 6 }, (_, index) => {
    const bytes = Buffer.from(`sety-retained-photo-${index + 1}`);
    return {
      photoId: `photo-${index + 1}`,
      eventId: index < 4 ? events[0].eventId : events[1].eventId,
      partitionKey,
      ordinal: index < 4 ? index : index - 4,
      recordType: "driver-stop-photo",
      mimeType: "image/jpeg",
      byteSize: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      blob: new Blob([bytes], { type: "image/jpeg" }),
      status: "local",
      attemptCount: 0
    };
  });
  const order = [];
  const uploadedBytes = new Map();

  const database = {
    createUuid: () => "sync-owner",
    getProfile: async () => profile,
    acquireLease: async () => true,
    releaseLease: async () => true,
    getPartitionEvents: async () => events,
    repairEventForSync: async (_key, eventId) => events.find((event) => event.eventId === eventId),
    getPendingPhotos: async () => photos.filter((photo) => photo.status !== "durably_received"),
    getManifest: async () => manifest,
    markPhotoAttempt: async (photoId, phase) => {
      const photo = photos.find((candidate) => candidate.photoId === photoId);
      photo.attemptCount += 1;
      photo.uploadPhase = phase;
    },
    markPhotoPhase: async (photoId, phase) => {
      photos.find((candidate) => candidate.photoId === photoId).uploadPhase = phase;
    },
    markPhotoUploaded: async (photoId, objectReference) => {
      const photo = photos.find((candidate) => candidate.photoId === photoId);
      photo.objectReference = objectReference;
      photo.status = "uploaded_unverified";
    },
    markPhotoError: async () => assert.fail("No retained photo should fail in this fixture."),
    applySyncResponse: async (_key, payload) => {
      for (const result of payload.photos || []) {
        assert.equal(result.durableReceipt, true);
        const photo = photos.find((candidate) => candidate.photoId === result.photoId);
        photo.status = "durably_received";
        photo.blob = null;
        order.push(`durable:${photo.photoId}`);
      }
    },
    getPendingEvents: async () => [],
    cleanupSynced: async () => {},
    getStorageHealth: async () => ({
      pendingEventCount: 0,
      reviewRequiredCount: 0,
      partitionUnsyncedPhotoCount: photos.filter((photo) => photo.blob).length
    }),
    recordSyncError: async () => {}
  };
  const browser = {
    DriverOfflineDB: database,
    crypto: crypto.webcrypto,
    navigator: { serviceWorker: null }
  };
  const fetchFixture = async (url, options = {}) => {
    if (url === "/api/driver/offline-sync") {
      const body = JSON.parse(options.body || "{}");
      assert.deepEqual(body.events || [], [], "Terminal event payloads must never be replayed.");
      assert.equal(body.photoReceipts?.length, 1, "Each photo needs its own durable checkpoint.");
      const receipt = body.photoReceipts[0];
      order.push(`receipt:${receipt.photoId}`);
      return jsonResponse({
        events: [],
        photos: [{ ...receipt, status: "durably_received", durableReceipt: true }]
      });
    }
    if (url === "/api/driver/photo-upload-token") {
      const photoId = JSON.parse(options.body).photoId;
      order.push(`ticket:${photoId}`);
      return jsonResponse({ uploadUrl: `https://upload.test/${photoId}`, token: "test-ticket" });
    }
    if (String(url).startsWith("https://upload.test/")) {
      const photoId = String(url).split("/").pop();
      const bytes = Buffer.from(await options.body.arrayBuffer());
      uploadedBytes.set(photoId, bytes);
      order.push(`upload:${photoId}`);
      const photo = photos.find((candidate) => candidate.photoId === photoId);
      return jsonResponse({
        objectReference: `r2://driver/driver-stop-photo/2026/08/05/${photoId}/evidence.jpg`,
        byteSize: photo.byteSize
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const context = {
    self: browser,
    window: browser,
    fetch: fetchFixture,
    crypto: crypto.webcrypto,
    ArrayBuffer,
    DataView,
    Uint8Array,
    Uint32Array,
    Blob,
    AbortController,
    Response,
    URL,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(HASH_SOURCE, context, { filename: "driver-photo-hash.js" });
  vm.runInNewContext(SYNC_SOURCE, context, { filename: "driver-offline-sync.js" });
  browser.DriverOfflineSync.configure({ getAuthToken: () => "driver-token" });

  const result = await browser.DriverOfflineSync.syncPartition(partitionKey);

  assert.equal(result.ok, true);
  assert.equal(uploadedBytes.size, 6);
  assert.equal(photos.every((photo) => photo.status === "durably_received" && photo.blob === null), true);
  for (const photo of photos) {
    assert.deepEqual(
      uploadedBytes.get(photo.photoId),
      Buffer.from(`sety-retained-photo-${Number(photo.photoId.split("-").pop())}`),
      `${photo.photoId} must upload its original sealed bytes.`
    );
    assert.ok(
      order.indexOf(`durable:${photo.photoId}`) < order.indexOf(`ticket:photo-${Number(photo.photoId.split("-").pop()) + 1}`)
      || photo.photoId === "photo-6",
      `${photo.photoId} must be durable before the next photo starts.`
    );
  }
});

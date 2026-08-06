import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readPublic = (name) => fs.readFileSync(path.resolve(HERE, `../../../public/${name}`), "utf8");
const HASH_SOURCE = readPublic("driver-photo-hash.js");
const SYNC_SOURCE = readPublic("driver-offline-sync.js");

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("one retrying photo cannot starve the later retained photos", async () => {
  const partitionKey = "sety::device";
  const profile = { partitionKey, deviceId: "device", sessionGeneration: "generation" };
  const manifest = { manifestId: "manifest", offlineSyncGrant: "grant" };
  const event = {
    eventId: "event",
    partitionKey,
    manifestId: manifest.manifestId,
    eventType: "job_completed",
    jobId: "job",
    jobFingerprint: "fingerprint",
    predecessorFingerprint: "predecessor",
    status: "pending",
    syncPayload: {
      eventId: "event",
      clientSequence: 1,
      eventType: "job_completed",
      jobId: "job",
      jobFingerprint: "fingerprint",
      predecessorFingerprint: "predecessor",
      occurredAt: "2026-08-05T10:23:35.420Z",
      locationStatus: "not_checked_offline",
      details: {},
      photos: []
    }
  };
  const photos = ["photo-a", "photo-b"].map((photoId) => {
    const bytes = Buffer.from(photoId);
    return {
      photoId,
      eventId: event.eventId,
      partitionKey,
      ordinal: photoId === "photo-a" ? 0 : 1,
      recordType: "driver-stop-photo",
      mimeType: "image/jpeg",
      byteSize: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      blob: new Blob([bytes], { type: "image/jpeg" }),
      status: "local",
      attemptCount: 0,
      nextAttemptAt: null
    };
  });
  let resolveSecondDurable;
  const secondDurable = new Promise((resolve) => { resolveSecondDurable = resolve; });
  const database = {
    createUuid: () => "owner",
    getProfile: async () => profile,
    acquireLease: async () => true,
    releaseLease: async () => true,
    getPartitionEvents: async () => [event],
    repairEventForSync: async () => event,
    getPendingPhotos: async () => photos.filter((photo) => photo.status !== "durably_received"),
    getManifest: async () => manifest,
    applySyncResponse: async (_key, payload) => {
      for (const result of payload.photos || []) {
        if (!result.durableReceipt) continue;
        const photo = photos.find((candidate) => candidate.photoId === result.photoId);
        photo.status = "durably_received";
        photo.blob = null;
        if (photo.photoId === "photo-b") resolveSecondDurable();
      }
    },
    markPhotoAttempt: async (photoId, phase) => {
      const photo = photos.find((candidate) => candidate.photoId === photoId);
      photo.attemptCount += 1;
      photo.uploadPhase = phase;
      photo.nextAttemptAt = null;
    },
    markPhotoPhase: async (photoId, phase) => {
      photos.find((candidate) => candidate.photoId === photoId).uploadPhase = phase;
    },
    markPhotoUploaded: async (photoId, objectReference) => {
      Object.assign(photos.find((candidate) => candidate.photoId === photoId), {
        objectReference,
        status: "uploaded_unverified"
      });
    },
    markPhotoError: async (photoId, error) => {
      Object.assign(photos.find((candidate) => candidate.photoId === photoId), {
        retryable: error.retryable,
        nextAttemptAt: error.nextAttemptAt,
        lastError: error.message
      });
    },
    getPendingEvents: async () => [],
    cleanupSynced: async () => {},
    getStorageHealth: async () => ({
      pendingEventCount: 1,
      reviewRequiredCount: 0,
      partitionUnsyncedPhotoCount: photos.filter((photo) => photo.blob).length
    }),
    recordSyncError: async () => {}
  };
  const timers = new Map();
  let nextTimerId = 1;
  const fakeSetTimeout = (callback, delay) => {
    const id = nextTimerId++;
    timers.set(id, { callback, delay: Number(delay) });
    return id;
  };
  const fakeClearTimeout = (id) => timers.delete(id);
  const browser = { DriverOfflineDB: database, crypto: crypto.webcrypto, navigator: {} };
  const fetchFixture = async (url, options = {}) => {
    if (url === "/api/driver/offline-sync") {
      const body = JSON.parse(options.body || "{}");
      if (body.photoReceipts?.length) {
        const receipt = body.photoReceipts[0];
        return jsonResponse({
          events: [],
          photos: [{ ...receipt, status: "durably_received", durableReceipt: true }]
        });
      }
      return jsonResponse({ events: [{ eventId: event.eventId, status: "waiting_photos" }], photos: [] });
    }
    if (url === "/api/driver/photo-upload-token") {
      const photoId = JSON.parse(options.body).photoId;
      return jsonResponse({ uploadUrl: `https://upload.test/${photoId}`, token: "test-ticket" });
    }
    if (url === "https://upload.test/photo-a") {
      throw new TypeError("synthetic connection drop");
    }
    if (url === "https://upload.test/photo-b") {
      const photo = photos[1];
      return jsonResponse({
        objectReference: `r2://driver/driver-stop-photo/2026/08/05/${photo.photoId}/evidence.jpg`,
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
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout
  };
  vm.runInNewContext(HASH_SOURCE, context, { filename: "driver-photo-hash.js" });
  vm.runInNewContext(SYNC_SOURCE, context, { filename: "driver-offline-sync.js" });
  browser.DriverOfflineSync.configure({ getAuthToken: () => "driver-token" });

  await assert.rejects(browser.DriverOfflineSync.syncPartition(partitionKey), (error) =>
    error.code === "driver_photo_sync_partial"
    && error.photoFailures?.[0]?.photoId === "photo-a"
    && error.photoFailures[0].retryable === true
  );

  const immediate = [...timers.entries()]
    .filter(([, timer]) => timer.delay <= 1000)
    .sort((left, right) => left[1].delay - right[1].delay)[0];
  assert.ok(
    immediate,
    `An interrupted drain needs a near-immediate continuation timer; observed ${JSON.stringify([...timers.values()].map((timer) => timer.delay))}.`
  );
  timers.delete(immediate[0]);
  immediate[1].callback();
  await Promise.race([
    secondDurable,
    new Promise((_, reject) => setTimeout(() => reject(new Error("photo-b remained starved")), 1000))
  ]);

  assert.equal(photos[0].status, "local");
  assert.equal(photos[1].status, "durably_received");
});

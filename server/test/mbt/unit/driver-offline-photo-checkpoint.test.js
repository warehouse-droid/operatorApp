import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYNC_SOURCE = fs.readFileSync(
  path.resolve(HERE, "../../../public/driver-offline-sync.js"),
  "utf8"
);
const HASH_SOURCE = fs.readFileSync(
  path.resolve(HERE, "../../../public/driver-photo-hash.js"),
  "utf8"
);

function sha256(blobText) {
  return crypto.createHash("sha256").update(blobText).digest("hex");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("each successful photo is durably checkpointed before the next large photo starts", async () => {
  const order = [];
  const durable = [];
  const recordedErrors = [];
  const profile = {
    partitionKey: "sety::device",
    deviceId: "device",
    sessionGeneration: "generation"
  };
  const manifest = { manifestId: "manifest", offlineSyncGrant: "grant" };
  const payload = {
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
  };
  const event = {
    ...payload,
    partitionKey: profile.partitionKey,
    manifestId: manifest.manifestId,
    status: "pending",
    syncPayload: payload
  };
  const photos = ["photo-one", "photo-two"].map((photoId, ordinal) => {
    const text = ordinal === 0 ? "one" : "two";
    return {
      photoId,
      eventId: event.eventId,
      partitionKey: profile.partitionKey,
      ordinal,
      recordType: "driver-stop-photo",
      mimeType: "image/jpeg",
      byteSize: text.length,
      sha256: sha256(text),
      blob: new Blob([text], { type: "image/jpeg" })
    };
  });

  const database = {
    createUuid: () => "owner",
    getProfile: async () => profile,
    acquireLease: async () => true,
    releaseLease: async () => true,
    getPartitionEvents: async () => [event],
    repairEventForSync: async () => event,
    getPendingPhotos: async () => photos,
    getManifest: async () => manifest,
    applySyncResponse: async (_partitionKey, response) => {
      for (const photo of response.photos || []) {
        if (photo.durableReceipt) durable.push(photo.photoId);
      }
    },
    markPhotoAttempt: async (photoId, phase) => order.push(`attempt:${photoId}:${phase}`),
    markPhotoPhase: async (photoId, phase) => order.push(`phase:${photoId}:${phase}`),
    markPhotoUploaded: async (photoId) => order.push(`uploaded:${photoId}`),
    markPhotoError: async (photoId, error) => {
      order.push(`error:${photoId}`);
      recordedErrors.push({ photoId, error });
    },
    getPendingEvents: async () => [],
    cleanupSynced: async () => {},
    getStorageHealth: async () => ({ pendingEventCount: 1, partitionUnsyncedPhotoCount: 1 }),
    recordSyncError: async () => {}
  };
  const browser = {
    DriverOfflineDB: database,
    crypto: crypto.webcrypto,
    navigator: { serviceWorker: null },
    fetch: async (url, options = {}) => {
      if (url === "/api/driver/offline-sync") {
        const body = JSON.parse(options.body || "{}");
        if (body.photoReceipts?.length) {
          const photoId = body.photoReceipts[0].photoId;
          order.push(`receipt:${photoId}`);
          return jsonResponse({
            events: [],
            photos: [{
              ...body.photoReceipts[0],
              status: "durably_received",
              durableReceipt: true
            }]
          });
        }
        order.push("registration");
        return jsonResponse({ events: [{ eventId: event.eventId, status: "waiting_photos" }], photos: [] });
      }
      if (url === "/api/driver/photo-upload-token") {
        const photoId = JSON.parse(options.body).photoId;
        order.push(`ticket:${photoId}`);
        return jsonResponse({ uploadUrl: `https://upload.test/${photoId}`, token: "test-ticket" });
      }
      if (String(url).startsWith("https://upload.test/")) {
        const photoId = String(url).split("/").pop();
        order.push(`upload:${photoId}`);
        if (photoId === "photo-two") return jsonResponse({ error: "synthetic worker rejection" }, 400);
        return jsonResponse({
          objectReference: `r2://driver/driver-stop-photo/2026/08/05/${photoId}/evidence.jpg`,
          byteSize: photos[0].byteSize
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  };
  const context = {
    self: browser,
    window: browser,
    fetch: browser.fetch,
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

  let failure = null;
  try {
    await browser.DriverOfflineSync.syncPartition(profile.partitionKey);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "The synthetic second upload must fail the partition sync.");
  assert.equal(
    failure.photoFailures?.length,
    1,
    JSON.stringify(failure.photoFailures || [])
  );

  assert.ok(
    order.indexOf("receipt:photo-one") < order.indexOf("ticket:photo-two"),
    `The first durable receipt must precede the second upload; observed ${order.join(" -> ")}`
  );
  assert.deepEqual(durable, ["photo-one"]);
  assert.ok(
    order.indexOf("attempt:photo-one:verifying") < order.indexOf("ticket:photo-one"),
    `Attempt state must be durable before network work; observed ${order.join(" -> ")}`
  );
  assert.equal(recordedErrors.length, 1);
  assert.equal(recordedErrors[0].photoId, "photo-two");
  assert.equal(recordedErrors[0].error.phase, "uploading");
  assert.equal(recordedErrors[0].error.status, 400);
  assert.equal(recordedErrors[0].error.retryable, false);
  assert.equal(failure.photoFailures[0].eventId, event.eventId);
  assert.equal(failure.photoFailures[0].phase, "uploading");
  assert.equal(failure.photoFailures[0].byteSize, photos[1].byteSize);
  assert.equal(failure.photoFailures[0].attemptCount, 1);
  assert.equal(failure.photoFailures[0].retryable, false);
  assert.equal(failure.photoFailures[0].httpStatus, 400);
});

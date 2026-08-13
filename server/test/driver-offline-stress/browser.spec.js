import { expect, test } from "@playwright/test";

import { recordStressResult } from "../support/driver-offline-stress-artifacts.mjs";
import {
  selectStressCases
} from "../support/driver-offline-stress-matrix.mjs";

const MODE = process.env.DOS_STRESS_MODE || "full";
const CASE_ID = String(process.env.DOS_STRESS_CASE_ID || "").trim();
const SEED = Number(process.env.DOS_STRESS_SEED || 20260812);
const SOAK_PHASE = String(process.env.DOS_STRESS_SOAK_PHASE || "standalone");
const NETWORK_PROFILE = String(process.env.DOS_STRESS_NETWORK_PROFILE || "fault-cycling");
if (SOAK_PHASE === "stable-drain" && NETWORK_PROFILE !== "stable-online") {
  throw new Error("Stable drain requires the stable-online network profile.");
}
const BROWSER_CASES = selectStressCases({ mode: MODE, caseId: CASE_ID, seed: SEED })
  .filter(({ runtime }) => runtime === "browser");
const LEGACY_PARTITION = "stress-driver::dos-stress-device";

async function seedLegacyDatabase(page, testCase) {
  return page.evaluate(async ({ partitionKey, storageKind, caseNumber }) => {
    const opened = await new Promise((resolve, reject) => {
      const request = indexedDB.open("mbbs-driver-offline", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const meta = db.createObjectStore("meta", { keyPath: "key" });
        const photos = db.createObjectStore("photos", { keyPath: "photoId" });
        photos.createIndex("byPartition", "partitionKey", { unique: false });
        photos.createIndex("byEvent", "eventId", { unique: false });
        photos.createIndex("byDraft", ["partitionKey", "draftKey"], { unique: false });
        meta.put({ key: "deviceId", value: "dos-stress-device" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const bytes = new Uint8Array(128 * 1024);
    for (let byteIndex = 0; byteIndex < bytes.length; byteIndex += 1) {
      bytes[byteIndex] = (
        caseNumber * 31 + byteIndex * 17 + Math.floor(byteIndex / 251)
      ) % 256;
    }
    const blob = new Blob([bytes], { type: "image/jpeg" });
    const binaryOnly = ["ArrayBuffer-only", "ArrayBuffer"].includes(storageKind);
    const storedBinary = binaryOnly ? await blob.arrayBuffer() : null;
    const legacyBlob = storageKind === "File"
      ? new File([blob], "historical-full-size.jpg", { type: "image/jpeg" })
      : blob;
    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    const transaction = opened.transaction("photos", "readwrite");
    transaction.objectStore("photos").put({
      photoId: "00000000-0000-4000-8000-00000000f001",
      partitionKey,
      draftKey: "job:historical-manifest:historical-job",
      eventId: null,
      ordinal: 0,
      recordType: "driver-stop-photo",
      mimeType: "image/jpeg",
      byteSize: blob.size,
      sha256,
      status: "draft",
      ...(binaryOnly ? { blobBytes: storedBinary } : { blob: legacyBlob })
    });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => {};
    });
    const verification = opened.transaction("photos", "readonly");
    const persisted = await new Promise((resolve, reject) => {
      const request = verification.objectStore("photos").get("00000000-0000-4000-8000-00000000f001");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    opened.close();
    return {
      byteSize: blob.size,
      sha256,
      storedShape: {
        hasBlob: persisted.blob instanceof Blob,
        hasFile: persisted.blob instanceof File,
        hasArrayBuffer: persisted.blobBytes instanceof ArrayBuffer,
        storedByteSize: persisted.blobBytes?.byteLength || 0,
        objectUrl: persisted.objectUrl || ""
      }
    };
  }, {
    partitionKey: LEGACY_PARTITION,
    storageKind: testCase.config.storageKind,
    caseNumber: testCase.number
  });
}

async function loadProductionRuntime(page, testCase) {
  await page.goto("/health");
  const legacySeed = testCase.group === "historical"
    ? await seedLegacyDatabase(page, testCase)
    : null;
  await page.addScriptTag({ url: "/driver-photo-hash.js" });
  await page.addScriptTag({ url: "/driver-offline-db.js" });
  await page.addScriptTag({ url: "/driver-offline-photos.js" });
  await page.addScriptTag({ url: "/driver-offline-sync.js" });
  return page.evaluate(async ({ id, number, legacySeed: seededLegacy }) => {
    const profile = await globalThis.DriverOfflineDB.unlockPartition({
      login: "stress-driver",
      name: "Anonymized stress driver"
    });
    const manifestId = `${number.toString(16).padStart(8, "0")}-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
    const jobs = Array.from({ length: 22 }, (_, index) => ({
      jobId: `${id}-job-${index + 1}`,
      sequenceIndex: index,
      stopType: index % 2 ? "dropoff" : "pickup",
      requiredPhotos: 8,
      fingerprint: String(index + 1).padStart(64, "a").slice(-64),
      predecessorFingerprint: String(index).padStart(64, "b").slice(-64)
    }));
    await globalThis.DriverOfflineDB.saveManifestAtomic(profile.partitionKey, {
      schemaVersion: 2,
      manifestId,
      planId: number,
      planDate: "2026-08-12",
      planRevision: 1,
      generatedAt: "2026-08-12T00:00:00.000Z",
      expiresAt: "2026-08-13T16:00:00.000Z",
      offlineSyncGrant: "synthetic-stress-grant",
      jobs
    });
    return { partitionKey: profile.partitionKey, manifestId, jobs, legacySeed: seededLegacy };
  }, { id: testCase.id, number: testCase.number, legacySeed });
}

async function createFullResolutionEvidence(page, testCase, runtime, {
  photoCount = 8,
  ordinalOffset = 0
} = {}) {
  const config = testCase.config;
  return page.evaluate(async ({ caseId, photoCount: count, ordinalOffset: offset, config: caseConfig, runtime: state }) => {
    const dimensions = String(caseConfig.sourceDimensions || "4032x3024").split("x").map(Number);
    const [width, height] = dimensions;
    const mimeType = String(caseConfig.sourceMimeType || "image/jpeg");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {throw new Error("Canvas is unavailable for the 4K corpus.");}
    const seed = Number(caseId.slice(-3));
    const columns = 32;
    const rows = 24;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const value = (seed * 31 + row * 17 + column * 43) % 255;
        context.fillStyle = `rgb(${value}, ${(value * 3) % 255}, ${(value * 7) % 255})`;
        context.fillRect(
          Math.floor(column * width / columns),
          Math.floor(row * height / rows),
          Math.ceil(width / columns),
          Math.ceil(height / rows)
        );
      }
    }
    context.fillStyle = "white";
    context.font = `${Math.max(80, Math.round(width / 30))}px sans-serif`;
    context.fillText(`${caseId} offline evidence`, 80, Math.round(height / 2));
    const sourceBlob = await new Promise((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("4K encoding failed.")),
      mimeType,
      0.96
    ));
    const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
    const sourceFiles = Array.from({ length: count }, (_, index) => new File(
      [sourceBlob],
      `${caseId}-source-${index + 1}.${extension}`,
      { type: mimeType, lastModified: 1786492800000 + index }
    ));
    const bitmap = await createImageBitmap(sourceFiles[0]);
    const sourceDimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    const compressedPhotos = await Promise.all(sourceFiles.map((file) => (
      globalThis.DriverOfflinePhotos.compress(file)
    )));
    const draftKey = `job:${state.manifestId}:${caseId}-job-1`;
    const photos = [];
    for (let index = 0; index < count; index += 1) {
      const compressed = compressedPhotos[index];
      const sourceBytes = compressed.blobBytes.slice(0);
      photos.push(await globalThis.DriverOfflineDB.saveDraftPhoto(state.partitionKey, draftKey, {
        photoId: crypto.randomUUID(),
        ordinal: index + offset,
        recordType: "driver-stop-photo",
        blobBytes: sourceBytes,
        mimeType: compressed.mimeType,
        byteSize: sourceBytes.byteLength,
        width: compressed.width,
        height: compressed.height,
        quality: compressed.quality,
        sha256: await globalThis.DriverPhotoHash.sha256(sourceBytes),
        sourceWidth: width,
        sourceHeight: height,
        sourceMimeType: mimeType,
        sourceFileName: sourceFiles[index].name
      }));
    }
    const compressedByteSizes = compressedPhotos.map(({ byteSize }) => byteSize);
    const compressedQualities = compressedPhotos.map(({ quality }) => quality);
    const firstCompressed = compressedPhotos[0];
    return {
      photos: photos.map((photo) => ({
        photoId: photo.photoId,
        ordinal: photo.ordinal,
        sha256: photo.sha256,
        byteSize: photo.byteSize,
        quality: photo.quality,
        width: photo.width,
        height: photo.height
      })),
      sourceCount: sourceFiles.length,
      sourceDimensions,
      sourceMimeType: mimeType,
      sourceByteSize: sourceBlob.size,
      compressedByteSize: Math.max(...compressedByteSizes),
      compressedByteSizes,
      compressedTotalByteSize: compressedByteSizes.reduce((sum, value) => sum + value, 0),
      compressedQuality: Math.min(...compressedQualities),
      compressedQualities,
      compressedDimensions: { width: firstCompressed.width, height: firstCompressed.height }
    };
  }, { caseId: testCase.id, photoCount, ordinalOffset, config, runtime });
}

async function rawDatabaseSnapshot(page) {
  return page.evaluate(async () => {
    const db = await globalThis.DriverOfflineDB.open();
    const transaction = db.transaction(["events", "photos"], "readonly");
    const all = (store) => new Promise((resolve, reject) => {
      const request = transaction.objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [events, photos] = await Promise.all([all("events"), all("photos")]);
    return {
      eventCount: events.length,
      events: events.map((event) => ({
        eventId: event.eventId,
        status: event.status,
        sealedPayload: JSON.stringify(event.syncPayload),
        photoIds: event.photoIds
      })),
      photoCount: photos.length,
      photos: photos.map((photo) => ({
        photoId: photo.photoId,
        eventId: photo.eventId,
        status: photo.status,
        hasBlob: photo.blob instanceof Blob,
        hasFile: photo.blob instanceof File,
        hasArrayBuffer: photo.blobBytes instanceof ArrayBuffer,
        byteSize: photo.byteSize,
        storedByteSize: photo.blobBytes?.byteLength || 0,
        objectUrl: photo.objectUrl || "",
        objectReference: photo.objectReference || "",
        durableReceipt: photo.durableReceipt === true,
        sha256: photo.sha256 || ""
      }))
    };
  });
}

async function queueCompletion(page, testCase, runtime, photos, { storm = false, poisoned = false } = {}) {
  return page.evaluate(async ({ id, state, photoList, storm: clickStorm, poisoned: injectPoison }) => {
    const input = (eventId) => ({
      eventId,
      manifestId: state.manifestId,
      eventType: "job_completed",
      jobId: `${id}-job-1`,
      jobFingerprint: state.jobs[0].fingerprint,
      predecessorFingerprint: state.jobs[0].predecessorFingerprint,
      occurredAt: "2026-08-12T12:00:00.000Z",
      locationStatus: "not_checked_offline",
      requiredPhotoCount: photoList.length,
      photos: photoList,
      details: injectPoison ? { poison: () => "synthetic IndexedDB fault" } : { caseId: id, result: "saved" }
    });
    if (!clickStorm) {return globalThis.DriverOfflineDB.queueEvent(state.partitionKey, input(crypto.randomUUID()));}
    const attempts = Array.from({ length: 20 }, (_, index) => new Promise((resolve) => {
      setTimeout(() => {
        globalThis.DriverOfflineDB.queueEvent(state.partitionKey, input(crypto.randomUUID()))
          .then((event) => resolve({ status: "fulfilled", eventId: event.eventId }))
          .catch((error) => resolve({ status: "rejected", code: error.code || error.name }));
      }, index * 50);
    }));
    return Promise.all(attempts);
  }, { id: testCase.id, state: runtime, photoList: photos, storm, poisoned });
}

async function installFaultBoundary(page, testCase) {
  await page.evaluate(({ config, networkProfile }) => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    const stableOnline = networkProfile === "stable-online";
    const state = {
      config,
      networkProfile,
      online: true,
      armed: !stableOnline,
      injectedFaults: [],
      requests: [],
      committedEvents: new Map(),
      committedPhotos: new Map(),
      uploadAttempts: new Map(),
      waveformTrace: []
    };
    globalThis.__dosFaultState = state;
    const failureResponse = () => {
      const status = /^\d+$/u.test(String(config.failure || "")) ? Number(config.failure) : 503;
      return new Response(JSON.stringify({ error: `Injected ${config.failure}`, code: "DOS_INJECTED_NETWORK" }), {
        status,
        headers: { "Content-Type": "application/json" }
      });
    };
    const fail = (phase, afterCommit = false) => {
      if (!state.armed) {return null;}
      const cutPoint = String(config.cutPoint || "");
      const matches = cutPoint === phase;
      if (!matches) {return null;}
      state.armed = false;
      state.injectedFaults.push({ type: "network", phase, failure: config.failure, afterCommit });
      if (String(config.failure) === "disconnect") {
        const error = new TypeError(`Injected disconnect at ${phase}`);
        error.isNetworkError = true;
        throw error;
      }
      return failureResponse();
    };
    // eslint-disable-next-line complexity -- one observable multiplexer models every exact upload boundary.
    globalThis.fetch = async (input, init = {}) => {
      const request = new Request(input, init);
      const url = new URL(request.url, location.origin);
      if (!url.pathname.startsWith("/api/driver/") && !url.pathname.startsWith("/dos-upload/")) {
        return originalFetch(input, init);
      }
      if (!state.online) {
        const error = new TypeError("Injected offline interval");
        error.isNetworkError = true;
        throw error;
      }
      const bytes = ["GET", "HEAD"].includes(request.method)
        ? new ArrayBuffer(0)
        : await request.clone().arrayBuffer();
      let body = {};
      try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { body = {}; }
      state.requests.push({ path: url.pathname, method: request.method, byteSize: bytes.byteLength });
      if (url.pathname === "/api/driver/offline-sync") {
        const hasEvents = Array.isArray(body.events) && body.events.length > 0;
        const hasReceipts = Array.isArray(body.photoReceipts) && body.photoReceipts.length > 0;
        if (hasEvents) {
          const before = fail("registration-before-commit");
          if (before) {return before;}
          for (const event of body.events) {
            const prior = state.committedEvents.get(event.eventId);
            if (prior && JSON.stringify(prior.payload) !== JSON.stringify(event)) {
              return new Response(JSON.stringify({ error: "Immutable replay conflict" }), { status: 409 });
            }
            state.committedEvents.set(event.eventId, { payload: event, applications: 1 });
          }
          const after = fail("registration-after-commit", true);
          if (after) {return after;}
        }
        if (hasReceipts) {
          const before = fail("receipt-before-commit");
          if (before) {return before;}
          for (const receipt of body.photoReceipts) {state.committedPhotos.set(receipt.photoId, receipt);}
          const after = fail("receipt-after-commit", true);
          if (after) {return after;}
        }
        const events = (body.events || []).map((event) => ({
          eventId: event.eventId,
          status: (event.photos || []).every(({ photoId }) => state.committedPhotos.has(photoId)) ? "applied" : "waiting_photos",
          appliedAt: new Date().toISOString()
        }));
        const photos = (body.photoReceipts || []).map((receipt) => ({
          ...receipt,
          status: "durably_received",
          durableReceipt: true
        }));
        return new Response(JSON.stringify({ events, photos, pendingCount: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url.pathname === "/api/driver/photo-upload-token") {
        const before = fail("ticket-before-response");
        if (before) {return before;}
        return new Response(JSON.stringify({
          uploadUrl: `${location.origin}/dos-upload/${body.photoId}`,
          token: "synthetic-upload-token"
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.pathname.startsWith("/dos-upload/")) {
        const photoId = url.pathname.split("/").at(-1);
        const attempts = Number(state.uploadAttempts.get(photoId) || 0) + 1;
        state.uploadAttempts.set(photoId, attempts);
        const cutPoint = String(config.cutPoint || "");
        if (state.armed && ["upload-zero-bytes", "upload-halfway"].includes(cutPoint)) {
          state.armed = false;
          state.injectedFaults.push({
            type: "network",
            phase: cutPoint,
            failure: config.failure,
            byteOffset: cutPoint === "upload-halfway" ? Math.floor(bytes.byteLength / 2) : 0
          });
          if (String(config.failure) === "disconnect") {throw new TypeError(`Injected disconnect at ${cutPoint}`);}
          return failureResponse();
        }
        const reference = `r2://driver/driver-stop-photo/2026/08/12/${photoId}/evidence.jpg`;
        state.committedPhotos.set(photoId, { photoId, objectReference: reference, byteSize: bytes.byteLength });
        const after = fail("upload-after-commit", true);
        if (after) {return after;}
        return new Response(JSON.stringify({ objectReference: reference, byteSize: bytes.byteLength }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    };
    globalThis.DriverOfflineSync.configure({
      getAuthToken: () => "synthetic-stress-token",
      onStatus: () => {},
      onUpdated: () => {}
    });
  }, { config: testCase.config, networkProfile: NETWORK_PROFILE });
}

async function forceRetryNow(page) {
  await page.evaluate(async () => {
    globalThis.__dosFaultState.online = true;
    const db = await globalThis.DriverOfflineDB.open();
    const transaction = db.transaction("photos", "readwrite");
    const store = transaction.objectStore("photos");
    const records = await new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    for (const photo of records) {store.put({ ...photo, nextAttemptAt: null });}
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => {};
    });
  });
}

async function exerciseNetworkWaveform(page, testCase, runtime, photos) {
  if (NETWORK_PROFILE === "stable-online") {
    return page.evaluate(() => {
      const state = globalThis.__dosFaultState;
      state.online = true;
      state.waveformTrace.push({
        online: true,
        virtualDurationMs: 11000,
        networkProfile: "stable-online"
      });
      return state.waveformTrace;
    });
  }
  if (testCase.config.waveform !== "online-1s-offline-10s") {return [];}
  await page.evaluate(() => {
    const state = globalThis.__dosFaultState;
    state.waveformTrace.push({ online: true, virtualDurationMs: 1000 });
    state.online = false;
    state.waveformTrace.push({ online: false, virtualDurationMs: 10000 });
  });
  const storm = await queueCompletion(page, testCase, runtime, photos, { storm: true });
  expect(storm.every(({ status }) => status === "rejected")).toBe(true);
  await page.evaluate(() => {
    const state = globalThis.__dosFaultState;
    state.online = true;
    state.waveformTrace.push({ online: true, virtualDurationMs: 1000 });
    state.online = false;
    state.waveformTrace.push({ online: false, virtualDurationMs: 10000 });
    state.online = true;
    state.waveformTrace.push({ online: true, virtualDurationMs: 1000 });
  });
  return page.evaluate(() => globalThis.__dosFaultState.waveformTrace);
}

async function syncToConvergence(page, runtime) {
  let firstFailure = null;
  try {
    await page.evaluate((partitionKey) => globalThis.DriverOfflineSync.syncPartition(partitionKey), runtime.partitionKey);
  } catch (error) {
    firstFailure = String(error?.message || error);
  }
  await forceRetryNow(page);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await page.evaluate((partitionKey) => globalThis.DriverOfflineSync.syncPartition(partitionKey), runtime.partitionKey);
    } catch (error) {
      if (attempt === 3) {throw error;}
      await forceRetryNow(page);
    }
  }
  const boundary = await page.evaluate(() => ({
    injectedFaults: globalThis.__dosFaultState.injectedFaults,
    requestCount: globalThis.__dosFaultState.requests.length,
    committedEventCount: globalThis.__dosFaultState.committedEvents.size,
    committedPhotoCount: globalThis.__dosFaultState.committedPhotos.size,
    applicationCounts: [...globalThis.__dosFaultState.committedEvents.values()].map(({ applications }) => applications)
  }));
  return { firstFailure, ...boundary };
}

async function runHistoricalCase(page, testCase, runtime, metrics) {
  const legacy = await page.evaluate(async (partitionKey) => {
    const photos = await globalThis.DriverOfflineDB.getDraftPhotos(
      partitionKey,
      "job:historical-manifest:historical-job"
    );
    return Promise.all(photos.map(async ({ photoId, blobBytes, blob, byteSize, sha256 }) => ({
      photoId,
      hasBytes: blobBytes instanceof ArrayBuffer,
      runtimeBlob: blob instanceof Blob,
      byteSize,
      sha256,
      computedSha256: blobBytes instanceof ArrayBuffer
        ? await globalThis.DriverPhotoHash.sha256(blobBytes)
        : ""
    })));
  }, runtime.partitionKey);
  expect(legacy).toHaveLength(1);
  if (testCase.config.storageKind === "ArrayBuffer-only") {
    expect(runtime.legacySeed.storedShape).toEqual({
      hasBlob: false,
      hasFile: false,
      hasArrayBuffer: true,
      storedByteSize: runtime.legacySeed.byteSize,
      objectUrl: ""
    });
    expect(legacy[0].hasBytes).toBe(true);
    expect(legacy[0].byteSize).toBe(runtime.legacySeed.byteSize);
    expect(legacy[0].sha256).toBe(runtime.legacySeed.sha256);
    expect(legacy[0].computedSha256).toBe(runtime.legacySeed.sha256);
  }
  const historicalPhoto = { photoId: legacy[0].photoId, ordinal: 0 };
  const generated = await createFullResolutionEvidence(page, testCase, runtime, {
    photoCount: 7,
    ordinalOffset: 1
  });
  const photos = [historicalPhoto, ...generated.photos];
  if (testCase.config.injectedIndexedDbFault) {
    let classified = null;
    try {
      await queueCompletion(page, testCase, runtime, photos, { poisoned: true });
    } catch (error) {
      classified = { type: "indexeddb", synthetic: true, name: error?.name, code: error?.code || "" };
    }
    expect(classified).not.toBeNull();
    metrics.injectedFaults.push(classified);
  } else {
    await queueCompletion(page, testCase, runtime, photos);
  }
  const snapshot = await rawDatabaseSnapshot(page);
  for (const photo of snapshot.photos) {
    expect(photo.hasBlob).toBe(false);
    expect(photo.hasFile).toBe(false);
    expect(photo.hasArrayBuffer).toBe(true);
    expect(photo.objectUrl.startsWith("blob:")).toBe(false);
  }
  if (!testCase.config.injectedIndexedDbFault) {
    expect(snapshot.eventCount).toBe(1);
    expect(snapshot.photoCount).toBe(8);
    const storedHistorical = snapshot.photos.find(({ photoId }) => photoId === historicalPhoto.photoId);
    expect(storedHistorical.storedByteSize).toBe(runtime.legacySeed.byteSize);
    expect(storedHistorical.sha256).toBe(runtime.legacySeed.sha256);
  }
  metrics.legacySeed = runtime.legacySeed;
  metrics.source = generated;
}

async function runCaptureCase(page, testCase, runtime, metrics) {
  const generated = await createFullResolutionEvidence(page, testCase, runtime);
  expect(generated.sourceCount).toBe(8);
  expect(`${generated.sourceDimensions.width}x${generated.sourceDimensions.height}`).toBe(testCase.config.sourceDimensions);
  expect(generated.compressedDimensions.width).toBeLessThanOrEqual(2048);
  expect(generated.compressedDimensions.height).toBeLessThanOrEqual(2048);
  expect(generated.compressedByteSize).toBeLessThanOrEqual(2 * 1024 * 1024);
  const storm = await queueCompletion(page, testCase, runtime, generated.photos, { storm: true });
  expect(storm.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  const snapshot = await rawDatabaseSnapshot(page);
  expect(snapshot.eventCount).toBe(1);
  expect(snapshot.photos).toHaveLength(8);
  expect(snapshot.photos.every(({ hasBlob, hasFile, hasArrayBuffer }) => !hasBlob && !hasFile && hasArrayBuffer)).toBe(true);
  expect(new Set(snapshot.events.map(({ sealedPayload }) => sealedPayload)).size).toBe(1);
  metrics.source = generated;
  metrics.clicks = { rateHz: 20, attempts: 20, logicalEvents: snapshot.eventCount };
}

async function runNetworkCase(page, testCase, runtime, metrics) {
  const generated = await createFullResolutionEvidence(page, testCase, runtime);
  await queueCompletion(page, testCase, runtime, generated.photos);
  const before = await rawDatabaseSnapshot(page);
  const sealed = before.events[0].sealedPayload;
  await installFaultBoundary(page, testCase);
  const waveformTrace = await exerciseNetworkWaveform(page, testCase, runtime, generated.photos);
  const convergence = await syncToConvergence(page, runtime);
  const after = await rawDatabaseSnapshot(page);
  expect(after.eventCount).toBe(1);
  expect(after.events[0].sealedPayload).toBe(sealed);
  expect(after.photos.every(({ durableReceipt, storedByteSize }) => durableReceipt && storedByteSize === 0)).toBe(true);
  expect(convergence.committedEventCount).toBe(1);
  expect(convergence.committedPhotoCount).toBe(8);
  expect(convergence.applicationCounts).toEqual([1]);
  if (NETWORK_PROFILE === "stable-online") {
    expect(convergence.firstFailure).toBeNull();
    expect(convergence.injectedFaults).toHaveLength(0);
    expect(waveformTrace).toHaveLength(1);
    expect(waveformTrace.every(({ online }) => online)).toBe(true);
  } else {
    expect(convergence.injectedFaults).toHaveLength(1);
  }
  metrics.source = generated;
  metrics.network = { ...convergence, waveformTrace, networkProfile: NETWORK_PROFILE };
  metrics.injectedFaults.push(...convergence.injectedFaults);
}

async function seedQuotaPhotos(page, runtime, count, byteSize) {
  return page.evaluate(async ({ state, count: total, byteSize: bytes }) => {
    const db = await globalThis.DriverOfflineDB.open();
    const transaction = db.transaction("photos", "readwrite");
    const store = transaction.objectStore("photos");
    const payload = new Uint8Array(bytes).buffer;
    for (let index = 0; index < total; index += 1) {
      store.put({
        photoId: crypto.randomUUID(),
        partitionKey: state.partitionKey,
        draftKey: `quota:${index}`,
        eventId: null,
        ordinal: 0,
        recordType: "driver-stop-photo",
        mimeType: "image/jpeg",
        byteSize: bytes,
        blobBytes: payload.slice(0),
        sha256: "c".repeat(64),
        status: "draft"
      });
    }
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => {};
    });
  }, { state: runtime, count, byteSize });
}

async function runQuotaCase(page, testCase, runtime, metrics) {
  const scenario = testCase.config.scenario;
  const existingCount = Number(testCase.config.existingPhotoCount);
  const corpusBytes = [211641, 525240, 959427, 1121732, 1244283, 1324236][testCase.number % 6];
  const seededCount = scenario === "committed-evidence-immutable" ? 0 : existingCount;
  await seedQuotaPhotos(page, runtime, seededCount, corpusBytes);
  const before = await page.evaluate((partitionKey) => globalThis.DriverOfflineDB.getStorageHealth(partitionKey), runtime.partitionKey);
  if (["p99-route-capacity", "p99-final-stop"].includes(scenario)) {
    const requiredSlots = Number(testCase.config.routeTargetPhotos);
    const documentedSafetyMargin = 3 * Number(testCase.config.sourcePhotoCount);
    expect(Number(before.maxUnsyncedPhotos), "p99 route plus three-stop margin must be retained").toBeGreaterThanOrEqual(requiredSlots + documentedSafetyMargin);
    const remainingAfterCandidate = Math.max(0, requiredSlots - seededCount - 1);
    const admission = await page.evaluate(({ partitionKey, bytes, remainingPhotoCount, expectedBytesPerPhoto }) => (
      globalThis.DriverOfflineDB.canStorePhoto(partitionKey, bytes, {
        remainingPhotoCount,
        expectedBytesPerPhoto,
        browserStorageEstimate: {
          usage: 0,
          quota: 250 * 1024 * 1024
        }
      })
    ), {
      partitionKey: runtime.partitionKey,
      bytes: corpusBytes,
      remainingPhotoCount: remainingAfterCandidate,
      expectedBytesPerPhoto: Number(testCase.config.pressureTargetBytes)
    });
    expect(admission.allowed, "the historical p99 route must retain its next required photo").toBe(true);
    expect(admission.remainingPhotoCount).toBe(remainingAfterCandidate);
    expect(admission.reserveBytes).toBe(Math.ceil(250 * 1024 * 1024 * 0.1));
  } else if (["adaptive-new-capture", "browser-estimate-pressure"].includes(scenario)) {
    const policy = await page.evaluate(({ retainedEvidenceBytes, remainingPhotoCount }) => {
      const selector = globalThis.DriverOfflinePhotos.capturePolicyForPressure;
      return {
        exposesAdaptivePolicy: typeof selector === "function",
        normal: selector?.({
          retainedEvidenceBytes: 0,
          remainingPhotoCount: 168,
          browserUsageBytes: 0,
          browserQuotaBytes: 300 * 1024 * 1024
        }),
        pressure: selector?.({
          retainedEvidenceBytes,
          remainingPhotoCount,
          optionalCacheBytes: 24 * 1024 * 1024,
          browserUsageBytes: retainedEvidenceBytes + 120 * 1024 * 1024,
          browserQuotaBytes: retainedEvidenceBytes + 170 * 1024 * 1024
        })
      };
    }, {
      retainedEvidenceBytes: before.evidenceBytes,
      remainingPhotoCount: Math.max(1, Number(testCase.config.routeTargetPhotos) - seededCount)
    });
    expect(policy.exposesAdaptivePolicy, "new captures need route-aware adaptive quality").toBe(true);
    expect(policy.normal).toMatchObject({
      pressure: false,
      maxEdge: 2048,
      targetBytes: 1024 * 1024,
      minimumQuality: 0.6,
      appliesTo: "new-captures-only"
    });
    expect(policy.pressure).toMatchObject({
      pressure: true,
      maxEdge: Number(testCase.config.minimumEdge),
      targetBytes: Number(testCase.config.pressureTargetBytes),
      minimumQuality: Number(testCase.config.minimumQuality),
      appliesTo: "new-captures-only"
    });
    expect(policy.pressure.optionalCacheEvictionBytes).toBeGreaterThan(0);
    expect(typeof policy.pressure.allowed).toBe("boolean");
    const pressureCompression = await page.evaluate(async ({ retainedEvidenceBytes, remainingPhotoCount }) => {
      const selectedPolicy = globalThis.DriverOfflinePhotos.capturePolicyForPressure({
        retainedEvidenceBytes,
        remainingPhotoCount,
        optionalCacheBytes: 24 * 1024 * 1024,
        browserUsageBytes: retainedEvidenceBytes + 120 * 1024 * 1024,
        browserQuotaBytes: retainedEvidenceBytes + 170 * 1024 * 1024
      });
      const canvas = document.createElement("canvas");
      canvas.width = 4032;
      canvas.height = 3024;
      const context = canvas.getContext("2d", { alpha: false });
      for (let row = 0; row < 24; row += 1) {
        for (let column = 0; column < 32; column += 1) {
          const value = (row * 47 + column * 83) % 255;
          context.fillStyle = `rgb(${value}, ${(value * 5) % 255}, ${(value * 11) % 255})`;
          context.fillRect(column * 126, row * 126, 126, 126);
        }
      }
      const sourceBlob = await new Promise((resolve, reject) => canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error("Pressure corpus encoding failed.")),
        "image/jpeg",
        0.98
      ));
      const compressed = await globalThis.DriverOfflinePhotos.compress(
        new File([sourceBlob], "pressure-4k.jpg", { type: "image/jpeg" }),
        selectedPolicy
      );
      return {
        width: compressed.width,
        height: compressed.height,
        byteSize: compressed.byteSize,
        quality: compressed.quality
      };
    }, {
      retainedEvidenceBytes: before.evidenceBytes,
      remainingPhotoCount: Math.max(1, Number(testCase.config.routeTargetPhotos) - seededCount)
    });
    expect(Math.max(pressureCompression.width, pressureCompression.height)).toBe(Number(testCase.config.minimumEdge));
    expect(pressureCompression.byteSize).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(pressureCompression.quality).toBeGreaterThanOrEqual(Number(testCase.config.minimumQuality));
  } else if (scenario === "committed-evidence-immutable") {
    const generated = await createFullResolutionEvidence(page, testCase, runtime);
    await queueCompletion(page, testCase, runtime, generated.photos);
    await expect(page.evaluate(async ({ state, photoId }) => {
      await globalThis.DriverOfflineDB.saveDraftPhoto(state.partitionKey, "replacement", {
        photoId: crypto.randomUUID(),
        ordinal: 0,
        recordType: "driver-stop-photo",
        blobBytes: new Uint8Array([1]).buffer,
        mimeType: "image/jpeg",
        byteSize: 1,
        sha256: "d".repeat(64)
      }, { replacePhotoId: photoId });
    }, { state: runtime, photoId: generated.photos[0].photoId })).rejects.toThrow(/committed|cannot be replaced/iu);
  } else if (scenario === "optional-cache-evicted-first") {
    const eviction = await page.evaluate(async (partitionKey) => {
      const bytes = new Uint8Array(2048);
      bytes.fill(31);
      await globalThis.DriverOfflineDB.cacheInstructionMedia(partitionKey, {
        mediaId: "optional-stress-cache",
        mediaKind: "image",
        mimeType: "image/jpeg",
        fileName: "optional-stress-cache.jpg",
        byteSize: bytes.byteLength,
        blobBytes: bytes.buffer,
        priority: 0
      });
      const photosBefore = await globalThis.DriverOfflineDB.getStorageHealth(partitionKey);
      const result = await globalThis.DriverOfflineDB.evictInstructionMediaForEvidence(
        partitionKey,
        { bytesToFree: 1 }
      );
      const cachedAfter = await globalThis.DriverOfflineDB.getCachedInstructionMedia(
        partitionKey,
        "optional-stress-cache"
      );
      const photosAfter = await globalThis.DriverOfflineDB.getStorageHealth(partitionKey);
      return { result, cachedAfter, photosBefore, photosAfter };
    }, runtime.partitionKey);
    expect(eviction.result.evictedMediaIds).toContain("optional-stress-cache");
    expect(eviction.result.evictedBytes).toBe(2048);
    expect(eviction.cachedAfter).toBeNull();
    expect(eviction.photosBefore.unsyncedPhotoCount).toBe(seededCount);
    expect(eviction.photosAfter.unsyncedPhotoCount).toBe(seededCount);
  } else if (scenario === "cross-partition-headroom") {
    const second = await page.evaluate(() => globalThis.DriverOfflineDB.unlockPartition({ login: "other-stress-driver" }));
    const admission = await page.evaluate(({ partitionKey, bytes }) => (
      globalThis.DriverOfflineDB.canStorePhoto(partitionKey, bytes)
    ), { partitionKey: second.partitionKey, bytes: corpusBytes });
    expect(admission.unsyncedPhotoCount).toBe(seededCount);
    expect(admission.evidenceBytes).toBe(seededCount * corpusBytes);
  } else if (scenario === "quota-failure-atomicity") {
    const countBefore = before.unsyncedPhotoCount;
    const admissionOptions = {
      remainingPhotoCount: Number(testCase.config.routeTargetPhotos),
      expectedBytesPerPhoto: Number(testCase.config.pressureTargetBytes),
      browserStorageEstimate: { usage: 1, quota: 1 }
    };
    const admission = await page.evaluate(({ partitionKey, bytes, options }) => (
      globalThis.DriverOfflineDB.canStorePhoto(partitionKey, bytes, options)
    ), { partitionKey: runtime.partitionKey, bytes: corpusBytes, options: admissionOptions });
    expect(admission.allowed).toBe(false);
    await expect(page.evaluate(async ({ state, bytes, options }) => {
      await globalThis.DriverOfflineDB.saveDraftPhoto(state.partitionKey, "quota-final", {
        photoId: crypto.randomUUID(),
        ordinal: 0,
        recordType: "driver-stop-photo",
        blobBytes: new Uint8Array(bytes).buffer,
        mimeType: "image/jpeg",
        byteSize: bytes,
        sha256: "e".repeat(64)
      }, options);
    }, { state: runtime, bytes: corpusBytes, options: admissionOptions })).rejects.toThrow(/headroom|storage|synchronize/iu);
    const after = await page.evaluate((partitionKey) => globalThis.DriverOfflineDB.getStorageHealth(partitionKey), runtime.partitionKey);
    expect(after.unsyncedPhotoCount).toBe(countBefore);
    expect(after.evidenceBytes).toBe(before.evidenceBytes);
  } else {
    const countBefore = before.unsyncedPhotoCount;
    let rejected = false;
    try {
      await page.evaluate(async ({ state, bytes }) => {
        await globalThis.DriverOfflineDB.saveDraftPhoto(state.partitionKey, "quota-final", {
          photoId: crypto.randomUUID(),
          ordinal: 0,
          recordType: "driver-stop-photo",
          blobBytes: new Uint8Array(bytes).buffer,
          mimeType: "image/jpeg",
          byteSize: bytes,
          sha256: "e".repeat(64)
        });
      }, { state: runtime, bytes: corpusBytes });
    } catch {
      rejected = true;
    }
    const after = await page.evaluate((partitionKey) => globalThis.DriverOfflineDB.getStorageHealth(partitionKey), runtime.partitionKey);
    expect([countBefore, countBefore + 1]).toContain(after.unsyncedPhotoCount);
    if (rejected) {expect(after.unsyncedPhotoCount).toBe(countBefore);}
  }
  metrics.quota = { scenario, before, corpusBytes };
}

async function reloadRuntime(page) {
  await page.reload();
  await page.addScriptTag({ url: "/driver-photo-hash.js" });
  await page.addScriptTag({ url: "/driver-offline-db.js" });
  await page.addScriptTag({ url: "/driver-offline-photos.js" });
  await page.addScriptTag({ url: "/driver-offline-sync.js" });
}

async function runLifecycleCase(page, context, testCase, runtime, metrics) {
  const generated = await createFullResolutionEvidence(page, testCase, runtime);
  const scenario = testCase.config.scenario;
  if (["reload-after-submit", "renderer-crash-after-submit"].includes(scenario)) {
    await queueCompletion(page, testCase, runtime, generated.photos);
    await reloadRuntime(page);
  } else if (["reload-before-submit", "renderer-crash-before-submit", "schema-reopen"].includes(scenario)) {
    await reloadRuntime(page);
    await queueCompletion(page, testCase, runtime, generated.photos);
  } else if (scenario === "two-tab-lease-race") {
    const secondPage = await context.newPage();
    await secondPage.goto("/health");
    await secondPage.addScriptTag({ url: "/driver-photo-hash.js" });
    await secondPage.addScriptTag({ url: "/driver-offline-db.js" });
    const leases = await Promise.all([
      page.evaluate((partitionKey) => globalThis.DriverOfflineDB.acquireLease(partitionKey, "tab-a", 120000), runtime.partitionKey),
      secondPage.evaluate((partitionKey) => globalThis.DriverOfflineDB.acquireLease(partitionKey, "tab-b", 120000), runtime.partitionKey)
    ]);
    await secondPage.close();
    expect(leases.filter(Boolean)).toHaveLength(1);
    await queueCompletion(page, testCase, runtime, generated.photos);
  } else if (scenario === "partition-lock-recovery") {
    await queueCompletion(page, testCase, runtime, generated.photos);
    await page.evaluate((partitionKey) => globalThis.DriverOfflineDB.lockPartition(partitionKey), runtime.partitionKey);
    const recovered = await page.evaluate(() => globalThis.DriverOfflineDB.recoverDriverDeviceIdentity({ login: "stress-driver" }));
    expect(recovered.recovered).toBe(true);
  } else {
    await queueCompletion(page, testCase, runtime, generated.photos);
    const recovered = await page.evaluate(() => globalThis.DriverOfflineDB.recoverDriverDeviceIdentity({ login: "stress-driver" }));
    expect(recovered.partitionKey).toBe(runtime.partitionKey);
  }
  const snapshot = await rawDatabaseSnapshot(page);
  expect(snapshot.eventCount).toBe(1);
  expect(snapshot.photos).toHaveLength(8);
  expect(snapshot.events[0].photoIds).toHaveLength(8);
  metrics.lifecycle = { scenario, fanout: testCase.config.fanout };
  metrics.source = generated;
}

async function executeCase(page, context, testCase) {
  const metrics = {
    organicErrors: [],
    injectedFaults: [],
    soakPhase: SOAK_PHASE,
    networkProfile: NETWORK_PROFILE
  };
  try {
    const runtime = await loadProductionRuntime(page, testCase);
    if (testCase.group === "historical") {await runHistoricalCase(page, testCase, runtime, metrics);}
    else if (testCase.group === "capture") {await runCaptureCase(page, testCase, runtime, metrics);}
    else if (testCase.group === "network") {await runNetworkCase(page, testCase, runtime, metrics);}
    else if (testCase.group === "quota") {await runQuotaCase(page, testCase, runtime, metrics);}
    else {await runLifecycleCase(page, context, testCase, runtime, metrics);}
  } catch (error) {
    const errorMessage = String(error?.message || "");
    const isIndexedDbError = String(error?.code || "").startsWith("driver_indexeddb_")
      || (errorMessage.includes("UnknownError") && errorMessage.includes("Blob/File data"));
    if (isIndexedDbError && !error?.synthetic) {
      metrics.organicErrors.push({
        name: error.name,
        code: error.code || "driver_indexeddb_unknownerror",
        message: error.message
      });
    }
    throw Object.assign(error, { stressMetrics: metrics });
  }
  return metrics;
}

for (const testCase of BROWSER_CASES) {
  test(`${testCase.id} ${testCase.title} @${testCase.project}`, async ({ page, context }, testInfo) => {
    const startedAt = Date.now();
    try {
      const metrics = await executeCase(page, context, testCase);
      await recordStressResult(testCase, {
        outcome: "passed",
        durationMs: Date.now() - startedAt,
        actualProject: testInfo.project.name,
        metrics
      });
    } catch (error) {
      await recordStressResult(testCase, {
        outcome: "failed",
        durationMs: Date.now() - startedAt,
        actualProject: testInfo.project.name,
        error: String(error?.message || error),
        stack: String(error?.stack || ""),
        metrics: error?.stressMetrics || { organicErrors: [], injectedFaults: [] }
      });
      throw error;
    }
  });
}

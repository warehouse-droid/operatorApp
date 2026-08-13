(function driverOfflineDatabase(global) {
  "use strict";

  const DB_NAME = "mbbs-driver-offline";
  const DB_VERSION = 3;
  const ACTIVE_PARTITION_KEY = "activePartition";
  const DEVICE_ID_KEY = "deviceId";
  const MAX_EVIDENCE_BYTES = 250 * 1024 * 1024;
  const MAX_INSTRUCTION_MEDIA_BYTES = 250 * 1024 * 1024;
  const MAX_INSTRUCTION_MEDIA_FILE_BYTES = 25 * 1024 * 1024;
  // Historical routes are p99 21 stops x 8 photos. Retain three additional
  // stops so route admission never strands a driver at the old 100-photo cap.
  const P99_ROUTE_PHOTOS = 21 * 8;
  const PHOTO_SAFETY_MARGIN = 3 * 8;
  const MAX_UNSYNCED_PHOTOS = P99_ROUTE_PHOTOS + PHOTO_SAFETY_MARGIN;
  const EVIDENCE_RESERVE_RATIO = 0.1;
  const PRESSURE_CAPTURE_TARGET_BYTES = 750 * 1024;
  const SYNCED_RETENTION_MS = 48 * 60 * 60 * 1000;
  const TERMINAL_EVENT_STATUSES = new Set(["applied", "evidence_only", "resolved", "cancelled", "rejected"]);
  const JOB_BOUND_EVENT_TYPES = new Set(["job_started", "job_completed", "truck_switched_physical"]);
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  let openPromise = null;
  let openConnection = null;

  function instructionMediaBinaryBuffer(value) {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    return null;
  }

  function instructionMediaByteSize(record) {
    return Math.max(0, Number(
      record?.byteSize
      || record?.blob?.size
      || instructionMediaBinaryBuffer(record?.blobBytes)?.byteLength
      || 0
    ));
  }

  async function instructionMediaRecordForStorage(record) {
    if (!record) return record;
    const { blob, objectUrl: _objectUrl, ...stored } = record;
    const blobBytes = instructionMediaBinaryBuffer(stored.blobBytes)
      || (blob instanceof Blob ? await blob.arrayBuffer() : null);
    return {
      ...stored,
      blobBytes,
      byteSize: Math.max(0, Number(stored.byteSize || blobBytes?.byteLength || blob?.size || 0))
    };
  }

  function instructionMediaRecordForRuntime(record) {
    if (!record || record.blob instanceof Blob) return record;
    const blobBytes = instructionMediaBinaryBuffer(record.blobBytes);
    if (!blobBytes?.byteLength) return record;
    return {
      ...record,
      blob: new Blob([blobBytes], { type: record.mimeType || "application/octet-stream" })
    };
  }

  function instructionMediaEvictionOrder(left, right, protectedIds = new Set()) {
    const leftProtected = protectedIds.has(String(left?.mediaId || "")) ? 1 : 0;
    const rightProtected = protectedIds.has(String(right?.mediaId || "")) ? 1 : 0;
    return leftProtected - rightProtected
      || Number(left?.priority || 0) - Number(right?.priority || 0)
      || String(left?.lastAccessedAt || left?.updatedAt || "")
        .localeCompare(String(right?.lastAccessedAt || right?.updatedAt || ""))
      || String(left?.mediaId || "").localeCompare(String(right?.mediaId || ""));
  }

  function selectInstructionMediaEvictions(
    records,
    maxBytes = MAX_INSTRUCTION_MEDIA_BYTES,
    protectedMediaIds = []
  ) {
    const limit = Math.max(0, Number(maxBytes || 0));
    const protectedIds = new Set((protectedMediaIds || []).map((value) => String(value || "")));
    const ordered = [...(records || [])]
      .filter((record) => record?.mediaId)
      .sort((left, right) => instructionMediaEvictionOrder(left, right, protectedIds));
    let retainedBytes = ordered.reduce((total, record) => total + instructionMediaByteSize(record), 0);
    const evictedMediaIds = [];
    for (const record of ordered) {
      if (retainedBytes <= limit) break;
      evictedMediaIds.push(String(record.mediaId));
      retainedBytes -= instructionMediaByteSize(record);
    }
    return {
      evictedMediaIds,
      retainedBytes: Math.max(0, retainedBytes),
      limitBytes: limit
    };
  }

  function nonNegativeInteger(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
  }

  function photoAdmissionForHealth(health, byteSize, options = {}) {
    const candidateBytes = nonNegativeInteger(byteSize);
    const retainedEvidenceBytes = nonNegativeInteger(health?.evidenceBytes);
    const retainedPhotoCount = nonNegativeInteger(health?.unsyncedPhotoCount);
    const routeAware = Object.prototype.hasOwnProperty.call(options, "remainingPhotoCount");
    const remainingPhotoCount = routeAware
      ? nonNegativeInteger(options.remainingPhotoCount)
      : 0;
    const expectedBytesPerPhoto = routeAware
      ? Math.max(1, nonNegativeInteger(
        options.expectedBytesPerPhoto,
        PRESSURE_CAPTURE_TARGET_BYTES
      ))
      : 0;
    const optionalCacheBytes = nonNegativeInteger(options.optionalCacheBytes);
    const estimate = options.browserStorageEstimate || {};
    const browserUsageBytes = nonNegativeInteger(estimate.usage);
    const browserQuotaBytes = nonNegativeInteger(estimate.quota);
    const browserFreeBytes = browserQuotaBytes > 0
      ? Math.max(0, browserQuotaBytes - browserUsageBytes)
      : MAX_EVIDENCE_BYTES;
    const browserEvidenceCapacity = browserQuotaBytes > 0
      ? retainedEvidenceBytes + browserFreeBytes + optionalCacheBytes
      : MAX_EVIDENCE_BYTES;
    const availableBudgetBytes = Math.min(
      MAX_EVIDENCE_BYTES,
      Math.max(0, browserEvidenceCapacity)
    );
    const reserveBytes = routeAware
      ? Math.ceil(availableBudgetBytes * EVIDENCE_RESERVE_RATIO)
      : 0;
    const requiredRouteBytes = remainingPhotoCount * expectedBytesPerPhoto;
    const nextBytes = retainedEvidenceBytes + candidateBytes;
    const nextCount = retainedPhotoCount + 1;
    const projectedRouteBytes = nextBytes + requiredRouteBytes + reserveBytes;
    const projectedRoutePhotoCount = nextCount + remainingPhotoCount;
    const allowed = nextBytes <= MAX_EVIDENCE_BYTES
      && nextCount <= MAX_UNSYNCED_PHOTOS
      && projectedRoutePhotoCount <= MAX_UNSYNCED_PHOTOS
      && projectedRouteBytes <= availableBudgetBytes;
    let reason = "";
    if (nextBytes > MAX_EVIDENCE_BYTES) {
      reason = "Offline photo storage has reached 250 MB. Synchronize before taking more required photos.";
    } else if (nextCount > MAX_UNSYNCED_PHOTOS) {
      reason = "There are already 192 unsynchronized photos. Synchronize before taking more required photos.";
    } else if (projectedRoutePhotoCount > MAX_UNSYNCED_PHOTOS) {
      reason = "There is not enough protected photo headroom for the remaining route. Synchronize before taking this required photo.";
    } else if (projectedRouteBytes > availableBudgetBytes) {
      reason = "There is not enough protected device storage headroom for the remaining required route photos. Synchronize or reconnect before taking this photo.";
    }
    return {
      ...health,
      allowed,
      reason,
      nextBytes,
      nextCount,
      remainingPhotoCount,
      expectedBytesPerPhoto,
      requiredRouteBytes,
      reserveBytes,
      projectedRouteBytes,
      projectedRoutePhotoCount,
      availableBudgetBytes,
      browserUsageBytes,
      browserQuotaBytes,
      optionalCacheBytes
    };
  }

  function photoHasLocalBytes(photo) {
    return Boolean(
      (photo?.blob instanceof Blob && photo.blob.size > 0)
      || (photoBinaryBuffer(photo?.blobBytes)?.byteLength || 0) > 0
    );
  }

  function photoBinaryBuffer(value) {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    return null;
  }

  function photoByteSize(photo) {
    return Math.max(0, Number(
      photo?.byteSize
      || photo?.blob?.size
      || photoBinaryBuffer(photo?.blobBytes)?.byteLength
      || 0
    ));
  }

  async function photoRecordForStorage(photo) {
    if (!photo) return photo;
    const { blob, objectUrl: _objectUrl, ...stored } = photo;
    const blobBytes = photoBinaryBuffer(stored.blobBytes)
      || (blob instanceof Blob ? await blob.arrayBuffer() : null);
    return {
      ...stored,
      blobBytes,
      byteSize: Math.max(0, Number(stored.byteSize || blobBytes?.byteLength || blob?.size || 0))
    };
  }

  function photoRecordForRuntime(photo) {
    if (!photo || photo.blob instanceof Blob) return photo;
    const blobBytes = photoBinaryBuffer(photo.blobBytes);
    if (!blobBytes?.byteLength) return photo;
    return {
      ...photo,
      blob: new Blob([blobBytes], { type: photo.mimeType || "image/jpeg" })
    };
  }

  function photoRecordForIndexedDb(photo) {
    if (!photo) return photo;
    const { blob, objectUrl: _objectUrl, ...stored } = photo;
    if (blob instanceof Blob && !photoBinaryBuffer(stored.blobBytes)?.byteLength) {
      throw offlineRepairError(
        "Photo bytes must be converted before updating offline storage.",
        "driver_offline_photo_binary_conversion_required"
      );
    }
    return stored;
  }

  function putPhotoRecord(store, photo) {
    return requestResult(store.put(photoRecordForIndexedDb(photo)));
  }

  function eventRequiresOnlineReconciliation(event) {
    const result = event?.result || {};
    const dvirPending = result.pendingOnline === true && result.samsaraReconciled !== true;
    const dutyPending = result.samsaraDutyPendingOnline === true && result.samsaraDutyReconciled !== true;
    return dvirPending || dutyPending;
  }

  function eventIsRetainedTerminal(event) {
    return TERMINAL_EVENT_STATUSES.has(event?.status) && !eventRequiresOnlineReconciliation(event);
  }

  function offlineRepairError(message, code = "driver_offline_event_repair_failed") {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function indexedDbOperationError(error, operation = "update saved Driver work") {
    if (String(error?.code || "").startsWith("driver_")) return error;
    const name = String(error?.name || "IndexedDBError");
    const detail = String(error?.message || "The browser rejected the offline storage transaction.");
    const wrapped = new Error(`${operation} failed (${name}): ${detail}`);
    wrapped.name = name;
    wrapped.code = `driver_indexeddb_${name.toLowerCase()}`;
    wrapped.cause = error;
    return wrapped;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      let requestError = null;
      transaction.oncomplete = () => resolve();
      transaction.onerror = (event) => {
        requestError = event?.target?.error || transaction.error || requestError;
      };
      transaction.onabort = () => reject(indexedDbOperationError(
        requestError
        || transaction.error
        || new Error("The transaction was aborted before the saved work could be updated."),
        "Updating offline storage"
      ));
    });
  }

  function getAll(source, query) {
    if (typeof source.getAll === "function") return requestResult(source.getAll(query));
    return new Promise((resolve, reject) => {
      const values = [];
      const request = source.openCursor(query);
      request.onerror = () => reject(request.error || new Error("IndexedDB cursor failed."));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(values);
        values.push(cursor.value);
        cursor.continue();
      };
    });
  }

  async function upgradePhotoRecordsToBinary(photoIds = []) {
    const ids = [...new Set((photoIds || []).map((value) => String(value || "")).filter(Boolean))];
    if (!ids.length) return 0;
    const db = await open();
    const readTransaction = db.transaction("photos", "readonly");
    const readCompletion = transactionDone(readTransaction);
    const readStore = readTransaction.objectStore("photos");
    const records = await Promise.all(ids.map((photoId) => requestResult(readStore.get(photoId))));
    await readCompletion;
    const conversions = new Map();
    for (const record of records) {
      if (
        !record?.photoId
        || photoBinaryBuffer(record.blobBytes)?.byteLength
        || !(record.blob instanceof Blob)
      ) continue;
      conversions.set(record.photoId, await record.blob.arrayBuffer());
    }
    if (!conversions.size) return 0;

    const writeTransaction = db.transaction("photos", "readwrite");
    const writeCompletion = transactionDone(writeTransaction);
    const writeStore = writeTransaction.objectStore("photos");
    let upgraded = 0;
    for (const [photoId, blobBytes] of conversions) {
      const current = await requestResult(writeStore.get(photoId));
      if (!current || photoBinaryBuffer(current.blobBytes)?.byteLength) continue;
      await putPhotoRecord(writeStore, { ...current, blobBytes });
      upgraded += 1;
    }
    await writeCompletion;
    return upgraded;
  }

  async function upgradePartitionPhotosToBinary(partitionKey) {
    if (!partitionKey) return 0;
    const db = await open();
    const transaction = db.transaction("photos", "readonly");
    const completion = transactionDone(transaction);
    const photos = await getAll(transaction.objectStore("photos").index("byPartition"), partitionKey);
    await completion;
    return upgradePhotoRecordsToBinary(photos.map((photo) => photo.photoId));
  }

  async function upgradeEventPhotosToBinary(eventId) {
    if (!eventId) return 0;
    const db = await open();
    const transaction = db.transaction("photos", "readonly");
    const completion = transactionDone(transaction);
    const photos = await getAll(transaction.objectStore("photos").index("byEvent"), eventId);
    await completion;
    return upgradePhotoRecordsToBinary(photos.map((photo) => photo.photoId));
  }

  function createUuid() {
    if (global.crypto?.randomUUID) return global.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    global.crypto?.getRandomValues?.(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function normalizeDriverLogin(value) {
    return String(value || "").trim().toLowerCase();
  }

  function makePartitionKey(driverLogin, deviceId) {
    return `${normalizeDriverLogin(driverLogin)}::${String(deviceId || "").trim()}`;
  }

  function makeManifestKey(partitionKey, manifestId) {
    return `${partitionKey}::${String(manifestId || "").trim()}`;
  }

  function ensureIndex(store, name, keyPath, options = {}) {
    if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
  }

  function assertSchema(db) {
    const requiredStores = [
      "meta",
      "profiles",
      "manifests",
      "jobs",
      "events",
      "photos",
      "instructionMedia",
      "leases"
    ];
    const missingStores = requiredStores.filter((name) => !db.objectStoreNames.contains(name));
    if (missingStores.length) {
      throw new Error(`Offline storage upgrade is incomplete (missing ${missingStores.join(", ")}). Close other Driver tabs and reload.`);
    }
  }

  function releaseOpenConnection(db) {
    if (openConnection !== db) return;
    openConnection = null;
    openPromise = null;
  }

  function open() {
    if (!("indexedDB" in global)) return Promise.reject(new Error("Offline storage is not supported by this browser."));
    if (openPromise) return openPromise;
    openPromise = new Promise((resolve, reject) => {
      const request = global.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        const upgrade = request.transaction;
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
        const profiles = db.objectStoreNames.contains("profiles")
          ? upgrade.objectStore("profiles")
          : db.createObjectStore("profiles", { keyPath: "partitionKey" });
        ensureIndex(profiles, "byDriver", "driverLogin", { unique: false });
        const manifests = db.objectStoreNames.contains("manifests")
          ? upgrade.objectStore("manifests")
          : db.createObjectStore("manifests", { keyPath: "key" });
        ensureIndex(manifests, "byPartition", "partitionKey", { unique: false });
        ensureIndex(manifests, "byPartitionDate", ["partitionKey", "planDate"], { unique: false });
        const jobs = db.objectStoreNames.contains("jobs")
          ? upgrade.objectStore("jobs")
          : db.createObjectStore("jobs", { keyPath: "key" });
        ensureIndex(jobs, "byManifest", "manifestKey", { unique: false });
        ensureIndex(jobs, "byPartition", "partitionKey", { unique: false });
        const eventsStoreExists = db.objectStoreNames.contains("events");
        const events = eventsStoreExists
          ? upgrade.objectStore("events")
          : db.createObjectStore("events", { keyPath: "eventId" });
        ensureIndex(events, "byPartition", "partitionKey", { unique: false });
        ensureIndex(events, "byManifest", "manifestId", { unique: false });
        // Sequence allocation is serialized in the same read/write transaction.
        // Keep this migration non-unique when an early v1 database omitted the
        // index, because legacy duplicate rows must remain recoverable evidence.
        ensureIndex(events, "byPartitionSequence", ["partitionKey", "clientSequence"], {
          unique: !eventsStoreExists
        });
        const photos = db.objectStoreNames.contains("photos")
          ? upgrade.objectStore("photos")
          : db.createObjectStore("photos", { keyPath: "photoId" });
        ensureIndex(photos, "byPartition", "partitionKey", { unique: false });
        ensureIndex(photos, "byEvent", "eventId", { unique: false });
        ensureIndex(photos, "byDraft", ["partitionKey", "draftKey"], { unique: false });
        const instructionMedia = db.objectStoreNames.contains("instructionMedia")
          ? upgrade.objectStore("instructionMedia")
          : db.createObjectStore("instructionMedia", { keyPath: "key" });
        ensureIndex(instructionMedia, "byPartition", "partitionKey", { unique: false });
        ensureIndex(instructionMedia, "byPartitionPriority", ["partitionKey", "priority"], { unique: false });
        if (!db.objectStoreNames.contains("leases")) db.createObjectStore("leases", { keyPath: "partitionKey" });
      };
      request.onsuccess = () => {
        const db = request.result;
        try {
          assertSchema(db);
        } catch (error) {
          db.close();
          openPromise = null;
          reject(error);
          return;
        }
        openConnection = db;
        db.onversionchange = () => {
          db.close();
          releaseOpenConnection(db);
        };
        db.onclose = () => releaseOpenConnection(db);
        resolve(db);
      };
      request.onerror = () => {
        openPromise = null;
        reject(request.error || new Error("Offline storage could not be opened."));
      };
      request.onblocked = () => {
        openPromise = null;
        reject(new Error("Offline storage upgrade is blocked by another Driver tab."));
      };
    });
    return openPromise;
  }

  async function getMeta(key) {
    const db = await open();
    const transaction = db.transaction("meta", "readonly");
    return (await requestResult(transaction.objectStore("meta").get(key)))?.value;
  }

  async function setMeta(key, value) {
    const db = await open();
    const transaction = db.transaction("meta", "readwrite");
    transaction.objectStore("meta").put({ key, value, updatedAt: new Date().toISOString() });
    await transactionDone(transaction);
    return value;
  }

  async function getDeviceId() {
    const existing = await getMeta(DEVICE_ID_KEY);
    if (existing) return existing;
    const db = await open();
    const transaction = db.transaction("meta", "readwrite");
    const store = transaction.objectStore("meta");
    const current = (await requestResult(store.get(DEVICE_ID_KEY)))?.value;
    const deviceId = current || createUuid();
    if (!current) store.put({ key: DEVICE_ID_KEY, value: deviceId, updatedAt: new Date().toISOString() });
    await transactionDone(transaction);
    return deviceId;
  }

  async function recoverDriverDeviceIdentity(profile) {
    const driverLogin = normalizeDriverLogin(
      profile?.login || profile?.driverLogin || profile?.username
    );
    if (!driverLogin) return { deviceId: await getDeviceId(), recovered: false };
    const db = await open();
    const readTransaction = db.transaction("profiles", "readonly");
    const readCompletion = transactionDone(readTransaction);
    const profiles = await getAll(
      readTransaction.objectStore("profiles").index("byDriver"),
      driverLogin
    );
    await readCompletion;
    const retained = [];
    for (const candidate of profiles) {
      const health = await getStorageHealth(candidate.partitionKey);
      const retainedCount = Number(health.pendingEventCount || 0)
        + Number(health.reviewRequiredCount || 0)
        + Number(
          health.partitionUnsyncedPhotoCount
          ?? health.unsyncedPhotoCount
          ?? 0
        );
      if (retainedCount > 0) retained.push({ profile: candidate, retainedCount });
    }
    if (!retained.length) return { deviceId: await getDeviceId(), recovered: false };
    retained.sort((left, right) => (
      right.retainedCount - left.retainedCount
      || String(right.profile.lastUsedAt || right.profile.authenticatedAt || "")
        .localeCompare(String(left.profile.lastUsedAt || left.profile.authenticatedAt || ""))
      || String(left.profile.partitionKey).localeCompare(String(right.profile.partitionKey))
    ));
    const recovered = retained[0].profile;
    const transaction = db.transaction("meta", "readwrite");
    const store = transaction.objectStore("meta");
    store.put({ key: DEVICE_ID_KEY, value: recovered.deviceId, updatedAt: new Date().toISOString() });
    await transactionDone(transaction);
    return {
      deviceId: recovered.deviceId,
      partitionKey: recovered.partitionKey,
      retainedCount: retained[0].retainedCount,
      recovered: true
    };
  }

  async function unlockPartition(profile) {
    const driverLogin = normalizeDriverLogin(profile?.login || profile?.driverLogin || profile?.username);
    if (!driverLogin) throw new Error("Driver login is required for offline storage.");
    const deviceId = await getDeviceId();
    const partitionKey = makePartitionKey(driverLogin, deviceId);
    const now = new Date().toISOString();
    const sessionGeneration = createUuid();
    const db = await open();
    const transaction = db.transaction(["profiles", "meta"], "readwrite");
    const profileStore = transaction.objectStore("profiles");
    const activeStore = transaction.objectStore("meta");
    const activePartition = (await requestResult(activeStore.get(ACTIVE_PARTITION_KEY)))?.value;
    if (activePartition && activePartition !== partitionKey) {
      const activeProfile = await requestResult(profileStore.get(activePartition));
      if (activeProfile) profileStore.put({ ...activeProfile, locked: true, lockedAt: now });
    }
    const previous = await requestResult(profileStore.get(partitionKey));
    profileStore.put({
      ...(previous || {}),
      partitionKey,
      driverLogin,
      deviceId,
      profile: { ...(previous?.profile || {}), ...profile, login: driverLogin },
      locked: false,
      sessionGeneration,
      authenticatedAt: now,
      lastUsedAt: now
    });
    activeStore.put({ key: ACTIVE_PARTITION_KEY, value: partitionKey, updatedAt: now });
    await transactionDone(transaction);
    return {
      partitionKey,
      driverLogin,
      deviceId,
      profile: { ...(previous?.profile || {}), ...profile, login: driverLogin },
      locked: false,
      sessionGeneration,
      authenticatedAt: now,
      lastUsedAt: now
    };
  }

  async function getProfile(partitionKey) {
    if (!partitionKey) return null;
    const db = await open();
    const transaction = db.transaction("profiles", "readonly");
    return (await requestResult(transaction.objectStore("profiles").get(partitionKey))) || null;
  }

  async function getActiveProfile() {
    const partitionKey = await getMeta(ACTIVE_PARTITION_KEY);
    const profile = await getProfile(partitionKey);
    return profile && !profile.locked ? profile : null;
  }

  async function lockPartition(partitionKey, { expectedSessionGeneration = "" } = {}) {
    if (!partitionKey) return false;
    const db = await open();
    const transaction = db.transaction(["profiles", "meta", "leases"], "readwrite");
    const profiles = transaction.objectStore("profiles");
    const existing = await requestResult(profiles.get(partitionKey));
    if (
      expectedSessionGeneration
      && existing?.sessionGeneration
      && existing.sessionGeneration !== expectedSessionGeneration
    ) {
      await transactionDone(transaction);
      return false;
    }
    if (existing) profiles.put({ ...existing, locked: true, lockedAt: new Date().toISOString() });
    const active = await requestResult(transaction.objectStore("meta").get(ACTIVE_PARTITION_KEY));
    if (active?.value === partitionKey) transaction.objectStore("meta").delete(ACTIVE_PARTITION_KEY);
    transaction.objectStore("leases").delete(partitionKey);
    await transactionDone(transaction);
    return true;
  }

  async function lockActivePartition() {
    const partitionKey = await getMeta(ACTIVE_PARTITION_KEY);
    await lockPartition(partitionKey);
  }

  function normalizeManifest(payload, partitionKey, complete) {
    const manifestId = String(payload?.manifestId || payload?.routeBootstrap?.manifestId || "").trim();
    if (!manifestId) throw new Error("The server did not return an offline manifest ID.");
    const planDate = String(payload?.planDate || payload?.date || payload?.dayState?.planDate || "").slice(0, 10);
    const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    return {
      key: makeManifestKey(partitionKey, manifestId),
      manifestId,
      partitionKey,
      planDate,
      planId: payload?.planId || null,
      planRevision: payload?.planRevision ?? payload?.revision ?? null,
      routeContentFingerprint: payload?.routeContentFingerprint
        || payload?.routeFingerprint
        || payload?.contentFingerprint
        || null,
      schemaVersion: payload?.schemaVersion || 1,
      fingerprintVersion: payload?.fingerprintVersion || 1,
      generatedAt: payload?.generatedAt || new Date().toISOString(),
      expiresAt: payload?.expiresAt || null,
      offlineSyncGrant: payload?.offlineSyncGrant || payload?.syncGrant || payload?.grant || null,
      dayState: payload?.dayState || payload?.state || null,
      samsaraWorkflowEnabled: payload?.samsaraWorkflowEnabled,
      complete: Boolean(complete),
      jobCount: jobs.length,
      payload: { ...payload, jobs: undefined },
      updatedAt: new Date().toISOString(),
      jobs
    };
  }

  async function saveManifestAtomic(partitionKey, payload, { complete = true, activate = true } = {}) {
    const normalized = normalizeManifest(payload, partitionKey, complete);
    const db = await open();
    const transaction = db.transaction(["manifests", "jobs", "meta"], "readwrite");
    const manifests = transaction.objectStore("manifests");
    const jobsStore = transaction.objectStore("jobs");
    const prior = await requestResult(manifests.get(normalized.key));
    const replaceJobs = Boolean(complete || !prior?.complete);
    const priorJobs = replaceJobs ? await getAll(jobsStore.index("byManifest"), normalized.key) : [];
    priorJobs.forEach((job) => jobsStore.delete(job.key));
    const manifestRecord = { ...normalized };
    delete manifestRecord.jobs;
    manifests.put({
      ...(prior || {}),
      ...manifestRecord,
      complete: Boolean(complete || prior?.complete),
      jobCount: replaceJobs ? normalized.jobCount : prior?.jobCount,
      payload: prior?.complete && !complete ? { ...prior.payload, dayState: normalized.dayState } : normalized.payload,
      offlineSyncGrant: normalized.offlineSyncGrant || prior?.offlineSyncGrant || null
    });
    if (replaceJobs) normalized.jobs.forEach((job, index) => {
      const sequenceIndex = Number.isFinite(Number(job.sequenceIndex)) ? Number(job.sequenceIndex) : index;
      jobsStore.put({
        ...job,
        key: `${normalized.key}::${String(sequenceIndex).padStart(6, "0")}::${job.jobId || index}`,
        manifestKey: normalized.key,
        manifestId: normalized.manifestId,
        partitionKey,
        sequenceIndex
      });
    });
    const metaStore = transaction.objectStore("meta");
    if (activate) {
      metaStore.put({
        key: `activeManifest::${partitionKey}`,
        value: normalized.key,
        updatedAt: new Date().toISOString()
      });
      metaStore.delete(`deferredManifest::${partitionKey}`);
    } else {
      metaStore.put({
        key: `deferredManifest::${partitionKey}`,
        value: normalized.key,
        updatedAt: new Date().toISOString()
      });
    }
    await transactionDone(transaction);
    return getManifestByKey(normalized.key);
  }

  async function replaceTerminalRouteCache(partitionKey, payload, { expectedSessionGeneration = "" } = {}) {
    if (!partitionKey) throw new Error("An authenticated Driver cache partition is required.");
    const normalized = normalizeManifest(payload, partitionKey, true);
    if (!Array.isArray(payload?.jobs) || payload?.complete === false) {
      throw new Error("A complete fresh route is required before the saved route can be cleared.");
    }
    const db = await open();
    const transaction = db.transaction(["profiles", "manifests", "jobs", "events", "photos", "meta"], "readwrite");
    const completion = transactionDone(transaction);
    const manifestsStore = transaction.objectStore("manifests");
    const jobsStore = transaction.objectStore("jobs");
    const eventsStore = transaction.objectStore("events");
    const photosStore = transaction.objectStore("photos");
    const metaStore = transaction.objectStore("meta");
    const profilesStore = transaction.objectStore("profiles");
    const [profile, events, photos, manifests, jobs] = await Promise.all([
      requestResult(profilesStore.get(partitionKey)),
      getAll(eventsStore.index("byPartition"), partitionKey),
      getAll(photosStore.index("byPartition"), partitionKey),
      getAll(manifestsStore.index("byPartition"), partitionKey),
      getAll(jobsStore.index("byPartition"), partitionKey)
    ]);
    if (
      !profile
      || profile.locked
      || (
        expectedSessionGeneration
        && profile.sessionGeneration !== expectedSessionGeneration
      )
    ) {
      await completion;
      const error = new Error("This Driver cache was locked by a logout or session change.");
      error.code = "driver_session_changed";
      throw error;
    }
    const blockingEvents = events.filter((event) => !eventIsRetainedTerminal(event));
    const protectedPhotos = photos.filter((photo) =>
      photoHasLocalBytes(photo)
      || photo.status !== "durably_received"
      || !photo.eventId
    );
    if (blockingEvents.length || protectedPhotos.length) {
      await completion;
      const error = new Error(
        "Saved work is still pending. Synchronize or resolve it before clearing the saved route."
      );
      error.code = "driver_route_cache_not_clearable";
      error.pendingEventCount = blockingEvents.length;
      error.unsyncedPhotoCount = protectedPhotos.length;
      throw error;
    }

    // Only acknowledged terminal route records are replaceable. Profile,
    // authentication/session metadata, the browser device ID, client sequence,
    // and every other Driver partition remain untouched.
    events.forEach((event) => eventsStore.delete(event.eventId));
    photos.forEach((photo) => photosStore.delete(photo.photoId));
    jobs.forEach((job) => jobsStore.delete(job.key));
    manifests.forEach((manifest) => manifestsStore.delete(manifest.key));
    metaStore.delete(`activeManifest::${partitionKey}`);
    metaStore.delete(`deferredManifest::${partitionKey}`);

    const manifestRecord = { ...normalized };
    delete manifestRecord.jobs;
    manifestsStore.put(manifestRecord);
    normalized.jobs.forEach((job, index) => {
      const sequenceIndex = Number.isFinite(Number(job.sequenceIndex)) ? Number(job.sequenceIndex) : index;
      jobsStore.put({
        ...job,
        key: `${normalized.key}::${String(sequenceIndex).padStart(6, "0")}::${job.jobId || index}`,
        manifestKey: normalized.key,
        manifestId: normalized.manifestId,
        partitionKey,
        sequenceIndex
      });
    });
    metaStore.put({
      key: `activeManifest::${partitionKey}`,
      value: normalized.key,
      updatedAt: new Date().toISOString()
    });
    await completion;
    return getManifestByKey(normalized.key);
  }

  async function saveBootstrap(partitionKey, nextJobPayload, { activate = true } = {}) {
    const bootstrap = nextJobPayload?.routeBootstrap;
    if (!bootstrap?.manifestId) return null;
    const job = nextJobPayload?.job
      ? [{
          ...nextJobPayload.job,
          fingerprint: bootstrap.currentJobFingerprint || bootstrap.jobFingerprint || bootstrap.fingerprint || nextJobPayload.job.fingerprint,
          predecessorFingerprint: bootstrap.predecessorFingerprint || nextJobPayload.job.predecessorFingerprint,
          contentFingerprint: bootstrap.currentJobContentFingerprint
            || bootstrap.contentFingerprint
            || nextJobPayload.job.contentFingerprint
            || nextJobPayload.job.snapshotFingerprint,
          sequenceIndex: Number(bootstrap.sequenceIndex || 0)
        }]
      : [];
    return saveManifestAtomic(partitionKey, {
      ...bootstrap,
      jobs: job,
      dayState: nextJobPayload.state,
      planDate: bootstrap.planDate || nextJobPayload.state?.planDate || nextJobPayload.job?.planDate
    }, { complete: false, activate });
  }

  async function getManifestByKey(key) {
    if (!key) return null;
    const db = await open();
    const transaction = db.transaction(["manifests", "jobs"], "readonly");
    const manifest = await requestResult(transaction.objectStore("manifests").get(key));
    if (!manifest) return null;
    const jobs = await getAll(transaction.objectStore("jobs").index("byManifest"), key);
    jobs.sort((left, right) => Number(left.sequenceIndex || 0) - Number(right.sequenceIndex || 0));
    return { ...manifest, jobs };
  }

  async function getActiveManifest(partitionKey) {
    const key = await getMeta(`activeManifest::${partitionKey}`);
    if (key) {
      const active = await getManifestByKey(key);
      if (active) return active;
    }
    const db = await open();
    const transaction = db.transaction("manifests", "readonly");
    const records = await getAll(transaction.objectStore("manifests").index("byPartition"), partitionKey);
    records.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
    return records[0] ? getManifestByKey(records[0].key) : null;
  }

  async function getManifest(partitionKey, manifestId) {
    return getManifestByKey(makeManifestKey(partitionKey, manifestId));
  }

  async function getDeferredManifest(partitionKey) {
    const key = await getMeta(`deferredManifest::${partitionKey}`);
    return key ? getManifestByKey(key) : null;
  }

  async function activateManifest(partitionKey, manifestId) {
    const key = makeManifestKey(partitionKey, manifestId);
    const manifest = await getManifestByKey(key);
    if (!manifest) throw new Error("The saved route update is no longer available.");
    const db = await open();
    const transaction = db.transaction("meta", "readwrite");
    const store = transaction.objectStore("meta");
    store.put({
      key: `activeManifest::${partitionKey}`,
      value: key,
      updatedAt: new Date().toISOString()
    });
    store.delete(`deferredManifest::${partitionKey}`);
    await transactionDone(transaction);
    return manifest;
  }

  async function getManifestBlockingState(partitionKey, activeManifest) {
    if (!activeManifest?.manifestId) return { eventCount: 0, reviewCount: 0, draftPhotoCount: 0, blocked: false };
    const db = await open();
    const transaction = db.transaction(["manifests", "events", "photos"], "readonly");
    const manifests = await getAll(transaction.objectStore("manifests").index("byPartition"), partitionKey);
    const compatibleManifestIds = new Set(manifests
      .filter((manifest) =>
        manifest.manifestId === activeManifest.manifestId
        || (
          String(manifest.planId ?? "") === String(activeManifest.planId ?? "")
          && String(manifest.planDate || "") === String(activeManifest.planDate || "")
          && String(manifest.planRevision ?? "") === String(activeManifest.planRevision ?? "")
        )
      )
      .map((manifest) => String(manifest.manifestId || "")));
    compatibleManifestIds.add(String(activeManifest.manifestId));
    const events = await getAll(transaction.objectStore("events").index("byPartition"), partitionKey);
    const blockingEvents = events.filter((event) =>
      compatibleManifestIds.has(String(event.manifestId || ""))
      && !eventIsRetainedTerminal(event)
    );
    const reviewCount = blockingEvents.filter((event) =>
      event.reviewRequired || ["review_required", "blocked"].includes(event.status)
    ).length;
    const photos = await getAll(transaction.objectStore("photos").index("byPartition"), partitionKey);
    const draftPhotoCount = photos.filter((photo) => {
      if (photo.eventId || !photoHasLocalBytes(photo) || !photo.draftKey) return false;
      const parts = String(photo.draftKey).split(":");
      return compatibleManifestIds.has(parts[1]);
    }).length;
    return {
      eventCount: blockingEvents.length,
      reviewCount,
      draftPhotoCount,
      blocked: blockingEvents.length > 0 || draftPhotoCount > 0
    };
  }

  async function saveDraftPhoto(partitionKey, draftKey, photo, options = {}) {
    const { replacePhotoId = "" } = options;
    const record = await photoRecordForStorage({
      ...photo,
      photoId: photo.photoId || createUuid(),
      partitionKey,
      draftKey,
      eventId: null,
      status: "draft",
      createdAt: photo.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    const db = await open();
    const transaction = db.transaction("photos", "readwrite");
    const store = transaction.objectStore("photos");
    const photos = await getAll(store);
    const existingRecord = photos.find((candidate) => candidate.photoId === record.photoId);
    if (
      existingRecord
      && (
        existingRecord.partitionKey !== partitionKey
        || existingRecord.eventId
      )
    ) {
      await transactionDone(transaction);
      throw new Error("A photo already committed as event evidence cannot be replaced.");
    }
    const explicitReplacement = replacePhotoId
      ? photos.find((candidate) => candidate.photoId === replacePhotoId)
      : null;
    if (
      explicitReplacement
      && (
        explicitReplacement.partitionKey !== partitionKey
        || explicitReplacement.eventId
      )
    ) {
      await transactionDone(transaction);
      throw new Error("A photo already committed as event evidence cannot be replaced.");
    }
    const slotReplacements = photos.filter((candidate) =>
      candidate.partitionKey === partitionKey
      && !candidate.eventId
      && String(candidate.draftKey || "") === String(draftKey || "")
      && Number(candidate.ordinal || 0) === Number(record.ordinal || 0)
    );
    const replacementIds = new Set([
      ...(existingRecord ? [existingRecord.photoId] : []),
      ...(explicitReplacement ? [explicitReplacement.photoId] : []),
      ...slotReplacements.map((candidate) => candidate.photoId)
    ]);
    const unsyncedPhotos = photos.filter((candidate) =>
      !replacementIds.has(candidate.photoId)
      && photoHasLocalBytes(candidate)
      && candidate.status !== "durably_received"
    );
    const evidenceBytes = unsyncedPhotos.reduce(
      (sum, candidate) => sum + photoByteSize(candidate),
      0
    );
    const admission = photoAdmissionForHealth({
      evidenceBytes,
      unsyncedPhotoCount: unsyncedPhotos.length,
      maxEvidenceBytes: MAX_EVIDENCE_BYTES,
      maxUnsyncedPhotos: MAX_UNSYNCED_PHOTOS
    }, photoByteSize(record), options);
    if (!admission.allowed) {
      await transactionDone(transaction);
      throw new Error(admission.reason);
    }
    await putPhotoRecord(store, record);
    for (const replacementId of replacementIds) {
      if (replacementId !== record.photoId) store.delete(replacementId);
    }
    await transactionDone(transaction);
    return photoRecordForRuntime(record);
  }

  async function getDraftPhotos(partitionKey, draftKey) {
    const db = await open();
    const transaction = db.transaction("photos", "readonly");
    const records = await getAll(
      transaction.objectStore("photos").index("byDraft"),
      global.IDBKeyRange.only([partitionKey, draftKey])
    );
    return records
      .sort((left, right) => Number(left.ordinal || 0) - Number(right.ordinal || 0))
      .map(photoRecordForRuntime);
  }

  async function getCompatibleDraftPhotos(partitionKey, activeManifest, kind, suffix) {
    if (!activeManifest?.manifestId) return [];
    const db = await open();
    const transaction = db.transaction(["manifests", "photos"], "readonly");
    const manifests = await getAll(transaction.objectStore("manifests").index("byPartition"), partitionKey);
    const compatibleIds = new Set(manifests
      .filter((manifest) =>
        String(manifest.planId ?? "") === String(activeManifest.planId ?? "")
        && String(manifest.planDate || "") === String(activeManifest.planDate || "")
        && String(manifest.planRevision ?? "") === String(activeManifest.planRevision ?? "")
      )
      .map((manifest) => manifest.manifestId));
    compatibleIds.add(activeManifest.manifestId);
    const photos = await getAll(transaction.objectStore("photos").index("byPartition"), partitionKey);
    const byOrdinal = new Map();
    photos
      .filter((photo) => {
        if (photo.eventId || !photo.draftKey) return false;
        const parts = String(photo.draftKey).split(":");
        return parts[0] === kind && compatibleIds.has(parts[1]) && parts.slice(2).join(":") === String(suffix || "");
      })
      .sort((left, right) => String(left.updatedAt || "").localeCompare(String(right.updatedAt || "")))
      .forEach((photo) => byOrdinal.set(Number(photo.ordinal || 0), photo));
    return [...byOrdinal.values()]
      .sort((left, right) => Number(left.ordinal || 0) - Number(right.ordinal || 0))
      .map(photoRecordForRuntime);
  }

  async function deleteDraftPhoto(photoId) {
    if (!photoId) return;
    const db = await open();
    const transaction = db.transaction("photos", "readwrite");
    const store = transaction.objectStore("photos");
    const record = await requestResult(store.get(photoId));
    if (record && !record.eventId) store.delete(photoId);
    await transactionDone(transaction);
  }

  async function queueEvent(partitionKey, input) {
    await upgradePhotoRecordsToBinary((input.photos || []).map((photo) =>
      typeof photo === "string" ? photo : photo?.photoId
    ));
    const db = await open();
    const transaction = db.transaction(["events", "photos", "meta"], "readwrite");
    const completion = transactionDone(transaction);
    // Validation paths intentionally abort this transaction before reaching the
    // final await. Mark the completion rejection handled while preserving it for
    // the successful write path below.
    void completion.catch(() => {});
    const eventsStore = transaction.objectStore("events");
    const photosStore = transaction.objectStore("photos");
    const sequenceKey = `sequence::${partitionKey}`;
    const metaStore = transaction.objectStore("meta");
    const [sequenceRecord, partitionEvents] = await Promise.all([
      requestResult(metaStore.get(sequenceKey)),
      getAll(eventsStore.index("byPartition"), partitionKey)
    ]);
    const highestStoredSequence = partitionEvents.reduce((highest, event) => {
      const candidate = Number(event.clientSequence);
      return Number.isSafeInteger(candidate) && candidate > highest ? candidate : highest;
    }, 0);
    const storedSequence = Number(sequenceRecord?.value);
    const lastSequence = Number.isSafeInteger(storedSequence) && storedSequence >= 0
      ? Math.max(storedSequence, highestStoredSequence)
      : highestStoredSequence;
    if (lastSequence >= Number.MAX_SAFE_INTEGER) {
      transaction.abort();
      throw offlineRepairError(
        "This device's saved event sequence is exhausted and requires support review.",
        "driver_offline_sequence_exhausted"
      );
    }
    const clientSequence = lastSequence + 1;
    const eventId = input.eventId || createUuid();
    const occurredAt = input.occurredAt || new Date().toISOString();
    const requiredPhotoCount = Number(input.requiredPhotoCount ?? 0);
    if (
      !Number.isInteger(requiredPhotoCount)
      || requiredPhotoCount < 0
      || requiredPhotoCount > MAX_UNSYNCED_PHOTOS
    ) {
      transaction.abort();
      throw new Error("The required photo count is invalid.");
    }
    if (input.eventType === "job_completed") {
      const requestedJobId = String(input.jobId || "");
      const requestedFingerprint = String(input.jobFingerprint || "");
      const requestedPredecessor = String(input.predecessorFingerprint || "");
      const openCompletion = partitionEvents.find((candidate) =>
        candidate.eventType === "job_completed"
        && !eventIsRetainedTerminal(candidate)
        && String(candidate.jobId || "") === requestedJobId
        && String(candidate.jobFingerprint || "") === requestedFingerprint
        && String(candidate.predecessorFingerprint || "") === requestedPredecessor
      );
      if (openCompletion) {
        if (String(openCompletion.eventId || "") === String(eventId)) {
          await completion;
          return openCompletion;
        }
        transaction.abort();
        const error = offlineRepairError(
          "This stop completion is already saved on this device and still needs synchronization.",
          "driver_completion_already_saved"
        );
        error.existingEvent = {
          eventId: openCompletion.eventId,
          status: openCompletion.status,
          jobId: openCompletion.jobId
        };
        throw error;
      }
    }
    if (input.enforcePhotoCompletionLimit) {
      const allPhotos = await getAll(photosStore);
      const unsyncedPhotos = allPhotos.filter((photo) =>
        photoHasLocalBytes(photo) && photo.status !== "durably_received"
      );
      const evidenceBytes = unsyncedPhotos.reduce(
        (sum, photo) => sum + photoByteSize(photo),
        0
      );
      if (
        evidenceBytes > MAX_EVIDENCE_BYTES
        || unsyncedPhotos.length > MAX_UNSYNCED_PHOTOS
      ) {
        await completion;
        throw new Error(evidenceBytes > MAX_EVIDENCE_BYTES
          ? "Offline photo storage has reached 250 MB. Synchronize before completing another photo-required action."
          : "There are already 192 unsynchronized photos. Synchronize before completing another photo-required action.");
      }
    }
    // Resolve and validate the complete evidence set before changing ownership.
    // This prevents a concurrent/double completion from stealing photos from an
    // event that is already durable in the local ledger.
    const photoIds = [];
    const photoRecords = [];
    const photoOrdinals = new Set();
    for (const photo of input.photos || []) {
      const photoId = typeof photo === "string" ? photo : photo?.photoId;
      if (!photoId) continue;
      if (photoIds.includes(photoId)) {
        transaction.abort();
        throw new Error("The same captured photo cannot be used twice for one action.");
      }
      const existing = await requestResult(photosStore.get(photoId));
      if (!existing || existing.partitionKey !== partitionKey) {
        transaction.abort();
        throw new Error("A captured photo is missing from offline storage.");
      }
      if (existing.eventId && existing.eventId !== eventId) {
        transaction.abort();
        throw new Error("A captured photo is already committed to another saved action.");
      }
      const ordinal = Number(existing.ordinal);
      if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > 999) {
        transaction.abort();
        throw new Error("A captured photo has an invalid slot number.");
      }
      if (photoOrdinals.has(ordinal)) {
        transaction.abort();
        throw new Error("Each required photo must occupy a different slot.");
      }
      photoIds.push(photoId);
      photoOrdinals.add(ordinal);
      photoRecords.push(existing);
    }
    if (photoRecords.length < requiredPhotoCount) {
      transaction.abort();
      throw new Error(`${requiredPhotoCount} saved photo${requiredPhotoCount === 1 ? " is" : "s are"} required before completing this action.`);
    }
    const ownershipUpdatedAt = new Date().toISOString();
    for (const existing of photoRecords) {
      await putPhotoRecord(photosStore, {
        ...existing,
        eventId,
        draftKey: null,
        status: existing.objectReference ? "uploaded_unverified" : "local",
        updatedAt: ownershipUpdatedAt
      });
    }
    const createdAt = new Date().toISOString();
    const syncPayload = {
      eventId,
      clientSequence,
      eventType: input.eventType,
      jobId: input.jobId || null,
      jobFingerprint: input.jobFingerprint || null,
      predecessorFingerprint: input.predecessorFingerprint || null,
      occurredAt,
      locationStatus: input.locationStatus || "not_checked_offline",
      locationVerificationId: input.locationVerificationId || null,
      locationOverride: Boolean(input.locationOverride),
      details: input.details || {},
      photos: photoRecords
        .slice()
        .sort((left, right) => Number(left.ordinal || 0) - Number(right.ordinal || 0))
        .map((photo) => ({
          photoId: photo.photoId,
          ordinal: Number(photo.ordinal || 0),
          mimeType: photo.mimeType || "image/jpeg",
          byteSize: photoByteSize(photo),
          sha256: photo.sha256,
          recordType: photo.recordType || "driver-stop-photo"
        }))
    };
    const eventRecord = {
      ...input,
      eventId,
      partitionKey,
      clientSequence,
      occurredAt,
      photoIds,
      requiredPhotoCount,
      photos: undefined,
      status: input.initialStatus || "pending",
      initialStatus: undefined,
      enforcePhotoCompletionLimit: undefined,
      receivedAt: null,
      appliedAt: null,
      syncAttempts: 0,
      // Freeze the exact registration envelope in the same IndexedDB
      // transaction as the evidence ownership and client sequence. A network
      // response can be lost after the server commits, so no later repair may
      // change this payload.
      syncPayload,
      syncPayloadSealedAt: createdAt,
      localPayloadRepairSafe: true,
      createdAt,
      updatedAt: createdAt
    };
    try {
      await requestResult(eventsStore.add(eventRecord));
      await requestResult(metaStore.put({
        key: sequenceKey,
        value: clientSequence,
        updatedAt: new Date().toISOString()
      }));
      await completion;
    } catch (error) {
      await completion.catch(() => {});
      throw indexedDbOperationError(error, "Saving this stop on the device");
    }
    return eventRecord;
  }

  async function repairEventForSync(partitionKey, eventId) {
    const expectedPartition = String(partitionKey || "");
    const expectedEventId = String(eventId || "");
    if (!expectedPartition || !expectedEventId) {
      throw offlineRepairError(
        "The offline event partition and event ID are required for recovery.",
        "driver_offline_event_identity_missing"
      );
    }
    await upgradePartitionPhotosToBinary(expectedPartition);
    const db = await open();
    const transaction = db.transaction(["events", "manifests", "jobs", "photos"], "readwrite");
    const completion = transactionDone(transaction);
    const eventsStore = transaction.objectStore("events");
    const manifestsStore = transaction.objectStore("manifests");
    const jobsStore = transaction.objectStore("jobs");
    const photosStore = transaction.objectStore("photos");
    const event = await requestResult(eventsStore.get(expectedEventId));
    const fail = async (message, code) => {
      await completion;
      throw offlineRepairError(message, code);
    };
    if (!event || event.partitionKey !== expectedPartition) {
      return fail(
        "The offline event is missing from this Driver partition.",
        "driver_offline_event_identity_missing"
      );
    }
    // Once an event has crossed the network boundary, every retry must use the
    // byte-for-byte-equivalent registration payload. This also covers a lost
    // HTTP response: the server may have accepted the first request even while
    // the local event still looks pending.
    if (event.syncPayload && typeof event.syncPayload === "object") {
      await completion;
      return event;
    }
    if (eventIsRetainedTerminal(event)) {
      await completion;
      return event;
    }

    let repaired = event;
    let exactManifest = null;
    let exactManifestJob = null;
    if (JOB_BOUND_EVENT_TYPES.has(event.eventType)) {
      const jobId = String(event.jobId || "").trim();
      const manifestId = String(event.manifestId || "").trim();
      if (!jobId) {
        return fail(
          "A saved job event has no job ID and cannot be repaired automatically.",
          "driver_offline_event_job_id_missing"
        );
      }
      if (!manifestId) {
        return fail(
          "A saved job event has no route manifest and cannot be repaired automatically.",
          "driver_offline_event_manifest_missing"
        );
      }
      const manifestKey = makeManifestKey(expectedPartition, manifestId);
      const manifest = await requestResult(manifestsStore.get(manifestKey));
      if (
        !manifest
        || manifest.partitionKey !== expectedPartition
        || String(manifest.manifestId || "") !== manifestId
      ) {
        return fail(
          "The saved job event's exact route manifest is unavailable.",
          "driver_offline_event_manifest_missing"
        );
      }
      const manifestJobs = await getAll(jobsStore.index("byManifest"), manifestKey);
      const matches = manifestJobs.filter((job) =>
        job.partitionKey === expectedPartition
        && String(job.manifestId || "") === manifestId
        && String(job.jobId || "") === jobId
      );
      if (matches.length !== 1) {
        return fail(
          matches.length
            ? "The saved route contains an ambiguous job identity."
            : "The saved job is not present in its exact route manifest.",
          "driver_offline_event_job_identity_unavailable"
        );
      }
      exactManifest = manifest;
      exactManifestJob = matches[0];
      const manifestFingerprint = String(matches[0].fingerprint || "").trim();
      const manifestPredecessor = String(matches[0].predecessorFingerprint || "").trim();
      if (!manifestFingerprint || !manifestPredecessor) {
        return fail(
          "The saved route job is missing its immutable identity.",
          "driver_offline_event_job_identity_unavailable"
        );
      }
      const eventFingerprint = String(event.jobFingerprint || "").trim();
      const eventPredecessor = String(event.predecessorFingerprint || "").trim();
      if (
        (eventFingerprint && eventFingerprint !== manifestFingerprint)
        || (eventPredecessor && eventPredecessor !== manifestPredecessor)
      ) {
        return fail(
          "The saved event identity conflicts with its exact route manifest.",
          "driver_offline_event_job_identity_conflict"
        );
      }
      if (!eventFingerprint || !eventPredecessor) {
        repaired = {
          ...repaired,
          ...(!eventFingerprint ? { jobFingerprint: manifestFingerprint } : {}),
          ...(!eventPredecessor ? { predecessorFingerprint: manifestPredecessor } : {})
        };
      }
    }

    if (
      repaired.eventType === "job_completed"
      && repaired.localPayloadRepairSafe === true
      && !repaired.receivedAt
      && exactManifest
      && exactManifestJob
    ) {
      const partitionManifests = await getAll(
        manifestsStore.index("byPartition"),
        expectedPartition
      );
      const compatibleManifestIds = new Set(partitionManifests
        .filter((candidate) =>
          String(candidate.manifestId || "") === String(exactManifest.manifestId || "")
          || (
            String(candidate.planId ?? "") === String(exactManifest.planId ?? "")
            && String(candidate.planDate || "") === String(exactManifest.planDate || "")
            && String(candidate.planRevision ?? "") === String(exactManifest.planRevision ?? "")
          )
        )
        .map((candidate) => String(candidate.manifestId || "")));
      compatibleManifestIds.add(String(exactManifest.manifestId || ""));

      const expectedJobId = String(repaired.jobId || "");
      const expectedFingerprint = String(exactManifestJob.fingerprint || "").trim();
      const expectedPredecessor = String(exactManifestJob.predecessorFingerprint || "").trim();
      const partitionEvents = await getAll(
        eventsStore.index("byPartition"),
        expectedPartition
      );
      const duplicateCompletions = partitionEvents
        .map((candidate) => candidate.eventId === repaired.eventId ? repaired : candidate)
        .filter((candidate) => {
          if (
            candidate.eventType !== "job_completed"
            || candidate.syncPayload
            || candidate.receivedAt
            || eventIsRetainedTerminal(candidate)
            || String(candidate.jobId || "") !== expectedJobId
            || !compatibleManifestIds.has(String(candidate.manifestId || ""))
          ) return false;
          const candidateFingerprint = String(candidate.jobFingerprint || "").trim();
          const candidatePredecessor = String(candidate.predecessorFingerprint || "").trim();
          return (!candidateFingerprint || candidateFingerprint === expectedFingerprint)
            && (!candidatePredecessor || candidatePredecessor === expectedPredecessor);
        })
        .sort((left, right) =>
          Number(left.clientSequence || 0) - Number(right.clientSequence || 0)
          || String(left.createdAt || "").localeCompare(String(right.createdAt || ""))
        );
      const canonical = duplicateCompletions[0] || null;
      const duplicateIds = new Set(duplicateCompletions.map((candidate) => candidate.eventId));
      const allPartitionPhotos = await getAll(
        photosStore.index("byPartition"),
        expectedPartition
      );
      const repairablePhotos = allPartitionPhotos.filter((photo) => {
        if (duplicateIds.has(photo.eventId)) return true;
        if (photo.eventId || !photo.draftKey) return false;
        const draftParts = String(photo.draftKey).split(":");
        return draftParts[0] === "job"
          && compatibleManifestIds.has(draftParts[1])
          && draftParts.slice(2).join(":") === expectedJobId;
      });
      const savedRequiredPhotoCount = Number(repaired.requiredPhotoCount || 0);
      const manifestRequiredPhotoCount = Number(exactManifestJob.requiredPhotos || 0);
      const requiredPhotoCount = Math.max(
        0,
        Number.isFinite(savedRequiredPhotoCount) ? savedRequiredPhotoCount : 0,
        Number.isFinite(manifestRequiredPhotoCount) ? manifestRequiredPhotoCount : 0
      );

      // Nothing is cancelled or rebound until the canonical completion can be
      // made whole. If evidence is still missing it remains untouched for a
      // later retry or Dispatch review.
      if (canonical && repairablePhotos.length >= requiredPhotoCount) {
        const ownerSequence = new Map(duplicateCompletions.map((candidate) => [
          candidate.eventId,
          Number(candidate.clientSequence || 0)
        ]));
        repairablePhotos.sort((left, right) => {
          const leftOwner = left.eventId === canonical.eventId
            ? -1
            : ownerSequence.has(left.eventId)
              ? ownerSequence.get(left.eventId)
              : Number.MAX_SAFE_INTEGER;
          const rightOwner = right.eventId === canonical.eventId
            ? -1
            : ownerSequence.has(right.eventId)
              ? ownerSequence.get(right.eventId)
              : Number.MAX_SAFE_INTEGER;
          return leftOwner - rightOwner
            || Number(left.ordinal || 0) - Number(right.ordinal || 0)
            || String(left.createdAt || "").localeCompare(String(right.createdAt || ""));
        });
        const usedOrdinals = new Set();
        const canonicalPhotoIds = [];
        let nextOrdinal = 0;
        const repairTime = new Date().toISOString();
        for (const photo of repairablePhotos) {
          let ordinal = Number(photo.ordinal);
          if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > 999 || usedOrdinals.has(ordinal)) {
            while (usedOrdinals.has(nextOrdinal)) nextOrdinal += 1;
            ordinal = nextOrdinal;
          }
          usedOrdinals.add(ordinal);
          nextOrdinal = Math.max(nextOrdinal, ordinal + 1);
          canonicalPhotoIds.push(photo.photoId);
          await putPhotoRecord(photosStore, {
            ...photo,
            eventId: canonical.eventId,
            draftKey: null,
            ordinal,
            status: photo.status === "durably_received"
              ? photo.status
              : photo.objectReference
                ? "uploaded_unverified"
                : "local",
            updatedAt: repairTime
          });
        }
        const occurrenceTimes = duplicateCompletions
          .map((candidate) => Date.parse(candidate.occurredAt || ""))
          .filter(Number.isFinite);
        const earliestOccurredAt = occurrenceTimes.length
          ? new Date(Math.min(...occurrenceTimes)).toISOString()
          : canonical.occurredAt;
        const canonicalRepair = {
          ...canonical,
          jobFingerprint: canonical.jobFingerprint || expectedFingerprint,
          predecessorFingerprint: canonical.predecessorFingerprint || expectedPredecessor,
          occurredAt: earliestOccurredAt,
          requiredPhotoCount,
          photoIds: canonicalPhotoIds,
          updatedAt: repairTime
        };
        eventsStore.put(canonicalRepair);

        for (const duplicate of duplicateCompletions.slice(1)) {
          eventsStore.put({
            ...duplicate,
            status: "cancelled",
            cancelledAt: repairTime,
            photoIds: [],
            result: {
              ...(duplicate.result || {}),
              duplicateOfEventId: canonical.eventId,
              locallyRepairedDuplicate: true
            },
            updatedAt: repairTime
          });
        }
        repaired = repaired.eventId === canonical.eventId
          ? canonicalRepair
          : {
              ...repaired,
              status: "cancelled",
              cancelledAt: repairTime,
              photoIds: [],
              result: {
                ...(repaired.result || {}),
                duplicateOfEventId: canonical.eventId,
                locallyRepairedDuplicate: true
              },
              updatedAt: repairTime
            };
      }
    }

    const currentRestId = String(repaired.details?.restId || "").trim();
    if (
      repaired.eventType === "rest_ended"
      && repaired.localPayloadRepairSafe === true
      && !repaired.receivedAt
      && !UUID_PATTERN.test(currentRestId)
    ) {
      const manifestEvents = await getAll(
        eventsStore.index("byManifest"),
        repaired.manifestId
      );
      const precedingStarts = manifestEvents
        .filter((candidate) =>
          candidate.partitionKey === expectedPartition
          && String(candidate.manifestId || "") === String(repaired.manifestId || "")
          && candidate.eventType === "rest_started"
          && Number(candidate.clientSequence || 0) < Number(repaired.clientSequence || 0)
        )
        .sort((left, right) =>
          Number(right.clientSequence || 0) - Number(left.clientSequence || 0)
        );
      const expectedStartedAt = Date.parse(repaired.details?.startedAt || "");
      const matchingStarts = Number.isFinite(expectedStartedAt)
        ? precedingStarts.filter((candidate) =>
            Date.parse(candidate.occurredAt || "") === expectedStartedAt
          )
        : [];
      if (
        matchingStarts.length > 1
        && new Set(matchingStarts.map((candidate) =>
          String(candidate.details?.restId || "").trim().toLowerCase()
        )).size > 1
      ) {
        return fail(
          "The saved rest end matches more than one local rest start.",
          "driver_offline_rest_identity_ambiguous"
        );
      }
      const sourceStart = matchingStarts[0] || precedingStarts[0] || null;
      const sourceRestId = String(sourceStart?.details?.restId || "").trim();
      if (!sourceStart || !UUID_PATTERN.test(sourceRestId)) {
        return fail(
          "The saved rest end cannot be matched safely to a preceding local rest start.",
          "driver_offline_rest_identity_unavailable"
        );
      }
      repaired = {
        ...repaired,
        details: {
          ...(repaired.details || {}),
          restId: sourceRestId
        }
      };
    }

    if (repaired !== event) eventsStore.put(repaired);
    await completion;
    return repaired;
  }

  async function sealEventSyncPayload(partitionKey, eventId, payload) {
    const expectedPartition = String(partitionKey || "");
    const expectedEventId = String(eventId || "");
    if (!expectedPartition || !expectedEventId || !payload || typeof payload !== "object") {
      throw offlineRepairError(
        "The offline event cannot be sealed without its partition, event ID, and payload.",
        "driver_offline_event_seal_invalid"
      );
    }
    const db = await open();
    const transaction = db.transaction("events", "readwrite");
    const store = transaction.objectStore("events");
    const event = await requestResult(store.get(expectedEventId));
    if (!event || event.partitionKey !== expectedPartition) {
      await transactionDone(transaction);
      throw offlineRepairError(
        "The offline event disappeared before its synchronization payload was sealed.",
        "driver_offline_event_identity_missing"
      );
    }
    if (event.syncPayload && typeof event.syncPayload === "object") {
      await transactionDone(transaction);
      return event.syncPayload;
    }
    if (
      String(payload.eventId || "") !== expectedEventId
      || Number(payload.clientSequence || 0) !== Number(event.clientSequence || 0)
    ) {
      transaction.abort();
      await transactionDone(transaction).catch(() => {});
      throw offlineRepairError(
        "The synchronization payload does not match its saved event identity.",
        "driver_offline_event_seal_identity_mismatch"
      );
    }
    const sealedAt = new Date().toISOString();
    store.put({
      ...event,
      syncPayload: payload,
      syncPayloadSealedAt: sealedAt,
      updatedAt: sealedAt
    });
    await transactionDone(transaction);
    return payload;
  }

  async function getPartitionEvents(partitionKey) {
    const db = await open();
    const transaction = db.transaction("events", "readonly");
    const events = await getAll(transaction.objectStore("events").index("byPartition"), partitionKey);
    return events.sort((left, right) => Number(left.clientSequence || 0) - Number(right.clientSequence || 0));
  }

  async function getManifestEvents(partitionKey, manifestId) {
    const db = await open();
    const transaction = db.transaction("events", "readonly");
    const events = await getAll(transaction.objectStore("events").index("byManifest"), manifestId);
    return events
      .filter((event) => event.partitionKey === partitionKey)
      .sort((left, right) => Number(left.clientSequence || 0) - Number(right.clientSequence || 0));
  }

  async function getProjectionEvents(partitionKey, activeManifest) {
    if (!activeManifest?.manifestId) return [];
    const db = await open();
    const transaction = db.transaction(["events", "manifests"], "readonly");
    const manifests = await getAll(transaction.objectStore("manifests").index("byPartition"), partitionKey);
    const activePlanId = String(activeManifest.planId ?? "");
    const activePlanDate = String(activeManifest.planDate || "");
    const activeRevision = String(activeManifest.planRevision ?? "");
    const compatibleManifestIds = new Set(manifests
      .filter((manifest) =>
        manifest.manifestId === activeManifest.manifestId
        || (
          String(manifest.planId ?? "") === activePlanId
          && String(manifest.planDate || "") === activePlanDate
          && String(manifest.planRevision ?? "") === activeRevision
        )
      )
      .map((manifest) => manifest.manifestId));
    const activeJobCandidates = new Map();
    for (const job of activeManifest.jobs || []) {
      const identity = `${job.fingerprint || ""}::${job.predecessorFingerprint || ""}`;
      if (!activeJobCandidates.has(identity)) activeJobCandidates.set(identity, []);
      activeJobCandidates.get(identity).push(job);
    }
    const events = await getAll(transaction.objectStore("events").index("byPartition"), partitionKey);
    return events
      .filter((event) => compatibleManifestIds.has(event.manifestId))
      .map((event) => {
        if (event.manifestId === activeManifest.manifestId) return event;
        const isJobEvent = ["job_started", "job_completed", "truck_switched_physical"].includes(event.eventType);
        const carriesJobIdentity = Boolean(event.jobFingerprint || event.predecessorFingerprint);
        if (!isJobEvent && !carriesJobIdentity) return event;
        const matches = activeJobCandidates.get(`${event.jobFingerprint || ""}::${event.predecessorFingerprint || ""}`) || [];
        const matchingJob = matches.length === 1 ? matches[0] : null;
        if (!matchingJob) return null;
        return { ...event, effectiveJobId: matchingJob.jobId };
      })
      .filter(Boolean)
      .sort((left, right) => Number(left.clientSequence || 0) - Number(right.clientSequence || 0));
  }

  async function getPendingEvents(partitionKey) {
    return (await getPartitionEvents(partitionKey)).filter((event) =>
      !TERMINAL_EVENT_STATUSES.has(event.status) && event.status !== "foreground_pending"
    );
  }

  async function getEventPhotos(eventId) {
    const db = await open();
    const transaction = db.transaction("photos", "readonly");
    return (await getAll(transaction.objectStore("photos").index("byEvent"), eventId))
      .map(photoRecordForRuntime);
  }

  async function getPendingPhotos(partitionKey) {
    const db = await open();
    const transaction = db.transaction("photos", "readonly");
    const photos = await getAll(transaction.objectStore("photos").index("byPartition"), partitionKey);
    return photos
      .filter((photo) => photo.eventId && photo.status !== "durably_received")
      .map(photoRecordForRuntime);
  }

  async function updatePhotoRecord(photoId, update) {
    await upgradePhotoRecordsToBinary([photoId]);
    const db = await open();
    const transaction = db.transaction("photos", "readwrite");
    const store = transaction.objectStore("photos");
    const existing = await requestResult(store.get(photoId));
    if (existing) await putPhotoRecord(store, update(existing));
    await transactionDone(transaction);
  }

  async function markPhotoAttempt(photoId, phase = "ticketing") {
    const now = new Date().toISOString();
    await updatePhotoRecord(photoId, (existing) => ({
      ...existing,
      attemptCount: Number(existing.attemptCount || 0) + 1,
      uploadPhase: String(phase || "ticketing"),
      lastAttemptAt: now,
      nextAttemptAt: null,
      lastError: null,
      lastErrorCode: "",
      lastHttpStatus: 0,
      retryable: false,
      updatedAt: now
    }));
  }

  async function markPhotoPhase(photoId, phase) {
    await updatePhotoRecord(photoId, (existing) => ({
      ...existing,
      uploadPhase: String(phase || existing.uploadPhase || "upload"),
      updatedAt: new Date().toISOString()
    }));
  }

  async function markPhotoUploaded(photoId, objectReference) {
    await updatePhotoRecord(photoId, (existing) => ({
      ...existing,
      objectReference,
      status: "uploaded_unverified",
      uploadPhase: "uploaded_unverified",
      nextAttemptAt: null,
      lastError: null,
      lastErrorCode: "",
      lastHttpStatus: 0,
      retryable: false,
      updatedAt: new Date().toISOString()
    }));
  }

  async function markPhotoError(photoId, error) {
    await updatePhotoRecord(photoId, (existing) => ({
      ...existing,
      status: existing.objectReference ? "uploaded_unverified" : "local",
      uploadPhase: String(error?.phase || error?.uploadPhase || "upload"),
      lastError: String(error?.message || error || "Photo upload failed."),
      lastErrorCode: String(error?.code || ""),
      lastHttpStatus: Math.max(0, Number(error?.status || error?.httpStatus || 0)),
      retryable: error?.retryable === true,
      nextAttemptAt: error?.nextAttemptAt || null,
      updatedAt: new Date().toISOString()
    }));
  }

  async function releaseForegroundEvent(eventId) {
    const db = await open();
    const transaction = db.transaction("events", "readwrite");
    const store = transaction.objectStore("events");
    const existing = await requestResult(store.get(eventId));
    if (existing?.status === "foreground_pending") {
      store.put({ ...existing, status: "pending", updatedAt: new Date().toISOString() });
    }
    await transactionDone(transaction);
  }

  async function releaseStaleForegroundEvents(partitionKey, minimumAgeMs = 5 * 60 * 1000, excludedEventIds = []) {
    const db = await open();
    const transaction = db.transaction("events", "readwrite");
    const store = transaction.objectStore("events");
    const events = await getAll(store.index("byPartition"), partitionKey);
    const now = new Date().toISOString();
    const cutoff = Date.now() - Math.max(30000, Number(minimumAgeMs || 0));
    const excluded = new Set(excludedEventIds || []);
    let released = 0;
    events.forEach((event) => {
      if (event.status !== "foreground_pending") return;
      if (excluded.has(event.eventId)) return;
      const timestamp = new Date(event.updatedAt || event.createdAt || 0).getTime();
      if (!Number.isFinite(timestamp) || timestamp > cutoff) return;
      store.put({ ...event, status: "pending", updatedAt: now });
      released += 1;
    });
    await transactionDone(transaction);
    return released;
  }

  async function markForegroundApplied(eventId, result = {}) {
    const db = await open();
    const transaction = db.transaction("events", "readwrite");
    const eventsStore = transaction.objectStore("events");
    const existing = await requestResult(eventsStore.get(eventId));
    const now = new Date().toISOString();
    if (existing) {
      eventsStore.put({
        ...existing,
        status: "receipt_pending",
        foregroundAppliedAt: now,
        foregroundResponse: result,
        result,
        updatedAt: now
      });
    }
    await transactionDone(transaction);
  }

  async function cancelForegroundEvent(eventId, draftKey = "") {
    await upgradeEventPhotosToBinary(eventId);
    const db = await open();
    const transaction = db.transaction(["events", "photos"], "readwrite");
    const eventsStore = transaction.objectStore("events");
    const photosStore = transaction.objectStore("photos");
    const existing = await requestResult(eventsStore.get(eventId));
    const now = new Date().toISOString();
    if (existing) {
      eventsStore.put({
        ...existing,
        status: "cancelled",
        cancelledAt: now,
        updatedAt: now
      });
      const photos = await getAll(photosStore.index("byEvent"), eventId);
      for (const photo of photos) {
        await putPhotoRecord(photosStore, {
          ...photo,
          eventId: null,
          draftKey: draftKey || photo.draftKey,
          status: "draft",
          updatedAt: now
        });
      }
    }
    await transactionDone(transaction);
  }

  async function mergeEventResult(eventId, resultPatch = {}) {
    const db = await open();
    const transaction = db.transaction("events", "readwrite");
    const store = transaction.objectStore("events");
    const existing = await requestResult(store.get(eventId));
    if (existing) {
      store.put({
        ...existing,
        result: { ...(existing.result || {}), ...(resultPatch || {}) },
        updatedAt: new Date().toISOString()
      });
    }
    await transactionDone(transaction);
  }

  async function markEventReviewRequired(eventId, reason, resultPatch = {}) {
    const db = await open();
    const transaction = db.transaction("events", "readwrite");
    const store = transaction.objectStore("events");
    const existing = await requestResult(store.get(eventId));
    if (existing) {
      store.put({
        ...existing,
        status: "review_required",
        reviewRequired: true,
        reviewReason: String(reason || "Dispatch review is required."),
        result: { ...(existing.result || {}), ...(resultPatch || {}) },
        updatedAt: new Date().toISOString()
      });
    }
    await transactionDone(transaction);
  }

  function responseEvents(payload) {
    if (Array.isArray(payload?.events)) return payload.events;
    if (Array.isArray(payload?.results)) return payload.results;
    if (Array.isArray(payload?.acknowledgements)) return payload.acknowledgements;
    return [];
  }

  async function applySyncResponse(partitionKey, payload) {
    await upgradePhotoRecordsToBinary((payload?.photos || payload?.photoReceipts || [])
      .map((result) => result?.photoId || result?.id));
    const db = await open();
    const transaction = db.transaction(["events", "photos", "meta"], "readwrite");
    const eventsStore = transaction.objectStore("events");
    const photosStore = transaction.objectStore("photos");
    const now = new Date().toISOString();
    for (const result of responseEvents(payload)) {
      const eventId = result.eventId || result.id;
      const existing = eventId ? await requestResult(eventsStore.get(eventId)) : null;
      if (!existing || existing.partitionKey !== partitionKey) continue;
      const rawStatus = String(result.status || (result.reviewRequired ? "review_required" : result.blocked ? "blocked" : "received")).toLowerCase();
      const status = rawStatus === "success" || rawStatus === "completed" ? "applied" : rawStatus;
      const reviewReason = String(result.reviewReason || result.reason || result.error || "");
      eventsStore.put({
        ...existing,
        status,
        reviewRequired: Boolean(result.reviewRequired || status === "review_required"),
        blocked: Boolean(result.blocked || status === "blocked"),
        reviewReason: reviewReason || existing.reviewReason || "",
        effectiveJobId: result.effectiveJobId || existing.effectiveJobId || null,
        missingPhotoIds: result.missingPhotoIds || [],
        result: {
          ...(existing.result || {}),
          ...(result.result || {})
        },
        receivedAt: result.receivedAt || payload.receivedAt || existing.receivedAt || now,
        appliedAt: result.appliedAt || (status === "applied" ? now : existing.appliedAt),
        syncAttempts: Number(existing.syncAttempts || 0) + 1,
        lastError: reviewReason || null,
        updatedAt: now
      });
    }
    for (const result of payload?.photos || payload?.photoReceipts || []) {
      const photoId = result.photoId || result.id;
      const existing = photoId ? await requestResult(photosStore.get(photoId)) : null;
      if (!existing || existing.partitionKey !== partitionKey) continue;
      const durable = Boolean(result.durableReceipt || result.status === "durably_received");
      const verificationFailed = !durable && Boolean(result.error) && photoHasLocalBytes(existing);
      await putPhotoRecord(photosStore, {
        ...existing,
        objectReference: verificationFailed
          ? null
          : result.objectReference || result.photoRef || existing.objectReference || null,
        durableReceipt: durable,
        uploadPhase: durable
          ? "durable"
          : verificationFailed
            ? "local"
            : result.status || existing.uploadPhase || existing.status,
        status: durable
          ? "durably_received"
          : verificationFailed
            ? "local"
            : result.status || existing.status,
        blobBytes: durable ? null : existing.blobBytes,
        nextAttemptAt: durable ? null : existing.nextAttemptAt || null,
        retryable: durable ? false : existing.retryable === true,
        lastError: result.error || null,
        lastErrorCode: durable ? "" : String(result.errorCode || existing.lastErrorCode || ""),
        lastHttpStatus: durable ? 0 : Math.max(0, Number(result.httpStatus || existing.lastHttpStatus || 0)),
        updatedAt: now
      });
    }
    transaction.objectStore("meta").put({
      key: `syncState::${partitionKey}`,
      value: {
        lastSuccessAt: now,
        lastError: null,
        lastErrorName: null,
        lastErrorCode: null,
        pendingCount: payload?.pendingCount,
        reviewRequired: Boolean(payload?.reviewRequired)
      },
      updatedAt: now
    });
    await transactionDone(transaction);
  }

  async function recordSyncError(partitionKey, error) {
    const current = (await getMeta(`syncState::${partitionKey}`)) || {};
    return setMeta(`syncState::${partitionKey}`, {
      ...current,
      lastAttemptAt: new Date().toISOString(),
      lastError: String(error?.message || error || "Synchronization failed."),
      lastErrorName: String(error?.name || "Error"),
      lastErrorCode: String(error?.code || "")
    });
  }

  async function getSyncState(partitionKey) {
    return (await getMeta(`syncState::${partitionKey}`)) || {};
  }

  async function getStorageHealth(partitionKey) {
    const db = await open();
    const transaction = db.transaction(["photos", "events"], "readonly");
    // Evidence limits are browser-wide. Locked partitions still occupy quota and
    // must remain protected, so another driver cannot silently exceed the guard.
    const photos = await getAll(transaction.objectStore("photos"));
    const events = await getAll(transaction.objectStore("events").index("byPartition"), partitionKey);
    const unsyncedPhotos = photos.filter((photo) =>
      photoHasLocalBytes(photo) && photo.status !== "durably_received"
    );
    const partitionUnsyncedPhotos = unsyncedPhotos.filter((photo) => photo.partitionKey === partitionKey);
    const evidenceBytes = unsyncedPhotos.reduce((sum, photo) => sum + photoByteSize(photo), 0);
    const partitionEvidenceBytes = partitionUnsyncedPhotos.reduce(
      (sum, photo) => sum + photoByteSize(photo),
      0
    );
    const pendingEvents = events.filter((event) => !eventIsRetainedTerminal(event));
    const reviewEvents = events.filter((event) => event.reviewRequired || event.status === "review_required");
    return {
      evidenceBytes,
      unsyncedPhotoCount: unsyncedPhotos.length,
      partitionEvidenceBytes,
      partitionUnsyncedPhotoCount: partitionUnsyncedPhotos.length,
      pendingEventCount: pendingEvents.length,
      reviewRequiredCount: reviewEvents.length,
      maxEvidenceBytes: MAX_EVIDENCE_BYTES,
      maxUnsyncedPhotos: MAX_UNSYNCED_PHOTOS
    };
  }

  async function canStorePhoto(partitionKey, byteSize, options = {}) {
    const health = await getStorageHealth(partitionKey);
    return photoAdmissionForHealth(health, byteSize, options);
  }

  function makeInstructionMediaKey(partitionKey, mediaId) {
    return `${String(partitionKey || "")}::${String(mediaId || "").trim().toLowerCase()}`;
  }

  async function cacheInstructionMedia(partitionKey, media = {}) {
    const normalizedPartition = String(partitionKey || "");
    const mediaId = String(media.mediaId || media.id || "").trim().toLowerCase();
    if (!normalizedPartition || !mediaId) {
      throw new Error("A Driver partition and delivery-instruction media ID are required.");
    }
    if (String(media.mediaKind || "image").toLowerCase() !== "image") {
      throw new Error("Only delivery-instruction images can be saved for offline viewing.");
    }
    const persisted = await instructionMediaRecordForStorage(media);
    const blobBytes = instructionMediaBinaryBuffer(persisted?.blobBytes);
    const actualByteSize = blobBytes?.byteLength || 0;
    const declaredByteSize = Number(media.byteSize || actualByteSize);
    if (
      actualByteSize < 1
      || actualByteSize > MAX_INSTRUCTION_MEDIA_FILE_BYTES
      || !Number.isSafeInteger(declaredByteSize)
      || declaredByteSize !== actualByteSize
    ) {
      throw new Error("The delivery-instruction image bytes do not match the approved file size.");
    }
    const now = new Date().toISOString();
    const priority = Math.min(2, Math.max(0, Number(media.priority || 0)));
    const record = {
      ...persisted,
      key: makeInstructionMediaKey(normalizedPartition, mediaId),
      partitionKey: normalizedPartition,
      mediaId,
      jobId: String(media.jobId || ""),
      mediaKind: "image",
      mimeType: String(media.mimeType || "application/octet-stream").toLowerCase(),
      fileName: String(media.fileName || "Delivery instruction image").slice(0, 255),
      byteSize: actualByteSize,
      priority,
      createdAt: persisted.createdAt || now,
      updatedAt: now,
      lastAccessedAt: now
    };

    const db = await open();
    const transaction = db.transaction(["profiles", "instructionMedia"], "readwrite");
    const completion = transactionDone(transaction);
    const profile = await requestResult(transaction.objectStore("profiles").get(normalizedPartition));
    if (!profile || profile.locked) {
      transaction.abort();
      await completion.catch(() => {});
      throw new Error("The Driver offline cache is locked for this session.");
    }
    const store = transaction.objectStore("instructionMedia");
    const existing = await getAll(store.index("byPartition"), normalizedPartition);
    const candidates = existing.filter((entry) => entry.key !== record.key).concat(record);
    const eviction = selectInstructionMediaEvictions(
      candidates,
      MAX_INSTRUCTION_MEDIA_BYTES,
      [mediaId]
    );
    const evicted = new Set(eviction.evictedMediaIds);
    store.put(record);
    for (const entry of candidates) {
      if (evicted.has(String(entry.mediaId))) store.delete(entry.key);
    }
    await completion;
    return {
      ...instructionMediaRecordForRuntime(record),
      evictedMediaIds: eviction.evictedMediaIds,
      retainedBytes: eviction.retainedBytes
    };
  }

  async function getCachedInstructionMedia(partitionKey, mediaId) {
    const key = makeInstructionMediaKey(partitionKey, mediaId);
    if (!String(partitionKey || "") || !String(mediaId || "")) return null;
    const db = await open();
    const transaction = db.transaction("instructionMedia", "readwrite");
    const completion = transactionDone(transaction);
    const store = transaction.objectStore("instructionMedia");
    const record = await requestResult(store.get(key));
    if (record) {
      store.put({ ...record, lastAccessedAt: new Date().toISOString() });
    }
    await completion;
    return record ? instructionMediaRecordForRuntime(record) : null;
  }

  async function setInstructionMediaPriorities(
    partitionKey,
    { currentMediaIds = [], nextMediaIds = [] } = {}
  ) {
    const normalizedPartition = String(partitionKey || "");
    if (!normalizedPartition) return 0;
    const current = new Set(currentMediaIds.map((value) => String(value || "").toLowerCase()));
    const next = new Set(nextMediaIds.map((value) => String(value || "").toLowerCase()));
    const db = await open();
    const transaction = db.transaction("instructionMedia", "readwrite");
    const completion = transactionDone(transaction);
    const store = transaction.objectStore("instructionMedia");
    const records = await getAll(store.index("byPartition"), normalizedPartition);
    const now = new Date().toISOString();
    for (const record of records) {
      const priority = current.has(String(record.mediaId))
        ? 2
        : next.has(String(record.mediaId))
          ? 1
          : 0;
      if (Number(record.priority || 0) !== priority) {
        store.put({ ...record, priority, updatedAt: now });
      }
    }
    await completion;
    return records.length;
  }

  async function getInstructionMediaCacheStats(partitionKey) {
    const normalizedPartition = String(partitionKey || "");
    if (!normalizedPartition) {
      return { count: 0, bytes: 0, maxBytes: MAX_INSTRUCTION_MEDIA_BYTES };
    }
    const db = await open();
    const transaction = db.transaction("instructionMedia", "readonly");
    const completion = transactionDone(transaction);
    const records = await getAll(
      transaction.objectStore("instructionMedia").index("byPartition"),
      normalizedPartition
    );
    await completion;
    return {
      count: records.length,
      bytes: records.reduce((total, record) => total + instructionMediaByteSize(record), 0),
      maxBytes: MAX_INSTRUCTION_MEDIA_BYTES
    };
  }

  async function evictInstructionMediaForEvidence(
    partitionKey,
    { bytesToFree = Number.MAX_SAFE_INTEGER } = {}
  ) {
    const normalizedPartition = String(partitionKey || "");
    if (!normalizedPartition) {
      throw new Error("A Driver partition is required before freeing optional offline media.");
    }
    const targetBytes = Math.max(0, nonNegativeInteger(bytesToFree));
    const db = await open();
    const transaction = db.transaction(["profiles", "instructionMedia"], "readwrite");
    const completion = transactionDone(transaction);
    const profile = await requestResult(
      transaction.objectStore("profiles").get(normalizedPartition)
    );
    if (!profile || profile.locked) {
      transaction.abort();
      await completion.catch(() => {});
      throw new Error("The Driver offline cache is locked for this session.");
    }
    const store = transaction.objectStore("instructionMedia");
    const records = await getAll(store.index("byPartition"), normalizedPartition);
    const ordered = [...records].sort((left, right) => (
      instructionMediaEvictionOrder(left, right)
    ));
    const evictedMediaIds = [];
    let evictedBytes = 0;
    for (const record of ordered) {
      if (evictedBytes >= targetBytes) break;
      store.delete(record.key);
      evictedMediaIds.push(String(record.mediaId));
      evictedBytes += instructionMediaByteSize(record);
    }
    await completion;
    const totalBytes = records.reduce(
      (sum, record) => sum + instructionMediaByteSize(record),
      0
    );
    return {
      evictedMediaIds,
      evictedBytes,
      remainingBytes: Math.max(0, totalBytes - evictedBytes)
    };
  }

  async function acquireLease(partitionKey, owner, ttlMs = 30000) {
    const db = await open();
    const transaction = db.transaction("leases", "readwrite");
    const store = transaction.objectStore("leases");
    const existing = await requestResult(store.get(partitionKey));
    const now = Date.now();
    if (existing && existing.owner !== owner && Number(existing.expiresAt || 0) > now) {
      await transactionDone(transaction);
      return false;
    }
    store.put({ partitionKey, owner, expiresAt: now + ttlMs, updatedAt: new Date(now).toISOString() });
    await transactionDone(transaction);
    return true;
  }

  async function getLease(partitionKey) {
    if (!partitionKey) return null;
    const db = await open();
    const transaction = db.transaction("leases", "readonly");
    return (await requestResult(transaction.objectStore("leases").get(partitionKey))) || null;
  }

  async function releaseLease(partitionKey, owner) {
    const db = await open();
    const transaction = db.transaction("leases", "readwrite");
    const store = transaction.objectStore("leases");
    const existing = await requestResult(store.get(partitionKey));
    if (existing?.owner === owner) store.delete(partitionKey);
    await transactionDone(transaction);
  }

  async function listSyncPartitions() {
    const db = await open();
    const transaction = db.transaction("profiles", "readonly");
    const profiles = await getAll(transaction.objectStore("profiles"));
    const results = [];
    for (const profile of profiles.filter((item) => !item.locked)) {
      const health = await getStorageHealth(profile.partitionKey);
      if (health.pendingEventCount || health.partitionUnsyncedPhotoCount) results.push(profile);
    }
    return results;
  }

  async function cleanupSynced(partitionKey, now = Date.now()) {
    const cutoff = now - SYNCED_RETENTION_MS;
    const db = await open();
    const transaction = db.transaction(["events", "photos", "manifests", "jobs", "meta"], "readwrite");
    const eventsStore = transaction.objectStore("events");
    const photosStore = transaction.objectStore("photos");
    const manifestsStore = transaction.objectStore("manifests");
    const jobsStore = transaction.objectStore("jobs");
    const events = await getAll(eventsStore.index("byPartition"), partitionKey);
    const removedEventIds = new Set();
    for (const event of events) {
      const timestamp = new Date(event.appliedAt || event.updatedAt || event.createdAt || 0).getTime();
      if (eventIsRetainedTerminal(event) && Number.isFinite(timestamp) && timestamp < cutoff) {
        eventsStore.delete(event.eventId);
        removedEventIds.add(event.eventId);
      }
    }
    const photos = await getAll(photosStore.index("byPartition"), partitionKey);
    for (const photo of photos) {
      const timestamp = new Date(photo.updatedAt || photo.createdAt || 0).getTime();
      if (!photoHasLocalBytes(photo) && photo.status === "durably_received" && Number.isFinite(timestamp) && timestamp < cutoff) {
        if (!photo.eventId || removedEventIds.has(photo.eventId)) photosStore.delete(photo.photoId);
      }
    }
    const protectedManifestIds = new Set(events
      .filter((event) => !eventIsRetainedTerminal(event))
      .map((event) => String(event.manifestId || "")));
    for (const photo of photos.filter(photoHasLocalBytes)) {
      const match = String(photo.draftKey || "").match(/^(?:job|dvir):([^:]+)/);
      if (match?.[1]) protectedManifestIds.add(match[1]);
    }
    const activeMetaKey = `activeManifest::${partitionKey}`;
    const activeManifestKey = (await requestResult(transaction.objectStore("meta").get(activeMetaKey)))?.value;
    const deferredManifestKey = (await requestResult(
      transaction.objectStore("meta").get(`deferredManifest::${partitionKey}`)
    ))?.value;
    const manifests = await getAll(manifestsStore.index("byPartition"), partitionKey);
    for (const manifest of manifests) {
      const timestamp = new Date(manifest.updatedAt || manifest.generatedAt || 0).getTime();
      if (
        !Number.isFinite(timestamp)
        || timestamp >= cutoff
        || manifest.key === deferredManifestKey
        || protectedManifestIds.has(String(manifest.manifestId))
      ) continue;
      const jobs = await getAll(jobsStore.index("byManifest"), manifest.key);
      jobs.forEach((job) => jobsStore.delete(job.key));
      manifestsStore.delete(manifest.key);
      if (activeManifestKey === manifest.key) transaction.objectStore("meta").delete(activeMetaKey);
    }
    await transactionDone(transaction);
  }

  global.DriverOfflineDB = {
    DB_NAME,
    DB_VERSION,
    MAX_EVIDENCE_BYTES,
    MAX_INSTRUCTION_MEDIA_BYTES,
    MAX_UNSYNCED_PHOTOS,
    normalizeDriverLogin,
    makePartitionKey,
    createUuid,
    open,
    getMeta,
    setMeta,
    getDeviceId,
    recoverDriverDeviceIdentity,
    unlockPartition,
    getProfile,
    getActiveProfile,
    lockPartition,
    lockActivePartition,
    saveManifestAtomic,
    replaceTerminalRouteCache,
    saveBootstrap,
    getManifest,
    getActiveManifest,
    getDeferredManifest,
    activateManifest,
    getManifestBlockingState,
    saveDraftPhoto,
    getDraftPhotos,
    getCompatibleDraftPhotos,
    deleteDraftPhoto,
    queueEvent,
    repairEventForSync,
    sealEventSyncPayload,
    getPartitionEvents,
    getManifestEvents,
    getProjectionEvents,
    getPendingEvents,
    getEventPhotos,
    getPendingPhotos,
    markPhotoAttempt,
    markPhotoPhase,
    markPhotoUploaded,
    markPhotoError,
    releaseForegroundEvent,
    releaseStaleForegroundEvents,
    markForegroundApplied,
    cancelForegroundEvent,
    mergeEventResult,
    markEventReviewRequired,
    applySyncResponse,
    recordSyncError,
    getSyncState,
    getStorageHealth,
    canStorePhoto,
    cacheInstructionMedia,
    getCachedInstructionMedia,
    setInstructionMediaPriorities,
    getInstructionMediaCacheStats,
    evictInstructionMediaForEvidence,
    acquireLease,
    getLease,
    releaseLease,
    listSyncPartitions,
    cleanupSynced
  };
})(typeof self !== "undefined" ? self : window);

(function driverOfflineSync(global) {
  "use strict";

  const DRIVER_PWA_CLIENT_VERSION = "2026.08.01.2";
  const DRIVER_PWA_VERSION_HEADER = "X-MBBS-Driver-Version";
  const LEASE_TTL_MS = 120000;
  const JOB_BOUND_EVENT_TYPES = new Set(["job_started", "job_completed", "truck_switched_physical"]);
  const ownerId = `sync-${global.DriverOfflineDB.createUuid()}`;
  let configuration = {
    getAuthToken: () => "",
    onStatus: () => {},
    onUpdated: () => {}
  };
  const activeRuns = new Map();

  function configure(options = {}) {
    configuration = { ...configuration, ...options };
  }

  async function assertPartitionSession(profile) {
    const current = await global.DriverOfflineDB.getProfile(profile?.partitionKey);
    if (
      !current
      || current.locked
      || (
        profile?.sessionGeneration
        && current.sessionGeneration !== profile.sessionGeneration
      )
    ) {
      const error = new Error("This Driver data is locked until the same driver signs in again.");
      error.code = "driver_partition_locked";
      throw error;
    }
    return current;
  }

  function authHeaders(manifest, profile, { json = true, forceGrant = false } = {}) {
    const token = forceGrant ? "" : String(configuration.getAuthToken?.() || "");
    return {
      ...(json ? { "Content-Type": "application/json" } : {}),
      "X-MBBS-Driver-Device": profile.deviceId,
      [DRIVER_PWA_VERSION_HEADER]: DRIVER_PWA_CLIENT_VERSION,
      ...(token
        ? { Authorization: `Bearer ${token}` }
        : manifest.offlineSyncGrant
          ? { "X-MBBS-Offline-Grant": manifest.offlineSyncGrant }
          : {})
    };
  }

  async function fetchJson(path, options, context) {
    let response;
    try {
      response = await fetch(path, { cache: "no-store", ...options });
    } catch (error) {
      error.isNetworkError = true;
      throw error;
    }
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }
    if (response.status === 401 && context.allowGrantRetry && context.manifest.offlineSyncGrant) {
      const retryHeaders = { ...(options.headers || {}) };
      delete retryHeaders.Authorization;
      retryHeaders["X-MBBS-Offline-Grant"] = context.manifest.offlineSyncGrant;
      return fetchJson(path, {
        ...options,
        headers: retryHeaders
      }, { ...context, allowGrantRetry: false });
    }
    if (!response.ok) {
      const error = new Error(payload.error || text || `Request failed (${response.status}).`);
      error.status = response.status;
      error.code = String(payload.code || "");
      error.data = payload;
      throw error;
    }
    return payload;
  }

  async function buildEventPayload(event, { repair = true } = {}) {
    const repaired = repair
      ? await global.DriverOfflineDB.repairEventForSync(event.partitionKey, event.eventId)
      : event;
    if (
      JOB_BOUND_EVENT_TYPES.has(repaired.eventType)
      && (
        !String(repaired.jobId || "").trim()
        || !String(repaired.jobFingerprint || "").trim()
        || !String(repaired.predecessorFingerprint || "").trim()
      )
    ) {
      const error = new Error("A saved job event is still missing its immutable route identity.");
      error.code = "driver_offline_event_job_identity_unavailable";
      throw error;
    }
    if (repaired.syncPayload && typeof repaired.syncPayload === "object") {
      return repaired.syncPayload;
    }
    const photos = await global.DriverOfflineDB.getEventPhotos(repaired.eventId);
    const payload = {
      eventId: repaired.eventId,
      clientSequence: repaired.clientSequence,
      eventType: repaired.eventType,
      jobId: repaired.jobId || null,
      jobFingerprint: repaired.jobFingerprint || null,
      predecessorFingerprint: repaired.predecessorFingerprint || null,
      occurredAt: repaired.occurredAt,
      locationStatus: repaired.locationStatus || "not_checked_offline",
      locationVerificationId: repaired.locationVerificationId || null,
      locationOverride: Boolean(repaired.locationOverride),
      details: repaired.details || {},
      photos: photos.map((photo) => ({
        photoId: photo.photoId,
        ordinal: Number(photo.ordinal || 0),
        mimeType: photo.mimeType || "image/jpeg",
        byteSize: Number(photo.byteSize || photo.blob?.size || 0),
        sha256: photo.sha256,
        recordType: photo.recordType || "driver-stop-photo"
      }))
    };
    return global.DriverOfflineDB.sealEventSyncPayload(
      repaired.partitionKey,
      repaired.eventId,
      payload
    );
  }

  async function postSync(manifest, profile, events, photoReceipts = [], signal) {
    const currentProfile = await assertPartitionSession(profile);
    const body = {
      manifestId: manifest.manifestId,
      deviceId: currentProfile.deviceId,
      events,
      ...(photoReceipts.length ? { photoReceipts } : {})
    };
    return fetchJson("/api/driver/offline-sync", {
      method: "POST",
      headers: authHeaders(manifest, currentProfile),
      body: JSON.stringify(body),
      signal
    }, {
      manifest,
      allowGrantRetry: Boolean(configuration.getAuthToken?.())
    });
  }

  async function verifyLocalPhotoBlob(photo) {
    if (!(photo?.blob instanceof Blob)) {
      const error = new Error("The local photo Blob is missing.");
      error.code = "driver_offline_photo_blob_missing";
      throw error;
    }
    const expectedBytes = Number(photo.byteSize || 0);
    if (!expectedBytes || photo.blob.size !== expectedBytes) {
      const error = new Error(
        `The saved photo contains ${photo.blob.size} of ${expectedBytes || "the expected"} bytes. Retake the photo or ask Dispatch to close the incomplete event as evidence only.`
      );
      error.code = "driver_offline_photo_blob_size_mismatch";
      throw error;
    }
    const bytes = await photo.blob.arrayBuffer();
    const digest = await global.crypto.subtle.digest("SHA-256", bytes);
    const actualSha256 = Array.from(new Uint8Array(digest))
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    if (!photo.sha256 || actualSha256 !== String(photo.sha256).toLowerCase()) {
      const error = new Error("The saved photo no longer matches its registered SHA-256 evidence descriptor.");
      error.code = "driver_offline_photo_blob_hash_mismatch";
      throw error;
    }
    return { expectedBytes, actualSha256 };
  }

  async function uploadPhoto(manifest, profile, photo, event, signal) {
    const currentProfile = await assertPartitionSession(profile);
    const { expectedBytes } = await verifyLocalPhotoBlob(photo);
    const ticketPayload = {
      offlineEventUpload: true,
      manifestId: manifest.manifestId,
      eventId: photo.eventId,
      photoId: photo.photoId,
      recordType: photo.recordType || "driver-stop-photo",
      mimeType: photo.mimeType || "image/jpeg",
      byteSize: expectedBytes,
      sha256: photo.sha256,
      jobId: event?.jobId || undefined,
      dvirType: event?.eventType === "dvir_captured" ? event?.details?.dvirType : undefined
    };
    const ticket = await fetchJson("/api/driver/photo-upload-token", {
      method: "POST",
      headers: authHeaders(manifest, currentProfile),
      body: JSON.stringify(ticketPayload),
      signal
    }, {
      manifest,
      allowGrantRetry: Boolean(configuration.getAuthToken?.())
    });
    if (!ticket.uploadUrl || !ticket.token) throw new Error("Photo upload authorization is incomplete.");
    const uploadName = `${photo.recordType || "driver-photo"}-${Number(photo.ordinal || 0) + 1}.jpg`;
    await assertPartitionSession(profile);
    let response;
    try {
      response = await fetch(ticket.uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ticket.token}`,
          "Content-Type": photo.mimeType || photo.blob.type || "image/jpeg",
          "X-File-Name": uploadName
        },
        // Send the registered JPEG bytes directly. The upload worker accepts a
        // raw request body, which avoids a multipart parser ever acknowledging
        // an object whose stored payload is empty.
        body: photo.blob,
        signal
      });
    } catch (error) {
      error.isNetworkError = true;
      throw error;
    }
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }
    if (!response.ok) throw new Error(payload.error || text || "Photo upload failed.");
    const reportedBytes = Number(payload.byteSize ?? payload.bytes ?? payload.size);
    if (Number.isFinite(reportedBytes) && reportedBytes !== expectedBytes) {
      throw new Error(`Photo upload stored ${reportedBytes} of ${expectedBytes} registered bytes.`);
    }
    const objectReference = payload.objectReference || payload.photoRef || payload.reference || (payload.key ? `r2://${payload.key}` : "");
    if (!objectReference) throw new Error("Photo upload did not return an object reference.");
    await global.DriverOfflineDB.markPhotoUploaded(photo.photoId, objectReference);
    return {
      photoId: photo.photoId,
      objectReference,
      byteSize: expectedBytes,
      sha256: photo.sha256
    };
  }

  async function registerForegroundEvent(partitionKey, eventId) {
    const profile = await global.DriverOfflineDB.getProfile(partitionKey);
    const currentProfile = await assertPartitionSession(profile);
    const events = await global.DriverOfflineDB.getPartitionEvents(partitionKey);
    const event = events.find((item) => item.eventId === eventId);
    if (!event || event.partitionKey !== partitionKey) {
      throw new Error("The foreground event is missing from offline storage.");
    }
    const manifest = await global.DriverOfflineDB.getManifest(partitionKey, event.manifestId);
    if (!manifest?.manifestId) {
      throw new Error("The foreground event route manifest is no longer available.");
    }
    const payload = await buildEventPayload(event);
    const registration = await postSync(manifest, currentProfile, [payload], []);
    const stored = responseEvents(registration).find((item) => item.eventId === eventId);
    if (!stored) throw new Error("The server did not acknowledge the foreground event.");
    if (stored.reviewRequired || ["review_required", "blocked"].includes(String(stored.status || "").toLowerCase())) {
      const error = new Error(stored.reviewReason || "The foreground event requires Dispatch review.");
      error.code = "driver_foreground_review_required";
      error.data = { ...stored, reviewRequired: true, serverRegistered: true };
      throw error;
    }
    return registration;
  }

  async function confirmForegroundEvidence(partitionKey, eventId) {
    const profile = await global.DriverOfflineDB.getProfile(partitionKey);
    const currentProfile = await assertPartitionSession(profile);
    const events = await global.DriverOfflineDB.getPartitionEvents(partitionKey);
    const event = events.find((item) => item.eventId === eventId);
    if (!event || event.partitionKey !== partitionKey) {
      throw new Error("The foreground event is missing from offline storage.");
    }
    const manifest = await global.DriverOfflineDB.getManifest(partitionKey, event.manifestId);
    if (!manifest?.manifestId) {
      throw new Error("The foreground event route manifest is no longer available.");
    }
    const photos = await global.DriverOfflineDB.getEventPhotos(eventId);
    if (event.eventType === "dvir_captured" && photos.length < 4) {
      throw new Error("Four registered inspection photos are required.");
    }
    const receipts = photos.map((photo) => {
      if (!photo.objectReference) throw new Error("A registered photo has not finished uploading.");
      return {
        photoId: photo.photoId,
        objectReference: photo.objectReference,
        byteSize: Number(photo.byteSize || photo.blob?.size || 0),
        sha256: photo.sha256
      };
    });
    const receiptResult = await postSync(manifest, currentProfile, [], receipts);
    await global.DriverOfflineDB.applySyncResponse(partitionKey, receiptResult);
    const failed = (receiptResult.photos || []).find((photo) =>
      !photo.durableReceipt && photo.status !== "durably_received"
    );
    if (failed) {
      const error = new Error(failed.error || "Inspection photo durability verification failed.");
      error.code = "driver_foreground_photo_not_durable";
      throw error;
    }
    const exactPayload = await buildEventPayload(event);
    const drained = await postSync(manifest, currentProfile, [exactPayload], []);
    await global.DriverOfflineDB.applySyncResponse(partitionKey, drained);
    const stored = responseEvents(drained).find((item) => item.eventId === eventId);
    if (!stored || stored.status !== "applied") {
      const error = new Error(stored?.reviewReason || "The inspection event is not safe for its online Samsara action.");
      error.code = "driver_foreground_event_not_applied";
      error.data = stored
        ? { ...stored, reviewRequired: stored.reviewRequired === true, serverRegistered: true }
        : {};
      throw error;
    }
    return stored;
  }

  async function syncPartitionInternal(partitionKey, signal) {
    const profile = await global.DriverOfflineDB.getProfile(partitionKey);
    if (!profile || profile.locked) return { skipped: "locked" };
    const acquired = await global.DriverOfflineDB.acquireLease(partitionKey, ownerId, LEASE_TTL_MS);
    if (!acquired) {
      const error = new Error("Driver synchronization is already running in another tab.");
      error.code = "sync_leased";
      throw error;
    }
    configuration.onStatus?.({ state: "syncing", partitionKey });
    try {
      const storedEvents = await global.DriverOfflineDB.getPartitionEvents(partitionKey);
      const allEvents = [];
      for (const event of storedEvents) {
        allEvents.push(await global.DriverOfflineDB.repairEventForSync(
          partitionKey,
          event.eventId
        ));
      }
      const allPendingEvents = allEvents.filter((event) =>
        !["applied", "evidence_only", "resolved", "cancelled", "rejected", "foreground_pending"].includes(event.status)
      );
      const allPendingPhotos = await global.DriverOfflineDB.getPendingPhotos(partitionKey);
      const eventsById = new Map(allEvents.map((event) => [event.eventId, event]));
      const groups = new Map();
      for (const event of allPendingEvents) {
        if (!groups.has(event.manifestId)) groups.set(event.manifestId, { events: [], eventIds: new Set() });
        groups.get(event.manifestId).events.push(event);
        groups.get(event.manifestId).eventIds.add(event.eventId);
      }
      // A server-applied/reviewed event can still own a photo whose durable
      // receipt failed. Keep that manifest in the drain so the photo can upload
      // and send a receipt-only POST without replaying the terminal event.
      for (const photo of allPendingPhotos) {
        const owner = eventsById.get(photo.eventId);
        if (!owner) continue;
        if (!groups.has(owner.manifestId)) groups.set(owner.manifestId, { events: [], eventIds: new Set() });
        const group = groups.get(owner.manifestId);
        group.eventIds.add(owner.eventId);
      }
      const photoFailures = [];
      for (const [manifestId, group] of groups) {
        const groupedEvents = group.events;
        const manifest = await global.DriverOfflineDB.getManifest(partitionKey, manifestId);
        if (!manifest?.manifestId) throw new Error("An offline event references a route manifest that is no longer available.");
        if (manifest.expiresAt && Date.parse(manifest.expiresAt) <= Date.now() && !configuration.getAuthToken?.()) {
          throw new Error("This offline route has expired. Reconnect and sign in to synchronize retained evidence.");
        }
        const eventPayloads = [];
        for (const event of groupedEvents) {
          eventPayloads.push(await buildEventPayload(event, { repair: false }));
        }
        if (eventPayloads.length) {
          const registration = await postSync(manifest, profile, eventPayloads, [], signal);
          await global.DriverOfflineDB.applySyncResponse(partitionKey, registration);
        }

        const receipts = [];
        for (const photo of allPendingPhotos.filter((item) => group.eventIds.has(item.eventId))) {
          await assertPartitionSession(profile);
          const renewed = await global.DriverOfflineDB.acquireLease(partitionKey, ownerId, LEASE_TTL_MS);
          if (!renewed) {
            const error = new Error("Driver synchronization lease was lost.");
            error.code = "sync_lease_lost";
            throw error;
          }
          if (photo.objectReference) {
            receipts.push({
              photoId: photo.photoId,
              objectReference: photo.objectReference,
              byteSize: Number(photo.byteSize || photo.blob?.size || 0),
              sha256: photo.sha256
            });
            continue;
          }
          try {
            receipts.push(await uploadPhoto(manifest, profile, photo, eventsById.get(photo.eventId), signal));
          } catch (error) {
            await global.DriverOfflineDB.markPhotoError(photo.photoId, error);
            if (error.isNetworkError) throw error;
            photoFailures.push({
              photoId: photo.photoId,
              message: String(error?.message || error || "Photo upload failed.")
            });
          }
        }
        if (receipts.length) {
          const receiptResult = await postSync(manifest, profile, [], receipts, signal);
          await global.DriverOfflineDB.applySyncResponse(partitionKey, receiptResult);
          for (const failed of (receiptResult.photos || []).filter((photo) =>
            !photo.durableReceipt && photo.status !== "durably_received"
          )) {
            photoFailures.push({
              photoId: failed.photoId,
              message: String(failed.error || "Photo durability verification failed; the local Blob will be re-uploaded.")
            });
          }
        }

        // A receipt can make an event newly applicable. An exact retry asks the
        // server to drain it without uploading an already-successful photo again.
        if (receipts.length) {
          const remaining = (await global.DriverOfflineDB.getPendingEvents(partitionKey))
            .filter((event) => event.manifestId === manifestId);
          if (remaining.length) {
            const retryPayloads = [];
            for (const event of remaining) retryPayloads.push(await buildEventPayload(event));
            const drained = await postSync(manifest, profile, retryPayloads, [], signal);
            await global.DriverOfflineDB.applySyncResponse(partitionKey, drained);
          }
        }
      }
      if (photoFailures.length) {
        const error = new Error(
          `${photoFailures.length} photo${photoFailures.length === 1 ? "" : "s"} could not be synchronized. Successful uploads were preserved and the remaining photo${photoFailures.length === 1 ? "" : "s"} will be retried.`
        );
        error.photoFailures = photoFailures;
        throw error;
      }
      await global.DriverOfflineDB.cleanupSynced(partitionKey).catch(() => {});
      const health = await global.DriverOfflineDB.getStorageHealth(partitionKey);
      const reviewRequired = Number(health.reviewRequiredCount || 0) > 0;
      configuration.onStatus?.({ state: reviewRequired ? "review" : "idle", partitionKey, health });
      configuration.onUpdated?.({ partitionKey, health });
      return { ok: true, health, reviewRequired };
    } catch (error) {
      await global.DriverOfflineDB.recordSyncError(partitionKey, error).catch(() => {});
      configuration.onStatus?.({ state: "error", partitionKey, error });
      configuration.onUpdated?.({ partitionKey, error });
      throw error;
    } finally {
      await global.DriverOfflineDB.releaseLease(partitionKey, ownerId).catch(() => {});
    }
  }

  function syncPartition(partitionKey) {
    if (!partitionKey) return Promise.resolve({ skipped: "no_partition" });
    const active = activeRuns.get(partitionKey);
    if (active) {
      active.rerunRequested = true;
      return active.promise;
    }
    const state = { rerunRequested: true, promise: null, controller: new AbortController() };
    state.promise = (async () => {
      let result;
      while (state.rerunRequested) {
        state.rerunRequested = false;
        result = await syncPartitionInternal(partitionKey, state.controller.signal);
      }
      return result;
    })().finally(() => activeRuns.delete(partitionKey));
    activeRuns.set(partitionKey, state);
    return state.promise;
  }

  function cancelPartition(partitionKey) {
    const active = activeRuns.get(partitionKey);
    if (!active) return false;
    active.rerunRequested = false;
    active.controller.abort();
    return true;
  }

  async function syncAll() {
    const partitions = await global.DriverOfflineDB.listSyncPartitions();
    const results = [];
    const failures = [];
    for (const profile of partitions) {
      try {
        results.push(await syncPartition(profile.partitionKey));
      } catch (error) {
        const failure = { ok: false, error: error.message, partitionKey: profile.partitionKey };
        failures.push(failure);
        results.push(failure);
      }
    }
    if (failures.length) {
      const error = new Error(`Driver offline synchronization failed for ${failures.length} partition(s).`);
      error.results = results;
      throw error;
    }
    return results;
  }

  async function registerBackgroundSync() {
    if (!global.navigator?.serviceWorker) return false;
    try {
      const registration = await global.navigator.serviceWorker.ready;
      if (!registration.sync) return false;
      await registration.sync.register("driver-offline-sync");
      return true;
    } catch {
      return false;
    }
  }

  global.DriverOfflineSync = {
    configure,
    confirmForegroundEvidence,
    registerForegroundEvent,
    syncPartition,
    cancelPartition,
    syncAll,
    registerBackgroundSync
  };
})(typeof self !== "undefined" ? self : window);

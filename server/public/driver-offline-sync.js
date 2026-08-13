(function driverOfflineSync(global) {
  "use strict";

  const DRIVER_PWA_CLIENT_VERSION = "2026.08.12.3";
  const DRIVER_PWA_VERSION_HEADER = "X-MBBS-Driver-Version";
  const LEASE_TTL_MS = 120000;
  const LEASE_HEARTBEAT_MS = 30000;
  const PHOTO_MEBIBYTE = 1024 * 1024;
  const PHOTO_TRANSFER_BASE_TIMEOUT_MS = 60000;
  const PHOTO_TRANSFER_CHUNK_TIMEOUT_MS = 30000;
  const PHOTO_TRANSFER_CHUNK_BYTES = 256 * 1024;
  const PHOTO_TRANSFER_MAX_TIMEOUT_MS = 6 * 60 * 1000;
  const PHOTO_RETRY_BASE_MS = 15000;
  const PHOTO_RETRY_MAX_MS = 15 * 60 * 1000;
  const JOB_BOUND_EVENT_TYPES = new Set(["job_started", "job_completed", "truck_switched_physical"]);
  const ownerId = `sync-${global.DriverOfflineDB.createUuid()}`;
  let configuration = {
    getAuthToken: () => "",
    onStatus: () => {},
    onUpdated: () => {}
  };
  const activeRuns = new Map();
  const partitionRetryTimers = new Map();

  function configure(options = {}) {
    configuration = { ...configuration, ...options };
  }

  function clearPartitionRetryTimer(partitionKey) {
    const timers = partitionRetryTimers.get(partitionKey);
    for (const timer of timers || []) clearTimeout(timer);
    partitionRetryTimers.delete(partitionKey);
  }

  function schedulePartitionRetry(partitionKey, failures = [], { continueDrain = false } = {}) {
    const retryTimes = failures
      .filter((failure) => failure?.retryable === true)
      .map((failure) => Date.parse(failure.nextAttemptAt || ""))
      .filter(Number.isFinite);
    if (!partitionKey || (!retryTimes.length && !continueDrain)) return false;
    clearPartitionRetryTimer(partitionKey);
    const timers = new Set();
    const schedule = (delay) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!timers.size) partitionRetryTimers.delete(partitionKey);
        void syncPartition(partitionKey).catch(() => {});
      }, delay);
      timers.add(timer);
    };
    // If a transfer broke the loop, immediately run another pass while that
    // photo is in backoff. This lets later retained photos make progress.
    if (continueDrain) schedule(1000);
    if (retryTimes.length) {
      schedule(Math.max(
        1000,
        Math.min(PHOTO_RETRY_MAX_MS, Math.min(...retryTimes) - Date.now())
      ));
    }
    partitionRetryTimers.set(partitionKey, timers);
    return true;
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

  function photoTransferTimeoutMs(photo) {
    const bytes = Math.max(1, Number(photo?.byteSize || photo?.blob?.size || 0));
    const chunks = Math.max(1, Math.ceil(bytes / PHOTO_TRANSFER_CHUNK_BYTES));
    return Math.min(
      PHOTO_TRANSFER_MAX_TIMEOUT_MS,
      PHOTO_TRANSFER_BASE_TIMEOUT_MS + chunks * PHOTO_TRANSFER_CHUNK_TIMEOUT_MS
    );
  }

  function retryablePhotoError(error) {
    if (typeof error?.retryable === "boolean") return error.retryable;
    const code = String(error?.code || "");
    if ([
      "driver_offline_photo_blob_missing",
      "driver_offline_photo_blob_size_mismatch",
      "driver_offline_photo_blob_hash_mismatch"
    ].includes(code)) return false;
    const status = Number(error?.status || error?.httpStatus || 0);
    if (status) return status === 408 || status === 425 || status === 429 || status >= 500;
    return Boolean(error?.isNetworkError || error?.name === "AbortError" || code === "driver_photo_upload_timeout")
      || !code.startsWith("driver_offline_photo_blob_");
  }

  function photoRetryDelayMs(photo, attemptCount) {
    const sizeUnits = Math.max(1, Math.ceil(
      Number(photo?.byteSize || photo?.blob?.size || 0) / PHOTO_MEBIBYTE
    ));
    const exponent = Math.min(5, Math.max(0, Number(attemptCount || 1) - 1));
    return Math.min(PHOTO_RETRY_MAX_MS, PHOTO_RETRY_BASE_MS * sizeUnits * (2 ** exponent));
  }

  function decoratePhotoError(error, photo, { phase, attemptCount }) {
    const decorated = error && typeof error === "object"
      ? error
      : new Error(String(error || "Photo upload failed."));
    decorated.phase = String(decorated.phase || phase || "upload");
    decorated.status = Math.max(0, Number(decorated.status || decorated.httpStatus || 0));
    decorated.retryable = retryablePhotoError(decorated);
    decorated.attemptCount = Math.max(0, Number(attemptCount || 0));
    decorated.nextAttemptAt = decorated.retryable
      ? new Date(Date.now() + photoRetryDelayMs(photo, decorated.attemptCount)).toISOString()
      : null;
    return decorated;
  }

  function photoFailure(photo, error) {
    return {
      photoId: String(photo?.photoId || ""),
      eventId: String(photo?.eventId || ""),
      phase: String(error?.phase || "upload"),
      byteSize: Math.max(0, Number(photo?.byteSize || photo?.blob?.size || 0)),
      attemptCount: Math.max(0, Number(error?.attemptCount ?? photo?.attemptCount ?? 0)),
      retryable: error?.retryable === true,
      nextAttemptAt: error?.nextAttemptAt || null,
      errorCode: String(error?.code || ""),
      httpStatus: Math.max(0, Number(error?.status || error?.httpStatus || 0)),
      message: String(error?.message || error || "Photo upload failed.")
    };
  }

  async function withPhotoTransferGuard(partitionKey, photo, outerSignal, task) {
    const controller = new AbortController();
    let settled = false;
    let heartbeatTimer = null;
    let rejectGuard = null;
    const guard = new Promise((_, reject) => {
      rejectGuard = reject;
    });
    const fail = (error) => {
      if (settled) return;
      controller.abort();
      rejectGuard(error);
    };
    const onOuterAbort = () => {
      const error = new Error("Driver photo synchronization was cancelled.");
      error.name = "AbortError";
      error.code = "driver_photo_upload_cancelled";
      fail(error);
    };
    if (outerSignal?.aborted) onOuterAbort();
    else outerSignal?.addEventListener?.("abort", onOuterAbort, { once: true });

    const timeout = setTimeout(() => {
      const error = new Error(
        `Photo upload did not finish within ${Math.ceil(photoTransferTimeoutMs(photo) / 60000)} minutes.`
      );
      error.code = "driver_photo_upload_timeout";
      error.isNetworkError = true;
      fail(error);
    }, photoTransferTimeoutMs(photo));

    const heartbeat = async () => {
      if (settled) return;
      try {
        const renewed = await global.DriverOfflineDB.acquireLease(partitionKey, ownerId, LEASE_TTL_MS);
        if (!renewed) {
          const error = new Error("Driver synchronization lease was lost during a photo upload.");
          error.code = "sync_lease_lost";
          fail(error);
          return;
        }
      } catch (cause) {
        const error = new Error("Driver synchronization lease could not be renewed during a photo upload.");
        error.code = "sync_lease_lost";
        error.cause = cause;
        fail(error);
        return;
      }
      if (!settled) heartbeatTimer = setTimeout(heartbeat, LEASE_HEARTBEAT_MS);
    };
    heartbeatTimer = setTimeout(heartbeat, LEASE_HEARTBEAT_MS);

    try {
      return await Promise.race([task(controller.signal), guard]);
    } finally {
      settled = true;
      clearTimeout(timeout);
      clearTimeout(heartbeatTimer);
      outerSignal?.removeEventListener?.("abort", onOuterAbort);
    }
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
    const actualSha256 = await global.DriverPhotoHash.sha256(photo.blob);
    if (!photo.sha256 || actualSha256 !== String(photo.sha256).toLowerCase()) {
      const error = new Error("The saved photo no longer matches its registered SHA-256 evidence descriptor.");
      error.code = "driver_offline_photo_blob_hash_mismatch";
      throw error;
    }
    return { expectedBytes, actualSha256 };
  }

  async function uploadPhoto(manifest, profile, photo, event, signal, transferState) {
    const currentProfile = await assertPartitionSession(profile);
    transferState.phase = "verifying";
    await global.DriverOfflineDB.markPhotoPhase?.(photo.photoId, transferState.phase);
    const { expectedBytes } = await verifyLocalPhotoBlob(photo);
    transferState.phase = "ticketing";
    await global.DriverOfflineDB.markPhotoPhase?.(photo.photoId, transferState.phase);
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
    transferState.phase = "uploading";
    await global.DriverOfflineDB.markPhotoPhase?.(photo.photoId, transferState.phase);
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
    if (!response.ok) {
      const error = new Error(payload.error || text || "Photo upload failed.");
      error.status = response.status;
      error.code = String(payload.code || "");
      throw error;
    }
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

  async function confirmPhotoReceipt(
    manifest,
    profile,
    partitionKey,
    photo,
    receipt,
    signal,
    transferState
  ) {
    transferState.phase = "confirming";
    await global.DriverOfflineDB.markPhotoPhase?.(photo.photoId, transferState.phase);
    const result = await postSync(manifest, profile, [], [receipt], signal);
    await global.DriverOfflineDB.applySyncResponse(partitionKey, result);
    const confirmation = (result.photos || result.photoReceipts || [])
      .find((candidate) => String(candidate.photoId || candidate.id || "") === String(photo.photoId));
    if (!confirmation) {
      const error = new Error("The server did not acknowledge this photo receipt.");
      error.code = "driver_photo_receipt_missing";
      throw error;
    }
    if (!confirmation.durableReceipt && confirmation.status !== "durably_received") {
      const error = new Error(
        confirmation.error || "Photo durability verification failed; the retained Blob will be retried."
      );
      error.code = String(confirmation.errorCode || "driver_photo_not_durable");
      throw error;
    }
    return confirmation;
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
      let drainInterrupted = false;
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

        let confirmedReceiptCount = 0;
        for (const photo of allPendingPhotos.filter((item) => group.eventIds.has(item.eventId))) {
          await assertPartitionSession(profile);
          const renewed = await global.DriverOfflineDB.acquireLease(partitionKey, ownerId, LEASE_TTL_MS);
          if (!renewed) {
            const error = new Error("Driver synchronization lease was lost.");
            error.code = "sync_lease_lost";
            throw error;
          }
          const scheduledRetryAt = Date.parse(photo.nextAttemptAt || "");
          if (Number.isFinite(scheduledRetryAt) && scheduledRetryAt > Date.now()) {
            photoFailures.push(photoFailure(photo, {
              phase: "backoff",
              attemptCount: Number(photo.attemptCount || 0),
              retryable: true,
              nextAttemptAt: new Date(scheduledRetryAt).toISOString(),
              code: "driver_photo_retry_deferred",
              message: `Photo retry is scheduled for ${new Date(scheduledRetryAt).toISOString()}.`
            }));
            continue;
          }
          const attemptCount = Number(photo.attemptCount || 0) + 1;
          const transferState = {
            phase: photo.objectReference ? "confirming" : "verifying"
          };
          try {
            await global.DriverOfflineDB.markPhotoAttempt(photo.photoId, transferState.phase);
            await withPhotoTransferGuard(partitionKey, photo, signal, async (transferSignal) => {
              const receipt = photo.objectReference
                ? {
                    photoId: photo.photoId,
                    objectReference: photo.objectReference,
                    byteSize: Number(photo.byteSize || photo.blob?.size || 0),
                    sha256: photo.sha256
                  }
                : await uploadPhoto(
                    manifest,
                    profile,
                    photo,
                    eventsById.get(photo.eventId),
                    transferSignal,
                    transferState
                  );
              return confirmPhotoReceipt(
                manifest,
                profile,
                partitionKey,
                photo,
                receipt,
                transferSignal,
                transferState
              );
            });
            confirmedReceiptCount += 1;
          } catch (error) {
            const decorated = decoratePhotoError(error, photo, {
              phase: transferState.phase,
              attemptCount
            });
            await global.DriverOfflineDB.markPhotoError(photo.photoId, decorated);
            photoFailures.push(photoFailure(photo, decorated));
            if (decorated.isNetworkError || decorated.code === "sync_lease_lost") {
              drainInterrupted = true;
              break;
            }
          }
        }

        // A receipt can make an event newly applicable. An exact retry asks the
        // server to drain it without uploading an already-successful photo again.
        if (confirmedReceiptCount && !drainInterrupted) {
          const remaining = (await global.DriverOfflineDB.getPendingEvents(partitionKey))
            .filter((event) => event.manifestId === manifestId);
          if (remaining.length) {
            const retryPayloads = [];
            for (const event of remaining) retryPayloads.push(await buildEventPayload(event));
            const drained = await postSync(manifest, profile, retryPayloads, [], signal);
            await global.DriverOfflineDB.applySyncResponse(partitionKey, drained);
          }
        }
        if (drainInterrupted) break;
      }
      if (photoFailures.length) {
        const error = new Error(
          `${photoFailures.length} photo${photoFailures.length === 1 ? "" : "s"} could not be synchronized. Successful uploads were preserved and the remaining photo${photoFailures.length === 1 ? "" : "s"} will be retried.`
        );
        error.code = "driver_photo_sync_partial";
        error.retryable = photoFailures.some((failure) => failure.retryable);
        error.photoFailures = photoFailures;
        schedulePartitionRetry(partitionKey, photoFailures, {
          continueDrain: drainInterrupted
        });
        throw error;
      }
      clearPartitionRetryTimer(partitionKey);
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
    clearPartitionRetryTimer(partitionKey);
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
    clearPartitionRetryTimer(partitionKey);
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

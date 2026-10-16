(function (global) {
  "use strict";

  const API_TIMEOUT_MS = 60000;
  const SAVE_TIMEOUT_MS = 120000;
  const ASSET_VERSION = "20261016-driver-reconnect-v1";
  const QUEUE_KEY = "mbbs.driver.uploadFailures.v1";
  const QUEUE_LIMIT = 100;

  function uploadError(code, message, status = 0) {
    return Object.assign(new Error(message), {code, status,
      isNetworkError: code === "driver_photo_upload_network_error" || code === "driver_upload_timeout"});
  }

  function safeMessage(value) {
    return String(value || "Upload failed.")
      .replace(/\bBearer\s+[^\s]+/giu, "Bearer [redacted]")
      .replace(/\b(?:token|access_token|secret|signature|authorization|api[_-]?key)\s*[=:]\s*[^\s&;,]+/giu, "credential=[redacted]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted]")
      .replace(/data:[^\s,]*,[^\s]+/giu, "[image omitted]")
      .slice(0, 1000);
  }

  async function deadline(task, {signal, timeoutMs = API_TIMEOUT_MS} = {}) {
    const cancelled = () => uploadError("driver_upload_cancelled", "Upload was cancelled.");
    if (signal?.aborted) throw cancelled();
    const controller = new global.AbortController();
    let rejectGuard;
    const guard = new Promise((_resolve, reject) => { rejectGuard = reject; });
    const stop = error => {
      rejectGuard(error);
      controller.abort();
    };
    const onAbort = () => stop(cancelled());
    const limit = Math.max(1, Number(timeoutMs) || API_TIMEOUT_MS);
    const expiresAt = Date.now() + limit;
    const expire = () => stop(Object.assign(uploadError("driver_upload_timeout", "The request timed out. Reconnecting..."),
      {timeoutMs: limit, timerDelayMs: Math.max(0, Date.now() - expiresAt)}));
    const resume = () => { if (Date.now() >= expiresAt) expire(); };
    const timer = global.setTimeout(expire, limit);
    global.addEventListener?.("pageshow", resume);
    global.document?.addEventListener("visibilitychange", resume);
    signal?.addEventListener("abort", onAbort, {once: true});
    try {
      return await Promise.race([guard, Promise.resolve().then(() => task(controller.signal))]);
    } finally {
      global.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      global.removeEventListener?.("pageshow", resume);
      global.document?.removeEventListener("visibilitychange", resume);
    }
  }

  function retryable(error) {
    if (error.code === "driver_upload_cancelled") return false;
    if (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) return false;
    return Boolean(error.isNetworkError || error.status >= 500 || [408, 429].includes(error.status)
      || ["driver_upload_timeout", "driver_photo_upload_invalid_response", "driver_request_invalid_response",
        "driver_photo_save_not_confirmed", "driver_save_recovery_pending"].includes(error.code));
  }

  function reconnectDelay(attempt) { return Math.min(30000, 1000 * 2 ** Math.min(5, Math.max(0, attempt - 1))); }

  function waitToReconnect(delayMs, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => finish(uploadError("driver_upload_cancelled", "Recovery paused. Your photos are retained."));
      const wake = () => { if (global.document?.visibilityState !== "hidden") finish(); };
      const timer = global.setTimeout(() => finish(), delayMs);
      function finish(error) {
        global.clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        for (const name of ["online", "pageshow"]) global.removeEventListener?.(name, wake);
        global.document?.removeEventListener("visibilitychange", wake);
        if (error) reject(error); else resolve();
      }
      signal?.addEventListener("abort", abort, {once: true});
      for (const name of ["online", "pageshow"]) global.addEventListener?.(name, wake);
      global.document?.addEventListener("visibilitychange", wake);
      if (signal?.aborted) abort();
    });
  }

  async function reconnect(operation, {signal, onRetry = () => {}} = {}) {
    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) throw uploadError("driver_upload_cancelled", "Recovery paused. Your photos are retained.");
      try { return await operation(attempt); }
      catch (error) {
        if (signal?.aborted) throw uploadError("driver_upload_cancelled", "Recovery paused. Your photos are retained.");
        if (!retryable(error)) throw error;
        const delayMs = reconnectDelay(attempt);
        onRetry({attempt, delayMs});
        await waitToReconnect(delayMs, signal);
      }
    }
  }

  function environmentDiagnostic(error = {}) {
    return {browserOnline: global.navigator?.onLine ?? null, visibilityState: global.document?.visibilityState || "unknown",
      timeoutMs: error.timeoutMs || 0, timerDelayMs: error.timerDelayMs || 0};
  }

  function photoTimeoutMs(photo) {
    const size = Math.max(1, Number(photo?.byteSize || photo?.blob?.size || 0));
    return Math.min(360000, 60000 + Math.ceil(size / (256 * 1024)) * 30000);
  }

  function batchProgress(photos) {
    const weights = photos.map(photo => Math.max(1, Number(photo?.byteSize || photo?.blob?.size || 1)));
    const fractions = photos.map(photo => photo?.objectReference
      || (typeof photo === "string" && photo.startsWith("r2://")) ? 100 : 0);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    return (index, value) => {
      if (!Number.isInteger(index) || index < 0 || index >= photos.length) throw new RangeError("Invalid photo progress index.");
      const percentage = value.percentage === null ? null
        : Math.floor(Math.max(0, Math.min(100, Number(value.percentage) || 0)));
      if (percentage !== null) fractions[index] = percentage;
      const transferred = weights.reduce((sum, weight, position) => sum + weight * fractions[position], 0);
      return {...value, percentage, overallPercentage: percentage === null ? null : Math.floor(transferred / total),
        photoNumber: index + 1, photoCount: photos.length};
    };
  }

  function transfer(ticket, photo, {signal, filename, update}) {
    return new Promise((resolve, reject) => {
      const xhr = new global.XMLHttpRequest();
      let settled = false;
      const abort = () => {
        finish(reject, uploadError("driver_upload_cancelled", "Upload was cancelled."));
        xhr.abort();
      };
      function finish(callback, value) {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        xhr.onload = xhr.onerror = xhr.ontimeout = xhr.onabort = null;
        xhr.upload.onprogress = xhr.upload.onload = null;
        callback(value);
      }
      xhr.upload.onprogress = event => {
        const fraction = event.lengthComputable && event.total > 0 ? Math.min(1, event.loaded / event.total) : null;
        update("uploading", fraction === null ? null : Math.floor(fraction * 100),
          fraction === null ? 0 : Math.floor(photo.blob.size * fraction));
      };
      xhr.upload.onload = () => update("confirming", 100, photo.blob.size);
      xhr.onload = () => {
        let payload;
        try { payload = JSON.parse(xhr.responseText || "{}"); } catch { payload = {}; }
        if (xhr.status < 200 || xhr.status >= 300) {
          finish(reject, uploadError("driver_photo_upload_http_error", safeMessage(payload?.error || `Storage rejected the upload (${xhr.status}).`), xhr.status));
        } else if (typeof payload?.key !== "string" || !payload.key || /[\u0000-\u001f]/u.test(payload.key) || payload.key.length > 2048) {
          finish(reject, uploadError("driver_photo_upload_invalid_response", "Storage did not confirm an uploaded photo key.", xhr.status));
        } else {
          finish(resolve, `r2://${payload.key}`);
        }
      };
      xhr.onerror = () => finish(reject, uploadError("driver_photo_upload_network_error", "The upload connection failed. The browser did not provide a more specific network reason."));
      xhr.ontimeout = () => finish(reject, uploadError("driver_upload_timeout", "The photo upload timed out."));
      xhr.onabort = () => finish(reject, uploadError("driver_upload_cancelled", "Upload was cancelled."));
      signal.addEventListener("abort", abort, {once: true});
      if (signal.aborted) { abort(); return; }
      try {
        xhr.open("POST", ticket.uploadUrl, true);
        xhr.setRequestHeader("Authorization", `Bearer ${ticket.token}`);
        const body = new global.FormData();
        body.append("file", photo.blob, filename || "driver-photo.jpg");
        xhr.send(body);
      } catch (error) { finish(reject, error); }
    });
  }

  function failureDiagnostic(photo, context, progress, error, attempt, startedAt) {
    return {
      failureId: global.crypto.randomUUID(), outcome: "failed", ...environmentDiagnostic(error), stage: progress.phase, occurredAt: new Date().toISOString(),
      jobId: String(context.jobId || ""), photoId: String(photo.photoId || ""), planDate: String(context.planDate || ""),
      recordType: String(context.recordType || ""), clientVersion: String(context.clientVersion || ""), assetVersion: ASSET_VERSION,
      attempt, byteSize: photo.blob.size, transferredBytes: progress.transferredBytes, percentage: progress.percentage,
      elapsedMs: Math.max(0, Math.min(86400000, Date.now() - startedAt)), httpStatus: Number(error.status || 0), errorCode: String(error.code), message: safeMessage(error.message)
    };
  }

  async function upload(photo, {ticket, signal, timeoutMs, filename, onProgress = () => {}, onFailure = () => {}, context = {}}) {
    const startedAt = Date.now();
    const attempt = Math.max(0, Number(photo.uploadAttemptCount || 0)) + 1;
    photo.uploadAttemptCount = attempt;
    let progress = {phase: "authorizing", percentage: 0, transferredBytes: 0};
    const update = (phase, percentage, transferredBytes) => {
      progress = {phase, percentage, transferredBytes};
      onProgress(progress);
    };
    try {
      update("authorizing", 0, 0);
      const authorization = await deadline(ticket, {signal, timeoutMs: Math.min(API_TIMEOUT_MS, timeoutMs || API_TIMEOUT_MS)});
      if (!authorization?.uploadUrl || !authorization?.token) {
        throw uploadError("driver_photo_upload_invalid_response", "Upload authorization is incomplete.");
      }
      progress = {...progress, phase: "uploading"};
      const reference = await deadline(innerSignal => transfer(authorization, photo, {signal: innerSignal, filename, update}),
        {signal, timeoutMs: timeoutMs || photoTimeoutMs(photo)});
      update("uploaded", 100, photo.blob.size);
      return reference;
    } catch (error) {
      if (!error.code) error.code = error.isNetworkError ? "driver_photo_upload_network_error" : "driver_photo_upload_failed";
      const diagnostic = failureDiagnostic(photo, context, progress, error, attempt, startedAt);
      try { onFailure(diagnostic); } catch { /* Diagnostic storage must not obscure the upload failure. */ }
      throw error;
    }
  }

  function boundedDiagnostic(raw) {
    const result = {};
    const limits = {failureId: 100, stage: 20, occurredAt: 40, jobId: 1000, photoId: 160, planDate: 10,
      recordType: 80, clientVersion: 80, assetVersion: 80, errorCode: 160, message: 1000, outcome: 12, recoveryId: 100, requestId: 100, visibilityState: 20};
    for (const [field, limit] of Object.entries(limits)) {
      const value = String(raw[field] || "");
      result[field] = value ? safeMessage(value).slice(0, limit) : "";
    }
    for (const field of ["attempt", "byteSize", "transferredBytes", "percentage", "elapsedMs", "httpStatus", "browserOnline", "timeoutMs", "timerDelayMs"]) result[field] = raw[field];
    return result;
  }

  function failureQueue(storage) {
    let memory = {items: [], dropped: 0};
    let storageUnavailable = false;
    const flights = new Map();
    const ownerKey = owner => JSON.stringify([String(owner.login || ""), String(owner.deviceId || "")]);
    function read() {
      if (storageUnavailable) return memory;
      try {
        const value = JSON.parse(storage.getItem(QUEUE_KEY) || "null");
        if (value && Array.isArray(value.items)) memory = {
          items: value.items.filter(item => item && typeof item.owner === "string" && item.failure && typeof item.failure.failureId === "string").slice(-QUEUE_LIMIT)
            .map(item => ({owner: item.owner, failure: boundedDiagnostic(item.failure)})),
          dropped: Math.max(0, Number(value.dropped) || 0)
        };
      } catch { storageUnavailable = true; /* Retain the memory fallback when browser storage is denied. */ }
      return memory;
    }
    function save(value) {
      memory = value;
      try { storage.setItem(QUEUE_KEY, JSON.stringify(value)); storageUnavailable = false; }
      catch { storageUnavailable = true; /* The current session can still send diagnostics. */ }
    }
    function enqueue(owner, raw) {
      const diagnostic = boundedDiagnostic(raw);
      const value = read();
      const key = ownerKey(owner);
      if (value.items.some(item => item.owner === key && item.failure.failureId === diagnostic.failureId)) return;
      value.items.push({owner: key, failure: diagnostic});
      const overflow = Math.max(0, value.items.length - QUEUE_LIMIT);
      value.items.splice(0, overflow);
      value.dropped += overflow;
      save(value);
    }
    async function drain(owner, send, signal) {
      const key = ownerKey(owner);
      while (!signal?.aborted) {
        const value = read();
        const entry = value.items.find(item => item.owner === key);
        if (!entry) return;
        const reportedDropped = value.dropped;
        try { await send({...entry.failure, droppedLogCount: reportedDropped}); } catch { return; }
        if (signal?.aborted) return;
        const current = read();
        current.items = current.items.filter(item => item.owner !== key || item.failure.failureId !== entry.failure.failureId);
        current.dropped = Math.max(0, current.dropped - reportedDropped);
        save(current);
      }
    }
    function flush(owner, send, {signal} = {}) {
      const key = ownerKey(owner);
      if (!flights.has(key)) flights.set(key, Promise.resolve().then(() => drain(owner, send, signal)).finally(() => flights.delete(key)));
      return flights.get(key);
    }
    return {enqueue, flush, pending: owner => read().items.filter(item => item.owner === ownerKey(owner)).map(item => item.failure)};
  }

  global.DriverUpload = {deadline, reconnect, reconnectDelay, environmentDiagnostic, photoTimeoutMs, batchProgress, upload, failureQueue, safeMessage, API_TIMEOUT_MS, SAVE_TIMEOUT_MS, ASSET_VERSION};
})(globalThis);

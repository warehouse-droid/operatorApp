const app = document.getElementById("driverApp");
const toast = document.getElementById("driverToast");
const offlineStatus = document.getElementById("driverOfflineStatus");
const routeChangeStatus = document.getElementById("driverRouteChangeStatus");
const syncHold = document.getElementById("driverSyncHold");
const TOKEN_KEY = "mbbs.driver.token"; // secret-scan: allow -- localStorage key name, not a token.
const STAFF_TOKEN_KEY = "mbbs.staff.token"; // secret-scan: allow -- localStorage key name, not a token.
const STAFF_ROLE_KEY = "mbbs.staff.role";
const STAFF_ROLES_KEY = "mbbs.staff.roles";
const CAMERA_FACING_KEY = "mbbs.camera.facingMode";
const DRIVER_PWA_CLIENT_VERSION = "2026.08.12.3";
const DRIVER_PWA_VERSION_HEADER = "X-MBBS-Driver-Version";
const DRIVER_PWA_UPDATE_MARKER_KEY = "mbbs.driver.requiredPwaVersion";
const DRIVER_PWA_VERIFIED_VERSION_KEY = "mbbs.driver.verifiedPwaVersion";
const DRIVER_OFFLINE_SESSION_KEY = "mbbs.driver.offlineObserved";
const DRIVER_OFFLINE_MODE_KEY = "mbbs.driver.offlineModeEnabled";
const DRIVER_DEVICE_ID_KEY = "mbbs.driver.deviceId";
const DRIVER_PWA_VERSION_CHECK_MS = 60000;
const DRIVER_OFFLINE_RECOVERY_CHECK_MS = 2000;
const DRIVER_ROUTE_PRESENCE_INTERVAL_MS = 10_000;
const DRIVER_PWA_REPAIR_TIMEOUT_MS = 45000;
const t = (key, fallback) => window.MBBS_I18N?.t(key, fallback) || fallback;
const tf = (key, fallback, variables = {}) => window.MBBS_I18N?.format(key, fallback, variables) || fallback;
const localizeMessage = (message) => window.MBBS_I18N?.message(message) || String(message || "");
const languageToggle = () => window.MBBS_I18N?.toggleHtml() || "";

let authToken = localStorage.getItem(TOKEN_KEY) || "";
let driver = null;
let currentJob = null;
let dayState = null;
let photos = [];
let driverRemark = "";
let driverRemarkSavePromise = Promise.resolve();
let binDraft = null;
let binDraftSavePromise = Promise.resolve();
let dvirPhotos = [];
let dvirMode = "";
const instructionMediaObjectUrls = new Map();
const instructionMediaOnlineFallbackIds = new Set();
const instructionMediaRetryNonces = new Map();
let instructionMediaPreparationKey = "";
let instructionMediaPreparationGeneration = 0;
let instructionTranslationPromise = null;
let instructionTranslationPromiseKey = "";
const instructionTranslationCache = new Map();
let photoPromptOpen = false;
let eventSource = null;
let locationCheck = null;
const locationOverrideApproval = window.DriverLocationOverridePolicy.create();
let countdownTimer = null;
let activeRest = null;
let restSummary = null;
let restTimer = null;
let endedRestMarker = null;
let activeView = "job";
let driverHistory = [];
let selectedHistoryId = "";
let historyDate = localDate();
let cameraFacingMode = localStorage.getItem(CAMERA_FACING_KEY) === "user" ? "user" : "environment";
let nextJobLoadPromise = null;
let liveRefreshTimer = null;
let liveRefreshRunning = false;
let liveRefreshQueued = false;
let quietSyncRunCount = 0;
let quietSyncEpoch = 0;
let quietSyncHoldLatched = false;
let quietSyncHoldTimer = null;
let quietSyncRefreshQueued = false;
let quietSyncRestoreFocus = null;
const quietSyncEventIds = new Map();
let driverInteractionEpoch = 0;
let photoCaptureInProgress = false;
let photoCaptureResetTimer = null;
let driverOfflineModeEnabled = false;
let driverOfflineModeKnown = false;
let driverOfflineModeRevision = null;
let offlineStorageAvailable = false;
let offlineDeviceId = browserDriverDeviceId();
let offlinePartition = null;
let offlineManifest = null;
let offlineDeferredManifest = null;
let offlineManifestUpdateDeferred = false;
let offlineRouteDownloading = false;
let offlineShellReady = false;
let offlineSyncing = false;
let offlineStatusOpen = false;
let offlineCachedView = false;
let browserOfflineObserved = !navigator.onLine || readDriverOfflineSessionMarker();
let driverOfflineRecoveryRunning = false;
let offlineHealth = null;
let offlineSyncState = null;
let offlineRetainedClientError = null;
let offlineStorageEstimate = null;
let offlineStoragePersistent = false;
let dayPlanDownloadPromise = null;
let onlineRouteValidationPromise = null;
let onlineRouteRevalidationTimer = null;
let onlineRouteRevalidationQueued = false;
let onlineRouteLastValidatedAt = 0;
let onlineRouteUpdatePending = false;
let savedRouteClearRunning = false;
let driverShellRepairRunning = false;
let pendingDvirEvent = null;
let pendingDvirPhotos = [];
let pendingDutyEvents = [];
let samsaraReconcileRunning = false;
let driverRequestController = new AbortController();
let driverSessionInvalidated = false;
let driverIdentityValidated = false;
let driverIdentityValidationPromise = null;
let driverPwaUpdateRequired = null;
let driverPwaVersionCheckComplete = false;
let driverPwaVersionCheckPromise = null;
let driverServiceWorkerRegistration = null;
let driverRouteChangeRequests = [];
let driverRoutePresenceRunning = false;
let driverRoutePushAvailable = null;
const activeForegroundEventIds = new Set();
const onlineBinEventAttempts = new Map();
const COMPLETE_DELAY_MS = 10000;
const LIVE_REFRESH_DEBOUNCE_MS = 180;
const QUIET_SYNC_LEASE_POLL_MS = 250;
const QUIET_SYNC_EVENT_TTL_MS = 10 * 60 * 1000;
const QUIET_SYNC_EVENT_LIMIT = 1000;
const PHOTO_CAPTURE_TIMEOUT_MS = 60000;
const DELIVERY_INSTRUCTION_IMAGE_TIMEOUT_MS = 15000;
const DRIVER_REMARK_MAX_LENGTH = 1000;
const ONLINE_ROUTE_REVALIDATE_MS = 45000;
const DRIVER_INTERACTION_ACTIONS = new Set([
  "reconcile-dvir",
  "logout",
  "refresh",
  "back-job",
  "show-photo",
  "recheck-location",
  "override-location",
  "start-rest",
  "end-rest",
  "close-photo",
  "switch-camera",
  "take-photo",
  "choose-gallery-photo",
  "take-dvir-photo",
  "choose-dvir-gallery-photo",
  "add-job-photo",
  "remove-job-photo",
  "add-dvir-photo",
  "remove-dvir-photo",
  "submit-dvir",
  "skip-dvir",
  "start-job",
  "confirm-truck-switch",
  "skip-samsara-switch",
  "complete-job"
]);

function browserDriverDeviceId() {
  try {
    const existing = String(localStorage.getItem(DRIVER_DEVICE_ID_KEY) || "").trim();
    if (existing.length >= 8) return existing;
    const created = globalThis.crypto?.randomUUID?.()
      || `driver-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(DRIVER_DEVICE_ID_KEY, created);
    return created;
  } catch {
    return globalThis.crypto?.randomUUID?.()
      || `driver-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function restoreDriverOfflineMode() {
  try {
    const stored = localStorage.getItem(DRIVER_OFFLINE_MODE_KEY);
    if (stored !== "true" && stored !== "false") return;
    driverOfflineModeEnabled = stored === "true";
    driverOfflineModeKnown = true;
  } catch {
    // A missing saved mode fails closed to online-only until the server replies.
  }
}

function publishDriverOfflineMode() {
  const message = {
    type: "DRIVER_OFFLINE_MODE",
    enabled: driverOfflineModeEnabled,
    revision: driverOfflineModeRevision
  };
  navigator.serviceWorker?.controller?.postMessage(message);
  driverServiceWorkerRegistration?.active?.postMessage?.(message);
}

function applyDriverOfflineMode(payload = {}) {
  if (typeof payload.offlineEnabled !== "boolean") return false;
  const changed = driverOfflineModeKnown
    && driverOfflineModeEnabled !== payload.offlineEnabled;
  driverOfflineModeEnabled = payload.offlineEnabled;
  driverOfflineModeKnown = true;
  driverOfflineModeRevision = payload.offlineModeRevision ?? null;
  try {
    localStorage.setItem(DRIVER_OFFLINE_MODE_KEY, String(driverOfflineModeEnabled));
  } catch {
    // The live server value remains authoritative for this document.
  }
  publishDriverOfflineMode();
  if (changed) {
    offlineCachedView = false;
    onlineRouteLastValidatedAt = 0;
    if (!driverOfflineModeEnabled) {
      offlineRouteDownloading = false;
      onlineRouteUpdatePending = false;
      offlineManifestUpdateDeferred = false;
    }
    renderOfflineStatus();
    applyDriverActionProtectionGate();
    if (driver && authToken && navigator.onLine && !photoInteractionActive()) {
      void loadNextJob().catch((error) => showToast(error.message));
    }
  }
  return changed;
}

restoreDriverOfflineMode();

function readDriverOfflineSessionMarker() {
  try {
    return sessionStorage.getItem(DRIVER_OFFLINE_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

function markDriverBrowserOffline() {
  browserOfflineObserved = true;
  try {
    sessionStorage.setItem(DRIVER_OFFLINE_SESSION_KEY, "1");
  } catch {
    // The in-memory marker still protects the current document when session
    // storage is disabled by the browser.
  }
}

function markDriverBrowserOnline() {
  browserOfflineObserved = false;
  try {
    sessionStorage.removeItem(DRIVER_OFFLINE_SESSION_KEY);
  } catch {
    // The in-memory marker is authoritative for the current document.
  }
}
const DRIVER_MUTATION_ACTIONS = new Set([
  "start-rest",
  "end-rest",
  "submit-dvir",
  "skip-dvir",
  "start-job",
  "confirm-truck-switch",
  "skip-samsara-switch",
  "complete-job"
]);
const DRIVER_ROUTE_PROTECTED_ACTIONS = new Set([
  "start-rest",
  "end-rest",
  "show-photo",
  "take-photo",
  "choose-gallery-photo",
  "take-dvir-photo",
  "choose-dvir-gallery-photo",
  "add-job-photo",
  "remove-job-photo",
  "add-dvir-photo",
  "remove-dvir-photo",
  "submit-dvir",
  "skip-dvir",
  "start-job",
  "confirm-truck-switch",
  "skip-samsara-switch",
  "complete-job"
]);
let activeDriverMutationToken = null;

function storedDriverPwaUpdateMarker() {
  try {
    const value = JSON.parse(localStorage.getItem(DRIVER_PWA_UPDATE_MARKER_KEY) || "null");
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function restoreDriverPwaUpdateMarker() {
  const marker = storedDriverPwaUpdateMarker();
  const requiredVersion = String(marker?.currentVersion || marker?.minimumVersion || "").trim();
  if (!requiredVersion || requiredVersion === DRIVER_PWA_CLIENT_VERSION) {
    try {
      localStorage.removeItem(DRIVER_PWA_UPDATE_MARKER_KEY);
    } catch {
      // Storage may be unavailable; the live server check still protects actions.
    }
    return false;
  }
  driverPwaUpdateRequired = {
    ...marker,
    currentVersion: requiredVersion,
    minimumVersion: String(marker?.minimumVersion || requiredVersion),
    reason: marker?.reason || "stored_update_requirement"
  };
  driverPwaVersionCheckComplete = true;
  return true;
}

function renderDriverPwaUpdateRequired() {
  if (!driverPwaUpdateRequired) return false;
  resetQuietSync();
  if (offlineStatus) offlineStatus.hidden = true;
  if (syncHold) syncHold.hidden = true;
  document.body.classList.remove("driver-sync-hold-active", "driver-sync-input-locked");
  document.body.classList.add("driver-pwa-update-active");
  const currentVersion = String(
    driverPwaUpdateRequired.currentVersion
    || driverPwaUpdateRequired.minimumVersion
    || t("driver.pwaLatest", "latest")
  );
  app.innerHTML = `
    <section class="driver-pwa-update-screen" role="alert" aria-live="assertive">
      <div class="driver-pwa-update-card">
        <span class="driver-pwa-update-icon" aria-hidden="true">&#8635;</span>
        <p>${t("app.driver", "MBBS Driver")}</p>
        <h1>${t("driver.pwaUpdateTitle", "Driver PWA update required")}</h1>
        <strong>${t("driver.pwaUpdateCloseReopen", "Close and reopen the Driver PWA while connected to the internet before continuing.")}</strong>
        <p>${t("driver.pwaUpdateEvidenceProtected", "Reload and Repair preserve saved evidence. Use the hard reset only while online when that local evidence may be permanently discarded.")}</p>
        <div class="driver-pwa-version-detail">
          <span>${t("driver.pwaOpenVersion", "Open version")}</span><b>${escapeHtml(DRIVER_PWA_CLIENT_VERSION)}</b>
          <span>${t("driver.pwaLatestVersion", "Latest version")}</span><b>${escapeHtml(currentVersion)}</b>
        </div>
        <button class="primary" data-action="reload-driver-pwa" type="button">${t("driver.pwaReloadLatest", "Reload latest PWA")}</button>
        <button class="secondary" data-action="repair-driver-pwa" ${driverShellRepairRunning ? "disabled" : ""} type="button">${driverShellRepairRunning ? t("driver.pwaRepairingCache", "Repairing Driver app cache…") : t("driver.pwaRepairCache", "Repair Driver app cache")}</button>
        <small>${t("driver.pwaRepairPreservesData", "Repairs only MBBS Driver app files. Saved routes, photos, pending submissions, login state, and other MBBS app data are preserved.")}</small>
        <a class="driver-site-reset-link" href="/reset-driver">${t("driver.pwaHardReset", "Hard reset this Driver site")}</a>
        <small class="driver-site-reset-warning">${t("driver.pwaHardResetWarning", "Emergency online recovery only. This signs out and permanently deletes all MBBS site storage, caches, saved routes, pending actions, and photos from this browser.")}</small>
        <small>${t("driver.pwaIphoneReopenHelp", "On iPhone or an installed PWA, close every MBBS Driver window and open it again if this message remains after reloading.")}</small>
      </div>
    </section>
  `;
  return true;
}

function requireDriverPwaUpdate(payload = {}, { reason = "server_version" } = {}) {
  const currentVersion = String(payload.currentVersion || payload.minimumVersion || "");
  driverPwaUpdateRequired = {
    currentVersion,
    minimumVersion: String(payload.minimumVersion || currentVersion),
    clientVersion: DRIVER_PWA_CLIENT_VERSION,
    preserveLocalEvidence: payload.preserveLocalEvidence !== false,
    reason,
    detectedAt: new Date().toISOString()
  };
  driverPwaVersionCheckComplete = true;
  try {
    localStorage.setItem(DRIVER_PWA_UPDATE_MARKER_KEY, JSON.stringify(driverPwaUpdateRequired));
  } catch {
    // The in-memory latch remains authoritative for this open page.
  }
  disconnectEvents();
  stopOnlineRouteRevalidation();
  renderDriverPwaUpdateRequired();
  return false;
}

async function checkDriverPwaVersion({ force = false, reason = "periodic" } = {}) {
  if (driverPwaUpdateRequired) return false;
  if (driverPwaVersionCheckPromise) return driverPwaVersionCheckPromise;
  const run = (async () => {
    try {
      const response = await fetch(`/api/driver/client-version?nonce=${encodeURIComponent(Date.now())}`, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin", // secret-scan: allow -- Fetch credential mode, not a credential value.
        headers: {
          "Cache-Control": "no-store",
          [DRIVER_PWA_VERSION_HEADER]: DRIVER_PWA_CLIENT_VERSION
        }
      });
      const text = await response.text();
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = {};
      }
      if (!response.ok) throw Object.assign(new Error(payload.error || text || "Version check failed."), {
        status: response.status,
        data: payload
      });
      markDriverBrowserOnline();
      const serverVersion = String(payload.currentVersion || "").trim();
      if (!serverVersion) throw new Error(t("driver.pwaVersionIncomplete", "The Driver PWA version response was incomplete."));
      if (serverVersion !== DRIVER_PWA_CLIENT_VERSION || payload.isCurrent !== true) {
        return requireDriverPwaUpdate(payload, { reason });
      }
      applyDriverOfflineMode(payload);
      driverPwaVersionCheckComplete = true;
      try {
        localStorage.setItem(DRIVER_PWA_VERIFIED_VERSION_KEY, DRIVER_PWA_CLIENT_VERSION);
        localStorage.removeItem(DRIVER_PWA_UPDATE_MARKER_KEY);
      } catch {
        // Version verification is still valid for this page.
      }
      applyDriverActionProtectionGate();
      return true;
    } catch (error) {
      // A version endpoint outage must not turn a valid saved route into an
      // authentication failure. Interactive APIs still enforce 426 online.
      driverPwaVersionCheckComplete = true;
      applyDriverActionProtectionGate();
      return !driverPwaUpdateRequired;
    }
  })();
  driverPwaVersionCheckPromise = run;
  try {
    return await run;
  } finally {
    if (driverPwaVersionCheckPromise === run) driverPwaVersionCheckPromise = null;
  }
}

async function reloadLatestDriverPwa(button = null) {
  if (button) {
    button.disabled = true;
    button.textContent = t("driver.pwaLoadingLatest", "Loading latest PWA…");
  }
  try {
    const registration = driverServiceWorkerRegistration
      || await navigator.serviceWorker?.getRegistration("/driver");
    if (registration) {
      await registration.update();
      registration.waiting?.postMessage({ type: "SKIP_WAITING" });
    }
    window.location.replace(`/driver?update=${encodeURIComponent(Date.now())}`);
  } catch (error) {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = t("driver.pwaRetryLoadingLatest", "Retry loading latest PWA");
    }
    showToast(tf(
      "driver.pwaLoadFailed",
      "Could not load the update. Check internet, then close and reopen the PWA. {detail}",
      { detail: localizeMessage(error.message || "") }
    ));
  }
}

function waitForDriverWorkerActivation(worker, timeoutMs = DRIVER_PWA_REPAIR_TIMEOUT_MS) {
  if (!worker || worker.state === "activated") return Promise.resolve(worker);
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.removeEventListener?.("statechange", onStateChange);
      reject(new Error(t("driver.pwaRepairWorkerTimeout", "The updated Driver app did not become ready in time.")));
    }, timeoutMs);
    function finish(callback, value) {
      window.clearTimeout(timeout);
      worker.removeEventListener?.("statechange", onStateChange);
      callback(value);
    }
    function onStateChange() {
      if (worker.state === "activated") finish(resolve, worker);
      else if (worker.state === "redundant") {
        finish(reject, new Error(t("driver.pwaRepairWorkerRejected", "The Driver app update was replaced before it became ready.")));
      }
    }
    worker.addEventListener("statechange", onStateChange);
    onStateChange();
  });
}

function requestDriverShellRepair(worker) {
  if (typeof MessageChannel !== "function") {
    return Promise.reject(new Error(t("driver.pwaRepairUnsupported", "This browser cannot safely repair the Driver app cache.")));
  }
  const requestId = globalThis.crypto?.randomUUID?.()
    || `driver-cache-repair-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => {
      channel.port1.close?.();
      reject(new Error(t("driver.pwaRepairResponseTimeout", "The Driver app cache repair timed out. Your saved data was not cleared.")));
    }, DRIVER_PWA_REPAIR_TIMEOUT_MS);
    channel.port1.onmessage = (event) => {
      const response = event.data || {};
      if (response.type !== "DRIVER_REPAIR_SHELL_RESULT" || response.requestId !== requestId) return;
      window.clearTimeout(timeout);
      channel.port1.close?.();
      if (!response.ok) {
        reject(new Error(response.error || t("driver.pwaRepairFailed", "The Driver app cache could not be repaired.")));
        return;
      }
      if (response.version !== DRIVER_PWA_CLIENT_VERSION) {
        reject(new Error(t("driver.pwaRepairStaleWorker", "The old Driver app is still active. Close every Driver window, reopen it while online, and retry.")));
        return;
      }
      resolve(response);
    };
    channel.port1.start?.();
    try {
      worker.postMessage({ type: "DRIVER_REPAIR_SHELL", requestId }, [channel.port2]);
    } catch (error) {
      window.clearTimeout(timeout);
      channel.port1.close?.();
      reject(error);
    }
  });
}

async function repairDriverAppCache(button = null) {
  if (driverShellRepairRunning) return false;
  if (
    activeRest
    || photoInteractionActive()
    || activeForegroundEventIds.size
    || activeDriverMutationToken
    || offlineSyncing
    || savedRouteClearRunning
  ) {
    showToast(t("driver.pwaRepairFinishAction", "Finish the active rest, photo, stop action, synchronization, or route refresh before repairing the app cache."));
    return false;
  }
  driverShellRepairRunning = true;
  if (button?.isConnected) {
    button.disabled = true;
    button.textContent = t("driver.pwaRepairingCache", "Repairing Driver app cache…");
  }
  if (driverPwaUpdateRequired) renderDriverPwaUpdateRequired();
  else renderOfflineStatus();
  try {
    const networkResponse = await fetch(`/api/driver/network-health?cacheRepair=${encodeURIComponent(Date.now())}`, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin", // secret-scan: allow -- Fetch credential mode, not a credential value.
      headers: { "Cache-Control": "no-store" }
    }).catch(() => null);
    if (!networkResponse?.ok) {
      showToast(t("driver.pwaRepairConnectFirst", "Connect to the internet before repairing the Driver app cache."));
      return false;
    }
    const confirmed = window.confirm(t(
      "driver.pwaRepairConfirm",
      "Repair only the MBBS Driver app cache? Your saved route, photos, pending submissions, and login state will be preserved. Other MBBS app caches will not be changed."
    ));
    if (!confirmed) return false;
    if (!("serviceWorker" in navigator)) {
      throw new Error(t("driver.pwaRepairUnsupported", "This browser cannot safely repair the Driver app cache."));
    }
    const registration = driverServiceWorkerRegistration
      || await navigator.serviceWorker.getRegistration("/driver");
    if (!registration) {
      throw new Error(t("driver.pwaRepairWorkerMissing", "The Driver app worker is not installed. Reload while online, then retry."));
    }
    await registration.update();
    const pendingWorker = registration.installing || registration.waiting;
    if (registration.waiting) registration.waiting.postMessage({ type: "SKIP_WAITING" });
    if (pendingWorker) await waitForDriverWorkerActivation(pendingWorker);
    const readyRegistration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => window.setTimeout(
        () => reject(new Error(t("driver.pwaRepairWorkerTimeout", "The updated Driver app did not become ready in time."))),
        DRIVER_PWA_REPAIR_TIMEOUT_MS
      ))
    ]);
    const worker = registration.active
      || readyRegistration?.active
      || navigator.serviceWorker.controller;
    if (!worker) {
      throw new Error(t("driver.pwaRepairWorkerMissing", "The Driver app worker is not installed. Reload while online, then retry."));
    }
    await requestDriverShellRepair(worker);
    showToast(t("driver.pwaRepairComplete", "Driver app cache repaired. Reloading…"));
    window.location.replace(`/driver?cache-repair=${encodeURIComponent(Date.now())}`);
    return true;
  } catch (error) {
    showToast(tf(
      "driver.pwaRepairFailedDetail",
      "Driver app cache repair failed. Your offline data was not cleared. {detail}",
      { detail: localizeMessage(error.message || "") }
    ));
    return false;
  } finally {
    driverShellRepairRunning = false;
    if (driverPwaUpdateRequired) renderDriverPwaUpdateRequired();
    else renderOfflineStatus();
  }
}

function staffHomeRoute(role) {
  const clean = String(role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (clean === "admin") return "/admin";
  if (clean === "dispatcher") return "/dispatch";
  if (clean === "scm" || clean === "scm_staff") return "/scm";
  if (clean === "yard_manager") return "/control";
  if (clean === "operator") return "/operator";
  return "/";
}

async function redirectExistingStaffSession() {
  const staffToken = localStorage.getItem(STAFF_TOKEN_KEY) || "";
  if (!staffToken) return false;
  const response = await fetch("/api/auth/me", {
    headers: { Authorization: `Bearer ${staffToken}` }
  }).catch(() => null);
  if (!response?.ok) {
    localStorage.removeItem(STAFF_TOKEN_KEY);
    localStorage.removeItem(STAFF_ROLE_KEY);
    localStorage.removeItem(STAFF_ROLES_KEY);
    return false;
  }
  const payload = await response.json();
  if (payload.operator?.role) localStorage.setItem(STAFF_ROLE_KEY, payload.operator.role);
  localStorage.setItem(STAFF_ROLES_KEY, JSON.stringify([...new Set([...(Array.isArray(payload.operator?.roles) ? payload.operator.roles : []), payload.operator?.role].filter(Boolean))]));
  if (window.DriverOfflineDB) await window.DriverOfflineDB.lockActivePartition().catch(() => {});
  window.location.replace(staffHomeRoute(payload.operator?.role));
  return true;
}

function cameraFacingLabel() {
  return cameraFacingMode === "user"
    ? t("common.frontCamera", "Front")
    : t("common.backCamera", "Back");
}

function cameraCaptureMode() {
  return cameraFacingMode === "user" ? "user" : "environment";
}

function switchCameraFacing() {
  cameraFacingMode = cameraFacingMode === "environment" ? "user" : "environment";
  localStorage.setItem(CAMERA_FACING_KEY, cameraFacingMode);
}

function renderCameraSwitchButton() {
  return `<button class="secondary compact camera-mode-button" data-action="switch-camera" type="button">${t("common.switchCamera", "Switch camera")} (${cameraFacingLabel()})</button>`;
}

function localDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
}

function markDriverInteraction() {
  // Chromium can report online again immediately after an offline shell
  // reload. Persist the trustworthy pre-reload signal during any offline
  // interaction so GPS remains suppressed after that navigation.
  if (!navigator.onLine) markDriverBrowserOffline();
  driverInteractionEpoch += 1;
  return driverInteractionEpoch;
}

function beginDriverMutation(action, button) {
  if (!DRIVER_MUTATION_ACTIONS.has(action)) return null;
  if (activeDriverMutationToken) return false;
  const token = {
    action,
    jobId: String(currentJob?.jobId || ""),
    button,
    buttonDisabled: Boolean(button?.disabled),
    buttonText: button?.textContent || ""
  };
  activeDriverMutationToken = token;
  if (button) button.disabled = true;
  return token;
}

function endDriverMutation(token) {
  if (!token || activeDriverMutationToken !== token) return;
  activeDriverMutationToken = null;
  if (token.button?.isConnected) {
    token.button.disabled = token.buttonDisabled;
    token.button.textContent = token.buttonText;
  }
}

function routeRefreshWasSuperseded(epoch) {
  if (epoch === driverInteractionEpoch) return false;
  quietSyncRefreshQueued = true;
  return true;
}

function beginPhotoCapture() {
  photoCaptureInProgress = true;
  clearTimeout(photoCaptureResetTimer);
  photoCaptureResetTimer = window.setTimeout(() => {
    photoCaptureResetTimer = null;
    photoCaptureInProgress = false;
  }, PHOTO_CAPTURE_TIMEOUT_MS);
}

function finishPhotoCapture() {
  clearTimeout(photoCaptureResetTimer);
  photoCaptureResetTimer = null;
  photoCaptureInProgress = false;
}

function photoInteractionActive() {
  return Boolean(
    photoCaptureInProgress
    || photoPromptOpen
    || dvirMode
    || (isDriverBinJob() && (driverBinDraftHasContent() || photos.some(Boolean)))
  );
}

function manifestJobFor(jobId, manifest = offlineManifest) {
  const id = String(jobId || "");
  if (!id || !manifest?.manifestId) return null;
  return (manifest.jobs || []).find((job) => String(job.jobId || "") === id) || null;
}

function isDriverBinJob(job = currentJob) {
  return Boolean(window.DriverBinUI?.isBinJob?.(job));
}

function hasProtectedDriverShell() {
  return Boolean(
    offlineShellReady
    || navigator.serviceWorker?.controller
    || driverServiceWorkerRegistration?.active
  );
}

function driverActionProtectionState() {
  if (driverPwaUpdateRequired) {
    return {
      ready: false,
      message: t("driver.actionGateUpdateRequired", "Close and reopen the Driver PWA to load the required update before recording another action.")
    };
  }
  const planExecution = driverPlanExecutionDecision(currentJob?.planDate || dayState?.planDate);
  if ((currentJob || dvirMode) && !planExecution.allowed) {
    return {
      ready: false,
      code: planExecution.code,
      message: planExecution.message
    };
  }
  if (navigator.onLine && !driverPwaVersionCheckComplete) {
    return {
      ready: false,
      message: t("driver.actionGateCheckingVersion", "Checking that this Driver PWA is the latest safe version. Actions will unlock automatically.")
    };
  }
  if (!driverOfflineModeKnown) {
    return {
      ready: false,
      message: t("driver.actionGateCheckingMode", "Checking whether Admin requires online-only or offline-capable operation.")
    };
  }
  if (!driverOfflineModeEnabled) {
    if (!navigator.onLine) {
      return {
        ready: false,
        message: t("driver.onlineOnlyConnectionRequired", "Admin has set this Driver PWA to online-only mode. Reconnect to record an action.")
      };
    }
    if (!driverIdentityValidated) {
      return {
        ready: false,
        message: t("driver.actionGateVerifyingDriver", "Verifying this Driver. Actions will unlock automatically.")
      };
    }
    if (
      isDriverBinJob(currentJob)
      && !window.DriverBinUI.clientVersionSatisfies(
        DRIVER_PWA_CLIENT_VERSION,
        currentJob.mbt?.minimumClientVersion
      )
    ) {
      return {
        ready: false,
        message: t("driver.binUpdateRequired", "Close and reopen the Driver PWA to load the version required for this BIN work order.")
      };
    }
    return { ready: true, message: "" };
  }
  if (!offlineStorageAvailable || !window.DriverOfflineDB) {
    return {
      ready: false,
      message: t("driver.actionGateStorageUnavailable", "Safe local recording is unavailable in this browser. Refresh or contact Dispatch before recording an action.")
    };
  }
  if (!driverIdentityValidated || !offlinePartition?.partitionKey) {
    return {
      ready: false,
      message: t("driver.actionGateVerifyingDriver", "Verifying this Driver and preparing secure local storage. Actions will unlock automatically.")
    };
  }
  if (!offlineShellReady && !hasProtectedDriverShell()) {
    return {
      ready: false,
      message: t("driver.actionGateSavingShell", "Saving the Driver app for offline reopening. Actions will unlock automatically when the app shell is protected.")
    };
  }
  if (!offlineManifest?.manifestId) {
    return {
      ready: false,
      message: t("driver.actionGateSavingRoute", "Saving the current route to this device. Actions will unlock automatically when this screen is protected.")
    };
  }
  if (!offlineManifest.complete) {
    return {
      ready: false,
      message: t("driver.actionGateDownloadingRoute", "Downloading and protecting the complete assigned route. Actions will unlock automatically when Offline ready appears.")
    };
  }
  if (routeManifestExpired()) {
    return {
      ready: false,
      message: t("driver.actionGateRouteExpired", "This saved route has expired. Reconnect and refresh before recording another action.")
    };
  }
  const activeDate = String(dayState?.planDate || currentJob?.planDate || "").slice(0, 10);
  if (activeDate && offlineManifest.planDate && activeDate !== offlineManifest.planDate) {
    return {
      ready: false,
      message: t("driver.actionGateSavingDate", "Saving the current route date to this device. Actions will unlock automatically when it is protected.")
    };
  }
  if (currentJob?.jobId) {
    if (
      isDriverBinJob(currentJob)
      && !window.DriverBinUI.clientVersionSatisfies(
        DRIVER_PWA_CLIENT_VERSION,
        currentJob.mbt?.minimumClientVersion
      )
    ) {
      return {
        ready: false,
        message: t("driver.binUpdateRequired", "Close and reopen the Driver PWA to load the version required for this BIN work order.")
      };
    }
    const savedJob = manifestJobFor(currentJob.jobId);
    if (!savedJob?.jobId || !savedJob.fingerprint || !savedJob.predecessorFingerprint) {
      return {
        ready: false,
        message: t("driver.actionGateSavingIdentity", "Protecting this stop's job ID and route fingerprints. Actions will unlock automatically.")
      };
    }
    const currentFingerprint = String(currentJob.fingerprint || "");
    const currentPredecessor = String(currentJob.predecessorFingerprint || "");
    const currentContentFingerprint = String(
      currentJob.contentFingerprint || currentJob.snapshotFingerprint || ""
    );
    const savedContentFingerprint = String(
      savedJob.contentFingerprint || savedJob.snapshotFingerprint || ""
    );
    if (
      (currentFingerprint && String(savedJob.fingerprint) !== currentFingerprint)
      || (currentPredecessor && String(savedJob.predecessorFingerprint) !== currentPredecessor)
      || (currentContentFingerprint && savedContentFingerprint !== currentContentFingerprint)
    ) {
      return {
        ready: false,
        message: t("driver.actionGateSavingLatestStop", "Saving the latest version of this stop to the device. Review it when actions unlock.")
      };
    }
  }
  return { ready: true, message: "" };
}

function routeProtectedControlAttributes() {
  return 'data-route-record-control="true"';
}

function renderDriverActionProtectionNotice(id = "driverRouteProtectionNotice") {
  if (activeView !== "job" || (!currentJob && !dvirMode && !activeRest)) return "";
  const protection = driverActionProtectionState();
  return `
    <div id="${escapeHtml(id)}" class="driver-action-protection" data-driver-action-protection-notice role="status" aria-live="polite" ${protection.ready ? "hidden" : ""}>
      <strong>${t("driver.actionGateTitle", "Preparing safe recording")}</strong>
      <span data-driver-action-protection-message>${escapeHtml(protection.message)}</span>
      <small>${t("driver.actionGateAvailableControls", "Maps, Refresh, History, Sync, language, and Logout remain available.")}</small>
    </div>
  `;
}

function applyDriverActionProtectionGate() {
  const protection = driverActionProtectionState();
  const notices = [...app.querySelectorAll("[data-driver-action-protection-notice]")];
  notices.forEach((notice) => {
    notice.hidden = protection.ready;
    const message = notice.querySelector("[data-driver-action-protection-message]");
    if (message) message.textContent = protection.message;
  });
  const descriptionId = notices[0]?.id || "driverRouteProtectionNotice";
  app.querySelectorAll("[data-route-record-control]").forEach((control) => {
    if (!protection.ready) {
      if (!control.disabled) control.dataset.routeProtectionDisabled = "true";
      control.disabled = true;
      control.setAttribute("aria-disabled", "true");
      control.setAttribute("aria-describedby", descriptionId);
      return;
    }
    if (control.dataset.routeProtectionDisabled === "true") {
      control.disabled = false;
      delete control.dataset.routeProtectionDisabled;
    }
    control.removeAttribute("aria-disabled");
    if (notices.some((notice) => control.getAttribute("aria-describedby") === notice.id)) {
      control.removeAttribute("aria-describedby");
    }
  });
  return protection.ready;
}

function withManifestJobIdentity(job, routeBootstrap = null) {
  if (!job?.jobId) return job || null;
  const manifestJob = manifestJobFor(job.jobId);
  return {
    ...job,
    fingerprint: job.fingerprint
      || routeBootstrap?.currentJobFingerprint
      || manifestJob?.fingerprint
      || "",
    predecessorFingerprint: job.predecessorFingerprint
      || routeBootstrap?.predecessorFingerprint
      || manifestJob?.predecessorFingerprint
      || "",
    contentFingerprint: job.contentFingerprint
      || job.snapshotFingerprint
      || routeBootstrap?.currentJobContentFingerprint
      || routeBootstrap?.contentFingerprint
      || manifestJob?.contentFingerprint
      || manifestJob?.snapshotFingerprint
      || ""
  };
}

function stableComparableValue(value) {
  if (Array.isArray(value)) return value.map(stableComparableValue);
  if (!value || typeof value !== "object") return value ?? null;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableComparableValue(value[key])]));
}

function comparableJobDetails(job = {}) {
  return stableComparableValue({
    jobId: job.jobId || "",
    planId: job.planId ?? null,
    planDate: job.planDate || "",
    driverLogin: job.driverLogin || "",
    truckId: job.truckId || "",
    truckPlate: job.truckPlate || "",
    fromTruckId: job.fromTruckId || "",
    fromTruckPlate: job.fromTruckPlate || "",
    nextTruckId: job.nextTruckId || "",
    nextTruckPlate: job.nextTruckPlate || "",
    parkingSpot: job.parkingSpot || "",
    switchYard: job.switchYard || "",
    loadId: job.loadId || "",
    loadName: job.loadName || "",
    stopId: job.stopId || "",
    stopType: job.stopType || "",
    location: job.location || "",
    pickupLocation: job.pickupLocation || "",
    dropLocation: job.dropLocation || "",
    address: job.address || "",
    dropAddress: job.dropAddress || "",
    fromLocation: job.fromLocation || "",
    fromJobLocation: job.fromJobLocation || "",
    fromAddress: job.fromAddress || "",
    toLocation: job.toLocation || "",
    toAddress: job.toAddress || "",
    toPickupLocation: job.toPickupLocation || "",
    destinationLocationId: job.destinationLocationId ?? null,
    lineRowIds: job.lineRowIds || [],
    physicalVisitJobIds: job.physicalVisitJobIds || [],
    physicalVisitStopIds: job.physicalVisitStopIds || [],
    consolidatedPhysicalVisit: job.consolidatedPhysicalVisit === true,
    windowStart: job.windowStart || "",
    windowEnd: job.windowEnd || "",
    instructions: job.instructions || "",
    orderRefs: job.orderRefs || [],
    orderTypes: job.orderTypes || [],
    dependencyPickupManifests: job.dependencyPickupManifests || [],
    deliveryInstructions: job.deliveryInstructions || { revision: 0, orders: [] },
    orders: job.orders || [],
    requiredPhotos: Number(job.requiredPhotos || 0),
    sequence: job.sequence || null
  });
}

const DRIVER_ROUTE_RECONCILIATION = Object.freeze({
  unchanged: "unchanged",
  localProgressPending: "local_progress_pending",
  localProgressReview: "local_progress_review",
  dispatchRouteChanged: "dispatch_route_changed",
  serverExecutionChanged: "server_execution_changed"
});
const DRIVER_LOCAL_COMPLETION_PENDING_STATUSES = new Set([
  "foreground_pending",
  "pending",
  "registered",
  "waiting_photos",
  "receipt_pending",
  "applying",
  "syncing"
]);
const DRIVER_LOCAL_COMPLETION_REVIEW_STATUSES = new Set([
  "review_required",
  "blocked",
  "resolution_pending"
]);
const DRIVER_CROSS_DEVICE_COMPLETION_STATUSES = new Set([
  "registered",
  "waiting_photos",
  "pending",
  "applying",
  "review_required",
  "blocked",
  "resolution_pending"
]);

function authoritativeJobIdentity(result = {}) {
  const job = result.job || null;
  const bootstrap = result.routeBootstrap || {};
  if (!job) return { job: null, fingerprint: "", predecessorFingerprint: "", contentFingerprint: "" };
  return {
    job,
    fingerprint: String(job.fingerprint || bootstrap.currentJobFingerprint || ""),
    predecessorFingerprint: String(job.predecessorFingerprint || bootstrap.predecessorFingerprint || ""),
    contentFingerprint: String(
      job.contentFingerprint
      || job.snapshotFingerprint
      || bootstrap.currentJobContentFingerprint
      || bootstrap.contentFingerprint
      || ""
    )
  };
}

function authoritativeJobChanged(previousJob, result = {}) {
  const authoritative = authoritativeJobIdentity(result);
  if (!previousJob && !authoritative.job) return false;
  if (!previousJob || !authoritative.job) return true;
  if (String(previousJob.jobId || "") !== String(authoritative.job.jobId || "")) return true;
  const previousFingerprint = String(previousJob.fingerprint || manifestJobFor(previousJob.jobId)?.fingerprint || "");
  if (previousFingerprint && authoritative.fingerprint && previousFingerprint !== authoritative.fingerprint) return true;
  const previousContent = String(
    previousJob.contentFingerprint
    || previousJob.snapshotFingerprint
    || manifestJobFor(previousJob.jobId)?.contentFingerprint
    || manifestJobFor(previousJob.jobId)?.snapshotFingerprint
    || ""
  );
  if (previousContent && authoritative.contentFingerprint) {
    return previousContent !== authoritative.contentFingerprint;
  }
  return JSON.stringify(comparableJobDetails(previousJob)) !== JSON.stringify(comparableJobDetails(authoritative.job));
}

function localCompletionReconciliationStatus(event) {
  if (event?.eventType !== "job_completed") return "";
  const status = String(event.status || "").toLowerCase();
  if (
    event.reviewRequired === true
    || event.blocked === true
    || DRIVER_LOCAL_COMPLETION_REVIEW_STATUSES.has(status)
  ) return DRIVER_ROUTE_RECONCILIATION.localProgressReview;
  if (DRIVER_LOCAL_COMPLETION_PENDING_STATUSES.has(status)) {
    return DRIVER_ROUTE_RECONCILIATION.localProgressPending;
  }
  return "";
}

function driverPhysicalVisitJobIds(job = {}) {
  const currentJobId = String(job?.jobId || "");
  const seen = new Set();
  const result = [];
  for (const value of job?.physicalVisitJobIds || []) {
    const jobId = String(value || "");
    if (!jobId || seen.has(jobId)) continue;
    seen.add(jobId);
    result.push(jobId);
  }
  if (currentJobId && !seen.has(currentJobId)) result.push(currentJobId);
  return result.length ? result : currentJobId ? [currentJobId] : [];
}

function driverEventPhysicalVisitJobIds(event, manifest = offlineManifest) {
  const eventJobId = String(event?.effectiveJobId || event?.jobId || "");
  const manifestJob = manifestJobFor(eventJobId, manifest);
  const declared = Array.isArray(event?.details?.physicalVisitJobIds)
    ? event.details.physicalVisitJobIds
    : [];
  return driverPhysicalVisitJobIds({
    ...(manifestJob || {}),
    jobId: eventJobId || manifestJob?.jobId || "",
    physicalVisitJobIds: declared.length ? declared : manifestJob?.physicalVisitJobIds
  });
}

function localCompletionBridge(previousJob, authoritativeJob, manifest, events = []) {
  const previousJobId = String(previousJob?.jobId || "");
  const authoritativeJobId = String(authoritativeJob?.jobId || "");
  const jobs = manifest?.jobs || [];
  if (!previousJobId || !authoritativeJobId || previousJobId === authoritativeJobId || !jobs.length) return "";
  const authoritativeIndex = jobs.findIndex((job) => String(job.jobId || "") === authoritativeJobId);
  const previousIndex = jobs.findIndex((job) => String(job.jobId || "") === previousJobId);
  if (authoritativeIndex < 0 || previousIndex <= authoritativeIndex || jobIsComplete(jobs[previousIndex])) return "";

  const completionsByJobId = new Map();
  for (const event of events || []) {
    const reconciliation = localCompletionReconciliationStatus(event);
    if (!reconciliation) continue;
    for (const eventJobId of driverEventPhysicalVisitJobIds(event, manifest)) {
      if (!completionsByJobId.has(eventJobId)) completionsByJobId.set(eventJobId, []);
      completionsByJobId.get(eventJobId).push(reconciliation);
    }
  }

  const authoritativeCompletionStatuses = completionsByJobId.get(authoritativeJobId) || [];
  if (!authoritativeCompletionStatuses.length) return "";
  let bridgeStatus = authoritativeCompletionStatuses.includes(DRIVER_ROUTE_RECONCILIATION.localProgressReview)
    ? DRIVER_ROUTE_RECONCILIATION.localProgressReview
    : DRIVER_ROUTE_RECONCILIATION.localProgressPending;
  for (const job of jobs.slice(authoritativeIndex + 1, previousIndex)) {
    if (jobIsComplete(job)) continue;
    const completionStatuses = completionsByJobId.get(String(job.jobId || "")) || [];
    if (!completionStatuses.length) return "";
    if (completionStatuses.includes(DRIVER_ROUTE_RECONCILIATION.localProgressReview)) {
      bridgeStatus = DRIVER_ROUTE_RECONCILIATION.localProgressReview;
    }
  }
  return bridgeStatus;
}

function classifyAuthoritativeRoute(previousJob, result = {}, {
  manifest = null,
  events = [],
  dispatchRouteChanged = false
} = {}) {
  if (dispatchRouteChanged) return DRIVER_ROUTE_RECONCILIATION.dispatchRouteChanged;
  if (!authoritativeJobChanged(previousJob, result)) return DRIVER_ROUTE_RECONCILIATION.unchanged;
  const bridge = localCompletionBridge(previousJob, authoritativeJobIdentity(result).job, manifest, events);
  return bridge || DRIVER_ROUTE_RECONCILIATION.serverExecutionChanged;
}

function crossDevicePendingCompletionMatchesJob(completion, job) {
  if (
    completion?.eventType !== "job_completed"
    || !DRIVER_CROSS_DEVICE_COMPLETION_STATUSES.has(String(completion.status || "").toLowerCase())
  ) return false;
  const completionJobId = String(completion.jobId || "");
  const expectedJobId = String(job?.jobId || "");
  if (!completionJobId || !expectedJobId || completionJobId !== expectedJobId) return false;
  const completionFingerprint = String(completion.jobFingerprint || "");
  const expectedFingerprint = String(job?.fingerprint || "");
  if (completionFingerprint && expectedFingerprint && completionFingerprint !== expectedFingerprint) return false;
  const completionPredecessor = String(completion.predecessorFingerprint || "");
  const expectedPredecessor = String(job?.predecessorFingerprint || "");
  return !completionPredecessor
    || !expectedPredecessor
    || completionPredecessor === expectedPredecessor;
}

function jobEventRequiresManifestIdentity(eventType) {
  return ["job_started", "job_completed", "truck_switched_physical"].includes(eventType);
}

function shouldRetryOfflineSyncError(error) {
  if (Array.isArray(error?.photoFailures) && error.photoFailures.length) {
    return error.photoFailures.some((failure) => failure?.retryable === true);
  }
  if (error?.isNetworkError || !navigator.onLine) return true;
  const status = Number(error?.status || 0);
  const code = String(error?.code || "");
  if (!status) {
    return !(
      code.startsWith("offline_event_identity_")
      || code.startsWith("driver_offline_event_")
      || code.startsWith("driver_offline_rest_")
    );
  }
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function quietSyncActive() {
  return quietSyncRunCount > 0;
}

function setQuietSyncBackgroundInert(inert) {
  for (const element of [app, offlineStatus, toast]) {
    if (element) element.inert = inert;
  }
  if (inert) app.setAttribute("aria-busy", "true");
  else app.removeAttribute("aria-busy");
}

function displayQuietSyncHold() {
  if (!syncHold || !quietSyncHoldLatched || !quietSyncActive()) return;
  const title = syncHold.querySelector("[data-driver-sync-title]");
  const message = syncHold.querySelector("[data-driver-sync-message]");
  if (title) title.textContent = t("driver.syncHoldTitle", "Syncing saved route");
  if (message) {
    message.textContent = t(
      "driver.syncHoldMessage",
      "The PWA is syncing. Please wait and keep this screen open."
    );
  }
  syncHold.hidden = false;
  document.body.classList.add("driver-sync-hold-active");
  syncHold.focus({ preventScroll: true });
}

function requestQuietSyncHold(token, { immediate = false } = {}) {
  if (!token || token.epoch !== quietSyncEpoch || !quietSyncActive()) return;
  quietSyncHoldLatched = true;
  if (!quietSyncRestoreFocus && document.activeElement instanceof HTMLElement) {
    quietSyncRestoreFocus = document.activeElement;
  }
  // Block another route action immediately. Only the visual transition is
  // delayed so a sub-140 ms no-op sync does not flash.
  setQuietSyncBackgroundInert(true);
  document.body.classList.add("driver-sync-input-locked");
  if (immediate) {
    clearTimeout(quietSyncHoldTimer);
    quietSyncHoldTimer = null;
    displayQuietSyncHold();
    return;
  }
  if (!quietSyncHoldTimer && syncHold?.hidden) {
    quietSyncHoldTimer = window.setTimeout(() => {
      quietSyncHoldTimer = null;
      displayQuietSyncHold();
    }, 140);
  }
}

function beginQuietSync({ holdScreen = false, immediate = false } = {}) {
  const token = { epoch: quietSyncEpoch };
  quietSyncRunCount += 1;
  if (liveRefreshTimer) {
    clearTimeout(liveRefreshTimer);
    liveRefreshTimer = null;
    quietSyncRefreshQueued = true;
  }
  if (holdScreen) requestQuietSyncHold(token, { immediate });
  return token;
}

function clearQuietSyncHold() {
  clearTimeout(quietSyncHoldTimer);
  quietSyncHoldTimer = null;
  quietSyncHoldLatched = false;
  if (syncHold) syncHold.hidden = true;
  setQuietSyncBackgroundInert(false);
  document.body.classList.remove("driver-sync-input-locked");
  document.body.classList.remove("driver-sync-hold-active");
  const restoreFocus = quietSyncRestoreFocus;
  quietSyncRestoreFocus = null;
  if (restoreFocus?.isConnected && !restoreFocus.closest("[inert]")) {
    restoreFocus.focus({ preventScroll: true });
  } else {
    app.querySelector("button:not([disabled]), input:not([disabled])")?.focus({ preventScroll: true });
  }
}

function endQuietSync(token) {
  if (!token || token.epoch !== quietSyncEpoch) return;
  quietSyncRunCount = Math.max(0, quietSyncRunCount - 1);
  if (quietSyncRunCount) return;
  clearQuietSyncHold();
}

function resetQuietSync() {
  quietSyncEpoch += 1;
  quietSyncRunCount = 0;
  quietSyncRefreshQueued = false;
  quietSyncEventIds.clear();
  clearQuietSyncHold();
}

function rememberQuietSyncEvents(events = []) {
  const cutoff = Date.now() - QUIET_SYNC_EVENT_TTL_MS;
  for (const [eventId, savedAt] of quietSyncEventIds) {
    if (savedAt < cutoff) quietSyncEventIds.delete(eventId);
  }
  const savedAt = Date.now();
  for (const event of events) {
    const eventId = String(event?.eventId || "");
    if (eventId) quietSyncEventIds.set(eventId, savedAt);
  }
  while (quietSyncEventIds.size > QUIET_SYNC_EVENT_LIMIT) {
    quietSyncEventIds.delete(quietSyncEventIds.keys().next().value);
  }
}

function isQuietSyncEcho(event = {}) {
  if (event.payload?.source !== "offline_sync") return false;
  const eventId = String(event.payload?.eventId || "");
  if (!eventId) return false;
  const savedAt = quietSyncEventIds.get(eventId);
  if (!savedAt) return false;
  if (savedAt < Date.now() - QUIET_SYNC_EVENT_TTL_MS) {
    quietSyncEventIds.delete(eventId);
    return false;
  }
  return true;
}

function photoValueUrl(value) {
  return window.DriverOfflinePhotos?.displayUrl(value) || String(value || "");
}

function currentPhotoDraftKey(kind = "job", suffix = "") {
  const manifestId = offlineManifest?.manifestId || "bootstrap";
  if (kind === "dvir") return `dvir:${manifestId}:${suffix || dvirMode || "pre"}`;
  return `job:${manifestId}:${currentJob?.jobId || "unknown"}`;
}

function currentDriverRemarkDraftKey() {
  const partitionKey = offlinePartition?.partitionKey || "";
  const jobId = currentJob?.jobId || "";
  const planDate = String(currentJob?.planDate || offlineManifest?.planDate || "").slice(0, 10);
  if (!partitionKey || !planDate || !jobId) return "";
  return `driverRemarkDraft::${partitionKey}::${planDate}::${jobId}`;
}

function normalizedDriverRemark(value = driverRemark) {
  return String(value || "").slice(0, DRIVER_REMARK_MAX_LENGTH).trim();
}

function persistDriverRemarkDraft(value = driverRemark) {
  const key = currentDriverRemarkDraftKey();
  if (!driverOfflineModeEnabled || !offlineStorageAvailable || !key || !window.DriverOfflineDB?.setMeta) return Promise.resolve();
  const remark = String(value || "").slice(0, DRIVER_REMARK_MAX_LENGTH);
  driverRemarkSavePromise = driverRemarkSavePromise
    .catch(() => {})
    .then(() => window.DriverOfflineDB.setMeta(key, remark ? { remark } : null));
  return driverRemarkSavePromise;
}

async function restoreDriverRemarkDraft() {
  driverRemark = "";
  const key = currentDriverRemarkDraftKey();
  const restoreEpoch = driverInteractionEpoch;
  if (!driverOfflineModeEnabled || !offlineStorageAvailable || !key || !window.DriverOfflineDB?.getMeta) return;
  const saved = await window.DriverOfflineDB.getMeta(key).catch(() => null);
  if (key !== currentDriverRemarkDraftKey() || restoreEpoch !== driverInteractionEpoch) return;
  driverRemark = String(saved?.remark || "").slice(0, DRIVER_REMARK_MAX_LENGTH);
}

function clearDriverRemarkDraft(key = currentDriverRemarkDraftKey()) {
  if (!driverOfflineModeEnabled || !offlineStorageAvailable || !key || !window.DriverOfflineDB?.setMeta) return Promise.resolve();
  driverRemarkSavePromise = driverRemarkSavePromise
    .catch(() => {})
    .then(() => window.DriverOfflineDB.setMeta(key, null));
  return driverRemarkSavePromise;
}

function currentDriverBinDraftKey(job = currentJob) {
  if (!isDriverBinJob(job)) return "";
  const partitionKey = offlinePartition?.partitionKey || "";
  const manifestId = offlineManifest?.manifestId || "";
  const jobId = job?.jobId || "";
  if (!partitionKey || !manifestId || !jobId) return "";
  return window.DriverBinUI.draftKey(partitionKey, manifestId, jobId);
}

function normalizedDriverBinDraft(job = currentJob, value = binDraft) {
  if (!isDriverBinJob(job)) return null;
  return window.DriverBinUI.normalizeDraft(job, value || window.DriverBinUI.createDraft(job));
}

function ensureDriverBinDraft(job = currentJob) {
  if (!isDriverBinJob(job)) {
    binDraft = null;
    return null;
  }
  binDraft = normalizedDriverBinDraft(job, binDraft);
  return binDraft;
}

function driverBinDraftHasContent(job = currentJob, value = binDraft) {
  if (!isDriverBinJob(job) || !value) return false;
  const draft = normalizedDriverBinDraft(job, value);
  return [
    ...Object.values(draft.scans || {}),
    ...Object.values(draft.notes || {}),
    ...Object.values(draft.signatures || {}).map((signature) => signature?.signedBy),
    ...Object.values(draft.receipt || {})
  ].some((entry) => String(entry || "").trim());
}

function persistDriverBinDraft(value = binDraft, job = currentJob) {
  const key = currentDriverBinDraftKey(job);
  if (!driverOfflineModeEnabled || !offlineStorageAvailable || !key || !window.DriverOfflineDB?.setMeta) return Promise.resolve();
  const draft = normalizedDriverBinDraft(job, value);
  binDraftSavePromise = binDraftSavePromise
    .catch(() => {})
    .then(() => window.DriverOfflineDB.setMeta(key, draft));
  return binDraftSavePromise;
}

async function restoreDriverBinDraft(job = currentJob) {
  if (!isDriverBinJob(job)) {
    binDraft = null;
    return;
  }
  const key = currentDriverBinDraftKey(job);
  const restoreEpoch = driverInteractionEpoch;
  const expectedJobId = String(job?.jobId || "");
  binDraft = window.DriverBinUI.createDraft(job);
  if (!driverOfflineModeEnabled || !offlineStorageAvailable || !key || !window.DriverOfflineDB?.getMeta) return;
  const saved = await window.DriverOfflineDB.getMeta(key).catch(() => null);
  if (
    key !== currentDriverBinDraftKey()
    || expectedJobId !== String(currentJob?.jobId || "")
    || restoreEpoch !== driverInteractionEpoch
  ) return;
  binDraft = window.DriverBinUI.normalizeDraft(currentJob, saved || {});
}

function clearDriverBinDraft(key = currentDriverBinDraftKey()) {
  if (!driverOfflineModeEnabled || !offlineStorageAvailable || !key || !window.DriverOfflineDB?.setMeta) return Promise.resolve();
  binDraftSavePromise = binDraftSavePromise
    .catch(() => {})
    .then(() => window.DriverOfflineDB.setMeta(key, null));
  return binDraftSavePromise;
}

function routeManifestExpired() {
  return Boolean(offlineManifest?.expiresAt && Date.parse(offlineManifest.expiresAt) <= Date.now());
}

function canUseOfflineLedger() {
  const activeDate = String(dayState?.planDate || currentJob?.planDate || "").slice(0, 10);
  const manifestHasJob = !currentJob?.jobId
    || (offlineManifest?.jobs || []).some((job) => String(job.jobId) === String(currentJob.jobId));
  return Boolean(
    driverOfflineModeEnabled
    && offlineStorageAvailable
    && offlinePartition?.partitionKey
    && offlineManifest?.manifestId
    && driverIdentityValidated
    && (!activeDate || !offlineManifest.planDate || activeDate === offlineManifest.planDate)
    && manifestHasJob
    && !routeManifestExpired()
  );
}

function manifestPlanDate(value) {
  return String(value?.planDate || value?.date || value?.dayState?.planDate || "").slice(0, 10);
}

function manifestRevisionChanged(active, incoming) {
  if (!active || !incoming) return false;
  const activeDate = manifestPlanDate(active);
  const incomingDate = manifestPlanDate(incoming);
  if (!activeDate || !incomingDate || activeDate !== incomingDate) return false;
  const activePlanId = active.planId;
  const incomingPlanId = incoming.planId;
  const activeRevision = active.planRevision ?? active.revision;
  const incomingRevision = incoming.planRevision ?? incoming.revision;
  const activeRouteFingerprint = String(
    active.routeContentFingerprint
    || active.routeFingerprint
    || active.payload?.routeContentFingerprint
    || active.payload?.routeFingerprint
    || ""
  );
  const incomingRouteFingerprint = String(
    incoming.routeContentFingerprint
    || incoming.routeFingerprint
    || incoming.payload?.routeContentFingerprint
    || incoming.payload?.routeFingerprint
    || ""
  );
  return (
    activePlanId != null
    && incomingPlanId != null
    && String(activePlanId) !== String(incomingPlanId)
  ) || (
    activeRevision != null
    && incomingRevision != null
    && String(activeRevision) !== String(incomingRevision)
  ) || (
    activeRouteFingerprint
    && incomingRouteFingerprint
    && activeRouteFingerprint !== incomingRouteFingerprint
  );
}

async function shouldDeferIncomingManifest(incoming) {
  if (
    !offlineStorageAvailable
    || !offlinePartition?.partitionKey
    || !offlineManifest
    || !manifestRevisionChanged(offlineManifest, incoming)
  ) return false;
  const blocking = await window.DriverOfflineDB.getManifestBlockingState(
    offlinePartition.partitionKey,
    offlineManifest
  );
  return blocking.blocked;
}

async function refreshDeferredManifestState({ activateIfSafe = true } = {}) {
  if (!offlineStorageAvailable || !offlinePartition?.partitionKey) return false;
  offlineDeferredManifest = await window.DriverOfflineDB.getDeferredManifest(offlinePartition.partitionKey);
  if (!offlineDeferredManifest) {
    offlineManifestUpdateDeferred = false;
    return false;
  }
  const active = offlineManifest || await window.DriverOfflineDB.getActiveManifest(offlinePartition.partitionKey);
  const revisionChanged = manifestRevisionChanged(active, offlineDeferredManifest);
  const blocking = revisionChanged && active
    ? await window.DriverOfflineDB.getManifestBlockingState(offlinePartition.partitionKey, active)
    : { blocked: false };
  if (revisionChanged && blocking.blocked) {
    offlineManifestUpdateDeferred = true;
    renderOfflineStatus();
    return false;
  }
  if (!activateIfSafe) return false;
  offlineManifest = await window.DriverOfflineDB.activateManifest(
    offlinePartition.partitionKey,
    offlineDeferredManifest.manifestId
  );
  offlineDeferredManifest = null;
  offlineManifestUpdateDeferred = false;
  onlineRouteUpdatePending = false;
  renderOfflineStatus();
  return true;
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value || 0));
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function offlineRouteWarning() {
  if (!driverOfflineModeEnabled) return "";
  if (!offlineStorageAvailable || !driver) return "";
  if (onlineRouteUpdatePending) {
    return `<div class="offline-route-warning offline-route-expired">${t("driver.routeUpdatedProtected", "Dispatch updated this route. Finish or close the current protected screen, then review the refreshed stop before continuing.")}</div>`;
  }
  if (offlineManifestUpdateDeferred) {
    return `<div class="offline-route-warning offline-route-expired">${t("driver.routeUpdateDeferred", "Dispatch changed this route while local records still need synchronization or review. The update is safely downloaded, but this saved route remains active until those records are resolved.")}</div>`;
  }
  if (routeManifestExpired()) {
    return `<div class="offline-route-warning offline-route-expired">${t("driver.routeExpiredReadOnly", "This saved route has expired and is read-only. Reconnect and sign in before recording more actions. Unsynchronized evidence is retained.")}</div>`;
  }
  if (!offlineManifest?.complete) {
    return `<div class="offline-route-warning">${t("driver.routePartialWarning", "Only already-downloaded stop information is protected. Keep this page online until “Offline ready” appears.")}</div>`;
  }
  return "";
}

function renderOfflineStatus() {
  if (!offlineStatus) return;
  if (driverPwaUpdateRequired) {
    offlineStatus.hidden = true;
    return;
  }
  if (!driver) {
    offlineStatus.hidden = true;
    return;
  }
  const health = offlineHealth || {};
  const pending = Number(health.pendingEventCount || 0);
  const review = Number(health.reviewRequiredCount || 0);
  if (!driverOfflineModeEnabled) {
    const retained = pending + review + Number(
      health.partitionUnsyncedPhotoCount ?? health.unsyncedPhotoCount ?? 0
    );
    const state = review ? "review"
      : retained && offlineSyncing ? "syncing"
        : retained ? "pending"
          : navigator.onLine ? "ready" : "error";
    const label = review
      ? t("driver.reviewRequired", "Review required")
      : retained && offlineSyncing
        ? t("driver.syncing", "Syncing retained evidence")
        : retained
          ? tf("driver.syncPendingCount", "Recovery sync · {count}", { count: retained })
          : navigator.onLine
            ? t("driver.onlineOnly", "Online only")
            : t("driver.connectionRequired", "Connection required");
    offlineStatus.hidden = false;
    offlineStatus.dataset.state = state;
    offlineStatus.innerHTML = `
      <button class="offline-status-button" data-offline-action="toggle" type="button" aria-expanded="${offlineStatusOpen ? "true" : "false"}">${escapeHtml(label)}</button>
      <section class="offline-status-panel" ${offlineStatusOpen ? "" : "hidden"}>
        <h2>${escapeHtml(label)}</h2>
        <p>${t("driver.onlineOnlyHelp", "Admin has disabled offline operation. New routes, actions, and photos are sent online and are not saved for offline use on this device.")}</p>
        ${retained ? `<div class="offline-route-warning">${t("driver.retainedEvidenceRecovery", "Evidence saved before online-only mode remains protected and will continue synchronizing while this PWA is open and online.")}</div>` : ""}
        ${offlineStatus.dataset.lastError ? `<div class="offline-route-warning offline-route-expired">${escapeHtml(localizeMessage(offlineStatus.dataset.lastError))}</div>` : ""}
        ${retained ? `<div class="offline-status-grid">
          <span>${t("driver.pendingEvents", "Pending events")}</span><strong>${pending}</strong>
          <span>${t("driver.unsyncedPhotos", "Unsynced photos")}</span><strong>${Number(health.unsyncedPhotoCount || 0)}</strong>
        </div>
        <div class="offline-status-actions">
          <button class="primary" data-offline-action="sync" ${offlineSyncing || !navigator.onLine ? "disabled" : ""} type="button">${t("driver.syncNow", "Sync now")}</button>
        </div>` : ""}
        <div class="offline-status-actions">
          <button class="secondary offline-repair-button" data-offline-action="repair-cache" ${driverShellRepairRunning || offlineSyncing || savedRouteClearRunning ? "disabled" : ""} type="button">${driverShellRepairRunning ? t("driver.pwaRepairingCache", "Repairing Driver app cache…") : t("driver.pwaRepairCache", "Repair Driver app cache")}</button>
        </div>
        <small>${t("driver.pwaRepairPreservesData", "Repairs only MBBS Driver app files. Saved routes, photos, pending submissions, login state, and other MBBS app data are preserved.")}</small>
      </section>
    `;
    applyDriverActionProtectionGate();
    return;
  }
  if (!offlineStorageAvailable) {
    offlineStatus.hidden = true;
    return;
  }
  const ready = Boolean(offlineManifest?.complete && hasProtectedDriverShell());
  const expired = routeManifestExpired();
  const lastError = offlineStatus.dataset.lastError || "";
  let state = "ready";
  let label = t("driver.offlineReady", "Offline ready");
  if (review) {
    state = "review";
    label = t("driver.reviewRequired", "Review required");
  } else if (expired) {
    state = "error";
    label = t("driver.offlineReadOnly", "Offline · Read-only");
  } else if (!navigator.onLine) {
    state = "pending";
    label = pending
      ? tf("driver.offlinePendingCount", "Offline · {count} pending", { count: pending })
      : t("driver.offline", "Offline");
  } else if (offlineSyncing) {
    state = "syncing";
    label = t("driver.syncing", "Syncing");
  } else if (pending) {
    state = lastError ? "error" : "pending";
    label = lastError
      ? tf("driver.syncIssuePendingCount", "Sync issue · {count} pending", { count: pending })
      : tf("driver.syncPendingCount", "Sync pending · {count}", { count: pending });
  } else if (offlineRouteDownloading || !ready || offlineManifestUpdateDeferred || onlineRouteUpdatePending) {
    state = "downloading";
    label = t("driver.downloadingRoute", "Downloading route");
  } else if (lastError) {
    state = "error";
    label = t("driver.syncIssue", "Sync issue");
  }
  const usage = Number(offlineStorageEstimate?.usage || 0);
  const quota = Number(offlineStorageEstimate?.quota || 0);
  const quotaPercent = quota ? Math.round((usage / quota) * 100) : 0;
  const warning = quotaPercent >= 80
    || Number(health.evidenceBytes || 0) >= 200 * 1024 * 1024
    || Number(health.unsyncedPhotoCount || 0) >= 80;
  const expiryText = offlineManifest?.expiresAt ? dateTimeText(offlineManifest.expiresAt) : "—";
  const lastSyncText = offlineSyncState?.lastSuccessAt
    ? dateTimeText(offlineSyncState.lastSuccessAt)
    : t("driver.never", "Never");
  const statusDescription = expired
    ? t("driver.offlineExpiredHelp", "This saved route has expired. Reconnect and sign in before recording more actions; retained evidence is still available.")
    : offlineManifestUpdateDeferred
      ? t("driver.offlineDeferredHelp", "A newer dispatch route is stored on this device. Your current cached route remains active until its local records synchronize or are reviewed.")
      : offlineManifest?.complete
        ? t("driver.offlineReadyHelp", "Your assigned day is stored on this device. Actions are saved here before synchronization.")
        : t("driver.offlineDownloadingHelp", "The full route is still downloading. Only already-downloaded information is protected.");
  offlineStatus.hidden = false;
  offlineStatus.dataset.state = state;
  offlineStatus.innerHTML = `
    <button class="offline-status-button" data-offline-action="toggle" type="button" aria-expanded="${offlineStatusOpen ? "true" : "false"}">${escapeHtml(label)}</button>
    <section class="offline-status-panel" ${offlineStatusOpen ? "" : "hidden"}>
      <h2>${escapeHtml(label)}</h2>
      <p>${statusDescription}</p>
      ${warning ? `<div class="offline-route-warning">${t("driver.storageGettingFull", "Storage is getting full. Synchronize soon before more required photos are blocked.")}</div>` : ""}
      ${lastError ? `<div class="offline-route-warning offline-route-expired">${escapeHtml(localizeMessage(lastError))}</div>` : ""}
      <div class="offline-status-grid">
        <span>${t("driver.pendingEvents", "Pending events")}</span><strong>${pending}</strong>
        <span>${t("driver.unsyncedPhotos", "Unsynced photos")}</span><strong>${Number(health.unsyncedPhotoCount || 0)}</strong>
        <span>${t("driver.offlineEvidence", "Offline evidence")}</span><strong>${formatBytes(health.evidenceBytes)}</strong>
        <span>${t("driver.browserStorage", "Browser storage")}</span><strong>${quota ? `${quotaPercent}% · ${formatBytes(usage)}` : t("driver.unavailable", "Unavailable")}</strong>
        <span>${t("driver.persistentStorage", "Persistent storage")}</span><strong>${offlineStoragePersistent ? t("driver.granted", "Granted") : t("driver.notGranted", "Not granted")}</strong>
        <span>${t("driver.lastSynchronized", "Last synchronized")}</span><strong>${escapeHtml(lastSyncText)}</strong>
        <span>${t("driver.routeExpires", "Route expires")}</span><strong>${escapeHtml(expiryText)}</strong>
      </div>
      <div class="offline-status-actions">
        <button class="primary" data-offline-action="sync" ${offlineSyncing ? "disabled" : ""} type="button">${lastError ? t("driver.retrySync", "Retry sync") : t("driver.syncNow", "Sync now")}</button>
        <button class="secondary" data-offline-action="persist" type="button">${t("driver.protectStorage", "Protect storage")}</button>
        <button class="secondary offline-repair-button" data-offline-action="repair-cache" ${driverShellRepairRunning || offlineSyncing || savedRouteClearRunning ? "disabled" : ""} type="button">${driverShellRepairRunning ? t("driver.pwaRepairingCache", "Repairing Driver app cache…") : t("driver.pwaRepairCache", "Repair Driver app cache")}</button>
        <button class="secondary danger-button offline-clear-button" data-offline-action="clear" ${offlineSyncing || savedRouteClearRunning || !navigator.onLine ? "disabled" : ""} type="button">${t("driver.clearSavedRoute", "Clear saved route")}</button>
      </div>
      <small>${t("driver.pwaRepairPreservesData", "Repairs only MBBS Driver app files. Saved routes, photos, pending submissions, login state, and other MBBS app data are preserved.")}</small>
    </section>
  `;
  applyDriverActionProtectionGate();
}

async function refreshOfflineHealth() {
  if (!offlineStorageAvailable || !offlinePartition?.partitionKey) return;
  try {
    offlineHealth = await window.DriverOfflineDB.getStorageHealth(offlinePartition.partitionKey);
    offlineSyncState = await window.DriverOfflineDB.getSyncState(offlinePartition.partitionKey);
    const retainedWorkCount = Number(offlineHealth.pendingEventCount || 0)
      + Number(offlineHealth.reviewRequiredCount || 0)
      + Number(offlineHealth.partitionUnsyncedPhotoCount ?? offlineHealth.unsyncedPhotoCount ?? 0);
    if (retainedWorkCount > 0 && (offlineRetainedClientError || offlineSyncState?.lastError)) {
      offlineStatus.dataset.lastError = String(
        offlineRetainedClientError?.message || offlineSyncState.lastError
      );
    } else if (retainedWorkCount === 0) {
      offlineRetainedClientError = null;
      offlineStatus.dataset.lastError = "";
    }
    if (navigator.storage?.estimate) offlineStorageEstimate = await navigator.storage.estimate();
    if (navigator.storage?.persisted) offlineStoragePersistent = await navigator.storage.persisted();
  } catch (error) {
    offlineStatus.dataset.lastError = error.message;
  }
  renderOfflineStatus();
}

function remainingRequiredPhotosAfterCandidate({ isDvir = false, index = 0 } = {}) {
  const currentJobId = String(currentJob?.jobId || "");
  const capturedJobPhotos = photos.filter(Boolean).length
    + (!isDvir && !photos[index] ? 1 : 0);
  let remaining = (offlineManifest?.jobs || []).reduce((total, job) => {
    if (jobIsComplete(job)) return total;
    const required = Math.max(0, Math.floor(Number(job?.requiredPhotos || 0)));
    if (!required) return total;
    if (String(job?.jobId || "") !== currentJobId) return total + required;
    return total + Math.max(0, required - Math.min(required, capturedJobPhotos));
  }, 0);
  if (isDvir) {
    const capturedDvirPhotos = dvirPhotos.filter(Boolean).length + (!dvirPhotos[index] ? 1 : 0);
    remaining += Math.max(0, 4 - Math.min(4, capturedDvirPhotos));
  }
  return remaining;
}

async function currentBrowserStorageEstimate() {
  let estimate = offlineStorageEstimate || {};
  if (navigator.storage?.estimate) {
    try {
      estimate = await navigator.storage.estimate();
      offlineStorageEstimate = estimate;
    } catch {
      // IndexedDB's independent 250 MB ledger remains authoritative when the
      // browser does not expose a usable origin estimate.
    }
  }
  return {
    usage: Math.max(0, Number(estimate?.usage || 0)),
    quota: Math.max(0, Number(estimate?.quota || 0))
  };
}

function selectOfflineCapturePolicy({ health, estimate, cacheStats, remainingPhotoCount, existingPhoto }) {
  return window.DriverOfflinePhotos.capturePolicyForPressure({
    retainedEvidenceBytes: Math.max(
      0,
      Number(health?.evidenceBytes || 0) - Number(existingPhoto?.byteSize || 0)
    ),
    remainingPhotoCount: remainingPhotoCount + 1,
    optionalCacheBytes: Number(cacheStats?.bytes || 0),
    browserUsageBytes: Number(estimate?.usage || 0),
    browserQuotaBytes: Number(estimate?.quota || 0),
    evidenceBudgetBytes: Number(health?.maxEvidenceBytes || 0)
      || window.DriverOfflineDB.MAX_EVIDENCE_BYTES
  });
}

async function prepareOfflinePhotoCapture({
  isDvir = false,
  index = 0,
  existingPhoto = null,
  evictOptional = true
} = {}) {
  const partitionKey = String(offlinePartition?.partitionKey || "");
  if (!driverOfflineModeEnabled || !offlineStorageAvailable || !partitionKey) {
    return { capturePolicy: {}, admission: {} };
  }
  const remainingPhotoCount = remainingRequiredPhotosAfterCandidate({ isDvir, index });
  let health = await window.DriverOfflineDB.getStorageHealth(partitionKey);
  let estimate = await currentBrowserStorageEstimate();
  let cacheStats = await window.DriverOfflineDB.getInstructionMediaCacheStats(partitionKey);
  let capturePolicy = selectOfflineCapturePolicy({
    health,
    estimate,
    cacheStats,
    remainingPhotoCount,
    existingPhoto
  });

  while (
    evictOptional
    && capturePolicy.optionalCacheEvictionBytes > 0
    && Number(cacheStats.bytes || 0) > 0
  ) {
    const eviction = await window.DriverOfflineDB.evictInstructionMediaForEvidence(
      partitionKey,
      { bytesToFree: capturePolicy.optionalCacheEvictionBytes }
    );
    if (!eviction.evictedBytes) break;
    [health, estimate, cacheStats] = await Promise.all([
      window.DriverOfflineDB.getStorageHealth(partitionKey),
      currentBrowserStorageEstimate(),
      window.DriverOfflineDB.getInstructionMediaCacheStats(partitionKey)
    ]);
    capturePolicy = selectOfflineCapturePolicy({
      health,
      estimate,
      cacheStats,
      remainingPhotoCount,
      existingPhoto
    });
  }

  if (!capturePolicy.allowed) {
    throw new Error(t(
      "driver.routePhotoHeadroomUnavailable",
      "There is not enough protected device storage for this photo and the remaining required route photos. Synchronize or reconnect before continuing."
    ));
  }
  const admission = {
    remainingPhotoCount,
    expectedBytesPerPhoto: capturePolicy.targetBytes,
    browserStorageEstimate: estimate,
    optionalCacheBytes: evictOptional ? 0 : Number(cacheStats.bytes || 0)
  };
  const decision = await window.DriverOfflineDB.canStorePhoto(
    partitionKey,
    capturePolicy.targetBytes,
    admission
  );
  if (!decision.allowed) throw new Error(decision.reason);
  return { capturePolicy, admission };
}

function launchPhotoPicker(input) {
  if (!input) return;
  // Keep this synchronous: mobile Safari requires the native file/camera
  // picker to open within the original user activation. Strict admission runs
  // after selection and before any evidence is persisted.
  beginPhotoCapture();
  input.click();
}

async function requestPersistentStorage({ userInitiated = false } = {}) {
  if (!navigator.storage?.persist) return false;
  try {
    offlineStoragePersistent = await navigator.storage.persist();
    await refreshOfflineHealth();
    if (userInitiated) {
      showToast(offlineStoragePersistent
        ? t("driver.persistentStorageGranted", "Persistent storage granted")
        : t("driver.persistentStorageDenied", "The browser did not grant persistent storage."));
    }
    return offlineStoragePersistent;
  } catch (error) {
    if (userInitiated) showToast(error.message);
    return false;
  }
}

async function clearSavedRouteCache() {
  if (savedRouteClearRunning) return false;
  if (!driver || !authToken || !offlineStorageAvailable || !offlinePartition?.partitionKey) {
    showToast(t("driver.clearRouteSignInOnline", "Sign in online before clearing the saved route."));
    return false;
  }
  if (!navigator.onLine) {
    showToast(t("driver.clearRouteConnectFirst", "Connect to the internet before clearing the saved route."));
    return false;
  }
  if (activeRest || photoInteractionActive() || activeForegroundEventIds.size) {
    showToast(t("driver.clearRouteFinishAction", "Finish the active rest, photo, or stop action before clearing the saved route."));
    return false;
  }
  const confirmed = window.confirm(
    t("driver.clearRouteConfirm", "Clear and redownload this Driver's saved route? Synchronized records will be removed from this browser. Unsynchronized evidence will never be deleted.")
  );
  if (!confirmed) return false;
  savedRouteClearRunning = true;
  stopOnlineRouteRevalidation();
  renderOfflineStatus();
  const partitionKey = offlinePartition.partitionKey;
  const clearContext = captureQuietSyncContext();
  try {
    const syncResult = await triggerOfflineSync({ userInitiated: true });
    if (!syncResult?.ok && syncResult?.error) throw syncResult.error;
    if (syncResult?.retainedError) throw syncResult.retainedError;
    if (syncResult?.reviewRequired) {
      throw Object.assign(
        new Error(t("driver.clearRouteReviewRequired", "Saved work requires Dispatch review before clearing the saved route.")),
        { code: "driver_route_cache_review_required" }
      );
    }
    await assertQuietSyncContext(clearContext);
    if (onlineRouteValidationPromise) await onlineRouteValidationPromise;
    if (dayPlanDownloadPromise) await dayPlanDownloadPromise;
    await assertQuietSyncContext(clearContext);
    const health = await window.DriverOfflineDB.getStorageHealth(partitionKey);
    if (
      Number(health.pendingEventCount || 0) > 0
      || Number(health.reviewRequiredCount || 0) > 0
      || Number(health.partitionUnsyncedPhotoCount || 0) > 0
      || activeForegroundEventIds.size > 0
    ) {
      const persistedSyncState = await window.DriverOfflineDB.getSyncState(partitionKey)
        .catch(() => offlineSyncState || {});
      throw Object.assign(
        new Error(
          offlineRetainedClientError?.message
          || persistedSyncState?.lastError
          || t("driver.clearRoutePending", "Saved work is still pending. Synchronize or resolve it before clearing the saved route.")
        ),
        { code: "driver_route_cache_not_clearable" }
      );
    }
    const payload = await fetchDriverDayPlanPayload(
      dayState?.planDate || currentJob?.planDate || offlineManifest?.planDate,
      { forceRefresh: true }
    );
    await assertQuietSyncContext(clearContext);
    const saved = await window.DriverOfflineDB.replaceTerminalRouteCache(partitionKey, payload, {
      expectedSessionGeneration: clearContext?.sessionGeneration || ""
    });
    await assertQuietSyncContext(clearContext);
    offlineManifest = saved;
    offlineDeferredManifest = null;
    offlineManifestUpdateDeferred = false;
    onlineRouteUpdatePending = false;
    onlineRouteRevalidationQueued = false;
    onlineRouteLastValidatedAt = Date.now();
    offlineRetainedClientError = null;
    offlineStatus.dataset.lastError = "";
    await refreshOfflineHealth();
    navigator.serviceWorker?.controller?.postMessage({ type: "DRIVER_REFRESH_SHELL" });
    await loadNextJob();
    showToast(t("driver.savedRouteReloaded", "Saved route cleared and downloaded again"));
    return true;
  } catch (error) {
    if (error.code !== "driver_session_changed") {
      offlineStatus.dataset.lastError = error.message;
      renderOfflineStatus();
      showToast(error.message);
    }
    return false;
  } finally {
    savedRouteClearRunning = false;
    renderOfflineStatus();
    scheduleOnlineRouteRevalidation();
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  toast.textContent = localizeMessage(message);
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function planDateText(value) {
  const text = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return t("driver.planDateNotSet", "Plan date not set");
  return window.MBBS_I18N?.displayDate(text) || t("driver.planDateNotSet", "Plan date not set");
}

function driverCompanyDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function driverPlanExecutionDecision(planDateValue, now = new Date()) {
  const planDate = String(planDateValue || "").slice(0, 10);
  const parsedPlanDate = /^\d{4}-\d{2}-\d{2}$/.test(planDate)
    ? new Date(`${planDate}T00:00:00.000Z`)
    : null;
  const valid = Number.isFinite(parsedPlanDate?.getTime())
    && parsedPlanDate.toISOString().slice(0, 10) === planDate;
  if (!valid) {
    return {
      allowed: false,
      code: "DRIVER_PLAN_DATE_INVALID",
      message: t("driver.planDateInvalid", "This route has no valid plan date. Refresh or contact Dispatch before recording work.")
    };
  }
  if (planDate > driverCompanyDate(now)) {
    return {
      allowed: false,
      code: "DRIVER_PLAN_NOT_STARTED",
      message: tf(
        "driver.planDateNotStarted",
        "This route is scheduled for {date}. You can review it now, but work cannot start before that date in Toronto.",
        { date: planDateText(planDate) }
      )
    };
  }
  return { allowed: true, code: "", message: "" };
}

function dateTimeText(value) {
  return window.MBBS_I18N?.displayDateTime(value) || "";
}

function mapsUrl(job) {
  const destination = job?.address || job?.toAddress || job?.location || "";
  if (!destination) return "";
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving&dir_action=navigate`;
}

function completeWaitSeconds(job) {
  if (!job?.startedAt) return 0;
  const startedAt = new Date(job.startedAt).getTime();
  if (!Number.isFinite(startedAt)) return 0;
  // A server/device clock skew must not turn the ten-second double-tap guard
  // into a permanent lockout. Server idempotency remains the durable guard.
  if (startedAt > Date.now()) return 0;
  const elapsed = Date.now() - startedAt;
  return Math.max(0, Math.ceil((COMPLETE_DELAY_MS - elapsed) / 1000));
}

function driverUsesSamsaraWorkflow() {
  if (typeof dayState?.samsaraEnabled === "boolean") return dayState.samsaraEnabled;
  if (typeof driver?.samsaraEnabled === "boolean") return driver.samsaraEnabled;
  return true;
}

function locationCheckApproved() {
  return locationCheck?.status === "ok"
    || locationCheck?.status === "not_checked_offline"
    || locationOverrideApproval.isAccepted(currentJob);
}

function offlineLocationCheckResult() {
  return {
    status: "not_checked_offline",
    locationStatus: "not_checked_offline",
    message: t("driver.locationOfflineMessage", "Location was not checked while offline.")
  };
}

function locationCheckBlocksConfirmation() {
  return !locationCheckApproved();
}

function canBeginJobConfirmation(job) {
  return job?.status === "in_progress" && completeWaitSeconds(job) <= 0 && !locationCheckBlocksConfirmation();
}

function canCompleteCurrentJob(job) {
  return canBeginJobConfirmation(job) && locationCheckApproved();
}

function clearCountdownTimer() {
  clearTimeout(countdownTimer);
  countdownTimer = null;
}

function clearRestTimer() {
  clearTimeout(restTimer);
  restTimer = null;
}

function driverRestMarker(rest) {
  if (!rest) return null;
  const restId = String(rest.restId || rest.id || "").trim();
  const startedAt = String(rest.startedAt || "").trim();
  return restId || startedAt ? { restId, startedAt } : null;
}

function sameDriverRest(left, right) {
  if (!left || !right) return false;
  if (left.restId && right.restId) return left.restId === right.restId;
  return Boolean(left.startedAt && right.startedAt && left.startedAt === right.startedAt);
}

function acceptDriverRestCandidate(rest) {
  const candidate = rest || null;
  if (!candidate) return null;
  const marker = driverRestMarker(candidate);
  if (sameDriverRest(marker, endedRestMarker)) return null;
  if (marker && endedRestMarker) endedRestMarker = null;
  return candidate;
}

function markDriverRestEnded(rest) {
  endedRestMarker = driverRestMarker(rest) || endedRestMarker;
  activeRest = null;
  clearRestTimer();
}

function elapsedSeconds(startedAt) {
  const start = new Date(startedAt || "").getTime();
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.floor((Date.now() - start) / 1000));
}

function durationClock(value) {
  const totalSeconds = Math.max(0, Math.floor(Number(value || 0)));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function dailyRestSeconds() {
  return Math.max(0, Number(restSummary?.completedSeconds || 0)) + elapsedSeconds(activeRest?.startedAt);
}

function updateRestTimerText() {
  const dailyTimer = app.querySelector("[data-rest-daily-timer]");
  const sessionTimer = app.querySelector("[data-rest-session-timer]");
  if (dailyTimer) dailyTimer.textContent = durationClock(dailyRestSeconds());
  if (sessionTimer) sessionTimer.textContent = durationClock(elapsedSeconds(activeRest?.startedAt));
}

function updateCountdownButtons(job) {
  if (!job || currentJob?.jobId !== job.jobId) return;
  const waitSeconds = completeWaitSeconds(job);
  app.querySelectorAll("[data-job-confirm]").forEach((button) => {
    const photosReady = button.dataset.photoRequired !== "true" || photos.filter(Boolean).length >= Number(job.requiredPhotos || 0);
    const binEvidenceReady = !isDriverBinJob(job) || driverBinEvidenceReady(job);
    const gpsReady = button.dataset.gpsGate === "complete"
      ? canCompleteCurrentJob(job)
      : canBeginJobConfirmation(job);
    button.disabled = waitSeconds > 0 || !gpsReady || !photosReady || !binEvidenceReady;
    button.textContent = waitSeconds > 0
      ? tf("driver.waitSeconds", "Wait {seconds}s", { seconds: waitSeconds })
      : button.dataset.readyLabel || t("driver.confirm", "Confirm");
  });
  applyDriverActionProtectionGate();
}

function scheduleCountdownRender(job) {
  clearCountdownTimer();
  if (!job || job.status !== "in_progress" || completeWaitSeconds(job) <= 0) return;
  countdownTimer = setTimeout(() => {
    updateCountdownButtons(job);
    if (currentJob?.jobId === job.jobId && completeWaitSeconds(job) > 0) scheduleCountdownRender(job);
  }, 1000);
}

function scheduleRestRender() {
  clearRestTimer();
  if (!activeRest?.startedAt) return;
  updateRestTimerText();
  restTimer = setTimeout(scheduleRestRender, 1000);
}

async function checkCurrentJobLocation({ render = true } = {}) {
  if (!currentJob?.jobId) return null;
  locationOverrideApproval.clear();
  const usingSavedOfflineBinRoute = isDriverBinJob(currentJob) && offlineCachedView;
  // An offline browser must never attempt a GPS/Samsara request. This guard is
  // deliberately independent of IndexedDB readiness: storage preparation and
  // location verification are separate concerns, and a temporarily unavailable
  // ledger is not permission to leak an online-only request.
  if (!navigator.onLine || browserOfflineObserved || usingSavedOfflineBinRoute) {
    locationCheck = offlineLocationCheckResult();
    if (render) renderJob();
    return locationCheck;
  }
  locationCheck = { status: "checking", message: t("driver.checkingGps", "Checking Samsara truck GPS against expected stop...") };
  if (render) renderJob();
  try {
    locationCheck = await request(`/api/driver/jobs/${encodeURIComponent(currentJob.jobId)}/location-check`, {
      method: "POST",
      body: JSON.stringify({})
    });
  } catch (error) {
    if (canUseOfflineLedger() && await isGenuineNetworkFailure(error)) {
      locationCheck = {
        status: "not_checked_offline",
        locationStatus: "not_checked_offline",
        message: t("driver.locationOfflineMessage", "Location was not checked while offline.")
      };
    } else {
      locationCheck = {
        status: "unavailable",
        message: localizeMessage(error.message || t("driver.gpsUnavailable", "Samsara truck GPS could not be checked."))
      };
    }
  }
  if (render) renderJob();
  return locationCheck;
}

async function ensureLocationApprovalBeforeConfirmation() {
  if (!currentJob || completeWaitSeconds(currentJob) > 0) return false;
  if (!locationCheck && !locationOverrideApproval.isAccepted(currentJob)) await checkCurrentJobLocation();
  if (locationCheckApproved()) return true;
  showToast(t("driver.verifyLocationBeforePhotos", "Verify the Samsara GPS location or confirm override before adding photos."));
  renderJob();
  return false;
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      cache: options.cache || "no-store",
      ...options,
      signal: options.signal || driverRequestController.signal,
      headers: {
        "Content-Type": "application/json",
        [DRIVER_PWA_VERSION_HEADER]: DRIVER_PWA_CLIENT_VERSION,
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...(offlineDeviceId ? { "X-MBBS-Driver-Device": offlineDeviceId } : {}),
        ...(options.headers || {})
      }
    });
  } catch (error) {
    error.isNetworkError = true;
    throw error;
  }
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  applyDriverOfflineMode(data);
  const advertisedVersion = String(response.headers?.get?.("X-MBBS-Driver-Current-Version") || "");
  if (advertisedVersion && advertisedVersion !== DRIVER_PWA_CLIENT_VERSION) {
    requireDriverPwaUpdate({
      ...data,
      currentVersion: advertisedVersion,
      minimumVersion: response.headers?.get?.("X-MBBS-Driver-Minimum-Version") || data.minimumVersion,
      preserveLocalEvidence: true
    }, { reason: "response_header" });
    const error = new Error(data.error || t("driver.pwaMustReopen", "This Driver PWA must be closed and reopened before continuing."));
    error.data = data;
    error.status = 426;
    error.code = "DRIVER_PWA_UPDATE_REQUIRED";
    throw error;
  }
  if (!response.ok) {
    const error = new Error(data.error || text || t("common.requestFailed", "Request failed"));
    error.data = data;
    error.status = response.status;
    error.code = String(data.code || "");
    if (response.status === 426 || error.code === "DRIVER_PWA_UPDATE_REQUIRED") {
      requireDriverPwaUpdate(data, { reason: "api_426" });
    }
    throw error;
  }
  return data;
}

function driverRoutePresenceSnapshot() {
  const health = offlineHealth || {};
  const pendingEventCount = Math.max(0, Number(health.pendingEventCount || 0))
    + Math.max(0, Number(health.reviewRequiredCount || 0));
  const pendingPhotoCount = Math.max(0, Number(
    health.partitionUnsyncedPhotoCount ?? health.unsyncedPhotoCount ?? 0
  ));
  const activeJobId = activeRest
    ? `rest:${String(activeRest.restId || activeRest.id || "active")}`
    : currentJob?.status === "in_progress" || photoInteractionActive() || activeDriverMutationToken
      ? String(currentJob?.jobId || "driver-action-active")
      : "";
  const syncState = Number(health.reviewRequiredCount || 0) > 0
    ? "review"
    : pendingEventCount > 0 || pendingPhotoCount > 0 || offlineSyncing
      ? "pending"
      : offlineManifest?.complete
        ? "clean"
        : "unknown";
  return {
    visible: document.visibilityState === "visible",
    manifestId: offlineManifest?.manifestId || null,
    syncState,
    pendingEventCount,
    pendingPhotoCount,
    activeJobId
  };
}

function driverRouteChangeLocalReadiness(routeRequest = {}) {
  if (!navigator.onLine) return { ready: false, message: t("driver.routeReadinessReconnect", "Reconnect before confirming route readiness.") };
  if (document.visibilityState !== "visible") return { ready: false, message: t("driver.routeReadinessKeepVisible", "Keep this Driver screen open and visible.") };
  const snapshot = driverRoutePresenceSnapshot();
  if (!offlineManifest?.manifestId || routeRequest.manifestId !== offlineManifest.manifestId) {
    return { ready: false, message: t("driver.routeReadinessDownload", "Download the current saved route before confirming.") };
  }
  if (snapshot.syncState !== "clean" || snapshot.pendingEventCount || snapshot.pendingPhotoCount) {
    return { ready: false, message: t("driver.routeReadinessSyncFirst", "Finish synchronizing all events and photos first.") };
  }
  if (snapshot.activeJobId) return { ready: false, message: t("driver.routeReadinessFinishAction", "Finish the active stop, rest, or photo action first.") };
  return { ready: true, message: t("driver.routeReadinessReady", "This device is synchronized and idle.") };
}

function driverRoutePushCanBeEnabled() {
  return driverRoutePushAvailable !== false
    && "serviceWorker" in navigator
    && "PushManager" in window
    && typeof Notification !== "undefined"
    && Notification.permission !== "denied"
    && Notification.permission !== "granted";
}

function renderDriverRouteChangeStatus() {
  if (!routeChangeStatus) return;
  if (!driver || !authToken || driverRouteChangeRequests.length === 0) {
    routeChangeStatus.hidden = true;
    routeChangeStatus.innerHTML = "";
    return;
  }
  const requestCards = driverRouteChangeRequests.map((routeRequest) => {
    const readiness = driverRouteChangeLocalReadiness(routeRequest);
    const readyUntil = Date.parse(routeRequest.readyExpiresAt || "");
    const alreadyReady = routeRequest.deviceState === "ready"
      && Number.isFinite(readyUntil)
      && readyUntil > Date.now();
    return `
      <section class="driver-route-change-request">
        <p><strong>${escapeHtml(planDateText(routeRequest.planDate))}</strong> · ${t("driver.routeUpdatePending", "Route update pending")}</p>
        <p>${t("driver.routeUpdatePendingHelp", "No route has changed yet. SCM must re-preview and explicitly apply it after every affected Driver device is ready.")}</p>
        <p class="driver-route-change-reason">${escapeHtml(alreadyReady
          ? tf("driver.routeReadinessRecordedUntil", "Readiness recorded until {time}. Keep this screen visible while SCM applies.", { time: dateTimeText(routeRequest.readyExpiresAt) })
          : readiness.message)}</p>
        <div class="driver-route-change-actions">
          <button
            class="primary"
            data-action="acknowledge-driver-route-change"
            data-route-request-id="${escapeHtml(routeRequest.requestId)}"
            ${alreadyReady || !readiness.ready ? "disabled" : ""}
            type="button"
          >${alreadyReady ? t("driver.routeReadyRecorded", "Ready recorded") : t("driver.routeReadyAction", "I am ready for route update")}</button>
          <button data-action="refresh-driver-route-change" type="button">${t("driver.refreshStatus", "Refresh status")}</button>
        </div>
      </section>
    `;
  }).join("");
  routeChangeStatus.innerHTML = `
    <h2>${t("driver.routeUpdateNeedsAttention", "Route update needs attention")}</h2>
    <p>${t("driver.routeUpdateKeepOpen", "Do not close this Driver screen until SCM confirms the update is applied.")}</p>
    ${requestCards}
    ${driverRoutePushCanBeEnabled() ? `
      <button data-action="enable-driver-route-alerts" type="button">${t("driver.enableRouteAlerts", "Enable route alerts")}</button>
    ` : ""}
  `;
  routeChangeStatus.hidden = false;
}

async function sendDriverRoutePresence({ visible = document.visibilityState === "visible", keepalive = false } = {}) {
  if (!driver || !authToken || !offlineDeviceId || !navigator.onLine) return false;
  const payload = { ...driverRoutePresenceSnapshot(), visible: visible === true };
  try {
    const response = await fetch("/api/driver/route-presence", {
      method: "POST",
      cache: "no-store",
      keepalive,
      headers: {
        "Content-Type": "application/json",
        [DRIVER_PWA_VERSION_HEADER]: DRIVER_PWA_CLIENT_VERSION,
        Authorization: `Bearer ${authToken}`,
        "X-MBBS-Driver-Device": offlineDeviceId
      },
      body: JSON.stringify(payload)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function loadDriverRouteChangeRequests() {
  if (!driver || !authToken || !navigator.onLine) return driverRouteChangeRequests;
  try {
    const result = await request("/api/driver/route-change-requests");
    driverRouteChangeRequests = Array.isArray(result.requests) ? result.requests : [];
  } catch (error) {
    if (![401, 426].includes(Number(error.status || 0))) return driverRouteChangeRequests;
    driverRouteChangeRequests = [];
  }
  renderDriverRouteChangeStatus();
  return driverRouteChangeRequests;
}

async function refreshDriverRouteChangeState({ visible = document.visibilityState === "visible", keepalive = false } = {}) {
  if (driverRoutePresenceRunning || !driver || !authToken || !navigator.onLine) return false;
  driverRoutePresenceRunning = true;
  try {
    await sendDriverRoutePresence({ visible, keepalive });
    if (visible) await loadDriverRouteChangeRequests();
    return true;
  } finally {
    driverRoutePresenceRunning = false;
  }
}

function urlBase64Bytes(value) {
  const padding = "=".repeat((4 - String(value || "").length % 4) % 4);
  const base64 = `${String(value || "").replaceAll("-", "+").replaceAll("_", "/")}${padding}`;
  const decoded = atob(base64);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function enableDriverRouteAlerts(button) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") {
    driverRoutePushAvailable = false;
    renderDriverRouteChangeStatus();
    return showToast(t("driver.routeAlertsUnsupported", "Route alerts are not supported on this device."));
  }
  button.disabled = true;
  try {
    const settings = await request("/api/driver/route-push/public-key");
    driverRoutePushAvailable = settings.enabled === true;
    if (!settings.enabled || !settings.publicKey) throw new Error(t("driver.routeAlertsNotConfigured", "Route alerts are not configured on the server."));
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error(t("driver.routeAlertPermissionDenied", "Route alert permission was not granted."));
    const registration = driverServiceWorkerRegistration || await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription()
      || await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64Bytes(settings.publicKey)
      });
    await request("/api/driver/route-push/subscription", {
      method: "POST",
      body: JSON.stringify({ subscription: subscription.toJSON() })
    });
    showToast(t("driver.routeAlertsEnabled", "Route alerts enabled."));
  } catch (error) {
    showToast(error.message);
  } finally {
    renderDriverRouteChangeStatus();
  }
}

async function acknowledgeDriverRouteChangeRequest(requestId, button) {
  const routeRequest = driverRouteChangeRequests.find((entry) => entry.requestId === requestId);
  const readiness = driverRouteChangeLocalReadiness(routeRequest || {});
  if (!routeRequest || !readiness.ready) {
    renderDriverRouteChangeStatus();
    return showToast(readiness.message || t("driver.routeRequestUnavailable", "This route request is no longer available."));
  }
  button.disabled = true;
  try {
    if (!(await sendDriverRoutePresence({ visible: true }))) {
      throw new Error(t("driver.routeVisibleScreenUnverified", "The server could not verify this visible Driver screen."));
    }
    const result = await request(
      `/api/driver/route-change-requests/${encodeURIComponent(requestId)}/ready`,
      { method: "POST", body: "{}" }
    );
    showToast(localizeMessage(result.message || t("driver.routeReadinessRecorded", "Readiness recorded. SCM must re-preview and apply the change.")));
    await loadDriverRouteChangeRequests();
  } catch (error) {
    showToast(error.message);
    await loadDriverRouteChangeRequests().catch(() => {});
  } finally {
    renderDriverRouteChangeStatus();
  }
}

async function isGenuineNetworkFailure(error) {
  if (!navigator.onLine) return true;
  if (!error?.isNetworkError) return false;
  try {
    await fetch(`/api/driver/network-health?nonce=${encodeURIComponent(Date.now())}`, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin", // secret-scan: allow -- Fetch credential mode, not a credential value.
      headers: {
        "Cache-Control": "no-store",
        [DRIVER_PWA_VERSION_HEADER]: DRIVER_PWA_CLIENT_VERSION
      }
    });
    return false;
  } catch {
    return true;
  }
}

function dataUrlToFile(dataUrl, filename = "photo.jpg") {
  const [header, body] = String(dataUrl || "").split(",");
  const mime = header.match(/data:([^;]+)/)?.[1] || "image/jpeg";
  const binary = atob(body || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], filename, { type: mime });
}

async function uploadDriverPhoto(photo, context = {}) {
  if (!photo) return photo;
  if (typeof photo === "string" && photo.startsWith("r2://")) return photo;
  if (photo?.objectReference) return photo.objectReference;
  const ticket = await request("/api/driver/photo-upload-token", {
    method: "POST",
    body: JSON.stringify({
      ...context,
      ...(photo && typeof photo === "object" ? {
        manifestId: offlineManifest?.manifestId || undefined,
        photoId: photo.photoId,
        mimeType: photo.mimeType || "image/jpeg",
        byteSize: Number(photo.byteSize || photo.blob?.size || 0),
        sha256: photo.sha256
      } : {})
    })
  });
  const file = photo?.blob instanceof Blob
    ? new File([photo.blob], context.filename || `${context.recordType || "driver-photo"}.jpg`, { type: photo.mimeType || "image/jpeg" })
    : dataUrlToFile(photo, context.filename || `${context.recordType || "driver-photo"}.jpg`);
  const formData = new FormData();
  formData.append("file", file);
  let response;
  try {
    response = await fetch(ticket.uploadUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${ticket.token}` },
      body: formData
    });
  } catch (error) {
    error.isNetworkError = true;
    throw error;
  }
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) throw new Error(payload?.error || text || t("driver.photoUploadFailed", "Photo upload failed."));
  if (!payload?.key) throw new Error(t("driver.photoUploadMissingKey", "Photo upload did not return an R2 key."));
  const objectReference = `r2://${payload.key}`;
  if (photo && typeof photo === "object") {
    photo.objectReference = objectReference;
    if (photo.photoId && offlineStorageAvailable) {
      await window.DriverOfflineDB.markPhotoUploaded(photo.photoId, objectReference).catch(() => {});
    }
  }
  return objectReference;
}

async function uploadDriverPhotos(photoValues, context = {}) {
  const uploaded = [];
  for (let index = 0; index < photoValues.length; index += 1) {
    uploaded.push(await uploadDriverPhoto(photoValues[index], {
      ...context,
      filename: `${context.recordType || "driver-photo"}-${index + 1}.jpg`
    }));
  }
  return uploaded;
}

function onlineBinEventAttempt(job, eventType) {
  const key = `${String(job?.jobId || "")}::${eventType}`;
  let attempt = onlineBinEventAttempts.get(key);
  if (!attempt) {
    attempt = {
      key,
      eventId: window.DriverOfflineDB?.createUuid?.()
        || globalThis.crypto?.randomUUID?.(),
      clientSequence: Date.now()
    };
    onlineBinEventAttempts.set(key, attempt);
  }
  return attempt;
}

function finishOnlineBinEventAttempt(attempt) {
  if (attempt?.key) onlineBinEventAttempts.delete(attempt.key);
}

function onlineBinPhotoDescriptors(photoValues) {
  return (photoValues || []).filter(Boolean).map((photo, index) => ({
    photoId: String(photo.photoId || ""),
    ordinal: Number(photo.ordinal ?? index),
    objectReference: String(photo.objectReference || ""),
    sha256: String(photo.sha256 || ""),
    byteSize: Number(photo.byteSize || photo.blob?.size || 0),
    mimeType: String(photo.mimeType || photo.blob?.type || "image/jpeg")
  }));
}

async function clearLegacyDraftPhotos(photoValues) {
  for (const photo of photoValues || []) {
    if (photo?.photoId && offlineStorageAvailable) {
      await window.DriverOfflineDB.deleteDraftPhoto(photo.photoId).catch(() => {});
    }
    window.DriverOfflinePhotos?.revokePhoto(photo);
  }
  void refreshOfflineHealth();
}

function photoSrc(value) {
  if (value && typeof value === "object") return photoValueUrl(value);
  const text = String(value || "");
  if (!text.startsWith("r2://")) return text;
  return `/api/photo-upload/preview?ref=${encodeURIComponent(text)}&token=${encodeURIComponent(authToken || "")}`;
}

function photoImgSrc(value) {
  return escapeHtml(photoSrc(value));
}

function openPhotoLightbox(photoRef, label = "") {
  const ref = String(photoRef || "");
  if (!ref) return;
  const visibleLabel = label || t("driver.photoPreview", "Photo preview");
  document.querySelector(".photo-lightbox")?.remove();
  const modal = document.createElement("div");
  modal.className = "photo-lightbox";
  modal.innerHTML = `
    <div class="photo-lightbox-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(visibleLabel)}">
      <button class="photo-lightbox-close" type="button">×</button>
      <img src="${photoImgSrc(ref)}" alt="${escapeHtml(visibleLabel)}" />
    </div>
  `;
  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target.closest(".photo-lightbox-close")) modal.remove();
  });
  document.body.appendChild(modal);
}

function renderLogin(message = "") {
  if (renderDriverPwaUpdateRequired()) return;
  document.body.classList.remove("driver-pwa-update-active");
  if (offlineStatus) offlineStatus.hidden = true;
  if (routeChangeStatus) routeChangeStatus.hidden = true;
  app.innerHTML = `
    <section class="driver-shell">
      <div class="driver-language">${languageToggle()}</div>
      <div class="driver-content">
        <form class="login-panel" data-form="login">
          <div>
            <p>${t("app.driver", "MBBS Driver")}</p>
            <h1>${t("driver.loginTitle", "Driver Login")}</h1>
          </div>
          ${message ? `<div class="message">${escapeHtml(localizeMessage(message))}</div>` : ""}
          <label>
            <span>${t("common.login", "Login")}</span>
            <input id="driverLogin" autocomplete="username" required />
          </label>
          <label>
            <span>${t("common.password", "Password")}</span>
            <input id="driverPassword" type="password" autocomplete="current-password" />
          </label>
          <button class="primary" type="submit">${t("common.login", "Login")}</button>
        </form>
      </div>
    </section>
  `;
}

function clearDriverSessionMemory() {
  const partitionKey = offlinePartition?.partitionKey || "";
  instructionMediaPreparationGeneration += 1;
  instructionMediaPreparationKey = "";
  instructionMediaOnlineFallbackIds.clear();
  instructionTranslationPromise = null;
  instructionTranslationPromiseKey = "";
  instructionTranslationCache.clear();
  releaseInstructionMediaObjectUrls();
  activeDriverMutationToken = null;
  markDriverInteraction();
  finishPhotoCapture();
  resetQuietSync();
  if (partitionKey) {
    window.DriverOfflineSync?.cancelPartition?.(partitionKey);
    navigator.serviceWorker?.controller?.postMessage({
      type: "DRIVER_LOCK_PARTITION",
      partitionKey
    });
  }
  driverRequestController.abort();
  driverRequestController = new AbortController();
  window.DriverOfflinePhotos?.releaseAll();
  disconnectEvents();
  stopOnlineRouteRevalidation();
  clearCountdownTimer();
  clearRestTimer();
  authToken = "";
  driver = null;
  currentJob = null;
  dayState = null;
  photos = [];
  driverRemark = "";
  binDraft = null;
  dvirPhotos = [];
  dvirMode = "";
  photoPromptOpen = false;
  locationCheck = null;
  locationOverrideApproval.clear();
  activeRest = null;
  restSummary = null;
  endedRestMarker = null;
  offlinePartition = null;
  offlineManifest = null;
  offlineDeferredManifest = null;
  offlineManifestUpdateDeferred = false;
  offlineHealth = null;
  offlineSyncState = null;
  offlineRetainedClientError = null;
  offlineCachedView = false;
  onlineRouteValidationPromise = null;
  onlineRouteRevalidationQueued = false;
  onlineRouteLastValidatedAt = 0;
  onlineRouteUpdatePending = false;
  savedRouteClearRunning = false;
  pendingDvirEvent = null;
  pendingDvirPhotos = [];
  pendingDutyEvents = [];
  driverRouteChangeRequests = [];
  driverRoutePresenceRunning = false;
  if (routeChangeStatus) {
    routeChangeStatus.hidden = true;
    routeChangeStatus.innerHTML = "";
  }
  activeForegroundEventIds.clear();
  driverSessionInvalidated = true;
  driverIdentityValidated = false;
  driverIdentityValidationPromise = null;
}

function renderPendingSamsaraAttention() {
  if (!pendingDvirEvent && !pendingDutyEvents.length) return "";
  const dvirType = pendingDvirEvent?.details?.dvirType === "post"
    ? t("driver.postTrip", "post-trip")
    : t("driver.preTrip", "pre-trip");
  const pendingDutyText = pendingDutyEvents.length === 1
    ? tf("driver.samsaraDutyPendingOne", "{count} saved job start still needs a Samsara duty-state handoff.", { count: pendingDutyEvents.length })
    : tf("driver.samsaraDutyPendingMany", "{count} saved job starts still need a Samsara duty-state handoff.", { count: pendingDutyEvents.length });
  return `
    <section class="offline-samsara-pending">
      <div>
        <strong>${t("driver.pendingOnline", "Pending online")}</strong>
        ${pendingDvirEvent ? `<span>${tf("driver.samsaraInspectionPending", "Your saved {type} inspection still needs to be submitted to Samsara.", { type: dvirType })}</span>` : ""}
        ${pendingDutyEvents.length ? `<span>${pendingDutyText}</span>` : ""}
      </div>
      ${pendingDvirPhotos.length && authToken ? `
        <div class="offline-samsara-photo-strip">
          ${pendingDvirPhotos.map((photo, index) => {
            const reference = photo.objectReference || "";
            return reference ? `<img src="${photoImgSrc(reference)}" alt="${tf("driver.pendingDvirPhoto", "Pending DVIR photo {number}", { number: index + 1 })}" />` : "";
          }).join("")}
        </div>
      ` : ""}
      ${pendingDvirEvent ? `<button class="primary compact" data-action="reconcile-dvir" ${!authToken || !navigator.onLine ? "disabled" : ""} type="button">${t("driver.submitPendingSamsara", "Submit Pending to Samsara")}</button>` : ""}
    </section>
  `;
}

function shell(content) {
  if (renderDriverPwaUpdateRequired()) return;
  document.body.classList.remove("driver-pwa-update-active");
  if (driverSessionInvalidated) {
    renderLogin(t("driver.sessionChanged", "The Driver session changed. Sign in again to continue."));
    return;
  }
  const switchWarning = driverUsesSamsaraWorkflow() ? dayState?.truckSwitchAttention?.[0] : null;
  app.innerHTML = `
    <section class="driver-shell">
      <div class="driver-top-chrome" aria-hidden="true"></div>
      <button class="driver-logout-button" data-action="logout" type="button">${t("common.logout", "Logout")}</button>
      <div class="driver-language">${languageToggle()}</div>
      <div class="driver-content">
        ${switchWarning ? `<div class="truck-switch-attention"><strong>${t("driver.switchAttention", "Samsara truck assignment needs attention")}</strong><span>${escapeHtml(tf("driver.switchAttentionDetail", "{from} to {to}: {detail}", {
          from: switchWarning.fromTruckPlate || t("driver.previousTruck", "Previous truck"),
          to: switchWarning.toTruckPlate || t("driver.newTruck", "new truck"),
          detail: localizeMessage(switchWarning.error || t("driver.switchRetryHelp", "Reassignment failed. Retry the switch or contact dispatch."))
        }))}</span></div>` : ""}
        ${offlineRouteWarning()}
        ${activeRest || photoPromptOpen ? "" : renderDriverActionProtectionNotice()}
        ${renderPendingSamsaraAttention()}
        ${content}
      </div>
    </section>
    <div class="driver-bottom-chrome" aria-hidden="true"></div>
  `;
  renderOfflineStatus();
  applyDriverActionProtectionGate();
}

function truckSwitchAttentionForJob(job) {
  if (!driverUsesSamsaraWorkflow() || !job?.jobId || job.stopType !== "truck_switch") return null;
  return (dayState?.truckSwitchAttention || []).find((item) => item.jobId === job.jobId) || null;
}

function renderNoJob() {
  clearCountdownTimer();
  if (activeRest) scheduleRestRender();
  else clearRestTimer();
  shell(`
    <section class="empty-panel" data-driver-no-job>
      <h2>${t("driver.noJob", "No assigned job")}</h2>
      <p>${t("driver.noJobHelp", "No pending stop was found for your login in the confirmed dispatch plans.")}</p>
      <div class="empty-actions">
        <button class="primary" data-action="refresh" type="button">${t("common.refresh", "Refresh")}</button>
        <button class="secondary" data-action="open-history" type="button">${t("common.history", "History")}</button>
      </div>
    </section>
    ${activeRest ? renderRestModal() : ""}
  `);
}

function renderDvir(type = "pre", message = "") {
  clearCountdownTimer();
  const labels = [
    t("driver.driverSide", "Driver side"),
    t("driver.front", "Front"),
    t("driver.passengerSide", "Passenger side"),
    t("driver.back", "Back")
  ];
  dvirMode = type;
  while (dvirPhotos.length < 4) dvirPhotos.push("");
  const isPost = type === "post";
  const needsSamsaraRetry = false;
  shell(`
    <section class="job-panel dvir-panel">
      <div class="job-sticky">
        <div class="plan-meta-row">
          <span>${escapeHtml(planDateText(dayState?.planDate))}</span>
          <span>${escapeHtml(driver?.name || "-")}</span>
          <span>${escapeHtml(dayState?.truckPlate || "-")}</span>
        </div>
        <div class="job-head">
          <div class="job-title-row">
            <span class="job-type ${isPost ? "dropoff" : ""}">${isPost ? t("driver.postTrip", "Post-Trip") : t("driver.preTrip", "Pre-Trip")}</span>
            <h2>${escapeHtml(dayState?.truckPlate || t("driver.truckInspection", "Truck Inspection"))}</h2>
          </div>
        </div>
      </div>
      ${message ? `<div class="message">${escapeHtml(localizeMessage(message))}</div>` : ""}
      <div class="photo-grid dvir-photo-grid">
        ${dvirPhotos.map((photo, index) => {
          const label = labels[index] || tf("driver.additionalPhoto", "Additional photo {number}", { number: index - labels.length + 1 });
          return `
          <div class="photo-slot dvir-photo-slot">
            <input data-dvir-photo-index="${index}" data-photo-source="camera" ${routeProtectedControlAttributes()} type="file" accept="image/*" capture="${cameraCaptureMode()}" />
            <input data-dvir-photo-index="${index}" data-photo-source="gallery" ${routeProtectedControlAttributes()} type="file" accept="image/*" />
            <div class="photo-preview">${photo ? `<img src="${escapeHtml(photoValueUrl(photo))}" alt="${escapeHtml(label)}" />` : escapeHtml(label)}</div>
            <div class="photo-source-actions">
              <button data-action="take-dvir-photo" data-dvir-photo-index="${index}" ${routeProtectedControlAttributes()} type="button">${t("common.camera", "Camera")}</button>
              <button data-action="choose-dvir-gallery-photo" data-dvir-photo-index="${index}" ${routeProtectedControlAttributes()} type="button">${t("common.gallery", "Gallery")}</button>
            </div>
          </div>
        `;
        }).join("")}
      </div>
      <div class="photo-list-actions">
        <button class="secondary compact" data-action="add-dvir-photo" ${routeProtectedControlAttributes()} type="button">${t("common.addAnotherPhoto", "Add another photo")}</button>
        ${dvirPhotos.length > 4 ? `<button class="secondary compact danger-button" data-action="remove-dvir-photo" ${routeProtectedControlAttributes()} type="button">${t("common.removeLastPhoto", "Remove last photo")}</button>` : ""}
      </div>
      <div class="job-actions">
        <button class="primary" data-action="submit-dvir" ${routeProtectedControlAttributes()} ${dvirPhotos.filter(Boolean).length >= 4 ? "" : "disabled"} type="button">${isPost ? t("driver.submitPostTrip", "Submit Post-Trip") : t("driver.submitPreTrip", "Submit Pre-Trip")}</button>
        ${renderCameraSwitchButton()}
        <button class="secondary compact" data-action="skip-dvir" ${routeProtectedControlAttributes()} type="button">${t("driver.skipDvirTest", "Skip DVIR Test")}</button>
        <button class="secondary compact" data-action="refresh" type="button">${t("common.refresh", "Refresh")}</button>
        <button class="secondary compact" data-action="open-history" type="button">${t("common.history", "History")}</button>
      </div>
    </section>
  `);
}

function unitPills(units = []) {
  return (Array.isArray(units) ? units : []).map((unit) => {
    const label = unit?.unit || unit?.label || unit?.uom || t("driver.uom", "UOM");
    const value = unit?.value ?? unit?.quantity ?? 0;
    return `
      <span class="unit-pill ${unit?.fallback ? "fallback" : ""}">${Number(value || 0).toLocaleString()} ${escapeHtml(label)}</span>
    `;
  }).join("");
}

function renderOrders(job) {
  return (job.orders || []).map((order) => {
    const items = order.items || [];
    return `
    <section class="order-card">
      <div>
        <h3>${escapeHtml(order.orderRef)}</h3>
      </div>
      <div class="item-list">
        ${items.map((item) => `
          <div class="item-row">
            <div class="item-main-row">
              <strong>${escapeHtml(item.itemName || item.sku || t("driver.item", "Item"))}</strong>
              <div class="unit-row">${unitPills(item.units)}</div>
            </div>
            ${item.description ? `<span class="item-description">${escapeHtml(item.description)}</span>` : ""}
          </div>
        `).join("") || `<div class="item-row"><strong>${t("driver.noItemDetail", "No item detail found in local DB")}</strong></div>`}
      </div>
    </section>
  `;
  }).join("");
}

function deliveryInstructionImageEntries(job) {
  if (job?.stopType !== "dropoff") return [];
  const entries = [];
  const seen = new Set();
  for (const order of job?.deliveryInstructions?.orders || []) {
    for (const media of order?.media || []) {
      const mediaId = String(media?.id || "").trim().toLowerCase();
      if (!mediaId || seen.has(mediaId) || media?.mediaKind !== "image") continue;
      seen.add(mediaId);
      entries.push({ ...media, id: mediaId });
    }
  }
  return entries;
}

function nextDeliveryInstructionJob(job) {
  const jobs = Array.isArray(offlineManifest?.jobs) ? offlineManifest.jobs : [];
  if (!jobs.length || !job) return null;
  const currentIds = new Set([
    String(job.jobId || ""),
    ...(job.physicalVisitJobIds || []).map((value) => String(value || ""))
  ].filter(Boolean));
  let currentIndex = -1;
  jobs.forEach((candidate, index) => {
    if (currentIds.has(String(candidate?.jobId || ""))) currentIndex = Math.max(currentIndex, index);
  });
  return jobs.slice(currentIndex + 1).find((candidate) =>
    candidate?.stopType === "dropoff"
    && !jobIsComplete(candidate)
    && deliveryInstructionImageEntries(candidate).length
  ) || null;
}

function releaseInstructionMediaObjectUrls(retainedMediaIds = new Set()) {
  for (const [mediaId, cached] of instructionMediaObjectUrls) {
    if (retainedMediaIds.has(mediaId)) continue;
    if (cached?.url) URL.revokeObjectURL(cached.url);
    instructionMediaObjectUrls.delete(mediaId);
  }
}

function rememberInstructionMediaObjectUrl(media, blob, jobId) {
  const mediaId = String(media?.id || "").toLowerCase();
  if (!mediaId || !(blob instanceof Blob) || !blob.size) return "";
  const previous = instructionMediaObjectUrls.get(mediaId);
  if (previous?.url) URL.revokeObjectURL(previous.url);
  const url = URL.createObjectURL(blob);
  instructionMediaObjectUrls.set(mediaId, { url, jobId: String(jobId || "") });
  instructionMediaOnlineFallbackIds.delete(mediaId);
  return url;
}

function patchDriverInstructionMedia(media) {
  const mediaId = String(media?.id || "").toLowerCase();
  if (!mediaId) return;
  app.querySelectorAll("[data-instruction-media-id]").forEach((node) => {
    if (String(node.dataset.instructionMediaId || "").toLowerCase() === mediaId) {
      node.outerHTML = renderDeliveryInstructionMedia(media);
    }
  });
}

function instructionMediaContentPath(media) {
  return `/api/delivery-instruction-media/${encodeURIComponent(String(media?.id || ""))}/content`;
}

async function fetchDeliveryInstructionImage(media) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), DELIVERY_INSTRUCTION_IMAGE_TIMEOUT_MS);
  try {
    const response = await fetch(instructionMediaContentPath(media), {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin", // secret-scan: allow -- Fetch credential mode, not a credential value.
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${authToken}`,
        [DRIVER_PWA_VERSION_HEADER]: DRIVER_PWA_CLIENT_VERSION
      }
    });
    if (!response.ok) throw new Error(`Delivery-instruction image request failed (${response.status}).`);
    const mimeType = String(response.headers.get("content-type") || media?.mimeType || "").split(";")[0].trim().toLowerCase();
    if (!mimeType.startsWith("image/")) throw new Error("The delivery-instruction image response has an invalid media type.");
    const blob = await response.blob();
    const expectedSize = Number(media?.byteSize || 0);
    if (!blob.size || blob.size > 25 * 1024 * 1024 || (expectedSize > 0 && blob.size !== expectedSize)) {
      throw new Error("The delivery-instruction image response has an invalid size.");
    }
    return blob.type === mimeType ? blob : new Blob([blob], { type: mimeType });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Delivery-instruction image request timed out.");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function prepareDeliveryInstructionMedia(job, { force = false } = {}) {
  const partitionKey = String(offlinePartition?.partitionKey || "");
  const currentImages = deliveryInstructionImageEntries(job);
  const currentIds = new Set(currentImages.map((media) => String(media.id)));
  releaseInstructionMediaObjectUrls(currentIds);
  if (!partitionKey || !offlineStorageAvailable || !window.DriverOfflineDB || job?.stopType !== "dropoff") {
    instructionMediaPreparationKey = "";
    return;
  }
  const nextJob = nextDeliveryInstructionJob(job);
  const nextImages = deliveryInstructionImageEntries(nextJob);
  const preparationKey = JSON.stringify({
    partitionKey,
    online: navigator.onLine,
    currentJobId: job?.jobId || "",
    current: currentImages.map((media) => media.id),
    nextJobId: nextJob?.jobId || "",
    next: nextImages.map((media) => media.id)
  });
  if (!force && preparationKey === instructionMediaPreparationKey) return;
  instructionMediaPreparationKey = preparationKey;
  const generation = ++instructionMediaPreparationGeneration;
  await window.DriverOfflineDB.setInstructionMediaPriorities(partitionKey, {
    currentMediaIds: currentImages.map((media) => media.id),
    nextMediaIds: nextImages.map((media) => media.id)
  }).catch(() => {});

  const targets = [
    ...currentImages.map((media) => ({ media, targetJob: job, priority: 2, visible: true })),
    ...nextImages.map((media) => ({ media, targetJob: nextJob, priority: 1, visible: false }))
  ];
  for (const target of targets) {
    if (generation !== instructionMediaPreparationGeneration || partitionKey !== offlinePartition?.partitionKey) return;
    const mediaId = String(target.media.id);
    let cached = await window.DriverOfflineDB.getCachedInstructionMedia(partitionKey, mediaId).catch(() => null);
    if (cached?.blob instanceof Blob && cached.blob.size === Number(target.media.byteSize || cached.blob.size)) {
      if (target.visible && String(currentJob?.jobId || "") === String(job?.jobId || "")) {
        rememberInstructionMediaObjectUrl(target.media, cached.blob, job.jobId);
        patchDriverInstructionMedia(target.media);
      }
      continue;
    }
    if (!navigator.onLine || !authToken) continue;
    try {
      const blob = await fetchDeliveryInstructionImage(target.media);
      if (generation !== instructionMediaPreparationGeneration || partitionKey !== offlinePartition?.partitionKey) return;
      cached = await window.DriverOfflineDB.cacheInstructionMedia(partitionKey, {
        ...target.media,
        mediaId,
        jobId: target.targetJob?.jobId || "",
        priority: target.priority,
        byteSize: blob.size,
        blob
      }).catch(() => null);
      const visibleBlob = cached?.blob instanceof Blob ? cached.blob : blob;
      if (target.visible && String(currentJob?.jobId || "") === String(job?.jobId || "")) {
        rememberInstructionMediaObjectUrl(target.media, visibleBlob, job.jobId);
        patchDriverInstructionMedia(target.media);
      }
    } catch {
      if (target.visible && navigator.onLine && String(currentJob?.jobId || "") === String(job?.jobId || "")) {
        instructionMediaOnlineFallbackIds.add(mediaId);
        patchDriverInstructionMedia(target.media);
      }
    }
  }
}

function driverDeliveryInstructionMediaUrl(media) {
  const mediaId = String(media?.id || "").toLowerCase();
  const cached = instructionMediaObjectUrls.get(mediaId);
  if (cached?.url) return cached.url;
  if (!navigator.onLine) return "";
  const base = instructionMediaContentPath(media);
  const retryNonce = instructionMediaRetryNonces.get(mediaId);
  const query = `token=${encodeURIComponent(authToken || "")}${retryNonce ? `&retry=${encodeURIComponent(retryNonce)}` : ""}`;
  return `${base}${base.includes("?") ? "&" : "?"}${query}`;
}

function currentDeliveryInstructionMedia(mediaId) {
  const targetId = String(mediaId || "").toLowerCase();
  for (const order of currentJob?.deliveryInstructions?.orders || []) {
    const media = (order?.media || []).find((item) => String(item?.id || "").toLowerCase() === targetId);
    if (media) return media;
  }
  return null;
}

function renderDeliveryInstructionImageError(media) {
  const mediaId = escapeHtml(String(media?.id || ""));
  return `<article class="driver-instruction-media unavailable" data-instruction-media-id="${mediaId}"><strong>${t("driver.instructionImageFailed", "Image could not load")}</strong><span>${escapeHtml(media?.fileName || "")}</span><button class="secondary compact" data-action="retry-instruction-image" data-media-id="${mediaId}" type="button">${t("common.retry", "Retry")}</button></article>`;
}

function renderDeliveryInstructionMedia(media) {
  const url = driverDeliveryInstructionMediaUrl(media);
  const mediaId = escapeHtml(String(media?.id || ""));
  if (media.mediaKind === "video") {
    return navigator.onLine && url
      ? `<article class="driver-instruction-media" data-instruction-media-id="${mediaId}"><video controls preload="metadata" referrerpolicy="no-referrer" src="${escapeHtml(url)}"></video><span>${escapeHtml(media.fileName || t("driver.deliveryVideo", "Delivery video"))}</span></article>`
      : `<article class="driver-instruction-media unavailable" data-instruction-media-id="${mediaId}"><strong>${t("driver.instructionVideoOnline", "Video requires an internet connection")}</strong><span>${escapeHtml(media.fileName || "")}</span></article>`;
  }
  return url
    ? `<article class="driver-instruction-media" data-instruction-media-id="${mediaId}"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><img data-instruction-media-image loading="eager" src="${escapeHtml(url)}" alt="${escapeHtml(media.fileName || t("driver.deliveryImage", "Delivery instruction image"))}" /></a><span>${escapeHtml(media.fileName || "")}</span></article>`
    : navigator.onLine
      ? `<article class="driver-instruction-media loading" data-instruction-media-id="${mediaId}"><strong>${t("driver.instructionImageLoading", "Loading instruction image...")}</strong><span>${escapeHtml(media.fileName || "")}</span></article>`
      : `<article class="driver-instruction-media unavailable" data-instruction-media-id="${mediaId}"><strong>${t("driver.instructionImageUnavailable", "This image requires an internet connection")}</strong><span>${escapeHtml(media.fileName || "")}</span></article>`;
}

app.addEventListener("error", (event) => {
  const image = event.target?.closest?.("[data-instruction-media-image]");
  const card = image?.closest?.("[data-instruction-media-id]");
  if (!card) return;
  const media = currentDeliveryInstructionMedia(card.dataset.instructionMediaId);
  if (media) card.outerHTML = renderDeliveryInstructionImageError(media);
}, true);

function driverInstructionLanguage() {
  return window.MBBS_I18N?.language?.() === "zh-CN" ? "zh-CN" : "en";
}

function localizedDeliveryInstructionText(order, field) {
  const sourceText = String(order?.[field] || "");
  const language = driverInstructionLanguage();
  const localizedText = order?.localized?.language === language
    ? String(order.localized?.[field] || "")
    : "";
  return localizedText || sourceText;
}

function deliveryInstructionLocalizationKey(job, language = driverInstructionLanguage()) {
  if (!job?.jobId || job.stopType !== "dropoff") return "";
  const instructions = job.deliveryInstructions || { revision: 0, orders: [] };
  const content = (instructions.orders || []).map((order) => [
    order?.orderId || order?.orderRef || "",
    order?.automaticText || "",
    order?.additionalText || ""
  ]);
  return JSON.stringify([job.jobId, Number(instructions.revision || 0), language, content]);
}

function deliveryInstructionTranslationUnavailable(instructions = {}) {
  return (instructions.orders || []).some((order) =>
    [order?.localized?.automaticStatus, order?.localized?.additionalStatus].includes("unavailable")
  );
}

function applyCurrentDeliveryInstructionLocalization(jobId, instructions) {
  if (!currentJob || String(currentJob.jobId || "") !== String(jobId || "")) return false;
  currentJob = { ...currentJob, deliveryInstructions: instructions };
  const scrollContainer = app.querySelector(".driver-content");
  const scrollTop = Number(scrollContainer?.scrollTop || 0);
  const details = app.querySelector(".stop-detail-page");
  if (details && !photoInteractionActive()) details.outerHTML = renderStopDetails(currentJob);
  if (scrollContainer) scrollContainer.scrollTop = scrollTop;
  return true;
}

async function prepareCurrentDeliveryInstructionLanguage({ force = false, announce = false } = {}) {
  const language = driverInstructionLanguage();
  const jobId = String(currentJob?.jobId || "");
  const key = deliveryInstructionLocalizationKey(currentJob, language);
  if (!key || !navigator.onLine || !authToken) return false;
  if (
    !force
    && (currentJob.deliveryInstructions?.orders || []).every((order) => order?.localized?.language === language)
  ) return true;

  const cached = instructionTranslationCache.get(key);
  if (cached) {
    const applied = applyCurrentDeliveryInstructionLocalization(jobId, cached);
    if (applied && announce) showToast(t("driver.instructionTranslationReady", "Delivery instructions translated"));
    return applied;
  }
  if (instructionTranslationPromise && instructionTranslationPromiseKey === key) {
    return instructionTranslationPromise;
  }

  if (announce) showToast(t("driver.translatingInstructions", "Translating delivery instructions..."));
  const task = (async () => {
    try {
      const path = new URL(`/api/driver/jobs/${encodeURIComponent(jobId)}/delivery-instructions`, window.location.origin);
      path.searchParams.set("language", language);
      const result = await request(`${path.pathname}${path.search}`);
      if (deliveryInstructionLocalizationKey(currentJob, language) !== key) return false;
      const instructions = result.deliveryInstructions || { revision: 0, orders: [] };
      instructionTranslationCache.set(key, instructions);
      while (instructionTranslationCache.size > 50) {
        instructionTranslationCache.delete(instructionTranslationCache.keys().next().value);
      }
      if (!applyCurrentDeliveryInstructionLocalization(jobId, instructions)) return false;
      if (announce) {
        showToast(deliveryInstructionTranslationUnavailable(instructions)
          ? t("driver.instructionTranslationUnavailable", "Translation is unavailable; showing the original instructions.")
          : t("driver.instructionTranslationReady", "Delivery instructions translated"));
      }
      return true;
    } catch (error) {
      if (announce && String(currentJob?.jobId || "") === jobId) {
        showToast(t("driver.instructionTranslationUnavailable", "Translation is unavailable; showing the original instructions."));
      }
      return false;
    }
  })();
  instructionTranslationPromise = task;
  instructionTranslationPromiseKey = key;
  try {
    return await task;
  } finally {
    if (instructionTranslationPromise === task) {
      instructionTranslationPromise = null;
      instructionTranslationPromiseKey = "";
    }
  }
}

function renderDeliveryInstructionPage(job) {
  if (job.stopType !== "dropoff") return "";
  const instructions = job.deliveryInstructions || { revision: 0, orders: [] };
  const orders = Array.isArray(instructions.orders) ? instructions.orders : [];
  const hasContent = orders.some((order) =>
    String(order?.automaticText || "").trim()
    || String(order?.additionalText || "").trim()
    || (order?.media || []).length
  );
  return `<section class="driver-delivery-instruction-page">
    <div class="driver-instruction-heading"><div><span>${t("driver.dropoff", "Drop Off")}</span><h3>${t("driver.deliveryInstructions", "Delivery Instructions")}</h3></div><span>${orders.length} SO</span></div>
    ${hasContent ? orders.map((order) => {
      const media = Array.isArray(order.media) ? order.media : [];
      const phones = Array.isArray(order.phones) ? order.phones : [];
      const automaticText = localizedDeliveryInstructionText(order, "automaticText");
      const additionalText = localizedDeliveryInstructionText(order, "additionalText");
      const orderHasContent = automaticText.trim() || additionalText.trim() || media.length;
      return `<article class="driver-instruction-order">
        <div class="driver-instruction-order-head"><strong>${escapeHtml(order.orderRef || "Sales Order")}</strong>${order.customer ? `<span>${escapeHtml(order.customer)}</span>` : ""}</div>
        ${orderHasContent ? `
          ${automaticText ? `<p class="driver-delivery-instruction-text">${escapeHtml(automaticText)}</p>` : ""}
          ${phones.length ? `<div class="driver-instruction-phones">${phones.map((phone) => `<a href="tel:${escapeHtml(phone.href)}">☎ ${escapeHtml(phone.display)}</a>`).join("")}</div>` : ""}
          ${additionalText ? `<div class="driver-additional-instruction"><strong>${t("driver.additionalDeliveryText", "Additional instruction")}</strong><p class="driver-delivery-instruction-text">${escapeHtml(additionalText)}</p></div>` : ""}
          ${media.length ? `<div class="driver-instruction-gallery">${media.map(renderDeliveryInstructionMedia).join("")}</div>` : ""}
        ` : `<p class="driver-no-instructions">${t("driver.noDeliveryInstructions", "No delivery instructions")}</p>`}
      </article>`;
    }).join("") : `<div class="driver-no-instructions"><strong>${t("driver.noDeliveryInstructions", "No delivery instructions")}</strong></div>`}
  </section>`;
}

function renderStopDetails(job) {
  if (job.stopType !== "dropoff") return renderOrders(job);
  return `<div class="stop-detail-page">
    ${renderDeliveryInstructionPage(job)}
    ${renderOrders(job)}
  </div>`;
}

function renderLocationCheck(job) {
  if (!job || job.status !== "in_progress") return "";
  const overridden = locationOverrideApproval.isAccepted(job);
  const status = overridden ? "warning_overridden" : locationCheck?.status || "unavailable";
  const text = overridden
    ? t("driver.locationOverrideAccepted", "Location override accepted for this stop")
    : localizeMessage(locationCheck?.message || t("driver.gpsNotRun", "Samsara truck GPS check has not run yet."));
  const detail = locationCheck?.expectedAddress
    ? `<small>${t("driver.expected", "Expected")}: ${escapeHtml(locationCheck.expectedAddress)}</small>`
    : "";
  const truckDetail = locationCheck?.truckFormattedLocation
    ? `<small>${t("driver.truck", "Truck")}: ${escapeHtml(locationCheck.truckFormattedLocation)}</small>`
    : "";
  return `
    <section class="location-check ${escapeHtml(status)}">
      <div>
        <strong>${status === "ok" ? t("driver.locationVerified", "Location verified") : status === "warning_overridden" ? t("driver.locationOverrideAccepted", "Location override accepted for this stop") : status === "not_checked_offline" ? t("driver.locationNotCheckedOffline", "Location not checked offline") : status === "warning" ? t("driver.locationWarning", "Location warning") : status === "checking" ? t("driver.checkingLocation", "Checking location") : t("driver.locationNotVerified", "Location not verified")}</strong>
        <span>${escapeHtml(text)}</span>
        ${detail}
        ${truckDetail}
      </div>
      <div class="location-actions">
        ${status === "not_checked_offline" ? "" : `<button class="secondary compact" data-action="recheck-location" ${status === "checking" ? "disabled" : ""} type="button">${t("driver.recheck", "Recheck")}</button>`}
        ${["warning", "unavailable"].includes(status) && !overridden ? `<button class="primary compact location-override-button" data-action="override-location" type="button">${t("driver.overrideContinue", "Override & Continue")}</button>` : ""}
      </div>
    </section>
  `;
}

function binEvidenceLabel(requirement) {
  const code = String(requirement?.evidenceCode || "");
  const labels = {
    outgoing_bin_scan: t("driver.binOutgoingScan", "Outgoing BIN scan"),
    incoming_bin_scan: t("driver.binIncomingScan", "Incoming BIN scan"),
    expected_bin_scan: t("driver.binExpectedScan", "Assigned BIN scan"),
    placement_photo: t("driver.binPlacementPhoto", "Placement photo"),
    condition_photo: t("driver.binConditionPhoto", "Condition photo"),
    load_photo: t("driver.binLoadPhoto", "Load photo"),
    dump_receipt_photo: t("driver.binReceiptPhoto", "Dump receipt photo"),
    condition_note: t("driver.binConditionNote", "Condition note"),
    site_signature: t("driver.binSiteSignature", "Site signature")
  };
  if (labels[code]) return labels[code];
  return code
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || t("driver.binEvidence", "Required evidence");
}

function binAssetRoleLabel(role) {
  if (role === "outgoing") return t("driver.binOutgoingAsset", "Outgoing BIN");
  if (role === "incoming") return t("driver.binIncomingAsset", "Incoming BIN");
  return t("driver.binExpectedAsset", "Assigned BIN");
}

function driverBinActionLabel(job) {
  const action = String(job?.mbt?.serviceAction || job?.mbt?.actionCode || "").toLowerCase();
  const labels = {
    delivery: t("driver.binActionDelivery", "Delivery"),
    deliver_bin: t("driver.binActionDelivery", "Delivery"),
    pickup: t("driver.binActionPickup", "Pickup"),
    return_bin: t("driver.binActionPickup", "Pickup"),
    collect_empty_bin: t("driver.binActionCollectEmpty", "Collect empty BIN"),
    pickup_loaded_bin: t("driver.binActionCollectLoaded", "Collect loaded BIN"),
    exchange: t("driver.binActionExchange", "Exchange"),
    exchange_bin: t("driver.binActionExchange", "Exchange"),
    dump: t("driver.binActionDump", "Dump"),
    dump_bin: t("driver.binActionDump", "Dump")
  };
  return labels[action] || action.replaceAll("_", " ") || t("driver.binWorkOrder", "BIN work order");
}

function driverBinErrorMessage(error, job = currentJob) {
  const requirement = window.DriverBinUI?.requirements?.(job)
    .find(({ evidenceCode }) => evidenceCode === error?.evidenceCode);
  if (error?.code === "DRIVER_BIN_EVIDENCE_MISSING") {
    return tf("driver.binMissingEvidence", "Complete {evidence} before finishing this BIN stop.", {
      evidence: binEvidenceLabel(requirement || { evidenceCode: error.evidenceCode })
    });
  }
  if (["DRIVER_BIN_ASSET_MISMATCH", "DRIVER_BIN_ASSET_IDENTITY_MISSING"].includes(error?.code)) {
    return t("driver.binAssetMismatch", "The scanned BIN does not match the exact asset assigned to this visit.");
  }
  if (error?.code === "DRIVER_BIN_RECEIPT_TOTAL_MISMATCH") {
    return t("driver.binReceiptTotalMismatch", "Receipt total must equal subtotal plus tax.");
  }
  if (["DRIVER_BIN_RECEIPT_INCOMPLETE", "DRIVER_BIN_RECEIPT_IDENTITY_MISSING"].includes(error?.code)) {
    return t("driver.binReceiptIncomplete", "Complete the frozen dump site, material, ticket, weight or quantity, unit, amounts, and receipt photo.");
  }
  if (["DRIVER_BIN_RECEIPT_AMOUNT_INVALID", "DRIVER_BIN_RECEIPT_INVALID"].includes(error?.code)) {
    return t("driver.binReceiptAmountInvalid", "Enter each receipt amount with no more than two decimal places.");
  }
  return localizeMessage(error?.message || t("driver.binEvidenceInvalid", "Review the required BIN evidence."));
}

function driverBinEvidenceReady(job = currentJob) {
  if (!isDriverBinJob(job)) return true;
  try {
    window.DriverBinUI.buildCompletionDetails(job, ensureDriverBinDraft(job), photos);
    return true;
  } catch {
    return false;
  }
}

function updateDriverBinCompletionButton(job = currentJob) {
  if (!isDriverBinJob(job)) return;
  const button = app.querySelector("[data-driver-bin-complete]");
  if (!button) return;
  const ready = driverBinEvidenceReady(job) && canBeginJobConfirmation(job);
  button.disabled = !ready;
  button.setAttribute("aria-disabled", ready ? "false" : "true");
  applyDriverActionProtectionGate();
}

function renderDriverBinPhotoSlot(slot, requirement) {
  const photo = photos[slot.ordinal];
  const label = binEvidenceLabel(requirement);
  return `
    <div class="photo-slot driver-bin-photo-slot" data-bin-photo-slot="${escapeHtml(slot.evidenceCode)}">
      <input data-photo-index="${slot.ordinal}" data-photo-source="camera" data-bin-evidence-code="${escapeHtml(slot.evidenceCode)}" ${routeProtectedControlAttributes()} type="file" accept="image/*" capture="${cameraCaptureMode()}" />
      <input data-photo-index="${slot.ordinal}" data-photo-source="gallery" data-bin-evidence-code="${escapeHtml(slot.evidenceCode)}" ${routeProtectedControlAttributes()} type="file" accept="image/*" />
      <div class="photo-preview">${photo
        ? `<img src="${escapeHtml(photoValueUrl(photo))}" alt="${escapeHtml(label)}" />`
        : `<span>${escapeHtml(label)}${requirement.required ? " *" : ""}</span>`}
      </div>
      <div class="photo-source-actions">
        <button data-action="take-photo" data-photo-index="${slot.ordinal}" ${routeProtectedControlAttributes()} type="button">${t("common.camera", "Camera")}</button>
        <button data-action="choose-gallery-photo" data-photo-index="${slot.ordinal}" ${routeProtectedControlAttributes()} type="button">${t("common.gallery", "Gallery")}</button>
      </div>
    </div>
  `;
}

function renderDriverBinReceipt(job, requirements) {
  const receiptRequired = requirements.some(({ evidenceType }) => ["receipt", "weight", "quantity"].includes(evidenceType))
    || String(job.mbt?.actionCode || "").includes("dump");
  if (!receiptRequired) return "";
  const receipt = ensureDriverBinDraft(job).receipt;
  return `
    <section class="driver-bin-receipt">
      <div class="driver-bin-section-head">
        <div><span>${t("driver.binDumpEvidence", "Dump evidence")}</span><h3>${t("driver.binCompleteReceipt", "Complete dump receipt")}</h3></div>
        <span class="driver-bin-required-badge">${t("common.required", "Required")}</span>
      </div>
      <div class="driver-bin-frozen-grid">
        <div><span>${t("driver.binDumpSite", "Dump site")}</span><strong>${escapeHtml(job.mbt.dumpSite?.displayName || job.mbt.dumpSite?.code || job.mbt.dumpSiteId || "-")}</strong></div>
        <div><span>${t("driver.binMaterial", "Material")}</span><strong>${escapeHtml(job.mbt.material?.displayName || job.mbt.material?.code || job.mbt.materialId || "-")}</strong></div>
      </div>
      <div class="driver-bin-receipt-grid">
        <label><span>${t("driver.binReceiptTicket", "Ticket number")} *</span><input data-bin-receipt="ticketNumber" ${routeProtectedControlAttributes()} maxlength="200" value="${escapeHtml(receipt.ticketNumber)}" /></label>
        <label><span>${t("driver.binReceiptUom", "Unit of measure")} *</span><input data-bin-receipt="unitOfMeasure" ${routeProtectedControlAttributes()} maxlength="40" value="${escapeHtml(receipt.unitOfMeasure)}" placeholder="TONNE" /></label>
        <label><span>${t("driver.binReceiptWeight", "Weight")}</span><input data-bin-receipt="weight" ${routeProtectedControlAttributes()} inputmode="decimal" maxlength="80" value="${escapeHtml(receipt.weight)}" /></label>
        <label><span>${t("driver.binReceiptQuantity", "Quantity")}</span><input data-bin-receipt="quantity" ${routeProtectedControlAttributes()} inputmode="decimal" maxlength="80" value="${escapeHtml(receipt.quantity)}" /></label>
        <label><span>${t("driver.binReceiptSubtotal", "Subtotal")} *</span><input data-bin-receipt="subtotal" ${routeProtectedControlAttributes()} inputmode="decimal" maxlength="40" value="${escapeHtml(receipt.subtotal)}" placeholder="0.00" /></label>
        <label><span>${t("driver.binReceiptTax", "Tax")} *</span><input data-bin-receipt="tax" ${routeProtectedControlAttributes()} inputmode="decimal" maxlength="40" value="${escapeHtml(receipt.tax)}" placeholder="0.00" /></label>
        <label><span>${t("driver.binReceiptTotal", "Total CAD")} *</span><input data-bin-receipt="total" ${routeProtectedControlAttributes()} inputmode="decimal" maxlength="40" value="${escapeHtml(receipt.total)}" placeholder="0.00" /></label>
      </div>
      <small>${t("driver.binReceiptBalanceHelp", "Total must equal subtotal plus tax. Enter either weight or quantity.")}</small>
    </section>
  `;
}

function renderDriverBinEvidence(job) {
  const draft = ensureDriverBinDraft(job);
  const requirements = window.DriverBinUI.requirements(job);
  const slots = window.DriverBinUI.photoSlots(job);
  while (photos.length < slots.length) photos.push("");
  const photoRequirements = new Map(requirements.map((requirement) => [requirement.evidenceCode, requirement]));
  const scanFields = requirements.filter(({ evidenceType }) => evidenceType === "bin_scan").map((requirement) => {
    const asset = requirement.asset || {};
    return `
      <label class="driver-bin-scan-field">
        <span>${escapeHtml(binEvidenceLabel(requirement))}${requirement.required ? " *" : ""}</span>
        <input data-bin-scan="${escapeHtml(requirement.evidenceCode)}" ${routeProtectedControlAttributes()} autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="200" value="${escapeHtml(draft.scans[requirement.evidenceCode])}" placeholder="${t("driver.binScanPlaceholder", "Scan or enter the exact BIN code")}" />
        <small>${t("driver.binExpected", "Expected")}: ${escapeHtml(asset.assetCode || asset.qrCode || asset.assetId || "-")}</small>
      </label>
    `;
  }).join("");
  const noteFields = requirements.filter(({ evidenceType }) => evidenceType === "note").map((requirement) => `
    <label class="driver-bin-note-field">
      <span>${escapeHtml(binEvidenceLabel(requirement))}${requirement.required ? " *" : ""}</span>
      <textarea data-bin-note="${escapeHtml(requirement.evidenceCode)}" ${routeProtectedControlAttributes()} maxlength="2000" placeholder="${t("driver.binNotePlaceholder", "Record the required condition or site note")}">${escapeHtml(draft.notes[requirement.evidenceCode])}</textarea>
    </label>
  `).join("");
  const signatureFields = requirements.filter(({ evidenceType }) => evidenceType === "signature").map((requirement) => `
    <label class="driver-bin-signature-field">
      <span>${escapeHtml(binEvidenceLabel(requirement))} · ${t("driver.binSignerName", "Signer name")}${requirement.required ? " *" : ""}</span>
      <input data-bin-signature="${escapeHtml(requirement.evidenceCode)}" ${routeProtectedControlAttributes()} maxlength="300" value="${escapeHtml(draft.signatures[requirement.evidenceCode]?.signedBy || "")}" placeholder="${t("driver.binSignerPlaceholder", "Enter the person who signed")}" />
    </label>
  `).join("");
  const photoFields = slots.map((slot) => renderDriverBinPhotoSlot(slot, photoRequirements.get(slot.evidenceCode) || slot)).join("");
  return `
    <section class="driver-bin-evidence" aria-label="${t("driver.binRequiredEvidence", "Required BIN evidence")}">
      <div class="driver-bin-section-head">
        <div><span>${t("driver.binSavedOnDevice", "Saved on this device")}</span><h3>${t("driver.binRequiredEvidence", "Required BIN evidence")}</h3></div>
        ${renderCameraSwitchButton()}
      </div>
      ${scanFields ? `<div class="driver-bin-field-grid">${scanFields}</div>` : ""}
      ${photoFields ? `<div class="photo-grid driver-bin-photo-grid">${photoFields}</div>` : ""}
      ${noteFields ? `<div class="driver-bin-field-grid">${noteFields}</div>` : ""}
      ${signatureFields ? `<div class="driver-bin-field-grid">${signatureFields}</div>` : ""}
      ${renderDriverBinReceipt(job, requirements)}
      <p class="driver-bin-local-first-note">${t("driver.binLocalFirstHelp", "Each action and required photo is saved on this device before the screen advances. Offline location is recorded as not checked.")}</p>
    </section>
  `;
}

function renderDriverBinSummary(job) {
  const assets = Object.entries(job.mbt?.exactAssets || {}).filter(([, asset]) => asset?.assetId);
  const requirements = window.DriverBinUI.requirements(job);
  return `
    <section class="driver-bin-work-order" data-driver-bin-job>
      <div class="driver-bin-work-head">
        <div><span>${t("driver.binWorkOrder", "BIN work order")}</span><h3>${escapeHtml(job.mbt?.visitReference || job.mbt?.contractNumber || job.jobId)}</h3></div>
        <span class="driver-bin-type-badge">${escapeHtml(job.mbt?.binTypeCode || "BIN")}</span>
      </div>
      <div class="driver-bin-frozen-grid">
        <div><span>${t("driver.binAction", "Action")}</span><strong>${escapeHtml(driverBinActionLabel(job))}</strong></div>
        <div><span>${t("driver.binVisit", "Visit")}</span><strong>${escapeHtml(job.mbt?.visitReference || "-")}</strong></div>
      </div>
      ${assets.length ? `<div class="driver-bin-assets">${assets.map(([role, asset]) => `
        <div data-bin-asset-role="${escapeHtml(role)}">
          <span>${escapeHtml(binAssetRoleLabel(role))}</span>
          <strong>${escapeHtml(asset.assetCode || asset.qrCode || asset.assetId)}</strong>
          <small>${escapeHtml(asset.binTypeCode || job.mbt?.binTypeCode || "")}</small>
        </div>
      `).join("")}</div>` : ""}
      ${job.status === "in_progress"
        ? renderDriverBinEvidence(job)
        : `<div class="driver-bin-requirements-preview"><strong>${t("driver.binAfterStart", "After Start, record:")}</strong><span>${requirements.map(binEvidenceLabel).map(escapeHtml).join(" · ") || t("driver.binNoExtraEvidence", "No additional evidence")}</span></div>`}
    </section>
  `;
}

function renderPhotoSlots(job) {
  if (!job.requiredPhotos) {
    return `
      <section class="photo-panel">
        <h3>${t("driver.noPhotosRequired", "No photos required")}</h3>
        <button class="primary" data-action="complete-job" ${routeProtectedControlAttributes()} type="button">${t("driver.completeTravel", "Complete Travel")}</button>
      </section>
    `;
  }
  const minimumPhotos = Math.max(2, Number(job.requiredPhotos || 0));
  while (photos.length < minimumPhotos) photos.push("");
  const completionBlockers = [];
  if (!locationCheckApproved()) {
    completionBlockers.push(t(
      "driver.locationRequiredBeforeComplete",
      "Recheck location or choose Override & Continue before completing."
    ));
  }
  const remainingPhotos = Math.max(0, minimumPhotos - photos.filter(Boolean).length);
  if (remainingPhotos > 0) {
    completionBlockers.push(tf(
      "driver.requiredPhotosRemaining",
      "Add {count} more required photo(s).",
      { count: remainingPhotos }
    ));
  }
  return `
    <div class="photo-modal" role="dialog" aria-modal="true" aria-label="${tf("driver.photosRequired", "At least {count} photos required", { count: minimumPhotos })}">
      <section class="photo-panel">
        ${renderDriverActionProtectionNotice("driverPhotoProtectionNotice")}
        <div class="photo-head">
          <h3>${tf("driver.photosRequired", "At least {count} photos required", { count: minimumPhotos })}</h3>
          ${renderCameraSwitchButton()}
          <button class="icon-button" data-action="close-photo" aria-label="${t("driver.closePhoto", "Close photo")}" title="${t("driver.closePhoto", "Close photo")}" type="button">X</button>
        </div>
        ${renderLocationCheck(job)}
        <div class="photo-grid">
          ${photos.map((photo, index) => `
            <div class="photo-slot">
            <input data-photo-index="${index}" data-photo-source="camera" ${routeProtectedControlAttributes()} type="file" accept="image/*" capture="${cameraCaptureMode()}" />
            <input data-photo-index="${index}" data-photo-source="gallery" ${routeProtectedControlAttributes()} type="file" accept="image/*" />
              <div class="photo-preview">${photo ? `<img src="${escapeHtml(photoValueUrl(photo))}" alt="${t("common.photos", "Photo")} ${index + 1}" />` : `${t("common.photos", "Photo")} ${index + 1}`}</div>
              <div class="photo-source-actions">
                <button data-action="take-photo" data-photo-index="${index}" ${routeProtectedControlAttributes()} type="button">${t("common.camera", "Camera")}</button>
                <button data-action="choose-gallery-photo" data-photo-index="${index}" ${routeProtectedControlAttributes()} type="button">${t("common.gallery", "Gallery")}</button>
              </div>
            </div>
          `).join("")}
        </div>
        <div class="photo-list-actions">
          <button class="secondary compact" data-action="add-job-photo" ${routeProtectedControlAttributes()} type="button">${t("common.addAnotherPhoto", "Add another photo")}</button>
          ${photos.length > minimumPhotos ? `<button class="secondary compact danger-button" data-action="remove-job-photo" ${routeProtectedControlAttributes()} type="button">${t("common.removeLastPhoto", "Remove last photo")}</button>` : ""}
        </div>
        <label class="driver-photo-remark">
          <span>${t("driver.photoRemark", "Driver remark")} <small>${t("common.optional", "Optional")}</small></span>
          <textarea data-driver-photo-remark ${routeProtectedControlAttributes()} maxlength="${DRIVER_REMARK_MAX_LENGTH}" placeholder="${t("driver.photoRemarkPlaceholder", "Add a note about this stop or the photos")}">${escapeHtml(driverRemark)}</textarea>
        </label>
        ${completionBlockers.length ? `<div class="photo-completion-blockers" id="driverPhotoCompletionBlockers" role="status">${completionBlockers.map((message) => `<span>${escapeHtml(message)}</span>`).join("")}</div>` : ""}
        <button class="primary" data-action="complete-job" data-job-confirm data-gps-gate="complete" ${routeProtectedControlAttributes()} data-photo-required="true" data-ready-label="${t("driver.completeStop", "Complete Stop")}" ${completionBlockers.length || !canCompleteCurrentJob(job) ? "disabled" : ""} ${completionBlockers.length ? `aria-describedby="driverPhotoCompletionBlockers"` : ""} type="button">${completeWaitSeconds(job) > 0 ? tf("driver.waitSeconds", "Wait {seconds}s", { seconds: completeWaitSeconds(job) }) : t("driver.completeStop", "Complete Stop")}</button>
      </section>
    </div>
  `;
}

function renderDriverDependencyWarnings(job) {
  const warnings = Array.isArray(job?.dependencyWarnings)
    ? job.dependencyWarnings.filter((warning) => warning?.softened === true)
    : [];
  if (!warnings.length) return "";
  return `
    <section class="driver-dependency-warning" role="alert" aria-live="assertive">
      <strong>${t("driver.softDependencyTitle", "Testing mode · dependency warning")}</strong>
      ${warnings.map((warning) => `
        <span>${escapeHtml(warning.message || t(
          "driver.softDependencyFallback",
          "The required yard-replenishment Transfer Order is not complete. Driver execution is temporarily allowed by Admin."
        ))}</span>
      `).join("")}
      <small>${t(
        "driver.softDependencyDispatchHard",
        "Dispatch planning and direct-linked same-truck Transfer Orders remain hard-blocked."
      )}</small>
    </section>
  `;
}

function renderJob() {
  if (activeRest) scheduleRestRender();
  else clearRestTimer();
  const job = currentJob;
  if (!job) return renderNoJob();
  const isPickup = job.stopType === "pickup";
  const isTravel = job.stopType === "travel";
  const isTruckSwitch = job.stopType === "truck_switch";
  const isBin = isDriverBinJob(job);
  const switchAttention = truckSwitchAttentionForJob(job);
  const isStarted = job.status === "in_progress";
  const typeText = isTruckSwitch ? t("driver.truckSwitch", "Truck Switch") : isTravel ? t("driver.travel", "Travel") : isPickup ? t("driver.pickup", "Pickup") : t("driver.dropoff", "Drop Off");
  const titleText = isTruckSwitch
    ? tf("driver.switchFromTo", "{from} to {to}", {
        from: job.fromTruckPlate || "-",
        to: job.nextTruckPlate || job.truckPlate || "-"
      })
    : isTravel ? job.location : (job.location || job.address || t("driver.stop", "Stop"));
  const navigationUrl = mapsUrl(job);
  const waitSeconds = completeWaitSeconds(job);
  const confirmDisabled = !canBeginJobConfirmation(job);
  scheduleCountdownRender(job);
  shell(`
    <section class="job-panel">
      <div class="job-sticky">
        <div class="plan-meta-row">
          <span>${escapeHtml(planDateText(job.planDate))}</span>
          <span>${escapeHtml(job.driverName || driver?.name || "-")}</span>
          <span>${escapeHtml(job.truckPlate || "-")}</span>
        </div>
        <div class="job-head">
          <div class="job-title-row">
            <span class="job-type ${isTruckSwitch ? "truck-switch" : isTravel ? "travel" : isPickup ? "" : "dropoff"}">${typeText}</span>
            <h2>${escapeHtml(titleText)}</h2>
          </div>
          <button class="rest-toggle" data-action="start-rest" ${routeProtectedControlAttributes()} type="button">${t("driver.rest", "Rest")}</button>
        </div>
        <div class="address-block">
          <div>
            <span>${isTruckSwitch ? t("driver.switchYard", "Switch yard") : isTravel ? t("driver.travelDestination", "Travel destination") : isPickup ? t("driver.pickupAddress", "Pickup address / yard") : t("driver.deliveryAddress", "Delivery address")}</span>
            <strong>${escapeHtml(job.address || job.location || "")}</strong>
            ${isTravel && job.fromAddress ? `<em>${tf("driver.startAddress", "Start: {address}", { address: escapeHtml(job.fromAddress) })}</em>` : ""}
            ${isTruckSwitch ? `<em>${t("driver.nextLoad", "Next load")}: ${escapeHtml(job.loadName || job.loadId || "-")} | ${t("driver.parkingSpot", "Parking spot")}: ${escapeHtml(job.parkingSpot || "-")}</em>` : ""}
          </div>
          ${navigationUrl ? `<a class="map-button" href="${navigationUrl}" target="_blank" rel="noopener">${t("driver.maps", "Maps")}</a>` : ""}
        </div>
      </div>
      ${renderDriverDependencyWarnings(job)}
      ${isTruckSwitch ? `<section class="truck-switch-summary">
        <div><span>${t("driver.currentTruck", "Current truck")}</span><strong>${escapeHtml(job.fromTruckPlate || "-")}</strong></div>
        <div><span>${t("driver.nextTruck", "Next truck")}</span><strong>${escapeHtml(job.nextTruckPlate || job.truckPlate || "-")}</strong></div>
        <p>${escapeHtml(job.instructions || t("driver.switchInstruction", "Park the current truck and confirm after entering the next truck."))}</p>
      </section>` : renderLocationCheck(job)}
      ${isTravel || isTruckSwitch ? "" : isBin ? renderDriverBinSummary(job) : renderStopDetails(job)}
      <div class="job-actions ${isTruckSwitch ? "truck-switch-job-actions" : ""}">
        ${isTruckSwitch
          ? `<div class="truck-switch-action-set">
              <button class="primary" data-action="confirm-truck-switch" ${routeProtectedControlAttributes()} type="button">${driverUsesSamsaraWorkflow() && switchAttention ? t("driver.retryTruckSwitch", "Retry Samsara & Confirm") : t("driver.confirmTruckSwitch", "Confirm Truck Switch")}</button>
              ${driverUsesSamsaraWorkflow() ? `<button class="secondary danger-button skip-samsara-button" data-action="skip-samsara-switch" ${routeProtectedControlAttributes()} type="button">${t("driver.skipSamsara", "Skip Samsara & Confirm")}</button>` : ""}
            </div>`
          : isStarted
          ? isBin
            ? `<button class="primary driver-bin-complete" data-action="complete-job" data-driver-bin-complete ${routeProtectedControlAttributes()} data-job-confirm data-gps-gate="begin" data-ready-label="${t("driver.binCompleteStop", "Complete BIN Stop")}" ${confirmDisabled || !driverBinEvidenceReady(job) ? "disabled" : ""} type="button">${waitSeconds > 0 ? tf("driver.waitSeconds", "Wait {seconds}s", { seconds: waitSeconds }) : t("driver.binCompleteStop", "Complete BIN Stop")}</button>`
            : `<button class="primary" data-action="${job.requiredPhotos ? "show-photo" : "complete-job"}" ${routeProtectedControlAttributes()} data-job-confirm data-gps-gate="begin" data-ready-label="${t("driver.confirm", "Confirm")}" ${confirmDisabled ? "disabled" : ""} type="button">${waitSeconds > 0 ? tf("driver.waitSeconds", "Wait {seconds}s", { seconds: waitSeconds }) : t("driver.confirm", "Confirm")}</button>`
          : `<button class="primary" data-action="start-job" ${routeProtectedControlAttributes()} type="button">${t("common.start", "Start")}</button>`}
        <button class="secondary compact" data-action="refresh" type="button">${t("common.refresh", "Refresh")}</button>
        <button class="secondary compact" data-action="open-history" type="button">${t("common.history", "History")}</button>
      </div>
      ${photoPromptOpen ? renderPhotoSlots(job) : ""}
    </section>
    ${activeRest ? renderRestModal() : ""}
  `);
  if (job.stopType === "dropoff") void prepareCurrentDeliveryInstructionLanguage();
}

function renderRestModal() {
  const rest = activeRest;
  if (!rest) return "";
  const sessionCount = Math.max(1, Number(restSummary?.sessionCount || 0));
  return `
    <div class="rest-modal" role="dialog" aria-modal="true" aria-labelledby="restTimerTitle">
      <section class="rest-timer-panel">
        ${renderDriverActionProtectionNotice("driverRestProtectionNotice")}
        <div class="rest-timer-head">
          <span class="rest-status-dot" aria-hidden="true"></span>
          <div>
            <span>${t("driver.restInProgress", "Rest in progress")}</span>
            <h2 id="restTimerTitle">${t("driver.todayAccumulatedRest", "Today's accumulated rest")}</h2>
          </div>
        </div>
        <div class="rest-daily-total">
          <strong data-rest-daily-timer>${durationClock(dailyRestSeconds())}</strong>
          <span>${tf("driver.totalRestFor", "Total rest for {date}", { date: escapeHtml(planDateText(rest.planDate || restSummary?.planDate || currentJob?.planDate)) })}</span>
        </div>
        <div class="rest-session-grid">
          <div>
            <span>${t("driver.currentSession", "Current session")}</span>
            <strong data-rest-session-timer>${durationClock(elapsedSeconds(rest.startedAt))}</strong>
          </div>
          <div>
            <span>${t("driver.sessionsToday", "Sessions today")}</span>
            <strong>${sessionCount}</strong>
          </div>
        </div>
        <p>${t("driver.restStatisticsHelp", "Rest time that overlaps a started stop is automatically deducted from that stop's service-time statistics.")}</p>
        <button class="primary rest-end-button" data-action="end-rest" ${routeProtectedControlAttributes()} type="button">${t("driver.endRest", "End rest time")}</button>
      </section>
    </div>
  `;
}

function renderRest() {
  return renderJob();
}

function jobIsComplete(job) {
  return ["complete", "completed", "done"].includes(String(job?.status || "").toLowerCase());
}

function dvirEventNeedsReconciliation(event) {
  return event?.status === "applied"
    && event?.result?.pendingOnline === true
    && event?.result?.samsaraReconciled !== true;
}

function dutyEventNeedsReconciliation(event) {
  return event?.status === "applied"
    && event?.result?.samsaraDutyPendingOnline === true
    && event?.result?.samsaraDutyReconciled !== true;
}

function projectOfflineRoute(manifest, events) {
  const jobs = (manifest?.jobs || []).map((job) => ({ ...job }));
  const jobsById = new Map(jobs.map((job) => [String(job.jobId), job]));
  const projectedState = {
    ...(manifest?.payload?.dayState || {}),
    ...(manifest?.dayState || {})
  };
  if (typeof manifest?.samsaraWorkflowEnabled === "boolean") {
    projectedState.samsaraEnabled = manifest.samsaraWorkflowEnabled;
  }
  let projectedRest = manifest?.payload?.rest || null;
  let projectedRestSummary = manifest?.payload?.restSummary || null;
  let projectedPendingDvir = null;
  const projectedPendingDuty = [];
  const manifestGeneratedAt = Date.parse(manifest?.generatedAt || "");
  for (const event of events || []) {
    if (["cancelled", "evidence_only", "rejected"].includes(event.status)) continue;
    const appliedAt = Date.parse(event.appliedAt || "");
    if (
      event.status === "applied"
      && !dvirEventNeedsReconciliation(event)
      && !dutyEventNeedsReconciliation(event)
      && Number.isFinite(appliedAt)
      && Number.isFinite(manifestGeneratedAt)
      && manifestGeneratedAt >= appliedAt
    ) continue;
    const job = jobsById.get(String(event.effectiveJobId || event.jobId || ""));
    const physicalVisitJobs = driverEventPhysicalVisitJobIds(event, manifest)
      .map((jobId) => jobsById.get(jobId))
      .filter(Boolean);
    if (event.eventType === "job_started" && physicalVisitJobs.length) {
      for (const visitJob of physicalVisitJobs) {
        visitJob.status = "in_progress";
        visitJob.startedAt = event.occurredAt;
      }
      if (dutyEventNeedsReconciliation(event)) projectedPendingDuty.push(event);
    }
    if (event.eventType === "job_completed" && physicalVisitJobs.length) {
      for (const visitJob of physicalVisitJobs) {
        visitJob.status = "completed";
        visitJob.completedAt = event.occurredAt;
      }
    }
    if (event.eventType === "truck_switched_physical" && job) {
      job.status = "completed";
      job.completedAt = event.occurredAt;
      projectedState.truckPlate = event.details?.toTruckPlate || job.nextTruckPlate || job.truckPlate || projectedState.truckPlate;
      if (event.details?.samsaraReconciliationRequired) {
        projectedState.truckSwitchAttention = [
          ...(projectedState.truckSwitchAttention || []),
          {
            jobId: job.jobId,
            fromTruckPlate: event.details?.fromTruckPlate || job.fromTruckPlate,
            toTruckPlate: event.details?.toTruckPlate || job.nextTruckPlate || job.truckPlate,
            error: t("driver.physicalSwitchReconciliationPending", "Physical switch recorded offline. Samsara reconciliation is pending.")
          }
        ];
      }
    }
    if (event.eventType === "rest_started") {
      projectedRest = {
        id: event.details?.restId || event.eventId,
        restId: event.details?.restId || event.eventId,
        startedAt: event.occurredAt,
        planDate: manifest.planDate
      };
      projectedRestSummary = {
        ...(projectedRestSummary || {}),
        planDate: manifest.planDate,
        sessionCount: Number(projectedRestSummary?.sessionCount || 0) + 1
      };
    }
    if (event.eventType === "rest_ended") {
      if (projectedRest?.startedAt) {
        projectedRestSummary = {
          ...(projectedRestSummary || {}),
          completedSeconds: Number(projectedRestSummary?.completedSeconds || 0) + elapsedSeconds(projectedRest.startedAt)
        };
      }
      projectedRest = null;
    }
    if (event.eventType === "dvir_captured") {
      const type = event.details?.dvirType === "post" ? "post" : "pre";
      if (event.result?.samsaraReconciled === true || event.result?.pendingOnline === false) {
        projectedState[`${type}DvirStatus`] = "complete";
      } else {
        projectedState[`${type}DvirStatus`] = "pending_online";
        projectedState.offlineDvirPending = true;
        if (dvirEventNeedsReconciliation(event)) projectedPendingDvir = event;
      }
    }
  }
  const inProgress = jobs.find((job) => String(job.status || "").toLowerCase() === "in_progress");
  const nextPending = jobs.find((job) => !jobIsComplete(job));
  const projectedJob = inProgress || nextPending || null;
  projectedState.allJobsComplete = Boolean(manifest?.complete && jobs.length > 0 && jobs.every(jobIsComplete));
  return {
    jobs,
    currentJob: projectedJob,
    dayState: projectedState,
    rest: projectedRest,
    restSummary: projectedRestSummary,
    pendingDvirEvent: projectedPendingDvir,
    pendingDutyEvents: projectedPendingDuty
  };
}

async function restoreDraftPhotos(kind = "job", suffix = "") {
  if (!driverOfflineModeEnabled || !offlineStorageAvailable || !offlinePartition?.partitionKey || !offlineManifest?.manifestId) return;
  const partitionKey = offlinePartition.partitionKey;
  const manifestId = offlineManifest.manifestId;
  const expectedJobId = String(currentJob?.jobId || "");
  const expectedDvirMode = suffix || dvirMode || "pre";
  const draftSuffix = kind === "dvir"
    ? expectedDvirMode
    : (expectedJobId || "unknown");
  const records = await window.DriverOfflineDB.getCompatibleDraftPhotos(
    partitionKey,
    offlineManifest,
    kind,
    draftSuffix
  );
  if (
    partitionKey !== offlinePartition?.partitionKey
    || manifestId !== offlineManifest?.manifestId
    || (kind === "dvir"
      ? expectedDvirMode !== (dvirMode || "pre")
      : expectedJobId !== String(currentJob?.jobId || ""))
  ) return false;
  const drafts = records.map((record) => window.DriverOfflinePhotos.hydrate(record));
  const target = kind === "dvir" ? dvirPhotos : photos;
  drafts.forEach((photo) => {
    target[Number(photo.ordinal || 0)] = photo;
  });
  return true;
}

async function renderOfflineProjection(manifest = offlineManifest) {
  if (!manifest) return false;
  const projectionEpoch = markDriverInteraction();
  const events = await window.DriverOfflineDB.getProjectionEvents(
    offlinePartition.partitionKey,
    manifest
  );
  if (routeRefreshWasSuperseded(projectionEpoch)) return false;
  const projection = projectOfflineRoute(manifest, events);
  const projectedPendingDvirPhotos = projection.pendingDvirEvent
    ? await window.DriverOfflineDB.getEventPhotos(projection.pendingDvirEvent.eventId)
    : [];
  if (routeRefreshWasSuperseded(projectionEpoch)) return false;
  offlineManifest = manifest;
  dayState = projection.dayState;
  currentJob = projection.currentJob;
  activeRest = acceptDriverRestCandidate(projection.rest);
  restSummary = projection.restSummary;
  pendingDvirEvent = projection.pendingDvirEvent || null;
  pendingDutyEvents = projection.pendingDutyEvents || [];
  pendingDvirPhotos = projectedPendingDvirPhotos;
  photos = [];
  driverRemark = "";
  binDraft = null;
  dvirPhotos = [];
  photoPromptOpen = false;
  locationCheck = null;
  locationOverrideApproval.reconcile(currentJob);

  // A refreshed offline route cannot perform a live GPS check. Restore the
  // explicit offline approval state so an in-progress stop does not become
  // permanently disabled merely because the document was reloaded.
  if (
    currentJob?.status === "in_progress"
    && (offlineCachedView || !navigator.onLine || browserOfflineObserved)
  ) {
    locationCheck = offlineLocationCheckResult();
  }

  const preStatus = String(dayState?.preDvirStatus || "").toLowerCase();
  const samsaraPending = !dayState?.samsaraOnDutyConfirmed || !dayState?.samsaraPreDvirConfirmed;
  const preDvirBlocked = driverUsesSamsaraWorkflow()
    && dayState?.truckPlate
    && !["complete", "pending_online"].includes(preStatus)
    && !dayState?.offlineDvirPending;
  if (preDvirBlocked || (driverUsesSamsaraWorkflow() && dayState?.truckPlate && samsaraPending && !dayState?.offlineDvirPending && preStatus === "complete")) {
    currentJob = null;
    dvirMode = "pre";
    await restoreDraftPhotos("dvir", "pre");
    if (routeRefreshWasSuperseded(projectionEpoch)) return false;
    renderDvir("pre", offlineCachedView
      ? t("driver.cachedRouteLoaded", "Saved route loaded. Samsara actions will remain pending until reconnection.")
      : "");
    return true;
  }
  const postStatus = String(dayState?.postDvirStatus || "").toLowerCase();
  if (offlineManifest?.complete && driverUsesSamsaraWorkflow() && !currentJob && dayState?.allJobsComplete && !["complete", "pending_online"].includes(postStatus)) {
    dvirMode = "post";
    await restoreDraftPhotos("dvir", "post");
    if (routeRefreshWasSuperseded(projectionEpoch)) return false;
    renderDvir("post", t("driver.offlinePostTripHelp", "Route complete. The post-trip inspection can be captured offline and submitted to Samsara after reconnection."));
    return true;
  }
  dvirMode = "";
  if (currentJob) {
    await Promise.all([
      restoreDraftPhotos("job"),
      restoreDriverRemarkDraft(),
      restoreDriverBinDraft()
    ]);
  }
  if (routeRefreshWasSuperseded(projectionEpoch)) return false;
  renderJob();
  return true;
}

async function loadCachedRoute() {
  if (!driverOfflineModeEnabled || !offlineStorageAvailable) return false;
  const active = offlinePartition || await window.DriverOfflineDB.getActiveProfile();
  if (!active || active.locked) return false;
  offlinePartition = active;
  offlineDeviceId = active.deviceId;
  driver = driver || active.profile;
  driverIdentityValidated = true;
  offlineManifest = await window.DriverOfflineDB.getActiveManifest(active.partitionKey);
  if (!offlineManifest) return false;
  await refreshDeferredManifestState({ activateIfSafe: true });
  offlineCachedView = true;
  await renderOfflineProjection(offlineManifest);
  await refreshOfflineHealth();
  return true;
}

async function ensureDriverIdentityValidated() {
  if (driverIdentityValidated) return true;
  if (!driverIdentityValidationPromise) return false;
  return Boolean(await driverIdentityValidationPromise);
}

async function prepareOfflineRecord() {
  if (!driverOfflineModeEnabled) {
    await ensureDriverIdentityValidated();
    if (driverIdentityValidated && navigator.onLine) return true;
    showToast(t("driver.onlineOnlyConnectionRequired", "Admin has set this Driver PWA to online-only mode. Reconnect to record an action."));
    return false;
  }
  if (canUseOfflineLedger()) return true;
  showToast(t("driver.preparingOfflineRecord", "Preparing offline record..."));
  await ensureDriverIdentityValidated();
  if (
    driverIdentityValidated
    && offlineStorageAvailable
    && authToken
    && navigator.onLine
    && !canUseOfflineLedger()
  ) {
    await downloadDayPlan(dayState?.planDate || currentJob?.planDate);
  }
  if (canUseOfflineLedger()) return true;
  showToast(offlineStorageAvailable
    ? t("driver.offlineRecordingNotReady", "Offline recording is not ready yet. Refresh the route before continuing.")
    : t("driver.offlineRecordingUnavailable", "Offline recording is unavailable in this browser. This action was not submitted."));
  return false;
}

async function saveRouteBootstrap(result, { activate } = {}) {
  if (!(await ensureDriverIdentityValidated())) return null;
  if (!driverOfflineModeEnabled || !offlineStorageAvailable || !offlinePartition?.partitionKey || !result?.routeBootstrap?.manifestId) return null;
  const shouldActivate = activate ?? !(await shouldDeferIncomingManifest(result.routeBootstrap));
  const saved = await window.DriverOfflineDB.saveBootstrap(
    offlinePartition.partitionKey,
    result,
    { activate: shouldActivate }
  );
  if (shouldActivate) {
    offlineManifest = saved;
    offlineDeferredManifest = null;
    offlineManifestUpdateDeferred = false;
  } else {
    offlineDeferredManifest = saved;
    offlineManifestUpdateDeferred = true;
  }
  await refreshOfflineHealth();
  applyDriverActionProtectionGate();
  return saved;
}

async function fetchDriverDayPlanPayload(date = "", { forceRefresh = false } = {}) {
  if (!driverOfflineModeEnabled) return null;
  const planDate = String(date || dayState?.planDate || currentJob?.planDate || localDate()).slice(0, 10);
  const params = new URLSearchParams({ date: planDate });
  if (forceRefresh) params.set("forceRefresh", "1");
  const payload = await request(`/api/driver/day-plan?${params.toString()}`);
  const responseLogin = window.DriverOfflineDB.normalizeDriverLogin(payload?.driver?.login);
  if (responseLogin && responseLogin !== offlinePartition?.driverLogin) {
    throw new Error(t("driver.routeWrongDriver", "The downloaded route belongs to another driver."));
  }
  if (!payload?.manifestId || !Array.isArray(payload.jobs) || payload.complete === false) {
    throw new Error(t("driver.routeIncomplete", "The server did not return a complete fresh route."));
  }
  return payload;
}

async function saveDriverDayPlanPayload(payload, { activate: requestedActivation } = {}) {
  if (!driverOfflineModeEnabled || !payload) return { saved: null, activate: false };
  const activate = requestedActivation ?? !(await shouldDeferIncomingManifest(payload));
  const saved = await window.DriverOfflineDB.saveManifestAtomic(
    offlinePartition.partitionKey,
    payload,
    { complete: true, activate }
  );
  if (activate) {
    offlineManifest = saved;
    offlineDeferredManifest = null;
    offlineManifestUpdateDeferred = false;
    onlineRouteUpdatePending = false;
  } else {
    offlineDeferredManifest = saved;
    offlineManifestUpdateDeferred = true;
  }
  applyDriverActionProtectionGate();
  if (activate && currentJob) void prepareDeliveryInstructionMedia(currentJob, { force: true });
  return { saved, activate };
}

async function downloadDayPlan(date = "", { forceRefresh = false } = {}) {
  if (!driverOfflineModeEnabled) return null;
  if (savedRouteClearRunning) return null;
  if (!(await ensureDriverIdentityValidated())) return null;
  if (!offlineStorageAvailable || !offlinePartition?.partitionKey || !authToken) return null;
  if (dayPlanDownloadPromise) return dayPlanDownloadPromise;
  dayPlanDownloadPromise = (async () => {
    offlineRouteDownloading = true;
    renderOfflineStatus();
    try {
      const payload = await fetchDriverDayPlanPayload(date, { forceRefresh });
      const { saved } = await saveDriverDayPlanPayload(payload);
      offlineStatus.dataset.lastError = "";
      await refreshOfflineHealth();
      return saved;
    } catch (error) {
      if (!offlineManifest?.complete) offlineStatus.dataset.lastError = error.message;
      renderOfflineStatus();
      return null;
    } finally {
      offlineRouteDownloading = false;
      renderOfflineStatus();
      dayPlanDownloadPromise = null;
    }
  })();
  return dayPlanDownloadPromise;
}

function stopOnlineRouteRevalidation() {
  clearTimeout(onlineRouteRevalidationTimer);
  onlineRouteRevalidationTimer = null;
}

function scheduleOnlineRouteRevalidation(delay = ONLINE_ROUTE_REVALIDATE_MS) {
  stopOnlineRouteRevalidation();
  if (!driver || !authToken || savedRouteClearRunning) return;
  onlineRouteRevalidationTimer = window.setTimeout(async () => {
    onlineRouteRevalidationTimer = null;
    try {
      if (!navigator.onLine || document.visibilityState !== "visible") return;
      if (quietSyncActive() || activeRest || photoInteractionActive()) {
        onlineRouteRevalidationQueued = true;
        return;
      }
      await revalidateOnlineRoute({ source: "poll" });
    } finally {
      scheduleOnlineRouteRevalidation();
    }
  }, Math.max(250, Number(delay || ONLINE_ROUTE_REVALIDATE_MS)));
}

function incomingRouteDiffers(payload) {
  if (!offlineManifest || !payload) return true;
  return manifestRevisionChanged(offlineManifest, payload)
    || String(offlineManifest.manifestId || "") !== String(payload.manifestId || "");
}

async function revalidateOnlineRoute({
  beforeAction = false,
  expectedJob = currentJob,
  forceRefresh = false,
  source = "background"
} = {}) {
  if (savedRouteClearRunning) return !beforeAction;
  if (!navigator.onLine || !driver || !authToken) {
    return true;
  }
  if (driverOfflineModeEnabled && (!offlineStorageAvailable || !offlinePartition?.partitionKey)) return true;
  if (!beforeAction && (quietSyncActive() || activeRest || photoInteractionActive())) {
    onlineRouteRevalidationQueued = true;
    return true;
  }
  if (onlineRouteValidationPromise) {
    const result = await onlineRouteValidationPromise;
    return beforeAction ? result : true;
  }
  const partitionKey = driverOfflineModeEnabled ? offlinePartition.partitionKey : "";
  onlineRouteValidationPromise = (async () => {
    try {
      const authoritative = await request(`/api/driver/next-job?revalidate=${encodeURIComponent(Date.now())}`);
      if (partitionKey && partitionKey !== offlinePartition?.partitionKey) throw driverSessionChangedError();
      if (crossDevicePendingCompletionMatchesJob(authoritative.pendingCompletion, expectedJob)) {
        onlineRouteLastValidatedAt = Date.now();
        if (beforeAction) {
          showToast(t(
            "driver.stopAlreadySavedAnotherDevice",
            "This stop has pending evidence under another device storage ID. A browser storage error can cause this even when nobody else logged in. Keep the original PWA open and use Sync now, or request Dispatch review."
          ));
        }
        return false;
      }
      if (!driverOfflineModeEnabled) {
        const currentChanged = authoritativeJobChanged(expectedJob, authoritative);
        onlineRouteLastValidatedAt = Date.now();
        onlineRouteUpdatePending = false;
        onlineRouteRevalidationQueued = false;
        if (authoritative.state) dayState = authoritative.state;
        if (currentChanged) {
          if (activeRest || photoInteractionActive()) {
            onlineRouteUpdatePending = true;
            onlineRouteRevalidationQueued = true;
            if (beforeAction) {
              showToast(t("driver.stopUpdatedReview", "The server stop changed. Finish the open screen, refresh, and review it before continuing."));
            }
            return false;
          }
          await loadNextJob();
          if (beforeAction) showToast(t("driver.stopUpdatedReview", "The server stop changed. Review it, then tap the action again."));
          return false;
        }
        const authoritativeIdentity = authoritativeJobIdentity(authoritative);
        if (currentJob && authoritativeIdentity.job && String(currentJob.jobId) === String(authoritativeIdentity.job.jobId)) {
          currentJob = withManifestJobIdentity({
            ...currentJob,
            fingerprint: authoritativeIdentity.fingerprint || currentJob.fingerprint,
            predecessorFingerprint: authoritativeIdentity.predecessorFingerprint || currentJob.predecessorFingerprint,
            contentFingerprint: authoritativeIdentity.contentFingerprint || currentJob.contentFingerprint
          }, authoritative.routeBootstrap);
        }
        renderOfflineStatus();
        return true;
      }
      const planDate = manifestPlanDate(authoritative.routeBootstrap)
        || authoritative.state?.planDate
        || authoritative.job?.planDate
        || localDate();
      const payload = await fetchDriverDayPlanPayload(planDate, { forceRefresh });
      if (partitionKey !== offlinePartition?.partitionKey) throw driverSessionChangedError();
      const currentChanged = authoritativeJobChanged(expectedJob, authoritative);
      const dispatchRouteChanged = manifestRevisionChanged(offlineManifest, payload);
      const projectionEvents = currentChanged && !dispatchRouteChanged && offlineManifest?.manifestId
        ? await window.DriverOfflineDB.getProjectionEvents(partitionKey, offlineManifest)
        : [];
      if (partitionKey !== offlinePartition?.partitionKey) throw driverSessionChangedError();
      const routeReconciliation = classifyAuthoritativeRoute(expectedJob, authoritative, {
        manifest: offlineManifest,
        events: projectionEvents,
        dispatchRouteChanged
      });
      const protectedInteraction = Boolean(activeRest || photoInteractionActive());
      const routeChanged = incomingRouteDiffers(payload);
      const requestedActivation = routeReconciliation === "local_progress_pending"
        ? true
        : protectedInteraction && (currentChanged || routeChanged)
          ? false
          : undefined;
      const { activate } = await saveDriverDayPlanPayload(payload, { activate: requestedActivation });
      if (partitionKey !== offlinePartition?.partitionKey) throw driverSessionChangedError();
      if (routeReconciliation === "local_progress_pending") {
        onlineRouteLastValidatedAt = Date.now();
        onlineRouteUpdatePending = false;
        onlineRouteRevalidationQueued = false;
        renderOfflineStatus();
        if (beforeAction) {
          showToast(t(
            "driver.previousStopPhotosSyncing",
            "Previous stop saved locally. Its photos are still synchronizing; you can continue with this route."
          ));
        }
        return true;
      }
      if (routeReconciliation === "local_progress_review") {
        onlineRouteUpdatePending = true;
        onlineRouteRevalidationQueued = true;
        renderOfflineStatus();
        if (beforeAction) {
          showToast(t(
            "driver.previousStopReviewRequired",
            "The previous stop needs Dispatch review before you can continue."
          ));
        }
        return false;
      }
      if (!activate && currentChanged) {
        onlineRouteUpdatePending = true;
        onlineRouteRevalidationQueued = true;
        renderOfflineStatus();
        if (beforeAction) {
          showToast(routeReconciliation === "server_execution_changed"
            ? t("driver.serverStopMovedProtected", "The server is on a different stop. Close the protected screen, refresh, and review it before continuing.")
            : t("driver.stopUpdatedProtected", "Dispatch updated this stop. Close the protected screen, refresh, and review it before continuing."));
        }
        return false;
      }
      if (!activate && !protectedInteraction) {
        onlineRouteUpdatePending = true;
        onlineRouteRevalidationQueued = true;
        renderOfflineStatus();
        if (beforeAction) showToast(t("driver.routeUpdateWaiting", "A route update is waiting for saved work to synchronize or be reviewed."));
        return false;
      }
      onlineRouteLastValidatedAt = Date.now();
      onlineRouteUpdatePending = false;
      onlineRouteRevalidationQueued = false;
      offlineStatus.dataset.lastError = "";
      if (routeReconciliation !== "unchanged") {
        if (protectedInteraction) {
          onlineRouteUpdatePending = true;
          onlineRouteRevalidationQueued = true;
          renderOfflineStatus();
          return false;
        }
        await loadNextJob();
        if (routeReconciliation === "server_execution_changed") {
          showToast(beforeAction
            ? t("driver.serverStopMovedReview", "The server is on a different stop. Review it, then tap the action again.")
            : t("driver.serverRouteMoved", "The server route moved to another stop."));
        } else {
          showToast(beforeAction
            ? t("driver.stopUpdatedReview", "Dispatch updated this stop. Review it, then tap the action again.")
            : t("driver.routeUpdated", "Route updated by Dispatch"));
        }
        return false;
      }
      if (authoritative.state) dayState = authoritative.state;
      const authoritativeIdentity = authoritativeJobIdentity(authoritative);
      if (currentJob && authoritativeIdentity.job && String(currentJob.jobId) === String(authoritativeIdentity.job.jobId)) {
        currentJob = withManifestJobIdentity({
          ...currentJob,
          fingerprint: authoritativeIdentity.fingerprint || currentJob.fingerprint,
          predecessorFingerprint: authoritativeIdentity.predecessorFingerprint || currentJob.predecessorFingerprint,
          contentFingerprint: authoritativeIdentity.contentFingerprint || currentJob.contentFingerprint
        }, authoritative.routeBootstrap);
      }
      renderOfflineStatus();
      return true;
    } catch (error) {
      if (error.code === "driver_session_changed") return false;
      const genuineNetworkFailure = await isGenuineNetworkFailure(error);
      if (genuineNetworkFailure) return true;
      offlineStatus.dataset.lastError = tf("driver.routeRecheckFailed", "Route recheck failed: {detail}", {
        detail: localizeMessage(error.message)
      });
      renderOfflineStatus();
      if (beforeAction) showToast(t("driver.stopRecheckFailed", "The current stop could not be rechecked. Try Sync now before continuing."));
      else if (source !== "poll") showToast(error.message);
      return false;
    } finally {
      if (!partitionKey || partitionKey === offlinePartition?.partitionKey) scheduleOnlineRouteRevalidation();
    }
  })();
  try {
    return await onlineRouteValidationPromise;
  } finally {
    onlineRouteValidationPromise = null;
  }
}

async function flushQueuedOnlineRouteRevalidation() {
  if (
    !onlineRouteRevalidationQueued
    || !driver
    || !authToken
    || !navigator.onLine
    || quietSyncActive()
    || activeRest
    || photoInteractionActive()
  ) return false;
  return revalidateOnlineRoute({ source: "deferred" });
}

async function ensureAuthoritativeJobBeforeAction(expectedJob = currentJob) {
  if (!expectedJob || !navigator.onLine) return true;
  return revalidateOnlineRoute({ beforeAction: true, expectedJob, source: "action" });
}

function captureQuietSyncContext() {
  if (!offlinePartition?.partitionKey) return null;
  return {
    partitionKey: offlinePartition.partitionKey,
    sessionGeneration: offlinePartition.sessionGeneration || "",
    driverLogin: offlinePartition.driverLogin || "",
    authToken
  };
}

function driverSessionChangedError() {
  const error = new Error(t("driver.sessionChangedDuringSync", "The Driver session changed while synchronization was running."));
  error.code = "driver_session_changed";
  return error;
}

async function assertQuietSyncContext(context) {
  if (
    !context
    || driverSessionInvalidated
    || !authToken
    || authToken !== context.authToken
    || offlinePartition?.partitionKey !== context.partitionKey
    || (
      context.sessionGeneration
      && offlinePartition?.sessionGeneration !== context.sessionGeneration
    )
  ) {
    throw driverSessionChangedError();
  }
  const storedProfile = await window.DriverOfflineDB.getProfile(context.partitionKey);
  if (
    !storedProfile
    || storedProfile.locked
    || (
      context.sessionGeneration
      && storedProfile.sessionGeneration !== context.sessionGeneration
    )
    || (
      context.driverLogin
      && storedProfile.driverLogin !== context.driverLogin
    )
  ) {
    throw driverSessionChangedError();
  }
  return storedProfile;
}

function waitForQuietSyncTick(milliseconds = QUIET_SYNC_LEASE_POLL_MS) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitForForeignSyncLease(context) {
  while (true) {
    await assertQuietSyncContext(context);
    const lease = await window.DriverOfflineDB.getLease(context.partitionKey);
    if (!lease || Number(lease.expiresAt || 0) <= Date.now()) return;
    await waitForQuietSyncTick();
  }
}

async function syncCapturedPartition(context) {
  while (true) {
    await assertQuietSyncContext(context);
    try {
      return await window.DriverOfflineSync.syncPartition(context.partitionKey);
    } catch (error) {
      if (error.code !== "sync_leased") throw error;
      await waitForForeignSyncLease(context);
    }
  }
}

async function reportDriverClientSyncStatus(state, { error = null, health = null } = {}) {
  if (!authToken || !offlineDeviceId || !navigator.onLine) return false;
  const snapshot = health || offlineHealth || {};
  const photoFailures = Array.isArray(error?.photoFailures)
    ? error.photoFailures.slice(0, 10).map((failure) => ({
        photoId: String(failure?.photoId || "").slice(0, 160),
        eventId: String(failure?.eventId || "").slice(0, 160),
        phase: String(failure?.phase || "").slice(0, 80),
        byteSize: Math.max(0, Number(failure?.byteSize || 0)),
        attemptCount: Math.max(0, Number(failure?.attemptCount || 0)),
        retryable: failure?.retryable === true,
        errorCode: String(failure?.errorCode || failure?.code || "").slice(0, 160),
        httpStatus: Math.max(0, Number(failure?.httpStatus || failure?.status || 0)),
        message: String(failure?.message || "Photo upload failed.").slice(0, 1000)
      }))
    : [];
  const payload = {
    state,
    errorName: error ? String(error.name || "").slice(0, 160) : "",
    errorCode: error ? String(error.code || "").slice(0, 160) : "",
    errorMessage: error ? String(error.message || error || "Synchronization failed.").slice(0, 2000) : "",
    manifestId: String(offlineManifest?.manifestId || "").slice(0, 160),
    planDate: String(
      offlineManifest?.planDate
      || dayState?.planDate
      || currentJob?.planDate
      || ""
    ).slice(0, 10),
    pendingEventCount: Math.max(0, Number(snapshot.pendingEventCount || 0)),
    reviewRequiredCount: Math.max(0, Number(snapshot.reviewRequiredCount || 0)),
    unsyncedPhotoCount: Math.max(0, Number(
      snapshot.partitionUnsyncedPhotoCount ?? snapshot.unsyncedPhotoCount ?? 0
    )),
    photoFailures,
    clientOccurredAt: new Date().toISOString()
  };
  try {
    const response = await fetch("/api/driver/sync-status", {
      method: "POST",
      cache: "no-store",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        [DRIVER_PWA_VERSION_HEADER]: DRIVER_PWA_CLIENT_VERSION,
        Authorization: `Bearer ${authToken}`,
        "X-MBBS-Driver-Device": offlineDeviceId
      },
      body: JSON.stringify(payload)
    });
    return response.ok;
  } catch {
    return false;
  }
}

function quietFinalRefreshSafe() {
  return Boolean(
    driver
    && authToken
    && navigator.onLine
    && !activeRest
    && !photoInteractionActive()
  );
}

async function waitForLiveRefreshToSettle(context) {
  while (liveRefreshRunning) {
    await assertQuietSyncContext(context);
    await waitForQuietSyncTick(25);
  }
}

async function renderQuietSyncFinalState(context) {
  if (!quietFinalRefreshSafe()) {
    quietSyncRefreshQueued = true;
    return false;
  }
  // A live event that arrives while the final request is in flight asks for
  // another pass. The overlay remains up until one complete pass is quiet.
  do {
    quietSyncRefreshQueued = false;
    await waitForLiveRefreshToSettle(context);
    await assertQuietSyncContext(context);
    if (activeView === "history") {
      await loadDriverHistory({ keepSelection: true });
    } else {
      const inFlightRefresh = nextJobLoadPromise;
      if (inFlightRefresh) await inFlightRefresh.catch(() => {});
      await assertQuietSyncContext(context);
      await loadNextJob();
    }
  } while (quietSyncRefreshQueued && quietFinalRefreshSafe());
  return !quietSyncRefreshQueued;
}

function retainedPhotoRecoveryRunsInBackground(health = offlineHealth) {
  return Number(
    health?.partitionUnsyncedPhotoCount ?? health?.unsyncedPhotoCount ?? 0
  ) > 0;
}

async function prepareQuietSyncHoldForSavedWork() {
  if (!navigator.onLine || !offlineStorageAvailable || !offlinePartition?.partitionKey) return null;
  const partitionKey = offlinePartition.partitionKey;
  const health = await window.DriverOfflineDB.getStorageHealth(partitionKey).catch(() => null);
  if (!health || offlinePartition?.partitionKey !== partitionKey) return null;
  offlineHealth = health;
  // Large retained photos drain sequentially and can take minutes on a weak
  // connection. Keep the local route usable while that evidence uploads.
  if (retainedPhotoRecoveryRunsInBackground(health)) return null;
  const hasSavedWork = Number(health.pendingEventCount || 0) > 0
    || Number(health.reviewRequiredCount || 0) > 0;
  return hasSavedWork
    ? beginQuietSync({ holdScreen: true, immediate: true })
    : null;
}

async function triggerOfflineSync({
  userInitiated = false,
  preparedToken = null,
  suppressHold = false
} = {}) {
  if (!offlinePartition?.partitionKey || !window.DriverOfflineSync) {
    endQuietSync(preparedToken);
    return;
  }
  const context = captureQuietSyncContext();
  const knownSavedWork = Number(offlineHealth?.pendingEventCount || 0) > 0
    || Number(offlineHealth?.partitionUnsyncedPhotoCount || 0) > 0;
  const holdAllowed = !suppressHold && !activeRest && !photoInteractionActive();
  const quietToken = preparedToken || beginQuietSync({
    holdScreen: navigator.onLine && holdAllowed && (userInitiated || knownSavedWork),
    immediate: userInitiated
  });
  let finalStateRendered = false;
  let syncSucceeded = false;
  let syncResult = null;
  let syncError = null;
  let retainedError = null;
  try {
    await assertQuietSyncContext(context);
    const [healthBeforeSync, savedEvents] = await Promise.all([
      window.DriverOfflineDB
        .getStorageHealth(context.partitionKey)
        .catch(() => offlineHealth || {}),
      window.DriverOfflineDB.getPartitionEvents(context.partitionKey)
    ]);
    rememberQuietSyncEvents(savedEvents);
    const hasSavedWork = Number(healthBeforeSync.pendingEventCount || 0) > 0
      || Number(healthBeforeSync.partitionUnsyncedPhotoCount || 0) > 0;
    if (navigator.onLine && holdAllowed && (userInitiated || hasSavedWork)) {
      requestQuietSyncHold(quietToken, { immediate: userInitiated || Boolean(preparedToken) });
    }
    syncResult = await syncCapturedPartition(context);
    await assertQuietSyncContext(context);
    const returnedHealth = syncResult?.health || {};
    const retainedWorkCount = Number(returnedHealth.pendingEventCount || 0)
      + Number(returnedHealth.reviewRequiredCount || 0)
      + Number(returnedHealth.partitionUnsyncedPhotoCount ?? returnedHealth.unsyncedPhotoCount ?? 0);
    if (retainedWorkCount > 0) {
      const persistedSyncState = await window.DriverOfflineDB.getSyncState(context.partitionKey)
        .catch(() => offlineSyncState || {});
      if (offlineRetainedClientError) {
        retainedError = offlineRetainedClientError;
      } else if (persistedSyncState?.lastError) {
        retainedError = Object.assign(new Error(String(persistedSyncState.lastError)), {
          name: String(persistedSyncState.lastErrorName || "Error"),
          code: String(persistedSyncState.lastErrorCode || "driver_retained_sync_error")
        });
      }
    } else {
      offlineRetainedClientError = null;
    }
    offlineStatus.dataset.lastError = retainedError?.message || "";
    await refreshDeferredManifestState({ activateIfSafe: true });
    if (offlineManifest && activeView === "job" && !activeRest && !photoInteractionActive()) {
      await renderOfflineProjection(offlineManifest);
    } else {
      await refreshPendingSamsaraReconciliations();
    }
    await reconcilePendingDutyEvents({ refreshFirst: false });
    finalStateRendered = await renderQuietSyncFinalState(context);
    syncSucceeded = true;
    // A completed upload of an actual ledger event is a stronger connectivity
    // signal than navigator.onLine after a service-worker reload. A no-op sync
    // must not erase the offline marker while the driver is still drafting.
    const synchronizedOfflineEvidence = savedEvents.some((event) => (
      event?.locationStatus === "not_checked_offline"
      && ["pending", "syncing", "foreground_pending"].includes(String(event?.status || "pending"))
    ));
    if (synchronizedOfflineEvidence && retainedWorkCount === 0) markDriverBrowserOnline();
    if (retainedError) void reportDriverClientSyncStatus("error", { error: retainedError, health: returnedHealth });
    else void reportDriverClientSyncStatus("ok", { health: returnedHealth });
    if (userInitiated) {
      showToast(retainedError?.message || (syncResult?.reviewRequired
        ? t("driver.syncReviewRequired", "Synchronization needs Dispatch review.")
        : t("driver.syncComplete", "Synchronization complete")));
    }
  } catch (error) {
    syncError = error;
    const contextStillActive = await assertQuietSyncContext(context)
      .then(() => true)
      .catch(() => false);
    if (error.code !== "driver_session_changed" && contextStillActive) {
      offlineStatus.dataset.lastError = error.message;
      void reportDriverClientSyncStatus("error", { error });
      if (userInitiated) showToast(error.message);
      if (shouldRetryOfflineSyncError(error)) {
        void window.DriverOfflineSync.registerBackgroundSync();
      }
      // A failed sync must never replace newer local-first state with the
      // server's older route/rest state. Re-project only the retained ledger,
      // and never touch an active photo interaction.
      if (offlineManifest && activeView === "job" && !activeRest && !photoInteractionActive()) {
        await renderOfflineProjection(offlineManifest).catch(() => {});
      }
    }
  } finally {
    const contextStillActive = await assertQuietSyncContext(context)
      .then(() => true)
      .catch(() => false);
    if (contextStillActive) await refreshOfflineHealth();
    endQuietSync(quietToken);
    if (syncSucceeded && !quietSyncActive() && quietSyncRefreshQueued) {
      if (!activeRest && !photoInteractionActive()) {
        quietSyncRefreshQueued = false;
        queueLiveRefresh();
      } else {
        onlineRouteRevalidationQueued = true;
      }
    }
  }
  return {
    ok: syncSucceeded,
    error: syncError,
    retainedError,
    reviewRequired: Boolean(syncResult?.reviewRequired),
    finalStateRendered
  };
}

async function queueDriverEvent(eventType, {
  job = currentJob,
  eventPhotos = [],
  details = {},
  locationStatus = "",
  deferSync = false
} = {}) {
  if (!canUseOfflineLedger()) throw new Error(routeManifestExpired()
    ? t("driver.routeExpiredActionBlocked", "This saved route has expired. Reconnect and sign in before recording another action.")
    : t("driver.stopNotProtected", "This stop is not yet protected for offline use."));
  const storedProfile = await window.DriverOfflineDB.getProfile(offlinePartition.partitionKey);
  if (
    !storedProfile
    || storedProfile.locked
    || (
      offlinePartition.sessionGeneration
      && storedProfile.sessionGeneration !== offlinePartition.sessionGeneration
    )
  ) {
    clearDriverSessionMemory();
    renderLogin(t("driver.cachedRouteSessionLocked", "This cached route was locked by a session change in another tab."));
    const error = new Error(t("driver.sessionChangedSignIn", "Driver session changed. Sign in again to continue."));
    error.code = "driver_session_changed";
    throw error;
  }
  const manifestJob = manifestJobFor(job?.jobId);
  const manifestRequiredPhotoCount = eventType === "dvir_captured"
    ? 4
    : eventType === "job_completed"
      ? Number(manifestJob?.requiredPhotos ?? job?.requiredPhotos ?? 0)
      : 0;
  const requiredPhotoCount = Number.isFinite(manifestRequiredPhotoCount)
    ? Math.max(0, Math.floor(manifestRequiredPhotoCount))
    : 0;
  if (
    jobEventRequiresManifestIdentity(eventType)
    && (
      !manifestJob?.jobId
      || !manifestJob.fingerprint
      || !manifestJob.predecessorFingerprint
    )
  ) {
    const error = new Error(t("driver.stopIdentityIncomplete", "This stop's saved route identity is incomplete. Refresh the route before recording this action."));
    error.code = "offline_event_identity_unavailable";
    throw error;
  }
  const offlineLocation = locationCheck?.status === "not_checked_offline" || !navigator.onLine;
  const locationVerificationId = locationCheck?.verificationId || locationCheck?.locationVerificationId || locationCheck?.id || null;
  const locationWasOverridden = locationOverrideApproval.isAccepted(job);
  let event;
  try {
    event = await window.DriverOfflineDB.queueEvent(offlinePartition.partitionKey, {
      manifestId: offlineManifest.manifestId,
      eventType,
      jobId: manifestJob?.jobId || job?.jobId || null,
      jobFingerprint: manifestJob?.fingerprint || job?.fingerprint || null,
      predecessorFingerprint: manifestJob?.predecessorFingerprint || job?.predecessorFingerprint || null,
      occurredAt: new Date().toISOString(),
      locationStatus: locationStatus || (offlineLocation
        ? "not_checked_offline"
        : locationWasOverridden
          ? "warning_overridden"
          : locationCheck?.status === "ok"
            ? "verified"
            : "not_required"),
      locationVerificationId,
      locationOverride: locationWasOverridden,
      initialStatus: deferSync ? "foreground_pending" : "pending",
      requiredPhotoCount,
      enforcePhotoCompletionLimit: eventType === "dvir_captured"
        || (eventType === "job_completed" && Number(job?.requiredPhotos || 0) > 0),
      details: {
        ...details,
        ...(["job_started", "job_completed"].includes(eventType)
          ? { physicalVisitJobIds: driverPhysicalVisitJobIds(manifestJob || job) }
          : {}),
        ...(locationVerificationId ? { locationVerificationId } : {})
      },
      photos: eventPhotos.filter(Boolean)
    });
  } catch (error) {
    offlineRetainedClientError = error;
    offlineStatus.dataset.lastError = String(
      error?.message
      || error
      || t("driver.localSaveFailed", "Local device save failed.")
    );
    renderOfflineStatus();
    void reportDriverClientSyncStatus("error", { error });
    await window.DriverOfflineDB.recordSyncError(offlinePartition.partitionKey, error).catch(() => {});
    throw error;
  }
  if (deferSync) activeForegroundEventIds.add(event.eventId);
  eventPhotos.filter(Boolean).forEach((photo) => window.DriverOfflinePhotos?.revokePhoto(photo));
  await renderOfflineProjection(offlineManifest);
  await refreshOfflineHealth();
  if (!deferSync) {
    void window.DriverOfflineSync.registerBackgroundSync();
    if (navigator.onLine) void triggerOfflineSync({ suppressHold: true });
  }
  return event;
}

async function queuePhysicalTruckSwitch({ samsaraSkipped = false, deferSync = false } = {}) {
  const job = currentJob;
  const event = await queueDriverEvent("truck_switched_physical", {
    job,
    details: {
      fromTruckPlate: job?.fromTruckPlate || dayState?.truckPlate || null,
      toTruckPlate: job?.nextTruckPlate || job?.truckPlate || null,
      samsaraSkipped,
      samsaraReconciliationRequired: driverUsesSamsaraWorkflow()
    },
    locationStatus: navigator.onLine ? "not_required" : "not_checked_offline",
    deferSync
  });
  if (!deferSync) {
    showToast(driverUsesSamsaraWorkflow()
      ? t("driver.physicalSwitchPending", "Physical truck switch saved. Samsara reconciliation is pending.")
      : t("driver.truckSwitchSaved", "Truck switch saved."));
  }
  return event;
}

function foregroundReceiptContext(event, job = currentJob) {
  return {
    eventId: event.eventId,
    deviceOccurredAt: event.occurredAt,
    manifestId: event.manifestId,
    clientSequence: event.clientSequence,
    jobFingerprint: event.jobFingerprint || null,
    predecessorFingerprint: event.predecessorFingerprint || null,
    planRevision: offlineManifest?.planRevision ?? null,
    truckPlate: event.details?.truckPlate
      || event.details?.fromTruckPlate
      || dayState?.truckPlate
      || job?.truckPlate
      || null
  };
}

function foregroundOutcomeUncertain(error) {
  return error?.foregroundLocalReceiptFailed === true
    || String(error?.data?.code || error?.code || "") === "DRIVER_FOREGROUND_OUTCOME_UNCERTAIN";
}

async function runForegroundTruckSwitch({ samsaraSkipped = false } = {}) {
  const switchedJob = currentJob;
  let foregroundEvent = null;
  try {
    foregroundEvent = await queuePhysicalTruckSwitch({ samsaraSkipped, deferSync: true });
    const endpoint = samsaraSkipped ? "skip-samsara" : "confirm-truck-switch";
    const result = await request(`/api/driver/jobs/${encodeURIComponent(switchedJob.jobId)}/${endpoint}`, {
      method: "POST",
      body: JSON.stringify({
        ...foregroundReceiptContext(foregroundEvent, switchedJob),
        autoStartNext: false,
        offlineLocalFirst: true
      })
    });
    await finishForegroundEvent(foregroundEvent, result);
    dayState = result.state || dayState;
    currentJob = withManifestJobIdentity(result.job);
    locationCheck = null;
    locationOverrideApproval.reconcile(currentJob);
    renderJob();
    showToast(samsaraSkipped
      ? t("driver.samsaraSkipped", "Truck switch confirmed in MBBS. Samsara was skipped.")
      : t("driver.switchConfirmed", "Truck switch confirmed"));
    void downloadDayPlan(dayState?.planDate || switchedJob.planDate);
    return true;
  } catch (error) {
    const outcomeUncertain = foregroundOutcomeUncertain(error);
    if (foregroundEvent && (outcomeUncertain || await isGenuineNetworkFailure(error))) {
      await deferForegroundEvent(foregroundEvent);
      if (outcomeUncertain) {
        offlineStatus.dataset.lastError = error.foregroundLocalReceiptFailed
          ? error.message
          : t("driver.truckSwitchOutcomeReview", "Truck-switch outcome needs server review. It will not be replayed.");
        void triggerOfflineSync();
      }
      showToast(error.foregroundLocalReceiptFailed
        ? error.message
        : outcomeUncertain
          ? t("driver.truckSwitchReviewRequired", "Truck switch saved · Review required")
        : driverUsesSamsaraWorkflow()
          ? t("driver.physicalSwitchPending", "Physical truck switch saved. Samsara reconciliation is pending.")
          : t("driver.truckSwitchSaved", "Truck switch saved."));
      return true;
    }
    if (foregroundEvent) await cancelForegroundEvent(foregroundEvent);
    showToast(samsaraSkipped
      ? tf("driver.skipSamsaraFailureDetail", "Could not skip Samsara: {detail}", {
          detail: localizeMessage(error.message)
        })
      : tf("driver.switchFailureDetail", "Truck switch failed: {detail}", {
          detail: localizeMessage(error.message)
        }));
    await loadNextJob().catch(() => renderJob());
    return true;
  }
}

async function queueOfflineDvir(type) {
  await queueDriverEvent("dvir_captured", {
    job: null,
    eventPhotos: dvirPhotos.filter(Boolean),
    details: {
      dvirType: type,
      truckPlate: dayState?.truckPlate || null,
      pendingOnline: true
    },
    locationStatus: "not_checked_offline"
  });
  dvirPhotos = [];
  dvirMode = "";
  showToast(t("driver.inspectionPendingOnline", "Inspection saved · Pending online"));
}

async function finishForegroundEvent(event, result = {}) {
  activeForegroundEventIds.delete(event.eventId);
  try {
    await window.DriverOfflineDB.markForegroundApplied(event.eventId, result);
  } catch (error) {
    offlineRetainedClientError = error;
    offlineStatus.dataset.lastError = String(
      error?.message
      || error
      || t("driver.localReceiptSaveFailed", "Local receipt save failed.")
    );
    renderOfflineStatus();
    void reportDriverClientSyncStatus("error", { error });
    await window.DriverOfflineDB.recordSyncError(offlinePartition.partitionKey, error).catch(() => {});
    error.foregroundLocalReceiptFailed = true;
    throw error;
  }
  await refreshOfflineHealth();
  void window.DriverOfflineSync.registerBackgroundSync();
  if (navigator.onLine) void triggerOfflineSync({ suppressHold: true });
}

async function deferForegroundEvent(event) {
  activeForegroundEventIds.delete(event.eventId);
  await window.DriverOfflineDB.releaseForegroundEvent(event.eventId);
  void window.DriverOfflineSync.registerBackgroundSync();
  await refreshOfflineHealth();
}

async function cancelForegroundEvent(event, draftKey = "") {
  activeForegroundEventIds.delete(event.eventId);
  await window.DriverOfflineDB.cancelForegroundEvent(event.eventId, draftKey);
  await renderOfflineProjection(offlineManifest);
  await refreshOfflineHealth();
}

async function refreshPendingSamsaraReconciliations() {
  if (!offlineStorageAvailable || !offlinePartition?.partitionKey || !offlineManifest) {
    pendingDvirEvent = null;
    pendingDvirPhotos = [];
    pendingDutyEvents = [];
    activeForegroundEventIds.clear();
    return;
  }
  const events = await window.DriverOfflineDB.getProjectionEvents(
    offlinePartition.partitionKey,
    offlineManifest
  );
  pendingDvirEvent = [...events].reverse().find(dvirEventNeedsReconciliation) || null;
  pendingDutyEvents = events.filter(dutyEventNeedsReconciliation);
  pendingDvirPhotos = pendingDvirEvent
    ? await window.DriverOfflineDB.getEventPhotos(pendingDvirEvent.eventId)
    : [];
}

async function reconcilePendingDutyEvents({ refreshFirst = true } = {}) {
  if (samsaraReconcileRunning || !authToken || !navigator.onLine) return;
  if (refreshFirst) await refreshPendingSamsaraReconciliations();
  if (!pendingDutyEvents.length) return;
  samsaraReconcileRunning = true;
  let reconciled = true;
  try {
    for (const pendingEvent of [...pendingDutyEvents]) {
      try {
        const response = await request(`/api/driver/offline-events/${encodeURIComponent(pendingEvent.eventId)}/reconcile-duty`, {
          method: "POST",
          body: JSON.stringify({})
        });
        await window.DriverOfflineDB.mergeEventResult(pendingEvent.eventId, {
          ...(response.event?.result || response.result || response.reconciliation || {}),
          samsaraDutyPendingOnline: false,
          samsaraDutyReconciled: true
        });
      } catch (error) {
        if (error.data?.reviewRequired) {
          await window.DriverOfflineDB.markEventReviewRequired(pendingEvent.eventId, error.message, {
            samsaraDutyPendingOnline: false,
            samsaraDutyReconciled: false,
            samsaraDutyReconciliationConflict: true
          });
        }
        reconciled = false;
        offlineStatus.dataset.lastError = error.data?.reviewRequired
          ? tf("driver.dutyReviewError", "Duty-state action requires Dispatch review: {detail}", {
              detail: localizeMessage(error.message)
            })
          : tf("driver.dutyPendingError", "Duty-state handoff remains Pending online: {detail}", {
              detail: localizeMessage(error.message)
            });
        break;
      }
    }
  } finally {
    samsaraReconcileRunning = false;
    await refreshPendingSamsaraReconciliations();
    await refreshDeferredManifestState({ activateIfSafe: true });
    await refreshOfflineHealth();
    if (activeView === "job" && !photoInteractionActive()) renderJob();
  }
  return reconciled;
}

async function reconcilePendingDvir() {
  if (!pendingDvirEvent || !authToken || !navigator.onLine || samsaraReconcileRunning) return;
  const event = pendingDvirEvent;
  samsaraReconcileRunning = true;
  try {
    const response = await request(`/api/driver/offline-events/${encodeURIComponent(event.eventId)}/reconcile-dvir`, {
      method: "POST",
      body: JSON.stringify({})
    });
    await window.DriverOfflineDB.mergeEventResult(event.eventId, {
      ...(response.event?.result || response.result || {}),
      pendingOnline: false,
      samsaraReconciled: true
    });
    offlineStatus.dataset.lastError = "";
    showToast(t("driver.pendingInspectionSubmitted", "Pending inspection submitted to Samsara"));
    await refreshPendingSamsaraReconciliations();
    await loadNextJob();
    void downloadDayPlan(dayState?.planDate);
  } catch (error) {
    if (error.data?.reviewRequired) {
      await window.DriverOfflineDB.markEventReviewRequired(event.eventId, error.message, {
        pendingOnline: false,
        samsaraReconciled: false,
        reconciliationConflict: true
      });
      await refreshPendingSamsaraReconciliations();
    }
    offlineStatus.dataset.lastError = error.data?.reviewRequired
      ? tf("driver.dvirReviewError", "DVIR requires Dispatch review: {detail}", {
          detail: localizeMessage(error.message)
        })
      : tf("driver.dvirPendingError", "DVIR remains Pending online: {detail}", {
          detail: localizeMessage(error.message)
        });
    showToast(error.message);
    renderJob();
  } finally {
    samsaraReconcileRunning = false;
    await refreshOfflineHealth();
  }
}

async function loadDriverHistory({ keepSelection = false } = {}) {
  activeView = "history";
  clearCountdownTimer();
  const params = new URLSearchParams({ limit: "100" });
  if (historyDate) params.set("date", historyDate);
  const result = await request(`/api/driver/history?${params.toString()}`);
  driverHistory = [...(result.records || [])].sort((left, right) =>
    new Date(left.createdAt || 0) - new Date(right.createdAt || 0)
      || String(left.id || "").localeCompare(String(right.id || ""))
  );
  if (!keepSelection || !driverHistory.some((item) => String(item.id) === String(selectedHistoryId))) selectedHistoryId = "";
  renderDriverHistory();
}

function historyTypeText(record) {
  if (!record) return t("driver.record", "Record");
  if (record.type === "pre_dvir") return t("driver.preTrip", "Pre-Trip");
  if (record.type === "post_dvir") return t("driver.postTrip", "Post-Trip");
  return record.title || t("driver.stop", "Stop");
}

function renderHistoryPhotos(record) {
  const photos = (record?.photos || []).filter(Boolean);
  if (!photos.length) return `<div class="history-empty small">${t("driver.noPhotosSaved", "No photos saved for this record.")}</div>`;
  return `
    <div class="history-photo-grid">
      ${photos.map((photo, index) => `
        <button class="history-photo-button" data-action="open-history-photo" data-photo-ref="${escapeHtml(photo)}" data-photo-label="${tf("driver.historyPhotoNumber", "{type} photo {number}", { type: historyTypeText(record), number: index + 1 })}" type="button">
          <img src="${photoImgSrc(photo)}" alt="${tf("driver.historyPhotoNumber", "{type} photo {number}", { type: historyTypeText(record), number: index + 1 })}" />
        </button>
      `).join("")}
    </div>
  `;
}

function renderDriverHistory() {
  const historyWasVisible = Boolean(app.querySelector(".history-panel"));
  const previousScrollTop = historyWasVisible ? Number(app.querySelector(".driver-content")?.scrollTop || 0) : 0;
  shell(`
    <section class="history-panel">
      <div class="history-controls">
        <div class="history-head">
          <div>
            <p>${escapeHtml(driver?.name || t("stats.driver", "Driver"))}</p>
            <h2>${t("driver.personalHistory", "Personal History")}</h2>
          </div>
          <button class="secondary compact history-back-button" data-action="back-job" type="button">${t("common.back", "Back")}</button>
        </div>
        <div class="history-filter">
          <input id="driverHistoryDate" type="date" value="${escapeHtml(historyDate)}" />
          <button class="secondary compact" data-action="refresh-history" type="button">${t("common.refresh", "Refresh")}</button>
        </div>
      </div>
      <div class="history-list">
        ${driverHistory.map((record) => {
          const expanded = String(record.id) === String(selectedHistoryId);
          return `
          <section class="history-entry ${expanded ? "expanded" : ""}">
            <button class="history-record ${expanded ? "active" : ""}" data-action="select-history" data-record="${escapeHtml(record.id)}" aria-expanded="${expanded}" type="button">
              <span class="history-record-copy">
                <strong>${escapeHtml(historyTypeText(record))}</strong>
                <span>${escapeHtml(record.reference || record.truckPlate || "-")}</span>
              </span>
              <span class="history-record-side">
                <em>${dateTimeText(record.createdAt)}</em>
                <span class="history-toggle-symbol" aria-hidden="true">${expanded ? "-" : "+"}</span>
              </span>
            </button>
            ${expanded ? `<div class="history-inline-detail">
              <div class="history-detail-title">
                <strong>${escapeHtml(historyTypeText(record))}</strong>
                <span>${escapeHtml(localizeMessage(record.status || ""))}</span>
              </div>
              <div class="history-meta">
                <span>${escapeHtml(planDateText(record.planDate))}</span>
                <span>${escapeHtml(record.truckPlate || "")}</span>
                <span>${escapeHtml(record.details?.loadName || record.details?.samsaraDvirId || "")}</span>
              </div>
              ${record.details?.driverRemark ? `<p class="history-driver-remark"><strong>${t("driver.photoRemark", "Driver remark")}:</strong> ${escapeHtml(record.details.driverRemark)}</p>` : ""}
              ${renderHistoryPhotos(record)}
            </div>` : ""}
          </section>`;
        }).join("") || `<div class="history-empty">${t("driver.noHistory", "No history for this date.")}</div>`}
      </div>
    </section>
  `);
  const historyScroller = app.querySelector(".driver-content");
  if (historyScroller) historyScroller.scrollTop = previousScrollTop;
}

function renderCachedDriverWorkView() {
  activeView = "job";
  if (!currentJob && ["pre", "post"].includes(dvirMode)) return renderDvir(dvirMode);
  return renderJob();
}

async function loadNextJob() {
  if (nextJobLoadPromise) return nextJobLoadPromise;
  nextJobLoadPromise = (async () => {
    const loadEpoch = driverInteractionEpoch;
    activeView = "job";
    clearRestTimer();
    let result;
    try {
      result = await request("/api/driver/next-job");
      if (routeRefreshWasSuperseded(loadEpoch)) return;
      const deferIncomingManifest = result?.routeBootstrap
        ? await shouldDeferIncomingManifest(result.routeBootstrap)
        : false;
      if (routeRefreshWasSuperseded(loadEpoch)) return;
      if (result?.routeBootstrap && deferIncomingManifest) {
        await saveRouteBootstrap(result, { activate: false });
        if (routeRefreshWasSuperseded(loadEpoch)) return;
        offlineCachedView = true;
        await renderOfflineProjection(offlineManifest);
        void downloadDayPlan(manifestPlanDate(result.routeBootstrap));
        return;
      }
      offlineCachedView = false;
      if (result?.state) dayState = result.state;
    } catch (error) {
      if (routeRefreshWasSuperseded(loadEpoch)) return;
      if (error.data?.state) {
        const deferIncomingManifest = error.data?.routeBootstrap
          ? await shouldDeferIncomingManifest(error.data.routeBootstrap)
          : false;
        if (routeRefreshWasSuperseded(loadEpoch)) return;
        if (error.data?.routeBootstrap && deferIncomingManifest) {
          await saveRouteBootstrap(error.data, { activate: false });
          if (routeRefreshWasSuperseded(loadEpoch)) return;
          offlineCachedView = true;
          await renderOfflineProjection(offlineManifest);
          void downloadDayPlan(manifestPlanDate(error.data.routeBootstrap));
          return;
        }
        dayState = error.data.state;
        if (error.data?.routeBootstrap) {
          void saveRouteBootstrap(error.data).then(() => downloadDayPlan(dayState?.planDate));
        } else {
          void downloadDayPlan(dayState?.planDate);
        }
        if (driverUsesSamsaraWorkflow()) {
          currentJob = null;
          dvirPhotos = [];
          return renderDvir("pre", error.message);
        }
      }
      const genuineNetworkFailure = await isGenuineNetworkFailure(error);
      if (routeRefreshWasSuperseded(loadEpoch)) return;
      if (genuineNetworkFailure && await loadCachedRoute()) return;
      throw error;
    }
    if (routeRefreshWasSuperseded(loadEpoch)) return;
    currentJob = withManifestJobIdentity(result.job, result.routeBootstrap);
    activeRest = acceptDriverRestCandidate(result.rest);
    restSummary = result.restSummary || null;
    photos = [];
    driverRemark = "";
    binDraft = null;
    dvirMode = "";
    dvirPhotos = [];
    photoPromptOpen = false;
    locationCheck = null;
    locationOverrideApproval.reconcile(currentJob);
    if (driverUsesSamsaraWorkflow() && dayState?.truckPlate && (dayState.preDvirStatus !== "complete" || !dayState.samsaraOnDutyConfirmed || !dayState.samsaraPreDvirConfirmed)) {
      currentJob = null;
      const message = dayState.preDvirStatus === "complete" && (!dayState.samsaraOnDutyConfirmed || !dayState.samsaraPreDvirConfirmed)
        ? tf("driver.samsaraInspectionRetry", "Samsara did not receive/verify the inspection. Please redo it in MBBS PWA. {detail}", {
            detail: localizeMessage(dayState.samsaraOnDutyError || t("driver.samsaraDvirPermissionHelp", "Check Samsara DVIR author ID and Write DVIRs permission."))
          })
        : "";
      renderDvir("pre", message);
      void (async () => {
        await saveRouteBootstrap(result);
        await restoreDraftPhotos("dvir", "pre");
        renderDvir("pre", message);
        await downloadDayPlan(dayState?.planDate);
      })();
      return;
    }
    if (driverUsesSamsaraWorkflow() && !currentJob && dayState?.allJobsComplete && dayState.postDvirStatus !== "complete") {
      const message = t("driver.postTripRequired", "All assigned jobs are complete. MBBS post-trip inspection is required before logout.");
      renderDvir("post", message);
      void (async () => {
        await saveRouteBootstrap(result);
        await restoreDraftPhotos("dvir", "post");
        renderDvir("post", message);
        await downloadDayPlan(dayState?.planDate);
      })();
      return;
    }
    renderJob();
    const renderedEpoch = driverInteractionEpoch;
    void (async () => {
      await saveRouteBootstrap(result);
      if (
        renderedEpoch === driverInteractionEpoch
        && currentJob
        && String(currentJob.jobId || "") === String(result.job?.jobId || "")
      ) {
        currentJob = withManifestJobIdentity(currentJob, result.routeBootstrap);
        await Promise.all([
          restoreDraftPhotos("job"),
          restoreDriverRemarkDraft(),
          restoreDriverBinDraft()
        ]);
        if (
          renderedEpoch === driverInteractionEpoch
          && (photos.some(Boolean) || Boolean(driverRemark) || driverBinDraftHasContent())
          && currentJob?.jobId === result.job?.jobId
        ) renderJob();
      }
      await downloadDayPlan(dayState?.planDate || currentJob?.planDate);
    })();
  })();
  try {
    return await nextJobLoadPromise;
  } finally {
    nextJobLoadPromise = null;
  }
}

function eventTargetsCurrentDriver(event = {}) {
  const eventDriver = String(event.payload?.driverLogin || "").trim().toLowerCase();
  if (!eventDriver || !String(event.type || "").startsWith("driver.")) return true;
  return eventDriver === String(driver?.login || "").trim().toLowerCase();
}

function eventTargetsCurrentDeliveryInstruction(event = {}) {
  if (event.type !== "delivery.instructions.updated" || currentJob?.stopType !== "dropoff") return false;
  const orderRef = String(event.payload?.orderRef || "").trim().toLowerCase();
  const orderId = String(event.payload?.orderId || "").trim();
  return (currentJob.deliveryInstructions?.orders || []).some((order) =>
    (orderRef && String(order?.orderRef || "").trim().toLowerCase() === orderRef)
    || (orderId && String(order?.orderId || "") === orderId)
  );
}

async function refreshCurrentDeliveryInstructions(event) {
  if (!eventTargetsCurrentDeliveryInstruction(event) || !navigator.onLine) return false;
  const jobId = String(currentJob?.jobId || "");
  const path = new URL(`/api/driver/jobs/${encodeURIComponent(jobId)}/delivery-instructions`, window.location.origin);
  path.searchParams.set("language", driverInstructionLanguage());
  const result = await request(`${path.pathname}${path.search}`);
  if (!currentJob || String(currentJob.jobId || "") !== jobId) return false;
  currentJob = {
    ...currentJob,
    deliveryInstructions: result.deliveryInstructions || { revision: 0, orders: [] }
  };
  const scrollContainer = app.querySelector(".driver-content");
  const scrollTop = Number(scrollContainer?.scrollTop || 0);
  const details = app.querySelector(".stop-detail-page");
  if (details && !photoInteractionActive()) details.outerHTML = renderStopDetails(currentJob);
  if (scrollContainer) scrollContainer.scrollTop = scrollTop;
  void prepareDeliveryInstructionMedia(currentJob, { force: true });
  if (driverOfflineModeEnabled && currentJob?.planDate) {
    void downloadDayPlan(currentJob.planDate, { forceRefresh: true });
  }
  showToast(t("driver.deliveryInstructionsUpdated", "Delivery instructions updated"));
  return true;
}

async function runLiveRefresh() {
  if (quietSyncActive()) {
    quietSyncRefreshQueued = true;
    return;
  }
  if (liveRefreshRunning) {
    liveRefreshQueued = true;
    return;
  }
  liveRefreshRunning = true;
  try {
    do {
      liveRefreshQueued = false;
      if (quietSyncActive()) {
        quietSyncRefreshQueued = true;
        return;
      }
      if (!driver || activeRest || photoInteractionActive()) return;
      if (activeView === "history") {
        await loadDriverHistory({ keepSelection: true });
        continue;
      }
      const beforeJobId = currentJob?.jobId || "";
      await loadNextJob();
      if ((currentJob?.jobId || "") !== beforeJobId) showToast(t("driver.jobUpdated", "Job updated"));
    } while (liveRefreshQueued);
  } catch (error) {
    showToast(error.message);
  } finally {
    liveRefreshRunning = false;
  }
}

function queueLiveRefresh() {
  liveRefreshQueued = true;
  if (liveRefreshTimer) return;
  liveRefreshTimer = window.setTimeout(() => {
    liveRefreshTimer = null;
    void runLiveRefresh();
  }, LIVE_REFRESH_DEBOUNCE_MS);
}

async function flushDeferredLiveRefresh() {
  if (
    !driver
    || !navigator.onLine
    || quietSyncActive()
    || activeRest
    || photoInteractionActive()
    || (!quietSyncRefreshQueued && !liveRefreshQueued)
  ) return false;
  const partitionKey = offlinePartition?.partitionKey || "";
  const health = partitionKey
    ? await window.DriverOfflineDB.getStorageHealth(partitionKey).catch(() => offlineHealth || {})
    : (offlineHealth || {});
  if (
    photoInteractionActive()
    || quietSyncActive()
    || (partitionKey && partitionKey !== offlinePartition?.partitionKey)
  ) return false;
  if (Number(health.pendingEventCount || 0) > 0) {
    void triggerOfflineSync({ suppressHold: true });
    return false;
  }
  quietSyncRefreshQueued = false;
  queueLiveRefresh();
  return true;
}

function connectEvents() {
  if (!authToken || eventSource) return;
  eventSource = new EventSource(`/api/events?client=driver&token=${encodeURIComponent(authToken)}`);
  eventSource.addEventListener("app-event", async (message) => {
    let event;
    try {
      event = JSON.parse(message.data || "{}");
    } catch {
      return;
    }
    if (event.type === "connected") return;
    const relevant = [
      "dispatch.plan.saved",
      "dispatch.plan.confirmed",
      "dispatch.plan.reopened",
      "dispatch.orders.updated",
      "driver.job.started",
      "driver.job.completed",
      "driver.job.reopened",
      "driver.truck.switched",
      "driver.truck.switch.overridden",
      "driver.truck.switch.samsara_skipped",
      "driver.offline.review.resolved",
      "dispatch.setup.updated",
      "driver.rest.started",
      "driver.rest.ended",
      "delivery.order.loaded",
      "delivery.instructions.updated"
    ].includes(event.type);
    if (!relevant || !driver) return;
    if (!eventTargetsCurrentDriver(event)) return;
    if (isQuietSyncEcho(event)) return;
    if (event.type === "delivery.instructions.updated") {
      try {
        await refreshCurrentDeliveryInstructions(event);
      } catch (error) {
        if (eventTargetsCurrentDeliveryInstruction(event)) showToast(error.message);
      }
      return;
    }
    if (event.type === "driver.offline.review.resolved") {
      void triggerOfflineSync();
      return;
    }
    if (quietSyncActive()) {
      quietSyncRefreshQueued = true;
      return;
    }
    if (activeRest || photoInteractionActive()) {
      quietSyncRefreshQueued = true;
      onlineRouteRevalidationQueued = true;
      showToast(activeRest
        ? t("driver.routeUpdatedEndRest", "Route updated. End rest to refresh the stop.")
        : t("driver.jobUpdatedClosePhotos", "Job updated. Finish or close photos to refresh."));
      return;
    }
    queueLiveRefresh();
  });
  eventSource.onerror = () => {
    eventSource?.close();
    eventSource = null;
    if (authToken) window.setTimeout(connectEvents, 3000);
  };
}

function disconnectEvents() {
  eventSource?.close();
  eventSource = null;
  clearTimeout(liveRefreshTimer);
  liveRefreshTimer = null;
  liveRefreshQueued = false;
}

app.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "reload-driver-pwa") {
    await reloadLatestDriverPwa(button);
    return;
  }
  if (action === "repair-driver-pwa") {
    await repairDriverAppCache(button);
    return;
  }
  if (action === "retry-instruction-image") {
    const mediaId = String(button.dataset.mediaId || "").toLowerCase();
    const media = currentDeliveryInstructionMedia(mediaId);
    if (!media || !navigator.onLine) return;
    const cached = instructionMediaObjectUrls.get(mediaId);
    if (cached?.url) URL.revokeObjectURL(cached.url);
    instructionMediaObjectUrls.delete(mediaId);
    instructionMediaRetryNonces.set(mediaId, String(Date.now()));
    patchDriverInstructionMedia(media);
    if (currentJob) void prepareDeliveryInstructionMedia(currentJob, { force: true });
    return;
  }
  if (driverPwaUpdateRequired) {
    renderDriverPwaUpdateRequired();
    return;
  }
  if (DRIVER_ROUTE_PROTECTED_ACTIONS.has(action) && !driverActionProtectionState().ready) {
    const protection = driverActionProtectionState();
    applyDriverActionProtectionGate();
    showToast(protection.message);
    return;
  }
  const mutationToken = beginDriverMutation(action, button);
  if (mutationToken === false) return;
  try {
  if (DRIVER_INTERACTION_ACTIONS.has(action)) markDriverInteraction();
  if (action === "reconcile-dvir") {
    if (samsaraReconcileRunning) {
      showToast(t("driver.samsaraUpdateRunning", "Another Samsara update is still running."));
      return;
    }
    button.disabled = true;
    button.textContent = t("common.submitting", "Submitting...");
    await reconcilePendingDvir();
    return;
  }
  if (action === "logout") {
    const logoutToken = authToken;
    const logoutDevice = offlineDeviceId;
    if (offlinePartition?.partitionKey) {
      await window.DriverOfflineDB.lockPartition(offlinePartition.partitionKey).catch(() => {});
    }
    localStorage.removeItem(TOKEN_KEY);
    clearDriverSessionMemory();
    fetch("/api/driver/logout", {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        [DRIVER_PWA_VERSION_HEADER]: DRIVER_PWA_CLIENT_VERSION,
        ...(logoutToken ? { Authorization: `Bearer ${logoutToken}` } : {}),
        ...(logoutDevice ? { "X-MBBS-Driver-Device": logoutDevice } : {})
      },
      body: JSON.stringify({ pendingOffline: true })
    }).catch(() => {});
    return renderLogin();
  }
  if (action === "refresh") {
    try {
      await loadNextJob();
      showToast(t("driver.jobRefreshed", "Job refreshed"));
    } catch (error) {
      showToast(error.message);
    }
  }
  if (action === "open-history") {
    try {
      await loadDriverHistory();
    } catch (error) {
      showToast(error.message);
    }
  }
  if (action === "back-job") {
    renderCachedDriverWorkView();
    void loadNextJob().catch((error) => showToast(error.message));
    return;
  }
  if (action === "refresh-history") {
    historyDate = document.getElementById("driverHistoryDate")?.value || historyDate;
    try {
      await loadDriverHistory({ keepSelection: true });
    } catch (error) {
      showToast(error.message);
    }
  }
  if (action === "select-history") {
    const recordId = button.dataset.record || "";
    selectedHistoryId = String(selectedHistoryId) === String(recordId) ? "" : recordId;
    return renderDriverHistory();
  }
  if (action === "open-history-photo") {
    openPhotoLightbox(button.dataset.photoRef, button.dataset.photoLabel || t("driver.historyPhoto", "History photo"));
    return;
  }
  if (action === "show-photo") {
    const photoJob = currentJob;
    if (!(await ensureAuthoritativeJobBeforeAction(photoJob))) return;
    const photoOpenEpoch = driverInteractionEpoch;
    if (!(await ensureLocationApprovalBeforeConfirmation())) return;
    if (routeRefreshWasSuperseded(photoOpenEpoch)) return;
    photoPromptOpen = true;
    await restoreDraftPhotos("job");
    if (routeRefreshWasSuperseded(photoOpenEpoch)) return;
    return renderJob();
  }
  if (action === "recheck-location") {
    if (!(await ensureAuthoritativeJobBeforeAction(currentJob))) return;
    await checkCurrentJobLocation();
    return;
  }
  if (action === "override-location") {
    const overrideJob = currentJob;
    if (!(await ensureAuthoritativeJobBeforeAction(overrideJob))) return;
    if (!currentJob || String(currentJob.jobId || "") !== String(overrideJob?.jobId || "")) return renderJob();
    locationOverrideApproval.accept(currentJob);
    showToast(t("driver.locationOverrideAccepted", "Location override accepted for this stop"));
    return renderJob();
  }
  if (action === "start-rest") {
    button.disabled = true;
    button.textContent = t("driver.startingRest", "Starting rest...");
    if (!(await prepareOfflineRecord())) return renderJob();
    if (canUseOfflineLedger()) {
      try {
        const restId = window.DriverOfflineDB.createUuid();
        await queueDriverEvent("rest_started", {
          job: currentJob,
          details: {
            restId,
            nextJobId: currentJob?.jobId || null
          }
        });
        showToast(t("driver.restStarted", "Rest started"));
        return renderRest();
      } catch (error) {
        showToast(error.message);
        return renderJob();
      }
    }
    try {
      const result = await request("/api/driver/rest/start", {
        method: "POST",
        body: JSON.stringify({})
      });
      activeRest = acceptDriverRestCandidate(result.rest);
      restSummary = result.restSummary || restSummary;
      currentJob = withManifestJobIdentity(result.job) || currentJob;
      showToast(t("driver.restStarted", "Rest started"));
      return renderRest();
    } catch (error) {
      showToast(error.message);
      return renderJob();
    }
  }
  if (action === "end-rest") {
    const endingRest = activeRest;
    button.disabled = true;
    button.textContent = t("driver.endingRest", "Ending rest...");
    if (!(await prepareOfflineRecord())) return renderRest();
    if (canUseOfflineLedger()) {
      try {
        await queueDriverEvent("rest_ended", {
          job: currentJob,
          details: {
            restId: activeRest?.restId || activeRest?.id || null,
            startedAt: activeRest?.startedAt || null
          }
        });
        markDriverRestEnded(endingRest);
        showToast(t("driver.restEnded", "Rest ended"));
        void flushDeferredLiveRefresh();
        void flushQueuedOnlineRouteRevalidation();
        return renderJob();
      } catch (error) {
        showToast(error.message);
        return renderRest();
      }
    }
    try {
      const result = await request("/api/driver/rest/end", {
        method: "POST",
        body: JSON.stringify({})
      });
      markDriverRestEnded(result.rest || endingRest);
      restSummary = result.restSummary || restSummary;
      currentJob = withManifestJobIdentity(result.job) || currentJob;
      showToast(t("driver.restEnded", "Rest ended"));
      void flushDeferredLiveRefresh();
      void flushQueuedOnlineRouteRevalidation();
      return renderJob();
    } catch (error) {
      showToast(error.message);
      return renderRest();
    }
  }
  if (action === "close-photo") {
    photoPromptOpen = false;
    finishPhotoCapture();
    renderJob();
    void flushDeferredLiveRefresh();
    void flushQueuedOnlineRouteRevalidation();
    return;
  }
  if (action === "switch-camera") {
    switchCameraFacing();
    if (dvirMode) return renderDvir(dvirMode);
    return renderJob();
  }
  if (action === "take-photo") {
    const input = app.querySelector(`input[data-photo-index="${button.dataset.photoIndex}"][data-photo-source="camera"]`);
    launchPhotoPicker(input);
  }
  if (action === "choose-gallery-photo") {
    const input = app.querySelector(`input[data-photo-index="${button.dataset.photoIndex}"][data-photo-source="gallery"]`);
    launchPhotoPicker(input);
  }
  if (action === "take-dvir-photo") {
    const input = app.querySelector(`input[data-dvir-photo-index="${button.dataset.dvirPhotoIndex}"][data-photo-source="camera"]`);
    launchPhotoPicker(input);
  }
  if (action === "choose-dvir-gallery-photo") {
    const input = app.querySelector(`input[data-dvir-photo-index="${button.dataset.dvirPhotoIndex}"][data-photo-source="gallery"]`);
    launchPhotoPicker(input);
  }
  if (action === "add-job-photo") {
    photos.push("");
    return renderJob();
  }
  if (action === "remove-job-photo") {
    if (photos.length > Math.max(2, Number(currentJob?.requiredPhotos || 0))) {
      const removed = photos.pop();
      if (removed?.photoId) await window.DriverOfflineDB.deleteDraftPhoto(removed.photoId).catch(() => {});
      window.DriverOfflinePhotos?.revokePhoto(removed);
    }
    return renderJob();
  }
  if (action === "add-dvir-photo") {
    dvirPhotos.push("");
    return renderDvir(dvirMode || "pre");
  }
  if (action === "remove-dvir-photo") {
    if (dvirPhotos.length > 4) {
      const removed = dvirPhotos.pop();
      if (removed?.photoId) await window.DriverOfflineDB.deleteDraftPhoto(removed.photoId).catch(() => {});
      window.DriverOfflinePhotos?.revokePhoto(removed);
    }
    return renderDvir(dvirMode || "pre");
  }
  if (action === "submit-dvir") {
    button.disabled = true;
    button.textContent = t("common.uploading", "Uploading...");
    const type = dvirMode || "pre";
    if (!(await prepareOfflineRecord())) return renderDvir(type);
    if (!navigator.onLine && canUseOfflineLedger()) {
      try {
        await queueOfflineDvir(type);
      } catch (error) {
        showToast(error.message);
        renderDvir(type, error.message);
      }
      return;
    }
    if (canUseOfflineLedger()) {
      const submittedDvirPhotos = dvirPhotos.filter(Boolean);
      const draftKey = currentPhotoDraftKey("dvir", type);
      let foregroundEvent = null;
      let foregroundRegistered = false;
      try {
        foregroundEvent = await queueDriverEvent("dvir_captured", {
          job: null,
          eventPhotos: submittedDvirPhotos,
          details: {
            dvirType: type,
            truckPlate: dayState?.truckPlate || null,
            pendingOnline: true
          },
          locationStatus: "not_required",
          deferSync: true
        });
        await window.DriverOfflineSync.registerForegroundEvent(
          offlinePartition.partitionKey,
          foregroundEvent.eventId
        );
        foregroundRegistered = true;
        const uploadedPhotos = await uploadDriverPhotos(submittedDvirPhotos, {
          recordType: type === "post" ? "driver-dvir-post-photo" : "driver-dvir-pre-photo",
          dvirType: type,
          manifestId: offlineManifest.manifestId,
          eventId: foregroundEvent.eventId,
          offlineEventUpload: true
        });
        await window.DriverOfflineSync.confirmForegroundEvidence(
          offlinePartition.partitionKey,
          foregroundEvent.eventId
        );
        const result = await request("/api/driver/dvir", {
          method: "POST",
          body: JSON.stringify({
            type,
            photoDataUrls: uploadedPhotos,
            ...foregroundReceiptContext(foregroundEvent)
          })
        });
        await finishForegroundEvent(foregroundEvent, {
          ...result,
          pendingOnline: false,
          samsaraReconciled: true
        });
        dayState = result.state;
        dvirPhotos = [];
        dvirMode = "";
        const warning = result.samsaraError
          ? tf("driver.samsaraDidNotReceive", "Samsara did not receive it: {detail}", {
              detail: localizeMessage(result.samsaraError)
            })
          : t("driver.inspectionSamsaraConfirmed", "MBBS inspection saved. Samsara confirmed.");
        showToast(warning);
        await loadNextJob();
      } catch (error) {
        const outcomeUncertain = foregroundOutcomeUncertain(error);
        const reviewRequired = error.data?.reviewRequired === true;
        if (foregroundEvent && reviewRequired) {
          await window.DriverOfflineDB.markEventReviewRequired(
            foregroundEvent.eventId,
            error.message,
            error.data
          );
        }
        if (
          foregroundEvent
          && (
            foregroundRegistered
            || error.data?.serverRegistered === true
            || outcomeUncertain
            || await isGenuineNetworkFailure(error)
          )
        ) {
          await deferForegroundEvent(foregroundEvent);
          if (outcomeUncertain || reviewRequired) {
            offlineStatus.dataset.lastError = error.foregroundLocalReceiptFailed
              ? error.message
              : t("driver.inspectionOutcomeReview", "Inspection outcome needs server review. It will not be replayed.");
            void triggerOfflineSync();
          }
          showToast(error.foregroundLocalReceiptFailed
            ? error.message
            : outcomeUncertain || reviewRequired
              ? t("driver.inspectionReviewRequired", "Inspection saved · Review required")
            : t("driver.inspectionPendingOnline", "Inspection saved · Pending online"));
          return;
        }
        if (foregroundEvent) await cancelForegroundEvent(foregroundEvent, draftKey);
        showToast(error.message);
        renderDvir(type, error.message);
      }
      return;
    }
    try {
      const submittedDvirPhotos = dvirPhotos.filter(Boolean);
      const uploadedPhotos = await uploadDriverPhotos(submittedDvirPhotos, {
        recordType: type === "post" ? "driver-dvir-post-photo" : "driver-dvir-pre-photo",
        dvirType: type
      });
      button.textContent = t("common.saving", "Saving...");
      const result = await request("/api/driver/dvir", {
        method: "POST",
        body: JSON.stringify({ type, photoDataUrls: uploadedPhotos })
      });
      dayState = result.state;
      await clearLegacyDraftPhotos(submittedDvirPhotos);
      const warning = result.samsaraError
        ? tf("driver.samsaraDidNotReceive", "Samsara did not receive it: {detail}", {
            detail: localizeMessage(result.samsaraError)
          })
        : t("driver.inspectionSamsaraConfirmed", "MBBS inspection saved. Samsara confirmed.");
      dvirPhotos = [];
      dvirMode = "";
      showToast(warning);
      await loadNextJob();
    } catch (error) {
      showToast(error.message);
      renderDvir(dvirMode || "pre", error.message);
    }
  }
  if (action === "skip-dvir") {
    button.disabled = true;
    button.textContent = t("driver.skippingDvirTest", "Skipping DVIR Test...");
    try {
      const skippedPhotos = dvirPhotos.filter(Boolean);
      const result = await request("/api/driver/dvir/skip", {
        method: "POST",
        body: JSON.stringify({ type: dvirMode || "pre" })
      });
      dayState = result.state;
      await clearLegacyDraftPhotos(skippedPhotos);
      dvirPhotos = [];
      dvirMode = "";
      showToast(t("driver.dvirSkippedTest", "DVIR skipped for testing"));
      await loadNextJob();
    } catch (error) {
      showToast(error.message);
      renderDvir(dvirMode || "pre", error.message);
    }
  }
  if (action === "start-job" && currentJob) {
    const planExecution = driverPlanExecutionDecision(currentJob.planDate);
    if (!planExecution.allowed) {
      showToast(planExecution.message);
      return renderJob();
    }
    if (activeRest) {
      showToast(t("driver.endRestBeforeStart", "End rest time before starting the next job."));
      return renderRest();
    }
    const expectedJob = currentJob;
    if (!(await ensureAuthoritativeJobBeforeAction(expectedJob))) return;
    button.disabled = true;
    button.textContent = `${t("common.start", "Start")}...`;
    if (!(await prepareOfflineRecord())) return renderJob();
    if (canUseOfflineLedger()) {
      const startedJob = currentJob;
      if (isDriverBinJob(startedJob)) {
        try {
          await queueDriverEvent("job_started", {
            job: startedJob,
            details: {
              truckPlate: dayState?.truckPlate || startedJob?.truckPlate || null
            },
            deferSync: false
          });
          locationCheck = null;
          locationOverrideApproval.clear();
          renderJob();
          showToast(t("driver.binJobStarted", "BIN stop saved on this device"));
          if (navigator.onLine) checkCurrentJobLocation().catch((error) => showToast(error.message));
        } catch (error) {
          showToast(error.message);
          renderJob();
        }
        return;
      }
      let foregroundEvent = null;
      try {
        foregroundEvent = await queueDriverEvent("job_started", {
          details: {
            truckPlate: dayState?.truckPlate || startedJob?.truckPlate || null
          },
          deferSync: navigator.onLine
        });
        if (navigator.onLine) {
          const result = await request(`/api/driver/jobs/${encodeURIComponent(startedJob.jobId)}/start`, {
            method: "POST",
            body: JSON.stringify({
              ...foregroundReceiptContext(foregroundEvent, startedJob)
            })
          });
          await finishForegroundEvent(foregroundEvent, result);
          currentJob = withManifestJobIdentity(result.job) || currentJob;
        }
        locationCheck = null;
        locationOverrideApproval.clear();
        renderJob();
        showToast(
          currentJob?.dependencyWarnings?.[0]?.message
          || startedJob?.dependencyWarnings?.[0]?.message
          || t("driver.jobStarted", "Job started")
        );
        if (navigator.onLine) checkCurrentJobLocation().catch((error) => showToast(error.message));
        return;
      } catch (error) {
        const outcomeUncertain = foregroundOutcomeUncertain(error);
        if (foregroundEvent && (outcomeUncertain || await isGenuineNetworkFailure(error))) {
          await deferForegroundEvent(foregroundEvent);
          locationCheck = {
            status: "not_checked_offline",
            locationStatus: "not_checked_offline",
            message: t("driver.locationOfflineMessage", "Location was not checked while offline.")
          };
          renderJob();
          if (outcomeUncertain) {
            offlineStatus.dataset.lastError = error.foregroundLocalReceiptFailed
              ? error.message
              : t("driver.jobStartOutcomeReview", "Job-start outcome needs server review. It will not be replayed.");
            void triggerOfflineSync();
          }
          showToast(error.foregroundLocalReceiptFailed
            ? error.message
            : outcomeUncertain
              ? t("driver.jobStartReviewRequired", "Job start saved · Review required")
            : t("driver.jobStartPendingOnline", "Job start saved · Pending online"));
          return;
        }
        if (foregroundEvent) await cancelForegroundEvent(foregroundEvent);
        showToast(error.message);
        await loadNextJob().catch(() => renderJob());
        return;
      }
    }
    if (isDriverBinJob(currentJob)) {
      const startedJob = currentJob;
      const attempt = onlineBinEventAttempt(startedJob, "job_started");
      try {
        const result = await request(`/api/driver/jobs/${encodeURIComponent(startedJob.jobId)}/bin/start`, {
          method: "POST",
          body: JSON.stringify({
            eventId: attempt.eventId,
            clientSequence: attempt.clientSequence,
            details: {
              truckPlate: dayState?.truckPlate || startedJob?.truckPlate || null
            }
          })
        });
        finishOnlineBinEventAttempt(attempt);
        dayState = result.state || dayState;
        currentJob = withManifestJobIdentity(result.job) || currentJob;
        locationCheck = null;
        locationOverrideApproval.clear();
        renderJob();
        showToast(t("driver.binJobStartedOnline", "BIN stop started online"));
        checkCurrentJobLocation().catch((error) => showToast(error.message));
      } catch (error) {
        showToast(error.message);
        await loadNextJob().catch(() => renderJob());
      }
      return;
    }
    try {
      const result = await request(`/api/driver/jobs/${encodeURIComponent(currentJob.jobId)}/start`, {
        method: "POST",
        body: JSON.stringify({})
      });
      currentJob = withManifestJobIdentity(result.job);
      locationCheck = null;
      locationOverrideApproval.clear();
      renderJob();
      showToast(result.dependencyWarnings?.[0]?.message || t("driver.jobStarted", "Job started"));
      checkCurrentJobLocation().catch((error) => showToast(error.message));
    } catch (error) {
      if (error.data?.rest) {
        activeRest = acceptDriverRestCandidate(error.data.rest);
        showToast(error.message);
        return renderRest();
      }
      showToast(error.message);
      renderJob();
    }
  }
  if (action === "confirm-truck-switch" && currentJob?.stopType === "truck_switch") {
    if (activeRest) {
      showToast(t("driver.endRestBeforeSwitch", "End rest time before switching trucks."));
      return renderRest();
    }
    if (!(await ensureAuthoritativeJobBeforeAction(currentJob))) return;
    button.disabled = true;
    button.textContent = `${t("driver.confirmTruckSwitch", "Confirm Truck Switch")}...`;
    if (!(await prepareOfflineRecord())) return renderJob();
    if (canUseOfflineLedger()) {
      if (!navigator.onLine) {
        try {
          await queuePhysicalTruckSwitch();
        } catch (error) {
          showToast(error.message);
          renderJob();
        }
        return;
      }
      await runForegroundTruckSwitch();
      return;
    }
    try {
      const result = await request(`/api/driver/jobs/${encodeURIComponent(currentJob.jobId)}/confirm-truck-switch`, {
        method: "POST",
        body: JSON.stringify({})
      });
      dayState = result.state || dayState;
      currentJob = withManifestJobIdentity(result.job);
      locationCheck = null;
      locationOverrideApproval.clear();
      renderJob();
      showToast(t("driver.switchConfirmed", "Truck switch confirmed"));
    } catch (error) {
      showToast(tf("driver.switchFailureDetail", "Truck switch failed: {detail}", {
        detail: localizeMessage(error.message)
      }));
      await loadNextJob().catch(() => renderJob());
    }
  }
  if (action === "skip-samsara-switch" && currentJob?.stopType === "truck_switch") {
    if (activeRest) {
      showToast(t("driver.endRestBeforeSwitch", "End rest time before switching trucks."));
      return renderRest();
    }
    if (!(await ensureAuthoritativeJobBeforeAction(currentJob))) return;
    const confirmed = window.confirm(tf(
      "driver.skipSamsaraConfirm",
      "Skip Samsara assignment and confirm the switch from {from} to {to} in MBBS? Samsara will remain unresolved.",
      {
        from: currentJob.fromTruckPlate || "-",
        to: currentJob.nextTruckPlate || currentJob.truckPlate || "-"
      }
    ));
    if (!confirmed) return;
    button.disabled = true;
    button.textContent = `${t("driver.skipSamsara", "Skip Samsara & Confirm")}...`;
    if (!(await prepareOfflineRecord())) return renderJob();
    if (canUseOfflineLedger()) {
      if (!navigator.onLine) {
        try {
          await queuePhysicalTruckSwitch({ samsaraSkipped: true });
        } catch (error) {
          showToast(error.message);
          renderJob();
        }
        return;
      }
      await runForegroundTruckSwitch({ samsaraSkipped: true });
      return;
    }
    try {
      const result = await request(`/api/driver/jobs/${encodeURIComponent(currentJob.jobId)}/skip-samsara`, {
        method: "POST",
        body: JSON.stringify({})
      });
      dayState = result.state || dayState;
      currentJob = withManifestJobIdentity(result.job);
      locationCheck = null;
      locationOverrideApproval.clear();
      renderJob();
      showToast(t("driver.samsaraSkipped", "Truck switch confirmed in MBBS. Samsara was skipped."));
    } catch (error) {
      showToast(tf("driver.skipSamsaraFailureDetail", "Could not skip Samsara: {detail}", {
        detail: localizeMessage(error.message)
      }));
      await loadNextJob().catch(() => renderJob());
    }
  }
  if (action === "complete-job" && currentJob) {
    const completedJob = currentJob;
    const submittedJobPhotos = isDriverBinJob(completedJob) ? photos.slice() : photos.filter(Boolean).slice();
    const submittedDriverRemark = normalizedDriverRemark();
    const submittedRemarkDraftKey = currentDriverRemarkDraftKey();
    const submittedBinDraftKey = currentDriverBinDraftKey(completedJob);
    let submittedBinDetails = null;
    if (isDriverBinJob(completedJob)) {
      try {
        submittedBinDetails = window.DriverBinUI.buildCompletionDetails(completedJob, binDraft, submittedJobPhotos);
      } catch (error) {
        showToast(driverBinErrorMessage(error, completedJob));
        return renderJob();
      }
    }
    if (!(await ensureAuthoritativeJobBeforeAction(completedJob))) return;
    if (!canBeginJobConfirmation(completedJob)) {
      if (completeWaitSeconds(completedJob) > 0) {
        showToast(tf("driver.pleaseWaitSeconds", "Please wait {seconds} seconds.", {
          seconds: completeWaitSeconds(completedJob)
        }));
      } else if (locationCheckBlocksConfirmation()) {
        showToast(t("driver.recheckOrOverride", "Recheck location or confirm override first."));
      }
      return renderJob();
    }
    if (!(await prepareOfflineRecord())) return renderJob();
    if (!(await ensureLocationApprovalBeforeConfirmation())) return;
    if (!canUseOfflineLedger() && !(await prepareOfflineRecord())) return renderJob();
    button.disabled = true;
    button.textContent = t("common.uploading", "Uploading...");
    if (canUseOfflineLedger()) {
      try {
        if (locationCheckBlocksConfirmation() || !locationCheckApproved()) {
          showToast(t("driver.recheckOrOverride", "Recheck location or confirm override first."));
          return renderJob();
        }
        await queueDriverEvent("job_completed", {
          job: completedJob,
          eventPhotos: submittedJobPhotos,
          details: {
            stopType: completedJob.stopType,
            stopId: completedJob.stopId || null,
            loadId: completedJob.loadId || null,
            planId: completedJob.planId || offlineManifest.planId || null,
            driverRemark: submittedDriverRemark,
            ...(submittedBinDetails ? { mbt: submittedBinDetails } : {})
          }
        });
        photos = [];
        driverRemark = "";
        binDraft = null;
        void clearDriverRemarkDraft(submittedRemarkDraftKey).catch(() => {});
        void clearDriverBinDraft(submittedBinDraftKey).catch(() => {});
        photoPromptOpen = false;
        locationCheck = null;
        locationOverrideApproval.clear();
        renderJob();
        showToast(t("driver.stopSaved", "Stop saved"));
        return;
      } catch (error) {
        showToast(error.message);
        return renderJob();
      }
    }
    if (isDriverBinJob(completedJob)) {
      const attempt = onlineBinEventAttempt(completedJob, "job_completed");
      try {
        if (locationCheckBlocksConfirmation() || !locationCheckApproved()) {
          showToast(t("driver.recheckOrOverride", "Recheck location or confirm override first."));
          return renderJob();
        }
        await uploadDriverPhotos(submittedJobPhotos, {
          recordType: "driver-stop-photo",
          jobId: completedJob.jobId,
          stopId: completedJob.stopId,
          planId: completedJob.planId,
          loadId: completedJob.loadId
        });
        button.textContent = t("common.saving", "Saving...");
        const result = await request(`/api/driver/jobs/${encodeURIComponent(completedJob.jobId)}/bin/complete`, {
          method: "POST",
          body: JSON.stringify({
            eventId: attempt.eventId,
            clientSequence: attempt.clientSequence,
            photos: onlineBinPhotoDescriptors(submittedJobPhotos),
            details: {
              stopType: completedJob.stopType,
              stopId: completedJob.stopId || null,
              loadId: completedJob.loadId || null,
              planId: completedJob.planId || null,
              driverRemark: submittedDriverRemark,
              mbt: submittedBinDetails
            }
          })
        });
        finishOnlineBinEventAttempt(attempt);
        await clearLegacyDraftPhotos(submittedJobPhotos);
        dayState = result.state || dayState;
        currentJob = withManifestJobIdentity(result.job);
        photos = [];
        driverRemark = "";
        binDraft = null;
        photoPromptOpen = false;
        locationCheck = null;
        locationOverrideApproval.clear();
        renderJob();
        showToast(t("driver.binStopCompletedOnline", "BIN stop completed online"));
      } catch (error) {
        showToast(error.message);
        await loadNextJob().catch(() => renderJob());
      }
      return;
    }
    try {
      if (locationCheckBlocksConfirmation() || !locationCheckApproved()) {
        showToast(t("driver.recheckOrOverride", "Recheck location or confirm override first."));
        return renderJob();
      }
      const uploadedPhotos = await uploadDriverPhotos(submittedJobPhotos, {
        recordType: completedJob.stopType === "pickup" ? "driver-pickup-photo"
          : completedJob.stopType === "dropoff" ? "driver-dropoff-photo"
            : "driver-stop-photo",
        jobId: completedJob.jobId,
        stopId: completedJob.stopId,
        planId: completedJob.planId,
        loadId: completedJob.loadId,
        orderRef: (completedJob.orderRefs || []).join(",")
      });
      button.textContent = t("common.saving", "Saving...");
      const result = await request(`/api/driver/jobs/${encodeURIComponent(completedJob.jobId)}/photos`, {
        method: "POST",
        body: JSON.stringify({
          photoDataUrls: uploadedPhotos,
          driverRemark: submittedDriverRemark,
          locationOverride: locationOverrideApproval.isAccepted(completedJob),
          autoStartNext: true
        })
      });
      await clearLegacyDraftPhotos(submittedJobPhotos);
      currentJob = withManifestJobIdentity(result.nextJob);
      activeRest = acceptDriverRestCandidate(result.rest);
      restSummary = result.restSummary || restSummary;
      photos = [];
      driverRemark = "";
      void clearDriverRemarkDraft(submittedRemarkDraftKey).catch(() => {});
      photoPromptOpen = false;
      const shouldCheckNext = currentJob?.status === "in_progress";
      locationCheck = null;
      locationOverrideApproval.clear();
      if (activeRest) {
        showToast(t("driver.restStarted", "Rest started"));
        return renderRest();
      }
      renderJob();
      if (shouldCheckNext) checkCurrentJobLocation().catch((error) => showToast(error.message));
      showToast(result.dependencyWarnings?.[0]?.message || t("driver.stopCompleted", "Stop completed"));
    } catch (error) {
      if (error.data?.locationCheck) locationCheck = error.data.locationCheck;
      showToast(error.message);
      renderJob();
    }
  }
  } finally {
    endDriverMutation(mutationToken);
  }
});

app.addEventListener("input", (event) => {
  const binScan = event.target.closest("[data-bin-scan]");
  const binNote = event.target.closest("[data-bin-note]");
  const binSignature = event.target.closest("[data-bin-signature]");
  const binReceipt = event.target.closest("[data-bin-receipt]");
  if (binScan || binNote || binSignature || binReceipt) {
    if (!driverActionProtectionState().ready || !isDriverBinJob()) {
      applyDriverActionProtectionGate();
      return;
    }
    markDriverInteraction();
    const draft = ensureDriverBinDraft();
    if (binScan) draft.scans[binScan.dataset.binScan] = String(binScan.value || "").slice(0, 200);
    if (binNote) draft.notes[binNote.dataset.binNote] = String(binNote.value || "").slice(0, 2000);
    if (binSignature) {
      draft.signatures[binSignature.dataset.binSignature] = {
        signedBy: String(binSignature.value || "").slice(0, 300)
      };
    }
    if (binReceipt) draft.receipt[binReceipt.dataset.binReceipt] = String(binReceipt.value || "").slice(0, 200);
    void persistDriverBinDraft(draft).catch(() => {});
    updateDriverBinCompletionButton();
    return;
  }
  const remarkInput = event.target.closest("[data-driver-photo-remark]");
  if (!remarkInput) return;
  if (!driverActionProtectionState().ready) {
    applyDriverActionProtectionGate();
    return;
  }
  markDriverInteraction();
  driverRemark = String(remarkInput.value || "").slice(0, DRIVER_REMARK_MAX_LENGTH);
  void persistDriverRemarkDraft(driverRemark).catch(() => {});
});

app.addEventListener("change", async (event) => {
  if (event.target?.id === "driverHistoryDate") {
    historyDate = event.target.value || localDate();
    return loadDriverHistory();
  }
  const input = event.target.closest("input[type='file'][data-photo-index]");
  const dvirInput = event.target.closest("input[type='file'][data-dvir-photo-index]");
  if (!input && !dvirInput) return;
  const selectedInput = dvirInput || input;
  if (!driverActionProtectionState().ready) {
    selectedInput.value = "";
    applyDriverActionProtectionGate();
    showToast(driverActionProtectionState().message);
    return;
  }
  const file = selectedInput?.files?.[0];
  markDriverInteraction();
  beginPhotoCapture();
  try {
    if (!file) return;
    const isDvir = Boolean(dvirInput);
    const index = Number((isDvir ? dvirInput.dataset.dvirPhotoIndex : input.dataset.photoIndex) || 0);
    const captureDvirMode = dvirMode || "pre";
    if (!(await prepareOfflineRecord())) return;
    const capturePartitionKey = driverOfflineModeEnabled
      ? (offlinePartition?.partitionKey || "")
      : "";
    const captureJobId = String(currentJob?.jobId || "");
    const captureDraftKey = currentPhotoDraftKey(
      isDvir ? "dvir" : "job",
      isDvir ? captureDvirMode : ""
    );
    const existingPhoto = (isDvir ? dvirPhotos : photos)[index];
    const offlineCapture = driverOfflineModeEnabled && offlineStorageAvailable && capturePartitionKey
      ? await prepareOfflinePhotoCapture({ isDvir, index, existingPhoto, evictOptional: true })
      : { capturePolicy: {}, admission: {} };
    const recordType = isDvir
      ? (captureDvirMode === "post" ? "driver-dvir-post-photo" : "driver-dvir-pre-photo")
      : currentJob?.stopType === "pickup"
        ? "driver-pickup-photo"
        : currentJob?.stopType === "dropoff"
        ? "driver-dropoff-photo"
        : "driver-stop-photo";
    app.classList.add("photo-processing");
    let captured;
    if (driverOfflineModeEnabled && offlineStorageAvailable && capturePartitionKey) {
      captured = await window.DriverOfflinePhotos.captureAndStore({
        file,
        partitionKey: capturePartitionKey,
        draftKey: captureDraftKey,
        ordinal: index,
        recordType,
        existingPhoto,
        capturePolicy: offlineCapture.capturePolicy,
        admission: offlineCapture.admission
      });
    } else {
      const compressed = await window.DriverOfflinePhotos.compress(file);
      captured = window.DriverOfflinePhotos.hydrate({
        photoId: window.DriverOfflineDB.createUuid(),
        ordinal: index,
        recordType,
        ...compressed
      });
    }
    const activeCapturePartitionKey = driverOfflineModeEnabled
      ? (offlinePartition?.partitionKey || "")
      : "";
    const captureStillCurrent = capturePartitionKey === activeCapturePartitionKey
      && (isDvir
        ? captureDvirMode === (dvirMode || "pre")
        : captureJobId === String(currentJob?.jobId || ""));
    if (!captureStillCurrent) {
      window.DriverOfflinePhotos?.revokePhoto(captured);
      quietSyncRefreshQueued = true;
      return;
    }
    if (isDvir) dvirPhotos[index] = captured;
    else {
      photos[index] = captured;
      // BIN evidence is rendered inline against immutable requirement codes;
      // opening the ordinary photo modal would duplicate and obscure it.
      photoPromptOpen = !isDriverBinJob();
    }
    await refreshOfflineHealth();
    if (isDvir) {
      renderDvir(captureDvirMode);
      return;
    }
    renderJob();
  } catch (error) {
    showToast(error.message);
  } finally {
    selectedInput.value = "";
    app.classList.remove("photo-processing");
    finishPhotoCapture();
  }
});

app.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-form='login']");
  if (!form) return;
  event.preventDefault();
  if (driverPwaUpdateRequired) return renderDriverPwaUpdateRequired();
  const submitButton = form.querySelector('button[type="submit"]');
  if (submitButton?.disabled) return;
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = t("driver.signingIn", "Signing in...");
  }
  try {
    const result = await request("/api/driver/login", {
      method: "POST",
      body: JSON.stringify({
        username: document.getElementById("driverLogin").value,
        password: document.getElementById("driverPassword").value
      })
    });
    authToken = result.token;
    driver = result.driver;
    driverSessionInvalidated = false;
    driverIdentityValidated = true;
    driverIdentityValidationPromise = Promise.resolve(true);
    dayState = result.dayState || null;
    localStorage.setItem(TOKEN_KEY, authToken);
    if (offlineStorageAvailable) {
      const recoveredIdentity = await window.DriverOfflineDB.recoverDriverDeviceIdentity(driver);
      offlineDeviceId = recoveredIdentity.deviceId || offlineDeviceId;
      try {
        localStorage.setItem(DRIVER_DEVICE_ID_KEY, offlineDeviceId);
      } catch {
        // IndexedDB remains authoritative for this session.
      }
      offlinePartition = await window.DriverOfflineDB.unlockPartition(driver);
      offlineDeviceId = offlinePartition.deviceId;
      await window.DriverOfflineDB.releaseStaleForegroundEvents(offlinePartition.partitionKey);
      offlineManifest = await window.DriverOfflineDB.getActiveManifest(offlinePartition.partitionKey);
      await refreshDeferredManifestState({ activateIfSafe: true });
      offlineStatus.dataset.lastError = "";
      void requestPersistentStorage();
    }
    const preparedSyncToken = await prepareQuietSyncHoldForSavedWork();
    const backgroundPhotoRecovery = retainedPhotoRecoveryRunsInBackground();
    connectEvents();
    let initialSyncResult = null;
    if (offlineStorageAvailable && offlinePartition?.partitionKey) {
      if (backgroundPhotoRecovery) {
        await loadNextJob();
        void triggerOfflineSync({ suppressHold: true });
      } else {
        initialSyncResult = await triggerOfflineSync({ preparedToken: preparedSyncToken });
      }
    } else {
      await loadNextJob();
    }
    scheduleOnlineRouteRevalidation(1000);
    void refreshDriverRouteChangeState({ visible: true });
    if (initialSyncResult?.error) showToast(initialSyncResult.error.message);
    else if (initialSyncResult?.retainedError) showToast(initialSyncResult.retainedError.message);
    else if (initialSyncResult?.reviewRequired) showToast(t("driver.syncReviewRequired", "Synchronization needs Dispatch review."));
    else showToast(tf("driver.welcome", "Welcome {name}", { name: driver.name }));
  } catch (error) {
    resetQuietSync();
    renderLogin(localizeMessage(error.message));
  }
});

async function initializeOfflineStorage() {
  try {
    await window.DriverOfflineDB.open();
    offlineDeviceId = await window.DriverOfflineDB.getDeviceId();
    try {
      localStorage.setItem(DRIVER_DEVICE_ID_KEY, offlineDeviceId);
    } catch {
      // The IndexedDB identity still protects this open session.
    }
    offlinePartition = await window.DriverOfflineDB.getActiveProfile();
    if (offlinePartition) await window.DriverOfflineDB.releaseStaleForegroundEvents(offlinePartition.partitionKey);
    offlineManifest = offlinePartition
      ? await window.DriverOfflineDB.getActiveManifest(offlinePartition.partitionKey)
      : null;
    offlineStorageAvailable = true;
    if (offlinePartition) await refreshDeferredManifestState({ activateIfSafe: true });
    window.DriverOfflineSync.configure({
      getAuthToken: () => authToken,
      onStatus(update) {
        if (
          update.state === "error"
          && (Number(update.error?.status || 0) === 426 || update.error?.code === "DRIVER_PWA_UPDATE_REQUIRED")
        ) {
          requireDriverPwaUpdate(update.error?.data || {}, { reason: "offline_sync_426" });
          return;
        }
        offlineSyncing = update.state === "syncing";
        if (update.state === "error") {
          offlineStatus.dataset.lastError = update.error?.message
            || t("driver.syncFailed", "Synchronization failed.");
        }
        renderOfflineStatus();
      },
      onUpdated() {
        void refreshOfflineHealth();
      }
    });
    await refreshOfflineHealth();
  } catch (error) {
    offlineStorageAvailable = false;
    console.warn("Driver offline storage unavailable:", error);
  }
}

async function recoverStaleForegroundEvents() {
  if (!offlineStorageAvailable || !offlinePartition?.partitionKey) return;
  const released = await window.DriverOfflineDB.releaseStaleForegroundEvents(
    offlinePartition.partitionKey,
    5 * 60 * 1000,
    [...activeForegroundEventIds]
  ).catch(() => 0);
  if (released) {
    void window.DriverOfflineSync.registerBackgroundSync();
    if (navigator.onLine) void triggerOfflineSync();
    else void refreshOfflineHealth();
  }
}

async function init() {
  restoreDriverPwaUpdateMarker();
  const versionCurrent = driverPwaUpdateRequired
    ? false
    : await checkDriverPwaVersion({ reason: "startup" });
  if (!versionCurrent) {
    renderDriverPwaUpdateRequired();
    return;
  }
  await initializeOfflineStorage();
  if (!authToken) {
    const offlineProbe = !navigator.onLine
      || await isGenuineNetworkFailure(Object.assign(new Error("Offline probe"), { isNetworkError: true }));
    if (offlinePartition && offlineProbe && await loadCachedRoute()) return;
    if (await redirectExistingStaffSession()) return;
    return renderLogin();
  }
  let preparedSyncToken = null;
  try {
    driverSessionInvalidated = false;
    driverIdentityValidated = false;
    preparedSyncToken = await prepareQuietSyncHoldForSavedWork();
    const backgroundPhotoRecovery = retainedPhotoRecoveryRunsInBackground();
    let identityError = null;
    driverIdentityValidationPromise = (async () => {
      try {
        const result = await request("/api/driver/me");
        driver = result.driver;
        if (offlineStorageAvailable) {
          const recoveredIdentity = await window.DriverOfflineDB.recoverDriverDeviceIdentity(driver);
          offlineDeviceId = recoveredIdentity.deviceId || offlineDeviceId;
          try {
            localStorage.setItem(DRIVER_DEVICE_ID_KEY, offlineDeviceId);
          } catch {
            // IndexedDB remains authoritative for this session.
          }
          offlinePartition = await window.DriverOfflineDB.unlockPartition(driver);
          offlineDeviceId = offlinePartition.deviceId;
          await window.DriverOfflineDB.releaseStaleForegroundEvents(offlinePartition.partitionKey);
          offlineManifest = await window.DriverOfflineDB.getActiveManifest(offlinePartition.partitionKey);
        }
        driverIdentityValidated = true;
        if (offlinePartition) await refreshDeferredManifestState({ activateIfSafe: true });
        return true;
      } catch (error) {
        identityError = error;
        return false;
      }
    })();
    let nextJobError = null;
    await loadNextJob().catch((error) => {
      nextJobError = error;
    });
    const identityValid = await driverIdentityValidationPromise;
    if (!identityValid) {
      throw identityError || new Error(t("driver.identityNotVerified", "Driver identity could not be verified."));
    }
    if (nextJobError) throw nextJobError;
    connectEvents();
    if (backgroundPhotoRecovery) {
      void triggerOfflineSync({ suppressHold: true });
    } else {
      await triggerOfflineSync({ preparedToken: preparedSyncToken });
    }
    preparedSyncToken = null;
    scheduleOnlineRouteRevalidation(1000);
    void refreshDriverRouteChangeState({ visible: true });
  } catch (error) {
    if (driverPwaUpdateRequired || error.code === "DRIVER_PWA_UPDATE_REQUIRED" || error.status === 426) {
      endQuietSync(preparedSyncToken);
      renderDriverPwaUpdateRequired();
      return;
    }
    if (await isGenuineNetworkFailure(error) && await loadCachedRoute()) {
      endQuietSync(preparedSyncToken);
      connectEvents();
      return;
    }
    if (error.status === 401) {
      const rejectedPartition = offlinePartition;
      if (rejectedPartition?.partitionKey && window.DriverOfflineDB) {
        await window.DriverOfflineDB.lockPartition(rejectedPartition.partitionKey, {
          expectedSessionGeneration: rejectedPartition.sessionGeneration || ""
        }).catch(() => {});
      }
      localStorage.removeItem(TOKEN_KEY);
      clearDriverSessionMemory();
      return renderLogin(t("driver.loginToContinue", "Please login to continue."));
    }
    endQuietSync(preparedSyncToken);
    renderLogin(localizeMessage(error.message || t("driver.serviceUnavailable", "Driver service is temporarily unavailable.")));
  }
}

window.addEventListener("mbbs-language-changed", () => {
  if (driverPwaUpdateRequired) return renderDriverPwaUpdateRequired();
  if (!authToken) return renderLogin();
  if (activeView === "history") return renderDriverHistory();
  if (dvirMode) return renderDvir(dvirMode);
  if (activeRest) return renderRest();
  renderJob();
  void prepareCurrentDeliveryInstructionLanguage({ force: true, announce: true });
});

offlineStatus?.addEventListener("click", async (event) => {
  if (driverPwaUpdateRequired) return renderDriverPwaUpdateRequired();
  const button = event.target.closest("[data-offline-action]");
  if (!button) return;
  if (button.dataset.offlineAction === "toggle") {
    offlineStatusOpen = !offlineStatusOpen;
    return renderOfflineStatus();
  }
  if (button.dataset.offlineAction === "sync") return triggerOfflineSync({ userInitiated: true });
  if (button.dataset.offlineAction === "persist") return requestPersistentStorage({ userInitiated: true });
  if (button.dataset.offlineAction === "repair-cache") return repairDriverAppCache(button);
  if (button.dataset.offlineAction === "clear") return clearSavedRouteCache();
});

routeChangeStatus?.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  if (button.dataset.action === "refresh-driver-route-change") {
    button.disabled = true;
    await refreshDriverRouteChangeState({ visible: true });
    return;
  }
  if (button.dataset.action === "enable-driver-route-alerts") {
    await enableDriverRouteAlerts(button);
    return;
  }
  if (button.dataset.action === "acknowledge-driver-route-change") {
    await acknowledgeDriverRouteChangeRequest(button.dataset.routeRequestId || "", button);
  }
});

async function resumeOnlineDriver(source, { synchronizeProtectedScreen = false } = {}) {
  if (!(await checkDriverPwaVersion({ force: true, reason: source }))) return false;
  if (!driver || !authToken) return true;
  const protectedScreen = Boolean(activeRest || photoInteractionActive());
  if (protectedScreen) {
    quietSyncRefreshQueued = true;
    onlineRouteRevalidationQueued = true;
    if (synchronizeProtectedScreen) {
      await triggerOfflineSync({ suppressHold: true });
    }
  } else {
    await triggerOfflineSync();
    if (!driverPwaUpdateRequired) await revalidateOnlineRoute({ source });
  }
  if (!driverPwaUpdateRequired) scheduleOnlineRouteRevalidation();
  return !driverPwaUpdateRequired;
}

window.addEventListener("online", () => {
  void resumeOnlineDriver("online", { synchronizeProtectedScreen: true })
    .then(() => refreshDriverRouteChangeState({ visible: document.visibilityState === "visible" }));
});

window.addEventListener("offline", () => {
  markDriverBrowserOffline();
  stopOnlineRouteRevalidation();
  if (currentJob?.status === "in_progress" && !photoInteractionActive()) {
    locationCheck = offlineLocationCheckResult();
    renderJob();
  }
  renderOfflineStatus();
  applyDriverActionProtectionGate();
  void refreshOfflineHealth();
  renderDriverRouteChangeStatus();
});

window.addEventListener("pagehide", () => {
  if (!navigator.onLine) markDriverBrowserOffline();
  else void sendDriverRoutePresence({ visible: false, keepalive: true });
});

window.addEventListener("storage", (event) => {
  if (
    event.storageArea !== localStorage
    || event.key !== TOKEN_KEY
    || event.oldValue === event.newValue
  ) return;
  const partition = offlinePartition;
  if (partition?.partitionKey && window.DriverOfflineDB) {
    void window.DriverOfflineDB.lockPartition(partition.partitionKey, {
      expectedSessionGeneration: partition.sessionGeneration || ""
    }).catch(() => {});
  }
  clearDriverSessionMemory();
  renderLogin(t("driver.sessionChangedOtherTab", "The Driver session changed in another tab. Sign in again to continue."));
});

window.addEventListener("pageshow", () => {
  void recoverStaleForegroundEvents();
  if (navigator.onLine) void resumeOnlineDriver("pageshow");
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void recoverStaleForegroundEvents();
    if (navigator.onLine) {
      void resumeOnlineDriver("visibility")
        .then(() => refreshDriverRouteChangeState({ visible: true }));
    }
  } else if (navigator.onLine) {
    void sendDriverRoutePresence({ visible: false, keepalive: true });
  }
  renderDriverRouteChangeStatus();
});

window.setInterval(() => {
  if (
    navigator.onLine
    && document.visibilityState === "visible"
    && driver
    && authToken
    && !driverPwaUpdateRequired
  ) {
    void refreshDriverRouteChangeState({ visible: true });
  }
}, DRIVER_ROUTE_PRESENCE_INTERVAL_MS);

window.setInterval(() => {
  void recoverStaleForegroundEvents();
  if (navigator.onLine && document.visibilityState === "visible") {
    void checkDriverPwaVersion({ force: true, reason: "periodic" });
    void driverServiceWorkerRegistration?.update?.().catch(() => {});
  }
}, DRIVER_PWA_VERSION_CHECK_MS);

window.setInterval(() => {
  if (
    driverOfflineRecoveryRunning
    || !browserOfflineObserved
    || !navigator.onLine
    || !driver
    || !authToken
    || driverPwaUpdateRequired
    || document.visibilityState !== "visible"
  ) return;
  driverOfflineRecoveryRunning = true;
  void resumeOnlineDriver("offline_recovery", { synchronizeProtectedScreen: true })
    .catch(() => false)
    .finally(() => {
      driverOfflineRecoveryRunning = false;
    });
}, DRIVER_OFFLINE_RECOVERY_CHECK_MS);

if ("serviceWorker" in navigator) {
  const requestDriverWorkerVersion = () => {
    navigator.serviceWorker.controller?.postMessage({ type: "DRIVER_VERSION_REQUEST" });
  };
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "DRIVER_VERSION") return;
    const workerVersion = String(event.data.version || "");
    if (workerVersion && workerVersion !== DRIVER_PWA_CLIENT_VERSION) {
      requireDriverPwaUpdate({
        currentVersion: workerVersion,
        minimumVersion: workerVersion,
        preserveLocalEvidence: true
      }, { reason: "service_worker_version" });
    }
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    offlineShellReady = Boolean(
      navigator.serviceWorker.controller
      || driverServiceWorkerRegistration?.active
    );
    renderOfflineStatus();
    applyDriverActionProtectionGate();
    window.setTimeout(requestDriverWorkerVersion, 0);
    window.setTimeout(publishDriverOfflineMode, 0);
  });
  navigator.serviceWorker.register("/driver-service-worker.js?v=20260819-driver-route-readiness-v1", {
    scope: "/driver",
    updateViaCache: "none"
  })
    .then(async (registration) => {
      driverServiceWorkerRegistration = registration;
      offlineShellReady = Boolean(navigator.serviceWorker.controller || registration.active);
      const observeInstallingWorker = (installingWorker) => {
        if (!installingWorker) return;
        installingWorker.addEventListener("statechange", () => {
          offlineShellReady = Boolean(
            navigator.serviceWorker.controller
            || registration.active
            || installingWorker.state === "activated"
          );
          renderOfflineStatus();
          applyDriverActionProtectionGate();
          if (installingWorker.state === "activated") requestDriverWorkerVersion();
        });
      };
      observeInstallingWorker(registration.installing);
      registration.addEventListener("updatefound", () => {
        observeInstallingWorker(registration.installing);
      });
          requestDriverWorkerVersion();
          publishDriverOfflineMode();
      void registration.update().catch(() => {});
      renderOfflineStatus();
      applyDriverActionProtectionGate();
    })
    .catch((error) => {
      offlineShellReady = false;
      if (offlineStatus) {
        offlineStatus.dataset.lastError = tf("driver.appShellUnavailable", "App shell unavailable: {detail}", {
          detail: localizeMessage(error.message)
        });
      }
      renderOfflineStatus();
    });
}

init();

const LOCATIONS = [
  { id: 1, text: "3445" },
  { id: 28, text: "2967" },
  { id: 15, text: "12441" },
  { id: 26, text: "150" }
];

const ORDER_PAGE_SIZE = 4;
const DELIVERY_ORDER_PAGE_SIZE = 3;
const LINE_PAGE_SIZE = 3;
const COMPACT_LINE_PAGE_SIZE = 6;
const HISTORY_PAGE_SIZE = 5;
const PICKABLE_ITEM_TYPES = new Set(["InvtPart", "NonInvtPart"]);

const app = document.getElementById("app");
const toast = document.getElementById("toast");
const t = (key, fallback) => window.MBBS_I18N?.t(key, fallback) || fallback;
const tf = (key, fallback, variables = {}) => window.MBBS_I18N?.format(key, fallback, variables) || fallback;
const localizeMessage = (message) => window.MBBS_I18N?.message(message) || String(message || "");
const languageToggle = () => window.MBBS_I18N?.toggleHtml() || "";

const TOKEN_KEY = "mbbs.operator.token";
const STAFF_TOKEN_KEY = "mbbs.staff.token";
const STAFF_ROLE_KEY = "mbbs.staff.role";
const STAFF_ROLES_KEY = "mbbs.staff.roles";
const STATE_KEY = "mbbs.operator.state";
const CAMERA_FACING_KEY = "mbbs.camera.facingMode";
const RESTORABLE_MODULES = new Set([
  "menu",
  "delivery-select",
  "delivery",
  "delivery-consolidation",
  "receiving",
  "return-select",
  "cycle-count",
  "personal-history",
  "customer-pickup-scan",
  "customer-pickup"
]);

function readOperatorState() {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function normalizedStaffRole(value) {
  return String(value || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
}

function staffRoleHome(role) {
  const clean = normalizedStaffRole(role);
  if (clean === "admin") return "/admin";
  if (clean === "dispatcher") return "/dispatch";
  if (clean === "scm" || clean === "scm_staff") return "/scm";
  if (clean === "yard_manager") return "/control";
  if (clean === "operator") return "/operator";
  return "/";
}

function operatorRoleAllowed(account) {
  const roles = new Set([...(Array.isArray(account?.roles) ? account.roles : []), account?.role].map(normalizedStaffRole).filter(Boolean));
  return ["admin", "operator", "yard_manager"].some((role) => roles.has(role));
}

function readOperatorToken() {
  return localStorage.getItem(STAFF_TOKEN_KEY)
    || localStorage.getItem(TOKEN_KEY)
    || localStorage.getItem("mbbs.control.token")
    || localStorage.getItem("mbbs.dispatch.token")
    || "";
}

function storeOperatorSession(nextToken, nextOperator) {
  authToken = nextToken || "";
  if (authToken) {
    localStorage.setItem(STAFF_TOKEN_KEY, authToken);
    localStorage.setItem(TOKEN_KEY, authToken);
  }
  if (nextOperator?.role) localStorage.setItem(STAFF_ROLE_KEY, normalizedStaffRole(nextOperator.role));
  localStorage.setItem(STAFF_ROLES_KEY, JSON.stringify([...new Set([...(Array.isArray(nextOperator?.roles) ? nextOperator.roles : []), nextOperator?.role].filter(Boolean))]));
}

function clearOperatorSession() {
  for (const key of [STAFF_TOKEN_KEY, STAFF_ROLE_KEY, STAFF_ROLES_KEY, "mbbs.control.token", "mbbs.dispatch.token", "mbbs.operator.token"]) {
    localStorage.removeItem(key);
  }
  authToken = "";
}

function restorableModule(value) {
  const module = value === "delivery-fulfill" ? "delivery"
    : value === "customer-pickup-load" ? "customer-pickup"
      : value === "receiving-receipt" ? "receiving"
        : value;
  return RESTORABLE_MODULES.has(module) ? module : "menu";
}

const initialOperatorState = readOperatorState();
let authToken = readOperatorToken();
let operator = null;

let locationId = Number(initialOperatorState.locationId || localStorage.getItem("mbbs.operator.locationId") || localStorage.getItem("mbbs.delivery.locationId") || 0);
if (locationId === 13) {
  locationId = 28;
  localStorage.setItem("mbbs.operator.locationId", "28");
  localStorage.setItem("mbbs.delivery.locationId", "28");
}
let currentModule = restorableModule(initialOperatorState.currentModule || "menu");
let locationDropdownOpen = false;
let viewMode = initialOperatorState.viewMode === "packed" ? "packed" : "active";
let deliveryOrderType = initialOperatorState.deliveryOrderType || localStorage.getItem("mbbs.operator.deliveryOrderType") || "sales_order";
let deliveryBatchFilter = initialOperatorState.deliveryBatchFilter || localStorage.getItem("mbbs.operator.deliveryBatchFilter") || "batch_a";
let deliveryPrepMode = initialOperatorState.deliveryPrepMode || localStorage.getItem("mbbs.operator.deliveryPrepMode") || "standard";
if (!["standard", "saved", "load"].includes(deliveryPrepMode)) deliveryPrepMode = "standard";
let deliveryLoadViewDate = initialOperatorState.deliveryLoadViewDate || localStorage.getItem("mbbs.operator.deliveryLoadViewDate") || new Date().toISOString().slice(0, 10);
let deliveryLoadViewTruck = "";
localStorage.removeItem("mbbs.operator.deliveryLoadViewTruck");
let deliveryLoadTrucks = [];
let savedDeliveryOrderKeys = new Set();
let consolidationQueue = { total: 0, eligible: 0, blocked: 0, orders: [] };
let consolidationBatch = null;
let consolidationStage = initialOperatorState.consolidationStage === "review" ? "review" : "pick";
let consolidationSearch = initialOperatorState.consolidationSearch || "";
let consolidationSelectedItemKey = initialOperatorState.consolidationSelectedItemKey || "";
let consolidationReviewOrderId = initialOperatorState.consolidationReviewOrderId || "";
let consolidationReviewLineKey = initialOperatorState.consolidationReviewLineKey || "";
let consolidationReviewLinePage = Number(initialOperatorState.consolidationReviewLinePage || 0);
let consolidationDrafts = new Map();
let consolidationBusy = false;
let consolidationNotice = "";
let compactLineMode = localStorage.getItem("mbbs.operator.compactLineList") === "true";
let orders = [];
let deliveryOrderBuckets = { active: null, packed: null };
let packedDeliveryPrefetch = null;
let deliveryNotifications = { total: 0, salesOrder: { dueToday: 0 }, transferOrder: { dueToday: 0 }, items: [] };
let urgentDeliveryAlert = null;
let operatorRequests = [];
let activeDeliveryDraft = null;
let selectedId = initialOperatorState.selectedId || null;
let selectedOrder = null;
let selectedLineId = initialOperatorState.selectedLineId || null;
let orderPage = Number(initialOperatorState.orderPage || 0);
let linePage = Number(initialOperatorState.linePage || 0);
let installPromptEvent = null;
let appInstalled = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
let fulfillmentOrder = null;
let fulfillmentPhotoDataUrls = [];
let fulfillmentActivePhotoSlot = 0;
let fulfillmentSubmitting = false;
let fulfillmentResult = null;
let fulfillmentCameraStream = null;
let fulfillmentCameraActive = false;
let fulfillmentStatusText = "";
let fulfillmentJobStage = "";
let fulfillmentStartedAt = 0;
let fulfillmentProgressTimer = null;
let fulfillmentValidation = null;
let fulfillmentReturnModule = "delivery";
let customerPickupScan = ["string", "number"].includes(typeof initialOperatorState.customerPickupScan)
  ? String(initialOperatorState.customerPickupScan)
  : "";
let customerPickupMessage = "";
let pickupScannerStream = null;
let pickupScannerActive = false;
let pickupScanTimer = null;
let pickupQrDecoder = null;
let pickupQrFrameBusy = false;
let pickupQuaggaActive = false;
let pickupScanSubmitting = false;
let pickupScanCandidate = "";
let pickupScanCandidateHits = 0;
let pickupScanCandidateAt = 0;

let cycleStep = initialOperatorState.cycleStep || "type";
let cycleSelection = initialOperatorState.cycleSelection || { productType: "", brand: "", series: "" };
let cycleSearch = initialOperatorState.cycleSearch || "";
let cycleFacets = { productTypes: [], brands: [], series: [] };
let inventoryItems = [];
let selectedInventoryItem = null;
let restoredInventoryItemId = initialOperatorState.selectedInventoryItemId || "";
let cycleDraft = null;
let cyclePage = Number(initialOperatorState.cyclePage || 0);
let activeCycleUnit = initialOperatorState.activeCycleUnit || "";
let cycleValues = {};
let cycleConfirming = false;

let receivingStep = initialOperatorState.receivingStep || "type";
let receivingOrderType = initialOperatorState.receivingOrderType || "purchase_order";
let receivingVendors = [];
let receivingSources = [];
let receivingOrders = [];
let receivingSelectedVendor = initialOperatorState.receivingSelectedVendor || "";
let receivingSelectedSourceId = initialOperatorState.receivingSelectedSourceId || "";
let receivingSelectedId = initialOperatorState.receivingSelectedId || null;
let receivingSelectedOrder = null;
let receivingSearch = initialOperatorState.receivingSearch || "";
let receivingItemSearch = initialOperatorState.receivingItemSearch || "";
let receivingItemSuggestions = [];
let receivingOrderPage = Number(initialOperatorState.receivingOrderPage || 0);
let receivingLinePage = Number(initialOperatorState.receivingLinePage || 0);
let receivingSelectedLineId = initialOperatorState.receivingSelectedLineId || null;
let receiptOrder = null;
let receiptPhotoDataUrls = [];
let receiptActivePhotoSlot = 0;
let receiptSubmitting = false;
let receiptResult = null;
let receiptCameraStream = null;
let receiptCameraActive = false;
let receiptStatusText = "";
let receiptJobStage = "";
let receiptStartedAt = 0;
let receiptProgressTimer = null;
let personalHistory = [];
let personalHistoryDate = initialOperatorState.personalHistoryDate || new Date().toISOString().slice(0, 10);
let selectedHistoryId = initialOperatorState.selectedHistoryId || "";
let historyReportReason = "";
let historyPage = Number(initialOperatorState.historyPage || 0);
let eventSource = null;
let eventRefreshTimer = null;
let pendingDeliveryEventAlertRefs = new Set();
let pendingDeliveryEventRefresh = false;
let pendingReceivingEventRefresh = false;
let pendingOperatorRequestAlert = false;
const localDeliveryMutationRefs = new Map();
let deliveryNotificationState = new Map();
let deliveryNotificationStateReady = false;
let cameraFacingMode = localStorage.getItem(CAMERA_FACING_KEY) === "user" ? "user" : "environment";
if (currentModule === "customer-pickup-scan") {
  cameraFacingMode = "environment";
  localStorage.setItem(CAMERA_FACING_KEY, cameraFacingMode);
}
let lastCameraDeviceId = "";
let pickupScannerBuffer = "";
let pickupScannerLastKeyAt = 0;
let pickupFocusTimer = null;
const OPERATOR_CAMERA_IDEAL_WIDTH = 4096;
const OPERATOR_CAMERA_IDEAL_HEIGHT = 3072;
const OPERATOR_CAMERA_JPEG_QUALITY = 0.92;

function cameraFacingLabel() {
  return cameraFacingMode === "user"
    ? t("common.frontCamera", "Front")
    : t("common.backCamera", "Back");
}

function cameraCaptureMode() {
  return cameraFacingMode === "user" ? "user" : "environment";
}

function selectRearCamera() {
  cameraFacingMode = "environment";
  localStorage.setItem(CAMERA_FACING_KEY, cameraFacingMode);
}

function cameraVideoConstraints(overrides = {}) {
  return {
    width: { ideal: OPERATOR_CAMERA_IDEAL_WIDTH },
    height: { ideal: OPERATOR_CAMERA_IDEAL_HEIGHT },
    ...overrides
  };
}

function cameraMediaConstraints() {
  return {
    video: cameraVideoConstraints({ facingMode: { ideal: cameraCaptureMode() } }),
    audio: false
  };
}

function cameraLabelMatchesFacing(device, facingMode) {
  const label = String(device?.label || "").toLowerCase();
  if (!label) return false;
  if (facingMode === "user") return /front|user|face|selfie|前|前置/.test(label);
  return /back|rear|environment|world|外|后|後|背/.test(label);
}

async function listVideoInputDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === "videoinput");
}

function pickCameraDevice(devices, facingMode, currentDeviceId = "") {
  const candidates = (devices || []).filter((device) => device.deviceId || device.id);
  if (!candidates.length) return "";
  const idOf = (device) => device.deviceId || device.id || "";
  const preferred = candidates.find((device) => cameraLabelMatchesFacing(device, facingMode) && idOf(device) !== currentDeviceId);
  if (preferred) return idOf(preferred);
  const anyFacing = candidates.find((device) => cameraLabelMatchesFacing(device, facingMode));
  if (anyFacing) return idOf(anyFacing);
  const other = currentDeviceId ? candidates.find((device) => idOf(device) !== currentDeviceId) : null;
  if (other) return idOf(other);
  return idOf(candidates[0]);
}

function rememberCameraStream(stream) {
  const track = stream?.getVideoTracks?.()[0];
  const deviceId = track?.getSettings?.().deviceId;
  if (deviceId) lastCameraDeviceId = deviceId;
}

async function maximizeCameraStreamResolution(stream) {
  const track = stream?.getVideoTracks?.()[0];
  if (!track?.applyConstraints || !track?.getCapabilities) return stream;
  let capabilities = {};
  try {
    capabilities = track.getCapabilities() || {};
  } catch {
    return stream;
  }
  const width = Number(capabilities.width?.max);
  const height = Number(capabilities.height?.max);
  const resolution = {};
  if (Number.isFinite(width) && width > 0) resolution.width = { ideal: width };
  if (Number.isFinite(height) && height > 0) resolution.height = { ideal: height };
  if (Object.keys(resolution).length) {
    try {
      await track.applyConstraints(resolution);
    } catch {
      // Keep the high-resolution stream when a device rejects its reported maximum pair.
    }
  }
  if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes("continuous")) {
    try {
      await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
    } catch {
      // Continuous autofocus is an optional enhancement.
    }
  }
  return stream;
}

async function prepareCameraStream(stream) {
  await maximizeCameraStreamResolution(stream);
  rememberCameraStream(stream);
  return stream;
}

async function openCameraStream() {
  const facing = cameraCaptureMode();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: cameraVideoConstraints({ facingMode: { exact: facing } }),
      audio: false
    });
    return prepareCameraStream(stream);
  } catch {
    // Some browsers reject exact facingMode even when the camera exists.
  }
  const deviceId = pickCameraDevice(await listVideoInputDevices(), facing, lastCameraDeviceId);
  if (deviceId) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: cameraVideoConstraints({ deviceId: { exact: deviceId } }),
        audio: false
      });
      return prepareCameraStream(stream);
    } catch {
      // Fall through to facingMode / generic camera fallback.
    }
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia(cameraMediaConstraints());
    return prepareCameraStream(stream);
  } catch (error) {
    if (error?.name === "NotFoundError" || error?.name === "OverconstrainedError") {
      const stream = await navigator.mediaDevices.getUserMedia({ video: cameraVideoConstraints(), audio: false });
      return prepareCameraStream(stream);
    }
    throw error;
  }
}

async function resolvePickupScannerVideoConstraints() {
  const facing = cameraCaptureMode();
  const resolution = {
    width: { min: 640, ideal: 1920 },
    height: { min: 480, ideal: 1080 }
  };

  const labelledDevice = (await listVideoInputDevices())
    .find((device) => cameraLabelMatchesFacing(device, facing));
  let deviceId = labelledDevice?.deviceId || "";

  if (!deviceId) {
    let probeStream = null;
    try {
      probeStream = await navigator.mediaDevices.getUserMedia({
        video: { ...resolution, facingMode: { exact: facing } },
        audio: false
      });
    } catch {
      probeStream = await navigator.mediaDevices.getUserMedia({
        video: { ...resolution, facingMode: { ideal: facing } },
        audio: false
      });
    }
    const probeTrack = probeStream?.getVideoTracks?.()[0];
    deviceId = probeTrack?.getSettings?.().deviceId || "";
    if (deviceId) lastCameraDeviceId = deviceId;
    probeStream?.getTracks?.().forEach((track) => track.stop());
    await new Promise((resolve) => window.setTimeout(resolve, 80));
  }

  return deviceId
    ? { ...resolution, deviceId: { exact: deviceId } }
    : { ...resolution, facingMode: { exact: facing } };
}

function switchCameraFacing() {
  cameraFacingMode = cameraFacingMode === "environment" ? "user" : "environment";
  localStorage.setItem(CAMERA_FACING_KEY, cameraFacingMode);
}

function renderCameraSwitchButton(action) {
  return `<button class="secondary-button compact-camera-button" data-action="${action}" type="button">${t("common.switchCamera", "Switch camera")} (${cameraFacingLabel()})</button>`;
}

function cameraErrorMessage(error) {
  if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
    return t("operator.cameraPermissionRequired", "Camera permission is required. Allow camera access in the browser settings and try again.");
  }
  if (error?.name === "NotFoundError" || error?.name === "OverconstrainedError") {
    return t("operator.rearCameraUnavailable", "A rear camera is not available on this device.");
  }
  if (error?.name === "NotReadableError" || error?.name === "AbortError") {
    return t("operator.cameraInUse", "The camera is in use by another app. Close it and try again.");
  }
  return error?.message || t("operator.cameraOpenFailed", "Camera could not be opened.");
}

function showToast(message) {
  toast.textContent = localizeMessage(message);
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 1800);
}

function customerPickupScanActive() {
  return currentModule === "customer-pickup-scan" && Boolean(authToken);
}

function focusCustomerPickupScanInput({ select = false } = {}) {
  if (!customerPickupScanActive()) return;
  const input = document.getElementById("customerPickupScan");
  if (!input) return;
  input.focus({ preventScroll: true });
  if (select) input.select();
}

function scheduleCustomerPickupFocus() {
  window.clearInterval(pickupFocusTimer);
  pickupFocusTimer = null;
  if (!customerPickupScanActive()) return;
  focusCustomerPickupScanInput();
  pickupFocusTimer = window.setInterval(() => {
    if (!customerPickupScanActive()) {
      window.clearInterval(pickupFocusTimer);
      pickupFocusTimer = null;
      return;
    }
    const active = document.activeElement;
    const canRefocus = !active
      || active === document.body
      || active.id === "customerPickupScan"
      || active.closest?.(".customer-pickup-scan-card");
    if (canRefocus) focusCustomerPickupScanInput();
  }, 1200);
}

async function submitCustomerPickupScanValue(value) {
  const code = String(value || "").trim();
  if (!code) return;
  customerPickupScan = code;
  const input = document.getElementById("customerPickupScan");
  if (input) input.value = code;
  await lookupCustomerPickup();
}

async function handleCustomerPickupScannerKey(event) {
  if (!customerPickupScanActive() || event.defaultPrevented) return false;
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  const target = event.target;
  const targetIsScanInput = target?.id === "customerPickupScan";
  if (targetIsScanInput) return false;
  if (target?.closest?.("input, textarea, select, [contenteditable='true']")) return false;

  const now = Date.now();
  if (now - pickupScannerLastKeyAt > 120) pickupScannerBuffer = "";
  pickupScannerLastKeyAt = now;

  if (event.key === "Enter" || event.key === "Tab") {
    const code = pickupScannerBuffer.trim();
    pickupScannerBuffer = "";
    if (!code) return false;
    event.preventDefault();
    await submitCustomerPickupScanValue(code);
    return true;
  }

  if (event.key === "Backspace") {
    pickupScannerBuffer = pickupScannerBuffer.slice(0, -1);
    event.preventDefault();
    return true;
  }

  if (event.key?.length === 1) {
    pickupScannerBuffer += event.key;
    event.preventDefault();
    return true;
  }

  return false;
}

function installLabel() {
  if (appInstalled) return t("operator.appMode", "App mode");
  if (installPromptEvent) return t("operator.installApp", "Install app");
  return t("operator.useBrowserInstall", "Use browser install");
}

function renderInstallButton() {
  if (appInstalled) return `<span class="install-status">${t("operator.appMode", "App mode")}</span>`;
  return `<button class="secondary-button install-button" data-action="install-app" type="button">${installLabel()}</button>`;
}

function notificationPermissionState() {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission || "default";
}

function renderNotificationButton() {
  const permission = notificationPermissionState();
  if (permission === "granted") return "";
  if (permission === "denied") return `<span class="install-status warning">${t("operator.notificationsBlocked", "Notifications blocked")}</span>`;
  return `<button class="secondary-button notification-button" data-action="enable-delivery-notifications" type="button">${t("common.enableNotifications", "Enable notifications")}</button>`;
}

function currentDraftLock() {
  const localOrder = selectedOrder && orderLocksCurrentOperator(selectedOrder)
    ? selectedOrder
    : orders.find((order) => orderLocksCurrentOperator(order));
  if (localOrder) {
    return {
      orderId: localOrder.netsuite_id,
      tranid: localOrder.tranid,
      orderType: localOrder.order_type,
      draftLineCount: (localOrder.lines || []).filter((line) => line.confirmed || hasPackedQty(line)).length
    };
  }
  if (activeDeliveryDraft?.netsuite_id) {
    return {
      orderId: activeDeliveryDraft.netsuite_id,
      tranid: activeDeliveryDraft.tranid,
      orderType: activeDeliveryDraft.order_type,
      draftLineCount: activeDeliveryDraft.draft_line_count || 0
    };
  }
  return null;
}

function renderReleaseDraftButton() {
  const draft = currentDraftLock();
  if (!draft?.orderId) return "";
  return `<button class="secondary-button danger-button release-draft-button" data-action="release-current-draft" data-order="${draft.orderId}" type="button">${t("operator.releaseDraft", "Release")} ${escapeHtml(draft.tranid || draft.orderId)}</button>`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
    cache: "no-store",
    ...options
  });
  if (response.status === 401) {
    clearOperatorSession();
    operator = null;
    localStorage.removeItem(STATE_KEY);
    renderLogin("Login expired. Please login again.");
    throw new Error("Login required");
  }
  if (!response.ok) {
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    const error = new Error(payload?.error || text || "Request failed.");
    error.status = response.status;
    error.payload = payload;
    if (response.status === 403 && payload?.redirect) window.location.replace(payload.redirect);
    throw error;
  }
  return response.json();
}

function dataUrlToFile(dataUrl, filename = "photo.jpg") {
  const [header, body] = String(dataUrl || "").split(",");
  const mime = header.match(/data:([^;]+)/)?.[1] || "image/jpeg";
  const binary = atob(body || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], filename, { type: mime });
}

function photoSrc(value) {
  const text = String(value || "");
  if (!text.startsWith("r2://")) return text;
  return `/api/photo-upload/preview?ref=${encodeURIComponent(text)}&token=${encodeURIComponent(authToken || "")}`;
}

function photoImgSrc(value) {
  return escapeHtml(photoSrc(value));
}

function openPhotoLightbox(photoRef, label = "Photo preview") {
  const ref = String(photoRef || "");
  if (!ref) return;
  const existing = document.querySelector(".photo-lightbox");
  if (existing) existing.remove();
  const modal = document.createElement("div");
  modal.className = "photo-lightbox";
  modal.innerHTML = `
    <div class="photo-lightbox-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(label)}">
      <button class="photo-lightbox-close" type="button">×</button>
      <img src="${photoImgSrc(ref)}" alt="${escapeHtml(label)}" />
    </div>
  `;
  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target.closest(".photo-lightbox-close")) modal.remove();
  });
  document.body.appendChild(modal);
}

async function uploadOperatorPhoto(photo, context = {}) {
  if (!photo || String(photo).startsWith("r2://")) return photo;
  if (!String(photo).startsWith("data:image/")) return photo;
  const ticket = await api("/api/operator/photo-upload-token", {
    method: "POST",
    body: JSON.stringify(context)
  });
  const file = dataUrlToFile(photo, context.filename || `${context.recordType || "operator-photo"}.jpg`);
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(ticket.uploadUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${ticket.token}` },
    body: formData
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) throw new Error(payload?.error || text || "Photo upload failed.");
  if (!payload?.key) throw new Error("Photo upload did not return an R2 key.");
  return `r2://${payload.key}`;
}

async function uploadOperatorPhotos(photos, context = {}) {
  const uploaded = [];
  for (let index = 0; index < photos.length; index += 1) {
    uploaded.push(await uploadOperatorPhoto(photos[index], {
      ...context,
      filename: `${context.recordType || "operator-photo"}-${index + 1}.jpg`
    }));
  }
  return uploaded;
}

async function publicApi(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function markLocalDeliveryMutation(orderId, ttlMs = 4000) {
  const key = String(orderId || "").trim();
  if (key) localDeliveryMutationRefs.set(key, Date.now() + ttlMs);
}

function finishLocalDeliveryMutation(orderId) {
  markLocalDeliveryMutation(orderId, 1500);
}

function isLocalDeliveryMutationEvent(payload = {}) {
  const now = Date.now();
  for (const [key, expiresAt] of localDeliveryMutationRefs.entries()) {
    if (expiresAt <= now) localDeliveryMutationRefs.delete(key);
  }
  const refs = [payload.orderId, payload.orderRef, payload.tranid]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return refs.some((ref) => (localDeliveryMutationRefs.get(ref) || 0) > now);
}

function connectEvents() {
  if (!authToken || eventSource) return;
  eventSource = new EventSource(`/api/events?client=operator&token=${encodeURIComponent(authToken)}`);
  eventSource.addEventListener("app-event", (message) => {
    let event;
    try {
      event = JSON.parse(message.data || "{}");
    } catch {
      return;
    }
    const payload = event.payload || {};
    if (event.type === "connected" || !operator || !locationId) return;
    const deliveryEvents = [
      "dispatch.plan.saved",
      "dispatch.plan.confirmed",
      "dispatch.operator_request.created",
      "delivery.order.updated",
      "delivery.line.confirmed",
      "delivery.line.updated",
      "delivery.order.unpacked",
      "delivery.order.loaded",
      "delivery.consolidation.updated",
      "dispatch.orders.updated"
    ];
    const receivingEvents = [
      "dispatch.co.updated",
      "receiving.line.confirmed",
      "receiving.line.unconfirmed",
      "receiving.order.received",
      "dispatch.vendor_yard.updated",
      "dispatch.orders.updated"
    ];
    const needsDelivery = deliveryEvents.includes(event.type);
    const needsReceiving = receivingEvents.includes(event.type);
    if (!needsDelivery && !needsReceiving) return;
    if (needsDelivery && isLocalDeliveryMutationEvent(payload)) return;
    if (needsDelivery) {
      deliveryOrderBuckets.active = null;
      deliveryOrderBuckets.packed = null;
    }
    pendingDeliveryEventRefresh ||= needsDelivery;
    pendingReceivingEventRefresh ||= needsReceiving;
    pendingOperatorRequestAlert ||= event.type === "dispatch.operator_request.created";
    if (needsDelivery && Array.isArray(payload.changedOperatorRefs)) {
      payload.changedOperatorRefs.forEach((ref) => {
        const cleanRef = String(ref || "").trim();
        if (cleanRef) pendingDeliveryEventAlertRefs.add(cleanRef);
      });
    }
    window.clearTimeout(eventRefreshTimer);
    eventRefreshTimer = window.setTimeout(async () => {
      try {
        const alertRefs = [...pendingDeliveryEventAlertRefs];
        pendingDeliveryEventAlertRefs.clear();
        const refreshDelivery = pendingDeliveryEventRefresh;
        const refreshReceiving = pendingReceivingEventRefresh;
        const showOperatorRequestAlert = pendingOperatorRequestAlert;
        pendingDeliveryEventRefresh = false;
        pendingReceivingEventRefresh = false;
        pendingOperatorRequestAlert = false;
        if (refreshDelivery && currentModule === "delivery-consolidation" && !consolidationBusy) {
          await loadConsolidation({ keepItem: true });
          return;
        }
        if (refreshDelivery && currentModule === "delivery" && !fulfillmentSubmitting) {
          await loadOrders({ keepSelection: true, alertRefs });
          showToast("Orders updated");
          return;
        }
        if (refreshDelivery) {
          await Promise.all([
            loadDeliveryNotifications({ alertRefs }),
            loadCurrentDeliveryDraft()
          ]);
        }
        if (refreshDelivery && currentModule === "delivery-select" && !fulfillmentSubmitting) {
          render();
          return;
        }
        if (refreshReceiving && currentModule === "receiving" && !receiptSubmitting) {
          await loadReceivingOptions();
          if (receivingStep === "orders") await loadReceivingOrders({ keepSelection: true });
          else render();
          showToast("Receiving updated");
          return;
        }
        if (showOperatorRequestAlert) {
          showToast("Dispatch request received");
        } else if (refreshDelivery && currentModule === "menu") {
          render();
        }
      } catch (error) {
        showToast(error.message);
      }
    }, 500);
  });
  eventSource.onerror = () => {
    eventSource?.close();
    eventSource = null;
    if (authToken) window.setTimeout(connectEvents, 3000);
  };
}

function disconnectEvents() {
  window.clearTimeout(eventRefreshTimer);
  pendingDeliveryEventRefresh = false;
  pendingReceivingEventRefresh = false;
  pendingOperatorRequestAlert = false;
  pendingDeliveryEventAlertRefs.clear();
  eventSource?.close();
  eventSource = null;
}

function currentLocation() {
  return LOCATIONS.find((location) => location.id === Number(locationId));
}

function statusText(status) {
  return {
    open: t("operator.open", "Open"),
    preparing: t("operator.preparing", "Preparing"),
    packed: t("operator.packed", "Packed"),
    fulfilled: t("operator.statusFulfilled", "Fulfilled"),
    loaded: t("common.loaded", "Loaded"),
    partial_loaded: t("operator.statusPartialLoaded", "Partial Loaded")
  }[status] || t("operator.open", "Open");
}

function orderWarningCount(order) {
  return qty(order?.warning_count);
}

function orderUnderpackCount(order) {
  return qty(order?.underpack_count);
}

function isVrmaReferenceOrder(order = selectedOrder) {
  return order?.vrma_reference_only === true;
}

function isVrmaOrder(order = selectedOrder) {
  return order?.order_type === "vrma_order";
}

function orderStatusText(order) {
  if (isVrmaReferenceOrder(order)) return order?.dispatch_planned ? t("operator.planned", "Planned") : t("operator.batchB", "Batch B");
  if (orderWarningCount(order)) return t("operator.warning", "Warning");
  if (orderUnderpackCount(order)) return t("operator.statusUnderpack", "Underpack");
  if (order?.local_yard_order_status === "Loaded") return t("common.loaded", "Loaded");
  return statusText(order?.operator_status);
}

function orderStatusClass(order) {
  if (isVrmaReferenceOrder(order)) return order?.dispatch_planned ? "planned" : "open";
  if (orderWarningCount(order)) return "warning";
  if (orderUnderpackCount(order)) return "underpack";
  if (order?.local_yard_order_status === "Loaded") return "loaded";
  return order?.operator_status || "open";
}

function formatDate(value) {
  if (!value) return "";
  return window.MBBS_I18N?.displayDate(value) || "";
}

function formatDateTime(value) {
  if (!value) return "";
  return window.MBBS_I18N?.displayDateTime(value) || "";
}

function localDateKey(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDaysKey(days) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return localDateKey(date);
}

function timeToMinutes(value) {
  const text = String(value || "").replace(/[^0-9]/g, "");
  if (!text) return null;
  const padded = text.length <= 2 ? `${text}00` : text.padStart(4, "0").slice(0, 4);
  const hours = Number(padded.slice(0, 2));
  const minutes = Number(padded.slice(2, 4));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours > 23 || minutes > 59) return null;
  return (hours * 60) + minutes;
}

function beforeNoonWindow(order) {
  const start = timeToMinutes(order?.dispatch_window_start);
  const end = timeToMinutes(order?.dispatch_window_end);
  if (end !== null) return end <= 12 * 60;
  if (start !== null) return start < 12 * 60;
  return false;
}

function hasDeliveryWindow(order) {
  return timeToMinutes(order?.dispatch_window_start) !== null || timeToMinutes(order?.dispatch_window_end) !== null;
}

function isTomorrowNoWindow(order) {
  return localDateKey(order?.expected_delivery_date) === addDaysKey(1) && !hasDeliveryWindow(order);
}

function deliveryDateSortKey(order) {
  return localDateKey(order?.expected_delivery_date || order?.dispatch_plan_date) || "9999-12-31";
}

function plannedDateSortKey(order) {
  return localDateKey(order?.dispatch_plan_date || order?.expected_delivery_date) || "9999-12-31";
}

function deliveryTimeSortKey(order) {
  const start = timeToMinutes(order?.dispatch_window_start);
  if (start !== null) return start;
  const end = timeToMinutes(order?.dispatch_window_end);
  if (end !== null) return end;
  return 24 * 60 + 1;
}

function loadSortKey(order) {
  const load = String(order?.dispatch_load_name || "");
  const match = load.match(/load\s*(\d+)/i) || load.match(/\b(\d+)\b/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function compareText(left, right) {
  return String(left || "").localeCompare(String(right || ""), undefined, { numeric: true, sensitivity: "base" });
}

function sortDeliveryOrders(list) {
  const sorted = [...list];
  if (deliveryPrepMode === "saved") return sorted;
  if (deliveryPrepMode === "load") {
    return sorted.sort((a, b) =>
      loadSortKey(a) - loadSortKey(b)
      || compareText(a.dispatch_load_name, b.dispatch_load_name)
      || compareText(a.tranid, b.tranid)
    );
  }
  if (deliveryPrepMode === "standard" && viewMode === "active" && deliveryBatchFilter === "transfer") {
    return sorted.sort((a, b) =>
      plannedDateSortKey(a).localeCompare(plannedDateSortKey(b))
      || loadSortKey(a) - loadSortKey(b)
      || compareText(a.tranid, b.tranid)
    );
  }
  if (deliveryPrepMode === "standard" && viewMode === "active" && deliveryBatchFilter === "planned") {
    return sorted.sort((a, b) =>
      plannedDateSortKey(a).localeCompare(plannedDateSortKey(b))
      || loadSortKey(a) - loadSortKey(b)
      || compareText(a.dispatch_truck_plate, b.dispatch_truck_plate)
      || compareText(a.tranid, b.tranid)
    );
  }
  if (deliveryOrderType === "sales_order" && viewMode === "active" && deliveryBatchFilter === "batch_a") {
    return sorted.sort((a, b) =>
      deliveryDateSortKey(a).localeCompare(deliveryDateSortKey(b))
      || deliveryTimeSortKey(a) - deliveryTimeSortKey(b)
      || compareText(a.tranid, b.tranid)
    );
  }
  return sorted;
}

function isBatchAOrder(order) {
  if (order?.dispatch_planned) return false;
  const expected = localDateKey(order?.expected_delivery_date);
  if (!expected) return false;
  const today = addDaysKey(0);
  const tomorrow = addDaysKey(1);
  return expected <= today || (expected === tomorrow && (beforeNoonWindow(order) || !hasDeliveryWindow(order)));
}

function deliveryBatchForOrder(order) {
  if (order?.order_type === "co_order") return "planned";
  if (isVrmaOrder(order)) return order?.dispatch_planned ? "planned" : "batch_b";
  if (!["sales_order", "transfer_order"].includes(order?.order_type)) return "";
  if (order?.dispatch_planned) return "planned";
  if (order?.order_type === "transfer_order") return "transfer";
  return isBatchAOrder(order) ? "batch_a" : "batch_b";
}

function deliveryBatchForNotification(item) {
  if (item?.dispatchPlanned) return "planned";
  return item?.type === "transfer_order" ? "transfer" : "batch_a";
}

function orderMatchesDeliveryBatch(order, filter = deliveryBatchFilter) {
  if (deliveryPrepMode === "load" || deliveryPrepMode !== "standard" || viewMode !== "active") return true;
  return deliveryBatchForOrder(order) === filter;
}

function filteredDeliveryOrders() {
  const filtered = sortDeliveryOrders(orders.filter((order) => orderMatchesDeliveryBatch(order)));
  const lockedId = preparingOrderId();
  if (lockedId && !filtered.some((order) => String(order.netsuite_id) === String(lockedId))) {
    const lockedOrder = orders.find((order) => String(order.netsuite_id) === String(lockedId));
    if (lockedOrder) return [lockedOrder, ...filtered];
  }
  return filtered;
}

function deliveryBatchCounts() {
  if (deliveryPrepMode !== "standard") return { planned: 0, batch_a: 0, batch_b: 0, transfer: 0 };
  return {
    planned: orders.filter((order) => orderMatchesDeliveryBatch(order, "planned")).length,
    batch_a: orders.filter((order) => orderMatchesDeliveryBatch(order, "batch_a")).length,
    batch_b: orders.filter((order) => orderMatchesDeliveryBatch(order, "batch_b")).length,
    transfer: orders.filter((order) => orderMatchesDeliveryBatch(order, "transfer")).length
  };
}

function deliveryNotificationItems() {
  return Array.isArray(deliveryNotifications?.items) ? deliveryNotifications.items : [];
}

function deliveryNotificationBaseKey(item) {
  return `${item?.type || "order"}:${item?.orderId || item?.tranid || ""}`;
}

function deliveryNotificationKey(item) {
  const base = deliveryNotificationBaseKey(item);
  const reason = item?.dispatchPlanned
    ? `planned:${item?.dispatchPlanDate || ""}:${item?.dispatchPlannedAt || ""}:${item?.truck || ""}:${item?.load || ""}:${item?.parkingSpot || ""}`
    : `due:${item?.expectedDeliveryDate || item?.dispatchPlanDate || ""}`;
  return `${base}:${reason}`;
}

function isRecentPlannedDeliveryNotification(item) {
  if (!item?.dispatchPlanned || !item?.dispatchPlannedAt) return false;
  const plannedAt = new Date(item.dispatchPlannedAt).getTime();
  if (!Number.isFinite(plannedAt)) return false;
  return Date.now() - plannedAt <= 30 * 60 * 1000;
}

function updateDeliveryNotificationState(items) {
  deliveryNotificationState = new Map(items.map((item) => [deliveryNotificationBaseKey(item), deliveryNotificationKey(item)]));
  deliveryNotificationStateReady = true;
}

function changedDeliveryNotificationItems(items) {
  return items.filter((item) => {
    const base = deliveryNotificationBaseKey(item);
    const key = deliveryNotificationKey(item);
    if (!base || base.endsWith(":") || !key || key.endsWith(":")) return false;
    const previous = deliveryNotificationState.get(base);
    if (!previous) return deliveryNotificationStateReady && Boolean(item?.dispatchPlanned);
    return previous !== key;
  });
}

function urgentDeliveryTitle(items = []) {
  if (items.length === 1) return t("operator.newUrgentDelivery", "New urgent delivery order");
  return `${items.length} ${t("operator.newUrgentDeliveries", "new urgent delivery orders")}`;
}

function urgentDeliveryBody(items = []) {
  const first = items[0] || {};
  const orderType = first.type === "transfer_order" ? t("operator.transferOrder", "Transfer Order") : t("operator.salesOrder", "Sales Order");
  const parts = [first.tranid, orderType, first.parkingSpot ? `${t("operator.parkingSpot", "Parking spot")} ${first.parkingSpot}` : ""].filter(Boolean);
  return parts.join(" | ");
}

function playDeliveryDing() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const context = new AudioContext();
    context.resume?.().catch(() => {});
    const master = context.createGain();
    master.gain.setValueAtTime(1, context.currentTime);
    master.connect(context.destination);

    const bell = (start, frequency, duration) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(frequency, context.currentTime + start);
      oscillator.frequency.exponentialRampToValueAtTime(frequency * 1.18, context.currentTime + start + 0.08);
      gain.gain.setValueAtTime(0.0001, context.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(1, context.currentTime + start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + start + duration);
      oscillator.connect(gain);
      gain.connect(master);
      oscillator.start(context.currentTime + start);
      oscillator.stop(context.currentTime + start + duration + 0.03);
    };

    bell(0, 1046.5, 0.34);
    bell(0.18, 1568, 0.52);
    bell(0.28, 2093, 0.36);
    window.setTimeout(() => context.close().catch(() => {}), 1100);
  } catch {
    // Browser audio can be blocked until the operator has interacted with the app.
  }
}

async function showBrowserDeliveryNotification(items) {
  if (!("Notification" in window) || !items.length) return;
  if (Notification.permission !== "granted") return;
  const title = urgentDeliveryTitle(items);
  const noticeTag = deliveryNotificationKey(items[0] || {}).replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 120);
  const options = {
    body: urgentDeliveryBody(items),
    tag: `delivery-prep-${locationId || "yard"}-${noticeTag || Date.now()}`,
    renotify: true,
    icon: "/icons/mbbs-yard-192.png",
    badge: "/icons/mbbs-yard-192.png",
    silent: true,
    requireInteraction: true,
    timestamp: Date.now(),
    data: { url: "/operator", notice: "delivery-prep" }
  };
  const registration = await navigator.serviceWorker?.ready?.catch(() => null);
  if (registration?.showNotification) {
    await registration.showNotification(title, options).catch(() => {});
    return;
  }
  const notification = new Notification(title, options);
  notification.onclick = () => {
    window.focus();
    openUrgentDeliveryAlert();
    notification.close();
  };
}

function showUrgentDeliveryAlert(items) {
  if (!items.length) return;
  const existingItems = urgentDeliveryAlert?.items || [];
  const merged = [...items, ...existingItems].reduce((list, item) => {
    const key = deliveryNotificationBaseKey(item);
    if (!key || list.some((existing) => deliveryNotificationBaseKey(existing) === key)) return list;
    list.push(item);
    return list;
  }, []);
  urgentDeliveryAlert = {
    items: merged,
    createdAt: urgentDeliveryAlert?.createdAt || Date.now(),
    updatedAt: Date.now()
  };
  playDeliveryDing();
  if (document.visibilityState !== "visible") {
    showBrowserDeliveryNotification(items).catch(() => {});
  }
  render();
}

function renderUrgentDeliveryAlert() {
  const items = urgentDeliveryAlert?.items || [];
  if (!items.length) return "";
  const permission = "Notification" in window ? Notification.permission : "unsupported";
  const first = items[0] || {};
  const alertTime = urgentDeliveryAlert?.updatedAt
    ? new Date(urgentDeliveryAlert.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "";
  return `
    <aside class="urgent-delivery-alert" role="status" aria-live="polite">
      <button class="urgent-delivery-main" data-action="open-urgent-delivery-alert" type="button">
        <b>${urgentDeliveryTitle(items)}</b>
        <span>${escapeHtml(urgentDeliveryBody(items))}</span>
        ${items.length > 1 ? `<em>${escapeHtml(items.slice(0, 3).map((item) => item.tranid).filter(Boolean).join(" / "))}</em>` : ""}
      </button>
      <div>
        ${permission === "default" ? `<button class="secondary-button" data-action="enable-delivery-notifications" type="button">${t("common.enableNotifications", "Enable notifications")}</button>` : ""}
        <button class="secondary-button" data-action="dismiss-urgent-delivery-alert" type="button">${t("common.dismiss", "Dismiss")}</button>
      </div>
      <small>${[formatDate(first.expectedDeliveryDate || first.dispatchPlanDate) || t("common.today", "Today"), alertTime].filter(Boolean).join(" | ")}</small>
    </aside>
  `;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function compactTime(value) {
  const minutes = timeToMinutes(value);
  if (minutes === null) return "";
  const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mins = String(minutes % 60).padStart(2, "0");
  return `${hours}${mins}`;
}

function deliveryWindowText(order) {
  const start = compactTime(order?.dispatch_window_start);
  const end = compactTime(order?.dispatch_window_end);
  if (start && end) return `${start}-${end}`;
  if (start) return tf("operator.afterTime", "After {time}", { time: start });
  if (end) return tf("operator.beforeTime", "Before {time}", { time: end });
  return t("operator.allDay", "All day");
}

function deliveryScheduleText(order) {
  if (isVrmaOrder(order)) {
    return tf("operator.pickupRoute", "Pickup {from} → {to}", {
      from: order?.outbound_location || "--",
      to: order?.destination_location || t("operator.vendorYard", "Vendor yard")
    });
  }
  const expected = order?.expected_delivery_date;
  if (!expected) return t("operator.noDeliveryDate", "No delivery date");
  return tf("operator.deliverySchedule", "Delivery {date} | {window}", {
    date: formatDate(expected),
    window: deliveryWindowText(order)
  });
}

function plannedOrderText(order, { spotLabel = "Spot" } = {}) {
  const parts = [
    formatDate(order?.dispatch_plan_date),
    order?.dispatch_truck_plate,
    order?.dispatch_load_name
  ].filter(Boolean);
  const spot = order?.dispatch_parking_spot
    ? ` | ${t("operator.spot", spotLabel)} ${escapeHtml(order.dispatch_parking_spot)}`
    : "";
  return `${t("operator.planned", "Planned")} ${escapeHtml(parts.join(" "))}${spot}`;
}

function renderFullOrderNote(order) {
  const memo = String(order?.memo || "").trim();
  if (!memo) return "";
  const title = t("operator.fullNote", "Full note");
  return `<div class="full-order-note"><strong>${title}</strong><p>${escapeHtml(memo)}</p></div>`;
}

function shouldShowDeliverySchedule() {
  return currentModule === "delivery" && deliveryOrderType === "sales_order";
}

function qty(value) {
  if (value === null || value === undefined || value === "") return 0;
  return Number(value);
}

function displayQty(value) {
  const number = qty(value);
  return number ? number.toLocaleString() : "-";
}

function displaySignedQty(value) {
  const number = qty(value);
  if (!number) return "0";
  return `${number > 0 ? "+" : ""}${number.toLocaleString()}`;
}

function itemCountUnits(item) {
  const units = [
    { key: "cycle-pallets", bodyKey: "pallets", label: "PLT", conversion: qty(item.to_plt) },
    { key: "cycle-layers", bodyKey: "layers", label: "LYR", conversion: qty(item.to_lyr) },
    { key: "cycle-sections", bodyKey: "sections", label: "SEC", conversion: qty(item.to_sec) },
    { key: "cycle-pieces", bodyKey: "pieces", label: "PCS", conversion: qty(item.to_pcs) }
  ].filter((unit) => unit.conversion > 0);
  if (units.length) return units;
  return [{ key: "cycle-default", bodyKey: "pieces", label: item.stock_unit || "Qty", conversion: 1 }];
}

function isCustomerPickupMode() {
  return currentModule === "customer-pickup" || currentModule === "customer-pickup-load";
}

function lineHasConversion(line) {
  return qty(line.to_plt) > 0 || qty(line.to_lyr) > 0 || qty(line.to_sec) > 0 || qty(line.to_pcs) > 0;
}

function isPalletSalesItem(line) {
  return String(line?.sku || line?.item_name || "").trim().toUpperCase() === "PALLET";
}

function isIndependentManualLine(line) {
  return !lineHasConversion(line) && !shouldUseSalesQuantity(line) && hasCustomPackQty(line);
}

function shouldUseSalesQuantity(line) {
  return !lineHasConversion(line) && qty(line.quantity) > 0;
}

function salesQuantityLabel(line, fallback = "Qty") {
  return isPalletSalesItem(line) ? "PALLET" : line?.unit || fallback;
}

function lineUnitsToSalesQty(line, values) {
  if (!lineHasConversion(line)) return qty(values.pieces) || qty(values.sections) || qty(values.layers) || qty(values.pallets);
  return (qty(values.pallets) * qty(line.to_plt))
    + (qty(values.layers) * qty(line.to_lyr))
    + (qty(values.sections) * qty(line.to_sec))
    + (qty(values.pieces) * qty(line.to_pcs));
}

function lineRequiredSalesQty(line) {
  return qty(line.quantity) || lineUnitsToSalesQty(line, {
    pallets: line.pallet_qty,
    layers: line.layer_qty,
    sections: line.section_qty,
    pieces: line.piece_qty
  });
}

const LOAD_SALES_QTY_TOLERANCE = 0.1;

function wholeUnitsFromSalesQty(salesQuantity, conversion) {
  const sales = qty(salesQuantity);
  const unitSize = qty(conversion);
  if (!sales || !unitSize) return 0;
  const rawUnits = sales / unitSize;
  const floorUnits = Math.floor(rawUnits + 0.000001);
  const ceilUnits = Math.ceil(rawUnits - 0.000001);
  if (ceilUnits > floorUnits && Math.abs((ceilUnits * unitSize) - sales) <= LOAD_SALES_QTY_TOLERANCE) {
    return ceilUnits;
  }
  return floorUnits;
}

function unitConversion(line, unit) {
  if (unit === "pallets") return qty(line.to_plt);
  if (unit === "layers") return qty(line.to_lyr);
  if (unit === "sections") return qty(line.to_sec);
  if (unit === "pieces") return qty(line.to_pcs);
  return 0;
}

function explicitUnitQty(line, unit) {
  if (unit === "pallets") return qty(line.pallet_qty);
  if (unit === "layers") return qty(line.layer_qty);
  if (unit === "sections") return qty(line.section_qty);
  if (unit === "pieces") return qty(line.piece_qty);
  return 0;
}

function unitRequiredLimit(line, unit) {
  if (unit === "sales") return qty(line.quantity);
  const conversion = unitConversion(line, unit);
  if (!conversion) return 0;
  const explicit = explicitUnitQty(line, unit);
  if (explicit > 0) return explicit;
  return !hasCustomPackQty(line) ? wholeUnitsFromSalesQty(lineRequiredSalesQty(line), conversion) : 0;
}

function loadedUnits(line) {
  const loadedSales = qty(line.loaded_qty);
  if (!loadedSales) return { pallets: 0, layers: 0, sections: 0, pieces: 0, sales: 0 };
  if (shouldUseSalesQuantity(line)) {
    return { pallets: 0, layers: 0, sections: 0, pieces: 0, sales: loadedSales };
  }
  let remainingLoaded = loadedSales;
  const consume = (required, conversion) => {
    if (!required || !conversion || remainingLoaded <= 0) return 0;
    const value = Math.min(required, Math.floor((remainingLoaded / conversion) + 0.000001));
    remainingLoaded = Math.max(0, remainingLoaded - (value * conversion));
    return value;
  };
  return {
    pallets: consume(unitRequiredLimit(line, "pallets"), qty(line.to_plt)),
    layers: consume(unitRequiredLimit(line, "layers"), qty(line.to_lyr)),
    sections: consume(unitRequiredLimit(line, "sections"), qty(line.to_sec)),
    pieces: consume(unitRequiredLimit(line, "pieces"), qty(line.to_pcs)),
    sales: loadedSales
  };
}

function pickupLoadedUnits(line) {
  return loadedUnits(line);
}

function loadedValue(line, unit) {
  const loaded = loadedUnits(line);
  if (unit === "pallets") return loaded.pallets;
  if (unit === "sections") return loaded.sections;
  if (unit === "layers") return loaded.layers;
  if (unit === "pieces") return loaded.pieces;
  if (unit === "sales") return loaded.sales;
  return 0;
}

function pickupLoadedValue(line, unit) {
  return loadedValue(line, unit);
}

function hasCustomerPickupDraft(order = selectedOrder) {
  return (order?.lines || []).some(hasPackedQty);
}

function exceptionText(line) {
  if (line.sync_exception === "line_deleted") {
    return t("operator.lineDeleted", "Line removed in NetSuite. Unpack this line and repack the order.");
  }
  if (line.sync_exception === "qty_reduced") {
    return t("operator.qtyReduced", "Required qty changed in NetSuite. Unpack this line and repack with the new qty.");
  }
  return "";
}

function exceptionLines(order) {
  return (order?.lines || []).filter((line) => line.sync_exception && hasPackedQty(line));
}

function warningOrders() {
  return orders.filter((order) => orderWarningCount(order) > 0);
}

function isPickableLine(line) {
  if (!line.item_type && !line.item_type_text) return false;
  const itemName = String(line.sku || line.item_name || line.itemName || "").trim().toUpperCase();
  if (itemName.startsWith("DELIVERY CHARGE") || itemName.startsWith("SALES CREDIT")) return false;
  return PICKABLE_ITEM_TYPES.has(line.item_type);
}

function visibleLines(order) {
  return (order?.lines || []).filter((line) => {
    if (line.sync_exception && hasPackedQty(line)) return viewMode === "packed";
    if (!isPickableLine(line)) return false;
    if (isCustomerPickupMode()) return hasPackedQty(line) || hasRemainingQty(line);
    if (viewMode !== "packed" && orderLocksCurrentOperator(order)) return hasPackedQty(line) || hasRemainingQty(line);
    return viewMode === "packed" ? hasPackedQty(line) : hasRemainingQty(line);
  });
}

function customerPickupVisibleLines(order) {
  return (order?.lines || []).filter((line) => {
    if (!isPickableLine(line)) return false;
    return hasPackedQty(line) || hasRemainingQty(line);
  });
}

function customerPickupUnavailableMessage(order) {
  const orderNo = order?.tranid || "This pickup order";
  const lines = order?.lines || [];
  if (!lines.length) {
    return `${orderNo} was found, but no item lines are synced locally. Please ask admin to sync this sales order detail.`;
  }

  const pickable = lines.filter(isPickableLine);
  if (!pickable.length) {
    const lineTypes = [...new Set(lines.map((line) => line.item_type_text || line.item_type || "Unknown").filter(Boolean))].join(", ");
    return `${orderNo} has no loadable item lines. Found only non-loadable line types: ${lineTypes || "Unknown"}.`;
  }

  const blocked = pickable.filter((line) => line.sync_exception);
  if (blocked.length === pickable.length) {
    return `${orderNo} has NetSuite line changes that need review before pickup. Please ask admin to refresh/check the order.`;
  }

  const requiredTotal = pickable.reduce((sum, line) => sum + lineRequiredSalesQty(line), 0);
  const loadedTotal = pickable.reduce((sum, line) => sum + qty(line.loaded_qty), 0);
  const uoms = [...new Set(pickable.map((line) => line.unit || "").filter(Boolean))];
  const uom = uoms.length === 1 ? ` ${uoms[0]}` : "";
  if (requiredTotal > 0 && loadedTotal >= requiredTotal) {
    return `${orderNo} is fully loaded locally. Loaded ${displayQty(loadedTotal)}${uom} of ${displayQty(requiredTotal)}${uom}; no remaining pickup quantity.`;
  }

  return `${orderNo} has no remaining loadable pickup lines. Please ask admin to check item type, quantity, and local loaded quantity.`;
}

function hasValue(value) {
  return qty(value) !== 0;
}

function hasCustomPackQty(line) {
  return hasValue(line.pallet_qty) || hasValue(line.section_qty) || hasValue(line.layer_qty) || hasValue(line.piece_qty);
}

function hasPackedQty(line) {
  return qty(line.packed_pallet_qty) > 0
    || qty(line.packed_section_qty) > 0
    || qty(line.packed_layer_qty) > 0
    || qty(line.packed_piece_qty) > 0
    || qty(line.packed_sales_qty) > 0;
}

function hasDraftPackedQty(order) {
  return (order?.lines || []).some((line) => isPickableLine(line) && hasPackedQty(line));
}

function canMarkPacked(order = selectedOrder) {
  return hasDraftPackedQty(order);
}

function hasRemainingQty(line) {
  if (shouldUseSalesQuantity(line)) return remainingValue(line, "sales") > 0;
  return remainingValue(line, "pallets") > 0
    || remainingValue(line, "sections") > 0
    || remainingValue(line, "layers") > 0
    || remainingValue(line, "pieces") > 0
    || (!lineHasConversion(line) && remainingValue(line, "sales") > 0);
}

function isUnderPacked(line) {
  return viewMode === "packed" && !line.sync_exception && hasRemainingQty(line);
}

function lineVariableUnit(line) {
  if (shouldUseSalesQuantity(line)) return { key: "sales", label: salesQuantityLabel(line), required: line.quantity, packedKey: "sales" };
  if (unitRequiredLimit(line, "sections") > 0 || packedValue(line, "sections") > 0) return { key: "sections", label: "SEC", required: unitRequiredLimit(line, "sections"), packedKey: "sections" };
  if (unitRequiredLimit(line, "layers") > 0 || packedValue(line, "layers") > 0) return { key: "layers", label: "LYR", required: unitRequiredLimit(line, "layers"), packedKey: "layers" };
  if (unitRequiredLimit(line, "pieces") > 0 || packedValue(line, "pieces") > 0) return { key: "pieces", label: "PCS", required: unitRequiredLimit(line, "pieces"), packedKey: "pieces" };
  if (!lineHasConversion(line)) return { key: "sales", label: salesQuantityLabel(line), required: line.quantity, packedKey: "sales" };
  return null;
}

function requiredValue(line, unit) {
  if (unit === "pallets" || unit === "sections" || unit === "layers" || unit === "pieces") return unitRequiredLimit(line, unit);
  if (unit === "sales") return qty(line.quantity);
  return 0;
}

function deliveryLineUnits(line) {
  if (line?.vrma_reference_only === true && !shouldUseSalesQuantity(line)) {
    const physical = [
      { key: "pallets", label: "PLT" },
      { key: "layers", label: "LYR" },
      { key: "sections", label: "SEC" },
      { key: "pieces", label: "PCS" }
    ].filter((unit) => requiredValue(line, unit.key) > 0);
    return physical.length ? physical : [{ key: "sales", label: line.unit || "Qty" }];
  }
  if (isIndependentManualLine(line)) {
    const physical = [
      { key: "pallets", label: "PLT" },
      { key: "layers", label: "LYR" },
      { key: "sections", label: "SEC" },
      { key: "pieces", label: "PCS" }
    ].filter((unit) => requiredValue(line, unit.key) > 0 || packedValue(line, unit.key) > 0);
    return [...physical, { key: "sales", label: line.unit || "Sales Qty" }];
  }
  const units = [];
  if (requiredValue(line, "pallets") > 0 || packedValue(line, "pallets") > 0) {
    units.push({ key: "pallets", label: "PLT" });
  }
  const variable = lineVariableUnit(line);
  if (variable && variable.packedKey !== "pallets") {
    units.push({ key: variable.packedKey, label: variable.label });
  }
  if (!units.length) units.push({ key: "sales", label: salesQuantityLabel(line) });
  return units;
}

function packedValue(line, unit) {
  if (unit === "sales") return qty(line.packed_sales_qty);
  const saved = unit === "pallets"
    ? line.packed_pallet_qty
    : unit === "sections"
      ? line.packed_section_qty
    : unit === "layers"
      ? line.packed_layer_qty
      : line.packed_piece_qty;
  return qty(saved);
}

function remainingValue(line, unit) {
  const loaded = loadedValue(line, unit);
  const remainingUnits = Math.max(0, requiredValue(line, unit) - loaded - packedValue(line, unit));
  if (remainingUnits > 0 || unit === "sales") return remainingUnits;
  const explicit = explicitUnitQty(line, unit);
  const conversion = unitConversion(line, unit);
  if (!explicit || !conversion) return remainingUnits;
  const remainingSales = Math.max(0, lineRequiredSalesQty(line) - qty(line.loaded_qty) - lineUnitsToSalesQty(line, {
    pallets: line.packed_pallet_qty,
    layers: line.packed_layer_qty,
    sections: line.packed_section_qty,
    pieces: line.packed_piece_qty
  }));
  return wholeUnitsFromSalesQty(remainingSales, conversion);
}

function isActiveDraftPackedLine(line, order = selectedOrder) {
  return currentModule === "delivery" && viewMode !== "packed" && orderLocksCurrentOperator(order) && hasPackedQty(line);
}

function activeDraftLimit(line, unit) {
  return Math.max(0, requiredValue(line, unit) - loadedValue(line, unit));
}

function panelValue(line, unit) {
  if (isActiveDraftPackedLine(line)) return packedValue(line, unit);
  return viewMode === "packed" ? packedValue(line, unit) : remainingValue(line, unit);
}

function panelLimit(line, unit) {
  if (currentModule === "receiving") return receivingRemainingValue(line, unit);
  if (isCustomerPickupMode()) return Math.max(0, requiredValue(line, unit) - pickupLoadedValue(line, unit));
  if (isActiveDraftPackedLine(line)) return activeDraftLimit(line, unit);
  return viewMode === "packed" ? requiredValue(line, unit) : remainingValue(line, unit);
}

function receivingRemainingSalesQty(line) {
  return Math.max(0, qty(line.quantity) - qty(line.netsuite_received_qty));
}

function receivingRemainingValue(line, unit) {
  const remainingSales = receivingRemainingSalesQty(line);
  if (unit === "sales") return remainingSales;
  const required = requiredValue(line, unit);
  if (isIndependentManualLine(line)) return required;
  const conversion = unit === "pallets" ? qty(line.to_plt)
    : unit === "layers" ? qty(line.to_lyr)
    : unit === "sections" ? qty(line.to_sec)
    : unit === "pieces" ? qty(line.to_pcs)
    : 0;
  if (!conversion) return 0;
  return Math.max(0, Math.min(required, wholeUnitsFromSalesQty(remainingSales, conversion)));
}

function hasReceivingRemainingQty(line) {
  return receivingRemainingSalesQty(line) > 0;
}

function receivingLineUnits(line) {
  if (isIndependentManualLine(line)) {
    const physical = [
      { key: "pallets", label: "PLT" },
      { key: "layers", label: "LYR" },
      { key: "sections", label: "SEC" },
      { key: "pieces", label: "PCS" }
    ].filter((unit) => requiredValue(line, unit.key) > 0 || receivingConfirmedValue(line, unit.key) > 0);
    return [
      ...physical,
      { key: "sales", label: line.unit || "Sales Qty" }
    ];
  }
  const units = [];
  if (receivingRemainingValue(line, "pallets") > 0 || qty(line.received_pallet_qty) > 0) {
    units.push({ key: "pallets", label: "PLT" });
  }
  const variable = lineVariableUnit(line);
  if (variable && variable.packedKey !== "pallets") {
    units.push({ key: variable.packedKey, label: variable.label });
  }
  if (!units.length) {
    units.push({ key: "sales", label: line.unit || "Qty" });
  }
  return units;
}

function orderLocksCurrentOperator(order) {
  if (!order) return false;
  const ownedByCurrentOperator = order.preparing_operator_id && String(order.preparing_operator_id) === String(operator?.id);
  if (hasDraftPackedQty(order)) return Boolean(ownedByCurrentOperator);
  return order.operator_status === "preparing" && Boolean(ownedByCurrentOperator);
}

function preparingOrderId() {
  if (viewMode !== "active") return null;
  if (orderLocksCurrentOperator(selectedOrder)) return selectedOrder.netsuite_id || null;
  return orders.find((order) => orderLocksCurrentOperator(order))?.netsuite_id || activeDeliveryDraft?.netsuite_id || null;
}

function currentOrderBlocksMove() {
  return Boolean(preparingOrderId());
}

function pageCount(items, size) {
  return Math.max(1, Math.ceil(items.length / size));
}

function pageItems(items, page, size) {
  return items.slice(page * size, page * size + size);
}

function activeLinePageSize() {
  return compactLineMode ? COMPACT_LINE_PAGE_SIZE : LINE_PAGE_SIZE;
}

function renderLineDensityToggle() {
  return `
    <div class="line-density-toggle" role="group" aria-label="${t("operator.lineListDisplayMode", "Line list display mode")}">
      <button class="${compactLineMode ? "" : "active"}" data-action="set-line-density" data-density="normal" type="button">${t("operator.normal", "Normal")}</button>
      <button class="${compactLineMode ? "active" : ""}" data-action="set-line-density" data-density="compact" type="button">${t("operator.compact", "Compact")}</button>
    </div>
  `;
}

function locationOptions() {
  return LOCATIONS.map((location) => `
    <option value="${location.id}" ${Number(location.id) === Number(locationId) ? "selected" : ""}>${location.text}</option>
  `).join("");
}

function shell(title, subtitle, body, actions = "") {
  app.innerHTML = `
    <header class="topbar">
      <div class="topbar-location">
        <button class="secondary-button location-button" data-action="toggle-location-dropdown" type="button">${t("common.location", "Location")} ${currentLocation()?.text || locationId || ""}</button>
        ${locationDropdownOpen ? `
          <div class="location-dropdown">
            ${LOCATIONS.map((location) => `
              <button class="${Number(location.id) === Number(locationId) ? "active" : ""}" data-action="set-location-dropdown" data-location-id="${location.id}" type="button">${location.text}</button>
            `).join("")}
          </div>
        ` : ""}
      </div>
      <div class="topbar-title">
        <p>${t("app.operator", "MBBS Yard Operator Application")}</p>
        <h1>${title}</h1>
        <span>${subtitle}</span>
      </div>
      <div class="topbar-language">${languageToggle()}</div>
      <div class="topbar-actions">${operator ? `${renderReleaseDraftButton()}${renderNotificationButton()}` : ""}${actions}</div>
    </header>
    ${renderUrgentDeliveryAlert()}
    ${body}
  `;
  if (fulfillmentCameraActive) window.requestAnimationFrame(attachFulfillmentCamera);
  if (receiptCameraActive) window.requestAnimationFrame(attachReceiptCamera);
}

function renderLogin(message = "") {
  app.innerHTML = `
    <section class="location-screen">
      <form class="location-panel login-panel" data-form="login">
        <p>${t("app.operator", "MBBS Yard Operator Application")}</p>
        <h1>${t("operator.loginTitle", "Operator login")}</h1>
        ${message ? `<div class="login-message">${message}</div>` : ""}
        <div class="install-hint">
          <strong>${installLabel()}</strong>
          <span>${installPromptEvent
            ? t("operator.installAppHelp", "Tap Install app to open as a standalone tablet app.")
            : t("operator.browserInstallHelp", "If this still opens like a browser, use Chrome or Edge on Android/Windows and install from a trusted HTTPS URL.")}</span>
        </div>
        <label>
          <span>${t("common.username", "Username")}</span>
          <input id="loginUsername" autocomplete="username" required />
        </label>
        <label>
          <span>${t("common.password", "Password")}</span>
          <input id="loginPassword" type="password" autocomplete="current-password" required />
        </label>
        <button class="primary-button" type="submit">${t("common.login", "Login")}</button>
      </form>
    </section>
  `;
}

function saveOperatorState() {
  if (!operator) return;
  const module = restorableModule(currentModule);
  localStorage.setItem(STATE_KEY, JSON.stringify({
    locationId,
    currentModule: module,
    viewMode,
    deliveryOrderType,
    deliveryBatchFilter,
    deliveryPrepMode,
    deliveryLoadViewDate,
    consolidationStage,
    consolidationSearch,
    consolidationSelectedItemKey,
    consolidationReviewOrderId,
    consolidationReviewLineKey,
    consolidationReviewLinePage,
    selectedId,
    selectedLineId,
    orderPage,
    linePage,
    customerPickupScan,
    receivingStep,
    receivingOrderType,
    receivingSelectedVendor,
    receivingSelectedSourceId,
    receivingSelectedId,
    receivingSearch,
    receivingItemSearch,
    receivingOrderPage,
    receivingLinePage,
    receivingSelectedLineId,
    cycleStep,
    cycleSelection,
    cycleSearch,
    selectedInventoryItemId: selectedInventoryItem?.item_id || restoredInventoryItemId || "",
    cyclePage,
    activeCycleUnit,
    personalHistoryDate,
    selectedHistoryId,
    historyPage
  }));
}

async function restoreOperatorView() {
  if (!operator) return renderLogin();
  if (!locationId) return renderLocationSelect();
  currentModule = restorableModule(currentModule);
  try {
    if (currentModule === "delivery") {
      await loadOrders({ keepSelection: true, alertRecent: true });
      return;
    }
    if (currentModule === "delivery-consolidation") {
      await loadConsolidation({ keepItem: true });
      return;
    }
    await Promise.all([
      loadDeliveryNotifications({ alertRecent: true }),
      loadCurrentDeliveryDraft()
    ]);
    if (currentModule === "customer-pickup") {
      if (selectedId) {
        await loadDetail(selectedId, { silentRender: true });
      }
      if (!selectedOrder) currentModule = "customer-pickup-scan";
      render();
      return;
    }
    if (currentModule === "receiving") {
      await loadReceivingOptions();
      if (receivingItemSearch.trim()) await loadReceivingItemSuggestions();
      if (receivingStep === "orders") {
        await loadReceivingOrders({ keepSelection: true });
      } else {
        render();
      }
      return;
    }
    if (currentModule === "cycle-count") {
      await loadCycleData();
      if (restoredInventoryItemId) {
        selectedInventoryItem = inventoryItems.find((item) => String(item.item_id) === String(restoredInventoryItemId)) || null;
        restoredInventoryItemId = "";
      }
      if (selectedInventoryItem && !activeCycleUnit) activeCycleUnit = itemCountUnits(selectedInventoryItem)[0]?.key || "";
      render();
      return;
    }
    if (currentModule === "personal-history") {
      await loadPersonalHistory();
      return;
    }
  } catch (error) {
    showToast(error.message);
  }
  render();
}

function renderLocationSelect() {
  app.innerHTML = `
    <section class="location-screen">
      <div class="location-panel">
        <p>${t("app.operator", "MBBS Yard Operator Application")}</p>
        <h1>${t("operator.selectLocation", "Select working location")}</h1>
        <label>
          <span>${t("common.location", "Location")}</span>
          <select id="locationSelect">${locationOptions()}</select>
        </label>
        <button class="primary-button" data-action="save-location" type="button">${t("common.continue", "Continue")}</button>
      </div>
    </section>
  `;
}

function deliveryScreenTitle() {
  if (deliveryPrepMode === "load") return t("operator.perLoadView", "Per Load View");
  return viewMode === "packed" ? t("operator.packedOrders", "Packed Orders") : t("operator.deliveryPrep", "Delivery Prep");
}

function deliveryScreenSubtitle() {
  const subtype = deliveryPrepMode === "load"
    ? `${formatDate(deliveryLoadViewDate)}${deliveryLoadViewTruck ? ` | ${deliveryLoadViewTruck}` : ""}`
    : deliveryPrepMode === "saved"
      ? t("operator.salesTransferOrders", "Sales Order + Transfer Order")
      : deliveryBatchFilter === "planned"
        ? t("operator.salesTransferOrders", "Sales Order + Transfer Order")
        : deliveryOrderType === "transfer_order" ? t("operator.transferOrder", "Transfer Order") : t("operator.salesOrder", "Sales Order");
  return `${subtype} | ${t("common.location", "Location")} ${currentLocation()?.text || locationId}`;
}

function deliveryScreenActions() {
  const topWarnings = viewMode === "packed" ? warningOrders() : [];
  return `
    ${topWarnings.length ? `<button class="top-warning-button" data-action="open-warning-order" data-order="${topWarnings[0].netsuite_id}" type="button">${t("operator.warning", "Warning")} ${topWarnings.length}</button>` : ""}
    <button class="secondary-button" data-action="main-menu" type="button">${t("common.menu", "Menu")}</button>
    ${renderInstallButton()}
    <button class="secondary-button" data-action="refresh" type="button">${t("common.refreshOrders", "Refresh Orders")}</button>
    <button class="secondary-button" data-action="logout" type="button">${operator.display_name}</button>
  `;
}

function renderDeliveryDetailContent() {
  if (selectedOrder) return renderDetailPanel(selectedOrder);
  if (selectedId) {
    return `<div class="empty-state"><strong>${t("common.loading", "Loading")}</strong><span>${t("operator.loadingOrderDetails", "Loading order details...")}</span></div>`;
  }
  return renderEmptyDetail();
}

function renderDeliveryPanels({ orderPanel = true, detailPanel = true } = {}) {
  const grid = currentModule === "delivery" ? app.querySelector(".delivery-grid") : null;
  if (!grid) return render();

  saveOperatorState();
  const orderPanelElement = grid.querySelector(".order-panel");
  const detailPanelElement = grid.querySelector(".detail-panel");
  const orderListScroll = orderPanelElement?.querySelector(".order-list")?.scrollTop || 0;
  const detailScroll = detailPanelElement?.scrollTop || 0;

  if (orderPanel && orderPanelElement) {
    orderPanelElement.innerHTML = renderOrderPanel();
    const nextOrderList = orderPanelElement.querySelector(".order-list");
    if (nextOrderList) nextOrderList.scrollTop = orderListScroll;
  }
  if (detailPanel && detailPanelElement) {
    detailPanelElement.innerHTML = renderDeliveryDetailContent();
    detailPanelElement.scrollTop = detailScroll;
  }

  const title = app.querySelector(".topbar-title h1");
  const subtitle = app.querySelector(".topbar-title span");
  const actions = app.querySelector(".topbar-actions");
  if (title) title.textContent = deliveryScreenTitle();
  if (subtitle) subtitle.textContent = deliveryScreenSubtitle();
  if (actions) actions.innerHTML = `${renderReleaseDraftButton()}${renderNotificationButton()}${deliveryScreenActions()}`;
}

function render() {
  if (!operator) return renderLogin();
  if (!locationId) return renderLocationSelect();
  saveOperatorState();
  if (currentModule === "menu") return renderMenu();
  if (currentModule === "cycle-count") return renderCycleCount();
  if (currentModule === "customer-pickup-scan") return renderCustomerPickupScan();
  if (currentModule === "customer-pickup") return renderCustomerPickupOrder();
  if (currentModule === "delivery-select") return renderDeliverySelect();
  if (currentModule === "delivery-consolidation") return renderConsolidationPick();
  if (currentModule === "receiving") return renderReceiving();
  if (currentModule === "receiving-receipt") return renderReceiptScreen();
  if (currentModule === "return-select") return renderReturnSelect();
  if (currentModule === "personal-history") return renderPersonalHistory();
  if (currentModule === "delivery-fulfill") return renderFulfillmentScreen();
  if (currentModule === "customer-pickup-load") return renderFulfillmentScreen();

  shell(deliveryScreenTitle(), deliveryScreenSubtitle(), `
    <section class="delivery-grid">
      <aside class="order-panel">
        ${renderOrderPanel()}
      </aside>
      <section class="detail-panel">
        ${renderDeliveryDetailContent()}
      </section>
    </section>
  `, deliveryScreenActions());
}

function renderMenu() {
  shell(t("operator.menuTitle", "Operator Menu"), `${t("common.location", "Location")} ${currentLocation()?.text || locationId}`, `
    <section class="module-menu">
      <button class="module-tile" data-action="open-module" data-module="customer-pickup" type="button">
        <strong>${t("operator.customerPickup", "Customer Pickup")}</strong>
        <span>${t("operator.customerPickupDesc", "Prepare order for customer pickup.")}</span>
      </button>
      <button class="module-tile" data-action="open-module" data-module="receiving" type="button">
        <strong>${t("operator.receiving", "Receiving")}</strong>
        <span>${t("operator.receivingDesc", "Receive PO and yard stock.")}</span>
      </button>
      <button class="module-tile" data-action="open-module" data-module="cycle-count" type="button">
        <strong>${t("operator.cycleCount", "Cycle Count")}</strong>
        <span>${t("operator.cycleCountDesc", "Check inventory by product, brand, series and SKU.")}</span>
      </button>
      <button class="module-tile" data-action="open-module" data-module="delivery" type="button">
        <strong>${t("operator.deliveryPrep", "Delivery Prep")}</strong>
        <span>${t("operator.deliveryPrepDesc", "Pack delivery orders for drivers.")}</span>
      </button>
      <button class="module-tile" data-action="open-module" data-module="return" type="button">
        <strong>${t("operator.return", "Return")}</strong>
        <span>${t("operator.returnDesc", "Pallet return or stock return.")}</span>
      </button>
      <button class="module-tile" data-action="open-module" data-module="personal-history" type="button">
        <strong>${t("operator.personalHistory", "Personal History")}</strong>
        <span>${t("operator.personalHistoryDesc", "Review your submitted IF, IR and count records.")}</span>
      </button>
    </section>
  `, `
    ${renderInstallButton()}
    <button class="secondary-button" data-action="logout" type="button">${operator.display_name}</button>
  `);
}

function renderReturnSelect() {
  shell(t("operator.return", "Return"), `${t("common.location", "Location")} ${currentLocation()?.text || locationId}`, `
    <section class="module-menu two-up">
      <button class="module-tile" data-action="open-module" data-module="pallet-return" type="button">
        <strong>${t("operator.palletReturn", "Pallet Return")}</strong>
        <span>${t("operator.palletReturnDesc", "Record returned pallets from customer.")}</span>
      </button>
      <button class="module-tile" data-action="open-module" data-module="stock-return" type="button">
        <strong>${t("operator.stockReturn", "Stock Return")}</strong>
        <span>${t("operator.stockReturnDesc", "Return stock by sales order.")}</span>
      </button>
    </section>
  `, `
    <button class="secondary-button" data-action="main-menu" type="button">${t("common.menu", "Menu")}</button>
    <button class="secondary-button" data-action="logout" type="button">${operator.display_name}</button>
  `);
}

function renderDeliverySelect() {
  shell(t("operator.deliveryPrep", "Delivery Prep"), `${t("common.location", "Location")} ${currentLocation()?.text || locationId}`, `
    <section class="module-menu two-up">
      <button class="module-tile" data-action="select-delivery-type" data-order-type="sales_order" type="button">
        <strong>${t("operator.batchView", "Batch")}</strong>
        <span>${t("operator.batchViewDesc", "Planned, Batch A, Batch B and TO in one panel.")}</span>
      </button>
      <button class="module-tile" data-action="select-delivery-pool" data-mode="saved" type="button">
        <strong>${t("operator.savedOrders", "Saved Orders")}</strong>
        <span>${t("operator.savedOrdersDesc", "Pick saved SO and TO in one pool.")}</span>
      </button>
      <button class="module-tile" data-action="select-delivery-pool" data-mode="load" type="button">
        <strong>${t("operator.perLoadView", "Per Load View")}</strong>
        <span>${t("operator.perLoadViewDesc", "Choose date and truck, then prepare by load sequence.")}</span>
      </button>
      <button class="module-tile" data-action="open-consolidation" type="button">
        <strong>${t("operator.consolidationPick", "Consolidation Pick")}</strong>
        <span>${t("operator.consolidationPickDesc", "Pick starred Sales Orders together across loads and dates.")}</span>
      </button>
    </section>
  `, `
    <button class="secondary-button" data-action="main-menu" type="button">${t("common.menu", "Menu")}</button>
    <button class="secondary-button" data-action="logout" type="button">${operator.display_name}</button>
  `);
}

function renderCustomerPickupScan() {
  shell(t("operator.customerPickup", "Customer Pickup"), `${t("common.location", "Location")} ${currentLocation()?.text || locationId}`, `
    <section class="fulfillment-screen">
      <div class="fulfillment-card customer-pickup-scan-card">
        <span>${t("operator.scanSalesOrder", "Scan sales order")}</span>
        <strong>${t("operator.customerPickupOnly", "Customer pickup only")}</strong>
        <div class="scanner-ready-banner">
          <b>${t("operator.scannerReady", "Scanner ready")}</b>
          <span>${t("operator.scannerReadyHelp", "Scan a 1D or QR sales-order barcode with the camera or Zebra scanner. The order will open automatically.")}</span>
        </div>
        <div class="camera-actions">
          <button class="primary-button" data-action="start-pickup-scanner" type="button">${pickupScannerActive ? t("common.restartCamera", "Restart camera") : t("common.openCamera", "Open camera")}</button>
          ${renderCameraSwitchButton("switch-pickup-camera")}
        </div>
        ${pickupScannerActive ? `
          <div class="barcode-scanner-viewport${cameraFacingMode === "user" ? " mirrored" : ""}" id="pickupScannerCamera">
            <div class="barcode-scan-guide" aria-hidden="true"><span></span></div>
          </div>
        ` : `<div class="photo-placeholder">${t("operator.scannerHelp", "Use the camera for 1D/QR barcodes, the Zebra scanner, or type the sales order number.")}</div>`}
      </div>
      <div class="fulfillment-card">
        <span>${t("operator.manualInput", "Manual / Zebra input")}</span>
        <strong>${t("operator.orderNumber", "Order number")}</strong>
        <label class="stepper-field">
          <span>${t("operator.scanOrType", "Scan or type and press Enter")}</span>
          <input id="customerPickupScan" value="${escapeHtml(customerPickupScan)}" placeholder="SOB104325" autocomplete="off" autofocus />
        </label>
        ${customerPickupMessage ? `<div class="sync-alert danger"><strong>${t("common.notice", "Notice")}</strong><span>${escapeHtml(localizeMessage(customerPickupMessage))}</span></div>` : ""}
        <div class="selected-actions">
          <button class="primary-button" data-action="lookup-customer-pickup" type="button">${t("operator.findOrder", "Find Order")}</button>
        </div>
      </div>
    </section>
  `, `
    <button class="secondary-button" data-action="main-menu" type="button">${t("common.menu", "Menu")}</button>
    <button class="secondary-button" data-action="logout" type="button">${operator.display_name}</button>
  `);
  window.requestAnimationFrame(() => {
    scheduleCustomerPickupFocus();
  });
}

function renderCustomerPickupOrder() {
  shell(t("operator.customerPickup", "Customer Pickup"), selectedOrder ? `${selectedOrder.tranid} | ${selectedOrder.customer || ""}` : `${t("common.location", "Location")} ${currentLocation()?.text || locationId}`, `
    <section class="delivery-grid single-detail">
      <section class="detail-panel">
        ${selectedOrder ? renderDetailPanel(selectedOrder) : renderEmptyDetail()}
      </section>
    </section>
  `, `
    <button class="secondary-button" data-action="customer-pickup-back" type="button">${t("operator.backToScan", "Back to Scan")}</button>
    <button class="secondary-button" data-action="main-menu" type="button">${t("common.menu", "Menu")}</button>
    <button class="secondary-button" data-action="logout" type="button">${operator.display_name}</button>
  `);
}

function receivingTypeLabel() {
  if (receivingOrderType === "co_order") return t("operator.transitCo", "Transit CO");
  return receivingOrderType === "transfer_order" ? t("operator.transferOrder", "Transfer Order") : t("operator.purchaseOrder", "Purchase Order");
}

function renderReceiving() {
  shell(t("operator.receiving", "Receiving"), `${receivingTypeLabel()} | ${t("common.location", "Location")} ${currentLocation()?.text || locationId}`, `
    <section class="receiving-shell">
      <div class="receiving-toolbar">
        <button class="secondary-button" data-action="main-menu" type="button">${t("common.menu", "Menu")}</button>
        <button class="secondary-button" data-action="receiving-back" type="button">${t("common.back", "Back")}</button>
        <label class="receiving-search">
          <span>${t("operator.searchOrderNumber", "Search PO / TO number")}</span>
          <input id="receivingSearch" value="${receivingSearch}" placeholder="${t("operator.scanOrType", "Scan or type and press Enter")}" />
        </label>
        <label class="receiving-search receiving-search-with-dropdown">
          <span>${t("operator.searchProduct", "Search product")}</span>
          <input id="receivingItemSearch" value="${receivingItemSearch}" placeholder="${t("operator.searchProduct", "Search product")}" />
          ${receivingItemSuggestions.length ? `
            <div class="autocomplete-dropdown">
              ${receivingItemSuggestions.map((item) => `
                <button data-action="receiving-pick-item" data-item="${item.item_name}" type="button">
                  <strong>${item.item_name}</strong>
                  <span>${item.order_count} PO/TO</span>
                </button>
              `).join("")}
            </div>
          ` : ""}
        </label>
        <button class="secondary-button" data-action="refresh-receiving" type="button">${t("common.refreshOrders", "Refresh Orders")}</button>
      </div>
      ${renderReceivingMain()}
    </section>
  `, `
    <button class="secondary-button" data-action="logout" type="button">${operator.display_name}</button>
  `);
}

function renderReceivingMain() {
  if (receivingStep === "type") {
    return `
      <section class="module-menu two-up compact-menu">
      <button class="module-tile" data-action="select-receiving-type" data-order-type="purchase_order" type="button">
        <strong>${t("operator.purchaseOrder", "Purchase Order")}</strong>
        <span>${t("operator.purchaseOrderDesc", "Receive vendor purchase orders.")}</span>
      </button>
      <button class="module-tile" data-action="select-receiving-type" data-order-type="transfer_order" type="button">
        <strong>${t("operator.transferOrder", "Transfer Order")}</strong>
        <span>${t("operator.transferOrderReceiveDesc", "Receive stock sent from another yard.")}</span>
      </button>
      <button class="module-tile" data-action="select-receiving-type" data-order-type="co_order" type="button">
        <strong>${t("operator.transitCo", "Transit CO")}</strong>
        <span>${t("operator.transitCoDesc", "Receive local transit depot stock.")}</span>
        </button>
      </section>
    `;
  }
  if (receivingStep === "vendor") {
    const list = (receivingOrderType === "transfer_order" || receivingOrderType === "co_order")
      ? receivingSources.filter((item) => String(item.source_location_id) !== String(locationId))
      : receivingVendors;
    return `
      <section class="receiving-option-grid">
        ${list.map((item) => `
          <button class="module-tile compact" data-action="${receivingOrderType === "purchase_order" ? "select-receiving-vendor" : "select-receiving-source"}" data-value="${receivingOrderType === "purchase_order" ? item.vendor : item.source_location_id}" type="button">
            <strong>${receivingOrderType === "purchase_order" ? item.vendor : tf("operator.fromLocation", "From {location}", { location: item.source_location })}</strong>
            <span>${tf("operator.openOrdersCount", "{count} open order(s)", { count: item.order_count })}</span>
          </button>
        `).join("") || `<div class="empty-state"><strong>${t("operator.noOpenOrders", "No open orders")}</strong><span>${t("operator.noOpenOrdersHelp", "Ask admin to sync if the order is missing.")}</span></div>`}
      </section>
    `;
  }
  return renderReceivingOrders();
}

function renderReceivingOrders() {
  const count = pageCount(receivingOrders, ORDER_PAGE_SIZE);
  receivingOrderPage = Math.min(receivingOrderPage, count - 1);
  const visible = pageItems(receivingOrders, receivingOrderPage, ORDER_PAGE_SIZE);
  return `
    <section class="receiving-grid">
      <aside class="order-panel">
        <div class="panel-title">
          <div>
            <span>${receivingSearch.trim() || receivingItemSearch.trim()
              ? t("operator.ordersLabel", "Orders")
              : receivingOrderType === "purchase_order" ? t("operator.vendor", "Vendor") : t("operator.source", "Source")}</span>
            <strong>${receivingSearch.trim() || receivingItemSearch.trim()
              ? t("operator.searchResults", "Search results")
              : receivingOrderType === "purchase_order"
                ? receivingSelectedVendor
                : tf("operator.fromLocation", "From {location}", { location: sourceLocationText(receivingSelectedSourceId) })}</strong>
          </div>
          <strong>${receivingOrders.length}</strong>
        </div>
        <div class="number-pad compact-pad">
          ${["1","2","3","4","5","6","7","8","9","Clear","0","Back"].map((key) => `
            <button data-action="receiving-key" data-key="${key}" type="button">${key === "Clear" ? t("common.clear", "Clear") : key === "Back" ? t("common.backspace", "Back") : key}</button>
          `).join("")}
        </div>
        <div class="order-list">
          ${visible.map((order) => `
            <button class="order-card ${String(order.netsuite_id) === String(receivingSelectedId) ? "active" : ""}" data-receiving-order="${order.netsuite_id}" type="button">
              <strong>${order.tranid}</strong>
              <span class="muted">${order.order_type === "co_order" ? "CO" : order.order_type === "transfer_order" ? "TO" : "PO"} | ${formatDate(order.trandate)} | ${tf("operator.lineCount", "{count} line(s)", { count: order.line_count || 0 })}</span>
              <span class="status-pill open">${escapeHtml(localizeMessage(order.status_text || t("operator.pendingReceipt", "Pending Receipt")))}</span>
            </button>
          `).join("") || `<div class="empty-state small"><strong>${t("operator.noOrderFound", "No order found")}</strong><span>${t("operator.noOrderFoundHelp", "Try another number or product.")}</span></div>`}
        </div>
        <div class="pagination-row">
          <button class="secondary-button" data-action="receiving-order-prev" ${receivingOrderPage === 0 ? "disabled" : ""} type="button">${t("common.previous", "Previous")}</button>
          <strong>${receivingOrderPage + 1} / ${count}</strong>
          <button class="secondary-button" data-action="receiving-order-next" ${receivingOrderPage >= count - 1 ? "disabled" : ""} type="button">${t("common.next", "Next")}</button>
        </div>
      </aside>
      <section class="detail-panel">
        ${receivingSelectedOrder ? renderReceivingDetail(receivingSelectedOrder) : `<div class="empty-state"><strong>${t("operator.selectOrder", "Select order")}</strong><span>${t("operator.selectOrderHelp", "Tap an open receiving order.")}</span></div>`}
      </section>
    </section>
  `;
}

function sourceLocationText(id) {
  return LOCATIONS.find((location) => String(location.id) === String(id))?.text || "";
}

function renderReceivingDetail(order) {
  const orderType = order.order_type || receivingOrderType;
  const lines = (order.lines || []).filter((line) => isPickableLine(line) && hasReceivingRemainingQty(line));
  if (!receivingSelectedLineId || !lines.some((line) => String(line.id) === String(receivingSelectedLineId))) {
    receivingSelectedLineId = lines[0]?.id || null;
  }
  const selectedLine = lines.find((line) => String(line.id) === String(receivingSelectedLineId));
  const linePageSize = activeLinePageSize();
  const count = pageCount(lines, linePageSize);
  receivingLinePage = Math.min(receivingLinePage, count - 1);
  const visible = pageItems(lines, receivingLinePage, linePageSize);
  const confirmedLines = lines.filter((line) => hasReceivedQty(line) && hasReceivingRemainingQty(line));
  return `
    <div class="detail-header">
      <div>
        <h2>${order.tranid}</h2>
        <p class="muted">${orderType === "purchase_order" ? order.vendor : tf("operator.fromTo", "From {from} to {to}", { from: order.source_location, to: order.destination_location })}</p>
        <p class="muted">${formatDate(order.trandate)} | ${escapeHtml(localizeMessage(order.status_text || ""))}</p>
      </div>
      <div class="status-actions">
        ${renderLineDensityToggle()}
        <button class="primary-button" data-action="start-receive" ${confirmedLines.length ? "" : "disabled"} type="button">${t("operator.receive", "Receive")}</button>
      </div>
    </div>
    <div class="receiving-detail-grid">
      <div class="line-column receiving-lines">
        <div class="line-list ${compactLineMode ? "compact-line-list" : ""}">
          ${visible.map((line) => renderReceivingLine(line)).join("") || `<div class="empty-state small"><strong>${t("operator.noItemLine", "No item line")}</strong><span>${t("operator.noItemLineHelp", "This order has no receivable item line.")}</span></div>`}
        </div>
        <div class="pagination-row">
          <button class="secondary-button" data-action="receiving-line-prev" ${receivingLinePage === 0 ? "disabled" : ""} type="button">${t("common.previous", "Previous")}</button>
          <strong>${receivingLinePage + 1} / ${count}</strong>
          <button class="secondary-button" data-action="receiving-line-next" ${receivingLinePage >= count - 1 ? "disabled" : ""} type="button">${t("common.next", "Next")}</button>
        </div>
      </div>
      ${selectedLine ? renderReceivingSelectedLinePanel(selectedLine) : `<aside class="selected-panel"><div class="empty-state small"><strong>${t("operator.selectLine", "Select line")}</strong></div></aside>`}
    </div>
  `;
}

function renderReceivingLine(line) {
  const units = receivingLineUnits(line);
  return `
    <button class="line-card ${String(receivingSelectedLineId) === String(line.id) ? "active" : ""} ${hasReceivedQty(line) ? "confirmed" : ""}" data-action="select-receiving-line" data-line="${line.id}" type="button">
      <div class="line-info">
        <strong>${line.sku || line.item_name}</strong>
        ${compactLineMode ? "" : `<span>${line.item_description || ""}</span>`}
        ${hasReceivedQty(line) ? `<em class="underpack-note">${t("operator.confirmed", "Confirmed")}</em>` : ""}
      </div>
      <div class="required-measures">
        ${units.map((unit) => `
          <div class="measure">
            <span>${t("operator.open", "Open")} ${unit.label}</span>
            <b>${displayQty(receivingRemainingValue(line, unit.key))}</b>
          </div>
          <div class="measure ${receivingConfirmedValue(line, unit.key) > 0 ? "confirmed-measure" : ""}">
            <span>${t("operator.confirmed", "Confirmed")} ${unit.label}</span>
            <b>${displayQty(receivingConfirmedValue(line, unit.key))}</b>
          </div>
        `).join("")}
      </div>
    </button>
  `;
}

function hasReceivedQty(line) {
  return qty(line.received_pallet_qty) > 0
    || qty(line.received_section_qty) > 0
    || qty(line.received_layer_qty) > 0
    || qty(line.received_piece_qty) > 0
    || qty(line.received_sales_qty) > 0;
}

function receivingPanelValue(line, unit) {
  if (unit === "pallets") return qty(line.received_pallet_qty) || receivingRemainingValue(line, "pallets");
  if (unit === "sections") return qty(line.received_section_qty) || receivingRemainingValue(line, "sections");
  if (unit === "layers") return qty(line.received_layer_qty) || receivingRemainingValue(line, "layers");
  if (unit === "pieces") return qty(line.received_piece_qty) || receivingRemainingValue(line, "pieces");
  if (unit === "sales") return qty(line.received_sales_qty) || receivingRemainingValue(line, "sales");
  return 0;
}

function receivingConfirmedValue(line, unit) {
  if (unit === "pallets") return qty(line.received_pallet_qty);
  if (unit === "sections") return qty(line.received_section_qty);
  if (unit === "layers") return qty(line.received_layer_qty);
  if (unit === "pieces") return qty(line.received_piece_qty);
  if (unit === "sales") return qty(line.received_sales_qty);
  return 0;
}

function renderReceivingSelectedLinePanel(line) {
  const units = receivingLineUnits(line);
  return `
    <aside class="selected-panel" data-receiving-selected-line="${line.id}">
      <div class="selected-header">
        <span>${t("operator.selectedItem", "Selected item")}</span>
        <strong>${line.sku || line.item_name}</strong>
        <p>${line.item_description || ""}</p>
      </div>
      <div class="selected-measures">
        ${units.map((unit) => `
          <div class="measure">
            <span>${t("operator.open", "Open")} ${unit.label}</span>
            <b>${displayQty(receivingRemainingValue(line, unit.key))}</b>
          </div>
          <div class="measure ${receivingConfirmedValue(line, unit.key) > 0 ? "confirmed-measure" : ""}">
            <span>${t("operator.confirmed", "Confirmed")} ${unit.label}</span>
            <b>${displayQty(receivingConfirmedValue(line, unit.key))}</b>
          </div>
        `).join("")}
      </div>
      ${units.map((unit) => renderStepper(unit.key, tf("operator.receiveUnit", "Receive {unit}", { unit: unit.label }), receivingPanelValue(line, unit.key))).join("")}
      <div class="selected-actions">
        ${hasReceivedQty(line) ? `<button class="secondary-button danger-button" data-action="unconfirm-receiving-line" data-line="${line.id}" type="button">${t("operator.unconfirmLine", "Unconfirm line")}</button>` : ""}
        <button class="primary-button" data-action="confirm-receiving-line" data-line="${line.id}" type="button">${t("operator.confirmLine", "Confirm line")}</button>
      </div>
    </aside>
  `;
}

function cycleStepTitle() {
  if (cycleSearch.trim()) return t("operator.searchResults", "Search Results");
  if (cycleStep === "type") return t("operator.selectProductType", "Select Product Type");
  if (cycleStep === "brand") return t("operator.selectBrand", "Select Brand");
  if (cycleStep === "series") return t("operator.selectSeries", "Select Series");
  return t("operator.selectSku", "Select SKU");
}

function renderCycleCount() {
  shell(t("operator.cycleCount", "Cycle Count"), `${t("common.location", "Location")} ${currentLocation()?.text || locationId}`, `
    <section class="cycle-shell">
      <div class="cycle-toolbar">
        <button class="secondary-button" data-action="main-menu" type="button">${t("common.menu", "Menu")}</button>
        <button class="secondary-button" data-action="cycle-back" type="button">${t("common.back", "Back")}</button>
        <label class="cycle-search">
          <span>${t("operator.searchSku", "Search SKU")}</span>
          <input id="cycleSearch" value="${cycleSearch}" placeholder="${t("operator.searchSku", "Search SKU")}" />
        </label>
      </div>
      <div class="cycle-crumbs">
        <span>${cycleSelection.productType || t("common.type", "Type")}</span>
        <span>${cycleSelection.brand || t("control.brand", "Brand")}</span>
        <span>${cycleSelection.series || t("control.series", "Series")}</span>
      </div>
      <div class="cycle-grid">
        <section class="cycle-list-panel">
          <div class="panel-title">
            <span>${cycleStepTitle()}</span>
            <strong>${cycleSearch.trim() || cycleStep === "sku" ? inventoryItems.length : currentCycleOptions().length}</strong>
          </div>
          ${renderCycleMain()}
        </section>
        <aside class="selected-panel">
          ${selectedInventoryItem ? renderCycleCountPanel(selectedInventoryItem) : renderCycleSummary()}
        </aside>
      </div>
    </section>
  `, `
    <button class="secondary-button" data-action="logout" type="button">${operator.display_name}</button>
  `);
}

function focusCycleSearch() {
  const input = document.getElementById("cycleSearch");
  if (!input) return;
  input.focus();
  const end = input.value.length;
  input.setSelectionRange(end, end);
}

function focusReceivingInput(id) {
  const input = document.getElementById(id);
  if (!input) return;
  input.focus();
  const end = input.value.length;
  input.setSelectionRange(end, end);
}

function currentCycleOptions() {
  if (cycleStep === "type") return cycleFacets.productTypes || [];
  if (cycleStep === "brand") return cycleFacets.brands || [];
  if (cycleStep === "series") return cycleFacets.series || [];
  return [];
}

function renderCycleMain() {
  if (cycleSearch.trim() || cycleStep === "sku") return renderInventorySkuList();
  const options = currentCycleOptions();
  return `
    <div class="cycle-option-grid">
      ${options.map((option) => `
        <button class="module-tile compact" data-action="cycle-select" data-value="${option.value}" type="button">
          <strong>${option.value || t("operator.unassigned", "Unassigned")}</strong>
          <span>${option.count} SKU</span>
        </button>
      `).join("") || `<div class="empty-state small"><strong>${t("operator.noOptions", "No options")}</strong><span>${t("operator.syncInventoryFirst", "Sync inventory first.")}</span></div>`}
    </div>
  `;
}

function renderInventorySkuList() {
  const count = pageCount(inventoryItems, LINE_PAGE_SIZE);
  cyclePage = Math.min(cyclePage, count - 1);
  const visible = pageItems(inventoryItems, cyclePage, LINE_PAGE_SIZE);
  return `
    <div class="line-list inventory-list">
      ${visible.map((item) => `
        <button class="line-card inventory-card ${selectedInventoryItem?.item_id === item.item_id ? "active" : ""}" data-action="select-inventory-item" data-item="${item.item_id}" type="button">
          <div class="line-info">
            <strong>${item.item_name}</strong>
            <span>${item.item_description || item.display_name || ""}</span>
            <em class="underpack-note">${item.product_type || ""} | ${item.brand || ""} | ${item.series || ""}</em>
          </div>
          <div class="required-measures">
            <div class="measure"><span>${t("operator.uom", "UOM")}</span><b>${item.stock_unit || "-"}</b></div>
            <div class="measure"><span>${t("operator.count", "Count")}</span><b>${t("operator.blind", "Blind")}</b></div>
          </div>
        </button>
      `).join("") || `<div class="empty-state small"><strong>${t("operator.noSku", "No SKU")}</strong><span>${t("operator.trySearchInventory", "Try search or sync inventory.")}</span></div>`}
    </div>
    <div class="pagination-row">
      <button class="secondary-button" data-action="cycle-prev" ${cyclePage === 0 ? "disabled" : ""} type="button">${t("common.previous", "Previous")}</button>
      <strong>${cyclePage + 1} / ${count}</strong>
      <button class="secondary-button" data-action="cycle-next" ${cyclePage >= count - 1 ? "disabled" : ""} type="button">${t("common.next", "Next")}</button>
    </div>
  `;
}

function renderCycleCountPanel(item) {
  const countUnits = itemCountUnits(item);
  if (!countUnits.some((unit) => unit.key === activeCycleUnit)) activeCycleUnit = countUnits[0]?.key || "";
  return `
    <div class="selected-header cycle-selected-header">
      <span>${t("operator.selectedSku", "Selected SKU")}</span>
      <strong>${item.item_name}</strong>
      <p>${item.item_description || item.display_name || ""}</p>
    </div>
    <div class="selected-measures cycle-conversion-measures">
      ${countUnits.map((unit) => `<div class="measure"><span>1 ${unit.label}</span><b>${displayQty(unit.conversion)}</b></div>`).join("")}
    </div>
    <div class="cycle-count-fields">
      ${countUnits.map((unit) => `
        <button class="cycle-count-field ${activeCycleUnit === unit.key ? "active" : ""}" data-action="select-cycle-unit" data-unit="${unit.key}" type="button">
          <span>${t("operator.counted", "Counted")} ${unit.label}</span>
          <strong data-cycle-display="${unit.key}">${cycleValues[unit.key] || 0}</strong>
        </button>
      `).join("")}
    </div>
    <div class="cycle-number-pad">
      ${["1", "2", "3", "4", "5", "6", "7", "8", "9", "Clear", "0", "Back"].map((key) => `
        <button data-action="cycle-key" data-key="${key}" type="button">${key === "Clear" ? t("common.clear", "Clear") : key === "Back" ? t("common.backspace", "Back") : key}</button>
      `).join("")}
    </div>
    <div class="cycle-variance" data-cycle-variance>
      <div><span>${t("operator.countedTotal", "Counted total")}</span><strong>0</strong></div>
      <div><span>${t("operator.mode", "Mode")}</span><strong>${t("operator.blind", "Blind")}</strong></div>
    </div>
    <div class="selected-actions">
      <button class="primary-button" data-action="confirm-cycle-line" ${cycleConfirming ? "disabled" : ""} type="button">${cycleConfirming ? t("operator.confirming", "Confirming...") : t("operator.confirmLine", "Confirm line")}</button>
    </div>
  `;
}

function renderCycleSummary() {
  const lines = cycleDraft?.lines || [];
  return `
    <div class="selected-header">
      <span>${t("operator.currentCount", "Current count")}</span>
      <strong>${lines.length} ${t("operator.confirmedLine", "confirmed line")}</strong>
      <p>${t("operator.confirmedDraftHelp", "Confirmed lines stay in this draft until Submit.")}</p>
    </div>
    <div class="cycle-summary">
      ${lines.slice(0, 6).map((line) => `
        <button class="${selectedInventoryItem?.item_id === line.item_id ? "active" : ""}" data-action="edit-cycle-line" data-line="${line.id}" type="button">
          <strong>${line.item_name}</strong>
          <span>${displayQty(line.counted_pallet_qty)} PLT / ${displayQty(line.counted_layer_qty)} LYR / ${displayQty(line.counted_section_qty)} SEC / ${displayQty(line.counted_piece_qty)} PCS</span>
          <span>${t("operator.total", "Total")} ${displayQty(line.counted_total_qty)} | ${t("control.variance", "Var")} ${displaySignedQty(line.variance_qty)}</span>
        </button>
      `).join("") || `<span class="muted">${t("operator.noLinesConfirmed", "No lines confirmed yet.")}</span>`}
    </div>
    <div class="selected-actions">
      <button class="primary-button" data-action="submit-cycle-count" ${lines.length ? "" : "disabled"} type="button">${t("operator.submit", "Submit")}</button>
    </div>
  `;
}

function deliveryPoolTitle() {
  if (deliveryPrepMode === "saved") return t("operator.savedOrders", "Saved Orders");
  if (deliveryPrepMode === "load") return t("operator.perLoadView", "Per Load View");
  return viewMode === "packed" ? t("operator.packed", "Packed") : t("operator.notPacked", "Not packed");
}

function renderDeliveryPrepModeControls() {
  if (deliveryPrepMode === "load") return "";
  return `
    <div class="delivery-mode-segment">
      <button class="${deliveryPrepMode === "standard" ? "active" : ""}" data-action="delivery-prep-mode" data-mode="standard" type="button">${t("operator.batchView", "Batch")}</button>
      <button class="${deliveryPrepMode === "saved" ? "active" : ""}" data-action="delivery-prep-mode" data-mode="saved" type="button">${t("operator.savedOrders", "Saved Orders")}</button>
    </div>
  `;
}

function renderDeliveryLoadControls() {
  if (deliveryPrepMode !== "load") return "";
  return `
    <div class="load-view-controls compact">
      <label class="load-date-field">
        <input data-input="delivery-load-date" type="date" value="${escapeHtml(deliveryLoadViewDate || "")}" />
      </label>
      <label class="load-truck-field">
        <select data-input="delivery-load-truck">
          <option value="">${t("operator.allTrucks", "All trucks")}</option>
          ${(deliveryLoadTrucks || []).map((truck) => `
            <option value="${escapeHtml(truck.truck_plate)}" ${String(truck.truck_plate) === String(deliveryLoadViewTruck) ? "selected" : ""}>
              ${escapeHtml(truck.truck_plate)} (${truck.load_count || 0})
            </option>
          `).join("")}
        </select>
      </label>
      <button class="secondary-button compact-action" data-action="apply-delivery-load-view" type="button">${t("common.apply", "Apply")}</button>
    </div>
  `;
}

function renderSavedOrderAction(order) {
  return "";
}

function isOrderSaved(order) {
  return savedDeliveryOrderKeys.has(String(order?.netsuite_id || ""));
}

function renderOrderSaveStar(order) {
  if (isVrmaOrder(order)) return "";
  if (!order || viewMode === "packed") return "";
  const saved = isOrderSaved(order);
  return `
    <button class="save-star-button ${saved ? "saved" : ""}" data-action="toggle-saved-order" data-order="${escapeHtml(order.netsuite_id)}" type="button" title="${saved ? t("operator.unsaveOrder", "Unsave order") : t("operator.saveOrder", "Save order")}">
      <span aria-hidden="true">&#9733;</span>
    </button>
  `;
}

function renderOrderPanel() {
  const panelOrders = filteredDeliveryOrders();
  const count = pageCount(panelOrders, DELIVERY_ORDER_PAGE_SIZE);
  orderPage = Math.min(orderPage, count - 1);
  const visible = pageItems(panelOrders, orderPage, DELIVERY_ORDER_PAGE_SIZE);
  const counts = deliveryBatchCounts();
  const showBatchFilter = deliveryPrepMode === "standard" && viewMode === "active";
  const showActivePacked = deliveryPrepMode === "standard" || deliveryPrepMode === "load";

  return `
    <div class="panel-title">
      <div class="order-panel-title">
        ${showActivePacked ? `
          <div class="panel-segment">
            <button class="${viewMode === "active" ? "active" : ""}" data-action="view-active" type="button">${t("operator.active", "Active")}</button>
            <button class="${viewMode === "packed" ? "active" : ""}" data-action="view-packed" type="button">${t("operator.packed", "Packed")}</button>
          </div>
        ` : ""}
      </div>
      <div class="order-panel-heading-actions">
        ${deliveryPrepMode === "saved" ? `
          <button class="secondary-button compact-action consolidation-jump-button" data-action="open-consolidation" type="button">
            ${t("operator.consolidationPick", "Consolidation Pick")}
          </button>
        ` : ""}
        <strong>${panelOrders.length}</strong>
      </div>
    </div>
    ${renderDeliveryLoadControls()}
    ${renderDeliveryPrepModeControls()}
    ${showBatchFilter ? `
      <div class="batch-segment">
        <button class="${deliveryBatchFilter === "planned" ? "active" : ""}" data-action="delivery-batch-filter" data-filter="planned" type="button">${t("operator.planned", "Planned")} <b>${counts.planned}</b></button>
        <button class="${deliveryBatchFilter === "batch_a" ? "active" : ""}" data-action="delivery-batch-filter" data-filter="batch_a" type="button">${t("operator.batchA", "Batch A")} <b>${counts.batch_a}</b></button>
        <button class="${deliveryBatchFilter === "batch_b" ? "active" : ""}" data-action="delivery-batch-filter" data-filter="batch_b" type="button">${t("operator.batchB", "Batch B")} <b>${counts.batch_b}</b></button>
        <button class="${deliveryBatchFilter === "transfer" ? "active" : ""}" data-action="delivery-batch-filter" data-filter="transfer" type="button">${t("operator.transferShort", "TO")} <b>${counts.transfer}</b></button>
      </div>
    ` : ""}
    ${renderPackedWarningNotice()}
    ${renderOperatorRequestNotice()}
    <div class="order-list">
      ${visible.map((order) => {
        const request = operatorRequestForOrder(order);
        return `
        <div class="order-card-wrap">
          <button class="order-card ${String(order.netsuite_id) === String(selectedId) ? "active" : ""} ${orderWarningCount(order) ? "warning" : ""} ${orderUnderpackCount(order) && order.operator_status === "packed" ? "underpack" : ""} ${request ? "request" : ""}" data-order="${order.netsuite_id}" type="button">
            <strong>${order.tranid}${order.testFixture ? ` <span class="status-pill test-fixture">TEST</span>` : ""}</strong>
            <span class="muted order-schedule-line">${shouldShowDeliverySchedule() ? deliveryScheduleText(order) : formatDate(order.trandate)} | ${order.outbound_location || ""}</span>
            ${order.dispatch_planned || order.load_view ? `<span class="planned-line">${plannedOrderText(order)}</span>` : ""}
            ${isOrderSaved(order) ? `<span class="saved-line">${t("operator.savedOrder", "Saved order")}</span>` : ""}
            ${request ? `<span class="request-line">${t("operator.dispatchUnpackRequest", "Dispatch asks to unpack for split")}</span>` : ""}
            <span class="status-pill ${orderStatusClass(order)}">${orderStatusText(order)}</span>
          </button>
          ${renderOrderSaveStar(order)}
        </div>
      `; }).join("") || `<div class="empty-state small"><strong>${t("operator.noOrders", "No orders")}</strong><span>${showBatchFilter ? t("operator.tryBatch", "Try another batch filter.") : t("operator.noOpenOrdersHelp", "Ask admin to sync if the order is missing.")}</span></div>`}
    </div>
    <div class="pagination-row">
      <button class="secondary-button" data-action="order-prev" ${orderPage === 0 ? "disabled" : ""} type="button">${t("common.previous", "Previous")}</button>
      <strong>${orderPage + 1} / ${count}</strong>
      <button class="secondary-button" data-action="order-next" ${orderPage >= count - 1 ? "disabled" : ""} type="button">${t("common.next", "Next")}</button>
    </div>
  `;
}

function operatorRequestForOrder(order) {
  return (operatorRequests || []).find((request) => {
    if (request.request_type !== "unpack_for_split") return false;
    return String(request.netsuite_id || "") === String(order.netsuite_id)
      || String(request.tranid || "") === String(order.tranid)
      || String(request.order_ref || "") === String(order.tranid)
      || String(request.order_ref || "") === String(order.netsuite_id);
  });
}

function renderOperatorRequestNotice() {
  const requests = (operatorRequests || []).filter((request) => request.request_type === "unpack_for_split");
  if (!requests.length) return "";
  const target = requests.find((request) => request.netsuite_id) || requests[0];
  return `
    <button class="operator-request-notice" data-action="open-operator-request" data-order="${target.netsuite_id || ""}" type="button">
      <strong>${t("operator.dispatchRequest", "Dispatch Request")}</strong>
      <span>${tf("operator.unpackRequestSummary", "{requests} unpack request(s) for split. Tap to handle.", { requests: requests.length })}</span>
    </button>
  `;
}

function renderPackedWarningNotice() {
  const warnings = viewMode === "packed" ? warningOrders() : [];
  if (!warnings.length) return "";
  const lines = warnings.reduce((total, order) => total + orderWarningCount(order), 0);
  return `
    <button class="order-warning-notice" data-action="open-warning-order" data-order="${warnings[0].netsuite_id}" type="button">
      <strong>${t("operator.warning", "Warning")}</strong>
      <span>${tf("operator.warningSummary", "{orders} order(s) / {lines} line(s) need adjustment", { orders: warnings.length, lines })}</span>
    </button>
  `;
}

function renderEmptyDetail() {
  return `
    <div class="empty-state">
      <strong>${t("operator.selectDeliveryOrder", "Select delivery order")}</strong>
      <span>${t("operator.selectDeliveryOrderHelp", "Tap an order on the left to load details.")}</span>
    </div>
  `;
}

function detailPanelLines(order) {
  return isCustomerPickupMode() ? customerPickupVisibleLines(order) : visibleLines(order);
}

function currentDetailPageLines(order = selectedOrder) {
  const lines = detailPanelLines(order || {});
  return pageItems(lines, linePage, activeLinePageSize());
}

function renderLoadValidation(validation) {
  const issues = validation?.issues || [];
  if (!issues.length) return "";
  return `
    <div class="sync-alert danger load-validation-alert">
      <strong>${tf("operator.linesCannotLoad", "{count} line(s) cannot load", { count: issues.length })}</strong>
      <span>${t("operator.netsuiteChangedFix", "NetSuite changed after packing. Correct these packed quantities first.")}</span>
      <div class="validation-lines">
        ${issues.map((issue) => `
          <div>
            <b>${escapeHtml(issue.itemName || "Line")}</b>
            <span>${escapeHtml(localizeMessage(issue.message || t("operator.updatePackedLine", "Update this packed line.")))}</span>
            <em>${t("operator.packedRequiredNow", "Packed: {packed} | Required now: {required}").replace("{packed}", escapeHtml(issue.packedText || "0")).replace("{required}", escapeHtml(issue.requiredText || "0"))}</em>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderDetailPanel(order) {
  const lines = detailPanelLines(order);
  const exceptions = exceptionLines(order);
  const linePageSize = activeLinePageSize();
  const count = pageCount(lines, linePageSize);
  linePage = Math.min(linePage, count - 1);
  const visible = pageItems(lines, linePage, linePageSize);
  const confirmed = lines.filter((line) => line.confirmed).length;
  const selectedLine = lines.find((line) => String(line.id) === String(selectedLineId)) || visible[0] || lines[0];
  if (selectedLine && String(selectedLineId) !== String(selectedLine.id)) selectedLineId = selectedLine.id;
  const customerPickupNotice = isCustomerPickupMode() && !lines.length ? customerPickupUnavailableMessage(order) : "";
  const directPickupInfo = !isCustomerPickupMode() && order.direct_pickup_only === true && !lines.length;
  const vrmaReferenceOnly = isVrmaReferenceOrder(order);
  const vrmaLocalOnly = isVrmaOrder(order) && !vrmaReferenceOnly;

  return `
    <div class="detail-header">
      <div>
        <div class="order-title-row">
          <h2>${order.tranid}${order.testFixture ? ` <span class="status-pill test-fixture">TEST</span>` : ""}</h2>
          ${viewMode === "packed" && !isCustomerPickupMode() && !vrmaReferenceOnly ? `<button class="secondary-button danger-button compact-action" data-action="unpack-order" type="button">${t("operator.unpackWholeOrder", "Unpack whole order")}</button>` : ""}
        </div>
        <p class="muted">${order.customer || ""}</p>
        <p class="muted">${shouldShowDeliverySchedule() ? deliveryScheduleText(order) : formatDate(order.trandate)} | ${order.delivery_method || ""}</p>
        ${order.dispatch_planned ? `<p class="dispatch-plan-note">${plannedOrderText(order, { spotLabel: "Parking spot" })}</p>` : ""}
      </div>
      <div class="status-actions">
        ${renderLineDensityToggle()}
        ${renderSavedOrderAction(order)}
        <span class="status-pill ${orderStatusClass(order)}">${orderStatusText(order)}</span>
        ${vrmaReferenceOnly
          ? `<span class="muted">${t("operator.referenceOnlyNoInventory", "Reference only · No inventory deduction")}</span>`
          : directPickupInfo ? "" : isCustomerPickupMode()
            ? `<button class="primary-button" data-action="start-fulfill" type="button" ${hasCustomerPickupDraft(order) ? "" : "disabled"}>${t("common.load", "Load")}</button>`
            : viewMode === "packed"
              ? `<button class="primary-button" data-action="start-fulfill" type="button">${t("common.load", "Load")}</button>`
              : `<button class="secondary-button" data-action="set-preparing" type="button">${t("operator.preparing", "Preparing")}</button>
                 <button class="primary-button" data-action="set-packed" type="button" ${canMarkPacked(order) ? "" : "disabled"}>${t("operator.packed", "Packed")}</button>`}
      </div>
    </div>
    <div class="progress-strip">
      <div><span>${vrmaReferenceOnly ? t("operator.referenceLines", "Reference lines") : isCustomerPickupMode() ? t("operator.pickupLines", "Pickup lines") : viewMode === "packed" ? t("operator.packedLines", "Packed lines") : t("operator.openLines", "Open lines")}</span><strong>${vrmaReferenceOnly ? lines.length : confirmed} / ${lines.length}</strong></div>
      <div><span>${t("common.location", "Location")}</span><strong>${currentLocation()?.text}</strong></div>
      <div><span>${t("operator.status", "Status")}</span><strong>${directPickupInfo ? t("operator.directPickup", "Direct pickup") : orderStatusText(order)}</strong></div>
    </div>
    ${vrmaReferenceOnly ? `
      <div class="sync-alert">
        <strong>${t("operator.localVrmaReference", "Local VRMA pickup reference")}</strong>
        <span>${tf("operator.localVrmaReferenceHelp", "Prepare for pickup from {from} to {to}. Quantities are for dispatch and driver reference only; this order does not deduct inventory.", {
          from: escapeHtml(order.outbound_location || t("operator.ourYard", "our yard")),
          to: escapeHtml(order.destination_location || t("operator.vendorYardGeneric", "the vendor yard"))
        })}</span>
      </div>
    ` : vrmaLocalOnly ? `
      <div class="sync-alert">
        <strong>${t("operator.localVrmaPacking", "Local VRMA packing and loading")}</strong>
        <span>${tf("operator.localVrmaPackingHelp", "Pack at {from} and load for {to}. These activities are recorded locally only: no NetSuite fulfillment and no inventory deduction.", {
          from: escapeHtml(order.outbound_location || t("operator.ourYard", "our yard")),
          to: escapeHtml(order.destination_location || t("operator.vendorYardGeneric", "the vendor yard"))
        })}</span>
      </div>
    ` : ""}
    ${exceptions.length ? `
      <div class="sync-alert">
        <strong>${tf("operator.linesNeedRepack", "{count} line(s) need repack", { count: exceptions.length })}</strong>
        <span>${t("operator.netsuiteChangedRepack", "NetSuite changed after packing. Unpack the affected line, then pack again with the latest required qty.")}</span>
      </div>
    ` : ""}
    ${customerPickupNotice ? `
      <div class="sync-alert danger">
        <strong>${t("operator.pickupUnavailable", "Pickup unavailable")}</strong>
        <span>${escapeHtml(localizeMessage(customerPickupNotice))}</span>
      </div>
    ` : ""}
    ${directPickupInfo ? `
      <div class="sync-alert">
        <strong>${t("operator.directPickupOrder", "Direct pickup order")}</strong>
        <span>${tf("operator.directPickupHelp", "All remaining quantities will be collected from linked source yards. There are no lines to prepare at {yard}.", { yard: escapeHtml(currentLocation()?.text || t("operator.thisYard", "this yard")) })}</span>
      </div>
    ` : ""}
    <div class="work-area">
      <div class="line-column">
        <div class="line-list ${compactLineMode ? "compact-line-list" : ""}">
          ${visible.map((line) => renderLine(line)).join("") || `<div class="empty-state small"><strong>${isCustomerPickupMode() ? t("operator.noPickupQuantity", "No pickup quantity") : directPickupInfo ? t("operator.noLocalYardQuantity", "No local-yard quantity") : t("operator.noLines", "No lines")}</strong><span>${escapeHtml(localizeMessage(customerPickupNotice || (directPickupInfo ? t("operator.driverCollectHelp", "Driver will collect the linked quantities from their source yards.") : t("operator.noOpenOrdersHelp", "Ask admin to sync if details are missing."))))}</span></div>`}
        </div>
        <div class="pagination-row">
          <button class="secondary-button" data-action="line-prev" ${linePage === 0 ? "disabled" : ""} type="button">${t("common.previous", "Previous")}</button>
          <strong>${linePage + 1} / ${count}</strong>
          <button class="secondary-button" data-action="line-next" ${linePage >= count - 1 ? "disabled" : ""} type="button">${t("common.next", "Next")}</button>
        </div>
      </div>
      ${selectedLine ? (vrmaReferenceOnly ? renderVrmaReferenceLinePanel(selectedLine) : renderSelectedLinePanel(selectedLine)) : customerPickupNotice ? `<aside class="selected-panel"><div class="empty-state"><strong>${t("operator.pickupUnavailable", "Pickup unavailable")}</strong><span>${escapeHtml(localizeMessage(customerPickupNotice))}</span></div></aside>` : directPickupInfo ? `<aside class="selected-panel"><div class="empty-state"><strong>${t("operator.dispatchInfoOnly", "Dispatch information only")}</strong><span>${t("operator.noPackingAtYard", "No packing action is required at this yard.")}</span></div></aside>` : renderEmptyDetail()}
    </div>
  `;
}

function renderFulfillmentScreen() {
  const order = fulfillmentOrder || selectedOrder;
  if (!order) {
    currentModule = "delivery";
    return render();
  }
  const packedLines = visibleLines(order).filter((line) => hasPackedQty(line));
  const fulfillmentPhotoSlots = Math.max(2, fulfillmentPhotoDataUrls.length);
  const fulfillmentPhotoCount = fulfillmentPhotoDataUrls.filter(Boolean).length;
  if (fulfillmentResult) {
    const isPickupLoad = currentModule === "customer-pickup-load";
    return shell(t("operator.loadComplete", "Load Complete"), `${t("common.order", "Order")} ${order.tranid}`, `
      <section class="fulfillment-screen">
        <div class="fulfillment-card success">
          <span>${isPickupLoad ? t("operator.pickupStatus", "Pickup Status") : t("operator.localYardStatus", "Local Yard Status")}</span>
          <strong>${isPickupLoad ? (fulfillmentResult.pickupStatus === "partial_loaded" ? t("operator.partialLoaded", "Partial Loaded") : t("common.loaded", "Loaded")) : (fulfillmentResult.localYardOrderStatus || t("common.loaded", "Loaded"))}</strong>
          <p>${isPickupLoad ? tf("operator.photoSavedRemaining", "Photo proof saved. Remaining line count: {count}.", { count: fulfillmentResult.remainingLines || 0 }) : t("operator.photoSavedHidden", "Photo proof saved. This order is hidden from the operator list.")}</p>
        </div>
        <div class="selected-actions">
          <button class="primary-button" data-action="finish-fulfill" type="button">${isPickupLoad ? t("operator.backToScan", "Back to Scan") : t("operator.backToDelivery", "Back to Delivery")}</button>
        </div>
      </section>
    `, `<button class="secondary-button" data-action="finish-fulfill" type="button">${t("operator.deliveryPrep", "Delivery")}</button>`);
  }
  return shell(t("operator.loadOrder", "Load Order"), `${order.tranid} | ${t("common.location", "Location")} ${currentLocation()?.text || ""}`, `
    <section class="fulfillment-screen">
      <div class="fulfillment-card">
        <span>${t("operator.photoProof", "Photo proof")}</span>
        <strong>${t("operator.loadedOnTruck", "Loaded on truck")}</strong>
        <div class="camera-actions">
          ${fulfillmentCameraActive
            ? `<button class="secondary-button" data-action="stop-camera" type="button">${t("common.closeCamera", "Close camera")}</button>`
            : `<button class="primary-button" data-action="start-camera" type="button">${t("common.openCamera", "Open camera")}</button>`}
          ${renderCameraSwitchButton("switch-fulfillment-camera")}
        </div>
        <div class="photo-slot-row">
          ${Array.from({ length: fulfillmentPhotoSlots }, (_, slot) => `
            <button class="${fulfillmentActivePhotoSlot === slot ? "active" : ""}" data-action="select-fulfillment-photo-slot" data-slot="${slot}" type="button">
              <strong>${t("common.photos", "Photo")} ${slot + 1}</strong>
              <span>${fulfillmentPhotoDataUrls[slot] ? t("common.ready", "Ready") : slot < 2 ? t("common.needed", "Needed") : t("common.optional", "Optional")}</span>
            </button>
          `).join("")}
        </div>
        <div class="photo-list-actions">
          <button class="secondary-button" data-action="add-fulfillment-photo" type="button">${t("common.addAnotherPhoto", "Add another photo")}</button>
          ${fulfillmentPhotoSlots > 2 ? `<button class="secondary-button danger-button" data-action="remove-fulfillment-photo" data-slot="${fulfillmentActivePhotoSlot}" ${fulfillmentActivePhotoSlot < 2 ? "disabled" : ""} type="button">${t("common.removeSelected", "Remove selected")}</button>` : ""}
        </div>
        ${fulfillmentCameraActive ? `
          <video class="camera-preview ${cameraCaptureMode() === "user" ? "mirrored" : ""}" id="fulfillmentCamera" autoplay muted playsinline></video>
          <button class="primary-button" data-action="capture-photo" type="button">${t("operator.capturePhoto", "Capture photo")} ${fulfillmentActivePhotoSlot + 1}</button>
        ` : fulfillmentPhotoDataUrls[fulfillmentActivePhotoSlot] ? `<img class="photo-preview" src="${fulfillmentPhotoDataUrls[fulfillmentActivePhotoSlot]}" alt="${t("operator.photoProof", "Truck loading proof")} ${fulfillmentActivePhotoSlot + 1}" />` : `<div class="photo-placeholder">${t("operator.takeTwoLoadPhotos", "Take at least 2 photos before confirming load. You can add more photos if needed.")}</div>`}
      </div>
      <div class="fulfillment-card">
        <span>${t("operator.packedQtyToLoad", "Packed qty to load")}</span>
        <strong>${tf("operator.lineCount", "{count} line(s)", { count: packedLines.length })}</strong>
        <div class="fulfillment-lines">
          ${packedLines.map((line) => `
            <div>
              <b>${line.sku || line.item_name}</b>
              <span>${displayQty(line.packed_pallet_qty)} PLT / ${displayQty(line.packed_section_qty)} SEC / ${displayQty(line.packed_layer_qty)} LYR / ${displayQty(line.packed_piece_qty)} PCS</span>
            </div>
          `).join("") || `<p class="muted">${t("operator.noPackedQty", "No packed qty.")}</p>`}
        </div>
      </div>
      <div class="selected-actions">
        ${fulfillmentSubmitting ? `<div class="sync-alert"><strong>${localizeMessage(fulfillmentJobStage || t("operator.savingLoadProof", "Saving load proof"))}</strong><span>${localizeMessage(fulfillmentStatusText || t("operator.savingLocalYardStatus", "Saving local yard status..."))}${fulfillmentStartedAt ? ` (${Math.max(1, Math.round((Date.now() - fulfillmentStartedAt) / 1000))}s)` : ""}</span></div>` : ""}
        ${!fulfillmentSubmitting && fulfillmentJobStage === "Load failed" ? `<div class="sync-alert danger"><strong>${t("operator.loadFailed", "Load failed")}</strong><span>${escapeHtml(localizeMessage(fulfillmentStatusText))}</span></div>` : ""}
        ${renderLoadValidation(fulfillmentValidation)}
        <button class="primary-button" data-action="confirm-fulfill" ${fulfillmentPhotoCount >= 2 && !fulfillmentSubmitting ? "" : "disabled"} type="button">${fulfillmentSubmitting ? t("operator.loading", "Loading...") : t("common.load", "Load")}</button>
      </div>
    </section>
  `, `
    <button class="secondary-button" data-action="cancel-fulfill" type="button">${t("common.back", "Back")}</button>
    <button class="secondary-button" data-action="logout" type="button">${operator.display_name}</button>
  `);
}

function renderLine(line) {
  const units = deliveryLineUnits(line);
  const notice = exceptionText(line);
  const underPacked = isUnderPacked(line);
  const draftConfirmed = isActiveDraftPackedLine(line);
  const referenceOnly = line.vrma_reference_only === true || isVrmaReferenceOrder();
  const valueLabel = referenceOnly ? t("operator.reference", "Reference") : isActiveDraftPackedLine(line) ? t("operator.confirmed", "Confirmed") : viewMode === "packed" ? t("operator.packed", "Packed") : t("operator.open", "Open");
  return `
    <button class="line-card ${String(selectedLineId) === String(line.id) ? "active" : ""} ${line.confirmed ? "confirmed" : ""} ${underPacked ? "underpacked" : ""} ${notice ? "exception" : ""}" data-line="${line.id}" type="button">
      <div class="line-info">
        <strong>${line.sku || line.item_name}</strong>
        ${compactLineMode ? "" : `<span>${line.item_description || ""}</span>`}
        ${draftConfirmed ? `<em class="confirmed-note">${t("operator.confirmedAdjust", "Confirmed - can still adjust before Packed")}</em>` : ""}
        ${notice ? `<em>${notice}</em>` : ""}
        ${underPacked ? `<em class="underpack-note">${t("operator.stillOpenQty", "Still has open qty")}</em>` : ""}
      </div>
      <div class="required-measures">
        ${units.map((unit) => `<div class="measure"><span>${valueLabel} ${unit.label}</span><b>${displayQty(panelValue(line, unit.key))}</b></div>`).join("")}
      </div>
    </button>
  `;
}

function renderVrmaReferenceLinePanel(line) {
  const units = deliveryLineUnits(line);
  return `
    <aside class="selected-panel vrma-reference-panel" data-selected-line="${line.id}">
      <div class="selected-header">
        <span>${t("operator.vrmaReferenceItem", "VRMA reference item")}</span>
        <strong>${escapeHtml(line.sku || line.item_name)}</strong>
        <p>${escapeHtml(line.item_description || "")}</p>
      </div>
      <div class="selected-measures">
        ${units.map((unit) => `<div class="measure"><span>${t("operator.reference", "Reference")} ${unit.label}</span><b>${displayQty(requiredValue(line, unit.key))}</b></div>`).join("")}
      </div>
      <div class="sync-alert">
        <strong>${t("operator.noPackingTransaction", "No packing transaction")}</strong>
        <span>${t("operator.vrmaReferenceItemHelp", "This item and quantity are shown for pickup preparation, dispatch, and driver reference. They do not update inventory or create a NetSuite fulfillment.")}</span>
      </div>
    </aside>
  `;
}

function renderSelectedLinePanel(line) {
  const units = deliveryLineUnits(line);
  const notice = exceptionText(line);
  const showConfirmPage = currentModule === "delivery" && viewMode !== "packed";
  const packedActions = notice
    ? `<button class="secondary-button danger-button" data-action="unpack-line" data-line="${line.id}" type="button">${t("operator.unpackPackedQty", "Unpack packed qty")}</button>`
    : `<button class="primary-button" data-action="update-packed-line" data-line="${line.id}" type="button">${t("operator.updatePackedQty", "Update packed qty")}</button>
       <button class="secondary-button danger-button" data-action="unpack-line" data-line="${line.id}" type="button">${t("operator.unpackPackedQty", "Unpack packed qty")}</button>`;
  return `
    <aside class="selected-panel" data-selected-line="${line.id}">
      ${showConfirmPage ? `
        <div class="selected-page-actions">
          <button class="secondary-button confirm-page-button" data-action="confirm-page" type="button">${t("operator.confirmPage", "Confirm page")}</button>
        </div>
      ` : ""}
      <div class="selected-header">
        <span>${t("operator.selectedItem", "Selected item")}</span>
        <strong>${line.sku || line.item_name}</strong>
        <p>${line.item_description || ""}</p>
      </div>
      <div class="selected-measures">
        ${units.map((unit) => `<div class="measure"><span>${isCustomerPickupMode() ? t("operator.remaining", "Remaining") : t("operator.required", "Required")} ${unit.label}</span><b>${displayQty(isCustomerPickupMode() ? Math.max(0, requiredValue(line, unit.key) - pickupLoadedValue(line, unit.key)) : requiredValue(line, unit.key))}</b></div>`).join("")}
      </div>
      ${notice ? `<div class="line-alert"><strong>${t("operator.repackNeeded", "Repack needed")}</strong><span>${notice}</span></div>` : ""}
      ${notice ? "" : units.map((unit) => renderStepper(unit.key, `${viewMode === "packed" ? t("operator.packed", "Packed") : t("operator.pack", "Pack")} ${unit.label}`, panelValue(line, unit.key))).join("")}
      ${viewMode === "packed"
        ? `<div class="selected-actions">${packedActions}</div>`
        : `<div class="selected-actions"><button class="primary-button" data-action="confirm-line" data-line="${line.id}" type="button">${t("operator.confirmLine", "Confirm line")}</button></div>`}
    </aside>
  `;
}

function renderStepper(unit, label, value) {
  return `
    <label class="stepper-field">
      <span>${label}</span>
      <div class="stepper" data-unit="${unit}">
        <button data-action="step-qty" data-unit="${unit}" data-delta="-1" type="button">-</button>
        <input data-pack="${unit}" value="${value}" readonly />
        <button data-action="step-qty" data-unit="${unit}" data-delta="1" type="button">+</button>
      </div>
    </label>
  `;
}

function deliveryOrderKey(order) {
  return String(order?.netsuite_id || order?.id || "");
}

function combineDeliveryOrderTypes(source = {}) {
  return [...(source.salesOrder || []), ...(source.transferOrder || []), ...(source.vrmaOrder || [])];
}

function applyDeliveryBootstrapState(bootstrap, options = {}) {
  savedDeliveryOrderKeys = new Set((bootstrap.savedOrderKeys || []).map((key) => String(key)));
  activeDeliveryDraft = bootstrap.activeDraft || null;
  applyDeliveryNotifications(bootstrap.notifications, options);
  deliveryOrderBuckets.active = combineDeliveryOrderTypes(bootstrap.orders);
}

async function fetchPackedDeliveryOrders(targetLocationId = locationId) {
  const [salesOrders, transferOrders, vrmaOrders] = await Promise.all([
    api(`/api/delivery/orders?locationId=${targetLocationId}&status=packed&orderType=sales_order`),
    api(`/api/delivery/orders?locationId=${targetLocationId}&status=packed&orderType=transfer_order`),
    api(`/api/delivery/vrma-orders?locationId=${targetLocationId}&status=packed`)
  ]);
  return [...salesOrders, ...transferOrders, ...vrmaOrders];
}

async function primePackedDeliveryOrders({ force = false } = {}) {
  if (deliveryPrepMode !== "standard" || !operator || !locationId) return deliveryOrderBuckets.packed;
  if (!force && Array.isArray(deliveryOrderBuckets.packed)) return deliveryOrderBuckets.packed;
  const prefetchLocationId = String(locationId);
  if (packedDeliveryPrefetch?.locationId === prefetchLocationId) return packedDeliveryPrefetch.promise;
  const promise = fetchPackedDeliveryOrders(prefetchLocationId)
    .then((packedOrders) => {
      if (String(locationId) === prefetchLocationId) deliveryOrderBuckets.packed = packedOrders;
      return packedOrders;
    })
    .finally(() => {
      if (packedDeliveryPrefetch?.promise === promise) packedDeliveryPrefetch = null;
    });
  packedDeliveryPrefetch = { locationId: prefetchLocationId, promise };
  return promise;
}

function mergeDeliveryOrderIntoState(order) {
  if (!order) return;
  const key = deliveryOrderKey(order);
  const merge = (list) => (Array.isArray(list)
    ? list.map((item) => deliveryOrderKey(item) === key ? { ...item, ...order } : item)
    : list);
  orders = merge(orders);
  deliveryOrderBuckets.active = merge(deliveryOrderBuckets.active);
  deliveryOrderBuckets.packed = merge(deliveryOrderBuckets.packed);
}

function upsertDeliveryOrder(list, order) {
  if (!Array.isArray(list)) return list;
  const key = deliveryOrderKey(order);
  const index = list.findIndex((item) => deliveryOrderKey(item) === key);
  if (index < 0) return [...list, order];
  return list.map((item, itemIndex) => itemIndex === index ? { ...item, ...order } : item);
}

function acceptRefreshedDeliveryOrder(order, { renderPanels = true } = {}) {
  if (!order) return false;
  mergeDeliveryOrderIntoState(order);
  if (String(selectedId || "") === deliveryOrderKey(order)) {
    selectedOrder = order;
    const lines = visibleLines(order);
    if (!selectedLineId || !lines.some((line) => String(line.id) === String(selectedLineId))) {
      selectedLineId = lines[0]?.id || null;
    }
  }
  if (renderPanels && currentModule === "delivery") renderDeliveryPanels();
  return true;
}

function applyPackedOrderTransition(order) {
  if (!order) return;
  const stillOpen = (order.lines || []).some((line) => isPickableLine(line) && hasRemainingQty(line));
  const nextOrder = { ...order, underpack_count: stillOpen ? 1 : 0 };
  const key = deliveryOrderKey(nextOrder);
  if (Array.isArray(deliveryOrderBuckets.active)) {
    deliveryOrderBuckets.active = stillOpen
      ? upsertDeliveryOrder(deliveryOrderBuckets.active, nextOrder)
      : deliveryOrderBuckets.active.filter((item) => deliveryOrderKey(item) !== key);
  }
  deliveryOrderBuckets.packed = upsertDeliveryOrder(deliveryOrderBuckets.packed || [], nextOrder);
  if (viewMode === "active") {
    orders = stillOpen
      ? upsertDeliveryOrder(orders, nextOrder)
      : orders.filter((item) => deliveryOrderKey(item) !== key);
    const panelOrders = filteredDeliveryOrders();
    selectedId = stillOpen ? key : panelOrders[0]?.netsuite_id || null;
    selectedOrder = stillOpen ? nextOrder : null;
    if (!stillOpen) selectedLineId = null;
    activeDeliveryDraft = null;
    renderDeliveryPanels();
  }
}

async function activateCachedDeliveryView(nextView) {
  const cached = deliveryOrderBuckets[nextView];
  if (!Array.isArray(cached)) return false;
  viewMode = nextView;
  orderPage = 0;
  orders = annotateSavedOrders(cached);
  selectedId = filteredDeliveryOrders()[0]?.netsuite_id || null;
  selectedOrder = null;
  selectedLineId = null;
  renderDeliveryPanels();
  if (nextView === "packed") {
    void api(`/api/operator/requests?locationId=${locationId}&status=open`)
      .then((requests) => {
        operatorRequests = requests;
        if (currentModule === "delivery" && viewMode === "packed") {
          renderDeliveryPanels({ detailPanel: false });
        }
      })
      .catch(() => null);
  }
  const detailId = selectedId;
  if (detailId) {
    await loadDetail(detailId, { silentRender: true });
    if (String(selectedId) === String(detailId)) renderDeliveryPanels({ orderPanel: false });
  }
  return true;
}

async function activateCachedDeliveryBatch(nextFilter) {
  deliveryBatchFilter = nextFilter || "batch_a";
  deliveryOrderType = deliveryBatchFilter === "transfer" ? "transfer_order" : "sales_order";
  localStorage.setItem("mbbs.operator.deliveryOrderType", deliveryOrderType);
  localStorage.setItem("mbbs.operator.deliveryBatchFilter", deliveryBatchFilter);

  orderPage = 0;
  linePage = 0;
  selectedLineId = null;
  selectedId = filteredDeliveryOrders()[0]?.netsuite_id || null;
  selectedOrder = null;

  renderDeliveryPanels();
  const detailId = selectedId;
  if (detailId) {
    await loadDetail(detailId, { silentRender: true });
    if (String(selectedId) === String(detailId)) renderDeliveryPanels({ orderPanel: false });
  }
}

async function loadOrders(options = {}) {
  const status = viewMode === "packed" ? "packed" : "active";
  const canBootstrap = ["standard", "saved"].includes(deliveryPrepMode) && status === "active";
  const previousSelectedOrder = selectedOrder;
  const previousSelectedId = selectedId;
  if (canBootstrap) {
    const [bootstrap, requests] = await Promise.all([
      api(`/api/delivery/bootstrap?locationId=${locationId}`),
      deliveryPrepMode === "standard" && deliveryBatchFilter !== "transfer"
        ? api(`/api/operator/requests?locationId=${locationId}&orderType=${deliveryOrderType}&status=open`).catch(() => [])
        : Promise.resolve([])
    ]);
    applyDeliveryBootstrapState(bootstrap, options);
    const bootstrappedOrders = deliveryOrderBuckets.active || [];
    orders = deliveryPrepMode === "saved"
      ? bootstrappedOrders.filter((order) => savedDeliveryOrderKeys.has(String(order.netsuite_id || "")))
      : bootstrappedOrders;
    operatorRequests = requests;
  } else if (deliveryPrepMode === "standard" && status === "packed") {
    const [packedOrders, requests] = await Promise.all([
      primePackedDeliveryOrders({ force: true }),
      api(`/api/operator/requests?locationId=${locationId}&status=open`).catch(() => [])
    ]);
    deliveryOrderBuckets.packed = packedOrders;
    orders = packedOrders;
    operatorRequests = requests;
    void Promise.all([
      loadDeliveryNotifications(options),
      loadCurrentDeliveryDraft(),
      loadSavedDeliveryOrderKeys()
    ]).then(() => {
      if (currentModule === "delivery" && viewMode === "packed") {
        renderDeliveryPanels({ orderPanel: false, detailPanel: false });
      }
    }).catch(() => null);
  } else {
    await Promise.all([
      loadDeliveryNotifications(options),
      loadCurrentDeliveryDraft(),
      loadSavedDeliveryOrderKeys()
    ]);
  }
  if (!canBootstrap && deliveryPrepMode === "saved") {
    orders = await api(`/api/delivery/saved-orders?locationId=${locationId}`);
  } else if (!canBootstrap && deliveryPrepMode === "load") {
    await loadDeliveryLoadTrucks();
    orders = deliveryLoadViewTruck
      ? await api(`/api/delivery/load-orders?locationId=${locationId}&status=${status}&planDate=${encodeURIComponent(deliveryLoadViewDate || "")}&truckPlate=${encodeURIComponent(deliveryLoadViewTruck)}`)
      : await api(`/api/delivery/load-orders?locationId=${locationId}&status=${status}&planDate=${encodeURIComponent(deliveryLoadViewDate || "")}`);
  } else if (!canBootstrap) {
    if (deliveryPrepMode === "standard") {
      const [salesOrders, transferOrders] = await Promise.all([
        api(`/api/delivery/orders?locationId=${locationId}&status=${status}&orderType=sales_order`),
        api(`/api/delivery/orders?locationId=${locationId}&status=${status}&orderType=transfer_order`)
      ]);
      orders = [...salesOrders, ...transferOrders];
    } else {
      orders = await api(`/api/delivery/orders?locationId=${locationId}&status=${status}&orderType=${deliveryOrderType}`);
    }
  }
  if (!canBootstrap) operatorRequests = deliveryPrepMode === "standard" && deliveryBatchFilter !== "transfer"
    ? await api(`/api/operator/requests?locationId=${locationId}&orderType=${deliveryOrderType}&status=open`).catch(() => [])
    : [];
  orders = annotateSavedOrders(orders);
  const preparing = preparingOrderId();
  const panelOrders = filteredDeliveryOrders();
  if (viewMode === "active" && preparing) selectedId = preparing;
  else if (!options.keepSelection) selectedId = panelOrders[0]?.netsuite_id || null;
  if (selectedId && !panelOrders.some((order) => String(order.netsuite_id) === String(selectedId))) {
    selectedId = panelOrders[0]?.netsuite_id || null;
  }
  const keepCurrentDetail = options.keepSelection
    && previousSelectedOrder
    && String(previousSelectedId || "") === String(selectedId || "");
  selectedOrder = keepCurrentDetail ? previousSelectedOrder : null;
  renderDeliveryPanels({ detailPanel: !keepCurrentDetail });
  const detailId = selectedId;
  if (detailId) {
    await loadDetail(detailId, { silentRender: true });
    if (String(selectedId) === String(detailId)) renderDeliveryPanels({ orderPanel: false });
  }
  if (status === "active" && deliveryPrepMode === "standard") {
    void primePackedDeliveryOrders().catch(() => null);
  }
}

function consolidationDraftKey(allocation) {
  return `${allocation.batchOrderId}:${allocation.lineKey}`;
}

function consolidationDraft(allocation) {
  const key = consolidationDraftKey(allocation);
  if (!consolidationDrafts.has(key)) {
    consolidationDrafts.set(key, Object.fromEntries((allocation.units || []).map((unit) => [unit.key, qty(unit.required)])));
  }
  return consolidationDrafts.get(key);
}

function consolidationStatusText(status) {
  return {
    picking: t("operator.consolidationPicking", "Picking"),
    ready: t("operator.readyToPack", "Ready to Pack"),
    packed: t("operator.packed", "Packed"),
    attention: t("operator.attentionRequired", "Attention Required")
  }[status] || status;
}

function consolidationTotalsText(totals = []) {
  return totals
    .filter((unit) => qty(unit.required) > 0 || qty(unit.confirmed) > 0)
    .map((unit) => `${displayQty(unit.confirmed)} / ${displayQty(unit.required)} ${escapeHtml(unit.label)}`)
    .join(" | ") || "0";
}

function renderConsolidationQueue() {
  const rows = consolidationQueue.orders || [];
  return `
    <section class="consolidation-queue">
      <div class="consolidation-intro">
        <div>
          <span>${t("operator.savedSalesOrders", "Saved Sales Orders")}</span>
          <strong>${consolidationQueue.eligible || 0} ${t("operator.ready", "ready")}</strong>
          <p>${t("operator.consolidationQueueHelp", "All starred Sales Orders at this yard will be reserved together.")}</p>
        </div>
        <button class="primary-button" data-action="start-consolidation" ${consolidationBusy || !(consolidationQueue.eligible > 0) ? "disabled" : ""} type="button">
          ${consolidationBusy ? t("operator.starting", "Starting...") : t("operator.startConsolidation", "Start Consolidation")}
        </button>
      </div>
      ${consolidationNotice ? `<div class="sync-alert danger"><strong>${t("operator.cannotStart", "Cannot start")}</strong><span>${escapeHtml(localizeMessage(consolidationNotice))}</span></div>` : ""}
      <div class="consolidation-queue-list">
        ${rows.map((row) => `
          <article class="consolidation-queue-row ${row.eligible ? "eligible" : "blocked"}">
            <div>
              <strong>${escapeHtml(row.orderRef)}</strong>
              <span>${formatDate(row.planDate)} | ${escapeHtml(row.truckPlate || "-")} | ${escapeHtml(row.loadName || "-")}</span>
              ${row.customer ? `<small>${escapeHtml(row.customer)}</small>` : ""}
            </div>
            <div class="consolidation-queue-state">
              <b>${row.eligible ? t("operator.ready", "Ready") : t("operator.blocked", "Blocked")}</b>
              <span>${escapeHtml(localizeMessage(row.issue || `${row.lineCount || 0} lines`))}</span>
            </div>
          </article>
        `).join("") || `<div class="empty-state"><strong>${t("operator.noSavedSalesOrders", "No saved Sales Orders")}</strong><span>${t("operator.starOrdersFirst", "Star Sales Orders in Delivery Prep first.")}</span></div>`}
      </div>
    </section>
  `;
}

function filteredConsolidationItems() {
  const needle = consolidationSearch.trim().toLowerCase();
  return (consolidationBatch?.items || []).filter((item) => {
    return !needle || `${item.itemName} ${item.description}`.toLowerCase().includes(needle);
  });
}

function selectedConsolidationItem() {
  const items = filteredConsolidationItems();
  let selected = items.find((item) => item.key === consolidationSelectedItemKey);
  if (!selected) {
    selected = items[0] || null;
    consolidationSelectedItemKey = selected?.key || "";
  }
  return selected;
}

function renderConsolidationAllocation(allocation) {
  const draft = consolidationDraft(allocation);
  return `
    <article class="consolidation-allocation ${allocation.syncException ? "warning" : ""}">
      <div class="consolidation-allocation-head">
        <div>
          <strong>${escapeHtml(allocation.orderRef)}</strong>
          <span>${formatDate(allocation.planDate)} | ${escapeHtml(allocation.truckPlate || "-")} | ${escapeHtml(allocation.loadName || "-")}</span>
        </div>
        ${allocation.syncException ? `<b>${t("operator.attentionRequired", "Attention Required")}</b>` : ""}
      </div>
      <div class="consolidation-unit-grid">
        ${(allocation.units || []).map((unit) => {
          const value = qty(draft[unit.key]);
          return `
            <div class="consolidation-unit">
              <span>${escapeHtml(unit.label)}</span>
              <div class="consolidation-required">
                <span>${t("operator.required", "Required")}</span>
                <strong>${displayQty(unit.required)} ${escapeHtml(unit.label)}</strong>
                <small>${t("operator.remaining", "Remaining")} ${displayQty(Math.max(0, qty(unit.required) - value))}</small>
              </div>
              <div class="stepper">
                <button data-action="step-consolidation" data-order="${allocation.batchOrderId}" data-line="${escapeHtml(allocation.lineKey)}" data-unit="${unit.key}" data-delta="-1" type="button">-</button>
                <input value="${displayQty(value)}" readonly />
                <button data-action="step-consolidation" data-order="${allocation.batchOrderId}" data-line="${escapeHtml(allocation.lineKey)}" data-unit="${unit.key}" data-delta="1" type="button">+</button>
              </div>
            </div>
          `;
        }).join("")}
      </div>
      <button class="primary-button compact-action" data-action="confirm-consolidation-line" data-order="${allocation.batchOrderId}" data-line="${escapeHtml(allocation.lineKey)}" ${consolidationBusy || allocation.syncException ? "disabled" : ""} type="button">${t("operator.confirmAllocation", "Confirm Allocation")}</button>
    </article>
  `;
}

function renderConsolidationPickStage() {
  const items = filteredConsolidationItems();
  const selected = selectedConsolidationItem();
  return `
    <div class="consolidation-workspace">
      <aside class="consolidation-item-panel">
        <label class="consolidation-search">
          <span>${t("common.search", "Search")}</span>
          <input id="consolidationSearch" value="${escapeHtml(consolidationSearch)}" placeholder="${t("operator.searchSkuItem", "SKU / item")}" autocomplete="off" />
        </label>
        <div class="consolidation-item-list">
          ${items.map((item) => `
            <button class="consolidation-item-card ${item.key === selected?.key ? "active" : ""}" data-action="select-consolidation-item" data-item="${escapeHtml(item.key)}" type="button">
              <strong>${escapeHtml(item.itemName)}</strong>
              <span>${consolidationTotalsText(item.totals)}</span>
              <small>${item.allocations.length} ${t("common.order", "order")}</small>
            </button>
          `).join("") || `<div class="empty-state small"><strong>${t("operator.noItems", "No items")}</strong><span>${t("operator.trySearch", "Try another search.")}</span></div>`}
        </div>
      </aside>
      <section class="consolidation-allocation-panel">
        ${selected ? `
          <div class="consolidation-selected-item">
            <div><span>${t("operator.consolidatedItem", "Consolidated item")}</span><strong>${escapeHtml(selected.itemName)}</strong><p>${escapeHtml(selected.description || "")}</p></div>
            <div class="consolidation-selected-actions">
              <b>${consolidationTotalsText(selected.totals)}</b>
              <button class="primary-button compact-action" data-action="confirm-consolidation-item" data-item="${escapeHtml(selected.key)}" ${consolidationBusy || selected.allocations.some((allocation) => allocation.syncException) ? "disabled" : ""} type="button">${t("operator.confirmAllSkuLines", "Confirm all SKU lines")}</button>
            </div>
          </div>
          <div class="consolidation-allocation-list">${selected.allocations.map(renderConsolidationAllocation).join("")}</div>
        ` : `<div class="empty-state"><strong>${t("operator.selectItem", "Select item")}</strong></div>`}
      </section>
    </div>
  `;
}

function consolidationLineComplete(line) {
  return (line?.units || []).length > 0
    && (line.units || []).every((unit) => qty(unit.remaining) <= 0.000001);
}

function consolidationQtyText(value) {
  return qty(value) <= 0.000001 ? "0" : displayQty(value);
}

function consolidationUnitLabel(unit) {
  return String(unit?.label || "").toUpperCase() === "PCS" ? "PC" : String(unit?.label || "");
}

function selectedConsolidationReviewOrder() {
  const batchOrders = consolidationBatch?.orders || [];
  let selected = batchOrders.find((order) => String(order.id) === String(consolidationReviewOrderId));
  if (!selected) {
    selected = batchOrders.find((order) => order.status !== "packed") || batchOrders[0] || null;
    consolidationReviewOrderId = selected?.id || "";
    consolidationReviewLineKey = "";
    consolidationReviewLinePage = 0;
  }
  return selected;
}

function selectedConsolidationReviewLine(order, visibleLines = []) {
  const lines = order?.lines || [];
  let selected = lines.find((line) => String(line.lineKey) === String(consolidationReviewLineKey));
  if (!selected) {
    selected = visibleLines[0] || lines[0] || null;
    consolidationReviewLineKey = selected?.lineKey || "";
  }
  return selected;
}

function renderConsolidationReviewOrderCard(order) {
  const completedLines = (order.lines || []).filter(consolidationLineComplete).length;
  const planLabel = formatDate(order.planDate) || t("operator.notPlanned", "Not planned");
  return `
    <button class="order-card consolidation-review-order-card status-${escapeHtml(order.status)} ${String(order.id) === String(consolidationReviewOrderId) ? "active" : ""}" data-action="select-consolidation-review-order" data-order="${order.id}" type="button">
      <strong>${escapeHtml(order.orderRef)}${order.testFixture ? ` <span class="status-pill test-fixture">TEST</span>` : ""}</strong>
      ${order.customer ? `<span>${escapeHtml(order.customer)}</span>` : ""}
      <span class="order-schedule-line">${planLabel} | ${escapeHtml(order.truckPlate || "-")} | ${escapeHtml(order.loadName || "-")}</span>
      <span class="consolidation-review-card-status">${consolidationStatusText(order.status)} | ${completedLines} / ${(order.lines || []).length} ${t("operator.lines", "lines")}</span>
    </button>
  `;
}

function renderConsolidationReviewLine(line) {
  const complete = consolidationLineComplete(line);
  const units = line.units || [];
  const cardUnits = units.slice(0, 2);
  return `
    <button class="line-card consolidation-review-line-card ${String(line.lineKey) === String(consolidationReviewLineKey) ? "active" : ""} ${complete ? "confirmed" : ""} ${line.syncException ? "exception" : ""}" data-action="select-consolidation-review-line" data-line="${escapeHtml(line.lineKey)}" type="button">
      <div class="line-info">
        <strong>${escapeHtml(line.itemName)}</strong>
        ${compactLineMode ? "" : `<span>${escapeHtml(line.description || "")}</span>`}
        ${line.syncException ? `<em>${escapeHtml(localizeMessage(line.syncException))}</em>` : ""}
      </div>
      <div class="required-measures">
        ${cardUnits.map((unit) => `
          <div class="measure ${qty(unit.remaining) <= 0.000001 ? "confirmed-measure" : ""}">
            <span>${escapeHtml(consolidationUnitLabel(unit))}</span>
            <b>${consolidationQtyText(unit.confirmed)} / ${consolidationQtyText(unit.required)}</b>
          </div>
        `).join("")}
      </div>
    </button>
  `;
}

function renderConsolidationReviewLinePanel(line) {
  if (!line) return `<aside class="selected-panel"><div class="empty-state small"><strong>${t("operator.selectLine", "Select line")}</strong></div></aside>`;
  return `
    <aside class="selected-panel consolidation-review-selected-line">
      <div class="selected-header">
        <span>${t("operator.selectedItem", "Selected item")}</span>
        <strong>${escapeHtml(line.itemName)}</strong>
        <p>${escapeHtml(line.description || "")}</p>
      </div>
      <div class="consolidation-review-quantity-list">
        ${(line.units || []).map((unit) => `
          <div class="consolidation-review-quantity ${qty(unit.remaining) <= 0.000001 ? "complete" : ""}">
            <span>${escapeHtml(consolidationUnitLabel(unit))}</span>
            <strong>${consolidationQtyText(unit.confirmed)} / ${consolidationQtyText(unit.required)}</strong>
          </div>
        `).join("")}
      </div>
      ${line.syncException ? `<div class="line-alert"><strong>${t("operator.attentionRequired", "Attention Required")}</strong><span>${escapeHtml(localizeMessage(line.syncException))}</span></div>` : ""}
      <div class="selected-actions consolidation-review-selected-actions">
        <button class="secondary-button" data-action="consolidation-stage" data-stage="pick" type="button">${t("operator.adjustInPickItems", "Adjust in Pick Items")}</button>
      </div>
    </aside>
  `;
}

function renderConsolidationReviewStage() {
  const batchOrders = consolidationBatch?.orders || [];
  const selectedOrder = selectedConsolidationReviewOrder();
  const lines = selectedOrder?.lines || [];
  const linePageSize = activeLinePageSize();
  const count = pageCount(lines, linePageSize);
  consolidationReviewLinePage = Math.min(Math.max(0, consolidationReviewLinePage), count - 1);
  const visible = pageItems(lines, consolidationReviewLinePage, linePageSize);
  const selectedLine = selectedConsolidationReviewLine(selectedOrder, visible);
  const confirmedLines = lines.filter(consolidationLineComplete).length;
  const selectedPlanLabel = formatDate(selectedOrder?.planDate) || t("operator.notPlanned", "Not planned");
  return `
    <div class="consolidation-review-workspace">
      <aside class="order-panel consolidation-review-orders">
        <div class="panel-title"><strong>${t("operator.orders", "Orders")}</strong><b>${batchOrders.length}</b></div>
        <div class="order-list consolidation-review-order-list">
          ${batchOrders.map(renderConsolidationReviewOrderCard).join("") || `<div class="empty-state"><strong>${t("operator.noOrders", "No orders")}</strong></div>`}
        </div>
      </aside>
      <section class="detail-panel consolidation-review-detail">
        ${selectedOrder ? `
          <div class="detail-header">
            <div>
              <div class="order-title-row"><h2>${escapeHtml(selectedOrder.orderRef)}${selectedOrder.testFixture ? ` <span class="status-pill test-fixture">TEST</span>` : ""}</h2></div>
              <p class="muted">${escapeHtml(selectedOrder.customer || "")}</p>
              <p class="dispatch-plan-note">${selectedPlanLabel} | ${escapeHtml(selectedOrder.truckPlate || "-")} | ${escapeHtml(selectedOrder.loadName || "-")}</p>
            </div>
            <div class="status-actions">
              ${renderLineDensityToggle()}
              <span class="status-pill consolidation-status-${escapeHtml(selectedOrder.status)}">${consolidationStatusText(selectedOrder.status)}</span>
              <button class="primary-button" data-action="pack-consolidation-order" data-order="${selectedOrder.id}" ${selectedOrder.status !== "ready" || consolidationBusy ? "disabled" : ""} type="button">${selectedOrder.status === "packed" ? t("operator.packed", "Packed") : t("operator.markPacked", "Mark Packed")}</button>
            </div>
          </div>
          <div class="progress-strip">
            <div><span>${t("operator.confirmedLines", "Confirmed lines")}</span><strong>${confirmedLines} / ${lines.length}</strong></div>
            <div><span>${t("operator.truck", "Truck")}</span><strong>${escapeHtml(selectedOrder.truckPlate || "-")}</strong></div>
            <div><span>${t("operator.status", "Status")}</span><strong>${consolidationStatusText(selectedOrder.status)}</strong></div>
          </div>
          <div class="work-area">
            <div class="line-column">
              <div class="line-list ${compactLineMode ? "compact-line-list" : ""}">
                ${visible.map(renderConsolidationReviewLine).join("") || `<div class="empty-state small"><strong>${t("operator.noItemLine", "No item line")}</strong></div>`}
              </div>
              <div class="pagination-row">
                <button class="secondary-button" data-action="consolidation-review-line-prev" ${consolidationReviewLinePage === 0 ? "disabled" : ""} type="button">${t("common.previous", "Previous")}</button>
                <strong>${consolidationReviewLinePage + 1} / ${count}</strong>
                <button class="secondary-button" data-action="consolidation-review-line-next" ${consolidationReviewLinePage >= count - 1 ? "disabled" : ""} type="button">${t("common.next", "Next")}</button>
              </div>
            </div>
            ${renderConsolidationReviewLinePanel(selectedLine)}
          </div>
        ` : `<div class="empty-state"><strong>${t("operator.selectOrder", "Select order")}</strong></div>`}
      </section>
    </div>
  `;
}

function renderConsolidationPick() {
  const summary = consolidationBatch?.summary || {};
  shell(t("operator.consolidationPick", "Consolidation Pick"), `${t("common.location", "Location")} ${currentLocation()?.text || locationId}`, `
    <section class="consolidation-screen">
      ${consolidationBatch ? `
        <div class="consolidation-toolbar">
          <div class="consolidation-stage-tabs">
            <button class="${consolidationStage === "pick" ? "active" : ""}" data-action="consolidation-stage" data-stage="pick" type="button">${t("operator.pickItems", "Pick Items")} <b>${summary.items || 0}</b></button>
            <button class="${consolidationStage === "review" ? "active" : ""}" data-action="consolidation-stage" data-stage="review" type="button">${t("operator.reviewPack", "Review & Pack")} <b>${summary.ready || 0}</b></button>
          </div>
          <div class="consolidation-summary">
            <span>${summary.picking || 0} ${t("operator.picking", "picking")}</span>
            <span>${summary.ready || 0} ${t("operator.ready", "ready")}</span>
            <span>${summary.packed || 0} ${t("operator.packed", "packed")}</span>
          </div>
          <button class="secondary-button danger-button" data-action="release-consolidation" ${consolidationBusy ? "disabled" : ""} type="button">${t("operator.releaseBatch", "Release Batch")}</button>
        </div>
        ${consolidationNotice ? `<div class="sync-alert danger"><strong>${t("common.notice", "Notice")}</strong><span>${escapeHtml(localizeMessage(consolidationNotice))}</span></div>` : ""}
        ${consolidationStage === "review" ? renderConsolidationReviewStage() : renderConsolidationPickStage()}
      ` : renderConsolidationQueue()}
    </section>
  `, `
    <button class="secondary-button" data-action="consolidation-back" type="button">${t("operator.deliveryPrep", "Delivery Prep")}</button>
    <button class="secondary-button" data-action="refresh-consolidation" type="button">${t("common.refresh", "Refresh")}</button>
    <button class="secondary-button" data-action="logout" type="button">${operator.display_name}</button>
  `);
  if (consolidationStage === "pick") {
    window.requestAnimationFrame(() => {
      const search = document.getElementById("consolidationSearch");
      if (search && document.activeElement?.id === "consolidationSearch") search.focus();
    });
  }
}

async function loadConsolidation({ keepItem = false } = {}) {
  const previousItem = keepItem ? consolidationSelectedItemKey : "";
  const active = await api(`/api/delivery/consolidation/active?locationId=${locationId}`);
  consolidationBatch = active || null;
  consolidationDrafts = new Map();
  consolidationNotice = "";
  if (consolidationBatch) {
    consolidationSelectedItemKey = previousItem;
    consolidationQueue = { total: 0, eligible: 0, blocked: 0, orders: [] };
  } else {
    consolidationSelectedItemKey = "";
    consolidationQueue = await api(`/api/delivery/consolidation/queue?locationId=${locationId}`);
  }
  render();
}

async function startConsolidation() {
  consolidationBusy = true;
  consolidationNotice = "";
  render();
  try {
    consolidationBatch = await api("/api/delivery/consolidation/start", {
      method: "POST",
      body: JSON.stringify({ locationId })
    });
    consolidationStage = "pick";
    consolidationDrafts = new Map();
    showToast(t("operator.consolidationStarted", "Consolidation started"));
  } catch (error) {
    const blockers = error.payload?.details || [];
    consolidationNotice = blockers.length
      ? blockers.map((item) => `${item.orderRef}: ${item.issue}`).join(" | ")
      : error.message;
  } finally {
    consolidationBusy = false;
    render();
  }
}

function stepConsolidationAllocation(batchOrderId, lineKey, unit, delta) {
  const allocation = (consolidationBatch?.items || []).flatMap((item) => item.allocations || [])
    .find((item) => String(item.batchOrderId) === String(batchOrderId) && String(item.lineKey) === String(lineKey));
  if (!allocation) return;
  const unitInfo = (allocation.units || []).find((item) => item.key === unit);
  if (!unitInfo) return;
  const draft = consolidationDraft(allocation);
  draft[unit] = Math.max(0, Math.min(qty(unitInfo.required), qty(draft[unit]) + Number(delta || 0)));
  render();
}

async function confirmConsolidationAllocation(batchOrderId, lineKey) {
  const allocation = (consolidationBatch?.items || []).flatMap((item) => item.allocations || [])
    .find((item) => String(item.batchOrderId) === String(batchOrderId) && String(item.lineKey) === String(lineKey));
  if (!allocation) return;
  consolidationBusy = true;
  render();
  try {
    consolidationBatch = await api(`/api/delivery/consolidation/orders/${encodeURIComponent(batchOrderId)}/lines/${encodeURIComponent(lineKey)}`, {
      method: "PUT",
      body: JSON.stringify({ values: consolidationDraft(allocation) })
    });
    consolidationDrafts.delete(consolidationDraftKey(allocation));
    consolidationNotice = "";
    showToast(t("operator.allocationSaved", "Allocation saved"));
  } catch (error) {
    consolidationNotice = error.message;
  } finally {
    consolidationBusy = false;
    render();
  }
}

async function confirmConsolidationSku(itemKey) {
  if (!consolidationBatch?.batch?.id || !itemKey) return;
  consolidationBusy = true;
  consolidationNotice = "";
  render();
  try {
    consolidationBatch = await api(`/api/delivery/consolidation/batches/${encodeURIComponent(consolidationBatch.batch.id)}/items/confirm`, {
      method: "PUT",
      body: JSON.stringify({ itemKey })
    });
    consolidationDrafts = new Map();
    showToast(t("operator.skuLinesConfirmed", "All SKU lines confirmed"));
  } catch (error) {
    consolidationNotice = error.message;
  } finally {
    consolidationBusy = false;
    render();
  }
}

async function packConsolidationBatchOrder(batchOrderId) {
  consolidationBusy = true;
  render();
  try {
    const result = await api(`/api/delivery/consolidation/orders/${encodeURIComponent(batchOrderId)}/pack`, { method: "POST" });
    if (result.completed) {
      consolidationBatch = null;
      consolidationNotice = t("operator.consolidationComplete", "Consolidation complete. Packed orders are ready for loading.");
      consolidationQueue = await api(`/api/delivery/consolidation/queue?locationId=${locationId}`);
    } else {
      consolidationBatch = result;
      consolidationDrafts = new Map();
      consolidationNotice = "";
    }
    showToast(t("operator.orderPacked", "Order packed"));
  } catch (error) {
    consolidationNotice = error.message;
  } finally {
    consolidationBusy = false;
    render();
  }
}

async function releaseConsolidation() {
  if (!window.confirm(t("operator.releaseConsolidationConfirm", "Release this consolidation batch and undo only its confirmed quantities?"))) return;
  consolidationBusy = true;
  render();
  try {
    await api("/api/delivery/consolidation/release", {
      method: "POST",
      body: JSON.stringify({ locationId })
    });
    consolidationBatch = null;
    consolidationDrafts = new Map();
    consolidationQueue = await api(`/api/delivery/consolidation/queue?locationId=${locationId}`);
    consolidationNotice = "";
    showToast(t("operator.batchReleased", "Batch released"));
  } catch (error) {
    consolidationNotice = error.message;
  } finally {
    consolidationBusy = false;
    render();
  }
}

async function loadDeliveryLoadTrucks() {
  if (deliveryPrepMode !== "load" || !deliveryLoadViewDate) {
    deliveryLoadTrucks = [];
    return deliveryLoadTrucks;
  }
  deliveryLoadTrucks = await api(`/api/delivery/load-trucks?locationId=${locationId}&planDate=${encodeURIComponent(deliveryLoadViewDate)}`).catch(() => []);
  if (deliveryLoadViewTruck && !deliveryLoadTrucks.some((truck) => String(truck.truck_plate) === String(deliveryLoadViewTruck))) {
    deliveryLoadViewTruck = "";
    localStorage.removeItem("mbbs.operator.deliveryLoadViewTruck");
  }
  return deliveryLoadTrucks;
}

async function loadSavedDeliveryOrderKeys() {
  if (!operator || !locationId) {
    savedDeliveryOrderKeys = new Set();
    return savedDeliveryOrderKeys;
  }
  const keys = await api(`/api/delivery/saved-order-keys?locationId=${locationId}`).catch(() => []);
  savedDeliveryOrderKeys = new Set((keys || []).map((key) => String(key)));
  return savedDeliveryOrderKeys;
}

function annotateSavedOrders(list) {
  return (list || []).map((order) => ({
    ...order,
    saved_order: savedDeliveryOrderKeys.has(String(order.netsuite_id || ""))
  }));
}

async function reloadDeliveryScreen(options = {}) {
  return loadOrders(options);
}

async function toggleSavedDeliveryOrder(orderId) {
  const id = String(orderId || "").trim();
  if (!id) return;
  if (savedDeliveryOrderKeys.has(id)) {
    await api(`/api/delivery/saved-orders/${encodeURIComponent(id)}?locationId=${locationId}`, { method: "DELETE" });
    savedDeliveryOrderKeys.delete(id);
    orders = orders.filter((order) => deliveryPrepMode !== "saved" || String(order.netsuite_id) !== id);
    if (String(selectedId) === id && deliveryPrepMode === "saved") {
      selectedId = null;
      selectedOrder = null;
      selectedLineId = null;
    } else if (selectedOrder && String(selectedOrder.netsuite_id) === id) {
      selectedOrder = { ...selectedOrder, saved_order: false };
    }
    orders = annotateSavedOrders(orders);
    showToast("Order unsaved");
    return render();
  }
  await api("/api/delivery/saved-orders", {
    method: "POST",
    body: JSON.stringify({ locationId, orderId: id })
  });
  savedDeliveryOrderKeys.add(id);
  orders = annotateSavedOrders(orders);
  if (selectedOrder && String(selectedOrder.netsuite_id) === id) selectedOrder = { ...selectedOrder, saved_order: true };
  showToast("Order saved");
  render();
}

async function loadCurrentDeliveryDraft() {
  if (!operator || !locationId) {
    activeDeliveryDraft = null;
    return null;
  }
  activeDeliveryDraft = await api(`/api/delivery/current-draft?locationId=${locationId}`).catch(() => null);
  return activeDeliveryDraft;
}

async function loadDeliveryNotifications(options = {}) {
  if (!locationId) {
    deliveryNotifications = { total: 0, salesOrder: { dueToday: 0 }, transferOrder: { dueToday: 0 }, items: [] };
    return deliveryNotifications;
  }
  const previous = deliveryNotifications;
  const nextNotifications = await api(`/api/delivery/notifications?locationId=${locationId}`).catch(() => (
    previous || { total: 0, salesOrder: { dueToday: 0 }, transferOrder: { dueToday: 0 }, items: [] }
  ));
  return applyDeliveryNotifications(nextNotifications, options);
}

function applyDeliveryNotifications(nextNotifications, options = {}) {
  deliveryNotifications = nextNotifications || { total: 0, salesOrder: { dueToday: 0 }, transferOrder: { dueToday: 0 }, items: [] };
  const items = deliveryNotificationItems();
  const alertRefs = new Set((options.alertRefs || []).map((ref) => String(ref || "").trim()).filter(Boolean));
  let alertItems = [];
  if (alertRefs.size) {
    alertItems = items.filter((item) => alertRefs.has(String(item.tranid || "")) || alertRefs.has(String(item.orderId || "")));
  } else if (options.alertRecent) {
    alertItems = items.filter(isRecentPlannedDeliveryNotification);
  } else {
    alertItems = changedDeliveryNotificationItems(items);
  }
  updateDeliveryNotificationState(items);
  if (alertItems.length) {
    showUrgentDeliveryAlert(alertItems);
  }
  return deliveryNotifications;
}

async function openUrgentDeliveryAlert() {
  const first = urgentDeliveryAlert?.items?.[0] || deliveryNotificationItems()[0];
  if (!first) return;
  const batch = deliveryBatchForNotification(first);
  urgentDeliveryAlert = null;
  deliveryOrderType = batch === "transfer" ? "transfer_order" : "sales_order";
  deliveryPrepMode = "standard";
  viewMode = "active";
  deliveryBatchFilter = batch;
  localStorage.setItem("mbbs.operator.deliveryPrepMode", deliveryPrepMode);
  localStorage.setItem("mbbs.operator.deliveryOrderType", deliveryOrderType);
  localStorage.setItem("mbbs.operator.deliveryBatchFilter", deliveryBatchFilter);
  currentModule = "delivery";
  selectedId = first.orderId || null;
  await loadOrders({ keepSelection: true });
}

async function loadReceivingOptions() {
  if (receivingOrderType === "transfer_order" || receivingOrderType === "co_order") {
    receivingSources = await api(`/api/receiving/sources?destinationLocationId=${locationId}&orderType=${receivingOrderType}`);
    receivingVendors = [];
  } else {
    receivingVendors = await api(`/api/receiving/vendors?destinationLocationId=${locationId}`);
    receivingSources = [];
  }
}

function receivingOrderUrl() {
  const url = new URL("/api/receiving/orders", window.location.origin);
  const isSearching = receivingSearch.trim() || receivingItemSearch.trim();
  url.searchParams.set("orderType", isSearching ? "all" : receivingOrderType);
  if (!isSearching && (receivingOrderType === "transfer_order" || receivingOrderType === "co_order")) {
    if (receivingSelectedSourceId && !isSearching) url.searchParams.set("sourceLocationId", receivingSelectedSourceId);
    url.searchParams.set("destinationLocationId", locationId);
  } else if (!isSearching && receivingSelectedVendor) {
    url.searchParams.set("vendor", receivingSelectedVendor);
  }
  if (isSearching || receivingOrderType === "purchase_order") url.searchParams.set("destinationLocationId", locationId);
  if (receivingSearch.trim()) url.searchParams.set("search", receivingSearch.trim());
  if (receivingItemSearch.trim()) url.searchParams.set("itemSearch", receivingItemSearch.trim());
  return url.pathname + url.search;
}

async function loadReceivingOrders(options = {}) {
  if (receivingSearch.trim() || receivingItemSearch.trim()) receivingStep = "orders";
  receivingOrders = await api(receivingOrderUrl());
  if (!options.keepSelection) receivingSelectedId = receivingOrders[0]?.netsuite_id || null;
  if (receivingSelectedId && !receivingOrders.some((order) => String(order.netsuite_id) === String(receivingSelectedId))) {
    receivingSelectedId = receivingOrders[0]?.netsuite_id || null;
  }
  receivingSelectedOrder = null;
  if (receivingSelectedId) await loadReceivingDetail(receivingSelectedId, { silentRender: true });
  render();
}

async function loadReceivingDetail(id, options = {}) {
  receivingSelectedId = id;
  const listOrder = receivingOrders.find((order) => String(order.netsuite_id) === String(id));
  const orderType = listOrder?.order_type || receivingOrderType;
  receivingSelectedOrder = await api(`/api/receiving/orders/${encodeURIComponent(id)}?orderType=${encodeURIComponent(orderType)}`);
  if (!options.silentRender) render();
}

async function loadReceivingItemSuggestions() {
  if (receivingItemSearch.trim().length < 2) {
    receivingItemSuggestions = [];
    return;
  }
  const url = new URL("/api/receiving/items", window.location.origin);
  url.searchParams.set("orderType", "all");
  url.searchParams.set("search", receivingItemSearch.trim());
  if (receivingOrderType === "transfer_order" || receivingOrderType === "co_order") {
    url.searchParams.set("destinationLocationId", locationId);
  }
  if (receivingOrderType === "purchase_order") url.searchParams.set("destinationLocationId", locationId);
  receivingItemSuggestions = await api(url.pathname + url.search);
}

async function refreshReceiving() {
  await loadReceivingOptions();
  if (receivingStep === "orders") {
    await loadReceivingOrders({ keepSelection: true });
  } else {
    render();
  }
  showToast("Receiving refreshed from local DB");
}

async function refreshDeliveryOrders() {
  deliveryOrderBuckets.active = null;
  deliveryOrderBuckets.packed = null;
  await loadOrders({ keepSelection: true });
  showToast("Orders refreshed from local DB");
}

async function lookupCustomerPickup() {
  const code = (document.getElementById("customerPickupScan")?.value || customerPickupScan).trim();
  customerPickupScan = code;
  customerPickupMessage = "";
  if (!code) {
    customerPickupMessage = "Scan or enter a sales order number.";
    return render();
  }
  try {
    const order = await api("/api/customer-pickup/lookup", {
      method: "POST",
      body: JSON.stringify({ code, locationId })
    });
    stopPickupScannerCamera();
    const pickupLines = customerPickupVisibleLines(order);
    if (!pickupLines.length) {
      selectedOrder = null;
      selectedId = null;
      selectedLineId = null;
      customerPickupMessage = customerPickupUnavailableMessage(order);
      currentModule = "customer-pickup-scan";
      return render();
    }
    selectedOrder = order;
    selectedId = order.netsuite_id;
    selectedLineId = pickupLines[0]?.id || null;
    linePage = 0;
    currentModule = "customer-pickup";
    render();
  } catch (error) {
    customerPickupMessage = error.message;
    render();
  }
}

async function confirmDiscardCustomerPickupDraft() {
  if (!isCustomerPickupMode() || !selectedId || !hasCustomerPickupDraft()) return true;
  if (!confirm(t("operator.discardPickupDraftConfirm", "All the confirmed lines for this order will be erased. Confirm?"))) return false;
  selectedOrder = await api(`/api/customer-pickup/orders/${selectedId}/clear-draft`, { method: "POST" });
  return true;
}

function stopPickupScannerCamera() {
  window.clearInterval(pickupScanTimer);
  pickupScanTimer = null;
  pickupQrDecoder = null;
  pickupQrFrameBusy = false;
  if (pickupQuaggaActive && window.Quagga) {
    window.Quagga.offDetected(handlePickupBarcodeDetected);
    try {
      window.Quagga.stop();
    } catch {
      // The scanner may already have released the camera after a navigation.
    }
  }
  pickupQuaggaActive = false;
  if (pickupScannerStream) pickupScannerStream.getTracks().forEach((track) => track.stop());
  pickupScannerStream = null;
  pickupScannerActive = false;
  pickupScanCandidate = "";
  pickupScanCandidateHits = 0;
  pickupScanCandidateAt = 0;
}

function pickupCameraCodeText(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = pickupCameraCodeText(entry, depth + 1);
      if (text) return text;
    }
    return "";
  }
  if (typeof value !== "object") return "";

  const candidates = [
    value.data,
    value.rawValue,
    value.text,
    value.value,
    value.code,
    value.content,
    value.codeResult?.code
  ];
  for (const candidate of candidates) {
    if (candidate === value) continue;
    const text = pickupCameraCodeText(candidate, depth + 1);
    if (text) return text;
  }
  return "";
}

function normalizedPickupCameraCode(value) {
  const clean = pickupCameraCodeText(value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (/^\[object\s+object\]$/i.test(clean)) return "";
  const orderRef = clean.match(/SO[A-Z]?\d+/i)?.[0];
  return orderRef ? orderRef.toUpperCase() : clean;
}

function pickupQuaggaOrderCode(result) {
  const results = Array.isArray(result) ? result : [result];
  for (const entry of results) {
    const code = normalizedPickupCameraCode(entry?.codeResult?.code);
    if (/^SO[A-Z]?\d+$/i.test(code)) return code;
  }
  return normalizedPickupCameraCode(result);
}

async function acceptPickupCameraScan(value, { confirmRepeated = false } = {}) {
  const code = normalizedPickupCameraCode(value);
  if (!code || !pickupScannerActive || pickupScanSubmitting) return;

  if (confirmRepeated && !/^SO[A-Z]?\d+$/i.test(code)) {
    const now = Date.now();
    if (code === pickupScanCandidate && now - pickupScanCandidateAt <= 1600) {
      pickupScanCandidateHits += 1;
    } else {
      pickupScanCandidate = code;
      pickupScanCandidateHits = 1;
    }
    pickupScanCandidateAt = now;
    if (pickupScanCandidateHits < 2) return;
  }

  pickupScanSubmitting = true;
  customerPickupScan = code;
  const input = document.getElementById("customerPickupScan");
  if (input) input.value = code;
  stopPickupScannerCamera();
  try {
    await lookupCustomerPickup();
  } finally {
    pickupScanSubmitting = false;
  }
}

function handlePickupBarcodeDetected(result) {
  void acceptPickupCameraScan(pickupQuaggaOrderCode(result), { confirmRepeated: true });
}

async function scanPickupQrFrame() {
  if (!pickupScannerActive || pickupScanSubmitting || pickupQrFrameBusy || !pickupQrDecoder) return;
  const video = document.querySelector("#pickupScannerCamera video");
  if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  pickupQrFrameBusy = true;
  try {
    const result = await pickupQrDecoder.scanImage(video, {
      returnDetailedScanResult: true,
      alsoTryWithoutScanRegion: true
    });
    await acceptPickupCameraScan(result);
  } catch {
    // No QR code in this frame is the normal case; Quagga continues scanning 1D codes.
  } finally {
    pickupQrFrameBusy = false;
  }
}

async function startPickupScannerCamera() {
  stopPickupScannerCamera();
  pickupScanSubmitting = false;
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      customerPickupMessage = "Camera is not available in this browser. Use Zebra scanner or manual input.";
      return render();
    }
    if (!window.Quagga) throw new Error("1D barcode scanner could not load. Refresh the app and try again.");
    pickupScannerActive = true;
    customerPickupMessage = "Starting 1D / QR camera scanner...";
    render();
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    const target = document.getElementById("pickupScannerCamera");
    if (!target) throw new Error("Camera preview is not ready.");

    const quagga = window.Quagga;
    const scannerConstraints = await resolvePickupScannerVideoConstraints();
    await new Promise((resolve, reject) => {
      quagga.init({
        inputStream: {
          name: "Operator barcode camera",
          type: "LiveStream",
          target,
          constraints: scannerConstraints
        },
        frequency: 8,
        numOfWorkers: Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 1)),
        locate: true,
        locator: { patchSize: "medium", halfSample: true },
        decoder: {
          readers: ["code_128_reader", "code_39_reader", "code_93_reader"],
          multiple: false
        }
      }, (error) => error ? reject(error) : resolve());
    });

    quagga.onDetected(handlePickupBarcodeDetected);
    quagga.start();
    pickupQuaggaActive = true;

    const video = target.querySelector("video");
    pickupScannerStream = video?.srcObject || null;
    if (pickupScannerStream) rememberCameraStream(pickupScannerStream);

    try {
      const { default: QrScanner } = await import("/vendor/qr-scanner/qr-scanner.min.js");
      pickupQrDecoder = QrScanner;
      pickupScanTimer = window.setInterval(() => void scanPickupQrFrame(), 650);
    } catch {
      // The 1D scanner remains available if the optional QR fallback cannot load.
    }

    customerPickupMessage = "";
    document.querySelector(".fulfillment-screen .sync-alert")?.remove();
  } catch (error) {
    customerPickupMessage = error.name === "NotAllowedError"
      ? "Camera permission was blocked. Allow camera access, or use Zebra scanner/manual input."
      : error.message || "Camera scanner failed.";
    stopPickupScannerCamera();
    render();
  }
}

async function switchPickupScannerCamera() {
  const wasActive = pickupScannerActive;
  switchCameraFacing();
  if (wasActive) return startPickupScannerCamera();
  render();
}

function pressReceivingKey(key) {
  if (key === "Clear") receivingSearch = "";
  else if (key === "Back") receivingSearch = receivingSearch.slice(0, -1);
  else receivingSearch = `${receivingSearch}${key}`;
  receivingOrderPage = 0;
  if (receivingSearch.trim()) {
    receivingStep = "orders";
    receivingSelectedVendor = "";
    receivingSelectedSourceId = "";
  }
  loadReceivingOrders().catch((error) => showToast(error.message));
}

async function loadDetail(id, options = {}) {
  selectedId = id;
  const order = await api(`/api/delivery/orders/${id}`);
  if (String(selectedId) !== String(id)) return null;
  selectedOrder = order;
  mergeDeliveryOrderIntoState(order);
  const lines = visibleLines(order);
  if (!selectedLineId || !lines.some((line) => String(line.id) === String(selectedLineId))) {
    selectedLineId = lines[0]?.id || null;
  }
  if (!options.silentRender) {
    if (currentModule === "delivery") renderDeliveryPanels();
    else render();
  }
  return order;
}

async function setOrderStatus(status) {
  if (!selectedId) return;
  if (status === "packed" && !canMarkPacked(selectedOrder)) {
    return showToast("Confirm at least one order line before marking Packed.");
  }
  const mutationOrderId = selectedId;
  markLocalDeliveryMutation(mutationOrderId);
  try {
    const result = await api(`/api/delivery/orders/${mutationOrderId}/status`, {
      method: "POST",
      body: JSON.stringify({ status })
    });
    showToast(statusText(status));
    if (status === "packed") {
      applyPackedOrderTransition(result.order);
      const nextOrderId = selectedId;
      if (nextOrderId && !selectedOrder) {
        await loadDetail(nextOrderId, { silentRender: true });
        if (String(selectedId) === String(nextOrderId)) renderDeliveryPanels({ orderPanel: false });
      }
      void primePackedDeliveryOrders({ force: true })
        .then((packedOrders) => {
          deliveryOrderBuckets.packed = upsertDeliveryOrder(packedOrders || [], result.order);
        })
        .catch(() => null);
    } else {
      acceptRefreshedDeliveryOrder(result.order);
    }
  } finally {
    finishLocalDeliveryMutation(mutationOrderId);
  }
}

async function confirmLine(lineId) {
  const row = app.querySelector(`[data-selected-line="${lineId}"]`);
  const line = selectedOrder?.lines?.find((item) => String(item.id) === String(lineId));
  const pallets = row.querySelector('[data-pack="pallets"]')?.value || 0;
  const layers = row.querySelector('[data-pack="layers"]')?.value || 0;
  const pieces = row.querySelector('[data-pack="pieces"]')?.value || 0;
  const salesQty = row.querySelector('[data-pack="sales"]')?.value || 0;
  const body = {
    pallets,
    layers,
    pieces: isIndependentManualLine(line) ? pieces : salesQty || pieces,
    salesQty,
    sections: row.querySelector('[data-pack="sections"]')?.value || 0
  };
  const path = isCustomerPickupMode()
    ? `/api/customer-pickup/orders/${encodeURIComponent(selectedId)}/lines/${encodeURIComponent(lineId)}/confirm`
    : isActiveDraftPackedLine(line)
      ? `/api/delivery/orders/${encodeURIComponent(selectedId)}/lines/${encodeURIComponent(lineId)}/packed-quantity`
    : `/api/delivery/orders/${encodeURIComponent(selectedId)}/lines/${encodeURIComponent(lineId)}/confirm`;
  const mutationOrderId = selectedId;
  if (!isCustomerPickupMode()) markLocalDeliveryMutation(mutationOrderId);
  try {
    const result = await api(path, {
      method: "POST",
      body: JSON.stringify(body)
    });
    showToast("Line confirmed");
    if (isCustomerPickupMode()) {
      selectedOrder = await api(`/api/delivery/orders/${selectedId}`);
      return render();
    }
    if (!acceptRefreshedDeliveryOrder(result.order)) await loadDetail(selectedId);
  } finally {
    if (!isCustomerPickupMode()) finishLocalDeliveryMutation(mutationOrderId);
  }
}

function confirmPayloadForLine(line) {
  const row = app.querySelector(`[data-selected-line="${line.id}"]`);
  const fieldValue = (unit) => row?.querySelector(`[data-pack="${unit}"]`)?.value;
  const value = (unit) => fieldValue(unit) ?? panelValue(line, unit);
  const pieces = fieldValue("pieces") ?? panelValue(line, "pieces");
  const salesQty = fieldValue("sales") ?? (isIndependentManualLine(line) || shouldUseSalesQuantity(line) ? panelValue(line, "sales") : 0);
  return {
    pallets: value("pallets") || 0,
    layers: value("layers") || 0,
    pieces: isIndependentManualLine(line) ? pieces || 0 : salesQty || pieces || 0,
    salesQty: salesQty || 0,
    sections: value("sections") || 0
  };
}

function confirmPayloadHasQty(body) {
  return qty(body.pallets) > 0 || qty(body.layers) > 0 || qty(body.pieces) > 0 || qty(body.sections) > 0 || qty(body.salesQty) > 0;
}

async function confirmPage() {
  if (!selectedOrder || currentModule !== "delivery" || viewMode === "packed") return;
  if (!selectedId) return showToast("Select an order before confirming the page.");
  const pageLines = currentDetailPageLines(selectedOrder).filter((line) => !exceptionText(line));
  const lines = [];
  const packedLines = [];
  for (const line of pageLines) {
    const body = confirmPayloadForLine(line);
    if (!confirmPayloadHasQty(body)) continue;
    const payload = { lineId: line.id, values: body, label: line.sku || line.item_name || line.id };
    if (isActiveDraftPackedLine(line)) packedLines.push(payload);
    else lines.push(payload);
  }
  const mutationOrderId = selectedId;
  markLocalDeliveryMutation(mutationOrderId);
  let confirmedCount = 0;
  const failures = [];
  let refreshedOrder = null;
  try {
    if (lines.length) {
      try {
        const result = await api(`/api/delivery/orders/${encodeURIComponent(selectedId)}/lines/confirm-page`, {
          method: "POST",
          body: JSON.stringify({ lines })
        });
        confirmedCount += Number(result.confirmed || 0);
        refreshedOrder = result.order || refreshedOrder;
        for (const failure of result.failures || []) failures.push(`${failure.lineId}: ${failure.error}`);
      } catch (error) {
        failures.push(error.message);
      }
    }
    for (const line of packedLines) {
      try {
        const result = await api(`/api/delivery/orders/${encodeURIComponent(selectedId)}/lines/${encodeURIComponent(line.lineId)}/packed-quantity`, {
          method: "POST",
          body: JSON.stringify(line.values)
        });
        refreshedOrder = result.order || refreshedOrder;
        confirmedCount += 1;
      } catch (error) {
        failures.push(`${line.label}: ${error.message}`);
      }
    }
    if (failures.length) {
      showToast(confirmedCount ? `${confirmedCount} confirmed, ${failures.length} failed` : failures[0]);
    } else {
      showToast(confirmedCount ? `${confirmedCount} line confirmed` : "No visible line quantity to confirm");
    }
    if (!acceptRefreshedDeliveryOrder(refreshedOrder)) await loadDetail(selectedId);
  } finally {
    finishLocalDeliveryMutation(mutationOrderId);
  }
}

async function unpackLine(lineId) {
  const line = selectedOrder?.lines?.find((item) => String(item.id) === String(lineId));
  if (!line) return;
  const mutationOrderId = selectedId;
  markLocalDeliveryMutation(mutationOrderId);
  try {
    const result = await api(`/api/delivery/orders/${mutationOrderId}/lines/${lineId}/unpack`, {
      method: "POST",
      body: JSON.stringify({
        pallets: packedValue(line, "pallets"),
        layers: packedValue(line, "layers"),
        pieces: packedValue(line, "pieces") || packedValue(line, "sales"),
        sections: packedValue(line, "sections")
      })
    });
    acceptRefreshedDeliveryOrder(result.order);
    showToast("Line unpacked");
    deliveryOrderBuckets.active = null;
    deliveryOrderBuckets.packed = null;
    await reloadDeliveryScreen({ keepSelection: true });
  } finally {
    finishLocalDeliveryMutation(mutationOrderId);
  }
}

async function updatePackedLine(lineId) {
  const row = app.querySelector(`[data-selected-line="${lineId}"]`);
  const line = selectedOrder?.lines?.find((item) => String(item.id) === String(lineId));
  const salesQty = row.querySelector('[data-pack="sales"]')?.value || 0;
  const body = {
    pallets: row.querySelector('[data-pack="pallets"]')?.value || 0,
    layers: row.querySelector('[data-pack="layers"]')?.value || 0,
    pieces: isIndependentManualLine(line) ? row.querySelector('[data-pack="pieces"]')?.value || 0 : salesQty || row.querySelector('[data-pack="pieces"]')?.value || 0,
    salesQty,
    sections: row.querySelector('[data-pack="sections"]')?.value || 0
  };
  const mutationOrderId = selectedId;
  markLocalDeliveryMutation(mutationOrderId);
  try {
    const result = await api(`/api/delivery/orders/${mutationOrderId}/lines/${lineId}/packed-quantity`, {
      method: "POST",
      body: JSON.stringify(body)
    });
    acceptRefreshedDeliveryOrder(result.order);
    showToast("Packed qty updated");
  } finally {
    finishLocalDeliveryMutation(mutationOrderId);
  }
}

async function unpackOrder() {
  if (!selectedId) return;
  const mutationOrderId = selectedId;
  markLocalDeliveryMutation(mutationOrderId);
  try {
    const result = await api(`/api/delivery/orders/${mutationOrderId}/unpack`, { method: "POST" });
    acceptRefreshedDeliveryOrder(result.order, { renderPanels: false });
    showToast("Order unpacked");
    viewMode = "active";
    deliveryOrderBuckets.active = null;
    deliveryOrderBuckets.packed = null;
    await reloadDeliveryScreen({ keepSelection: true });
  } finally {
    finishLocalDeliveryMutation(mutationOrderId);
  }
}

async function releaseCurrentDraft(orderId) {
  const draft = currentDraftLock();
  const targetOrderId = orderId || draft?.orderId;
  if (!targetOrderId) return showToast("No preparing order lock found.");
  const label = draft?.tranid || targetOrderId;
  if (!confirm(tf("operator.releaseDraftConfirm", "Release {order}? This will erase confirmed draft lines for this order only. Loaded quantities will not change.", { order: label }))) return;
  const result = await api(`/api/delivery/orders/${targetOrderId}/release-draft`, { method: "POST" });
  activeDeliveryDraft = null;
  if (String(selectedId || "") === String(targetOrderId)) {
    selectedOrder = result.order || await api(`/api/delivery/orders/${targetOrderId}`).catch(() => null);
  }
  showToast(`${label} released`);
  if (currentModule === "delivery") {
    viewMode = "active";
    await loadOrders({ keepSelection: true });
  } else {
    await loadCurrentDeliveryDraft();
    render();
  }
}

async function startFulfillment() {
  if (!selectedOrder) return;
  fulfillmentOrder = selectedOrder;
  fulfillmentReturnModule = currentModule;
  fulfillmentPhotoDataUrls = [];
  fulfillmentActivePhotoSlot = 0;
  fulfillmentResult = null;
  fulfillmentSubmitting = false;
  fulfillmentStatusText = "";
  fulfillmentJobStage = "";
  fulfillmentStartedAt = 0;
  fulfillmentValidation = null;
  selectRearCamera();
  currentModule = isCustomerPickupMode() ? "customer-pickup-load" : "delivery-fulfill";
  render();
}

function stopFulfillmentCamera() {
  if (fulfillmentCameraStream) {
    fulfillmentCameraStream.getTracks().forEach((track) => track.stop());
  }
  fulfillmentCameraStream = null;
  fulfillmentCameraActive = false;
}

function attachFulfillmentCamera() {
  const video = document.getElementById("fulfillmentCamera");
  if (!video || !fulfillmentCameraStream) return;
  video.srcObject = fulfillmentCameraStream;
  video.play().catch(() => {});
}

async function startFulfillmentCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast(t("operator.cameraUnavailable", "Camera is not available in this browser."));
    return;
  }
  stopFulfillmentCamera();
  try {
    fulfillmentCameraStream = await openCameraStream();
    fulfillmentCameraActive = true;
    render();
  } catch (error) {
    stopFulfillmentCamera();
    showToast(cameraErrorMessage(error));
    render();
  }
}

async function switchFulfillmentCamera() {
  const wasActive = fulfillmentCameraActive;
  switchCameraFacing();
  if (wasActive) return startFulfillmentCamera();
  render();
}

async function captureCameraPhotoDataUrl(stream, video) {
  const track = stream?.getVideoTracks?.()[0];
  if (track && typeof window.ImageCapture === "function") {
    try {
      const imageCapture = new window.ImageCapture(track);
      let photoSettings;
      try {
        const capabilities = await imageCapture.getPhotoCapabilities?.();
        const imageWidth = Number(capabilities?.imageWidth?.max);
        const imageHeight = Number(capabilities?.imageHeight?.max);
        if ((Number.isFinite(imageWidth) && imageWidth > 0) || (Number.isFinite(imageHeight) && imageHeight > 0)) {
          photoSettings = {};
          if (Number.isFinite(imageWidth) && imageWidth > 0) photoSettings.imageWidth = imageWidth;
          if (Number.isFinite(imageHeight) && imageHeight > 0) photoSettings.imageHeight = imageHeight;
        }
      } catch {
        photoSettings = undefined;
      }
      let blob;
      try {
        blob = await imageCapture.takePhoto(photoSettings);
      } catch (error) {
        if (!photoSettings) throw error;
        blob = await imageCapture.takePhoto();
      }
      if (blob?.size) return readPhotoFile(blob);
    } catch {
      // Fall back to the maximum-resolution frame supplied by the video track.
    }
  }
  if (!video?.videoWidth || !video?.videoHeight) throw new Error(t("operator.cameraPreviewNotReady", "Camera preview is not ready yet."));
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Camera photo capture is not available in this browser.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", OPERATOR_CAMERA_JPEG_QUALITY);
}

function nextPhotoSlot(photoDataUrls, currentSlot, minimumSlots) {
  const slotCount = Math.max(minimumSlots, photoDataUrls.length);
  for (let offset = 1; offset < slotCount; offset += 1) {
    const candidate = (currentSlot + offset) % slotCount;
    if (!photoDataUrls[candidate]) return candidate;
  }
  return currentSlot;
}

async function captureFulfillmentPhoto() {
  const video = document.getElementById("fulfillmentCamera");
  if (!video || !video.videoWidth || !video.videoHeight) {
    showToast(t("operator.cameraPreviewNotReady", "Camera preview is not ready yet."));
    return;
  }
  try {
    fulfillmentPhotoDataUrls[fulfillmentActivePhotoSlot] = await captureCameraPhotoDataUrl(fulfillmentCameraStream, video);
    fulfillmentActivePhotoSlot = nextPhotoSlot(fulfillmentPhotoDataUrls, fulfillmentActivePhotoSlot, 2);
    render();
  } catch (error) {
    showToast(error.message || t("operator.photoCaptureFailed", "Photo capture failed."));
  }
}

function readPhotoFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function confirmFulfillment() {
  if (!fulfillmentOrder || fulfillmentPhotoDataUrls.filter(Boolean).length < 2 || fulfillmentSubmitting) return;
  stopFulfillmentCamera();
  fulfillmentSubmitting = true;
  fulfillmentStartedAt = Date.now();
  fulfillmentJobStage = "Saving proof";
  fulfillmentStatusText = "Saving photo proof and local loaded status...";
  fulfillmentValidation = null;
  window.clearInterval(fulfillmentProgressTimer);
  fulfillmentProgressTimer = window.setInterval(() => {
    if (fulfillmentSubmitting) render();
  }, 1000);
  render();
  try {
    fulfillmentStatusText = "Uploading photo proof to R2...";
    render();
    const uploadedPhotoRefs = await uploadOperatorPhotos(fulfillmentPhotoDataUrls.filter(Boolean), {
      recordType: currentModule === "customer-pickup-load" ? "operator-customer-pickup-photo" : "operator-load-photo",
      orderType: fulfillmentOrder.order_type || deliveryOrderType,
      orderId: fulfillmentOrder.netsuite_id,
      orderRef: fulfillmentOrder.tranid
    });
    const path = currentModule === "customer-pickup-load"
      ? `/api/customer-pickup/orders/${fulfillmentOrder.netsuite_id}/load`
      : `/api/delivery/orders/${fulfillmentOrder.netsuite_id}/load`;
    fulfillmentStatusText = "Saving local loaded status...";
    fulfillmentResult = await api(path, {
      method: "POST",
      body: JSON.stringify({ photoDataUrls: uploadedPhotoRefs, locationId })
    });
    showToast("Order loaded");
  } catch (error) {
    fulfillmentJobStage = "Load failed";
    fulfillmentValidation = error.payload?.validation || null;
    fulfillmentStatusText = fulfillmentValidation
      ? "Correct the listed packed lines before loading."
      : error.message;
    showToast(error.message);
  } finally {
    window.clearInterval(fulfillmentProgressTimer);
    fulfillmentProgressTimer = null;
    fulfillmentSubmitting = false;
    render();
  }
}

async function pollFulfillmentJob(jobId) {
  if (!jobId) throw new Error("Fulfillment job was not started.");
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const job = await api(`/api/delivery/fulfillment-jobs/${jobId}`);
    if (job.status === "complete") return job.result;
    if (job.status === "error") throw new Error(job.error || "NetSuite fulfillment failed.");
    fulfillmentJobStage = job.stage || "Posting";
    fulfillmentStatusText = job.message || tf("operator.stillPosting", "Still posting... {seconds}s", { seconds: attempt + 1 });
    render();
  }
  throw new Error("NetSuite fulfillment is still running. Please check Delivery Fulfillment in control panel.");
}

async function finishFulfillment() {
  stopFulfillmentCamera();
  const wasPickup = fulfillmentOrder && currentModule === "customer-pickup-load";
  const returnModule = fulfillmentReturnModule || "delivery";
  currentModule = wasPickup ? "customer-pickup-scan" : returnModule;
  fulfillmentOrder = null;
  fulfillmentPhotoDataUrls = [];
  fulfillmentActivePhotoSlot = 0;
  fulfillmentResult = null;
  fulfillmentStatusText = "";
  fulfillmentJobStage = "";
  fulfillmentValidation = null;
  fulfillmentStartedAt = 0;
  fulfillmentReturnModule = "delivery";
  viewMode = "active";
  if (wasPickup) {
    selectedId = null;
    selectedOrder = null;
    customerPickupScan = "";
    return render();
  }
  await reloadDeliveryScreen();
}

function renderReceiptScreen() {
  const order = receiptOrder || receivingSelectedOrder;
  if (!order) {
    currentModule = "receiving";
    return render();
  }
  const confirmedLines = (order.lines || []).filter((line) => hasReceivedQty(line));
  if (receiptResult) {
    const isLocalCo = (receiptOrder?.order_type || receivingOrderType) === "co_order";
    return shell(t("operator.receivingComplete", "Receiving Complete"), `${t("common.order", "Order")} ${order.tranid}`, `
      <section class="fulfillment-screen">
        <div class="fulfillment-card success">
          <span>${isLocalCo ? t("operator.localCoReceived", "Local CO Received") : t("operator.itemReceipt", "Item Receipt")}</span>
          <strong>${receiptResult.itemReceiptTranid || receiptResult.itemReceiptId || t("common.created", "Created")}</strong>
          <p>${isLocalCo ? t("operator.coReadyForLoading", "CO is now available in Delivery Prep packed orders for loading.") : t("operator.receivingPosted", "Receiving posted to NetSuite.")}</p>
        </div>
        <div class="selected-actions">
          <button class="primary-button" data-action="finish-receive" type="button">${t("operator.backToReceiving", "Back to Receiving")}</button>
        </div>
      </section>
    `, `<button class="secondary-button" data-action="finish-receive" type="button">${t("operator.receiving", "Receiving")}</button>`);
  }
  return shell(t("operator.receiveOrder", "Receive Order"), `${order.tranid} | ${t("common.location", "Location")} ${currentLocation()?.text || ""}`, `
    <section class="fulfillment-screen">
      <div class="fulfillment-card">
        <span>${t("operator.photoProof", "Photo proof")}</span>
        <strong>${t("operator.truckPhotos", "Truck photos")}</strong>
        <div class="camera-actions">
          ${receiptCameraActive
            ? `<button class="secondary-button" data-action="stop-receipt-camera" type="button">${t("common.closeCamera", "Close camera")}</button>`
            : `<button class="primary-button" data-action="start-receipt-camera" type="button">${t("common.openCamera", "Open camera")}</button>`}
          ${renderCameraSwitchButton("switch-receipt-camera")}
        </div>
        <div class="photo-slot-row">
          ${Array.from({ length: Math.max(2, receiptPhotoDataUrls.length) }, (_, slot) => `
            <button class="${receiptActivePhotoSlot === slot ? "active" : ""}" data-action="select-receipt-photo-slot" data-slot="${slot}" type="button">
              <strong>${t("common.photos", "Photo")} ${slot + 1}</strong>
              <span>${receiptPhotoDataUrls[slot] ? t("common.ready", "Ready") : slot < 2 ? t("common.needed", "Needed") : t("common.optional", "Optional")}</span>
            </button>
          `).join("")}
        </div>
        <div class="photo-list-actions">
          <button class="secondary-button" data-action="add-receipt-photo" type="button">${t("common.addAnotherPhoto", "Add another photo")}</button>
          ${Math.max(2, receiptPhotoDataUrls.length) > 2 ? `<button class="secondary-button danger-button" data-action="remove-receipt-photo" data-slot="${receiptActivePhotoSlot}" ${receiptActivePhotoSlot < 2 ? "disabled" : ""} type="button">${t("common.removeSelected", "Remove selected")}</button>` : ""}
        </div>
        ${receiptCameraActive ? `
          <video class="camera-preview ${cameraCaptureMode() === "user" ? "mirrored" : ""}" id="receiptCamera" autoplay muted playsinline></video>
          <button class="primary-button" data-action="capture-receipt-photo" type="button">${t("operator.capturePhoto", "Capture photo")} ${receiptActivePhotoSlot + 1}</button>
        ` : receiptPhotoDataUrls[receiptActivePhotoSlot] ? `<img class="photo-preview" src="${receiptPhotoDataUrls[receiptActivePhotoSlot]}" alt="Receiving proof" />` : `<div class="photo-placeholder">${t("operator.receivePhotoHelp", "Take 2 truck photos before receiving.")}</div>`}
      </div>
      <div class="fulfillment-card">
        <span>${t("operator.confirmedQtyToReceive", "Confirmed qty to receive")}</span>
        <strong>${tf("operator.lineCount", "{count} line(s)", { count: confirmedLines.length })}</strong>
        <div class="fulfillment-lines">
          ${confirmedLines.map((line) => `
            <div>
              <b>${line.sku || line.item_name}</b>
              <span>${shouldUseSalesQuantity(line)
                ? `${displayQty(line.received_sales_qty)} ${salesQuantityLabel(line)}`
                : `${displayQty(line.received_pallet_qty)} PLT / ${displayQty(line.received_section_qty)} SEC / ${displayQty(line.received_layer_qty)} LYR / ${displayQty(line.received_piece_qty)} PCS`}</span>
            </div>
          `).join("") || `<p class="muted">${t("operator.noConfirmedQty", "No confirmed qty.")}</p>`}
        </div>
      </div>
      <div class="selected-actions">
        ${receiptSubmitting ? `<div class="sync-alert"><strong>${localizeMessage(receiptJobStage || t("operator.recordingLocally", "Recording locally"))}</strong><span>${localizeMessage(receiptStatusText || t("operator.savingReceivingRecord", "Saving receiving record..."))}${receiptStartedAt ? ` (${Math.max(1, Math.round((Date.now() - receiptStartedAt) / 1000))}s)` : ""}</span></div>` : ""}
        ${!receiptSubmitting && receiptJobStage === "Receiving failed" ? `<div class="sync-alert danger"><strong>${t("operator.receivingFailed", "Receiving failed")}</strong><span>${escapeHtml(localizeMessage(receiptStatusText))}</span></div>` : ""}
        <button class="primary-button" data-action="confirm-receive" ${receiptPhotoDataUrls.filter(Boolean).length >= 2 && !receiptSubmitting ? "" : "disabled"} type="button">${receiptSubmitting ? t("operator.receivingProgress", "Receiving...") : t("operator.receive", "Receive")}</button>
      </div>
    </section>
  `, `
    <button class="secondary-button" data-action="cancel-receive" type="button">${t("common.back", "Back")}</button>
    <button class="secondary-button" data-action="logout" type="button">${operator.display_name}</button>
  `);
}

async function confirmReceivingLine(lineId) {
  const row = app.querySelector(`[data-receiving-selected-line="${lineId}"]`);
  if (!row || !receivingSelectedId) return;
  const line = receivingSelectedOrder?.lines?.find((item) => String(item.id) === String(lineId));
  const salesQty = row.querySelector('[data-pack="sales"]')?.value || 0;
  const body = {
    pallets: row.querySelector('[data-pack="pallets"]')?.value || 0,
    layers: row.querySelector('[data-pack="layers"]')?.value || 0,
    pieces: isIndependentManualLine(line) ? row.querySelector('[data-pack="pieces"]')?.value || 0 : salesQty || row.querySelector('[data-pack="pieces"]')?.value || 0,
    salesQty,
    sections: row.querySelector('[data-pack="sections"]')?.value || 0,
    orderType: receivingSelectedOrder?.order_type || receivingOrderType
  };
  receivingSelectedOrder = await api(`/api/receiving/orders/${receivingSelectedId}/lines/${lineId}/confirm`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  showToast("Receiving line confirmed");
  render();
}

async function unconfirmReceivingLine(lineId) {
  if (!receivingSelectedId) return;
  receivingSelectedOrder = await api(`/api/receiving/orders/${receivingSelectedId}/lines/${lineId}/unconfirm`, {
    method: "POST",
    body: JSON.stringify({
      orderType: receivingSelectedOrder?.order_type || receivingOrderType
    })
  });
  showToast(t("operator.receivingLineUnconfirmed", "Receiving line unconfirmed"));
  render();
}

function startReceipt() {
  if (!receivingSelectedOrder) return;
  receiptOrder = receivingSelectedOrder;
  receiptPhotoDataUrls = [];
  receiptActivePhotoSlot = 0;
  receiptSubmitting = false;
  receiptResult = null;
  receiptStatusText = "";
  receiptJobStage = "";
  receiptStartedAt = 0;
  selectRearCamera();
  currentModule = "receiving-receipt";
  render();
}

function stopReceiptCamera() {
  if (receiptCameraStream) receiptCameraStream.getTracks().forEach((track) => track.stop());
  receiptCameraStream = null;
  receiptCameraActive = false;
}

function attachReceiptCamera() {
  const video = document.getElementById("receiptCamera");
  if (!video || !receiptCameraStream) return;
  video.srcObject = receiptCameraStream;
  video.play().catch(() => {});
}

async function startReceiptCamera() {
  if (!navigator.mediaDevices?.getUserMedia) return showToast(t("operator.cameraUnavailable", "Camera is not available in this browser."));
  stopReceiptCamera();
  try {
    receiptCameraStream = await openCameraStream();
    receiptCameraActive = true;
    render();
  } catch (error) {
    stopReceiptCamera();
    showToast(cameraErrorMessage(error));
    render();
  }
}

async function switchReceiptCamera() {
  const wasActive = receiptCameraActive;
  switchCameraFacing();
  if (wasActive) return startReceiptCamera();
  render();
}

async function captureReceiptPhoto() {
  const video = document.getElementById("receiptCamera");
  if (!video || !video.videoWidth || !video.videoHeight) return showToast(t("operator.cameraPreviewNotReady", "Camera preview is not ready yet."));
  try {
    receiptPhotoDataUrls[receiptActivePhotoSlot] = await captureCameraPhotoDataUrl(receiptCameraStream, video);
    receiptActivePhotoSlot = nextPhotoSlot(receiptPhotoDataUrls, receiptActivePhotoSlot, 2);
    render();
  } catch (error) {
    showToast(error.message || t("operator.photoCaptureFailed", "Photo capture failed."));
  }
}

async function confirmReceipt() {
  if (!receiptOrder || receiptPhotoDataUrls.filter(Boolean).length < 2 || receiptSubmitting) return;
  stopReceiptCamera();
  receiptSubmitting = true;
  receiptStartedAt = Date.now();
  receiptJobStage = "Uploading proof";
  receiptStatusText = "Uploading receiving proof to server...";
  window.clearInterval(receiptProgressTimer);
  receiptProgressTimer = window.setInterval(() => {
    if (receiptSubmitting) render();
  }, 1000);
  render();
  try {
    receiptStatusText = "Uploading receiving photos to R2...";
    render();
    const uploadedPhotoRefs = await uploadOperatorPhotos(receiptPhotoDataUrls.filter(Boolean), {
      recordType: (receiptOrder.order_type || receivingOrderType) === "co_order" ? "operator-co-receiving-photo" : "operator-receiving-photo",
      orderType: receiptOrder.order_type || receivingOrderType,
      orderId: receiptOrder.netsuite_id,
      orderRef: receiptOrder.tranid
    });
    const started = await api(`/api/receiving/orders/${receiptOrder.netsuite_id}/receive`, {
      method: "POST",
      body: JSON.stringify({
        photoDataUrls: uploadedPhotoRefs,
        locationId,
        destinationLocationId: locationId,
        orderType: receiptOrder.order_type || receivingOrderType,
        sourceLocationId: receiptOrder.source_location_id || receivingSelectedSourceId || null
      })
    });
    if (started.status === "complete" && started.result) {
      receiptResult = started.result;
      showToast((receiptOrder.order_type || receivingOrderType) === "co_order" ? "CO received and moved to packed list" : "Receiving recorded locally");
      return;
    }
    receiptJobStage = "Queued";
    receiptStatusText = "Waiting for local receiving record...";
    render();
    receiptResult = await pollReceiptJob(started.jobId);
    showToast("Receiving recorded locally");
  } catch (error) {
    receiptJobStage = "Receiving failed";
    receiptStatusText = error.message;
    showToast(error.message);
  } finally {
    window.clearInterval(receiptProgressTimer);
    receiptProgressTimer = null;
    receiptSubmitting = false;
    render();
  }
}

async function pollReceiptJob(jobId) {
  if (!jobId) throw new Error("Receiving job was not started.");
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const job = await api(`/api/receiving/receipt-jobs/${jobId}`);
    if (job.status === "complete") return job.result;
    if (job.status === "error") throw new Error(job.error || "Receiving failed.");
    receiptJobStage = job.stage || "Recording";
    receiptStatusText = job.message || tf("operator.stillRecording", "Still recording... {seconds}s", { seconds: attempt + 1 });
    render();
  }
  throw new Error("Receiving record is still running. Please check control panel.");
}

async function finishReceipt() {
  stopReceiptCamera();
  const wasLocalCo = (receiptOrder?.order_type || receivingOrderType) === "co_order";
  currentModule = "receiving";
  receiptOrder = null;
  receiptPhotoDataUrls = [];
  receiptResult = null;
  receiptStatusText = "";
  receiptJobStage = "";
  receiptStartedAt = 0;
  if (wasLocalCo) {
    currentModule = "delivery";
    deliveryOrderType = "transfer_order";
    localStorage.setItem("mbbs.operator.deliveryOrderType", deliveryOrderType);
    viewMode = "packed";
    selectedId = null;
    return loadOrders();
  }
  await loadReceivingOrders({ keepSelection: false });
}

async function loadPersonalHistory() {
  const params = new URLSearchParams({ limit: "100" });
  if (personalHistoryDate) params.set("date", personalHistoryDate);
  personalHistory = await api(`/api/operator/history?${params.toString()}`);
  historyPage = Math.min(historyPage, pageCount(personalHistory, HISTORY_PAGE_SIZE) - 1);
  if (!personalHistory.some((item) => item.id === selectedHistoryId)) {
    selectedHistoryId = personalHistory[0]?.id || "";
    historyPage = 0;
  }
  render();
}

function historyTypeLabel(type) {
  return {
    confirm_line: t("operator.confirmLineHistory", "Confirm Line"),
    item_receipt: "IR",
    item_fulfillment: "IF",
    cycle_count: t("operator.cycleHistory", "Cycle"),
    customer_return: t("operator.customerReturnHistory", "Customer Return")
  }[type] || type || t("operator.recordHistory", "Record");
}

function renderHistoryPhotos(record) {
  const photos = (record?.photos || []).filter(Boolean);
  if (!photos.length) return "";
  return `
    <div class="history-photo-grid">
      ${photos.map((photo, index) => `
        <button class="history-photo-button" data-action="open-history-photo" data-photo-ref="${escapeHtml(photo)}" data-photo-label="${tf("operator.recordPhotoNumber", "Record photo {number}", { number: index + 1 })}" type="button">
          <img src="${photoImgSrc(photo)}" alt="${tf("operator.recordPhotoNumber", "Record photo {number}", { number: index + 1 })}" />
        </button>
      `).join("")}
    </div>
  `;
}

function historyLineUnits(line) {
  const unitDefs = [
    { label: "PLT", key: line.countedPallets !== undefined ? "countedPallets" : "pallets" },
    { label: "LYR", key: line.countedLayers !== undefined ? "countedLayers" : "layers" },
    { label: "SEC", key: line.countedSections !== undefined ? "countedSections" : "sections" },
    { label: "PCS", key: line.countedPieces !== undefined ? "countedPieces" : "pieces" }
  ];
  const units = unitDefs
    .filter((unit) => qty(line?.[unit.key]) !== 0)
    .map((unit) => ({ ...unit, value: displayQty(line?.[unit.key]) }));
  const salesKey = line.countedTotal !== undefined ? "countedTotal" : "salesQuantity";
  units.push({ label: t("operator.salesUnit", "Sales"), key: salesKey, value: displayQty(line?.[salesKey]) });
  return units;
}

function renderHistoryLineDetails(record) {
  const lines = record?.details?.lines || [];
  if (!lines.length) return "";
  return `
    <div class="history-lines-table">
      ${lines.map((line) => {
        const units = historyLineUnits(line);
        return `
        <div style="--history-unit-count: ${Math.max(units.length, 1)}">
          <div class="history-line-name">
            <strong>${escapeHtml(line.itemName || "")}</strong>
            ${line.description ? `<span>${escapeHtml(line.description)}</span>` : ""}
          </div>
          ${units.map((unit) => `<span>${unit.label} ${unit.value}</span>`).join("")}
        </div>
      `;
      }).join("")}
    </div>
  `;
}

function renderHistoryDetail(record) {
  if (!record) {
    return `<div class="empty-state small"><strong>${t("operator.selectRecord", "Select a record")}</strong><span>${t("operator.selectRecordHelp", "Tap one history record to view details.")}</span></div>`;
  }
  return `
    <div class="history-detail-card">
      <div class="detail-header">
        <div>
          <h2>${escapeHtml(record.tranid || record.reference || historyTypeLabel(record.type))}</h2>
          <p>${escapeHtml(historyTypeLabel(record.type))} | ${formatDateTime(record.createdAt)}</p>
        </div>
        ${record.status ? `<span class="status-pill open">${escapeHtml(localizeMessage(record.status))}</span>` : ""}
      </div>
      <div class="progress-strip history-meta">
        <div><span>${t("operator.reference", "Reference")}</span><strong>${escapeHtml(record.reference || "-")}</strong></div>
        <div><span>${t("operator.action", "Action")}</span><strong>${escapeHtml(localizeMessage(record.action || "-"))}</strong></div>
        <div><span>${t("common.order", "Order")}</span><strong>${escapeHtml(record.orderId || "-")}</strong></div>
      </div>
      ${renderHistoryPhotos(record)}
      ${renderHistoryLineDetails(record)}
      <div class="history-report-box">
        <strong>${t("operator.reportProblem", "Report record problem")}</strong>
        <textarea id="historyReportReason" placeholder="${t("operator.reportProblemHelp", "Describe what is wrong for supervisor review.")}">${escapeHtml(historyReportReason)}</textarea>
        <button class="danger-button" data-action="report-history-error" data-record="${record.id}" type="button">${t("operator.reportError", "Report Error")}</button>
      </div>
    </div>
  `;
}

function renderPersonalHistory() {
  const selected = personalHistory.find((item) => item.id === selectedHistoryId) || null;
  const visibleHistory = pageItems(personalHistory, historyPage, HISTORY_PAGE_SIZE);
  shell("Personal History", operator?.display_name || "", `
    <section class="history-shell">
      <div class="history-toolbar">
        <label>
          <span>${t("operator.date", "Date")}</span>
          <input id="historyDate" type="date" value="${escapeHtml(personalHistoryDate)}" />
        </label>
      </div>
      <div class="history-work-area">
        <div class="history-list-column">
          <div class="fulfillment-lines history-list">
            ${visibleHistory.map((item) => `
              <button class="history-record ${item.id === selectedHistoryId ? "active" : ""}" data-action="select-history" data-record="${item.id}" type="button">
                <span>${historyTypeLabel(item.type)}</span>
                <b>${escapeHtml(item.tranid || item.orderId || item.type)}</b>
                <em>${formatDateTime(item.createdAt)}</em>
                ${item.reference ? `<strong>${escapeHtml(item.reference)}</strong>` : ""}
                ${item.status ? `<i>${escapeHtml(item.status)}</i>` : ""}
              </button>
            `).join("") || `<div class="empty-state small"><strong>${t("operator.noHistory", "No history")}</strong><span>${t("operator.noHistoryHelp", "No operator records for this date.")}</span></div>`}
          </div>
          <div class="pagination-row">
            <button class="secondary-button" data-action="history-prev" ${historyPage <= 0 ? "disabled" : ""} type="button">${t("common.back", "Back")}</button>
            <strong>${personalHistory.length ? `${historyPage + 1} / ${pageCount(personalHistory, HISTORY_PAGE_SIZE)}` : "0 / 0"}</strong>
            <button class="secondary-button" data-action="history-next" ${historyPage >= pageCount(personalHistory, HISTORY_PAGE_SIZE) - 1 ? "disabled" : ""} type="button">${t("common.next", "Next")}</button>
          </div>
        </div>
        <div class="history-detail">
          ${renderHistoryDetail(selected)}
        </div>
      </div>
    </section>
  `, `
    <button class="secondary-button" data-action="main-menu" type="button">${t("common.menu", "Menu")}</button>
    <button class="primary-button" data-action="refresh-history" type="button">${t("common.refresh", "Refresh")}</button>
    <button class="secondary-button" data-action="logout" type="button">${operator.display_name}</button>
  `);
}

async function openModule(moduleName) {
  if (moduleName === "customer-pickup") {
    selectRearCamera();
    currentModule = "customer-pickup-scan";
    customerPickupScan = "";
    customerPickupMessage = "";
    selectedId = null;
    selectedOrder = null;
    selectedLineId = null;
    linePage = 0;
    return render();
  }
  if (moduleName === "delivery") {
    currentModule = "delivery-select";
    return render();
  }
  if (moduleName === "personal-history") {
    currentModule = "personal-history";
    personalHistory = [];
    return loadPersonalHistory();
  }
  if (moduleName === "return") {
    currentModule = "return-select";
    return render();
  }
  if (moduleName === "receiving") {
    currentModule = "receiving";
    receivingStep = "type";
    receivingOrderType = "purchase_order";
    receivingSelectedVendor = "";
    receivingSelectedSourceId = "";
    receivingSearch = "";
    receivingItemSearch = "";
    receivingItemSuggestions = [];
    receivingOrders = [];
    receivingSelectedOrder = null;
    receivingSelectedId = null;
    receivingOrderPage = 0;
    await loadReceivingOptions().catch(() => {});
    return render();
  }
  if (moduleName === "delivery-run") {
    currentModule = "delivery";
    viewMode = "active";
    orderPage = 0;
    selectedId = null;
    return loadOrders();
  }
  if (moduleName === "cycle-count") {
    currentModule = "cycle-count";
    cycleStep = "type";
    cycleSelection = { productType: "", brand: "", series: "" };
    cycleSearch = "";
    selectedInventoryItem = null;
    activeCycleUnit = "";
    cycleValues = {};
    cyclePage = 0;
    await loadCycleData();
    return render();
  }
  showToast(t("operator.moduleComingSoon", "This module is next."));
}

async function loadCycleData() {
  const facetUrl = new URL("/api/inventory/facets", window.location.origin);
  facetUrl.searchParams.set("locationId", locationId);
  if (cycleSelection.productType) facetUrl.searchParams.set("productType", cycleSelection.productType);
  if (cycleSelection.brand) facetUrl.searchParams.set("brand", cycleSelection.brand);
  cycleFacets = await api(facetUrl.pathname + facetUrl.search);

  const shouldLoadItems = cycleSearch.trim() || cycleStep === "sku";
  if (shouldLoadItems) {
    const itemUrl = new URL("/api/inventory/items", window.location.origin);
    itemUrl.searchParams.set("locationId", locationId);
    if (cycleSelection.productType) itemUrl.searchParams.set("productType", cycleSelection.productType);
    if (cycleSelection.brand) itemUrl.searchParams.set("brand", cycleSelection.brand);
    if (cycleSelection.series) itemUrl.searchParams.set("series", cycleSelection.series);
    if (cycleSearch.trim()) itemUrl.searchParams.set("search", cycleSearch.trim());
    inventoryItems = await api(itemUrl.pathname + itemUrl.search);
  } else {
    inventoryItems = [];
  }
  cycleDraft = await api("/api/cycle-count/draft");
}

async function selectCycleValue(value) {
  if (cycleStep === "type") {
    cycleSelection.productType = value;
    cycleSelection.brand = "";
    cycleSelection.series = "";
    cycleStep = "brand";
  } else if (cycleStep === "brand") {
    cycleSelection.brand = value;
    cycleSelection.series = "";
    cycleStep = "series";
  } else if (cycleStep === "series") {
    cycleSelection.series = value;
    cycleStep = "sku";
  }
  cyclePage = 0;
  selectedInventoryItem = null;
  await loadCycleData();
  render();
}

async function cycleBack() {
  if (cycleSearch.trim()) {
    cycleSearch = "";
  } else if (cycleStep === "sku") {
    cycleStep = "series";
    cycleSelection.series = "";
  } else if (cycleStep === "series") {
    cycleStep = "brand";
    cycleSelection.brand = "";
    cycleSelection.series = "";
  } else if (cycleStep === "brand") {
    cycleStep = "type";
    cycleSelection.productType = "";
    cycleSelection.brand = "";
    cycleSelection.series = "";
  } else {
    currentModule = "menu";
    return render();
  }
  cyclePage = 0;
  selectedInventoryItem = null;
  await loadCycleData();
  render();
}

async function syncInventory() {
  await api("/api/inventory/sync", {
    method: "POST",
    body: JSON.stringify({ locationIds: LOCATIONS.map((location) => location.id) })
  });
  showToast("Inventory synced");
  await loadCycleData();
  render();
}

async function confirmCycleLine() {
  if (!selectedInventoryItem || cycleConfirming) return;
  const pallets = qty(cycleValues["cycle-pallets"]);
  const layers = qty(cycleValues["cycle-layers"]);
  const sections = qty(cycleValues["cycle-sections"]);
  const pieces = qty(cycleValues["cycle-pieces"]) || qty(cycleValues["cycle-default"]);
  const itemId = selectedInventoryItem.item_id;
  const selectedLocationId = selectedInventoryItem.location_id;
  cycleConfirming = true;
  render();
  try {
    cycleDraft = await api("/api/cycle-count/lines", {
      method: "POST",
      body: JSON.stringify({
        itemId,
        locationId: selectedLocationId,
        pallets,
        layers,
        sections,
        pieces
      })
    });
    selectedInventoryItem = null;
    activeCycleUnit = "";
    cycleValues = {};
    showToast("Cycle count line confirmed");
  } finally {
    cycleConfirming = false;
    render();
  }
}

function editCycleLine(lineId) {
  const line = cycleDraft?.lines?.find((item) => String(item.id) === String(lineId));
  if (!line) return;
  selectedInventoryItem = {
    item_id: line.item_id,
    location_id: line.location_id,
    item_name: line.item_name,
    item_description: line.item_description,
    display_name: line.display_name,
    stock_unit: line.stock_unit,
    product_type: line.product_type,
    brand: line.brand,
    series: line.series,
    to_plt: line.to_plt,
    to_lyr: line.to_lyr,
    to_sec: line.to_sec,
    to_pcs: line.to_pcs
  };
  cycleValues = {
    "cycle-pallets": qty(line.counted_pallet_qty),
    "cycle-layers": qty(line.counted_layer_qty),
    "cycle-sections": qty(line.counted_section_qty),
    "cycle-pieces": qty(line.counted_piece_qty),
    "cycle-default": qty(line.counted_piece_qty)
  };
  activeCycleUnit = itemCountUnits(selectedInventoryItem)[0]?.key || "";
  render();
  updateCycleVariancePreview();
}

async function submitCycleCount() {
  cycleDraft = await api("/api/cycle-count/submit", { method: "POST" });
  showToast("Cycle count submitted");
  cycleDraft = await api("/api/cycle-count/draft");
  render();
}

function stepQty(unit, delta) {
  const input = app.querySelector(`.selected-panel [data-pack="${unit}"]`);
  if (!input) return;
  const selectedLine = selectedOrder?.lines?.find((line) => String(line.id) === String(selectedLineId));
  const receivingLine = receivingSelectedOrder?.lines?.find((line) => String(line.id) === String(receivingSelectedLineId));
  const activeLine = currentModule === "receiving" ? receivingLine : selectedLine;
  const max = unit.startsWith("cycle-") ? Number.POSITIVE_INFINITY : activeLine ? panelLimit(activeLine, unit) : Number.POSITIVE_INFINITY;
  input.value = Math.min(max, Math.max(0, qty(input.value) + Number(delta)));
  if (unit.startsWith("cycle-")) updateCycleVariancePreview();
}

function cycleUnitValue(unit) {
  return qty(app.querySelector(`[data-cycle-display="${unit}"]`)?.textContent);
}

function setCycleUnitValue(unit, value) {
  cycleValues[unit] = Math.max(0, Number(value) || 0);
  const display = app.querySelector(`[data-cycle-display="${unit}"]`);
  if (!display) return;
  display.textContent = String(cycleValues[unit]);
}

function pressCycleKey(key) {
  if (!activeCycleUnit) return;
  const current = String(cycleUnitValue(activeCycleUnit));
  if (key === "Clear") setCycleUnitValue(activeCycleUnit, 0);
  else if (key === "Back") setCycleUnitValue(activeCycleUnit, current.length <= 1 ? 0 : current.slice(0, -1));
  else setCycleUnitValue(activeCycleUnit, Number(`${current === "0" ? "" : current}${key}`));
  updateCycleVariancePreview();
}

function updateCycleVariancePreview() {
  if (!selectedInventoryItem) return;
  const pallets = cycleUnitValue("cycle-pallets");
  const layers = cycleUnitValue("cycle-layers");
  const sections = cycleUnitValue("cycle-sections");
  const pieces = cycleUnitValue("cycle-pieces");
  const defaultQty = cycleUnitValue("cycle-default");
  const units = itemCountUnits(selectedInventoryItem);
  if (units.length === 1 && units[0].key === "cycle-default") {
    const countedDefault = defaultQty;
    const defaultBox = app.querySelector("[data-cycle-variance]");
    if (!defaultBox) return;
    const defaultValues = defaultBox.querySelectorAll("strong");
    defaultValues[0].textContent = displayQty(countedDefault);
    defaultValues[1].textContent = t("operator.blind", "Blind");
    defaultValues[1].className = "";
    return;
  }
  const countedTotal = (pallets * qty(selectedInventoryItem.to_plt))
    + (layers * qty(selectedInventoryItem.to_lyr))
    + (sections * qty(selectedInventoryItem.to_sec))
    + (pieces * (qty(selectedInventoryItem.to_pcs) || 1));
  const box = app.querySelector("[data-cycle-variance]");
  if (!box) return;
  const values = box.querySelectorAll("strong");
  values[0].textContent = displayQty(countedTotal);
  values[1].textContent = t("operator.blind", "Blind");
  values[1].className = "";
}

app.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;

  try {
    if (button.dataset.action === "install-app") {
      if (!installPromptEvent) {
        return showToast("Browser install prompt is not available on this device.");
      }
      installPromptEvent.prompt();
      const choice = await installPromptEvent.userChoice;
      installPromptEvent = null;
      showToast(choice.outcome === "accepted" ? "Installing app" : "Install cancelled");
      return render();
    }
    if (button.dataset.action === "logout") {
      await api("/api/auth/logout", { method: "POST" }).catch(() => ({}));
      operator = null;
      clearOperatorSession();
      localStorage.removeItem(STATE_KEY);
      disconnectEvents();
      return renderLogin();
    }
    if (button.dataset.action === "toggle-location-dropdown") {
      locationDropdownOpen = !locationDropdownOpen;
      return render();
    }
    if (button.dataset.action === "set-location-dropdown") {
      const value = Number(button.dataset.locationId || 0);
      if (!value || Number(locationId) === value) {
        locationDropdownOpen = false;
        return render();
      }
      if (currentOrderBlocksMove()) return showToast("Pack current order before changing location.");
      if (!(await confirmDiscardCustomerPickupDraft())) return;
      stopFulfillmentCamera();
      stopReceiptCamera();
      stopPickupScannerCamera();
      locationId = value;
      locationDropdownOpen = false;
      localStorage.setItem("mbbs.operator.locationId", String(value));
      localStorage.removeItem(STATE_KEY);
      deliveryOrderBuckets = { active: null, packed: null };
      selectedId = null;
      selectedOrder = null;
      selectedLineId = null;
      currentModule = "menu";
      await loadDeliveryNotifications();
      return render();
    }
    if (button.dataset.action === "main-menu") {
      locationDropdownOpen = false;
      if (!(await confirmDiscardCustomerPickupDraft())) return;
      stopFulfillmentCamera();
      stopReceiptCamera();
      stopPickupScannerCamera();
      currentModule = "menu";
      selectedId = null;
      selectedOrder = null;
      selectedInventoryItem = null;
      return render();
    }
    if (button.dataset.action === "open-module") return openModule(button.dataset.module);
    if (button.dataset.action === "open-urgent-delivery-alert") return openUrgentDeliveryAlert();
    if (button.dataset.action === "dismiss-urgent-delivery-alert") {
      urgentDeliveryAlert = null;
      return render();
    }
    if (button.dataset.action === "enable-delivery-notifications") {
      if (!("Notification" in window)) {
        showToast("This browser does not support notifications.");
        return render();
      }
      const permission = await Notification.requestPermission().catch(() => "default");
      if (permission === "granted") {
        playDeliveryDing();
        const registration = await navigator.serviceWorker?.ready?.catch(() => null);
        await registration?.showNotification?.(t("operator.notificationsEnabled", "MBBS notifications enabled"), {
          body: t("operator.notificationsEnabledBody", "Urgent delivery prep alerts will appear here."),
          tag: "operator-notification-ready",
          icon: "/icons/mbbs-yard-192.png",
          badge: "/icons/mbbs-yard-192.png",
          silent: true,
          data: { url: "/operator", notice: "notification-ready" }
        }).catch(() => {});
        showToast("Notifications enabled");
      } else if (permission === "denied") {
        showToast("Notifications are blocked in browser settings.");
      }
      return render();
    }
    if (button.dataset.action === "set-line-density") {
      compactLineMode = button.dataset.density === "compact";
      localStorage.setItem("mbbs.operator.compactLineList", compactLineMode ? "true" : "false");
      linePage = 0;
      receivingLinePage = 0;
      consolidationReviewLinePage = 0;
      consolidationReviewLineKey = "";
      showToast(compactLineMode ? "Compact line list" : "Normal line list");
      return render();
    }
    if (button.dataset.action === "release-current-draft") return releaseCurrentDraft(button.dataset.order);
    if (button.dataset.action === "lookup-customer-pickup") return lookupCustomerPickup();
    if (button.dataset.action === "start-pickup-scanner") return startPickupScannerCamera();
    if (button.dataset.action === "switch-pickup-camera") return switchPickupScannerCamera();
    if (button.dataset.action === "customer-pickup-back") {
      if (!(await confirmDiscardCustomerPickupDraft())) return;
      selectedId = null;
      selectedOrder = null;
      selectedLineId = null;
      currentModule = "customer-pickup-scan";
      return render();
    }
    if (button.dataset.action === "select-delivery-type") {
      deliveryOrderType = "sales_order";
      deliveryPrepMode = "standard";
      deliveryBatchFilter = "planned";
      localStorage.setItem("mbbs.operator.deliveryOrderType", deliveryOrderType);
      localStorage.setItem("mbbs.operator.deliveryPrepMode", deliveryPrepMode);
      localStorage.setItem("mbbs.operator.deliveryBatchFilter", deliveryBatchFilter);
      return openModule("delivery-run");
    }
    if (button.dataset.action === "select-delivery-pool") {
      deliveryPrepMode = button.dataset.mode || "saved";
      if (!["saved", "load"].includes(deliveryPrepMode)) deliveryPrepMode = "saved";
      viewMode = "active";
      if (deliveryPrepMode === "load") deliveryLoadViewTruck = "";
      localStorage.setItem("mbbs.operator.deliveryPrepMode", deliveryPrepMode);
      return openModule("delivery-run");
    }
    if (button.dataset.action === "open-consolidation") {
      currentModule = "delivery-consolidation";
      consolidationStage = "pick";
      consolidationSearch = "";
      consolidationSelectedItemKey = "";
      return loadConsolidation();
    }
    if (button.dataset.action === "consolidation-back") {
      currentModule = "delivery-select";
      consolidationNotice = "";
      return render();
    }
    if (button.dataset.action === "refresh-consolidation") return loadConsolidation({ keepItem: true });
    if (button.dataset.action === "start-consolidation") return startConsolidation();
    if (button.dataset.action === "consolidation-stage") {
      consolidationStage = button.dataset.stage === "review" ? "review" : "pick";
      return render();
    }
    if (button.dataset.action === "select-consolidation-review-order") {
      consolidationReviewOrderId = button.dataset.order || "";
      consolidationReviewLineKey = "";
      consolidationReviewLinePage = 0;
      return render();
    }
    if (button.dataset.action === "select-consolidation-review-line") {
      consolidationReviewLineKey = button.dataset.line || "";
      return render();
    }
    if (button.dataset.action === "consolidation-review-line-prev") {
      consolidationReviewLinePage = Math.max(0, consolidationReviewLinePage - 1);
      consolidationReviewLineKey = "";
      return render();
    }
    if (button.dataset.action === "consolidation-review-line-next") {
      const selectedOrder = selectedConsolidationReviewOrder();
      consolidationReviewLinePage = Math.min(pageCount(selectedOrder?.lines || [], activeLinePageSize()) - 1, consolidationReviewLinePage + 1);
      consolidationReviewLineKey = "";
      return render();
    }
    if (button.dataset.action === "select-consolidation-item") {
      consolidationSelectedItemKey = button.dataset.item || "";
      return render();
    }
    if (button.dataset.action === "step-consolidation") {
      return stepConsolidationAllocation(button.dataset.order, button.dataset.line, button.dataset.unit, button.dataset.delta);
    }
    if (button.dataset.action === "confirm-consolidation-line") {
      return confirmConsolidationAllocation(button.dataset.order, button.dataset.line);
    }
    if (button.dataset.action === "confirm-consolidation-item") return confirmConsolidationSku(button.dataset.item);
    if (button.dataset.action === "pack-consolidation-order") return packConsolidationBatchOrder(button.dataset.order);
    if (button.dataset.action === "release-consolidation") return releaseConsolidation();
    if (button.dataset.action === "select-receiving-type") {
      receivingOrderType = button.dataset.orderType || "purchase_order";
      receivingStep = "vendor";
      receivingSelectedVendor = "";
      receivingSelectedSourceId = "";
      receivingSearch = "";
      receivingItemSearch = "";
      receivingItemSuggestions = [];
      receivingOrders = [];
      receivingSelectedOrder = null;
      receivingSelectedId = null;
      await loadReceivingOptions();
      return render();
    }
    if (button.dataset.action === "receiving-back") {
      if (receivingStep === "orders") {
        receivingStep = receivingSearch.trim() || receivingItemSearch.trim() ? "type" : "vendor";
        receivingSearch = "";
        receivingItemSearch = "";
        receivingItemSuggestions = [];
        receivingSelectedId = null;
        receivingSelectedOrder = null;
        receivingOrders = [];
      } else if (receivingStep === "vendor") {
        receivingStep = "type";
        receivingSelectedVendor = "";
        receivingSelectedSourceId = "";
      } else {
        currentModule = "menu";
      }
      return render();
    }
    if (button.dataset.action === "select-receiving-vendor") {
      receivingSelectedVendor = button.dataset.value || "";
      receivingStep = "orders";
      receivingOrderPage = 0;
      return loadReceivingOrders();
    }
    if (button.dataset.action === "select-receiving-source") {
      receivingSelectedSourceId = button.dataset.value || "";
      receivingStep = "orders";
      receivingOrderPage = 0;
      return loadReceivingOrders();
    }
    if (button.dataset.action === "refresh-receiving") return refreshReceiving();
    if (button.dataset.action === "receiving-key") return pressReceivingKey(button.dataset.key);
    if (button.dataset.action === "receiving-pick-item") {
      receivingItemSearch = button.dataset.item || "";
      receivingItemSuggestions = [];
      receivingStep = "orders";
      receivingSelectedVendor = "";
      receivingSelectedSourceId = "";
      receivingOrderPage = 0;
      return loadReceivingOrders();
    }
    if (button.dataset.action === "receiving-order-prev") {
      receivingOrderPage = Math.max(0, receivingOrderPage - 1);
      return render();
    }
    if (button.dataset.action === "receiving-order-next") {
      receivingOrderPage = Math.min(pageCount(receivingOrders, ORDER_PAGE_SIZE) - 1, receivingOrderPage + 1);
      return render();
    }
    if (button.dataset.action === "receiving-line-prev") {
      receivingLinePage = Math.max(0, receivingLinePage - 1);
      return render();
    }
    if (button.dataset.action === "receiving-line-next") {
      const lines = (receivingSelectedOrder?.lines || []).filter((line) => isPickableLine(line) && hasReceivingRemainingQty(line));
      receivingLinePage = Math.min(pageCount(lines, activeLinePageSize()) - 1, receivingLinePage + 1);
      return render();
    }
    if (button.dataset.action === "select-receiving-line") {
      receivingSelectedLineId = button.dataset.line;
      return render();
    }
    if (button.dataset.action === "confirm-receiving-line") return confirmReceivingLine(button.dataset.line);
    if (button.dataset.action === "unconfirm-receiving-line") return unconfirmReceivingLine(button.dataset.line);
    if (button.dataset.action === "start-receive") return startReceipt();
    if (button.dataset.action === "cancel-receive") {
      stopReceiptCamera();
      currentModule = "receiving";
      receiptOrder = null;
      receiptPhotoDataUrls = [];
      receiptResult = null;
      receiptStatusText = "";
      receiptJobStage = "";
      receiptStartedAt = 0;
      return render();
    }
    if (button.dataset.action === "select-receipt-photo-slot") {
      receiptActivePhotoSlot = Number(button.dataset.slot) || 0;
      return render();
    }
    if (button.dataset.action === "add-receipt-photo") {
      while (receiptPhotoDataUrls.length < 2) receiptPhotoDataUrls.push("");
      receiptPhotoDataUrls.push("");
      receiptActivePhotoSlot = receiptPhotoDataUrls.length - 1;
      return render();
    }
    if (button.dataset.action === "remove-receipt-photo") {
      const slot = Number(button.dataset.slot);
      if (slot >= 2 && slot < receiptPhotoDataUrls.length) receiptPhotoDataUrls.splice(slot, 1);
      receiptActivePhotoSlot = Math.min(receiptActivePhotoSlot, Math.max(1, receiptPhotoDataUrls.length - 1));
      return render();
    }
    if (button.dataset.action === "start-receipt-camera") return startReceiptCamera();
    if (button.dataset.action === "stop-receipt-camera") {
      stopReceiptCamera();
      return render();
    }
    if (button.dataset.action === "switch-receipt-camera") return switchReceiptCamera();
    if (button.dataset.action === "capture-receipt-photo") return captureReceiptPhoto();
    if (button.dataset.action === "confirm-receive") return confirmReceipt();
    if (button.dataset.action === "finish-receive") return finishReceipt();
    if (button.dataset.action === "refresh-history") return loadPersonalHistory();
    if (button.dataset.action === "cycle-back") return cycleBack();
    if (button.dataset.action === "sync-inventory") return syncInventory();
    if (button.dataset.action === "cycle-select") return selectCycleValue(button.dataset.value);
    if (button.dataset.action === "select-inventory-item") {
      selectedInventoryItem = inventoryItems.find((item) => String(item.item_id) === String(button.dataset.item)) || null;
      activeCycleUnit = itemCountUnits(selectedInventoryItem || {})[0]?.key || "";
      cycleValues = {};
      return render();
    }
    if (button.dataset.action === "select-cycle-unit") {
      activeCycleUnit = button.dataset.unit;
      app.querySelectorAll(".cycle-count-field").forEach((item) => item.classList.toggle("active", item.dataset.unit === activeCycleUnit));
      return;
    }
    if (button.dataset.action === "cycle-key") return pressCycleKey(button.dataset.key);
    if (button.dataset.action === "edit-cycle-line") return editCycleLine(button.dataset.line);
    if (button.dataset.action === "cycle-prev") {
      cyclePage = Math.max(0, cyclePage - 1);
      return render();
    }
    if (button.dataset.action === "cycle-next") {
      cyclePage = Math.min(pageCount(inventoryItems, LINE_PAGE_SIZE) - 1, cyclePage + 1);
      return render();
    }
    if (button.dataset.action === "confirm-cycle-line") return confirmCycleLine();
    if (button.dataset.action === "submit-cycle-count") return submitCycleCount();
    if (button.dataset.action === "save-location") {
      const value = Number(document.getElementById("locationSelect").value);
      locationId = value;
      locationDropdownOpen = false;
      localStorage.setItem("mbbs.operator.locationId", String(value));
      deliveryOrderBuckets = { active: null, packed: null };
      orderPage = 0;
      linePage = 0;
      currentModule = "menu";
      return render();
    }
    if (button.dataset.action === "change-location") {
      localStorage.removeItem("mbbs.operator.locationId");
      localStorage.removeItem(STATE_KEY);
      locationId = 0;
      locationDropdownOpen = false;
      deliveryOrderBuckets = { active: null, packed: null };
      selectedId = null;
      selectedOrder = null;
      return render();
    }
    if (button.dataset.action === "view-active") {
      viewMode = "active";
      orderPage = 0;
      selectedId = null;
      if (deliveryPrepMode === "standard" && await activateCachedDeliveryView("active")) return;
      return loadOrders();
    }
    if (button.dataset.action === "view-packed") {
      if (currentOrderBlocksMove()) return showToast("Pack current order before moving on.");
      viewMode = "packed";
      orderPage = 0;
      selectedId = null;
      if (deliveryPrepMode === "standard" && await activateCachedDeliveryView("packed")) return;
      return loadOrders();
    }
    if (button.dataset.action === "delivery-batch-filter") {
      if (currentOrderBlocksMove()) return showToast("Pack current order before moving on.");
      return activateCachedDeliveryBatch(button.dataset.filter);
    }
    if (button.dataset.action === "delivery-prep-mode") {
      if (currentOrderBlocksMove()) return showToast("Pack current order before moving on.");
      deliveryPrepMode = button.dataset.mode || "standard";
      if (!["standard", "saved", "load"].includes(deliveryPrepMode)) deliveryPrepMode = "standard";
      if (deliveryPrepMode === "load") deliveryLoadViewTruck = "";
      localStorage.setItem("mbbs.operator.deliveryPrepMode", deliveryPrepMode);
      viewMode = "active";
      orderPage = 0;
      linePage = 0;
      selectedId = null;
      selectedOrder = null;
      return loadOrders();
    }
    if (button.dataset.action === "apply-delivery-load-view") {
      if (currentOrderBlocksMove()) return showToast("Pack current order before moving on.");
      const dateInput = app.querySelector('[data-input="delivery-load-date"]');
      const truckInput = app.querySelector('[data-input="delivery-load-truck"]');
      deliveryLoadViewDate = dateInput?.value || deliveryLoadViewDate || new Date().toISOString().slice(0, 10);
      deliveryLoadViewTruck = truckInput?.value || "";
      localStorage.setItem("mbbs.operator.deliveryLoadViewDate", deliveryLoadViewDate);
      orderPage = 0;
      linePage = 0;
      selectedId = null;
      selectedOrder = null;
      return loadOrders();
    }
    if (button.dataset.action === "toggle-saved-order") {
      return toggleSavedDeliveryOrder(button.dataset.order || selectedId);
    }
    if (button.dataset.action === "save-delivery-order") {
      await api("/api/delivery/saved-orders", {
        method: "POST",
        body: JSON.stringify({ locationId, orderId: button.dataset.order || selectedId })
      });
      showToast("Order saved");
      return loadOrders({ keepSelection: true });
    }
    if (button.dataset.action === "remove-saved-order") {
      await api(`/api/delivery/saved-orders/${encodeURIComponent(button.dataset.order || selectedId)}?locationId=${locationId}`, {
        method: "DELETE"
      });
      showToast("Saved order removed");
      selectedId = null;
      selectedOrder = null;
      return loadOrders();
    }
    if (button.dataset.action === "sync") {
      return refreshDeliveryOrders();
    }
    if (button.dataset.action === "refresh") {
      return refreshDeliveryOrders();
    }
    if (button.dataset.action === "open-warning-order") {
      selectedId = button.dataset.order;
      linePage = 0;
      selectedLineId = null;
      const index = orders.findIndex((order) => String(order.netsuite_id) === String(selectedId));
      if (index >= 0) orderPage = Math.floor(index / DELIVERY_ORDER_PAGE_SIZE);
      return loadDetail(selectedId);
    }
    if (button.dataset.action === "open-operator-request") {
      if (!button.dataset.order) return showToast("Requested order is not in this list.");
      viewMode = "packed";
      selectedId = button.dataset.order;
      await loadOrders({ keepSelection: true });
      const index = orders.findIndex((order) => String(order.netsuite_id) === String(selectedId));
      if (index >= 0) orderPage = Math.floor(index / DELIVERY_ORDER_PAGE_SIZE);
      return render();
    }
    if (button.dataset.action === "order-prev") {
      if (currentOrderBlocksMove()) return showToast("Pack current order before moving on.");
      orderPage = Math.max(0, orderPage - 1);
      return render();
    }
    if (button.dataset.action === "order-next") {
      if (currentOrderBlocksMove()) return showToast("Pack current order before moving on.");
      orderPage = Math.min(pageCount(filteredDeliveryOrders(), DELIVERY_ORDER_PAGE_SIZE) - 1, orderPage + 1);
      return render();
    }
    if (button.dataset.action === "line-prev") {
      const lines = detailPanelLines(selectedOrder);
      linePage = Math.max(0, linePage - 1);
      selectedLineId = pageItems(lines, linePage, activeLinePageSize())[0]?.id || selectedLineId;
      return render();
    }
    if (button.dataset.action === "line-next") {
      const lines = detailPanelLines(selectedOrder);
      linePage = Math.min(pageCount(lines, activeLinePageSize()) - 1, linePage + 1);
      selectedLineId = pageItems(lines, linePage, activeLinePageSize())[0]?.id || selectedLineId;
      return render();
    }
    if (button.dataset.action === "step-qty") return stepQty(button.dataset.unit, button.dataset.delta);
    if (button.dataset.action === "set-preparing") return setOrderStatus("preparing");
    if (button.dataset.action === "set-packed") return setOrderStatus("packed");
    if (button.dataset.action === "start-fulfill") return startFulfillment();
    if (button.dataset.action === "cancel-fulfill") {
      stopFulfillmentCamera();
      currentModule = currentModule === "customer-pickup-load" ? "customer-pickup" : (fulfillmentReturnModule || "delivery");
      fulfillmentOrder = null;
      fulfillmentPhotoDataUrls = [];
      fulfillmentActivePhotoSlot = 0;
      fulfillmentResult = null;
      fulfillmentStatusText = "";
      fulfillmentJobStage = "";
      fulfillmentStartedAt = 0;
      return render();
    }
    if (button.dataset.action === "confirm-fulfill") return confirmFulfillment();
    if (button.dataset.action === "finish-fulfill") return finishFulfillment();
    if (button.dataset.action === "start-camera") return startFulfillmentCamera();
    if (button.dataset.action === "stop-camera") {
      stopFulfillmentCamera();
      return render();
    }
    if (button.dataset.action === "switch-fulfillment-camera") return switchFulfillmentCamera();
    if (button.dataset.action === "capture-photo") return captureFulfillmentPhoto();
    if (button.dataset.action === "select-fulfillment-photo-slot") {
      fulfillmentActivePhotoSlot = Number(button.dataset.slot) || 0;
      return render();
    }
    if (button.dataset.action === "add-fulfillment-photo") {
      while (fulfillmentPhotoDataUrls.length < 2) fulfillmentPhotoDataUrls.push("");
      fulfillmentPhotoDataUrls.push("");
      fulfillmentActivePhotoSlot = fulfillmentPhotoDataUrls.length - 1;
      return render();
    }
    if (button.dataset.action === "remove-fulfillment-photo") {
      const slot = Number(button.dataset.slot);
      if (slot >= 2 && slot < fulfillmentPhotoDataUrls.length) fulfillmentPhotoDataUrls.splice(slot, 1);
      fulfillmentActivePhotoSlot = Math.min(fulfillmentActivePhotoSlot, Math.max(1, fulfillmentPhotoDataUrls.length - 1));
      return render();
    }
    if (button.dataset.action === "select-history") {
      selectedHistoryId = button.dataset.record;
      historyReportReason = "";
      return render();
    }
    if (button.dataset.action === "open-history-photo") {
      openPhotoLightbox(button.dataset.photoRef, button.dataset.photoLabel || "Record photo");
      return;
    }
    if (button.dataset.action === "history-prev") {
      historyPage = Math.max(0, historyPage - 1);
      selectedHistoryId = pageItems(personalHistory, historyPage, HISTORY_PAGE_SIZE)[0]?.id || selectedHistoryId;
      historyReportReason = "";
      return render();
    }
    if (button.dataset.action === "history-next") {
      historyPage = Math.min(pageCount(personalHistory, HISTORY_PAGE_SIZE) - 1, historyPage + 1);
      selectedHistoryId = pageItems(personalHistory, historyPage, HISTORY_PAGE_SIZE)[0]?.id || selectedHistoryId;
      historyReportReason = "";
      return render();
    }
    if (button.dataset.action === "report-history-error") {
      historyReportReason = document.getElementById("historyReportReason")?.value || "";
      await api("/api/operator/history/report-error", {
        method: "POST",
        body: JSON.stringify({ recordId: button.dataset.record, reason: historyReportReason })
      });
      historyReportReason = "";
      showToast("Reported to supervisor");
      return loadPersonalHistory();
    }
    if (button.dataset.action === "confirm-page") return confirmPage();
    if (button.dataset.action === "confirm-line") return confirmLine(button.dataset.line);
    if (button.dataset.action === "unpack-line") return unpackLine(button.dataset.line);
    if (button.dataset.action === "update-packed-line") return updatePackedLine(button.dataset.line);
    if (button.dataset.action === "unpack-order") {
      if (isCustomerPickupMode()) return showToast("Whole-order unpack is not available for customer pickup.");
      return unpackOrder();
    }
    if (button.dataset.order) {
      const preparing = preparingOrderId();
      if (preparing && String(button.dataset.order) !== String(preparing)) {
        return showToast("Pack current order before moving on.");
      }
      linePage = 0;
      selectedLineId = null;
      return loadDetail(button.dataset.order);
    }
    if (button.dataset.receivingOrder) {
      receivingLinePage = 0;
      return loadReceivingDetail(button.dataset.receivingOrder);
    }
    if (button.dataset.line) {
      selectedLineId = button.dataset.line;
      return render();
    }
  } catch (error) {
    showToast(error.message);
  }
});

app.addEventListener("input", async (event) => {
  if (event.target?.id === "consolidationSearch") {
    consolidationSearch = event.target.value;
    window.clearTimeout(app.consolidationSearchTimer);
    app.consolidationSearchTimer = window.setTimeout(() => {
      render();
      window.requestAnimationFrame(() => {
        const input = document.getElementById("consolidationSearch");
        if (!input) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    }, 100);
    return;
  }
  if (event.target?.id === "customerPickupScan") {
    customerPickupScan = event.target.value;
    customerPickupMessage = "";
    return;
  }
  if (event.target?.id === "historyReportReason") {
    historyReportReason = event.target.value;
    return;
  }
  if (event.target?.id === "receivingSearch") {
    receivingSearch = event.target.value;
    receivingOrderPage = 0;
    window.clearTimeout(app.receivingSearchTimer);
    app.receivingSearchTimer = window.setTimeout(async () => {
      try {
        if (receivingSearch.trim()) {
          receivingStep = "orders";
          receivingSelectedVendor = "";
          receivingSelectedSourceId = "";
          await loadReceivingOrders({ keepSelection: false });
          window.requestAnimationFrame(() => focusReceivingInput("receivingSearch"));
        } else {
          receivingSelectedId = null;
          receivingSelectedOrder = null;
          receivingOrders = [];
          render();
          window.requestAnimationFrame(() => focusReceivingInput("receivingSearch"));
        }
      } catch (error) {
        showToast(error.message);
      }
    }, 250);
    return;
  }
  if (event.target?.id === "receivingItemSearch") {
    receivingItemSearch = event.target.value;
    receivingOrderPage = 0;
    window.clearTimeout(app.receivingItemTimer);
    app.receivingItemTimer = window.setTimeout(async () => {
      try {
        await loadReceivingItemSuggestions();
        if (receivingItemSearch.trim()) {
          receivingStep = "orders";
          receivingSelectedVendor = "";
          receivingSelectedSourceId = "";
          await loadReceivingOrders({ keepSelection: false });
          window.requestAnimationFrame(() => focusReceivingInput("receivingItemSearch"));
        } else {
          receivingItemSuggestions = [];
          receivingSelectedId = null;
          receivingSelectedOrder = null;
          receivingOrders = [];
          render();
          window.requestAnimationFrame(() => focusReceivingInput("receivingItemSearch"));
        }
      } catch (error) {
        showToast(error.message);
      }
    }, 250);
    return;
  }
  if (event.target?.id !== "cycleSearch") return;
  cycleSearch = event.target.value;
  cyclePage = 0;
  selectedInventoryItem = null;
  window.clearTimeout(app.cycleSearchTimer);
  app.cycleSearchTimer = window.setTimeout(async () => {
    try {
      await loadCycleData();
      render();
      window.requestAnimationFrame(focusCycleSearch);
    } catch (error) {
      showToast(error.message);
    }
  }, 250);
});

app.addEventListener("keydown", async (event) => {
  if (event.target?.id === "customerPickupScan" && event.key === "Enter") {
    event.preventDefault();
    await submitCustomerPickupScanValue(event.target.value);
  }
});

window.addEventListener("keydown", async (event) => {
  try {
    await handleCustomerPickupScannerKey(event);
  } catch (error) {
    customerPickupMessage = error.message;
    render();
  }
}, true);

app.addEventListener("change", async (event) => {
  if (event.target?.id === "historyDate") {
    personalHistoryDate = event.target.value || "";
    selectedHistoryId = "";
    historyReportReason = "";
    historyPage = 0;
    return loadPersonalHistory();
  }
  if (event.target?.dataset?.input === "delivery-load-date") {
    deliveryLoadViewDate = event.target.value || deliveryLoadViewDate;
    deliveryLoadViewTruck = "";
    localStorage.setItem("mbbs.operator.deliveryLoadViewDate", deliveryLoadViewDate);
    orderPage = 0;
    selectedId = null;
    return loadOrders();
  }
  if (event.target?.dataset?.input === "delivery-load-truck") {
    deliveryLoadViewTruck = event.target.value || "";
    orderPage = 0;
    selectedId = null;
    return loadOrders();
  }
  return;
});

app.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-form='login']");
  if (!form) return;
  event.preventDefault();
  try {
    const result = await publicApi("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: document.getElementById("loginUsername").value,
        password: document.getElementById("loginPassword").value
      })
    });
    operator = result.operator;
    storeOperatorSession(result.token, operator);
    if (!operatorRoleAllowed(operator)) {
      window.location.replace(staffRoleHome(operator.role));
      return;
    }
    connectEvents();
    showToast(`Welcome ${operator.display_name}`);
    await restoreOperatorView();
  } catch (error) {
    renderLogin("Invalid username or password.");
  }
});

async function boot() {
  if (!authToken) {
    if (localStorage.getItem("mbbs.driver.token")) {
      window.location.replace("/driver");
      return;
    }
    const bootstrap = await publicApi("/api/auth/bootstrap-needed").catch(() => ({ needed: false }));
    return renderLogin(bootstrap.needed ? "No operator account yet. Open /control to create the first admin account." : "");
  }
  try {
    const result = await api("/api/auth/me");
    operator = result.operator;
    storeOperatorSession(authToken, operator);
    if (!operatorRoleAllowed(operator)) {
      window.location.replace(staffRoleHome(operator.role));
      return;
    }
    connectEvents();
    await restoreOperatorView();
  } catch (error) {
    disconnectEvents();
    renderLogin("Please login to continue.");
  }
}

boot();
setInterval(() => {
  if (!operator || !locationId) return;
  if (currentModule === "delivery") {
    loadOrders({ keepSelection: true }).catch((error) => showToast(error.message));
  } else {
    loadDeliveryNotifications()
      .then(() => {
        if (currentModule === "menu" || currentModule === "delivery-select") render();
      })
      .catch((error) => showToast(error.message));
  }
}, 60000);

setInterval(() => {
  if (!operator || !locationId) return;
  loadDeliveryNotifications().catch(() => {});
}, 10000);

if ("serviceWorker" in navigator) {
  let serviceWorkerRefreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (serviceWorkerRefreshing) return;
    serviceWorkerRefreshing = true;
    window.location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").then((registration) => {
      registration.update().catch(() => {});
      if (registration.waiting) registration.waiting.postMessage({ type: "SKIP_WAITING" });
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            worker.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });
    }).catch(() => {});
  });
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "OPEN_URGENT_DELIVERY_ALERT") {
      openUrgentDeliveryAlert().catch((error) => showToast(error.message));
    }
  });
}

window.addEventListener("pagehide", () => {
  stopFulfillmentCamera();
  stopReceiptCamera();
  stopPickupScannerCamera();
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPromptEvent = event;
  if (app.innerHTML) render();
});

window.addEventListener("appinstalled", () => {
  appInstalled = true;
  installPromptEvent = null;
  showToast("App installed");
  render();
});

window.addEventListener("mbbs-language-changed", () => {
  render();
});

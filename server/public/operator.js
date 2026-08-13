const LOCATIONS = [
  { id: 1, text: "3445" },
  { id: 28, text: "2967" },
  { id: 15, text: "12441" },
  { id: 26, text: "150" }
];

const ORDER_PAGE_SIZE = 4;
const DELIVERY_ORDER_PAGE_SIZE = 3;
const LINE_PAGE_SIZE = 3;
const CYCLE_OPTION_PAGE_SIZE = 6;
const COMPACT_LINE_PAGE_SIZE = 6;
const HISTORY_PAGE_SIZE = 5;
const PICKABLE_ITEM_TYPES = new Set(["InvtPart", "NonInvtPart"]);
const RETURN_MAX_PHOTOS = 5;
const RETURN_LINE_PAGE_SIZE = 3;
const RETURN_HISTORY_PAGE_SIZE = 100;
const RETURN_QUANTITY_EPSILON = 1e-6;
const RETURN_ORDER_PREFIX_YARDS = Object.freeze({
  SOA: { locationId: 28, yardCode: "2967" },
  SOB: { locationId: 1, yardCode: "3445" },
  SOM: { locationId: 26, yardCode: "150" }
});

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
  "pallet-return",
  "stock-return",
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
let deliveryLoadViewDate = initialOperatorState.deliveryLoadViewDate || localStorage.getItem("mbbs.operator.deliveryLoadViewDate") || new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
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
let deliveryNotificationsRequest = null;
let deliveryOrdersLoadingCount = 0;
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
let fulfillmentLoadRequestId = "";
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

let returnMode = initialOperatorState.returnMode === "stock" || currentModule === "stock-return" ? "stock"
  : initialOperatorState.returnMode === "pallet" || currentModule === "pallet-return" ? "pallet"
    : "";
let returnStage = ["lookup", "form", "review", "success"].includes(initialOperatorState.returnStage)
  ? initialOperatorState.returnStage
  : "lookup";
let returnView = ["workflow", "drafts", "history"].includes(initialOperatorState.returnView)
  ? initialOperatorState.returnView
  : "workflow";
let returnType = initialOperatorState.returnType === "quality" ? "quality" : "normal";
let returnLookupCode = String(initialOperatorState.returnLookupCode || "");
let returnLookupMessage = "";
let returnLookupData = null;
let returnCustomerSearch = "";
let returnCustomerResults = [];
let returnCustomerSearchBusy = false;
let returnCustomerSearchActive = false;
let returnCustomerSearchPending = false;
let returnCustomerSearchGeneration = 0;
let returnSelectedCustomer = null;
let returnPalletBalance = null;
let returnPalletQuantity = 0;
let returnVehiclePlate = "";
let returnHeaderNote = "";
let returnLineValues = {};
let returnLinePage = 0;
let returnActiveLineId = "";
let returnRecordPhotos = [];
let returnPalletPhotos = [];
let returnPhotoTarget = { kind: "record", lineId: "" };
let returnPhotoSlot = 0;
let returnCameraStream = null;
let returnCameraActive = false;
let returnScannerStream = null;
let returnScannerActive = false;
let returnScannerTimer = null;
let returnQrDecoder = null;
let returnQrFrameBusy = false;
let returnQuaggaActive = false;
let returnScanSubmitting = false;
let returnScanCandidate = "";
let returnScanCandidateHits = 0;
let returnScanCandidateAt = 0;
let returnScannerBuffer = "";
let returnScannerLastKeyAt = 0;
let returnReasons = {
  normalReason: { id: "10", label: "GD - Good Condition" },
  qualityReasons: [
    { id: "5", label: "R1 - Color Variation" },
    { id: "6", label: "R2 - Efflorescence" },
    { id: "7", label: "R3 - Chipping / Crack" },
    { id: "8", label: "R4 - Surface" },
    { id: "9", label: "R5 - Others" }
  ]
};
let returnYardSettings = [];
let returnDraftId = String(initialOperatorState.returnDraftId || "");
let returnIdempotencyKey = "";
let returnDrafts = [];
let returnHistory = [];
let returnHistoryOffset = 0;
let returnHistoryTotal = 0;
let returnHistoryDetail = null;
let returnSelectedRecordId = "";
let returnBusy = false;
let returnDirty = false;
let returnResult = null;
let returnValidationMessage = "";

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
let personalHistoryDate = initialOperatorState.personalHistoryDate || new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
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

function photoImgAttributes(value) {
  const text = String(value || "");
  if (!text.startsWith("r2://")) return `src="${escapeHtml(text)}"`;
  return `data-secure-photo-ref="${escapeHtml(text)}"`;
}

function releaseSecurePhotoImage(image) {
  if (!image) return;
  image._securePhotoController?.abort();
  image._securePhotoController = null;
  if (image._securePhotoObjectUrl) URL.revokeObjectURL(image._securePhotoObjectUrl);
  image._securePhotoObjectUrl = "";
}

function releaseSecurePhotoImages(root = app) {
  if (!root) return;
  const images = [
    ...(root.matches?.("img[data-secure-photo-ref]") ? [root] : []),
    ...root.querySelectorAll("img[data-secure-photo-ref]")
  ];
  images.forEach(releaseSecurePhotoImage);
}

async function hydrateSecurePhotoImage(image) {
  const ref = String(image?.dataset?.securePhotoRef || "");
  if (!ref || image.dataset.securePhotoState === "loading" || image.dataset.securePhotoState === "loaded") return;
  const controller = new AbortController();
  image._securePhotoController = controller;
  image.dataset.securePhotoState = "loading";
  try {
    const response = await fetch(`/api/photo-upload/preview?ref=${encodeURIComponent(ref)}`, {
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Photo preview failed (${response.status})`);
    const objectUrl = URL.createObjectURL(await response.blob());
    if (!image.isConnected || image.dataset.securePhotoRef !== ref || controller.signal.aborted) {
      URL.revokeObjectURL(objectUrl);
      return;
    }
    image._securePhotoObjectUrl = objectUrl;
    image.dataset.securePhotoState = "loaded";
    const release = () => releaseSecurePhotoImage(image);
    image.addEventListener("load", release, { once: true });
    image.addEventListener("error", release, { once: true });
    image.src = objectUrl;
  } catch (error) {
    if (error.name !== "AbortError") {
      image.dataset.securePhotoState = "error";
      image.title = error.message;
    }
  } finally {
    if (image._securePhotoController === controller) image._securePhotoController = null;
  }
}

function hydrateSecurePhotoImages(root = app) {
  root?.querySelectorAll("img[data-secure-photo-ref]").forEach((image) => {
    hydrateSecurePhotoImage(image);
  });
}

function openPhotoLightbox(photoRef, label = "Photo preview") {
  const ref = String(photoRef || "");
  if (!ref) return;
  closePhotoLightbox();
  const modal = document.createElement("div");
  modal.className = "photo-lightbox";
  modal.innerHTML = `
    <div class="photo-lightbox-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(label)}">
      <button class="photo-lightbox-close" type="button">×</button>
      <img ${photoImgAttributes(ref)} alt="${escapeHtml(label)}" />
    </div>
  `;
  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target.closest(".photo-lightbox-close")) closePhotoLightbox();
  });
  document.body.appendChild(modal);
  hydrateSecurePhotoImages(modal);
}

function closePhotoLightbox() {
  const modal = document.querySelector(".photo-lightbox");
  if (!modal) return;
  releaseSecurePhotoImages(modal);
  modal.remove();
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
  return mapWithConcurrency(photos, 2, (photo, index) => (
    uploadOperatorPhoto(photo, {
      ...context,
      filename: `${context.recordType || "operator-photo"}-${index + 1}.jpg`
    })
  ));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const values = Array.from(items || []);
  if (!values.length) return [];
  const results = new Array(values.length);
  let nextIndex = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await mapper(values[index], index);
      } catch (error) {
        failure ||= error;
      }
    }
  };
  const workerCount = Math.min(values.length, Math.max(1, Number(concurrency) || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (failure) throw failure;
  return results;
}

function updateUploadElapsed(selector, startedAt) {
  const elapsed = app.querySelector(selector);
  if (!elapsed || !startedAt) return;
  elapsed.textContent = ` (${Math.max(1, Math.round((Date.now() - startedAt) / 1000))}s)`;
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
    ? new Date(urgentDeliveryAlert.updatedAt).toLocaleTimeString([], { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", second: "2-digit" })
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
  const returnLocationLocked = returnModuleActive() && (returnStage !== "lookup" || Boolean(returnDraftId));
  releaseSecurePhotoImages(app);
  app.innerHTML = `
    <header class="topbar">
      <div class="topbar-location">
        <button class="secondary-button location-button" data-action="toggle-location-dropdown" ${returnLocationLocked ? "disabled" : ""} type="button">${t("common.location", "Location")} ${currentLocation()?.text || locationId || ""}${returnLocationLocked ? ` · ${t("operator.locked", "Locked")}` : ""}</button>
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
  if (returnCameraActive) window.requestAnimationFrame(attachReturnCamera);
  hydrateSecurePhotoImages(app);
}

function renderLogin(message = "") {
  releaseSecurePhotoImages(app);
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
    returnMode,
    returnStage,
    returnView,
    returnType,
    returnLookupCode,
    returnDraftId,
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
    if (currentModule === "pallet-return" || currentModule === "stock-return") {
      returnMode = currentModule === "stock-return" ? "stock" : "pallet";
      await loadReturnReasons().catch(() => {});
      if (returnDraftId) {
        await loadReturnDrafts({ renderAfter: false }).catch(() => {});
        const draft = returnDrafts.find((item) => String(item.id) === String(returnDraftId));
        if (draft) await resumeReturnDraft(draft, { renderAfter: false }).catch(() => {});
        else resetReturnWorkflow(returnMode);
      } else {
        resetReturnWorkflow(returnMode);
      }
      render();
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
  if (currentModule === "pallet-return" || currentModule === "stock-return") return renderReturnWorkflow();
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
        <span>${t("operator.personalHistoryDesc", "Review your submitted IF, IR, count and return records.")}</span>
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

function returnModuleActive() {
  return currentModule === "pallet-return" || currentModule === "stock-return";
}

function returnModuleTitle() {
  return returnMode === "stock"
    ? t("operator.stockReturn", "Stock Return")
    : t("operator.palletReturn", "Pallet Return");
}

function returnOrder() {
  return returnLookupData?.order || returnLookupData?.salesOrder || null;
}

function returnCustomer() {
  return returnSelectedCustomer
    || returnLookupData?.customer
    || returnOrder()?.customer
    || null;
}

function returnCustomerId(customer = returnCustomer()) {
  return customer?.internalId || customer?.internal_id || customer?.id || customer?.netsuiteId || customer?.netsuite_id || "";
}

function returnCustomerCode(customer = returnCustomer()) {
  return customer?.code || customer?.entityId || customer?.entity_id || customer?.customerCode || customer?.customer_code || "";
}

function returnCustomerName(customer = returnCustomer()) {
  if (typeof customer === "string") return customer;
  return customer?.name || customer?.companyName || customer?.company_name || customer?.customerName || customer?.customer_name || "";
}

function returnOrderId(order = returnOrder()) {
  return order?.netsuiteId || order?.netsuite_id || order?.internalId || order?.internal_id || order?.id || "";
}

function returnOrderRef(order = returnOrder()) {
  return order?.tranid || order?.orderNumber || order?.order_number || returnLookupCode || "";
}

function returnLines() {
  const lines = returnLookupData?.lines || returnOrder()?.lines || [];
  return lines.filter((line) => returnLinePolicy(line).effective !== "NOT_RETURNABLE"
    && returnLineRemaining(line) > RETURN_QUANTITY_EPSILON);
}

function firstReturnLineId(lines = returnLines()) {
  if (returnMode === "pallet" || !lines.length) return "PALLET";
  const first = lines.find((line) => returnLinePolicy(line).effective !== "NOT_RETURNABLE") || lines[0];
  return first ? returnSourceLineId(first) : "";
}

function returnSourceLineId(line) {
  return String(line?.sourceLineId || line?.source_line_id || line?.lineId || line?.line_id || line?.id || "");
}

function returnLineName(line) {
  return line?.itemName || line?.item_name || line?.sku || line?.item || line?.displayName || line?.display_name || returnSourceLineId(line);
}

function returnLineDescription(line) {
  return line?.description || line?.itemDescription || line?.item_description || "";
}

function returnLinePolicy(line) {
  const policy = line?.returnPolicy || line?.return_policy || {};
  const effective = String(policy.effective || line?.returnPolicyEffective || line?.return_policy_effective || "NOT_RETURNABLE")
    .trim()
    .toUpperCase()
    .replaceAll(" ", "_");
  return {
    effective,
    requiresApproval: Boolean(policy.requiresApproval ?? policy.requires_approval ?? effective === "APPROVAL_REQUIRED")
  };
}

function returnPolicyLabel(line) {
  const effective = returnLinePolicy(line).effective;
  if (effective === "ALLOWED") return t("operator.returnAllowed", "Allowed");
  if (effective === "APPROVAL_REQUIRED") return t("operator.returnApprovalRequired", "Approval Required");
  return t("operator.returnNotReturnable", "Not Returnable");
}

function returnPolicyClass(line) {
  const effective = returnLinePolicy(line).effective;
  if (effective === "ALLOWED") return "allowed";
  if (effective === "APPROVAL_REQUIRED") return "approval";
  return "blocked";
}

function returnBalanceValue(balance, camel, snake = "") {
  return Number(balance?.[camel] ?? balance?.[snake || camel] ?? 0) || 0;
}

function currentPalletBalance() {
  return returnPalletBalance || returnLookupData?.palletBalance || returnLookupData?.pallet_balance || null;
}

function returnBalanceAvailable(balance = currentPalletBalance()) {
  return returnBalanceValue(balance, "available", "available");
}

function displayReturnQty(value, zero = "0") {
  const number = Number(value);
  if (!Number.isFinite(number)) return zero;
  return number.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function renderReturnBalance(balance, { unit = "PALLET" } = {}) {
  if (!balance) {
    return `<div class="sync-alert"><strong>${t("operator.balanceUnavailable", "Balance unavailable")}</strong><span>${t("operator.balanceUnavailableHelp", "A successful NetSuite lookup is required before submission.")}</span></div>`;
  }
  const lookedUpAt = balance.lookedUpAt || balance.looked_up_at || balance.lookupTimestamp || balance.lookup_timestamp;
  return `
    <div class="return-balance-grid">
      <div><span>${t("operator.fulfilled", "Fulfilled")}</span><strong>${displayReturnQty(returnBalanceValue(balance, "fulfilled", "fulfilled"))} ${escapeHtml(unit)}</strong></div>
      <div><span>${t("operator.netsuiteReturned", "NetSuite returned")}</span><strong>${displayReturnQty(returnBalanceValue(balance, "netsuiteReturned", "netsuite_returned"))} ${escapeHtml(unit)}</strong></div>
      <div><span>${t("operator.localReserved", "Local reserved")}</span><strong>${displayReturnQty(returnBalanceValue(balance, "localReserved", "local_reserved"))} ${escapeHtml(unit)}</strong></div>
      <div class="available"><span>${t("operator.availableToReturn", "Available to return")}</span><strong>${displayReturnQty(returnBalanceAvailable(balance))} ${escapeHtml(unit)}</strong></div>
    </div>
    ${lookedUpAt ? `<small class="return-lookup-time">${tf("operator.checkedAt", "Checked {time}", { time: formatDateTime(lookedUpAt) })}</small>` : ""}
  `;
}

function returnYardName(value) {
  if (!value) return "";
  if (typeof value !== "object") return String(value);
  return String(value.yardCode || value.yard_code || value.code || value.name || value.text || value.locationName || value.location_name || value.id || "");
}

function returnYardGate() {
  const data = returnLookupData || {};
  const blocked = returnMode === "stock" && (
    data.crossYardBlocked === true
    || data.cross_yard_blocked === true
    || data.returnAllowed === false
    || data.return_allowed === false
  );
  const required = data.requiredReturnLocation || data.required_return_location || data.defaultReturnLocation || data.default_return_location || null;
  const requiredName = returnYardName(required);
  return { blocked, requiredName: requiredName || "" };
}

function renderReturnYardBanner() {
  const gate = returnYardGate();
  if (gate.blocked) {
    return `
      <div class="sync-alert danger">
        <strong>${t("operator.wrongReturnYard", "Wrong return yard")}</strong>
        <span>${tf("operator.returnMustBeProcessedAt", "This return must be processed at {yard}.", { yard: gate.requiredName || "-" })}</span>
      </div>
    `;
  }
  const order = returnOrder();
  if (!order) return "";
  const orderingYard = returnLookupData?.defaultReturnLocationName
    || returnLookupData?.default_return_location_name
    || order.orderingLocationName
    || order.ordering_location_name
    || "";
  return `
    <div class="return-yard-banner">
      <span>${t("operator.receivingYardLocked", "Receiving yard (locked)")}</span>
      <strong>${escapeHtml(currentLocation()?.text || locationId)}</strong>
      ${orderingYard ? `<em>${tf("operator.orderingYard", "Ordering yard: {yard}", { yard: orderingYard })}</em>` : ""}
    </div>
  `;
}

function normalizeReturnReason(reason, fallbackId = "") {
  if (typeof reason === "string" || typeof reason === "number") {
    return { id: String(fallbackId || reason), label: String(reason) };
  }
  return {
    id: String(reason?.id || reason?.internalId || reason?.internal_id || reason?.value || fallbackId || ""),
    label: String(reason?.label || reason?.text || reason?.name || "")
  };
}

function applyReturnReasons(payload = {}) {
  const normal = payload.normalReason || payload.normal_reason;
  const quality = payload.qualityReasons || payload.quality_reasons || payload.reasons;
  const yardSettings = payload.yardSettings || payload.yard_settings;
  if (normal) returnReasons.normalReason = normalizeReturnReason(normal, "10");
  if (Array.isArray(quality) && quality.length) {
    returnReasons.qualityReasons = quality
      .map((reason) => normalizeReturnReason(reason))
      .filter((reason) => reason.id && reason.id !== String(returnReasons.normalReason.id));
  }
  if (Array.isArray(yardSettings)) returnYardSettings = yardSettings;
}

function returnOrderPrefixYard(orderRef) {
  return RETURN_ORDER_PREFIX_YARDS[String(orderRef || "").trim().slice(0, 3).toUpperCase()] || null;
}

function currentReturnYardSetting() {
  return returnYardSettings.find((setting) => Number(
    setting?.locationId ?? setting?.location_id ?? setting?.id
  ) === Number(locationId)) || null;
}

function currentYardAllowsCrossYardReturns() {
  const setting = currentReturnYardSetting();
  return setting?.allowCrossYardReturns === true || setting?.allow_cross_yard_returns === true;
}

function returnLookupYardPreflight(orderRef) {
  const requiredYard = returnOrderPrefixYard(orderRef);
  if (!requiredYard
      || Number(requiredYard.locationId) === Number(locationId)
      || currentYardAllowsCrossYardReturns()) {
    return { blocked: false, requiredYard };
  }
  return { blocked: true, requiredYard };
}

function returnOrderNotFullyFulfilledMessage() {
  return t(
    "operator.orderNotFullyFulfilled",
    "This Sales Order is not fully fulfilled. NetSuite status must show fully fulfilled before recording a return."
  );
}

function returnLineEntryMode(line) {
  const stated = String(line?.entryMode || line?.entry_mode || "").toLowerCase();
  if (stated === "sales_uom" || stated === "sales" || stated === "fallback") return "sales_uom";
  return returnLineUnits(line).length ? "physical" : "sales_uom";
}

function returnLineUnits(line) {
  return [
    { key: "pallets", label: "PLT", conversion: Number(line?.toPlt ?? line?.to_plt ?? 0) || 0 },
    { key: "layers", label: "LYR", conversion: Number(line?.toLyr ?? line?.to_lyr ?? 0) || 0 },
    { key: "sections", label: "SEC", conversion: Number(line?.toSec ?? line?.to_sec ?? 0) || 0 },
    { key: "pieces", label: "PCS", conversion: Number(line?.toPcs ?? line?.to_pcs ?? 0) || 0 }
  ].filter((unit) => unit.conversion > 0);
}

function returnLineSalesUom(line) {
  return line?.salesUom || line?.sales_uom || line?.unit || line?.uom || t("operator.salesUnit", "Sales UOM");
}

function returnLineRemaining(line) {
  return Number(line?.remainingReturnable ?? line?.remaining_returnable ?? 0) || 0;
}

function ensureReturnLineValue(line, rowKey = returnSourceLineId(line)) {
  const sourceLineId = returnSourceLineId(line);
  const key = String(rowKey || sourceLineId);
  if (!returnLineValues[key]) {
    returnLineValues[key] = {
      clientRowKey: key,
      sourceLineId,
      pallets: 0,
      layers: 0,
      sections: 0,
      pieces: 0,
      salesQuantity: 0,
      reasonId: "",
      reasonLabel: "",
      note: "",
      photos: []
    };
  }
  return returnLineValues[key];
}

function returnRowsForLine(line) {
  const sourceLineId = returnSourceLineId(line);
  const rows = Object.values(returnLineValues).filter((values) => String(values.sourceLineId || "") === sourceLineId);
  if (!rows.length) rows.push(ensureReturnLineValue(line));
  return rows;
}

function returnLineForValues(values) {
  return returnLines().find((line) => returnSourceLineId(line) === String(values?.sourceLineId || ""));
}

function defaultReturnPhotoTarget({ open = true } = {}) {
  if (returnMode === "pallet") return { kind: "pallet", lineId: "", open };
  if (returnType === "quality") {
    const rows = Object.values(returnLineValues);
    const firstRow = rows.find((values) => {
      const line = returnLineForValues(values);
      return line && returnLinePolicy(line).effective !== "NOT_RETURNABLE";
    }) || rows[0];
    if (firstRow) return { kind: "line", lineId: String(firstRow.clientRowKey || ""), open };
  }
  return { kind: "record", lineId: "", open };
}

function returnLineCalculatedSalesQty(line, values = ensureReturnLineValue(line)) {
  if (returnLineEntryMode(line) === "sales_uom") return Number(values.salesQuantity) || 0;
  return returnLineUnits(line).reduce((total, unit) => total + ((Number(values[unit.key]) || 0) * unit.conversion), 0);
}

function returnLineHasQty(line, values = ensureReturnLineValue(line)) {
  return returnLineCalculatedSalesQty(line, values) > 0;
}

function returnTargetPhotos(target = returnPhotoTarget) {
  if (target?.kind === "pallet") return returnPalletPhotos;
  if (target?.kind === "line") {
    const values = returnLineValues[String(target.lineId || "")];
    return values?.photos || [];
  }
  return returnRecordPhotos;
}

function setReturnTargetPhotos(photos, target = returnPhotoTarget) {
  if (target?.kind === "pallet") {
    returnPalletPhotos = photos;
    return;
  }
  if (target?.kind === "line") {
    const values = returnLineValues[String(target.lineId || "")];
    if (values) values.photos = photos;
    return;
  }
  returnRecordPhotos = photos;
}

function returnPhotoTargetLabel(target = returnPhotoTarget) {
  if (target?.kind === "pallet") return t("operator.palletEvidence", "PALLET evidence");
  if (target?.kind === "line") {
    const line = returnLineForValues(returnLineValues[String(target.lineId || "")]);
    return `${t("operator.qualityEvidence", "Quality evidence")} — ${returnLineName(line || {})}`;
  }
  return returnMode === "pallet"
    ? t("operator.palletEvidence", "PALLET evidence")
    : returnType === "quality"
      ? t("operator.qualityEvidence", "Quality evidence")
      : t("operator.normalReturnEvidence", "Normal return evidence");
}

function returnPhotoCount(kind, lineId = "") {
  return returnTargetPhotos({ kind, lineId }).filter(Boolean).length;
}

function returnReviewPhotoTargets() {
  const targets = [];
  const selectedRows = returnSelectedRows();
  if (returnMode === "stock" && selectedRows.length) {
    if (returnType === "quality") {
      selectedRows.forEach(({ line, values }, index) => {
        const reason = returnReasons.qualityReasons
          .find((item) => String(item.id) === String(values.reasonId));
        targets.push({
          kind: "line",
          lineId: String(values.clientRowKey || ""),
          label: returnLineName(line),
          detail: reason?.label || tf("operator.returnReasonRow", "Return reason row {number}", { number: index + 1 })
        });
      });
    } else {
      targets.push({
        kind: "record",
        lineId: "",
        label: t("operator.normalReturnEvidence", "Normal return evidence"),
        detail: tf("operator.stockLineCount", "{count} stock line(s)", { count: selectedRows.length })
      });
    }
  }
  if (Number(returnPalletQuantity) > 0) {
    targets.push({
      kind: "pallet",
      lineId: "",
      label: t("operator.palletEvidence", "PALLET evidence"),
      detail: tf("operator.palletCount", "{count} PALLET", { count: displayReturnQty(returnPalletQuantity) })
    });
  }
  return targets;
}

function returnPhotoTargetsMatch(left, right) {
  return String(left?.kind || "") === String(right?.kind || "")
    && String(left?.lineId || "") === String(right?.lineId || "");
}

function selectReturnReviewPhotoTarget(target, { preferMissing = false } = {}) {
  const targets = returnReviewPhotoTargets();
  const requested = targets.find((candidate) => returnPhotoTargetsMatch(candidate, target));
  const nextTarget = requested
    || (preferMissing ? targets.find((candidate) => returnPhotoCount(candidate.kind, candidate.lineId) < 1) : null)
    || targets[0]
    || defaultReturnPhotoTarget({ open: false });
  returnPhotoTarget = {
    kind: nextTarget.kind,
    lineId: String(nextTarget.lineId || ""),
    open: returnCameraActive
  };
  const photos = returnTargetPhotos();
  const firstEmpty = photos.findIndex((photo) => !photo);
  returnPhotoSlot = firstEmpty >= 0 ? firstEmpty : Math.max(0, photos.length - 1);
}

function renderReturnPhotoWorkspace() {
  const targets = returnReviewPhotoTargets();
  const photos = returnTargetPhotos();
  const selected = photos[returnPhotoSlot] || "";
  const readyTargets = targets.filter((target) => returnPhotoCount(target.kind, target.lineId) > 0).length;
  return `
    <div class="fulfillment-card return-photo-workspace return-review-photo-card">
      <span>${t("operator.photoProof", "Photo proof")}</span>
      <strong>${escapeHtml(returnPhotoTargetLabel())}</strong>
      <div class="return-evidence-heading">
        <span>${t("operator.evidenceTargets", "Required evidence")}</span>
        <b>${tf("operator.evidenceReady", "{ready} / {total} ready", { ready: readyTargets, total: targets.length })}</b>
      </div>
      <div class="return-evidence-targets">
        ${targets.map((target) => {
          const active = returnPhotoTargetsMatch(target, returnPhotoTarget);
          const count = returnPhotoCount(target.kind, target.lineId);
          return `
            <button class="${active ? "active" : ""} ${count ? "ready" : ""}" data-action="return-select-evidence-target" data-photo-kind="${escapeHtml(target.kind)}" data-line="${escapeHtml(target.lineId)}" type="button">
              <strong>${escapeHtml(target.label)}</strong>
              <span>${escapeHtml(target.detail || "")}</span>
              <b>${count} / ${RETURN_MAX_PHOTOS}</b>
            </button>
          `;
        }).join("")}
      </div>
      <div class="camera-actions">
        <button class="primary-button" data-action="return-start-camera" type="button">${returnCameraActive ? t("common.restartCamera", "Restart camera") : t("common.openCamera", "Open camera")}</button>
        ${renderCameraSwitchButton("return-switch-camera")}
        ${returnCameraActive ? `<button class="secondary-button" data-action="return-close-camera" type="button">${t("common.closeCamera", "Close camera")}</button>` : ""}
      </div>
      <div class="photo-slot-row return-photo-slots">
        ${Array.from({ length: Math.max(1, photos.length) }, (_, index) => `
          <button class="${index === returnPhotoSlot ? "active" : ""}" data-action="return-select-photo-slot" data-slot="${index}" type="button">
            <strong>${t("common.photos", "Photo")} ${index + 1}</strong>
            <span>${photos[index] ? t("common.ready", "Ready") : t("common.needed", "Needed")}</span>
          </button>
        `).join("")}
      </div>
      ${returnCameraActive ? `
        <video class="camera-preview ${cameraCaptureMode() === "user" ? "mirrored" : ""}" id="returnCamera" autoplay muted playsinline></video>
        <button class="primary-button" data-action="return-capture-photo" type="button">${t("operator.capturePhoto", "Capture photo")}</button>
      ` : selected ? `
        <img class="photo-preview" ${photoImgAttributes(selected)} alt="${escapeHtml(returnPhotoTargetLabel())}" />
      ` : `
        <div class="photo-placeholder">${t("operator.liveCameraOnly", "Use the live PWA camera to take return evidence.")}</div>
      `}
      <div class="photo-list-actions">
        <button class="secondary-button" data-action="return-add-photo" ${photos.length >= RETURN_MAX_PHOTOS ? "disabled" : ""} type="button">${t("common.addAnotherPhoto", "Add another photo")}</button>
        <button class="secondary-button danger-button" data-action="return-remove-photo" ${!selected ? "disabled" : ""} type="button">${t("common.removeSelected", "Remove selected")}</button>
      </div>
    </div>
  `;
}

function renderReturnLookup() {
  const palletMode = returnMode === "pallet";
  return `
    <section class="return-lookup-grid">
      <div class="return-card return-scanner-card">
        <div class="return-panel-heading">
          <div>
            <span>${t("operator.scanSalesOrder", "Scan sales order")}</span>
            <strong>${t("operator.allSalesOrders", "SOA / SOB / SOM")}</strong>
          </div>
        </div>
        <div class="scanner-ready-banner">
          <b>${t("operator.scannerReady", "Scanner ready")}</b>
          <span>${t("operator.returnScannerHelp", "Scan the Sales Order barcode to identify the exact customer and ordering yard.")}</span>
        </div>
        <div class="camera-actions">
          <button class="primary-button" data-action="return-start-scanner" ${returnBusy ? "disabled" : ""} type="button">${returnScannerActive ? t("common.restartCamera", "Restart camera") : t("common.openCamera", "Open camera")}</button>
          ${renderCameraSwitchButton("return-switch-scanner-camera")}
        </div>
        ${returnScannerActive ? `
          <div class="barcode-scanner-viewport${cameraFacingMode === "user" ? " mirrored" : ""}" id="returnScannerCamera">
            <div class="barcode-scan-guide" aria-hidden="true"><span></span></div>
          </div>
        ` : `<div class="photo-placeholder">${t("operator.scannerHelp", "Use the camera for 1D/QR barcodes, the Zebra scanner, or type the sales order number.")}</div>`}
      </div>
      <div class="return-card return-lookup-card">
        ${returnMode === "stock" ? `
          <div class="return-type-toggle">
            <button class="${returnType === "normal" ? "active" : ""}" data-action="return-set-type" data-return-type="normal" type="button">
              <strong>${t("operator.normalStockReturn", "Normal Stock Return")}</strong>
              <span>GD — ${t("operator.goodCondition", "Good Condition")}</span>
            </button>
            <button class="${returnType === "quality" ? "active" : ""}" data-action="return-set-type" data-return-type="quality" type="button">
              <strong>${t("operator.qualityReturn", "Quality Issue Return")}</strong>
              <span>R1–R5</span>
            </button>
          </div>
        ` : ""}
        <label class="return-field">
          <span>${t("operator.manualInput", "Manual / Zebra input")}</span>
          <input id="returnOrderLookup" value="${escapeHtml(returnLookupCode)}" placeholder="SOB115976" autocomplete="off" />
        </label>
        <button class="primary-button" data-action="return-lookup-order" ${returnBusy ? "disabled" : ""} type="button">${returnBusy ? t("common.loading", "Loading") : t("operator.findOrder", "Find Order")}</button>
        ${returnLookupMessage ? `<div class="sync-alert danger"><strong>${t("common.notice", "Notice")}</strong><span>${escapeHtml(localizeMessage(returnLookupMessage))}</span></div>` : ""}
        ${palletMode ? `
          <div class="return-divider"><span>${t("operator.orSearchCustomer", "or search customer directly")}</span></div>
          <label class="return-field">
            <span>${t("operator.customerCodeNamePhone", "Customer code, name, or phone")}</span>
            <input id="returnCustomerSearch" value="${escapeHtml(returnCustomerSearch)}" placeholder="${t("common.search", "Search")}" autocomplete="off" />
          </label>
          <div class="return-customer-results">
            ${returnCustomerSearchBusy ? `<div class="empty-state small"><strong>${t("common.loading", "Loading")}</strong></div>` : returnCustomerResults.map((customer) => `
              <button data-action="return-select-customer" data-customer-id="${escapeHtml(returnCustomerId(customer))}" type="button">
                <strong>${escapeHtml([returnCustomerCode(customer), returnCustomerName(customer)].filter(Boolean).join(" — "))}</strong>
                <span>${escapeHtml(customer.phone || customer.phoneNumber || customer.phone_number || "")}</span>
                <em>${escapeHtml(customer.address || customer.primaryAddress || customer.primary_address || "")}</em>
              </button>
            `).join("") || (returnCustomerSearch.trim().length >= 2 ? `<div class="empty-state small"><strong>${t("operator.noActiveCustomers", "No active customers found")}</strong></div>` : "")}
          </div>
        ` : ""}
      </div>
    </section>
  `;
}

function renderReturnCustomerSummary() {
  const customer = returnCustomer();
  const order = returnOrder();
  return `
    <div class="return-customer-summary">
      <div>
        <span>${t("operator.customer", "Customer")}</span>
        <strong>${escapeHtml([returnCustomerCode(customer), returnCustomerName(customer)].filter(Boolean).join(" — ") || "-")}</strong>
        <em>${escapeHtml(customer?.address || customer?.primaryAddress || customer?.primary_address || "")}</em>
      </div>
      ${order ? `
        <div>
          <span>${t("operator.salesOrder", "Sales Order")}</span>
          <strong>${escapeHtml(returnOrderRef(order))}</strong>
          <em>${t("operator.exactNetsuiteLines", "Exact NetSuite fulfillment lines")}</em>
        </div>
      ` : ""}
      <div>
        <span>${t("operator.receivingYard", "Receiving yard")}</span>
        <strong>${escapeHtml(currentLocation()?.text || locationId)}</strong>
        <em>${t("operator.yardLockedAfterStart", "Locked for this draft")}</em>
      </div>
    </div>
  `;
}

function renderReturnPalletSection() {
  const balance = currentPalletBalance();
  const available = returnBalanceAvailable(balance);
  const selected = returnActiveLineId === "PALLET";
  const over = Number(returnPalletQuantity) > available + RETURN_QUANTITY_EPSILON;
  return `
    <button class="return-pallet-compact ${selected ? "active" : ""} ${over ? "over" : ""}" data-action="return-select-stock-line" data-source-line="PALLET" type="button">
      <div class="return-pallet-identity">
        <span>${t("operator.customerLevel", "Customer level")}</span>
        <strong>${t("operator.palletReturn", "Pallet Return")}</strong>
      </div>
      <div class="return-pallet-compact-balance">
        <span>${t("operator.availableToReturn", "Available to return")} <b>${balance ? displayReturnQty(available) : "—"}</b></span>
        <span>${t("operator.palletsReturned", "PALLET returned")} <b data-return-pallet-proposed>${displayReturnQty(returnPalletQuantity)}</b></span>
        <span>${t("common.photos", "Photos")} <b>${returnPalletPhotos.filter(Boolean).length} / ${RETURN_MAX_PHOTOS}</b></span>
      </div>
      <span class="return-policy-pill allowed">${t("operator.alwaysEligibleWithinQuota", "Allowed within quota")}</span>
    </button>
  `;
}

function renderReturnPalletEditor() {
  const balance = currentPalletBalance();
  const available = returnBalanceAvailable(balance);
  const standalone = returnMode === "pallet";
  return `
    <aside class="return-selected-editor pallet-editor">
      <div class="return-panel-heading">
        <div>
          <span>${t("operator.customerLevel", "Customer level")}</span>
          <strong>${t("operator.palletReturn", "Pallet Return")}</strong>
        </div>
        <span class="return-policy-pill allowed">${t("operator.alwaysEligibleWithinQuota", "Allowed within quota")}</span>
      </div>
      ${renderReturnBalance(balance)}
      <div class="return-selected-editor-controls">
        <div class="return-quantity-field">
          <span>${standalone ? t("operator.palletsReturned", "PALLET returned") : t("operator.optionalPalletsReturned", "Optional PALLET returned")}</span>
          ${renderReturnQuantityStepper({
            value: returnPalletQuantity,
            kind: "pallet",
            field: "palletQuantity",
            label: standalone ? t("operator.palletsReturned", "PALLET returned") : t("operator.optionalPalletsReturned", "Optional PALLET returned")
          })}
        </div>
      </div>
      <div class="sync-alert danger" data-return-pallet-over ${Number(returnPalletQuantity) > available + RETURN_QUANTITY_EPSILON ? "" : "hidden"}>
        <strong>${t("operator.overPalletQuota", "PALLET quantity exceeds quota")}</strong>
        <span>${tf("operator.maximumReturnable", "Maximum returnable: {quantity}", { quantity: displayReturnQty(available) })}</span>
      </div>
    </aside>
  `;
}

function renderReturnQuantityStepper({
  value = 0,
  kind = "line",
  field = "",
  lineId = "",
  step = 1,
  label = ""
} = {}) {
  const numericValue = Math.max(0, Number(value) || 0);
  const shared = `
    data-return-quantity-kind="${escapeHtml(kind)}"
    data-return-quantity-field="${escapeHtml(field)}"
    data-return-quantity-step="${escapeHtml(step)}"
    ${kind === "pallet" ? 'data-return-input="palletQuantity"' : `data-return-line-input="${escapeHtml(field)}" data-line="${escapeHtml(lineId)}"`}
  `;
  return `
    <div class="return-quantity-stepper" role="group" aria-label="${escapeHtml(label)}">
      <button data-action="return-step-quantity" data-delta="-1" ${shared} ${numericValue <= 0 ? "disabled" : ""} type="button" aria-label="${t("operator.decreaseQuantity", "Decrease quantity")}">−</button>
      <output data-return-quantity-value aria-live="polite">${displayReturnQty(numericValue)}</output>
      <button data-action="return-step-quantity" data-delta="1" ${shared} type="button" aria-label="${t("operator.increaseQuantity", "Increase quantity")}">+</button>
    </div>
  `;
}

function renderReturnUnitInputs(line, values) {
  const rowKey = values.clientRowKey;
  if (returnLineEntryMode(line) === "sales_uom") {
    return `
      <div class="stepper-field return-unit-field sales-uom">
        <span>${escapeHtml(returnLineSalesUom(line))}</span>
        ${renderReturnQuantityStepper({
          value: values.salesQuantity,
          field: "salesQuantity",
          lineId: rowKey,
          label: returnLineSalesUom(line)
        })}
      </div>
    `;
  }
  return returnLineUnits(line).map((unit) => `
    <div class="stepper-field return-unit-field">
      <span>${unit.label}</span>
      ${renderReturnQuantityStepper({
        value: values[unit.key],
        field: unit.key,
        lineId: rowKey,
        label: unit.label
      })}
      <small>× ${displayReturnQty(unit.conversion)} ${escapeHtml(returnLineSalesUom(line))}</small>
    </div>
  `).join("");
}

function renderReturnStockRow(line, values, rowIndex) {
  const rowKey = values.clientRowKey;
  const calculated = returnLineCalculatedSalesQty(line, values);
  const remaining = returnLineRemaining(line);
  return `
    <div class="return-line-entry-row" data-return-row="${escapeHtml(rowKey)}">
      ${returnType === "quality" ? `
        <div class="return-split-row-heading">
          <strong>${tf("operator.returnReasonRow", "Return reason row {number}", { number: rowIndex + 1 })}</strong>
          ${rowIndex > 0 ? `<button class="danger-button" data-action="return-remove-split-row" data-line="${escapeHtml(rowKey)}" type="button">${t("operator.removeRow", "Remove row")}</button>` : ""}
        </div>
      ` : ""}
      <div class="return-line-inputs">${renderReturnUnitInputs(line, values)}</div>
      <div class="return-calculated-qty ${calculated > remaining + RETURN_QUANTITY_EPSILON ? "over" : ""}" data-return-calculated>
        <span>${t("operator.calculatedSalesQuantity", "Calculated Sales UOM quantity")}</span>
        <strong data-return-calculated-value>${displayReturnQty(calculated)} ${escapeHtml(returnLineSalesUom(line))}</strong>
        <em>${tf("operator.maximumReturnable", "Maximum returnable: {quantity}", { quantity: `${displayReturnQty(remaining)} ${returnLineSalesUom(line)}` })}</em>
      </div>
      ${returnType === "quality" ? `
        <div class="return-quality-fields">
          <label class="return-field">
            <span>${t("operator.netsuiteReason", "NetSuite reason")}</span>
            <select data-return-line-input="reasonId" data-line="${escapeHtml(rowKey)}">
              <option value="">${t("operator.selectReason", "Select reason")}</option>
              ${returnReasons.qualityReasons.map((reason) => `<option value="${escapeHtml(reason.id)}" ${String(values.reasonId) === String(reason.id) ? "selected" : ""}>${escapeHtml(reason.label)}</option>`).join("")}
            </select>
          </label>
          <label class="return-field">
            <span>${t("operator.shortNoteOptional", "Short note (optional)")}</span>
            <input data-return-line-input="note" data-line="${escapeHtml(rowKey)}" value="${escapeHtml(values.note)}" maxlength="250" />
          </label>
        </div>
      ` : ""}
    </div>
  `;
}

function renderReturnStockLine(line) {
  const lineId = returnSourceLineId(line);
  const rows = returnRowsForLine(line);
  const policy = returnLinePolicy(line);
  const disabled = policy.effective === "NOT_RETURNABLE";
  const active = String(returnActiveLineId) === lineId;
  const remaining = returnLineRemaining(line);
  const proposedTotal = rows.reduce((total, values) => total + returnLineCalculatedSalesQty(line, values), 0);
  const over = proposedTotal > remaining + RETURN_QUANTITY_EPSILON;
  const fulfilled = Number(line.fulfilledQuantity ?? line.fulfilled_quantity ?? 0) || 0;
  const netsuiteReturned = Number(line.netsuiteReturned ?? line.netsuite_returned ?? 0) || 0;
  const localReserved = Number(line.localReserved ?? line.local_reserved ?? 0) || 0;
  const selectedRows = rows.filter((values) => returnLineHasQty(line, values));
  const photoCount = selectedRows.reduce((total, values) => total + values.photos.filter(Boolean).length, 0);
  return `
    <button class="return-line-card ${disabled ? "disabled" : ""} ${active ? "active" : ""} ${over ? "over" : ""}" data-return-line-card="${escapeHtml(lineId)}" data-action="return-select-stock-line" data-source-line="${escapeHtml(lineId)}" type="button">
      <div class="return-line-identity">
        <strong>${escapeHtml(returnLineName(line))}</strong>
        <span>${escapeHtml(returnLineDescription(line))}</span>
        <em>${tf("operator.sourceLine", "Source line {line}", { line: escapeHtml(lineId) })}</em>
      </div>
      <div class="return-line-card-measures">
        <span>${t("operator.remaining", "Remaining")} <b>${displayReturnQty(remaining)} ${escapeHtml(returnLineSalesUom(line))}</b></span>
        <span>${t("operator.returning", "Returning")} <b data-return-line-proposed>${displayReturnQty(proposedTotal)} ${escapeHtml(returnLineSalesUom(line))}</b></span>
        <small>${t("operator.fulfilled", "Fulfilled")} ${displayReturnQty(fulfilled)} · ${t("operator.netsuiteReturned", "NetSuite returned")} ${displayReturnQty(netsuiteReturned)} · ${t("operator.localReserved", "Local reserved")} ${displayReturnQty(localReserved)}</small>
      </div>
      <div class="return-line-state">
        <span class="return-policy-pill ${returnPolicyClass(line)}">${returnPolicyLabel(line)}</span>
        ${returnType === "quality" && selectedRows.length ? `<small>${selectedRows.length} ${t("operator.reasonRows", "reason row(s)")} · ${photoCount} ${t("common.photos", "photos")}</small>` : ""}
      </div>
    </button>
  `;
}

function returnSelectedStockLine() {
  if (!returnActiveLineId || returnActiveLineId === "PALLET") return null;
  return returnLines().find((line) => returnSourceLineId(line) === String(returnActiveLineId)) || null;
}

function renderReturnSelectedLineEditor() {
  if (returnActiveLineId === "PALLET" || returnMode === "pallet") return renderReturnPalletEditor();
  const line = returnSelectedStockLine();
  if (!line) {
    return `
      <aside class="return-selected-editor">
        <div class="empty-state">
          <strong>${t("operator.selectStockLine", "Select an order item")}</strong>
          <span>${t("operator.selectStockLineHelp", "Choose a line in the middle list to enter its returned quantity.")}</span>
        </div>
      </aside>
    `;
  }
  const lineId = returnSourceLineId(line);
  const rows = returnRowsForLine(line);
  const disabled = returnLinePolicy(line).effective === "NOT_RETURNABLE";
  const remaining = returnLineRemaining(line);
  const proposedTotal = rows.reduce((total, values) => total + returnLineCalculatedSalesQty(line, values), 0);
  const over = proposedTotal > remaining + RETURN_QUANTITY_EPSILON;
  const fulfilled = Number(line.fulfilledQuantity ?? line.fulfilled_quantity ?? 0) || 0;
  const netsuiteReturned = Number(line.netsuiteReturned ?? line.netsuite_returned ?? 0) || 0;
  const localReserved = Number(line.localReserved ?? line.local_reserved ?? 0) || 0;
  const primaryValues = rows[0] || ensureReturnLineValue(line);
  const salesUom = returnLineSalesUom(line);
  return `
    <aside class="return-selected-editor" data-return-line-editor-card="${escapeHtml(lineId)}">
      <div class="return-panel-heading">
        <div>
          <span>${t("operator.selectedReturnItem", "Selected return item")}</span>
          <strong>${escapeHtml(returnLineName(line))}</strong>
          <em>${escapeHtml(returnLineDescription(line))}</em>
        </div>
        <span class="return-policy-pill ${returnPolicyClass(line)}">${returnPolicyLabel(line)}</span>
      </div>
      <div class="return-balance-grid return-stock-balance-grid">
        <div><span>${t("operator.fulfilled", "Fulfilled")}</span><strong>${displayReturnQty(fulfilled)} ${escapeHtml(salesUom)}</strong></div>
        <div><span>${t("operator.netsuiteReturned", "NetSuite returned")}</span><strong>${displayReturnQty(netsuiteReturned)} ${escapeHtml(salesUom)}</strong></div>
        <div><span>${t("operator.localReserved", "Local reserved")}</span><strong>${displayReturnQty(localReserved)} ${escapeHtml(salesUom)}</strong></div>
        <div class="available"><span>${t("operator.remaining", "Remaining")}</span><strong>${displayReturnQty(remaining)} ${escapeHtml(salesUom)}</strong></div>
      </div>
      ${disabled ? `
        <div class="sync-alert danger"><strong>${t("operator.returnNotReturnable", "Not Returnable")}</strong><span>${t("operator.itemPolicyBlocksReturn", "The company-wide Item Master policy blocks this product.")}</span></div>
      ` : `
        <div class="return-selected-line-editor">
          ${rows.map((values, index) => renderReturnStockRow(line, values, index)).join("")}
          ${returnType === "normal" ? `
            <div class="return-normal-editor-fields">
              <div class="return-fixed-reason"><span>${t("operator.netsuiteReason", "NetSuite reason")}</span><strong>${escapeHtml(returnReasons.normalReason.label || "GD - Good Condition")}</strong></div>
              <label class="return-field">
                <span>${t("operator.shortNoteOptional", "Short note (optional)")}</span>
                <input data-return-line-input="note" data-line="${escapeHtml(primaryValues.clientRowKey)}" value="${escapeHtml(primaryValues.note)}" maxlength="250" />
              </label>
            </div>
          ` : ""}
          <div class="sync-alert danger" data-return-line-over ${over ? "" : "hidden"}>
            <strong>${t("operator.overReturnableQuantity", "Quantity exceeds remaining returnable")}</strong>
            <span data-return-line-over-value>${displayReturnQty(proposedTotal)} / ${displayReturnQty(remaining)} ${escapeHtml(returnLineSalesUom(line))}</span>
          </div>
          ${returnType === "quality" ? `<button class="secondary-button return-add-split" data-action="return-add-split-row" data-source-line="${escapeHtml(lineId)}" type="button">${t("operator.addAnotherReason", "Add another reason / quantity")}</button>` : ""}
        </div>
      `}
    </aside>
  `;
}

function updateReturnPhotoRequirement(kind, lineId, required) {
  const button = [...app.querySelectorAll(`.return-photo-button[data-photo-kind="${kind}"]`)]
    .find((candidate) => String(candidate.dataset.line || "") === String(lineId || ""));
  if (!button) return;
  button.dataset.photoRequired = required ? "true" : "false";
  const label = button.querySelector("[data-return-photo-requirement]");
  if (label) {
    label.textContent = required
      ? t("operator.photoRequired", "Photo required")
      : t("common.optional", "Optional");
  }
}

function stepReturnQuantity(button) {
  const kind = String(button?.dataset?.returnQuantityKind || "");
  const field = String(button?.dataset?.returnQuantityField || "");
  const delta = Number(button?.dataset?.delta || 0);
  const step = Math.max(0, Number(button?.dataset?.returnQuantityStep || 1)) || 1;
  if (!delta || !field) return;

  let currentValue = 0;
  let values = null;
  if (kind === "pallet" && field === "palletQuantity") {
    currentValue = Number(returnPalletQuantity) || 0;
  } else {
    values = returnLineValues[String(button.dataset.line || "")];
    if (!values || !["pallets", "layers", "sections", "pieces", "salesQuantity"].includes(field)) return;
    currentValue = Number(values[field]) || 0;
  }

  const nextValue = Math.max(0, Math.round((currentValue + (delta * step)) * 1_000_000) / 1_000_000);
  if (kind === "pallet") returnPalletQuantity = nextValue;
  else values[field] = nextValue;
  returnDirty = true;

  const stepper = button.closest(".return-quantity-stepper");
  const output = stepper?.querySelector("[data-return-quantity-value]");
  if (output) output.textContent = displayReturnQty(nextValue);
  const decrease = stepper?.querySelector('[data-action="return-step-quantity"][data-delta="-1"]');
  if (decrease) decrease.disabled = nextValue <= 0;
  refreshReturnQuantityFeedback(button);
}

function refreshReturnQuantityFeedback(target) {
  if (target?.dataset?.returnInput === "palletQuantity") {
    const balance = currentPalletBalance();
    const over = Number(returnPalletQuantity) > returnBalanceAvailable(balance) + RETURN_QUANTITY_EPSILON;
    const alert = app.querySelector("[data-return-pallet-over]");
    if (alert) alert.hidden = !over;
    const selector = app.querySelector(".return-pallet-compact");
    selector?.classList.toggle("over", over);
    const proposed = selector?.querySelector("[data-return-pallet-proposed]");
    if (proposed) proposed.textContent = displayReturnQty(returnPalletQuantity);
    updateReturnPhotoRequirement(
      "pallet",
      "",
      returnMode === "pallet" || Number(returnPalletQuantity) > 0
    );
    return;
  }
  if (!target?.dataset?.returnLineInput) return;
  const values = returnLineValues[String(target.dataset.line || "")];
  const line = returnLineForValues(values);
  if (!values || !line) return;
  const calculated = returnLineCalculatedSalesQty(line, values);
  const remaining = returnLineRemaining(line);
  const row = target.closest("[data-return-row]");
  const calculatedBox = row?.querySelector("[data-return-calculated]");
  calculatedBox?.classList.toggle("over", calculated > remaining + RETURN_QUANTITY_EPSILON);
  const calculatedValue = row?.querySelector("[data-return-calculated-value]");
  if (calculatedValue) {
    calculatedValue.textContent = `${displayReturnQty(calculated)} ${returnLineSalesUom(line)}`;
  }
  if (returnType === "quality") {
    updateReturnPhotoRequirement("line", values.clientRowKey, calculated > 0);
  } else {
    updateReturnPhotoRequirement("record", "", returnSelectedRows().length > 0);
  }
  const proposedTotal = returnRowsForLine(line)
    .reduce((total, candidate) => total + returnLineCalculatedSalesQty(line, candidate), 0);
  const editor = target.closest("[data-return-line-editor-card]");
  const overAlert = editor?.querySelector("[data-return-line-over]");
  if (overAlert) overAlert.hidden = !(proposedTotal > remaining + RETURN_QUANTITY_EPSILON);
  const overValue = editor?.querySelector("[data-return-line-over-value]");
  if (overValue) {
    overValue.textContent = `${displayReturnQty(proposedTotal)} / ${displayReturnQty(remaining)} ${returnLineSalesUom(line)}`;
  }
  const listCard = [...app.querySelectorAll("[data-return-line-card]")]
    .find((candidate) => String(candidate.dataset.returnLineCard || "") === returnSourceLineId(line));
  listCard?.classList.toggle("over", proposedTotal > remaining + RETURN_QUANTITY_EPSILON);
  const proposedValue = listCard?.querySelector("[data-return-line-proposed]");
  if (proposedValue) {
    proposedValue.textContent = `${displayReturnQty(proposedTotal)} ${returnLineSalesUom(line)}`;
  }
}

function renderReturnStockLines() {
  const lines = returnLines();
  const visible = pageItems(lines, returnLinePage, RETURN_LINE_PAGE_SIZE);
  return `
    <section class="return-stock-selector-panel">
      <div class="return-section-heading">
        <div>
          <span>${returnType === "quality" ? t("operator.qualityReturn", "Quality Issue Return") : t("operator.normalStockReturn", "Normal Stock Return")}</span>
          <h2>${t("operator.orderItems", "Order items")}</h2>
        </div>
        <span>${lines.length} ${t("common.lines", "lines")}</span>
      </div>
      <div class="return-line-list">
        ${visible.map(renderReturnStockLine).join("") || `<div class="empty-state small"><strong>${t("operator.noReturnableOrderLines", "No stock lines found")}</strong></div>`}
      </div>
      <div class="pagination-row">
        <button class="secondary-button" data-action="return-line-prev" ${returnLinePage <= 0 ? "disabled" : ""} type="button">${t("common.previous", "Previous")}</button>
        <strong>${lines.length ? `${returnLinePage + 1} / ${pageCount(lines, RETURN_LINE_PAGE_SIZE)}` : "0 / 0"}</strong>
        <button class="secondary-button" data-action="return-line-next" ${returnLinePage >= pageCount(lines, RETURN_LINE_PAGE_SIZE) - 1 ? "disabled" : ""} type="button">${t("common.next", "Next")}</button>
      </div>
      <div class="return-pallet-selector-footer">
        ${renderReturnPalletSection()}
      </div>
    </section>
  `;
}

function renderReturnPalletSelectorPanel() {
  return `
    <section class="return-stock-selector-panel pallet-only-selector">
      <div class="return-section-heading">
        <div>
          <span>${t("operator.customerLevel", "Customer level")}</span>
          <h2>${t("operator.returnItems", "Return items")}</h2>
        </div>
      </div>
      <div class="return-pallet-selector-footer">
        ${renderReturnPalletSection()}
      </div>
    </section>
  `;
}

function renderReturnForm() {
  return `
    <section class="return-form-shell ${returnMode === "stock" ? "stock-return-form" : "pallet-return-form"}">
      ${renderReturnCustomerSummary()}
      ${renderReturnYardBanner()}
      ${returnValidationMessage ? `<div class="sync-alert danger"><strong>${t("operator.returnNeedsAttention", "Return needs attention")}</strong><span>${escapeHtml(returnValidationMessage)}</span></div>` : ""}
      <div class="return-form-grid return-quantity-grid">
        ${returnMode === "stock" ? renderReturnStockLines() : renderReturnPalletSelectorPanel()}
        ${renderReturnSelectedLineEditor()}
      </div>
      <div class="return-bottom-actions">
        <button class="secondary-button" data-action="return-save-draft" ${returnBusy ? "disabled" : ""} type="button">${returnBusy ? t("common.saving", "Saving...") : t("operator.saveDraft", "Save Draft")}</button>
        <button class="primary-button" data-action="return-open-review" ${returnBusy || returnYardGate().blocked ? "disabled" : ""} type="button">${t("operator.reviewReturn", "Review Return")}</button>
      </div>
    </section>
  `;
}

function returnSelectedRows() {
  return Object.values(returnLineValues)
    .map((values) => ({ values, line: returnLineForValues(values) }))
    .filter(({ line, values }) => line && returnLineHasQty(line, values));
}

function renderReturnReviewLine({ line, values }) {
  const reason = returnType === "normal"
    ? returnReasons.normalReason
    : returnReasons.qualityReasons.find((item) => String(item.id) === String(values.reasonId)) || { label: values.reasonLabel || "-" };
  return `
    <div class="return-review-line">
      <div>
        <strong>${escapeHtml(returnLineName(line))}</strong>
        <span class="return-review-reason">${escapeHtml(reason.label || "-")}</span>
        ${values.note ? `<em>${escapeHtml(values.note)}</em>` : ""}
      </div>
      <b>${displayReturnQty(returnLineCalculatedSalesQty(line, values))} ${escapeHtml(returnLineSalesUom(line))}</b>
      <span class="return-policy-pill ${returnPolicyClass(line)}">${returnPolicyLabel(line)}</span>
      ${returnType === "quality" ? `<small>${values.photos.filter(Boolean).length} ${t("common.photos", "photos")}</small>` : ""}
    </div>
  `;
}

function renderReturnPalletReviewLine() {
  if (Number(returnPalletQuantity) <= RETURN_QUANTITY_EPSILON) return "";
  return `
    <div class="return-review-line pallet-return-review-line">
      <div>
        <strong>${t("operator.palletReturn", "Pallet Return")}</strong>
        <span>${t("operator.customerLevel", "Customer level")}</span>
      </div>
      <b>${displayReturnQty(returnPalletQuantity)} PALLET</b>
      <span class="return-policy-pill allowed">${t("operator.alwaysEligibleWithinQuota", "Allowed within quota")}</span>
      <small>${returnPalletPhotos.filter(Boolean).length} ${t("common.photos", "photos")}</small>
    </div>
  `;
}

function renderReturnPhotoSummary(photos, label) {
  const visible = (photos || []).filter(Boolean);
  if (!visible.length) return "";
  return `
    <div class="return-review-photos">
      <strong>${escapeHtml(label)}</strong>
      <div>
        ${visible.map((photo, index) => `<button data-action="open-history-photo" data-photo-ref="${escapeHtml(photo)}" data-photo-label="${escapeHtml(label)} ${index + 1}" type="button"><img ${photoImgAttributes(photo)} alt="${escapeHtml(label)} ${index + 1}" /></button>`).join("")}
      </div>
    </div>
  `;
}

function renderReturnReview() {
  const selectedRows = returnSelectedRows();
  const palletReviewLine = renderReturnPalletReviewLine();
  const reviewReference = returnOrderRef() || returnCustomerName();
  return `
    <section class="fulfillment-screen return-review-screen">
      ${renderReturnPhotoWorkspace()}
      <div class="fulfillment-card return-review-details-card">
        <span>${t("operator.finalReview", "Final review")}</span>
        <div class="return-review-header">
          <div>
            <strong>${escapeHtml(reviewReference)}</strong>
            <small>${returnMode === "stock" ? (returnType === "quality" ? t("operator.qualityReturn", "Quality Issue Return") : t("operator.normalStockReturn", "Normal Stock Return")) : t("operator.palletReturn", "Pallet Return")}</small>
          </div>
          <span class="status-pill open">${t("common.review", "Review")}</span>
        </div>
        <div class="return-review-detail-scroll">
          ${renderReturnCustomerSummary()}
          ${renderReturnYardBanner()}
          ${returnValidationMessage ? `
            <div class="sync-alert danger" data-return-review-validation>
              <strong>${t("operator.returnNeedsAttention", "Return needs attention")}</strong>
              <span>${escapeHtml(returnValidationMessage)}</span>
            </div>
          ` : ""}
          ${selectedRows.length || palletReviewLine ? `
            <div class="fulfillment-lines return-review-lines">
              ${palletReviewLine}
              ${selectedRows.map(renderReturnReviewLine).join("")}
            </div>
          ` : ""}
          <div class="sync-alert">
            <strong>${t("operator.finalValidationNotice", "Final validation runs when you confirm")}</strong>
            <span>${t("operator.finalValidationHelp", "NetSuite and local reservations will be rechecked. Both linked records are saved atomically.")}</span>
          </div>
          <div class="return-review-entry-fields">
            <label class="return-field">
              <span>${t("operator.vehiclePlate", "Vehicle plate")} · ${t("operator.requiredBeforeConfirm", "Required before confirm")}</span>
              <input data-return-input="vehiclePlate" value="${escapeHtml(returnVehiclePlate)}" autocomplete="off" maxlength="32" />
              <small>${t("operator.vehiclePlateHelp", "Enter the plate of the vehicle that brought the return.")}</small>
            </label>
            <label class="return-field">
              <span>${t("operator.returnNoteOptional", "Return note (optional)")}</span>
              <textarea data-return-input="headerNote" maxlength="500" placeholder="${t("operator.returnNoteHelp", "Add a short note for this return or PALLET record.")}">${escapeHtml(returnHeaderNote)}</textarea>
            </label>
          </div>
        </div>
      </div>
      <div class="selected-actions return-review-actions">
        <button class="secondary-button" data-action="return-back-to-form" ${returnBusy ? "disabled" : ""} type="button">${t("common.back", "Back")}</button>
        <button class="primary-button" data-action="return-confirm-submit" ${returnBusy ? "disabled" : ""} type="button">${returnBusy ? t("operator.confirming", "Confirming...") : t("operator.confirmReturn", "Confirm Return")}</button>
      </div>
    </section>
  `;
}

function renderReturnSuccess() {
  const batch = returnResult?.batchReference || returnResult?.batch_reference || "";
  const stock = returnResult?.stockReturn || returnResult?.stock_return || null;
  const pallet = returnResult?.palletReturn || returnResult?.pallet_return || null;
  const referenceOf = (record) => record?.reference || record?.returnReference || record?.return_reference || "";
  const statusOf = (record) => record?.status || "";
  return `
    <section class="return-success-shell">
      <div class="return-success-mark">✓</div>
      <span>${t("operator.returnRecorded", "Return recorded")}</span>
      <h2>${escapeHtml(batch || referenceOf(stock) || referenceOf(pallet))}</h2>
      <p>${t("operator.returnRecordedHelp", "The local records are saved in PostgreSQL. Inventory was not changed.")}</p>
      <div class="return-created-records">
        ${stock ? `<div><span>${t("operator.stockReturn", "Stock Return")}</span><strong>${escapeHtml(referenceOf(stock))}</strong><em>${escapeHtml(localizeMessage(statusOf(stock)))}</em></div>` : ""}
        ${pallet ? `<div><span>${t("operator.palletReturn", "Pallet Return")}</span><strong>${escapeHtml(referenceOf(pallet))}</strong><em>${escapeHtml(localizeMessage(statusOf(pallet)))}</em></div>` : ""}
      </div>
      <div class="return-bottom-actions">
        <button class="secondary-button" data-action="return-open-history-view" type="button">${t("common.history", "History")}</button>
        <button class="primary-button" data-action="return-new" type="button">${t("operator.newReturn", "New Return")}</button>
      </div>
    </section>
  `;
}

function returnRecordReference(record) {
  return record?.batchReference || record?.batch_reference || record?.reference || record?.returnReference || record?.return_reference || record?.id || "";
}

function returnSavedPhotoReference(photo) {
  return typeof photo === "string"
    ? photo
    : photo?.reference || photo?.photoReference || photo?.photo_reference || photo?.url || "";
}

function renderReturnHistoryDetails(record) {
  const lines = record?.lines || [];
  const headerPhotos = (record?.photos || []).map(returnSavedPhotoReference).filter(Boolean);
  const palletQuantity = record?.palletQuantity ?? record?.pallet_quantity;
  return `
    ${palletQuantity !== null && palletQuantity !== undefined ? `
      <div class="return-header-note">
        <span>${t("operator.palletQuantity", "PALLET quantity")}</span>
        <p>${displayReturnQty(palletQuantity)}</p>
      </div>
    ` : ""}
    ${record?.note ? `
      <div class="return-header-note">
        <span>${t("operator.returnNote", "Return note")}</span>
        <p>${escapeHtml(record.note)}</p>
      </div>
    ` : ""}
    ${lines.length ? `
      <div class="return-review-lines">
        ${lines.map((line) => `
          <div class="return-review-line">
            <div>
              <strong>${escapeHtml(line.itemName || line.item_name || line.sku || "-")}</strong>
              <span>${escapeHtml(line.reasonLabel || line.reason_label || "")}</span>
              ${line.note ? `<em>${escapeHtml(line.note)}</em>` : ""}
            </div>
            <b>${displayReturnQty(line.returnedSalesQuantity ?? line.returned_sales_quantity ?? line.salesQuantity ?? line.sales_quantity)} ${escapeHtml(line.salesUom || line.sales_uom || "")}</b>
            <span class="return-policy-pill ${String(line.approvalStatus || line.approval_status || "").includes("pending") ? "approval" : "allowed"}">${escapeHtml(localizeMessage(line.approvalStatus || line.approval_status || ""))}</span>
            <small>${(line.photos || []).length} ${t("common.photos", "photos")}</small>
          </div>
        `).join("")}
      </div>
    ` : ""}
    ${renderReturnPhotoSummary(headerPhotos, t("common.photos", "Photos"))}
    ${lines.map((line) => renderReturnPhotoSummary(
      (line.photos || []).map(returnSavedPhotoReference).filter(Boolean),
      line.itemName || line.item_name || t("common.line", "Line")
    )).join("")}
    ${(record.netSuiteTransactionRef || record.net_suite_transaction_ref || record.netSuiteSyncStatus || record.net_suite_sync_status) ? `
      <div class="sync-alert">
        <strong>${escapeHtml(record.netSuiteTransactionRef || record.net_suite_transaction_ref || t("operator.netsuiteSync", "NetSuite sync"))}</strong>
        <span>${escapeHtml(localizeMessage(record.netSuiteSyncStatus || record.net_suite_sync_status || ""))}${record.netSuiteSyncError || record.net_suite_sync_error ? ` — ${escapeHtml(record.netSuiteSyncError || record.net_suite_sync_error)}` : ""}</span>
      </div>
    ` : ""}
  `;
}

function renderReturnRecordList(records, type) {
  const selected = records.find((record) => String(record.id) === String(returnSelectedRecordId)) || records[0] || null;
  const detail = type === "history" && String(returnHistoryDetail?.id) === String(selected?.id)
    ? returnHistoryDetail
    : selected;
  return `
    <section class="return-records-shell">
      <div class="return-record-list">
        ${records.map((record) => `
          <button class="${String(record.id) === String(selected?.id) ? "active" : ""}" data-action="return-select-${type}" data-record="${escapeHtml(record.id)}" type="button">
            <span>${escapeHtml(record.returnType || record.return_type || record.type || "")}</span>
            <strong>${escapeHtml(returnRecordReference(record))}</strong>
            <em>${formatDateTime(record.submittedAt || record.submitted_at || record.updatedAt || record.updated_at || record.createdAt || record.created_at)}</em>
            <b>${escapeHtml(localizeMessage(record.status || (type === "draft" ? t("operator.draft", "Draft") : "")))}</b>
          </button>
        `).join("") || `<div class="empty-state"><strong>${type === "draft" ? t("operator.noReturnDrafts", "No return drafts") : t("operator.noReturnHistory", "No return history")}</strong></div>`}
        ${type === "history" ? `
          <div class="pagination-row">
            <button class="secondary-button" data-action="return-history-prev" ${returnHistoryOffset <= 0 ? "disabled" : ""} type="button">${t("common.previous", "Previous")}</button>
            <strong>${returnHistoryTotal
              ? `${returnHistoryOffset + 1}–${Math.min(returnHistoryOffset + records.length, returnHistoryTotal)} / ${returnHistoryTotal}`
              : "0 / 0"}</strong>
            <button class="secondary-button" data-action="return-history-next" ${returnHistoryOffset + records.length >= returnHistoryTotal ? "disabled" : ""} type="button">${t("common.next", "Next")}</button>
          </div>
        ` : ""}
      </div>
      <div class="return-record-detail">
        ${detail ? `
          <div class="return-review-header">
            <div><span>${type === "draft" ? t("operator.draft", "Draft") : t("common.history", "History")}</span><h2>${escapeHtml(returnRecordReference(detail))}</h2></div>
            <span class="status-pill open">${escapeHtml(localizeMessage(detail.status || ""))}</span>
          </div>
          <div class="return-review-meta">
            <div><span>${t("operator.salesOrder", "Sales Order")}</span><strong>${escapeHtml(detail.sourceSalesOrderRef || detail.source_sales_order_ref || detail.orderRef || detail.order_ref || "-")}</strong></div>
            <div><span>${t("operator.customer", "Customer")}</span><strong>${escapeHtml(detail.customerName || detail.customer_name || "-")}</strong></div>
            <div><span>${t("operator.vehiclePlate", "Vehicle plate")}</span><strong>${escapeHtml(detail.vehiclePlate || detail.vehicle_plate || "-")}</strong></div>
            ${(detail.palletQuantity ?? detail.pallet_quantity) !== null
                && (detail.palletQuantity ?? detail.pallet_quantity) !== undefined
              ? `<div><span>${t("operator.palletQuantity", "PALLET quantity")}</span><strong>${displayReturnQty(detail.palletQuantity ?? detail.pallet_quantity)}</strong></div>`
              : ""}
          </div>
          ${type === "draft" && detail.note ? `<div class="return-header-note"><span>${t("operator.returnNote", "Return note")}</span><p>${escapeHtml(detail.note)}</p></div>` : ""}
          ${type === "history" ? renderReturnHistoryDetails(detail) : ""}
          ${type === "draft" ? `
            <div class="return-bottom-actions">
              <button class="danger-button" data-action="return-delete-draft" data-record="${escapeHtml(detail.id)}" type="button">${t("operator.discardDraft", "Discard Draft")}</button>
              <button class="primary-button" data-action="return-resume-draft" data-record="${escapeHtml(detail.id)}" type="button">${t("operator.resumeDraft", "Resume Draft")}</button>
            </div>
          ` : ""}
        ` : ""}
      </div>
    </section>
  `;
}

function renderReturnWorkflow() {
  const actions = `
    <button class="secondary-button" data-action="return-back-select" type="button">${t("common.back", "Back")}</button>
    <button class="${returnView === "drafts" ? "primary-button" : "secondary-button"}" data-action="return-open-drafts" type="button">${t("operator.drafts", "Drafts")}${returnDrafts.length ? ` (${returnDrafts.length})` : ""}</button>
    <button class="${returnView === "history" ? "primary-button" : "secondary-button"}" data-action="return-open-history-view" type="button">${t("common.history", "History")}</button>
    <button class="secondary-button" data-action="logout" type="button">${escapeHtml(operator.display_name)}</button>
  `;
  let body;
  if (returnView === "drafts") body = renderReturnRecordList(returnDrafts, "draft");
  else if (returnView === "history") body = renderReturnRecordList(returnHistory, "history");
  else if (returnStage === "form") body = renderReturnForm();
  else if (returnStage === "review") body = renderReturnReview();
  else if (returnStage === "success") body = renderReturnSuccess();
  else body = renderReturnLookup();
  shell(returnModuleTitle(), `${t("common.location", "Location")} ${currentLocation()?.text || locationId}`, body, actions);
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
  const count = pageCount(options, CYCLE_OPTION_PAGE_SIZE);
  cyclePage = Math.min(cyclePage, count - 1);
  const visible = pageItems(options, cyclePage, CYCLE_OPTION_PAGE_SIZE);
  return `
    <div class="cycle-option-grid">
      ${visible.map((option) => `
        <button class="module-tile compact" data-action="cycle-select" data-value="${option.value}" type="button">
          <strong>${option.value || t("operator.unassigned", "Unassigned")}</strong>
          <span>${option.count} SKU</span>
        </button>
      `).join("") || `<div class="empty-state small"><strong>${t("operator.noOptions", "No options")}</strong><span>${t("operator.syncInventoryFirst", "Sync inventory first.")}</span></div>`}
    </div>
    <div class="pagination-row cycle-option-pagination">
      <button class="secondary-button" data-action="cycle-prev" ${cyclePage === 0 ? "disabled" : ""} type="button">${t("common.previous", "Previous")}</button>
      <strong>${cyclePage + 1} / ${count}</strong>
      <button class="secondary-button" data-action="cycle-next" ${cyclePage >= count - 1 ? "disabled" : ""} type="button">${t("common.next", "Next")}</button>
    </div>
  `;
}

function currentCyclePageCount() {
  return cycleSearch.trim() || cycleStep === "sku"
    ? pageCount(inventoryItems, LINE_PAGE_SIZE)
    : pageCount(currentCycleOptions(), CYCLE_OPTION_PAGE_SIZE);
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

function renderReloadMarker(order) {
  return order?.reload_authorized
    ? `<span class="status-pill warning reload-marker">RE-LOAD</span>`
    : "";
}

function isPackedReloadReady(order) {
  if (!order?.reload_authorized) return false;
  const cycle = order.reload_cycle || order.reloadCycle;
  if (cycle) return String(cycle.status || "") === "packed";
  const cycles = Array.isArray(order.reload_cycles) ? order.reload_cycles : [];
  return cycles.length > 0 && cycles.every((item) => String(item?.status || "") === "packed");
}

function deliveryLoadAction(order, mode = "active") {
  const reloadReady = isPackedReloadReady(order);
  return {
    reloadReady,
    show: reloadReady || mode === "packed",
    label: reloadReady ? "Take Photos & Re-load" : t("common.load", "Load"),
    allowPackedQuantityEdit: !reloadReady,
    showEditPacking: reloadReady
  };
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
            <strong>${order.tranid}${order.testFixture ? ` <span class="status-pill test-fixture">TEST</span>` : ""} ${renderReloadMarker(order)}</strong>
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
  const loadAction = deliveryLoadAction(order, viewMode);

  return `
    <div class="detail-header">
      <div>
        <div class="order-title-row">
          <h2>${order.tranid}${order.testFixture ? ` <span class="status-pill test-fixture">TEST</span>` : ""} ${renderReloadMarker(order)}</h2>
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
            : loadAction.show
              ? `<button class="primary-button" data-action="start-fulfill" type="button">${loadAction.label}</button>`
              : `<button class="secondary-button" data-action="set-preparing" type="button">${t("operator.preparing", "Preparing")}</button>
                 <button class="primary-button" data-action="set-packed" type="button" ${canMarkPacked(order) ? "" : "disabled"}>${t("operator.packed", "Packed")}</button>`}
      </div>
    </div>
    <div class="progress-strip">
      <div><span>${vrmaReferenceOnly ? t("operator.referenceLines", "Reference lines") : isCustomerPickupMode() ? t("operator.pickupLines", "Pickup lines") : viewMode === "packed" ? t("operator.packedLines", "Packed lines") : t("operator.openLines", "Open lines")}</span><strong>${vrmaReferenceOnly ? lines.length : confirmed} / ${lines.length}</strong></div>
      <div><span>${t("common.location", "Location")}</span><strong>${currentLocation()?.text}</strong></div>
      <div><span>${t("operator.status", "Status")}</span><strong>${directPickupInfo ? t("operator.directPickup", "Direct pickup") : orderStatusText(order)}</strong></div>
    </div>
    ${order.reload_authorized ? `
      <div class="sync-alert reload-notice">
        <strong>Local-only re-load</strong>
        <span>${escapeHtml(order.reload_reason || order.reload_cycle?.reason || "Authorized by Control")}</span>
        <em>Pack and photograph this physical load again. Canonical Sales Order fulfillment and Dispatch stay unchanged.</em>
      </div>
    ` : ""}
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
  const isReloadLoad = Boolean(order.reload_authorized);
  if (fulfillmentResult) {
    const isPickupLoad = currentModule === "customer-pickup-load";
    return shell(t("operator.loadComplete", "Load Complete"), `${t("common.order", "Order")} ${order.tranid}`, `
      <section class="fulfillment-screen">
        <div class="fulfillment-card success">
          <span>${isPickupLoad ? t("operator.pickupStatus", "Pickup Status") : t("operator.localYardStatus", "Local Yard Status")}</span>
          <strong>${isPickupLoad ? (fulfillmentResult.pickupStatus === "partial_loaded" ? t("operator.partialLoaded", "Partial Loaded") : t("common.loaded", "Loaded")) : isReloadLoad ? (fulfillmentResult.completed ? "Re-load Complete" : "Re-load Partially Loaded") : (fulfillmentResult.localYardOrderStatus || t("common.loaded", "Loaded"))}</strong>
          <p>${isPickupLoad ? tf("operator.photoSavedRemaining", "Photo proof saved. Remaining line count: {count}.", { count: fulfillmentResult.remainingLines || 0 }) : isReloadLoad ? "This re-load attempt was saved locally. NetSuite fulfillment and Dispatch were not changed." : t("operator.photoSavedHidden", "Photo proof saved. This order is hidden from the operator list.")}</p>
        </div>
        <div class="selected-actions">
          <button class="primary-button" data-action="finish-fulfill" type="button">${isPickupLoad ? t("operator.backToScan", "Back to Scan") : t("operator.backToDelivery", "Back to Delivery")}</button>
        </div>
      </section>
    `, `<button class="secondary-button" data-action="finish-fulfill" type="button">${t("operator.deliveryPrep", "Delivery")}</button>`);
  }
  return shell(t("operator.loadOrder", "Load Order"), `${order.tranid} | ${t("common.location", "Location")} ${currentLocation()?.text || ""}`, `
    <section class="fulfillment-screen ${isReloadLoad ? "reload-fulfillment-screen" : ""}">
      ${isReloadLoad ? `<div class="sync-alert reload-notice"><strong>Local-only re-load</strong><span>${escapeHtml(order.reload_reason || order.reload_cycle?.reason || "")}</span></div>` : ""}
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
        ${fulfillmentSubmitting ? `<div class="sync-alert"><strong>${localizeMessage(fulfillmentJobStage || t("operator.savingLoadProof", "Saving load proof"))}</strong><span>${localizeMessage(fulfillmentStatusText || t("operator.savingLocalYardStatus", "Saving local yard status..."))}<span data-fulfillment-upload-elapsed>${fulfillmentStartedAt ? ` (${Math.max(1, Math.round((Date.now() - fulfillmentStartedAt) / 1000))}s)` : ""}</span></span></div>` : ""}
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
  const loadAction = deliveryLoadAction(selectedOrder, viewMode);
  const packedReview = viewMode === "packed" || loadAction.reloadReady;
  const showConfirmPage = currentModule === "delivery" && !packedReview;
  const packedActions = loadAction.allowPackedQuantityEdit
    ? notice
      ? `<button class="secondary-button danger-button" data-action="unpack-line" data-line="${line.id}" type="button">${t("operator.unpackPackedQty", "Unpack packed qty")}</button>`
      : `<button class="primary-button" data-action="update-packed-line" data-line="${line.id}" type="button">${t("operator.updatePackedQty", "Update packed qty")}</button>
         <button class="secondary-button danger-button" data-action="unpack-line" data-line="${line.id}" type="button">${t("operator.unpackPackedQty", "Unpack packed qty")}</button>`
    : `<button class="primary-button" data-action="start-fulfill" type="button">${loadAction.label}</button>
       <button class="secondary-button" data-action="edit-reload-packing" type="button">Edit packing</button>`;
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
      ${notice || !loadAction.allowPackedQuantityEdit ? "" : units.map((unit) => renderStepper(unit.key, `${packedReview ? t("operator.packed", "Packed") : t("operator.pack", "Pack")} ${unit.label}`, panelValue(line, unit.key))).join("")}
      ${packedReview
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

function removeDeliveryOrderFromLocalState(order) {
  const key = deliveryOrderKey(order);
  if (!key) return;
  const withoutOrder = (list) => Array.isArray(list)
    ? list.filter((item) => deliveryOrderKey(item) !== key)
    : list;
  orders = withoutOrder(orders);
  deliveryOrderBuckets.active = withoutOrder(deliveryOrderBuckets.active);
  deliveryOrderBuckets.packed = withoutOrder(deliveryOrderBuckets.packed);
  selectedId = filteredDeliveryOrders()[0]?.netsuite_id || null;
  selectedOrder = null;
  selectedLineId = null;
  orderPage = Math.min(orderPage, pageCount(filteredDeliveryOrders(), DELIVERY_ORDER_PAGE_SIZE) - 1);
  linePage = 0;
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
  deliveryOrdersLoadingCount += 1;
  try {
    return await loadOrdersRequest(options);
  } finally {
    deliveryOrdersLoadingCount = Math.max(0, deliveryOrdersLoadingCount - 1);
  }
}

async function loadOrdersRequest(options = {}) {
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
  const requestLocationId = String(locationId);
  const previous = deliveryNotifications;
  if (!deliveryNotificationsRequest || deliveryNotificationsRequest.locationId !== requestLocationId) {
    const promise = api(`/api/delivery/notifications?locationId=${requestLocationId}`)
      .catch(() => previous || { total: 0, salesOrder: { dueToday: 0 }, transferOrder: { dueToday: 0 }, items: [] })
      .finally(() => {
        if (deliveryNotificationsRequest?.promise === promise) deliveryNotificationsRequest = null;
      });
    deliveryNotificationsRequest = { locationId: requestLocationId, promise };
  }
  const nextNotifications = await deliveryNotificationsRequest.promise;
  if (String(locationId) !== requestLocationId) return deliveryNotifications;
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

function createOperatorUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Math.floor(Math.random() * 4)];
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

async function editReloadPacking() {
  if (!selectedOrder || !isPackedReloadReady(selectedOrder)) return;
  const orderId = selectedOrder.netsuite_id;
  markLocalDeliveryMutation(orderId);
  try {
    const result = await api(`/api/delivery/orders/${encodeURIComponent(orderId)}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "preparing" })
    });
    viewMode = "active";
    deliveryOrderBuckets = { active: null, packed: null };
    selectedId = orderId;
    selectedOrder = result.order || selectedOrder;
    showToast("Re-load moved back to Preparing");
    await loadOrders({ keepSelection: true });
  } finally {
    finishLocalDeliveryMutation(orderId);
  }
}

async function startFulfillment() {
  if (!selectedOrder) return;
  let order = selectedOrder;
  if (order.reload_authorized) {
    const refreshed = await api(`/api/delivery/orders/${encodeURIComponent(order.netsuite_id)}`);
    acceptRefreshedDeliveryOrder(refreshed, { renderPanels: false });
    if (!isPackedReloadReady(refreshed)) {
      showToast("Pack this re-load before taking photos.");
      if (currentModule === "delivery") renderDeliveryPanels();
      return;
    }
    order = refreshed;
  }
  fulfillmentOrder = order;
  fulfillmentReturnModule = currentModule;
  fulfillmentPhotoDataUrls = [];
  fulfillmentActivePhotoSlot = 0;
  fulfillmentResult = null;
  fulfillmentSubmitting = false;
  fulfillmentStatusText = "";
  fulfillmentJobStage = "";
  fulfillmentStartedAt = 0;
  fulfillmentValidation = null;
  fulfillmentLoadRequestId = createOperatorUuid();
  selectRearCamera();
  currentModule = isCustomerPickupMode() ? "customer-pickup-load" : "delivery-fulfill";
  render();
  if (order.reload_authorized) await startFulfillmentCamera();
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
    if (fulfillmentSubmitting) updateUploadElapsed("[data-fulfillment-upload-elapsed]", fulfillmentStartedAt);
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
      body: JSON.stringify({
        photoDataUrls: uploadedPhotoRefs,
        requestId: fulfillmentLoadRequestId,
        locationId
      })
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
  const completedOrder = fulfillmentOrder;
  currentModule = wasPickup ? "customer-pickup-scan" : returnModule;
  fulfillmentOrder = null;
  fulfillmentPhotoDataUrls = [];
  fulfillmentActivePhotoSlot = 0;
  fulfillmentResult = null;
  fulfillmentStatusText = "";
  fulfillmentJobStage = "";
  fulfillmentValidation = null;
  fulfillmentStartedAt = 0;
  fulfillmentLoadRequestId = "";
  fulfillmentReturnModule = "delivery";
  viewMode = "active";
  if (wasPickup) {
    selectedId = null;
    selectedOrder = null;
    customerPickupScan = "";
    return render();
  }
  removeDeliveryOrderFromLocalState(completedOrder);
  render();
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
        ${receiptSubmitting ? `<div class="sync-alert"><strong>${localizeMessage(receiptJobStage || t("operator.recordingLocally", "Recording locally"))}</strong><span>${localizeMessage(receiptStatusText || t("operator.savingReceivingRecord", "Saving receiving record..."))}<span data-receipt-upload-elapsed>${receiptStartedAt ? ` (${Math.max(1, Math.round((Date.now() - receiptStartedAt) / 1000))}s)` : ""}</span></span></div>` : ""}
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
    if (receiptSubmitting) updateUploadElapsed("[data-receipt-upload-elapsed]", receiptStartedAt);
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
    customer_return: t("operator.customerReturnHistory", "Customer Return"),
    stock_return: t("operator.stockReturn", "Stock Return"),
    pallet_return: t("operator.palletReturn", "Pallet Return"),
    return_batch: t("operator.returnBatch", "Return Batch")
  }[type] || type || t("operator.recordHistory", "Record");
}

function renderHistoryPhotos(record) {
  const photos = (record?.photos || []).filter(Boolean);
  if (!photos.length) return "";
  return `
    <div class="history-photo-grid">
      ${photos.map((photo, index) => `
        <button class="history-photo-button" data-action="open-history-photo" data-photo-ref="${escapeHtml(photo)}" data-photo-label="${tf("operator.recordPhotoNumber", "Record photo {number}", { number: index + 1 })}" type="button">
          <img ${photoImgAttributes(photo)} alt="${tf("operator.recordPhotoNumber", "Record photo {number}", { number: index + 1 })}" />
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
            ${line.reasonLabel || line.reasonCode
              ? `<span>${escapeHtml(line.reasonLabel || line.reasonCode)}</span>`
              : ""}
            ${line.approvalStatus
              ? `<em>${escapeHtml(localizeMessage(line.approvalStatus))}</em>`
              : ""}
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
  const details = record.details || {};
  const vehiclePlate = record.vehiclePlate || record.vehicle_plate || details.vehiclePlate || details.vehicle_plate || "";
  const customerName = record.customerName || record.customer_name || details.customerName || details.customer_name || "";
  const receivingYard = record.receivingYard || record.receiving_yard
    || details.receivingLocationName || details.receiving_location_name || "";
  const palletQuantity = record.palletQuantity ?? record.pallet_quantity
    ?? details.palletQuantity ?? details.pallet_quantity;
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
      ${(vehiclePlate || customerName || receivingYard || (palletQuantity !== null && palletQuantity !== undefined)) ? `
        <div class="progress-strip history-meta">
          <div><span>${t("operator.vehiclePlate", "Vehicle plate")}</span><strong>${escapeHtml(vehiclePlate || "-")}</strong></div>
          <div><span>${t("operator.customer", "Customer")}</span><strong>${escapeHtml(customerName || "-")}</strong></div>
          <div><span>${t("operator.receivingYard", "Receiving yard")}</span><strong>${escapeHtml(receivingYard || "-")}</strong></div>
          ${palletQuantity !== null && palletQuantity !== undefined
            ? `<div><span>${t("operator.palletQuantity", "PALLET quantity")}</span><strong>${displayReturnQty(palletQuantity)}</strong></div>`
            : ""}
        </div>
      ` : ""}
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
  if (moduleName === "pallet-return" || moduleName === "stock-return") {
    resetReturnWorkflow(moduleName === "stock-return" ? "stock" : "pallet");
    currentModule = moduleName;
    selectRearCamera();
    await loadReturnReasons().catch(() => {});
    return render();
  }
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

function createReturnIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `return-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function resetReturnWorkflow(mode = returnMode || "pallet", { keepResult = false } = {}) {
  stopReturnCamera();
  stopReturnScannerCamera();
  returnMode = mode === "stock" ? "stock" : "pallet";
  returnStage = "lookup";
  returnView = "workflow";
  returnType = "normal";
  returnLookupCode = "";
  returnLookupMessage = "";
  returnLookupData = null;
  returnCustomerSearch = "";
  returnCustomerResults = [];
  returnCustomerSearchBusy = false;
  returnCustomerSearchPending = false;
  returnCustomerSearchGeneration += 1;
  returnSelectedCustomer = null;
  returnPalletBalance = null;
  returnPalletQuantity = 0;
  returnVehiclePlate = "";
  returnHeaderNote = "";
  returnLineValues = {};
  returnLinePage = 0;
  returnActiveLineId = "";
  returnRecordPhotos = [];
  returnPalletPhotos = [];
  returnPhotoTarget = { kind: mode === "pallet" ? "pallet" : "record", lineId: "", open: false };
  returnPhotoSlot = 0;
  returnDraftId = "";
  returnHistoryDetail = null;
  returnDirty = false;
  returnBusy = false;
  returnValidationMessage = "";
  returnIdempotencyKey = createReturnIdempotencyKey();
  if (!keepResult) returnResult = null;
}

async function loadReturnReasons() {
  const payload = await api("/api/returns/reasons");
  applyReturnReasons(payload || {});
  return returnReasons;
}

function normalizeReturnLookup(payload = {}) {
  const order = payload.order || payload.salesOrder || payload.sales_order || null;
  const customer = payload.customer || order?.customer || null;
  const lines = Array.isArray(payload.lines)
    ? payload.lines
    : Array.isArray(order?.lines) ? order.lines : [];
  return {
    ...payload,
    order,
    customer,
    lines,
    palletBalance: payload.palletBalance || payload.pallet_balance || null
  };
}

async function lookupReturnOrder(code = returnLookupCode) {
  const clean = normalizedPickupCameraCode(code);
  returnLookupCode = clean;
  returnLookupMessage = "";
  if (!/^SO(?:A|B|M)\d+$/i.test(clean)) {
    returnLookupMessage = t("operator.validSalesOrderRequired", "Enter a valid SOA, SOB, or SOM Sales Order number.");
    return render();
  }
  if (returnMode === "stock") {
    const yardPreflight = returnLookupYardPreflight(clean);
    if (yardPreflight.blocked) {
      returnLookupMessage = tf(
        "operator.returnMustBeProcessedAt",
        "This return must be processed at {yard}.",
        { yard: yardPreflight.requiredYard?.yardCode || "-" }
      );
      return render();
    }
  }
  stopReturnScannerCamera();
  returnBusy = true;
  render();
  try {
    const payload = await api("/api/returns/orders/lookup", {
      method: "POST",
      body: JSON.stringify({ code: clean, receivingLocationId: locationId, mode: returnMode })
    });
    stopReturnScannerCamera();
    returnLookupData = normalizeReturnLookup(payload);
    returnSelectedCustomer = returnLookupData.customer;
    returnPalletBalance = returnLookupData.palletBalance;
    returnLineValues = {};
    for (const line of returnLines()) ensureReturnLineValue(line);
    returnActiveLineId = firstReturnLineId();
    returnPalletQuantity = 0;
    returnVehiclePlate = "";
    returnHeaderNote = "";
    returnRecordPhotos = [];
    returnPalletPhotos = [];
    returnLinePage = 0;
    returnPhotoTarget = defaultReturnPhotoTarget();
    returnPhotoSlot = 0;
    returnDraftId = "";
    returnIdempotencyKey = createReturnIdempotencyKey();
    returnDirty = false;
    returnStage = "form";
    returnView = "workflow";
    returnValidationMessage = "";
  } catch (error) {
    const code = String(error.payload?.code || "");
    returnLookupMessage = code === "CROSS_YARD_RETURN_BLOCKED"
      ? tf("operator.returnMustBeProcessedAt", "This return must be processed at {yard}.", { yard: returnYardName(error.payload.requiredReturnLocation) || "-" })
      : code === "ORDER_NOT_FULLY_FULFILLED"
        ? returnOrderNotFullyFulfilledMessage()
        : error.message;
  } finally {
    returnBusy = false;
    render();
  }
}

async function searchReturnCustomers() {
  if (returnCustomerSearchActive) {
    returnCustomerSearchPending = true;
    return;
  }
  returnCustomerSearchActive = true;
  try {
    while (true) {
      returnCustomerSearchPending = false;
      window.clearTimeout(app.returnCustomerSearchTimer);
      app.returnCustomerSearchTimer = null;
      const search = returnCustomerSearch.trim();
      const generation = returnCustomerSearchGeneration;
      if (returnMode !== "pallet" || search.length < 2) {
        returnCustomerResults = [];
        returnCustomerSearchBusy = false;
        break;
      }
      stopReturnScannerCamera();
      returnCustomerSearchBusy = true;
      render();
      try {
        const params = new URLSearchParams({
          search,
          receivingLocationId: String(locationId)
        });
        const payload = await api(`/api/returns/customers?${params.toString()}`);
        if (generation === returnCustomerSearchGeneration && search === returnCustomerSearch.trim()) {
          returnCustomerResults = Array.isArray(payload) ? payload : payload.customers || [];
        }
      } catch (error) {
        if (generation === returnCustomerSearchGeneration) {
          returnLookupMessage = error.message;
          returnCustomerResults = [];
        }
      }
      if (!returnCustomerSearchPending && generation === returnCustomerSearchGeneration) break;
    }
  } finally {
    returnCustomerSearchActive = false;
    returnCustomerSearchBusy = false;
    render();
    window.requestAnimationFrame(() => {
      const input = document.getElementById("returnCustomerSearch");
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    });
  }
}

async function selectReturnCustomer(customerId) {
  const customer = returnCustomerResults.find((item) => String(returnCustomerId(item)) === String(customerId));
  if (!customer) return;
  returnBusy = true;
  returnLookupMessage = "";
  render();
  try {
    const params = new URLSearchParams({ receivingLocationId: String(locationId) });
    const payload = await api(`/api/returns/customers/${encodeURIComponent(returnCustomerId(customer))}/pallet-balance?${params.toString()}`);
    returnSelectedCustomer = payload.customer || customer;
    returnPalletBalance = payload.balance || payload.palletBalance || payload.pallet_balance || null;
    returnLookupData = normalizeReturnLookup({
      ...payload,
      customer: returnSelectedCustomer,
      palletBalance: returnPalletBalance,
      lines: []
    });
    returnPalletQuantity = 0;
    returnVehiclePlate = "";
    returnHeaderNote = "";
    returnPalletPhotos = [];
    returnActiveLineId = "PALLET";
    returnPhotoTarget = defaultReturnPhotoTarget();
    returnPhotoSlot = 0;
    returnDraftId = "";
    returnIdempotencyKey = createReturnIdempotencyKey();
    returnDirty = false;
    returnStage = "form";
    returnView = "workflow";
  } catch (error) {
    returnLookupMessage = error.message;
  } finally {
    returnBusy = false;
    render();
  }
}

async function loadReturnDrafts({ renderAfter = true } = {}) {
  const params = new URLSearchParams({ receivingLocationId: String(locationId) });
  const payload = await api(`/api/returns/operator/drafts?${params.toString()}`);
  returnDrafts = Array.isArray(payload) ? payload : payload.drafts || [];
  if (!returnDrafts.some((item) => String(item.id) === String(returnSelectedRecordId))) {
    returnSelectedRecordId = returnDrafts[0]?.id || "";
  }
  if (renderAfter) render();
  return returnDrafts;
}

async function loadReturnHistory({ offset = returnHistoryOffset } = {}) {
  returnHistoryOffset = Math.max(0, Number(offset) || 0);
  const params = new URLSearchParams({
    limit: String(RETURN_HISTORY_PAGE_SIZE),
    offset: String(returnHistoryOffset)
  });
  const payload = await api(`/api/returns/operator/history?${params.toString()}`);
  returnHistory = Array.isArray(payload) ? payload : payload.records || payload.returns || payload.history || [];
  returnHistoryTotal = Array.isArray(payload)
    ? returnHistory.length
    : Number(payload.counts?.total ?? payload.total ?? returnHistory.length);
  if (!returnHistory.some((item) => String(item.id) === String(returnSelectedRecordId))) {
    returnSelectedRecordId = returnHistory[0]?.id || "";
  }
  returnHistoryDetail = null;
  if (returnSelectedRecordId) await loadReturnHistoryDetail(returnSelectedRecordId, { renderAfter: false });
  render();
}

async function loadReturnHistoryDetail(id, { renderAfter = true } = {}) {
  if (!id) {
    returnHistoryDetail = null;
    if (renderAfter) render();
    return null;
  }
  const payload = await api(`/api/returns/operator/history/${encodeURIComponent(id)}`);
  returnHistoryDetail = payload.record || payload.return || payload;
  if (renderAfter) render();
  return returnHistoryDetail;
}

function draftReturnMode(draft) {
  const type = String(draft?.returnMode || draft?.return_mode || draft?.mode || draft?.type || "").toLowerCase();
  if (type.includes("pallet")) return "pallet";
  if (type.includes("stock") || type.includes("combined")) return "stock";
  return draft?.orderId || draft?.order_id ? "stock" : "pallet";
}

async function resumeReturnDraft(draft, { renderAfter = true } = {}) {
  if (!draft) return;
  stopReturnCamera();
  stopReturnScannerCamera();
  const mode = draftReturnMode(draft);
  returnMode = mode;
  currentModule = mode === "stock" ? "stock-return" : "pallet-return";
  returnType = String(draft.stockReturnType || draft.stock_return_type || draft.returnType || draft.return_type || "normal").toLowerCase() === "quality"
    ? "quality"
    : "normal";
  returnDraftId = String(draft.id || draft.draftId || draft.draft_id || "");
  returnIdempotencyKey = String(draft.idempotencyKey || draft.idempotency_key || createReturnIdempotencyKey());
  returnLookupCode = String(draft.orderRef || draft.order_ref || draft.tranid || "");
  let lookup = draft.lookup || draft.lookupData || draft.lookup_data || null;
  if (!lookup && returnLookupCode) {
    lookup = await api("/api/returns/orders/lookup", {
      method: "POST",
      body: JSON.stringify({ code: returnLookupCode, receivingLocationId: locationId, mode })
    });
  }
  if (!lookup && (draft.customerId || draft.customer_id)) {
    const params = new URLSearchParams({ receivingLocationId: String(locationId) });
    const payload = await api(`/api/returns/customers/${encodeURIComponent(draft.customerId || draft.customer_id)}/pallet-balance?${params.toString()}`);
    lookup = { ...payload, palletBalance: payload.balance || payload.palletBalance };
  }
  returnLookupData = normalizeReturnLookup(lookup || draft);
  returnSelectedCustomer = returnLookupData.customer || draft.customer || null;
  returnPalletBalance = returnLookupData.palletBalance || draft.palletBalance || draft.pallet_balance || null;
  returnPalletQuantity = Number(draft.palletQuantity ?? draft.pallet_quantity ?? 0) || 0;
  returnVehiclePlate = draft.vehiclePlate || draft.vehicle_plate || "";
  returnHeaderNote = draft.note || draft.headerNote || draft.header_note || "";
  returnRecordPhotos = [...(draft.photos || draft.stockPhotos || draft.stock_photos || [])];
  returnPalletPhotos = [...(draft.palletPhotos || draft.pallet_photos || [])];
  returnLineValues = {};
  const savedLines = draft.lines || [];
  for (const line of returnLines()) ensureReturnLineValue(line);
  const restoredSources = new Set();
  for (const saved of savedLines) {
    const sourceLineId = String(saved.sourceLineId || saved.source_line_id || saved.lineId || saved.line_id || "");
    const source = returnLines().find((item) => returnSourceLineId(item) === sourceLineId);
    if (!source) continue;
    const firstForSource = !restoredSources.has(sourceLineId);
    restoredSources.add(sourceLineId);
    const rowKey = String(saved.clientRowKey || saved.client_row_key || (firstForSource ? sourceLineId : createReturnIdempotencyKey()));
    if (firstForSource && rowKey !== sourceLineId) delete returnLineValues[sourceLineId];
    returnLineValues[rowKey] = {
      clientRowKey: rowKey,
      sourceLineId,
      pallets: Number(saved.pallets || 0),
      layers: Number(saved.layers || 0),
      sections: Number(saved.sections || 0),
      pieces: Number(saved.pieces || 0),
      salesQuantity: Number(saved.salesQuantity ?? saved.sales_quantity ?? 0),
      reasonId: String(saved.reasonId || saved.reason_id || ""),
      reasonLabel: saved.reasonLabel || saved.reason_label || "",
      note: saved.note || "",
      photos: [...(saved.photos || [])]
    };
  }
  returnStage = "form";
  returnView = "workflow";
  returnLinePage = 0;
  returnActiveLineId = firstReturnLineId();
  returnDirty = false;
  returnValidationMessage = "";
  returnPhotoTarget = defaultReturnPhotoTarget();
  returnPhotoSlot = 0;
  if (renderAfter) render();
}

async function deleteReturnDraft(id) {
  if (!id || !confirm(t("operator.discardDraftConfirm", "Discard this return draft?"))) return;
  await api(`/api/returns/drafts/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (String(returnDraftId) === String(id)) resetReturnWorkflow(returnMode);
  returnSelectedRecordId = "";
  await loadReturnDrafts({ renderAfter: false });
  returnView = "drafts";
  showToast(t("operator.draftDiscarded", "Draft discarded"));
  render();
}

function stopReturnCamera() {
  if (returnCameraStream) returnCameraStream.getTracks().forEach((track) => track.stop());
  returnCameraStream = null;
  returnCameraActive = false;
}

function attachReturnCamera() {
  const video = document.getElementById("returnCamera");
  if (!video || !returnCameraStream) return;
  video.srcObject = returnCameraStream;
  video.play().catch(() => {});
}

async function startReturnCamera() {
  if (!navigator.mediaDevices?.getUserMedia) return showToast(t("operator.cameraUnavailable", "Camera is not available in this browser."));
  stopReturnScannerCamera();
  stopReturnCamera();
  try {
    returnCameraStream = await openCameraStream();
    returnCameraActive = true;
    returnPhotoTarget.open = true;
    render();
  } catch (error) {
    stopReturnCamera();
    showToast(cameraErrorMessage(error));
    render();
  }
}

async function switchReturnCamera() {
  const wasActive = returnCameraActive;
  switchCameraFacing();
  if (wasActive) return startReturnCamera();
  render();
}

async function compressReturnPhoto(dataUrl, maxDimension = 1800) {
  const image = new Image();
  const loaded = new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = reject;
  });
  image.src = dataUrl;
  await loaded;
  const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
  if (scale >= 1 && String(dataUrl).length < 2_000_000) return dataUrl;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return dataUrl;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.84);
}

async function captureReturnPhoto() {
  const video = document.getElementById("returnCamera");
  if (!video || !returnCameraStream) return showToast(t("operator.cameraPreviewNotReady", "Camera preview is not ready yet."));
  try {
    const captured = await captureCameraPhotoDataUrl(returnCameraStream, video);
    const photo = await compressReturnPhoto(captured);
    const photos = [...returnTargetPhotos()];
    photos[returnPhotoSlot] = photo;
    setReturnTargetPhotos(photos);
    returnDirty = true;
    const nextEmpty = photos.findIndex((item, index) => index > returnPhotoSlot && !item);
    if (nextEmpty >= 0) returnPhotoSlot = nextEmpty;
    render();
  } catch (error) {
    showToast(error.message || t("operator.photoCaptureFailed", "Photo capture failed."));
  }
}

function openReturnPhotoTarget(kind, lineId = "") {
  stopReturnScannerCamera();
  stopReturnCamera();
  returnPhotoTarget = { kind, lineId: String(lineId || ""), open: true };
  const photos = returnTargetPhotos();
  returnPhotoSlot = Math.max(0, photos.findIndex((photo) => !photo));
  if (returnPhotoSlot < 0) returnPhotoSlot = 0;
  render();
}

function addReturnPhotoSlot() {
  const photos = [...returnTargetPhotos()];
  if (photos.length >= RETURN_MAX_PHOTOS) return;
  photos.push("");
  setReturnTargetPhotos(photos);
  returnPhotoSlot = photos.length - 1;
  returnDirty = true;
  render();
}

function removeReturnPhoto() {
  const photos = [...returnTargetPhotos()];
  if (!photos[returnPhotoSlot]) return;
  photos.splice(returnPhotoSlot, 1);
  setReturnTargetPhotos(photos);
  returnPhotoSlot = Math.min(returnPhotoSlot, Math.max(0, photos.length - 1));
  returnDirty = true;
  render();
}

function stopReturnScannerCamera() {
  window.clearInterval(returnScannerTimer);
  returnScannerTimer = null;
  returnQrDecoder = null;
  returnQrFrameBusy = false;
  if (returnQuaggaActive && window.Quagga) {
    window.Quagga.offDetected(handleReturnBarcodeDetected);
    try {
      window.Quagga.stop();
    } catch {
      // Camera may already be released after navigation.
    }
  }
  returnQuaggaActive = false;
  if (returnScannerStream) returnScannerStream.getTracks().forEach((track) => track.stop());
  returnScannerStream = null;
  returnScannerActive = false;
  returnScanCandidate = "";
  returnScanCandidateHits = 0;
  returnScanCandidateAt = 0;
}

async function acceptReturnCameraScan(value, { confirmRepeated = false } = {}) {
  const code = normalizedPickupCameraCode(value);
  if (!code || !returnScannerActive || returnScanSubmitting) return;
  if (confirmRepeated && !/^SO[A-Z]?\d+$/i.test(code)) {
    const now = Date.now();
    if (code === returnScanCandidate && now - returnScanCandidateAt <= 1600) returnScanCandidateHits += 1;
    else {
      returnScanCandidate = code;
      returnScanCandidateHits = 1;
    }
    returnScanCandidateAt = now;
    if (returnScanCandidateHits < 2) return;
  }
  returnScanSubmitting = true;
  returnLookupCode = code;
  stopReturnScannerCamera();
  try {
    await lookupReturnOrder(code);
  } finally {
    returnScanSubmitting = false;
  }
}

function handleReturnBarcodeDetected(result) {
  void acceptReturnCameraScan(pickupQuaggaOrderCode(result), { confirmRepeated: true });
}

async function scanReturnQrFrame() {
  if (!returnScannerActive || returnScanSubmitting || returnQrFrameBusy || !returnQrDecoder) return;
  const video = document.querySelector("#returnScannerCamera video");
  if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  returnQrFrameBusy = true;
  try {
    const result = await returnQrDecoder.scanImage(video, {
      returnDetailedScanResult: true,
      alsoTryWithoutScanRegion: true
    });
    await acceptReturnCameraScan(result);
  } catch {
    // No QR code in this frame is normal.
  } finally {
    returnQrFrameBusy = false;
  }
}

async function startReturnScannerCamera() {
  stopReturnCamera();
  stopReturnScannerCamera();
  returnScanSubmitting = false;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(t("operator.cameraUnavailable", "Camera is not available in this browser."));
    if (!window.Quagga) throw new Error(t("operator.scannerLoadFailed", "Barcode scanner could not load. Refresh the app and try again."));
    returnScannerActive = true;
    returnLookupMessage = t("operator.startingScanner", "Starting 1D / QR camera scanner...");
    render();
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    const target = document.getElementById("returnScannerCamera");
    if (!target) throw new Error(t("operator.cameraPreviewNotReady", "Camera preview is not ready yet."));
    const scannerConstraints = await resolvePickupScannerVideoConstraints();
    await new Promise((resolve, reject) => {
      window.Quagga.init({
        inputStream: {
          name: "Operator return barcode camera",
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
    window.Quagga.onDetected(handleReturnBarcodeDetected);
    window.Quagga.start();
    returnQuaggaActive = true;
    const video = target.querySelector("video");
    returnScannerStream = video?.srcObject || null;
    if (returnScannerStream) rememberCameraStream(returnScannerStream);
    try {
      const { default: QrScanner } = await import("/vendor/qr-scanner/qr-scanner.min.js");
      returnQrDecoder = QrScanner;
      returnScannerTimer = window.setInterval(() => void scanReturnQrFrame(), 650);
    } catch {
      // 1D scanning remains available.
    }
    returnLookupMessage = "";
    document.querySelector(".return-lookup-card .sync-alert")?.remove();
  } catch (error) {
    returnLookupMessage = cameraErrorMessage(error);
    stopReturnScannerCamera();
    render();
  }
}

async function switchReturnScannerCamera() {
  const wasActive = returnScannerActive;
  switchCameraFacing();
  if (wasActive) return startReturnScannerCamera();
  render();
}

function returnScannerKeyActive() {
  return returnModuleActive() && returnStage === "lookup" && returnView === "workflow";
}

async function handleReturnScannerKey(event) {
  if (!returnScannerKeyActive() || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return false;
  const target = event.target;
  if (target?.id === "returnOrderLookup") return false;
  if (target?.closest?.("input, textarea, select, [contenteditable='true']")) return false;
  const now = Date.now();
  if (now - returnScannerLastKeyAt > 120) returnScannerBuffer = "";
  returnScannerLastKeyAt = now;
  if (event.key === "Enter" || event.key === "Tab") {
    const code = returnScannerBuffer.trim();
    returnScannerBuffer = "";
    if (!code) return false;
    event.preventDefault();
    await lookupReturnOrder(code);
    return true;
  }
  if (event.key === "Backspace") {
    returnScannerBuffer = returnScannerBuffer.slice(0, -1);
    event.preventDefault();
    return true;
  }
  if (event.key?.length === 1) {
    returnScannerBuffer += event.key;
    event.preventDefault();
    return true;
  }
  return false;
}

function addReturnSplitRow(sourceLineId) {
  const line = returnLines().find((item) => returnSourceLineId(item) === String(sourceLineId));
  if (!line || returnType !== "quality") return;
  const rowKey = createReturnIdempotencyKey();
  ensureReturnLineValue(line, rowKey);
  returnDirty = true;
  render();
}

function removeReturnSplitRow(rowKey) {
  const values = returnLineValues[String(rowKey || "")];
  if (!values) return;
  const rows = Object.values(returnLineValues).filter((item) => item.sourceLineId === values.sourceLineId);
  if (rows.length <= 1) return;
  if (returnPhotoTarget.kind === "line" && returnPhotoTarget.lineId === rowKey) stopReturnCamera();
  delete returnLineValues[rowKey];
  const selectedRow = Object.values(returnLineValues)
    .find((item) => String(item.sourceLineId || "") === String(returnActiveLineId));
  returnPhotoTarget = returnType === "quality" && selectedRow
    ? { kind: "line", lineId: String(selectedRow.clientRowKey || ""), open: true }
    : defaultReturnPhotoTarget();
  returnPhotoSlot = 0;
  returnDirty = true;
  render();
}

function returnPayloadLines({ includeEmpty = false } = {}) {
  return Object.values(returnLineValues).flatMap((values) => {
    const line = returnLineForValues(values);
    if (!line || returnLinePolicy(line).effective === "NOT_RETURNABLE") return [];
    const salesQuantity = returnLineCalculatedSalesQty(line, values);
    const hasDraftData = salesQuantity > 0 || values.reasonId || values.note || values.photos.filter(Boolean).length;
    if (!includeEmpty && salesQuantity <= 0) return [];
    if (includeEmpty && !hasDraftData) return [];
    const reason = returnType === "normal"
      ? returnReasons.normalReason
      : returnReasons.qualityReasons.find((item) => String(item.id) === String(values.reasonId)) || { id: values.reasonId, label: values.reasonLabel };
    return [{
      clientRowKey: values.clientRowKey,
      sourceLineId: values.sourceLineId,
      pallets: Number(values.pallets) || 0,
      layers: Number(values.layers) || 0,
      sections: Number(values.sections) || 0,
      pieces: Number(values.pieces) || 0,
      salesQuantity,
      reasonId: String(reason?.id || ""),
      reasonLabel: reason?.label || "",
      note: values.note || "",
      photos: values.photos.filter(Boolean)
    }];
  });
}

function buildReturnPayload({ draft = false } = {}) {
  if (!returnIdempotencyKey) returnIdempotencyKey = createReturnIdempotencyKey();
  return {
    draftId: returnDraftId || undefined,
    idempotencyKey: returnIdempotencyKey,
    returnMode,
    draftType: draft
      ? returnMode === "pallet" ? "pallet" : Number(returnPalletQuantity) > 0 ? "combined" : "stock"
      : undefined,
    stockReturnType: returnMode === "stock" ? returnType : undefined,
    receivingLocationId: locationId,
    orderId: returnOrderId() || undefined,
    orderRef: returnOrderRef() || undefined,
    customerId: returnCustomerId(),
    customer: draft ? returnCustomer() : undefined,
    order: draft ? returnOrder() : undefined,
    lookup: draft ? returnLookupData : undefined,
    vehiclePlate: returnVehiclePlate.trim(),
    note: returnHeaderNote.trim(),
    lines: returnPayloadLines({ includeEmpty: draft }),
    palletQuantity: Number(returnPalletQuantity) || 0,
    palletPhotos: returnPalletPhotos.filter(Boolean),
    photos: returnRecordPhotos.filter(Boolean)
  };
}

function validateReturnForReview({ requireVehiclePlate = true, requirePhotos = true } = {}) {
  if (!returnCustomerId()) return t("operator.customerRequired", "A NetSuite customer is required.");
  if (returnMode === "stock" && !returnOrderId()) return t("operator.salesOrderRequired", "A Sales Order is required.");
  if (returnYardGate().blocked) {
    return tf("operator.returnMustBeProcessedAt", "This return must be processed at {yard}.", { yard: returnYardGate().requiredName || "-" });
  }
  if (requireVehiclePlate && !returnVehiclePlate.trim()) return t("operator.vehiclePlateRequired", "Vehicle plate is required.");

  const palletQty = Number(returnPalletQuantity) || 0;
  if (palletQty < 0 || !Number.isInteger(palletQty)) return t("operator.palletWholeNumber", "PALLET quantity must be a non-negative whole number.");
  if (returnMode === "pallet" && palletQty <= 0) return t("operator.palletPositiveRequired", "Enter at least one PALLET.");
  if (palletQty > 0 && !currentPalletBalance()) return t("operator.palletBalanceRequired", "A current PALLET balance is required.");
  if (palletQty > returnBalanceAvailable() + RETURN_QUANTITY_EPSILON) return tf("operator.maximumReturnable", "Maximum returnable: {quantity}", { quantity: displayReturnQty(returnBalanceAvailable()) });
  if (requirePhotos && palletQty > 0 && returnPalletPhotos.filter(Boolean).length < 1) {
    return t("operator.palletPhotoRequired", "Take at least one live photo of the returned PALLET.");
  }

  const selectedRows = returnSelectedRows();
  if (returnMode === "stock" && !selectedRows.length && palletQty <= 0) return t("operator.returnQuantityRequired", "Enter at least one stock or PALLET return quantity.");
  for (const line of returnLines()) {
    const rows = returnRowsForLine(line);
    const total = rows.reduce((sum, values) => sum + returnLineCalculatedSalesQty(line, values), 0);
    if (total > returnLineRemaining(line) + RETURN_QUANTITY_EPSILON) {
      return `${returnLineName(line)}: ${tf("operator.maximumReturnable", "Maximum returnable: {quantity}", { quantity: `${displayReturnQty(returnLineRemaining(line))} ${returnLineSalesUom(line)}` })}`;
    }
    for (const values of rows) {
      if (!returnLineHasQty(line, values)) continue;
      if (returnLinePolicy(line).effective === "NOT_RETURNABLE") return `${returnLineName(line)}: ${t("operator.returnNotReturnable", "Not Returnable")}`;
      if (returnLineEntryMode(line) === "physical") {
        const invalid = returnLineUnits(line).some((unit) => {
          const amount = Number(values[unit.key]) || 0;
          return amount < 0 || !Number.isInteger(amount);
        });
        if (invalid) return `${returnLineName(line)}: ${t("operator.physicalWholeNumber", "PLT, LYR, SEC, and PCS must be non-negative whole numbers.")}`;
      } else if ((Number(values.salesQuantity) || 0) < 0) {
        return `${returnLineName(line)}: ${t("operator.nonNegativeQuantity", "Quantity cannot be negative.")}`;
      }
      if (returnType === "quality" && !values.reasonId) return `${returnLineName(line)}: ${t("operator.qualityReasonRequired", "Select a quality reason.")}`;
      if (requirePhotos && returnType === "quality" && values.photos.filter(Boolean).length < 1) {
        return `${returnLineName(line)}: ${t("operator.qualityPhotoRequired", "Take at least one live quality photo for this row.")}`;
      }
    }
  }
  if (requirePhotos && returnMode === "stock" && returnType === "normal" && selectedRows.length && returnRecordPhotos.filter(Boolean).length < 1) {
    return t("operator.normalPhotoRequired", "Take at least one live photo for the Normal Stock Return.");
  }
  return "";
}

async function uploadReturnPhotoList(photos, recordType, suffix = "") {
  return mapWithConcurrency(photos.filter(Boolean), 2, (photo, index) => (
    uploadOperatorPhoto(photo, {
      recordType,
      orderType: "customer_return",
      orderId: returnOrderId() || returnCustomerId(),
      orderRef: returnOrderRef() || returnCustomerCode(),
      filename: `${recordType}${suffix ? `-${suffix}` : ""}-${index + 1}.jpg`
    })
  ));
}

async function uploadReturnEvidence() {
  returnRecordPhotos = await uploadReturnPhotoList(returnRecordPhotos.filter(Boolean), "operator-return-photo", "stock");
  returnPalletPhotos = await uploadReturnPhotoList(returnPalletPhotos.filter(Boolean), "operator-return-photo", "pallet");
  for (const values of Object.values(returnLineValues)) {
    if (!values.photos?.some(Boolean)) continue;
    values.photos = await uploadReturnPhotoList(values.photos.filter(Boolean), "operator-return-photo", `quality-${values.clientRowKey}`);
  }
}

async function saveReturnDraft() {
  if (returnBusy || !returnCustomerId()) return showToast(t("operator.lookupCustomerFirst", "Look up a customer before saving a draft."));
  returnBusy = true;
  returnValidationMessage = "";
  render();
  try {
    await uploadReturnEvidence();
    const payload = buildReturnPayload({ draft: true });
    const result = await api("/api/returns/drafts", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    const draft = result.draft || result;
    returnDraftId = String(draft.id || draft.draftId || draft.draft_id || returnDraftId);
    returnIdempotencyKey = String(draft.idempotencyKey || draft.idempotency_key || returnIdempotencyKey);
    returnDirty = false;
    showToast(t("operator.draftSaved", "Return draft saved"));
  } catch (error) {
    returnValidationMessage = error.message;
    showToast(error.message);
  } finally {
    returnBusy = false;
    render();
  }
}

function openReturnReview() {
  const error = validateReturnForReview({ requireVehiclePlate: false, requirePhotos: false });
  returnValidationMessage = error;
  if (error) return render();
  stopReturnCamera();
  stopReturnScannerCamera();
  selectReturnReviewPhotoTarget(returnPhotoTarget, { preferMissing: true });
  returnStage = "review";
  render();
}

async function submitReturn() {
  if (returnBusy) return;
  const validation = validateReturnForReview();
  if (validation) {
    returnValidationMessage = validation;
    returnStage = "review";
    return render();
  }
  returnBusy = true;
  render();
  try {
    await uploadReturnEvidence();
    returnResult = await api("/api/returns/submit", {
      method: "POST",
      body: JSON.stringify(buildReturnPayload())
    });
    returnDirty = false;
    returnDraftId = "";
    returnStage = "success";
    showToast(t("operator.returnRecorded", "Return recorded"));
  } catch (error) {
    const code = String(error.payload?.code || "");
    returnValidationMessage = code === "CROSS_YARD_RETURN_BLOCKED"
      ? tf("operator.returnMustBeProcessedAt", "This return must be processed at {yard}.", { yard: returnYardName(error.payload.requiredReturnLocation) || "-" })
      : code === "ORDER_NOT_FULLY_FULFILLED"
        ? returnOrderNotFullyFulfilledMessage()
        : error.message;
    returnStage = "form";
    showToast(returnValidationMessage);
  } finally {
    returnBusy = false;
    render();
  }
}

async function confirmLeaveReturnWorkflow() {
  if (!returnModuleActive() || !returnDirty || returnStage === "success") return true;
  return confirm(t("operator.leaveUnsavedReturnConfirm", "Leave this return without saving the latest changes?"));
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
      stopReturnCamera();
      stopReturnScannerCamera();
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
      if (returnModuleActive()) {
        if (returnStage !== "lookup" || returnDraftId || returnDirty) {
          return showToast(t("operator.returnYardLocked", "The receiving yard is locked. Discard or finish this return before changing yard."));
        }
      }
      if (!(await confirmDiscardCustomerPickupDraft())) return;
      stopFulfillmentCamera();
      stopReceiptCamera();
      stopPickupScannerCamera();
      stopReturnCamera();
      stopReturnScannerCamera();
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
      if (!(await confirmLeaveReturnWorkflow())) return;
      if (!(await confirmDiscardCustomerPickupDraft())) return;
      stopFulfillmentCamera();
      stopReceiptCamera();
      stopPickupScannerCamera();
      stopReturnCamera();
      stopReturnScannerCamera();
      currentModule = "menu";
      selectedId = null;
      selectedOrder = null;
      selectedInventoryItem = null;
      return render();
    }
    if (button.dataset.action === "open-module") return openModule(button.dataset.module);
    if (button.dataset.action === "return-back-select") {
      if (!(await confirmLeaveReturnWorkflow())) return;
      resetReturnWorkflow(returnMode);
      currentModule = "return-select";
      return render();
    }
    if (button.dataset.action === "return-set-type") {
      const nextType = button.dataset.returnType === "quality" ? "quality" : "normal";
      if (nextType === returnType) return;
      if (returnLines().length && !confirm(t("operator.changeReturnTypeConfirm", "Changing return type clears entered stock quantities and line photos. Continue?"))) return;
      returnType = nextType;
      if (returnLines().length) {
        returnLineValues = {};
        for (const line of returnLines()) ensureReturnLineValue(line);
        returnRecordPhotos = [];
      }
      returnActiveLineId = firstReturnLineId();
      stopReturnCamera();
      returnPhotoTarget = defaultReturnPhotoTarget();
      returnPhotoSlot = 0;
      returnDirty = Boolean(returnLines().length);
      return render();
    }
    if (button.dataset.action === "return-start-scanner") return startReturnScannerCamera();
    if (button.dataset.action === "return-switch-scanner-camera") return switchReturnScannerCamera();
    if (button.dataset.action === "return-lookup-order") return lookupReturnOrder(document.getElementById("returnOrderLookup")?.value || returnLookupCode);
    if (button.dataset.action === "return-select-customer") return selectReturnCustomer(button.dataset.customerId);
    if (button.dataset.action === "return-step-quantity") return stepReturnQuantity(button);
    if (button.dataset.action === "return-select-evidence-target") {
      selectReturnReviewPhotoTarget({
        kind: button.dataset.photoKind || "record",
        lineId: button.dataset.line || ""
      });
      return render();
    }
    if (button.dataset.action === "return-open-camera") return openReturnPhotoTarget(button.dataset.photoKind || "record", button.dataset.line || "");
    if (button.dataset.action === "return-close-camera") {
      stopReturnCamera();
      returnPhotoTarget.open = false;
      return render();
    }
    if (button.dataset.action === "return-start-camera") return startReturnCamera();
    if (button.dataset.action === "return-switch-camera") return switchReturnCamera();
    if (button.dataset.action === "return-capture-photo") return captureReturnPhoto();
    if (button.dataset.action === "return-add-photo") return addReturnPhotoSlot();
    if (button.dataset.action === "return-remove-photo") return removeReturnPhoto();
    if (button.dataset.action === "return-select-photo-slot") {
      returnPhotoSlot = Number(button.dataset.slot) || 0;
      return render();
    }
    if (button.dataset.action === "return-add-split-row") return addReturnSplitRow(button.dataset.sourceLine);
    if (button.dataset.action === "return-remove-split-row") return removeReturnSplitRow(button.dataset.line);
    if (button.dataset.action === "return-select-stock-line") {
      returnActiveLineId = String(button.dataset.sourceLine || "");
      if (returnActiveLineId === "PALLET") {
        returnPhotoTarget = { kind: "pallet", lineId: "", open: true };
      } else if (returnType === "quality") {
        const row = Object.values(returnLineValues)
          .find((values) => String(values.sourceLineId || "") === returnActiveLineId);
        if (row) {
          returnPhotoTarget = { kind: "line", lineId: String(row.clientRowKey || ""), open: true };
        }
      } else {
        returnPhotoTarget = { kind: "record", lineId: "", open: true };
      }
      const photos = returnTargetPhotos();
      returnPhotoSlot = Math.max(0, photos.findIndex((photo) => !photo));
      if (returnPhotoSlot < 0) returnPhotoSlot = 0;
      return render();
    }
    if (button.dataset.action === "return-line-prev") {
      returnLinePage = Math.max(0, returnLinePage - 1);
      return render();
    }
    if (button.dataset.action === "return-line-next") {
      returnLinePage = Math.min(pageCount(returnLines(), RETURN_LINE_PAGE_SIZE) - 1, returnLinePage + 1);
      return render();
    }
    if (button.dataset.action === "return-save-draft") return saveReturnDraft();
    if (button.dataset.action === "return-open-review") return openReturnReview();
    if (button.dataset.action === "return-back-to-form") {
      stopReturnCamera();
      returnStage = "form";
      return render();
    }
    if (button.dataset.action === "return-confirm-submit") return submitReturn();
    if (button.dataset.action === "return-new") {
      const mode = returnMode;
      resetReturnWorkflow(mode);
      currentModule = mode === "stock" ? "stock-return" : "pallet-return";
      return render();
    }
    if (button.dataset.action === "return-open-drafts") {
      if (returnDirty && !confirm(t("operator.openDraftsUnsavedConfirm", "Open drafts without saving the latest changes?"))) return;
      stopReturnCamera();
      stopReturnScannerCamera();
      returnView = "drafts";
      returnSelectedRecordId = "";
      returnBusy = true;
      render();
      try {
        await loadReturnDrafts({ renderAfter: false });
      } finally {
        returnBusy = false;
        render();
      }
      return;
    }
    if (button.dataset.action === "return-open-history-view") {
      if (returnDirty && !confirm(t("operator.openHistoryUnsavedConfirm", "Open history without saving the latest changes?"))) return;
      stopReturnCamera();
      stopReturnScannerCamera();
      returnView = "history";
      returnSelectedRecordId = "";
      returnHistoryOffset = 0;
      returnBusy = true;
      render();
      try {
        await loadReturnHistory();
      } finally {
        returnBusy = false;
        render();
      }
      return;
    }
    if (button.dataset.action === "return-select-draft") {
      returnSelectedRecordId = button.dataset.record || "";
      return render();
    }
    if (button.dataset.action === "return-select-history") {
      returnSelectedRecordId = button.dataset.record || "";
      returnHistoryDetail = null;
      render();
      return loadReturnHistoryDetail(returnSelectedRecordId);
    }
    if (button.dataset.action === "return-history-prev" || button.dataset.action === "return-history-next") {
      const delta = button.dataset.action === "return-history-next"
        ? RETURN_HISTORY_PAGE_SIZE
        : -RETURN_HISTORY_PAGE_SIZE;
      returnSelectedRecordId = "";
      returnHistoryDetail = null;
      returnBusy = true;
      render();
      try {
        await loadReturnHistory({ offset: returnHistoryOffset + delta });
      } finally {
        returnBusy = false;
        render();
      }
      return;
    }
    if (button.dataset.action === "return-resume-draft") {
      const draft = returnDrafts.find((item) => String(item.id) === String(button.dataset.record));
      return resumeReturnDraft(draft);
    }
    if (button.dataset.action === "return-delete-draft") return deleteReturnDraft(button.dataset.record);
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
      cyclePage = Math.min(currentCyclePageCount() - 1, cyclePage + 1);
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
      deliveryLoadViewDate = dateInput?.value || deliveryLoadViewDate || new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
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
    if (button.dataset.action === "edit-reload-packing") return editReloadPacking();
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
      fulfillmentLoadRequestId = "";
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
  if (event.target?.id === "returnOrderLookup") {
    returnLookupCode = event.target.value;
    returnLookupMessage = "";
    return;
  }
  if (event.target?.id === "returnCustomerSearch") {
    returnCustomerSearch = event.target.value;
    returnCustomerSearchGeneration += 1;
    returnLookupMessage = "";
    window.clearTimeout(app.returnCustomerSearchTimer);
    app.returnCustomerSearchTimer = window.setTimeout(() => {
      searchReturnCustomers().catch((error) => showToast(error.message));
    }, 300);
    return;
  }
  if (event.target?.dataset?.returnInput === "vehiclePlate") {
    returnVehiclePlate = event.target.value.toUpperCase();
    returnDirty = true;
    if (returnStage === "review" && returnVehiclePlate.trim()) {
      returnValidationMessage = "";
      app.querySelector("[data-return-review-validation]")?.remove();
    }
    return;
  }
  if (event.target?.dataset?.returnInput === "headerNote") {
    returnHeaderNote = event.target.value;
    returnDirty = true;
    return;
  }
  if (event.target?.dataset?.returnInput === "palletQuantity") {
    returnPalletQuantity = Math.max(0, Number(event.target.value) || 0);
    returnDirty = true;
    refreshReturnQuantityFeedback(event.target);
    return;
  }
  if (event.target?.dataset?.returnLineInput) {
    const values = returnLineValues[String(event.target.dataset.line || "")];
    if (!values) return;
    const field = event.target.dataset.returnLineInput;
    if (["pallets", "layers", "sections", "pieces", "salesQuantity"].includes(field)) {
      values[field] = Math.max(0, Number(event.target.value) || 0);
    } else {
      values[field] = event.target.value;
      if (field === "reasonId") {
        values.reasonLabel = returnReasons.qualityReasons.find((reason) => String(reason.id) === String(values.reasonId))?.label || "";
      }
    }
    returnDirty = true;
    refreshReturnQuantityFeedback(event.target);
    return;
  }
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
  if (event.target?.id === "returnOrderLookup" && event.key === "Enter") {
    event.preventDefault();
    await lookupReturnOrder(event.target.value);
    return;
  }
  if (event.target?.id === "customerPickupScan" && event.key === "Enter") {
    event.preventDefault();
    await submitCustomerPickupScanValue(event.target.value);
  }
});

window.addEventListener("keydown", async (event) => {
  try {
    if (await handleReturnScannerKey(event)) return;
    await handleCustomerPickupScannerKey(event);
  } catch (error) {
    if (returnScannerKeyActive()) returnLookupMessage = error.message;
    else customerPickupMessage = error.message;
    render();
  }
}, true);

app.addEventListener("change", async (event) => {
  if (event.target?.dataset?.returnInput || event.target?.dataset?.returnLineInput) {
    return render();
  }
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
  if (deliveryOrdersLoadingCount || fulfillmentSubmitting || receiptSubmitting || returnBusy) return;
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
  if (deliveryOrdersLoadingCount || fulfillmentSubmitting || receiptSubmitting || returnBusy) return;
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
  stopReturnCamera();
  stopReturnScannerCamera();
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
  if (returnScannerActive) {
    stopReturnScannerCamera();
    render();
    void startReturnScannerCamera();
    return;
  }
  render();
});

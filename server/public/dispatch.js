const app = document.getElementById("dispatchApp");
const t = (key, fallback) => window.MBBS_I18N?.t(key, fallback) || fallback;
const tf = (key, fallback, variables = {}) => window.MBBS_I18N?.format(key, fallback, variables)
  || Object.entries(variables).reduce(
    (result, [name, value]) => result.replaceAll(`{${name}}`, String(value ?? "")),
    t(key, fallback)
  );
const languageToggle = () => window.MBBS_I18N?.toggleHtml() || "";
const displayDate = (value) => window.MBBS_I18N?.displayDate(value) || "";
const displayDateTime = (value) => window.MBBS_I18N?.displayDateTime(value) || "";
const SALES_PLANNING_HOST = window.location.pathname.startsWith("/sales/");
const DISPATCH_PLAN_CACHE_KEY = "mbbs.dispatch.plan";

const ROUTE_ESTIMATE_STORAGE_KEY = "mbbs.dispatch.routeEstimates.v1";
const ROUTE_ESTIMATE_CACHE_LIMIT = 100;
const ROUTE_ESTIMATE_CACHE_MAX_CHARS = 500000;
const ROUTE_ESTIMATE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
function dispatchStorageGet(key, fallback = null) {
  // Dispatch plans are server-authoritative and can be larger than the browser's
  // per-origin localStorage quota. Never hydrate a plan from this legacy cache.
  if (key === DISPATCH_PLAN_CACHE_KEY) return fallback;
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function dispatchStorageSet(key, value) {
  // Older releases stored the complete plan under this key. Discard that cache
  // instead of allowing a quota exception to interrupt load, save, or confirm.
  if (key === DISPATCH_PLAN_CACHE_KEY) {
    dispatchStorageRemove(key);
    return false;
  }
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    // The server is authoritative for dispatch plans. A full browser quota must
    // never stop a read-only board from loading or a server save from running.
    return false;
  }
}

function dispatchStorageRemove(key) {
  try {
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

// Free space consumed by plans written by older versions before any other
// preference is persisted. The active plan is always loaded from the API.
dispatchStorageRemove(DISPATCH_PLAN_CACHE_KEY);

const DISPATCH_SESSION_KEY = "mbbs.dispatch.sessionId";

function createDispatchSessionId() {
  const generated = `dispatch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const stored = window.sessionStorage?.getItem(DISPATCH_SESSION_KEY);
    if (stored) return stored;
    window.sessionStorage?.setItem(DISPATCH_SESSION_KEY, generated);
  } catch {
    // An in-memory ID is sufficient when browser storage is blocked.
  }
  return generated;
}

const dispatchSessionId = createDispatchSessionId();
const DEFAULT_FIRST_LOAD_START = "07:00";

const HUBS = {
  "3445": { x: 48, y: 40, lat: 43.8204306, lng: -79.3053423, address: "3445 Kennedy Road, Toronto, ON" },
  "2967": { x: 62, y: 52, lat: 43.806119, lng: -79.2986377, address: "2967 Kennedy Road, Toronto, ON" },
  "12441": { x: 40, y: 66, lat: 43.948694, lng: -79.3727582, address: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON" },
  "150": { x: 54, y: 58, address: "150 Clark Blvd, Brampton, ON L6T 4Y8, Canada" },
  "Vendor": { x: 28, y: 22, lat: 43.857, lng: -79.521 }
};

const MAP_CENTER = { lat: 43.700, lng: -79.650 };

let ownYards = Object.entries(HUBS)
  .filter(([code]) => code !== "Vendor")
  .map(([code, hub]) => ({ code, name: code, address: hub.address || code, lat: hub.lat, lng: hub.lng, x: hub.x, y: hub.y }));

function applyOwnYards(nextYards = []) {
  if (Array.isArray(nextYards) && nextYards.length) {
    ownYards = nextYards
      .map((yard) => ({
        code: String(yard.code || yard.name || "").trim(),
        name: String(yard.name || yard.code || "").trim(),
        locationId: yard.locationId === "" || yard.locationId == null ? null : Number(yard.locationId),
        address: String(yard.address || "").trim(),
        lat: yard.lat === "" || yard.lat == null ? Number.NaN : Number(yard.lat),
        lng: yard.lng === "" || yard.lng == null ? Number.NaN : Number(yard.lng),
        x: yard.x === "" || yard.x == null ? Number.NaN : Number(yard.x),
        y: yard.y === "" || yard.y == null ? Number.NaN : Number(yard.y)
      }))
      .filter((yard) => yard.code);
  }
  for (const yard of ownYards) {
    const existing = HUBS[yard.code] || {};
    HUBS[yard.code] = {
      ...existing,
      x: Number.isFinite(yard.x) ? yard.x : (existing.x ?? 50),
      y: Number.isFinite(yard.y) ? yard.y : (existing.y ?? 50),
      lat: Number.isFinite(yard.lat) ? yard.lat : (existing.lat ?? MAP_CENTER.lat),
      lng: Number.isFinite(yard.lng) ? yard.lng : (existing.lng ?? MAP_CENTER.lng),
      address: yard.address || existing.address || yard.code,
      name: yard.name || existing.name || yard.code
    };
  }
}

const sampleOrders = [
  {
    id: "SOB104512",
    type: "SO",
    customer: "Cedar Ridge Homes",
    address: "42 Maple Quarry Rd, Vaughan",
    windowStart: "09:00",
    windowEnd: "11:00",
    pallets: 11,
    layers: 2,
    items: [
      { sku: "BWS-AR-COP-UB", pallets: 2, layers: 3 },
      { sku: "BWS-HUNT-SM", pallets: 9, layers: 7 }
    ],
    salesQty: 1150,
    weight: 12.4,
    pickupLocations: ["3445"],
    unloadMinutes: 38,
    travelMinutes: 34,
    groupKey: "42 Maple Quarry Rd, Vaughan",
    notes: "Front curb drop. Call site lead 20 minutes before arrival.",
    committedQty: 1150,
    x: 70,
    y: 34
  },
  {
    id: "SOB104519",
    type: "SO",
    customer: "Cedar Ridge Homes",
    address: "42 Maple Quarry Rd, Vaughan",
    windowStart: "09:00",
    windowEnd: "11:00",
    pallets: 5,
    layers: 4,
    items: [
      { sku: "BWS-HUNT-GM", pallets: 5, layers: 4 }
    ],
    salesQty: 560,
    weight: 5.8,
    pickupLocations: ["2967"],
    unloadMinutes: 26,
    travelMinutes: 28,
    groupKey: "42 Maple Quarry Rd, Vaughan",
    notes: "Same address as SOB104512. Group recommended.",
    committedQty: 560,
    x: 70,
    y: 34
  },
  {
    id: "SOB104530",
    type: "SO",
    customer: "Haven Landscape",
    address: "88 Stone Trail, Markham",
    windowStart: "08:30",
    windowEnd: "10:00",
    pallets: 18,
    layers: 0,
    items: [
      { sku: "BC-LEX-GR", pallets: 12, layers: 0 },
      { sku: "OAK-FILL-AB", pallets: 6, layers: 0 }
    ],
    salesQty: 1800,
    weight: 19.2,
    pickupLocations: ["3445", "12441"],
    unloadMinutes: 48,
    travelMinutes: 42,
    groupKey: "88 Stone Trail, Markham",
    notes: "Multiple pickup in one truck: 3445 has 12 PLT, 12441 has 6 PLT.",
    committedQty: 1800,
    x: 76,
    y: 48
  },
  {
    id: "SOB104544",
    type: "SO",
    customer: "North Gate Condo",
    address: "16 Harbour Loop, Toronto",
    windowStart: "13:00",
    windowEnd: "15:30",
    pallets: 8,
    layers: 6,
    items: [
      { sku: "UNI-EDGE-CH", pallets: 3, layers: 4 },
      { sku: "PER-LINE-BK", pallets: 5, layers: 2 }
    ],
    salesQty: 890,
    weight: 8.5,
    pickupLocations: ["2967"],
    unloadMinutes: 44,
    travelMinutes: 58,
    groupKey: "16 Harbour Loop, Toronto",
    notes: "Tight downtown unloading. Driver needs DZ.",
    committedQty: 890,
    x: 54,
    y: 78
  },
  {
    id: "SOB104561",
    type: "SO",
    customer: "Royal Paving",
    address: "310 Industrial Pkwy, Aurora",
    windowStart: "10:30",
    windowEnd: "12:00",
    pallets: 24,
    layers: 0,
    items: [
      { sku: "BNS-SLAB-NT", pallets: 10, layers: 0 },
      { sku: "ARCH-COP-BL", pallets: 14, layers: 0 }
    ],
    salesQty: 2400,
    weight: 24.5,
    pickupLocations: ["3445"],
    unloadMinutes: 55,
    travelMinutes: 46,
    groupKey: "310 Industrial Pkwy, Aurora",
    notes: "Large order, split into 2-3 loads.",
    committedQty: 2400,
    x: 67,
    y: 22
  },
  {
    id: "SOB104577",
    type: "SO",
    customer: "Urban Yard Supply",
    address: "19 Mill St, Brampton",
    windowStart: "12:00",
    windowEnd: "14:00",
    pallets: 7,
    layers: 1,
    items: [
      { sku: "BWS-AR-COP-UB", pallets: 2, layers: 1 },
      { sku: "BC-ROM-CH", pallets: 5, layers: 0 }
    ],
    salesQty: 720,
    weight: 7.6,
    pickupLocations: ["12441"],
    unloadMinutes: 30,
    travelMinutes: 37,
    groupKey: "19 Mill St, Brampton",
    notes: "Short 220 sales units at 12441. Consolidate to 3445 today for delivery tomorrow.",
    committedQty: 500,
    shortageAvailability: { "3445": 260, "2967": 80, "12441": 20 },
    x: 30,
    y: 44
  },
  {
    id: "SOB104588",
    type: "SO",
    customer: "Oak Valley Masonry",
    address: "7045 Side Rd, Caledon",
    windowStart: "15:00",
    windowEnd: "17:00",
    pallets: 13,
    layers: 3,
    items: [
      { sku: "OAK-NAT-LG", pallets: 8, layers: 0 },
      { sku: "OAK-STEP-GR", pallets: 5, layers: 3 }
    ],
    salesQty: 1380,
    weight: 13.9,
    pickupLocations: ["3445"],
    unloadMinutes: 42,
    travelMinutes: 51,
    groupKey: "7045 Side Rd, Caledon",
    notes: "Return trip can pick empty pallets.",
    committedQty: 1380,
    x: 25,
    y: 25
  },
  {
    id: "SOB104602",
    type: "SO",
    customer: "Metro Build",
    address: "500 Finch Ave, Toronto",
    windowStart: "07:30",
    windowEnd: "09:00",
    pallets: 4,
    layers: 5,
    items: [
      { sku: "UNI-CITY-GR", pallets: 4, layers: 5 }
    ],
    salesQty: 455,
    weight: 4.7,
    pickupLocations: ["2967"],
    unloadMinutes: 24,
    travelMinutes: 48,
    groupKey: "500 Finch Ave, Toronto",
    notes: "Early time window warning if loaded after 06:45.",
    committedQty: 455,
    x: 58,
    y: 68
  },
  {
    id: "POB03012",
    type: "PO",
    customer: "UNI Supplier",
    address: "UNI Supplier yard to 3445",
    sourceYard: "UNI Supplier Yard",
    destinationYard: "3445",
    windowStart: "10:00",
    windowEnd: "14:00",
    pallets: 16,
    layers: 0,
    items: [{ sku: "UNI-CITY-GR", pallets: 16, layers: 0 }],
    salesQty: 1600,
    committedQty: 1600,
    weight: 17.2,
    pickupLocations: ["Vendor"],
    unloadMinutes: 50,
    travelMinutes: 64,
    groupKey: "UNI Supplier",
    notes: "Purchase order pickup from vendor.",
    x: 44,
    y: 18
  },
  {
    id: "POB03027",
    type: "PO",
    customer: "OAK Natural Stone",
    address: "OAK Vendor yard to 2967",
    sourceYard: "OAK Vendor Yard",
    destinationYard: "2967",
    windowStart: "13:00",
    windowEnd: "16:00",
    pallets: 10,
    layers: 4,
    items: [{ sku: "OAK-NAT-LG", pallets: 10, layers: 4 }],
    salesQty: 1040,
    committedQty: 1040,
    weight: 11.5,
    pickupLocations: ["Vendor"],
    unloadMinutes: 40,
    travelMinutes: 72,
    groupKey: "OAK Natural Stone",
    notes: "Purchase order pickup from vendor.",
    x: 34,
    y: 20
  },
  {
    id: "TOB00024",
    type: "TO",
    customer: "Yard Transfer",
    address: "3445 to 12441",
    windowStart: "08:00",
    windowEnd: "12:00",
    pallets: 6,
    layers: 2,
    items: [{ sku: "BWS-AR-COP-UB", pallets: 6, layers: 2 }],
    salesQty: 620,
    committedQty: 620,
    weight: 6.8,
    pickupLocations: ["3445"],
    unloadMinutes: 32,
    travelMinutes: 44,
    groupKey: "3445 to 12441",
    notes: "Transfer order between yards.",
    x: 40,
    y: 66
  },
  {
    id: "TOB00025",
    type: "TO",
    customer: "Yard Transfer",
    address: "2967 to 3445",
    windowStart: "11:00",
    windowEnd: "15:00",
    pallets: 9,
    layers: 0,
    items: [{ sku: "ARCH-COP-BL", pallets: 9, layers: 0 }],
    salesQty: 900,
    committedQty: 900,
    weight: 9.6,
    pickupLocations: ["2967"],
    unloadMinutes: 36,
    travelMinutes: 38,
    groupKey: "2967 to 3445",
    notes: "Transfer order between yards.",
    x: 48,
    y: 40
  }
];

let orderCatalog = [];
let orders = orderCatalog.map((order) => ({ ...order, assigned: false }));
let drivers = [
  { name: "Alex Wong", license: "AZ", number: "A90211", login: "alex", ownYardFixedMinutes: 42, vendorFixedMinutes: 36, deliveryFixedMinutes: 36, outsideFixedMinutes: 36, minutesPerPallet: 1, loadMinutes: 42, unloadMinutes: 36 },
  { name: "Jenny Lee", license: "DZ", number: "D18870", login: "jenny", ownYardFixedMinutes: 38, vendorFixedMinutes: 32, deliveryFixedMinutes: 32, outsideFixedMinutes: 32, minutesPerPallet: 1, loadMinutes: 38, unloadMinutes: 32 }
];

let fleet = [
  { plate: "MBBS-101", capacityLbs: 48000 },
  { plate: "MBBS-205", capacityLbs: 44000 },
  { plate: "MBBS-318", capacityLbs: 52000 }
];
let trucks = fleet.map((vehicle, index) => makeTruckFromFleet(vehicle, index));

let selectedOrderId = orders[0]?.id || "";
let selectedLoadId = trucks[0].loads[0].id;
let dragged = null;
let pointerDraggedLoadId = "";
let supportTab = "drivers";
let searchText = "";
let activeOrderType = "SO";
let orderSearchTimer = null;
let orderSearchSequence = 0;
let orderSearchLoading = false;
let orderSearchError = "";
let modalType = "";
let modalOrderId = "";
let modalLoadId = "";
let splitParts = 2;
let splitDraft = { orderId: "", parts: 0, items: {} };
let poAllocationOptions = null;
let poAllocationLoading = false;
let poAllocationError = "";
let orderDependencyOptions = null;
let orderDependencyLoading = false;
let orderDependencyError = "";
const linkModalDrafts = new Map();
let orderDependencyRequestSequence = 0;
let orderDependencyAbortController = null;
let poAllocationRequestSequence = 0;
let poAllocationAbortController = null;
let selectedOrderIds = new Set([selectedOrderId]);
let loadPreviewOpen = false;
let sequenceCollapsed = false;
let lastSavedAt = "";
let routeNotice = "";
let dispatchDateFilter = "";
let dispatchConfig = { googleMapsApiKey: "" };
let dispatchSetupLoaded = false;
let dispatchPlanningSettings = { truckSwitchMinutes: 10 };
const driverNewTruckSelections = new Map();
let driverLaneOrder = [];
let assignmentAdvisoryByLoad = new Map();
let dispatchVendorYards = [];
let driverJobStatuses = [];
let driverTruckSwitchAttention = [];
let googleMapsPromise = null;
let routeEstimates = {};
let routeCache = {};
let persistedRouteEstimateCache = loadPersistedRouteEstimateCache();
let persistedRouteEstimateSaveTimer = null;
let backgroundRouteTimer = null;
let backgroundRoutesRunning = false;
let backgroundRouteRenderQueued = false;
let backgroundRouteInFlight = new Set();
let geocodeCache = {};
let orderListScrollTop = 0;
let loadPreviewWidth = Number(dispatchStorageGet("mbbs.dispatch.previewWidth", "520"));
let isResizingPreview = false;
let renderUiSequence = 0;
let lastServerSavedAt = "";
let saveTimer = null;
let saveInFlight = false;
let saveQueued = false;
let saveFlushPromise = null;
let forceNextPlanSave = false;
let confirmInFlight = false;
let minimumPlanRevisionToApply = { planId: "", revision: 0 };
let isApplyingRemotePlan = false;
let localPlanDirty = false;
let lastLocalPlanEditAt = "";
let localPlanGeneration = 0;
let blockedRemotePlanUpdate = false;
let blockedDispatchSetupUpdate = false;
let lastSavedPlanHash = "";
let planPollInFlight = false;
let eventSource = null;
let remoteRefreshTimer = null;
let orderClickTimer = null;
let undoStack = [];
let redoStack = [];
let historyCurrentState = "";
let historyCurrentSnapshot = null;
let historyReady = false;
let isApplyingHistory = false;
let pendingOperatorAlertRefs = new Set();
let nextSaveNeedsOrderPoolRefresh = false;
let nextPlanSaveMode = "";
let plannedAssignmentRefs = new Set();
const HISTORY_LIMIT = 20;
const HISTORY_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
const DISPATCH_PLAN_KEY = DISPATCH_PLAN_CACHE_KEY;
const DISPATCH_PLAN_DATE_KEY = "mbbs.dispatch.planDate";
let currentPlanDate = dispatchStorageGet(DISPATCH_PLAN_DATE_KEY, "") || todayLocalDate();
let currentPlan = null;
let planHistory = [];
let planEditLease = null;
let planEditLeaseToken = "";
let planEditMode = false;
let planEditHeartbeatTimer = null;
let planEditHeartbeatInFlight = false;

function dispatchEditModeMessage() {
  const owner = planEditLease?.active ? (planEditLease.operatorName || "another dispatcher") : "";
  return owner
    ? `${owner} is editing this plan. This screen is in View mode.`
    : "Enter Edit Mode before changing this dispatch plan.";
}

function isDispatchPlanEditor() {
  return Boolean(planEditMode && planEditLeaseToken && planEditLease?.active && planEditLease?.sessionId === dispatchSessionId);
}

function ensureDispatchPlanEditor() {
  if (isDispatchPlanEditor()) return true;
  routeNotice = dispatchEditModeMessage();
  render({ save: false });
  return false;
}

const DISPATCH_VIEW_MUTATION_ACTIONS = new Set([
  "undo-plan", "redo-plan", "confirm-plan", "reopen-plan",
  "open-group-modal", "confirm-group", "ungroup-order", "open-split-modal", "confirm-split", "unsplit-order", "request-unpack-for-split",
  "open-consolidate-modal", "confirm-consolidate", "open-po-link-modal", "open-to-link-modal", "confirm-po-link",
  "open-co-modal", "confirm-co", "open-po-yard-modal", "confirm-po-yard", "cancel-po-link",
  "link-order-dependency", "update-dependency-mode", "unlink-dependency",
  "delete-load", "confirm-delete-load", "clear-load", "add-load", "add-driver-load", "add-driver-return", "insert-driver-return", "move-truck-up", "move-truck-down",
  "move-driver-up", "move-driver-down", "add-return-load", "remove-stop", "optimize-route", "toggle-route-tolls"
]);

const DISPATCH_ASSIGNMENT_MUTATION_ACTIONS = new Set([
  "delete-load",
  "confirm-delete-load",
  "clear-load",
  "add-load",
  "add-driver-load",
  "add-driver-return",
  "insert-driver-return",
  "add-return-load",
  "remove-stop",
  "optimize-route",
  "load_added",
  "return_load_added",
  "load_added_by_drop",
  "load_driver_updated",
  "load_truck_updated",
  "load_start_time_updated",
  "load_deleted",
  "load_start_mode_updated",
  "load_cleared",
  "order_removed_from_load",
  "drop_order_new_load",
  "drop_order_or_stop",
  "route_optimized"
]);

function dispatchLeaseRequestPayload(extra = {}) {
  return {
    ...extra,
    planDate: currentPlanDate,
    sessionId: dispatchSessionId,
    editLeaseToken: planEditLeaseToken
  };
}

function clearPlanEditHeartbeat() {
  window.clearInterval(planEditHeartbeatTimer);
  planEditHeartbeatTimer = null;
  planEditHeartbeatInFlight = false;
}

function leaveDispatchEditMode({ clearLease = false } = {}) {
  clearPlanEditHeartbeat();
  planEditMode = false;
  planEditLeaseToken = "";
  if (clearLease) planEditLease = null;
}

async function refreshDispatchPlanEditLease(planDate = currentPlanDate) {
  if (SALES_PLANNING_HOST) {
    leaveDispatchEditMode({ clearLease: true });
    return null;
  }
  const response = await fetch(`/api/dispatch/plan-edit-lease?planDate=${encodeURIComponent(planDate)}`);
  if (!response.ok) throw new Error(await dispatchErrorMessage(response));
  const payload = await response.json();
  planEditLease = payload.lease || null;
  if (!planEditLease?.active || planEditLease.sessionId !== dispatchSessionId) {
    if (planEditMode) leaveDispatchEditMode();
  }
  return planEditLease;
}

async function heartbeatDispatchEditLease() {
  if (!isDispatchPlanEditor() || planEditHeartbeatInFlight) return;
  planEditHeartbeatInFlight = true;
  try {
    const response = await fetch("/api/dispatch/plan-edit-lease/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dispatchLeaseRequestPayload())
    });
    if (!response.ok) throw new Error(await dispatchErrorMessage(response));
    const payload = await response.json();
    planEditLease = payload.lease || planEditLease;
  } catch (error) {
    leaveDispatchEditMode();
    routeNotice = `Edit Mode ended: ${error.message}`;
    render({ save: false });
  } finally {
    planEditHeartbeatInFlight = false;
  }
}

function startDispatchEditHeartbeat() {
  clearPlanEditHeartbeat();
  planEditHeartbeatTimer = window.setInterval(heartbeatDispatchEditLease, 30000);
}

async function enterDispatchEditMode() {
  const response = await fetch("/api/dispatch/plan-edit-lease/acquire", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planDate: currentPlanDate, sessionId: dispatchSessionId })
  });
  if (!response.ok) throw new Error(await dispatchErrorMessage(response));
  const payload = await response.json();
  planEditLease = payload.lease || null;
  planEditLeaseToken = payload.editLeaseToken || "";
  planEditMode = Boolean(planEditLeaseToken && planEditLease?.active);
  if (!planEditMode) throw new Error("The server did not grant an edit lease.");
  startDispatchEditHeartbeat();
  if (!currentPlan?.id) await createPlanForDate(currentPlanDate);
  routeNotice = "Edit Mode enabled. Changes save automatically.";
  render({ save: false });
}

async function releaseDispatchEditMode() {
  if (!isDispatchPlanEditor()) {
    leaveDispatchEditMode();
    return;
  }
  const response = await fetch("/api/dispatch/plan-edit-lease/release", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dispatchLeaseRequestPayload())
  });
  if (!response.ok) throw new Error(await dispatchErrorMessage(response));
  leaveDispatchEditMode({ clearLease: true });
  routeNotice = "View Mode enabled.";
  render({ save: false });
}

function autosaveDebugEnabled() {
  return dispatchStorageGet("mbbs.dispatch.debugAutosave", "") === "1";
}

function shortHash(value = "") {
  return String(value || "").slice(0, 12);
}

function autosaveDebug(event, details = {}) {
  if (!autosaveDebugEnabled()) return;
  const payload = {
    event,
    sessionId: dispatchSessionId,
    planId: currentPlan?.id || "",
    planDate: currentPlanDate,
    revision: currentPlan?.revision ?? null,
    localPlanDirty,
    saveInFlight,
    saveQueued,
    lastSavedHash: shortHash(lastSavedPlanHash),
    orderCount: orders.length,
    loadCount: trucks.reduce((sum, truck) => sum + (truck.loads?.length || 0), 0),
    ...details
  };
  console.log("[dispatch-autosave]", payload);
}

function reportDispatchSaveError(event, error, details = {}) {
  console.error("[dispatch-save]", {
    event,
    planId: currentPlan?.id || "",
    planDate: currentPlanDate,
    revision: currentPlan?.revision ?? null,
    sessionId: dispatchSessionId,
    message: error?.message || String(error || "Unknown save error"),
    ...details
  }, error);
}

function minutes(value) {
  const [hour, minute] = String(value || "00:00").split(":").map(Number);
  return (hour * 60) + minute;
}

function todayLocalDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - (offset * 60000)).toISOString().slice(0, 10);
}

function timeText(totalMinutes) {
  const wrapped = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

function normalizeTypedDispatchTime(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  let hour;
  let minute;
  const colonMatch = text.match(/^(\d{1,2}):(\d{1,2})$/);
  if (colonMatch) {
    hour = Number(colonMatch[1]);
    minute = Number(colonMatch[2]);
  } else if (/^\d{1,4}$/.test(text)) {
    if (text.length <= 2) {
      hour = Number(text);
      minute = 0;
    } else {
      hour = Number(text.slice(0, -2));
      minute = Number(text.slice(-2));
    }
  } else {
    return "";
  }
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function resolvedLoadStartMode(load = {}) {
  const configured = String(load.startMode || load.start_mode || "").trim().toLowerCase();
  if (configured === "auto" || configured === "fixed") return configured;
  return String(load.start || "").trim() ? "fixed" : "auto";
}

function driverJobIdForStop(truck, load, stop) {
  const assignedTruck = effectiveTruckForLoad(truck, load);
  return [currentPlan?.id, assignedTruck.id || assignedTruck.plate, load.id, stop.id].map((part) => encodeURIComponent(String(part || ""))).join(":");
}

function driverTravelJobIdForLoad(truck, load, startTravel) {
  if (!startTravel) return "";
  const assignedTruck = effectiveTruckForLoad(truck, load);
  const jobStart = startTravel.fromJobLocation || startTravel.from;
  const jobTarget = startTravel.toPickupLocation || startTravel.to;
  return [currentPlan?.id, assignedTruck.id || assignedTruck.plate, load.id, "TRAVEL", jobStart, jobTarget, ""].map((part) => encodeURIComponent(String(part || ""))).join(":");
}

function driverSwitchApproachJobIdForLoad(truck, load, handoffTravel) {
  if (!handoffTravel) return "";
  const previous = previousDriverLoad(truck, load);
  const previousTruck = previous ? effectiveTruckForLoad(previous.truck, previous.load) : null;
  return [
    currentPlan?.id,
    previousTruck?.id || previousTruck?.plate || "",
    load.id,
    "TRAVEL",
    handoffTravel.fromJobLocation || handoffTravel.from,
    handoffTravel.to,
    "TRUCK_SWITCH_APPROACH"
  ].map((part) => encodeURIComponent(String(part || ""))).join(":");
}

function driverReturnJobIdForLoad(truck, load) {
  if (!load?.returnOnly) return "";
  const assignedTruck = effectiveTruckForLoad(truck, load);
  const previousEntry = driverOrientedPlanningEnabled() ? previousDriverLoad(truck, load) : null;
  const index = loadIndexInTruck(truck, load);
  const changedTruck = previousEntry
    && loadTruckPlate(previousEntry.truck, previousEntry.load) !== loadTruckPlate(truck, load);
  const previous = changedTruck
    ? { label: loadSwitchYard(truck, load) }
    : previousEntry
      ? startPointAfterLoad(previousEntry.truck, previousEntry.load)
    : index > 0 ? startPointAfterLoad(truck, (truck.loads || [])[index - 1]) : null;
  const from = previous?.jobLabel || previous?.label || assignedTruck?.base || "";
  const to = load.returnYard || "12441";
  if (!from || String(from) === String(to)) return "";
  return [currentPlan?.id, assignedTruck.id || assignedTruck.plate, load.id, "RETURN", from, to].map((part) => encodeURIComponent(String(part || ""))).join(":");
}

function driverTruckSwitchJobIdForLoad(truck, load) {
  if (!load) return "";
  return [currentPlan?.id, loadDriverKey(truck, load), load.id, "TRUCK_SWITCH"]
    .map((part) => encodeURIComponent(String(part || "")))
    .join(":");
}

function durationText(totalMinutes) {
  const value = Math.max(0, Math.round(Number(totalMinutes || 0)));
  const hours = Math.floor(value / 60);
  const minutesPart = value % 60;
  if (!hours) return `${minutesPart} min`;
  if (!minutesPart) return `${hours} hr`;
  return `${hours} hr ${minutesPart} min`;
}

function formatLbs(value) {
  return `${Math.round(Number(value || 0)).toLocaleString()} lb`;
}

function truckCapacityLbs(truck) {
  return Number(truck?.capacityLbs || 0) || Number(truck?.capacity || 0) * 2000 || 48000;
}

function truckTravelTimePercent(truck) {
  const value = Number(truck?.travelTimePercent ?? truck?.travelPercent ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function adjustedTravelMinutesForTruck(truck, value) {
  const baseMinutes = Number(value || 0);
  if (!Number.isFinite(baseMinutes) || baseMinutes <= 0) return 0;
  const percent = Math.max(0, truckTravelTimePercent(truck));
  return Math.max(1, Math.round(baseMinutes * (1 + (percent / 100))));
}

function travelAdjustmentText(truck) {
  const percent = truckTravelTimePercent(truck);
  return percent > 0 ? `+${percent}% travel` : "Google travel";
}

function driverKey(driver) {
  return String(driver?.login || driver?.name || "").trim();
}

function driverByKey(key) {
  const text = String(key || "").trim();
  return drivers.find((driver) => driverKey(driver) === text || driver.name === text || driver.login === text) || null;
}

function truckDriver(truck) {
  return driverByKey(truck?.driverLogin) || driverByKey(truck?.driver) || null;
}

function driverOrientedPlanningEnabled() {
  return dispatchConfig.driverOrientedPlanning === true;
}

function loadDriverKey(truck, load) {
  return String(load?.driverLogin || load?.driver_login || truck?.driverLogin || truck?.driver_login || "").trim().toLowerCase();
}

function loadDriver(truck, load) {
  return driverByKey(loadDriverKey(truck, load)) || driverByKey(load?.driverName || load?.driver || truck?.driver) || null;
}

function normalizedTruckPlate(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

function loadTruckPlate(truck, load) {
  return normalizedTruckPlate(load?.truckPlate || load?.truck_plate || truck?.plate);
}

function loadTruckId(truck, load) {
  return String(load?.truckId || load?.truck_id || truck?.id || "").trim();
}

function loadSwitchYard(truck, load) {
  return String(load?.switchYard || load?.switch_yard || load?.startYard || truck?.base || "12441").trim();
}

function loadParkingSpot(truck, load) {
  return String(load?.parkingSpot || load?.parking_spot || truck?.parkingSpot || "").trim();
}

function effectiveTruckForLoad(truck, load) {
  const plate = loadTruckPlate(truck, load);
  const fleetTruck = fleet.find((item) => normalizedTruckPlate(item.plate) === plate);
  const assignedDriver = loadDriver(truck, load);
  return {
    ...truck,
    ...(fleetTruck || {}),
    id: loadTruckId(truck, load) || truck?.id || "",
    plate,
    driverLogin: loadDriverKey(truck, load),
    driver: assignedDriver?.name || load?.driverName || load?.driver || truck?.driver || "Unassigned",
    license: assignedDriver?.license || load?.license || truck?.license || "-",
    base: loadSwitchYard(truck, load),
    parkingSpot: loadParkingSpot(truck, load),
    ownYardFixedMinutes: ownYardFixedMinutesFor(assignedDriver, truck),
    vendorFixedMinutes: vendorFixedMinutesFor(assignedDriver, truck),
    deliveryFixedMinutes: deliveryFixedMinutesFor(assignedDriver, truck),
    minutesPerPallet: minutesPerPalletFor(assignedDriver, truck)
  };
}

function assignLoadFields(truck, load, { driver = null, sequence = null } = {}) {
  const assignedDriver = driver || loadDriver(truck, load);
  load.driverLogin = assignedDriver ? driverKey(assignedDriver) : loadDriverKey(truck, load);
  load.driverName = assignedDriver?.name || load.driverName || load.driver || truck.driver || "";
  load.truckId = String(truck.id || "");
  load.truckPlate = String(truck.plate || "").toUpperCase();
  load.switchYard = loadSwitchYard(truck, load);
  load.parkingSpot = loadParkingSpot(truck, load);
  if (!Number.isFinite(Number(load.driverSequence))) load.driverSequence = Number(sequence || 0);
  return load;
}

function normalizeLoadAssignments() {
  const sequenceByDriver = new Map();
  for (const truck of trucks) {
    for (const load of truck.loads || []) {
      const login = loadDriverKey(truck, load);
      const sequence = sequenceByDriver.get(login) || 0;
      assignLoadFields(truck, load, { sequence });
      sequenceByDriver.set(login, Math.max(sequence, Number(load.driverSequence || 0)) + 1);
    }
  }
}

function driverLoadEntries(driverLogin = null) {
  const requested = driverLogin === null ? null : String(driverLogin || "").trim().toLowerCase();
  const entries = [];
  for (const [truckIndex, truck] of trucks.entries()) {
    for (const [loadIndex, load] of (truck.loads || []).entries()) {
      const login = loadDriverKey(truck, load);
      if (requested !== null && login !== requested) continue;
      entries.push({
        truck,
        load,
        truckIndex,
        loadIndex,
        driverLogin: login,
        driver: loadDriver(truck, load),
        sequence: Number(load.driverSequence || 0)
      });
    }
  }
  return entries.sort((left, right) =>
    left.sequence - right.sequence
      || minutes(left.load.start || left.truck.start || DEFAULT_FIRST_LOAD_START) - minutes(right.load.start || right.truck.start || DEFAULT_FIRST_LOAD_START)
      || left.truckIndex - right.truckIndex
      || left.loadIndex - right.loadIndex
  );
}

function normalizedDriverLaneOrder(values = []) {
  const next = [];
  for (const login of Array.isArray(values) ? values : []) {
    const key = String(login || "").trim().toLowerCase();
    if (!key || next.includes(key)) continue;
    next.push(key);
  }
  return next;
}

function defaultDriverLaneOrder() {
  return drivers
    .map((driver, index) => ({ driver, index }))
    .sort((left, right) => {
      const leftOrder = Number(left.driver?.displayOrder);
      const rightOrder = Number(right.driver?.displayOrder);
      const orderDifference = (Number.isFinite(leftOrder) ? leftOrder : left.index)
        - (Number.isFinite(rightOrder) ? rightOrder : right.index);
      return orderDifference || left.index - right.index;
    })
    .map(({ driver }) => String(driverKey(driver) || "").trim().toLowerCase())
    .filter(Boolean);
}

function plannedHistoricalDriverLaneOrder() {
  const next = [];
  for (const truck of trucks || []) {
    for (const load of truck.loads || []) {
      if (!loadHasPlanningContentForAssignment(load)) continue;
      const login = loadDriverKey(truck, load);
      if (login && !next.includes(login)) next.push(login);
    }
  }
  return next;
}

function ensureDriverLaneOrder(preferred = driverLaneOrder) {
  const preferredOrder = normalizedDriverLaneOrder(preferred);
  const defaultOrder = normalizedDriverLaneOrder(defaultDriverLaneOrder());
  const historicalOrder = normalizedDriverLaneOrder(plannedHistoricalDriverLaneOrder());
  const valid = new Set([...defaultOrder, ...historicalOrder, ...preferredOrder]);
  const next = [];
  for (const login of preferredOrder) {
    if (valid.has(login) && !next.includes(login)) next.push(login);
  }
  for (const login of [...defaultOrder, ...historicalOrder]) {
    if (!next.includes(login)) next.push(login);
  }
  driverLaneOrder = next;
  return driverLaneOrder;
}

function applyDriverLaneOrder(nextOrder, driverLogin) {
  const next = normalizedDriverLaneOrder(nextOrder);
  const before = [...driverLaneOrder];
  if (before.length === next.length && before.every((login, index) => login === next[index])) return false;
  driverLaneOrder = next;
  const key = String(driverLogin || "").trim().toLowerCase();
  logDispatchAudit({
    action: "driver_lane_sequence_updated",
    entityType: "plan",
    entityId: currentPlan?.id || currentPlanDate,
    before,
    after: [...driverLaneOrder],
    details: { planDate: currentPlanDate, driverLogin: key, fromIndex: before.indexOf(key), toIndex: driverLaneOrder.indexOf(key) }
  });
  return true;
}

function moveDriverLane(driverLogin, delta) {
  const key = String(driverLogin || "").trim().toLowerCase();
  ensureDriverLaneOrder();
  const index = driverLaneOrder.indexOf(key);
  const target = index + Number(delta || 0);
  if (index < 0 || target < 0 || target >= driverLaneOrder.length) return false;
  const next = [...driverLaneOrder];
  const [login] = next.splice(index, 1);
  next.splice(target, 0, login);
  return applyDriverLaneOrder(next, key);
}

function moveDriverLaneByDrop(driverLogin, targetLogin, insertAfter = false) {
  const key = String(driverLogin || "").trim().toLowerCase();
  const targetKey = String(targetLogin || "").trim().toLowerCase();
  ensureDriverLaneOrder();
  if (!key || !targetKey || key === targetKey || !driverLaneOrder.includes(key) || !driverLaneOrder.includes(targetKey)) return false;
  const next = driverLaneOrder.filter((login) => login !== key);
  const targetIndex = next.indexOf(targetKey);
  next.splice(targetIndex + (insertAfter ? 1 : 0), 0, key);
  return applyDriverLaneOrder(next, key);
}

function historicalDriverForLane(driverLogin) {
  const key = String(driverLogin || "").trim().toLowerCase();
  for (const truck of trucks || []) {
    for (const load of truck.loads || []) {
      if (loadDriverKey(truck, load) !== key) continue;
      return {
        login: key,
        name: load.driverName || load.driver || truck.driver || key,
        license: load.driverLicense || load.license || truck.license || "-"
      };
    }
    if (String(truck.driverLogin || truck.driver_login || "").trim().toLowerCase() === key) {
      return { login: key, name: truck.driver || key, license: truck.license || "-" };
    }
  }
  return { login: key, name: key, license: "-" };
}

function driverLanes() {
  ensureDriverLaneOrder();
  const laneOrder = new Map(driverLaneOrder.map((login, index) => [login, index]));
  const laneByLogin = new Map(drivers.map((driver, index) => {
    const login = String(driverKey(driver) || "").trim().toLowerCase();
    return [login, {
      driverLogin: login,
      driver,
      driverName: driver.name,
      displayOrder: Number(driver.displayOrder ?? index),
      historical: false,
      entries: []
    }];
  }));
  for (const [index, login] of driverLaneOrder.entries()) {
    if (laneByLogin.has(login)) continue;
    const historicalDriver = historicalDriverForLane(login);
    laneByLogin.set(login, {
      driverLogin: login,
      driver: historicalDriver,
      driverName: historicalDriver.name || login,
      displayOrder: index,
      historical: true,
      entries: []
    });
  }
  laneByLogin.set("", {
    driverLogin: "",
    driver: null,
    driverName: "Unassigned",
    displayOrder: 200000,
    historical: false,
    entries: []
  });
  for (const entry of driverLoadEntries()) {
    const login = entry.driverLogin;
    if (!laneByLogin.has(login)) {
      if (!loadHasPlanningContentForAssignment(entry.load)) continue;
      laneByLogin.set(login, {
        driverLogin: login,
        driver: entry.driver || historicalDriverForLane(login),
        driverName: entry.driver?.name || entry.load.driverName || (login ? login : "Unassigned"),
        displayOrder: login ? 100000 : 200000,
        historical: Boolean(login && !entry.driver),
        entries: []
      });
    }
    laneByLogin.get(login).entries.push(entry);
  }
  return [...laneByLogin.values()].sort((left, right) => {
    if (!left.driverLogin) return 1;
    if (!right.driverLogin) return -1;
    const leftOrder = laneOrder.has(left.driverLogin) ? laneOrder.get(left.driverLogin) : left.displayOrder;
    const rightOrder = laneOrder.has(right.driverLogin) ? laneOrder.get(right.driverLogin) : right.displayOrder;
    return leftOrder - rightOrder || left.driverName.localeCompare(right.driverName);
  });
}

function nextDriverSequence(driverLogin) {
  const entries = driverLoadEntries(driverLogin);
  return entries.length ? Math.max(...entries.map((entry) => Number(entry.load.driverSequence || 0))) + 1 : 0;
}

function previousDriverLoad(truck, load) {
  const entries = driverLoadEntries(loadDriverKey(truck, load));
  const index = entries.findIndex((entry) => entry.load.id === load.id);
  return index > 0 ? entries[index - 1] : null;
}

function firstTruckUseEntry(truck, load) {
  const plate = loadTruckPlate(truck, load);
  if (!plate) return null;
  const entries = [];
  for (const [truckIndex, parentTruck] of trucks.entries()) {
    for (const [loadIndex, candidate] of (parentTruck.loads || []).entries()) {
      if (loadTruckPlate(parentTruck, candidate) !== plate) continue;
      entries.push({
        truck: parentTruck,
        load: candidate,
        truckIndex,
        loadIndex,
        sequence: Number(candidate.driverSequence || 0)
      });
    }
  }
  const plannedEntries = entries.filter((entry) => loadHasPlanningContentForAssignment(entry.load));
  const candidates = plannedEntries.length ? plannedEntries : entries;
  return candidates.sort((left, right) =>
    minutes(left.load.start || left.truck.start || DEFAULT_FIRST_LOAD_START)
      - minutes(right.load.start || right.truck.start || DEFAULT_FIRST_LOAD_START)
      || left.sequence - right.sequence
      || left.truckIndex - right.truckIndex
      || left.loadIndex - right.loadIndex
  )[0] || null;
}

function isFirstTruckUse(truck, load) {
  return firstTruckUseEntry(truck, load)?.load?.id === load?.id;
}

function truckHasDriver(truck) {
  return Boolean(truckDriver(truck));
}

function loadHasAssignedDriver(truck, load) {
  return driverOrientedPlanningEnabled() ? Boolean(loadDriverKey(truck, load)) : truckHasDriver(truck);
}

function truckHasPlanningContent(truck) {
  return (truck?.loads || []).some((load, index) => load.returnOnly || load.stops?.length || index > 0);
}

function driverAssignedToOtherTruck(driverKeyValue, truckId = "") {
  const key = String(driverKeyValue || "").trim();
  if (!key) return false;
  return trucks.some((truck) => truck.id !== truckId && driverKey(truckDriver(truck)) === key);
}

function truckAssignedToDriver(driverKeyValue, truckId = "") {
  const key = String(driverKeyValue || "").trim();
  if (!key) return null;
  return trucks.find((truck) => truck.id !== truckId && driverKey(truckDriver(truck)) === key) || null;
}

function driverLockNotice(truck) {
  return `${truck?.plate || "This truck"} needs a driver before dispatch planning can change loads.`;
}

function ownYardFixedMinutesFor(driver, truck = {}) {
  return Number(driver?.ownYardFixedMinutes || driver?.loadMinutes || truck?.ownYardFixedMinutes || truck?.loadMinutes || 40);
}

function outsideFixedMinutesFor(driver, truck = {}) {
  return deliveryFixedMinutesFor(driver, truck);
}

function vendorFixedMinutesFor(driver, truck = {}) {
  return Number(driver?.vendorFixedMinutes || truck?.vendorFixedMinutes || driver?.outsideFixedMinutes || driver?.unloadMinutes || truck?.outsideFixedMinutes || truck?.unloadMinutes || 35);
}

function deliveryFixedMinutesFor(driver, truck = {}) {
  return Number(driver?.deliveryFixedMinutes || truck?.deliveryFixedMinutes || driver?.outsideFixedMinutes || driver?.unloadMinutes || truck?.outsideFixedMinutes || truck?.unloadMinutes || 35);
}

function minutesPerPalletFor(driver, truck = {}) {
  return Number(driver?.minutesPerPallet || truck?.minutesPerPallet || 1);
}

function truckOwnYardFixedMinutes(truck) {
  const driver = truckDriver(truck);
  return ownYardFixedMinutesFor(driver, truck);
}

function truckOutsideFixedMinutes(truck) {
  return truckDeliveryFixedMinutes(truck);
}

function truckVendorFixedMinutes(truck) {
  const driver = truckDriver(truck);
  return vendorFixedMinutesFor(driver, truck);
}

function truckDeliveryFixedMinutes(truck) {
  const driver = truckDriver(truck);
  return deliveryFixedMinutesFor(driver, truck);
}

function truckMinutesPerPallet(truck) {
  const driver = truckDriver(truck);
  return minutesPerPalletFor(driver, truck);
}

function truckStopMinutes(truck, stopType = "delivery", palletCount = 0) {
  const type = stopType === true ? "own" : stopType === false ? "delivery" : String(stopType || "delivery");
  if (type === "own") return Math.round(truckOwnYardFixedMinutes(truck));
  if (type === "vendor") return Math.round(truckVendorFixedMinutes(truck));
  return Math.round(truckDeliveryFixedMinutes(truck) + (Number(palletCount || 0) * truckMinutesPerPallet(truck)));
}

function truckLoadMinutes(truck) {
  return truckOwnYardFixedMinutes(truck);
}

function truckUnloadMinutes(truck) {
  return truckOutsideFixedMinutes(truck);
}

function driverOptions(selectedKey = "", truckId = "") {
  const current = String(selectedKey || "").trim();
  const options = [`<option value="">Unassigned</option>`];
  const renderedKeys = new Set();
  for (const driver of drivers) {
    const key = driverKey(driver);
    if (!key || renderedKeys.has(key)) continue;
    renderedKeys.add(key);
    const assignedElsewhere = key !== current && driverAssignedToOtherTruck(key, truckId);
    const suffix = assignedElsewhere ? (current ? " | swap" : " | on other truck") : "";
    options.push(`<option value="${escapeHtml(key)}" ${key === current ? "selected" : ""}>${escapeHtml(driver.name)} | ${escapeHtml(driver.license || "-")}${suffix}</option>`);
  }
  return options.join("");
}

function applyDriverToTruck(truck, driver) {
  truck.driverLogin = driver ? driverKey(driver) : "";
  truck.driver = driver?.name || "Unassigned";
  truck.license = driver?.license || "-";
  truck.ownYardFixedMinutes = ownYardFixedMinutesFor(driver, truck);
  truck.vendorFixedMinutes = vendorFixedMinutesFor(driver, truck);
  truck.deliveryFixedMinutes = deliveryFixedMinutesFor(driver, truck);
  truck.outsideFixedMinutes = truck.deliveryFixedMinutes;
  truck.minutesPerPallet = minutesPerPalletFor(driver, truck);
  truck.loadMinutes = truck.ownYardFixedMinutes;
  truck.unloadMinutes = truck.deliveryFixedMinutes;
}

function normalizeUniqueTruckDrivers(nextTrucks = []) {
  if (driverOrientedPlanningEnabled()) return nextTrucks;
  const used = new Set();
  for (const truck of nextTrucks || []) {
    const key = driverKey(truckDriver(truck)) || String(truck?.driverLogin || "").trim();
    if (!key) continue;
    if (used.has(key)) {
      applyDriverToTruck(truck, null);
      continue;
    }
    used.add(key);
  }
  return nextTrucks;
}

function makeTruckFromFleet(vehicle, index, saved = {}) {
  const defaultDriver = drivers[index] || {};
  const savedDriverKey = saved.driverLogin || saved.driver_login || driverKey(driverByKey(saved.driver)) || driverKey(defaultDriver);
  const driver = driverByKey(savedDriverKey) || defaultDriver;
  const id = saved.id || `T${index + 1}`;
  return {
    id,
    plate: vehicle.plate,
    capacityLbs: truckCapacityLbs(vehicle),
    driverLogin: savedDriverKey || "",
    driver: driver.name || saved.driver || "Unassigned",
    license: driver.license || saved.license || "-",
    base: saved.base ?? vehicle.baseYard ?? "",
    parkingSpot: saved.parkingSpot || vehicle.parkingSpot || "",
    start: saved.start || timeText(7 * 60 + (index * 30)),
    ownYardFixedMinutes: Number(saved.ownYardFixedMinutes || saved.loadMinutes || driver.ownYardFixedMinutes || driver.loadMinutes || 40),
    vendorFixedMinutes: Number(saved.vendorFixedMinutes || driver.vendorFixedMinutes || saved.outsideFixedMinutes || saved.unloadMinutes || driver.outsideFixedMinutes || driver.unloadMinutes || 35),
    deliveryFixedMinutes: Number(saved.deliveryFixedMinutes || driver.deliveryFixedMinutes || saved.outsideFixedMinutes || saved.unloadMinutes || driver.outsideFixedMinutes || driver.unloadMinutes || 35),
    outsideFixedMinutes: Number(saved.deliveryFixedMinutes || driver.deliveryFixedMinutes || saved.outsideFixedMinutes || saved.unloadMinutes || driver.outsideFixedMinutes || driver.unloadMinutes || 35),
    minutesPerPallet: Number(saved.minutesPerPallet || driver.minutesPerPallet || 1),
    travelTimePercent: vehicle.travelTimePercent !== undefined || vehicle.travelPercent !== undefined
      ? truckTravelTimePercent(vehicle)
      : truckTravelTimePercent(saved),
    loadMinutes: Number(saved.ownYardFixedMinutes || saved.loadMinutes || driver.ownYardFixedMinutes || driver.loadMinutes || 40),
    unloadMinutes: Number(saved.deliveryFixedMinutes || driver.deliveryFixedMinutes || saved.outsideFixedMinutes || saved.unloadMinutes || driver.outsideFixedMinutes || driver.unloadMinutes || 35),
    loads: Array.isArray(saved.loads) ? saved.loads : [{ id: `${id}-L1`, name: "Load 1", stops: [] }]
  };
}

function trucksFromFleetAndSavedPlan(savedTrucks = []) {
  const savedList = Array.isArray(savedTrucks) ? savedTrucks : [];
  const plateKey = normalizedTruckPlate;
  const fleetByPlate = new Map(fleet.map((vehicle) => [plateKey(vehicle.plate), vehicle]));
  const savedByPlate = new Map(savedList.map((truck) => [plateKey(truck.plate), truck]));
  const orderedVehicles = [];
  const seen = new Set();
  for (const savedTruck of savedList) {
    const plate = plateKey(savedTruck.plate);
    const activeVehicle = fleetByPlate.get(plate);
    if (!activeVehicle && !(savedTruck.loads || []).some(loadHasPlanningContentForAssignment)) continue;
    const vehicle = activeVehicle || { plate, capacityLbs: truckCapacityLbs(savedTruck), travelTimePercent: truckTravelTimePercent(savedTruck) };
    if (!vehicle.plate || seen.has(plateKey(vehicle.plate))) continue;
    orderedVehicles.push(vehicle);
    seen.add(plateKey(vehicle.plate));
  }
  for (const vehicle of fleet) {
    const plate = plateKey(vehicle.plate);
    if (!plate || seen.has(plate)) continue;
    orderedVehicles.push(vehicle);
    seen.add(plate);
  }
  return normalizeUniqueTruckDrivers(orderedVehicles.map((vehicle, index) => {
    const savedTruck = savedByPlate.get(plateKey(vehicle.plate));
    return makeTruckFromFleet(
      vehicle,
      index,
      savedTruck || (driverOrientedPlanningEnabled() ? { loads: [] } : undefined)
    );
  }));
}

function moveTruckInPlan(truckId, delta) {
  const index = trucks.findIndex((truck) => truck.id === truckId);
  if (index < 0) return false;
  const next = index + delta;
  if (next < 0 || next >= trucks.length) return false;
  const before = trucks.map((truck) => truck.plate);
  const [truck] = trucks.splice(index, 1);
  trucks.splice(next, 0, truck);
  selectedLoadId = truck.loads?.[0]?.id || selectedLoadId;
  logDispatchAudit({
    action: "truck_display_sequence_updated",
    entityType: "truck",
    entityId: truck.id,
    truckId: truck.id,
    before,
    after: trucks.map((item) => item.plate),
    details: { planDate: currentPlanDate, fromIndex: index, toIndex: next }
  });
  return true;
}

function orderWeightLbs(order) {
  return Math.round(Number(order?.weight || 0));
}

function dropoffForStop(order = {}, stop = {}) {
  const dropoffs = Array.isArray(order.dropoffs) ? order.dropoffs : [];
  const key = String(stop.dropoffKey || "");
  if (key) {
    const exact = dropoffs.find((dropoff) => String(dropoff.key || "") === key);
    if (exact) return exact;
  }
  const yard = String(stop.dropLocation || "");
  if (yard) {
    const exact = dropoffs.find((dropoff) => String(dropoff.destinationYard || "") === yard);
    if (exact) return exact;
  }
  return dropoffs.length === 1 ? dropoffs[0] : null;
}

function dropItemsForStop(order = {}, stop = {}) {
  const stopLineRowIds = Array.isArray(stop.lineRowIds) ? stop.lineRowIds.filter((value) => value !== null && value !== undefined && String(value) !== "") : [];
  const dropoffLineRowIds = dropoffForStop(order, stop)?.lineRowIds || [];
  const lineRowIds = new Set((stopLineRowIds.length ? stopLineRowIds : dropoffLineRowIds).map(String));
  if (!lineRowIds.size) return (order.dropoffs || []).length > 1 ? [] : order.items || [];
  return (order.items || []).filter((item) => lineRowIds.has(String(item.lineRowId)));
}

function dropWeightLbs(order = {}, stop = {}) {
  const explicit = stop.dropWeight ?? dropoffForStop(order, stop)?.weight;
  if (explicit !== undefined && explicit !== null && Number.isFinite(Number(explicit))) return Math.max(0, Math.round(Number(explicit)));
  const itemWeight = dropItemsForStop(order, stop).reduce((sum, item) => {
    const lineWeight = Number(item.lineWeight || 0);
    return sum + (lineWeight || (Number(item.quantity || item.salesQty || 0) * Number(item.itemWeight || 0)));
  }, 0);
  if (itemWeight > 0) return Math.round(itemWeight);
  return (order.dropoffs || []).length > 1 ? 0 : orderWeightLbs(order);
}

function dropPallets(order = {}, stop = {}) {
  const explicit = stop.dropPallets ?? dropoffForStop(order, stop)?.pallets;
  if (explicit !== undefined && explicit !== null && Number.isFinite(Number(explicit))) return Math.max(0, Number(explicit));
  const itemPallets = dropItemsForStop(order, stop).reduce((sum, item) => sum + Number(item.pallets || 0), 0);
  if (itemPallets > 0) return itemPallets;
  return (order.dropoffs || []).length > 1 ? 0 : Number(order.pallets || 0);
}

function dropUnitText(order = {}, stop = {}) {
  const dropoff = dropoffForStop(order, stop) || {};
  const items = dropItemsForStop(order, stop);
  const layers = Number(stop.dropLayers ?? dropoff.layers ?? items.reduce((sum, item) => sum + Number(item.layers || 0), 0));
  return `${qtyText(dropPallets(order, stop))} PLT${layers ? ` ${qtyText(layers)} LYR` : ""}`;
}

function dropFootprintPallets(order = {}, stop = {}) {
  const dropoff = dropoffForStop(order, stop) || {};
  const items = dropItemsForStop(order, stop);
  const pallets = dropPallets(order, stop);
  const hasLoose = Number(stop.dropLayers ?? dropoff.layers ?? 0) > 0
    || Number(stop.dropSections ?? dropoff.sections ?? 0) > 0
    || Number(stop.dropPieces ?? dropoff.pieces ?? 0) > 0
    || items.some((item) => Number(item.layers || 0) > 0 || Number(item.sections || 0) > 0 || Number(item.pieces || 0) > 0);
  return pallets + (hasLoose ? 1 : 0);
}

function orderFootprintPallets(order) {
  return Number(order?.pallets || 0) + (Number(order?.layers || 0) > 0 ? 1 : 0);
}

function yardTravelMinutes(from, to) {
  if (!from || !to || String(from) === String(to)) return 0;
  const fromHub = HUBS[from];
  const toHub = HUBS[to];
  if (!fromHub || !toHub) return 30;
  const latKm = (fromHub.lat - toHub.lat) * 111;
  const lngKm = (fromHub.lng - toHub.lng) * 111 * Math.cos(((fromHub.lat + toHub.lat) / 2) * Math.PI / 180);
  const km = Math.sqrt((latKm * latKm) + (lngKm * lngKm));
  return Math.max(12, Math.round((km / 48) * 60));
}

function itemFootprint(item) {
  if (item?.splitQty !== undefined) return Number(item.splitQty || 0);
  return Number(item?.pallets || item?.layers || item?.sections || item?.pieces || item?.quantity || 0);
}

function splitItemKey(item = {}, index = 0) {
  return String(item.lineRowId || item.id || item.lineId || item.line_id || item.sku || item.itemName || `item-${index}`);
}

function conversionNumber(item = {}, key) {
  const fieldMap = {
    pallets: ["toPlt", "to_plt"],
    layers: ["toLyr", "to_lyr"],
    sections: ["toSec", "to_sec"],
    pieces: ["toPcs", "to_pcs"]
  };
  return Number((fieldMap[key] || []).map((field) => item[field]).find((value) => Number(value || 0) > 0) || 0);
}

function splitQuantityValue(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function splitNumberAcrossParts(total, parts, step = 1) {
  const cleanTotal = splitQuantityValue(total);
  const cleanParts = Math.max(1, Number(parts) || 1);
  if (step >= 1 && Number.isInteger(cleanTotal)) {
    const base = Math.floor(cleanTotal / cleanParts);
    const remainder = cleanTotal % cleanParts;
    return Array.from({ length: cleanParts }).map((_, index) => base + (index < remainder ? 1 : 0));
  }
  const base = Math.floor((cleanTotal / cleanParts) * 1000000) / 1000000;
  let remaining = cleanTotal;
  return Array.from({ length: cleanParts }).map((_, index) => {
    if (index === cleanParts - 1) return Math.round(remaining * 1000000) / 1000000;
    remaining -= base;
    return base;
  });
}

function splitUnitDefinitions(item = {}) {
  const convertedUnits = [
    { key: "pallets", label: "PLT", total: Number(item.pallets || item.pallet_qty || 0), conversion: conversionNumber(item, "pallets"), step: 1 },
    { key: "layers", label: "LYR", total: Number(item.layers || item.layer_qty || 0), conversion: conversionNumber(item, "layers"), step: 1 },
    { key: "sections", label: "SEC", total: Number(item.sections || item.section_qty || 0), conversion: conversionNumber(item, "sections"), step: 1 },
    { key: "pieces", label: "PCS", total: Number(item.pieces || item.piece_qty || 0), conversion: conversionNumber(item, "pieces"), step: 1 }
  ].filter((unit) => unit.conversion > 0);
  const unitsWithRequiredQty = convertedUnits.filter((unit) => unit.total > 0);
  if (unitsWithRequiredQty.length) return unitsWithRequiredQty;
  if (convertedUnits.length && Number(item.quantity || item.salesQty || 0) > 0) {
    let remaining = Number(item.quantity || item.salesQty || 0);
    const derivedUnits = convertedUnits
      .sort((a, b) => b.conversion - a.conversion)
      .map((unit) => {
        const total = Math.floor((remaining / unit.conversion) + 0.000001);
        remaining -= total * unit.conversion;
        return { ...unit, total };
      })
      .filter((unit) => unit.total > 0);
    if (derivedUnits.length) return derivedUnits;
  }
  const unitLabel = item.unit || item.salesUom || item.sales_uom || "QTY";
  return [{ key: "quantity", label: unitLabel, total: Number(item.quantity || item.salesQty || 0), conversion: 1, step: 0.01 }];
}

function splitPartTemplate(item = {}) {
  return splitUnitDefinitions(item).reduce((part, unit) => {
    part[unit.key] = 0;
    return part;
  }, {});
}

function normalizeSplitPartValue(item = {}, value) {
  const template = splitPartTemplate(item);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(template)) template[key] = splitQuantityValue(value[key]);
    return template;
  }
  const firstUnit = splitUnitDefinitions(item)[0]?.key || "quantity";
  template[firstUnit] = splitQuantityValue(value);
  return template;
}

function splitPartSalesQuantity(item = {}, part = {}) {
  const units = splitUnitDefinitions(item);
  const hasConversion = units.some((unit) => unit.key !== "quantity");
  if (!hasConversion) return splitQuantityValue(part.quantity);
  const converted = units.reduce((sum, unit) => {
    if (unit.key === "quantity") return sum;
    return sum + (splitQuantityValue(part[unit.key]) * conversionNumber(item, unit.key));
  }, 0);
  return Math.round(converted * 1000000) / 1000000;
}

function splitPartLabel(item = {}, part = {}) {
  return splitUnitDefinitions(item)
    .map((unit) => {
      const value = splitQuantityValue(part[unit.key]);
      return value > 0 ? `${qtyText(value)} ${unit.label}` : "";
    })
    .filter(Boolean)
    .join(" ");
}

function splitItemTotalLabel(item = {}) {
  return splitUnitDefinitions(item)
    .map((unit) => `${qtyText(unit.total)} ${unit.label}`)
    .join(" ");
}

function orderUnitText(order) {
  return `${order.pallets || 0} PLT${order.layers ? ` ${order.layers} LYR` : ""}`;
}

function orderPickupText(order) {
  const locations = order?.pickupLocations?.length ? order.pickupLocations : order?.sourceYard ? [order.sourceYard] : [];
  return locations.length ? locations.join(", ") : "--";
}

function packedUnitText(order) {
  const packed = order?.packed || {};
  const parts = [
    ["PLT", packed.pallets],
    ["LYR", packed.layers],
    ["SEC", packed.sections],
    ["PCS", packed.pieces]
  ].filter(([, value]) => Number(value || 0) > 0)
    .map(([label, value]) => `${Number(value).toLocaleString()} ${label}`);
  return parts.join(" ");
}

function qtyText(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : number.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function itemQtyText(item = {}) {
  const parts = [
    ["PLT", item.pallets],
    ["LYR", item.layers],
    ["SEC", item.sections],
    ["PCS", item.pieces]
  ].filter(([, value]) => Number(value || 0) > 0)
    .map(([label, value]) => `${qtyText(value)} ${label}`);
  if (!parts.length && Number(item.quantity || item.salesQty || 0) > 0) parts.push(`${qtyText(item.quantity || item.salesQty)} ${item.unit || "Qty"}`);
  return parts.join(" ") || "0";
}

function positiveBalance(value, allocated) {
  return Math.max(Number(value || 0) - Number(allocated || 0), 0);
}

function isOwnYardCode(value) {
  return Boolean(ownYardForLocation(value));
}

function directPickupEntriesForLocation(order = {}, pickupLocation = "") {
  const location = normalizedPickupLocation(pickupLocation);
  return (order.directPickupManifest || []).filter((entry) => normalizedPickupLocation(entry.location) === location);
}

function directPickupItemsForLocation(order = {}, pickupLocation = "") {
  return directPickupEntriesForLocation(order, pickupLocation).flatMap((entry) => (entry.items || []).map((item) => ({
    ...item,
    sku: item.sku || item.itemName || "",
    pallets: Number(item.palletQty || 0),
    layers: Number(item.layerQty || 0),
    sections: Number(item.sectionQty || 0),
    pieces: Number(item.pieceQty || 0),
    quantity: Number(item.quantity || 0),
    salesQty: Number(item.quantity || 0)
  })));
}

function poPickupEntriesForLocation(order = {}, pickupLocation = "") {
  const location = normalizedPickupLocation(pickupLocation);
  return (order.poPickupManifest || []).filter((entry) => normalizedPickupLocation(entry.location) === location);
}

function poPickupItemsForLocation(order = {}, pickupLocation = "") {
  return poPickupEntriesForLocation(order, pickupLocation).flatMap((entry) => (entry.items || []).map((item) => ({
    ...item,
    sku: item.sku || item.itemName || "",
    salesQty: Number(item.quantity || 0)
  })));
}

function directPickupAllocatedForItem(order = {}, item = {}) {
  const itemId = String(item.itemId || item.item_id || "");
  const sku = String(item.sku || item.itemName || item.name || "").trim().toLowerCase();
  const matches = (order.directPickupManifest || []).flatMap((entry) => entry.items || []).filter((entry) => {
    if (itemId && String(entry.itemId || entry.item_id || "") === itemId) return true;
    return sku && String(entry.sku || entry.itemName || "").trim().toLowerCase() === sku;
  });
  return matches.reduce((total, entry) => ({
    pallets: total.pallets + Number(entry.palletQty || 0),
    layers: total.layers + Number(entry.layerQty || 0),
    sections: total.sections + Number(entry.sectionQty || 0),
    pieces: total.pieces + Number(entry.pieceQty || 0),
    quantity: total.quantity + Number(entry.quantity || 0)
  }), { pallets: 0, layers: 0, sections: 0, pieces: 0, quantity: 0 });
}

function itemForPickupLocation(item = {}, pickupLocation = "", order = {}) {
  if (order?.type === "CUSTOM") return item;
  const location = String(pickupLocation || "").trim();
  if (!location) return item;
  if (isOwnYardCode(location)) {
    const direct = String(order.sourceYard || order.outboundLocation || "") === location
      ? directPickupAllocatedForItem(order, item)
      : { pallets: 0, layers: 0, sections: 0, pieces: 0, quantity: 0 };
    return {
      ...item,
      pallets: positiveBalance(item.pallets, Number(item.poAllocatedPallets || 0) + direct.pallets),
      layers: positiveBalance(item.layers, Number(item.poAllocatedLayers || 0) + direct.layers),
      sections: positiveBalance(item.sections, Number(item.poAllocatedSections || 0) + direct.sections),
      pieces: positiveBalance(item.pieces, Number(item.poAllocatedPieces || 0) + direct.pieces),
      quantity: positiveBalance(item.quantity || item.salesQty, Number(item.poAllocatedSalesQty || 0) + direct.quantity),
      salesQty: positiveBalance(item.salesQty || item.quantity, Number(item.poAllocatedSalesQty || 0) + direct.quantity)
    };
  }
  return {
    ...item,
    pallets: Number(item.poAllocatedPallets || 0),
    layers: Number(item.poAllocatedLayers || 0),
    sections: Number(item.poAllocatedSections || 0),
    pieces: Number(item.poAllocatedPieces || 0),
    quantity: Number(item.poAllocatedSalesQty || 0),
    salesQty: Number(item.poAllocatedSalesQty || 0)
  };
}

function normalizedPickupLocation(value) {
  return String(value || "").trim().toLowerCase();
}

function orderRequiresPickupLocation(order = {}, pickupLocation = "") {
  const target = normalizedPickupLocation(pickupLocation);
  if (!target) return false;
  return requiredPickupLocations(order).some((location) => normalizedPickupLocation(location) === target);
}

function pickupOrdersForStop(load, stop) {
  if (!load || !stop || stop.type !== "pick") return [];
  const ordersForLocation = [];
  const seen = new Set();
  for (const candidate of load.stops || []) {
    if (candidate.type !== "drop") continue;
    const order = stopOrder(candidate);
    if (!order || seen.has(order.id)) continue;
    if (!orderRequiresPickupLocation(order, stop.location)) continue;
    seen.add(order.id);
    ordersForLocation.push(order);
  }
  const directOrder = stopOrder(stop);
  if (directOrder && !seen.has(directOrder.id)) ordersForLocation.unshift(directOrder);
  return ordersForLocation;
}

function itemHasQuantity(item = {}) {
  return Number(item.pallets || 0)
    || Number(item.layers || 0)
    || Number(item.sections || 0)
    || Number(item.pieces || 0)
    || Number(item.quantity || item.salesQty || 0);
}

function tooltipItemsForOrder(order, { pickupLocation = "", stop = null } = {}) {
  if (stop?.type === "drop") return dropItemsForStop(order, stop).filter(itemHasQuantity);
  if (pickupLocation && order?.type === "PO") {
    return (order.items || []).filter(itemHasQuantity);
  }
  const directItems = pickupLocation ? directPickupItemsForLocation(order, pickupLocation) : [];
  if (directItems.length && String(order.sourceYard || order.outboundLocation || "") !== String(pickupLocation || "")) {
    return directItems.filter(itemHasQuantity);
  }
  const poItems = pickupLocation ? poPickupItemsForLocation(order, pickupLocation) : [];
  if (poItems.length && !isOwnYardCode(pickupLocation)) return poItems.filter(itemHasQuantity);
  return (order.items || [])
    .map((item) => pickupLocation ? itemForPickupLocation(item, pickupLocation, order) : item)
    .filter(itemHasQuantity);
}

function tooltipItemRowsForOrder(order, { pickupLocation = "", stop = null, includeOrderHeader = false } = {}) {
  const directEntries = pickupLocation ? directPickupEntriesForLocation(order, pickupLocation) : [];
  if (directEntries.length && String(order.sourceYard || order.outboundLocation || "") !== String(pickupLocation || "")) {
    return directEntries.map((entry) => `
      <div>
        <b>${escapeHtml(entry.transferOrderRef || order.id)}</b>
        <span>For ${escapeHtml(entry.salesOrderRef || order.id)}</span>
      </div>
      ${(entry.items || []).map((item) => `
        <div>
          <b>${escapeHtml(item.sku || item.itemName || "")}</b>
          <span>${escapeHtml(itemQtyText({
            pallets: item.palletQty,
            layers: item.layerQty,
            sections: item.sectionQty,
            pieces: item.pieceQty,
            quantity: item.quantity,
            unit: item.unit
          }))}</span>
        </div>
      `).join("")}
    `).join("");
  }
  const poEntries = pickupLocation ? poPickupEntriesForLocation(order, pickupLocation) : [];
  if (poEntries.length && !isOwnYardCode(pickupLocation)) {
    return poEntries.map((entry) => `
      <div>
        <b>${escapeHtml(entry.poOrderRef || order.id)}</b>
        <span>${escapeHtml(entry.location || "Vendor pickup")}</span>
      </div>
      ${(entry.items || []).map((item) => `
        <div>
          <b>${escapeHtml(item.sku || item.itemName || "")}</b>
          <span>${escapeHtml(itemQtyText(item))}</span>
        </div>
      `).join("")}
    `).join("");
  }
  const rows = tooltipItemsForOrder(order, { pickupLocation, stop }).map((item) => `
    <div>
      <b>${escapeHtml(item.sku)}</b>
      <span>${escapeHtml(itemQtyText(item))}</span>
    </div>
  `).join("");
  if (!rows) return "";
  if (!includeOrderHeader) return rows;
  return `
    <div>
      <b>${escapeHtml(order.id)}</b>
      <span>${escapeHtml(order.customer || movementText(order) || "")}</span>
    </div>
    ${rows}
  `;
}

function availableUnitsForLine(line = {}) {
  const available = line.available || {};
  const units = [
    ["pallets", "PLT", available.pallets],
    ["layers", "LYR", available.layers],
    ["sections", "SEC", available.sections],
    ["pieces", "PCS", available.pieces]
  ].filter(([, , value]) => Number(value || 0) > 0);
  if (line.independentSalesQty && Number(available.salesQty || 0) > 0) {
    units.push(["salesQty", line.required?.unit || "Sales Qty", available.salesQty]);
  }
  if (units.length) return units;
  if (Number(available.salesQty || 0) > 0) return [["salesQty", line.required?.unit || "Qty", available.salesQty]];
  return [];
}

function linkQuantityInputStep() {
  return "0.000001";
}

function availableQtyTextForLine(line = {}) {
  return itemQtyText({ ...(line.available || {}), unit: line.required?.unit || "Qty" });
}

function linkSalesQuantityFromValues(values = {}, conversions = {}) {
  const converted = ["pallets", "layers", "sections", "pieces"].reduce(
    (sum, unit) => sum + (Number(values[unit] || 0) * Number(conversions[unit] || 0)),
    0
  );
  return Number((converted > 0 ? converted : Number(values.salesQty || 0)).toFixed(6));
}

function updateLinkSalesEquivalent(row) {
  if (!row) return;
  const values = {};
  for (const input of row.querySelectorAll("[data-to-link-qty], [data-po-link-qty]")) {
    const field = input.dataset.toLinkQty || input.dataset.poLinkQty;
    values[field] = Number(input.value || 0);
  }
  const conversions = {
    pallets: Number(row.dataset.toPlt || 0),
    layers: Number(row.dataset.toLyr || 0),
    sections: Number(row.dataset.toSec || 0),
    pieces: Number(row.dataset.toPcs || 0)
  };
  const equivalent = row.querySelector("[data-link-sales-equivalent]");
  if (equivalent) equivalent.textContent = `Selected ${qtyText(linkSalesQuantityFromValues(values, conversions))} ${row.dataset.salesUnit || "Qty"}`;
}

function normalizedLinkItemName(value) {
  return String(value || "").trim().toLowerCase();
}

function linkLineItemsMatch(salesLine = {}, sourceLine = {}) {
  const salesItemId = String(salesLine.itemId || salesLine.item_id || "").trim();
  const sourceItemId = String(sourceLine.itemId || sourceLine.item_id || "").trim();
  if (salesItemId && sourceItemId) return salesItemId === sourceItemId;
  const salesName = normalizedLinkItemName(salesLine.sku || salesLine.itemName || salesLine.item_name);
  const sourceName = normalizedLinkItemName(sourceLine.sku || sourceLine.itemName || sourceLine.item_name);
  return Boolean(salesName && sourceName && salesName === sourceName);
}

function poLinkLinesForRef(poRef) {
  const normalizedRef = String(poRef || "").trim().toLowerCase();
  if (!normalizedRef) return [];
  return (poAllocationOptions?.poLines || []).filter(
    (line) => String(line.poRef || "").trim().toLowerCase() === normalizedRef
  );
}

function poLinkCandidateMetaForLine(line = {}, poRef) {
  const normalizedRef = String(poRef || "").trim().toLowerCase();
  return (line.poCandidates || []).filter(
    (candidate) => String(candidate.poRef || "").trim().toLowerCase() === normalizedRef
  );
}

function poLinkCandidateLinesForSalesLine(line = {}, poRef) {
  const candidateIds = new Set(
    poLinkCandidateMetaForLine(line, poRef).map((candidate) => String(candidate.poLineId))
  );
  return poLinkLinesForRef(poRef).filter((poLine) => candidateIds.has(String(poLine.id)));
}

function poLinkMatchMeta(line = {}, poLineId, poRef) {
  return poLinkCandidateMetaForLine(line, poRef).find(
    (candidate) => String(candidate.poLineId) === String(poLineId || "")
  ) || null;
}

function currentPoLinkBoardState(orderRef) {
  const draft = getLinkModalDraft("po", orderRef);
  const poLines = poLinkLinesForRef(draft.ref);
  const salesLines = (poAllocationOptions?.salesLines || []).filter(
    (line) => poLinkCandidateLinesForSalesLine(line, draft.ref).length
  );
  const pendingLine = salesLines.find(
    (line) => String(line.targetLineKey) === String(draft.pendingSoLineKey || "")
  ) || null;
  const connections = salesLines.map((line) => {
    const poLineId = String(draft.poLineIds[line.targetLineKey] || "");
    const poLine = poLines.find((candidate) => String(candidate.id) === poLineId);
    const matchMeta = poLine ? poLinkMatchMeta(line, poLine.id, draft.ref) : null;
    return poLine && matchMeta ? { line, poLine, matchMeta } : null;
  }).filter(Boolean);
  const linkedCountByPo = connections.reduce((counts, connection) => {
    const key = String(connection.poLine.id);
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map());
  return { draft, poLines, salesLines, pendingLine, connections, linkedCountByPo };
}

function refreshPoLinkBoardInPlace(orderRef) {
  const board = app.querySelector(".po-match-board");
  if (!board) return false;
  const order = orderById(orderRef);
  const state = currentPoLinkBoardState(orderRef);
  const salesByKey = new Map(state.salesLines.map((line) => [String(line.targetLineKey), line]));

  for (const card of board.querySelectorAll("[data-po-map-so]")) {
    const targetLineKey = String(card.dataset.targetLineKey || "");
    const mappedPoId = String(state.draft.poLineIds[targetLineKey] || "");
    const mappedPoLine = state.poLines.find((line) => String(line.id) === mappedPoId);
    const selected = targetLineKey === String(state.draft.pendingSoLineKey || "");
    card.classList.toggle("mapped", Boolean(mappedPoLine));
    card.classList.toggle("selected", selected);
    card.setAttribute("aria-pressed", selected ? "true" : "false");
    const status = card.querySelector(".po-match-card-state");
    if (status) {
      status.classList.toggle("connected", Boolean(mappedPoLine));
      status.textContent = mappedPoLine
        ? `Connected to PO line ${mappedPoLine.lineId || mappedPoLine.id}`
        : "Drag or click to connect";
    }
  }

  for (const card of board.querySelectorAll("[data-po-map-po]")) {
    const poLineId = String(card.dataset.poLineId || "");
    const matchMeta = state.pendingLine ? poLinkMatchMeta(state.pendingLine, poLineId, state.draft.ref) : null;
    const linkedCount = state.linkedCountByPo.get(poLineId) || 0;
    const stateClass = !state.pendingLine ? "waiting" : (matchMeta ? (matchMeta.exactMatch ? "exact" : "compatible") : "incompatible");
    card.classList.remove("waiting", "exact", "compatible", "incompatible");
    card.classList.add(stateClass);
    card.classList.toggle("mapped", linkedCount > 0);
    card.setAttribute("aria-disabled", state.pendingLine && !matchMeta ? "true" : "false");
    const status = card.querySelector(".po-match-card-state");
    if (status) {
      const stateText = !state.pendingLine ? "Select SO first" : (matchMeta ? (matchMeta.exactMatch ? "Exact match" : "Manual match allowed") : "Different item");
      status.textContent = `${stateText}${linkedCount ? ` · ${linkedCount} connection(s)` : ""}`;
    }
  }

  const counts = board.querySelector("[data-po-match-counts]");
  if (counts) counts.textContent = `${state.connections.length} matched · ${state.salesLines.length - state.connections.length} remaining`;
  const connectorList = board.querySelector('[data-po-match-scroll="connections"]');
  if (connectorList) {
    connectorList.innerHTML = state.connections.map(({ line, poLine, matchMeta }) => `
      <div class="po-match-connector ${matchMeta.exactMatch ? "exact" : "manual"}">
        <span class="po-match-connector-line" aria-hidden="true">→</span>
        <div>
          <strong>${escapeHtml(line.sourceOrderRef || order?.id || orderRef)} #${escapeHtml(line.lineId || line.id || "--")}</strong>
          <span>to ${escapeHtml(poLine.poRef)} #${escapeHtml(poLine.lineId || poLine.id || "--")}</span>
          <em>${matchMeta.exactMatch ? "Exact description + unit" : `Manual match${!matchMeta.descriptionMatch ? " · description differs" : ""}${!matchMeta.unitMatch ? " · unit differs" : ""}`}</em>
        </div>
        <button data-action="remove-po-line-match" data-target-line-key="${escapeHtml(line.targetLineKey || "")}" type="button" aria-label="Remove this match">×</button>
      </div>
    `).join("") || `<div class="po-match-connector-empty">Select an SO line to begin.</div>`;
  }

  for (const row of app.querySelectorAll(".po-link-line[data-target-line-key]")) {
    const targetLineKey = String(row.dataset.targetLineKey || "");
    const line = salesByKey.get(targetLineKey);
    if (!line) continue;
    const poLineId = String(state.draft.poLineIds[targetLineKey] || "");
    const poLine = state.poLines.find((candidate) => String(candidate.id) === poLineId);
    const matchMeta = poLine ? poLinkMatchMeta(line, poLine.id, state.draft.ref) : null;
    const connected = Boolean(poLine && matchMeta);
    const quantities = state.draft.quantities[targetLineKey] || {};
    for (const input of row.querySelectorAll("[data-po-link-qty]")) {
      input.disabled = !connected;
      input.value = String(quantities[input.dataset.poLinkQty] ?? 0);
    }
    updateLinkSalesEquivalent(row);
    const matchLabel = row.querySelector(".po-link-qty-match");
    if (matchLabel) {
      matchLabel.classList.toggle("connected", connected);
      matchLabel.textContent = connected
        ? `${matchMeta.exactMatch ? "Exact" : "Manual"} match · ${poLine.poRef} line ${poLine.lineId || poLine.id}`
        : "Not connected — match this SO line above to enter quantity.";
    }
  }
  return true;
}

function setPoLineMatch(orderRef, targetLineKey, poLineId) {
  captureActiveLinkModalDraft();
  const draft = getLinkModalDraft("po", orderRef);
  const salesLine = (poAllocationOptions?.salesLines || []).find(
    (line) => String(line.targetLineKey) === String(targetLineKey)
  );
  const poLine = poLinkLinesForRef(draft.ref).find((line) => String(line.id) === String(poLineId));
  const matchMeta = salesLine ? poLinkMatchMeta(salesLine, poLineId, draft.ref) : null;
  if (!salesLine || !poLine || !matchMeta) return false;

  draft.poLineIds[targetLineKey] = String(poLineId);
  const saved = draft.quantities[targetLineKey] || {};
  if (!Object.values(saved).some((value) => Number(value || 0) > 0)) {
    draft.quantities[targetLineKey] = Object.fromEntries(
      availableUnitsForLine(salesLine).map(([field, , max]) => [field, Number(max || 0)])
    );
  }
  draft.pendingSoLineKey = "";
  if (!refreshPoLinkBoardInPlace(orderRef)) renderActiveLinkModalInPlace();
  return true;
}

function removePoLineMatch(orderRef, targetLineKey) {
  captureActiveLinkModalDraft();
  const draft = getLinkModalDraft("po", orderRef);
  draft.poLineIds[targetLineKey] = "";
  draft.quantities[targetLineKey] = {};
  if (draft.pendingSoLineKey === targetLineKey) draft.pendingSoLineKey = "";
  if (!refreshPoLinkBoardInPlace(orderRef)) renderActiveLinkModalInPlace();
}

function applyPoLinkDefaultsForRef(orderRef, poRef) {
  const options = poAllocationOptions || {};
  const draft = getLinkModalDraft("po", orderRef);
  const normalizedRef = String(poRef || "").trim().toLowerCase();
  const selectedPoLines = (options.poLines || []).filter((line) => String(line.poRef || "").trim().toLowerCase() === normalizedRef);
  if (!normalizedRef || !selectedPoLines.length) return false;
  draft.quantities = {};
  draft.poLineIds = {};
  draft.pendingSoLineKey = "";
  for (const line of options.salesLines || []) {
    const units = availableUnitsForLine(line);
    const candidateMeta = (line.poCandidates || []).filter((candidate) => String(candidate.poRef || "").trim().toLowerCase() === normalizedRef);
    const candidateIds = new Set(candidateMeta.map((candidate) => String(candidate.poLineId)));
    const candidates = selectedPoLines.filter((poLine) => candidateIds.has(String(poLine.id)));
    const exactIds = new Set(candidateMeta.filter((candidate) => candidate.exactMatch).map((candidate) => String(candidate.poLineId)));
    const exactCandidates = candidates.filter((poLine) => exactIds.has(String(poLine.id)));
    const selected = exactCandidates.length === 1 ? exactCandidates[0] : (!line.isSpecial && candidates.length === 1 ? candidates[0] : null);
    const matched = Boolean(selected);
    draft.poLineIds[line.targetLineKey] = selected ? String(selected.id) : "";
    const quantities = {};
    units.forEach(([field, , max]) => {
      quantities[field] = matched ? Number(max || 0) : 0;
    });
    draft.quantities[line.targetLineKey] = quantities;
    const row = app.querySelector(`.po-link-line[data-target-line-key="${CSS.escape(line.targetLineKey)}"]`);
    for (const input of row?.querySelectorAll("[data-po-link-qty]") || []) {
      input.value = String(quantities[input.dataset.poLinkQty] || 0);
    }
    updateLinkSalesEquivalent(row);
  }
  draft.defaultsAppliedRef = normalizedRef;
  return true;
}

function movementText(order) {
  if (order.type === "PO") {
    const destinations = [...new Set((order.dropoffs || []).map((dropoff) => dropoff.destinationYard).filter(Boolean))];
    const destinationText = destinations.length
      ? destinations.join(" + ")
      : order.destinationYard || order.pickupLocations?.[0] || "our yard";
    return `${order.sourceYard || "Vendor yard"} to ${destinationText}`;
  }
  if (order.type === "TO") return `${order.sourceYard || order.pickupLocations?.[0] || "source yard"} to ${order.destinationYard || "destination yard"}`;
  if (order.type === "CO") return `${order.sourceYard || order.pickupLocations?.[0] || "source yard"} to ${order.destinationYard || "transit depot"}`;
  if (order.type === "CUSTOM") return `${order.sourceYard || order.pickupLocations?.[0] || "pickup"} to ${order.destinationYard || order.address || "drop-off"}`;
  return order.address;
}

function isReviewOnlyOrder(order = {}) {
  const localStatus = String(order.localYardOrderStatus || "").toLowerCase();
  const operatorStatus = String(order.operatorStatus || "").toLowerCase();
  const fulfillmentStatus = String(order.fulfillmentStatus || order.raw?.fulfillment_status || "").toLowerCase();
  const statusText = String(order.netsuiteStatusText || order.raw?.status_text || "").toLowerCase();
  if (["loaded", "shipped", "received"].includes(localStatus)) return true;
  if (["loaded", "shipped", "received"].includes(operatorStatus)) return true;
  if (["fulfilled", "shipped", "received", "billed"].includes(fulfillmentStatus)) return true;
  return statusText.includes("pending billing")
    || statusText.includes("billed")
    || statusText.includes("fulfilled")
    || statusText.includes("received");
}

function reviewOnlyText(order = {}) {
  const localStatus = String(order.localYardOrderStatus || order.operatorStatus || "").trim();
  const statusText = String(order.netsuiteStatusText || order.raw?.status_text || "").replace(/^(Sales Order|Transfer Order|Purchase Order)\s*:\s*/i, "").trim();
  return localStatus || statusText || "Review only";
}

function orderTypeLabel(type) {
  return ({ SO: "Sales Order", PO: "Purchase Order", TO: "Transfer Order", CO: "Transit Depot Order", CUSTOM: "Custom Order" })[type] || "Order";
}

function splitBlockReason(order) {
  if (!["SO", "TO"].includes(order?.type)) return "";
  if (order.localYardOrderStatus === "Loaded") return `${order.id} is already loaded by yard operator and cannot be split.`;
  if (order.operatorStatus === "packed") return `${order.id} is already packed. Request yard operator to unpack before splitting.`;
  return "";
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizedPlaceKey(value) {
  return normalizeText(value).replace(/\s+/g, " ");
}

function normalizedStreetAddressKey(value) {
  const aliases = {
    avenue: "ave",
    boulevard: "blvd",
    circle: "cir",
    court: "ct",
    crescent: "cres",
    drive: "dr",
    highway: "hwy",
    lane: "ln",
    parkway: "pkwy",
    road: "rd",
    street: "st",
    trail: "trl"
  };
  const tokens = normalizedPlaceKey(value).split(" ").filter(Boolean);
  if (tokens.length < 3 || !/^\d+[a-z]?$/.test(tokens[0])) return "";
  const suffixIndex = tokens.findIndex((token, index) =>
    index >= 2 && Boolean(aliases[token] || Object.values(aliases).includes(token))
  );
  if (suffixIndex < 2) return "";
  return tokens.slice(0, suffixIndex + 1).map((token) => aliases[token] || token).join(" ");
}

function canadianPostalCode(value) {
  const compact = String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return compact.match(/[abceghj-nprstvxy]\d[abceghj-nprstvwxyz]\d[abceghj-nprstvwxyz]\d$/)?.[0] || "";
}

function addressMunicipalityKey(value) {
  const streetKey = normalizedStreetAddressKey(value);
  if (!streetKey) return "";
  const tokens = normalizedPlaceKey(value).split(" ").filter(Boolean);
  const streetTokens = streetKey.split(" ");
  const municipality = [];
  for (const token of tokens.slice(streetTokens.length)) {
    if (["on", "ontario", "canada"].includes(token) || /^[abceghj-nprstvxy]\d[abceghj-nprstvwxyz]$/i.test(token)) break;
    municipality.push(token);
  }
  const key = municipality.join(" ");
  return ["toronto", "scarborough", "north york", "etobicoke", "east york", "york"].includes(key)
    ? "toronto"
    : key;
}

function physicalAddressRegionCompatible(left, right) {
  const leftPostal = canadianPostalCode(left);
  const rightPostal = canadianPostalCode(right);
  if (leftPostal && rightPostal && leftPostal !== rightPostal) return false;
  const leftMunicipality = addressMunicipalityKey(left);
  const rightMunicipality = addressMunicipalityKey(right);
  return !leftMunicipality || !rightMunicipality || leftMunicipality === rightMunicipality;
}

function configuredOwnYardPlaces() {
  const places = [];
  const ownCodes = new Set();
  for (const yard of ownYards || []) {
    const code = String(yard.code || yard.name || "").trim();
    const address = String(yard.address || "").trim();
    if (!code || !address) continue;
    ownCodes.add(code);
    places.push({ key: `own:${code}`, address });
  }
  for (const [code, hub] of Object.entries(HUBS || {})) {
    if (code === "Vendor" || ownCodes.has(code) || !String(hub?.address || "").trim()) continue;
    places.push({ key: `own:${code}`, address: hub.address });
  }
  return places;
}

function samePhysicalAddress(left, right) {
  const leftPoint = left && typeof left === "object"
    ? { lat: Number(left.lat), lng: Number(left.lng) }
    : null;
  const rightPoint = right && typeof right === "object"
    ? { lat: Number(right.lat), lng: Number(right.lng) }
    : null;
  if (leftPoint || rightPoint) {
    return Boolean(
      leftPoint
      && rightPoint
      && Number.isFinite(leftPoint.lat)
      && Number.isFinite(leftPoint.lng)
      && Number.isFinite(rightPoint.lat)
      && Number.isFinite(rightPoint.lng)
      && Math.abs(leftPoint.lat - rightPoint.lat) < 0.000001
      && Math.abs(leftPoint.lng - rightPoint.lng) < 0.000001
    );
  }
  const leftKey = normalizedPlaceKey(left);
  const rightKey = normalizedPlaceKey(right);
  if (!leftKey || !rightKey) return false;
  if (leftKey === rightKey) return true;
  const leftStreet = normalizedStreetAddressKey(left);
  const rightStreet = normalizedStreetAddressKey(right);
  if (!leftStreet || leftStreet !== rightStreet || !physicalAddressRegionCompatible(left, right)) return false;
  const matchingPlaces = new Set(
    configuredOwnYardPlaces()
      .filter((place) => normalizedStreetAddressKey(place.address) === leftStreet)
      .map((place) => place.key)
  );
  return matchingPlaces.size === 1;
}

function ownYardForLocation(location = "") {
  const key = normalizedPlaceKey(location);
  if (!key) return null;
  if (HUBS[String(location)] && String(location) !== "Vendor") {
    const hub = HUBS[String(location)];
    return { code: String(location), name: hub.name || String(location), address: hub.address || String(location), lat: hub.lat, lng: hub.lng };
  }
  const exact = ownYards.find((yard) => {
    const code = normalizedPlaceKey(yard.code);
    const name = normalizedPlaceKey(yard.name);
    const address = normalizedPlaceKey(yard.address);
    return key === code || key === name || key === address;
  });
  if (exact) return exact;
  const streetKey = normalizedStreetAddressKey(location);
  if (!streetKey) return null;
  const streetMatches = ownYards.filter((yard) =>
    streetKey === normalizedStreetAddressKey(yard.address)
    && physicalAddressRegionCompatible(location, yard.address)
  );
  return streetMatches.length === 1 ? streetMatches[0] : null;
}

function vendorYardForLocation(location = "", order = null) {
  return vendorYardsForLocation(location, order)[0] || null;
}

function vendorYardsForLocation(location = "", order = null) {
  const key = normalizedPlaceKey(location);
  if (!key) return [];
  const rows = dispatchVendorYards.filter((row) => String(row.address || "").trim());
  const exact = rows.filter((row) =>
    normalizedPlaceKey(row.yard) === key
    || normalizedPlaceKey(row.address) === key
  );
  if (exact.length) return exact;
  const vendorFiltered = order
    ? rows.filter((row) => vendorMatchesOrder(row, order))
    : rows;
  const fuzzyVendorRows = vendorFiltered.filter((row) => {
    const yard = normalizedPlaceKey(row.yard);
    const vendor = normalizedPlaceKey(row.vendor);
    return yard && (key.includes(yard) || yard.includes(key) || (vendor && key.includes(vendor)));
  });
  if (fuzzyVendorRows.length) return fuzzyVendorRows;
  return rows.filter((row) => {
    const yard = normalizedPlaceKey(row.yard);
    return yard && (key.includes(yard) || yard.includes(key));
  });
}

function placeForLocation(location = "", order = null) {
  const ownYard = ownYardForLocation(location);
  if (ownYard) {
    return {
      kind: "own",
      key: ownYard.code || ownYard.name || location,
      label: ownYard.name || ownYard.code || location,
      address: ownYard.address || ownYard.code || location,
      lat: Number(ownYard.lat),
      lng: Number(ownYard.lng)
    };
  }
  const vendorYard = vendorYardForLocation(location, order);
  if (vendorYard) {
    return {
      kind: "vendor",
      key: vendorYard.yard || location,
      label: vendorYard.yard || vendorYard.vendor || location,
      address: vendorYard.address || location,
      lat: Number(vendorYard.lat),
      lng: Number(vendorYard.lng)
    };
  }
  return null;
}

function vendorMatchesOrder(row, order) {
  const vendor = normalizeText(row.vendor);
  const customer = normalizeText(order.customer);
  if (!vendor || !customer) return false;
  return vendor === customer || vendor.includes(customer) || customer.includes(vendor);
}

function vendorYardOptionsForOrder(order) {
  const related = dispatchVendorYards.filter((row) => row.active && vendorMatchesOrder(row, order));
  const rows = related.length ? related : [];
  const byYard = new Map();
  for (const row of rows) {
    const key = `${row.vendor}|${row.yard}`;
    if (!byYard.has(key)) byYard.set(key, row);
  }
  return [...byYard.values()];
}

function shortageQty(order) {
  if (order.type !== "SO") return 0;
  return Math.max(0, Number(order.salesQty || 0) - Number(order.committedQty || 0));
}

function consolidateYards(order) {
  const shortage = shortageQty(order);
  if (!shortage) return [];
  return Object.entries(order.shortageAvailability || {})
    .filter(([, available]) => Number(available || 0) >= shortage)
    .map(([yard, available]) => ({ yard, available: Number(available || 0) }));
}

function canConsolidatePick(order) {
  return consolidateYards(order).length > 0;
}

function orderById(id) {
  return orders.find((order) => order.id === id) || orderCatalog.find((order) => order.id === id);
}

function canonicalDispatchOrderType(value, id = "") {
  const text = String(value || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (["SO", "SALES_ORDER", "SALESORDER", "SALES_ORD"].includes(text)) return "SO";
  if (["PO", "PURCHASE_ORDER", "PURCHASEORDER", "PURCH_ORD"].includes(text)) return "PO";
  if (["TO", "TRANSFER_ORDER", "TRANSFERORDER", "TRNFR_ORD"].includes(text)) return "TO";
  if (["CO", "CO_ORDER", "LOCAL_CO", "LOCAL_CO_ORDER"].includes(text)) return "CO";
  if (["CUSTOM", "CUSTOM_ORDER", "LOCAL_CUSTOM", "LOCAL_CUSTOM_ORDER"].includes(text)) return "CUSTOM";
  const orderId = String(id || "").toUpperCase();
  if (orderId.startsWith("PO")) return "PO";
  if (orderId.startsWith("TO")) return "TO";
  if (orderId.startsWith("CO-")) return "CO";
  return "SO";
}

function flattenDispatchGroupMembers(order = {}) {
  const leafDetails = [];
  const leafIndexById = new Map();
  const groupAliases = new Set(
    (Array.isArray(order.groupAliases) ? order.groupAliases : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  );
  const visiting = new Set();

  const addLeaf = (id, detail = {}, fallbackType = order.type) => {
    const leafId = String(id || detail?.id || "").trim();
    if (!leafId) return;
    const normalizedDetail = {
      ...detail,
      id: leafId,
      type: canonicalDispatchOrderType(detail?.type || fallbackType, leafId),
      childOrders: [],
      childOrderDetails: []
    };
    if (leafIndexById.has(leafId)) {
      const index = leafIndexById.get(leafId);
      leafDetails[index] = { ...leafDetails[index], ...normalizedDetail };
      return;
    }
    leafIndexById.set(leafId, leafDetails.length);
    leafDetails.push(normalizedDetail);
  };

  const visit = (group, { root = false, fallbackType = order.type } = {}) => {
    const groupId = String(group?.id || "").trim();
    const childIds = (Array.isArray(group?.childOrders) ? group.childOrders : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    if (!childIds.length) {
      if (!root) addLeaf(groupId, group, fallbackType);
      return;
    }

    if (!root && groupId) groupAliases.add(groupId);
    for (const alias of Array.isArray(group?.groupAliases) ? group.groupAliases : []) {
      const normalizedAlias = String(alias || "").trim();
      if (normalizedAlias) groupAliases.add(normalizedAlias);
    }
    if (groupId && visiting.has(groupId)) return;
    if (groupId) visiting.add(groupId);

    const detailById = new Map(
      (Array.isArray(group?.childOrderDetails) ? group.childOrderDetails : [])
        .filter((detail) => detail?.id)
        .map((detail) => [String(detail.id), detail])
    );
    for (const childId of childIds) {
      const detail = detailById.get(childId) || { id: childId, type: fallbackType };
      if (Array.isArray(detail.childOrders) && detail.childOrders.length) {
        visit(detail, { fallbackType: detail.type || fallbackType });
      } else {
        addLeaf(childId, detail, fallbackType);
      }
    }

    if (groupId) visiting.delete(groupId);
  };

  visit(order, { root: true, fallbackType: order.type });
  return {
    childOrders: leafDetails.map((detail) => detail.id),
    childOrderDetails: leafDetails,
    groupAliases: [...groupAliases]
  };
}

function groupedOrderDependencies(groupItems = []) {
  const dependenciesByKey = new Map();
  const visited = new Set();
  const dependencyKey = (dependency = {}) => {
    const id = String(dependency.id ?? "").trim();
    if (id) return `id:${id}`;
    return [
      dependency.transferOrderRef,
      dependency.canonicalSalesOrderRef || dependency.salesOrderRef,
      dependency.dispatchTargetRef,
      dependency.mode
    ].map((value) => String(value || "").trim().toLowerCase()).join("|");
  };
  const visit = (order = {}) => {
    if (!order || typeof order !== "object" || visited.has(order)) return;
    visited.add(order);
    for (const child of Array.isArray(order.childOrderDetails) ? order.childOrderDetails : []) visit(child);
    for (const dependency of Array.isArray(order.orderDependencies) ? order.orderDependencies : []) {
      if (!dependency || dependency.status === "cancelled") continue;
      const key = dependencyKey(dependency);
      if (!key.replace(/\|/g, "")) continue;
      const previous = dependenciesByKey.get(key) || {};
      const merged = { ...previous, ...dependency };
      if ((!Array.isArray(dependency.lines) || !dependency.lines.length) && Array.isArray(previous.lines)) {
        merged.lines = previous.lines;
      }
      dependenciesByKey.set(key, merged);
    }
  };
  for (const item of groupItems || []) visit(item);
  return [...dependenciesByKey.values()].sort((left, right) =>
    String(left.transferOrderRef || "").localeCompare(String(right.transferOrderRef || ""))
    || String(left.canonicalSalesOrderRef || left.salesOrderRef || "").localeCompare(
      String(right.canonicalSalesOrderRef || right.salesOrderRef || "")
    )
    || String(left.id ?? "").localeCompare(String(right.id ?? ""), undefined, { numeric: true })
  );
}

function groupedOrderDependencyLabels(groupItems = [], dependencies = groupedOrderDependencies(groupItems)) {
  const labels = [];
  const seen = new Set();
  const add = (value) => {
    const label = String(value || "").trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key)) return;
    seen.add(key);
    labels.push(label);
  };
  const visited = new Set();
  const visit = (order = {}) => {
    if (!order || typeof order !== "object" || visited.has(order)) return;
    visited.add(order);
    for (const child of Array.isArray(order.childOrderDetails) ? order.childOrderDetails : []) visit(child);
    for (const label of Array.isArray(order.dependencyLabels) ? order.dependencyLabels : []) add(label);
  };
  for (const item of groupItems || []) visit(item);
  for (const dependency of dependencies) {
    if (dependency.transferOrderRef) add(`Requires ${dependency.transferOrderRef}`);
  }
  if (dependencies.some((dependency) => dependency.mode === "direct_to_customer")) add("Direct pickup");
  if (dependencies.some((dependency) =>
    dependency.mode === "yard_replenishment"
    && !["delivered", "received_local"].includes(String(dependency.status || "").toLowerCase())
  )) add("Waiting for transfer");
  if (dependencies.some((dependency) => dependency.reconciliationStatus === "required")) {
    add("NetSuite reconciliation required");
  }
  return labels;
}

function splitParentOrderId(order = {}) {
  if (
    String(order.type || "").trim().toUpperCase() === "CUSTOM"
    || order.customOrder
    || order.sourceTable === "dispatch_custom_orders"
  ) return "";
  const explicitParent = String(order.originalOrderId || "").trim();
  if (explicitParent) return explicitParent;
  const orderId = String(order.id || "").trim();
  return /-S\d+$/i.test(orderId) ? orderId.replace(/-S\d+$/i, "") : "";
}

function normalizePoDropoffs(order = {}, type = "", items = []) {
  if (type !== "PO") return [];
  const source = Array.isArray(order.dropoffs) && order.dropoffs.length
    ? order.dropoffs
    : (order.destinationYard || order.destinationLocationId || order.address)
      ? [{
          destinationLocationId: order.destinationLocationId || null,
          destinationYard: order.destinationYard || "",
          address: order.destinationAddress || order.address || "",
          lineRowIds: items.map((item) => item.lineRowId).filter((value) => value !== undefined && value !== null),
          pallets: order.pallets,
          layers: order.layers,
          salesQty: order.salesQty,
          weight: order.weight
        }]
      : [];
  return source.map((dropoff, index) => {
    const destinationYard = String(dropoff.destinationYard || order.destinationYard || "").trim();
    const destinationLocationId = dropoff.destinationLocationId ?? order.destinationLocationId ?? null;
    const key = String(dropoff.key || (destinationLocationId ? `location:${destinationLocationId}` : `yard:${destinationYard.toLowerCase()}`) || `drop:${index}`);
    return {
      ...dropoff,
      key,
      destinationLocationId,
      destinationYard,
      address: dropoff.address || HUBS[destinationYard]?.address || order.destinationAddress || order.address || destinationYard,
      lineRowIds: (dropoff.lineRowIds || []).map(String),
      pallets: Number(dropoff.pallets || 0),
      layers: Number(dropoff.layers || 0),
      sections: Number(dropoff.sections || 0),
      pieces: Number(dropoff.pieces || 0),
      salesQty: Number(dropoff.salesQty || 0),
      weight: Number(dropoff.weight || 0)
    };
  });
}

function normalizeOrder(order) {
  const id = String(order.id || "");
  const type = canonicalDispatchOrderType(order.type, id);
  const items = Array.isArray(order.items) ? order.items : [];
  const groupMembers = Array.isArray(order.childOrders) && order.childOrders.length
    ? flattenDispatchGroupMembers({ ...order, type })
    : {
        childOrders: Array.isArray(order.childOrders) ? order.childOrders : [],
        childOrderDetails: Array.isArray(order.childOrderDetails) ? order.childOrderDetails : [],
        groupAliases: Array.isArray(order.groupAliases) ? order.groupAliases : []
      };
  const groupedDependencySources = groupMembers.childOrders.length
    ? [
        ...groupMembers.childOrderDetails,
        {
          orderDependencies: order.orderDependencies,
          dependencyLabels: order.dependencyLabels
        }
      ]
    : [];
  const orderDependencies = groupedDependencySources.length
    ? groupedOrderDependencies(groupedDependencySources)
    : order.orderDependencies;
  const dependencyLabels = groupedDependencySources.length
    ? groupedOrderDependencyLabels(groupedDependencySources, orderDependencies)
    : order.dependencyLabels;
  const dependencyChildren = groupedDependencySources.length ? groupMembers.childOrderDetails : [];
  const basePickupLocations = Array.isArray(order.pickupLocations) && order.pickupLocations.length
    ? order.pickupLocations
    : order.sourceYard
      ? [order.sourceYard]
      : type === "SO"
        ? ["3445"]
        : [];
  const pickupLocations = order.transitCo?.toYard ? [order.transitCo.toYard] : basePickupLocations;
  const dropoffs = normalizePoDropoffs(order, type, items);
  return {
    ...order,
    type,
    originalOrderId: type === "CUSTOM"
      ? ""
      : splitParentOrderId({ ...order, id, type }) || order.originalOrderId || "",
    committedQty: Number(order.committedQty ?? order.salesQty ?? 0),
    customer: order.customer || order.vendorYard || order.sourceYard || "",
    address: order.address || "",
    expectedDeliveryDate: order.expectedDeliveryDate || order.expected_delivery_date || "",
    notes: order.notes || order.instructions || "",
    windowStart: order.windowStart || "",
    windowEnd: order.windowEnd || "",
    items,
    pallets: Number(order.pallets || 0),
    layers: Number(order.layers || 0),
    salesQty: Number(order.salesQty || 0),
    weight: Number(order.weight || 0),
    pickupLocations,
    dropoffs,
    childOrders: groupMembers.childOrders,
    childOrderDetails: groupMembers.childOrderDetails,
    groupAliases: groupMembers.groupAliases,
    orderDependencies,
    dependencyLabels,
    dependencyDirectPickup: Boolean(order.dependencyDirectPickup
      || dependencyChildren.some((child) => child.dependencyDirectPickup)
      || orderDependencies?.some((dependency) => dependency.mode === "direct_to_customer")),
    dependencyWaitingForTransfer: Boolean(order.dependencyWaitingForTransfer
      || dependencyChildren.some((child) => child.dependencyWaitingForTransfer)
      || orderDependencies?.some((dependency) =>
        dependency.mode === "yard_replenishment"
        && !["delivered", "received_local"].includes(String(dependency.status || "").toLowerCase())
      )),
    dependencyAttention: Boolean(order.dependencyAttention
      || dependencyChildren.some((child) => child.dependencyAttention)
      || orderDependencies?.some((dependency) => dependency.status === "attention")),
    dependencyUncovered: Boolean(order.dependencyUncovered
      || dependencyChildren.some((child) => child.dependencyUncovered)),
    dependencyUncoveredQuantity: dependencyChildren.length
      ? dependencyChildren.reduce((sum, child) => sum + Number(child.dependencyUncoveredQuantity || 0), 0)
      : Number(order.dependencyUncoveredQuantity || 0),
    groupKey: order.groupKey || id,
    unloadMinutes: Number(order.unloadMinutes || 35),
    travelMinutes: Number(order.travelMinutes || 30)
  };
}

function hasUsableDispatchAddress(order) {
  if (order?.type !== "SO") return true;
  const address = String(order.address || "").trim();
  if (!address) return false;
  return !/^(3445\s+kennedy|2967\s+kennedy|12441\s+woodbine)\b/i.test(address);
}

function relatedTransitCo(order) {
  return order?.transitCo?.id ? orderById(order.transitCo.id) : null;
}

function isTransitCoPlanned(order) {
  if (!order?.transitCo?.id) return true;
  const coOrder = relatedTransitCo(order);
  return allAssignedOrderIds().has(order.transitCo.id) || Boolean(coOrder?.dispatchPlanned);
}

function transitBlockMessage(order) {
  if (!order?.transitCo?.id || isTransitCoPlanned(order)) return "";
  return `${order.id} requires ${order.transitCo.id} to be planned first.`;
}

function replenishmentDependencyComplete(dependency = {}, transferOrder = {}) {
  const dependencyStatus = String(dependency.status || "").toLowerCase();
  const receivingStatus = String(transferOrder.receivingStatus || transferOrder.raw?.receiving_status || "").toLowerCase();
  return ["delivered", "received_local"].includes(dependencyStatus)
    || ["received", "completed", "shipped"].includes(receivingStatus);
}

function replenishmentDependencyTargetRefs(dependency = {}, transferOrder = {}) {
  return new Set([
    dependency.dispatchTargetRef,
    dependency.salesOrderRef,
    dependency.canonicalSalesOrderRef,
    transferOrder.dependentSalesOrderRef
  ].map((value) => String(value || "").trim()).filter(Boolean));
}

function dispatchOrderMatchesRefs(order, refs = new Set()) {
  if (!order || !refs.size) return false;
  const orderRefs = dispatchGroupingRefs(order);
  return [...refs].some((ref) => orderRefs.has(ref));
}

function replenishmentDependentPlacement(transferOrder, targetLoad) {
  const dependency = transferOrder?.orderDependency;
  if (
    !targetLoad
    || dependency?.mode !== "yard_replenishment"
    || dependency?.status === "cancelled"
    || replenishmentDependencyComplete(dependency, transferOrder)
  ) return null;
  const targetRefs = replenishmentDependencyTargetRefs(dependency, transferOrder);
  if (!targetRefs.size) return null;
  const dependentDropIndex = (targetLoad.stops || []).findIndex((stop) =>
    stop.type === "drop" && dispatchOrderMatchesRefs(stopOrder(stop), targetRefs)
  );
  if (dependentDropIndex < 0) return null;
  const dependentOrder = stopOrder(targetLoad.stops[dependentDropIndex]);
  const pickupLocations = new Set(
    requiredPickupLocations(dependentOrder).map(normalizedPickupLocation).filter(Boolean)
  );
  const dependentPickupIndex = (targetLoad.stops || []).findIndex((stop, index) =>
    index < dependentDropIndex
    && stop.type === "pick"
    && pickupLocations.has(normalizedPickupLocation(stop.location))
  );
  return {
    dependency,
    dependentOrder,
    dependentDropIndex,
    dependentPickupIndex,
    pickupBoundaryIndex: dependentPickupIndex >= 0 ? dependentPickupIndex : dependentDropIndex
  };
}

function normalizeReplenishmentTransferInsertIndex(order, targetLoad, insertIndex = null) {
  const placement = replenishmentDependentPlacement(order, targetLoad);
  if (!placement) return insertIndex;
  const requestedIndex = Number.isInteger(insertIndex) ? insertIndex : (targetLoad.stops || []).length;
  return Math.min(requestedIndex, placement.pickupBoundaryIndex);
}

function replenishmentTransferCompletionInLoad(dependency = {}, targetLoad = null) {
  if (!targetLoad) return null;
  const transferRef = String(dependency.transferOrderRef || "").trim();
  if (!transferRef) return null;
  const transferRefs = new Set([transferRef]);
  let completion = null;
  for (const [index, stop] of (targetLoad.stops || []).entries()) {
    if (stop.type !== "drop") continue;
    const transferOrder = stopOrder(stop);
    if (
      String(stop.orderId || "") !== transferRef
      && !dispatchOrderMatchesRefs(transferOrder, transferRefs)
    ) continue;
    completion = { index, stop, transferOrder };
  }
  return completion;
}

function normalizeReplenishmentDependentInsertIndex(order, targetLoad, insertIndex = null) {
  if (!targetLoad) return insertIndex;
  let completionBoundary = -1;
  for (const dependency of order?.orderDependencies || []) {
    if (dependency.mode !== "yard_replenishment" || dependency.status === "cancelled") continue;
    const completion = replenishmentTransferCompletionInLoad(dependency, targetLoad);
    if (!completion || replenishmentDependencyComplete(dependency, completion.transferOrder)) continue;
    completionBoundary = Math.max(completionBoundary, completion.index + 1);
  }
  if (completionBoundary < 0) return insertIndex;
  const requestedIndex = Number.isInteger(insertIndex) ? insertIndex : (targetLoad.stops || []).length;
  return Math.max(requestedIndex, completionBoundary);
}

function replenishmentSequenceWarningsForStops(stops = []) {
  const load = { stops };
  const warnings = [];
  const seen = new Set();
  for (const [transferDropIndex, stop] of stops.entries()) {
    if (stop.type !== "drop") continue;
    const transferOrder = stopOrder(stop);
    const placement = replenishmentDependentPlacement(transferOrder, load);
    if (!placement || transferDropIndex < placement.pickupBoundaryIndex) continue;
    const transferRef = String(placement.dependency.transferOrderRef || transferOrder?.id || stop.orderId || "");
    const salesRef = String(placement.dependency.dispatchTargetRef
      || placement.dependency.salesOrderRef
      || transferOrder?.dependentSalesOrderRef
      || placement.dependentOrder?.id
      || "");
    const warning = `${transferRef} must finish before ${salesRef} pickup.`;
    if (!seen.has(warning)) {
      seen.add(warning);
      warnings.push(warning);
    }
  }
  return warnings;
}

function replenishmentPlacementBlockMessage(order, targetTruck, targetLoad, insertIndex = null) {
  const dependencies = (order?.orderDependencies || []).filter((dependency) =>
    dependency.mode === "yard_replenishment" && dependency.status !== "cancelled"
  );
  for (const dependency of dependencies) {
    if (String(dependency.status || "").toLowerCase() === "attention") {
      return `${order.id}: ${dependency.attentionReason || `${dependency.transferOrderRef} requires attention`}.`;
    }
    const transferOrder = orderById(dependency.transferOrderRef);
    if (replenishmentDependencyComplete(dependency, transferOrder)) continue;
    const assignment = orderAssignment(dependency.transferOrderRef);
    if (!assignment.load) {
      const transferDate = String(transferOrder?.dispatchPlanDate || "").slice(0, 10);
      if (transferOrder?.dispatchPlanned && transferDate && comparePlanDate(transferDate, currentPlanDate) < 0) continue;
      return `${order.id} requires ${dependency.transferOrderRef} to be planned before this delivery.`;
    }
    if (String(assignment.load.id || "") === String(targetLoad?.id || "")) {
      const transferDropIndex = replenishmentTransferCompletionInLoad(dependency, assignment.load)?.index ?? -1;
      const targetIndex = Number.isInteger(insertIndex) ? insertIndex : (targetLoad?.stops || []).length;
      if (transferDropIndex < 0 || transferDropIndex >= targetIndex) {
        return `${dependency.transferOrderRef} must be completed before ${order.id} pickup in this load.`;
      }
      continue;
    }
    if (String(assignment.truck?.id || "") === String(targetTruck?.id || "")) {
      const transferLoadIndex = (targetTruck?.loads || []).findIndex((load) => load.id === assignment.load.id);
      const targetLoadIndex = (targetTruck?.loads || []).findIndex((load) => load.id === targetLoad?.id);
      if (transferLoadIndex >= targetLoadIndex) {
        return `${dependency.transferOrderRef} must be in an earlier load than ${order.id}.`;
      }
    }
  }
  return "";
}

function comparePlanDate(a, b) {
  const left = String(a || "").slice(0, 10);
  const right = String(b || "").slice(0, 10);
  if (!left || !right || left === right) return 0;
  return left < right ? -1 : 1;
}

function orderDropAssignment(orderId) {
  const target = String(orderId || "");
  for (const truck of trucks) {
    for (const load of truck.loads || []) {
      if ((load.stops || []).some((stop) => stop.type === "drop" && String(stop.orderId || "") === target)) {
        return { truck, load };
      }
    }
  }
  return {};
}

function orderLoadFinishMinutes(orderId) {
  const { truck, load } = orderDropAssignment(orderId);
  if (!truck || !load) return null;
  return loadStats(truck, load).finish;
}

function orderPickupArrivalMinutes(orderId) {
  const { truck, load } = orderDropAssignment(orderId);
  if (!truck || !load) return null;
  const stats = loadStats(truck, load);
  const pickup = (stats.rows || []).find((row) => row.stop?.type === "pick" && String(row.stop?.orderId || "") === String(orderId || ""));
  return Number.isFinite(Number(pickup?.arrival)) ? Number(pickup.arrival) : stats.start;
}

function coTimingViolation(order) {
  if (!order?.transitCo?.id) return "";
  const coId = order.transitCo.id;
  const coOrder = relatedTransitCo(order);
  const coInCurrentPlan = isOrderAssignedInCurrentPlan(coId);
  const coPlannedDate = coInCurrentPlan ? currentPlanDate : String(coOrder?.dispatchPlanDate || "").slice(0, 10);
  if (!coPlannedDate) return `${order.id} requires ${coId} to be planned first.`;
  const dateCompare = comparePlanDate(coPlannedDate, currentPlanDate);
  if (dateCompare < 0) return "";
  if (dateCompare > 0) return `${coId} is planned on ${coPlannedDate}, after ${order.id} on ${currentPlanDate}. Plan the CO before this order.`;
  const coFinish = orderLoadFinishMinutes(coId);
  const sourcePickup = orderPickupArrivalMinutes(order.id);
  if (!Number.isFinite(Number(coFinish)) || !Number.isFinite(Number(sourcePickup))) {
    return "";
  }
  if (Number(coFinish) > Number(sourcePickup)) {
    return `${coId} must finish before ${order.id} pickup. CO finishes ${timeText(coFinish)}, target pickup starts ${timeText(sourcePickup)}.`;
  }
  return "";
}

function modalTimeValue(value) {
  return String(value || "").replace(":", "").trim();
}

function isValidDispatchTime(value) {
  const text = String(value || "").trim();
  return !text || /^([01]\d|2[0-3])[0-5]\d$/.test(text);
}

function timeValidationMessage(start, end) {
  if (!isValidDispatchTime(start) || !isValidDispatchTime(end)) {
    return "Time window must use 24-hour format, for example 0700 or 1900.";
  }
  if (start && end && Number(start) >= Number(end)) {
    return "End time must be later than start time.";
  }
  return "";
}

function planWeekdayName(planDate = currentPlanDate) {
  const text = String(planDate || "").slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T12:00:00`) : new Date();
  return date.toLocaleDateString("en-US", { weekday: "long" });
}

function dayLabelMatchesPlan(dayLabel = "", planDate = currentPlanDate) {
  const label = normalizeText(dayLabel);
  if (!label) return false;
  const weekday = planWeekdayName(planDate);
  const day = normalizeText(weekday);
  if (label === day) return true;
  const weekdayIndex = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(day);
  if (label.includes("mon fri") || label.includes("monday friday")) return weekdayIndex >= 1 && weekdayIndex <= 5;
  if (label.includes("mon thu") || label.includes("monday thursday")) return weekdayIndex >= 1 && weekdayIndex <= 4;
  if (label.includes("sat sun") || label.includes("weekend")) return weekdayIndex === 0 || weekdayIndex === 6;
  return false;
}

function dayLabelIsExactPlanDay(dayLabel = "", planDate = currentPlanDate) {
  return normalizeText(dayLabel) === normalizeText(planWeekdayName(planDate));
}

function vendorWindowForLocation(location = "", order = null) {
  const rows = vendorYardsForLocation(location, order);
  if (!rows.length) return { start: "", end: "", label: "" };
  const matchingDay = rows.find((row) => dayLabelIsExactPlanDay(row.dayLabel))
    || rows.find((row) => dayLabelMatchesPlan(row.dayLabel));
  const fallbackActive = rows.find((row) => row.active !== false && row.windowStart && row.windowEnd);
  const row = matchingDay || fallbackActive || rows[0];
  if (matchingDay && matchingDay.active === false) {
    return { start: "", end: "", label: matchingDay.dayLabel || planWeekdayName(), closed: true };
  }
  return {
    start: row?.active === false ? "" : (row?.windowStart || ""),
    end: row?.active === false ? "" : (row?.windowEnd || ""),
    label: row?.dayLabel || ""
  };
}

function setEditFormStatus(form, message = "", tone = "info") {
  const status = form?.querySelector("[data-edit-status]");
  if (!status) return;
  status.textContent = message;
  status.className = `modal-status ${tone}`;
}

function setModalFormStatus(form, message = "", tone = "info") {
  const status = form?.querySelector("[data-modal-status]");
  if (!status) return;
  status.textContent = message;
  status.className = `modal-status ${tone}`;
}

async function loadDispatchConfig() {
  try {
    const response = await fetch("/api/dispatch/config");
    if (!response.ok) return;
    dispatchConfig = await response.json();
  } catch {
    dispatchConfig = { googleMapsApiKey: "" };
  }
}

async function loadDispatchVendorYards() {
  try {
    const response = await fetch("/api/dispatch/vendor-yards");
    if (!response.ok) return;
    dispatchVendorYards = await response.json();
  } catch {
    dispatchVendorYards = [];
  }
}

async function loadDispatchSetup() {
  try {
    const response = await fetch("/api/dispatch/setup");
    if (!response.ok) return;
    const setup = await response.json();
    dispatchSetupLoaded = true;
    if (Array.isArray(setup.drivers)) drivers = setup.drivers;
    ensureDriverLaneOrder();
    if (Array.isArray(setup.ownYards)) applyOwnYards(setup.ownYards);
    if (setup.planning) dispatchPlanningSettings = { ...dispatchPlanningSettings, ...setup.planning };
    if (Array.isArray(setup.trucks)) {
      fleet = setup.trucks;
      trucks = fleet.map((vehicle, index) => makeTruckFromFleet(vehicle, index));
    }
  } catch {
    // Keep built-in setup if the server setup file is unavailable.
  }
}

function applyDispatchOrderFeed(feed) {
  const nextOrders = Array.isArray(feed) ? feed.map(normalizeOrder).filter((order) => order.id) : [];
  orderCatalog = nextOrders;
  const byId = new Map(orders.map((order) => [order.id, order]));
  const localOrders = orders.filter((order) => shouldPreserveDuringFeedRefresh(order));
  const nextIds = new Set(orderCatalog.map((order) => order.id));
  orders = [
    ...orderCatalog.map((order) => normalizeOrder({ ...(byId.get(order.id) || {}), ...order })),
    ...localOrders.filter((order) => !nextIds.has(order.id)).map(normalizeOrder)
  ];
  reconcileTransitCoSourceOrders();
  selectedOrderId = orders.find((order) => order.id === selectedOrderId)?.id || orders[0]?.id || "";
  selectedOrderIds = new Set([...selectedOrderIds].filter((id) => orders.some((order) => order.id === id)));
  if (!selectedOrderIds.size && selectedOrderId) selectedOrderIds.add(selectedOrderId);
}

function mergeDispatchOrderSearchFeed(feed) {
  const candidates = Array.isArray(feed) ? feed.map(normalizeOrder).filter((order) => order.id) : [];
  if (!candidates.length) return;
  const catalogById = new Map(orderCatalog.map((order) => [order.id, order]));
  const ordersById = new Map(orders.map((order) => [order.id, order]));
  for (const candidate of candidates) {
    const existing = ordersById.get(candidate.id);
    const merged = normalizeOrder(existing ? { ...candidate, ...existing } : candidate);
    ordersById.set(candidate.id, merged);
    catalogById.set(candidate.id, normalizeOrder(catalogById.has(candidate.id)
      ? { ...candidate, ...catalogById.get(candidate.id) }
      : candidate));
  }
  orders = [...ordersById.values()];
  orderCatalog = [...catalogById.values()];
  reconcileTransitCoSourceOrders();
}

function cancelDispatchOrderSearch() {
  if (orderSearchTimer) clearTimeout(orderSearchTimer);
  orderSearchTimer = null;
  orderSearchSequence += 1;
  orderSearchLoading = false;
  orderSearchError = "";
}

async function loadDispatchOrderSearch(term, sequence) {
  try {
    const params = new URLSearchParams({ search: term });
    const response = await fetch("/api/dispatch/orders?" + params.toString());
    if (!response.ok) throw new Error(await response.text());
    const feed = await response.json();
    if (sequence !== orderSearchSequence || term !== searchText.trim()) return;
    mergeDispatchOrderSearchFeed(feed);
    orderSearchError = "";
  } catch (error) {
    if (sequence !== orderSearchSequence) return;
    orderSearchError = error.message || "Search failed.";
  } finally {
    if (sequence !== orderSearchSequence) return;
    orderSearchLoading = false;
    refreshOrderPoolForSearch();
  }
}

function scheduleDispatchOrderSearch() {
  if (orderSearchTimer) clearTimeout(orderSearchTimer);
  orderSearchTimer = null;
  const term = searchText.trim();
  const sequence = ++orderSearchSequence;
  orderSearchError = "";
  orderSearchLoading = term.length >= 2;
  if (term.length < 2) return;
  orderSearchTimer = setTimeout(() => {
    orderSearchTimer = null;
    loadDispatchOrderSearch(term, sequence);
  }, 300);
}

function applyPlannedAssignments(assignments = []) {
  plannedAssignmentRefs = new Set((assignments || []).map((assignment) => String(assignment.orderRef || "")).filter(Boolean));
  const byOrderRef = new Map((assignments || []).map((assignment) => [String(assignment.orderRef || ""), assignment]));
  const plannedDerivedSnapshots = (assignments || [])
    .map((assignment) => assignment?.plannedOrderSnapshot)
    .filter((order) => order?.id && (order?.childOrders?.length || order?.originalOrderId));
  const applyToOrder = (order) => {
    const assignment = byOrderRef.get(String(order.id || ""));
    return normalizeOrder({
      ...order,
      dispatchPlanned: Boolean(assignment),
      dispatchPlanId: assignment?.dispatchPlanId || "",
      dispatchPlanDate: assignment?.dispatchPlanDate || "",
      dispatchTruckPlate: assignment?.dispatchTruckPlate || "",
      dispatchLoadName: assignment?.dispatchLoadName || "",
      dispatchParkingSpot: assignment?.dispatchParkingSpot || "",
      plannedOrderRef: assignment?.plannedOrderRef || "",
      childOrderDetails: (order.childOrderDetails || []).map(applyToOrder)
    });
  };
  const addPlannedDerivedSnapshots = (list = []) => {
    const byId = new Map((list || []).map((order) => [String(order?.id || ""), order]));
    for (const snapshot of plannedDerivedSnapshots) {
      if (byId.has(String(snapshot.id || ""))) continue;
      const assignment = byOrderRef.get(String(snapshot.id || ""));
      byId.set(String(snapshot.id), normalizeOrder({
        ...snapshot,
        dispatchPlanned: true,
        dispatchPlanId: assignment?.dispatchPlanId || snapshot.dispatchPlanId || "",
        dispatchPlanDate: assignment?.dispatchPlanDate || snapshot.dispatchPlanDate || "",
        dispatchTruckPlate: assignment?.dispatchTruckPlate || snapshot.dispatchTruckPlate || "",
        dispatchLoadName: assignment?.dispatchLoadName || snapshot.dispatchLoadName || "",
        dispatchParkingSpot: assignment?.dispatchParkingSpot || snapshot.dispatchParkingSpot || "",
        plannedOrderRef: assignment?.plannedOrderRef || snapshot.id
      }));
    }
    return [...byId.values()];
  };
  orders = orders.map(applyToOrder);
  orderCatalog = orderCatalog.map(applyToOrder);
  orders = addPlannedDerivedSnapshots(orders);
  orderCatalog = addPlannedDerivedSnapshots(orderCatalog);
}

async function refreshPlannedAssignments() {
  const response = await fetch("/api/dispatch/planned-assignments");
  if (!response.ok) throw new Error(await response.text());
  applyPlannedAssignments(await response.json());
}

async function loadDispatchOrders({ sync = false } = {}) {
  try {
    const response = await fetch(sync ? "/api/dispatch/sync" : "/api/dispatch/orders", { method: sync ? "POST" : "GET" });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    applyDispatchOrderFeed(sync ? payload.orders : payload);
    routeNotice = sync ? "Orders refreshed from local DB." : routeNotice;
    return true;
  } catch (error) {
    routeNotice = sync ? `Order refresh failed: ${error.message}` : routeNotice;
    applyDispatchOrderFeed(orderCatalog);
    return false;
  }
}

function linkModalDraftKey(type, orderRef) {
  return `${type}:${String(orderRef || "").trim()}`;
}

function getLinkModalDraft(type, orderRef) {
  const key = linkModalDraftKey(type, orderRef);
  if (!linkModalDrafts.has(key)) {
    linkModalDrafts.set(key, {
      ref: "",
      mode: "direct_to_customer",
      poLineIds: {},
      quantities: {},
      targetSignature: "",
      structureWarning: "",
      defaultsAppliedRef: "",
      pendingSoLineKey: ""
    });
  }
  return linkModalDrafts.get(key);
}

function clearLinkModalDraft(type, orderRef) {
  linkModalDrafts.delete(linkModalDraftKey(type, orderRef));
}

function captureActiveLinkModalDraft() {
  if (!modalOrderId || !["po-link", "to-link"].includes(modalType)) return;
  const type = modalType === "to-link" ? "to" : "po";
  const draft = getLinkModalDraft(type, modalOrderId);
  const refInput = document.getElementById(type === "to" ? "toLinkRef" : "poLinkRef");
  if (refInput) draft.ref = refInput.value;
  if (type === "to") {
    const mode = document.getElementById("toLinkMode");
    if (mode) draft.mode = mode.value || "direct_to_customer";
    for (const input of app.querySelectorAll("[data-to-link-qty][data-target-line-key]")) {
      const quantities = typeof draft.quantities[input.dataset.targetLineKey] === "object"
        ? draft.quantities[input.dataset.targetLineKey]
        : {};
      quantities[input.dataset.toLinkQty] = input.value;
      draft.quantities[input.dataset.targetLineKey] = quantities;
    }
  } else {
    for (const row of app.querySelectorAll(".po-link-line[data-target-line-key]")) {
      const quantities = draft.quantities[row.dataset.targetLineKey] || {};
      for (const input of row.querySelectorAll("[data-po-link-qty]")) {
        quantities[input.dataset.poLinkQty] = input.value;
      }
      const poLineSelect = row.querySelector("[data-po-line-id]");
      if (poLineSelect) {
        draft.poLineIds[row.dataset.targetLineKey] = poLineSelect.value;
      }
      draft.quantities[row.dataset.targetLineKey] = quantities;
    }
  }
}

function renderActiveLinkModalInPlace() {
  const current = app.querySelector('.modal-backdrop[data-link-modal="true"]');
  const order = orderById(modalOrderId);
  if (!current || !order) return render({ save: false });
  const uiState = captureRenderUiState();
  current.outerHTML = modalType === "to-link" ? renderToLinkModal(order) : renderPoLinkModal(order);
  restoreRenderUiState(uiState);
}

async function loadPoAllocationOptions(orderId) {
  const sequence = ++poAllocationRequestSequence;
  poAllocationAbortController?.abort();
  poAllocationAbortController = new AbortController();
  poAllocationLoading = true;
  poAllocationError = "";
  poAllocationOptions = null;
  renderActiveLinkModalInPlace();
  try {
    const params = new URLSearchParams({ planDate: currentPlanDate });
    const response = await fetch(`/api/dispatch/orders/${encodeURIComponent(orderId)}/po-allocations?${params}`, {
      signal: poAllocationAbortController.signal
    });
    if (!response.ok) throw new Error(await dispatchErrorMessage(response));
    if (sequence !== poAllocationRequestSequence || modalType !== "po-link" || modalOrderId !== orderId) return;
    poAllocationOptions = await response.json();
    const draft = getLinkModalDraft("po", orderId);
    const nextSignature = poAllocationOptions?.order?.targetSignature || "";
    if (draft.targetSignature && nextSignature && draft.targetSignature !== nextSignature) {
      draft.structureWarning = `${orderId} changed while this window was open. Review the refreshed quantities.`;
    } else {
      draft.structureWarning = "";
    }
    draft.targetSignature = nextSignature;
  } catch (error) {
    if (error.name !== "AbortError" && sequence === poAllocationRequestSequence) {
      poAllocationError = error.message || "Unable to load Link PO options.";
    }
  } finally {
    if (sequence === poAllocationRequestSequence) {
      poAllocationLoading = false;
      renderActiveLinkModalInPlace();
    }
  }
}

async function loadDriverJobStatuses() {
  try {
    const url = new URL("/api/dispatch/driver-job-statuses", window.location.origin);
    if (currentPlan?.id) url.searchParams.set("planId", currentPlan.id);
    else if (currentPlanDate) url.searchParams.set("planDate", currentPlanDate);
    const response = await fetch(url.pathname + url.search);
    if (!response.ok) throw new Error(await response.text());
    driverJobStatuses = await response.json();
    if (currentPlan?.id) {
      const attentionResponse = await fetch(`/api/dispatch/driver-truck-switches/attention?planId=${encodeURIComponent(currentPlan.id)}`);
      driverTruckSwitchAttention = attentionResponse.ok ? await attentionResponse.json() : [];
    } else {
      driverTruckSwitchAttention = [];
    }
  } catch {
    driverJobStatuses = [];
    driverTruckSwitchAttention = [];
  }
}

function driverStatusByJobId() {
  return new Map((driverJobStatuses || []).map((record) => [record.job_id || record.jobId, record]));
}

function driverRecordForStop(truck, load, stop) {
  return driverStatusByJobId().get(driverJobIdForStop(truck, load, stop)) || null;
}

function executionStatusFromRecord(record) {
  if (record?.status === "complete") return "complete";
  if (record?.status === "in_progress") return "in_progress";
  return "pending";
}

function stopExecutionStatus(truck, load, stop) {
  return executionStatusFromRecord(driverRecordForStop(truck, load, stop));
}

function driverRecordForTravel(truck, load, startTravel) {
  const jobStart = startTravel?.fromJobLocation || startTravel?.from || "";
  const jobTarget = startTravel?.toPickupLocation || startTravel?.to || "";
  return driverStatusByJobId().get(driverTravelJobIdForLoad(truck, load, startTravel))
    || (driverJobStatuses || []).find((item) =>
      String(item.load_id || item.loadId || "") === String(load?.id || "")
      && String(item.stop_type || item.stopType || "") === "travel"
      && String(item.stop_id || item.stopId || "") === `travel-${jobStart}-${jobTarget}`
    )
    || null;
}

function driverRecordForSwitchApproach(truck, load, handoffTravel) {
  return driverStatusByJobId().get(driverSwitchApproachJobIdForLoad(truck, load, handoffTravel)) || null;
}

function travelExecutionStatus(truck, load, startTravel) {
  const record = driverRecordForTravel(truck, load, startTravel);
  return executionStatusFromRecord(record);
}

function driverRecordForReturn(truck, load) {
  return driverStatusByJobId().get(driverReturnJobIdForLoad(truck, load)) || null;
}

function returnExecutionStatus(truck, load) {
  return executionStatusFromRecord(driverRecordForReturn(truck, load));
}

function recordStartedAt(record) {
  return record?.started_at || record?.startedAt || "";
}

function recordCompletedAt(record) {
  return record?.completed_at || record?.completedAt || "";
}

function actualTimeText(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function actualMinuteOfDay(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return (date.getHours() * 60) + date.getMinutes();
}

function varianceMinutes(actualValue, plannedMinutes) {
  const actual = actualMinuteOfDay(actualValue);
  if (actual === null) return null;
  let diff = actual - (((Math.round(Number(plannedMinutes || 0)) % 1440) + 1440) % 1440);
  if (diff > 720) diff -= 1440;
  if (diff < -720) diff += 1440;
  return diff;
}

function varianceText(diff) {
  if (diff === null || diff === undefined) return "--";
  if (Math.abs(diff) < 1) return "0";
  const value = Math.round(diff);
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  const hours = Math.floor(absolute / 60);
  const minutesPart = absolute % 60;
  if (!hours) return `${sign}${minutesPart}m`;
  return `${sign}${hours}h${String(minutesPart).padStart(2, "0")}m`;
}

function varianceValueHtml(label, diff) {
  const number = diff === null || diff === undefined ? null : Number(diff);
  const status = number === null || !Number.isFinite(number) || number === 0 ? "neutral" : number > 0 ? "late" : "early";
  return `<span class="variance-value ${status}">${label} ${varianceText(diff)}</span>`;
}

function varianceClass(diff) {
  if (diff === null || diff === undefined) return "";
  if (Math.abs(diff) <= 10) return "ok";
  if (Math.abs(diff) <= 30) return "minor";
  return "major";
}

function plannedTimeHtml({ startLabel = "Arr", endLabel = "Lv", plannedStart = 0, plannedEnd = 0 } = {}) {
  const labelText = (label) => {
    const text = String(label || "");
    if (text.toLowerCase() === "arr") return "Arrive";
    if (text.toLowerCase() === "lv") return "Leave";
    return text;
  };
  return `<span>${labelText(startLabel)} ${timeText(plannedStart)}</span><span>${labelText(endLabel)} ${timeText(plannedEnd)}</span>`;
}

function timingSummaryHtml({ startLabel = "Arr", endLabel = "LV", plannedStart = 0, plannedEnd = 0, actualStart = "", actualEnd = "", showActual = false } = {}) {
  if (!showActual) return plannedTimeHtml({ startLabel, endLabel, plannedStart, plannedEnd });
  const startDiff = varianceMinutes(actualStart, plannedStart);
  const endDiff = varianceMinutes(actualEnd, plannedEnd);
  return `
    <div class="time-compare ${varianceClass(endDiff || startDiff)}">
      <span class="time-label">Plan</span><span>${startLabel} ${timeText(plannedStart)} / ${endLabel} ${timeText(plannedEnd)}</span>
      <span class="time-label">Real</span><span>${startLabel} ${actualTimeText(actualStart)} / ${endLabel} ${actualTimeText(actualEnd)}</span>
      <span class="time-label">Var</span><span class="variance-row">${varianceValueHtml(startLabel, startDiff)} / ${varianceValueHtml(endLabel, endDiff)}</span>
    </div>
  `;
}

function timingDetailHtml({ title = "Timing", startLabel = "Arrive", endLabel = "Leave", plannedStart = 0, plannedEnd = 0, actualStart = "", actualEnd = "" } = {}) {
  const startDiff = varianceMinutes(actualStart, plannedStart);
  const endDiff = varianceMinutes(actualEnd, plannedEnd);
  return `
    <div class="timing-detail">
      <b>${escapeHtml(title)}</b>
      <span>Planned ${startLabel}: ${timeText(plannedStart)} | Actual: ${actualTimeText(actualStart)} | ${varianceText(startDiff)}</span>
      <span>Planned ${endLabel}: ${timeText(plannedEnd)} | Actual: ${actualTimeText(actualEnd)} | ${varianceText(endDiff)}</span>
    </div>
  `;
}

function loadDriverActivityRecords(load) {
  const loadId = String(load?.id || "");
  if (!loadId) return [];
  return (driverJobStatuses || []).filter((record) => {
    const status = executionStatusFromRecord(record);
    return String(record.load_id || record.loadId || "") === loadId && (status === "in_progress" || status === "complete");
  });
}

function loadHasDriverActivity(load) {
  return loadDriverActivityRecords(load).length > 0;
}

function loadActivityLockNotice(load) {
  return `${load?.name || "This load"} already has driver activity. Its driver, truck, stops, and orders are locked.`;
}

function stopDriverActivityRecords(foundOrLoad, stopValue = null) {
  const load = stopValue ? foundOrLoad : foundOrLoad?.load;
  const stop = stopValue || foundOrLoad?.stop;
  const loadId = String(load?.id || "");
  const stopId = String(stop?.id || "");
  const orderId = String(stop?.orderId || "");
  const currentStopIds = new Set((load?.stops || []).map((item) => String(item.id || "")));
  if (!loadId || (!stopId && !orderId)) return [];
  return (driverJobStatuses || []).filter((record) => {
    const status = executionStatusFromRecord(record);
    const recordStopId = String(record.stop_id || record.stopId || "");
    if (status !== "in_progress" && status !== "complete") return false;
    if (String(record.load_id || record.loadId || "") !== loadId) return false;
    if (stopId && recordStopId === stopId) return true;
    return orderId && currentStopIds.has(recordStopId) && (record.order_refs || record.orderRefs || []).map(String).includes(orderId);
  });
}

function stopHasDriverActivity(foundOrLoad, stopValue = null) {
  return stopDriverActivityRecords(foundOrLoad, stopValue).length > 0;
}

function orderHasDriverActivityInLoad(load, orderId) {
  const id = String(orderId || "");
  if (!load || !id) return false;
  return (load.stops || []).some((stop) => String(stop.orderId || "") === id && stopHasDriverActivity(load, stop));
}

function stopActivityLockNotice(stop) {
  return `${stop?.orderId || "This stop"} has already started in this load. It can be reordered, but cannot be removed from the load.`;
}

function driverStatusesForOrder(orderId) {
  const id = String(orderId || "");
  const currentStopIds = new Set(trucks.flatMap((truck) => (truck.loads || []).flatMap((load) => (load.stops || []).map((stop) => String(stop.id || "")))));
  return (driverJobStatuses || [])
    .filter((record) => currentStopIds.has(String(record.stop_id || record.stopId || "")) && (record.order_refs || record.orderRefs || []).map(String).includes(id))
    .map(executionStatusFromRecord);
}

function orderExecutionStatus(orderId) {
  const stopStatuses = [];
  for (const truck of trucks) {
    for (const load of truck.loads || []) {
      for (const stop of load.stops || []) {
        if (stop.orderId !== orderId) continue;
        stopStatuses.push(stopExecutionStatus(truck, load, stop));
      }
    }
  }
  stopStatuses.push(...driverStatusesForOrder(orderId));
  if (!stopStatuses.length) return "pending";
  if (stopStatuses.every((status) => status === "complete")) return "complete";
  if (stopStatuses.some((status) => status === "complete" || status === "in_progress")) return "in_progress";
  return "pending";
}

function loadGoogleMaps() {
  if (!dispatchConfig.googleMapsApiKey) return Promise.resolve(false);
  if (window.google?.maps) return Promise.resolve(true);
  if (googleMapsPromise) return googleMapsPromise;
  googleMapsPromise = new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(dispatchConfig.googleMapsApiKey)}`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
  return googleMapsPromise;
}

function planPayload(savedAt = new Date()) {
  normalizePlanBeforeSave();
  const assignedIds = assignedOrderIdsForTrucks(trucks);
  const hiddenOrderIds = new Set([
    ...groupedChildOrderIds(),
    ...splitParentOrderIds()
  ]);
  const payloadPlanId = currentPlan?.id || null;
  const payloadPlanDate = currentPlan?.planDate || currentPlanDate;
  return {
    planId: payloadPlanId,
    planDate: payloadPlanDate,
    editLeaseToken: planEditLeaseToken,
    baseRevision: nextPlanSaveMode === "truck_sequence" ? null : (currentPlan?.revision ?? 0),
    saveMode: nextPlanSaveMode || "",
    savedAt: savedAt.toISOString(),
    refreshOrderPool: Boolean(nextSaveNeedsOrderPoolRefresh),
    summary: planSummary(),
    orders: orders
      .filter((order) => !hiddenOrderIds.has(order.id))
      .map((order) => ({
        ...order,
        localDispatchStatus: assignedIds.has(order.id) ? "planned" : "open"
      })),
    trucks: trucksWithTimingMetadata()
  };
}

function trucksWithTimingMetadata() {
  normalizeLoadAssignments();
  return trucks.map((truck) => ({
    ...truck,
    loads: (truck.loads || []).map((load) => {
      const { routeEstimate, routeEstimateId, fromPersistentCache, ...savedLoad } = load;
      const stats = loadStats(truck, load);
      const assignment = assignLoadFields(truck, savedLoad);
      const startMode = resolvedLoadStartMode(load);
      const effectiveTruck = effectiveTruckForLoad(truck, assignment);
      const rowsByStopId = new Map((stats.rows || []).map((row) => [String(row.stop?.id || ""), row]));
      return {
        ...assignment,
        startMode,
        start: startMode === "auto"
          ? ""
          : (normalizeTypedDispatchTime(assignment.start) || timeText(stats.scheduledStart)),
        ownYardFixedMinutes: Number(effectiveTruck.ownYardFixedMinutes || 40),
        vendorFixedMinutes: Number(effectiveTruck.vendorFixedMinutes || 35),
        deliveryFixedMinutes: Number(effectiveTruck.deliveryFixedMinutes || 35),
        minutesPerPallet: Number(effectiveTruck.minutesPerPallet || 1),
        truckSwitchMinutes: Math.max(0, Math.round(Number(dispatchPlanningSettings.truckSwitchMinutes ?? 10))),
        handoffTravelMinutes: Number(stats.handoffMinutes || 0),
        handoffTravelFrom: stats.handoffTravel?.from || "",
        handoffTravelTo: stats.handoffTravel?.to || "",
        plannedStartMinute: stats.start,
        plannedFinishMinute: stats.finish,
        timing: {
          start: stats.start,
          finish: stats.finish,
          scheduledStart: stats.scheduledStart,
          previousFinish: stats.previousFinish,
          restBefore: stats.restBefore,
          handoffTravel: stats.handoffTravel ? {
            from: stats.handoffTravel.from,
            to: stats.handoffTravel.to,
            minutes: stats.handoffMinutes,
            start: stats.handoffStart,
            finish: stats.handoffFinish
          } : null,
          switchStart: stats.switchStart,
          startClamped: stats.startClamped
        },
        stops: (load.stops || []).map((stop) => {
          const row = rowsByStopId.get(String(stop.id || ""));
          return {
            ...stop,
            timing: row
              ? { arrival: row.arrival, depart: row.depart }
              : { arrival: stats.start, depart: stats.start }
          };
        })
      };
    })
  }));
}

function normalizePlanBeforeSave() {
  expandScmGroupedPoStops();
  collapseGroupedOrderStops();
  cleanupOrphanPickupStops();
  syncPickupStops();
  syncReturnLoads();
}

function compactStringFingerprint(value = "") {
  const text = String(value || "");
  let first = 2166136261;
  let second = 2246822507;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 3266489909);
  }
  return `${text.length.toString(36)}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`;
}

function stablePlanHashPayload(payload = {}) {
  return compactStringFingerprint(JSON.stringify({
    planId: payload.planId || null,
    planDate: payload.planDate || currentPlanDate,
    orders: payload.orders || [],
    trucks: payload.trucks || [],
    driverLaneOrder: payload.summary?.driverLaneOrder || []
  }));
}

function savedPlanHash(saved = {}) {
  return stablePlanHashPayload({
    planId: saved.id || saved.planId || currentPlan?.id || null,
    planDate: saved.planDate || currentPlanDate,
    orders: saved.orders || [],
    trucks: saved.trucks || [],
    summary: saved.summary || {}
  });
}

function payloadRequiresSave(payload = {}, nextHash = stablePlanHashPayload(payload), forceSave = false) {
  const requiresFollowup = payload.refreshOrderPool || payload.saveMode || pendingOperatorAlertRefs.size;
  return forceSave || requiresFollowup || nextHash !== lastSavedPlanHash;
}

function requestOrderPoolRefreshOnNextSave() {
  nextSaveNeedsOrderPoolRefresh = true;
}

function requestTruckSequenceSaveOnNextSave() {
  nextPlanSaveMode = "truck_sequence";
}

function planSummary() {
  assignmentAdvisoryByLoad = buildLocalAssignmentAdvisories();
  const stats = boardStats();
  return {
    ...stats,
    planDate: currentPlanDate,
    status: currentPlan?.status || "draft",
    ownYardCodes: [...new Set((ownYards || [])
      .map((yard) => String(yard?.code || yard?.name || yard?.id || "").trim())
      .filter(Boolean))],
    driverLaneOrder: [...ensureDriverLaneOrder()]
  };
}

function summarizeOrder(order) {
  if (!order) return null;
  return {
    id: order.id,
    type: order.type,
    customer: order.customer,
    address: order.address,
    sourceAddress: order.sourceAddress,
    pickupAddressOverride: order.pickupAddressOverride,
    expectedDeliveryDate: order.expectedDeliveryDate,
    windowStart: order.windowStart,
    windowEnd: order.windowEnd,
    pallets: order.pallets,
    layers: order.layers,
    salesQty: order.salesQty,
    weight: order.weight,
    pickupLocations: order.pickupLocations,
    sourceTable: order.sourceTable
  };
}

function summarizeStop(stop) {
  if (!stop) return null;
  return {
    id: stop.id,
    loadId: stop.loadId,
    orderId: stop.orderId,
    type: stop.type,
    location: stop.location
  };
}

function summarizeLoad(load) {
  if (!load) return null;
  return {
    id: load.id,
    name: load.name,
    returnOnly: Boolean(load.returnOnly),
    manual: Boolean(load.manual),
    allowTolls: Boolean(load.allowTolls),
    returnYard: load.returnYard,
    start: load.start,
    startMode: resolvedLoadStartMode(load),
    driverLogin: load.driverLogin || "",
    driverName: load.driverName || "",
    truckId: load.truckId || "",
    truckPlate: load.truckPlate || "",
    switchYard: load.switchYard || "",
    parkingSpot: load.parkingSpot || "",
    plannedStartMinute: load.plannedStartMinute ?? null,
    plannedFinishMinute: load.plannedFinishMinute ?? null,
    driverSequence: load.driverSequence ?? 0,
    stops: (load.stops || []).map(summarizeStop)
  };
}

function summarizeTruck(truck) {
  if (!truck) return null;
  const driver = truckDriver(truck);
  return {
    id: truck.id,
    plate: truck.plate,
    driverLogin: truck.driverLogin || "",
    driver: driver?.name || "Unassigned",
    license: driver?.license || "",
    base: truck.base,
    parkingSpot: truck.parkingSpot,
    capacityLbs: truck.capacityLbs,
    loadCount: truck.loads?.length || 0
  };
}

function logDispatchAudit(entry = {}) {
  const payload = {
    ...entry,
    sessionId: dispatchSessionId,
    source: "dispatch",
    details: {
      ...(entry.details || {}),
      url: location.pathname
    }
  };
  fetch("/api/dispatch/audit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

function isLocalDispatchOrder(order) {
  const id = String(order?.id || "");
  return order?.type === "CO"
    || order?.type === "CUSTOM"
    || order?.sourceTable === "dispatch_custom_orders"
    || id.startsWith("CO-")
    || id.startsWith("GRP-")
    || /^G[A-Z]+-/i.test(id)
    || id.startsWith("TO-DRAFT-")
    || Boolean(splitParentOrderId(order));
}

function isNetSuiteDispatchOrder(order) {
  return ["SO", "PO", "TO"].includes(order?.type) && !isLocalDispatchOrder(order);
}

function supportsTransitCoForOrder(order) {
  if (!order) return false;
  if (["SO", "TO"].includes(order.type)) return true;
  return (order.childOrderDetails || []).some((child) => ["SO", "TO"].includes(canonicalDispatchOrderType(child?.type, child?.id)));
}

function transitSourceOrderType(order) {
  if (["SO", "TO"].includes(order?.type)) return order.type;
  const child = (order?.childOrderDetails || []).find((item) => ["SO", "TO"].includes(canonicalDispatchOrderType(item?.type, item?.id)));
  return child ? canonicalDispatchOrderType(child.type, child.id) : "";
}

function transitCoSourceRef(coOrder) {
  const id = String(coOrder?.id || "");
  return coOrder?.sourceOrderId
    || coOrder?.relatedSoId
    || coOrder?.relatedToId
    || coOrder?.transitCo?.sourceOrderId
    || (id.startsWith("CO-") ? id.slice(3) : "");
}

function applyTransitPickupToOrder(order, { coId, fromYard, toYard, createdAt } = {}) {
  if (!order || !fromYard || !toYard) return order;
  const originalPickupLocations = order.transitOriginalPickupLocations?.length
    ? order.transitOriginalPickupLocations
    : (order.pickupLocations || []).filter((location) => String(location) !== String(toYard));
  order.transitOriginalPickupLocations = originalPickupLocations.length ? originalPickupLocations : [fromYard];
  if (order.transitOriginalSourceYard === undefined) order.transitOriginalSourceYard = order.sourceYard || fromYard;
  order.transitCo = {
    ...(order.transitCo || {}),
    id: coId || order.transitCo?.id || `CO-${order.id}`,
    fromYard,
    toYard,
    sourceOrderId: order.id,
    createdAt: createdAt || order.transitCo?.createdAt || new Date().toISOString()
  };
  order.pickupLocations = [toYard];
  order.sourceYard = toYard;
  order.childOrderDetails = (order.childOrderDetails || []).map((child) => {
    const next = normalizeOrder({ ...child });
    applyTransitPickupToOrder(next, {
      coId: order.transitCo.id,
      fromYard,
      toYard,
      createdAt: order.transitCo.createdAt
    });
    return next;
  });
  return order;
}

function reconcileTransitCoSourceOrders() {
  for (const coOrder of orders.filter((order) => order.type === "CO")) {
    const sourceRef = transitCoSourceRef(coOrder);
    const sourceOrder = orderById(sourceRef);
    if (!sourceOrder) continue;
    const fromYard = coOrder.sourceYard || coOrder.pickupLocations?.[0] || coOrder.transitCo?.fromYard || sourceOrder.pickupLocations?.[0] || "";
    const toYard = coOrder.destinationYard || coOrder.transitCo?.toYard || sourceOrder.transitCo?.toYard || "";
    if (!fromYard || !toYard) continue;
    applyTransitPickupToOrder(sourceOrder, {
      coId: coOrder.id,
      fromYard,
      toYard,
      createdAt: sourceOrder.transitCo?.createdAt || coOrder.createdAt
    });
    coOrder.sourceOrderId = sourceOrder.id;
    coOrder.sourceOrderType = transitSourceOrderType(sourceOrder) || coOrder.sourceOrderType || "";
  }
}

function shouldPreserveDuringFeedRefresh(order) {
  if (order?.type === "CUSTOM" || order?.sourceTable === "dispatch_custom_orders") return false;
  if (isLocalDispatchOrder(order)) return true;
  return isNetSuiteDispatchOrder(order)
    && order?.netsuiteFeedMissing
    && order?.localDispatchStatus !== "planned";
}

function assignedOrderIdsForTrucks(truckList = trucks) {
  const ids = new Set();
  for (const truck of truckList || []) {
    for (const load of truck.loads || []) {
      for (const stop of load.stops || []) {
        if (stop.orderId) ids.add(stop.orderId);
      }
    }
  }
  return ids;
}

function groupedChildOrderIds(orderList = orders) {
  const ids = new Set();
  for (const order of orderList || []) {
    for (const childId of [...(order.childOrders || []), ...(order.groupAliases || [])]) {
      if (childId) ids.add(childId);
    }
  }
  return ids;
}

function splitParentOrderIds(orderList = orders) {
  return new Set((orderList || [])
    .map(splitParentOrderId)
    .filter(Boolean));
}

function splitSiblingsForOrder(order = {}) {
  const originalOrderId = splitParentOrderId(order);
  if (!originalOrderId) return [];
  return orders.filter((item) => splitParentOrderId(item) === originalOrderId);
}

function splitOrderPlanningBlock(splits = []) {
  const planned = (splits || []).filter((split) =>
    isOrderAssignedInCurrentPlan(split.id)
    || isOrderPlannedOutsideCurrentPlan(split)
    || split.localDispatchStatus === "planned"
    || Boolean(split.dispatchPlanned)
  );
  if (!planned.length) return "";
  return `Unsplit blocked. Unplan these split orders first: ${planned.map((split) => split.id).join(", ")}.`;
}

function applySavedPlan(saved) {
  if (!Array.isArray(saved?.orders) || !Array.isArray(saved?.trucks)) return false;
  clearActiveRouteEstimates();
  const defaultById = new Map(orderCatalog.map((order) => [order.id, normalizeOrder(order)]));
  const savedAssignedIds = assignedOrderIdsForTrucks(saved.trucks);
  const allowSavedOnlyOrder = (order) => {
    if (order?.type === "CUSTOM" || order?.sourceTable === "dispatch_custom_orders") {
      return savedAssignedIds.has(order.id);
    }
    if (isLocalDispatchOrder(order)) return true;
    if (!isNetSuiteDispatchOrder(order)) return false;
    const localStatus = order.localDispatchStatus || (savedAssignedIds.has(order.id) ? "planned" : "open");
    return localStatus !== "planned" || savedAssignedIds.has(order.id);
  };
  const savedById = new Map(saved.orders.filter((order) => defaultById.has(order.id) || allowSavedOnlyOrder(order)).map((order) => {
    const base = defaultById.get(order.id) || {};
    const keepPlanningFields = {
      assigned: order.assigned,
      localDispatchStatus: savedAssignedIds.has(order.id) ? "planned" : (order.localDispatchStatus || "open"),
      netsuiteFeedMissing: !base.id && isNetSuiteDispatchOrder(order),
      childOrders: order.childOrders,
      childOrderDetails: order.childOrderDetails,
      consolidation: order.consolidation,
      originalOrderId: order.type === "CUSTOM"
        ? ""
        : splitParentOrderId(order) || order.originalOrderId,
      originalPallets: order.originalPallets,
      transitCo: order.transitCo,
      transitOriginalPickupLocations: order.transitOriginalPickupLocations
    };
    if (splitParentOrderId(order) && Array.isArray(order.items) && order.items.length && !base.items?.length) {
      keepPlanningFields.items = order.items;
      keepPlanningFields.raw = order.raw;
    }
    const merged = {
      ...order,
      ...base,
      ...Object.fromEntries(Object.entries(keepPlanningFields).filter(([, value]) => value !== undefined)),
      shortageAvailability: base.shortageAvailability || order.shortageAvailability,
      committedQty: base.shortageAvailability ? base.committedQty : order.committedQty
    };
    return [order.id, normalizeOrder(merged)];
  }));
  const hiddenOrderIds = new Set([
    ...groupedChildOrderIds([...savedById.values()]),
    ...splitParentOrderIds([...savedById.values()])
  ]);
  for (const order of orderCatalog) {
    if (hiddenOrderIds.has(order.id)) continue;
    if (!savedById.has(order.id)) savedById.set(order.id, normalizeOrder(order));
  }
  orders = [...savedById.values()].filter((order) => !hiddenOrderIds.has(order.id));
  trucks = trucksFromFleetAndSavedPlan(saved.trucks);
  normalizeLoadAssignments();
  ensureDriverLaneOrder(Array.isArray(saved.summary?.driverLaneOrder) ? saved.summary.driverLaneOrder : defaultDriverLaneOrder());
  reconcileTransitCoSourceOrders();
  expandScmGroupedPoStops();
  collapseGroupedOrderStops();
  syncPickupStops();
  cleanupOrphanPickupStops();
  selectedOrderId = orders.find((order) => order.id === selectedOrderId)?.id || orders[0]?.id || "";
  selectedLoadId = trucks.flatMap((truck) => truck.loads).find((load) => load.id === selectedLoadId)?.id || trucks[0]?.loads[0]?.id || "";
  selectedOrderIds = new Set(selectedOrderId ? [selectedOrderId] : []);
  lastSavedAt = saved.savedAt ? new Date(saved.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  lastServerSavedAt = saved.savedAt || lastServerSavedAt;
  lastSavedPlanHash = savedPlanHash(saved);
  return true;
}

function compactCurrentPlan(plan) {
  if (!plan?.id) return plan || null;
  const { orders: _orders, trucks: _trucks, ...metadata } = plan;
  return metadata;
}

async function savePlanToServer(payload, { retryOnStale = true, forceSave = false, payloadHash = "", saveGeneration = localPlanGeneration } = {}) {
  try {
    let targetPlanId = payload.planId || null;
    let targetPlanDate = payload.planDate || currentPlanDate;
    if (!targetPlanId) {
      const created = await createPlanForDate(targetPlanDate);
      targetPlanId = created.id;
      targetPlanDate = created.planDate || targetPlanDate;
      payload = {
        ...payload,
        planId: targetPlanId,
        planDate: targetPlanDate,
        baseRevision: created.revision ?? payload.baseRevision ?? 0
      };
      payloadHash = "";
    }
    payloadHash ||= stablePlanHashPayload(payload);
    const operatorAlertRefs = [...pendingOperatorAlertRefs];
    const refreshOrderPool = Boolean(payload.refreshOrderPool);
    const saveMode = payload.saveMode || "";
    autosaveDebug("savePlanToServer:start", {
      baseRevision: payload.baseRevision,
      payloadHash: shortHash(payloadHash),
      retryOnStale,
      saveMode,
      refreshOrderPool
    });
    const response = await fetch(`/api/dispatch/plans/${encodeURIComponent(targetPlanId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        forceSave,
        baseRevision: forceSave ? null : payload.baseRevision,
        summary: planSummary(),
        audit: {
          sessionId: dispatchSessionId,
          action: forceSave ? "dispatch_plan_force_saved" : saveMode === "truck_sequence" ? "dispatch_plan_truck_sequence_saved" : "dispatch_plan_autosaved",
          details: { planDate: targetPlanDate, status: currentPlan?.status, operatorAlertRefs, refreshOrderPool, saveMode, forceSave }
        }
      })
    });
    autosaveDebug("savePlanToServer:response", {
      status: response.status,
      baseRevision: payload.baseRevision,
      payloadHash: shortHash(payloadHash)
    });
    if (response.status === 409) {
      const conflict = await response.json().catch(() => ({}));
      autosaveDebug("savePlanToServer:conflict", {
        code: conflict.code || "",
        expectedRevision: conflict.expectedRevision,
        currentRevision: conflict.currentRevision,
        retryOnStale,
        willRetry: conflict.code === "STALE_DISPATCH_PLAN" && retryOnStale && localPlanDirty
      });
      reportDispatchSaveError("conflict", new Error(conflict.error || conflict.message || `Plan save conflict (${response.status})`), {
        status: response.status,
        code: conflict.code || "",
        expectedRevision: conflict.expectedRevision,
        currentRevision: conflict.currentRevision,
        retryOnStale
      });
      if (conflict.code === "DISPATCH_ORDER_ALREADY_PLANNED") {
        if (conflict.currentRevision !== undefined && currentPlan) {
          currentPlan = {
            ...currentPlan,
            revision: Number(conflict.currentRevision || 0)
          };
        }
        const details = (conflict.conflicts || [])
          .slice(0, 4)
          .map((item) => `${item.orderRef} on ${displayDate(item.planDate)}`)
          .join(", ");
        localPlanDirty = true;
        routeNotice = `Cannot save: order already planned on another date${details ? ` (${details})` : "."}`;
        render({ save: false });
        return { blocked: true, code: conflict.code };
      }
      if (conflict.code === "DISPATCH_CO_SEQUENCE_INVALID") {
        localPlanDirty = true;
        routeNotice = conflict.error || "CO must be planned before the original order pickup.";
        render({ save: false });
        return { blocked: true, code: conflict.code };
      }
      if (conflict.code && conflict.code !== "STALE_DISPATCH_PLAN") {
        localPlanDirty = true;
        routeNotice = conflict.error || conflict.conflicts?.[0]?.message || "Driver or truck assignment is invalid.";
        render({ save: false });
        return { blocked: true, code: conflict.code, error: routeNotice, businessConflict: true };
      }
      if (conflict.currentRevision !== undefined && currentPlan) {
        currentPlan = {
          ...currentPlan,
          revision: Number(conflict.currentRevision || 0)
        };
      }
      if (conflict.code === "STALE_DISPATCH_PLAN" && retryOnStale && localPlanDirty) {
        saveQueued = true;
        return { staleRetryQueued: true, code: conflict.code };
      }
      if (confirmInFlight) {
        return { blocked: true, code: conflict.code || "STALE_DISPATCH_PLAN", ignoredDuringConfirm: true };
      }
      localPlanDirty = true;
      blockedRemotePlanUpdate = true;
      routeNotice = "Plan changed on another screen. Your current changes are still visible but were not saved. Review before continuing.";
      render({ save: false });
      return { blocked: true, code: conflict.code || "STALE_DISPATCH_PLAN", error: routeNotice };
    }
    if (!response.ok) {
      const responseText = await response.text();
      const error = new Error(responseText || response.statusText || `HTTP ${response.status}`);
      reportDispatchSaveError("server-response", error, { status: response.status, responseText });
      routeNotice = `Plan save failed: ${error.message}`;
      render({ save: false });
      return { failed: true, error };
    }
    const result = await response.json();
    const saveTargetsCurrentView = String(currentPlan?.id || "") === String(targetPlanId)
      && String(currentPlanDate || "").slice(0, 10) === String(targetPlanDate || "").slice(0, 10);
    const resultRevision = Number(result.revision || 0);
    const guardedRevision = String(minimumPlanRevisionToApply.planId || "") === String(targetPlanId)
      ? Number(minimumPlanRevisionToApply.revision || 0)
      : 0;
    if (saveTargetsCurrentView && resultRevision < guardedRevision) {
      autosaveDebug("savePlanToServer:ignoredOlderResult", {
        resultRevision,
        minimumPlanRevisionToApply: guardedRevision
      });
      return { saved: true, ignoredOlderResult: true };
    }
    if (saveTargetsCurrentView) currentPlan = compactCurrentPlan(result);
    lastServerSavedAt = result.savedAt || payload.savedAt;
    lastSavedPlanHash = payloadHash;
    const savedLatestLocal = saveGeneration === localPlanGeneration;
    autosaveDebug("savePlanToServer:success", {
      returnedRevision: result.revision,
      payloadHash: shortHash(payloadHash),
      saveGeneration,
      localPlanGeneration,
      savedLatestLocal,
      noChange: Boolean(result.noChange),
      refreshOrderPool,
      saveMode
    });
    if (result.noChange) {
      if (savedLatestLocal) {
        if (refreshOrderPool) nextSaveNeedsOrderPoolRefresh = false;
        if (saveMode === "truck_sequence") nextPlanSaveMode = "";
        clearLocalPlanDirty(payload.savedAt, saveGeneration);
      } else {
        saveQueued = true;
      }
      return { saved: true, noChange: true, latest: savedLatestLocal };
    }
    if (savedLatestLocal) {
      const refreshAfterSave = !saveTargetsCurrentView
        ? Promise.resolve()
        : saveMode === "truck_sequence"
        ? Promise.resolve().then(() => {
            isApplyingRemotePlan = true;
            applySavedPlan(result);
            resetUndoHistory();
            isApplyingRemotePlan = false;
          })
        : refreshOrderPool
          ? loadDispatchOrders().then(() => restoreServerPlan())
          : refreshPlannedAssignments();
      refreshAfterSave.then(() => render({ save: false })).catch(() => null);
      if (refreshOrderPool) nextSaveNeedsOrderPoolRefresh = false;
      if (saveMode === "truck_sequence") nextPlanSaveMode = "";
      clearLocalPlanDirty(payload.savedAt, saveGeneration);
      operatorAlertRefs.forEach((ref) => pendingOperatorAlertRefs.delete(ref));
    } else {
      saveQueued = true;
    }
    if (Array.isArray(result.followupWarnings) && result.followupWarnings.length) {
      const warning = new Error(result.followupWarnings.map((item) => `${item.step}: ${item.message}`).join("; "));
      reportDispatchSaveError("saved-with-followup-warning", warning, { followupWarnings: result.followupWarnings });
      routeNotice = `Plan saved, but ${result.followupWarnings.map((item) => item.label || item.step).join(", ")} needs attention. Details are in the browser console.`;
    }
    return { saved: true, latest: savedLatestLocal };
  } catch (error) {
    reportDispatchSaveError("exception", error);
    routeNotice = `Plan save failed: ${error.message}`;
    render({ save: false });
    return { failed: true, error };
  }
}

function queueServerSave() {
  if (isApplyingRemotePlan || !isDispatchPlanEditor()) return;
  autosaveDebug("queueServerSave", {
    wasQueued: saveQueued,
    timerActive: Boolean(saveTimer)
  });
  saveQueued = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushPlanSaveQueue(), 250);
}

async function flushPlanSaveQueue() {
  clearTimeout(saveTimer);
  if (isApplyingRemotePlan || !isDispatchPlanEditor()) return;
  if (saveInFlight) {
    autosaveDebug("flushPlanSaveQueue:alreadyInFlight");
    saveQueued = true;
    return saveFlushPromise;
  }
  autosaveDebug("flushPlanSaveQueue:start");
  saveInFlight = true;
  saveFlushPromise = (async () => {
    let staleRetryCount = 0;
    let finalResult = null;
    try {
      while (saveQueued) {
        saveQueued = false;
        const savedAt = new Date();
        const payload = planPayload(savedAt);
        const payloadHash = stablePlanHashPayload(payload);
        const saveGeneration = localPlanGeneration;
        const forceSave = forceNextPlanSave;
        forceNextPlanSave = false;
        const requiresSave = payloadRequiresSave(payload, payloadHash, forceSave);
        autosaveDebug("flushPlanSaveQueue:payload", {
          staleRetryCount,
          baseRevision: payload.baseRevision,
          payloadHash: shortHash(payloadHash),
          requiresSave,
          refreshOrderPool: Boolean(payload.refreshOrderPool),
          saveMode: payload.saveMode || "",
          forceSave
        });
        if (!requiresSave) {
          finalResult = { saved: true, noChange: true };
          clearLocalPlanDirty(savedAt.toISOString(), saveGeneration);
          continue;
        }
        lastSavedAt = savedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        const result = await savePlanToServer(payload, {
          retryOnStale: staleRetryCount < 1,
          payloadHash,
          saveGeneration,
          forceSave
        });
        finalResult = result;
        if (result?.staleRetryQueued) {
          autosaveDebug("flushPlanSaveQueue:staleRetryQueued", { staleRetryCount });
          staleRetryCount += 1;
          continue;
        }
        staleRetryCount = 0;
        if (result?.blocked || result?.failed) {
          const newerMutationQueued = saveQueued && localPlanGeneration !== saveGeneration;
          autosaveDebug("flushPlanSaveQueue:failedResult", {
            blocked: Boolean(result?.blocked),
            failed: Boolean(result?.failed),
            saveGeneration,
            localPlanGeneration,
            newerMutationQueued
          });
          if (newerMutationQueued) continue;
          break;
        }
      }
      return finalResult;
    } finally {
      saveInFlight = false;
      saveFlushPromise = null;
      autosaveDebug("flushPlanSaveQueue:end", { saveQueued });
    }
  })();
  return saveFlushPromise;
}

function historySnapshot() {
  return {
    orders,
    trucks,
    driverLaneOrder: [...driverLaneOrder],
    selectedOrderId,
    selectedOrderIds: [...selectedOrderIds],
    selectedLoadId,
    loadPreviewOpen,
    activeOrderType
  };
}

function packHistorySnapshot(snapshot = historySnapshot()) {
  return JSON.stringify(snapshot);
}

function unpackHistorySnapshot(packed) {
  return packed ? JSON.parse(packed) : null;
}

function historySnapshotFingerprint(snapshot = historySnapshot()) {
  return compactStringFingerprint(JSON.stringify({
    orders: snapshot.orders,
    trucks: snapshot.trucks,
    driverLaneOrder: snapshot.driverLaneOrder || []
  }));
}

function trimHistoryMemory() {
  while (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  while (redoStack.length > HISTORY_LIMIT) redoStack.shift();
  const memoryBytes = () => [...undoStack, ...redoStack].reduce((sum, packed) => sum + (String(packed || "").length * 2), 0);
  while (memoryBytes() > HISTORY_MEMORY_LIMIT_BYTES && undoStack.length + redoStack.length > 1) {
    if (undoStack.length > 1 || !redoStack.length) undoStack.shift();
    else redoStack.shift();
  }
}

function resetUndoHistory() {
  undoStack = [];
  redoStack = [];
  historyCurrentState = "";
  historyCurrentSnapshot = null;
  historyReady = false;
}

function applyHistorySnapshot(snapshot) {
  if (!snapshot) return;
  orders = (snapshot.orders || []).map(normalizeOrder);
  trucks = snapshot.trucks || [];
  ensureDriverLaneOrder(snapshot.driverLaneOrder || defaultDriverLaneOrder());
  selectedOrderId = orders.find((order) => order.id === snapshot.selectedOrderId)?.id || orders[0]?.id || "";
  selectedOrderIds = new Set((snapshot.selectedOrderIds || []).filter((id) => orders.some((order) => order.id === id)));
  if (!selectedOrderIds.size && selectedOrderId) selectedOrderIds.add(selectedOrderId);
  selectedLoadId = trucks.flatMap((truck) => truck.loads || []).find((load) => load.id === snapshot.selectedLoadId)?.id
    || trucks[0]?.loads?.[0]?.id
    || "";
  loadPreviewOpen = Boolean(snapshot.loadPreviewOpen && selectedLoadId);
  activeOrderType = snapshot.activeOrderType || activeOrderType;
  modalType = "";
  modalOrderId = "";
  modalLoadId = "";
  poAllocationOptions = null;
  poAllocationLoading = false;
  poAllocationError = "";
  orderDependencyOptions = null;
  orderDependencyLoading = false;
  orderDependencyError = "";
  clearActiveRouteEstimates();
}

function captureUndoPointIfNeeded(save) {
  const snapshot = historySnapshot();
  const fingerprint = historySnapshotFingerprint(snapshot);
  if (!historyReady) {
    historyCurrentState = fingerprint;
    historyCurrentSnapshot = packHistorySnapshot(snapshot);
    historyReady = true;
    return false;
  }
  if (fingerprint === historyCurrentState) return false;
  if (save && !isApplyingHistory && !isApplyingRemotePlan) {
    undoStack.push(historyCurrentSnapshot || packHistorySnapshot(snapshot));
    redoStack = [];
    trimHistoryMemory();
  }
  historyCurrentState = fingerprint;
  historyCurrentSnapshot = packHistorySnapshot(snapshot);
  return true;
}

function markLocalPlanDirty() {
  if (isApplyingHistory || isApplyingRemotePlan) return;
  localPlanDirty = true;
  localPlanGeneration += 1;
  lastLocalPlanEditAt = new Date().toISOString();
  autosaveDebug("markLocalPlanDirty", { lastLocalPlanEditAt, localPlanGeneration });
}

function clearLocalPlanDirty(savedAt = "", savedGeneration = localPlanGeneration) {
  if (savedGeneration !== localPlanGeneration) return;
  if (savedAt && lastLocalPlanEditAt && new Date(savedAt) < new Date(lastLocalPlanEditAt)) return;
  localPlanDirty = false;
  lastLocalPlanEditAt = "";
  if (blockedRemotePlanUpdate) {
    routeNotice = "Your changes were saved. A remote plan update was held back while you were editing.";
    blockedRemotePlanUpdate = false;
  }
  if (blockedDispatchSetupUpdate) {
    blockedDispatchSetupUpdate = false;
    queueDispatchSetupRefresh(0);
  }
}

function resetLocalPlanDirty() {
  const refreshSetup = blockedDispatchSetupUpdate;
  localPlanDirty = false;
  lastLocalPlanEditAt = "";
  blockedRemotePlanUpdate = false;
  blockedDispatchSetupUpdate = false;
  if (refreshSetup) queueDispatchSetupRefresh(0);
}

function undoDispatchChange() {
  if (!undoStack.length) return false;
  const current = historySnapshot();
  const currentPacked = packHistorySnapshot(current);
  const previousPacked = undoStack.pop();
  const previousState = unpackHistorySnapshot(previousPacked);
  redoStack.push(currentPacked);
  trimHistoryMemory();
  isApplyingHistory = true;
  applyHistorySnapshot(previousState);
  routeNotice = "Undo applied.";
  historyCurrentState = historySnapshotFingerprint(previousState);
  historyCurrentSnapshot = previousPacked;
  logDispatchAudit({
    action: "dispatch_plan_undo",
    entityType: "plan",
    entityId: currentPlan?.id || currentPlanDate,
    before: { orders: current.orders.length, trucks: current.trucks.length },
    after: { orders: previousState.orders?.length || 0, trucks: previousState.trucks?.length || 0 },
    details: { planDate: currentPlanDate }
  });
  isApplyingHistory = false;
  commitPlanMutation("dispatch_plan_undo");
  return true;
}

function redoDispatchChange() {
  if (!redoStack.length) return false;
  const current = historySnapshot();
  const currentPacked = packHistorySnapshot(current);
  const nextPacked = redoStack.pop();
  const nextState = unpackHistorySnapshot(nextPacked);
  undoStack.push(currentPacked);
  trimHistoryMemory();
  isApplyingHistory = true;
  applyHistorySnapshot(nextState);
  routeNotice = "Redo applied.";
  historyCurrentState = historySnapshotFingerprint(nextState);
  historyCurrentSnapshot = nextPacked;
  logDispatchAudit({
    action: "dispatch_plan_redo",
    entityType: "plan",
    entityId: currentPlan?.id || currentPlanDate,
    before: { orders: current.orders.length, trucks: current.trucks.length },
    after: { orders: nextState.orders?.length || 0, trucks: nextState.trucks?.length || 0 },
    details: { planDate: currentPlanDate }
  });
  isApplyingHistory = false;
  commitPlanMutation("dispatch_plan_redo");
  return true;
}

function autoSavePlan() {
  if (!isDispatchPlanEditor()) return;
  lastSavedAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  queueServerSave();
}

async function saveCurrentPlanNow({ forceSave = false } = {}) {
  if (!ensureDispatchPlanEditor()) throw new Error(dispatchEditModeMessage());
  clearTimeout(saveTimer);
  if (forceSave) forceNextPlanSave = true;
  saveQueued = true;
  const result = await flushPlanSaveQueue();
  if (result?.failed || result?.blocked) {
    throw result.error instanceof Error ? result.error : new Error(result.error || routeNotice || "Dispatch plan save failed.");
  }
  if (localPlanDirty) {
    throw new Error(routeNotice || "Latest dispatch plan changes were not saved.");
  }
}

async function forceSaveCurrentPlan() {
  if (!ensureDispatchPlanEditor()) throw new Error(dispatchEditModeMessage());
  if (!currentPlan?.id) throw new Error("Dispatch plan is not loaded.");
  await saveCurrentPlanNow({ forceSave: true });
  if (!routeNotice.startsWith("Plan saved, but")) routeNotice = "Plan saved.";
  render({ save: false });
}

async function dispatchErrorMessage(response) {
  const text = await response.text();
  try {
    const json = JSON.parse(text || "{}");
    return json.error || json.message || text || response.statusText;
  } catch {
    return text || response.statusText;
  }
}

async function confirmCurrentPlanAtomic() {
  if (!ensureDispatchPlanEditor()) throw new Error(dispatchEditModeMessage());
  if (!currentPlan?.id) throw new Error("Dispatch plan is not loaded.");
  clearTimeout(saveTimer);
  await saveCurrentPlanNow();
  saveQueued = false;
  const savedAt = new Date();
  const payload = planPayload(savedAt);
  const operatorAlertRefs = [...pendingOperatorAlertRefs];
  confirmInFlight = true;
  try {
    const response = await fetch(`/api/dispatch/plans/${encodeURIComponent(payload.planId || currentPlan.id)}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        editLeaseToken: planEditLeaseToken,
        baseRevision: null,
        summary: planSummary(),
        audit: {
          sessionId: dispatchSessionId,
          action: "dispatch_plan_confirmed",
          details: {
            planDate: payload.planDate,
            status: currentPlan?.status,
            operatorAlertRefs,
            refreshOrderPool: Boolean(payload.refreshOrderPool),
            saveMode: "confirm"
          }
        }
      })
    });
    if (!response.ok) throw new Error(await dispatchErrorMessage(response));
    try {
      const plan = await response.json();
      currentPlan = plan;
      currentPlanDate = plan.planDate || currentPlanDate;
      dispatchStorageSet(DISPATCH_PLAN_DATE_KEY, currentPlanDate);
      applySavedPlan(plan);
      currentPlan = compactCurrentPlan(plan);
      await loadPlanHistory();
      lastServerSavedAt = plan.savedAt || plan.updatedAt || lastServerSavedAt;
      lastSavedPlanHash = savedPlanHash(plan);
      lastSavedAt = savedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      saveQueued = false;
      nextSaveNeedsOrderPoolRefresh = false;
      nextPlanSaveMode = "";
      pendingOperatorAlertRefs.clear();
      resetLocalPlanDirty();
      resetUndoHistory();
      minimumPlanRevisionToApply = { planId: String(plan.id || ""), revision: Number(plan.revision || 0) };
      return plan;
    } catch (error) {
      const refreshError = new Error(`Plan confirmation succeeded on the server, but this screen could not refresh: ${error.message}. Reload the plan before retrying.`);
      refreshError.code = "DISPATCH_CONFIRM_REFRESH_FAILED";
      throw refreshError;
    }
  } finally {
    confirmInFlight = false;
  }
}

function commitPlanMutation(actionName = "dispatch_plan_mutation", mutator = null, options = {}) {
  if (!ensureDispatchPlanEditor()) return false;
  const rollbackPacked = historyReady ? historyCurrentSnapshot : null;
  autosaveDebug("commitPlanMutation:start", {
    actionName,
    options,
    beforeRevision: currentPlan?.revision ?? null
  });
  if (typeof mutator === "function") mutator();
  if (options.refreshOrderPool) requestOrderPoolRefreshOnNextSave();
  if (options.truckSequence) requestTruckSequenceSaveOnNextSave();
  normalizePlanBeforeSave();
  const dependencySequenceWarning = options.validateDependencies === false
    ? ""
    : trucks
      .flatMap((truck) => (truck.loads || []).flatMap((load) => replenishmentSequenceWarningsForStops(load.stops || [])))
      .find(Boolean) || "";
  if (dependencySequenceWarning) {
    if (rollbackPacked) applyHistorySnapshot(unpackHistorySnapshot(rollbackPacked));
    routeNotice = `Invalid dependency sequence: ${dependencySequenceWarning}`;
    autosaveDebug("commitPlanMutation:dependencyRejected", {
      actionName,
      message: dependencySequenceWarning
    });
    render({ save: false });
    return false;
  }
  const assignmentConflict = options.validateAssignments === false || !DISPATCH_ASSIGNMENT_MUTATION_ACTIONS.has(actionName)
    ? null
    : localDispatchLoadAssignmentConflict();
  if (assignmentConflict) {
    if (rollbackPacked) applyHistorySnapshot(unpackHistorySnapshot(rollbackPacked));
    routeNotice = assignmentConflict.message;
    autosaveDebug("commitPlanMutation:assignmentRejected", {
      actionName,
      code: assignmentConflict.code,
      message: assignmentConflict.message
    });
    render({ save: false });
    return false;
  }
  const planChanged = captureUndoPointIfNeeded(true);
  if (planChanged || options.forceSave) {
    markLocalPlanDirty();
    autoSavePlan();
  }
  autosaveDebug("commitPlanMutation:end", {
    actionName,
    planChanged,
    forceSave: Boolean(options.forceSave)
  });
  render({ save: false });
  return planChanged;
}

async function loadPlanHistory() {
  try {
    const response = await fetch("/api/dispatch/plans?limit=80");
    if (!response.ok) return [];
    planHistory = await response.json();
    return planHistory;
  } catch {
    planHistory = [];
    return [];
  }
}

async function createPlanForDate(planDate = currentPlanDate) {
  if (!ensureDispatchPlanEditor()) throw new Error(dispatchEditModeMessage());
  const response = await fetch("/api/dispatch/plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      planDate,
      sessionId: dispatchSessionId,
      editLeaseToken: planEditLeaseToken,
      audit: { sessionId: dispatchSessionId }
    })
  });
  if (!response.ok) throw new Error(await response.text());
  const plan = await response.json();
  currentPlan = compactCurrentPlan(plan);
  currentPlanDate = plan.planDate || planDate;
  dispatchStorageSet(DISPATCH_PLAN_DATE_KEY, currentPlanDate);
  await loadPlanHistory();
  return plan;
}

function resetPlanningBoard() {
  orders = orderCatalog.map((order) => normalizeOrder(order));
  trucks = fleet.map((vehicle, index) => makeTruckFromFleet(vehicle, index));
  if (driverOrientedPlanningEnabled()) {
    for (const truck of trucks) truck.loads = [];
  }
  ensureDriverLaneOrder(defaultDriverLaneOrder());
  selectedOrderId = orders[0]?.id || "";
  selectedOrderIds = new Set(selectedOrderId ? [selectedOrderId] : []);
  selectedLoadId = trucks[0]?.loads?.[0]?.id || "";
  clearActiveRouteEstimates();
}

async function resetDispatchAfterOrderDataClear() {
  clearTimeout(saveTimer);
  clearTimeout(remoteRefreshTimer);
  dispatchStorageRemove(DISPATCH_PLAN_KEY);
  currentPlan = null;
  lastSavedAt = "";
  lastServerSavedAt = "";
  resetLocalPlanDirty();
  selectedLoadId = "";
  selectedOrderId = "";
  selectedOrderIds = new Set();
  activeGroupOrderId = "";
  splitOrderId = "";
  coEditOrderId = "";
  poLinkOrderId = "";
  await loadDispatchOrders();
  await loadDriverJobStatuses();
  resetPlanningBoard();
  resetUndoHistory();
  routeNotice = "Operational order data was cleared. Dispatch board reset.";
  render({ save: false });
}

async function loadPlanForDate(planDate = currentPlanDate, { createIfMissing = true } = {}) {
  if (String(planDate || "") !== String(currentPlanDate || "")) driverNewTruckSelections.clear();
  const response = await fetch(`/api/dispatch/plans/current?date=${encodeURIComponent(planDate)}`);
  if (!response.ok) throw new Error(await response.text());
  let plan = await response.json();
  let created = false;
  if (!plan?.id && createIfMissing && isDispatchPlanEditor()) {
    plan = await createPlanForDate(planDate);
    created = true;
  }
  currentPlan = plan?.id ? plan : null;
  currentPlanDate = plan?.planDate || planDate;
  dispatchStorageSet(DISPATCH_PLAN_DATE_KEY, currentPlanDate);
  // Lease status controls editing only. A transient read failure must not prevent
  // the read-only planning board from rendering.
  try {
    await refreshDispatchPlanEditLease(currentPlanDate);
  } catch (error) {
    leaveDispatchEditMode({ clearLease: true });
    routeNotice = `Edit Mode status is temporarily unavailable: ${error.message}`;
  }
  if (Array.isArray(currentPlan?.orders) && Array.isArray(currentPlan?.trucks)) {
    applySavedPlan(currentPlan);
    currentPlan = compactCurrentPlan(currentPlan);
    lastServerSavedAt = currentPlan.savedAt || currentPlan.updatedAt || lastServerSavedAt;
    await loadDriverJobStatuses();
    resetUndoHistory();
    resetLocalPlanDirty();
    return { loaded: true, created, hasSnapshot: true };
  }
    currentPlan = compactCurrentPlan(currentPlan);
  if (currentPlan?.id) {
    resetPlanningBoard();
    lastServerSavedAt = currentPlan.savedAt || currentPlan.updatedAt || lastServerSavedAt;
    await loadDriverJobStatuses();
    resetUndoHistory();
    resetLocalPlanDirty();
    return { loaded: true, created, hasSnapshot: false };
  }
  resetPlanningBoard();
  await loadDriverJobStatuses();
  resetUndoHistory();
  resetLocalPlanDirty();
  return { loaded: false, created, hasSnapshot: false };
}

async function loadPlanById(planId) {
  const response = await fetch(`/api/dispatch/plans/${encodeURIComponent(planId)}`);
  if (!response.ok) throw new Error(await response.text());
  const plan = await response.json();
  if (String(plan.planDate || "") !== String(currentPlanDate || "")) driverNewTruckSelections.clear();
  currentPlan = plan;
  currentPlanDate = plan.planDate || currentPlanDate;
  dispatchStorageSet(DISPATCH_PLAN_DATE_KEY, currentPlanDate);
  leaveDispatchEditMode();
  try {
    await refreshDispatchPlanEditLease(currentPlanDate);
  } catch (error) {
    leaveDispatchEditMode({ clearLease: true });
    routeNotice = `Edit Mode status is temporarily unavailable: ${error.message}`;
  }
  currentPlan = compactCurrentPlan(plan);
  if (Array.isArray(plan.orders) && Array.isArray(plan.trucks)) applySavedPlan(plan);
  lastServerSavedAt = plan.savedAt || plan.updatedAt || lastServerSavedAt;
  await loadPlanHistory();
  await loadDriverJobStatuses();
  resetUndoHistory();
  resetLocalPlanDirty();
  return plan;
}

async function restoreServerPlan() {
  try {
    if (!currentPlan?.id) return false;
    const requestedPlanId = currentPlan.id;
    const response = await fetch(`/api/dispatch/plans/${encodeURIComponent(requestedPlanId)}`);
    if (!response.ok) return false;
    const saved = await response.json();
    if (!saved?.savedAt || !Array.isArray(saved.orders) || !Array.isArray(saved.trucks)) return false;
    const savedRevision = Number(saved.revision || 0);
    const localRevision = Number(currentPlan?.revision || 0);
    const newerRevision = savedRevision > localRevision;
    const newerSavedAt = !lastServerSavedAt || new Date(saved.savedAt) > new Date(lastServerSavedAt);
    if (!newerRevision && !newerSavedAt) return false;
    if (localPlanDirty) {
      blockedRemotePlanUpdate = true;
      routeNotice = "Remote update available. Your unsaved changes are still visible.";
      return false;
    }
    isApplyingRemotePlan = true;
    currentPlanDate = saved.planDate || currentPlanDate;
    const applied = applySavedPlan(saved);
    currentPlan = compactCurrentPlan(saved);
    await loadDriverJobStatuses();
    if (applied) resetUndoHistory();
    isApplyingRemotePlan = false;
    return applied;
  } catch {
    isApplyingRemotePlan = false;
    return false;
  }
}

async function pollServerPlan() {
  if (!currentPlan?.id || planPollInFlight || saveInFlight || saveQueued || confirmInFlight) return;
  planPollInFlight = true;
  try {
    const response = await fetch(`/api/dispatch/plans/${encodeURIComponent(currentPlan.id)}/revision`);
    if (!response.ok) return;
    const remote = await response.json();
    const remoteRevision = Number(remote.revision || 0);
    const localRevision = Number(currentPlan?.revision || 0);
    autosaveDebug("pollServerPlan:revision", {
      remoteRevision,
      localRevision,
      savedAt: remote.savedAt || "",
      updatedBySessionId: remote.updatedBySessionId || ""
    });
    if (!remoteRevision || remoteRevision <= localRevision) return;
    if (localPlanDirty) {
      blockedRemotePlanUpdate = true;
      routeNotice = "Remote update available. Your unsaved changes are still visible.";
      autosaveDebug("pollServerPlan:blockedByDirty", { remoteRevision, localRevision });
      render({ save: false });
      return;
    }
    const applied = await restoreServerPlan();
    if (applied) render({ save: false });
  } catch {
    // Keep polling quietly; SSE or the next poll will catch up.
  } finally {
    planPollInFlight = false;
  }
}

function queueRemoteRefresh(reason = "Plan updated from another screen.", { reloadOrders = true } = {}) {
  window.clearTimeout(remoteRefreshTimer);
  remoteRefreshTimer = window.setTimeout(async () => {
    try {
      if (reloadOrders) await loadDispatchOrders();
      const applied = await restoreServerPlan();
      await loadDriverJobStatuses();
      if (!reloadOrders) await refreshPlannedAssignments();
      if (reason) routeNotice = reason;
      render({ save: false });
      if (reloadOrders && modalType === "to-link") {
        loadOrderDependencyOptions(orderById(modalOrderId)).catch(() => null);
      } else if (reloadOrders && modalType === "po-link") {
        loadPoAllocationOptions(modalOrderId).catch(() => null);
      }
      if (applied && reason) routeNotice = reason;
    } catch (error) {
      routeNotice = `Auto refresh failed: ${error.message}`;
      render({ save: false });
    }
  }, 350);
}

function queueDispatchSetupRefresh(delay = 350) {
  window.clearTimeout(remoteRefreshTimer);
  remoteRefreshTimer = window.setTimeout(async () => {
    if (localPlanDirty) {
      blockedDispatchSetupUpdate = true;
      routeNotice = "Dispatch setup changed. Your unsaved plan changes are still visible; setup will refresh after they are saved or cleared.";
      render({ save: false });
      return;
    }
    try {
      const savedTrucks = trucks;
      await loadDispatchSetup();
      trucks = trucksFromFleetAndSavedPlan(savedTrucks);
      normalizeLoadAssignments();
      clearActiveRouteEstimates();
      routeNotice = "Dispatch setup updated.";
      render({ save: false });
    } catch (error) {
      routeNotice = `Setup refresh failed: ${error.message}`;
      render({ save: false });
    }
  }, delay);
}

function connectEvents() {
  if (eventSource) return;
  eventSource = new EventSource(`/api/events?client=dispatch&sessionId=${encodeURIComponent(dispatchSessionId)}`);
  eventSource.addEventListener("app-event", (message) => {
    let event;
    try {
      event = JSON.parse(message.data || "{}");
    } catch {
      return;
    }
    if (event.type === "connected") return;
    const payload = event.payload || {};
    if (payload.sourceSessionId && payload.sourceSessionId === dispatchSessionId) return;

    if (event.type === "dispatch.plan.edit_lease_changed") {
      if (payload.planDate && payload.planDate !== currentPlanDate) return;
      refreshDispatchPlanEditLease(currentPlanDate)
        .then(() => render({ save: false }))
        .catch(() => null);
      return;
    }

    if ((event.type === "dispatch.orders.updated" && payload.change === "order_data_clear") || event.type === "dispatch.plan.cleared") {
      resetDispatchAfterOrderDataClear().catch((error) => {
        routeNotice = `Dispatch reset failed: ${error.message}`;
        render({ save: false });
      });
      return;
    }

    if (["dispatch.plan.saved", "dispatch.plan.confirmed", "dispatch.plan.reopened"].includes(event.type)) {
      if (payload.planDate && payload.planDate !== currentPlanDate) return;
      autosaveDebug("sse:planEvent", {
        type: event.type,
        sourceSessionId: payload.sourceSessionId || "",
        savedAt: payload.savedAt || "",
        refreshOrderPool: payload.refreshOrderPool === true
      });
      // Some legacy server events omit sourceSessionId. Verify that the server
      // revision is actually newer before warning about a remote editor.
      if (saveInFlight || saveQueued || confirmInFlight) return;
      pollServerPlan();
      return;
    }

    if (event.type === "dispatch.setup.updated") {
      if (localPlanDirty) {
        blockedDispatchSetupUpdate = true;
        routeNotice = "Dispatch setup changed. Your unsaved plan changes are still visible; setup will refresh after they are saved or cleared.";
        render({ save: false });
        return;
      }
      queueDispatchSetupRefresh();
      return;
    }

    if ([
      "delivery.order.unpacked",
      "delivery.order.loaded",
      "delivery.order.updated",
      "delivery.line.confirmed",
      "delivery.line.updated",
      "dispatch.operator_request.created",
      "dispatch.orders.updated",
      "dispatch.co.updated",
      "driver.job.started",
      "driver.job.completed",
      "driver.truck.switched",
      "driver.truck.switch.attention",
      "driver.truck.switch.overridden",
      "receiving.order.received"
    ].includes(event.type)) {
      queueRemoteRefresh(event.type === "delivery.order.unpacked" ? "Operator unpacked an order. Split can continue." : "Order data updated.");
    }
  });
  eventSource.onerror = () => {
    eventSource?.close();
    eventSource = null;
    window.setTimeout(connectEvents, 3000);
  };
}

function findLoad(loadId) {
  for (const truck of trucks) {
    const load = truck.loads.find((item) => item.id === loadId);
    if (load) return { truck, load };
  }
  return {};
}

function allAssignedOrderIds() {
  const assigned = assignedOrderIdsForTrucks(trucks);
  for (const order of orders || []) {
    const childIds = (order.childOrders || []).map(String).filter(Boolean);
    if (childIds.length && childIds.every((childId) => assigned.has(childId))) {
      assigned.add(order.id);
    }
  }
  return assigned;
}

function orderAssignment(orderId) {
  const target = String(orderId || "");
  const matchesOrderRef = (order) => {
    if (!order || !target) return false;
    if (String(order.id || "") === target) return true;
    if (String(order.originalOrderId || "") === target) return true;
    if ((order.childOrders || []).map(String).includes(target)) return true;
    return (order.childOrderDetails || []).some((child) =>
      String(child?.id || "") === target || String(child?.originalOrderId || "") === target
    );
  };
  for (const truck of trucks) {
    for (const load of truck.loads || []) {
      for (const stop of load.stops || []) {
        const order = orderById(stop.orderId);
        if (String(stop.orderId || "") === target || matchesOrderRef(order)) {
          return { truck, load, orderId: stop.orderId };
        }
      }
    }
  }
  return {};
}

function isOrderAssignedInCurrentPlan(orderId) {
  return allAssignedOrderIds().has(String(orderId || ""));
}

function isOrderPlannedOnAnotherDate(order = {}) {
  if (!order?.dispatchPlanned) return false;
  if (isOrderAssignedInCurrentPlan(order.id)) return false;
  const plannedDate = String(order.dispatchPlanDate || "").slice(0, 10);
  return plannedDate && plannedDate !== String(currentPlanDate || "").slice(0, 10);
}

function isOrderPlannedOutsideCurrentPlan(order = {}) {
  return Boolean(order?.dispatchPlanned && !isOrderAssignedInCurrentPlan(order.id));
}

function orderPlannedElsewhereText(order = {}) {
  const parts = [
    order.dispatchPlanDate ? `planned on ${order.dispatchPlanDate}` : "already planned",
    [order.dispatchTruckPlate, order.dispatchLoadName].filter(Boolean).join(" ")
  ].filter(Boolean);
  return parts.join(" | ");
}

async function jumpToPlannedOrder(orderId) {
  const order = orderById(orderId);
  const targetDate = String(order?.dispatchPlanDate || "").slice(0, 10);
  if (!order || !targetDate) return false;
  routeNotice = `Loading ${targetDate} plan for ${order.id}...`;
  render({ save: false });
  await loadPlanForDate(targetDate, { createIfMissing: false });
  const assignment = orderAssignment(order.id);
  if (!assignment.load) {
    routeNotice = `${order.id} is marked planned on ${targetDate}, but the load was not found.`;
    render({ save: false });
    return false;
  }
  selectedOrderId = assignment.orderId || order.id;
  selectedOrderIds = new Set([selectedOrderId]);
  selectedLoadId = assignment.load.id;
  loadPreviewOpen = true;
  routeNotice = `${order.id} is planned on ${assignment.truck?.plate || "truck"} ${assignment.load.name}.`;
  render({ save: false });
  return true;
}

function openOrders() {
  const assigned = allAssignedOrderIds();
  const visibilitySource = [...orders, ...orderCatalog];
  const hiddenOrderIds = new Set([
    ...groupedChildOrderIds(visibilitySource),
    ...splitParentOrderIds(visibilitySource)
  ]);
  const term = searchText.trim();
  return orders.filter((order) => {
    if (hiddenOrderIds.has(order.id)) return false;
    if (!term && order.dependencyHidden) return false;
    if (!term && assigned.has(order.id)) return false;
    if (!term && isOrderPlannedOutsideCurrentPlan(order)) return false;
    if (!matchesSearch(order)) return false;
    if (dispatchDateFilter && order.type === "SO" && order.expectedDeliveryDate !== dispatchDateFilter) return false;
    return term
      ? true
      : activeOrderType === "TO"
        ? ["TO", "CUSTOM"].includes(order.type)
        : order.type === activeOrderType;
  });
}

function matchesSearch(order) {
  const term = searchText.trim().toLowerCase();
  if (!term) return true;
  return [
    order.id,
    order.type,
    order.customer,
    order.address,
    order.sourceYard,
    order.destinationYard,
    order.sourceOrderId,
    order.relatedSoId,
    order.transitCo?.id,
    order.expectedDeliveryDate,
    order.notes,
    ...(order.childOrders || []),
    ...(order.groupAliases || []),
    ...(order.childOrderDetails || []).flatMap((child) => [child?.id, child?.originalOrderId]),
    ...(order.items || []).map((item) => item.sku)
  ].join(" ").toLowerCase().includes(term);
}

function groupCandidates(order) {
  return orders.filter((item) => item.childOrders?.includes(order.id) || (order.childOrders || []).includes(item.id));
}

function stopOrder(stop) {
  const orderId = String(stop?.orderId || "");
  if (!orderId) return null;
  const directPlanOrder = orders.find((order) => String(order?.id || "") === orderId);
  if (directPlanOrder) return directPlanOrder;
  const catalogOrder = orderCatalog.find((order) => String(order?.id || "") === orderId);
  if (catalogOrder) return catalogOrder;
  return orders.find((order) => dispatchGroupingRefs(order).has(orderId)) || null;
}

function stopById(stopId) {
  const id = String(stopId || "");
  for (const truck of trucks) {
    for (const load of truck.loads || []) {
      const found = (load.stops || []).find((stop) => String(stop.id) === id);
      if (found) return found;
    }
  }
  return null;
}

function requiredPickupLocations(order) {
  const locations = order?.pickupLocations?.length ? order.pickupLocations : ["3445"];
  const seen = new Set();
  const uniqueLocations = locations.filter((location) => {
    const key = normalizedPickupLocation(location);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const hasPickupAddressOverride = Boolean(String(order?.pickupAddressOverride || "").trim());
  return uniqueLocations.filter((location, index) =>
    (hasPickupAddressOverride && index === 0)
      || tooltipItemsForOrder(order, { pickupLocation: location }).some(itemHasQuantity)
  );
}

function sequenceWarningsForStops(stops) {
  const picked = new Set();
  const warnings = [];
  for (const stop of stops) {
    if (stop.type === "pick") {
      picked.add(String(stop.location));
      continue;
    }
    if (stop.type !== "drop") continue;
    const order = stopOrder(stop);
    if (!order) continue;
    const missing = requiredPickupLocations(order).filter((location) => !picked.has(String(location)));
    if (missing.length) warnings.push(`${order.id}: pickup ${missing.join(", ")} before drop.`);
  }
  for (const warning of replenishmentSequenceWarningsForStops(stops)) {
    if (!warnings.includes(warning)) warnings.push(warning);
  }
  return warnings;
}

function sequenceIsValid(stops) {
  return !sequenceWarningsForStops(stops).length;
}

function uniquePickupLocations(load, truck) {
  const locations = [];
  for (const stop of load.stops) {
    if (stop.type === "pick") {
      if (stop.location && !locations.includes(stop.location)) locations.push(stop.location);
      continue;
    }
    const order = stopOrder(stop);
    for (const location of order?.pickupLocations || [truck.base]) {
      if (location && !locations.includes(location)) locations.push(location);
    }
  }
  if (!locations.length && truck?.base) locations.push(truck.base);
  return locations;
}

function uniquePickupDisplayLabels(load, truck) {
  const labels = [];
  for (const stop of load?.stops || []) {
    if (stop.type !== "pick") continue;
    const order = stopOrder(stop);
    const label = pickupStopLabel(stop, order);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels.length ? labels : uniquePickupLocations(load, truck);
}

function pickupFootprintForLocation(load, location) {
  const pickupLocation = String(location || "");
  const countedOrders = new Set();
  let total = 0;
  for (const stop of load.stops || []) {
    if (stop.type !== "drop" || countedOrders.has(stop.orderId)) continue;
    const order = stopOrder(stop);
    if (!order) continue;
    if (!requiredPickupLocations(order).map(String).includes(pickupLocation)) continue;
    countedOrders.add(stop.orderId);
    total += pickupFootprintForOrderLocation(order, pickupLocation);
  }
  return total;
}

function pickupFootprintForOrderLocation(order, location) {
  const items = tooltipItemsForOrder(order, { pickupLocation: location });
  if (!items.length) return 0;
  const pallets = items.reduce((sum, item) => sum + Number(item.pallets || item.pallet_qty || 0), 0);
  const hasLoose = items.some((item) => Number(item.layers || item.layer_qty || 0)
    || Number(item.sections || item.section_qty || 0)
    || Number(item.pieces || item.piece_qty || 0));
  if (pallets || hasLoose) return pallets + (hasLoose ? 1 : 0);
  const direct = directPickupEntriesForLocation(order, location);
  if (direct.length) return direct.reduce((sum, entry) => sum + (entry.items || []).reduce((itemSum, item) => itemSum + Number(item.palletQty || 0), 0), 0);
  return orderFootprintPallets(order);
}

function directPickupWeight(order = {}, entries = order.directPickupManifest || []) {
  return entries.reduce((sum, entry) => sum + (entry.items || []).reduce((itemSum, item) => {
    return itemSum + (Number(item.quantity || 0) * Number(item.itemWeight || item.item_weight || 0));
  }, 0), 0);
}

function pickupWeightForOrderLocation(order, location) {
  const direct = directPickupEntriesForLocation(order, location);
  const source = String(order.sourceYard || order.outboundLocation || "");
  if (direct.length && source !== String(location || "")) return directPickupWeight(order, direct);
  if (source === String(location || "") && (order.directPickupManifest || []).length) {
    return Math.max(0, orderWeightLbs(order) - directPickupWeight(order));
  }
  return orderWeightLbs(order);
}

function routeLegMinutesForLoad(load) {
  const estimate = estimateForLoad(load);
  return Array.isArray(estimate?.legMinutes) ? estimate.legMinutes : [];
}

function normalizeRouteEstimateForLoad(load, estimate) {
  if (!estimate || !load?.returnOnly || !load?.manual) return estimate || null;
  const stayMinutes = Math.max(0, Number(estimate.stayMinutes || 0));
  const totalMinutes = Math.max(0, Number(estimate.totalMinutes || 0));
  const explicitDriveMinutes = Number(estimate.driveMinutes);
  const driveMinutes = Number.isFinite(explicitDriveMinutes)
    ? Math.max(0, explicitDriveMinutes)
    : Math.max(0, totalMinutes - stayMinutes);
  if (stayMinutes === 0 && totalMinutes === driveMinutes) return estimate;
  return { ...estimate, driveMinutes, stayMinutes: 0, totalMinutes: driveMinutes };
}

function estimateForLoad(load) {
  const estimate = routeEstimates[load?.id] || load?.routeEstimate || null;
  return normalizeRouteEstimateForLoad(load, estimate);
}

function discardRouteEstimateForLoad(load) {
  if (!load?.id) return;
  delete routeCache[load.id];
  delete routeEstimates[load.id];
  delete load.routeEstimate;
}

function clearActiveRouteEstimates() {
  window.clearTimeout(backgroundRouteTimer);
  backgroundRouteTimer = null;
  backgroundRouteRenderQueued = false;
  backgroundRouteInFlight.clear();
  routeCache = {};
  routeEstimates = {};
  for (const truck of trucks || []) {
    for (const load of truck.loads || []) delete load.routeEstimate;
  }
}

function invalidateDriverRoutesFromLoad(loadId) {
  const found = findLoad(loadId);
  if (!found.load) return;
  const entries = driverLoadEntries(loadDriverKey(found.truck, found.load));
  const startIndex = entries.findIndex((entry) => entry.load.id === found.load.id);
  const affected = startIndex >= 0 ? entries.slice(startIndex) : [found];
  for (const entry of affected) discardRouteEstimateForLoad(entry.load);
  backgroundRouteInFlight.clear();
  window.clearTimeout(backgroundRouteTimer);
  backgroundRouteTimer = null;
}

function routeStopIsOwnYard(stop = {}) {
  if (stop.kind === "own") return true;
  const keys = [
    stop.address,
    typeof stop.routeLocation === "string" ? stop.routeLocation : "",
    stop.title,
    stop.label
  ].map(normalizedPlaceKey).filter(Boolean);
  if (!keys.length) return false;
  return ownYards.some((yard) => {
    const yardKeys = [yard.code, yard.name, yard.address].map(normalizedPlaceKey).filter(Boolean);
    return yardKeys.some((yardKey) => keys.includes(yardKey));
  });
}

function routePendingForLoad(truck, load) {
  if (!dispatchConfig.googleMapsApiKey || estimateForLoad(load)) return false;
  const stops = mapStopsForLoad(load, effectiveTruckForLoad(truck, load));
  if (stops.length <= 1) return false;
  return stops.some((stop) => !routeStopIsOwnYard(stop));
}

function loadFinishText(truck, load, stats = loadStats(truck, load)) {
  return routePendingForLoad(truck, load) ? "Route pending" : timeText(stats.finish);
}

function fallbackTravelMinutesBetweenStops(truck, previousStop, currentStop, previousOrder, currentOrder) {
  if (!previousStop) return 0;
  const previousPlace = resolveStopPlace(previousStop, previousOrder);
  const currentPlace = resolveStopPlace(currentStop, currentOrder);
  if (
    (previousPlace.kind === "own"
      && currentPlace.kind === "own"
      && String(previousPlace.key || "") === String(currentPlace.key || ""))
    || samePhysicalAddress(
      previousPlace.routeLocation || previousPlace.address,
      currentPlace.routeLocation || currentPlace.address
    )
  ) return 0;
  const previousLocation = previousPlace.kind === "own"
    ? previousPlace.key
    : previousPlace.address || previousPlace.key || "";
  const currentLocation = currentPlace.kind === "own"
    ? currentPlace.key
    : currentPlace.address || currentPlace.key || "";
  let value = 30;
  if (HUBS[previousLocation] && HUBS[currentLocation]) value = yardTravelMinutes(previousLocation, currentLocation);
  else if (currentStop.type === "drop") value = Number(currentOrder?.travelMinutes || 30);
  else value = Number(previousOrder?.travelMinutes || currentOrder?.travelMinutes || 30);
  return adjustedTravelMinutesForTruck(truck, value);
}

function loadStats(parentTruck, load) {
  const truck = effectiveTruckForLoad(parentTruck, load);
  const startInfo = loadStartInfo(parentTruck, load);
  const start = startInfo.start;
  const startWarnings = [];
  if (startInfo.startClamped) {
    startWarnings.push(`Load start ${timeText(startInfo.scheduledStart)} does not leave enough time after the previous load. Start was moved to ${timeText(start)}.`);
  }
  if (load.returnOnly) {
    const estimate = estimateForLoad(load);
    const totalMinutes = Number(estimate?.totalMinutes || adjustedTravelMinutesForTruck(truck, load.returnMinutes || 30));
    return {
      rows: [],
      palletTotal: 0,
      footprintTotal: 0,
      weightTotalLbs: 0,
      capacityLbs: truckCapacityLbs(truck),
      start,
      finish: start + totalMinutes,
      returnTrip: totalMinutes,
      warningCount: startWarnings.length,
      warnings: startWarnings,
      capacityWarning: false,
      fullLoad: false,
      restBefore: startInfo.restBefore,
      switchBefore: startInfo.switchBefore,
      switchMinutes: startInfo.switchMinutes,
      handoffTravel: startInfo.handoffTravel,
      handoffMinutes: startInfo.handoffMinutes,
      handoffStart: startInfo.handoffStart,
      handoffFinish: startInfo.handoffFinish,
      switchStart: startInfo.switchStart,
      previousFinish: startInfo.previousFinish,
      scheduledStart: startInfo.scheduledStart,
      startClamped: startInfo.startClamped
    };
  }
  let current = start;
  const startTravel = startTravelForLoad(truck, load);
  let resolvedStartTravel = startTravel;
  const routeLegMinutes = routeLegMinutesForLoad(load);
  let routeLegIndex = startInfo.handoffTravel ? 1 : 0;
  if (startTravel) {
    const startTravelMinutes = Number(routeLegMinutes[routeLegIndex] ?? adjustedTravelMinutesForTruck(truck, startTravel.minutes));
    resolvedStartTravel = { ...startTravel, minutes: startTravelMinutes };
    current += startTravelMinutes;
    routeLegIndex += 1;
  }
  const rows = [];
  let palletTotal = 0;
  let footprintTotal = 0;
  let processedWeightLbs = 0;
  let currentWeightLbs = 0;
  let peakWeightLbs = 0;
  let travelTotal = 0;
  let warningCount = startWarnings.length;
  const warnings = [...startWarnings];
  const sequenceWarnings = sequenceWarningsForStops(load.stops);
  const pickedLocations = new Set();
  const onboardOrderIds = new Set();
  const droppedOrderIds = new Set();
  const remainingDropCounts = new Map();
  for (const stop of load.stops) {
    if (stop.type !== "drop" || !stop.orderId) continue;
    remainingDropCounts.set(
      String(stop.orderId),
      Number(remainingDropCounts.get(String(stop.orderId)) || 0) + 1
    );
  }
  const explicitPickCount = load.stops.filter((stop) => stop.type === "pick").length;
  if (!explicitPickCount) {
    for (const location of uniquePickupLocations(load, truck)) {
      current += truckStopMinutes(truck, HUBS[location] ? "own" : "vendor", pickupFootprintForLocation(load, location));
    }
    for (const stop of load.stops) {
      if (stop.type !== "drop" || onboardOrderIds.has(stop.orderId)) continue;
      const order = stopOrder(stop);
      if (!order) continue;
      currentWeightLbs += orderWeightLbs(order);
      onboardOrderIds.add(stop.orderId);
    }
    peakWeightLbs = currentWeightLbs;
  }

  let previousStop = null;
  let previousOrder = null;
  for (const stop of load.stops) {
    const order = stopOrder(stop);
    if (!order) continue;
    if (previousStop) {
      current += Number(routeLegMinutes[routeLegIndex] ?? fallbackTravelMinutesBetweenStops(truck, previousStop, stop, previousOrder, order));
      routeLegIndex += 1;
    }
    if (stop.type === "pick") {
      pickedLocations.add(String(stop.location));
      let pickedFootprint = 0;
      const pickedOrderIdsAtLocation = new Set();
      for (const dropStop of load.stops) {
        if (dropStop.type !== "drop" || droppedOrderIds.has(dropStop.orderId)) continue;
        if (pickedOrderIdsAtLocation.has(String(dropStop.orderId))) continue;
        const dropOrder = stopOrder(dropStop);
        if (!dropOrder) continue;
        if (!requiredPickupLocations(dropOrder).map(String).includes(String(stop.location))) continue;
        currentWeightLbs += pickupWeightForOrderLocation(dropOrder, stop.location);
        pickedFootprint += pickupFootprintForOrderLocation(dropOrder, stop.location);
        pickedOrderIdsAtLocation.add(String(dropStop.orderId));
        onboardOrderIds.add(dropStop.orderId);
        peakWeightLbs = Math.max(peakWeightLbs, currentWeightLbs);
      }
      const arrival = current;
      current += truckStopMinutes(truck, stopServiceType(stop, order), pickedFootprint);
      let warningReason = "";
      const window = stopTimeWindow(stop, order);
      const hasTimeWindow = Boolean(window.start && window.end);
      const pickupLabel = pickupStopLabel(stop, order);
      if (window.closed) warningReason = `${pickupLabel} closed on ${window.label || planWeekdayName()}.`;
      else if (hasTimeWindow && arrival > minutes(window.end)) warningReason = `Pickup ${pickupLabel} late: arrives ${timeText(arrival)}, window ends ${window.end}`;
      else if (hasTimeWindow && arrival < minutes(window.start)) warningReason = `Pickup ${pickupLabel} early: arrives ${timeText(arrival)}, window starts ${window.start}`;
      if (warningReason) {
        warningCount += 1;
        warnings.push(warningReason);
      }
      rows.push({ stop, order, arrival, depart: current, warning: Boolean(warningReason), warningReason });
      previousStop = stop;
      previousOrder = order;
      continue;
    }
    const missingPickupLocations = requiredPickupLocations(order).filter((location) => !pickedLocations.has(String(location)));
    const arrival = current;
    const dropFootprint = dropFootprintPallets(order, stop);
    const dropWeight = dropWeightLbs(order, stop);
    current += truckStopMinutes(truck, stopServiceType(stop, order), dropFootprint);
    palletTotal += dropPallets(order, stop);
    footprintTotal += dropFootprint;
    processedWeightLbs += dropWeight;
    if (onboardOrderIds.has(order.id)) {
      currentWeightLbs = Math.max(0, currentWeightLbs - dropWeight);
      const remainingDrops = Math.max(Number(remainingDropCounts.get(String(order.id)) || 1) - 1, 0);
      remainingDropCounts.set(String(order.id), remainingDrops);
      if (!remainingDrops) {
        onboardOrderIds.delete(order.id);
        droppedOrderIds.add(order.id);
      }
    }
    travelTotal += Number(routeLegMinutes[Math.max(routeLegIndex - 1, 0)] ?? order.travelMinutes ?? 0);
    let warningReason = "";
    const window = stopTimeWindow(stop, order);
    const hasTimeWindow = Boolean(window.start && window.end);
    if (missingPickupLocations.length) warningReason = `${order.id}: pickup ${missingPickupLocations.join(", ")} before drop.`;
    else if (window.closed) warningReason = `${order.id} ${stop.type} location closed on ${window.label || planWeekdayName()}.`;
    else if (hasTimeWindow && arrival > minutes(window.end)) warningReason = `${order.id} ${stop.type} late: arrives ${timeText(arrival)}, window ends ${window.end}`;
    else if (hasTimeWindow && arrival < minutes(window.start) - 45) warningReason = `${order.id} ${stop.type} early: arrives ${timeText(arrival)}, window starts ${window.start}`;
    if (warningReason) {
      warningCount += 1;
      warnings.push(warningReason);
    }
    rows.push({ stop, order, arrival, depart: current, warning: Boolean(warningReason), warningReason });
    previousStop = stop;
    previousOrder = order;
  }
  for (const warning of sequenceWarnings) {
    if (!warnings.includes(warning)) {
      warningCount += 1;
      warnings.push(warning);
    }
  }

  const returnTrip = Math.max(22, Math.round(travelTotal / Math.max(load.stops.filter((stop) => stop.type === "drop").length, 1) * 0.8));
  const capacityLbs = truckCapacityLbs(truck);
  const weightTotalLbs = Math.max(peakWeightLbs, explicitPickCount ? 0 : processedWeightLbs);
  const fullLoad = weightTotalLbs >= capacityLbs;
  const capacityWarning = weightTotalLbs > capacityLbs;
  if (capacityWarning) {
    warningCount += 1;
    warnings.push(`Over capacity: ${formatLbs(weightTotalLbs)} peak onboard, truck capacity ${formatLbs(capacityLbs)}`);
  }
  return {
    rows,
    startTravel: resolvedStartTravel,
    palletTotal,
    footprintTotal,
    weightTotalLbs,
    processedWeightLbs,
    capacityLbs,
    start,
    finish: current,
    returnTrip,
    warningCount,
    warnings,
    capacityWarning,
    fullLoad,
    restBefore: startInfo.restBefore,
    switchBefore: startInfo.switchBefore,
    switchMinutes: startInfo.switchMinutes,
    handoffTravel: startInfo.handoffTravel,
    handoffMinutes: startInfo.handoffMinutes,
    handoffStart: startInfo.handoffStart,
    handoffFinish: startInfo.handoffFinish,
    switchStart: startInfo.switchStart,
    previousFinish: startInfo.previousFinish,
    scheduledStart: startInfo.scheduledStart,
    startClamped: startInfo.startClamped
  };
}

function loadHasPlanningContentForAssignment(load) {
  return Boolean(load?.returnOnly || (load?.stops || []).length || (load?.orders || []).length);
}

function localDispatchLoadAssignmentConflict() {
  if (!driverOrientedPlanningEnabled()) return null;
  const rows = [];
  for (const truck of trucks) {
    for (const load of truck.loads || []) {
      if (!loadHasPlanningContentForAssignment(load)) continue;
      const stats = loadStats(truck, load);
      const driverLogin = loadDriverKey(truck, load);
      const truckPlate = loadTruckPlate(truck, load);
      if (!driverLogin || !truckPlate) continue;
      rows.push({
        truck,
        load,
        driverLogin,
        driverName: loadDriver(truck, load)?.name || load.driverName || driverLogin,
        truckPlate,
        start: Number(stats.start),
        finish: Number(stats.finish),
        switchBefore: Boolean(stats.switchBefore),
        switchMinutes: Number(stats.switchMinutes || 0),
        handoffTravel: stats.handoffTravel,
        handoffStart: Number(stats.handoffStart || 0),
        handoffFinish: Number(stats.handoffFinish || 0)
      });
    }
  }

  const byDriver = new Map();
  for (const row of rows) {
    if (!byDriver.has(row.driverLogin)) byDriver.set(row.driverLogin, []);
    byDriver.get(row.driverLogin).push(row);
  }
  for (const driverRows of byDriver.values()) {
    driverRows.sort((left, right) => left.start - right.start || Number(left.load.driverSequence || 0) - Number(right.load.driverSequence || 0));
    for (let index = 1; index < driverRows.length; index += 1) {
      const previous = driverRows[index - 1];
      const current = driverRows[index];
      if (previous.finish > current.start) {
        return {
          code: "DISPATCH_DRIVER_TIME_CONFLICT",
          message: `${current.driverName} cannot operate ${previous.load.name} and ${current.load.name} at overlapping times.`
        };
      }
    }
  }

  const byTruck = new Map();
  for (const row of rows) {
    const occupancyStart = row.switchBefore ? row.start - row.switchMinutes : row.start;
    const occupancy = { ...row, occupancyStart };
    if (!byTruck.has(row.truckPlate)) byTruck.set(row.truckPlate, []);
    byTruck.get(row.truckPlate).push(occupancy);
    const previousEntry = row.handoffTravel?.previousEntry;
    const previousPlate = previousEntry ? loadTruckPlate(previousEntry.truck, previousEntry.load) : "";
    if (previousPlate && row.handoffFinish > row.handoffStart) {
      if (!byTruck.has(previousPlate)) byTruck.set(previousPlate, []);
      byTruck.get(previousPlate).push({
        ...row,
        truckPlate: previousPlate,
        occupancyStart: row.handoffStart,
        finish: row.handoffFinish,
        handoffOccupancy: true
      });
    }
  }
  for (const truckRows of byTruck.values()) {
    truckRows.sort((left, right) => left.occupancyStart - right.occupancyStart || left.finish - right.finish);
    for (let index = 1; index < truckRows.length; index += 1) {
      const previous = truckRows[index - 1];
      const current = truckRows[index];
      if (previous.occupancyStart < current.finish && current.occupancyStart < previous.finish) {
        return {
          code: "DISPATCH_TRUCK_OCCUPANCY_CONFLICT",
          message: `${current.truckPlate} is already occupied by ${previous.driverName} ${previous.load.name} from ${timeText(previous.occupancyStart)} to ${timeText(previous.finish)}. It cannot also run ${current.driverName} ${current.load.name} from ${timeText(current.occupancyStart)} to ${timeText(current.finish)}.`
        };
      }
    }
  }
  return null;
}

function addLocalAssignmentAdvisory(target, loadId, code, message) {
  const key = String(loadId || "");
  if (!key || !message) return;
  const entries = target.get(key) || [];
  if (!entries.some((entry) => entry.code === code && entry.message === message)) {
    entries.push({ code, message });
    target.set(key, entries);
  }
}

function buildLocalAssignmentAdvisories() {
  const advisories = new Map();
  if (!driverOrientedPlanningEnabled()) return advisories;
  const rows = [];
  for (const truck of trucks) {
    for (const load of truck.loads || []) {
      if (!loadHasPlanningContentForAssignment(load)) continue;
      const stats = loadStats(truck, load);
      rows.push({
        truck,
        load,
        driverLogin: loadDriverKey(truck, load),
        driverName: loadDriver(truck, load)?.name || load.driverName || loadDriverKey(truck, load),
        truckPlate: loadTruckPlate(truck, load),
        start: Number(stats.start),
        finish: Number(stats.finish)
      });
    }
  }

  const byDriver = new Map();
  for (const row of rows) {
    if (!row.driverLogin) continue;
    if (!byDriver.has(row.driverLogin)) byDriver.set(row.driverLogin, []);
    byDriver.get(row.driverLogin).push(row);
  }
  for (const driverRows of byDriver.values()) {
    driverRows.sort((left, right) => left.start - right.start || Number(left.load.driverSequence || 0) - Number(right.load.driverSequence || 0));
    for (let index = 1; index < driverRows.length; index += 1) {
      const previous = driverRows[index - 1];
      const current = driverRows[index];
      if (previous.truckPlate === current.truckPlate) continue;
      const switchYard = loadSwitchYard(current.truck, current.load);
      const previousEndYard = loadEndOwnYard(previous.load);
      const handoffTravel = switchApproachTravelForLoad(current.truck, current.load);
      if (!handoffTravel && previousEndYard && previousEndYard !== switchYard) {
        addLocalAssignmentAdvisory(
          advisories,
          current.load.id,
          "DRIVER_SWITCH_YARD_MISMATCH",
          `${current.driverName} finishes at ${previousEndYard}, but this switch is set for ${switchYard}.`
        );
      }
    }
  }

  const byTruck = new Map();
  for (const row of rows) {
    if (!row.truckPlate) continue;
    if (!byTruck.has(row.truckPlate)) byTruck.set(row.truckPlate, []);
    byTruck.get(row.truckPlate).push(row);
  }
  for (const truckRows of byTruck.values()) {
    truckRows.sort((left, right) => left.start - right.start || left.finish - right.finish);
    const first = truckRows[0];
    const firstSwitchYard = loadSwitchYard(first.truck, first.load);
    const configuredStartYard = String(first.truck?.base || "").trim();
    if (!configuredStartYard) {
      addLocalAssignmentAdvisory(
        advisories,
        first.load.id,
        "TRUCK_LOCATION_UNKNOWN",
        `${first.truckPlate} starting location is unknown. This plan assumes it is available at ${firstSwitchYard}; verify or set its starting yard for this date.`
      );
    } else if (configuredStartYard !== firstSwitchYard) {
      addLocalAssignmentAdvisory(
        advisories,
        first.load.id,
        "TRUCK_REPOSITION_REQUIRED",
        `${first.truckPlate} starts at ${configuredStartYard} but this load starts at ${firstSwitchYard}. Allow time to reposition it.`
      );
    }
    for (let index = 1; index < truckRows.length; index += 1) {
      const previous = truckRows[index - 1];
      const current = truckRows[index];
      if (previous.driverLogin === current.driverLogin) continue;
      const handoffYard = loadSwitchYard(current.truck, current.load);
      const previousEndYard = loadEndOwnYard(previous.load);
      if (!previousEndYard || previousEndYard !== handoffYard) {
        addLocalAssignmentAdvisory(
          advisories,
          current.load.id,
          "TRUCK_HANDOFF_REPOSITION_REQUIRED",
          `${current.truckPlate} must be returned to ${handoffYard} before ${current.driverName} can take it${previousEndYard ? ` from ${previousEndYard}` : ""}.`
        );
      }
    }
  }
  return advisories;
}

function boardStats() {
  let planned = 0;
  let warnings = 0;
  let stops = 0;
  for (const truck of trucks) {
    for (const load of truck.loads) {
      const stats = loadStats(truck, load);
      planned += load.stops.filter((stop) => stop.type === "drop").length;
      stops += load.stops.length;
      warnings += stats.warningCount;
    }
  }
  warnings += [...assignmentAdvisoryByLoad.values()].reduce((total, entries) => total + entries.length, 0);
  return { planned, warnings, stops, open: openOrders().length };
}

function syncReturnLoads() {
  for (const truck of trucks) {
    for (let index = truck.loads.length - 1; index >= 0; index -= 1) {
      const load = truck.loads[index];
      if (!load.returnOnly || load.manual) continue;
      const previous = truck.loads[index - 1];
      const previousHasDrop = previous?.stops?.some((stop) => stop.type === "drop");
      if (!previous || previous.returnOnly || !previousHasDrop) {
        truck.loads.splice(index, 1);
      }
    }
  }
  if (!findLoad(selectedLoadId).load) selectedLoadId = trucks[0]?.loads[0]?.id || "";
}

function opaqueDispatchStopId() {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  return randomUuid
    ? `stop-${randomUuid}`
    : `stop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function makePickupStop(load, order, location) {
  return {
    id: opaqueDispatchStopId(),
    loadId: load.id,
    orderId: order.id,
    type: "pick",
    location
  };
}

function ensurePickupStops(load, order, insertIndex = null) {
  let added = 0;
  for (const location of requiredPickupLocations(order)) {
    const exists = load.stops.some((stop) => stop.type === "pick" && String(stop.location) === String(location));
    if (exists) continue;
    const stop = makePickupStop(load, order, location);
    if (Number.isInteger(insertIndex)) {
      load.stops.splice(insertIndex + added, 0, stop);
      added += 1;
    } else {
      load.stops.push(stop);
    }
  }
  return added;
}

function isScmGroupedPoOrder(order = {}) {
  return order?.type === "PO"
    && String(order?.id || "").toUpperCase().startsWith("PGOB-")
    && Array.isArray(order.childOrders)
    && order.childOrders.length > 0;
}

function addScmGroupedPoToLoad(order, loadId, insertIndex = null) {
  const { truck, load } = findLoad(loadId);
  if (!truck || !load || !isScmGroupedPoOrder(order)) return false;
  const childOrders = order.childOrders
    .map((childId) => orderById(childId))
    .filter(Boolean);
  if (childOrders.length !== order.childOrders.length) {
    const missing = order.childOrders.filter((childId) => !orderById(childId));
    selectedOrderId = order.id;
    selectedOrderIds = new Set([order.id]);
    routeNotice = `${order.id} cannot be planned because child PO ${missing.join(", ")} is missing from the order feed.`;
    return false;
  }
  const beforeStops = (load.stops || []).map((stop) => ({ ...stop }));
  const beforeNotice = routeNotice;
  let nextInsertIndex = Number.isInteger(insertIndex) ? insertIndex : null;
  for (const child of childOrders) {
    const beforeLength = load.stops.length;
    const added = addOrderToLoad(child.id, loadId, "drop", "", nextInsertIndex);
    if (!added) {
      load.stops = beforeStops;
      selectedOrderId = order.id;
      selectedOrderIds = new Set([order.id]);
      routeNotice = routeNotice || `${order.id} cannot be planned because ${child.id} could not be added.`;
      return false;
    }
    if (Number.isInteger(nextInsertIndex)) {
      nextInsertIndex += Math.max(load.stops.length - beforeLength, 1);
    }
  }
  selectedOrderId = order.id;
  selectedOrderIds = new Set([order.id]);
  selectedLoadId = loadId;
  routeNotice = beforeNotice;
  return true;
}

function syncPickupStops() {
  for (const truck of trucks) {
    for (const load of truck.loads) {
      if (load.returnOnly) continue;
      for (let index = 0; index < load.stops.length; index += 1) {
        const stop = load.stops[index];
        if (stop.type !== "drop") continue;
        const order = stopOrder(stop);
        if (order) {
          const added = ensurePickupStops(load, order, index);
          index += added;
        }
      }
    }
  }
}

function collapseGroupedOrderStops() {
  const groupsById = new Map();
  const groupsByMemberRef = new Map();
  for (const order of orders || []) {
    if (!order?.childOrders?.length || isScmGroupedPoOrder(order)) continue;
    groupsById.set(String(order.id), order);
    for (const ref of dispatchGroupingRefs(order)) {
      if (ref !== String(order.id)) groupsByMemberRef.set(ref, order);
    }
  }
  if (!groupsById.size) return;

  for (const truck of trucks) {
    for (const load of truck.loads || []) {
      if (load.returnOnly) continue;
      const seenDropGroups = new Set();
      const nextStops = [];
      for (const stop of load.stops || []) {
        const stopOrderId = String(stop.orderId || "");
        const group = groupsById.get(stopOrderId) || groupsByMemberRef.get(stopOrderId);
        if (!group) {
          nextStops.push(stop);
          continue;
        }
        if (stop.type === "drop") {
          if (seenDropGroups.has(group.id)) continue;
          seenDropGroups.add(group.id);
        }
        nextStops.push(stopOrderId === String(group.id)
          ? stop
          : { ...stop, orderId: group.id, location: stop.type === "drop" ? (group.address || stop.location || "") : stop.location });
      }
      load.stops = nextStops;
    }
  }
}

function cleanupOrphanPickupStops() {
  for (const truck of trucks) {
    for (const load of truck.loads) {
      if (load.returnOnly) continue;
      load.stops = load.stops.filter((stop) => stop.type !== "drop" || Boolean(stopOrder(stop)));
      const needed = new Set();
      for (const stop of load.stops) {
        if (stop.type !== "drop") continue;
        const order = stopOrder(stop);
        if (!order) continue;
        for (const location of requiredPickupLocations(order)) needed.add(String(location));
      }
      load.stops = load.stops.filter((stop) => stop.type !== "pick" || needed.has(String(stop.location)));
    }
  }
}

function expandScmGroupedPoStops() {
  for (const truck of trucks) {
    for (const load of truck.loads || []) {
      if (load.returnOnly) continue;
      const nextStops = [];
      const existingDropIds = new Set((load.stops || [])
        .filter((stop) => stop.type === "drop")
        .map((stop) => String(stop.orderId || "")));
      for (const stop of load.stops || []) {
        const stopOrderRecord = orderById(stop.orderId);
        if (stop.type === "pick" && isScmGroupedPoOrder(stopOrderRecord)) {
          const firstChild = (stopOrderRecord.childOrders || []).map((childId) => orderById(childId)).find(Boolean);
          nextStops.push(firstChild ? { ...stop, orderId: firstChild.id } : stop);
          continue;
        }
        const order = stop.type === "drop" ? stopOrderRecord : null;
        if (!isScmGroupedPoOrder(order)) {
          nextStops.push(stop);
          continue;
        }
        const children = (order.childOrders || [])
          .map((childId) => orderById(childId))
          .filter(Boolean);
        if (children.length !== order.childOrders.length) {
          nextStops.push(stop);
          continue;
        }
        for (const child of children) {
          if (existingDropIds.has(String(child.id))) continue;
          nextStops.push({
            ...stop,
            id: `${stop.id}-${child.id}`,
            orderId: child.id,
            location: child.pickupLocations?.[0] || stop.location || ""
          });
          existingDropIds.add(String(child.id));
        }
      }
      load.stops = nextStops;
    }
  }
}

function selectedOrder() {
  return orderById(selectedOrderId) || orders[0];
}

function loadIndexInTruck(truck, load) {
  return truck?.loads?.findIndex((item) => item.id === load?.id) ?? -1;
}

function renumberTruckLoads(truck) {
  if (driverOrientedPlanningEnabled()) {
    const byDriver = new Map();
    for (const parentTruck of trucks) {
      for (const load of parentTruck.loads || []) {
        const login = loadDriverKey(parentTruck, load);
        if (!byDriver.has(login)) byDriver.set(login, []);
        byDriver.get(login).push({ truck: parentTruck, load });
      }
    }
    for (const entries of byDriver.values()) {
      entries.sort((left, right) =>
        Number(left.load.driverSequence || 0) - Number(right.load.driverSequence || 0)
          || minutes(left.load.start || left.truck.start || DEFAULT_FIRST_LOAD_START) - minutes(right.load.start || right.truck.start || DEFAULT_FIRST_LOAD_START)
      );
      let number = 1;
      for (const entry of entries) {
        if (entry.load.returnOnly) {
          entry.load.name = entry.load.name || "Return Load";
          continue;
        }
        entry.load.name = `Load ${number}`;
        number += 1;
      }
    }
    return;
  }
  let number = 1;
  for (const load of truck?.loads || []) {
    if (load.returnOnly) {
      load.name = load.name || "Return Load";
      continue;
    }
    load.name = `Load ${number}`;
    number += 1;
  }
}

function insertIndexForLoadButton(truck, button) {
  if (!truck) return -1;
  const afterLoadId = button?.dataset?.afterLoad;
  if (!afterLoadId) {
    const selectedIndex = truck.loads.findIndex((load) => load.id === selectedLoadId);
    return selectedIndex >= 0 ? selectedIndex + 1 : truck.loads.length;
  }
  const afterIndex = truck.loads.findIndex((load) => load.id === afterLoadId);
  return afterIndex >= 0 ? afterIndex + 1 : truck.loads.length;
}

function newLoadStartFields(truck, driver = null) {
  const hasPrevious = driverOrientedPlanningEnabled()
    ? driverLoadEntries(driver ? driverKey(driver) : "").length > 0
    : (truck?.loads || []).length > 0;
  return hasPrevious
    ? { startMode: "auto", start: "" }
    : { startMode: "fixed", start: DEFAULT_FIRST_LOAD_START };
}

function addLoadToTruck(truck, insertIndex = truck?.loads?.length || 0, assignedDriver = null) {
  const driver = assignedDriver || truckDriver(truck);
  const sequence = nextDriverSequence(driver ? driverKey(driver) : "");
  const load = { id: `${truck.id}-L${Date.now()}-${Math.random().toString(16).slice(2)}`, name: "Load", stops: [], ...newLoadStartFields(truck, driver) };
  assignLoadFields(truck, load, { driver, sequence });
  truck.loads.splice(Math.max(0, Math.min(insertIndex, truck.loads.length)), 0, load);
  renumberTruckLoads(truck);
  return load;
}

function addReturnLoadToTruck(truck, insertIndex = truck?.loads?.length || 0, assignedDriver = null) {
  const driver = assignedDriver || truckDriver(truck);
  const sequence = nextDriverSequence(driver ? driverKey(driver) : "");
  const load = { id: `${truck.id}-MR${Date.now()}-${Math.random().toString(16).slice(2)}`, name: "Return Load", returnOnly: true, manual: true, returnYard: "12441", stops: [], ...newLoadStartFields(truck, driver) };
  assignLoadFields(truck, load, { driver, sequence });
  truck.loads.splice(Math.max(0, Math.min(insertIndex, truck.loads.length)), 0, load);
  renumberTruckLoads(truck);
  return load;
}

function defaultTruckForDriver(driverLogin) {
  const entries = driverLoadEntries(driverLogin);
  const previous = entries.at(-1);
  const preferredTruckId = driverNewTruckSelections.get(String(driverLogin || "").toLowerCase()) || "";
  if (preferredTruckId) {
    const selected = trucks.find((truck) => String(truck.id || "") === String(preferredTruckId));
    if (selected) return selected;
  }
  const previousPlate = previous?.load?.truckPlate || previous?.truck?.plate || "";
  if (!previousPlate) return null;
  return trucks.find((truck) => normalizedTruckPlate(truck.plate) === normalizedTruckPlate(previousPlate)) || null;
}

function driverEntryTimingSnapshot() {
  return new Map(driverLoadEntries().map((entry) => {
    const stats = loadStats(entry.truck, entry.load);
    return [entry.load.id, {
      start: Number(stats.start),
      duration: Math.max(1, Number(stats.finish) - Number(stats.start))
    }];
  }));
}

function reflowDriverLaneEntries(driverLogin, orderedEntries, timingByLoad, movedLoadId = "") {
  const login = String(driverLogin || "").trim().toLowerCase();
  const entries = (orderedEntries || []).filter((entry) => entry?.load);
  if (!login) {
    entries.forEach((entry, index) => {
      assignLoadToDriver(entry.truck, entry.load, "", { append: false });
      entry.load.driverSequence = index;
    });
    return;
  }
  const firstExisting = entries.find((entry) => entry.load.id !== movedLoadId) || entries[0];
  const laneStart = timingByLoad.get(firstExisting?.load?.id)?.start
    ?? timingByLoad.get(entries[0]?.load?.id)?.start
    ?? minutes(DEFAULT_FIRST_LOAD_START);
  let previous = null;
  let previousFinish = laneStart;
  for (const [index, entry] of entries.entries()) {
    const timing = timingByLoad.get(entry.load.id) || { start: laneStart, duration: 30 };
    assignLoadToDriver(entry.truck, entry.load, login, { append: false });
    entry.load.driverSequence = index;
    const startMode = resolvedLoadStartMode(entry.load);
    const fixedStart = normalizeTypedDispatchTime(entry.load.start);
    let start = startMode === "fixed" ? minutes(fixedStart || timeText(timing.start)) : (index === 0 ? laneStart : Number(timing.start));
    if (previous) {
      const changedTruck = loadTruckPlate(previous.truck, previous.load) !== loadTruckPlate(entry.truck, entry.load);
      const switchMinutes = changedTruck ? Math.max(0, Number(dispatchPlanningSettings.truckSwitchMinutes ?? 10)) : 0;
      if (changedTruck) {
        const handoffYard = loadEndOwnYard(previous.load);
        if (handoffYard) entry.load.switchYard = handoffYard;
      }
      const switchYard = loadSwitchYard(entry.truck, entry.load);
      const previousEndYard = loadEndOwnYard(previous.load);
      const previousPoint = startPointAfterLoad(previous.truck, previous.load);
      const handoffMinutes = changedTruck && previousPoint && previousEndYard !== switchYard
        ? adjustedTravelMinutesForTruck(
          effectiveTruckForLoad(previous.truck, previous.load),
          travelMinutesBetweenPoints(previousPoint, switchYard)
        )
        : 0;
      const earliest = previousFinish + handoffMinutes + switchMinutes;
      if (startMode === "auto" || entry.load.id === movedLoadId || start < earliest) start = earliest;
    }
    entry.load.startMode = startMode;
    entry.load.start = startMode === "auto" ? "" : timeText(start);
    previousFinish = start + Math.max(1, Number(timing.duration || 30));
    previous = entry;
  }
}

function moveLoadToDriverLane(loadId, targetDriverLogin, { targetLoadId = "", insertAfter = false } = {}) {
  const found = findLoad(loadId);
  if (!found.load || !found.truck) return null;
  const timingByLoad = driverEntryTimingSnapshot();
  const sourceLogin = loadDriverKey(found.truck, found.load);
  const targetLogin = String(targetDriverLogin || "").trim().toLowerCase();
  const sourceEntries = driverLoadEntries(sourceLogin).filter((entry) => entry.load.id !== found.load.id);
  const targetEntries = sourceLogin === targetLogin
    ? [...sourceEntries]
    : driverLoadEntries(targetLogin).filter((entry) => entry.load.id !== found.load.id);
  let insertIndex = targetEntries.length;
  const targetIndex = targetEntries.findIndex((entry) => entry.load.id === targetLoadId);
  if (targetIndex >= 0) insertIndex = targetIndex + (insertAfter ? 1 : 0);
  const movedEntry = { ...found, driverLogin: targetLogin, driver: driverByKey(targetLogin) };
  targetEntries.splice(Math.max(0, Math.min(insertIndex, targetEntries.length)), 0, movedEntry);

  if (sourceLogin !== targetLogin) {
    sourceEntries.forEach((entry, index) => {
      entry.load.driverSequence = index;
    });
  }
  reflowDriverLaneEntries(targetLogin, targetEntries, timingByLoad, found.load.id);
  return { ...found, sourceLogin, targetLogin, targetEntries };
}

function moveLoadToPhysicalTruck(loadId, targetTruckId) {
  const source = findLoad(loadId);
  const targetTruck = trucks.find((truck) => String(truck.id) === String(targetTruckId));
  if (!source.load || !source.truck || !targetTruck) return null;
  if (source.truck.id !== targetTruck.id) {
    source.truck.loads = source.truck.loads.filter((item) => item.id !== source.load.id);
    targetTruck.loads.push(source.load);
    renumberTruckLoads(source.truck);
    renumberTruckLoads(targetTruck);
  }
  source.load.truckId = String(targetTruck.id || "");
  source.load.truckPlate = String(targetTruck.plate || "").toUpperCase();
  source.load.parkingSpot = targetTruck.parkingSpot || source.load.parkingSpot || "";
  return { truck: targetTruck, load: source.load, previousTruck: source.truck };
}

function assignLoadToDriver(truck, load, driverLogin, { append = true } = {}) {
  const driver = driverByKey(driverLogin);
  load.driverLogin = driver ? driverKey(driver) : "";
  load.driverName = driver?.name || "";
  if (append) load.driverSequence = nextDriverSequence(load.driverLogin);
  renumberTruckLoads(truck);
  return load;
}

function loadStartMinutes(truck, load) {
  return loadStartInfo(truck, load).start;
}

function switchApproachTravelForLoad(truck, load) {
  if (!driverOrientedPlanningEnabled() || !load) return null;
  const previousEntry = previousDriverLoad(truck, load);
  if (!previousEntry) return null;
  const previousPlate = loadTruckPlate(previousEntry.truck, previousEntry.load);
  const nextPlate = loadTruckPlate(truck, load);
  if (!previousPlate || !nextPlate || previousPlate === nextPlate) return null;

  const switchYard = loadSwitchYard(truck, load);
  const previousOwnYard = loadEndOwnYard(previousEntry.load);
  if (previousOwnYard && previousOwnYard === switchYard) return null;
  const from = startPointAfterLoad(previousEntry.truck, previousEntry.load);
  if (!from) return null;
  const switchPlace = placeForLocation(switchYard);
  const toAddress = switchPlace?.address || hubAddress(switchYard);
  if (samePhysicalAddress(from.routeLocation || from.address || from.label, toAddress || switchYard)) return null;

  const previousTruck = effectiveTruckForLoad(previousEntry.truck, previousEntry.load);
  return {
    from: from.label || from.address || "Previous stop",
    fromJobLocation: from.jobLabel || from.label || from.address || "Previous stop",
    fromAddress: from.address || String(from.label || ""),
    fromPosition: from.position,
    fromRouteLocation: from.routeLocation || from.address || from.position,
    to: switchYard,
    toAddress,
    toPosition: placePosition(switchPlace) || hubPosition(switchYard),
    toRouteLocation: toAddress || placePosition(switchPlace) || hubPosition(switchYard),
    minutes: adjustedTravelMinutesForTruck(previousTruck, travelMinutesBetweenPoints(from, switchYard)),
    previousEntry
  };
}

function loadStartInfo(truck, load) {
  if (driverOrientedPlanningEnabled()) {
    const previousEntry = previousDriverLoad(truck, load);
    const assignedTruck = effectiveTruckForLoad(truck, load);
    const startMode = resolvedLoadStartMode(load);
    if (!previousEntry) {
      const fixedStart = normalizeTypedDispatchTime(load?.start);
      const start = minutes(startMode === "fixed" ? (fixedStart || DEFAULT_FIRST_LOAD_START) : (assignedTruck?.start || DEFAULT_FIRST_LOAD_START));
      return {
        startMode,
        start,
        scheduledStart: start,
        previousFinish: null,
        restBefore: 0,
        switchBefore: false,
        switchMinutes: 0,
        startClamped: false
      };
    }
    const previousFinish = loadStats(previousEntry.truck, previousEntry.load).finish;
    const previousPlate = loadTruckPlate(previousEntry.truck, previousEntry.load);
    const nextPlate = loadTruckPlate(truck, load);
    const switchBefore = Boolean(previousPlate && nextPlate && previousPlate !== nextPlate);
    const switchMinutes = switchBefore ? Math.max(0, Number(dispatchPlanningSettings.truckSwitchMinutes ?? 10)) : 0;
    const handoffTravel = switchBefore ? switchApproachTravelForLoad(truck, load) : null;
    const estimatedHandoffMinutes = handoffTravel
      ? Number(routeLegMinutesForLoad(load)[0] ?? handoffTravel.minutes)
      : 0;
    const handoffMinutes = Math.max(0, Math.round(Number.isFinite(estimatedHandoffMinutes) ? estimatedHandoffMinutes : 0));
    const earliestStart = previousFinish + handoffMinutes + switchMinutes;
    const fixedStart = normalizeTypedDispatchTime(load?.start);
    const scheduledStart = startMode === "fixed" ? minutes(fixedStart || timeText(earliestStart)) : earliestStart;
    const start = Math.max(earliestStart, scheduledStart);
    const restBefore = Math.max(0, scheduledStart - earliestStart);
    const handoffStart = previousFinish + restBefore;
    const handoffFinish = handoffStart + handoffMinutes;
    return {
      startMode,
      start,
      scheduledStart,
      previousFinish,
      restBefore,
      switchBefore,
      switchMinutes,
      handoffTravel: handoffTravel ? { ...handoffTravel, minutes: handoffMinutes } : null,
      handoffMinutes,
      handoffStart,
      handoffFinish,
      switchStart: handoffFinish,
      startClamped: startMode === "fixed" && scheduledStart < earliestStart
    };
  }
  const startMode = resolvedLoadStartMode(load);
  const index = loadIndexInTruck(truck, load);
  if (index <= 0) {
    const fixedStart = normalizeTypedDispatchTime(load?.start);
    const start = minutes(startMode === "fixed" ? (fixedStart || DEFAULT_FIRST_LOAD_START) : DEFAULT_FIRST_LOAD_START);
    return { startMode, start, scheduledStart: start, previousFinish: null, restBefore: 0, startClamped: false };
  }
  const previous = truck.loads[index - 1];
  const previousFinish = loadStats(truck, previous).finish;
  const fixedStart = normalizeTypedDispatchTime(load?.start);
  const scheduledStart = startMode === "fixed" ? minutes(fixedStart || timeText(previousFinish)) : previousFinish;
  const start = Math.max(previousFinish, scheduledStart);
  return {
    startMode,
    start,
    scheduledStart,
    previousFinish,
    restBefore: Math.max(0, scheduledStart - previousFinish),
    startClamped: startMode === "fixed" && scheduledStart < previousFinish
  };
}

function startPointAfterLoad(truck, load) {
  if (!load) return null;
  if (load.returnOnly) {
    const yard = load.returnYard || "12441";
    const place = placeForLocation(yard);
    return {
      label: yard,
      jobLabel: yard,
      address: place?.address || hubAddress(yard),
      position: placePosition(place) || hubPosition(yard),
      routeLocation: place?.address || hubAddress(yard),
      isHub: Boolean(place?.kind === "own")
    };
  }
  const stop = lastRoutedStop(load);
  const order = stop ? stopOrder(stop) : null;
  if (!stop) return null;
  const place = resolveStopPlace(stop, order);
  return {
    label: stop.type === "pick" ? pickupStopLabel(stop, order) : (order?.id || "Previous stop"),
    jobLabel: stop.type === "pick" ? String(stop.location || "") : (order?.id || "Previous stop"),
    address: place.address,
    position: { lat: place.lat, lng: place.lng },
    routeLocation: place.routeLocation,
    isHub: place.kind === "own"
  };
}

function travelMinutesBetweenPoints(from, toYard) {
  const toPlace = placeForLocation(toYard);
  if (from?.isHub && from.label && toPlace?.kind === "own") return yardTravelMinutes(from.label, toPlace.key);
  return 30;
}

function startTravelForLoad(truck, load) {
  if (load?.returnOnly) return null;
  const firstPickup = load.stops.find((stop) => stop.type === "pick");
  if (!firstPickup?.location) return null;
  const firstPickupOrder = stopOrder(firstPickup);
  const pickupPlace = resolveStopPlace(firstPickup, firstPickupOrder);
  const pickupAddress = pickupPlace.address;
  const pickupLabel = pickupStopLabel(firstPickup, firstPickupOrder);
  const pickupKey = pickupPlace.key || pickupLabel;
  const assignedTruck = effectiveTruckForLoad(truck, load);
  if (driverOrientedPlanningEnabled()) {
    const previousEntry = previousDriverLoad(truck, load);
    let from = null;
    if (previousEntry) {
      const previousPlate = loadTruckPlate(previousEntry.truck, previousEntry.load);
      if (previousPlate !== assignedTruck.plate) {
        const switchYard = loadSwitchYard(truck, load);
        const switchPlace = placeForLocation(switchYard);
        from = {
          label: switchYard,
          jobLabel: switchYard,
          address: switchPlace?.address || hubAddress(switchYard),
          position: placePosition(switchPlace) || hubPosition(switchYard),
          routeLocation: switchPlace?.address || hubAddress(switchYard),
          isHub: true
        };
      } else {
        from = startPointAfterLoad(previousEntry.truck, previousEntry.load);
      }
    } else {
      const startYard = loadSwitchYard(truck, load) || assignedTruck.base;
      const startPlace = placeForLocation(startYard);
      from = {
        label: startYard,
        jobLabel: startYard,
        address: startPlace?.address || hubAddress(startYard),
        position: placePosition(startPlace) || hubPosition(startYard),
        routeLocation: startPlace?.address || hubAddress(startYard),
        isHub: true
      };
    }
    if (!from) return null;
    if (samePhysicalAddress(from.routeLocation || from.address, pickupPlace.routeLocation || pickupAddress)) return null;
    return {
      from: from.label || from.address || "Previous stop",
      fromJobLocation: from.jobLabel || from.label || from.address || "Previous stop",
      to: pickupLabel,
      toPickupLocation: String(firstPickup.location || ""),
      address: from.address,
      position: from.position,
      routeLocation: from.routeLocation,
      minutes: travelMinutesBetweenPoints(from, pickupKey)
    };
  }
  const index = loadIndexInTruck(truck, load);
  if (index <= 0) {
    if (!truck?.base) return null;
    const basePlace = placeForLocation(truck.base);
    const baseAddress = basePlace?.address || hubAddress(truck.base);
    if (samePhysicalAddress(baseAddress, pickupPlace.routeLocation || pickupAddress)) return null;
    return {
      from: truck.base,
      fromJobLocation: truck.base,
      to: pickupLabel,
      toPickupLocation: String(firstPickup.location || ""),
      address: baseAddress,
      position: placePosition(basePlace) || hubPosition(truck.base),
      routeLocation: baseAddress,
      minutes: travelMinutesBetweenPoints({
        label: truck.base,
        address: baseAddress,
        position: placePosition(basePlace) || hubPosition(truck.base),
        routeLocation: baseAddress,
        isHub: basePlace?.kind === "own"
      }, pickupKey)
    };
  }
  const previous = truck.loads[index - 1];
  const from = startPointAfterLoad(truck, previous);
  if (!from) return null;
  if (samePhysicalAddress(from.routeLocation || from.address, pickupPlace.routeLocation || pickupAddress)) return null;
  return {
    from: from.label || from.address || "Previous stop",
    fromJobLocation: from.jobLabel || from.label || from.address || "Previous stop",
    to: pickupLabel,
    toPickupLocation: String(firstPickup.location || ""),
    address: from.address,
    position: from.position,
    routeLocation: from.routeLocation,
    minutes: travelMinutesBetweenPoints(from, pickupKey)
  };
}

function yardOptions(selected = "12441", { includeUnknown = false } = {}) {
  const selectedValue = String(selected || (includeUnknown ? "" : "12441"));
  const yards = ownYards.length ? ownYards : [{ code: "12441" }, { code: "3445" }, { code: "2967" }];
  return [
    ...(includeUnknown ? [`<option value="" ${selectedValue ? "" : "selected"}>${t("dispatch.unknownLocation", "Unknown")}</option>`] : []),
    ...yards.map((yard) => {
      const code = String(yard.code || yard.name || "").trim();
      if (!code) return "";
      const label = yard.name && yard.name !== code ? `${code} - ${yard.name}` : code;
      return `<option value="${escapeHtml(code)}" ${selectedValue === code ? "selected" : ""}>${escapeHtml(label)}</option>`;
    })
  ].join("");
}

function previousLoadFor(loadId) {
  if (driverOrientedPlanningEnabled()) {
    const found = findLoad(loadId);
    if (!found.load) return {};
    const previous = previousDriverLoad(found.truck, found.load);
    return previous ? { truck: previous.truck, load: previous.load } : {};
  }
  for (const truck of trucks) {
    const index = truck.loads.findIndex((load) => load.id === loadId);
    if (index > 0) return { truck, load: truck.loads[index - 1] };
  }
  return {};
}

function lastRoutedStop(load) {
  return [...(load?.stops || [])].reverse().find((stop) => stop.type === "drop" || stop.type === "pick");
}

function loadEndOwnYard(load) {
  if (load?.returnOnly) return ownYardForLocation(load.returnYard)?.code || String(load.returnYard || "");
  const stop = lastRoutedStop(load);
  if (!stop) return "";
  if (stop.type === "pick") {
    const place = resolveStopPlace(stop, stopOrder(stop));
    return place.kind === "own" ? String(place.key || "") : "";
  }
  const order = stopOrder(stop);
  return ownYardForLocation(order?.destinationYard || order?.address)?.code || "";
}

function selectedOrders() {
  return [...selectedOrderIds].map(orderById).filter(Boolean);
}

function removeStopsForOrders(orderIds = []) {
  const ids = new Set(orderIds.filter(Boolean));
  if (!ids.size) return [];
  const removed = [];
  for (const truck of trucks) {
    for (const load of truck.loads) {
      const beforeCount = load.stops.length;
      load.stops = load.stops.filter((stop) => {
        const shouldRemove = ids.has(stop.orderId);
        if (shouldRemove) removed.push({ truckId: truck.id, loadId: load.id, stop: summarizeStop(stop) });
        return !shouldRemove;
      });
      if (beforeCount !== load.stops.length) cleanupOrphanPickupStops();
    }
  }
  return removed;
}

function selectedLoad() {
  return findLoad(selectedLoadId);
}

function mapPins() {
  const { truck, load } = selectedLoad();
  const stops = load?.stops || [];
  const pins = [];
  stops.forEach((stop, index) => {
    const order = stopOrder(stop);
    if (!order) return;
    if (stop.type === "pick") {
      const place = resolveStopPlace(stop, order);
      const hub = HUBS[place?.key] || { x: Number(order.x || 50), y: Number(order.y || 50) };
      pins.push({ label: String(index + 1), className: "pick", x: hub.x, y: hub.y });
    } else {
      const destination = dropLocationForStop(stop, order);
      const hub = HUBS[destination];
      if (hub) pins.push({ label: `${index + 1}`, className: "", x: hub.x, y: hub.y });
      else pins.push({ label: `${index + 1}`, className: "", x: order.x, y: order.y });
    }
  });
  return pins;
}

function hubPosition(location) {
  const place = placeForLocation(location);
  if (placePosition(place)) return placePosition(place);
  const hub = HUBS[location] || HUBS["3445"];
  return { lat: hub.lat, lng: hub.lng };
}

function hubAddress(location) {
  return placeForLocation(location)?.address || HUBS[location]?.address || location;
}

function orderPosition(order) {
  if (Number.isFinite(order?.lat) && Number.isFinite(order?.lng)) return { lat: order.lat, lng: order.lng };
  const x = Number(order?.x || 50);
  const y = Number(order?.y || 50);
  return {
    lat: 43.86 - (y / 100) * 0.42,
    lng: -79.92 + (x / 100) * 0.55
  };
}

function placePosition(place) {
  if (!place) return null;
  const lat = Number(place.lat);
  const lng = Number(place.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function fallbackPositionForAddress(address, order) {
  const text = normalizedPlaceKey(address);
  if (text && text === normalizedPlaceKey(order?.address)) return orderPosition(order);
  return MAP_CENTER;
}

function dropLocationForStop(stop = {}, order = {}) {
  return String(stop.dropLocation || dropoffForStop(order, stop)?.destinationYard || order?.destinationYard || "").trim();
}

function dropAddressForStop(stop = {}, order = {}) {
  const location = dropLocationForStop(stop, order);
  return stop.dropAddress
    || dropoffForStop(order, stop)?.address
    || HUBS[location]?.address
    || order?.destinationAddress
    || order?.address
    || location;
}

function dropStopLabel(stop = {}, order = {}) {
  const location = dropLocationForStop(stop, order);
  return location ? `${order?.id || stop.orderId || "Drop"} · ${location}` : order?.id || stop.orderId || "Drop";
}

function resolveStopPlace(stop, order) {
  if (!stop) {
    return {
      kind: "unknown",
      key: "unknown",
      label: "Unknown stop",
      address: "",
      routeLocation: MAP_CENTER,
      lat: MAP_CENTER.lat,
      lng: MAP_CENTER.lng
    };
  }
  if (stop.type === "return") {
    const place = placeForLocation(stop.location) || placeForLocation("12441");
    const position = placePosition(place) || MAP_CENTER;
    return {
      kind: place?.kind || "own",
      key: place?.key || stop.location || "12441",
      label: place?.label || stop.location || "12441",
      address: place?.address || String(stop.location || ""),
      routeLocation: place?.address || position,
      lat: position.lat,
      lng: position.lng
    };
  }
  if (stop.type === "pick") {
    const pickupAddressOverride = String(order?.pickupAddressOverride || "").trim();
    const physicalLocation = pickupAddressOverride || stop.location;
    const place = placeForLocation(physicalLocation, order);
    const address = pickupAddressOverride
      || place?.address
      || order?.sourceAddress
      || (order?.type === "PO" ? "" : order?.address)
      || String(stop.location || "");
    const position = placePosition(place) || fallbackPositionForAddress(address, order);
    return {
      kind: place?.kind || "pickup",
      key: place?.key || String(physicalLocation || address || ""),
      label: place?.label || String(physicalLocation || "Pickup"),
      address,
      routeLocation: address || position,
      lat: position.lat,
      lng: position.lng,
      logicalLocation: String(stop.location || "")
    };
  }
  const destinationYard = dropLocationForStop(stop, order);
  const destinationPlace = destinationYard ? placeForLocation(destinationYard, order) : null;
  const address = dropAddressForStop(stop, order) || destinationPlace?.address || hubAddress("3445");
  const position = placePosition(destinationPlace) || fallbackPositionForAddress(address, order);
  return {
    kind: destinationPlace?.kind || "delivery",
    key: destinationPlace?.key || destinationYard || order?.id || address,
    label: destinationPlace?.label || destinationYard || order?.id || "Drop off",
    address,
    routeLocation: address || position,
    lat: position.lat,
    lng: position.lng
  };
}

function pickupStopLabel(stop, order) {
  const place = resolveStopPlace(stop, order);
  return String(place.label || place.address || stop?.location || "Pickup");
}

function stopIsOwnYard(stop, order) {
  if (stop.type === "pick") return resolveStopPlace(stop, order).kind === "own";
  const destinationYard = dropLocationForStop(stop, order);
  return Boolean(destinationYard && placeForLocation(destinationYard, order)?.kind === "own");
}

function stopServiceType(stop, order) {
  if (stopIsOwnYard(stop, order)) return "own";
  if (stop.type === "pick") return "vendor";
  return "delivery";
}

function stopTimeWindow(stop, order) {
  if (!stop || !order || stopIsOwnYard(stop, order)) return { start: "", end: "" };
  if (stop.type === "pick") return vendorWindowForLocation(order.pickupAddressOverride || stop.location, order);
  if (stop.type === "drop") return { start: order.windowStart || "", end: order.windowEnd || "" };
  return { start: "", end: "" };
}

function stopStayMinutes(stop, order, truck) {
  return truckStopMinutes(truck, stopServiceType(stop, order), stop.type === "drop" ? dropFootprintPallets(order, stop) : orderFootprintPallets(order));
}

function stopPosition(stop, order) {
  const place = resolveStopPlace(stop, order);
  return { lat: place.lat, lng: place.lng };
}

function stopAddress(stop, order) {
  return resolveStopPlace(stop, order).address;
}

function stopRouteLocation(stop) {
  return stop.routeLocation || { lat: stop.lat, lng: stop.lng };
}

function samePhysicalRouteStop(left, right) {
  if (!left || !right) return false;
  if (
    left.kind === "own"
    && right.kind === "own"
    && String(left.placeKey || left.key || "")
    && String(left.placeKey || left.key || "") === String(right.placeKey || right.key || "")
  ) return true;
  return samePhysicalAddress(stopRouteLocation(left), stopRouteLocation(right));
}

function routeLocationForStop(stop, order, position, address) {
  const place = resolveStopPlace(stop, order);
  return place.routeLocation || address || position;
}

function returnYardStayMinutes(load, truck) {
  // A manual return represents travel only. The following load owns any yard service time.
  if (load?.returnOnly && load?.manual) return 0;
  return truckStopMinutes(truck, "own", 0);
}

function routeStayMinutesForLoad(load, stops = []) {
  if (load?.returnOnly && load?.manual) return 0;
  return stops.reduce((sum, stop) => sum + Number(stop.stayMinutes || 0), 0);
}

function mapStopsForLoad(load, truck) {
  const parentTruck = findLoad(load?.id).truck || truck;
  truck = effectiveTruckForLoad(parentTruck, load);
  if (load?.returnOnly) {
    const previousEntry = driverOrientedPlanningEnabled() ? previousDriverLoad(parentTruck, load) : null;
    const changedTruck = previousEntry
      && loadTruckPlate(previousEntry.truck, previousEntry.load) !== loadTruckPlate(parentTruck, load);
    const { load: previousLoad } = previousLoadFor(load.id);
    const previousStop = changedTruck ? null : lastRoutedStop(previousLoad);
    const previousOrder = previousStop ? stopOrder(previousStop) : null;
    const switchYard = loadSwitchYard(parentTruck, load);
    const startPosition = changedTruck
      ? hubPosition(switchYard)
      : previousStop ? stopPosition(previousStop, previousOrder) : hubPosition(truck?.base || "12441");
    const startAddress = changedTruck
      ? hubAddress(switchYard)
      : previousStop ? stopAddress(previousStop, previousOrder) : hubAddress(truck?.base || "12441");
    const returnYard = load.returnYard || "12441";
    return [
      {
        ...startPosition,
        address: startAddress,
        routeLocation: startAddress || startPosition,
        label: "1",
        title: "Start return",
        type: "drop",
        stayMinutes: 0,
        orderId: previousOrder?.id || ""
      },
      {
        ...hubPosition(returnYard),
        address: hubAddress(returnYard),
        routeLocation: hubAddress(returnYard),
        label: "2",
        title: `Return ${returnYard}`,
        type: "pick",
        stayMinutes: returnYardStayMinutes(load, truck),
        orderId: ""
      }
    ];
  }
  const handoffTravel = switchApproachTravelForLoad(parentTruck, load);
  const handoffStops = handoffTravel ? [{
    lat: handoffTravel.fromPosition?.lat,
    lng: handoffTravel.fromPosition?.lng,
    address: handoffTravel.fromAddress,
    routeLocation: handoffTravel.fromRouteLocation || handoffTravel.fromAddress || handoffTravel.fromPosition,
    label: "H",
    title: `Handoff travel from ${handoffTravel.from}`,
    type: "drop",
    stayMinutes: 0,
    orderId: ""
  }] : [];
  const startTravel = startTravelForLoad(parentTruck, load);
  const startPoint = startTravel?.position || (HUBS[startTravel?.from] ? hubPosition(startTravel.from) : MAP_CENTER);
  const startStops = startTravel ? [{
    lat: startPoint.lat,
    lng: startPoint.lng,
    address: startTravel.address || hubAddress(startTravel.from),
    routeLocation: startTravel.routeLocation || startTravel.address || startPoint,
    label: "S",
    title: `Start ${startTravel.from}`,
    type: "pick",
    stayMinutes: 0,
    orderId: ""
  }] : [];
  const routedStops = (load?.stops || []).map((stop, index) => {
    const order = stopOrder(stop);
    if (!order) return null;
    const place = resolveStopPlace(stop, order);
    const position = { lat: place.lat, lng: place.lng };
    const address = place.address;
    const sequence = index + 1 + handoffStops.length + startStops.length;
    return {
      ...position,
      address,
      routeLocation: place.routeLocation || routeLocationForStop(stop, order, position, address),
      kind: place.kind,
      placeKey: place.key,
      label: String(sequence),
      title: stop.type === "pick" ? `${sequence}. Pickup ${pickupStopLabel(stop, order)}` : `${sequence}. Drop ${dropStopLabel(stop, order)}`,
      type: stop.type,
      stayMinutes: stop.type === "pick"
        ? truckStopMinutes(truck, stopServiceType(stop, order), pickupFootprintForLocation(load, stop.location))
        : stopStayMinutes(stop, order, truck),
      orderId: order.id
    };
  }).filter(Boolean);
  return [...handoffStops, ...startStops, ...routedStops];
}

function routeSignature(stops) {
  return stops.map((stop) => [
    stop.type,
    stop.orderId,
    stop.address,
    typeof stop.routeLocation === "string"
      ? stop.routeLocation
      : `${Number(stop.routeLocation?.lat || stop.lat || 0).toFixed(6)},${Number(stop.routeLocation?.lng || stop.lng || 0).toFixed(6)}`,
    stop.title,
    stop.stayMinutes
  ].join("|")).join(">");
}

function boundedPersistedRouteEstimateCache(cache = {}, now = Date.now()) {
  const entries = Object.entries(cache || {})
    .filter(([, entry]) => {
      const savedAt = Date.parse(entry?.savedAt || "");
      return Boolean(entry?.estimate) && Number.isFinite(savedAt) && savedAt <= now + 300000 && now - savedAt <= ROUTE_ESTIMATE_CACHE_MAX_AGE_MS;
    })
    .sort(([, left], [, right]) => String(right.savedAt || "").localeCompare(String(left.savedAt || "")));
  const bounded = {};
  let charCount = 2;
  for (const [id, entry] of entries.slice(0, ROUTE_ESTIMATE_CACHE_LIMIT)) {
    const entryChars = JSON.stringify([id, entry]).length + 1;
    if (charCount + entryChars > ROUTE_ESTIMATE_CACHE_MAX_CHARS) continue;
    bounded[id] = entry;
    charCount += entryChars;
  }
  return bounded;
}

function loadPersistedRouteEstimateCache() {
  try {
    const parsed = JSON.parse(dispatchStorageGet(ROUTE_ESTIMATE_STORAGE_KEY, "{}") || "{}") || {};
    return boundedPersistedRouteEstimateCache(parsed);
  } catch {
    return {};
  }
}

function flushPersistedRouteEstimateCache() {
  window.clearTimeout(persistedRouteEstimateSaveTimer);
  persistedRouteEstimateSaveTimer = null;
  persistedRouteEstimateCache = boundedPersistedRouteEstimateCache(persistedRouteEstimateCache);
  const serialized = JSON.stringify(persistedRouteEstimateCache);
  if (!dispatchStorageSet(ROUTE_ESTIMATE_STORAGE_KEY, serialized)) dispatchStorageRemove(ROUTE_ESTIMATE_STORAGE_KEY);
}

function savePersistedRouteEstimateCache() {
  persistedRouteEstimateCache = boundedPersistedRouteEstimateCache(persistedRouteEstimateCache);
  window.clearTimeout(persistedRouteEstimateSaveTimer);
  persistedRouteEstimateSaveTimer = window.setTimeout(flushPersistedRouteEstimateCache, 500);
}

function routeEstimateId(signature = "") {
  let hash = 2166136261;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function routeEstimateMeta(truck, load, stops = mapStopsForLoad(load, truck)) {
  const parentTruck = findLoad(load?.id).truck || truck;
  truck = effectiveTruckForLoad(parentTruck, load);
  const handoffTravel = switchApproachTravelForLoad(parentTruck, load);
  const loadStart = handoffTravel?.previousEntry
    ? loadStats(handoffTravel.previousEntry.truck, handoffTravel.previousEntry.load).finish
    : loadStats(parentTruck, load).start;
  const allowTolls = Boolean(load?.allowTolls);
  const signature = [
    currentPlanDate,
    routeSignature(stops),
    `start:${loadStart}`,
    `tolls:${allowTolls ? "allow" : "avoid"}`,
    `truckPct:${truckTravelTimePercent(truck)}`
  ].join("@");
  return {
    id: routeEstimateId(signature),
    signature,
    loadStart,
    allowTolls
  };
}

function cacheRouteEstimate(truck, load, stops, estimate) {
  if (!load?.id || !estimate) return null;
  const meta = routeEstimateMeta(truck, load, stops);
  const cached = {
    id: meta.id,
    signature: meta.signature,
    savedAt: new Date().toISOString(),
    estimate: {
      rawDriveMinutes: Number(estimate.rawDriveMinutes || 0),
      driveMinutes: Number(estimate.driveMinutes || 0),
      stayMinutes: Number(estimate.stayMinutes || 0),
      totalMinutes: Number(estimate.totalMinutes || 0),
      legMinutes: Array.isArray(estimate.legMinutes) ? estimate.legMinutes.map(Number) : [],
      rawLegMinutes: Array.isArray(estimate.rawLegMinutes) ? estimate.rawLegMinutes.map(Number) : [],
      allowTolls: Boolean(estimate.allowTolls),
      travelTimePercent: Number(estimate.travelTimePercent || 0),
      routeEstimateId: meta.id
    }
  };
  persistedRouteEstimateCache[meta.id] = cached;
  savePersistedRouteEstimateCache();
  return cached;
}

function applyCachedRouteEstimate(truck, load, stops = mapStopsForLoad(load, truck)) {
  if (!load?.id || estimateForLoad(load)) return false;
  const meta = routeEstimateMeta(truck, load, stops);
  const cached = persistedRouteEstimateCache[meta.id];
  if (!cached?.estimate || cached.signature !== meta.signature) return false;
  const estimate = { ...cached.estimate, routeEstimateId: meta.id, fromPersistentCache: true };
  routeEstimates[load.id] = estimate;
  return true;
}

function hydrateCachedRouteEstimates() {
  let changed = false;
  for (const truck of trucks) {
    for (const load of truck.loads || []) {
      const stops = mapStopsForLoad(load, truck);
      if (stops.length <= 1) continue;
      if (applyCachedRouteEstimate(truck, load, stops)) changed = true;
    }
  }
  return changed;
}

function plannedDepartureDate(startMinutes) {
  const departure = new Date();
  departure.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);
  if (departure.getTime() < Date.now() + 5 * 60 * 1000) {
    departure.setDate(departure.getDate() + 1);
  }
  return departure;
}

function mapMarkerIcon(stop) {
  const color = stop.type === "pick" ? "#155eef" : "#0f8f4f";
  const label = String(stop.label || "").slice(0, 3);
  const fontSize = label.length > 2 ? 13 : 16;
  if (stop.fanPin) {
    const dx = Number(stop.fanPin.dx || 0);
    const dy = Number(stop.fanPin.dy || 0);
    const headX = 35 + dx;
    const headY = 27 + dy;
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="70" height="76" viewBox="0 0 70 76">
        <line x1="35" y1="70" x2="${headX}" y2="${headY + 14}" stroke="#fff" stroke-width="8" stroke-linecap="round"/>
        <line x1="35" y1="70" x2="${headX}" y2="${headY + 14}" stroke="${color}" stroke-width="5" stroke-linecap="round"/>
        <circle cx="${headX}" cy="${headY}" r="17" fill="${color}" stroke="#fff" stroke-width="3"/>
        <text x="${headX}" y="${headY + 6}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="900" fill="#fff">${label}</text>
      </svg>
    `.trim();
    return {
      url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
      scaledSize: new google.maps.Size(70, 76),
      anchor: new google.maps.Point(35, 70)
    };
  }
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="42" height="50" viewBox="0 0 42 50">
      <path d="M21 48C17 41 5 31 5 19C5 9.6 12.2 3 21 3s16 6.6 16 16c0 12-12 22-16 29Z" fill="${color}" stroke="#fff" stroke-width="3"/>
      <circle cx="21" cy="19" r="12.5" fill="rgba(255,255,255,.18)"/>
      <text x="21" y="24" text-anchor="middle" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="900" fill="#fff">${label}</text>
    </svg>
  `.trim();
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new google.maps.Size(42, 50),
    anchor: new google.maps.Point(21, 48),
    labelOrigin: new google.maps.Point(21, 19)
  };
}

function spreadOverlappingMarkers(markerStops) {
  const groups = new Map();
  for (const stop of markerStops) {
    const key = `${Number(stop.lat).toFixed(5)},${Number(stop.lng).toFixed(5)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(stop);
  }
  const spread = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      spread.push(group[0]);
      continue;
    }
    const radius = 0.00018 + (group.length * 0.000025);
    const stepDegrees = group.length <= 2 ? 60 : 30;
    const startDegrees = -((group.length - 1) * stepDegrees) / 2;
    const fanDistance = 18;
    group.forEach((stop, index) => {
      const angle = ((startDegrees + (index * stepDegrees)) * Math.PI) / 180;
      spread.push({
        ...stop,
        fanPin: {
          dx: Math.sin(angle) * fanDistance,
          dy: -(Math.cos(angle) * fanDistance)
        }
      });
    });
  }
  return spread;
}

function geocodeAddress(address) {
  const key = normalizedPlaceKey(address);
  if (!key || !window.google?.maps?.Geocoder) return Promise.resolve(null);
  if (geocodeCache[key]) return Promise.resolve(geocodeCache[key]);
  const geocoder = new google.maps.Geocoder();
  return new Promise((resolve) => {
    geocoder.geocode({ address }, (results, status) => {
      if (status !== "OK" || !results?.[0]?.geometry?.location) return resolve(null);
      const location = results[0].geometry.location;
      const point = { lat: location.lat(), lng: location.lng() };
      geocodeCache[key] = point;
      const oldestKey = Object.keys(geocodeCache).length >= 400 ? Object.keys(geocodeCache)[0] : "";
      if (oldestKey) delete geocodeCache[oldestKey];
      resolve(point);
    });
  });
}

async function geocodeMarkerStops(markerStops = []) {
  return Promise.all(markerStops.map(async (stop) => {
    if (typeof stop.routeLocation !== "string") return stop;
    const point = await geocodeAddress(stop.routeLocation);
    return point ? { ...stop, ...point } : stop;
  }));
}

function routeEstimateFromGoogleLegs(load, stops, legs = [], truck = {}) {
  truck = effectiveTruckForLoad(findLoad(load?.id).truck || truck, load);
  const rawLegMinutes = legs.map((leg, index) => {
    const from = stops[index];
    const to = stops[index + 1];
    if (samePhysicalRouteStop(from, to)) return 0;
    return Math.max(1, Math.round(Number((leg.duration_in_traffic || leg.duration)?.value || 0) / 60));
  });
  const legMinutes = rawLegMinutes.map((value) => adjustedTravelMinutesForTruck(truck, value));
  const rawDriveMinutes = rawLegMinutes.reduce((sum, value) => sum + value, 0);
  const driveMinutes = legMinutes.reduce((sum, value) => sum + value, 0);
  const stayMinutes = routeStayMinutesForLoad(load, stops);
  const totalMinutes = driveMinutes + stayMinutes;
  const estimate = {
    rawDriveMinutes,
    driveMinutes,
    stayMinutes,
    totalMinutes,
    legMinutes,
    rawLegMinutes,
    allowTolls: Boolean(load?.allowTolls),
    travelTimePercent: truckTravelTimePercent(truck)
  };
  routeEstimates[load.id] = estimate;
  cacheRouteEstimate(truck, load, stops, estimate);
  return estimate;
}

function directionsRequestForLoad(truck, load, stops, meta = routeEstimateMeta(truck, load, stops)) {
  return {
    origin: stopRouteLocation(stops[0]),
    destination: stopRouteLocation(stops[stops.length - 1]),
    waypoints: stops.slice(1, -1).map((stop) => ({ location: stopRouteLocation(stop), stopover: true })),
    travelMode: google.maps.TravelMode.DRIVING,
    avoidTolls: !meta.allowTolls,
    optimizeWaypoints: false,
    drivingOptions: {
      departureTime: plannedDepartureDate(meta.loadStart),
      trafficModel: google.maps.TrafficModel.BEST_GUESS
    }
  };
}

function googleRouteForLoad(truck, load) {
  if (!window.google?.maps?.DirectionsService || !load?.id) return Promise.resolve(null);
  truck = effectiveTruckForLoad(findLoad(load.id).truck || truck, load);
  const stops = mapStopsForLoad(load, truck);
  if (stops.length <= 1) return Promise.resolve(null);
  if (applyCachedRouteEstimate(truck, load, stops)) return Promise.resolve({ source: "persistent-cache", stops, estimate: estimateForLoad(load) });
  const meta = routeEstimateMeta(truck, load, stops);
  const cached = routeCache[load.id];
  if (cached?.signature === meta.signature && cached.result) {
    const legs = cached.result.routes?.[0]?.legs || [];
    const estimate = routeEstimateFromGoogleLegs(load, stops, legs, truck);
    return Promise.resolve({ source: "memory-cache", stops, result: cached.result, markerStops: cached.markerStops || stops, estimate });
  }
  if (backgroundRouteInFlight.has(meta.id)) return Promise.resolve(null);
  backgroundRouteInFlight.add(meta.id);
  const directionsService = new google.maps.DirectionsService();
  return new Promise((resolve) => {
    directionsService.route(directionsRequestForLoad(truck, load, stops, meta), (result, status) => {
      backgroundRouteInFlight.delete(meta.id);
      if (status !== "OK" || !result) return resolve({ source: "google-error", status, stops });
      const legs = result.routes?.[0]?.legs || [];
      const routeMarkerStops = stops.map((stop, index) => {
        if (typeof stop.routeLocation !== "string") return stop;
        const routePoint = index === 0
          ? legs[0]?.start_location
          : legs[index - 1]?.end_location;
        return routePoint ? { ...stop, lat: routePoint.lat(), lng: routePoint.lng() } : stop;
      });
      const estimate = routeEstimateFromGoogleLegs(load, stops, legs, truck);
      routeCache[load.id] = { signature: meta.signature, result, markerStops: routeMarkerStops };
      resolve({ source: "google", status, stops, result, markerStops: routeMarkerStops, estimate });
    });
  });
}

function routeEstimateSummaryHtml(estimate, truck, suffix = "") {
  const adjustment = truckTravelTimePercent(truck) > 0
    ? ` | Google ${durationText(estimate.rawDriveMinutes)} +${truckTravelTimePercent(truck)}%`
    : "";
  const tollText = estimate.allowTolls ? " | tolls allowed" : " | avoiding tolls";
  return `<strong>${durationText(estimate.totalMinutes)} total</strong><span>${durationText(estimate.driveMinutes)} drive + ${durationText(estimate.stayMinutes)} stop time${adjustment}${tollText}${suffix}</span>`;
}

function routeEstimateChangesVisibleTiming(previousEstimate, estimate) {
  if (!estimate) return false;
  if (!previousEstimate) return true;
  return Number(previousEstimate.totalMinutes || 0) !== Number(estimate.totalMinutes || 0)
    || Number(previousEstimate.driveMinutes || 0) !== Number(estimate.driveMinutes || 0)
    || Number(previousEstimate.stayMinutes || 0) !== Number(estimate.stayMinutes || 0)
    || Number(previousEstimate.travelTimePercent || 0) !== Number(estimate.travelTimePercent || 0)
    || Boolean(previousEstimate.allowTolls) !== Boolean(estimate.allowTolls);
}

async function renderGoogleMapPreview() {
  const canvas = document.getElementById("googleMapPreview");
  if (!canvas) return;
  const available = await loadGoogleMaps();
  if (!available || !window.google?.maps) {
    canvas.innerHTML = dispatchConfig.googleMapsApiKey ? "Google Maps could not load." : "Add GOOGLE_MAPS_API_KEY to enable Google Maps.";
    return;
  }
  const selected = selectedLoad();
  const load = selected.load;
  const truck = effectiveTruckForLoad(selected.truck, load);
  const stops = mapStopsForLoad(load, truck);
  const meta = routeEstimateMeta(truck, load, stops);
  const allowTolls = meta.allowTolls;
  const map = new google.maps.Map(canvas, {
    center: stops[0] || MAP_CENTER,
    zoom: 9,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false
  });
  const routeSummary = document.getElementById("routeEstimateSummary");
  const bounds = new google.maps.LatLngBounds();
  const drawStopMarkers = (markerStops) => {
    spreadOverlappingMarkers(markerStops).forEach((stop) => {
      const marker = new google.maps.Marker({
        position: { lat: stop.lat, lng: stop.lng },
        map,
        icon: mapMarkerIcon(stop),
        title: stop.title
      });
      const info = new google.maps.InfoWindow({
        content: `<strong>${escapeHtml(stop.title)}</strong><br>${stop.type === "pick" ? "Pickup" : "Drop off"}<br>Stay ${Number(stop.stayMinutes || 0)} min`
      });
      marker.addListener("click", () => info.open({ anchor: marker, map }));
      bounds.extend(marker.getPosition());
    });
    if (markerStops.length) map.fitBounds(bounds, 36);
  };
  if (stops.length > 1 && google.maps.DirectionsService) {
    const directionsRenderer = new google.maps.DirectionsRenderer({
      map,
      suppressMarkers: true,
      preserveViewport: false,
      polylineOptions: {
        strokeColor: "#006f6b",
        strokeOpacity: 0.9,
        strokeWeight: 5
      }
    });
    const cached = routeCache[load.id];
    if (cached?.signature === meta.signature && cached.result) {
      directionsRenderer.setDirections(cached.result);
      drawStopMarkers(cached.markerStops || stops);
      const legs = cached.result.routes?.[0]?.legs || [];
      const previousEstimate = routeEstimates[load.id];
      const estimate = routeEstimateFromGoogleLegs(load, stops, legs, truck);
      if (routeSummary) {
        routeSummary.innerHTML = routeEstimateSummaryHtml(estimate, truck, " | cached route");
      }
      if (
        selectedLoadId === load.id
        && routeEstimateChangesVisibleTiming(previousEstimate, estimate)
      ) {
        setTimeout(() => render({ save: false }), 0);
      }
      return;
    }
    const directionsService = new google.maps.DirectionsService();
    directionsService.route(directionsRequestForLoad(truck, load, stops, meta), (result, status) => {
      if (status !== "OK" || !result) {
        if (routeSummary) routeSummary.textContent = `Google route unavailable (${status}).`;
        geocodeMarkerStops(stops).then((markerStops) => {
          drawStopMarkers(markerStops);
          new google.maps.Polyline({
            path: markerStops.map((stop) => ({ lat: stop.lat, lng: stop.lng })),
            geodesic: true,
            strokeColor: "#006f6b",
            strokeOpacity: 0.55,
            strokeWeight: 4,
            map
          });
        });
        return;
      }
      directionsRenderer.setDirections(result);
      const legs = result.routes?.[0]?.legs || [];
      const routeMarkerStops = stops.map((stop, index) => {
        if (typeof stop.routeLocation !== "string") return stop;
        const routePoint = index === 0
          ? legs[0]?.start_location
          : legs[index - 1]?.end_location;
        return routePoint ? { ...stop, lat: routePoint.lat(), lng: routePoint.lng() } : stop;
      });
      drawStopMarkers(routeMarkerStops);
      const previousEstimate = routeEstimates[load.id];
      const estimate = routeEstimateFromGoogleLegs(load, stops, legs, truck);
      routeCache[load.id] = { signature: meta.signature, result, markerStops: routeMarkerStops };
      if (routeSummary) {
        routeSummary.innerHTML = routeEstimateSummaryHtml(estimate, truck);
      }
      if (selectedLoadId === load.id && routeEstimateChangesVisibleTiming(previousEstimate, estimate)) {
        setTimeout(() => render({ save: false }), 0);
      }
    });
  } else if (stops.length > 1) {
    const markerStops = await geocodeMarkerStops(stops);
    drawStopMarkers(markerStops);
    new google.maps.Polyline({
      path: markerStops.map((stop) => ({ lat: stop.lat, lng: stop.lng })),
      geodesic: true,
      strokeColor: "#006f6b",
      strokeOpacity: 0.9,
      strokeWeight: 4,
      map
    });
    const stayMinutes = routeStayMinutesForLoad(load, stops);
    if (routeSummary) routeSummary.innerHTML = `<strong>${stayMinutes} min stay</strong><span>Add more stops for Google travel estimate.</span>`;
  } else {
    drawStopMarkers(await geocodeMarkerStops(stops));
  }
}

function routeLoadsNeedingEstimate() {
  const candidates = [];
  for (const truck of trucks) {
    for (const load of truck.loads || []) {
      const stops = mapStopsForLoad(load, truck);
      if (stops.length <= 1) continue;
      if (applyCachedRouteEstimate(truck, load, stops)) continue;
      if (!routePendingForLoad(truck, load)) continue;
      const meta = routeEstimateMeta(truck, load, stops);
      candidates.push({ truck, load, meta });
    }
  }
  return candidates;
}

function scheduleBackgroundRouteEstimates() {
  if (!dispatchConfig.googleMapsApiKey) return;
  clearTimeout(backgroundRouteTimer);
  backgroundRouteTimer = setTimeout(runBackgroundRouteEstimates, 650);
}

async function runBackgroundRouteEstimates() {
  if (backgroundRoutesRunning || !dispatchConfig.googleMapsApiKey) return;
  const candidates = routeLoadsNeedingEstimate();
  if (!candidates.length) return;
  backgroundRoutesRunning = true;
  try {
    const available = await loadGoogleMaps();
    if (!available || !window.google?.maps?.DirectionsService) return;
    for (const candidate of candidates) {
      const latest = findLoad(candidate.load.id);
      if (!latest.truck || !latest.load) continue;
      const previousEstimate = estimateForLoad(latest.load);
      const result = await googleRouteForLoad(latest.truck, latest.load);
      if (routeEstimateChangesVisibleTiming(previousEstimate, result?.estimate)) {
        backgroundRouteRenderQueued = true;
      }
    }
  } finally {
    backgroundRoutesRunning = false;
    if (backgroundRouteRenderQueued) {
      backgroundRouteRenderQueued = false;
      render({ save: false });
    }
  }
}

function planBadgeText() {
  if (!currentPlan?.id) return "No plan";
  return String(currentPlan.status || "draft").toUpperCase();
}

function planModeControlHtml() {
  if (SALES_PLANNING_HOST) {
    return `<span class="dispatch-mode-pill viewing">Sales view only</span>`;
  }
  if (isDispatchPlanEditor()) {
    return `
      <span class="dispatch-mode-pill editing">Edit mode</span>
      <button data-action="save-plan-now" type="button">Save Now</button>
      <button data-action="exit-edit-mode" type="button">Exit Edit</button>
    `;
  }
  const owner = planEditLease?.active ? escapeHtml(planEditLease.operatorName || "Another dispatcher") : "";
  const lockedByOther = Boolean(planEditLease?.active && planEditLease.sessionId !== dispatchSessionId);
  return `
    <span class="dispatch-mode-pill viewing">${lockedByOther ? `${owner} editing` : "View mode"}</span>
    <button class="primary" data-action="enter-edit-mode" type="button" ${lockedByOther ? `disabled title="${owner} is already editing this plan"` : ""}>Enter Edit Mode</button>
  `;
}

function planCanEditConfirmed() {
  return Boolean(currentPlan?.id && currentPlan.status === "confirmed");
}

function cssAttr(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function selectorForElement(element) {
  if (!element || !app.contains(element)) return "";
  if (element.id) return `#${cssAttr(element.id)}`;
  const tag = element.tagName.toLowerCase();
  const attrs = [
    "data-action",
    "data-load",
    "data-load-card",
    "data-stop",
    "data-order",
    "data-truck",
    "data-truck-driver",
    "data-truck-start",
    "data-truck-parking",
    "data-driver-new-truck",
    "data-load-driver",
    "data-load-truck",
    "data-load-start",
    "data-load-start-mode",
    "data-load-switch-yard",
    "data-load-parking",
    "data-return-yard",
    "data-po-match-scroll",
    "data-driver-lane",
    "data-driver-lane-drop"
  ].filter((name) => element.hasAttribute(name));
  if (attrs.length) return `${tag}${attrs.map((name) => `[${name}="${cssAttr(element.getAttribute(name))}"]`).join("")}`;
  const dataParent = element.closest("[data-action], [data-load-card], [data-stop], [data-order]");
  return dataParent && dataParent !== element ? selectorForElement(dataParent) : "";
}

function captureRenderUiState() {
  const active = document.activeElement;
  return {
    focusSelector: selectorForElement(active),
    selectionStart: typeof active?.selectionStart === "number" ? active.selectionStart : null,
    selectionEnd: typeof active?.selectionEnd === "number" ? active.selectionEnd : null,
    scrolls: [...app.querySelectorAll(".order-list, .truck-board, .truck-timeline, .date-truck-yard-list, .load-preview-body, .preview-stop-list, .stop-list, .modal-body, .po-link-lines, .order-dependency-match-lines, [data-po-match-scroll]")]
      .map((element) => ({
        selector: selectorForElement(element) || `.${[...element.classList].join(".")}`,
        top: element.scrollTop,
        left: element.scrollLeft
      }))
      .filter((item) => item.selector)
  };
}

function restoreRenderUiState(state = {}, sequence = renderUiSequence) {
  const restoreScrolls = () => {
    for (const item of state.scrolls || []) {
      const element = app.querySelector(item.selector);
      if (!element) continue;
      element.scrollTop = item.top || 0;
      element.scrollLeft = item.left || 0;
    }
  };
  restoreScrolls();
  if (state.focusSelector) {
    const element = app.querySelector(state.focusSelector);
    if (element && typeof element.focus === "function") {
      element.focus({ preventScroll: true });
      if (state.selectionStart !== null && typeof element.setSelectionRange === "function") {
        element.setSelectionRange(state.selectionStart, state.selectionEnd ?? state.selectionStart);
      }
    }
  }
  window.requestAnimationFrame(() => {
    if (sequence === renderUiSequence) restoreScrolls();
  });
}

function render(options = {}) {
  const { save = false } = options;
  const uiSequence = ++renderUiSequence;
  const uiState = captureRenderUiState();
  orderListScrollTop = app.querySelector(".order-list")?.scrollTop ?? orderListScrollTop;
  if (save) normalizePlanBeforeSave();
  const planChanged = (!historyReady || save) ? captureUndoPointIfNeeded(save) : false;
  if (save && planChanged) {
    markLocalPlanDirty();
    autoSavePlan();
  }
  const stats = boardStats();
  app.innerHTML = `
    <section class="dispatch-shell ${isDispatchPlanEditor() ? "dispatch-editing" : "dispatch-viewing"}">
      <header class="dispatch-topbar">
        <div class="topbar-main">
          <div>
            <p>${t("app.transportation", "MBBS Transportation")}</p>
            <h1>${t("dispatch.planning", "Dispatch Planning")}</h1>
          </div>
          <div class="topbar-controls">
            <input id="planDateInput" type="date" value="${escapeHtml(currentPlanDate)}" />
            <span class="autosave-pill plan-status-pill">${escapeHtml(planBadgeText())}</span>
          </div>
        </div>
        <div class="topbar-language">${languageToggle()}</div>
        <div class="topbar-actions">
          <button onclick="location.href='${SALES_PLANNING_HOST ? "/sales" : "/dispatch"}'" type="button">${t("common.menu", "Menu")}</button>
          <button data-action="undo-plan" ${undoStack.length && isDispatchPlanEditor() ? "" : "disabled"} title="Undo (Ctrl+Z)" type="button">${t("dispatch.undo", "Undo")}</button>
          <button data-action="redo-plan" ${redoStack.length && isDispatchPlanEditor() ? "" : "disabled"} title="Redo (Ctrl+Y)" type="button">${t("dispatch.redo", "Redo")}</button>
          <button data-action="export-shipped-csv" ${currentPlan?.id ? "" : "disabled"} type="button">${t("dispatch.exportShippedCsv", "Export Shipped CSV")}</button>
          <button class="primary" data-action="confirm-plan" ${currentPlan?.id && isDispatchPlanEditor() ? "" : "disabled"} type="button">${t("dispatch.confirmPlan", "Confirm Plan")}</button>
          <button data-action="refresh-orders" type="button">${t("dispatch.refreshOrders", "Refresh Orders")}</button>
          ${planModeControlHtml()}
          <span class="autosave-pill">${localPlanDirty ? "Saving..." : t("dispatch.saved", "Saved")} ${lastSavedAt}</span>
        </div>
      </header>
      ${routeNotice ? `<div class="route-notice"><span>${escapeHtml(routeNotice)}</span><button data-action="close-route-notice" type="button">x</button></div>` : ""}
      ${driverTruckSwitchAttention.length ? `<div class="truck-switch-attention-panel">
        ${driverTruckSwitchAttention.map((item) => `<div><span><strong>${escapeHtml(item.driver_login || "Driver")}</strong>: ${escapeHtml(item.from_truck_plate || "previous truck")} to ${escapeHtml(item.to_truck_plate || "new truck")} failed in Samsara. ${escapeHtml(item.samsara_error || "")}</span><button data-action="override-truck-switch" data-job-id="${escapeHtml(item.job_id)}" type="button">Override</button></div>`).join("")}
      </div>` : ""}
      <div class="dispatch-grid">
        ${renderOrderPool()}
        <section class="planner-panel">
          <div class="kpi-strip">
            <div class="kpi"><span>${t("dispatch.openOrders", "Open Orders")}</span><strong>${stats.open}</strong></div>
            <div class="kpi"><span>${t("dispatch.plannedDrops", "Planned Drops")}</span><strong>${stats.planned}</strong></div>
            <div class="kpi"><span>${t("dispatch.totalStops", "Total Stops")}</span><strong>${stats.stops}</strong></div>
            <div class="kpi"><span>${t("dispatch.warnings", "Warnings")}</span><strong>${stats.warnings}</strong></div>
            <div class="kpi"><span>${driverOrientedPlanningEnabled() ? t("dispatch.drivers", "Drivers") : t("dispatch.trucks", "Trucks")}</span><strong>${driverOrientedPlanningEnabled() ? drivers.length : trucks.length}</strong></div>
          </div>
          <div class="truck-board">
            ${driverOrientedPlanningEnabled() ? driverLanes().map(renderDriverLane).join("") : trucks.map(renderTruck).join("")}
          </div>
        </section>
      </div>
      ${renderLoadPreview()}
      ${renderModal()}
      <div id="orderTooltip"></div>
    </section>
  `;
  const orderList = app.querySelector(".order-list");
  if (orderList) orderList.scrollTop = orderListScrollTop;
  restoreRenderUiState(uiState, uiSequence);
  renderGoogleMapPreview();
  scheduleBackgroundRouteEstimates();
}

function orderPoolSubtitle() {
  if (!searchText.trim()) return activeOrderType === "TO" ? "Transfer and Custom Order list" : orderTypeLabel(activeOrderType) + " list";
  if (orderSearchLoading) return "Searching all valid SO, PO, TO, Custom, and CO orders...";
  if (orderSearchError) return "Server search unavailable: " + orderSearchError;
  return "Search results across all valid SO, PO, TO, Custom, and CO orders.";
}

function renderOrderPool() {
  const searching = Boolean(searchText.trim());
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>${t("dispatch.orderPool", "Order Pool")}</h2>
          <p>${orderPoolSubtitle()}</p>
        </div>
        <div class="order-tools">
          <input id="orderSearch" value="${escapeHtml(searchText)}" placeholder="Search SO, PO, TO, Custom, CO, SKU, address" />
          <label class="date-filter">
            <span>SO Date</span>
            <input id="dispatchDate" type="date" value="${escapeHtml(dispatchDateFilter)}" />
          </label>
        </div>
        ${renderSelectedOrderActions()}
      </div>
      <div class="order-type-tabs">
        ${["SO", "PO", "TO", "CO"].map((type) => `<button class="${!searching && activeOrderType === type ? "active" : ""}" data-action="order-type-tab" data-type="${type}" type="button">${type}</button>`).join("")}
      </div>
      <div class="order-list">${renderOrderList()}</div>
    </section>
  `;
}

function renderOrderList() {
  return openOrders().map(renderOrderCard).join("") || `<div class="empty-drop">No open orders match the filter.</div>`;
}

function refreshOrderPoolForSearch() {
  const active = document.activeElement;
  const searchSelection = active?.id === "orderSearch" && typeof active.selectionStart === "number"
    ? { start: active.selectionStart, end: active.selectionEnd ?? active.selectionStart }
    : null;
  const searching = Boolean(searchText.trim());
  const pool = document.querySelector(".panel .panel-header h2")?.closest(".panel");
  const subtitle = pool?.querySelector(".panel-header p");
  const tabs = pool?.querySelectorAll(".order-type-tabs button");
  const list = pool?.querySelector(".order-list");
  if (subtitle) subtitle.textContent = orderPoolSubtitle();
  tabs?.forEach((button) => button.classList.toggle("active", !searching && activeOrderType === button.dataset.type));
  if (list) list.innerHTML = renderOrderList();
  if (searchSelection) {
    const input = document.getElementById("orderSearch");
    if (input && typeof input.setSelectionRange === "function") {
      input.focus({ preventScroll: true });
      input.setSelectionRange(searchSelection.start, searchSelection.end);
    }
  }
}

function renderSelectedOrderActions() {
  const order = selectedOrder();
  if (!order) return "";
  const selected = selectedOrders();
  const includesCustomOrder = selected.some((item) => item.type === "CUSTOM");
  const label = selected.length > 1 ? `${selected.length} selected` : order.id;
  const groupedCount = order.childOrders?.length || 0;
  const reviewOnly = selected.some((item) => isReviewOnlyOrder(item));
  const blockedUngroup = groupedCount && groupedOrderTransitCoId(order);
  return `
    <div class="selected-order-actions">
      <span>${escapeHtml(label)}</span>
      ${reviewOnly ? `<span>Loaded/shipped history</span>` : ""}
      ${groupedCount ? `<button data-action="ungroup-order" data-order="${escapeHtml(order.id)}" ${blockedUngroup ? `disabled title="Cancel ${escapeHtml(blockedUngroup)} before ungrouping"` : ""} type="button">Ungroup</button>` : selected.length > 1 && !includesCustomOrder ? `<button data-action="open-group-modal" data-order="${escapeHtml(order.id)}" type="button">Group</button>` : ""}
      ${blockedUngroup ? `<span>Cancel ${escapeHtml(blockedUngroup)} before ungrouping</span>` : ""}
      ${order.type === "CUSTOM" ? `<button data-action="edit-custom-order" data-custom-order-id="${escapeHtml(order.customOrderId || "")}" type="button">Open Custom Order</button>` : ""}
      ${!reviewOnly && order.type === "PO" && order.sourceTable !== "scm_vrma_orders" ? `<button data-action="open-po-yard-modal" data-order="${escapeHtml(order.id)}" type="button">Set Yard</button>` : ""}
      ${!reviewOnly && order.type === "SO" ? `<button data-action="open-po-link-modal" data-order="${escapeHtml(order.id)}" type="button">Link PO</button>` : ""}
      ${!reviewOnly && order.type === "SO" ? `<button data-action="open-to-link-modal" data-order="${escapeHtml(order.id)}" type="button">Link TO</button>` : ""}
      ${!reviewOnly && !["CO", "CUSTOM"].includes(order.type) && order.sourceTable !== "scm_vrma_orders" && !order.originalOrderId ? `<button data-action="open-split-modal" data-order="${escapeHtml(order.id)}" type="button">Split</button>` : ""}
      ${!reviewOnly && order.type !== "CUSTOM" && order.originalOrderId ? `<button data-action="unsplit-order" data-order="${escapeHtml(order.id)}" type="button">Unsplit</button>` : ""}
      ${!reviewOnly && canConsolidatePick(order) ? `<button data-action="open-consolidate-modal" data-order="${escapeHtml(order.id)}" type="button">Consolidate Pick</button>` : ""}
    </div>
  `;
}

function renderOrderCard(order) {
  const splitWarning = order.pallets > 20;
  const groupedCount = order.childOrders?.length || 0;
  const shortage = shortageQty(order);
  const missingAddress = !hasUsableDispatchAddress(order);
  const transitMessage = transitBlockMessage(order);
  const transitBlocked = Boolean(transitMessage);
  const dateText = order.expectedDeliveryDate ? `${displayDate(order.expectedDeliveryDate)} | ` : "";
  const assignment = orderAssignment(order.id);
  const planned = Boolean(assignment.load);
  const plannedElsewhere = isOrderPlannedOutsideCurrentPlan(order);
  const dependencyLinked = Boolean(order.dependencyHidden);
  const dependentSalesOrder = dependencyLinked ? orderById(order.dependentSalesOrderRef) : null;
  const dependentSalesAssignment = dependentSalesOrder ? orderAssignment(dependentSalesOrder.id) : {};
  const dependencyParentPlanned = dependencyLinked && Boolean(dependentSalesAssignment.load || dependentSalesOrder?.dispatchPlanned);
  const anyPlanned = planned || plannedElsewhere;
  const dragBlocked = anyPlanned || dependencyLinked;
  const reviewOnly = isReviewOnlyOrder(order);
  const packedText = packedUnitText(order);
  const executionStatus = orderExecutionStatus(order.id);
  const plannedText = planned
    ? `${assignment.truck?.plate || ""} ${assignment.load?.name || "Planned"}`
    : orderPlannedElsewhereText(order);
  return `
    <article class="order-card status-${executionStatus} ${selectedOrderIds.has(order.id) ? "selected" : ""} ${planned ? "planned" : ""} ${plannedElsewhere ? "planned-elsewhere" : ""} ${dependencyLinked && !dependencyParentPlanned ? "dependency-linked" : ""} ${dependencyParentPlanned ? "dependency-parent-planned" : ""} ${reviewOnly ? "review-only" : ""} ${missingAddress || transitBlocked || order.dependencyAttention ? "warning" : ""}" draggable="${dragBlocked ? "false" : "true"}" data-order="${escapeHtml(order.id)}" data-planned="${anyPlanned ? "true" : "false"}" data-dependency-linked="${dependencyLinked ? "true" : "false"}" data-review-only="${reviewOnly ? "true" : "false"}" data-planned-elsewhere="${plannedElsewhere ? "true" : "false"}">
      <strong>${escapeHtml(order.id)} | ${escapeHtml(order.customer)}</strong>
      <span>${plannedElsewhere ? escapeHtml(orderPlannedElsewhereText(order)) : missingAddress ? "Missing delivery address" : transitBlocked ? escapeHtml(transitMessage) : escapeHtml(movementText(order))}</span>
      <span class="order-compact-line">Pickup ${escapeHtml(orderPickupText(order))} | ${dateText}${order.windowStart || "--"}-${order.windowEnd || "--"}</span>
      <span class="order-compact-line">${orderUnitText(order)} | ${orderFootprintPallets(order)} pos | ${formatLbs(orderWeightLbs(order))}${packedText ? ` | Packed ${escapeHtml(packedText)}` : ""}</span>
      ${groupedCount ? `<span>Includes ${order.childOrders.join(", ")}</span>` : ""}
      <div class="chip-row">
        <span class="chip">${order.type === "CUSTOM" ? "Custom" : order.type}</span>
        ${order.sourceTable === "scm_vrma_orders" ? `<span class="chip">Local VRMA</span>` : ""}
        ${executionStatus === "complete" ? `<span class="chip complete-chip">Completed</span>` : executionStatus === "in_progress" ? `<span class="chip progress-chip">In progress</span>` : ""}
        ${reviewOnly ? `<span class="chip complete-chip">${escapeHtml(reviewOnlyText(order))}</span>` : ""}
        ${anyPlanned ? `<span class="chip planned-chip">${escapeHtml(plannedText)}</span>` : ""}
        ${missingAddress ? `<span class="chip warn">Update address</span>` : ""}
        ${order.netsuiteFeedMissing ? `<span class="chip warn">NetSuite status changed</span>` : ""}
        ${order.transitCo ? `<span class="chip ${transitBlocked ? "warn" : ""}">CO ${escapeHtml(order.transitCo.id)}</span>` : ""}
        ${(order.items || []).some((item) => Number(item.poAllocatedSalesQty || 0) > 0) ? `<span class="chip">PO linked</span>` : ""}
        ${order.type === "CO" ? `<span class="chip">For ${escapeHtml(order.sourceOrderId || order.relatedSoId || "SO")}</span>` : ""}
        ${order.scm?.isSpecialOrder ? `<span class="chip warn">Sp.O</span>` : ""}
        ${order.testFixture ? `<span class="chip">TEST</span>` : ""}
        ${order.scm?.status && order.scm.status !== "Queued" ? `<span class="chip">${escapeHtml(order.scm.status)}</span>` : ""}
        ${order.scm?.packingSlipRef ? `<span class="chip">Ref ${escapeHtml(order.scm.packingSlipRef)}</span>` : ""}
        ${order.scm?.groupRef ? `<span class="chip">PGOB ${escapeHtml(order.scm.groupRef.replace(/^PGOB-/, ""))}</span>` : ""}
        ${(order.dependencyLabels || []).map((label) => `<span class="chip ${/attention|uncovered/i.test(label) ? "warn" : ""}">${escapeHtml(label)}</span>`).join("")}
        ${groupedCount ? `<span class="chip">Grouped ${groupedCount}</span>` : ""}
        ${splitWarning ? `<span class="chip warn">Split suggested</span>` : ""}
        ${shortage ? `<span class="chip warn">${shortage} short</span>` : ""}
        ${canConsolidatePick(order) ? `<span class="chip">Conso Pick</span>` : ""}
        ${order.consolidation ? `<span class="chip">From ${order.consolidation.sourceYard}</span>` : ""}
      </div>
    </article>
  `;
}

function renderTruck(truck, index = 0) {
  const selectedDriver = truckDriver(truck);
  const hasDriver = truckHasDriver(truck);
  const selectedOnTruck = truck.loads.some((load) => load.id === selectedLoadId);
  const insertText = selectedOnTruck ? "Insert after selected load" : "Add to end";
  return `
    <article class="truck-row ${hasDriver ? "" : "driver-missing"}">
      <div class="truck-sequence-controls">
        <button data-action="move-truck-up" data-truck="${escapeHtml(truck.id)}" ${index <= 0 ? "disabled" : ""} title="Move truck up" type="button">▲</button>
        <button data-action="move-truck-down" data-truck="${escapeHtml(truck.id)}" ${index >= trucks.length - 1 ? "disabled" : ""} title="Move truck down" type="button">▼</button>
      </div>
      <div class="truck-label">
        <div>
          <strong>${escapeHtml(truck.plate)}</strong>
          <span>${formatLbs(truckCapacityLbs(truck))} cap. | ${escapeHtml(travelAdjustmentText(truck))}</span>
          <label class="truck-start-yard">
            <span>Driver</span>
            <select data-truck-driver="${escapeHtml(truck.id)}">${driverOptions(driverKey(selectedDriver) || truck.driverLogin || "", truck.id)}</select>
          </label>
          ${hasDriver ? "" : `<span class="truck-driver-warning">Assign driver first</span>`}
          <label class="truck-start-yard">
            <span>Start yard</span>
            <select data-truck-start="${escapeHtml(truck.id)}">${yardOptions(truck.base || "12441")}</select>
          </label>
          <label class="truck-start-yard">
            <span>Parking spot</span>
            <input data-truck-parking="${escapeHtml(truck.id)}" value="${escapeHtml(truck.parkingSpot || "")}" placeholder="A1" />
          </label>
        </div>
        <div class="truck-actions">
          <button data-action="add-load" data-truck="${escapeHtml(truck.id)}" title="${hasDriver ? insertText : "Assign driver first"}" ${hasDriver ? "" : "disabled"} type="button">+ Load</button>
          <button data-action="add-return-load" data-truck="${escapeHtml(truck.id)}" title="${hasDriver ? insertText : "Assign driver first"}" ${hasDriver ? "" : "disabled"} type="button">+ Return</button>
        </div>
      </div>
      <div class="truck-timeline">
        ${truck.loads.map((load) => renderLoad(truck, load)).join("")}
        <div class="timeline-drop-zone ${hasDriver ? "" : "locked"}" data-load-create="${escapeHtml(truck.id)}">${hasDriver ? "Drop order here<br>to create new load" : "Assign driver first"}</div>
      </div>
    </article>
  `;
}

function loadDriverOptions(selectedLogin = "") {
  const selected = String(selectedLogin || "").toLowerCase();
  return [
    `<option value="">${t("dispatch.unassigned", "Unassigned")}</option>`,
    ...drivers.map((driver) => {
      const login = driverKey(driver);
      return `<option value="${escapeHtml(login)}" ${login === selected ? "selected" : ""}>${escapeHtml(driver.name)} | ${escapeHtml(driver.license || "-")}</option>`;
    })
  ].join("");
}

function loadTruckOptions(selectedTruckId = "", { includePrompt = false } = {}) {
  const selected = String(selectedTruckId || "");
  return [
    ...(includePrompt ? [`<option value="">${t("dispatch.selectTruck", "Select truck")}</option>`] : []),
    ...trucks.map((truck) => `<option value="${escapeHtml(truck.id)}" ${String(truck.id) === selected ? "selected" : ""}>${escapeHtml(truck.plate)}</option>`)
  ].join("");
}

function renderDriverLane(lane, index = 0) {
  const login = String(lane.driverLogin || "").toLowerCase();
  const selectedTruck = defaultTruckForDriver(login);
  const isUnassigned = !login;
  const isHistorical = Boolean(lane.historical);
  const canReorder = isDispatchPlanEditor() && !isUnassigned && !isHistorical;
  const disabled = isDispatchPlanEditor() && !isUnassigned && !isHistorical ? "" : "disabled";
  const movableLaneCount = driverLaneOrder.length;
  return `
    <article class="truck-row driver-lane ${isUnassigned ? "driver-missing" : ""} ${isHistorical ? "historical-disabled-driver" : ""}" data-driver-lane="${escapeHtml(login)}" data-driver-lane-reorderable="${canReorder ? "true" : "false"}">
      <div class="driver-lane-sequence-controls">
        <button data-action="move-driver-up" data-driver-login="${escapeHtml(login)}" ${!canReorder || index <= 0 ? "disabled" : ""} title="Move driver lane up" type="button">&uarr;</button>
        <span class="driver-lane-marker" data-driver-lane-handle="${escapeHtml(login)}" draggable="${canReorder ? "true" : "false"}" aria-label="Drag ${escapeHtml(lane.driverName || login)} lane" title="${canReorder ? "Drag to reorder this driver lane" : "Lane reordering unavailable"}">${isUnassigned ? "?" : escapeHtml(String(lane.driverName || login).slice(0, 1).toUpperCase())}</span>
        <button data-action="move-driver-down" data-driver-login="${escapeHtml(login)}" ${!canReorder || index >= movableLaneCount - 1 ? "disabled" : ""} title="Move driver lane down" type="button">&darr;</button>
      </div>
      <div class="truck-label driver-label">
        <div>
          <strong>${escapeHtml(lane.driverName || t("dispatch.unassigned", "Unassigned"))}</strong>
          <span>${isUnassigned ? t("dispatch.assignLoadsBeforeConfirm", "Assign these loads before confirmation") : `${escapeHtml(lane.driver?.license || "-")} | ${tf("dispatch.driverLoadCount", "{count} load(s)", { count: lane.entries.length })}${isHistorical ? " | Disabled (historical plan)" : ""}`}</span>
        </div>
        <label class="truck-start-yard">
          <span>${t("dispatch.truckForNewLoad", "Truck for new load")}</span>
          <select data-driver-new-truck="${escapeHtml(login)}" ${disabled}>${loadTruckOptions(selectedTruck?.id || "", { includePrompt: true })}</select>
        </label>
        <div class="truck-actions">
          <button data-action="add-driver-load" data-driver-login="${escapeHtml(login)}" ${disabled || (!selectedTruck ? "disabled" : "")} type="button">${t("dispatch.addLoad", "+ Load")}</button>
          <button data-action="add-driver-return" data-driver-login="${escapeHtml(login)}" ${disabled || (!selectedTruck ? "disabled" : "")} type="button">${t("dispatch.addReturn", "+ Return")}</button>
        </div>
      </div>
      <div class="truck-timeline driver-lane-timeline" ${isHistorical ? "" : `data-driver-lane-drop="${escapeHtml(login)}"`}>
        ${lane.entries.map((entry, entryIndex) => `
          ${entryIndex > 0 ? renderTruckSwitchTransition(lane.entries[entryIndex - 1], entry) : ""}
          ${renderLoad(entry.truck, entry.load)}
        `).join("")}
        ${isHistorical ? `
          <div class="timeline-drop-zone locked">Historical driver retained for this saved plan. New loads are disabled.</div>
        ` : `
          <div class="timeline-drop-zone ${isUnassigned ? "unassigned-zone" : ""}" data-load-create-driver="${escapeHtml(login)}">
            ${isUnassigned ? t("dispatch.dropLoadToUnassign", "Drop a load here to unassign") : t("dispatch.dropOrderToCreateLoad", "Drop order here to create a load")}
          </div>
        `}
      </div>
    </article>
  `;
}

function renderLoadStartControl(parentTruck, load, { disabled = false, preview = false } = {}) {
  const startInfo = loadStartInfo(parentTruck, load);
  const startMode = resolvedLoadStartMode(load);
  const displayedTime = startMode === "fixed"
    ? (normalizeTypedDispatchTime(load.start) || timeText(startInfo.scheduledStart))
    : timeText(startInfo.start);
  const controlDisabled = disabled ? "disabled" : "";
  const timeDisabled = disabled || startMode === "auto" ? "disabled" : "";
  return `
    <div class="load-start-control ${preview ? "preview-load-start-control" : ""}">
      <label>
        <span>${t("dispatch.startMode", "Start mode")}</span>
        <select data-load-start-mode="${escapeHtml(load.id)}" ${controlDisabled}>
          <option value="auto" ${startMode === "auto" ? "selected" : ""}>${t("dispatch.autoInherit", "Auto inherit")}</option>
          <option value="fixed" ${startMode === "fixed" ? "selected" : ""}>${t("dispatch.dedicatedStart", "Dedicated time")}</option>
        </select>
      </label>
      <label>
        <span>${t("dispatch.start", "Start")}</span>
        <input data-load-start="${escapeHtml(load.id)}" type="text" inputmode="numeric" maxlength="5" autocomplete="off" placeholder="HH:MM" value="${escapeHtml(displayedTime)}" ${timeDisabled} />
      </label>
    </div>
  `;
}

function renderLoadAssignmentControls(parentTruck, load) {
  if (!driverOrientedPlanningEnabled()) return "";
  const truck = effectiveTruckForLoad(parentTruck, load);
  const startInfo = loadStartInfo(parentTruck, load);
  const controlDisabled = !isDispatchPlanEditor() || loadHasDriverActivity(load);
  const disabled = controlDisabled ? "disabled" : "";
  const advisories = assignmentAdvisoryByLoad.get(String(load.id)) || [];
  const firstUse = isFirstTruckUse(parentTruck, load);
  const showParking = firstUse && !startInfo.switchBefore;
  const assignedTruck = trucks.find((item) => String(item.id) === String(loadTruckId(parentTruck, load)))
    || trucks.find((item) => normalizedTruckPlate(item.plate) === loadTruckPlate(parentTruck, load))
    || parentTruck;
  return `
    <div class="load-assignment-controls ${firstUse ? "has-start-yard" : ""} ${showParking ? "has-parking" : ""}">
      <label><span>${t("dispatch.truck", "Truck")}</span><select data-load-truck="${escapeHtml(load.id)}" ${disabled}>${loadTruckOptions(truck.id)}</select></label>
      ${renderLoadStartControl(parentTruck, load, { disabled: controlDisabled })}
      ${firstUse ? `<label><span>${t("dispatch.startYard", "Start Yard")}</span><select data-plan-truck-base="${escapeHtml(assignedTruck.id)}" ${disabled}>${yardOptions(assignedTruck.base || loadSwitchYard(parentTruck, load), { includeUnknown: true })}</select></label>` : ""}
      ${showParking ? `<label><span>${t("dispatch.parking", "Parking")}</span><input data-load-parking="${escapeHtml(load.id)}" value="${escapeHtml(loadParkingSpot(parentTruck, load))}" placeholder="A1" ${disabled} /></label>` : ""}
      <span class="load-truck-meta">${formatLbs(truckCapacityLbs(truck))} | ${escapeHtml(travelAdjustmentText(truck))}</span>
      ${advisories.length ? `<div class="load-assignment-advisory">${advisories.map((item) => `<span>${escapeHtml(item.message)}</span>`).join("")}</div>` : ""}
    </div>
  `;
}

function renderLoad(parentTruck, load) {
  const truck = effectiveTruckForLoad(parentTruck, load);
  const isLocked = loadHasDriverActivity(load);
  const canDragLoad = isDispatchPlanEditor() && !isLocked;
  if (load.returnOnly) {
    const stats = loadStats(parentTruck, load);
    const executionStatus = returnExecutionStatus(parentTruck, load);
    const finishText = loadFinishText(parentTruck, load, stats);
    return `
      <section class="load-block return-only status-${executionStatus}" draggable="${canDragLoad}" data-driver-load-card="${escapeHtml(load.id)}">
        <div class="load-header">
          <button class="load-title return-load-title" data-action="select-load" data-load="${escapeHtml(load.id)}" type="button">
            <strong>${load.manual ? "Manual Return" : "Return Load"}</strong>
            <span class="${finishText === "Route pending" ? "route-pending" : ""}">${finishText === "Route pending" ? finishText : `Finish ${finishText}`}</span>
          </button>
          <div class="load-header-actions">
            <span class="load-drag-handle" draggable="${canDragLoad}" title="Drag this whole load to another driver" aria-label="Drag whole load">&#8942;&#8942;</span>
            <button class="load-insert-return" data-action="insert-driver-return" data-after-load="${escapeHtml(load.id)}" data-driver-login="${escapeHtml(loadDriverKey(parentTruck, load))}" ${isLocked ? "disabled" : ""} title="Insert a return after this load" type="button">+R</button>
            <button class="load-delete" data-action="delete-load" data-load="${escapeHtml(load.id)}" ${isLocked ? "disabled" : ""} title="${isLocked ? escapeHtml(loadActivityLockNotice(load)) : "Delete return load"}" type="button">x</button>
          </div>
        </div>
        ${renderLoadAssignmentControls(parentTruck, load)}
        <div class="return-yard-row">
          <label>
            <span>${t("dispatch.returnYard", "Return yard")}</span>
            <select data-return-yard="${escapeHtml(load.id)}" ${isDispatchPlanEditor() && !isLocked ? "" : "disabled"}>${yardOptions(load.returnYard || "12441")}</select>
          </label>
        </div>
        <div class="stop-list">
          ${stats.switchBefore ? "" : renderRestStop(stats)}
          <div class="empty-drop return-helper status-${executionStatus}">Return from previous load last stop</div>
        </div>
      </section>
    `;
  }
  const stats = loadStats(parentTruck, load);
  const active = selectedLoadId === load.id;
  const finishText = loadFinishText(parentTruck, load, stats);
  return `
    <section class="load-block ${stats.warningCount ? "warning" : ""} ${active ? "selected" : ""} ${isLocked ? "driver-active" : ""}" draggable="${canDragLoad}" data-driver-load-card="${escapeHtml(load.id)}" data-load-card="${escapeHtml(load.id)}">
      ${stats.warningCount ? `<span class="load-warning-badge">${stats.warningCount}</span>` : ""}
      <div class="load-header">
        <button class="load-title" data-action="select-load" data-load="${escapeHtml(load.id)}" type="button">
          <strong>${escapeHtml(load.name)}</strong>
          <span class="${finishText === "Route pending" ? "route-pending" : ""}">${finishText === "Route pending" ? finishText : `Finish ${finishText}`}</span>
        </button>
        <div class="load-header-actions">
          <span class="load-drag-handle" draggable="${canDragLoad}" title="Drag this whole load to another driver" aria-label="Drag whole load">&#8942;&#8942;</span>
          <button class="load-insert-return" data-action="insert-driver-return" data-after-load="${escapeHtml(load.id)}" data-driver-login="${escapeHtml(loadDriverKey(parentTruck, load))}" ${isLocked ? "disabled" : ""} title="Insert a return after this load" type="button">+R</button>
          <button class="load-delete" data-action="delete-load" data-load="${escapeHtml(load.id)}" ${isLocked ? "disabled" : ""} title="${isLocked ? escapeHtml(loadActivityLockNotice(load)) : "Delete load"}" type="button">x</button>
        </div>
      </div>
      ${renderLoadAssignmentControls(parentTruck, load)}
      <div class="stop-list" data-load="${escapeHtml(load.id)}">
        ${stats.switchBefore ? "" : renderRestStop(stats)}
        ${renderStartTravelStop(parentTruck, load, stats.startTravel, stats.start)}
        ${load.stops.map((stop, index) => renderStop(parentTruck, load, stop, index, stats.rows[index])).join("") || `<div class="empty-drop">Drop order here</div>`}
      </div>
    </section>
  `;
}

function renderTruckSwitchTransition(previousEntry, currentEntry) {
  if (!driverOrientedPlanningEnabled() || !previousEntry?.load || !currentEntry?.load) return "";
  const previousPlate = loadTruckPlate(previousEntry.truck, previousEntry.load);
  const nextPlate = loadTruckPlate(currentEntry.truck, currentEntry.load);
  if (!previousPlate || !nextPlate || previousPlate === nextPlate) return "";
  const stats = loadStats(currentEntry.truck, currentEntry.load);
  const disabled = isDispatchPlanEditor() && !loadHasDriverActivity(currentEntry.load) ? "" : "disabled";
  return `
    <section class="truck-switch-transition" data-truck-switch-for="${escapeHtml(currentEntry.load.id)}">
      <div class="truck-switch-transition-header">
        <div>
          <strong>${t("dispatch.truckSwitchTransition", "Truck Switch")}</strong>
          <span>${escapeHtml(previousEntry.load.name || "Previous load")} &rarr; ${escapeHtml(currentEntry.load.name || "Next load")}</span>
        </div>
        <span class="truck-switch-plates">${escapeHtml(previousPlate)} &rarr; ${escapeHtml(nextPlate)}</span>
      </div>
      <div class="truck-switch-transition-controls">
        <label><span>${t("driver.switchYard", "Switch Yard")}</span><select data-load-switch-yard="${escapeHtml(currentEntry.load.id)}" ${disabled}>${yardOptions(loadSwitchYard(currentEntry.truck, currentEntry.load))}</select></label>
        <label><span>${t("dispatch.parking", "Parking")}</span><input data-load-parking="${escapeHtml(currentEntry.load.id)}" value="${escapeHtml(loadParkingSpot(currentEntry.truck, currentEntry.load))}" placeholder="A1" ${disabled} /></label>
      </div>
      <div class="truck-switch-transition-steps">
        ${renderRestStop(stats)}
        ${renderSwitchApproachTravelStop(currentEntry.truck, currentEntry.load, stats)}
        ${renderTruckSwitchStop(currentEntry.truck, currentEntry.load, stats)}
      </div>
    </section>
  `;
}

function renderSwitchApproachTravelStop(truck, load, stats) {
  const travel = stats?.handoffTravel;
  if (!travel) return "";
  const record = driverRecordForSwitchApproach(truck, load, travel);
  const executionStatus = executionStatusFromRecord(record);
  return `
    <article class="stop-card compact travel-stop truck-switch-approach status-${executionStatus}">
      <div class="stop-main">
        <strong>Travel ${escapeHtml(travel.from)} to ${escapeHtml(travel.to)}</strong>
        <span>Reposition to the truck switch yard</span>
      </div>
      <div class="stop-time">${timingSummaryHtml({
        startLabel: "LV",
        endLabel: "Arr",
        plannedStart: stats.handoffStart,
        plannedEnd: stats.handoffFinish,
        actualStart: recordStartedAt(record),
        actualEnd: recordCompletedAt(record),
        showActual: executionStatus === "complete"
      })}</div>
    </article>
  `;
}

function renderTruckSwitchStop(truck, load, stats) {
  if (!stats?.switchBefore) return "";
  const previous = previousDriverLoad(truck, load);
  const previousPlate = previous ? loadTruckPlate(previous.truck, previous.load) : "";
  return `
    <article class="stop-card compact truck-switch-stop">
      <div class="stop-main">
        <strong>${tf("dispatch.switchTruck", "Switch {from} to {to}", { from: escapeHtml(previousPlate), to: escapeHtml(loadTruckPlate(truck, load)) })}</strong>
        <span>${escapeHtml(loadSwitchYard(truck, load))} | Parking ${escapeHtml(loadParkingSpot(truck, load) || "--")}</span>
      </div>
      <div class="stop-time"><span>${timeText(stats.switchStart || stats.previousFinish)}</span><span>${durationText(stats.switchMinutes)}</span></div>
    </article>
  `;
}

function renderRestStop(stats) {
  if (!Number(stats?.restBefore || 0)) return "";
  return `
    <article class="stop-card compact rest-stop">
      <div class="stop-main">
        <strong>Rest / Wait</strong>
        <span>Gap before next load</span>
      </div>
      <div class="stop-time"><span>${timeText(stats.previousFinish)}</span><span>${durationText(stats.restBefore)}</span></div>
    </article>
  `;
}

function renderStartTravelStop(truck, load, startTravel, start) {
  if (!startTravel) return "";
  const arrival = start + startTravel.minutes;
  const executionStatus = travelExecutionStatus(truck, load, startTravel);
  const record = driverRecordForTravel(truck, load, startTravel);
  return `
    <article class="stop-card compact travel-stop status-${executionStatus}">
      <div class="stop-main">
        <strong>Travel ${escapeHtml(startTravel.from)} to ${escapeHtml(startTravel.to)}</strong>
        <span>Empty truck reposition</span>
      </div>
      <div class="stop-time">${timingSummaryHtml({
        startLabel: "LV",
        endLabel: "Arr",
        plannedStart: start,
        plannedEnd: arrival,
        actualStart: recordStartedAt(record),
        actualEnd: recordCompletedAt(record),
        showActual: executionStatus === "complete"
      })}</div>
    </article>
  `;
}

function renderStop(truck, load, stop, index, row) {
  const order = stopOrder(stop);
  if (!order) return "";
  const isPick = stop.type === "pick";
  const executionStatus = stopExecutionStatus(truck, load, stop);
  const record = driverRecordForStop(truck, load, stop);
  const showWarning = Boolean(row?.warning && executionStatus !== "complete");
  const removalLocked = loadHasDriverActivity(load);
  return `
    <article class="stop-card compact status-${executionStatus} ${isPick ? "pick" : ""} ${selectedOrderId === order.id ? "selected-order-stop" : ""} ${showWarning ? "warning" : ""}" draggable="${isDispatchPlanEditor() && !removalLocked}" data-load="${escapeHtml(stop.loadId)}" data-stop="${escapeHtml(stop.id)}" data-order="${escapeHtml(order.id)}" data-index="${index}">
      <button class="stop-remove" data-action="remove-stop" data-stop="${escapeHtml(stop.id)}" ${removalLocked ? "disabled" : ""} title="${removalLocked ? escapeHtml(stopActivityLockNotice(stop)) : "Remove stop"}" type="button">x</button>
      <div class="stop-main">
        <strong>${index + 1}. ${escapeHtml(isPick ? `Pickup ${pickupStopLabel(stop, order)}` : dropStopLabel(stop, order))}</strong>
        <span>${escapeHtml(stopAddress(stop, order))}</span>
      </div>
      <div class="stop-time">${timingSummaryHtml({
        startLabel: "Arr",
        endLabel: "LV",
        plannedStart: row?.arrival || 0,
        plannedEnd: row?.depart || row?.arrival || 0,
        actualStart: recordStartedAt(record),
        actualEnd: recordCompletedAt(record),
        showActual: executionStatus === "complete"
      })}</div>
    </article>
  `;
}

function renderLoadTimingDetails(truck, load, stats) {
  const rows = [];
  if (stats.handoffTravel) {
    const record = driverRecordForSwitchApproach(truck, load, stats.handoffTravel);
    rows.push(timingDetailHtml({
      title: `Travel ${stats.handoffTravel.from} to ${stats.handoffTravel.to}`,
      startLabel: "Leave",
      endLabel: "Arrive",
      plannedStart: stats.handoffStart,
      plannedEnd: stats.handoffFinish,
      actualStart: recordStartedAt(record),
      actualEnd: recordCompletedAt(record)
    }));
  }
  if (stats.switchBefore) {
    const previous = previousDriverLoad(truck, load);
    const record = driverStatusByJobId().get(driverTruckSwitchJobIdForLoad(truck, load));
    rows.push(timingDetailHtml({
      title: `Switch ${loadTruckPlate(previous?.truck, previous?.load)} to ${loadTruckPlate(truck, load)}`,
      plannedStart: stats.switchStart || stats.previousFinish,
      plannedEnd: (stats.switchStart || stats.previousFinish) + stats.switchMinutes,
      actualStart: recordStartedAt(record),
      actualEnd: recordCompletedAt(record)
    }));
  }
  if (load.returnOnly) {
    const estimate = estimateForLoad(load);
    const record = driverRecordForReturn(truck, load);
    rows.push(timingDetailHtml({
      title: `Return ${load.returnYard || "12441"}`,
      startLabel: "Leave",
      endLabel: "Arrive",
      plannedStart: stats.start,
      plannedEnd: estimate ? stats.start + estimate.totalMinutes : stats.finish,
      actualStart: recordStartedAt(record),
      actualEnd: recordCompletedAt(record)
    }));
    return rows.join("");
  }
  if (stats.startTravel) {
    const record = driverRecordForTravel(truck, load, stats.startTravel);
    rows.push(timingDetailHtml({
      title: `Travel ${stats.startTravel.from} to ${stats.startTravel.to}`,
      startLabel: "Leave",
      endLabel: "Arrive",
      plannedStart: stats.start,
      plannedEnd: stats.start + stats.startTravel.minutes,
      actualStart: recordStartedAt(record),
      actualEnd: recordCompletedAt(record)
    }));
  }
  for (let index = 0; index < (load.stops || []).length; index += 1) {
    const stop = load.stops[index];
    const order = stopOrder(stop);
    const row = stats.rows[index];
    if (!order || !row) continue;
    const record = driverRecordForStop(truck, load, stop);
    rows.push(timingDetailHtml({
      title: stop.type === "pick" ? `Pickup ${pickupStopLabel(stop, order)}` : `Drop ${dropStopLabel(stop, order)}`,
      plannedStart: row.arrival || 0,
      plannedEnd: row.depart || row.arrival || 0,
      actualStart: recordStartedAt(record),
      actualEnd: recordCompletedAt(record)
    }));
  }
  return rows.join("") || `<div class="empty-drop">No stop timing available.</div>`;
}

function renderLoadPreview() {
  if (!loadPreviewOpen) return "";
  const { truck: parentTruck, load } = selectedLoad();
  if (!parentTruck || !load) return "";
  const truck = effectiveTruckForLoad(parentTruck, load);
  const stats = loadStats(parentTruck, load);
  const finishText = loadFinishText(parentTruck, load, stats);
  const isLocked = loadHasDriverActivity(load);
  const firstOrder = load.stops.map(stopOrder).find(Boolean);
  const pickupLocations = load.stops.length ? uniquePickupDisplayLabels(load, truck) : [];
  const pickupPoint = pickupLocations.join(", ") || firstOrder?.pickupLocations?.[0] || truck.base;
  const restOffset = stats.restBefore ? 1 : 0;
  const handoffOffset = stats.handoffTravel ? 1 : 0;
  const switchOffset = stats.switchBefore ? 1 : 0;
  const travelOffset = stats.startTravel ? 1 : 0;
  const stopOffset = restOffset + handoffOffset + switchOffset + travelOffset;
  const sequenceHtml = load.returnOnly
    ? renderReturnPreviewStops(load, parentTruck, stats)
    : `${renderPreviewRestStop(stats)}${renderPreviewSwitchApproachTravelStop(parentTruck, load, stats, restOffset)}${renderPreviewTruckSwitchStop(parentTruck, load, stats, restOffset + handoffOffset)}${renderPreviewStartTravelStop(parentTruck, load, stats.startTravel, stats.start, restOffset + handoffOffset + switchOffset)}${load.stops.map((stop, index) => renderPreviewStop(parentTruck, load, stop, index, stats.rows[index], index + stopOffset)).join("")}`;
  return `
    <aside class="load-preview-panel" style="width:${Math.min(Math.max(loadPreviewWidth, 390), Math.round(window.innerWidth * 0.92))}px">
      <div class="load-preview-resize" title="Drag to resize"></div>
      <div class="load-preview-header">
        <div>
          <h2>${escapeHtml(truck.plate)} | ${escapeHtml(load.name)}</h2>
          <p>${load.returnOnly ? `Return to ${escapeHtml(load.returnYard || "12441")}` : `${formatLbs(stats.weightTotalLbs)}/${formatLbs(stats.capacityLbs)} | ${stats.footprintTotal} pallet positions | Pickup ${escapeHtml(pickupPoint)}`}</p>
        </div>
        <button data-action="close-load-preview" type="button">x</button>
      </div>
      <div class="load-preview-body">
        <section class="preview-section sequence-section">
          <div class="preview-section-title">
            <strong>Stop Sequence</strong>
            <button class="sequence-toggle" data-action="toggle-sequence" type="button">${sequenceCollapsed ? "Expand" : "Collapse"}</button>
            <span>Drag stops to reorder. Multiple pick/drop is allowed.</span>
          </div>
          <div class="preview-stop-list ${sequenceCollapsed ? "collapsed" : ""}" data-load="${escapeHtml(load.id)}">
            ${sequenceHtml || `<div class="empty-drop">No assigned orders yet.</div>`}
          </div>
        </section>
        <section class="preview-section">
          <div class="preview-section-title">
            <strong>Maps Preview</strong>
            <span>Pickup yards and planned drop sequence.</span>
          </div>
          ${renderPreviewMap()}
        </section>
        <section class="preview-section">
          <div class="preview-section-title"><strong>Load Details</strong></div>
          <div class="preview-details-grid">
            ${renderLoadStartControl(parentTruck, load, { disabled: !isDispatchPlanEditor() || loadHasDriverActivity(load), preview: true })}
            <div><span>Finish</span><strong class="${finishText === "Route pending" ? "route-pending" : ""}">${finishText}</strong></div>
            <div><span>Rest before</span><strong>${stats.restBefore ? durationText(stats.restBefore) : "None"}</strong></div>
            <div><span>${load.returnOnly ? "Return route" : "Drive buffer"}</span><strong>${durationText(stats.returnTrip)}</strong></div>
            <div><span>Weight</span><strong>${formatLbs(stats.weightTotalLbs)}</strong></div>
            <div><span>Capacity</span><strong>${formatLbs(stats.capacityLbs)}</strong></div>
            <div><span>Pallet space</span><strong>${stats.footprintTotal} pos</strong></div>
            <div><span>Status</span><strong>${stats.capacityWarning ? "Over capacity" : stats.fullLoad ? "Full load" : "Open"}</strong></div>
          </div>
        </section>
        <section class="preview-section">
          <div class="preview-section-title">
            <strong>Planned vs Actual</strong>
            <span>Arrival/leave variance from driver PWA records.</span>
          </div>
          <div class="timing-detail-list">
            ${renderLoadTimingDetails(truck, load, stats)}
          </div>
        </section>
        <section class="preview-section">
          <div class="preview-section-title">
            <strong>Warning Details</strong>
            <span>${stats.warnings.length ? "Adjust load time or stop sequence." : "No issue detected for this load."}</span>
          </div>
          <div class="warning-detail-list">
            ${stats.warnings.map((warning) => `<div class="warning-detail">${escapeHtml(warning)}</div>`).join("") || `<div class="empty-drop">No warnings.</div>`}
          </div>
        </section>
        <section class="preview-section">
          <div class="preview-section-title"><strong>Assigned Orders</strong></div>
          <div class="assigned-order-list">
            ${[...new Set(load.stops.map((stop) => stop.orderId))].map((orderId) => {
              const order = orderById(orderId);
              if (!order) return "";
              return `<div><strong>${escapeHtml(order.id)}</strong><span>${escapeHtml(order.customer)} | ${orderFootprintPallets(order)} pos | ${formatLbs(orderWeightLbs(order))}</span></div>`;
            }).join("") || `<div class="empty-drop">No assigned orders.</div>`}
          </div>
        </section>
      </div>
      <div class="load-preview-footer">
        <button class="danger" data-action="delete-load" data-load="${escapeHtml(load.id)}" ${isLocked ? "disabled" : ""} title="${isLocked ? escapeHtml(loadActivityLockNotice(load)) : "Delete load"}" type="button">Delete Load</button>
        <button class="danger" data-action="clear-load" data-load="${escapeHtml(load.id)}" ${isLocked ? "disabled" : ""} title="${isLocked ? escapeHtml(loadActivityLockNotice(load)) : "Clear load"}" type="button">Clear Load</button>
      </div>
    </aside>
  `;
}

function renderPreviewRestStop(stats) {
  if (!Number(stats?.restBefore || 0)) return "";
  return `
    <article class="preview-stop rest">
      <div class="stop-main">
        <strong>1. Rest / Wait</strong>
        <span>Gap between previous load finish and this load start</span>
      </div>
      <div class="stop-time"><span>From ${timeText(stats.previousFinish)}</span><span>Leave ${timeText(stats.handoffStart ?? stats.switchStart ?? stats.start)}</span></div>
    </article>
  `;
}

function renderPreviewSwitchApproachTravelStop(truck, load, stats, displayOffset = 0) {
  const travel = stats?.handoffTravel;
  if (!travel) return "";
  const record = driverRecordForSwitchApproach(truck, load, travel);
  const executionStatus = executionStatusFromRecord(record);
  return `
    <article class="preview-stop travel truck-switch-approach status-${executionStatus}">
      <div class="stop-main">
        <strong>${displayOffset + 1}. Travel | ${escapeHtml(travel.from)} to ${escapeHtml(travel.to)}</strong>
        <span>Reposition to the truck switch yard</span>
      </div>
      <div class="stop-time">${timingSummaryHtml({
        startLabel: "LV",
        endLabel: "Arr",
        plannedStart: stats.handoffStart,
        plannedEnd: stats.handoffFinish,
        actualStart: recordStartedAt(record),
        actualEnd: recordCompletedAt(record),
        showActual: executionStatus === "complete"
      })}</div>
    </article>
  `;
}

function renderPreviewStartTravelStop(truck, load, startTravel, start, displayOffset = 0) {
  if (!startTravel) return "";
  const executionStatus = travelExecutionStatus(truck, load, startTravel);
  const record = driverRecordForTravel(truck, load, startTravel);
  return `
    <article class="preview-stop travel status-${executionStatus}">
      <div class="stop-main">
        <strong>${displayOffset + 1}. Travel | ${escapeHtml(startTravel.from)} to ${escapeHtml(startTravel.to)}</strong>
        <span>Empty truck reposition</span>
      </div>
      <div class="stop-time">${timingSummaryHtml({
        startLabel: "LV",
        endLabel: "Arr",
        plannedStart: start,
        plannedEnd: start + startTravel.minutes,
        actualStart: recordStartedAt(record),
        actualEnd: recordCompletedAt(record),
        showActual: executionStatus === "complete"
      })}</div>
    </article>
  `;
}

function renderPreviewTruckSwitchStop(truck, load, stats, displayOffset = 0) {
  if (!stats?.switchBefore) return "";
  const previous = previousDriverLoad(truck, load);
  const record = driverStatusByJobId().get(driverTruckSwitchJobIdForLoad(truck, load));
  const executionStatus = executionStatusFromRecord(record);
  return `
    <article class="preview-stop truck-switch status-${executionStatus}">
      <div class="stop-main">
        <strong>${displayOffset + 1}. Truck switch | ${escapeHtml(loadTruckPlate(previous?.truck, previous?.load))} to ${escapeHtml(loadTruckPlate(truck, load))}</strong>
        <span>${escapeHtml(loadSwitchYard(truck, load))} | Parking ${escapeHtml(loadParkingSpot(truck, load) || "--")}</span>
      </div>
      <div class="stop-time">${timingSummaryHtml({
        startLabel: "Start",
        endLabel: "End",
        plannedStart: stats.switchStart || stats.previousFinish,
        plannedEnd: (stats.switchStart || stats.previousFinish) + stats.switchMinutes,
        actualStart: recordStartedAt(record),
        actualEnd: recordCompletedAt(record),
        showActual: executionStatus === "complete"
      })}</div>
    </article>
  `;
}

function renderPreviewStop(truck, load, stop, index, row, displayIndex = index) {
  const order = stopOrder(stop);
  if (!order) return "";
  const label = stop.type === "pick" ? `${displayIndex + 1}. Pickup | ${pickupStopLabel(stop, order)}` : `${displayIndex + 1}. Drop | ${dropStopLabel(stop, order)}`;
  const sub = stopAddress(stop, order);
  const executionStatus = stopExecutionStatus(truck, load, stop);
  const record = driverRecordForStop(truck, load, stop);
  const showWarning = Boolean(row?.warning && executionStatus !== "complete");
  const removalLocked = loadHasDriverActivity(load);
  return `
    <article class="preview-stop status-${executionStatus} ${stop.type} ${selectedOrderId === order.id ? "selected-order-stop" : ""} ${showWarning ? "warning" : ""}" draggable="true" data-load="${escapeHtml(stop.loadId)}" data-stop="${escapeHtml(stop.id)}" data-order="${escapeHtml(order.id)}" data-index="${index}">
      <button class="stop-remove" data-action="remove-stop" data-stop="${escapeHtml(stop.id)}" ${removalLocked ? "disabled" : ""} title="${removalLocked ? escapeHtml(stopActivityLockNotice(stop)) : "Remove stop"}" type="button">x</button>
      <div class="stop-main">
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(sub)}</span>
      </div>
      <div class="stop-time">${timingSummaryHtml({
        startLabel: "Arr",
        endLabel: "LV",
        plannedStart: row?.arrival || 0,
        plannedEnd: row?.depart || row?.arrival || 0,
        actualStart: recordStartedAt(record),
        actualEnd: recordCompletedAt(record),
        showActual: executionStatus === "complete"
      })}</div>
    </article>
  `;
}

function renderReturnPreviewStops(load, truck, stats) {
  const stops = mapStopsForLoad(load, truck);
  const estimate = estimateForLoad(load);
  const finish = estimate ? timeText(stats.start + estimate.totalMinutes) : "Calculating";
  const restOffset = (stats.restBefore ? 1 : 0) + (stats.switchBefore ? 1 : 0);
  const executionStatus = returnExecutionStatus(truck, load);
  const record = driverRecordForReturn(truck, load);
  const stopHtml = stops.map((stop, index) => {
    const isStart = index === 0;
    const sub = isStart
      ? `Leave ${timeText(stats.start)}`
      : `Arrive ${finish} | Return yard`;
    return `
      <article class="preview-stop status-${executionStatus} ${isStart ? "drop" : "pick"}" data-load="${escapeHtml(load.id)}" data-index="${index}">
        <div class="stop-main">
          <strong>${index + restOffset + 1}. ${escapeHtml(stop.title)}</strong>
          <span>${isStart ? "Return route start" : "Return yard"}</span>
        </div>
        <div class="stop-time">${isStart
          ? timingSummaryHtml({
              startLabel: "LV",
              endLabel: "Arr",
              plannedStart: stats.start,
              plannedEnd: estimate ? stats.start + estimate.totalMinutes : stats.finish,
              actualStart: recordStartedAt(record),
              actualEnd: recordCompletedAt(record),
              showActual: executionStatus === "complete"
            })
          : `<span>${escapeHtml(sub)}</span>`}</div>
      </article>
    `;
  }).join("") || `<div class="empty-drop">No previous stop available for return route.</div>`;
  return `${renderPreviewRestStop(stats)}${renderPreviewTruckSwitchStop(truck, load, stats, stats.restBefore ? 1 : 0)}${stopHtml}`;
}

function renderPreviewMap() {
  const { truck, load } = selectedLoad();
  const pins = mapPins();
  const estimate = estimateForLoad(load);
  const allowTolls = Boolean(load?.allowTolls);
  return `
    <div class="google-map-preview" id="googleMapPreview">Loading map...</div>
    <div class="route-estimate-summary" id="routeEstimateSummary">
      ${estimate ? routeEstimateSummaryHtml(estimate, truck) : `<strong>Calculating route...</strong><span>Google travel time, truck adjustment, plus driver stop time.</span>`}
    </div>
    <div class="route-option-row">
      <button class="${allowTolls ? "" : "active"}" data-action="toggle-route-tolls" data-load="${escapeHtml(load?.id || "")}" type="button">
        ${allowTolls ? "Tolls Allowed" : "Avoid Tolls"}
      </button>
      <span>${allowTolls ? "Google may use toll roads for faster ETA." : "Default: route avoids toll roads."}</span>
    </div>
    ${dispatchConfig.googleMapsApiKey ? "" : `<div class="map-preview load-map-preview fallback-map-preview">
      <div class="route-line"></div>
      ${pins.map((pin) => `<div class="map-pin ${pin.className}" style="left:${pin.x}%;top:${pin.y}%">${pin.label}</div>`).join("")}
    </div>`}
  `;
}

function renderMap() {
  const pins = mapPins();
  const mapsUrl = googleMapsUrl();
  return `
    <section class="panel map-panel">
      <div class="panel-header">
        <h2>Route Preview</h2>
        <p>Planning preview now. Google Maps link can use API later.</p>
      </div>
      <div class="map-preview">
        <div class="route-line"></div>
        ${pins.map((pin) => `<div class="map-pin ${pin.className}" style="left:${pin.x}%;top:${pin.y}%">${pin.label}</div>`).join("")}
      </div>
      <div class="map-actions">
        <button class="primary" onclick="window.open('${mapsUrl}', '_blank')" type="button">Open Google Maps</button>
        <button data-action="optimize-route" type="button">Optimize Sequence</button>
      </div>
    </section>
  `;
}

function renderTransitCoEditor(order) {
  const originalPickup = order.transitOriginalPickupLocations?.[0] || order.transitCo?.fromYard || order.pickupLocations?.[0] || "3445";
  const toYard = order.transitCo?.toYard || "12441";
  const checked = order.transitCo ? "checked" : "";
  const sourceTypeLabel = order.childOrders?.length ? "grouped order" : order.type === "TO" ? "TO" : "SO";
  return `
    <section class="transit-co-editor">
      <label class="transit-check">
        <input name="createTransitCo" type="checkbox" ${checked} />
        <span>Initiate CO transit depot order</span>
      </label>
      <div class="transit-co-grid">
        <label class="split-field">
          <span>Pick from</span>
          <select name="transitFromYard">${yardOptions(originalPickup)}</select>
        </label>
        <label class="split-field">
          <span>Transit depot</span>
          <select name="transitToYard">${yardOptions(toYard)}</select>
        </label>
      </div>
      <p>Creates a local CO and changes this ${sourceTypeLabel} pickup yard to the transit depot. The CO must be planned before this ${sourceTypeLabel} can be dropped to a load.</p>
      ${order.transitCo ? `<strong>Current CO: ${escapeHtml(order.transitCo.id)}</strong>` : ""}
    </section>
  `;
}

async function loadOrderDependencyOptions(order, { transferOrderRef = "" } = {}) {
  if (!order?.id) return;
  const targetRef = order.id;
  const draft = getLinkModalDraft("to", targetRef);
  const requestRef = String(transferOrderRef ?? draft.ref).trim();
  draft.ref = requestRef;
  const sequence = ++orderDependencyRequestSequence;
  orderDependencyAbortController?.abort();
  orderDependencyAbortController = new AbortController();
  orderDependencyLoading = true;
  orderDependencyError = "";
  renderActiveLinkModalInPlace();
  const params = new URLSearchParams({
    dispatchTargetRef: targetRef,
    transferOrderRef: requestRef,
    planDate: currentPlanDate
  });
  try {
    const response = await fetch(`/api/dispatch/order-dependencies/options?${params}`, {
      signal: orderDependencyAbortController.signal
    });
    if (!response.ok) throw new Error(await dispatchErrorMessage(response));
    const payload = await response.json();
    if (sequence !== orderDependencyRequestSequence || modalType !== "to-link" || modalOrderId !== targetRef) return;
    orderDependencyOptions = payload;
    if (draft.targetSignature && draft.targetSignature !== payload.targetSignature) {
      draft.structureWarning = `${targetRef} changed while this window was open. Review the refreshed matching quantities.`;
    } else {
      draft.structureWarning = "";
    }
    draft.targetSignature = payload.targetSignature || "";
    for (const line of payload.matchingLines || []) {
      if (draft.quantities[line.targetLineKey] === undefined) {
        draft.quantities[line.targetLineKey] = { ...(line.suggestedQuantities || { salesQty: Number(line.suggestedQuantity || 0) }) };
      }
    }
  } catch (error) {
    if (error.name === "AbortError" || sequence !== orderDependencyRequestSequence) return;
    orderDependencyError = error.message || "Unable to load Link TO options.";
    orderDependencyOptions = null;
  } finally {
    if (sequence === orderDependencyRequestSequence) {
      orderDependencyLoading = false;
      renderActiveLinkModalInPlace();
    }
  }
}

function renderDependencyLinks(links = []) {
  if (!links.length) return `<div class="muted">No active linked Transfer Order.</div>`;
  return links.map((dependency) => `
    <div class="order-dependency-linked">
      <div>
        <strong>${escapeHtml(dependency.transferOrderRef)} linked with ${escapeHtml(dependency.dispatchTargetRef || dependency.salesOrderRef)}</strong>
        <span>${escapeHtml(dependency.status)} | ${escapeHtml(dependency.reconciliationStatus || "pending")}</span>
      </div>
      <select data-dependency-mode="${dependency.id}">
        <option value="direct_to_customer" ${dependency.mode === "direct_to_customer" ? "selected" : ""}>Direct pickup</option>
        <option value="yard_replenishment" ${dependency.mode === "yard_replenishment" ? "selected" : ""}>Replenishment</option>
      </select>
      <button class="dependency-action-button" data-action="update-dependency-mode" data-dependency="${dependency.id}" type="button">Update</button>
      <button class="danger-text dependency-action-button" data-action="unlink-dependency" data-dependency="${dependency.id}" type="button">Unlink</button>
    </div>
    <div class="order-dependency-lines">
      ${(dependency.lines || []).map((line) => `<span><b>${escapeHtml(line.sourceOrderRef ? `${line.sourceOrderRef} | ` : "")}${escapeHtml(line.itemName)}</b> ${escapeHtml(itemQtyText({
        pallets: line.palletQty,
        layers: line.layerQty,
        sections: line.sectionQty,
        pieces: line.pieceQty,
        salesQty: line.allocatedQuantity,
        unit: line.unit
      }))}</span>`).join("")}
    </div>
  `).join("");
}

function renderToLinkModal(order) {
  const options = orderDependencyOptions || {};
  const draft = getLinkModalDraft("to", order.id);
  const links = options.existingLinks || order.orderDependencies || [];
  const transferOrders = options.transferOrders || [];
  const matchingLines = options.matchingLines || [];
  const matchError = options.matchError || "";
  return `
    <div class="modal-backdrop show" data-link-modal="true">
      <section class="dispatch-modal wide-modal">
        <div class="modal-header">
          <div>
            <h2>Link TO</h2>
            <p>${escapeHtml(order.id)}${options.dispatchTargetKind && options.dispatchTargetKind !== "normal" ? ` | ${escapeHtml(options.dispatchTargetKind)}` : ""}</p>
          </div>
          <button data-action="close-modal" type="button">Close</button>
        </div>
        <div class="modal-body">
          <section class="order-dependency-editor">
            <div class="order-dependency-head">
              <div><strong>Active links</strong><span>One TO can allocate several item lines from this dispatch order.</span></div>
            </div>
            ${renderDependencyLinks(links)}
          </section>
          <form class="po-link-form" data-form="to-link">
            <div class="order-dependency-link-grid">
              <label><span>Sales Order target</span><input value="${escapeHtml(order.id)}" readonly /></label>
              <div class="to-link-ref-field"><label for="toLinkRef">Transfer Order</label><div class="to-link-ref-control"><input id="toLinkRef" list="toLinkOptions" value="${escapeHtml(draft.ref)}" placeholder="Type TO number" autocomplete="off" /><button data-action="match-to-link-lines" type="button">Match Lines</button></div></div>
              <label><span>Mode</span><select id="toLinkMode"><option value="direct_to_customer" ${draft.mode === "direct_to_customer" ? "selected" : ""}>Direct pickup</option><option value="yard_replenishment" ${draft.mode === "yard_replenishment" ? "selected" : ""}>Replenishment</option></select></label>
            </div>
            <datalist id="toLinkOptions">${transferOrders.filter((entry) => !entry.linkedSalesOrderRef || entry.linkedSalesOrderRef === order.id).map((entry) => `<option value="${escapeHtml(entry.ref)}">${escapeHtml(entry.fromLocation || "")} to ${escapeHtml(entry.toLocation || "")}</option>`).join("")}</datalist>
            ${orderDependencyLoading ? `<div class="empty-drop">Matching Transfer Order lines...</div>` : ""}
            ${orderDependencyError ? `<div class="warning-detail">Link TO options failed: ${escapeHtml(orderDependencyError)}</div>` : ""}
            ${draft.structureWarning ? `<div class="warning-detail">${escapeHtml(draft.structureWarning)} <button data-action="refresh-to-link-match" type="button">Refresh Match</button></div>` : ""}
            <div class="order-dependency-match-lines">
              ${matchingLines.map((line, index) => {
                const units = availableUnitsForLine({ available: line.available, required: { unit: line.unit } });
                const saved = typeof draft.quantities[line.targetLineKey] === "object" ? draft.quantities[line.targetLineKey] : {};
                const values = { ...(line.suggestedQuantities || {}), ...saved };
                const equivalent = linkSalesQuantityFromValues(values, line.conversions || {});
                return `<section class="link-quantity-line to-link-line" data-target-line-key="${escapeHtml(line.targetLineKey)}" data-dependency-item="${line.itemId}" data-to-plt="${Number(line.conversions?.pallets || 0)}" data-to-lyr="${Number(line.conversions?.layers || 0)}" data-to-sec="${Number(line.conversions?.sections || 0)}" data-to-pcs="${Number(line.conversions?.pieces || 0)}" data-sales-unit="${escapeHtml(line.unit || "Qty")}">
                  <div class="link-quantity-info"><strong>${escapeHtml(line.sku || line.itemName)}</strong>${line.sourceOrderRef && line.sourceOrderRef !== order.id ? `<span>${escapeHtml(line.sourceOrderRef)}</span>` : ""}<em>SO open ${escapeHtml(availableQtyTextForLine({ available: line.available, required: { unit: line.unit } }))} | TO ${escapeHtml(itemQtyText({ ...(line.transferDisplay || {}), salesQty: line.transferDisplay?.salesQty, unit: line.unit }))}</em><em class="link-sales-equivalent" data-link-sales-equivalent>Selected ${escapeHtml(qtyText(equivalent))} ${escapeHtml(line.unit || "Qty")}</em></div>
                  <div class="link-quantity-units">${units.map(([field, label, max]) => `<label><span>${escapeHtml(label)}</span><input id="toLinkQty-${index}-${field}" data-to-link-qty="${field}" data-target-line-key="${escapeHtml(line.targetLineKey)}" type="number" inputmode="decimal" min="0" max="${Number(max || 0)}" step="${linkQuantityInputStep()}" value="${escapeHtml(values[field] ?? 0)}" /></label>`).join("")}</div>
                </section>`;
              }).join("") || (!orderDependencyLoading ? (matchError ? `<div class="warning-detail">${escapeHtml(matchError)}</div>` : `<span class="muted">Type a Transfer Order number, then press Match Lines.</span>`) : "")}
            </div>
            <div class="modal-status" data-modal-status></div>
            <div class="modal-footer">
              <button data-action="close-modal" type="button">Cancel</button>
              <button class="primary" type="submit" ${matchingLines.length && !draft.structureWarning ? "" : "disabled"}>Link Transfer Order</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  `;
}


function renderPoLinkMatchBoard(order, salesLines, poLines, draft) {
  const normalizedRef = String(draft.ref || "").trim().toLowerCase();
  const selectedPoLines = poLines.filter(
    (line) => String(line.poRef || "").trim().toLowerCase() === normalizedRef
  );
  if (!normalizedRef) {
    return `<div class="po-match-empty">Choose a purchase order to start matching its lines.</div>`;
  }
  if (!selectedPoLines.length) {
    return `<div class="po-match-empty">No lines found for <strong>${escapeHtml(draft.ref)}</strong>. Choose a purchase order from the list.</div>`;
  }

  const pendingLine = salesLines.find(
    (line) => String(line.targetLineKey) === String(draft.pendingSoLineKey || "")
  );
  const connections = salesLines.map((line) => {
    const poLineId = String(draft.poLineIds[line.targetLineKey] || "");
    const poLine = selectedPoLines.find((candidate) => String(candidate.id) === poLineId);
    const matchMeta = poLine ? poLinkMatchMeta(line, poLine.id, draft.ref) : null;
    return poLine && matchMeta ? { line, poLine, matchMeta } : null;
  }).filter(Boolean);
  const linkedCountByPo = connections.reduce((counts, connection) => {
    const key = String(connection.poLine.id);
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map());
  const unmatchedCount = salesLines.length - connections.length;

  return `
    <div class="po-match-guide">
      <strong>Match PO and SO lines</strong>
      <span>Drag an SO card onto its PO card. You can also click the SO card, then click the PO card.</span>
    </div>
    <div class="po-match-board">
      <section class="po-match-column po-match-so-column">
        <header><span>1</span><div><strong>Sales order lines</strong><small>${salesLines.length} line(s)</small></div></header>
        <div class="po-match-card-list" data-po-match-scroll="so">
          ${salesLines.map((line) => {
            const mappedPoId = String(draft.poLineIds[line.targetLineKey] || "");
            const mappedPoLine = selectedPoLines.find((candidate) => String(candidate.id) === mappedPoId);
            const selected = String(draft.pendingSoLineKey || "") === String(line.targetLineKey);
            return `
              <button class="po-match-card po-match-so-card ${mappedPoLine ? "mapped" : ""} ${selected ? "selected" : ""}"
                data-action="select-po-map-so" data-po-map-so="true" data-target-line-key="${escapeHtml(line.targetLineKey || "")}"
                draggable="true" type="button" aria-pressed="${selected ? "true" : "false"}">
                <span class="po-match-card-top"><b>${escapeHtml(line.sourceOrderRef || order.id)}</b><em>SO line ${escapeHtml(line.lineId || line.id || "--")}</em></span>
                <strong>${escapeHtml(line.sku || line.itemName)}</strong>
                <span class="po-match-card-description">${escapeHtml(line.description || "No description")}</span>
                <span class="po-match-card-qty">Open ${escapeHtml(availableQtyTextForLine(line))}</span>
                ${mappedPoLine ? `<span class="po-match-card-state connected">Connected to PO line ${escapeHtml(mappedPoLine.lineId || mappedPoLine.id)}</span>` : `<span class="po-match-card-state">Drag or click to connect</span>`}
              </button>
            `;
          }).join("") || `<div class="po-match-empty">No SO lines available.</div>`}
        </div>
      </section>

      <section class="po-match-column po-match-connections-column">
        <header><span>2</span><div><strong>Connections</strong><small data-po-match-counts>${connections.length} matched · ${unmatchedCount} remaining</small></div></header>
        <div class="po-match-connector-list" data-po-match-scroll="connections">
          ${connections.map(({ line, poLine, matchMeta }) => `
            <div class="po-match-connector ${matchMeta.exactMatch ? "exact" : "manual"}">
              <span class="po-match-connector-line" aria-hidden="true">→</span>
              <div>
                <strong>${escapeHtml(line.sourceOrderRef || order.id)} #${escapeHtml(line.lineId || line.id || "--")}</strong>
                <span>to ${escapeHtml(poLine.poRef)} #${escapeHtml(poLine.lineId || poLine.id || "--")}</span>
                <em>${matchMeta.exactMatch ? "Exact description + unit" : `Manual match${!matchMeta.descriptionMatch ? " · description differs" : ""}${!matchMeta.unitMatch ? " · unit differs" : ""}`}</em>
              </div>
              <button data-action="remove-po-line-match" data-target-line-key="${escapeHtml(line.targetLineKey || "")}" type="button" aria-label="Remove this match">×</button>
            </div>
          `).join("") || `<div class="po-match-connector-empty">Select an SO line to begin.</div>`}
        </div>
      </section>

      <section class="po-match-column po-match-po-column">
        <header><span>3</span><div><strong>${escapeHtml(selectedPoLines[0]?.poRef || draft.ref)} lines</strong><small>${selectedPoLines.length} line(s)</small></div></header>
        <div class="po-match-card-list" data-po-match-scroll="po">
          ${selectedPoLines.map((poLine) => {
            const matchMeta = pendingLine ? poLinkMatchMeta(pendingLine, poLine.id, draft.ref) : null;
            const linkedCount = linkedCountByPo.get(String(poLine.id)) || 0;
            const stateClass = !pendingLine ? "waiting" : (matchMeta ? (matchMeta.exactMatch ? "exact" : "compatible") : "incompatible");
            const stateText = !pendingLine ? "Select SO first" : (matchMeta ? (matchMeta.exactMatch ? "Exact match" : "Manual match allowed") : "Different item");
            return `
              <button class="po-match-card po-match-po-card ${stateClass} ${linkedCount ? "mapped" : ""}"
                data-action="select-po-map-po" data-po-map-po="true" data-po-line-id="${poLine.id}" type="button"
                aria-disabled="${pendingLine && !matchMeta ? "true" : "false"}">
                <span class="po-match-card-top"><b>${escapeHtml(poLine.poRef)}</b><em>PO line ${escapeHtml(poLine.lineId || poLine.id || "--")}</em></span>
                <strong>${escapeHtml(poLine.sku || poLine.itemName)}</strong>
                <span class="po-match-card-description">${escapeHtml(poLine.description || "No description")}</span>
                <span class="po-match-card-qty">Open ${escapeHtml(availableQtyTextForLine(poLine))}</span>
                <span class="po-match-card-state">${escapeHtml(stateText)}${linkedCount ? ` · ${linkedCount} connection(s)` : ""}</span>
              </button>
            `;
          }).join("")}
        </div>
      </section>
    </div>
  `;
}

function renderPoLinkModal(order) {
  const options = poAllocationOptions;
  const draft = getLinkModalDraft("po", order.id);
  draft.poLineIds ||= {};
  draft.pendingSoLineKey ||= "";
  const salesLines = options?.salesLines || [];
  const poLines = options?.poLines || [];
  const allocations = options?.allocations || [];
  const poRefs = [...new Map(poLines.map((line) => [line.poRef, line])).values()];
  const selectedPoLines = poLinkLinesForRef(draft.ref);
  const matchableSalesLines = selectedPoLines.length
    ? salesLines.filter((line) => poLinkCandidateLinesForSalesLine(line, draft.ref).length)
    : salesLines;
  return `
    <div class="modal-backdrop show" data-link-modal="true">
      <section class="dispatch-modal wide-modal">
        <div class="modal-header">
          <div>
            <h2>Link PO Pickup</h2>
            <p>${order.id} | vendor pickup quantity will be removed from yard packing</p>
          </div>
          <button data-action="close-modal" type="button">Close</button>
        </div>
        <div class="modal-body">
          ${poAllocationLoading ? `<div class="empty-drop">Loading matching PO lines...</div>` : ""}
          ${poAllocationError ? `<div class="warning-detail">Link PO options failed: ${escapeHtml(poAllocationError)}</div>` : ""}
          ${draft.structureWarning ? `<div class="warning-detail">${escapeHtml(draft.structureWarning)} <button data-action="refresh-po-link-options" type="button">Refresh Match</button></div>` : ""}
          ${allocations.length ? `
            <div class="allocation-list">
              <strong>Active linked PO quantity</strong>
              ${allocations.map((item) => `
                <div class="allocation-card">
                  <span>${escapeHtml(item.sku || item.itemName)} | ${escapeHtml(item.poOrderRef)} ${escapeHtml(item.poVendorYard || item.poVendor || "")}</span>
                  <b>${itemQtyText(item)}</b>
                  <button class="danger-text" data-action="cancel-po-link" data-allocation="${item.id}" type="button">Cancel</button>
                </div>
              `).join("")}
            </div>
          ` : ""}
          <form class="po-link-form" data-form="po-link" novalidate>
            <label class="split-field">
              <span>Purchase order</span>
              <input id="poLinkRef" name="poRef" value="${escapeHtml(draft.ref)}" list="poLinkPoOptions" placeholder="Type PO number" autocomplete="off" required />
              <datalist id="poLinkPoOptions">
                ${poRefs.map((line) => `
                  <option value="${escapeHtml(line.poRef)}">${escapeHtml(line.vendorYard || line.vendor)} | ${escapeHtml(line.address || "")}</option>
                `).join("")}
              </datalist>
            </label>
            ${renderPoLinkMatchBoard(order, matchableSalesLines, poLines, draft)}
            <div class="po-link-quantity-heading">
              <strong>Connected quantities</strong>
              <span>Only connected SO lines can be entered below.</span>
            </div>
            <div class="po-link-lines">
              ${matchableSalesLines.map((line, index) => {
                const units = availableUnitsForLine(line);
                const selectedPoLineId = String(draft.poLineIds[line.targetLineKey] || "");
                const selectedPoLine = selectedPoLines.find((poLine) => String(poLine.id) === selectedPoLineId);
                const matchMeta = selectedPoLine ? poLinkMatchMeta(line, selectedPoLine.id, draft.ref) : null;
                const selectedPoHasItem = Boolean(selectedPoLine && matchMeta);
                const values = Object.fromEntries(units.map(([field]) => [field, draft.quantities[line.targetLineKey]?.[field] ?? 0]));
                const equivalent = linkSalesQuantityFromValues(values, line.conversions || {});
                return `
                <section class="po-link-line link-quantity-line" data-sales-line="${line.id}" data-target-line-key="${escapeHtml(line.targetLineKey || "")}" data-to-plt="${Number(line.conversions?.pallets || 0)}" data-to-lyr="${Number(line.conversions?.layers || 0)}" data-to-sec="${Number(line.conversions?.sections || 0)}" data-to-pcs="${Number(line.conversions?.pieces || 0)}" data-sales-unit="${escapeHtml(line.required?.unit || "Qty")}">
                  <div class="link-quantity-info">
                    <strong>${escapeHtml(line.sku || line.itemName)}</strong>
                    ${line.sourceOrderRef && line.sourceOrderRef !== order.id ? `<span>${escapeHtml(line.sourceOrderRef)}</span>` : ""}
                    <span>${escapeHtml(line.description || "")}</span>
                    <em>Open ${availableQtyTextForLine(line)}</em>
                    <em class="link-sales-equivalent" data-link-sales-equivalent>Selected ${escapeHtml(qtyText(equivalent))} ${escapeHtml(line.required?.unit || "Qty")}</em>
                    ${selectedPoHasItem ? `
                      <span class="po-link-qty-match connected">${matchMeta.exactMatch ? "Exact" : "Manual"} match · ${escapeHtml(selectedPoLine.poRef)} line ${escapeHtml(selectedPoLine.lineId || selectedPoLine.id)}</span>
                    ` : `<span class="po-link-qty-match">Not connected — match this SO line above to enter quantity.</span>`}
                  </div>
                  <div class="link-quantity-units">${units.map(([field, label, max]) => `
                    <label><span>${escapeHtml(label)}</span><input id="poLinkQty-${index}-${field}" data-po-link-qty="${field}" type="number" inputmode="decimal" min="0" max="${Number(max || 0)}" step="${linkQuantityInputStep()}" value="${escapeHtml(values[field] ?? 0)}" ${selectedPoHasItem ? "" : "disabled"} /></label>
                  `).join("") || `<span class="muted">No available quantity</span>`}</div>
                </section>
              `; }).join("")}
            </div>
            <div class="warning-detail">
              Item code controls which cards can connect. For MBBS-Special, description and sales unit identify an exact match; when either differs, the connection is clearly saved as a manual line match. Physical quantities and sales quantity remain independent.
            </div>
            <div class="modal-status" data-modal-status></div>
            <div class="modal-footer">
              <button data-action="close-modal" type="button">Cancel</button>
              <button class="primary" ${matchableSalesLines.length && !draft.structureWarning ? "" : "disabled"} type="submit">Connect PO Quantity</button>
            </div>
          </form>
          ${!poAllocationLoading && !salesLines.length ? `<div class="empty-drop">No SO item line was found.</div>` : ""}
        </div>
      </section>
    </div>
  `;
}

function renderModal() {
  if (!modalType) return "";
  if (modalType === "plan-history") {
    return `
      <div class="modal-backdrop show">
        <section class="dispatch-modal plan-history-modal">
          <div class="modal-header">
            <div>
              <h2>Plan History</h2>
              <p>Open confirmed or draft plans by date.</p>
            </div>
            <button data-action="close-modal" type="button">Close</button>
          </div>
          <div class="modal-body">
            <div class="audit-toolbar">
              <button data-action="refresh-plan-history" type="button">Refresh</button>
              <span class="muted">${planHistory.length} plans</span>
            </div>
            <div class="plan-history-list">
              ${planHistory.map((plan) => `
                <button class="plan-history-card ${currentPlan?.id === plan.id ? "selected" : ""}" data-action="load-plan-id" data-plan-id="${plan.id}" type="button">
                  <strong>${escapeHtml(displayDate(plan.planDate))} | ${escapeHtml(String(plan.status || "").toUpperCase())}</strong>
                  <span>Saved ${plan.savedAt ? displayDateTime(plan.savedAt) : "--"}${plan.confirmedAt ? ` | Confirmed ${displayDateTime(plan.confirmedAt)}` : ""}</span>
                  <span>${plan.summary ? `${plan.summary.planned || 0} planned | ${plan.summary.warnings || 0} warnings` : ""}</span>
                </button>
              `).join("") || `<div class="empty-drop">No dispatch plans yet.</div>`}
            </div>
          </div>
        </section>
      </div>
    `;
  }
  const order = orderById(modalOrderId) || selectedOrder();
  if (!order) return "";
  if (modalType === "edit-order") {
    return `
      <div class="modal-backdrop show">
        <section class="dispatch-modal wide-modal">
          <div class="modal-header">
            <div>
              <h2>Edit Dispatch Info</h2>
              <p>${order.id} | ${escapeHtml(order.customer)}</p>
            </div>
            <button data-action="close-modal" type="button">Close</button>
          </div>
          <form class="modal-body" data-form="edit-order-details">
            <label class="split-field">
              <span>Expected date</span>
              <input name="expectedDeliveryDate" type="date" value="${escapeHtml(order.expectedDeliveryDate || "")}" />
            </label>
            <label class="split-field">
              <span>Delivery address</span>
              <input name="address" value="${escapeHtml(order.address || "")}" placeholder="Address" required />
            </label>
            <label class="split-field">
              <span>Pickup address override <small>(optional)</small></span>
              <input name="pickupAddress" value="${escapeHtml(order.pickupAddressOverride || "")}" placeholder="Leave blank to use the mapped pickup location" />
            </label>
            <div class="split-row">
              <label class="split-field">
                <span>Start time</span>
                <input name="windowStart" value="${escapeHtml(modalTimeValue(order.windowStart))}" placeholder="0700" inputmode="numeric" maxlength="4" />
              </label>
              <label class="split-field">
                <span>End time</span>
                <input name="windowEnd" value="${escapeHtml(modalTimeValue(order.windowEnd))}" placeholder="1900" inputmode="numeric" maxlength="4" />
              </label>
            </div>
            ${supportsTransitCoForOrder(order) ? renderTransitCoEditor(order) : ""}
            <div class="modal-status" data-edit-status></div>
            <div class="modal-footer">
              <button data-action="close-modal" type="button">Cancel</button>
              <button class="primary" type="submit">Save Dispatch Info</button>
            </div>
          </form>
        </section>
      </div>
    `;
  }
  if (modalType === "po-link") {
    return renderPoLinkModal(order);
  }
  if (modalType === "to-link") {
    return renderToLinkModal(order);
  }
  if (modalType === "group") {
    const selected = selectedOrders();
    const candidates = selected.length > 1 ? selected : [];
    return `
      <div class="modal-backdrop show">
        <section class="dispatch-modal">
          <div class="modal-header">
            <div>
              <h2>Group Orders</h2>
              <p>${selected.length > 1 ? `${selected.length} selected orders` : escapeHtml(order.address)}</p>
            </div>
            <button data-action="close-modal" type="button">Close</button>
          </div>
          <div class="modal-body">
            ${candidates.map((item) => `
              <label class="modal-choice">
                <input type="checkbox" checked disabled />
                <strong>${item.id}</strong>
                <span>${escapeHtml(item.customer)} | ${orderFootprintPallets(item)} pos | ${formatLbs(orderWeightLbs(item))}</span>
              </label>
            `).join("")}
          </div>
          <div class="modal-footer">
            <button data-action="close-modal" type="button">Cancel</button>
            <button class="primary" data-action="confirm-group" data-order="${order.id}" type="button">Add Group to Selected Load</button>
          </div>
        </section>
      </div>
    `;
  }
  if (modalType === "consolidate") {
    const yards = consolidateYards(order);
    return `
      <div class="modal-backdrop show">
        <section class="dispatch-modal">
          <div class="modal-header">
            <div>
              <h2>Consolidate Pick</h2>
              <p>${order.id} shortage ${shortageQty(order)} sales units</p>
            </div>
            <button data-action="close-modal" type="button">Close</button>
          </div>
          <div class="modal-body">
            ${yards.map((item) => `
              <button class="modal-choice yard-choice" data-action="confirm-consolidate" data-order="${order.id}" data-yard="${item.yard}" type="button">
                <strong>Transfer from ${item.yard}</strong>
                <span>${item.available} available, shortage ${shortageQty(order)}</span>
              </button>
            `).join("") || `<div class="empty-drop">No yard has enough available quantity for this shortage.</div>`}
          </div>
          <div class="modal-footer">
            <button data-action="close-modal" type="button">Cancel</button>
          </div>
        </section>
      </div>
    `;
  }
  if (modalType === "po-yard") {
    const relatedYards = vendorYardOptionsForOrder(order);
    const vendorOptions = relatedYards
      .map((row) => `<option value="${row.id}" ${order.vendorYard === row.yard ? "selected" : ""}>${escapeHtml(row.vendor)} | ${escapeHtml(row.yard)} | ${escapeHtml(row.dayLabel)} ${row.windowStart || ""}-${row.windowEnd || ""}</option>`)
      .join("");
    return `
      <div class="modal-backdrop show">
        <section class="dispatch-modal">
          <div class="modal-header">
            <div>
              <h2>Set PO Vendor Yard</h2>
              <p>${order.id} | ${escapeHtml(order.customer)}</p>
            </div>
            <button data-action="close-modal" type="button">Close</button>
          </div>
          <div class="modal-body">
            <label class="split-field">
              <span>Vendor yard</span>
              <select id="poVendorYardSelect" ${vendorOptions ? "" : "disabled"}>${vendorOptions}</select>
            </label>
            <div class="warning-detail">${vendorOptions ? "Use this when the memo does not clearly identify the pickup yard." : "No vendor yard setup matches this PO vendor. Add or correct this vendor in Dispatch Setup first."}</div>
          </div>
          <div class="modal-footer">
            <button data-action="close-modal" type="button">Cancel</button>
            <button class="primary" data-action="confirm-po-yard" data-order="${order.id}" ${vendorOptions ? "" : "disabled"} type="button">Update PO Yard</button>
          </div>
        </section>
      </div>
    `;
  }
  if (modalType === "split") {
    const blockReason = splitBlockReason(order);
    if (blockReason) {
      return `
        <div class="modal-backdrop show">
          <section class="dispatch-modal">
            <div class="modal-header">
              <div>
                <h2>Split Blocked</h2>
                <p>${order.id}</p>
              </div>
              <button data-action="close-modal" type="button">Close</button>
            </div>
            <div class="modal-body">
              <div class="warning-detail">${escapeHtml(blockReason)}</div>
            </div>
            <div class="modal-footer">
              <button data-action="close-modal" type="button">Cancel</button>
              ${order.operatorStatus === "packed" ? `<button class="primary" data-action="request-unpack-for-split" data-order="${order.id}" type="button">Request Unpack</button>` : ""}
            </div>
          </section>
        </div>
      `;
    }
    ensureSplitDraft(order);
    return `
      <div class="modal-backdrop show">
        <section class="dispatch-modal wide-modal">
          <div class="modal-header">
            <div>
              <h2>Split Order</h2>
              <p>${order.id} | unit-based split | ${formatLbs(orderWeightLbs(order))}</p>
            </div>
            <button data-action="close-modal" type="button">Close</button>
          </div>
          <div class="modal-body">
            <label class="split-field">
              <span>Number of sub-orders</span>
              <input id="splitParts" type="number" min="2" max="10" value="${splitParts}" />
            </label>
            <div class="split-item-editor" style="--split-cols:${splitParts}">
              <div class="split-row split-head">
                <strong>Item</strong>
                <span>Total</span>
                ${Array.from({ length: splitParts }).map((_, index) => `<span>Split ${index + 1}</span>`).join("")}
              </div>
              ${(order.items || []).map((item, itemIndex) => {
                const sku = item.sku || item.itemName || item.item_name || `Line ${itemIndex + 1}`;
                const itemKey = splitItemKey(item, itemIndex);
                const units = splitUnitDefinitions(item);
                const values = splitDraft.items[itemKey] || [];
                const assignedByUnit = units.reduce((memo, unit) => {
                  memo[unit.key] = values.reduce((sum, value) => sum + splitQuantityValue(normalizeSplitPartValue(item, value)[unit.key]), 0);
                  return memo;
                }, {});
                const leftText = units
                  .map((unit) => {
                    const left = Math.round((Number(unit.total || 0) - Number(assignedByUnit[unit.key] || 0)) * 1000000) / 1000000;
                    return Math.abs(left) > 0.000001 ? `${qtyText(left)} ${unit.label} left` : "";
                  })
                  .filter(Boolean)
                  .join(" | ");
                return `
                  <div class="split-row">
                    <strong>${escapeHtml(sku)}</strong>
                    <span>${escapeHtml(splitItemTotalLabel(item))}${leftText ? ` | ${escapeHtml(leftText)}` : ""}</span>
                    ${Array.from({ length: splitParts }).map((_, index) => `
                      <div class="split-unit-stack">
                        ${units.map((unit) => {
                          const part = normalizeSplitPartValue(item, values[index]);
                          const step = unit.step >= 1 ? "1" : "0.01";
                          return `
                            <label class="split-unit-input">
                              <span>${escapeHtml(unit.label)}</span>
                              <input data-split-key="${escapeHtml(itemKey)}" data-split-sku="${escapeHtml(sku)}" data-split-index="${index}" data-split-unit="${unit.key}" type="number" min="0" step="${step}" value="${part[unit.key] || 0}" />
                            </label>
                          `;
                        }).join("")}
                      </div>
                    `).join("")}
                  </div>
                `;
              }).join("")}
            </div>
          </div>
          <div class="modal-footer">
            <button data-action="close-modal" type="button">Cancel</button>
            <button class="primary" data-action="confirm-split" data-order="${order.id}" type="button">Create Split Orders</button>
          </div>
        </section>
      </div>
    `;
  }
  if (modalType === "delete-load") {
    const { truck, load } = findLoad(modalLoadId);
    const orderCount = new Set((load?.stops || []).filter((stop) => stop.type === "drop").map((stop) => stop.orderId)).size;
    return `
      <div class="modal-backdrop show">
        <section class="dispatch-modal">
          <div class="modal-header">
            <div>
              <h2>Delete Load</h2>
              <p>${escapeHtml(truck?.plate || "")} ${escapeHtml(load?.name || "")}</p>
            </div>
            <button data-action="close-modal" type="button">Close</button>
          </div>
          <div class="modal-body">
            ${orderCount ? `<div class="warning-detail">This load has ${orderCount} assigned order${orderCount > 1 ? "s" : ""}. Deleting it will release all assigned orders back to the order pool.</div>` : `<div class="empty-drop">This load is empty.</div>`}
          </div>
          <div class="modal-footer">
            <button data-action="close-modal" type="button">Cancel</button>
            <button class="danger" data-action="confirm-delete-load" data-load="${escapeHtml(load?.id || "")}" type="button">Delete Load</button>
          </div>
        </section>
      </div>
    `;
  }
  return `
    <div></div>
  `;
}

function renderSideDrawer() {
  return `
    <div class="drawer-backdrop ${sideMenuOpen ? "show" : ""}" data-action="close-side-menu"></div>
    <aside class="side-drawer ${sideMenuOpen ? "show" : ""}">
      <div class="panel-header drawer-header">
        <div>
          <h2>Dispatch Setup</h2>
          <p>Drivers, trucks, and route preview tools.</p>
        </div>
        <button data-action="close-side-menu" type="button">Close</button>
      </div>
      <div class="drawer-content">
        ${renderSupport()}
        ${renderMap()}
      </div>
    </aside>
  `;
}

function renderSupport() {
  const list = supportTab === "drivers" ? drivers : fleet;
  return `
    <section class="panel">
      <div class="panel-header">
        <h2>Support Setup</h2>
        <p>Driver and truck registration for dispatch planning.</p>
      </div>
      <div class="support-tabs">
        <button class="${supportTab === "drivers" ? "active" : ""}" data-action="support-tab" data-tab="drivers" type="button">Drivers</button>
        <button class="${supportTab === "trucks" ? "active" : ""}" data-action="support-tab" data-tab="trucks" type="button">Trucks</button>
      </div>
      <div class="registration-list">
        ${list.map((item) => supportTab === "drivers" ? `
          <div class="registration-card">
            <strong>${escapeHtml(item.name)} | ${item.license}</strong>
            <span class="muted">License ${escapeHtml(item.number)} | Login ${escapeHtml(item.login)}</span>
            <span class="muted">Own yard ${ownYardFixedMinutesFor(item)}m | Vendor ${vendorFixedMinutesFor(item)}m | Delivery ${deliveryFixedMinutesFor(item)}m + ${minutesPerPalletFor(item)}m/PLT</span>
          </div>
        ` : `
          <div class="registration-card">
            <strong>${escapeHtml(item.plate)}</strong>
            <span class="muted">Capacity ${formatLbs(truckCapacityLbs(item))}</span>
          </div>
        `).join("")}
      </div>
      ${renderRegistrationForm()}
    </section>
  `;
}

function renderRegistrationForm() {
  if (supportTab === "drivers") {
    return `
      <form class="registration-form" data-form="driver">
        <input name="name" placeholder="Driver name" required />
        <select name="license"><option>AZ</option><option>DZ</option></select>
        <input name="number" placeholder="License number" required />
        <input name="login" placeholder="Login" required />
        <input name="password" placeholder="Password" type="password" required />
        <input name="ownYardFixedMinutes" placeholder="Own yard fixed min" type="number" value="40" required />
        <input name="vendorFixedMinutes" placeholder="Vendor fixed min" type="number" value="35" required />
        <input name="deliveryFixedMinutes" placeholder="Delivery fixed min" type="number" value="35" required />
        <input name="minutesPerPallet" placeholder="Delivery min / PLT" type="number" value="1" step="0.1" required />
        <button class="primary" type="submit">Register Driver</button>
      </form>
    `;
  }
  return `
    <form class="registration-form" data-form="truck">
      <input name="plate" placeholder="Plate number" required />
      <input name="capacityLbs" placeholder="Capacity lb" type="number" value="48000" required />
      <button class="primary" type="submit">Register Truck</button>
    </form>
  `;
}

function googleMapsUrl() {
  const { load } = selectedLoad();
  const stops = (load?.stops || []).map(stopOrder).filter(Boolean);
  const destination = stops[stops.length - 1]?.address || "3445 Mavis Rd, Mississauga";
  const waypoints = stops.slice(0, -1).map((order) => order.address).join("|");
  const params = new URLSearchParams({
    api: "1",
    origin: "3445 Mavis Rd, Mississauga",
    destination
  });
  if (waypoints) params.set("waypoints", waypoints);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function poDropStopDetails(dropoff = {}) {
  return {
    dropoffKey: String(dropoff.key || ""),
    dropLocation: String(dropoff.destinationYard || ""),
    dropAddress: String(dropoff.address || ""),
    destinationLocationId: dropoff.destinationLocationId ?? null,
    lineRowIds: (dropoff.lineRowIds || []).map(String),
    dropPallets: Number(dropoff.pallets || 0),
    dropLayers: Number(dropoff.layers || 0),
    dropSections: Number(dropoff.sections || 0),
    dropPieces: Number(dropoff.pieces || 0),
    dropSalesQty: Number(dropoff.salesQty || 0),
    dropWeight: Number(dropoff.weight || 0)
  };
}

function addPoDropoffsToLoad(order, loadId, insertIndex = null) {
  const { load } = findLoad(loadId);
  const dropoffs = Array.isArray(order?.dropoffs) ? order.dropoffs : [];
  if (!load || !dropoffs.length) return false;
  const beforeStops = (load.stops || []).map((stop) => ({ ...stop }));
  const beforeNotice = routeNotice;
  let nextInsertIndex = Number.isInteger(insertIndex) ? insertIndex : null;
  for (const dropoff of dropoffs) {
    const beforeLength = load.stops.length;
    const added = addOrderToLoad(
      order.id,
      loadId,
      "drop",
      "",
      nextInsertIndex,
      poDropStopDetails(dropoff)
    );
    if (!added) {
      load.stops = beforeStops;
      selectedOrderId = order.id;
      selectedOrderIds = new Set([order.id]);
      routeNotice = routeNotice || `${order.id} could not add every destination drop.`;
      return false;
    }
    if (Number.isInteger(nextInsertIndex)) {
      nextInsertIndex += Math.max(load.stops.length - beforeLength, 1);
    }
  }
  selectedOrderId = order.id;
  selectedOrderIds = new Set([order.id]);
  selectedLoadId = loadId;
  routeNotice = beforeNotice;
  return true;
}

function addOrderToLoad(orderId, loadId, type = "drop", location = "", insertIndex = null, stopDetails = {}) {
  const { truck, load } = findLoad(loadId);
  const order = orderById(orderId);
  if (!load || !order) return false;
  if (!loadHasAssignedDriver(truck, load)) {
    routeNotice = driverLockNotice(truck);
    return false;
  }
  if (type === "drop" && isOrderPlannedOutsideCurrentPlan(order)) {
    selectedOrderId = orderId;
    selectedOrderIds = new Set([orderId]);
    routeNotice = `${order.id} is already ${orderPlannedElsewhereText(order)}. Remove it from that plan before adding it here.`;
    return false;
  }
  if (type === "drop" && isScmGroupedPoOrder(order)) {
    return addScmGroupedPoToLoad(order, loadId, insertIndex);
  }
  if (type === "drop" && order.type === "PO" && !stopDetails.dropoffKey && order.dropoffs?.length) {
    return addPoDropoffsToLoad(order, loadId, insertIndex);
  }
  const transferNormalizedInsertIndex = type === "drop"
    ? normalizeReplenishmentTransferInsertIndex(order, load, insertIndex)
    : insertIndex;
  const normalizedInsertIndex = type === "drop"
    ? normalizeReplenishmentDependentInsertIndex(order, load, transferNormalizedInsertIndex)
    : transferNormalizedInsertIndex;
  const dependencyTimingMessage = type === "drop"
    ? replenishmentPlacementBlockMessage(order, truck, load, normalizedInsertIndex)
    : "";
  if (dependencyTimingMessage) {
    selectedOrderId = orderId;
    selectedOrderIds = new Set([orderId]);
    routeNotice = dependencyTimingMessage;
    return false;
  }
  const beforeLoad = summarizeLoad(load);
  if (type === "drop" && !hasUsableDispatchAddress(order)) {
    selectedOrderId = orderId;
    selectedOrderIds = new Set([orderId]);
    routeNotice = `${order.id} needs a delivery address before it can be planned. Double-click the order to update it.`;
    return false;
  }
  const transitMessage = type === "drop" ? transitBlockMessage(order) : "";
  if (transitMessage) {
    selectedOrderId = orderId;
    selectedOrderIds = new Set([orderId]);
    routeNotice = `${transitMessage} Open the CO tab and plan the transit move first.`;
    return false;
  }
  const beforeStops = (load.stops || []).map((stop) => ({ ...stop }));
  let cleanInsertIndex = Number.isInteger(normalizedInsertIndex) ? normalizedInsertIndex : null;
  if (type === "drop") {
    const addedPickups = ensurePickupStops(load, order, cleanInsertIndex);
    if (Number.isInteger(cleanInsertIndex)) cleanInsertIndex += addedPickups;
    if (["SO", "TO"].includes(order.type)) pendingOperatorAlertRefs.add(order.id);
  }
  const stopLocation = location || order.pickupLocations[0] || "3445";
  const existing = pullExistingStop(orderId, type, stopLocation, stopDetails);
  if (existing?.locked) {
    if (existing.load.id !== load.id) {
      routeNotice = stopActivityLockNotice(existing.stop);
      return false;
    }
    existing.stops.splice(existing.index, 1);
    existing.locked = false;
  }
  const sameLoadMove = existing?.load?.id === load.id && Number.isInteger(cleanInsertIndex) && existing.index < cleanInsertIndex;
  const stop = existing?.stop || {
    id: `${loadId}-${orderId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    loadId,
    orderId,
    type,
    location: stopLocation
  };
  stop.loadId = load.id;
  Object.assign(stop, stopDetails);
  if (Number.isInteger(cleanInsertIndex)) load.stops.splice(Math.max(0, cleanInsertIndex - (sameLoadMove ? 1 : 0)), 0, stop);
  else load.stops.push(stop);
  if (type === "drop") {
    const coWarning = coTimingViolation(order);
    if (coWarning) {
      load.stops = beforeStops;
      cleanupOrphanPickupStops();
      pendingOperatorAlertRefs.delete(order.id);
      selectedOrderId = orderId;
      selectedOrderIds = new Set([orderId]);
      routeNotice = coWarning;
      return false;
    }
  }
  selectedOrderId = orderId;
  selectedLoadId = loadId;
  logDispatchAudit({
    action: type === "drop" ? "order_dropped_to_load" : "stop_added_to_load",
    entityType: "load",
    entityId: load.id,
    orderId,
    loadId: load.id,
    before: beforeLoad,
    after: summarizeLoad(load),
    details: {
      stopType: type,
      location: stopLocation,
      dropLocation: stop.dropLocation || "",
      dropoffKey: stop.dropoffKey || "",
      insertIndex: cleanInsertIndex,
      movedFromLoadId: existing?.load?.id || null,
      order: summarizeOrder(order)
    }
  });
  return true;
}

function pullExistingStop(orderId, type, location, stopDetails = {}) {
  for (const truck of trucks) {
    for (const load of truck.loads) {
      const index = load.stops.findIndex((stop) => {
        if (stop.orderId !== orderId || stop.type !== type) return false;
        if (type === "pick") return String(stop.location) === String(location);
        if (!stopDetails.dropoffKey) return true;
        if (String(stop.dropoffKey || "") === String(stopDetails.dropoffKey)) return true;
        if (stop.dropLocation && String(stop.dropLocation) === String(stopDetails.dropLocation || "")) return true;
        if (!stop.dropoffKey && !stop.dropLocation) {
          const order = orderById(orderId);
          const dropoffs = Array.isArray(order?.dropoffs) ? order.dropoffs : [];
          return dropoffs.length <= 1 || String(dropoffs[0]?.key || "") === String(stopDetails.dropoffKey);
        }
        return false;
      });
      if (index >= 0) {
        const found = { truck, load, stops: load.stops, stop: load.stops[index], index };
        if (orderHasDriverActivityInLoad(load, orderId)) return { ...found, locked: true };
        const [stop] = load.stops.splice(index, 1);
        return { truck, load, stop, index };
      }
    }
  }
  return null;
}

function moveStop(stopId, delta) {
  const found = findStop(stopId);
  if (!found) return;
  const { stops, index } = found;
  const next = index + delta;
  if (next < 0 || next >= stops.length) return;
  const [stop] = stops.splice(index, 1);
  stops.splice(next, 0, stop);
}

function findStop(stopId) {
  for (const truck of trucks) {
    for (const load of truck.loads) {
      const index = load.stops.findIndex((stop) => stop.id === stopId);
      if (index >= 0) return { truck, load, stops: load.stops, stop: load.stops[index], index };
    }
  }
  return null;
}

function deleteLoad(loadId) {
  const { truck, load } = findLoad(loadId);
  if (!truck || !load) return;
  if (loadHasDriverActivity(load)) {
    routeNotice = loadActivityLockNotice(load);
    return;
  }
  const before = summarizeLoad(load);
  truck.loads = truck.loads.filter((item) => item.id !== loadId);
  renumberTruckLoads(truck);
  if (selectedLoadId === loadId) {
    selectedLoadId = trucks.flatMap((item) => item.loads).find((item) => !item.returnOnly)?.id || trucks[0]?.loads[0]?.id || "";
    loadPreviewOpen = Boolean(selectedLoadId);
  }
  logDispatchAudit({
    action: "load_deleted",
    entityType: "load",
    entityId: loadId,
    loadId,
    truckId: truck.id,
    before,
    after: null,
    details: { truck: summarizeTruck(truck) }
  });
}

function previewStopMove(found, target, insertIndex) {
  const source = found.stops;
  const sameLoad = found.load.id === target.id;
  const sourceDraft = [...source];
  const [removedStop] = sourceDraft.splice(found.index, 1);
  const stop = { ...removedStop };
  if (sameLoad) {
    const adjustedIndex = Number.isInteger(insertIndex) && found.index < insertIndex ? insertIndex - 1 : insertIndex;
    if (Number.isInteger(adjustedIndex)) sourceDraft.splice(adjustedIndex, 0, stop);
    else sourceDraft.push(stop);
    return { sourceDraft, targetDraft: sourceDraft };
  }
  const targetDraft = [...target.stops];
  stop.loadId = target.id;
  if (Number.isInteger(insertIndex)) targetDraft.splice(insertIndex, 0, stop);
  else targetDraft.push(stop);
  return { sourceDraft, targetDraft };
}

function stopMoveWarning(found, target, insertIndex) {
  const { sourceDraft, targetDraft } = previewStopMove(found, target, insertIndex);
  const warnings = [...sequenceWarningsForStops(sourceDraft), ...sequenceWarningsForStops(targetDraft)];
  return warnings[0] || "";
}

function stopRemovalWarning(found) {
  const draft = [...found.stops];
  draft.splice(found.index, 1);
  return sequenceWarningsForStops(draft)[0] || "";
}

function insertIndexFromDrop(event, targetStop, targetLoad) {
  if (!targetStop) return null;
  const baseIndex = Number(targetStop.dataset.index);
  if (!Number.isInteger(baseIndex)) return null;
  const rect = targetStop.getBoundingClientRect();
  const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0;
  if (ratio < 0.33) return baseIndex;
  if (ratio > 0.66) return baseIndex + 1;
  return baseIndex;
}

function ensureSplitDraft(order, force = false) {
  if (!force && splitDraft.orderId === order.id && splitDraft.parts === splitParts) return;
  const items = {};
  for (const [itemIndex, item] of (order.items || []).entries()) {
    const units = splitUnitDefinitions(item);
    const parts = Array.from({ length: splitParts }).map(() => splitPartTemplate(item));
    for (const unit of units) {
      const values = splitNumberAcrossParts(unit.total, splitParts, unit.step);
      values.forEach((value, index) => {
        parts[index][unit.key] = value;
      });
    }
    items[splitItemKey(item, itemIndex)] = parts;
  }
  splitDraft = { orderId: order.id, parts: splitParts, items };
}

function splitTotalsForPart(order, partIndex) {
  const items = (order.items || [])
    .map((item, itemIndex) => {
      const key = splitItemKey(item, itemIndex);
      const part = normalizeSplitPartValue(item, splitDraft.items[key]?.[partIndex]);
      const splitLabel = splitPartLabel(item, part);
      if (!splitLabel) return null;
      const salesQuantity = splitPartSalesQuantity(item, part);
      const next = {
        ...item,
        pallets: splitQuantityValue(part.pallets),
        layers: splitQuantityValue(part.layers),
        sections: splitQuantityValue(part.sections),
        pieces: splitQuantityValue(part.pieces),
        quantity: salesQuantity,
        splitQty: salesQuantity,
        splitUnit: splitLabel
      };
      if (part.quantity !== undefined && splitUnitDefinitions(item).every((unit) => unit.key === "quantity")) {
        next.quantity = splitQuantityValue(part.quantity);
      }
      return next;
    })
    .filter(Boolean);
  const pallets = items.reduce((sum, item) => sum + Number(item.pallets || 0) + (Number(item.layers || 0) > 0 ? 1 : 0), 0);
  const salesQty = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const weight = items.reduce((sum, item) => {
    const itemWeight = Number(item.itemWeight || item.item_weight || 0);
    return sum + (itemWeight > 0 ? Number(item.quantity || 0) * itemWeight : 0);
  }, 0);
  return { items, pallets, salesQty, weight };
}

function splitOrder(orderId, parts = 2, startSuffix = 1) {
  const order = orderById(orderId);
  if (!order || order.type === "CUSTOM") return;
  const cleanParts = Math.min(Math.max(Number(parts) || 2, 2), 10);
  const cleanStartSuffix = Math.max(Number(startSuffix) || 1, 1);
  const originalPallets = order.pallets;
  const insertAt = orders.findIndex((item) => item.id === order.id) + 1;
  orders.splice(orders.findIndex((item) => item.id === order.id), 1);
  const splits = Array.from({ length: cleanParts }).map((_, index) => {
    const totals = splitTotalsForPart(order, index);
    return {
      ...order,
      id: `${order.id}-S${cleanStartSuffix + index}`,
      pallets: totals.pallets,
      layers: 0,
      items: totals.items,
      salesQty: Math.round(Number(totals.salesQty || 0) * 1000000) / 1000000,
      weight: totals.weight > 0
        ? Math.round(totals.weight * 10) / 10
        : Math.round((Number(order.weight || 0) * (Number(totals.salesQty || 0) / Math.max(Number(order.salesQty || order.quantity || 0), 1))) * 10) / 10,
      notes: `Split ${index + 1}/${cleanParts} from ${order.id}. ${order.notes}`,
      originalOrderId: order.id,
      originalPallets
    };
  }).filter((split) => split.items.length);
  orders.splice(insertAt - 1, 0, ...splits);
  selectedOrderId = splits[0]?.id || "";
  selectedOrderIds = new Set(selectedOrderId ? [selectedOrderId] : []);
  if (splits[0]?.type) activeOrderType = splits[0].type;
}

function prepareUnsplitOrder(splitOrderId) {
  const split = orderById(splitOrderId);
  if (split?.type === "CUSTOM" || !split?.originalOrderId) {
    routeNotice = "Select a split order before using Unsplit.";
    return null;
  }
  const siblings = splitSiblingsForOrder(split);
  const blockReason = splitOrderPlanningBlock(siblings);
  if (blockReason) {
    routeNotice = blockReason;
    return null;
  }
  const parent = orderCatalog.find((order) => order.id === split.originalOrderId);
  if (!parent) {
    routeNotice = `Cannot unsplit ${split.originalOrderId}. Refresh orders first, then try again.`;
    return null;
  }
  return {
    parent,
    siblings,
    before: siblings.map(summarizeOrder),
    siblingIds: siblings.map((item) => item.id),
    firstIndex: orders.findIndex((item) => siblings.some((sibling) => sibling.id === item.id))
  };
}

function applyUnsplitOrder(prepared) {
  if (!prepared?.parent || !prepared?.siblingIds?.length) return false;
  const siblingIds = new Set(prepared.siblingIds);
  orders = orders.filter((item) => !siblingIds.has(item.id));
  const restored = normalizeOrder({
    ...prepared.parent,
    localDispatchStatus: "open",
    dispatchPlanned: false,
    dispatchPlanId: "",
    dispatchPlanDate: "",
    dispatchTruckPlate: "",
    dispatchLoadName: "",
    dispatchParkingSpot: ""
  });
  orders.splice(Math.max(prepared.firstIndex, 0), 0, restored);
  selectedOrderId = restored.id;
  selectedOrderIds = new Set([restored.id]);
  if (restored.type) activeOrderType = restored.type;
  routeNotice = `${restored.id} restored. Split orders removed: ${[...siblingIds].join(", ")}.`;
  logDispatchAudit({
    action: "order_unsplit",
    entityType: "order",
    entityId: restored.id,
    orderId: restored.id,
    before: prepared.before,
    after: summarizeOrder(restored),
    details: { removedSplitOrderIds: [...siblingIds] }
  });
  return true;
}

function orderGroupYard(order) {
  const locations = Array.isArray(order?.pickupLocations) ? order.pickupLocations : [];
  return String(locations[0] || order?.sourceYard || "").trim();
}

function mixedYardGroupBlockReason(groupItems = []) {
  const yardRows = groupItems.map((order) => ({
    id: order?.id || "",
    yard: orderGroupYard(order) || "Unknown"
  }));
  const yards = [...new Set(yardRows.map((row) => row.yard))];
  if (yards.length <= 1) return "";
  return `Cannot group orders from different yards: ${yardRows.map((row) => `${row.id} (${row.yard})`).join(", ")}.`;
}

function groupedOrderDependencyStructureBlockMessage(groupItems = []) {
  for (const dependency of groupedOrderDependencies(groupItems)) {
    const transferRef = String(dependency.transferOrderRef || "the linked Transfer Order");
    const salesRef = String(
      dependency.canonicalSalesOrderRef
      || dependency.salesOrderRef
      || dependency.dispatchTargetRef
      || "this Sales Order"
    );
    const mode = String(dependency.mode || "");
    const status = String(dependency.status || "active").toLowerCase();
    const targetKind = String(dependency.dispatchTargetKind || "normal").toLowerCase();
    const hasExecutionProgress = (dependency.lines || []).some((line) =>
      Number(line.loadedQuantity ?? line.loaded_quantity ?? 0) > 0
      || Number(line.deliveredQuantity ?? line.delivered_quantity ?? 0) > 0
      || Number(line.locallyReceivedQuantity ?? line.locally_received_quantity ?? 0) > 0
    );
    if (mode !== "yard_replenishment") {
      return `Cannot group ${salesRef}: ${transferRef} is a direct-pickup dependency. Change or unlink it first.`;
    }
    if (hasExecutionProgress) {
      return `Cannot group ${salesRef}: processing has already started for ${transferRef}.`;
    }
    if (!["active", "attention"].includes(status) || targetKind !== "normal") {
      return `Cannot group ${salesRef}: its dependency on ${transferRef} cannot be moved into a new group.`;
    }
  }
  return "";
}

function dispatchGroupingRefs(order = {}) {
  return new Set([
    order.id,
    ...(order.childOrders || []),
    ...(order.groupAliases || []),
    ...(order.childOrderDetails || []).flatMap((child) => [child?.id, child?.originalOrderId])
  ].map((value) => String(value || "")).filter(Boolean));
}

function prepareGroupedOrderPlanning(groupItems = []) {
  const plannedElsewhere = groupItems.find((item) => isOrderPlannedOutsideCurrentPlan(item));
  if (plannedElsewhere) {
    selectedOrderId = plannedElsewhere.id;
    selectedOrderIds = new Set([plannedElsewhere.id]);
    routeNotice = `${plannedElsewhere.id} is already ${orderPlannedElsewhereText(plannedElsewhere)}. Remove it from that plan before grouping.`;
    return null;
  }

  const refs = new Set(groupItems.flatMap((item) => [...dispatchGroupingRefs(item)]));
  const assignments = [];
  for (const truck of trucks) {
    for (const load of truck.loads || []) {
      for (const [index, stop] of (load.stops || []).entries()) {
        if (stop.type === "drop" && refs.has(String(stop.orderId || ""))) {
          assignments.push({ truck, load, stop, index });
        }
      }
    }
  }

  const assignedLoadIds = new Set(assignments.map((entry) => String(entry.load.id || "")));
  if (assignedLoadIds.size > 1) {
    routeNotice = `Cannot group orders assigned to different loads: ${assignments.map((entry) => `${entry.stop.orderId} (${entry.truck.plate} ${entry.load.name})`).join(", ")}.`;
    return null;
  }
  const activeAssignment = assignments.find((entry) =>
    loadHasDriverActivity(entry.load) || stopHasDriverActivity(entry.load, entry.stop)
  );
  if (activeAssignment) {
    routeNotice = `Cannot group orders in ${activeAssignment.truck.plate} ${activeAssignment.load.name} because driver activity has already started.`;
    return null;
  }

  return {
    refs,
    assignments,
    truck: assignments[0]?.truck || null,
    load: assignments[0]?.load || null
  };
}

function groupedOrderPlanningDependencyBlockMessage(grouped, planning = {}) {
  const load = planning.load;
  if (!load || !grouped?.orderDependencies?.length) return "";
  const plannedDropIndexes = (load.stops || [])
    .map((stop, index) => ({ stop, index }))
    .filter(({ stop }) => stop.type === "drop" && planning.refs?.has(String(stop.orderId || "")))
    .map(({ index }) => index);
  if (!plannedDropIndexes.length) return "";
  const firstDropIndex = Math.min(...plannedDropIndexes);
  const pickupLocations = new Set(
    requiredPickupLocations(grouped).map(normalizedPickupLocation).filter(Boolean)
  );
  const firstPickupIndex = (load.stops || []).findIndex((stop, index) =>
    index < firstDropIndex
    && stop.type === "pick"
    && pickupLocations.has(normalizedPickupLocation(stop.location))
  );
  return replenishmentPlacementBlockMessage(
    grouped,
    planning.truck,
    load,
    firstPickupIndex >= 0 ? firstPickupIndex : firstDropIndex
  );
}

function applyGroupedOrderPlanning(grouped, planning = {}) {
  const load = planning.load;
  if (!load || !planning.assignments?.length) return;
  const affectedStopIds = new Set(planning.assignments.map((entry) => String(entry.stop.id || "")));
  const primary = [...planning.assignments].sort((left, right) => left.index - right.index)[0];
  const groupedStop = {
    ...primary.stop,
    id: `${load.id}-${grouped.id}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    loadId: load.id,
    orderId: grouped.id,
    location: grouped.address || primary.stop.location || ""
  };
  const nextStops = [];
  let inserted = false;
  for (const stop of load.stops || []) {
    if (affectedStopIds.has(String(stop.id || ""))) {
      if (!inserted) {
        nextStops.push(groupedStop);
        inserted = true;
      }
      continue;
    }
    if (stop.type === "pick" && planning.refs.has(String(stop.orderId || ""))) {
      nextStops.push({ ...stop, orderId: grouped.id });
      continue;
    }
    nextStops.push(stop);
  }
  load.stops = nextStops;
  selectedLoadId = load.id;
  delete routeCache[load.id];
  delete routeEstimates[load.id];
  if (["SO", "TO"].includes(grouped.type)) {
    for (const ref of grouped.childOrders || []) pendingOperatorAlertRefs.add(ref);
  }
  routeNotice = `${grouped.id} grouped in ${planning.truck?.plate || "truck"} ${load.name}.`;
}

function groupOrder(orderId) {
  const selected = selectedOrders();
  const groupItems = selected.length > 1 ? selected : [];
  if (groupItems.length < 2) {
    routeNotice = "Select at least two orders before grouping.";
    return false;
  }
  if (groupItems.some((item) => item.type === "CUSTOM")) {
    routeNotice = "Custom Orders cannot be grouped. Plan each Custom Order separately.";
    return false;
  }
  const blockReason = mixedYardGroupBlockReason(groupItems);
  if (blockReason) {
    routeNotice = blockReason;
    return false;
  }
  const dependencyBlockedOrder = groupItems.find((item) => item.dependencyHidden);
  if (dependencyBlockedOrder) {
    selectedOrderId = dependencyBlockedOrder.id;
    selectedOrderIds = new Set([dependencyBlockedOrder.id]);
    routeNotice = `${dependencyBlockedOrder.id} is linked to ${dependencyBlockedOrder.dependentSalesOrderRef || "a Sales Order"} as direct pickup and cannot be grouped independently.`;
    return false;
  }
  const dependencyStructureBlock = groupedOrderDependencyStructureBlockMessage(groupItems);
  if (dependencyStructureBlock) {
    routeNotice = dependencyStructureBlock;
    return false;
  }
  const planning = prepareGroupedOrderPlanning(groupItems);
  if (!planning) return false;
  const flattenedMembers = flattenDispatchGroupMembers({
    type: groupItems[0].type,
    childOrders: groupItems.map((item) => item.id),
    childOrderDetails: groupItems
  });
  const leafItems = flattenedMembers.childOrderDetails;
  const groupAliases = [...new Set([
    ...flattenedMembers.groupAliases,
    ...groupItems.filter((item) => item.childOrders?.length).map((item) => item.id)
  ])];
  const grouped = normalizeOrder({
    ...groupItems[0],
    id: uniqueGroupedDispatchOrderId(leafItems),
    customer: `${leafItems.length} orders grouped`,
    address: groupItems[0].address,
    pallets: groupItems.reduce((sum, item) => sum + Number(item.pallets || 0), 0),
    layers: groupItems.reduce((sum, item) => sum + Number(item.layers || 0), 0),
    salesQty: groupItems.reduce((sum, item) => sum + Number(item.salesQty || 0), 0),
    weight: groupItems.reduce((sum, item) => sum + Number(item.weight || 0), 0),
    unloadMinutes: groupItems.reduce((sum, item) => sum + Number(item.unloadMinutes || 0), 0),
    travelMinutes: Math.max(...groupItems.map((item) => Number(item.travelMinutes || 0))),
    pickupLocations: [...new Set(groupItems.flatMap((item) => item.pickupLocations || []))],
    items: groupItems.flatMap((item) => item.items || []),
    childOrders: flattenedMembers.childOrders,
    childOrderDetails: leafItems.map((item) => normalizeOrder({ ...item })),
    groupAliases,
    notes: `Grouped orders: ${flattenedMembers.childOrders.join(", ")}`
  });
  const dependencyTimingBlock = groupedOrderPlanningDependencyBlockMessage(grouped, planning);
  if (dependencyTimingBlock) {
    routeNotice = dependencyTimingBlock;
    return false;
  }
  const ids = new Set(groupItems.map((item) => item.id));
  const firstIndex = orders.findIndex((item) => ids.has(item.id));
  orders = orders.filter((item) => !ids.has(item.id));
  orders.splice(Math.max(firstIndex, 0), 0, grouped);
  applyGroupedOrderPlanning(grouped, planning);
  selectedOrderId = grouped.id;
  selectedOrderIds = new Set([grouped.id]);
  return true;
}

function groupedDispatchOrderId(groupItems = []) {
  const parsed = groupItems.map((item) => {
    const id = String(item?.id || "").trim().toUpperCase();
    const match = id.match(/\b(SO[A-Z]|TO[A-Z]|PO[A-Z])\D*(\d+)/i) || id.match(/^([A-Z]+)[^\d]*(\d+)/);
    if (!match) return { prefix: "GRP", number: id.replace(/\W+/g, "") || "ORDER", sortNumber: Number.MAX_SAFE_INTEGER, sortSuffix: id };
    const sourcePrefix = match[1];
    const groupPrefix = sourcePrefix.length > 1 ? `G${sourcePrefix.slice(1)}` : `G${sourcePrefix}`;
    const splitSuffix = id.slice((match.index || 0) + match[0].length).match(/-S\d+/i)?.[0]?.replace(/\W+/g, "") || "";
    const sortNumber = Number.parseInt(match[2], 10) || 0;
    const number = `${String(sortNumber)}${splitSuffix}`;
    return { prefix: groupPrefix, number, sortNumber, sortSuffix: splitSuffix };
  }).sort((a, b) => a.prefix.localeCompare(b.prefix) || a.sortNumber - b.sortNumber || a.sortSuffix.localeCompare(b.sortSuffix) || a.number.localeCompare(b.number));
  const prefixes = [...new Set(parsed.map((item) => item.prefix).filter(Boolean))];
  const prefix = prefixes.length === 1 ? prefixes[0] : `G${prefixes.map((item) => item.replace(/^G/i, "")).join("")}`;
  return `${prefix}-${parsed.map((item) => item.number).join("-")}`;
}

function dispatchOrderIdExists(id, excludedIds = new Set()) {
  const target = String(id || "");
  if (!target || excludedIds.has(target)) return false;
  if (plannedAssignmentRefs.has(target)) return true;
  const lists = [orders, orderCatalog];
  for (const list of lists) {
    if ((list || []).some((order) => String(order?.id || "") === target && !excludedIds.has(String(order?.id || "")))) return true;
  }
  for (const truck of trucks || []) {
    for (const load of truck.loads || []) {
      if ((load.stops || []).some((stop) => String(stop?.orderId || "") === target && !excludedIds.has(String(stop?.orderId || "")))) return true;
    }
  }
  return false;
}

function uniqueGroupedDispatchOrderId(groupItems = []) {
  const baseId = groupedDispatchOrderId(groupItems);
  const excludedIds = new Set(groupItems.map((item) => String(item?.id || "")).filter(Boolean));
  if (!dispatchOrderIdExists(baseId, excludedIds)) return baseId;
  for (let version = 2; version < 1000; version += 1) {
    const candidate = `${baseId}-V${version}`;
    if (!dispatchOrderIdExists(candidate, excludedIds)) return candidate;
  }
  return `${baseId}-V${Date.now()}`;
}

function groupedOrderTransitCoId(order) {
  if (!order?.childOrders?.length) return "";
  const directCoId = String(order.transitCo?.id || "").trim();
  if (directCoId) return directCoId;
  const expectedCoId = `CO-${order.id}`;
  const coOrder = orderById(expectedCoId);
  if (coOrder) return expectedCoId;
  const relatedCo = (orders || []).find((item) => item?.type === "CO" && (
    String(item.sourceOrderId || "") === String(order.id || "")
    || String(item.relatedSoId || "") === String(order.id || "")
    || String(item.relatedToId || "") === String(order.id || "")
  ));
  return relatedCo?.id || "";
}

function ungroupOrder(orderId) {
  const group = orderById(orderId);
  if (!group?.childOrders?.length) return null;
  const coId = groupedOrderTransitCoId(group);
  if (coId) {
    routeNotice = `Cancel ${coId} before ungrouping ${group.id}.`;
    return null;
  }
  const before = summarizeOrder(group);
  const removedStops = removeStopsForOrders([group.id]);
  const fallbackById = new Map(orderCatalog.map((item) => [item.id, item]));
  const detailById = new Map((group.childOrderDetails || []).map((item) => [item.id, item]));
  const restored = group.childOrders
    .map((id) => detailById.get(id) || fallbackById.get(id))
    .filter(Boolean)
    .map((item) => normalizeOrder({
      ...item,
      localDispatchStatus: "open"
    }));
  const groupIndex = orders.findIndex((item) => item.id === group.id);
  orders = orders.filter((item) => item.id !== group.id && !restored.some((child) => child.id === item.id));
  orders.splice(Math.max(groupIndex, 0), 0, ...restored);
  selectedOrderId = restored[0]?.id || orders[0]?.id || "";
  selectedOrderIds = new Set(selectedOrderId ? [selectedOrderId] : []);
  activeOrderType = restored[0]?.type || activeOrderType;
  routeNotice = restored.length
    ? `Ungrouped ${group.id}. Orders returned to the pool.`
    : `Ungrouped ${group.id}, but original order details were not found.`;
  logDispatchAudit({
    action: "orders_ungrouped",
    entityType: "order",
    entityId: group.id,
    orderId: group.id,
    before,
    after: restored.map(summarizeOrder),
    details: { childOrderIds: group.childOrders, removedStops }
  });
  return restored;
}

function consolidatePick(orderId, sourceYard) {
  const order = orderById(orderId);
  if (!order) return;
  const shortage = shortageQty(order);
  const yard = consolidateYards(order).find((item) => item.yard === sourceYard);
  if (!yard) return;
  const targetYard = order.pickupLocations?.[0] || "3445";
  const draftId = `TO-DRAFT-${order.id.replace(/\D/g, "").slice(-4)}-${sourceYard}`;
  order.consolidation = {
    sourceYard,
    shortageQty: shortage,
    targetYard,
    transferOrderId: draftId
  };
  if (!orders.some((item) => item.id === draftId)) {
    orders.unshift({
      id: draftId,
      type: "TO",
      customer: "Consolidate Pick",
      address: `${sourceYard} to ${targetYard}`,
      sourceYard,
      destinationYard: targetYard,
      windowStart: "07:00",
      windowEnd: "12:00",
      pallets: Math.max(1, Math.ceil(shortage / 100)),
      layers: 0,
      items: (order.items || []).slice(0, 1).map((item) => ({ ...item, pallets: Math.max(1, Math.ceil(shortage / 100)), layers: 0, splitQty: shortage })),
      salesQty: shortage,
      committedQty: shortage,
      weight: Math.max(1, Math.round((order.weight / Math.max(Number(order.salesQty || 1), 1)) * shortage * 10) / 10),
      pickupLocations: [sourceYard],
      unloadMinutes: 28,
      travelMinutes: 36,
      groupKey: `${sourceYard} to ${targetYard}`,
      notes: `Draft TO created for shortage on ${order.id}. Move ${shortage} units one day before delivery.`,
      x: HUBS[targetYard]?.x || 50,
      y: HUBS[targetYard]?.y || 50
    });
  }
  order.notes = `Consolidate ${shortage} units from ${sourceYard} to ${targetYard} one day before. ${order.notes}`;
  activeOrderType = "TO";
  searchText = "";
  selectedOrderId = draftId;
  selectedOrderIds = new Set([draftId]);
}

function upsertTransitCoForOrder(orderId, fromYard, toYard) {
  const order = orderById(orderId);
  if (!order || !supportsTransitCoForOrder(order)) return null;
  if (!fromYard || !toYard || String(fromYard) === String(toYard)) return null;
  const beforeOrder = summarizeOrder(order);
  const coId = order.transitCo?.id || `CO-${order.id}`;
  const beforeCo = summarizeOrder(orderById(coId));
  applyTransitPickupToOrder(order, {
    coId,
    fromYard,
    toYard,
    createdAt: order.transitCo?.createdAt || new Date().toISOString()
  });
  order.notes = order.notes?.includes(`Transit via ${toYard}`)
    ? order.notes
    : `Transit via ${toYard}. ${order.notes || ""}`.trim();
  const sourceOrderType = transitSourceOrderType(order);

  const coOrder = normalizeOrder({
    ...(orderById(coId) || {}),
    id: coId,
    type: "CO",
    customer: `Transit Depot for ${order.id}`,
    address: hubAddress(toYard),
    sourceYard: fromYard,
    destinationYard: toYard,
    expectedDeliveryDate: order.expectedDeliveryDate || "",
    windowStart: "",
    windowEnd: "",
    pallets: order.pallets,
    layers: order.layers,
    items: (order.items || []).map((item) => ({ ...item })),
    salesQty: order.salesQty,
    committedQty: order.salesQty,
    weight: order.weight,
    pickupLocations: [fromYard],
    unloadMinutes: order.unloadMinutes,
    travelMinutes: yardTravelMinutes(fromYard, toYard),
    sourceOrderId: order.id,
    relatedSoId: order.type === "SO" ? order.id : "",
    relatedToId: order.type === "TO" ? order.id : "",
    sourceOrderType: order.type,
    transitOrder: true,
    groupKey: `${fromYard} to ${toYard}`,
    childOrders: order.childOrders || [],
    childOrderDetails: order.childOrderDetails || [],
    sourceOrderType,
    notes: `Local transit depot order for ${order.id}. No NetSuite order.`
  });

  const existingIndex = orders.findIndex((item) => item.id === coId);
  if (existingIndex >= 0) orders[existingIndex] = coOrder;
  else {
    const sourceIndex = orders.findIndex((item) => item.id === order.id);
    orders.splice(sourceIndex >= 0 ? sourceIndex + 1 : 0, 0, coOrder);
  }

  logDispatchAudit({
    action: beforeCo ? "co_updated" : "co_initiated",
    entityType: "order",
    entityId: coId,
    orderId: coId,
    before: { sourceOrder: beforeOrder, coOrder: beforeCo },
    after: { sourceOrder: summarizeOrder(order), coOrder: summarizeOrder(coOrder) },
    details: { sourceOrderId: order.id, fromYard, toYard }
  });
  return coOrder;
}

async function saveTransitCoToServer(sourceOrder, coOrder) {
  if (!sourceOrder || !coOrder) return null;
  const response = await fetch("/api/dispatch/co-orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceOrderRef: sourceOrder.id,
      fromYard: coOrder.sourceYard,
      toYard: coOrder.destinationYard,
      order: {
        ...coOrder,
        customer: sourceOrder.customer,
        notes: coOrder.notes,
        items: coOrder.items || sourceOrder.items || [],
        childOrders: sourceOrder.childOrders || [],
        childOrderDetails: sourceOrder.childOrderDetails || []
      },
      planId: currentPlan?.id || null,
      planDate: currentPlanDate,
      sessionId: dispatchSessionId,
      editLeaseToken: planEditLeaseToken,
      audit: { sessionId: dispatchSessionId }
    })
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function cancelTransitCoOnServer(coId) {
  if (!coId) return null;
  const response = await fetch(`/api/dispatch/co-orders/${encodeURIComponent(coId)}?sessionId=${encodeURIComponent(dispatchSessionId)}&planDate=${encodeURIComponent(currentPlanDate)}&editLeaseToken=${encodeURIComponent(planEditLeaseToken)}`, {
    method: "DELETE"
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function persistTransitCoInBackground(promise, successMessage = "") {
  promise
    .then(() => {
      if (!successMessage) return;
      routeNotice = successMessage;
      render({ save: false });
    })
    .catch((error) => {
      routeNotice = `CO server update failed: ${error.message}`;
      render({ save: false });
    });
}

function cancelTransitCoForOrder(orderId) {
  const order = orderById(orderId);
  if (!order?.transitCo?.id) return null;
  const coId = order.transitCo.id;
  const beforeOrder = summarizeOrder(order);
  const beforeCo = summarizeOrder(orderById(coId));
  const removedStops = removeStopsForOrders([coId]);
  const restoredPickups = order.transitOriginalPickupLocations?.length
    ? order.transitOriginalPickupLocations
    : order.transitCo.fromYard
      ? [order.transitCo.fromYard]
      : order.pickupLocations || ["3445"];
  order.pickupLocations = restoredPickups;
  order.sourceYard = order.transitOriginalSourceYard || restoredPickups[0] || order.sourceYard;
  order.childOrderDetails = (order.childOrderDetails || []).map((child) => {
    const next = normalizeOrder({ ...child });
    const childRestoredPickups = next.transitOriginalPickupLocations?.length
      ? next.transitOriginalPickupLocations
      : restoredPickups;
    next.pickupLocations = childRestoredPickups;
    next.sourceYard = next.transitOriginalSourceYard || childRestoredPickups[0] || next.sourceYard;
    delete next.transitCo;
    delete next.transitOriginalPickupLocations;
    delete next.transitOriginalSourceYard;
    return next;
  });
  delete order.transitCo;
  delete order.transitOriginalPickupLocations;
  delete order.transitOriginalSourceYard;
  order.notes = String(order.notes || "").replace(/^Transit via [^.]+\.?\s*/i, "").trim();
  orders = orders.filter((item) => item.id !== coId);
  if (activeOrderType === "CO" && !orders.some((item) => item.type === "CO")) activeOrderType = "SO";
  selectedOrderId = order.id;
  selectedOrderIds = new Set([order.id]);
  logDispatchAudit({
    action: "co_cancelled",
    entityType: "order",
    entityId: coId,
    orderId: coId,
    before: { sourceOrder: beforeOrder, coOrder: beforeCo },
    after: { sourceOrder: summarizeOrder(order) },
    details: { sourceOrderId: order.id, removedStops }
  });
  return { coId, removedStops };
}

function optimizeSelectedRoute() {
  const { load } = selectedLoad();
  if (!load) return;
  load.stops.sort((a, b) => {
    if (a.type !== b.type) return a.type === "pick" ? -1 : 1;
    return minutes(stopOrder(a)?.windowStart || "23:59") - minutes(stopOrder(b)?.windowStart || "23:59");
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function moveWholeLoadToDriverLane(loadId, driverLane, targetLoadCard = null, clientX = 0) {
  const found = findLoad(loadId);
  if (!found.load || loadHasDriverActivity(found.load)) {
    routeNotice = found.load ? loadActivityLockNotice(found.load) : "Load no longer exists.";
    render({ save: false });
    return false;
  }
  const nextLogin = String(driverLane?.dataset?.driverLaneDrop || "");
  const before = summarizeLoad(found.load);
  let targetLoadId = targetLoadCard?.dataset?.driverLoadCard || "";
  if (targetLoadId === found.load.id) targetLoadId = "";
  const targetRect = targetLoadCard?.getBoundingClientRect();
  const insertAfter = Boolean(targetRect && clientX > targetRect.left + (targetRect.width / 2));
  const moved = moveLoadToDriverLane(found.load.id, nextLogin, { targetLoadId, insertAfter });
  if (!moved) {
    routeNotice = "Load could not be moved because its assignment changed during the drag.";
    render({ save: false });
    return false;
  }
  routeNotice = nextLogin
    ? `${found.load.name} moved to ${driverByKey(nextLogin)?.name || nextLogin}; its start time was recalculated.`
    : `${found.load.name} moved to Unassigned.`;
  logDispatchAudit({
    action: "load_driver_updated",
    entityType: "load",
    entityId: found.load.id,
    loadId: found.load.id,
    before,
    after: summarizeLoad(found.load)
  });
  return commitPlanMutation("load_driver_updated");
}

function clearDriverLaneDragStyles() {
  document.querySelectorAll(".driver-lane.driver-lane-dragging, .driver-lane.driver-lane-drag-before, .driver-lane.driver-lane-drag-after")
    .forEach((lane) => lane.classList.remove("driver-lane-dragging", "driver-lane-drag-before", "driver-lane-drag-after"));
}

app.addEventListener("dragstart", (event) => {
  if (!ensureDispatchPlanEditor()) {
    event.preventDefault();
    return;
  }
  const driverLaneHandle = event.target.closest("[data-driver-lane-handle]");
  if (driverLaneHandle) {
    const driverLane = driverLaneHandle.closest("[data-driver-lane]");
    const driverLogin = String(driverLaneHandle.dataset.driverLaneHandle || "").trim().toLowerCase();
    if (!driverLogin || driverLane?.dataset.driverLaneReorderable !== "true") {
      event.preventDefault();
      return;
    }
    dragged = { type: "driver-lane-order", driverLogin };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `driver-lane:${driverLogin}`);
    driverLane.classList.add("driver-lane-dragging");
    if (typeof event.dataTransfer.setDragImage === "function") event.dataTransfer.setDragImage(driverLane, 16, 24);
    return;
  }
  const poMapSo = event.target.closest("[data-po-map-so]");
  if (poMapSo) {
    captureActiveLinkModalDraft();
    const draft = getLinkModalDraft("po", modalOrderId);
    draft.pendingSoLineKey = poMapSo.dataset.targetLineKey || "";
    refreshPoLinkBoardInPlace(modalOrderId);
    dragged = { type: "po-map-so", targetLineKey: poMapSo.dataset.targetLineKey };
    poMapSo.classList.add("dragging");
    event.dataTransfer.effectAllowed = "link";
    event.dataTransfer.setData("text/plain", poMapSo.dataset.targetLineKey);
    return;
  }
  const orderCard = event.target.closest("[data-order]");
  const stopCard = event.target.closest("[data-stop]");
  const loadCard = event.target.closest("[data-driver-load-card]");
  if (stopCard) {
    const found = findStop(stopCard.dataset.stop);
    if (found?.load && loadHasDriverActivity(found.load)) {
      event.preventDefault();
      dragged = null;
      routeNotice = loadActivityLockNotice(found.load);
      return render({ save: false });
    }
    dragged = { type: "stop", stopId: stopCard.dataset.stop };
    event.dataTransfer.setData("text/plain", stopCard.dataset.stop);
  } else if (driverOrientedPlanningEnabled() && loadCard && !event.target.closest("input, select, button")) {
    const found = findLoad(loadCard.dataset.driverLoadCard);
    if (!found.load || loadHasDriverActivity(found.load)) {
      event.preventDefault();
      dragged = null;
      return;
    }
    dragged = { type: "load", loadId: found.load.id };
    event.dataTransfer.setData("text/plain", found.load.id);
  } else if (orderCard) {
    const order = orderById(orderCard.dataset.order);
    if (orderCard.dataset.planned === "true") {
      event.preventDefault();
      dragged = null;
      if (order && isOrderPlannedOutsideCurrentPlan(order)) {
        routeNotice = `${order.id} is already ${orderPlannedElsewhereText(order)}. Remove it from that plan before adding it here.`;
        render({ save: false });
      }
      return;
    }
    dragged = { type: "order", orderId: orderCard.dataset.order };
    event.dataTransfer.setData("text/plain", orderCard.dataset.order);
  }
});

app.addEventListener("dragend", () => {
  document.querySelectorAll(".po-match-card.dragging, .po-match-card.drag-over").forEach(
    (card) => card.classList.remove("dragging", "drag-over")
  );
  clearDriverLaneDragStyles();
  dragged = null;
});

function startPreviewResize(event) {
  isResizingPreview = true;
  event.preventDefault();
}

function movePreviewResize(event) {
  if (!isResizingPreview) return;
  const maxWidth = Math.round(window.innerWidth * 0.92);
  loadPreviewWidth = Math.min(Math.max(window.innerWidth - event.clientX, 390), maxWidth);
  dispatchStorageSet("mbbs.dispatch.previewWidth", String(loadPreviewWidth));
  const panel = document.querySelector(".load-preview-panel");
  if (panel) panel.style.width = `${loadPreviewWidth}px`;
}

function stopPreviewResize() {
  isResizingPreview = false;
}

function beginWholeLoadPointerDrag(event) {
  const loadHandle = event.target.closest(".load-drag-handle");
  if (!loadHandle) return false;
  if (!ensureDispatchPlanEditor()) return true;
  const loadCard = loadHandle.closest("[data-driver-load-card]");
  const found = findLoad(loadCard?.dataset?.driverLoadCard || "");
  if (!found.load || loadHasDriverActivity(found.load)) {
    routeNotice = found.load ? loadActivityLockNotice(found.load) : "Load no longer exists.";
    render({ save: false });
    return true;
  }
  pointerDraggedLoadId = found.load.id;
  document.body.classList.add("load-pointer-dragging");
  loadCard.classList.add("pointer-drag-source");
  event.preventDefault();
  return true;
}

function highlightWholeLoadDropTarget(event) {
  if (!pointerDraggedLoadId) return;
  document.querySelectorAll("[data-driver-lane-drop].drag-over").forEach((lane) => lane.classList.remove("drag-over"));
  document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-driver-lane-drop]")?.classList.add("drag-over");
  event.preventDefault();
}

function finishWholeLoadPointerDrag(event) {
  if (!pointerDraggedLoadId) return;
  const loadId = pointerDraggedLoadId;
  pointerDraggedLoadId = "";
  document.body.classList.remove("load-pointer-dragging");
  document.querySelectorAll(".pointer-drag-source").forEach((card) => card.classList.remove("pointer-drag-source"));
  const targetElement = document.elementFromPoint(event.clientX, event.clientY);
  const driverLane = targetElement?.closest("[data-driver-lane-drop]");
  const targetLoadCard = targetElement?.closest("[data-driver-load-card]");
  document.querySelectorAll("[data-driver-lane-drop].drag-over").forEach((lane) => lane.classList.remove("drag-over"));
  if (driverLane) moveWholeLoadToDriverLane(loadId, driverLane, targetLoadCard, event.clientX);
}

app.addEventListener("pointerdown", (event) => {
  if (beginWholeLoadPointerDrag(event)) return;
  if (!event.target.closest(".load-preview-resize")) return;
  startPreviewResize(event);
});

app.addEventListener("mousedown", (event) => {
  if (beginWholeLoadPointerDrag(event)) return;
  if (!event.target.closest(".load-preview-resize")) return;
  startPreviewResize(event);
});

window.addEventListener("pointermove", movePreviewResize);
window.addEventListener("mousemove", movePreviewResize);
window.addEventListener("pointermove", highlightWholeLoadDropTarget);
window.addEventListener("mousemove", highlightWholeLoadDropTarget);
window.addEventListener("pointerup", (event) => {
  stopPreviewResize();
  finishWholeLoadPointerDrag(event);
});
window.addEventListener("pointercancel", () => {
  pointerDraggedLoadId = "";
  document.body.classList.remove("load-pointer-dragging");
  document.querySelectorAll(".pointer-drag-source, [data-driver-lane-drop].drag-over").forEach((element) => element.classList.remove("pointer-drag-source", "drag-over"));
});
window.addEventListener("mouseup", (event) => {
  stopPreviewResize();
  finishWholeLoadPointerDrag(event);
});

function isEditingTextField(target) {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  return Boolean(element.closest("input, textarea, select, [contenteditable='true']"));
}

window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(String(event.key || "").toLowerCase()) && !isDispatchPlanEditor()) {
    event.preventDefault();
    ensureDispatchPlanEditor();
    return;
  }
  if (!event.ctrlKey || event.metaKey || event.altKey || isEditingTextField(event.target)) return;
  const key = String(event.key || "").toLowerCase();
  if (key === "z") {
    event.preventDefault();
    if (!undoDispatchChange()) {
      routeNotice = "Nothing to undo.";
      render({ save: false });
    }
  } else if (key === "y") {
    event.preventDefault();
    if (!redoDispatchChange()) {
      routeNotice = "Nothing to redo.";
      render({ save: false });
    }
  }
});

app.addEventListener("dragover", (event) => {
  if (dragged?.type === "driver-lane-order") {
    const targetLane = event.target.closest('[data-driver-lane][data-driver-lane-reorderable="true"]');
    const targetLogin = String(targetLane?.dataset.driverLane || "").trim().toLowerCase();
    if (!targetLane || !targetLogin || targetLogin === dragged.driverLogin) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    document.querySelectorAll(".driver-lane.driver-lane-drag-before, .driver-lane.driver-lane-drag-after")
      .forEach((lane) => lane.classList.remove("driver-lane-drag-before", "driver-lane-drag-after"));
    const rect = targetLane.getBoundingClientRect();
    const insertAfter = event.clientY > rect.top + (rect.height / 2);
    targetLane.classList.add(insertAfter ? "driver-lane-drag-after" : "driver-lane-drag-before");
    return;
  }
  const poMapTarget = event.target.closest("[data-po-map-po]");
  if (dragged?.type === "po-map-so" && poMapTarget) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "link";
    poMapTarget.classList.add("drag-over");
    return;
  }
  const list = event.target.closest(".stop-list, .preview-stop-list");
  const stopCard = event.target.closest(".stop-card, .preview-stop");
  const createZone = event.target.closest(".timeline-drop-zone");
  const driverLane = event.target.closest("[data-driver-lane-drop]");
  if (!list && !createZone && !stopCard && !driverLane) return;
  event.preventDefault();
  document.querySelectorAll(".insert-before,.insert-after").forEach((item) => item.classList.remove("insert-before", "insert-after"));
  if (stopCard) {
    const rect = stopCard.getBoundingClientRect();
    const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0;
    stopCard.classList.add(ratio > 0.66 ? "insert-after" : "insert-before");
  }
  (stopCard || list || createZone || driverLane).classList.add("drag-over");
});

app.addEventListener("dragleave", (event) => {
  event.target.closest("[data-po-map-po]")?.classList.remove("drag-over");
  event.target.closest(".stop-list, .preview-stop-list")?.classList.remove("drag-over");
  event.target.closest(".stop-card, .preview-stop")?.classList.remove("drag-over", "insert-before", "insert-after");
  event.target.closest(".timeline-drop-zone")?.classList.remove("drag-over");
  event.target.closest("[data-driver-lane-drop]")?.classList.remove("drag-over");
  event.target.closest("[data-driver-lane]")?.classList.remove("driver-lane-drag-before", "driver-lane-drag-after");
});

app.addEventListener("drop", (event) => {
  if (!ensureDispatchPlanEditor()) {
    event.preventDefault();
    return;
  }
  if (dragged?.type === "driver-lane-order") {
    event.preventDefault();
    const sourceLogin = dragged.driverLogin;
    const targetLane = event.target.closest('[data-driver-lane][data-driver-lane-reorderable="true"]');
    const targetLogin = String(targetLane?.dataset.driverLane || "").trim().toLowerCase();
    const insertAfter = Boolean(targetLane?.classList.contains("driver-lane-drag-after"));
    dragged = null;
    clearDriverLaneDragStyles();
    if (targetLogin && moveDriverLaneByDrop(sourceLogin, targetLogin, insertAfter)) {
      routeNotice = "Driver lane position updated for this plan date.";
      commitPlanMutation("move-driver-lane");
    } else {
      render({ save: false });
    }
    return;
  }
  const poMapTarget = event.target.closest("[data-po-map-po]");
  if (dragged?.type === "po-map-so" && poMapTarget) {
    event.preventDefault();
    poMapTarget.classList.remove("drag-over");
    const connected = setPoLineMatch(modalOrderId, dragged.targetLineKey, poMapTarget.dataset.poLineId);
    dragged = null;
    if (!connected) {
      setModalFormStatus(poMapTarget.closest("form"), "These lines have different item codes and cannot be connected.", "error");
    }
    return;
  }
  const targetStop = event.target.closest(".stop-card, .preview-stop");
  const list = event.target.closest(".stop-list, .preview-stop-list");
  const createZone = event.target.closest(".timeline-drop-zone");
  const driverLane = event.target.closest("[data-driver-lane-drop]");
  const targetLoadCard = event.target.closest("[data-driver-load-card]");
  if ((!list && !createZone && !driverLane) || !dragged) return;
  event.preventDefault();
  list?.classList.remove("drag-over");
  targetStop?.classList.remove("drag-over", "insert-before", "insert-after");
  createZone?.classList.remove("drag-over");
  driverLane?.classList.remove("drag-over");
  if (dragged.type === "load" && driverLane) {
    const loadId = dragged.loadId;
    dragged = null;
    moveWholeLoadToDriverLane(loadId, driverLane, targetLoadCard, event.clientX);
    return;
  }
  if (!list && !createZone) {
    dragged = null;
    return;
  }
  if (createZone && dragged.type === "order") {
    const laneLogin = createZone.dataset.loadCreateDriver;
    if (laneLogin !== undefined && !String(laneLogin || "").trim()) {
      routeNotice = t("dispatch.assignDriverBeforeOrder", "Assign the order to a driver lane before creating a load.");
      dragged = null;
      return render({ save: false });
    }
    const truck = laneLogin !== undefined
      ? defaultTruckForDriver(laneLogin)
      : trucks.find((item) => item.id === createZone.dataset.loadCreate);
    if (laneLogin !== undefined && !truck) {
      routeNotice = t("dispatch.selectTruckBeforeLoad", "Select a truck before creating the first load.");
      dragged = null;
      return render({ save: false });
    }
    if (truck) {
      const driver = laneLogin !== undefined ? driverByKey(laneLogin) : truckDriver(truck);
      if (laneLogin === undefined && !truckHasDriver(truck)) {
        routeNotice = driverLockNotice(truck);
        dragged = null;
        return render({ save: false });
      }
      const load = addLoadToTruck(truck, truck.loads.length, driver);
      const added = addOrderToLoad(dragged.orderId, load.id);
      if (!added && !load.stops.length) {
        truck.loads = truck.loads.filter((item) => item.id !== load.id);
        renumberTruckLoads(truck);
      }
      if (added) {
        logDispatchAudit({
          action: "load_added_by_drop",
          entityType: "load",
          entityId: load.id,
          loadId: load.id,
          truckId: truck.id,
          after: summarizeLoad(load),
          details: { truck: summarizeTruck(truck), orderId: dragged.orderId }
        });
      }
    }
    dragged = null;
    return commitPlanMutation("drop_order_new_load");
  }
  if (!list) return;
  const targetLoadId = targetStop?.dataset.load || list.dataset.load;
  const targetFound = findLoad(targetLoadId);
  const targetLoad = targetFound.load;
  if (targetLoad && loadHasDriverActivity(targetLoad)) {
    routeNotice = loadActivityLockNotice(targetLoad);
    dragged = null;
    return render({ save: false });
  }
  if (!loadHasAssignedDriver(targetFound.truck, targetLoad)) {
    routeNotice = driverLockNotice(targetFound.truck);
    dragged = null;
    return render({ save: false });
  }
  const insertIndex = insertIndexFromDrop(event, targetStop, targetLoad);
  if (dragged.type === "order") {
    const added = addOrderToLoad(dragged.orderId, targetLoadId, "drop", "", Number.isInteger(insertIndex) ? insertIndex : null);
    if (added) routeNotice = "";
  } else if (dragged.type === "stop") {
    const found = findStop(dragged.stopId);
    const target = findLoad(targetLoadId).load;
    if (found && target) {
      if (found.load.id !== target.id && orderHasDriverActivityInLoad(found.load, found.stop.orderId)) {
        routeNotice = stopActivityLockNotice(found.stop);
        dragged = null;
        return render({ save: false });
      }
      const beforeSource = summarizeLoad(found.load);
      const beforeTarget = found.load.id === target.id ? beforeSource : summarizeLoad(target);
      const movedStop = summarizeStop(found.stop);
      const warning = stopMoveWarning(found, target, insertIndex);
      if (warning) {
        routeNotice = `Invalid sequence: ${warning}`;
        dragged = null;
        return render({ save: false });
      }
      const [stop] = found.stops.splice(found.index, 1);
      stop.loadId = target.id;
      const adjustedIndex = found.load.id === target.id && Number.isInteger(insertIndex) && found.index < insertIndex ? insertIndex - 1 : insertIndex;
      if (Number.isInteger(adjustedIndex)) target.stops.splice(adjustedIndex, 0, stop);
      else target.stops.push(stop);
      selectedLoadId = target.id;
      routeNotice = "";
      logDispatchAudit({
        action: "stop_moved",
        entityType: "load",
        entityId: target.id,
        orderId: stop.orderId,
        loadId: target.id,
        before: { source: beforeSource, target: beforeTarget },
        after: { source: summarizeLoad(found.load), target: summarizeLoad(target) },
        details: {
          stop: movedStop,
          fromLoadId: found.load.id,
          toLoadId: target.id,
          fromIndex: found.index,
          toIndex: adjustedIndex
        }
      });
    }
  }
  dragged = null;
  commitPlanMutation("drop_order_or_stop");
});

app.addEventListener("click", (event) => {
  if (event.target.dataset?.action === "close-modal") {
    const closingType = modalType;
    const closingOrderRef = modalOrderId;
    captureActiveLinkModalDraft();
    if (closingType === "po-link") clearLinkModalDraft("po", closingOrderRef);
    if (closingType === "to-link") clearLinkModalDraft("to", closingOrderRef);
    orderDependencyAbortController?.abort();
    poAllocationAbortController?.abort();
    modalType = "";
    modalOrderId = "";
    modalLoadId = "";
    poAllocationOptions = null;
    poAllocationLoading = false;
    poAllocationError = "";
    orderDependencyOptions = null;
    orderDependencyLoading = false;
    orderDependencyError = "";
    return render({ save: false });
  }
  const button = event.target.closest("button");
  if (!button) {
    const orderCard = event.target.closest("[data-order]");
    if (orderCard) {
      if (event.detail > 1) return;
      const clickedOrder = orderById(orderCard.dataset.order);
      if (clickedOrder && isOrderPlannedOutsideCurrentPlan(clickedOrder)) {
        jumpToPlannedOrder(clickedOrder.id).catch((error) => {
          routeNotice = `Plan jump failed: ${error.message}`;
          render({ save: false });
        });
        return;
      }
      selectedOrderId = orderCard.dataset.order;
      const assignment = orderAssignment(selectedOrderId);
      if (assignment.load) {
        selectedLoadId = assignment.load.id;
        loadPreviewOpen = true;
        routeNotice = `${selectedOrderId} is planned on ${assignment.truck?.plate || "truck"} ${assignment.load.name}.`;
      }
      if (event.ctrlKey || event.metaKey) {
        if (selectedOrderIds.has(orderCard.dataset.order)) selectedOrderIds.delete(orderCard.dataset.order);
        else selectedOrderIds.add(orderCard.dataset.order);
        if (!selectedOrderIds.size) selectedOrderIds.add(orderCard.dataset.order);
      } else {
        selectedOrderIds = new Set([orderCard.dataset.order]);
      }
      clearTimeout(orderClickTimer);
      orderClickTimer = setTimeout(() => render({ save: false }), 180);
      return;
    }
  }
  if (!button) return;
  const action = button.dataset.action;
  if (!action) return;
  if (action === "edit-custom-order") {
    const customOrderId = String(button.dataset.customOrderId || "").trim();
    location.href = customOrderId
      ? `/dispatch/custom-orders?edit=${encodeURIComponent(customOrderId)}`
      : "/dispatch/custom-orders";
    return;
  }
  if (action === "enter-edit-mode") {
    enterDispatchEditMode().catch((error) => {
      routeNotice = `Cannot enter Edit Mode: ${error.message}`;
      render({ save: false });
    });
    return;
  }
  if (action === "exit-edit-mode") {
    releaseDispatchEditMode().catch((error) => {
      routeNotice = `Cannot exit Edit Mode: ${error.message}`;
      render({ save: false });
    });
    return;
  }
  if (action === "save-plan-now") {
    forceSaveCurrentPlan().catch((error) => {
      reportDispatchSaveError("save-now", error);
      routeNotice = `Save failed: ${error.message}`;
      render({ save: false });
    });
    return;
  }
  if (action === "override-truck-switch") {
    if (!window.confirm("Override this failed Samsara truck reassignment and allow the driver to continue?")) return;
    button.disabled = true;
    fetch(`/api/dispatch/driver-truck-switches/${encodeURIComponent(button.dataset.jobId || "")}/override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Dispatcher override from planning board" })
    }).then(async (response) => {
      if (!response.ok) throw new Error(await dispatchErrorMessage(response));
      await loadDriverJobStatuses();
      routeNotice = "Truck switch override recorded. The driver can continue.";
      render({ save: false });
    }).catch((error) => {
      routeNotice = `Truck switch override failed: ${error.message}`;
      render({ save: false });
    });
    return;
  }
  if (action === "refresh-to-link-match") {
    const draft = getLinkModalDraft("to", modalOrderId);
    draft.structureWarning = "";
    loadOrderDependencyOptions(orderById(modalOrderId)).catch(() => null);
    return;
  }
  if (action === "match-to-link-lines") {
    captureActiveLinkModalDraft();
    const order = orderById(modalOrderId);
    const draft = getLinkModalDraft("to", modalOrderId);
    const form = button.closest("form");
    if (!String(draft.ref || "").trim()) {
      setModalFormStatus(form, "Enter a Transfer Order number before matching.", "error");
      return;
    }
    loadOrderDependencyOptions(order, { transferOrderRef: draft.ref }).catch((error) => {
      orderDependencyError = error.message || "Unable to match Transfer Order lines.";
      renderActiveLinkModalInPlace();
    });
    return;
  }
  if (action === "refresh-po-link-options") {
    const draft = getLinkModalDraft("po", modalOrderId);
    draft.structureWarning = "";
    loadPoAllocationOptions(modalOrderId).catch(() => null);
    return;
  }
  if (action === "select-po-map-so") {
    captureActiveLinkModalDraft();
    const draft = getLinkModalDraft("po", modalOrderId);
    draft.pendingSoLineKey = button.dataset.targetLineKey || "";
    if (!refreshPoLinkBoardInPlace(modalOrderId)) renderActiveLinkModalInPlace();
    return;
  }
  if (action === "select-po-map-po") {
    captureActiveLinkModalDraft();
    const draft = getLinkModalDraft("po", modalOrderId);
    const form = button.closest("form");
    if (!draft.pendingSoLineKey) {
      setModalFormStatus(form, "Select an SO line first, then choose its PO line.", "info");
      return;
    }
    if (!setPoLineMatch(modalOrderId, draft.pendingSoLineKey, button.dataset.poLineId)) {
      setModalFormStatus(form, "These lines have different item codes and cannot be connected.", "error");
    }
    return;
  }
  if (action === "remove-po-line-match") {
    removePoLineMatch(modalOrderId, button.dataset.targetLineKey);
    return;
  }
  if (DISPATCH_VIEW_MUTATION_ACTIONS.has(action) && !ensureDispatchPlanEditor()) return;
  if (action === "update-dependency-mode") {
    const dependencyId = button.dataset.dependency;
    const mode = app.querySelector(`[data-dependency-mode="${CSS.escape(dependencyId)}"]`)?.value;
    fetch(`/api/dispatch/order-dependencies/${encodeURIComponent(dependencyId)}/mode`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dispatchLeaseRequestPayload({ mode }))
    }).then(async (response) => {
      if (!response.ok) throw new Error(await dispatchErrorMessage(response));
      return response.json();
    }).then(async (payload) => {
      if (Array.isArray(payload.orders)) applyDispatchOrderFeed(payload.orders);
      routeNotice = "Dependency mode updated.";
      await loadOrderDependencyOptions(orderById(modalOrderId));
    }).catch((error) => {
      routeNotice = `Dependency update failed: ${error.message}`;
      render({ save: false });
    });
    return;
  }
  if (action === "unlink-dependency") {
    const dependencyId = button.dataset.dependency;
    if (!window.confirm("Unlink this Transfer Order dependency?")) return;
    fetch(`/api/dispatch/order-dependencies/${encodeURIComponent(dependencyId)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dispatchLeaseRequestPayload())
    }).then(async (response) => {
      if (!response.ok) throw new Error(await dispatchErrorMessage(response));
      return response.json();
    }).then(async (payload) => {
      if (Array.isArray(payload.orders)) applyDispatchOrderFeed(payload.orders);
      orderDependencyOptions = null;
      routeNotice = "Order dependency unlinked.";
      requestOrderPoolRefreshOnNextSave();
      commitPlanMutation("to_link_cancelled");
      await loadOrderDependencyOptions(orderById(modalOrderId));
    }).catch((error) => {
      routeNotice = `Dependency unlink failed: ${error.message}`;
      render({ save: false });
    });
    return;
  }
  if (action === "undo-plan") {
    if (!undoDispatchChange()) {
      routeNotice = "Nothing to undo.";
      render({ save: false });
    }
    return;
  }
  if (action === "redo-plan") {
    if (!redoDispatchChange()) {
      routeNotice = "Nothing to redo.";
      render({ save: false });
    }
    return;
  }
  if (button.dataset.order) {
    selectedOrderId = button.dataset.order;
    if (!selectedOrderIds.has(button.dataset.order)) selectedOrderIds = new Set([button.dataset.order]);
  }
  if (action === "open-group-modal") {
    modalType = "group";
    modalOrderId = button.dataset.order;
  }
  if (action === "ungroup-order") {
    ungroupOrder(button.dataset.order);
    requestOrderPoolRefreshOnNextSave();
    commitPlanMutation("ungroup_order");
    return;
  }
  if (action === "unsplit-order") {
    const prepared = prepareUnsplitOrder(button.dataset.order);
    if (!prepared) {
      render({ save: false });
      return;
    }
    fetch("/api/dispatch/split-orders/unsplit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        originalOrderId: prepared.parent.id,
        orderType: prepared.parent.type,
        splitOrderIds: prepared.siblingIds,
        planDate: currentPlanDate,
        editLeaseToken: planEditLeaseToken,
        audit: { sessionId: dispatchSessionId }
      })
    }).then((response) => {
      if (!response.ok) return response.text().then((text) => Promise.reject(new Error(text)));
      return response.json();
    }).then(() => {
      applyUnsplitOrder(prepared);
      requestOrderPoolRefreshOnNextSave();
      commitPlanMutation("unsplit_order");
    }).catch((error) => {
      routeNotice = `Unsplit failed: ${error.message}`;
      render({ save: false });
    });
    return;
  }
  if (action === "open-split-modal") {
    modalType = "split";
    modalOrderId = button.dataset.order;
    const splitOrderTarget = orderById(button.dataset.order);
    splitParts = Math.max(2, Math.ceil((orderFootprintPallets(splitOrderTarget) || 2) / 10));
    ensureSplitDraft(orderById(button.dataset.order), true);
  }
  if (action === "open-consolidate-modal") {
    modalType = "consolidate";
    modalOrderId = button.dataset.order;
  }
  if (action === "open-po-yard-modal") {
    modalType = "po-yard";
    modalOrderId = button.dataset.order;
  }
  if (action === "open-po-link-modal") {
    modalType = "po-link";
    modalOrderId = button.dataset.order;
    poAllocationError = "";
    getLinkModalDraft("po", modalOrderId);
    render({ save: false });
    loadPoAllocationOptions(button.dataset.order).catch(() => null);
    return;
  }
  if (action === "open-to-link-modal") {
    modalType = "to-link";
    modalOrderId = button.dataset.order;
    orderDependencyOptions = null;
    orderDependencyError = "";
    getLinkModalDraft("to", modalOrderId);
    render({ save: false });
    loadOrderDependencyOptions(orderById(modalOrderId)).catch(() => null);
    return;
  }
  if (action === "order-type-tab") {
    activeOrderType = button.dataset.type;
    searchText = "";
    cancelDispatchOrderSearch();
    selectedOrderIds = new Set();
    selectedOrderId = openOrders()[0]?.id || selectedOrderId;
    if (selectedOrderId) selectedOrderIds.add(selectedOrderId);
  }
  if (action === "open-plan-history") {
    loadPlanHistory().then(() => {
      modalType = "plan-history";
      render({ save: false });
    });
    return;
  }
  if (action === "export-shipped-csv") {
    if (!currentPlan?.id) {
      routeNotice = "Load or save a dispatch plan before exporting shipped orders.";
      return render({ save: false });
    }
    fetch(`/api/dispatch/plans/${encodeURIComponent(currentPlan.id)}/shipped-orders.csv`)
      .then((response) => {
        if (!response.ok) return response.text().then((text) => Promise.reject(new Error(text)));
        return response.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `shipped-orders-${currentPlanDate || currentPlan.id}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      })
      .catch((error) => {
        routeNotice = `CSV export failed: ${error.message}`;
        render({ save: false });
      });
    return;
  }
  if (action === "refresh-plan-history") {
    loadPlanHistory().finally(() => render({ save: false }));
    return;
  }
  if (action === "load-plan-id") {
    loadPlanById(button.dataset.planId).then((plan) => {
      modalType = "";
      routeNotice = `Loaded ${displayDate(plan.planDate)} ${plan.status}.`;
      render({ save: false });
    }).catch((error) => {
      routeNotice = `Plan load failed: ${error.message}`;
      render({ save: false });
    });
    return;
  }
  if (action === "confirm-plan") {
    confirmCurrentPlanAtomic().then((plan) => {
      if (Array.isArray(plan.followupWarnings) && plan.followupWarnings.length) {
        const warning = new Error(plan.followupWarnings.map((item) => `${item.step}: ${item.message}`).join("; "));
        reportDispatchSaveError("confirmed-with-followup-warning", warning, { followupWarnings: plan.followupWarnings });
        routeNotice = `Plan ${displayDate(plan.planDate)} confirmed, but ${plan.followupWarnings.map((item) => item.label || item.step).join(", ")} needs attention. Details are in the browser console.`;
      } else {
        routeNotice = `Plan ${displayDate(plan.planDate)} confirmed.`;
      }
      render({ save: false });
    }).catch((error) => {
      reportDispatchSaveError("confirm", error, { code: error.code || "" });
      routeNotice = error.code === "DISPATCH_CONFIRM_REFRESH_FAILED"
        ? error.message
        : `Confirm failed: ${error.message}`;
      render({ save: false });
    });
    return;
  }
  if (action === "reopen-plan") {
    fetch(`/api/dispatch/plans/${encodeURIComponent(currentPlan.id)}/reopen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dispatchLeaseRequestPayload({ audit: { sessionId: dispatchSessionId } }))
    }).then((response) => {
      if (!response.ok) return response.text().then((text) => Promise.reject(new Error(text)));
      return response.json();
    }).then(async (plan) => {
      currentPlan = plan;
      currentPlanDate = plan.planDate;
      dispatchStorageSet(DISPATCH_PLAN_DATE_KEY, currentPlanDate);
      if (Array.isArray(plan.orders) && Array.isArray(plan.trucks)) applySavedPlan(plan);
      await loadPlanHistory();
      currentPlan = compactCurrentPlan(plan);
      routeNotice = `Plan ${displayDate(plan.planDate)} opened for editing.`;
      render({ save: false });
    }).catch((error) => {
      routeNotice = `Edit failed: ${error.message}`;
      render({ save: false });
    });
    return;
  }
  if (action === "confirm-group") {
    const before = selectedOrders().map(summarizeOrder);
    if (!groupOrder(button.dataset.order)) {
      render({ save: false });
      return;
    }
    requestOrderPoolRefreshOnNextSave();
    logDispatchAudit({
      action: "orders_grouped",
      entityType: "order",
      entityId: selectedOrderId,
      orderId: selectedOrderId,
      before,
      after: summarizeOrder(orderById(selectedOrderId)),
      details: { sourceOrderIds: before.map((item) => item?.id).filter(Boolean) }
    });
    modalType = "";
    modalOrderId = "";
  }
  if (action === "request-unpack-for-split") {
    const order = orderById(button.dataset.order);
    fetch("/api/dispatch/operator-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dispatchLeaseRequestPayload({
        requestType: "unpack_for_split",
        orderRef: order?.id,
        sourceOrderType: order?.type,
        details: {
          reason: "Dispatcher needs to split packed order.",
          operatorStatus: order?.operatorStatus,
          localYardOrderStatus: order?.localYardOrderStatus,
          planDate: currentPlanDate
        },
        audit: { sessionId: dispatchSessionId }
      }))
    }).then((response) => {
      if (!response.ok) return response.text().then((text) => Promise.reject(new Error(text)));
      return response.json();
    }).then(() => {
      modalType = "";
      modalOrderId = "";
      routeNotice = `Unpack request sent for ${order?.id}.`;
      render({ save: false });
    }).catch((error) => {
      routeNotice = `Unpack request failed: ${error.message}`;
      render({ save: false });
    });
    return;
  }
  if (action === "confirm-split") {
    const order = orderById(button.dataset.order);
    const before = summarizeOrder(order);
    fetch(`/api/dispatch/orders/${encodeURIComponent(button.dataset.order)}/split-seed?type=${encodeURIComponent(order?.type || "")}`)
      .then((response) => {
        if (!response.ok) return response.text().then((text) => Promise.reject(new Error(text)));
        return response.json();
      })
      .then((seed) => {
        splitOrder(button.dataset.order, splitParts, seed.nextSuffix);
        requestOrderPoolRefreshOnNextSave();
        const created = orders.filter((item) => item.originalOrderId === button.dataset.order).map(summarizeOrder);
        logDispatchAudit({
          action: "order_split",
          entityType: "order",
          entityId: button.dataset.order,
          orderId: button.dataset.order,
          before,
          after: created,
          details: {
            splitParts,
            startSuffix: seed.nextSuffix,
            createdOrderIds: created.map((item) => item?.id).filter(Boolean)
          }
        });
        modalType = "";
        modalOrderId = "";
        commitPlanMutation("split_order");
      })
      .catch((error) => {
        routeNotice = `Split failed: ${error.message}`;
        render({ save: false });
      });
    return;
  }
  if (action === "confirm-consolidate") {
    const before = summarizeOrder(orderById(button.dataset.order));
    consolidatePick(button.dataset.order, button.dataset.yard);
    requestOrderPoolRefreshOnNextSave();
    logDispatchAudit({
      action: "consolidate_pick_created",
      entityType: "order",
      entityId: button.dataset.order,
      orderId: button.dataset.order,
      before,
      after: summarizeOrder(orderById(button.dataset.order)),
      details: { sourceYard: button.dataset.yard, transferOrderId: orderById(button.dataset.order)?.consolidation?.transferOrderId }
    });
    modalType = "";
    modalOrderId = "";
  }
  if (action === "confirm-po-yard") {
    const vendorYardId = document.getElementById("poVendorYardSelect")?.value;
    const before = summarizeOrder(orderById(button.dataset.order));
    fetch(`/api/dispatch/orders/${encodeURIComponent(button.dataset.order)}/vendor-yard`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dispatchLeaseRequestPayload({ vendorYardId, audit: { sessionId: dispatchSessionId, before } }))
    }).then((response) => {
      if (!response.ok) return response.text().then((text) => Promise.reject(new Error(text)));
      return loadDispatchOrders();
    }).then(() => {
      modalType = "";
      modalOrderId = "";
      routeNotice = "PO vendor yard updated.";
      render({ save: false });
    }).catch((error) => {
      routeNotice = `PO yard update failed: ${error.message}`;
      render({ save: false });
    });
    return;
  }
  if (action === "cancel-po-link") {
    fetch(`/api/dispatch/po-allocations/${encodeURIComponent(button.dataset.allocation)}?sessionId=${encodeURIComponent(dispatchSessionId)}&planDate=${encodeURIComponent(currentPlanDate)}&editLeaseToken=${encodeURIComponent(planEditLeaseToken)}`, {
      method: "DELETE"
    }).then((response) => {
      if (!response.ok) return response.text().then((text) => Promise.reject(new Error(text)));
      return response.json();
    }).then((payload) => {
      poAllocationOptions = payload.options;
      applyDispatchOrderFeed(payload.orders || []);
      requestOrderPoolRefreshOnNextSave();
      routeNotice = "PO link cancelled.";
      commitPlanMutation("cancel_po_link");
    }).catch((error) => {
      routeNotice = `Cancel PO link failed: ${error.message}`;
      render({ save: false });
    });
    return;
  }
  if (action === "delete-load") {
    const { load } = findLoad(button.dataset.load);
    if (!load) return render({ save: false });
    if (loadHasDriverActivity(load)) {
      routeNotice = loadActivityLockNotice(load);
      return render({ save: false });
    }
    if (!load.returnOnly && load.stops.length) {
      modalType = "delete-load";
      modalLoadId = load.id;
      return render({ save: false });
    } else {
      deleteLoad(load.id);
    }
  }
  if (action === "confirm-delete-load") {
    const { load } = findLoad(button.dataset.load);
    if (load && loadHasDriverActivity(load)) {
      routeNotice = loadActivityLockNotice(load);
      modalType = "";
      modalLoadId = "";
      return render({ save: false });
    }
    deleteLoad(button.dataset.load);
    modalType = "";
    modalLoadId = "";
  }
  if (action === "select-load") {
    selectedLoadId = button.dataset.load;
    loadPreviewOpen = true;
  }
  if (action === "close-load-preview") loadPreviewOpen = false;
  if (action === "toggle-sequence") sequenceCollapsed = !sequenceCollapsed;
  if (action === "clear-load") {
    const { load } = findLoad(button.dataset.load);
    if (load) {
      if (loadHasDriverActivity(load)) {
        routeNotice = loadActivityLockNotice(load);
        return render({ save: false });
      }
      const before = summarizeLoad(load);
      load.stops = [];
      logDispatchAudit({
        action: "load_cleared",
        entityType: "load",
        entityId: load.id,
        loadId: load.id,
        before,
        after: summarizeLoad(load)
      });
    }
  }
  if (action === "add-load") {
    const truck = trucks.find((item) => item.id === button.dataset.truck);
    if (truck) {
      if (!truckHasDriver(truck)) {
        routeNotice = driverLockNotice(truck);
        return render({ save: false });
      }
      const insertIndex = insertIndexForLoadButton(truck, button);
      const load = addLoadToTruck(truck, insertIndex);
      selectedLoadId = load.id;
      logDispatchAudit({
        action: "load_added",
        entityType: "load",
        entityId: load.id,
        loadId: load.id,
        truckId: truck.id,
        after: summarizeLoad(load),
        details: { truck: summarizeTruck(truck), insertIndex }
      });
    }
  }
  if (["add-driver-load", "add-driver-return", "insert-driver-return"].includes(action)) {
    const login = String(button.dataset.driverLogin || "").toLowerCase();
    const driver = driverByKey(login);
    const selectedFound = findLoad(selectedLoadId);
    const requestedAfterLoadId = button.dataset.afterLoad
      || (action === "add-driver-return" && loadDriverKey(selectedFound.truck, selectedFound.load) === login ? selectedLoadId : "");
    const requestedAfter = requestedAfterLoadId ? findLoad(requestedAfterLoadId) : null;
    const truck = requestedAfter?.truck || defaultTruckForDriver(login);
    if (!truck) {
      routeNotice = "Add a truck in Dispatch Setup before creating a load.";
      return render({ save: false });
    }
    const previous = requestedAfter?.load ? requestedAfter : driverLoadEntries(login).at(-1);
    const physicalInsertIndex = requestedAfter?.load
      ? Math.max(0, truck.loads.findIndex((item) => item.id === requestedAfter.load.id) + 1)
      : truck.loads.length;
    const isReturn = action !== "add-driver-load";
    const load = isReturn
      ? addReturnLoadToTruck(truck, physicalInsertIndex, driver)
      : addLoadToTruck(truck, physicalInsertIndex, driver);
    if (previous) {
      load.startMode = "auto";
      load.start = "";
      load.switchYard = loadEndOwnYard(previous.load) || previous.load.returnYard || truck.base || "12441";
    } else {
      load.startMode = "fixed";
      load.start = DEFAULT_FIRST_LOAD_START;
    }
    moveLoadToDriverLane(load.id, login, {
      targetLoadId: previous?.load?.id || "",
      insertAfter: Boolean(previous)
    });
    selectedLoadId = load.id;
    routeNotice = requestedAfter?.load
      ? `${load.name} inserted after ${requestedAfter.load.name} for ${driver?.name || "Unassigned"}.`
      : `${load.name} added for ${driver?.name || "Unassigned"} on ${truck.plate}.`;
    logDispatchAudit({
      action: isReturn ? "return_load_added" : "load_added",
      entityType: "load",
      entityId: load.id,
      loadId: load.id,
      truckId: truck.id,
      after: summarizeLoad(load),
      details: { driverLogin: login, truckPlate: truck.plate }
    });
  }
  if (action === "move-truck-up" || action === "move-truck-down") {
    const moved = moveTruckInPlan(button.dataset.truck, action === "move-truck-up" ? -1 : 1);
    if (moved) {
      routeNotice = "";
      requestTruckSequenceSaveOnNextSave();
    }
  }
  if (action === "move-driver-up" || action === "move-driver-down") {
    const moved = moveDriverLane(button.dataset.driverLogin, action === "move-driver-up" ? -1 : 1);
    if (moved) routeNotice = "Driver lane position updated for this plan date.";
  }
  if (action === "add-return-load") {
    const truck = trucks.find((item) => item.id === button.dataset.truck);
    if (truck) {
      if (!truckHasDriver(truck)) {
        routeNotice = driverLockNotice(truck);
        return render({ save: false });
      }
      const insertIndex = insertIndexForLoadButton(truck, button);
      const load = addReturnLoadToTruck(truck, insertIndex);
      selectedLoadId = load.id;
      logDispatchAudit({
        action: "return_load_added",
        entityType: "load",
        entityId: load.id,
        loadId: load.id,
        truckId: truck.id,
        after: summarizeLoad(load),
        details: { truck: summarizeTruck(truck), insertIndex }
      });
    }
  }
  if (action === "remove-stop") {
    const found = findStop(button.dataset.stop);
    if (found) {
      const orderId = found.stop.orderId;
      const warning = loadHasDriverActivity(found.load) ? loadActivityLockNotice(found.load) : "";
      if (warning) routeNotice = `Cannot remove stop: ${warning}`;
      else {
        const before = summarizeLoad(found.load);
        const removed = found.load.stops.filter((stop) => stop.orderId === orderId).map(summarizeStop);
        found.load.stops = found.load.stops.filter((stop) => stop.orderId !== orderId);
        syncPickupStops();
        cleanupOrphanPickupStops();
        routeNotice = "";
        logDispatchAudit({
          action: "order_removed_from_load",
          entityType: "load",
          entityId: found.load.id,
          orderId,
          loadId: found.load.id,
          before,
          after: summarizeLoad(found.load),
          details: { removed }
        });
      }
    }
  }
  if (action === "optimize-route") {
    const { load } = selectedLoad();
    const before = summarizeLoad(load);
    optimizeSelectedRoute();
    logDispatchAudit({
      action: "route_optimized",
      entityType: "load",
      entityId: load?.id,
      loadId: load?.id,
      before,
      after: summarizeLoad(load)
    });
  }
  if (action === "toggle-route-tolls") {
    const { truck, load } = selectedLoad();
    if (!load) return;
    const before = summarizeLoad(load);
    load.allowTolls = !Boolean(load.allowTolls);
    delete routeCache[load.id];
    delete routeEstimates[load.id];
    routeNotice = load.allowTolls
      ? `${truck?.plate || "Truck"} ${load.name} may use toll roads. ETA recalculating.`
      : `${truck?.plate || "Truck"} ${load.name} will avoid toll roads. ETA recalculating.`;
    logDispatchAudit({
      action: "route_toll_preference_updated",
      entityType: "load",
      entityId: load.id,
      loadId: load.id,
      before,
      after: summarizeLoad(load),
      details: { allowTolls: load.allowTolls }
    });
  }
  if (action === "support-tab") supportTab = button.dataset.tab;
  if (action === "refresh-orders") {
    searchText = "";
    cancelDispatchOrderSearch();
    loadDispatchOrders().then(() => restoreServerPlan()).then((applied) => {
      if (applied) render({ save: false });
      else render({ save: false });
    });
    return;
  }
  if (action === "close-route-notice") routeNotice = "";
  const planMutationActions = new Set([
    "confirm-group",
    "confirm-consolidate",
    "delete-load",
    "confirm-delete-load",
    "clear-load",
    "add-load",
    "add-driver-load",
    "add-driver-return",
    "insert-driver-return",
    "move-truck-up",
    "move-truck-down",
    "move-driver-up",
    "move-driver-down",
    "add-return-load",
    "remove-stop",
    "optimize-route",
    "toggle-route-tolls"
  ]);
  if (planMutationActions.has(action)) commitPlanMutation(action);
  else render({ save: false });
});

app.addEventListener("dblclick", (event) => {
  const orderCard = event.target.closest("[data-order]");
  if (!orderCard) return;
  const order = orderById(orderCard.dataset.order);
  if (!order) return;
  if (order.type === "CUSTOM") {
    location.href = order.customOrderId
      ? `/dispatch/custom-orders?edit=${encodeURIComponent(order.customOrderId)}`
      : "/dispatch/custom-orders";
    return;
  }
  if (!ensureDispatchPlanEditor()) return;
  clearTimeout(orderClickTimer);
  selectedOrderId = order.id;
  selectedOrderIds = new Set([order.id]);
  modalType = "edit-order";
  modalOrderId = order.id;
  orderDependencyOptions = null;
  render({ save: false });
});

app.addEventListener("input", (event) => {
  if (["po-link", "to-link"].includes(modalType) && event.target.closest('[data-link-modal="true"]')) {
    if (modalType === "to-link" && event.target?.id === "toLinkRef") {
      const draft = getLinkModalDraft("to", modalOrderId);
      const nextRef = event.target.value;
      if (draft.ref !== nextRef) {
        draft.ref = nextRef;
        draft.quantities = {};
        draft.structureWarning = "";
        orderDependencyError = "";
        if (orderDependencyOptions) orderDependencyOptions = { ...orderDependencyOptions, matchingLines: [] };
        const results = event.target.closest("form")?.querySelector(".order-dependency-match-lines");
        if (results) results.innerHTML = '<span class="muted">Choose a Transfer Order, then press Match Lines.</span>';
        const submit = event.target.closest("form")?.querySelector('button[type="submit"]');
        if (submit) submit.disabled = true;
      }
      return;
    }
    if (modalType === "po-link" && event.target?.id === "poLinkRef") {
      const draft = getLinkModalDraft("po", modalOrderId);
      const nextRef = event.target.value;
      if (draft.ref !== nextRef) {
        draft.ref = nextRef;
        draft.quantities = {};
        draft.poLineIds = {};
        draft.defaultsAppliedRef = "";
        draft.pendingSoLineKey = "";
      }
      if (applyPoLinkDefaultsForRef(modalOrderId, nextRef)) renderActiveLinkModalInPlace();
      return;
    }
    if (event.target.matches("[data-to-link-qty], [data-po-link-qty]")) updateLinkSalesEquivalent(event.target.closest(".link-quantity-line"));
    captureActiveLinkModalDraft();
    return;
  }
  if (event.target?.id === "splitParts") {
    splitParts = Math.min(Math.max(Number(event.target.value) || 2, 2), 10);
    ensureSplitDraft(orderById(modalOrderId), true);
    return render({ save: false });
  }
  if (event.target?.dataset?.splitSku) {
    const key = event.target.dataset.splitKey || event.target.dataset.splitSku;
    const sku = event.target.dataset.splitSku;
    const index = Number(event.target.dataset.splitIndex);
    const unit = event.target.dataset.splitUnit || "quantity";
    const order = orderById(modalOrderId);
    const item = (order?.items || []).find((candidate, candidateIndex) => splitItemKey(candidate, candidateIndex) === key) || {};
    if (!splitDraft.items[key]) splitDraft.items[key] = Array.from({ length: splitParts }).map(() => splitPartTemplate(item));
    splitDraft.items[key][index] = normalizeSplitPartValue(item, splitDraft.items[key][index]);
    const beforeValue = splitQuantityValue(splitDraft.items[key][index][unit]);
    splitDraft.items[key][index][unit] = Math.max(0, Number(event.target.value) || 0);
    logDispatchAudit({
      action: "split_quantity_edited",
      entityType: "order",
      entityId: modalOrderId,
      orderId: modalOrderId,
      before: { sku, index, unit, value: beforeValue },
      after: { sku, index, unit, value: splitDraft.items[key][index][unit] },
      details: { splitParts }
    });
    return;
  }
  if (event.target?.id !== "orderSearch") return;
  searchText = event.target.value;
  scheduleDispatchOrderSearch();
  refreshOrderPoolForSearch();
});

app.addEventListener("keydown", (event) => {
  if (event.target?.dataset?.loadStart !== undefined) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.target.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      render({ save: false });
    }
    return;
  }
  if (event.key !== "Enter" || event.target?.id !== "toLinkRef" || modalType !== "to-link") return;
  event.preventDefault();
  event.target.closest("form")?.querySelector('[data-action="match-to-link-lines"]')?.click();
});

app.addEventListener("change", (event) => {
  if (["po-link", "to-link"].includes(modalType) && event.target.closest('[data-link-modal="true"]')) {
    captureActiveLinkModalDraft();
    return;
  }
  if (event.target?.id === "planDateInput") {
    const nextDate = event.target.value || todayLocalDate();
    Promise.resolve()
      .then(async () => {
        if (localPlanDirty || saveQueued || saveInFlight) {
          routeNotice = "Saving current plan before switching date...";
          render({ save: false });
          await saveCurrentPlanNow();
        } else {
          clearTimeout(saveTimer);
        }
        if (isDispatchPlanEditor()) await releaseDispatchEditMode();
        return loadPlanForDate(nextDate, { createIfMissing: false });
      })
      .then((result) => {
      routeNotice = result.created
        ? `Started dispatch plan for ${currentPlanDate}.`
        : `Loaded dispatch plan for ${currentPlanDate}.`;
      render({ save: false });
    }).catch((error) => {
      routeNotice = `Plan load failed: ${error.message}`;
      event.target.value = currentPlanDate;
      render({ save: false });
    });
    return;
  }
  if (event.target?.id === "dispatchDate") {
    dispatchDateFilter = event.target.value || "";
    selectedOrderId = openOrders()[0]?.id || selectedOrderId;
    selectedOrderIds = new Set(selectedOrderId ? [selectedOrderId] : []);
    render({ save: false });
    return;
  }
  if (event.target?.dataset?.planTruckBase !== undefined) {
    if (!ensureDispatchPlanEditor()) return;
    const truck = trucks.find((item) => String(item.id) === String(event.target.dataset.planTruckBase));
    if (!truck) return;
    const firstUse = firstTruckUseEntry(truck, { truckId: truck.id, truckPlate: truck.plate });
    if (firstUse?.load && loadHasDriverActivity(firstUse.load)) {
      routeNotice = `${truck.plate} has already started work. Its starting yard for this date cannot be changed.`;
      return render({ save: false });
    }
    const before = summarizeTruck(truck);
    truck.base = String(event.target.value || "").trim();
    if (truck.base && firstUse?.load) firstUse.load.switchYard = truck.base;
    clearActiveRouteEstimates();
    logDispatchAudit({
      action: "truck_start_yard_updated",
      entityType: "truck",
      entityId: truck.id,
      truckId: truck.id,
      before,
      after: summarizeTruck(truck),
      details: { planDate: currentPlanDate, startYard: truck.base || "unknown" }
    });
    commitPlanMutation("truck_start_yard_updated", null, { validateAssignments: false });
    return;
  }
  if (event.target?.dataset?.driverNewTruck !== undefined) {
    driverNewTruckSelections.set(
      String(event.target.dataset.driverNewTruck || "").toLowerCase(),
      event.target.value || ""
    );
    render({ save: false });
    return;
  }
  if (event.target?.dataset?.loadDriver) {
    if (!ensureDispatchPlanEditor()) return;
    const found = findLoad(event.target.dataset.loadDriver);
    if (!found.load) return;
    if (loadHasDriverActivity(found.load)) {
      routeNotice = loadActivityLockNotice(found.load);
      return render({ save: false });
    }
    const before = summarizeLoad(found.load);
    assignLoadToDriver(found.truck, found.load, event.target.value, { append: true });
    logDispatchAudit({
      action: "load_driver_updated",
      entityType: "load",
      entityId: found.load.id,
      loadId: found.load.id,
      before,
      after: summarizeLoad(found.load)
    });
    commitPlanMutation("load_driver_updated");
    return;
  }
  if (event.target?.dataset?.loadTruck) {
    if (!ensureDispatchPlanEditor()) return;
    const found = findLoad(event.target.dataset.loadTruck);
    if (!found.load) return;
    if (loadHasDriverActivity(found.load)) {
      routeNotice = loadActivityLockNotice(found.load);
      return render({ save: false });
    }
    const before = summarizeLoad(found.load);
    const moved = moveLoadToPhysicalTruck(found.load.id, event.target.value);
    if (!moved) {
      routeNotice = "The selected truck is no longer available.";
      return render({ save: false });
    }
    clearActiveRouteEstimates();
    logDispatchAudit({
      action: "load_truck_updated",
      entityType: "load",
      entityId: moved.load.id,
      loadId: moved.load.id,
      truckId: moved.truck.id,
      before,
      after: summarizeLoad(moved.load),
      details: { fromTruck: found.truck.plate, toTruck: moved.truck.plate }
    });
    commitPlanMutation("load_truck_updated");
    return;
  }
  if (event.target?.dataset?.loadStartMode !== undefined) {
    if (!ensureDispatchPlanEditor()) return;
    const found = findLoad(event.target.dataset.loadStartMode);
    if (!found.load) return;
    if (loadHasDriverActivity(found.load)) {
      routeNotice = loadActivityLockNotice(found.load);
      return render({ save: false });
    }
    const before = summarizeLoad(found.load);
    const inheritedTime = timeText(loadStartInfo(found.truck, found.load).start);
    const nextMode = event.target.value === "fixed" ? "fixed" : "auto";
    found.load.startMode = nextMode;
    found.load.start = nextMode === "auto"
      ? ""
      : (normalizeTypedDispatchTime(found.load.start) || inheritedTime);
    invalidateDriverRoutesFromLoad(found.load.id);
    logDispatchAudit({
      action: "load_start_mode_updated",
      entityType: "load",
      entityId: found.load.id,
      loadId: found.load.id,
      before,
      after: summarizeLoad(found.load)
    });
    commitPlanMutation("load_start_mode_updated");
    return;
  }
  if (event.target?.dataset?.loadStart !== undefined) {
    if (!ensureDispatchPlanEditor()) return;
    const found = findLoad(event.target.dataset.loadStart);
    if (!found.load) return;
    if (loadHasDriverActivity(found.load)) {
      routeNotice = loadActivityLockNotice(found.load);
      return render({ save: false });
    }
    const normalizedStart = normalizeTypedDispatchTime(event.target.value);
    if (!normalizedStart) {
      routeNotice = "Enter a valid start time, for example 7, 700, 07:30, or 7:30.";
      return render({ save: false });
    }
    const before = summarizeLoad(found.load);
    found.load.startMode = "fixed";
    found.load.start = normalizedStart;
    invalidateDriverRoutesFromLoad(found.load.id);
    logDispatchAudit({
      action: "load_start_time_updated",
      entityType: "load",
      entityId: found.load.id,
      loadId: found.load.id,
      before,
      after: summarizeLoad(found.load)
    });
    commitPlanMutation("load_start_time_updated");
    return;
  }
  if (event.target?.dataset?.loadSwitchYard) {
    if (!ensureDispatchPlanEditor()) return;
    const found = findLoad(event.target.dataset.loadSwitchYard);
    if (!found.load) return;
    const before = summarizeLoad(found.load);
    found.load.switchYard = event.target.value || "12441";
    invalidateDriverRoutesFromLoad(found.load.id);
    logDispatchAudit({
      action: "load_switch_yard_updated",
      entityType: "load",
      entityId: found.load.id,
      loadId: found.load.id,
      before,
      after: summarizeLoad(found.load)
    });
    commitPlanMutation("load_switch_yard_updated");
    return;
  }
  if (event.target?.dataset?.loadParking) {
    if (!ensureDispatchPlanEditor()) return;
    const found = findLoad(event.target.dataset.loadParking);
    if (!found.load) return;
    const before = summarizeLoad(found.load);
    found.load.parkingSpot = event.target.value || "";
    logDispatchAudit({
      action: "load_parking_spot_updated",
      entityType: "load",
      entityId: found.load.id,
      loadId: found.load.id,
      before,
      after: summarizeLoad(found.load)
    });
    commitPlanMutation("load_parking_spot_updated");
    return;
  }
  if (event.target?.dataset?.truckStart) {
    if (!ensureDispatchPlanEditor()) return;
    const truck = trucks.find((item) => item.id === event.target.dataset.truckStart);
    if (truck) {
      const before = summarizeTruck(truck);
      truck.base = event.target.value || "12441";
      clearActiveRouteEstimates();
      logDispatchAudit({
        action: "truck_start_yard_updated",
        entityType: "truck",
        entityId: truck.id,
        truckId: truck.id,
        before,
        after: summarizeTruck(truck)
      });
      commitPlanMutation("truck_start_yard_updated");
    }
    return;
  }
  if (event.target?.dataset?.truckDriver) {
    if (!ensureDispatchPlanEditor()) return;
    const truck = trucks.find((item) => item.id === event.target.dataset.truckDriver);
    if (truck) {
      const before = summarizeTruck(truck);
      const driver = driverByKey(event.target.value);
      const nextDriverKey = driver ? driverKey(driver) : "";
      if (!nextDriverKey && truckHasPlanningContent(truck)) {
        routeNotice = `${truck.plate} already has planned load activity. Change to another driver or clear the truck before unassigning.`;
        return render({ save: false });
      }
      const swapTruck = nextDriverKey ? truckAssignedToDriver(nextDriverKey, truck.id) : null;
      const swapBefore = summarizeTruck(swapTruck);
      const currentDriver = truckDriver(truck);
      if (swapTruck && !currentDriver) {
        routeNotice = `${driver.name} is already on ${swapTruck.plate}. Assign a driver to ${truck.plate} first, then swap.`;
        return render({ save: false });
      }
      applyDriverToTruck(truck, driver);
      if (swapTruck) applyDriverToTruck(swapTruck, currentDriver);
      clearActiveRouteEstimates();
      logDispatchAudit({
        action: swapTruck ? "truck_driver_swapped" : "truck_driver_updated",
        entityType: "truck",
        entityId: truck.id,
        truckId: truck.id,
        before: swapTruck ? { target: before, swapped: swapBefore } : before,
        after: swapTruck ? { target: summarizeTruck(truck), swapped: summarizeTruck(swapTruck) } : summarizeTruck(truck),
        details: swapTruck ? { swappedTruckId: swapTruck.id, selectedDriver: driver?.name || "", movedDriver: currentDriver?.name || "" } : {}
      });
      routeNotice = swapTruck
        ? `${driver.name} moved to ${truck.plate}. ${currentDriver.name} moved to ${swapTruck.plate}.`
        : "";
      commitPlanMutation(swapTruck ? "truck_driver_swapped" : "truck_driver_updated");
    }
    return;
  }
  if (event.target?.dataset?.truckParking) {
    if (!ensureDispatchPlanEditor()) return;
    const truck = trucks.find((item) => item.id === event.target.dataset.truckParking);
    if (truck) {
      const before = summarizeTruck(truck);
      truck.parkingSpot = event.target.value || "";
      logDispatchAudit({
        action: "truck_parking_spot_updated",
        entityType: "truck",
        entityId: truck.id,
        truckId: truck.id,
        before,
        after: summarizeTruck(truck)
      });
      commitPlanMutation("truck_parking_spot_updated");
    }
    return;
  }
  if (event.target?.dataset?.returnYard) {
    if (!ensureDispatchPlanEditor()) return;
    const { load } = findLoad(event.target.dataset.returnYard);
    if (load) {
      const before = summarizeLoad(load);
      load.returnYard = event.target.value || "12441";
      logDispatchAudit({
        action: "return_yard_updated",
        entityType: "load",
        entityId: load.id,
        loadId: load.id,
        before,
        after: summarizeLoad(load)
      });
      commitPlanMutation("return_yard_updated");
    }
    return;
  }
});

function showOrderTooltip(event) {
  const card = event.target.closest("[data-order]");
  if (!card) return;
  const order = orderById(card.dataset.order);
  if (!order) return;
  selectedOrderId = order.id;
  const tooltip = document.getElementById("orderTooltip");
  tooltip.className = "tooltip";
  tooltip.style.left = `${Math.min(event.clientX + 16, window.innerWidth - 330)}px`;
  tooltip.style.top = `${Math.min(event.clientY + 16, window.innerHeight - 180)}px`;
  const stopCard = event.target.closest("[data-stop]");
  const foundStop = stopCard ? findStop(stopCard.dataset.stop) : null;
  const stop = foundStop?.stop || null;
  const pickupLocation = stop?.type === "pick" ? stop.location : "";
  const isDropStop = stop?.type === "drop";
  const dropItems = isDropStop ? dropItemsForStop(order, stop).filter(itemHasQuantity) : [];
  const pickupOrders = pickupLocation && foundStop?.load ? pickupOrdersForStop(foundStop.load, stop) : [];
  let timingHtml = "";
  if (foundStop?.truck && foundStop?.load && stop) {
    const stats = loadStats(foundStop.truck, foundStop.load);
    const row = stats.rows[foundStop.index];
    const record = driverRecordForStop(foundStop.truck, foundStop.load, stop);
    timingHtml = timingDetailHtml({
      title: stop.type === "pick" ? `Pickup ${pickupStopLabel(stop, order)}` : `Drop ${dropStopLabel(stop, order)}`,
      plannedStart: row?.arrival || 0,
      plannedEnd: row?.depart || row?.arrival || 0,
      actualStart: recordStartedAt(record),
      actualEnd: recordCompletedAt(record)
    });
  }
  const itemRows = pickupOrders.length
    ? pickupOrders.map((pickupOrder) => tooltipItemRowsForOrder(pickupOrder, { pickupLocation, includeOrderHeader: true })).join("")
    : tooltipItemRowsForOrder(order, { pickupLocation, stop });
  const poPickupAddress = !pickupLocation && !isDropStop && order.type === "PO" && order.sourceAddress
    ? `<span>Pickup address: ${escapeHtml(order.sourceAddress)}</span>`
    : "";
  const tooltipTitle = pickupLocation
    ? `Pickup | ${escapeHtml(pickupStopLabel(stop, pickupOrders[0] || order))}`
    : isDropStop
      ? `${escapeHtml(dropStopLabel(stop, order))} | ${escapeHtml(order.customer)}`
      : `${escapeHtml(order.id)} | ${escapeHtml(order.customer)}`;
  const tooltipAddress = pickupLocation
    ? stopAddress(stop, pickupOrders[0] || order)
    : isDropStop
      ? stopAddress(stop, order)
      : order.address;
  const dropSummary = isDropStop
    ? `${order.expectedDeliveryDate ? `${displayDate(order.expectedDeliveryDate)} | ` : ""}${dropItems.length} line${dropItems.length === 1 ? "" : "s"} | ${dropUnitText(order, stop)} | ${dropFootprintPallets(order, stop)} pos | ${formatLbs(dropWeightLbs(order, stop))} | ${order.windowStart || "--"}-${order.windowEnd || "--"}`
    : "";
  tooltip.innerHTML = `
    <strong>${tooltipTitle}</strong>
    <span>${escapeHtml(tooltipAddress)}</span>
    ${poPickupAddress}
    ${pickupLocation ? `<span>Pickup content: ${escapeHtml(pickupLocation)}</span>` : ""}
    ${pickupLocation
      ? `<span>${pickupOrders.length} order${pickupOrders.length === 1 ? "" : "s"} at this pickup stop.</span>`
      : `<span>${dropSummary || `${order.expectedDeliveryDate ? `${displayDate(order.expectedDeliveryDate)} | ` : ""}${orderUnitText(order)} | ${orderFootprintPallets(order)} pos | ${formatLbs(orderWeightLbs(order))} | ${order.windowStart || "--"}-${order.windowEnd || "--"}`}</span>`}
    ${!pickupLocation && order.consolidation ? `<span>Consolidate ${order.consolidation.shortageQty} from ${order.consolidation.sourceYard} to ${order.consolidation.targetYard}</span>` : ""}
    ${!pickupLocation && order.transitCo ? `<span>Requires ${order.transitCo.id}: ${order.transitCo.fromYard} to ${order.transitCo.toYard}</span>` : ""}
    ${!pickupLocation && order.type === "CO" ? `<span>Local CO for ${escapeHtml(order.sourceOrderId || order.relatedSoId || "")}</span>` : ""}
    ${!pickupLocation ? `<span>${escapeHtml(order.notes)}</span>` : ""}
    ${timingHtml}
    ${itemRows ? `<div class="tooltip-items">${itemRows}</div>` : ""}
  `;
}

function showLoadTooltip(event) {
  const card = event.target.closest("[data-load-card]");
  if (!card) return;
  const { truck, load } = findLoad(card.dataset.loadCard);
  if (!truck || !load) return;
  const stats = loadStats(truck, load);
  const finishText = loadFinishText(truck, load, stats);
  const tooltip = document.getElementById("orderTooltip");
  tooltip.className = "tooltip load-tooltip";
  tooltip.style.left = `${Math.min(event.clientX + 16, window.innerWidth - 330)}px`;
  tooltip.style.top = `${Math.min(event.clientY + 16, window.innerHeight - 220)}px`;
  const assigned = [...new Set(load.stops.map((stop) => stop.orderId))]
    .map(orderById)
    .filter(Boolean)
    .map((order) => `<div><b>${escapeHtml(order.id)}</b><span>${orderFootprintPallets(order)} pos | ${formatLbs(orderWeightLbs(order))}</span></div>`)
    .join("");
  tooltip.innerHTML = `
    <strong>${escapeHtml(truck.plate)} | ${escapeHtml(load.name)}</strong>
    <span class="${finishText === "Route pending" ? "route-pending" : ""}">${formatLbs(stats.weightTotalLbs)}/${formatLbs(stats.capacityLbs)} | ${stats.footprintTotal} pos | ${finishText === "Route pending" ? finishText : `Finish ${finishText}`}</span>
    <span>Start ${timeText(stats.start)} | ${load.returnOnly ? "Return load" : `${load.stops.filter((stop) => stop.type === "drop").length} drops`}</span>
    ${stats.warnings.length ? `<span>${escapeHtml(stats.warnings[0])}</span>` : `<span>No warning.</span>`}
    <div class="tooltip-items">${renderLoadTimingDetails(truck, load, stats)}</div>
    ${assigned ? `<div class="tooltip-items">${assigned}</div>` : ""}
  `;
}

function showDispatchTooltip(event) {
  if (event.target.closest("[data-order]")) return showOrderTooltip(event);
  if (event.target.closest("[data-load-card]")) return showLoadTooltip(event);
}

app.addEventListener("mouseover", showDispatchTooltip);
app.addEventListener("pointerover", showDispatchTooltip);

app.addEventListener("mousemove", (event) => {
  const tooltip = document.getElementById("orderTooltip");
  if (!tooltip?.classList.contains("tooltip")) return;
  tooltip.style.left = `${Math.min(event.clientX + 16, window.innerWidth - 330)}px`;
  tooltip.style.top = `${Math.min(event.clientY + 16, window.innerHeight - 180)}px`;
});

function hideDispatchTooltip(event) {
  if (!event.target.closest("[data-order], [data-load-card]")) return;
  const tooltip = document.getElementById("orderTooltip");
  tooltip.className = "";
  tooltip.innerHTML = "";
}

app.addEventListener("mouseout", hideDispatchTooltip);
app.addEventListener("pointerout", hideDispatchTooltip);

app.addEventListener("submit", (event) => {
  const form = event.target.closest("form");
  if (!form) return;
  if (form.dataset.form === "dispatch-login") return;
  event.preventDefault();
  if (["po-link", "to-link", "edit-order-details"].includes(form.dataset.form) && !ensureDispatchPlanEditor()) return;
  const data = Object.fromEntries(new FormData(form).entries());
  if (form.dataset.form === "to-link") {
    const order = orderById(modalOrderId);
    if (!order) return;
    captureActiveLinkModalDraft();
    const draft = getLinkModalDraft("to", order.id);
    const transferOrderRef = String(draft.ref || "").trim();
    const allocations = [...form.querySelectorAll(".to-link-line[data-target-line-key]")]
      .map((row) => {
        const quantities = {};
        for (const input of row.querySelectorAll("[data-to-link-qty]")) quantities[input.dataset.toLinkQty] = Number(input.value || 0);
        return { targetLineKey: row.dataset.targetLineKey, quantities };
      })
      .filter((line) => Object.values(line.quantities).some((value) => Number(value || 0) > 0));
    if (!transferOrderRef) {
      setModalFormStatus(form, "Enter a Transfer Order number.", "error");
      return;
    }
    if (!allocations.length) {
      setModalFormStatus(form, "Enter quantity for at least one matched item.", "error");
      return;
    }
    if (draft.structureWarning) {
      setModalFormStatus(form, "Review the refreshed order structure before linking.", "error");
      return;
    }
    const submitButton = form.querySelector("button[type='submit']");
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Linking...";
    }
    setModalFormStatus(form, "Validating Transfer Order quantities...", "info");
    fetch("/api/dispatch/order-dependencies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dispatchLeaseRequestPayload({
        dispatchTargetRef: order.id,
        transferOrderRef,
        mode: draft.mode || "direct_to_customer",
        targetSignature: draft.targetSignature,
        allocations,
        audit: { sessionId: dispatchSessionId }
      }))
    }).then(async (response) => {
      if (!response.ok) throw new Error(await dispatchErrorMessage(response));
      return response.json();
    }).then((payload) => {
      if (Array.isArray(payload.orders)) applyDispatchOrderFeed(payload.orders);
      clearLinkModalDraft("to", order.id);
      getLinkModalDraft("to", order.id);
      orderDependencyOptions = null;
      requestOrderPoolRefreshOnNextSave();
      routeNotice = `${transferOrderRef} linked with ${order.id}.`;
      commitPlanMutation("to_link_created");
      loadOrderDependencyOptions(orderById(order.id)).catch(() => null);
    }).catch((error) => {
      setModalFormStatus(form, `TO link failed: ${error.message}`, "error");
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Link Transfer Order";
      }
    });
    return;
  }
  if (form.dataset.form === "po-link") {
    const order = orderById(modalOrderId);
    if (!order) return;
    captureActiveLinkModalDraft();
    const draft = getLinkModalDraft("po", order.id);
    const poRef = String(data.poRef || "").trim();
    const lines = [...form.querySelectorAll(".po-link-line")].map((row) => ({
      salesLineId: row.dataset.salesLine,
      targetLineKey: row.dataset.targetLineKey,
      poLineId: String(draft.poLineIds[row.dataset.targetLineKey] || ""),
      quantities: {
        pallets: row.querySelector('[data-po-link-qty="pallets"]')?.value || 0,
        layers: row.querySelector('[data-po-link-qty="layers"]')?.value || 0,
        sections: row.querySelector('[data-po-link-qty="sections"]')?.value || 0,
        pieces: row.querySelector('[data-po-link-qty="pieces"]')?.value || 0,
        salesQty: row.querySelector('[data-po-link-qty="salesQty"]')?.value || 0
      }
    })).filter((line) => Object.values(line.quantities).some((value) => Number(value || 0) > 0));
    if (!poRef) {
      setModalFormStatus(form, "Enter a PO number before connecting.", "error");
      return;
    }
    if (!lines.length) {
      setModalFormStatus(form, "Enter quantity for at least one connected SO item.", "error");
      return;
    }
    if (lines.some((line) => !line.poLineId)) {
      setModalFormStatus(form, "Connect every SO line that has a quantity to a PO line.", "error");
      return;
    }
    if (draft.structureWarning) {
      setModalFormStatus(form, "Review the refreshed order structure before connecting the PO.", "error");
      return;
    }
    const submitButton = form.querySelector("button[type='submit']");
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Connecting...";
    }
    setModalFormStatus(form, "Checking PO available quantity...", "info");
    fetch(`/api/dispatch/orders/${encodeURIComponent(order.id)}/po-allocations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dispatchLeaseRequestPayload({
        poRef,
        lines,
        targetSignature: draft.targetSignature,
        audit: { sessionId: dispatchSessionId }
      }))
    }).then((response) => {
      if (!response.ok) return response.text().then((text) => Promise.reject(new Error(text)));
      return response.json();
    }).then((payload) => {
      poAllocationOptions = payload.options;
      if (Array.isArray(payload.orders)) applyDispatchOrderFeed(payload.orders);
      clearLinkModalDraft("po", order.id);
      const nextDraft = getLinkModalDraft("po", order.id);
      nextDraft.targetSignature = payload.options?.order?.targetSignature || "";
      requestOrderPoolRefreshOnNextSave();
      routeNotice = `${payload.allocations?.length || 0} PO item line(s) connected to sales order.`;
      commitPlanMutation("po_link_created");
    }).catch((error) => {
      setModalFormStatus(form, `PO link failed: ${error.message}`, "error");
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Connect PO Quantity";
      }
    });
    return;
  }
  if (form.dataset.form === "edit-order-details") {
    const order = orderById(modalOrderId);
    if (!order) return;
    const windowStart = modalTimeValue(data.windowStart);
    const windowEnd = modalTimeValue(data.windowEnd);
    const validation = timeValidationMessage(windowStart, windowEnd);
    if (validation) {
      setEditFormStatus(form, validation, "error");
      return;
    }
    const supportsTransitCo = supportsTransitCoForOrder(order);
    const wantsTransitCo = supportsTransitCo && data.createTransitCo === "on";
    const transitFromYard = data.transitFromYard || order.pickupLocations?.[0] || "3445";
    const transitToYard = data.transitToYard || "12441";
    if (wantsTransitCo && String(transitFromYard) === String(transitToYard)) {
      setEditFormStatus(form, "CO pick-from yard and transit depot must be different.", "error");
      return;
    }
    const submitButton = form.querySelector("button[type='submit']");
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Saving...";
    }
    setEditFormStatus(form, "Saving dispatch info...", "info");
    const saveDetails = isLocalDispatchOrder(order)
      ? Promise.resolve({ orders: null })
      : fetch(`/api/dispatch/orders/${encodeURIComponent(order.id)}/details`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(dispatchLeaseRequestPayload({
            type: order.type,
            sourceTable: order.sourceTable,
            address: data.address,
            pickupAddress: String(data.pickupAddress || "").trim(),
            expectedDeliveryDate: data.expectedDeliveryDate,
            windowStart,
            windowEnd,
            audit: {
              sessionId: dispatchSessionId,
              before: summarizeOrder(order)
            }
          }))
        }).then((response) => {
          if (!response.ok) return response.text().then((text) => Promise.reject(new Error(text)));
          return response.json();
        });
    saveDetails.then(async (payload) => {
      const pickupAddress = String(data.pickupAddress || "").trim();
      order.address = data.address;
      order.pickupAddressOverride = pickupAddress;
      order.sourceAddress = pickupAddress || order.defaultSourceAddress || "";
      order.expectedDeliveryDate = data.expectedDeliveryDate || "";
      order.windowStart = windowStart;
      order.windowEnd = windowEnd;
      if (Array.isArray(payload.orders)) applyDispatchOrderFeed(payload.orders);
      let coOrder = null;
      let cancelledCo = null;
      if (wantsTransitCo) {
        coOrder = upsertTransitCoForOrder(order.id, transitFromYard, transitToYard);
        if (coOrder) activeOrderType = "CO";
      } else if (supportsTransitCo && order.transitCo?.id) {
        cancelledCo = cancelTransitCoForOrder(order.id);
      }
      if (coOrder || cancelledCo) requestOrderPoolRefreshOnNextSave();
      if (coOrder) {
        persistTransitCoInBackground(
          saveTransitCoToServer(order, coOrder),
          `${coOrder.id} saved to local DB.`
        );
      }
      if (cancelledCo?.coId) {
        persistTransitCoInBackground(
          cancelTransitCoOnServer(cancelledCo.coId),
          `${cancelledCo.coId} cancellation saved to local DB.`
        );
      }
      modalType = "";
      modalOrderId = "";
      routeNotice = coOrder
        ? `${coOrder.id} initiated. Plan this CO before dropping ${order.id}.`
        : cancelledCo
          ? `${cancelledCo.coId} cancelled. ${order.id} pickup restored.`
          : "Dispatch info updated.";
      clearActiveRouteEstimates();
      commitPlanMutation("dispatch_order_details_updated");
    }).catch((error) => {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Save Dispatch Info";
      }
      setEditFormStatus(form, `Update failed: ${error.message}`, "error");
    });
    return;
  }
  if (form.dataset.form === "driver") {
    drivers.push({
      name: data.name,
      license: data.license,
      number: data.number,
      login: data.login,
      ownYardFixedMinutes: Number(data.ownYardFixedMinutes || data.loadMinutes || 40),
      vendorFixedMinutes: Number(data.vendorFixedMinutes || data.outsideFixedMinutes || data.unloadMinutes || 35),
      deliveryFixedMinutes: Number(data.deliveryFixedMinutes || data.outsideFixedMinutes || data.unloadMinutes || 35),
      outsideFixedMinutes: Number(data.deliveryFixedMinutes || data.outsideFixedMinutes || data.unloadMinutes || 35),
      minutesPerPallet: Number(data.minutesPerPallet || 1),
      loadMinutes: Number(data.ownYardFixedMinutes || data.loadMinutes || 40),
      unloadMinutes: Number(data.deliveryFixedMinutes || data.outsideFixedMinutes || data.unloadMinutes || 35)
    });
  } else if (form.dataset.form === "truck") {
    const vehicle = { plate: data.plate, capacityLbs: Number(data.capacityLbs || 48000) };
    fleet.push(vehicle);
    trucks.push(makeTruckFromFleet(vehicle, trucks.length));
  } else {
    return;
  }
  render({ save: false });
});

async function initDispatch() {
  try {
    await loadDispatchConfig();
    await loadDispatchSetup();
    await loadDispatchVendorYards();
    await loadDispatchOrders();
    await loadPlanHistory();
    const restoredServer = await loadPlanForDate(currentPlanDate, { createIfMissing: false });
    await loadDriverJobStatuses();
    if (!restoredServer.loaded) resetPlanningBoard();
  } catch (error) {
    console.error("Dispatch planner initialization failed", error);
    routeNotice = `Planning data could not fully load: ${error.message}. You can still review the available board and retry Edit Mode.`;
    if (!trucks.length && !dispatchSetupLoaded) resetPlanningBoard();
  }
  render({ save: false });
  connectEvents();
  setInterval(pollServerPlan, 1000);
}

window.addEventListener("mbbs-language-changed", () => {
  render({ save: false });
});

window.addEventListener("pagehide", () => {
  flushPersistedRouteEstimateCache();
  if (!isDispatchPlanEditor()) return;
  fetch("/api/dispatch/plan-edit-lease/release", {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dispatchLeaseRequestPayload())
  }).catch(() => {});
});

requireDispatchLogin({
  mount: app,
  roles: SALES_PLANNING_HOST ? ["sales", "admin"] : ["dispatcher", "admin"],
  onReady: initDispatch
});

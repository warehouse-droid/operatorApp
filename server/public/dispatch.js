const app = document.getElementById("dispatchApp");
const t = (key, fallback) => window.MBBS_I18N?.t(key, fallback) || fallback;
const languageToggle = () => window.MBBS_I18N?.toggleHtml() || "";
const displayDate = (value) => window.MBBS_I18N?.displayDate(value) || "";
const displayDateTime = (value) => window.MBBS_I18N?.displayDateTime(value) || "";
const DISPATCH_SESSION_KEY = "mbbs.dispatch.sessionId";
const dispatchSessionId = localStorage.getItem(DISPATCH_SESSION_KEY) || `dispatch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
localStorage.setItem(DISPATCH_SESSION_KEY, dispatchSessionId);

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
let supportTab = "drivers";
let searchText = "";
let activeOrderType = "SO";
let modalType = "";
let modalOrderId = "";
let modalLoadId = "";
let splitParts = 2;
let splitDraft = { orderId: "", parts: 0, items: {} };
let poAllocationOptions = null;
let poAllocationLoading = false;
let selectedOrderIds = new Set([selectedOrderId]);
let loadPreviewOpen = false;
let sequenceCollapsed = false;
let lastSavedAt = "";
let routeNotice = "";
let dispatchDateFilter = "";
let dispatchConfig = { googleMapsApiKey: "" };
let dispatchVendorYards = [];
let driverJobStatuses = [];
let googleMapsPromise = null;
let routeEstimates = {};
let routeCache = {};
let geocodeCache = {};
let orderListScrollTop = 0;
let loadPreviewWidth = Number(localStorage.getItem("mbbs.dispatch.previewWidth") || 520);
let isResizingPreview = false;
let lastServerSavedAt = "";
let saveTimer = null;
let isApplyingRemotePlan = false;
let localPlanDirty = false;
let lastLocalPlanEditAt = "";
let blockedRemotePlanUpdate = false;
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
const HISTORY_LIMIT = 80;
const DISPATCH_PLAN_KEY = "mbbs.dispatch.plan";
const DISPATCH_PLAN_DATE_KEY = "mbbs.dispatch.planDate";
let currentPlanDate = localStorage.getItem(DISPATCH_PLAN_DATE_KEY) || todayLocalDate();
let currentPlan = null;
let planHistory = [];

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

function driverJobIdForStop(truck, load, stop) {
  return [currentPlan?.id, truck.id || truck.plate, load.id, stop.id].map((part) => encodeURIComponent(String(part || ""))).join(":");
}

function driverTravelJobIdForLoad(truck, load, startTravel) {
  if (!startTravel) return "";
  return [currentPlan?.id, truck.id || truck.plate, load.id, "TRAVEL", startTravel.from, startTravel.to].map((part) => encodeURIComponent(String(part || ""))).join(":");
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

function truckHasDriver(truck) {
  return Boolean(truckDriver(truck));
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
    base: saved.base || "12441",
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
    loads: saved.loads?.length ? saved.loads : [{ id: `${id}-L1`, name: "Load 1", stops: [] }]
  };
}

function trucksFromFleetAndSavedPlan(savedTrucks = []) {
  const savedList = Array.isArray(savedTrucks) ? savedTrucks : [];
  const fleetByPlate = new Map(fleet.map((vehicle) => [String(vehicle.plate || ""), vehicle]));
  const savedByPlate = new Map(savedList.map((truck) => [String(truck.plate || ""), truck]));
  const orderedVehicles = [];
  const seen = new Set();
  for (const savedTruck of savedList) {
    const plate = String(savedTruck.plate || "");
    const vehicle = fleetByPlate.get(plate) || { plate, capacityLbs: truckCapacityLbs(savedTruck), travelTimePercent: truckTravelTimePercent(savedTruck) };
    if (!vehicle.plate || seen.has(String(vehicle.plate))) continue;
    orderedVehicles.push(vehicle);
    seen.add(String(vehicle.plate));
  }
  for (const vehicle of fleet) {
    const plate = String(vehicle.plate || "");
    if (!plate || seen.has(plate)) continue;
    orderedVehicles.push(vehicle);
    seen.add(plate);
  }
  return normalizeUniqueTruckDrivers(orderedVehicles.map((vehicle, index) => makeTruckFromFleet(vehicle, index, savedByPlate.get(String(vehicle.plate || "")))));
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

function itemForPickupLocation(item = {}, pickupLocation = "") {
  const location = String(pickupLocation || "").trim();
  if (!location) return item;
  if (isOwnYardCode(location)) {
    return {
      ...item,
      pallets: positiveBalance(item.pallets, item.poAllocatedPallets),
      layers: positiveBalance(item.layers, item.poAllocatedLayers),
      sections: positiveBalance(item.sections, item.poAllocatedSections),
      pieces: positiveBalance(item.pieces, item.poAllocatedPieces),
      quantity: positiveBalance(item.quantity || item.salesQty, item.poAllocatedSalesQty),
      salesQty: positiveBalance(item.salesQty || item.quantity, item.poAllocatedSalesQty)
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

function itemHasQuantity(item = {}) {
  return Number(item.pallets || 0)
    || Number(item.layers || 0)
    || Number(item.sections || 0)
    || Number(item.pieces || 0)
    || Number(item.quantity || item.salesQty || 0);
}

function tooltipItemsForOrder(order, { pickupLocation = "" } = {}) {
  return (order.items || [])
    .map((item) => pickupLocation ? itemForPickupLocation(item, pickupLocation) : item)
    .filter(itemHasQuantity);
}

function availableUnitsForLine(line = {}) {
  const available = line.available || {};
  const units = [
    ["pallets", "PLT", available.pallets],
    ["layers", "LYR", available.layers],
    ["sections", "SEC", available.sections],
    ["pieces", "PCS", available.pieces]
  ].filter(([, , value]) => Number(value || 0) > 0);
  if (units.length) return units;
  if (Number(available.salesQty || 0) > 0) return [["salesQty", line.required?.unit || "Qty", available.salesQty]];
  return [];
}

function availableQtyTextForLine(line = {}) {
  return itemQtyText({ ...(line.available || {}), unit: line.required?.unit || "Qty" });
}

function movementText(order) {
  if (order.type === "PO") return `${order.sourceYard || "Vendor yard"} to ${order.destinationYard || order.pickupLocations?.[0] || "our yard"}`;
  if (order.type === "TO") return `${order.sourceYard || order.pickupLocations?.[0] || "source yard"} to ${order.destinationYard || "destination yard"}`;
  if (order.type === "CO") return `${order.sourceYard || order.pickupLocations?.[0] || "source yard"} to ${order.destinationYard || "transit depot"}`;
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
  return ({ SO: "Sales Order", PO: "Purchase Order", TO: "Transfer Order", CO: "Transit Depot Order" })[type] || "Order";
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

function ownYardForLocation(location = "") {
  const key = normalizedPlaceKey(location);
  if (!key) return null;
  if (HUBS[String(location)] && String(location) !== "Vendor") {
    const hub = HUBS[String(location)];
    return { code: String(location), name: hub.name || String(location), address: hub.address || String(location), lat: hub.lat, lng: hub.lng };
  }
  return ownYards.find((yard) => {
    const code = normalizedPlaceKey(yard.code);
    const name = normalizedPlaceKey(yard.name);
    const address = normalizedPlaceKey(yard.address);
    return key === code || key === name || key === address;
  }) || null;
}

function vendorYardForLocation(location = "", order = null) {
  return vendorYardsForLocation(location, order)[0] || null;
}

function vendorYardsForLocation(location = "", order = null) {
  const key = normalizedPlaceKey(location);
  if (!key) return [];
  const rows = dispatchVendorYards.filter((row) => String(row.address || "").trim());
  const exact = rows.filter((row) => normalizedPlaceKey(row.yard) === key);
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
  return orders.find((order) => order.id === id);
}

function canonicalDispatchOrderType(value, id = "") {
  const text = String(value || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (["SO", "SALES_ORDER", "SALESORDER", "SALES_ORD"].includes(text)) return "SO";
  if (["PO", "PURCHASE_ORDER", "PURCHASEORDER", "PURCH_ORD"].includes(text)) return "PO";
  if (["TO", "TRANSFER_ORDER", "TRANSFERORDER", "TRNFR_ORD"].includes(text)) return "TO";
  if (["CO", "CO_ORDER", "LOCAL_CO", "LOCAL_CO_ORDER"].includes(text)) return "CO";
  const orderId = String(id || "").toUpperCase();
  if (orderId.startsWith("PO")) return "PO";
  if (orderId.startsWith("TO")) return "TO";
  if (orderId.startsWith("CO-")) return "CO";
  return "SO";
}

function normalizeOrder(order) {
  const id = String(order.id || "");
  const type = canonicalDispatchOrderType(order.type, id);
  const items = Array.isArray(order.items) ? order.items : [];
  const basePickupLocations = Array.isArray(order.pickupLocations) && order.pickupLocations.length
    ? order.pickupLocations
    : order.sourceYard
      ? [order.sourceYard]
      : type === "SO"
        ? ["3445"]
        : [];
  const pickupLocations = order.transitCo?.toYard ? [order.transitCo.toYard] : basePickupLocations;
  return {
    ...order,
    type,
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
    if (Array.isArray(setup.drivers)) drivers = setup.drivers;
    if (Array.isArray(setup.ownYards)) applyOwnYards(setup.ownYards);
    if (Array.isArray(setup.trucks) && setup.trucks.length) {
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

function applyPlannedAssignments(assignments = []) {
  plannedAssignmentRefs = new Set((assignments || []).map((assignment) => String(assignment.orderRef || "")).filter(Boolean));
  const byOrderRef = new Map((assignments || []).map((assignment) => [String(assignment.orderRef || ""), assignment]));
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
      childOrderDetails: (order.childOrderDetails || []).map(applyToOrder)
    });
  };
  orders = orders.map(applyToOrder);
  orderCatalog = orderCatalog.map(applyToOrder);
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

async function loadPoAllocationOptions(orderId) {
  poAllocationLoading = true;
  poAllocationOptions = null;
  render({ save: false });
  try {
    const response = await fetch(`/api/dispatch/orders/${encodeURIComponent(orderId)}/po-allocations`);
    if (!response.ok) throw new Error(await response.text());
    poAllocationOptions = await response.json();
  } finally {
    poAllocationLoading = false;
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
  } catch {
    driverJobStatuses = [];
  }
}

function driverStatusByJobId() {
  return new Map((driverJobStatuses || []).map((record) => [record.job_id || record.jobId, record]));
}

function executionStatusFromRecord(record) {
  if (record?.status === "complete") return "complete";
  if (record?.status === "in_progress") return "in_progress";
  return "pending";
}

function stopExecutionStatus(truck, load, stop) {
  const record = driverStatusByJobId().get(driverJobIdForStop(truck, load, stop));
  return executionStatusFromRecord(record);
}

function travelExecutionStatus(truck, load, startTravel) {
  const record = driverStatusByJobId().get(driverTravelJobIdForLoad(truck, load, startTravel));
  return executionStatusFromRecord(record);
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
  return `${load?.name || "This load"} already has driver activity. Delete Load and Clear Load are locked, but stops/orders can still be edited.`;
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
  const assignedIds = assignedOrderIdsForTrucks(trucks);
  const hiddenOrderIds = new Set([
    ...groupedChildOrderIds(),
    ...splitParentOrderIds()
  ]);
  return {
    planId: currentPlan?.id || null,
    planDate: currentPlanDate,
    baseRevision: nextPlanSaveMode === "truck_sequence" ? null : (currentPlan?.revision ?? 0),
    saveMode: nextPlanSaveMode || "",
    savedAt: savedAt.toISOString(),
    refreshOrderPool: Boolean(nextSaveNeedsOrderPoolRefresh),
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
  return trucks.map((truck) => ({
    ...truck,
    loads: (truck.loads || []).map((load) => {
      const stats = loadStats(truck, load);
      const rowsByStopId = new Map((stats.rows || []).map((row) => [String(row.stop?.id || ""), row]));
      return {
        ...load,
        timing: {
          start: stats.start,
          finish: stats.finish,
          scheduledStart: stats.scheduledStart,
          previousFinish: stats.previousFinish,
          restBefore: stats.restBefore,
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

function requestOrderPoolRefreshOnNextSave() {
  nextSaveNeedsOrderPoolRefresh = true;
}

function requestTruckSequenceSaveOnNextSave() {
  nextPlanSaveMode = "truck_sequence";
}

function planSummary() {
  const stats = boardStats();
  return {
    ...stats,
    planDate: currentPlanDate,
    status: currentPlan?.status || "draft"
  };
}

function summarizeOrder(order) {
  if (!order) return null;
  return {
    id: order.id,
    type: order.type,
    customer: order.customer,
    address: order.address,
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
    || id.startsWith("CO-")
    || id.startsWith("GRP-")
    || /^G[A-Z]+-/i.test(id)
    || id.startsWith("TO-DRAFT-")
    || Boolean(order?.originalOrderId);
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
    for (const childId of order.childOrders || []) {
      if (childId) ids.add(childId);
    }
  }
  return ids;
}

function splitParentOrderIds(orderList = orders) {
  return new Set((orderList || [])
    .map((order) => String(order?.originalOrderId || "").trim())
    .filter(Boolean));
}

function splitSiblingsForOrder(order = {}) {
  const originalOrderId = String(order?.originalOrderId || "").trim();
  if (!originalOrderId) return [];
  return orders.filter((item) => String(item?.originalOrderId || "").trim() === originalOrderId);
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
  if (!saved?.orders?.length || !saved?.trucks?.length) return false;
  const defaultById = new Map(orderCatalog.map((order) => [order.id, normalizeOrder(order)]));
  const savedAssignedIds = assignedOrderIdsForTrucks(saved.trucks);
  const allowSavedOnlyOrder = (order) => {
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
      originalOrderId: order.originalOrderId,
      originalPallets: order.originalPallets,
      transitCo: order.transitCo,
      transitOriginalPickupLocations: order.transitOriginalPickupLocations
    };
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
  reconcileTransitCoSourceOrders();
  syncPickupStops();
  cleanupOrphanPickupStops();
  selectedOrderId = orders.find((order) => order.id === selectedOrderId)?.id || orders[0]?.id || "";
  selectedLoadId = trucks.flatMap((truck) => truck.loads).find((load) => load.id === selectedLoadId)?.id || trucks[0]?.loads[0]?.id || "";
  selectedOrderIds = new Set(selectedOrderId ? [selectedOrderId] : []);
  lastSavedAt = saved.savedAt ? new Date(saved.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  lastServerSavedAt = saved.savedAt || lastServerSavedAt;
  localStorage.setItem(DISPATCH_PLAN_KEY, JSON.stringify(saved));
  return true;
}

async function savePlanToServer(payload) {
  try {
    if (!currentPlan?.id) {
      currentPlan = await createPlanForDate(currentPlanDate);
    }
    const operatorAlertRefs = [...pendingOperatorAlertRefs];
    const refreshOrderPool = Boolean(payload.refreshOrderPool);
    const saveMode = payload.saveMode || "";
    const response = await fetch(`/api/dispatch/plans/${encodeURIComponent(currentPlan.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        summary: planSummary(),
        audit: {
          sessionId: dispatchSessionId,
          action: saveMode === "truck_sequence" ? "dispatch_plan_truck_sequence_saved" : "dispatch_plan_autosaved",
          details: { planDate: currentPlanDate, status: currentPlan?.status, operatorAlertRefs, refreshOrderPool, saveMode }
        }
      })
    });
    if (response.status === 409) {
      const conflict = await response.json().catch(() => ({}));
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
        return;
      }
      if (conflict.code === "DISPATCH_CO_SEQUENCE_INVALID") {
        localPlanDirty = true;
        routeNotice = conflict.error || "CO must be planned before the original order pickup.";
        render({ save: false });
        return;
      }
      if (conflict.currentRevision !== undefined && currentPlan) {
        currentPlan = {
          ...currentPlan,
          revision: Number(conflict.currentRevision || 0)
        };
      }
      localPlanDirty = true;
      blockedRemotePlanUpdate = true;
      routeNotice = "Plan changed on another screen. Your current changes are still visible but were not saved. Review before continuing.";
      render({ save: false });
      return;
    }
    if (!response.ok) return;
    const result = await response.json();
    currentPlan = result;
    lastServerSavedAt = result.savedAt || payload.savedAt;
    if (result.noChange) {
      if (refreshOrderPool) nextSaveNeedsOrderPoolRefresh = false;
      if (saveMode === "truck_sequence") nextPlanSaveMode = "";
      clearLocalPlanDirty(payload.savedAt);
      return;
    }
    const refreshAfterSave = saveMode === "truck_sequence"
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
    clearLocalPlanDirty(payload.savedAt);
    operatorAlertRefs.forEach((ref) => pendingOperatorAlertRefs.delete(ref));
  } catch {
    // Local storage keeps the latest draft if the server is temporarily unavailable.
  }
}

function queueServerSave(payload) {
  if (isApplyingRemotePlan) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => savePlanToServer(payload), 250);
}

function cloneHistoryValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function historySnapshot() {
  return {
    orders: cloneHistoryValue(orders),
    trucks: cloneHistoryValue(trucks),
    selectedOrderId,
    selectedOrderIds: [...selectedOrderIds],
    selectedLoadId,
    loadPreviewOpen,
    activeOrderType
  };
}

function serializeHistorySnapshot(snapshot = historySnapshot()) {
  return JSON.stringify({
    orders: snapshot.orders,
    trucks: snapshot.trucks
  });
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
  trucks = cloneHistoryValue(snapshot.trucks || []);
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
  routeCache = {};
  routeEstimates = {};
}

function captureUndoPointIfNeeded(save) {
  const snapshot = historySnapshot();
  const serialized = serializeHistorySnapshot(snapshot);
  if (!historyReady) {
    historyCurrentState = serialized;
    historyCurrentSnapshot = cloneHistoryValue(snapshot);
    historyReady = true;
    return false;
  }
  if (serialized === historyCurrentState) return false;
  if (save && !isApplyingHistory && !isApplyingRemotePlan) {
    undoStack.push(cloneHistoryValue(historyCurrentSnapshot || snapshot));
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
  }
  historyCurrentState = serialized;
  historyCurrentSnapshot = cloneHistoryValue(snapshot);
  return true;
}

function markLocalPlanDirty() {
  if (isApplyingHistory || isApplyingRemotePlan) return;
  localPlanDirty = true;
  lastLocalPlanEditAt = new Date().toISOString();
}

function clearLocalPlanDirty(savedAt = "") {
  if (savedAt && lastLocalPlanEditAt && new Date(savedAt) < new Date(lastLocalPlanEditAt)) return;
  localPlanDirty = false;
  lastLocalPlanEditAt = "";
  if (blockedRemotePlanUpdate) {
    routeNotice = "Your changes were saved. A remote plan update was held back while you were editing.";
    blockedRemotePlanUpdate = false;
  }
}

function resetLocalPlanDirty() {
  localPlanDirty = false;
  lastLocalPlanEditAt = "";
  blockedRemotePlanUpdate = false;
}

function undoDispatchChange() {
  if (!undoStack.length) return false;
  const current = historySnapshot();
  const previousState = undoStack.pop();
  redoStack.push(current);
  if (redoStack.length > HISTORY_LIMIT) redoStack.shift();
  isApplyingHistory = true;
  applyHistorySnapshot(previousState);
  routeNotice = "Undo applied.";
  historyCurrentState = serializeHistorySnapshot(previousState);
  historyCurrentSnapshot = cloneHistoryValue(previousState);
  logDispatchAudit({
    action: "dispatch_plan_undo",
    entityType: "plan",
    entityId: currentPlan?.id || currentPlanDate,
    before: { orders: current.orders.length, trucks: current.trucks.length },
    after: { orders: previousState.orders?.length || 0, trucks: previousState.trucks?.length || 0 },
    details: { planDate: currentPlanDate }
  });
  render();
  isApplyingHistory = false;
  return true;
}

function redoDispatchChange() {
  if (!redoStack.length) return false;
  const current = historySnapshot();
  const nextState = redoStack.pop();
  undoStack.push(current);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  isApplyingHistory = true;
  applyHistorySnapshot(nextState);
  routeNotice = "Redo applied.";
  historyCurrentState = serializeHistorySnapshot(nextState);
  historyCurrentSnapshot = cloneHistoryValue(nextState);
  logDispatchAudit({
    action: "dispatch_plan_redo",
    entityType: "plan",
    entityId: currentPlan?.id || currentPlanDate,
    before: { orders: current.orders.length, trucks: current.trucks.length },
    after: { orders: nextState.orders?.length || 0, trucks: nextState.trucks?.length || 0 },
    details: { planDate: currentPlanDate }
  });
  render();
  isApplyingHistory = false;
  return true;
}

function autoSavePlan() {
  const savedAt = new Date();
  lastSavedAt = savedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const payload = planPayload(savedAt);
  localStorage.setItem(DISPATCH_PLAN_KEY, JSON.stringify(payload));
  queueServerSave(payload);
}

async function saveCurrentPlanNow() {
  clearTimeout(saveTimer);
  const savedAt = new Date();
  const payload = planPayload(savedAt);
  localStorage.setItem(DISPATCH_PLAN_KEY, JSON.stringify(payload));
  await savePlanToServer(payload);
  lastSavedAt = savedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function restoreSavedPlan() {
  try {
    const saved = JSON.parse(localStorage.getItem(DISPATCH_PLAN_KEY) || "null");
    applySavedPlan(saved);
  } catch {
    localStorage.removeItem(DISPATCH_PLAN_KEY);
  }
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
  const response = await fetch("/api/dispatch/plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      planDate,
      audit: { sessionId: dispatchSessionId }
    })
  });
  if (!response.ok) throw new Error(await response.text());
  const plan = await response.json();
  currentPlan = plan;
  currentPlanDate = plan.planDate || planDate;
  localStorage.setItem(DISPATCH_PLAN_DATE_KEY, currentPlanDate);
  await loadPlanHistory();
  return plan;
}

function resetPlanningBoard() {
  orders = orderCatalog.map((order) => normalizeOrder(order));
  trucks = fleet.map((vehicle, index) => makeTruckFromFleet(vehicle, index));
  selectedOrderId = orders[0]?.id || "";
  selectedOrderIds = new Set(selectedOrderId ? [selectedOrderId] : []);
  selectedLoadId = trucks[0]?.loads[0]?.id || "";
  routeCache = {};
  routeEstimates = {};
}

async function resetDispatchAfterOrderDataClear() {
  clearTimeout(saveTimer);
  clearTimeout(remoteRefreshTimer);
  localStorage.removeItem(DISPATCH_PLAN_KEY);
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
  const response = await fetch(`/api/dispatch/plans/current?date=${encodeURIComponent(planDate)}`);
  if (!response.ok) throw new Error(await response.text());
  let plan = await response.json();
  let created = false;
  if (!plan?.id && createIfMissing) {
    plan = await createPlanForDate(planDate);
    created = true;
  }
  currentPlan = plan?.id ? plan : null;
  currentPlanDate = plan?.planDate || planDate;
  localStorage.setItem(DISPATCH_PLAN_DATE_KEY, currentPlanDate);
  if (currentPlan?.orders?.length && currentPlan?.trucks?.length) {
    applySavedPlan(currentPlan);
    lastServerSavedAt = currentPlan.savedAt || currentPlan.updatedAt || lastServerSavedAt;
    await loadDriverJobStatuses();
    resetUndoHistory();
    resetLocalPlanDirty();
    return { loaded: true, created, hasSnapshot: true };
  }
  if (currentPlan?.id) {
    resetPlanningBoard();
    lastServerSavedAt = currentPlan.savedAt || currentPlan.updatedAt || lastServerSavedAt;
    await loadDriverJobStatuses();
    resetUndoHistory();
    resetLocalPlanDirty();
    return { loaded: true, created, hasSnapshot: false };
  }
  return { loaded: false, created, hasSnapshot: false };
}

async function loadPlanById(planId) {
  const response = await fetch(`/api/dispatch/plans/${encodeURIComponent(planId)}`);
  if (!response.ok) throw new Error(await response.text());
  const plan = await response.json();
  currentPlan = plan;
  currentPlanDate = plan.planDate || currentPlanDate;
  localStorage.setItem(DISPATCH_PLAN_DATE_KEY, currentPlanDate);
  if (plan.orders?.length && plan.trucks?.length) applySavedPlan(plan);
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
    if (localPlanDirty) {
      blockedRemotePlanUpdate = true;
      routeNotice = "Plan updated on another screen. Your unsaved changes were kept.";
      return false;
    }
    const response = await fetch(`/api/dispatch/plans/${encodeURIComponent(currentPlan?.id || "")}`);
    if (!response.ok) return false;
    const saved = await response.json();
    if (!saved?.savedAt || !saved.orders?.length || !saved.trucks?.length) return false;
    if (lastServerSavedAt && new Date(saved.savedAt) <= new Date(lastServerSavedAt)) return false;
    isApplyingRemotePlan = true;
    currentPlan = saved;
    currentPlanDate = saved.planDate || currentPlanDate;
    const applied = applySavedPlan(saved);
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
  const applied = await restoreServerPlan();
  if (applied) render({ save: false });
}

function queueRemoteRefresh(reason = "Plan updated from another screen.", { reloadOrders = true } = {}) {
  window.clearTimeout(remoteRefreshTimer);
  remoteRefreshTimer = window.setTimeout(async () => {
    try {
      if (reloadOrders) await loadDispatchOrders();
      const applied = await restoreServerPlan();
      if (!reloadOrders) await refreshPlannedAssignments();
      if (reason) routeNotice = reason;
      render({ save: false });
      if (applied && reason) routeNotice = reason;
    } catch (error) {
      routeNotice = `Auto refresh failed: ${error.message}`;
      render({ save: false });
    }
  }, 350);
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

    if ((event.type === "dispatch.orders.updated" && payload.change === "order_data_clear") || event.type === "dispatch.plan.cleared") {
      resetDispatchAfterOrderDataClear().catch((error) => {
        routeNotice = `Dispatch reset failed: ${error.message}`;
        render({ save: false });
      });
      return;
    }

    if (["dispatch.plan.saved", "dispatch.plan.confirmed", "dispatch.plan.reopened"].includes(event.type)) {
      if (payload.planDate && payload.planDate !== currentPlanDate) return;
      if (localPlanDirty) {
        blockedRemotePlanUpdate = true;
        routeNotice = "Plan updated on another screen. Your unsaved changes were kept.";
        render({ save: false });
        return;
      }
      queueRemoteRefresh("Dispatch plan updated.", { reloadOrders: payload.refreshOrderPool === true });
      return;
    }

    if (event.type === "dispatch.setup.updated") {
      window.clearTimeout(remoteRefreshTimer);
      remoteRefreshTimer = window.setTimeout(async () => {
        try {
          await loadDispatchSetup();
          if (currentPlan?.orders?.length && currentPlan?.trucks?.length) applySavedPlan(currentPlan);
          routeCache = {};
          routeEstimates = {};
          routeNotice = "Dispatch setup updated.";
          render({ save: false });
        } catch (error) {
          routeNotice = `Setup refresh failed: ${error.message}`;
          render({ save: false });
        }
      }, 350);
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
  return assignedOrderIdsForTrucks(trucks);
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
  const hiddenOrderIds = new Set([
    ...groupedChildOrderIds(),
    ...splitParentOrderIds()
  ]);
  const term = searchText.trim();
  return orders.filter((order) => {
    if (hiddenOrderIds.has(order.id)) return false;
    if (!term && assigned.has(order.id)) return false;
    if (!term && isOrderPlannedOutsideCurrentPlan(order)) return false;
    if (!matchesSearch(order)) return false;
    if (dispatchDateFilter && order.type === "SO" && order.expectedDeliveryDate !== dispatchDateFilter) return false;
    return term ? true : order.type === activeOrderType;
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
    ...(order.items || []).map((item) => item.sku)
  ].join(" ").toLowerCase().includes(term);
}

function groupCandidates(order) {
  return orders.filter((item) => item.childOrders?.includes(order.id) || (order.childOrders || []).includes(item.id));
}

function stopOrder(stop) {
  return orderById(stop.orderId);
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
  return order?.pickupLocations?.length ? order.pickupLocations : ["3445"];
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
    total += orderFootprintPallets(order);
  }
  return total;
}

function routeLegMinutesForLoad(load) {
  const estimate = routeEstimates[load?.id];
  return Array.isArray(estimate?.legMinutes) ? estimate.legMinutes : [];
}

function fallbackTravelMinutesBetweenStops(truck, previousStop, currentStop, previousOrder, currentOrder) {
  if (!previousStop) return 0;
  const previousLocation = previousStop.type === "pick"
    ? previousStop.location
    : previousOrder?.destinationYard || previousOrder?.address || "";
  const currentLocation = currentStop.type === "pick"
    ? currentStop.location
    : currentOrder?.destinationYard || currentOrder?.address || "";
  let value = 30;
  if (HUBS[previousLocation] && HUBS[currentLocation]) value = yardTravelMinutes(previousLocation, currentLocation);
  else if (currentStop.type === "drop") value = Number(currentOrder?.travelMinutes || 30);
  else value = Number(previousOrder?.travelMinutes || currentOrder?.travelMinutes || 30);
  return adjustedTravelMinutesForTruck(truck, value);
}

function loadStats(truck, load) {
  const startInfo = loadStartInfo(truck, load);
  const start = startInfo.start;
  const startWarnings = [];
  if (startInfo.startClamped) {
    startWarnings.push(`Load start ${timeText(startInfo.scheduledStart)} is before previous load finishes ${timeText(startInfo.previousFinish)}. Start was moved to ${timeText(start)}.`);
  }
  if (load.returnOnly) {
    const estimate = routeEstimates[load.id];
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
      previousFinish: startInfo.previousFinish,
      scheduledStart: startInfo.scheduledStart,
      startClamped: startInfo.startClamped
    };
  }
  let current = start;
  const startTravel = startTravelForLoad(truck, load);
  let resolvedStartTravel = startTravel;
  const routeLegMinutes = routeLegMinutesForLoad(load);
  let routeLegIndex = 0;
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
      for (const dropStop of load.stops) {
        if (dropStop.type !== "drop" || droppedOrderIds.has(dropStop.orderId) || onboardOrderIds.has(dropStop.orderId)) continue;
        const dropOrder = stopOrder(dropStop);
        if (!dropOrder) continue;
        if (!requiredPickupLocations(dropOrder).map(String).includes(String(stop.location))) continue;
        currentWeightLbs += orderWeightLbs(dropOrder);
        pickedFootprint += orderFootprintPallets(dropOrder);
        onboardOrderIds.add(dropStop.orderId);
        peakWeightLbs = Math.max(peakWeightLbs, currentWeightLbs);
      }
      const arrival = current;
      current += truckStopMinutes(truck, stopServiceType(stop, order), pickedFootprint);
      let warningReason = "";
      const window = stopTimeWindow(stop, order);
      const hasTimeWindow = Boolean(window.start && window.end);
      if (window.closed) warningReason = `${stop.location} closed on ${window.label || planWeekdayName()}.`;
      else if (hasTimeWindow && arrival > minutes(window.end)) warningReason = `Pickup ${stop.location} late: arrives ${timeText(arrival)}, window ends ${window.end}`;
      else if (hasTimeWindow && arrival < minutes(window.start)) warningReason = `Pickup ${stop.location} early: arrives ${timeText(arrival)}, window starts ${window.start}`;
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
    current += truckStopMinutes(truck, stopServiceType(stop, order), orderFootprintPallets(order));
    palletTotal += Number(order.pallets || 0);
    footprintTotal += orderFootprintPallets(order);
    processedWeightLbs += orderWeightLbs(order);
    if (onboardOrderIds.has(order.id)) {
      currentWeightLbs = Math.max(0, currentWeightLbs - orderWeightLbs(order));
      onboardOrderIds.delete(order.id);
      droppedOrderIds.add(order.id);
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
    previousFinish: startInfo.previousFinish,
    scheduledStart: startInfo.scheduledStart,
    startClamped: startInfo.startClamped
  };
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

function makePickupStop(load, order, location) {
  return {
    id: `${load.id}-${order.id}-PICK-${location}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    loadId: load.id,
    orderId: order.id,
    type: "pick",
    location
  };
}

function ensurePickupStops(load, order, insertIndex = null) {
  let added = 0;
  for (const location of order.pickupLocations || []) {
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

function cleanupOrphanPickupStops() {
  for (const truck of trucks) {
    for (const load of truck.loads) {
      if (load.returnOnly) continue;
      const needed = new Set();
      for (const stop of load.stops) {
        if (stop.type !== "drop") continue;
        const order = stopOrder(stop);
        for (const location of requiredPickupLocations(order)) needed.add(String(location));
      }
      load.stops = load.stops.filter((stop) => stop.type !== "pick" || needed.has(String(stop.location)));
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

function addLoadToTruck(truck, insertIndex = truck?.loads?.length || 0) {
  const load = { id: `${truck.id}-L${Date.now()}-${Math.random().toString(16).slice(2)}`, name: "Load", stops: [] };
  truck.loads.splice(Math.max(0, Math.min(insertIndex, truck.loads.length)), 0, load);
  renumberTruckLoads(truck);
  return load;
}

function addReturnLoadToTruck(truck, insertIndex = truck?.loads?.length || 0) {
  const load = { id: `${truck.id}-MR${Date.now()}-${Math.random().toString(16).slice(2)}`, name: "Return Load", returnOnly: true, manual: true, returnYard: "12441", stops: [] };
  truck.loads.splice(Math.max(0, Math.min(insertIndex, truck.loads.length)), 0, load);
  renumberTruckLoads(truck);
  return load;
}

function loadStartMinutes(truck, load) {
  return loadStartInfo(truck, load).start;
}

function loadStartInfo(truck, load) {
  const index = loadIndexInTruck(truck, load);
  if (index <= 0) {
    const start = minutes(load?.start || truck?.start || "08:00");
    return { start, scheduledStart: start, previousFinish: null, restBefore: 0, startClamped: false };
  }
  const previous = truck.loads[index - 1];
  const previousFinish = loadStats(truck, previous).finish;
  const hasManualStart = Boolean(String(load?.start || "").trim());
  const scheduledStart = hasManualStart ? minutes(load.start) : previousFinish;
  const start = Math.max(previousFinish, scheduledStart);
  return {
    start,
    scheduledStart,
    previousFinish,
    restBefore: Math.max(0, scheduledStart - previousFinish),
    startClamped: hasManualStart && scheduledStart < previousFinish
  };
}

function startPointAfterLoad(truck, load) {
  if (!load) return null;
  if (load.returnOnly) {
    const yard = load.returnYard || "12441";
    const place = placeForLocation(yard);
    return {
      label: yard,
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
    label: stop.type === "pick" ? String(stop.location || "") : (order?.id || "Previous stop"),
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
  const index = loadIndexInTruck(truck, load);
  if (index <= 0) {
    if (!truck?.base || String(truck.base) === String(firstPickup.location)) return null;
    const basePlace = placeForLocation(truck.base);
    return {
      from: truck.base,
      to: firstPickup.location,
      address: basePlace?.address || hubAddress(truck.base),
      position: placePosition(basePlace) || hubPosition(truck.base),
      routeLocation: basePlace?.address || hubAddress(truck.base),
      minutes: yardTravelMinutes(truck.base, firstPickup.location)
    };
  }
  const previous = truck.loads[index - 1];
  const from = startPointAfterLoad(truck, previous);
  if (!from || String(from.label) === String(firstPickup.location)) return null;
  return {
    from: from.label || from.address || "Previous stop",
    to: firstPickup.location,
    address: from.address,
    position: from.position,
    routeLocation: from.routeLocation,
    minutes: travelMinutesBetweenPoints(from, firstPickup.location)
  };
}

function yardOptions(selected = "12441") {
  const selectedValue = String(selected || "12441");
  const yards = ownYards.length ? ownYards : [{ code: "12441" }, { code: "3445" }, { code: "2967" }];
  return yards
    .map((yard) => {
      const code = String(yard.code || yard.name || "").trim();
      if (!code) return "";
      const label = yard.name && yard.name !== code ? `${code} - ${yard.name}` : code;
      return `<option value="${escapeHtml(code)}" ${selectedValue === code ? "selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");
}

function previousLoadFor(loadId) {
  for (const truck of trucks) {
    const index = truck.loads.findIndex((load) => load.id === loadId);
    if (index > 0) return { truck, load: truck.loads[index - 1] };
  }
  return {};
}

function lastRoutedStop(load) {
  return [...(load?.stops || [])].reverse().find((stop) => stop.type === "drop" || stop.type === "pick");
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
      const place = placeForLocation(stop.location, order);
      const hub = HUBS[place?.key] || HUBS[truck?.base] || { x: 50, y: 50 };
      pins.push({ label: String(index + 1), className: "pick", x: hub.x, y: hub.y });
    } else {
      pins.push({ label: `${index + 1}`, className: "", x: order.x, y: order.y });
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
    const place = placeForLocation(stop.location, order);
    const address = place?.address
      || order?.sourceAddress
      || (order?.type === "PO" ? order?.address : "")
      || String(stop.location || "");
    const position = placePosition(place) || fallbackPositionForAddress(address, order);
    return {
      kind: place?.kind || "pickup",
      key: place?.key || String(stop.location || address || ""),
      label: place?.label || String(stop.location || "Pickup"),
      address,
      routeLocation: address || position,
      lat: position.lat,
      lng: position.lng
    };
  }
  const destinationPlace = order?.destinationYard ? placeForLocation(order.destinationYard, order) : null;
  const address = destinationPlace?.address || order?.address || hubAddress("3445");
  const position = placePosition(destinationPlace) || fallbackPositionForAddress(address, order);
  return {
    kind: destinationPlace?.kind || "delivery",
    key: destinationPlace?.key || order?.id || address,
    label: destinationPlace?.label || order?.id || "Drop off",
    address,
    routeLocation: address || position,
    lat: position.lat,
    lng: position.lng
  };
}

function stopIsOwnYard(stop, order) {
  if (stop.type === "pick") return placeForLocation(stop.location, order)?.kind === "own";
  return Boolean(order?.destinationYard && placeForLocation(order.destinationYard, order)?.kind === "own");
}

function stopServiceType(stop, order) {
  if (stopIsOwnYard(stop, order)) return "own";
  if (stop.type === "pick") return "vendor";
  return "delivery";
}

function stopTimeWindow(stop, order) {
  if (!stop || !order || stopIsOwnYard(stop, order)) return { start: "", end: "" };
  if (stop.type === "pick") return vendorWindowForLocation(stop.location, order);
  if (stop.type === "drop") return { start: order.windowStart || "", end: order.windowEnd || "" };
  return { start: "", end: "" };
}

function stopStayMinutes(stop, order, truck) {
  return truckStopMinutes(truck, stopServiceType(stop, order), orderFootprintPallets(order));
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

function routeLocationForStop(stop, order, position, address) {
  const place = resolveStopPlace(stop, order);
  return place.routeLocation || address || position;
}

function mapStopsForLoad(load, truck) {
  if (load?.returnOnly) {
    const { load: previousLoad } = previousLoadFor(load.id);
    const previousStop = lastRoutedStop(previousLoad);
    const previousOrder = previousStop ? stopOrder(previousStop) : null;
    const startPosition = previousStop ? stopPosition(previousStop, previousOrder) : hubPosition(truck?.base || "12441");
    const startAddress = previousStop ? stopAddress(previousStop, previousOrder) : hubAddress(truck?.base || "12441");
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
        stayMinutes: truckStopMinutes(truck, "own", 0),
        orderId: ""
      }
    ];
  }
  const startTravel = startTravelForLoad(truck, load);
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
    const position = stopPosition(stop, order);
    const address = stopAddress(stop, order);
    const sequence = index + 1 + startStops.length;
    return {
      ...position,
      address,
      routeLocation: routeLocationForStop(stop, order, position, address),
      label: String(sequence),
      title: stop.type === "pick" ? `${sequence}. Pickup ${stop.location}` : `${sequence}. Drop ${order.id}`,
      type: stop.type,
      stayMinutes: stop.type === "pick"
        ? truckStopMinutes(truck, stopServiceType(stop, order), pickupFootprintForLocation(load, stop.location))
        : stopStayMinutes(stop, order, truck),
      orderId: order.id
    };
  }).filter(Boolean);
  return [...startStops, ...routedStops];
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
  const rawLegMinutes = legs.map((leg) => Math.max(1, Math.round(Number((leg.duration_in_traffic || leg.duration)?.value || 0) / 60)));
  const legMinutes = rawLegMinutes.map((value) => adjustedTravelMinutesForTruck(truck, value));
  const rawDriveMinutes = rawLegMinutes.reduce((sum, value) => sum + value, 0);
  const driveMinutes = legMinutes.reduce((sum, value) => sum + value, 0);
  const stayMinutes = stops.reduce((sum, stop) => sum + Number(stop.stayMinutes || 0), 0);
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
  return estimate;
}

function routeEstimateSummaryHtml(estimate, truck, suffix = "") {
  const adjustment = truckTravelTimePercent(truck) > 0
    ? ` | Google ${durationText(estimate.rawDriveMinutes)} +${truckTravelTimePercent(truck)}%`
    : "";
  const tollText = estimate.allowTolls ? " | tolls allowed" : " | avoiding tolls";
  return `<strong>${durationText(estimate.totalMinutes)} total</strong><span>${durationText(estimate.driveMinutes)} drive + ${durationText(estimate.stayMinutes)} stop time${adjustment}${tollText}${suffix}</span>`;
}

async function renderGoogleMapPreview() {
  const canvas = document.getElementById("googleMapPreview");
  if (!canvas) return;
  const available = await loadGoogleMaps();
  if (!available || !window.google?.maps) {
    canvas.innerHTML = dispatchConfig.googleMapsApiKey ? "Google Maps could not load." : "Add GOOGLE_MAPS_API_KEY to enable Google Maps.";
    return;
  }
  const { truck, load } = selectedLoad();
  const stops = mapStopsForLoad(load, truck);
  const loadStart = loadStats(truck, load).start;
  const allowTolls = Boolean(load?.allowTolls);
  const signature = `${routeSignature(stops)}@${loadStart}@tolls:${allowTolls ? "allow" : "avoid"}`;
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
        content: `<strong>${stop.title}</strong><br>${stop.type === "pick" ? "Pickup" : "Drop off"}<br>Stay ${stop.stayMinutes} min`
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
    if (cached?.signature === signature && cached.result) {
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
        && (!previousEstimate
          || previousEstimate.totalMinutes !== estimate.totalMinutes
          || previousEstimate.travelTimePercent !== estimate.travelTimePercent)
      ) {
        setTimeout(() => render({ save: false }), 0);
      }
      return;
    }
    const directionsService = new google.maps.DirectionsService();
    directionsService.route({
      origin: stopRouteLocation(stops[0]),
      destination: stopRouteLocation(stops[stops.length - 1]),
      waypoints: stops.slice(1, -1).map((stop) => ({ location: stopRouteLocation(stop), stopover: true })),
      travelMode: google.maps.TravelMode.DRIVING,
      avoidTolls: !allowTolls,
      optimizeWaypoints: false,
      drivingOptions: {
        departureTime: plannedDepartureDate(loadStart),
        trafficModel: google.maps.TrafficModel.BEST_GUESS
      }
    }, (result, status) => {
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
      const estimate = routeEstimateFromGoogleLegs(load, stops, legs, truck);
      routeCache[load.id] = { signature, result, markerStops: routeMarkerStops };
      if (routeSummary) {
        routeSummary.innerHTML = routeEstimateSummaryHtml(estimate, truck);
      }
      if (selectedLoadId === load.id) setTimeout(() => render({ save: false }), 0);
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
    const stayMinutes = stops.reduce((sum, stop) => sum + Number(stop.stayMinutes || 0), 0);
    if (routeSummary) routeSummary.innerHTML = `<strong>${stayMinutes} min stay</strong><span>Add more stops for Google travel estimate.</span>`;
  } else {
    drawStopMarkers(await geocodeMarkerStops(stops));
  }
}

function planBadgeText() {
  if (!currentPlan?.id) return "No plan";
  return String(currentPlan.status || "draft").toUpperCase();
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
    "data-return-yard"
  ].filter((name) => element.hasAttribute(name));
  if (attrs.length) return `${tag}${attrs.map((name) => `[${name}="${cssAttr(element.getAttribute(name))}"]`).join("")}`;
  const dataParent = element.closest("[data-action], [data-load-card], [data-stop], [data-order]");
  return dataParent && dataParent !== element ? selectorForElement(dataParent) : "";
}

function captureRenderUiState() {
  const active = document.activeElement;
  return {
    focusSelector: selectorForElement(active),
    scrolls: [...app.querySelectorAll(".order-list, .truck-board, .load-preview-body, .preview-stop-list, .stop-list")]
      .map((element) => ({
        selector: selectorForElement(element) || `.${[...element.classList].join(".")}`,
        top: element.scrollTop,
        left: element.scrollLeft
      }))
      .filter((item) => item.selector)
  };
}

function restoreRenderUiState(state = {}) {
  for (const item of state.scrolls || []) {
    const element = app.querySelector(item.selector);
    if (!element) continue;
    element.scrollTop = item.top || 0;
    element.scrollLeft = item.left || 0;
  }
  if (state.focusSelector) {
    const element = app.querySelector(state.focusSelector);
    if (element && typeof element.focus === "function") element.focus({ preventScroll: true });
  }
}

function render(options = {}) {
  const { save = true } = options;
  const uiState = captureRenderUiState();
  orderListScrollTop = app.querySelector(".order-list")?.scrollTop ?? orderListScrollTop;
  cleanupOrphanPickupStops();
  syncPickupStops();
  syncReturnLoads();
  const planChanged = captureUndoPointIfNeeded(save);
  if (save && planChanged) {
    markLocalPlanDirty();
    autoSavePlan();
  }
  const stats = boardStats();
  app.innerHTML = `
    <section class="dispatch-shell">
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
          <button onclick="location.href='/dispatch'" type="button">${t("common.menu", "Menu")}</button>
          <button data-action="undo-plan" ${undoStack.length ? "" : "disabled"} title="Undo (Ctrl+Z)" type="button">${t("dispatch.undo", "Undo")}</button>
          <button data-action="redo-plan" ${redoStack.length ? "" : "disabled"} title="Redo (Ctrl+Y)" type="button">${t("dispatch.redo", "Redo")}</button>
          <button data-action="export-shipped-csv" ${currentPlan?.id ? "" : "disabled"} type="button">${t("dispatch.exportShippedCsv", "Export Shipped CSV")}</button>
          <button class="primary" data-action="confirm-plan" ${currentPlan?.id ? "" : "disabled"} type="button">${t("dispatch.confirmPlan", "Confirm Plan")}</button>
          <button data-action="refresh-orders" type="button">${t("dispatch.refreshOrders", "Refresh Orders")}</button>
          <span class="autosave-pill">${localPlanDirty ? "Saving..." : t("dispatch.saved", "Saved")} ${lastSavedAt}</span>
        </div>
      </header>
      ${routeNotice ? `<div class="route-notice"><span>${escapeHtml(routeNotice)}</span><button data-action="close-route-notice" type="button">x</button></div>` : ""}
      <div class="dispatch-grid">
        ${renderOrderPool()}
        <section class="planner-panel">
          <div class="kpi-strip">
            <div class="kpi"><span>${t("dispatch.openOrders", "Open Orders")}</span><strong>${stats.open}</strong></div>
            <div class="kpi"><span>${t("dispatch.plannedDrops", "Planned Drops")}</span><strong>${stats.planned}</strong></div>
            <div class="kpi"><span>${t("dispatch.totalStops", "Total Stops")}</span><strong>${stats.stops}</strong></div>
            <div class="kpi"><span>${t("dispatch.warnings", "Warnings")}</span><strong>${stats.warnings}</strong></div>
            <div class="kpi"><span>${t("dispatch.trucks", "Trucks")}</span><strong>${trucks.length}</strong></div>
          </div>
          <div class="truck-board">
            ${trucks.map(renderTruck).join("")}
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
  restoreRenderUiState(uiState);
  renderGoogleMapPreview();
}

function renderOrderPool() {
  const searching = Boolean(searchText.trim());
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>${t("dispatch.orderPool", "Order Pool")}</h2>
          <p>${searching ? "Search results across SO, PO, TO, and CO." : `${orderTypeLabel(activeOrderType)} list`}</p>
        </div>
        <div class="order-tools">
          <input id="orderSearch" value="${escapeHtml(searchText)}" placeholder="Search SO, PO, TO, CO, SKU, address" />
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
  const searching = Boolean(searchText.trim());
  const pool = document.querySelector(".panel .panel-header h2")?.closest(".panel");
  const subtitle = pool?.querySelector(".panel-header p");
  const tabs = pool?.querySelectorAll(".order-type-tabs button");
  const list = pool?.querySelector(".order-list");
  if (subtitle) subtitle.textContent = searching ? "Search results across SO, PO, TO, and CO." : `${orderTypeLabel(activeOrderType)} list`;
  tabs?.forEach((button) => button.classList.toggle("active", !searching && activeOrderType === button.dataset.type));
  if (list) list.innerHTML = renderOrderList();
}

function renderSelectedOrderActions() {
  const order = selectedOrder();
  if (!order) return "";
  const selected = selectedOrders();
  const label = selected.length > 1 ? `${selected.length} selected` : order.id;
  const groupedCount = order.childOrders?.length || 0;
  const reviewOnly = selected.some((item) => isReviewOnlyOrder(item));
  const blockedUngroup = groupedCount && groupedOrderTransitCoId(order);
  return `
    <div class="selected-order-actions">
      <span>${escapeHtml(label)}</span>
      ${reviewOnly ? `<span>Loaded/shipped history</span>` : groupedCount ? `<button data-action="ungroup-order" data-order="${order.id}" ${blockedUngroup ? `disabled title="Cancel ${escapeHtml(blockedUngroup)} before ungrouping"` : ""} type="button">Ungroup</button>` : selected.length > 1 ? `<button data-action="open-group-modal" data-order="${order.id}" type="button">Group</button>` : ""}
      ${blockedUngroup ? `<span>Cancel ${escapeHtml(blockedUngroup)} before ungrouping</span>` : ""}
      ${!reviewOnly && order.type === "PO" ? `<button data-action="open-po-yard-modal" data-order="${order.id}" type="button">Set Yard</button>` : ""}
      ${!reviewOnly && order.type === "SO" ? `<button data-action="open-po-link-modal" data-order="${order.id}" type="button">Link PO</button>` : ""}
      ${!reviewOnly && order.type !== "CO" && !order.originalOrderId ? `<button data-action="open-split-modal" data-order="${order.id}" type="button">Split</button>` : ""}
      ${!reviewOnly && order.originalOrderId ? `<button data-action="unsplit-order" data-order="${order.id}" type="button">Unsplit</button>` : ""}
      ${!reviewOnly && canConsolidatePick(order) ? `<button data-action="open-consolidate-modal" data-order="${order.id}" type="button">Consolidate Pick</button>` : ""}
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
  const anyPlanned = planned || plannedElsewhere;
  const reviewOnly = isReviewOnlyOrder(order);
  const packedText = packedUnitText(order);
  const executionStatus = orderExecutionStatus(order.id);
  const plannedText = planned
    ? `${assignment.truck?.plate || ""} ${assignment.load?.name || "Planned"}`
    : orderPlannedElsewhereText(order);
  return `
    <article class="order-card status-${executionStatus} ${selectedOrderIds.has(order.id) ? "selected" : ""} ${planned ? "planned" : ""} ${plannedElsewhere ? "planned-elsewhere" : ""} ${reviewOnly ? "review-only" : ""} ${missingAddress || transitBlocked ? "warning" : ""}" draggable="${anyPlanned ? "false" : "true"}" data-order="${order.id}" data-planned="${anyPlanned ? "true" : "false"}" data-review-only="${reviewOnly ? "true" : "false"}" data-planned-elsewhere="${plannedElsewhere ? "true" : "false"}">
      <strong>${order.id} | ${escapeHtml(order.customer)}</strong>
      <span>${plannedElsewhere ? escapeHtml(orderPlannedElsewhereText(order)) : missingAddress ? "Missing delivery address" : transitBlocked ? escapeHtml(transitMessage) : escapeHtml(movementText(order))}</span>
      <span class="order-compact-line">Pickup ${escapeHtml(orderPickupText(order))} | ${dateText}${order.windowStart || "--"}-${order.windowEnd || "--"}</span>
      <span class="order-compact-line">${orderUnitText(order)} | ${orderFootprintPallets(order)} pos | ${formatLbs(orderWeightLbs(order))}${packedText ? ` | Packed ${escapeHtml(packedText)}` : ""}</span>
      ${groupedCount ? `<span>Includes ${order.childOrders.join(", ")}</span>` : ""}
      <div class="chip-row">
        <span class="chip">${order.type}</span>
        ${executionStatus === "complete" ? `<span class="chip complete-chip">Completed</span>` : executionStatus === "in_progress" ? `<span class="chip progress-chip">In progress</span>` : ""}
        ${reviewOnly ? `<span class="chip complete-chip">${escapeHtml(reviewOnlyText(order))}</span>` : ""}
        ${anyPlanned ? `<span class="chip planned-chip">${escapeHtml(plannedText)}</span>` : ""}
        ${missingAddress ? `<span class="chip warn">Update address</span>` : ""}
        ${order.netsuiteFeedMissing ? `<span class="chip warn">NetSuite status changed</span>` : ""}
        ${order.transitCo ? `<span class="chip ${transitBlocked ? "warn" : ""}">CO ${escapeHtml(order.transitCo.id)}</span>` : ""}
        ${(order.items || []).some((item) => Number(item.poAllocatedSalesQty || 0) > 0) ? `<span class="chip">PO linked</span>` : ""}
        ${order.type === "CO" ? `<span class="chip">For ${escapeHtml(order.sourceOrderId || order.relatedSoId || "SO")}</span>` : ""}
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
        <button data-action="move-truck-up" data-truck="${truck.id}" ${index <= 0 ? "disabled" : ""} title="Move truck up" type="button">▲</button>
        <button data-action="move-truck-down" data-truck="${truck.id}" ${index >= trucks.length - 1 ? "disabled" : ""} title="Move truck down" type="button">▼</button>
      </div>
      <div class="truck-label">
        <div>
          <strong>${truck.plate}</strong>
          <span>${formatLbs(truckCapacityLbs(truck))} cap. | ${escapeHtml(travelAdjustmentText(truck))}</span>
          <label class="truck-start-yard">
            <span>Driver</span>
            <select data-truck-driver="${truck.id}">${driverOptions(driverKey(selectedDriver) || truck.driverLogin || "", truck.id)}</select>
          </label>
          ${hasDriver ? "" : `<span class="truck-driver-warning">Assign driver first</span>`}
          <label class="truck-start-yard">
            <span>Start yard</span>
            <select data-truck-start="${truck.id}">${yardOptions(truck.base || "12441")}</select>
          </label>
          <label class="truck-start-yard">
            <span>Parking spot</span>
            <input data-truck-parking="${truck.id}" value="${escapeHtml(truck.parkingSpot || "")}" placeholder="A1" />
          </label>
        </div>
        <div class="truck-actions">
          <button data-action="add-load" data-truck="${truck.id}" title="${hasDriver ? insertText : "Assign driver first"}" ${hasDriver ? "" : "disabled"} type="button">+ Load</button>
          <button data-action="add-return-load" data-truck="${truck.id}" title="${hasDriver ? insertText : "Assign driver first"}" ${hasDriver ? "" : "disabled"} type="button">+ Return</button>
        </div>
      </div>
      <div class="truck-timeline">
        ${truck.loads.map((load) => renderLoad(truck, load)).join("")}
        <div class="timeline-drop-zone ${hasDriver ? "" : "locked"}" data-load-create="${truck.id}">${hasDriver ? "Drop order here<br>to create new load" : "Assign driver first"}</div>
      </div>
    </article>
  `;
}

function renderLoad(truck, load) {
  const isLocked = load.returnOnly ? false : loadHasDriverActivity(load);
  if (load.returnOnly) {
    const stats = loadStats(truck, load);
    return `
      <section class="load-block return-only">
        <div class="load-header">
          <button class="load-title return-load-title" data-action="select-load" data-load="${load.id}" type="button">
            <strong>${load.manual ? "Manual Return" : "Return Load"}</strong>
            <span>Finish ${timeText(stats.finish)}</span>
          </button>
          <div class="load-header-actions">
            <button class="load-delete" data-action="delete-load" data-load="${load.id}" title="Delete return load" type="button">x</button>
          </div>
        </div>
        <div class="return-yard-row">
          <label>
            <span>Return yard</span>
            <select data-return-yard="${load.id}">${yardOptions(load.returnYard || "12441")}</select>
          </label>
        </div>
        <div class="stop-list">
          ${renderRestStop(stats)}
          <div class="empty-drop return-helper">Return from previous load last stop</div>
        </div>
      </section>
    `;
  }
  const stats = loadStats(truck, load);
  const active = selectedLoadId === load.id;
  return `
    <section class="load-block ${stats.warningCount ? "warning" : ""} ${active ? "selected" : ""} ${isLocked ? "driver-active" : ""}" data-load-card="${load.id}">
      ${stats.warningCount ? `<span class="load-warning-badge">${stats.warningCount}</span>` : ""}
      <div class="load-header">
        <button class="load-title" data-action="select-load" data-load="${load.id}" type="button">
          <strong>${load.name}</strong>
          <span>Finish ${timeText(stats.finish)}</span>
        </button>
        <div class="load-header-actions">
          <button class="load-delete" data-action="delete-load" data-load="${load.id}" ${isLocked ? "disabled" : ""} title="${isLocked ? escapeHtml(loadActivityLockNotice(load)) : "Delete load"}" type="button">x</button>
        </div>
      </div>
      <div class="stop-list" data-load="${load.id}">
        ${renderRestStop(stats)}
        ${renderStartTravelStop(truck, load, stats.startTravel, stats.start)}
        ${load.stops.map((stop, index) => renderStop(truck, load, stop, index, stats.rows[index])).join("") || `<div class="empty-drop">Drop order here</div>`}
      </div>
    </section>
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
  return `
    <article class="stop-card compact travel-stop status-${executionStatus}">
      <div class="stop-main">
        <strong>Travel ${startTravel.from} to ${startTravel.to}</strong>
        <span>Empty truck reposition</span>
      </div>
      <div class="stop-time"><span>Leave ${timeText(start)}</span><span>Arrive ${timeText(arrival)}</span></div>
    </article>
  `;
}

function renderStop(truck, load, stop, index, row) {
  const order = stopOrder(stop);
  if (!order) return "";
  const isPick = stop.type === "pick";
  const executionStatus = stopExecutionStatus(truck, load, stop);
  const removalLocked = stopHasDriverActivity(load, stop);
  return `
    <article class="stop-card compact status-${executionStatus} ${isPick ? "pick" : ""} ${selectedOrderId === order.id ? "selected-order-stop" : ""} ${row?.warning ? "warning" : ""}" draggable="true" data-load="${stop.loadId}" data-stop="${stop.id}" data-order="${order.id}" data-index="${index}">
      <button class="stop-remove" data-action="remove-stop" data-stop="${stop.id}" ${removalLocked ? "disabled" : ""} title="${removalLocked ? escapeHtml(stopActivityLockNotice(stop)) : "Remove stop"}" type="button">x</button>
      <div class="stop-main">
        <strong>${index + 1}. ${isPick ? `Pickup ${stop.location}` : order.id}</strong>
        <span>${escapeHtml(stopAddress(stop, order))}</span>
      </div>
      <div class="stop-time"><span>Arrive ${timeText(row?.arrival || 0)}</span><span>Leave ${timeText(row?.depart || row?.arrival || 0)}</span></div>
    </article>
  `;
}

function renderLoadPreview() {
  if (!loadPreviewOpen) return "";
  const { truck, load } = selectedLoad();
  if (!truck || !load) return "";
  const stats = loadStats(truck, load);
  const isLocked = load.returnOnly ? false : loadHasDriverActivity(load);
  const firstOrder = load.stops.map(stopOrder).find(Boolean);
  const pickupLocations = load.stops.length ? uniquePickupLocations(load, truck) : [];
  const pickupPoint = pickupLocations.join(", ") || firstOrder?.pickupLocations?.[0] || truck.base;
  const restOffset = stats.restBefore ? 1 : 0;
  const travelOffset = stats.startTravel ? 1 : 0;
  const stopOffset = restOffset + travelOffset;
  const sequenceHtml = load.returnOnly
    ? renderReturnPreviewStops(load, truck, stats)
    : `${renderPreviewRestStop(stats)}${renderPreviewStartTravelStop(truck, load, stats.startTravel, stats.start, restOffset)}${load.stops.map((stop, index) => renderPreviewStop(truck, load, stop, index, stats.rows[index], index + stopOffset)).join("")}`;
  return `
    <aside class="load-preview-panel" style="width:${Math.min(Math.max(loadPreviewWidth, 390), Math.round(window.innerWidth * 0.92))}px">
      <div class="load-preview-resize" title="Drag to resize"></div>
      <div class="load-preview-header">
        <div>
          <h2>${truck.plate} | ${load.name}</h2>
          <p>${load.returnOnly ? `Return to ${load.returnYard || "12441"}` : `${formatLbs(stats.weightTotalLbs)}/${formatLbs(stats.capacityLbs)} | ${stats.footprintTotal} pallet positions | Pickup ${pickupPoint}`}</p>
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
          <div class="preview-stop-list ${sequenceCollapsed ? "collapsed" : ""}" data-load="${load.id}">
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
            <label><span>Start time</span><input id="loadStartTime" data-load="${load.id}" type="time" value="${load.start || timeText(stats.start)}" /></label>
            <div><span>Finish</span><strong>${timeText(stats.finish)}</strong></div>
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
              return `<div><strong>${order.id}</strong><span>${escapeHtml(order.customer)} | ${orderFootprintPallets(order)} pos | ${formatLbs(orderWeightLbs(order))}</span></div>`;
            }).join("") || `<div class="empty-drop">No assigned orders.</div>`}
          </div>
        </section>
      </div>
      <div class="load-preview-footer">
        <button class="danger" data-action="delete-load" data-load="${load.id}" ${isLocked ? "disabled" : ""} title="${isLocked ? escapeHtml(loadActivityLockNotice(load)) : "Delete load"}" type="button">Delete Load</button>
        <button class="danger" data-action="clear-load" data-load="${load.id}" ${isLocked ? "disabled" : ""} title="${isLocked ? escapeHtml(loadActivityLockNotice(load)) : "Clear load"}" type="button">Clear Load</button>
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
      <div class="stop-time"><span>From ${timeText(stats.previousFinish)}</span><span>Leave ${timeText(stats.start)}</span></div>
    </article>
  `;
}

function renderPreviewStartTravelStop(truck, load, startTravel, start, displayOffset = 0) {
  if (!startTravel) return "";
  const executionStatus = travelExecutionStatus(truck, load, startTravel);
  return `
    <article class="preview-stop travel status-${executionStatus}">
      <div class="stop-main">
        <strong>${displayOffset + 1}. Travel | ${startTravel.from} to ${startTravel.to}</strong>
        <span>Empty truck reposition</span>
      </div>
      <div class="stop-time"><span>Leave ${timeText(start)}</span><span>Arrive ${timeText(start + startTravel.minutes)}</span></div>
    </article>
  `;
}

function renderPreviewStop(truck, load, stop, index, row, displayIndex = index) {
  const order = stopOrder(stop);
  if (!order) return "";
  const label = stop.type === "pick" ? `${displayIndex + 1}. Pickup | ${stop.location}` : `${displayIndex + 1}. Drop | ${order.id}`;
  const sub = stopAddress(stop, order);
  const executionStatus = stopExecutionStatus(truck, load, stop);
  const removalLocked = stopHasDriverActivity(load, stop);
  return `
    <article class="preview-stop status-${executionStatus} ${stop.type} ${selectedOrderId === order.id ? "selected-order-stop" : ""} ${row?.warning ? "warning" : ""}" draggable="true" data-load="${stop.loadId}" data-stop="${stop.id}" data-order="${order.id}" data-index="${index}">
      <button class="stop-remove" data-action="remove-stop" data-stop="${stop.id}" ${removalLocked ? "disabled" : ""} title="${removalLocked ? escapeHtml(stopActivityLockNotice(stop)) : "Remove stop"}" type="button">x</button>
      <div class="stop-main">
        <strong>${label}</strong>
        <span>${escapeHtml(sub)}</span>
      </div>
      <div class="stop-time"><span>Arrive ${timeText(row?.arrival || 0)}</span><span>Leave ${timeText(row?.depart || row?.arrival || 0)}</span></div>
    </article>
  `;
}

function renderReturnPreviewStops(load, truck, stats) {
  const stops = mapStopsForLoad(load, truck);
  const estimate = routeEstimates[load.id];
  const finish = estimate ? timeText(stats.start + estimate.totalMinutes) : "Calculating";
  const restOffset = stats.restBefore ? 1 : 0;
  const stopHtml = stops.map((stop, index) => {
    const isStart = index === 0;
    const sub = isStart
      ? `Leave ${timeText(stats.start)}`
      : `Arrive ${finish} | Return yard`;
    return `
      <article class="preview-stop ${isStart ? "drop" : "pick"}" data-load="${load.id}" data-index="${index}">
        <div class="stop-main">
          <strong>${index + restOffset + 1}. ${escapeHtml(stop.title)}</strong>
          <span>${isStart ? "Return route start" : "Return yard"}</span>
        </div>
        <div class="stop-time"><span>${escapeHtml(sub)}</span></div>
      </article>
    `;
  }).join("") || `<div class="empty-drop">No previous stop available for return route.</div>`;
  return `${renderPreviewRestStop(stats)}${stopHtml}`;
}

function renderPreviewMap() {
  const { truck, load } = selectedLoad();
  const pins = mapPins();
  const estimate = routeEstimates[selectedLoadId];
  const allowTolls = Boolean(load?.allowTolls);
  return `
    <div class="google-map-preview" id="googleMapPreview">Loading map...</div>
    <div class="route-estimate-summary" id="routeEstimateSummary">
      ${estimate ? routeEstimateSummaryHtml(estimate, truck) : `<strong>Calculating route...</strong><span>Google travel time, truck adjustment, plus driver stop time.</span>`}
    </div>
    <div class="route-option-row">
      <button class="${allowTolls ? "" : "active"}" data-action="toggle-route-tolls" data-load="${load?.id || ""}" type="button">
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

function renderPoLinkModal(order) {
  const options = poAllocationOptions;
  const salesLines = options?.salesLines || [];
  const poLines = options?.poLines || [];
  const allocations = options?.allocations || [];
  const poRefs = [...new Map(poLines.map((line) => [line.poRef, line])).values()];
  return `
    <div class="modal-backdrop show">
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
          <form class="po-link-form" data-form="po-link">
            <label class="split-field">
              <span>Purchase order</span>
              <input name="poRef" list="poLinkPoOptions" placeholder="Type PO number" autocomplete="off" required />
              <datalist id="poLinkPoOptions">
                ${poRefs.map((line) => `
                  <option value="${escapeHtml(line.poRef)}">${escapeHtml(line.vendorYard || line.vendor)} | ${escapeHtml(line.address || "")}</option>
                `).join("")}
              </datalist>
            </label>
            <div class="po-link-lines">
              ${salesLines.map((line) => {
                const units = availableUnitsForLine(line);
                return `
                <section class="po-link-line" data-sales-line="${line.id}">
                  <div>
                    <strong>${escapeHtml(line.sku || line.itemName)}</strong>
                    <span>${escapeHtml(line.description || "")}</span>
                    <em>Open ${availableQtyTextForLine(line)}</em>
                  </div>
                  ${units.map(([field, label, max]) => `
                    <label><span>${escapeHtml(label)}</span><input data-po-link-qty="${field}" type="number" min="0" max="${Number(max || 0)}" step="1" value="0" /></label>
                  `).join("") || `<span class="muted">No available quantity</span>`}
                </section>
              `; }).join("")}
            </div>
            <div class="warning-detail">
              The PO number is free input with autocomplete. On submit, each SO item with quantity will be matched to the same item in that PO and reserved locally.
            </div>
            <div class="modal-status" data-modal-status></div>
            <div class="modal-footer">
              <button data-action="close-modal" type="button">Cancel</button>
              <button class="primary" ${salesLines.length ? "" : "disabled"} type="submit">Connect PO Quantity</button>
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
        <section class="dispatch-modal">
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
              <span>Address</span>
              <input name="address" value="${escapeHtml(order.address || "")}" placeholder="Address" required />
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
              <p>${truck?.plate || ""} ${load?.name || ""}</p>
            </div>
            <button data-action="close-modal" type="button">Close</button>
          </div>
          <div class="modal-body">
            ${orderCount ? `<div class="warning-detail">This load has ${orderCount} assigned order${orderCount > 1 ? "s" : ""}. Deleting it will release all assigned orders back to the order pool.</div>` : `<div class="empty-drop">This load is empty.</div>`}
          </div>
          <div class="modal-footer">
            <button data-action="close-modal" type="button">Cancel</button>
            <button class="danger" data-action="confirm-delete-load" data-load="${load?.id || ""}" type="button">Delete Load</button>
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

function addOrderToLoad(orderId, loadId, type = "drop", location = "", insertIndex = null) {
  const { truck, load } = findLoad(loadId);
  const order = orderById(orderId);
  if (!load || !order) return false;
  if (!truckHasDriver(truck)) {
    routeNotice = driverLockNotice(truck);
    return false;
  }
  if (type === "drop" && isOrderPlannedOutsideCurrentPlan(order)) {
    selectedOrderId = orderId;
    selectedOrderIds = new Set([orderId]);
    routeNotice = `${order.id} is already ${orderPlannedElsewhereText(order)}. Remove it from that plan before adding it here.`;
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
  let cleanInsertIndex = Number.isInteger(insertIndex) ? insertIndex : null;
  if (type === "drop") {
    const addedPickups = ensurePickupStops(load, order, cleanInsertIndex);
    if (Number.isInteger(cleanInsertIndex)) cleanInsertIndex += addedPickups;
    if (["SO", "TO"].includes(order.type)) pendingOperatorAlertRefs.add(order.id);
  }
  const stopLocation = location || order.pickupLocations[0] || "3445";
  const existing = pullExistingStop(orderId, type, stopLocation);
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
      insertIndex: cleanInsertIndex,
      movedFromLoadId: existing?.load?.id || null,
      order: summarizeOrder(order)
    }
  });
  return true;
}

function pullExistingStop(orderId, type, location) {
  for (const truck of trucks) {
    for (const load of truck.loads) {
      const index = load.stops.findIndex((stop) => {
        if (stop.orderId !== orderId || stop.type !== type) return false;
        return type !== "pick" || String(stop.location) === String(location);
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
  if (!load.returnOnly && loadHasDriverActivity(load)) {
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
  if (!order) return;
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
  if (!split?.originalOrderId) {
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

function groupOrder(orderId) {
  const order = orderById(orderId);
  const selected = selectedOrders();
  const groupItems = selected.length > 1 ? selected : [];
  if (groupItems.length < 2) return;
  const grouped = {
    ...groupItems[0],
    id: uniqueGroupedDispatchOrderId(groupItems),
    customer: `${groupItems.length} orders grouped`,
    address: groupItems[0].address,
    pallets: groupItems.reduce((sum, item) => sum + Number(item.pallets || 0), 0),
    layers: groupItems.reduce((sum, item) => sum + Number(item.layers || 0), 0),
    salesQty: groupItems.reduce((sum, item) => sum + Number(item.salesQty || 0), 0),
    weight: groupItems.reduce((sum, item) => sum + Number(item.weight || 0), 0),
    unloadMinutes: groupItems.reduce((sum, item) => sum + Number(item.unloadMinutes || 0), 0),
    travelMinutes: Math.max(...groupItems.map((item) => Number(item.travelMinutes || 0))),
    pickupLocations: [...new Set(groupItems.flatMap((item) => item.pickupLocations || []))],
    items: groupItems.flatMap((item) => item.items || []),
    childOrders: groupItems.map((item) => item.id),
    childOrderDetails: groupItems.map((item) => normalizeOrder({ ...item })),
    notes: `Grouped orders: ${groupItems.map((item) => item.id).join(", ")}`
  };
  const ids = new Set(groupItems.map((item) => item.id));
  const firstIndex = orders.findIndex((item) => ids.has(item.id));
  orders = orders.filter((item) => !ids.has(item.id));
  orders.splice(Math.max(firstIndex, 0), 0, grouped);
  selectedOrderId = grouped.id;
  selectedOrderIds = new Set([grouped.id]);
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
      audit: { sessionId: dispatchSessionId }
    })
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function cancelTransitCoOnServer(coId) {
  if (!coId) return null;
  const response = await fetch(`/api/dispatch/co-orders/${encodeURIComponent(coId)}?sessionId=${encodeURIComponent(dispatchSessionId)}`, {
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

app.addEventListener("dragstart", (event) => {
  const orderCard = event.target.closest("[data-order]");
  const stopCard = event.target.closest("[data-stop]");
  if (stopCard) {
    dragged = { type: "stop", stopId: stopCard.dataset.stop };
    event.dataTransfer.setData("text/plain", stopCard.dataset.stop);
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

function startPreviewResize(event) {
  isResizingPreview = true;
  event.preventDefault();
}

function movePreviewResize(event) {
  if (!isResizingPreview) return;
  const maxWidth = Math.round(window.innerWidth * 0.92);
  loadPreviewWidth = Math.min(Math.max(window.innerWidth - event.clientX, 390), maxWidth);
  localStorage.setItem("mbbs.dispatch.previewWidth", String(loadPreviewWidth));
  const panel = document.querySelector(".load-preview-panel");
  if (panel) panel.style.width = `${loadPreviewWidth}px`;
}

function stopPreviewResize() {
  isResizingPreview = false;
}

app.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".load-preview-resize")) return;
  startPreviewResize(event);
});

app.addEventListener("mousedown", (event) => {
  if (!event.target.closest(".load-preview-resize")) return;
  startPreviewResize(event);
});

window.addEventListener("pointermove", movePreviewResize);
window.addEventListener("mousemove", movePreviewResize);
window.addEventListener("pointerup", stopPreviewResize);
window.addEventListener("mouseup", stopPreviewResize);

function isEditingTextField(target) {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  return Boolean(element.closest("input, textarea, select, [contenteditable='true']"));
}

window.addEventListener("keydown", (event) => {
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
  const list = event.target.closest(".stop-list, .preview-stop-list");
  const stopCard = event.target.closest(".stop-card, .preview-stop");
  const createZone = event.target.closest(".timeline-drop-zone");
  if (!list && !createZone && !stopCard) return;
  event.preventDefault();
  document.querySelectorAll(".insert-before,.insert-after").forEach((item) => item.classList.remove("insert-before", "insert-after"));
  if (stopCard) {
    const rect = stopCard.getBoundingClientRect();
    const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0;
    stopCard.classList.add(ratio > 0.66 ? "insert-after" : "insert-before");
  }
  (stopCard || list || createZone).classList.add("drag-over");
});

app.addEventListener("dragleave", (event) => {
  event.target.closest(".stop-list, .preview-stop-list")?.classList.remove("drag-over");
  event.target.closest(".stop-card, .preview-stop")?.classList.remove("drag-over", "insert-before", "insert-after");
  event.target.closest(".timeline-drop-zone")?.classList.remove("drag-over");
});

app.addEventListener("drop", (event) => {
  const targetStop = event.target.closest(".stop-card, .preview-stop");
  const list = event.target.closest(".stop-list, .preview-stop-list");
  const createZone = event.target.closest(".timeline-drop-zone");
  if ((!list && !createZone) || !dragged) return;
  event.preventDefault();
  list?.classList.remove("drag-over");
  targetStop?.classList.remove("drag-over", "insert-before", "insert-after");
  createZone?.classList.remove("drag-over");
  if (createZone && dragged.type === "order") {
    const truck = trucks.find((item) => item.id === createZone.dataset.loadCreate);
    if (truck) {
      if (!truckHasDriver(truck)) {
        routeNotice = driverLockNotice(truck);
        dragged = null;
        return render();
      }
      const load = addLoadToTruck(truck);
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
    return render();
  }
  if (!list) return;
  const targetLoadId = targetStop?.dataset.load || list.dataset.load;
  const targetFound = findLoad(targetLoadId);
  const targetLoad = targetFound.load;
  if (!truckHasDriver(targetFound.truck)) {
    routeNotice = driverLockNotice(targetFound.truck);
    dragged = null;
    return render();
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
        return render();
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
  render();
});

app.addEventListener("click", (event) => {
  if (event.target.dataset?.action === "close-modal") {
    modalType = "";
    modalOrderId = "";
    modalLoadId = "";
    poAllocationOptions = null;
    poAllocationLoading = false;
    return render();
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
      orderClickTimer = setTimeout(() => render(), 180);
      return;
    }
  }
  if (!button) return;
  const action = button.dataset.action;
  if (!action) return;
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
    render();
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
        audit: { sessionId: dispatchSessionId }
      })
    }).then((response) => {
      if (!response.ok) return response.text().then((text) => Promise.reject(new Error(text)));
      return response.json();
    }).then(() => {
      applyUnsplitOrder(prepared);
      requestOrderPoolRefreshOnNextSave();
      render();
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
    loadPoAllocationOptions(button.dataset.order).then(() => render({ save: false })).catch((error) => {
      poAllocationLoading = false;
      routeNotice = `PO link options failed: ${error.message}`;
      render({ save: false });
    });
    render({ save: false });
    return;
  }
  if (action === "order-type-tab") {
    activeOrderType = button.dataset.type;
    searchText = "";
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
    saveCurrentPlanNow().then(() => fetch(`/api/dispatch/plans/${encodeURIComponent(currentPlan.id)}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audit: { sessionId: dispatchSessionId } })
    })).then((response) => {
      if (!response.ok) return response.text().then((text) => Promise.reject(new Error(text)));
      return response.json();
    }).then(async (plan) => {
      currentPlan = plan;
      await loadPlanHistory();
      routeNotice = `Plan ${displayDate(plan.planDate)} confirmed.`;
      render({ save: false });
    }).catch((error) => {
      routeNotice = `Confirm failed: ${error.message}`;
      render({ save: false });
    });
    return;
  }
  if (action === "reopen-plan") {
    fetch(`/api/dispatch/plans/${encodeURIComponent(currentPlan.id)}/reopen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audit: { sessionId: dispatchSessionId } })
    }).then((response) => {
      if (!response.ok) return response.text().then((text) => Promise.reject(new Error(text)));
      return response.json();
    }).then(async (plan) => {
      currentPlan = plan;
      currentPlanDate = plan.planDate;
      localStorage.setItem(DISPATCH_PLAN_DATE_KEY, currentPlanDate);
      if (plan.orders?.length && plan.trucks?.length) applySavedPlan(plan);
      await loadPlanHistory();
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
    groupOrder(button.dataset.order);
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
      body: JSON.stringify({
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
      })
    }).then((response) => {
      if (!response.ok) return response.text().then((text) => Promise.reject(new Error(text)));
      return response.json();
    }).then(() => {
      modalType = "";
      modalOrderId = "";
      routeNotice = `Unpack request sent for ${order?.id}.`;
      render();
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
        render();
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
      body: JSON.stringify({ vendorYardId, audit: { sessionId: dispatchSessionId, before } })
    }).then((response) => {
      if (!response.ok) return response.text().then((text) => Promise.reject(new Error(text)));
      return loadDispatchOrders();
    }).then(() => {
      modalType = "";
      modalOrderId = "";
      routeNotice = "PO vendor yard updated.";
      render();
    }).catch((error) => {
      routeNotice = `PO yard update failed: ${error.message}`;
      render();
    });
    return;
  }
  if (action === "cancel-po-link") {
    fetch(`/api/dispatch/po-allocations/${encodeURIComponent(button.dataset.allocation)}?sessionId=${encodeURIComponent(dispatchSessionId)}`, {
      method: "DELETE"
    }).then((response) => {
      if (!response.ok) return response.text().then((text) => Promise.reject(new Error(text)));
      return response.json();
    }).then((payload) => {
      poAllocationOptions = payload.options;
      applyDispatchOrderFeed(payload.orders || []);
      requestOrderPoolRefreshOnNextSave();
      routeNotice = "PO link cancelled.";
      render();
    }).catch((error) => {
      routeNotice = `Cancel PO link failed: ${error.message}`;
      render({ save: false });
    });
    return;
  }
  if (action === "delete-load") {
    const { load } = findLoad(button.dataset.load);
    if (!load) return render();
    if (!load.returnOnly && loadHasDriverActivity(load)) {
      routeNotice = loadActivityLockNotice(load);
      return render({ save: false });
    }
    if (!load.returnOnly && load.stops.length) {
      modalType = "delete-load";
      modalLoadId = load.id;
    } else {
      deleteLoad(load.id);
    }
  }
  if (action === "confirm-delete-load") {
    const { load } = findLoad(button.dataset.load);
    if (!load?.returnOnly && loadHasDriverActivity(load)) {
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
  if (action === "move-truck-up" || action === "move-truck-down") {
    const moved = moveTruckInPlan(button.dataset.truck, action === "move-truck-up" ? -1 : 1);
    if (moved) {
      routeNotice = "";
      requestTruckSequenceSaveOnNextSave();
    }
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
      const warning = orderHasDriverActivityInLoad(found.load, orderId) ? stopActivityLockNotice(found.stop) : "";
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
    loadDispatchOrders().then(() => restoreServerPlan()).then((applied) => {
      if (applied) render({ save: false });
      else render();
    });
    return;
  }
  if (action === "close-route-notice") routeNotice = "";
  render();
});

app.addEventListener("dblclick", (event) => {
  const orderCard = event.target.closest("[data-order]");
  if (!orderCard) return;
  const order = orderById(orderCard.dataset.order);
  if (!order) return;
  clearTimeout(orderClickTimer);
  selectedOrderId = order.id;
  selectedOrderIds = new Set([order.id]);
  modalType = "edit-order";
  modalOrderId = order.id;
  render();
});

app.addEventListener("input", (event) => {
  if (event.target?.id === "splitParts") {
    splitParts = Math.min(Math.max(Number(event.target.value) || 2, 2), 10);
    ensureSplitDraft(orderById(modalOrderId), true);
    return render();
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
  refreshOrderPoolForSearch();
});

app.addEventListener("change", (event) => {
  if (event.target?.id === "planDateInput") {
    const nextDate = event.target.value || todayLocalDate();
    loadPlanForDate(nextDate, { createIfMissing: true }).then((result) => {
      routeNotice = result.created
        ? `Started dispatch plan for ${currentPlanDate}.`
        : `Loaded dispatch plan for ${currentPlanDate}.`;
      render({ save: result.created || !result.hasSnapshot });
    }).catch((error) => {
      routeNotice = `Plan load failed: ${error.message}`;
      render({ save: false });
    });
    return;
  }
  if (event.target?.id === "dispatchDate") {
    dispatchDateFilter = event.target.value || "";
    selectedOrderId = openOrders()[0]?.id || selectedOrderId;
    selectedOrderIds = new Set(selectedOrderId ? [selectedOrderId] : []);
    render();
    return;
  }
  if (event.target?.dataset?.truckStart) {
    const truck = trucks.find((item) => item.id === event.target.dataset.truckStart);
    if (truck) {
      const before = summarizeTruck(truck);
      truck.base = event.target.value || "12441";
      routeCache = {};
      logDispatchAudit({
        action: "truck_start_yard_updated",
        entityType: "truck",
        entityId: truck.id,
        truckId: truck.id,
        before,
        after: summarizeTruck(truck)
      });
      render();
    }
    return;
  }
  if (event.target?.dataset?.truckDriver) {
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
      routeCache = {};
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
      render();
    }
    return;
  }
  if (event.target?.dataset?.truckParking) {
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
      render();
    }
    return;
  }
  if (event.target?.dataset?.returnYard) {
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
      render();
    }
    return;
  }
  if (event.target?.id !== "loadStartTime") return;
  const { load } = findLoad(event.target.dataset.load);
  if (load) {
    const before = summarizeLoad(load);
    load.start = event.target.value;
    logDispatchAudit({
      action: "load_start_time_updated",
      entityType: "load",
      entityId: load.id,
      loadId: load.id,
      before,
      after: summarizeLoad(load)
    });
    render();
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
  const stop = stopCard ? stopById(stopCard.dataset.stop) : null;
  const pickupLocation = stop?.type === "pick" ? stop.location : "";
  const itemRows = tooltipItemsForOrder(order, { pickupLocation }).map((item) => `
    <div>
      <b>${escapeHtml(item.sku)}</b>
      <span>${escapeHtml(itemQtyText(item))}</span>
    </div>
  `).join("");
  tooltip.innerHTML = `
    <strong>${order.id} | ${escapeHtml(order.customer)}</strong>
    <span>${escapeHtml(order.address)}</span>
    ${pickupLocation ? `<span>Pickup content: ${escapeHtml(pickupLocation)}</span>` : ""}
    <span>${order.expectedDeliveryDate ? `${displayDate(order.expectedDeliveryDate)} | ` : ""}${orderUnitText(order)} | ${orderFootprintPallets(order)} pos | ${formatLbs(orderWeightLbs(order))} | ${order.windowStart || "--"}-${order.windowEnd || "--"}</span>
    ${order.consolidation ? `<span>Consolidate ${order.consolidation.shortageQty} from ${order.consolidation.sourceYard} to ${order.consolidation.targetYard}</span>` : ""}
    ${order.transitCo ? `<span>Requires ${order.transitCo.id}: ${order.transitCo.fromYard} to ${order.transitCo.toYard}</span>` : ""}
    ${order.type === "CO" ? `<span>Local CO for ${escapeHtml(order.sourceOrderId || order.relatedSoId || "")}</span>` : ""}
    <span>${escapeHtml(order.notes)}</span>
    ${itemRows ? `<div class="tooltip-items">${itemRows}</div>` : ""}
  `;
}

function showLoadTooltip(event) {
  const card = event.target.closest("[data-load-card]");
  if (!card) return;
  const { truck, load } = findLoad(card.dataset.loadCard);
  if (!truck || !load) return;
  const stats = loadStats(truck, load);
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
    <span>${formatLbs(stats.weightTotalLbs)}/${formatLbs(stats.capacityLbs)} | ${stats.footprintTotal} pos | Finish ${timeText(stats.finish)}</span>
    <span>Start ${timeText(stats.start)} | ${load.returnOnly ? "Return load" : `${load.stops.filter((stop) => stop.type === "drop").length} drops`}</span>
    ${stats.warnings.length ? `<span>${escapeHtml(stats.warnings[0])}</span>` : `<span>No warning.</span>`}
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
  const data = Object.fromEntries(new FormData(form).entries());
  if (form.dataset.form === "po-link") {
    const order = orderById(modalOrderId);
    if (!order) return;
    const poRef = String(data.poRef || "").trim();
    const lines = [...form.querySelectorAll(".po-link-line")].map((row) => ({
      salesLineId: row.dataset.salesLine,
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
      setModalFormStatus(form, "Enter quantity for at least one SO item.", "error");
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
      body: JSON.stringify({
        poRef,
        lines,
        audit: { sessionId: dispatchSessionId }
      })
    }).then((response) => {
      if (!response.ok) return response.text().then((text) => Promise.reject(new Error(text)));
      return response.json();
    }).then((payload) => {
      poAllocationOptions = payload.options;
      if (Array.isArray(payload.orders)) applyDispatchOrderFeed(payload.orders);
      requestOrderPoolRefreshOnNextSave();
      routeNotice = `${payload.allocations?.length || 0} PO item line(s) connected to sales order.`;
      render();
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
          body: JSON.stringify({
            type: order.type,
            sourceTable: order.sourceTable,
            address: data.address,
            expectedDeliveryDate: data.expectedDeliveryDate,
            windowStart,
            windowEnd,
            audit: {
              sessionId: dispatchSessionId,
              before: summarizeOrder(order)
            }
          })
        }).then((response) => {
          if (!response.ok) return response.text().then((text) => Promise.reject(new Error(text)));
          return response.json();
        });
    saveDetails.then(async (payload) => {
      order.address = data.address;
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
      render();
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
  render();
});

async function initDispatch() {
  await loadDispatchConfig();
  await loadDispatchSetup();
  await loadDispatchVendorYards();
  await loadDispatchOrders();
  await loadPlanHistory();
  const restoredServer = await loadPlanForDate(currentPlanDate, { createIfMissing: true });
  await loadDriverJobStatuses();
  if (!restoredServer.loaded) restoreSavedPlan();
  render({ save: restoredServer.created || !restoredServer.hasSnapshot });
  connectEvents();
  setInterval(pollServerPlan, 5000);
}

window.addEventListener("mbbs-language-changed", () => {
  render({ save: false });
});

requireDispatchLogin({
  mount: app,
  onReady: initDispatch
});

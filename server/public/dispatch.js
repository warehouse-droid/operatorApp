const app = document.getElementById("dispatchApp");

const HUBS = {
  "3445": { x: 48, y: 40, lat: 43.7046, lng: -79.2767, address: "3445 Kennedy Road, Toronto, ON" },
  "2967": { x: 62, y: 52, lat: 43.8183, lng: -79.3062, address: "2967 Kennedy Road, Toronto, ON" },
  "12441": { x: 40, y: 66, lat: 43.9445, lng: -79.3740, address: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON" },
  "Vendor": { x: 28, y: 22, lat: 43.857, lng: -79.521 }
};

const MAP_CENTER = { lat: 43.700, lng: -79.650 };

const initialOrders = [
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

let orders = initialOrders.map((order) => ({ ...order, assigned: false }));
let trucks = [
  { id: "T1", plate: "MBBS-101", capacityLbs: 48000, driver: "Alex Wong", license: "AZ", base: "3445", start: "07:00", loadMinutes: 42, unloadMinutes: 36, loads: [{ id: "T1-L1", name: "Load 1", stops: [] }] },
  { id: "T2", plate: "MBBS-205", capacityLbs: 44000, driver: "Jenny Lee", license: "DZ", base: "3445", start: "07:30", loadMinutes: 38, unloadMinutes: 32, loads: [{ id: "T2-L1", name: "Load 1", stops: [] }] },
  { id: "T3", plate: "MBBS-318", capacityLbs: 52000, driver: "Carlos Ramos", license: "AZ", base: "2967", start: "08:00", loadMinutes: 45, unloadMinutes: 40, loads: [{ id: "T3-L1", name: "Load 1", stops: [] }] },
  { id: "T4", plate: "MBBS-422", capacityLbs: 36000, driver: "Maya Chan", license: "DZ", base: "2967", start: "08:30", loadMinutes: 34, unloadMinutes: 30, loads: [{ id: "T4-L1", name: "Load 1", stops: [] }] },
  { id: "T5", plate: "MBBS-516", capacityLbs: 48000, driver: "Omar Patel", license: "AZ", base: "12441", start: "07:15", loadMinutes: 44, unloadMinutes: 35, loads: [{ id: "T5-L1", name: "Load 1", stops: [] }] },
  { id: "T6", plate: "MBBS-629", capacityLbs: 40000, driver: "Grace Ng", license: "DZ", base: "12441", start: "09:00", loadMinutes: 36, unloadMinutes: 33, loads: [{ id: "T6-L1", name: "Load 1", stops: [] }] }
];

let drivers = [
  { name: "Alex Wong", license: "AZ", number: "A90211", login: "alex", loadMinutes: 42, unloadMinutes: 36 },
  { name: "Jenny Lee", license: "DZ", number: "D18870", login: "jenny", loadMinutes: 38, unloadMinutes: 32 }
];

let fleet = [
  { plate: "MBBS-101", capacityLbs: 48000 },
  { plate: "MBBS-205", capacityLbs: 44000 },
  { plate: "MBBS-318", capacityLbs: 52000 }
];

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
let selectedOrderIds = new Set([selectedOrderId]);
let loadPreviewOpen = false;
let lastSavedAt = "";
let routeNotice = "";
let dispatchConfig = { googleMapsApiKey: "" };
let googleMapsPromise = null;
let routeEstimates = {};
const DISPATCH_PLAN_KEY = "mbbs.dispatch.plan";

function minutes(value) {
  const [hour, minute] = String(value || "00:00").split(":").map(Number);
  return (hour * 60) + minute;
}

function timeText(totalMinutes) {
  const wrapped = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

function formatLbs(value) {
  return `${Math.round(Number(value || 0)).toLocaleString()} lb`;
}

function truckCapacityLbs(truck) {
  return Number(truck?.capacityLbs || 0) || Number(truck?.capacity || 0) * 2000 || 48000;
}

function orderWeightLbs(order) {
  return Math.round(Number(order?.weight || 0) * 1000);
}

function orderFootprintPallets(order) {
  return Number(order?.pallets || 0) + (Number(order?.layers || 0) > 0 ? 1 : 0);
}

function itemFootprint(item) {
  return Number(item?.splitQty ?? item?.pallets ?? 0) + (Number(item?.layers || 0) > 0 ? 1 : 0);
}

function orderUnitText(order) {
  return `${order.pallets || 0} PLT${order.layers ? ` ${order.layers} LYR` : ""}`;
}

function movementText(order) {
  if (order.type === "PO") return `${order.sourceYard || "Vendor yard"} to ${order.destinationYard || order.pickupLocations?.[0] || "our yard"}`;
  if (order.type === "TO") return `${order.sourceYard || order.pickupLocations?.[0] || "source yard"} to ${order.destinationYard || "destination yard"}`;
  return order.address;
}

function orderTypeLabel(type) {
  return ({ SO: "Sales Order", PO: "Purchase Order", TO: "Transfer Order" })[type] || "Order";
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

function normalizeOrder(order) {
  const id = String(order.id || "");
  return {
    type: id.startsWith("PO") ? "PO" : id.startsWith("TO") ? "TO" : "SO",
    committedQty: Number(order.salesQty || 0),
    ...order
  };
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

function autoSavePlan() {
  const savedAt = new Date();
  lastSavedAt = savedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  localStorage.setItem(DISPATCH_PLAN_KEY, JSON.stringify({
    savedAt: savedAt.toISOString(),
    orders,
    trucks
  }));
}

function restoreSavedPlan() {
  try {
    const saved = JSON.parse(localStorage.getItem(DISPATCH_PLAN_KEY) || "null");
    if (!saved?.orders?.length || !saved?.trucks?.length) return;
    const defaultById = new Map(initialOrders.map((order) => [order.id, normalizeOrder(order)]));
    const savedById = new Map(saved.orders.map((order) => {
      const base = defaultById.get(order.id) || {};
      const merged = {
        ...base,
        ...order,
        shortageAvailability: base.shortageAvailability || order.shortageAvailability,
        committedQty: base.shortageAvailability ? base.committedQty : order.committedQty
      };
      return [order.id, normalizeOrder(merged)];
    }));
    for (const order of initialOrders) {
      if (!savedById.has(order.id)) savedById.set(order.id, normalizeOrder(order));
    }
    orders = [...savedById.values()];
    trucks = saved.trucks.map((truck) => ({
      ...truck,
      capacityLbs: truckCapacityLbs(truck)
    }));
    selectedOrderId = orders[0]?.id || "";
    selectedLoadId = trucks[0]?.loads[0]?.id || "";
    selectedOrderIds = new Set(selectedOrderId ? [selectedOrderId] : []);
    lastSavedAt = saved.savedAt ? new Date(saved.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  } catch {
    localStorage.removeItem(DISPATCH_PLAN_KEY);
  }
}

function findLoad(loadId) {
  for (const truck of trucks) {
    const load = truck.loads.find((item) => item.id === loadId);
    if (load) return { truck, load };
  }
  return {};
}

function allAssignedOrderIds() {
  const ids = new Set();
  for (const truck of trucks) {
    for (const load of truck.loads) {
      for (const stop of load.stops) ids.add(stop.orderId);
    }
  }
  return ids;
}

function openOrders() {
  const assigned = allAssignedOrderIds();
  const term = searchText.trim();
  return orders.filter((order) => {
    if (assigned.has(order.id)) return false;
    if (!matchesSearch(order)) return false;
    return term ? true : order.type === activeOrderType;
  });
}

function matchesSearch(order) {
  const term = searchText.trim().toLowerCase();
  if (!term) return true;
  return [order.id, order.type, order.customer, order.address, order.notes, ...(order.items || []).map((item) => item.sku)].join(" ").toLowerCase().includes(term);
}

function groupCandidates(order) {
  return orders.filter((item) => item.type === order.type && item.groupKey === order.groupKey && item.id !== order.id);
}

function stopOrder(stop) {
  return orderById(stop.orderId);
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

function loadStats(truck, load) {
  const plannedStart = load.start || timeText(minutes(truck.start) + ((Number(load.name.replace(/\D/g, "")) || 1) - 1) * 270);
  let current = minutes(plannedStart);
  const rows = [];
  let palletTotal = 0;
  let footprintTotal = 0;
  let weightTotalLbs = 0;
  let travelTotal = 0;
  let warningCount = 0;
  const warnings = [];
  const sequenceWarnings = sequenceWarningsForStops(load.stops);
  const pickedLocations = new Set();
  const explicitPickCount = load.stops.filter((stop) => stop.type === "pick").length;
  if (!explicitPickCount) current += uniquePickupLocations(load, truck).length * truck.loadMinutes;

  for (const stop of load.stops) {
    const order = stopOrder(stop);
    if (!order) continue;
    if (stop.type === "pick") {
      pickedLocations.add(String(stop.location));
      current += truck.loadMinutes;
      rows.push({ stop, order, arrival: current, depart: current, warning: false });
      continue;
    }
    const missingPickupLocations = requiredPickupLocations(order).filter((location) => !pickedLocations.has(String(location)));
    current += order.travelMinutes;
    const arrival = current;
    current += order.unloadMinutes || truck.unloadMinutes;
    palletTotal += Number(order.pallets || 0);
    footprintTotal += orderFootprintPallets(order);
    weightTotalLbs += orderWeightLbs(order);
    travelTotal += Number(order.travelMinutes || 0);
    let warningReason = "";
    if (missingPickupLocations.length) warningReason = `${order.id}: pickup ${missingPickupLocations.join(", ")} before drop.`;
    else if (arrival > minutes(order.windowEnd)) warningReason = `${order.id} late: arrives ${timeText(arrival)}, window ends ${order.windowEnd}`;
    else if (arrival < minutes(order.windowStart) - 45) warningReason = `${order.id} early: arrives ${timeText(arrival)}, window starts ${order.windowStart}`;
    if (warningReason) {
      warningCount += 1;
      warnings.push(warningReason);
    }
    rows.push({ stop, order, arrival, depart: current, warning: Boolean(warningReason), warningReason });
  }
  for (const warning of sequenceWarnings) {
    if (!warnings.includes(warning)) {
      warningCount += 1;
      warnings.push(warning);
    }
  }

  const returnTrip = Math.max(22, Math.round(travelTotal / Math.max(load.stops.filter((stop) => stop.type === "drop").length, 1) * 0.8));
  const capacityLbs = truckCapacityLbs(truck);
  const fullLoad = weightTotalLbs >= capacityLbs;
  const capacityWarning = weightTotalLbs > capacityLbs;
  if (capacityWarning) {
    warningCount += 1;
    warnings.push(`Over capacity: ${formatLbs(weightTotalLbs)} loaded, truck capacity ${formatLbs(capacityLbs)}`);
  }
  return { rows, palletTotal, footprintTotal, weightTotalLbs, capacityLbs, start: minutes(plannedStart), finish: current + returnTrip, returnTrip, warningCount, warnings, capacityWarning, fullLoad };
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
      if (!load.returnOnly) continue;
      const previous = truck.loads[index - 1];
      if (!previous || previous.returnOnly || !loadStats(truck, previous).fullLoad) {
        truck.loads.splice(index, 1);
      }
    }

    for (let index = 0; index < truck.loads.length; index += 1) {
      const load = truck.loads[index];
      if (load.returnOnly || !loadStats(truck, load).fullLoad) continue;
      if (!truck.loads[index + 1]?.returnOnly) {
        truck.loads.splice(index + 1, 0, {
          id: `${truck.id}-R${Date.now()}-${index}`,
          name: "Return Load",
          returnOnly: true,
          stops: []
        });
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

function selectedOrder() {
  return orderById(selectedOrderId) || orders[0];
}

function selectedOrders() {
  return [...selectedOrderIds].map(orderById).filter(Boolean);
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
      const hub = HUBS[stop.location] || HUBS[truck?.base] || { x: 50, y: 50 };
      pins.push({ label: String(index + 1), className: "pick", x: hub.x, y: hub.y });
    } else {
      pins.push({ label: `${index + 1}`, className: "", x: order.x, y: order.y });
    }
  });
  return pins;
}

function hubPosition(location) {
  const hub = HUBS[location] || HUBS["3445"];
  return { lat: hub.lat, lng: hub.lng };
}

function hubAddress(location) {
  return HUBS[location]?.address || location;
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

function stopIsOwnYard(stop, order) {
  if (stop.type === "pick") return Boolean(HUBS[stop.location]);
  return Boolean(order?.destinationYard && HUBS[order.destinationYard]);
}

function stopStayMinutes(stop, order, truck) {
  const base = stopIsOwnYard(stop, order) ? Number(truck?.loadMinutes || 0) : Number(truck?.unloadMinutes || 0);
  return base + orderFootprintPallets(order);
}

function stopPosition(stop, order) {
  if (stop.type === "pick") return hubPosition(stop.location);
  if (order?.destinationYard && HUBS[order.destinationYard]) return hubPosition(order.destinationYard);
  return orderPosition(order);
}

function stopAddress(stop, order) {
  if (stop.type === "pick") return hubAddress(stop.location);
  if (order?.destinationYard && HUBS[order.destinationYard]) return hubAddress(order.destinationYard);
  return order?.address || hubAddress("3445");
}

function mapStopsForLoad(load, truck) {
  return (load?.stops || []).map((stop, index) => {
    const order = stopOrder(stop);
    if (!order) return null;
    const position = stopPosition(stop, order);
    const sequence = index + 1;
    return {
      ...position,
      address: stopAddress(stop, order),
      label: String(sequence),
      title: stop.type === "pick" ? `${sequence}. Pickup ${stop.location}` : `${sequence}. Drop ${order.id}`,
      type: stop.type,
      stayMinutes: stopStayMinutes(stop, order, truck),
      orderId: order.id
    };
  }).filter(Boolean);
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
  const map = new google.maps.Map(canvas, {
    center: stops[0] || MAP_CENTER,
    zoom: 9,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false
  });
  const routeSummary = document.getElementById("routeEstimateSummary");
  const bounds = new google.maps.LatLngBounds();
  stops.forEach((stop, index) => {
    const marker = new google.maps.Marker({
      position: { lat: stop.lat, lng: stop.lng },
      map,
      label: stop.label,
      title: stop.title
    });
    marker.setIcon(stop.type === "pick"
      ? "https://maps.google.com/mapfiles/ms/icons/blue-dot.png"
      : "https://maps.google.com/mapfiles/ms/icons/green-dot.png");
    const info = new google.maps.InfoWindow({
      content: `<strong>${stop.title}</strong><br>${stop.type === "pick" ? "Pickup" : "Drop off"}<br>Stay ${stop.stayMinutes} min`
    });
    marker.addListener("click", () => info.open({ anchor: marker, map }));
    bounds.extend(marker.getPosition());
  });
  if (stops.length > 1 && google.maps.DirectionsService) {
    const directionsService = new google.maps.DirectionsService();
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
    directionsService.route({
      origin: stops[0].address || { lat: stops[0].lat, lng: stops[0].lng },
      destination: stops[stops.length - 1].address || { lat: stops[stops.length - 1].lat, lng: stops[stops.length - 1].lng },
      waypoints: stops.slice(1, -1).map((stop) => ({ location: stop.address || { lat: stop.lat, lng: stop.lng }, stopover: true })),
      travelMode: google.maps.TravelMode.DRIVING,
      optimizeWaypoints: false,
      drivingOptions: {
        departureTime: new Date(Date.now() + 5 * 60 * 1000),
        trafficModel: google.maps.TrafficModel.BEST_GUESS
      }
    }, (result, status) => {
      if (status !== "OK" || !result) {
        if (routeSummary) routeSummary.textContent = `Google route unavailable (${status}).`;
        if (stops.length) map.fitBounds(bounds, 36);
        return;
      }
      directionsRenderer.setDirections(result);
      const legs = result.routes?.[0]?.legs || [];
      const driveSeconds = legs.reduce((sum, leg) => sum + Number((leg.duration_in_traffic || leg.duration)?.value || 0), 0);
      const driveMinutes = Math.round(driveSeconds / 60);
      const stayMinutes = stops.reduce((sum, stop) => sum + Number(stop.stayMinutes || 0), 0);
      const totalMinutes = driveMinutes + stayMinutes;
      routeEstimates[load.id] = { driveMinutes, stayMinutes, totalMinutes };
      if (routeSummary) {
        routeSummary.innerHTML = `<strong>${totalMinutes} min total</strong><span>${driveMinutes} min drive + ${stayMinutes} min loading/unloading</span>`;
      }
    });
  } else if (stops.length > 1) {
    new google.maps.Polyline({
      path: stops.map((stop) => ({ lat: stop.lat, lng: stop.lng })),
      geodesic: true,
      strokeColor: "#006f6b",
      strokeOpacity: 0.9,
      strokeWeight: 4,
      map
    });
    const stayMinutes = stops.reduce((sum, stop) => sum + Number(stop.stayMinutes || 0), 0);
    if (routeSummary) routeSummary.innerHTML = `<strong>${stayMinutes} min stay</strong><span>Add more stops for Google travel estimate.</span>`;
  }
  if (stops.length) map.fitBounds(bounds, 36);
}

function render() {
  syncPickupStops();
  syncReturnLoads();
  autoSavePlan();
  const stats = boardStats();
  app.innerHTML = `
    <section class="dispatch-shell">
      <header class="dispatch-topbar">
        <div>
          <p>MBBS Transportation</p>
          <h1>Dispatch Planning</h1>
        </div>
        <div class="topbar-controls">
          <input id="dispatchDate" type="date" value="2026-06-22" />
          <select id="yardFilter">
            <option>All yards</option>
            <option>3445</option>
            <option>2967</option>
            <option>12441</option>
          </select>
        </div>
        <div class="topbar-actions">
          <button onclick="location.href='/dispatch/setup'" type="button">☰ Setup</button>
          <button data-action="refresh-orders" type="button">Refresh Orders</button>
          <span class="autosave-pill">Saved ${lastSavedAt}</span>
        </div>
      </header>
      ${routeNotice ? `<div class="route-notice">${escapeHtml(routeNotice)}</div>` : ""}
      <div class="dispatch-grid">
        ${renderOrderPool()}
        <section class="planner-panel">
          <div class="kpi-strip">
            <div class="kpi"><span>Open Orders</span><strong>${stats.open}</strong></div>
            <div class="kpi"><span>Planned Drops</span><strong>${stats.planned}</strong></div>
            <div class="kpi"><span>Total Stops</span><strong>${stats.stops}</strong></div>
            <div class="kpi"><span>Warnings</span><strong>${stats.warnings}</strong></div>
            <div class="kpi"><span>Trucks</span><strong>${trucks.length}</strong></div>
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
  renderGoogleMapPreview();
}

function renderOrderPool() {
  const searching = Boolean(searchText.trim());
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Order Pool</h2>
          <p>${searching ? "Search results across SO, PO, and TO." : `${orderTypeLabel(activeOrderType)} list`}</p>
        </div>
        <div class="order-tools">
          <input id="orderSearch" value="${escapeHtml(searchText)}" placeholder="Search SO, PO, TO, SKU, address" />
        </div>
        ${renderSelectedOrderActions()}
      </div>
      <div class="order-type-tabs">
        ${["SO", "PO", "TO"].map((type) => `<button class="${!searching && activeOrderType === type ? "active" : ""}" data-action="order-type-tab" data-type="${type}" type="button">${type}</button>`).join("")}
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
  if (subtitle) subtitle.textContent = searching ? "Search results across SO, PO, and TO." : `${orderTypeLabel(activeOrderType)} list`;
  tabs?.forEach((button) => button.classList.toggle("active", !searching && activeOrderType === button.dataset.type));
  if (list) list.innerHTML = renderOrderList();
  autoSavePlan();
}

function renderSelectedOrderActions() {
  const order = selectedOrder();
  if (!order) return "";
  const selected = selectedOrders();
  const label = selected.length > 1 ? `${selected.length} selected` : order.id;
  return `
    <div class="selected-order-actions">
      <span>${escapeHtml(label)}</span>
      <button data-action="open-group-modal" data-order="${order.id}" type="button">Group</button>
      <button data-action="open-split-modal" data-order="${order.id}" type="button">Split</button>
      ${canConsolidatePick(order) ? `<button data-action="open-consolidate-modal" data-order="${order.id}" type="button">Consolidate Pick</button>` : ""}
    </div>
  `;
}

function renderOrderCard(order) {
  const groupCount = groupCandidates(order).length + 1;
  const splitWarning = order.pallets > 20;
  const groupedCount = order.childOrders?.length || 0;
  const shortage = shortageQty(order);
  return `
    <article class="order-card ${selectedOrderIds.has(order.id) ? "selected" : ""}" draggable="true" data-order="${order.id}">
      <strong>${order.id} | ${escapeHtml(order.customer)}</strong>
      <span>${escapeHtml(movementText(order))}</span>
      <span>${order.windowStart}-${order.windowEnd} | ${orderFootprintPallets(order)} pos | ${formatLbs(orderWeightLbs(order))}</span>
      ${groupedCount ? `<span>Includes ${order.childOrders.join(", ")}</span>` : ""}
      <div class="chip-row">
        <span class="chip">${order.type}</span>
        ${groupedCount ? `<span class="chip">Grouped ${groupedCount}</span>` : groupCount > 1 ? `<span class="chip">Group ${groupCount}</span>` : ""}
        ${splitWarning ? `<span class="chip warn">Split suggested</span>` : ""}
        ${shortage ? `<span class="chip warn">${shortage} short</span>` : ""}
        ${canConsolidatePick(order) ? `<span class="chip">Conso Pick</span>` : ""}
        ${order.consolidation ? `<span class="chip">From ${order.consolidation.sourceYard}</span>` : ""}
      </div>
    </article>
  `;
}

function renderTruck(truck) {
  return `
    <article class="truck-row">
      <div class="truck-label">
        <div>
          <strong>${truck.plate}</strong>
          <span>${truck.driver} | ${truck.license} | ${formatLbs(truckCapacityLbs(truck))} cap.</span>
        </div>
        <button data-action="add-load" data-truck="${truck.id}" type="button">+ Load</button>
      </div>
      <div class="truck-timeline">
        ${truck.loads.map((load) => renderLoad(truck, load)).join("")}
        <div class="timeline-drop-zone" data-load-create="${truck.id}">Drop order here<br>to create new load</div>
      </div>
    </article>
  `;
}

function renderLoad(truck, load) {
  if (load.returnOnly) {
    return `
      <section class="load-block return-only">
        <div class="load-header">
          <button class="load-title" data-action="select-load" data-load="${load.id}" type="button">
            <strong>${load.name}</strong>
            <span>Auto added after full load</span>
          </button>
          <div class="load-header-actions">
            <span class="chip">Return</span>
            <button class="load-delete" data-action="delete-load" data-load="${load.id}" type="button">x</button>
          </div>
        </div>
        <div class="stop-list"><div class="empty-drop">Return to yard / ready for next load</div></div>
      </section>
    `;
  }
  const stats = loadStats(truck, load);
  const active = selectedLoadId === load.id;
  return `
    <section class="load-block ${stats.warningCount ? "warning" : ""} ${active ? "selected" : ""}">
      <div class="load-header">
        <button class="load-title" data-action="select-load" data-load="${load.id}" type="button">
          <strong>${load.name}${active ? " | Selected" : ""}</strong>
          <span>${formatLbs(stats.weightTotalLbs)}/${formatLbs(stats.capacityLbs)} | ${stats.footprintTotal} pos | Return ${stats.returnTrip}m | Finish ${timeText(stats.finish)}</span>
        </button>
        <div class="load-header-actions">
          <span class="chip ${stats.warningCount ? "warn" : ""}">${stats.warningCount ? `${stats.warningCount} warn` : "OK"}</span>
          <button class="load-delete" data-action="delete-load" data-load="${load.id}" type="button">x</button>
        </div>
      </div>
      <div class="stop-list" data-load="${load.id}">
        ${stats.fullLoad ? `<div class="return-load-marker">Full load: return trip added after last drop.</div>` : ""}
        ${load.stops.map((stop, index) => renderStop(stop, index, stats.rows[index])).join("") || `<div class="empty-drop">Drop order here</div>`}
      </div>
    </section>
  `;
}

function renderStop(stop, index, row) {
  const order = stopOrder(stop);
  if (!order) return "";
  const isPick = stop.type === "pick";
  return `
    <article class="stop-card compact ${isPick ? "pick" : ""} ${row?.warning ? "warning" : ""}" draggable="true" data-load="${stop.loadId}" data-stop="${stop.id}" data-order="${order.id}" data-index="${index}">
      <button class="stop-remove" data-action="remove-stop" data-stop="${stop.id}" type="button">x</button>
      <strong>${index + 1}. ${isPick ? `Pickup ${stop.location}` : order.id}</strong>
      <span>${isPick ? order.id : `Pickup ${timeText(Math.max((row?.arrival || 0) - order.travelMinutes, 0))}`}</span>
      <span>${isPick ? `Yard loading ${timeText(row?.arrival || 0)}` : `Est. delivery ${timeText(row?.arrival || 0)}`}</span>
    </article>
  `;
}

function renderLoadPreview() {
  if (!loadPreviewOpen) return "";
  const { truck, load } = selectedLoad();
  if (!truck || !load) return "";
  const stats = loadStats(truck, load);
  const firstOrder = load.stops.map(stopOrder).find(Boolean);
  const pickupLocations = load.stops.length ? uniquePickupLocations(load, truck) : [];
  const pickupPoint = pickupLocations.join(", ") || firstOrder?.pickupLocations?.[0] || truck.base;
  return `
    <aside class="load-preview-panel">
      <div class="load-preview-header">
        <div>
          <h2>${truck.plate} | ${load.name}</h2>
          <p>${formatLbs(stats.weightTotalLbs)}/${formatLbs(stats.capacityLbs)} | ${stats.footprintTotal} pallet positions | Pickup ${pickupPoint}</p>
        </div>
        <button data-action="close-load-preview" type="button">x</button>
      </div>
      <div class="load-preview-body">
        <section class="preview-section sequence-section">
          <div class="preview-section-title">
            <strong>Stop Sequence</strong>
            <span>Drag stops to reorder. Multiple pick/drop is allowed.</span>
          </div>
          <div class="preview-stop-list" data-load="${load.id}">
            ${load.stops.map((stop, index) => renderPreviewStop(stop, index, stats.rows[index])).join("") || `<div class="empty-drop">No assigned orders yet.</div>`}
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
            <div><span>Return trip</span><strong>${stats.returnTrip} min</strong></div>
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
        <button class="danger" data-action="delete-load" data-load="${load.id}" type="button">Delete Load</button>
        <button class="danger" data-action="clear-load" data-load="${load.id}" type="button">Clear Load</button>
      </div>
    </aside>
  `;
}

function renderPreviewStop(stop, index, row) {
  const order = stopOrder(stop);
  if (!order) return "";
  const label = stop.type === "pick" ? `${index + 1}. Pickup | ${stop.location}` : `${index + 1}. Drop | ${order.id}`;
  const sub = stop.type === "pick" ? `${order.id} stock pickup` : `${order.customer} | Est. ${timeText(row?.arrival || 0)}`;
  return `
    <article class="preview-stop ${stop.type}" draggable="true" data-load="${stop.loadId}" data-stop="${stop.id}" data-order="${order.id}" data-index="${index}">
      <button class="stop-remove" data-action="remove-stop" data-stop="${stop.id}" type="button">x</button>
      <strong>${label}</strong>
      <span>${escapeHtml(sub)}</span>
    </article>
  `;
}

function renderPreviewMap() {
  const pins = mapPins();
  const estimate = routeEstimates[selectedLoadId];
  return `
    <div class="google-map-preview" id="googleMapPreview">Loading map...</div>
    <div class="route-estimate-summary" id="routeEstimateSummary">
      ${estimate ? `<strong>${estimate.totalMinutes} min total</strong><span>${estimate.driveMinutes} min drive + ${estimate.stayMinutes} min loading/unloading</span>` : `<strong>Calculating route...</strong><span>Google travel time plus driver loading/unloading.</span>`}
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

function renderModal() {
  if (!modalType) return "";
  const order = orderById(modalOrderId) || selectedOrder();
  if (!order) return "";
  if (modalType === "group") {
    const selected = selectedOrders();
    const candidates = selected.length > 1 ? selected : orders.filter((item) => item.groupKey === order.groupKey);
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
  if (modalType === "split") {
    ensureSplitDraft(order);
    return `
      <div class="modal-backdrop show">
        <section class="dispatch-modal wide-modal">
          <div class="modal-header">
            <div>
              <h2>Split Order</h2>
              <p>${order.id} | ${orderFootprintPallets(order)} pos | ${formatLbs(orderWeightLbs(order))}</p>
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
                <span>Total pos</span>
                ${Array.from({ length: splitParts }).map((_, index) => `<span>Split ${index + 1}</span>`).join("")}
              </div>
              ${(order.items || []).map((item) => {
                const sku = item.sku;
                const values = splitDraft.items[sku] || [];
                const total = itemFootprint(item);
                const assigned = values.reduce((sum, value) => sum + Number(value || 0), 0);
                return `
                  <div class="split-row">
                    <strong>${escapeHtml(sku)}</strong>
                    <span>${total} pos${assigned !== total ? ` | ${total - assigned} left` : ""}</span>
                    ${Array.from({ length: splitParts }).map((_, index) => `
                      <input data-split-sku="${escapeHtml(sku)}" data-split-index="${index}" type="number" min="0" value="${values[index] || 0}" />
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
            <span class="muted">Load ${item.loadMinutes}m | Unload ${item.unloadMinutes}m</span>
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
        <input name="loadMinutes" placeholder="Load min" type="number" value="40" required />
        <input name="unloadMinutes" placeholder="Unload min" type="number" value="35" required />
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
  const { load } = findLoad(loadId);
  const order = orderById(orderId);
  if (!load || !order) return;
  let cleanInsertIndex = Number.isInteger(insertIndex) ? insertIndex : null;
  if (type === "drop") {
    const addedPickups = ensurePickupStops(load, order, cleanInsertIndex);
    if (Number.isInteger(cleanInsertIndex)) cleanInsertIndex += addedPickups;
  }
  const stopLocation = location || order.pickupLocations[0] || "3445";
  const existing = pullExistingStop(orderId, type, stopLocation);
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
  selectedOrderId = orderId;
  selectedLoadId = loadId;
}

function pullExistingStop(orderId, type, location) {
  for (const truck of trucks) {
    for (const load of truck.loads) {
      const index = load.stops.findIndex((stop) => {
        if (stop.orderId !== orderId || stop.type !== type) return false;
        return type !== "pick" || String(stop.location) === String(location);
      });
      if (index >= 0) {
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
  truck.loads = truck.loads.filter((item) => item.id !== loadId);
  if (selectedLoadId === loadId) {
    selectedLoadId = trucks.flatMap((item) => item.loads).find((item) => !item.returnOnly)?.id || trucks[0]?.loads[0]?.id || "";
    loadPreviewOpen = Boolean(selectedLoadId);
  }
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
  for (const item of order.items || []) {
    const total = itemFootprint(item);
    const base = Math.floor(total / splitParts);
    const remainder = total % splitParts;
    items[item.sku] = Array.from({ length: splitParts }).map((_, index) => base + (index < remainder ? 1 : 0));
  }
  splitDraft = { orderId: order.id, parts: splitParts, items };
}

function splitTotalsForPart(order, partIndex) {
  const items = (order.items || [])
    .map((item) => {
      const qty = Number(splitDraft.items[item.sku]?.[partIndex] || 0);
      if (!qty) return null;
      return { ...item, pallets: qty, layers: 0, splitQty: qty };
    })
    .filter(Boolean);
  const pallets = items.reduce((sum, item) => sum + Number(item.splitQty || 0), 0);
  return { items, pallets };
}

function splitOrder(orderId, parts = 2) {
  const order = orderById(orderId);
  if (!order || order.pallets <= 1) return;
  const cleanParts = Math.min(Math.max(Number(parts) || 2, 2), 10);
  const originalPallets = order.pallets;
  const insertAt = orders.findIndex((item) => item.id === order.id) + 1;
  orders.splice(orders.findIndex((item) => item.id === order.id), 1);
  const splits = Array.from({ length: cleanParts }).map((_, index) => {
    const totals = splitTotalsForPart(order, index);
    return {
      ...order,
      id: `${order.id}-S${index + 1}`,
      pallets: totals.pallets,
      layers: 0,
      items: totals.items,
      salesQty: totals.pallets * 100,
      weight: Math.round((order.weight / Math.max(orderFootprintPallets(order), 1)) * totals.pallets * 10) / 10,
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

function groupOrder(orderId) {
  const order = orderById(orderId);
  const selected = selectedOrders();
  const groupItems = selected.length > 1 ? selected : orders.filter((candidate) => candidate.groupKey === order?.groupKey);
  if (groupItems.length < 2) return;
  const grouped = {
    ...groupItems[0],
    id: `GRP-${groupItems.map((item) => item.id.replace(/\D/g, "").slice(-3)).join("-")}`,
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
    notes: `Grouped orders: ${groupItems.map((item) => item.id).join(", ")}`
  };
  const ids = new Set(groupItems.map((item) => item.id));
  const firstIndex = orders.findIndex((item) => ids.has(item.id));
  orders = orders.filter((item) => !ids.has(item.id));
  orders.splice(Math.max(firstIndex, 0), 0, grouped);
  selectedOrderId = grouped.id;
  selectedOrderIds = new Set([grouped.id]);
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
    dragged = { type: "order", orderId: orderCard.dataset.order };
    event.dataTransfer.setData("text/plain", orderCard.dataset.order);
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
      const load = { id: `${truck.id}-L${truck.loads.length + 1}`, name: `Load ${truck.loads.length + 1}`, stops: [] };
      truck.loads.push(load);
      addOrderToLoad(dragged.orderId, load.id);
    }
    dragged = null;
    return render();
  }
  if (!list) return;
  const targetLoadId = targetStop?.dataset.load || list.dataset.load;
  const targetLoad = findLoad(targetLoadId).load;
  const insertIndex = insertIndexFromDrop(event, targetStop, targetLoad);
  if (dragged.type === "order") {
    addOrderToLoad(dragged.orderId, targetLoadId, "drop", "", Number.isInteger(insertIndex) ? insertIndex : null);
    routeNotice = "";
  } else if (dragged.type === "stop") {
    const found = findStop(dragged.stopId);
    const target = findLoad(targetLoadId).load;
    if (found && target) {
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
    return render();
  }
  const button = event.target.closest("button");
  if (!button) {
    const orderCard = event.target.closest("[data-order]");
    if (orderCard) {
      selectedOrderId = orderCard.dataset.order;
      if (event.ctrlKey || event.metaKey) {
        if (selectedOrderIds.has(orderCard.dataset.order)) selectedOrderIds.delete(orderCard.dataset.order);
        else selectedOrderIds.add(orderCard.dataset.order);
        if (!selectedOrderIds.size) selectedOrderIds.add(orderCard.dataset.order);
      } else {
        selectedOrderIds = new Set([orderCard.dataset.order]);
      }
      return render();
    }
  }
  if (!button) return;
  const action = button.dataset.action;
  if (button.dataset.order) {
    selectedOrderId = button.dataset.order;
    if (!selectedOrderIds.has(button.dataset.order)) selectedOrderIds = new Set([button.dataset.order]);
  }
  if (action === "open-group-modal") {
    modalType = "group";
    modalOrderId = button.dataset.order;
  }
  if (action === "open-split-modal") {
    modalType = "split";
    modalOrderId = button.dataset.order;
    splitParts = Math.max(2, Math.ceil((orderById(button.dataset.order)?.pallets || 2) / 10));
    ensureSplitDraft(orderById(button.dataset.order), true);
  }
  if (action === "open-consolidate-modal") {
    modalType = "consolidate";
    modalOrderId = button.dataset.order;
  }
  if (action === "order-type-tab") {
    activeOrderType = button.dataset.type;
    searchText = "";
    selectedOrderIds = new Set();
    selectedOrderId = openOrders()[0]?.id || selectedOrderId;
    if (selectedOrderId) selectedOrderIds.add(selectedOrderId);
  }
  if (action === "confirm-group") {
    groupOrder(button.dataset.order);
    modalType = "";
    modalOrderId = "";
  }
  if (action === "confirm-split") {
    splitOrder(button.dataset.order, splitParts);
    modalType = "";
    modalOrderId = "";
  }
  if (action === "confirm-consolidate") {
    consolidatePick(button.dataset.order, button.dataset.yard);
    modalType = "";
    modalOrderId = "";
  }
  if (action === "delete-load") {
    const { load } = findLoad(button.dataset.load);
    if (!load) return render();
    if (load.stops.length) {
      modalType = "delete-load";
      modalLoadId = load.id;
    } else {
      deleteLoad(load.id);
    }
  }
  if (action === "confirm-delete-load") {
    deleteLoad(button.dataset.load);
    modalType = "";
    modalLoadId = "";
  }
  if (action === "select-load") {
    selectedLoadId = button.dataset.load;
    loadPreviewOpen = true;
  }
  if (action === "close-load-preview") loadPreviewOpen = false;
  if (action === "clear-load") {
    const { load } = findLoad(button.dataset.load);
    if (load) load.stops = [];
  }
  if (action === "add-load") {
    const truck = trucks.find((item) => item.id === button.dataset.truck);
    if (truck) {
      const load = { id: `${truck.id}-L${truck.loads.length + 1}`, name: `Load ${truck.loads.length + 1}`, stops: [] };
      truck.loads.push(load);
      selectedLoadId = load.id;
    }
  }
  if (action === "remove-stop") {
    const found = findStop(button.dataset.stop);
    if (found) {
      const warning = stopRemovalWarning(found);
      if (warning) routeNotice = `Cannot remove stop: ${warning}`;
      else {
        found.stops.splice(found.index, 1);
        routeNotice = "";
      }
    }
  }
  if (action === "optimize-route") optimizeSelectedRoute();
  if (action === "support-tab") supportTab = button.dataset.tab;
  if (action === "refresh-orders") {
    searchText = "";
  }
  render();
});

app.addEventListener("input", (event) => {
  if (event.target?.id === "splitParts") {
    splitParts = Math.min(Math.max(Number(event.target.value) || 2, 2), 10);
    ensureSplitDraft(orderById(modalOrderId), true);
    return render();
  }
  if (event.target?.dataset?.splitSku) {
    const sku = event.target.dataset.splitSku;
    const index = Number(event.target.dataset.splitIndex);
    if (!splitDraft.items[sku]) splitDraft.items[sku] = Array.from({ length: splitParts }).fill(0);
    splitDraft.items[sku][index] = Math.max(0, Number(event.target.value) || 0);
    return;
  }
  if (event.target?.id !== "orderSearch") return;
  searchText = event.target.value;
  refreshOrderPoolForSearch();
});

app.addEventListener("change", (event) => {
  if (event.target?.id !== "loadStartTime") return;
  const { load } = findLoad(event.target.dataset.load);
  if (load) {
    load.start = event.target.value;
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
  const itemRows = (order.items || []).map((item) => `
    <div>
      <b>${escapeHtml(item.sku)}</b>
      <span>${item.pallets ? `${item.pallets} PLT` : ""}${item.layers ? ` ${item.layers} LYR` : ""}</span>
    </div>
  `).join("");
  tooltip.innerHTML = `
    <strong>${order.id} | ${escapeHtml(order.customer)}</strong>
    <span>${escapeHtml(order.address)}</span>
    <span>${orderUnitText(order)} | ${orderFootprintPallets(order)} pos | ${formatLbs(orderWeightLbs(order))} | ${order.windowStart}-${order.windowEnd}</span>
    ${order.consolidation ? `<span>Consolidate ${order.consolidation.shortageQty} from ${order.consolidation.sourceYard} to ${order.consolidation.targetYard}</span>` : ""}
    <span>${escapeHtml(order.notes)}</span>
    ${itemRows ? `<div class="tooltip-items">${itemRows}</div>` : ""}
  `;
}

app.addEventListener("mouseover", showOrderTooltip);
app.addEventListener("pointerover", showOrderTooltip);

app.addEventListener("mousemove", (event) => {
  const tooltip = document.getElementById("orderTooltip");
  if (!tooltip?.classList.contains("tooltip")) return;
  tooltip.style.left = `${Math.min(event.clientX + 16, window.innerWidth - 330)}px`;
  tooltip.style.top = `${Math.min(event.clientY + 16, window.innerHeight - 180)}px`;
});

function hideOrderTooltip(event) {
  if (!event.target.closest("[data-order]")) return;
  const tooltip = document.getElementById("orderTooltip");
  tooltip.className = "";
  tooltip.innerHTML = "";
}

app.addEventListener("mouseout", hideOrderTooltip);
app.addEventListener("pointerout", hideOrderTooltip);

app.addEventListener("submit", (event) => {
  const form = event.target.closest("form");
  if (!form) return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  if (form.dataset.form === "driver") {
    drivers.push({
      name: data.name,
      license: data.license,
      number: data.number,
      login: data.login,
      loadMinutes: Number(data.loadMinutes || 40),
      unloadMinutes: Number(data.unloadMinutes || 35)
    });
  }
  if (form.dataset.form === "truck") {
    fleet.push({ plate: data.plate, capacityLbs: Number(data.capacityLbs || 48000) });
    trucks.push({
      id: `T${trucks.length + 1}`,
      plate: data.plate,
      capacityLbs: Number(data.capacityLbs || 48000),
      driver: "Unassigned",
      license: "-",
      base: "3445",
      start: "08:00",
      loadMinutes: 40,
      unloadMinutes: 35,
      loads: [{ id: `T${trucks.length + 1}-L1`, name: "Load 1", stops: [] }]
    });
  }
  render();
});

async function initDispatch() {
  await loadDispatchConfig();
  restoreSavedPlan();
  render();
}

initDispatch();

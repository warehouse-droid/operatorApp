const dispatchLoadedApp = document.getElementById("dispatchLoadedApp");
const loadedT = (key, fallback) => window.MBBS_I18N?.t(key, fallback) || fallback;
const loadedSalesHost = window.location.pathname === "/sales/in-outbound-record"
  || window.location.pathname.startsWith("/sales/in-outbound-record/");
const loadedApiBase = loadedSalesHost ? "/api/sales/in-outbound-records" : "/api/dispatch/loaded-orders";
const loadedHome = loadedSalesHost ? "/sales" : "/dispatch";
const loadedRoles = loadedSalesHost ? ["sales", "admin"] : ["dispatcher", "admin"];
const LOADED_YARDS = [
  { locationId: 1, yardCode: "3445" },
  { locationId: 28, yardCode: "2967" },
  { locationId: 15, yardCode: "12441" },
  { locationId: 26, yardCode: "150" }
];

function loadedToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
}

const loadedDefaultDate = loadedToday();

const loadedState = {
  operator: null,
  drivers: [],
  orders: [],
  searchResults: [],
  detail: null,
  selectedKey: "",
  search: "",
  itemSearch: "",
  direction: localStorage.getItem("mbbs.dispatch.loaded.direction") === "inbound" ? "inbound" : "outbound",
  typeByDirection: {
    inbound: ["purchase_order", "transfer_order", "co_order"].includes(localStorage.getItem("mbbs.dispatch.loaded.inboundType"))
      ? localStorage.getItem("mbbs.dispatch.loaded.inboundType")
      : "purchase_order",
    outbound: ["sales_order", "transfer_order", "co_order", "vrma_order", "custom_order"].includes(localStorage.getItem("mbbs.dispatch.loaded.outboundType"))
      ? localStorage.getItem("mbbs.dispatch.loaded.outboundType")
      : "sales_order"
  },
  filters: {
    from: loadedDefaultDate,
    to: loadedDefaultDate,
    yard: localStorage.getItem("mbbs.dispatch.loaded.yard") || "all",
    driver: localStorage.getItem("mbbs.dispatch.loaded.driver") || "all"
  },
  searchLoading: false,
  searchSeq: 0,
  busy: "",
  error: ""
};

function loadedEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function loadedFormatDate(value) {
  return value ? (window.MBBS_I18N?.displayDateTime(value) || String(value)) : "";
}

function loadedValue(value) {
  return value === null || value === undefined ? "" : String(value);
}

function loadedOrderKey(order) {
  return `${order.direction}:${order.order_type}:${order.order_id}`;
}

function loadedField(source, ...keys) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source?.[key] !== null) return source[key];
  }
  return null;
}

function loadedNumber(source, keys, fallback = 0) {
  const value = loadedField(source, ...keys);
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function loadedBoolean(source, ...keys) {
  const value = loadedField(source, ...keys);
  return value === true || value === 1 || String(value || "").toLowerCase() === "true";
}

function loadedOperatorRoles(operator = loadedState.operator) {
  return new Set([...(operator?.roles || []), operator?.role]
    .map((role) => String(role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_"))
    .filter(Boolean));
}

function loadedAllowedYards() {
  if (!loadedSalesHost || loadedOperatorRoles().has("admin")) return LOADED_YARDS;
  const allowed = new Set((loadedState.operator?.yardLocationIds || loadedState.operator?.yard_location_ids || []).map(Number));
  return LOADED_YARDS.filter((yard) => allowed.has(yard.locationId));
}

const DISPATCH_YARD_TYPES = {
  inbound: ["purchase_order", "transfer_order", "co_order"],
  outbound: ["sales_order", "transfer_order", "co_order", "vrma_order", "custom_order"]
};

function selectedMovementType() {
  return loadedState.typeByDirection[loadedState.direction];
}

function movementTypeCode(orderType) {
  return {
    sales_order: "SO",
    transfer_order: "TO",
    purchase_order: "PO",
    co_order: "CO",
    vrma_order: "VRMA",
    custom_order: "Custom"
  }[orderType] || String(orderType || "").toUpperCase();
}

function movementTypeLabel(orderType) {
  return {
    sales_order: loadedT("yard.salesOrder", "Sales Order"),
    transfer_order: loadedT("yard.transferOrder", "Transfer Order"),
    purchase_order: loadedT("yard.purchaseOrder", "Purchase Order"),
    co_order: loadedT("yard.coOrder", "CO Order"),
    vrma_order: "VRMA",
    custom_order: loadedT("dispatch.customOrders", "Custom Order")
  }[orderType] || orderType;
}

function movementQuantity(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return loadedEscape(loadedValue(value));
  return numeric.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function movementMixedUnits(line) {
  const processedQty = Number(line.processed_qty || 0);
  const definitions = [
    { label: "PLT", direct: "processed_pallet_qty", conversion: "to_plt" },
    { label: "LYR", direct: "processed_layer_qty", conversion: "to_lyr" },
    { label: "SEC", direct: "processed_section_qty", conversion: "to_sec" },
    { label: "PCS", direct: "processed_piece_qty", conversion: "to_pcs" }
  ].map((definition) => ({
    ...definition,
    directQty: Math.max(0, Number(line[definition.direct] || 0)),
    conversionQty: Math.max(0, Number(line[definition.conversion] || 0))
  }));
  const hasConversion = definitions.some((definition) => definition.conversionQty > 0);
  const directSalesQty = definitions.reduce(
    (sum, definition) => sum + (definition.directQty * definition.conversionQty),
    0
  );
  const useDirect = definitions.some((definition) => definition.directQty > 0 && definition.conversionQty > 0)
    && Math.abs(directSalesQty - processedQty) <= 0.1;
  if (useDirect) {
    return {
      hasConversion,
      remainder: 0,
      units: definitions
        .filter((definition) => definition.directQty > 0 && definition.conversionQty > 0)
        .map((definition) => ({ label: definition.label, value: definition.directQty }))
    };
  }
  let remainder = Math.max(0, processedQty);
  const units = [];
  definitions.forEach((definition) => {
    if (definition.conversionQty <= 0 || remainder <= 0) return;
    const value = Math.floor((remainder / definition.conversionQty) + 0.000001);
    if (value <= 0) return;
    units.push({ label: definition.label, value });
    remainder = Math.max(0, remainder - (value * definition.conversionQty));
  });
  return {
    hasConversion,
    units,
    remainder: remainder <= 0.1 ? 0 : Math.round(remainder * 1000000) / 1000000
  };
}

function renderMovementQuantityEquation(line) {
  const salesUom = line.processed_uom || line.unit || "";
  const mixed = movementMixedUnits(line);
  const salesTerm = `<span class="dispatch-movement-quantity-term sales"><b>${movementQuantity(line.processed_qty)}</b><small>${loadedEscape(salesUom)}</small></span>`;
  if (!mixed.units.length) {
    return `<div class="dispatch-movement-quantity-equation single">${salesTerm}</div>${!mixed.hasConversion ? `<small class="dispatch-converted-uom-empty">${loadedT("yard.noConversion", "No item conversion")}</small>` : ""}`;
  }
  const terms = [
    ...mixed.units.map((unit) => `<span class="dispatch-movement-quantity-term"><b>${movementQuantity(unit.value)}</b><small>${unit.label}</small></span>`),
    ...(mixed.remainder > 0 ? [`<span class="dispatch-movement-quantity-term remainder"><b>${movementQuantity(mixed.remainder)}</b><small>${loadedEscape(salesUom)}</small></span>`] : [])
  ];
  return `<div class="dispatch-movement-quantity-equation">${terms.join('<i class="dispatch-movement-quantity-join">&amp;</i>')}<i class="dispatch-movement-quantity-equals">=</i>${salesTerm}</div>`;
}

function loadedFilterQuery() {
  return new URLSearchParams({
    from: loadedState.filters.from || loadedToday(),
    to: loadedState.filters.to || loadedState.filters.from || loadedToday(),
    yard: loadedState.filters.yard || "all",
    driver: loadedState.filters.driver || "all",
    direction: loadedState.direction,
    orderType: selectedMovementType()
  });
}

function loadedSearchQuery() {
  const params = new URLSearchParams({
    from: "2000-01-01",
    to: "2099-12-31",
    yard: "all",
    driver: "all"
  });
  if (loadedState.search.trim()) params.set("search", loadedState.search.trim());
  if (loadedState.itemSearch.trim()) params.set("itemSearch", loadedState.itemSearch.trim());
  return params;
}

function loadedSearchActive() {
  return loadedState.search.trim().length > 0 || loadedState.itemSearch.trim().length > 0;
}

function visibleLoadedOrders() {
  return loadedSearchActive() ? loadedState.searchResults : loadedState.orders;
}

function selectedLoadedOrder() {
  return visibleLoadedOrders().find((order) => loadedOrderKey(order) === loadedState.selectedKey)
    || loadedState.orders.find((order) => loadedOrderKey(order) === loadedState.selectedKey)
    || null;
}

async function loadedRequest(path) {
  const response = await fetch(path);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    if (response.status === 403 && payload?.redirect) window.location.replace(payload.redirect);
    throw new Error(payload?.error || text || response.statusText || "Request failed");
  }
  return payload;
}

async function loadSelectedDetail() {
  loadedState.detail = null;
  const selected = selectedLoadedOrder();
  if (!selected) return;
  const params = loadedSearchActive() ? loadedSearchQuery() : loadedFilterQuery();
  params.set("direction", selected.direction);
  params.set("orderType", selected.order_type);
  params.set("orderId", selected.order_id);
  loadedState.detail = await loadedRequest(`${loadedApiBase}/detail?${params.toString()}`);
}

async function loadLoadedDrivers() {
  const drivers = await loadedRequest(`${loadedApiBase}/drivers`);
  loadedState.drivers = Array.isArray(drivers) ? drivers : [];
  const available = new Set(loadedState.drivers.map((driver) => String(driver.login || "")));
  if (loadedState.filters.driver !== "all" && !available.has(String(loadedState.filters.driver))) {
    loadedState.filters.driver = "all";
    localStorage.setItem("mbbs.dispatch.loaded.driver", "all");
  }
}

async function loadLoadedOrders({ keepSelection = false } = {}) {
  loadedState.orders = await loadedRequest(`${loadedApiBase}?${loadedFilterQuery().toString()}`);
  if (!keepSelection || !loadedState.orders.some((order) => loadedOrderKey(order) === loadedState.selectedKey)) {
    loadedState.selectedKey = loadedState.orders[0] ? loadedOrderKey(loadedState.orders[0]) : "";
  }
  loadedState.detail = null;
  updateLoadedPanels();
  await loadSelectedDetail();
}

async function loadLoadedSearch() {
  const term = loadedState.search.trim();
  const itemTerm = loadedState.itemSearch.trim();
  const seq = ++loadedState.searchSeq;
  if (!term && !itemTerm) {
    loadedState.searchResults = [];
    loadedState.searchLoading = false;
    if (!loadedState.orders.some((order) => loadedOrderKey(order) === loadedState.selectedKey)) {
      loadedState.selectedKey = loadedState.orders[0] ? loadedOrderKey(loadedState.orders[0]) : "";
    }
    await loadSelectedDetail();
    return;
  }
  loadedState.searchLoading = true;
  updateLoadedPanels();
  const results = await loadedRequest(`${loadedApiBase}?${loadedSearchQuery().toString()}`);
  if (seq !== loadedState.searchSeq) return;
  loadedState.searchResults = results;
  loadedState.searchLoading = false;
  if (!results.some((order) => loadedOrderKey(order) === loadedState.selectedKey)) {
    loadedState.selectedKey = results[0] ? loadedOrderKey(results[0]) : "";
  }
  loadedState.detail = null;
  updateLoadedPanels();
  await loadSelectedDetail();
}

function loadedPhotoSrc(value, { thumbnail = false } = {}) {
  const ref = String(value || "");
  if (!ref.startsWith("r2://")) return ref;
  const params = new URLSearchParams({
    ref,
    token: dispatchAuthToken || ""
  });
  if (thumbnail) params.set("variant", "thumbnail");
  return `/api/photo-upload/preview?${params.toString()}`;
}

function openLoadedPhoto(photoRef, label) {
  const modal = document.createElement("div");
  modal.className = "photo-lightbox";
  modal.innerHTML = `<div class="photo-lightbox-panel" role="dialog" aria-modal="true" aria-label="${loadedEscape(label)}">
    <button class="photo-lightbox-close" data-action="close-loaded-photo" type="button">×</button>
    <img src="${loadedEscape(loadedPhotoSrc(photoRef))}" alt="${loadedEscape(label)}" />
  </div>`;
  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target.closest("[data-action='close-loaded-photo']")) modal.remove();
  });
  document.body.appendChild(modal);
}

async function downloadLoadedCsv() {
  const response = await fetch(`${loadedApiBase}/export.csv?${loadedFilterQuery().toString()}`);
  if (!response.ok) throw new Error(await response.text());
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = `in-outbound-record-${loadedState.filters.from}-${loadedState.filters.to}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function renderLoadedList() {
  const orders = visibleLoadedOrders();
  return `
    <div class="dispatch-loaded-list-head"><strong>${orders.length}</strong><span>${loadedSearchActive() ? loadedT("yard.globalResults", "results across all directions and order types") : `${movementTypeCode(selectedMovementType())} · ${loadedT("yard.processed", "processed")}`}</span></div>
    ${loadedState.searchLoading ? `<div class="dispatch-loaded-notice">${loadedT("control.searching", "Searching...")} ${loadedT("yard.searchingHelp", "Checking all processed yard movements across every direction, type, yard, and date.")}</div>` : ""}
    ${orders.map((order) => {
      const driverOnly = loadedBoolean(order, "driver_only", "driverOnly");
      const yardActivities = loadedNumber(order, ["yard_activity_count", "yardActivityCount"], loadedNumber(order, ["process_count", "processCount"]));
      const driverActivities = loadedNumber(order, ["driver_activity_count", "driverActivityCount"]);
      const yardPhotos = loadedNumber(order, ["yard_photo_count", "yardPhotoCount"], loadedNumber(order, ["photo_count", "photoCount"]));
      const driverPhotos = loadedNumber(order, ["driver_photo_count", "driverPhotoCount"]);
      const deliveryAt = loadedField(order, "delivery_at", "deliveryAt");
      const lastActivityAt = loadedField(order, "last_activity_at", "lastActivityAt", "last_processed_at", "lastProcessedAt");
      return `<button class="dispatch-loaded-order ${loadedOrderKey(order) === loadedState.selectedKey ? "active" : ""}" data-action="select-loaded-order" data-key="${loadedEscape(loadedOrderKey(order))}" type="button">
        <div class="dispatch-movement-card-head"><strong>${loadedEscape(order.tranid || order.order_id)}</strong><span class="dispatch-movement-badges"><i class="dispatch-movement-badge ${loadedEscape(order.direction)}">${loadedT(`yard.${order.direction}`, order.direction)}</i><i class="dispatch-movement-badge type">${movementTypeCode(order.order_type)}</i>${driverOnly ? `<i class="dispatch-movement-badge type">${loadedT("yard.driverOnly", "Driver only")}</i>` : ""}</span></div>
        <span>${loadedEscape(order.yard_location || loadedT("common.yard", "Yard"))} | ${loadedEscape(order.movement_status || (driverOnly ? loadedT("yard.driverComplete", "Driver complete") : loadedT("yard.processed", "Processed")))}</span>
        <em>${deliveryAt ? `${loadedT("yard.deliveryTime", "Delivered")} ${loadedFormatDate(deliveryAt)}` : loadedFormatDate(lastActivityAt)} | ${loadedT("yard.yardActivities", "Yard")} ${yardActivities} · ${loadedT("yard.driverActivities", "Driver")} ${driverActivities} | ${yardPhotos + driverPhotos} ${loadedT("common.photos", "photos")}</em>
        ${order.party ? `<small>${loadedEscape(order.party)}</small>` : ""}
      </button>`;
    }).join("") || (!loadedState.searchLoading ? `<div class="dispatch-loaded-notice">${loadedSearchActive() ? loadedT("yard.noSearchResults", "No order matched either search across all dates, yards, directions, and order types.") : loadedT("yard.noFilterResults", "No processed movement matched this direction, order type, date, and yard.")}</div>` : "")}
  `;
}

function loadedHumanLabel(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function loadedDetailValue(value) {
  if (Array.isArray(value)) {
    return value.some((item) => item && typeof item === "object")
      ? JSON.stringify(value)
      : value.filter(Boolean).join(", ");
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return loadedValue(value);
}

function renderDriverJobDetails(record) {
  const details = loadedField(record, "job_details", "jobDetails");
  if (!details || typeof details !== "object" || Array.isArray(details)) return "";
  const hiddenKeys = new Set(["schemaVersion", "orders", "orderTypes", "lineRowIds", "requiredPhotos"]);
  const rows = Object.entries(details)
    .filter(([key]) => !hiddenKeys.has(key))
    .map(([key, value]) => [key, loadedDetailValue(value)])
    .filter(([, value]) => value);
  const orderRows = (Array.isArray(details.orders) ? details.orders : []).map((order) => {
    const items = (Array.isArray(order?.items) ? order.items : [])
      .map((item) => item?.sku || item?.itemName)
      .filter(Boolean);
    const label = [order?.orderRef, order?.party].filter(Boolean).join(" · ");
    return [label, items.length ? `${items.length} item(s): ${items.join(", ")}` : ""].filter(Boolean).join(" — ");
  }).filter(Boolean);
  return [
    ...rows.map(([key, value]) => `<em>${loadedEscape(loadedHumanLabel(key))}: ${loadedEscape(value)}</em>`),
    ...orderRows.map((value) => `<em>${loadedEscape(value)}</em>`)
  ].join("");
}

function loadedStopTypeLabel(value) {
  const stopType = String(value || "").trim().toLowerCase();
  if (stopType === "pickup") return loadedT("yard.pickupStop", "Pickup stop");
  if (stopType === "dropoff") return loadedT("yard.dropoffStop", "Delivery stop");
  if (stopType === "travel") return loadedT("yard.travelStop", "Travel");
  if (stopType === "truck_switch") return loadedT("yard.truckSwitch", "Truck switch");
  return loadedHumanLabel(stopType || loadedT("yard.driverActivity", "Driver activity"));
}

function renderDriverRecords(records = []) {
  if (!records.length) return "";
  return `<section class="dispatch-loaded-photos">
    <h2>${loadedT("yard.driverActivities", "Driver activity")}</h2>
    <div class="dispatch-loaded-lines">
      ${records.map((record) => {
        const driverName = loadedField(record, "driver_name", "driverName", "driver_login", "driverLogin") || loadedT("yard.driver", "Driver");
        const driverLogin = loadedField(record, "driver_login", "driverLogin");
        const truckPlate = loadedField(record, "truck_plate", "truckPlate");
        const loadName = loadedField(record, "load_name", "loadName");
        const stopType = loadedField(record, "stop_type", "stopType");
        const status = loadedField(record, "status") || "";
        const startedAt = loadedField(record, "started_at", "startedAt");
        const completedAt = loadedField(record, "completed_at", "completedAt");
        const photoCount = loadedNumber(record, ["photo_count", "photoCount"]);
        return `<article class="dispatch-loaded-line">
          <div>
            <strong>${loadedEscape(driverName)}</strong>
            ${driverLogin && String(driverLogin) !== String(driverName) ? `<span>${loadedEscape(driverLogin)}</span>` : ""}
            <span>${loadedEscape(loadedStopTypeLabel(stopType))}${status ? ` · ${loadedEscape(status)}` : ""}</span>
            ${truckPlate ? `<em>${loadedT("yard.truck", "Truck")}: ${loadedEscape(truckPlate)}</em>` : ""}
            ${loadName ? `<em>${loadedT("yard.load", "Load")}: ${loadedEscape(loadName)}</em>` : ""}
            ${renderDriverJobDetails(record)}
          </div>
          <div class="dispatch-loaded-qty">
            <strong>${completedAt ? `${loadedT("yard.completedAt", "Completed")} ${loadedFormatDate(completedAt)}` : loadedT("yard.notCompleted", "Not completed")}</strong>
            ${startedAt ? `<small>${loadedT("yard.startedAt", "Started")} ${loadedFormatDate(startedAt)}</small>` : ""}
            <small>${photoCount} ${loadedT("common.photos", "photos")}</small>
          </div>
        </article>`;
      }).join("")}
    </div>
  </section>`;
}

function renderLoadedPhotoSection(title, photos = [], source = "yard") {
  const visiblePhotos = photos.filter((photo) => loadedField(photo, "photo_data_url", "photoDataUrl"));
  return `<section class="dispatch-loaded-photos"><h2>${loadedEscape(title)}</h2><div class="dispatch-loaded-photo-grid">
    ${visiblePhotos.map((photo) => {
      const photoRef = loadedField(photo, "photo_data_url", "photoDataUrl");
      const driverName = loadedField(photo, "driver_name", "driverName", "driver_login", "driverLogin");
      const truckPlate = loadedField(photo, "truck_plate", "truckPlate");
      const stopType = loadedField(photo, "stop_type", "stopType");
      const createdAt = loadedField(photo, "created_at", "createdAt");
      const sourceLabel = source === "driver"
        ? `${driverName || loadedT("yard.driver", "Driver")}${stopType ? ` · ${loadedStopTypeLabel(stopType)}` : ""}`
        : loadedT("yard.yardActivityPhoto", "Yard activity");
      const photoLabel = `${sourceLabel} ${loadedField(photo, "id") || ""}`.trim();
      return `<figure>
        <button class="dispatch-loaded-photo" data-action="open-loaded-photo" data-photo-ref="${loadedEscape(photoRef)}" data-photo-label="${loadedEscape(photoLabel)}" type="button"><img src="${loadedEscape(loadedPhotoSrc(photoRef, { thumbnail: true }))}" loading="lazy" decoding="async" alt="${loadedEscape(photoLabel)}" /></button>
        <figcaption>${loadedEscape(sourceLabel)}${truckPlate ? ` · ${loadedT("yard.truck", "Truck")} ${loadedEscape(truckPlate)}` : ""}${createdAt ? `<br>${loadedFormatDate(createdAt)}` : ""}</figcaption>
      </figure>`;
    }).join("") || `<div class="dispatch-loaded-notice">${loadedT("common.noPhoto", "No photo")}</div>`}
  </div></section>`;
}

function renderLoadedDetail() {
  if (!loadedState.detail) return `<div class="dispatch-loaded-empty"><strong>${loadedT("common.selectOrder", "Select an order")}</strong><span>${loadedT("yard.selectMovementHelp", "Yard processing, driver delivery details, timestamps, and photo proof will show here.")}</span></div>`;
  const { order, lines = [], photos = [] } = loadedState.detail;
  const driverRecords = loadedState.detail.driverRecords || loadedState.detail.driver_records || [];
  const driverPhotos = loadedState.detail.driverPhotos || loadedState.detail.driver_photos || [];
  const driverOnly = loadedBoolean(order, "driver_only", "driverOnly");
  const yardActivities = loadedNumber(order, ["yard_activity_count", "yardActivityCount"], loadedNumber(order, ["process_count", "processCount"]));
  const driverActivities = loadedNumber(order, ["driver_activity_count", "driverActivityCount"], driverRecords.length);
  const deliveryAt = loadedField(order, "delivery_at", "deliveryAt");
  const firstActivityAt = loadedField(order, "first_activity_at", "firstActivityAt", "first_processed_at", "firstProcessedAt");
  const lastActivityAt = loadedField(order, "last_activity_at", "lastActivityAt", "last_processed_at", "lastProcessedAt");
  const activityRange = [...new Set([firstActivityAt, lastActivityAt].filter(Boolean))].map(loadedFormatDate).filter(Boolean).join(" → ");
  const route = [order.source_location, order.destination_location].filter(Boolean).join(" → ");
  return `
    <div class="dispatch-loaded-detail-head">
      <div><div class="dispatch-movement-detail-title"><h2>${loadedEscape(order.tranid || order.order_id)}</h2><span class="dispatch-movement-badges"><i class="dispatch-movement-badge ${loadedEscape(order.direction)}">${loadedT(`yard.${order.direction}`, order.direction)}</i><i class="dispatch-movement-badge type">${movementTypeCode(order.order_type)}</i>${driverOnly ? `<i class="dispatch-movement-badge type">${loadedT("yard.driverOnly", "Driver only")}</i>` : ""}</span></div><p>${loadedEscape(movementTypeLabel(order.order_type))} | ${loadedEscape(order.yard_location || "")} | ${loadedEscape(order.movement_status || (driverOnly ? loadedT("yard.driverComplete", "Driver complete") : loadedT("yard.processed", "Processed")))}</p>${route ? `<p>${loadedEscape(route)}</p>` : ""}${order.party ? `<p>${loadedEscape(order.party)}</p>` : ""}${deliveryAt ? `<p><strong>${loadedT("yard.deliveryTime", "Delivered")}:</strong> ${loadedFormatDate(deliveryAt)}</p>` : ""}${activityRange ? `<p>${loadedT("yard.activityRange", "Activity")}: ${activityRange}</p>` : ""}</div>
      <strong>${lines.length} ${loadedT("control.lines", "line(s)")} · ${loadedT("yard.yardActivities", "Yard")} ${yardActivities} · ${loadedT("yard.driverActivities", "Driver")} ${driverActivities}</strong>
    </div>
    <div class="dispatch-loaded-lines">${lines.map((line) => `<div class="dispatch-loaded-line">
      <div><strong>${loadedEscape(line.sku || line.item_name || "")}</strong><span>${loadedEscape(line.item_name || "")}</span>${line.item_description ? `<em>${loadedEscape(line.item_description)}</em>` : ""}</div>
      <div class="dispatch-loaded-qty">${renderMovementQuantityEquation(line)}<small>${loadedEscape(line.location || order.yard_location || "")}</small></div>
    </div>`).join("") || `<div class="dispatch-loaded-notice">${driverOnly ? loadedT("yard.noYardLinesYet", "No yard processing record yet. Driver delivery data is shown below.") : loadedT("yard.noProcessedLines", "No processed lines")}</div>`}</div>
    ${renderDriverRecords(driverRecords)}
    ${!driverOnly || photos.length ? renderLoadedPhotoSection(loadedT("yard.yardPhotos", "Yard photos"), photos, "yard") : ""}
    ${driverRecords.length || driverPhotos.length || driverOnly ? renderLoadedPhotoSection(loadedT("yard.driverDeliveryPhotos", "Driver delivery photos"), driverPhotos, "driver") : ""}
  `;
}

function updateLoadedPanels() {
  const list = document.getElementById("dispatchLoadedList");
  if (list) list.innerHTML = renderLoadedList();
  const detail = document.getElementById("dispatchLoadedDetail");
  if (detail) detail.innerHTML = renderLoadedDetail();
}

function renderDispatchLoaded() {
  const operator = loadedState.operator || {};
  const typeTabs = DISPATCH_YARD_TYPES[loadedState.direction] || [];
  const yardOptions = loadedAllowedYards();
  const driverOptions = loadedState.drivers;
  const homeLabel = loadedSalesHost ? loadedT("sales.menu", "Sales Menu") : loadedT("dispatch.menu", "Dispatch Menu");
  dispatchLoadedApp.innerHTML = `
    <header class="dispatch-topbar"><div><p>${loadedSalesHost ? "MBBS Operation" : "MBBS Transportation"}</p><h1>${loadedT("control.loadedExportTitle", "In/Outbound Record")}</h1></div><div class="topbar-language">${window.MBBS_I18N?.toggleHtml() || ""}</div><div class="topbar-actions"><span class="dispatch-user">${loadedEscape(operator.display_name || operator.username || "")}</span><button onclick="location.href='${loadedHome}'" type="button">${homeLabel}</button><button onclick="dispatchLogout()" type="button">${loadedT("common.logout", "Logout")}</button></div></header>
    <section class="dispatch-loaded-page">
      ${loadedState.error ? `<div class="dispatch-loaded-error">${loadedEscape(loadedState.error)}</div>` : ""}
      <aside class="dispatch-loaded-left panel">
        <div class="dispatch-loaded-searches"><label><span>${loadedT("control.orderSearch", "Order Search")}</span><input id="dispatchLoadedSearch" placeholder="${loadedT("yard.orderSearchPlaceholder", "Order / party / location")}" value="${loadedEscape(loadedState.search)}" /></label><label><span>${loadedT("yard.itemSearch", "Item Search")}</span><input id="dispatchLoadedItemSearch" placeholder="${loadedT("yard.itemSearchPlaceholder", "SKU / item / description")}" value="${loadedEscape(loadedState.itemSearch)}" /></label></div>
        <div class="dispatch-yard-tabs">
          <div class="dispatch-yard-direction-tabs" role="tablist" aria-label="${loadedT("yard.direction", "Direction")}">${["inbound", "outbound"].map((direction) => `<button class="${loadedState.direction === direction && !loadedSearchActive() ? "active" : ""}" data-action="yard-direction" data-direction="${direction}" type="button">${loadedT(`yard.${direction}`, direction === "inbound" ? "Inbound" : "Outbound")}</button>`).join("")}</div>
          <div class="dispatch-yard-type-tabs" role="tablist" aria-label="${loadedT("yard.orderType", "Order Type")}">${typeTabs.map((orderType) => `<button class="${selectedMovementType() === orderType && !loadedSearchActive() ? "active" : ""}" data-action="yard-type" data-order-type="${orderType}" aria-label="${loadedEscape(movementTypeLabel(orderType))}" title="${loadedEscape(movementTypeLabel(orderType))}" type="button">${movementTypeCode(orderType)}</button>`).join("")}</div>
        </div>
        <div class="dispatch-loaded-list" id="dispatchLoadedList">${renderLoadedList()}</div>
      </aside>
      <section class="dispatch-loaded-right panel">
        <div class="dispatch-loaded-filters">
          <label><span>${loadedT("common.from", "From")}</span><input id="dispatchLoadedFrom" type="date" value="${loadedEscape(loadedState.filters.from)}" /></label>
          <label><span>${loadedT("common.to", "To")}</span><input id="dispatchLoadedTo" type="date" value="${loadedEscape(loadedState.filters.to)}" /></label>
          <label><span>${loadedT("common.yard", "Yard")}</span><select id="dispatchLoadedYard"><option value="all" ${loadedState.filters.yard === "all" ? "selected" : ""}>${loadedT("common.all", "All")}</option>${yardOptions.map((yard) => `<option value="${yard.locationId}" ${loadedState.filters.yard === String(yard.locationId) ? "selected" : ""}>${loadedEscape(yard.yardCode)}</option>`).join("")}</select></label>
          <label><span>${loadedT("yard.driver", "Driver")}</span><select id="dispatchLoadedDriver"><option value="all" ${loadedState.filters.driver === "all" ? "selected" : ""}>${loadedT("yard.allDrivers", "All drivers")}</option>${driverOptions.map((driver) => `<option value="${loadedEscape(driver.login)}" ${loadedState.filters.driver === String(driver.login) ? "selected" : ""}>${loadedEscape(driver.name || driver.login)}${driver.active === false ? ` · ${loadedT("common.inactive", "Inactive")}` : ""}</option>`).join("")}</select></label>
          <button class="primary" data-action="apply-loaded-filters" type="button">${loadedT("common.apply", "Apply")}</button>
          <button data-action="refresh-loaded-orders" type="button">${loadedT("common.refresh", "Refresh")}</button>
          <button data-action="export-loaded-csv" type="button" ${loadedState.orders.length ? "" : "disabled"}>${loadedT("common.exportCsv", "Export CSV")}</button>
          <span>${loadedEscape(loadedState.busy)}</span>
        </div>
        <div class="dispatch-loaded-detail" id="dispatchLoadedDetail">${renderLoadedDetail()}</div>
      </section>
    </section>`;
}

async function runLoadedAction(label, action) {
  if (loadedState.busy) return;
  loadedState.busy = label;
  loadedState.error = "";
  renderDispatchLoaded();
  try {
    await action();
  } catch (error) {
    loadedState.error = error.message;
  } finally {
    loadedState.busy = "";
    renderDispatchLoaded();
  }
}

let loadedSearchTimer = null;
dispatchLoadedApp.addEventListener("input", (event) => {
  if (!["dispatchLoadedSearch", "dispatchLoadedItemSearch"].includes(event.target?.id)) return;
  if (event.target.id === "dispatchLoadedSearch") loadedState.search = event.target.value || "";
  if (event.target.id === "dispatchLoadedItemSearch") loadedState.itemSearch = event.target.value || "";
  localStorage.setItem("mbbs.dispatch.loaded.search", loadedState.search);
  localStorage.setItem("mbbs.dispatch.loaded.itemSearch", loadedState.itemSearch);
  clearTimeout(loadedSearchTimer);
  loadedSearchTimer = setTimeout(() => loadLoadedSearch().then(updateLoadedPanels).catch((error) => {
    loadedState.searchLoading = false;
    loadedState.error = error.message;
    renderDispatchLoaded();
  }), 250);
});

dispatchLoadedApp.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "yard-direction") {
    const direction = button.dataset.direction;
    if (!DISPATCH_YARD_TYPES[direction]) return;
    loadedState.direction = direction;
    localStorage.setItem("mbbs.dispatch.loaded.direction", direction);
    loadedState.search = "";
    loadedState.itemSearch = "";
    loadedState.searchResults = [];
    loadedState.searchLoading = false;
    localStorage.setItem("mbbs.dispatch.loaded.search", "");
    localStorage.setItem("mbbs.dispatch.loaded.itemSearch", "");
    loadedState.selectedKey = "";
    await runLoadedAction(loadedT("common.loading", "Loading..."), () => loadLoadedOrders());
    return;
  }
  if (action === "yard-type") {
    const orderType = button.dataset.orderType;
    if (!(DISPATCH_YARD_TYPES[loadedState.direction] || []).includes(orderType)) return;
    loadedState.typeByDirection[loadedState.direction] = orderType;
    localStorage.setItem(`mbbs.dispatch.loaded.${loadedState.direction}Type`, orderType);
    loadedState.search = "";
    loadedState.itemSearch = "";
    loadedState.searchResults = [];
    loadedState.searchLoading = false;
    localStorage.setItem("mbbs.dispatch.loaded.search", "");
    localStorage.setItem("mbbs.dispatch.loaded.itemSearch", "");
    loadedState.selectedKey = "";
    await runLoadedAction(loadedT("common.loading", "Loading..."), () => loadLoadedOrders());
    return;
  }
  if (action === "select-loaded-order") {
    loadedState.selectedKey = button.dataset.key || "";
    loadedState.detail = null;
    updateLoadedPanels();
    try {
      await loadSelectedDetail();
      updateLoadedPanels();
    } catch (error) {
      loadedState.error = error.message;
      renderDispatchLoaded();
    }
    return;
  }
  if (action === "open-loaded-photo") {
    openLoadedPhoto(button.dataset.photoRef, button.dataset.photoLabel || "Load photo");
    return;
  }
  if (action === "apply-loaded-filters") {
    loadedState.filters = {
      from: document.getElementById("dispatchLoadedFrom")?.value || loadedToday(),
      to: document.getElementById("dispatchLoadedTo")?.value || document.getElementById("dispatchLoadedFrom")?.value || loadedToday(),
      yard: document.getElementById("dispatchLoadedYard")?.value || "all",
      driver: document.getElementById("dispatchLoadedDriver")?.value || "all"
    };
    for (const [key, value] of Object.entries(loadedState.filters)) localStorage.setItem(`mbbs.dispatch.loaded.${key}`, value);
    loadedState.selectedKey = "";
    await runLoadedAction(loadedT("common.loading", "Loading..."), () => loadLoadedOrders());
    return;
  }
  if (action === "refresh-loaded-orders") {
    await runLoadedAction(loadedT("common.loading", "Loading..."), async () => {
      await loadLoadedOrders({ keepSelection: true });
      if (loadedSearchActive()) await loadLoadedSearch();
    });
    return;
  }
  if (action === "export-loaded-csv") {
    await runLoadedAction(loadedT("common.loading", "Loading..."), downloadLoadedCsv);
  }
});

window.addEventListener("mbbs-language-changed", renderDispatchLoaded);

requireDispatchLogin({
  mount: dispatchLoadedApp,
  roles: loadedRoles,
  allowPublicSales: false,
  async onReady(operator) {
    loadedState.operator = operator;
    const allowedYardIds = new Set(loadedAllowedYards().map((yard) => String(yard.locationId)));
    if (loadedState.filters.yard !== "all" && !allowedYardIds.has(String(loadedState.filters.yard))) {
      loadedState.filters.yard = "all";
      localStorage.setItem("mbbs.dispatch.loaded.yard", "all");
    }
    await runLoadedAction(loadedT("common.loading", "Loading..."), async () => {
      await loadLoadedDrivers();
      await loadLoadedOrders();
      if (loadedSearchActive()) await loadLoadedSearch();
    });
  }
});

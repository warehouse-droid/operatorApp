const dispatchLoadedApp = document.getElementById("dispatchLoadedApp");
const loadedT = (key, fallback) => window.MBBS_I18N?.t(key, fallback) || fallback;

function loadedToday() {
  const date = new Date();
  return new Date(date.getTime() - (date.getTimezoneOffset() * 60000)).toISOString().slice(0, 10);
}

const loadedState = {
  operator: null,
  orders: [],
  searchResults: [],
  detail: null,
  selectedKey: "",
  search: localStorage.getItem("mbbs.dispatch.loaded.search") || "",
  itemSearch: localStorage.getItem("mbbs.dispatch.loaded.itemSearch") || "",
  direction: localStorage.getItem("mbbs.dispatch.loaded.direction") === "inbound" ? "inbound" : "outbound",
  typeByDirection: {
    inbound: ["purchase_order", "transfer_order", "co_order"].includes(localStorage.getItem("mbbs.dispatch.loaded.inboundType"))
      ? localStorage.getItem("mbbs.dispatch.loaded.inboundType")
      : "purchase_order",
    outbound: ["sales_order", "transfer_order", "co_order", "vrma_order"].includes(localStorage.getItem("mbbs.dispatch.loaded.outboundType"))
      ? localStorage.getItem("mbbs.dispatch.loaded.outboundType")
      : "sales_order"
  },
  filters: {
    from: localStorage.getItem("mbbs.dispatch.loaded.from") || loadedToday(),
    to: localStorage.getItem("mbbs.dispatch.loaded.to") || loadedToday(),
    yard: localStorage.getItem("mbbs.dispatch.loaded.yard") || "all"
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

const DISPATCH_YARD_TYPES = {
  inbound: ["purchase_order", "transfer_order", "co_order"],
  outbound: ["sales_order", "transfer_order", "co_order", "vrma_order"]
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
    vrma_order: "VRMA"
  }[orderType] || String(orderType || "").toUpperCase();
}

function movementTypeLabel(orderType) {
  return {
    sales_order: loadedT("yard.salesOrder", "Sales Order"),
    transfer_order: loadedT("yard.transferOrder", "Transfer Order"),
    purchase_order: loadedT("yard.purchaseOrder", "Purchase Order"),
    co_order: loadedT("yard.coOrder", "CO Order"),
    vrma_order: "VRMA"
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
    direction: loadedState.direction,
    orderType: selectedMovementType()
  });
}

function loadedSearchQuery() {
  const params = new URLSearchParams({
    from: "2000-01-01",
    to: "2099-12-31",
    yard: "all"
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
  loadedState.detail = await loadedRequest(`/api/dispatch/loaded-orders/detail?${params.toString()}`);
}

async function loadLoadedOrders({ keepSelection = false } = {}) {
  loadedState.orders = await loadedRequest(`/api/dispatch/loaded-orders?${loadedFilterQuery().toString()}`);
  if (!keepSelection || !loadedState.orders.some((order) => loadedOrderKey(order) === loadedState.selectedKey)) {
    loadedState.selectedKey = loadedState.orders[0] ? loadedOrderKey(loadedState.orders[0]) : "";
  }
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
  const results = await loadedRequest(`/api/dispatch/loaded-orders?${loadedSearchQuery().toString()}`);
  if (seq !== loadedState.searchSeq) return;
  loadedState.searchResults = results;
  loadedState.searchLoading = false;
  if (!results.some((order) => loadedOrderKey(order) === loadedState.selectedKey)) {
    loadedState.selectedKey = results[0] ? loadedOrderKey(results[0]) : "";
  }
  await loadSelectedDetail();
}

function loadedPhotoSrc(value) {
  const ref = String(value || "");
  if (!ref.startsWith("r2://")) return ref;
  return `/api/photo-upload/preview?ref=${encodeURIComponent(ref)}&token=${encodeURIComponent(dispatchAuthToken || "")}`;
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
  const response = await fetch(`/api/dispatch/loaded-orders/export.csv?${loadedFilterQuery().toString()}`);
  if (!response.ok) throw new Error(await response.text());
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = `yard-in-outbound-${loadedState.filters.from}-${loadedState.filters.to}.csv`;
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
    ${orders.map((order) => `<button class="dispatch-loaded-order ${loadedOrderKey(order) === loadedState.selectedKey ? "active" : ""}" data-action="select-loaded-order" data-key="${loadedEscape(loadedOrderKey(order))}" type="button">
      <div class="dispatch-movement-card-head"><strong>${loadedEscape(order.tranid || order.order_id)}</strong><span class="dispatch-movement-badges"><i class="dispatch-movement-badge ${loadedEscape(order.direction)}">${loadedT(`yard.${order.direction}`, order.direction)}</i><i class="dispatch-movement-badge type">${movementTypeCode(order.order_type)}</i></span></div>
      <span>${loadedEscape(order.yard_location || loadedT("common.yard", "Yard"))} | ${loadedEscape(order.movement_status || loadedT("yard.processed", "Processed"))}</span>
      <em>${loadedFormatDate(order.last_processed_at)} | ${order.process_count || 0} ${loadedT("yard.activities", "activities")} | ${order.photo_count || 0} ${loadedT("common.photos", "photos")}</em>
      ${order.party ? `<small>${loadedEscape(order.party)}</small>` : ""}
    </button>`).join("") || (!loadedState.searchLoading ? `<div class="dispatch-loaded-notice">${loadedSearchActive() ? loadedT("yard.noSearchResults", "No order matched either search across all dates, yards, directions, and order types.") : loadedT("yard.noFilterResults", "No processed movement matched this direction, order type, date, and yard.")}</div>` : "")}
  `;
}

function renderLoadedDetail() {
  if (!loadedState.detail) return `<div class="dispatch-loaded-empty"><strong>${loadedT("common.selectOrder", "Select an order")}</strong><span>${loadedT("yard.selectMovementHelp", "Processed lines, converted UOM, and photo proof will show here.")}</span></div>`;
  const { order, lines = [], photos = [] } = loadedState.detail;
  const route = [order.source_location, order.destination_location].filter(Boolean).join(" → ");
  return `
    <div class="dispatch-loaded-detail-head">
      <div><div class="dispatch-movement-detail-title"><h2>${loadedEscape(order.tranid || order.order_id)}</h2><span class="dispatch-movement-badges"><i class="dispatch-movement-badge ${loadedEscape(order.direction)}">${loadedT(`yard.${order.direction}`, order.direction)}</i><i class="dispatch-movement-badge type">${movementTypeCode(order.order_type)}</i></span></div><p>${loadedEscape(movementTypeLabel(order.order_type))} | ${loadedEscape(order.yard_location || "")} | ${loadedEscape(order.movement_status || loadedT("yard.processed", "Processed"))}</p>${route ? `<p>${loadedEscape(route)}</p>` : ""}${order.party ? `<p>${loadedEscape(order.party)}</p>` : ""}</div>
      <strong>${lines.length} ${loadedT("control.lines", "line(s)")}</strong>
    </div>
    <div class="dispatch-loaded-lines">${lines.map((line) => `<div class="dispatch-loaded-line">
      <div><strong>${loadedEscape(line.sku || line.item_name || "")}</strong><span>${loadedEscape(line.item_name || "")}</span>${line.item_description ? `<em>${loadedEscape(line.item_description)}</em>` : ""}</div>
      <div class="dispatch-loaded-qty">${renderMovementQuantityEquation(line)}<small>${loadedEscape(line.location || order.yard_location || "")}</small></div>
    </div>`).join("") || `<div class="dispatch-loaded-notice">${loadedT("yard.noProcessedLines", "No processed lines")}</div>`}</div>
    <section class="dispatch-loaded-photos"><h2>${loadedT("common.photos", "Photos")}</h2><div class="dispatch-loaded-photo-grid">
      ${photos.filter((photo) => photo.photo_data_url).map((photo) => `<figure>
        <button class="dispatch-loaded-photo" data-action="open-loaded-photo" data-photo-ref="${loadedEscape(photo.photo_data_url)}" data-photo-label="${loadedT("yard.activityPhoto", "Activity photo")} ${loadedEscape(photo.id)}" type="button"><img src="${loadedEscape(loadedPhotoSrc(photo.photo_data_url))}" alt="${loadedT("yard.activityPhoto", "Activity photo")} ${loadedEscape(photo.id)}" /></button>
        <figcaption>${loadedFormatDate(photo.created_at)}</figcaption>
      </figure>`).join("") || `<div class="dispatch-loaded-notice">${loadedT("common.noPhoto", "No photo")}</div>`}
    </div></section>
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
  dispatchLoadedApp.innerHTML = `
    <header class="dispatch-topbar"><div><p>MBBS Transportation</p><h1>${loadedT("control.loadedExportTitle", "Yard In/Outbound")}</h1></div><div class="topbar-language">${window.MBBS_I18N?.toggleHtml() || ""}</div><div class="topbar-actions"><span class="dispatch-user">${loadedEscape(operator.display_name || operator.username || "")}</span><button onclick="location.href='/dispatch'" type="button">${loadedT("dispatch.menu", "Dispatch Menu")}</button><button onclick="dispatchLogout()" type="button">${loadedT("common.logout", "Logout")}</button></div></header>
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
          <label><span>${loadedT("common.yard", "Yard")}</span><select id="dispatchLoadedYard"><option value="all" ${loadedState.filters.yard === "all" ? "selected" : ""}>${loadedT("common.all", "All")}</option><option value="1" ${loadedState.filters.yard === "1" ? "selected" : ""}>3445</option><option value="28" ${loadedState.filters.yard === "28" ? "selected" : ""}>2967</option><option value="15" ${loadedState.filters.yard === "15" ? "selected" : ""}>12441</option><option value="26" ${loadedState.filters.yard === "26" ? "selected" : ""}>150</option></select></label>
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
      yard: document.getElementById("dispatchLoadedYard")?.value || "all"
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
  async onReady(operator) {
    loadedState.operator = operator;
    await runLoadedAction(loadedT("common.loading", "Loading..."), async () => {
      await loadLoadedOrders();
      if (loadedSearchActive()) await loadLoadedSearch();
    });
  }
});

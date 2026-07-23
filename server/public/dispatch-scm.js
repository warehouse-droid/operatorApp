const scmApp = document.getElementById("dispatchScmApp");
const t = (key, fallback) => window.MBBS_I18N?.t(key, fallback) || fallback;
const languageToggle = () => window.MBBS_I18N?.toggleHtml() || "";

let scmOperator = null;
let scmOrders = [];
let selectedScmOrderId = "";
let scmSearch = "";
let scmPoTypeFilter = "";
let scmDropoffFilter = "";
let scmVendorFilter = "";
let scmPickupFilter = "";
let scmLineSearch = "";
let scmRef = "";
let scmRenameRef = "";
let scmLineInputs = {};
let scmNotice = "";
let scmLoading = false;
let scmSummaryOpen = false;
let scmDestinationLocationId = "";
let scmPickupPoint = "";
let scmGroupSelection = new Set();
const scmInitialOrderRef = new URLSearchParams(window.location.search).get("order") || "";
let scmInitialOrderApplied = false;

const SCM_DESTINATION_YARDS = [
  { id: "1", text: "3445" },
  { id: "15", text: "12441" },
  { id: "28", text: "2967" },
  { id: "26", text: "150" }
];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function scmApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function scmNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(number, 0) : 0;
}

function scmWeightLabel(value) {
  return `${scmNumber(value).toLocaleString("en-CA", { maximumFractionDigits: 0 })} lb`;
}

function scmLineSalesQuantity(item = {}, quantities = {}) {
  const converted = (scmNumber(quantities.pallets) * scmNumber(item.toPlt))
    + (scmNumber(quantities.layers) * scmNumber(item.toLyr))
    + (scmNumber(quantities.sections) * scmNumber(item.toSec))
    + (scmNumber(quantities.pieces) * scmNumber(item.toPcs));
  return converted > 0 ? converted : scmNumber(quantities.salesQty);
}

function scmLineWeight(item = {}, quantities = {}) {
  return scmLineSalesQuantity(item, quantities) * scmNumber(item.itemWeight);
}

function scmLineWeightText(item = {}, quantities = {}) {
  return `${t("dispatch.selectedLineWeight", "Selected weight")}: ${scmWeightLabel(scmLineWeight(item, quantities))}`;
}

function scmItemWeightText(item = {}) {
  const palletConversion = scmNumber(item.toPlt);
  if (palletConversion > 0) {
    return `${t("dispatch.weightPerPallet", "Weight per PLT")}: ${scmWeightLabel(scmNumber(item.itemWeight) * palletConversion)} / PLT`;
  }
  return `${t("dispatch.unitWeight", "Unit weight")}: ${scmWeightLabel(item.itemWeight)} / ${item.unit || item.salesUnit || "sales unit"}`;
}

function scmHasConversion(item = {}) {
  return scmNumber(item.toPlt) > 0
    || scmNumber(item.toLyr) > 0
    || scmNumber(item.toSec) > 0
    || scmNumber(item.toPcs) > 0;
}

function scmAvailableUnits(item = {}) {
  const units = [
    { key: "pallets", label: "PLT", value: scmNumber(item.pallets), conversion: scmNumber(item.toPlt) },
    { key: "layers", label: "LYR", value: scmNumber(item.layers), conversion: scmNumber(item.toLyr) },
    { key: "sections", label: "SEC", value: scmNumber(item.sections), conversion: scmNumber(item.toSec) },
    { key: "pieces", label: "PCS", value: scmNumber(item.pieces), conversion: scmNumber(item.toPcs) }
  ];
  if (scmHasConversion(item)) return units.filter((unit) => unit.conversion > 0 && unit.value > 0);
  const salesUnit = String(item.unit || item.salesUnit || "").trim() || "Sales Qty";
  return [{ key: "salesQty", label: salesUnit, value: scmNumber(item.quantity), conversion: 1 }];
}

function scmQuantityLabel(item = {}) {
  return scmAvailableUnits(item)
    .map((unit) => `${unit.value.toLocaleString()} ${unit.label}`)
    .join(" / ") || `${scmNumber(item.quantity).toLocaleString()} ${item.unit || item.salesUnit || "Sales Qty"}`;
}

function scmOrderQuantityLabel(order = {}) {
  const totals = new Map();
  for (const item of order.items || []) {
    for (const unit of scmAvailableUnits(item)) {
      const key = unit.label || "Qty";
      totals.set(key, scmNumber(totals.get(key)) + scmNumber(unit.value));
    }
  }
  if (!totals.size) {
    for (const [key, label] of [["pallets", "PLT"], ["layers", "LYR"], ["sections", "SEC"], ["pieces", "PCS"]]) {
      const value = scmNumber(order[key]);
      if (value > 0) totals.set(label, scmNumber(totals.get(label)) + value);
    }
    if (scmNumber(order.salesQty) > 0) totals.set("UOM", scmNumber(order.salesQty));
  }
  return [...totals.entries()]
    .filter(([, value]) => value > 0)
    .map(([label, value]) => `${value.toLocaleString()} ${label}`)
    .join("  ");
}

function scmPlannedLabel(order = {}) {
  const scm = order.scm || {};
  const date = scm.etaDate || order.dispatchPlanDate || "";
  const load = scm.notes || [order.dispatchTruckPlate, order.dispatchLoadName].filter(Boolean).join(" ");
  const driver = scm.driver || "";
  if (!date && !load && !driver) return "";
  return [date, load, driver].filter(Boolean).join(" | ");
}

function scmSelectedOrder() {
  return scmOrders.find((order) => String(order.id) === String(selectedScmOrderId)) || null;
}

function scmLocationIdFromText(value) {
  const text = String(value || "").trim();
  if (text === "3445") return "1";
  if (text === "12441") return "15";
  if (text === "2967") return "28";
  if (text === "150") return "26";
  return "";
}

function scmDefaultDestinationLocationId(order = scmSelectedOrder()) {
  const rawId = order?.destinationLocationId || order?.raw?.destination_location_id || "";
  const normalizedId = String(rawId || "").trim();
  if (SCM_DESTINATION_YARDS.some((yard) => yard.id === normalizedId)) return normalizedId;
  return scmLocationIdFromText(order?.destinationYard || order?.raw?.destination_location || "");
}

function scmUniqueOptions(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

function compareScmOrders(left = {}, right = {}) {
  return String(left.id || "").localeCompare(String(right.id || ""), undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function scmOrderVendorLabel(order = {}) {
  const localVendor = scmVendorYardOptions(order).map((option) => option.vendor).find(Boolean);
  return localVendor || order.customer || order.vendorYard || order.sourceYard || "";
}

function ensureScmDestinationLocation(order = scmSelectedOrder()) {
  if (!scmDestinationLocationId) scmDestinationLocationId = scmDefaultDestinationLocationId(order);
  return scmDestinationLocationId;
}

function scmVendorYardOptions(order = scmSelectedOrder()) {
  const options = Array.isArray(order?.vendorYardOptions) ? order.vendorYardOptions : [];
  const seen = new Set();
  return options.filter((option) => {
    const yard = String(option?.yard || "").trim();
    if (!yard) return false;
    const key = yard.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scmDefaultPickupPoint(order = scmSelectedOrder()) {
  const options = scmVendorYardOptions(order);
  const current = order?.scm?.pickupPoint || order?.sourceYard || order?.vendorYard || "";
  if (!options.length) return current;
  const matched = options.find((option) => String(option.yard || "").toLowerCase() === String(current || "").trim().toLowerCase());
  return matched?.yard || options[0]?.yard || current;
}

function ensureScmPickupPoint(order = scmSelectedOrder()) {
  if (!scmPickupPoint) scmPickupPoint = scmDefaultPickupPoint(order);
  return scmPickupPoint;
}

function renderScmPickupYardControl(order = {}, { action = "existing-pickup-yard", field = true } = {}) {
  const options = scmVendorYardOptions(order);
  const selected = ensureScmPickupPoint(order);
  const fieldAttr = field ? ` data-scm-field="pickupPoint"` : "";
  if (!options.length) {
    return `<div class="scm-readonly-field scm-pickup-yard-field"><span>${t("dispatch.pickupYard", "Pickup Yard")}</span><strong>${escapeHtml(selected || order.address || order.sourceAddress || t("dispatch.useNetsuiteAddress", "Use NetSuite address"))}</strong></div>`;
  }
  const hasSelected = options.some((option) => String(option.yard || "").toLowerCase() === String(selected || "").toLowerCase());
  const effectiveSelected = hasSelected ? selected : options[0]?.yard || selected;
  return `<label class="scm-pickup-yard-field"><span>${t("dispatch.pickupYard", "Pickup Yard")}</span><select${fieldAttr} data-action="${action}">
    ${hasSelected ? "" : `<option value="${escapeHtml(selected)}">${escapeHtml(selected || t("dispatch.selectPickupYard", "Select pickup yard"))}</option>`}
    ${options.map((option) => `<option value="${escapeHtml(option.yard)}" ${String(option.yard || "").toLowerCase() === String(effectiveSelected || "").toLowerCase() ? "selected" : ""}>${escapeHtml(option.yard)}</option>`).join("")}
  </select></label>`;
}

function scmOrderIsSplit(order = {}) {
  return order.isScmSplit === true || order.parseSource === "scm-split";
}

function scmOrderCanGroup(order = {}) {
  if (!order) return false;
  if (String(order.id || "").toUpperCase().startsWith("PGOB-")) return false;
  if (order.scm?.groupRef) return false;
  return order.type !== "TO";
}

function scmLineMatchesSearch(item = {}) {
  const needle = scmLineSearch.trim().toLowerCase();
  if (!needle) return true;
  return [
    item.sku,
    item.itemName,
    item.description,
    item.unit,
    item.salesUnit,
    item.destinationYard,
    item.destinationLocationId,
    scmQuantityLabel(item)
  ].join(" ").toLowerCase().includes(needle);
}

function scmFilteredItems(order = scmSelectedOrder()) {
  return (order?.items || []).filter(scmLineMatchesSearch);
}

function scmInputForLine(lineRowId) {
  const key = String(lineRowId || "");
  if (!scmLineInputs[key]) {
    scmLineInputs[key] = { pallets: 0, layers: 0, sections: 0, pieces: 0, salesQty: 0 };
  }
  return scmLineInputs[key];
}

function scmSelectedLineCount() {
  return Object.values(scmLineInputs).filter((row) =>
    scmNumber(row.pallets) + scmNumber(row.layers) + scmNumber(row.sections) + scmNumber(row.pieces) + scmNumber(row.salesQty) > 0
  ).length;
}

function scmSelectedLinesForOrder(order = scmSelectedOrder()) {
  if (!order) return [];
  return (order.items || []).map((item) => {
    const input = scmInputForLine(item.lineRowId);
    const quantities = {
      pallets: scmNumber(input.pallets),
      layers: scmNumber(input.layers),
      sections: scmNumber(input.sections),
      pieces: scmNumber(input.pieces),
      salesQty: scmNumber(input.salesQty)
    };
    return { item, quantities };
  }).filter((row) =>
    scmNumber(row.quantities.pallets)
      + scmNumber(row.quantities.layers)
      + scmNumber(row.quantities.sections)
      + scmNumber(row.quantities.pieces)
      + scmNumber(row.quantities.salesQty) > 0
  );
}

function scmSelectedLineLabel(item = {}, quantities = {}) {
  const units = scmAvailableUnits(item);
  return units
    .map((unit) => ({ label: unit.label, value: scmNumber(quantities[unit.key]) }))
    .filter((unit) => unit.value > 0)
    .map((unit) => `${unit.value.toLocaleString()} ${unit.label}`)
    .join(" / ");
}

function captureScmFocus() {
  const element = document.activeElement;
  if (!element || !scmApp.contains(element)) return null;
  const selector = element.id
    ? `#${CSS.escape(element.id)}`
    : element.dataset?.action
      ? `[data-action="${CSS.escape(element.dataset.action)}"]${element.dataset.line ? `[data-line="${CSS.escape(element.dataset.line)}"]` : ""}${element.dataset.field ? `[data-field="${CSS.escape(element.dataset.field)}"]` : ""}`
      : "";
  if (!selector) return null;
  return {
    selector,
    start: typeof element.selectionStart === "number" ? element.selectionStart : null,
    end: typeof element.selectionEnd === "number" ? element.selectionEnd : null
  };
}

function restoreScmFocus(state) {
  if (!state?.selector) return;
  const element = scmApp.querySelector(state.selector);
  if (!element) return;
  element.focus({ preventScroll: true });
  if (state.start !== null && typeof element.setSelectionRange === "function") {
    element.setSelectionRange(state.start, state.end ?? state.start);
  }
}

function captureScmScroll() {
  return {
    windowX: window.scrollX,
    windowY: window.scrollY,
    orderListTop: scmApp.querySelector(".scm-order-list")?.scrollTop || 0,
    lineListTop: scmApp.querySelector(".scm-line-list")?.scrollTop || 0
  };
}

function restoreScmScroll(state) {
  if (!state) return;
  const orderList = scmApp.querySelector(".scm-order-list");
  if (orderList) orderList.scrollTop = state.orderListTop || 0;
  const lineList = scmApp.querySelector(".scm-line-list");
  if (lineList) lineList.scrollTop = state.lineListTop || 0;
  window.scrollTo(state.windowX || 0, state.windowY || 0);
}

async function loadScmOrders() {
  scmLoading = true;
  renderScm();
  try {
    const params = new URLSearchParams();
    if (scmSearch) params.set("search", scmSearch);
    if (scmPoTypeFilter) params.set("poType", scmPoTypeFilter);
    if (scmDropoffFilter) params.set("dropoff", scmDropoffFilter);
    if (scmVendorFilter) params.set("vendor", scmVendorFilter);
    if (scmPickupFilter) params.set("pickupPoint", scmPickupFilter);
    const query = params.toString() ? `?${params.toString()}` : "";
    scmOrders = (await scmApi(`/api/dispatch/scm/purchase-orders${query}`)).sort(compareScmOrders);
    if (scmInitialOrderRef && !scmInitialOrderApplied) {
      const initialNeedle = scmInitialOrderRef.toLowerCase();
      const initialOrder = scmOrders.find((order) => [
        order.id,
        order.originalPoRef,
        order.dispatchRef,
        order.sourcePoRef
      ].some((value) => String(value || "").toLowerCase() === initialNeedle));
      if (initialOrder) {
        selectedScmOrderId = initialOrder.id;
        scmInitialOrderApplied = true;
      }
    }
    if (selectedScmOrderId && !scmOrders.some((order) => String(order.id) === String(selectedScmOrderId))) {
      selectedScmOrderId = "";
      scmLineInputs = {};
    }
    const validGroupIds = new Set(scmOrders.map((order) => String(order.id)));
    scmGroupSelection = new Set([...scmGroupSelection].filter((id) => validGroupIds.has(String(id))));
    if (!selectedScmOrderId && scmOrders[0]) selectedScmOrderId = scmOrders[0].id;
    if (!scmRenameRef && selectedScmOrderId) {
      const selected = scmOrders.find((order) => String(order.id) === String(selectedScmOrderId));
      scmRenameRef = scmOrderIsSplit(selected) ? selected?.id || "" : selected?.dispatchRef || "";
    }
  } catch (error) {
    scmNotice = `SCM PO list failed: ${error.message}`;
  } finally {
    scmLoading = false;
    renderScm();
  }
}

function renderScmListFilters() {
  const dropoffOptions = scmUniqueOptions([
    scmDropoffFilter,
    ...scmOrders.flatMap((order) => [order.destinationYard, ...(order.dropoffs || []).map((dropoff) => dropoff.destinationYard)])
  ]);
  const vendorOptions = scmUniqueOptions([scmVendorFilter, ...scmOrders.map(scmOrderVendorLabel)]);
  const pickupOptions = scmUniqueOptions([scmPickupFilter, ...scmOrders.map(scmDefaultPickupPoint)]);
  const renderSelect = (action, value, label, options) => `
    <label>
      <span>${escapeHtml(label)}</span>
      <select data-action="${action}">
        <option value="">${t("common.all", "All")}</option>
        ${options.map((option) => `<option value="${escapeHtml(option)}" ${option === value ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}
      </select>
    </label>
  `;
  return `
    <div class="scm-list-filters">
      <div class="scm-po-type-filters" role="group" aria-label="${t("dispatch.poType", "PO type")}">
        <button class="scm-po-type-filter ${scmPoTypeFilter === "po" ? "active" : ""}" data-action="filter-po-type" data-value="po" type="button" aria-pressed="${scmPoTypeFilter === "po"}">${t("dispatch.po", "PO")}</button>
        <button class="scm-po-type-filter ${scmPoTypeFilter === "split" ? "active" : ""}" data-action="filter-po-type" data-value="split" type="button" aria-pressed="${scmPoTypeFilter === "split"}">${t("dispatch.splitPo", "Split PO")}</button>
      </div>
      ${renderSelect("filter-dropoff", scmDropoffFilter, t("dispatch.dropoff", "Drop off"), dropoffOptions)}
      ${renderSelect("filter-vendor", scmVendorFilter, t("dispatch.vendor", "Vendor"), vendorOptions)}
      ${renderSelect("filter-pickup", scmPickupFilter, t("dispatch.pickupPoint", "Pickup point"), pickupOptions)}
    </div>
  `;
}

function renderOrderList() {
  if (scmLoading) return `<div class="empty-state">${t("common.loading", "Loading...")}</div>`;
  if (!scmOrders.length) return `<div class="empty-state">${t("dispatch.noPoFound", "No purchase orders found.")}</div>`;
  return scmOrders.map((order) => {
    const isSplit = scmOrderIsSplit(order);
    const alreadyGrouped = Boolean(order.scm?.groupRef) || String(order.id || "").toUpperCase().startsWith("PGOB-");
    const groupSelected = scmGroupSelection.has(String(order.id));
    const quantityLabel = scmOrderQuantityLabel(order);
    const plannedLabel = scmPlannedLabel(order);
    const pickupPoint = scmDefaultPickupPoint(order) || "";
    const destinationYards = [...new Set([
      order.destinationYard,
      ...(order.dropoffs || []).map((dropoff) => dropoff.destinationYard)
    ].map((yard) => String(yard || "").trim()).filter(Boolean))];
    const destinationText = destinationYards.join(", ");
    return `
      <button class="order-card scm-po-card ${plannedLabel ? "has-plan" : ""} ${isSplit ? "scm-split-card" : ""} ${alreadyGrouped ? "scm-grouped-card" : ""} ${groupSelected ? "multi-selected" : ""} ${String(order.id) === String(selectedScmOrderId) ? "selected" : ""}" data-action="select-order" data-id="${escapeHtml(order.id)}" type="button">
        <div class="scm-card-main">
          <strong>${escapeHtml(order.id)}</strong>
          <span class="scm-card-party">${isSplit ? t("dispatch.scmSplitOrder", "SCM Split Order") : escapeHtml(order.customer || order.vendorYard || order.sourceYard || "Purchase Order")}</span>
          <span class="scm-card-route">${isSplit
            ? `${t("dispatch.sourcePo", "Source PO")}: ${escapeHtml(order.sourcePoRef || "")}`
            : `${order.dispatchRef ? `PO ${escapeHtml(order.originalPoRef || "")} | ` : ""}${escapeHtml(pickupPoint)}${pickupPoint && destinationText ? " -> " : ""}${escapeHtml(destinationText)}`}</span>
          <span class="scm-card-qty">${escapeHtml(quantityLabel || "-")}</span>
          <span class="scm-card-weight">${t("dispatch.orderWeight", "Order weight")}: ${escapeHtml(scmWeightLabel(order.weight))}</span>
        </div>
        ${plannedLabel ? `<div class="scm-card-plan-side">
          <span class="scm-planned-badge">Planned</span>
          <span class="scm-card-plan">${escapeHtml(plannedLabel)}</span>
        </div>` : ""}
      </button>
    `;
  }).join("");
}

function renderSelectedOrder() {
  const order = scmSelectedOrder();
  if (!order) {
    return `
      <section class="scm-detail-panel empty-detail">
        <h2>${t("dispatch.selectPo", "Select a blanket PO")}</h2>
        <p>${t("dispatch.selectPoDesc", "Search or choose a PO on the left, then enter the SCM ref and split quantities.")}</p>
      </section>
    `;
  }
  const isSplit = scmOrderIsSplit(order);
  const visibleItems = scmFilteredItems(order);
  const lineRows = visibleItems.map((item) => {
    const input = scmInputForLine(item.lineRowId);
    const units = scmAvailableUnits(item);
    const displayedQuantities = isSplit
      ? Object.fromEntries(units.map((unit) => [unit.key, unit.value]))
      : input;
    return `
      <article class="scm-line-card">
        <div class="scm-line-main">
          <div>
            <strong>${escapeHtml(item.sku || item.itemName || "Item")}</strong>
            <span>${escapeHtml(item.description || "")}</span>
            <span class="scm-line-yard">
              ${t("dispatch.destinationYard", "Destination Yard")}: <b>${escapeHtml(item.destinationYard || order.destinationYard || "--")}</b>
            </span>
          </div>
          <div class="scm-line-totals">
            <div class="scm-line-available">${escapeHtml(scmQuantityLabel(item))}</div>
            <span>${escapeHtml(scmItemWeightText(item))}</span>
            <span>${t("dispatch.availableLineWeight", "Available line weight")}: ${escapeHtml(scmWeightLabel(item.lineWeight))}</span>
          </div>
        </div>
        <div class="scm-line-inputs ${isSplit ? "readonly" : ""}">
          ${units.map((unit) => `
            <label>
              <span>${unit.label}</span>
              <input data-action="line-qty" data-line="${escapeHtml(item.lineRowId)}" data-field="${escapeHtml(unit.key)}" type="number" min="0" max="${escapeHtml(unit.value)}" step="1" value="${escapeHtml(isSplit ? unit.value : input[unit.key] || 0)}" ${isSplit ? "disabled" : ""} />
            </label>
          `).join("")}
        </div>
        <div class="scm-line-selected-weight" data-scm-line-weight="${escapeHtml(item.lineRowId)}">${escapeHtml(scmLineWeightText(item, displayedQuantities))}</div>
      </article>
    `;
  }).join("");
  return `
    <section class="scm-detail-panel">
      <div class="scm-detail-header">
        <div>
          <p>${t("dispatch.blanketPo", "Blanket PO")}</p>
          <h2>${escapeHtml(order.id)}</h2>
          <span>${order.originalPoRef && order.originalPoRef !== order.id ? `PO ${escapeHtml(order.originalPoRef)} | ` : ""}${escapeHtml(order.customer || order.vendorYard || order.sourceYard || "")}</span>
        </div>
        <div class="scm-detail-total-weight">
          <span>${isSplit ? t("dispatch.splitPoTotalWeight", "Split PO total weight") : t("dispatch.poTotalWeight", "PO total weight")}</span>
          <strong>${escapeHtml(scmWeightLabel(order.weight))}</strong>
        </div>
      </div>
      ${renderScmScheduleMiniPanel(order)}
      <div class="scm-selected-summary">
        <input class="scm-line-search" data-action="line-search" value="${escapeHtml(scmLineSearch)}" placeholder="${t("dispatch.searchLine", "Search line / SKU")}" autocomplete="off" />
        <span>${isSplit ? `${visibleItems.length} ${t("dispatch.linesShown", "lines shown")}` : `${scmSelectedLineCount()} ${t("dispatch.linesSelected", "lines selected")}`}</span>
        ${isSplit ? "" : `<button class="secondary-button" data-action="clear-inputs" type="button">${t("common.clear", "Clear")}</button>`}
      </div>
      <div class="scm-line-list">
        ${lineRows || `<div class="empty-state">${t("dispatch.noOpenLines", "No open PO lines remain for this order.")}</div>`}
      </div>
      ${isSplit ? "" : `<div class="scm-submit-row">
        <button class="primary-action" data-action="create-split" type="button">${t("dispatch.createPoRef", "Create PO Ref")}</button>
      </div>`}
    </section>
  `;
}

function renderScmScheduleMiniPanel(order = {}) {
  const scm = order.scm || {};
  const isSplit = scmOrderIsSplit(order);
  const currentMethod = scm.method || "MBT";
  const currentStatus = scm.status || "Queued";
  const currentGroup = scm.groupRef || "";
  const orderKind = order.type === "TO" ? "TO" : "PO";
  const manualStatuses = ["Queued", "Urgent", "Cancelled", "Hold", "Priority", "Surplus Only", "Book Appt"];
  const statusIsManual = manualStatuses.includes(currentStatus);
  const selectedDestination = scmDestinationLocationId || scmDefaultDestinationLocationId(order);
  return `
    <section class="scm-mini-panel">
      <div class="scm-mini-grid">
        <label><span>Method</span><select data-scm-field="method">
          ${["MBT", "Vendor", "Customer Pickup"].map((value) => `<option value="${value}" ${currentMethod === value ? "selected" : ""}>${value}</option>`).join("")}
        </select></label>
        <label><span>Status</span>${statusIsManual
          ? `<select data-scm-field="status">${manualStatuses.map((value) => `<option value="${value}" ${currentStatus === value ? "selected" : ""}>${value}</option>`).join("")}</select>`
          : `<input value="${escapeHtml(currentStatus)}" readonly />`}</label>
        ${renderScmPickupYardControl(order, { action: isSplit ? "existing-split-pickup-yard" : "existing-pickup-yard", field: !isSplit })}
        <label class="checkbox-line"><input data-scm-field="isSpecialOrder" type="checkbox" ${scm.isSpecialOrder ? "checked" : ""} /> <span>Sp.O</span></label>
        ${isSplit
          ? `<label><span>${t("dispatch.changeRef", "Change Ref")}</span><input data-action="rename-ref" value="${escapeHtml(scmRenameRef || order.id || "")}" autocomplete="off" /></label>
             <label><span>${t("dispatch.destinationYard", "Destination Yard")}</span><select data-action="existing-split-destination-yard">
               ${SCM_DESTINATION_YARDS.map((yard) => `<option value="${yard.id}" ${yard.id === selectedDestination ? "selected" : ""}>${yard.text}</option>`).join("")}
             </select></label>`
          : `<label><span>Packing Slip / Ref</span><input data-scm-field="packingSlipRef" value="${escapeHtml(scm.packingSlipRef || order.dispatchRef || "")}" /></label>`}
        <button data-action="save-scm-schedule" data-kind="${escapeHtml(orderKind)}" type="button">Save Schedule</button>
        ${isSplit ? `<button data-action="update-split" type="button">${t("common.update", "Update")}</button><button class="danger-button" data-action="unsplit-order" type="button">${t("dispatch.unsplit", "Unsplit")}</button>` : ""}
      </div>
      ${currentGroup ? `<div class="scm-group-tools compact"><strong>${escapeHtml(currentGroup)}</strong><button class="danger-button" data-action="cancel-scm-group" data-group="${escapeHtml(currentGroup)}" type="button">Ungroup</button></div>` : ""}
    </section>
  `;
}

function renderScmSplitModal() {
  if (!scmSummaryOpen) return "";
  const order = scmSelectedOrder();
  const rows = scmSelectedLinesForOrder(order);
  const totalSelectedWeight = rows.reduce((sum, row) => sum + scmLineWeight(row.item, row.quantities), 0);
  const selectedDestination = ensureScmDestinationLocation(order);
  ensureScmPickupPoint(order);
  return `
    <div class="modal-backdrop show scm-summary-backdrop">
      <section class="dispatch-modal scm-summary-modal">
        <div class="modal-header">
          <div>
            <p>${t("dispatch.splitSummary", "Split Summary")}</p>
            <h2>${escapeHtml(order?.id || "")}</h2>
          </div>
          <button data-action="close-summary" type="button">×</button>
        </div>
        <div class="scm-summary-body">
          <label class="scm-ref-input">
            <span>${t("dispatch.newPoRef", "New PO Ref")}</span>
            <input data-action="new-ref" value="${escapeHtml(scmRef)}" placeholder="POB12345-A" autocomplete="off" />
          </label>
          <label class="scm-ref-input">
            <span>${t("dispatch.destinationYard", "Destination Yard")}</span>
            <select data-action="split-destination-yard">
              ${SCM_DESTINATION_YARDS.map((yard) => `<option value="${yard.id}" ${yard.id === selectedDestination ? "selected" : ""}>${yard.text}</option>`).join("")}
            </select>
          </label>
          <div class="scm-ref-input">
            ${renderScmPickupYardControl(order, { action: "split-pickup-yard", field: false })}
          </div>
          <div class="scm-summary-lines">
            ${rows.map(({ item, quantities }) => `
              <article>
                <strong>${escapeHtml(item.sku || item.itemName || "Item")}</strong>
                <span>${escapeHtml(scmSelectedLineLabel(item, quantities))}</span>
                <small>${t("dispatch.destinationYard", "Destination Yard")}: ${escapeHtml(item.destinationYard || order?.destinationYard || "--")}</small>
                <small>${escapeHtml(scmLineWeightText(item, quantities))}</small>
              </article>
            `).join("") || `<div class="empty-state">${t("dispatch.noLinesSelected", "No lines selected.")}</div>`}
          </div>
          <div class="scm-summary-total-weight">${t("dispatch.totalSelectedWeight", "Total selected weight")}: <strong>${escapeHtml(scmWeightLabel(totalSelectedWeight))}</strong></div>
        </div>
        <div class="modal-footer">
          <button data-action="close-summary" type="button">${t("common.cancel", "Cancel")}</button>
          <button class="primary-action" data-action="confirm-create-split" type="button">${t("dispatch.createPoRef", "Create PO Ref")}</button>
        </div>
      </section>
    </div>
  `;
}

function renderScm() {
  const focusState = captureScmFocus();
  const scrollState = captureScmScroll();
  const operator = scmOperator || {};
  scmApp.innerHTML = `
    <section class="dispatch-shell scm-shell">
      <header class="dispatch-topbar">
        <div>
          <p>${t("app.transportation", "MBBS Transportation")}</p>
          <h1>${t("dispatch.scmSplit", "SCM PO Split")}</h1>
        </div>
        <div class="topbar-language">${languageToggle()}</div>
        <div class="topbar-actions">
          <span class="dispatch-user">${escapeHtml(operator.display_name || operator.username || "")}</span>
          <button onclick="location.href='/scm'" type="button">${t("common.menu", "SCM Menu")}</button>
          <button onclick="dispatchLogout()" type="button">${t("common.logout", "Logout")}</button>
        </div>
      </header>
      ${scmNotice ? `<div class="route-notice scm-notice"><span>${escapeHtml(scmNotice)}</span><button class="scm-notice-close" data-action="close-notice" type="button" aria-label="${t("common.close", "Close")}">x</button></div>` : ""}
      <section class="scm-grid">
        <aside class="scm-list-panel">
          <div class="scm-search-row">
            <input id="scmSearchInput" value="${escapeHtml(scmSearch)}" placeholder="${t("dispatch.searchPoSkuVendor", "Search PO / SKU / vendor")}" autocomplete="off" />
            <button data-action="refresh" type="button">${t("common.refresh", "Refresh")}</button>
          </div>
          ${renderScmListFilters()}
          <div class="scm-list-actions">
            <span>${scmGroupSelection.size ? `${scmGroupSelection.size} selected` : "Ctrl+click PO to group"}</span>
            <button class="primary-action" data-action="create-scm-group" type="button" ${scmGroupSelection.size >= 2 ? "" : "disabled"}>Group</button>
          </div>
          <div class="order-list scm-order-list">${renderOrderList()}</div>
        </aside>
        ${renderSelectedOrder()}
      </section>
      ${renderScmSplitModal()}
    </section>
  `;
  restoreScmScroll(scrollState);
  restoreScmFocus(focusState);
}

async function createScmSplit() {
  const order = scmSelectedOrder();
  if (!order) return;
  const lines = scmSelectedLinesForOrder(order).map(({ item, quantities }) => ({
    lineRowId: item.lineRowId,
    ...quantities
  }));
  const destinationLocationId = ensureScmDestinationLocation(order);
  const pickupPoint = scmVendorYardOptions(order).length ? ensureScmPickupPoint(order) : "";
  if (!scmRef.trim()) {
    scmNotice = "New PO ref number is required.";
    renderScm();
    return;
  }
  if (!destinationLocationId) {
    scmNotice = "Destination yard is required.";
    renderScm();
    return;
  }
  if (!lines.length) {
    scmNotice = "Select at least one line quantity.";
    renderScm();
    return;
  }
  scmLoading = true;
  scmNotice = "Creating SCM split...";
  renderScm();
  try {
    const payload = await scmApi("/api/dispatch/scm/purchase-order-splits", {
      method: "POST",
      body: JSON.stringify({
        sourcePoRef: order.originalPoRef || order.id,
        newPoRef: scmRef.trim(),
        pickupPoint,
        destinationLocationId,
        lines,
        audit: { sessionId: sessionStorage.getItem("mbbs.dispatch.sessionId") || "" }
      })
    });
    const createdRef = payload.created?.split?.splitPoRef || scmRef;
    scmNotice = `Created ${createdRef}. It is now searchable under PO.`;
    scmRef = "";
    scmDestinationLocationId = "";
    scmPickupPoint = "";
    scmSummaryOpen = false;
    scmLineInputs = {};
    await loadScmOrders();
  } catch (error) {
    scmNotice = `Create split failed: ${error.message}`;
  } finally {
    scmLoading = false;
    renderScm();
  }
}

async function updateScmPoRef({ clear = false } = {}) {
  const order = scmSelectedOrder();
  if (!order || scmOrderIsSplit(order)) return;
  const newRef = clear ? "" : String(scmRenameRef || "").trim();
  scmLoading = true;
  scmNotice = clear ? "Clearing PO ref..." : "Updating PO ref...";
  renderScm();
  try {
    const payload = await scmApi(`/api/dispatch/scm/purchase-orders/${encodeURIComponent(order.originalPoRef || order.id)}/ref`, {
      method: "PUT",
      body: JSON.stringify({
        newRef,
        audit: { sessionId: sessionStorage.getItem("mbbs.dispatch.sessionId") || "" }
      })
    });
    selectedScmOrderId = payload.updated?.displayRef || order.originalPoRef || order.id;
    scmRenameRef = payload.updated?.dispatchRef || "";
    scmNotice = payload.updated?.dispatchRef
      ? `Updated PO ref to ${payload.updated.displayRef}.`
      : `Cleared PO ref. Showing ${payload.updated?.poRef || selectedScmOrderId}.`;
    await loadScmOrders();
  } catch (error) {
    scmNotice = `Update PO ref failed: ${error.message}`;
  } finally {
    scmLoading = false;
    renderScm();
  }
}

async function updateScmSplitRef() {
  const order = scmSelectedOrder();
  if (!order || !scmOrderIsSplit(order)) return;
  const newRef = String(scmRenameRef || order.id || "").trim();
  if (!newRef) {
    scmNotice = "New PO ref number is required.";
    renderScm();
    return;
  }
  scmLoading = true;
  scmNotice = "Updating split ref...";
  renderScm();
  try {
    const payload = await scmApi(`/api/dispatch/scm/purchase-order-splits/${encodeURIComponent(order.id)}`, {
      method: "PUT",
      body: JSON.stringify({
        newPoRef: newRef,
        audit: { sessionId: sessionStorage.getItem("mbbs.dispatch.sessionId") || "" }
      })
    });
    selectedScmOrderId = payload.updated?.newPoRef || newRef;
    scmRenameRef = selectedScmOrderId;
    scmNotice = `Updated split ref to ${selectedScmOrderId}.`;
    await loadScmOrders();
  } catch (error) {
    scmNotice = `Update ref failed: ${error.message}`;
  } finally {
    scmLoading = false;
    renderScm();
  }
}

async function updateScmSplit() {
  const order = scmSelectedOrder();
  if (!order || !scmOrderIsSplit(order)) return;
  const newRef = String(scmRenameRef || order.id || "").trim();
  const currentDestinationId = scmDefaultDestinationLocationId(order);
  const nextDestinationId = String(scmDestinationLocationId || currentDestinationId || "").trim();
  const pickupOptions = scmVendorYardOptions(order);
  const currentPickupPoint = scmDefaultPickupPoint(order);
  const nextPickupPoint = pickupOptions.length ? String(scmPickupPoint || currentPickupPoint || "").trim() : currentPickupPoint;
  if (!newRef) {
    scmNotice = "New PO ref number is required.";
    renderScm();
    return;
  }
  if (!nextDestinationId) {
    scmNotice = "Destination yard is required.";
    renderScm();
    return;
  }
  const refChanged = newRef.toLowerCase() !== String(order.id || "").trim().toLowerCase();
  const destinationChanged = nextDestinationId !== currentDestinationId;
  const pickupChanged = nextPickupPoint.toLowerCase() !== String(currentPickupPoint || "").trim().toLowerCase();
  if (!refChanged && !destinationChanged && !pickupChanged) {
    scmNotice = "No split order changes to update.";
    renderScm();
    return;
  }
  scmLoading = true;
  scmNotice = "Updating split order...";
  renderScm();
  try {
    let currentRef = order.id;
    let updatedRef = null;
    let updatedDestination = null;
    let updatedPickup = null;
    const audit = { sessionId: sessionStorage.getItem("mbbs.dispatch.sessionId") || "" };
    if (refChanged) {
      const refPayload = await scmApi(`/api/dispatch/scm/purchase-order-splits/${encodeURIComponent(currentRef)}`, {
        method: "PUT",
        body: JSON.stringify({ newPoRef: newRef, audit })
      });
      currentRef = refPayload.updated?.newPoRef || newRef;
      updatedRef = currentRef;
    }
    if (destinationChanged) {
      const destinationPayload = await scmApi(`/api/dispatch/scm/purchase-order-splits/${encodeURIComponent(currentRef)}/destination`, {
        method: "PUT",
        body: JSON.stringify({ destinationLocationId: nextDestinationId, audit })
      });
      updatedDestination = destinationPayload.updated?.destinationLocation || SCM_DESTINATION_YARDS.find((yard) => yard.id === nextDestinationId)?.text || "";
    }
    if (pickupChanged) {
      const pickupPayload = await scmApi(`/api/dispatch/scm/purchase-order-splits/${encodeURIComponent(currentRef)}/pickup`, {
        method: "PUT",
        body: JSON.stringify({ pickupPoint: nextPickupPoint, audit })
      });
      updatedPickup = pickupPayload.updated?.pickupPoint || nextPickupPoint;
    }
    selectedScmOrderId = updatedRef || currentRef;
    scmRenameRef = selectedScmOrderId;
    scmDestinationLocationId = "";
    scmPickupPoint = "";
    scmNotice = [
      updatedRef ? `ref ${updatedRef}` : "",
      updatedDestination ? `destination ${updatedDestination}` : "",
      updatedPickup ? `pickup ${updatedPickup}` : ""
    ].filter(Boolean).join(" and ");
    scmNotice = scmNotice ? `Updated split ${scmNotice}.` : "Updated split order.";
    await loadScmOrders();
  } catch (error) {
    scmNotice = `Update split failed: ${error.message}`;
  } finally {
    scmLoading = false;
    renderScm();
  }
}

async function unsplitScmOrder() {
  const order = scmSelectedOrder();
  if (!order || !scmOrderIsSplit(order)) return;
  if (!confirm(`Unsplit ${order.id}? The selected quantity will return to ${order.sourcePoRef || "the source PO"}.`)) return;
  scmLoading = true;
  scmNotice = "Unsplitting order...";
  renderScm();
  try {
    await scmApi(`/api/dispatch/scm/purchase-order-splits/${encodeURIComponent(order.id)}?sessionId=${encodeURIComponent(sessionStorage.getItem("mbbs.dispatch.sessionId") || "")}`, {
      method: "DELETE"
    });
    scmNotice = `${order.id} was unsplit. Quantity returned to ${order.sourcePoRef || "source PO"}.`;
    selectedScmOrderId = order.sourcePoRef || "";
    scmRenameRef = "";
    scmLineInputs = {};
    scmLineSearch = "";
    await loadScmOrders();
  } catch (error) {
    scmNotice = `Unsplit failed: ${error.message}`;
  } finally {
    scmLoading = false;
    renderScm();
  }
}

function collectScmSchedulePatch(order = scmSelectedOrder()) {
  const patch = { orderKind: order?.type === "TO" ? "TO" : "PO" };
  scmApp.querySelectorAll("[data-scm-field]").forEach((field) => {
    patch[field.dataset.scmField] = field.type === "checkbox" ? field.checked : field.value;
  });
  return patch;
}

async function saveScmScheduleForSelected() {
  const order = scmSelectedOrder();
  if (!order) return;
  const patch = collectScmSchedulePatch(order);
  scmLoading = true;
  scmNotice = "Saving SCM schedule...";
  renderScm();
  try {
    await scmApi(`/api/scm/schedule/${encodeURIComponent(order.id)}`, {
      method: "PUT",
      body: JSON.stringify({
        ...patch,
        audit: { sessionId: sessionStorage.getItem("mbbs.dispatch.sessionId") || "" }
      })
    });
    scmNotice = `Saved SCM schedule for ${order.id}.`;
    await loadScmOrders();
  } catch (error) {
    scmNotice = `Save schedule failed: ${error.message}`;
  } finally {
    scmLoading = false;
    renderScm();
  }
}

async function createScmGroupForSelected() {
  const selectedOrders = scmOrders.filter((order) => scmGroupSelection.has(String(order.id)) && scmOrderCanGroup(order));
  const refs = selectedOrders.map((order) => order.id).filter(Boolean);
  if (refs.length < 2) {
    scmNotice = "Ctrl+click at least two ungrouped POs before grouping.";
    renderScm();
    return;
  }
  scmLoading = true;
  scmNotice = "Creating SCM group...";
  renderScm();
  try {
    const payload = await scmApi("/api/scm/schedule-groups", {
      method: "POST",
      body: JSON.stringify({
        refs,
        audit: { sessionId: sessionStorage.getItem("mbbs.dispatch.sessionId") || "" }
      })
    });
    scmNotice = `Created ${payload.grouped?.groupRef || "group"}.`;
    scmGroupSelection = new Set();
    await loadScmOrders();
  } catch (error) {
    scmNotice = `Create group failed: ${error.message}`;
  } finally {
    scmLoading = false;
    renderScm();
  }
}

async function cancelScmGroup(groupRef) {
  if (!groupRef) return;
  scmLoading = true;
  scmNotice = "Ungrouping...";
  renderScm();
  try {
    await scmApi(`/api/scm/schedule-groups/${encodeURIComponent(groupRef)}?sessionId=${encodeURIComponent(sessionStorage.getItem("mbbs.dispatch.sessionId") || "")}`, {
      method: "DELETE"
    });
    scmNotice = `Ungrouped ${groupRef}.`;
    await loadScmOrders();
  } catch (error) {
    scmNotice = `Ungroup failed: ${error.message}`;
  } finally {
    scmLoading = false;
    renderScm();
  }
}

scmApp.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "close-notice") {
    scmNotice = "";
    renderScm();
    return;
  }
  if (action === "select-order") {
    const clickedId = target.dataset.id || "";
    const clickedOrder = scmOrders.find((order) => String(order.id) === String(clickedId));
    if (event.ctrlKey || event.metaKey) {
      if (!scmOrderCanGroup(clickedOrder)) {
        scmNotice = "This PO is already grouped and cannot be selected for a new group.";
        renderScm();
        return;
      }
      if (scmGroupSelection.has(String(clickedId))) scmGroupSelection.delete(String(clickedId));
      else scmGroupSelection.add(String(clickedId));
      selectedScmOrderId = clickedId;
    } else {
      selectedScmOrderId = clickedId;
      scmGroupSelection = new Set();
    }
    const selected = scmOrders.find((order) => String(order.id) === String(selectedScmOrderId));
    scmLineInputs = {};
    scmLineSearch = "";
      scmRenameRef = scmOrderIsSplit(selected) ? selected?.id || "" : selected?.dispatchRef || "";
    scmDestinationLocationId = scmOrderIsSplit(selected) ? scmDefaultDestinationLocationId(selected) : "";
    scmPickupPoint = scmDefaultPickupPoint(selected);
    scmNotice = "";
    scmSummaryOpen = false;
    renderScm();
  }
  if (action === "refresh") {
    await loadScmOrders();
  }
  if (action === "filter-po-type") {
    const nextType = target.dataset.value || "";
    scmPoTypeFilter = scmPoTypeFilter === nextType ? "" : nextType;
    selectedScmOrderId = "";
    scmGroupSelection = new Set();
    await loadScmOrders();
    return;
  }
  if (action === "clear-inputs") {
    scmLineInputs = {};
    scmSummaryOpen = false;
    renderScm();
  }
  if (action === "create-split") {
    if (!scmSelectedLineCount()) {
      scmNotice = "Select at least one line quantity.";
      renderScm();
      return;
    }
    scmSummaryOpen = true;
    scmDestinationLocationId = scmDefaultDestinationLocationId(scmSelectedOrder());
    scmPickupPoint = scmDefaultPickupPoint(scmSelectedOrder());
    scmNotice = "";
    renderScm();
  }
  if (action === "close-summary") {
    scmSummaryOpen = false;
    scmDestinationLocationId = "";
    scmPickupPoint = "";
    renderScm();
  }
  if (action === "confirm-create-split") {
    await createScmSplit();
  }
  if (action === "update-po-ref") {
    await updateScmPoRef();
  }
  if (action === "clear-po-ref") {
    scmRenameRef = "";
    await updateScmPoRef({ clear: true });
  }
  if (action === "update-split") {
    await updateScmSplit();
  }
  if (action === "update-split-ref") {
    await updateScmSplitRef();
  }
  if (action === "unsplit-order") {
    await unsplitScmOrder();
  }
  if (action === "save-scm-schedule") {
    await saveScmScheduleForSelected();
  }
  if (action === "create-scm-group") {
    await createScmGroupForSelected();
  }
  if (action === "cancel-scm-group") {
    await cancelScmGroup(target.dataset.group || "");
  }
});

scmApp.addEventListener("input", (event) => {
  const target = event.target;
  if (target.id === "scmSearchInput") {
    scmSearch = target.value;
    clearTimeout(window.__scmSearchTimer);
    window.__scmSearchTimer = setTimeout(loadScmOrders, 250);
    return;
  }
  if (target.dataset.action === "new-ref") {
    scmRef = target.value;
    return;
  }
  if (target.dataset.action === "rename-ref") {
    scmRenameRef = target.value;
    return;
  }
  if (target.dataset.action === "line-search") {
    scmLineSearch = target.value;
    renderScm();
    return;
  }
  if (target.dataset.action === "line-qty") {
    const input = scmInputForLine(target.dataset.line);
    input[target.dataset.field] = scmNumber(target.value);
    const item = scmSelectedOrder()?.items?.find((candidate) => String(candidate.lineRowId) === String(target.dataset.line));
    const weight = scmApp.querySelector(`[data-scm-line-weight="${CSS.escape(String(target.dataset.line || ""))}"]`);
    if (item && weight) weight.textContent = scmLineWeightText(item, input);
  }
});

scmApp.addEventListener("change", (event) => {
  const target = event.target;
  if (target.dataset.action === "split-destination-yard" || target.dataset.action === "existing-split-destination-yard") {
    scmDestinationLocationId = target.value;
  }
  if (target.dataset.action === "split-pickup-yard" || target.dataset.action === "existing-split-pickup-yard" || target.dataset.action === "existing-pickup-yard") {
    scmPickupPoint = target.value;
  }
  if (target.dataset.action === "filter-dropoff") {
    scmDropoffFilter = target.value;
    selectedScmOrderId = "";
    scmGroupSelection = new Set();
    loadScmOrders();
  }
  if (target.dataset.action === "filter-vendor") {
    scmVendorFilter = target.value;
    selectedScmOrderId = "";
    scmGroupSelection = new Set();
    loadScmOrders();
  }
  if (target.dataset.action === "filter-pickup") {
    scmPickupFilter = target.value;
    selectedScmOrderId = "";
    scmGroupSelection = new Set();
    loadScmOrders();
  }
});

window.addEventListener("mbbs-language-changed", renderScm);

requireDispatchLogin({
  mount: scmApp,
  roles: ["admin", "scm", "scm_staff", "dispatcher"],
  async onReady(operator) {
    scmOperator = operator;
    if (scmInitialOrderRef) scmSearch = scmInitialOrderRef;
    await loadScmOrders();
  }
});

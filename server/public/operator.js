const LOCATIONS = [
  { id: 1, text: "3445" },
  { id: 13, text: "2967" }
];

const ORDER_PAGE_SIZE = 4;
const LINE_PAGE_SIZE = 3;
const PICKABLE_ITEM_TYPES = new Set(["InvtPart", "NonInvtPart"]);

const app = document.getElementById("app");
const toast = document.getElementById("toast");

const TOKEN_KEY = "mbbs.operator.token";
let authToken = localStorage.getItem(TOKEN_KEY) || "";
let operator = null;

let locationId = Number(localStorage.getItem("mbbs.operator.locationId") || localStorage.getItem("mbbs.delivery.locationId") || 0);
let currentModule = "menu";
let viewMode = "active";
let orders = [];
let selectedId = null;
let selectedOrder = null;
let selectedLineId = null;
let orderPage = 0;
let linePage = 0;
let installPromptEvent = null;
let appInstalled = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
let fulfillmentOrder = null;
let fulfillmentPhotoDataUrl = "";
let fulfillmentSubmitting = false;
let fulfillmentResult = null;
let fulfillmentCameraStream = null;
let fulfillmentCameraActive = false;
let fulfillmentStatusText = "";
let fulfillmentJobStage = "";
let fulfillmentStartedAt = 0;
let fulfillmentProgressTimer = null;

let cycleStep = "type";
let cycleSelection = { productType: "", brand: "", series: "" };
let cycleSearch = "";
let cycleFacets = { productTypes: [], brands: [], series: [] };
let inventoryItems = [];
let selectedInventoryItem = null;
let cycleDraft = null;
let cyclePage = 0;
let activeCycleUnit = "";
let cycleValues = {};
let cycleConfirming = false;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 1800);
}

function installLabel() {
  if (appInstalled) return "App mode";
  if (installPromptEvent) return "Install app";
  return "Use browser install";
}

function renderInstallButton() {
  if (appInstalled) return `<span class="install-status">App mode</span>`;
  return `<button class="secondary-button install-button" data-action="install-app" type="button">${installLabel()}</button>`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
    ...options
  });
  if (response.status === 401) {
    authToken = "";
    operator = null;
    localStorage.removeItem(TOKEN_KEY);
    renderLogin("Login expired. Please login again.");
    throw new Error("Login required");
  }
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function publicApi(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function currentLocation() {
  return LOCATIONS.find((location) => location.id === Number(locationId));
}

function statusText(status) {
  return {
    open: "Open",
    preparing: "Preparing",
    packed: "Packed",
    fulfilled: "Fulfilled"
  }[status] || "Open";
}

function orderWarningCount(order) {
  return qty(order?.warning_count);
}

function orderUnderpackCount(order) {
  return qty(order?.underpack_count);
}

function orderStatusText(order) {
  if (orderWarningCount(order)) return "Warning";
  if (orderUnderpackCount(order) && order?.operator_status === "packed") return "Underpack";
  return statusText(order?.operator_status);
}

function orderStatusClass(order) {
  if (orderWarningCount(order)) return "warning";
  if (orderUnderpackCount(order) && order?.operator_status === "packed") return "underpack";
  return order?.operator_status || "open";
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleDateString();
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

function exceptionText(line) {
  if (line.sync_exception === "line_deleted") {
    return "Line removed in NetSuite. Unpack this line and repack the order.";
  }
  if (line.sync_exception === "qty_reduced") {
    return "Required qty changed in NetSuite. Unpack this line and repack with the new qty.";
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
  return PICKABLE_ITEM_TYPES.has(line.item_type);
}

function visibleLines(order) {
  return (order?.lines || []).filter((line) => {
    if (line.sync_exception && hasPackedQty(line)) return viewMode === "packed";
    if (!isPickableLine(line)) return false;
    return viewMode === "packed" ? hasPackedQty(line) : hasRemainingQty(line);
  });
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
    || qty(line.packed_piece_qty) > 0;
}

function hasRemainingQty(line) {
  return remainingValue(line, "pallets") > 0
    || remainingValue(line, "sections") > 0
    || remainingValue(line, "layers") > 0
    || remainingValue(line, "pieces") > 0
    || (!hasCustomPackQty(line) && remainingValue(line, "sales") > 0);
}

function isUnderPacked(line) {
  return viewMode === "packed" && !line.sync_exception && hasRemainingQty(line);
}

function lineVariableUnit(line) {
  if (hasValue(line.section_qty)) return { key: "sections", label: "SEC", required: line.section_qty, packedKey: "sections" };
  if (hasValue(line.layer_qty)) return { key: "layers", label: "LYR", required: line.layer_qty, packedKey: "layers" };
  if (hasValue(line.piece_qty)) return { key: "pieces", label: "PCS", required: line.piece_qty, packedKey: "pieces" };
  if (!hasCustomPackQty(line)) return { key: "sales", label: line.unit || "Qty", required: line.quantity, packedKey: "sales" };
  return null;
}

function requiredValue(line, unit) {
  if (unit === "pallets") return qty(line.pallet_qty);
  if (unit === "sections") return qty(line.section_qty);
  if (unit === "layers") return qty(line.layer_qty);
  if (unit === "pieces") return qty(line.piece_qty);
  if (unit === "sales") return qty(line.quantity);
  return 0;
}

function packedValue(line, unit) {
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
  return Math.max(0, requiredValue(line, unit) - packedValue(line, unit));
}

function panelValue(line, unit) {
  return viewMode === "packed" ? packedValue(line, unit) : remainingValue(line, unit);
}

function panelLimit(line, unit) {
  return viewMode === "packed" ? requiredValue(line, unit) : remainingValue(line, unit);
}

function currentOrderBlocksMove() {
  return viewMode === "active" && orders.some((order) => order.operator_status === "preparing" && order.preparing_operator_id === operator?.id);
}

function preparingOrderId() {
  return orders.find((order) => order.operator_status === "preparing" && order.preparing_operator_id === operator?.id)?.netsuite_id || null;
}

function pageCount(items, size) {
  return Math.max(1, Math.ceil(items.length / size));
}

function pageItems(items, page, size) {
  return items.slice(page * size, page * size + size);
}

function locationOptions() {
  return LOCATIONS.map((location) => `
    <option value="${location.id}" ${Number(location.id) === Number(locationId) ? "selected" : ""}>${location.text}</option>
  `).join("");
}

function shell(title, subtitle, body, actions = "") {
  app.innerHTML = `
    <header class="topbar">
      <button class="secondary-button" data-action="change-location" type="button">${currentLocation()?.text || "Location"}</button>
      <div class="topbar-title">
        <p>MBBS Yard Operator Application</p>
        <h1>${title}</h1>
        <span>${subtitle}</span>
      </div>
      <div class="topbar-actions">${actions}</div>
    </header>
    ${body}
  `;
}

function renderLogin(message = "") {
  app.innerHTML = `
    <section class="location-screen">
      <form class="location-panel login-panel" data-form="login">
        <p>MBBS Yard Operator Application</p>
        <h1>Operator login</h1>
        ${message ? `<div class="login-message">${message}</div>` : ""}
        <div class="install-hint">
          <strong>${installLabel()}</strong>
          <span>${installPromptEvent ? "Tap Install app to open as a standalone tablet app." : "If this still opens like a browser, use Chrome or Edge on Android/Windows and install from a trusted HTTPS URL."}</span>
        </div>
        <label>
          <span>Username</span>
          <input id="loginUsername" autocomplete="username" required />
        </label>
        <label>
          <span>Password</span>
          <input id="loginPassword" type="password" autocomplete="current-password" required />
        </label>
        <button class="primary-button" type="submit">Login</button>
      </form>
    </section>
  `;
}

function renderLocationSelect() {
  app.innerHTML = `
    <section class="location-screen">
      <div class="location-panel">
        <p>MBBS Yard Operator Application</p>
        <h1>Select working location</h1>
        <label>
          <span>Location</span>
          <select id="locationSelect">${locationOptions()}</select>
        </label>
        <button class="primary-button" data-action="save-location" type="button">Continue</button>
      </div>
    </section>
  `;
}

function render() {
  if (!operator) return renderLogin();
  if (!locationId) return renderLocationSelect();
  if (currentModule === "menu") return renderMenu();
  if (currentModule === "cycle-count") return renderCycleCount();
  if (currentModule === "delivery-fulfill") return renderFulfillmentScreen();

  const title = viewMode === "packed" ? "Packed Orders" : "Delivery Prep";
  const subtitle = `Location ${currentLocation()?.text || locationId}`;
  const topWarnings = viewMode === "packed" ? warningOrders() : [];
  const actions = `
    ${topWarnings.length ? `<button class="top-warning-button" data-action="open-warning-order" data-order="${topWarnings[0].netsuite_id}" type="button">Warning ${topWarnings.length}</button>` : ""}
    <button class="secondary-button" data-action="main-menu" type="button">Menu</button>
    ${renderInstallButton()}
    <button class="primary-button" data-action="sync" type="button">Sync</button>
    <button class="secondary-button" data-action="refresh" type="button">Refresh</button>
    <button class="secondary-button" data-action="logout" type="button">${operator.display_name}</button>
  `;

  shell(title, subtitle, `
    <section class="delivery-grid">
      <aside class="order-panel">
        ${renderOrderPanel()}
      </aside>
      <section class="detail-panel">
        ${selectedOrder ? renderDetailPanel(selectedOrder) : renderEmptyDetail()}
      </section>
    </section>
  `, actions);
}

function renderMenu() {
  shell("Operator Menu", `Location ${currentLocation()?.text || locationId}`, `
    <section class="module-menu">
      <button class="module-tile" data-action="open-module" data-module="customer-pickup" type="button">
        <strong>Customer Pickup</strong>
        <span>Prepare order for customer pickup.</span>
      </button>
      <button class="module-tile" data-action="open-module" data-module="receiving" type="button">
        <strong>Receiving</strong>
        <span>Receive PO and yard stock.</span>
      </button>
      <button class="module-tile" data-action="open-module" data-module="cycle-count" type="button">
        <strong>Cycle Count</strong>
        <span>Check inventory by product, brand, series and SKU.</span>
      </button>
      <button class="module-tile" data-action="open-module" data-module="delivery" type="button">
        <strong>Delivery Prep</strong>
        <span>Pack delivery orders for drivers.</span>
      </button>
      <button class="module-tile" data-action="open-module" data-module="pallet-return" type="button">
        <strong>Pallet Return</strong>
        <span>Record returned pallets.</span>
      </button>
      <button class="module-tile" data-action="open-module" data-module="stock-return" type="button">
        <strong>Stock Return</strong>
        <span>Return stock by sales order.</span>
      </button>
    </section>
  `, `
    ${renderInstallButton()}
    <button class="secondary-button" data-action="change-location" type="button">Location</button>
    <button class="secondary-button" data-action="logout" type="button">${operator.display_name}</button>
  `);
}

function cycleStepTitle() {
  if (cycleSearch.trim()) return "Search Results";
  if (cycleStep === "type") return "Select Product Type";
  if (cycleStep === "brand") return "Select Brand";
  if (cycleStep === "series") return "Select Series";
  return "Select SKU";
}

function renderCycleCount() {
  shell("Cycle Count", `Location ${currentLocation()?.text || locationId}`, `
    <section class="cycle-shell">
      <div class="cycle-toolbar">
        <button class="secondary-button" data-action="main-menu" type="button">Menu</button>
        <button class="secondary-button" data-action="cycle-back" type="button">Back</button>
        <label class="cycle-search">
          <span>Search SKU</span>
          <input id="cycleSearch" value="${cycleSearch}" placeholder="Search item, brand, series..." />
        </label>
      </div>
      <div class="cycle-crumbs">
        <span>${cycleSelection.productType || "Type"}</span>
        <span>${cycleSelection.brand || "Brand"}</span>
        <span>${cycleSelection.series || "Series"}</span>
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
          <strong>${option.value || "Unassigned"}</strong>
          <span>${option.count} SKU</span>
        </button>
      `).join("") || `<div class="empty-state small"><strong>No options</strong><span>Sync inventory first.</span></div>`}
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
            <div class="measure"><span>UOM</span><b>${item.stock_unit || "-"}</b></div>
            <div class="measure"><span>Count</span><b>Blind</b></div>
          </div>
        </button>
      `).join("") || `<div class="empty-state small"><strong>No SKU</strong><span>Try search or sync inventory.</span></div>`}
    </div>
    <div class="pagination-row">
      <button class="secondary-button" data-action="cycle-prev" ${cyclePage === 0 ? "disabled" : ""} type="button">Previous</button>
      <strong>${cyclePage + 1} / ${count}</strong>
      <button class="secondary-button" data-action="cycle-next" ${cyclePage >= count - 1 ? "disabled" : ""} type="button">Next</button>
    </div>
  `;
}

function renderCycleCountPanel(item) {
  const countUnits = itemCountUnits(item);
  if (!countUnits.some((unit) => unit.key === activeCycleUnit)) activeCycleUnit = countUnits[0]?.key || "";
  return `
    <div class="selected-header cycle-selected-header">
      <span>Selected SKU</span>
      <strong>${item.item_name}</strong>
      <p>${item.item_description || item.display_name || ""}</p>
    </div>
    <div class="selected-measures cycle-conversion-measures">
      ${countUnits.map((unit) => `<div class="measure"><span>1 ${unit.label}</span><b>${displayQty(unit.conversion)}</b></div>`).join("")}
    </div>
    <div class="cycle-count-fields">
      ${countUnits.map((unit) => `
        <button class="cycle-count-field ${activeCycleUnit === unit.key ? "active" : ""}" data-action="select-cycle-unit" data-unit="${unit.key}" type="button">
          <span>Counted ${unit.label}</span>
          <strong data-cycle-display="${unit.key}">${cycleValues[unit.key] || 0}</strong>
        </button>
      `).join("")}
    </div>
    <div class="cycle-number-pad">
      ${["1", "2", "3", "4", "5", "6", "7", "8", "9", "Clear", "0", "Back"].map((key) => `
        <button data-action="cycle-key" data-key="${key}" type="button">${key}</button>
      `).join("")}
    </div>
    <div class="cycle-variance" data-cycle-variance>
      <div><span>Counted total</span><strong>0</strong></div>
      <div><span>Mode</span><strong>Blind</strong></div>
    </div>
    <div class="selected-actions">
      <button class="primary-button" data-action="confirm-cycle-line" ${cycleConfirming ? "disabled" : ""} type="button">${cycleConfirming ? "Confirming..." : "Confirm line"}</button>
    </div>
  `;
}

function renderCycleSummary() {
  const lines = cycleDraft?.lines || [];
  return `
    <div class="selected-header">
      <span>Current count</span>
      <strong>${lines.length} confirmed line</strong>
      <p>Confirmed lines stay in this draft until Submit.</p>
    </div>
    <div class="cycle-summary">
      ${lines.slice(0, 6).map((line) => `
        <button class="${selectedInventoryItem?.item_id === line.item_id ? "active" : ""}" data-action="edit-cycle-line" data-line="${line.id}" type="button">
          <strong>${line.item_name}</strong>
          <span>${displayQty(line.counted_pallet_qty)} PLT / ${displayQty(line.counted_layer_qty)} LYR / ${displayQty(line.counted_section_qty)} SEC / ${displayQty(line.counted_piece_qty)} PCS</span>
          <span>Total ${displayQty(line.counted_total_qty)} | Var ${displaySignedQty(line.variance_qty)}</span>
        </button>
      `).join("") || `<span class="muted">No lines confirmed yet.</span>`}
    </div>
    <div class="selected-actions">
      <button class="primary-button" data-action="submit-cycle-count" ${lines.length ? "" : "disabled"} type="button">Submit</button>
    </div>
  `;
}

function renderOrderPanel() {
  const count = pageCount(orders, ORDER_PAGE_SIZE);
  orderPage = Math.min(orderPage, count - 1);
  const visible = pageItems(orders, orderPage, ORDER_PAGE_SIZE);

  return `
    <div class="panel-title">
      <div class="order-panel-title">
        <span>${viewMode === "packed" ? "Packed" : "Not packed"}</span>
        <div class="panel-segment">
          <button class="${viewMode === "active" ? "active" : ""}" data-action="view-active" type="button">Active</button>
          <button class="${viewMode === "packed" ? "active" : ""}" data-action="view-packed" type="button">Packed</button>
        </div>
      </div>
      <strong>${orders.length}</strong>
    </div>
    ${renderPackedWarningNotice()}
    <div class="order-list">
      ${visible.map((order) => `
        <button class="order-card ${String(order.netsuite_id) === String(selectedId) ? "active" : ""} ${orderWarningCount(order) ? "warning" : ""} ${orderUnderpackCount(order) && order.operator_status === "packed" ? "underpack" : ""}" data-order="${order.netsuite_id}" type="button">
          <strong>${order.tranid}</strong>
          <span class="muted">${formatDate(order.trandate)} | ${order.outbound_location || ""}</span>
          <span class="status-pill ${orderStatusClass(order)}">${orderStatusText(order)}</span>
        </button>
      `).join("") || `<div class="empty-state small"><strong>No orders</strong><span>Sync from NetSuite.</span></div>`}
    </div>
    <div class="pagination-row">
      <button class="secondary-button" data-action="order-prev" ${orderPage === 0 ? "disabled" : ""} type="button">Previous</button>
      <strong>${orderPage + 1} / ${count}</strong>
      <button class="secondary-button" data-action="order-next" ${orderPage >= count - 1 ? "disabled" : ""} type="button">Next</button>
    </div>
  `;
}

function renderPackedWarningNotice() {
  const warnings = viewMode === "packed" ? warningOrders() : [];
  if (!warnings.length) return "";
  const lines = warnings.reduce((total, order) => total + orderWarningCount(order), 0);
  return `
    <button class="order-warning-notice" data-action="open-warning-order" data-order="${warnings[0].netsuite_id}" type="button">
      <strong>Warning</strong>
      <span>${warnings.length} order / ${lines} line needs adjustment</span>
    </button>
  `;
}

function renderEmptyDetail() {
  return `
    <div class="empty-state">
      <strong>Select delivery order</strong>
      <span>Tap an order on the left to load details.</span>
    </div>
  `;
}

function renderDetailPanel(order) {
  const lines = visibleLines(order);
  const exceptions = exceptionLines(order);
  const count = pageCount(lines, LINE_PAGE_SIZE);
  linePage = Math.min(linePage, count - 1);
  const visible = pageItems(lines, linePage, LINE_PAGE_SIZE);
  const confirmed = lines.filter((line) => line.confirmed).length;
  const selectedLine = lines.find((line) => String(line.id) === String(selectedLineId)) || visible[0] || lines[0];
  if (selectedLine && String(selectedLineId) !== String(selectedLine.id)) selectedLineId = selectedLine.id;

  return `
    <div class="detail-header">
      <div>
        <div class="order-title-row">
          <h2>${order.tranid}</h2>
          ${viewMode === "packed" ? `<button class="secondary-button danger-button compact-action" data-action="unpack-order" type="button">Unpack whole order</button>` : ""}
        </div>
        <p class="muted">${order.customer || ""}</p>
        <p class="muted">${formatDate(order.trandate)} | ${order.delivery_method || ""}</p>
      </div>
      <div class="status-actions">
        <span class="status-pill ${orderStatusClass(order)}">${orderStatusText(order)}</span>
        ${viewMode === "packed"
          ? `<button class="primary-button" data-action="start-fulfill" type="button">Fulfill</button>`
          : `<button class="secondary-button" data-action="set-preparing" type="button">Preparing</button>
             <button class="primary-button" data-action="set-packed" type="button">Packed</button>`}
      </div>
    </div>
    <div class="progress-strip">
      <div><span>${viewMode === "packed" ? "Packed lines" : "Open lines"}</span><strong>${confirmed} / ${lines.length}</strong></div>
      <div><span>Location</span><strong>${currentLocation()?.text}</strong></div>
      <div><span>Status</span><strong>${orderStatusText(order)}</strong></div>
    </div>
    ${exceptions.length ? `
      <div class="sync-alert">
        <strong>${exceptions.length} line needs repack</strong>
        <span>NetSuite changed after packing. Unpack the affected line, then pack again with the latest required qty.</span>
      </div>
    ` : ""}
    <div class="work-area">
      <div class="line-column">
        <div class="line-list">
          ${visible.map((line) => renderLine(line)).join("") || `<div class="empty-state small"><strong>No lines</strong><span>Sync details for this order.</span></div>`}
        </div>
        <div class="pagination-row">
          <button class="secondary-button" data-action="line-prev" ${linePage === 0 ? "disabled" : ""} type="button">Previous</button>
          <strong>${linePage + 1} / ${count}</strong>
          <button class="secondary-button" data-action="line-next" ${linePage >= count - 1 ? "disabled" : ""} type="button">Next</button>
        </div>
      </div>
      ${selectedLine ? renderSelectedLinePanel(selectedLine) : renderEmptyDetail()}
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
  if (fulfillmentResult) {
    return shell("Fulfillment Complete", `Order ${order.tranid}`, `
      <section class="fulfillment-screen">
        <div class="fulfillment-card success">
          <span>Item Fulfillment</span>
          <strong>${fulfillmentResult.itemFulfillmentTranid || fulfillmentResult.itemFulfillmentId || "Created"}</strong>
          <p>${fulfillmentResult.fulfillmentStatus === "partial_fulfilled" ? "Partial fulfilled. Remaining open qty will stay in Active." : "Fulfilled. This order will leave delivery prep."}</p>
        </div>
        <div class="selected-actions">
          <button class="primary-button" data-action="finish-fulfill" type="button">Back to Delivery</button>
        </div>
      </section>
    `, `<button class="secondary-button" data-action="finish-fulfill" type="button">Delivery</button>`);
  }
  return shell("Fulfill Order", `${order.tranid} | Location ${currentLocation()?.text || ""}`, `
    <section class="fulfillment-screen">
      <div class="fulfillment-card">
        <span>Photo proof</span>
        <strong>Loaded on truck</strong>
        <div class="camera-actions">
          <button class="primary-button" data-action="start-camera" type="button">${fulfillmentCameraActive ? "Restart camera" : "Open camera"}</button>
          <button class="secondary-button" data-action="choose-photo-file" type="button">Choose file</button>
          <input id="fulfillmentPhoto" accept="image/*" capture="environment" type="file" />
        </div>
        ${fulfillmentCameraActive ? `
          <video class="camera-preview" id="fulfillmentCamera" autoplay muted playsinline></video>
          <button class="primary-button" data-action="capture-photo" type="button">Capture photo</button>
        ` : fulfillmentPhotoDataUrl ? `<img class="photo-preview" src="${fulfillmentPhotoDataUrl}" alt="Truck loading proof" />` : `<div class="photo-placeholder">Open camera and take 1 photo before confirming fulfillment.</div>`}
      </div>
      <div class="fulfillment-card">
        <span>Packed qty to send</span>
        <strong>${packedLines.length} line</strong>
        <div class="fulfillment-lines">
          ${packedLines.map((line) => `
            <div>
              <b>${line.sku || line.item_name}</b>
              <span>${displayQty(line.packed_pallet_qty)} PLT / ${displayQty(line.packed_section_qty)} SEC / ${displayQty(line.packed_layer_qty)} LYR / ${displayQty(line.packed_piece_qty)} PCS</span>
            </div>
          `).join("") || `<p class="muted">No packed qty.</p>`}
        </div>
      </div>
      <div class="selected-actions">
        ${fulfillmentSubmitting ? `<div class="sync-alert"><strong>${fulfillmentJobStage || "Posting to NetSuite"}</strong><span>${fulfillmentStatusText || "Creating Item Fulfillment..."}${fulfillmentStartedAt ? ` (${Math.max(1, Math.round((Date.now() - fulfillmentStartedAt) / 1000))}s)` : ""}</span></div>` : ""}
        ${!fulfillmentSubmitting && fulfillmentJobStage === "Fulfillment failed" ? `<div class="sync-alert danger"><strong>Fulfillment failed</strong><span>${fulfillmentStatusText}</span></div>` : ""}
        <button class="primary-button" data-action="confirm-fulfill" ${fulfillmentPhotoDataUrl && !fulfillmentSubmitting ? "" : "disabled"} type="button">${fulfillmentSubmitting ? "Fulfilling..." : "Confirm Fulfill"}</button>
      </div>
    </section>
  `, `
    <button class="secondary-button" data-action="cancel-fulfill" type="button">Back</button>
    <button class="secondary-button" data-action="logout" type="button">${operator.display_name}</button>
  `);
}

function renderLine(line) {
  const variable = lineVariableUnit(line);
  const notice = exceptionText(line);
  const underPacked = isUnderPacked(line);
  return `
    <button class="line-card ${String(selectedLineId) === String(line.id) ? "active" : ""} ${line.confirmed ? "confirmed" : ""} ${underPacked ? "underpacked" : ""} ${notice ? "exception" : ""}" data-line="${line.id}" type="button">
      <div class="line-info">
        <strong>${line.sku || line.item_name}</strong>
        <span>${line.item_description || ""}</span>
        ${notice ? `<em>${notice}</em>` : ""}
        ${underPacked ? `<em class="underpack-note">Still has open qty</em>` : ""}
      </div>
      <div class="required-measures">
        <div class="measure"><span>${viewMode === "packed" ? "Packed" : "Open"} PLT</span><b>${displayQty(panelValue(line, "pallets"))}</b></div>
        ${variable ? `<div class="measure"><span>${viewMode === "packed" ? "Packed" : "Open"} ${variable.label}</span><b>${displayQty(panelValue(line, variable.packedKey))}</b></div>` : ""}
      </div>
    </button>
  `;
}

function renderSelectedLinePanel(line) {
  const variable = lineVariableUnit(line);
  const notice = exceptionText(line);
  const packedActions = notice
    ? `<button class="secondary-button danger-button" data-action="unpack-line" data-line="${line.id}" type="button">Unpack packed qty</button>`
    : `<button class="primary-button" data-action="update-packed-line" data-line="${line.id}" type="button">Update packed qty</button>
       <button class="secondary-button danger-button" data-action="unpack-line" data-line="${line.id}" type="button">Unpack packed qty</button>`;
  return `
    <aside class="selected-panel" data-selected-line="${line.id}">
      <div class="selected-header">
        <span>Selected item</span>
        <strong>${line.sku || line.item_name}</strong>
        <p>${line.item_description || ""}</p>
      </div>
      <div class="selected-measures">
        <div class="measure"><span>Required PLT</span><b>${displayQty(line.pallet_qty)}</b></div>
        ${variable ? `<div class="measure"><span>Required ${variable.label}</span><b>${displayQty(variable.required)}</b></div>` : ""}
      </div>
      ${notice ? `<div class="line-alert"><strong>Repack needed</strong><span>${notice}</span></div>` : ""}
      ${notice ? "" : renderStepper("pallets", `${viewMode === "packed" ? "Packed" : "Pack"} PLT`, panelValue(line, "pallets"))}
      ${!notice && variable?.packedKey ? renderStepper(variable.packedKey, `${viewMode === "packed" ? "Packed" : "Pack"} ${variable.label}`, panelValue(line, variable.packedKey)) : ""}
      ${viewMode === "packed"
        ? `<div class="selected-actions">${packedActions}</div>`
        : `<div class="selected-actions"><button class="primary-button" data-action="confirm-line" data-line="${line.id}" type="button">Confirm line</button></div>`}
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

async function loadOrders(options = {}) {
  const status = viewMode === "packed" ? "packed" : "active";
  orders = await api(`/api/delivery/orders?locationId=${locationId}&status=${status}`);
  const preparing = preparingOrderId();
  if (viewMode === "active" && preparing) selectedId = preparing;
  else if (!options.keepSelection) selectedId = orders[0]?.netsuite_id || null;
  if (selectedId && !orders.some((order) => String(order.netsuite_id) === String(selectedId))) {
    selectedId = orders[0]?.netsuite_id || null;
  }
  selectedOrder = null;
  if (selectedId) await loadDetail(selectedId, { silentRender: true });
  render();
}

async function loadDetail(id, options = {}) {
  selectedId = id;
  const order = await api(`/api/delivery/orders/${id}`);
  selectedOrder = order;
  const lines = visibleLines(order);
  if (!selectedLineId || !lines.some((line) => String(line.id) === String(selectedLineId))) {
    selectedLineId = lines[0]?.id || null;
  }
  if (!options.silentRender) render();
}

async function setOrderStatus(status) {
  if (!selectedId) return;
  await api(`/api/delivery/orders/${selectedId}/status`, {
    method: "POST",
    body: JSON.stringify({ status })
  });
  showToast(statusText(status));
  await loadOrders({ keepSelection: status !== "packed" || viewMode === "packed" });
}

async function confirmLine(lineId) {
  const row = app.querySelector(`[data-selected-line="${lineId}"]`);
  const pallets = row.querySelector('[data-pack="pallets"]')?.value || 0;
  const layers = row.querySelector('[data-pack="layers"]')?.value || 0;
  const pieces = row.querySelector('[data-pack="pieces"]')?.value || 0;
  const body = {
    pallets,
    layers,
    pieces: row.querySelector('[data-pack="sales"]')?.value || pieces,
    sections: row.querySelector('[data-pack="sections"]')?.value || 0
  };
  await api(`/api/delivery/orders/${selectedId}/lines/${lineId}/confirm`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  showToast("Line confirmed");
  await loadDetail(selectedId);
}

async function unpackLine(lineId) {
  const line = selectedOrder?.lines?.find((item) => String(item.id) === String(lineId));
  if (!line) return;
  await api(`/api/delivery/orders/${selectedId}/lines/${lineId}/unpack`, {
    method: "POST",
    body: JSON.stringify({
      pallets: packedValue(line, "pallets"),
      layers: packedValue(line, "layers"),
      pieces: packedValue(line, "pieces") || packedValue(line, "sales"),
      sections: packedValue(line, "sections")
    })
  });
  showToast("Line unpacked");
  await loadOrders({ keepSelection: true });
}

async function updatePackedLine(lineId) {
  const row = app.querySelector(`[data-selected-line="${lineId}"]`);
  const body = {
    pallets: row.querySelector('[data-pack="pallets"]')?.value || 0,
    layers: row.querySelector('[data-pack="layers"]')?.value || 0,
    pieces: row.querySelector('[data-pack="sales"]')?.value || row.querySelector('[data-pack="pieces"]')?.value || 0,
    sections: row.querySelector('[data-pack="sections"]')?.value || 0
  };
  await api(`/api/delivery/orders/${selectedId}/lines/${lineId}/packed-quantity`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  showToast("Packed qty updated");
  await loadOrders({ keepSelection: true });
}

async function unpackOrder() {
  if (!selectedId) return;
  await api(`/api/delivery/orders/${selectedId}/unpack`, { method: "POST" });
  showToast("Order unpacked");
  viewMode = "active";
  await loadOrders({ keepSelection: true });
}

async function startFulfillment() {
  if (!selectedOrder) return;
  fulfillmentOrder = selectedOrder;
  fulfillmentPhotoDataUrl = "";
  fulfillmentResult = null;
  fulfillmentSubmitting = false;
  fulfillmentStatusText = "";
  fulfillmentJobStage = "";
  fulfillmentStartedAt = 0;
  currentModule = "delivery-fulfill";
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
    showToast("Camera is not available in this browser.");
    return;
  }
  stopFulfillmentCamera();
  fulfillmentCameraStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" } },
    audio: false
  });
  fulfillmentCameraActive = true;
  fulfillmentPhotoDataUrl = "";
  render();
  window.requestAnimationFrame(attachFulfillmentCamera);
}

function captureFulfillmentPhoto() {
  const video = document.getElementById("fulfillmentCamera");
  if (!video || !video.videoWidth || !video.videoHeight) {
    showToast("Camera preview is not ready yet.");
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  fulfillmentPhotoDataUrl = canvas.toDataURL("image/jpeg", 0.82);
  stopFulfillmentCamera();
  render();
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
  if (!fulfillmentOrder || !fulfillmentPhotoDataUrl || fulfillmentSubmitting) return;
  fulfillmentSubmitting = true;
  fulfillmentStartedAt = Date.now();
  fulfillmentJobStage = "Uploading proof";
  fulfillmentStatusText = "Uploading photo proof to server...";
  window.clearInterval(fulfillmentProgressTimer);
  fulfillmentProgressTimer = window.setInterval(() => {
    if (fulfillmentSubmitting) render();
  }, 1000);
  render();
  try {
    const started = await api(`/api/delivery/orders/${fulfillmentOrder.netsuite_id}/fulfill`, {
      method: "POST",
      body: JSON.stringify({ photoDataUrl: fulfillmentPhotoDataUrl, locationId })
    });
    fulfillmentJobStage = "Queued";
    fulfillmentStatusText = "Waiting for NetSuite IF number...";
    render();
    fulfillmentResult = await pollFulfillmentJob(started.jobId);
    showToast("Fulfillment posted to NetSuite");
  } catch (error) {
    fulfillmentJobStage = "Fulfillment failed";
    fulfillmentStatusText = error.message;
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
    fulfillmentStatusText = job.message || `Still posting... ${attempt + 1}s`;
    render();
  }
  throw new Error("NetSuite fulfillment is still running. Please check Delivery Fulfillment in control panel.");
}

async function finishFulfillment() {
  stopFulfillmentCamera();
  currentModule = "delivery";
  fulfillmentOrder = null;
  fulfillmentPhotoDataUrl = "";
  fulfillmentResult = null;
  fulfillmentStatusText = "";
  fulfillmentJobStage = "";
  fulfillmentStartedAt = 0;
  viewMode = "active";
  await loadOrders();
}

async function openModule(moduleName) {
  if (moduleName === "delivery") {
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
  showToast("This module is next.");
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
  const max = unit.startsWith("cycle-") ? Number.POSITIVE_INFINITY : selectedLine ? panelLimit(selectedLine, unit) : Number.POSITIVE_INFINITY;
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
    defaultValues[1].textContent = "Blind";
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
  values[1].textContent = "Blind";
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
      authToken = "";
      operator = null;
      localStorage.removeItem(TOKEN_KEY);
      return renderLogin();
    }
    if (button.dataset.action === "main-menu") {
      stopFulfillmentCamera();
      currentModule = "menu";
      selectedId = null;
      selectedOrder = null;
      selectedInventoryItem = null;
      return render();
    }
    if (button.dataset.action === "open-module") return openModule(button.dataset.module);
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
      localStorage.setItem("mbbs.operator.locationId", String(value));
      orderPage = 0;
      linePage = 0;
      currentModule = "menu";
      return render();
    }
    if (button.dataset.action === "change-location") {
      localStorage.removeItem("mbbs.operator.locationId");
      locationId = 0;
      selectedId = null;
      selectedOrder = null;
      return render();
    }
    if (button.dataset.action === "view-active") {
      viewMode = "active";
      orderPage = 0;
      selectedId = null;
      return loadOrders();
    }
    if (button.dataset.action === "view-packed") {
      if (currentOrderBlocksMove()) return showToast("Pack current order before moving on.");
      viewMode = "packed";
      orderPage = 0;
      selectedId = null;
      return loadOrders();
    }
    if (button.dataset.action === "sync") {
      await api("/api/delivery/sync", {
        method: "POST",
        body: JSON.stringify({ locationId })
      });
      showToast("Synced from NetSuite");
      return loadOrders({ keepSelection: true });
    }
    if (button.dataset.action === "refresh") return loadOrders({ keepSelection: true });
    if (button.dataset.action === "open-warning-order") {
      selectedId = button.dataset.order;
      linePage = 0;
      selectedLineId = null;
      const index = orders.findIndex((order) => String(order.netsuite_id) === String(selectedId));
      if (index >= 0) orderPage = Math.floor(index / ORDER_PAGE_SIZE);
      return loadDetail(selectedId);
    }
    if (button.dataset.action === "order-prev") {
      if (currentOrderBlocksMove()) return showToast("Pack current order before moving on.");
      orderPage = Math.max(0, orderPage - 1);
      return render();
    }
    if (button.dataset.action === "order-next") {
      if (currentOrderBlocksMove()) return showToast("Pack current order before moving on.");
      orderPage = Math.min(pageCount(orders, ORDER_PAGE_SIZE) - 1, orderPage + 1);
      return render();
    }
    if (button.dataset.action === "line-prev") {
      const lines = visibleLines(selectedOrder);
      linePage = Math.max(0, linePage - 1);
      selectedLineId = pageItems(lines, linePage, LINE_PAGE_SIZE)[0]?.id || selectedLineId;
      return render();
    }
    if (button.dataset.action === "line-next") {
      const lines = visibleLines(selectedOrder);
      linePage = Math.min(pageCount(lines, LINE_PAGE_SIZE) - 1, linePage + 1);
      selectedLineId = pageItems(lines, linePage, LINE_PAGE_SIZE)[0]?.id || selectedLineId;
      return render();
    }
    if (button.dataset.action === "step-qty") return stepQty(button.dataset.unit, button.dataset.delta);
    if (button.dataset.action === "set-preparing") return setOrderStatus("preparing");
    if (button.dataset.action === "set-packed") return setOrderStatus("packed");
    if (button.dataset.action === "start-fulfill") return startFulfillment();
    if (button.dataset.action === "cancel-fulfill") {
      stopFulfillmentCamera();
      currentModule = "delivery";
      fulfillmentOrder = null;
      fulfillmentPhotoDataUrl = "";
      fulfillmentResult = null;
      fulfillmentStatusText = "";
      fulfillmentJobStage = "";
      fulfillmentStartedAt = 0;
      return render();
    }
    if (button.dataset.action === "confirm-fulfill") return confirmFulfillment();
    if (button.dataset.action === "finish-fulfill") return finishFulfillment();
    if (button.dataset.action === "start-camera") return startFulfillmentCamera();
    if (button.dataset.action === "capture-photo") return captureFulfillmentPhoto();
    if (button.dataset.action === "choose-photo-file") return document.getElementById("fulfillmentPhoto")?.click();
    if (button.dataset.action === "confirm-line") return confirmLine(button.dataset.line);
    if (button.dataset.action === "unpack-line") return unpackLine(button.dataset.line);
    if (button.dataset.action === "update-packed-line") return updatePackedLine(button.dataset.line);
    if (button.dataset.action === "unpack-order") return unpackOrder();
    if (button.dataset.order) {
      const preparing = preparingOrderId();
      if (preparing && String(button.dataset.order) !== String(preparing)) {
        return showToast("Pack current order before moving on.");
      }
      linePage = 0;
      selectedLineId = null;
      return loadDetail(button.dataset.order);
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

app.addEventListener("change", async (event) => {
  if (event.target?.id !== "fulfillmentPhoto") return;
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    stopFulfillmentCamera();
    fulfillmentPhotoDataUrl = await readPhotoFile(file);
    render();
  } catch (error) {
    showToast(error.message);
  }
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
    authToken = result.token;
    operator = result.operator;
    localStorage.setItem(TOKEN_KEY, authToken);
    showToast(`Welcome ${operator.display_name}`);
    render();
  } catch (error) {
    renderLogin("Invalid username or password.");
  }
});

async function boot() {
  if (!authToken) {
    const bootstrap = await publicApi("/api/auth/bootstrap-needed").catch(() => ({ needed: false }));
    return renderLogin(bootstrap.needed ? "No operator account yet. Open /control to create the first admin account." : "");
  }
  try {
    const result = await api("/api/auth/me");
    operator = result.operator;
    render();
  } catch (error) {
    renderLogin("Please login to continue.");
  }
}

boot();
setInterval(() => {
  if (operator && locationId && currentModule === "delivery") loadOrders({ keepSelection: true }).catch((error) => showToast(error.message));
}, 60000);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  });
}

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

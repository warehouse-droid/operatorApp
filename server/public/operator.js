const LOCATIONS = [
  { id: 1, text: "3445" },
  { id: 13, text: "2967" },
  { id: 15, text: "12441" }
];

const ORDER_PAGE_SIZE = 4;
const LINE_PAGE_SIZE = 3;
const HISTORY_PAGE_SIZE = 5;
const PICKABLE_ITEM_TYPES = new Set(["InvtPart", "NonInvtPart"]);

const app = document.getElementById("app");
const toast = document.getElementById("toast");

const TOKEN_KEY = "mbbs.operator.token";
let authToken = localStorage.getItem(TOKEN_KEY) || "";
let operator = null;

let locationId = Number(localStorage.getItem("mbbs.operator.locationId") || localStorage.getItem("mbbs.delivery.locationId") || 0);
let currentModule = "menu";
let viewMode = "active";
let deliveryOrderType = localStorage.getItem("mbbs.operator.deliveryOrderType") || "sales_order";
let orders = [];
let operatorRequests = [];
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

let receivingStep = "type";
let receivingOrderType = "purchase_order";
let receivingVendors = [];
let receivingSources = [];
let receivingOrders = [];
let receivingSelectedVendor = "";
let receivingSelectedSourceId = "";
let receivingSelectedId = null;
let receivingSelectedOrder = null;
let receivingSearch = "";
let receivingItemSearch = "";
let receivingItemSuggestions = [];
let receivingOrderPage = 0;
let receivingLinePage = 0;
let receivingSelectedLineId = null;
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
let personalHistoryDate = new Date().toISOString().slice(0, 10);
let selectedHistoryId = "";
let historyReportReason = "";
let historyPage = 0;
let eventSource = null;
let eventRefreshTimer = null;

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
    if (event.type === "connected" || !operator || !locationId) return;
    const deliveryEvents = [
      "dispatch.plan.confirmed",
      "dispatch.operator_request.created",
      "delivery.order.updated",
      "delivery.line.confirmed",
      "delivery.line.updated",
      "delivery.order.unpacked",
      "delivery.order.loaded",
      "dispatch.orders.updated"
    ];
    const receivingEvents = [
      "dispatch.co.updated",
      "receiving.line.confirmed",
      "receiving.order.received",
      "dispatch.vendor_yard.updated",
      "dispatch.orders.updated"
    ];
    const needsDelivery = deliveryEvents.includes(event.type);
    const needsReceiving = receivingEvents.includes(event.type);
    if (!needsDelivery && !needsReceiving) return;
    window.clearTimeout(eventRefreshTimer);
    eventRefreshTimer = window.setTimeout(async () => {
      try {
        if (needsDelivery && currentModule === "delivery-select" && !fulfillmentSubmitting) {
          await loadOrders({ keepSelection: true });
          showToast("Orders updated");
          return;
        }
        if (needsReceiving && currentModule === "receiving" && !receiptSubmitting) {
          await loadReceivingOptions();
          if (receivingStep === "orders") await loadReceivingOrders({ keepSelection: true });
          else render();
          showToast("Receiving updated");
          return;
        }
        if (event.type === "dispatch.operator_request.created") {
          showToast("Dispatch request received");
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
  eventSource?.close();
  eventSource = null;
}

function currentLocation() {
  return LOCATIONS.find((location) => location.id === Number(locationId));
}

function statusText(status) {
  return {
    open: "Open",
    preparing: "Preparing",
    packed: "Packed",
    fulfilled: "Fulfilled",
    loaded: "Loaded"
  }[status] || "Open";
}

function orderWarningCount(order) {
  return qty(order?.warning_count);
}

function orderUnderpackCount(order) {
  return qty(order?.underpack_count);
}

function orderStatusText(order) {
  if (order?.local_yard_order_status === "Loaded") return "Loaded";
  if (orderWarningCount(order)) return "Warning";
  if (orderUnderpackCount(order) && order?.operator_status === "packed") return "Underpack";
  return statusText(order?.operator_status);
}

function orderStatusClass(order) {
  if (order?.local_yard_order_status === "Loaded") return "loaded";
  if (orderWarningCount(order)) return "warning";
  if (orderUnderpackCount(order) && order?.operator_status === "packed") return "underpack";
  return order?.operator_status || "open";
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleDateString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
  if (currentModule === "receiving") return receivingRemainingValue(line, unit);
  return viewMode === "packed" ? requiredValue(line, unit) : remainingValue(line, unit);
}

function receivingRemainingSalesQty(line) {
  return Math.max(0, qty(line.quantity) - qty(line.netsuite_received_qty));
}

function receivingRemainingValue(line, unit) {
  const remainingSales = receivingRemainingSalesQty(line);
  if (unit === "sales") return remainingSales;
  const required = requiredValue(line, unit);
  const conversion = unit === "pallets" ? qty(line.to_plt)
    : unit === "layers" ? qty(line.to_lyr)
    : unit === "sections" ? qty(line.to_sec)
    : unit === "pieces" ? qty(line.to_pcs) || 1
    : 0;
  if (!conversion) return required;
  return Math.max(0, Math.min(required, Math.floor((remainingSales / conversion) + 0.000001)));
}

function hasReceivingRemainingQty(line) {
  return receivingRemainingSalesQty(line) > 0;
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
  if (currentModule === "delivery-select") return renderDeliverySelect();
  if (currentModule === "receiving") return renderReceiving();
  if (currentModule === "receiving-receipt") return renderReceiptScreen();
  if (currentModule === "return-select") return renderReturnSelect();
  if (currentModule === "personal-history") return renderPersonalHistory();
  if (currentModule === "delivery-fulfill") return renderFulfillmentScreen();

  const title = viewMode === "packed" ? "Packed Orders" : "Delivery Prep";
  const subtitle = `${deliveryOrderType === "transfer_order" ? "Transfer Order" : "Sales Order"} | Location ${currentLocation()?.text || locationId}`;
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
      <button class="module-tile" data-action="open-module" data-module="return" type="button">
        <strong>Return</strong>
        <span>Pallet return or stock return.</span>
      </button>
      <button class="module-tile" data-action="open-module" data-module="personal-history" type="button">
        <strong>Personal History</strong>
        <span>Review your submitted IF, IR and count records.</span>
      </button>
    </section>
  `, `
    ${renderInstallButton()}
    <button class="secondary-button" data-action="change-location" type="button">Location</button>
    <button class="secondary-button" data-action="logout" type="button">${operator.display_name}</button>
  `);
}

function renderReturnSelect() {
  shell("Return", `Location ${currentLocation()?.text || locationId}`, `
    <section class="module-menu two-up">
      <button class="module-tile" data-action="open-module" data-module="pallet-return" type="button">
        <strong>Pallet Return</strong>
        <span>Record returned pallets from customer.</span>
      </button>
      <button class="module-tile" data-action="open-module" data-module="stock-return" type="button">
        <strong>Stock Return</strong>
        <span>Return stock by sales order.</span>
      </button>
    </section>
  `, `
    <button class="secondary-button" data-action="main-menu" type="button">Menu</button>
    <button class="secondary-button" data-action="logout" type="button">${operator.display_name}</button>
  `);
}

function renderDeliverySelect() {
  shell("Delivery Prep", `Location ${currentLocation()?.text || locationId}`, `
    <section class="module-menu two-up">
      <button class="module-tile" data-action="select-delivery-type" data-order-type="sales_order" type="button">
        <strong>Sales Order</strong>
        <span>Prepare customer delivery orders.</span>
      </button>
      <button class="module-tile" data-action="select-delivery-type" data-order-type="transfer_order" type="button">
        <strong>Transfer Order</strong>
        <span>Prepare stock transfer to another yard.</span>
      </button>
    </section>
  `, `
    <button class="secondary-button" data-action="main-menu" type="button">Menu</button>
    <button class="secondary-button" data-action="logout" type="button">${operator.display_name}</button>
  `);
}

function receivingTypeLabel() {
  if (receivingOrderType === "co_order") return "Transit CO";
  return receivingOrderType === "transfer_order" ? "Transfer Order" : "Purchase Order";
}

function renderReceiving() {
  shell("Receiving", `${receivingTypeLabel()} | Location ${currentLocation()?.text || locationId}`, `
    <section class="receiving-shell">
      <div class="receiving-toolbar">
        <button class="secondary-button" data-action="main-menu" type="button">Menu</button>
        <button class="secondary-button" data-action="receiving-back" type="button">Back</button>
        <label class="receiving-search">
          <span>Search PO / TO number</span>
          <input id="receivingSearch" value="${receivingSearch}" placeholder="Tap keypad or type order number..." />
        </label>
        <label class="receiving-search receiving-search-with-dropdown">
          <span>Search product</span>
          <input id="receivingItemSearch" value="${receivingItemSearch}" placeholder="Item autocomplete..." />
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
        <button class="primary-button" data-action="sync-receiving" type="button">Sync</button>
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
          <strong>Purchase Order</strong>
          <span>Receive vendor purchase orders.</span>
        </button>
        <button class="module-tile" data-action="select-receiving-type" data-order-type="transfer_order" type="button">
          <strong>Transfer Order</strong>
          <span>Receive stock sent from another yard.</span>
        </button>
        <button class="module-tile" data-action="select-receiving-type" data-order-type="co_order" type="button">
          <strong>Transit CO</strong>
          <span>Receive local transit depot stock.</span>
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
            <strong>${receivingOrderType === "purchase_order" ? item.vendor : `From ${item.source_location}`}</strong>
            <span>${item.order_count} open order</span>
          </button>
        `).join("") || `<div class="empty-state"><strong>No open orders</strong><span>Tap Sync to retrieve from NetSuite.</span></div>`}
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
            <span>${receivingSearch.trim() || receivingItemSearch.trim() ? "Orders" : receivingOrderType === "purchase_order" ? "Vendor" : "Source"}</span>
            <strong>${receivingSearch.trim() || receivingItemSearch.trim()
              ? "Search results"
              : receivingOrderType === "purchase_order"
                ? receivingSelectedVendor
                : `From ${sourceLocationText(receivingSelectedSourceId)}`}</strong>
          </div>
          <strong>${receivingOrders.length}</strong>
        </div>
        <div class="number-pad compact-pad">
          ${["1","2","3","4","5","6","7","8","9","Clear","0","Back"].map((key) => `
            <button data-action="receiving-key" data-key="${key}" type="button">${key}</button>
          `).join("")}
        </div>
        <div class="order-list">
          ${visible.map((order) => `
            <button class="order-card ${String(order.netsuite_id) === String(receivingSelectedId) ? "active" : ""}" data-receiving-order="${order.netsuite_id}" type="button">
              <strong>${order.tranid}</strong>
              <span class="muted">${formatDate(order.trandate)} | ${order.line_count || 0} line</span>
              <span class="status-pill open">${order.status_text || "Pending Receipt"}</span>
            </button>
          `).join("") || `<div class="empty-state small"><strong>No order found</strong><span>Try another number or product.</span></div>`}
        </div>
        <div class="pagination-row">
          <button class="secondary-button" data-action="receiving-order-prev" ${receivingOrderPage === 0 ? "disabled" : ""} type="button">Previous</button>
          <strong>${receivingOrderPage + 1} / ${count}</strong>
          <button class="secondary-button" data-action="receiving-order-next" ${receivingOrderPage >= count - 1 ? "disabled" : ""} type="button">Next</button>
        </div>
      </aside>
      <section class="detail-panel">
        ${receivingSelectedOrder ? renderReceivingDetail(receivingSelectedOrder) : `<div class="empty-state"><strong>Select order</strong><span>Tap an open receiving order.</span></div>`}
      </section>
    </section>
  `;
}

function sourceLocationText(id) {
  return LOCATIONS.find((location) => String(location.id) === String(id))?.text || "";
}

function renderReceivingDetail(order) {
  const lines = (order.lines || []).filter((line) => isPickableLine(line) && hasReceivingRemainingQty(line));
  if (!receivingSelectedLineId || !lines.some((line) => String(line.id) === String(receivingSelectedLineId))) {
    receivingSelectedLineId = lines[0]?.id || null;
  }
  const selectedLine = lines.find((line) => String(line.id) === String(receivingSelectedLineId));
  const count = pageCount(lines, LINE_PAGE_SIZE);
  receivingLinePage = Math.min(receivingLinePage, count - 1);
  const visible = pageItems(lines, receivingLinePage, LINE_PAGE_SIZE);
  const confirmedLines = lines.filter((line) => hasReceivedQty(line) && hasReceivingRemainingQty(line));
  return `
    <div class="detail-header">
      <div>
        <h2>${order.tranid}</h2>
        <p class="muted">${receivingOrderType === "purchase_order" ? order.vendor : `From ${order.source_location} to ${order.destination_location}`}</p>
        <p class="muted">${formatDate(order.trandate)} | ${order.status_text}</p>
      </div>
      <button class="primary-button" data-action="start-receive" ${confirmedLines.length ? "" : "disabled"} type="button">Receive</button>
    </div>
    <div class="receiving-detail-grid">
      <div class="line-column receiving-lines">
        <div class="line-list">
          ${visible.map((line) => renderReceivingLine(line)).join("") || `<div class="empty-state small"><strong>No item line</strong><span>This order has no receivable item line.</span></div>`}
        </div>
        <div class="pagination-row">
          <button class="secondary-button" data-action="receiving-line-prev" ${receivingLinePage === 0 ? "disabled" : ""} type="button">Previous</button>
          <strong>${receivingLinePage + 1} / ${count}</strong>
          <button class="secondary-button" data-action="receiving-line-next" ${receivingLinePage >= count - 1 ? "disabled" : ""} type="button">Next</button>
        </div>
      </div>
      ${selectedLine ? renderReceivingSelectedLinePanel(selectedLine) : `<aside class="selected-panel"><div class="empty-state small"><strong>Select line</strong></div></aside>`}
    </div>
  `;
}

function renderReceivingLine(line) {
  const variable = lineVariableUnit(line);
  return `
    <button class="line-card ${String(receivingSelectedLineId) === String(line.id) ? "active" : ""} ${hasReceivedQty(line) ? "confirmed" : ""}" data-action="select-receiving-line" data-line="${line.id}" type="button">
      <div class="line-info">
        <strong>${line.sku || line.item_name}</strong>
        <span>${line.item_description || ""}</span>
        ${hasReceivedQty(line) ? `<em class="underpack-note">Confirmed</em>` : ""}
      </div>
      <div class="required-measures">
        <div class="measure"><span>Open PLT</span><b>${displayQty(receivingRemainingValue(line, "pallets"))}</b></div>
        ${variable ? `<div class="measure"><span>Open ${variable.label}</span><b>${displayQty(receivingRemainingValue(line, variable.packedKey))}</b></div>` : ""}
      </div>
    </button>
  `;
}

function hasReceivedQty(line) {
  return qty(line.received_pallet_qty) > 0
    || qty(line.received_section_qty) > 0
    || qty(line.received_layer_qty) > 0
    || qty(line.received_piece_qty) > 0;
}

function receivingPanelValue(line, unit) {
  if (unit === "pallets") return qty(line.received_pallet_qty) || receivingRemainingValue(line, "pallets");
  if (unit === "sections") return qty(line.received_section_qty) || receivingRemainingValue(line, "sections");
  if (unit === "layers") return qty(line.received_layer_qty) || receivingRemainingValue(line, "layers");
  if (unit === "pieces") return qty(line.received_piece_qty) || receivingRemainingValue(line, "pieces");
  if (unit === "sales") return qty(line.received_piece_qty) || receivingRemainingValue(line, "sales");
  return 0;
}

function renderReceivingSelectedLinePanel(line) {
  const variable = lineVariableUnit(line);
  return `
    <aside class="selected-panel" data-receiving-selected-line="${line.id}">
      <div class="selected-header">
        <span>Selected item</span>
        <strong>${line.sku || line.item_name}</strong>
        <p>${line.item_description || ""}</p>
      </div>
      <div class="selected-measures">
        <div class="measure"><span>Open PLT</span><b>${displayQty(receivingRemainingValue(line, "pallets"))}</b></div>
        ${variable ? `<div class="measure"><span>Open ${variable.label}</span><b>${displayQty(receivingRemainingValue(line, variable.packedKey))}</b></div>` : ""}
      </div>
      ${renderStepper("pallets", "Receive PLT", receivingPanelValue(line, "pallets"))}
      ${variable?.packedKey ? renderStepper(variable.packedKey, `Receive ${variable.label}`, receivingPanelValue(line, variable.packedKey)) : ""}
      <div class="selected-actions">
        <button class="primary-button" data-action="confirm-receiving-line" data-line="${line.id}" type="button">Confirm line</button>
      </div>
    </aside>
  `;
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
    ${renderOperatorRequestNotice()}
    <div class="order-list">
      ${visible.map((order) => {
        const request = operatorRequestForOrder(order);
        return `
        <button class="order-card ${String(order.netsuite_id) === String(selectedId) ? "active" : ""} ${orderWarningCount(order) ? "warning" : ""} ${orderUnderpackCount(order) && order.operator_status === "packed" ? "underpack" : ""} ${request ? "request" : ""}" data-order="${order.netsuite_id}" type="button">
          <strong>${order.tranid}</strong>
          <span class="muted">${formatDate(order.trandate)} | ${order.outbound_location || ""}</span>
          ${order.dispatch_planned ? `<span class="planned-line">Planned ${escapeHtml(order.dispatch_truck_plate || "")} ${escapeHtml(order.dispatch_load_name || "")}${order.dispatch_parking_spot ? ` | Spot ${escapeHtml(order.dispatch_parking_spot)}` : ""}</span>` : ""}
          ${request ? `<span class="request-line">Dispatch asks to unpack for split</span>` : ""}
          <span class="status-pill ${orderStatusClass(order)}">${orderStatusText(order)}</span>
        </button>
      `; }).join("") || `<div class="empty-state small"><strong>No orders</strong><span>Sync from NetSuite.</span></div>`}
    </div>
    <div class="pagination-row">
      <button class="secondary-button" data-action="order-prev" ${orderPage === 0 ? "disabled" : ""} type="button">Previous</button>
      <strong>${orderPage + 1} / ${count}</strong>
      <button class="secondary-button" data-action="order-next" ${orderPage >= count - 1 ? "disabled" : ""} type="button">Next</button>
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
      <strong>Dispatch Request</strong>
      <span>${requests.length} unpack request${requests.length > 1 ? "s" : ""} for split. Tap to handle.</span>
    </button>
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
        ${order.dispatch_planned ? `<p class="dispatch-plan-note">Planned: ${escapeHtml(order.dispatch_truck_plate || "")} ${escapeHtml(order.dispatch_load_name || "")}${order.dispatch_parking_spot ? ` | Parking spot ${escapeHtml(order.dispatch_parking_spot)}` : ""}</p>` : ""}
      </div>
      <div class="status-actions">
        <span class="status-pill ${orderStatusClass(order)}">${orderStatusText(order)}</span>
        ${viewMode === "packed"
          ? `<button class="primary-button" data-action="start-fulfill" type="button">Load</button>`
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
    return shell("Load Complete", `Order ${order.tranid}`, `
      <section class="fulfillment-screen">
        <div class="fulfillment-card success">
          <span>Local Yard Status</span>
          <strong>${fulfillmentResult.localYardOrderStatus || "Loaded"}</strong>
          <p>Photo proof saved. This order is hidden from the operator list.</p>
        </div>
        <div class="selected-actions">
          <button class="primary-button" data-action="finish-fulfill" type="button">Back to Delivery</button>
        </div>
      </section>
    `, `<button class="secondary-button" data-action="finish-fulfill" type="button">Delivery</button>`);
  }
  return shell("Load Order", `${order.tranid} | Location ${currentLocation()?.text || ""}`, `
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
        ` : fulfillmentPhotoDataUrl ? `<img class="photo-preview" src="${fulfillmentPhotoDataUrl}" alt="Truck loading proof" />` : `<div class="photo-placeholder">Open camera and take 1 photo before confirming load.</div>`}
      </div>
      <div class="fulfillment-card">
        <span>Packed qty to load</span>
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
        ${fulfillmentSubmitting ? `<div class="sync-alert"><strong>${fulfillmentJobStage || "Saving load proof"}</strong><span>${fulfillmentStatusText || "Saving local yard status..."}${fulfillmentStartedAt ? ` (${Math.max(1, Math.round((Date.now() - fulfillmentStartedAt) / 1000))}s)` : ""}</span></div>` : ""}
        ${!fulfillmentSubmitting && fulfillmentJobStage === "Load failed" ? `<div class="sync-alert danger"><strong>Load failed</strong><span>${fulfillmentStatusText}</span></div>` : ""}
        <button class="primary-button" data-action="confirm-fulfill" ${fulfillmentPhotoDataUrl && !fulfillmentSubmitting ? "" : "disabled"} type="button">${fulfillmentSubmitting ? "Loading..." : "Load"}</button>
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
  orders = await api(`/api/delivery/orders?locationId=${locationId}&status=${status}&orderType=${deliveryOrderType}`);
  operatorRequests = await api(`/api/operator/requests?locationId=${locationId}&orderType=${deliveryOrderType}&status=open`).catch(() => []);
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
  url.searchParams.set("orderType", receivingOrderType);
  const isSearching = receivingSearch.trim() || receivingItemSearch.trim();
  if (receivingOrderType === "transfer_order" || receivingOrderType === "co_order") {
    if (receivingSelectedSourceId && !isSearching) url.searchParams.set("sourceLocationId", receivingSelectedSourceId);
    url.searchParams.set("destinationLocationId", locationId);
  } else if (receivingSelectedVendor && !isSearching) {
    url.searchParams.set("vendor", receivingSelectedVendor);
  }
  if (receivingOrderType === "purchase_order") url.searchParams.set("destinationLocationId", locationId);
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
  if (receivingOrderType !== "co_order") {
    await api(`/api/receiving/orders/${id}/sync`, {
      method: "POST",
      body: JSON.stringify({
        orderType: receivingOrderType,
        locationId,
        destinationLocationId: locationId,
        sourceLocationId: receivingSelectedSourceId || null
      })
    });
  }
  receivingSelectedOrder = await api(`/api/receiving/orders/${id}`);
  if (!options.silentRender) render();
}

async function loadReceivingItemSuggestions() {
  if (receivingItemSearch.trim().length < 2) {
    receivingItemSuggestions = [];
    return;
  }
  const url = new URL("/api/receiving/items", window.location.origin);
  url.searchParams.set("orderType", receivingOrderType);
  url.searchParams.set("search", receivingItemSearch.trim());
  if (receivingOrderType === "transfer_order" || receivingOrderType === "co_order") {
    url.searchParams.set("destinationLocationId", locationId);
  }
  if (receivingOrderType === "purchase_order") url.searchParams.set("destinationLocationId", locationId);
  receivingItemSuggestions = await api(url.pathname + url.search);
}

async function syncReceiving() {
  await api("/api/receiving/sync", {
    method: "POST",
    body: JSON.stringify({
      orderType: receivingOrderType,
      sourceLocationId: receivingSelectedSourceId || null,
      locationId,
      destinationLocationId: locationId
    })
  });
  showToast("Receiving synced");
  await loadReceivingOptions();
  if (receivingStep === "orders") return loadReceivingOrders({ keepSelection: true });
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
  fulfillmentJobStage = "Saving proof";
  fulfillmentStatusText = "Saving photo proof and local loaded status...";
  window.clearInterval(fulfillmentProgressTimer);
  fulfillmentProgressTimer = window.setInterval(() => {
    if (fulfillmentSubmitting) render();
  }, 1000);
  render();
  try {
    fulfillmentResult = await api(`/api/delivery/orders/${fulfillmentOrder.netsuite_id}/load`, {
      method: "POST",
      body: JSON.stringify({ photoDataUrl: fulfillmentPhotoDataUrl, locationId })
    });
    showToast("Order loaded");
  } catch (error) {
    fulfillmentJobStage = "Load failed";
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

function renderReceiptScreen() {
  const order = receiptOrder || receivingSelectedOrder;
  if (!order) {
    currentModule = "receiving";
    return render();
  }
  const confirmedLines = (order.lines || []).filter((line) => hasReceivedQty(line));
  if (receiptResult) {
    const isLocalCo = (receiptOrder?.order_type || receivingOrderType) === "co_order";
    return shell("Receiving Complete", `Order ${order.tranid}`, `
      <section class="fulfillment-screen">
        <div class="fulfillment-card success">
          <span>${isLocalCo ? "Local CO Received" : "Item Receipt"}</span>
          <strong>${receiptResult.itemReceiptTranid || receiptResult.itemReceiptId || "Created"}</strong>
          <p>${isLocalCo ? "CO is now available in Delivery Prep packed orders for loading." : "Receiving posted to NetSuite."}</p>
        </div>
        <div class="selected-actions">
          <button class="primary-button" data-action="finish-receive" type="button">Back to Receiving</button>
        </div>
      </section>
    `, `<button class="secondary-button" data-action="finish-receive" type="button">Receiving</button>`);
  }
  return shell("Receive Order", `${order.tranid} | Location ${currentLocation()?.text || ""}`, `
    <section class="fulfillment-screen">
      <div class="fulfillment-card">
        <span>Photo proof</span>
        <strong>Truck photos</strong>
        <div class="camera-actions">
          <button class="primary-button" data-action="start-receipt-camera" type="button">${receiptCameraActive ? "Restart camera" : "Open camera"}</button>
          <button class="secondary-button" data-action="choose-receipt-photo-file" type="button">Choose file</button>
          <input id="receiptPhoto" accept="image/*" capture="environment" type="file" />
        </div>
        <div class="photo-slot-row">
          ${[0, 1].map((slot) => `
            <button class="${receiptActivePhotoSlot === slot ? "active" : ""}" data-action="select-receipt-photo-slot" data-slot="${slot}" type="button">
              <strong>Photo ${slot + 1}</strong>
              <span>${receiptPhotoDataUrls[slot] ? "Ready" : "Needed"}</span>
            </button>
          `).join("")}
        </div>
        ${receiptCameraActive ? `
          <video class="camera-preview" id="receiptCamera" autoplay muted playsinline></video>
          <button class="primary-button" data-action="capture-receipt-photo" type="button">Capture photo ${receiptActivePhotoSlot + 1}</button>
        ` : receiptPhotoDataUrls[receiptActivePhotoSlot] ? `<img class="photo-preview" src="${receiptPhotoDataUrls[receiptActivePhotoSlot]}" alt="Receiving proof" />` : `<div class="photo-placeholder">Take 2 truck photos before receiving.</div>`}
      </div>
      <div class="fulfillment-card">
        <span>Confirmed qty to receive</span>
        <strong>${confirmedLines.length} line</strong>
        <div class="fulfillment-lines">
          ${confirmedLines.map((line) => `
            <div>
              <b>${line.sku || line.item_name}</b>
              <span>${displayQty(line.received_pallet_qty)} PLT / ${displayQty(line.received_section_qty)} SEC / ${displayQty(line.received_layer_qty)} LYR / ${displayQty(line.received_piece_qty)} PCS</span>
            </div>
          `).join("") || `<p class="muted">No confirmed qty.</p>`}
        </div>
      </div>
      <div class="selected-actions">
        ${receiptSubmitting ? `<div class="sync-alert"><strong>${receiptJobStage || "Posting to NetSuite"}</strong><span>${receiptStatusText || "Creating Item Receipt..."}${receiptStartedAt ? ` (${Math.max(1, Math.round((Date.now() - receiptStartedAt) / 1000))}s)` : ""}</span></div>` : ""}
        ${!receiptSubmitting && receiptJobStage === "Receiving failed" ? `<div class="sync-alert danger"><strong>Receiving failed</strong><span>${receiptStatusText}</span></div>` : ""}
        <button class="primary-button" data-action="confirm-receive" ${receiptPhotoDataUrls.filter(Boolean).length >= 2 && !receiptSubmitting ? "" : "disabled"} type="button">${receiptSubmitting ? "Receiving..." : "Receive"}</button>
      </div>
    </section>
  `, `
    <button class="secondary-button" data-action="cancel-receive" type="button">Back</button>
    <button class="secondary-button" data-action="logout" type="button">${operator.display_name}</button>
  `);
}

async function confirmReceivingLine(lineId) {
  const row = app.querySelector(`[data-receiving-selected-line="${lineId}"]`);
  if (!row || !receivingSelectedId) return;
  const body = {
    pallets: row.querySelector('[data-pack="pallets"]')?.value || 0,
    layers: row.querySelector('[data-pack="layers"]')?.value || 0,
    pieces: row.querySelector('[data-pack="sales"]')?.value || row.querySelector('[data-pack="pieces"]')?.value || 0,
    sections: row.querySelector('[data-pack="sections"]')?.value || 0
  };
  receivingSelectedOrder = await api(`/api/receiving/orders/${receivingSelectedId}/lines/${lineId}/confirm`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  showToast("Receiving line confirmed");
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
  if (!navigator.mediaDevices?.getUserMedia) return showToast("Camera is not available in this browser.");
  stopReceiptCamera();
  receiptCameraStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" } },
    audio: false
  });
  receiptCameraActive = true;
  render();
  window.requestAnimationFrame(attachReceiptCamera);
}

function captureReceiptPhoto() {
  const video = document.getElementById("receiptCamera");
  if (!video || !video.videoWidth || !video.videoHeight) return showToast("Camera preview is not ready yet.");
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  receiptPhotoDataUrls[receiptActivePhotoSlot] = canvas.toDataURL("image/jpeg", 0.82);
  receiptActivePhotoSlot = Math.min(1, receiptActivePhotoSlot + 1);
  stopReceiptCamera();
  render();
}

async function confirmReceipt() {
  if (!receiptOrder || receiptPhotoDataUrls.filter(Boolean).length < 2 || receiptSubmitting) return;
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
    const started = await api(`/api/receiving/orders/${receiptOrder.netsuite_id}/receive`, {
      method: "POST",
      body: JSON.stringify({
        photoDataUrls: receiptPhotoDataUrls,
        locationId,
        destinationLocationId: locationId,
        orderType: receiptOrder.order_type || receivingOrderType,
        sourceLocationId: receiptOrder.source_location_id || receivingSelectedSourceId || null
      })
    });
    if (started.status === "complete" && started.result) {
      receiptResult = started.result;
      showToast(receivingOrderType === "co_order" ? "CO received and moved to packed list" : "Receiving posted to NetSuite");
      return;
    }
    receiptJobStage = "Queued";
    receiptStatusText = "Waiting for NetSuite IR number...";
    render();
    receiptResult = await pollReceiptJob(started.jobId);
    showToast("Receiving posted to NetSuite");
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
    if (job.status === "error") throw new Error(job.error || "NetSuite receiving failed.");
    receiptJobStage = job.stage || "Posting";
    receiptStatusText = job.message || `Still posting... ${attempt + 1}s`;
    render();
  }
  throw new Error("NetSuite receiving is still running. Please check control panel.");
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
    confirm_line: "Confirm Line",
    item_receipt: "IR",
    item_fulfillment: "IF",
    cycle_count: "Cycle",
    customer_return: "Customer Return"
  }[type] || type || "Record";
}

function renderHistoryPhotos(record) {
  const photos = (record?.photos || []).filter(Boolean);
  if (!photos.length) return "";
  return `
    <div class="history-photo-grid">
      ${photos.map((photo, index) => `<img class="photo-preview" src="${photo}" alt="Record photo ${index + 1}" />`).join("")}
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
  units.push({ label: "Sales", key: salesKey, value: displayQty(line?.[salesKey]) });
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
    return `<div class="empty-state small"><strong>Select a record</strong><span>Tap one history record to view details.</span></div>`;
  }
  return `
    <div class="history-detail-card">
      <div class="detail-header">
        <div>
          <h2>${escapeHtml(record.tranid || record.reference || historyTypeLabel(record.type))}</h2>
          <p>${escapeHtml(historyTypeLabel(record.type))} | ${new Date(record.createdAt).toLocaleString()}</p>
        </div>
        ${record.status ? `<span class="status-pill open">${escapeHtml(record.status)}</span>` : ""}
      </div>
      <div class="progress-strip history-meta">
        <div><span>Reference</span><strong>${escapeHtml(record.reference || "-")}</strong></div>
        <div><span>Action</span><strong>${escapeHtml(record.action || "-")}</strong></div>
        <div><span>Order</span><strong>${escapeHtml(record.orderId || "-")}</strong></div>
      </div>
      ${renderHistoryPhotos(record)}
      ${renderHistoryLineDetails(record)}
      <div class="history-report-box">
        <strong>Report record problem</strong>
        <textarea id="historyReportReason" placeholder="Describe what is wrong for supervisor review.">${escapeHtml(historyReportReason)}</textarea>
        <button class="danger-button" data-action="report-history-error" data-record="${record.id}" type="button">Report Error</button>
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
          <span>Date</span>
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
                <em>${new Date(item.createdAt).toLocaleString()}</em>
                ${item.reference ? `<strong>${escapeHtml(item.reference)}</strong>` : ""}
                ${item.status ? `<i>${escapeHtml(item.status)}</i>` : ""}
              </button>
            `).join("") || `<div class="empty-state small"><strong>No history</strong><span>No operator records for this date.</span></div>`}
          </div>
          <div class="pagination-row">
            <button class="secondary-button" data-action="history-prev" ${historyPage <= 0 ? "disabled" : ""} type="button">Back</button>
            <strong>${personalHistory.length ? `${historyPage + 1} / ${pageCount(personalHistory, HISTORY_PAGE_SIZE)}` : "0 / 0"}</strong>
            <button class="secondary-button" data-action="history-next" ${historyPage >= pageCount(personalHistory, HISTORY_PAGE_SIZE) - 1 ? "disabled" : ""} type="button">Next</button>
          </div>
        </div>
        <div class="history-detail">
          ${renderHistoryDetail(selected)}
        </div>
      </div>
    </section>
  `, `
    <button class="secondary-button" data-action="main-menu" type="button">Menu</button>
    <button class="primary-button" data-action="refresh-history" type="button">Refresh</button>
    <button class="secondary-button" data-action="logout" type="button">${operator.display_name}</button>
  `);
}

async function openModule(moduleName) {
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
      disconnectEvents();
      return renderLogin();
    }
    if (button.dataset.action === "main-menu") {
      stopFulfillmentCamera();
      stopReceiptCamera();
      currentModule = "menu";
      selectedId = null;
      selectedOrder = null;
      selectedInventoryItem = null;
      return render();
    }
    if (button.dataset.action === "open-module") return openModule(button.dataset.module);
    if (button.dataset.action === "select-delivery-type") {
      deliveryOrderType = button.dataset.orderType || "sales_order";
      localStorage.setItem("mbbs.operator.deliveryOrderType", deliveryOrderType);
      return openModule("delivery-run");
    }
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
    if (button.dataset.action === "sync-receiving") return syncReceiving();
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
      const lines = (receivingSelectedOrder?.lines || []).filter((line) => isPickableLine(line));
      receivingLinePage = Math.min(pageCount(lines, LINE_PAGE_SIZE) - 1, receivingLinePage + 1);
      return render();
    }
    if (button.dataset.action === "select-receiving-line") {
      receivingSelectedLineId = button.dataset.line;
      return render();
    }
    if (button.dataset.action === "confirm-receiving-line") return confirmReceivingLine(button.dataset.line);
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
    if (button.dataset.action === "start-receipt-camera") return startReceiptCamera();
    if (button.dataset.action === "capture-receipt-photo") return captureReceiptPhoto();
    if (button.dataset.action === "choose-receipt-photo-file") return document.getElementById("receiptPhoto")?.click();
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
        body: JSON.stringify({ locationId, orderType: deliveryOrderType })
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
    if (button.dataset.action === "open-operator-request") {
      if (!button.dataset.order) return showToast("Requested order is not in this list.");
      viewMode = "packed";
      selectedId = button.dataset.order;
      await loadOrders({ keepSelection: true });
      const index = orders.findIndex((order) => String(order.netsuite_id) === String(selectedId));
      if (index >= 0) orderPage = Math.floor(index / ORDER_PAGE_SIZE);
      return render();
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
    if (button.dataset.action === "select-history") {
      selectedHistoryId = button.dataset.record;
      historyReportReason = "";
      return render();
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

app.addEventListener("change", async (event) => {
  if (event.target?.id === "historyDate") {
    personalHistoryDate = event.target.value || "";
    selectedHistoryId = "";
    historyReportReason = "";
    historyPage = 0;
    return loadPersonalHistory();
  }
  if (event.target?.id !== "fulfillmentPhoto" && event.target?.id !== "receiptPhoto") return;
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (event.target.id === "fulfillmentPhoto") {
      stopFulfillmentCamera();
      fulfillmentPhotoDataUrl = await readPhotoFile(file);
    } else {
      stopReceiptCamera();
      receiptPhotoDataUrls[receiptActivePhotoSlot] = await readPhotoFile(file);
      receiptActivePhotoSlot = Math.min(1, receiptActivePhotoSlot + 1);
    }
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
    connectEvents();
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
    connectEvents();
    render();
  } catch (error) {
    disconnectEvents();
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

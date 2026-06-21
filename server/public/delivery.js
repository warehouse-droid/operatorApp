const LOCATIONS = [
  { id: 1, text: "3445" },
  { id: 13, text: "2967" }
];

const ORDER_PAGE_SIZE = 4;
const LINE_PAGE_SIZE = 4;
const PICKABLE_ITEM_TYPES = new Set(["InvtPart", "NonInvtPart"]);

const app = document.getElementById("app");
const toast = document.getElementById("toast");

const TOKEN_KEY = "mbbs.delivery.token";
let authToken = localStorage.getItem(TOKEN_KEY) || "";
let operator = null;

let locationId = Number(localStorage.getItem("mbbs.delivery.locationId") || 0);
let viewMode = "active";
let orders = [];
let selectedId = null;
let selectedOrder = null;
let selectedLineId = null;
let orderPage = 0;
let linePage = 0;
let installPromptEvent = null;
let appInstalled = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

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
    packed: "Packed"
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

  const title = viewMode === "packed" ? "Packed Orders" : "Delivery Prep";
  const subtitle = `Location ${currentLocation()?.text || locationId}`;
  const topWarnings = viewMode === "packed" ? warningOrders() : [];
  const actions = `
    ${topWarnings.length ? `<button class="top-warning-button" data-action="open-warning-order" data-order="${topWarnings[0].netsuite_id}" type="button">Warning ${topWarnings.length}</button>` : ""}
    ${renderInstallButton()}
    <button class="secondary-button" data-action="view-active" type="button">Active</button>
    <button class="secondary-button" data-action="view-packed" type="button">Packed</button>
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

function renderOrderPanel() {
  const count = pageCount(orders, ORDER_PAGE_SIZE);
  orderPage = Math.min(orderPage, count - 1);
  const visible = pageItems(orders, orderPage, ORDER_PAGE_SIZE);

  return `
    <div class="panel-title">
      <span>${viewMode === "packed" ? "Packed" : "Not packed"}</span>
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
        <h2>${order.tranid}</h2>
        <p class="muted">${order.customer || ""}</p>
        <p class="muted">${formatDate(order.trandate)} | ${order.delivery_method || ""}</p>
      </div>
      <div class="status-actions">
        <span class="status-pill ${orderStatusClass(order)}">${orderStatusText(order)}</span>
        ${viewMode === "packed"
          ? `<button class="primary-button" data-action="set-packed" type="button">Packed</button>
             <button class="secondary-button danger-button" data-action="unpack-order" type="button">Unpack whole order</button>`
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

function stepQty(unit, delta) {
  const input = app.querySelector(`.selected-panel [data-pack="${unit}"]`);
  if (!input) return;
  const selectedLine = selectedOrder?.lines?.find((line) => String(line.id) === String(selectedLineId));
  const max = selectedLine ? panelLimit(selectedLine, unit) : Number.POSITIVE_INFINITY;
  input.value = Math.min(max, Math.max(0, qty(input.value) + Number(delta)));
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
    if (button.dataset.action === "save-location") {
      const value = Number(document.getElementById("locationSelect").value);
      locationId = value;
      localStorage.setItem("mbbs.delivery.locationId", String(value));
      orderPage = 0;
      linePage = 0;
      return loadOrders();
    }
    if (button.dataset.action === "change-location") {
      localStorage.removeItem("mbbs.delivery.locationId");
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
    if (locationId) await loadOrders();
    else render();
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
    if (locationId) await loadOrders();
    else render();
  } catch (error) {
    renderLogin("Please login to continue.");
  }
}

boot();
setInterval(() => {
  if (operator && locationId) loadOrders({ keepSelection: true }).catch((error) => showToast(error.message));
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

const salesPrintingApp = document.getElementById("salesPrintingApp");
let salesPrintOperator = null;
let salesPrintPrinters = [];
let salesPrintOrders = [];
let salesPrintJobs = [];
let salesPrintSearch = "";
let salesPrintOrderingYard = "";
let salesPrintBusy = "";
let salesPrintNotice = "";
let salesPrintError = "";
let salesPrintTimer = null;
let salesPrintRemoteTimer = null;
let salesPrintEventSource = null;
let salesPrintPreview = null;
let salesPrintHistory = null;

const SALES_PRINT_TABLE_PREF_KEY = "mbbs.salesPrinting.tablePreferences.v1";
const SALES_PRINT_COLUMNS = Object.freeze([
  { key: "order", label: "Sales Order", width: 112, minWidth: 90 },
  { key: "date", label: "Date", width: 96, minWidth: 82 },
  { key: "customer", label: "Customer", width: 145, minWidth: 100 },
  { key: "yard", label: "Inventory Line Yard", width: 100, minWidth: 82 },
  { key: "status", label: "Status", width: 105, minWidth: 82 },
  { key: "items", label: "Item Details", width: 220, minWidth: 140 },
  { key: "lines", label: "Lines", width: 58, minWidth: 50 },
  { key: "actions", label: "Preview / History", width: 168, minWidth: 145 }
]);
const SALES_PRINT_TABLE_DEFAULTS = Object.freeze({ fontSize: 12 });

function salesPrintClamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function loadSalesPrintTablePreferences() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SALES_PRINT_TABLE_PREF_KEY) || "{}"); } catch { saved = {}; }
  if (!saved || typeof saved !== "object") saved = {};
  return {
    fontSize: salesPrintClamp(saved.fontSize, 10, 18, SALES_PRINT_TABLE_DEFAULTS.fontSize),
    widths: Object.fromEntries(SALES_PRINT_COLUMNS.map((column) => [
      column.key,
      salesPrintClamp(saved.widths?.[column.key], column.minWidth, 900, column.width)
    ]))
  };
}

let salesPrintTablePreferences = loadSalesPrintTablePreferences();

function saveSalesPrintTablePreferences() {
  try { localStorage.setItem(SALES_PRINT_TABLE_PREF_KEY, JSON.stringify(salesPrintTablePreferences)); } catch {
    // Browser storage is optional; table controls still work for the current page.
  }
}

function salesPrintTableWidth() {
  return SALES_PRINT_COLUMNS.reduce((total, column) => total + salesPrintTablePreferences.widths[column.key], 0);
}

function salesPrintTableStyle() {
  const width = salesPrintTableWidth();
  return `width:${width}px;min-width:${width}px;--sales-print-table-font-size:${salesPrintTablePreferences.fontSize}px`;
}

function salesPrintTableColgroup() {
  return `<colgroup>${SALES_PRINT_COLUMNS.map((column) => `<col data-sales-column="${salesPrintEscape(column.key)}" style="width:${salesPrintTablePreferences.widths[column.key]}px" />`).join("")}</colgroup>`;
}

function salesPrintTableHeaders() {
  return SALES_PRINT_COLUMNS.map((column) => `<th data-sales-column-key="${salesPrintEscape(column.key)}">
    <span>${salesPrintEscape(column.label)}</span>
    <button class="sales-column-resizer" data-sales-resize-column="${salesPrintEscape(column.key)}" type="button" aria-label="Resize ${salesPrintEscape(column.label)} column" title="Drag to resize column"></button>
  </th>`).join("");
}

function applySalesPrintTablePreferences() {
  const table = salesPrintingApp.querySelector(".sales-order-print-table");
  if (!table) return;
  const width = salesPrintTableWidth();
  table.style.width = `${width}px`;
  table.style.minWidth = `${width}px`;
  table.style.setProperty("--sales-print-table-font-size", `${salesPrintTablePreferences.fontSize}px`);
  SALES_PRINT_COLUMNS.forEach((column) => {
    const col = table.querySelector(`col[data-sales-column="${column.key}"]`);
    if (col) col.style.width = `${salesPrintTablePreferences.widths[column.key]}px`;
  });
  const output = salesPrintingApp.querySelector('[data-sales-table-output="fontSize"]');
  if (output) output.textContent = `${salesPrintTablePreferences.fontSize}px`;
}

function salesPrintEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}

function salesPrintDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString([], {
    year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit"
  });
}

function salesPrintOrderDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return value ? String(value) : "—";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${match[1]}-${months[Number(match[2]) - 1] || match[2]}-${match[3]}`;
}

function salesPrintQuantity(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return number.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}

function salesPrintItemDetails(order) {
  const lines = Array.isArray(order?.itemLines) ? order.itemLines : [];
  if (!lines.length) return `<div class="sales-item-line"><span>${salesPrintEscape(order?.items || "—")}</span><strong>—</strong></div>`;
  return lines.map((line) => {
    const quantity = salesPrintQuantity(line.quantity);
    const unit = String(line.unit || "").trim();
    return `<div class="sales-item-line" title="${salesPrintEscape(line.itemName || "Item")}">
      <span>${salesPrintEscape(line.itemName || "Item")}</span>
      <strong>${salesPrintEscape(quantity)}${unit ? ` ${salesPrintEscape(unit)}` : ""}</strong>
    </div>`;
  }).join("");
}

async function salesPrintApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
  if (!response.ok) throw new Error(payload.error || text || "Request failed.");
  return payload;
}

async function salesPrintPdf(path) {
  const response = await fetch(path, { headers: { Accept: "application/pdf" } });
  if (!response.ok) {
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
    throw new Error(payload.error || text || "The picking-ticket snapshot could not load.");
  }
  return response.blob();
}

function salesPrinter(locationId) {
  return salesPrintPrinters.find((printer) => String(printer.locationId) === String(locationId)) || null;
}

function salesPrinterReady(printer) {
  return Boolean(printer?.enabled && printer?.hasToken && printer?.printerName);
}

function salesOrderLineYards(order) {
  return order?.lineYards || [];
}

function salesOrderLineYard(order, lineLocationId) {
  return salesOrderLineYards(order)
    .find((yard) => String(yard.locationId) === String(lineLocationId)) || null;
}

function salesOrderLineLocation(order) {
  const yards = salesOrderLineYards(order);
  return yards.length === 1 ? String(yards[0].locationId) : "";
}

function salesPrintVisibleOrders() {
  // A deliberate search is global within the account's assigned ordering yards,
  // including print history, so a stale local yard filter must not hide the hit.
  if (salesPrintSearch.trim() || !salesPrintOrderingYard) return salesPrintOrders;
  return salesPrintOrders.filter((order) => String(order.orderingLocationId) === salesPrintOrderingYard);
}

function salesPrintOrderRows() {
  return salesPrintVisibleOrders().map((order) => {
    const lineLocationId = salesOrderLineLocation(order);
    const lineYards = salesOrderLineYards(order);
    const lineYard = lineLocationId ? salesOrderLineYard(order, lineLocationId) : null;
    const yardLabel = lineYard?.yardCode || (lineYards.length > 1 ? "Multiple inventory yards" : "No inventory yard");
    return `
      <tr>
        <td><strong>${salesPrintEscape(order.orderRef)}</strong><br><small>#${salesPrintEscape(order.orderId)}</small></td>
        <td class="sales-order-date">${salesPrintEscape(salesPrintOrderDate(order.orderDate))}</td>
        <td>${salesPrintEscape(order.customer || "—")}</td>
        <td><strong>${salesPrintEscape(yardLabel)}</strong></td>
        <td>${salesPrintEscape(order.status || "—")}</td>
        <td class="items"><div class="sales-item-scroll">${salesPrintItemDetails(order)}</div></td>
        <td>${salesPrintEscape(order.lineCount)}</td>
        <td>
          <div class="sales-print-action">
            <div class="sales-print-action-buttons">
              <button class="primary" data-action="preview-so" data-order-id="${salesPrintEscape(order.orderId)}" data-order-ref="${salesPrintEscape(order.orderRef)}" type="button" ${lineLocationId && !salesPrintBusy ? "" : "disabled"}>${salesPrintBusy === `preview:${order.orderId}` ? "Loading…" : "Preview"}</button>
              <button data-action="history-so" data-order-id="${salesPrintEscape(order.orderId)}" data-order-ref="${salesPrintEscape(order.orderRef)}" type="button" ${salesPrintBusy ? "disabled" : ""}>History${order.printHistoryCount ? ` (${salesPrintEscape(order.printHistoryCount)})` : ""}</button>
            </div>
          </div>
        </td>
      </tr>
    `;
  }).join("") || `<tr><td colspan="8">No Delivery Sales Orders match this search and ordering-location scope.</td></tr>`;
}

function salesPrintJobCards() {
  return salesPrintJobs.map((job) => `
    <article class="sales-print-job-card">
      <header><strong>#${salesPrintEscape(job.id)} · ${salesPrintEscape(job.yardCode)}</strong><span class="sales-status-pill ${salesPrintEscape(job.status)}">${salesPrintEscape(job.status)}</span></header>
      <div title="${salesPrintEscape(job.documentName)}">${salesPrintEscape(job.documentName)}</div>
      <small>${salesPrintDate(job.queuedAt)} · ${salesPrintEscape(job.attempts)} attempt${Number(job.attempts) === 1 ? "" : "s"}</small>
      ${job.lastError ? `<p>${salesPrintEscape(job.lastError)}</p>` : ""}
    </article>
  `).join("") || `<div class="sales-print-jobs-empty">No Sales Order print jobs are available.</div>`;
}

function salesPrintHistoryModal() {
  if (!salesPrintHistory) return "";
  const rows = (salesPrintHistory.history || []).map((entry) => `
    <tr>
      <td>#${salesPrintEscape(entry.jobId)}</td>
      <td><strong>${salesPrintEscape(entry.requestedBy)}</strong><br><small>${salesPrintDate(entry.requestedAt)}</small></td>
      <td>${salesPrintEscape(entry.lineYardCode || "—")}</td>
      <td><strong>${salesPrintEscape(entry.printerYardCode || "—")}</strong><br><small>${salesPrintEscape(entry.printerName || "")}</small></td>
      <td><span class="sales-status-pill ${salesPrintEscape(entry.status)}">${salesPrintEscape(entry.status)}</span>${entry.printedAt ? `<br><small>Printed ${salesPrintDate(entry.printedAt)}</small>` : ""}${entry.lastError ? `<br><small class="sales-history-error">${salesPrintEscape(entry.lastError)}</small>` : ""}</td>
      <td><button data-action="view-snapshot" data-order-id="${salesPrintEscape(entry.orderId)}" data-job-id="${salesPrintEscape(entry.jobId)}" data-order-ref="${salesPrintEscape(entry.orderRef || salesPrintHistory.order.orderRef)}" data-line-yard="${salesPrintEscape(entry.lineYardCode)}" data-printer-yard="${salesPrintEscape(entry.printerYardCode)}" data-requested-by="${salesPrintEscape(entry.requestedBy)}" data-requested-at="${salesPrintEscape(entry.requestedAt)}" type="button" ${salesPrintBusy ? "disabled" : ""}>View snapshot</button></td>
    </tr>
  `).join("") || `<tr><td colspan="6">This Sales Order has no picking-ticket print history.</td></tr>`;
  return `
    <div class="sales-preview-backdrop" data-action="close-history-backdrop">
      <section class="sales-history-dialog" role="dialog" aria-modal="true" aria-label="Sales Order print history">
        <header>
          <div><p>Picking-ticket history</p><h2>${salesPrintEscape(salesPrintHistory.order.orderRef)}</h2><span>Every row keeps the exact PDF snapshot submitted at that time.</span></div>
          <button data-action="close-history" type="button">Close</button>
        </header>
        <div class="sales-table-wrap"><table class="sales-table"><thead><tr><th>Job</th><th>Requested by / when</th><th>Line yard</th><th>Printer</th><th>Result</th><th>Snapshot</th></tr></thead><tbody>${rows}</tbody></table></div>
      </section>
    </div>
  `;
}

function salesPrintPreviewModal() {
  if (!salesPrintPreview) return "";
  const printer = salesPrinter(salesPrintPreview.printerLocationId);
  const ready = salesPrinterReady(printer);
  const snapshotOnly = Boolean(salesPrintPreview.snapshotOnly);
  return `
    <div class="sales-preview-backdrop" data-action="close-preview-backdrop">
      <section class="sales-preview-dialog" role="dialog" aria-modal="true" aria-label="Picking ticket preview">
        <header>
          <div>
            <p>${snapshotOnly ? "Historical ticket snapshot" : "Picking ticket preview"}</p>
            <h2>${salesPrintEscape(salesPrintPreview.orderRef)}</h2>
            <span>Line yard: <strong>${salesPrintEscape(salesPrintPreview.lineYardCode || "—")}</strong> · Printer: <strong>${salesPrintEscape(salesPrintPreview.printerYardCode || printer?.yardCode || "—")}</strong></span>
            ${snapshotOnly ? `<small>Requested by ${salesPrintEscape(salesPrintPreview.requestedBy || "—")} · ${salesPrintDate(salesPrintPreview.requestedAt)}</small>` : ""}
          </div>
          <button data-action="close-preview" type="button">Close</button>
        </header>
        <iframe src="${salesPrintEscape(salesPrintPreview.objectUrl)}" title="${salesPrintEscape(salesPrintPreview.orderRef)} picking ticket"></iframe>
        <footer>
          ${snapshotOnly || ready ? "" : `<span class="sales-preview-warning">${salesPrintEscape(printer?.yardCode || "Selected yard")} printer setup is incomplete.</span>`}
          <button data-action="close-preview" type="button">${snapshotOnly ? "Close" : "Cancel"}</button>
          ${snapshotOnly ? "" : `<button class="primary" data-action="queue-preview" type="button" ${ready && !salesPrintBusy ? "" : "disabled"}>${salesPrintBusy === "queue-preview" ? "Queuing…" : `Print to ${salesPrintEscape(printer?.yardCode || "yard")}`}</button>`}
        </footer>
      </section>
    </div>
  `;
}

function renderSalesPrinting() {
  const operator = salesPrintOperator || {};
  salesPrintingApp.innerHTML = `
    <header class="dispatch-topbar">
      <div><p>Sales</p><h1>Sales Order Printing</h1></div>
      <div class="topbar-language">${window.MBBS_I18N?.toggleHtml?.() || ""}</div>
      <div class="topbar-actions">
        <span class="dispatch-user">${salesPrintEscape(operator.display_name || operator.username || "")}</span>
        <button onclick="location.href='/sales'" type="button">Sales Menu</button>
        <button onclick="dispatchLogout()" type="button">Logout</button>
      </div>
    </header>
    <section class="sales-printing-page">
      ${salesPrintError ? `<div class="route-notice"><span>${salesPrintEscape(salesPrintError)}</span></div>` : ""}
      ${salesPrintNotice ? `<div class="route-notice"><span>${salesPrintEscape(salesPrintNotice)}</span></div>` : ""}
      <div class="sales-print-columns">
        <section class="panel sales-print-orders-panel">
          <div class="sales-section-head"><div><h2>Delivery Sales Orders</h2><p>Unprinted orders are shown by default. Search also finds orders that were printed before.</p></div></div>
          <div class="sales-print-toolbar">
            <input data-sales-search type="search" value="${salesPrintEscape(salesPrintSearch)}" placeholder="Search delivery SO, customer, item, or SKU" autocomplete="off" />
            <select data-sales-ordering-yard><option value="">All assigned ordering locations</option>${[...new Map(salesPrintOrders.map((order) => [String(order.orderingLocationId), order.orderingYardCode])).entries()].map(([locationId, yardCode]) => `<option value="${salesPrintEscape(locationId)}" ${salesPrintOrderingYard === locationId ? "selected" : ""}>${salesPrintEscape(yardCode)}</option>`).join("")}</select>
            <button data-action="refresh" type="button" ${salesPrintBusy ? "disabled" : ""}>Refresh</button>
            <div class="sales-table-settings" role="group" aria-label="Delivery Sales Order table settings">
              <label>Font <input data-sales-table-setting="fontSize" type="range" min="10" max="18" step="1" value="${salesPrintTablePreferences.fontSize}" /><output data-sales-table-output="fontSize">${salesPrintTablePreferences.fontSize}px</output></label>
              <button data-action="reset-table-layout" type="button" title="Reset font size and all column widths">Reset columns</button>
            </div>
          </div>
          <div class="sales-table-wrap sales-order-table-wrap"><table class="sales-table sales-order-print-table" style="${salesPrintTableStyle()}">${salesPrintTableColgroup()}<thead><tr>${salesPrintTableHeaders()}</tr></thead><tbody>${salesPrintOrderRows()}</tbody></table></div>
        </section>
        <aside class="panel sales-print-jobs-panel">
          <div class="sales-section-head"><div><h2>Recent print jobs</h2><p>Use an order's History for its user, time, and PDF snapshot.</p></div></div>
          <div class="sales-print-job-list">${salesPrintJobCards()}</div>
        </aside>
      </div>
    </section>
    ${salesPrintHistoryModal()}
    ${salesPrintPreviewModal()}
  `;
}

function closeSalesPrintPreview() {
  if (salesPrintPreview?.objectUrl) URL.revokeObjectURL(salesPrintPreview.objectUrl);
  salesPrintPreview = null;
}

async function loadSalesPrinting({ quiet = false } = {}) {
  if (!quiet) salesPrintBusy = "loading";
  salesPrintError = "";
  renderSalesPrinting();
  try {
    const params = new URLSearchParams({ limit: "2500" });
    if (salesPrintSearch.trim()) params.set("search", salesPrintSearch.trim());
    const [printers, orders, jobs] = await Promise.all([
      salesPrintApi("/api/sales/printers"),
      salesPrintApi(`/api/sales/sales-orders?${params}`),
      salesPrintApi("/api/sales/print-jobs?limit=200")
    ]);
    salesPrintPrinters = printers;
    salesPrintOrders = orders;
    salesPrintJobs = jobs;
  } catch (error) {
    salesPrintError = error.message;
  } finally {
    salesPrintBusy = "";
    renderSalesPrinting();
  }
}

salesPrintingApp.addEventListener("input", (event) => {
  if (event.target.matches("[data-sales-search]")) {
    salesPrintSearch = event.target.value || "";
    clearTimeout(salesPrintTimer);
    salesPrintTimer = setTimeout(() => loadSalesPrinting({ quiet: true }), 350);
    return;
  }
  if (event.target.matches('[data-sales-table-setting="fontSize"]')) {
    salesPrintTablePreferences.fontSize = salesPrintClamp(event.target.value, 10, 18, SALES_PRINT_TABLE_DEFAULTS.fontSize);
    saveSalesPrintTablePreferences();
    applySalesPrintTablePreferences();
  }
});

salesPrintingApp.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest("[data-sales-resize-column]");
  if (!handle) return;
  const key = handle.dataset.salesResizeColumn || "";
  const column = SALES_PRINT_COLUMNS.find((item) => item.key === key);
  const header = handle.closest("th");
  if (!column || !header) return;
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = header.getBoundingClientRect().width;
  document.body.classList.add("sales-resizing-column");
  handle.setPointerCapture?.(event.pointerId);

  const move = (moveEvent) => {
    salesPrintTablePreferences.widths[key] = salesPrintClamp(startWidth + moveEvent.clientX - startX, column.minWidth, 900, column.width);
    applySalesPrintTablePreferences();
  };
  const finish = () => {
    document.body.classList.remove("sales-resizing-column");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    saveSalesPrintTablePreferences();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish, { once: true });
  window.addEventListener("pointercancel", finish, { once: true });
});

salesPrintingApp.addEventListener("change", (event) => {
  if (event.target.matches("[data-sales-ordering-yard]")) {
    salesPrintOrderingYard = event.target.value || "";
    renderSalesPrinting();
    return;
  }
});

salesPrintingApp.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  if (button.dataset.action === "close-preview-backdrop" && event.target !== button) return;
  if (button.dataset.action === "close-history-backdrop" && event.target !== button) return;
  if (["close-preview", "close-preview-backdrop"].includes(button.dataset.action)) {
    closeSalesPrintPreview();
    renderSalesPrinting();
    return;
  }
  if (["close-history", "close-history-backdrop"].includes(button.dataset.action)) {
    salesPrintHistory = null;
    renderSalesPrinting();
    return;
  }
  if (salesPrintBusy) return;
  if (button.dataset.action === "refresh") return loadSalesPrinting();
  if (button.dataset.action === "reset-table-layout") {
    salesPrintTablePreferences = loadSalesPrintTablePreferences();
    salesPrintTablePreferences.fontSize = SALES_PRINT_TABLE_DEFAULTS.fontSize;
    salesPrintTablePreferences.widths = Object.fromEntries(SALES_PRINT_COLUMNS.map((column) => [column.key, column.width]));
    saveSalesPrintTablePreferences();
    applySalesPrintTablePreferences();
    return;
  }
  if (button.dataset.action === "history-so") {
    salesPrintBusy = `history:${button.dataset.orderId}`;
    salesPrintError = "";
    renderSalesPrinting();
    try {
      salesPrintHistory = await salesPrintApi(`/api/sales/sales-orders/${encodeURIComponent(button.dataset.orderId)}/print-history`);
    } catch (error) {
      salesPrintError = error.message;
    } finally {
      salesPrintBusy = "";
      renderSalesPrinting();
    }
    return;
  }
  if (button.dataset.action === "view-snapshot") {
    salesPrintBusy = `snapshot:${button.dataset.jobId}`;
    salesPrintError = "";
    renderSalesPrinting();
    try {
      const blob = await salesPrintPdf(`/api/sales/sales-orders/${encodeURIComponent(button.dataset.orderId)}/print-history/${encodeURIComponent(button.dataset.jobId)}/snapshot`);
      closeSalesPrintPreview();
      salesPrintHistory = null;
      salesPrintPreview = {
        snapshotOnly: true,
        orderId: button.dataset.orderId,
        orderRef: button.dataset.orderRef,
        lineYardCode: button.dataset.lineYard,
        printerYardCode: button.dataset.printerYard,
        requestedBy: button.dataset.requestedBy,
        requestedAt: button.dataset.requestedAt,
        objectUrl: URL.createObjectURL(blob)
      };
    } catch (error) {
      salesPrintError = error.message;
    } finally {
      salesPrintBusy = "";
      renderSalesPrinting();
    }
    return;
  }
  if (button.dataset.action === "preview-so") {
    const orderId = String(button.dataset.orderId);
    const order = salesPrintOrders.find((item) => String(item.orderId) === orderId);
    const lineLocationId = salesOrderLineLocation(order);
    const lineYard = salesOrderLineYard(order, lineLocationId);
    if (!lineYard) return;
    salesPrintBusy = `preview:${orderId}`;
    salesPrintError = "";
    salesPrintNotice = "";
    renderSalesPrinting();
    try {
      const blob = await salesPrintPdf(`/api/sales/sales-orders/${encodeURIComponent(orderId)}/picking-ticket-preview?lineLocationId=${encodeURIComponent(lineLocationId)}`);
      closeSalesPrintPreview();
      salesPrintPreview = {
        snapshotOnly: false,
        orderId,
        orderRef: button.dataset.orderRef || `SO-${orderId}`,
        lineLocationId,
        lineYardCode: lineYard.yardCode,
        printerLocationId: lineYard.printerLocationId,
        printerYardCode: salesPrinter(lineYard.printerLocationId)?.yardCode || "",
        objectUrl: URL.createObjectURL(blob)
      };
    } catch (error) {
      salesPrintError = error.message;
    } finally {
      salesPrintBusy = "";
      renderSalesPrinting();
    }
    return;
  }
  if (button.dataset.action !== "queue-preview" || !salesPrintPreview || salesPrintPreview.snapshotOnly) return;
  const preview = { ...salesPrintPreview };
  salesPrintBusy = "queue-preview";
  salesPrintError = "";
  salesPrintNotice = "";
  renderSalesPrinting();
  try {
    const result = await salesPrintApi(`/api/sales/sales-orders/${encodeURIComponent(preview.orderId)}/print`, {
      method: "POST",
      body: JSON.stringify({ lineLocationId: Number(preview.lineLocationId) })
    });
    closeSalesPrintPreview();
    salesPrintNotice = `${result.order.orderRef} ${result.lineYard.yardCode} ticket queued to ${result.printJob.yardCode} as print job #${result.printJob.id}.`;
    await loadSalesPrinting({ quiet: true });
  } catch (error) {
    salesPrintError = error.message;
  } finally {
    salesPrintBusy = "";
    renderSalesPrinting();
  }
});

function connectSalesPrintEvents() {
  if (salesPrintEventSource) return;
  salesPrintEventSource = new EventSource("/api/events?client=sales-printing");
  salesPrintEventSource.addEventListener("app-event", (message) => {
    let event;
    try { event = JSON.parse(message.data || "{}"); } catch { return; }
    if (event.type !== "sales.printing.updated") return;
    clearTimeout(salesPrintRemoteTimer);
    salesPrintRemoteTimer = setTimeout(() => loadSalesPrinting({ quiet: true }), 300);
  });
}

window.addEventListener("beforeunload", () => {
  closeSalesPrintPreview();
  salesPrintEventSource?.close();
});
window.addEventListener("mbbs-language-changed", renderSalesPrinting);
requireDispatchLogin({
  mount: salesPrintingApp,
  roles: ["sales", "admin"],
  async onReady(operator) {
    salesPrintOperator = operator;
    renderSalesPrinting();
    await loadSalesPrinting();
    connectSalesPrintEvents();
  }
});

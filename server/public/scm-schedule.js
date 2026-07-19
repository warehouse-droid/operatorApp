const scmScheduleApp = document.getElementById("scmScheduleApp");
const scmScheduleDispatchHost = window.location.pathname.startsWith("/dispatch/");

let scmScheduleOperator = null;
let scmScheduleRows = [];
let scmSchedulePresets = [];
let scmScheduleNotice = "";
let scmScheduleLoading = false;
let scmScheduleSavingRef = "";
let scmScheduleFilters = { view: "dispatch", search: "", status: [], method: "", kind: "", dropoffPoint: "", brand: [], from: "", to: "" };
let scmScheduleSelectedRows = new Set();
let scmScheduleFocusAfterRender = "";
let scmSchedulePresetsRequest = null;
let scmScheduleSearchTimer = null;
let scmScheduleLoadRequestId = 0;

const SCM_SCHEDULE_SHEET_PREF_KEY = "mbbs.scmSchedule.sheetPreferences.v1";
const SCM_SCHEDULE_COLUMNS = [
  { key: "select", label: "", width: 40, minWidth: 36, editableOnly: true },
  { key: "date", label: "Date Added", width: 112, minWidth: 84 },
  { key: "type", label: "Type", width: 100, minWidth: 80 },
  { key: "method", label: "Method", width: 132, minWidth: 105 },
  { key: "pickup", label: "Pickup Point", width: 158, minWidth: 110 },
  { key: "dropoff", label: "Drop off Point", width: 150, minWidth: 110 },
  { key: "brand", label: "Brand", width: 145, minWidth: 100 },
  { key: "content", label: "Content", width: 520, minWidth: 220 },
  { key: "order", label: "Order Number", width: 170, minWidth: 130 },
  { key: "weight", label: "Weight LBs", width: 104, minWidth: 90 },
  { key: "packing", label: "Packing Slip Number", width: 168, minWidth: 130 },
  { key: "eta", label: "ETA", width: 140, minWidth: 110 },
  { key: "driver", label: "Driver", width: 120, minWidth: 95 },
  { key: "status", label: "Status", width: 132, minWidth: 100 },
  { key: "sla", label: "SLA", width: 95, minWidth: 75 },
  { key: "action", label: "Save", width: 82, minWidth: 70 }
];
const SCM_SCHEDULE_SHEET_DEFAULTS = Object.freeze({ fontSize: 12, rowHeight: 58 });
let scmScheduleSheetPreferences = loadScmScheduleSheetPreferences();

const SCM_METHODS = ["MBT", "Vendor", "Customer Pickup"];
const SCM_STATUS_FILTERS = ["Queued", "Planned", "Completed", "Urgent", "Cancelled", "Hold", "Priority", "Surplus Only", "Book Appt"];
const SCM_MANUAL_STATUSES = ["Queued", "Urgent", "Cancelled", "Hold", "Priority", "Surplus Only", "Book Appt"];
const SCM_SYSTEM_STATUSES = new Set(["Planned", "Completed", "Partially Done"]);
const SCM_TYPES = ["PO", "TO", "VRMA"];
const OWN_YARDS = ["3445", "12441", "2967", "150"];

function scmScheduleEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function scmScheduleClamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function loadScmScheduleSheetPreferences() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SCM_SCHEDULE_SHEET_PREF_KEY) || "{}");
  } catch {
    saved = {};
  }
  if (!saved || typeof saved !== "object") saved = {};
  const widths = {};
  for (const column of SCM_SCHEDULE_COLUMNS) {
    widths[column.key] = scmScheduleClamp(saved.widths?.[column.key], column.minWidth, 1200, column.width);
  }
  return {
    fontSize: scmScheduleClamp(saved.fontSize, 10, 18, SCM_SCHEDULE_SHEET_DEFAULTS.fontSize),
    rowHeight: scmScheduleClamp(saved.rowHeight, 38, 120, SCM_SCHEDULE_SHEET_DEFAULTS.rowHeight),
    widths
  };
}

function saveScmScheduleSheetPreferences() {
  try {
    localStorage.setItem(SCM_SCHEDULE_SHEET_PREF_KEY, JSON.stringify(scmScheduleSheetPreferences));
  } catch {
    // Layout preferences are optional when browser storage is unavailable.
  }
}

function scmScheduleVisibleColumns(editable = canEditScmSchedule()) {
  return SCM_SCHEDULE_COLUMNS.filter((column) => !column.editableOnly || editable);
}

function scmScheduleGridMetrics(editable = canEditScmSchedule()) {
  const columns = scmScheduleVisibleColumns(editable);
  const widths = columns.map((column) => scmScheduleSheetPreferences.widths[column.key] || column.width);
  return { columns, widths, minWidth: widths.reduce((sum, width) => sum + width, 0) };
}

function scmScheduleGridStyle(editable = canEditScmSchedule()) {
  const metrics = scmScheduleGridMetrics(editable);
  return `grid-template-columns:${metrics.widths.map((width) => `${width}px`).join(" ")};min-width:${metrics.minWidth}px;--scm-schedule-font-size:${scmScheduleSheetPreferences.fontSize}px;--scm-schedule-row-height:${scmScheduleSheetPreferences.rowHeight}px`;
}

function scmScheduleHeaderHtml(column) {
  return `<div class="scm-sheet-header" data-column-key="${scmScheduleEscape(column.key)}">
    <span>${scmScheduleEscape(column.label)}</span>
    <button class="scm-column-resizer" data-action="resize-column" data-column-key="${scmScheduleEscape(column.key)}" type="button" aria-label="Resize ${scmScheduleEscape(column.label || "selection")} column" title="Drag to resize column"></button>
  </div>`;
}

function applyScmScheduleSheetPreferences() {
  const grid = scmScheduleApp.querySelector(".scm-sheet-grid");
  if (!grid) return;
  const metrics = scmScheduleGridMetrics(grid.classList.contains("with-select"));
  grid.style.gridTemplateColumns = metrics.widths.map((width) => `${width}px`).join(" ");
  grid.style.minWidth = `${metrics.minWidth}px`;
  grid.style.setProperty("--scm-schedule-font-size", `${scmScheduleSheetPreferences.fontSize}px`);
  grid.style.setProperty("--scm-schedule-row-height", `${scmScheduleSheetPreferences.rowHeight}px`);
  const fontOutput = scmScheduleApp.querySelector('[data-sheet-output="fontSize"]');
  const rowOutput = scmScheduleApp.querySelector('[data-sheet-output="rowHeight"]');
  if (fontOutput) fontOutput.textContent = `${scmScheduleSheetPreferences.fontSize}px`;
  if (rowOutput) rowOutput.textContent = `${scmScheduleSheetPreferences.rowHeight}px`;
}

async function scmScheduleApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function scmScheduleQuery() {
  const params = new URLSearchParams();
  const search = String(scmScheduleFilters.search || "").trim();
  if (search) {
    params.set("search", search);
    return `?${params.toString()}`;
  }
  Object.entries(scmScheduleFilters).forEach(([key, value]) => {
    if (key === "search") return;
    if (Array.isArray(value)) {
      value.filter(Boolean).forEach((item) => params.append(key, item));
      return;
    }
    if (!value) return;
    params.set(key, value);
  });
  return params.toString() ? `?${params.toString()}` : "";
}

function loadScmSchedulePresetsOnce() {
  if (scmSchedulePresets.length) return Promise.resolve(scmSchedulePresets);
  if (!scmSchedulePresetsRequest) {
    scmSchedulePresetsRequest = scmScheduleApi("/api/scm/view-presets").catch((error) => {
      scmSchedulePresetsRequest = null;
      throw error;
    });
  }
  return scmSchedulePresetsRequest;
}

async function loadScmSchedule() {
  const requestId = ++scmScheduleLoadRequestId;
  const query = scmScheduleQuery();
  scmScheduleLoading = true;
  renderScmSchedule();
  try {
    const [rows, presets] = await Promise.all([
      scmScheduleApi(`/api/scm/schedule${query}`),
      loadScmSchedulePresetsOnce()
    ]);
    if (requestId !== scmScheduleLoadRequestId) return;
    scmScheduleRows = rows;
    scmSchedulePresets = presets;
    const validRowIds = new Set(scmScheduleRows.map(scheduleRowId));
    scmScheduleSelectedRows = new Set([...scmScheduleSelectedRows].filter((rowId) => validRowIds.has(rowId)));
  } catch (error) {
    if (requestId === scmScheduleLoadRequestId) scmScheduleNotice = `Schedule load failed: ${error.message}`;
  } finally {
    if (requestId === scmScheduleLoadRequestId) {
      scmScheduleLoading = false;
      renderScmSchedule();
    }
  }
}

function scheduleRowId(row = {}) {
  return `${row.orderKind || "PO"}::${row.orderRef || ""}`;
}

function canEditScmSchedule() {
  return !scmScheduleDispatchHost && scmScheduleFilters.view === "scm working";
}

function scmScheduleRole() {
  return String(scmScheduleOperator?.role || "").trim().toLowerCase();
}

function scmScheduleAllowedViewsForRole() {
  if (scmScheduleDispatchHost) return ["dispatch", "completed"];
  const role = scmScheduleRole();
  if (role === "dispatcher") return ["dispatch", "completed"];
  if (role === "yard_manager" || role === "yard-manager" || role === "yard manager") return ["yard manager"];
  return null;
}

function scmScheduleDefaultViewForRole() {
  if (scmScheduleDispatchHost) return "dispatch";
  const role = scmScheduleRole();
  if (role === "dispatcher") return "dispatch";
  if (role === "yard_manager" || role === "yard-manager" || role === "yard manager") return "yard manager";
  return "scm working";
}

function scmScheduleVisiblePresets() {
  const allowed = scmScheduleAllowedViewsForRole();
  if (!allowed) return scmSchedulePresets;
  return scmSchedulePresets.filter((preset) => allowed.includes(String(preset.name || "").toLowerCase()));
}

function scmScheduleCanShowScmWorkingControls() {
  return canEditScmSchedule() && ["admin", "scm", "scm_staff", "scm-staff", "scm staff"].includes(scmScheduleRole());
}

function scmScheduleIsYardManagerView() {
  const role = scmScheduleRole();
  return role === "yard_manager" || role === "yard-manager" || role === "yard manager";
}

function selectedScmScheduleRows() {
  return scmScheduleRows.filter((row) => scmScheduleSelectedRows.has(scheduleRowId(row)));
}

function scheduleOptionList(field) {
  const values = new Set(field === "dropoffPoint" ? OWN_YARDS : []);
  if (field === "dropoffPoint") return OWN_YARDS;
  for (const row of scmScheduleRows) {
    if (field === "pickupPoint" && row.pickupPoint) values.add(row.pickupPoint);
    if (field === "dropoffPoint" && row.dropoffPoint) values.add(row.dropoffPoint);
    if (field === "brand" && (row.brand || row.party)) values.add(row.brand || row.party);
  }
  return [...values].filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

function scmScheduleFilterValues(value) {
  return [...new Set((Array.isArray(value) ? value : [value])
    .map((item) => String(item || "").trim())
    .filter(Boolean))];
}

function scmScheduleMultiFilterSummary(field, label) {
  const selected = scmScheduleFilterValues(scmScheduleFilters[field]);
  if (!selected.length) return `All ${label}`;
  if (selected.length <= 2) return `${label}: ${selected.join(", ")}`;
  return `${label} (${selected.length})`;
}

function scmScheduleMultiFilterHtml({ field, label, options = [] }) {
  const selected = new Set(scmScheduleFilterValues(scmScheduleFilters[field]));
  const cleanOptions = [...new Set([...selected, ...options].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  return `<details class="scm-multi-filter" data-multi-filter="${scmScheduleEscape(field)}">
    <summary data-multi-filter-summary>${scmScheduleEscape(scmScheduleMultiFilterSummary(field, label))}</summary>
    <div class="scm-multi-filter-menu">
      <div class="scm-multi-filter-head"><strong>${scmScheduleEscape(label)}</strong><button data-action="clear-multi-filter" data-filter-name="${scmScheduleEscape(field)}" type="button">Clear</button></div>
      <div class="scm-multi-filter-options">
        ${cleanOptions.map((option) => `<label><input data-multi-filter-option type="checkbox" value="${scmScheduleEscape(option)}" ${selected.has(option) ? "checked" : ""} /><span>${scmScheduleEscape(option)}</span></label>`).join("")}
      </div>
    </div>
  </details>`;
}

function updateScmScheduleMultiFilter(details) {
  if (!details) return;
  const field = details.dataset.multiFilter || "";
  if (!field) return;
  const values = [...details.querySelectorAll("[data-multi-filter-option]:checked")].map((input) => input.value);
  scmScheduleFilters[field] = scmScheduleFilterValues(values);
  const label = field === "status" ? "Status" : "Brand";
  const summary = details.querySelector("[data-multi-filter-summary]");
  if (summary) summary.textContent = scmScheduleMultiFilterSummary(field, label);
}

function queueScmScheduleSearch(value) {
  scmScheduleFilters.search = String(value || "");
  clearTimeout(scmScheduleSearchTimer);
  scmScheduleSearchTimer = setTimeout(() => {
    scmScheduleSearchTimer = null;
    loadScmSchedule();
  }, 350);
}

function selectHtml({ rowId, field, value, options, disabled = false }) {
  return `
    <select data-row="${scmScheduleEscape(rowId)}" data-field="${scmScheduleEscape(field)}" ${disabled ? "disabled" : ""}>
      ${value && !options.includes(value) ? `<option value="${scmScheduleEscape(value)}">${scmScheduleEscape(value)}</option>` : ""}
      ${options.map((option) => `<option value="${scmScheduleEscape(option)}" ${String(value || "") === option ? "selected" : ""}>${scmScheduleEscape(option)}</option>`).join("")}
    </select>
  `;
}

function inputHtml({ rowId, field, value, type = "text", placeholder = "", readonly = false }) {
  return `<input data-row="${scmScheduleEscape(rowId)}" data-field="${scmScheduleEscape(field)}" type="${type}" value="${scmScheduleEscape(value || "")}" placeholder="${scmScheduleEscape(placeholder)}" autocomplete="off" ${readonly ? "readonly" : ""} />`;
}

function readOnlyCell(value, extra = "") {
  return `<span class="scm-readonly-value">${scmScheduleEscape(value || "--")}</span>${extra}`;
}

function scmScheduleCssAttr(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function scmScheduleSelectorForElement(element) {
  if (!element || !scmScheduleApp.contains(element)) return "";
  const tag = element.tagName.toLowerCase();
  if (element.dataset?.action || element.dataset?.row || element.dataset?.field || element.dataset?.filter) {
    return `${tag}${["data-action", "data-row", "data-field", "data-filter"].filter((name) => element.hasAttribute(name)).map((name) => `[${name}="${scmScheduleCssAttr(element.getAttribute(name))}"]`).join("")}`;
  }
  return "";
}

function captureScmScheduleUiState() {
  const active = document.activeElement;
  const sheet = scmScheduleApp.querySelector(".scm-sheet-wrap");
  return {
    focusSelector: scmScheduleSelectorForElement(active),
    start: typeof active?.selectionStart === "number" ? active.selectionStart : null,
    end: typeof active?.selectionEnd === "number" ? active.selectionEnd : null,
    sheetTop: sheet?.scrollTop || 0,
    sheetLeft: sheet?.scrollLeft || 0
  };
}

function restoreScmScheduleUiState(state = {}) {
  const sheet = scmScheduleApp.querySelector(".scm-sheet-wrap");
  if (sheet) {
    sheet.scrollTop = state.sheetTop || 0;
    sheet.scrollLeft = state.sheetLeft || 0;
  }
  const selector = scmScheduleFocusAfterRender || state.focusSelector;
  scmScheduleFocusAfterRender = "";
  if (!selector) return;
  const element = scmScheduleApp.querySelector(selector);
  if (!element || typeof element.focus !== "function") return;
  element.focus({ preventScroll: true });
  if (state.start !== null && !scmScheduleFocusAfterRender && typeof element.setSelectionRange === "function") {
    element.setSelectionRange(state.start, state.end ?? state.start);
  }
}

function formatScheduleNumber(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  return number.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function contentCell(row = {}) {
  const totalPalletQty = Number(row.totalPalletQty || 0);
  return `
    <div class="scm-content-layout" title="${scmScheduleEscape(row.content || "")}">
      <span class="scm-readonly-value scm-content-lines">${scmScheduleEscape(row.content || "--")}</span>
      ${totalPalletQty > 0 ? `<strong class="scm-content-total">Total ${scmScheduleEscape(formatScheduleNumber(totalPalletQty))} PLT</strong>` : ""}
    </div>
  `;
}

function orderNumberCell(row = {}) {
  if (row.orderKind === "PO") {
    const source = row.sourceRef || row.orderRef || row.displayRef;
    const ref = row.dispatchRef || row.displayRef || row.orderRef;
    return `
      <button class="scm-order-link" data-action="open-po-split" data-order="${scmScheduleEscape(source || row.orderRef || "")}" type="button">${scmScheduleEscape(source || "--")}</button>
      ${ref && ref !== source ? `<small>${scmScheduleEscape(ref)}</small>` : ""}
    `;
  }
  return `<strong>${scmScheduleEscape(row.displayRef || row.orderRef || "--")}</strong>`;
}

function poSplitLink(value, fallback = "--") {
  const text = String(value || "").trim();
  if (!text) return `<span class="scm-readonly-value">${scmScheduleEscape(fallback)}</span>`;
  return `<button class="scm-order-link" data-action="open-po-split" data-order="${scmScheduleEscape(text)}" type="button">${scmScheduleEscape(text)}</button>`;
}

function scheduleDateText(row = {}) {
  return row.queuedDate || "";
}

function renderScheduleTableRows({ pickupOptions = [], dropoffOptions = OWN_YARDS } = {}) {
  if (scmScheduleLoading) {
    return `<div class="scm-sheet-empty">Loading schedule...</div>`;
  }
  if (!scmScheduleRows.length) {
    return `<div class="scm-sheet-empty">No schedule rows match this view.</div>`;
  }

  return scmScheduleRows.map((row) => {
    const rowId = scheduleRowId(row);
    const editable = canEditScmSchedule();
    const statusEditable = editable && !SCM_SYSTEM_STATUSES.has(String(row.status || ""));
    const selectable = editable && row.orderKind === "PO" && !row.groupRef && !String(row.orderRef || "").toUpperCase().startsWith("PGOB-");
    const displayType = row.orderKind;
    const eta = [row.etaDate, row.etaTime].filter(Boolean).join(" ") || "--";
    const isGroupOrder = Boolean(row.groupRef) || String(row.orderRef || "").toUpperCase().startsWith("PGOB-");
    return `
      <div class="scm-sheet-row status-${scmScheduleEscape(String(row.status || "").toLowerCase().replaceAll(" ", "-"))} ${isGroupOrder ? "group-order" : ""}" data-row-ref="${scmScheduleEscape(row.orderRef)}">
        ${editable ? `<div class="scm-sheet-cell scm-select-cell">${selectable ? `<input data-action="select-row" data-row="${scmScheduleEscape(rowId)}" type="checkbox" ${scmScheduleSelectedRows.has(rowId) ? "checked" : ""} aria-label="Select ${scmScheduleEscape(row.orderRef)}" />` : ""}</div>` : ""}
        <div class="scm-sheet-cell readonly">${readOnlyCell(scheduleDateText(row))}</div>
        <div class="scm-sheet-cell readonly scm-type-cell">
          <strong>${scmScheduleEscape(displayType)}</strong>
          ${row.orderKind === "PO" ? `<label class="scm-sheet-check"><input data-row="${scmScheduleEscape(rowId)}" data-field="isSpecialOrder" type="checkbox" ${row.isSpecialOrder ? "checked" : ""} ${editable ? "" : "disabled"} /> Sp.O</label>` : ""}
        </div>
        <div class="scm-sheet-cell">${editable ? selectHtml({ rowId, field: "method", value: row.method, options: SCM_METHODS }) : readOnlyCell(row.method)}</div>
        <div class="scm-sheet-cell">${editable ? selectHtml({ rowId, field: "pickupPoint", value: row.pickupPoint, options: pickupOptions }) : readOnlyCell(row.pickupPoint)}</div>
        <div class="scm-sheet-cell">${editable ? selectHtml({ rowId, field: "dropoffPoint", value: row.dropoffPoint, options: dropoffOptions }) : readOnlyCell(row.dropoffPoint)}</div>
        <div class="scm-sheet-cell readonly">${readOnlyCell(row.orderKind === "TO" ? "Transfer Order" : row.brand || row.party)}</div>
        <div class="scm-sheet-cell readonly content-cell">${contentCell(row)}</div>
        <div class="scm-sheet-cell readonly">
          ${orderNumberCell(row)}
        </div>
        <div class="scm-sheet-cell readonly number-cell">${readOnlyCell(Math.round(Number(row.weightLbs || 0)).toLocaleString())}</div>
        <div class="scm-sheet-cell ${editable ? "" : "readonly"}">${editable ? inputHtml({ rowId, field: "packingSlipRef", value: row.packingSlipRef, placeholder: "Packing slip" }) : poSplitLink(row.packingSlipRef)}</div>
        <div class="scm-sheet-cell readonly">${readOnlyCell(eta)}</div>
        <div class="scm-sheet-cell readonly">${readOnlyCell(row.driver)}</div>
        <div class="scm-sheet-cell ${statusEditable ? "" : "readonly"}">${statusEditable ? selectHtml({ rowId, field: "status", value: row.status, options: SCM_MANUAL_STATUSES }) : readOnlyCell(row.status)}</div>
        <div class="scm-sheet-cell readonly">${readOnlyCell(row.sla)}</div>
        <div class="scm-sheet-cell action-cell">
          ${editable ? `<button data-action="save-row" data-row="${scmScheduleEscape(rowId)}" data-ref="${scmScheduleEscape(row.orderRef)}" data-kind="${scmScheduleEscape(row.orderKind)}" type="button" ${scmScheduleSavingRef === rowId ? "disabled" : ""}>${scmScheduleSavingRef === rowId ? "Saving" : "Save"}</button>` : `<span class="view-only-chip">View</span>`}
        </div>
      </div>
    `;
  }).join("");
}

function renderScmSchedule() {
  const uiState = captureScmScheduleUiState();
  const operator = scmScheduleOperator || {};
  const editable = canEditScmSchedule();
  const selectedRows = selectedScmScheduleRows();
  const visiblePresets = scmScheduleVisiblePresets();
  const showScmWorkingControls = scmScheduleCanShowScmWorkingControls();
  const yardManagerView = scmScheduleIsYardManagerView();
  const pickupOptions = scheduleOptionList("pickupPoint");
  const dropoffOptions = scheduleOptionList("dropoffPoint");
  const brandOptions = scheduleOptionList("brand");
  const sheetMetrics = scmScheduleGridMetrics(editable);
  scmScheduleApp.innerHTML = `
    <header class="dispatch-topbar">
      <div><p>${scmScheduleDispatchHost ? "Dispatch" : "SCM"}</p><h1>PO / TO Schedule</h1></div>
      <div class="topbar-language">${window.MBBS_I18N?.toggleHtml() || ""}</div>
      <div class="topbar-actions">
        <span class="dispatch-user">${scmScheduleEscape(operator.display_name || operator.username || "")}</span>
        <button onclick="location.href='${scmScheduleDispatchHost ? "/dispatch" : "/scm"}'" type="button">${scmScheduleDispatchHost ? "Dispatch Menu" : "SCM Menu"}</button>
        <button onclick="dispatchLogout()" type="button">Logout</button>
      </div>
    </header>
    ${scmScheduleNotice ? `<div class="route-notice scm-notice"><span>${scmScheduleEscape(scmScheduleNotice)}</span><button class="scm-notice-close" data-action="close-notice" type="button" aria-label="Close">x</button></div>` : ""}
    <section class="scm-schedule-page">
      <div class="scm-schedule-toolbar">
        ${visiblePresets.length > 1 ? `<select data-filter="view">
          ${visiblePresets.map((preset) => {
            const value = preset.name.toLowerCase();
            return `<option value="${scmScheduleEscape(value)}" ${scmScheduleFilters.view === value ? "selected" : ""}>${scmScheduleEscape(preset.name)}</option>`;
          }).join("")}
        </select>` : `<input data-filter="view" type="hidden" value="${scmScheduleEscape(scmScheduleFilters.view)}" />`}
        ${yardManagerView ? "" : `<input data-filter="search" type="search" value="${scmScheduleEscape(scmScheduleFilters.search)}" placeholder="Search all orders / vendors / content" autocomplete="off" />`}
        ${showScmWorkingControls ? `<select data-filter="kind"><option value="">All Types</option>${SCM_TYPES.map((item) => `<option ${scmScheduleFilters.kind === item ? "selected" : ""}>${item}</option>`).join("")}</select>` : ""}
        ${showScmWorkingControls ? `<select data-filter="method"><option value="">All Methods</option>${SCM_METHODS.map((item) => `<option ${scmScheduleFilters.method === item ? "selected" : ""}>${item}</option>`).join("")}</select>` : ""}
        ${yardManagerView ? "" : scmScheduleMultiFilterHtml({ field: "status", label: "Status", options: SCM_STATUS_FILTERS })}
        <select data-filter="dropoffPoint"><option value="">All Drop Off</option>${dropoffOptions.map((item) => `<option value="${scmScheduleEscape(item)}" ${scmScheduleFilters.dropoffPoint === item ? "selected" : ""}>${scmScheduleEscape(item)}</option>`).join("")}</select>
        ${scmScheduleMultiFilterHtml({ field: "brand", label: "Brand", options: brandOptions })}
        ${yardManagerView ? "" : `<input data-filter="from" type="date" value="${scmScheduleEscape(scmScheduleFilters.from)}" />`}
        ${yardManagerView ? "" : `<input data-filter="to" type="date" value="${scmScheduleEscape(scmScheduleFilters.to)}" />`}
        <button data-action="apply-filters" type="button">Apply</button>
        ${editable ? `<button class="primary" data-action="group-selected" type="button" ${selectedRows.length >= 2 ? "" : "hidden disabled"}>Group ${scmScheduleEscape(String(selectedRows.length))}</button>` : ""}
        <div class="scm-sheet-settings" role="group" aria-label="Schedule display settings">
          <label>Font <input data-sheet-setting="fontSize" type="range" min="10" max="18" step="1" value="${scmScheduleSheetPreferences.fontSize}" /><output data-sheet-output="fontSize">${scmScheduleSheetPreferences.fontSize}px</output></label>
          <label>Row <input data-sheet-setting="rowHeight" type="range" min="38" max="120" step="2" value="${scmScheduleSheetPreferences.rowHeight}" /><output data-sheet-output="rowHeight">${scmScheduleSheetPreferences.rowHeight}px</output></label>
          <button data-action="reset-sheet-layout" type="button" title="Reset column widths, row height, and font size">Reset layout</button>
        </div>
      </div>
      <div class="scm-sheet-wrap">
        <div class="scm-sheet-grid ${editable ? "with-select" : ""}" style="${scmScheduleGridStyle(editable)}">
          ${sheetMetrics.columns.map(scmScheduleHeaderHtml).join("")}
          ${renderScheduleTableRows({ pickupOptions, dropoffOptions })}
        </div>
      </div>
    </section>
  `;
  updateScmScheduleGroupButton();
  restoreScmScheduleUiState(uiState);
}

function updateScmScheduleGroupButton() {
  const button = scmScheduleApp.querySelector("[data-action='group-selected']");
  if (!button) return;
  const count = scmScheduleSelectedRows.size;
  button.hidden = count < 2;
  button.disabled = count < 2;
  button.textContent = `Group ${count}`;
}

function collectRowPatch(rowId) {
  const row = scmScheduleRows.find((item) => scheduleRowId(item) === rowId);
  const patch = { orderKind: row?.orderKind || "PO" };
  scmScheduleApp.querySelectorAll(`[data-row="${CSS.escape(rowId)}"][data-field]`).forEach((field) => {
    patch[field.dataset.field] = field.type === "checkbox" ? field.checked : field.value;
  });
  return patch;
}

scmScheduleApp.addEventListener("input", (event) => {
  const search = event.target.closest('[data-filter="search"]');
  if (search) {
    queueScmScheduleSearch(search.value);
    return;
  }
  const control = event.target.closest("[data-sheet-setting]");
  if (!control) return;
  const setting = control.dataset.sheetSetting;
  if (setting === "fontSize") {
    scmScheduleSheetPreferences.fontSize = scmScheduleClamp(control.value, 10, 18, SCM_SCHEDULE_SHEET_DEFAULTS.fontSize);
  } else if (setting === "rowHeight") {
    scmScheduleSheetPreferences.rowHeight = scmScheduleClamp(control.value, 38, 120, SCM_SCHEDULE_SHEET_DEFAULTS.rowHeight);
  }
  saveScmScheduleSheetPreferences();
  applyScmScheduleSheetPreferences();
});

scmScheduleApp.addEventListener("change", (event) => {
  const option = event.target.closest("[data-multi-filter-option]");
  if (!option) return;
  updateScmScheduleMultiFilter(option.closest("[data-multi-filter]"));
});

scmScheduleApp.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest(".scm-column-resizer");
  if (!handle) return;
  const key = handle.dataset.columnKey || "";
  const column = SCM_SCHEDULE_COLUMNS.find((item) => item.key === key);
  const header = handle.closest(".scm-sheet-header");
  if (!column || !header) return;
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = header.getBoundingClientRect().width;
  document.body.classList.add("scm-resizing-column");
  handle.setPointerCapture?.(event.pointerId);

  const move = (moveEvent) => {
    scmScheduleSheetPreferences.widths[key] = scmScheduleClamp(startWidth + moveEvent.clientX - startX, column.minWidth, 1200, column.width);
    applyScmScheduleSheetPreferences();
  };
  const finish = () => {
    document.body.classList.remove("scm-resizing-column");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    saveScmScheduleSheetPreferences();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish, { once: true });
  window.addEventListener("pointercancel", finish, { once: true });
});

scmScheduleApp.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;

  if (action === "close-notice") {
    scmScheduleNotice = "";
    renderScmSchedule();
    return;
  }

  if (action === "clear-multi-filter") {
    const details = target.closest("[data-multi-filter]");
    details?.querySelectorAll("[data-multi-filter-option]").forEach((input) => { input.checked = false; });
    updateScmScheduleMultiFilter(details);
    return;
  }

  if (action === "reset-sheet-layout") {
    scmScheduleSheetPreferences = loadScmScheduleSheetPreferences();
    scmScheduleSheetPreferences.fontSize = SCM_SCHEDULE_SHEET_DEFAULTS.fontSize;
    scmScheduleSheetPreferences.rowHeight = SCM_SCHEDULE_SHEET_DEFAULTS.rowHeight;
    scmScheduleSheetPreferences.widths = Object.fromEntries(SCM_SCHEDULE_COLUMNS.map((column) => [column.key, column.width]));
    saveScmScheduleSheetPreferences();
    renderScmSchedule();
    return;
  }

  if (action === "select-row") {
    const rowId = target.dataset.row || "";
    if (target.checked) scmScheduleSelectedRows.add(rowId);
    else scmScheduleSelectedRows.delete(rowId);
    updateScmScheduleGroupButton();
  }

  if (action === "apply-filters") {
    clearTimeout(scmScheduleSearchTimer);
    scmScheduleSearchTimer = null;
    scmScheduleApp.querySelectorAll("[data-filter]").forEach((field) => {
      scmScheduleFilters[field.dataset.filter] = field.value;
    });
    await loadScmSchedule();
  }

  if (action === "group-selected") {
    const rows = selectedScmScheduleRows();
    if (rows.length < 2) return;
    const pickupPoints = [...new Set(rows.map((row) => String(row.pickupPoint || "").trim().toLowerCase()).filter(Boolean))];
    if (pickupPoints.length !== 1) {
      scmScheduleNotice = `Group failed: pickup point must be the same. ${rows.map((row) => `${row.orderRef}=${row.pickupPoint || "blank"}`).join(", ")}`;
      renderScmSchedule();
      return;
    }
    scmScheduleNotice = "Creating SCM group...";
    renderScmSchedule();
    try {
      const refs = rows.map((row) => row.orderRef).filter(Boolean);
      const payload = await scmScheduleApi("/api/scm/schedule-groups?includeSchedule=false", {
        method: "POST",
        body: JSON.stringify({ refs, audit: { sessionId: sessionStorage.getItem("mbbs.dispatch.sessionId") || "" } })
      });
      scmScheduleSelectedRows = new Set();
      scmScheduleNotice = `Created ${payload.grouped?.groupRef || "group"}.`;
      await loadScmSchedule();
    } catch (error) {
      scmScheduleNotice = `Group failed: ${error.message}`;
      renderScmSchedule();
    }
  }

  if (action === "open-po-split") {
    const orderRef = target.dataset.order || "";
    if (!orderRef) return;
    window.open(`/scm/POsplit?order=${encodeURIComponent(orderRef)}`, "_blank", "noopener");
  }

  if (action === "save-row") {
    const rowId = target.dataset.row || "";
    const orderRef = target.dataset.ref || "";
    if (!orderRef) return;
    const patch = collectRowPatch(rowId);
    scmScheduleSavingRef = rowId;
    scmScheduleNotice = "";
    scmScheduleFocusAfterRender = `button[data-action="save-row"][data-row="${scmScheduleCssAttr(rowId)}"]`;
    renderScmSchedule();
    try {
      await scmScheduleApi(`/api/scm/schedule/${encodeURIComponent(orderRef)}?includeSchedule=false`, {
        method: "PUT",
        body: JSON.stringify({ ...patch, audit: { sessionId: sessionStorage.getItem("mbbs.dispatch.sessionId") || "" } })
      });
      scmScheduleNotice = `Saved ${orderRef}.`;
      await loadScmSchedule();
    } catch (error) {
      scmScheduleNotice = `Save failed: ${error.message}`;
      renderScmSchedule();
    } finally {
      scmScheduleSavingRef = "";
      scmScheduleFocusAfterRender = `button[data-action="save-row"][data-row="${scmScheduleCssAttr(rowId)}"]`;
      renderScmSchedule();
    }
  }
});

window.addEventListener("mbbs-language-changed", renderScmSchedule);

requireDispatchLogin({
  mount: scmScheduleApp,
  roles: ["admin", "scm", "scm_staff", "dispatcher"],
  async onReady(operator) {
    scmScheduleOperator = operator;
    scmScheduleFilters.view = scmScheduleDefaultViewForRole();
    await loadScmSchedule();
  }
});

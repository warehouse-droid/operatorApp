const scmScheduleApp = document.getElementById("scmScheduleApp");
const scmScheduleDispatchHost = window.location.pathname.startsWith("/dispatch/");
const scmScheduleSalesHost = window.location.pathname.startsWith("/sales/");

let scmScheduleOperator = null;
let scmScheduleRows = [];
let scmSchedulePresets = [];
let scmScheduleMeta = {};
let scmScheduleNotice = "";
let scmScheduleLoading = false;
let scmScheduleSavingRef = "";
let scmScheduleBlanketSavingRef = "";
let scmScheduleFilters = { view: "dispatch", search: "", status: [], method: "", kind: "", dropoffPoint: "", brand: [], from: "", to: "" };
let scmScheduleSelectedRows = new Set();
let scmScheduleReviewOnly = false;
let scmScheduleShowReconciliationDetails = false;
let scmScheduleExpandedReconciliationRows = new Set();
let scmScheduleReconciliationBusyRef = "";
let scmSchedulePoSplitLineOptions = new Map();
let scmSchedulePoSplitLineOptionsLoading = new Set();
let scmSchedulePoSplitLineOptionsErrors = new Map();
let scmSchedulePoSplitLineAdjustmentBusy = new Set();
let scmScheduleVrmaCompletingRef = "";
let scmScheduleFocusAfterRender = "";
let scmSchedulePresetsRequest = null;
let scmScheduleSearchTimer = null;
let scmScheduleLoadRequestId = 0;
let scmScheduleFormatting = { status: {}, type: {}, dropoffPoint: {} };
let scmScheduleFormattingLoaded = false;
let scmScheduleFormattingRequest = null;

const SCM_SCHEDULE_SHEET_PREF_KEY = "mbbs.scmSchedule.sheetPreferences.v1";
const SCM_SCHEDULE_RECONCILIATION_PREF_KEY = "mbbs.scmSchedule.showReconciliationDetails.v1";
const SCM_SCHEDULE_FILTER_PREF_KEY = "mbbs.scmSchedule.filters.v1";
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
const SCM_STATUS_FILTERS = ["Queued", "Planned", "Partially Done", "In Transit", "Completed", "Reconcile Review", "Urgent", "Cancelled", "Hold", "Priority", "Surplus Only", "Book Appt"];
const SCM_MANUAL_STATUSES = ["Queued", "Urgent", "Cancelled", "Hold", "Priority", "Surplus Only", "Book Appt"];
const SCM_SYSTEM_STATUSES = new Set(["Planned", "Completed", "Partially Done", "In Transit", "Reconcile Review"]);
const SCM_RESTRICTED_STATUS_KEYS = new Set(["hold", "complete", "completed", "cancelled", "canceled"]);
const SCM_TYPES = ["PO", "Sp.O", "TO", "VRMA"];
const OWN_YARDS = ["3445", "12441", "2967", "150"];

function scmScheduleSurface() {
  if (scmScheduleSalesHost) return "sales";
  if (scmScheduleDispatchHost) return "dispatch";
  return "scm";
}

function scmScheduleFilterPreferenceKey() {
  const userKey = scmScheduleOperator?.id || scmScheduleOperator?.username || "browser";
  return `${SCM_SCHEDULE_FILTER_PREF_KEY}.${scmScheduleSurface()}.${userKey}`;
}

function normalizeScmSchedulePersistedFilters(value = {}) {
  const rawKind = String(value.kind || value.orderKind || "").trim().toUpperCase();
  const kind = rawKind === "SP.O" ? "Sp.O" : rawKind;
  const method = String(value.method || "").trim();
  const scmSurface = scmScheduleSurface() === "scm";
  return {
    kind: scmSurface && SCM_TYPES.includes(kind) ? kind : "",
    method: scmSurface && SCM_METHODS.includes(method) ? method : "",
    status: scmScheduleFilterValues(value.status ?? value.statuses)
      .filter((status) => SCM_STATUS_FILTERS.includes(status))
      .filter((status) => scmScheduleCanViewRestrictedOrders()
        || !SCM_RESTRICTED_STATUS_KEYS.has(String(status || "").trim().toLowerCase()))
  };
}

function applyScmSchedulePersistedFilters(value = {}) {
  const filters = normalizeScmSchedulePersistedFilters(value);
  scmScheduleFilters.kind = filters.kind;
  scmScheduleFilters.method = filters.method;
  scmScheduleFilters.status = filters.status;
  return filters;
}

function loadLocalScmScheduleFilterPreference() {
  try {
    return normalizeScmSchedulePersistedFilters(
      JSON.parse(localStorage.getItem(scmScheduleFilterPreferenceKey()) || "{}")
    );
  } catch {
    return normalizeScmSchedulePersistedFilters();
  }
}

function saveLocalScmScheduleFilterPreference(value = scmScheduleFilters) {
  const filters = normalizeScmSchedulePersistedFilters(value);
  try {
    localStorage.setItem(scmScheduleFilterPreferenceKey(), JSON.stringify(filters));
  } catch {
    // Schedule filters still work for this page when browser storage is unavailable.
  }
  return filters;
}

function scmScheduleFilterPreferenceApiPath() {
  return scmScheduleSalesHost
    ? "/api/sales/schedule-preferences"
    : `/api/scm/schedule-preferences/${encodeURIComponent(scmScheduleSurface())}`;
}

function scmScheduleHasPrivatePreferenceAccount() {
  return Boolean(scmScheduleOperator?.id) && !scmScheduleOperator?.publicSales;
}

async function loadScmScheduleFilterPreference() {
  const localPreference = loadLocalScmScheduleFilterPreference();
  applyScmSchedulePersistedFilters(localPreference);
  if (!scmScheduleHasPrivatePreferenceAccount()) return localPreference;
  try {
    const saved = await scmScheduleApi(scmScheduleFilterPreferenceApiPath());
    if (saved?.persisted !== false) {
      const filters = applyScmSchedulePersistedFilters(saved);
      saveLocalScmScheduleFilterPreference(filters);
      return filters;
    }
  } catch {
    // Keep the operator-specific browser copy if the preference API is unavailable.
  }
  return localPreference;
}

async function saveScmScheduleFilterPreference() {
  const filters = saveLocalScmScheduleFilterPreference(scmScheduleFilters);
  if (!scmScheduleHasPrivatePreferenceAccount()) return { ...filters, persisted: false };
  const saved = await scmScheduleApi(scmScheduleFilterPreferenceApiPath(), {
    method: "PUT",
    body: JSON.stringify(filters)
  });
  const canonical = applyScmSchedulePersistedFilters(saved);
  saveLocalScmScheduleFilterPreference(canonical);
  return saved;
}

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

function scmScheduleHeaderSelect({ field, value = "", options = [], allLabel = "All" } = {}) {
  const cleanValue = String(value || "").trim();
  const cleanOptions = [...new Set([cleanValue, ...options].map((option) => String(option || "").trim()).filter(Boolean))];
  return `<select class="scm-column-filter-select ${cleanValue ? "filtered" : ""}" data-filter="${scmScheduleEscape(field)}" data-column-filter aria-label="Filter ${scmScheduleEscape(allLabel)}">
    <option value="">${scmScheduleEscape(allLabel)}</option>
    ${cleanOptions.map((option) => `<option value="${scmScheduleEscape(option)}" ${cleanValue === option ? "selected" : ""}>${scmScheduleEscape(option)}</option>`).join("")}
  </select>`;
}

function scmScheduleDateFilterSummary({
  from = scmScheduleFilters.from,
  to = scmScheduleFilters.to
} = {}) {
  if (from && to) return `${from} – ${to}`;
  if (from) return `From ${from}`;
  if (to) return `To ${to}`;
  return "All ETA";
}

function scmScheduleDateFilterHtml() {
  const filtered = Boolean(scmScheduleFilters.from || scmScheduleFilters.to);
  return `<details class="scm-column-date-filter ${filtered ? "filtered" : ""}" data-deferred-column-filter>
    <summary data-date-filter-summary>${scmScheduleEscape(scmScheduleDateFilterSummary())}</summary>
    <div class="scm-column-filter-menu align-right">
      <label><span>ETA from</span><input data-filter="from" type="date" value="${scmScheduleEscape(scmScheduleFilters.from)}" /></label>
      <label><span>ETA to</span><input data-filter="to" type="date" value="${scmScheduleEscape(scmScheduleFilters.to)}" /></label>
      <div class="scm-column-filter-actions">
        <button data-action="clear-date-filter" type="button">Clear</button>
        <button class="primary" data-action="apply-column-filters" type="button">Apply</button>
      </div>
    </div>
  </details>`;
}

function scmScheduleColumnFilterHtml(column, {
  showScmWorkingControls = false,
  yardManagerView = false,
  dropoffOptions = [],
  brandOptions = []
} = {}) {
  if (column.key === "type" && showScmWorkingControls) {
    return scmScheduleHeaderSelect({
      field: "kind",
      value: scmScheduleFilters.kind,
      options: SCM_TYPES,
      allLabel: "All Types"
    });
  }
  if (column.key === "method" && showScmWorkingControls) {
    return scmScheduleHeaderSelect({
      field: "method",
      value: scmScheduleFilters.method,
      options: SCM_METHODS,
      allLabel: "All Methods"
    });
  }
  if (column.key === "dropoff") {
    return scmScheduleHeaderSelect({
      field: "dropoffPoint",
      value: scmScheduleFilters.dropoffPoint,
      options: dropoffOptions,
      allLabel: "All Drop-off"
    });
  }
  if (column.key === "brand") {
    return scmScheduleMultiFilterHtml({
      field: "brand",
      label: "Brand",
      options: brandOptions,
      column: true
    });
  }
  if (column.key === "status" && !yardManagerView) {
    return scmScheduleMultiFilterHtml({
      field: "status",
      label: "Status",
      options: SCM_STATUS_FILTERS.filter((status) => scmScheduleCanViewRestrictedOrders()
        || !SCM_RESTRICTED_STATUS_KEYS.has(String(status || "").trim().toLowerCase())),
      column: true,
      alignRight: true
    });
  }
  if (column.key === "eta" && !yardManagerView) return scmScheduleDateFilterHtml();
  return "";
}

function scmScheduleHeaderHtml(column, context = {}) {
  const filter = scmScheduleColumnFilterHtml(column, context);
  return `<div class="scm-sheet-header ${filter ? "has-column-filter" : ""}" data-column-key="${scmScheduleEscape(column.key)}">
    <span class="scm-sheet-header-label">${scmScheduleEscape(column.label)}</span>
    ${filter}
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

function scmScheduleFormattingApiPath() {
  if (scmScheduleSalesHost) return "/api/sales/schedule-formatting";
  if (scmScheduleDispatchHost) return "/api/dispatch/schedule-formatting";
  return "/api/scm/schedule-formatting";
}

function scmScheduleFormattingColor(value, fallback) {
  const clean = String(value || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(clean) ? clean : fallback;
}

function normalizeScmScheduleFormattingPayload(payload = {}) {
  const rules = payload?.rules && typeof payload.rules === "object" ? payload.rules : {};
  return {
    status: rules.status && typeof rules.status === "object" ? rules.status : {},
    type: rules.type && typeof rules.type === "object" ? rules.type : {},
    dropoffPoint: rules.dropoffPoint && typeof rules.dropoffPoint === "object"
      ? rules.dropoffPoint
      : {}
  };
}

function loadScmScheduleFormattingOnce() {
  if (!scmScheduleFormattingRequest) {
    scmScheduleFormattingRequest = scmScheduleApi(scmScheduleFormattingApiPath())
      .then((payload) => {
        scmScheduleFormatting = normalizeScmScheduleFormattingPayload(payload);
        scmScheduleFormattingLoaded = true;
        return scmScheduleFormatting;
      })
      .catch(() => {
        scmScheduleFormattingLoaded = false;
        return scmScheduleFormatting;
      });
  }
  return scmScheduleFormattingRequest;
}

function scmScheduleFormattingRule(category, value) {
  const rules = scmScheduleFormatting?.[category];
  const cleanValue = String(value || "").trim();
  if (!rules || !cleanValue) return null;
  if (rules[cleanValue]) return rules[cleanValue];
  const match = Object.keys(rules).find((key) => key.toLowerCase() === cleanValue.toLowerCase());
  return match ? rules[match] : null;
}

function scmScheduleCellFormatting(category, value) {
  const rule = scmScheduleFormattingRule(category, value);
  if (!scmScheduleFormattingLoaded || rule?.cellEnabled !== true) {
    return { className: "", style: "" };
  }
  const background = scmScheduleFormattingColor(rule.cellBackground, "#ffffff");
  const color = scmScheduleFormattingColor(rule.cellColor, "#20313a");
  return {
    className: " scm-custom-cell-format",
    style: ` style="--scm-custom-cell-background:${background};--scm-custom-cell-color:${color}"`
  };
}

function scmScheduleRowFormatting(status) {
  const rule = scmScheduleFormattingRule("status", status);
  if (!scmScheduleFormattingLoaded || rule?.rowEnabled !== true) {
    return { className: "", style: "" };
  }
  const background = scmScheduleFormattingColor(rule.rowBackground, "#ffffff");
  const color = scmScheduleFormattingColor(rule.rowColor, "#20313a");
  return {
    className: " scm-custom-row-format",
    style: ` style="--scm-custom-row-background:${background};--scm-custom-row-color:${color}"`
  };
}

function scmScheduleQuery() {
  const params = new URLSearchParams();
  const search = String(scmScheduleFilters.search || "").trim();
  if (search) params.set("search", search);
  Object.entries(scmScheduleFilters).forEach(([key, value]) => {
    if (key === "search") return;
    if ((key === "kind" || key === "method") && !scmScheduleCanShowScmWorkingControls()) return;
    if (Array.isArray(value)) {
      value.filter(Boolean).forEach((item) => params.append(key, item));
      return;
    }
    if (!value) return;
    params.set(key, value);
  });
  if (scmScheduleReviewOnly) params.set("reconciliationStatus", "review");
  return params.toString() ? `?${params.toString()}` : "";
}

function normalizeScmSchedulePayload(payload) {
  if (Array.isArray(payload)) return { rows: payload, meta: {} };
  if (!payload || typeof payload !== "object") return { rows: [], meta: {} };
  const rows = [payload.rows, payload.schedule, payload.orders, payload.data].find(Array.isArray) || [];
  const meta = payload.meta && typeof payload.meta === "object" ? payload.meta : payload;
  return { rows, meta };
}

function loadScmSchedulePresetsOnce() {
  if (scmSchedulePresets.length) return Promise.resolve(scmSchedulePresets);
  if (!scmSchedulePresetsRequest) {
    scmSchedulePresetsRequest = scmScheduleApi(scmScheduleSalesHost ? "/api/sales/schedule-presets" : "/api/scm/view-presets").catch((error) => {
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
    const [schedulePayload, presets] = await Promise.all([
      scmScheduleApi(`${scmScheduleSalesHost ? "/api/sales/schedule" : "/api/scm/schedule"}${query}`),
      loadScmSchedulePresetsOnce(),
      loadScmScheduleFormattingOnce()
    ]);
    if (requestId !== scmScheduleLoadRequestId) return;
    const schedule = normalizeScmSchedulePayload(schedulePayload);
    scmScheduleRows = schedule.rows.filter((row) =>
      scmScheduleCanViewRestrictedOrders() || !scmScheduleIsRestrictedOrder(row));
    scmScheduleMeta = schedule.meta;
    scmSchedulePresets = presets;
    const validRowIds = new Set(scmScheduleRows.filter((row) => !scmScheduleNeedsReconciliationReview(row)).map(scheduleRowId));
    scmScheduleSelectedRows = new Set([...scmScheduleSelectedRows].filter((rowId) => validRowIds.has(rowId)));
    const loadedRowIds = new Set(scmScheduleRows.map(scheduleRowId));
    scmScheduleExpandedReconciliationRows = new Set([...scmScheduleExpandedReconciliationRows].filter((rowId) => loadedRowIds.has(rowId)));
  } catch (error) {
    if (requestId === scmScheduleLoadRequestId) scmScheduleNotice = `Schedule load failed: ${error.message}`;
  } finally {
    if (requestId === scmScheduleLoadRequestId) {
      scmScheduleLoading = false;
      renderScmSchedule();
    }
  }
}

async function waitForScmScheduleReconciliationRerun({
  rowId,
  runId,
  attempts = 20,
  intervalMs = 1500
} = {}) {
  let lastStatus = "queued";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (runId) {
      try {
        const payload = await scmScheduleApi(`/api/scm/reconciliation/runs/${encodeURIComponent(runId)}`);
        lastStatus = String(payload?.run?.status || payload?.status || "").trim().toLowerCase();
      } catch {
        lastStatus = "";
      }
    }
    await loadScmSchedule();
    const row = scmScheduleRows.find((item) => scheduleRowId(item) === rowId);
    if (!row || !scmScheduleNeedsReconciliationReview(row)) {
      return { cleared: true, status: lastStatus };
    }
    if (lastStatus && !["queued", "running"].includes(lastStatus)) {
      return { cleared: false, status: lastStatus };
    }
  }
  return { cleared: false, status: lastStatus || "running", timedOut: true };
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

function scmScheduleRoles() {
  return new Set([
    ...(Array.isArray(scmScheduleOperator?.roles) ? scmScheduleOperator.roles : []),
    scmScheduleOperator?.role
  ].map((role) => String(role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_")).filter(Boolean));
}

function scmScheduleCanViewReconciliationDetails() {
  const roles = scmScheduleRoles();
  return ["admin", "scm", "scm_staff"].some((role) => roles.has(role));
}

function scmScheduleCanRetryReconciliation() {
  return scmScheduleCanViewReconciliationDetails();
}

function scmScheduleCanResolveReconciliation() {
  return scmScheduleRoles().has("admin");
}

function scmScheduleCanCompleteVrma() {
  const roles = scmScheduleRoles();
  return ["admin", "scm", "scm_staff"].some((role) => roles.has(role));
}

function scmScheduleCanViewRestrictedOrders() {
  const roles = scmScheduleRoles();
  return ["admin", "scm", "scm_staff"].some((role) => roles.has(role));
}

function scmScheduleIsRestrictedOrder(row = {}) {
  if (row.isBlanket === true) return true;
  return SCM_RESTRICTED_STATUS_KEYS.has(scmScheduleEffectiveStatus(row).toLowerCase());
}

function scmScheduleReconciliationPreferenceKey() {
  const userKey = scmScheduleOperator?.id || scmScheduleOperator?.username || "browser";
  return `${SCM_SCHEDULE_RECONCILIATION_PREF_KEY}.${userKey}`;
}

function loadLocalScmScheduleReconciliationPreference() {
  try {
    return localStorage.getItem(scmScheduleReconciliationPreferenceKey()) === "true";
  } catch {
    return false;
  }
}

function saveLocalScmScheduleReconciliationPreference(value) {
  try {
    localStorage.setItem(scmScheduleReconciliationPreferenceKey(), value ? "true" : "false");
  } catch {
    // This preference remains optional when browser storage is unavailable.
  }
}

function reconciliationPreferenceValue(payload = {}) {
  const value = payload.showDetails
    ?? payload.showReconciliationDetails
    ?? payload.preferences?.showDetails
    ?? payload.preferences?.showReconciliationDetails;
  return typeof value === "boolean" ? value : null;
}

async function loadScmScheduleReconciliationPreference() {
  scmScheduleShowReconciliationDetails = loadLocalScmScheduleReconciliationPreference();
  if (!scmScheduleCanViewReconciliationDetails()) return;
  try {
    const payload = await scmScheduleApi("/api/scm/reconciliation/preferences");
    const saved = reconciliationPreferenceValue(payload);
    if (saved !== null) {
      scmScheduleShowReconciliationDetails = saved;
      saveLocalScmScheduleReconciliationPreference(saved);
    }
  } catch {
    // Older servers use the per-user browser preference until the endpoint is deployed.
  }
}

async function saveScmScheduleReconciliationPreference(value) {
  const previous = scmScheduleShowReconciliationDetails;
  scmScheduleShowReconciliationDetails = Boolean(value);
  saveLocalScmScheduleReconciliationPreference(scmScheduleShowReconciliationDetails);
  try {
    await scmScheduleApi("/api/scm/reconciliation/preferences", {
      method: "PUT",
      body: JSON.stringify({ showDetails: scmScheduleShowReconciliationDetails })
    });
  } catch (error) {
    scmScheduleShowReconciliationDetails = previous;
    saveLocalScmScheduleReconciliationPreference(previous);
    throw error;
  }
}

function scmScheduleAllowedViewsForRole() {
  const canViewRestricted = scmScheduleCanViewRestrictedOrders();
  if (scmScheduleSalesHost) return canViewRestricted ? ["yard manager", "completed"] : ["yard manager"];
  if (scmScheduleDispatchHost) return canViewRestricted ? ["dispatch", "completed"] : ["dispatch"];
  if (canViewRestricted) return null;
  const role = scmScheduleRole();
  if (role === "dispatcher") return ["dispatch"];
  if (role === "yard_manager" || role === "yard-manager" || role === "yard manager") return ["yard manager"];
  return null;
}

function scmScheduleDefaultViewForRole() {
  if (scmScheduleSalesHost) return "yard manager";
  if (scmScheduleDispatchHost) return "dispatch";
  if (scmScheduleCanViewRestrictedOrders()) return "scm working";
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
  return canEditScmSchedule() && scmScheduleCanViewRestrictedOrders();
}

function scmScheduleCanManageBlankets() {
  return !scmScheduleDispatchHost && !scmScheduleSalesHost && scmScheduleFilters.view === "blanket"
    && scmScheduleCanViewRestrictedOrders();
}

function scmScheduleIsYardManagerView() {
  if (scmScheduleCanViewRestrictedOrders()) return false;
  const role = scmScheduleRole();
  return role === "yard_manager" || role === "yard-manager" || role === "yard manager";
}

function selectedScmScheduleRows() {
  return scmScheduleRows.filter((row) => !scmScheduleNeedsReconciliationReview(row) && scmScheduleSelectedRows.has(scheduleRowId(row)));
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

function scmScheduleMultiFilterSummary(field, label, { selectedValues = null, column = false } = {}) {
  const selected = selectedValues === null
    ? scmScheduleFilterValues(scmScheduleFilters[field])
    : scmScheduleFilterValues(selectedValues);
  if (!selected.length) return column ? "All" : `All ${label}`;
  if (selected.length <= 2) return `${label}: ${selected.join(", ")}`;
  return `${label} (${selected.length})`;
}

function scmScheduleMultiFilterHtml({ field, label, options = [], column = false, alignRight = false }) {
  const selected = new Set(scmScheduleFilterValues(scmScheduleFilters[field]));
  const cleanOptions = [...new Set([...selected, ...options].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  return `<details class="scm-multi-filter ${column ? "column-filter" : ""} ${selected.size ? "filtered" : ""}" data-multi-filter="${scmScheduleEscape(field)}" data-multi-filter-label="${scmScheduleEscape(label)}" ${column ? "data-column-filter" : ""}>
    <summary data-multi-filter-summary>${scmScheduleEscape(scmScheduleMultiFilterSummary(field, label, { column }))}</summary>
    <div class="scm-multi-filter-menu ${alignRight ? "align-right" : ""}">
      <div class="scm-multi-filter-head">
        <strong>${scmScheduleEscape(label)}</strong>
        <div><button data-action="clear-multi-filter" data-filter-name="${scmScheduleEscape(field)}" type="button">Clear</button><button class="primary" data-action="apply-column-filters" type="button">Apply</button></div>
      </div>
      <div class="scm-multi-filter-options">
        ${cleanOptions.map((option) => `<label><input data-multi-filter-option type="checkbox" value="${scmScheduleEscape(option)}" ${selected.has(option) ? "checked" : ""} /><span>${scmScheduleEscape(option)}</span></label>`).join("")}
      </div>
    </div>
  </details>`;
}

function scmScheduleMultiFilterSelectedValues(details) {
  return [...(details?.querySelectorAll("[data-multi-filter-option]:checked") || [])]
    .map((input) => input.value);
}

function updateScmScheduleMultiFilter(details, { commit = true } = {}) {
  if (!details) return;
  const field = details.dataset.multiFilter || "";
  if (!field) return;
  const values = scmScheduleFilterValues(scmScheduleMultiFilterSelectedValues(details));
  if (commit) scmScheduleFilters[field] = values;
  details.classList.toggle("filtered", values.length > 0);
  const label = details.dataset.multiFilterLabel || (field === "status" ? "Status" : "Brand");
  const summary = details.querySelector("[data-multi-filter-summary]");
  if (summary) summary.textContent = scmScheduleMultiFilterSummary(field, label, {
    selectedValues: values,
    column: details.hasAttribute("data-column-filter")
  });
}

function queueScmScheduleSearch(value) {
  scmScheduleFilters.search = String(value || "");
  clearTimeout(scmScheduleSearchTimer);
  scmScheduleSearchTimer = setTimeout(() => {
    scmScheduleSearchTimer = null;
    loadScmSchedule();
  }, 350);
}

function updateScmScheduleDateFilterSummary(details) {
  if (!details) return;
  const from = details.querySelector('[data-filter="from"]')?.value || "";
  const to = details.querySelector('[data-filter="to"]')?.value || "";
  details.classList.toggle("filtered", Boolean(from || to));
  const summary = details.querySelector("[data-date-filter-summary]");
  if (summary) summary.textContent = scmScheduleDateFilterSummary({ from, to });
}

function scmScheduleHasColumnFilters() {
  return Boolean(
    scmScheduleFilters.kind
    || scmScheduleFilters.method
    || scmScheduleFilters.dropoffPoint
    || scmScheduleFilters.from
    || scmScheduleFilters.to
    || scmScheduleFilterValues(scmScheduleFilters.status).length
    || scmScheduleFilterValues(scmScheduleFilters.brand).length
  );
}

async function applyScmScheduleFilters() {
  clearTimeout(scmScheduleSearchTimer);
  scmScheduleSearchTimer = null;
  scmScheduleApp.querySelectorAll("[data-filter]").forEach((field) => {
    scmScheduleFilters[field.dataset.filter] = field.value;
  });
  scmScheduleApp.querySelectorAll("[data-multi-filter]").forEach((details) => {
    updateScmScheduleMultiFilter(details, { commit: true });
  });
  try {
    await saveScmScheduleFilterPreference();
  } catch (error) {
    scmScheduleNotice = `Filters were applied, but the signed-in preference was not saved: ${error.message}`;
  }
  await loadScmSchedule();
}

function selectHtml({ rowId, field, value, options, disabled = false }) {
  const cleanValue = String(value || "").trim();
  return `
    <select data-row="${scmScheduleEscape(rowId)}" data-field="${scmScheduleEscape(field)}" ${disabled ? "disabled" : ""}>
      ${!cleanValue ? '<option value="" selected>--</option>' : ""}
      ${cleanValue && !options.includes(cleanValue) ? `<option value="${scmScheduleEscape(cleanValue)}">${scmScheduleEscape(cleanValue)}</option>` : ""}
      ${options.map((option) => `<option value="${scmScheduleEscape(option)}" ${cleanValue === option ? "selected" : ""}>${scmScheduleEscape(option)}</option>`).join("")}
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

function scmScheduleFirstValue(source = {}, keys = []) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function scmScheduleReconciliation(row = {}) {
  return row.reconciliation && typeof row.reconciliation === "object" ? row.reconciliation : {};
}

function scmScheduleEffectiveStatus(row = {}) {
  const reconciliation = scmScheduleReconciliation(row);
  return String(
    scmScheduleFirstValue(row, [
      "calculatedStatus",
      "reconciliationApplicationStatus",
      "calculated_status",
      "reconciliation_application_status"
    ])
      ?? scmScheduleFirstValue(reconciliation, [
        "applicationStatus",
        "calculatedStatus",
        "application_status",
        "calculated_status"
      ])
      ?? row.status
      ?? "Queued"
  ).trim() || "Queued";
}

function scmScheduleReconciliationStatus(row = {}) {
  const reconciliation = scmScheduleReconciliation(row);
  const status = scmScheduleFirstValue(row, ["reconciliationStatus", "reconcileStatus", "reconciliation_status"])
    ?? scmScheduleFirstValue(reconciliation, ["status", "reconciliationStatus", "reconcileStatus"]);
  const normalized = String(status || "").trim().toLowerCase().replaceAll("_", " ").replaceAll("-", " ");
  if (normalized === "review" || normalized === "reconcile review" || scmScheduleEffectiveStatus(row).toLowerCase() === "reconcile review") return "review";
  if (["unreconciled", "pending", "missing", "error"].includes(normalized)) return "unreconciled";
  return normalized || "ok";
}

function scmScheduleNeedsReconciliationReview(row = {}) {
  return scmScheduleReconciliationStatus(row) === "review";
}

function scmScheduleReconciliationReason(row = {}) {
  const reconciliation = scmScheduleReconciliation(row);
  return String(
    scmScheduleFirstValue(row, ["reconciliationReason", "reviewReason", "reconciliation_reason"])
      ?? scmScheduleFirstValue(reconciliation, ["reason", "reviewReason", "reconciliationReason"])
      ?? ""
  ).trim();
}

function scmScheduleReviewCount() {
  const explicit = scmScheduleFirstValue(scmScheduleMeta, [
    "reconciliationReviewCount",
    "reconcileReviewCount",
    "reviewCount",
    "reconciliation_review_count"
  ]);
  const count = Number(explicit);
  return explicit !== null && Number.isFinite(count) && count >= 0
    ? count
    : scmScheduleRows.filter(scmScheduleNeedsReconciliationReview).length;
}

function scmScheduleHistoryTime(row = {}) {
  const reconciliation = scmScheduleReconciliation(row);
  const raw = scmScheduleFirstValue(row, [
    "completedAt", "completed_at", "cancelledAt", "cancelled_at", "terminalAt", "terminal_at",
    "statusChangedAt", "status_changed_at", "historyAt", "updatedAt", "updated_at"
  ]) ?? scmScheduleFirstValue(reconciliation, [
    "completedAt", "completed_at", "cancelledAt", "cancelled_at", "terminalAt", "terminal_at",
    "statusChangedAt", "status_changed_at", "lastReconciledAt", "last_reconciled_at", "reconciledAt", "updatedAt"
  ]);
  const timestamp = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function scmScheduleDisplayRows() {
  let rows = scmScheduleRows;
  if (scmScheduleReviewOnly) rows = rows.filter(scmScheduleNeedsReconciliationReview);
  const historyView = scmScheduleFilters.view === "completed"
    || (scmScheduleFilterValues(scmScheduleFilters.status).length > 0
      && scmScheduleFilterValues(scmScheduleFilters.status).every((status) => ["Completed", "Cancelled"].includes(status)));
  if (!historyView) return rows;
  return rows.map((row, index) => ({ row, index }))
    .sort((left, right) => scmScheduleHistoryTime(right.row) - scmScheduleHistoryTime(left.row) || left.index - right.index)
    .map(({ row }) => row);
}

function scmScheduleRowMatchesCurrentFilters(row = {}) {
  if (!scmScheduleCanViewRestrictedOrders() && scmScheduleIsRestrictedOrder(row)) return false;
  const effectiveStatus = scmScheduleEffectiveStatus(row);
  const search = String(scmScheduleFilters.search || "").trim().toLowerCase();
  if (search) {
    const searchable = [
      row.orderRef,
      row.sourceRef,
      row.dispatchRef,
      row.displayRef,
      row.party,
      row.pickupPoint,
      row.dropoffPoint,
      row.brand,
      row.content,
      row.packingSlipRef,
      row.groupRef
    ].join(" ").toLowerCase();
    if (!searchable.includes(search)) return false;
  }
  const statuses = scmScheduleFilterValues(scmScheduleFilters.status);
  if (statuses.length && !statuses.includes(effectiveStatus)) return false;
  if (scmScheduleFilters.method && row.method !== scmScheduleFilters.method) return false;
  if (scmScheduleFilters.kind === "Sp.O" && !(row.orderKind === "PO" && row.isSpecialOrder)) return false;
  if (scmScheduleFilters.kind && scmScheduleFilters.kind !== "Sp.O" && row.orderKind !== scmScheduleFilters.kind) return false;
  if (scmScheduleFilters.dropoffPoint) {
    const dropoffPoints = String(row.dropoffPoint || "")
      .replace(/\s+/g, "")
      .split("+")
      .filter(Boolean);
    if (!dropoffPoints.includes(scmScheduleFilters.dropoffPoint)) return false;
  }
  const brands = scmScheduleFilterValues(scmScheduleFilters.brand)
    .map((brand) => brand.toLowerCase());
  if (brands.length && !brands.includes(String(row.brand || "").trim().toLowerCase())) return false;
  const etaDate = String(row.etaDate || "").slice(0, 10);
  if (scmScheduleFilters.from && (!etaDate || etaDate < scmScheduleFilters.from)) return false;
  if (scmScheduleFilters.to && (!etaDate || etaDate > scmScheduleFilters.to)) return false;

  const view = String(scmScheduleFilters.view || "").toLowerCase();
  if (view !== "blanket" && row.isBlanket) return false;
  if (view === "blanket" && (row.orderKind !== "PO" || !row.isBlanket)) return false;
  if (view === "dispatch"
    && (row.method !== "MBT" || ["Cancelled", "Hold"].includes(effectiveStatus))) return false;
  if (view === "completed" && !["Completed", "Cancelled"].includes(effectiveStatus)) return false;
  if (scmScheduleReviewOnly && !scmScheduleNeedsReconciliationReview(row)) return false;
  return true;
}

function moveScmScheduleMapEntry(map, oldRowId, newRowId = "") {
  if (!map.has(oldRowId)) return;
  const value = map.get(oldRowId);
  map.delete(oldRowId);
  if (newRowId) map.set(newRowId, value);
}

function moveScmScheduleSetEntry(set, oldRowId, newRowId = "") {
  if (!set.has(oldRowId)) return;
  set.delete(oldRowId);
  if (newRowId) set.add(newRowId);
}

function migrateScmScheduleRowState(oldRowId, newRowId = "") {
  moveScmScheduleSetEntry(scmScheduleSelectedRows, oldRowId, newRowId);
  moveScmScheduleSetEntry(scmScheduleExpandedReconciliationRows, oldRowId, newRowId);
  moveScmScheduleSetEntry(scmSchedulePoSplitLineOptionsLoading, oldRowId, newRowId);
  moveScmScheduleMapEntry(scmSchedulePoSplitLineOptions, oldRowId, newRowId);
  moveScmScheduleMapEntry(scmSchedulePoSplitLineOptionsErrors, oldRowId, newRowId);
  const oldPrefix = `${oldRowId}::`;
  for (const busyKey of [...scmSchedulePoSplitLineAdjustmentBusy]) {
    if (!busyKey.startsWith(oldPrefix)) continue;
    scmSchedulePoSplitLineAdjustmentBusy.delete(busyKey);
    if (newRowId) scmSchedulePoSplitLineAdjustmentBusy.add(`${newRowId}::${busyKey.slice(oldPrefix.length)}`);
  }
  if (scmScheduleReconciliationBusyRef === oldRowId) {
    scmScheduleReconciliationBusyRef = newRowId;
  }
}

function scmScheduleReconciliationQuantity(row = {}, keys = []) {
  const reconciliation = scmScheduleReconciliation(row);
  const quantities = reconciliation.quantities && typeof reconciliation.quantities === "object"
    ? reconciliation.quantities
    : {};
  const direct = scmScheduleFirstValue(quantities, keys)
    ?? scmScheduleFirstValue(reconciliation, keys)
    ?? scmScheduleFirstValue(row, keys);
  const number = Number(direct);
  return Number.isFinite(number) ? number : 0;
}

function scmScheduleReconciliationDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function scmScheduleReconciliationLines(row = {}) {
  const reconciliation = scmScheduleReconciliation(row);
  const lines = reconciliation.lines ?? row.reconciliationLines ?? row.reconciliation_lines;
  return Array.isArray(lines) ? lines : [];
}

function scmScheduleAllocationTargets(row = {}) {
  const reconciliation = scmScheduleReconciliation(row);
  const explicit = reconciliation.allocationTargets
    ?? reconciliation.allocation_targets
    ?? row.reconciliationAllocationTargets;
  const targets = Array.isArray(explicit) ? explicit : [];
  if (targets.length) return targets;
  return scmScheduleReconciliationLines(row).flatMap((line) => {
    const children = line.candidateChildren ?? line.allocationTargets ?? line.splitChildren;
    if (!Array.isArray(children)) return [];
    return children.map((child) => ({
      ...child,
      lineKey: child.lineKey ?? line.lineKey ?? line.netSuiteLineKey ?? line.netsuiteLineKey,
      item: child.item ?? child.itemRef ?? line.item ?? line.itemRef
    }));
  });
}

function scmSchedulePoSplitAdjustmentOrderRef(row = {}) {
  return String(row.sourceRef || row.sourceOrderRef || row.orderRef || "").trim();
}

function scmSchedulePoSplitAdjustmentEntry(rowId, ledgerLineId) {
  const payload = scmSchedulePoSplitLineOptions.get(rowId);
  const adjustments = Array.isArray(payload?.adjustments) ? payload.adjustments : [];
  return adjustments.find((adjustment) =>
    String(adjustment?.ledgerLineId ?? "") === String(ledgerLineId ?? "")
  ) || null;
}

function scmSchedulePoSplitAdjustmentCandidate(adjustment, localLineId) {
  const candidates = Array.isArray(adjustment?.candidates) ? adjustment.candidates : [];
  return candidates.find((candidate) =>
    String(candidate?.localLineId ?? "") === String(localLineId ?? "")
  ) || null;
}

function scmSchedulePoSplitRequiresBaselineReduction(candidate = {}) {
  if (candidate.requiresBaselineReduction === true) return true;
  const baseline = Number(candidate.baselineQty);
  const recommended = Number(candidate.recommendedBaselineQty);
  return Number.isFinite(baseline)
    && Number.isFinite(recommended)
    && recommended < baseline;
}

function scmSchedulePoSplitCandidatePreviewHtml(candidate = null) {
  if (!candidate) {
    return `<span class="scm-po-split-line-choice-empty">Choose a compatible source line to preview its capacity and baseline impact.</span>`;
  }
  const requiresReduction = scmSchedulePoSplitRequiresBaselineReduction(candidate);
  const baseline = formatScheduleNumber(candidate.baselineQty);
  const recommendedBaseline = formatScheduleNumber(
    candidate.recommendedBaselineQty ?? candidate.baselineQty
  );
  return `<div class="scm-po-split-line-candidate-metrics">
      <span>Ordered <strong>${scmScheduleEscape(formatScheduleNumber(candidate.orderedQty))}</strong></span>
      <span>Received <strong>${scmScheduleEscape(formatScheduleNumber(candidate.receivedQty))}</strong></span>
      <span>Stored baseline <strong>${scmScheduleEscape(baseline)}</strong></span>
      <span>After adjustment <strong>${scmScheduleEscape(recommendedBaseline)}</strong></span>
    </div>
    ${requiresReduction
      ? `<label class="scm-po-split-baseline-confirm">
          <input data-po-split-baseline-confirm type="checkbox" />
          <span>I confirm lowering this source line's received baseline from
            <strong>${scmScheduleEscape(baseline)}</strong> to
            <strong>${scmScheduleEscape(recommendedBaseline)}</strong>. This change is recorded in the audit log.</span>
        </label>`
      : `<span class="scm-po-split-baseline-safe">No received-baseline reduction is needed for this source line.</span>`}`;
}

function scmSchedulePoSplitLineAdjustmentHtml(row = {}) {
  const rowId = scheduleRowId(row);
  if (!scmScheduleCanResolveReconciliation()
    || String(row.orderKind || "").toUpperCase() !== "PO") return "";
  const loading = scmSchedulePoSplitLineOptionsLoading.has(rowId);
  const error = scmSchedulePoSplitLineOptionsErrors.get(rowId) || "";
  const loaded = scmSchedulePoSplitLineOptions.has(rowId);
  const payload = scmSchedulePoSplitLineOptions.get(rowId);
  const adjustments = Array.isArray(payload?.adjustments) ? payload.adjustments : [];
  const orderRef = scmSchedulePoSplitAdjustmentOrderRef(row);

  let body = "";
  if (loading) {
    body = `<div class="scm-po-split-line-adjustment-state" role="status">Loading compatible source lines…</div>`;
  } else if (error) {
    body = `<div class="scm-po-split-line-adjustment-state error" role="alert">
      <span>${scmScheduleEscape(error)}</span>
      <button data-action="load-po-split-line-options" data-row="${scmScheduleEscape(rowId)}" type="button">Try again</button>
    </div>`;
  } else if (!loaded) {
    body = `<div class="scm-po-split-line-adjustment-state">
      <span>Load the active PO split lines and compatible NetSuite source lines before making an adjustment.</span>
      <button data-action="load-po-split-line-options" data-row="${scmScheduleEscape(rowId)}" type="button">Load source-line options</button>
    </div>`;
  } else if (!adjustments.length) {
    body = `<div class="scm-po-split-line-adjustment-state">No active split line has another compatible source line on ${scmScheduleEscape(orderRef || "this PO")}.</div>`;
  } else {
    body = `<div class="scm-po-split-line-adjustment-list">
      ${adjustments.map((adjustment) => {
        const ledgerLineId = adjustment.ledgerLineId;
        const current = adjustment.currentSource && typeof adjustment.currentSource === "object"
          ? adjustment.currentSource
          : {};
        const candidates = Array.isArray(adjustment.candidates) ? adjustment.candidates : [];
        const targetRef = adjustment.targetOrderRef || "--";
        const item = adjustment.itemName || adjustment.sku || "--";
        const sku = adjustment.sku && adjustment.sku !== item ? adjustment.sku : "";
        const unit = adjustment.unit || "";
        const busyKey = `${rowId}::${ledgerLineId}`;
        const busy = scmSchedulePoSplitLineAdjustmentBusy.has(busyKey);
        return `<article class="scm-po-split-line-adjustment-card"
            data-po-split-line-adjustment
            data-row="${scmScheduleEscape(rowId)}"
            data-ledger-line-id="${scmScheduleEscape(ledgerLineId)}">
          <div class="scm-po-split-line-adjustment-head">
            <div><strong>${scmScheduleEscape(targetRef)} · ${scmScheduleEscape(item)}</strong>
              ${sku ? `<small>${scmScheduleEscape(sku)}</small>` : ""}
            </div>
            <span>Requested <strong>${scmScheduleEscape(formatScheduleNumber(adjustment.requestedQty))}</strong> ${scmScheduleEscape(unit)}</span>
          </div>
          <div class="scm-po-split-current-source">
            <span>Current source line</span>
            <strong>${scmScheduleEscape(current.lineKey || current.localLineId || "--")}</strong>
            <span>${scmScheduleEscape(formatScheduleNumber(current.receivedQty))} received /
              ${scmScheduleEscape(formatScheduleNumber(current.orderedQty))} ordered · baseline
              ${scmScheduleEscape(formatScheduleNumber(current.baselineQty))}</span>
          </div>
          <label class="scm-po-split-line-select">
            <span>Move this split line to</span>
            <select data-po-split-source-select ${busy ? "disabled" : ""}>
              <option value="">Choose source line…</option>
              ${candidates.map((candidate) => `<option value="${scmScheduleEscape(candidate.localLineId)}">
                ${scmScheduleEscape(candidate.lineKey || candidate.localLineId || "--")} ·
                ${scmScheduleEscape(formatScheduleNumber(candidate.receivedQty))} /
                ${scmScheduleEscape(formatScheduleNumber(candidate.orderedQty))} received
              </option>`).join("")}
            </select>
          </label>
          <div class="scm-po-split-line-choice" data-po-split-candidate-preview>
            ${scmSchedulePoSplitCandidatePreviewHtml()}
          </div>
          <label class="scm-po-split-line-note">
            <span>Required audit note</span>
            <textarea data-po-split-line-note rows="2" maxlength="1000"
              placeholder="Explain why this split belongs to the selected NetSuite source line"
              ${busy ? "disabled" : ""}></textarea>
          </label>
          <div class="scm-po-split-line-adjustment-error" data-po-split-line-error role="alert"></div>
          <div class="scm-po-split-line-adjustment-actions">
            <button class="primary" data-action="apply-po-split-line-adjustment"
              data-row="${scmScheduleEscape(rowId)}"
              data-ledger-line-id="${scmScheduleEscape(ledgerLineId)}"
              type="button" ${busy ? "disabled" : ""}>${busy ? "Applying…" : "Adjust source line"}</button>
          </div>
        </article>`;
      }).join("")}
    </div>`;
  }

  return `<section class="scm-po-split-line-adjustments" data-po-split-line-options>
    <div class="scm-po-split-line-adjustments-head">
      <div><strong>Admin source-line adjustment</strong>
        <span>Repair an active PO split that was linked to the wrong same-item NetSuite line.</span>
      </div>
      ${loaded && !loading ? `<button data-action="load-po-split-line-options" data-row="${scmScheduleEscape(rowId)}" type="button">Refresh options</button>` : ""}
    </div>
    ${body}
  </section>`;
}

async function loadScmSchedulePoSplitLineOptions(rowId, row = {}, { force = false } = {}) {
  if (!scmScheduleCanResolveReconciliation()
    || String(row.orderKind || "").toUpperCase() !== "PO"
    || scmSchedulePoSplitLineOptionsLoading.has(rowId)
    || (!force && scmSchedulePoSplitLineOptions.has(rowId))) return;
  const orderRef = scmSchedulePoSplitAdjustmentOrderRef(row);
  if (!orderRef) return;
  scmSchedulePoSplitLineOptionsLoading.add(rowId);
  scmSchedulePoSplitLineOptionsErrors.delete(rowId);
  renderScmSchedule();
  try {
    const query = new URLSearchParams({ orderRef });
    const payload = await scmScheduleApi(`/api/scm/reconciliation/po-split-line-options?${query.toString()}`);
    scmSchedulePoSplitLineOptions.set(rowId, payload && typeof payload === "object"
      ? payload
      : { order: { orderRef }, adjustments: [] });
  } catch (error) {
    scmSchedulePoSplitLineOptions.delete(rowId);
    scmSchedulePoSplitLineOptionsErrors.set(rowId, `Source-line options could not be loaded: ${error.message}`);
  } finally {
    scmSchedulePoSplitLineOptionsLoading.delete(rowId);
    renderScmSchedule();
  }
}

function scmScheduleReconciliationDismissible(row = {}) {
  const reconciliation = scmScheduleReconciliation(row);
  if (reconciliation.dismissible === true || row.reconciliationDismissible === true) return true;
  const cases = reconciliation.reviewCases ?? reconciliation.cases ?? row.reconciliationReviewCases;
  return Array.isArray(cases) && cases.some((reviewCase) =>
    reviewCase?.dismissible === true
    && ["open", "review", ""].includes(String(reviewCase.status || "").trim().toLowerCase())
  );
}

function scmScheduleOpenReviewCases(row = {}) {
  const reconciliation = scmScheduleReconciliation(row);
  const cases = reconciliation.reviewCases ?? reconciliation.cases ?? row.reconciliationReviewCases;
  return Array.isArray(cases)
    ? cases.filter((reviewCase) => ["", "open", "review"].includes(
      String(reviewCase?.status || "").trim().toLowerCase()
    ))
    : [];
}

function scmScheduleMissingSourceReview(row = {}) {
  return scmScheduleOpenReviewCases(row).find((reviewCase) =>
    String(reviewCase?.code ?? reviewCase?.reviewCode ?? reviewCase?.review_code ?? "")
      .trim()
      .toLowerCase() === "source_missing"
  ) || null;
}

function scmScheduleReconciliationBadge(row = {}) {
  const status = scmScheduleReconciliationStatus(row);
  const reason = scmScheduleReconciliationReason(row);
  if (status === "review") {
    return `<span class="scm-reconcile-badge review" title="${scmScheduleEscape(reason || "This order requires reconciliation review.")}">Reconcile Review</span>
      ${reason ? `<small class="scm-reconcile-reason" title="${scmScheduleEscape(reason)}">${scmScheduleEscape(reason)}</small>` : ""}`;
  }
  if (status === "unreconciled" && scmScheduleCanViewReconciliationDetails() && scmScheduleShowReconciliationDetails) {
    return `<span class="scm-reconcile-badge pending">Not reconciled</span>`;
  }
  return "";
}

function scmScheduleReconciliationSummaryHtml(row = {}) {
  const reconciliation = scmScheduleReconciliation(row);
  const kind = String(row.orderKind || "").toUpperCase();
  const ordered = scmScheduleReconciliationQuantity(row, kind === "TO"
    ? ["transfer", "transferQty", "transfer_qty", "ordered", "orderedQty", "ordered_qty", "currentQuantity"]
    : ["ordered", "orderedQty", "ordered_qty", "purchase", "purchaseQty", "purchase_qty", "currentQuantity"]);
  const fulfilled = scmScheduleReconciliationQuantity(row, ["fulfilled", "fulfilledQty", "fulfilled_qty", "sourceFulfilled", "sourceFulfilledQty", "source_fulfilled_qty"]);
  const received = scmScheduleReconciliationQuantity(row, ["received", "receivedQty", "received_qty", "destinationReceived", "destinationReceivedQty", "destination_received_qty"]);
  const abandoned = scmScheduleReconciliationQuantity(row, ["abandoned", "abandonedQty", "abandoned_qty", "closed", "closedQty", "closed_qty"]);
  const remaining = scmScheduleReconciliationQuantity(row, ["remaining", "remainingQty", "remaining_qty", "open", "openQty", "open_qty"]);
  const allocated = scmScheduleReconciliationQuantity(row, ["allocated", "allocatedQty", "allocated_qty", "splitAllocated", "splitAllocatedQty", "split_allocated_qty"]);
  const exact = reconciliation.exactAllocation ?? reconciliation.allocationExact ?? row.reconciliationExactAllocation;
  const method = String(reconciliation.allocationMethod ?? reconciliation.allocation_method ?? "").trim();
  const lastReconciledAt = reconciliation.lastReconciledAt
    ?? reconciliation.last_reconciled_at
    ?? reconciliation.reconciledAt
    ?? row.lastReconciledAt
    ?? row.last_reconciled_at;
  const source = reconciliation.source ?? reconciliation.lastSource ?? row.reconciliationSource ?? "--";
  const quantities = kind === "TO"
    ? [
      ["Transfer", ordered],
      ["Source fulfilled", fulfilled],
      ["Destination received", received],
      ["Abandoned / closed", abandoned],
      ["Remaining", remaining],
      ["Split allocated", allocated]
    ]
    : [
      ["Ordered", ordered],
      ["Received", received],
      ["Abandoned / closed", abandoned],
      ["Remaining", remaining],
      ["Split allocated", allocated]
    ];
  return `<div class="scm-reconcile-quantity-grid">
      ${quantities.map(([label, value]) => `<div><span>${scmScheduleEscape(label)}</span><strong>${scmScheduleEscape(formatScheduleNumber(value))}</strong></div>`).join("")}
    </div>
    <div class="scm-reconcile-meta">
      <span>Allocation <strong>${exact === true ? "Exact" : exact === false ? "Inferred" : scmScheduleEscape(method || "--")}</strong></span>
      <span>Source <strong>${scmScheduleEscape(String(source || "--").replaceAll("_", " "))}</strong></span>
      <span>Last reconciled <strong>${scmScheduleEscape(scmScheduleReconciliationDate(lastReconciledAt))}</strong></span>
    </div>`;
}

function scmScheduleReconciliationLinesHtml(row = {}) {
  const lines = scmScheduleReconciliationLines(row);
  if (!lines.length) return "";
  return `<div class="scm-reconcile-lines" role="table" aria-label="Reconciliation lines">
    <div class="scm-reconcile-line header" role="row">
      <span>Line / item</span><span>Ordered</span><span>Fulfilled</span><span>Received</span><span>Remaining</span><span>Match</span>
    </div>
    ${lines.map((line) => {
      const lineKey = scmScheduleFirstValue(line, ["lineKey", "netSuiteLineKey", "netsuiteLineKey", "lineId", "line_id"]) || "--";
      const item = scmScheduleFirstValue(line, ["item", "itemRef", "itemName", "sku"]) || "--";
      const exact = line.exact ?? line.exactMatch ?? line.allocationExact;
      const matchType = String(line.matchType ?? line.allocationQuality ?? line.allocation_quality ?? "").trim();
      const inferred = exact === false || ["inferred", "mixed"].includes(matchType.toLowerCase());
      return `<div class="scm-reconcile-line" role="row">
        <span><strong>${scmScheduleEscape(item)}</strong><small>${scmScheduleEscape(lineKey)}</small></span>
        <span>${scmScheduleEscape(formatScheduleNumber(scmScheduleFirstValue(line, ["ordered", "orderedQty", "ordered_qty", "quantity"]) || 0))}</span>
        <span>${scmScheduleEscape(formatScheduleNumber(scmScheduleFirstValue(line, ["fulfilled", "fulfilledQty", "fulfilled_qty"]) || 0))}</span>
        <span>${scmScheduleEscape(formatScheduleNumber(scmScheduleFirstValue(line, ["received", "receivedQty", "received_qty"]) || 0))}</span>
        <span>${scmScheduleEscape(formatScheduleNumber(scmScheduleFirstValue(line, ["remaining", "remainingQty", "remaining_qty"]) || 0))}</span>
        <span class="${inferred ? "inferred" : ""}">${exact === true ? "Exact" : exact === false ? "Inferred" : scmScheduleEscape(matchType || "--")}</span>
      </div>`;
    }).join("")}
  </div>`;
}

function scmScheduleAllocationEditorHtml(row = {}) {
  const targets = scmScheduleAllocationTargets(row);
  if (!targets.length || !scmScheduleCanResolveReconciliation()) return "";
  return `<div class="scm-reconcile-allocation-editor">
    <strong>Manual split allocation</strong>
    <div class="scm-reconcile-allocation-grid">
      ${targets.map((target, index) => {
        const splitRef = scmScheduleFirstValue(target, ["splitRef", "childRef", "targetOrderRef", "target_order_ref", "orderRef", "ref"]) || "--";
        const lineKey = scmScheduleFirstValue(target, ["lineKey", "targetLineRef", "target_line_ref", "netSuiteLineKey", "netsuiteLineKey", "lineId"]) || "";
        const item = scmScheduleFirstValue(target, ["item", "itemRef", "itemName", "sku"]) || "";
        const progressKind = String(
          scmScheduleFirstValue(target, ["progressKind", "progress_kind"]) || "received"
        ).toLowerCase();
        const quantity = scmScheduleFirstValue(target, ["quantity", "allocatedQty", "proposedQty", "currentQty"]) || 0;
        const maximum = scmScheduleFirstValue(target, ["maximum", "maxQuantity", "requestedQty"]);
        return `<label>
          <span>${scmScheduleEscape(splitRef)}${item ? ` · ${scmScheduleEscape(item)}` : ""} · ${scmScheduleEscape(progressKind)}</span>
          <input data-reconciliation-allocation
            data-allocation-index="${index}"
            data-split-ref="${scmScheduleEscape(splitRef)}"
            data-line-key="${scmScheduleEscape(lineKey)}"
            data-progress-kind="${scmScheduleEscape(progressKind)}"
            type="number" min="0" ${maximum !== null ? `max="${scmScheduleEscape(maximum)}"` : ""} step="any"
            value="${scmScheduleEscape(quantity)}" />
        </label>`;
      }).join("")}
    </div>
  </div>`;
}

function scmScheduleReconciliationActionsHtml(row = {}) {
  const rowId = scheduleRowId(row);
  const status = scmScheduleReconciliationStatus(row);
  const busy = scmScheduleReconciliationBusyRef === rowId;
  const canRetry = scmScheduleCanRetryReconciliation() && ["review", "unreconciled"].includes(status);
  const canResolve = scmScheduleCanResolveReconciliation() && status === "review";
  if (!canRetry && !canResolve) return "";
  const targets = scmScheduleAllocationTargets(row);
  const dismissible = scmScheduleReconciliationDismissible(row);
  const missingSourceReview = scmScheduleMissingSourceReview(row);
  return `<div class="scm-reconcile-actions">
    ${canRetry ? `<button data-action="retry-reconciliation" data-row="${scmScheduleEscape(rowId)}" type="button" ${busy ? "disabled" : ""}>${busy ? "Retrying…" : "Retry reconciliation"}</button>` : ""}
    ${canResolve && missingSourceReview ? `<div class="scm-reconcile-resolution scm-reconcile-missing-resolution">
      <div class="notice">
        <strong>NetSuite record unavailable</strong>
        <span>The integration could not find this PO twice. Verify again, then mark only the local copy Cancelled when NetSuite has cancelled or removed it.</span>
      </div>
      <label class="note"><span>Required audit note</span><textarea data-missing-po-note rows="2" placeholder="Explain how the NetSuite cancellation was confirmed"></textarea></label>
      <button class="danger" data-action="close-missing-po-locally"
        data-row="${scmScheduleEscape(rowId)}"
        data-review-case-id="${scmScheduleEscape(missingSourceReview.id || "")}"
        data-review-last-detected-at="${scmScheduleEscape(missingSourceReview.lastDetectedAt ?? missingSourceReview.last_detected_at ?? "")}"
        type="button" ${busy ? "disabled" : ""}>${busy ? "Verifying…" : "Verify again and close locally"}</button>
    </div>` : canResolve ? `<div class="scm-reconcile-resolution">
      <label><span>Admin resolution</span>
        <select data-reconciliation-resolution>
          <option value="accept_current">Accept current NetSuite outcome</option>
          ${targets.length ? `<option value="allocate">Pin split allocation shown above</option>` : ""}
          ${dismissible ? `<option value="dismiss_info">Dismiss informational warning</option>` : ""}
        </select>
      </label>
      <label class="note"><span>Required audit note</span><textarea data-reconciliation-note rows="2" placeholder="Explain this resolution"></textarea></label>
      <button class="primary" data-action="resolve-reconciliation" data-row="${scmScheduleEscape(rowId)}" type="button" ${busy ? "disabled" : ""}>${busy ? "Applying…" : "Apply resolution"}</button>
    </div>` : ""}
  </div>`;
}

function scmScheduleReconciliationDetailHtml(row = {}) {
  const rowId = scheduleRowId(row);
  if (!scmScheduleCanViewReconciliationDetails()
    || !scmScheduleShowReconciliationDetails
    || !scmScheduleExpandedReconciliationRows.has(rowId)
    || !["PO", "TO"].includes(String(row.orderKind || "").toUpperCase())) return "";
  const reason = scmScheduleReconciliationReason(row);
  return `<section class="scm-reconciliation-detail ${scmScheduleNeedsReconciliationReview(row) ? "review" : ""}" data-reconciliation-detail="${scmScheduleEscape(rowId)}">
    <div class="scm-reconcile-detail-head">
      <div><strong>${scmScheduleEscape(row.displayRef || row.orderRef || rowId)} reconciliation</strong>
        ${reason ? `<span>${scmScheduleEscape(reason)}</span>` : ""}
      </div>
      <button data-action="toggle-reconciliation-row" data-row="${scmScheduleEscape(rowId)}" type="button">Close</button>
    </div>
    ${scmScheduleReconciliationSummaryHtml(row)}
    ${scmScheduleReconciliationLinesHtml(row)}
    ${scmScheduleAllocationEditorHtml(row)}
    ${scmSchedulePoSplitLineAdjustmentHtml(row)}
    ${scmScheduleReconciliationActionsHtml(row)}
  </section>`;
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
  if (row.orderKind === "PO" && !scmScheduleSalesHost) {
    const source = row.sourceRef || row.orderRef || row.displayRef;
    const ref = row.dispatchRef || row.displayRef || row.orderRef;
    if (scmScheduleNeedsReconciliationReview(row)) {
      return `<strong title="PO Split is blocked until reconciliation review is resolved.">${scmScheduleEscape(source || "--")}</strong>
        ${ref && ref !== source ? `<small>${scmScheduleEscape(ref)}</small>` : ""}`;
    }
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

function scmScheduleDisplayType(row = {}, { scmWorkingView = canEditScmSchedule() } = {}) {
  return row.isSpecialOrder && !scmWorkingView ? "Sp.O" : row.orderKind;
}

function scmScheduleTableRowHtml(row, { pickupOptions = [], dropoffOptions = OWN_YARDS } = {}) {
    const rowId = scheduleRowId(row);
    const editable = canEditScmSchedule();
    const scmWorkingView = editable;
    const reconciliationReview = scmScheduleNeedsReconciliationReview(row);
    const displayStatus = scmScheduleEffectiveStatus(row);
    const rowEditable = editable && !reconciliationReview;
    const statusEditable = rowEditable && !SCM_SYSTEM_STATUSES.has(displayStatus);
    const selectable = rowEditable && row.orderKind === "PO" && !row.groupRef && !String(row.orderRef || "").toUpperCase().startsWith("PGOB-");
    const displayType = scmScheduleDisplayType(row, { scmWorkingView });
    const eta = [row.etaDate, row.etaTime].filter(Boolean).join(" ") || "--";
    const isGroupOrder = Boolean(row.groupRef) || String(row.orderRef || "").toUpperCase().startsWith("PGOB-");
    const blanketView = scmScheduleFilters.view === "blanket";
    const canManageBlankets = scmScheduleCanManageBlankets();
    const reconciliationExpanded = scmScheduleExpandedReconciliationRows.has(rowId);
    const reconciliationToggle = scmScheduleCanViewReconciliationDetails()
      && scmScheduleShowReconciliationDetails
      && ["PO", "TO"].includes(String(row.orderKind || "").toUpperCase())
      ? `<button class="scm-reconcile-detail-toggle" data-action="toggle-reconciliation-row" data-row="${scmScheduleEscape(rowId)}" type="button" aria-expanded="${reconciliationExpanded ? "true" : "false"}">${reconciliationExpanded ? "Hide details" : "Details"}</button>`
      : "";
    const canCompleteVrma = editable
      && scmScheduleCanCompleteVrma()
      && row.orderKind === "VRMA"
      && !["Completed", "Cancelled", "Hold"].includes(displayStatus);
    const rowFormatting = scmScheduleRowFormatting(displayStatus);
    const typeFormatting = scmScheduleCellFormatting("type", row.isSpecialOrder ? "Sp.O" : row.orderKind);
    const dropoffFormatting = scmScheduleCellFormatting("dropoffPoint", row.dropoffPoint);
    const statusFormatting = scmScheduleCellFormatting("status", displayStatus);
    return `
      <div class="scm-sheet-row status-${scmScheduleEscape(displayStatus.toLowerCase().replaceAll(" ", "-"))} ${isGroupOrder ? "group-order" : ""} ${reconciliationReview ? "reconcile-review" : ""}${rowFormatting.className}" data-schedule-row="${scmScheduleEscape(rowId)}" data-row-ref="${scmScheduleEscape(row.orderRef)}"${rowFormatting.style}>
        ${editable ? `<div class="scm-sheet-cell scm-select-cell">${selectable ? `<input data-action="select-row" data-row="${scmScheduleEscape(rowId)}" type="checkbox" ${scmScheduleSelectedRows.has(rowId) ? "checked" : ""} aria-label="Select ${scmScheduleEscape(row.orderRef)}" />` : ""}</div>` : ""}
        <div class="scm-sheet-cell readonly">${readOnlyCell(scheduleDateText(row))}</div>
        <div class="scm-sheet-cell readonly scm-type-cell${typeFormatting.className}"${typeFormatting.style}>
          <strong>${scmScheduleEscape(displayType)}</strong>
          ${scmWorkingView && row.orderKind === "PO" ? `<label class="scm-sheet-check"><input data-row="${scmScheduleEscape(rowId)}" data-field="isSpecialOrder" type="checkbox" ${row.isSpecialOrder ? "checked" : ""} ${rowEditable ? "" : "disabled"} /><span>Sp.O</span></label>` : ""}
          ${blanketView && row.orderKind === "PO" ? `<label class="scm-blanket-flag ${row.isBlanket ? "active" : ""}" title="${row.isBlanket ? "Flagged blanket parent: hidden from normal schedules and dispatch planning" : "Flag this large parent PO as a blanket order"}">
            <input data-action="toggle-blanket" data-ref="${scmScheduleEscape(row.orderRef)}" type="checkbox" ${row.isBlanket ? "checked" : ""}
              ${canManageBlankets && scmScheduleBlanketSavingRef !== rowId ? "" : "disabled"} />
            <span aria-hidden="true">⚑</span> Blanket
          </label>` : ""}
        </div>
        <div class="scm-sheet-cell">${rowEditable ? selectHtml({ rowId, field: "method", value: row.method, options: SCM_METHODS }) : readOnlyCell(row.method)}</div>
        <div class="scm-sheet-cell">${rowEditable ? selectHtml({ rowId, field: "pickupPoint", value: row.pickupPoint, options: pickupOptions }) : readOnlyCell(row.pickupPoint)}</div>
        <div class="scm-sheet-cell scm-dropoff-cell${dropoffFormatting.className}"${dropoffFormatting.style}>${rowEditable ? selectHtml({ rowId, field: "dropoffPoint", value: row.dropoffPoint, options: dropoffOptions }) : readOnlyCell(row.dropoffPoint)}</div>
        <div class="scm-sheet-cell readonly">${readOnlyCell(row.orderKind === "TO" ? "Transfer Order" : row.brand || row.party)}</div>
        <div class="scm-sheet-cell readonly content-cell">${contentCell(row)}</div>
        <div class="scm-sheet-cell readonly">
          ${orderNumberCell(row)}
        </div>
        <div class="scm-sheet-cell readonly number-cell">${readOnlyCell(Math.round(Number(row.weightLbs || 0)).toLocaleString())}</div>
        <div class="scm-sheet-cell ${rowEditable ? "" : "readonly"}">${rowEditable
          ? inputHtml({ rowId, field: "packingSlipRef", value: row.packingSlipRef, placeholder: "Packing slip" })
          : reconciliationReview ? readOnlyCell(row.packingSlipRef) : poSplitLink(row.packingSlipRef)}</div>
        <div class="scm-sheet-cell readonly">${readOnlyCell(eta)}</div>
        <div class="scm-sheet-cell readonly">${readOnlyCell(row.driver)}</div>
        <div class="scm-sheet-cell scm-reconcile-status-cell ${statusEditable ? "" : "readonly"}${statusFormatting.className}"${statusFormatting.style}>
          ${statusEditable ? selectHtml({ rowId, field: "status", value: displayStatus, options: SCM_MANUAL_STATUSES }) : readOnlyCell(displayStatus)}
          ${scmScheduleReconciliationBadge(row)}
        </div>
        <div class="scm-sheet-cell readonly">${readOnlyCell(row.sla)}</div>
        <div class="scm-sheet-cell action-cell">
          ${editable
            ? reconciliationReview
              ? `<span class="scm-review-blocked" title="Resolve reconciliation review before editing this order.">Review blocked</span>`
              : `<button data-action="save-row" data-row="${scmScheduleEscape(rowId)}" data-ref="${scmScheduleEscape(row.orderRef)}" data-kind="${scmScheduleEscape(row.orderKind)}" type="button" ${scmScheduleSavingRef === rowId ? "disabled" : ""}>${scmScheduleSavingRef === rowId ? "Saving" : "Save"}</button>`
            : `<span class="view-only-chip">View</span>`}
          ${canCompleteVrma
            ? `<button class="primary scm-complete-vrma" data-action="complete-vrma"
                data-row="${scmScheduleEscape(rowId)}" type="button"
                ${scmScheduleVrmaCompletingRef === rowId ? "disabled" : ""}>${scmScheduleVrmaCompletingRef === rowId ? "Completing…" : "Complete VRMA"}</button>`
            : ""}
          ${reconciliationToggle}
        </div>
      </div>
      ${scmScheduleReconciliationDetailHtml(row)}
    `;
}

function renderScheduleTableRows({ pickupOptions = [], dropoffOptions = OWN_YARDS } = {}) {
  if (scmScheduleLoading) {
    return `<div class="scm-sheet-empty">Loading schedule...</div>`;
  }
  const displayRows = scmScheduleDisplayRows();
  if (!displayRows.length) {
    return `<div class="scm-sheet-empty">${scmScheduleReviewOnly ? "No orders require reconciliation review in this view." : "No schedule rows match this view."}</div>`;
  }

  return displayRows.map((row) => scmScheduleTableRowHtml(row, {
    pickupOptions,
    dropoffOptions
  })).join("");
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
  const reconciliationReviewCount = scmScheduleReviewCount();
  scmScheduleApp.innerHTML = `
    <header class="dispatch-topbar">
      <div><p>${scmScheduleSalesHost ? "Sales" : scmScheduleDispatchHost ? "Dispatch" : "SCM"}</p><h1>PO / TO Schedule</h1></div>
      <div class="topbar-language">${window.MBBS_I18N?.toggleHtml() || ""}</div>
      <div class="topbar-actions">
        <span class="dispatch-user">${scmScheduleEscape(operator.display_name || operator.username || "")}</span>
        <button onclick="location.href='${scmScheduleSalesHost ? "/sales" : scmScheduleDispatchHost ? "/dispatch" : "/scm"}'" type="button">${scmScheduleSalesHost ? "Sales Menu" : scmScheduleDispatchHost ? "Dispatch Menu" : "SCM Menu"}</button>
        ${operator.publicSales ? "" : `<button onclick="dispatchLogout()" type="button">Logout</button>`}
      </div>
    </header>
    ${scmScheduleNotice ? `<div class="route-notice scm-notice"><span>${scmScheduleEscape(scmScheduleNotice)}</span><button class="scm-notice-close" data-action="close-notice" type="button" aria-label="Close">x</button></div>` : ""}
    <section class="scm-schedule-page ${scmScheduleFormattingLoaded ? "scm-schedule-formatting-ready" : ""}">
      <div class="scm-schedule-toolbar">
        ${visiblePresets.length > 1 ? `<select data-filter="view">
          ${visiblePresets.map((preset) => {
            const value = preset.name.toLowerCase();
            return `<option value="${scmScheduleEscape(value)}" ${scmScheduleFilters.view === value ? "selected" : ""}>${scmScheduleEscape(preset.name)}</option>`;
          }).join("")}
        </select>` : `<input data-filter="view" type="hidden" value="${scmScheduleEscape(scmScheduleFilters.view)}" />`}
        ${yardManagerView ? "" : `<input data-filter="search" type="search" value="${scmScheduleEscape(scmScheduleFilters.search)}" placeholder="Search all orders / vendors / content" autocomplete="off" />`}
        <button class="scm-review-filter ${scmScheduleReviewOnly ? "active" : ""}" data-action="toggle-review-filter" type="button" aria-pressed="${scmScheduleReviewOnly ? "true" : "false"}">
          Reconcile Review <span>${scmScheduleEscape(reconciliationReviewCount)}</span>
        </button>
        ${scmScheduleHasColumnFilters() ? `<button data-action="clear-column-filters" type="button">Clear column filters</button>` : ""}
        ${editable ? `<button class="primary" data-action="group-selected" type="button" ${selectedRows.length >= 2 ? "" : "hidden disabled"}>Group ${scmScheduleEscape(String(selectedRows.length))}</button>` : ""}
        ${scmScheduleCanViewReconciliationDetails() ? `<label class="scm-reconciliation-visibility">
          <input data-reconciliation-preference="showDetails" type="checkbox" ${scmScheduleShowReconciliationDetails ? "checked" : ""} />
          <span>Show reconciliation details</span>
        </label>` : ""}
        <div class="scm-sheet-settings" role="group" aria-label="Schedule display settings">
          <label>Font <input data-sheet-setting="fontSize" type="range" min="10" max="18" step="1" value="${scmScheduleSheetPreferences.fontSize}" /><output data-sheet-output="fontSize">${scmScheduleSheetPreferences.fontSize}px</output></label>
          <label>Row <input data-sheet-setting="rowHeight" type="range" min="38" max="120" step="2" value="${scmScheduleSheetPreferences.rowHeight}" /><output data-sheet-output="rowHeight">${scmScheduleSheetPreferences.rowHeight}px</output></label>
          <button data-action="reset-sheet-layout" type="button" title="Reset column widths, row height, and font size">Reset layout</button>
        </div>
      </div>
      <div class="scm-sheet-wrap">
        <div class="scm-sheet-grid ${editable ? "with-select" : ""}" style="${scmScheduleGridStyle(editable)}">
          ${sheetMetrics.columns.map((column) => scmScheduleHeaderHtml(column, {
            showScmWorkingControls,
            yardManagerView,
            dropoffOptions,
            brandOptions
          })).join("")}
          ${renderScheduleTableRows({ pickupOptions, dropoffOptions })}
        </div>
      </div>
    </section>
  `;
  updateScmScheduleGroupButton();
  restoreScmScheduleUiState(uiState);
}

function updateScmScheduleNotice(message = "") {
  scmScheduleNotice = String(message || "");
  const existing = scmScheduleApp.querySelector(".scm-notice");
  if (!scmScheduleNotice) {
    existing?.remove();
    return;
  }
  if (existing) {
    const text = existing.querySelector("span");
    if (text) text.textContent = scmScheduleNotice;
    return;
  }
  const page = scmScheduleApp.querySelector(".scm-schedule-page");
  if (!page) return;
  page.insertAdjacentHTML(
    "beforebegin",
    `<div class="route-notice scm-notice"><span>${scmScheduleEscape(scmScheduleNotice)}</span><button class="scm-notice-close" data-action="close-notice" type="button" aria-label="Close">x</button></div>`
  );
}

function replaceScmScheduleRow(oldRowId, refreshedRow) {
  const oldIndex = scmScheduleRows.findIndex((row) => scheduleRowId(row) === oldRowId);
  const oldElement = scmScheduleApp.querySelector(`.scm-sheet-row[data-schedule-row="${CSS.escape(oldRowId)}"]`);
  if (oldIndex < 0 || !oldElement || !refreshedRow || typeof refreshedRow !== "object") {
    return { replaced: false, removed: false, rowId: oldRowId };
  }

  const sheet = scmScheduleApp.querySelector(".scm-sheet-wrap");
  const scrollTop = sheet?.scrollTop || 0;
  const scrollLeft = sheet?.scrollLeft || 0;
  const oldDetail = scmScheduleApp.querySelector(`[data-reconciliation-detail="${CSS.escape(oldRowId)}"]`);
  const newRowId = scheduleRowId(refreshedRow);
  const matches = scmScheduleRowMatchesCurrentFilters(refreshedRow);

  if (!matches) {
    scmScheduleRows.splice(oldIndex, 1);
    migrateScmScheduleRowState(oldRowId);
    oldDetail?.remove();
    oldElement.remove();
    const grid = scmScheduleApp.querySelector(".scm-sheet-grid");
    if (grid && !grid.querySelector(".scm-sheet-row")) {
      grid.insertAdjacentHTML(
        "beforeend",
        `<div class="scm-sheet-empty">${scmScheduleReviewOnly ? "No orders require reconciliation review in this view." : "No schedule rows match this view."}</div>`
      );
    }
    updateScmScheduleGroupButton();
    if (sheet) {
      sheet.scrollTop = scrollTop;
      sheet.scrollLeft = scrollLeft;
    }
    return { replaced: true, removed: true, rowId: newRowId };
  }

  scmScheduleRows[oldIndex] = refreshedRow;
  migrateScmScheduleRowState(oldRowId, newRowId);
  oldElement.insertAdjacentHTML(
    "beforebegin",
    scmScheduleTableRowHtml(refreshedRow, {
      pickupOptions: scheduleOptionList("pickupPoint"),
      dropoffOptions: scheduleOptionList("dropoffPoint")
    })
  );
  oldDetail?.remove();
  oldElement.remove();
  scmScheduleApp.querySelector(".scm-sheet-empty")?.remove();
  updateScmScheduleGroupButton();
  if (sheet) {
    sheet.scrollTop = scrollTop;
    sheet.scrollLeft = scrollLeft;
  }
  const saveButton = scmScheduleApp.querySelector(
    `button[data-action="save-row"][data-row="${CSS.escape(newRowId)}"]`
  );
  saveButton?.focus({ preventScroll: true });
  return { replaced: true, removed: false, rowId: newRowId };
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

function collectScmScheduleReconciliationAllocations(rowId) {
  const detail = scmScheduleApp.querySelector(`[data-reconciliation-detail="${CSS.escape(rowId)}"]`);
  if (!detail) return [];
  return [...detail.querySelectorAll("[data-reconciliation-allocation]")].map((input) => ({
    splitRef: input.dataset.splitRef || "",
    lineKey: input.dataset.lineKey || "",
    progressKind: input.dataset.progressKind || "",
    quantity: Number(input.value)
  })).filter((allocation) =>
    allocation.splitRef
    && ["fulfilled", "received"].includes(allocation.progressKind)
    && Number.isFinite(allocation.quantity)
    && allocation.quantity > 0
  );
}

scmScheduleApp.addEventListener("input", (event) => {
  const search = event.target.closest('[data-filter="search"]');
  if (search) {
    queueScmScheduleSearch(search.value);
    return;
  }
  const deferredDateFilter = event.target.closest("[data-deferred-column-filter] [data-filter]");
  if (deferredDateFilter) {
    updateScmScheduleDateFilterSummary(deferredDateFilter.closest("[data-deferred-column-filter]"));
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

scmScheduleApp.addEventListener("change", async (event) => {
  const preference = event.target.closest("[data-reconciliation-preference]");
  if (preference) {
    try {
      await saveScmScheduleReconciliationPreference(preference.checked);
      await loadScmSchedule();
    } catch (error) {
      scmScheduleNotice = `Reconciliation preference was not saved: ${error.message}`;
      renderScmSchedule();
    }
    return;
  }
  const sourceLine = event.target.closest("[data-po-split-source-select]");
  if (sourceLine) {
    const card = sourceLine.closest("[data-po-split-line-adjustment]");
    const rowId = card?.dataset.row || "";
    const adjustment = scmSchedulePoSplitAdjustmentEntry(rowId, card?.dataset.ledgerLineId);
    const candidate = scmSchedulePoSplitAdjustmentCandidate(adjustment, sourceLine.value);
    const preview = card?.querySelector("[data-po-split-candidate-preview]");
    const error = card?.querySelector("[data-po-split-line-error]");
    if (preview) preview.innerHTML = scmSchedulePoSplitCandidatePreviewHtml(candidate);
    if (error) error.textContent = "";
    return;
  }
  const option = event.target.closest("[data-multi-filter-option]");
  if (option) {
    updateScmScheduleMultiFilter(option.closest("[data-multi-filter]"), { commit: false });
    return;
  }
  const deferredDateFilter = event.target.closest("[data-deferred-column-filter] [data-filter]");
  if (deferredDateFilter) {
    updateScmScheduleDateFilterSummary(deferredDateFilter.closest("[data-deferred-column-filter]"));
    return;
  }
  const filter = event.target.closest("[data-filter]");
  if (filter && filter.dataset.filter !== "search") {
    await applyScmScheduleFilters();
  }
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
    updateScmScheduleNotice("");
    return;
  }

  if (action === "toggle-review-filter") {
    scmScheduleReviewOnly = !scmScheduleReviewOnly;
    scmScheduleSelectedRows = new Set();
    await loadScmSchedule();
    return;
  }

  if (action === "toggle-reconciliation-row") {
    if (!scmScheduleCanViewReconciliationDetails() || !scmScheduleShowReconciliationDetails) return;
    const rowId = target.dataset.row || "";
    if (!rowId) return;
    const expanding = !scmScheduleExpandedReconciliationRows.has(rowId);
    if (expanding) scmScheduleExpandedReconciliationRows.add(rowId);
    else scmScheduleExpandedReconciliationRows.delete(rowId);
    renderScmSchedule();
    if (expanding) {
      const row = scmScheduleRows.find((item) => scheduleRowId(item) === rowId);
      await loadScmSchedulePoSplitLineOptions(rowId, row);
    }
    return;
  }

  if (action === "load-po-split-line-options") {
    const rowId = target.dataset.row || "";
    const row = scmScheduleRows.find((item) => scheduleRowId(item) === rowId);
    if (!row || !scmScheduleCanResolveReconciliation() || row.orderKind !== "PO") return;
    await loadScmSchedulePoSplitLineOptions(rowId, row, { force: true });
    return;
  }

  if (action === "apply-po-split-line-adjustment") {
    const rowId = target.dataset.row || "";
    const ledgerLineId = target.dataset.ledgerLineId || "";
    const row = scmScheduleRows.find((item) => scheduleRowId(item) === rowId);
    const card = target.closest("[data-po-split-line-adjustment]");
    const adjustment = scmSchedulePoSplitAdjustmentEntry(rowId, ledgerLineId);
    const sourceSelect = card?.querySelector("[data-po-split-source-select]");
    const candidate = scmSchedulePoSplitAdjustmentCandidate(adjustment, sourceSelect?.value);
    const note = String(card?.querySelector("[data-po-split-line-note]")?.value || "").trim();
    const error = card?.querySelector("[data-po-split-line-error]");
    const showError = (message) => {
      if (error) error.textContent = message;
    };
    if (!row || !card || !adjustment || !scmScheduleCanResolveReconciliation() || row.orderKind !== "PO") return;
    if (!candidate) {
      showError("Choose the compatible NetSuite source line first.");
      sourceSelect?.focus();
      return;
    }
    if (!note) {
      showError("An admin audit note is required for this source-line adjustment.");
      card.querySelector("[data-po-split-line-note]")?.focus();
      return;
    }
    const requiresReduction = scmSchedulePoSplitRequiresBaselineReduction(candidate);
    const baselineConfirmed = card.querySelector("[data-po-split-baseline-confirm]")?.checked === true;
    if (requiresReduction && !baselineConfirmed) {
      showError("Confirm the received-baseline reduction before applying this adjustment.");
      card.querySelector("[data-po-split-baseline-confirm]")?.focus();
      return;
    }

    const busyKey = `${rowId}::${ledgerLineId}`;
    if (scmSchedulePoSplitLineAdjustmentBusy.has(busyKey)) return;
    scmSchedulePoSplitLineAdjustmentBusy.add(busyKey);
    showError("");
    card.setAttribute("aria-busy", "true");
    card.querySelectorAll("button, select, textarea, input").forEach((control) => {
      control.disabled = true;
    });
    target.textContent = "Applying…";
    try {
      const payload = await scmScheduleApi(
        `/api/scm/reconciliation/po-split-lines/${encodeURIComponent(ledgerLineId)}/reassign`,
        {
          method: "POST",
          body: JSON.stringify({
            expectedSourceLineId: adjustment.currentSource?.localLineId,
            newSourceLineId: candidate.localLineId,
            note,
            allowBaselineReduction: requiresReduction && baselineConfirmed,
            expectedBaselineQty: candidate.baselineQty
          })
        }
      );
      scmSchedulePoSplitLineOptions.delete(rowId);
      scmSchedulePoSplitLineOptionsErrors.delete(rowId);
      scmScheduleExpandedReconciliationRows.delete(rowId);
      const targetRef = adjustment.targetOrderRef || row.orderRef;
      scmScheduleNotice = payload?.rerunError
        ? `Source line adjusted for ${targetRef}, but targeted reconciliation did not start. Use Retry reconciliation.`
        : `Source line adjusted for ${targetRef}; targeted reconciliation is running.`;
      await loadScmSchedule();
    } catch (requestError) {
      showError(`Source-line adjustment failed: ${requestError.message}`);
    } finally {
      scmSchedulePoSplitLineAdjustmentBusy.delete(busyKey);
      if (card.isConnected) {
        card.removeAttribute("aria-busy");
        card.querySelectorAll("button, select, textarea, input").forEach((control) => {
          control.disabled = false;
        });
        target.textContent = "Adjust source line";
      }
    }
    return;
  }

  if (action === "retry-reconciliation") {
    const rowId = target.dataset.row || "";
    const row = scmScheduleRows.find((item) => scheduleRowId(item) === rowId);
    if (!row || !scmScheduleCanRetryReconciliation()) return;
    scmScheduleReconciliationBusyRef = rowId;
    scmScheduleNotice = `Retrying reconciliation for ${row.orderRef}...`;
    renderScmSchedule();
    try {
      await scmScheduleApi("/api/scm/reconciliation/retry", {
        method: "POST",
        body: JSON.stringify({
          orderKind: row.orderKind,
          orderRef: row.orderRef,
          audit: { sessionId: sessionStorage.getItem("mbbs.dispatch.sessionId") || "" }
        })
      });
      scmScheduleNotice = `Reconciliation retry completed for ${row.orderRef}.`;
      await loadScmSchedule();
    } catch (error) {
      scmScheduleNotice = `Reconciliation retry failed: ${error.message}`;
    } finally {
      scmScheduleReconciliationBusyRef = "";
      renderScmSchedule();
    }
    return;
  }

  if (action === "close-missing-po-locally") {
    const rowId = target.dataset.row || "";
    const row = scmScheduleRows.find((item) => scheduleRowId(item) === rowId);
    const detail = target.closest("[data-reconciliation-detail]");
    const note = String(detail?.querySelector("[data-missing-po-note]")?.value || "").trim();
    if (!row || !scmScheduleCanResolveReconciliation() || row.orderKind !== "PO") return;
    if (!note) {
      scmScheduleNotice = "An admin audit note is required to close this missing PO locally.";
      renderScmSchedule();
      return;
    }
    if (!confirm(
      `Verify ${row.orderRef} in NetSuite again and, only if it is still unavailable, mark the local PO Cancelled? `
      + "This does not change NetSuite and preserves the local order history."
    )) return;
    scmScheduleReconciliationBusyRef = rowId;
    scmScheduleNotice = `Verifying ${row.orderRef} before local cancellation...`;
    renderScmSchedule();
    try {
      await scmScheduleApi("/api/scm/reconciliation/close-missing-po", {
        method: "POST",
        body: JSON.stringify({
          orderRef: row.orderRef,
          reviewCaseId: target.dataset.reviewCaseId || undefined,
          expectedLastDetectedAt: target.dataset.reviewLastDetectedAt || undefined,
          note,
          confirm: true
        })
      });
      scmScheduleExpandedReconciliationRows.delete(rowId);
      scmScheduleNotice = `${row.orderRef} was verified unavailable and marked Cancelled locally.`;
      await loadScmSchedule();
    } catch (error) {
      scmScheduleNotice = `Local PO cancellation failed: ${error.message}`;
    } finally {
      scmScheduleReconciliationBusyRef = "";
      renderScmSchedule();
    }
    return;
  }

  if (action === "resolve-reconciliation") {
    const rowId = target.dataset.row || "";
    const row = scmScheduleRows.find((item) => scheduleRowId(item) === rowId);
    if (!row || !scmScheduleCanResolveReconciliation() || !scmScheduleNeedsReconciliationReview(row)) return;
    const detail = target.closest("[data-reconciliation-detail]");
    const resolution = detail?.querySelector("[data-reconciliation-resolution]")?.value || "";
    const note = String(detail?.querySelector("[data-reconciliation-note]")?.value || "").trim();
    const allocations = resolution === "allocate" ? collectScmScheduleReconciliationAllocations(rowId) : [];
    if (!note) {
      scmScheduleNotice = "An admin audit note is required to resolve Reconcile Review.";
      renderScmSchedule();
      return;
    }
    if (resolution === "allocate" && !allocations.length) {
      scmScheduleNotice = "Enter at least one valid split allocation before applying this resolution.";
      renderScmSchedule();
      return;
    }
    scmScheduleReconciliationBusyRef = rowId;
    scmScheduleNotice = `Applying reconciliation resolution for ${row.orderRef}...`;
    renderScmSchedule();
    try {
      const payload = await scmScheduleApi("/api/scm/reconciliation/resolve", {
        method: "POST",
        body: JSON.stringify({
          orderKind: row.orderKind,
          orderRef: row.orderRef,
          resolution,
          note,
          ...(allocations.length ? { allocations } : {}),
          audit: { sessionId: sessionStorage.getItem("mbbs.dispatch.sessionId") || "" }
        })
      });
      if (payload?.pending === true) {
        const runId = payload?.run?.id || payload?.runId || "";
        scmScheduleNotice = `Allocation saved for ${row.orderRef}; targeted reconciliation is running...`;
        renderScmSchedule();
        const outcome = await waitForScmScheduleReconciliationRerun({ rowId, runId });
        if (outcome.cleared) {
          scmScheduleExpandedReconciliationRows.delete(rowId);
          scmScheduleNotice = `Resolved reconciliation review for ${row.orderRef}.`;
        } else if (outcome.timedOut) {
          scmScheduleNotice = `Reconciliation is still running for ${row.orderRef}. The schedule will remain blocked until it finishes.`;
        } else {
          scmScheduleNotice = `Reconciliation finished with ${outcome.status || "review"} for ${row.orderRef}; review the remaining conflict.`;
        }
      } else {
        scmScheduleExpandedReconciliationRows.delete(rowId);
        scmScheduleNotice = `Resolved reconciliation review for ${row.orderRef}.`;
        await loadScmSchedule();
      }
    } catch (error) {
      scmScheduleNotice = `Reconciliation resolution failed: ${error.message}`;
    } finally {
      scmScheduleReconciliationBusyRef = "";
      renderScmSchedule();
    }
    return;
  }

  if (action === "complete-vrma") {
    const rowId = target.dataset.row || "";
    const row = scmScheduleRows.find((item) => scheduleRowId(item) === rowId);
    if (!row || row.orderKind !== "VRMA" || !scmScheduleCanCompleteVrma()) return;
    const note = prompt(
      `Required completion note for ${row.orderRef}:`,
      "SCM confirmed this local VRMA delivery is complete."
    );
    if (note === null) return;
    if (!note.trim()) {
      scmScheduleNotice = "An audit note is required to complete a VRMA.";
      renderScmSchedule();
      return;
    }
    if (!confirm(
      `Mark local VRMA ${row.orderRef} Completed? `
      + "This removes it from the active dispatch pool, preserves its load/driver history, and does not update NetSuite."
    )) return;
    scmScheduleVrmaCompletingRef = rowId;
    scmScheduleNotice = `Completing ${row.orderRef}...`;
    renderScmSchedule();
    try {
      const result = await scmScheduleApi(
        `/api/scm/vrma-orders/${encodeURIComponent(row.orderRef)}/complete-override`,
        {
          method: "POST",
          body: JSON.stringify({
            note: note.trim(),
            expectedUpdatedAt: row.updatedAt,
            confirm: true,
            force: true
          })
        }
      );
      scmScheduleNotice = result?.result?.forced
        ? `${row.orderRef} was marked Completed with an operator-progress override.`
        : `${row.orderRef} was marked Completed.`;
      await loadScmSchedule();
    } catch (error) {
      scmScheduleNotice = `VRMA completion failed: ${error.message}`;
    } finally {
      scmScheduleVrmaCompletingRef = "";
      renderScmSchedule();
    }
    return;
  }

  if (action === "toggle-blanket") {
    const orderRef = target.dataset.ref || "";
    const row = scmScheduleRows.find((item) => item.orderKind === "PO" && item.orderRef === orderRef);
    if (!orderRef || !row || !scmScheduleCanManageBlankets()) return;
    const rowId = scheduleRowId(row);
    const isBlanket = target.checked === true;
    scmScheduleBlanketSavingRef = rowId;
    scmScheduleNotice = `${isBlanket ? "Flagging" : "Clearing"} ${orderRef}...`;
    renderScmSchedule();
    try {
      await scmScheduleApi(`/api/scm/purchase-orders/${encodeURIComponent(orderRef)}/blanket`, {
        method: "PUT",
        body: JSON.stringify({
          isBlanket,
          audit: { sessionId: sessionStorage.getItem("mbbs.dispatch.sessionId") || "" }
        })
      });
      scmScheduleNotice = isBlanket
        ? `${orderRef} is now a Blanket parent and is hidden from normal schedules and dispatch planning.`
        : `${orderRef} is no longer flagged as a Blanket parent.`;
      await loadScmSchedule();
    } catch (error) {
      scmScheduleNotice = `Blanket flag failed: ${error.message}`;
      await loadScmSchedule();
    } finally {
      scmScheduleBlanketSavingRef = "";
      renderScmSchedule();
    }
    return;
  }

  if (action === "clear-multi-filter") {
    const details = target.closest("[data-multi-filter]");
    details?.querySelectorAll("[data-multi-filter-option]").forEach((input) => { input.checked = false; });
    updateScmScheduleMultiFilter(details, { commit: false });
    return;
  }

  if (action === "apply-column-filters") {
    await applyScmScheduleFilters();
    return;
  }

  if (action === "clear-date-filter") {
    const details = target.closest("[data-deferred-column-filter]");
    details?.querySelectorAll('[data-filter="from"], [data-filter="to"]').forEach((input) => {
      input.value = "";
    });
    updateScmScheduleDateFilterSummary(details);
    await applyScmScheduleFilters();
    return;
  }

  if (action === "clear-column-filters") {
    scmScheduleFilters.kind = "";
    scmScheduleFilters.method = "";
    scmScheduleFilters.status = [];
    scmScheduleFilters.dropoffPoint = "";
    scmScheduleFilters.brand = [];
    scmScheduleFilters.from = "";
    scmScheduleFilters.to = "";
    try {
      await saveScmScheduleFilterPreference();
    } catch (error) {
      scmScheduleNotice = `Column filters were cleared, but the signed-in preference was not saved: ${error.message}`;
    }
    await loadScmSchedule();
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
    await applyScmScheduleFilters();
    return;
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
    const row = scmScheduleRows.find((item) => item.orderKind === "PO"
      && [item.orderRef, item.sourceRef, item.displayRef, item.dispatchRef].includes(orderRef));
    if (row && scmScheduleNeedsReconciliationReview(row)) {
      scmScheduleNotice = `${row.orderRef} is blocked until Reconcile Review is resolved.`;
      renderScmSchedule();
      return;
    }
    window.open(`/scm/POsplit?order=${encodeURIComponent(orderRef)}`, "_blank", "noopener");
  }

  if (action === "save-row") {
    const rowId = target.dataset.row || "";
    const orderRef = target.dataset.ref || "";
    if (!orderRef || scmScheduleSavingRef) return;
    const row = scmScheduleRows.find((item) => scheduleRowId(item) === rowId);
    if (row && scmScheduleNeedsReconciliationReview(row)) {
      updateScmScheduleNotice(`${orderRef} is blocked until Reconcile Review is resolved.`);
      return;
    }
    const patch = collectRowPatch(rowId);
    scmScheduleSavingRef = rowId;
    updateScmScheduleNotice("");
    target.disabled = true;
    target.textContent = "Saving";
    try {
      const payload = await scmScheduleApi(`/api/scm/schedule/${encodeURIComponent(orderRef)}?includeSchedule=false`, {
        method: "PUT",
        body: JSON.stringify({ ...patch, audit: { sessionId: sessionStorage.getItem("mbbs.dispatch.sessionId") || "" } })
      });
      scmScheduleSavingRef = "";
      const replacement = replaceScmScheduleRow(rowId, payload?.row);
      if (!replacement.replaced) {
        updateScmScheduleNotice(`Saved ${orderRef}; refreshing the schedule because the row response was unavailable.`);
        await loadScmSchedule();
      } else if (replacement.removed) {
        updateScmScheduleNotice(`Saved ${orderRef}. It no longer matches the current filters.`);
      } else {
        updateScmScheduleNotice(`Saved ${payload.row?.orderRef || orderRef}.`);
      }
    } catch (error) {
      updateScmScheduleNotice(`Save failed: ${error.message}`);
      if (target.isConnected) {
        target.disabled = false;
        target.textContent = "Save";
        target.focus({ preventScroll: true });
      }
    } finally {
      scmScheduleSavingRef = "";
      if (target.isConnected) {
        target.disabled = false;
        target.textContent = "Save";
      }
    }
  }
});

window.addEventListener("mbbs-language-changed", renderScmSchedule);

requireDispatchLogin({
  mount: scmScheduleApp,
  roles: scmScheduleSalesHost
    ? ["sales", "admin"]
    : ["admin", "scm", "scm_staff", "dispatcher", "yard_manager"],
  async onReady(operator) {
    scmScheduleOperator = operator;
    scmScheduleFilters.view = scmScheduleDefaultViewForRole();
    await loadScmScheduleFilterPreference();
    await loadScmScheduleReconciliationPreference();
    await loadScmSchedule();
  }
});

const app = document.getElementById("controlApp");
const TOKEN_KEY = "mbbs.control.token";
const t = (key, fallback) => window.MBBS_I18N?.t(key, fallback) || fallback;
const languageToggle = () => window.MBBS_I18N?.toggleHtml() || "";

let token = localStorage.getItem(TOKEN_KEY) || "";
let operator = null;
let operators = [];
let audit = [];
let classifications = [];
let cycleRecords = [];
let fulfillmentRecords = [];
let recordWarnings = [];
let orderLocks = [];
let loadedOrders = [];
let loadedSearchResults = [];
let loadedOrderDetail = null;
let selectedLoadedOrderKey = "";
let syncSettings = { mode: "manual", running: false, lastStatus: "idle" };
let envSettings = { activeEnvFile: ".env", selectedEnvFile: ".env", restartRequired: false, files: [] };
let vendorMappings = { localVendors: [], mappings: [] };
let vendorMappingTab = localStorage.getItem("mbbs.control.vendorMapping.tab") || "links";
const USE_NETSUITE_ADDRESS_VENDOR = "__USE_NETSUITE_ADDRESS__";
let classificationSearch = "";
let bootstrapNeeded = false;
let activeSection = localStorage.getItem("mbbs.control.section") || "dashboard";
let syncPollTimer = null;

function todayKey() {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

let loadedFilters = {
  from: localStorage.getItem("mbbs.control.loaded.from") || todayKey(),
  to: localStorage.getItem("mbbs.control.loaded.to") || todayKey(),
  yard: localStorage.getItem("mbbs.control.loaded.yard") || "all"
};
let loadedSearchTerm = localStorage.getItem("mbbs.control.loaded.search") || "";
let loadedSearchTimer = null;
let loadedSearchSeq = 0;
let loadedSearchLoading = false;
let auditFilters = {
  from: localStorage.getItem("mbbs.control.audit.from") || "",
  to: localStorage.getItem("mbbs.control.audit.to") || "",
  actor: localStorage.getItem("mbbs.control.audit.actor") || "",
  action: localStorage.getItem("mbbs.control.audit.action") || "",
  tranid: localStorage.getItem("mbbs.control.audit.tranid") || "",
  limit: localStorage.getItem("mbbs.control.audit.limit") || "200"
};
let auditOptions = { actors: [], actions: [] };
let syncMaxRunMinutesDraft = null;

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...options
  });
  if (response.status === 401) {
    token = "";
    operator = null;
    localStorage.removeItem(TOKEN_KEY);
    renderLogin("Please login again.");
    throw new Error("Login required");
  }
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function formatDate(value) {
  if (!value) return "";
  return window.MBBS_I18N?.displayDateTime(value) || "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function photoSrc(value) {
  const text = String(value || "");
  if (!text.startsWith("r2://")) return text;
  return `/api/photo-upload/preview?ref=${encodeURIComponent(text)}&token=${encodeURIComponent(token || "")}`;
}

function photoImgSrc(value) {
  return escapeHtml(photoSrc(value));
}

function saveAuditFilters() {
  for (const [key, value] of Object.entries(auditFilters)) {
    localStorage.setItem(`mbbs.control.audit.${key}`, value || "");
  }
}

function auditQueryString() {
  const url = new URL("/api/delivery/audit", window.location.origin);
  for (const [key, value] of Object.entries(auditFilters)) {
    const text = String(value || "").trim();
    if (text) url.searchParams.set(key, text);
  }
  if (!url.searchParams.has("limit")) url.searchParams.set("limit", "200");
  return url.pathname + url.search;
}

function auditOptionsQueryString() {
  const url = new URL("/api/delivery/audit/options", window.location.origin);
  for (const key of ["from", "to", "tranid"]) {
    const text = String(auditFilters[key] || "").trim();
    if (text) url.searchParams.set(key, text);
  }
  return url.pathname + url.search;
}

function renderAuditSelectOptions(values, selectedValue, allLabel) {
  const selected = String(selectedValue || "");
  const allValues = [...new Set([selected, ...(values || [])].filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
  return `
    <option value="">${escapeHtml(allLabel)}</option>
    ${allValues.map((value) => `<option value="${escapeHtml(value)}" ${String(value) === selected ? "selected" : ""}>${escapeHtml(value)}</option>`).join("")}
  `;
}

function openPhotoLightbox(photoRef, label = "Photo preview") {
  const ref = String(photoRef || "");
  if (!ref) return;
  const existing = document.querySelector(".photo-lightbox");
  if (existing) existing.remove();
  const modal = document.createElement("div");
  modal.className = "photo-lightbox";
  modal.innerHTML = `
    <div class="photo-lightbox-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(label)}">
      <button class="photo-lightbox-close" data-action="close-photo-lightbox" type="button">×</button>
      <img src="${photoImgSrc(ref)}" alt="${escapeHtml(label)}" />
    </div>
  `;
  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target.closest("[data-action='close-photo-lightbox']")) closePhotoLightbox();
  });
  document.body.appendChild(modal);
}

function closePhotoLightbox() {
  document.querySelector(".photo-lightbox")?.remove();
}

function envFileLabel(file) {
  if (file === ".env") return "Production (.env)";
  if (file === ".env.old") return "Sandbox (.env.old)";
  return file;
}

function clearSyncPoll() {
  clearTimeout(syncPollTimer);
  syncPollTimer = null;
}

function scheduleSyncPoll() {
  clearSyncPoll();
  if (!operator || !syncSettings.running) return;
  syncPollTimer = setTimeout(pollSyncStatus, 3000);
}

async function pollSyncStatus() {
  if (!operator) return;
  const wasRunning = Boolean(syncSettings.running);
  try {
    syncSettings = await request("/api/control/sync-settings");
    if (wasRunning && !syncSettings.running) {
      await loadControlData();
      alert(`NetSuite sync ${syncSettings.lastStatus || "finished"}.`);
      return;
    }
    if (["dashboard", "sync"].includes(activeSection)) render();
  } catch (error) {
    console.warn(error);
  } finally {
    scheduleSyncPoll();
  }
}

function renderLogin(message = "") {
  clearSyncPoll();
  app.innerHTML = `
    <section class="panel login">
      <h1>${t("control.operatorControl", "MBBS Operator Control")}</h1>
      ${bootstrapNeeded ? `<div class="notice">${t("control.noAccountBootstrap", "No account exists yet. Create the first admin account.")}</div>` : ""}
      ${message ? `<div class="notice">${message}</div>` : ""}
      <form class="form-grid" data-form="${bootstrapNeeded ? "bootstrap" : "login"}">
        <label>
            <span>${t("common.username", "Username")}</span>
          <input id="username" autocomplete="username" required />
        </label>
        ${bootstrapNeeded ? `
          <label>
            <span>${t("control.displayName", "Display name")}</span>
            <input id="displayName" required />
          </label>
        ` : ""}
        <label>
            <span>${t("common.password", "Password")}</span>
          <input id="password" type="password" autocomplete="${bootstrapNeeded ? "new-password" : "current-password"}" required />
        </label>
        <button class="primary" type="submit">${bootstrapNeeded ? t("control.createAdmin", "Create admin") : t("common.login", "Login")}</button>
      </form>
    </section>
  `;
}

function controlCssAttr(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function controlSelectorForElement(element) {
  if (!element || !app.contains(element)) return "";
  if (element.id) return `#${controlCssAttr(element.id)}`;
  const tag = element.tagName.toLowerCase();
  const attrs = ["data-audit-filter", "data-field", "name"].filter((name) => element.hasAttribute(name));
  if (!attrs.length) return "";
  return `${tag}${attrs.map((name) => `[${name}="${controlCssAttr(element.getAttribute(name))}"]`).join("")}`;
}

function captureControlFocus() {
  const element = document.activeElement;
  const selector = controlSelectorForElement(element);
  if (!selector) return null;
  return {
    selector,
    start: typeof element.selectionStart === "number" ? element.selectionStart : null,
    end: typeof element.selectionEnd === "number" ? element.selectionEnd : null
  };
}

function restoreControlFocus(state) {
  if (!state?.selector) return;
  const element = app.querySelector(state.selector);
  if (!element || typeof element.focus !== "function") return;
  element.focus({ preventScroll: true });
  if (state.start !== null && typeof element.setSelectionRange === "function") {
    element.setSelectionRange(state.start, state.end ?? state.start);
  }
}

function render() {
  if (!operator) return renderLogin();
  const focusState = captureControlFocus();
  app.innerHTML = `
    <section class="shell">
      <header class="topbar">
        <div>
          <p class="muted">${t("app.control", "MBBS Yard Server")}</p>
          <h1>${t("control.operatorControl", "Operator Control")}</h1>
        </div>
        <div class="topbar-language">${languageToggle()}</div>
        <div class="actions">
          <button onclick="location.href='/operator'">${t("control.openOperator", "Open Operator PWA")}</button>
          <button data-action="refresh">${t("common.refresh", "Refresh")}</button>
          <button data-action="logout">${t("common.logout", "Logout")} ${operator.display_name}</button>
        </div>
      </header>
      <div class="control-layout">
        <nav class="control-menu">
          ${renderMenuButton("dashboard", t("control.dashboard", "Dashboard"), t("control.quickStatus", "Quick status and shortcuts"))}
          ${renderMenuButton("operators", t("control.accountManagement", "Account Management"), t("control.accountManagementDesc", "Register and manage accounts"))}
          ${renderMenuButton("locks", t("control.orderLocks", "Order Locks"), t("control.orderLocksDesc", "Release stuck preparing orders"))}
          ${renderMenuButton("classification", t("control.itemClassification", "Item Classification"), t("control.itemClassificationDesc", "Maintain type, brand, series"))}
          ${renderMenuButton("vendor-mapping", t("control.vendorMapping", "Vendor Mapping"), t("control.vendorMappingDesc", "Map NetSuite vendors to local vendors"))}
          ${renderMenuButton("sync", t("control.syncSettings", "Sync Settings"), t("control.syncSettingsDesc", "Auto or manual NetSuite sync"))}
          ${renderMenuButton("warnings", t("control.operatorWarnings", "Operator Warnings"), t("control.operatorWarningsDesc", "Handle reported record problems"))}
          ${renderMenuButton("loaded-export", t("control.loadedExport", "Loaded Export"), t("control.loadedExportDesc", "View and export loaded SO / TO"))}
          ${renderMenuButton("cycle-count", t("control.cycleCountReview", "Cycle Count Review"), t("control.cycleCountReviewDesc", "Review submitted blind counts"))}
          ${renderMenuButton("fulfillment", t("control.operatorLoadRecords", "Operator Load Records"), t("control.operatorLoadRecordsDesc", "Review load/photo records"))}
          ${renderMenuButton("audit", t("control.auditLog", "Audit Log"), t("control.auditLogDesc", "Trace operator and sync actions"))}
        </nav>
        <section class="control-content">
          ${renderActiveSection()}
        </section>
      </div>
    </section>
  `;
  restoreControlFocus(focusState);
  scheduleSyncPoll();
}

function renderMenuButton(section, title, subtitle) {
  return `
    <button class="menu-button ${activeSection === section ? "active" : ""}" data-action="control-section" data-section="${section}" type="button">
      <strong>${title}</strong>
      <span>${subtitle}</span>
    </button>
  `;
}

function renderActiveSection() {
  if (activeSection === "operators") return renderOperatorsSection();
  if (activeSection === "locks") return renderLocksSection();
  if (activeSection === "classification") return renderClassificationSection();
  if (activeSection === "vendor-mapping") return renderVendorMappingSection();
  if (activeSection === "sync") return renderSyncSection();
  if (activeSection === "warnings") return renderWarningsSection();
  if (activeSection === "loaded-export") return renderLoadedExportSection();
  if (activeSection === "cycle-count") return renderCycleCountSection();
  if (activeSection === "fulfillment") return renderFulfillmentSection();
  if (activeSection === "audit") return renderAuditSection();
  return renderDashboardSection();
}

function renderDashboardSection() {
  const activeOperators = operators.filter((item) => item.active).length;
  const classified = classifications.filter((item) => item.product_type || item.brand || item.series).length;
  const openWarnings = recordWarnings.filter((item) => item.status === "open").length;
  return `
    <div class="dashboard-grid">
      <button class="metric-card" data-action="control-section" data-section="operators" type="button">
        <span>${t("control.accounts", "Accounts")}</span>
        <strong>${activeOperators} / ${operators.length}</strong>
        <em>${t("control.activeAccounts", "active accounts")}</em>
      </button>
      <button class="metric-card" data-action="control-section" data-section="classification" type="button">
        <span>${t("control.itemClassification", "Item Classification")}</span>
        <strong>${classified} / ${classifications.length}</strong>
        <em>${t("control.loadedRowsClassified", "loaded rows classified")}</em>
      </button>
      <button class="metric-card" data-action="control-section" data-section="audit" type="button">
        <span>${t("control.auditLog", "Audit Log")}</span>
        <strong>${audit.length}</strong>
        <em>${t("control.latestRecordsLoaded", "latest records loaded")}</em>
      </button>
      <button class="metric-card" data-action="control-section" data-section="sync" type="button">
        <span>${t("control.netsuiteSync", "NetSuite Sync")}</span>
        <strong>${syncSettings.mode === "auto" ? t("control.auto", "Auto") : t("control.manual", "Manual")}</strong>
        <em>${syncSettings.running ? t("control.syncRunning", "sync running") : syncSettings.lastStatus || "idle"}</em>
      </button>
      <button class="metric-card ${openWarnings ? "warning" : ""}" data-action="control-section" data-section="warnings" type="button">
        <span>${t("control.operatorWarnings", "Operator Warnings")}</span>
        <strong>${openWarnings}</strong>
        <em>${t("control.openReports", "open reports")}</em>
      </button>
      <button class="metric-card ${orderLocks.length ? "warning" : ""}" data-action="control-section" data-section="locks" type="button">
        <span>${t("control.orderLocks", "Order Locks")}</span>
        <strong>${orderLocks.length}</strong>
        <em>${t("control.activeLocks", "active preparing locks")}</em>
      </button>
      <button class="metric-card" data-action="control-section" data-section="cycle-count" type="button">
        <span>${t("operator.cycleCount", "Cycle Count")}</span>
        <strong>${cycleRecords.length}</strong>
        <em>${t("control.submittedRecords", "submitted records")}</em>
      </button>
      <button class="metric-card" data-action="control-section" data-section="fulfillment" type="button">
        <span>${t("control.operatorLoadRecords", "Fulfillment")}</span>
        <strong>${fulfillmentRecords.length}</strong>
        <em>${t("control.latestLoadRecords", "latest load records")}</em>
      </button>
      <button class="metric-card" data-action="control-section" data-section="loaded-export" type="button">
        <span>${t("control.loadedExport", "Loaded Export")}</span>
        <strong>${loadedOrders.length}</strong>
        <em>${t("control.filteredLoaded", "filtered loaded SO / TO")}</em>
      </button>
    </div>
    <section class="panel">
      <h2>${t("control.operatorControl", "Control Panel")}</h2>
      <p class="muted">${t("control.panelIntro", "Use the left menu to register operators, maintain item classification, or review audit history.")}</p>
      <div class="actions">
        <button class="primary" data-action="sync-inventory">${t("control.syncInventory", "Sync Inventory")}</button>
        <button data-action="refresh">${t("control.refreshAll", "Refresh All")}</button>
      </div>
    </section>
`;
}

function orderTypeLabel(value) {
  return value === "transfer_order" ? "TO" : "SO";
}

function renderLocksSection() {
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>${t("control.orderLocks", "Order Locks")}</h2>
          <p class="muted">${t("control.releaseLockHelp", "Release stuck preparing locks after app close, tablet crash, or server restart. Quantities and order status are not changed.")}</p>
        </div>
        <div class="actions">
          <button data-action="refresh-locks" type="button">${t("common.refresh", "Refresh")}</button>
          <button class="danger" data-action="release-all-locks" type="button" ${orderLocks.length ? "" : "disabled"}>${t("common.releaseAll", "Release All")}</button>
        </div>
      </div>
      ${orderLocks.length ? `
        <table>
          <thead>
            <tr>
              <th>${t("common.order", "Order")}</th>
              <th>${t("common.type", "Type")}</th>
              <th>${t("common.location", "Location")}</th>
              <th>${t("common.status", "Status")}</th>
              <th>${t("control.lockedBy", "Locked By")}</th>
              <th>${t("common.started", "Started")}</th>
              <th>${t("control.draftLines", "Draft Lines")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${orderLocks.map((lock) => `
              <tr>
                <td><strong>${escapeHtml(lock.tranid || lock.netsuite_id)}</strong><br><span class="muted">${escapeHtml(lock.netsuite_id)}</span></td>
                <td>${orderTypeLabel(lock.order_type)}</td>
                <td>${escapeHtml(lock.outbound_location || "")}</td>
                <td><strong>${escapeHtml(lock.operator_status || "")}</strong><br><span class="muted">${escapeHtml(lock.local_yard_order_status || "")}</span></td>
                <td><strong>${escapeHtml(lock.display_name || lock.username || "Unknown")}</strong><br><span class="muted">${escapeHtml(lock.username || lock.preparing_operator_id || "")}</span></td>
                <td>${formatDate(lock.preparing_started_at)}</td>
                <td>${lock.draft_line_count || 0}</td>
                <td>
                  <button class="danger" data-action="release-lock" data-order-type="${escapeHtml(lock.order_type)}" data-order-id="${escapeHtml(lock.netsuite_id)}" data-order-ref="${escapeHtml(lock.tranid || lock.netsuite_id)}" type="button">${t("common.release", "Release")}</button>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      ` : `
        <div class="notice">
          <strong>${t("control.noLocks", "No active order locks")}</strong>
          <span>${t("control.noLocksHelp", "No operator is currently holding a preparing lock.")}</span>
        </div>
      `}
    </section>
  `;
}

function renderLocalVendorOptions(selected = "") {
  const current = String(selected || "");
  const vendors = [...new Set([current, ...(vendorMappings.localVendors || [])].filter((vendor) => vendor && vendor !== USE_NETSUITE_ADDRESS_VENDOR))]
    .sort((a, b) => a.localeCompare(b));
  return `
    <option value="">${t("control.selectLocalVendor", "Select local vendor")}</option>
    <option value="${USE_NETSUITE_ADDRESS_VENDOR}" ${current === USE_NETSUITE_ADDRESS_VENDOR ? "selected" : ""}>${t("control.useNetsuiteAddress", "Use Netsuite Address")}</option>
    ${vendors.map((vendor) => `<option value="${escapeHtml(vendor)}" ${vendor === current ? "selected" : ""}>${escapeHtml(vendor)}</option>`).join("")}
  `;
}

function renderVendorMappingSection() {
  const rows = vendorMappings.mappings || [];
  const unmappedCount = rows.filter((row) => row.active && !row.localVendor).length;
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>${t("control.vendorMapping", "Vendor Mapping")}</h2>
          <p class="muted">${t("control.vendorMappingHelp", "Link NetSuite PO vendor names to local app vendors first, then PO memo aliases choose the specific yard.")}</p>
        </div>
        <div class="actions">
          <button class="primary" data-action="discover-vendor-mappings" type="button">${t("control.getNewPoVendors", "Get New Vendors From Latest POs")}</button>
          <button data-action="refresh-vendor-mappings" type="button">${t("common.refresh", "Refresh")}</button>
        </div>
      </div>
      <div class="subtab-row">
        <button class="${vendorMappingTab === "links" ? "active" : ""}" data-action="vendor-mapping-tab" data-tab="links" type="button">${t("control.vendorLinks", "Vendor Links")}</button>
        <button class="${vendorMappingTab === "local-vendors" ? "active" : ""}" data-action="vendor-mapping-tab" data-tab="local-vendors" type="button">${t("control.localVendors", "Local Vendors")}</button>
      </div>
      ${vendorMappingTab === "local-vendors" ? renderLocalVendorManagement() : `
        ${unmappedCount ? `<div class="notice">${unmappedCount} ${t("control.unmappedVendors", "NetSuite vendor(s) need a local vendor mapping.")}</div>` : ""}
        ${renderVendorMappingTable(rows)}
      `}
    </section>
  `;
}

function renderVendorMappingTable(rows) {
  return `
      <div class="spreadsheet-wrap">
        <table class="spreadsheet-table vendor-mapping-table">
          <thead>
            <tr>
              <th>${t("control.netsuiteVendor", "NetSuite Vendor")}</th>
              <th>${t("control.vendorId", "Vendor ID")}</th>
              <th>${t("control.lastPo", "Last PO")}</th>
              <th>${t("control.localVendor", "Local Vendor")}</th>
              <th>${t("common.status", "Status")}</th>
              <th>${t("common.updated", "Updated")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => `
              <tr data-vendor-mapping-row="${escapeHtml(row.id)}">
                <td><strong>${escapeHtml(row.netsuiteVendorName)}</strong></td>
                <td>${escapeHtml(row.netsuiteVendorId || "")}</td>
                <td><strong>${escapeHtml(row.lastPoRef || "")}</strong><br><span class="muted">${formatDate(row.lastSeenAt)}</span></td>
                <td>
                  <select data-field="localVendor">
                    ${renderLocalVendorOptions(row.localVendor)}
                  </select>
                </td>
                <td>
                  <label class="inline-check">
                    <input data-field="active" type="checkbox" ${row.active ? "checked" : ""} />
                    <span>${row.active ? t("common.active", "Active") : t("common.disabled", "Disabled")}</span>
                  </label>
                </td>
                <td>${formatDate(row.updatedAt)}<br><span class="muted">${escapeHtml(row.updatedBy || "")}</span></td>
                <td><button class="primary" data-action="save-vendor-mapping" data-id="${escapeHtml(row.id)}" type="button">${t("common.save", "Save")}</button></td>
              </tr>
            `).join("") || `<tr><td colspan="7" class="muted">${t("control.noVendorMappings", "No PO vendors discovered yet. Sync POs, then click Get New Vendors From Latest POs.")}</td></tr>`}
          </tbody>
        </table>
      </div>
  `;
}

function renderLocalVendorManagement() {
  const rows = vendorMappings.localVendorRows || [];
  return `
    <div class="local-vendor-create">
      <label>
        <span>${t("control.newLocalVendor", "New Local Vendor")}</span>
        <input id="newLocalVendorName" placeholder="${t("control.localVendorName", "Local vendor name")}" />
      </label>
      <button class="primary" data-action="create-local-vendor" type="button">${t("common.add", "Add")}</button>
    </div>
    <div class="spreadsheet-wrap">
      <table class="spreadsheet-table local-vendor-table">
        <thead>
          <tr>
            <th>${t("control.localVendor", "Local Vendor")}</th>
            <th>${t("control.vendorYards", "Vendor Yards")}</th>
            <th>${t("control.vendorLinks", "Vendor Links")}</th>
            <th>${t("common.status", "Status")}</th>
            <th>${t("common.updated", "Updated")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr data-local-vendor-row="${escapeHtml(row.id)}">
              <td><input data-field="name" value="${escapeHtml(row.name)}" /></td>
              <td>${row.yardCount || 0}</td>
              <td>${row.mappingCount || 0}</td>
              <td>
                <label class="inline-check">
                  <input data-field="active" type="checkbox" ${row.active ? "checked" : ""} />
                  <span>${row.active ? t("common.active", "Active") : t("common.disabled", "Disabled")}</span>
                </label>
              </td>
              <td>${formatDate(row.updatedAt)}<br><span class="muted">${escapeHtml(row.updatedBy || "")}</span></td>
              <td><button class="primary" data-action="save-local-vendor" data-id="${escapeHtml(row.id)}" data-current-name="${escapeHtml(row.name)}" type="button">${t("common.save", "Save")}</button></td>
            </tr>
          `).join("") || `<tr><td colspan="6" class="muted">${t("control.noLocalVendors", "No local vendors yet.")}</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function loadedOrderKey(order) {
  return `${order.order_type}:${order.order_id}`;
}

function loadedOrdersQuery() {
  const params = new URLSearchParams();
  params.set("from", loadedFilters.from || todayKey());
  params.set("to", loadedFilters.to || loadedFilters.from || todayKey());
  params.set("yard", loadedFilters.yard || "all");
  return params;
}

function loadedSearchQuery() {
  const params = new URLSearchParams();
  params.set("from", "2000-01-01");
  params.set("to", "2099-12-31");
  params.set("yard", "all");
  params.set("search", loadedSearchTerm.trim());
  return params;
}

function saveLoadedFilters() {
  localStorage.setItem("mbbs.control.loaded.from", loadedFilters.from || "");
  localStorage.setItem("mbbs.control.loaded.to", loadedFilters.to || "");
  localStorage.setItem("mbbs.control.loaded.yard", loadedFilters.yard || "all");
}

function saveLoadedSearch() {
  localStorage.setItem("mbbs.control.loaded.search", loadedSearchTerm || "");
}

function isLoadedSearchActive() {
  return loadedSearchTerm.trim().length > 0;
}

function visibleLoadedOrders() {
  return isLoadedSearchActive() ? loadedSearchResults : loadedOrders;
}

function findSelectedLoadedOrder() {
  return visibleLoadedOrders().find((order) => loadedOrderKey(order) === selectedLoadedOrderKey)
    || loadedOrders.find((order) => loadedOrderKey(order) === selectedLoadedOrderKey);
}

async function loadLoadedOrderDetailForSelection() {
  loadedOrderDetail = null;
  if (!selectedLoadedOrderKey) return;
  const selected = findSelectedLoadedOrder();
  if (!selected) return;
  const detailParams = new URLSearchParams(isLoadedSearchActive() ? loadedSearchQuery() : loadedOrdersQuery());
  detailParams.set("orderType", selected.order_type);
  detailParams.set("orderId", selected.order_id);
  loadedOrderDetail = await request(`/api/control/loaded-orders/detail?${detailParams.toString()}`);
}

async function loadLoadedOrders(options = {}) {
  const params = loadedOrdersQuery();
  loadedOrders = await request(`/api/control/loaded-orders?${params.toString()}`);
  if (!options.keepSelection || !loadedOrders.some((order) => loadedOrderKey(order) === selectedLoadedOrderKey)) {
    selectedLoadedOrderKey = loadedOrders[0] ? loadedOrderKey(loadedOrders[0]) : "";
  }
  await loadLoadedOrderDetailForSelection();
}

async function loadLoadedSearchResults() {
  const term = loadedSearchTerm.trim();
  const seq = ++loadedSearchSeq;
  if (!term) {
    loadedSearchResults = [];
    loadedSearchLoading = false;
    if (!loadedOrders.some((order) => loadedOrderKey(order) === selectedLoadedOrderKey)) {
      selectedLoadedOrderKey = loadedOrders[0] ? loadedOrderKey(loadedOrders[0]) : "";
    }
    await loadLoadedOrderDetailForSelection();
    return;
  }
  loadedSearchLoading = true;
  const results = await request(`/api/control/loaded-orders?${loadedSearchQuery().toString()}`);
  if (seq !== loadedSearchSeq) return;
  loadedSearchResults = results;
  loadedSearchLoading = false;
  if (!loadedSearchResults.some((order) => loadedOrderKey(order) === selectedLoadedOrderKey)) {
    selectedLoadedOrderKey = loadedSearchResults[0] ? loadedOrderKey(loadedSearchResults[0]) : "";
  }
  await loadLoadedOrderDetailForSelection();
}

function refreshLoadedPanels() {
  const list = document.getElementById("loadedOrderList");
  if (list) list.innerHTML = renderLoadedOrderList();
  const detail = document.getElementById("loadedDetailPanel");
  if (detail) detail.innerHTML = renderLoadedOrderDetail();
}

async function downloadLoadedCsv() {
  const response = await fetch(`/api/control/loaded-orders/export.csv?${loadedOrdersQuery().toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  if (!response.ok) throw new Error(await response.text());
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `loaded-orders-${loadedFilters.from || "from"}-${loadedFilters.to || "to"}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function renderLoadedOrderList() {
  const orders = visibleLoadedOrders();
  const searchActive = isLoadedSearchActive();
  return `
    <div class="loaded-list-head">
      <strong>${orders.length}</strong>
      <span>${searchActive ? `${t("control.searchResults", "search results across all dates/yards")}` : `${t("control.loadedShown", "shown / loaded")} ${loadedOrders.length}`}</span>
    </div>
    ${loadedSearchLoading ? `<div class="notice"><strong>${t("control.searching", "Searching...")}</strong><span>${t("control.searchingHelp", "Checking loaded SO / TO records across all yards and dates.")}</span></div>` : ""}
    ${orders.map((order) => `
      <button class="loaded-order-card ${loadedOrderKey(order) === selectedLoadedOrderKey ? "active" : ""}" data-action="select-loaded-order" data-key="${escapeHtml(loadedOrderKey(order))}" type="button">
        <strong>${escapeHtml(order.tranid || order.order_id)}</strong>
        <span>${order.order_type === "transfer_order" ? "TO" : "SO"} | ${escapeHtml(order.outbound_location || "")} | ${escapeHtml(order.local_yard_order_status || order.operator_status || "")}</span>
        <em>${formatDate(order.last_loaded_at)} | ${order.load_count || 0} ${t("common.load", "load")} | ${order.photo_count || 0} ${t("common.photos", "photo")}</em>
        ${order.customer ? `<small>${escapeHtml(order.customer)}</small>` : ""}
      </button>
    `).join("") || (!loadedSearchLoading ? `<div class="notice"><strong>${t("control.noLoadedOrders", "No loaded orders")}</strong><span>${searchActive ? t("control.noLoadedSearch", "No loaded SO / TO record matched this search across all dates and yards.") : t("control.noLoadedFilter", "Adjust the date or yard filter, then press Apply.")}</span></div>` : "")}
  `;
}

function renderLoadedExportSection() {
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>${t("control.loadedExportTitle", "Loaded SO / TO Export")}</h2>
          <p class="muted">${t("control.loadedExportHelp", "View loaded and partially loaded Sales Orders / Transfer Orders by yard and load date.")}</p>
        </div>
        <button data-action="refresh-loaded-orders" type="button">${t("common.refresh", "Refresh")}</button>
      </div>
      <div class="loaded-layout">
        <aside class="loaded-left-panel">
          <label class="loaded-search-panel">
            <span>${t("control.orderSearch", "Order Search")}</span>
            <input id="loadedSearch" placeholder="${t("control.orderSearchPlaceholder", "SO / TO / customer")}" value="${escapeHtml(loadedSearchTerm)}" />
          </label>
          <div class="loaded-order-list" id="loadedOrderList">
            ${renderLoadedOrderList()}
          </div>
        </aside>
        <section class="loaded-right-panel">
          <div class="loaded-filter-card">
            <div class="loaded-filter-title">
              <strong>${t("control.exportFilter", "Export Filter")}</strong>
              <span>${t("control.exportFilterHelp", "CSV uses these applied filters only.")}</span>
            </div>
            <div class="loaded-filter-row">
              <label><span>${t("common.from", "From")}</span><input id="loadedFrom" type="date" value="${escapeHtml(loadedFilters.from)}" /></label>
              <label><span>${t("common.to", "To")}</span><input id="loadedTo" type="date" value="${escapeHtml(loadedFilters.to)}" /></label>
              <label>
                <span>${t("common.yard", "Yard")}</span>
                <select id="loadedYard">
                  <option value="all" ${loadedFilters.yard === "all" ? "selected" : ""}>${t("common.all", "All")}</option>
                  <option value="1" ${loadedFilters.yard === "1" ? "selected" : ""}>3445</option>
                  <option value="28" ${loadedFilters.yard === "28" ? "selected" : ""}>2967</option>
                  <option value="15" ${loadedFilters.yard === "15" ? "selected" : ""}>12441</option>
                  <option value="26" ${loadedFilters.yard === "26" ? "selected" : ""}>150</option>
                </select>
              </label>
              <div class="loaded-filter-actions">
                <button class="primary" data-action="apply-loaded-filters" type="button">${t("common.apply", "Apply")}</button>
                <button data-action="export-loaded-csv" type="button" ${loadedOrders.length ? "" : "disabled"}>${t("common.exportCsv", "Export CSV")}</button>
              </div>
            </div>
          </div>
          <section class="loaded-detail-panel" id="loadedDetailPanel">
            ${renderLoadedOrderDetail()}
          </section>
        </section>
      </div>
    </section>
  `;
}

function renderLoadedOrderDetail() {
  if (!loadedOrderDetail) {
    return `<div class="empty-detail"><strong>${t("common.selectOrder", "Select an order")}</strong><span>${t("control.selectLoadedHelp", "Loaded lines and photo proof will show here.")}</span></div>`;
  }
  const { order, lines = [], photos = [] } = loadedOrderDetail;
  return `
    <div class="loaded-detail-head">
      <div>
        <h3>${escapeHtml(order.tranid || order.order_id)}</h3>
        <p class="muted">${order.order_type === "transfer_order" ? "Transfer Order" : "Sales Order"} | ${escapeHtml(order.outbound_location || "")} | ${escapeHtml(order.local_yard_order_status || order.operator_status || "")}</p>
        ${order.customer ? `<p class="muted">${escapeHtml(order.customer)}</p>` : ""}
      </div>
      <strong>${lines.length} ${t("control.lines", "line(s)")}</strong>
    </div>
    <div class="loaded-lines">
      ${lines.map((line) => `
        <div class="loaded-line-card">
          <div>
            <strong>${escapeHtml(line.sku || line.item_name || "")}</strong>
            <span>${escapeHtml(line.item_name || "")}</span>
            ${line.item_description ? `<em>${escapeHtml(line.item_description)}</em>` : ""}
          </div>
          <div class="loaded-line-qty">
            <b>${valueText(line.loaded_qty)}</b>
            <span>${escapeHtml(line.loaded_uom || "")}</span>
            <small>${escapeHtml(line.location || order.outbound_location || "")}</small>
          </div>
        </div>
      `).join("") || `<div class="notice"><strong>${t("control.noLoadedLines", "No loaded lines")}</strong><span>${t("control.noLoadedLinesHelp", "This order has load records but no current loaded line quantity.")}</span></div>`}
    </div>
    <div class="loaded-photo-section">
      <h3>${t("common.photos", "Photos")}</h3>
      <div class="loaded-photo-grid">
        ${photos.filter((photo) => photo.photo_data_url).map((photo) => `
          <figure>
            <button class="photo-thumb-button" data-action="open-photo-lightbox" data-photo-ref="${escapeHtml(photo.photo_data_url)}" data-photo-label="Load photo ${escapeHtml(photo.id)}" type="button">
              <img src="${photoImgSrc(photo.photo_data_url)}" alt="Load photo ${escapeHtml(photo.id)}" />
            </button>
            <figcaption>${formatDate(photo.created_at)}</figcaption>
          </figure>
        `).join("") || `<div class="notice"><strong>${t("common.noPhoto", "No photo")}</strong><span>${t("control.noPhotoHelp", "No photo proof is attached in this filtered date range.")}</span></div>`}
      </div>
    </div>
  `;
}

function renderSyncSection() {
  const isAuto = syncSettings.mode === "auto";
  const savedMaxRunMinutes = Math.max(1, Math.round(Number(syncSettings.maxRunSeconds || 900) / 60));
  const maxRunMinutes = syncMaxRunMinutesDraft ?? savedMaxRunMinutes;
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>${t("control.syncSettings", "NetSuite Sync Settings")}</h2>
          <p class="muted">${t("control.syncHelp", "Control whether the server syncs SO, TO, and PO data automatically or only when requested.")}</p>
        </div>
        <button data-action="refresh">${t("common.refresh", "Refresh")}</button>
      </div>
      <div class="sync-mode-grid">
        <button class="sync-mode-card ${isAuto ? "active" : ""}" data-action="set-sync-mode" data-mode="auto" type="button">
          <strong>${t("control.autoSync", "Auto Sync")}</strong>
          <span>${t("control.autoSyncHelp", "Server syncs NetSuite order feed every minute.")}</span>
        </button>
        <button class="sync-mode-card ${!isAuto ? "active" : ""}" data-action="set-sync-mode" data-mode="manual" type="button">
          <strong>${t("control.manualSync", "Manual Sync")}</strong>
          <span>${t("control.manualSyncHelp", "Server syncs only when an admin or dispatcher starts it.")}</span>
        </button>
      </div>
      <div class="sync-status-grid">
        <div>
          <span>SO</span>
          <strong>${t("control.openRemainingSync", "Pending / partial with remaining qty")}</strong>
        </div>
        <div>
          <span>PO / TO</span>
          <strong>${t("control.openRemainingSync", "Pending / partial with remaining qty")}</strong>
        </div>
      </div>
      <div class="sync-status-grid">
        <div><span>${t("control.mode", "Mode")}</span><strong>${isAuto ? t("control.auto", "Auto") : t("control.manual", "Manual")}</strong></div>
        <div><span>${t("control.running", "Running")}</span><strong>${syncSettings.running ? t("control.yes", "Yes") : t("control.no", "No")}</strong></div>
        <div><span>${t("control.maxRuntime", "Max Runtime")}</span><strong>${Math.round(Number(syncSettings.maxRunSeconds || 900) / 60)} min</strong></div>
        <div><span>${t("control.lastStatus", "Last Status")}</span><strong>${escapeHtml(syncSettings.lastStatus || "idle")}</strong></div>
        <div><span>${t("control.lastSource", "Last Source")}</span><strong>${escapeHtml(syncSettings.lastSource || "")}</strong></div>
        <div><span>${t("control.lastStarted", "Last Started")}</span><strong>${formatDate(syncSettings.lastStartedAt)}</strong></div>
        <div><span>${t("control.lastFinished", "Last Finished")}</span><strong>${formatDate(syncSettings.lastFinishedAt)}</strong></div>
      </div>
      <div class="sync-status-grid sync-setting-grid">
        <label>
          <span>${t("control.maxRuntimeMinutes", "Max Runtime Minutes")}</span>
          <input data-field="sync-max-run-minutes" type="number" min="1" step="1" value="${maxRunMinutes}" ${syncSettings.running ? "disabled" : ""}>
        </label>
        <div>
          <span>${t("control.maxRuntimeHelp", "Timeout Rule")}</span>
          <strong>${t("control.maxRuntimeHelpText", "Sync stops at the next safe checkpoint after this limit.")}</strong>
        </div>
      </div>
      ${syncSettings.lastError ? `<div class="notice sync-error">${escapeHtml(syncSettings.lastError)}</div>` : ""}
      <div class="notice">
        <strong>${t("control.environment", "NetSuite Environment")}</strong>
        <span>${t("control.activeNow", "Active now")}: <code>${escapeHtml(envFileLabel(envSettings.activeEnvFile))}</code>. ${t("control.selected", "Selected")}: <code>${escapeHtml(envFileLabel(envSettings.selectedEnvFile))}</code>.</span>
        ${envSettings.applyError ? `<span class="sync-error">${escapeHtml(envSettings.applyError)}</span>` : ""}
        ${envSettings.restartRequired ? `<span class="sync-error">${t("control.restartRequired", "Restart is required only because the selected env could not be safely applied live.")}</span>` : ""}
        <div class="sync-mode-grid">
          ${(envSettings.files || []).map((file) => `
            <button class="sync-mode-card ${file.file === envSettings.selectedEnvFile ? "active" : ""}" data-action="select-env-file" data-env-file="${escapeHtml(file.file)}" type="button" ${syncSettings.running ? "disabled" : ""}>
              <strong>${escapeHtml(envFileLabel(file.file))}</strong>
              <span>${file.active ? t("control.activeNow", "Active now") : file.selected ? t("control.selected", "Selected") : t("control.switchNow", "Switch now")}${file.lastModifiedAt ? ` | ${t("control.updated", "Updated")} ${formatDate(file.lastModifiedAt)}` : ""}</span>
            </button>
          `).join("") || `<div class="muted">${t("control.noEnvFiles", "No env files found.")}</div>`}
        </div>
      </div>
      <div class="actions">
        <button class="primary" data-action="connect-netsuite" type="button">${t("control.connectNetsuite", "Connect NetSuite")}</button>
        <button data-action="save-sync-settings" type="button">${t("control.saveSyncSettings", "Save Sync Settings")}</button>
        <button class="primary" data-action="run-sync-now" type="button" ${syncSettings.running ? "disabled" : ""}>${t("control.runSyncNow", "Run Sync Now")}</button>
        <button data-action="run-transfer-order-sync" type="button" ${syncSettings.running ? "disabled" : ""}>${t("control.runTransferOrderSync", "Sync TO/PO Only")}</button>
        <button data-action="reconcile-netsuite-progress" type="button" ${syncSettings.running ? "disabled" : ""}>${t("control.reconcileProgress", "Reconcile NetSuite Progress")}</button>
        <button class="danger" data-action="stop-sync" type="button">${t("control.stopSync", "Stop / Clear Sync")}</button>
        <button data-action="refresh" type="button">${t("control.refreshStatus", "Refresh Status")}</button>
      </div>
      <div class="notice">
        <strong>${t("control.environmentNote", "Environment note")}</strong>
        <span>${t("control.environmentNoteText", "The selector hot-loads NetSuite/Samsara/API settings when the database URL is unchanged. If the env file points to a different database, save it and restart. server/.env.old is ignored by git.")}</span>
      </div>
      <div class="notice sync-error">
        <strong>${t("control.developmentClear", "Development clear")}</strong>
        <span>${t("control.developmentClearText", "Clears SO/TO/PO/CO order records, dispatch plans, operator order requests, driver job records, fulfillment/receipt records, and order warnings. Accounts, sync settings, vendor yards, parser rules, item master, item classifications, and inventory balances are kept.")}</span>
        <div class="actions">
          <button class="danger" data-action="clear-order-data" type="button" ${syncSettings.running ? "disabled" : ""}>${t("control.clearOrderData", "Clear All Order Data")}</button>
        </div>
      </div>
    </section>
  `;
}

function warningTypeLabel(type) {
  return {
    confirm_line: "Confirm Line",
    item_receipt: "IR",
    item_fulfillment: "IF",
    cycle_count: "Cycle",
    customer_return: "Customer Return"
  }[type] || type || "Record";
}

function renderWarningPhotos(warning) {
  const photos = warning.details?.photos || [];
  if (!photos.length) return "";
  return `
    <div class="warning-photo-grid">
      ${photos.filter(Boolean).map((photo, index) => `<img src="${photoImgSrc(photo)}" alt="Warning photo ${index + 1}" />`).join("")}
    </div>
  `;
}

function renderWarningsSection() {
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>${t("control.operatorWarnings", "Operator Warnings")}</h2>
          <p class="muted">${t("control.operatorWarningsHelp", "Records reported by operators for supervisor review.")}</p>
        </div>
        <button data-action="refresh">${t("common.refresh", "Refresh")}</button>
      </div>
      <div class="warning-review-list">
        ${recordWarnings.map((warning) => `
          <details class="review-record warning-record ${warning.status}">
            <summary>
              <strong>${warning.status === "open" ? t("control.open", "Open") : t("control.resolved", "Resolved")}</strong>
              <span>${escapeHtml(warningTypeLabel(warning.record_type))}</span>
              <span>${escapeHtml(warning.reference || warning.record_id)}</span>
              <span>${escapeHtml(warning.operator_name || warning.operator_username || "")}</span>
              <span>${formatDate(warning.created_at)}</span>
            </summary>
            <div class="warning-body">
              <div class="notice warning-note"><strong>${t("control.reportedIssue", "Reported issue")}</strong><span>${escapeHtml(warning.reason)}</span></div>
              ${renderWarningPhotos(warning)}
              <pre>${escapeHtml(JSON.stringify(warning.details || {}, null, 2))}</pre>
              ${warning.status === "open" ? `
                <button class="primary" data-action="resolve-warning" data-id="${warning.id}" type="button">${t("control.markHandled", "Mark Handled")}</button>
              ` : `
                <div class="notice"><strong>${t("control.handledBy", "Handled by")} ${escapeHtml(warning.handled_by_name || "")}</strong><span>${escapeHtml(warning.resolution || "")}</span></div>
              `}
            </div>
          </details>
        `).join("") || `<p class="muted">${t("control.noWarnings", "No operator warnings.")}</p>`}
      </div>
    </section>
  `;
}

function renderOperatorsSection() {
  return `
    <div class="grid">
      <section class="panel">
        <h2>${t("control.registerAccount", "Register Account")}</h2>
        <form class="form-grid" data-form="create-operator">
          <label><span>${t("common.username", "Username")}</span><input id="newUsername" required /></label>
          <label><span>${t("control.displayName", "Display name")}</span><input id="newDisplayName" required /></label>
          <label><span>${t("common.password", "Password")}</span><input id="newPassword" type="password" required /></label>
          <label>
            <span>${t("common.role", "Role")}</span>
            <select id="newRole">
              <option value="operator">${t("control.roleOperator", "Operator")}</option>
              <option value="dispatcher">${t("control.roleDispatcher", "Dispatcher")}</option>
              <option value="scm">${t("control.roleScm", "SCM Staff")}</option>
              <option value="yard_manager">${t("control.roleYardManager", "Yard Manager")}</option>
              <option value="admin">${t("control.roleAdmin", "Admin")}</option>
            </select>
          </label>
          <button class="primary" type="submit">${t("control.createAccount", "Create account")}</button>
        </form>
      </section>
      <section class="panel">
        <h2>${t("control.accounts", "Accounts")}</h2>
        ${renderOperators()}
      </section>
    </div>
  `;
}

function renderClassificationSection() {
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>${t("control.itemClassification", "Item Classification")}</h2>
          <p class="muted">${t("control.classificationHelp", "Edit local Type, Brand, and Series for cycle count filtering.")}</p>
        </div>
        <div class="actions">
          <input id="classificationSearch" placeholder="${t("control.searchItem", "Search item...")}" value="${classificationSearch}" />
          <button data-action="sync-inventory">${t("control.syncInventory", "Sync Inventory")}</button>
          <button data-action="load-classifications">${t("control.reloadItems", "Reload Items")}</button>
        </div>
      </div>
      ${renderClassifications()}
    </section>
  `;
}

function renderAuditSection() {
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>${t("control.auditLog", "Audit Log")}</h2>
          <p class="muted">${t("control.latest", "Latest")} ${audit.length} ${t("control.records", "records")}</p>
        </div>
        <button data-action="load-audit">${t("common.refresh", "Refresh")}</button>
      </div>
      <div class="audit-filter-card">
        <div class="audit-filter-row">
          <label>
            <span>${t("control.from", "From")}</span>
            <input data-audit-filter="from" type="datetime-local" value="${escapeHtml(auditFilters.from)}" />
          </label>
          <label>
            <span>${t("control.to", "To")}</span>
            <input data-audit-filter="to" type="datetime-local" value="${escapeHtml(auditFilters.to)}" />
          </label>
          <label>
            <span>${t("control.actor", "Actor")}</span>
            <select data-audit-filter="actor">
              ${renderAuditSelectOptions(auditOptions.actors, auditFilters.actor, t("control.allActors", "All actors"))}
            </select>
          </label>
          <label>
            <span>${t("control.action", "Action")}</span>
            <select data-audit-filter="action">
              ${renderAuditSelectOptions(auditOptions.actions, auditFilters.action, t("control.allActions", "All actions"))}
            </select>
          </label>
          <label>
            <span>${t("control.tranid", "TranID")}</span>
            <input data-audit-filter="tranid" placeholder="SO / TO / PO / CO" value="${escapeHtml(auditFilters.tranid)}" />
          </label>
          <label>
            <span>${t("control.limit", "Limit")}</span>
            <select data-audit-filter="limit">
              ${["100", "200", "300", "500"].map((value) => `<option value="${value}" ${String(auditFilters.limit) === value ? "selected" : ""}>${value}</option>`).join("")}
            </select>
          </label>
          <div class="audit-filter-actions">
            <button class="primary" data-action="apply-audit-filters" type="button">${t("common.apply", "Apply")}</button>
            <button data-action="reset-audit-filters" type="button">${t("common.reset", "Reset")}</button>
          </div>
        </div>
      </div>
      ${renderAudit()}
    </section>
  `;
}

function renderCycleCountSection() {
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>${t("control.cycleCountReview", "Cycle Count Review")}</h2>
          <p class="muted">${t("control.cycleCountHelp", "Review submitted blind counts with system quantities and variance.")}</p>
        </div>
        <button data-action="refresh">${t("common.refresh", "Refresh")}</button>
      </div>
      <div class="cycle-review-list">
        ${cycleRecords.map((record) => `
          <details class="review-record">
            <summary>
              <strong>#${record.id}</strong>
              <span>${record.operator_name || t("control.unknownOperator", "Unknown operator")}</span>
              <span>${formatDate(record.submitted_at)}</span>
              <span>${record.line_count} ${t("control.lines", "lines")}</span>
              <span>${t("control.absVariance", "Abs Var")} ${valueText(record.total_abs_variance)}</span>
            </summary>
            <div class="spreadsheet-wrap small">
              <table class="spreadsheet-table cycle-review-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>${t("common.location", "Location")}</th>
                    <th>${t("control.counted", "Counted")}</th>
                    <th>${t("control.countedTotal", "Counted Total")}</th>
                    <th>${t("control.systemOnHand", "System On Hand")}</th>
                    <th>${t("control.available", "Available")}</th>
                    <th>${t("control.variance", "Variance")}</th>
                    <th>${t("control.conversion", "Conversion")}</th>
                  </tr>
                </thead>
                <tbody>
                  ${record.lines.map((line) => `
                    <tr>
                      <td><strong>${line.item_name}</strong><br><span class="muted">${line.brand || ""} ${line.series || ""}</span></td>
                      <td>${line.location || line.location_id}</td>
                      <td>${valueText(line.counted_pallet_qty)} PLT / ${valueText(line.counted_layer_qty)} LYR / ${valueText(line.counted_section_qty)} SEC / ${valueText(line.counted_piece_qty)} PCS</td>
                      <td>${valueText(line.counted_total_qty)}</td>
                      <td>${valueText(line.system_on_hand_qty)}</td>
                      <td>${valueText(line.system_available_qty)}</td>
                      <td><strong class="${Number(line.variance_qty) === 0 ? "" : Number(line.variance_qty) > 0 ? "bad" : "warn"}">${valueText(line.variance_qty)}</strong></td>
                      <td>PLT ${valueText(line.to_plt)} / LYR ${valueText(line.to_lyr)} / SEC ${valueText(line.to_sec)} / PCS ${valueText(line.to_pcs)}</td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>
          </details>
        `).join("") || `<p class="muted">${t("control.noCycleCounts", "No submitted cycle counts yet.")}</p>`}
      </div>
    </section>
  `;
}

function renderFulfillmentSection() {
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>${t("control.operatorLoadRecords", "Operator Load Records")}</h2>
          <p class="muted">${t("control.loadRecordsHelp", "Review local load/photo records posted by operators.")}</p>
        </div>
        <button data-action="refresh">${t("common.refresh", "Refresh")}</button>
      </div>
      <div class="fulfillment-review-list">
        ${fulfillmentRecords.map((record) => `
          <details class="review-record">
            <summary>
              <strong>${record.fulfillment_status || "Load"}</strong>
              <span>${record.tranid || record.order_id}</span>
              <span>${record.fulfillment_status}</span>
              <span>${record.operator_name || ""}</span>
              <span>${formatDate(record.created_at)}</span>
            </summary>
            <pre>${JSON.stringify({ payload: record.payload, response: record.response, photo: record.photo_preview ? "captured" : "" }, null, 2)}</pre>
          </details>
        `).join("") || `<p class="muted">${t("control.noLoadRecords", "No load records yet.")}</p>`}
      </div>
    </section>
  `;
}

function valueText(value) {
  return value === null || value === undefined ? "" : String(value);
}

function renderClassifications() {
  return `
    <div class="spreadsheet-wrap">
      <table class="spreadsheet-table">
        <thead>
          <tr>
            <th>${t("control.internalId", "Internal ID")}</th>
            <th>${t("common.name", "Name")}</th>
            <th>${t("common.description", "Description")}</th>
            <th>${t("control.onHand", "On Hand")}</th>
            <th>${t("control.available", "Available")}</th>
            <th>${t("common.type", "Type")}</th>
            <th>${t("control.brand", "Brand")}</th>
            <th>${t("control.series", "Series")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${classifications.map((item) => `
            <tr data-item-row="${item.item_id}">
              <td><strong>${item.item_id}</strong></td>
              <td><strong>${item.item_name || ""}</strong><br><span class="muted">${item.display_name || ""}</span></td>
              <td>${item.item_description || ""}</td>
              <td>${valueText(item.total_on_hand)}</td>
              <td>${valueText(item.total_available)}</td>
              <td><input data-field="productType" value="${valueText(item.product_type)}" /></td>
              <td><input data-field="brand" value="${valueText(item.brand)}" /></td>
              <td><input data-field="series" value="${valueText(item.series)}" /></td>
              <td><button class="primary" data-action="save-classification" data-item="${item.item_id}">${t("common.save", "Save")}</button></td>
            </tr>
          `).join("") || `<tr><td colspan="9" class="muted">${t("control.noItems", "No items yet. Click Sync Inventory.")}</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function renderOperators() {
  return `
    <table>
      <thead><tr><th>${t("common.name", "Name")}</th><th>${t("common.role", "Role")}</th><th>${t("common.status", "Status")}</th><th>${t("common.password", "Password")}</th><th></th></tr></thead>
      <tbody>
        ${operators.map((item) => `
          <tr>
            <td><strong>${item.display_name}</strong><br><span class="muted">${item.username}</span></td>
            <td>${item.role}</td>
            <td>${item.active ? t("common.active", "Active") : t("common.disabled", "Disabled")}</td>
            <td>
              <form class="password-reset-form" data-form="reset-password" data-id="${item.id}" data-name="${item.display_name}">
                <input name="password" type="password" minlength="6" placeholder="${t("common.passwordNew", "New password")}" autocomplete="new-password" required />
                <button class="primary" type="submit">${t("common.reset", "Reset")}</button>
              </form>
            </td>
            <td>
              <button class="${item.active ? "danger" : ""}" data-action="toggle-active" data-id="${item.id}" data-active="${!item.active}">
                ${item.active ? t("common.disable", "Disable") : t("common.enable", "Enable")}
              </button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderAudit() {
  return `
    <table>
      <thead><tr><th>${t("control.time", "Time")}</th><th>${t("control.actor", "Actor")}</th><th>${t("control.action", "Action")}</th><th>${t("control.tranid", "TranID")}</th><th>${t("common.order", "Order")}</th><th>${t("control.details", "Details")}</th></tr></thead>
      <tbody>
        ${audit.map((row) => `
          <tr>
            <td>${formatDate(row.created_at)}</td>
            <td>${row.display_name || row.actor_type}</td>
            <td><strong>${row.action}</strong><br><span class="muted">${row.source}</span></td>
            <td><strong>${escapeHtml(row.tranid || "")}</strong></td>
            <td>${row.order_id || ""}${row.line_id ? `<br><span class="muted">${t("control.line", "Line")} ${row.line_id}</span>` : ""}</td>
            <td><pre>${JSON.stringify(row.details || {}, null, 2)}</pre></td>
          </tr>
        `).join("") || `<tr><td colspan="6" class="muted">${t("control.noAuditRows", "No audit rows match the filters.")}</td></tr>`}
      </tbody>
    </table>
  `;
}

async function loadAudit() {
  audit = await request(auditQueryString());
  return audit;
}

async function loadAuditOptions() {
  auditOptions = await request(auditOptionsQueryString());
  return auditOptions;
}

async function loadControlData() {
  operators = await request("/api/operators");
  await loadAuditOptions();
  await loadAudit();
  classifications = await request(`/api/inventory/classifications?limit=300${classificationSearch ? `&search=${encodeURIComponent(classificationSearch)}` : ""}`);
  cycleRecords = await request("/api/cycle-count/records?limit=50");
  fulfillmentRecords = await request("/api/delivery/fulfillments?limit=100");
  recordWarnings = await request("/api/control/record-warnings?limit=100");
  orderLocks = await request("/api/control/order-locks");
  vendorMappings = await request("/api/control/vendor-mappings");
  await loadLoadedOrders({ keepSelection: true });
  if (isLoadedSearchActive()) await loadLoadedSearchResults();
  syncSettings = await request("/api/control/sync-settings");
  envSettings = await request("/api/control/env-settings");
  render();
}

app.addEventListener("submit", async (event) => {
  const form = event.target.closest("form");
  if (!form) return;
  event.preventDefault();
  try {
    if (form.dataset.form === "login") {
      const result = await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: document.getElementById("username").value,
          password: document.getElementById("password").value
        })
      });
      token = result.token;
      operator = result.operator;
      localStorage.setItem(TOKEN_KEY, token);
      return loadControlData();
    }
    if (form.dataset.form === "bootstrap") {
      await request("/api/auth/bootstrap", {
        method: "POST",
        body: JSON.stringify({
          username: document.getElementById("username").value,
          displayName: document.getElementById("displayName").value,
          password: document.getElementById("password").value
        })
      });
      bootstrapNeeded = false;
      return renderLogin("Admin created. Please login.");
    }
    if (form.dataset.form === "create-operator") {
      await request("/api/operators", {
        method: "POST",
        body: JSON.stringify({
          username: document.getElementById("newUsername").value,
          displayName: document.getElementById("newDisplayName").value,
          password: document.getElementById("newPassword").value,
          role: document.getElementById("newRole").value
        })
      });
      return loadControlData();
    }
    if (form.dataset.form === "reset-password") {
      const password = form.querySelector('input[name="password"]').value;
      if (!confirm(`Reset password for ${form.dataset.name}? This will logout existing sessions for this account.`)) return;
      await request(`/api/operators/${form.dataset.id}/password`, {
        method: "POST",
        body: JSON.stringify({ password })
      });
      form.reset();
      alert("Password updated.");
      return loadControlData();
    }
  } catch (error) {
    alert(error.message);
  }
});

app.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  try {
    if (button.dataset.action === "control-section") {
      activeSection = button.dataset.section;
      localStorage.setItem("mbbs.control.section", activeSection);
      return render();
    }
    if (button.dataset.action === "refresh") return loadControlData();
    if (button.dataset.action === "load-audit") {
      await loadAuditOptions();
      await loadAudit();
      return render();
    }
    if (button.dataset.action === "apply-audit-filters") {
      app.querySelectorAll("[data-audit-filter]").forEach((input) => {
        auditFilters[input.dataset.auditFilter] = input.value || "";
      });
      saveAuditFilters();
      await loadAuditOptions();
      await loadAudit();
      return render();
    }
    if (button.dataset.action === "reset-audit-filters") {
      auditFilters = { from: "", to: "", actor: "", action: "", tranid: "", limit: "200" };
      saveAuditFilters();
      await loadAuditOptions();
      await loadAudit();
      return render();
    }
    if (button.dataset.action === "open-photo-lightbox") {
      openPhotoLightbox(button.dataset.photoRef, button.dataset.photoLabel || "Photo preview");
      return;
    }
    if (button.dataset.action === "close-photo-lightbox") {
      closePhotoLightbox();
      return;
    }
    if (button.dataset.action === "refresh-locks") {
      orderLocks = await request("/api/control/order-locks");
      return render();
    }
    if (button.dataset.action === "refresh-vendor-mappings") {
      vendorMappings = await request("/api/control/vendor-mappings");
      return render();
    }
    if (button.dataset.action === "vendor-mapping-tab") {
      vendorMappingTab = button.dataset.tab || "links";
      localStorage.setItem("mbbs.control.vendorMapping.tab", vendorMappingTab);
      return render();
    }
    if (button.dataset.action === "discover-vendor-mappings") {
      button.disabled = true;
      button.textContent = t("common.loading", "Loading...");
      const result = await request("/api/control/vendor-mappings/discover", { method: "POST" });
      vendorMappings = { localVendors: result.localVendors || [], localVendorRows: result.localVendorRows || [], mappings: result.mappings || [] };
      alert(`Vendor discovery complete. ${result.inserted || 0} new, ${result.updated || 0} updated.`);
      return render();
    }
    if (button.dataset.action === "save-vendor-mapping") {
      const row = app.querySelector(`[data-vendor-mapping-row="${controlCssAttr(button.dataset.id)}"]`);
      const result = await request(`/api/control/vendor-mappings/${button.dataset.id}`, {
        method: "PUT",
        body: JSON.stringify({
          localVendor: row?.querySelector('[data-field="localVendor"]')?.value || "",
          active: Boolean(row?.querySelector('[data-field="active"]')?.checked)
        })
      });
      vendorMappings = { localVendors: result.localVendors || [], localVendorRows: result.localVendorRows || [], mappings: result.mappings || [] };
      alert(`Vendor mapping saved. Re-enriched ${result.enriched?.receiving || 0} receiving orders.`);
      return render();
    }
    if (button.dataset.action === "create-local-vendor") {
      const name = document.getElementById("newLocalVendorName")?.value || "";
      if (!name.trim()) return alert("Enter a local vendor name.");
      const result = await request("/api/control/local-vendors", {
        method: "POST",
        body: JSON.stringify({ name })
      });
      vendorMappings = { localVendors: result.localVendors || [], localVendorRows: result.localVendorRows || [], mappings: result.mappings || [] };
      return render();
    }
    if (button.dataset.action === "save-local-vendor") {
      const row = app.querySelector(`[data-local-vendor-row="${controlCssAttr(button.dataset.id)}"]`);
      const name = row?.querySelector('[data-field="name"]')?.value || "";
      if (!name.trim()) return alert("Enter a local vendor name.");
      if (button.dataset.currentName && button.dataset.currentName !== name && !confirm(`Rename local vendor "${button.dataset.currentName}" to "${name}"? Related vendor yards and vendor mappings will be updated.`)) return;
      const result = await request(`/api/control/local-vendors/${button.dataset.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name,
          active: Boolean(row?.querySelector('[data-field="active"]')?.checked)
        })
      });
      vendorMappings = { localVendors: result.localVendors || [], localVendorRows: result.localVendorRows || [], mappings: result.mappings || [] };
      alert(`Local vendor saved. Re-enriched ${result.enriched?.receiving || 0} receiving orders.`);
      return render();
    }
    if (button.dataset.action === "refresh-loaded-orders") {
      await loadLoadedOrders({ keepSelection: true });
      if (isLoadedSearchActive()) await loadLoadedSearchResults();
      return render();
    }
    if (button.dataset.action === "apply-loaded-filters") {
      loadedFilters = {
        from: document.getElementById("loadedFrom")?.value || todayKey(),
        to: document.getElementById("loadedTo")?.value || document.getElementById("loadedFrom")?.value || todayKey(),
        yard: document.getElementById("loadedYard")?.value || "all"
      };
      saveLoadedFilters();
      selectedLoadedOrderKey = "";
      await loadLoadedOrders();
      if (isLoadedSearchActive()) await loadLoadedSearchResults();
      return render();
    }
    if (button.dataset.action === "select-loaded-order") {
      selectedLoadedOrderKey = button.dataset.key || "";
      await loadLoadedOrderDetailForSelection();
      refreshLoadedPanels();
      return;
    }
    if (button.dataset.action === "export-loaded-csv") {
      await downloadLoadedCsv();
      return;
    }
    if (button.dataset.action === "release-lock") {
      if (!confirm(`Release preparing lock for ${button.dataset.orderRef}? Quantities and order status will not be changed.`)) return;
      const result = await request("/api/control/order-locks/release", {
        method: "POST",
        body: JSON.stringify({
          orderType: button.dataset.orderType,
          orderId: button.dataset.orderId
        })
      });
      orderLocks = result.locks || [];
      alert(`Released ${result.released?.length || 0} lock.`);
      return render();
    }
    if (button.dataset.action === "release-all-locks") {
      if (!confirm(`Release all ${orderLocks.length} active order locks? Quantities and order status will not be changed.`)) return;
      const result = await request("/api/control/order-locks/release", {
        method: "POST",
        body: JSON.stringify({ all: true })
      });
      orderLocks = result.locks || [];
      alert(`Released ${result.released?.length || 0} lock${result.released?.length === 1 ? "" : "s"}.`);
      return render();
    }
    if (button.dataset.action === "load-classifications") {
      classificationSearch = document.getElementById("classificationSearch")?.value || "";
      return loadControlData();
    }
    if (button.dataset.action === "sync-inventory") {
      await request("/api/inventory/sync", {
        method: "POST",
        body: JSON.stringify({ locationIds: [1, 28, 15, 26] })
      });
      return loadControlData();
    }
    if (button.dataset.action === "set-sync-mode") {
      syncSettings = await request("/api/control/sync-settings", {
        method: "PUT",
        body: JSON.stringify({ mode: button.dataset.mode })
      });
      return loadControlData();
    }
    if (button.dataset.action === "select-env-file") {
      if (syncSettings.running) return alert("Stop the current sync before switching env file.");
      const envFile = button.dataset.envFile;
      if (!confirm(`Switch to ${envFileLabel(envFile)} now? The current NetSuite connection token will be cleared if the live switch succeeds.`)) return;
      envSettings = await request("/api/control/env-settings", {
        method: "PUT",
        body: JSON.stringify({ envFile, applyNow: true })
      });
      if (envSettings.appliedNow) {
        alert(`Switched to ${envFileLabel(envSettings.activeEnvFile)}. Please reconnect NetSuite before syncing.`);
      } else if (envSettings.applyError) {
        alert(`Selected ${envFileLabel(envSettings.selectedEnvFile)}, but live switch was not applied: ${envSettings.applyError}`);
      } else {
        alert(`${envFileLabel(envSettings.selectedEnvFile)} is selected.`);
      }
      return loadControlData();
    }
    if (button.dataset.action === "save-sync-settings") {
      const minutesInput = app.querySelector('[data-field="sync-max-run-minutes"]');
      const parsedMaxRunMinutes = Math.round(Number(minutesInput?.value || syncMaxRunMinutesDraft || 15));
      if (!Number.isFinite(parsedMaxRunMinutes) || parsedMaxRunMinutes < 1) return alert("Enter a valid max runtime.");
      const maxRunMinutes = Math.max(1, parsedMaxRunMinutes);
      syncSettings = await request("/api/control/sync-settings", {
        method: "PUT",
        body: JSON.stringify({ mode: syncSettings.mode, maxRunSeconds: maxRunMinutes * 60 })
      });
      syncMaxRunMinutesDraft = null;
      return loadControlData();
    }
    if (button.dataset.action === "connect-netsuite") {
      location.href = "/api/auth/netsuite/start";
      return;
    }
    if (button.dataset.action === "run-sync-now") {
      button.disabled = true;
      button.textContent = "Starting...";
      const result = await request("/api/control/sync-now", { method: "POST" });
      syncSettings = result.settings || await request("/api/control/sync-settings");
      render();
      scheduleSyncPoll();
      alert(result.skipped ? "Sync is already running." : "NetSuite sync started in the background.");
      return;
    }
    if (button.dataset.action === "run-transfer-order-sync") {
      button.disabled = true;
      button.textContent = "Starting...";
      const result = await request("/api/control/sync-transfer-orders", { method: "POST" });
      syncSettings = result.settings || await request("/api/control/sync-settings");
      render();
      scheduleSyncPoll();
      alert(result.skipped ? "Sync is already running." : "Transfer/Purchase Order sync started in the background.");
      return;
    }
    if (button.dataset.action === "reconcile-netsuite-progress") {
      if (!confirm("Reconcile SO fulfilled, PO received, and TO fulfilled/received progress from current NetSuite records into local order progress? Run a normal sync first when possible.")) return;
      button.disabled = true;
      button.textContent = "Starting...";
      const result = await request("/api/control/netsuite-progress/reconcile", { method: "POST" });
      syncSettings = result.settings || await request("/api/control/sync-settings");
      render();
      scheduleSyncPoll();
      alert(result.skipped ? "Sync/reconcile is already running." : "NetSuite progress reconcile started in the background.");
      return;
    }
    if (button.dataset.action === "stop-sync") {
      if (!confirm("Stop the current sync or clear a stale running flag?")) return;
      await request("/api/control/sync-stop", { method: "POST" });
      return loadControlData();
    }
    if (button.dataset.action === "clear-order-data") {
      const confirmText = prompt("This clears operational SO/TO/PO/CO order data and dispatch plans only. Type CLEAR ORDERS to continue.");
      if (confirmText !== "CLEAR ORDERS") return;
      button.disabled = true;
      button.textContent = "Clearing...";
      const result = await request("/api/control/order-data/clear", {
        method: "POST",
        body: JSON.stringify({ confirmText })
      });
      const total = Object.values(result.counts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
      alert(`Order data cleared. ${total} rows removed.`);
      return loadControlData();
    }
    if (button.dataset.action === "save-classification") {
      const row = app.querySelector(`[data-item-row="${button.dataset.item}"]`);
      await request(`/api/inventory/classifications/${button.dataset.item}`, {
        method: "PUT",
        body: JSON.stringify({
          productType: row.querySelector('[data-field="productType"]').value,
          brand: row.querySelector('[data-field="brand"]').value,
          series: row.querySelector('[data-field="series"]').value
        })
      });
      return loadControlData();
    }
    if (button.dataset.action === "resolve-warning") {
      const resolution = prompt("Resolution note for this warning:");
      if (!resolution) return;
      await request(`/api/control/record-warnings/${button.dataset.id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ resolution })
      });
      return loadControlData();
    }
    if (button.dataset.action === "logout") {
      await request("/api/auth/logout", { method: "POST" }).catch(() => ({}));
      token = "";
      operator = null;
      clearSyncPoll();
      localStorage.removeItem(TOKEN_KEY);
      return renderLogin();
    }
    if (button.dataset.action === "toggle-active") {
      await request(`/api/operators/${button.dataset.id}/active`, {
        method: "POST",
        body: JSON.stringify({ active: button.dataset.active === "true" })
      });
      return loadControlData();
    }
  } catch (error) {
    alert(error.message);
  }
});

window.addEventListener("mbbs-control-section", (event) => {
  activeSection = event.detail?.section || "dashboard";
  localStorage.setItem("mbbs.control.section", activeSection);
  render();
});

app.addEventListener("input", (event) => {
  if (event.target?.dataset?.field !== "sync-max-run-minutes") return;
  const value = Number(event.target.value);
  syncMaxRunMinutesDraft = Number.isFinite(value) && value >= 0 ? event.target.value : "";
});

app.addEventListener("input", (event) => {
  if (event.target?.id !== "loadedSearch") return;
  loadedSearchTerm = event.target.value || "";
  saveLoadedSearch();
  clearTimeout(loadedSearchTimer);
  if (!isLoadedSearchActive()) {
    loadedSearchResults = [];
    loadedSearchLoading = false;
    if (!loadedOrders.some((order) => loadedOrderKey(order) === selectedLoadedOrderKey)) {
      selectedLoadedOrderKey = loadedOrders[0] ? loadedOrderKey(loadedOrders[0]) : "";
    }
    loadLoadedOrderDetailForSelection()
      .then(refreshLoadedPanels)
      .catch((error) => alert(error.message));
    return;
  }
  loadedSearchLoading = true;
  refreshLoadedPanels();
  loadedSearchTimer = setTimeout(() => {
    loadLoadedSearchResults()
      .then(refreshLoadedPanels)
      .catch((error) => {
        loadedSearchLoading = false;
        refreshLoadedPanels();
        alert(error.message);
      });
  }, 250);
});

async function boot() {
  const bootstrap = await request("/api/auth/bootstrap-needed");
  bootstrapNeeded = bootstrap.needed;
  if (!token) return renderLogin();
  try {
    const result = await request("/api/auth/me");
    operator = result.operator;
    if (operator.role !== "admin") return renderLogin("Admin account required.");
    await loadControlData();
  } catch (error) {
    renderLogin();
  }
}

window.addEventListener("mbbs-language-changed", () => {
  render();
});

boot().catch((error) => renderLogin(error.message));

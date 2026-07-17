const app = document.getElementById("controlApp");
const TOKEN_KEY = "mbbs.control.token";
const STAFF_TOKEN_KEY = "mbbs.staff.token";
const STAFF_ROLE_KEY = "mbbs.staff.role";
const STAFF_ROLES_KEY = "mbbs.staff.roles";
const ACCOUNT_ROLE_OPTIONS = [
  { value: "operator", labelKey: "control.roleOperator", label: "Operator" },
  { value: "dispatcher", labelKey: "control.roleDispatcher", label: "Dispatcher" },
  { value: "scm", labelKey: "control.roleScm", label: "SCM Staff" },
  { value: "yard_manager", labelKey: "control.roleYardManager", label: "Yard Manager" },
  { value: "admin", labelKey: "control.roleAdmin", label: "Admin" }
];
const IS_ADMIN_PAGE = window.location.pathname.startsWith("/admin");
const SECTION_STORAGE_KEY = IS_ADMIN_PAGE ? "mbbs.admin.section" : "mbbs.control.section";
const ACCOUNT_SELECTION_KEY = "mbbs.admin.selectedAccount";
const ADMIN_SECTIONS = new Set(["dashboard", "operators", "sync", "storage", "audit"]);
const CONTROL_SECTIONS = new Set(["dashboard", "locks", "classification", "vendor-mapping", "warnings", "loaded-export", "cycle-count", "fulfillment"]);
const CONTROL_SECTION_ROUTES = {
  dashboard: "/control",
  locks: "/control/order-locks",
  classification: "/control/item-classification",
  "vendor-mapping": "/control/vendor-mapping",
  warnings: "/control/operator-warnings",
  "loaded-export": "/control/yard-in-outbound",
  "cycle-count": "/control/cycle-count-review",
  fulfillment: "/control/operator-load-records"
};
const CONTROL_ROUTE_SECTIONS = Object.fromEntries(
  Object.entries(CONTROL_SECTION_ROUTES).map(([section, route]) => [route, section])
);
const PAGE_SECTIONS = IS_ADMIN_PAGE ? ADMIN_SECTIONS : CONTROL_SECTIONS;
const t = (key, fallback) => window.MBBS_I18N?.t(key, fallback) || fallback;
const languageToggle = () => window.MBBS_I18N?.toggleHtml() || "";

function normalizedRole(value) {
  return String(value || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
}

function normalizedStaffRoles(account) {
  return [...new Set([
    ...(Array.isArray(account?.roles) ? account.roles : []),
    account?.role
  ].map(normalizedRole).filter(Boolean))];
}

function hasStaffAuthority(account, allowedRoles) {
  const granted = new Set(normalizedStaffRoles(account));
  return allowedRoles.some((role) => granted.has(normalizedRole(role)));
}

function operatorRoleLabel(role) {
  const option = ACCOUNT_ROLE_OPTIONS.find((entry) => entry.value === normalizedRole(role));
  return option ? t(option.labelKey, option.label) : String(role || "");
}

function renderRoleOptions(selectedRole) {
  const selected = normalizedRole(selectedRole);
  return ACCOUNT_ROLE_OPTIONS.map((option) => `
    <option value="${option.value}" ${option.value === selected ? "selected" : ""}>${t(option.labelKey, option.label)}</option>
  `).join("");
}

function renderAuthorityChoices(selectedRoles, attributeName) {
  const selected = new Set((selectedRoles || []).map(normalizedRole));
  return ACCOUNT_ROLE_OPTIONS.map((option) => `
    <label class="authority-choice">
      <input type="checkbox" ${attributeName} value="${option.value}" ${selected.has(option.value) ? "checked" : ""} />
      <span>${t(option.labelKey, option.label)}</span>
    </label>
  `).join("");
}

function roleHomeRoute(role) {
  const clean = normalizedRole(role);
  if (clean === "admin") return "/admin";
  if (clean === "dispatcher") return "/dispatch";
  if (clean === "scm" || clean === "scm_staff") return "/scm";
  if (clean === "yard_manager") return "/control";
  if (clean === "operator") return "/operator";
  return "/";
}

function readStaffToken() {
  return localStorage.getItem(STAFF_TOKEN_KEY)
    || localStorage.getItem(TOKEN_KEY)
    || localStorage.getItem("mbbs.dispatch.token")
    || localStorage.getItem("mbbs.operator.token")
    || "";
}

function storeStaffSession(nextToken, nextOperator) {
  token = nextToken || "";
  if (token) {
    localStorage.setItem(STAFF_TOKEN_KEY, token);
    localStorage.setItem(TOKEN_KEY, token);
  }
  if (nextOperator?.role) localStorage.setItem(STAFF_ROLE_KEY, normalizedRole(nextOperator.role));
  localStorage.setItem(STAFF_ROLES_KEY, JSON.stringify(normalizedStaffRoles(nextOperator)));
}

function clearStaffSession() {
  for (const key of [STAFF_TOKEN_KEY, STAFF_ROLE_KEY, STAFF_ROLES_KEY, "mbbs.control.token", "mbbs.dispatch.token", "mbbs.operator.token"]) {
    localStorage.removeItem(key);
  }
  token = "";
}

function canAccessCurrentPage(account) {
  return IS_ADMIN_PAGE
    ? hasStaffAuthority(account, ["admin"])
    : hasStaffAuthority(account, ["admin", "yard_manager"]);
}

function normalizedSection(value) {
  return PAGE_SECTIONS.has(value) ? value : "dashboard";
}

function sectionFromCurrentRoute() {
  if (IS_ADMIN_PAGE) return null;
  return CONTROL_ROUTE_SECTIONS[window.location.pathname] || null;
}

function routeForSection(section) {
  return IS_ADMIN_PAGE ? "/admin" : (CONTROL_SECTION_ROUTES[normalizedSection(section)] || "/control");
}

function setActiveSection(section, { updateRoute = true } = {}) {
  activeSection = normalizedSection(section);
  localStorage.setItem(SECTION_STORAGE_KEY, activeSection);
  if (updateRoute && !IS_ADMIN_PAGE) {
    const route = routeForSection(activeSection);
    if (window.location.pathname !== route) window.history.pushState({ controlSection: activeSection }, "", route);
    window.dispatchEvent(new Event("mbbs-sidebar-route-changed"));
  }
  render();
}

let token = readStaffToken();
let operator = null;
let operators = [];
let selectedOperatorId = localStorage.getItem(ACCOUNT_SELECTION_KEY) || "";
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
let photoArchiveSettings = {
  mode: "off",
  intervalMinutes: 1440,
  running: false,
  lastStatus: "idle",
  stats: {}
};
let envSettings = { activeEnvFile: ".env", selectedEnvFile: ".env", restartRequired: false, files: [] };
let vendorMappings = { localVendors: [], mappings: [] };
let vendorMappingTab = localStorage.getItem("mbbs.control.vendorMapping.tab") || "links";
const USE_NETSUITE_ADDRESS_VENDOR = "__USE_NETSUITE_ADDRESS__";
let classificationSearch = "";
let bootstrapNeeded = false;
let activeSection = normalizedSection(sectionFromCurrentRoute() || localStorage.getItem(SECTION_STORAGE_KEY) || "dashboard");
let syncPollTimer = null;
let photoArchivePollTimer = null;

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
let loadedItemSearchTerm = localStorage.getItem("mbbs.control.loaded.itemSearch") || "";
let loadedDirection = localStorage.getItem("mbbs.control.loaded.direction") === "inbound" ? "inbound" : "outbound";
const loadedTypeByDirection = {
  inbound: ["purchase_order", "transfer_order", "co_order"].includes(localStorage.getItem("mbbs.control.loaded.inboundType"))
    ? localStorage.getItem("mbbs.control.loaded.inboundType")
    : "purchase_order",
  outbound: ["sales_order", "transfer_order", "vrma_order"].includes(localStorage.getItem("mbbs.control.loaded.outboundType"))
    ? localStorage.getItem("mbbs.control.loaded.outboundType")
    : "sales_order"
};
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
    clearStaffSession();
    operator = null;
    renderLogin("Please login again.");
    throw new Error("Login required");
  }
  if (!response.ok) {
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (response.status === 403 && payload?.redirect) {
      window.location.replace(payload.redirect);
      throw new Error(payload.error || "Not authorized");
    }
    throw new Error(payload?.error || text || "Request failed");
  }
  return response.json();
}

function formatDate(value) {
  if (!value) return "";
  return window.MBBS_I18N?.displayDateTime(value) || "";
}

function formatBytes(value) {
  let amount = Math.max(0, Number(value || 0));
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toLocaleString(undefined, { maximumFractionDigits: unit ? 2 : 0 })} ${units[unit]}`;
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
  if (!IS_ADMIN_PAGE || !operator || !syncSettings.running) return;
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

function clearPhotoArchivePoll() {
  clearTimeout(photoArchivePollTimer);
  photoArchivePollTimer = null;
}

function schedulePhotoArchivePoll() {
  clearPhotoArchivePoll();
  if (!IS_ADMIN_PAGE || !operator || !photoArchiveSettings.running) return;
  photoArchivePollTimer = setTimeout(pollPhotoArchiveStatus, 3000);
}

async function pollPhotoArchiveStatus() {
  if (!operator) return;
  const wasRunning = Boolean(photoArchiveSettings.running);
  try {
    photoArchiveSettings = await request("/api/admin/photo-archive");
    if (wasRunning && !photoArchiveSettings.running) {
      await loadControlData();
      return;
    }
    if (["dashboard", "storage"].includes(activeSection)) render();
  } catch (error) {
    console.warn(error);
  } finally {
    schedulePhotoArchivePoll();
  }
}

function renderLogin(message = "") {
  clearSyncPoll();
  clearPhotoArchivePoll();
  app.innerHTML = `
    <section class="panel login">
      <h1>${IS_ADMIN_PAGE ? "MBBS Administration" : t("control.operatorControl", "MBBS Yard Control")}</h1>
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
          <h1>${IS_ADMIN_PAGE ? "Administration" : t("control.operatorControl", "Yard Control")}</h1>
        </div>
        <div class="topbar-language">${languageToggle()}</div>
        <div class="actions">
          ${IS_ADMIN_PAGE
            ? `<button onclick="location.href='/control'">Open Control</button>`
            : `<button onclick="location.href='/operator'">${t("control.openOperator", "Open Operator PWA")}</button>${hasStaffAuthority(operator, ["admin"]) ? `<button onclick="location.href='/admin'">Admin</button>` : ""}`}
          <button data-action="refresh">${t("common.refresh", "Refresh")}</button>
          <button data-action="logout">${t("common.logout", "Logout")} ${operator.display_name}</button>
        </div>
      </header>
      <section class="control-content">
        ${renderActiveSection()}
      </section>
    </section>
  `;
  restoreControlFocus(focusState);
  schedulePhotoArchivePoll();
  scheduleSyncPoll();
}

function renderActiveSection() {
  activeSection = normalizedSection(activeSection);
  if (activeSection === "operators") return renderOperatorsSection();
  if (activeSection === "locks") return renderLocksSection();
  if (activeSection === "classification") return renderClassificationSection();
  if (activeSection === "vendor-mapping") return renderVendorMappingSection();
  if (activeSection === "storage") return renderStorageSection();
  if (activeSection === "sync") return renderSyncSection();
  if (activeSection === "warnings") return renderWarningsSection();
  if (activeSection === "loaded-export") return renderLoadedExportSection();
  if (activeSection === "cycle-count") return renderCycleCountSection();
  if (activeSection === "fulfillment") return renderFulfillmentSection();
  if (activeSection === "audit") return renderAuditSection();
  return renderDashboardSection();
}

function renderDashboardSection() {
  if (IS_ADMIN_PAGE) {
    const activeOperators = operators.filter((item) => item.active).length;
    return `
      <div class="dashboard-grid">
        <button class="metric-card" data-action="control-section" data-section="operators" type="button">
          <span>${t("control.accounts", "Accounts")}</span>
          <strong>${activeOperators} / ${operators.length}</strong>
          <em>${t("control.activeAccounts", "active accounts")}</em>
        </button>
        <button class="metric-card" data-action="control-section" data-section="sync" type="button">
          <span>${t("control.netsuiteSync", "NetSuite Sync")}</span>
          <strong>${syncSettings.mode === "auto" ? t("control.auto", "Auto") : t("control.manual", "Manual")}</strong>
          <em>${syncSettings.running ? t("control.syncRunning", "sync running") : syncSettings.lastStatus || "idle"}</em>
        </button>
        <button class="metric-card ${photoArchiveSettings.lastStatus === "partial" || photoArchiveSettings.lastStatus === "failed" ? "warning" : ""}" data-action="control-section" data-section="storage" type="button">
          <span>Photo Storage</span>
          <strong>${photoArchiveSettings.mode === "off" ? "Off" : photoArchiveSettings.mode === "auto" ? "Auto" : "Manual"}</strong>
          <em>${photoArchiveSettings.stats?.referencedArchivedCount || 0} / ${photoArchiveSettings.stats?.referencedR2Count || 0} photos archived locally</em>
        </button>
        <button class="metric-card" data-action="control-section" data-section="audit" type="button">
          <span>${t("control.auditLog", "Audit Log")}</span>
          <strong>${audit.length}</strong>
          <em>login and application records loaded</em>
        </button>
      </div>
      <section class="panel">
        <h2>Administration</h2>
        <p class="muted">Manage application access, NetSuite synchronization, photo storage, and security audit history. Yard operations remain under Control.</p>
        <div class="actions"><button onclick="location.href='/control'">Open Control</button></div>
      </section>
    `;
  }
  const classified = classifications.filter((item) => item.product_type || item.brand || item.series).length;
  const openWarnings = recordWarnings.filter((item) => item.status === "open").length;
  return `
    <div class="dashboard-grid">
      <button class="metric-card" data-action="control-section" data-section="classification" type="button">
        <span>${t("control.itemClassification", "Item Classification")}</span>
        <strong>${classified} / ${classifications.length}</strong>
        <em>${t("control.loadedRowsClassified", "loaded rows classified")}</em>
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
        <span>${t("control.loadedExport", "Yard In/Outbound")}</span>
        <strong>${loadedOrders.length}</strong>
        <em>${t("control.filteredLoaded", "processed movements in the selected tab")}</em>
      </button>
      <button class="metric-card" data-action="control-section" data-section="vendor-mapping" type="button">
        <span>${t("control.vendorMapping", "Vendor Mapping")}</span>
        <strong>${vendorMappings.mappings?.length || 0}</strong>
        <em>local vendor links</em>
      </button>
    </div>
    <section class="panel">
      <h2>${t("control.operatorControl", "Yard Control")}</h2>
      <p class="muted">Use the left menu to manage yard records, classifications, warnings, locks, and load history.</p>
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
  return `${order.direction}:${order.order_type}:${order.order_id}`;
}

const YARD_MOVEMENT_TYPES = {
  inbound: ["purchase_order", "transfer_order", "co_order"],
  outbound: ["sales_order", "transfer_order", "vrma_order"]
};

function selectedLoadedOrderType() {
  return loadedTypeByDirection[loadedDirection];
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
    sales_order: t("yard.salesOrder", "Sales Order"),
    transfer_order: t("yard.transferOrder", "Transfer Order"),
    purchase_order: t("yard.purchaseOrder", "Purchase Order"),
    co_order: t("yard.coOrder", "CO Order"),
    vrma_order: "VRMA"
  }[orderType] || orderType;
}

function movementQuantity(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return escapeHtml(valueText(value));
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
  const salesTerm = `<span class="movement-quantity-term sales"><b>${movementQuantity(line.processed_qty)}</b><small>${escapeHtml(salesUom)}</small></span>`;
  if (!mixed.units.length) {
    return `<div class="movement-quantity-equation single">${salesTerm}</div>${!mixed.hasConversion ? `<small class="converted-uom-empty">${t("yard.noConversion", "No item conversion")}</small>` : ""}`;
  }
  const terms = [
    ...mixed.units.map((unit) => `<span class="movement-quantity-term"><b>${movementQuantity(unit.value)}</b><small>${unit.label}</small></span>`),
    ...(mixed.remainder > 0 ? [`<span class="movement-quantity-term remainder"><b>${movementQuantity(mixed.remainder)}</b><small>${escapeHtml(salesUom)}</small></span>`] : [])
  ];
  return `<div class="movement-quantity-equation">${terms.join('<i class="movement-quantity-join">&amp;</i>')}<i class="movement-quantity-equals">=</i>${salesTerm}</div>`;
}

function loadedOrdersQuery() {
  const params = new URLSearchParams();
  params.set("from", loadedFilters.from || todayKey());
  params.set("to", loadedFilters.to || loadedFilters.from || todayKey());
  params.set("yard", loadedFilters.yard || "all");
  params.set("direction", loadedDirection);
  params.set("orderType", selectedLoadedOrderType());
  return params;
}

function loadedSearchQuery() {
  const params = new URLSearchParams();
  params.set("from", "2000-01-01");
  params.set("to", "2099-12-31");
  params.set("yard", "all");
  if (loadedSearchTerm.trim()) params.set("search", loadedSearchTerm.trim());
  if (loadedItemSearchTerm.trim()) params.set("itemSearch", loadedItemSearchTerm.trim());
  return params;
}

function saveLoadedFilters() {
  localStorage.setItem("mbbs.control.loaded.from", loadedFilters.from || "");
  localStorage.setItem("mbbs.control.loaded.to", loadedFilters.to || "");
  localStorage.setItem("mbbs.control.loaded.yard", loadedFilters.yard || "all");
}

function saveLoadedSearch() {
  localStorage.setItem("mbbs.control.loaded.search", loadedSearchTerm || "");
  localStorage.setItem("mbbs.control.loaded.itemSearch", loadedItemSearchTerm || "");
}

function isLoadedSearchActive() {
  return loadedSearchTerm.trim().length > 0 || loadedItemSearchTerm.trim().length > 0;
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
  detailParams.set("direction", selected.direction);
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
  const itemTerm = loadedItemSearchTerm.trim();
  const seq = ++loadedSearchSeq;
  if (!term && !itemTerm) {
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
  link.download = `yard-in-outbound-${loadedFilters.from || "from"}-${loadedFilters.to || "to"}.csv`;
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
      <span>${searchActive ? t("yard.globalResults", "results across all directions and order types") : `${movementTypeCode(selectedLoadedOrderType())} · ${t("yard.processed", "processed")}`}</span>
    </div>
    ${loadedSearchLoading ? `<div class="notice"><strong>${t("control.searching", "Searching...")}</strong><span>${t("yard.searchingHelp", "Checking all processed yard movements across every direction, type, yard, and date.")}</span></div>` : ""}
    ${orders.map((order) => `
      <button class="loaded-order-card ${loadedOrderKey(order) === selectedLoadedOrderKey ? "active" : ""}" data-action="select-loaded-order" data-key="${escapeHtml(loadedOrderKey(order))}" type="button">
        <div class="movement-card-head">
          <strong>${escapeHtml(order.tranid || order.order_id)}</strong>
          <span class="movement-badges"><i class="movement-badge ${escapeHtml(order.direction)}">${t(`yard.${order.direction}`, order.direction)}</i><i class="movement-badge type">${movementTypeCode(order.order_type)}</i></span>
        </div>
        <span>${escapeHtml(order.yard_location || t("common.yard", "Yard"))} | ${escapeHtml(order.movement_status || t("yard.processed", "Processed"))}</span>
        <em>${formatDate(order.last_processed_at)} | ${order.process_count || 0} ${t("yard.activities", "activities")} | ${order.photo_count || 0} ${t("common.photos", "photos")}</em>
        ${order.party ? `<small>${escapeHtml(order.party)}</small>` : ""}
      </button>
    `).join("") || (!loadedSearchLoading ? `<div class="notice"><strong>${t("yard.noMovements", "No processed yard movements")}</strong><span>${searchActive ? t("yard.noSearchResults", "No order matched either search across all dates, yards, directions, and order types.") : t("yard.noFilterResults", "No processed movement matched this direction, order type, date, and yard.")}</span></div>` : "")}
  `;
}

function renderLoadedExportSection() {
  const searchActive = isLoadedSearchActive();
  const typeTabs = YARD_MOVEMENT_TYPES[loadedDirection] || [];
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>${t("control.loadedExportTitle", "Yard In/Outbound")}</h2>
          <p class="muted">${t("control.loadedExportHelp", "Review processed receipts and loads for PO, TO, CO, SO, and VRMA orders.")}</p>
        </div>
        <button data-action="refresh-loaded-orders" type="button">${t("common.refresh", "Refresh")}</button>
      </div>
      <div class="loaded-layout">
        <aside class="loaded-left-panel">
          <div class="loaded-search-panel loaded-search-stack">
            <label>
              <span>${t("control.orderSearch", "Order Search")}</span>
              <input id="loadedSearch" placeholder="${t("yard.orderSearchPlaceholder", "Order / party / location")}" value="${escapeHtml(loadedSearchTerm)}" />
            </label>
            <label>
              <span>${t("yard.itemSearch", "Item Search")}</span>
              <input id="loadedItemSearch" placeholder="${t("yard.itemSearchPlaceholder", "SKU / item / description")}" value="${escapeHtml(loadedItemSearchTerm)}" />
            </label>
          </div>
          <div class="yard-movement-tabs">
            <div class="yard-direction-tabs" role="tablist" aria-label="${t("yard.direction", "Direction")}">
              ${["inbound", "outbound"].map((direction) => `<button class="${loadedDirection === direction && !searchActive ? "active" : ""}" data-action="yard-direction" data-direction="${direction}" type="button">${t(`yard.${direction}`, direction === "inbound" ? "Inbound" : "Outbound")}</button>`).join("")}
            </div>
            <div class="yard-type-tabs" role="tablist" aria-label="${t("yard.orderType", "Order Type")}">
              ${typeTabs.map((orderType) => `<button class="${selectedLoadedOrderType() === orderType && !searchActive ? "active" : ""}" data-action="yard-type" data-order-type="${orderType}" aria-label="${escapeHtml(movementTypeLabel(orderType))}" title="${escapeHtml(movementTypeLabel(orderType))}" type="button">${movementTypeCode(orderType)}</button>`).join("")}
            </div>
          </div>
          <div class="loaded-order-list" id="loadedOrderList">
            ${renderLoadedOrderList()}
          </div>
        </aside>
        <section class="loaded-right-panel">
          <div class="loaded-filter-card">
            <div class="loaded-filter-title">
              <strong>${t("control.exportFilter", "Export Filter")}</strong>
              <span>${t("yard.exportFilterHelp", "CSV uses the selected direction, type, date, and yard filters.")}</span>
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
    return `<div class="empty-detail"><strong>${t("common.selectOrder", "Select an order")}</strong><span>${t("yard.selectMovementHelp", "Processed lines, converted UOM, and photo proof will show here.")}</span></div>`;
  }
  const { order, lines = [], photos = [] } = loadedOrderDetail;
  const route = [order.source_location, order.destination_location].filter(Boolean).join(" → ");
  return `
    <div class="loaded-detail-head">
      <div>
        <div class="movement-detail-title"><h3>${escapeHtml(order.tranid || order.order_id)}</h3><span class="movement-badges"><i class="movement-badge ${escapeHtml(order.direction)}">${t(`yard.${order.direction}`, order.direction)}</i><i class="movement-badge type">${movementTypeCode(order.order_type)}</i></span></div>
        <p class="muted">${escapeHtml(movementTypeLabel(order.order_type))} | ${escapeHtml(order.yard_location || "")} | ${escapeHtml(order.movement_status || t("yard.processed", "Processed"))}</p>
        ${route ? `<p class="muted">${escapeHtml(route)}</p>` : ""}
        ${order.party ? `<p class="muted">${escapeHtml(order.party)}</p>` : ""}
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
            ${renderMovementQuantityEquation(line)}
            <small>${escapeHtml(line.location || order.yard_location || "")}</small>
          </div>
        </div>
      `).join("") || `<div class="notice"><strong>${t("yard.noProcessedLines", "No processed lines")}</strong><span>${t("yard.noProcessedLinesHelp", "This order has an activity record but no retained processed line quantity.")}</span></div>`}
    </div>
    <div class="loaded-photo-section">
      <h3>${t("common.photos", "Photos")}</h3>
      <div class="loaded-photo-grid">
        ${photos.filter((photo) => photo.photo_data_url).map((photo) => `
          <figure>
            <button class="photo-thumb-button" data-action="open-photo-lightbox" data-photo-ref="${escapeHtml(photo.photo_data_url)}" data-photo-label="${t("yard.activityPhoto", "Activity photo")} ${escapeHtml(photo.id)}" type="button">
              <img src="${photoImgSrc(photo.photo_data_url)}" alt="${t("yard.activityPhoto", "Activity photo")} ${escapeHtml(photo.id)}" />
            </button>
            <figcaption>${formatDate(photo.created_at)}</figcaption>
          </figure>
        `).join("") || `<div class="notice"><strong>${t("common.noPhoto", "No photo")}</strong><span>${t("yard.noPhotoHelp", "No photo proof is attached to this processed activity in the filtered date range.")}</span></div>`}
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

function renderStorageSection() {
  const stats = photoArchiveSettings.stats || {};
  const summary = photoArchiveSettings.lastSummary || {};
  const mode = photoArchiveSettings.mode || "off";
  const intervalMinutes = Math.max(5, Number(photoArchiveSettings.intervalMinutes || 1440));
  const failures = Array.isArray(summary.failures) ? summary.failures : [];
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Photo Storage Management</h2>
          <p class="muted">Archive referenced R2 photos into persistent local storage, verify every local copy, and then remove the R2 object.</p>
        </div>
        <button data-action="refresh-photo-archive" type="button">Refresh</button>
      </div>
      <div class="sync-mode-grid">
        <button class="sync-mode-card ${mode === "off" ? "active" : ""}" data-action="set-photo-archive-mode" data-mode="off" type="button" ${photoArchiveSettings.running ? "disabled" : ""}>
          <strong>Off</strong>
          <span>Disable manual and scheduled archival.</span>
        </button>
        <button class="sync-mode-card ${mode === "manual" ? "active" : ""}" data-action="set-photo-archive-mode" data-mode="manual" type="button" ${photoArchiveSettings.running ? "disabled" : ""}>
          <strong>Manual</strong>
          <span>Archive only when an admin selects Run Backup Now.</span>
        </button>
        <button class="sync-mode-card ${mode === "auto" ? "active" : ""}" data-action="set-photo-archive-mode" data-mode="auto" type="button" ${photoArchiveSettings.running ? "disabled" : ""}>
          <strong>Auto</strong>
          <span>Run automatically using the interval below.</span>
        </button>
      </div>
      <div class="sync-status-grid">
        <div><span>Referenced R2 Photos</span><strong>${Number(stats.referencedR2Count || 0).toLocaleString()}</strong></div>
        <div><span>Readable Locally</span><strong>${Number(stats.referencedArchivedCount || 0).toLocaleString()}</strong></div>
        <div><span>Removed From R2</span><strong>${Number(stats.referencedRemoteDeletedCount || 0).toLocaleString()}</strong></div>
        <div><span>Still Pending in R2</span><strong>${Number(stats.referencedPendingCount || 0).toLocaleString()}</strong></div>
        <div><span>Local Archive Size</span><strong>${formatBytes(stats.localBytes)}</strong></div>
        <div><span>Local Disk Available</span><strong>${formatBytes(stats.localDiskAvailableBytes)}</strong></div>
        <div><span>Status</span><strong>${photoArchiveSettings.running ? "Running" : escapeHtml(photoArchiveSettings.lastStatus || "idle")}</strong></div>
        <div><span>Next Auto Run</span><strong>${formatDate(photoArchiveSettings.nextRunAt) || (mode === "auto" ? "Due now" : "Not scheduled")}</strong></div>
      </div>
      <div class="sync-status-grid sync-setting-grid">
        <label>
          <span>Automatic Interval (minutes)</span>
          <input data-field="photo-archive-interval" type="number" min="5" max="43200" step="1" value="${intervalMinutes}" ${photoArchiveSettings.running ? "disabled" : ""}>
        </label>
        <div>
          <span>Examples</span>
          <strong>60 = hourly · 1,440 = daily · 10,080 = weekly</strong>
        </div>
      </div>
      <div class="actions">
        <button data-action="save-photo-archive-settings" type="button" ${photoArchiveSettings.running ? "disabled" : ""}>Save Settings</button>
        <button class="primary" data-action="run-photo-archive" type="button" ${mode === "off" || photoArchiveSettings.running ? "disabled" : ""}>
          ${photoArchiveSettings.running ? "Backup Running..." : "Run Backup Now"}
        </button>
        <button data-action="refresh-photo-archive" type="button">Refresh Status</button>
      </div>
      <div class="notice">
        <strong>Safe deletion order</strong>
        <span>Download from R2 → write locally → verify file size and SHA-256 → record the archive → request R2 deletion. A failed download or verification never deletes the R2 copy.</span>
      </div>
      <div class="notice">
        <strong>Transparent photo access</strong>
        <span>Historical records keep their current R2 references. Operator, Driver, Dispatch, Control, and export screens automatically read an archived local file first.</span>
      </div>
      <div class="notice ${photoArchiveSettings.lastError ? "sync-error" : ""}">
        <strong>R2 Worker requirement</strong>
        <span>The configured photo worker must accept signed <code>DELETE /object</code> requests with the <code>photo-delete</code> scope. If deletion is unsupported, the verified local copy remains readable, the R2 object remains pending, and the run reports Partial.</span>
      </div>
      ${photoArchiveSettings.lastError ? `<div class="notice sync-error">
        <strong>Last run needs attention</strong>
        <span>${escapeHtml(photoArchiveSettings.lastError)}</span>
      </div>` : ""}
      <div class="sync-status-grid">
        <div><span>Last Started</span><strong>${formatDate(photoArchiveSettings.lastStartedAt) || "-"}</strong></div>
        <div><span>Last Finished</span><strong>${formatDate(photoArchiveSettings.lastFinishedAt) || "-"}</strong></div>
        <div><span>Downloaded This Run</span><strong>${Number(summary.archived || 0).toLocaleString()} · ${formatBytes(summary.bytesArchived)}</strong></div>
        <div><span>Deleted This Run</span><strong>${Number(summary.remoteDeleted || 0).toLocaleString()}</strong></div>
      </div>
      ${failures.length ? `<details class="notice sync-error">
        <summary>Show the first ${Math.min(failures.length, 25)} failed objects</summary>
        <pre>${escapeHtml(failures.slice(0, 25).map((failure) => `${failure.stage}: ${failure.key} — ${failure.error}`).join("\n"))}</pre>
      </details>` : ""}
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
  ensureOperatorSelection();
  const selected = operators.find((item) => String(item.id) === String(selectedOperatorId)) || null;
  return `
    <div class="account-management-layout">
      <aside class="panel account-master-panel">
        <div class="account-master-head">
          <div>
            <h2>${t("control.users", "Users")}</h2>
            <p class="muted">${operators.length} ${t("control.accounts", "accounts")}</p>
          </div>
          <button class="primary" data-action="new-account" type="button">+ ${t("control.newUser", "New User")}</button>
        </div>
        <div class="account-user-list" role="listbox" aria-label="${t("control.users", "Users")}">
          ${operators.map((item) => `
            <button class="account-user-option ${String(item.id) === String(selectedOperatorId) ? "selected" : ""}" data-action="select-account" data-id="${escapeHtml(item.id)}" type="button" role="option" aria-selected="${String(item.id) === String(selectedOperatorId)}">
              <span class="account-user-avatar">${escapeHtml(String(item.display_name || item.username || "?").trim().slice(0, 1).toUpperCase())}</span>
              <span class="account-user-copy">
                <strong>${escapeHtml(item.display_name || item.username)}</strong>
                <small>@${escapeHtml(item.username)} · ${escapeHtml(operatorRoleLabel(item.role))}</small>
              </span>
              <span class="account-status-dot ${item.active ? "active" : "disabled"}" title="${item.active ? t("common.active", "Active") : t("common.disabled", "Disabled")}"></span>
              ${String(item.id) === String(operator?.id) ? `<em>${t("control.you", "You")}</em>` : ""}
            </button>
          `).join("") || `<p class="muted account-list-empty">${t("control.noUsers", "No users found.")}</p>`}
        </div>
      </aside>
      <section class="panel account-detail-panel">
        ${selectedOperatorId === "new" ? renderNewOperatorDetail() : renderOperatorDetail(selected)}
      </section>
    </div>
  `;
}

function ensureOperatorSelection() {
  if (selectedOperatorId === "new") return;
  if (operators.some((item) => String(item.id) === String(selectedOperatorId))) return;
  selectedOperatorId = operators.find((item) => String(item.id) === String(operator?.id))?.id || operators[0]?.id || "new";
  if (selectedOperatorId !== "new") localStorage.setItem(ACCOUNT_SELECTION_KEY, selectedOperatorId);
}

function renderNewOperatorDetail() {
  return `
    <div class="account-detail-head">
      <div>
        <p class="eyebrow">${t("control.accountDetails", "Account details")}</p>
        <h2>${t("control.newUser", "New User")}</h2>
        <p class="muted">${t("control.newUserHelp", "Enter the new account information and assign its module authorities.")}</p>
      </div>
      ${operators.length ? `<button data-action="cancel-new-account" type="button">${t("common.cancel", "Cancel")}</button>` : ""}
    </div>
    <form class="account-detail-form" data-form="create-operator">
      <div class="account-form-grid">
        <label><span>${t("common.username", "Username")}</span><input id="newUsername" autocomplete="off" required /></label>
        <label><span>${t("control.displayName", "Display name")}</span><input id="newDisplayName" required /></label>
        <label><span>${t("common.password", "Password")}</span><input id="newPassword" type="password" minlength="6" autocomplete="new-password" required /></label>
        <label>
          <span>${t("control.primaryRole", "Primary role")}</span>
          <select id="newRole">${renderRoleOptions("operator")}</select>
        </label>
      </div>
      <fieldset class="authority-picker">
        <legend>${t("control.authorities", "Module authorities")}</legend>
        <p class="muted">${t("control.authoritiesHelp", "Select every module this account may access. The primary role controls the default page after login.")}</p>
        <div class="authority-choice-grid">${renderAuthorityChoices(["operator"], "data-new-authority")}</div>
      </fieldset>
      <div class="account-detail-actions">
        <button class="primary" type="submit">${t("control.createAccount", "Create account")}</button>
      </div>
    </form>
  `;
}

function renderOperatorDetail(item) {
  if (!item) {
    return `
      <div class="account-detail-empty">
        <h2>${t("control.selectUser", "Select a user")}</h2>
        <p class="muted">${t("control.selectUserHelp", "Choose a user on the left or create a new account.")}</p>
      </div>
    `;
  }
  return `
    <div class="account-detail-head">
      <div>
        <p class="eyebrow">${t("control.accountDetails", "Account details")}</p>
        <h2>${escapeHtml(item.display_name || item.username)}</h2>
        <p class="muted">@${escapeHtml(item.username)}</p>
      </div>
      <span class="account-status-badge ${item.active ? "active" : "disabled"}">${item.active ? t("common.active", "Active") : t("common.disabled", "Disabled")}</span>
    </div>
    <div class="account-detail-body" data-account-detail data-account-row="${escapeHtml(item.id)}">
      <section class="account-detail-card">
        <h3>${t("control.identity", "Identity")}</h3>
        <div class="account-form-grid">
          <label><span>${t("common.username", "Username")}</span><input value="${escapeHtml(item.username)}" readonly /></label>
          <label><span>${t("control.displayName", "Display name")}</span><input value="${escapeHtml(item.display_name)}" readonly /></label>
        </div>
      </section>
      <section class="account-detail-card account-access-editor">
        <div>
          <h3>${t("control.accessRights", "Access rights")}</h3>
          <p class="muted">${t("control.authoritiesHelp", "Select every module this account may access. The primary role controls the default page after login.")}</p>
        </div>
        <label>
          <span>${t("control.primaryRole", "Primary role")}</span>
          <select data-account-primary-role>${renderRoleOptions(item.role)}</select>
        </label>
        <div>
          <span class="field-label">${t("control.authorities", "Module authorities")}</span>
          <div class="authority-choice-grid">${renderAuthorityChoices(normalizedStaffRoles(item), "data-account-authority")}</div>
        </div>
        <div class="account-detail-actions">
          <button class="primary" data-action="save-account-roles" data-id="${escapeHtml(item.id)}" type="button">${t("control.saveAccess", "Save access")}</button>
        </div>
      </section>
      <section class="account-detail-card">
        <h3>${t("control.security", "Security")}</h3>
        <form class="password-reset-form" data-form="reset-password" data-id="${escapeHtml(item.id)}" data-name="${escapeHtml(item.display_name)}">
          <input name="password" type="password" minlength="6" placeholder="${t("common.passwordNew", "New password")}" autocomplete="new-password" required />
          <button class="primary" type="submit">${t("common.reset", "Reset")}</button>
        </form>
      </section>
      <section class="account-detail-card account-status-card">
        <div>
          <h3>${t("control.accountStatus", "Account status")}</h3>
          <p class="muted">${item.active ? t("control.activeAccountHelp", "This user can currently sign in.") : t("control.disabledAccountHelp", "This user is blocked from signing in.")}</p>
        </div>
        <button class="${item.active ? "danger" : "primary"}" data-action="toggle-active" data-id="${escapeHtml(item.id)}" data-active="${!item.active}" type="button">
          ${item.active ? t("common.disable", "Disable") : t("common.enable", "Enable")}
        </button>
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
  if (IS_ADMIN_PAGE) {
    const [nextOperators, nextAuditOptions, nextAudit, nextSyncSettings, nextEnvSettings, nextPhotoArchiveSettings] = await Promise.all([
      request("/api/operators"),
      request(auditOptionsQueryString()),
      request(auditQueryString()),
      request("/api/control/sync-settings"),
      request("/api/control/env-settings"),
      request("/api/admin/photo-archive")
    ]);
    operators = nextOperators;
    auditOptions = nextAuditOptions;
    audit = nextAudit;
    syncSettings = nextSyncSettings;
    envSettings = nextEnvSettings;
    photoArchiveSettings = nextPhotoArchiveSettings;
  } else {
    classifications = await request(`/api/inventory/classifications?limit=300${classificationSearch ? `&search=${encodeURIComponent(classificationSearch)}` : ""}`);
    cycleRecords = await request("/api/cycle-count/records?limit=50");
    fulfillmentRecords = await request("/api/delivery/fulfillments?limit=100");
    recordWarnings = await request("/api/control/record-warnings?limit=100");
    orderLocks = await request("/api/control/order-locks");
    vendorMappings = await request("/api/control/vendor-mappings");
    await loadLoadedOrders({ keepSelection: true });
    if (isLoadedSearchActive()) await loadLoadedSearchResults();
  }
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
      operator = result.operator;
      storeStaffSession(result.token, operator);
      if (!canAccessCurrentPage(operator)) {
        window.location.replace(roleHomeRoute(operator.role));
        return;
      }
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
      const primaryRole = document.getElementById("newRole").value;
      const roles = [...document.querySelectorAll("[data-new-authority]:checked")].map((input) => input.value);
      if (!roles.includes(primaryRole)) roles.push(primaryRole);
      const created = await request("/api/operators", {
        method: "POST",
        body: JSON.stringify({
          username: document.getElementById("newUsername").value,
          displayName: document.getElementById("newDisplayName").value,
          password: document.getElementById("newPassword").value,
          role: primaryRole,
          roles
        })
      });
      selectedOperatorId = created.id;
      localStorage.setItem(ACCOUNT_SELECTION_KEY, selectedOperatorId);
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
      return setActiveSection(button.dataset.section);
    }
    if (button.dataset.action === "new-account") {
      selectedOperatorId = "new";
      return render();
    }
    if (button.dataset.action === "select-account") {
      selectedOperatorId = button.dataset.id || "";
      if (selectedOperatorId) localStorage.setItem(ACCOUNT_SELECTION_KEY, selectedOperatorId);
      return render();
    }
    if (button.dataset.action === "cancel-new-account") {
      const savedId = localStorage.getItem(ACCOUNT_SELECTION_KEY) || "";
      selectedOperatorId = operators.some((item) => String(item.id) === String(savedId))
        ? savedId
        : operators.find((item) => String(item.id) === String(operator?.id))?.id || operators[0]?.id || "new";
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
    if (button.dataset.action === "yard-direction") {
      const direction = button.dataset.direction;
      if (!YARD_MOVEMENT_TYPES[direction]) return;
      loadedDirection = direction;
      localStorage.setItem("mbbs.control.loaded.direction", loadedDirection);
      loadedSearchTerm = "";
      loadedItemSearchTerm = "";
      loadedSearchResults = [];
      loadedSearchLoading = false;
      saveLoadedSearch();
      selectedLoadedOrderKey = "";
      await loadLoadedOrders();
      return render();
    }
    if (button.dataset.action === "yard-type") {
      const orderType = button.dataset.orderType;
      if (!(YARD_MOVEMENT_TYPES[loadedDirection] || []).includes(orderType)) return;
      loadedTypeByDirection[loadedDirection] = orderType;
      localStorage.setItem(`mbbs.control.loaded.${loadedDirection}Type`, orderType);
      loadedSearchTerm = "";
      loadedItemSearchTerm = "";
      loadedSearchResults = [];
      loadedSearchLoading = false;
      saveLoadedSearch();
      selectedLoadedOrderKey = "";
      await loadLoadedOrders();
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
    if (button.dataset.action === "refresh-photo-archive") {
      photoArchiveSettings = await request("/api/admin/photo-archive");
      return render();
    }
    if (button.dataset.action === "set-photo-archive-mode") {
      const intervalMinutes = Math.round(Number(app.querySelector('[data-field="photo-archive-interval"]')?.value || photoArchiveSettings.intervalMinutes || 1440));
      if (!Number.isFinite(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 43200) {
        return alert("Enter an interval between 5 and 43,200 minutes.");
      }
      photoArchiveSettings = await request("/api/admin/photo-archive", {
        method: "PUT",
        body: JSON.stringify({ mode: button.dataset.mode, intervalMinutes })
      });
      return render();
    }
    if (button.dataset.action === "save-photo-archive-settings") {
      const intervalMinutes = Math.round(Number(app.querySelector('[data-field="photo-archive-interval"]')?.value || 0));
      if (!Number.isFinite(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 43200) {
        return alert("Enter an interval between 5 and 43,200 minutes.");
      }
      photoArchiveSettings = await request("/api/admin/photo-archive", {
        method: "PUT",
        body: JSON.stringify({ mode: photoArchiveSettings.mode, intervalMinutes })
      });
      alert("Photo Storage settings saved.");
      return render();
    }
    if (button.dataset.action === "run-photo-archive") {
      if (!confirm("Run photo backup now? Each R2 object will be deleted only after its local copy passes size and SHA-256 verification.")) return;
      button.disabled = true;
      button.textContent = "Starting Backup...";
      const result = await request("/api/admin/photo-archive/run", { method: "POST", body: "{}" });
      photoArchiveSettings = result.settings || await request("/api/admin/photo-archive");
      render();
      schedulePhotoArchivePoll();
      if (!result.started) alert("A photo backup is already running.");
      return;
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
      operator = null;
      clearSyncPoll();
      clearStaffSession();
      return renderLogin();
    }
    if (button.dataset.action === "toggle-active") {
      await request(`/api/operators/${button.dataset.id}/active`, {
        method: "POST",
        body: JSON.stringify({ active: button.dataset.active === "true" })
      });
      return loadControlData();
    }
    if (button.dataset.action === "save-account-roles") {
      const row = button.closest("[data-account-row]");
      const role = row?.querySelector("[data-account-primary-role]")?.value || "operator";
      const roles = [...(row?.querySelectorAll("[data-account-authority]:checked") || [])].map((input) => input.value);
      if (!roles.includes(role)) roles.push(role);
      await request(`/api/operators/${button.dataset.id}/roles`, {
        method: "PUT",
        body: JSON.stringify({ role, roles })
      });
      alert(t("control.accessSaved", "Account access updated."));
      return loadControlData();
    }
  } catch (error) {
    alert(error.message);
  }
});

window.addEventListener("mbbs-control-section", (event) => {
  setActiveSection(event.detail?.section || "dashboard", { updateRoute: !IS_ADMIN_PAGE });
});

window.addEventListener("popstate", () => {
  const routedSection = sectionFromCurrentRoute();
  if (routedSection) setActiveSection(routedSection, { updateRoute: false });
});

app.addEventListener("input", (event) => {
  if (event.target?.dataset?.field !== "sync-max-run-minutes") return;
  const value = Number(event.target.value);
  syncMaxRunMinutesDraft = Number.isFinite(value) && value >= 0 ? event.target.value : "";
});

app.addEventListener("change", (event) => {
  if (event.target?.id === "newRole") {
    const checkbox = document.querySelector(`[data-new-authority][value="${event.target.value}"]`);
    if (checkbox) checkbox.checked = true;
    return;
  }
  if (event.target?.matches?.("[data-account-primary-role]")) {
    const row = event.target.closest("[data-account-row]");
    const checkbox = [...(row?.querySelectorAll("[data-account-authority]") || [])]
      .find((input) => input.value === event.target.value);
    if (checkbox) checkbox.checked = true;
  }
});

app.addEventListener("input", (event) => {
  if (!["loadedSearch", "loadedItemSearch"].includes(event.target?.id)) return;
  if (event.target.id === "loadedSearch") loadedSearchTerm = event.target.value || "";
  if (event.target.id === "loadedItemSearch") loadedItemSearchTerm = event.target.value || "";
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
  if (!token) {
    if (bootstrapNeeded && !IS_ADMIN_PAGE) {
      window.location.replace("/admin");
      return;
    }
    if (localStorage.getItem("mbbs.driver.token")) {
      window.location.replace("/driver");
      return;
    }
    return renderLogin();
  }
  try {
    const result = await request("/api/auth/me");
    operator = result.operator;
    storeStaffSession(token, operator);
    if (!canAccessCurrentPage(operator)) {
      window.location.replace(roleHomeRoute(operator.role));
      return;
    }
    await loadControlData();
  } catch (error) {
    if (!operator) renderLogin();
  }
}

window.addEventListener("mbbs-language-changed", () => {
  render();
});

boot().catch((error) => renderLogin(error.message));

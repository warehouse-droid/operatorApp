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
  { value: "sales", labelKey: "control.roleSales", label: "Sales" },
  { value: "mbt_frontdesk", labelKey: "control.roleMbtFrontdesk", label: "MBT Front Desk" },
  { value: "mbt_billing", labelKey: "control.roleMbtBilling", label: "MBT Billing" },
  { value: "admin", labelKey: "control.roleAdmin", label: "Admin" }
];
const SALES_YARD_OPTIONS = [
  { locationId: 1, yardCode: "3445" },
  { locationId: 28, yardCode: "2967" },
  { locationId: 15, yardCode: "12441" },
  { locationId: 26, yardCode: "150" }
];
const IS_ADMIN_PAGE = window.location.pathname.startsWith("/admin");
const SECTION_STORAGE_KEY = IS_ADMIN_PAGE ? "mbbs.admin.section" : "mbbs.control.section";
const ACCOUNT_SELECTION_KEY = "mbbs.admin.selectedAccount";
const SCM_RECONCILIATION_SELECTED_RUN_KEY = "mbbs.admin.reconciliation.selectedRun";
const ADMIN_SECTIONS = new Set(["dashboard", "operators", "sync", "reconciliation", "return-automation", "storage", "audit"]);
const CONTROL_SECTIONS = new Set(["dashboard", "returns", "locks", "classification", "vendor-mapping", "warnings", "loaded-export", "cycle-count", "fulfillment"]);
const CONTROL_SECTION_ROUTES = {
  dashboard: "/control",
  returns: "/control/returns",
  locks: "/control/order-locks",
  classification: "/control/item-classification",
  "vendor-mapping": "/control/vendor-mapping",
  warnings: "/control/operator-warnings",
  "loaded-export": "/control/yard-in-outbound",
  "cycle-count": "/control/cycle-count-review",
  fulfillment: "/control/operator-load-records"
};
const ADMIN_SECTION_ROUTES = {
  dashboard: "/admin",
  operators: "/admin/accounts",
  sync: "/admin/sync",
  reconciliation: "/admin/reconciliation",
  "return-automation": "/admin/return-automation",
  storage: "/admin/photo-storage",
  audit: "/admin/audit"
};
const CONTROL_ROUTE_SECTIONS = Object.fromEntries(
  Object.entries(CONTROL_SECTION_ROUTES).map(([section, route]) => [route, section])
);
const ADMIN_ROUTE_SECTIONS = Object.fromEntries(
  Object.entries(ADMIN_SECTION_ROUTES).map(([section, route]) => [route, section])
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

function classificationReturnPolicy(item = {}) {
  const override = String(item.return_policy_override || item.returnPolicyOverride || "").trim().toUpperCase();
  const productType = String(item.product_type || item.productType || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\s+/g, " ");
  const defaultPolicy = productType === "interlocking"
    ? "ALLOWED"
    : productType === "natural stone"
      ? "APPROVAL_REQUIRED"
      : "NOT_RETURNABLE";
  return {
    override,
    defaultPolicy,
    effective: override || defaultPolicy
  };
}

function classificationReturnPolicyOptions(item = {}) {
  const policy = classificationReturnPolicy(item);
  const labels = {
    ALLOWED: "Allowed",
    APPROVAL_REQUIRED: "Approval Required",
    NOT_RETURNABLE: "Not Returnable"
  };
  return [
    ["DEFAULT", `Default · ${labels[policy.defaultPolicy]}`],
    ["ALLOWED", labels.ALLOWED],
    ["APPROVAL_REQUIRED", labels.APPROVAL_REQUIRED],
    ["NOT_RETURNABLE", labels.NOT_RETURNABLE]
  ].map(([value, label]) => `
    <option value="${value}" ${(policy.override || "DEFAULT") === value ? "selected" : ""}>${label}</option>
  `).join("");
}

function refreshClassificationReturnPolicy(row) {
  const productType = row?.querySelector('[data-field="productType"]')?.value || "";
  const select = row?.querySelector('[data-field="returnPolicyOverride"]');
  if (!select) return;
  const labels = {
    ALLOWED: "Allowed",
    APPROVAL_REQUIRED: "Approval Required",
    NOT_RETURNABLE: "Not Returnable"
  };
  const policy = classificationReturnPolicy({
    productType,
    returnPolicyOverride: select.value === "DEFAULT" ? null : select.value
  });
  const defaultOption = [...select.options].find((option) => option.value === "DEFAULT");
  if (defaultOption) defaultOption.textContent = `Default · ${labels[policy.defaultPolicy]}`;
  const source = row.querySelector('[data-field="returnPolicySource"]');
  if (source) {
    source.textContent = `Company-wide · ${select.value === "DEFAULT" ? "Product Type default" : "Admin override"}`;
  }
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

function renderSalesYardChoices(selectedYards, attributeName) {
  const selected = new Set((selectedYards || []).map(Number));
  return SALES_YARD_OPTIONS.map((yard) => `
    <label class="authority-choice">
      <input type="checkbox" ${attributeName} value="${yard.locationId}" ${selected.has(yard.locationId) ? "checked" : ""} />
      <span>${yard.yardCode}</span>
    </label>
  `).join("");
}

function roleHomeRoute(role) {
  const clean = normalizedRole(role);
  if (clean === "admin") return "/admin";
  if (clean === "dispatcher") return "/dispatch";
  if (clean === "scm" || clean === "scm_staff") return "/scm";
  if (clean === "yard_manager") return "/control";
  if (clean === "sales") return "/sales";
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
  const routeSections = IS_ADMIN_PAGE ? ADMIN_ROUTE_SECTIONS : CONTROL_ROUTE_SECTIONS;
  return routeSections[window.location.pathname] || null;
}

function routeForSection(section) {
  const sectionRoutes = IS_ADMIN_PAGE ? ADMIN_SECTION_ROUTES : CONTROL_SECTION_ROUTES;
  return sectionRoutes[normalizedSection(section)] || (IS_ADMIN_PAGE ? "/admin" : "/control");
}

function setActiveSection(section, { updateRoute = true } = {}) {
  activeSection = normalizedSection(section);
  updateControlPageLayoutClass();
  localStorage.setItem(SECTION_STORAGE_KEY, activeSection);
  if (updateRoute) {
    const route = routeForSection(activeSection);
    if (window.location.pathname !== route) window.history.pushState({ controlSection: activeSection }, "", route);
    window.dispatchEvent(new Event("mbbs-sidebar-route-changed"));
  }
  render();
}

let token = readStaffToken();
let operator = null;
let operators = [];
let publicSalesSettings = { enabled: false, updatedBy: null, updatedAt: null };
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
let targetedSyncOrderRef = "";
let targetedSyncBusy = false;
let targetedSyncResult = null;
const SCM_RECONCILIATION_TIME_ZONE = "America/Toronto";
const SCM_RECONCILIATION_DEFAULT_SETTINGS = Object.freeze({
  nightlyEnabled: false,
  nightlyTime: "21:30",
  timeZone: SCM_RECONCILIATION_TIME_ZONE,
  initialBackfillSince: "2026-01-01",
  initialDryRunApproved: false,
  soInitialDryRunApproved: false
});
let scmReconciliationSettings = { ...SCM_RECONCILIATION_DEFAULT_SETTINGS };
let scmReconciliationSettingsLoaded = false;
let scmReconciliationRuns = [];
const scmReconciliationRunDetails = new Map();
let scmReconciliationLoadError = "";
let scmReconciliationBusy = false;
const scmReconciliationDecisionBusyTargets = new Set();
const scmReconciliationDecisionDrafts = new Map();
let scmReconciliationScope = "all";
let scmReconciliationSoOrderType = "delivery";
let scmReconciliationOrderKind = "PO";
let scmReconciliationOrderRef = "";
let scmReconciliationIncludeTerminalOrders = false;
let scmReconciliationDryRun = true;
let scmReconciliationSelectedRunId = localStorage.getItem(SCM_RECONCILIATION_SELECTED_RUN_KEY) || "";
let mirrorStatus = { role: "disabled", configured: false, source: {}, consumer: {} };
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
let returnRecords = [];
let returnCounts = {};
let returnDashboardCounts = {};
let returnDetail = null;
let selectedReturnId = localStorage.getItem("mbbs.control.returns.selected") || "";
let returnLoadError = "";
let returnSettingsError = "";
let controlReturnSettings = [];
let adminReturnSettings = [];
const RETURN_RECORD_PAGE_SIZE = 100;
let returnRecordOffset = 0;
let returnFilters = {
  search: localStorage.getItem("mbbs.control.returns.search") || "",
  status: localStorage.getItem("mbbs.control.returns.status") || "",
  type: localStorage.getItem("mbbs.control.returns.type") || "",
  yardLocationId: localStorage.getItem("mbbs.control.returns.yard") || "",
  from: localStorage.getItem("mbbs.control.returns.from") || "",
  to: localStorage.getItem("mbbs.control.returns.to") || ""
};
const USE_NETSUITE_ADDRESS_VENDOR = "__USE_NETSUITE_ADDRESS__";
let classificationSearch = "";
let bootstrapNeeded = false;
let activeSection = normalizedSection(sectionFromCurrentRoute() || localStorage.getItem(SECTION_STORAGE_KEY) || "dashboard");
let syncPollTimer = null;
let scmReconciliationPollTimer = null;
let photoArchivePollTimer = null;

function updateControlPageLayoutClass() {
  document.body.classList.toggle(
    "admin-sync-page",
    IS_ADMIN_PAGE && ["sync", "reconciliation"].includes(activeSection)
  );
  document.body.classList.toggle(
    "admin-reconciliation-page",
    IS_ADMIN_PAGE && activeSection === "reconciliation"
  );
}

updateControlPageLayoutClass();

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
  outbound: ["sales_order", "transfer_order", "co_order", "vrma_order"].includes(localStorage.getItem("mbbs.control.loaded.outboundType"))
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

function photoImgAttributes(value) {
  const text = String(value || "");
  if (!text.startsWith("r2://")) return `src="${escapeHtml(text)}"`;
  return `data-secure-photo-ref="${escapeHtml(text)}"`;
}

function releaseSecurePhotoImage(image) {
  if (!image) return;
  image._securePhotoController?.abort();
  image._securePhotoController = null;
  if (image?._securePhotoObjectUrl) URL.revokeObjectURL(image._securePhotoObjectUrl);
  image._securePhotoObjectUrl = "";
}

function releaseSecurePhotoImages(root = app) {
  if (!root) return;
  const images = [
    ...(root.matches?.("img[data-secure-photo-ref]") ? [root] : []),
    ...root.querySelectorAll("img[data-secure-photo-ref]")
  ];
  images.forEach(releaseSecurePhotoImage);
}

async function hydrateSecurePhotoImage(image) {
  const ref = String(image?.dataset?.securePhotoRef || "");
  if (!ref || image.dataset.securePhotoState === "loading" || image.dataset.securePhotoState === "loaded") return;
  const controller = new AbortController();
  image._securePhotoController = controller;
  image.dataset.securePhotoState = "loading";
  try {
    const response = await fetch(`/api/photo-upload/preview?ref=${encodeURIComponent(ref)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Photo preview failed (${response.status})`);
    const objectUrl = URL.createObjectURL(await response.blob());
    if (!image.isConnected || image.dataset.securePhotoRef !== ref || controller.signal.aborted) {
      URL.revokeObjectURL(objectUrl);
      return;
    }
    image._securePhotoObjectUrl = objectUrl;
    image.dataset.securePhotoState = "loaded";
    const release = () => releaseSecurePhotoImage(image);
    image.addEventListener("load", release, { once: true });
    image.addEventListener("error", release, { once: true });
    image.src = objectUrl;
  } catch (error) {
    if (error.name !== "AbortError") {
      image.dataset.securePhotoState = "error";
      image.title = error.message;
    }
  } finally {
    if (image._securePhotoController === controller) image._securePhotoController = null;
  }
}

function hydrateSecurePhotoImages(root = app) {
  root?.querySelectorAll("img[data-secure-photo-ref]").forEach((image) => {
    hydrateSecurePhotoImage(image);
  });
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
  closePhotoLightbox();
  const modal = document.createElement("div");
  modal.className = "photo-lightbox";
  modal.innerHTML = `
    <div class="photo-lightbox-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(label)}">
      <button class="photo-lightbox-close" data-action="close-photo-lightbox" type="button">×</button>
      <img ${photoImgAttributes(ref)} alt="${escapeHtml(label)}" />
    </div>
  `;
  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target.closest("[data-action='close-photo-lightbox']")) closePhotoLightbox();
  });
  document.body.appendChild(modal);
  hydrateSecurePhotoImages(modal);
}

function closePhotoLightbox() {
  const modal = document.querySelector(".photo-lightbox");
  if (!modal) return;
  releaseSecurePhotoImages(modal);
  modal.remove();
}

function closeSalesOrderReloadDialog() {
  document.querySelector(".sales-order-reload-modal")?.remove();
}

function openSalesOrderReloadDialog(order, { cancel = false, cycle = null } = {}) {
  if (!order?.order_id) return;
  closeSalesOrderReloadDialog();
  const requestId = cancel ? "" : crypto.randomUUID();
  const modal = document.createElement("div");
  modal.className = "photo-lightbox sales-order-reload-modal";
  modal.innerHTML = `
    <form class="photo-lightbox-panel sales-order-reload-panel" role="dialog" aria-modal="true" aria-label="${cancel ? "Cancel Re-load" : "Authorize Re-load"}">
      <button class="photo-lightbox-close" data-action="close-sales-order-reload" type="button">×</button>
      <h2>${cancel ? "Cancel Re-load" : "Authorize Re-load"}</h2>
      <p><strong>${escapeHtml(order.tranid || order.order_id)}</strong> · ${escapeHtml(order.yard_location || "")}</p>
      <p class="muted">${cancel
        ? "Cancellation is allowed only before any Operator packing activity. Existing load records remain unchanged."
        : "Exactly the currently loaded local quantities will be offered again. This is local-only: it does not create a NetSuite fulfillment or change Dispatch."}</p>
      <label>
        <span>Re-load reason</span>
        <textarea name="reason" maxlength="500" rows="4" required placeholder="Describe why this order must be packed and loaded again"></textarea>
      </label>
      <div class="loaded-filter-actions">
        <button data-action="close-sales-order-reload" type="button">${t("common.cancel", "Cancel")}</button>
        <button class="primary" type="submit">${cancel ? "Cancel Re-load" : "Authorize Re-load"}</button>
      </div>
    </form>
  `;
  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target.closest("[data-action='close-sales-order-reload']")) {
      closeSalesOrderReloadDialog();
    }
  });
  modal.querySelector("form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const reason = String(new FormData(form).get("reason") || "").trim();
    if (!reason) return;
    const submit = form.querySelector("button[type='submit']");
    if (submit) submit.disabled = true;
    try {
      const base = `/api/control/sales-orders/${encodeURIComponent(order.order_id)}/reload-cycles`;
      await request(cancel ? `${base}/${encodeURIComponent(cycle?.id)}/cancel` : base, {
        method: "POST",
        body: JSON.stringify(cancel ? { reason } : { reason, requestId })
      });
      closeSalesOrderReloadDialog();
      await loadLoadedOrders({ keepSelection: true });
      if (isLoadedSearchActive()) await loadLoadedSearchResults();
      render();
    } catch (error) {
      if (submit) submit.disabled = false;
      alert(error.message);
    }
  });
  document.body.appendChild(modal);
  modal.querySelector("textarea")?.focus();
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

function scmReconciliationBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string") return ["1", "true", "yes", "on", "enabled"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function normalizeScmReconciliationOrderRefs(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values
    .flatMap((entry) => String(entry || "").split(/[,\r\n]+/))
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean))];
}

function scmReconciliationOrderRefsPreview(orderRefs = [], limit = 4) {
  const refs = normalizeScmReconciliationOrderRefs(orderRefs);
  if (!refs.length) return "";
  const visible = refs.slice(0, Math.max(1, Number(limit) || 4));
  return `${visible.join(", ")}${refs.length > visible.length ? ` +${refs.length - visible.length} more` : ""}`;
}

function normalizeScmReconciliationSettings(payload) {
  const settings = payload?.settings && typeof payload.settings === "object" ? payload.settings : (payload || {});
  return {
    ...SCM_RECONCILIATION_DEFAULT_SETTINGS,
    ...settings,
    nightlyEnabled: scmReconciliationBoolean(
      firstDefined(settings, ["nightlyEnabled", "nightly_enabled"], SCM_RECONCILIATION_DEFAULT_SETTINGS.nightlyEnabled),
      SCM_RECONCILIATION_DEFAULT_SETTINGS.nightlyEnabled
    ),
    nightlyTime: String(firstDefined(settings, ["nightlyTime", "nightly_time"], SCM_RECONCILIATION_DEFAULT_SETTINGS.nightlyTime)),
    timeZone: String(firstDefined(settings, ["timeZone", "timezone", "time_zone"], SCM_RECONCILIATION_TIME_ZONE)),
    initialBackfillSince: String(firstDefined(
      settings,
      [
        "initialBackfillSince",
        "initial_backfill_since",
        "initialBackfillModifiedSince",
        "initial_backfill_modified_since"
      ],
      SCM_RECONCILIATION_DEFAULT_SETTINGS.initialBackfillSince
    )),
    initialDryRunApproved: scmReconciliationBoolean(firstDefined(settings, [
      "initialDryRunApproved",
      "initial_dry_run_approved",
      "initialDryRunApplied",
      "initial_dry_run_applied"
    ], false)),
    soInitialDryRunApproved: scmReconciliationBoolean(firstDefined(settings, [
      "soInitialDryRunApproved",
      "so_initial_dry_run_approved"
    ], false))
  };
}

function normalizeScmReconciliationRuns(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.runs)) return payload.runs;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function scmReconciliationRunStatus(run) {
  return String(firstDefined(run, ["status", "runStatus", "run_status"], "unknown"))
    .trim()
    .toLowerCase()
    .replaceAll(" ", "_")
    .replaceAll("-", "_");
}

function scmReconciliationRunIsActive(run) {
  return ["queued", "waiting", "running", "processing", "applying"].includes(scmReconciliationRunStatus(run));
}

function scmReconciliationRunCanResume(run) {
  const explicit = firstDefined(run, ["resumeAllowed", "resume_allowed"], undefined);
  if (explicit !== undefined) return scmReconciliationBoolean(explicit);
  return scmReconciliationRunStatus(run) === "interrupted";
}

function scmReconciliationRunStopRequested(run) {
  return Boolean(firstDefined(run, [
    "cancelRequestedAt",
    "cancel_requested_at",
    "stopRequestedAt",
    "stop_requested_at"
  ], ""));
}

function setScmReconciliationSelectedRunId(runId) {
  scmReconciliationSelectedRunId = String(runId || "").trim();
  if (scmReconciliationSelectedRunId) {
    localStorage.setItem(SCM_RECONCILIATION_SELECTED_RUN_KEY, scmReconciliationSelectedRunId);
  } else {
    localStorage.removeItem(SCM_RECONCILIATION_SELECTED_RUN_KEY);
  }
  return scmReconciliationSelectedRunId;
}

function ensureScmReconciliationSelectedRun() {
  const selectedExists = scmReconciliationRuns.some((run) =>
    scmReconciliationRunId(run) === scmReconciliationSelectedRunId);
  if (selectedExists) return scmReconciliationSelectedRunId;
  return setScmReconciliationSelectedRunId(
    scmReconciliationRunId(scmReconciliationRuns[0] || {})
  );
}

function clearScmReconciliationPoll() {
  clearTimeout(scmReconciliationPollTimer);
  scmReconciliationPollTimer = null;
}

function scheduleScmReconciliationPoll() {
  clearScmReconciliationPoll();
  if (
    !IS_ADMIN_PAGE
    || !operator
    || activeSection !== "reconciliation"
    || !scmReconciliationRuns.some(scmReconciliationRunIsActive)
  ) return;
  scmReconciliationPollTimer = setTimeout(pollScmReconciliationRuns, 4000);
}

async function pollScmReconciliationRuns() {
  if (!operator) return;
  const previousSelectedRun = scmReconciliationRuns.find((run) =>
    scmReconciliationRunId(run) === scmReconciliationSelectedRunId);
  const previousSelectedWasActive = scmReconciliationRunIsActive(previousSelectedRun || {});
  try {
    const payload = await request("/api/control/scm-reconciliation/runs");
    scmReconciliationRuns = normalizeScmReconciliationRuns(payload);
    const selectedRunId = ensureScmReconciliationSelectedRun();
    const selectedRun = scmReconciliationRuns.find((run) =>
      scmReconciliationRunId(run) === selectedRunId);
    const selectedBecameTerminal = previousSelectedWasActive
      && selectedRun
      && !scmReconciliationRunIsActive(selectedRun);
    scmReconciliationLoadError = "";
    if (activeSection === "reconciliation") {
      if (selectedBecameTerminal) scmReconciliationRunDetails.delete(selectedRunId);
      if (selectedRunId && !scmReconciliationRunDetails.has(selectedRunId)) {
        await loadScmReconciliationRunDetails(selectedRunId);
      } else {
        render();
      }
    }
  } catch (error) {
    scmReconciliationLoadError = error.message;
    if (activeSection === "reconciliation") render();
  } finally {
    scheduleScmReconciliationPoll();
  }
}

async function loadScmReconciliationControl() {
  const [settingsResult, runsResult] = await Promise.allSettled([
    request("/api/control/scm-reconciliation/settings"),
    request("/api/control/scm-reconciliation/runs")
  ]);
  const errors = [];
  if (settingsResult.status === "fulfilled") {
    scmReconciliationSettings = normalizeScmReconciliationSettings(settingsResult.value);
    scmReconciliationSettingsLoaded = true;
  } else {
    scmReconciliationSettingsLoaded = false;
    errors.push(settingsResult.reason?.message || "Settings could not be loaded.");
  }
  if (runsResult.status === "fulfilled") {
    scmReconciliationRuns = normalizeScmReconciliationRuns(runsResult.value);
    ensureScmReconciliationSelectedRun();
  } else {
    errors.push(runsResult.reason?.message || "Run history could not be loaded.");
  }
  scmReconciliationLoadError = [...new Set(errors)].join(" ");
  if (
    activeSection === "reconciliation"
    && scmReconciliationSelectedRunId
    && !scmReconciliationRunDetails.has(scmReconciliationSelectedRunId)
  ) {
    await loadScmReconciliationRunDetails(scmReconciliationSelectedRunId);
  }
}

async function loadScmReconciliationRunDetails(runId, { append = false } = {}) {
  const id = String(runId || "").trim();
  if (!id) throw new Error("This reconciliation run is unavailable.");
  const existing = scmReconciliationRunDetails.get(id) || {
    loading: false,
    targets: [],
    targetCount: 0,
    hasMore: false,
    error: ""
  };
  const offset = append ? existing.targets.length : 0;
  scmReconciliationRunDetails.set(id, {
    ...existing,
    loading: true,
    error: ""
  });
  render();
  try {
    const payload = await request(
      `/api/scm/reconciliation/runs/${encodeURIComponent(id)}?limit=100&offset=${offset}`
    );
    const incoming = Array.isArray(payload?.targets) ? payload.targets : [];
    const targets = append
      ? [...existing.targets, ...incoming].filter((target, index, all) =>
          all.findIndex((candidate) => String(candidate.id) === String(target.id)) === index)
      : incoming;
    scmReconciliationRunDetails.set(id, {
      loading: false,
      targets,
      targetCount: Number(payload?.targetCount || targets.length),
      hasMore: payload?.hasMore === true,
      error: ""
    });
    if (payload?.run) {
      scmReconciliationRuns = scmReconciliationRuns.map((run) =>
        scmReconciliationRunId(run) === id ? payload.run : run);
    }
  } catch (error) {
    scmReconciliationRunDetails.set(id, {
      ...existing,
      loading: false,
      error: error.message
    });
  }
  render();
}

async function selectScmReconciliationRun(runId) {
  const id = String(runId || "").trim();
  if (!id) return;
  if (!scmReconciliationRuns.some((run) => scmReconciliationRunId(run) === id)) return;
  setScmReconciliationSelectedRunId(id);
  render();
  if (!scmReconciliationRunDetails.has(id)) {
    await loadScmReconciliationRunDetails(id);
  }
}

async function saveScmReconciliationSettings(form) {
  if (!scmReconciliationSettingsLoaded) {
    throw new Error("Reconciliation settings are not loaded. Refresh before saving.");
  }
  const nightlyEnabled = Boolean(form.elements.nightlyEnabled?.checked);
  const nightlyTime = String(form.elements.nightlyTime?.value || "").trim();
  const timeZone = String(form.elements.timeZone?.value || SCM_RECONCILIATION_TIME_ZONE).trim();
  const initialBackfillSince = String(form.elements.initialBackfillSince?.value || "").trim();
  if (!/^\d{2}:\d{2}$/.test(nightlyTime)) throw new Error("Enter a valid nightly start time.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(initialBackfillSince)) throw new Error("Enter a valid initial backfill date.");
  scmReconciliationBusy = true;
  render();
  try {
    const payload = await request("/api/control/scm-reconciliation/settings", {
      method: "PUT",
      body: JSON.stringify({
        nightlyEnabled,
        nightlyTime,
        timeZone,
        initialBackfillSince,
        initialBackfillModifiedSince: initialBackfillSince
      })
    });
    scmReconciliationSettings = normalizeScmReconciliationSettings(payload);
    scmReconciliationSettingsLoaded = true;
    scmReconciliationLoadError = "";
    alert("SO / PO / TO reconciliation settings saved.");
  } finally {
    scmReconciliationBusy = false;
    render();
  }
}

async function startScmReconciliationRun(form) {
  const scope = String(form.elements.scope?.value || "all");
  if (!["all", "SO", "PO", "TO", "order_family"].includes(scope)) throw new Error("Choose a valid reconciliation scope.");
  const broadSoScope = scope === "all" || scope === "SO";
  const soOrderType = String(
    form.elements.soOrderType?.value || scmReconciliationSoOrderType || "delivery"
  ).toLowerCase();
  if (broadSoScope && !["delivery", "pickup"].includes(soOrderType)) {
    throw new Error("Choose Delivery or Pick-Up for the Sales Order filter.");
  }
  const orderKind = String(form.elements.orderKind?.value || scmReconciliationOrderKind || "PO").toUpperCase();
  const orderRefs = normalizeScmReconciliationOrderRefs(form.elements.orderRefs?.value || "");
  if (scope === "order_family" && !["SO", "PO", "TO"].includes(orderKind)) throw new Error("Choose SO, PO, or TO for the targeted order families.");
  if (scope === "order_family" && !orderRefs.length) throw new Error("Enter at least one source SO, PO, or TO reference.");
  const includeTerminalOrders = scope !== "order_family"
    && Boolean(form.elements.includeTerminalOrders?.checked);
  const scopeApproved = broadSoScope
    ? scmReconciliationScopeApproved(scope, orderKind, soOrderType)
    : scmReconciliationScopeApproved(scope, orderKind);
  const forceInitialDryRun = !scopeApproved;
  const dryRun = forceInitialDryRun || Boolean(form.elements.dryRun?.checked);
  const soOrderTypeLabel = soOrderType === "pickup" ? "Pick-Up" : "Delivery";
  const targetSummary = scope === "order_family"
    ? `${orderRefs.length.toLocaleString()} ${orderKind} source order${orderRefs.length === 1 ? "" : "s"} (${scmReconciliationOrderRefsPreview(orderRefs)})`
    : scope === "all"
      ? `${soOrderTypeLabel} SO plus all PO / TO orders`
      : scope === "SO"
        ? `${soOrderTypeLabel} SO orders`
        : `${scope} orders`;
  if (!dryRun && !confirm(
    `Apply ${targetSummary} reconciliation changes immediately?`
    + `${includeTerminalOrders ? " This broad run includes locally terminal or skipped orders." : ""}`
    + ` Conflicts will still go to Reconcile Review.`
  )) return;
  const body = { scope, dryRun, includeTerminalOrders };
  if (broadSoScope) body.soOrderType = soOrderType;
  if (scope === "order_family") {
    body.orderKind = orderKind;
    body.orderRefs = orderRefs;
    body.orderRef = orderRefs.join(", ");
  }
  scmReconciliationScope = scope;
  if (broadSoScope) scmReconciliationSoOrderType = soOrderType;
  scmReconciliationOrderKind = orderKind;
  scmReconciliationOrderRef = orderRefs.join("\n");
  scmReconciliationIncludeTerminalOrders = includeTerminalOrders;
  scmReconciliationDryRun = dryRun;
  scmReconciliationBusy = true;
  render();
  try {
    const payload = await request("/api/control/scm-reconciliation/run", {
      method: "POST",
      body: JSON.stringify(body)
    });
    const run = payload?.run || payload;
    if (run && typeof run === "object" && scmReconciliationRunId(run)) {
      const runId = scmReconciliationRunId(run);
      scmReconciliationRuns = [
        run,
        ...scmReconciliationRuns.filter((item) => scmReconciliationRunId(item) !== runId)
      ];
      setScmReconciliationSelectedRunId(runId);
      scmReconciliationRunDetails.delete(runId);
      if (activeSection === "reconciliation") {
        await loadScmReconciliationRunDetails(runId);
      }
    } else {
      const runsPayload = await request("/api/control/scm-reconciliation/runs");
      scmReconciliationRuns = normalizeScmReconciliationRuns(runsPayload);
      ensureScmReconciliationSelectedRun();
    }
    scmReconciliationLoadError = "";
    alert(`${dryRun ? "Dry run" : "Reconciliation"} started.`);
  } finally {
    scmReconciliationBusy = false;
    render();
  }
}

function scmReconciliationTargetDecisionKey(runId, targetId) {
  return `${String(runId || "")}:${String(targetId || "")}`;
}

function scmReconciliationTargetDecisionControlId(runId, targetId) {
  return `scm-reconciliation-decision-${String(runId || "")}-${String(targetId || "")}`;
}

function updateScmReconciliationTargetDecisionDraft(container) {
  if (!container) return null;
  const runId = String(container.dataset.runId || "");
  const targetId = String(container.dataset.targetId || "");
  if (!runId || !targetId) return null;
  const draft = {
    decision: String(container.querySelector("[data-review-decision]")?.value || ""),
    note: String(container.querySelector("[data-review-decision-note]")?.value || "")
  };
  scmReconciliationDecisionDrafts.set(
    scmReconciliationTargetDecisionKey(runId, targetId),
    draft
  );
  return draft;
}

async function saveScmReconciliationTargetDecision(button) {
  const runId = String(button.dataset.runId || "");
  const targetId = String(button.dataset.targetId || "");
  const container = button.closest("[data-reconciliation-target-decision]");
  const draft = updateScmReconciliationTargetDecisionDraft(container) || {};
  const decision = String(draft.decision || "");
  const note = String(draft.note || "").trim();
  const decisionKey = scmReconciliationTargetDecisionKey(runId, targetId);
  const restoreSaveFocus = document.activeElement === button;
  if (!runId || !targetId) throw new Error("This reviewed order is unavailable. Refresh and try again.");
  if (scmReconciliationDecisionBusyTargets.has(decisionKey)) return;
  if (!["accept_current", "skip", "keep_review"].includes(decision)) {
    throw new Error("Choose an action for this reviewed order.");
  }
  if (["accept_current", "skip"].includes(decision) && !note) {
    throw new Error("Enter an audit note before accepting or skipping this order.");
  }
  scmReconciliationDecisionBusyTargets.add(decisionKey);
  render();
  try {
    const payload = await request(
      `/api/control/scm-reconciliation/runs/${encodeURIComponent(runId)}`
        + `/targets/${encodeURIComponent(targetId)}/decision`,
      {
        method: "PUT",
        body: JSON.stringify({
          decision,
          note,
          expectedUpdatedAt: button.dataset.targetUpdatedAt || ""
        })
      }
    );
    const detail = scmReconciliationRunDetails.get(runId);
    if (detail && payload?.target) {
      scmReconciliationRunDetails.set(runId, {
        ...detail,
        targets: detail.targets.map((target) =>
          String(target.id) === targetId ? payload.target : target)
      });
    }
    if (payload?.decisionSummary) {
      scmReconciliationRuns = scmReconciliationRuns.map((run) =>
        scmReconciliationRunId(run) === runId
          ? { ...run, reviewDecisionSummary: payload.decisionSummary }
          : run);
    }
    scmReconciliationDecisionDrafts.delete(decisionKey);
  } finally {
    scmReconciliationDecisionBusyTargets.delete(decisionKey);
    render();
    if (
      restoreSaveFocus
      && (!document.activeElement || document.activeElement === document.body)
    ) {
      document
        .getElementById(`${scmReconciliationTargetDecisionControlId(runId, targetId)}-save`)
        ?.focus({ preventScroll: true });
    }
  }
}

async function applyScmReconciliationRun(runId) {
  const run = scmReconciliationRuns.find((item) => scmReconciliationRunId(item) === String(runId));
  if (!run) throw new Error("This reconciliation run is no longer available. Refresh and try again.");
  if (!scmReconciliationRunCanApply(run)) throw new Error("This dry run is not ready to apply.");
  const pendingDecisions = scmReconciliationRunPendingDecisions(run);
  if (pendingDecisions > 0) {
    throw new Error(
      `Choose an action for all reviewed orders before applying.`
      + ` ${pendingDecisions.toLocaleString()} decision(s) remain.`
    );
  }
  if (scmReconciliationRuns.some(scmReconciliationRunIsActive)) {
    throw new Error("Wait for the active reconciliation run to finish before applying a dry run.");
  }
  const scope = String(firstDefined(run, ["scope"], "all")).toUpperCase();
  const decisions = scmReconciliationRunDecisionSummary(run);
  const reviewOrders = scmReconciliationRunReviewCount(run);
  if (!confirm(
    `Apply the ${scope} scope proposed by dry run #${runId}?\n\n`
    + `This starts a fresh live reconciliation against current NetSuite data; it does not write the stored snapshot directly.`
    + `${reviewOrders ? ` The dry run found ${reviewOrders.toLocaleString()} conflict order(s).` : ""}`
    + `${Number(decisions.acceptedTargets || 0) ? ` ${Number(decisions.acceptedTargets).toLocaleString()} NetSuite outcome(s) will be accepted only if their evidence is unchanged.` : ""}`
    + `${Number(decisions.skippedTargets || 0) ? ` ${Number(decisions.skippedTargets).toLocaleString()} order(s) will be skipped.` : ""}`
    + `${Number(decisions.keptReviewTargets || 0) ? ` ${Number(decisions.keptReviewTargets).toLocaleString()} order(s) will remain in Review if their conflict is confirmed.` : ""}`
    + `\n\nThis updates only local SO / PO / TO operational state and never writes back to NetSuite.`
  )) return;
  scmReconciliationBusy = true;
  render();
  try {
    const payload = await request(`/api/control/scm-reconciliation/runs/${encodeURIComponent(runId)}/apply`, {
      method: "POST",
      body: "{}"
    });
    await loadScmReconciliationControl();
    if (payload?.pending === true) {
      alert(`Applying reconciliation run #${runId}. Progress will update in the run history.`);
    } else {
      alert(`Reconciliation run #${runId} was applied.`);
    }
  } finally {
    scmReconciliationBusy = false;
    render();
  }
}

async function stopScmReconciliationRun(runId) {
  const id = String(runId || "").trim();
  const run = scmReconciliationRuns.find((item) => scmReconciliationRunId(item) === id);
  if (!run || !scmReconciliationRunIsActive(run)) {
    throw new Error("This reconciliation run is no longer active. Refresh and try again.");
  }
  if (!confirm(
    `Stop reconciliation run #${id}?`
    + ` The worker will preserve its recorded progress and stop before continuing when safe.`
  )) return;
  scmReconciliationBusy = true;
  render();
  try {
    await request(`/api/control/scm-reconciliation/runs/${encodeURIComponent(id)}/stop`, {
      method: "POST",
      body: "{}"
    });
    await loadScmReconciliationControl();
    alert(`Stop requested for reconciliation run #${id}.`);
  } finally {
    scmReconciliationBusy = false;
    render();
  }
}

async function resumeScmReconciliationRun(runId) {
  const id = String(runId || "").trim();
  const run = scmReconciliationRuns.find((item) => scmReconciliationRunId(item) === id);
  if (!run || !scmReconciliationRunCanResume(run)) {
    throw new Error("This reconciliation run cannot be resumed. Refresh and try again.");
  }
  if (scmReconciliationRuns.some(scmReconciliationRunIsActive)) {
    throw new Error("Wait for the active reconciliation run to finish before resuming this one.");
  }
  if (!confirm(
    `Resume reconciliation run #${id}?`
    + ` Completed, reviewed, and skipped orders will remain untouched.`
    + ` Only unfinished orders will continue; the request that was in flight will be repeated.`
  )) return;
  scmReconciliationBusy = true;
  render();
  try {
    const payload = await request(
      `/api/control/scm-reconciliation/runs/${encodeURIComponent(id)}/resume`,
      { method: "POST", body: "{}" }
    );
    const resumed = payload?.run || payload;
    if (resumed && scmReconciliationRunId(resumed)) {
      scmReconciliationRuns = scmReconciliationRuns.map((item) =>
        scmReconciliationRunId(item) === id ? resumed : item);
      setScmReconciliationSelectedRunId(id);
      scmReconciliationRunDetails.delete(id);
      await loadScmReconciliationRunDetails(id);
    } else {
      await loadScmReconciliationControl();
    }
    alert(`Reconciliation run #${id} is resuming from its saved order progress.`);
  } finally {
    scmReconciliationBusy = false;
    render();
    scheduleScmReconciliationPoll();
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
  clearScmReconciliationPoll();
  clearPhotoArchivePoll();
  releaseSecurePhotoImages(app);
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

function captureControlScrollPositions() {
  return [...app.querySelectorAll("[data-control-scroll]")].map((element) => ({
    key: element.dataset.controlScroll,
    left: element.scrollLeft,
    top: element.scrollTop
  }));
}

function restoreControlScrollPositions(positions) {
  for (const position of positions || []) {
    const element = app.querySelector(
      `[data-control-scroll="${controlCssAttr(position.key)}"]`
    );
    if (!element) continue;
    element.scrollLeft = position.left;
    element.scrollTop = position.top;
  }
}

function render() {
  if (!operator) return renderLogin();
  const focusState = captureControlFocus();
  const scrollPositions = captureControlScrollPositions();
  releaseSecurePhotoImages(app);
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
  restoreControlScrollPositions(scrollPositions);
  hydrateSecurePhotoImages(app);
  schedulePhotoArchivePoll();
  scheduleSyncPoll();
  scheduleScmReconciliationPoll();
}

function renderActiveSection() {
  activeSection = normalizedSection(activeSection);
  if (activeSection === "operators") return renderOperatorsSection();
  if (activeSection === "returns") return renderReturnManagementSection();
  if (activeSection === "return-automation") return renderReturnAutomationSection();
  if (activeSection === "locks") return renderLocksSection();
  if (activeSection === "classification") return renderClassificationSection();
  if (activeSection === "vendor-mapping") return renderVendorMappingSection();
  if (activeSection === "storage") return renderStorageSection();
  if (activeSection === "reconciliation") return renderScmReconciliationSection();
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
    const automationYards = adminReturnSettings.filter((yard) =>
      yard.autoCreateStockReturnAuthorization || yard.autoCreatePalletCreditMemo
    ).length;
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
        <button class="metric-card" data-action="control-section" data-section="return-automation" type="button">
          <span>Return Automation</span>
          <strong>${automationYards} / ${SALES_YARD_OPTIONS.length}</strong>
          <em>yards with at least one NetSuite automation enabled</em>
        </button>
        <button class="metric-card" onclick="location.href='/admin/printers'" type="button">
          <span>Yard Printers</span>
          <strong>Setup</strong>
          <em>printer agents, queues, tests, and print jobs</em>
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
        <p class="muted">Manage application access, NetSuite synchronization, yard printers, photo storage, and security audit history. Yard operations remain under Control.</p>
        <div class="actions"><button onclick="location.href='/control'">Open Control</button></div>
      </section>
    `;
  }
  const classified = classifications.filter((item) => item.product_type || item.brand || item.series).length;
  const openWarnings = recordWarnings.filter((item) => item.status === "open").length;
  const pendingReturns = Number(
    returnDashboardCounts.pendingApproval ?? returnDashboardCounts.pending_approval ?? 0
  ) + Number(
    returnDashboardCounts.partiallyPending ?? returnDashboardCounts.partially_pending ?? 0
  );
  return `
    <div class="dashboard-grid">
      <button class="metric-card ${pendingReturns ? "warning" : ""}" data-action="control-section" data-section="returns" type="button">
        <span>Return Management</span>
        <strong>${pendingReturns}</strong>
        <em>return records awaiting approval</em>
      </button>
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
        <span>${t("control.loadedExport", "In/Outbound Record")}</span>
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

function firstDefined(object, keys, fallback = "") {
  for (const key of keys) {
    if (object?.[key] !== undefined && object?.[key] !== null) return object[key];
  }
  if (object?.payload && typeof object.payload === "object") {
    for (const key of keys) {
      if (object.payload[key] !== undefined && object.payload[key] !== null) return object.payload[key];
    }
  }
  return fallback;
}

function returnRecordId(record) {
  return String(firstDefined(record, ["id", "returnId", "return_id"], ""));
}

function returnReference(record) {
  if (record?.draftId || record?.draft_id) {
    return `Draft ${String(record.draftId || record.draft_id).slice(0, 8).toUpperCase()}`;
  }
  return String(firstDefined(record, [
    "reference",
    "returnReference",
    "return_reference",
    "localReference",
    "local_reference",
    "stockReturnReference",
    "stock_return_reference",
    "palletReturnReference",
    "pallet_return_reference"
  ], returnRecordId(record) ? `Return #${returnRecordId(record)}` : "Return"));
}

function returnStatus(record) {
  if (record?.draftId || record?.draft_id) return "draft";
  const syncStatus = String(firstDefined(record, ["netSuiteSyncStatus", "netsuite_sync_status"], "")).toLowerCase();
  if (syncStatus === "failed") {
    return returnType(record) === "pallet" ? "credit_memo_creation_failed" : "ra_creation_failed";
  }
  return String(firstDefined(record, ["status", "returnStatus", "return_status", "approvalStatus", "approval_status"], "unknown"))
    .trim()
    .toLowerCase()
    .replaceAll(" ", "_")
    .replaceAll("-", "_");
}

function returnType(record) {
  const recordType = String(firstDefined(record, ["returnType", "return_type", "recordType", "record_type", "type"], "stock")).trim().toLowerCase();
  const stockType = String(firstDefined(record, ["stockReturnType", "stock_return_type"], "")).trim().toLowerCase();
  if (recordType.includes("pallet")) return "pallet";
  if (recordType.includes("combined")) return stockType.includes("quality") ? "combined_quality" : "combined_normal";
  if (stockType.includes("quality") || recordType.includes("quality")) return "quality_stock";
  if (stockType.includes("normal") || recordType.includes("normal") || recordType.includes("good")) return "normal_stock";
  return recordType || "stock";
}

function returnTypeLabel(record) {
  const type = returnType(record);
  if (type === "pallet") return "PALLET Return";
  if (type === "quality_stock") return "Quality Stock Return";
  if (type === "normal_stock") return "Normal Stock Return";
  if (type === "combined_quality") return "Combined Quality Stock + PALLET Draft";
  if (type === "combined_normal") return "Combined Normal Stock + PALLET Draft";
  return String(type || "Stock Return").replaceAll("_", " ");
}

function returnStatusLabel(value) {
  const clean = typeof value === "string" ? value : returnStatus(value);
  const labels = {
    accepted: "Accepted",
    pending_approval: "Pending Approval",
    partially_pending: "Partially Pending Approval",
    partially_pending_approval: "Partially Pending Approval",
    approved: "Approved",
    rejected: "Rejected",
    partially_rejected: "Partially Rejected",
    voided: "Voided",
    draft: "Draft",
    ra_creation_failed: "RA Creation Failed",
    credit_memo_creation_failed: "Credit Memo Creation Failed",
    sync_failed: "NetSuite Sync Failed",
    synced: "Synced",
    linked: "Linked",
    not_required: "Accepted"
  };
  return labels[clean] || String(clean || "Unknown").replaceAll("_", " ");
}

function returnStatusPill(recordOrStatus) {
  const status = typeof recordOrStatus === "string" ? recordOrStatus : returnStatus(recordOrStatus);
  return `<span class="return-status-pill ${escapeHtml(status)}">${escapeHtml(returnStatusLabel(status))}</span>`;
}

function returnMoney(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(number);
}

function returnYard(record, prefix) {
  const code = firstDefined(record, [
    `${prefix}YardCode`,
    `${prefix}_yard_code`,
    `${prefix}LocationName`,
    `${prefix}_location_name`,
    prefix === "receiving" ? "yardCode" : "",
    prefix === "receiving" ? "yard_code" : ""
  ].filter(Boolean), "");
  const id = firstDefined(record, [
    `${prefix}YardLocationId`,
    `${prefix}_yard_location_id`,
    `${prefix}LocationId`,
    `${prefix}_location_id`,
    prefix === "receiving" ? "yardLocationId" : "",
    prefix === "receiving" ? "yard_location_id" : ""
  ].filter(Boolean), "");
  return String(code || SALES_YARD_OPTIONS.find((yard) => Number(yard.locationId) === Number(id))?.yardCode || id || "—");
}

function returnPhotoRef(photo) {
  if (typeof photo === "string") return photo;
  return String(firstDefined(photo, [
    "photoDataUrl",
    "photo_data_url",
    "reference",
    "photoReference",
    "photo_reference",
    "storageRef",
    "storage_ref",
    "objectRef",
    "object_ref",
    "url"
  ], ""));
}

function returnLines(detail = returnDetail) {
  return detail?.lines || detail?.returnLines || detail?.return_lines || detail?.return?.lines || detail?.payload?.lines || [];
}

function returnPhotos(detail = returnDetail) {
  const header = returnHeader(detail);
  if (returnStatus(header) === "draft") {
    return [
      ...(detail?.photos || []),
      ...(detail?.palletPhotos || detail?.pallet_photos || []),
      ...(detail?.payload?.photos || []),
      ...(detail?.payload?.palletPhotos || detail?.payload?.pallet_photos || [])
    ].filter((photo, index, all) =>
      all.findIndex((candidate) => returnPhotoRef(candidate) === returnPhotoRef(photo)) === index);
  }
  return detail?.photos
    || detail?.returnPhotos
    || detail?.return_photos
    || detail?.return?.photos
    || [...(detail?.payload?.photos || []), ...(detail?.payload?.palletPhotos || [])];
}

function returnLinks(detail = returnDetail) {
  const header = returnHeader(detail);
  const links = [...(detail?.netSuiteLinks || detail?.netsuiteLinks || detail?.net_suite_links || detail?.links || [])];
  const transactionId = firstDefined(header, ["netSuiteTransactionId", "netsuite_transaction_id"], "");
  const transactionRef = firstDefined(header, ["netSuiteTransactionRef", "netsuite_transaction_ref"], "");
  if ((transactionId || transactionRef) && !links.some((link) =>
    String(firstDefined(link, ["netsuiteId", "netsuite_id", "internalId", "internal_id"], "")) === String(transactionId))) {
    links.push({
      transactionType: firstDefined(header, ["netSuiteStage", "netsuite_stage"], "transaction"),
      netsuiteId: transactionId,
      netsuiteTranid: transactionRef,
      status: firstDefined(header, ["netSuiteTransactionStatus", "netsuite_transaction_status"], "")
    });
  }
  const snapshot = header.netSuiteSnapshot || header.netsuite_snapshot || detail?.netSuiteSnapshot || detail?.netsuite_snapshot || {};
  for (const credit of snapshot.creditMemos || snapshot.credit_memos || []) {
    const id = credit.id || credit.internalId || credit.internal_id || "";
    if (links.some((link) =>
      String(firstDefined(link, ["netsuiteId", "netsuite_id", "internalId", "internal_id"], "")) === String(id))) continue;
    links.push({
      transactionType: "credit_memo",
      netsuiteId: id,
      netsuiteTranid: credit.tranid || credit.tranId || "",
      status: credit.statusText || credit.status_text || credit.status || ""
    });
  }
  return links;
}

function returnHeader(detail = returnDetail) {
  const header = detail?.return || detail?.record || detail?.header || detail || {};
  if (header?.draftId || header?.draft_id) {
    return {
      ...(header.payload || {}),
      ...header,
      status: "draft"
    };
  }
  return header;
}

function saveReturnFilters() {
  localStorage.setItem("mbbs.control.returns.search", returnFilters.search || "");
  localStorage.setItem("mbbs.control.returns.status", returnFilters.status || "");
  localStorage.setItem("mbbs.control.returns.type", returnFilters.type || "");
  localStorage.setItem("mbbs.control.returns.yard", returnFilters.yardLocationId || "");
  localStorage.setItem("mbbs.control.returns.from", returnFilters.from || "");
  localStorage.setItem("mbbs.control.returns.to", returnFilters.to || "");
}

function returnListQuery() {
  const params = new URLSearchParams({
    limit: String(RETURN_RECORD_PAGE_SIZE),
    offset: String(returnRecordOffset)
  });
  for (const [key, value] of Object.entries(returnFilters)) {
    if (String(value || "").trim()) params.set(key, String(value).trim());
  }
  return params;
}

function renderReturnPhotoGrid(photos, emptyLabel = "No photos attached") {
  const visible = (photos || []).filter((photo) => returnPhotoRef(photo));
  if (!visible.length) return `<div class="return-empty-photo">${escapeHtml(emptyLabel)}</div>`;
  return `<div class="return-photo-grid">${visible.map((photo, index) => {
    const ref = returnPhotoRef(photo);
    const label = firstDefined(photo, ["label", "caption", "kind", "photoKind", "photo_kind", "photoType", "photo_type"], `Return photo ${index + 1}`);
    return `<figure>
      <button class="photo-thumb-button" data-action="open-photo-lightbox" data-photo-ref="${escapeHtml(ref)}" data-photo-label="${escapeHtml(label)}" type="button">
        <img ${photoImgAttributes(ref)} alt="${escapeHtml(label)}" />
      </button>
      <figcaption>${escapeHtml(label)}${firstDefined(photo, ["createdAt", "created_at"], "") ? `<br>${formatDate(firstDefined(photo, ["createdAt", "created_at"]))}` : ""}</figcaption>
    </figure>`;
  }).join("")}</div>`;
}

function renderReturnRecordList() {
  if (returnLoadError) {
    return `<div class="notice sync-error"><strong>Return records could not be loaded</strong><span>${escapeHtml(returnLoadError)}</span></div>`;
  }
  if (!returnRecords.length) {
    return `<div class="return-empty"><strong>No return records</strong><span>No submitted return matches the selected filters.</span></div>`;
  }
  const cards = returnRecords.map((record) => {
    const id = returnRecordId(record);
    const sourceOrder = firstDefined(record, ["sourceSalesOrderRef", "source_sales_order_ref", "sourceOrderTranid", "source_order_tranid", "salesOrderTranid", "sales_order_tranid"], "");
    const customer = firstDefined(record, ["customerName", "customer_name", "customerCode", "customer_code"], "");
    const submittedAt = firstDefined(record, ["submittedAt", "submitted_at", "createdAt", "created_at"], "");
    const batch = firstDefined(record, ["batchReference", "batch_reference"], "");
    return `<button class="return-list-card ${id === String(selectedReturnId) ? "active" : ""}" data-action="select-return-record" data-id="${escapeHtml(id)}" type="button">
      <span class="return-card-head"><strong>${escapeHtml(returnReference(record))}</strong>${returnStatusPill(record)}</span>
      <span>${escapeHtml(returnTypeLabel(record))}${batch ? ` · ${escapeHtml(batch)}` : ""}</span>
      <span>${escapeHtml([sourceOrder, customer].filter(Boolean).join(" · ") || "Customer-level return")}</span>
      <small>${escapeHtml(returnYard(record, "receiving"))} · ${formatDate(submittedAt)}</small>
    </button>`;
  }).join("");
  const total = Number(returnCounts.total);
  const hasNext = Number.isFinite(total)
    ? returnRecordOffset + returnRecords.length < total
    : returnRecords.length === RETURN_RECORD_PAGE_SIZE;
  return `${cards}
    <div class="pagination-row">
      <button data-action="return-page-prev" ${returnRecordOffset <= 0 ? "disabled" : ""} type="button">Previous</button>
      <span>${returnRecordOffset + 1}–${returnRecordOffset + returnRecords.length}${Number.isFinite(total) ? ` of ${total}` : ""}</span>
      <button data-action="return-page-next" ${hasNext ? "" : "disabled"} type="button">Next</button>
    </div>`;
}

function renderReturnLineDecisionActions(line) {
  if (returnStatus(returnHeader()) === "draft") return "";
  const status = returnStatus(line);
  const policy = String(firstDefined(line, [
    "returnPolicyEffective",
    "return_policy_effective",
    "policySnapshot",
    "policy_snapshot"
  ], "")).toLowerCase();
  const needsDecision = ["pending", "pending_approval", "approval_required"].includes(status)
    || (policy.includes("approval") && !["approved", "accepted", "rejected", "voided"].includes(status));
  if (!needsDecision) return "";
  const lineId = String(firstDefined(line, ["id", "lineId", "line_id"], ""));
  if (!lineId) return "";
  return `<div class="return-line-actions">
    <button class="primary" data-action="decide-return-line" data-decision="approved" data-line-id="${escapeHtml(lineId)}" type="button">Approve</button>
    <button class="danger" data-action="decide-return-line" data-decision="rejected" data-line-id="${escapeHtml(lineId)}" type="button">Reject</button>
  </div>`;
}

function renderReturnLine(line, index) {
  const item = firstDefined(line, ["itemName", "item_name", "sku", "itemId", "item_id"], `Line ${index + 1}`);
  const description = firstDefined(line, ["description", "itemDescription", "item_description"], "");
  const salesQuantity = firstDefined(line, ["returnedSalesQuantity", "returned_sales_quantity", "salesQuantity", "sales_quantity", "quantity"], "");
  const salesUom = firstDefined(line, ["salesUom", "sales_uom", "uom"], "");
  const physical = [
    ["PLT", firstDefined(line, ["pallets", "returnedPallets", "returned_pallets", "palletQuantity", "pallet_quantity", "plt"], 0)],
    ["LYR", firstDefined(line, ["layers", "returnedLayers", "returned_layers", "layerQuantity", "layer_quantity", "lyr"], 0)],
    ["SEC", firstDefined(line, ["sections", "returnedSections", "returned_sections", "sectionQuantity", "section_quantity", "sec"], 0)],
    ["PCS", firstDefined(line, ["pieces", "returnedPieces", "returned_pieces", "pieceQuantity", "piece_quantity", "pcs"], 0)]
  ].filter(([, value]) => Number(value) > 0).map(([unit, value]) => `${value} ${unit}`).join(" + ");
  const reason = firstDefined(line, ["reasonLabel", "reason_label", "reasonCodeLabel", "reason_code_label"], "");
  const note = firstDefined(line, ["note", "reasonNote", "reason_note"], "");
  const decisionNote = firstDefined(line, ["approvalNote", "approval_note", "decisionNote", "decision_note"], "");
  const decidedAt = firstDefined(line, ["decidedAt", "decided_at"], "");
  const policy = firstDefined(line, ["returnPolicyEffective", "return_policy_effective", "policySnapshot", "policy_snapshot"], "");
  const estimatedCredit = firstDefined(line, [
    "estimatedCreditAmount",
    "estimated_credit_amount",
    "estimatedCredit",
    "estimated_credit"
  ], null);
  const linePhotos = line.photos || line.returnPhotos || line.return_photos || [];
  return `<article class="return-line-card">
    <div class="return-line-heading">
      <div><strong>${escapeHtml(item)}</strong>${description ? `<span>${escapeHtml(description)}</span>` : ""}</div>
      ${returnStatusPill(returnStatus(line))}
    </div>
    <div class="return-line-facts">
      <span><small>Returned</small><strong>${escapeHtml(physical || `${salesQuantity} ${salesUom}`.trim() || "—")}</strong></span>
      <span><small>Sales quantity</small><strong>${escapeHtml(`${salesQuantity} ${salesUom}`.trim() || "—")}</strong></span>
      <span><small>Reason</small><strong>${escapeHtml(reason || "—")}</strong></span>
      <span><small>Policy snapshot</small><strong>${escapeHtml(String(policy || "—").replaceAll("_", " "))}</strong></span>
      <span><small>Estimated credit</small><strong>${returnMoney(estimatedCredit)}</strong></span>
    </div>
    ${note ? `<p class="return-note">${escapeHtml(note)}</p>` : ""}
    ${decisionNote ? `<p class="return-note"><strong>${returnStatus(line) === "rejected" ? "Rejection reason" : "Approval note"}:</strong> ${escapeHtml(decisionNote)}${decidedAt ? ` · ${formatDate(decidedAt)}` : ""}</p>` : ""}
    ${renderReturnPhotoGrid(linePhotos, "No line photos")}
    ${renderReturnLineDecisionActions(line)}
  </article>`;
}

function renderReturnLinks(links, header) {
  const normalized = [...(links || [])];
  const headerRa = firstDefined(header, ["netSuiteRaTranid", "netsuite_ra_tranid", "raTranid", "ra_tranid"], "");
  const headerCm = firstDefined(header, ["netSuiteCreditMemoTranid", "netsuite_credit_memo_tranid", "creditMemoTranid", "credit_memo_tranid"], "");
  const headerTransaction = firstDefined(header, ["netSuiteTransactionRef", "netsuite_transaction_ref"], "");
  const headerTransactionId = firstDefined(header, ["netSuiteTransactionId", "netsuite_transaction_id"], "");
  const headerStage = firstDefined(header, ["netSuiteStage", "netsuite_stage"], "");
  if (headerRa && !normalized.some((link) => String(firstDefined(link, ["transactionType", "transaction_type"], "")).includes("authorization"))) {
    normalized.push({ transactionType: "return_authorization", netsuiteTranid: headerRa });
  }
  if (headerCm && !normalized.some((link) => String(firstDefined(link, ["transactionType", "transaction_type"], "")).includes("credit"))) {
    normalized.push({ transactionType: "credit_memo", netsuiteTranid: headerCm });
  }
  if ((headerTransaction || headerTransactionId) && !normalized.length) {
    normalized.push({
      transactionType: headerStage || "transaction",
      netsuiteTranid: headerTransaction,
      netsuiteId: headerTransactionId,
      status: firstDefined(header, ["netSuiteTransactionStatus", "netsuite_transaction_status"], "")
    });
  }
  if (!normalized.length) return `<span class="muted">No NetSuite transaction linked.</span>`;
  return `<div class="return-link-list">${normalized.map((link) => {
    const type = String(firstDefined(link, ["transactionType", "transaction_type", "type"], "transaction")).replaceAll("_", " ");
    const tranid = firstDefined(link, ["netsuiteTranid", "netsuite_tranid", "tranid", "transactionNumber"], "");
    const id = firstDefined(link, ["netsuiteId", "netsuite_id", "internalId", "internal_id"], "");
    const status = firstDefined(link, ["status", "transactionStatus", "transaction_status"], "");
    return `<span><strong>${escapeHtml(type)}</strong> ${escapeHtml(tranid || `Internal ID ${id}`)}${status ? ` · ${escapeHtml(status)}` : ""}</span>`;
  }).join("")}</div>`;
}

function renderReturnDetail() {
  if (!returnDetail) {
    return `<div class="return-empty return-detail-empty"><strong>Select a return record</strong><span>Quantities, approval status, photos, financial estimates, and NetSuite reconciliation will appear here.</span></div>`;
  }
  const header = returnHeader();
  const id = returnRecordId(header) || String(selectedReturnId);
  const lines = returnLines();
  const photos = returnPhotos();
  const status = returnStatus(header);
  const batch = firstDefined(header, ["batchReference", "batch_reference"], "");
  const sourceOrder = firstDefined(header, ["sourceSalesOrderRef", "source_sales_order_ref", "sourceOrderTranid", "source_order_tranid", "salesOrderTranid", "sales_order_tranid"], "");
  const customer = [
    firstDefined(header, ["customerCode", "customer_code"], ""),
    firstDefined(header, ["customerName", "customer_name"], "")
  ].filter(Boolean).join(" · ");
  const vehiclePlate = firstDefined(header, ["vehiclePlate", "vehicle_plate"], "");
  const orderingYard = returnYard(header, "ordering");
  const receivingYard = returnYard(header, "receiving");
  const estimated = firstDefined(header, ["estimatedCreditAmount", "estimated_credit_amount", "estimatedCredit", "estimated_credit"], null);
  const actual = firstDefined(header, ["actualCreditAmount", "actual_credit_amount", "actualCredit", "actual_credit"], null);
  const submittedAt = firstDefined(header, ["submittedAt", "submitted_at", "createdAt", "created_at"], "");
  const submittedBy = firstDefined(header, ["operatorName", "operator_name", "submittedByName", "submitted_by_name"], "");
  const syncError = firstDefined(header, ["netSuiteSyncError", "netsuite_sync_error", "syncError", "sync_error", "netSuiteError", "netsuite_error"], "");
  const syncStatus = String(firstDefined(header, ["netSuiteSyncStatus", "netsuite_sync_status"], "")).toLowerCase();
  const note = firstDefined(header, ["note", "returnNote", "return_note"], "");
  const palletQuantity = firstDefined(header, ["palletQuantity", "pallet_quantity"], null);
  const canVoid = !["voided", "draft"].includes(status);
  const canRetry = hasStaffAuthority(operator, ["admin"])
    && syncStatus === "failed";
  const isDraft = status === "draft";
  return `<div class="return-detail">
    <div class="return-detail-head">
      <div>
        <div class="return-title-row"><h3>${escapeHtml(returnReference(header))}</h3>${returnStatusPill(header)}</div>
        <p>${escapeHtml(returnTypeLabel(header))}${batch ? ` · ${escapeHtml(batch)}` : ""}</p>
      </div>
      <div class="return-detail-actions">
        ${isDraft ? `<button class="danger" data-action="discard-return-draft" data-id="${escapeHtml(id)}" type="button">Discard Draft</button>` : ""}
        ${canRetry ? `<button data-action="retry-return-sync" data-id="${escapeHtml(id)}" type="button">Retry NetSuite Sync</button>` : ""}
        ${canVoid ? `<button class="danger" data-action="void-return" data-id="${escapeHtml(id)}" type="button">Void Return</button>` : ""}
      </div>
    </div>
    ${syncError ? `<div class="notice sync-error"><strong>NetSuite processing failed</strong><span>${escapeHtml(syncError)}</span></div>` : ""}
    <div class="return-summary-grid">
      <span><small>Customer</small><strong>${escapeHtml(customer || "—")}</strong></span>
      <span><small>Sales Order</small><strong>${escapeHtml(sourceOrder || "Customer-level")}</strong></span>
      <span><small>Ordering yard</small><strong>${escapeHtml(orderingYard)}</strong></span>
      <span><small>Receiving yard</small><strong>${escapeHtml(receivingYard)}</strong></span>
      <span><small>Vehicle plate</small><strong>${escapeHtml(vehiclePlate || "—")}</strong></span>
      ${palletQuantity !== null && palletQuantity !== undefined
        ? `<span><small>PALLET quantity</small><strong>${escapeHtml(palletQuantity)}</strong></span>`
        : ""}
      <span><small>Submitted</small><strong>${formatDate(submittedAt)}${submittedBy ? `<br>${escapeHtml(submittedBy)}` : ""}</strong></span>
      <span><small>Estimated credit</small><strong>${returnMoney(estimated)}</strong></span>
      <span><small>Actual credit</small><strong>${returnMoney(actual)}</strong></span>
    </div>
    ${note ? `<p class="return-note"><strong>Return note:</strong> ${escapeHtml(note)}</p>` : ""}
    <section class="return-detail-section">
      <div class="return-subheading"><h4>Returned lines</h4><span>${lines.length} line(s)</span></div>
      <div class="return-line-list">${lines.map(renderReturnLine).join("") || `<div class="return-empty"><span>No stock lines are attached to this return.</span></div>`}</div>
    </section>
    <section class="return-detail-section">
      <div class="return-subheading"><h4>Record photos</h4><span>${photos.length} attachment(s)</span></div>
      ${renderReturnPhotoGrid(photos)}
    </section>
    <section class="return-detail-section">
      <div class="return-subheading"><h4>NetSuite reconciliation</h4></div>
      ${isDraft ? `<span class="muted">Drafts reserve no quantity and cannot be linked to NetSuite. Only the creating operator can resume this draft in the Operator PWA.</span>` : renderReturnLinks(returnLinks(), header)}
      ${!isDraft && hasStaffAuthority(operator, ["admin"]) ? `
        <form class="return-link-form" data-form="manual-return-link" data-id="${escapeHtml(id)}">
          <label><span>Transaction type</span><select name="transactionType"><option value="return_authorization">Return Authorization</option><option value="credit_memo">Credit Memo</option></select></label>
          <label><span>NetSuite internal ID</span><input name="netsuiteId" inputmode="numeric" required /></label>
          <label><span>Transaction number (optional)</span><input name="netsuiteTranid" placeholder="RA123 / CM123" /></label>
          <button class="primary" type="submit">Link Existing Transaction</button>
        </form>
      ` : ""}
    </section>
  </div>`;
}

function renderCrossYardSettings() {
  const canEdit = hasStaffAuthority(operator, ["admin"]);
  return `<section class="panel return-yard-settings">
    <div class="section-heading">
      <div>
        <h2>Cross-yard Return Acceptance</h2>
        <p class="muted"><strong>Allowing cross-yard stock returns for this yard means this yard accepts stock from both its own orders and orders from other yards.</strong> When disabled, stock returns must be processed at the Sales Order's ordering yard. Customer-level PALLET returns are accepted at every yard.</p>
      </div>
      ${returnSettingsError ? "" : `<span class="return-access-label">${canEdit ? "Admin editable" : "Admin only"}</span>`}
    </div>
    ${returnSettingsError ? `<div class="notice sync-error"><strong>Yard settings could not be loaded</strong><span>${escapeHtml(returnSettingsError)}</span></div>` : `
      <div class="return-yard-grid">
        ${controlReturnSettings.map((yard) => `<article class="return-yard-card" data-return-yard="${Number(yard.locationId)}">
          <div><strong>${escapeHtml(yard.yardCode || yard.locationId)}</strong><span>Receiving yard</span></div>
          <label class="return-switch">
            <input data-return-setting="allowCrossYardReturns" type="checkbox" ${yard.allowCrossYardReturns ? "checked" : ""} ${canEdit ? "" : "disabled"} />
            <span>${yard.allowCrossYardReturns ? "Accepting other-yard stock orders" : "Own-yard stock orders only"}</span>
          </label>
          ${canEdit ? `<button class="primary" data-action="save-cross-yard-setting" data-location-id="${Number(yard.locationId)}" type="button">Save</button>` : ""}
        </article>`).join("")}
      </div>
    `}
  </section>`;
}

function renderReturnManagementSection() {
  return `${renderCrossYardSettings()}
    <section class="panel return-management">
      <div class="section-heading">
        <div>
          <h2>Return Management</h2>
          <p class="muted">Review submitted stock and PALLET returns, decide approval-required lines, inspect photo evidence, and reconcile NetSuite transactions.</p>
        </div>
        <button data-action="refresh-return-records" type="button">Refresh</button>
      </div>
      <div class="return-record-tabs" role="tablist" aria-label="Return record state">
        <button class="${returnFilters.status === "draft" ? "" : "active"}" data-action="set-return-view" data-status="" type="button">Submitted Returns</button>
        <button class="${returnFilters.status === "draft" ? "active" : ""}" data-action="set-return-view" data-status="draft" type="button">Drafts</button>
      </div>
      <div class="return-filter-grid">
        <label><span>Search</span><input data-return-filter="search" type="search" value="${escapeHtml(returnFilters.search)}" placeholder="SR / PR / RB / SO / customer / plate" /></label>
        <label><span>Status</span><select data-return-filter="status">
          <option value="">All submitted statuses</option>
          <option value="draft" ${returnFilters.status === "draft" ? "selected" : ""}>Drafts</option>
          ${["pending_approval", "partially_pending", "partially_rejected", "accepted", "approved", "rejected", "voided", "sync_failed", "synced"].map((status) => `<option value="${status}" ${returnFilters.status === status ? "selected" : ""}>${escapeHtml(returnStatusLabel(status))}</option>`).join("")}
        </select></label>
        <label><span>Return type</span><select data-return-filter="type">
          <option value="">Stock + PALLET</option>
          <option value="normal_stock" ${returnFilters.type === "normal_stock" ? "selected" : ""}>Normal Stock</option>
          <option value="quality_stock" ${returnFilters.type === "quality_stock" ? "selected" : ""}>Quality Stock</option>
          <option value="pallet" ${returnFilters.type === "pallet" ? "selected" : ""}>PALLET</option>
        </select></label>
        <label><span>Receiving yard</span><select data-return-filter="yardLocationId"><option value="">All authorized yards</option>${SALES_YARD_OPTIONS.map((yard) => `<option value="${yard.locationId}" ${String(returnFilters.yardLocationId) === String(yard.locationId) ? "selected" : ""}>${yard.yardCode}</option>`).join("")}</select></label>
        <label><span>From</span><input data-return-filter="from" type="date" value="${escapeHtml(returnFilters.from)}" /></label>
        <label><span>To</span><input data-return-filter="to" type="date" value="${escapeHtml(returnFilters.to)}" /></label>
        <div class="return-filter-actions"><button class="primary" data-action="apply-return-filters" type="button">Apply</button><button data-action="reset-return-filters" type="button">Reset</button></div>
      </div>
      <div class="return-management-layout">
        <aside class="return-list-panel">${renderReturnRecordList()}</aside>
        <section class="return-detail-panel">${renderReturnDetail()}</section>
      </div>
    </section>`;
}

function renderReturnAutomationSection() {
  return `<section class="panel return-automation">
    <div class="section-heading">
      <div>
        <h2>Return NetSuite Automation</h2>
        <p class="muted">These settings are yard-specific and default to Off. The actual receiving yard controls automation, including approved cross-yard stock returns and customer-level PALLET returns.</p>
      </div>
      <button data-action="refresh-return-automation" type="button">Refresh</button>
    </div>
    <div class="notice">
      <strong>Safe rollout</strong>
      <span>Stock returns create Return Authorizations. PALLET returns create Credit Memos directly at $40 per Each. Keep both settings off until that yard is ready for live NetSuite transactions.</span>
    </div>
    <div class="notice">
      <strong>Current NetSuite limitation</strong>
      <span>A Quality Return that splits one Sales Order line across multiple reason codes remains local. Link its Return Authorization manually after creating it in NetSuite; automatic creation stays fail-safe for that record.</span>
    </div>
    ${returnSettingsError ? `<div class="notice sync-error"><strong>Return automation settings could not be loaded</strong><span>${escapeHtml(returnSettingsError)}</span></div>` : `
      <div class="return-automation-grid">
        ${adminReturnSettings.map((yard) => `<article class="return-automation-card" data-return-automation-yard="${Number(yard.locationId)}">
          <header><div><strong>${escapeHtml(yard.yardCode || yard.locationId)}</strong><span>Actual receiving yard</span></div>${yard.autoCreateStockReturnAuthorization || yard.autoCreatePalletCreditMemo ? `<span class="return-status-pill accepted">Live automation enabled</span>` : `<span class="return-status-pill draft">Automation off</span>`}</header>
          <label class="return-toggle-row">
            <input data-return-setting="autoCreateStockReturnAuthorization" type="checkbox" ${yard.autoCreateStockReturnAuthorization ? "checked" : ""} />
            <span><strong>Auto-create Stock Return Authorizations</strong><small>Allowed items create immediately. Approval-required returns wait until every line is resolved.</small></span>
          </label>
          <label class="return-toggle-row">
            <input data-return-setting="autoCreatePalletCreditMemo" type="checkbox" ${yard.autoCreatePalletCreditMemo ? "checked" : ""} />
            <span><strong>Auto-create PALLET Credit Memos</strong><small>Creates a PALLET Credit Memo directly using the receiving yard and $40 per Each.</small></span>
          </label>
          <div class="return-setting-meta">${firstDefined(yard, ["updatedAt", "updated_at"], "") ? `Last changed ${formatDate(firstDefined(yard, ["updatedAt", "updated_at"]))}` : "Default: both Off"}</div>
          <button class="primary" data-action="save-return-automation" data-location-id="${Number(yard.locationId)}" type="button">Save Yard Settings</button>
        </article>`).join("")}
      </div>
    `}
  </section>`;
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
  outbound: ["sales_order", "transfer_order", "co_order", "vrma_order"]
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
  link.download = `in-outbound-record-${loadedFilters.from || "from"}-${loadedFilters.to || "to"}.csv`;
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
          <span class="movement-badges"><i class="movement-badge ${escapeHtml(order.direction)}">${t(`yard.${order.direction}`, order.direction)}</i><i class="movement-badge type">${movementTypeCode(order.order_type)}</i>${order.driver_only ? `<i class="movement-badge type">${t("yard.driverOnly", "Driver only")}</i>` : ""}</span>
        </div>
        <span>${escapeHtml(order.yard_location || t("common.yard", "Yard"))} | ${escapeHtml(order.movement_status || t("yard.processed", "Processed"))}</span>
        <em>${formatDate(order.last_activity_at || order.last_processed_at)} | ${t("yard.yardActivities", "Yard")} ${order.yard_activity_count || order.process_count || 0} | ${t("yard.driverActivities", "Driver")} ${order.driver_activity_count || 0} | ${order.photo_count || 0} ${t("common.photos", "photos")}</em>
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
          <h2>${t("control.loadedExportTitle", "In/Outbound Record")}</h2>
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

function renderSalesOrderLoadAttempts(loadAttempts = []) {
  if (!loadAttempts.length) return "";
  return `
    <div class="loaded-photo-section load-attempt-timeline">
      <h3>Physical load attempts</h3>
      <div class="loaded-lines">
        ${loadAttempts.map((attempt) => `
          <article class="loaded-line-card load-attempt-card">
            <div>
              <strong>${attempt.attemptKind === "reload" ? `Re-load #${attempt.cycleNumber || ""}` : "Original load"}</strong>
              <span>${formatDate(attempt.processedAt)} · ${escapeHtml(attempt.operatorName || attempt.operatorId || "Operator")}</span>
              ${attempt.reason ? `<em>${escapeHtml(attempt.reason)}</em>` : ""}
              <small>${attempt.quantityBasis === "exact_attempt" ? "Exact quantity for this attempt" : "Legacy recorded loaded state"}</small>
            </div>
            <div class="loaded-line-qty">
              <strong>${(attempt.attemptLines || []).length} ${t("control.lines", "line(s)")}</strong>
              <small>${(attempt.photos || []).length} ${t("common.photos", "photos")}</small>
            </div>
          </article>
          ${(attempt.attemptLines || []).map((line) => `
            <div class="loaded-line-card load-attempt-line">
              <div><strong>${escapeHtml(line.sku || line.itemName || "")}</strong><span>${escapeHtml(line.itemName || "")}</span></div>
              <div class="loaded-line-qty"><strong>${movementQuantity(line.loadedQty ?? line.quantity ?? 0)} ${escapeHtml(line.loadedUom || line.unit || "")}</strong></div>
            </div>
          `).join("")}
        `).join("")}
      </div>
    </div>
  `;
}

function renderLoadedOrderDetail() {
  if (!loadedOrderDetail) {
    return `<div class="empty-detail"><strong>${t("common.selectOrder", "Select an order")}</strong><span>${t("yard.selectMovementHelp", "Yard processing, driver delivery details, timestamps, and photo proof will show here.")}</span></div>`;
  }
  const { order, lines = [], photos = [], loadAttempts = [], activeReloadCycle = null } = loadedOrderDetail;
  const driverRecords = loadedOrderDetail.driverRecords || loadedOrderDetail.driverEvents || [];
  const driverPhotos = loadedOrderDetail.driverPhotos || [];
  const route = [order.source_location, order.destination_location].filter(Boolean).join(" → ");
  const salesOrderReloadEligible = order.direction === "outbound" && order.order_type === "sales_order" && !order.driver_only;
  const reloadCanCancel = activeReloadCycle?.status === "authorized" && !activeReloadCycle?.activityStartedAt;
  return `
    <div class="loaded-detail-head">
      <div>
        <div class="movement-detail-title"><h3>${escapeHtml(order.tranid || order.order_id)}</h3><span class="movement-badges"><i class="movement-badge ${escapeHtml(order.direction)}">${t(`yard.${order.direction}`, order.direction)}</i><i class="movement-badge type">${movementTypeCode(order.order_type)}</i>${order.driver_only ? `<i class="movement-badge type">${t("yard.driverOnly", "Driver only")}</i>` : ""}</span></div>
        <p class="muted">${escapeHtml(movementTypeLabel(order.order_type))} | ${escapeHtml(order.yard_location || "")} | ${escapeHtml(order.movement_status || t("yard.processed", "Processed"))}</p>
        ${route ? `<p class="muted">${escapeHtml(route)}</p>` : ""}
        ${order.party ? `<p class="muted">${escapeHtml(order.party)}</p>` : ""}
        ${order.delivery_at ? `<p class="muted"><strong>${t("yard.deliveryTime", "Delivered")}:</strong> ${formatDate(order.delivery_at)}</p>` : ""}
      </div>
      <div class="loaded-detail-actions">
        <strong>${lines.length} ${t("control.lines", "line(s)")} · ${t("yard.yardActivities", "Yard")} ${order.yard_activity_count || order.process_count || 0} · ${t("yard.driverActivities", "Driver")} ${order.driver_activity_count || driverRecords.length}</strong>
        ${salesOrderReloadEligible && !activeReloadCycle ? `<button class="primary" data-action="authorize-sales-order-reload" type="button">Authorize Re-load</button>` : ""}
        ${reloadCanCancel ? `<button data-action="cancel-sales-order-reload" data-cycle-id="${escapeHtml(activeReloadCycle.id)}" type="button">Cancel Re-load</button>` : ""}
        ${activeReloadCycle ? `<small><strong>Re-load #${escapeHtml(activeReloadCycle.cycleNumber)}</strong> · ${escapeHtml(activeReloadCycle.status)} · ${escapeHtml(activeReloadCycle.reason)}</small>` : ""}
      </div>
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
      `).join("") || `<div class="notice"><strong>${t("yard.noProcessedLines", "No processed lines")}</strong><span>${order.driver_only ? t("yard.noYardLinesYet", "No yard processing record yet. Driver delivery data is shown below.") : t("yard.noProcessedLinesHelp", "This order has an activity record but no retained processed line quantity.")}</span></div>`}
    </div>
    ${renderSalesOrderLoadAttempts(loadAttempts)}
    ${driverRecords.length ? `
      <div class="loaded-photo-section">
        <h3>${t("yard.driverActivity", "Driver activity")}</h3>
        <div class="loaded-lines">
          ${driverRecords.map((record) => {
            const details = record.job_details && typeof record.job_details === "object" ? record.job_details : {};
            const detailLocation = [details.location || details.dropLocation, details.address || details.dropAddress].filter(Boolean).join(" · ");
            const windowText = [details.windowStart, details.windowEnd].filter(Boolean).join(" – ");
            return `<div class="loaded-line-card">
              <div>
                <strong>${escapeHtml(record.driver_name || record.driver_login || t("yard.driver", "Driver"))} · ${escapeHtml(record.stop_type === "dropoff" ? t("yard.dropoffStop", "Delivery stop") : t("yard.pickupStop", "Pickup stop"))}</strong>
                <span>${escapeHtml([record.truck_plate, record.load_name].filter(Boolean).join(" · "))}</span>
                ${detailLocation ? `<em>${escapeHtml(detailLocation)}</em>` : ""}
                ${windowText ? `<em>${escapeHtml(windowText)}</em>` : ""}
                ${details.instructions ? `<em>${escapeHtml(details.instructions)}</em>` : ""}
              </div>
              <div class="loaded-line-qty">
                <strong>${record.completed_at ? formatDate(record.completed_at) : t("yard.notCompleted", "Not completed")}</strong>
                ${record.started_at ? `<small>${t("yard.startedAt", "Started")} ${formatDate(record.started_at)}</small>` : ""}
                <small>${record.photo_count || 0} ${t("common.photos", "photos")}</small>
              </div>
            </div>`;
          }).join("")}
        </div>
      </div>
    ` : ""}
    <div class="loaded-photo-section">
      <h3>${t("yard.yardPhotos", "Yard photos")}</h3>
      <div class="loaded-photo-grid">
        ${photos.filter((photo) => photo.photo_data_url).map((photo) => `
          <figure>
            <button class="photo-thumb-button" data-action="open-photo-lightbox" data-photo-ref="${escapeHtml(photo.photo_data_url)}" data-photo-label="${t("yard.activityPhoto", "Activity photo")} ${escapeHtml(photo.id)}" type="button">
              <img ${photoImgAttributes(photo.photo_data_url)} alt="${t("yard.activityPhoto", "Activity photo")} ${escapeHtml(photo.id)}" />
            </button>
            <figcaption>${formatDate(photo.created_at)}</figcaption>
          </figure>
        `).join("") || `<div class="notice"><strong>${t("common.noPhoto", "No photo")}</strong><span>${t("yard.noPhotoHelp", "No photo proof is attached to this processed activity in the filtered date range.")}</span></div>`}
      </div>
    </div>
    ${driverRecords.length || driverPhotos.length || order.driver_only ? `
      <div class="loaded-photo-section">
        <h3>${t("yard.driverDeliveryPhotos", "Driver delivery photos")}</h3>
        <div class="loaded-photo-grid">
          ${driverPhotos.filter((photo) => photo.photo_data_url).map((photo) => `
            <figure>
              <button class="photo-thumb-button" data-action="open-photo-lightbox" data-photo-ref="${escapeHtml(photo.photo_data_url)}" data-photo-label="${escapeHtml(photo.driver_name || photo.driver_login || t("yard.driver", "Driver"))} ${escapeHtml(photo.id)}" type="button">
                <img ${photoImgAttributes(photo.photo_data_url)} alt="${escapeHtml(photo.driver_name || photo.driver_login || t("yard.driver", "Driver"))} ${escapeHtml(photo.id)}" />
              </button>
              <figcaption>${escapeHtml([photo.driver_name || photo.driver_login, photo.truck_plate, photo.stop_type].filter(Boolean).join(" · "))}<br>${formatDate(photo.created_at)}</figcaption>
            </figure>
          `).join("") || `<div class="notice"><strong>${t("common.noPhoto", "No photo")}</strong></div>`}
        </div>
      </div>
    ` : ""}
  `;
}


function renderNetSuiteMirrorPanel() {
  const role = mirrorStatus.role || "disabled";
  if (role === "disabled") return "";
  const source = mirrorStatus.source || {};
  const consumer = mirrorStatus.consumer || {};
  const isConsumer = role === "consumer";
  const ready = mirrorStatus.configured
    && (isConsumer ? mirrorStatus.sourceUrlConfigured : mirrorStatus.consumerUrlConfigured);
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>NetSuite Data Mirror</h2>
          <p class="muted">${isConsumer
            ? "This V2 server reads normalized NetSuite data only from the current port 3000 application."
            : "This server is the NetSuite source of truth and relays durable change events to Dispatch V2."}</p>
        </div>
        <button data-action="refresh" type="button">${t("common.refresh", "Refresh")}</button>
      </div>
      <div class="sync-status-grid">
        <div><span>Role</span><strong>${escapeHtml(role)}</strong></div>
        <div><span>Configured</span><strong>${ready ? t("control.yes", "Yes") : t("control.no", "No")}</strong></div>
        <div><span>Source high-water</span><strong>${Number(source.highWaterSequence || 0)}</strong></div>
        ${isConsumer
          ? `<div><span>Applied sequence</span><strong>${Number(consumer.appliedSequence || 0)}</strong></div>
             <div><span>Event lag</span><strong>${Number(consumer.lag || 0)}</strong></div>
             <div><span>Failed</span><strong>${Number(consumer.failed || 0)}</strong></div>
             <div><span>Last applied</span><strong>${formatDate(consumer.lastAppliedAt)}</strong></div>`
          : `<div><span>Pending relay</span><strong>${Number(source.pending || 0)}</strong></div>
             <div><span>Failed relay</span><strong>${Number(source.failed || 0)}</strong></div>
             <div><span>Last delivered</span><strong>${formatDate(source.lastDeliveredAt)}</strong></div>`}
      </div>
      ${source.lastError || consumer.lastError ? `<div class="notice sync-error">${escapeHtml(source.lastError || consumer.lastError)}</div>` : ""}
      <div class="actions">
        <button data-action="retry-netsuite-mirror" type="button">Retry Failed / Catch Up</button>
        ${isConsumer ? '<button data-action="reconcile-netsuite-mirror" type="button">Run Full Reconciliation</button>' : ""}
      </div>
    </section>
  `;
}

function renderTargetedOrderSyncPanel() {
  const result = targetedSyncResult;
  const lineSummary = result?.lines
    ? Object.entries(result.lines).map(([stage, count]) => `${Number(count || 0)} ${stage}`).join(" / ")
    : "";
  const statusSummary = result?.ok
    ? (result.statusChanged
      ? `${result.previousStatus || "—"} → ${result.status || "—"}`
      : (result.status || result.previousStatus || "—"))
    : "";
  return `
    <section class="panel targeted-sync-panel">
      <div class="section-heading">
        <div>
          <h2>${t("control.targetedOrderSync", "Sync One NetSuite Order")}</h2>
          <p class="muted">${t("control.targetedOrderSyncHelp", "Enter an SO, PO, or TO number. The server infers the type and refreshes only that order header and its lines.")}</p>
        </div>
      </div>
      <form class="targeted-sync-form" data-form="targeted-order-sync">
        <label>
          <span>${t("control.orderNumber", "Order Number")}</span>
          <input id="targetedSyncOrderRef" name="orderRef" maxlength="64" autocomplete="off" spellcheck="false" placeholder="POB03581 / SOA05632 / TOB00690" value="${escapeHtml(targetedSyncOrderRef)}" ${targetedSyncBusy || syncSettings.running ? "disabled" : ""} />
        </label>
        <button class="primary" type="submit" ${targetedSyncBusy || syncSettings.running ? "disabled" : ""}>${targetedSyncBusy ? t("control.syncingOrder", "Syncing Order...") : t("control.syncThisOrder", "Sync This Order")}</button>
      </form>
      <p class="muted">${t("control.targetedOrderSyncNote", "Use the NetSuite transaction number, not a local split PO reference. A full sync cannot run at the same time.")}</p>
      ${result?.ok ? `
        <div class="notice sync-success" role="status">
          <strong>${escapeHtml(result.orderRef)} ${t("control.syncComplete", "sync complete")}</strong>
          <span>${escapeHtml(result.orderType)} · NetSuite ID ${escapeHtml(result.netSuiteId)} · ${escapeHtml(statusSummary)}${lineSummary ? ` · ${escapeHtml(lineSummary)}` : ""} · ${formatDate(result.syncedAt)}</span>
        </div>
      ` : result?.error ? `<div class="notice sync-error" role="alert"><strong>${t("control.syncFailed", "Sync failed")}</strong><span>${escapeHtml(result.error)}</span></div>` : ""}
    </section>
  `;
}

function humanizeScmReconciliationKey(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function scmReconciliationRunId(run) {
  return String(firstDefined(run, ["id", "runId", "run_id"], ""));
}

function scmReconciliationRunIsDry(run) {
  const explicit = firstDefined(run, ["dryRun", "dry_run", "isDryRun", "is_dry_run"], null);
  if (explicit !== null) return scmReconciliationBoolean(explicit);
  return scmReconciliationRunStatus(run).includes("dry_run")
    || String(firstDefined(run, ["mode"], "")).toLowerCase().includes("dry");
}

function scmReconciliationInitialApproved() {
  return scmReconciliationSettings.initialDryRunApproved
    || Boolean(firstDefined(scmReconciliationSettings, [
      "initialDryRunApprovedAt",
      "initial_dry_run_approved_at",
      "initialDryRunAppliedAt",
      "initial_dry_run_applied_at"
    ], ""));
}

function scmReconciliationSoInitialApproved() {
  return scmReconciliationSettings.soInitialDryRunApproved
    || Boolean(firstDefined(scmReconciliationSettings, [
      "soInitialDryRunApprovedAt",
      "so_initial_dry_run_approved_at"
    ], ""));
}

function scmReconciliationScopeApproved(scope = "all", orderKind = "", soOrderType = "all") {
  const cleanScope = String(scope || "all").toUpperCase();
  const cleanKind = String(orderKind || "").toUpperCase();
  const cleanSoOrderType = String(soOrderType || "all")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (cleanScope === "ORDER_FAMILY" && cleanKind === "SO") {
    return scmReconciliationSoInitialApproved();
  }
  if (["ALL", "SO"].includes(cleanScope) && cleanSoOrderType === "pickup") return false;
  if (cleanScope === "SO") return scmReconciliationSoInitialApproved();
  if (cleanScope === "ALL") {
    return scmReconciliationInitialApproved() && scmReconciliationSoInitialApproved();
  }
  return scmReconciliationInitialApproved();
}

function scmReconciliationRunResumeId(run) {
  const value = Number(firstDefined(run, [
    "resumeOfRunId",
    "resume_of_run_id"
  ], 0));
  return Number.isSafeInteger(value) && value > 0 ? String(value) : "";
}

function scmReconciliationAppliedRunFor(run) {
  const runId = scmReconciliationRunId(run);
  if (!runId) return null;
  return scmReconciliationRuns.find((candidate) =>
    !scmReconciliationRunIsDry(candidate)
    && scmReconciliationRunResumeId(candidate) === runId
    && ["queued", "running", "succeeded"].includes(scmReconciliationRunStatus(candidate))
  ) || null;
}

function scmReconciliationRunCanApply(run) {
  if (!scmReconciliationRunId(run) || !scmReconciliationRunIsDry(run)) return false;
  const scope = String(firstDefined(run, ["scope"], "")).toLowerCase();
  const status = scmReconciliationRunStatus(run);
  if (!["succeeded", "awaiting_approval"].includes(status)) return false;
  if (status === "awaiting_approval" && !["all", "so"].includes(scope)) return false;
  if (scmReconciliationBoolean(firstDefined(run, ["applied", "isApplied", "is_applied"], false))) return false;
  if (firstDefined(run, ["appliedAt", "applied_at", "approvedAt", "approved_at"], "")) return false;
  return !scmReconciliationAppliedRunFor(run);
}

function scmReconciliationRunSummary(run) {
  const summary = firstDefined(run, ["summary", "result", "results", "stats"], {});
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return {};
  return summary;
}

function scmReconciliationRunDecisionSummary(run) {
  const summary = firstDefined(run, [
    "reviewDecisionSummary",
    "review_decision_summary"
  ], {});
  return summary && typeof summary === "object" && !Array.isArray(summary)
    ? summary
    : {};
}

function scmReconciliationRunPendingDecisions(run) {
  return Number(firstDefined(
    scmReconciliationRunDecisionSummary(run),
    ["pendingTargets", "pending_targets", "unresolvedTargets"],
    0
  )) || 0;
}

function scmReconciliationRunReviewCount(run) {
  const decisionCount = Number(firstDefined(
    scmReconciliationRunDecisionSummary(run),
    ["reviewTargets", "review_targets"],
    Number.NaN
  ));
  if (Number.isFinite(decisionCount)) return Math.max(0, decisionCount);
  const summaryCount = Number(firstDefined(
    scmReconciliationRunSummary(run),
    ["reviewOrders", "review_orders"],
    0
  ));
  return Number.isFinite(summaryCount) ? Math.max(0, summaryCount) : 0;
}

function scmReconciliationRunMetricHtml(run) {
  const summary = scmReconciliationRunSummary(run);
  const entries = Object.entries(summary)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 8);
  if (!entries.length) return "";
  return `
    <div class="scm-reconciliation-result-grid">
      ${entries.map(([key, value]) => `
        <div>
          <span>${escapeHtml(humanizeScmReconciliationKey(key))}</span>
          <strong>${escapeHtml(typeof value === "number" ? value.toLocaleString() : value)}</strong>
        </div>
      `).join("")}
    </div>
  `;
}

function scmReconciliationRunProgressHtml(run) {
  if (!scmReconciliationRunIsActive(run)) return "";
  const checkpoint = firstDefined(run, ["checkpoint"], {});
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return "";
  const phase = String(checkpoint.phase || "queued");
  const phaseLabel = {
    resolve_sources: "Resolving local orders",
    fetch_sources: "Loading NetSuite orders",
    direct_lookup: "Checking missing orders",
    fetch_linked_transactions: "Loading IF / IR evidence",
    reconcile: "Reconciling orders",
    complete: "Finalizing run"
  }[phase] || humanizeScmReconciliationKey(phase);
  const isLinkedFetch = phase === "fetch_linked_transactions";
  const processed = Number(isLinkedFetch
    ? checkpoint.processedSourceOrders
    : checkpoint.processed);
  const total = Number(isLinkedFetch
    ? checkpoint.totalSourceOrders
    : checkpoint.total);
  const progress = Number.isFinite(processed) && Number.isFinite(total) && total > 0
    ? `${processed.toLocaleString()} of ${total.toLocaleString()} orders`
    : "Worker heartbeat is active";
  const batchAttempt = Number(checkpoint.linkedBatchAttempt);
  const batchMaxAttempts = Number(checkpoint.linkedBatchMaxAttempts);
  const batchSize = Number(checkpoint.linkedBatchSize);
  const batchDetails = isLinkedFetch && Number.isFinite(batchSize) && batchSize > 0
    ? [
      `${batchSize.toLocaleString()} in current batch`,
      Number.isFinite(batchAttempt) && Number.isFinite(batchMaxAttempts)
        ? `attempt ${batchAttempt.toLocaleString()} of ${batchMaxAttempts.toLocaleString()}`
        : "",
      checkpoint.linkedBatchRetrying ? "retrying after timeout" : ""
    ].filter(Boolean).join(" · ")
    : "";
  return `
    <div class="notice">
      <strong>${escapeHtml(phaseLabel)}</strong>
      <span>${escapeHtml([progress, batchDetails].filter(Boolean).join(" · "))}</span>
    </div>
  `;
}

function scmReconciliationRunDetailsJson(run) {
  const details = firstDefined(run, ["summary", "result", "results", "stats", "error", "lastError", "last_error"], null);
  if (details === null || details === undefined || details === "") return "";
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
}

function scmReconciliationTargetProposal(target = {}) {
  const proposed = target.proposedChange && Object.keys(target.proposedChange).length
    ? target.proposedChange
    : target.result || {};
  return proposed && typeof proposed === "object" ? proposed : {};
}

function scmReconciliationQuantityText(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? numeric.toLocaleString(undefined, { maximumFractionDigits: 6 })
    : "—";
}

function scmReconciliationTargetCalculatedOutcome(target = {}, proposal = {}) {
  const reconciliationStatus = String(
    proposal.reconciliationStatus
    || proposal.reconciliation_status
    || ""
  ).trim().toLowerCase();
  if (reconciliationStatus === "missing") return "";
  const explicit = String(
    proposal.calculatedApplicationStatus
    || proposal.authoritativeApplicationStatus
    || ""
  ).trim();
  if (explicit) return explicit;
  const applicationStatus = String(
    proposal.applicationStatus
    || proposal.application_status
    || ""
  ).trim();
  if (applicationStatus && applicationStatus !== "Reconcile Review") {
    return applicationStatus;
  }
  const quantities = proposal.quantities && typeof proposal.quantities === "object"
    ? proposal.quantities
    : {};
  const ordered = Number(quantities.ordered || 0);
  const fulfilled = Number(quantities.fulfilled || 0);
  const received = Number(quantities.received || 0);
  const abandoned = Number(quantities.abandoned || 0);
  const kind = String(target.orderKind || proposal.orderKind || "").toUpperCase();
  if (
    ordered > 0
    && received + abandoned >= ordered - 0.000001
    && (kind !== "TO" || fulfilled + abandoned >= ordered - 0.000001)
  ) {
    return "Completed";
  }
  return "";
}

function scmReconciliationTargetReasonPresentation(reason, proposal = {}) {
  const full = String(reason || "").trim();
  if (!full) return { summary: "", full: "", collapsed: false, detailCount: 0 };
  const explicitSummary = String(
    proposal.reviewSummary
    || proposal.review_summary
    || proposal.reviewDiagnostics?.summary
    || proposal.review_diagnostics?.summary
    || ""
  ).trim();
  const parts = full.split(/(?<=[.!?])\s+/).filter(Boolean);
  const collapsed = Boolean(explicitSummary)
    ? explicitSummary !== full
    : parts.length > 2 || full.length > 320;
  let summary = explicitSummary || parts[0] || full;
  if (!explicitSummary && summary.length > 260) {
    summary = `${summary.slice(0, 257).trimEnd()}…`;
  }
  return {
    summary: collapsed ? summary : full,
    full,
    collapsed,
    detailCount: Math.max(parts.length, 1)
  };
}

function renderScmReconciliationTargetDecision(target = {}, run = {}, proposal = {}) {
  const runStatus = scmReconciliationRunStatus(run);
  const targetStatus = String(target.status || "").toLowerCase();
  if (
    !scmReconciliationRunIsDry(run)
    || !["succeeded", "awaiting_approval"].includes(runStatus)
    || targetStatus !== "review"
  ) {
    return "";
  }
  const targetId = String(target.id || "");
  const runId = scmReconciliationRunId(run);
  const decisionKey = scmReconciliationTargetDecisionKey(runId, targetId);
  const draft = scmReconciliationDecisionDrafts.get(decisionKey);
  const hasSavedDecision = Boolean(target.reviewDecision);
  const decision = String(draft?.decision ?? target.reviewDecision ?? "");
  const note = String(draft?.note ?? target.reviewDecisionNote ?? "");
  const outcome = scmReconciliationTargetCalculatedOutcome(target, proposal);
  const busy = scmReconciliationDecisionBusyTargets.has(decisionKey);
  const noteRequired = ["accept_current", "skip"].includes(decision);
  const controlId = scmReconciliationTargetDecisionControlId(runId, targetId);
  const headingId = `${controlId}-heading`;
  const hintId = `${controlId}-hint`;
  const actionId = `${controlId}-action`;
  const noteId = `${controlId}-note`;
  const saveId = `${controlId}-save`;
  const orderLabel = `${target.orderKind || "Order"} ${target.orderRef || target.orderId || ""}`.trim();
  return `
    <section class="scm-reconciliation-target-decision"
      data-reconciliation-target-decision="${escapeHtml(targetId)}"
      data-run-id="${escapeHtml(runId)}"
      data-target-id="${escapeHtml(targetId)}"
      aria-labelledby="${escapeHtml(headingId)}"
      aria-describedby="${escapeHtml(hintId)}">
      <div>
        <strong id="${escapeHtml(headingId)}">Decision before apply</strong>
        <span id="${escapeHtml(hintId)}">The live apply will refetch NetSuite. A saved acceptance is ignored if the evidence changes.</span>
      </div>
      <label for="${escapeHtml(actionId)}">
        <span>Action</span>
        <select id="${escapeHtml(actionId)}" data-review-decision required aria-required="true" ${busy ? "disabled" : ""}>
          <option value="" ${decision ? "" : "selected"}>Choose an action…</option>
          ${outcome ? `<option value="accept_current" ${decision === "accept_current" ? "selected" : ""}>Accept NetSuite outcome — ${escapeHtml(outcome)}</option>` : ""}
          <option value="skip" ${decision === "skip" ? "selected" : ""}>Skip this order and future broad runs</option>
          <option value="keep_review" ${decision === "keep_review" ? "selected" : ""}>Apply normally; keep Review if conflict remains</option>
        </select>
      </label>
      <label class="note" for="${escapeHtml(noteId)}">
        <span>Audit note (${noteRequired ? "required" : "optional"})</span>
        <textarea id="${escapeHtml(noteId)}" data-review-decision-note rows="2"
          placeholder="Why is this action appropriate?"
          ${noteRequired ? 'required aria-required="true"' : 'aria-required="false"'}
          ${busy ? "disabled" : ""}>${escapeHtml(note)}</textarea>
      </label>
      <div class="actions">
        <button class="primary" id="${escapeHtml(saveId)}"
          data-action="save-scm-reconciliation-target-decision"
          data-run-id="${escapeHtml(runId)}"
          data-target-id="${escapeHtml(targetId)}"
          data-target-updated-at="${escapeHtml(target.updatedAt || "")}"
          aria-label="${escapeHtml(`${hasSavedDecision ? "Update" : "Save"} decision for ${orderLabel}`)}"
          type="button" ${busy ? "disabled" : ""}>${busy ? "Saving…" : hasSavedDecision ? "Update decision" : "Save decision"}</button>
        ${decision && !draft ? `<span class="scm-reconciliation-decision-saved" role="status" aria-live="polite">Saved: ${escapeHtml(humanizeScmReconciliationKey(decision))}${target.reviewDecidedAt ? ` · ${escapeHtml(formatDate(target.reviewDecidedAt))}` : ""}</span>` : ""}
        ${draft ? `<span class="scm-reconciliation-decision-saved draft">Unsaved changes</span>` : ""}
      </div>
    </section>
  `;
}

function renderScmReconciliationRunTarget(target = {}, run = {}) {
  const proposal = scmReconciliationTargetProposal(target);
  const quantities = proposal.quantities && typeof proposal.quantities === "object"
    ? proposal.quantities
    : {};
  const status = String(target.status || proposal.reconciliationStatus || "pending").toLowerCase();
  const applicationStatus = String(proposal.applicationStatus || proposal.application_status || "");
  const calculatedOutcome = scmReconciliationTargetCalculatedOutcome(target, proposal);
  const reason = String(target.error || proposal.reason || proposal.reconciliationReason || "");
  const reasonPresentation = scmReconciliationTargetReasonPresentation(reason, proposal);
  const detailJson = (() => {
    try {
      return JSON.stringify(proposal, null, 2);
    } catch {
      return String(proposal);
    }
  })();
  const metrics = [
    ["Ordered", quantities.ordered],
    ["Fulfilled", quantities.fulfilled],
    ["Received", quantities.received],
    ["Abandoned", quantities.abandoned],
    ["Remaining", quantities.remaining],
    ["Destination remaining", quantities.destinationRemaining]
  ].filter(([, value]) => value !== undefined && value !== null);
  return `
    <article class="scm-reconciliation-target-card ${escapeHtml(status)}">
      <header>
        <div>
          <strong>${escapeHtml(target.orderKind || "Order")} ${escapeHtml(target.orderRef || target.orderId || "")}</strong>
          ${applicationStatus ? `<span>Proposed: ${escapeHtml(applicationStatus)}</span>` : ""}
          ${calculatedOutcome && calculatedOutcome !== applicationStatus ? `<span>Calculated NetSuite outcome: ${escapeHtml(calculatedOutcome)}</span>` : ""}
        </div>
        <span class="scm-reconciliation-status ${escapeHtml(status)}">${escapeHtml(humanizeScmReconciliationKey(status))}</span>
      </header>
      ${metrics.length ? `
        <div class="scm-reconciliation-target-quantities">
          ${metrics.map(([label, value]) => `
            <span><small>${escapeHtml(label)}</small><strong>${escapeHtml(scmReconciliationQuantityText(value))}</strong></span>
          `).join("")}
        </div>
      ` : ""}
      ${reasonPresentation.summary ? `<p class="scm-reconciliation-target-reason">${escapeHtml(reasonPresentation.summary)}</p>` : ""}
      ${renderScmReconciliationTargetDecision(target, run, proposal)}
      ${reasonPresentation.collapsed ? `
        <details class="scm-reconciliation-target-reason-details">
          <summary>View all ${reasonPresentation.detailCount.toLocaleString()} review details</summary>
          <p>${escapeHtml(reasonPresentation.full)}</p>
        </details>
      ` : ""}
      ${detailJson && detailJson !== "{}"
        ? `<details><summary>Full proposed result</summary><pre>${escapeHtml(detailJson)}</pre></details>`
        : ""}
    </article>
  `;
}

function renderScmReconciliationRunTargets(runId) {
  const detail = scmReconciliationRunDetails.get(String(runId));
  const run = scmReconciliationRuns.find((candidate) =>
    scmReconciliationRunId(candidate) === String(runId)) || {};
  if (!detail) {
    return `
      <section class="scm-reconciliation-target-review" aria-busy="true">
        <div class="scm-reconciliation-target-review-heading">
          <strong>Order-by-order review</strong>
          <span>Loading…</span>
        </div>
        <div class="notice"><strong>Loading proposed orders…</strong></div>
      </section>
    `;
  }
  return `
    <section class="scm-reconciliation-target-review" aria-busy="${detail.loading ? "true" : "false"}">
      <div class="scm-reconciliation-target-review-heading">
        <strong>Order-by-order review</strong>
        <span>${Number(detail.targetCount || detail.targets.length).toLocaleString()} target(s)</span>
      </div>
      ${detail.error ? `<div class="notice sync-error"><strong>Run details could not be loaded</strong><span>${escapeHtml(detail.error)}</span></div>` : ""}
      ${detail.targets.map((target) => renderScmReconciliationRunTarget(target, run)).join("")
        || (detail.loading
          ? `<div class="notice"><strong>Loading proposed orders…</strong></div>`
          : `<div class="notice"><strong>No order targets were recorded for this run.</strong></div>`)}
      ${detail.hasMore
        ? `<button data-action="load-more-scm-reconciliation-targets" data-run-id="${escapeHtml(runId)}" type="button" ${detail.loading ? "disabled" : ""}>${detail.loading ? "Loading…" : "Load more orders"}</button>`
        : ""}
    </section>
  `;
}

function scmReconciliationRunScopeLabel(run) {
  const scope = String(firstDefined(run, ["scope"], "all"));
  const soOrderType = String(firstDefined(
    run,
    ["soOrderType", "so_order_type", "so_order_type_filter"],
    "all"
  )).toLowerCase();
  const soOrderTypeLabel = soOrderType === "delivery"
    ? "Delivery"
    : soOrderType === "pickup"
      ? "Pick-Up"
      : "All SO types";
  const orderKind = String(firstDefined(run, ["orderKind", "order_kind", "targetOrderKind", "target_order_kind"], ""));
  const orderRefs = normalizeScmReconciliationOrderRefs(firstDefined(
    run,
    ["orderRefs", "order_refs", "targetOrderRefs", "target_order_refs", "orderRef", "order_ref", "targetOrderRef", "target_order_ref"],
    []
  ));
  const orderId = firstDefined(run, ["orderId", "order_id", "targetOrderId", "target_order_id"], "");
  return scope === "order_family"
    ? orderRefs.length > 1
      ? `${orderKind || "Order"} · ${orderRefs.length.toLocaleString()} families`
      : `${orderKind || "Order"} ${orderRefs[0] || (orderId ? `ID ${orderId}` : "family")}`
    : scope === "SO"
      ? `SO · ${soOrderTypeLabel}`
      : scope === "all"
        ? soOrderType === "all"
          ? "ALL · All SO types"
          : `ALL · ${soOrderTypeLabel} SO`
        : scope.toUpperCase();
}

function renderScmReconciliationRunListItem(run) {
  const id = scmReconciliationRunId(run);
  const status = scmReconciliationRunStatus(run);
  const startedAt = firstDefined(run, ["startedAt", "started_at", "createdAt", "created_at"], "");
  const source = String(firstDefined(run, ["source", "trigger", "triggerSource", "trigger_source", "runSource", "run_source"], "manual"));
  const pendingDecisions = scmReconciliationRunPendingDecisions(run);
  const reviewCount = scmReconciliationRunReviewCount(run);
  const selected = id && id === scmReconciliationSelectedRunId;
  const scopeLabel = scmReconciliationRunScopeLabel(run);
  return `
    <button class="scm-reconciliation-run-list-item ${selected ? "selected" : ""} ${scmReconciliationRunIsActive(run) ? "active" : ""}"
      data-action="select-scm-reconciliation-run"
      data-run-id="${escapeHtml(id)}"
      type="button"
      aria-current="${selected ? "true" : "false"}"
      aria-label="${escapeHtml(`Run ${id}, ${scopeLabel}, ${humanizeScmReconciliationKey(status)}`)}">
      <span class="scm-reconciliation-run-list-heading">
        <strong>#${escapeHtml(id)} · ${escapeHtml(scopeLabel)}</strong>
        <span class="scm-reconciliation-status ${escapeHtml(status)}">${escapeHtml(humanizeScmReconciliationKey(status))}</span>
      </span>
      <span>${scmReconciliationRunIsDry(run) ? "Dry run" : "Live run"} · ${escapeHtml(source)}</span>
      <small>${formatDate(startedAt) || "Not started"}</small>
      ${reviewCount ? `<span class="scm-reconciliation-run-review-count ${pendingDecisions ? "pending" : ""}">${pendingDecisions
        ? `${pendingDecisions.toLocaleString()} decision(s) pending`
        : `${reviewCount.toLocaleString()} reviewed order(s)`}</span>` : ""}
    </button>
  `;
}

function renderScmReconciliationSelectedRun(run) {
  const id = scmReconciliationRunId(run);
  const status = scmReconciliationRunStatus(run);
  const startedAt = firstDefined(run, ["startedAt", "started_at", "createdAt", "created_at"], "");
  const finishedAt = firstDefined(run, ["finishedAt", "finished_at", "completedAt", "completed_at", "updatedAt", "updated_at"], "");
  const source = String(firstDefined(run, ["source", "trigger", "triggerSource", "trigger_source", "runSource", "run_source"], "manual"));
  const error = String(firstDefined(run, ["error", "lastError", "last_error"], ""));
  const errorHeading = status === "interrupted"
    ? "Run interrupted"
    : status === "cancelled"
      ? "Run cancelled"
      : "Run failed";
  const detailsJson = scmReconciliationRunDetailsJson(run);
  const appliedRun = scmReconciliationAppliedRunFor(run);
  const pendingDecisions = scmReconciliationRunPendingDecisions(run);
  const reviewCount = scmReconciliationRunReviewCount(run);
  const scopeLabel = scmReconciliationRunScopeLabel(run);
  const hasStopRequest = scmReconciliationRunStopRequested(run);
  const stopRequested = scmReconciliationRunIsActive(run) && hasStopRequest;
  const stoppedSafely = status === "interrupted" && hasStopRequest;
  return `
    <article class="scm-reconciliation-run-card scm-reconciliation-selected-run ${scmReconciliationRunIsActive(run) ? "active" : ""}">
      <header>
        <div>
          <strong>${escapeHtml(scopeLabel)}</strong>
          <span>${scmReconciliationRunIsDry(run) ? "Dry run" : "Live run"} · ${escapeHtml(source)}</span>
        </div>
        <span class="scm-reconciliation-status ${escapeHtml(status)}">${escapeHtml(humanizeScmReconciliationKey(status))}</span>
      </header>
      <div class="scm-reconciliation-run-meta">
        <span>Started <strong>${formatDate(startedAt) || "—"}</strong></span>
        <span>Finished <strong>${formatDate(finishedAt) || "—"}</strong></span>
        ${id ? `<span>Run <strong>#${escapeHtml(id)}</strong></span>` : ""}
        ${appliedRun ? `<span>Applied by live run <strong>#${escapeHtml(scmReconciliationRunId(appliedRun))} · ${escapeHtml(humanizeScmReconciliationKey(scmReconciliationRunStatus(appliedRun)))}</strong></span>` : ""}
      </div>
      ${scmReconciliationRunProgressHtml(run)}
      ${stopRequested ? `<div class="notice"><strong>Stop requested</strong><span>The worker will finish its current atomic step, preserve recorded progress, and then mark this run Interrupted.</span></div>` : ""}
      ${stoppedSafely ? `<div class="notice"><strong>Stopped safely</strong><span>Recorded progress is preserved. Resume this run when you are ready to continue the remaining orders.</span></div>` : ""}
      ${scmReconciliationRunMetricHtml(run)}
      ${error ? `<div class="notice sync-error"><strong>${escapeHtml(errorHeading)}</strong><span>${escapeHtml(error)}</span></div>` : ""}
      ${scmReconciliationRunCanApply(run) && pendingDecisions > 0 ? `
        <div class="notice">
          <strong>Review decisions required</strong>
          <span>${pendingDecisions.toLocaleString()} of ${reviewCount.toLocaleString()} reviewed order(s) still need an action. Use the decision controls below before applying.</span>
        </div>
      ` : ""}
      <div class="actions">
        ${id && scmReconciliationRunIsActive(run)
          ? `<button class="danger" data-action="stop-scm-reconciliation-run" data-run-id="${escapeHtml(id)}" type="button" ${scmReconciliationBusy || stopRequested ? "disabled" : ""}>${stopRequested ? "Stopping…" : "Stop run"}</button>`
          : ""}
        ${id && scmReconciliationRunCanResume(run)
          ? `<button class="primary" data-action="resume-scm-reconciliation-run" data-run-id="${escapeHtml(id)}" type="button" ${scmReconciliationBusy || scmReconciliationRuns.some(scmReconciliationRunIsActive) ? "disabled" : ""}>Resume remaining orders</button>`
          : ""}
        ${scmReconciliationRunCanApply(run)
          ? `<button class="primary" data-action="apply-scm-reconciliation-run" data-run-id="${escapeHtml(id)}" type="button" ${scmReconciliationBusy || pendingDecisions > 0 || scmReconciliationRuns.some(scmReconciliationRunIsActive) ? "disabled" : ""}>Apply dry-run scope</button>`
          : ""}
        ${id ? `<button data-action="refresh-scm-reconciliation-run-details" data-run-id="${escapeHtml(id)}" type="button" ${scmReconciliationRunDetails.get(String(id))?.loading ? "disabled" : ""}>Refresh order details</button>` : ""}
        ${detailsJson ? `<details><summary>View result details</summary><pre>${escapeHtml(detailsJson)}</pre></details>` : ""}
      </div>
      ${id ? renderScmReconciliationRunTargets(id) : ""}
    </article>
  `;
}

function renderScmReconciliationSection() {
  if (!hasStaffAuthority(operator, ["admin"])) return "";
  const poToInitialApproved = scmReconciliationInitialApproved();
  const soInitialApproved = scmReconciliationSoInitialApproved();
  const initialApproved = poToInitialApproved && soInitialApproved;
  const approvalAt = firstDefined(scmReconciliationSettings, [
    "initialDryRunApprovedAt",
    "initial_dry_run_approved_at",
    "initialDryRunAppliedAt",
    "initial_dry_run_applied_at"
  ], "");
  const activeRun = scmReconciliationRuns.some(scmReconciliationRunIsActive);
  const broadSoScope = ["all", "SO"].includes(scmReconciliationScope);
  const fullRunMustBeDry = !scmReconciliationScopeApproved(
    scmReconciliationScope,
    scmReconciliationOrderKind,
    scmReconciliationSoOrderType
  );
  const runDisabled = scmReconciliationBusy || activeRun;
  const settingsDisabled = scmReconciliationBusy || !scmReconciliationSettingsLoaded;
  const latestRun = scmReconciliationRuns[0] || null;
  const selectedRun = scmReconciliationRuns.find((run) =>
    scmReconciliationRunId(run) === scmReconciliationSelectedRunId) || null;
  return `
    <section class="panel scm-reconciliation-panel">
      <div class="section-heading">
        <div>
          <h2>SO / PO / TO Reconciliation</h2>
          <p class="muted">Keep dispatch/operator Sales Orders and the PO/TO schedule aligned with current NetSuite headers, quantities, fulfillment, receipts, and exact Billed state. Reconciliation runs one NetSuite request at a time and yields to operational work.</p>
        </div>
        <button data-action="refresh-scm-reconciliation" type="button" ${scmReconciliationBusy ? "disabled" : ""}>Refresh</button>
      </div>
      ${scmReconciliationLoadError ? `
        <div class="notice sync-error" role="alert">
          <strong>Reconciliation controls could not be fully loaded</strong>
          <span>${escapeHtml(scmReconciliationLoadError)}</span>
        </div>
      ` : ""}
      <div class="scm-reconciliation-manual-bar">
        <div>
          <h3>Manual reconciliation</h3>
          <p class="muted">Run all orders, SO/PO/TO only, or targeted order families including their local splits.</p>
        </div>
        <form class="scm-reconciliation-run-form" data-form="scm-reconciliation-run">
          <label>
            <span>Scope</span>
            <select name="scope" data-field="scm-reconciliation-scope" ${runDisabled ? "disabled" : ""}>
              <option value="all" ${scmReconciliationScope === "all" ? "selected" : ""}>All SO / PO / TO</option>
              <option value="SO" ${scmReconciliationScope === "SO" ? "selected" : ""}>SO only</option>
              <option value="PO" ${scmReconciliationScope === "PO" ? "selected" : ""}>PO only</option>
              <option value="TO" ${scmReconciliationScope === "TO" ? "selected" : ""}>TO only</option>
              <option value="order_family" ${scmReconciliationScope === "order_family" ? "selected" : ""}>Target order families</option>
            </select>
          </label>
          <label>
            <span>SO type</span>
            <select name="soOrderType" data-field="scm-reconciliation-so-order-type" ${broadSoScope && !runDisabled ? "" : "disabled"}>
              <option value="delivery" ${scmReconciliationSoOrderType === "delivery" ? "selected" : ""}>Delivery</option>
              <option value="pickup" ${scmReconciliationSoOrderType === "pickup" ? "selected" : ""}>Pick-Up</option>
            </select>
            <small>For All, this filters only SO; PO and TO remain included.</small>
          </label>
          <label>
            <span>Family type</span>
            <select name="orderKind" data-field="scm-reconciliation-order-kind" ${scmReconciliationScope === "order_family" && !runDisabled ? "" : "disabled"}>
              <option value="SO" ${scmReconciliationOrderKind === "SO" ? "selected" : ""}>SO</option>
              <option value="PO" ${scmReconciliationOrderKind === "PO" ? "selected" : ""}>PO</option>
              <option value="TO" ${scmReconciliationOrderKind === "TO" ? "selected" : ""}>TO</option>
            </select>
          </label>
          <label class="scm-reconciliation-family-ref">
            <span>Source order references</span>
            <textarea name="orderRefs" data-field="scm-reconciliation-order-ref" rows="3" maxlength="4096" autocomplete="off" spellcheck="false" placeholder="SOB116645, POB03581&#10;or one reference per line" ${scmReconciliationScope === "order_family" && !runDisabled ? "" : "disabled"}>${escapeHtml(scmReconciliationOrderRef)}</textarea>
          </label>
          <div class="scm-reconciliation-run-options">
            <label class="scm-reconciliation-toggle compact">
              <input name="includeTerminalOrders" data-field="scm-reconciliation-include-terminal" type="checkbox" ${scmReconciliationScope !== "order_family" && scmReconciliationIncludeTerminalOrders ? "checked" : ""} ${scmReconciliationScope !== "order_family" && !runDisabled ? "" : "disabled"} />
              <span><strong>Include locally terminal / skipped orders</strong><small>Broad runs exclude Completed, Cancelled/closed, Hold, and saved Skip decisions by default. Targeted order-family runs inherently override this filter.</small></span>
            </label>
            <label class="scm-reconciliation-toggle compact">
              <input name="dryRun" data-field="scm-reconciliation-dry-run" type="checkbox" ${scmReconciliationDryRun || fullRunMustBeDry ? "checked" : ""} ${fullRunMustBeDry || runDisabled ? "disabled" : ""} />
              <span><strong>Dry run</strong><small>Calculate and report changes without applying them.</small></span>
            </label>
          </div>
          <button class="primary" type="submit" ${runDisabled ? "disabled" : ""}>${scmReconciliationBusy ? "Starting…" : activeRun ? "Run in progress" : "Start reconciliation"}</button>
        </form>
        <p class="muted" data-scm-reconciliation-run-help>${fullRunMustBeDry
          ? scmReconciliationSoOrderType === "pickup" && broadSoScope
            ? "Pick-Up reconciliation starts as a dry run. Review it, then use Apply dry-run scope."
            : "Initial safeguard: this full reconciliation must be reviewed as a dry run."
          : "Uncheck Dry run only when you are ready to apply unambiguous results immediately."}</p>
      </div>
      <div class="notice ${initialApproved ? "sync-success" : ""}">
        <strong>Initial full reconciliation: ${initialApproved ? "Approved and applied" : "Dry-run approval required"}</strong>
        <span>${initialApproved
          ? `Future unambiguous nightly Delivery SO / PO / TO results apply automatically.${approvalAt ? ` Approved ${formatDate(approvalAt)}.` : ""}`
          : `Approval state: SO Delivery ${soInitialApproved ? "approved" : "required"}; PO / TO ${poToInitialApproved ? "approved" : "required"}. A broad Delivery SO or All run must be reviewed and applied before nightly automation can update that scope.`}</span>
      </div>
      <details class="scm-reconciliation-settings-disclosure">
        <summary>
          <span><strong>Nightly reconciliation settings</strong><small>Runs after operational hours and waits when another NetSuite task is active.</small></span>
          <span class="scm-reconciliation-settings-state">${scmReconciliationSettings.nightlyEnabled ? "Enabled" : "Disabled"}</span>
        </summary>
        <form class="scm-reconciliation-settings" data-form="scm-reconciliation-settings" aria-busy="${scmReconciliationBusy ? "true" : "false"}">
          <label class="scm-reconciliation-toggle">
            <input name="nightlyEnabled" type="checkbox" ${scmReconciliationSettings.nightlyEnabled ? "checked" : ""} ${settingsDisabled ? "disabled" : ""} />
            <span><strong>Enable nightly reconciliation</strong><small>Apply future unambiguous results on schedule.</small></span>
          </label>
          <label>
            <span>Nightly start time</span>
            <input name="nightlyTime" type="time" required value="${escapeHtml(scmReconciliationSettings.nightlyTime || "21:30")}" ${settingsDisabled ? "disabled" : ""} />
          </label>
          <label>
            <span>Time zone</span>
            <input name="timeZone" value="${escapeHtml(scmReconciliationSettings.timeZone || SCM_RECONCILIATION_TIME_ZONE)}" readonly />
          </label>
          <label>
            <span>Initial backfill since</span>
            <input name="initialBackfillSince" type="date" required value="${escapeHtml(scmReconciliationSettings.initialBackfillSince || "2026-01-01")}" ${settingsDisabled ? "disabled" : ""} />
          </label>
          <button type="submit" ${settingsDisabled ? "disabled" : ""}>Save settings</button>
        </form>
      </details>
      <div class="control-visually-hidden" role="status" aria-live="polite">${latestRun
        ? `Latest reconciliation run ${escapeHtml(scmReconciliationRunId(latestRun))} is ${escapeHtml(humanizeScmReconciliationKey(scmReconciliationRunStatus(latestRun)))}.`
        : "No reconciliation runs yet."}</div>
      <div class="scm-reconciliation-workspace">
        <aside class="scm-reconciliation-run-browser" aria-label="Reconciliation runs">
          <div class="scm-reconciliation-run-browser-heading">
            <div>
              <h3>Run history</h3>
              <span>${scmReconciliationRuns.length.toLocaleString()} recent run(s)</span>
            </div>
          </div>
          <nav class="scm-reconciliation-run-list" data-control-scroll="reconciliation-run-list" aria-busy="${activeRun ? "true" : "false"}" aria-label="Select a reconciliation run">
            ${scmReconciliationRuns.map(renderScmReconciliationRunListItem).join("")
              || `<div class="notice"><strong>No reconciliation runs yet</strong><span>Start the initial full dry run above.</span></div>`}
          </nav>
        </aside>
        <section class="scm-reconciliation-selected-detail" aria-live="polite">
          ${selectedRun
            ? renderScmReconciliationSelectedRun(selectedRun)
            : `<div class="scm-reconciliation-empty-detail"><strong>Select a reconciliation run</strong><span>Run progress, results, reviewed orders, and apply controls will appear here.</span></div>`}
        </section>
      </div>
    </section>
  `;
}

function renderScmReconciliationSyncLink() {
  return `
    <section class="panel scm-reconciliation-link-panel">
      <div class="section-heading">
        <div>
          <h2>SO / PO / TO Reconciliation</h2>
          <p class="muted">Manual runs, run history, dry-run decisions, and apply controls now have a dedicated review page.</p>
        </div>
        <a class="scm-reconciliation-page-link" href="/admin/reconciliation">Open reconciliation</a>
      </div>
    </section>
  `;
}

function refreshScmReconciliationRunForm(form) {
  if (!form) return;
  const familyScope = scmReconciliationScope === "order_family";
  const broadSoScope = ["all", "SO"].includes(scmReconciliationScope);
  const activeRun = scmReconciliationRuns.some(scmReconciliationRunIsActive);
  const disabled = scmReconciliationBusy || activeRun;
  const kind = form.querySelector('[data-field="scm-reconciliation-order-kind"]');
  const soOrderType = form.querySelector('[data-field="scm-reconciliation-so-order-type"]');
  const orderRefs = form.querySelector('[data-field="scm-reconciliation-order-ref"]');
  const includeTerminal = form.querySelector('[data-field="scm-reconciliation-include-terminal"]');
  const dryRun = form.querySelector('[data-field="scm-reconciliation-dry-run"]');
  const forceInitialDryRun = !scmReconciliationScopeApproved(
    scmReconciliationScope,
    scmReconciliationOrderKind,
    scmReconciliationSoOrderType
  );
  if (kind) kind.disabled = !familyScope || disabled;
  if (soOrderType) {
    soOrderType.value = scmReconciliationSoOrderType;
    soOrderType.disabled = !broadSoScope || disabled;
  }
  if (orderRefs) orderRefs.disabled = !familyScope || disabled;
  if (includeTerminal) {
    includeTerminal.checked = !familyScope && scmReconciliationIncludeTerminalOrders;
    includeTerminal.disabled = familyScope || disabled;
  }
  if (dryRun) {
    dryRun.checked = forceInitialDryRun || scmReconciliationDryRun;
    dryRun.disabled = forceInitialDryRun || disabled;
  }
  const help = app.querySelector("[data-scm-reconciliation-run-help]");
  if (help) {
    help.textContent = forceInitialDryRun
      ? scmReconciliationSoOrderType === "pickup" && broadSoScope
        ? "Pick-Up reconciliation starts as a dry run. Review it, then use Apply dry-run scope."
        : "Initial safeguard: this full reconciliation must be reviewed as a dry run."
      : "Uncheck Dry run only when you are ready to apply unambiguous results immediately.";
  }
}

function renderSyncSection() {
  const isAuto = syncSettings.mode === "auto";
  const savedMaxRunMinutes = Math.max(1, Math.round(Number(syncSettings.maxRunSeconds || 900) / 60));
  const maxRunMinutes = syncMaxRunMinutesDraft ?? savedMaxRunMinutes;
  const mirrorPanel = renderNetSuiteMirrorPanel();
  const reconciliationLink = renderScmReconciliationSyncLink();
  if (mirrorStatus.role === "consumer") return `${mirrorPanel}${reconciliationLink}`;
  const targetedOrderPanel = renderTargetedOrderSyncPanel();
  return `${mirrorPanel}${reconciliationLink}${targetedOrderPanel}
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
      ${photos.filter(Boolean).map((photo, index) => `<img ${photoImgAttributes(photo)} alt="Warning photo ${index + 1}" />`).join("")}
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
  const publicSalesEnabled = publicSalesSettings.enabled === true;
  return `
    <div class="account-management-page">
      <section class="panel public-sales-access-card">
        <div>
          <p class="eyebrow">Sales portal</p>
          <h2>Public Sales Access</h2>
          <p class="muted">Allow customers to open Sales without a staff account. Turning this off requires a Sales or Admin login.</p>
        </div>
        <div class="public-sales-access-control">
          <span class="account-status-badge ${publicSalesEnabled ? "active" : "disabled"}">${publicSalesEnabled ? "On" : "Off"}</span>
          <button class="${publicSalesEnabled ? "danger" : "primary"}" data-action="toggle-public-sales" data-enabled="${!publicSalesEnabled}" type="button">
            Turn ${publicSalesEnabled ? "Off" : "On"}
          </button>
        </div>
      </section>
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
      <fieldset class="authority-picker">
        <legend>${t("control.salesYards", "Sales yard access")}</legend>
        <p class="muted">${t("control.salesYardsHelp", "Sales schedule, Sales Orders, printers, and print jobs are limited to these yards.")}</p>
        <div class="authority-choice-grid">${renderSalesYardChoices([], "data-new-sales-yard")}</div>
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
        <div>
          <span class="field-label">${t("control.salesYards", "Sales yard access")}</span>
          <p class="muted">${t("control.salesYardsHelp", "Sales schedule, Sales Orders, printers, and print jobs are limited to these yards.")}</p>
          <div class="authority-choice-grid">${renderSalesYardChoices(item.yardLocationIds, "data-account-sales-yard")}</div>
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
            <th>Return Policy</th>
            <th>${t("control.brand", "Brand")}</th>
            <th>${t("control.series", "Series")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${classifications.map((item) => `
            <tr data-item-row="${item.item_id}">
              <td><strong>${item.item_id}</strong></td>
              <td><strong>${escapeHtml(item.item_name || "")}</strong><br><span class="muted">${escapeHtml(item.display_name || "")}</span></td>
              <td>${escapeHtml(item.item_description || "")}</td>
              <td>${valueText(item.total_on_hand)}</td>
              <td>${valueText(item.total_available)}</td>
              <td><input data-field="productType" data-original-value="${escapeHtml(valueText(item.product_type))}" value="${escapeHtml(valueText(item.product_type))}" /></td>
              <td>
                <select data-field="returnPolicyOverride" data-original-value="${escapeHtml(classificationReturnPolicy(item).override || "DEFAULT")}" ${hasStaffAuthority(operator, ["admin"]) ? "" : "disabled"}>
                  ${classificationReturnPolicyOptions(item)}
                </select>
                <br><span class="muted" data-field="returnPolicySource">Company-wide · ${classificationReturnPolicy(item).override ? "Admin override" : "Product Type default"}</span>
              </td>
              <td><input data-field="brand" data-original-value="${escapeHtml(valueText(item.brand))}" value="${escapeHtml(valueText(item.brand))}" /></td>
              <td><input data-field="series" data-original-value="${escapeHtml(valueText(item.series))}" value="${escapeHtml(valueText(item.series))}" /></td>
              <td><button class="primary" data-action="save-classification" data-item="${item.item_id}">${t("common.save", "Save")}</button></td>
            </tr>
          `).join("") || `<tr><td colspan="10" class="muted">${t("control.noItems", "No items yet. Click Sync Inventory.")}</td></tr>`}
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

async function loadReturnDetail(id = selectedReturnId) {
  if (!id) {
    returnDetail = null;
    return;
  }
  returnDetail = await request(`/api/returns/${encodeURIComponent(id)}`);
}

async function loadReturnRecords({ keepSelection = true } = {}) {
  returnLoadError = "";
  try {
    const [payload, dashboardPayload] = await Promise.all([
      request(`/api/returns?${returnListQuery()}`),
      request("/api/returns?limit=1&offset=0").catch(() => null)
    ]);
    returnRecords = Array.isArray(payload) ? payload : (payload.records || payload.returns || []);
    returnCounts = Array.isArray(payload) ? {} : (payload.counts || {});
    if (dashboardPayload && !Array.isArray(dashboardPayload)) {
      returnDashboardCounts = dashboardPayload.counts || {};
    }
    const availableIds = new Set(returnRecords.map(returnRecordId).filter(Boolean));
    if (!keepSelection || !availableIds.has(String(selectedReturnId))) {
      selectedReturnId = returnRecordId(returnRecords[0] || {});
    }
    if (selectedReturnId) {
      localStorage.setItem("mbbs.control.returns.selected", selectedReturnId);
      try {
        await loadReturnDetail(selectedReturnId);
      } catch (error) {
        returnDetail = null;
        returnLoadError = error.message;
      }
    } else {
      returnDetail = null;
    }
  } catch (error) {
    returnRecords = [];
    returnCounts = {};
    returnDetail = null;
    returnLoadError = error.message;
  }
}

async function loadControlReturnSettings() {
  returnSettingsError = "";
  try {
    const payload = await request("/api/control/return-settings");
    const settings = Array.isArray(payload) ? payload : (payload.settings || payload.yards || []);
    controlReturnSettings = settings.map((rawSetting) => {
      const setting = rawSetting.setting || rawSetting.yard || rawSetting;
      const fallback = SALES_YARD_OPTIONS.find(
        (yard) => Number(yard.locationId) === Number(setting.locationId ?? setting.location_id)
      ) || {};
      return {
        ...fallback,
        ...setting,
        locationId: Number(setting.locationId ?? setting.location_id ?? fallback.locationId),
        yardCode: setting.yardCode || setting.yard_code || fallback.yardCode,
        allowCrossYardReturns: Boolean(setting.allowCrossYardReturns ?? setting.allow_cross_yard_returns)
      };
    });
  } catch (error) {
    controlReturnSettings = [];
    returnSettingsError = error.message;
  }
}

async function loadAdminReturnSettings() {
  returnSettingsError = "";
  try {
    const payload = await request("/api/admin/return-settings");
    const settings = Array.isArray(payload) ? payload : (payload.yards || payload.settings || []);
    const byLocation = new Map(settings.map((setting) => [
      Number(setting.locationId ?? setting.location_id),
      setting
    ]));
    adminReturnSettings = SALES_YARD_OPTIONS.map((yard) => {
      const setting = byLocation.get(yard.locationId) || {};
      return {
        ...yard,
        ...setting,
        locationId: yard.locationId,
        yardCode: setting.yardCode || setting.yard_code || yard.yardCode,
        autoCreateStockReturnAuthorization: Boolean(
          setting.autoCreateStockReturnAuthorization
          ?? setting.auto_create_stock_return_authorization
          ?? setting.autoCreateStockRa
          ?? setting.auto_create_stock_ra
        ),
        autoCreatePalletCreditMemo: Boolean(
          setting.autoCreatePalletCreditMemo ?? setting.auto_create_pallet_credit_memo
        )
      };
    });
  } catch (error) {
    adminReturnSettings = [];
    returnSettingsError = error.message;
  }
}

async function loadControlData() {
  if (IS_ADMIN_PAGE) {
    const [nextOperators, nextAuditOptions, nextAudit, nextSyncSettings, nextEnvSettings, nextPhotoArchiveSettings, nextMirrorStatus, nextPublicSalesSettings] = await Promise.all([
      request("/api/operators"),
      request(auditOptionsQueryString()),
      request(auditQueryString()),
      request("/api/control/sync-settings"),
      request("/api/control/env-settings"),
      request("/api/admin/photo-archive"),
      request("/api/admin/netsuite-mirror"),
      request("/api/admin/public-sales")
    ]);
    operators = nextOperators;
    auditOptions = nextAuditOptions;
    audit = nextAudit;
    syncSettings = nextSyncSettings;
    envSettings = nextEnvSettings;
    photoArchiveSettings = nextPhotoArchiveSettings;
    mirrorStatus = nextMirrorStatus;
    publicSalesSettings = nextPublicSalesSettings;
    await Promise.all([
      loadAdminReturnSettings(),
      loadScmReconciliationControl()
    ]);
  } else {
    classifications = await request(`/api/inventory/classifications?limit=300${classificationSearch ? `&search=${encodeURIComponent(classificationSearch)}` : ""}`);
    cycleRecords = await request("/api/cycle-count/records?limit=50");
    fulfillmentRecords = await request("/api/delivery/fulfillments?limit=100");
    recordWarnings = await request("/api/control/record-warnings?limit=100");
    orderLocks = await request("/api/control/order-locks");
    vendorMappings = await request("/api/control/vendor-mappings");
    await loadLoadedOrders({ keepSelection: true });
    if (isLoadedSearchActive()) await loadLoadedSearchResults();
    await Promise.all([
      loadReturnRecords({ keepSelection: true }),
      loadControlReturnSettings()
    ]);
  }
  render();
}

app.addEventListener("submit", async (event) => {
  const form = event.target.closest("form");
  if (!form) return;
  event.preventDefault();
  try {
    if (form.dataset.form === "scm-reconciliation-settings") {
      await saveScmReconciliationSettings(form);
      return;
    }
    if (form.dataset.form === "scm-reconciliation-run") {
      await startScmReconciliationRun(form);
      return;
    }
    if (form.dataset.form === "manual-return-link") {
      const formData = new FormData(form);
      const netsuiteId = String(formData.get("netsuiteId") || "").trim();
      const netsuiteTranid = String(formData.get("netsuiteTranid") || "").trim().toUpperCase();
      if (!/^\d+$/.test(netsuiteId)) throw new Error("Enter the NetSuite numeric internal ID.");
      if (!confirm(`Link this local return to ${netsuiteTranid || `NetSuite internal ID ${netsuiteId}`}? The server will validate the customer, quantities, and transaction type.`)) return;
      await request(`/api/returns/${encodeURIComponent(form.dataset.id)}/netsuite-link`, {
        method: "POST",
        body: JSON.stringify({
          transactionType: String(formData.get("transactionType") || ""),
          netsuiteId,
          netsuiteTranid: netsuiteTranid || undefined
        })
      });
      await loadReturnRecords({ keepSelection: true });
      render();
      alert("NetSuite transaction linked.");
      return;
    }
    if (form.dataset.form === "targeted-order-sync") {
      targetedSyncOrderRef = String(form.elements.orderRef?.value || "").trim().toUpperCase();
      if (!targetedSyncOrderRef) {
        targetedSyncResult = { ok: false, error: t("control.enterOrderNumber", "Enter a NetSuite SO, PO, or TO order number.") };
        return render();
      }
      targetedSyncBusy = true;
      targetedSyncResult = null;
      render();
      try {
        targetedSyncResult = await request("/api/control/sync-order", {
          method: "POST",
          body: JSON.stringify({ orderRef: targetedSyncOrderRef })
        });
        targetedSyncOrderRef = targetedSyncResult.orderRef || targetedSyncOrderRef;
      } catch (error) {
        targetedSyncResult = { ok: false, error: error.message };
      } finally {
        targetedSyncBusy = false;
        render();
      }
      return;
    }
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
      const yardLocationIds = [...document.querySelectorAll("[data-new-sales-yard]:checked")].map((input) => Number(input.value));
      if (!roles.includes(primaryRole)) roles.push(primaryRole);
      const created = await request("/api/operators", {
        method: "POST",
        body: JSON.stringify({
          username: document.getElementById("newUsername").value,
          displayName: document.getElementById("newDisplayName").value,
          password: document.getElementById("newPassword").value,
          role: primaryRole,
          roles,
          yardLocationIds
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
    if (button.dataset.action === "refresh-scm-reconciliation") {
      scmReconciliationBusy = true;
      if (scmReconciliationSelectedRunId) {
        scmReconciliationRunDetails.delete(scmReconciliationSelectedRunId);
      }
      render();
      try {
        await loadScmReconciliationControl();
      } finally {
        scmReconciliationBusy = false;
        render();
      }
      return;
    }
    if (button.dataset.action === "select-scm-reconciliation-run") {
      await selectScmReconciliationRun(button.dataset.runId);
      return;
    }
    if (button.dataset.action === "apply-scm-reconciliation-run") {
      await applyScmReconciliationRun(button.dataset.runId);
      return;
    }
    if (button.dataset.action === "stop-scm-reconciliation-run") {
      await stopScmReconciliationRun(button.dataset.runId);
      return;
    }
    if (button.dataset.action === "resume-scm-reconciliation-run") {
      await resumeScmReconciliationRun(button.dataset.runId);
      return;
    }
    if (button.dataset.action === "save-scm-reconciliation-target-decision") {
      await saveScmReconciliationTargetDecision(button);
      return;
    }
    if (button.dataset.action === "refresh-scm-reconciliation-run-details") {
      await loadScmReconciliationRunDetails(button.dataset.runId);
      return;
    }
    if (button.dataset.action === "load-more-scm-reconciliation-targets") {
      await loadScmReconciliationRunDetails(button.dataset.runId, { append: true });
      return;
    }
    if (button.dataset.action === "refresh") return loadControlData();
    if (button.dataset.action === "refresh-return-records") {
      await Promise.all([
        loadReturnRecords({ keepSelection: true }),
        loadControlReturnSettings()
      ]);
      return render();
    }
    if (button.dataset.action === "set-return-view") {
      returnFilters.status = button.dataset.status || "";
      returnRecordOffset = 0;
      saveReturnFilters();
      await loadReturnRecords({ keepSelection: false });
      return render();
    }
    if (button.dataset.action === "apply-return-filters") {
      app.querySelectorAll("[data-return-filter]").forEach((input) => {
        returnFilters[input.dataset.returnFilter] = input.value || "";
      });
      saveReturnFilters();
      returnRecordOffset = 0;
      await loadReturnRecords({ keepSelection: false });
      return render();
    }
    if (button.dataset.action === "reset-return-filters") {
      returnFilters = { search: "", status: "", type: "", yardLocationId: "", from: "", to: "" };
      returnRecordOffset = 0;
      saveReturnFilters();
      await loadReturnRecords({ keepSelection: false });
      return render();
    }
    if (button.dataset.action === "return-page-prev" || button.dataset.action === "return-page-next") {
      returnRecordOffset = Math.max(
        0,
        returnRecordOffset + (button.dataset.action === "return-page-next"
          ? RETURN_RECORD_PAGE_SIZE
          : -RETURN_RECORD_PAGE_SIZE)
      );
      await loadReturnRecords({ keepSelection: false });
      return render();
    }
    if (button.dataset.action === "select-return-record") {
      selectedReturnId = button.dataset.id || "";
      if (selectedReturnId) localStorage.setItem("mbbs.control.returns.selected", selectedReturnId);
      returnLoadError = "";
      try {
        await loadReturnDetail(selectedReturnId);
      } catch (error) {
        returnDetail = null;
        returnLoadError = error.message;
      }
      return render();
    }
    if (button.dataset.action === "decide-return-line") {
      if (!selectedReturnId) return;
      const approved = button.dataset.decision === "approved";
      const note = prompt(approved
        ? "Optional approval note:"
        : "Rejection reason (required):");
      if (note === null) return;
      if (!approved && !note.trim()) return alert("A rejection reason is required.");
      if (!confirm(`${approved ? "Approve" : "Reject"} this full return-line quantity?`)) return;
      await request(`/api/returns/${encodeURIComponent(selectedReturnId)}/lines/${encodeURIComponent(button.dataset.lineId)}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: button.dataset.decision, note: note.trim() || undefined })
      });
      await loadReturnRecords({ keepSelection: true });
      return render();
    }
    if (button.dataset.action === "void-return") {
      const reason = prompt("Void reason (required):");
      if (reason === null) return;
      if (!reason.trim()) return alert("A void reason is required.");
      if (!confirm(`Void ${returnReference(returnHeader())}? Submitted details remain in the audit history.`)) return;
      await request(`/api/returns/${encodeURIComponent(button.dataset.id)}/void`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() })
      });
      await loadReturnRecords({ keepSelection: true });
      return render();
    }
    if (button.dataset.action === "discard-return-draft") {
      const reason = prompt("Optional reason for discarding this draft:");
      if (reason === null) return;
      if (!confirm("Discard this server draft? It cannot be resumed after deletion.")) return;
      await request(`/api/returns/drafts/${encodeURIComponent(button.dataset.id)}/discard`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() || undefined })
      });
      selectedReturnId = "";
      localStorage.removeItem("mbbs.control.returns.selected");
      await loadReturnRecords({ keepSelection: false });
      return render();
    }
    if (button.dataset.action === "retry-return-sync") {
      if (!confirm("Retry NetSuite processing using the existing idempotency key?")) return;
      await request(`/api/returns/${encodeURIComponent(button.dataset.id)}/sync/retry`, {
        method: "POST",
        body: "{}"
      });
      await loadReturnRecords({ keepSelection: true });
      return render();
    }
    if (button.dataset.action === "save-cross-yard-setting") {
      const locationId = Number(button.dataset.locationId);
      const card = app.querySelector(`[data-return-yard="${locationId}"]`);
      const allowCrossYardReturns = Boolean(card?.querySelector('[data-return-setting="allowCrossYardReturns"]')?.checked);
      const yardCode = SALES_YARD_OPTIONS.find((yard) => yard.locationId === locationId)?.yardCode || locationId;
      const explanation = allowCrossYardReturns
        ? `${yardCode} will accept stock from both its own orders and orders from other yards. PALLET returns remain accepted at every yard.`
        : `${yardCode} will accept only its own ordering-yard stock returns. PALLET returns remain accepted at every yard.`;
      if (!confirm(`${explanation} Save this setting?`)) return;
      await request(`/api/control/return-settings/${locationId}`, {
        method: "PUT",
        body: JSON.stringify({ allowCrossYardReturns })
      });
      await loadControlReturnSettings();
      return render();
    }
    if (button.dataset.action === "refresh-return-automation") {
      await loadAdminReturnSettings();
      return render();
    }
    if (button.dataset.action === "save-return-automation") {
      const locationId = Number(button.dataset.locationId);
      const card = app.querySelector(`[data-return-automation-yard="${locationId}"]`);
      const autoCreateStockReturnAuthorization = Boolean(
        card?.querySelector('[data-return-setting="autoCreateStockReturnAuthorization"]')?.checked
      );
      const autoCreatePalletCreditMemo = Boolean(
        card?.querySelector('[data-return-setting="autoCreatePalletCreditMemo"]')?.checked
      );
      const yardCode = SALES_YARD_OPTIONS.find((yard) => yard.locationId === locationId)?.yardCode || locationId;
      if ((autoCreateStockReturnAuthorization || autoCreatePalletCreditMemo)
        && !confirm(`Enable live NetSuite return automation for yard ${yardCode}? Submitted returns may create real NetSuite transactions.`)) return;
      const result = await request(`/api/admin/return-settings/${locationId}`, {
        method: "PUT",
        body: JSON.stringify({
          autoCreateStockRa: autoCreateStockReturnAuthorization,
          autoCreateStockReturnAuthorization,
          autoCreatePalletCreditMemo
        })
      });
      const updated = result.setting || result.yard || result;
      adminReturnSettings = adminReturnSettings.map((yard) => Number(yard.locationId) === locationId
        ? {
            ...yard,
            ...updated,
            autoCreateStockReturnAuthorization: Boolean(
              updated.autoCreateStockReturnAuthorization
              ?? updated.auto_create_stock_return_authorization
              ?? updated.autoCreateStockRa
              ?? updated.auto_create_stock_ra
              ?? autoCreateStockReturnAuthorization
            ),
            autoCreatePalletCreditMemo: Boolean(
              updated.autoCreatePalletCreditMemo
              ?? updated.auto_create_pallet_credit_memo
              ?? autoCreatePalletCreditMemo
            )
          }
        : yard);
      alert(`Return automation settings saved for ${yardCode}.`);
      return render();
    }
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
    if (button.dataset.action === "authorize-sales-order-reload") {
      if (!loadedOrderDetail?.order) return;
      openSalesOrderReloadDialog(loadedOrderDetail.order);
      return;
    }
    if (button.dataset.action === "cancel-sales-order-reload") {
      if (!loadedOrderDetail?.order || !loadedOrderDetail.activeReloadCycle) return;
      openSalesOrderReloadDialog(loadedOrderDetail.order, {
        cancel: true,
        cycle: loadedOrderDetail.activeReloadCycle
      });
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
    if (button.dataset.action === "retry-netsuite-mirror") {
      button.disabled = true;
      button.textContent = "Retrying...";
      const result = await request("/api/admin/netsuite-mirror/retry", { method: "POST", body: "{}" });
      mirrorStatus = result.status || await request("/api/admin/netsuite-mirror");
      render();
      alert("NetSuite mirror retry and catch-up completed.");
      return;
    }
    if (button.dataset.action === "reconcile-netsuite-mirror") {
      if (!confirm("Run a full reconciliation of all NetSuite-backed orders and inventory from the current server? V2 planning and workflow fields will be preserved.")) return;
      button.disabled = true;
      button.textContent = "Reconciling...";
      const result = await request("/api/admin/netsuite-mirror/reconcile", { method: "POST", body: "{}" });
      mirrorStatus = result.status || await request("/api/admin/netsuite-mirror");
      render();
      alert("Full NetSuite mirror reconciliation completed.");
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
      if (!row) throw new Error("Item row is no longer available. Reload Item Classification.");
      const productTypeInput = row.querySelector('[data-field="productType"]');
      const brandInput = row.querySelector('[data-field="brand"]');
      const seriesInput = row.querySelector('[data-field="series"]');
      const policyInput = row.querySelector('[data-field="returnPolicyOverride"]');
      const selectedPolicy = policyInput?.value || "DEFAULT";
      const originalPolicy = policyInput?.dataset.originalValue || "DEFAULT";
      const payload = {};
      for (const [field, input] of [
        ["productType", productTypeInput],
        ["brand", brandInput],
        ["series", seriesInput]
      ]) {
        if (String(input?.value || "") !== String(input?.dataset.originalValue || "")) {
          payload[field] = input?.value || "";
        }
      }
      const policyChanged = hasStaffAuthority(operator, ["admin"])
        && selectedPolicy !== originalPolicy;
      if (policyChanged) {
        payload.returnPolicyOverride = selectedPolicy === "DEFAULT" ? null : selectedPolicy;
      }
      if (Object.hasOwn(payload, "productType") || policyChanged) {
        payload.expectedReturnPolicyContext = {
          productType: productTypeInput?.dataset.originalValue || "",
          returnPolicyOverride: originalPolicy === "DEFAULT" ? null : originalPolicy
        };
      }
      if (!Object.keys(payload).length) {
        alert("No Item Classification changes to save.");
        return;
      }
      await request(`/api/inventory/classifications/${button.dataset.item}`, {
        method: "PUT",
        body: JSON.stringify(payload)
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
      clearScmReconciliationPoll();
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
    if (button.dataset.action === "toggle-public-sales") {
      const enabled = button.dataset.enabled === "true";
      const action = enabled ? "turn on" : "turn off";
      if (!confirm(`Are you sure you want to ${action} Public Sales access?`)) return;
      button.disabled = true;
      publicSalesSettings = await request("/api/admin/public-sales", {
        method: "PUT",
        body: JSON.stringify({ enabled })
      });
      alert(`Public Sales access is now ${enabled ? "on" : "off"}.`);
      return render();
    }
    if (button.dataset.action === "save-account-roles") {
      const row = button.closest("[data-account-row]");
      const role = row?.querySelector("[data-account-primary-role]")?.value || "operator";
      const roles = [...(row?.querySelectorAll("[data-account-authority]:checked") || [])].map((input) => input.value);
      const yardLocationIds = [...(row?.querySelectorAll("[data-account-sales-yard]:checked") || [])].map((input) => Number(input.value));
      if (!roles.includes(role)) roles.push(role);
      await request(`/api/operators/${button.dataset.id}/roles`, {
        method: "PUT",
        body: JSON.stringify({ role, roles, yardLocationIds })
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
  if (event.target?.matches?.("[data-review-decision-note]")) {
    updateScmReconciliationTargetDecisionDraft(
      event.target.closest("[data-reconciliation-target-decision]")
    );
    return;
  }
  if (event.target?.dataset?.field === "productType") {
    refreshClassificationReturnPolicy(event.target.closest("[data-item-row]"));
    return;
  }
  if (event.target?.id === "targetedSyncOrderRef") {
    targetedSyncOrderRef = event.target.value || "";
    targetedSyncResult = null;
    return;
  }
  if (event.target?.dataset?.field === "scm-reconciliation-order-ref") {
    scmReconciliationOrderRef = event.target.value || "";
    return;
  }
  if (event.target?.dataset?.field !== "sync-max-run-minutes") return;
  const value = Number(event.target.value);
  syncMaxRunMinutesDraft = Number.isFinite(value) && value >= 0 ? event.target.value : "";
});

app.addEventListener("change", (event) => {
  if (event.target?.matches?.("[data-review-decision]")) {
    updateScmReconciliationTargetDecisionDraft(
      event.target.closest("[data-reconciliation-target-decision]")
    );
    render();
    return;
  }
  if (event.target?.dataset?.field === "scm-reconciliation-scope") {
    scmReconciliationScope = event.target.value || "all";
    refreshScmReconciliationRunForm(event.target.closest("form"));
    return;
  }
  if (event.target?.dataset?.field === "scm-reconciliation-so-order-type") {
    scmReconciliationSoOrderType = event.target.value === "pickup" ? "pickup" : "delivery";
    refreshScmReconciliationRunForm(event.target.closest("form"));
    return;
  }
  if (event.target?.dataset?.field === "scm-reconciliation-order-kind") {
    scmReconciliationOrderKind = event.target.value || "PO";
    return;
  }
  if (event.target?.dataset?.field === "scm-reconciliation-include-terminal") {
    scmReconciliationIncludeTerminalOrders = Boolean(event.target.checked);
    return;
  }
  if (event.target?.dataset?.field === "scm-reconciliation-dry-run") {
    scmReconciliationDryRun = Boolean(event.target.checked);
    return;
  }
  if (event.target?.dataset?.field === "returnPolicyOverride") {
    refreshClassificationReturnPolicy(event.target.closest("[data-item-row]"));
    return;
  }
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

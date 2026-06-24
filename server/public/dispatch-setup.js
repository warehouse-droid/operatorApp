const setupApp = document.getElementById("dispatchSetupApp");

let setupTab = "drivers";
let selectedSetupIndex = null;
let drivers = [
  { name: "Alex Wong", license: "AZ", number: "A90211", login: "alex", ownYardFixedMinutes: 42, outsideFixedMinutes: 36, minutesPerPallet: 1, loadMinutes: 42, unloadMinutes: 36 },
  { name: "Jenny Lee", license: "DZ", number: "D18870", login: "jenny", ownYardFixedMinutes: 38, outsideFixedMinutes: 32, minutesPerPallet: 1, loadMinutes: 38, unloadMinutes: 32 }
];
let trucks = [
  { plate: "MBBS-101", capacityLbs: 48000 },
  { plate: "MBBS-205", capacityLbs: 44000 },
  { plate: "MBBS-318", capacityLbs: 52000 }
];
let vendorYards = [];
let parserRules = [];
let ollamaAudit = [];
let dispatchAudit = [];
let setupNotice = "";
let selectedVendor = "";
let selectedYard = "";
let vendorAddMode = false;
let expandedAuditId = "";
let expandedDispatchAuditId = "";
let eventSource = null;
let setupRefreshTimer = null;
const WEEK_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

async function api(path, options = {}) {
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

async function loadVendorYards() {
  try {
    vendorYards = await api("/api/dispatch/vendor-yards");
    if (!selectedVendor) selectedVendor = [...new Set(vendorYards.map((row) => row.vendor))][0] || "";
    if (!selectedYard) selectedYard = vendorYards.find((row) => row.vendor === selectedVendor)?.yard || "";
  } catch (error) {
    setupNotice = `Vendor table failed to load: ${error.message}`;
  }
}

async function loadDispatchSetup() {
  try {
    const setup = await api("/api/dispatch/setup");
    if (Array.isArray(setup.drivers)) drivers = setup.drivers;
    if (Array.isArray(setup.trucks)) trucks = setup.trucks;
  } catch (error) {
    setupNotice = `Dispatch setup failed to load: ${error.message}`;
  }
}

async function saveDispatchSetup() {
  const saved = await api("/api/dispatch/setup", {
    method: "PUT",
    body: JSON.stringify({ drivers, trucks })
  });
  if (Array.isArray(saved.drivers)) drivers = saved.drivers;
  if (Array.isArray(saved.trucks)) trucks = saved.trucks;
}

async function loadParserRules() {
  try {
    parserRules = await api("/api/dispatch/parser-rules");
  } catch (error) {
    setupNotice = `Parser rules failed to load: ${error.message}`;
  }
}

async function loadOllamaAudit() {
  try {
    ollamaAudit = await api("/api/dispatch/ollama-audit?limit=80");
  } catch (error) {
    setupNotice = `Ollama audit failed to load: ${error.message}`;
  }
}

async function loadDispatchAudit() {
  try {
    dispatchAudit = await api("/api/dispatch/audit?limit=200");
  } catch (error) {
    setupNotice = `Dispatch log failed to load: ${error.message}`;
  }
}

function connectEvents() {
  if (eventSource) return;
  eventSource = new EventSource("/api/events?client=dispatch-setup");
  eventSource.addEventListener("app-event", (message) => {
    let event;
    try {
      event = JSON.parse(message.data || "{}");
    } catch {
      return;
    }
    if (event.type === "connected") return;
    const setupEvents = ["dispatch.setup.updated", "dispatch.vendor_yard.updated"];
    const auditEvents = [
      "dispatch.plan.saved",
      "dispatch.plan.confirmed",
      "dispatch.plan.reopened",
      "dispatch.operator_request.created",
      "dispatch.orders.updated",
      "delivery.order.unpacked",
      "delivery.order.loaded",
      "driver.job.started",
      "driver.job.completed"
    ];
    if (!setupEvents.includes(event.type) && !auditEvents.includes(event.type)) return;
    window.clearTimeout(setupRefreshTimer);
    setupRefreshTimer = window.setTimeout(async () => {
      try {
        if (setupEvents.includes(event.type)) {
          await loadDispatchSetup();
          await loadVendorYards();
        }
        if (auditEvents.includes(event.type)) await loadDispatchAudit();
        renderSetup();
      } catch (error) {
        setupNotice = `Auto refresh failed: ${error.message}`;
        renderSetup();
      }
    }, 500);
  });
  eventSource.onerror = () => {
    eventSource?.close();
    eventSource = null;
    window.setTimeout(connectEvents, 3000);
  };
}

function formatLbs(value) {
  return `${Math.round(Number(value || 0)).toLocaleString()} lb`;
}

function truckCapacityLbs(truck) {
  return Number(truck?.capacityLbs || 0) || Number(truck?.capacity || 0) * 2000 || 48000;
}

function ownYardFixedMinutesFor(driver) {
  return Number(driver?.ownYardFixedMinutes || driver?.loadMinutes || 40);
}

function outsideFixedMinutesFor(driver) {
  return Number(driver?.outsideFixedMinutes || driver?.unloadMinutes || 35);
}

function minutesPerPalletFor(driver) {
  return Number(driver?.minutesPerPallet || 1);
}

function displayTime24(value) {
  const match = String(value || "").match(/^(\d{2}):?(\d{2})$/);
  return match ? `${match[1]}${match[2]}` : "";
}

function normalizeTime24(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length !== 4) return "";
  const hour = Number(digits.slice(0, 2));
  const minute = Number(digits.slice(2, 4));
  if (hour > 23 || minute > 59) return "";
  return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
}

function titleCaseAction(action) {
  return String(action || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function compactAuditTarget(row) {
  return row.orderId || row.loadId || row.truckId || row.entityId || row.entityType || "";
}

function compactAuditDetails(row) {
  const details = row.details || {};
  const parts = [];
  if (details.order?.id) parts.push(`Order ${details.order.id}`);
  if (details.orderId) parts.push(`Order ${details.orderId}`);
  if (details.stopType) parts.push(details.stopType);
  if (details.fromLoadId || details.toLoadId) parts.push(`${details.fromLoadId || "-"} -> ${details.toLoadId || "-"}`);
  if (details.sourceYard) parts.push(`From ${details.sourceYard}`);
  if (details.vendorYardId) parts.push(`Vendor yard ${details.vendorYardId}`);
  if (details.windowStart || details.windowEnd) parts.push(`${details.windowStart || "--"}-${details.windowEnd || "--"}`);
  return parts.filter(Boolean).join(" | ");
}

function renderJsonBlock(label, value) {
  if (value === undefined || value === null || value === "") return "";
  return `<strong>${label}</strong><code>${escapeHtml(JSON.stringify(value, null, 2))}</code>`;
}

function renderSetup() {
  setupApp.innerHTML = `
    <section class="dispatch-shell setup-shell">
      <header class="dispatch-topbar">
        <div>
          <p>MBBS Transportation</p>
          <h1>Dispatch Setup</h1>
        </div>
        <div></div>
        <div class="topbar-actions">
          <button onclick="location.href='/dispatch'" type="button">Dispatch Menu</button>
          <button onclick="location.href='/dispatch/planning'" type="button">Back to Planner</button>
          <button class="primary" data-action="save-dispatch-setup" type="button">Save Setup</button>
        </div>
      </header>
      <div class="setup-page">
        <section class="panel">
          <div class="panel-header">
            <h2>Setup Menu</h2>
            <p>Maintain dispatch resources.</p>
          </div>
          <div class="setup-menu">
            <button class="${setupTab === "drivers" ? "active" : ""}" data-tab="drivers" type="button">Drivers</button>
            <button class="${setupTab === "trucks" ? "active" : ""}" data-tab="trucks" type="button">Trucks</button>
            <button class="${setupTab === "vendors" ? "active" : ""}" data-tab="vendors" type="button">Vendor Hours</button>
            <button class="${setupTab === "parser" ? "active" : ""}" data-tab="parser" type="button">Parser Rules</button>
            <button class="${setupTab === "dispatch-log" ? "active" : ""}" data-tab="dispatch-log" type="button">Dispatch Log</button>
            <button class="${setupTab === "audit" ? "active" : ""}" data-tab="audit" type="button">Ollama Audit</button>
          </div>
        </section>
        <section class="panel">
          <div class="panel-header">
            <h2>${setupTab === "drivers" ? "Driver Registration" : setupTab === "trucks" ? "Truck Registration" : setupTab === "vendors" ? "Vendor Address & Hours" : setupTab === "parser" ? "Label Parser Rules" : setupTab === "dispatch-log" ? "Dispatch Action Log" : "Ollama Input & Output Audit"}</h2>
            <p>${setupTab === "drivers" ? "Driver login, license, and service speed." : setupTab === "trucks" ? "Vehicle plate and weight capacity." : setupTab === "vendors" ? "Used to match PO vendor yards and plan pickup windows." : setupTab === "parser" ? "Maintain address/time labels and default meanings such as PM or whole day." : setupTab === "dispatch-log" ? "Review planner updates, drag/drop actions, load changes, and manual edits." : "Review parser prompts, model responses, and parsed results."}</p>
          </div>
          ${setupNotice ? `<div class="setup-notice">${escapeHtml(setupNotice)}</div>` : ""}
          ${setupTab === "drivers" ? renderDrivers() : setupTab === "trucks" ? renderTrucks() : setupTab === "vendors" ? renderVendorYards() : setupTab === "parser" ? renderParserRules() : setupTab === "dispatch-log" ? renderDispatchAudit() : renderOllamaAudit()}
        </section>
      </div>
    </section>
  `;
}

function renderDrivers() {
  const selected = Number.isInteger(selectedSetupIndex) ? drivers[selectedSetupIndex] : null;
  return `
    <div class="setup-content">
      <div class="setup-list-column">
        <div class="section-heading-row">
          <strong>Current Drivers</strong>
          <button data-action="new-setup-record" type="button">New</button>
        </div>
        <div class="registration-list setup-list">
        ${drivers.map((driver, index) => `
          <button class="registration-card ${selectedSetupIndex === index ? "selected" : ""}" data-action="select-setup-record" data-index="${index}" type="button">
            <strong>${escapeHtml(driver.name)} | ${driver.license}</strong>
            <span class="muted">License ${escapeHtml(driver.number)} | Login ${escapeHtml(driver.login)}</span>
            <span class="muted">Own yard fixed ${ownYardFixedMinutesFor(driver)}m | Outside fixed ${outsideFixedMinutesFor(driver)}m | ${minutesPerPalletFor(driver)}m/PLT</span>
          </button>
        `).join("")}
        </div>
      </div>
      <form class="registration-form setup-form" data-form="driver">
        <h3>${selected ? "Update Driver" : "Register Driver"}</h3>
        <label><span>Driver name</span><input name="name" value="${escapeHtml(selected?.name || "")}" required /></label>
        <label><span>License class</span><select name="license">
          <option ${selected?.license === "AZ" ? "selected" : ""}>AZ</option>
          <option ${selected?.license === "DZ" ? "selected" : ""}>DZ</option>
        </select></label>
        <label><span>License number</span><input name="number" value="${escapeHtml(selected?.number || "")}" required /></label>
        <label><span>Login</span><input name="login" value="${escapeHtml(selected?.login || "")}" required /></label>
        <label><span>${selected ? "New password optional" : "Password"}</span><input name="password" type="password" ${selected ? "" : "required"} /></label>
        <label><span>Fixed stop time in own yard</span><input name="ownYardFixedMinutes" type="number" value="${ownYardFixedMinutesFor(selected)}" required /></label>
        <label><span>Fixed stop time in vendor yard / delivery</span><input name="outsideFixedMinutes" type="number" value="${outsideFixedMinutesFor(selected)}" required /></label>
        <label><span>Minutes per pallet</span><input name="minutesPerPallet" type="number" step="0.1" value="${minutesPerPalletFor(selected)}" required /></label>
        <button class="primary" type="submit">${selected ? "Update Driver" : "Register Driver"}</button>
      </form>
    </div>
  `;
}

function renderTrucks() {
  const selected = Number.isInteger(selectedSetupIndex) ? trucks[selectedSetupIndex] : null;
  return `
    <div class="setup-content">
      <div class="setup-list-column">
        <div class="section-heading-row">
          <strong>Current Trucks</strong>
          <button data-action="new-setup-record" type="button">New</button>
        </div>
        <div class="registration-list setup-list">
        ${trucks.map((truck, index) => `
          <button class="registration-card ${selectedSetupIndex === index ? "selected" : ""}" data-action="select-setup-record" data-index="${index}" type="button">
            <strong>${escapeHtml(truck.plate)}</strong>
            <span class="muted">Capacity ${formatLbs(truckCapacityLbs(truck))}</span>
          </button>
        `).join("")}
        </div>
      </div>
      <form class="registration-form setup-form" data-form="truck">
        <h3>${selected ? "Update Truck" : "Register Truck"}</h3>
        <label><span>Vehicle plate number</span><input name="plate" value="${escapeHtml(selected?.plate || "")}" required /></label>
        <label><span>Load capacity (lb)</span><input name="capacityLbs" type="number" value="${truckCapacityLbs(selected)}" required /></label>
        <button class="primary" type="submit">${selected ? "Update Truck" : "Register Truck"}</button>
      </form>
    </div>
  `;
}

function renderVendorYards() {
  const vendors = [...new Set(vendorYards.map((row) => row.vendor))].sort();
  const yards = [...new Set(vendorYards.filter((row) => row.vendor === selectedVendor).map((row) => row.yard))].sort();
  if (!vendorAddMode && !yards.includes(selectedYard)) selectedYard = yards[0] || "";
  const rows = vendorAddMode ? [] : vendorYards.filter((row) => row.vendor === selectedVendor && row.yard === selectedYard);
  const byDay = new Map(rows.map((row) => [row.dayLabel, row]));
  const base = vendorAddMode ? { vendor: "", yard: "", aliases: [], address: "" } : rows[0] || { vendor: selectedVendor, yard: selectedYard, aliases: [], address: "" };
  return `
    <form class="vendor-hours-editor" data-form="vendor-hours">
      <div class="vendor-editor-toolbar">
        <div>
          <strong>${vendorAddMode ? "Add Vendor Yard" : "Edit Vendor Yard"}</strong>
          <span>${vendorAddMode ? "Create one vendor yard and its weekly hours." : "Select an existing vendor yard to adjust address and hours."}</span>
        </div>
        <div>
          ${vendorAddMode
            ? `<button data-action="cancel-add-vendor-yard" type="button">Edit Existing</button>`
            : `<button data-action="add-vendor-yard" type="button">Add Vendor Yard</button>`}
        </div>
      </div>
      <div class="vendor-selector-row">
        <label><span>Vendor</span>${vendorAddMode
          ? `<input name="vendor" placeholder="Vendor name" required />`
          : `<select id="vendorSelect" name="vendor">${vendors.map((vendor) => `<option value="${escapeHtml(vendor)}" ${vendor === selectedVendor ? "selected" : ""}>${escapeHtml(vendor)}</option>`).join("")}</select>`}</label>
        <label><span>Yard</span>${vendorAddMode
          ? `<input name="yard" placeholder="Yard name" required />`
          : `<select id="yardSelect" name="yard">${yards.map((yard) => `<option value="${escapeHtml(yard)}" ${yard === selectedYard ? "selected" : ""}>${escapeHtml(yard)}</option>`).join("")}</select>`}</label>
        <label><span>Aliases</span><input name="aliases" value="${escapeHtml((base.aliases || []).join(", "))}" /></label>
        <label><span>Address</span><input name="address" value="${escapeHtml(base.address || "")}" /></label>
      </div>
      <div class="vendor-day-grid">
        <div class="vendor-day-row vendor-day-head">
          <strong>Day</strong><strong>Open</strong><strong>Close</strong><strong>Instruction</strong><strong>Active</strong>
        </div>
        ${WEEK_DAYS.map((day) => {
          const row = byDay.get(day) || {};
          return `
            <div class="vendor-day-row" data-day="${day}" data-id="${row.id || ""}">
              <strong>${day}</strong>
              <input name="${day}-start" inputmode="numeric" maxlength="4" placeholder="start time" value="${escapeHtml(displayTime24(row.windowStart))}" />
              <input name="${day}-end" inputmode="numeric" maxlength="4" placeholder="end time" value="${escapeHtml(displayTime24(row.windowEnd))}" />
              <input name="${day}-instructions" value="${escapeHtml(row.instructions || "")}" />
              <label class="active-check"><input name="${day}-active" type="checkbox" ${row.active === true ? "checked" : ""} /> On</label>
            </div>
          `;
        }).join("")}
      </div>
      <div class="modal-footer inline-footer">
        <button class="primary" type="submit">${vendorAddMode ? "Create Vendor Yard" : "Save Vendor Hours"}</button>
      </div>
    </form>
  `;
}

function renderParserRules() {
  const help = {
    address_labels: "Words that mean delivery address, separated by comma.",
    time_labels: "Words that mean delivery time window, separated by comma.",
    instruction_labels: "Words that mean placement or drop-off instruction.",
    am_terms: "Terms that mean morning.",
    pm_terms: "Terms that mean afternoon/evening. Example PM can be 12:00-22:00.",
    noon_terms: "Terms that mean noon.",
    am_window: "Default AM range in HH:MM-HH:MM.",
    pm_window: "Default PM range in HH:MM-HH:MM.",
    noon_window: "Default noon range in HH:MM-HH:MM.",
    whole_day_window: "Used when a date exists but no time is detected."
  };
  return `
    <form class="parser-rules-editor" data-form="parser-rules">
      <div class="parser-rule-grid">
        ${parserRules.map((rule) => `
          <label class="parser-rule-row">
            <span>
              <strong>${escapeHtml(rule.key)}</strong>
              <small>${escapeHtml(rule.description || help[rule.key] || "")}</small>
            </span>
            <input name="${escapeHtml(rule.key)}" value="${escapeHtml(rule.value || "")}" />
          </label>
        `).join("") || `<div class="empty-state">No parser rules found. Run database migration first.</div>`}
      </div>
      <div class="modal-footer inline-footer">
        <button class="primary" type="submit">Save Parser Rules</button>
      </div>
    </form>
  `;
}

function renderOllamaAudit() {
  return `
    <div class="audit-toolbar">
      <button data-action="refresh-audit" type="button">Refresh Audit</button>
      <span class="muted">${ollamaAudit.length} recent records</span>
    </div>
    <div class="ollama-audit-list">
      ${ollamaAudit.map((row) => {
        const expanded = String(row.id) === String(expandedAuditId);
        return `
          <article class="audit-card ${expanded ? "expanded" : ""}">
            <button class="audit-summary-button" data-action="toggle-audit" data-id="${row.id}" type="button">
              <span class="audit-summary">
                <strong>${escapeHtml(row.sourceRef || "No source")}</strong>
                <em>${escapeHtml(row.parserType || "")}</em>
                <small>${row.createdAt ? new Date(row.createdAt).toLocaleString() : ""}</small>
                ${row.error ? `<b class="audit-error">Error</b>` : `<b>OK</b>`}
              </span>
            </button>
            ${expanded ? `
              <div class="audit-details">
                <strong>Input</strong>
                <code>${escapeHtml(row.prompt || "")}</code>
                <strong>Output</strong>
                <code>${escapeHtml(row.response || "")}</code>
                ${row.parsed ? `<strong>Parsed</strong><code>${escapeHtml(JSON.stringify(row.parsed, null, 2))}</code>` : ""}
                ${row.error ? `<strong>Error</strong><code>${escapeHtml(row.error)}</code>` : ""}
              </div>
            ` : ""}
          </article>
        `;
      }).join("") || `<div class="empty-state">No Ollama parser calls recorded yet.</div>`}
    </div>
  `;
}

function renderDispatchAudit() {
  return `
    <div class="audit-toolbar">
      <button data-action="refresh-dispatch-audit" type="button">Refresh Dispatch Log</button>
      <span class="muted">${dispatchAudit.length} recent records</span>
    </div>
    <div class="ollama-audit-list dispatch-audit-list">
      ${dispatchAudit.map((row) => {
        const expanded = String(row.id) === String(expandedDispatchAuditId);
        const target = compactAuditTarget(row);
        const details = compactAuditDetails(row);
        return `
          <article class="audit-card dispatch-audit-card ${expanded ? "expanded" : ""}">
            <button class="audit-summary-button" data-action="toggle-dispatch-audit" data-id="${row.id}" type="button">
              <span class="audit-summary dispatch-audit-summary">
                <strong>${escapeHtml(titleCaseAction(row.action))}</strong>
                <em>${escapeHtml(target || "-")}</em>
                <small>${row.createdAt ? new Date(row.createdAt).toLocaleString() : ""}</small>
                <b>${escapeHtml(row.operatorName || row.sessionId || "System")}</b>
              </span>
              ${details ? `<span class="audit-subline">${escapeHtml(details)}</span>` : ""}
            </button>
            ${expanded ? `
              <div class="audit-details">
                <div class="dispatch-audit-meta">
                  <span>Action: ${escapeHtml(row.action)}</span>
                  <span>Entity: ${escapeHtml(row.entityType || "")} ${escapeHtml(row.entityId || "")}</span>
                  <span>Order: ${escapeHtml(row.orderId || "-")}</span>
                  <span>Load: ${escapeHtml(row.loadId || "-")}</span>
                  <span>Truck: ${escapeHtml(row.truckId || "-")}</span>
                  <span>Session: ${escapeHtml(row.sessionId || "-")}</span>
                </div>
                ${renderJsonBlock("Before", row.before)}
                ${renderJsonBlock("After", row.after)}
                ${renderJsonBlock("Details", row.details)}
              </div>
            ` : ""}
          </article>
        `;
      }).join("") || `<div class="empty-state">No dispatch actions recorded yet.</div>`}
    </div>
  `;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

setupApp.addEventListener("click", (event) => {
  const tabButton = event.target.closest("[data-tab]");
  if (tabButton) {
    setupTab = tabButton.dataset.tab;
    selectedSetupIndex = null;
    if (setupTab !== "vendors") vendorAddMode = false;
    setupNotice = "";
    return renderSetup();
  }
  if (event.target?.id === "vendorSelect") return;
  const selectButton = event.target.closest("[data-action='select-setup-record']");
  if (selectButton) {
    selectedSetupIndex = Number(selectButton.dataset.index);
    return renderSetup();
  }
  const newButton = event.target.closest("[data-action='new-setup-record']");
  if (newButton) {
    selectedSetupIndex = null;
    return renderSetup();
  }
  const auditButton = event.target.closest("[data-action='toggle-audit']");
  if (auditButton) {
    expandedAuditId = String(expandedAuditId) === String(auditButton.dataset.id) ? "" : auditButton.dataset.id;
    return renderSetup();
  }
  const dispatchAuditButton = event.target.closest("[data-action='toggle-dispatch-audit']");
  if (dispatchAuditButton) {
    expandedDispatchAuditId = String(expandedDispatchAuditId) === String(dispatchAuditButton.dataset.id) ? "" : dispatchAuditButton.dataset.id;
    return renderSetup();
  }
  const refreshAuditButton = event.target.closest("[data-action='refresh-audit']");
  if (refreshAuditButton) {
    loadOllamaAudit().finally(renderSetup);
    return;
  }
  const refreshDispatchAuditButton = event.target.closest("[data-action='refresh-dispatch-audit']");
  if (refreshDispatchAuditButton) {
    loadDispatchAudit().finally(renderSetup);
    return;
  }
  const addVendorButton = event.target.closest("[data-action='add-vendor-yard']");
  if (addVendorButton) {
    vendorAddMode = true;
    setupNotice = "";
    return renderSetup();
  }
  const cancelAddVendorButton = event.target.closest("[data-action='cancel-add-vendor-yard']");
  if (cancelAddVendorButton) {
    vendorAddMode = false;
    setupNotice = "";
    if (!selectedVendor) selectedVendor = [...new Set(vendorYards.map((row) => row.vendor))][0] || "";
    if (!selectedYard) selectedYard = vendorYards.find((row) => row.vendor === selectedVendor)?.yard || "";
    return renderSetup();
  }
  const saveSetupButton = event.target.closest("[data-action='save-dispatch-setup']");
  if (saveSetupButton) {
    saveDispatchSetup().then(() => {
      setupNotice = "Dispatch setup saved.";
      renderSetup();
    }).catch((error) => {
      setupNotice = `Setup save failed: ${error.message}`;
      renderSetup();
    });
    return;
  }
  if (!tabButton) return;
  renderSetup();
});

setupApp.addEventListener("submit", (event) => {
  const form = event.target.closest("form");
  if (!form) return;
  if (form.dataset.form === "dispatch-login") return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  if (form.dataset.form === "vendor-hours") {
    const vendorName = String(data.vendor || "").trim();
    const yardName = String(data.yard || "").trim();
    if (!vendorName || !yardName) {
      setupNotice = "Vendor name and yard name are required.";
      renderSetup();
      return;
    }
    const wasAddMode = vendorAddMode;
    const promises = WEEK_DAYS.map((day) => api("/api/dispatch/vendor-yards", {
      method: "POST",
      body: JSON.stringify({
        vendor: vendorName,
        yard: yardName,
        dayLabel: day,
        windowStart: normalizeTime24(data[`${day}-start`]),
        windowEnd: normalizeTime24(data[`${day}-end`]),
        instructions: data[`${day}-instructions`] || "",
        address: data.address || "",
        aliases: data.aliases || "",
        active: data[`${day}-active`] === "on"
      })
    }));
    Promise.all(promises).then(async () => {
      selectedVendor = vendorName;
      selectedYard = yardName;
      vendorAddMode = false;
      setupNotice = wasAddMode ? "Vendor yard created. PO enrichment refreshed." : "Vendor hours saved. PO enrichment refreshed.";
      await loadVendorYards();
      renderSetup();
    }).catch((error) => {
      setupNotice = `Save failed: ${error.message}`;
      renderSetup();
    });
    return;
  }
  if (form.dataset.form === "parser-rules") {
    const promises = parserRules.map((rule) => api(`/api/dispatch/parser-rules/${encodeURIComponent(rule.key)}`, {
      method: "PUT",
      body: JSON.stringify({ value: data[rule.key] || "" })
    }));
    Promise.all(promises).then(async () => {
      setupNotice = "Parser rules saved.";
      await loadParserRules();
      renderSetup();
    }).catch((error) => {
      setupNotice = `Parser save failed: ${error.message}`;
      renderSetup();
    });
    return;
  }
  if (form.dataset.form === "driver") {
    const existingDriver = Number.isInteger(selectedSetupIndex) ? drivers[selectedSetupIndex] : null;
    const driver = {
      name: data.name,
      license: data.license,
      number: data.number,
      login: data.login,
      password: data.password || existingDriver?.password || "",
      ownYardFixedMinutes: Number(data.ownYardFixedMinutes || data.loadMinutes || 40),
      outsideFixedMinutes: Number(data.outsideFixedMinutes || data.unloadMinutes || 35),
      minutesPerPallet: Number(data.minutesPerPallet || 1),
      loadMinutes: Number(data.ownYardFixedMinutes || data.loadMinutes || 40),
      unloadMinutes: Number(data.outsideFixedMinutes || data.unloadMinutes || 35)
    };
    if (Number.isInteger(selectedSetupIndex)) drivers[selectedSetupIndex] = driver;
    else {
      drivers.push(driver);
      selectedSetupIndex = drivers.length - 1;
    }
    saveDispatchSetup().then(() => {
      setupNotice = "Driver setup saved.";
      renderSetup();
    }).catch((error) => {
      setupNotice = `Driver save failed: ${error.message}`;
      renderSetup();
    });
    return;
  }
  if (form.dataset.form === "truck") {
    const truck = { plate: data.plate, capacityLbs: Number(data.capacityLbs || 48000) };
    if (Number.isInteger(selectedSetupIndex)) trucks[selectedSetupIndex] = truck;
    else {
      trucks.push(truck);
      selectedSetupIndex = trucks.length - 1;
    }
    saveDispatchSetup().then(() => {
      setupNotice = "Truck setup saved.";
      renderSetup();
    }).catch((error) => {
      setupNotice = `Truck save failed: ${error.message}`;
      renderSetup();
    });
    return;
  }
});

setupApp.addEventListener("change", (event) => {
  if (event.target?.id === "vendorSelect") {
    selectedVendor = event.target.value;
    selectedYard = vendorYards.find((row) => row.vendor === selectedVendor)?.yard || "";
    return renderSetup();
  }
  if (event.target?.id === "yardSelect") {
    selectedYard = event.target.value;
    return renderSetup();
  }
});

async function initDispatchSetup() {
  await Promise.all([loadDispatchSetup(), loadVendorYards(), loadParserRules(), loadOllamaAudit(), loadDispatchAudit()]);
  connectEvents();
  renderSetup();
}

requireDispatchLogin({
  mount: setupApp,
  onReady: initDispatchSetup
});

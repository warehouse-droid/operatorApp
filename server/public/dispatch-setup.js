const setupApp = document.getElementById("dispatchSetupApp");
const t = (key, fallback) => window.MBBS_I18N?.t(key, fallback) || fallback;
const languageToggle = () => window.MBBS_I18N?.toggleHtml() || "";
const displayDate = (value) => window.MBBS_I18N?.displayDate(value) || "";
const displayDateTime = (value) => window.MBBS_I18N?.displayDateTime(value) || "";

let setupTab = "drivers";
let selectedSetupIndex = null;
let drivers = [
  { name: "Alex Wong", license: "AZ", number: "A90211", login: "alex", ownYardFixedMinutes: 42, vendorFixedMinutes: 36, deliveryFixedMinutes: 36, outsideFixedMinutes: 36, minutesPerPallet: 1, loadMinutes: 42, unloadMinutes: 36 },
  { name: "Jenny Lee", license: "DZ", number: "D18870", login: "jenny", ownYardFixedMinutes: 38, vendorFixedMinutes: 32, deliveryFixedMinutes: 32, outsideFixedMinutes: 32, minutesPerPallet: 1, loadMinutes: 38, unloadMinutes: 32 }
];
let trucks = [
  { plate: "MBBS-101", capacityLbs: 48000, travelTimePercent: 0, baseYard: "" },
  { plate: "MBBS-205", capacityLbs: 44000, travelTimePercent: 0, baseYard: "" },
  { plate: "MBBS-318", capacityLbs: 52000, travelTimePercent: 0, baseYard: "" }
];
let ownYards = [
  { code: "3445", name: "3445", locationId: 1, address: "3445 Kennedy Road, Toronto, ON", lat: 43.8204306, lng: -79.3053423 },
  { code: "2967", name: "2967", locationId: 28, address: "2967 Kennedy Road, Toronto, ON", lat: 43.806119, lng: -79.2986377 },
  { code: "12441", name: "12441", locationId: 15, address: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON", lat: 43.948694, lng: -79.3727582 },
  { code: "150", name: "150", locationId: 26, address: "150 Clark Blvd, Brampton, ON L6T 4Y8, Canada" }
];
let vendorYards = [];
let parserRules = [];
let ollamaAudit = [];
let dispatchAudit = [];
let parserReparseResult = null;
let setupNotice = "";
let samsaraTestResult = null;
let samsaraSettings = { dvirAuthorId: "1868723" };
let planningSettings = { truckSwitchMinutes: 10 };
let selectedVendor = "";
let selectedYard = "";
let vendorAddMode = false;
let expandedAuditId = "";
let expandedDispatchAuditId = "";
let eventSource = null;
let setupRefreshTimer = null;
let draggedTruckSetupIndex = null;
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
    if (Array.isArray(setup.ownYards)) ownYards = setup.ownYards;
    if (setup.samsara) samsaraSettings = { ...samsaraSettings, ...setup.samsara };
    if (setup.planning) planningSettings = { ...planningSettings, ...setup.planning };
  } catch (error) {
    setupNotice = `Dispatch setup failed to load: ${error.message}`;
  }
}

function validateUniqueDriverLogins() {
  const seen = new Map();
  for (const driver of drivers || []) {
    const login = String(driver?.login || "").trim();
    if (!login) continue;
    const key = login.toLowerCase();
    const previous = seen.get(key);
    if (previous) throw new Error(`Driver login must be unique. "${login}" is used by both ${previous} and ${driver.name || login}.`);
    seen.set(key, driver.name || login);
  }
}

async function saveDispatchSetup() {
  validateUniqueDriverLogins();
  const saved = await api("/api/dispatch/setup", {
    method: "PUT",
    body: JSON.stringify({ drivers, trucks, ownYards, samsara: samsaraSettings, planning: planningSettings })
  });
  if (Array.isArray(saved.drivers)) drivers = saved.drivers;
  if (Array.isArray(saved.trucks)) trucks = saved.trucks;
  if (Array.isArray(saved.ownYards)) ownYards = saved.ownYards;
  if (saved.samsara) samsaraSettings = { ...samsaraSettings, ...saved.samsara };
  if (saved.planning) planningSettings = { ...planningSettings, ...saved.planning };
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

function truckTravelTimePercent(truck) {
  const value = Number(truck?.travelTimePercent ?? truck?.travelPercent ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function truckBaseYardOptions(selected = "") {
  const selectedValue = String(selected || "").trim();
  return [
    `<option value="" ${selectedValue ? "" : "selected"}>Unknown / not confirmed</option>`,
    ...ownYards.map((yard) => {
      const code = String(yard.code || yard.name || "").trim();
      const label = yard.name && yard.name !== code ? `${code} - ${yard.name}` : code;
      return `<option value="${escapeHtml(code)}" ${selectedValue === code ? "selected" : ""}>${escapeHtml(label)}</option>`;
    })
  ].join("");
}

function ownYardFixedMinutesFor(driver) {
  return Number(driver?.ownYardFixedMinutes || driver?.loadMinutes || 40);
}

function outsideFixedMinutesFor(driver) {
  return deliveryFixedMinutesFor(driver);
}

function vendorFixedMinutesFor(driver) {
  return Number(driver?.vendorFixedMinutes || driver?.outsideFixedMinutes || driver?.unloadMinutes || 35);
}

function deliveryFixedMinutesFor(driver) {
  return Number(driver?.deliveryFixedMinutes || driver?.outsideFixedMinutes || driver?.unloadMinutes || 35);
}

function minutesPerPalletFor(driver) {
  return Number(driver?.minutesPerPallet || 1);
}

function samsaraLoginSummary(driver) {
  const primary = String(driver?.samsaraPrimaryLogin || "").trim();
  const secondary = String(driver?.samsaraSecondaryLogin || "").trim();
  const parts = [];
  if (primary) parts.push(`Primary username ${primary}`);
  if (secondary) parts.push(`Secondary username ${secondary}`);
  return parts.join(" | ");
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
          <p>${t("app.transportation", "MBBS Transportation")}</p>
          <h1>${t("dispatch.setup", "Dispatch Setup")}</h1>
        </div>
        <div class="topbar-language">${languageToggle()}</div>
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
            <button class="${setupTab === "own-yards" ? "active" : ""}" data-tab="own-yards" type="button">Own Yards</button>
            <button class="${setupTab === "vendors" ? "active" : ""}" data-tab="vendors" type="button">Vendor Hours</button>
            <button class="${setupTab === "samsara" ? "active" : ""}" data-tab="samsara" type="button">Samsara</button>
            <button class="${setupTab === "parser" ? "active" : ""}" data-tab="parser" type="button">Parser Rules</button>
            <button class="${setupTab === "dispatch-log" ? "active" : ""}" data-tab="dispatch-log" type="button">Dispatch Log</button>
            <button class="${setupTab === "audit" ? "active" : ""}" data-tab="audit" type="button">Ollama Audit</button>
          </div>
        </section>
        <section class="panel">
          <div class="panel-header">
            <h2>${setupTab === "drivers" ? "Driver Registration" : setupTab === "trucks" ? "Truck Registration" : setupTab === "own-yards" ? "Own Yard Addresses" : setupTab === "vendors" ? "Vendor Address & Hours" : setupTab === "samsara" ? "Samsara Settings" : setupTab === "parser" ? "Label Parser Rules" : setupTab === "dispatch-log" ? "Dispatch Action Log" : "Ollama Input & Output Audit"}</h2>
            <p>${setupTab === "drivers" ? "Driver login, license, and service speed." : setupTab === "trucks" ? "Vehicle plate and weight capacity." : setupTab === "own-yards" ? "Used to route yard pickup, return, transfer, and truck reposition stops." : setupTab === "vendors" ? "Used to match PO vendor yards and plan pickup windows." : setupTab === "samsara" ? "Configure Samsara DVIR author and connection checks." : setupTab === "parser" ? "Maintain address/time labels and default meanings such as PM or whole day." : setupTab === "dispatch-log" ? "Review planner updates, drag/drop actions, load changes, and manual edits." : "Review parser prompts, model responses, and parsed results."}</p>
          </div>
          ${setupNotice ? `<div class="setup-notice">${escapeHtml(setupNotice)}</div>` : ""}
          ${setupTab === "drivers" && samsaraTestResult ? renderSamsaraTestResult() : ""}
          ${setupTab === "drivers" ? renderDrivers() : setupTab === "trucks" ? renderTrucks() : setupTab === "own-yards" ? renderOwnYards() : setupTab === "vendors" ? renderVendorYards() : setupTab === "samsara" ? renderSamsaraSettings() : setupTab === "parser" ? renderParserRules() : setupTab === "dispatch-log" ? renderDispatchAudit() : renderOllamaAudit()}
        </section>
      </div>
    </section>
  `;
}

function renderSamsaraTestResult() {
  const matches = samsaraTestResult.truckMatches || [];
  return `
    <div class="setup-notice samsara-test-result">
      <strong>Samsara API OK</strong>
      <span>${Number(samsaraTestResult.vehicleCount || 0)} vehicles found.</span>
      ${matches.length ? `<span>${matches.filter((item) => item.matched).length}/${matches.length} local trucks matched by plate.</span>` : ""}
    </div>
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
            ${samsaraLoginSummary(driver) ? `<span class="muted">Samsara ${escapeHtml(samsaraLoginSummary(driver))}</span>` : ""}
            <span class="muted">Own yard ${ownYardFixedMinutesFor(driver)}m | Vendor ${vendorFixedMinutesFor(driver)}m | Delivery ${deliveryFixedMinutesFor(driver)}m + ${minutesPerPalletFor(driver)}m/PLT</span>
          </button>
        `).join("")}
        </div>
      </div>
      <form class="registration-form setup-form" data-form="driver">
        <h3>${selected ? "Update Driver" : "Register Driver"}</h3>
        <div class="form-action-row">
          <button data-action="test-samsara-api" type="button">Test Samsara API</button>
          ${selected ? `<button data-action="test-samsara-login" data-account="primary" type="button">Find Primary Driver</button>` : ""}
          ${selected ? `<button data-action="test-samsara-login" data-account="secondary" type="button">Find Secondary Driver</button>` : ""}
        </div>
        <label><span>Driver name</span><input name="name" value="${escapeHtml(selected?.name || "")}" required /></label>
        <label><span>License class</span><select name="license">
          <option ${selected?.license === "AZ" ? "selected" : ""}>AZ</option>
          <option ${selected?.license === "DZ" ? "selected" : ""}>DZ</option>
        </select></label>
        <label><span>License number</span><input name="number" value="${escapeHtml(selected?.number || "")}" required /></label>
        <label><span>Login</span><input name="login" value="${escapeHtml(selected?.login || "")}" required /></label>
        <label><span>${selected ? "New password optional" : "Password"}</span><input name="password" type="password" ${selected ? "" : "required"} /></label>
        <label><span>Samsara primary username</span><input name="samsaraPrimaryLogin" autocomplete="off" value="${escapeHtml(selected?.samsaraPrimaryLogin || "")}" /></label>
        <label><span>Samsara secondary username</span><input name="samsaraSecondaryLogin" autocomplete="off" value="${escapeHtml(selected?.samsaraSecondaryLogin || "")}" /></label>
        <label><span>Fixed stop time in own yard</span><input name="ownYardFixedMinutes" type="number" value="${ownYardFixedMinutesFor(selected)}" required /></label>
        <label><span>Fixed stop time in vendor yard</span><input name="vendorFixedMinutes" type="number" value="${vendorFixedMinutesFor(selected)}" required /></label>
        <label><span>Fixed stop time in delivery</span><input name="deliveryFixedMinutes" type="number" value="${deliveryFixedMinutesFor(selected)}" required /></label>
        <label><span>Delivery minutes per pallet</span><input name="minutesPerPallet" type="number" step="0.1" value="${minutesPerPalletFor(selected)}" required /></label>
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
          <div>
            <strong>Current Trucks</strong>
            <span class="muted">Drag to set the default planning sequence.</span>
          </div>
          <button data-action="new-setup-record" type="button">New</button>
        </div>
        <div class="registration-list setup-list">
        ${trucks.map((truck, index) => `
          <button class="registration-card truck-setup-card ${selectedSetupIndex === index ? "selected" : ""}" data-action="select-setup-record" data-index="${index}" data-truck-index="${index}" draggable="true" type="button">
            <strong>${escapeHtml(truck.plate)}</strong>
            <span class="muted">Capacity ${formatLbs(truckCapacityLbs(truck))}</span>
            <span class="muted">Google travel time +${truckTravelTimePercent(truck)}%</span>
            <span class="muted">Base yard ${escapeHtml(truck.baseYard || "Unknown")}</span>
          </button>
        `).join("")}
        </div>
      </div>
      <form class="registration-form setup-form" data-form="truck">
        <h3>${selected ? "Update Truck" : "Register Truck"}</h3>
        <label><span>${t("dispatch.truckSwitchMinutes", "Truck switch time (minutes)")}</span><input name="truckSwitchMinutes" type="number" min="0" max="120" step="1" value="${Number(planningSettings.truckSwitchMinutes ?? 10)}" required /></label>
        <label><span>Vehicle plate number</span><input name="plate" value="${escapeHtml(selected?.plate || "")}" required /></label>
        <label><span>Load capacity (lb)</span><input name="capacityLbs" type="number" value="${truckCapacityLbs(selected)}" required /></label>
        <label><span>Google travel time + %</span><input name="travelTimePercent" type="number" min="0" max="300" step="1" value="${truckTravelTimePercent(selected)}" required /></label>
        <label><span>Default base yard</span><select name="baseYard">${truckBaseYardOptions(selected?.baseYard || "")}</select></label>
        <button class="primary" type="submit">${selected ? "Update Truck" : "Register Truck"}</button>
      </form>
    </div>
  `;
}

function moveSetupTruck(fromIndex, toIndex) {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return false;
  if (fromIndex < 0 || fromIndex >= trucks.length || toIndex < 0 || toIndex >= trucks.length || fromIndex === toIndex) return false;
  const [truck] = trucks.splice(fromIndex, 1);
  trucks.splice(toIndex, 0, truck);
  if (selectedSetupIndex === fromIndex) selectedSetupIndex = toIndex;
  else if (Number.isInteger(selectedSetupIndex)) {
    if (fromIndex < selectedSetupIndex && toIndex >= selectedSetupIndex) selectedSetupIndex -= 1;
    else if (fromIndex > selectedSetupIndex && toIndex <= selectedSetupIndex) selectedSetupIndex += 1;
  }
  return true;
}

function renderOwnYards() {
  const selected = Number.isInteger(selectedSetupIndex) ? ownYards[selectedSetupIndex] : null;
  return `
    <div class="setup-content">
      <div class="setup-list-column">
        <div class="section-heading-row">
          <strong>Current Yards</strong>
          <button data-action="new-setup-record" type="button">New</button>
        </div>
        <div class="registration-list setup-list">
        ${ownYards.map((yard, index) => `
          <button class="registration-card ${selectedSetupIndex === index ? "selected" : ""}" data-action="select-setup-record" data-index="${index}" type="button">
            <strong>${escapeHtml(yard.code || yard.name)}</strong>
            <span class="muted">${escapeHtml(yard.name || yard.code || "")}</span>
            <span class="muted">${escapeHtml(yard.address || "No address")}</span>
          </button>
        `).join("")}
        </div>
      </div>
      <form class="registration-form setup-form" data-form="own-yard">
        <h3>${selected ? "Update Yard" : "Add Yard"}</h3>
        <label><span>Yard code</span><input name="code" value="${escapeHtml(selected?.code || "")}" placeholder="3445" required /></label>
        <label><span>Display name</span><input name="name" value="${escapeHtml(selected?.name || selected?.code || "")}" placeholder="3445" /></label>
        <label><span>NetSuite internal ID</span><input name="locationId" type="number" value="${escapeHtml(selected?.locationId ?? "")}" placeholder="1" /></label>
        <label><span>Address</span><input name="address" value="${escapeHtml(selected?.address || "")}" placeholder="3445 Kennedy Road, Toronto, ON" required /></label>
        <label><span>Latitude optional</span><input name="lat" type="number" step="0.000001" value="${escapeHtml(selected?.lat ?? "")}" /></label>
        <label><span>Longitude optional</span><input name="lng" type="number" step="0.000001" value="${escapeHtml(selected?.lng ?? "")}" /></label>
        <button class="primary" type="submit">${selected ? "Update Yard" : "Add Yard"}</button>
      </form>
    </div>
  `;
}

function renderSamsaraSettings() {
  return `
    <form class="registration-form setup-form" data-form="samsara-settings">
      <h3>Samsara DVIR</h3>
      <div class="form-action-row">
        <button data-action="test-samsara-api" type="button">Test Samsara API</button>
      </div>
      <label>
        <span>DVIR author user ID</span>
        <input name="dvirAuthorId" value="${escapeHtml(samsaraSettings.dvirAuthorId || "")}" placeholder="1868723" required />
      </label>
      <label>
        <span>Author</span>
        <input value="warehouse MBBS | warehouse@mrbininc.com" disabled />
      </label>
      <button class="primary" type="submit">Save Samsara Settings</button>
    </form>
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
    date_labels: "Words that mean delivery date. Example Date: 07-03 means July 3.",
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
    <section class="setup-panel parser-maintenance-panel">
      <div>
        <h3>Re-parse Missing Delivery Time</h3>
        <p class="muted">Re-run the current parser rules on active sales delivery orders that have no delivery address or time window.</p>
      </div>
      <div class="inline-footer">
        <button class="secondary-button" data-action="dry-run-reparse-missing-delivery-time" type="button">Preview Count</button>
        <button class="primary" data-action="reparse-missing-delivery-time" type="button">Re-parse Orders</button>
        <button class="danger-button" data-action="reparse-non-shipped-delivery-orders" type="button">Re-parse All Non-Shipped</button>
      </div>
      ${parserReparseResult ? `
        <div class="reparse-result">
          <strong>${parserReparseResult.dryRun ? "Preview" : "Updated"}:</strong>
          ${Number(parserReparseResult.matched || 0)} matched,
          ${Number(parserReparseResult.updated || 0)} saved,
          ${Number(parserReparseResult.resolvedTime || 0)} time windows found,
          ${Number(parserReparseResult.resolvedAddress || 0)} addresses found,
          ${Number(parserReparseResult.failed || 0)} failed.
          ${Array.isArray(parserReparseResult.details) && parserReparseResult.details.length ? `
            <div class="reparse-detail-list">
              ${parserReparseResult.details.slice(0, 8).map((row) => `
                <span>
                  <b>${escapeHtml(row.tranid || row.netsuiteId || "")}</b>
                  ${row.error ? `Error: ${escapeHtml(row.error)}` : `${escapeHtml(displayDate(row.after?.expectedDeliveryDate) || "No date")} | ${escapeHtml(row.after?.windowStart || "-")} - ${escapeHtml(row.after?.windowEnd || "-")} | ${escapeHtml(row.after?.address || "No address")}`}
                </span>
              `).join("")}
            </div>
          ` : ""}
        </div>
      ` : ""}
    </section>
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
                <small>${displayDateTime(row.createdAt)}</small>
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
                <small>${displayDateTime(row.createdAt)}</small>
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

setupApp.addEventListener("dragstart", (event) => {
  const truckCard = event.target.closest("[data-truck-index]");
  if (!truckCard || setupTab !== "trucks") return;
  draggedTruckSetupIndex = Number(truckCard.dataset.truckIndex);
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", String(draggedTruckSetupIndex));
  truckCard.classList.add("dragging");
});

setupApp.addEventListener("dragover", (event) => {
  const truckCard = event.target.closest("[data-truck-index]");
  if (!truckCard || setupTab !== "trucks" || draggedTruckSetupIndex === null) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  document.querySelectorAll(".truck-setup-card.drag-over").forEach((card) => card.classList.remove("drag-over"));
  truckCard.classList.add("drag-over");
});

setupApp.addEventListener("dragleave", (event) => {
  event.target.closest(".truck-setup-card")?.classList.remove("drag-over");
});

setupApp.addEventListener("dragend", () => {
  draggedTruckSetupIndex = null;
  document.querySelectorAll(".truck-setup-card.dragging, .truck-setup-card.drag-over").forEach((card) => card.classList.remove("dragging", "drag-over"));
});

setupApp.addEventListener("drop", (event) => {
  const truckCard = event.target.closest("[data-truck-index]");
  if (!truckCard || setupTab !== "trucks" || draggedTruckSetupIndex === null) return;
  event.preventDefault();
  const fromIndex = draggedTruckSetupIndex;
  const toIndex = Number(truckCard.dataset.truckIndex);
  draggedTruckSetupIndex = null;
  document.querySelectorAll(".truck-setup-card.dragging, .truck-setup-card.drag-over").forEach((card) => card.classList.remove("dragging", "drag-over"));
  if (!moveSetupTruck(fromIndex, toIndex)) return renderSetup();
  saveDispatchSetup().then(() => {
    setupNotice = "Truck default sequence saved.";
    renderSetup();
  }).catch((error) => {
    setupNotice = `Truck sequence save failed: ${error.message}`;
    renderSetup();
  });
});

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
  const reparseButton = event.target.closest("[data-action='reparse-missing-delivery-time'], [data-action='dry-run-reparse-missing-delivery-time'], [data-action='reparse-non-shipped-delivery-orders']");
  if (reparseButton) {
    const dryRun = reparseButton.dataset.action === "dry-run-reparse-missing-delivery-time";
    const allNonShipped = reparseButton.dataset.action === "reparse-non-shipped-delivery-orders";
    reparseButton.disabled = true;
    reparseButton.textContent = dryRun ? "Checking..." : allNonShipped ? "Re-parsing all..." : "Re-parsing...";
    api(`/api/dispatch/reparse-missing-delivery-time${dryRun ? "?dryRun=true" : ""}`, {
      method: "POST",
      body: JSON.stringify({ limit: allNonShipped ? 1000 : 300, dryRun, scope: allNonShipped ? "non_shipped" : "missing" })
    }).then(async (result) => {
      parserReparseResult = result;
      setupNotice = dryRun
        ? `Preview found ${Number(result.matched || 0)} delivery orders with missing parser fields.`
        : allNonShipped
          ? `Re-parsed ${Number(result.updated || 0)} non-shipped delivery orders.`
          : `Re-parsed ${Number(result.updated || 0)} delivery orders.`;
      await loadOllamaAudit();
      renderSetup();
    }).catch((error) => {
      setupNotice = `Re-parse failed: ${error.message}`;
      renderSetup();
    });
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
  const samsaraApiButton = event.target.closest("[data-action='test-samsara-api']");
  if (samsaraApiButton) {
    samsaraApiButton.disabled = true;
    samsaraApiButton.textContent = "Testing...";
    api("/api/dispatch/samsara/test").then((result) => {
      samsaraTestResult = result;
      setupNotice = "Samsara API token works.";
      renderSetup();
    }).catch((error) => {
      setupNotice = `Samsara API test failed: ${error.message}`;
      samsaraTestResult = null;
      renderSetup();
    });
    return;
  }
  const samsaraLoginButton = event.target.closest("[data-action='test-samsara-login']");
  if (samsaraLoginButton) {
    const selected = Number.isInteger(selectedSetupIndex) ? drivers[selectedSetupIndex] : null;
    if (!selected?.login) {
      setupNotice = "Select and save a driver before testing Samsara login.";
      renderSetup();
      return;
    }
    const account = samsaraLoginButton.dataset.account === "secondary" ? "secondary" : "primary";
    samsaraLoginButton.disabled = true;
    samsaraLoginButton.textContent = "Testing...";
    api("/api/dispatch/samsara/driver-login-test", {
      method: "POST",
      body: JSON.stringify({ driverLogin: selected.login, account })
    }).then((result) => {
      setupNotice = `Samsara ${account} driver found: ${result.samsaraDriver?.name || result.username} (${result.samsaraDriver?.id || "-"})`;
      renderSetup();
    }).catch((error) => {
      setupNotice = `Samsara ${account} driver lookup failed: ${error.message}`;
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
  if (form.dataset.form === "samsara-settings") {
    samsaraSettings = {
      ...samsaraSettings,
      dvirAuthorId: String(data.dvirAuthorId || "").trim()
    };
    saveDispatchSetup().then(() => {
      setupNotice = "Samsara settings saved.";
      renderSetup();
    }).catch((error) => {
      setupNotice = `Samsara settings save failed: ${error.message}`;
      renderSetup();
    });
    return;
  }
  if (form.dataset.form === "own-yard") {
    const code = String(data.code || "").trim();
    const address = String(data.address || "").trim();
    if (!code || !address) {
      setupNotice = "Yard code and address are required.";
      renderSetup();
      return;
    }
    const yard = {
      code,
      name: String(data.name || code).trim(),
      locationId: data.locationId === "" ? null : Number(data.locationId),
      address,
      lat: data.lat === "" ? null : Number(data.lat),
      lng: data.lng === "" ? null : Number(data.lng)
    };
    if (Number.isInteger(selectedSetupIndex)) ownYards[selectedSetupIndex] = yard;
    else {
      ownYards.push(yard);
      selectedSetupIndex = ownYards.length - 1;
    }
    saveDispatchSetup().then(() => {
      setupNotice = "Own yard address saved.";
      renderSetup();
    }).catch((error) => {
      setupNotice = `Own yard save failed: ${error.message}`;
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
      id: existingDriver?.id || null,
      password: data.password || "",
      samsaraPrimaryLogin: String(data.samsaraPrimaryLogin || "").trim(),
      samsaraSecondaryLogin: String(data.samsaraSecondaryLogin || "").trim(),
      ownYardFixedMinutes: Number(data.ownYardFixedMinutes || data.loadMinutes || 40),
      vendorFixedMinutes: Number(data.vendorFixedMinutes || data.outsideFixedMinutes || data.unloadMinutes || 35),
      deliveryFixedMinutes: Number(data.deliveryFixedMinutes || data.outsideFixedMinutes || data.unloadMinutes || 35),
      outsideFixedMinutes: Number(data.deliveryFixedMinutes || data.outsideFixedMinutes || data.unloadMinutes || 35),
      minutesPerPallet: Number(data.minutesPerPallet || 1),
      loadMinutes: Number(data.ownYardFixedMinutes || data.loadMinutes || 40),
      unloadMinutes: Number(data.deliveryFixedMinutes || data.outsideFixedMinutes || data.unloadMinutes || 35)
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
    const existingTruck = Number.isInteger(selectedSetupIndex) ? trucks[selectedSetupIndex] : null;
    const truck = {
      id: existingTruck?.id || null,
      plate: data.plate,
      capacityLbs: Number(data.capacityLbs || 48000),
      travelTimePercent: Math.max(0, Number(data.travelTimePercent || 0)),
      baseYard: String(data.baseYard || "").trim()
    };
    planningSettings.truckSwitchMinutes = Math.max(0, Math.round(Number(data.truckSwitchMinutes ?? 10)));
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

window.addEventListener("mbbs-language-changed", () => {
  renderSetup();
});

requireDispatchLogin({
  mount: setupApp,
  onReady: initDispatchSetup
});

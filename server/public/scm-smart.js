const smartScmApp = document.getElementById("smartScmApp");

const smartState = {
  operator: null,
  data: null,
  plan: null,
  forecasts: [],
  vendorReplyLoads: [],
  tab: "overview",
  busy: "",
  notice: "",
  error: "",
  planSearch: "",
  planType: "",
  planStatus: "",
  planSource: "",
  planDestination: "",
  planSort: "destination",
  selectedProposalIds: new Set(),
  vendorSearch: "",
  forecastSearch: "",
  forecastYard: "",
  itemData: null,
  itemSearch: "",
  itemVendorYard: "",
  itemEnabled: "true",
  itemOffset: 0,
  itemLimit: 150
};

let smartItemSearchTimer = null;
const smartVendorSearchTimers = new Map();
const smartProposalSearchTimers = new Map();

function smartEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function smartNumber(value, places = 1) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-CA", { maximumFractionDigits: places }).format(amount);
}

function smartPercent(value, places = 0) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-CA", { style: "percent", maximumFractionDigits: places }).format(amount);
}

function smartDate(value, withTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return smartEscape(String(value));
  return new Intl.DateTimeFormat("en-CA", withTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" }).format(date);
}

function smartRoles() {
  return new Set([
    ...(Array.isArray(smartState.operator?.roles) ? smartState.operator.roles : []),
    smartState.operator?.role
  ].map((role) => String(role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_")).filter(Boolean));
}

function smartCanWrite() {
  const roles = smartRoles();
  return ["admin", "scm", "scm_staff"].some((role) => roles.has(role));
}

function smartPill(value, label = null) {
  const display = String(label ?? value ?? "Unknown").replaceAll("_", " ");
  const css = String(value || "").toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  return `<span class="smart-pill ${css}">${smartEscape(display)}</span>`;
}

async function smartApi(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body === "object" && !(options.body instanceof Blob) && !(options.body instanceof ArrayBuffer) && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    options = { ...options, body: JSON.stringify(options.body) };
  }
  const response = await fetch(url, { ...options, headers });
  const type = response.headers.get("content-type") || "";
  const payload = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(payload?.error || payload || `Request failed (${response.status})`);
  return payload;
}

async function smartDownload(url, fallbackName) {
  const response = await fetch(url);
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Download failed (${response.status})`);
  }
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="?([^";]+)"?/i);
  const filename = match?.[1] || fallbackName;
  const blob = await response.blob();
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
}

async function smartLoadBootstrap({ quiet = false } = {}) {
  if (!quiet) {
    smartState.busy = "Loading Smart SCM";
    smartRender();
  }
  const data = await smartApi("/api/scm/smart/bootstrap?proposalLimit=500");
  smartState.data = data;
  if (!smartState.plan || !data.latestRun || Number(smartState.plan.id) === Number(data.latestRun.id)) {
    smartState.plan = data.latestRun;
  }
  smartState.forecasts = data.latestForecasts || [];
  smartState.vendorReplyLoads = data.vendorReplyLoads || [];
  smartState.busy = "";
  smartRender();
}

async function smartLoadItems({ reset = false, quiet = false } = {}) {
  if (reset) smartState.itemOffset = 0;
  if (!quiet) {
    smartState.busy = "Loading Item Master";
    smartRender();
  }
  const params = new URLSearchParams({
    search: smartState.itemSearch,
    enabled: smartState.itemEnabled,
    limit: String(smartState.itemLimit),
    vendorYard: smartState.itemVendorYard,
    offset: String(smartState.itemOffset)
  });
  smartState.itemData = await smartApi(`/api/scm/smart/items?${params}`);
  smartState.busy = "";
  smartRender();
}

function smartHeader() {
  const settings = smartState.data?.settings || {};
  return `
    <header class="dispatch-topbar">
      <div class="smart-brand">
        <div class="smart-brand-mark">SCM</div>
        <div><p>Inventory decision workspace</p><h1>Smart SCM</h1></div>
      </div>
      <span class="smart-mode ${settings.executionMode === "live" ? "live" : ""}">${smartEscape(settings.executionMode || "loading")} execution</span>
      <div class="topbar-actions">
        <span class="dispatch-user">${smartEscape(smartState.operator?.display_name || smartState.operator?.username || "")}</span>
        <button type="button" onclick="location.href='/scm/route-rules'">Route rules</button>
        <button type="button" onclick="location.href='/scm'">SCM menu</button>
        <button type="button" onclick="dispatchLogout()">Logout</button>
      </div>
    </header>`;
}

function smartTabs() {
  const tabs = [
    ["overview", "Overview"],
    ["items", "Item Master"],
    ["forecasts", "Forecast evidence"],
    ["plans", "PO / TO proposals"],
    ["vendors", "Vendor replies"],
    ["settings", "Settings"]
  ];
  return `<nav class="smart-tabs">${tabs.map(([key, label]) => `<button class="${smartState.tab === key ? "active" : ""}" data-smart-tab="${key}" type="button">${label}</button>`).join("")}</nav>`;
}

function smartOverview() {
  const data = smartState.data;
  const sync = data.syncStatus || {};
  const forecast = data.forecastRuns?.[0];
  const plan = data.planningRuns?.[0];
  const printers = data.printers || [];
  const healthyPrinters = printers.filter((printer) => printer.transferOrderReady && ["online", "offline"].includes(printer.status)).length;
  const totals = plan?.totals || {};
  return `
    <section class="smart-stats">
      <article class="smart-stat"><small>Inventory + sales data</small><strong>${sync.inventoryStatus === "ready" ? "Inventory ready" : "Sync inventory"}</strong><span>${smartNumber(sync.inventoryItemCount, 0)} NetSuite items · ${smartNumber(sync.salesFactCount, 0)} ${smartEscape((sync.salesSource || "workbook").toUpperCase())} sales facts</span></article>
      <article class="smart-stat"><small>Latest forecast</small><strong>${forecast ? `#${forecast.id}` : "—"}</strong><span>${forecast ? `${smartNumber(forecast.metrics?.forecasts, 0)} item-yard series · ${smartDate(forecast.completedAt, true)}` : "No forecast run yet"}</span></article>
      <article class="smart-stat"><small>Latest plan</small><strong>${plan ? smartNumber(totals.proposals, 0) : "—"}</strong><span>${plan ? `${smartNumber(totals.poProposals, 0)} PO · ${smartNumber(totals.toProposals, 0)} TO · revision ${plan.revision}` : "No planning run yet"}</span></article>
      <article class="smart-stat"><small>TO print routing</small><strong>${healthyPrinters}/4</strong><span>${printers.filter((printer) => printer.status === "online").length} agent(s) online · two printers required per source yard</span></article>
    </section>
    <section class="smart-section">
      <div class="smart-section-head">
        <div><h2>Controlled planning cycle</h2><p>Forecasts remain explainable and shadowed until a yard/series segment passes promotion rules.</p></div>
        <div class="smart-actions">
          ${smartCanWrite() ? `<button class="smart-button blue" data-smart-action="run-forecast" type="button">Run forecast</button><button class="smart-button primary" data-smart-action="run-plan" type="button">Build PO / TO plan</button>` : ""}
          <button class="smart-button" data-smart-action="refresh" type="button">Refresh</button>
        </div>
      </div>
      <div class="smart-section-body smart-grid-2">
        <article class="smart-card"><h3>1. Live item and inventory truth</h3><p>NetSuite owns item identity, vendor, UOM, conversions, weight, and all four yard balances. Item Master stores only operational overrides such as lead time, vendor yard, and yard eligibility.</p></article>
        <article class="smart-card"><h3>2. Seasonal demand forecast</h3><p>The uploaded raw sales CSV feeds a calendar-aware baseline: demand ramps in March/April, peaks in June/July, and declines from October. Statistical candidates remain backtested and explainable.</p></article>
        <article class="smart-card"><h3>3. Vendor response revisions</h3><p>Direct-vendor PO proposals wait for reply. Partial supply, stock-out, production ETA, or credit hold creates a new revision and recalculates only unconfirmed draft transfers.</p></article>
        <article class="smart-card"><h3>4. Safe TO execution</h3><p>A confirmed TO reserves source stock, creates exactly one transfer in live mode, verifies Pending Fulfillment, retrieves its picking ticket, and prints one copy on each of the source yard's two TO printers.</p></article>
      </div>
    </section>
    ${plan ? `<section class="smart-section"><div class="smart-section-head"><div><h3>Latest planning run #${plan.id}</h3><p>${smartDate(plan.completedAt, true)} · ${smartEscape(plan.triggerSource)} · revision ${plan.revision}</p></div>${smartPill(plan.status)}</div><div class="smart-section-body smart-grid-4"><div class="smart-card"><h3>${smartNumber(totals.shortageLines, 0)}</h3><p>Undercover item-yard lines</p></div><div class="smart-card"><h3>${smartNumber(totals.urgent, 0)}</h3><p>Urgent proposals</p></div><div class="smart-card"><h3>${smartNumber(totals.held, 0)}</h3><p>Held or incomplete loads</p></div><div class="smart-card"><h3>${smartNumber(totals.exceptions?.length || 0, 0)}</h3><p>Manual planning exceptions</p></div></div></section>` : ""}`;
}

function smartItemYard(item, locationId) {
  return (item.yardPolicies || []).find((policy) => Number(policy.locationId) === Number(locationId)) || {
    locationId,
    yardCode: String(locationId),
    eligible: false,
    capacityPallets: 25,
    capacitySource: "default",
    capacityManuallyOverridden: false,
    serviceQuantile: Number(locationId) === 15 ? 0.95 : 0.90,
    minimumSafetyPallets: 1
  };
}

function smartCapacityProvenance(policy = {}) {
  const source = String(policy.capacitySource || "default").trim().toLowerCase();
  if (policy.capacityManuallyOverridden || source === "manual") return "Manual override";
  if (source === "decision_workbook") {
    const sheet = String(policy.capacitySourceSheet || "*_Cal").trim();
    const row = Number(policy.capacitySourceRow);
    const reference = Number.isInteger(row) && row > 1 ? `${sheet} row ${row}` : sheet;
    const method = String(policy.capacityMatchMethod || "").trim().replaceAll("_", " ");
    return method ? `${reference} · ${method}` : reference;
  }
  if (source === "legacy_import") return "Legacy import · awaiting verified *_Cal match";
  return Number(policy.capacityPallets) === 25
    ? "Default 25 · no verified *_Cal match"
    : "Default · no verified *_Cal match";
}

function smartItemBalance(item, locationId) {
  return (item.balances || []).find((balance) => Number(balance.locationId) === Number(locationId)) || {
    quantityOnHand: 0,
    quantityAvailable: 0,
    syncedAt: null
  };
}

function smartVendorYardOptions(item, yards = []) {
  const selectedId = Number(item.vendorYardId);
  const sourceYard = String(item.vendorYard || "").trim();
  const hasMappedSelection = Number.isInteger(selectedId) && yards.some((yard) => Number(yard.id) === selectedId);
  const blank = `<option value="" ${!hasMappedSelection && !sourceYard ? "selected" : ""}>Select vendor yard</option>`;
  const source = sourceYard && !hasMappedSelection ? `<option value="__source__" selected>Item Master · ${smartEscape(sourceYard)} (local yard not matched)</option>` : "";
  return `${blank}${source}${yards.map((yard) => `<option value="${yard.id}" ${hasMappedSelection && selectedId === Number(yard.id) ? "selected" : ""}>${smartEscape(yard.vendor)} · ${smartEscape(yard.yard)}</option>`).join("")}`;
}

function smartVendorYardFilterOptions(yards = []) {
  const selected = String(smartState.itemVendorYard || "");
  const option = (value, label) => '<option value="' + smartEscape(value) + '" ' + (selected === value ? "selected" : "") + ">" + smartEscape(label) + "</option>";
  return [
    option("", "All vendor yard overrides"),
    option("assigned", "Has vendor yard override"),
    option("none", "No vendor yard override"),
    option("unmatched", "Unmatched source value"),
    ...yards.map((yard) => option("id:" + yard.id, yard.vendor + " · " + yard.yard))
  ].join("");
}

function smartCaptureItemViewport(row) {
  const grid = row?.closest(".smart-item-grid-wrap");
  return {
    itemId: String(row?.dataset.itemRow || ""),
    rowTop: row ? row.getBoundingClientRect().top : null,
    windowX: window.scrollX,
    windowY: window.scrollY,
    gridScrollLeft: grid?.scrollLeft || 0,
    gridScrollTop: grid?.scrollTop || 0
  };
}

function smartRestoreItemViewport(snapshot) {
  if (!snapshot) return;
  requestAnimationFrame(() => {
    const grid = document.querySelector(".smart-item-grid-wrap");
    if (grid) {
      grid.scrollLeft = snapshot.gridScrollLeft;
      grid.scrollTop = snapshot.gridScrollTop;
    }
    window.scrollTo(snapshot.windowX, snapshot.windowY);
    const row = snapshot.itemId
      ? document.querySelector('[data-item-row="' + snapshot.itemId + '"]')
      : null;
    if (row && Number.isFinite(snapshot.rowTop)) {
      window.scrollBy(0, row.getBoundingClientRect().top - snapshot.rowTop);
      row.querySelector('[data-smart-action="save-item"]')?.focus({ preventScroll: true });
    }
  });
}

function smartItemYardCell(item, yard) {
  const policy = smartItemYard(item, yard.locationId);
  const balance = smartItemBalance(item, yard.locationId);
  const pallets = Number(item.toPlt) > 0 ? Number(balance.quantityAvailable) / Number(item.toPlt) : null;
  return `<td class="smart-yard-cell">
    <strong>${smartNumber(balance.quantityAvailable, 2)} ${smartEscape(item.stockUnit || "UOM")}</strong>
    <span>${pallets === null ? "No ToPLT" : `${smartNumber(pallets, 2)} PLT available`}</span>
    <label><input data-item-yard-enabled="${yard.locationId}" data-service-quantile="${policy.serviceQuantile}" data-minimum-safety="${policy.minimumSafetyPallets}" type="checkbox" ${policy.eligible ? "checked" : ""} ${smartCanWrite() ? "" : "disabled"} /> Plan this yard</label>
    <label class="smart-capacity">Capacity <input data-item-yard-capacity="${yard.locationId}" type="number" min="0" step="1" value="${smartEscape(policy.capacityPallets)}" ${smartCanWrite() ? "" : "disabled"} /> PLT</label>
    <small class="smart-capacity-provenance">${smartEscape(smartCapacityProvenance(policy))}</small>
  </td>`;
}

function smartItemMaster() {
  const data = smartState.itemData;
  const sync = smartState.data.syncStatus || {};
  if (!data) return `<section class="smart-section"><div class="smart-empty">Open Item Master to load NetSuite items.</div></section>`;
  const rows = data.items || [];
  const yards = [
    { locationId: 1, code: "3445" },
    { locationId: 28, code: "2967" },
    { locationId: 15, code: "12441" },
    { locationId: 26, code: "150" }
  ];
  const first = data.total ? data.offset + 1 : 0;
  const last = Math.min(data.total || 0, data.offset + rows.length);
  return `
    <section class="smart-section">
      <div class="smart-section-head">
        <div><h2>Item Master</h2><p>Edit only Smart SCM policy fields. Item, vendor, UOM, conversion, weight, and inventory are read directly from NetSuite.</p></div>
        <div class="smart-actions">
          <span class="smart-help">Inventory ${smartPill(sync.inventoryStatus || "never")} ${smartDate(sync.inventorySyncedAt, true)} · Sales source ${smartEscape((sync.salesSource || "workbook").toUpperCase())}</span>
          ${smartCanWrite() ? `<button class="smart-button blue" data-smart-action="sync-live" type="button">Sync NetSuite items + inventory</button>` : ""}
        </div>
      </div>
      <div class="smart-toolbar">
        <input id="smartItemSearch" type="search" value="${smartEscape(smartState.itemSearch)}" placeholder="Search item, ID, vendor, or description" />
        <select id="smartItemEnabled"><option value="" ${smartState.itemEnabled === "" ? "selected" : ""}>All NetSuite items</option><option value="true" ${smartState.itemEnabled === "true" ? "selected" : ""}>Planning enabled</option><option value="false" ${smartState.itemEnabled === "false" ? "selected" : ""}>Planning disabled</option></select>
        <select id="smartItemVendorYard">${smartVendorYardFilterOptions(data.vendorYards || [])}</select>
        <span class="smart-help">${first}–${last} of ${smartNumber(data.total, 0)}</span>
        <button class="smart-button" data-smart-action="item-prev" type="button" ${data.offset <= 0 ? "disabled" : ""}>Previous</button>
        <button class="smart-button" data-smart-action="item-next" type="button" ${data.offset + rows.length >= data.total ? "disabled" : ""}>Next</button>
      </div>
      <div class="smart-table-wrap smart-item-grid-wrap"><table class="smart-table smart-item-table"><thead><tr><th>Plan</th><th>NetSuite item</th><th>Vendor</th><th>Vendor yard override</th><th>Lead time</th><th>Conversion / weight</th>${yards.map((yard) => `<th>${yard.code} availability / policy</th>`).join("")}<th>NetSuite sync</th><th></th></tr></thead><tbody>
        ${rows.map((item) => `<tr data-item-row="${item.itemId}">
          <td><input data-item-field="planningEnabled" type="checkbox" ${item.planningEnabled ? "checked" : ""} ${smartCanWrite() ? "" : "disabled"} /></td>
          <td class="smart-item-name"><strong>${smartEscape(item.itemName)}</strong><span>ID ${item.itemId} · ${smartEscape(item.description || item.displayName || item.itemType)}</span></td>
          <td><strong>${smartEscape(item.vendor || "—")}</strong><span class="smart-help">NetSuite-owned</span></td>
          <td><select data-item-field="vendorYardId" data-source-yard="${smartEscape(item.vendorYard || "")}" ${smartCanWrite() ? "" : "disabled"}>${smartVendorYardOptions(item, data.vendorYards || [])}</select>${item.vendorYard && !item.vendorYardId ? `<span class="smart-help">Source value retained until a matching local vendor yard is selected.</span>` : ""}</td>
          <td><input class="smart-lead-input" data-item-field="leadTimeDays" type="number" min="1" max="730" step="1" value="${smartEscape(item.leadTimeDays ?? item.netSuiteLeadTimeDays ?? 14)}" ${smartCanWrite() ? "" : "disabled"} /><span class="smart-help">days${item.netSuiteLeadTimeDays ? ` · NetSuite ${smartNumber(item.netSuiteLeadTimeDays, 0)}` : ""}</span></td>
          <td><strong>1 PLT = ${smartNumber(item.toPlt, 4)} ${smartEscape(item.stockUnit || "UOM")}</strong><span>${smartNumber(item.palletWeightLbs, 2)} lb / PLT · LYR ${smartNumber(item.toLyr, 4)} · SEC ${smartNumber(item.toSec, 4)} · PCS ${smartNumber(item.toPcs, 4)}</span></td>
          ${yards.map((yard) => smartItemYardCell(item, yard)).join("")}
          <td>${smartDate(item.netSuiteSyncedAt, true)}</td>
          <td>${smartCanWrite() ? `<button class="smart-button primary" data-smart-action="save-item" data-item-id="${item.itemId}" type="button">Save</button>` : ""}</td>
        </tr>`).join("") || `<tr><td colspan="12" class="smart-empty">No NetSuite item matches this search.</td></tr>`}
      </tbody></table></div>
    </section>`;
}

function smartForecastStockPolicy(row) {
  const calculationDriver = row.stockPolicyModel && row.stockPolicyModel !== "formula"
    ? `${smartEscape(row.stockPolicyModel)} quantile target`
    : `factor ${smartNumber(row.safetyFactor, 3)}`;
  let formulaExplanation;
  if (row.stockPolicyModel && row.stockPolicyModel !== "formula") {
    formulaExplanation = `<small>ROP and preferred use the active ${smartEscape(row.stockPolicyModel)} quantiles and remain capped by ${smartNumber(row.capacityPallets, 2)} PLT capacity.</small>`;
  } else if (row.zeroDemandCoverageApplied) {
    formulaExplanation = `<small>Base ROP = round(${smartNumber(row.safetyStockPallets, 3)} safety + ${smartNumber(row.weeklyDemandPallets, 2)} demand × ${smartNumber(row.leadWeeks, 2)} lead) = ${smartNumber(row.baseReorderPointPallets, 2)} PLT; coverage floor raises final ROP to ${smartNumber(row.reorderPointPallets, 2)} PLT.</small>
      <small>Preferred = min(${smartNumber(row.capacityPallets, 2)} capacity, max(${smartNumber(row.basePreferredPallets, 2)} base preferred, ${smartNumber(row.reorderPointPallets, 2)} ROP)) = ${smartNumber(row.preferredPallets, 2)} PLT</small>`;
  } else {
    formulaExplanation = `<small>ROP = round(${smartNumber(row.safetyStockPallets, 3)} safety + ${smartNumber(row.weeklyDemandPallets, 2)} demand × ${smartNumber(row.leadWeeks, 2)} lead) = ${smartNumber(row.baseReorderPointPallets, 2)} PLT</small>
      <small>Preferred = min(${smartNumber(row.capacityPallets, 2)} capacity, ceil(${smartNumber(row.reorderPointPallets, 2)} ROP + ${smartNumber(row.weeklyDemandPallets, 2)} demand × ${smartNumber(row.leadWeeks, 2)} lead)) = ${smartNumber(row.preferredPallets, 2)} PLT</small>`;
  }
  return `<div class="smart-stock-policy">
    <span>Safety stock <strong>${smartNumber(row.safetyStockPallets, 3)} PLT</strong></span>
    <span>ROP <strong>${smartNumber(row.reorderPointPallets, 2)} PLT</strong></span>
    <span>Preferred stock level <strong>${smartNumber(row.preferredPallets, 2)} PLT</strong></span>
    <span>Capacity <strong>${smartNumber(row.capacityPallets, 2)} PLT</strong></span>
    <small>${smartNumber(row.weeklyDemandPallets, 2)} PLT/week · SD ${smartNumber(row.weeklyDemandSdPallets, 3)} · ${smartNumber(row.leadWeeks, 2)} lead weeks · ${calculationDriver} · current policy/settings</small>
    ${formulaExplanation}
  </div>`;
}

function smartForecasts() {
  const rows = smartState.forecasts || [];
  const latest = smartState.data.forecastRuns?.[0];
  const sync = smartState.data.syncStatus || {};
  return `
    <section class="smart-section">
      <div class="smart-section-head"><div><h2>Forecast evidence</h2><p>Forecasts use the uploaded raw sales CSV and are expressed in pallets per week. The NetSuite sales-history API is suspended.</p></div><div class="smart-actions">${smartCanWrite() ? `<button class="smart-button blue" data-smart-action="run-forecast" type="button">Run forecast</button>` : ""}</div></div>
      <div class="smart-toolbar smart-sales-upload">
        <input id="smartSalesCsv" type="file" accept=".csv,text/csv" />
        ${smartCanWrite() ? `<button class="smart-button primary" data-smart-action="upload-sales-csv" type="button">Upload raw sales CSV</button>` : ""}
        <button class="smart-button" data-smart-action="download-sales-template" type="button">CSV header template</button>
        <span class="smart-help">Required: Internal ID, Date, Quantity, Location. Recommended: Document Number, Item, Delivery Method, Sales Amount, Status.</span>
        <span class="smart-help">Current: ${smartEscape(sync.salesFilename || "legacy workbook fallback")} · ${smartNumber(sync.salesFactCount, 0)} rows · ${smartDate(sync.salesCoverageStart)} to ${smartDate(sync.salesSyncedThrough)}</span>
      </div>
      <div class="smart-toolbar"><input id="smartForecastSearch" type="search" value="${smartEscape(smartState.forecastSearch)}" placeholder="Item, ID, series, or vendor" /><select id="smartForecastYard"><option value="">All yards</option>${["3445", "2967", "12441", "150"].map((yard) => `<option value="${yard}" ${smartState.forecastYard === yard ? "selected" : ""}>${yard}</option>`).join("")}</select><button class="smart-button" data-smart-action="filter-forecasts" type="button">Apply</button>${latest ? `<span class="smart-help">Run #${latest.id} · cutoff ${smartDate(latest.dataCutoff)} · ${smartNumber(latest.metrics?.scoredSeries, 0)} backtested series</span>` : ""}</div>
      <div class="smart-table-wrap"><table class="smart-table"><thead><tr><th>Item</th><th>Yard</th><th>Series</th><th>Selected / active</th><th>Confidence</th><th class="numeric">History</th><th class="numeric">P50 / week</th><th class="numeric">P90 / week</th><th class="numeric">Lead P90</th><th class="numeric">WAPE</th><th class="numeric">Bias</th><th>Current stock policy</th><th>Zero-demand coverage</th><th>Gate</th></tr></thead><tbody>
        ${rows.map((row) => `<tr><td><strong>${smartEscape(row.itemName || row.itemId)}</strong><div class="smart-help">ID ${row.itemId}</div></td><td>${smartEscape(row.yardCode)}</td><td>${smartEscape(row.series || "—")}</td><td>${smartEscape(row.selectedModel)}<div class="smart-help">active: ${smartEscape(row.authoritativeModel)}</div></td><td>${smartPill(row.confidence)}</td><td class="numeric">${row.historyWeeks} wk<br><span class="smart-help">${row.positiveWeeks} positive</span></td><td class="numeric">${smartNumber(row.p50Weekly, 2)}</td><td class="numeric">${smartNumber(row.p90Weekly, 2)}</td><td class="numeric">${smartNumber(row.leadTimeP90, 2)}</td><td class="numeric">${row.wape === null ? "—" : smartPercent(row.wape, 1)}</td><td class="numeric">${row.bias === null ? "—" : smartPercent(row.bias, 1)}</td><td>${smartForecastStockPolicy(row)}</td><td>${row.coverageFloorPallets > 0 ? `<strong>${smartNumber(row.coverageFloorPallets, 0)} PLT</strong><div class="smart-help">${smartNumber(row.representativeOrderPallets, 2)} PLT/order × ${smartNumber(row.coverageOrderCount, 0)} · ${smartEscape(row.coverageSource)}</div>${row.zeroDemandCoverageApplied ? smartPill("ok", "Active") : smartPill("warn", "Preview")}${row.coverageCapacityShortfall ? smartPill("attention", "Capacity capped") : ""}` : `<span class="smart-help">No usable order evidence</span>`}</td><td>${row.eligibleForPromotion ? `${smartPill("ok", "Eligible")}${smartCanWrite() ? `<div><button class="smart-button" data-smart-action="promote-model" data-yard="${smartEscape(row.yardCode)}" data-series="${smartEscape(row.series || "*")}" type="button">Promote segment</button></div>` : ""}` : smartPill("warn", "Shadow only")}</td></tr>`).join("") || `<tr><td colspan="14" class="smart-empty">No forecast matches this filter. Enable the item and at least one yard in Item Master, then run a forecast.</td></tr>`}
      </tbody></table></div>
    </section>`;
}

function smartFilteredProposals() {
  const search = smartState.planSearch.trim().toLowerCase();
  return (smartState.plan?.proposals || []).filter((proposal) => {
    if (smartState.planType && proposal.proposalType !== smartState.planType) return false;
    if (smartState.planStatus && proposal.status !== smartState.planStatus) return false;
    if (!search) return true;
    return [proposal.sourceName, proposal.destinationName, proposal.vendor, proposal.plant, proposal.memo, ...proposal.lines.flatMap((line) => [line.itemId, line.itemName, line.itemDescription])]
      .some((value) => String(value || "").toLowerCase().includes(search));
  });
}

function smartCoverageEvidence(line) {
  const reason = line.reason || {};
  if (!reason.zeroDemandCoverageApplied) return "";
  return `<div class="smart-reason"><strong>Zero-demand ROP floor</strong><span>${smartNumber(reason.representativeOrderPallets, 2)} PLT/order × ${smartNumber(reason.coverageOrderCount, 0)} orders = ${smartNumber(reason.coverageFloorPallets, 0)} PLT</span><span>Evidence: ${smartEscape(reason.coverageSource || "none")} · local ${smartNumber(reason.coverageLocalSamples, 0)} · donor ${smartNumber(reason.coverageDonorSamples, 0)}</span><span>Available: ${smartNumber(reason.availablePallets, 2)} PLT · ${reason.availableCoverageOrders === null ? "—" : smartNumber(reason.availableCoverageOrders, 1)} representative orders</span>${reason.coverageCoveredByInbound ? `<span>Current gap is covered by inbound stock.</span>` : ""}${reason.coverageCapacityShortfall ? `<span>Configured capacity caps this floor.</span>` : ""}${reason.coverageReviewRequired ? smartPill("warn", "Borrowed evidence · review required") : smartPill("ok", "Local evidence")}</div>`;
}

function smartProposalCard(proposal) {
  const isPo = proposal.proposalType === "PO";
  const executionRef = isPo ? proposal.netsuitePurchaseOrderRef : proposal.netsuiteTransferOrderRef;
  const hasExecutionReference = Boolean(isPo
    ? (proposal.netsuitePurchaseOrderId || proposal.netsuitePurchaseOrderRef)
    : (proposal.netsuiteTransferOrderId || proposal.netsuiteTransferOrderRef));
  const locked = hasExecutionReference || ["confirmed", "executing", "completed", "superseded", "cancelled"].includes(proposal.status);
  const canConfirm = !hasExecutionReference && !isPo && ["draft", "reviewed"].includes(proposal.status);
  let actions = "";
  if (smartCanWrite() && isPo && proposal.status === "held") {
    actions = `<button class="smart-button primary" data-smart-action="proposal-status" data-proposal-id="${proposal.id}" data-status="order_requested" type="button">Order Requested</button><button class="smart-button danger" data-smart-action="proposal-status" data-proposal-id="${proposal.id}" data-status="cancelled" type="button">Cancel</button>`;
  } else if (smartCanWrite() && isPo && proposal.status === "order_requested") {
    actions = `<button class="smart-button" data-smart-action="open-vendor-load" data-proposal-id="${proposal.id}" type="button">Vendor reply</button><button class="smart-button warn" data-smart-action="proposal-status" data-proposal-id="${proposal.id}" data-status="held" type="button">Return to Hold</button><button class="smart-button danger" data-smart-action="proposal-status" data-proposal-id="${proposal.id}" data-status="cancelled" type="button">Cancel</button>`;
  } else if (isPo && ["vendor_replied", "attention", "failed", "completed"].includes(proposal.status)) {
    actions = `<button class="smart-button" data-smart-action="open-vendor-load" data-proposal-id="${proposal.id}" type="button">View vendor load</button>`;
  } else if (smartCanWrite() && !isPo && !locked) {
    actions = `<button class="smart-button ${proposal.status === "held" ? "" : "warn"}" data-smart-action="proposal-status" data-proposal-id="${proposal.id}" data-status="${proposal.status === "held" ? "reviewed" : "held"}" type="button">${proposal.status === "held" ? "Release" : "Hold"}</button><button class="smart-button danger" data-smart-action="proposal-status" data-proposal-id="${proposal.id}" data-status="cancelled" type="button">Cancel</button>`;
  }
  return `<article class="smart-proposal">
    <div class="smart-proposal-head">
      <div><strong>${smartEscape(proposal.proposalType)}</strong><div>${smartPill(proposal.status)}</div></div>
      <div class="smart-proposal-route"><strong>${smartEscape(proposal.sourceName || proposal.vendor || "Vendor")} → ${smartEscape(proposal.destinationName)}</strong><span>#${proposal.id} · ${smartEscape(proposal.phase.replaceAll("_", " "))}${proposal.provisional ? " · provisional" : ""}${proposal.urgent ? " · urgent" : ""}</span></div>
      <div class="smart-proposal-metric"><strong>${smartNumber(proposal.totalPallets, 2)} PLT</strong><span>Pallets</span></div>
      <div class="smart-proposal-metric"><strong>${smartNumber(proposal.totalWeightLbs, 0)} lb</strong><span>${smartPercent(proposal.utilization, 0)} truck</span></div>
      <div class="smart-proposal-metric"><strong>${executionRef ? smartEscape(executionRef) : "—"}</strong><span>${isPo ? "PO load ref" : "TO / mock ref"}</span></div>
      <div class="smart-actions">
        ${actions}
        ${smartCanWrite() && canConfirm ? `<button class="smart-button primary" data-smart-action="confirm-transfer" data-proposal-id="${proposal.id}" type="button">Confirm TO + print</button>` : ""}
        ${smartCanWrite() && !isPo && hasExecutionReference && proposal.status === "attention" ? `<button class="smart-button warn" data-smart-action="retry-picking-ticket" data-proposal-id="${proposal.id}" type="button">Retry picking ticket</button>` : ""}
      </div>
    </div>
    <div class="smart-proposal-lines smart-table-wrap"><table class="smart-table"><thead><tr><th>Item</th><th class="numeric">Required</th><th class="numeric">Proposed</th><th class="numeric">Sales quantity</th><th class="numeric">Line weight</th><th>Decision evidence</th></tr></thead><tbody>${proposal.lines.map((line) => `<tr><td><strong>${smartEscape(line.itemName)}</strong><div class="smart-help">ID ${line.itemId} · ${smartEscape(line.itemDescription || line.unit || "")}</div>${line.manualPlanningRequired ? smartPill("attention", "Missing conversion / weight") : ""}</td><td class="numeric">${smartNumber(line.requiredPallets, 2)} PLT</td><td class="numeric">${smartNumber(line.proposedPallets, 2)} PLT</td><td class="numeric">${smartNumber(line.salesQuantity, 3)} ${smartEscape(line.unit || "UOM")}</td><td class="numeric">${smartNumber(line.lineWeightLbs, 0)} lb</td><td>${smartCoverageEvidence(line)}<div class="smart-reason">${Object.entries(line.reason || {}).slice(0, 8).map(([key, value]) => `<span>${smartEscape(key.replaceAll(/([A-Z])/g, " $1"))}: ${smartEscape(value)}</span>`).join("")}</div></td></tr>`).join("")}</tbody></table></div>
  </article>`;
}

function smartPlans() {
  const plan = smartState.plan;
  const runs = smartState.data.planningRuns || [];
  const proposals = smartFilteredProposals();
  return `
    <section class="smart-section">
      <div class="smart-section-head"><div><h2>PO / TO proposal review</h2><p>Every PO load starts on Hold. Mark a reviewed PO load Order Requested to place it in the cross-plan Vendor replies queue; TO confirmation remains unchanged.</p></div><div class="smart-actions">${smartCanWrite() ? `<button class="smart-button primary" data-smart-action="run-plan" type="button">Build new plan</button>` : ""}</div></div>
      <div class="smart-toolbar"><select id="smartPlanRun"><option value="">Select a run</option>${runs.map((run) => `<option value="${run.id}" ${Number(plan?.id) === Number(run.id) ? "selected" : ""}>#${run.id} · ${smartDate(run.completedAt, true)} · r${run.revision}</option>`).join("")}</select><input id="smartPlanSearch" type="search" value="${smartEscape(smartState.planSearch)}" placeholder="Item, vendor, yard, or memo" /><select id="smartPlanType"><option value="">PO + TO</option><option value="PO" ${smartState.planType === "PO" ? "selected" : ""}>PO only</option><option value="TO" ${smartState.planType === "TO" ? "selected" : ""}>TO only</option></select><select id="smartPlanStatus"><option value="">All statuses</option>${["draft", "held", "order_requested", "vendor_replied", "reviewed", "attention", "executing", "completed", "failed", "superseded", "cancelled"].map((status) => `<option value="${status}" ${smartState.planStatus === status ? "selected" : ""}>${status.replaceAll("_", " ")}</option>`).join("")}</select><button class="smart-button" data-smart-action="filter-plan" type="button">Apply</button><span class="smart-help">${proposals.length} proposal(s)</span></div>
      ${plan ? `<div class="smart-proposals">${proposals.map(smartProposalCard).join("") || `<div class="smart-empty">No proposal matches this filter.</div>`}</div>` : `<div class="smart-empty">No planning run exists. Configure Item Master, upload sales history, then build a plan; live NetSuite inventory is refreshed automatically.</div>`}
    </section>`;
}

function smartVendorRepliesLegacy() {
  const poProposals = (smartState.plan?.proposals || []).filter((proposal) => proposal.proposalType === "PO" && !["superseded", "cancelled"].includes(proposal.status));
  const rows = poProposals.flatMap((proposal) => proposal.lines.map((line) => ({ proposal, line, latest: line.vendorResponses?.[0] || {} })));
  return `
    <section class="smart-section">
      <div class="smart-section-head"><div><h2>Vendor reply reconciliation</h2><p>Record the vendor's actual availability. Any shortfall creates a revision and recalculates only the residual demand and unlocked TO alternatives.</p></div><div class="smart-actions"><button class="smart-button" data-smart-action="download-vendor-template" type="button">Download CSV template</button>${smartCanWrite() ? `<input id="smartVendorImport" type="file" accept=".csv,.xlsx" /><button class="smart-button blue" data-smart-action="import-vendor-replies" type="button">Import replies</button>` : ""}</div></div>
      <div class="smart-table-wrap"><table class="smart-table"><thead><tr><th>PO proposal / item</th><th>Status</th><th class="numeric">Requested</th><th class="numeric">Confirmed</th><th>Ready date</th><th>Vendor ref</th><th>PO ref</th><th>Remarks</th><th></th></tr></thead><tbody>
        ${rows.map(({ proposal, line, latest }) => `<tr data-vendor-line="${line.id}"><td><strong>#${proposal.id} · ${smartEscape(proposal.vendor || proposal.sourceName)}</strong><div>${smartEscape(line.itemName)} · ${smartEscape(proposal.destinationName)}</div><div class="smart-help">Reply due ${smartDate(proposal.vendorReplyDueAt, true)} · revision ${latest.revision || 0}</div></td><td><select data-vendor-field="responseStatus">${["awaiting", "confirmed", "partial", "out_of_stock", "production_eta", "credit_hold", "cancelled"].map((status) => `<option value="${status}" ${(latest.response_status || "awaiting") === status ? "selected" : ""}>${status.replaceAll("_", " ")}</option>`).join("")}</select></td><td class="numeric">${smartNumber(line.proposedPallets, 2)} PLT</td><td><input data-vendor-field="confirmedPallets" type="number" min="0" step="0.01" value="${smartEscape(latest.confirmed_pallets ?? line.confirmedPallets ?? 0)}" /></td><td><input data-vendor-field="readyDate" type="date" value="${smartEscape(String(latest.ready_date || "").slice(0, 10))}" /></td><td><input class="wide-field" data-vendor-field="vendorReference" value="${smartEscape(latest.vendor_reference || "")}" /></td><td><input class="wide-field" data-vendor-field="netsuitePoReference" value="${smartEscape(latest.netsuite_po_reference || "")}" /></td><td><input class="wide-field" data-vendor-field="remarks" value="${smartEscape(latest.remarks || "")}" /></td><td>${smartCanWrite() ? `<button class="smart-button primary" data-smart-action="save-vendor-reply" data-line-id="${line.id}" type="button">Save reply</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="9" class="smart-empty">This planning run has no active direct-vendor PO lines.</td></tr>`}
      </tbody></table></div>
    </section>
    ${smartState.plan?.revisions?.length ? `<section class="smart-section"><div class="smart-section-head"><div><h3>Plan revision history</h3><p>Confirmed executions are never rewritten by a vendor response.</p></div></div><div class="smart-table-wrap"><table class="smart-table"><thead><tr><th>Revision</th><th>Reason</th><th>Changed</th></tr></thead><tbody>${smartState.plan.revisions.map((revision) => `<tr><td>r${revision.revision}<div class="smart-help">${smartDate(revision.createdAt, true)}</div></td><td>${smartEscape(revision.reason)}</td><td>${smartEscape(JSON.stringify(revision.diff || {}))}</td></tr>`).join("")}</tbody></table></div></section>` : ""}`;
}

function smartSettings() {
  const settings = smartState.data.settings || {};
  const activeSegments = Object.keys(settings.modelActiveSegments || {});
  return `
    <form class="smart-section" id="smartSettingsForm">
      <div class="smart-section-head"><div><h2>Smart SCM controls</h2><p>Live execution is guarded by both this setting and a server environment flag. Daily planning uses the configured Toronto-local schedule.</p></div>${smartCanWrite() ? `<button class="smart-button primary" type="submit">Save settings</button>` : ""}</div>
      <div class="smart-section-body smart-form-grid">
        <label class="smart-field"><span>Execution mode</span><select name="executionMode" ${smartCanWrite() ? "" : "disabled"}><option value="mock" ${settings.executionMode === "mock" ? "selected" : ""}>Mock — no NetSuite write</option><option value="live" ${settings.executionMode === "live" ? "selected" : ""}>Live — guarded NetSuite TO</option></select><small>Start in mock and validate proposals, reservations, and print routing first.</small></label>
        <label class="smart-field"><span>Forecast mode</span><select name="forecastMode" ${smartCanWrite() ? "" : "disabled"}><option value="formula" ${settings.forecastMode === "formula" ? "selected" : ""}>Formula only</option><option value="shadow" ${settings.forecastMode === "shadow" ? "selected" : ""}>Formula + shadow comparison</option><option value="hybrid" ${settings.forecastMode === "hybrid" ? "selected" : ""}>Promoted prediction segments</option></select><small>Hybrid uses prediction only for explicitly promoted yard/series segments.</small></label>
        <label class="smart-field"><span>Daily run time</span><input name="dailyTime" type="time" value="${smartEscape(settings.dailyTime || "06:00")}" ${smartCanWrite() ? "" : "disabled"} /><small>${smartEscape(settings.timeZone || "America/Toronto")}</small></label>
        <label class="smart-field"><span>Daily automation</span><span class="smart-check"><input name="dailyEnabled" type="checkbox" ${settings.dailyEnabled ? "checked" : ""} ${smartCanWrite() ? "" : "disabled"} /> Run one forecast and plan per local day</span></label>
        <label class="smart-field"><span>Formula average period</span><input name="formulaAverageWeeks" type="number" min="2" max="52" step="1" value="${smartEscape(settings.formulaAverageWeeks || 6)}" ${smartCanWrite() ? "" : "disabled"} /><small>Completed weeks used for normal average demand and SD.</small></label>
        <label class="smart-field"><span>Stockout peak period</span><input name="stockoutBenchmarkWeeks" type="number" min="2" max="52" step="1" value="${smartEscape(settings.stockoutBenchmarkWeeks || 6)}" ${smartCanWrite() ? "" : "disabled"} /><small>Completed weeks searched for maximum demand when less than one pallet is available.</small></label>
        <label class="smart-field"><span>12441 / delivery safety factor</span><input name="deliverySafetyFactor" type="number" min="0.01" max="5" step="0.001" value="${smartEscape(settings.deliverySafetyFactor || 1.645)}" ${smartCanWrite() ? "" : "disabled"} /><small>Default 1.645.</small></label>
        <label class="smart-field"><span>Pickup-yard safety factor</span><input name="pickupSafetyFactor" type="number" min="0.01" max="5" step="0.001" value="${smartEscape(settings.pickupSafetyFactor || 1.3)}" ${smartCanWrite() ? "" : "disabled"} /><small>Applies to 3445, 2967, and 150. Default 1.3.</small></label>
        <label class="smart-field"><span>Zero-demand coverage</span><span class="smart-check"><input name="zeroDemandCoverageEnabled" type="checkbox" ${settings.zeroDemandCoverageEnabled ? "checked" : ""} ${smartCanWrite() ? "" : "disabled"} /> Apply an order-count ROP floor only when recent formula demand is zero</span><small>Borrowed low-sample proposals remain on Hold for review.</small></label>
        <label class="smart-field"><span>Pickup orders to cover</span><input name="zeroDemandPickupOrderCount" type="number" min="1" max="50" step="1" value="${smartEscape(settings.zeroDemandPickupOrderCount || 5)}" ${smartCanWrite() ? "" : "disabled"} /><small>Applies separately to each eligible SKU at 3445, 2967, and 150.</small></label>
        <label class="smart-field"><span>Delivery orders to cover</span><input name="zeroDemandDeliveryOrderCount" type="number" min="1" max="50" step="1" value="${smartEscape(settings.zeroDemandDeliveryOrderCount || 1)}" ${smartCanWrite() ? "" : "disabled"} /><small>Applies separately to each eligible SKU at 12441.</small></label>
        <label class="smart-field"><span>Representative order percentile</span><input name="coverageOrderPercentile" type="number" min="0.25" max="0.75" step="0.01" value="${smartEscape(settings.coverageOrderPercentile || 0.5)}" ${smartCanWrite() ? "" : "disabled"} /><small>Default 0.50 (median). Quantities stay fractional until the final coverage floor is rounded.</small></label>
        <label class="smart-field"><span>Coverage history (weeks)</span><input name="coverageHistoryWeeks" type="number" min="26" max="260" step="1" value="${smartEscape(settings.coverageHistoryWeeks || 104)}" ${smartCanWrite() ? "" : "disabled"} /><small>Completed weeks used for local and 3445 same-channel evidence.</small></label>
        <label class="smart-field"><span>Coverage prior strength (orders)</span><input name="coveragePriorStrengthOrders" type="number" min="1" max="100" step="1" value="${smartEscape(settings.coveragePriorStrengthOrders || 8)}" ${smartCanWrite() ? "" : "disabled"} /><small>Local evidence reaches equal weight with the borrowed baseline at this sample count.</small></label>
        <label class="smart-field"><span>Vendor response SLA (hours)</span><input name="vendorResponseSlaHours" type="number" min="1" max="720" value="${smartEscape(settings.vendorResponseSlaHours)}" ${smartCanWrite() ? "" : "disabled"} /></label>
        <label class="smart-field"><span>Truck capacity (lb)</span><input name="truckCapacityLbs" type="number" min="1" step="1" value="${smartEscape(settings.truckCapacityLbs)}" ${smartCanWrite() ? "" : "disabled"} /></label>
        <label class="smart-field"><span>Full load threshold</span><input name="fullLoadRatio" type="number" min="0.01" max="1" step="0.01" value="${smartEscape(settings.fullLoadRatio)}" ${smartCanWrite() ? "" : "disabled"} /><small>Ratio of configured truck weight.</small></label>
        <label class="smart-field"><span>Hold threshold</span><input name="holdLoadRatio" type="number" min="0.01" max="0.99" step="0.01" value="${smartEscape(settings.holdLoadRatio)}" ${smartCanWrite() ? "" : "disabled"} /><small>Non-urgent TO loads below this ratio stay held.</small></label>
      </div>
    </form>
    <section class="smart-section"><div class="smart-section-head"><div><h3>Promoted prediction segments</h3><p>Promotion can be applied from an eligible forecast row. Formula remains the fallback for every other segment.</p></div></div><div class="smart-section-body">${activeSegments.length ? `<div class="smart-actions">${activeSegments.map((segment) => `${smartPill("ok", segment)}${smartCanWrite() ? `<button class="smart-button danger" data-smart-action="fallback-model" data-segment="${smartEscape(segment)}" type="button">Return ${smartEscape(segment)} to formula</button>` : ""}`).join("")}</div>` : `<div class="smart-empty">No prediction segment is authoritative.</div>`}</div></section>`;
}

function smartContent() {
  if (!smartState.data) return `<section class="smart-section"><div class="smart-empty">Loading Smart SCM…</div></section>`;
  if (smartState.tab === "items") return smartItemMaster();
  if (smartState.tab === "forecasts") return smartForecasts();
  if (smartState.tab === "plans") return smartPlans();
  if (smartState.tab === "vendors") return smartVendorReplies();
  if (smartState.tab === "settings") return smartSettings();
  return smartOverview();
}

function smartRender() {
  smartScmApp.innerHTML = `${smartHeader()}<div class="smart-main">${smartState.error ? `<div class="smart-notice error">${smartEscape(smartState.error)}</div>` : ""}${smartState.notice ? `<div class="smart-notice">${smartEscape(smartState.notice)}</div>` : ""}${smartState.busy ? `<div class="smart-notice">${smartEscape(smartState.busy)}…</div>` : ""}${smartTabs()}${smartContent()}</div>`;
}

async function smartWork(label, task, success = "Saved") {
  smartState.busy = label;
  smartState.error = "";
  smartState.notice = "";
  smartRender();
  try {
    const result = await task();
    smartState.notice = success;
    return result;
  } catch (error) {
    smartState.error = error.message;
    throw error;
  } finally {
    smartState.busy = "";
    smartRender();
  }
}

smartScmApp.addEventListener("click", async (event) => {
  const tab = event.target.closest("[data-smart-tab]");
  if (tab) {
    smartState.tab = tab.dataset.smartTab;
    smartState.error = "";
    smartRender();
    if (smartState.tab === "items" && !smartState.itemData) {
      try {
        await smartLoadItems();
      } catch (error) {
        smartState.busy = "";
        smartState.error = error.message;
        smartRender();
      }
    }
    return;
  }
  const button = event.target.closest("[data-smart-action]");
  if (!button || smartState.busy) return;
  const action = button.dataset.smartAction;
  try {
    if (action === "refresh") {
      await smartLoadBootstrap();
    } else if (action === "run-forecast") {
      await smartWork("Running backtests and forecasts", () => smartApi("/api/scm/smart/forecasts", { method: "POST", body: {} }), "Forecast completed");
      await smartLoadBootstrap({ quiet: true });
    } else if (action === "run-plan") {
      await smartWork("Refreshing NetSuite, forecasting, and building inventory plan", () => smartApi("/api/scm/smart/plans", { method: "POST", body: {} }), "New planning revision is ready");
      smartState.plan = null;
      await smartLoadBootstrap({ quiet: true });
      smartState.tab = "plans";
      smartRender();
    } else if (action === "sync-live") {
      await smartWork("Syncing NetSuite items and inventory", () => smartApi("/api/scm/smart/sync", {
        method: "POST",
        body: { fullCatalog: true, includeSales: false }
      }), "NetSuite items and inventory synchronized");
      await smartLoadBootstrap({ quiet: true });
      await smartLoadItems({ reset: true, quiet: true });
      smartState.tab = "items";
      smartRender();
    } else if (action === "upload-sales-csv") {
      const file = document.getElementById("smartSalesCsv")?.files?.[0];
      if (!file) throw new Error("Select a raw sales CSV first.");
      if (!file.name.toLowerCase().endsWith(".csv")) throw new Error("Raw sales history requires a CSV file.");
      const summary = await smartWork("Validating and replacing raw sales history", () => smartApi("/api/scm/smart/sales-csv", {
        method: "POST",
        headers: { "Content-Type": file.type || "text/csv", "X-File-Name": file.name },
        body: file
      }), "Raw sales CSV imported");
      await smartLoadBootstrap({ quiet: true });
      smartState.notice = `${smartNumber(summary.facts, 0)} sales rows imported from ${summary.filename}; ${smartNumber(summary.rejectedRows, 0)} invalid/cancelled rows ignored. Run forecast when ready.`;
      smartState.tab = "forecasts";
      smartRender();
    } else if (action === "download-sales-template") {
      await smartDownload("/api/scm/smart/sales-csv/template", "smart-scm-raw-sales-template.csv");
    } else if (action === "save-item") {
      const row = button.closest("[data-item-row]");
      if (!row) throw new Error("Item row is no longer available.");
      const viewport = smartCaptureItemViewport(row);
      const yardPolicies = [...row.querySelectorAll("[data-item-yard-enabled]")].map((input) => {
        const locationId = Number(input.dataset.itemYardEnabled);
        const capacity = row.querySelector(`[data-item-yard-capacity="${locationId}"]`);
        return {
          locationId,
          eligible: input.checked,
          capacityPallets: Number(capacity?.value || 0),
          serviceQuantile: Number(input.dataset.serviceQuantile || 0.9),
          minimumSafetyPallets: Number(input.dataset.minimumSafety || 1)
        };
      });
      const vendorYardSelect = row.querySelector('[data-item-field="vendorYardId"]');
      const vendorYardValue = vendorYardSelect?.value || "";
      const payload = {
        planningEnabled: Boolean(row.querySelector('[data-item-field="planningEnabled"]')?.checked),
        leadTimeDays: Number(row.querySelector('[data-item-field="leadTimeDays"]')?.value || 0),
        vendorYardId: /^\d+$/.test(vendorYardValue) ? Number(vendorYardValue) : null,
        vendorYard: vendorYardValue === "__source__" ? (vendorYardSelect?.dataset.sourceYard || "") : vendorYardValue ? undefined : "",
        yardPolicies
      };
      button.disabled = true;
      button.textContent = "Saving…";
      smartState.error = "";
      smartState.notice = "";
      try {
        const updated = await smartApi(`/api/scm/smart/items/${button.dataset.itemId}`, {
          method: "PATCH",
          body: payload
        });
        if (updated && smartState.itemData) {
          smartState.itemData.items = smartState.itemData.items.map((item) => Number(item.itemId) === Number(updated.itemId) ? updated : item);
        }
        smartState.notice = "Item Master policy saved";
      } catch (error) {
        smartState.error = error.message;
      }
      smartRender();
      smartRestoreItemViewport(viewport);
      return;
    } else if (action === "item-prev") {
      smartState.itemOffset = Math.max(0, smartState.itemOffset - smartState.itemLimit);
      await smartLoadItems();
    } else if (action === "item-next") {
      smartState.itemOffset += smartState.itemLimit;
      await smartLoadItems();
    } else if (action === "upload-input") {
      const file = document.getElementById(`smart-file-${button.dataset.slot}`)?.files?.[0];
      if (!file) throw new Error("Select a file first.");
      await smartWork(`Validating ${file.name}`, () => smartApi(`/api/scm/smart/inputs/${button.dataset.slot}`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": file.name }, body: file }), "Version uploaded and validated");
      await smartLoadBootstrap({ quiet: true });
    } else if (action === "activate-input") {
      if (!confirm("Activate this version and replace the current imported data for this slot?")) return;
      await smartWork("Activating input version", () => smartApi(`/api/scm/smart/inputs/${button.dataset.fileId}/activate`, { method: "POST", body: {} }), "Input version activated");
      await smartLoadBootstrap({ quiet: true });
    } else if (action === "download-input") {
      await smartWork("Preparing download", () => smartDownload(`/api/scm/smart/inputs/${button.dataset.fileId}/download`, button.dataset.filename || "smart-scm-input"), "Download ready");
    } else if (action === "filter-forecasts") {
      smartState.forecastSearch = document.getElementById("smartForecastSearch")?.value || "";
      smartState.forecastYard = document.getElementById("smartForecastYard")?.value || "";
      const params = new URLSearchParams({ search: smartState.forecastSearch, yard: smartState.forecastYard, limit: "2000" });
      smartState.forecasts = await smartWork("Filtering forecasts", () => smartApi(`/api/scm/smart/forecasts?${params}`), "");
      smartState.notice = "";
      smartRender();
    } else if (action === "promote-model") {
      if (!confirm(`Allow eligible prediction models for ${button.dataset.yard} / ${button.dataset.series}?`)) return;
      await smartWork("Promoting forecast segment", () => smartApi("/api/scm/smart/model-segments", { method: "POST", body: { yardCode: button.dataset.yard, series: button.dataset.series, active: true } }), "Forecast segment promoted");
      await smartLoadBootstrap({ quiet: true });
    } else if (action === "fallback-model") {
      const [yardCode, ...seriesParts] = button.dataset.segment.split(":");
      await smartWork("Returning segment to formula", () => smartApi("/api/scm/smart/model-segments", { method: "POST", body: { yardCode, series: seriesParts.join(":"), active: false } }), "Formula fallback restored");
      await smartLoadBootstrap({ quiet: true });
    } else if (action === "filter-plan") {
      smartState.planSearch = document.getElementById("smartPlanSearch")?.value || "";
      smartState.planType = document.getElementById("smartPlanType")?.value || "";
      smartState.planStatus = document.getElementById("smartPlanStatus")?.value || "";
      smartState.planSource = document.getElementById("smartPlanSource")?.value || "";
      smartState.planDestination = document.getElementById("smartPlanDestination")?.value || "";
      smartState.planSort = document.getElementById("smartPlanSort")?.value || "destination";
      smartRender();
    } else if (action === "proposal-status") {
      await smartWork("Updating proposal", () => smartApi(`/api/scm/smart/proposals/${button.dataset.proposalId}`, { method: "PATCH", body: { status: button.dataset.status } }), "Proposal updated");
      smartState.plan = await smartApi(`/api/scm/smart/planning-runs/${smartState.plan.id}`);
      smartRender();
    } else if (action === "confirm-transfer") {
      if (!confirm("Confirm this TO, reserve source inventory, and queue its picking ticket to the source yard printer?")) return;
      const result = await smartWork("Creating and verifying transfer order", () => smartApi(`/api/scm/smart/proposals/${button.dataset.proposalId}/confirm-transfer`, { method: "POST", body: {} }), "TO confirmed and print job queued");
      smartState.notice = `${result.transferOrderRef} confirmed; print job #${result.printJob.id} queued.`;
      smartState.plan = await smartApi(`/api/scm/smart/planning-runs/${smartState.plan.id}`);
      smartRender();
    } else if (action === "retry-picking-ticket") {
      const result = await smartWork("Recovering the existing TO picking ticket", () => smartApi(`/api/scm/smart/proposals/${button.dataset.proposalId}/retry-picking-ticket`, { method: "POST", body: {} }), "Picking ticket recovered and queued");
      smartState.notice = `${result.transferOrderRef} reused; print job #${result.printJob.id} is ${result.printJob.status}.`;
      smartState.plan = await smartApi(`/api/scm/smart/planning-runs/${smartState.plan.id}`);
      smartRender();
    } else if (action === "save-vendor-reply") {
      const row = button.closest("[data-vendor-line]");
      const response = { proposalLineId: Number(button.dataset.lineId) };
      row.querySelectorAll("[data-vendor-field]").forEach((input) => { response[input.dataset.vendorField] = input.value; });
      smartState.plan = await smartWork("Revising plan from vendor reply", () => smartApi("/api/scm/smart/vendor-responses", { method: "POST", body: { responses: [response] } }), "Vendor reply saved; residual plan recalculated");
      smartRender();
    } else if (action === "download-vendor-template") {
      const suffix = smartState.plan?.id ? `?runId=${smartState.plan.id}` : "";
      await smartWork("Preparing vendor template", () => smartDownload(`/api/scm/smart/vendor-responses/template${suffix}`, "smart-scm-vendor-responses.csv"), "Template downloaded");
    } else if (action === "import-vendor-replies") {
      const file = document.getElementById("smartVendorImport")?.files?.[0];
      if (!file) throw new Error("Select a CSV or XLSX reply file first.");
      const imported = await smartWork("Importing vendor replies", () => smartApi("/api/scm/smart/vendor-responses/import", { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": file.name }, body: file }), "Vendor replies imported and plan revised");
      smartState.plan = imported.run;
      smartRender();
    }
  } catch (error) {
    smartState.error = error.message;
    smartState.busy = "";
    smartRender();
  }
});

smartScmApp.addEventListener("change", async (event) => {
  if (event.target.id === "smartItemEnabled" || event.target.id === "smartItemVendorYard") {
    if (event.target.id === "smartItemEnabled") smartState.itemEnabled = event.target.value;
    if (event.target.id === "smartItemVendorYard") smartState.itemVendorYard = event.target.value;
    try {
      await smartLoadItems({ reset: true });
    } catch (error) {
      smartState.busy = "";
      smartState.error = error.message;
      smartRender();
    }
    return;
  }
  if (event.target.id !== "smartPlanRun" || !event.target.value) return;
  try {
    smartState.plan = await smartWork("Loading planning run", () => smartApi(`/api/scm/smart/planning-runs/${event.target.value}`), "");
    smartState.notice = "";
    smartRender();
  } catch {
    // smartWork already exposes the error.
  }
});

smartScmApp.addEventListener("input", (event) => {
  if (event.target.id !== "smartItemSearch") return;
  smartState.itemSearch = event.target.value;
  clearTimeout(smartItemSearchTimer);
  smartItemSearchTimer = setTimeout(async () => {
    try {
      await smartLoadItems({ reset: true, quiet: true });
    } catch (error) {
      smartState.busy = "";
      smartState.error = error.message;
      smartRender();
    }
  }, 300);
});

smartScmApp.addEventListener("submit", async (event) => {
  const form = event.target.closest("#smartSettingsForm");
  if (!form) return;
  event.preventDefault();
  if (!smartCanWrite()) return;
  const fields = new FormData(form);
  try {
    await smartWork("Saving Smart SCM settings", () => smartApi("/api/scm/smart/settings", {
      method: "PUT",
      body: {
        executionMode: fields.get("executionMode"),
        forecastMode: fields.get("forecastMode"),
        dailyEnabled: fields.get("dailyEnabled") === "on",
        dailyTime: fields.get("dailyTime"),
        timeZone: smartState.data.settings.timeZone || "America/Toronto",
        formulaAverageWeeks: Number(fields.get("formulaAverageWeeks")),
        stockoutBenchmarkWeeks: Number(fields.get("stockoutBenchmarkWeeks")),
        deliverySafetyFactor: Number(fields.get("deliverySafetyFactor")),
        pickupSafetyFactor: Number(fields.get("pickupSafetyFactor")),
        zeroDemandCoverageEnabled: fields.get("zeroDemandCoverageEnabled") === "on",
        zeroDemandPickupOrderCount: Number(fields.get("zeroDemandPickupOrderCount")),
        zeroDemandDeliveryOrderCount: Number(fields.get("zeroDemandDeliveryOrderCount")),
        coverageOrderPercentile: Number(fields.get("coverageOrderPercentile")),
        coverageHistoryWeeks: Number(fields.get("coverageHistoryWeeks")),
        coveragePriorStrengthOrders: Number(fields.get("coveragePriorStrengthOrders")),
        vendorResponseSlaHours: Number(fields.get("vendorResponseSlaHours")),
        truckCapacityLbs: Number(fields.get("truckCapacityLbs")),
        fullLoadRatio: Number(fields.get("fullLoadRatio")),
        holdLoadRatio: Number(fields.get("holdLoadRatio"))
      }
    }), "Settings saved");
    await smartLoadBootstrap({ quiet: true });
  } catch {
    // smartWork already exposes the error.
  }
});

window.addEventListener("mbbs-language-changed", smartRender);

requireDispatchLogin({
  mount: smartScmApp,
  roles: ["admin", "scm", "scm_staff", "dispatcher", "yard_manager"],
  async onReady(operator) {
    smartState.operator = operator;
    smartRender();
    try {
      await smartLoadBootstrap();
    } catch (error) {
      smartState.busy = "";
      smartState.error = error.message;
      smartRender();
    }
  }
});

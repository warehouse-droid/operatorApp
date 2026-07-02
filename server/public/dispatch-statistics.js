const app = document.getElementById("dispatchStatisticsApp");
const t = (key, fallback) => window.MBBS_I18N?.t(key, fallback) || fallback;
const languageToggle = () => window.MBBS_I18N?.toggleHtml() || "";

const state = {
  operator: null,
  loading: true,
  error: "",
  from: daysAgo(13),
  to: localDate(),
  driver: "",
  data: null
};

function localDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - (offset * 60000)).toISOString().slice(0, 10);
}

function daysAgo(days = 0) {
  const date = new Date();
  date.setDate(date.getDate() - Number(days || 0));
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - (offset * 60000)).toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[char]);
}

function numberText(value, digits = 0) {
  const number = Number(value || 0);
  return number.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  });
}

function durationText(value) {
  const minutes = Math.max(0, Math.round(Number(value || 0)));
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const minLabel = t("stats.min", "min");
  const hrLabel = t("stats.hr", "hr");
  if (!hours) return `${mins} ${minLabel}`;
  if (!mins) return `${hours} ${hrLabel}`;
  return `${hours} ${hrLabel} ${mins} ${minLabel}`;
}

function dateTimeText(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

async function api(path) {
  const response = await fetch(path);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

async function loadStatistics() {
  state.loading = true;
  state.error = "";
  render();
  try {
    const params = new URLSearchParams();
    params.set("from", state.from);
    params.set("to", state.to);
    if (state.driver) params.set("driver", state.driver);
    state.data = await api(`/api/dispatch/statistics?${params.toString()}`);
  } catch (error) {
    state.error = error.message || "Failed to load statistics.";
  } finally {
    state.loading = false;
    render();
  }
}

function driverOptions() {
  const drivers = state.data?.drivers || [];
  return [
    `<option value="">${t("stats.allDrivers", "All drivers")}</option>`,
    ...drivers.map((driver) => `<option value="${escapeHtml(driver)}" ${driver === state.driver ? "selected" : ""}>${escapeHtml(driver)}</option>`)
  ].join("");
}

function kpiCard(label, value, note = "") {
  return `
    <article class="stats-kpi-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${note ? `<small>${escapeHtml(note)}</small>` : ""}
    </article>
  `;
}

function barRows(rows, metric, { suffix = "", max = null, label = "label" } = {}) {
  const values = rows.map((row) => Number(row[metric] || 0));
  const top = max || Math.max(...values, 1);
  return rows.map((row) => {
    const value = Number(row[metric] || 0);
    const width = Math.max(2, Math.min(100, (value / top) * 100));
    return `
      <div class="stats-bar-row">
        <span>${escapeHtml(row[label] || row.key || "")}</span>
        <div class="stats-bar-track"><div class="stats-bar-fill" style="width:${width}%"></div></div>
        <strong>${escapeHtml(numberText(value, value % 1 ? 1 : 0))}${escapeHtml(suffix)}</strong>
      </div>
    `;
  }).join("");
}

function renderStopClassChart() {
  const rows = state.data?.byStopClass || [];
  return `
    <section class="stats-panel">
      <div class="stats-panel-head">
        <h2>${t("stats.averageStopTime", "Average Stop Time")}</h2>
        <span>${t("stats.actualPwaTime", "Actual driver PWA time")}</span>
      </div>
      <div class="stats-bars">
        ${rows.length ? barRows(rows, "averageStopMinutes", { suffix: ` ${t("stats.min", "min")}` }) : `<div class="stats-empty">${t("stats.noCompletedStops", "No completed stops in this range.")}</div>`}
      </div>
    </section>
  `;
}

function renderDailyChart() {
  const rows = state.data?.daily || [];
  return `
    <section class="stats-panel">
      <div class="stats-panel-head">
        <h2>${t("stats.dailyCompletedStops", "Daily Completed Stops")}</h2>
        <span>${t("stats.completedInProgress", "Completed + in progress")}</span>
      </div>
      <div class="stats-bars">
        ${rows.length ? barRows(rows, "completedStops", { label: "key" }) : `<div class="stats-empty">${t("stats.noDailyActivity", "No daily activity in this range.")}</div>`}
      </div>
    </section>
  `;
}

function renderDriverTable() {
  const rows = state.data?.byDriver || [];
  return `
    <section class="stats-panel stats-table-panel">
      <div class="stats-panel-head">
        <h2>${t("stats.driverPerformance", "Driver Performance")}</h2>
        <span>${t("stats.serviceTimeOnly", "Stop service time only")}</span>
      </div>
      <div class="stats-table">
        <div class="stats-table-row head">
          <span>${t("stats.driver", "Driver")}</span><span>${t("stats.stops", "Stops")}</span><span>${t("stats.avgStop", "Avg Stop")}</span><span>${t("stats.deliveryPerPlt", "Delivery / PLT")}</span><span>${t("stats.overPlanned", "Over Plan")}</span><span>${t("stats.photos", "Photos")}</span>
        </div>
        ${rows.map((row) => `
          <div class="stats-table-row">
            <strong>${escapeHtml(row.label || row.key)}</strong>
            <span>${numberText(row.completedStops)}</span>
            <span>${numberText(row.averageStopMinutes, 1)} ${t("stats.min", "min")}</span>
            <span>${row.deliveryMinutesPerPallet ? `${numberText(row.deliveryMinutesPerPallet, 1)} ${t("stats.min", "min")}` : "--"}</span>
            <span class="${row.overrunMinutes > 0 ? "stats-warn-text" : ""}">${durationText(row.overrunMinutes)}</span>
            <span>${numberText(row.photoRate, 0)}%</span>
          </div>
        `).join("") || `<div class="stats-empty">${t("stats.noDriverRecords", "No driver records in this range.")}</div>`}
      </div>
    </section>
  `;
}

function renderDvirTable() {
  const rows = state.data?.dvir || [];
  return `
    <section class="stats-panel stats-table-panel">
      <div class="stats-panel-head">
        <h2>${t("stats.dvirCompletion", "DVIR Completion")}</h2>
        <span>${t("stats.dvirByDay", "Pre-trip and post-trip by driver day")}</span>
      </div>
      <div class="stats-table dvir-stats-table">
        <div class="stats-table-row head">
          <span>${t("stats.driver", "Driver")}</span><span>${t("stats.days", "Days")}</span><span>${t("stats.pre", "Pre")}</span><span>${t("stats.post", "Post")}</span>
        </div>
        ${rows.map((row) => `
          <div class="stats-table-row">
            <strong>${escapeHtml(row.driverLogin)}</strong>
            <span>${numberText(row.dayCount)}</span>
            <span>${numberText(row.preRate, 0)}%</span>
            <span>${numberText(row.postRate, 0)}%</span>
          </div>
        `).join("") || `<div class="stats-empty">${t("stats.noDvirRecords", "No DVIR records in this range.")}</div>`}
      </div>
    </section>
  `;
}

function renderRecentStops() {
  const rows = state.data?.recentStops || [];
  return `
    <section class="stats-panel stats-recent-panel">
      <div class="stats-panel-head">
        <h2>${t("stats.recentStops", "Recent Stop Records")}</h2>
        <span>${t("stats.newestFirst", "Newest first")}</span>
      </div>
      <div class="stats-stop-list">
        ${rows.map((row) => `
          <article class="stats-stop-card ${row.status === "in_progress" ? "in-progress" : ""}">
            <div>
              <strong>${escapeHtml(row.driverLogin || "--")} | ${escapeHtml(row.truckPlate || "--")}</strong>
              <span>${escapeHtml(row.planDate || "")} ${escapeHtml(row.loadName || "")}</span>
            </div>
            <div>
              <strong>${escapeHtml(row.stopClassLabel || row.stopType)}</strong>
              <span>${escapeHtml((row.orderRefs || []).join(", ") || row.stopType)}</span>
            </div>
            <div>
              <strong>${row.status === "complete" ? durationText(row.actualMinutes) : t("stats.started", "Started")}</strong>
              <span>${dateTimeText(row.startedAt)}${row.completedAt ? ` - ${dateTimeText(row.completedAt)}` : ""}</span>
            </div>
            <div>
              <strong class="${row.overrunMinutes > 0 ? "stats-warn-text" : ""}">${row.status === "complete" ? durationText(row.overrunMinutes) : "--"}</strong>
              <span>${t("stats.overPlannedShort", "Over planned")}</span>
            </div>
          </article>
        `).join("") || `<div class="stats-empty">${t("stats.noStopRecords", "No stop records in this range.")}</div>`}
      </div>
    </section>
  `;
}

function render() {
  const summary = state.data?.summary || {};
  app.innerHTML = `
    <header class="dispatch-topbar">
      <div>
        <p>${t("app.transportation", "MBBS Transportation")}</p>
        <h1>${t("dispatch.statistics", "Statistics")}</h1>
      </div>
      <div class="stats-filter-row">
        <label><span>${t("stats.from", "From")}</span><input id="statsFrom" type="date" value="${escapeHtml(state.from)}" /></label>
        <label><span>${t("stats.to", "To")}</span><input id="statsTo" type="date" value="${escapeHtml(state.to)}" /></label>
        <label><span>${t("stats.driver", "Driver")}</span><select id="statsDriver">${driverOptions()}</select></label>
        <button data-action="apply" type="button">${t("common.apply", "Apply")}</button>
      </div>
      <div class="topbar-actions">
        ${languageToggle()}
        <button onclick="location.href='/dispatch'" type="button">${t("common.menu", "Menu")}</button>
        <button onclick="dispatchLogout()" type="button">${t("common.logout", "Logout")}</button>
      </div>
    </header>
    <section class="stats-page">
      <div class="stats-note">
        <strong>${t("stats.currentCalculation", "Current calculation:")}</strong>
        <span>${t("stats.calculationHelp", "Actual stop time is Driver PWA Start to Confirm. Planned overrun compares actual stop service time with driver/truck timing rules. Google route leg history is not persisted yet, so drive-time overrun is not included here.")}</span>
      </div>
      ${state.error ? `<div class="route-notice visible danger">${escapeHtml(state.error)}</div>` : ""}
      ${state.loading ? `<div class="stats-loading">${t("stats.loading", "Loading statistics...")}</div>` : `
        <div class="stats-kpi-grid">
          ${kpiCard(t("stats.completedStops", "Completed Stops"), numberText(summary.completedStops || 0), `${numberText(summary.inProgressStops || 0)} ${t("stats.inProgress", "in progress")}`)}
          ${kpiCard(t("stats.ownYardAvg", "Own Yard Avg"), `${numberText(summary.averageOwnYardStopMinutes || 0, 1)} ${t("stats.min", "min")}`, t("stats.ownYardNote", "Pickup/drop in MBBS yards"))}
          ${kpiCard(t("stats.vendorYardAvg", "Vendor Yard Avg"), `${numberText(summary.averageVendorYardStopMinutes || 0, 1)} ${t("stats.min", "min")}`, t("stats.vendorYardNote", "Vendor pickup stops"))}
          ${kpiCard(t("stats.deliveryPerPlt", "Delivery / PLT"), summary.deliveryMinutesPerPallet ? `${numberText(summary.deliveryMinutesPerPallet, 1)} ${t("stats.min", "min")}` : "--", t("stats.deliverySpeed", "Customer drop speed"))}
          ${kpiCard(t("stats.overPlanned", "Over Planned"), durationText(summary.totalOverrunMinutes || 0), `${numberText(summary.averageOverrunMinutes || 0, 1)} ${t("stats.min", "min")} ${t("stats.avg", "avg")}`)}
          ${kpiCard(t("stats.photoRate", "Photo Rate"), `${numberText(summary.photoRate || 0, 0)}%`, t("stats.photoRateNote", "Completed stops with photos"))}
        </div>
        <div class="stats-chart-grid">
          ${renderStopClassChart()}
          ${renderDailyChart()}
        </div>
        <div class="stats-lower-grid">
          ${renderDriverTable()}
          ${renderDvirTable()}
        </div>
        ${renderRecentStops()}
      `}
    </section>
  `;
}

app.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  if (button.dataset.action === "apply") {
    state.from = document.getElementById("statsFrom")?.value || state.from;
    state.to = document.getElementById("statsTo")?.value || state.to;
    state.driver = document.getElementById("statsDriver")?.value || "";
    loadStatistics();
  }
});

window.addEventListener("mbbs-language-changed", () => {
  render();
});

requireDispatchLogin({
  mount: app,
  onReady(operator) {
    state.operator = operator;
    loadStatistics();
  }
});

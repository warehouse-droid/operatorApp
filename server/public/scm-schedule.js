const scmScheduleApp = document.getElementById("scmScheduleApp");

let scmScheduleOperator = null;
let scmScheduleRows = [];
let scmSchedulePresets = [];
let scmScheduleNotice = "";
let scmScheduleLoading = false;
let scmScheduleSavingRef = "";
let scmScheduleFilters = { view: "dispatch", search: "", status: "", method: "", kind: "", dropoffPoint: "", brand: "", from: "", to: "" };
let scmScheduleSelectedRows = new Set();
let scmScheduleFocusAfterRender = "";

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
  Object.entries(scmScheduleFilters).forEach(([key, value]) => {
    if (!value) return;
    if (key === "dropoffPoint") params.set("dropoffPoint", value);
    else params.set(key, value);
  });
  return params.toString() ? `?${params.toString()}` : "";
}

async function loadScmSchedule() {
  scmScheduleLoading = true;
  renderScmSchedule();
  try {
    const [rows, presets] = await Promise.all([
      scmScheduleApi(`/api/scm/schedule${scmScheduleQuery()}`),
      scmScheduleApi("/api/scm/view-presets")
    ]);
    scmScheduleRows = rows;
    scmSchedulePresets = presets;
    const validRowIds = new Set(scmScheduleRows.map(scheduleRowId));
    scmScheduleSelectedRows = new Set([...scmScheduleSelectedRows].filter((rowId) => validRowIds.has(rowId)));
  } catch (error) {
    scmScheduleNotice = `Schedule load failed: ${error.message}`;
  } finally {
    scmScheduleLoading = false;
    renderScmSchedule();
  }
}

function scheduleRowId(row = {}) {
  return `${row.orderKind || "PO"}::${row.orderRef || ""}`;
}

function canEditScmSchedule() {
  return scmScheduleFilters.view === "scm working";
}

function scmScheduleRole() {
  return String(scmScheduleOperator?.role || "").trim().toLowerCase();
}

function scmScheduleAllowedViewsForRole() {
  const role = scmScheduleRole();
  if (role === "dispatcher") return ["dispatch", "completed"];
  if (role === "yard_manager" || role === "yard-manager" || role === "yard manager") return ["yard manager"];
  return null;
}

function scmScheduleDefaultViewForRole() {
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

function renderScheduleTableRows() {
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
        <div class="scm-sheet-cell">${editable ? selectHtml({ rowId, field: "pickupPoint", value: row.pickupPoint, options: scheduleOptionList("pickupPoint") }) : readOnlyCell(row.pickupPoint)}</div>
        <div class="scm-sheet-cell">${editable ? selectHtml({ rowId, field: "dropoffPoint", value: row.dropoffPoint, options: scheduleOptionList("dropoffPoint") }) : readOnlyCell(row.dropoffPoint)}</div>
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
  scmScheduleApp.innerHTML = `
    <header class="dispatch-topbar">
      <div><p>SCM</p><h1>PO / TO Schedule</h1></div>
      <div class="topbar-language">${window.MBBS_I18N?.toggleHtml() || ""}</div>
      <div class="topbar-actions">
        <span class="dispatch-user">${scmScheduleEscape(operator.display_name || operator.username || "")}</span>
        <button onclick="location.href='/scm'" type="button">SCM Menu</button>
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
        ${yardManagerView ? "" : `<input data-filter="search" value="${scmScheduleEscape(scmScheduleFilters.search)}" placeholder="Search order / vendor / content" />`}
        ${showScmWorkingControls ? `<select data-filter="kind"><option value="">All Types</option>${SCM_TYPES.map((item) => `<option ${scmScheduleFilters.kind === item ? "selected" : ""}>${item}</option>`).join("")}</select>` : ""}
        ${showScmWorkingControls ? `<select data-filter="method"><option value="">All Methods</option>${SCM_METHODS.map((item) => `<option ${scmScheduleFilters.method === item ? "selected" : ""}>${item}</option>`).join("")}</select>` : ""}
        ${yardManagerView ? "" : `<select data-filter="status"><option value="">All Status</option>${SCM_STATUS_FILTERS.map((item) => `<option ${scmScheduleFilters.status === item ? "selected" : ""}>${item}</option>`).join("")}</select>`}
        <select data-filter="dropoffPoint"><option value="">All Drop Off</option>${scheduleOptionList("dropoffPoint").map((item) => `<option value="${scmScheduleEscape(item)}" ${scmScheduleFilters.dropoffPoint === item ? "selected" : ""}>${scmScheduleEscape(item)}</option>`).join("")}</select>
        <select data-filter="brand"><option value="">All Brand</option>${scheduleOptionList("brand").map((item) => `<option value="${scmScheduleEscape(item)}" ${scmScheduleFilters.brand === item ? "selected" : ""}>${scmScheduleEscape(item)}</option>`).join("")}</select>
        ${yardManagerView ? "" : `<input data-filter="from" type="date" value="${scmScheduleEscape(scmScheduleFilters.from)}" />`}
        ${yardManagerView ? "" : `<input data-filter="to" type="date" value="${scmScheduleEscape(scmScheduleFilters.to)}" />`}
        <button data-action="apply-filters" type="button">Apply</button>
        ${editable ? `<button class="primary" data-action="group-selected" type="button" ${selectedRows.length >= 2 ? "" : "hidden disabled"}>Group ${scmScheduleEscape(String(selectedRows.length))}</button>` : ""}
      </div>
      <div class="scm-sheet-wrap">
        <div class="scm-sheet-grid ${editable ? "with-select" : ""}">
          ${editable ? `<div class="scm-sheet-header"></div>` : ""}
          <div class="scm-sheet-header">Date Added</div>
          <div class="scm-sheet-header">Type</div>
          <div class="scm-sheet-header">Method</div>
          <div class="scm-sheet-header">Pickup Point</div>
          <div class="scm-sheet-header">Drop off Point</div>
          <div class="scm-sheet-header">Brand</div>
          <div class="scm-sheet-header">Content</div>
          <div class="scm-sheet-header">Order Number</div>
          <div class="scm-sheet-header">Weight LBs</div>
          <div class="scm-sheet-header">Packing Slip Number</div>
          <div class="scm-sheet-header">ETA</div>
          <div class="scm-sheet-header">Driver</div>
          <div class="scm-sheet-header">Status</div>
          <div class="scm-sheet-header">SLA</div>
          <div class="scm-sheet-header">Save</div>
          ${renderScheduleTableRows()}
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

scmScheduleApp.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;

  if (action === "close-notice") {
    scmScheduleNotice = "";
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
      const payload = await scmScheduleApi("/api/scm/schedule-groups", {
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
      await scmScheduleApi(`/api/scm/schedule/${encodeURIComponent(orderRef)}`, {
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
  roles: ["admin", "scm", "scm_staff", "dispatcher", "yard_manager"],
  async onReady(operator) {
    scmScheduleOperator = operator;
    scmScheduleFilters.view = scmScheduleDefaultViewForRole();
    await loadScmSchedule();
  }
});

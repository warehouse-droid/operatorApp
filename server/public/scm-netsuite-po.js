const poApp = document.getElementById("smartNetSuitePoApp");
let poPdfRequestSequence = 0;

const poState = {
  operator: null,
  records: [],
  options: { vendors: [], vendorYards: [], destinations: [] },
  filters: { search: "", createdFrom: "", createdTo: "", vendorId: "", vendorYard: "", destinationLocationId: "", lifecycle: "pending_receive" },
  page: 1,
  pageSize: 25,
  total: 0,
  totalPages: 1,
  busy: "",
  notice: "",
  error: "",
  syncWarning: "",
  pdf: null,
  events: null,
  dirtyIds: new Set(),
  drafts: new Map(),
  remoteSyncRunning: false,
  loadSequence: 0,
  filtersDirty: false
};

function esc(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function num(value, places = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat("en-CA", { maximumFractionDigits: places }).format(number) : "—";
}

function money(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(number) : "—";
}

function date(value, withTime = false) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat("en-CA", withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }).format(parsed) : esc(value);
}

function dateInput(value) {
  if (!value) return "";
  const match = String(value).match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}

function sameNumber(left, right) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.000001;
}

function inputNumber(value, places = 6) {
  const number = Number(value);
  return Number.isFinite(number) ? String(Number(number.toFixed(places))) : "";
}

function activeEditor() {
  const active = document.activeElement;
  return Boolean(active && poApp.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
}

function quietRefreshBlocked() {
  return poState.dirtyIds.size > 0 || poState.filtersDirty || activeEditor() || poState.busy || poState.pdf;
}

function roles() {
  return new Set([...(poState.operator?.roles || []), poState.operator?.role].map((role) => String(role || "").toLowerCase().replaceAll("-", "_").replaceAll(" ", "_")).filter(Boolean));
}

function canWrite() {
  return ["admin", "scm", "scm_staff"].some((role) => roles().has(role));
}

function recordCanWrite(record) {
  const status = `${record.current.status || ""} ${record.current.statusText || ""}`;
  return canWrite() && record.lifecycle !== "missing" && record.lifecycle !== "completed"
    && record.current.active !== false
    && !/closed|cancelled|canceled|fully received|fully billed/i.test(status)
    && !(record.current.lines || []).some((line) => line.closed || Number(line.receivedQuantity || 0) > 0);
}

function releasePdfDocument() {
  if (poState.pdf?.url) URL.revokeObjectURL(poState.pdf.url);
}

function closePdf() {
  poPdfRequestSequence += 1;
  releasePdfDocument();
  poState.pdf = null;
}

async function loadPdf(record) {
  releasePdfDocument();
  const requestSequence = ++poPdfRequestSequence;
  poState.pdf = {
    label: record.purchaseOrderRef,
    status: "loading",
    url: "",
    error: ""
  };
  render();
  try {
    const response = await fetch(`/api/scm/netsuite-po-history/${record.id}/pdf`, {
      headers: dispatchAuthHeaders({ Accept: "application/pdf" })
    });
    if (!response.ok) {
      const contentType = response.headers.get("content-type") || "";
      const payload = contentType.includes("application/json")
        ? await response.json().catch(() => null)
        : await response.text().catch(() => "");
      throw new Error(payload?.error || payload || `Purchase order preview failed (${response.status}).`);
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/pdf")) {
      throw new Error("NetSuite did not return a PDF document for this purchase order.");
    }
    const blob = await response.blob();
    if (!blob.size) throw new Error("The purchase order PDF is empty.");
    if (requestSequence !== poPdfRequestSequence || !poState.pdf) return;
    const url = URL.createObjectURL(blob);
    if (requestSequence !== poPdfRequestSequence || !poState.pdf) {
      URL.revokeObjectURL(url);
      return;
    }
    poState.pdf = { ...poState.pdf, status: "ready", url, error: "" };
    render();
  } catch (error) {
    if (requestSequence !== poPdfRequestSequence || !poState.pdf) return;
    poState.pdf = {
      ...poState.pdf,
      status: "error",
      url: "",
      error: error?.message || "The purchase order PDF could not be loaded."
    };
    render();
  }
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body === "object") {
    headers["Content-Type"] = "application/json";
    options = { ...options, body: JSON.stringify(options.body) };
  }
  const response = await fetch(url, { ...options, headers });
  const payload = (response.headers.get("content-type") || "").includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(payload?.error || payload || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function optionList(rows, selected, emptyLabel) {
  return `<option value="">${esc(emptyLabel)}</option>${rows.map((row) => {
    const value = typeof row === "string" ? row : row.id;
    const label = typeof row === "string" ? row : row.name;
    return `<option value="${esc(value)}" ${String(value) === String(selected) ? "selected" : ""}>${esc(label)}</option>`;
  }).join("")}`;
}

function statusPill(record) {
  const netSuiteLabel = record.current.statusText || record.current.status || "Unknown";
  const label = record.lifecycle === "missing"
    ? "No longer exists in NetSuite"
    : record.lifecycle === "completed"
      ? `Completed · ${netSuiteLabel}`
      : netSuiteLabel;
  const css = record.lifecycle === "missing" || /closed|cancel/i.test(label)
    ? "cancelled"
    : /pending|open|receive/i.test(label) ? "confirmed" : "reviewed";
  return `<span class="smart-pill ${css}">${esc(label)}</span>`;
}

function lineRow(record, line) {
  const editable = recordCanWrite(record) && line.editable;
  const palletEditable = editable && line.palletEditable;
  const draft = (poState.drafts.get(record.id)?.lines || []).find((row) => Number(row.lineId) === Number(line.lineId)) || {};
  const palletQuantity = Object.prototype.hasOwnProperty.call(draft, "palletQuantity") ? draft.palletQuantity : line.palletQuantity;
  const nativeQuantity = Object.prototype.hasOwnProperty.call(draft, "palletQuantity") && Number(line.unitsPerPallet) > 0
    ? Number(draft.palletQuantity) * Number(line.unitsPerPallet)
    : line.nativeQuantity ?? line.quantity;
  const rate = Object.prototype.hasOwnProperty.call(draft, "rate") ? draft.rate : line.rate ?? "";
  const destinationLocationId = Object.prototype.hasOwnProperty.call(draft, "destinationLocationId") ? draft.destinationLocationId : line.destinationLocationId;
  const destinations = poState.options.destinations.some((row) => Number(row.id) === Number(line.destinationLocationId))
    ? poState.options.destinations
    : [{ id: line.destinationLocationId, name: line.destination || `Location ${line.destinationLocationId}` }, ...poState.options.destinations];
  const conversionHelp = line.palletEditable
    ? `${inputNumber(line.unitsPerPallet)} ${line.nativeUnit || line.unit || "unit"} / PLT${line.conversionSource === "line_ratio" ? " · derived from current PO" : ""}`
    : `No reliable PLT conversion; ${line.nativeUnit || line.unit || "native quantity"} is read-only`;
  return `<tr data-po-line="${line.lineId}" data-units-per-pallet="${esc(line.unitsPerPallet || "")}">
    <td><strong>${esc(line.itemName || line.itemId)}</strong><small>ID ${esc(line.itemId)} · ${esc(line.description || "No description")}</small></td>
    <td><input data-line-field="palletQuantity" type="number" min="0.000001" step="0.01" value="${esc(palletQuantity ?? "")}" ${palletEditable ? "" : "disabled"}><small>PLT · ${esc(conversionHelp)}</small></td>
    <td><input data-line-native-quantity type="number" value="${esc(inputNumber(nativeQuantity))}" readonly tabindex="-1"><small>${esc(line.nativeUnit || line.unit || "unit")} · calculated, read only</small></td>
    <td><input data-line-field="rate" type="number" min="0" step="0.0001" value="${esc(rate)}" ${editable ? "" : "disabled"}></td>
    <td>${money(line.amount)}</td>
    <td><select data-line-field="destinationLocationId" ${editable ? "" : "disabled"}>${optionList(destinations, destinationLocationId, line.destination || "Destination")}</select><small>${esc(line.destination || "—")}</small></td>
    <td>${num(line.receivedQuantity, 4)}${line.closed ? `<small class="po-lock">Closed</small>` : line.receivedQuantity > 0 ? `<small class="po-lock">Received · locked</small>` : ""}</td>
  </tr>`;
}

function snapshotSummary(record) {
  const snapshot = record.creationSnapshot || {};
  const lines = Array.isArray(snapshot.lines) ? snapshot.lines : [];
  return `<details class="po-snapshot"><summary>Creation snapshot (${lines.length} lines)</summary><pre>${esc(JSON.stringify(snapshot, null, 2))}</pre></details>`;
}

function card(record) {
  const writable = recordCanWrite(record);
  const netSuiteExists = record.lifecycle !== "missing";
  const current = record.current;
  const headerDraft = poState.drafts.get(record.id)?.header || {};
  const headValue = (field, original) => Object.prototype.hasOwnProperty.call(headerDraft, field) ? headerDraft[field] : original;
  return `<article class="po-history-card" data-history-id="${record.id}" data-version="${esc(record.remoteLastModifiedAt || "")}">
    <header class="po-history-head">
      <div><span class="po-kicker">APP-CREATED NETSUITE PO</span><h2>${esc(current.tranid || record.purchaseOrderRef)}</h2></div>
      <div class="po-history-route"><strong>${esc(current.vendor || record.creationSnapshot?.vendor || "Unknown vendor")}</strong><span>${esc(current.vendorYard || "Vendor yard not set")} → ${esc([...new Set((current.lines || []).map((line) => line.destination).filter(Boolean))].join(", ") || "Destination not set")}</span></div>
      <div><strong>${money(current.total)}</strong><span>Current total</span></div>
      <div>${statusPill(record)}<span>NetSuite status</span></div>
      <div class="po-card-actions">${netSuiteExists ? `<button class="smart-button" data-action="pdf">Preview PDF</button><button class="smart-button" data-action="refresh">Sync now</button>${writable ? `<button class="smart-button primary" data-action="save">Save to NetSuite</button>` : ""}` : `<span class="smart-help po-missing-actions">NetSuite actions unavailable</span>`}${canWrite() ? `<button class="smart-button danger" data-action="unarchive">Return to Vendor Replies</button>` : ""}</div>
    </header>
    ${record.lastSyncError ? `<div class="smart-notice error">${esc(record.lastSyncError)}</div>` : ""}
    <div class="po-meta-grid">
      <label>Transaction date<input data-head-field="transactionDate" type="date" value="${esc(headValue("transactionDate", dateInput(current.transactionDate)))}" ${writable ? "" : "disabled"}></label>
      <label>Expected date<input data-head-field="expectedDeliveryDate" type="date" value="${esc(headValue("expectedDeliveryDate", dateInput(current.expectedDeliveryDate)))}" ${writable ? "" : "disabled"}></label>
      <div class="po-vendor-reference">
        <label for="poVendorReference-${record.id}">Vendor reference</label>
        <div class="po-vendor-reference-row">
          <input id="poVendorReference-${record.id}" data-head-field="vendorReference" value="${esc(headValue("vendorReference", current.vendorReference || ""))}" maxlength="300" ${writable ? "" : "disabled"}>
          ${writable ? `<button class="smart-button primary" data-action="save-vendor-reference" type="button">Save reference</button>` : ""}
        </div>
        <small>Updates Packing Slip / Ref in Dispatch, PO Split, and PO/TO Schedule.</small>
      </div>
      <label class="po-memo">Memo<textarea data-head-field="memo" maxlength="4000" ${writable ? "" : "disabled"}>${esc(headValue("memo", current.memo || ""))}</textarea></label>
    </div>
    <div class="smart-table-wrap"><table class="smart-table po-lines"><thead><tr><th>Item</th><th>PLT (editable)</th><th>Native quantity (read only)</th><th>Rate</th><th>Amount</th><th>Destination</th><th>Received</th></tr></thead><tbody>${(current.lines || []).map((line) => lineRow(record, line)).join("") || `<tr><td colspan="7">No current NetSuite lines were mirrored.</td></tr>`}</tbody></table></div>
    <footer><span>Created ${date(record.appCreatedAt, true)} · Archived ${date(record.archivedAt, true)}</span><span>NetSuite synced ${date(record.lastSyncedAt, true)} · Version ${date(record.remoteLastModifiedAt, true)}</span></footer>
    ${snapshotSummary(record)}
  </article>`;
}

function render() {
  poApp.innerHTML = `<header class="dispatch-topbar"><div class="smart-brand"><div class="smart-brand-mark">PO</div><div><p>Smart SCM accounting history</p><h1>NetSuite PO history</h1></div></div><span class="smart-mode">live NetSuite data</span><div class="topbar-actions"><span class="dispatch-user">${esc(poState.operator?.display_name || poState.operator?.username || "")}</span><button onclick="location.href='/scm/smart'">Smart SCM</button><button onclick="location.href='/scm'">SCM menu</button><button onclick="dispatchLogout()">Logout</button></div></header>
  <div class="smart-main">
    ${poState.error ? `<div class="smart-notice error">${esc(poState.error)}</div>` : ""}${poState.syncWarning ? `<div class="smart-notice po-sync-warning">${esc(poState.syncWarning)}</div>` : ""}${poState.notice ? `<div class="smart-notice">${esc(poState.notice)}</div>` : ""}${poState.busy ? `<div class="smart-notice">${esc(poState.busy)}…</div>` : ""}
    <section class="smart-section"><div class="smart-section-head"><div><h2>Archived application-created POs</h2><p>Creation evidence is preserved while current status, prices, quantities, dates and destinations come from NetSuite.</p></div><span class="smart-help">${poState.total} PO(s)</span></div>
      <div class="po-filters">
        <input id="poSearch" type="search" value="${esc(poState.filters.search)}" placeholder="Search PO, vendor, item or yard">
        <label>Created from<input id="poCreatedFrom" type="date" value="${esc(poState.filters.createdFrom)}"></label>
        <label>Created to<input id="poCreatedTo" type="date" value="${esc(poState.filters.createdTo)}"></label>
        <select id="poVendor">${optionList(poState.options.vendors, poState.filters.vendorId, "All vendors")}</select>
        <select id="poVendorYard">${optionList(poState.options.vendorYards, poState.filters.vendorYard, "All vendor yards")}</select>
        <select id="poDestination">${optionList(poState.options.destinations, poState.filters.destinationLocationId, "All destination yards")}</select>
        <select id="poLifecycle" aria-label="PO lifecycle"><option value="" ${poState.filters.lifecycle ? "" : "selected"}>All PO lifecycle</option><option value="pending_receive" ${poState.filters.lifecycle === "pending_receive" ? "selected" : ""}>Pending Receive</option><option value="completed" ${poState.filters.lifecycle === "completed" ? "selected" : ""}>Completed</option><option value="missing" ${poState.filters.lifecycle === "missing" ? "selected" : ""}>No longer exists in NetSuite</option></select>
        <button class="smart-button primary" data-action="filter">Apply</button><button class="smart-button" data-action="clear">Clear</button>
      </div>
      <div class="po-history-list">${poState.records.map(card).join("") || `<div class="smart-empty">No archived application-created PO matches these filters.</div>`}</div>
      <nav class="po-pagination"><button class="smart-button" data-action="previous" ${poState.page <= 1 ? "disabled" : ""}>Previous</button><span>Page ${poState.page} of ${poState.totalPages}</span><button class="smart-button" data-action="next" ${poState.page >= poState.totalPages ? "disabled" : ""}>Next</button></nav>
    </section>
  </div>${poState.pdf ? `<div class="po-modal" role="dialog" aria-modal="true"><div class="po-modal-card"><header><div><strong>${esc(poState.pdf.label)}</strong><small>NetSuite PDF preview</small></div><button data-action="close-pdf" aria-label="Close">×</button></header>${poState.pdf.status === "error" ? `<div class="smart-notice error"><strong>Preview could not be loaded</strong><div>${esc(poState.pdf.error)}</div></div>` : poState.pdf.url ? `<iframe src="${esc(poState.pdf.url)}" title="NetSuite PO PDF"></iframe>` : `<div class="smart-notice">Loading purchase order PDF…</div>`}</div></div>` : ""}`;
}

function readFilters() {
  poState.filters = {
    search: document.getElementById("poSearch")?.value.trim() || "",
    createdFrom: document.getElementById("poCreatedFrom")?.value || "",
    createdTo: document.getElementById("poCreatedTo")?.value || "",
    vendorId: document.getElementById("poVendor")?.value || "",
    vendorYard: document.getElementById("poVendorYard")?.value || "",
    destinationLocationId: document.getElementById("poDestination")?.value || "",
    lifecycle: document.getElementById("poLifecycle")?.value || ""
  };
  poState.filtersDirty = false;
}

async function load({ quiet = false, force = false } = {}) {
  if (quiet && !force && quietRefreshBlocked()) return false;
  const sequence = ++poState.loadSequence;
  let discardQuietResponse = false;
  if (!quiet) poState.busy = "Loading PO history";
  poState.error = "";
  if (!quiet) render();
  try {
    const params = new URLSearchParams({ ...poState.filters, page: String(poState.page), pageSize: String(poState.pageSize) });
    const payload = await api(`/api/scm/netsuite-po-history?${params}`);
    if (sequence !== poState.loadSequence) return false;
    if (quiet && !force && quietRefreshBlocked()) {
      discardQuietResponse = true;
      return false;
    }
    poState.records = payload.records || [];
    poState.page = payload.page || 1;
    poState.total = payload.total || 0;
    poState.totalPages = payload.totalPages || 1;
  } catch (error) {
    if (sequence !== poState.loadSequence) return false;
    if (quiet && !force && quietRefreshBlocked()) {
      discardQuietResponse = true;
      return false;
    }
    poState.error = error.message;
  } finally {
    if (sequence === poState.loadSequence && !discardQuietResponse) {
      poState.busy = "";
      render();
    }
  }
  return true;
}

function changesForCard(cardElement, record) {
  const current = record.current;
  const header = {};
  for (const input of cardElement.querySelectorAll("[data-head-field]")) {
    const field = input.dataset.headField;
    const original = field === "transactionDate" || field === "expectedDeliveryDate"
      ? dateInput(current[field])
      : String(current[field] || "");
    if (input.value !== original) header[field] = input.value;
  }
  const currentByLine = new Map((current.lines || []).map((line) => [Number(line.lineId), line]));
  const lines = [];
  for (const row of cardElement.querySelectorAll("[data-po-line]")) {
    const firstField = row.querySelector("[data-line-field]");
    if (!firstField || firstField.disabled) continue;
    const original = currentByLine.get(Number(row.dataset.poLine));
    if (!original) continue;
    const requested = { lineId: Number(row.dataset.poLine), itemId: original.itemId };
    const palletQuantity = row.querySelector('[data-line-field="palletQuantity"]');
    const rate = row.querySelector('[data-line-field="rate"]');
    const destination = row.querySelector('[data-line-field="destinationLocationId"]');
    if (palletQuantity && !palletQuantity.disabled && !sameNumber(palletQuantity.value, original.palletQuantity)) {
      requested.palletQuantity = Number(palletQuantity.value);
    }
    if (rate && !sameNumber(rate.value, original.rate ?? 0)) requested.rate = Number(rate.value);
    if (destination && String(destination.value) !== String(original.destinationLocationId ?? "")) {
      requested.destinationLocationId = Number(destination.value);
    }
    if (Object.keys(requested).length > 2) lines.push(requested);
  }
  return { header, lines };
}

function clearHeaderDraftField(id, field) {
  const draft = poState.drafts.get(id);
  if (!draft) return;
  const header = { ...(draft.header || {}) };
  delete header[field];
  const next = { header, lines: [...(draft.lines || [])] };
  if (Object.keys(next.header).length || next.lines.length) {
    poState.drafts.set(id, next);
    poState.dirtyIds.add(id);
  } else {
    poState.drafts.delete(id);
    poState.dirtyIds.delete(id);
  }
}

function syncNativeQuantityPreview(input) {
  if (!input?.matches('[data-line-field="palletQuantity"]')) return;
  const row = input.closest("[data-po-line]");
  const native = row?.querySelector("[data-line-native-quantity]");
  const unitsPerPallet = Number(row?.dataset.unitsPerPallet);
  const pallets = Number(input.value);
  if (!native) return;
  native.value = Number.isFinite(pallets) && pallets > 0 && Number.isFinite(unitsPerPallet) && unitsPerPallet > 0
    ? inputNumber(pallets * unitsPerPallet)
    : "";
}

async function reconcileFromNetSuite() {
  if (poState.remoteSyncRunning || !poState.records.length || quietRefreshBlocked() || document.visibilityState !== "visible") return;
  poState.remoteSyncRunning = true;
  const oldest = [...poState.records].sort((left, right) => new Date(left.lastSyncedAt || 0) - new Date(right.lastSyncedAt || 0))[0];
  try {
    // One bounded server request reconciles the requested PO plus up to 24
    // oldest stale app-created POs in a single SuiteQL batch.
    await api(`/api/scm/netsuite-po-history/${oldest.id}/refresh`, { method: "POST", body: {} });
    poState.syncWarning = "";
    await load({ quiet: true });
  } catch (error) {
    poState.syncWarning = `Live NetSuite refresh delayed: ${error.message} Local history remains available.`;
    if (!quietRefreshBlocked()) render();
  } finally {
    poState.remoteSyncRunning = false;
  }
}

async function act(button) {
  const action = button.dataset.action;
  if (poState.filtersDirty && !["filter", "clear"].includes(action)) readFilters();
  if (action === "close-pdf") { closePdf(); render(); return; }
  if (["filter", "clear", "previous", "next"].includes(action) && poState.dirtyIds.size && !confirm("Discard unsaved PO edits and continue?")) return;
  if (["filter", "clear", "previous", "next"].includes(action)) { poState.dirtyIds.clear(); poState.drafts.clear(); }
  if (action === "filter") { readFilters(); poState.page = 1; await load(); return; }
  if (action === "clear") { poState.filters = { search: "", createdFrom: "", createdTo: "", vendorId: "", vendorYard: "", destinationLocationId: "", lifecycle: "pending_receive" }; poState.filtersDirty = false; poState.page = 1; await load(); return; }
  if (action === "previous" || action === "next") { poState.page += action === "next" ? 1 : -1; await load(); return; }
  const cardElement = button.closest("[data-history-id]");
  if (!cardElement) return;
  const id = Number(cardElement.dataset.historyId);
  const record = poState.records.find((row) => row.id === id);
  if (action === "pdf") { await loadPdf(record); return; }
  if (action === "unarchive" && !confirm(`${record.purchaseOrderRef} will return to Vendor Replies and disappear from this history. Continue?`)) return;
  const savingVendorReference = action === "save-vendor-reference";
  const vendorReference = savingVendorReference
    ? String(cardElement.querySelector('[data-head-field="vendorReference"]')?.value || "").trim()
    : "";
  const changes = action === "save"
    ? changesForCard(cardElement, record)
    : savingVendorReference
      ? { header: { vendorReference }, lines: [] }
      : null;
  if (action === "save" && !Object.keys(changes.header).length && !changes.lines.length) {
    poState.notice = `${record.purchaseOrderRef} has no unsaved changes.`;
    poState.dirtyIds.delete(id);
    poState.drafts.delete(id);
    render();
    return;
  }
  if (savingVendorReference && vendorReference === String(record.current.vendorReference || "").trim()) {
    poState.notice = `${record.purchaseOrderRef} has no Vendor reference change to save.`;
    clearHeaderDraftField(id, "vendorReference");
    render();
    return;
  }
  poState.error = "";
  poState.notice = "";
  poState.busy = savingVendorReference
    ? "Saving Vendor reference to NetSuite"
    : action === "save" ? "Saving changes to NetSuite" : action === "refresh" ? "Refreshing from NetSuite" : "Returning PO to Vendor Replies";
  render();
  try {
    if (action === "save" || savingVendorReference) {
      const saved = await api(`/api/scm/netsuite-po-history/${id}`, { method: "PATCH", body: { expectedLastModifiedAt: cardElement.dataset.version, ...changes } });
      if (savingVendorReference) clearHeaderDraftField(id, "vendorReference");
      else {
        poState.dirtyIds.delete(id);
        poState.drafts.delete(id);
      }
      poState.notice = saved.readbackPending
        ? savingVendorReference
          ? `${record.purchaseOrderRef} Vendor reference was accepted by NetSuite. Packing Slip / Ref will synchronize after readback.`
          : `${record.purchaseOrderRef} was accepted by NetSuite. Readback is still pending and will reconcile automatically.`
        : savingVendorReference
          ? `${record.purchaseOrderRef} Vendor reference and Packing Slip / Ref were saved.`
          : `${record.purchaseOrderRef} was updated in NetSuite and read back successfully.`;
    } else if (action === "refresh") {
      await api(`/api/scm/netsuite-po-history/${id}/refresh`, { method: "POST", body: {} });
      poState.notice = `${record.purchaseOrderRef} refreshed from NetSuite.`;
    } else if (action === "unarchive") {
      await api(`/api/scm/netsuite-po-history/${id}/unarchive`, { method: "POST", body: {} });
      poState.dirtyIds.delete(id);
      poState.drafts.delete(id);
      poState.notice = `${record.purchaseOrderRef} returned to Vendor Replies.`;
    }
    poState.busy = "";
    await load({ quiet: true, force: true });
  } catch (error) {
    poState.error = error.status === 409 ? `${error.message} No local values were changed.` : error.message;
    poState.busy = "";
    render();
  }
}

poApp.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (button && !poState.busy) act(button);
});

poApp.addEventListener("keydown", (event) => {
  if (event.target.id === "poSearch" && event.key === "Enter") {
    event.preventDefault();
    if (poState.dirtyIds.size && !confirm("Discard unsaved PO edits and search?")) return;
    poState.dirtyIds.clear();
    poState.drafts.clear();
    readFilters();
    poState.page = 1;
    load();
  }
});

poApp.addEventListener("input", (event) => {
  syncNativeQuantityPreview(event.target);
  if (event.target.closest(".po-filters")) poState.filtersDirty = true;
  const cardElement = event.target.closest("[data-history-id]");
  if (cardElement && (event.target.matches("[data-head-field]") || event.target.matches("[data-line-field]"))) {
    const id = Number(cardElement.dataset.historyId);
    const record = poState.records.find((row) => row.id === id);
    const draft = record ? changesForCard(cardElement, record) : { header: {}, lines: [] };
    if (Object.keys(draft.header).length || draft.lines.length) {
      poState.dirtyIds.add(id);
      poState.drafts.set(id, draft);
    } else {
      poState.dirtyIds.delete(id);
      poState.drafts.delete(id);
    }
  }
});

poApp.addEventListener("change", (event) => {
  if (event.target.closest(".po-filters")) poState.filtersDirty = true;
  const cardElement = event.target.closest("[data-history-id]");
  if (cardElement && (event.target.matches("[data-head-field]") || event.target.matches("[data-line-field]"))) {
    const id = Number(cardElement.dataset.historyId);
    const record = poState.records.find((row) => row.id === id);
    const draft = record ? changesForCard(cardElement, record) : { header: {}, lines: [] };
    if (Object.keys(draft.header).length || draft.lines.length) {
      poState.dirtyIds.add(id);
      poState.drafts.set(id, draft);
    } else {
      poState.dirtyIds.delete(id);
      poState.drafts.delete(id);
    }
  }
});

function startEvents() {
  if (!("EventSource" in window) || poState.events) return;
  poState.events = new EventSource("/api/events?client=scm-netsuite-po-history");
  poState.events.addEventListener("app-event", (message) => {
    try {
      const event = JSON.parse(message.data || "{}");
      if (event.type === "scm.smart.updated" || event.type === "receiving.order.updated") load({ quiet: true });
    } catch { /* malformed events are ignored; timed refresh remains active */ }
  });
}

setInterval(() => { if (poState.operator) reconcileFromNetSuite(); }, 60000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && poState.operator && !poState.busy) {
    load({ quiet: true }).then(() => reconcileFromNetSuite());
  }
});
window.addEventListener("beforeunload", () => {
  releasePdfDocument();
  poState.events?.close();
});

requireDispatchLogin({
  mount: poApp,
  roles: ["admin", "scm", "scm_staff"],
  async onReady(operator) {
    poState.operator = operator;
    render();
    try { poState.options = await api("/api/scm/netsuite-po-history/options"); } catch (error) { poState.error = error.message; }
    startEvents();
    await load();
    void reconcileFromNetSuite();
  }
});

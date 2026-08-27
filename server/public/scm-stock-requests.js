const scmStockRequestApp = document.getElementById("scmStockRequestApp");

const scmStockState = {
  operator: null,
  queue: localStorage.getItem("mbbs.scm.stockRequests.queue") || "request",
  search: "",
  vendorFilter: "",
  requestDateFilter: "",
  sourceLocationFilter: "",
  destinationLocationFilter: "",
  filterOptions: { vendors: [], sourceYards: [], destinationYards: [] },
  requests: [],
  selectedId: Number(localStorage.getItem("mbbs.scm.stockRequests.selected")) || null,
  selectedTransferId: null,
  detail: null,
  selectedLineIds: new Set(),
  pendingDecision: null,
  loading: true,
  busy: false,
  error: "",
  notice: "",
  eventSource: null,
  refreshTimer: null,
  loadGeneration: 0
};

function scmStockEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}

function scmStockNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat("en-CA", { maximumFractionDigits: 4 }).format(number) : "0";
}

function scmStockDate(value) {
  if (!value) return "—";
  return window.MBBS_I18N?.displayDateTime?.(value) || String(value);
}

function scmStockPill(status) {
  const normalized = String(status || "unknown").trim().toLowerCase();
  return `<span class="stock-request-pill ${scmStockEscape(normalized)}">${scmStockEscape(normalized.replaceAll("_", " "))}</span>`;
}

async function scmStockApi(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(payload?.error || payload || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = payload?.code || "";
    throw error;
  }
  return payload;
}

function scmStockHeader() {
  const operator = scmStockState.operator || {};
  return `<header class="dispatch-topbar">
    <div><p>SCM · Sales Requests</p><h1>Stock Requests</h1></div>
    <div class="topbar-language">${window.MBBS_I18N?.toggleHtml?.() || ""}</div>
    <div class="topbar-actions">
      <span class="dispatch-user">${scmStockEscape(operator.display_name || operator.username || "")}</span>
      <button onclick="location.href='/scm'" type="button">SCM Menu</button>
      <button onclick="dispatchLogout()" type="button">Logout</button>
    </div>
  </header>`;
}

function scmStockList() {
  if (scmStockState.loading) return `<div class="stock-request-empty"><strong>Loading ${scmStockState.queue === "request" ? "requests" : "pending TOs"}…</strong></div>`;
  if (!scmStockState.requests.length) return `<div class="stock-request-empty"><strong>No records in this queue</strong><span>Live changes will appear automatically.</span></div>`;
  return scmStockState.requests.map((request) => {
    const pendingLines = request.lines.filter((line) => ["submitted", "changes_requested"].includes(line.status)).length;
    const pendingTransfers = request.transfers.filter((transfer) => !["received", "cancelled", "closed"].includes(transfer.status)).length;
    const rejectedLines = request.lines.filter((line) => line.status === "rejected").length;
    const closedTransfers = request.transfers.filter((transfer) => transfer.status === "closed").length;
    const countLabel = scmStockState.queue === "request"
      ? `${pendingLines} actionable line(s)`
      : scmStockState.queue === "pending_to"
        ? `${pendingTransfers} pending TO(s)`
        : scmStockState.queue === "rejected"
          ? `${rejectedLines} rejected line(s)`
          : `${closedTransfers} closed TO(s)`;
    return `<button class="stock-request-card ${Number(request.id) === Number(scmStockState.selectedId) ? "selected" : ""}" data-scm-stock-action="select" data-id="${Number(request.id)}" type="button">
      <span class="stock-request-status-line"><strong>${scmStockEscape(request.requestRef)}</strong>${scmStockPill(request.bucket || request.status)}</span>
      <span>To ${scmStockEscape(request.destinationName)} · ${countLabel}</span>
      <small>${scmStockEscape(request.requestedByName || request.requestedBy || "")} · ${scmStockDate(request.updatedAt)}</small>
    </button>`;
  }).join("");
}

function scmStockAvailability(itemId) {
  return scmStockState.detail?.availability?.find((entry) => Number(entry.item?.itemId) === Number(itemId)) || null;
}

function scmStockAvailabilityMatrix(itemId) {
  const availability = scmStockAvailability(itemId);
  if (!availability) return "";
  return `<div class="stock-request-availability">${availability.yards.map((yard) => {
    const equivalents = [
      ["PLT", availability.item.toPlt],
      ["LYR", availability.item.toLyr],
      ["SEC", availability.item.toSec],
      ["PCS", availability.item.toPcs]
    ].filter(([, conversion]) => Number(conversion) > 0)
      .map(([label, conversion]) => `<span><strong>${scmStockNumber(Number(yard.requestableAvailable) / Number(conversion))}</strong> ${label}</span>`)
      .join("");
    return `<article><small>${scmStockEscape(yard.yardCode)}</small>
      <span class="stock-request-availability-primary"><small>Sales quantity</small><strong>${scmStockNumber(yard.requestableAvailable)} ${scmStockEscape(availability.item.salesUom)}</strong></span>
      ${equivalents ? `<span class="stock-request-availability-equivalents">${equivalents}</span>` : ""}
      <small>${scmStockNumber(yard.liveAvailable)} live − ${scmStockNumber(yard.activeReserved)} reserved</small></article>`;
  }).join("")}</div>`;
}

function scmStockSourceOptions(line) {
  const availability = scmStockAvailability(line.itemId);
  if (!availability) return `<option value="${Number(line.sourceLocationId)}">${scmStockEscape(line.sourceName)}</option>`;
  return availability.yards.filter((yard) => Number(yard.locationId) !== Number(line.destinationLocationId)).map((yard) => `<option value="${Number(yard.locationId)}" ${Number(yard.locationId) === Number(line.sourceLocationId) ? "selected" : ""}>${scmStockEscape(yard.yardCode)} · ${scmStockNumber(yard.requestableAvailable)} available</option>`).join("");
}

function scmStockBackorderNotice(lines, { transfer = null } = {}) {
  const grouped = new Map();
  for (const line of lines || []) {
    const sourceLocationId = Number(transfer?.sourceLocationId ?? line.sourceLocationId);
    const key = `${Number(line.itemId)}:${sourceLocationId}`;
    const current = grouped.get(key) || {
      itemId: Number(line.itemId),
      itemName: line.itemName || "Item",
      salesUom: line.salesUom || "",
      sourceLocationId,
      requested: 0
    };
    current.requested += Number(line.salesQty || 0);
    grouped.set(key, current);
  }
  const shortages = [];
  for (const group of grouped.values()) {
    const yard = scmStockAvailability(group.itemId)?.yards?.find((entry) =>
      Number(entry.locationId) === group.sourceLocationId
    );
    if (!yard) continue;
    const ownReserved = transfer ? group.requested : 0;
    const otherReserved = Math.max(0, Number(yard.activeReserved || 0) - ownReserved);
    const availableForThisTo = Math.max(0, Number(yard.liveAvailable || 0) - otherReserved);
    const backorder = Math.max(0, group.requested - availableForThisTo);
    if (backorder <= 1e-9) continue;
    shortages.push(`${scmStockEscape(group.itemName)}: requested/TO ${scmStockNumber(group.requested)} ${scmStockEscape(group.salesUom)}, currently available ${scmStockNumber(availableForThisTo)}, backorder ${scmStockNumber(backorder)}`);
  }
  if (!shortages.length) return "";
  return `<div class="stock-request-notice stock-request-backorder"><strong>Backorder allowed.</strong> ${shortages.join("<br />")}</div>`;
}

function scmStockQuantityInputs(line, prefix = "line", disabled = false) {
  const fields = [
    ["pallets", "PLT", line.toPlt],
    ["layers", "LYR", line.toLyr],
    ["sections", "SEC", line.toSec],
    ["pieces", "PCS", line.toPcs]
  ].filter(([, , conversion]) => Number(conversion) > 0);
  if (!fields.length) {
    return `<label><span>Sales quantity (${scmStockEscape(line.salesUom)})</span><input data-scm-stock-quantity="salesQty" data-prefix="${prefix}" type="number" min="0" step="any" value="${scmStockEscape(line.salesQty)}" ${disabled ? "disabled" : ""} /></label>`;
  }
  return fields.map(([field, label, conversion]) => `<label><span>${label} <small>× ${scmStockNumber(conversion)}</small></span><input data-scm-stock-quantity="${field}" data-prefix="${prefix}" type="number" min="0" step="${field === "layers" ? "1" : "any"}" value="${scmStockEscape(line[field] ?? "")}" ${disabled ? "disabled" : ""} /></label>`).join("");
}

function scmStockRequestLine(line) {
  const actionable = line.status === "submitted" || line.status === "changes_requested";
  const editable = line.status === "submitted";
  return `<article class="stock-request-line" data-scm-stock-line-id="${Number(line.id)}">
    <header>
      <div class="stock-request-status-line">${actionable ? `<input data-scm-stock-select-line type="checkbox" ${scmStockState.selectedLineIds.has(line.id) ? "checked" : ""} aria-label="Select ${scmStockEscape(line.itemName)}" />` : ""}<div><strong>${scmStockEscape(line.itemName)}</strong><div class="stock-request-muted">${scmStockEscape(line.itemDescription || "")}</div></div></div>
      ${scmStockPill(line.status)}
    </header>
    <div class="stock-request-line-fields">
      <label><span>Source yard</span><select data-scm-stock-source ${editable ? "" : "disabled"}>${scmStockSourceOptions(line)}</select></label>
      ${scmStockQuantityInputs(line, "line", !editable)}
    </div>
    ${scmStockAvailabilityMatrix(line.itemId)}
    ${line.decisionReason ? `<div class="stock-request-notice"><strong>Decision reason:</strong> ${scmStockEscape(line.decisionReason)}</div>` : ""}
    ${editable ? `<div class="stock-request-actions"><button data-scm-stock-action="save-line" type="button">Save line adjustment</button></div>` : ""}
  </article>`;
}

function scmStockDecisionEditor() {
  const pending = scmStockState.pendingDecision;
  if (!pending) return "";
  const isReject = pending.decision === "reject";
  const label = isReject ? "Reject" : "Request Changes";
  const title = isReject ? "Reject stock-request lines" : "Request changes for stock-request lines";
  return `<section class="stock-request-section stock-request-form stock-request-decision-editor" role="dialog" aria-labelledby="scmStockDecisionTitle">
    <h3 id="scmStockDecisionTitle">${title}</h3>
    <p>${pending.lineIds.length} line(s) will be updated. Enter the required reason before confirming.</p>
    <label><span>${label} reason</span><textarea data-scm-stock-decision-reason maxlength="1000" rows="3" required>${scmStockEscape(pending.reason || "")}</textarea></label>
    <div class="stock-request-actions">
      <button data-scm-stock-action="cancel-decision" type="button">Cancel</button>
      <button class="${isReject ? "danger" : "primary"}" data-scm-stock-action="confirm-decision" type="button">Confirm ${label}</button>
    </div>
  </section>`;
}

function scmStockRequestDetail() {
  const request = scmStockState.detail;
  if (!request) return `<div class="stock-request-empty"><strong>Select a request</strong><span>All-yard availability and line decisions will appear here.</span></div>`;
  const selectable = request.lines.filter((line) => line.status === "submitted" || line.status === "changes_requested");
  const selected = request.lines.filter((line) => scmStockState.selectedLineIds.has(line.id));
  const canRequestChanges = selected.length > 0 && selected.every((line) => line.status === "submitted");
  return `<div class="stock-request-heading">
      <div><h2>${scmStockEscape(request.requestRef)}</h2><p>${scmStockEscape(request.requestedByName || request.requestedBy || "")} · destination ${scmStockEscape(request.destinationName)}</p></div>
      ${scmStockPill(request.bucket || request.status)}
    </div>
    <div class="stock-request-summary">
      <span><small>Destination</small><strong>${scmStockEscape(request.destinationName)}</strong></span>
      <span><small>Revision</small><strong>${Number(request.revision)}</strong></span>
      <span><small>Submitted</small><strong>${scmStockDate(request.createdAt)}</strong></span>
      <span><small>First SCM decision</small><strong>${scmStockDate(request.firstScmDecisionAt)}</strong></span>
    </div>
    ${request.remarks ? `<div class="stock-request-notice"><strong>Sales remark:</strong> ${scmStockEscape(request.remarks)}</div>` : ""}
    ${scmStockBackorderNotice(selectable)}
    <div class="stock-request-actions">
      <button data-scm-stock-action="select-all" type="button" ${selectable.length ? "" : "disabled"}>Select actionable lines</button>
      <button class="primary" data-scm-stock-action="convert" type="button" ${scmStockState.selectedLineIds.size ? "" : "disabled"}>Convert to TO</button>
      <button data-scm-stock-action="request-changes" type="button" ${canRequestChanges ? "" : "disabled"}>Request Changes</button>
      <button class="danger" data-scm-stock-action="reject" type="button" ${selectable.length ? "" : "disabled"}>${selected.length ? "Reject selected" : "Reject all actionable"}</button>
    </div>
    ${scmStockDecisionEditor()}
    <section class="stock-request-section"><h3>Request lines and all-yard availability</h3><div class="stock-request-lines">${request.lines.map(scmStockRequestLine).join("")}</div></section>`;
}

function scmStockSelectedTransfer() {
  const transfers = scmStockState.detail?.transfers || [];
  return transfers.find((transfer) => Number(transfer.id) === Number(scmStockState.selectedTransferId))
    || (scmStockState.queue === "closed" ? transfers.find((transfer) => transfer.status === "closed") : null)
    || transfers.find((transfer) => !["received", "cancelled", "closed"].includes(transfer.status))
    || transfers[0]
    || null;
}

function scmStockTransferList(request) {
  return `<div class="stock-request-tabs">${request.transfers.map((transfer) => `<button data-scm-stock-action="select-transfer" data-transfer-id="${Number(transfer.id)}" aria-selected="${Number(scmStockSelectedTransfer()?.id) === Number(transfer.id)}" type="button">${scmStockEscape(transfer.transferRef)} · ${scmStockEscape(transfer.sourceName)} → ${scmStockEscape(transfer.destinationName)}</button>`).join("")}</div>`;
}

function scmStockTransferLine(line) {
  return `<article class="stock-request-line" data-scm-stock-transfer-line-id="${Number(line.id)}">
    <header><div><strong>${scmStockEscape(line.itemName)}</strong><div class="stock-request-muted">${scmStockEscape(line.itemDescription || "")}</div></div><strong>${scmStockNumber(line.salesQty)} ${scmStockEscape(line.salesUom)}</strong></header>
    <div class="stock-request-line-fields">${scmStockQuantityInputs(line, "transfer", line.disabled === true)}</div>
  </article>`;
}

function scmStockPendingToDetail() {
  const request = scmStockState.detail;
  if (!request) return `<div class="stock-request-empty"><strong>Select a pending TO</strong><span>Local and real Transfer Order controls will appear here.</span></div>`;
  if (!request.transfers.length) return `<div class="stock-request-empty"><strong>No pending TO on this request</strong></div>`;
  const transfer = scmStockSelectedTransfer();
  scmStockState.selectedTransferId = transfer.id;
  const canEdit = !["partially_fulfilled", "pending_receipt", "received", "cancelled", "closed"].includes(transfer.status);
  const canConfirm = ["pending_local", "attention"].includes(transfer.status);
  const hasPrinted = Boolean(transfer.printJobId || transfer.printGeneration);
  const canRejectPending = transfer.status === "pending_local"
    && transfer.confirmationStatus === "idle"
    && !transfer.confirmationRequestId
    && !transfer.netsuiteTransferOrderId
    && !transfer.netsuiteTransferOrderRef
    && !transfer.printJobId
    && !transfer.printGeneration;
  return `<div class="stock-request-heading">
      <div><h2>${scmStockEscape(request.requestRef)} · ${scmStockEscape(transfer.transferRef)}</h2><p>${scmStockEscape(transfer.sourceName)} → ${scmStockEscape(transfer.destinationName)}</p></div>
      ${scmStockPill(transfer.status)}
    </div>
    ${scmStockTransferList(request)}
    <div class="stock-request-summary">
      <span><small>From location</small><strong>${scmStockEscape(transfer.sourceName)}</strong></span>
      <span><small>To location</small><strong>${scmStockEscape(transfer.destinationName)}</strong></span>
      <span><small>Local revision</small><strong>${Number(transfer.revision)}</strong></span>
      <span><small>NetSuite TO</small><strong>${scmStockEscape(transfer.netsuiteTransferOrderRef || "Not created")}</strong></span>
      <span><small>Print</small><strong>${scmStockEscape(transfer.printStatus || (hasPrinted ? "queued" : "not printed"))}</strong></span>
      <span><small>Dispatch</small><strong>${scmStockEscape(transfer.dispatchPlanned ? `${transfer.dispatchPlanDate || "Planned"} · ${transfer.dispatchTruckPlate || "Truck pending"}` : "Not planned")}</strong></span>
      <span><small>Driver</small><strong>${transfer.driverCompleted ? "Completed" : "Pending"}</strong></span>
      <span><small>Status</small><strong>${scmStockEscape(transfer.status === "closed" ? "Closed by NetSuite" : transfer.receivingStatus || transfer.netsuiteStatusText || "Pending")}</strong></span>
    </div>
    ${transfer.confirmationError ? `<div class="stock-request-notice stock-request-error"><strong>Attention:</strong> ${scmStockEscape(transfer.confirmationError)}</div>` : ""}
    ${transfer.printInvalidatedAt ? `<div class="stock-request-notice">The prior ticket was invalidated by a quantity change. Save/sync, then use Re-print.</div>` : ""}
    ${request.remarks ? `<div class="stock-request-notice"><strong>Sales remark:</strong> ${scmStockEscape(request.remarks)}</div>` : ""}
    ${scmStockBackorderNotice(transfer.lines, { transfer })}
    <section class="stock-request-section"><h3>TO material quantities</h3><div class="stock-request-lines">${transfer.lines.map((line) => scmStockTransferLine({ ...line, disabled: !canEdit })).join("")}</div></section>
    <div class="stock-request-line-fields">
      <label><span>Official PALLET item quantity${transfer.palletQuantityRequiresManual ? " · required manual final value" : ""}</span><input data-scm-stock-pallet type="number" min="0" step="any" value="${scmStockEscape(transfer.palletQuantity)}" ${canEdit ? "" : "disabled"} /></label>
    </div>
    <div class="stock-request-actions">
      <button data-scm-stock-action="save-transfer" type="button" ${canEdit ? "" : "disabled"}>Save TO quantities</button>
      <button class="primary" data-scm-stock-action="confirm-print" type="button" ${canConfirm ? "" : "disabled"}>Confirm TO + Print</button>
      ${hasPrinted || transfer.netsuiteTransferOrderId ? `<button data-scm-stock-action="reprint" type="button" ${transfer.netsuiteTransferOrderId ? "" : "disabled"}>Re-print</button>` : ""}
      ${scmStockState.queue === "pending_to" ? `<button class="danger" data-scm-stock-action="reject-pending-to" title="${canRejectPending ? "Reject this local Pending TO" : "Only available before Confirm TO + Print"}" type="button" ${canRejectPending ? "" : "disabled"}>Reject Pending TO</button>` : ""}
    </div>`;
}

function scmStockFocusSnapshot() {
  const active = document.activeElement;
  if (!active || !scmStockRequestApp.contains(active) || !active.matches("[data-scm-stock-search]")) return null;
  return { selectionStart: active.selectionStart, selectionEnd: active.selectionEnd };
}

function scmStockRestoreFocus(snapshot) {
  if (!snapshot) return;
  const input = scmStockRequestApp.querySelector("[data-scm-stock-search]");
  input?.focus();
  if (typeof input?.setSelectionRange === "function") {
    input.setSelectionRange(snapshot.selectionStart ?? input.value.length, snapshot.selectionEnd ?? input.value.length);
  }
}

function scmStockFilterOptions(kind, selected) {
  const values = scmStockState.filterOptions[kind] || [];
  return values.map((value) => {
    const optionValue = typeof value === "string" ? value : value.locationId;
    const label = typeof value === "string" ? value : value.yardCode;
    return `<option value="${scmStockEscape(optionValue)}" ${String(selected) === String(optionValue) ? "selected" : ""}>${scmStockEscape(label)}</option>`;
  }).join("");
}

function renderScmStockRequests() {
  const focusSnapshot = scmStockFocusSnapshot();
  scmStockRequestApp.innerHTML = `${scmStockHeader()}
    <section class="stock-request-page">
      <div class="stock-request-tabs" role="tablist" aria-label="Stock request type">
        <button aria-selected="true" type="button">Regular</button>
        <button data-scm-stock-action="special" type="button">Special</button>
      </div>
      <div class="stock-request-toolbar">
        <div class="stock-request-tabs" role="tablist" aria-label="Regular stock request queue">
          <button data-scm-stock-action="queue" data-queue="request" aria-selected="${scmStockState.queue === "request"}" type="button">Request</button>
          <button data-scm-stock-action="queue" data-queue="pending_to" aria-selected="${scmStockState.queue === "pending_to"}" type="button">Pending TO</button>
          <button data-scm-stock-action="queue" data-queue="rejected" aria-selected="${scmStockState.queue === "rejected"}" type="button">Rejected</button>
          <button data-scm-stock-action="queue" data-queue="closed" aria-selected="${scmStockState.queue === "closed"}" type="button">Closed</button>
        </div>
        <div class="stock-request-actions"><input class="stock-request-search" data-scm-stock-search type="search" value="${scmStockEscape(scmStockState.search)}" placeholder="Search request or item" /><button data-scm-stock-action="refresh" type="button">Refresh</button></div>
        <div class="stock-request-filters">
          <label><span>Item vendor</span><select name="vendor" data-scm-stock-filter="vendorFilter"><option value="">All vendors</option>${scmStockFilterOptions("vendors", scmStockState.vendorFilter)}</select></label>
          <label><span>Request date</span><input name="requestDate" data-scm-stock-filter="requestDateFilter" type="date" value="${scmStockEscape(scmStockState.requestDateFilter)}" /></label>
          <label><span>From yard</span><select name="sourceLocationId" data-scm-stock-filter="sourceLocationFilter"><option value="">All source yards</option>${scmStockFilterOptions("sourceYards", scmStockState.sourceLocationFilter)}</select></label>
          <label><span>To yard</span><select name="destinationLocationId" data-scm-stock-filter="destinationLocationFilter"><option value="">All destination yards</option>${scmStockFilterOptions("destinationYards", scmStockState.destinationLocationFilter)}</select></label>
          <button data-scm-stock-action="clear-filters" type="button">Clear filters</button>
        </div>
      </div>
      <div class="stock-request-feedback">
        ${scmStockState.notice ? `<div class="stock-request-notice">${scmStockEscape(scmStockState.notice)}</div>` : ""}
        ${scmStockState.error ? `<div class="stock-request-notice stock-request-error">${scmStockEscape(scmStockState.error)}</div>` : ""}
      </div>
      <div class="stock-request-workspace">
        <aside class="stock-request-panel stock-request-list">${scmStockList()}</aside>
        <section class="stock-request-panel stock-request-detail">${["pending_to", "closed"].includes(scmStockState.queue) ? scmStockPendingToDetail() : scmStockRequestDetail()}</section>
      </div>
    </section>`;
  scmStockRestoreFocus(focusSnapshot);
}

async function scmStockLoadDetail(id) {
  if (!id) {
    scmStockState.detail = null;
    return;
  }
  const generation = ++scmStockState.loadGeneration;
  const detail = await scmStockApi(`/api/scm/stock-requests/${encodeURIComponent(id)}`);
  if (generation !== scmStockState.loadGeneration) return;
  scmStockState.detail = detail;
  const valid = new Set(scmStockState.detail.lines.filter((line) => ["submitted", "changes_requested"].includes(line.status)).map((line) => line.id));
  scmStockState.selectedLineIds = new Set([...scmStockState.selectedLineIds].filter((id) => valid.has(id)));
  if (!scmStockState.detail.transfers.some((transfer) => Number(transfer.id) === Number(scmStockState.selectedTransferId))) {
    scmStockState.selectedTransferId = (scmStockState.queue === "closed"
      ? scmStockState.detail.transfers.find((transfer) => transfer.status === "closed")
      : scmStockState.detail.transfers.find((transfer) => !["received", "cancelled", "closed"].includes(transfer.status)))?.id
      || scmStockState.detail.transfers[0]?.id
      || null;
  }
}

async function scmStockLoad({ preserveSelection = true } = {}) {
  const generation = ++scmStockState.loadGeneration;
  scmStockState.loading = true;
  renderScmStockRequests();
  const params = new URLSearchParams({ queue: scmStockState.queue, limit: "100" });
  if (scmStockState.search.trim()) params.set("search", scmStockState.search.trim());
  if (scmStockState.vendorFilter) params.set("vendor", scmStockState.vendorFilter);
  if (scmStockState.requestDateFilter) params.set("requestDate", scmStockState.requestDateFilter);
  if (scmStockState.sourceLocationFilter) params.set("sourceLocationId", scmStockState.sourceLocationFilter);
  if (scmStockState.destinationLocationFilter) params.set("destinationLocationId", scmStockState.destinationLocationFilter);
  const payload = await scmStockApi(`/api/scm/stock-requests?${params}`);
  if (generation !== scmStockState.loadGeneration) return;
  const requests = payload.requests || [];
  let selectedId = scmStockState.selectedId;
  if (!preserveSelection || !requests.some((request) => Number(request.id) === Number(selectedId))) {
    selectedId = requests[0]?.id || null;
  }
  const detail = selectedId
    ? await scmStockApi(`/api/scm/stock-requests/${encodeURIComponent(selectedId)}`)
    : null;
  if (generation !== scmStockState.loadGeneration) return;
  scmStockState.requests = requests;
  scmStockState.filterOptions = payload.filterOptions || { vendors: [], sourceYards: [], destinationYards: [] };
  scmStockState.selectedId = selectedId;
  scmStockState.detail = detail;
  const validLineIds = new Set((detail?.lines || []).filter((line) => ["submitted", "changes_requested"].includes(line.status)).map((line) => line.id));
  scmStockState.selectedLineIds = new Set([...scmStockState.selectedLineIds].filter((id) => validLineIds.has(id)));
  if (detail && !detail.transfers.some((transfer) => Number(transfer.id) === Number(scmStockState.selectedTransferId))) {
    scmStockState.selectedTransferId = (scmStockState.queue === "closed"
      ? detail.transfers.find((transfer) => transfer.status === "closed")
      : detail.transfers.find((transfer) => !["received", "cancelled", "closed"].includes(transfer.status)))?.id
      || detail.transfers[0]?.id
      || null;
  }
  if (selectedId) localStorage.setItem("mbbs.scm.stockRequests.selected", String(selectedId));
  scmStockState.loading = false;
  scmStockState.error = "";
  renderScmStockRequests();
}

function scmStockLineElement(target) {
  const element = target.closest("[data-scm-stock-line-id]");
  if (!element) return null;
  return scmStockState.detail?.lines.find((line) => Number(line.id) === Number(element.dataset.scmStockLineId)) || null;
}

function scmStockQuantityPayload(container, line) {
  const fields = [...container.querySelectorAll("[data-scm-stock-quantity]")];
  const conversions = [line.toPlt, line.toLyr, line.toSec, line.toPcs].some((value) => Number(value) > 0);
  const payload = {};
  for (const field of fields) {
    const key = field.dataset.scmStockQuantity;
    if (String(field.value).trim() !== "") payload[key] = Number(field.value);
  }
  if (!conversions && !Object.hasOwn(payload, "salesQty")) payload.salesQty = Number(line.salesQty);
  return payload;
}

async function scmStockSaveLine(button) {
  const container = button.closest("[data-scm-stock-line-id]");
  const line = scmStockLineElement(button);
  const body = {
    expectedRevision: scmStockState.detail.revision,
    itemId: line.itemId,
    sourceLocationId: Number(container.querySelector("[data-scm-stock-source]").value),
    ...scmStockQuantityPayload(container, line)
  };
  scmStockState.detail = await scmStockApi(`/api/scm/stock-requests/${scmStockState.detail.id}/lines/${line.id}`, {
    method: "PATCH",
    body: JSON.stringify(body)
  });
  renderScmStockRequests();
}

function scmStockOpenDecision(decision) {
  const allowedStatuses = decision === "reject"
    ? new Set(["submitted", "changes_requested"])
    : new Set(["submitted"]);
  const eligible = (scmStockState.detail?.lines || []).filter((line) => allowedStatuses.has(line.status));
  const selected = eligible.filter((line) => scmStockState.selectedLineIds.has(line.id));
  const targets = selected.length ? selected : eligible;
  if (!targets.length) throw new Error("No actionable stock-request lines are available.");
  scmStockState.pendingDecision = {
    decision,
    lineIds: targets.map((line) => line.id),
    reason: ""
  };
  scmStockState.error = "";
  renderScmStockRequests();
  scmStockRequestApp.querySelector("[data-scm-stock-decision-reason]")?.focus();
}

async function scmStockDecision(decision, { lineIds, reason } = {}) {
  const label = decision === "reject" ? "Reject" : "Request Changes";
  const normalizedReason = String(reason || "").trim();
  if (!normalizedReason) throw new Error(`${label} requires a reason.`);
  const selectedLineIds = [...new Set((lineIds || []).map(Number))];
  if (!selectedLineIds.length) throw new Error("Select at least one stock-request line.");
  scmStockState.detail = await scmStockApi(`/api/scm/stock-requests/${scmStockState.detail.id}/line-decisions`, {
    method: "POST",
    body: JSON.stringify({
      expectedRevision: scmStockState.detail.revision,
      lineIds: selectedLineIds,
      decision,
      reason: normalizedReason
    })
  });
  scmStockState.pendingDecision = null;
  scmStockState.error = "";
  scmStockState.notice = decision === "reject"
    ? "Selected request line(s) were rejected."
    : "Changes were requested. Convert and Reject remain available until Sales submits a newer revision.";
  if (decision === "reject") {
    scmStockState.selectedLineIds.clear();
    scmStockState.queue = "rejected";
    localStorage.setItem("mbbs.scm.stockRequests.queue", "rejected");
  } else {
    scmStockState.selectedLineIds = new Set(selectedLineIds);
  }
  await scmStockLoad({ preserveSelection: decision !== "reject" });
}

function scmStockTransferPayload() {
  const transfer = scmStockSelectedTransfer();
  const lines = [...scmStockRequestApp.querySelectorAll("[data-scm-stock-transfer-line-id]")].map((container) => {
    const line = transfer.lines.find((candidate) => Number(candidate.id) === Number(container.dataset.scmStockTransferLineId));
    return { requestLineId: line.id, ...scmStockQuantityPayload(container, line) };
  });
  return {
    expectedRevision: transfer.revision,
    requestId: crypto.randomUUID(),
    palletQuantity: Number(scmStockRequestApp.querySelector("[data-scm-stock-pallet]").value),
    lines
  };
}

scmStockRequestApp.addEventListener("input", (event) => {
  if (!event.target.matches("[data-scm-stock-search]")) return;
  scmStockState.search = event.target.value;
  window.clearTimeout(scmStockState.refreshTimer);
  scmStockState.refreshTimer = window.setTimeout(() => scmStockLoad({ preserveSelection: false }).catch((error) => {
    scmStockState.loading = false;
    scmStockState.error = error.message;
    renderScmStockRequests();
  }), 350);
});

scmStockRequestApp.addEventListener("change", (event) => {
  if (event.target.matches("[data-scm-stock-filter]")) {
    scmStockState[event.target.dataset.scmStockFilter] = event.target.value;
    scmStockLoad({ preserveSelection: false }).catch((error) => {
      scmStockState.loading = false;
      scmStockState.error = error.message;
      renderScmStockRequests();
    });
    return;
  }
  if (!event.target.matches("[data-scm-stock-select-line]")) return;
  const line = scmStockLineElement(event.target);
  if (event.target.checked) scmStockState.selectedLineIds.add(line.id);
  else scmStockState.selectedLineIds.delete(line.id);
  renderScmStockRequests();
});

scmStockRequestApp.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-scm-stock-action]");
  if (!button || scmStockState.busy) return;
  const action = button.dataset.scmStockAction;
  try {
    if (action === "special") return window.MBBSSCMSpecialStock?.open({ operator: scmStockState.operator });
    if (action === "queue") {
      scmStockState.pendingDecision = null;
      scmStockState.queue = button.dataset.queue;
      localStorage.setItem("mbbs.scm.stockRequests.queue", scmStockState.queue);
      scmStockState.selectedLineIds.clear();
      scmStockState.selectedTransferId = null;
      return scmStockLoad({ preserveSelection: false });
    }
    if (action === "refresh") return scmStockLoad({ preserveSelection: true });
    if (action === "clear-filters") {
      scmStockState.vendorFilter = "";
      scmStockState.requestDateFilter = "";
      scmStockState.sourceLocationFilter = "";
      scmStockState.destinationLocationFilter = "";
      return scmStockLoad({ preserveSelection: false });
    }
    if (action === "select") {
      scmStockState.pendingDecision = null;
      scmStockState.selectedId = Number(button.dataset.id);
      localStorage.setItem("mbbs.scm.stockRequests.selected", String(scmStockState.selectedId));
      scmStockState.selectedLineIds.clear();
      await scmStockLoadDetail(scmStockState.selectedId);
      return renderScmStockRequests();
    }
    if (action === "select-transfer") {
      scmStockState.selectedTransferId = Number(button.dataset.transferId);
      return renderScmStockRequests();
    }
    if (action === "select-all") {
      scmStockState.selectedLineIds = new Set(scmStockState.detail.lines.filter((line) => ["submitted", "changes_requested"].includes(line.status)).map((line) => line.id));
      return renderScmStockRequests();
    }
    if (action === "save-line") return scmStockSaveLine(button);
    if (action === "request-changes") return scmStockOpenDecision("request_changes");
    if (action === "reject") return scmStockOpenDecision("reject");
    if (action === "cancel-decision") {
      scmStockState.pendingDecision = null;
      return renderScmStockRequests();
    }
    if (action === "confirm-decision") {
      const pending = scmStockState.pendingDecision;
      if (!pending) throw new Error("The SCM decision is no longer available. Open it again.");
      pending.reason = scmStockRequestApp.querySelector("[data-scm-stock-decision-reason]")?.value || "";
      scmStockState.busy = true;
      await scmStockDecision(pending.decision, pending);
      return;
    }
    if (action === "convert") {
      scmStockState.busy = true;
      renderScmStockRequests();
      await scmStockApi(`/api/scm/stock-requests/${scmStockState.detail.id}/convert`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision: scmStockState.detail.revision, lineIds: [...scmStockState.selectedLineIds] })
      });
      scmStockState.notice = "Selected request line(s) were converted to a local Pending TO. Any quantity above current availability is retained as backorder.";
      scmStockState.queue = "pending_to";
      localStorage.setItem("mbbs.scm.stockRequests.queue", "pending_to");
      scmStockState.selectedLineIds.clear();
      return scmStockLoad({ preserveSelection: true });
    }
    if (action === "save-transfer") {
      const transfer = scmStockSelectedTransfer();
      const result = await scmStockApi(`/api/scm/stock-transfers/${transfer.id}`, {
        method: "PATCH",
        body: JSON.stringify(scmStockTransferPayload())
      });
      scmStockState.detail = await scmStockApi(`/api/scm/stock-requests/${result.transfer.requestId}`);
      scmStockState.notice = "TO quantities saved. Any quantity above current availability is retained as backorder.";
      return renderScmStockRequests();
    }
    if (action === "confirm-print") {
      const transfer = scmStockSelectedTransfer();
      if (!confirm(`Create/approve the real NetSuite TO for ${transfer.transferRef} and print its ticket to both source-yard printers?`)) return;
      scmStockState.busy = true;
      renderScmStockRequests();
      await scmStockApi(`/api/scm/stock-transfers/${transfer.id}/confirm-print`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision: transfer.revision, requestId: crypto.randomUUID() })
      });
      return scmStockLoad({ preserveSelection: true });
    }
    if (action === "reject-pending-to") {
      const transfer = scmStockSelectedTransfer();
      const reason = prompt("Reject Pending TO reason (required):", "");
      if (reason === null) return;
      if (!reason.trim()) throw new Error("Reject Pending TO requires a reason.");
      if (!confirm(`Reject ${transfer.transferRef} before NetSuite confirmation and release its reservation?`)) return;
      const result = await scmStockApi(`/api/scm/stock-transfers/${transfer.id}/reject`, {
        method: "POST",
        body: JSON.stringify({
          expectedRevision: transfer.revision,
          expectedRequestRevision: scmStockState.detail.revision,
          reason
        })
      });
      scmStockState.selectedId = result.request.id;
      scmStockState.queue = "rejected";
      scmStockState.notice = `${transfer.transferRef} was rejected before confirmation.`;
      localStorage.setItem("mbbs.scm.stockRequests.queue", "rejected");
      return scmStockLoad({ preserveSelection: true });
    }
    if (action === "reprint") {
      const transfer = scmStockSelectedTransfer();
      if (!confirm(`Re-print the current ${transfer.netsuiteTransferOrderRef} ticket to both source-yard printers?`)) return;
      await scmStockApi(`/api/scm/stock-transfers/${transfer.id}/reprint`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision: transfer.revision, requestId: crypto.randomUUID() })
      });
      return scmStockLoad({ preserveSelection: true });
    }
  } catch (error) {
    scmStockState.error = error.message;
    renderScmStockRequests();
  } finally {
    scmStockState.busy = false;
  }
});

function scmStockConnectEvents() {
  if (!("EventSource" in window) || scmStockState.eventSource) return;
  scmStockState.eventSource = new EventSource("/api/events?client=scm-stock-requests");
  scmStockState.eventSource.addEventListener("app-event", (message) => {
    let event;
    try { event = JSON.parse(message.data || "{}"); } catch { return; }
    if (event.type !== "stock-request.updated" && event.type !== "dispatch.orders.updated" && event.type !== "driver.job.completed") return;
    window.clearTimeout(scmStockState.refreshTimer);
    scmStockState.refreshTimer = window.setTimeout(() => scmStockLoad({ preserveSelection: true }).catch(() => {}), 400);
  });
}

window.addEventListener("mbbs-language-changed", renderScmStockRequests);
window.addEventListener("pagehide", () => {
  scmStockState.eventSource?.close();
  scmStockState.eventSource = null;
});

requireDispatchLogin({
  mount: scmStockRequestApp,
  roles: ["admin", "scm", "scm_staff"],
  async onReady(operator) {
    scmStockState.operator = operator;
    try {
      await scmStockLoad({ preserveSelection: true });
      scmStockConnectEvents();
    } catch (error) {
      scmStockState.loading = false;
      scmStockState.error = error.message;
      renderScmStockRequests();
    }
  }
});

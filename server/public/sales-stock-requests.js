const salesStockRequestApp = document.getElementById("salesStockRequestApp");
const salesStockT = (key, fallback) => window.MBBS_I18N?.t(key, fallback) || fallback;
const salesStockTf = (key, fallback, variables) => window.MBBS_I18N?.format(key, fallback, variables) || fallback;
const salesStockMessage = (value) => window.MBBS_I18N?.message(value) || String(value || "");

const salesStockState = {
  operator: null,
  yards: [],
  bucket: localStorage.getItem("mbbs.sales.stockRequests.bucket") || "pending",
  search: "",
  vendorFilter: "",
  requestDateFilter: "",
  sourceLocationFilter: "",
  filterOptions: { vendors: [], sourceYards: [] },
  allowOverAvailability: false,
  availabilityGateRevision: null,
  requests: [],
  selectedId: Number(localStorage.getItem("mbbs.sales.stockRequests.selected")) || null,
  detail: null,
  composer: null,
  suggestions: new Map(),
  loading: true,
  saving: false,
  error: "",
  eventSource: null,
  refreshTimer: null,
  refreshPending: false,
  dataSignature: "",
  loadGeneration: 0
};

function salesStockEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}

function salesStockDate(value) {
  if (!value) return "—";
  return window.MBBS_I18N?.displayDateTime?.(value) || String(value);
}

function salesStockNumber(value) {
  const number = Number(value);
  const locale = window.MBBS_I18N?.language?.() === "zh-CN" ? "zh-CN" : "en-CA";
  return Number.isFinite(number) ? new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(number) : "0";
}

function salesStockStatusLabel(value) {
  const status = String(value || "unknown").trim().toLowerCase();
  if (status === "pending") return salesStockT("salesStock.status.pending", "Pending");
  if (status === "accepted") return salesStockT("salesStock.status.accepted", "Accepted");
  if (status === "completed") return salesStockT("salesStock.status.completed", "Completed");
  if (status === "submitted") return salesStockT("salesStock.status.submitted", "Submitted");
  if (status === "changes_requested") return salesStockT("salesStock.status.changesRequested", "Request Change");
  if (status === "converted") return salesStockT("salesStock.status.converted", "Converted");
  if (status === "rejected") return salesStockT("salesStock.status.rejected", "Rejected");
  if (status === "received") return salesStockT("salesStock.status.received", "Received");
  if (status === "cancelled") return salesStockT("salesStock.status.cancelled", "Cancelled");
  if (status === "closed") return salesStockT("salesStock.status.closed", "Closed");
  if (status === "pending_local") return salesStockT("salesStock.status.pendingLocal", "Pending local");
  if (status === "creating") return salesStockT("salesStock.status.creating", "Creating");
  if (status === "pending_approval") return salesStockT("salesStock.status.pendingApproval", "Pending approval");
  if (status === "pending_fulfillment") return salesStockT("salesStock.status.pendingFulfillment", "Pending fulfillment");
  if (status === "partially_fulfilled") return salesStockT("salesStock.status.partiallyFulfilled", "Partially fulfilled");
  if (status === "pending_receipt") return salesStockT("salesStock.status.pendingReceipt", "Pending receipt");
  if (status === "attention") return salesStockT("salesStock.status.attention", "Attention");
  return window.MBBS_I18N?.language?.() === "zh-CN"
    ? salesStockT("salesStock.status.unknown", "Unknown")
    : status.replaceAll("_", " ");
}

function salesStockEventLabel(value) {
  const eventType = String(value || "").trim().toLowerCase();
  if (eventType === "request_submitted") return salesStockT("salesStock.event.requestSubmitted", "Request submitted");
  if (eventType === "request_edited") return salesStockT("salesStock.event.requestEdited", "Request edited");
  if (eventType === "request_cancelled") return salesStockT("salesStock.event.requestCancelled", "Request cancelled");
  if (eventType === "request_resubmitted") return salesStockT("salesStock.event.requestResubmitted", "Request resubmitted");
  if (eventType === "line_adjusted_by_scm") return salesStockT("salesStock.event.lineAdjusted", "Line adjusted by SCM");
  if (eventType === "local_transfer_created") return salesStockT("salesStock.event.localTransferCreated", "Local transfer created");
  if (eventType === "pending_transfer_rejected") return salesStockT("salesStock.event.pendingTransferRejected", "Pending transfer rejected");
  if (eventType === "netsuite_transfer_linked") return salesStockT("salesStock.event.netsuiteTransferLinked", "NetSuite transfer linked");
  if (eventType === "netsuite_transfer_approved") return salesStockT("salesStock.event.netsuiteTransferApproved", "NetSuite transfer approved");
  if (eventType === "netsuite_transfer_webhook") return salesStockT("salesStock.event.netsuiteTransferUpdated", "NetSuite transfer updated");
  if (eventType === "transfer_confirmation_attention") return salesStockT("salesStock.event.confirmationAttention", "Transfer confirmation needs attention");
  if (eventType === "transfer_print_queued") return salesStockT("salesStock.event.printQueued", "Transfer print queued");
  if (eventType === "transfer_print_requested") return salesStockT("salesStock.event.printRequested", "Transfer re-print requested");
  if (eventType === "transfer_quantities_revised") return salesStockT("salesStock.event.quantitiesRevised", "Transfer quantities revised");
  return window.MBBS_I18N?.language?.() === "zh-CN"
    ? salesStockT("salesStock.event.update", "Update")
    : eventType.replaceAll("_", " ");
}

function salesStockPill(status, label = "") {
  const normalized = String(status || "unknown").trim().toLowerCase();
  return `<span class="stock-request-pill ${salesStockEscape(normalized)}">${salesStockEscape(label || salesStockStatusLabel(normalized))}</span>`;
}

function salesStockRequestNeedsAttention(request) {
  return (request?.lines || []).some((line) => line.status === "changes_requested");
}

function salesStockAvailabilityEquivalents(item, yard) {
  return [
    ["PLT", item?.toPlt],
    ["LYR", item?.toLyr],
    ["SEC", item?.toSec],
    ["PCS", item?.toPcs]
  ].filter(([, conversion]) => Number(conversion) > 0)
    .map(([label, conversion]) => `<span><strong>${salesStockNumber(Number(yard.requestableAvailable) / Number(conversion))}</strong> ${label}</span>`)
    .join("");
}

function salesStockAvailabilityCard(item, yard) {
  const equivalents = salesStockAvailabilityEquivalents(item, yard);
  return `<article>
    <small>${salesStockEscape(yard.yardCode)}</small>
    <span class="stock-request-availability-primary"><small>${salesStockT("salesStock.availability.salesQuantity", "Sales quantity")}</small><strong>${salesStockNumber(yard.requestableAvailable)} ${salesStockEscape(item?.salesUom || "")}</strong></span>
    ${equivalents ? `<span class="stock-request-availability-equivalents">${equivalents}</span>` : ""}
    <small>${salesStockTf("salesStock.availability.balance", "{live} live − {reserved} reserved", {
      live: salesStockNumber(yard.liveAvailable),
      reserved: salesStockNumber(yard.activeReserved)
    })}</small>
  </article>`;
}

async function salesStockApi(path, options = {}) {
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

function salesStockHeader() {
  const operator = salesStockState.operator || {};
  return `<header class="dispatch-topbar">
    <div><p>${salesStockT("salesStock.eyebrow", "Sales · Regular Stock")}</p><h1>${salesStockT("salesStock.heading", "Request Stock")}</h1></div>
    <div class="topbar-language">${window.MBBS_I18N?.toggleHtml?.() || ""}</div>
    <div class="topbar-actions">
      <span class="dispatch-user">${salesStockEscape(operator.display_name || operator.username || "")}</span>
      <button onclick="location.href='/sales'" type="button">${salesStockT("salesStock.salesMenu", "Sales Menu")}</button>
      <button onclick="dispatchLogout()" type="button">${salesStockT("salesStock.logout", "Logout")}</button>
    </div>
  </header>`;
}

function salesStockLineCount(request) {
  return Array.isArray(request?.lines) ? request.lines.length : 0;
}

function salesStockList() {
  if (salesStockState.loading) return `<div class="stock-request-empty"><strong>${salesStockT("salesStock.loadingRequests", "Loading requests…")}</strong></div>`;
  if (!salesStockState.requests.length) {
    return `<div class="stock-request-empty"><strong>${salesStockTf("salesStock.noBucketRequests", "No {bucket} requests", {
      bucket: salesStockStatusLabel(salesStockState.bucket)
    })}</strong><span>${salesStockT("salesStock.authorizedYardsEmpty", "Requests for your authorized destination yard(s) will appear here.")}</span></div>`;
  }
  return salesStockState.requests.map((request) => `
    <button class="stock-request-card ${salesStockRequestNeedsAttention(request) ? "stock-request-card-attention" : ""} ${Number(request.id) === Number(salesStockState.selectedId) ? "selected" : ""}" data-sales-stock-action="select" data-id="${Number(request.id)}" type="button">
      <span class="stock-request-status-line"><strong>${salesStockEscape(request.requestRef)}</strong>${salesStockPill(salesStockRequestNeedsAttention(request) ? "changes_requested" : request.bucket || request.status)}</span>
      <span>${salesStockEscape(request.destinationName)} · ${salesStockTf("salesStock.lineCount", "{count} line(s)", { count: salesStockLineCount(request) })}</span>
      <small>${salesStockEscape(request.requestedByName || request.requestedBy || "")} · ${salesStockDate(request.updatedAt)}</small>
    </button>
  `).join("");
}

function salesStockTransferProgress(transfer) {
  const terminalStatus = transfer.status === "closed"
    ? [true, salesStockT("salesStock.progress.netsuiteClosed", "NetSuite closed")]
    : [
      transfer.status === "received" || Boolean(transfer.receivedAt),
      transfer.status === "received"
        ? salesStockT("salesStock.progress.netsuiteReceived", "NetSuite received")
        : salesStockT("salesStock.progress.receivingPending", "Receiving pending")
    ];
  const milestones = [
    [true, salesStockT("salesStock.status.accepted", "Accepted")],
    [Boolean(transfer.netsuiteTransferOrderId), transfer.netsuiteTransferOrderRef || salesStockT("salesStock.progress.netsuiteTo", "NetSuite TO")],
    [
      Boolean(transfer.printJobId),
      transfer.printStatus === "printed"
        ? salesStockT("salesStock.progress.printed", "Printed")
        : salesStockT("salesStock.progress.printQueued", "Print queued")
    ],
    [
      Boolean(transfer.dispatchPlanned),
      transfer.dispatchPlanned
        ? salesStockTf("salesStock.progress.dispatchValue", "Dispatch {value}", {
          value: transfer.dispatchPlanDate || salesStockT("salesStock.progress.planned", "planned")
        })
        : salesStockT("salesStock.progress.dispatchPending", "Dispatch pending")
    ],
    [
      Boolean(transfer.driverCompleted),
      transfer.driverCompleted
        ? salesStockT("salesStock.progress.driverCompleted", "Driver completed")
        : salesStockT("salesStock.progress.driverPending", "Driver pending")
    ],
    terminalStatus
  ];
  return `<div class="stock-request-status-line">${milestones.map(([done, label]) => `<span class="stock-request-pill ${done ? "completed" : ""}">${done ? "✓" : "○"} ${salesStockEscape(label)}</span>`).join("")}</div>`;
}

function salesStockDetail() {
  const request = salesStockState.detail;
  if (!request) {
    return `<div class="stock-request-empty"><strong>${salesStockT("salesStock.selectRequest", "Select a request")}</strong><span>${salesStockT("salesStock.selectRequestHelp", "Line decisions, Transfer Orders, dispatch, driver, and receiving milestones will appear here.")}</span></div>`;
  }
  const editableBeforeDecision = !request.firstScmDecisionAt && request.status === "submitted";
  const returnedLines = request.lines.filter((line) => line.status === "changes_requested");
  return `<div class="stock-request-heading">
      <div><h2>${salesStockEscape(request.requestRef)}</h2><p>${salesStockEscape(request.requestedByName || request.requestedBy || "")} · ${salesStockDate(request.createdAt)}</p></div>
      ${salesStockPill(request.bucket || request.status)}
    </div>
    <div class="stock-request-summary">
      <span><small>${salesStockT("salesStock.destination", "Destination")}</small><strong>${salesStockEscape(request.destinationName)}</strong></span>
      <span><small>${salesStockT("salesStock.revision", "Revision")}</small><strong>${Number(request.revision)}</strong></span>
      <span><small>${salesStockT("salesStock.lines", "Lines")}</small><strong>${request.lines.length}</strong></span>
      <span><small>${salesStockT("salesStock.lastUpdate", "Last update")}</small><strong>${salesStockDate(request.updatedAt)}</strong></span>
    </div>
    ${request.remarks ? `<div class="stock-request-notice"><strong>${salesStockT("salesStock.salesRemark", "Sales remark:")}</strong> ${salesStockEscape(request.remarks)}</div>` : ""}
    <div class="stock-request-actions">
      ${(editableBeforeDecision || returnedLines.length) ? `<button data-sales-stock-action="edit" type="button">${returnedLines.length ? salesStockT("salesStock.editReturnedLines", "Edit returned line(s)") : salesStockT("salesStock.editRequest", "Edit request")}</button>` : ""}
      ${returnedLines.length ? `<button class="primary" data-sales-stock-action="resubmit" type="button">${salesStockT("salesStock.resubmitReturned", "Resubmit returned lines")}</button>` : ""}
      ${editableBeforeDecision ? `<button class="danger" data-sales-stock-action="cancel" type="button">${salesStockT("salesStock.cancelRequest", "Cancel request")}</button>` : ""}
    </div>
    <section class="stock-request-section">
      <h3>${salesStockT("salesStock.requestedItems", "Requested items")}</h3>
      <div class="stock-request-lines">${request.lines.map((line) => `
        <article class="stock-request-line">
          <header><div><strong>${salesStockEscape(line.itemName)}</strong><div class="stock-request-muted">${salesStockEscape(line.itemDescription || "")}</div></div>${salesStockPill(line.status)}</header>
          <div class="stock-request-summary">
            <span><small>${salesStockT("salesStock.from", "From")}</small><strong>${salesStockEscape(line.sourceName)}</strong></span>
            <span><small>${salesStockT("salesStock.to", "To")}</small><strong>${salesStockEscape(line.destinationName)}</strong></span>
            <span><small>${salesStockT("salesStock.quantity", "Quantity")}</small><strong>${salesStockNumber(line.salesQty)} ${salesStockEscape(line.salesUom)}</strong></span>
            ${line.quantityMode === "conversion" ? `<span><small>${salesStockT("salesStock.entered", "Entered")}</small><strong>${salesStockNumber(line.pallets)} PLT · ${salesStockNumber(line.layers)} LYR · ${salesStockNumber(line.sections)} SEC · ${salesStockNumber(line.pieces)} PCS</strong></span>` : ""}
          </div>
          ${line.decisionReason ? `<div class="stock-request-notice"><strong>${salesStockT("salesStock.scmUpdate", "SCM update:")}</strong> ${salesStockEscape(line.decisionReason)}</div>` : ""}
        </article>
      `).join("")}</div>
    </section>
    ${request.transfers.length ? `<section class="stock-request-section"><h3>${salesStockT("salesStock.transferProgress", "Transfer Orders and delivery progress")}</h3><div class="stock-request-lines">${request.transfers.map((transfer) => `
      <article class="stock-request-line">
        <header><div><strong>${salesStockEscape(transfer.transferRef)}</strong><div class="stock-request-muted">${salesStockEscape(transfer.sourceName)} → ${salesStockEscape(transfer.destinationName)}</div></div>${salesStockPill(transfer.status)}</header>
        <div class="stock-request-summary">
          <span><small>${salesStockT("salesStock.progress.netsuiteTo", "NetSuite TO")}</small><strong>${salesStockEscape(transfer.netsuiteTransferOrderRef || salesStockT("salesStock.pendingConfirmation", "Pending confirmation"))}</strong></span>
          <span><small>${salesStockT("salesStock.truck", "Truck")}</small><strong>${salesStockEscape(transfer.dispatchTruckPlate || salesStockT("salesStock.notAssigned", "Not assigned"))}</strong></span>
          <span><small>${salesStockT("salesStock.load", "Load")}</small><strong>${salesStockEscape(transfer.dispatchLoadName || salesStockT("salesStock.notAssigned", "Not assigned"))}</strong></span>
          <span><small>${salesStockT("salesStock.palletItem", "PALLET item")}</small><strong>${salesStockNumber(transfer.palletQuantity)}</strong></span>
        </div>
        ${salesStockTransferProgress(transfer)}
      </article>`).join("")}</div></section>` : ""}
    ${request.events.length ? `<section class="stock-request-section"><h3>${salesStockT("salesStock.updates", "Updates")}</h3>${request.events.slice(0, 12).map((event) => `<div class="stock-request-event"><strong>${salesStockEscape(salesStockEventLabel(event.eventType))}</strong><small>${salesStockEscape(event.actorName)} · ${salesStockDate(event.createdAt)}</small></div>`).join("")}</section>` : ""}`;
}

function salesStockNewLine(overrides = {}) {
  return {
    key: crypto.randomUUID(),
    id: null,
    item: null,
    itemSearch: "",
    sourceLocationId: "",
    pallets: "",
    layers: "",
    sections: "",
    pieces: "",
    salesQty: "",
    availability: null,
    loadingAvailability: false,
    availabilityGeneration: 0,
    searchGeneration: 0,
    ...overrides
  };
}

function salesStockStartNew() {
  if (salesStockState.loading || !salesStockState.yards.length) return;
  salesStockState.composer = {
    requestId: null,
    expectedRevision: null,
    partial: false,
    remarks: "",
    destinationLocationId: String(salesStockState.yards[0]?.locationId || ""),
    lines: [salesStockNewLine()]
  };
  salesStockState.error = "";
  renderSalesStockRequests();
}

function salesStockSupportedDestinationLocationId(value) {
  const locationId = Number(value);
  return Number.isInteger(locationId)
    && salesStockState.yards.some((yard) => Number(yard.locationId) === locationId)
    ? locationId
    : null;
}

function salesStockReconcileNewComposerDestination() {
  const composer = salesStockState.composer;
  if (!composer || composer.requestId || salesStockSupportedDestinationLocationId(composer.destinationLocationId)) return;
  const destinationLocationId = salesStockSupportedDestinationLocationId(salesStockState.yards[0]?.locationId);
  if (!destinationLocationId) return;
  composer.destinationLocationId = String(destinationLocationId);
  for (const line of composer.lines || []) {
    if (Number(line.sourceLocationId) === destinationLocationId) line.sourceLocationId = "";
  }
}

function salesStockStartEdit() {
  const request = salesStockState.detail;
  if (!request) return;
  const partial = Boolean(request.firstScmDecisionAt);
  const sourceLines = partial ? request.lines.filter((line) => line.status === "changes_requested") : request.lines;
  salesStockState.composer = {
    requestId: request.id,
    expectedRevision: request.revision,
    partial,
    remarks: request.remarks || "",
    destinationLocationId: String(request.destinationLocationId),
    lines: sourceLines.map((line) => salesStockNewLine({
      id: line.id,
      item: {
        itemId: line.itemId,
        itemCode: line.itemName,
        displayName: line.itemName,
        description: line.itemDescription,
        salesUom: line.salesUom,
        toPlt: line.toPlt,
        toLyr: line.toLyr,
        toSec: line.toSec,
        toPcs: line.toPcs
      },
      itemSearch: line.itemName,
      sourceLocationId: String(line.sourceLocationId),
      pallets: line.pallets ?? "",
      layers: line.layers ?? "",
      sections: line.sections ?? "",
      pieces: line.pieces ?? "",
      salesQty: line.quantityMode === "sales" ? line.salesQty : "",
      availability: request.availability.find((entry) => Number(entry.item?.itemId) === Number(line.itemId)) || null
    }))
  };
  salesStockState.error = "";
  renderSalesStockRequests();
}

function salesStockYardOptions(line, destinationLocationId) {
  const yards = line.availability?.yards || [];
  return yards.filter((yard) => Number(yard.locationId) !== Number(destinationLocationId)).map((yard) => `
    <option value="${Number(yard.locationId)}" ${String(line.sourceLocationId) === String(yard.locationId) ? "selected" : ""}>
      ${salesStockEscape(yard.yardCode)} · ${salesStockTf("salesStock.availableQuantity", "{quantity} available", { quantity: salesStockNumber(yard.requestableAvailable) })}
    </option>
  `).join("");
}

function salesStockQuantityFields(line) {
  const item = line.item;
  if (!item) return "";
  const conversions = [
    ["pallets", "PLT", item.toPlt],
    ["layers", "LYR", item.toLyr],
    ["sections", "SEC", item.toSec],
    ["pieces", "PCS", item.toPcs]
  ].filter(([, , conversion]) => Number(conversion) > 0);
  if (!conversions.length) {
    return `<label><span>${salesStockTf("salesStock.salesQuantityWithUom", "Sales quantity ({uom})", { uom: salesStockEscape(item.salesUom || "UOM") })}</span><input data-sales-stock-field="salesQty" type="number" min="0" step="any" value="${salesStockEscape(line.salesQty)}" /></label>`;
  }
  return conversions.map(([field, label, conversion]) => `<label><span>${label} <small>× ${salesStockNumber(conversion)} ${salesStockEscape(item.salesUom)}</small></span><input data-sales-stock-field="${field}" type="number" min="0" step="${field === "layers" ? "1" : "any"}" value="${salesStockEscape(line[field])}" /></label>`).join("");
}

function salesStockComposerLine(line, index) {
  const suggestions = salesStockState.suggestions.get(line.key) || [];
  return `<article class="stock-request-line" data-sales-stock-line="${salesStockEscape(line.key)}">
    <header><strong>${salesStockTf("salesStock.lineNumber", "Line {number}", { number: index + 1 })}${line.id ? ` · #${Number(line.id)}` : ""}</strong>${salesStockState.composer.lines.length > 1 && !salesStockState.composer.partial ? `<button class="danger" data-sales-stock-action="remove-line" type="button">${salesStockT("salesStock.remove", "Remove")}</button>` : ""}</header>
    <div class="stock-request-line-fields">
      <label class="stock-request-item-search"><span>${salesStockT("salesStock.itemCode", "Item code")}</span><input data-sales-stock-field="itemSearch" type="search" autocomplete="off" value="${salesStockEscape(line.itemSearch)}" placeholder="${salesStockT("salesStock.itemSearchHint", "Type at least 2 characters")}" />
        ${suggestions.length ? `<div class="stock-request-suggestions">${suggestions.map((item) => `<button data-sales-stock-action="choose-item" data-item-id="${Number(item.itemId)}" type="button"><strong>${salesStockEscape(item.itemCode)}</strong><small>${salesStockEscape(item.description || item.displayName || "")}</small></button>`).join("")}</div>` : ""}
      </label>
      <label><span>${salesStockT("salesStock.requestFromYard", "Request from yard")}</span><select data-sales-stock-field="sourceLocationId" ${line.loadingAvailability || !line.item ? "disabled" : ""}><option value="">${line.loadingAvailability ? salesStockT("salesStock.refreshingYards", "Refreshing all yards…") : salesStockT("salesStock.selectSourceYard", "Select source yard")}</option>${salesStockYardOptions(line, salesStockState.composer.destinationLocationId)}</select></label>
      ${salesStockQuantityFields(line)}
    </div>
    ${line.availability ? `<div class="stock-request-availability">${line.availability.yards.map((yard) => salesStockAvailabilityCard(line.item, yard)).join("")}</div>` : ""}
  </article>`;
}

function salesStockComposer() {
  const composer = salesStockState.composer;
  const singleYard = salesStockState.yards.length === 1;
  const supportedDestinationLocationId = salesStockSupportedDestinationLocationId(composer.destinationLocationId);
  return `<div class="stock-request-heading"><div><h2>${composer.requestId ? salesStockT("salesStock.editTitle", "Edit stock request") : salesStockT("salesStock.newTitle", "New regular stock request")}</h2><p>${composer.partial ? salesStockT("salesStock.returnedOnly", "Only lines returned by SCM are unlocked.") : salesStockT("salesStock.multiLineHint", "One request can contain multiple independently sourced items.")}</p></div><button data-sales-stock-action="close-composer" type="button">${salesStockT("salesStock.close", "Close")}</button></div>
    <form class="stock-request-form" data-sales-stock-form>
      <div class="stock-request-form-head">
        <label><span>${salesStockT("salesStock.yourDestination", "Your destination yard")}</span><select data-sales-stock-destination ${singleYard || composer.partial ? "disabled" : ""}>${supportedDestinationLocationId ? "" : `<option value="" selected>${salesStockT("salesStock.selectDestinationYard", "Select destination yard")}</option>`}${salesStockState.yards.map((yard) => `<option value="${Number(yard.locationId)}" ${supportedDestinationLocationId === Number(yard.locationId) ? "selected" : ""}>${salesStockEscape(yard.yardCode)}</option>`).join("")}</select></label>
        <div class="stock-request-notice">${salesStockT("salesStock.availabilityNotice", "Availability is refreshed from NetSuite through the backend when an item is selected. Submitting does not reserve inventory; SCM conversion does.")}</div>
        ${salesStockState.allowOverAvailability ? `<div class="stock-request-notice stock-request-availability-override"><strong>${salesStockT("salesStock.overAvailabilityEnabled", "Admin override enabled:")}</strong> ${salesStockT("salesStock.overAvailabilityHelp", "You may request more than this yard currently has. SCM can convert the full requested quantity; the shortage will remain visible as a Transfer Order backorder.")}</div>` : ""}
      </div>
      <label class="stock-request-remark"><span>${salesStockT("salesStock.remarkOptional", "Request remark (optional)")}</span><textarea name="remarks" data-sales-stock-remarks maxlength="2000" rows="3" ${composer.partial ? "readonly" : ""}>${salesStockEscape(composer.remarks)}</textarea></label>
      <div class="stock-request-lines">${composer.lines.map(salesStockComposerLine).join("")}</div>
      <div class="stock-request-actions">
        ${composer.partial ? "" : `<button data-sales-stock-action="add-line" type="button">${salesStockT("salesStock.addLine", "Add another line")}</button>`}
        <button class="primary" type="submit" ${salesStockState.saving ? "disabled" : ""}>${salesStockState.saving ? salesStockT("salesStock.saving", "Saving…") : composer.requestId ? salesStockT("salesStock.saveChanges", "Save changes") : salesStockT("salesStock.submitRequest", "Submit request")}</button>
      </div>
    </form>`;
}

function salesStockFocusSnapshot() {
  const active = document.activeElement;
  if (!active || !salesStockRequestApp.contains(active)) return null;
  let selector = "";
  if (active.matches("[data-sales-stock-search]")) {
    selector = "[data-sales-stock-search]";
  } else if (active.matches("[data-sales-stock-remarks]")) {
    selector = "[data-sales-stock-remarks]";
  } else if (active.matches("[data-sales-stock-destination]")) {
    selector = "[data-sales-stock-destination]";
  } else if (active.matches("[data-sales-stock-field]")) {
    const line = active.closest("[data-sales-stock-line]");
    if (line) {
      selector = `[data-sales-stock-line="${CSS.escape(line.dataset.salesStockLine)}"] [data-sales-stock-field="${CSS.escape(active.dataset.salesStockField)}"]`;
    }
  }
  if (!selector) return null;
  return {
    selector,
    selectionStart: active.selectionStart,
    selectionEnd: active.selectionEnd
  };
}

function salesStockRestoreFocus(snapshot) {
  if (!snapshot) return;
  const input = salesStockRequestApp.querySelector(snapshot.selector);
  input?.focus();
  if (Number.isInteger(snapshot.selectionStart) && typeof input?.setSelectionRange === "function") {
    input.setSelectionRange(
      snapshot.selectionStart,
      Number.isInteger(snapshot.selectionEnd) ? snapshot.selectionEnd : snapshot.selectionStart
    );
  }
}

function salesStockScrollSnapshot() {
  return {
    list: salesStockRequestApp.querySelector(".stock-request-list")?.scrollTop || 0,
    detail: salesStockRequestApp.querySelector(".stock-request-detail")?.scrollTop || 0
  };
}

function salesStockRestoreScroll(snapshot) {
  if (!snapshot) return;
  const list = salesStockRequestApp.querySelector(".stock-request-list");
  const detail = salesStockRequestApp.querySelector(".stock-request-detail");
  if (list) list.scrollTop = snapshot.list;
  if (detail) detail.scrollTop = snapshot.detail;
}

function salesStockYardFilterOptions() {
  return (salesStockState.filterOptions.sourceYards || []).map((yard) => `<option value="${Number(yard.locationId)}" ${String(salesStockState.sourceLocationFilter) === String(yard.locationId) ? "selected" : ""}>${salesStockEscape(yard.yardCode)}</option>`).join("");
}

function salesStockVendorFilterOptions() {
  return (salesStockState.filterOptions.vendors || []).map((vendor) => `<option value="${salesStockEscape(vendor)}" ${salesStockState.vendorFilter === vendor ? "selected" : ""}>${salesStockEscape(vendor)}</option>`).join("");
}

function renderSalesStockRequests() {
  const focusSnapshot = salesStockFocusSnapshot();
  const scrollSnapshot = salesStockScrollSnapshot();
  const navigationDisabled = salesStockState.composer ? "disabled" : "";
  document.title = salesStockT("salesStock.title", "MBBS Sales Request Stock");
  salesStockRequestApp.innerHTML = `${salesStockHeader()}
    <section class="stock-request-page">
      <div class="stock-request-tabs" role="tablist" aria-label="${salesStockT("salesStock.requestType", "Stock request type")}">
        <button aria-selected="true" type="button">${salesStockT("salesStock.regular", "Regular")}</button>
        <button data-sales-stock-action="special" type="button" ${navigationDisabled}>${salesStockT("salesStock.special", "Special")}</button>
      </div>
      <div class="stock-request-toolbar">
        <div class="stock-request-tabs" role="tablist" aria-label="${salesStockT("salesStock.regularStatus", "Regular request status")}">
          ${["pending", "accepted", "completed"].map((bucket) => `<button data-sales-stock-action="bucket" data-bucket="${bucket}" aria-selected="${salesStockState.bucket === bucket}" type="button" ${navigationDisabled}>${salesStockStatusLabel(bucket)}</button>`).join("")}
        </div>
        <div class="stock-request-actions"><input class="stock-request-search" data-sales-stock-search type="search" value="${salesStockEscape(salesStockState.search)}" placeholder="${salesStockT("salesStock.searchPlaceholder", "Search request or item")}" ${navigationDisabled} /><button class="primary" data-sales-stock-action="new" type="button" ${salesStockState.loading || !salesStockState.yards.length || salesStockState.composer ? "disabled" : ""}>${salesStockT("salesStock.newRequest", "New request")}</button><button data-sales-stock-action="refresh" type="button" ${navigationDisabled}>${salesStockT("salesStock.refresh", "Refresh")}</button></div>
        <div class="stock-request-filters">
          <label><span>${salesStockT("salesStock.itemVendor", "Item vendor")}</span><select name="vendor" data-sales-stock-filter="vendorFilter" ${navigationDisabled}><option value="">${salesStockT("salesStock.allVendors", "All vendors")}</option>${salesStockVendorFilterOptions()}</select></label>
          <label><span>${salesStockT("salesStock.requestDate", "Request date")}</span><input name="requestDate" data-sales-stock-filter="requestDateFilter" type="date" value="${salesStockEscape(salesStockState.requestDateFilter)}" ${navigationDisabled} /></label>
          <label><span>${salesStockT("salesStock.fromYard", "From yard")}</span><select name="sourceLocationId" data-sales-stock-filter="sourceLocationFilter" ${navigationDisabled}><option value="">${salesStockT("salesStock.allSourceYards", "All source yards")}</option>${salesStockYardFilterOptions()}</select></label>
          <button data-sales-stock-action="clear-filters" type="button" ${navigationDisabled}>${salesStockT("salesStock.clearFilters", "Clear filters")}</button>
        </div>
      </div>
      <div class="stock-request-feedback">
        ${salesStockState.error ? `<div class="stock-request-notice stock-request-error">${salesStockEscape(salesStockMessage(salesStockState.error))}</div>` : ""}
      </div>
      <div class="stock-request-workspace">
        <aside class="stock-request-panel stock-request-list">${salesStockList()}</aside>
        <section class="stock-request-panel stock-request-detail">${salesStockState.composer ? salesStockComposer() : salesStockDetail()}</section>
      </div>
    </section>`;
  salesStockRestoreFocus(focusSnapshot);
  salesStockRestoreScroll(scrollSnapshot);
}

async function salesStockLoadDetail(id) {
  if (!id) {
    salesStockState.detail = null;
    return;
  }
  const generation = ++salesStockState.loadGeneration;
  const detail = await salesStockApi(`/api/sales/stock-requests/${encodeURIComponent(id)}`);
  if (generation !== salesStockState.loadGeneration) return;
  salesStockState.detail = detail;
}

async function salesStockLoad({ preserveSelection = true, background = false } = {}) {
  if (salesStockState.composer) {
    salesStockState.refreshPending = true;
    return false;
  }
  const generation = ++salesStockState.loadGeneration;
  if (!background) {
    salesStockState.loading = true;
    renderSalesStockRequests();
  }
  const params = new URLSearchParams({ bucket: salesStockState.bucket, limit: "100" });
  if (salesStockState.search.trim()) params.set("search", salesStockState.search.trim());
  if (salesStockState.vendorFilter) params.set("vendor", salesStockState.vendorFilter);
  if (salesStockState.requestDateFilter) params.set("requestDate", salesStockState.requestDateFilter);
  if (salesStockState.sourceLocationFilter) params.set("sourceLocationId", salesStockState.sourceLocationFilter);
  const payload = await salesStockApi(`/api/sales/stock-requests?${params}`);
  if (generation !== salesStockState.loadGeneration) return;
  const requests = payload.requests || [];
  let selectedId = salesStockState.selectedId;
  if (!preserveSelection || !requests.some((request) => Number(request.id) === Number(selectedId))) {
    selectedId = requests[0]?.id || null;
  }
  const detail = selectedId
    ? await salesStockApi(`/api/sales/stock-requests/${encodeURIComponent(selectedId)}`)
    : null;
  if (generation !== salesStockState.loadGeneration) return;
  const filterOptions = payload.filterOptions || { vendors: [], sourceYards: [] };
  const allowOverAvailability = payload.allowOverAvailability === true;
  const availabilityGateRevision = payload.revision === null || payload.revision === undefined
    ? null
    : Number(payload.revision);
  const dataSignature = JSON.stringify({
    yards: payload.yards || [],
    filterOptions,
    allowOverAvailability,
    availabilityGateRevision,
    requests,
    selectedId,
    detail
  });
  if (salesStockState.composer) {
    const destinationBeforeYardRefresh = salesStockSupportedDestinationLocationId(
      salesStockState.composer.destinationLocationId
    );
    salesStockState.yards = payload.yards || [];
    salesStockState.filterOptions = filterOptions;
    salesStockState.allowOverAvailability = allowOverAvailability;
    salesStockState.availabilityGateRevision = availabilityGateRevision;
    salesStockState.requests = requests;
    salesStockState.selectedId = selectedId;
    salesStockState.detail = detail;
    salesStockState.dataSignature = dataSignature;
    if (selectedId) localStorage.setItem("mbbs.sales.stockRequests.selected", String(selectedId));
    salesStockReconcileNewComposerDestination();
    const destinationAfterYardRefresh = salesStockSupportedDestinationLocationId(
      salesStockState.composer.destinationLocationId
    );
    salesStockState.loading = false;
    salesStockState.refreshPending = true;
    if (destinationBeforeYardRefresh !== destinationAfterYardRefresh) renderSalesStockRequests();
    return false;
  }
  const dataChanged = dataSignature !== salesStockState.dataSignature;
  salesStockState.yards = payload.yards || [];
  salesStockReconcileNewComposerDestination();
  salesStockState.filterOptions = filterOptions;
  salesStockState.allowOverAvailability = allowOverAvailability;
  salesStockState.availabilityGateRevision = availabilityGateRevision;
  salesStockState.requests = requests;
  salesStockState.selectedId = selectedId;
  salesStockState.detail = detail;
  salesStockState.dataSignature = dataSignature;
  salesStockState.refreshPending = false;
  if (selectedId) localStorage.setItem("mbbs.sales.stockRequests.selected", String(selectedId));
  salesStockState.loading = false;
  salesStockState.error = "";
  if (!background || dataChanged) renderSalesStockRequests();
  return dataChanged;
}

function salesStockComposerLineElement(target) {
  const element = target.closest("[data-sales-stock-line]");
  if (!element || !salesStockState.composer) return null;
  return salesStockState.composer.lines.find((line) => line.key === element.dataset.salesStockLine) || null;
}

async function salesStockSearchItems(line, generation = line.searchGeneration) {
  const term = String(line.itemSearch || "").trim();
  if (term.length < 2) {
    if (generation !== line.searchGeneration) return;
    if (salesStockState.suggestions.delete(line.key)) renderSalesStockRequests();
    return;
  }
  try {
    const payload = await salesStockApi(`/api/sales/stock-request-items?search=${encodeURIComponent(term)}&limit=20`);
    if (generation !== line.searchGeneration
        || String(line.itemSearch || "").trim() !== term
        || !salesStockState.composer?.lines.includes(line)) return;
    salesStockState.suggestions.set(line.key, payload.items || []);
    renderSalesStockRequests();
  } catch (error) {
    if (generation !== line.searchGeneration || !salesStockState.composer?.lines.includes(line)) return;
    salesStockState.error = error.message;
    renderSalesStockRequests();
  }
}

async function salesStockChooseItem(line, itemId) {
  const item = (salesStockState.suggestions.get(line.key) || []).find((candidate) => Number(candidate.itemId) === Number(itemId));
  if (!item) return;
  const composer = salesStockState.composer;
  const availabilityGeneration = Number(line.availabilityGeneration || 0) + 1;
  line.availabilityGeneration = availabilityGeneration;
  const isCurrentSelection = () => salesStockState.composer === composer
    && composer?.lines.includes(line)
    && line.availabilityGeneration === availabilityGeneration;
  line.item = item;
  line.itemSearch = item.itemCode;
  line.searchGeneration = Number(line.searchGeneration || 0) + 1;
  window.clearTimeout(line.searchTimer);
  line.loadingAvailability = true;
  salesStockState.suggestions.delete(line.key);
  renderSalesStockRequests();
  try {
    const availability = await salesStockApi(`/api/sales/stock-request-items/${Number(item.itemId)}/availability/refresh`, { method: "POST" });
    if (!isCurrentSelection()) return;
    line.item = availability.item;
    line.itemSearch = availability.item.itemCode;
    line.availability = availability;
    const candidates = availability.yards.filter((yard) => Number(yard.locationId) !== Number(salesStockState.composer.destinationLocationId));
    if (!candidates.some((yard) => String(yard.locationId) === String(line.sourceLocationId))) {
      line.sourceLocationId = String(candidates.sort((left, right) => Number(right.requestableAvailable) - Number(left.requestableAvailable))[0]?.locationId || "");
    }
  } catch (error) {
    if (!isCurrentSelection()) return;
    salesStockState.error = error.message;
    line.availability = null;
  } finally {
    if (isCurrentSelection()) {
      line.loadingAvailability = false;
      renderSalesStockRequests();
    }
  }
}

function salesStockLinePayload(line) {
  if (!line.item?.itemId) throw new Error("Select an item on every request line.");
  if (!line.sourceLocationId) throw new Error(`Select a source yard for ${line.item.itemCode}.`);
  const conversions = [line.item.toPlt, line.item.toLyr, line.item.toSec, line.item.toPcs].some((value) => Number(value) > 0);
  const payload = {
    ...(line.id ? { id: line.id } : {}),
    itemId: Number(line.item.itemId),
    sourceLocationId: Number(line.sourceLocationId)
  };
  if (conversions) {
    for (const field of ["pallets", "layers", "sections", "pieces"]) {
      if (String(line[field]).trim() !== "") payload[field] = Number(line[field]);
    }
  } else {
    payload.salesQty = Number(line.salesQty);
  }
  return payload;
}

async function salesStockSaveComposer() {
  const composer = salesStockState.composer;
  const visibleDestinationLocationId = salesStockRequestApp.querySelector("[data-sales-stock-destination]")?.value;
  if (visibleDestinationLocationId !== undefined) composer.destinationLocationId = visibleDestinationLocationId;
  salesStockState.error = "";
  salesStockState.saving = true;
  renderSalesStockRequests();
  try {
    const destinationLocationId = salesStockSupportedDestinationLocationId(composer.destinationLocationId);
    if (!destinationLocationId) throw new Error("Select a valid supported destination yard.");
    const body = {
      destinationLocationId,
      remarks: composer.remarks,
      lines: composer.lines.map(salesStockLinePayload),
      ...(composer.requestId ? { expectedRevision: composer.expectedRevision } : {})
    };
    const saved = composer.requestId
      ? await salesStockApi(`/api/sales/stock-requests/${composer.requestId}`, { method: "PATCH", body: JSON.stringify(body) })
      : await salesStockApi("/api/sales/stock-requests", { method: "POST", body: JSON.stringify(body) });
    salesStockState.selectedId = saved.id;
    salesStockState.composer = null;
    salesStockState.suggestions.clear();
    salesStockState.refreshPending = false;
    window.clearTimeout(salesStockState.refreshTimer);
    await salesStockLoad({ preserveSelection: true });
  } catch (error) {
    salesStockState.loading = false;
    salesStockState.error = error.message;
  } finally {
    salesStockState.saving = false;
    if (salesStockState.composer || salesStockState.error) {
      renderSalesStockRequests();
    } else if (salesStockState.refreshPending) {
      salesStockState.refreshPending = false;
      await salesStockLoad({ preserveSelection: true, background: true });
    }
  }
}

salesStockRequestApp.addEventListener("input", (event) => {
  if (event.target.matches("[data-sales-stock-search]")) {
    salesStockState.search = event.target.value;
    window.clearTimeout(salesStockState.refreshTimer);
    salesStockState.refreshTimer = window.setTimeout(() => salesStockLoad({ preserveSelection: false }).catch((error) => {
      salesStockState.loading = false;
      salesStockState.error = error.message;
      renderSalesStockRequests();
    }), 350);
    return;
  }
  if (event.target.matches("[data-sales-stock-remarks]") && salesStockState.composer) {
    salesStockState.composer.remarks = event.target.value;
    return;
  }
  const line = salesStockComposerLineElement(event.target);
  const field = event.target.dataset.salesStockField;
  if (!line || !field) return;
  line[field] = event.target.value;
  if (field === "itemSearch") {
    if (line.item && line.item.itemCode !== line.itemSearch) {
      line.availabilityGeneration = Number(line.availabilityGeneration || 0) + 1;
      line.loadingAvailability = false;
      line.item = null;
      line.availability = null;
      line.sourceLocationId = "";
    }
    window.clearTimeout(line.searchTimer);
    line.searchGeneration = Number(line.searchGeneration || 0) + 1;
    const searchGeneration = line.searchGeneration;
    line.searchTimer = window.setTimeout(() => salesStockSearchItems(line, searchGeneration), 250);
  }
});

salesStockRequestApp.addEventListener("change", (event) => {
  if (event.target.matches("[data-sales-stock-filter]")) {
    salesStockState[event.target.dataset.salesStockFilter] = event.target.value;
    salesStockLoad({ preserveSelection: false }).catch((error) => {
      salesStockState.loading = false;
      salesStockState.error = error.message;
      renderSalesStockRequests();
    });
    return;
  }
  if (event.target.matches("[data-sales-stock-destination]")) {
    salesStockState.composer.destinationLocationId = event.target.value;
    for (const line of salesStockState.composer.lines) {
      if (String(line.sourceLocationId) === String(event.target.value)) line.sourceLocationId = "";
    }
    renderSalesStockRequests();
    return;
  }
  const line = salesStockComposerLineElement(event.target);
  if (line && event.target.dataset.salesStockField) line[event.target.dataset.salesStockField] = event.target.value;
});

salesStockRequestApp.addEventListener("submit", (event) => {
  if (!event.target.matches("[data-sales-stock-form]")) return;
  event.preventDefault();
  salesStockSaveComposer();
});

salesStockRequestApp.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-sales-stock-action]");
  if (!button) return;
  const action = button.dataset.salesStockAction;
  try {
    if (action === "special") return window.MBBSSalesSpecialStock?.open({
      operator: salesStockState.operator,
      yards: salesStockState.yards
    });
    if (action === "new") return salesStockStartNew();
    if (action === "close-composer") {
      const refreshPending = salesStockState.refreshPending;
      salesStockState.composer = null;
      salesStockState.suggestions.clear();
      salesStockState.refreshPending = false;
      renderSalesStockRequests();
      if (refreshPending) await salesStockLoad({ preserveSelection: true, background: true });
      return;
    }
    if (action === "add-line") {
      salesStockState.composer.lines.push(salesStockNewLine());
      return renderSalesStockRequests();
    }
    if (action === "remove-line") {
      const line = salesStockComposerLineElement(button);
      salesStockState.composer.lines = salesStockState.composer.lines.filter((candidate) => candidate.key !== line.key);
      return renderSalesStockRequests();
    }
    if (action === "choose-item") return salesStockChooseItem(salesStockComposerLineElement(button), button.dataset.itemId);
    if (action === "bucket") {
      salesStockState.bucket = button.dataset.bucket;
      localStorage.setItem("mbbs.sales.stockRequests.bucket", salesStockState.bucket);
      salesStockState.composer = null;
      return salesStockLoad({ preserveSelection: false });
    }
    if (action === "refresh") return salesStockLoad({ preserveSelection: true });
    if (action === "clear-filters") {
      salesStockState.vendorFilter = "";
      salesStockState.requestDateFilter = "";
      salesStockState.sourceLocationFilter = "";
      return salesStockLoad({ preserveSelection: false });
    }
    if (action === "select") {
      salesStockState.selectedId = Number(button.dataset.id);
      localStorage.setItem("mbbs.sales.stockRequests.selected", String(salesStockState.selectedId));
      salesStockState.composer = null;
      await salesStockLoadDetail(salesStockState.selectedId);
      return renderSalesStockRequests();
    }
    if (action === "edit") return salesStockStartEdit();
    if (action === "cancel") {
      if (!confirm(salesStockTf("salesStock.confirmCancel", "Cancel {reference}?", {
        reference: salesStockState.detail.requestRef
      }))) return;
      await salesStockApi(`/api/sales/stock-requests/${salesStockState.detail.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision: salesStockState.detail.revision })
      });
      return salesStockLoad({ preserveSelection: false });
    }
    if (action === "resubmit") {
      await salesStockApi(`/api/sales/stock-requests/${salesStockState.detail.id}/resubmit`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision: salesStockState.detail.revision })
      });
      return salesStockLoad({ preserveSelection: true });
    }
  } catch (error) {
    salesStockState.error = error.message;
    renderSalesStockRequests();
  }
});

function salesStockConnectEvents() {
  if (!("EventSource" in window) || salesStockState.eventSource) return;
  salesStockState.eventSource = new EventSource("/api/events?client=sales-stock-requests");
  salesStockState.eventSource.addEventListener("app-event", (message) => {
    let event;
    try { event = JSON.parse(message.data || "{}"); } catch { return; }
    if (event.type !== "stock-request.updated" && event.type !== "dispatch.orders.updated" && event.type !== "driver.job.completed") return;
    if (salesStockState.composer || salesStockState.saving) {
      salesStockState.refreshPending = true;
      return;
    }
    window.clearTimeout(salesStockState.refreshTimer);
    salesStockState.refreshTimer = window.setTimeout(() => salesStockLoad({
      preserveSelection: true,
      background: true
    }).catch(() => {}), 400);
  });
}

window.addEventListener("mbbs-language-changed", renderSalesStockRequests);
window.addEventListener("pagehide", () => {
  salesStockState.eventSource?.close();
  salesStockState.eventSource = null;
});

requireDispatchLogin({
  mount: salesStockRequestApp,
  roles: ["sales", "admin"],
  allowPublicSales: false,
  async onReady(operator) {
    salesStockState.operator = operator;
    try {
      await salesStockLoad({ preserveSelection: true });
      salesStockConnectEvents();
    } catch (error) {
      salesStockState.loading = false;
      salesStockState.error = error.message;
      renderSalesStockRequests();
    }
  }
});

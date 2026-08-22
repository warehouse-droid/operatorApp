const scmToPrintingApp = document.getElementById("scmToPrintingApp");
let scmToPrintOperator = null;
let scmToPrintPrinters = [];
let scmToPrintOrders = [];
let scmToPrintJobs = [];
let scmToPrintSearch = "";
let scmToPrintSourceYard = "";
let scmToPrintBusy = "";
let scmToPrintNotice = "";
let scmToPrintError = "";
let scmToPrintSearchTimer = null;
let scmToPrintRemoteTimer = null;
let scmToPrintEventSource = null;
let scmToPrintPreview = null;
let scmToPrintHistory = null;

function scmToPrintEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}

function scmToPrintDate(value) {
  if (!value) return "—";
  return window.MBBS_I18N?.displayDateTime?.(value) || String(value);
}

function scmToPrintOrderDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return value ? String(value) : "—";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${match[1]}-${months[Number(match[2]) - 1] || match[2]}-${match[3]}`;
}

function scmToPrintQuantity(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number)
    ? number.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 4 })
    : String(value);
}

function scmToPrintItemDetails(order = {}) {
  const lines = Array.isArray(order.itemLines) ? order.itemLines : [];
  if (!lines.length) return `<div class="sales-item-line"><span>${scmToPrintEscape(order.items || "—")}</span><strong>—</strong></div>`;
  return lines.map((line) => {
    const unit = String(line.unit || "").trim();
    return `<div class="sales-item-line" title="${scmToPrintEscape(line.itemName || "Item")}">
      <span>${scmToPrintEscape(line.itemName || line.sku || "Item")}</span>
      <strong>${scmToPrintEscape(scmToPrintQuantity(line.quantity))}${unit ? ` ${scmToPrintEscape(unit)}` : ""}</strong>
    </div>`;
  }).join("");
}

async function scmToPrintApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
  if (!response.ok) throw new Error(payload.error || text || "Request failed.");
  return payload;
}

async function scmToPrintPdf(path) {
  const response = await fetch(path, { headers: { Accept: "application/pdf" } });
  if (!response.ok) {
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
    throw new Error(payload.error || text || "The picking-ticket snapshot could not load.");
  }
  return {
    blob: await response.blob(),
    previewToken: response.headers.get("x-mbbs-print-preview-token") || "",
    printerYard: response.headers.get("x-mbbs-print-yard") || "",
    sourceYard: response.headers.get("x-mbbs-source-yard") || ""
  };
}

function scmToPrinter(locationId) {
  const resolved = Number(locationId) === 14 ? 1 : Number(locationId);
  return scmToPrintPrinters.find((printer) => Number(printer.locationId) === resolved) || null;
}

function scmToPrintRequestId() {
  return `scm-to-printing:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function scmToPrintOrderRows() {
  return scmToPrintOrders.map((order) => {
    const printer = scmToPrinter(order.sourceLocationId);
    const source = order.sourceLocation || printer?.yardCode || "Unknown";
    const previewDisabled = !order.printable || !order.sourceLocationId || scmToPrintBusy;
    return `<tr>
      <td><strong>${scmToPrintEscape(order.orderRef)}</strong><br><small>#${scmToPrintEscape(order.orderId)}</small></td>
      <td class="sales-order-date">${scmToPrintEscape(scmToPrintOrderDate(order.orderDate))}</td>
      <td><strong>${scmToPrintEscape(source)}</strong></td>
      <td><strong>${scmToPrintEscape(order.destinationLocation || "—")}</strong></td>
      <td>${scmToPrintEscape(order.statusText || order.status || "—")}</td>
      <td class="items"><div class="sales-item-scroll">${scmToPrintItemDetails(order)}</div></td>
      <td>${scmToPrintEscape(order.lineCount)}</td>
      <td><div class="sales-print-action"><div class="sales-print-action-buttons">
        <button class="primary" data-action="preview-to" data-order-id="${scmToPrintEscape(order.orderId)}" data-order-ref="${scmToPrintEscape(order.orderRef)}" type="button" ${previewDisabled ? "disabled" : ""}>${scmToPrintBusy === `preview:${order.orderId}` ? "Loading…" : "Preview"}</button>
        <button data-action="history-to" data-order-id="${scmToPrintEscape(order.orderId)}" data-order-ref="${scmToPrintEscape(order.orderRef)}" type="button" ${scmToPrintBusy ? "disabled" : ""}>History${order.printHistoryCount ? ` (${scmToPrintEscape(order.printHistoryCount)})` : ""}</button>
      </div></div></td>
    </tr>`;
  }).join("") || `<tr><td colspan="8">No Transfer Orders match this search and source-yard scope.</td></tr>`;
}

function scmToPrintJobCards() {
  return scmToPrintJobs.map((job) => `<article class="sales-print-job-card">
    <header><strong>#${scmToPrintEscape(job.jobId)} · ${scmToPrintEscape(job.orderRef || "TO")}</strong><span class="sales-status-pill ${scmToPrintEscape(job.status)}">${scmToPrintEscape(job.status)}</span></header>
    <div>${scmToPrintEscape(job.sourceModule)} · ${scmToPrintEscape(job.sourceYardCode || job.printerYardCode || "—")}</div>
    <small>${scmToPrintDate(job.requestedAt)} · ${scmToPrintEscape(job.printerNames.join(" + ") || job.printerName || "No printer")}</small>
    ${job.lastError ? `<p>${scmToPrintEscape(job.lastError)}</p>` : ""}
  </article>`).join("") || `<div class="sales-print-jobs-empty">No Transfer Order print jobs are available.</div>`;
}

function scmToPrintHistoryModal() {
  if (!scmToPrintHistory) return "";
  const rows = (scmToPrintHistory.history || []).map((entry) => `<tr>
    <td>#${scmToPrintEscape(entry.jobId)}</td>
    <td><strong>${scmToPrintEscape(entry.sourceModule)}</strong></td>
    <td><strong>${scmToPrintEscape(entry.requestedBy)}</strong><br><small>${scmToPrintDate(entry.requestedAt)}</small>${entry.requestedIpAddress ? `<br><small>IP: ${scmToPrintEscape(entry.requestedIpAddress)}</small>` : ""}</td>
    <td>${scmToPrintEscape(entry.sourceYardCode || "—")}</td>
    <td><strong>${scmToPrintEscape(entry.printerYardCode || "—")}</strong><br><small>${scmToPrintEscape(entry.printerNames.join(" + ") || entry.printerName || "")}</small></td>
    <td><span class="sales-status-pill ${scmToPrintEscape(entry.status)}">${scmToPrintEscape(entry.status)}</span>${entry.printedAt ? `<br><small>Printed ${scmToPrintDate(entry.printedAt)}</small>` : ""}${entry.lastError ? `<br><small class="sales-history-error">${scmToPrintEscape(entry.lastError)}</small>` : ""}</td>
    <td><button data-action="view-snapshot" data-order-id="${scmToPrintEscape(entry.orderId || scmToPrintHistory.order.orderId)}" data-job-id="${scmToPrintEscape(entry.jobId)}" data-order-ref="${scmToPrintEscape(entry.orderRef || scmToPrintHistory.order.orderRef)}" data-source-yard="${scmToPrintEscape(entry.sourceYardCode)}" data-printer-yard="${scmToPrintEscape(entry.printerYardCode)}" data-requested-by="${scmToPrintEscape(entry.requestedBy)}" data-requested-at="${scmToPrintEscape(entry.requestedAt)}" type="button" ${scmToPrintBusy ? "disabled" : ""}>View snapshot</button></td>
  </tr>`).join("") || `<tr><td colspan="7">This Transfer Order has no tracked picking-ticket history.</td></tr>`;
  return `<div class="sales-preview-backdrop" data-action="close-history-backdrop">
    <section class="sales-history-dialog" role="dialog" aria-modal="true" aria-label="Transfer Order print history">
      <header><div><p>All-module picking-ticket history</p><h2>${scmToPrintEscape(scmToPrintHistory.order.orderRef)}</h2><span>Includes TO Printing, Smart SCM, Auto Transfer, and Stock Requests.</span></div><button data-action="close-history" type="button">Close</button></header>
      <div class="sales-table-wrap"><table class="sales-table"><thead><tr><th>Job</th><th>Module</th><th>Requester / when</th><th>Source yard</th><th>Printers</th><th>Result</th><th>Snapshot</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>
  </div>`;
}

function scmToPrintPreviewModal() {
  if (!scmToPrintPreview) return "";
  const printer = scmToPrinter(scmToPrintPreview.printerLocationId);
  const ready = printer?.transferOrderReady === true;
  const snapshotOnly = Boolean(scmToPrintPreview.snapshotOnly);
  const printerNames = Array.isArray(printer?.transferOrderPrinterNames)
    ? printer.transferOrderPrinterNames.join(" + ")
    : "";
  return `<div class="sales-preview-backdrop" data-action="close-preview-backdrop">
    <section class="sales-preview-dialog" role="dialog" aria-modal="true" aria-label="Transfer Order picking ticket preview">
      <header><div><p>${snapshotOnly ? "Historical ticket snapshot" : "Picking ticket preview"}</p><h2>${scmToPrintEscape(scmToPrintPreview.orderRef)}</h2><span>Source: <strong>${scmToPrintEscape(scmToPrintPreview.sourceYard || "—")}</strong> · Destination: <strong>${scmToPrintEscape(scmToPrintPreview.destinationYard || "—")}</strong></span>${snapshotOnly ? `<small>Requested by ${scmToPrintEscape(scmToPrintPreview.requestedBy || "—")} · ${scmToPrintDate(scmToPrintPreview.requestedAt)}</small>` : `<small>Two copies: ${scmToPrintEscape(printerNames || "TO printers are not ready")}</small>`}</div><button data-action="close-preview" type="button">Close</button></header>
      <iframe src="${scmToPrintEscape(scmToPrintPreview.objectUrl)}" title="${scmToPrintEscape(scmToPrintPreview.orderRef)} picking ticket"></iframe>
      <footer>${scmToPrintError ? `<span class="sales-preview-error" role="alert">${scmToPrintEscape(scmToPrintError)}</span>` : ""}${snapshotOnly || ready ? "" : `<span class="sales-preview-warning">${scmToPrintEscape(printer?.yardCode || scmToPrintPreview.sourceYard || "Source yard")} needs an enabled queue, agent token, and two TO printers.</span>`}<button data-action="close-preview" type="button">${snapshotOnly ? "Close" : "Cancel"}</button>${snapshotOnly ? "" : `<button class="primary" data-action="queue-preview" type="button" ${ready && !scmToPrintBusy ? "" : "disabled"}>${scmToPrintBusy === "queue-preview" ? "Queuing…" : "Print to both TO printers"}</button>`}</footer>
    </section>
  </div>`;
}

function renderScmToPrinting() {
  const operator = scmToPrintOperator || {};
  const yardOptions = scmToPrintPrinters.map((printer) => `<option value="${scmToPrintEscape(printer.locationId)}" ${String(printer.locationId) === scmToPrintSourceYard ? "selected" : ""}>${scmToPrintEscape(printer.yardCode)}</option>`).join("");
  scmToPrintingApp.innerHTML = `<header class="dispatch-topbar">
    <div><p>SCM</p><h1>Transfer Order Printing</h1></div>
    <div class="topbar-language">${window.MBBS_I18N?.toggleHtml?.() || ""}</div>
    <div class="topbar-actions"><span class="dispatch-user">${scmToPrintEscape(operator.display_name || operator.username || "")}</span><button onclick="location.href='/scm'" type="button">SCM Menu</button><button onclick="dispatchLogout()" type="button">Logout</button></div>
  </header>
  <section class="sales-printing-page">
    ${scmToPrintError && !scmToPrintPreview ? `<div class="route-notice"><span>${scmToPrintEscape(scmToPrintError)}</span></div>` : ""}
    ${scmToPrintNotice ? `<div class="route-notice"><span>${scmToPrintEscape(scmToPrintNotice)}</span></div>` : ""}
    <div class="sales-print-columns">
      <section class="panel sales-print-orders-panel">
        <div class="sales-section-head"><div><h2>Transfer Orders</h2><p>Pending Fulfillment TOs are shown by default. Search also finds older TOs so their complete printing history remains available.</p></div></div>
        <div class="sales-print-toolbar"><input data-to-print-search type="search" value="${scmToPrintEscape(scmToPrintSearch)}" placeholder="Search TO, source, destination, item, or SKU" autocomplete="off" /><select data-to-print-yard><option value="">All source yards</option>${yardOptions}</select><button data-action="refresh" type="button" ${scmToPrintBusy ? "disabled" : ""}>Refresh</button></div>
        <div class="sales-table-wrap sales-order-table-wrap"><table class="sales-table sales-order-print-table"><thead><tr><th>Transfer Order</th><th>Date</th><th>Source</th><th>Destination</th><th>Status</th><th>Item Details</th><th>Lines</th><th>Preview / History</th></tr></thead><tbody>${scmToPrintOrderRows()}</tbody></table></div>
      </section>
      <aside class="panel sales-print-jobs-panel"><div class="sales-section-head"><div><h2>Recent TO print jobs</h2><p>Shared history from every module that printed a TO ticket.</p></div></div><div class="sales-print-job-list">${scmToPrintJobCards()}</div></aside>
    </div>
  </section>${scmToPrintHistoryModal()}${scmToPrintPreviewModal()}`;
}

function closeScmToPrintPreview() {
  if (scmToPrintPreview?.objectUrl) URL.revokeObjectURL(scmToPrintPreview.objectUrl);
  scmToPrintPreview = null;
}

function captureScmToPrintSearchFocus() {
  const input = document.activeElement;
  if (!input?.matches?.("[data-to-print-search]")) return null;
  return {
    start: input.selectionStart,
    end: input.selectionEnd,
    direction: input.selectionDirection
  };
}

function restoreScmToPrintSearchFocus(focus) {
  if (!focus) return;
  const input = scmToPrintingApp.querySelector("[data-to-print-search]");
  if (!input) return;
  input.focus({ preventScroll: true });
  const length = input.value.length;
  input.setSelectionRange(
    Math.min(focus.start ?? length, length),
    Math.min(focus.end ?? length, length),
    focus.direction || "none"
  );
}

async function loadScmToPrinting({ quiet = false } = {}) {
  if (!quiet) { scmToPrintBusy = "loading"; renderScmToPrinting(); }
  scmToPrintError = "";
  try {
    const params = new URLSearchParams({ limit: "1000" });
    if (scmToPrintSearch.trim()) params.set("search", scmToPrintSearch.trim());
    if (scmToPrintSourceYard) params.set("sourceLocationId", scmToPrintSourceYard);
    const [printers, orders, jobs] = await Promise.all([
      scmToPrintApi("/api/scm/to-printing/printers"),
      scmToPrintApi(`/api/scm/to-printing/transfer-orders?${params}`),
      scmToPrintApi("/api/scm/to-printing/print-jobs?limit=200")
    ]);
    scmToPrintPrinters = printers;
    scmToPrintOrders = orders;
    scmToPrintJobs = jobs;
  } catch (error) {
    scmToPrintError = error.message;
  } finally {
    scmToPrintBusy = "";
    const searchFocus = quiet ? captureScmToPrintSearchFocus() : null;
    renderScmToPrinting();
    restoreScmToPrintSearchFocus(searchFocus);
  }
}

scmToPrintingApp.addEventListener("input", (event) => {
  if (!event.target.matches("[data-to-print-search]")) return;
  scmToPrintSearch = event.target.value || "";
  clearTimeout(scmToPrintSearchTimer);
  scmToPrintSearchTimer = setTimeout(() => loadScmToPrinting({ quiet: true }), 350);
});

scmToPrintingApp.addEventListener("change", (event) => {
  if (!event.target.matches("[data-to-print-yard]")) return;
  scmToPrintSourceYard = event.target.value || "";
  loadScmToPrinting({ quiet: true });
});

scmToPrintingApp.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "close-preview-backdrop" && event.target !== button) return;
  if (action === "close-history-backdrop" && event.target !== button) return;
  if (["close-preview", "close-preview-backdrop"].includes(action)) {
    closeScmToPrintPreview();
    scmToPrintError = "";
    renderScmToPrinting();
    return;
  }
  if (["close-history", "close-history-backdrop"].includes(action)) {
    scmToPrintHistory = null;
    renderScmToPrinting();
    return;
  }
  if (scmToPrintBusy) return;
  if (action === "refresh") return loadScmToPrinting();
  if (action === "history-to") {
    scmToPrintBusy = `history:${button.dataset.orderId}`;
    scmToPrintError = "";
    renderScmToPrinting();
    try {
      scmToPrintHistory = await scmToPrintApi(`/api/scm/to-printing/transfer-orders/${encodeURIComponent(button.dataset.orderId)}/print-history`);
    } catch (error) {
      scmToPrintError = error.message;
    } finally {
      scmToPrintBusy = "";
      renderScmToPrinting();
    }
    return;
  }
  if (action === "view-snapshot") {
    scmToPrintBusy = `snapshot:${button.dataset.jobId}`;
    scmToPrintError = "";
    renderScmToPrinting();
    try {
      const { blob } = await scmToPrintPdf(`/api/scm/to-printing/transfer-orders/${encodeURIComponent(button.dataset.orderId)}/print-history/${encodeURIComponent(button.dataset.jobId)}/snapshot`);
      closeScmToPrintPreview();
      scmToPrintHistory = null;
      scmToPrintPreview = {
        snapshotOnly: true,
        orderRef: button.dataset.orderRef,
        sourceYard: button.dataset.sourceYard,
        printerYard: button.dataset.printerYard,
        requestedBy: button.dataset.requestedBy,
        requestedAt: button.dataset.requestedAt,
        objectUrl: URL.createObjectURL(blob)
      };
    } catch (error) {
      scmToPrintError = error.message;
    } finally {
      scmToPrintBusy = "";
      renderScmToPrinting();
    }
    return;
  }
  if (action === "preview-to") {
    const orderId = String(button.dataset.orderId || "");
    const order = scmToPrintOrders.find((entry) => String(entry.orderId) === orderId);
    if (!order?.printable) return;
    scmToPrintBusy = `preview:${orderId}`;
    scmToPrintError = "";
    scmToPrintNotice = "";
    renderScmToPrinting();
    try {
      const { blob, previewToken, printerYard, sourceYard } = await scmToPrintPdf(`/api/scm/to-printing/transfer-orders/${encodeURIComponent(orderId)}/picking-ticket-preview`);
      closeScmToPrintPreview();
      scmToPrintPreview = {
        snapshotOnly: false,
        orderId,
        orderRef: order.orderRef,
        sourceYard: sourceYard || order.sourceLocation,
        destinationYard: order.destinationLocation,
        printerLocationId: order.sourceLocationId,
        printerYard,
        previewToken,
        requestId: scmToPrintRequestId(),
        objectUrl: URL.createObjectURL(blob)
      };
    } catch (error) {
      scmToPrintError = error.message;
    } finally {
      scmToPrintBusy = "";
      renderScmToPrinting();
    }
    return;
  }
  if (action !== "queue-preview" || !scmToPrintPreview || scmToPrintPreview.snapshotOnly) return;
  const preview = { ...scmToPrintPreview };
  scmToPrintBusy = "queue-preview";
  scmToPrintError = "";
  scmToPrintNotice = "";
  renderScmToPrinting();
  try {
    const result = await scmToPrintApi(`/api/scm/to-printing/transfer-orders/${encodeURIComponent(preview.orderId)}/print`, {
      method: "POST",
      body: JSON.stringify({
        previewToken: preview.previewToken,
        requestId: preview.requestId,
        audit: { sessionId: sessionStorage.getItem("mbbs.dispatch.sessionId") || "" }
      })
    });
    closeScmToPrintPreview();
    const printers = Array.isArray(result?.printer?.printerNames) ? result.printer.printerNames.join(" + ") : "both TO printers";
    scmToPrintNotice = `${result.order.orderRef} queued as print job #${result.printJob.id} at ${result.printer.yardCode} (${printers}).`;
    await loadScmToPrinting({ quiet: true });
  } catch (error) {
    scmToPrintError = error.message;
  } finally {
    scmToPrintBusy = "";
    renderScmToPrinting();
  }
});

function connectScmToPrintEvents() {
  if (scmToPrintEventSource) return;
  scmToPrintEventSource = new EventSource("/api/events?client=scm-to-printing");
  scmToPrintEventSource.addEventListener("app-event", (message) => {
    let event;
    try { event = JSON.parse(message.data || "{}"); } catch { return; }
    if (!["scm.to_printing.updated", "scm.smart.updated", "scm.transfer_dependency.updated", "stock-request.updated"].includes(event.type)) return;
    clearTimeout(scmToPrintRemoteTimer);
    scmToPrintRemoteTimer = setTimeout(() => loadScmToPrinting({ quiet: true }), 300);
  });
}

window.addEventListener("beforeunload", () => {
  closeScmToPrintPreview();
  scmToPrintEventSource?.close();
});
window.addEventListener("mbbs-language-changed", renderScmToPrinting);
requireDispatchLogin({
  mount: scmToPrintingApp,
  roles: ["admin", "scm", "scm_staff"],
  async onReady(operator) {
    scmToPrintOperator = operator;
    renderScmToPrinting();
    await loadScmToPrinting();
    connectScmToPrintEvents();
  }
});

const salesApp = document.getElementById("salesApp");
const salesT = (key, fallback) => window.MBBS_I18N?.t(key, fallback) || fallback;
const SALES_RETURNS_PAGE = window.location.pathname === "/sales/returns";
const SALES_YARDS = [
  { locationId: 1, yardCode: "3445" },
  { locationId: 28, yardCode: "2967" },
  { locationId: 15, yardCode: "12441" },
  { locationId: 26, yardCode: "150" }
];
let salesOperator = null;
let salesReturnRecords = [];
let salesReturnCounts = {};
let salesReturnDetail = null;
let salesReturnError = "";
let salesReturnSelectedId = localStorage.getItem("mbbs.sales.returns.selected") || "";
const SALES_RETURN_PAGE_SIZE = 100;
let salesReturnOffset = 0;
let salesReturnFilters = {
  search: localStorage.getItem("mbbs.sales.returns.search") || "",
  status: localStorage.getItem("mbbs.sales.returns.status") || "",
  type: localStorage.getItem("mbbs.sales.returns.type") || "",
  yardLocationId: localStorage.getItem("mbbs.sales.returns.yard") || "",
  from: localStorage.getItem("mbbs.sales.returns.from") || "",
  to: localStorage.getItem("mbbs.sales.returns.to") || ""
};

function salesEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}

function salesRoles(operator) {
  return new Set([...(operator?.roles || []), operator?.role].map((role) => String(role || "").trim().toLowerCase()));
}

function salesYardCodes(operator) {
  if (salesRoles(operator).has("admin")) return SALES_YARDS.map((yard) => yard.yardCode);
  const allowed = new Set((operator?.yardLocationIds || []).map(Number));
  return SALES_YARDS.filter((yard) => allowed.has(yard.locationId)).map((yard) => yard.yardCode);
}

function salesFirst(object, keys, fallback = "") {
  for (const key of keys) {
    if (object?.[key] !== undefined && object?.[key] !== null) return object[key];
  }
  return fallback;
}

function salesReturnId(record) {
  return String(salesFirst(record, ["id", "returnId", "return_id"], ""));
}

function salesReturnReference(record) {
  return String(salesFirst(record, [
    "reference",
    "returnReference",
    "return_reference",
    "localReference",
    "local_reference",
    "stockReturnReference",
    "stock_return_reference",
    "palletReturnReference",
    "pallet_return_reference"
  ], salesReturnId(record) ? `Return #${salesReturnId(record)}` : "Return"));
}

function salesReturnStatus(record) {
  const syncStatus = String(salesFirst(record, ["netSuiteSyncStatus", "netsuite_sync_status"], "")).toLowerCase();
  if (syncStatus === "failed") {
    return salesReturnType(record) === "pallet" ? "credit_memo_creation_failed" : "ra_creation_failed";
  }
  return String(salesFirst(record, ["status", "returnStatus", "return_status", "approvalStatus", "approval_status"], "unknown"))
    .trim()
    .toLowerCase()
    .replaceAll(" ", "_")
    .replaceAll("-", "_");
}

function salesReturnStatusLabel(recordOrStatus) {
  const status = typeof recordOrStatus === "string" ? recordOrStatus : salesReturnStatus(recordOrStatus);
  const labels = {
    accepted: "Accepted",
    pending_approval: "Pending Approval",
    partially_pending: "Partially Pending Approval",
    partially_pending_approval: "Partially Pending Approval",
    approved: "Approved",
    rejected: "Rejected",
    partially_rejected: "Partially Rejected",
    voided: "Voided",
    ra_creation_failed: "RA Creation Failed",
    credit_memo_creation_failed: "Credit Memo Creation Failed",
    sync_failed: "NetSuite Sync Failed",
    synced: "Synced",
    linked: "Linked",
    not_required: "Accepted"
  };
  return labels[status] || String(status || "Unknown").replaceAll("_", " ");
}

function salesReturnStatusPill(recordOrStatus) {
  const status = typeof recordOrStatus === "string" ? recordOrStatus : salesReturnStatus(recordOrStatus);
  return `<span class="sales-return-status ${salesEscape(status)}">${salesEscape(salesReturnStatusLabel(status))}</span>`;
}

function salesReturnType(record) {
  const recordType = String(salesFirst(record, ["returnType", "return_type", "recordType", "record_type", "type"], "stock")).toLowerCase();
  const stockType = String(salesFirst(record, ["stockReturnType", "stock_return_type"], "")).toLowerCase();
  if (recordType.includes("pallet")) return "pallet";
  if (stockType.includes("quality") || recordType.includes("quality")) return "quality_stock";
  if (stockType.includes("normal") || recordType.includes("normal") || recordType.includes("good")) return "normal_stock";
  return recordType || "stock";
}

function salesReturnTypeLabel(record) {
  const type = salesReturnType(record);
  if (type === "pallet") return "PALLET Return";
  if (type === "quality_stock") return "Quality Stock Return";
  if (type === "normal_stock") return "Normal Stock Return";
  return String(type).replaceAll("_", " ");
}

function salesReturnMoney(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(number)
    : "—";
}

function salesReturnDate(value) {
  if (!value) return "—";
  return window.MBBS_I18N?.displayDateTime?.(value)
    || new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function salesReturnYard(record, prefix) {
  const code = salesFirst(record, [`${prefix}YardCode`, `${prefix}_yard_code`, `${prefix}LocationName`, `${prefix}_location_name`], "");
  const id = Number(salesFirst(record, [`${prefix}YardLocationId`, `${prefix}_yard_location_id`, `${prefix}LocationId`, `${prefix}_location_id`], 0));
  if (!code && !id && prefix === "ordering") return salesReturnYard(record, "receiving");
  return String(code || SALES_YARDS.find((yard) => yard.locationId === id)?.yardCode || id || "—");
}

function salesReturnPhotoRef(photo) {
  if (typeof photo === "string") return photo;
  return String(salesFirst(photo, [
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

function salesReturnPhotoImgAttributes(photo) {
  const ref = salesReturnPhotoRef(photo);
  if (!ref.startsWith("r2://")) return `src="${salesEscape(ref)}"`;
  return `data-secure-photo-ref="${salesEscape(ref)}"`;
}

function salesReleaseSecurePhotoImage(image) {
  if (!image) return;
  image._securePhotoController?.abort();
  image._securePhotoController = null;
  if (image._securePhotoObjectUrl) URL.revokeObjectURL(image._securePhotoObjectUrl);
  image._securePhotoObjectUrl = "";
}

function salesReleaseSecurePhotoImages(root = salesApp) {
  if (!root) return;
  const images = [
    ...(root.matches?.("img[data-secure-photo-ref]") ? [root] : []),
    ...root.querySelectorAll("img[data-secure-photo-ref]")
  ];
  images.forEach(salesReleaseSecurePhotoImage);
}

async function salesHydrateSecurePhotoImage(image) {
  const ref = String(image?.dataset?.securePhotoRef || "");
  if (!ref || image.dataset.securePhotoState === "loading" || image.dataset.securePhotoState === "loaded") return;
  const controller = new AbortController();
  image._securePhotoController = controller;
  image.dataset.securePhotoState = "loading";
  try {
    const response = await fetch(`/api/photo-upload/preview?ref=${encodeURIComponent(ref)}`, {
      headers: dispatchAuthToken ? { Authorization: `Bearer ${dispatchAuthToken}` } : {},
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
    const release = () => salesReleaseSecurePhotoImage(image);
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

function salesHydrateSecurePhotoImages(root = salesApp) {
  root?.querySelectorAll("img[data-secure-photo-ref]").forEach((image) => {
    salesHydrateSecurePhotoImage(image);
  });
}

function salesSaveReturnFilters() {
  localStorage.setItem("mbbs.sales.returns.search", salesReturnFilters.search || "");
  localStorage.setItem("mbbs.sales.returns.status", salesReturnFilters.status || "");
  localStorage.setItem("mbbs.sales.returns.type", salesReturnFilters.type || "");
  localStorage.setItem("mbbs.sales.returns.yard", salesReturnFilters.yardLocationId || "");
  localStorage.setItem("mbbs.sales.returns.from", salesReturnFilters.from || "");
  localStorage.setItem("mbbs.sales.returns.to", salesReturnFilters.to || "");
}

function salesReturnQuery() {
  const params = new URLSearchParams({
    limit: String(SALES_RETURN_PAGE_SIZE),
    offset: String(salesReturnOffset)
  });
  for (const [key, value] of Object.entries(salesReturnFilters)) {
    if (String(value || "").trim()) params.set(key, String(value).trim());
  }
  return params;
}

async function salesReturnApi(url) {
  const response = await fetch(url);
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
  return payload;
}

async function salesLoadReturnDetail(id = salesReturnSelectedId) {
  salesReturnDetail = id ? await salesReturnApi(`/api/sales/returns/${encodeURIComponent(id)}`) : null;
}

async function salesLoadReturns({ keepSelection = true } = {}) {
  salesReturnError = "";
  try {
    const payload = await salesReturnApi(`/api/sales/returns?${salesReturnQuery()}`);
    salesReturnRecords = Array.isArray(payload) ? payload : (payload.records || payload.returns || []);
    salesReturnCounts = Array.isArray(payload) ? {} : (payload.counts || {});
    const available = new Set(salesReturnRecords.map(salesReturnId));
    if (!keepSelection || !available.has(String(salesReturnSelectedId))) {
      salesReturnSelectedId = salesReturnId(salesReturnRecords[0] || {});
    }
    if (salesReturnSelectedId) {
      localStorage.setItem("mbbs.sales.returns.selected", salesReturnSelectedId);
      await salesLoadReturnDetail();
    } else {
      salesReturnDetail = null;
    }
  } catch (error) {
    salesReturnError = error.message;
    salesReturnRecords = [];
    salesReturnCounts = {};
    salesReturnDetail = null;
  }
}

function renderSalesHeader(title, subtitle = "Sales") {
  const operator = salesOperator || {};
  return `<header class="dispatch-topbar">
    <div><p>${salesEscape(subtitle)}</p><h1>${salesEscape(title)}</h1></div>
    <div class="topbar-language">${window.MBBS_I18N?.toggleHtml?.() || ""}</div>
    <div class="topbar-actions">
      <span class="dispatch-user">${salesEscape(operator.display_name || operator.username || "")}</span>
      ${operator.publicSales ? "" : `<button onclick="dispatchLogout()" type="button">${salesT("common.logout", "Logout")}</button>`}
    </div>
  </header>`;
}

function renderSalesMenu() {
  const operator = salesOperator || {};
  const yards = salesYardCodes(operator);
  salesApp.innerHTML = `
    ${renderSalesHeader(salesT("sales.title", "Sales"), "MBBS Operation")}
    <section class="dispatch-menu-page">
      <div class="dispatch-menu-heading">
        <h2>${salesT("sales.menu", "Sales Menu")}</h2>
        <p>${operator.publicSales ? "Available" : "Authorized"} yards: ${salesEscape(yards.join(", ") || "None assigned")}</p>
      </div>
      ${yards.length ? "" : `<div class="route-notice"><span>No Sales yards are assigned to this account. Ask an administrator to update Account Management.</span></div>`}
      <div class="dispatch-menu-grid">
        ${operator.publicSales ? "" : `
          <button class="dispatch-menu-card primary-card" onclick="location.href='/sales/returns'" type="button">
            <strong>Return Records</strong><span>Review your store's submitted stock and PALLET returns, photos, approval status, and estimated or actual credits.</span>
          </button>
        `}
        <button class="dispatch-menu-card ${operator.publicSales ? "primary-card" : ""}" onclick="location.href='/sales/planning'" type="button">
          <strong>Dispatch Planning</strong><span>Review daily loads, routes, trucks, orders, and stops in permanent view-only mode.</span>
        </button>
        <button class="dispatch-menu-card" onclick="location.href='/sales/schedule'" type="button">
          <strong>PO / TO Schedule</strong><span>Review Yard Manager and Completed schedule views for your authorized yards.</span>
        </button>
        <button class="dispatch-menu-card" onclick="location.href='/sales/monitor'" type="button">
          <strong>Truck Monitor</strong><span>View live truck locations, active loads, and stop progress.</span>
        </button>
        <button class="dispatch-menu-card" onclick="location.href='/sales/printing'" type="button">
          <strong>Sales Order Printing</strong><span>Find Delivery orders by ordering location, preview the selected line-yard ticket, and review every stored print snapshot.</span>
        </button>
        ${operator.publicSales ? "" : `
          <button class="dispatch-menu-card" onclick="location.href='/sales/in-outbound-record'" type="button">
            <strong>${salesT("control.loadedExport", "In/Outbound Record")}</strong>
            <span>${salesT("control.loadedExportHelp", "Review yard processing, driver delivery timestamps, details, and photo proof.")}</span>
          </button>
        `}
      </div>
    </section>
  `;
}

function salesRenderReturnList() {
  if (salesReturnError) {
    return `<div class="sales-return-empty error"><strong>Return records could not be loaded</strong><span>${salesEscape(salesReturnError)}</span></div>`;
  }
  const cards = salesReturnRecords.map((record) => {
    const id = salesReturnId(record);
    const order = salesFirst(record, ["sourceSalesOrderRef", "source_sales_order_ref", "sourceOrderTranid", "source_order_tranid", "salesOrderTranid", "sales_order_tranid"], "");
    const customer = salesFirst(record, ["customerName", "customer_name", "customerCode", "customer_code"], "");
    const date = salesFirst(record, ["submittedAt", "submitted_at", "createdAt", "created_at"], "");
    const estimate = salesFirst(record, ["estimatedCreditAmount", "estimated_credit_amount", "estimatedCredit", "estimated_credit"], null);
    const actual = salesFirst(record, ["actualCreditAmount", "actual_credit_amount", "actualCredit", "actual_credit"], null);
    return `<button class="sales-return-card ${id === String(salesReturnSelectedId) ? "active" : ""}" data-sales-return-action="select" data-id="${salesEscape(id)}" type="button">
      <span class="sales-return-card-head"><strong>${salesEscape(salesReturnReference(record))}</strong>${salesReturnStatusPill(record)}</span>
      <span>${salesEscape(salesReturnTypeLabel(record))} · ${salesEscape(order || "Customer-level")}</span>
      <span>${salesEscape(customer || "—")}</span>
      <small>${salesEscape(salesReturnYard(record, "ordering"))} · ${salesReturnDate(date)} · ${salesReturnMoney(actual ?? estimate)}</small>
    </button>`;
  }).join("");
  if (!cards) return `<div class="sales-return-empty"><strong>No return records</strong><span>No submitted return matches your store scope and filters.</span></div>`;
  const total = Number(salesReturnCounts.total);
  const hasNext = Number.isFinite(total)
    ? salesReturnOffset + salesReturnRecords.length < total
    : salesReturnRecords.length === SALES_RETURN_PAGE_SIZE;
  return `${cards}
    <div class="sales-return-pagination">
      <button data-sales-return-action="page-prev" ${salesReturnOffset <= 0 ? "disabled" : ""} type="button">Previous</button>
      <span>${salesReturnOffset + 1}–${salesReturnOffset + salesReturnRecords.length}${Number.isFinite(total) ? ` of ${total}` : ""}</span>
      <button data-sales-return-action="page-next" ${hasNext ? "" : "disabled"} type="button">Next</button>
    </div>`;
}

function salesRenderReturnPhotos(photos, empty = "No photos attached") {
  const visible = (photos || []).filter((photo) => salesReturnPhotoRef(photo));
  if (!visible.length) return `<div class="sales-return-photo-empty">${salesEscape(empty)}</div>`;
  return `<div class="sales-return-photo-grid">${visible.map((photo, index) => {
    const label = salesFirst(photo, ["label", "caption", "kind", "photoKind", "photo_kind", "photoType", "photo_type"], `Return photo ${index + 1}`);
    const ref = salesReturnPhotoRef(photo);
    return `<figure>
      <button data-sales-return-action="photo" data-photo-ref="${salesEscape(ref)}" data-photo-label="${salesEscape(label)}" type="button">
        <img ${salesReturnPhotoImgAttributes(photo)} alt="${salesEscape(label)}" />
      </button>
      <figcaption>${salesEscape(label)}</figcaption>
    </figure>`;
  }).join("")}</div>`;
}

function salesReturnHeader() {
  return salesReturnDetail?.return || salesReturnDetail?.record || salesReturnDetail?.header || salesReturnDetail || {};
}

function salesReturnLines() {
  return salesReturnDetail?.lines || salesReturnDetail?.returnLines || salesReturnDetail?.return_lines || salesReturnDetail?.return?.lines || [];
}

function salesReturnPhotos() {
  return salesReturnDetail?.photos || salesReturnDetail?.returnPhotos || salesReturnDetail?.return_photos || salesReturnDetail?.return?.photos || [];
}

function salesReturnLinks() {
  const links = [...(salesReturnDetail?.netSuiteLinks || salesReturnDetail?.netsuiteLinks || salesReturnDetail?.net_suite_links || salesReturnDetail?.links || [])];
  const header = salesReturnHeader();
  const ref = salesFirst(header, ["netSuiteTransactionRef", "netsuite_transaction_ref"], "");
  const id = salesFirst(header, ["netSuiteTransactionId", "netsuite_transaction_id"], "");
  if ((ref || id) && !links.some((link) =>
    String(salesFirst(link, ["netsuiteId", "netsuite_id", "internalId", "internal_id"], "")) === String(id))) {
    links.push({
      transactionType: salesFirst(header, ["netSuiteStage", "netsuite_stage"], "transaction"),
      netsuiteTranid: ref,
      netsuiteId: id,
      status: salesFirst(header, ["netSuiteTransactionStatus", "netsuite_transaction_status"], "")
    });
  }
  const snapshot = header.netSuiteSnapshot || header.netsuite_snapshot
    || salesReturnDetail?.netSuiteSnapshot || salesReturnDetail?.netsuite_snapshot || {};
  for (const credit of snapshot.creditMemos || snapshot.credit_memos || []) {
    const creditId = credit.id || credit.internalId || credit.internal_id || "";
    if (links.some((link) =>
      String(salesFirst(link, ["netsuiteId", "netsuite_id", "internalId", "internal_id"], "")) === String(creditId))) continue;
    links.push({
      transactionType: "credit_memo",
      netsuiteTranid: credit.tranid || credit.tranId || "",
      netsuiteId: creditId,
      status: credit.statusText || credit.status_text || credit.status || ""
    });
  }
  return links;
}

function salesRenderReturnLine(line, index) {
  const item = salesFirst(line, ["itemName", "item_name", "sku", "itemId", "item_id"], `Line ${index + 1}`);
  const quantity = salesFirst(line, ["returnedSalesQuantity", "returned_sales_quantity", "salesQuantity", "sales_quantity", "quantity"], "");
  const uom = salesFirst(line, ["salesUom", "sales_uom", "uom"], "");
  const reason = salesFirst(line, ["reasonLabel", "reason_label", "reasonCodeLabel", "reason_code_label"], "");
  const note = salesFirst(line, ["note", "reasonNote", "reason_note"], "");
  const decisionNote = salesFirst(line, ["approvalNote", "approval_note", "decisionNote", "decision_note"], "");
  const decidedAt = salesFirst(line, ["decidedAt", "decided_at"], "");
  const photos = line.photos || line.returnPhotos || line.return_photos || [];
  return `<article class="sales-return-line">
    <header><div><strong>${salesEscape(item)}</strong><span>${salesEscape(`${quantity} ${uom}`.trim() || "—")}</span></div>${salesReturnStatusPill(line)}</header>
    <div class="sales-return-line-meta"><span><small>Reason</small><strong>${salesEscape(reason || "—")}</strong></span><span><small>Estimated credit</small><strong>${salesReturnMoney(salesFirst(line, ["estimatedCreditAmount", "estimated_credit_amount", "estimatedCredit", "estimated_credit"], null))}</strong></span></div>
    ${note ? `<p>${salesEscape(note)}</p>` : ""}
    ${decisionNote ? `<p><strong>${salesReturnStatus(line) === "rejected" ? "Rejection reason" : "Approval note"}:</strong> ${salesEscape(decisionNote)}${decidedAt ? ` · ${salesReturnDate(decidedAt)}` : ""}</p>` : ""}
    ${salesRenderReturnPhotos(photos, "No line photos")}
  </article>`;
}

function salesRenderReturnDetail() {
  if (!salesReturnDetail) {
    return `<div class="sales-return-empty detail"><strong>Select a return record</strong><span>Submitted quantities, reasons, photos, approval status, and financial values will appear here.</span></div>`;
  }
  const header = salesReturnHeader();
  const order = salesFirst(header, ["sourceSalesOrderRef", "source_sales_order_ref", "sourceOrderTranid", "source_order_tranid", "salesOrderTranid", "sales_order_tranid"], "");
  const customer = [salesFirst(header, ["customerCode", "customer_code"], ""), salesFirst(header, ["customerName", "customer_name"], "")].filter(Boolean).join(" · ");
  const batch = salesFirst(header, ["batchReference", "batch_reference"], "");
  const estimated = salesFirst(header, ["estimatedCreditAmount", "estimated_credit_amount", "estimatedCredit", "estimated_credit"], null);
  const actual = salesFirst(header, ["actualCreditAmount", "actual_credit_amount", "actualCredit", "actual_credit"], null);
  const palletQuantity = salesFirst(header, ["palletQuantity", "pallet_quantity"], null);
  const note = salesFirst(header, ["note", "returnNote", "return_note"], "");
  const links = salesReturnLinks();
  return `<div class="sales-return-detail">
    <header class="sales-return-detail-head">
      <div><div class="sales-return-title"><h2>${salesEscape(salesReturnReference(header))}</h2>${salesReturnStatusPill(header)}</div><p>${salesEscape(salesReturnTypeLabel(header))}${batch ? ` · ${salesEscape(batch)}` : ""}</p></div>
    </header>
    <div class="sales-return-summary">
      <span><small>Customer</small><strong>${salesEscape(customer || "—")}</strong></span>
      <span><small>Sales Order</small><strong>${salesEscape(order || "Customer-level")}</strong></span>
      <span><small>Ordering yard</small><strong>${salesEscape(salesReturnYard(header, "ordering"))}</strong></span>
      <span><small>Receiving yard</small><strong>${salesEscape(salesReturnYard(header, "receiving"))}</strong></span>
      <span><small>Vehicle plate</small><strong>${salesEscape(salesFirst(header, ["vehiclePlate", "vehicle_plate"], "—"))}</strong></span>
      ${palletQuantity !== null && palletQuantity !== undefined
        ? `<span><small>PALLET quantity</small><strong>${salesEscape(palletQuantity)}</strong></span>`
        : ""}
      <span><small>Submitted</small><strong>${salesReturnDate(salesFirst(header, ["submittedAt", "submitted_at", "createdAt", "created_at"], ""))}</strong></span>
      <span><small>Estimated credit</small><strong>${salesReturnMoney(estimated)}</strong></span>
      <span><small>Actual NetSuite credit</small><strong>${salesReturnMoney(actual)}</strong></span>
    </div>
    ${note ? `<p class="sales-return-note"><strong>Return note:</strong> ${salesEscape(note)}</p>` : ""}
    <section><div class="sales-return-subhead"><h3>Returned lines</h3><span>${salesReturnLines().length} line(s)</span></div><div class="sales-return-lines">${salesReturnLines().map(salesRenderReturnLine).join("") || `<div class="sales-return-empty"><span>No stock lines on this PALLET return.</span></div>`}</div></section>
    <section><div class="sales-return-subhead"><h3>Record photos</h3></div>${salesRenderReturnPhotos(salesReturnPhotos())}</section>
    <section><div class="sales-return-subhead"><h3>NetSuite</h3></div><div class="sales-return-links">${links.map((link) => {
      const status = salesFirst(link, ["status", "statusText", "status_text", "transactionStatus", "transaction_status"], "");
      return `<span><strong>${salesEscape(String(salesFirst(link, ["transactionType", "transaction_type"], "Transaction")).replaceAll("_", " "))}</strong>${salesEscape(salesFirst(link, ["netsuiteTranid", "netsuite_tranid", "tranid"], `Internal ID ${salesFirst(link, ["netsuiteId", "netsuite_id"], "—")}`))}${status ? ` · ${salesEscape(status)}` : ""}</span>`;
    }).join("") || `<span class="sales-return-muted">No NetSuite transaction linked.</span>`}</div></section>
  </div>`;
}

function renderSalesReturns() {
  const yards = salesYardCodes(salesOperator);
  salesReleaseSecurePhotoImages(salesApp);
  salesApp.innerHTML = `${renderSalesHeader("Return Records", "Sales · Read only")}
    <section class="sales-return-page">
      <div class="sales-return-page-head">
        <div><h2>Store Return Records</h2><p>Submitted records for ordering yard(s): ${salesEscape(yards.join(", ") || "None assigned")}. Drafts are not shown.</p></div>
        <button data-sales-return-action="refresh" type="button">Refresh</button>
      </div>
      <div class="sales-return-filters">
        <label><span>Search</span><input data-sales-return-filter="search" type="search" value="${salesEscape(salesReturnFilters.search)}" placeholder="SR / PR / RB / SO / customer / plate" /></label>
        <label><span>Status</span><select data-sales-return-filter="status"><option value="">All submitted statuses</option>${["pending_approval", "partially_pending", "partially_rejected", "accepted", "approved", "rejected", "voided", "sync_failed", "synced"].map((status) => `<option value="${status}" ${salesReturnFilters.status === status ? "selected" : ""}>${salesEscape(salesReturnStatusLabel(status))}</option>`).join("")}</select></label>
        <label><span>Type</span><select data-sales-return-filter="type"><option value="">Stock + PALLET</option><option value="normal_stock" ${salesReturnFilters.type === "normal_stock" ? "selected" : ""}>Normal Stock</option><option value="quality_stock" ${salesReturnFilters.type === "quality_stock" ? "selected" : ""}>Quality Stock</option><option value="pallet" ${salesReturnFilters.type === "pallet" ? "selected" : ""}>PALLET</option></select></label>
        <label><span>Ordering yard</span><select data-sales-return-filter="yardLocationId"><option value="">All authorized yards</option>${SALES_YARDS.filter((yard) => yards.includes(yard.yardCode)).map((yard) => `<option value="${yard.locationId}" ${String(salesReturnFilters.yardLocationId) === String(yard.locationId) ? "selected" : ""}>${yard.yardCode}</option>`).join("")}</select></label>
        <label><span>From</span><input data-sales-return-filter="from" type="date" value="${salesEscape(salesReturnFilters.from)}" /></label>
        <label><span>To</span><input data-sales-return-filter="to" type="date" value="${salesEscape(salesReturnFilters.to)}" /></label>
        <div><button class="primary-action" data-sales-return-action="apply" type="button">Apply</button><button data-sales-return-action="reset" type="button">Reset</button></div>
      </div>
      <div class="sales-return-layout">
        <aside class="sales-return-list">${salesRenderReturnList()}</aside>
        <section class="sales-return-detail-panel">${salesRenderReturnDetail()}</section>
      </div>
    </section>`;
  salesHydrateSecurePhotoImages(salesApp);
}

function renderSales() {
  if (SALES_RETURNS_PAGE) return renderSalesReturns();
  return renderSalesMenu();
}

function salesCloseReturnPhoto(modal) {
  if (!modal) return;
  salesReleaseSecurePhotoImages(modal);
  modal.remove();
}

function salesOpenReturnPhoto(ref, label) {
  const modal = document.createElement("div");
  modal.className = "sales-return-lightbox";
  modal.innerHTML = `<div role="dialog" aria-modal="true" aria-label="${salesEscape(label || "Return photo")}"><button data-sales-return-action="close-photo" type="button">×</button><img ${salesReturnPhotoImgAttributes(ref)} alt="${salesEscape(label || "Return photo")}" /></div>`;
  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target.closest("[data-sales-return-action='close-photo']")) salesCloseReturnPhoto(modal);
  });
  document.body.appendChild(modal);
  salesHydrateSecurePhotoImages(modal);
}

salesApp.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-sales-return-action]");
  if (!button) return;
  try {
    const action = button.dataset.salesReturnAction;
    if (action === "photo") return salesOpenReturnPhoto(button.dataset.photoRef, button.dataset.photoLabel);
    if (action === "refresh") {
      await salesLoadReturns({ keepSelection: true });
      return renderSalesReturns();
    }
    if (action === "apply") {
      salesApp.querySelectorAll("[data-sales-return-filter]").forEach((input) => {
        salesReturnFilters[input.dataset.salesReturnFilter] = input.value || "";
      });
      salesSaveReturnFilters();
      salesReturnOffset = 0;
      await salesLoadReturns({ keepSelection: false });
      return renderSalesReturns();
    }
    if (action === "reset") {
      salesReturnFilters = { search: "", status: "", type: "", yardLocationId: "", from: "", to: "" };
      salesReturnOffset = 0;
      salesSaveReturnFilters();
      await salesLoadReturns({ keepSelection: false });
      return renderSalesReturns();
    }
    if (action === "page-prev" || action === "page-next") {
      salesReturnOffset = Math.max(
        0,
        salesReturnOffset + (action === "page-next" ? SALES_RETURN_PAGE_SIZE : -SALES_RETURN_PAGE_SIZE)
      );
      await salesLoadReturns({ keepSelection: false });
      return renderSalesReturns();
    }
    if (action === "select") {
      salesReturnSelectedId = button.dataset.id || "";
      if (salesReturnSelectedId) localStorage.setItem("mbbs.sales.returns.selected", salesReturnSelectedId);
      try {
        await salesLoadReturnDetail();
        salesReturnError = "";
      } catch (error) {
        salesReturnDetail = null;
        salesReturnError = error.message;
      }
      return renderSalesReturns();
    }
  } catch (error) {
    salesReturnError = error.message;
    renderSalesReturns();
  }
});

window.addEventListener("mbbs-language-changed", renderSales);
requireDispatchLogin({
  mount: salesApp,
  roles: ["sales", "admin"],
  allowPublicSales: !SALES_RETURNS_PAGE,
  async onReady(operator) {
    salesOperator = operator;
    if (SALES_RETURNS_PAGE) await salesLoadReturns({ keepSelection: true });
    renderSales();
  }
});

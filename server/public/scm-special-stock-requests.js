(() => {
  const mount = document.getElementById("scmStockRequestApp");
  if (!mount) return;

  const state = {
    operator: null,
    enabled: null,
    requests: [],
    detail: null,
    loading: false,
    busy: false,
    error: "",
    notice: "",
    search: "",
    stage: ""
  };

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
  const displayDate = (value) => value ? (window.MBBS_I18N?.displayDateTime?.(value) || String(value)) : "—";
  const number = (value) => Number.isFinite(Number(value)) ? new Intl.NumberFormat("en-CA", { maximumFractionDigits: 4 }).format(Number(value)) : "0";
  const pill = (value) => `<span class="stock-request-pill ${escapeHtml(value || "pending")}">${escapeHtml(String(value || "pending").replaceAll("_", " "))}</span>`;

  async function api(path, options = {}) {
    const response = await fetch(path, {
      cache: "no-store", ...options,
      headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = text; }
    if (!response.ok) {
      const error = new Error(payload?.error || payload || `Request failed (${response.status})`);
      error.status = response.status;
      error.code = payload?.code || "";
      throw error;
    }
    return payload;
  }

  function header() {
    const operator = state.operator || {};
    return `<header class="dispatch-topbar"><div><p>SCM · Special Item</p><h1>Special Stock Requests</h1></div><div class="topbar-language">${window.MBBS_I18N?.toggleHtml?.() || ""}</div><div class="topbar-actions"><span class="dispatch-user">${escapeHtml(operator.display_name || operator.username || "")}</span><button onclick="location.href='/scm'" type="button">SCM Menu</button><button onclick="dispatchLogout()" type="button">Logout</button></div></header>`;
  }

  function list() {
    if (state.loading) return `<div class="stock-request-empty"><strong>Loading Special Item queue…</strong></div>`;
    if (!state.requests.length) return `<div class="stock-request-empty"><strong>No matching cases</strong><span>Sales-submitted Special Item cases appear here.</span></div>`;
    return state.requests.map((request) => `<button class="stock-request-card ${state.detail?.id === request.id ? "selected" : ""}" data-special-scm-action="select" data-id="${request.id}" type="button"><span class="stock-request-status-line"><strong>${escapeHtml(request.requestRef)}</strong>${pill(request.stage)}</span><span>${escapeHtml(request.customerName)} · ${escapeHtml(request.vendorName)}</span><small>${request.lines.length} line(s) · ${displayDate(request.updatedAt)}</small></button>`).join("");
  }

  function responseForm(line) {
    const resolution = line.itemResolution || {};
    const hasSalesOrder = Boolean(state.detail.salesOrderId);
    const hasPurchaseOrder = Boolean(state.detail.purchaseOrderId);
    if (hasSalesOrder && !hasPurchaseOrder && line.salesDecision !== "accepted") {
      return `<div class="stock-request-muted">No second SCM response is required for this ${escapeHtml(line.salesDecision)} line.</div>`;
    }
    const canRespond = !state.detail.purchaseOrderId || state.detail.postPoChangePending === false;
    return `<form class="stock-request-form special-response-form" data-special-response-form data-line-id="${line.id}">
      <h4>${hasPurchaseOrder ? "Post-PO availability change" : hasSalesOrder ? "Second SCM response · Purchase Order preparation" : "First SCM response · Availability"}</h4>
      <div class="stock-request-line-fields">
        <label><span>Supply status *</span><select name="supplyStatus"><option value="in_stock" ${line.supplyStatus === "in_stock" ? "selected" : ""}>In stock</option><option value="vendor_transfer" ${line.supplyStatus === "vendor_transfer" ? "selected" : ""}>Vendor transfer</option><option value="production" ${line.supplyStatus === "production" ? "selected" : ""}>Production</option><option value="allocation" ${line.supplyStatus === "allocation" ? "selected" : ""}>Allocation</option><option value="no_stock" ${line.supplyStatus === "no_stock" ? "selected" : ""}>No stock</option></select></label>
        <label><span>Projection *</span><select name="availabilityMode"><option value="dated" ${line.availabilityMode !== "no_projection" ? "selected" : ""}>Estimated date</option><option value="no_projection" ${line.availabilityMode === "no_projection" ? "selected" : ""}>No projection</option></select></label>
        <label><span>Estimated available date</span><input name="availableDate" type="date" value="${escapeHtml(line.availableDate || "")}" /></label>
        <label><span>Vendor ID *</span><input name="vendorId" type="number" min="1" required value="${escapeHtml(line.responseVendorId || state.detail.vendorId || "")}" /></label>
        <label class="stock-request-item-search"><span>Vendor name *</span><input name="vendorName" data-special-scm-vendor-search data-line-id="${line.id}" autocomplete="off" required value="${escapeHtml(line.responseVendorName || state.detail.vendorName)}" /><div class="stock-request-suggestions" data-special-scm-vendor-suggestions="${line.id}"></div></label>
        <label><span>Vendor yard *</span><input name="vendorYard" required value="${escapeHtml(line.vendorYard || "")}" /></label>
        <label><span>Vendor reference</span><input name="vendorReference" value="${escapeHtml(line.vendorReference || "")}" /></label>
        <label><span>Unit purchase cost (SCM only)</span><input name="unitPurchaseCost" type="number" min="0" step="any" value="${escapeHtml(line.unitPurchaseCost ?? "")}" /></label>
        <label><span>Currency</span><input name="currency" maxlength="3" value="${escapeHtml(line.currency || "CAD")}" /></label>
        <label class="stock-request-wide"><span>Sales-visible response</span><textarea name="salesVisibleNote" rows="2">${escapeHtml(line.salesVisibleNote || "")}</textarea></label>
        <label class="stock-request-wide"><span>SCM internal note</span><textarea name="scmInternalNote" rows="2">${escapeHtml(line.scmInternalNote || "")}</textarea></label>
      </div>
      ${hasSalesOrder && !hasPurchaseOrder ? `<h4>Locked Sales mapping and editable purchase mapping</h4>
        <div class="stock-request-line-fields">
          <label><span>NetSuite Item ID</span><input name="itemId" type="number" value="${escapeHtml(resolution.itemId || "")}" readonly /></label>
          <label><span>Item name</span><input name="itemName" value="${escapeHtml(resolution.itemName || "")}" readonly /></label>
          <label class="stock-request-wide"><span>Sales description</span><input name="description" value="${escapeHtml(resolution.description || "")}" readonly /></label>
          <label><span>Sales UOM</span><input name="salesUom" value="${escapeHtml(resolution.salesUom || "")}" readonly /></label>
          <label><span>Sales quantity</span><input name="salesQuantity" type="number" value="${escapeHtml(resolution.salesQuantity || "")}" readonly /></label>
          <label><span>Purchase UOM *</span><input name="purchaseUom" required value="${escapeHtml(resolution.purchaseUom || resolution.salesUom || "")}" /></label>
          <label><span>Purchase quantity *</span><input name="purchaseQuantity" type="number" min="0.000001" step="any" required value="${escapeHtml(resolution.purchaseQuantity || resolution.salesQuantity || "")}" /></label>
          <label><span>Pallet quantity</span><input name="palletQuantity" type="number" min="0.000001" step="any" value="${escapeHtml(resolution.palletQuantity || (line.uom === "PLT" ? line.quantity : ""))}" /></label>
        </div>` : ""}
      ${!hasSalesOrder ? `<div class="stock-request-muted">Exact NetSuite item resolution is not required in the first reply. Sales resolves accepted items during customer follow-up.</div>` : ""}
      <div class="stock-request-actions"><button class="primary" type="submit" ${canRespond ? "" : "disabled"}>${hasPurchaseOrder ? "Report post-PO vendor change" : hasSalesOrder ? "Save second SCM response" : "Save first SCM response"}</button></div>
    </form>`;
  }

  function lineCard(line) {
    const title = [line.brand, line.productName, line.color, line.size].filter(Boolean).join(" · ");
    return `<article class="stock-request-line"><header><div><strong>${escapeHtml(title)}</strong><small>Requested ${number(line.quantity)} ${escapeHtml(line.uom)}</small></div><div>${pill(line.salesDecision)} ${line.salesDecision === "accepted" && state.detail.salesOrderId ? pill(line.poReady ? "po_ready" : "second_response_pending") : ""}</div></header>${line.salesDecisionReason ? `<div class="stock-request-notice">Sales: ${escapeHtml(line.salesDecisionReason || line.salesCustomerNote)}</div>` : ""}${responseForm(line)}</article>`;
  }

  function orderControls(detail) {
    if (!detail.salesOrderId) return `<div class="stock-request-notice">Sales creates or links the SO after every line is accepted, declined, or closed.</div>`;
    if (!detail.salesOrderApproved) return `<section class="stock-request-section"><h3>Sales Order approval</h3><div class="stock-request-summary"><span><small>SO</small><strong>${escapeHtml(detail.salesOrderRef)}</strong></span><span><small>Status</small><strong>${escapeHtml(detail.salesOrderStatus || "Pending")}</strong></span></div><button data-special-scm-action="refresh-so" type="button">Refresh NetSuite approval</button></section>`;
    if (detail.purchaseOrderId) return `<section class="stock-request-section"><h3>Purchase Order</h3><div class="stock-request-summary"><span><small>PO</small><strong>${escapeHtml(detail.purchaseOrderRef)}</strong></span><span><small>Status</small><strong>${escapeHtml(detail.purchaseOrderStatus || "Pending sync")}</strong></span><span><small>Dispatch</small><strong>${escapeHtml(detail.fulfillmentMethod === "vendor_pickup" ? "Not required" : detail.handoff?.status || "Waiting")}</strong></span></div></section>`;
    const accepted = detail.lines.filter((line) => line.salesDecision === "accepted");
    const ready = accepted.filter((line) => line.poReady);
    if (!accepted.length || ready.length !== accepted.length) {
      return `<section class="stock-request-section"><h3>Purchase Order waiting</h3><div class="stock-request-notice">Complete SCM's second response for every accepted line before creating or linking a PO. ${ready.length} of ${accepted.length} accepted line(s) ready.</div></section>`;
    }
    return `<section class="stock-request-section"><h3>Create or link exclusive Purchase Order</h3><p>The PO uses accepted material mappings, SCM costs, and the SO operational yard. It cannot be shared with another SO.</p><div class="stock-request-actions"><button class="primary" data-special-scm-action="create-po" type="button">Create PO in NetSuite</button></div><form class="stock-request-line-fields special-inline-form" data-special-link-po-form><label class="stock-request-item-search"><span>Search active Purchase Order</span><input data-special-po-link-search autocomplete="off" /><div class="stock-request-suggestions" data-special-po-link-suggestions></div></label><label><span>Existing PO internal ID</span><input name="purchaseOrderId" type="number" min="1" required /></label><label><span>PO number</span><input name="purchaseOrderRef" required /></label><button type="submit">Link existing PO</button></form></section>`;
  }

  function detail() {
    const detail = state.detail;
    if (!detail) return `<div class="stock-request-empty"><strong>Select a case</strong><span>Respond line by line and retain SCM-only costs here.</span></div>`;
    return `<div class="stock-request-heading"><div><h2>${escapeHtml(detail.requestRef)}</h2><p>${escapeHtml(detail.customerName)} · ${escapeHtml(detail.customerPhone || "No phone")}</p></div>${pill(detail.stage)}</div><div class="stock-request-summary"><span><small>Vendor</small><strong>${escapeHtml(detail.vendorName)}</strong></span><span><small>Store</small><strong>${escapeHtml(detail.storeName)}</strong></span><span><small>Case inquiry date</small><strong>${escapeHtml(detail.inquiryDate)}</strong></span><span><small>Revision</small><strong>${detail.revision}</strong></span></div>${detail.remarks ? `<div class="stock-request-notice">${escapeHtml(detail.remarks)}</div>` : ""}${detail.postPoChangePending ? `<div class="stock-request-notice stock-request-error">A post-PO vendor change is waiting for Sales to record customer acknowledgement. The existing SO, PO, and Dispatch handoff were not silently changed.</div>` : ""}<section class="stock-request-section"><h3>Line responses</h3><div class="stock-request-lines">${detail.lines.map(lineCard).join("")}</div></section>${orderControls(detail)}<section class="stock-request-section"><h3>Audit trail</h3>${detail.events.slice(0, 20).map((event) => `<div class="stock-request-event"><strong>${escapeHtml(event.eventType.replaceAll("_", " "))}</strong><small>${escapeHtml(event.actorName)} · ${displayDate(event.createdAt)}</small></div>`).join("")}</section>`;
  }

  function render() {
    if (state.enabled === false) {
      mount.innerHTML = `${header()}<section class="stock-request-page"><div class="stock-request-tabs"><button data-special-scm-action="regular" type="button">Regular</button><button aria-selected="true" type="button">Special</button></div><div class="stock-request-empty"><strong>Special Item workflow is off</strong><span>Enable special_stock_request_workflow after the NetSuite mappings are reviewed.</span></div></section>`;
      return;
    }
    mount.innerHTML = `${header()}<section class="stock-request-page"><div class="stock-request-tabs"><button data-special-scm-action="regular" type="button">Regular</button><button aria-selected="true" type="button">Special</button></div><div class="stock-request-toolbar"><div class="stock-request-actions"><input class="stock-request-search" data-special-scm-search value="${escapeHtml(state.search)}" placeholder="Search case, customer, vendor, SO, PO, or item" /><select data-special-scm-stage><option value="">All stages</option>${["awaiting_purchase", "awaiting_sales", "awaiting_so", "awaiting_so_approval", "awaiting_po", "awaiting_route", "in_progress", "operationally_complete", "completed", "attention", "closed"].map((stage) => `<option value="${stage}" ${state.stage === stage ? "selected" : ""}>${stage.replaceAll("_", " ")}</option>`).join("")}</select><button data-special-scm-action="refresh" type="button">Refresh</button></div></div><div class="stock-request-feedback">${state.notice ? `<div class="stock-request-notice">${escapeHtml(state.notice)}</div>` : ""}${state.error ? `<div class="stock-request-notice stock-request-error">${escapeHtml(state.error)}</div>` : ""}</div><div class="stock-request-workspace"><aside class="stock-request-panel stock-request-list">${list()}</aside><section class="stock-request-panel stock-request-detail">${detail()}</section></div></section>`;
  }

  async function load({ selectedId = state.detail?.id } = {}) {
    state.loading = true;
    state.error = "";
    render();
    try {
      const params = new URLSearchParams({ search: state.search, stage: state.stage });
      const payload = await api(`/api/scm/special-stock-requests?${params}`);
      state.requests = payload.requests || [];
      if (selectedId) state.detail = await api(`/api/scm/special-stock-requests/${selectedId}`);
      else if (state.requests[0]) state.detail = await api(`/api/scm/special-stock-requests/${state.requests[0].id}`);
      else state.detail = null;
    } finally {
      state.loading = false;
      render();
    }
  }

  function replaceSuggestions(selector, html) {
    const target = mount.querySelector(selector);
    if (target) target.innerHTML = html;
  }

  mount.addEventListener("input", (event) => {
    if (event.target.matches("[data-special-scm-vendor-search]")) {
      const lineId = Number(event.target.dataset.lineId);
      const search = event.target.value;
      window.clearTimeout(state.vendorTimer);
      state.vendorTimer = window.setTimeout(async () => {
        try {
          const payload = await api(`/api/scm/special-stock-requests/vendors?search=${encodeURIComponent(search)}`);
          const current = mount.querySelector(`[data-special-scm-vendor-search][data-line-id="${lineId}"]`);
          if (!current || current.value !== search) return;
          const html = (payload.vendors || []).filter((vendor) => vendor.id).map((vendor) => `<button data-special-scm-action="choose-vendor" data-line-id="${lineId}" data-vendor-id="${vendor.id}" data-vendor-name="${escapeHtml(vendor.name)}" type="button"><strong>${escapeHtml(vendor.name)}</strong><small>NetSuite vendor ${vendor.id}</small></button>`).join("");
          replaceSuggestions(`[data-special-scm-vendor-suggestions="${lineId}"]`, html);
        } catch (error) {
          replaceSuggestions(`[data-special-scm-vendor-suggestions="${lineId}"]`, `<small>${escapeHtml(error.message)}</small>`);
        }
      }, 250);
    }
    if (event.target.matches("[data-special-po-link-search]")) {
      const search = event.target.value;
      window.clearTimeout(state.poLinkTimer);
      state.poLinkTimer = window.setTimeout(async () => {
        try {
          const payload = await api(`/api/scm/special-stock-requests/order-links?kind=purchase_order&search=${encodeURIComponent(search)}`);
          const current = mount.querySelector("[data-special-po-link-search]");
          if (!current || current.value !== search) return;
          const html = (payload.orders || []).map((order) => `<button data-special-scm-action="choose-po-link" data-order-id="${order.id}" data-order-ref="${escapeHtml(order.ref)}" type="button"><strong>${escapeHtml(order.ref)} · ${escapeHtml(order.entityName)}</strong><small>${escapeHtml(order.status)}</small></button>`).join("");
          replaceSuggestions("[data-special-po-link-suggestions]", html);
        } catch (error) {
          replaceSuggestions("[data-special-po-link-suggestions]", `<small>${escapeHtml(error.message)}</small>`);
        }
      }, 250);
    }
  });

  mount.addEventListener("change", async (event) => {
    if (!event.target.matches("[data-special-scm-stage]")) return;
    state.stage = event.target.value;
    await load({ selectedId: null });
  });

  mount.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !event.target.matches("[data-special-scm-search]")) return;
    event.preventDefault();
    state.search = event.target.value;
    load({ selectedId: null }).catch((error) => { state.error = error.message; render(); });
  });

  mount.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!form.matches("[data-special-response-form], [data-special-link-po-form]")) return;
    event.preventDefault();
    state.busy = true;
    state.error = "";
    try {
      const values = Object.fromEntries(new FormData(form));
      if (form.matches("[data-special-response-form]")) {
        const itemResolution = values.itemId
          ? {
              itemId: Number(values.itemId), itemName: values.itemName, description: values.description,
              salesUom: values.salesUom, purchaseUom: values.purchaseUom,
              salesQuantity: Number(values.salesQuantity),
              purchaseQuantity: values.purchaseQuantity ? Number(values.purchaseQuantity) : null,
              palletQuantity: values.palletQuantity ? Number(values.palletQuantity) : null
            }
          : null;
        state.detail = await api(`/api/scm/special-stock-requests/${state.detail.id}/lines/${form.dataset.lineId}/response`, {
          method: "POST",
          body: JSON.stringify({
            expectedRevision: state.detail.revision,
            supplyStatus: values.supplyStatus,
            availabilityMode: values.availabilityMode,
            availableDate: values.availabilityMode === "dated" ? values.availableDate : null,
            vendorId: Number(values.vendorId), vendorName: values.vendorName,
            vendorYard: values.vendorYard, vendorReference: values.vendorReference,
            salesVisibleNote: values.salesVisibleNote, scmInternalNote: values.scmInternalNote,
            unitPurchaseCost: values.unitPurchaseCost === "" ? null : Number(values.unitPurchaseCost),
            currency: values.currency,
            itemResolution
          })
        });
        state.notice = state.detail.purchaseOrderId
          ? "Post-PO availability change reported for Sales acknowledgement."
          : state.detail.salesOrderId
            ? "Second SCM response saved. This accepted line is ready for PO preparation."
            : "First SCM response saved. Sales can complete the customer follow-up.";
      } else {
        state.detail = await api(`/api/scm/special-stock-requests/${state.detail.id}/purchase-order/link`, {
          method: "POST",
          body: JSON.stringify({ expectedRevision: state.detail.revision, purchaseOrderId: Number(values.purchaseOrderId), purchaseOrderRef: values.purchaseOrderRef })
        });
      }
    } catch (error) {
      state.error = error.message;
      if (error.status === 409 && state.detail) await load({ selectedId: state.detail.id }).catch(() => {});
    } finally {
      state.busy = false;
      render();
    }
  });

  mount.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-special-scm-action]");
    if (!button || state.busy) return;
    const action = button.dataset.specialScmAction;
    try {
      if (action === "regular") return location.reload();
      if (action === "refresh") return load();
      if (action === "select") { state.detail = await api(`/api/scm/special-stock-requests/${button.dataset.id}`); return render(); }
      if (action === "choose-vendor") {
        const form = mount.querySelector(`[data-special-response-form][data-line-id="${button.dataset.lineId}"]`);
        form.querySelector("[name=vendorId]").value = button.dataset.vendorId;
        form.querySelector("[name=vendorName]").value = button.dataset.vendorName;
        replaceSuggestions(`[data-special-scm-vendor-suggestions="${button.dataset.lineId}"]`, "");
        return;
      }
      if (action === "choose-po-link") {
        const form = mount.querySelector("[data-special-link-po-form]");
        form.querySelector("[name=purchaseOrderId]").value = button.dataset.orderId;
        form.querySelector("[name=purchaseOrderRef]").value = button.dataset.orderRef;
        form.querySelector("[data-special-po-link-search]").value = button.dataset.orderRef;
        replaceSuggestions("[data-special-po-link-suggestions]", "");
        return;
      }
      state.busy = true;
      state.error = "";
      if (action === "refresh-so") {
        state.detail = await api(`/api/scm/special-stock-requests/${state.detail.id}/sales-order/refresh`, { method: "POST", body: "{}" });
      } else if (action === "create-po") {
        state.detail = await api(`/api/scm/special-stock-requests/${state.detail.id}/purchase-order/create`, {
          method: "POST", body: JSON.stringify({ expectedRevision: state.detail.revision, operationId: crypto.randomUUID() })
        });
        state.notice = `${state.detail.purchaseOrderRef} created and linked exclusively.`;
      }
    } catch (error) {
      state.error = error.message;
    } finally {
      state.busy = false;
      render();
    }
  });

  window.MBBSSCMSpecialStock = {
    async open({ operator } = {}) {
      state.operator = operator || state.operator;
      state.loading = true;
      render();
      try {
        const policy = await api("/api/scm/special-stock-requests/policy");
        state.enabled = policy.enabled === true;
        if (state.enabled) await load();
      } catch (error) {
        state.error = error.message;
        state.loading = false;
        render();
      }
    }
  };
})();

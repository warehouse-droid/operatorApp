(() => {
  const mount = document.getElementById("scmStockRequestApp");
  if (!mount) return;

  const workflowReady = import('/special-stock-workflow.js');
  const formsReady = import('/special-stock-form-state.js');
  let SPECIAL_STAGES = {}, stageFilterHtml = () => '';
  let specialFormKey, rememberSpecialForm, restoreSpecialForms, preserveSpecialScroll;
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
    stages: [],
    dirty: false,
    formDrafts: new Map(),
    testSkipOrdersEnabled: false
  };

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
  const displayDate = (value) => value ? (window.MBBS_I18N?.displayDateTime?.(value) || String(value)) : "—";
  const number = (value) => Number.isFinite(Number(value)) ? new Intl.NumberFormat("en-CA", { maximumFractionDigits: 4 }).format(Number(value)) : "0";
  const pill = (value) => `<span class="stock-request-pill ${escapeHtml(value || "pending")}">${escapeHtml(SPECIAL_STAGES[value] || String(value || "pending").replaceAll("_", " "))}</span>`;

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
    return state.requests.map((request) => `<button class="stock-request-card ${state.detail?.id === request.id ? "selected" : ""}" data-special-scm-action="select" data-id="${request.id}" type="button"><span class="stock-request-status-line"><strong>${escapeHtml(request.requestRef)}</strong>${pill(request.stage)}</span><span>${escapeHtml(request.customerName)} · ${escapeHtml(request.vendorName)}</span><small>${request.lines.length} line(s) · ${displayDate(request.updatedAt)}</small>${request.quantityReviewPending ? '<strong class="stock-request-error">Quantity changed · SCM review required</strong>' : ''}${request.readinessAlerts?.length ? `<strong class="stock-request-error">${request.readinessAlerts.length} readiness check(s) due</strong>` : ""}</button>`).join("");
  }

  function responseForm(line) {
    if (['closed','completed'].includes(state.detail.stage)) return '';
    if (line.salesDecision === 'accepted') return `<form class="stock-request-line-fields" data-special-readiness-form data-line-id="${line.id}">
      <label><span>Stock readiness</span><select name="ready"><option value="false" ${line.supplyStatus !== 'in_stock' ? 'selected' : ''}>Not ready</option><option value="true" ${line.supplyStatus === 'in_stock' ? 'selected' : ''}>Ready for collection</option></select></label>
      <label data-special-eta ${line.supplyStatus === 'in_stock' ? 'hidden' : ''}><span>ETA *</span><input name="eta" type="date" ${line.supplyStatus === 'in_stock' ? 'disabled' : 'required'} value="${escapeHtml(line.availableDate || '')}" /></label><button type="submit">Save readiness check</button></form>`;
    if (['declined','closed'].includes(line.salesDecision) || state.detail.salesOrderId || state.detail.salesOrderSkipped) return '';
    return `<form class="stock-request-form special-response-form" data-special-response-form data-line-id="${line.id}"><h4>SCM stock check</h4>
      <input name="vendorId" type="hidden" value="${escapeHtml(line.responseVendorId || state.detail.vendorId || '')}" />
      <div class="stock-request-line-fields"><label><span>Supply status *</span><select name="supplyStatus"><option value="in_stock" ${line.supplyStatus === 'in_stock' ? 'selected' : ''}>In stock</option><option value="production" ${line.supplyStatus === 'production' ? 'selected' : ''}>Wait For Production</option><option value="no_stock" ${line.supplyStatus === 'no_stock' ? 'selected' : ''}>No stock or ETA</option></select></label>
      <label class="stock-request-item-search"><span>Vendor *</span><input name="vendorName" data-special-scm-vendor-search data-line-id="${line.id}" required value="${escapeHtml(line.responseVendorName || state.detail.vendorName)}" /><div class="stock-request-suggestions" data-special-scm-vendor-suggestions="${line.id}"></div></label>
      <label data-special-eta ${line.supplyStatus === 'production' ? '' : 'hidden'}><span>ETA *</span><input name="availableDate" type="date" ${line.supplyStatus === 'production' ? 'required' : 'disabled'} value="${escapeHtml(line.availableDate || '')}" /></label>
      <label class="stock-request-wide"><span>Vendor pickup location *</span><input name="vendorYard" ${line.supplyStatus === "no_stock" ? "" : "required"} value="${escapeHtml(line.vendorYard || '')}" /></label>
      <label class="stock-request-wide"><span>Sales-visible reply</span><textarea name="salesVisibleNote">${escapeHtml(line.salesVisibleNote || '')}</textarea></label>
      <label class="stock-request-wide"><span>SCM internal note</span><textarea name="scmInternalNote">${escapeHtml(line.scmInternalNote || '')}</textarea></label></div>
      <button class="primary" type="submit">Save stock check</button></form>`;
  }

  function lineCard(line) {
    const alert = state.detail.readinessAlerts?.some(item => item.lineId === line.id);
    return `<article class="stock-request-line"><header><div><strong>${escapeHtml([line.brand,line.productName,line.color,line.size].filter(Boolean).join(' · '))}</strong><small>${number(line.quantity)} ${escapeHtml(line.uom)}</small></div>${pill(line.salesDecision)}</header>
      <p>${line.supplyStatus === 'in_stock' ? 'Stock ready' : `ETA: ${escapeHtml(line.availableDate || 'Not available')}`} · Pickup: ${escapeHtml(line.vendorYard || 'Awaiting check')}</p>
      ${alert ? '<div class="stock-request-notice stock-request-error" role="status">Readiness check due. This alert stays active until SCM confirms stock is ready.</div>' : ''}
      ${line.salesCustomerNote || line.salesDecisionReason ? `<p>Sales: ${escapeHtml(line.salesCustomerNote || line.salesDecisionReason)}</p>` : ''}${responseForm(line)}</article>`;
  }

  function orderControls(detail) {
    if (['closed','completed'].includes(detail.stage)) return '';
    if (detail.quantityReviewPending) return '<p>SO/PO actions wait for the quantity review above.</p>';
    if (!detail.salesOrderId && !detail.salesOrderSkipped) return `<div class="stock-request-notice">Sales can create the SO after the customer confirms the available stock or accepts the ETA.</div>
      ${detail.lines.every(line => line.supplyStatus === 'no_stock' && !line.availableDate) ? `<form data-special-scm-close-form><label>Closure reason<input name="reason" required /></label><button class="danger" type="submit">Close request — no stock or ETA</button></form>` : ''}`;
    if (detail.purchaseOrderId || detail.purchaseOrderSkipped) return `<section><h3>${detail.purchaseOrderSkipped ? 'PO creation skipped (test)' : `Purchase Order ${escapeHtml(detail.purchaseOrderRef)}`}</h3><p>${detail.salesOrderSkipped ? 'SO creation skipped (test)' : `SO ${escapeHtml(detail.salesOrderRef)}`} · ${detail.stage === 'wait_for_production' ? 'Waiting for SCM readiness confirmation' : detail.fulfillmentMethod === 'vendor_pickup' ? 'Customer pickup at vendor yard' : 'Dispatch Arrangement'}</p></section>`;
    if (!detail.salesOrderApproved) return `<section><h3>SO approval pending</h3><p>${escapeHtml(detail.salesOrderRef)}</p><button data-special-scm-action="refresh-so" type="button">Refresh NetSuite approval</button></section>`;
    const retry = detail.purchaseOrderOperationStatus === 'attention';
    return `<section class="stock-request-section"><h3>Review and create Purchase Order</h3><p>${detail.salesOrderSkipped ? 'SO creation skipped for testing. Use Skip PO Creation to continue the test.' : `SO ${escapeHtml(detail.salesOrderRef)}. Creating a PO also applies description changes to the linked SO.`}</p>
      <form data-special-po-form><fieldset ${retry ? 'disabled' : ''} style="border:0;padding:0">
      ${detail.purchaseOrderLines.map(line => `<article class="stock-request-line" data-special-po-line="${line.caseLineId}"><strong>MBBS-Special Order</strong><div class="stock-request-line-fields">
        <label class="stock-request-wide"><span>Order description *</span><input name="description" required value="${escapeHtml(line.description)}" /></label>
        <label><span>Purchase quantity *</span><input name="quantity" type="number" min="0.000001" step="any" required value="${escapeHtml(line.quantity)}" /></label>
        <label><span>Purchase UOM *</span><input name="uom" required value="${escapeHtml(line.uom)}" /></label>
        <label><span>Purchase unit cost *</span><input name="unitPurchaseCost" type="number" min="0" step="any" required value="${escapeHtml(line.unitPurchaseCost ?? '')}" /></label></div></article>`).join('')}</fieldset>
      <div class="stock-request-actions">${!detail.salesOrderSkipped ? `<button class="primary" type="submit">${retry ? 'Recover PO operation' : 'Create PO in NetSuite'}</button>` : ''}${state.testSkipOrdersEnabled && !retry && detail.purchaseOrderOperationStatus !== 'creating' ? '<button type="submit" data-special-skip-po>Skip PO Creation</button>' : ''}</div></form></section>`;
  }

  function quantityReviewView(detail) {
    if (!detail.quantityReviewPending) return '';
    const review = detail.quantityReview;
    return `<section class="stock-request-section"><form class="stock-request-form" data-special-quantity-review-form><h3>SCM quantity review</h3>
      <p>${review.mode === 'issued' ? 'Confirmation updates the issued SO and PO. A partial update stays pending until both are verified.' : 'Confirm the new stock requirement before Sales creates the SO.'}</p>
      ${review.lines.map(line=>`<article class="stock-request-line"><strong>${escapeHtml(line.productName)}</strong><p>${number(line.fromPackageQuantity)} → ${number(line.toPackageQuantity)} ${escapeHtml(line.packageUom)}</p><p>SO: ${number(line.fromQuantity)} → ${number(line.toQuantity)} ${escapeHtml(line.salesUom)} · PO: ${number(line.fromPurchaseQuantity)} → ${number(line.toPurchaseQuantity)} ${escapeHtml(line.purchaseUom)}</p></article>`).join('')}
      ${review.error ? `<p class="stock-request-error">${escapeHtml(review.error)}</p>` : ''}
      <label><span>Review note</span><input name="reason" /></label><div class="stock-request-actions"><button class="primary" type="submit" value="approve">${['applying','attention'].includes(review.status) ? 'Retry quantity update' : 'Confirm quantity change'}</button>
      ${!review.remoteStarted && review.status !== 'applying' ? '<button class="danger" type="submit" value="reject">Reject quantity change</button>' : ''}</div></form></section>`;
  }

  function detail() {
    const detail = state.detail;
    if (!detail) return `<div class="stock-request-empty"><strong>Select a case</strong><span>Respond line by line and retain SCM-only costs here.</span></div>`;
    return `<div class="stock-request-heading"><div><h2>${escapeHtml(detail.requestRef)}</h2><p>${escapeHtml(detail.customerName)} · ${escapeHtml(detail.customerPhone || "No phone")}</p></div>${pill(detail.stage)}</div><div class="stock-request-summary"><span><small>Vendor</small><strong>${escapeHtml(detail.vendorName)}</strong></span><span><small>Store</small><strong>${escapeHtml(detail.storeName)}</strong></span><span><small>Case inquiry date</small><strong>${escapeHtml(detail.inquiryDate)}</strong></span><span><small>Revision</small><strong>${detail.revision}</strong></span></div>${detail.attention ? `<div class="stock-request-notice stock-request-error">${escapeHtml(detail.attentionReason)}</div>` : ''}${quantityReviewView(detail)}${detail.closureReason ? `<div class="stock-request-notice">Closed: ${escapeHtml(detail.closureReason)}</div>` : ''}${detail.remarks ? `<div class="stock-request-notice">${escapeHtml(detail.remarks)}</div>` : ""}${detail.postPoChangePending ? `<div class="stock-request-notice stock-request-error">A post-PO vendor change is waiting for Sales to record customer acknowledgement. The existing SO, PO, and Dispatch handoff were not silently changed.</div>` : ""}<section class="stock-request-section"><h3>Line responses</h3><div class="stock-request-lines">${detail.lines.map(lineCard).join("")}</div></section>${orderControls(detail)}<section class="stock-request-section"><h3>Audit trail</h3>${detail.events.slice(0, 20).map((event) => `<div class="stock-request-event"><strong>${escapeHtml(event.eventType.replaceAll("_", " "))}</strong><small>${escapeHtml(event.actorName)} · ${displayDate(event.createdAt)}</small></div>`).join("")}</section>`;
  }

  function render() {
    const restoreScroll = preserveSpecialScroll?.(mount);
    if (state.detail) state.requests = state.requests.map(request => request.id === state.detail.id ? state.detail : request)
      .filter(request => !state.stages.length || state.stages.includes(request.stage))
      .sort((a,b) => Number(Boolean(b.quantityReviewPending)) - Number(Boolean(a.quantityReviewPending)));
    if (window.MBBSStockRequestTabs && !window.MBBSStockRequestTabs.isActive("special")) return;
    const restoreTabFocus = window.MBBSStockRequestTabs?.preserveFocus();
    if (state.enabled === false) {
      mount.innerHTML = `${header()}<section class="stock-request-page">${window.MBBSStockRequestTabs?.html() || `<div class="stock-request-tabs"><button data-special-scm-action="regular" type="button">Regular</button><button aria-selected="true" type="button">Special</button></div>`}<div class="stock-request-empty"><strong>Special Item workflow is off</strong><span>Enable special_stock_request_workflow after the NetSuite mappings are reviewed.</span></div></section>`;
      restoreTabFocus?.();
      return;
    }
    mount.innerHTML = `${header()}<section class="stock-request-page">${window.MBBSStockRequestTabs?.html() || `<div class="stock-request-tabs"><button data-special-scm-action="regular" type="button">Regular</button><button aria-selected="true" type="button">Special</button></div>`}<div class="stock-request-toolbar"><div class="stock-request-actions"><input class="stock-request-search" data-special-scm-search value="${escapeHtml(state.search)}" placeholder="Search case, customer, vendor, SO, PO, or item" />${stageFilterHtml(state.stages, "data-special-scm-stage")}<button data-special-scm-action="refresh" type="button">Refresh</button></div></div><div class="stock-request-feedback">${state.notice ? `<div class="stock-request-notice">${escapeHtml(state.notice)}</div>` : ""}${state.error ? `<div class="stock-request-notice stock-request-error">${escapeHtml(state.error)}</div>` : ""}</div><div class="stock-request-workspace"><aside class="stock-request-panel stock-request-list">${list()}</aside><section class="stock-request-panel stock-request-detail">${detail()}</section></div></section>`;
    restoreTabFocus?.();
    mount.querySelector('.stock-request-page')?.classList.add('special-stock-page');
    restoreSpecialForms?.(mount, state.formDrafts);
    for (const form of mount.querySelectorAll('[data-special-response-form], [data-special-readiness-form]')) updateEtaVisibility(form);
    restoreScroll?.();
  }

  async function load({ selectedId = state.detail?.id } = {}) {
    state.loading = true;
    state.dirty = false;
    state.formDrafts.clear();
    state.error = "";
    render();
    try {
      const params = new URLSearchParams({ search: state.search, stages: state.stages.join(",") });
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

  function updateEtaVisibility(form) {
    const status = form.querySelector('[name=supplyStatus]');
    const waiting = status ? status.value === 'production' : form.querySelector('[name=ready]')?.value === 'false';
    const eta = form.querySelector('[data-special-eta]');
    if (eta) {
      eta.hidden = !waiting;
      eta.querySelector('input').disabled = !waiting;
      eta.querySelector('input').required = waiting;
    }
    if (status) form.querySelector('[name=vendorYard]').required = status.value !== 'no_stock';
  }

  mount.addEventListener("input", (event) => {
    if (event.target.closest("form")) state.dirty = true;
    if (event.target.matches("[data-special-scm-vendor-search]")) {
      const lineId = Number(event.target.dataset.lineId);
      const search = event.target.value;
      event.target.form.querySelector('[name=vendorId]').value = '';
      replaceSuggestions(`[data-special-scm-vendor-suggestions="${lineId}"]`, '');
      const requestId = state.detail.id;
      window.clearTimeout(state.vendorTimer);
      state.vendorTimer = window.setTimeout(async () => {
        try {
          const payload = await api(`/api/scm/special-stock-requests/vendors?search=${encodeURIComponent(search)}`);
          const current = mount.querySelector(`[data-special-scm-vendor-search][data-line-id="${lineId}"]`);
          if (!current || current.value !== search || state.detail?.id !== requestId) return;
          const html = (payload.vendors || []).filter((vendor) => vendor.id).map((vendor) => `<button data-special-scm-action="choose-vendor" data-line-id="${lineId}" data-vendor-id="${vendor.id}" data-vendor-name="${escapeHtml(vendor.name)}" type="button"><strong>${escapeHtml(vendor.name)}</strong></button>`).join("");
          replaceSuggestions(`[data-special-scm-vendor-suggestions="${lineId}"]`, html);
        } catch (error) {
          replaceSuggestions(`[data-special-scm-vendor-suggestions="${lineId}"]`, `<small>${escapeHtml(error.message)}</small>`);
        }
      }, 250);
    }
    rememberSpecialForm?.(state.formDrafts, event.target.closest('form'));
  });

  mount.addEventListener("change", async (event) => {
    if (event.target.matches('[name=supplyStatus], [name=ready]')) updateEtaVisibility(event.target.form);
    if (event.target.closest('form')) state.dirty = true;
    rememberSpecialForm?.(state.formDrafts, event.target.closest('form'));
    if (!event.target.matches("[data-special-scm-stage]")) return;
    state.stages = [...mount.querySelectorAll("[data-special-scm-stage]:checked")].map(input => input.value);
    await load({ selectedId: null });
    mount.querySelector(".special-stage-filter").open = true;
  });

  mount.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !event.target.matches("[data-special-scm-search]")) return;
    event.preventDefault();
    state.search = event.target.value;
    load({ selectedId: null }).catch((error) => { state.error = error.message; render(); });
  });

  mount.addEventListener('submit', async event => {
    const form = event.target;
    if (!form.matches('[data-special-response-form], [data-special-readiness-form], [data-special-po-form], [data-special-scm-close-form], [data-special-quantity-review-form]')) return;
    event.preventDefault();
    if (state.busy) return;
    state.busy = true; state.error = '';
    rememberSpecialForm(state.formDrafts, form);
    try {
      const values = Object.fromEntries(new FormData(form));
      let path, payload = { expectedRevision: state.detail.revision };
      if (form.matches('[data-special-response-form]')) {
        if (!values.vendorId) throw new Error('Select a vendor from the suggestions.');
        const eta = values.supplyStatus === 'production' ? values.availableDate : null;
        if (values.supplyStatus === 'production' && !eta) throw new Error('Enter an ETA for stock awaiting supply.');
        path = `lines/${form.dataset.lineId}/response`;
        payload = { ...values, ...payload, availableDate: eta, availabilityMode: eta ? 'dated' : 'no_projection' };
      } else if (form.matches('[data-special-readiness-form]')) {
        path = `lines/${form.dataset.lineId}/readiness`; payload = { ...payload, ready: values.ready === 'true', eta: values.eta };
      } else if (form.matches('[data-special-quantity-review-form]')) {
        path = 'quantity-review'; payload = { ...payload, reviewId: state.detail.quantityReview.id, decision: event.submitter.value, reason: values.reason };
      } else if (form.matches('[data-special-scm-close-form]')) {
        path = 'close-unavailable'; payload.reason = values.reason;
      } else {
        path = event.submitter?.matches('[data-special-skip-po]') ? 'purchase-order/skip' : 'purchase-order/create';
        payload.operationId = state.detail.purchaseOrderOperationId || crypto.randomUUID();
        if (state.detail.purchaseOrderOperationStatus !== 'attention') payload.lines = [...form.querySelectorAll('[data-special-po-line]')].map(element => ({
          caseLineId: Number(element.dataset.specialPoLine), ...Object.fromEntries([...element.querySelectorAll('[name]')].map(input => [input.name,input.value]))
        }));
      }
      state.detail = await api(`/api/scm/special-stock-requests/${state.detail.id}/${path}`, { method: 'POST', body: JSON.stringify(payload) });
      state.formDrafts.delete(specialFormKey(form));
      state.dirty = state.formDrafts.size > 0; state.notice = path === 'purchase-order/skip' ? 'PO creation skipped for testing.' : 'Saved.';
      const index = state.requests.findIndex(request => request.id === state.detail.id);
      if (index >= 0) state.requests[index] = state.detail;
    } catch (error) {
      state.error = error.message;
      if (state.detail) state.detail = await api(`/api/scm/special-stock-requests/${state.detail.id}`).catch(() => state.detail);
    } finally { state.busy = false; render(); }
  });

  mount.addEventListener("click", async (event) => {
    if (event.target.closest('[data-special-clear-stages]')) { state.stages = []; await load({ selectedId: null }); return; }
    const button = event.target.closest("[data-special-scm-action]");
    if (!button || state.busy) return;
    const action = button.dataset.specialScmAction;
    try {
      if (action === "regular") return window.MBBSStockRequestTabs ? window.MBBSStockRequestTabs.open("regular") : location.reload();
      if (action === "refresh") return load();
      if (action === "select") { state.formDrafts.clear(); state.dirty = false; state.detail = await api(`/api/scm/special-stock-requests/${button.dataset.id}`); return render(); }
      if (action === "choose-vendor") {
        const form = mount.querySelector(`[data-special-response-form][data-line-id="${button.dataset.lineId}"]`);
        form.querySelector("[name=vendorId]").value = button.dataset.vendorId;
        form.querySelector("[name=vendorName]").value = button.dataset.vendorName;
        state.dirty = true;
        rememberSpecialForm(state.formDrafts, form);
        replaceSuggestions(`[data-special-scm-vendor-suggestions="${button.dataset.lineId}"]`, "");
        return;
      }
      state.busy = true;
      state.error = "";
      if (action === "refresh-so") {
        state.detail = await api(`/api/scm/special-stock-requests/${state.detail.id}/sales-order/refresh`, { method: "POST", body: "{}" });
      }
    } catch (error) {
      state.error = error.message;
    } finally {
      state.busy = false;
      render();
    }
  });

  window.setInterval(() => {
    if (state.enabled && !state.busy && !state.dirty && !document.hidden && (!window.MBBSStockRequestTabs || window.MBBSStockRequestTabs.isActive('special'))) {
      load().catch(error => { state.error = error.message; render(); });
    }
  }, 60000);
  window.MBBSSCMSpecialStock = {
    async open({ operator } = {}) {
      ({ SPECIAL_STAGES, stageFilterHtml } = await workflowReady);
      ({ specialFormKey, rememberSpecialForm, restoreSpecialForms, preserveSpecialScroll } = await formsReady);
      state.operator = operator || state.operator;
      state.loading = true;
      render();
      try {
        const policy = await api("/api/scm/special-stock-requests/policy");
        state.enabled = policy.enabled === true;
        state.testSkipOrdersEnabled = policy.testSkipOrdersEnabled === true;
        if (state.enabled) await load();
      } catch (error) {
        state.error = error.message;
        state.loading = false;
        render();
      }
    }
  };
})();

(() => {
  const mount = document.getElementById("salesStockRequestApp");
  if (!mount) return;

  import('/special-stock-detail-display.js?v=20260928-display-v1').then(module => {
    module.installSpecialDetailDisplay(mount, () => state.operator?.id);
  });

  const expiryReady = import('/special-stock-expiry.js?v=20260928-enhancements-v1');
  let defaultSpecialExpiry;
  const busyReady = import('/special-stock-busy.js');
  /** @type {ReturnType<typeof import('./special-stock-busy.js').installSpecialBusyState>|undefined} */
  let busyUI;
  const queueReady = import('/special-stock-queue.js');
  let queue;
  /** @type {typeof import('./special-stock-fulfillment.js').specialFulfillmentEditor} */
  let specialFulfillmentEditor=()=>'';
  /** @type {typeof import('./special-stock-fulfillment.js').syncSpecialFulfillmentForm} */
  let syncSpecialFulfillmentForm=()=>{};
  /** @type {typeof import('./special-stock-internal-remark.js').syncSpecialInternalRemarkForm} */
  let syncSpecialInternalRemarkForm=()=>{};
  import(new URL('/special-stock-fulfillment.js?v=20261003-internal-remark-v1', location.href).href).then(module=>{
    specialFulfillmentEditor=module.specialFulfillmentEditor;syncSpecialFulfillmentForm=module.syncSpecialFulfillmentForm;
    syncSpecialInternalRemarkForm=module.syncSpecialInternalRemarkForm;
    if(state.enabled)render();
  });
  const informationReady = import(new URL('/special-stock-information.js?v=20261002-stock-updates-v1', location.href).href);
  /** @type {typeof import('./special-stock-information.js').specialInformationPanel} */
  let specialInformationPanel = () => '';
  /** @type {typeof import('./special-stock-workflow.js').specialStockAvailable} */
  let specialStockAvailable;
  const workflowReady = import(new URL('/special-stock-workflow.js?v=20261002-stock-updates-v1', location.href).href);
  const lineDetailsReady = import('/special-stock-line-details.js?v=20261001-po-mini-rows-v1');
  let specialItemDescription;
  const palletDisplayReady = import(new URL('/special-stock-pallet-display.js?v=20261001-delivery-fee-v1', location.href).href);
  /** @type {typeof import('./special-stock-pallet-display.js').specialRequestPalletLine} */
  let specialRequestPalletLine;
  /** @type {typeof import('./special-stock-delivery-fee.js').savedSpecialDeliveryFee} */
  let savedSpecialDeliveryFee;
  const vendorFilterReady = import('/stock-request-vendor-filter.js?v=20260928-enhancements-v1');
  let vendorFilterHtml = () => '';
  const yardFilterReady = import('/stock-request-yard-filter.js?v=20260927');
  let yardFilterHtml = () => '';
  const formsReady = import('/special-stock-form-state.js?v=20260928-batch-v1');
  const requestActionsReady = import(new URL('/special-stock-request-actions.js?v=20261003-internal-remark-v1',location.href).href);
  /** @type {typeof import('./special-stock-request-actions.js').canAddSpecialItems} */
  let canAddSpecialItems;
  /** @type {typeof import('./special-stock-request-actions.js').copySpecialRequestDraft} */
  let copySpecialRequestDraft;
  /** @type {typeof import('./special-stock-request-actions.js').confirmSpecialAddItems} */
  let confirmSpecialAddItems;
  /** @type {typeof import('./special-stock-case-edits.js').revokeSpecialLineDecision} */
  let revokeSpecialLineDecision;
  const caseEditsReady = import(new URL('/special-stock-case-edits.js?v=20261003-line-decline-v1', location.href).href);
  const lineNotesReady = import(new URL('/special-stock-line-notes.js?v=20261003-request-corrections-v1', location.href).href);
  /** @type {typeof import('./special-stock-line-notes.js').specialLineNotes} */
  let specialLineNotes;
  /** @type {typeof import('./special-stock-line-notes.js').specialRequestLineNotes} */
  let specialRequestLineNotes;
  /** @type {typeof import('./special-stock-case-edits.js').canEditSpecialCaseLines} */
  let canEditSpecialCaseLines;
  /** @type {typeof import('./special-stock-case-edits.js').specialCaseEditDraft} */
  let specialCaseEditDraft;
  /** @type {typeof import('./special-stock-case-edits.js').planSpecialCaseEdits} */
  let planSpecialCaseEdits;
  /** @type {typeof import('./special-stock-case-edits.js').confirmSpecialCaseRestart} */
  let confirmSpecialCaseRestart;
  /** @typedef {Record<string,any>&{lines:Array<Record<string,any>>}} SpecialRequestModel */
  const pricingReady = import('/special-stock-pricing.js');
  let specialDocumentActions = () => '';
  /** @type {typeof import('./special-stock-case-status.js').specialPlanningStatus} */
  let specialPlanningStatus = () => '';
  let specialClosureStatus = () => '', canRequestSpecialClosure = () => false;
  import(new URL('/special-stock-case-status.js?v=20261002-stock-updates-v1', location.href).href).then(status => {
    specialPlanningStatus = (detail, compact = false) => status.specialPlanningStatus(detail, compact, { audience: 'sales', showOrderPreviews: !compact }); specialClosureStatus = status.specialClosureStatus;
    canRequestSpecialClosure = status.canRequestSpecialClosure;
    if (state.enabled) render();
  });
  import('/special-stock-documents.js').then(documents => {
    specialDocumentActions = detail => documents.specialDocumentActions(detail, 'sales');
    documents.installSpecialDocumentPreviews(mount, { audience: 'sales', getDraft: () => {
      syncCaseComposerFromDom();
      return { ...state.composer, customerId: state.composer.customerId || null, vendorId: state.composer.vendorId || null };
    } });
    if (state.enabled) render();
  });
  /** @type {typeof import('./special-stock-pricing.js').specialDiscountLineSubtotal} */
  let specialLineSubtotal;
  /** @type {typeof import('./special-stock-pricing.js').specialNativeLinePricing} */
  let specialNativePricing;
  /** @type {typeof import('./special-stock-pricing.js').earliestSpecialDeliveryDate} */
  let earliestSpecialDeliveryDate;
  let SPECIAL_STAGES = {}, stageFilterHtml = () => '';
  /** @type {typeof import('./special-stock-form-state.js').specialFormKey} */
  let specialFormKey;
  /** @type {typeof import('./special-stock-form-state.js').rememberSpecialForm} */
  let rememberSpecialForm;
  /** @type {typeof import('./special-stock-form-state.js').restoreSpecialForms} */
  let restoreSpecialForms;
  /** @type {typeof import('./special-stock-form-state.js').preserveSpecialScroll} */
  let preserveSpecialScroll;
  const state = {
    operator: null,
    yards: [],
    enabled: null,
    storeLocationIds: [],
    vendorNames: [],
    vendors: [],
    requests: /** @type {SpecialRequestModel[]} */ ([]),
    detail: /** @type {SpecialRequestModel|null} */ (null),
    composer: /** @type {SpecialRequestModel|null} */ (null),
    copySource: /** @type {SpecialRequestModel|null} */ (null),
    addItemsDraft: /** @type {{lines:Array<Record<string,any>>}|null} */ (null),
    confirmingAddItems: false,
    caseEditDraft: /** @type {ReturnType<typeof import('./special-stock-case-edits.js').specialCaseEditDraft>|null} */ (null),
    caseEditSource: /** @type {SpecialRequestModel|null} */ (null),
    soDraft: /** @type {Record<string,any>|null} */ (null),
    soDraftDirty: false,
    formDrafts: new Map(),
    salesReps: null,
    salesRepsLoading: false,
    salesRepsError: "",
    testSkipOrdersEnabled: false,
    caseCustomerResults: [],
    caseVendorResults: [],
    customerResults: [],
    itemResults: [],
    loading: false,
    busy: false,
    error: "",
    notice: "",
    search: new URLSearchParams(location.search).get('search') || '',
    mine: new URLSearchParams(location.search).get('mine') === '1',
    stages: [...new Set((new URLSearchParams(location.search).get('stages') || '').split(',').filter(Boolean))]
  };

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
  const todayToronto = () => new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  const minimumRequiredDate = todayToronto;
  const displayDate = (value) => value ? (window.MBBS_I18N?.displayDateTime?.(value) || String(value)) : "—";
  const number = (value) => Number.isFinite(Number(value))
    ? new Intl.NumberFormat("en-CA", { maximumFractionDigits: 4 }).format(Number(value))
    : "0";
  const pill = (value) => `<span class="stock-request-pill ${escapeHtml(value || "pending")}">${escapeHtml(SPECIAL_STAGES[value] || String(value || "pending").replaceAll("_", " "))}</span>`;

  async function api(path, options = {}) {
    if (options.method && options.method !== 'GET') busyUI?.start(path, options.body);
    const response = await fetch(path, {
      cache: "no-store",
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      }
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
    if (options.method && options.method !== "GET") queue?.invalidate();
    return payload;
  }

  function header() {
    const operator = state.operator || {};
    return `<header class="dispatch-topbar">
      <div><p>Sales · Special Item</p><h1>Special Stock Requests</h1></div>
      <div class="topbar-language">${window.MBBS_I18N?.toggleHtml?.() || ""}</div>
      <div class="topbar-actions">
        <span class="dispatch-user">${escapeHtml(operator.display_name || operator.username || "")}</span>
        <button onclick="location.href='/sales'" type="button">Sales Menu</button>
        <button onclick="dispatchLogout()" type="button">Logout</button>
      </div>
    </header>`;
  }

  const money = value => value == null ? '—' : '$' + new Intl.NumberFormat('en-CA', {minimumFractionDigits:2,maximumFractionDigits:2}).format(value);
  const rateLabel = value => value == null ? '—' : '$' + new Intl.NumberFormat('en-CA', {minimumFractionDigits:2,maximumFractionDigits:6}).format(value);
  function refreshPricing() {
    for (const element of mount?.querySelectorAll('[data-special-composer-line], [data-special-material], [data-special-case-edit-line]') || []) {
      const value = name => element.querySelector(`[name=${name}]`)?.value;
      const output = element.querySelector('[data-special-subtotal]');
      if (!output) continue;
      try { output.textContent = money(specialLineSubtotal(value('quantity'), value('rate'), value('discountPercent'))); }
      catch { output.textContent = '—'; }
      const native = element.querySelector('[data-special-native]');
      if (native) {
        try {
          const line = state.soDraft?.materials.find(line => line.caseLineId === Number(element.dataset.specialMaterial));
          const price = specialNativePricing({quantity:value('quantity'),rate:value('rate'),discountPercent:value('discountPercent'),conversionToPc:line?.conversionToPc ?? 1});
          native.textContent = `NetSuite: ${number(price.quantity)} ${line?.legacy ? line.uom : 'PC'} × ${rateLabel(price.rate)} per unit${price.discountPercent ? ` · Custom Discount%: -${number(price.discountPercent)}%` : ''}`;
        } catch (error) { native.textContent = error.message; }
      }
    }
    const pallet = mount?.querySelector('[data-special-quote-pallet]');
    if (pallet) {
      const quantity = /** @type {HTMLInputElement} */ (pallet.querySelector('[name=palletTotal]'));
      const rate = /** @type {HTMLInputElement} */ (pallet.querySelector('[name=palletRate]'));
      const output = /** @type {HTMLOutputElement} */ (pallet.querySelector('[data-special-subtotal]'));
      rate.required = Number(quantity.value) > 0;
      try { output.textContent = money(Number(quantity.value) === 0 ? 0 : specialLineSubtotal(quantity.value, rate.value, 0)); }
      catch { output.textContent = '—'; }
    }
  }
  function quantityReviewNotice(detail) {
    if (!detail.quantityReviewPending) return '';
    return `<div class="stock-request-notice stock-request-error" role="status"><strong>Order adjustment · SCM review required</strong>
      ${(detail.quantityReview?.lines || []).map(line => `<p>${escapeHtml(line.productName)}: ${number(line.fromPackageQuantity)} → ${number(line.toPackageQuantity)} ${escapeHtml(line.packageUom)} (${number(line.fromQuantity)} → ${number(line.toQuantity)} ${escapeHtml(line.salesUom)})</p>`).join('')}
      ${(detail.quantityReview?.lines || []).filter(line=>line.fromDiscountPercent!==line.toDiscountPercent).map(line=>`<p>${escapeHtml(line.productName)} discount: ${number(line.fromDiscountPercent)}% → ${number(line.toDiscountPercent)}%</p>`).join('')}
      ${detail.quantityReview?.pallets ? `<p>PALLET: ${number(detail.quantityReview.pallets.fromQuantity)} → ${number(detail.quantityReview.pallets.toQuantity)} EACH</p>` : ''}
      <p>${escapeHtml(detail.quantityReview?.error || 'Order creation and Dispatch wait for SCM confirmation.')}</p></div>`;
  }
  function quantityProposalEditor(detail) {
    if (detail.closeStatus !== 'active' || detail.operationallyComplete || detail.remotelyReconciled || ['applying','attention'].includes(detail.quantityReview?.status)) return '';
    return `<form class="stock-request-form" data-special-quantity-form><h4>Request an order adjustment</h4><p>SCM confirms quantity, discount and PALLET changes. Original rates stay fixed.</p>
      ${detail.lines.filter(line=>line.salesDecision==='accepted').map(line=>`<article class="stock-request-line" data-special-material="${line.id}"><strong>MBBS-Special</strong><p>${escapeHtml(specialItemDescription(line))}</p><div class="special-sales-pricing-row">
        <label><span>Quantity (${escapeHtml(line.rateUom)}) *</span><input name="quantity" type="number" min="0.000001" step="0.000001" required value="${escapeHtml(detail.quantityReviewPending ? detail.quantityReview?.lines.find(change=>change.caseLineId===line.id)?.toPackageQuantity ?? line.packageQuantity : line.packageQuantity)}" /></label>
        <label><span>Original rate ($)</span><output class="special-fixed-value">${rateLabel(line.originalRate)}</output><input name="rate" type="hidden" value="${escapeHtml(line.originalRate)}" /></label><label><span>Discount (%)</span><input name="discountPercent" type="number" min="0" max="100" step="0.0001" required value="${escapeHtml(detail.quantityReviewPending ? detail.quantityReview?.lines.find(change=>change.caseLineId===line.id)?.toDiscountPercent ?? line.discountPercent : line.discountPercent)}" /></label>
        <label><span>Subtotal (before tax)</span><output data-special-subtotal></output></label></div></article>`).join('')}
      <div class="stock-request-line-fields"><label><span>PALLET quantity *</span><input name="palletTotal" type="number" min="0" max="1000000000" step="1" required value="${escapeHtml(detail.quantityReviewPending ? detail.quantityReview?.pallets?.toQuantity ?? detail.palletTotal ?? 0 : detail.palletTotal ?? 0)}" /><small>0 removes the PALLET line.</small></label><label><span>PALLET rate ($)</span>${detail.palletRate == null ? `<input name="palletRate" type="number" min="0" step="0.000001" value="${escapeHtml(detail.quantityReview?.pallets?.rate ?? '')}" /><small>Set the rate when adding PALLET for the first time.</small>` : `<output class="special-fixed-value">${rateLabel(detail.palletRate)}</output>`}</label></div>
      <button type="submit">Request adjustment</button></form>`;
  }

  function newLine() {
    return {
      key: crypto.randomUUID(), productName: "", color: "", size: "", detailSpec: "",
      palletQty: "", layerQty: "", sectionQty: "", pieceQty: "",
      quantity: "", uom: "PLT", rate: "", discountPercent: 0, requiredDate: minimumRequiredDate(), customerNote: ""
    };
  }

  function startComposer() {
    state.formDrafts.clear();
    state.copySource = null; state.addItemsDraft = null;
    state.caseEditDraft = null; state.caseEditSource = null;
    state.detail = null;
    state.soDraft = null;
    state.composer = {
      storeLocationId: String(state.yards[0]?.locationId || ""),
      inquiryDate: todayToronto(),
      expiresOn: defaultSpecialExpiry(todayToronto()),
      salesRepId: "",
      customerId: "",
      customerName: "",
      customerPhone: "",
      selectedCustomerName: "",
      selectedCustomerPhone: "",
      vendorId: "",
      vendorName: "",
      selectedVendorName: "",
      estimateId: "",
      palletTotal: 0, palletRate: "", deliveryFeeRate: "",
      remarks: "",
      salesInternalRemark: "",
      fulfillmentMethod: '', deliveryAddress: '', deliveryContactName: '', deliveryContactPhone: '',
      deliveryDate: '', windowStart: '', windowEnd: '', deliveryInstructions: '',
      lines: [newLine()]
    };
    state.caseCustomerResults = [];
    state.caseVendorResults = [];
    if(state.salesReps === null)void loadSalesReps();
    render();
  }

  function caseList() {
    if (state.loading && !state.requests.length) return `<div class="stock-request-empty"><strong>Loading Special Item cases…</strong></div>`;
    if (!state.requests.length) return `<div class="stock-request-empty"><strong>No matching Special Item cases</strong><span>Create a multi-line case for one vendor.</span></div>`;
    return state.requests.map((request) => `
      <button class="stock-request-card ${state.detail?.id === request.id ? "selected" : ""}" data-special-sales-action="select" data-id="${request.id}" type="button">
        <span class="stock-request-status-line"><strong>${escapeHtml(request.requestRef)}</strong>${pill(request.stage)}</span>${specialPlanningStatus(request, true)}
        <span>${escapeHtml(request.customerName)} · ${escapeHtml(request.vendorName)}</span>
        <small>${escapeHtml(request.storeName || request.storeLocationId)} · ${request.lines.length} line(s) · ${displayDate(request.updatedAt)}</small>${request.informationRequest?.status === 'pending' ? '<strong class="stock-request-error">SCM needs more information · Update required</strong>' : ''}${request.quantityReviewPending ? '<strong class="stock-request-error">Order adjustment · SCM review required</strong>' : ''}
      </button>`).join("");
  }

  /** @param {Record<string,any>} line @param {number} index @param {boolean} adding */
  function composerLine(line, index, adding = false) {
    const lines = (adding ? state.addItemsDraft : state.composer)?.lines || [];
    const removeAction = adding ? 'remove-added-line' : 'remove-case-line';
    return `<article class="stock-request-line" data-special-composer-line="${index}">
      <header><div><strong>MBBS-Special</strong><small>Line ${index + 1 + (adding ? state.detail?.lines.length || 0 : 0)}</small></div>${lines.length > 1 ? `<button class="danger" data-special-sales-action="${removeAction}" data-index="${index}" type="button">Remove</button>` : ""}</header>
      <div class="stock-request-line-fields special-case-initial-grid">
        <div class="special-case-product-row">
        <label><span>Product name *</span><input name="productName" required value="${escapeHtml(line.productName)}" /></label>
        <label><span>Colour</span><input name="color" value="${escapeHtml(line.color)}" /></label>
        <label><span>Size</span><input name="size" value="${escapeHtml(line.size)}" /></label>
        <label><span>Detail Spec</span><input name="detailSpec" maxlength="2000" value="${escapeHtml(line.detailSpec)}" /></label>
        </div>
        <div class="special-sales-pricing-row special-case-pricing-row">
        <label><span>Quantity *</span><input name="quantity" type="number" min="0.000001" step="any" required value="${escapeHtml(line.quantity)}" /></label>
        <label><span>Sales UOM *</span><select name="uom" required>${[["PLT", "Plt"], ["LYR", "lyr"], ["SEC", "Sec"], ["PCS", "Pcs"], ["EACH", "Each"], ["SQFT", "SQFT"]].map(([value, label]) => `<option value="${value}" ${line.uom === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
        <label><span>Sales rate per unit ($) *</span><input name="rate" type="number" min="0" step="0.000001" required value="${escapeHtml(line.rate)}" /></label>
        <label><span>Discount (%)</span><input name="discountPercent" type="number" min="0" max="100" step="0.0001" value="${escapeHtml(line.discountPercent)}" /></label>
        <label><span>Subtotal (before tax)</span><output data-special-subtotal></output></label></div>
        <div class="special-case-delivery-row"><label><span>Required date *</span><input name="requiredDate" type="date" min="${minimumRequiredDate()}" required value="${escapeHtml(line.requiredDate || minimumRequiredDate())}" /><small>Delivery requires at least three working days after SO placement, excluding weekends and Ontario public holidays.</small></label>
        <label><span>Line note</span><input name="customerNote" value="${escapeHtml(line.customerNote)}" /></label>
        ${[["palletQty","PLT"],["layerQty","LYR"],["sectionQty","SEC"],["pieceQty","PCS"]].map(([name,label])=>`<label><span>${label}</span><input name="${name}" type="number" min="0" max="1000000000" step="any" value="${escapeHtml(line[name])}" /></label>`).join("")}</div>
      </div>
    </article>`;
  }

  function salesRepField(draft) {
    return `<label><span>NetSuite Sales Rep *</span><select name="salesRepId" required ${state.salesRepsLoading ? 'disabled' : ''}><option value="">${state.salesRepsLoading ? 'Loading NetSuite reps…' : 'Choose a Sales Rep'}</option>${(state.salesReps || []).map(rep => `<option value="${rep.id}" ${String(draft.salesRepId) === String(rep.id) ? 'selected' : ''}>${escapeHtml(rep.name)}</option>`).join('')}</select>${state.salesRepsError ? `<small class="stock-request-error">${escapeHtml(state.salesRepsError)}</small>` : ''}<button type="button" data-special-sales-action="refresh-sales-reps">Refresh reps</button></label>`;
  }

  function composerView() {
    const draft = state.composer;
    if (!draft) return '';
    return `<form class="stock-request-form" data-special-case-form>
      <div class="stock-request-heading"><div><h2>New Special Item case</h2><p>One case may have many items, but every line must use the same vendor.</p></div><button data-special-sales-action="cancel-compose" type="button">Close</button></div>
      <div class="stock-request-line-fields special-case-initial-grid">
        <label><span>Inquiry store *</span><select name="storeLocationId" required>${state.yards.map((yard) => `<option value="${yard.locationId}" ${String(yard.locationId) === draft.storeLocationId ? "selected" : ""}>${escapeHtml(yard.yardCode)}</option>`).join("")}</select></label>
        <label><span>Case inquiry date *</span><input name="inquiryDate" type="date" required value="${escapeHtml(draft.inquiryDate)}" /></label>
        <label class="stock-request-item-search"><span>Customer *</span><input name="customerName" data-special-case-customer-search autocomplete="off" required value="${escapeHtml(draft.customerName)}" /><small>Choose a NetSuite customer or keep free text.</small><div class="stock-request-suggestions" data-special-case-customer-suggestions>${state.caseCustomerResults.map((customer) => `<button data-special-sales-action="choose-case-customer" data-customer-id="${customer.id}" data-customer-name="${escapeHtml(customer.displayName)}" data-customer-phone="${escapeHtml(customer.phone)}" type="button"><strong>${escapeHtml(customer.entityNumber)} · ${escapeHtml(customer.displayName)}</strong><small>${escapeHtml(customer.phone || customer.email || "No phone in NetSuite")}</small></button>`).join("")}</div></label>
        <label><span>Phone</span><input name="customerPhone" value="${escapeHtml(draft.customerPhone)}" /><small>Filled from the selected NetSuite customer; editable for free text.</small></label>
        <label class="stock-request-item-search"><span>Vendor *</span><input name="vendorName" data-special-case-vendor-search autocomplete="off" required value="${escapeHtml(draft.vendorName)}" /><small>Choose a synced NetSuite vendor or keep free text.</small><div class="stock-request-suggestions" data-special-case-vendor-suggestions>${state.caseVendorResults.map((vendor) => `<button data-special-sales-action="choose-case-vendor" data-vendor-id="${vendor.id || ""}" data-vendor-name="${escapeHtml(vendor.name)}" type="button"><strong>${escapeHtml(vendor.name)}</strong><small>${vendor.id ? `NetSuite vendor ${vendor.id}` : "Synced NetSuite vendor"}</small></button>`).join("")}</div></label>
        ${salesRepField(draft)}
        <label><span>Expiry date *</span><input name="expiresOn" type="date" min="${todayToronto()}" required value="${escapeHtml(draft.expiresOn)}" /><small>Auto-closes after this date if no SO or PO exists.</small></label>
        <div class="stock-request-wide special-request-notes"><label><span>Note</span><textarea name="remarks" rows="3" maxlength="8000">${escapeHtml(draft.remarks)}</textarea></label><label><span>Sales internal remark</span><textarea name="salesInternalRemark" rows="3" maxlength="8000">\n${escapeHtml(draft.salesInternalRemark)}</textarea><small>Visible to Sales only. Excluded from quotes and order documents.</small></label></div>
      </div>
      <div class="stock-request-line-fields">${fulfillmentFields(draft, true)}</div>
      <section class="stock-request-section"><h3>Requested items</h3><div class="stock-request-lines">${draft.lines.map((line,index) => composerLine(line,index)).join("")}
        <article class="stock-request-line" data-special-quote-pallet><header><strong>PALLET</strong></header>
          <div class="stock-request-line-fields"><label><span>PALLET quantity (EACH) *</span><input name="palletTotal" type="number" min="0" max="1000000000" step="1" required value="${escapeHtml(draft.palletTotal ?? 0)}" /><small>Use 0 to omit PALLET from the quote.</small></label>
          <label><span>PALLET sales rate ($)</span><input name="palletRate" type="number" min="0" max="1000000000" step="0.000001" ${Number(draft.palletTotal) > 0 ? 'required' : ''} value="${escapeHtml(draft.palletRate ?? '')}" /></label>
          <label><span>Subtotal (before tax)</span><output data-special-subtotal></output></label></div>
        </article>${deliveryFeeFields(draft)}</div></section>
      <div class="stock-request-actions special-document-actions"><button data-special-sales-action="add-case-line" type="button">Add line</button><button class="primary" type="submit" ${state.busy ? "disabled" : ""}>Submit to SCM</button><button data-special-document="draft_quote" type="button">Preview quote</button></div>
    </form>`;
  }

  function fulfillmentFields(draft, initial = false) {
    return `<label><span>Delivery method *</span><select name="fulfillmentMethod" ${initial ? 'data-special-initial-fulfillment' : 'data-special-fulfillment'} required><option value="">Select method</option>${[['vendor_pickup','Customer pickup at vendor yard'],['yard_pickup','Pickup at inquired yard'],['mbt_delivery','Delivery']].map(([value,label]) => `<option value="${value}" ${draft.fulfillmentMethod === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      ${draft.fulfillmentMethod === 'vendor_pickup' ? '<p>SCM will confirm the vendor pickup location during the stock check.</p>' : ''}
      ${draft.fulfillmentMethod === 'mbt_delivery' ? `<label class="stock-request-wide"><span>Delivery address *</span><input name="deliveryAddress" required value="${escapeHtml(draft.deliveryAddress)}" /></label>
      <label><span>Delivery contact name</span><input name="deliveryContactName" value="${escapeHtml(draft.deliveryContactName)}" /></label>
      <label><span>Delivery contact phone</span><input name="deliveryContactPhone" value="${escapeHtml(draft.deliveryContactPhone)}" /></label>
      <label><span>Preferred delivery date</span><input name="deliveryDate" type="date" min="${initial ? todayToronto() : earliestSpecialDeliveryDate()}" value="${escapeHtml(draft.deliveryDate)}" /><small>Minimum: three working days after SO placement, excluding weekends and Ontario public holidays.</small></label>
      <label><span>Window start</span><input name="windowStart" type="time" value="${escapeHtml(draft.windowStart)}" /></label>
      <label><span>Window end</span><input name="windowEnd" type="time" value="${escapeHtml(draft.windowEnd)}" /></label>
      <label class="stock-request-wide"><span>Delivery instructions</span><textarea name="deliveryInstructions">${escapeHtml(draft.deliveryInstructions)}</textarea></label>` : ''}`;
  }

  /** @param {Record<string,any>} draft @param {boolean} [required] */
  function deliveryFeeFields(draft, required = true) {
    if (draft.fulfillmentMethod !== 'mbt_delivery') return '';
    return `<article class="stock-request-line" data-special-delivery-fee>
      <header><strong>Delivery fee</strong></header><div class="stock-request-line-fields">
        <label><span>Delivery fee rate ($)${required ? ' *' : ''}</span><input name="deliveryFeeRate" type="number" min="0" max="1000000000" step="0.000001" ${required ? 'required' : ''} value="${escapeHtml(draft.deliveryFeeRate ?? '')}" /><small>Enter the customer charge. Use 0 for free delivery.</small></label>
      </div></article>`;
  }

  function canDecide(line) {
    if (!state.detail) return false;
    return state.detail.informationRequest?.status !== 'pending' && state.detail.closeStatus === 'active' && !state.detail.salesOrderId && !state.detail.salesOrderSkipped
      && line.supplyStatus && !['accepted', 'declined', 'closed'].includes(line.salesDecision);
  }

  function decisionForm(line) {
    if (!canDecide(line)) return '';
    const canAccept = specialStockAvailable(line.supplyStatus) || line.availableDate;
    return `<div class="stock-request-line-fields special-inline-form" data-special-decision-line="${line.id}">
      <label><span>Customer decision</span><select name="decision"><option value="">Select decision</option>${canAccept ? `<option value="accepted">${specialStockAvailable(line.supplyStatus) ? 'Customer confirms' : 'Customer will wait for ETA'}</option>` : ''}<option value="declined">Customer declines</option></select></label>
      <label><span>Reason (required unless accepted)</span><input name="reason" /></label>
      <label><span>Customer note</span><input name="customerNote" /></label>
    </div>`;
  }

  /** @param {Record<string,any>} line */
  function detailLine(line) {
    const product = specialItemDescription(line);
    return `<article class="stock-request-line">
      <header><div><strong>MBBS-Special</strong><small>${escapeHtml(product)}</small><small>${number(line.packageQuantity ?? line.quantity)} ${escapeHtml(line.rateUom || line.uom)}</small></div>${pill(line.salesDecision)}</header>
      <div class="stock-request-summary">
        <span><small>SCM supply</small><strong>${escapeHtml(line.supplyStatus === 'low_inventory' ? 'Low inventory' : line.supplyStatus === 'vendor_transfer' ? 'Wait for Transfer' : line.supplyStatus?.replaceAll("_", " ") || "Waiting")}</strong></span>
        <span><small>Projection</small><strong>${escapeHtml(line.availableDate || line.availabilityMode || "—")}</strong></span>
        <span><small>Vendor yard</small><strong>${escapeHtml(line.vendorYard || "—")}</strong></span>
        <span><small>Vendor ref</small><strong>${escapeHtml(line.vendorReference || "—")}</strong></span>
      </div>
      ${line.originalRate != null ? `<p>Original rate: ${rateLabel(line.originalRate)} / ${escapeHtml(line.rateUom)} · Discount: ${number(line.discountPercent)}% · Current subtotal: ${money(line.subtotal)}</p>` : ''}
      ${line.salesVisibleNote ? `<div class="stock-request-notice">${escapeHtml(line.salesVisibleNote)}</div>` : ""}
      ${line.itemResolution ? `<div class="stock-request-muted">Mapped to ${escapeHtml(line.itemResolution.itemName)} · ${number(line.itemResolution.salesQuantity)} ${escapeHtml(line.itemResolution.salesUom)}</div>` : ""}
      ${specialLineNotes(line)}
      ${decisionForm(line)}
    </article>`;
  }

  function ensureSoDraft() {
    if (state.soDraft || !state.detail) return;
    state.soDraftDirty = false;
    const detail = state.detail;
    state.soDraft = {
      source: detail.salesOrderSource === 'estimate_transform' ? 'estimate_transform' : 'standalone',
      customerId: detail.netsuiteCustomerId || detail.customerId || "",
      salesRepId: detail.netsuiteSalesRepId || "",
      customerSearch: detail.netsuiteCustomerName || detail.customerName || "",
      operationalYardLocationId: String(detail.operationalYardLocationId || detail.storeLocationId || state.yards[0]?.locationId || ""),
      fulfillmentMethod: detail.fulfillmentMethod || "yard_pickup",
      deliveryAddress: detail.deliveryAddress || "",
      deliveryContactName: detail.deliveryContactName || '', deliveryContactPhone: detail.deliveryContactPhone || '',
      palletTotal: detail.palletTotal ?? '', palletRate: detail.palletRate ?? '',
      deliveryFeeRate: savedSpecialDeliveryFee(detail) ?? '',
      deliveryDate: detail.deliveryDate || "",
      windowStart: detail.windowStart || "",
      windowEnd: detail.windowEnd || "",
      deliveryInstructions: detail.deliveryInstructions || "",
      materials: detail.lines.filter(line => line.salesDecision === 'accepted').map(line => ({
        caseLineId: line.id, itemId: 2055,
        description: line.itemResolution?.description || specialItemDescription(line),
        quantity: line.originalRate == null && line.pricingSource !== 'enquiry' ? line.itemResolution?.salesQuantity ?? line.quantity : line.packageQuantity ?? line.quantity,
        uom: line.rateUom || (line.pricingSource !== 'enquiry' ? line.itemResolution?.salesUom || 'PC' : line.uom),
        rate: line.originalRate ?? '', rateLocked: line.originalRate != null,
        discountPercent: line.discountPercent ?? 0, conversionToPc: line.conversionToPc ?? 1,
        legacy: line.pricingSource && line.pricingSource !== 'enquiry' 
      })),
      ancillaryLines: detail.salesOrderLines.filter(/** @param {Record<string,any>} line */ line => line.ancillary && line.itemId !== 1784 && line.itemId !== 1987).map(/** @param {Record<string,any>} line */ line => ({ ...line, key: crypto.randomUUID() })),
      media: detail.media.filter((media) => ["staged", "attached"].includes(media.status)).map((media) => ({ id: media.id, mimeType: media.mimeType, byteSize: media.byteSize }))
    };
  }

  function ancillaryEditor(line, index) {
    return `<article class="stock-request-line" data-special-ancillary="${index}">
      <header><strong>Ancillary line ${index + 1}</strong><button class="danger" data-special-sales-action="remove-ancillary" data-index="${index}" type="button">Remove</button></header>
      <div class="stock-request-line-fields">
        <label><span>Search item</span><input data-special-item-search data-index="${index}" value="${escapeHtml(line.itemName || "")}" /></label>
        <label><span>Item ID *</span><input name="itemId" type="number" min="1" required value="${escapeHtml(line.itemId || "")}" /></label>
        <label><span>Description</span><input name="description" value="${escapeHtml(line.description || "")}" /></label>
        <label><span>Quantity *</span><input name="quantity" type="number" min="0.000001" step="any" required value="${escapeHtml(line.quantity || 1)}" /></label>
        <label><span>UOM</span><input name="uom" value="${escapeHtml(line.uom || "EA")}" /></label>
        <label><span>Sales rate ($)</span><input name="rate" type="number" step="any" value="${escapeHtml(line.rate ?? "")}" /></label>
      </div>
      ${state.itemResults?.items?.length && Number(state.itemResults.index) === index ? `<div class="stock-request-suggestions special-static-suggestions">${state.itemResults.items.map((item) => `<button data-special-sales-action="choose-ancillary" data-index="${index}" data-item-id="${item.itemId}" data-item-name="${escapeHtml(item.itemName)}" type="button">${escapeHtml(item.itemName)} · ${escapeHtml(item.description)}</button>`).join("")}</div>` : ""}
    </article>`;
  }

  async function loadSalesReps() {
    if (state.salesRepsLoading) return;
    state.salesRepsLoading = true; state.salesRepsError = '';
    try { state.salesReps = (await api('/api/sales/special-stock-requests/sales-reps')).salesReps || []; }
    catch (error) { state.salesReps = []; state.salesRepsError = error.message; }
    finally { syncCaseComposerFromDom(); syncSoFromDom(); state.salesRepsLoading = false; render(); }
  }

  function soEditor() {
    ensureSoDraft();
    const draft = state.soDraft;
    const detail = state.detail;
    const canEdit = !detail.salesOrderId && !detail.salesOrderSkipped;
    if (!canEdit) return quantityProposalEditor(detail);
    if (!draft || !draft.materials.length) return "";
    if (state.salesReps === null) void loadSalesReps();
    return `<section class="stock-request-section special-order-editor"><h3>Create or link Sales Order</h3>
      ${detail?.lineDecisionsNeedReview ? '<p class="stock-request-notice">Line decisions changed. Save the SO draft before creating or linking an order.</p>' : ''}
      <form class="stock-request-form" data-special-so-form>
        <div class="stock-request-line-fields">
          <input name="customerId" type="hidden" value="${escapeHtml(draft.customerId)}" />
          <label class="stock-request-item-search"><span>NetSuite customer account *</span><input name="customerSearch" data-special-customer-search required value="${escapeHtml(draft.customerSearch)}" autocomplete="off" /><small>Select the account for the NetSuite SO. The original request customer stays unchanged.</small><div class="stock-request-suggestions" data-special-customer-suggestions></div></label>
          ${salesRepField(draft)}
          <label><span>Operational yard *</span><select name="operationalYardLocationId">${state.yards.map((yard) => `<option value="${yard.locationId}" ${String(yard.locationId) === String(draft.operationalYardLocationId) ? "selected" : ""}>${escapeHtml(yard.yardCode)}</option>`).join("")}</select></label>
          ${fulfillmentFields(draft)}
          ${draft.fulfillmentMethod === 'mbt_delivery' ? `<label><span>Delivery photos or video</span><input data-special-media type="file" multiple accept="image/*,video/mp4,video/quicktime,video/webm" /><small>${draft.media.length} staged files</small></label>` : ''}
        </div>
        <h4>Accepted materials</h4>
        <div class="stock-request-lines">${draft.materials.map(line => `<article class="stock-request-line" data-special-material="${line.caseLineId}"><strong>MBBS-Special</strong><div class="stock-request-line-fields special-so-material-fields">
          <label class="stock-request-wide"><span>Sales description *</span><input name="description" required value="${escapeHtml(line.description)}" /></label>
          <div class="special-sales-pricing-row">
          <label><span>Quantity (${escapeHtml(line.uom)}) *</span><input name="quantity" type="number" min="0.000001" step="any" required value="${escapeHtml(line.quantity)}" /><input name="uom" type="hidden" value="${escapeHtml(line.uom)}" /></label>
          <label><span>Original rate ($)</span>${line.rateLocked ? `<output class="special-fixed-value">${rateLabel(line.rate)}</output><input name="rate" type="hidden" value="${escapeHtml(line.rate)}" />` : `<input name="rate" type="number" min="0" step="0.000001" required value="${escapeHtml(line.rate)}" /><small>Enter the initial rate once.</small>`}</label>
          <label><span>Discount (%)</span><input name="discountPercent" type="number" min="0" max="100" step="0.0001" value="${escapeHtml(line.discountPercent)}" /></label>
          <label><span>Subtotal (before tax)</span><output data-special-subtotal></output></label></div>
          <p class="stock-request-wide" data-special-native></p></div></article>`).join('')}</div>
        <div class="stock-request-line-fields"><label><span>Pallets needed *</span><input name="palletTotal" type="number" min="0" step="1" required value="${escapeHtml(draft.palletTotal)}" /><small>0 omits the PALLET line.</small></label>
        <label><span>PALLET unit price ($, required when pallets &gt; 0)</span><input name="palletRate" type="number" min="0" step="any" value="${escapeHtml(draft.palletRate)}" /></label></div>
        ${deliveryFeeFields(draft)}
        <h4>Other ancillary items</h4>
        <div class="stock-request-lines">${draft.ancillaryLines.map(ancillaryEditor).join("")}</div>
        <div class="stock-request-actions"><button data-special-sales-action="add-ancillary" type="button">Add ancillary item</button><button class="primary" type="submit">Save SO draft</button></div>
      </form>
      ${detail.salesOrderLines.length ? `<div class="stock-request-actions"><select data-special-so-source><option value="standalone" ${draft.source === "standalone" ? "selected" : ""}>Create standalone SO</option>${detail.estimateId ? `<option value="estimate_transform" ${draft.source === "estimate_transform" ? "selected" : ""}>Transform estimate ${escapeHtml(detail.estimateNumber || detail.estimateId)}</option>` : ""}</select><button class="primary" data-special-sales-action="create-so" type="button" ${state.soDraftDirty || detail.quantityReviewPending || detail?.lineDecisionsNeedReview ? 'disabled' : ''}>Create in NetSuite</button>${state.testSkipOrdersEnabled && !['creating','attention'].includes(detail.salesOrderOperationStatus) ? `<button data-special-sales-action="skip-so" type="button" ${state.soDraftDirty || detail.quantityReviewPending || detail?.lineDecisionsNeedReview ? 'disabled' : ''}>Skip SO creation</button>` : ''}</div>` : ""}
      <p class="stock-request-muted" id="special-so-action-status" data-special-so-action-status role="status" hidden></p>
      <form class="stock-request-line-fields special-inline-form" data-special-link-so-form><label class="stock-request-item-search"><span>Search active Sales Order</span><input data-special-so-link-search autocomplete="off" /><div class="stock-request-suggestions" data-special-so-link-suggestions></div></label><label><span>Existing SO internal ID</span><input name="salesOrderId" type="number" min="1" required /></label><label><span>SO number</span><input name="salesOrderRef" required /></label><button type="submit" ${detail.quantityReviewPending || detail?.lineDecisionsNeedReview ? 'disabled' : ''}>Link existing SO</button></form>
    </section>`;
  }

  function expiryEditor(detail) {
    if(!detail.expiresOn)return '';
    const editable=detail.closeStatus==='active' && !detail.salesOrderId && !detail.purchaseOrderId && !detail.salesOrderSkipped && !detail.purchaseOrderSkipped && !detail.operationallyComplete;
    return editable ? `<form class="stock-request-summary special-expiry-form" data-special-expiry-form><label><span>Expiry date</span><input name="expiresOn" type="date" min="${todayToronto()}" required value="${escapeHtml(detail.expiresOn)}" /></label><button type="submit">Save expiry</button><small>Auto-close only while no SO or PO exists.</small></form>` : `<p class="stock-request-muted">Expiry: ${escapeHtml(detail.expiresOn)} · ${detail.closeStatus === 'closed' ? 'Request closed' : 'Automatic expiry stops once an order exists.'}</p>`;
  }

  /** @param {SpecialRequestModel} detail */
  function addItemsView(detail) {
    if (!state.addItemsDraft) return '';
    const allowed = canAddSpecialItems(detail);
    return `<form class="stock-request-form special-add-items-form" data-special-add-items-form>
      <h3>New items</h3><p>Existing items will be kept. Submit the new items to return this request to New enquiry for SCM review.</p>
      ${allowed ? '' : '<p class="stock-request-error">This request can no longer accept new items. Your entered items are shown below; cancel to continue working.</p>'}
      <fieldset class="special-add-items-fields" ${allowed ? '' : 'disabled'}><div class="stock-request-lines">${state.addItemsDraft.lines.map((line,index) => composerLine(line,index,true)).join('')}</div></fieldset>
      <div class="stock-request-actions"><button type="button" data-special-sales-action="add-another-item" ${allowed ? '' : 'disabled'}>Add another item</button><button class="special-add-item-button" type="submit" ${allowed ? '' : 'disabled'}>Submit new items to SCM</button><button type="button" data-special-sales-action="cancel-add-items">Cancel</button></div>
    </form>`;
  }

  /** @param {SpecialRequestModel} detail @param {boolean} showSaveDecisions @param {boolean} showAddItems */
  function caseLinesView(detail, showSaveDecisions, showAddItems) {
    const draft = state.caseEditDraft;
    if (detail.salesOrderId && !draft) return specialRequestLineNotes(detail);
    const editable = canEditSpecialCaseLines(detail) && !state.addItemsDraft;
    const heading = `<div class="stock-request-actions"><h3>Case lines</h3>${editable && !draft ? '<button type="button" data-special-sales-action="edit-case-lines">Edit case lines</button>' : ''}</div>`;
    if (!draft) return `<section class="stock-request-section">${heading}<form data-special-decisions-form><div class="stock-request-lines">${detail.lines.map(detailLine).join('')}${specialRequestPalletLine(/** @type {Parameters<typeof specialRequestPalletLine>[0]} */ (detail))}</div>${showSaveDecisions || showAddItems ? `<div class="stock-request-actions special-case-line-actions">${showSaveDecisions ? '<button class="primary" type="submit">Save customer decisions</button>' : ''}${showAddItems ? '<button class="special-add-item-button" type="button" data-special-sales-action="add-items">Add item</button>' : ''}</div>` : ''}</form></section>`;
    const fresh = editable && draft.expectedRevision === detail.revision;
    const source = /** @type {SpecialRequestModel} */ (state.caseEditSource);
    return `<section class="stock-request-section">${heading}<form class="stock-request-form" data-special-case-edit-form>
      <p>Material name or quantity changes return this request to New enquiry. Sales rate, PALLET quantity or rate, delivery fee, and decline or revoke changes keep its current status.</p>
      ${fresh ? '' : '<p class="stock-request-error">This request changed while you were editing. Your entries are kept below. Cancel edits and reopen the editor to use the latest request.</p>'}
      <div class="stock-request-lines">${draft.lines.map(line => {
        const saved = /** @type {Record<string,any>} */ (source.lines.find(item => item.id === line.lineId));
        const declined = draft.decisions.find(value => value.lineId === line.lineId)?.declined === true;
        const decision = declined ? 'declined' : saved.salesDecision === 'declined' ? revokeSpecialLineDecision(saved) : saved.salesDecision;
        return `<article class="stock-request-line${declined ? ' special-case-line-declined' : ''}" data-special-case-edit-line="${line.lineId}">
          <header><div><strong>MBBS-Special</strong><small>${escapeHtml([saved.color, saved.size, saved.detailSpec].filter(Boolean).join(' '))}</small></div>${declined ? '<span class="stock-request-pill declined">Declined</span>' : pill(decision)}</header>
          <div class="stock-request-line-fields">
            <label><span>Product name *</span><input name="productName" required maxlength="500" value="${escapeHtml(line.productName)}" /></label>
            <label><span>Quantity * (${escapeHtml(saved.rateUom || saved.uom)})</span><input name="quantity" type="number" min="0.000001" max="1000000000" step="0.000001" required value="${escapeHtml(line.quantity)}" /></label>
            <label><span>Sales rate${saved.originalRate == null ? '' : ' *'}</span><input name="rate" type="number" min="0" max="1000000000" step="0.000001" ${saved.originalRate == null ? '' : 'required'} value="${escapeHtml(line.rate)}" />${saved.originalRate == null ? '<small>Enter a sales rate when changing this item.</small>' : ''}</label>
          </div><input name="discountPercent" type="hidden" value="${escapeHtml(saved.discountPercent || 0)}" />
          <p>Discount: ${number(saved.discountPercent || 0)}% · Subtotal: <output data-special-subtotal></output></p>
          ${specialLineNotes(saved)}
          <div class="special-case-line-decision-actions"><button type="button" data-special-sales-action="toggle-case-decline" data-line-id="${line.lineId}" ${fresh && saved.salesDecision !== 'closed' ? '' : 'disabled'}>${declined ? 'Revoke decline' : 'Decline'}</button></div>
        </article>`;
      }).join('')}
      <article class="stock-request-line special-quote-pallet" data-special-quote-pallet>
        <header><strong>PALLET</strong><small>EACH</small></header><div class="stock-request-line-fields">
          <label><span>PALLET quantity</span><input name="palletTotal" type="number" min="0" max="1000000000" step="1" required value="${escapeHtml(draft.pallet.quantity)}" /></label>
          <label><span>PALLET sales rate</span><input name="palletRate" type="number" min="0" max="1000000000" step="0.000001" value="${escapeHtml(draft.pallet.rate ?? '')}" /></label>
          <label><span>PALLET subtotal</span><output data-special-subtotal></output></label>
        </div>
      </article>${deliveryFeeFields({ fulfillmentMethod: source.fulfillmentMethod, deliveryFeeRate: draft.deliveryFeeRate }, savedSpecialDeliveryFee(source) != null)}</div>
      <div class="stock-request-actions"><button class="primary" type="submit" ${fresh ? '' : 'disabled'}>Save line changes</button><button type="button" data-special-sales-action="cancel-case-edits">Cancel edits</button></div>
    </form></section>`;
  }

  function detailView() {
    const detail = state.detail;
    if (!detail) return `<div class="stock-request-empty"><strong>Select a Special Item case</strong><span>SCM responses, customer decisions, SO, PO, and fulfillment progress appear here.</span></div>`;
    const showSaveDecisions = detail.lines.some(canDecide);
    const showAddItems = canAddSpecialItems(detail) && !state.addItemsDraft;
    return `<div class="stock-request-heading"><div><div class="special-request-title"><h2>${escapeHtml(detail.requestRef)}</h2><button type="button" data-special-sales-action="copy-request">Copy the request</button></div><p>${escapeHtml(detail.customerName)} · ${escapeHtml(detail.vendorName)}</p></div>${pill(detail.stage)}</div>
      ${specialFulfillmentEditor(detail, {
        before: `<span><small>Original customer</small><strong>${escapeHtml(detail.customerName)}</strong><small>${escapeHtml(detail.customerPhone || "—")}</small></span><span><small>Inquiry store</small><strong>${escapeHtml(detail.storeName)}</strong></span>`,
        after: `<span><small>Inquiry date</small><strong>${escapeHtml(detail.inquiryDate)}</strong></span>
          ${detail.estimateId ? `<span><small>Existing NetSuite Quote ID</small><strong>${escapeHtml(detail.estimateId)}</strong></span>` : ''}
          <span><small>Sales Rep</small><strong>${escapeHtml(detail.netsuiteSalesRepName || detail.requestedByName || "—")}</strong></span>${detail.netsuiteCustomerName ? `<span><small>NetSuite customer account</small><strong>${escapeHtml(detail.netsuiteCustomerName)}</strong></span>` : ""}<span><small>Revision</small><strong>${detail.revision}</strong></span>`
      })}
      ${expiryEditor(detail)}
      ${detail.salesOrderSkipped || detail.purchaseOrderSkipped ? `<div class="stock-request-notice">Test request: ${detail.salesOrderSkipped ? 'SO creation skipped. ' : ''}${detail.purchaseOrderSkipped ? 'PO creation skipped. ' : ''}Skipped orders are excluded from live Dispatch.</div>` : ''}
      ${detail.attention ? `<div class="stock-request-notice stock-request-error">${escapeHtml(detail.attentionReason)}</div>` : ''}
      ${specialInformationPanel(detail, 'sales')}${specialPlanningStatus(detail)}${specialClosureStatus(detail, 'sales')}
      ${quantityReviewNotice(detail)}
      ${detail.closeStatus === "closed" && detail.closureReason ? `<div class="stock-request-notice">Closed: ${escapeHtml(detail.closureReason)}</div>` : ''}
      ${detail.postPoChangePending ? `<div class="stock-request-notice stock-request-error"><strong>Vendor changed availability after PO:</strong> ${escapeHtml(JSON.stringify(detail.postPoChangeDetails))}<form data-special-ack-form><input name="acknowledgement" required placeholder="Customer acknowledgement" /><button type="submit">Record acknowledgement</button></form></div>` : ""}
      ${caseLinesView(detail, showSaveDecisions, showAddItems)}
      ${addItemsView(detail)}
      ${detail.informationRequest?.status !== 'pending' && !state.caseEditDraft && (detail.salesOrderId || detail.salesOrderSkipped || (detail.closeStatus === 'active' && detail.lines.every(line => ['accepted','declined','closed'].includes(line.salesDecision)))) ? soEditor() : ''}
      ${(detail.purchaseOrderId || detail.purchaseOrderSkipped) ? `<section class="stock-request-section"><h3>Fulfillment</h3><div class="stock-request-summary"><span><small>Dispatch route</small><strong>${escapeHtml(detail.handoffRoute || (detail.fulfillmentMethod === "vendor_pickup" ? "Not required" : "Waiting Dispatch"))}</strong></span><span><small>Completion</small><strong>${detail.operationallyComplete ? "Operationally complete" : "In progress"}</strong></span></div>${detail.vendorPickupDate ? `<div class="stock-request-muted">Customer pickup: ${escapeHtml(detail.vendorPickupDate)} · ${escapeHtml(detail.vendorPickupReference)}</div>` : ""}</section>` : ""}
      ${(detail.purchaseOrderId || detail.purchaseOrderSkipped) && (!detail.purchaseOrderId || detail.purchaseOrderApproved !== false) && detail.fulfillmentMethod === "vendor_pickup" && !detail.operationallyComplete && detail.lines.filter(line => line.salesDecision === "accepted").every(line => specialStockAvailable(line.supplyStatus)) ? `<form class="stock-request-line-fields special-inline-form" data-special-vendor-pickup-form><label><span>Customer pickup date *</span><input name="pickupDate" type="date" required value="${todayToronto()}" /></label><label><span>Pickup reference / evidence *</span><input name="pickupReference" required /></label><button class="primary" type="submit">Complete vendor pickup</button></form>` : ""}
      ${canRequestSpecialClosure(detail) ? `<form class="stock-request-line-fields special-inline-form" data-special-close-form><label><span>Close reason</span><input name="reason" required value="${escapeHtml(detail.closureReason || '')}" /></label><button class="danger" type="submit">${detail.closeStatus === "closure_pending" ? "Retry SO closure" : detail.purchaseOrderId ? "Request closure · SCM confirmation" : detail.salesOrderId ? "Close SO and case" : "Close case"}</button></form>` : ""}
      ${detail.closeStatus === "closure_pending" && !detail.closureReview?.id ? `<div class="stock-request-notice">SO closure has not completed. Use Retry SO closure to finish.</div>` : ""}
      ${!detail.salesOrderId ? specialDocumentActions(detail) : ''}`;
  }

  function render() {
    if (window.MBBSSalesStockActiveTab === "regular") return;
    const restoreScroll = preserveSpecialScroll?.(/** @type {HTMLElement} */ (mount));
    if (state.detail) state.requests = state.requests.map(request => request.id === state.detail.id ? state.detail : request)
      .filter(request => !state.stages.length || state.stages.includes(request.stage))
      .sort((a,b) => Number(Boolean(b.quantityReviewPending)) - Number(Boolean(a.quantityReviewPending)));
    if (state.enabled === false) {
      mount.innerHTML = `${header()}<section class="stock-request-page"><div class="stock-request-tabs"><button aria-selected="true" type="button">Special</button><button data-special-sales-action="regular" type="button">Regular</button></div><div class="stock-request-empty"><strong>Special Item workflow is off</strong><span>An administrator must enable special_stock_request_workflow after reviewing NetSuite mappings.</span></div></section>`;
      return;
    }
    mount.innerHTML = `${header()}<section class="stock-request-page special-stock-page">
      <div class="stock-request-tabs"><button aria-selected="true" type="button">Special</button><button data-special-sales-action="regular" type="button">Regular</button></div>
      <div class="stock-request-toolbar"><div class="stock-request-actions"><input class="stock-request-search" data-special-search value="${escapeHtml(state.search)}" placeholder="Search case, customer, vendor, SO, PO, or item" />${yardFilterHtml(state.yards, state.storeLocationIds)}${vendorFilterHtml(state.vendors, state.vendorNames)}${stageFilterHtml(state.stages)}<label class="special-own-filter"><input type="checkbox" data-special-mine ${state.mine ? "checked" : ""}> My requests</label><button class="primary" data-special-sales-action="new" type="button">New Special case</button><button data-special-sales-action="refresh" type="button">Refresh</button></div></div>
      <div class="stock-request-feedback">${state.notice ? `<div class="stock-request-notice">${escapeHtml(state.notice)}</div>` : ""}${state.error ? `<div class="stock-request-notice stock-request-error">${escapeHtml(state.error)}</div>` : ""}</div>
      <div class="stock-request-workspace"><aside class="stock-request-panel stock-request-list">${caseList()}</aside><section class="stock-request-panel stock-request-detail">${state.composer ? composerView() : detailView()}</section></div>
    </section>`;
    restoreSpecialForms?.(/** @type {HTMLElement} */ (mount), state.formDrafts);
    syncSpecialFulfillmentForm(/** @type {HTMLElement} */ (mount).querySelector('[data-special-fulfillment-form]'), state.detail?.revision);
    syncSpecialInternalRemarkForm(/** @type {HTMLElement} */ (mount).querySelector('[data-special-internal-remark-form]'), state.detail?.revision);
    for (const group of mount.querySelectorAll('[data-special-decision-line]')) updateDecisionReason(group);
    refreshPricing();
    syncSoActionAvailability();
    busyUI?.render();
    restoreScroll?.();
  }

  const active = () => window.MBBSSalesStockActiveTab !== 'regular';
  const editing = () => state.busy || state.confirmingAddItems || Boolean(state.addItemsDraft) || Boolean(state.caseEditDraft) || (!busyUI?.remote() && (Boolean(state.composer) || state.soDraftDirty || state.formDrafts.size > 0));
  const queueKey = () => new URLSearchParams({ search: state.search, stages: state.stages.join(','), storeLocationIds: state.storeLocationIds.join(','), vendorNames: JSON.stringify(state.vendorNames), mine: state.mine ? '1' : '' }).toString();

  async function initializeQueue() {
    if (queue) return;
    const {createSpecialQueueLoader,watchSpecialQueue} = await queueReady;
    if (queue) return;
    queue = createSpecialQueueLoader({
      read: (key,signal) => api(`/api/sales/special-stock-requests?${key}`, {signal}),
      blocked: () => !active() || editing(),
      loading: value => { state.loading = value; if (value && !state.requests.length) render(); },
      error: error => { state.error = error.message; render(); },
      accept: payload => {
        const selectedId = state.detail?.id;
        state.yards = payload.yards || state.yards;
        state.vendors = payload.vendors || [];
        state.requests = payload.requests || [];
        state.detail = state.requests.find(row => row.id === selectedId) || state.requests[0] || null;
        state.error = ''; state.soDraft = null; state.soDraftDirty = false;
        render();
      }
    });
    watchSpecialQueue({queue,key:queueKey,requests:()=>state.requests,active,audience:'sales'});
  }

  async function load({selectedId,force=false} = {}) {
    await initializeQueue();
    if (force) queue.invalidate();
    if (editing()) {
      queue.invalidate();
      if (force) { state.notice = 'Finish your current edits before refreshing the queue.'; render(); }
      return;
    }
    if (selectedId === null) state.detail = null;
    await queue.load(queueKey(), {force});
  }

  function selectCase(id) {
    const detail = state.requests.find(row => String(row.id) === String(id));
    if (!detail || detail.id === state.detail?.id) return;
    state.formDrafts.clear(); state.composer = null; state.soDraft = null; state.soDraftDirty = false;
    state.copySource = null; state.addItemsDraft = null;
    state.caseEditDraft = null; state.caseEditSource = null;
    state.detail = detail; state.error = ''; state.notice = '';
    render();
    if (queue?.pending) void load();
  }

  function syncCaseComposerFromDom() {
    const form = mount.querySelector("[data-special-case-form]");
    if (!form || !state.composer) return;
    const values = new FormData(form);
    for (const field of ["palletTotal", "palletRate", "deliveryFeeRate", "storeLocationId", "inquiryDate", "expiresOn", "salesRepId", "customerName", "customerPhone", "vendorName", "estimateId", "remarks", "salesInternalRemark", "fulfillmentMethod", "deliveryAddress", "deliveryContactName", "deliveryContactPhone", "deliveryDate", "windowStart", "windowEnd", "deliveryInstructions"]) {
      if (values.has(field)) state.composer[field] = values.get(field) || "";
    }
    for (const element of form.querySelectorAll("[data-special-composer-line]")) {
      const line = state.composer.lines[Number(element.dataset.specialComposerLine)];
      for (const input of element.querySelectorAll("[name]")) line[input.name] = input.value;
    }
  }

  function syncAddedItemsFromDom() {
    const form = mount?.querySelector('[data-special-add-items-form]');
    if (!form || !state.addItemsDraft) return;
    for (const element of /** @type {NodeListOf<HTMLElement>} */ (form.querySelectorAll('[data-special-composer-line]'))) {
      const line = state.addItemsDraft.lines[Number(element.dataset.specialComposerLine)];
      for (const input of /** @type {NodeListOf<HTMLInputElement|HTMLSelectElement>} */ (element.querySelectorAll('[name]'))) line[input.name] = input.value;
    }
  }

  function syncCaseEditsFromDom() {
    const form = mount?.querySelector('[data-special-case-edit-form]'), draft = state.caseEditDraft;
    if (!form || !draft) return;
    for (const element of /** @type {NodeListOf<HTMLElement>} */ (form.querySelectorAll('[data-special-case-edit-line]'))) {
      const line = /** @type {typeof draft.lines[number]} */ (draft.lines.find(item => item.lineId === Number(element.dataset.specialCaseEditLine)));
      for (const field of /** @type {Array<'productName'|'quantity'|'rate'>} */ (['productName', 'quantity', 'rate'])) {
        line[field] = /** @type {HTMLInputElement} */ (element.querySelector(`[name=${field}]`)).value;
      }
    }
    draft.pallet.quantity = /** @type {HTMLInputElement} */ (form.querySelector('[name=palletTotal]')).value;
    draft.pallet.rate = /** @type {HTMLInputElement} */ (form.querySelector('[name=palletRate]')).value;
    const fee = /** @type {HTMLInputElement|null} */ (form.querySelector('[name=deliveryFeeRate]'));
    if (fee) draft.deliveryFeeRate = fee.value;
  }

  function syncSoFromDom() {
    const form = mount.querySelector("[data-special-so-form]");
    if (!form || !state.soDraft) return;
    const values = new FormData(form);
    for (const field of ["customerId", "customerSearch", "salesRepId", "operationalYardLocationId", "fulfillmentMethod", "deliveryAddress", "deliveryDate", "windowStart", "windowEnd", "deliveryInstructions", "deliveryContactName", "deliveryContactPhone", "palletTotal", "palletRate", "deliveryFeeRate"]) {
      if (values.has(field)) state.soDraft[field] = values.get(field) || "";
    }
    for (const element of form.querySelectorAll("[data-special-material]")) {
      const material = state.soDraft.materials.find((line) => line.caseLineId === Number(element.dataset.specialMaterial));
      for (const input of element.querySelectorAll("[name]")) material[input.name] = input.value;
    }
    for (const element of form.querySelectorAll("[data-special-ancillary]")) {
      const line = state.soDraft.ancillaryLines[Number(element.dataset.specialAncillary)];
      for (const input of element.querySelectorAll("[name]")) line[input.name] = input.value;
    }
  }

  async function uploadMedia(files) {
    if (!files?.length) return;
    if (!window.DeliveryInstructionUpload) throw new Error("The media preparation tool did not load.");
    syncSoFromDom();
    const prepared = await window.DeliveryInstructionUpload.prepareFiles([...files]);
    for (const file of prepared) {
      const ticket = await api(`/api/sales/special-stock-requests/${state.detail.id}/media-ticket`, {
        method: "POST", body: JSON.stringify({ mimeType: file.type, byteSize: file.size })
      });
      const formData = new FormData();
      formData.append("file", file, file.name);
      const response = await fetch(ticket.upload.uploadUrl, { method: "POST", headers: { Authorization: `Bearer ${ticket.upload.token}` }, body: formData });
      const text = await response.text();
      let uploaded;
      try { uploaded = text ? JSON.parse(text) : null; } catch { uploaded = null; }
      if (!response.ok || !uploaded?.key) throw new Error(uploaded?.error || text || "Media upload failed.");
      state.detail = await api(`/api/sales/special-stock-requests/${state.detail.id}/media`, {
        method: "POST",
        body: JSON.stringify({ id: ticket.id, objectRef: `r2://${uploaded.key}`, mimeType: file.type, byteSize: file.size })
      });
    }
    state.soDraft.media = state.detail.media.filter(media => ['staged', 'attached'].includes(media.status))
      .map(media => ({ id: media.id, mimeType: media.mimeType, byteSize: media.byteSize }));
  }

  function replaceSuggestions(selector, html) {
    const target = mount.querySelector(selector);
    if (target) target.innerHTML = html;
  }

  function markSoDraftDirty() {
    state.soDraftDirty = true;
    syncSoActionAvailability();
  }

  function syncSoActionAvailability() {
    const reason = state.detail?.lineDecisionsNeedReview ? 'Line decisions changed. Save the SO draft before continuing.'
      : state.soDraftDirty ? 'Save the updated SO draft before continuing.'
      : !state.detail?.salesOrderSubmissionStartedAt && (!state.soDraft?.salesRepId || !(state.salesReps || []).some(rep => String(rep.id) === String(state.soDraft.salesRepId))) ? 'Choose an active NetSuite Sales Rep and save the SO draft.'
      : state.detail?.quantityReviewPending ? 'Quantity changed. Waiting for SCM confirmation before creating or skipping the SO.'
        : state.busy || state.loading ? 'Please wait for the current action to finish.' : '';
    for (const button of mount.querySelectorAll('[data-special-sales-action="create-so"], [data-special-sales-action="skip-so"]')) {
      button.disabled = Boolean(reason);
      button.title = reason;
      button.setAttribute('aria-describedby', 'special-so-action-status');
    }
    const message = mount.querySelector('[data-special-so-action-status]');
    if (message) {
      message.textContent = reason;
      message.hidden = !reason;
    }
  }

  mount.addEventListener("input", (event) => {
    if ((/** @type {HTMLElement|null} */ (event.target))?.closest('[data-special-composer-line], [data-special-material], [data-special-quote-pallet], [data-special-case-edit-line]')) refreshPricing();
    if ((/** @type {HTMLElement|null} */ (event.target))?.closest('[data-special-case-edit-form]')) { syncCaseEditsFromDom(); return; }
    if (event.target.closest('[data-special-so-form]')) markSoDraftDirty();
    if (event.target.matches("[data-special-case-customer-search]")) {
      syncCaseComposerFromDom();
      const search = event.target.value;
      if (search !== state.composer.selectedCustomerName) {
        state.composer.customerId = "";
        if (state.composer.customerPhone === state.composer.selectedCustomerPhone) {
          state.composer.customerPhone = "";
          const phone = mount.querySelector("[data-special-case-form] [name=customerPhone]");
          if (phone) phone.value = "";
        }
        state.composer.selectedCustomerName = "";
        state.composer.selectedCustomerPhone = "";
      }
      window.clearTimeout(state.caseCustomerTimer);
      state.caseCustomerTimer = window.setTimeout(async () => {
        try {
          const payload = await api(`/api/sales/special-stock-requests/customers?search=${encodeURIComponent(search)}`);
          const current = mount.querySelector("[data-special-case-customer-search]");
          if (!current || current.value !== search) return;
          state.caseCustomerResults = payload.customers || [];
          replaceSuggestions("[data-special-case-customer-suggestions]", state.caseCustomerResults.map((customer) => `<button data-special-sales-action="choose-case-customer" data-customer-id="${customer.id}" data-customer-name="${escapeHtml(customer.displayName)}" data-customer-phone="${escapeHtml(customer.phone)}" type="button"><strong>${escapeHtml(customer.entityNumber)} · ${escapeHtml(customer.displayName)}</strong><small>${escapeHtml(customer.phone || customer.email || "No phone in NetSuite")}</small></button>`).join(""));
        } catch (error) {
          replaceSuggestions("[data-special-case-customer-suggestions]", `<small>${escapeHtml(error.message)}</small>`);
        }
      }, 250);
    }
    if (event.target.matches("[data-special-case-vendor-search]")) {
      syncCaseComposerFromDom();
      const search = event.target.value;
      if (search !== state.composer.selectedVendorName) {
        state.composer.vendorId = "";
        state.composer.selectedVendorName = "";
      }
      window.clearTimeout(state.caseVendorTimer);
      state.caseVendorTimer = window.setTimeout(async () => {
        try {
          const payload = await api(`/api/sales/special-stock-requests/vendors?search=${encodeURIComponent(search)}`);
          const current = mount.querySelector("[data-special-case-vendor-search]");
          if (!current || current.value !== search) return;
          state.caseVendorResults = payload.vendors || [];
          replaceSuggestions("[data-special-case-vendor-suggestions]", state.caseVendorResults.map((vendor) => `<button data-special-sales-action="choose-case-vendor" data-vendor-id="${vendor.id || ""}" data-vendor-name="${escapeHtml(vendor.name)}" type="button"><strong>${escapeHtml(vendor.name)}</strong><small>${vendor.id ? `NetSuite vendor ${vendor.id}` : "Synced NetSuite vendor"}</small></button>`).join(""));
        } catch (error) {
          replaceSuggestions("[data-special-case-vendor-suggestions]", `<small>${escapeHtml(error.message)}</small>`);
        }
      }, 250);
    }
    if (event.target.matches("[data-special-customer-search]")) {
      syncSoFromDom();
      state.soDraft.customerSearch = event.target.value;
      state.soDraft.customerId = '';
      event.target.form.querySelector('[name=customerId]').value = '';
      state.customerResults = [];
      replaceSuggestions('[data-special-customer-suggestions]', '');
      const search = state.soDraft.customerSearch;
      const requestId = state.detail.id;
      const draft = state.soDraft;
      window.clearTimeout(state.customerTimer);
      state.customerTimer = window.setTimeout(async () => {
        try {
          const payload = await api(`/api/sales/special-stock-requests/customers?search=${encodeURIComponent(search)}`);
          if (state.detail?.id !== requestId || state.soDraft !== draft || state.soDraft?.customerSearch !== search || state.soDraft.customerId) return;
          state.customerResults = payload.customers || [];
          replaceSuggestions('[data-special-customer-suggestions]', state.customerResults.map(customer => `<button data-special-sales-action="choose-customer" data-id="${customer.id}" data-name="${escapeHtml(customer.displayName)}" type="button"><strong>${escapeHtml(customer.entityNumber)} · ${escapeHtml(customer.displayName)}</strong></button>`).join(''));
        } catch (error) {
          if (state.soDraft === draft && state.soDraft.customerSearch === search) replaceSuggestions('[data-special-customer-suggestions]', `<small>${escapeHtml(error.message)}</small>`);
        }
      }, 250);
    }
    if (event.target.matches("[data-special-item-search]")) {
      const index = Number(event.target.dataset.index);
      syncSoFromDom();
      state.soDraft.ancillaryLines[index].itemName = event.target.value;
      const search = event.target.value;
      window.clearTimeout(state.itemTimer);
      state.itemTimer = window.setTimeout(async () => {
        try {
          const payload = await api(`/api/sales/special-stock-requests/items?search=${encodeURIComponent(search)}`);
          if (state.soDraft?.ancillaryLines?.[index]?.itemName !== search) return;
          state.itemResults = { index, items: payload.items || [] };
          render();
        } catch (error) { state.error = error.message; render(); }
      }, 250);
    }
    if (event.target.matches("[data-special-so-link-search]")) {
      const search = event.target.value;
      window.clearTimeout(state.soLinkTimer);
      state.soLinkTimer = window.setTimeout(async () => {
        try {
          const payload = await api(`/api/sales/special-stock-requests/order-links?kind=sales_order&search=${encodeURIComponent(search)}`);
          const current = mount.querySelector("[data-special-so-link-search]");
          if (!current || current.value !== search) return;
          const html = (payload.orders || []).map((order) => `<button data-special-sales-action="choose-so-link" data-order-id="${order.id}" data-order-ref="${escapeHtml(order.ref)}" type="button"><strong>${escapeHtml(order.ref)} · ${escapeHtml(order.entityName)}</strong><small>${escapeHtml(order.status)}</small></button>`).join("");
          replaceSuggestions("[data-special-so-link-suggestions]", html);
        } catch (error) {
          replaceSuggestions("[data-special-so-link-suggestions]", `<small>${escapeHtml(error.message)}</small>`);
        }
      }, 250);
    }
    rememberSpecialForm?.(state.formDrafts, event.target.closest('form'));
  });

  function updateDecisionReason(group) {
    group.querySelector('[name=reason]').required = group.querySelector('[name=decision]').value === 'declined';
  }

  mount.addEventListener("change", async (event) => {
    if ((/** @type {HTMLElement|null} */ (event.target))?.closest('[data-special-case-edit-form]')) { syncCaseEditsFromDom(); refreshPricing(); return; }
    if(event.target.matches("[data-special-mine]")){state.mine=event.target.checked;await load({selectedId:null});return;}
    if(event.target.matches('[data-special-fulfillment-form] [name=fulfillmentMethod]')) syncSpecialFulfillmentForm(event.target.closest('form'));
    if (event.target.matches('[data-special-decision-line] [name=decision]')) updateDecisionReason(event.target.closest('[data-special-decision-line]'));
    if (event.target.matches('[data-special-vendor]')) {
      const vendor=event.target.value;
      state.vendorNames = event.target.checked ? [...new Set([...state.vendorNames,vendor])] : state.vendorNames.filter(name=>name!==vendor);
      await load({selectedId:null});
      const filter=mount.querySelector('.special-vendor-filter');if(filter)filter.open=true;
      return;
    }
    if (event.target.matches('[data-special-yard]')) {
      state.storeLocationIds = [...mount.querySelectorAll('[data-special-yard]:checked')].map(input => input.value);
      await load({selectedId: null});
      const filter = mount.querySelector('[data-yard-filter="storeLocationIds"]');
      if (filter) filter.open = true;
      return;
    }
    if (event.target.closest('[data-special-so-form]') || event.target.matches('[data-special-so-source]')) markSoDraftDirty();
    if (event.target.matches('[data-special-so-source]') && state.soDraft) state.soDraft.source = event.target.value;
    rememberSpecialForm?.(state.formDrafts, event.target.closest('form'));
    if (event.target.matches('[data-special-initial-fulfillment]')) { syncCaseComposerFromDom(); render(); }
    if (event.target.matches("[data-special-fulfillment]")) {
      syncSoFromDom();
      render();
    }
    if (event.target.matches("[data-special-media]")) {
      state.busy = true;
      state.error = "";
      try { await uploadMedia(event.target.files); state.notice = "Delivery media staged."; } catch (error) { state.error = error.message; }
      state.busy = false; busyUI?.end();
      render();
    }
    if (event.target.matches("[data-special-stage]")) { state.stages = [...mount.querySelectorAll("[data-special-stage]:checked")].map(input => input.value); await load({ selectedId: null }); mount.querySelector(".special-stage-filter").open = true; }
  });

  mount.addEventListener("submit", async (event) => {
    const form = /** @type {HTMLFormElement} */ (event.target);
    if (state.busy) { event.preventDefault(); return; }
    if (!form.matches("[data-special-internal-remark-form], [data-special-information-reply-form], [data-special-case-form], [data-special-case-edit-form], [data-special-add-items-form], [data-special-expiry-form], [data-special-fulfillment-form], [data-special-decisions-form], [data-special-so-form], [data-special-link-so-form], [data-special-close-form], [data-special-ack-form], [data-special-vendor-pickup-form], [data-special-quantity-form]")) return;
    event.preventDefault();
    state.busy = true;
    syncSoActionAvailability();
    state.error = "";
    if (!form.matches('[data-special-case-edit-form]')) rememberSpecialForm(state.formDrafts, form);
    try {
      if (form.matches('[data-special-internal-remark-form]')) {
        const detail = state.detail;
        if (!detail) throw new Error('Select a request before saving the internal remark.');
        const values = Object.fromEntries(new FormData(form));
        if (Number(values.expectedRevision) !== detail.revision) throw new Error('This request changed. Reload the remark before saving.');
        state.detail = await api(`/api/sales/special-stock-requests/${detail.id}/internal-remark`, { method: 'PUT', body: JSON.stringify(values) });
        state.notice = 'Sales internal remark saved.';
      } else if (form.matches('[data-special-information-reply-form]')) {
        const detail = state.detail;
        if (!detail) throw new Error('Select a request before submitting the information update.');
        if (state.formDrafts.size > 1 || state.caseEditDraft) throw new Error('Save or cancel your case edits before submitting the information update.');
        const values = Object.fromEntries(new FormData(form));
        state.detail = await api(`/api/sales/special-stock-requests/${detail.id}/information-update`, {
          method: 'POST', body: JSON.stringify({ expectedRevision: detail.revision, reply: values.reply })
        });
        state.notice = 'Information sent to SCM. Stock checking can resume.';
      } else if (form.matches("[data-special-case-form]") && state.composer) {
        syncCaseComposerFromDom();
        /** @type {Record<string,any>} */
        const payload = {
          ...state.composer,
          storeLocationId: Number(state.composer.storeLocationId),
          customerId: state.composer.customerId ? Number(state.composer.customerId) : null,
          vendorId: state.composer.vendorId ? Number(state.composer.vendorId) : null,
          estimateId: state.composer.estimateId ? Number(state.composer.estimateId) : null,
          lines: state.composer.lines.map((line) => ({ ...line, quantity: Number(line.quantity), rate: Number(line.rate) }))
        };
        for (const field of ["selectedCustomerName", "selectedCustomerPhone", "selectedVendorName"]) delete payload[field];
        const detail = await api("/api/sales/special-stock-requests", { method: "POST", body: JSON.stringify(payload) });
        state.composer = null;
        state.copySource = null;
        state.notice = `${detail.requestRef} submitted to SCM.`;
        state.detail = detail; state.requests = [detail, ...state.requests.filter(row => row.id !== detail.id)];
        state.formDrafts.clear(); return;
      }
      if (form.matches('[data-special-case-edit-form]') && state.caseEditDraft && state.detail) {
        if (state.formDrafts.has('data-special-fulfillment-form:')) throw new Error('The header has unsaved changes. Cancel case edits, save the header, then reopen the line editor.');
        syncCaseEditsFromDom();
        const draft = state.caseEditDraft;
        if (!canEditSpecialCaseLines(state.detail) || draft.expectedRevision !== state.detail.revision) throw new Error('Cancel edits and reopen the editor to use the latest request.');
        const plan = planSpecialCaseEdits(/** @type {SpecialRequestModel} */ (state.caseEditSource), draft);
        if (!plan.lines.length && !plan.pallet && plan.deliveryFeeRate === undefined && !plan.decisions?.length) {
          state.caseEditDraft = null; state.caseEditSource = null;
          state.formDrafts.delete(specialFormKey(form)); state.notice = 'No line changes to save.'; return;
        }
        if (plan.restart && !await confirmSpecialCaseRestart()) return;
        state.detail = await api(`/api/sales/special-stock-requests/${state.detail.id}/case-lines`, {
          method: 'PUT', body: JSON.stringify({ expectedRevision: draft.expectedRevision,
            lines: plan.lines.map(line => ({ lineId: line.lineId, productName: line.productName, quantity: line.quantity, rate: line.rate })),
            ...(plan.pallet ? { pallet: plan.pallet } : {}),
            ...(plan.decisions?.length ? { decisions: plan.decisions } : {}),
            ...(plan.deliveryFeeRate !== undefined ? { deliveryFeeRate: plan.deliveryFeeRate } : {}) })
        });
        state.caseEditDraft = null; state.caseEditSource = null; state.soDraft = null; state.soDraftDirty = false;
        state.formDrafts.clear();
        state.notice = plan.restart ? 'Line changes saved. The request is now New enquiry; changed items need a new SCM review.' : 'Line changes saved. Request status and stock checks are kept.';
      } else if (form.matches('[data-special-add-items-form]') && state.addItemsDraft && state.detail) {
        syncAddedItemsFromDom();
        const detail = await api(`/api/sales/special-stock-requests/${state.detail.id}/items`, {
          method:'POST',body:JSON.stringify({expectedRevision:state.detail.revision,lines:state.addItemsDraft.lines})
        });
        state.detail = detail; state.addItemsDraft = null; state.soDraft = null; state.soDraftDirty = false;
        state.notice = 'New items submitted to SCM. The request is now New enquiry; existing item details are saved.';
      } else if (form.matches("[data-special-expiry-form]")) {
        state.detail=await api(`/api/sales/special-stock-requests/${state.detail.id}/expiry`,{method:"PUT",body:JSON.stringify({expectedRevision:state.detail.revision,expiresOn:new FormData(form).get("expiresOn")})});
        state.notice="Expiry date saved.";
      } else if (form.matches("[data-special-decisions-form]")) {
        const lines = [.../** @type {NodeListOf<HTMLElement>} */ (form.querySelectorAll('[data-special-decision-line]'))].map(group => ({
          lineId: Number(group.dataset.specialDecisionLine),
          ...Object.fromEntries([.../** @type {NodeListOf<HTMLInputElement|HTMLSelectElement>} */ (group.querySelectorAll('[name]'))].map(input => [input.name, input.value]))
        })).filter(line => /** @type {Record<string,unknown>} */ (line).decision);
        if (!lines.length) throw new Error('Select at least one customer decision to save.');
        state.detail = await api(`/api/sales/special-stock-requests/${state.detail.id}/customer-decisions`, {
          method: 'POST', body: JSON.stringify({ expectedRevision: state.detail.revision, lines })
        });
        state.notice = 'Customer decisions saved.';
        state.soDraft = null;
      } else if (form.matches("[data-special-so-form]")) {
        syncSoFromDom();
        const draft = state.soDraft;
        if (!draft.customerId) throw new Error('Select a NetSuite Customer from the suggestions.');
        state.detail = await api(`/api/sales/special-stock-requests/${state.detail.id}/sales-order-draft`, {
          method: "PUT",
          body: JSON.stringify({
            expectedRevision: state.detail.revision,
            customerId: Number(draft.customerId),
            salesRepId: Number(draft.salesRepId),
            operationalYardLocationId: Number(draft.operationalYardLocationId),
            fulfillmentMethod: draft.fulfillmentMethod,
            deliveryAddress: draft.deliveryAddress,
            deliveryContactName: draft.deliveryContactName, deliveryContactPhone: draft.deliveryContactPhone,
            palletTotal: draft.palletTotal, palletRate: draft.palletRate,
            deliveryFeeRate: draft?.deliveryFeeRate,
            deliveryDate: draft.deliveryDate,
            windowStart: draft.windowStart,
            windowEnd: draft.windowEnd,
            deliveryInstructions: draft.deliveryInstructions,
            media: draft.media,
            materialLines: draft.materials.map(line => {
              const price = specialNativePricing({ quantity: line.quantity, rate: line.rate, discountPercent: line.discountPercent, conversionToPc: line.conversionToPc });
              return { ...line, packageQuantity: line.quantity, quantity: price.quantity, uom: line.legacy ? line.uom : 'PC' };
            }),
            ancillaryLines: draft.ancillaryLines.map((line) => ({ itemId: Number(line.itemId), description: line.description, quantity: Number(line.quantity), uom: line.uom, rate: Number(line.rate) }))
          })
        });
        state.soDraft = null;
        ensureSoDraft();
        state.soDraft.source = draft.source;
        state.notice = "Sales Order draft saved.";
      } else if(form.matches('[data-special-fulfillment-form]')) {
        const detail = state.detail;
        if (!detail) throw new Error('Select a request before saving the header.');
        const header = form.hasAttribute('data-special-header-form');
        if (header && (state.caseEditDraft || state.addItemsDraft)) throw new Error('Save or cancel your item edits before saving the header.');
        syncSoFromDom();
        const values=Object.fromEntries(new FormData(form));
        const change=state.detail.fulfillmentChange;
        const expected = header ? Number(values.expectedRevision) : detail.revision;
        if (expected !== detail.revision) throw new Error('This request changed. Reload the header before saving.');
        const changed = Object.entries(values).some(([field,value]) => field !== 'expectedRevision' && String(value) !== String(detail[field] ?? ''));
        if (header && !changed) { state.notice = 'Header is already saved.'; state.formDrafts.delete(specialFormKey(form)); return; }
        state.detail=await api(`/api/sales/special-stock-requests/${detail.id}/${header ? 'header' : 'fulfillment'}`,{method:header ? 'PUT' : 'POST',body:JSON.stringify({
          ...values,expectedRevision:expected,...(!header && ['applying','attention'].includes(change?.status)?{changeId:change.id}:{})
        })});
        if(state.soDraft) for(const field of ['fulfillmentMethod','deliveryAddress','deliveryContactName','deliveryContactPhone','deliveryDate','windowStart','windowEnd','deliveryInstructions']) state.soDraft[field]=state.detail[field];
        state.formDrafts.delete('data-special-so-form:');state.notice=header ? 'Header saved. Request status and stock checks are kept.' : 'Delivery method saved.';
      } else if (form.matches('[data-special-quantity-form]') && state.detail) {
        state.detail = await api(`/api/sales/special-stock-requests/${state.detail.id}/quantity-change`, { method: 'POST', body: JSON.stringify({
          expectedRevision: state.detail.revision, palletTotal: /** @type {HTMLInputElement} */ (form.querySelector('[name=palletTotal]')).value,
          palletRate: /** @type {HTMLInputElement|null} */ (form.querySelector('[name=palletRate]'))?.value,
          lines: [.../** @type {NodeListOf<HTMLElement>} */ (form.querySelectorAll('[data-special-material]'))].map(element => ({
            caseLineId: Number(element.dataset.specialMaterial), quantity: /** @type {HTMLInputElement} */ (element.querySelector('[name=quantity]')).value,
            discountPercent: /** @type {HTMLInputElement} */ (element.querySelector('[name=discountPercent]')).value
          }))
        }) });
        state.soDraft = null; state.notice = 'Order adjustment sent to SCM for confirmation.';
      } else if (form.matches("[data-special-link-so-form]")) {
        const values = Object.fromEntries(new FormData(form));
        state.detail = await api(`/api/sales/special-stock-requests/${state.detail.id}/sales-order/link`, {
          method: "POST", body: JSON.stringify({ expectedRevision: state.detail.revision, salesOrderId: Number(values.salesOrderId), salesOrderRef: values.salesOrderRef })
        });
      } else if (form.matches("[data-special-close-form]")) {
        const values = Object.fromEntries(new FormData(form));
        state.detail = await api(`/api/sales/special-stock-requests/${state.detail.id}/close`, {
          method: "POST", body: JSON.stringify({ expectedRevision: state.detail.revision, reason: values.reason })
        });
      } else if (form.matches("[data-special-ack-form]")) {
        const values = Object.fromEntries(new FormData(form));
        state.detail = await api(`/api/sales/special-stock-requests/${state.detail.id}/post-po-change/acknowledge`, {
          method: "POST", body: JSON.stringify({ expectedRevision: state.detail.revision, acknowledgement: values.acknowledgement })
        });
      } else if (form.matches("[data-special-vendor-pickup-form]")) {
        const values = Object.fromEntries(new FormData(form));
        state.detail = await api(`/api/sales/special-stock-requests/${state.detail.id}/vendor-pickup/complete`, {
          method: "POST",
          body: JSON.stringify({ expectedRevision: state.detail.revision, pickupDate: values.pickupDate, pickupReference: values.pickupReference })
        });
        state.notice = "Customer pickup completion recorded.";
      }
      state.formDrafts.delete(specialFormKey(form));
    } catch (error) {
      state.error = error.message;
      if (state.detail) state.detail = await api(`/api/sales/special-stock-requests/${state.detail.id}`).catch(() => state.detail);
    } finally {
      state.busy = false; busyUI?.end();
      render();
      if (queue?.pending && !editing()) void load();
    }
  });

  mount.addEventListener("click", async (event) => {
    if (event.target.closest('[data-special-clear-vendors]')) { state.vendorNames=[];await load({selectedId:null});return; }
    if (event.target.closest('[data-yard-filter-clear="storeLocationIds"]')) { state.storeLocationIds = []; await load({selectedId: null}); return; }
    if (event.target.closest('[data-special-clear-stages]')) { state.stages = []; await load({ selectedId: null }); return; }
    const button = event.target.closest("[data-special-sales-action]");
    if (!button || state.busy || state.confirmingAddItems || button.disabled) return;
    const action = button.dataset.specialSalesAction;
    if (action === "select") return selectCase(button.dataset.id);
    if (action === "refresh") return load({force:true});
    if (['create-so','skip-so'].includes(action) && (state.soDraftDirty || state.detail?.quantityReviewPending || state.detail?.lineDecisionsNeedReview)) {
      state.error = 'Save the updated SO draft and finish any SCM quantity review before continuing.';
      return render();
    }
    try {
      if (action === "regular") return window.MBBSSalesRegularStock.open();
      if (action === "new") return startComposer();
      if (action === 'copy-request' && state.detail) {
        const source = state.detail;
        const draft = copySpecialRequestDraft(source);
        startComposer(); state.copySource = source; state.composer = draft;
        state.notice = `Copied from ${source.requestRef}. Review the dates and click Submit to SCM to create a new request.`;
        state.error = ''; return render();
      }
      if (action === 'edit-case-lines' && state.detail) {
        if (state.formDrafts.has('data-special-fulfillment-form:')) throw new Error('Save header before editing case lines.');
        if (!canEditSpecialCaseLines(state.detail)) throw new Error('Case lines can only be edited before Sales Order creation.');
        if (state.soDraftDirty || state.addItemsDraft) throw new Error('Save or cancel your current item or Sales Order draft edits first.');
        state.caseEditSource = state.detail; state.caseEditDraft = specialCaseEditDraft(state.detail);
        state.error = ''; state.notice = ''; return render();
      }
      if (action === 'toggle-case-decline' && state.caseEditDraft && state.detail) {
        if (!canEditSpecialCaseLines(state.detail) || state.caseEditDraft.expectedRevision !== state.detail.revision) return;
        const id = Number(button.dataset.lineId), saved = state.caseEditSource?.lines.find(line => line.id === id);
        if (!saved || saved.salesDecision === 'closed') return;
        syncCaseEditsFromDom();
        const decision = state.caseEditDraft.decisions.find(line => line.lineId === id);
        if (!decision) return;
        decision.declined = !decision.declined;
        state.formDrafts.delete('data-special-case-edit-form:'); return render();
      }
      if (action === 'cancel-case-edits') {
        state.caseEditDraft = null; state.caseEditSource = null;
        state.formDrafts.delete('data-special-case-edit-form:'); return render();
      }
      if (action === 'add-items') {
        if (state.formDrafts.has('data-special-fulfillment-form:')) throw new Error('Save header before adding items.');
        state.confirmingAddItems = true;
        let confirmed;
        try { confirmed = await confirmSpecialAddItems(); } finally { state.confirmingAddItems = false; }
        if (!confirmed) return;
        state.addItemsDraft = {lines:[newLine()]}; state.notice = ''; state.error = ''; return render();
      }
      if (action === 'add-another-item' && state.addItemsDraft) { syncAddedItemsFromDom(); state.addItemsDraft.lines.push(newLine()); return render(); }
      if (action === 'remove-added-line' && state.addItemsDraft) { syncAddedItemsFromDom(); state.addItemsDraft.lines.splice(Number(button.dataset.index),1); state.formDrafts.delete('data-special-add-items-form:'); return render(); }
      if (action === 'cancel-add-items') { state.addItemsDraft = null; state.formDrafts.delete('data-special-add-items-form:'); return render(); }
      if (action === 'reload-header') { state.formDrafts.delete('data-special-fulfillment-form:'); state.error = ''; state.notice = ''; return render(); }
      if (action === 'reload-internal-remark') { state.formDrafts.delete('data-special-internal-remark-form:'); state.error = ''; state.notice = ''; return render(); }
      if (action === "cancel-compose") { state.detail = state.copySource || state.detail; state.copySource = null; state.composer = null; state.notice = ''; state.formDrafts.clear(); return render(); }
      if (action === "add-case-line") { syncCaseComposerFromDom(); state.composer.lines.push(newLine()); return render(); }
      if (action === "remove-case-line") { syncCaseComposerFromDom(); state.formDrafts.clear(); state.composer.lines.splice(Number(button.dataset.index), 1); return render(); }
      if (action === "choose-case-customer") {
        syncCaseComposerFromDom();
        state.composer.customerId = button.dataset.customerId || "";
        state.composer.customerName = button.dataset.customerName;
        state.composer.customerPhone = button.dataset.customerPhone || "";
        state.composer.selectedCustomerName = button.dataset.customerName;
        state.composer.selectedCustomerPhone = button.dataset.customerPhone || "";
        state.caseCustomerResults = [];
        state.formDrafts.delete('data-special-case-form:');
        return render();
      }
      if (action === "choose-case-vendor") {
        syncCaseComposerFromDom();
        state.composer.vendorId = button.dataset.vendorId || "";
        state.composer.vendorName = button.dataset.vendorName;
        state.composer.selectedVendorName = button.dataset.vendorName;
        state.caseVendorResults = [];
        state.formDrafts.delete('data-special-case-form:');
        return render();
      }
      if (action === "choose-customer") {
        markSoDraftDirty();
        syncSoFromDom();
        state.soDraft.customerId = Number(button.dataset.id); state.soDraft.customerSearch = button.dataset.name; state.customerResults = [];
        const form = mount.querySelector('[data-special-so-form]');
        form.querySelector('[name=customerId]').value = button.dataset.id;
        form.querySelector('[data-special-customer-search]').value = button.dataset.name;
        rememberSpecialForm(state.formDrafts, /** @type {HTMLFormElement|null} */ (form));
        replaceSuggestions('[data-special-customer-suggestions]', '');
        return;
      }
      if (action === "choose-so-link") {
        const form = mount.querySelector("[data-special-link-so-form]");
        form.querySelector("[name=salesOrderId]").value = button.dataset.orderId;
        form.querySelector("[name=salesOrderRef]").value = button.dataset.orderRef;
        form.querySelector("[data-special-so-link-search]").value = button.dataset.orderRef;
        replaceSuggestions("[data-special-so-link-suggestions]", "");
        return;
      }
      if (action === "add-ancillary") { markSoDraftDirty(); syncSoFromDom(); state.soDraft.ancillaryLines.push({ key: crypto.randomUUID(), itemId: "", itemName: "", description: "", quantity: 1, uom: "EA", rate: "" }); return render(); }
      if (action === "remove-ancillary") { markSoDraftDirty(); syncSoFromDom(); state.formDrafts.delete('data-special-so-form:'); state.soDraft.ancillaryLines.splice(Number(button.dataset.index), 1); return render(); }
      if (action === "choose-ancillary") {
        markSoDraftDirty();
        syncSoFromDom();
        const line = state.soDraft.ancillaryLines[Number(button.dataset.index)];
        line.itemId = Number(button.dataset.itemId); line.itemName = button.dataset.itemName;
        state.formDrafts.delete('data-special-so-form:');
        state.itemResults = [];
        return render();
      }
      if (action === "refresh-sales-reps") { syncSoFromDom(); return loadSalesReps(); }
      state.busy = true;
      state.error = "";
      syncSoActionAvailability();
      if (action === "create-so") {
        const source = mount.querySelector("[data-special-so-source]")?.value || "standalone";
        state.detail = await api(`/api/sales/special-stock-requests/${state.detail.id}/sales-order/create`, {
          method: "POST", body: JSON.stringify({ expectedRevision: state.detail.revision, operationId: state.detail.salesOrderOperationId || crypto.randomUUID(), source, salesRepId: state.soDraft?.salesRepId || state.detail.netsuiteSalesRepId })
        });
        state.notice = `${state.detail.salesOrderRef} linked to this case.`;
      } else if (action === 'skip-so') {
        state.detail = await api(`/api/sales/special-stock-requests/${state.detail.id}/sales-order/skip`, {
          method: 'POST', body: JSON.stringify({ expectedRevision: state.detail.revision })
        });
        state.formDrafts.clear(); state.soDraft = null;
        state.notice = 'SO creation skipped for testing.';
      } else if (action === "refresh-so") {
        state.detail = await api(`/api/sales/special-stock-requests/${state.detail.id}/sales-order/refresh`, { method: "POST", body: "{}" });
      }
    } catch (error) {
      state.error = error.message;
      if (state.detail) state.detail = await api(`/api/sales/special-stock-requests/${state.detail.id}`).catch(() => state.detail);
    } finally {
      state.busy = false; busyUI?.end();
      render();
      if (queue?.pending && !editing()) void load();
    }
  });

  mount.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !event.target.matches("[data-special-search]")) return;
    event.preventDefault();
    state.search = event.target.value;
    load({ selectedId: null }).catch((error) => { state.error = error.message; render(); });
  });

  window.MBBSSalesSpecialStock = {
    async open({ operator, yards } = {}) {
      window.MBBSSalesRegularStock?.suspend();
      window.MBBSSalesStockActiveTab = "special";
      const url = new URL(location.href); url.searchParams.set("tab", "special"); history.replaceState(null, "", url);
      if (!busyUI) {
        const { installSpecialBusyState } = await busyReady;
        busyUI = installSpecialBusyState(mount, { getDetail: () => state.detail, getLocalBusy: () => state.busy });
      }
      ({ SPECIAL_STAGES, stageFilterHtml, specialStockAvailable } = await workflowReady);
      ({ specialInformationPanel } = await informationReady);
      ({ yardFilterHtml } = await yardFilterReady);
      ({ vendorFilterHtml } = await vendorFilterReady);
      ({ specialItemDescription } = await lineDetailsReady);
      ({ specialRequestPalletLine, savedSpecialDeliveryFee } = await palletDisplayReady);
      ({ defaultSpecialExpiry } = await expiryReady);
      ({ specialFormKey, rememberSpecialForm, restoreSpecialForms, preserveSpecialScroll } = await formsReady);
      ({ canAddSpecialItems, copySpecialRequestDraft, confirmSpecialAddItems } = await requestActionsReady);
      ({ canEditSpecialCaseLines, specialCaseEditDraft, planSpecialCaseEdits, confirmSpecialCaseRestart, revokeSpecialLineDecision } = await caseEditsReady);
      ({ specialLineNotes, specialRequestLineNotes } = await lineNotesReady);
      ({ specialDiscountLineSubtotal: specialLineSubtotal, specialNativeLinePricing: specialNativePricing, earliestSpecialDeliveryDate } = await pricingReady);
      state.operator = operator || state.operator;
      state.yards = yards || state.yards;
      if (state.enabled !== null) { render(); if (state.enabled) await load(); return; }
      state.loading = true;
      render();
      try {
        const policy = await api("/api/sales/special-stock-requests/policy");
        state.enabled = policy.enabled === true;
        state.testSkipOrdersEnabled = policy.testSkipOrdersEnabled === true;
        if (state.enabled) await load(); else { state.loading = false; render(); }
      } catch (error) {
        state.error = error.message;
        state.loading = false;
        render();
      }
    }
  };
})();

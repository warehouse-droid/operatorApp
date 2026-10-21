(() => {
  const mount = document.getElementById("scmStockRequestApp");
  if (!mount) return;

  import('/special-stock-detail-display.js?v=20260928-display-v1').then(module => {
    module.installSpecialDetailDisplay(mount, () => state.operator?.id);
  });

  const busyReady = import('/special-stock-busy.js');
  let busyUI;
  const queueReady = import(new URL('/special-stock-queue.js?v=20261006-stable-view', location.href).href);
  let queue;
  const informationReady = import(new URL('/special-stock-information.js?conversation=20261016&v=20261002-stock-updates-v1', location.href).href);
  /** @type {typeof import('./special-stock-information.js').specialInformationPanel} */
  let specialInformationPanel = () => '';
  /** @type {typeof import('./special-stock-workflow.js').specialStockAvailable} */
  let specialStockAvailable;
  const transferEtaReady = import('/special-stock-transfer-eta.js?v=20261016');
  let isSpecialTransferEta, specialSupplyEtaLabel;
  const workflowReady = import(new URL('/special-stock-workflow.js?v=20261002-stock-updates-v1&filterApply=20261010-v1', location.href).href);
  const lineFieldsReady = import(new URL('/special-stock-line-fields.js?v=20261003-scm-lines-v1&compactStockCheck=20261013-v1', location.href).href);
  const caseEditsReady = import(new URL('/special-stock-case-edits.js?v=20261009-stock-check-revision-v1', location.href).href);
  /** @type {typeof import('./special-stock-case-edits.js').canEditSpecialCaseLines} */
  let canEditSpecialCaseLines;
  /** @type {typeof import('./special-stock-line-fields.js').specialLineFields} */
  let specialLineFields;
  /** @type {typeof import('./special-stock-line-fields.js').specialLineFieldValues} */
  let specialLineFieldValues;
  /** @type {typeof import('./special-stock-line-fields.js').specialAdjustmentFieldSummary} */
  let specialAdjustmentFieldSummary;
  const lineDetailsReady = import('/special-stock-line-details.js?v=20261001-po-mini-rows-v1');
  /** @type {typeof import('./special-stock-line-details.js').specialItemDescription} */
  let specialItemDescription;
  const palletDisplayReady = import(new URL('/special-stock-pallet-display.js?v=20261001-delivery-fee-v1', location.href).href);
  /** @type {typeof import('./special-stock-pallet-display.js').specialRequestPalletLine} */
  let specialRequestPalletLine;
  const vendorFilterReady = import('/stock-request-vendor-filter.js?v=20260928-enhancements-v1&filterApply=20261010-v1');
  let vendorFilterHtml = () => '';
  const yardFilterReady = import('/stock-request-yard-filter.js?v=20260927&filterApply=20261010-v1');
  let yardFilterHtml = () => '';
  let vendorDiscountReview;
  /** @type {typeof import('./special-stock-purchase-pricing.js').specialPurchasePalletLine} */
  let purchasePalletLine;
  /** @type {typeof import('./special-stock-purchase-pricing.js').specialLineSubtotal} */
  let purchaseSubtotal;
  const purchasePricingReady = import('/special-stock-purchase-pricing.js' + '?v=20260930-pallet-routing-v1');
  purchasePricingReady.then(module => { vendorDiscountReview = module.specialVendorLineDiscountReview; purchasePalletLine = module.specialPurchasePalletLine; purchaseSubtotal = module.specialLineSubtotal; });
  /** @type {typeof import('./special-stock-po-routing.js').specialPoRoutingHtml} */
  let poRoutingHtml = () => '';
  /** @type {typeof import('./special-stock-po-routing.js').specialPoRoutingPatch} */
  let poRoutingPatch;
  const poRoutingReady = import('/special-stock-po-routing.js' + '?v=20261001-po-mini-rows-v1');
  poRoutingReady.then(module => { poRoutingHtml = module.specialPoRoutingHtml; poRoutingPatch = module.specialPoRoutingPatch; if (state.enabled) render(); });
  const formsReady = import('/special-stock-form-state.js?v=20260928-batch-v1');
  let specialDocumentActions = () => '';
  /** @type {typeof import('./special-stock-case-status.js').specialPlanningStatus} */
  let specialPlanningStatus = () => '';
  /** @type {typeof import('./special-stock-case-status.js').specialSupplyWaitingStatus} */
  let specialSupplyWaitingStatus = () => '';
  let specialClosureStatus = () => '';
  let specialClosureCardAlert = () => '', specialClosureQueueAlert = () => '';
  let compareSpecialScmQueue = (a,b) => Number(Boolean(b.quantityReviewPending)) - Number(Boolean(a.quantityReviewPending));
  import(new URL('/special-stock-case-status.js?v=20261016-po-sent-placement-v1&waitingLabels=20261016', location.href).href).then(status => {
    specialSupplyWaitingStatus = status.specialSupplyWaitingStatus;
    specialPlanningStatus = (detail, compact = false) => status.specialPlanningStatus(detail, compact, {
      showOrderPreviews: !compact, purchaseOrderActions: compact ? '' : purchaseSentControls(detail)
    }); specialClosureStatus = status.specialClosureStatus;
    specialClosureCardAlert = status.specialClosureCardAlert;
    specialClosureQueueAlert = status.specialClosureQueueAlert;
    compareSpecialScmQueue = status.compareSpecialScmQueue;
    if (state.enabled) render();
  });
  import('/special-stock-documents.js').then(documents => {
    specialDocumentActions = detail => documents.specialDocumentActions(detail, 'scm', { showOrderPreviews: false });
    documents.installSpecialDocumentPreviews(mount, { audience: 'scm' });
    if (state.enabled) render();
  });
  let SPECIAL_STAGES = {}, stageFilterHtml = () => '';
  let specialFormKey, rememberSpecialForm, restoreSpecialForms, preserveSpecialScroll;
  const state = {
    operator: null,
    enabled: null,
    storeLocationIds: [],
    vendorNames: [],
    vendors: [],
    yards: [],
    requests: /** @type {any[]} */ ([]),
    detail: /** @type {any} */ (null),
    loading: false,
    busy: false,
    error: "",
    notice: "",
    search: "",
    stages: [...new Set((new URLSearchParams(location.search).get('stages') || '').split(',').filter(Boolean))],
    dirty: false,
    formDrafts: new Map(),
    revisingDeclinedLineIds: new Set(),
    editingStockLineIds: new Set(),
    poRouting: /** @type {{ref:string,order:any,error:string}|null} */ (null),
    vendorTimer: 0,
    testSkipOrdersEnabled: false
  };

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
  const displayDate = (value) => value ? (window.MBBS_I18N?.displayDateTime?.(value) || String(value)) : "—";
  const number = (value) => Number.isFinite(Number(value)) ? new Intl.NumberFormat("en-CA", { maximumFractionDigits: 4 }).format(Number(value)) : "0";
  const money = value => '$' + new Intl.NumberFormat('en-CA', {minimumFractionDigits:2,maximumFractionDigits:2}).format(value ?? 0);
  const rateLabel = value => '$' + new Intl.NumberFormat('en-CA', {minimumFractionDigits:2,maximumFractionDigits:6}).format(value ?? 0);
  const pill = (value) => `<span class="stock-request-pill ${escapeHtml(value || "pending")}">${escapeHtml(SPECIAL_STAGES[value] || String(value || "pending").replaceAll("_", " "))}</span>`;
  const requiresSupplyEta = status => status === 'production';

  async function api(path, options = {}) {
    if (options.method && options.method !== 'GET') busyUI?.start(path, options.body);
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
    if (options.method && options.method !== "GET") queue?.invalidate();
    return payload;
  }

  function header() {
    const operator = state.operator || {};
    return `<header class="dispatch-topbar"><div><p>SCM · Special Item</p><h1>Special Stock Requests</h1></div><div class="topbar-language">${window.MBBS_I18N?.toggleHtml?.() || ""}</div><div class="topbar-actions"><span class="dispatch-user">${escapeHtml(operator.display_name || operator.username || "")}</span><button onclick="location.href='/scm'" type="button">SCM Menu</button><button onclick="dispatchLogout()" type="button">Logout</button></div></header>`;
  }

  function list() {
    state.requests = window.StockRequestConversation?.order(state.requests) || state.requests;
    if (state.loading && !state.requests.length) return `<div class="stock-request-empty"><strong>Loading Special Item queue…</strong></div>`;
    if (!state.requests.length) return `<div class="stock-request-empty"><strong>No matching cases</strong><span>Sales-submitted Special Item cases appear here.</span></div>`;
    return state.requests.map((request) => `<button class="stock-request-card ${state.detail?.id === request.id ? "selected" : ""}" data-special-scm-action="select" data-id="${request.id}" type="button"><span class="stock-request-status-line"><strong>${escapeHtml(request.requestRef)}</strong>${pill(request.stage)}${specialSupplyWaitingStatus(request)}</span>${specialPlanningStatus(request, true)}<span>${escapeHtml(request.customerName)} · ${escapeHtml(request.vendorName)}</span><small>${escapeHtml(request.storeName || request.storeLocationId)} · ${request.lines.length} line(s) · ${displayDate(request.updatedAt)}</small>${specialClosureCardAlert(request)}${request.quantityReviewPending ? '<strong class="stock-request-error">Order adjustment · SCM review required</strong>' : ''}${request.readinessAlerts?.length ? `<strong class="stock-request-error">${request.readinessAlerts.length} readiness check(s) due</strong>` : ""}</button>`).join("");
  }

  function canCheckStock(line) {
    return state.detail.informationRequest?.status !== 'pending' && state.detail.closeStatus === 'active' && !['closed','completed'].includes(state.detail.stage)
      && (line.salesDecision === 'accepted' || (line.salesDecision !== 'closed'
        && (line.salesDecision !== 'declined' || (canEditSpecialCaseLines(state.detail) && state.revisingDeclinedLineIds.has(line.id)))
        && !state.detail.salesOrderId && !state.detail.salesOrderSkipped));
  }

  function responseForm(line) {
    if (!canCheckStock(line)) return line.salesDecision === 'declined' && canEditSpecialCaseLines(state.detail) && canCheckStock({ ...line, salesDecision: 'pending' })
      ? `<button type="button" data-special-scm-action="revise-stock-check" data-line-id="${line.id}">Revise stock check</button>` : '';
    const pendingTransfer = isSpecialTransferEta(line) && !state.detail.salesOrderId;
    if (line.salesDecision === 'accepted') return `<div class="stock-request-line-fields" data-special-stock-line="${line.id}" data-kind="readiness" data-line-id="${line.id}" data-transfer-pending="${pendingTransfer}">
      <label><span>Stock readiness</span><select name="ready"><option value="false" ${!specialStockAvailable(line.supplyStatus) ? 'selected' : ''}>Not ready</option><option value="true" ${specialStockAvailable(line.supplyStatus) ? 'selected' : ''}>Ready for Arrangement</option></select></label>
      <label data-special-eta ${specialStockAvailable(line.supplyStatus) ? 'hidden' : ''}><span>ETA *</span><input name="eta" type="date" ${specialStockAvailable(line.supplyStatus) ? 'disabled' : 'required'} value="${escapeHtml(line.availableDate || '')}" /></label><p data-special-transfer-eta ${pendingTransfer ? '' : 'hidden'}>SO placement +5 working days</p></div>`;
    const editingItem = state.editingStockLineIds.has(line.id);
    return `<div class="stock-request-form special-response-form" data-special-stock-line="${line.id}" data-kind="response" data-line-id="${line.id}">
      <div class="special-response-heading"><h4>SCM stock check</h4><button type="button" data-special-scm-action="edit-stock-line" data-line-id="${line.id}" aria-expanded="${editingItem}" aria-controls="special-scm-item-fields-${line.id}">${editingItem ? 'Hide details' : 'Edit'}</button></div>
      ${line.salesDecision === 'declined' ? '<p class="stock-request-notice">Saving this stock check reopens the line for customer confirmation.</p>' : ''}
      <input name="vendorId" type="hidden" value="${escapeHtml(line.responseVendorId || state.detail.vendorId || '')}" />
      <div id="special-scm-item-fields-${line.id}" data-special-scm-item-fields ${editingItem ? '' : 'hidden'}>${specialLineFields(specialLineFieldValues(line), { sales: false, itemLabel: 'Item name *', showRequiredDate: false })}</div>
      <div class="stock-request-line-fields special-response-stock-row${requiresSupplyEta(line.supplyStatus) || line.supplyStatus === 'vendor_transfer' ? ' has-eta' : ''}">
      <label><span>Required date *</span><input name="requiredDate" type="date" ${line.requiredDate ? 'required' : ''} value="${escapeHtml(line.requiredDate || '')}" /></label>
      <label><span>Supply status *</span><select name="supplyStatus"><option value="in_stock" ${line.supplyStatus === 'in_stock' ? 'selected' : ''}>In stock</option><option value="low_inventory" ${line.supplyStatus === 'low_inventory' ? 'selected' : ''}>Low inventory</option><option value="production" ${line.supplyStatus === 'production' ? 'selected' : ''}>Wait For Production</option><option value="vendor_transfer" ${line.supplyStatus === 'vendor_transfer' ? 'selected' : ''}>Wait for Transfer</option><option value="no_stock" ${line.supplyStatus === 'no_stock' ? 'selected' : ''}>No stock or ETA</option></select></label>
      <label class="stock-request-item-search"><span>Vendor *</span><input name="vendorName" data-special-scm-vendor-search data-line-id="${line.id}" required value="${escapeHtml(line.responseVendorName || state.detail.vendorName)}" /><div class="stock-request-suggestions" data-special-scm-vendor-suggestions="${line.id}"></div></label>
      <label data-special-eta ${requiresSupplyEta(line.supplyStatus) ? '' : 'hidden'}><span>ETA *</span><input name="availableDate" type="date" ${requiresSupplyEta(line.supplyStatus) ? 'required' : 'disabled'} value="${escapeHtml(line.availableDate || '')}" /></label>
      <p data-special-transfer-eta ${line.supplyStatus === 'vendor_transfer' ? '' : 'hidden'}>ETA: SO placement +5 working days</p>
      </div>
      <div class="special-response-notes-row">
      <label><span>Vendor pickup location *</span><input name="vendorYard" ${line.supplyStatus === "no_stock" ? "" : "required"} value="${escapeHtml(line.vendorYard || '')}" /></label>
      <label><span>Sales-visible reply</span><textarea name="salesVisibleNote" rows="2">${escapeHtml(line.salesVisibleNote || '')}</textarea></label>
      <label><span>SCM internal note</span><textarea name="scmInternalNote" rows="2">${escapeHtml(line.scmInternalNote || '')}</textarea></label></div>
      </div>`;
  }

  function lineCard(line) {
    const alert = state.detail.readinessAlerts?.some(item => item.lineId === line.id);
    const html = `<article class="stock-request-line"><header><div><strong>MBBS-Special</strong><p class="special-scm-item-description">${escapeHtml(specialItemDescription(line))}</p><small>${number(line.quantity)} ${escapeHtml(line.uom)}</small></div>${pill(line.salesDecision)}</header>
      <p>${escapeHtml([line.requiredDate ? `Required: ${line.requiredDate}` : '',line.customerNote,`PLT ${line.palletQty ?? '—'} · LYR ${line.layerQty ?? '—'} · SEC ${line.sectionQty ?? '—'} · PCS ${line.pieceQty ?? '—'}`].filter(Boolean).join(' · '))}</p>
      <p class="stock-live-summary"><span>${specialStockAvailable(line.supplyStatus) ? (line.supplyStatus === 'low_inventory' ? 'Low inventory' : 'Stock ready') : `${line.supplyStatus === 'vendor_transfer' ? 'Wait for Transfer · ' : line.supplyStatus === 'production' ? 'Waiting for Production · ' : ''}ETA: ${escapeHtml(specialSupplyEtaLabel(line, 'Not available'))}`} · Pickup: ${escapeHtml(line.vendorYard || 'Awaiting check')}</span>${window.SCMStockCheckLines?.line(state.detail,line) || ''}</p>
      ${alert ? '<div class="stock-request-notice stock-request-error" role="status">Readiness check due. This alert stays active until SCM confirms stock is ready.</div>' : ''}
      ${line.salesCustomerNote || line.salesDecisionReason ? `<p>Sales: ${escapeHtml(line.salesCustomerNote || line.salesDecisionReason)}</p>` : ''}${responseForm(line)}</article>`;
    return window.SCMRequestLineVisibility?.wrap(state.detail, line, html) || html;
  }

  let specialFulfillmentLabel = () => '';
  import('/special-stock-fulfillment.js?v=20260928-display-v1').then(module => {specialFulfillmentLabel=module.specialFulfillmentLabel;if(state.enabled)render();});

  /** @param {any} detail */
  function manualPurchaseLinkControls(detail) {
    if (detail.purchaseOrderId || detail.purchaseOrderSkipped || detail.salesOrderSkipped
        || detail.purchaseOrderSubmissionStartedAt || detail.purchaseOrderOperationStatus === 'creating') return '';
    return '<label style="max-width:22rem"><span>Manual PO link</span><input name="purchaseOrderRef" maxlength="120" placeholder="Existing synced PO number" style="width:100%" /><small>Link the order number without comparing request or order details.</small></label><button type="submit" data-special-link-po formnovalidate>Link PO</button>';
  }

  /** @param {any} detail */
  function purchaseSentControls(detail) {
    if (!detail.purchaseOrderId || detail.informationRequest?.status === 'pending' || detail.quantityReviewPending
        || ['closed','completed'].includes(detail.stage) || detail.closeStatus === 'closure_pending') return '';
    if (detail.purchaseOrderSentToVendorAt) return '<p role="status">PO sent to vendor</p>';
    if (detail.stage === 'dispatch_arrangement') return '';
    return '<form data-special-po-sent-form><button type="submit">PO Sent to Vendor</button></form>';
  }

  function orderControls(detail) {
    const waitingForStock = detail.lines.some(line => line.salesDecision === 'accepted' && !specialStockAvailable(line.supplyStatus));
    const manualControls = manualPurchaseLinkControls(detail);
    const manualForm = manualControls ? `<section class="stock-request-section"><form data-special-po-form><div class="stock-request-actions">${manualControls}</div></form></section>` : '';
    if (detail.informationRequest?.status === 'pending') return manualForm;
    if (['closed','completed'].includes(detail.stage) || detail.closeStatus === 'closure_pending') return manualForm;
    if (detail.quantityReviewPending) return `<p>PO creation waits for the order adjustment review above.</p>${manualForm}`;
    if (!detail.salesOrderId && !detail.salesOrderSkipped) return `<div class="stock-request-notice">Sales can create the SO after the customer confirms the available stock or accepts the ETA.</div>
      ${manualForm}${detail.lines.every(line => line.supplyStatus === 'no_stock' && !line.availableDate) ? `<form data-special-scm-close-form><label>Closure reason<input name="reason" required /></label><button class="danger" type="submit">Close request — no stock or ETA</button></form>` : ''}`;
    if (detail.purchaseOrderId || detail.purchaseOrderSkipped) return `<section><h3>${detail.purchaseOrderSkipped ? 'PO creation skipped (test)' : 'Purchase Order'}</h3><p>${detail.salesOrderSkipped ? 'SO creation skipped (test) · ' : ''}${detail.stage === 'waiting_vendor_confirmation' ? 'Waiting Vendor Confirmation' : detail.purchaseOrderApproved === false ? 'Waiting for NetSuite PO approval' : waitingForStock ? 'Waiting for SCM readiness confirmation' : detail.fulfillmentMethod === 'vendor_pickup' ? 'Customer pickup at vendor yard' : detail.stage === 'dispatch_arrangement' ? 'Dispatch Arrangement' : 'PO linked'}</p>${detail.purchaseOrderCustomLinkage ? '<p>Custom PO linkage: SO and PO details are independent. SO descriptions stay unchanged. Arrange this PO via the yard before SO delivery.</p>' : ''}</section>`;
    const independentPurchase = detail.salesOrderSource === 'manual_link';
    if (!detail.salesOrderApproved && !independentPurchase) return `<section><h3>SO approval pending</h3><p>NetSuite status updates automatically.</p></section>${manualForm}`;
    const retry = detail.purchaseOrderOperationStatus === 'attention' && Boolean(detail.purchaseOrderSubmissionStartedAt);
    /** @type {any[]} */
    const purchaseLines = independentPurchase && detail.vendorDiscountReview?.mode !== 'per_line'
      ? (/** @type {any[]} */ (detail.lines || [])).filter(line => line.salesDecision === 'accepted').map(line => ({
        caseLineId: line.id, itemId: 2055, ancillary: false, description: specialItemDescription(line),
        quantity: line.quantity, uom: line.uom, unitPurchaseCost: line.unitPurchaseCost
      })) : [...detail.purchaseOrderLines];
    const pallet = purchaseLines.find(line => line.itemId === 1784);
    const palletQuantity = pallet?.quantity ?? detail.vendorDiscountReview?.pallet?.quantity ?? detail.palletTotal ?? 0;
    return `<section class="stock-request-section"><h3>Review and create Purchase Order</h3><p>${detail.salesOrderSkipped ? 'SO creation skipped for testing. Use Skip PO Creation to continue the test.' : (independentPurchase || detail.localAdjustedAt) ? 'Review the request materials and vendor costs below to create a standalone NetSuite PO. The linked SO stays unchanged.' : 'The reviewed quantity, UOM and description will update the SO first, then create a standalone NetSuite PO for this request. Sales prices remain unchanged.'}</p>
      <form data-special-po-form><fieldset ${retry ? 'disabled' : ''} style="border:0;padding:0">
      ${purchaseLines.filter(line => !line.ancillary).map(line => `<article class="stock-request-line" data-special-po-line="${line.caseLineId}"><strong>MBBS-Special</strong><div class="stock-request-line-fields">
        <label class="stock-request-wide"><span>Order description *</span><input name="description" required value="${escapeHtml(line.description)}" /></label>
        <div class="special-po-pricing-row"><label><span>Quantity *</span><input name="quantity" type="number" min="0.000001" step="any" required value="${escapeHtml(line.quantity)}" /></label>
        <label><span>UOM *</span><input name="uom" required value="${escapeHtml(line.uom)}" /></label>
        <label><span>Unit cost ($) *</span><input name="unitPurchaseCost" type="number" min="0" step="any" required value="${escapeHtml(detail.vendorDiscountReview?.lines?.find(review => review.caseLineId === line.caseLineId)?.grossUnitCost ?? line.unitPurchaseCost ?? '')}" /></label>
        <label><span>Vendor discount % *</span><input name="vendorDiscountPercent" type="number" min="0" max="100" step="0.0001" required placeholder="Enter 0 if none" value="${escapeHtml(detail.vendorDiscountReview?.mode === 'per_line' ? detail.vendorDiscountReview.lines.find(review => review.caseLineId === line.caseLineId)?.vendorDiscountPercent ?? '' : '')}" /></label>
        </div></div><p data-special-vendor-line-total></p></article>`).join('')}
      <p>Enter unit cost before discount and confirm the vendor discount for each material. NetSuite will show one combined vendor discount.</p>
      <article class="stock-request-line"><strong>PALLET</strong><div class="stock-request-line-fields">
        <label><span>PALLET quantity (EACH) *</span><input name="purchasePalletQuantity" type="number" min="0" max="1000000000" step="1" required value="${escapeHtml(palletQuantity)}" /><small>0 omits the PALLET line from the PO.</small></label>
        <label><span>PALLET purchase cost ($ / EACH)</span><input name="purchasePalletCost" type="number" min="0" max="1000000000" step="0.000001" ${Number(palletQuantity) > 0 ? 'required' : ''} value="${escapeHtml(pallet?.unitPurchaseCost ?? detail.vendorDiscountReview?.pallet?.unitPurchaseCost ?? '')}" /><small>Review the vendor cost separately from the SO selling price.</small></label>
      </div></article>
      <p data-special-purchase-totals role="status"></p></fieldset>
      <div class="stock-request-actions">${!detail.salesOrderSkipped ? `<button class="primary" type="submit">${retry ? 'Recover PO operation' : 'Create PO in NetSuite'}</button>` : ''}${manualControls}${state.testSkipOrdersEnabled && !retry && detail.purchaseOrderOperationStatus !== 'creating' ? '<button type="submit" data-special-skip-po>Skip PO Creation</button>' : ''}</div></form></section>`;
  }

  function quantityReviewView(detail) {
    if (!detail.quantityReviewPending) return '';
    const review = detail.quantityReview;
    return `<section class="stock-request-section"><form class="stock-request-form" data-special-quantity-review-form><h3>SCM order adjustment review</h3>
      <p>${review.mode === 'issued' ? review.remoteStarted ? 'Recover the previously started order update using its saved plan.' : 'Confirmation applies changes and item removals to the local request. Existing NetSuite orders stay as created.' : 'Confirm the new stock requirement before Sales creates the SO.'}</p>
      ${review.lines.map(line=>`<article class="stock-request-line"><strong>MBBS-Special</strong><p>${escapeHtml(line.productName)}</p>${line.remove ? '<p>Remove item from this request</p>' : `<p>${number(line.fromPackageQuantity)} → ${number(line.toPackageQuantity)} ${escapeHtml(line.packageUom)}</p>${review.remoteStarted || review.mode !== 'issued' ? `<p>SO: ${number(line.fromQuantity)} → ${number(line.toQuantity)} ${escapeHtml(line.salesUom)} · PO: ${number(line.fromPurchaseQuantity)} → ${number(line.toPurchaseQuantity)} ${escapeHtml(line.purchaseUom)}</p>` : ''}`}</article>`).join('')}
      ${review.lines.map(specialAdjustmentFieldSummary).join('')}
      ${review.lines.filter(line=>!line.remove && line.fromDiscountPercent!==line.toDiscountPercent).map(line=>`<p>${escapeHtml(line.productName)} discount: ${number(line.fromDiscountPercent)}% → ${number(line.toDiscountPercent)}%</p>`).join('')}
      ${review.pallets ? `<p>PALLET: ${number(review.pallets.fromQuantity)} → ${number(review.pallets.toQuantity)} EACH · Rate: ${rateLabel(review.pallets.rate)}</p>` : ''}
      ${review.error ? `<p class="stock-request-error">${escapeHtml(review.error)}</p>` : ''}
      <label><span>Review note</span><input name="reason" /></label><div class="stock-request-actions"><button class="primary" type="submit" value="approve">${['applying','attention'].includes(review.status) ? 'Retry order update' : 'Confirm adjustment'}</button>
      ${!review.remoteStarted && review.status !== 'applying' ? '<button class="danger" type="submit" value="reject">Reject adjustment</button>' : ''}</div></form></section>`;
  }

  function detail() {
    const detail = state.detail;
    if (!detail) return `<div class="stock-request-empty"><strong>Select a case</strong><span>Review the stock checks and save them together.</span></div>`;
    return `<div class="stock-request-heading"><div><h2>${escapeHtml(detail.requestRef)}</h2><p>${escapeHtml(detail.customerName)} · ${escapeHtml(detail.customerPhone || "No phone")}</p></div>${pill(detail.stage)}</div><div class="stock-request-summary"><span><small>Vendor</small><strong>${escapeHtml(detail.vendorName)}</strong></span><span><small>Store</small><strong>${escapeHtml(detail.storeName)}</strong></span><span><small>Delivery method</small><strong>${escapeHtml(specialFulfillmentLabel(detail.fulfillmentMethod))}</strong></span><span><small>Case inquiry date</small><strong>${escapeHtml(detail.inquiryDate)}</strong></span><span><small>Sales Rep</small><strong>${escapeHtml(detail.netsuiteSalesRepName || detail.requestedByName || "—")}</strong></span><span><small>Expiry</small><strong>${escapeHtml(detail.expiresOn || "—")}</strong></span>${detail.netsuiteCustomerName ? `<span><small>NetSuite customer account</small><strong>${escapeHtml(detail.netsuiteCustomerName)}</strong></span>` : ""}<span><small>Revision</small><strong>${detail.revision}</strong></span></div>${detail.fulfillmentMethod === 'mbt_delivery' ? `<p class="stock-request-notice">${escapeHtml([detail.deliveryAddress,detail.deliveryContactName,detail.deliveryContactPhone,detail.deliveryDate].filter(Boolean).join(' · '))}</p>` : ''}${detail.attention ? `<div class="stock-request-notice stock-request-error">${escapeHtml(detail.attentionReason)}</div>` : ''}${specialPlanningStatus(detail)}${specialClosureStatus(detail, "scm")}${quantityReviewView(detail)}${detail.closeStatus === "closed" && detail.closureReason ? `<div class="stock-request-notice">Closed: ${escapeHtml(detail.closureReason)}</div>` : ''}${detail.remarks ? `<div class="stock-request-notice"><small>Note</small><div class="special-header-note-content">${escapeHtml(detail.remarks)}</div></div>` : ""}${detail.postPoChangePending ? `<div class="stock-request-notice stock-request-error">A post-PO vendor change is waiting for Sales to record customer acknowledgement. The existing SO, PO, and Dispatch handoff were not silently changed.</div>` : ""}${poRoutingHtml(detail, state.poRouting)}${specialInformationPanel(detail, 'scm')}<section class="stock-request-section" data-scm-line-visibility="${detail.id}">${window.SCMStockCheckLines?.header(detail) || '<h3>Line responses</h3>'}${window.SCMRequestLineVisibility?.controls(detail) || ""}<form data-special-stock-check-form><div class="stock-request-lines" id="scm-request-lines-${detail.id}">${detail.lines.map(lineCard).join("")}${specialRequestPalletLine(detail)}</div>${detail.lines.some(canCheckStock) ? '<div class="stock-request-actions"><button class="primary" type="submit" data-scm-line-save>Save stock check</button></div>' : ''}</form></section>${orderControls(detail)}<section class="stock-request-section"><h3>Audit trail</h3>${detail.events.slice(0, 20).map((event) => `<div class="stock-request-event"><strong>${escapeHtml(event.eventType.replaceAll("_", " "))}</strong><small>${escapeHtml(event.actorName)} · ${displayDate(event.createdAt)}</small></div>`).join("")}</section>${specialDocumentActions(detail)}`;
  }

  function render({detailOnly=false} = {}) {
    const restoreScroll = preserveSpecialScroll?.(mount);
    if (state.detail && !detailOnly) state.requests = state.requests.map(request => request.id === state.detail.id ? state.detail : request)
      .filter(request => state.search.trim() || !state.stages.length || state.stages.includes(request.stage))
      .sort(compareSpecialScmQueue);
    if (window.MBBSStockRequestTabs && !window.MBBSStockRequestTabs.isActive("special")) return;
    const restoreTabFocus = window.MBBSStockRequestTabs?.preserveFocus();
    if (state.enabled === false) {
      mount.innerHTML = `${header()}<section class="stock-request-page">${window.MBBSStockRequestTabs?.html() || `<div class="stock-request-tabs"><button aria-selected="true" type="button">Special</button><button data-special-scm-action="regular" type="button">Regular</button></div>`}<div class="stock-request-empty"><strong>Special Item workflow is off</strong><span>Enable special_stock_request_workflow after the NetSuite mappings are reviewed.</span></div></section>`;
      restoreTabFocus?.();
      return;
    }
    if (!detailOnly || !window.StockRequestView?.renderDetail(mount, detail(), state.detail?.id)) {
    mount.innerHTML = `${header()}<section class="stock-request-page">${window.MBBSStockRequestTabs?.html() || `<div class="stock-request-tabs"><button aria-selected="true" type="button">Special</button><button data-special-scm-action="regular" type="button">Regular</button></div>`}<div class="stock-request-toolbar"><div class="stock-request-actions"><input class="stock-request-search" data-special-scm-search value="${escapeHtml(state.search)}" placeholder="Search case, customer, vendor, SO, PO, or item" />${yardFilterHtml(state.yards, state.storeLocationIds)}${vendorFilterHtml(state.vendors, state.vendorNames)}${stageFilterHtml(state.stages, "data-special-scm-stage")}<button data-special-scm-action="refresh" type="button">Refresh</button></div></div><div class="stock-request-feedback">${specialClosureQueueAlert(state.requests)}${state.notice ? `<div class="stock-request-notice">${escapeHtml(state.notice)}</div>` : ""}${state.error ? `<div class="stock-request-notice stock-request-error">${escapeHtml(state.error)}</div>` : ""}</div><div class="stock-request-workspace"><aside class="stock-request-panel stock-request-list">${list()}</aside><section class="stock-request-panel stock-request-detail">${detail()}</section></div></section>`;
    }
    restoreTabFocus?.();
    mount.querySelector('.stock-request-page')?.classList.add('special-stock-page');
    restoreSpecialForms?.(mount, state.formDrafts);
    for (const form of mount.querySelectorAll('[data-special-stock-line]')) updateEtaVisibility(form);
    updatePurchaseTotals();
    busyUI?.render();
    window.StockRequestConversation?.watchQueue(mount, {url:`/api/scm/special-stock-requests?${queueKey()}`, requests:state.requests,
      active, read:api, error:()=>updates?.changed(),
      accept:requests=>{state.requests=requests; const host=mount.querySelector('.stock-request-list'); if(host)host.innerHTML=list();}});
    window.StockRequestConversation?.render(mount, state.detail, 'scm', {onWorkflowUpdated:()=>load({force:true})});
    restoreScroll?.();
    void loadPoRouting();
    updates?.paint();
  }

  async function loadPoRouting(force = false) {
    const detail = state.detail, ref = detail?.purchaseOrderRef;
    if (!detail?.purchaseOrderId || !ref) { state.poRouting = null; return; }
    if (!force && state.poRouting?.ref === ref) return;
    /** @type {{ref:string,order:any,error:string}} */
    const entry = {ref, order:null, error:''};
    state.poRouting = entry;
    try {
      await poRoutingReady;
      const displayRef = detail.purchaseOrderReference || ref;
      const payload = await api(`/api/dispatch/scm/v2/purchase-orders/${encodeURIComponent(displayRef)}`);
      if (!payload.order || String(payload.order.originalPoRef || payload.order.id) !== ref) throw new Error('The PO routing record does not match this request.');
      const {note} = await api(`/api/scm/special-stock-requests/${detail.id}/purchase-order/note`);
      if (typeof note !== 'string') throw new Error('The NetSuite PO Note could not be loaded.');
      entry.order = {...payload.order, netSuiteNote:note};
    } catch (error) { entry.error = error instanceof Error ? error.message : String(error); }
    if (state.poRouting === entry && state.detail?.id === detail.id) {
      const panel = mount.querySelector('.special-po-routing');
      if (panel) panel.outerHTML = poRoutingHtml(detail, entry);
    }
  }

  const active = () => (!window.MBBSStockRequestTabs || window.MBBSStockRequestTabs.isActive('special'));
  const updates = window.StockRequestView?.create({mount,active});
  const editing = () => state.busy || (!busyUI?.remote() && state.dirty);
  const queueKey = () => new URLSearchParams({ search: state.search, stages: state.search.trim() ? '' : state.stages.join(','), storeLocationIds: state.storeLocationIds.join(','), vendorNames: JSON.stringify(state.vendorNames) }).toString();

  async function initializeQueue() {
    if (queue) return;
    const {createSpecialQueueLoader,watchSpecialQueue} = await queueReady;
    if (queue) return;
    queue = createSpecialQueueLoader({
      autoReload: false,
      read: (key,signal) => api(`/api/scm/special-stock-requests?${key}`, {signal}),
      blocked: () => !active() || editing(),
      loading: value => { state.loading = value; if (value && !state.requests.length) render(); },
      error: error => { state.error = error.message; render(); },
      accept: payload => {
        const selectedId = state.detail?.id || Number(new URLSearchParams(location.search).get('requestId'));
        state.yards = payload.yards || state.yards;
        state.vendors = payload.vendors || [];
        state.requests = payload.requests || [];
        state.detail = state.requests.find(row => row.id === selectedId) || state.requests[0] || null;
        state.poRouting = null;
        state.error = '';
        render();
      }
    });
    watchSpecialQueue({queue,key:queueKey,requests:()=>state.requests,active,audience:'scm',onUpdate:()=>updates?.changed()});
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
    const version = updates?.version;
    await queue.load(queueKey(), {force});
    if (!queue.pending) updates?.acknowledge(version);
  }

  function selectCase(id) {
    const detail = state.requests.find(row => String(row.id) === String(id));
    if (!detail || detail.id === state.detail?.id) return;
    state.formDrafts.clear(); state.dirty = false;
    state.revisingDeclinedLineIds.clear();
    state.editingStockLineIds.clear();
    state.poRouting = null;
    state.detail = detail; state.error = ''; state.notice = '';
    render({detailOnly:true});
  }

  function replaceSuggestions(selector, html) {
    const target = mount.querySelector(selector);
    if (target) target.innerHTML = html;
  }

  function updateEtaVisibility(form) {
    const status = form.querySelector('[name=supplyStatus]');
    const relative = status ? status.value === 'vendor_transfer' : form.dataset.transferPending === 'true' && form.querySelector('[name=ready]')?.value === 'false';
    const waiting = status ? requiresSupplyEta(status.value) : !relative && form.querySelector('[name=ready]')?.value === 'false';
    const transferLabel = form.querySelector('[data-special-transfer-eta]');
    if (transferLabel) transferLabel.hidden = !relative;
    form.querySelector('.special-response-stock-row')?.classList.toggle('has-eta', waiting || relative);
    const eta = form.querySelector('[data-special-eta]');
    if (eta) {
      eta.hidden = !waiting;
      eta.querySelector('input').disabled = !waiting;
      eta.querySelector('input').required = waiting;
    }
    if (status) form.querySelector('[name=vendorYard]').required = status.value !== 'no_stock';
  }

  function purchaseReviewLines(form) {
    return [...form.querySelectorAll('[data-special-po-line]')].map(element => ({
      caseLineId: Number(element.dataset.specialPoLine), ...Object.fromEntries([...element.querySelectorAll('[name]')].map(input => [input.name,input.value]))
    }));
  }

  function updatePurchaseTotals() {
    const form = /** @type {HTMLFormElement|null} */ (mount.querySelector('[data-special-po-form]'));
    const display = form?.querySelector('[data-special-purchase-totals]');
    if (!form || !display || !vendorDiscountReview) return;
    const palletInput = purchasePalletReview(form);
    const palletCost = /** @type {HTMLInputElement} */ (form.querySelector('[name=purchasePalletCost]'));
    palletCost.required = Number(palletInput.quantity) > 0;
    try {
      const review = vendorDiscountReview(purchaseReviewLines(form));
      const pallet = purchasePalletLine(palletInput);
      const palletTotal = pallet ? purchaseSubtotal(pallet.quantity,pallet.unitPurchaseCost) : 0;
      for (const line of review.lines) form.querySelector(`[data-special-po-line="${line.caseLineId}"] [data-special-vendor-line-total]`).textContent = `Vendor discount: ${money(line.discountAmount)} · Net line total: ${money(line.netTotal)}`;
      display.textContent = `Gross purchase total: ${money(review.grossTotal + palletTotal)} · Vendor discount: ${money(review.amount)} · Net purchase total: ${money(review.netTotal + palletTotal)}${pallet ? ` · PALLET: ${money(palletTotal)}` : ''}`;
    } catch (error) {
      for (const line of form.querySelectorAll('[data-special-vendor-line-total]')) line.textContent = '';
      display.textContent = state.detail.purchaseOrderSubmissionStartedAt && state.detail.vendorDiscountReview?.mode !== 'per_line' ? `Submitted vendor discount: ${money(state.detail.vendorDiscountReview?.amount || 0)} · Original purchase costs retained for recovery.` : error.message;
    }
  }

  /** @param {HTMLFormElement} form */
  function purchasePalletReview(form) {
    const quantity = /** @type {HTMLInputElement} */ (form.querySelector('[name=purchasePalletQuantity]'));
    const cost = /** @type {HTMLInputElement} */ (form.querySelector('[name=purchasePalletCost]'));
    return {quantity:quantity.value,unitPurchaseCost:cost.value};
  }

  mount.addEventListener("input", (event) => {
    if (!active()) return;
    if (event.target.closest("[data-special-po-form]")) updatePurchaseTotals();
    if (event.target.closest("form")) state.dirty = true;
    if (event.target.matches("[data-special-scm-vendor-search]")) {
      const lineId = Number(event.target.dataset.lineId);
      const search = event.target.value;
      event.target.closest('[data-special-stock-line]').querySelector('[name=vendorId]').value = '';
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
    if (!active()) return;
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
    if (event.target.matches('[name=supplyStatus], [name=ready]')) updateEtaVisibility(event.target.closest('[data-special-stock-line]'));
    if (event.target.closest('form')) state.dirty = true;
    rememberSpecialForm?.(state.formDrafts, event.target.closest('form'));
    if (!event.target.matches("[data-special-scm-stage]")) return;
    state.stages = [...mount.querySelectorAll("[data-special-scm-stage]:checked")].map(input => input.value);
    await load({ selectedId: null });
    mount.querySelector(".special-stage-filter").open = true;
  });

  mount.addEventListener("keydown", (event) => {
    const input = /** @type {HTMLInputElement|null} */ (event.target);
    if (event.key === 'Enter' && input?.form && input.matches('[data-special-po-form] [name=purchaseOrderRef]')) {
      event.preventDefault();input.form.requestSubmit(/** @type {HTMLButtonElement} */ (input.form.querySelector('[data-special-link-po]')));return;
    }
    if (event.key !== "Enter" || !event.target.matches("[data-special-scm-search]")) return;
    event.preventDefault();
    state.search = event.target.value;
    load({ selectedId: null }).catch((error) => { state.error = error.message; render(); });
  });

  mount.addEventListener('submit', async event => {
    const form = /** @type {HTMLFormElement} */ (event.target);
    if (!form.matches('[data-special-information-request-form], [data-special-stock-check-form], [data-special-po-routing-form], [data-special-po-form], [data-special-po-sent-form], [data-special-scm-close-form], [data-special-quantity-review-form], [data-special-closure-review-form]')) return;
    event.preventDefault();
    if (state.busy) return;
    state.busy = true; state.error = '';
    rememberSpecialForm(state.formDrafts, form);
    try {
      const values = Object.fromEntries(new FormData(form));
      let path, apiPath, method = 'POST';
      /** @type {Record<string, any>} */
      let payload = { expectedRevision: state.detail.revision };
      if (form.matches('[data-special-information-request-form]')) {
        path = 'request-information'; payload.question = values.question;
      } else if (form.matches('[data-special-stock-check-form]')) {
        path = 'stock-check';
        payload.lines = [...form.querySelectorAll('[data-special-stock-line]')].filter(group => !group.closest('[data-scm-line-id][disabled]')).map(group => {
          const fields = Object.fromEntries([...group.querySelectorAll('[name]:not(:disabled)')].map(input => {
            const field = /** @type {HTMLInputElement} */ (input);
            return [field.name, field.value];
          }));
          const element = /** @type {HTMLElement} */ (group);
          const line = { lineId: Number(element.dataset.specialStockLine), kind: element.dataset.kind };
          if (line.kind === 'readiness') return { ...line, ready: fields.ready === 'true', eta: fields.eta };
          if (!fields.vendorId) throw new Error('Select a vendor from the suggestions for every stock check.');
          const eta = requiresSupplyEta(fields.supplyStatus) ? fields.availableDate : null;
          if (requiresSupplyEta(fields.supplyStatus) && !eta) throw new Error('Enter an ETA for stock awaiting supply.');
          return { ...fields, ...line, availableDate: eta, availabilityMode: fields.supplyStatus === 'vendor_transfer' ? 'so_placement' : eta ? 'dated' : 'no_projection' };
        });
      } else if (form.matches('[data-special-po-sent-form]')) {
        path = 'purchase-order/sent-to-vendor';
      } else if (form.matches('[data-special-po-routing-form]')) {
        await poRoutingReady;
        const routing = state.poRouting;
        if (!routing || routing.ref !== state.detail.purchaseOrderRef) throw new Error('Reload this PO routing before saving.');
        path = 'po-routing'; method = 'PUT';
        apiPath = `/api/scm/special-stock-requests/${state.detail.id}/purchase-order/routing`;
        payload = {...poRoutingPatch(form,routing.order),expectedRevision:state.detail.revision,expectedNote:routing.order.netSuiteNote};
      } else if (form.matches('[data-special-quantity-review-form]')) {
        path = 'quantity-review'; payload = { ...payload, reviewId: state.detail.quantityReview.id, decision: event.submitter.value, reason: values.reason };
      } else if (form.matches('[data-special-closure-review-form]')) {
        path = 'closure-review'; payload = { ...payload, reviewId: state.detail.closureReview.id, decision: event.submitter.value, reason: values.reason };
      } else if (form.matches('[data-special-scm-close-form]')) {
        path = 'close-unavailable'; payload.reason = values.reason;
      } else if (event.submitter?.matches('[data-special-link-po]')) {
        path = 'purchase-order/link';
        payload.purchaseOrderRef = String(values.purchaseOrderRef || '').trim();
        if (!payload.purchaseOrderRef) throw new Error('Enter an existing PO number to link.');
        payload.customLinkage = true;
      } else {
        path = event.submitter?.matches('[data-special-skip-po]') ? 'purchase-order/skip' : 'purchase-order/create';
        payload.operationId = state.detail.purchaseOrderOperationId || crypto.randomUUID();
        if (!state.detail.purchaseOrderSubmissionStartedAt) {
          payload.lines = purchaseReviewLines(form);
          payload.pallet = purchasePalletReview(form);
          await purchasePricingReady;
          vendorDiscountReview(payload.lines);
          purchasePalletLine(payload.pallet);
        }
      }
      const saved = await api(apiPath || `/api/scm/special-stock-requests/${state.detail.id}/${path}`, { method, body: JSON.stringify(payload) });
      let stockCheckRefreshError = '';
      if (path === 'po-routing') {
        state.detail = await api(`/api/scm/special-stock-requests/${state.detail.id}`);
        state.poRouting = null;
      } else {
        state.detail = saved;
      }
      if (path === 'stock-check') {
        const readVersion = updates?.version;
        try {
          state.detail = await api(`/api/scm/special-stock-requests/${state.detail.id}`);
          updates?.acknowledge(readVersion);
        } catch (error) {
          stockCheckRefreshError = error.message;
        }
      }
      state.formDrafts.delete(specialFormKey(form));
      if (path === 'stock-check') { state.revisingDeclinedLineIds.clear(); state.editingStockLineIds.clear(); }
      state.dirty = state.formDrafts.size > 0; state.notice = path === 'purchase-order/skip' ? 'PO creation skipped for testing.' : 'Saved.';
      if (stockCheckRefreshError) state.notice = `Stock check saved. The latest status could not be reloaded: ${stockCheckRefreshError} Use Refresh to try again.`;
      const index = state.requests.findIndex(request => request.id === state.detail.id);
      if (index >= 0) state.requests[index] = state.detail;
    } catch (error) {
      state.error = error.message;
      if (state.detail) state.detail = await api(`/api/scm/special-stock-requests/${state.detail.id}`).catch(() => state.detail);
    } finally { state.busy = false; busyUI?.end(); render(); }
  });

  mount.addEventListener("click", async (event) => {
    const apply = event.target.closest('[data-special-apply-vendors], [data-yard-filter-apply="storeLocationIds"], [data-special-apply-stages]');
    if (apply) {
      if (!active() || state.busy || apply.disabled) return;
      apply.closest('details')?.removeAttribute('open');
      try { await load({selectedId: null, force: true}); }
      catch (error) { state.error = error.message; render(); }
      return;
    }
    if (event.target.closest('[data-special-clear-vendors]')) { state.vendorNames=[];await load({selectedId:null});return; }
    if (event.target.closest('[data-yard-filter-clear="storeLocationIds"]')) { state.storeLocationIds = []; await load({selectedId: null}); return; }
    if (event.target.closest('[data-special-clear-stages]')) { state.stages = []; await load({ selectedId: null }); return; }
    const button = event.target.closest("[data-special-scm-action]");
    if (!button || state.busy) return;
    const action = button.dataset.specialScmAction;
    if (action === "select") return selectCase(button.dataset.id);
    if (action === 'edit-stock-line') {
      const fields = button.closest('[data-special-stock-line]')?.querySelector('[data-special-scm-item-fields]');
      if (!fields) return;
      const expanded = fields.hidden;
      const invalid = /** @type {HTMLInputElement|null} */ (fields.querySelector('input:invalid, select:invalid, textarea:invalid'));
      if (!expanded && invalid && !invalid.reportValidity()) return;
      const lineId = Number(button.dataset.lineId);
      if (expanded) state.editingStockLineIds.add(lineId); else state.editingStockLineIds.delete(lineId);
      fields.hidden = !expanded;
      button.setAttribute('aria-expanded', String(expanded));
      button.textContent = expanded ? 'Hide details' : 'Edit';
      return;
    }
    if (action === 'revise-stock-check') {
      const line = state.detail.lines.find(/** @param {Record<string,any>} item */ item => item.id === Number(button.dataset.lineId));
      if (line?.salesDecision !== 'declined' || !canEditSpecialCaseLines(state.detail) || !canCheckStock({ ...line, salesDecision: 'pending' })) return;
      state.revisingDeclinedLineIds.add(line.id);
      state.dirty = true;
      render({detailOnly:true});
      return;
    }
    if (action === "refresh") return load({force:true});
    if (action === 'reload-po-routing') return loadPoRouting(true);
    try {
      if (action === "regular") return window.MBBSStockRequestTabs ? window.MBBSStockRequestTabs.open("regular") : location.reload();
      if (action === "choose-vendor") {
        const form = mount.querySelector(`[data-special-stock-line="${button.dataset.lineId}"]`);
        form.querySelector("[name=vendorId]").value = button.dataset.vendorId;
        form.querySelector("[name=vendorName]").value = button.dataset.vendorName;
        state.dirty = true;
        rememberSpecialForm(state.formDrafts, form.closest('form'));
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
      state.busy = false; busyUI?.end();
      render();
    }
  });

  window.MBBSSCMSpecialStock = {
    async open({ operator } = {}) {
      if (!busyUI) {
        const { installSpecialBusyState } = await busyReady;
        busyUI = installSpecialBusyState(mount, { getDetail: () => state.detail, getLocalBusy: () => state.busy });
      }
      ({ SPECIAL_STAGES, stageFilterHtml, specialStockAvailable } = await workflowReady);
      ({ isSpecialTransferEta, specialSupplyEtaLabel } = await transferEtaReady);
      ({ specialInformationPanel } = await informationReady);
      state.stages = state.stages.filter(stage => Object.hasOwn(SPECIAL_STAGES, stage));
      ({ yardFilterHtml } = await yardFilterReady);
      ({ vendorFilterHtml } = await vendorFilterReady);
      ({ specialItemDescription } = await lineDetailsReady);
      ({ specialLineFields, specialLineFieldValues, specialAdjustmentFieldSummary } = await lineFieldsReady);
      ({ canEditSpecialCaseLines } = await caseEditsReady);
      ({ specialRequestPalletLine } = await palletDisplayReady);
      ({ specialFormKey, rememberSpecialForm, restoreSpecialForms, preserveSpecialScroll } = await formsReady);
      state.operator = operator || state.operator;
      if (!state.detail && new URLSearchParams(location.search).get('requestRef')) state.search = new URLSearchParams(location.search).get('requestRef');
      if (state.enabled !== null) { render(); if (state.enabled) await load(); return; }
      state.loading = true;
      render();
      try {
        const policy = await api("/api/scm/special-stock-requests/policy");
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

(() => {
  const mount = document.getElementById("salesStockRequestApp");
  if (!mount) return;

  const workflowReady = import('/special-stock-workflow.js');
  const formsReady = import('/special-stock-form-state.js');
  const pricingReady = import('/special-stock-pricing.js');
  let specialLineSubtotal, specialNativePricing, earliestSpecialDeliveryDate;
  let SPECIAL_STAGES = {}, stageFilterHtml = () => '';
  let specialFormKey, rememberSpecialForm, restoreSpecialForms, preserveSpecialScroll;
  const state = {
    operator: null,
    yards: [],
    enabled: null,
    requests: [],
    detail: null,
    composer: null,
    soDraft: null,
    soDraftDirty: false,
    formDrafts: new Map(),
    testSkipOrdersEnabled: false,
    caseCustomerResults: [],
    caseVendorResults: [],
    customerResults: [],
    itemResults: [],
    loading: false,
    busy: false,
    error: "",
    notice: "",
    search: "",
    stages: []
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

  const money = value => value == null ? '—' : new Intl.NumberFormat('en-CA', {minimumFractionDigits:2,maximumFractionDigits:2}).format(value);
  function refreshPricing() {
    for (const element of mount.querySelectorAll('[data-special-composer-line], [data-special-material]')) {
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
          native.textContent = `NetSuite: ${number(price.quantity)} ${line?.legacy ? line.uom : 'PC'} × ${number(price.rate)} per unit`;
        } catch (error) { native.textContent = error.message; }
      }
    }
  }
  function quantityReviewNotice(detail) {
    if (!detail.quantityReviewPending) return '';
    return `<div class="stock-request-notice stock-request-error" role="status"><strong>Quantity changed · SCM review required</strong>
      ${(detail.quantityReview?.lines || []).map(line => `<p>${escapeHtml(line.productName)}: ${number(line.fromPackageQuantity)} → ${number(line.toPackageQuantity)} ${escapeHtml(line.packageUom)} (${number(line.fromQuantity)} → ${number(line.toQuantity)} ${escapeHtml(line.salesUom)})</p>`).join('')}
      <p>${escapeHtml(detail.quantityReview?.error || 'Order creation and Dispatch wait for SCM confirmation.')}</p></div>`;
  }
  function quantityProposalEditor(detail) {
    if (detail.closeStatus !== 'active' || detail.operationallyComplete || detail.remotelyReconciled || ['applying','attention'].includes(detail.quantityReview?.status)) return '';
    return `<form class="stock-request-form" data-special-quantity-form><h4>Request an order quantity change</h4><p>SCM must confirm changes to the SO and PO. Original rates and discounts stay fixed.</p>
      ${detail.lines.filter(line=>line.salesDecision==='accepted').map(line=>`<article class="stock-request-line" data-special-material="${line.id}"><strong>${escapeHtml(line.productName)}</strong><div class="stock-request-line-fields">
        <label><span>Quantity (${escapeHtml(line.rateUom)}) *</span><input name="quantity" type="number" min="0.000001" step="0.000001" required value="${escapeHtml(detail.quantityReviewPending ? detail.quantityReview?.lines.find(change=>change.caseLineId===line.id)?.toPackageQuantity ?? line.packageQuantity : line.packageQuantity)}" /></label>
        <label><span>Original rate per unit</span><input name="rate" readonly value="${escapeHtml(line.originalRate)}" /></label><label><span>Discount (%)</span><input name="discountPercent" readonly value="${escapeHtml(line.discountPercent)}" /></label>
        <label><span>Subtotal (before tax)</span><output data-special-subtotal></output></label></div></article>`).join('')}
      <button type="submit">Request quantity change</button></form>`;
  }

  function newLine() {
    return {
      key: crypto.randomUUID(), productName: "", color: "", size: "",
      quantity: "", uom: "PLT", rate: "", discountPercent: 0, requiredDate: minimumRequiredDate(), customerNote: ""
    };
  }

  function startComposer() {
    state.formDrafts.clear();
    state.detail = null;
    state.soDraft = null;
    state.composer = {
      storeLocationId: String(state.yards[0]?.locationId || ""),
      inquiryDate: todayToronto(),
      customerId: "",
      customerName: "",
      customerPhone: "",
      selectedCustomerName: "",
      selectedCustomerPhone: "",
      vendorId: "",
      vendorName: "",
      selectedVendorName: "",
      estimateId: "",
      remarks: "",
      fulfillmentMethod: '', deliveryAddress: '', deliveryContactName: '', deliveryContactPhone: '',
      deliveryDate: '', windowStart: '', windowEnd: '', deliveryInstructions: '',
      lines: [newLine()]
    };
    state.caseCustomerResults = [];
    state.caseVendorResults = [];
    render();
  }

  function caseList() {
    if (state.loading) return `<div class="stock-request-empty"><strong>Loading Special Item cases…</strong></div>`;
    if (!state.requests.length) return `<div class="stock-request-empty"><strong>No matching Special Item cases</strong><span>Create a multi-line case for one vendor.</span></div>`;
    return state.requests.map((request) => `
      <button class="stock-request-card ${state.detail?.id === request.id ? "selected" : ""}" data-special-sales-action="select" data-id="${request.id}" type="button">
        <span class="stock-request-status-line"><strong>${escapeHtml(request.requestRef)}</strong>${pill(request.stage)}</span>
        <span>${escapeHtml(request.customerName)} · ${escapeHtml(request.vendorName)}</span>
        <small>${request.lines.length} line(s) · ${displayDate(request.updatedAt)}</small>${request.quantityReviewPending ? '<strong class="stock-request-error">Quantity changed · SCM review required</strong>' : ''}
      </button>`).join("");
  }

  function composerLine(line, index) {
    return `<article class="stock-request-line" data-special-composer-line="${index}">
      <header><strong>Line ${index + 1}</strong>${state.composer.lines.length > 1 ? `<button class="danger" data-special-sales-action="remove-case-line" data-index="${index}" type="button">Remove</button>` : ""}</header>
      <div class="stock-request-line-fields special-case-initial-grid">
        <label><span>Product name *</span><input name="productName" required value="${escapeHtml(line.productName)}" /></label>
        <label><span>Color</span><input name="color" value="${escapeHtml(line.color)}" /></label>
        <label><span>Size</span><input name="size" value="${escapeHtml(line.size)}" /></label>
        <label><span>Quantity *</span><input name="quantity" type="number" min="0.000001" step="any" required value="${escapeHtml(line.quantity)}" /></label>
        <label><span>UOM *</span><select name="uom" required>${[["PLT", "Plt"], ["LYR", "lyr"], ["SEC", "Sec"], ["PCS", "Pcs"], ["EACH", "Each"]].map(([value, label]) => `<option value="${value}" ${line.uom === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
        <label><span>Sales rate per unit *</span><input name="rate" type="number" min="0" step="0.000001" required value="${escapeHtml(line.rate)}" /></label>
        <label><span>Discount (%)</span><input name="discountPercent" type="number" min="0" max="100" step="0.0001" value="${escapeHtml(line.discountPercent)}" /></label>
        <label><span>Subtotal (before tax)</span><output data-special-subtotal></output></label>
        <label><span>Required date *</span><input name="requiredDate" type="date" min="${minimumRequiredDate()}" required value="${escapeHtml(line.requiredDate || minimumRequiredDate())}" /><small>Delivery requires at least three working days after SO placement, excluding weekends and Ontario public holidays.</small></label>
        <label class="special-case-line-note"><span>Line note</span><input name="customerNote" value="${escapeHtml(line.customerNote)}" /></label>
      </div>
    </article>`;
  }

  function composerView() {
    const draft = state.composer;
    return `<form class="stock-request-form" data-special-case-form>
      <div class="stock-request-heading"><div><h2>New Special Item case</h2><p>One case may have many items, but every line must use the same vendor.</p></div><button data-special-sales-action="cancel-compose" type="button">Close</button></div>
      <div class="stock-request-line-fields special-case-initial-grid">
        <label><span>Inquiry store *</span><select name="storeLocationId" required>${state.yards.map((yard) => `<option value="${yard.locationId}" ${String(yard.locationId) === draft.storeLocationId ? "selected" : ""}>${escapeHtml(yard.yardCode)}</option>`).join("")}</select></label>
        <label><span>Case inquiry date *</span><input name="inquiryDate" type="date" required value="${escapeHtml(draft.inquiryDate)}" /></label>
        <label class="stock-request-item-search"><span>Customer *</span><input name="customerName" data-special-case-customer-search autocomplete="off" required value="${escapeHtml(draft.customerName)}" /><small>Choose a NetSuite customer or keep free text.</small><div class="stock-request-suggestions" data-special-case-customer-suggestions>${state.caseCustomerResults.map((customer) => `<button data-special-sales-action="choose-case-customer" data-customer-id="${customer.id}" data-customer-name="${escapeHtml(customer.displayName)}" data-customer-phone="${escapeHtml(customer.phone)}" type="button"><strong>${escapeHtml(customer.entityNumber)} · ${escapeHtml(customer.displayName)}</strong><small>${escapeHtml(customer.phone || customer.email || "No phone in NetSuite")}</small></button>`).join("")}</div></label>
        <label><span>Phone</span><input name="customerPhone" value="${escapeHtml(draft.customerPhone)}" /><small>Filled from the selected NetSuite customer; editable for free text.</small></label>
        <label class="stock-request-item-search"><span>Vendor *</span><input name="vendorName" data-special-case-vendor-search autocomplete="off" required value="${escapeHtml(draft.vendorName)}" /><small>Choose a synced NetSuite vendor or keep free text.</small><div class="stock-request-suggestions" data-special-case-vendor-suggestions>${state.caseVendorResults.map((vendor) => `<button data-special-sales-action="choose-case-vendor" data-vendor-id="${vendor.id || ""}" data-vendor-name="${escapeHtml(vendor.name)}" type="button"><strong>${escapeHtml(vendor.name)}</strong><small>${vendor.id ? `NetSuite vendor ${vendor.id}` : "Synced NetSuite vendor"}</small></button>`).join("")}</div></label>
        <label><span>NetSuite Quote ID (optional)</span><input name="estimateId" type="number" min="1" value="${escapeHtml(draft.estimateId)}" /></label>
        <label class="stock-request-wide"><span>Customer / case notes</span><textarea name="remarks" rows="3">${escapeHtml(draft.remarks)}</textarea></label>
      </div>
      <div class="stock-request-line-fields">${fulfillmentFields(draft, true)}</div>
      <section class="stock-request-section"><h3>Requested items</h3><div class="stock-request-lines">${draft.lines.map(composerLine).join("")}</div></section>
      <div class="stock-request-actions"><button data-special-sales-action="add-case-line" type="button">Add line</button><button class="primary" type="submit" ${state.busy ? "disabled" : ""}>Submit to SCM</button></div>
    </form>`;
  }

  function fulfillmentFields(draft, initial = false) {
    return `<label><span>Delivery method *</span><select name="fulfillmentMethod" ${initial ? 'data-special-initial-fulfillment' : 'data-special-fulfillment'} required><option value="">Select method</option>${[['vendor_pickup','Customer pickup at vendor yard'],['yard_pickup','Pickup at inquired yard'],['mbt_delivery','Delivery']].map(([value,label]) => `<option value="${value}" ${draft.fulfillmentMethod === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      ${draft.fulfillmentMethod === 'vendor_pickup' ? '<p>SCM will confirm the vendor pickup location during the stock check.</p>' : ''}
      ${draft.fulfillmentMethod === 'mbt_delivery' ? `<label class="stock-request-wide"><span>Delivery address *</span><input name="deliveryAddress" required value="${escapeHtml(draft.deliveryAddress)}" /></label>
      <label><span>Preferred delivery date</span><input name="deliveryDate" type="date" min="${initial ? todayToronto() : earliestSpecialDeliveryDate()}" value="${escapeHtml(draft.deliveryDate)}" /><small>Minimum: three working days after SO placement, excluding weekends and Ontario public holidays.</small></label>
      <label><span>Window start</span><input name="windowStart" type="time" value="${escapeHtml(draft.windowStart)}" /></label>
      <label><span>Window end</span><input name="windowEnd" type="time" value="${escapeHtml(draft.windowEnd)}" /></label>
      <label class="stock-request-wide"><span>Delivery instructions</span><textarea name="deliveryInstructions">${escapeHtml(draft.deliveryInstructions)}</textarea></label>` : ''}`;
  }

  function decisionForm(line) {
    if (state.detail.closeStatus !== 'active' || state.detail.salesOrderId || state.detail.salesOrderSkipped || !line.supplyStatus || ['accepted', 'declined', 'closed'].includes(line.salesDecision)) return '';
    const canAccept = line.supplyStatus === 'in_stock' || line.availableDate;
    return `<form class="stock-request-line-fields special-inline-form" data-special-decision-form data-line-id="${line.id}">
      <label><span>Customer decision</span><select name="decision">${canAccept ? `<option value="accepted">${line.supplyStatus === 'in_stock' ? 'Customer confirms' : 'Customer will wait for ETA'}</option>` : ''}<option value="declined">Customer declines</option></select></label>
      <label><span>Reason (required unless accepted)</span><input name="reason" /></label>
      <label><span>Customer note</span><input name="customerNote" /></label>
      <button class="primary" type="submit">Save decision</button>
    </form>`;
  }

  function detailLine(line) {
    const product = [line.brand, line.productName, line.color, line.size].filter(Boolean).join(" · ");
    return `<article class="stock-request-line">
      <header><div><strong>${escapeHtml(product)}</strong><small>${number(line.quantity)} ${escapeHtml(line.uom)}</small></div>${pill(line.salesDecision)}</header>
      <div class="stock-request-summary">
        <span><small>SCM supply</small><strong>${escapeHtml(line.supplyStatus?.replaceAll("_", " ") || "Waiting")}</strong></span>
        <span><small>Projection</small><strong>${escapeHtml(line.availableDate || line.availabilityMode || "—")}</strong></span>
        <span><small>Vendor yard</small><strong>${escapeHtml(line.vendorYard || "—")}</strong></span>
        <span><small>Vendor ref</small><strong>${escapeHtml(line.vendorReference || "—")}</strong></span>
      </div>
      ${line.originalRate != null ? `<p>Original rate: ${number(line.originalRate)} / ${escapeHtml(line.rateUom)} · Discount: ${number(line.discountPercent)}% · Current subtotal: ${money(line.subtotal)}</p>` : ''}
      ${line.salesVisibleNote ? `<div class="stock-request-notice">${escapeHtml(line.salesVisibleNote)}</div>` : ""}
      ${line.itemResolution ? `<div class="stock-request-muted">Mapped to ${escapeHtml(line.itemResolution.itemName)} · ${number(line.itemResolution.salesQuantity)} ${escapeHtml(line.itemResolution.salesUom)}</div>` : ""}
      ${line.salesDecisionReason ? `<div class="stock-request-muted">Decision: ${escapeHtml(line.salesDecisionReason)}</div>` : ""}
      ${decisionForm(line)}
    </article>`;
  }

  function ensureSoDraft() {
    if (state.soDraft || !state.detail) return;
    state.soDraftDirty = false;
    const detail = state.detail;
    state.soDraft = {
      source: detail.salesOrderSource === 'estimate_transform' ? 'estimate_transform' : 'standalone',
      customerId: detail.customerId || "",
      customerSearch: detail.customerName || "",
      operationalYardLocationId: String(detail.operationalYardLocationId || detail.storeLocationId || state.yards[0]?.locationId || ""),
      fulfillmentMethod: detail.fulfillmentMethod || "yard_pickup",
      deliveryAddress: detail.deliveryAddress || "",
      deliveryContactName: detail.deliveryContactName || '', deliveryContactPhone: detail.deliveryContactPhone || '',
      palletTotal: detail.palletTotal ?? '', palletRate: detail.palletRate ?? '',
      deliveryDate: detail.deliveryDate || "",
      windowStart: detail.windowStart || "",
      windowEnd: detail.windowEnd || "",
      deliveryInstructions: detail.deliveryInstructions || "",
      materials: detail.lines.filter(line => line.salesDecision === 'accepted').map(line => ({
        caseLineId: line.id, itemId: 2055,
        description: line.itemResolution?.description || [line.brand, line.productName, line.color, line.size].filter(Boolean).join(' '),
        quantity: line.originalRate == null && line.pricingSource !== 'enquiry' ? line.itemResolution?.salesQuantity ?? line.quantity : line.packageQuantity ?? line.quantity,
        uom: line.rateUom || (line.pricingSource !== 'enquiry' ? line.itemResolution?.salesUom || 'PC' : line.uom),
        rate: line.originalRate ?? '', rateLocked: line.originalRate != null,
        discountPercent: line.discountPercent ?? 0, conversionToPc: line.conversionToPc ?? 1,
        legacy: line.pricingSource && line.pricingSource !== 'enquiry' 
      })),
      ancillaryLines: detail.salesOrderLines.filter(line => line.ancillary && line.itemId !== 1784).map(line => ({ ...line, key: crypto.randomUUID() })),
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
        <label><span>Sales rate</span><input name="rate" type="number" step="any" value="${escapeHtml(line.rate ?? "")}" /></label>
      </div>
      ${state.itemResults?.items?.length && Number(state.itemResults.index) === index ? `<div class="stock-request-suggestions special-static-suggestions">${state.itemResults.items.map((item) => `<button data-special-sales-action="choose-ancillary" data-index="${index}" data-item-id="${item.itemId}" data-item-name="${escapeHtml(item.itemName)}" type="button">${escapeHtml(item.itemName)} · ${escapeHtml(item.description)}</button>`).join("")}</div>` : ""}
    </article>`;
  }

  function soEditor() {
    ensureSoDraft();
    const draft = state.soDraft;
    if (!draft || !draft.materials.length) return "";
    const detail = state.detail;
    const canEdit = !detail.salesOrderId && !detail.salesOrderSkipped;
    if (!canEdit) {
      return `<section class="stock-request-section"><h3>Sales Order</h3>
        <div class="stock-request-summary"><span><small>SO</small><strong>${detail.salesOrderSkipped ? 'SO creation skipped (test)' : escapeHtml(detail.salesOrderRef)}</strong></span><span><small>Status</small><strong>${detail.salesOrderSkipped ? 'Test step completed' : escapeHtml(detail.salesOrderStatus || "Pending sync")}</strong></span><span><small>Approval</small><strong>${detail.salesOrderApproved ? "Approved / active" : "Waiting approval"}</strong></span></div>
        ${quantityProposalEditor(detail)}
        ${!detail.salesOrderSkipped && !detail.purchaseOrderSkipped ? '<div class="stock-request-actions"><button data-special-sales-action="refresh-so" type="button">Refresh NetSuite status</button></div>' : ''}
      </section>`;
    }
    return `<section class="stock-request-section special-order-editor"><h3>Create or link Sales Order</h3>
      <form class="stock-request-form" data-special-so-form>
        <div class="stock-request-line-fields">
          <input name="customerId" type="hidden" value="${escapeHtml(draft.customerId)}" />
          <label class="stock-request-item-search"><span>NetSuite Customer *</span><input name="customerSearch" data-special-customer-search required value="${escapeHtml(draft.customerSearch)}" autocomplete="off" /><small>Select a customer from the suggestions.</small><div class="stock-request-suggestions" data-special-customer-suggestions></div></label>
          <label><span>Operational yard *</span><select name="operationalYardLocationId">${state.yards.map((yard) => `<option value="${yard.locationId}" ${String(yard.locationId) === String(draft.operationalYardLocationId) ? "selected" : ""}>${escapeHtml(yard.yardCode)}</option>`).join("")}</select></label>
          ${fulfillmentFields(draft)}
          ${draft.fulfillmentMethod === 'mbt_delivery' ? `<label><span>Delivery photos or video</span><input data-special-media type="file" multiple accept="image/*,video/mp4,video/quicktime,video/webm" /><small>${draft.media.length} staged files</small></label>` : ''}
        </div>
        <h4>Accepted materials</h4>
        <div class="stock-request-lines">${draft.materials.map(line => `<article class="stock-request-line" data-special-material="${line.caseLineId}"><strong>MBBS-Special Order</strong><div class="stock-request-line-fields special-so-material-fields">
          <label class="stock-request-wide"><span>Sales description *</span><input name="description" required value="${escapeHtml(line.description)}" /></label>
          <label><span>Sales quantity *</span><input name="quantity" type="number" min="0.000001" step="any" required value="${escapeHtml(line.quantity)}" /></label>
          <label><span>Sales UOM</span><input name="uom" readonly value="${escapeHtml(line.uom)}" /></label>
          <label><span>Original rate per ${escapeHtml(line.uom)} *</span><input name="rate" type="number" min="0" step="0.000001" required ${line.rateLocked ? 'readonly' : ''} value="${escapeHtml(line.rate)}" /><small>${line.rateLocked ? 'Original rate is fixed. Apply a percentage discount.' : 'Legacy request: enter the initial rate once.'}</small></label>
          <label><span>Discount (%)</span><input name="discountPercent" type="number" min="0" max="100" step="0.0001" value="${escapeHtml(line.discountPercent)}" /></label>
          <label><span>Subtotal (before tax)</span><output data-special-subtotal></output></label>
          <p class="stock-request-wide" data-special-native></p></div></article>`).join('')}</div>
        <div class="stock-request-line-fields"><label><span>Pallets needed *</span><input name="palletTotal" type="number" min="0" step="1" required value="${escapeHtml(draft.palletTotal)}" /><small>0 omits the PALLET line.</small></label>
        <label><span>PALLET unit price (required when pallets &gt; 0)</span><input name="palletRate" type="number" min="0" step="any" value="${escapeHtml(draft.palletRate)}" /></label></div>
        <h4>Optional delivery charge or other ancillary items</h4>
        <div class="stock-request-lines">${draft.ancillaryLines.map(ancillaryEditor).join("")}</div>
        <div class="stock-request-actions"><button data-special-sales-action="add-ancillary" type="button">Add ancillary item</button><button class="primary" type="submit">Save SO draft</button></div>
      </form>
      ${detail.salesOrderLines.length ? `<div class="stock-request-actions"><select data-special-so-source><option value="standalone" ${draft.source === "standalone" ? "selected" : ""}>Create standalone SO</option>${detail.estimateId ? `<option value="estimate_transform" ${draft.source === "estimate_transform" ? "selected" : ""}>Transform estimate ${escapeHtml(detail.estimateNumber || detail.estimateId)}</option>` : ""}</select><button class="primary" data-special-sales-action="create-so" type="button" ${state.soDraftDirty || detail.quantityReviewPending ? 'disabled' : ''}>Create in NetSuite</button>${state.testSkipOrdersEnabled && !['creating','attention'].includes(detail.salesOrderOperationStatus) ? `<button data-special-sales-action="skip-so" type="button" ${state.soDraftDirty || detail.quantityReviewPending ? 'disabled' : ''}>Skip SO creation</button>` : ''}</div>` : ""}
      <p class="stock-request-muted" id="special-so-action-status" data-special-so-action-status role="status" hidden></p>
      <form class="stock-request-line-fields special-inline-form" data-special-link-so-form><label class="stock-request-item-search"><span>Search active Sales Order</span><input data-special-so-link-search autocomplete="off" /><div class="stock-request-suggestions" data-special-so-link-suggestions></div></label><label><span>Existing SO internal ID</span><input name="salesOrderId" type="number" min="1" required /></label><label><span>SO number</span><input name="salesOrderRef" required /></label><button type="submit" ${detail.quantityReviewPending ? 'disabled' : ''}>Link existing SO</button></form>
    </section>`;
  }

  function detailView() {
    const detail = state.detail;
    if (!detail) return `<div class="stock-request-empty"><strong>Select a Special Item case</strong><span>SCM responses, customer decisions, SO, PO, and fulfillment progress appear here.</span></div>`;
    return `<div class="stock-request-heading"><div><h2>${escapeHtml(detail.requestRef)}</h2><p>${escapeHtml(detail.customerName)} · ${escapeHtml(detail.vendorName)}</p></div>${pill(detail.stage)}</div>
      <div class="stock-request-summary">
        <span><small>Inquiry store</small><strong>${escapeHtml(detail.storeName)}</strong></span>
        <span><small>Delivery method</small><strong>${escapeHtml({vendor_pickup:'Customer pickup at vendor yard',yard_pickup:'Pickup at inquired yard',mbt_delivery:'Delivery'}[detail.fulfillmentMethod])}</strong></span><span><small>Inquiry date</small><strong>${escapeHtml(detail.inquiryDate)}</strong></span>
        <span><small>NetSuite Quote ID</small><strong>${escapeHtml(detail.estimateId || "Not linked")}</strong></span>
        <span><small>Revision</small><strong>${detail.revision}</strong></span>
      </div>
      ${detail.salesOrderSkipped || detail.purchaseOrderSkipped ? `<div class="stock-request-notice">Test request: ${detail.salesOrderSkipped ? 'SO creation skipped. ' : ''}${detail.purchaseOrderSkipped ? 'PO creation skipped. ' : ''}Skipped orders are excluded from live Dispatch.</div>` : ''}
      ${detail.attention ? `<div class="stock-request-notice stock-request-error">${escapeHtml(detail.attentionReason)}</div>` : ''}
      ${quantityReviewNotice(detail)}
      ${detail.closureReason ? `<div class="stock-request-notice">Closed: ${escapeHtml(detail.closureReason)}</div>` : ''}
      ${detail.remarks ? `<div class="stock-request-notice">${escapeHtml(detail.remarks)}</div>` : ""}
      ${detail.postPoChangePending ? `<div class="stock-request-notice stock-request-error"><strong>Vendor changed availability after PO:</strong> ${escapeHtml(JSON.stringify(detail.postPoChangeDetails))}<form data-special-ack-form><input name="acknowledgement" required placeholder="Customer acknowledgement" /><button type="submit">Record acknowledgement</button></form></div>` : ""}
      <section class="stock-request-section"><h3>Case lines</h3><div class="stock-request-lines">${detail.lines.map(detailLine).join("")}</div></section>
      ${detail.closeStatus === 'active' && detail.lines.every(line => ['accepted','declined','closed'].includes(line.salesDecision)) ? soEditor() : ''}
      ${(detail.purchaseOrderId || detail.purchaseOrderSkipped) ? `<section class="stock-request-section"><h3>Purchase and fulfillment</h3><div class="stock-request-summary"><span><small>PO</small><strong>${detail.purchaseOrderSkipped ? 'PO creation skipped (test)' : escapeHtml(detail.purchaseOrderRef)}</strong></span><span><small>PO status</small><strong>${escapeHtml(detail.purchaseOrderStatus || "Pending sync")}</strong></span><span><small>Dispatch route</small><strong>${escapeHtml(detail.handoffRoute || (detail.fulfillmentMethod === "vendor_pickup" ? "Not required" : "Waiting Dispatch"))}</strong></span><span><small>Completion</small><strong>${detail.operationallyComplete ? "Operationally complete" : "In progress"}</strong></span></div>${detail.vendorPickupDate ? `<div class="stock-request-muted">Customer pickup: ${escapeHtml(detail.vendorPickupDate)} · ${escapeHtml(detail.vendorPickupReference)}</div>` : ""}</section>` : ""}
      ${(detail.purchaseOrderId || detail.purchaseOrderSkipped) && detail.fulfillmentMethod === "vendor_pickup" && !detail.operationallyComplete && detail.lines.filter(line => line.salesDecision === "accepted").every(line => line.supplyStatus === "in_stock") ? `<form class="stock-request-line-fields special-inline-form" data-special-vendor-pickup-form><label><span>Customer pickup date *</span><input name="pickupDate" type="date" required value="${todayToronto()}" /></label><label><span>Pickup reference / evidence *</span><input name="pickupReference" required /></label><button class="primary" type="submit">Complete vendor pickup</button></form>` : ""}
      ${detail.closeStatus === "active" && !detail.purchaseOrderId && !detail.purchaseOrderSkipped ? `<form class="stock-request-line-fields special-inline-form" data-special-close-form><label><span>Close reason</span><input name="reason" required /></label><button class="danger" type="submit">Close case</button></form>` : ""}
      ${detail.closeStatus === "closure_pending" ? `<div class="stock-request-notice">Closure waits for the linked SO to become cancelled/closed in NetSuite.</div>` : ""}`;
  }

  function render() {
    const restoreScroll = preserveSpecialScroll?.(mount);
    if (state.detail) state.requests = state.requests.map(request => request.id === state.detail.id ? state.detail : request)
      .filter(request => !state.stages.length || state.stages.includes(request.stage))
      .sort((a,b) => Number(Boolean(b.quantityReviewPending)) - Number(Boolean(a.quantityReviewPending)));
    if (state.enabled === false) {
      mount.innerHTML = `${header()}<section class="stock-request-page"><div class="stock-request-tabs"><button data-special-sales-action="regular" type="button">Regular</button><button aria-selected="true" type="button">Special</button></div><div class="stock-request-empty"><strong>Special Item workflow is off</strong><span>An administrator must enable special_stock_request_workflow after reviewing NetSuite mappings.</span></div></section>`;
      return;
    }
    mount.innerHTML = `${header()}<section class="stock-request-page special-stock-page">
      <div class="stock-request-tabs"><button data-special-sales-action="regular" type="button">Regular</button><button aria-selected="true" type="button">Special</button></div>
      <div class="stock-request-toolbar"><div class="stock-request-actions"><input class="stock-request-search" data-special-search value="${escapeHtml(state.search)}" placeholder="Search case, customer, vendor, SO, PO, or item" />${stageFilterHtml(state.stages)}<button class="primary" data-special-sales-action="new" type="button">New Special case</button><button data-special-sales-action="refresh" type="button">Refresh</button></div></div>
      <div class="stock-request-feedback">${state.notice ? `<div class="stock-request-notice">${escapeHtml(state.notice)}</div>` : ""}${state.error ? `<div class="stock-request-notice stock-request-error">${escapeHtml(state.error)}</div>` : ""}</div>
      <div class="stock-request-workspace"><aside class="stock-request-panel stock-request-list">${caseList()}</aside><section class="stock-request-panel stock-request-detail">${state.composer ? composerView() : detailView()}</section></div>
    </section>`;
    restoreSpecialForms?.(mount, state.formDrafts);
    refreshPricing();
    syncSoActionAvailability();
    restoreScroll?.();
  }

  async function load({ selectedId = state.detail?.id } = {}) {
    state.loading = true;
    state.formDrafts.clear();
    state.error = "";
    render();
    try {
      const params = new URLSearchParams({ search: state.search, stages: state.stages.join(",") });
      const payload = await api(`/api/sales/special-stock-requests?${params}`);
      state.yards = payload.yards || state.yards;
      state.requests = payload.requests || [];
      if (selectedId) state.detail = await api(`/api/sales/special-stock-requests/${selectedId}`);
      else if (state.requests[0]) state.detail = await api(`/api/sales/special-stock-requests/${state.requests[0].id}`);
      else state.detail = null;
      state.soDraft = null;
    } finally {
      state.loading = false;
      render();
    }
  }

  function syncCaseComposerFromDom() {
    const form = mount.querySelector("[data-special-case-form]");
    if (!form) return;
    const values = new FormData(form);
    for (const field of ["storeLocationId", "inquiryDate", "customerName", "customerPhone", "vendorName", "estimateId", "remarks", "fulfillmentMethod", "deliveryAddress", "deliveryContactName", "deliveryContactPhone", "deliveryDate", "windowStart", "windowEnd", "deliveryInstructions"]) state.composer[field] = values.get(field) || "";
    for (const element of form.querySelectorAll("[data-special-composer-line]")) {
      const line = state.composer.lines[Number(element.dataset.specialComposerLine)];
      for (const input of element.querySelectorAll("[name]")) line[input.name] = input.value;
    }
  }

  function syncSoFromDom() {
    const form = mount.querySelector("[data-special-so-form]");
    if (!form || !state.soDraft) return;
    const values = new FormData(form);
    for (const field of ["customerId", "customerSearch", "operationalYardLocationId", "fulfillmentMethod", "deliveryAddress", "deliveryDate", "windowStart", "windowEnd", "deliveryInstructions", "deliveryContactName", "deliveryContactPhone", "palletTotal", "palletRate"]) {
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
    const reason = state.soDraftDirty ? 'Save the updated SO draft before continuing.'
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
    if (event.target.closest('[data-special-composer-line], [data-special-material]')) refreshPricing();
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

  mount.addEventListener("change", async (event) => {
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
      state.busy = false;
      render();
    }
    if (event.target.matches("[data-special-stage]")) { state.stages = [...mount.querySelectorAll("[data-special-stage]:checked")].map(input => input.value); await load({ selectedId: null }); mount.querySelector(".special-stage-filter").open = true; }
  });

  mount.addEventListener("submit", async (event) => {
    const form = event.target;
    if (state.busy) { event.preventDefault(); return; }
    if (!form.matches("[data-special-case-form], [data-special-decision-form], [data-special-so-form], [data-special-link-so-form], [data-special-close-form], [data-special-ack-form], [data-special-vendor-pickup-form], [data-special-quantity-form]")) return;
    event.preventDefault();
    state.busy = true;
    syncSoActionAvailability();
    state.error = "";
    rememberSpecialForm(state.formDrafts, form);
    try {
      if (form.matches("[data-special-case-form]")) {
        syncCaseComposerFromDom();
        const payload = {
          ...state.composer,
          storeLocationId: Number(state.composer.storeLocationId),
          customerId: state.composer.customerId ? Number(state.composer.customerId) : null,
          vendorId: state.composer.vendorId ? Number(state.composer.vendorId) : null,
          estimateId: state.composer.estimateId ? Number(state.composer.estimateId) : null,
          lines: state.composer.lines.map((line) => ({ ...line, quantity: Number(line.quantity) }))
        };
        for (const field of ["selectedCustomerName", "selectedCustomerPhone", "selectedVendorName"]) delete payload[field];
        const detail = await api("/api/sales/special-stock-requests", { method: "POST", body: JSON.stringify(payload) });
        state.composer = null;
        state.notice = `${detail.requestRef} submitted to SCM.`;
        return await load({ selectedId: detail.id });
      }
      if (form.matches("[data-special-decision-form]")) {
        const values = Object.fromEntries(new FormData(form));
        state.detail = await api(`/api/sales/special-stock-requests/${state.detail.id}/lines/${form.dataset.lineId}/decision`, {
          method: "POST",
          body: JSON.stringify({
            expectedRevision: state.detail.revision,
            decision: values.decision,
            reason: values.reason,
            customerNote: values.customerNote
          })
        });
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
            operationalYardLocationId: Number(draft.operationalYardLocationId),
            fulfillmentMethod: draft.fulfillmentMethod,
            deliveryAddress: draft.deliveryAddress,
            deliveryContactName: draft.deliveryContactName, deliveryContactPhone: draft.deliveryContactPhone,
            palletTotal: draft.palletTotal, palletRate: draft.palletRate,
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
      } else if (form.matches('[data-special-quantity-form]')) {
        state.detail = await api(`/api/sales/special-stock-requests/${state.detail.id}/quantity-change`, { method: 'POST', body: JSON.stringify({
          expectedRevision: state.detail.revision, lines: [...form.querySelectorAll('[data-special-material]')].map(element => ({
            caseLineId: Number(element.dataset.specialMaterial), quantity: element.querySelector('[name=quantity]').value
          }))
        }) });
        state.soDraft = null; state.notice = 'Quantity change sent to SCM for confirmation.';
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
      if (error.status === 409 && state.detail) state.detail = await api(`/api/sales/special-stock-requests/${state.detail.id}`).catch(() => state.detail);
    } finally {
      state.busy = false;
      render();
    }
  });

  mount.addEventListener("click", async (event) => {
    if (event.target.closest('[data-special-clear-stages]')) { state.stages = []; await load({ selectedId: null }); return; }
    const button = event.target.closest("[data-special-sales-action]");
    if (!button || state.busy || button.disabled) return;
    const action = button.dataset.specialSalesAction;
    if (['create-so','skip-so'].includes(action) && (state.soDraftDirty || state.detail?.quantityReviewPending)) {
      state.error = 'Save the updated SO draft and finish any SCM quantity review before continuing.';
      return render();
    }
    try {
      if (action === "regular") return location.reload();
      if (action === "new") return startComposer();
      if (action === "cancel-compose") { state.composer = null; state.formDrafts.clear(); return render(); }
      if (action === "add-case-line") { syncCaseComposerFromDom(); state.composer.lines.push(newLine()); return render(); }
      if (action === "remove-case-line") { syncCaseComposerFromDom(); state.formDrafts.clear(); state.composer.lines.splice(Number(button.dataset.index), 1); return render(); }
      if (action === "refresh") return load();
      if (action === "select") { state.formDrafts.clear(); state.composer = null; state.soDraft = null; state.detail = await api(`/api/sales/special-stock-requests/${button.dataset.id}`); return render(); }
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
        rememberSpecialForm(state.formDrafts, form);
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
      state.busy = true;
      state.error = "";
      syncSoActionAvailability();
      if (action === "create-so") {
        const source = mount.querySelector("[data-special-so-source]")?.value || "standalone";
        state.detail = await api(`/api/sales/special-stock-requests/${state.detail.id}/sales-order/create`, {
          method: "POST", body: JSON.stringify({ expectedRevision: state.detail.revision, operationId: state.detail.salesOrderOperationId || crypto.randomUUID(), source })
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
      state.busy = false;
      render();
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
      ({ SPECIAL_STAGES, stageFilterHtml } = await workflowReady);
      ({ specialFormKey, rememberSpecialForm, restoreSpecialForms, preserveSpecialScroll } = await formsReady);
      ({ specialLineSubtotal, specialNativePricing, earliestSpecialDeliveryDate } = await pricingReady);
      state.operator = operator || state.operator;
      state.yards = yards || state.yards;
      state.loading = true;
      render();
      try {
        const policy = await api("/api/sales/special-stock-requests/policy");
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

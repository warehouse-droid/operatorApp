/* global HTMLInputElement, HTMLFormElement */
const scmStockYardFilterReady = import('/stock-request-yard-filter.js?v=20260927&filterApply=20261010-v1');
let scmStockYardFilterHtml = () => '';
const scmStockQueueFilterUrl = '/stock-request-queue-filter.js?v=20261007-v3&filterApply=20261010-v1';
const scmStockQueueFilterReady = import(scmStockQueueFilterUrl);
/** @type {(selected?:unknown)=>string} */
let scmStockQueueFilterHtml = () => '';
/** @param {string} value */
const scmStockQueueIncludes = value => !scmStockState.queue || scmStockState.queue.split(',').includes(value);
function scmStockShowsTransfers() {
  const request=scmStockState.detail;
  if (!request) return false;
  return Boolean(request?.transfers?.length) && (scmStockQueueIncludes('pending_to') || scmStockQueueIncludes('closed'))
    && (!scmStockState.queue.includes(',') && scmStockState.queue!=='' || !request.lines.some(/** @param {{status:string}} line */ line=>['submitted','changes_requested'].includes(line.status)));
}
const scmStockRequestApp = /** @type {HTMLElement} */ (document.getElementById("scmStockRequestApp"));
const scmStockUpdates = window.StockRequestView?.create({mount:scmStockRequestApp,active:()=>!window.MBBSStockRequestTabs || window.MBBSStockRequestTabs.isActive('regular')});

const scmStockState = {
  operator: null,
  queue: new URLSearchParams(location.search).get("review") === "1" ? "request" : (localStorage.getItem("mbbs.scm.stockRequests.queue") ?? "request"),
  search: "",
  requestTypeFilter:"",
  backorderStageFilter:"",
  vendorFilter: "",
  requestDateFilter: "",
  sourceLocationFilter: "",
  destinationLocationFilter: "",
  filterOptions: { vendors: [], sourceYards: [], destinationYards: [] },
  requests: /** @type {Array<Record<string,any>&{id:number,revision:number,workflowVersion:number,status:string,regular:Record<string,any>}>} */ ([]),
  selectedId: Number(localStorage.getItem("mbbs.scm.stockRequests.selected")) || null,
  selectedTransferId: /** @type {number|null} */ (null),
  detail: /** @type {Record<string,any>&{id:number,revision:number,workflowVersion:number,status:string,regular:Record<string,any>}|null} */ (null),
  replyDraft: /** @type {import('../tools/regular-stock-resolution-globals.js').StockingReplyDraft|null} */ (null),
  resolveDraft: /** @type {import('../tools/regular-stock-resolution-globals.js').RegularResolutionDraft|null} */ (null),
  purchaseReviewQuantities: /** @type {Record<number,string>} */ ({}),
  purchaseReleaseReasons: /** @type {Record<number,string>} */ ({}),
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
  return `<span class="stock-request-pill ${scmStockEscape(normalized)}">${scmStockEscape(window.RegularStockReply?.label(normalized)||normalized.replaceAll("_", " "))}</span>`;
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
    throw window.RegularStockUI.apiError(payload,response.status);
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
  scmStockState.requests = window.StockRequestConversation?.order(scmStockState.requests) || scmStockState.requests;
  if (scmStockState.loading && !scmStockState.requests.length) return `<div class="stock-request-empty"><strong>Loading requests…</strong></div>`;
  if (!scmStockState.requests.length) return `<div class="stock-request-empty"><strong>No records in this queue</strong><span>Live changes will appear automatically.</span></div>`;
  return scmStockState.requests.map((request) => {
    const pendingLines = request.lines.filter((line) => ["submitted", "changes_requested"].includes(line.status)).length;
    const pendingTransfers = request.transfers.filter((transfer) => !["received", "cancelled", "closed"].includes(transfer.status)).length;
    const rejectedLines = request.lines.filter((line) => line.status === "rejected").length;
    const closedTransfers = request.transfers.filter((transfer) => transfer.status === "closed").length;
    const countLabel = request.workflowKind==='backorder'?`Backorder · ${scmStockEscape(request.stage.replaceAll("_"," "))}`:window.RegularPurchaseUI?.purchase(request)
      ?window.RegularStockUI.t(`Purchase · ${pendingLines} pending item(s)`,`采购 · ${pendingLines} 行待审核`)
      :scmStockState.queue === "request"
      ? `${pendingLines} actionable line(s)`
      : scmStockState.queue === "pending_to"
        ? `${pendingTransfers} pending TO(s)`
        : scmStockState.queue === "rejected"
          ? `${rejectedLines} rejected line(s)`
          : scmStockState.queue === "closed" ? `${closedTransfers} closed TO(s)` : `${pendingLines} actionable line(s) · ${pendingTransfers} pending TO(s) · ${rejectedLines} rejected line(s) · ${closedTransfers} closed TO(s)`;
    return `<button class="stock-request-card ${Number(request.id) === Number(scmStockState.selectedId) ? "selected" : ""}" data-scm-stock-action="select" data-id="${Number(request.id)}" type="button">
      <span class="stock-request-status-line"><strong>${scmStockEscape(request.requestRef)}</strong>${scmStockPill(window.RegularStockReply?.status(request)||request.bucket||request.status)}</span>
      <span>To ${scmStockEscape(request.destinationName)} · ${countLabel}</span>
      ${window.RegularStockUI.customer(request)}
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
  if(scmStockState.detail?.workflowVersion===2 && scmStockState.detail.status==='completed')return `<option value="${Number(line.sourceLocationId)}">${scmStockEscape(line.sourceName)}</option>`;
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
  const actionable = scmStockActionable(line);
  const editable = line.status === "submitted";
  const snapshot=scmStockState.detail.workflowVersion===2 && (!!scmStockState.detail.regular?.pickupTransfer || scmStockState.detail.regular?.handoffStatus==='complete' || scmStockState.detail.status==='completed');
  return `<article class="stock-request-line" data-scm-stock-line-id="${Number(line.id)}">
    <header>
      <div class="stock-request-status-line">${actionable&&!window.RegularStockUI.stocking(scmStockState.detail) ? `<input data-scm-stock-select-line type="checkbox" ${scmStockState.selectedLineIds.has(line.id) ? "checked" : ""} aria-label="Select ${scmStockEscape(line.itemName)}" />` : ""}<div><strong>${scmStockEscape(line.itemName)}</strong><div class="stock-request-muted">${scmStockEscape(line.itemDescription || "")}</div></div></div>
      ${scmStockPill(window.RegularStockWaitlistTransition?.lineStatus(scmStockState.detail,line)==='waitlisted'?'waitlisted':window.RegularStockReply?.lineStatus(scmStockState.detail,line)||line.status)}
    </header>
    <div class="stock-request-line-fields">
      <label><span>Source yard</span><select data-scm-stock-source ${editable ? "" : "disabled"}>${snapshot?`<option>${scmStockEscape(line.sourceName)}</option>`:scmStockSourceOptions(line)}</select></label>
      ${scmStockQuantityInputs(line, "line", !editable)}
    </div>
    ${snapshot?'':scmStockAvailabilityMatrix(line.itemId)}
    ${window.RegularStockUI.safety(scmStockState.detail,line)}
    ${line.decisionReason ? `<div class="stock-request-notice"><strong>Decision reason:</strong> ${scmStockEscape(line.decisionReason)}</div>` : ""}
    ${window.RegularStockWaitlistTransition?.result(scmStockState.detail,line,'scm')||''}
    ${window.RegularStockUI.stocking(scmStockState.detail)?`<div class="stock-request-actions">${actionable?`<button class="danger" data-scm-stock-action="reject" data-line-id="${line.id}" type="button" ${scmStockState.busy?'disabled':''}>${window.RegularStockUI.t('Reject','拒绝')}</button>`:''}${window.RegularStockReply?.button(scmStockState.detail,'scm',scmStockState.busy,undefined,line)||''}${window.RegularStockResolution?.button(scmStockState.detail,scmStockState.busy,line)||''}</div>${window.RegularStockResolution?.result(scmStockState.detail,line)||''}${window.RegularStockResolution?.editor(scmStockState.detail,scmStockState.resolveDraft,scmStockState.busy,line)||''}${window.RegularStockReply?.panel(scmStockState.detail,'scm',scmStockState.replyDraft,scmStockState.busy,undefined,{line,showButton:false})||''}`:''}
    ${editable||window.RegularStockWaitlistTransition?.eligible(scmStockState.detail,line)?`<div class="stock-request-actions">${editable?'<button data-scm-stock-action="save-line" type="button">Save line adjustment</button>':''}${window.RegularStockWaitlistTransition?.button(scmStockState.detail,line,scmStockState.busy)||''}</div>`:''}
  </article>`;
}

function scmStockDecisionEditor() {
  const pending = scmStockState.pendingDecision;
  if (!pending) return "";
  const isReject = pending.decision === "reject";
  const approval=["stock","po"].includes(pending.decision);
  const label = approval ? window.RegularStockDelivery.simple(scmStockState.detail)?window.RegularStockUI.t('Approve and create TO','批准并建立调货单'):window.RegularStockUI.decision(pending.decision) : isReject ? "Reject" : "Request Changes";
  const title = approval ? label : isReject ? "Reject stock-request lines" : "Request changes for stock-request lines";
  return `<section class="stock-request-section stock-request-form stock-request-decision-editor" role="dialog" aria-labelledby="scmStockDecisionTitle">
    <h3 id="scmStockDecisionTitle">${title}</h3>
    <p>${pending.lineIds.length} ${window.RegularStockUI.t("line(s) will be updated.","行将被更新。")} ${approval ? window.RegularStockUI.t("Notes are optional.","备注选填。") : "Enter the required reason before confirming."}</p>
    <label><span>${label} reason</span><textarea data-scm-stock-decision-reason maxlength="1000" rows="3" ${approval?"":"required"}>${scmStockEscape(pending.reason || "")}</textarea></label>
    <div class="stock-request-actions">
      <button data-scm-stock-action="cancel-decision" type="button">Cancel</button>
      <button class="${isReject ? "danger" : "primary"}" data-scm-stock-action="confirm-decision" type="button">Confirm ${label}</button>
    </div>
  </section>`;
}

function scmStockActionable(line) {
  return line.status==='submitted' || line.status==='changes_requested' || (line.status==='approved' && !window.RegularPurchaseUI?.purchase(scmStockState.detail) && window.RegularStockUI.stocking(scmStockState.detail) && !scmStockState.detail.regular.pickupTransfer);
}

function scmStockPickupButton(request) {
  if(!window.RegularStockUI.stocking(request) || request.regular.pickupTransfer?.status==='complete')return '';
  return `<button class="primary" data-scm-stock-action="pickup-convert" type="button">${request.regular.pickupTransfer?window.RegularStockUI.t('Retry / check TO creation','重试 / 查看调货单'):window.RegularStockUI.t('Convert to TO','转换为调货单')}</button>`;
}

/** @type {ReturnType<typeof import('./backorder-stock-requests.js').createBackorderUI>|undefined} */
let scmBackorderUI;
/** @type {ReturnType<typeof import('./stocking-backorder-conversion-ui.js').createStockingBackorderUI>|undefined} */
let scmStockingBackorderUI;
const scmBackorderReady=()=>Promise.all([import(new URL('/backorder-stock-requests.js?transferEta=20261016&lineVisibility=20261016&conversation=20261016&v=20261014-live-stock',location.href).href),import(new URL('/stocking-backorder-conversion-ui.js?v=20261007-v1',location.href).href)]).then(([{createBackorderUI},{createStockingBackorderUI}])=>{
  scmBackorderUI=createBackorderUI({mount:scmStockRequestApp,audience:'scm',api:scmStockApi,getDetail:()=>/** @type {import('./backorder-workflow.js').BackorderRequest|null} */ (scmStockState.detail),
    setDetail:(/** @type {import('./backorder-workflow.js').BackorderRequest} */ request)=>{scmStockState.detail=request;scmStockState.requests=scmStockState.requests.map(row=>row.id===request.id?request:row);},render:renderScmStockRequests});
  scmStockingBackorderUI=createStockingBackorderUI({api:scmStockApi,onConverted:(/** @type {any} */ request)=>{
    if(scmStockState.detail?.id!==request.id)return;
    scmStockState.detail=request;scmStockState.requests=scmStockState.requests.map(row=>row.id===request.id?request:row);
    scmStockState.selectedLineIds.clear();scmStockState.replyDraft=null;scmStockState.resolveDraft=null;
    scmStockState.queue='request';localStorage.setItem('mbbs.scm.stockRequests.queue','request');
    scmStockState.notice='Stocking request converted to Backorder. Review the stock before Sales replies.';renderScmStockRequests();
  }});
});
function scmStockRequestDetail() {
  const request = scmStockState.detail;
  if(scmBackorderUI?.isBackorder(request))return scmBackorderUI.detail(/** @type {import('./backorder-workflow.js').BackorderRequest} */ (request));
  if (!request) return `<div class="stock-request-empty"><strong>Select a request</strong><span>All-yard availability and line decisions will appear here.</span></div>`;
  if(window.RegularPurchaseUI?.purchase(request))return `<div class="stock-request-actions">${scmStockingBackorderUI?.button(request,scmStockState.busy)||''}</div>`+window.RegularPurchaseUI.detail(request,true,{selectedLineIds:scmStockState.selectedLineIds,reviewedQuantities:scmStockState.purchaseReviewQuantities||{},releaseReasons:scmStockState.purchaseReleaseReasons||{},resolveDraft:scmStockState.resolveDraft,replyDraft:scmStockState.replyDraft,busy:scmStockState.busy})+scmStockDecisionEditor();
  if(window.RegularStockDelivery.simple(request))return window.RegularStockDelivery.scm(request,scmStockDecisionEditor());
  const selectable = request.lines.filter(scmStockActionable);
  const selected = request.lines.filter((line) => scmStockState.selectedLineIds.has(line.id));
  const canRequestChanges = selected.length > 0 && selected.every((line) => line.status === "submitted");
  const snapshot=request.workflowVersion===2 && (!!request.regular?.pickupTransfer || request.regular?.handoffStatus==='complete' || request.status==='completed');
  return `<div class="stock-request-heading">
      <div><h2>${scmStockEscape(request.requestRef)}</h2><p>${scmStockEscape(request.requestedByName || request.requestedBy || "")} · destination ${scmStockEscape(request.destinationName)}</p></div>
      ${scmStockPill(window.RegularStockReply?.status(request)||request.bucket||request.status)}
    </div>
    <div class="stock-request-summary">
      <span><small>Destination</small><strong>${scmStockEscape(request.destinationName)}</strong></span>
      <span><small>Revision</small><strong>${Number(request.revision)}</strong></span>
      <span><small>Submitted</small><strong>${scmStockDate(request.createdAt)}</strong></span>
      <span><small>First SCM decision</small><strong>${scmStockDate(request.firstScmDecisionAt)}</strong></span>
    </div>
    ${window.RegularStockUI.summary(request)}
    ${window.RegularStockUI.stocking(request)?window.RegularStockUI.stockingResult(request):''}
    ${request.regular?.pickupTransfer?scmStockPickupButton(request):''}
    ${request.remarks ? `<div class="stock-request-notice"><strong>Sales remark:</strong> ${scmStockEscape(request.remarks)}</div>` : ""}
    ${scmStockBackorderNotice(selectable)}
    <div class="stock-request-actions">
      ${scmStockingBackorderUI?.button(request,scmStockState.busy)||''}
      ${snapshot?'':`
      ${window.RegularStockUI.stocking(request)?'':`<button data-scm-stock-action="select-all" type="button" ${selectable.length ? "" : "disabled"}>Select actionable lines</button>`}
      ${request.workflowVersion===2 ? `<button data-scm-stock-action="refresh-evidence" type="button">${window.RegularStockUI.t('Refresh stock evidence','刷新库存数据')}</button>${window.RegularStockUI.stocking(request)?scmStockPickupButton(request):`<button class="primary" data-scm-stock-action="approve-stock" type="button" ${canRequestChanges?'':'disabled'}>${window.RegularStockUI.t('Approve · TO / location change','批准 · 调货 / 更改地点')}</button><button data-scm-stock-action="approve-po" type="button" ${canRequestChanges?'':'disabled'}>${window.RegularStockUI.t('Approve · source replenishment PO','批准 · 原货场采购补货')}</button>`}` : `<button class="primary" data-scm-stock-action="convert" type="button" ${scmStockState.selectedLineIds.size ? "" : "disabled"}>Convert to TO</button>
      <button data-scm-stock-action="request-changes" type="button" ${canRequestChanges ? "" : "disabled"}>Request Changes</button>`}
      ${window.RegularStockUI.stocking(request)?'':`<button class="danger" data-scm-stock-action="reject" type="button" ${selectable.length ? "" : "disabled"}>${selected.length ? "Reject selected" : "Reject all actionable"}</button>`}
      `}
    </div>
    ${scmStockDecisionEditor()}
    ${window.RegularStockReply?.panel(request,'scm',null,scmStockState.busy,undefined,{showButton:false})||''}
    <section class="stock-request-section"><h3>${snapshot?window.RegularStockUI.t('Request lines · saved decision snapshot','申请商品 · 已保存的审核记录'):'Request lines and all-yard availability'}</h3><div class="stock-request-lines">${request.lines.map(scmStockRequestLine).join("")}</div></section>`;
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

function scmStockCanRestructureTransfer(transfer) {
  return transfer.status === "pending_local"
    && transfer.confirmationStatus === "idle"
    && !transfer.confirmationRequestId
    && !transfer.netsuiteTransferOrderId
    && !transfer.netsuiteTransferOrderRef
    && !transfer.printJobId
    && !transfer.printGeneration;
}

function scmStockTransferLine(line, { canEditQuantities, canEditStructure } = {}) {
  return `<article class="stock-request-line" data-scm-stock-transfer-line-id="${Number(line.id)}">
    <header><div><strong>${scmStockEscape(line.itemName)}</strong><div class="stock-request-muted">${scmStockEscape(line.itemDescription || "")}</div></div><strong>${scmStockNumber(line.salesQty)} ${scmStockEscape(line.salesUom)}</strong></header>
    <div class="stock-request-line-fields">
      <label><span>Outbound location</span><select data-scm-stock-transfer-source ${canEditStructure ? "" : "disabled"}>${scmStockSourceOptions(line)}</select></label>
      ${scmStockQuantityInputs(line, "transfer", !canEditQuantities)}
    </div>
    ${canEditStructure ? `<label class="stock-request-line-removal"><input data-scm-stock-remove-transfer-line type="checkbox" /> <span>Remove from this TO <small>Returns this line to the Request queue.</small></span></label>` : ""}
    ${window.RegularStockReply?.panel(scmStockState.detail,'scm',scmStockState.replyDraft,scmStockState.busy,undefined,{line})||''}
  </article>`;
}

function scmStockPendingToDetail() {
  const request = scmStockState.detail;
  if (!request) return `<div class="stock-request-empty"><strong>Select a pending TO</strong><span>Local and real Transfer Order controls will appear here.</span></div>`;
  if (!request.transfers.length) return `<div class="stock-request-empty"><strong>No pending TO on this request</strong></div>`;
  const transfer = scmStockSelectedTransfer();
  scmStockState.selectedTransferId = transfer.id;
  const canEdit = request.workflowVersion !== 2 && !["partially_fulfilled", "pending_receipt", "received", "cancelled", "closed"].includes(transfer.status);
  const canEditStructure = request.workflowVersion !== 2 && scmStockCanRestructureTransfer(transfer);
  const canConfirm = !window.RegularStockDelivery.simple(request) && !request.regular?.pickupTransfer && ["pending_local", "attention"].includes(transfer.status);
  const hasPrinted = Boolean(transfer.printJobId || transfer.printGeneration);
  const canRejectPending = request.workflowVersion !== 2 && transfer.status === "pending_local"
    && transfer.confirmationStatus === "idle"
    && !transfer.confirmationRequestId
    && !transfer.netsuiteTransferOrderId
    && !transfer.netsuiteTransferOrderRef
    && !transfer.printJobId
    && !transfer.printGeneration;
  return `<div class="stock-request-heading">
      <div><h2>${scmStockEscape(request.requestRef)} · ${scmStockEscape(transfer.transferRef)}</h2><p>${scmStockEscape(transfer.sourceName)} → ${scmStockEscape(transfer.destinationName)}</p></div>
      ${scmStockPill(transfer.status)}
      ${window.RegularStockReply?.label(request.displayStatus)?scmStockPill(request.displayStatus):''}
    </div>
    ${scmStockTransferList(request)}
    ${window.RegularStockUI.customer(request)}
    ${window.RegularStockDelivery.simple(request)?window.RegularStockDelivery.summary(request)+window.RegularStockDelivery.progress(request,true):''}
    ${request.regular?.pickupTransfer?window.RegularStockUI.stockingResult(request)+scmStockPickupButton(request):''}
    ${window.RegularStockReply?.panel(request,'scm',scmStockState.replyDraft,scmStockState.busy,undefined,{showButton:false})||''}
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
    ${request.status==='completed'?'':scmStockBackorderNotice(transfer.lines, { transfer })}
    ${request.workflowVersion===2 && (request.regular?.pickupTransfer || request.status==='completed')?`<section class="stock-request-section"><h3>${window.RegularStockUI.t('Request lines · saved decision snapshot','申请商品 · 已保存的审核记录')}</h3>${request.lines.map(line=>`<article class="stock-request-line"><strong>${scmStockEscape(line.itemName)} · ${scmStockEscape(line.sourceName)}</strong>${window.RegularStockUI.safety(request,line)}</article>`).join('')}</section>`:''}
    <section class="stock-request-section"><h3>TO material lines</h3>
      ${canEditStructure ? `<div class="stock-request-notice">Change a line's outbound location to move it into a separate local Pending TO for that route. Remove a line to return it to the Request queue. These route changes are available before Confirm TO + Print.</div>` : ""}
      <div class="stock-request-lines">${transfer.lines.map((line) => scmStockTransferLine(line, { canEditQuantities: canEdit, canEditStructure })).join("")}</div>
    </section>
    <div class="stock-request-line-fields">
      <label><span>Official PALLET item quantity${transfer.palletQuantityRequiresManual ? " · required manual final value" : ""}</span><input data-scm-stock-pallet type="number" min="0" step="any" value="${scmStockEscape(transfer.palletQuantity)}" ${canEdit ? "" : "disabled"} /></label>
    </div>
    <div class="stock-request-actions">
      <button data-scm-stock-action="save-transfer" type="button" ${canEdit ? "" : "disabled"}>Save TO changes</button>
      <button class="primary" data-scm-stock-action="confirm-print" type="button" ${canConfirm ? "" : "disabled"}>Confirm TO + Print</button>
      ${hasPrinted || transfer.netsuiteTransferOrderId ? `<button data-scm-stock-action="reprint" type="button" ${transfer.netsuiteTransferOrderId ? "" : "disabled"}>Re-print</button>` : ""}
      ${scmStockQueueIncludes("pending_to") ? `<button class="danger" data-scm-stock-action="reject-pending-to" title="${canRejectPending ? "Reject this local Pending TO" : "Only available before Confirm TO + Print"}" type="button" ${canRejectPending ? "" : "disabled"}>Reject Pending TO</button>` : ""}
    </div>`;
}

function scmStockFocusSnapshot() {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement) || !scmStockRequestApp.contains(active)) return null;
  const selector=active.matches('[data-scm-stock-search]')?'[data-scm-stock-search]':
    ['regularResolvePo','regularResolveEta'].includes(active.id)?'#'+active.id:null;
  if(!selector)return null;
  return { selector,selectionStart: active.selectionStart, selectionEnd: active.selectionEnd };
}

function scmStockRestoreFocus(snapshot) {
  if (!snapshot) return;
  const input = /** @type {HTMLInputElement|null} */ (scmStockRequestApp.querySelector(snapshot.selector));
  input?.focus();
  if (typeof input?.setSelectionRange === "function" && input.type!=='date') {
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

function renderScmStockRequests({detailOnly=false} = {}) {
  if (window.MBBSStockRequestTabs && !window.MBBSStockRequestTabs.isActive("regular")) return;
  const restoreScroll = window.StockRequestView?.preserveScroll(scmStockRequestApp);
  const restoreTabFocus = window.MBBSStockRequestTabs?.preserveFocus();
  const focusSnapshot = scmStockFocusSnapshot();
  if (!detailOnly || !window.StockRequestView?.renderDetail(scmStockRequestApp, scmStockShowsTransfers() ? scmStockPendingToDetail() : scmStockRequestDetail(), scmStockState.selectedId)) {
  scmStockRequestApp.innerHTML = `${scmStockHeader()}
    <section class="stock-request-page">
      ${window.MBBSStockRequestTabs?.html() || `<div class="stock-request-tabs" role="tablist" aria-label="Stock request type">
        <button aria-selected="true" type="button">Regular</button>
        <button data-scm-stock-action="special" type="button">Special</button>
      </div>`}
      <div class="stock-request-toolbar">
        <div class="stock-request-actions"><input class="stock-request-search" data-scm-stock-search type="search" value="${scmStockEscape(scmStockState.search)}" placeholder="Search request or item" /><button data-scm-stock-action="refresh" type="button">Refresh</button></div>
        <div class="stock-request-filters">${scmStockQueueFilterHtml(scmStockState.queue)}${scmBackorderUI?.filter(scmStockState.requestTypeFilter || "",scmStockState.backorderStageFilter || "",'data-scm-stock-filter') || ""}
          <label><span>Item vendor</span><select name="vendor" data-scm-stock-filter="vendorFilter"><option value="">All vendors</option>${scmStockFilterOptions("vendors", scmStockState.vendorFilter)}</select></label>
          <label><span>Request date</span><input name="requestDate" data-scm-stock-filter="requestDateFilter" type="date" value="${scmStockEscape(scmStockState.requestDateFilter)}" /></label>
          ${scmStockYardFilterHtml(scmStockState.filterOptions.sourceYards || [], scmStockState.sourceLocationFilter, {label: "From yard", name: "sourceLocationId", attribute: 'data-scm-stock-filter="sourceLocationFilter"'})}
          ${scmStockYardFilterHtml(scmStockState.filterOptions.destinationYards || [], scmStockState.destinationLocationFilter, {label: "To yard", name: "destinationLocationId", attribute: 'data-scm-stock-filter="destinationLocationFilter"'})}
          <div class="stock-request-filter-actions"><button data-scm-stock-action="clear-filters" type="button">Clear filters</button>
          <button class="primary" data-scm-stock-action="apply-filters" type="button">Apply</button></div>
        </div>
      </div>
      <div class="stock-request-feedback">
        ${scmStockState.notice ? `<div class="stock-request-notice">${scmStockEscape(scmStockState.notice)}</div>` : ""}
        ${scmStockState.error ? `<div class="stock-request-notice stock-request-error">${scmStockEscape(scmStockState.error)}</div>` : ""}
      </div>
      <div class="stock-request-workspace">
        <aside class="stock-request-panel stock-request-list">${scmStockList()}</aside>
        <section class="stock-request-panel stock-request-detail">${scmStockShowsTransfers() ? scmStockPendingToDetail() : scmStockRequestDetail()}</section>
      </div>
    </section>`;
  }
  window.StockRequestConversation?.watchQueue(scmStockRequestApp, {url:scmStockState.conversationQueueUrl, requests:scmStockState.requests,
    active:()=>(!window.MBBSStockRequestTabs || window.MBBSStockRequestTabs.isActive('regular')), read:scmStockApi, error:()=>scmStockUpdates?.changed(),
    accept:requests=>{scmStockState.requests=requests; const list=scmStockRequestApp.querySelector('.stock-request-list'); if(list)list.innerHTML=scmStockList();}});
  window.StockRequestConversation?.render(scmStockRequestApp, scmStockState.detail, 'scm', {onWorkflowUpdated:async()=>{await scmStockLoadDetail(scmStockState.detail.id);renderScmStockRequests({detailOnly:true});}});
  scmStockRestoreFocus(focusSnapshot);
  restoreTabFocus?.();
  restoreScroll?.();
  if (detailOnly) window.StockRequestView?.setError(scmStockRequestApp, scmStockState.error);
  scmStockUpdates?.paint();
}

async function scmStockLoadDetail(id, {selection=false} = {}) {
  if (!id) {
    scmStockState.detail = null;
    return;
  }
  const generation = ++scmStockState.loadGeneration;
  const edits = scmStockUpdates?.editVersion, version = scmStockUpdates?.version;
  let detail;
  try {detail = await scmStockApi(`/api/scm/stock-requests/${encodeURIComponent(id)}`);}
  catch (error) {if (generation !== scmStockState.loadGeneration) return;throw error;}
  if (generation !== scmStockState.loadGeneration) return;
  if (selection && (scmStockState.busy || scmStockState.pendingDecision || scmStockState.resolveDraft || scmStockState.replyDraft || edits !== scmStockUpdates?.editVersion || version !== scmStockUpdates?.version)) {
    scmStockUpdates?.changed();
    return;
  }
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
  scmStockState.requests = scmStockState.requests.map(row => Number(row.id) === Number(id) ? detail : row);
  if (selection) renderScmStockRequests({detailOnly:true});
}

async function scmStockLoad({ preserveSelection = true } = {}) {
  if (window.MBBSStockRequestTabs && !window.MBBSStockRequestTabs.isActive("regular")) return;
  const generation = ++scmStockState.loadGeneration;
  const version = scmStockUpdates?.version;
  scmStockState.loading = true;
  renderScmStockRequests();
  const params = new URLSearchParams({ queue: scmStockState.queue, limit: "100" });
  if(scmStockState.requestTypeFilter)params.set("type",scmStockState.requestTypeFilter);
  if(scmStockState.backorderStageFilter)params.set("stage",scmStockState.backorderStageFilter);
  if (scmStockState.search.trim()) params.set("search", scmStockState.search.trim());
  if (scmStockState.search.trim()) params.set("allStatuses", "1");
  if (scmStockState.vendorFilter) params.set("vendor", scmStockState.vendorFilter);
  if (scmStockState.requestDateFilter) params.set("requestDate", scmStockState.requestDateFilter);
  if (scmStockState.sourceLocationFilter) params.set("sourceLocationIds", scmStockState.sourceLocationFilter);
  if (scmStockState.destinationLocationFilter) params.set("destinationLocationIds", scmStockState.destinationLocationFilter);
  const payload = await scmStockApi(`/api/scm/stock-requests?${params}`);
  if (generation !== scmStockState.loadGeneration) return;
  scmStockState.conversationQueueUrl = `/api/scm/stock-requests?${params}`;
  const requests = payload.requests || [];
  let selectedId = scmStockState.selectedId;
  if (!preserveSelection || !requests.some((request) => Number(request.id) === Number(selectedId))) {
    selectedId = requests[0]?.id || null;
  }
  const selected = requests.find((request) => Number(request.id) === Number(selectedId)) || null;
  // Backorder and Waitlist queues contain the complete authorized detail.
  // Stocking detail additionally reads current availability and purchasing evidence.
  const detail = selected && !["backorder", "waitlist"].includes(selected.regular?.deliveryMethod)
    ? await scmStockApi(`/api/scm/stock-requests/${encodeURIComponent(selectedId)}`)
    : selected;
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
  scmStockUpdates?.acknowledge(version);
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
  if(scmStockState.detail.workflowVersion===2)await scmStockLoadDetail(scmStockState.detail.id);
  renderScmStockRequests();
}

/** @param {number|string} [lineId] */
function scmStockOpenDecision(decision,lineId) {
  const allowedStatuses = decision === "reject"
    ? new Set(window.RegularStockUI.stocking(scmStockState.detail)&&!window.RegularPurchaseUI.purchase(scmStockState.detail)?["submitted", "changes_requested", "approved"]:["submitted", "changes_requested"])
    : new Set(["submitted"]);
  const eligible = (scmStockState.detail?.lines || []).filter((line) => allowedStatuses.has(line.status));
  const selected = eligible.filter((line) => scmStockState.selectedLineIds.has(line.id));
  const targets = lineId===undefined?(window.RegularStockUI.stocking(scmStockState.detail)?[]:selected.length?selected:eligible):eligible.filter(/** @param {{id:number}} line */ line=>line.id===Number(lineId));
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

async function scmStockDecision(decision, { lineIds, reason } = {}, operation) {
  const label = decision === "reject" ? "Reject" : "Request Changes";
  const normalizedReason = String(reason || "").trim();
  if (["reject","request_changes"].includes(decision) && !normalizedReason) throw new Error(`${label} requires a reason.`);
  const selectedLineIds = [...new Set((lineIds || []).map(Number))];
  if (!selectedLineIds.length) throw new Error("Select at least one stock-request line.");
  scmStockState.detail = window.RegularStockDelivery.simple(scmStockState.detail)
    ? await window.RegularStockDelivery.run(scmStockApi,'decision',{expectedRevision:scmStockState.detail.revision,lineIds:selectedLineIds,decision,reason:normalizedReason},
      {audience:'scm',requestId:scmStockState.detail.id,dialog:operation})
    : await scmStockApi(`/api/scm/stock-requests/${scmStockState.detail.id}/line-decisions`, {
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
  scmStockState.notice = ["stock","po"].includes(decision) ? window.RegularStockDelivery.simple(scmStockState.detail)?window.RegularStockUI.t('Delivery approved. Check TO and printing progress below.','送货申请已批准，请查看下方调货单及打印进度。'):window.RegularStockUI.decision(decision) : decision === "reject"
    ? "Selected request line(s) were rejected."
    : "Changes were requested. Convert and Reject remain available until Sales submits a newer revision.";
  if (decision === "reject") {
    scmStockState.selectedLineIds.clear();
    if(!window.RegularStockUI.stocking(scmStockState.detail)||scmStockState.detail.status==='completed')scmStockState.queue="rejected";
    localStorage.setItem("mbbs.scm.stockRequests.queue", scmStockState.queue);
  } else {
    scmStockState.selectedLineIds = new Set(selectedLineIds);
  }
  if(["stock","po"].includes(decision)&&!scmStockState.detail.lines.some(line=>line.status==='submitted'))scmStockState.queue=window.RegularStockDelivery.simple(scmStockState.detail)?'pending_to':'approved';
  await scmStockLoad({ preserveSelection: decision !== "reject" });
}

function scmStockTransferPayload() {
  const transfer = scmStockSelectedTransfer();
  const lines = [...scmStockRequestApp.querySelectorAll("[data-scm-stock-transfer-line-id]")].map((container) => {
    const line = transfer.lines.find((candidate) => Number(candidate.id) === Number(container.dataset.scmStockTransferLineId));
    return {
      requestLineId: line.id,
      sourceLocationId: Number(container.querySelector("[data-scm-stock-transfer-source]")?.value || transfer.sourceLocationId),
      remove: container.querySelector("[data-scm-stock-remove-transfer-line]")?.checked === true,
      ...scmStockQuantityPayload(container, line)
    };
  });
  return {
    expectedRevision: transfer.revision,
    requestId: crypto.randomUUID(),
    palletQuantity: Number(scmStockRequestApp.querySelector("[data-scm-stock-pallet]").value),
    lines
  };
}

scmStockRequestApp.addEventListener("input", (event) => {
  if(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement){if(event.target.dataset.regularReplyField&&scmStockState.replyDraft){scmStockState.replyDraft[/** @type {'message'|'eta'|'salesOrderRef'} */ (event.target.dataset.regularReplyField)]=event.target.value;return;}}
  const target=/** @type {HTMLInputElement} */ (event.target);
  const draft=scmStockState.resolveDraft;
  const request=/** @type {import('../tools/regular-stock-resolution-globals.js').RegularResolutionRequest|null} */ (scmStockState.detail);
  if(target.matches('[data-regular-resolution-field]')&&draft&&draft.requestId===request?.id){
    const field=target.dataset.regularResolutionField;
    if(field==='purchaseOrderRef'||field==='eta')draft[field]=target.value;
    return;
  }
  if(event.target.dataset.purchaseReleaseReason){
    (scmStockState.purchaseReleaseReasons ||= {})[Number(event.target.dataset.purchaseReleaseReason)]=event.target.value;
    return;
  }
  if(event.target.dataset.purchaseReviewLine){
    const id=Number(event.target.dataset.purchaseReviewLine),line=scmStockState.detail.lines.find(row=>row.id===id);
    (scmStockState.purchaseReviewQuantities ||= {})[id]=event.target.value;
    const preview=scmStockRequestApp.querySelector(`[data-purchase-rounded-line="${id}"]`);
    if(preview)preview.textContent=`${window.RegularStockUI.number(window.RegularPurchaseUI.rounded(event.target.value,line))} ${line.salesUom}`;
    return;
  }

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
  if (event.target.matches("[data-scm-stock-remove-transfer-line]")) {
    const container = event.target.closest("[data-scm-stock-transfer-line-id]");
    const removed = event.target.checked;
    container?.querySelectorAll("[data-scm-stock-transfer-source], [data-scm-stock-quantity]").forEach((field) => {
      field.disabled = removed;
    });
    container?.classList.toggle("stock-request-line-removed", removed);
    return;
  }
  if (event.target.matches("[data-scm-stock-filter]")) {
    const filterName = /** @type {"requestTypeFilter"|"backorderStageFilter"|"vendorFilter"|"requestDateFilter"|"sourceLocationFilter"|"destinationLocationFilter"|"queue"|"search"} */ (event.target.dataset.scmStockFilter);
    if(filterName==='requestTypeFilter'||filterName==='backorderStageFilter'){scmStockState.queue=['closed','completed'].includes(event.target.value)?'closed':'request';if(filterName==='requestTypeFilter')scmStockState.backorderStageFilter='';}
    const yardName = event.target.type === 'checkbox' ? event.target.name : null;
    scmStockState[filterName] = yardName
      ? [...scmStockRequestApp.querySelectorAll(`[name="${yardName}"]:checked`)].map(input => input.value).join(',')
      : event.target.value;
    if(filterName==='queue'){
      localStorage.setItem('mbbs.scm.stockRequests.queue',scmStockState.queue);
      scmStockState.replyDraft=null;scmStockState.resolveDraft=null;scmStockState.pendingDecision=null;
      scmStockState.selectedLineIds.clear();scmStockState.selectedTransferId=null;
    }
    scmStockLoad({ preserveSelection: false }).then(() => {
      const filter = yardName && scmStockRequestApp.querySelector(`[data-yard-filter="${yardName}"]`);
      if (filter) filter.open = true;
    }).catch((error) => {
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

scmStockRequestApp.addEventListener('submit',async(event)=>{
  const form=event.target;
  if(form instanceof HTMLFormElement&&form.matches('[data-regular-reply-form]')){event.preventDefault();await scmStockSendReply(form);return;}
  if(!(form instanceof HTMLFormElement)||!form.matches('[data-regular-resolution-form]'))return;
  event.preventDefault();
  if(scmStockState.busy||!form.reportValidity())return;
  const request=/** @type {import('../tools/regular-stock-resolution-globals.js').RegularResolutionRequest|null} */ (scmStockState.detail),draft=scmStockState.resolveDraft;
  if(!request||!draft||draft.requestId!==request.id)return;
  scmStockState.busy=true;scmStockState.error='';renderScmStockRequests();
  try{
    scmStockState.detail=await scmStockApi(`/api/scm/stock-requests/${request.id}/resolve`,{method:'POST',body:JSON.stringify({lineId:draft.lineId,expectedRevision:draft.expectedRevision,purchaseOrderRef:draft.purchaseOrderRef,eta:draft.eta})});
    scmStockState.resolveDraft=null;scmStockState.pendingDecision=null;scmStockState.selectedLineIds.clear();
    if(scmStockState.detail.status==='completed')scmStockState.queue='closed';
    localStorage.setItem('mbbs.scm.stockRequests.queue',scmStockState.queue);
    scmStockState.notice=window.RegularStockUI.t('Material resolved. Sales will see its PO and ETA.','商品已解决。销售将看到其采购订单和预计到达日期。');
    await scmStockLoad({preserveSelection:true});
  }catch(error){scmStockState.error=error instanceof Error?error.message:String(error);}
  finally{scmStockState.busy=false;renderScmStockRequests();}
});

async function scmStockSendReply(form) {
  const request=/** @type {import('../tools/regular-stock-resolution-globals.js').RegularResolutionRequest|null} */ (scmStockState.detail),draft=scmStockState.replyDraft;
  if(scmStockState.busy||!form.reportValidity()||!request||!draft||draft.requestId!==request.id)return;
  scmStockState.busy=true;scmStockState.error='';renderScmStockRequests({detailOnly:true});
  try{
    scmStockState.detail=await scmStockApi(`/api/scm/stock-requests/${request.id}/reply`,{method:'POST',body:JSON.stringify(draft)});
    scmStockState.replyDraft=null;scmStockState.requests=scmStockState.requests.map(row=>row.id===request.id?scmStockState.detail||row:row);
    scmStockState.notice=window.RegularStockUI.t('Reply sent. Sales will be alerted.','回复已发送，将通知销售。');
  }catch(error){scmStockState.error=error instanceof Error?error.message:String(error);}
  finally{scmStockState.busy=false;renderScmStockRequests();}
}

scmStockRequestApp.addEventListener("click", async (event) => {
  const button = event.target.closest('[data-scm-stock-action], [data-yard-filter-clear], [data-yard-filter-apply="queue"], [data-yard-filter-apply="sourceLocationId"], [data-yard-filter-apply="destinationLocationId"]');
  if (!button || scmStockState.busy || window.RegularStockDialog.isBusy()) return;
  const action = button.dataset.scmStockAction;
  let operation;
  try {
    if (action === 'apply-filters' || button.hasAttribute('data-yard-filter-apply')) {
      if (button.disabled) return;
      window.clearTimeout(scmStockState.refreshTimer);
      scmStockRequestApp.querySelectorAll('.stock-request-yard-filter[open]').forEach(filter => filter.removeAttribute('open'));
      return await scmStockLoad({preserveSelection: false});
    }
    if(['purchase-add','purchase-release','refresh-evidence','confirm-decision','save-line','convert','save-transfer','confirm-print','reprint','delivery-retry'].includes(action)){
      operation=window.RegularStockDialog.begin(window.RegularStockUI.t('Checking stock and processing your action…','正在检查库存并处理您的操作…'),{lockFields:window.RegularStockDelivery.simple(scmStockState.detail)});
    }
    if (button.dataset.yardFilterClear==='queue') {
      scmStockState.queue='';localStorage.setItem('mbbs.scm.stockRequests.queue','');
      scmStockState.replyDraft=null;scmStockState.resolveDraft=null;scmStockState.pendingDecision=null;
      scmStockState.selectedLineIds.clear();scmStockState.selectedTransferId=null;
      return scmStockLoad({preserveSelection:false});
    }
    if (button.dataset.yardFilterClear) {
      scmStockState[button.dataset.yardFilterClear === 'sourceLocationId' ? 'sourceLocationFilter' : 'destinationLocationFilter'] = '';
      return scmStockLoad({preserveSelection: false});
    }
    if (action === "special") return window.MBBSSCMSpecialStock?.open({ operator: scmStockState.operator });
    if (action === "refresh") return scmStockLoad({ preserveSelection: true });
    if (action === "clear-filters") {
      scmStockState.queue="";localStorage.setItem("mbbs.scm.stockRequests.queue","");
      scmStockState.replyDraft=null;scmStockState.resolveDraft=null;scmStockState.pendingDecision=null;
      scmStockState.selectedLineIds.clear();scmStockState.selectedTransferId=null;
      scmStockState.requestTypeFilter="";scmStockState.backorderStageFilter="";
      scmStockState.vendorFilter = "";
      scmStockState.requestDateFilter = "";
      scmStockState.sourceLocationFilter = "";
      scmStockState.destinationLocationFilter = "";
      return scmStockLoad({ preserveSelection: false });
    }
    if (action === "select") {
      if (Number(button.dataset.id) === scmStockState.selectedId) return;
      scmStockState.replyDraft=null;
      scmStockState.resolveDraft=null;
      scmStockState.pendingDecision = null;
      scmStockState.selectedId = Number(button.dataset.id);
      localStorage.setItem("mbbs.scm.stockRequests.selected", String(scmStockState.selectedId));
      scmStockState.selectedLineIds.clear();
      scmStockState.purchaseReviewQuantities = {}; scmStockState.purchaseReleaseReasons = {};
      scmStockState.detail = structuredClone(scmStockState.requests.find(row => Number(row.id) === scmStockState.selectedId) || null);
      scmStockState.error = '';
      renderScmStockRequests({detailOnly:true});
      return await scmStockLoadDetail(scmStockState.selectedId, {selection:true});
    }
    if (action === "select-transfer") {
      scmStockState.selectedTransferId = Number(button.dataset.transferId);
      return renderScmStockRequests();
    }
    if(action==='resolve'){
      scmStockState.replyDraft=null;
      const request=/** @type {import('../tools/regular-stock-resolution-globals.js').RegularResolutionRequest|null} */ (scmStockState.detail);
      if(!request)return;
      const line=request.lines?.find(line=>line.id===Number(button.dataset.lineId));
      if(!line||!window.RegularStockResolution.eligible(request,line))return;
      scmStockState.pendingDecision=null;
      scmStockState.resolveDraft={requestId:request.id,lineId:line.id,expectedRevision:request.revision,purchaseOrderRef:'',eta:''};
      renderScmStockRequests();
      const input=/** @type {HTMLInputElement|null} */ (scmStockRequestApp.querySelector('#regularResolvePo'));
      input?.focus();return;
    }
    if(action==='cancel-resolve'){scmStockState.resolveDraft=null;scmStockState.error='';renderScmStockRequests();return;}
    if(action==='reply'){
      const request=/** @type {import('../tools/regular-stock-resolution-globals.js').RegularResolutionRequest|null} */ (scmStockState.detail),line=request?.lines?.find(line=>line.id===Number(button.dataset.lineId));
      if(!request||!line||!window.RegularStockReply?.eligible(request,'scm',undefined,line))return;
      scmStockState.resolveDraft=null;scmStockState.pendingDecision=null;
      scmStockState.replyDraft={requestId:request.id,lineId:line.id,expectedRevision:request.revision,message:'',eta:''};
      renderScmStockRequests({detailOnly:true});scmStockRequestApp.querySelector('[data-regular-reply-field="message"]')?.focus();return;
    }
    if(action==='cancel-reply'){scmStockState.replyDraft=null;scmStockState.error='';renderScmStockRequests({detailOnly:true});return;}
    if(action==='waitlist-line'){
      const request=scmStockState.detail,line=request?.lines.find(row=>row.id===Number(button.dataset.lineId));
      return window.RegularStockWaitlistTransition.open(request,line,{api:scmStockApi,onComplete:async result=>{
        scmStockState.detail=result.request;scmStockState.selectedLineIds.delete(line.id);
        scmStockState.notice=`${line.itemName} ${window.RegularStockUI.t('moved to waitlist','已转入候补清单')} ${result.waitlistRequest.requestRef}.`;
        if(result.request.status==='completed'){scmStockState.queue='closed';localStorage.setItem('mbbs.scm.stockRequests.queue','closed');}
        try{await scmStockLoad({preserveSelection:true});}
        catch(error){scmStockState.loading=false;scmStockState.error=error.message;renderScmStockRequests();}
      }});
    }
    if (action === "select-all") {
      scmStockState.selectedLineIds = new Set(scmStockState.detail.lines.filter(scmStockActionable).map((line) => line.id));
      return renderScmStockRequests();
    }
    if (action === "save-line") return await scmStockSaveLine(button);
    if(action==='refresh-evidence'){
      button.disabled=true;
      scmStockState.detail=await scmStockApi(`/api/scm/stock-requests/${scmStockState.detail.id}/evidence`,{method:'POST',body:'{}'});
      return renderScmStockRequests();
    }
    if(action==='purchase-add'||action==='purchase-release'){
      const request=scmStockState.detail;
      const body=action==='purchase-add'?{expectedRevision:request.revision,lines:request.lines.filter(line=>line.status==='submitted'&&line.id===Number(button.dataset.lineId)).map(line=>({lineId:line.id,reviewedSalesQty:Number(scmStockState.purchaseReviewQuantities?.[line.id]??line.salesQty)}))}
        :{expectedRevision:request.revision,lineIds:[Number(button.dataset.lineId)],reason:scmStockState.purchaseReleaseReasons?.[button.dataset.lineId]||''};
      scmStockState.busy=true;
      scmStockState.detail=await scmStockApi(`/api/scm/stock-requests/${request.id}/${action==='purchase-add'?'purchase-proposals':'purchase-release'}`,{method:'POST',body:JSON.stringify(body)});
      scmStockState.selectedLineIds.clear();
      if(!scmStockState.detail.lines.some(line=>line.status==='submitted')){
        scmStockState.queue=scmStockState.detail.bucket==='completed'?'closed':'approved';
        localStorage.setItem('mbbs.scm.stockRequests.queue',scmStockState.queue);
      }
      scmStockState.notice=window.RegularStockUI.t(action==='purchase-add'?'Purchase quantities added to PO/TO proposals.':'Remaining Purchase demand released.',action==='purchase-add'?'采购数量已加入采购 / 调货建议。':'剩余采购需求已释放。');
      await scmStockLoad({preserveSelection:true});return;
    }
    if(action==='approve-stock')return scmStockOpenDecision('stock');
    if(action==='backorder-convert')return scmStockingBackorderUI?.open(scmStockState.detail);
    if(action==='pickup-convert')return window.RegularPickupUI.open(scmStockState.detail,{api:scmStockApi,onComplete:async()=>{
      scmStockState.queue='pending_to';localStorage.setItem('mbbs.scm.stockRequests.queue','pending_to');
      scmStockState.notice=window.RegularStockUI.t('SCM approved the Stocking request and created its Transfer Orders.','SCM 已批准备货申请并建立调货单。');
      await scmStockLoad({preserveSelection:true});
    }});
    if(action==='approve-po')return scmStockOpenDecision('po');
    if (action === "request-changes") return scmStockOpenDecision("request_changes");
    if (action === "reject") return scmStockOpenDecision("reject",button.dataset.lineId);
    if (action === "cancel-decision") {
      scmStockState.pendingDecision = null;
      return renderScmStockRequests();
    }
    if(action==='delivery-retry'){
      scmStockState.busy=true;
      scmStockState.detail=await window.RegularStockDelivery.run(scmStockApi,'retry',{},{audience:'scm',requestId:scmStockState.detail.id,dialog:operation});
      if(scmStockState.detail.transfers.length)scmStockState.queue='pending_to';
      await scmStockLoad({preserveSelection:true});return;
    }
    if (action === "confirm-decision") {
      const pending = scmStockState.pendingDecision;
      if (!pending) throw new Error("The SCM decision is no longer available. Open it again.");
      pending.reason = scmStockRequestApp.querySelector("[data-scm-stock-decision-reason]")?.value || "";
      scmStockState.busy = true;
      await scmStockDecision(pending.decision, pending, operation);
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
      const payload = scmStockTransferPayload();
      const hasStructureChanges = payload.lines.some((line) => line.remove
        || Number(line.sourceLocationId) !== Number(transfer.sourceLocationId));
      const result = await scmStockApi(`/api/scm/stock-transfers/${transfer.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
      scmStockState.detail = await scmStockApi(`/api/scm/stock-requests/${result.transfer.requestId}`);
      const activeTransfers = (/** @type {{transfers:{id:number,status:string}[]}} */ (/** @type {unknown} */ (scmStockState.detail))).transfers.filter((candidate) =>
        !["received", "cancelled", "closed"].includes(candidate.status)
      );
      scmStockState.notice = hasStructureChanges
        ? "TO changes saved. Changed outbound locations were separated into the correct local Pending TOs; removed lines returned to Request. Review each TO's PALLET quantity before confirmation."
        : "TO quantities saved. Any quantity above current availability is retained as backorder.";
      if (!activeTransfers.length) {
        scmStockState.queue = "request";
        scmStockState.selectedTransferId = null;
        localStorage.setItem("mbbs.scm.stockRequests.queue", "request");
        return scmStockLoad({ preserveSelection: true });
      }
      if (!activeTransfers.some((candidate) => Number(candidate.id) === Number(scmStockState.selectedTransferId))) {
        scmStockState.selectedTransferId = activeTransfers[0].id;
      }
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
          expectedRequestRevision: (/** @type {{revision:number}} */ (/** @type {unknown} */ (scmStockState.detail))).revision,
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
    if (action === 'select') {
      window.StockRequestView?.setError(scmStockRequestApp, error.message);
      scmStockUpdates?.paint();
    } else renderScmStockRequests();
  } finally {
    scmStockState.busy = false;
    if(operation){renderScmStockRequests();operation.close();}
  }
});

function scmStockConnectEvents() {
  if (!("EventSource" in window) || scmStockState.eventSource) return;
  scmStockState.eventSource = new EventSource("/api/events?client=scm-stock-requests");
  scmStockState.eventSource.addEventListener("app-event", (message) => {
    let event;
    try { event = JSON.parse(message.data || "{}"); } catch { return; }
    if (!window.StockRequestView?.regularEventRelevant(event, scmStockState.requests)) return;
    if(window.MBBSStockRequestTabs?.isActive('waitlist')){window.SCMWaitlist.refresh();return;}
    scmStockUpdates?.changed();
  });
}

window.addEventListener("mbbs-language-changed", renderScmStockRequests);
window.addEventListener("mbbs-stock-request-tab-changed", () => {
  scmStockState.loadGeneration += 1;
  window.clearTimeout(scmStockState.refreshTimer);
});
window.addEventListener("pagehide", () => {
  scmStockState.eventSource?.close();
  scmStockState.eventSource = null;
});

let scmPrintRefreshing=false;
window.setInterval(async()=>{
  if((window.MBBSStockRequestTabs&&!window.MBBSStockRequestTabs.isActive('regular'))||scmStockUpdates?.pending||scmPrintRefreshing||scmStockState.busy||scmStockState.pendingDecision||window.RegularStockDialog.isBusy()||!window.RegularStockDelivery.printing(scmStockState.detail))return;
  scmPrintRefreshing=true;
  try{const detail=await scmStockApi(`/api/scm/stock-requests/${scmStockState.selectedId}`);if(JSON.stringify(detail)!==JSON.stringify(scmStockState.detail))scmStockUpdates?.changed();}catch{/* Refresh remains available when the connection returns. */}
  finally{scmPrintRefreshing=false;}
},3000);

requireDispatchLogin({
  mount: scmStockRequestApp,
  roles: ["admin", "scm", "scm_staff"],
  async onReady(operator) {
    scmStockState.operator = operator;
    await scmBackorderReady();
    window.RegularStockDelivery.configure(operator.id);
    try {
      ({yardFilterHtml: scmStockYardFilterHtml} = await scmStockYardFilterReady);
      ({scmQueueFilterHtml: scmStockQueueFilterHtml} = await scmStockQueueFilterReady);
      const linkedId=Number(new URLSearchParams(location.search).get('requestId'));
      if(linkedId>0 && new URLSearchParams(location.search).get('tab')==='regular'){scmStockState.queue='request';scmStockState.selectedId=linkedId;scmStockState.requestTypeFilter='';scmStockState.backorderStageFilter='';scmStockState.search=new URLSearchParams(location.search).get('requestRef') || '';}
      if (window.MBBSStockRequestTabs) {
        window.MBBSStockRequestTabs.onOpen = async (type) => {
          if (type === 'waitlist') return window.SCMWaitlist.open({mount:scmStockRequestApp,operator,api:scmStockApi});
          if (type === "aggregate") return window.MBBSAggregateRequests.open({ mount: scmStockRequestApp, operator, scm: true });
          if (type === "special") return window.MBBSSCMSpecialStock.open({ operator });
          return scmStockLoad({ preserveSelection: true }).catch((error) => {
            scmStockState.loading = false;
            scmStockState.error = error.message;
            renderScmStockRequests();
          });
        };
        await window.MBBSStockRequestTabs.open(window.MBBSStockRequestTabs.active);
      } else {
        await scmStockLoad({ preserveSelection: true });
      }
      if(!window.MBBSStockRequestTabs||window.MBBSStockRequestTabs.active==='regular'){
        const resumed=await window.RegularStockDelivery.resume(scmStockApi,'scm');
        if(resumed){scmStockState.selectedId=resumed.id;await scmStockLoad({preserveSelection:true});}
      }
      scmStockConnectEvents();
    } catch (error) {
      scmStockState.loading = false;
      scmStockState.error = error.message;
      renderScmStockRequests();
    }
  }
});

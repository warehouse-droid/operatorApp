export const SPECIAL_STAGES = Object.freeze({
  new_enquiry: 'New enquiry',
  pending_update: 'Pending Update',
  await_customer_confirmation: 'Await Customer Confirmation',
  confirmed: 'Confirmed',
  dispatch_arrangement: 'Dispatch Arrangement',
  wait_for_production: 'Wait for production / Transfer',
  closed: 'Closed',
  completed: 'Completed'
});

/** @param {unknown} status */
export const specialStockAvailable = status => status === 'in_stock' || status === 'low_inventory';

/** @param {unknown} status */
const orderStatusLabel = status => String(status || '').replaceAll('_', ' ').replace(/^.*: */, '').trim().toLowerCase();
/** @param {string} label */
const incompleteOrderStatus = label => /partial|closed|cancelled|canceled/.test(label);

/** @param {Record<string,any>} detail */
export function specialSalesOrderFulfilled(detail) {
  const fulfillment = orderStatusLabel(detail.salesOrderFulfillmentStatus);
  const status = orderStatusLabel(detail.salesOrderStatus);
  const netsuiteFulfilled = detail.salesOrderActive !== false
    && ['fulfilled', 'fully fulfilled', 'billed', 'fully billed', 'pending billing'].includes(status);
  const locallyFulfilled = !incompleteOrderStatus(fulfillment) && Boolean(detail.salesOrderFulfilledAt || detail.salesOrderPickupCompletedAt
    || detail.operationalCompletionSource === 'yard_pickup' || ['fulfilled', 'fully fulfilled'].includes(fulfillment));
  return netsuiteFulfilled || locallyFulfilled;
}

/** @param {{purchaseOrderReference?:unknown,purchaseOrderDispatchStatus?:unknown}} evidence */
export function specialPurchaseOrderDispatchReady(evidence = {}) {
  return typeof evidence.purchaseOrderReference === 'string' && Boolean(evidence.purchaseOrderReference.trim())
    && ['queued', 'planned', 'in transit', 'partially done', 'completed', 'complete']
      .includes(String(evidence.purchaseOrderDispatchStatus || '').trim().toLowerCase());
}

/** @param {{closed?:boolean,cancelled?:boolean,operationallyComplete?:boolean,pendingUpdate?:boolean,waitingForProduction?:boolean,purchaseOrderId?:number|null,purchaseOrderApproved?:boolean,purchaseOrderReference?:unknown,purchaseOrderDispatchStatus?:unknown,salesOrderId?:number|null,salesOrderSkipped?:boolean,purchaseOrderSkipped?:boolean,fulfillmentMethod?:string,hasPendingSalesDecision?:boolean,linesResolved?:boolean,hasAcceptedLines?:boolean}} evidence */
export function specialStage(evidence = {}) {
  if (evidence.closed || evidence.cancelled) return 'closed';
  if (evidence.operationallyComplete) return 'completed';
  if (evidence.pendingUpdate) return 'pending_update';
  if (evidence.purchaseOrderId) {
    if (evidence.purchaseOrderApproved !== false && specialPurchaseOrderDispatchReady(evidence)
        && evidence.fulfillmentMethod !== 'vendor_pickup') return 'dispatch_arrangement';
    return 'confirmed';
  }
  // This flag represents resolved customer decisions with an accepted stock ETA.
  if (evidence.waitingForProduction) return 'confirmed';
  if (evidence.purchaseOrderSkipped && evidence.fulfillmentMethod !== 'vendor_pickup') return 'dispatch_arrangement';
  if (evidence.salesOrderId || evidence.salesOrderSkipped || (evidence.linesResolved && evidence.hasAcceptedLines)) return 'confirmed';
  if (evidence.hasPendingSalesDecision || evidence.linesResolved) return 'await_customer_confirmation';
  return 'new_enquiry';
}

export function torontoDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

/** @param {string|null|undefined} eta */
export function reminderDate(eta) {
  if (!eta) return null;
  const date = new Date(`${String(eta).slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid ETA.');
  let remaining = 3;
  while (remaining) {
    date.setUTCDate(date.getUTCDate() - 1);
    if (![0, 6].includes(date.getUTCDay())) remaining -= 1;
  }
  return date.toISOString().slice(0, 10);
}

/** @param {{previousDue?:string|null,eta?:string|null,ready:boolean,today?:string}} input */
export function nextReminderDate({ previousDue, eta, ready, today = torontoDate() }) {
  if (ready) return null;
  if (previousDue && previousDue <= today) return previousDue;
  return reminderDate(eta);
}

/** @param {string[]|string} selected @param {string} attribute */
export function stageFilterHtml(selected = [], attribute = 'data-special-stage') {
  const values = new Set(Array.isArray(selected) ? selected : String(selected).split(','));
  return `<details class="special-stage-filter"><summary>Stages${values.size && !values.has('') ? ` (${values.size})` : ': All'}</summary><div>${Object.entries(SPECIAL_STAGES).map(([value, label]) => `<label><input type="checkbox" ${attribute} value="${value}" ${values.has(value) ? 'checked' : ''}> ${label}</label>`).join('')}<div class="stock-request-filter-actions"><button type="button" data-special-clear-stages>Clear selection</button><button class="primary" type="button" data-special-apply-stages>Apply</button></div></div></details>`;
}

/** @param {string[]|string|undefined|null} value */
export function parseStages(value) {
  const stages = [...new Set((Array.isArray(value) ? value : String(value || '').split(',')).filter(Boolean))];
  if (stages.some(stage => !Object.hasOwn(SPECIAL_STAGES, stage))) {
    throw Object.assign(new Error('Select a supported request stage.'), { status: 400, code: 'SPECIAL_STAGE_INVALID' });
  }
  return stages;
}

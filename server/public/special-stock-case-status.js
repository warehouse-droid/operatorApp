import { specialPurchaseOrderDisplayRef } from './special-stock-po-reference.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function specialClosureNeedsScm(detail) {
  return detail.closeStatus === 'closure_pending' && Boolean(detail.closureReview?.id)
    && detail.closureReview.requiresScm !== false
    && ['pending','attention'].includes(detail.closureReview.status);
}

export function compareSpecialScmQueue(a,b) {
  return Number(specialClosureNeedsScm(b)) - Number(specialClosureNeedsScm(a))
    || Number(Boolean(b.quantityReviewPending)) - Number(Boolean(a.quantityReviewPending));
}

export function specialClosureCardAlert(detail) {
  if (!specialClosureNeedsScm(detail)) return '';
  return `<strong class="stock-request-error">${detail.closureReview.status === 'pending'
    ? 'Closure requested · SCM confirmation required' : 'Closure incomplete · SCM retry required'}</strong>`;
}

export function specialClosureQueueAlert(requests) {
  const count = requests.filter(specialClosureNeedsScm).length;
  return count ? `<div class="stock-request-notice stock-request-error" role="status">${count} closure ${count === 1
    ? 'request requires' : 'requests require'} SCM confirmation.</div>` : '';
}

function estimatedArrivalLabel(plan) {
  const value = plan.estimatedArrivalMinute;
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0) return '';
  const minutes = Math.round(Number(value));
  const days = Math.floor(minutes / 1440);
  const time = `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return `${plan.planDate ? `${plan.planDate} ` : ''}${time}${days ? ` (+${days} day${days === 1 ? '' : 's'})` : ''}`;
}

/** @param {Record<string,any>} detail */
function salesFulfillment(detail) {
  const label = String(detail.salesOrderFulfillmentStatus || detail.salesOrderStatus || '').replaceAll('_', ' ').replace(/^.*: */, '').trim();
  const partial = /partial/i.test(label);
  const fulfilled = !partial && Boolean(detail.salesOrderFulfilledAt || detail.salesOrderPickupCompletedAt
    || detail.operationalCompletionSource === 'yard_pickup' || /^(fully )?(fulfilled|billed)$|^pending billing$/i.test(label));
  return { fulfilled, label: fulfilled ? 'Fulfilled' : label || 'Pending fulfillment' };
}

/** @typedef {{planned?:boolean,plans?:Array<{planDate?:string,estimatedArrivalMinute?:number|null}>}} PlanningState */
/** @typedef {[string,number|null|undefined,PlanningState|undefined,string|undefined,string,boolean|undefined]} PlanningOrder */
/** @param {Record<string,any>} detail @param {string} label @param {PlanningState|undefined} state @param {boolean|undefined} skipped @param {boolean} compact @param {string} audience */
function orderProgress(detail, label, state, skipped, compact, audience) {
  if (skipped) return { success: false, text: 'Test step completed', arrival: '' };
  if (audience === 'sales' && label === 'SO' && detail.fulfillmentMethod === 'yard_pickup') {
    const fulfillment = salesFulfillment(detail);
    return { success: fulfillment.fulfilled, text: `SO fulfillment: ${fulfillment.label}`, arrival: '' };
  }
  if (audience === 'sales' && label === 'SO' && detail.fulfillmentMethod === 'vendor_pickup') {
    return { success: false, text: detail.salesOrderStatus || 'Pending sync', arrival: '' };
  }
  const dates = [...new Set((state?.plans || []).map(plan => plan.planDate).filter(Boolean))];
  const status = state?.planned ? `Planned${!compact && dates.length ? ` (${dates.join(', ')})` : ''}` : 'Not planned';
  const arrivals = [...new Set((state?.plans || []).map(estimatedArrivalLabel).filter(Boolean))];
  return { success: Boolean(state?.planned), text: `${audience === 'sales' ? `${label} planning: ` : ''}${status}`,
    arrival: !compact && state?.planned ? `Est. arrival: ${arrivals.join(', ') || 'Not available'}` : '' };
}

/** @param {Record<string,any>} detail @param {PlanningOrder} value @param {boolean} compact @param {{audience:string,showOrderPreviews:boolean}} options */
function planningOrderCard(detail, value, compact, { audience, showOrderPreviews }) {
  const [label, id, state, reference, kind, skipped] = value;
  const progress = orderProgress(detail, label, state, skipped, compact, audience);
  const tag = compact ? 'span' : 'div';
  const preview = showOrderPreviews && !compact && !skipped && id && (audience === 'scm' || kind === 'sales_order');
  const nativeStatus = label === 'SO' ? detail.salesOrderStatus : detail.purchaseOrderStatus;
  return `<${tag} class="special-planning-order${progress.success ? ' is-planned' : ''}"><span><strong>${label} ${escape(skipped ? 'creation skipped (test)' : reference || id)}</strong><small class="special-planning-order-status">${escape(progress.text)}</small>
    ${!compact && nativeStatus ? `<small>${escape(nativeStatus)}</small>` : ''}
    ${progress.arrival ? `<small class="special-planning-eta">${escape(progress.arrival)}</small>` : ''}</span>
    ${preview ? `<button type="button" data-special-document="${kind}" data-case-id="${escape(detail.id)}">Preview ${label}</button>` : ''}</${tag}>`;
}

/** @param {Record<string,any>} detail */
export function specialPlanningStatus(detail, compact = false, { showOrderPreviews = false, audience = 'scm' } = {}) {
  const notice = detail.purchaseOrderId && detail.purchaseOrderApproved === false && !['closed','completed'].includes(detail.stage)
    ? `<div class="stock-request-notice" role="status">${detail.purchaseOrderPendingApproval ? 'PO approval pending' : 'PO approval not confirmed'}${compact ? '' : ' — request remains Confirmed until NetSuite approval. Status updates automatically.'}</div>` : '';
  const planning = detail.dispatchPlanning;
  /** @type {PlanningOrder[]} */
  const values = [['SO', detail.salesOrderId, planning?.salesOrder, detail.salesOrderRef, 'sales_order', detail.salesOrderSkipped],
    ['PO', detail.purchaseOrderId, planning?.purchaseOrder, specialPurchaseOrderDisplayRef(detail), 'purchase_order', detail.purchaseOrderSkipped]];
  if (audience === 'sales' || showOrderPreviews && !compact) {
    const orders = values.filter(([, id, , , , skipped]) => id || skipped).map(value => planningOrderCard(detail, value, compact, { audience, showOrderPreviews }));
    if (!orders.length) return notice;
    const tag = compact ? 'span' : 'div';
    const salesClasses = audience === 'sales' ? ` special-sales-planning${compact ? ' is-compact' : ' special-sales-order-documents'}` : '';
    return `${notice}<${tag} class="special-planning-status special-planning-documents${salesClasses}${planning?.anyPlanned ? ' is-planned' : ''}">${compact ? '' : `<strong>${audience === 'sales' ? 'Orders' : 'Dispatch planning'}</strong>`}${orders.join('')}</${tag}>`;
  }
  const labels = values.filter(([,id])=>id).map(([label,,state,reference]) => {
    const dates = [...new Set((state?.plans || []).map(plan=>plan.planDate).filter(Boolean))];
    return `${label}: ${state?.planned ? `Planned${!compact && dates.length ? ` (${dates.join(', ')})` : ''}` : 'Not planned'}${label === 'PO' && reference ? ` · ${reference}` : ''}`;
  });
  if (!labels.length) return notice;
  return `${notice}<${compact ? 'small' : 'div'} class="special-planning-status${planning?.anyPlanned ? ' is-planned' : ''}">Dispatch · ${escape(labels.join(' · '))}</${compact ? 'small' : 'div'}>`;
}

export function specialClosureStatus(detail, audience) {
  if (detail.closeStatus !== 'closure_pending' || !detail.closureReview?.id) return '';
  const review = detail.closureReview;
  if (review.requiresScm === false) {
    const message = review.status === 'applying' ? 'Closing the linked Sales Order in NetSuite'
      : 'SO closure incomplete · Sales can retry closure';
    return `<section class="stock-request-notice"><p><strong>${message}</strong></p><p>${escape(detail.closureReason)}</p>${review.error ? `<p class="stock-request-error">${escape(review.error)}</p>` : ''}</section>`;
  }
  const message = review.status === 'pending' ? 'Closure requested · Waiting for SCM confirmation'
    : review.status === 'applying' ? 'Closing the linked SO and PO'
      : 'Closure incomplete · SCM retry required';
  const notice = `<p><strong>${message}</strong></p><p>${escape(detail.closureReason)}</p>${review.error ? `<p class="stock-request-error">${escape(review.error)}</p>` : ''}`;
  if (audience !== 'scm') return `<section class="stock-request-notice">${notice}</section>`;
  return `<section class="stock-request-section"><form class="stock-request-form" data-special-closure-review-form>${notice}
    <p>Confirmation closes ${escape(detail.salesOrderRef)} and ${escape(detail.purchaseOrderRef)} in NetSuite and cancels this request locally.</p>
    <label><span>Review note</span><input name="reason" /></label><div class="stock-request-actions">
      <button class="danger" type="submit" value="approve">${review.status === 'pending' ? 'Confirm closure of SO and PO' : 'Retry closure of SO and PO'}</button>
      ${!review.remoteStarted && review.status !== 'applying' ? '<button type="submit" value="reject">Reject closure</button>' : ''}
    </div></form></section>`;
}

export function canRequestSpecialClosure(detail) {
  const retry = detail.closeStatus === 'closure_pending' && detail.salesOrderId && !detail.purchaseOrderId
    && (!detail.closureReview?.id || ['pending','attention'].includes(detail.closureReview.status));
  return (detail.closeStatus === 'active' || Boolean(retry)) && !detail.dispatchPlanning?.anyPlanned && !detail.dispatchPlanned
    && !detail.operationallyComplete && !detail.quantityReviewPending && !detail.purchaseOrderSkipped;
}

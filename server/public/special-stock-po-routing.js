/* global HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement */
const methods = ['MBT','Vendor','Customer Pickup'];
const statuses = ['Queued','Urgent','Cancelled','Hold','Priority','Surplus Only','Book Appt'];
const destinations = ['3445','12441','2967','150'];
/** @type {Record<string,string>} */
const escaped = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
/** @param {unknown} value */
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => escaped[c] || c);
/** @param {string[]} values @param {string} current */
const options = (values,current) => values.map(value => `<option value="${escape(value)}" ${value === current ? 'selected' : ''}>${escape(value)}</option>`).join('');

/** @param {any} detail @param {{ref:string,order?:any,error?:string}|null} entry */
export function specialPoRoutingHtml(detail, entry) {
  if (!detail.purchaseOrderId || !detail.purchaseOrderRef || ['closed','completed'].includes(detail.stage)
      || detail.closeStatus === 'closure_pending' || detail.quantityReviewPending) return '';
  const order = entry && entry.ref === detail.purchaseOrderRef ? entry.order : null;
  if (!order) return `<section class="stock-request-section special-po-routing"><h3>PO split and routing</h3>
    <p role="status">${escape(entry?.error || 'Loading PO routing…')}</p>${entry?.error ? '<button type="button" data-special-scm-action="reload-po-routing">Retry PO routing</button>' : ''}</section>`;
  const scm = order.scm || {};
  const remarkOverride = String(scm.remarkOverride || '');
  const remark = remarkOverride || String(scm.netSuiteMemo || '');
  const locked = order.scmSplitLocked === true;
  const pickup = scm.pickupPoint || order.sourceYard || order.vendorYard || '';
  const yards = [...new Set((order.vendorYardOptions || []).map(/** @param {{yard?:unknown}} option */ option => String(option.yard || '').trim()).filter(Boolean))];
  if (pickup && yards.length && !yards.includes(pickup)) yards.unshift(pickup);
  const status = scm.status || 'Queued';
  return `<section class="stock-request-section special-po-routing"><h3>PO split and routing · ${escape(detail.purchaseOrderRef)}</h3>
    <form class="scm-mini-panel" data-special-po-routing-form>
    <fieldset ${locked ? 'disabled' : ''}><div class="scm-mini-grid">
    <div class="scm-mini-row scm-mini-routing-row">
      <label class="scm-mini-method-field"><span>Method</span><select name="method" data-scm-field="method">${options(methods,scm.method || 'MBT')}</select></label>
      <label class="scm-mini-status-field"><span>Status</span>${statuses.includes(status) ? `<select name="status" data-scm-field="status">${options(statuses,status)}</select>` : `<input value="${escape(status)}" readonly />`}</label>
      <label class="scm-pickup-yard-field"><span>Pickup Yard</span>${yards.length ? `<select name="pickupPoint" data-scm-field="pickupPoint">${options(yards,pickup || yards[0])}</select>` : `<input value="${escape(pickup || order.address || 'Use NetSuite address')}" readonly />`}</label>
      <label class="checkbox-line scm-mini-special-field"><input name="isSpecialOrder" data-scm-field="isSpecialOrder" type="checkbox" ${scm.isSpecialOrder ? 'checked' : ''} /><span>Sp.O</span></label>
      <label class="scm-mini-reference-field"><span>Packing Slip / Ref</span><input name="packingSlipRef" data-scm-field="packingSlipRef" maxlength="120" value="${escape(scm.packingSlipRef || detail.purchaseOrderReference || '')}" /></label>
    </div>
    <div class="scm-mini-row scm-mini-notes-row">
      <label><span>Destination Override</span><select name="dropoffPoint" data-scm-field="dropoffPoint"><option value="">${escape(order.destinationYard || detail.storeName || 'NetSuite line destinations')} (NetSuite)</option>${options(destinations,scm.dropoffPoint || '')}</select></label>
      <label class="scm-remark-field"><span>Remark</span><textarea name="remarkOverride" data-scm-field="remarkOverride" data-scm-remark-value="${escape(remark)}" data-scm-remark-override="${escape(remarkOverride)}" rows="2" maxlength="2000">${escape(remark)}</textarea><small>Clear to use the PO remark. Shared with PO / TO Schedule.</small></label>
      <label class="scm-note-field"><span>Note</span><textarea name="notes" data-scm-field="notes" rows="2" maxlength="4000">${escape(order.netSuiteNote ?? scm.notes ?? order.notes ?? '')}</textarea><small>Saved to the NetSuite PO.</small></label>
      <div class="scm-mini-actions"><button type="submit">Save Schedule</button></div>
    </div></div></fieldset></form>${locked ? '<p>This split is locked. Unplan or unlink it in PO Split before editing.</p>' : ''}</section>`;
}

/** @param {HTMLFormElement} form @param {any} order */
export function specialPoRoutingPatch(form, order) {
  if (!order || order.scmSplitLocked === true) throw new Error('Load an editable PO before saving its routing.');
  /** @type {Record<string, unknown>} */
  const patch = {orderKind:'PO',expectedUpdatedAt:order.scm?.updatedAt || null};
  for (const field of form.querySelectorAll('[data-scm-field]')) {
    if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) || field.disabled) continue;
    const name = field.dataset.scmField;
    if (name) patch[name] = name === 'remarkOverride' && field.value === field.dataset.scmRemarkValue
      ? field.dataset.scmRemarkOverride || ''
      : field instanceof HTMLInputElement && field.type === 'checkbox' ? field.checked : field.value;
  }
  return patch;
}

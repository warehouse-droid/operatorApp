import { canEditSpecialCaseLines } from './special-stock-case-edits.js';
import { specialSalesInternalRemarkField, specialSalesInternalRemarkForm } from './special-stock-internal-remark.js';
export { syncSpecialInternalRemarkForm } from './special-stock-internal-remark.js';
/** @typedef {Record<string, any>} CaseDetail Application API case JSON. */
/** @param {unknown} value */
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char] || char));
/** @type {Record<string,string>} */
const methods = {vendor_pickup:'Customer pickup at vendor yard',yard_pickup:'Pickup at inquired yard',mbt_delivery:'Delivery'};
/** @param {string} method */
export const specialFulfillmentLabel = method => methods[method] || 'Not selected';
/** @param {CaseDetail} detail */
export function canEditSpecialFulfillment(detail) {
  return detail.closeStatus==='active' && !detail.operationallyComplete && !['closed','completed'].includes(detail.stage)
    && !detail.dispatchPlanning?.anyPlanned && !detail.dispatchPlanned && !['planned','in_progress','completed'].includes(detail.handoff?.status);
}
/** @param {CaseDetail} detail */
export function canEditSpecialHeader(detail) {
  return canEditSpecialCaseLines(detail) && canEditSpecialFulfillment(detail);
}
/** @param {unknown} value @returns {string} */
export function normalizeSpecialHeaderNote(value) {
  if (typeof value !== 'string' || value.length > 8000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw Object.assign(new Error('Note must be text of 8,000 characters or fewer, without control characters.'), { status: 400, code: 'SPECIAL_HEADER_NOTE_INVALID' });
  }
  return value.replace(/\r\n?/g, '\n');
}
/** @param {CaseDetail} detail @param {{before?:string,after?:string}} summaryFields Escaped summary fields from the caller. */
export function specialFulfillmentEditor(detail, {before='',after=''} = {}) {
  /** @param {string} method */
  const summary = method => `<div class="stock-request-summary">${before}${method}${after}</div>`;
  const note = `<div class="stock-request-notice"><small>Note</small><div class="special-header-note-content">${escape(detail.remarks || '—')}</div></div>`;
  const savedNotes = `<div class="special-request-notes">${note}${specialSalesInternalRemarkForm(detail)}</div>`;
  if(!canEditSpecialFulfillment(detail)) return summary(`<span><small>Delivery method</small><strong>${escape(specialFulfillmentLabel(detail.fulfillmentMethod))}</strong></span>`) + savedNotes;
  const header = canEditSpecialHeader(detail);
  const pending=['applying','attention'].includes(detail.fulfillmentChange?.status),draft=pending?detail.fulfillmentChange.target:detail;
  return `<form class="stock-request-form special-summary-form" data-special-fulfillment-form ${header ? 'data-special-header-form' : ''}>
    ${header ? `<input type="hidden" name="expectedRevision" value="${escape(detail.revision)}"><p class="stock-request-error" data-special-header-conflict hidden>This request changed. Your header entries are kept. Reload the header before saving.</p>` : ''}
    ${summary(`<span class="special-summary-delivery"><small>Delivery method</small><select name="fulfillmentMethod" aria-label="Delivery method" required ${pending?'disabled':''}>${Object.entries(methods).map(([value,label])=>`<option value="${value}" ${draft.fulfillmentMethod===value?'selected':''}>${label}</option>`).join('')}</select>
      <button type="submit" class="primary" ${pending?'title="Retry the saved delivery update"':''}>${header ? 'Save header' : 'Save'}</button></span>`)}
    ${header ? `<div class="special-request-notes"><label><span>Note</span><textarea name="remarks" rows="4" maxlength="8000">\n${escape(detail.remarks)}</textarea></label>${specialSalesInternalRemarkField(detail)}</div><button type="button" data-special-sales-action="reload-header" hidden>Reload header</button>` : ''}
    ${pending?`<p class="stock-request-error">Delivery update incomplete. Retry the saved change. ${escape(detail.fulfillmentChange.error)}</p>`:''}
    <fieldset class="stock-request-line-fields special-fulfillment-fields" data-special-delivery-fields ${pending?'disabled':''} ${draft.fulfillmentMethod==='mbt_delivery'?'':'hidden'}>
      <label class="stock-request-wide"><span>Delivery address *</span><input name="deliveryAddress" required value="${escape(draft.deliveryAddress)}"></label>
      <label><span>Contact name</span><input name="deliveryContactName" value="${escape(draft.deliveryContactName)}"></label>
      <label><span>Contact phone</span><input name="deliveryContactPhone" value="${escape(draft.deliveryContactPhone)}"></label>
      <label><span>Preferred delivery date</span><input type="date" name="deliveryDate" value="${escape(draft.deliveryDate)}"></label>
      <label><span>Window start</span><input type="time" name="windowStart" value="${escape(draft.windowStart)}"></label>
      <label><span>Window end</span><input type="time" name="windowEnd" value="${escape(draft.windowEnd)}"></label>
      <label class="stock-request-wide"><span>Delivery instructions</span><textarea name="deliveryInstructions">${escape(draft.deliveryInstructions)}</textarea></label>
    </fieldset></form>${header ? '' : savedNotes}`;
}
/** @param {HTMLFormElement|null} form @param {number} [revision] */
export function syncSpecialFulfillmentForm(form, revision) {
  if(!form) return;
  if (form.hasAttribute('data-special-header-form') && revision !== undefined) {
    const expected = /** @type {HTMLInputElement} */ (form.querySelector('[name=expectedRevision]'));
    const stale = Number(expected.value) !== revision;
    /** @type {HTMLButtonElement} */ (form.querySelector('[type=submit]')).disabled = stale;
    /** @type {HTMLElement} */ (form.querySelector('[data-special-header-conflict]')).hidden = !stale;
    /** @type {HTMLButtonElement} */ (form.querySelector('[data-special-sales-action=reload-header]')).hidden = !stale;
  }
  const select=form.querySelector('select'),fields=/** @type {HTMLElement|null} */(form.querySelector('[data-special-delivery-fields]'));
  if (!select || !fields) return;
  const delivery=select.value==='mbt_delivery';
  fields.hidden=!delivery;
  for(const input of fields.querySelectorAll('input,textarea')) /** @type {HTMLInputElement|HTMLTextAreaElement} */(input).disabled=!delivery;
}

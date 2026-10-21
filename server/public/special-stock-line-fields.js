import { normalizeSpecialDiscount, specialQuantity } from './special-stock-pricing.js';
import { normalizePackQuantity } from './order-pack-quantities.js';

export const SPECIAL_LINE_UNITS = ['PLT', 'LYR', 'SEC', 'PCS', 'EACH', 'SQFT'];
export const SPECIAL_LINE_PACK_FIELDS = ['palletQty', 'layerQty', 'sectionQty', 'pieceQty'];
export const SPECIAL_LINE_MATERIAL_FIELDS = ['productName', 'color', 'size', 'detailSpec', 'quantity', 'uom', ...SPECIAL_LINE_PACK_FIELDS];
export const SPECIAL_LINE_SCM_FIELDS = [...SPECIAL_LINE_MATERIAL_FIELDS, 'requiredDate'];
export const SPECIAL_LINE_SALES_FIELDS = [...SPECIAL_LINE_MATERIAL_FIELDS, 'discountPercent', 'requiredDate', 'customerNote'];
/** @param {string} today Toronto calendar date in YYYY-MM-DD format. */
export function defaultSpecialLineRequiredDate(today) {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 14);
  return date.toISOString().slice(0, 10);
}
/** @param {string} message */
const invalid = message => Object.assign(new Error(message), { status: 400, code: 'SPECIAL_LINE_FIELD_INVALID' });
/** @param {Record<string,any>} line @returns {Record<string,any>} */
export function specialLineFieldValues(line) {
  return { ...Object.fromEntries(SPECIAL_LINE_SALES_FIELDS.map(field => [field, SPECIAL_LINE_PACK_FIELDS.includes(field) ? normalizePackQuantity(line[field]) : line[field] ?? (field === 'discountPercent' ? 0 : '')])),
    quantity: line.packageQuantity ?? line.quantity, uom: line.rateUom || line.uom || '', rate: line.originalRate ?? line.rate ?? '' };
}
/** @param {unknown} value @param {string} field @param {number} maximum */
function textField(value, field, maximum) {
  if (typeof value !== 'string') throw invalid(`Enter a valid ${field}.`);
  const text = value.trim().replace(/\r\n?/g, '\n');
  if (text.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) || (field === 'productName' && !text)) throw invalid(`Enter a valid ${field} (up to ${maximum} characters).`);
  return text;
}
/** Only the declared line fields can enter an edit or review.
 * @param {Record<string,any>} input @param {Record<string,any>} before
 * @param {{sales?:boolean,now?:Date}} [options] @returns {Record<string,any>} */
export function changedSpecialLineFields(input, before, { sales = false, now = new Date() } = {}) {
  const saved = specialLineFieldValues(before);
  /** @type {Record<string,any>} */
  const changes = {};
  for (const field of sales ? SPECIAL_LINE_SALES_FIELDS : SPECIAL_LINE_SCM_FIELDS) {
    if (!Object.hasOwn(input, field)) continue;
    let value = input[field];
    if (SPECIAL_LINE_PACK_FIELDS.includes(field)) {
      try { value = normalizePackQuantity(value); }
      catch { throw invalid('PLT, LYR, SEC and PCS must be numbers between 0 and 1000000000.'); }
    } else if (field === 'quantity') value = specialQuantity(value);
    else if (field === 'discountPercent') value = normalizeSpecialDiscount(value);
    else if (field === 'uom') {
      if (typeof value !== 'string') throw invalid('Select a Sales UOM.');
      value = value.trim().toUpperCase();
      if (value !== saved.uom && !SPECIAL_LINE_UNITS.includes(value)) throw invalid('Sales UOM must be PLT, LYR, SEC, PCS, EACH or SQFT.');
    } else if (field === 'requiredDate') {
      if (typeof value !== 'string') throw invalid('Enter a required date.');
      value = value.trim();
      if (value !== saved.requiredDate) {
        const parsed = new Date(`${value}T00:00:00Z`);
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value < today) throw invalid('Required date must be a valid date today or later.');
      }
    } else value = textField(value, field, (/** @type {Record<string,number>} */ ({ productName: 500, detailSpec: 2000, customerNote: 4000 }))[field] || 200);
    if (value !== saved[field]) changes[field] = value;
  }
  return changes;
}
/** @param {unknown} value */
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => (/** @type {Record<string,string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }))[char]);
/** Shared material controls for New Request, Sales edits, SCM and adjustments.
 * @param {Record<string,any>} line
 * @param {{sales?:boolean,rateMode?:string,minimumDate?:string,itemLabel?:string,showRequiredDate?:boolean}} [options] */
export function specialLineFields(line, { sales = true, rateMode = 'required', minimumDate = '', itemLabel = 'Product name *', showRequiredDate = true } = {}) {
  const units = SPECIAL_LINE_UNITS.includes(line.uom) || !line.uom ? SPECIAL_LINE_UNITS : [line.uom, ...SPECIAL_LINE_UNITS];
  const packing = SPECIAL_LINE_PACK_FIELDS.map((field, index) => `<label><span>${['PLT', 'LYR', 'SEC', 'PCS'][index]}</span><input name="${field}" type="number" min="0" max="1000000000" step="any" value="${escape(normalizePackQuantity(line[field]))}" /></label>`).join('');
  const requiredDate = showRequiredDate ? `<label><span>Required date *</span><input name="requiredDate" type="date" ${minimumDate ? `min="${escape(minimumDate)}"` : ''} ${line.requiredDate || minimumDate ? 'required' : ''} value="${escape(line.requiredDate)}" /></label>` : '';
  return `<div class="stock-request-line-fields special-case-initial-grid">
    <div class="special-case-product-row">${(/** @type {Array<[string,string,number]>} */ ([['productName', itemLabel, 500], ['color', 'Colour', 200], ['size', 'Size', 200], ['detailSpec', 'Detail Spec', 2000]])).map(([field, label, max]) => `<label><span>${label}</span>${/[\r\n]/.test(String(line[field] ?? '')) ? `<textarea name="${field}" maxlength="${max}" rows="2" ${field === 'productName' ? 'required' : ''}>${escape(line[field])}</textarea>` : `<input name="${field}" maxlength="${max}" ${field === 'productName' ? 'required' : ''} value="${escape(line[field])}" />`}</label>`).join('')}</div>
    <div class="${sales ? 'special-sales-pricing-row special-case-pricing-row' : 'special-scm-quantity-row'}">
      <label><span>Quantity *</span><input name="quantity" type="number" min="0.000001" max="1000000000" step="any" required value="${escape(line.quantity)}" /></label>
      <label><span>Sales UOM *</span><select name="uom" required>${units.map(unit => `<option value="${escape(unit)}" ${line.uom === unit ? 'selected' : ''}>${escape(unit)}</option>`).join('')}</select></label>
      ${sales ? `<label><span>${rateMode === 'fixed' ? 'Original rate ($)' : 'Sales rate per unit ($) *'}</span>${rateMode === 'fixed' ? `<output class="special-fixed-value">${escape(line.rate)}</output><input name="rate" type="hidden" value="${escape(line.rate)}" />` : `<input name="rate" type="number" min="0" max="1000000000" step="0.000001" ${rateMode === 'required' ? 'required' : ''} value="${escape(line.rate)}" />`}</label>
      <label><span>Discount (%)</span><input name="discountPercent" type="number" min="0" max="100" step="0.0001" value="${escape(line.discountPercent)}" /></label>
      <label><span>Subtotal (before tax)</span><output data-special-subtotal></output></label>` : packing}
    </div>${sales ? `<div class="special-case-delivery-row">${requiredDate}
      <label><span>Line note</span>${/[\r\n]/.test(String(line.customerNote ?? '')) ? `<textarea name="customerNote" maxlength="4000" rows="2">${escape(line.customerNote)}</textarea>` : `<input name="customerNote" maxlength="4000" value="${escape(line.customerNote)}" />`}</label>
      ${packing}</div>` : requiredDate}</div>`;
}
/** @param {Record<string,any>} change */
export function specialAdjustmentFieldSummary(change) {
  /** @type {Record<string,string>} */
  const labels = { productName: 'Product name', color: 'Colour', size: 'Size', detailSpec: 'Detail Spec', uom: 'Sales UOM', requiredDate: 'Required date', customerNote: 'Line note', palletQty: 'PLT', layerQty: 'LYR', sectionQty: 'SEC', pieceQty: 'PCS' };
  return Object.entries(change.toFields || {}).filter(([field]) => labels[field]).map(([field, value]) => `<p>${escape(labels[field])}: ${escape(change.fromFields?.[field] ?? '—')} → ${escape(value === '' ? '—' : value)}</p>`).join('');
}

import { specialItemDescription } from './special-stock-line-details.js';

/** @param {unknown} value */
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));

/** Saved Sales notes stay readable when the decision form or case editor is hidden.
 * @param {Record<string,any>} line
 */
export function specialLineNotes(line) {
  const notes = [['Line note', line.customerNote], ['Customer note', line.salesCustomerNote], ['Decision reason', line.salesDecisionReason]]
    .filter(([, value]) => String(value ?? '').trim());
  if (!notes.length) return '';
  return `<div class="special-line-notes" data-special-line-notes>${notes.map(([label, value]) =>
    `<div><small>${label}</small><div class="special-line-note-content">${escape(value)}</div></div>`).join('')}</div>`;
}

/** @param {{lines?:Array<Record<string,any>>}} detail */
export function specialRequestLineNotes(detail) {
  const lines = (detail.lines || []).map(line => ({ line, notes: specialLineNotes(line) })).filter(value => value.notes);
  if (!lines.length) return '';
  return `<section class="stock-request-section" data-special-request-line-notes><h3>Sales line notes</h3><div class="stock-request-lines">${lines.map(({ line, notes }) =>
    `<article class="stock-request-line"><header><strong>${escape(specialItemDescription(line))}</strong></header>${notes}</article>`).join('')}</div></section>`;
}

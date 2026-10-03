/** @type {Record<string,string>} */
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** @param {unknown} value */
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => entities[char]);

/** @param {Record<string,any>} detail @param {string} audience */
export function specialInformationPanel(detail, audience) {
  const info = detail.informationRequest;
  const active = detail.closeStatus === 'active' && !['closed', 'completed'].includes(detail.stage);
  if (info?.status === 'pending') {
    return `<section class="stock-request-notice special-information-request" role="status"><h3>Pending Update</h3><p><strong>SCM needs more information:</strong></p><p class="special-header-note-content">${escape(info.question)}</p>
      ${audience === 'sales' && active ? `<form class="stock-request-form" data-special-information-reply-form><label><span>Information for SCM *</span><textarea name="reply" required maxlength="4000" rows="3"></textarea></label><p>Update the case details if needed, then submit your reply to resume the stock check.</p><button class="primary" type="submit">Submit update to SCM</button></form>` : '<p>Waiting for Sales to update the information before stock checking.</p>'}</section>`;
  }
  const answered = info?.status === 'answered' ? `<section class="stock-request-notice special-information-request"><strong>Sales information update</strong><p class="special-header-note-content">SCM: ${escape(info.question)}</p><p class="special-header-note-content">Sales: ${escape(info.reply)}</p></section>` : '';
  if (audience !== 'scm' || !active || detail.salesOrderId || detail.salesOrderSkipped || detail.purchaseOrderId || detail.purchaseOrderSkipped
    || !detail.lines.some(/** @param {Record<string,any>} line */ line => !line.supplyStatus || line.salesDecision === 'request_update')) return answered;
  return `${answered}<section class="stock-request-section"><form class="stock-request-form" data-special-information-request-form><label><span>Information needed from Sales</span><textarea name="question" required maxlength="4000" rows="2" placeholder="Explain what Sales needs to clarify before the stock check"></textarea></label><button type="submit">Ask Sales for more information</button></form></section>`;
}

/** @param {unknown} value */
export function normalizeSpecialSalesInternalRemark(value) {
  if (typeof value !== 'string' || value.length > 8000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw Object.assign(new Error('Sales internal remark must be text of 8,000 characters or fewer, without control characters.'),
      { status: 400, code: 'SPECIAL_SALES_INTERNAL_REMARK_INVALID' });
  }
  return value.replace(/\r\n?/g, '\n');
}

/** @param {Record<string,any>} detail */
export function canEditSpecialSalesInternalRemark(detail) {
  return detail.closeStatus === 'active' && !detail.operationallyComplete
    && !['closed', 'completed'].includes(detail.stage) && !['cancelled', 'closed', 'completed'].includes(detail.status);
}

/** @param {unknown} value */
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));

/** @param {Record<string,any>} detail */
export function specialSalesInternalRemarkField(detail) {
  if (!canEditSpecialSalesInternalRemark(detail)) return `<div class="stock-request-notice special-sales-internal-remark"><small>Sales internal remark · Sales only</small><div class="special-sales-internal-remark-content">${escape(detail.salesInternalRemark || '—')}</div></div>`;
  return `<label class="special-sales-internal-remark"><span>Sales internal remark</span><textarea name="salesInternalRemark" rows="4" maxlength="8000">\n${escape(detail.salesInternalRemark)}</textarea><small>Visible to Sales only. Excluded from quotes and order documents.</small></label>`;
}

/** @param {Record<string,any>} detail */
export function specialSalesInternalRemarkForm(detail) {
  const field = specialSalesInternalRemarkField(detail);
  if (!canEditSpecialSalesInternalRemark(detail)) return field;
  return `<form class="stock-request-form special-internal-remark-form" data-special-internal-remark-form>
    <input type="hidden" name="expectedRevision" value="${escape(detail.revision)}">${field}
    <p class="stock-request-error" data-special-internal-remark-conflict hidden>This request changed. Your remark is kept. Reload the remark before saving.</p>
    <div class="stock-request-actions"><button type="submit" class="primary">Save internal remark</button><button type="button" data-special-sales-action="reload-internal-remark" hidden>Reload remark</button></div>
  </form>`;
}

/** @param {HTMLFormElement|null} form @param {number} [revision] */
export function syncSpecialInternalRemarkForm(form, revision) {
  if (!form || revision === undefined) return;
  const stale = Number(/** @type {HTMLInputElement} */ (form.querySelector('[name=expectedRevision]')).value) !== revision;
  /** @type {HTMLButtonElement} */ (form.querySelector('[type=submit]')).disabled = stale;
  /** @type {HTMLElement} */ (form.querySelector('[data-special-internal-remark-conflict]')).hidden = !stale;
  /** @type {HTMLButtonElement} */ (form.querySelector('[data-special-sales-action=reload-internal-remark]')).hidden = !stale;
}

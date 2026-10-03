/* global Element */
/** @typedef {{salesOrderOperationStatus?:string,purchaseOrderOperationStatus?:string,purchaseOrderId?:number|null,quantityReview?:{status?:string},closureReview?:{status?:string}}} CaseDetail */
/** @param {CaseDetail|null} detail */
export function specialOrderBusyMessage(detail) {
  const orders = detail?.purchaseOrderId ? 'Sales Order and Purchase Order' : 'Sales Order';
  if (detail?.closureReview?.status === 'applying') return `Closing ${orders} in NetSuite…`;
  if (detail?.quantityReview?.status === 'applying') return `Updating ${orders} in NetSuite…`;
  if (detail?.salesOrderOperationStatus === 'creating') return 'Creating Sales Order in NetSuite…';
  if (detail?.purchaseOrderOperationStatus === 'creating') return 'Creating Purchase Order in NetSuite…';
  return '';
}

/** @param {string} path @param {string|undefined} body @param {CaseDetail|null} detail */
export function specialMutationMessage(path, body, detail) {
  const orders = detail?.purchaseOrderId ? 'Sales Order and Purchase Order' : 'Sales Order';
  if (path.endsWith('/sales-order/create')) return 'Creating Sales Order in NetSuite…';
  if (path.endsWith('/purchase-order/create')) return 'Creating Purchase Order in NetSuite…';
  if (path.endsWith('/quantity-review') && JSON.parse(body || '{}').decision === 'approve') return `Updating ${orders} in NetSuite…`;
  if (path.endsWith('/closure-review') && JSON.parse(body || '{}').decision === 'approve') return `Closing ${orders} in NetSuite…`;
  if (path.endsWith('/close')) return detail?.purchaseOrderId ? 'Requesting SCM closure confirmation…' : 'Closing Sales Order in NetSuite…';
  return 'Saving…';
}

/** Disable only after the caller has collected its payload; retain native disabled states.
 * @param {HTMLElement} mount
 * @param {{getDetail:()=>CaseDetail|null,getLocalBusy:()=>boolean}} options
 */
export function installSpecialBusyState(mount, { getDetail, getLocalBusy }) {
  let localMessage = '';
  /** @type {Map<HTMLButtonElement|HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement,boolean>} */
  const disabled = new Map();
  function render() {
    for (const [control, before] of disabled) control.disabled = before;
    disabled.clear();
    const detail = mount.querySelector('.stock-request-detail');
    if (!detail) return;
    const message = localMessage || specialOrderBusyMessage(getDetail());
    detail.setAttribute('aria-busy', String(Boolean(message)));
    let status = detail.querySelector('[data-special-operation-status]');
    if (!message) { status?.remove(); return; }
    if (!status) {
      status = document.createElement('div');
      status.setAttribute('data-special-operation-status', '');
      status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      status.className = 'stock-request-notice special-operation-status';
      status.innerHTML = '<span class="special-operation-spinner" aria-hidden="true"></span><span data-special-operation-message></span>';
      detail.prepend(status);
    }
    const label = /** @type {HTMLElement} */ (status.querySelector('[data-special-operation-message]'));
    label.textContent = `${message} Please wait.`;
    const scope = localMessage ? mount : detail;
    for (const control of scope.querySelectorAll('button, input, select, textarea')) {
      const field = /** @type {HTMLButtonElement|HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement} */ (control);
      disabled.set(field, field.disabled); field.disabled = true;
    }
  }
  // Guard delegated listeners as well as native button clicks, including PDF previews.
  for (const type of ['click', 'submit', 'input', 'change']) mount.addEventListener(type, event => {
    if (!(event.target instanceof Element)) return;
    if (localMessage || getLocalBusy() || (specialOrderBusyMessage(getDetail()) && event.target.closest('.stock-request-detail'))) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  return {
    render,
    remote: () => Boolean(specialOrderBusyMessage(getDetail())),
    /** @param {string} path @param {string|undefined} body */
    start(path, body) { localMessage = specialMutationMessage(path, body, getDetail()); render(); },
    end() { localMessage = ''; render(); }
  };
}

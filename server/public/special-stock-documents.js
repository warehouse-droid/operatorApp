/* global AbortController */
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export function specialDocumentActions(detail, audience = 'sales') {
  const button = (kind, label) => `<button type="button" data-special-document="${kind}" data-case-id="${escape(detail.id)}">${label}</button>`;
  return `<div class="stock-request-actions special-document-actions">
    ${!detail.salesOrderId ? button('quote', 'Preview saved quote') : ''}
    ${detail.salesOrderId && !detail.salesOrderSkipped ? button('sales_order', 'Preview SO') : ''}
    ${audience === 'scm' && detail.purchaseOrderId && !detail.purchaseOrderSkipped ? button('purchase_order', 'Preview PO') : ''}
  </div>`;
}

function installStyles() {
  if (!document.querySelector('link[data-special-document-styles]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = '/special-stock-documents.css'; link.dataset.specialDocumentStyles = '';
    document.head.append(link);
  }
}

function previewDialog(title, trigger) {
  const dialog = document.createElement('dialog');
  dialog.className = 'special-document-dialog'; dialog.setAttribute('aria-label', title);
  dialog.innerHTML = `<header><h2>${escape(title)}</h2><div><a data-document-download hidden>Download PDF</a><button type="button" data-document-close autofocus>Close</button></div></header><div class="special-document-body" aria-live="polite">Loading preview…</div>`;
  const controller = new AbortController();
  let url;
  dialog.querySelector('[data-document-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { controller.abort(); if (url) URL.revokeObjectURL(url); dialog.remove(); if (trigger?.isConnected) trigger.focus(); }, { once: true });
  document.body.append(dialog); dialog.showModal();
  const body = dialog.querySelector('.special-document-body');
  return { dialog, body, signal: controller.signal, showPdf(blob, filename) {
    url = URL.createObjectURL(blob);
    const link = dialog.querySelector('[data-document-download]'); link.href = url; link.download = filename; link.hidden = false;
    const frame = document.createElement('iframe'); frame.title = title; frame.src = url;
    body.replaceChildren(frame);
  } };
}

export function installSpecialDocumentPreviews(mount, { audience, getDraft } = {}) {
  installStyles();
  mount.addEventListener('click', async event => {
    const trigger = event.target.closest('[data-special-document]');
    if (!trigger || !mount.contains(trigger)) return;
    event.preventDefault();
    const kind = trigger.dataset.specialDocument;
    let input;
    if (kind === 'draft_quote') {
      if (!mount.querySelector('[data-special-case-form]').reportValidity()) return;
      input = getDraft();
    }
    const quote = ['quote', 'draft_quote'].includes(kind);
    const preview = previewDialog(quote ? 'MBBS quote preview' : kind === 'sales_order' ? 'Sales Order preview' : 'Purchase Order preview', trigger);
    try {
      const prefix = `/api/${audience}/special-stock-requests`;
      const path = kind === 'draft_quote' ? `${prefix}/quote-preview` : `${prefix}/${encodeURIComponent(trigger.dataset.caseId)}${quote ? '/quote.pdf' : `/orders/${encodeURIComponent(kind)}.pdf`}`;
      const response = await fetch(path, { cache: 'no-store', signal: preview.signal,
        method: input ? 'POST' : 'GET', headers: { Accept: 'application/pdf', ...(input ? { 'Content-Type': 'application/json' } : {}) },
        ...(input ? { body: JSON.stringify(input) } : {}) });
      if (!response.ok) { const problem = await response.json().catch(() => ({})); throw Error(problem.error || `Preview unavailable (${response.status}).`); }
      if (!response.headers.get('content-type')?.includes('application/pdf')) throw Error('The preview did not return a PDF.');
      const blob = await response.blob();
      const filename = (/filename="([^"]+)"/.exec(response.headers.get('content-disposition') || '')?.[1] || 'MBBS-document.pdf').replace(/[^a-zA-Z0-9_.-]/g, '-');
      if (preview.dialog.isConnected) preview.showPdf(blob, filename);
    } catch (error) {
      if (preview.dialog.isConnected) { preview.body.setAttribute('role', 'alert'); preview.body.textContent = error.message; }
    }
  });
}

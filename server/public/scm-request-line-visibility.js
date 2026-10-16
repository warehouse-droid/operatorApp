(() => {
  const expanded = new Set();
  const excluded = line => line.salesDecision === 'declined';
  const label = show => show ? 'Hide Decline/Revoke' : 'Show All';
  function controls(request) {
    if (!request.lines.some(excluded)) return '';
    const show = expanded.has(Number(request.id));
    return `<div class="stock-request-actions"><button type="button" data-scm-line-toggle aria-expanded="${show}" aria-controls="scm-request-lines-${Number(request.id)}">${label(show)}</button></div>
      <p class="stock-request-muted" data-scm-lines-empty ${!show && request.lines.every(excluded) ? '' : 'hidden'}>All lines are declined or revoked. Select Show All to view them.</p>`;
  }
  function wrap(request, line, html) {
    const hidden = excluded(line) && !expanded.has(Number(request.id));
    return `<fieldset data-scm-line-id="${Number(line.id)}" data-scm-line-excluded="${excluded(line)}" ${hidden ? 'hidden disabled' : ''} style="border:0;padding:0;margin:0;min-width:0">${html}</fieldset>`;
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-scm-line-toggle]');
    if (!button || button.disabled) return;
    const section = button.closest('[data-scm-line-visibility]');
    if (!section) return;
    const id = Number(section.dataset.scmLineVisibility), show = !expanded.has(id);
    if (show) expanded.add(id); else expanded.delete(id);
    for (const row of section.querySelectorAll('[data-scm-line-id]')) {
      row.hidden = row.dataset.scmLineExcluded === 'true' && !show;
      row.disabled = row.hidden;
    }
    button.textContent = label(show); button.setAttribute('aria-expanded', String(show));
    const empty = section.querySelector('[data-scm-lines-empty]');
    if (empty) empty.hidden = Boolean(section.querySelector('[data-scm-line-id]:not([hidden])'));
    const save = section.querySelector('[data-scm-line-save]');
    if (save) save.disabled = !section.querySelector('[data-scm-line-id]:not([disabled]) [data-special-stock-line]');
  });
  window.SCMRequestLineVisibility = {controls, wrap};
})();

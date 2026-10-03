(() => {
  const types = ['special', 'regular', 'waitlist', 'aggregate'];
  const selected = new URLSearchParams(location.search).get('tab');
  const t = label => window.MBBSAggregateI18n?.text(label) || label;
  let opened = false;
  let active = types.includes(selected) ? selected : 'special';
  window.MBBSStockRequestTabs = {
    get active() { return active; },
    onOpen: null,
    isActive(type) { return type === active; },
    preserveFocus() {
      const focused = Boolean(document.activeElement?.matches('[data-stock-request-tab]'));
      return () => {
        if (focused) { document.querySelector(`[data-stock-request-tab="${active}"]`)?.focus(); }
      };
    },
    html() {
      return `<div class="stock-request-tabs" role="tablist" aria-label="${t('Stock request type')}">${types.map(type =>
        `<button role="tab" type="button" data-stock-request-tab="${type}" aria-selected="${type === active}" tabindex="${type === active ? 0 : -1}">${t(type[0].toUpperCase() + type.slice(1))}</button>`
      ).join('')}</div>`;
    },
    async open(type) {
      if (!types.includes(type)) { return; }
      if (opened && active === type) return;
      opened = true;
      active = type;
      document.getElementById('scmStockRequestApp')?.classList.remove('aggregate-shell');
      document.body.classList.remove('aggregate-module-active');
      const url = new URL(location.href);
      url.searchParams.set('tab', type);
      history.replaceState(null, '', url);
      window.dispatchEvent(new CustomEvent('mbbs-stock-request-tab-changed', { detail: { type } }));
      await this.onOpen?.(type);
    }
  };
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-stock-request-tab]');
    if (button) { window.MBBSStockRequestTabs.open(button.dataset.stockRequestTab); }
  });
  document.addEventListener('keydown', event => {
    const button = event.target.closest('[data-stock-request-tab]');
    if (!button || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { return; }
    event.preventDefault();
    const current = types.indexOf(button.dataset.stockRequestTab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? types.length-1 : (current + (event.key === 'ArrowRight' ? 1 : types.length-1)) % types.length;
    window.MBBSStockRequestTabs.open(types[next]);
  });
})();

/* global MutationObserver */
(() => {
  if (window.MBBSScmSpecialAlert) { return; }
  const endpoint = '/api/scm/special-stock-requests/alerts';
  const tokenKeys = ['mbbs.staff.token', 'mbbs.dispatch.token', 'mbbs.control.token', 'mbbs.operator.token'];
  const readToken = () => tokenKeys.map(key => localStorage.getItem(key)).find(Boolean) || '';
  const chinese = () => window.MBBS_I18N?.language() === 'zh-CN';
  let session = '', checkedSession = '', allowed = false, count = null;
  let timer = null, retry = null, events = null, observer = null, request = null, authority = null, refreshAgain = false;
  let link = null, status = null;
  let newRequests = 0, confirmedOrders = 0;

  function paint() {
    if (!allowed) { return; }
    const host = document.querySelector('.dispatch-topbar .topbar-actions, .topbar .topbar-actions, .topbar > .actions')
      || document.querySelector('.dispatch-topbar, .topbar, .mbt-app-topbar');
    if (!host) { return; }
    if (!link) {
      link = document.createElement('a');
      link.className = 'scm-special-alert';
      link.href = '/scm/stock-requests?tab=special&stages=new_enquiry,confirmed';
      link.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg><span data-special-alert-label></span><strong data-special-alert-count></strong>';
    }
    if (link.parentElement !== host) { host.prepend(link); }
    link.hidden = !count;
    const label = chinese() ? '特殊商品申请' : 'Special requests';
    const description = chinese() ? `${count || 0} 份特殊商品申请：${newRequests} 份新申请，${confirmedOrders} 份已确认订单`
      : `${count || 0} special request${count === 1 ? '' : 's'}: ${newRequests} new request${newRequests === 1 ? '' : 's'}, ${confirmedOrders} confirmed order${confirmedOrders === 1 ? '' : 's'}`;
    const labelNode = link.querySelector('[data-special-alert-label]');
    const countNode = link.querySelector('[data-special-alert-count]');
    if (labelNode.textContent !== label) { labelNode.textContent = label; }
    if (countNode.textContent !== String(count || 0)) { countNode.textContent = String(count || 0); }
    link.setAttribute('aria-label', description);
    link.title = description;
    if (!status) {
      status = document.createElement('span');
      status.className = 'scm-special-alert-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.setAttribute('aria-atomic', 'true');
      document.body.append(status);
    }
    if (count !== null && status.textContent !== description) { status.textContent = description; }
  }

  function stop() {
    allowed = false;
    count = null;
    newRequests = 0;
    confirmedOrders = 0;
    window.clearInterval(timer);
    window.clearTimeout(retry);
    timer = null;
    events?.close();
    events = null;
    observer?.disconnect();
    observer = null;
    request?.abort();
    request = null;
    refreshAgain = false;
    link?.remove();
    status?.remove();
    link = null;
    status = null;
  }

  async function refresh() {
    if (readToken() !== session) { return checkSession(); }
    if (!allowed || document.hidden) { return; }
    if (request) { refreshAgain = true; return; }
    const controller = new AbortController();
    request = controller;
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(endpoint, { cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${session}` } });
      if (request !== controller || readToken() !== session) { return; }
      if (response.status === 401 || response.status === 403) { stop(); checkedSession = ''; return; }
      if (response.status === 404) { count = 0; newRequests = 0; confirmedOrders = 0; paint(); return; }
      if (!response.ok) { return; }
      const data = await response.json();
      if (request !== controller || readToken() !== session) { return; }
      if (![data.newRequests, data.confirmedOrders, data.total].every(value => Number.isSafeInteger(value) && value >= 0)
          || data.total !== data.newRequests + data.confirmedOrders) { return; }
      newRequests = data.newRequests;
      confirmedOrders = data.confirmedOrders;
      count = data.total;
      paint();
    } catch {
      // Keep the last known count through temporary connection failures.
    } finally {
      window.clearTimeout(timeout);
      if (request === controller) {
        request = null;
        if (refreshAgain) { refreshAgain = false; void refresh(); }
      }
    }
  }

  function start() {
    if (!allowed) { return; }
    if (!observer) {
      observer = new MutationObserver(paint);
      observer.observe(document.body, { childList: true, subtree: true });
    }
    paint();
    if (!timer) { timer = window.setInterval(refresh, 30000); }
    if (!events && 'EventSource' in window) {
      events = new EventSource('/api/events?client=scm-special-alert');
      events.addEventListener('open', refresh);
      events.addEventListener('app-event', message => {
        try {
          if (['special-stock-request.updated', 'dispatch.orders.updated', 'driver.job.completed'].includes(JSON.parse(message.data).type)) { void refresh(); }
        } catch { /* Ignore malformed invalidations. */ }
      });
    }
    void refresh();
  }

  function acceptOperator(operator) {
    const roles = [...(operator?.roles || []), operator?.role];
    const canManage = !operator?.publicSales && roles.some(role => ['admin', 'scm', 'scm_staff'].includes(role));
    if (!canManage) { stop(); return; }
    allowed = true;
    start();
  }

  async function checkSession() {
    window.clearTimeout(retry);
    const token = readToken();
    if (token !== session) {
      stop();
      authority?.abort();
      authority = null;
      checkedSession = '';
      session = token;
    }
    if (!token) { return; }
    if (checkedSession === token) { start(); return; }
    if (authority) { return; }
    const controller = new AbortController();
    authority = controller;
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch('/api/auth/me', { cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
      if (response.status === 401 || response.status === 403) { checkedSession = token; return; }
      if (!response.ok) { return; }
      const data = await response.json();
      if (authority !== controller || token !== readToken()) { return; }
      checkedSession = token;
      acceptOperator(data.operator);
    } catch { /* Retry session verification when the page regains focus. */ }
    finally {
      window.clearTimeout(timeout);
      if (authority === controller) {
        authority = null;
        if (checkedSession !== token) { retry = window.setTimeout(checkSession, 30000); }
      }
    }
  }

  function init() {
    const style = document.createElement('style');
    style.textContent = `
      .scm-special-alert { display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: 0 1 auto; max-width: 100%; min-height: 32px; box-sizing: border-box; padding: 5px 8px; border: 1px solid #1d4ed8; border-radius: 8px; background: #eff6ff; color: #1e3a8a; font: 700 12px/1.3 system-ui, sans-serif; text-decoration: none; }
      .scm-special-alert[hidden] { display: none; }
      .scm-special-alert:hover { background: #dbeafe; }
      .scm-special-alert:focus-visible { outline: 3px solid #006f6b; outline-offset: 2px; }
      .scm-special-alert svg { width: 17px; height: 17px; flex-shrink: 0; }
      .scm-special-alert strong { min-width: 20px; padding: 2px 4px; box-sizing: border-box; border-radius: 12px; background: #1d4ed8; color: white; text-align: center; }
      .scm-special-alert-status { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
      @media (max-width: 760px) {
        .scm-special-alert { min-height: 36px; }
        body.has-app-sidebar .dispatch-topbar:has(.scm-special-alert:not([hidden])) { grid-template-columns: minmax(0, 1fr) auto; }
        body.has-app-sidebar .dispatch-shell:has(> .dispatch-topbar .scm-special-alert:not([hidden])) { grid-template-rows: auto minmax(0, 1fr); }
        .dispatch-topbar:has(.scm-special-alert:not([hidden])) .topbar-actions { max-width: 100%; flex-wrap: wrap; }
      }
      @media (max-width: 360px) {
        body.has-app-sidebar:not(.app-sidebar-collapsed) .scm-special-alert [data-special-alert-label] { display: none; }
      }
    `;
    document.head.append(style);
    void checkSession();
  }

  window.MBBSScmSpecialAlert = { refresh };
  window.addEventListener('mbbs-auth-operator-changed', () => {
    stop();
    checkedSession = '';
    void checkSession();
  });
  window.addEventListener('mbbs-language-changed', paint);
  window.addEventListener('storage', event => { if (tokenKeys.includes(event.key) || event.key === null) { void checkSession(); } });
  window.addEventListener('focus', checkSession);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { void checkSession(); } });
  window.addEventListener('pageshow', checkSession);
  window.addEventListener('pagehide', () => { stop(); authority?.abort(); authority = null; checkedSession = ''; });
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init, { once: true }); }
  else { init(); }
})();

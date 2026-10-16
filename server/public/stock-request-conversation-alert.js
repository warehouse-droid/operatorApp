/* global localStorage, EventSource, AbortSignal */
(() => {
  if (window.StockRequestConversationAlerts) return;
  const token = () => ['mbbs.staff.token','mbbs.dispatch.token','mbbs.control.token','mbbs.operator.token'].map(key => localStorage.getItem(key)).find(Boolean) || '';
  let session = '', actor = null, generation = 0, checking = false, refreshing = false, stream = null, badge = null, notice = null, rows = [];
  const shown = new Set();
  const link = row => `/${row.audience}/stock-requests?tab=${row.tab}&requestId=${row.id}&requestRef=${encodeURIComponent(row.requestRef)}`;
  const text = (tag, value) => {const node = document.createElement(tag); node.textContent = value; return node;};
  const key = row => `mbbs.stock.conversation.${actor.id}.${row.audience}.${row.id}.${row.latestEventId}`;
  function stop() {
    generation++; actor = null; rows = []; checking = false; refreshing = false; stream?.close(); stream = null;
    badge?.remove(); badge = null; notice?.remove(); notice = null; shown.clear();
  }
  function seen(row) {try {return shown.has(key(row)) || localStorage.getItem(key(row)) === '1';} catch {return shown.has(key(row));}}
  function remember(row) {shown.add(key(row)); try {localStorage.setItem(key(row), '1');} catch { /* Memory deduplication remains available. */ }}
  function visible(row) {const displayed = window.StockRequestConversation?.displayed(); return displayed?.id === row.id && displayed.audience === row.audience && displayed.eventId >= row.latestEventId;}
  function paint(count) {
    if (!actor) return;
    if (!badge) {badge = text('a',''); badge.dataset.stockConversationAlert = ''; badge.className = 'stock-conversation-alert';}
    const host = document.querySelector('.topbar .topbar-actions,.dispatch-topbar .topbar-actions,.topbar > .actions') || document.body;
    if (badge.parentElement !== host) host.append(badge);
    badge.classList.toggle('stock-conversation-alert-floating', host === document.body);
    badge.hidden = !count; badge.textContent = `Messages ${count}`; badge.setAttribute('aria-label', `${count} unread conversation messages`);
    if (rows[0]) badge.href = link(rows[0]);
    if (document.hidden || notice) return;
    const row = rows.find(item => !visible(item) && !seen(item));
    if (!row) return;
    notice = text('aside',''); notice.dataset.stockConversationNotice = ''; notice.className = 'stock-conversation-notice'; notice.setAttribute('role','status');
    notice.append(text('strong','New message'), text('p',`${row.requestRef} · ${row.actorName}`), text('p',row.message));
    const open = text('a','Open conversation'); open.href = link(row);
    const dismiss = text('button','Dismiss'); dismiss.type = 'button'; dismiss.addEventListener('click', () => {notice?.remove(); notice = null; paint(count);});
    notice.append(open,dismiss); document.body.append(notice); remember(row);
  }
  async function get(path, current) {
    const response = await fetch(path, {cache:'no-store', headers:{Authorization:`Bearer ${current}`, Accept:'application/json'}, signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw Object.assign(new Error('Conversation alerts unavailable'), {status:response.status});
    return response.json();
  }
  function audiences(operator) {
    if (!operator?.id || operator.publicSales) return [];
    const roles = [operator.role, ...(operator.roles || [])];
    return [...(roles.some(role => ['sales','admin'].includes(role)) ? ['sales'] : []), ...(roles.some(role => ['scm','scm_staff','admin'].includes(role)) ? ['scm'] : [])];
  }
  async function refresh() {
    if (token() !== session || !actor) return checkSession();
    if (refreshing) return;
    refreshing = true; const version = generation, current = session;
    try {
      const results = await Promise.all(audiences(actor).map(async audience => ({audience, ...await get(`/api/${audience}/stock-request-conversation-alerts`, current)})));
      if (version !== generation || current !== token()) return;
      rows = results.flatMap(result => (result.requests || []).map(row => ({...row, audience:result.audience}))).sort((a,b) => b.latestEventId-a.latestEventId);
      for (const row of rows) {
        if (visible(row) || seen(row)) continue;
        void window.MBBSOSNotifications?.notify({id:`stock-conversation:${row.audience}:${row.id}:${row.latestEventId}`, title:'New conversation message',
          body:`${row.requestRef} · ${row.actorName}: ${row.message}`, url:link(row), session});
      }
      if (notice && !rows.some(row => notice.dataset.messageKey === key(row))) {notice.remove(); notice = null;}
      paint(results.reduce((sum, result) => sum + Number(result.count || 0), 0));
      if (notice && !notice.dataset.messageKey) {const row = rows.find(item => shown.has(key(item))); if (row) notice.dataset.messageKey = key(row);}
    } catch (error) {if (version === generation && [401,403].includes(error.status)) stop();}
    finally {if (version === generation) refreshing = false;}
  }
  async function checkSession(force = false) {
    const current = token();
    if (current !== session) {stop(); session = current;}
    if (!current || checking) return;
    if (actor && !force) return refresh();
    checking = true; const version = generation;
    try {
      const data = await get('/api/auth/me', current);
      if (version !== generation || current !== token()) return;
      if (!audiences(data.operator).length) {stop(); return;}
      if (actor && JSON.stringify(actor) !== JSON.stringify(data.operator)) stop();
      actor = data.operator;
      if (!stream) {
        stream = window.MBBSAppEventStream?.connect('/api/events?client=stock-conversation-alert') || new EventSource(`/api/events?client=stock-conversation-alert&token=${encodeURIComponent(current)}`);
        stream.addEventListener('app-event', event => {try {if (['stock-request.updated','special-stock-request.updated'].includes(JSON.parse(event.data).type)) void refresh();} catch { /* Ignore invalid events. */ }});
      }
      await refresh();
    } catch { /* Retry on focus and polling. */ }
    finally {if (version === generation) checking = false;}
  }
  const style = text('style', `.stock-conversation-alert{display:inline-flex;align-items:center;padding:7px 10px;border:1px solid #0f766e;border-radius:8px;background:#f0fdfa;color:#134e4a;font:700 12px system-ui;text-decoration:none}.stock-conversation-alert[hidden]{display:none}.stock-conversation-alert-floating{position:fixed;right:16px;bottom:60px;z-index:1000}.stock-conversation-notice{position:fixed;right:20px;bottom:108px;z-index:1100;max-width:340px;width:calc(100vw - 64px);padding:18px;border:1px solid #94a3b8;border-radius:12px;box-shadow:0 6px 24px #0f172a30;background:white;color:#0f172a;font:14px/1.5 system-ui}.stock-conversation-notice p{white-space:pre-wrap;overflow-wrap:anywhere;max-height:140px;overflow:auto}.stock-conversation-notice a,.stock-conversation-notice button{display:inline-block;padding:7px 10px;border:1px solid #0f766e;border-radius:6px;font:inherit;margin-right:8px;color:#134e4a;background:#f0fdfa;text-decoration:none;cursor:pointer}`);
  document.head.append(style);
  setInterval(() => void checkSession(), 20000);
  window.addEventListener('stock-conversation-read', () => void refresh());
  window.addEventListener('storage', () => void checkSession(true));
  window.addEventListener('mbbs-auth-operator-changed', () => void checkSession(true));
  window.addEventListener('focus', () => void checkSession(true));
  document.addEventListener('visibilitychange', () => {if (!document.hidden) void checkSession(true);});
  window.addEventListener('pagehide', stop);
  window.StockRequestConversationAlerts = {refresh, checkSession};
  void checkSession();
})();

/* global localStorage, EventSource, CustomEvent, AbortSignal */
(() => {
  const token = () => ['mbbs.staff.token','mbbs.dispatch.token','mbbs.control.token','mbbs.operator.token'].map(key => localStorage.getItem(key)).find(Boolean) || '';
  const drafts = new Map();
  const activity = new Map();
  let active = null, session = '', stream = null, queueView = null;
  const element = (tag, text, className) => {const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;};
  const current = state => active?.state === state && state.session === token() && active.panel.isConnected;
  const supported = request => request && (request.requestType === 'special' || request.workflowKind === 'special'
    || ['backorder','stocking','delivery'].includes(request.regular?.deliveryMethod) || request.workflowKind === 'backorder');
  function order(requests) {
    if (session !== token()) reset();
    for (const row of requests) activity.set(Number(row.id), Math.max(activity.get(Number(row.id)) || 0, Number(row.conversationEventId) || 0));
    return [...requests].sort((a, b) => (activity.get(Number(b.id)) || 0) - (activity.get(Number(a.id)) || 0));
  }
  const currentQueue = view => queueView === view && view.session === token() && view.active() && view.mount.isConnected;
  function acceptQueue(view, requests) {
    if (!currentQueue(view)) return;
    view.requests = order(requests); view.accept(view.requests);
  }
  async function refreshQueue(view) {
    if (view.loading) {view.pending = true; return;}
    view.loading = true;
    try {const payload = await view.read(view.url); acceptQueue(view, payload.requests || []);}
    catch {if (currentQueue(view)) view.error?.();}
    finally {
      view.loading = false;
      if (view.pending && currentQueue(view)) {view.pending = false; void refreshQueue(view);}
    }
  }
  function noteActivity(id, eventId) {
    id = Number(id); eventId = Number(eventId);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(eventId) || eventId <= (activity.get(id) || 0)) return;
    activity.set(id, eventId);
    const view = queueView;
    if (!view || !currentQueue(view)) return;
    if (view.requests.some(row => Number(row.id) === id)) acceptQueue(view, view.requests);
    else void refreshQueue(view);
  }
  function connect() {
    if (stream) return;
    stream = window.MBBSAppEventStream?.connect('/api/events?client=stock-conversation') || new EventSource(`/api/events?client=stock-conversation&token=${encodeURIComponent(session)}`);
    stream.addEventListener('app-event', event => {
      try {
        const message = JSON.parse(event.data), payload = message.payload || {};
        if (!['stock-request.updated','special-stock-request.updated'].includes(message.type)) return;
        if (payload.source === 'stock-conversation') noteActivity(payload.requestId, payload.conversationEventId);
        if (!payload.requestId || Number(payload.requestId) === Number(active?.state.id)) void refresh();
      } catch { /* Ignore invalid events. */ }
    });
  }
  function watchQueue(mount, options) {
    if (session !== token()) reset();
    if (!options.url) {queueView = null; return;}
    if (queueView?.mount !== mount || queueView.url !== options.url) queueView = {mount, session};
    Object.assign(queueView, options); connect();
  }
  async function api(state, suffix = '', body) {
    const response = await fetch(`/api/${state.audience}/stock-requests/${state.id}/conversation${suffix}`, {
      method: body ? 'POST' : 'GET', cache: 'no-store', headers: {Authorization: `Bearer ${state.session}`, 'Content-Type': 'application/json'},
      ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(15000)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || result.message || 'Could not load the conversation. Please retry.');
    return result;
  }
  async function acknowledge(state) {
    const eventId = state.data?.latestEventId;
    if (!current(state) || document.hidden || !active.panel.getClientRects().length || !eventId || eventId <= state.readEventId || state.reading) return;
    state.reading = true;
    try {
      await api(state, '/read', {eventId}); state.readEventId = eventId;
      if (current(state)) window.dispatchEvent(new CustomEvent('stock-conversation-read'));
    } catch { /* The unread alert remains until a later successful acknowledgement. */ }
    finally {state.reading = false;}
  }
  function paint(state) {
    if (!current(state)) return;
    const {list, input, send, status} = active;
    const signature = JSON.stringify({loaded: Boolean(state.data), messages: state.data?.messages || []});
    if (list.dataset.signature !== signature) {
      const follow = list.scrollHeight - list.scrollTop - list.clientHeight < 45;
      list.replaceChildren(); list.dataset.signature = signature;
      for (const message of state.data?.messages || []) {
        const card = element('article', '', `stock-conversation-message stock-conversation-${message.audience}`);
        const meta = element('div', '', 'stock-conversation-meta');
        meta.append(element('strong', `${message.actorName} · ${message.audience === 'sales' ? 'Sales' : 'SCM'}`));
        const time = element('time'); time.dateTime = message.createdAt;
        time.textContent = window.MBBS_I18N?.displayDateTime?.(message.createdAt) || new Date(message.createdAt).toLocaleString('en-CA', {timeZone:'America/Toronto'});
        meta.append(time); card.append(meta);
        if (message.itemName) card.append(element('small', message.itemName));
        card.append(element('p', message.message)); list.append(card);
      }
      if (!list.children.length && state.data) list.append(element('p', 'No messages yet.', 'stock-request-muted'));
      if (follow) list.scrollTop = list.scrollHeight;
    }
    input.disabled = state.sending || !state.data?.canSend;
    send.disabled = input.disabled || !state.draft.trim(); send.textContent = state.sending ? 'Sending…' : 'Send message';
    status.textContent = state.error || (state.data?.canSend === false ? 'This conversation is read-only.' : '');
    void acknowledge(state);
  }
  async function refresh() {
    const state = active?.state;
    if (!state || !current(state) || state.loading || state.sending) return;
    state.loading = true;
    try {state.data = await api(state); if (!state.sendError) state.error = '';}
    catch (error) {if (current(state)) state.error = error.message;}
    finally {state.loading = false; paint(state);}
  }
  async function sendMessage(state, event) {
    event.preventDefault(); event.stopPropagation();
    if (state.sending || !state.draft.trim() || !state.data?.canSend) return;
    const message = state.draft;
    if (!state.operation || state.operation.message !== message) state.operation = {message, operationId: crypto.randomUUID()};
    state.sending = true; state.error = ''; state.sendError = false; paint(state);
    try {
      state.data = await api(state, '', state.operation);
      if (state.session === token()) noteActivity(state.id, state.data.latestEventId);
      state.draft = ''; state.operation = null;
      if (current(state)) {active.input.value = ''; if (state.data.workflowUpdated) await active.onWorkflowUpdated?.();}
    } catch (error) {state.error = error.message; state.sendError = true;}
    finally {state.sending = false; paint(state);}
  }
  function reset() {active?.panel.remove(); active = null; queueView = null; drafts.clear(); activity.clear(); stream?.close(); stream = null; session = token();}
  function render(mount, request, audience, {onWorkflowUpdated} = {}) {
    if (session !== token()) reset();
    const host = mount?.querySelector('.stock-request-detail');
    if (!host || !supported(request)) {if (active?.mount === mount) {active.panel.remove(); active = null;} return;}
    const key = `${audience}:${request.id}`;
    let state = drafts.get(key);
    if (!state) {state = {id:request.id, audience, session, draft:'', error:'', readEventId:0}; drafts.set(key, state);}
    active?.panel.remove();
    const panel = element('section', '', 'stock-request-section stock-conversation'); panel.dataset.stockConversation = String(request.id);
    panel.append(element('h3', 'Conversation'), element('p', 'Sales and SCM', 'stock-conversation-subtitle'));
    const list = element('div', '', 'stock-conversation-messages'); list.dataset.conversationMessages = ''; list.setAttribute('role','log'); list.setAttribute('aria-label','Conversation messages');
    const form = element('form'), label = element('label', 'Message'), input = element('textarea');
    input.id = `stock-conversation-message-${audience}-${request.id}`; label.htmlFor = input.id; input.rows = 3; input.maxLength = 4000; input.required = true; input.value = state.draft;
    input.placeholder = 'Write a message…'; input.name = 'conversationMessage';
    const status = element('p', '', 'stock-conversation-status'); status.setAttribute('role','status');
    const send = element('button','Send message','primary'); send.type = 'submit';
    const retry = element('button','Refresh messages'); retry.type = 'button'; retry.addEventListener('click', () => void refresh());
    const actions = element('div', '', 'stock-request-actions'); actions.append(send, retry);
    form.append(label, input, status, actions); panel.append(list, form);
    input.addEventListener('input', event => {event.stopPropagation(); state.draft = input.value; state.error = ''; state.sendError = false; paint(state);});
    input.addEventListener('change', event => event.stopPropagation());
    form.addEventListener('submit', event => void sendMessage(state, event));
    active = {state, panel, mount, list, input, send, status, onWorkflowUpdated};
    const heading = host.querySelector('.stock-request-heading');
    if (heading) heading.after(panel); else host.prepend(panel);
    paint(state); void refresh();
    connect();
  }
  setInterval(() => {if (!document.hidden) void refresh();}, 20000);
  document.addEventListener('visibilitychange', () => {if (!document.hidden) void refresh();});
  window.addEventListener('storage', () => {if (session !== token()) reset();});
  window.addEventListener('mbbs-auth-operator-changed', () => {if (session !== token()) reset();});
  window.addEventListener('pagehide', reset);
  window.StockRequestConversation = {render, refresh, order, watchQueue, displayed: () => active?.panel.isConnected && !document.hidden ? {id:active.state.id, audience:active.state.audience, eventId:active.state.data?.latestEventId || 0} : null};
})();

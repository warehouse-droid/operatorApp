/* global requireDispatchLogin, dispatchAuthHeaders, dispatchRoleHome */
(() => {
  const mount = document.getElementById('aggregateRequestApp');
  if (!mount) { return; }
  const state = { actor: null, data: null, form: null, yard: '', dirty: false, busy: false,
    error: '', notice: '', generation: 0, operation: null, events: null };
  const t = (label, variables) => window.MBBSAggregateI18n?.text(label, variables) || label;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const titles = { new: "Request tomorrow's loads", edit: 'Edit submitted request', report: 'Report actual received / collected loads', waiting: 'Request awaiting SCM', closed: 'Request completed' };
  const saves = { new: 'Submit request', edit: 'Save requested loads', report: 'Submit actual report' };
  const writable = () => ['new', 'edit', 'report'].includes(state.form?.kind);

  async function api(path, options = {}) {
    const response = await fetch(path, { cache: 'no-store', ...options, headers: dispatchAuthHeaders({
      Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {})
    }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) { throw Object.assign(new Error(result.error || `Request failed (${response.status}).`), result, { status: response.status }); }
    return result;
  }

  function stage(data) {
    const row = data.request;
    if (!row) { return 'new'; }
    if (row.status === 'rejected' || row.status === 'reported') { return 'closed'; }
    if (row.requestedBy !== state.actor.id) { return 'waiting'; }
    return row.status === 'confirmed' ? 'report' : 'edit';
  }

  function initializeForm(data) {
    const kind = stage(data), row = data.request;
    state.form = { kind, remarks: row?.remarks || '', loads: Object.fromEntries(data.materials.map(material => {
      const line = row?.lines.find(item => item.materialCode === material.code);
      const amount = ['report', 'new'].includes(kind) ? 0 : line?.actualLoads ?? line?.requestedLoads ?? 0;
      return [material.code, String(amount)];
    })) };
    state.dirty = false;
    state.operation = null;
  }

  function card(material) {
    const amount = state.form.loads[material.code], label = t(material.label);
    const actual = state.form.kind === 'report';
    const line = state.data.request?.lines.find(item => item.materialCode === material.code);
    const locked = !writable() || state.busy;
    return `<div class="aggregate-quantity-card ${material.direction}" data-ag-request-card data-ag-material="${material.code}">
      <span class="aggregate-card-direction">${t(material.direction === 'inbound' ? 'Inbound · stock deliveries' : 'Outbound · dump collections')}</span>
      <div class="aggregate-material-heading">
        <label for="ag-load-${material.code}">${escape(label)}</label>
        ${actual ? `<div class="aggregate-confirmed-loads" role="note" aria-label="${escape(t('SCM confirmed: {count} loads', { count: line.confirmedLoads }))}">
          <span aria-hidden="true">${t('SCM')}<br>${t('Confirmed')}</span><strong aria-hidden="true" ${String(line.confirmedLoads).length > 5 ? 'class="aggregate-long-count"' : ''}>${line.confirmedLoads}</strong>
        </div>` : ''}
      </div>
      <span class="aggregate-count-label">${t(actual ? (material.direction === 'inbound' ? 'Loads received' : 'Loads collected') : 'Loads required')}</span>
      <div class="aggregate-stepper" role="group" aria-label="${escape(t('{material} load controls', { material: label }))}">
        <button type="button" data-ag-step="-1" aria-label="${escape(t('Decrease {material} loads', { material: label }))}" ${locked || (amount !== '' && Number(amount) <= 0) ? 'disabled' : ''}>−</button>
        <input id="ag-load-${material.code}" data-ag-load="${material.code}" aria-label="${escape(t('{material} loads', { material: label }))}" type="number" min="0" max="1000000000" step="1" inputmode="numeric" required value="${escape(amount)}" ${locked ? 'disabled' : ''} />
        <button type="button" data-ag-step="1" aria-label="${escape(t('Increase {material} loads', { material: label }))}" ${locked || Number(amount) >= 1000000000 ? 'disabled' : ''}>+</button>
      </div></div>`;
  }

  function notes() {
    if (!['new', 'edit'].includes(state.form.kind)) { return ''; }
    return `<label>${t('Remarks (optional)')}<textarea data-ag-remarks aria-label="${t('Remarks (optional)')}" maxlength="2000" rows="2" ${state.busy ? 'disabled' : ''}>${escape(state.form.remarks)}</textarea></label>`;
  }

  function stageHelp() {
    const row = state.data.request;
    if (state.form.kind === 'edit') { return t('Submitted · waiting for SCM confirmation. You can edit these loads.'); }
    if (state.form.kind === 'waiting') { return t('This request belongs to the previous submitter. SCM must resolve it before a new request.'); }
    if (state.form.kind === 'closed') { return row.status === 'rejected' ? `${t('Rejected')}: ${escape(row.decisionReason)}` : t('Actual loads reported.'); }
    if (state.form.kind === 'report') { return t('SCM confirmed · enter the actual loads received or collected. Enter 0 when none moved.'); }
    return t('Yard access is assigned by Admin.');
  }

  function formHtml() {
    const data = state.data, form = state.form;
    const date = data.request?.serviceDate || data.serviceDate;
    return `<form class="aggregate-form aggregate-requester-form${form.kind === 'report' ? ' aggregate-actual-report' : ''}" data-ag-form>
      <div class="aggregate-form-header">
        <div><h2>${t(titles[form.kind])}</h2><p class="aggregate-stage-help">${stageHelp()}</p></div>
        <label class="aggregate-yard-selector">${t('Assigned yard')}<select data-ag-form-yard aria-label="${t('Assigned yard')}" ${data.yards.length === 1 || state.busy ? 'disabled' : ''}>
          ${data.yards.map(yard => `<option value="${yard.locationId}" ${yard.locationId === data.yardLocationId ? 'selected' : ''}>${yard.yardCode}</option>`).join('')}
        </select></label>
      </div>
      <div class="aggregate-request-grid">${data.materials.map(card).join('')}
        <div class="aggregate-yard-card" data-ag-request-card>
          ${data.request ? `<p class="aggregate-card-hint">${escape(data.request.requestRef)}</p>` : ''}
          ${data.request ? `<p class="aggregate-submitted-at">${t('Submitted at')}<br><time datetime="${escape(data.request.createdAt)}">${escape(window.MBBSAggregateI18n.dateTime(data.request.createdAt))}</time></p>` : ''}
          <p>${t('Delivery / collection')}<strong>${escape(date)}</strong></p>
          ${form.kind === 'report' ? `<p>${t('Actual report due')}<strong>${escape(data.request.reportDueDate)}</strong></p>` : ''}
          ${notes()}<div class="aggregate-actions">
            ${writable() ? `<button class="primary" type="submit" ${state.busy ? 'disabled' : ''}>${t(state.busy ? 'Saving…' : saves[form.kind])}</button>` : ''}
            <button type="button" data-ag-action="reset" ${state.busy ? 'disabled' : ''}>${t('Reload saved loads')}</button>
          </div>
        </div>
      </div></form>`;
  }

  function render() {
    if (!state.actor) { return; }
    document.title = `MBBS ${t('Aggregate Requests')}`;
    mount.innerHTML = `<header class="dispatch-topbar"><div><p>${t('Yard supply and collection')}</p><h1>${t('Aggregate Requests')}</h1></div>
      <div class="topbar-actions"><span class="dispatch-user">${escape(state.actor.display_name || state.actor.username)}</span>
        ${window.MBBS_I18N?.toggleHtml() || ''}<a class="aggregate-menu-link" href="${escape(dispatchRoleHome(state.actor.role))}">${t('Menu')}</a>
        <button type="button" onclick="dispatchLogout()">${t('Logout')}</button></div></header>
      <section class="aggregate-page" data-aggregate-root>
        <div data-ag-feedback role="status">${state.notice ? `<p class="aggregate-notice">${escape(t(state.notice))}</p>` : ''}
          ${state.error ? `<p class="aggregate-notice aggregate-error" role="alert">${escape(t(state.error))}</p>` : ''}</div>
        ${state.form ? formHtml() : state.error ? '' : `<p role="status">${t('Loading aggregate requests…')}</p>`}
      </section>`;
  }

  function acceptSnapshot(data, reset) {
    const previous = state.data;
    const sameStage = state.form && stage(data) === state.form.kind && data.yardLocationId === previous.yardLocationId
      && data.request?.id === previous.request?.id;
    const sameRequest = sameStage && data.request?.revision === previous.request?.revision && data.serviceDate === previous.serviceDate;
    if (!reset && sameStage && state.dirty && !sameRequest) {
      state.error = 'The request changed. Reload saved loads before continuing.';
      render();
      return;
    }
    state.data = data;
    state.yard = String(data.yardLocationId);
    if (!reset && sameRequest) {
      const hadError = Boolean(state.error);
      state.error = '';
      if (hadError || previous.today !== data.today) { render(); }
      return;
    }
    state.error = '';
    initializeForm(data);
    render();
  }

  async function load({ reset = false } = {}) {
    if (!state.actor || state.busy) { return; }
    const generation = ++state.generation;
    try {
      const data = await api(`/api/aggregate-requests/workspace${state.yard ? `?yardLocationId=${state.yard}` : ''}`);
      if (generation !== state.generation) { return; }
      acceptSnapshot(data, reset);
    } catch (error) {
      if (generation !== state.generation) { return; }
      state.error = error.message;
      if (error.status === 401 || error.status === 403) { state.form = null; state.data = null; }
      render();
    }
  }

  async function save(event) {
    event.preventDefault();
    if (state.busy || !writable() || !event.target.reportValidity()) { return; }
    const kind = state.form.kind, row = state.data.request;
    const loads = Object.fromEntries(Object.entries(state.form.loads).map(([key, value]) => [key, Number(value)]));
    const body = kind === 'new' ? { loads, yardLocationId: state.data.yardLocationId, serviceDate: state.data.serviceDate, remarks: state.form.remarks }
      : { loads, expectedRevision: row.revision, ...(kind === 'edit' ? { remarks: state.form.remarks } : {}) };
    const path = `/api/aggregate-requests${kind === 'new' ? '' : `/${row.id}/${kind}`}`;
    const fingerprint = JSON.stringify({ path, body });
    if (state.operation?.fingerprint !== fingerprint) { state.operation = { fingerprint, id: crypto.randomUUID() }; }
    state.busy = true; state.error = ''; state.generation += 1;
    render();
    let saved = false;
    try {
      await api(path, { method: 'POST', body: JSON.stringify({ ...body, operationId: state.operation.id }) });
      state.notice = kind === 'report' ? 'Actual loads reported. You can request again; SCM will review any differences.' : 'Saved.';
      saved = true;
    } catch (error) {
      state.error = error.message;
      if (error.status === 401 || error.status === 403) { state.form = null; state.data = null; }
    } finally {
      state.busy = false;
      if (saved) { await load({ reset: true }); } else { render(); }
    }
  }

  function updateStepper(input) {
    const quantityCard = input.closest('[data-ag-material]');
    quantityCard.querySelector('[data-ag-step="-1"]').disabled = input.value !== '' && Number(input.value) <= 0;
    quantityCard.querySelector('[data-ag-step="1"]').disabled = Number(input.value) >= 1000000000;
  }
  mount.addEventListener('input', event => {
    if (!state.form || state.busy || !writable()) { return; }
    const input = event.target;
    if (!input.matches('[data-ag-load], [data-ag-remarks]')) { return; }
    if (input.dataset.agLoad) { state.form.loads[input.dataset.agLoad] = input.value; updateStepper(input); }
    if (input.matches('[data-ag-remarks]')) { state.form.remarks = input.value; }
    state.dirty = true;
  });
  mount.addEventListener('click', event => {
    if (state.busy) { return; }
    if (event.target.closest('[data-ag-action="reset"]')) { load({ reset: true }); return; }
    const button = event.target.closest('[data-ag-step]');
    if (!button || !writable()) { return; }
    const input = button.closest('[data-ag-material]').querySelector('[data-ag-load]');
    const value = input.value === '' ? 0 : Number(input.value);
    if (!Number.isInteger(value)) { input.reportValidity(); return; }
    input.value = String(Math.max(0, Math.min(1000000000, value + Number(button.dataset.agStep))));
    state.form.loads[input.dataset.agLoad] = input.value;
    state.dirty = true;
    updateStepper(input);
  });
  mount.addEventListener('change', event => {
    if (!event.target.matches('[data-ag-form-yard]') || state.busy) { return; }
    if (state.dirty && !window.confirm(t('Switch yards and discard unsaved loads?'))) { event.target.value = state.yard; return; }
    state.yard = event.target.value;
    load({ reset: true });
  });
  mount.addEventListener('submit', save);
  window.addEventListener('mbbs-language-changed', render);
  window.addEventListener('focus', () => load());
  requireDispatchLogin({ mount, allowPublicSales: false, roles: ['admin', 'sales', 'operator', 'yard_manager'], onReady: async actor => {
    state.actor = actor;
    mount.classList.add('aggregate-shell');
    document.body.classList.add('aggregate-module-active');
    render(); await load();
    state.events = new EventSource('/api/events?client=aggregate-requests');
    state.events.addEventListener('app-event', event => {
      try { if (['aggregate-request.updated', 'operator.access.updated'].includes(JSON.parse(event.data).type)) { load(); } } catch { /* Invalid notification. */ }
    });
  } });
  window.addEventListener('pagehide', () => state.events?.close());
})();

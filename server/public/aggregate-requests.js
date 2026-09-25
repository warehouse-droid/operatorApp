/* global requireDispatchLogin, dispatchCanAccess, dispatchAuthHeaders, dispatchRoleHome */
(() => {
  const state = {
    mount: null, operator: null, scm: false, data: null, detail: null, form: null,
    yard: '', date: '', queue: new URLSearchParams(location.search).get('queue') === 'pending' ? 'pending' : 'all', offset: 0, selectedId: null,
    loading: false, busy: false, error: '', notice: '', existingId: null,
    generation: 0, refreshPending: false, operation: null, events: null, requesterStarted: false
  };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const t = (label, variables) => window.MBBSAggregateI18n?.text(label, variables) || label;
  const active = () => state.mount && (!state.scm || window.MBBSStockRequestTabs?.isActive('aggregate'));
  const manage = () => state.data?.canManage === true;
  const submitter = () => dispatchCanAccess(state.operator, ['admin', 'sales', 'operator', 'yard_manager']);
  const prefix = () => state.scm ? '/api/scm/aggregate-requests' : '/api/aggregate-requests';
  const labels = { submitted: 'Submitted', confirmed: 'Confirmed', reported: 'Reported', rejected: 'Rejected' };
  const actionLabels = { submit: 'Submitted', edit: 'Requested loads edited', confirm: 'Loads confirmed', reject: 'Rejected', report: 'Actuals reported', correct: 'Actuals corrected', acknowledge: 'Difference acknowledged', memo: 'Material memos updated' };
  const formTitles = { new: "Request tomorrow's loads", edit: 'Edit requested loads', confirm: 'Confirm loads', report: 'Report actual loads', correct: 'Correct actual loads', reject: 'Reject request', memo: 'Edit material memos' };
  const formSaves = { new: 'Submit request', edit: 'Save requested loads', confirm: 'Save confirmation', report: 'Submit actual report', correct: 'Save correction', reject: 'Confirm rejection', memo: 'Save material memos' };
  const yardName = id => state.data?.yards.find(yard => yard.locationId === Number(id))?.yardCode || id;
  const blockedAt = yard => state.data?.blockers.filter(row => row.yardLocationId === Number(yard)) || [];
  const dateTime = value => window.MBBSAggregateI18n.dateTime(value);
  const submittedAt = row => `${t('Submitted at')}: <time datetime="${escape(row.createdAt)}">${escape(dateTime(row.createdAt))}</time>`;

  async function api(path, options = {}) {
    const response = await fetch(path, { cache: 'no-store', ...options, headers: dispatchAuthHeaders({
      Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {})
    }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) { throw Object.assign(new Error(payload.error || `Request failed (${response.status}).`), payload, { status: response.status }); }
    return payload;
  }

  function header() {
    return `<header class="dispatch-topbar"><div><p>${t(state.scm ? 'SCM · Stock Requests' : 'Yard supply and collection')}</p><h1>${t('Aggregate Requests')}</h1></div>
      <div class="topbar-actions"><span class="dispatch-user">${escape(state.operator.display_name || state.operator.username)}</span>
      ${window.MBBS_I18N?.toggleHtml() || ''}
      <a class="aggregate-menu-link" href="${state.scm ? '/scm' : escape(dispatchRoleHome(state.operator.role))}">${t(state.scm ? 'SCM Menu' : 'Menu')}</a>
      <button type="button" onclick="dispatchLogout()">${t('Logout')}</button></div></header>`;
  }

  function yardOptions(selected, all = false) {
    return `${all ? `<option value="">${t('All yards')}</option>` : ''}${(state.data?.yards || []).map(yard =>
      `<option value="${yard.locationId}" ${Number(selected) === yard.locationId ? 'selected' : ''}>${escape(yard.yardCode)}</option>`
    ).join('')}`;
  }

  function queues() {
    if (!state.scm) { return ''; }
    return `<div class="aggregate-queues" aria-label="${t('Aggregate queues')}">${[
      ['pending', 'Pending'], ['awaiting_actuals', 'Awaiting Actuals'],
      ['needs_review', 'Needs Review ({count})'], ['history', 'History'], ['all', 'All']
    ].map(([key, label]) => `<button type="button" data-ag-queue="${key}" aria-pressed="${state.queue === key}" ${state.form ? 'disabled' : ''}>${t(label, { count: state.data?.needsReviewCount || 0 })}</button>`).join('')}</div>`;
  }

  function blockers() {
    const rows = state.data?.blockers || [];
    if (!rows.length) { return ''; }
    return `<section class="aggregate-notice aggregate-warning" aria-label="${t('Overdue requests')}"><strong>${t('Resolve your overdue requests before requesting again at that yard.')}</strong>${rows.map(row =>
      `<p>${escape(t('Yard {yard}', { yard: yardName(row.yardLocationId) }))} · ${escape(row.serviceDate)} · ${t(row.status === 'submitted' ? 'Awaiting SCM confirmation or rejection' : 'Actual loads required')}
      <button type="button" data-ag-select="${row.id}" ${state.form ? 'disabled' : ''}>${escape(t('Open {reference}', { reference: row.requestRef }))}</button></p>`
    ).join('')}</section>`;
  }

  function list() {
    const rows = state.data?.requests || [];
    if (!rows.length) { return `<p class="aggregate-empty">${t('No requests match these filters.')}</p>`; }
    return rows.map(row => `<button type="button" class="aggregate-card" data-ag-select="${row.id}" aria-current="${state.selectedId === row.id}" ${state.form ? 'disabled' : ''}>
      <strong>${escape(t('Yard {yard}', { yard: yardName(row.yardLocationId) }))} · ${escape(row.serviceDate)}</strong>
      <span>${escape(row.requestRef)} · <span class="aggregate-pill">${t(labels[row.status])}</span></span>
      <small>${escape(row.requestedByName)}</small>
      <small class="aggregate-submitted-at">${submittedAt(row)}</small>
      ${row.needsReview ? `<span class="aggregate-pill review">${t('Needs Review')}</span>` : ''}
      ${['submitted', 'confirmed'].includes(row.status) && row.reportDueDate <= state.data.today ? `<span class="aggregate-short">${t(row.status === 'submitted' ? 'Overdue · awaiting SCM' : 'Actual report overdue')}</span>` : ''}
      </button>`).join('');
  }

  function variance(line) {
    if (line.actualLoads === null || line.confirmedLoads === null) { return '—'; }
    const difference = line.actualLoads - line.confirmedLoads;
    if (difference < 0) { return `<span class="aggregate-short">${t('{count} short', { count: -difference })}</span>`; }
    if (difference > 0) { return `<span class="aggregate-extra">${t('{count} extra', { count: difference })}</span>`; }
    return t('Matched');
  }

  function comparison(row, memos = null) {
    return `<div class="aggregate-table-wrap" role="region" aria-label="${t('Material load quantities')}" tabindex="0"><table class="aggregate-table"><caption>${t('Loads by material')}</caption>
      <thead><tr>${['Material', 'Requested', 'Confirmed', 'Actual', 'Difference', 'SCM memo'].map(label => `<th scope="col">${t(label)}</th>`).join('')}</tr></thead>
      <tbody>${row.lines.map(line => {
        const material = state.data.materials.find(item => item.code === line.materialCode);
        return `<tr><th scope="row">${escape(t(material.label))}<small>${t(material.direction === 'inbound' ? 'Inbound · received' : 'Outbound · collected')}</small></th>
          <td>${line.requestedLoads}</td><td>${line.confirmedLoads ?? '—'}</td><td>${line.actualLoads ?? '—'}</td><td>${variance(line)}</td>
          <td class="aggregate-memo-cell">${memos
            ? `<textarea data-ag-memo="${material.code}" aria-label="${escape(t('{material} SCM memo', { material: t(material.label) }))}" maxlength="2000" rows="2">${escape(memos[material.code])}</textarea>`
            : `<span data-ag-memo-value="${material.code}">${escape(line.scmMemo || '—')}</span>`}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }

  function detailActions(row) {
    const owner = row.requestedBy === state.operator.id;
    const buttons = [];
    const add = (action, label) => buttons.push(`<button type="button" data-ag-action="${action}">${t(label)}</button>`);
    if (row.status === 'submitted' && owner) { add('edit', 'Edit requested loads'); }
    if (manage() && ['submitted', 'confirmed'].includes(row.status)) { add('confirm', row.status === 'submitted' ? 'Confirm loads' : 'Revise confirmation'); }
    if (manage() && row.status === 'submitted') { add('reject', 'Reject request'); }
    if (manage()) { add('memo', 'Edit material memos'); }
    if (row.status === 'confirmed' && (owner || manage())) { add('report', 'Report actual loads'); }
    if (manage() && row.status === 'reported') {
      if (row.needsReview) { add('acknowledge', 'Acknowledge difference'); }
      add('correct', 'Correct actual loads');
    }
    return `<div class="aggregate-actions">${buttons.join('')}</div>`;
  }

  function detail() {
    const row = state.detail;
    if (!row) { return `<div class="aggregate-empty">${t('Select a request to see confirmed and actual loads.')}</div>`; }
    return `<div data-ag-detail><h2>${escape(row.requestRef)} · ${escape(t('Yard {yard}', { yard: yardName(row.yardLocationId) }))}</h2>
      <p><span class="aggregate-pill">${t(labels[row.status])}</span> ${row.needsReview ? `<span class="aggregate-pill review">${t('Needs Review')}</span>` : ''}</p>
      <p>${t('Delivery / collection')}: <strong>${escape(row.serviceDate)}</strong><br>${t('Actual report due')}: <strong>${escape(row.reportDueDate)}</strong></p>
      <p class="aggregate-muted">${escape(t('Requested by {name}', { name: row.requestedByName }))}</p>
      <p class="aggregate-submitted-at">${submittedAt(row)}</p>
      ${row.remarks ? `<p><strong>${t('Remarks')}:</strong> ${escape(row.remarks)}</p>` : ''}
      ${row.decisionReason ? `<p><strong>${t('SCM reason')}:</strong> ${escape(row.decisionReason)}</p>` : ''}
      ${row.acknowledgedAt ? `<p class="aggregate-notice">${t('Difference acknowledged by SCM.')}</p>` : ''}
      ${detailActions(row)}${comparison(row)}
      <details><summary>${t('Request history')}</summary><ol class="aggregate-history">${(row.events || []).map(event =>
        `<li><strong>${t(actionLabels[event.action])}</strong> · ${escape(event.actorName)}<br><small>${escape(dateTime(event.createdAt))}</small>${dateChange(event)}${event.reason ? `<p>${escape(event.reason)}</p>` : ''}</li>`
      ).join('')}</ol></details></div>`;
  }

  function dateChange(event) {
    const before = event.before?.serviceDate, after = event.after?.serviceDate;
    return before && after && before !== after
      ? `<p data-ag-date-change>${t('Delivery / collection')}: ${escape(before)} → ${escape(after)}</p>` : '';
  }

  function reportDueDate(serviceDate) {
    const date = new Date(`${serviceDate}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || serviceDate < '0001-01-01' || serviceDate > '9999-12-30') { return '—'; }
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  }

  function confirmationDate(form) {
    return `<label>${t('Delivery / collection date')}<input type="date" data-ag-service-date aria-label="${t('Delivery / collection date')}" required min="0001-01-01" max="9999-12-30" value="${escape(form.serviceDate)}" /></label>
      <p>${t('Actual report due')}: <strong data-ag-report-due>${escape(reportDueDate(form.serviceDate))}</strong></p>`;
  }

  function loadFields(form) {
    if (form.kind === 'reject') { return ''; }
    return ['inbound', 'outbound'].map(direction => `<fieldset><legend>${t(direction === 'inbound' ? 'Inbound · stock deliveries' : 'Outbound · dump collections')} · ${t('loads')}</legend>
      <div class="aggregate-load-grid">${state.data.materials.filter(material => material.direction === direction).map(material =>
        `<label><span>${escape(t(material.label))}</span><input name="${material.code}" data-ag-load="${material.code}" aria-label="${escape(t('{material} loads', { material: t(material.label) }))}" type="number" min="0" max="1000000000" step="1" inputmode="numeric" required value="${escape(form.loads[material.code])}" /></label>`
      ).join('')}</div></fieldset>`).join('');
  }

  function formNotes(form) {
    if (['new', 'edit'].includes(form.kind)) {
      return `<label>${t('Remarks (optional)')}<textarea data-ag-remarks aria-label="${t('Remarks (optional)')}" maxlength="2000" rows="2">${escape(form.remarks)}</textarea></label>`;
    }
    return ['correct', 'reject'].includes(form.kind)
      ? `<label>${t('Reason')}<textarea data-ag-reason aria-label="${t('Reason')}" maxlength="2000" required rows="2">${escape(form.reason)}</textarea></label>` : '';
  }

  function saveControls(form, blocked) {
    return `<div class="aggregate-actions"><button class="primary" type="submit" ${blocked ? 'disabled' : ''}>${t(state.busy ? 'Saving…' : formSaves[form.kind])}</button>
      <button type="button" data-ag-action="cancel">${t('Cancel')}</button></div>`;
  }

  function reportHelp(form) {
    return ['report', 'correct'].includes(form.kind) ? `<p>${t('Enter loads received for stock items and loads collected for dump items. Enter 0 when none moved.')}</p>` : '';
  }

  function quantityCard(form, material) {
    const value = form.loads[material.code];
    const label = t(material.label);
    const actual = ['report', 'correct'].includes(form.kind);
    const countLabel = actual ? (material.direction === 'inbound' ? 'Loads received' : 'Loads collected') : 'Loads required';
    return `<div class="aggregate-quantity-card ${material.direction}" data-ag-request-card data-ag-material="${material.code}">
      <span class="aggregate-card-direction">${t(material.direction === 'inbound' ? 'Inbound · stock deliveries' : 'Outbound · dump collections')}</span>
      <label for="ag-load-${material.code}">${escape(label)}</label><span class="aggregate-count-label">${t(countLabel)}</span>
      <div class="aggregate-stepper" role="group" aria-label="${escape(t('{material} load controls', { material: label }))}">
        <button type="button" data-ag-step="-1" aria-label="${escape(t('Decrease {material} loads', { material: label }))}" ${value !== '' && Number(value) <= 0 ? 'disabled' : ''}>−</button>
        <input id="ag-load-${material.code}" name="${material.code}" data-ag-load="${material.code}" aria-label="${escape(t('{material} loads', { material: label }))}" type="number" min="0" max="1000000000" step="1" inputmode="numeric" required value="${escape(value)}" />
        <button type="button" data-ag-step="1" aria-label="${escape(t('Increase {material} loads', { material: label }))}" ${Number(value) >= 1000000000 ? 'disabled' : ''}>+</button>
      </div>
    </div>`;
  }

  function requesterForm(form, blocked) {
    const yard = form.kind === 'new'
      ? `<label>${t('Assigned yard')}<select data-ag-form-yard aria-label="${t('Assigned yard')}" ${state.data.yards.length === 1 ? 'disabled' : ''}>${yardOptions(form.yard)}</select></label>`
      : `<p class="aggregate-fixed-yard">${escape(t('Yard {yard}', { yard: yardName(form.yard) }))}</p>`;
    return `<form class="aggregate-form aggregate-requester-form" data-ag-form><h2>${t(formTitles[form.kind])}</h2>${reportHelp(form)}
      <fieldset ${state.busy ? 'disabled' : ''}><div class="aggregate-request-grid">
        ${state.data.materials.map(material => quantityCard(form, material)).join('')}
        <div class="aggregate-yard-card" data-ag-request-card>${yard}
          <p class="aggregate-card-hint">${t('Yard access is assigned by Admin.')}</p>
          <p>${t('Delivery / collection')}<strong>${escape(form.serviceDate)}</strong></p>
          ${blocked ? `<p class="aggregate-notice aggregate-warning">${t('Resolve your overdue requests for this yard before submitting.')}</p>` : ''}
          ${formNotes(form)}${saveControls(form, blocked)}
        </div>
      </div></fieldset></form>`;
  }

  function formView() {
    const form = state.form;
    const blocked = form.kind === 'new' && blockedAt(form.yard).length > 0;
    if (!state.scm && form.kind !== 'reject') { return requesterForm(form, blocked); }
    return `<form class="aggregate-form" data-ag-form><h2>${t(formTitles[form.kind])}</h2>
      ${state.detail ? `<p class="aggregate-submitted-at">${submittedAt(state.detail)}</p>` : ''}
      ${form.kind === 'confirm' ? '' : `<p>${t('Delivery / collection')}: <strong>${escape(form.serviceDate)}</strong></p>`}
      <p>${escape(t('Yard {yard}', { yard: yardName(form.yard) }))}</p>${reportHelp(form)}
      <fieldset ${state.busy ? 'disabled' : ''}>${form.kind === 'confirm' ? confirmationDate(form) : ''}${form.kind === 'memo' ? comparison(state.detail, form.memos) : loadFields(form)}${formNotes(form)}${saveControls(form, blocked)}</fieldset></form>`;
  }

  function toolbar() {
    return `<div class="aggregate-toolbar"><p>${t('Whole loads · Toronto calendar dates')}</p><div class="aggregate-actions">
      ${!state.scm && submitter() ? `<button type="button" class="primary" data-ag-action="new" ${!state.data || state.form || state.loading ? 'disabled' : ''}>${t("Request tomorrow's loads")}</button>` : ''}
      <button type="button" data-ag-action="refresh" ${state.loading ? 'disabled' : ''}>${t('Refresh')}</button></div></div>`;
  }

  function feedback() {
    return `<div data-ag-feedback role="status">${state.notice ? `<p class="aggregate-notice">${escape(t(state.notice))}</p>` : ''}${state.error ? `<p class="aggregate-notice aggregate-error" role="alert">${escape(t(state.error))}${state.existingId ? ` <button type="button" data-ag-existing="${state.existingId}">${t('Open existing request')}</button>` : ''}${state.form ? ` <button type="button" data-ag-action="cancel">${t('Discard edits and refresh')}</button>` : ''}</p>` : ''}</div>`;
  }

  function filters() {
    return `<div class="aggregate-filters"><label>${t('Filter yard')}<select data-ag-filter="yard" ${state.form ? 'disabled' : ''}>${yardOptions(state.yard, true)}</select></label>
      <label>${t('Delivery / collection date')}<input type="date" data-ag-filter="date" value="${escape(state.date)}" ${state.form ? 'disabled' : ''} /></label>
      <button type="button" data-ag-action="clear-filters" ${state.form ? 'disabled' : ''}>${t('Clear filters')}</button></div>`;
  }

  function requestList() {
    return `${list()}<div class="aggregate-actions"><button type="button" data-ag-action="previous" ${!state.offset || state.form ? 'disabled' : ''}>${t('Previous')}</button>
      <button type="button" data-ag-action="next" ${!state.data?.hasMore || state.form ? 'disabled' : ''}>${t('Next')}</button></div>`;
  }

  function workspace() {
    if (!state.scm && state.form) { return formView(); }
    const requests = state.scm
      ? `<aside class="aggregate-list" aria-label="${t('Aggregate Requests')}">${requestList()}</aside>`
      : `<section class="aggregate-request-history"><h2>${t('Requests & reports')}</h2><div class="aggregate-list">${requestList()}</div></section>`;
    return `<div class="aggregate-workspace">${requests}<section class="aggregate-panel" aria-label="${t('Request details')}">${state.form ? formView() : detail()}</section></div>`;
  }

  function render() {
    if (!active()) { return; }
    const restoreTabFocus = window.MBBSStockRequestTabs?.preserveFocus();
    const requesting = !state.scm && state.form;
    if (!state.scm) { document.title = `MBBS ${t('Aggregate Requests')}`; }
    state.mount.innerHTML = `${header()}${state.scm ? window.MBBSStockRequestTabs.html() : ''}<section class="aggregate-page" data-aggregate-root>
      ${requesting ? '' : toolbar()}${feedback()}${requesting ? '' : blockers() + queues() + filters()}
      ${state.loading && !state.data ? `<p role="status">${t('Loading aggregate requests…')}</p>` : ''}
      ${workspace()}</section>`;
    restoreTabFocus?.();
  }

  function deferRefresh() {
    state.refreshPending = true;
    const target = active() && state.mount.querySelector('[data-ag-feedback]');
    if (target && !state.error) { target.textContent = t('Updates are available. Finish or cancel your form to refresh.'); }
  }

  const currentLoad = generation => generation === state.generation && active();
  function finishLoad(generation) {
    if (generation !== state.generation) { return; }
    state.loading = false;
    if (!state.scm && !state.requesterStarted && state.data) {
      state.requesterStarted = true;
      if (submitter() && !state.data.blockers.length) { startForm('new'); return; }
    }
    if (!state.form && !state.busy) { render(); }
  }

  async function load({ background = false } = {}) {
    if (!active()) { return; }
    if (state.form || state.busy) { deferRefresh(); return; }
    const generation = ++state.generation;
    state.loading = true;
    if (!background) { state.detail = null; render(); }
    try {
      const params = new URLSearchParams({ queue: state.queue, offset: String(state.offset) });
      if (state.yard) { params.set('yardLocationId', state.yard); }
      if (state.date) { params.set('serviceDate', state.date); }
      const data = await api(`${prefix()}?${params}`);
      const selectedId = state.selectedId || data.requests[0]?.id || null;
      const selected = selectedId ? await api(`${prefix()}/${selectedId}`) : null;
      if (!currentLoad(generation)) { return; }
      if (state.form || state.busy) { deferRefresh(); return; }
      state.data = data;
      state.selectedId = selectedId;
      state.detail = selected;
      state.refreshPending = false;
      state.error = '';
    } catch (error) {
      if (currentLoad(generation)) { state.error = error.message; }
    } finally {
      finishLoad(generation);
    }
  }

  function startForm(kind) {
    if (!state.data || state.form || state.busy) { return; }
    state.generation += 1;
    state.loading = false;
    const row = state.detail;
    const yard = kind === 'new' ? Number(state.yard || state.data.yards[0]?.locationId) : row.yardLocationId;
    const field = { edit: 'requestedLoads', confirm: 'confirmedLoads', correct: 'actualLoads' }[kind];
    const loads = Object.fromEntries(state.data.materials.map(material => {
      const line = row?.lines.find(item => item.materialCode === material.code);
      const value = ['report', 'new'].includes(kind) ? 0 : line?.[field] ?? line?.requestedLoads ?? 0;
      return [material.code, String(value)];
    }));
    const memos = Object.fromEntries((row?.lines || []).map(line => [line.materialCode, line.scmMemo || '']));
    state.form = { kind, yard, loads, memos, remarks: kind === 'new' ? '' : row.remarks, reason: '',
      serviceDate: kind === 'new' ? state.data.serviceDate : row.serviceDate,
      requestId: kind === 'new' ? null : row.id, expectedRevision: kind === 'new' ? null : row.revision };
    state.error = '';
    state.notice = '';
    state.existingId = null;
    state.operation = null;
    render();
    state.mount.querySelector('[data-ag-form]')?.scrollIntoView({ block: 'nearest' });
  }

  function commandBody(form) {
    const body = {};
    if (!['reject', 'memo'].includes(form.kind)) {
      if (Object.values(form.loads).some(value => String(value).trim() === '')) { throw new Error('Enter loads for every material, including zero.'); }
      body.loads = Object.fromEntries(Object.entries(form.loads).map(([key, value]) => [key, Number(value)]));
    }
    if (form.kind === 'new') {
      Object.assign(body, { yardLocationId: form.yard, serviceDate: form.serviceDate, remarks: form.remarks });
    } else { body.expectedRevision = form.expectedRevision; }
    if (form.kind === 'edit') { body.remarks = form.remarks; }
    if (form.kind === 'confirm') { body.serviceDate = form.serviceDate; }
    if (form.kind === 'memo') { body.memos = form.memos; }
    if (['correct', 'reject'].includes(form.kind)) { body.reason = form.reason; }
    return body;
  }

  async function write(action, requestId, body) {
    const apiRoot = manage() && action !== 'edit' && action !== 'new' ? '/api/scm/aggregate-requests' : '/api/aggregate-requests';
    const path = action === 'new' ? apiRoot : `${apiRoot}/${requestId}/${action}`;
    const fingerprint = JSON.stringify({ path, body });
    if (state.operation?.fingerprint !== fingerprint) { state.operation = { fingerprint, id: crypto.randomUUID() }; }
    state.busy = true;
    state.error = '';
    render();
    try {
      const saved = await api(path, { method: 'POST', body: JSON.stringify({ ...body, operationId: state.operation.id }) });
      state.form = null;
      state.operation = null;
      state.selectedId = saved.id;
      state.notice = action === 'report' ? 'Actual loads reported. You can request again; SCM will review any differences.' : 'Saved.';
    } catch (error) {
      state.error = error.message;
      state.existingId = error.requestId || null;
    } finally {
      state.busy = false;
      if (state.error) { render(); } else { await load(); }
    }
  }

  function updateStepper(input) {
    const card = input.closest('[data-ag-material]');
    if (!card) { return; }
    card.querySelector('[data-ag-step="-1"]').disabled = input.value !== '' && Number(input.value) <= 0;
    card.querySelector('[data-ag-step="1"]').disabled = Number(input.value) >= 1000000000;
  }

  function stepLoads(button) {
    if (!state.form) { return; }
    const input = button.closest('[data-ag-material]').querySelector('[data-ag-load]');
    const amount = input.value === '' ? 0 : Number(input.value);
    if (!Number.isInteger(amount) || !Number.isFinite(amount)) { input.reportValidity(); return; }
    const next = Math.max(0, Math.min(1000000000, amount + Number(button.dataset.agStep)));
    input.value = String(next);
    state.form.loads[input.dataset.agLoad] = input.value;
    updateStepper(input);
  }

  async function click(event) {
    if (!active() || state.busy) { return; }
    const step = event.target.closest('[data-ag-step]');
    if (step) { stepLoads(step); return; }
    const button = event.target.closest('[data-ag-action], [data-ag-select], [data-ag-queue], [data-ag-existing]');
    if (!button) { return; }
    if (button.dataset.agExisting) {
      state.form = null;
      state.selectedId = Number(button.dataset.agExisting);
      return load();
    }
    if (button.dataset.agSelect && !state.form) {
      state.selectedId = Number(button.dataset.agSelect);
      return load();
    }
    if (button.dataset.agQueue && !state.form) {
      state.queue = button.dataset.agQueue;
      state.offset = 0;
      state.selectedId = null;
      return load();
    }
    const action = button.dataset.agAction;
    if (['new', 'edit', 'confirm', 'report', 'correct', 'reject', 'memo'].includes(action)) { return startForm(action); }
    if (action === 'acknowledge') { return write(action, state.detail.id, { expectedRevision: state.detail.revision }); }
    if (action === 'cancel') { state.form = null; state.operation = null; state.error = ''; }
    if (action === 'clear-filters') { state.yard = ''; state.date = ''; state.offset = 0; state.selectedId = null; }
    if (action === 'next' || action === 'previous') { state.offset += action === 'next' ? 50 : -50; state.selectedId = null; }
    await load();
  }

  function bind(mount) {
    mount.addEventListener('click', event => click(event).catch(error => { state.error = error.message; render(); }));
    mount.addEventListener('input', event => {
      if (!active() || !state.form) { return; }
      if (event.target.matches('[data-ag-service-date]')) {
        state.form.serviceDate = event.target.value;
        mount.querySelector('[data-ag-report-due]').textContent = reportDueDate(state.form.serviceDate);
      }
      if (event.target.dataset.agLoad) { state.form.loads[event.target.dataset.agLoad] = event.target.value; updateStepper(event.target); }
      if (event.target.matches('[data-ag-remarks]')) { state.form.remarks = event.target.value; }
      if (event.target.matches('[data-ag-reason]')) { state.form.reason = event.target.value; }
      if (event.target.dataset.agMemo) { state.form.memos[event.target.dataset.agMemo] = event.target.value; }
    });
    mount.addEventListener('change', event => {
      if (!active()) { return; }
      if (event.target.matches('[data-ag-form-yard]')) { state.form.yard = Number(event.target.value); render(); }
      if (event.target.dataset.agFilter && !state.form) {
        state[event.target.dataset.agFilter] = event.target.value;
        state.offset = 0;
        state.selectedId = null;
        load();
      }
    });
    mount.addEventListener('submit', event => {
      if (!event.target.matches('[data-ag-form]') || !active()) { return; }
      event.preventDefault();
      if (state.busy || !state.form || !event.target.reportValidity()) { return; }
      try { write(state.form.kind, state.form.requestId, commandBody(state.form)); }
      catch (error) { state.error = error.message; render(); }
    });
  }

  function connectEvents() {
    if (!('EventSource' in window) || state.events) { return; }
    state.events = new EventSource('/api/events?client=aggregate-requests');
    state.events.addEventListener('app-event', message => {
      try {
        if (JSON.parse(message.data).type === 'aggregate-request.updated' && active()) { load({ background: true }); }
      } catch { /* Ignore unrelated invalidation messages. */ }
    });
  }

  window.MBBSAggregateRequests = {
    async open({ mount, operator, scm = false }) {
      if (state.mount !== mount) { bind(mount); }
      state.mount = mount;
      state.operator = operator;
      state.scm = scm;
      mount.classList.add('aggregate-shell');
      document.body.classList.add('aggregate-module-active');
      render();
      await load();
      connectEvents();
    }
  };
  window.addEventListener('focus', () => { if (active()) { load({ background: true }); } });
  window.addEventListener('mbbs-language-changed', () => { if (active()) { render(); } });
  window.addEventListener('mbbs-stock-request-tab-changed', () => { state.generation += 1; state.loading = false; });
  window.addEventListener('pagehide', () => { state.events?.close(); state.events = null; });
  const standalone = document.getElementById('aggregateRequestApp');
  if (standalone) {
    requireDispatchLogin({ mount: standalone, allowPublicSales: false, roles: ['admin', 'sales', 'operator', 'yard_manager', 'scm', 'scm_staff'],
      onReady: operator => window.MBBSAggregateRequests.open({ mount: standalone, operator }) });
  }
})();

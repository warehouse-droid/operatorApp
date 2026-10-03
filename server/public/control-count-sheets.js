(function (root) {
  'use strict';
  const t = (key, fallback) => root.MBBS_I18N?.t(`inventory.${key}`, fallback) || fallback;
  const status = value => t(`status.${value}`, ({available:'Available', in_progress:'In progress', submitted:'Submitted', cancelled:'Cancelled'})[value] || value);
  const qty = value => (value === null || value === undefined) ? '—' : Number(value).toLocaleString(undefined, {maximumFractionDigits:6});
  const date = value => value ? new Date(value).toLocaleString(undefined, {timeZone:'America/Toronto'}) : '—';

  function create(ctx) {
    const esc = ctx.escape;
    let yards = [], rows = [], locationId = '', detail = null, draft = null, busy = false, error = '';
    let suggestions = [], search = '', timer, searchVersion = 0;
    const request = (path, body) => ctx.request(`/api/control/count-sheets${path}`, body === undefined ? undefined : {method:'POST', body:JSON.stringify(body)});
    const button = (action, label, extra = '') => `<button type="button" data-sheet-action="${action}" ${busy ? 'disabled' : ''} ${extra}>${label}</button>`;
    const yardName = id => yards.find(yard => Number(yard.id) === Number(id))?.name || id;

    async function load() {
      busy = true; error = ''; ctx.render();
      try {
        yards = (await request('/config')).yards;
        locationId = locationId || String(yards[0]?.id || '');
        rows = locationId ? await request(`?locationId=${locationId}`) : [];
        if (detail) { detail = await request(`/${detail.id}`); }
      } catch (failure) { error = failure.message; }
      finally { busy = false; ctx.render(); }
    }
    function render() {
      return `<section class="panel count-sheet-control"><div class="count-sheet-toolbar"><div><h2>${t('sheetsTitle','Count sheets')}</h2><p>${t('controlHelp','Assign specific SKUs to a yard. The first operator to take a sheet owns the count.')}</p></div>
        <label>${t('yard','Yard')} <select data-sheet-yard ${busy || draft ? 'disabled' : ''}>${yards.map(yard => `<option value="${yard.id}" ${String(yard.id) === String(locationId) ? 'selected' : ''}>${esc(yard.name)}</option>`).join('')}</select></label>
        ${button('new',t('newSheet','New count sheet'),!locationId ? 'disabled' : '')}</div>
        ${error ? `<p class="count-sheet-error" role="alert">${esc(error)}</p>` : ''}
        ${draft ? renderDraft() : `<div class="count-sheet-control-grid"><aside class="count-sheet-list">${rows.map(row => `<button type="button" data-sheet-action="open" data-id="${row.id}" class="${detail?.id === row.id ? 'active' : ''}"><strong>${esc(row.title)}</strong><span>${esc(status(row.status))} · ${row.counted}/${row.total}</span><span>${esc(row.owner_name || '')}</span></button>`).join('') || `<p>${busy ? t('loading','Loading…') : t('noSheets','No count sheets assigned to this yard.')}</p>`}</aside><section data-sheet-detail>${detail ? renderDetail() : `<p>${t('selectSheet','Select a count sheet to review its counts and history.')}</p>`}</section></div>`}
      </section>`;
    }
    function renderDraft() {
      return `<section class="count-sheet-editor"><h3>${draft.id ? t('editSheet','Edit count sheet') : t('newSheet','New count sheet')} · ${esc(yardName(locationId))}</h3>
        <label for="sheetTitle">${t('title','Title')}</label><input id="sheetTitle" maxlength="160" value="${esc(draft.title)}" ${busy ? 'disabled' : ''}>
        <label for="sheetSearch">${t('searchSku','Search SKU')}</label><input id="sheetSearch" data-sheet-search autocomplete="off" value="${esc(search)}" ${busy ? 'disabled' : ''}>
        <div class="count-sheet-suggestions" data-sheet-suggestions>${suggestionHtml()}</div>
        <p>${draft.items.length} ${t('skus','SKUs')}</p><div class="count-sheet-assigned">${draft.items.map(item => `<div><span><strong>${esc(item.item_name)}</strong> ${esc(item.item_description || '')}</span>${button('remove',t('remove','Remove'),`data-id="${item.item_id}"`)}</div>`).join('')}</div>
        <div class="count-sheet-toolbar">${button('save',t('saveSheet','Save count sheet'),!draft.items.length ? 'disabled' : '')}${button('discard',t('back','Back'))}</div></section>`;
    }
    function suggestionHtml() {
      return suggestions.filter(item => !draft?.items.some(chosen => String(chosen.item_id) === String(item.item_id))).map(item => button('add',`<strong>${esc(item.item_name)}</strong> ${esc(item.item_description || '')}`,`data-id="${item.item_id}"`)).join('');
    }
    function renderDetail() {
      return `<h3>${esc(detail.title)}</h3><p><strong data-sheet-status>${esc(status(detail.status))}</strong> · ${detail.counted}/${detail.total} ${t('counted','counted')}</p>
        <p>${t('operator','Operator')}: ${esc(detail.owner_name || '—')} · ${t('attempt','Attempt')}: ${detail.attempt}</p>
        <div class="count-sheet-toolbar">${detail.status === 'available' ? button('edit',t('editSheet','Edit count sheet')) : ''}${detail.status === 'in_progress' ? button('reset',t('resetSheet','Reset and release sheet')) : ''}${['available','in_progress'].includes(detail.status) ? button('cancel',t('cancelSheet','Cancel sheet')) : ''}</div>
        <p>${t('packedReviewHelp','Actual on hand = On hand − Packed. Var = Counted − Actual on hand. These comparisons do not change stock. Older counts without a packed snapshot show —.')}</p>
        <div class="count-sheet-table"><table><thead><tr><th>SKU</th><th>${t('uom','UOM')}</th><th>${t('onHand','On hand')}</th><th>${t('packed','Packed')}</th><th>${t('actualOnHand','Actual on hand')}</th><th>${t('counted','Counted')}</th><th>${t('var','Var')}</th><th>${t('snapshot','Inventory snapshot')}</th></tr></thead><tbody>${detail.items.map(item => `<tr><td><strong>${esc(item.item_name)}</strong><small>${esc(item.item_description || '')}</small></td><td>${esc(item.count?.unit || item.stock_unit || '')}</td><td>${qty(item.count?.system_on_hand)}</td><td>${qty(item.count?.packed_qty)}</td><td>${qty(item.count?.actual_on_hand)}</td><td>${item.count ? qty(item.count.quantity) : t('uncounted','Uncounted')}</td><td>${qty(item.count?.variance)}</td><td>${item.count?.comparison_basis === 'reconstructed_current' ? `<strong>${t('currentReconstruction','Current reconstruction')}</strong><br>` : ''}${esc(date(item.count?.inventory_synced_at))}${item.count?.packed_snapshot_at ? `<small>${t('packed','Packed')}: ${esc(date(item.count.packed_snapshot_at))}</small>` : ''}</td></tr>`).join('')}</tbody></table></div>
        ${detail.attempts?.length ? `<details><summary>${t('previousCounts','Previous attempts (archived counts)')}</summary><div class="count-sheet-table"><table><thead><tr><th>${t('attempt','Attempt')}</th><th>SKU</th><th>${t('counted','Counted')}</th><th>${t('operator','Operator')}</th></tr></thead><tbody>${detail.attempts.map(count => `<tr><td>${count.attempt}</td><td>${esc(count.item_name)}</td><td>${qty(count.quantity)} ${esc(count.unit)}</td><td>${esc(count.operator_name)}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
        <details><summary>${t('history','Activity history')}</summary><ol>${(detail.history || []).map(entry => `<li>${esc(date(entry.created_at))} · ${esc(entry.actor_name || '')} · ${esc(t(`event.${entry.action}`,entry.action))} · ${t('attempt','Attempt')} ${entry.attempt}</li>`).join('')}</ol></details>`;
    }
    async function searchItems() {
      const version = ++searchVersion;
      try {
        const result = search.trim() ? await request(`/catalog?locationId=${locationId}&search=${encodeURIComponent(search)}`) : [];
        if (version !== searchVersion || !draft) { return; }
        suggestions = result;
        const box = ctx.root.querySelector('[data-sheet-suggestions]');
        if (box) { box.innerHTML = suggestionHtml(); }
      } catch (failure) { error = failure.message; ctx.render(); }
    }
    async function run(action, target) {
      if (action === 'new') {
        draft = {requestId:crypto.randomUUID(), title:'', items:[]}; search = ''; suggestions = []; return;
      }
      if (action === 'open') { detail = await request(`/${target.dataset.id}`); return; }
      if (action === 'edit') { draft = {...detail, items:[...detail.items]}; search = ''; suggestions = []; return; }
      if (action === 'discard') { draft = null; searchVersion++; return; }
      if (action === 'add') {
        const item = suggestions.find(row => String(row.item_id) === target.dataset.id);
        if (item && !draft.items.some(row => row.item_id === item.item_id)) { draft.items.push(item); }
        search = ''; suggestions = []; searchVersion++; return;
      }
      if (action === 'remove') { draft.items = draft.items.filter(row => String(row.item_id) !== target.dataset.id); return; }
      if (action === 'save') {
        detail = await request(draft.id ? `/${draft.id}/edit` : '', {requestId:draft.requestId, revision:draft.revision, title:draft.title, locationId:Number(locationId), itemIds:draft.items.map(item => item.item_id)});
        draft = null;
      }
      if (action === 'reset' || action === 'cancel') {
        const prompt = action === 'reset' ? t('resetConfirm','Archive the current counts and release this sheet for another operator?') : t('cancelConfirm','Cancel this unfinished count sheet?');
        if (!root.confirm(prompt)) { return; }
        detail = await request(`/${detail.id}/${action}`, {revision:detail.revision});
      }
      rows = await request(`?locationId=${locationId}`);
    }
    ctx.root.addEventListener('click', async event => {
      const target = event.target.closest('[data-sheet-action]');
      if (!target) { return; }
      event.stopImmediatePropagation();
      if (busy) { return; }
      busy = true; error = '';
      try { await run(target.dataset.sheetAction, target); }
      catch (failure) { error = failure.message; }
      finally { busy = false; ctx.render(); }
    }, true);
    ctx.root.addEventListener('input', event => {
      if (event.target.id === 'sheetTitle' && draft) { draft.title = event.target.value; }
      if (event.target.matches('[data-sheet-search]')) { search = event.target.value; clearTimeout(timer); timer = setTimeout(searchItems,250); }
    });
    ctx.root.addEventListener('change', event => {
      if (event.target.matches('[data-sheet-yard]')) { locationId = event.target.value; detail = null; void load(); }
    });
    return {load,render};
  }
  root.MBBSControlCountSheets = {create};
})(window);

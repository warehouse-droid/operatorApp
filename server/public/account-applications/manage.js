// Account applications for the staff who create them (Sales, MBT front desk, MBR sales,
// Field sales). Mounted inside each role's own menu; card and driver's-licence
// details are never shown here.
const STATUS_LABELS = { sent: 'Sent', opened: 'Opened', submitted: 'Waiting for Accounting', creating: 'Creating in NetSuite',
  created: 'Approved', rejected: 'Rejected', expired: 'Expired', cancelled: 'Cancelled' };
const NATURE_LABELS = { renovation: 'Renovation', landscaping: 'Landscaping' };
const EVENT_LABELS = { created: 'Application created', link_issued: 'Link issued', link_regenerated: 'New link generated (old link stopped working)',
  opened: 'Customer opened the link', submitted: 'Customer submitted the application', extended: 'Link extended', cancelled: 'Cancelled',
  expired: 'Link expired', approved: 'Accounting approved', netsuite_created: 'Customer created in NetSuite', netsuite_failed: 'NetSuite creation failed',
  linked_existing: 'Linked to an existing NetSuite customer', rejected: 'Rejected by Accounting', card_revealed: 'Card viewed by Accounting',
  document_viewed: 'Document viewed by Accounting', card_charged: 'Card charged', cvv_purged: 'Security code deleted', card_deleted: 'Card deleted',
  documents_deleted: 'Documents deleted' };

export const escapeHtml = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
export const statusBadge = (status) => `<span class="aa-status ${escapeHtml(status)}">${escapeHtml(STATUS_LABELS[status] || status)}</span>`;
export const dateTime = (value) => (value ? new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Toronto' }).format(new Date(value)) : '—');
export const eventLabel = (kind) => EVENT_LABELS[kind] || kind;
export const natureText = (values = []) => values.map((value) => NATURE_LABELS[value] || value).join(', ');
export function staffToken() {
  return localStorage.getItem('mbbs.staff.token') || localStorage.getItem('mbbs.control.token') || localStorage.getItem('mbbs.dispatch.token')
    || localStorage.getItem('mbbs.operator.token') || '';
}

export function createApi(token) {
  return async function request(path, { method = 'GET', body, raw = false } = {}) {
    const response = await fetch(`/api/account-applications${path}`, { method, cache: 'no-store',
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (raw && response.ok) return response;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error || 'Could not complete this request. Please try again.'), { status: response.status, code: payload.code });
    return payload;
  };
}

export async function downloadBlob(response, fallback) {
  const url = URL.createObjectURL(await response.blob()), anchor = document.createElement('a');
  anchor.href = url; anchor.download = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/u)?.[1] || fallback;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export async function imageUrl(request, path) {
  return URL.createObjectURL(await (await request(path, { raw: true })).blob());
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const input = document.createElement('textarea'); input.value = text; document.body.append(input); input.select();
    const copied = document.execCommand?.('copy'); input.remove(); return Boolean(copied);
  }
}

// options: { token, basePath ('/sales/account-applications'), routing: 'history' | 'internal', heading }
export function mountAccountApplications(root, { token = staffToken(), basePath, routing = 'history', heading = 'Account Applications' } = {}) {
  const request = createApi(token);
  const objectUrls = [];
  let profilesInfo = null, selectedId = null, filters = { search: '', status: '' }, offset = 0, lastLink = null;
  const pathId = () => {
    if (routing !== 'history') return selectedId;
    const rest = location.pathname.replace(/\/+$/u, '').slice(basePath.length).replace(/^\//u, '');
    return rest || null;
  };
  function navigate(id) {
    selectedId = id;
    if (routing === 'history') history.pushState({}, '', id ? `${basePath}/${id}` : basePath);
    void show();
  }
  function notice(message, kind = 'error') {
    const target = root.querySelector('[data-aa-notice]');
    if (!target) return;
    target.className = message ? `aa-notice ${kind}` : '';
    target.textContent = message || '';
  }
  function releaseImages() { while (objectUrls.length) URL.revokeObjectURL(objectUrls.pop()); }

  function frame(inner) {
    root.innerHTML = `<div class="aa-header"><div><div class="aa-eyebrow">Customer accounts</div><h1>${escapeHtml(heading)}</h1></div><div class="aa-actions">${selectedId || pathId() ? '<button type="button" data-aa="back">← All applications</button>' : '<button type="button" class="primary" data-aa="new">New application</button>'}</div></div><div data-aa-notice role="status" aria-live="polite"></div>${inner}`;
  }

  async function loadProfiles() {
    if (!profilesInfo) profilesInfo = await request('/profiles');
    return profilesInfo;
  }

  function linkPanel(link, application) {
    const share = `Hello${application?.customerName ? ` ${application.customerName}` : ''}, please complete your Mr. Bin account application: ${link.url}`;
    return `<section class="aa-card" data-link-panel><h2>Customer link</h2><p class="aa-muted">Send this link to the customer. Link expires: ${escapeHtml(dateTime(link.expiresAt))}</p>
      <div class="aa-link-box"><input readonly value="${escapeHtml(link.url)}" aria-label="Customer link"><button type="button" class="primary" data-aa="copy" data-url="${escapeHtml(link.url)}">Copy link</button></div>
      <div class="aa-actions" style="margin-top:10px">${navigator.share ? `<button type="button" data-aa="share" data-text="${escapeHtml(share)}">Share…</button>` : ''}
      <a class="aa-button" href="sms:${application?.contactPhone ? escapeHtml(application.contactPhone.replace(/[^\d+]/gu, '')) : ''}?&body=${encodeURIComponent(share)}">Text message</a>
      <a class="aa-button" href="mailto:${escapeHtml(application?.contactEmail || '')}?subject=${encodeURIComponent('Mr. Bin account application')}&body=${encodeURIComponent(share)}">Email</a></div></section>`;
  }

  async function renderNew() {
    const info = await loadProfiles();
    if (!info.profiles.length) {
      frame('<section class="aa-card"><h2>No company available</h2><p>Your account is not set up to create applications for any company yet. Ask an administrator to check your yard assignment.</p></section>');
      return;
    }
    const options = info.profiles.map((profile) => `<option value="${escapeHtml(profile.key)}">${escapeHtml(profile.label)} — ${escapeHtml(profile.legalName)}</option>`).join('');
    frame(`<form class="aa-card" data-aa-form="new"><h2>New account application</h2><div class="aa-grid">
      <label class="wide"><span class="aa-required">Customer / business name</span><input name="customerName" required maxlength="200" autocomplete="off"></label>
      ${info.profiles.length > 1 ? `<label class="wide"><span class="aa-required">Company</span><select name="profileKey" required>${options}</select><p class="aa-help">The form shows this company's name and address.</p></label>`
        : `<input type="hidden" name="profileKey" value="${escapeHtml(info.profiles[0].key)}"><div class="wide"><span class="aa-muted">Company</span><div><strong>${escapeHtml(info.profiles[0].label)}</strong> — ${escapeHtml(info.profiles[0].legalName)}</div></div>`}
      <label><span>Customer phone</span><input name="contactPhone" type="tel" maxlength="40" placeholder="Optional — for texting the link"></label>
      <label><span>Customer email</span><input name="contactEmail" type="email" maxlength="254" placeholder="Optional — for emailing the link"></label>
      <label><span class="aa-required">Link valid for (days)</span><input name="validityDays" type="number" min="1" max="${info.maxValidityDays}" value="${info.defaultValidityDays}" required></label>
      <label class="wide"><span>Note for Accounting</span><textarea name="note" maxlength="500" placeholder="Optional"></textarea></label>
    </div><div class="aa-actions" style="margin-top:14px"><button type="submit" class="primary">Create link</button><button type="button" data-aa="back">Cancel</button></div></form>`);
  }

  async function renderList(append = false) {
    if (!append) {
      offset = 0;
      frame(`<section class="aa-card"><form class="aa-filters" data-aa-form="filters"><label><span>Search</span><input name="search" type="search" maxlength="200" value="${escapeHtml(filters.search)}" placeholder="Customer, application number or phone"></label>
        <label><span>Status</span><select name="status"><option value="">All</option>${Object.entries(STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${filters.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <span></span><button type="submit">Search</button></form></section><section class="aa-card"><table class="aa-table"><thead><tr><th>Customer</th><th class="hide-sm">Company</th><th>Status</th><th class="hide-sm">Expires / submitted</th><th></th></tr></thead><tbody data-aa-rows><tr><td colspan="5" class="aa-loading">Loading…</td></tr></tbody></table><div class="aa-actions" style="margin-top:10px"><button type="button" data-aa="more" hidden>Load more</button></div></section>`);
    }
    const result = await request(`/applications?${new URLSearchParams({ ...filters, offset: String(offset) })}`);
    const rows = result.items.map((item) => `<tr data-open="${escapeHtml(item.id)}"><td><strong>${escapeHtml(item.legalName || item.customerName)}</strong><br><small>${escapeHtml(item.number)}${item.createdByName ? ` · ${escapeHtml(item.createdByName)}` : ''}</small></td>
      <td class="hide-sm">${escapeHtml(item.profileLabel || item.company)}</td><td>${statusBadge(item.status)}${item.netsuiteCustomerId ? `<br><small>NetSuite #${escapeHtml(item.netsuiteCustomerId)}</small>` : ''}</td>
      <td class="hide-sm">${escapeHtml(item.submittedAt ? `Submitted ${dateTime(item.submittedAt)}` : `Expires ${dateTime(item.expiresAt)}`)}</td>
      <td>${['sent', 'opened'].includes(item.status) ? `<button type="button" class="small" data-aa="copy-row" data-id="${escapeHtml(item.id)}">Copy link</button>` : ''}</td></tr>`).join('');
    const body = root.querySelector('[data-aa-rows]');
    if (append) body.insertAdjacentHTML('beforeend', rows);
    else body.innerHTML = rows || '<tr><td colspan="5" class="aa-empty">No applications yet. Use “New application” to create a customer link.</td></tr>';
    offset += result.items.length;
    root.querySelector('[data-aa="more"]').hidden = !result.hasMore;
  }

  async function renderDetail(id) {
    releaseImages();
    const application = await request(`/applications/${encodeURIComponent(id)}`);
    const open = ['sent', 'opened'].includes(application.status);
    const canManage = open || application.status === 'expired';
    const s = application.submission;
    const linkHtml = open ? linkPanel(lastLink?.id === id ? lastLink : { url: '', expiresAt: application.expiresAt }, application) : '';
    frame(`<div class="aa-two"><div>
      <section class="aa-card"><div class="aa-header" style="margin:0 0 8px"><div><h2 style="margin:0">${escapeHtml(s?.legalName || application.customerName)}</h2><small>${escapeHtml(application.number)} · ${escapeHtml(application.profile.label)}</small></div>${statusBadge(application.status)}</div>
        <dl class="aa-dl"><dt>Customer name</dt><dd>${escapeHtml(application.customerName)}</dd><dt>Company</dt><dd>${escapeHtml(application.profile.legalName)}</dd>
        <dt>Created</dt><dd>${escapeHtml(dateTime(application.createdAt))} by ${escapeHtml(application.createdBy.name)}</dd>
        ${application.submittedAt ? `<dt>Submitted</dt><dd>${escapeHtml(dateTime(application.submittedAt))}</dd>` : `<dt>Link expires</dt><dd>${escapeHtml(dateTime(application.expiresAt))}</dd>`}
        ${application.note ? `<dt>Note</dt><dd>${escapeHtml(application.note)}</dd>` : ''}
        ${application.result.netsuiteCustomerId ? `<dt>NetSuite customer</dt><dd>#${escapeHtml(application.result.netsuiteCustomerId)} ${escapeHtml(application.result.netsuiteEntityId || '')}</dd>` : ''}
        ${application.result.rejectReason ? `<dt>Reject reason</dt><dd>${escapeHtml(application.result.rejectReason)}</dd>` : ''}</dl></section>
      ${linkHtml}
      ${canManage ? `<section class="aa-card"><h2>Manage link</h2><div class="aa-actions">${open ? '<button type="button" data-aa="regenerate">New link (stop old one)</button>' : ''}
        <label style="display:flex;gap:8px;align-items:center;font-weight:500">Extend by <input type="number" min="1" max="${profilesInfo?.maxValidityDays || 30}" value="${profilesInfo?.defaultValidityDays || 7}" data-aa-extend style="width:90px"> days</label><button type="button" data-aa="extend">Extend</button>
        <button type="button" class="danger" data-aa="cancel">Cancel application</button></div></section>` : ''}
      ${s ? `<section class="aa-card"><h2>Submitted details</h2><dl class="aa-dl"><dt>Legal name</dt><dd>${escapeHtml(s.legalName)}</dd><dt>Trade name</dt><dd>${escapeHtml(s.tradeName || '—')}</dd>
        <dt>Address</dt><dd>${escapeHtml(s.street)}<br>${escapeHtml(`${s.city}, ${s.province} ${s.postalCode}`)}</dd><dt>Phone</dt><dd>${escapeHtml(s.phone)}</dd><dt>Email</dt><dd>${escapeHtml(s.email)}</dd>
        <dt>Nature of business</dt><dd>${escapeHtml(natureText(s.nature))}</dd><dt>Signed by</dt><dd>${escapeHtml(`${s.signerName}, ${s.signerTitle}`)}</dd>
        <dt>Driver’s licence</dt><dd>${application.documents.driversLicenseProvided ? 'Provided (visible to Accounting only)' : 'Not provided'}</dd>
        <dt>Credit card</dt><dd>${application.cardProvided ? 'Provided (visible to Accounting only)' : 'Not provided'}</dd></dl>
        <div class="aa-actions" style="margin-top:12px"><button type="button" data-aa="pdf">Download signed PDF</button></div>
        ${application.documents.businessCards.length ? `<h3>Business card</h3><div class="aa-docs" data-aa-cards></div>` : ''}</section>` : ''}
    </div><section class="aa-card"><h2>History</h2><ol class="aa-timeline">${application.history.map((item) => `<li><strong>${escapeHtml(eventLabel(item.kind))}</strong><br><small>${escapeHtml(dateTime(item.at))} · ${escapeHtml(item.actorName)}</small></li>`).join('')}</ol></section></div>`);
    if (open && lastLink?.id !== id) {
      // Fill the link box (re-copying returns the same link; it does not create a new one).
      request(`/applications/${encodeURIComponent(id)}/link`, { method: 'POST', body: {} }).then((link) => {
        lastLink = { ...link, id };
        const panel = root.querySelector('[data-link-panel]');
        if (panel) panel.outerHTML = linkPanel(lastLink, application);
      }).catch((error) => notice(error.message));
    }
    const holder = root.querySelector('[data-aa-cards]');
    for (const card of application.documents.businessCards) {
      imageUrl(request, `/applications/${encodeURIComponent(id)}/documents/${encodeURIComponent(card.id)}`).then((url) => {
        objectUrls.push(url);
        holder?.insertAdjacentHTML('beforeend', `<figure><img src="${escapeHtml(url)}" alt="Business card"><figcaption>Business card</figcaption></figure>`);
      }).catch(() => holder?.insertAdjacentHTML('beforeend', '<p class="aa-muted">Business card image could not be loaded.</p>'));
    }
    root.dataset.application = JSON.stringify({ id, customerName: application.customerName, contactPhone: application.contactPhone, contactEmail: application.contactEmail });
  }

  async function show() {
    const id = pathId();
    try {
      await loadProfiles();
      if (id === 'new') await renderNew();
      else if (id) await renderDetail(id);
      else await renderList();
    } catch (error) {
      if (error.status === 401) { location.assign('/?next=' + encodeURIComponent(location.pathname + location.hash)); return; }
      frame(`<section class="aa-card"><h2>Account applications unavailable</h2><p>${escapeHtml(error.message)}</p></section>`);
    }
  }

  root.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-aa-form]');
    if (!form) return;
    event.preventDefault();
    if (form.dataset.aaForm === 'filters') {
      const values = new FormData(form); filters = { search: String(values.get('search') || '').trim(), status: String(values.get('status') || '') };
      await renderList().catch((error) => notice(error.message));
      return;
    }
    if (!form.reportValidity()) return;
    const values = new FormData(form), button = form.querySelector('[type=submit]');
    button.disabled = true;
    try {
      const result = await request('/applications', { method: 'POST', body: { customerName: values.get('customerName'), profileKey: values.get('profileKey'),
        validityDays: Number(values.get('validityDays')), contactPhone: values.get('contactPhone'), contactEmail: values.get('contactEmail'), note: values.get('note') } });
      lastLink = { ...result.link, id: result.application.id };
      navigate(result.application.id);
    } catch (error) { notice(error.message); button.disabled = false; }
  });

  root.addEventListener('click', async (event) => {
    const row = event.target.closest('tr[data-open]');
    const button = event.target.closest('[data-aa]');
    if (!button && row) { navigate(row.dataset.open); return; }
    if (!button) return;
    const action = button.dataset.aa, id = pathId();
    try {
      if (action === 'new') navigate('new');
      else if (action === 'back') navigate(null);
      else if (action === 'more') await renderList(true);
      else if (action === 'copy') { notice(await copyText(button.dataset.url) ? 'Link copied. Paste it into a text, WeChat or email to the customer.' : 'Copy failed — select the link and copy it manually.', 'ok'); }
      else if (action === 'share') await navigator.share({ title: 'Mr. Bin account application', text: button.dataset.text }).catch(() => {});
      else if (action === 'copy-row') {
        event.stopPropagation();
        const link = await request(`/applications/${encodeURIComponent(button.dataset.id)}/link`, { method: 'POST', body: {} });
        notice(await copyText(link.url) ? 'Link copied.' : link.url, 'ok');
      } else if (action === 'regenerate') {
        if (!confirm('Create a new link? The link you already sent will stop working.')) return;
        lastLink = { ...(await request(`/applications/${encodeURIComponent(id)}/link`, { method: 'POST', body: { regenerate: true } })), id };
        await renderDetail(id); notice('New link created. Send it to the customer.', 'ok');
      } else if (action === 'extend') {
        const days = Number(root.querySelector('[data-aa-extend]').value);
        await request(`/applications/${encodeURIComponent(id)}/extend`, { method: 'POST', body: { validityDays: days } });
        lastLink = null; await renderDetail(id); notice(`Link extended by ${days} day${days === 1 ? '' : 's'}.`, 'ok');
      } else if (action === 'cancel') {
        if (!confirm('Cancel this application? The customer link will stop working.')) return;
        await request(`/applications/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} });
        await renderDetail(id); notice('Application cancelled.', 'ok');
      } else if (action === 'pdf') {
        await downloadBlob(await request(`/applications/${encodeURIComponent(id)}/pdf`, { raw: true }), 'account-application.pdf');
      }
    } catch (error) { notice(error.message); }
  });

  if (routing === 'history') window.addEventListener('popstate', () => { selectedId = pathId(); void show(); });
  void show();
  return { refresh: show, destroy: releaseImages };
}

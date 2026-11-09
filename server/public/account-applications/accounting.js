// Accounting: review every submitted account application, view card / driver's licence,
// approve (terms + credit level) and create the NetSuite customer. Also hosts Setup.
import { COMPANIES, PROVINCES, rolesOf } from './domain.js';
import { escapeHtml, statusBadge, dateTime, eventLabel, natureText, staffToken, createApi, downloadBlob, imageUrl } from './manage.js';

const root = document.getElementById('aaAccountingApp');
const token = staffToken();
const request = createApi(token);
const BASE = '/accounting/account-applications';
const STATUS_FILTERS = [['submitted', 'Waiting for review'], ['creating', 'Creating in NetSuite'], ['created', 'Approved'], ['rejected', 'Rejected'],
  ['sent', 'Sent'], ['opened', 'Opened'], ['expired', 'Expired'], ['cancelled', 'Cancelled'], ['', 'All']];
const YARDS = [['', 'No yard'], ['1', '3445'], ['28', '2967'], ['15', '12441'], ['26', '150']];
let operator = null, options = null, filters = { search: '', status: 'submitted', company: '' }, offset = 0, revealTimer = null;
const objectUrls = [];
const provinceName = (code) => PROVINCES.find(([value]) => value === code)?.[1] || code;

function frame(title, inner, actions = '') {
  root.innerHTML = `<div class="aa-header"><div><div class="aa-eyebrow">Accounting</div><h1>${escapeHtml(title)}</h1></div><div class="aa-actions">${actions}</div></div><div data-aa-notice role="status" aria-live="polite"></div>${inner}`;
}
function notice(message, kind = 'error') {
  const target = root.querySelector('[data-aa-notice]');
  if (!target) return;
  target.className = message ? `aa-notice ${kind}` : '';
  target.textContent = message || '';
  if (message) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function navigate(path) { history.pushState({}, '', path); void route(); }
function releaseImages() { while (objectUrls.length) URL.revokeObjectURL(objectUrls.pop()); }
const isAccounting = () => rolesOf(operator).has('accounting');
const isAdmin = () => rolesOf(operator).has('admin');

async function renderMenu() {
  const accounting = isAccounting();
  const summary = accounting ? await request('/review/summary').catch(() => ({ submitted: 0 })) : { submitted: 0 };
  const waiting = Number(summary.submitted) || 0;
  frame('Accounting Menu', `<section class="aa-card"><p class="aa-muted" style="margin:0">Customer accounts, card-on-file and NetSuite customer setup.</p></section>
    <div class="aa-menu-grid">
      ${accounting ? `<a class="aa-menu-card primary" href="${BASE}"><strong>Account Approvals${waiting ? `<span class="aa-menu-count">${waiting}</span>` : ''}</strong>
        <span>Review submitted account applications, view cards and driver’s licences, approve with terms and credit level, and create the customer in NetSuite.</span></a>` : ''}
      <a class="aa-menu-card" href="/accounting/setup"><strong>Application Setup</strong>
        <span>Company letterheads, NetSuite subsidiaries and defaults, link validity, and the declaration and card authorization wording.</span></a>
    </div>
    ${accounting ? '' : '<section class="aa-card" style="margin-top:16px"><p class="aa-muted" style="margin:0">Account Approvals is available to users with the Accounting role.</p></section>'}`);
}

async function renderList(append = false) {
  if (!append) {
    offset = 0;
    frame('Account Approvals', `<section class="aa-card"><form class="aa-filters" data-form="filters">
      <label><span>Search</span><input name="search" type="search" maxlength="200" value="${escapeHtml(filters.search)}" placeholder="Customer, number, phone or staff"></label>
      <label><span>Status</span><select name="status">${STATUS_FILTERS.map(([value, label]) => `<option value="${value}" ${filters.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <label><span>Company</span><select name="company"><option value="">All</option>${COMPANIES.map((company) => `<option ${filters.company === company ? 'selected' : ''}>${company}</option>`).join('')}</select></label>
      <button type="submit">Search</button></form></section>
      <section class="aa-card"><table class="aa-table"><thead><tr><th>Customer</th><th class="hide-sm">Company</th><th class="hide-sm">Shared by</th><th>Status</th><th class="hide-sm">Submitted</th></tr></thead><tbody data-rows><tr><td colspan="5" class="aa-loading">Loading…</td></tr></tbody></table>
      <div class="aa-actions" style="margin-top:10px"><button type="button" data-action="more" hidden>Load more</button></div></section>`);
  }
  const result = await request(`/review?${new URLSearchParams({ ...filters, offset: String(offset) })}`);
  const rows = result.items.map((item) => `<tr data-open="${escapeHtml(item.id)}"><td><strong>${escapeHtml(item.legalName || item.customerName)}</strong><br><small>${escapeHtml(item.number)}${item.cardOnFile ? ' · 💳 card on file' : ''}</small></td>
    <td class="hide-sm">${escapeHtml(item.profileLabel || item.company)}</td><td class="hide-sm">${escapeHtml(item.createdByName)}</td>
    <td>${statusBadge(item.status)}${item.netsuiteCustomerId ? `<br><small>NetSuite #${escapeHtml(item.netsuiteCustomerId)}</small>` : ''}</td>
    <td class="hide-sm">${escapeHtml(item.submittedAt ? dateTime(item.submittedAt) : '—')}</td></tr>`).join('');
  const body = root.querySelector('[data-rows]');
  if (append) body.insertAdjacentHTML('beforeend', rows);
  else body.innerHTML = rows || '<tr><td colspan="5" class="aa-empty">No applications match.</td></tr>';
  offset += result.items.length;
  root.querySelector('[data-action="more"]').hidden = !result.hasMore;
}

function select(name, list, selected, { optional = false } = {}) {
  const values = list || [];
  const known = values.some((option) => option.id === String(selected ?? ''));
  return `<select name="${name}" ${optional ? '' : 'required'}>${optional ? '<option value="">— none —</option>' : '<option value="">Choose…</option>'}${values.map((option) => `<option value="${escapeHtml(option.id)}" ${String(selected ?? '') === option.id ? 'selected' : ''}>${escapeHtml(option.name)}</option>`).join('')}${selected && !known ? `<option value="${escapeHtml(selected)}" selected>#${escapeHtml(selected)}</option>` : ''}</select>`;
}

function defaultSalesRep(application) {
  const name = String(application.createdBy?.name || '').trim().toLowerCase();
  if (!name || !options?.salesReps?.length) return '';
  const first = name.split(/\s+/u)[0];
  return (options.salesReps.find((rep) => rep.name.toLowerCase() === name)
    || options.salesReps.find((rep) => rep.name.toLowerCase().startsWith(first)))?.id || '';
}

function cardPanel(application) {
  const card = application.card;
  if (!card) return '<section class="aa-card"><h2>Credit card</h2><p class="aa-muted">No card provided.</p></section>';
  if (card.deletedAt) return `<section class="aa-card"><h2>Credit card</h2><p>${escapeHtml(card.brand)} •••• ${escapeHtml(card.last4)} — deleted ${escapeHtml(dateTime(card.deletedAt))}.</p></section>`;
  const expiry = `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}`;
  return `<section class="aa-card"><h2>Credit card</h2><p><strong>${escapeHtml(card.brand)} •••• ${escapeHtml(card.last4)}</strong> · exp ${escapeHtml(expiry)}</p>
    <p class="aa-muted">${card.cvvOnFile ? `Security code on file — deleted when you mark the card charged, or automatically by ${escapeHtml(dateTime(card.cvvDeadline))}` : card.cvvPurgedAt ? `Security code deleted ${escapeHtml(dateTime(card.cvvPurgedAt))}` : 'No security code was provided.'}${card.chargedAt ? ` · Charged ${escapeHtml(dateTime(card.chargedAt))}` : ''}</p>
    <div data-reveal></div><div class="aa-actions"><button type="button" class="primary" data-action="reveal">Reveal card (60 s)</button>${card.chargedAt ? '' : '<button type="button" data-action="charged">Mark charged</button>'}<button type="button" class="danger" data-action="delete-card">Delete card</button></div>
    <p class="aa-help">Every reveal is recorded with your name and time.</p></section>`;
}

function decisionPanel(application) {
  const pending = application.status === 'submitted' || application.status === 'creating';
  if (!pending) {
    const approval = application.approval || {};
    return `<section class="aa-card"><h2>Decision</h2>${application.status === 'created' ? `<p>Approved${application.result.reviewedAt ? ` ${escapeHtml(dateTime(application.result.reviewedAt))}` : ''}. NetSuite customer <strong>#${escapeHtml(application.result.netsuiteCustomerId)}</strong> ${escapeHtml(approval.entityId || '')}${approval.linkedExisting ? ' (linked to an existing customer)' : ''}</p>
      ${approval.labels ? `<dl class="aa-dl"><dt>Terms</dt><dd>${escapeHtml(approval.labels.terms || approval.termsId || '—')}</dd><dt>Credit level</dt><dd>${escapeHtml(approval.labels.creditLevel || approval.creditLevelId || '—')}</dd><dt>Price level</dt><dd>${escapeHtml(approval.labels.priceLevel || '—')}</dd><dt>Sales rep</dt><dd>${escapeHtml(approval.labels.salesRep || '—')}</dd></dl>` : ''}
      ${(approval.warnings || []).map((warning) => `<div class="aa-notice info">${escapeHtml(warning)}</div>`).join('')}`
      : application.status === 'rejected' ? `<p>Rejected: ${escapeHtml(application.result.rejectReason)}</p>` : `<p class="aa-muted">The customer has not submitted this application yet (${escapeHtml(application.status)}).</p>`}</section>`;
  }
  const defaults = application.defaults || {};
  return `<section class="aa-card"><h2>Approve and create customer</h2>${application.netsuiteError ? `<div class="aa-notice error">Last NetSuite attempt failed: ${escapeHtml(application.netsuiteError)}</div>` : ''}
    ${options && !options.live ? '<div class="aa-notice info">NetSuite lists could not be loaded; showing saved values.</div>' : ''}
    <form data-form="approve"><div class="aa-grid">
      <label><span class="aa-required">Terms</span>${select('termsId', options?.terms, defaults.defaultTermsId)}</label>
      <label><span class="aa-required">Credit level</span>${select('creditLevelId', options?.creditLevels, defaults.defaultCreditLevelId)}</label>
      <label><span>Price level</span>${select('priceLevelId', options?.priceLevels, defaults.defaultPriceLevelId, { optional: true })}</label>
      <label><span>Sales rep</span>${select('salesRepId', options?.salesReps, defaultSalesRep(application), { optional: true })}</label>
      <label class="wide"><span class="aa-required">Customer status</span>${select('statusId', options?.statuses, defaults.defaultStatusId)}</label></div>
      <p class="aa-help">Creates the customer in subsidiary ${escapeHtml(defaults.subsidiaryId || '?')}${(defaults.additionalSubsidiaryIds || []).length ? ` (also ${escapeHtml(defaults.additionalSubsidiaryIds.join(', '))})` : ''} with the billing/shipping address, and the signer as a contact.</p>
      <div class="aa-actions"><button type="submit" class="primary">Approve &amp; create in NetSuite</button></div></form></section>
    <section class="aa-card"><h2>Possible existing customers</h2><div data-matches class="aa-loading">Searching…</div>
      <form data-form="link-existing" class="aa-link-box" style="margin-top:10px"><input name="customerId" inputmode="numeric" pattern="\\d{1,12}" placeholder="NetSuite customer internal ID" required><button type="submit">Link existing</button></form></section>
    <section class="aa-card"><h2>Reject</h2><form data-form="reject"><label><span class="aa-required">Reason (shown to the staff member)</span><textarea name="reason" maxlength="500" required></textarea></label>
      <div class="aa-actions" style="margin-top:10px"><button type="submit" class="danger">Reject application</button></div><p class="aa-help">Rejecting deletes the card and driver’s licence from the vault.</p></form></section>`;
}

async function renderDetail(id) {
  releaseImages(); clearReveal();
  const [application] = await Promise.all([request(`/review/${encodeURIComponent(id)}`), options ? null : request('/review/options').then((value) => { options = value; }).catch(() => { options = null; })]);
  const s = application.submission;
  frame(s?.legalName || application.customerName, `<div class="aa-two"><div>
    <section class="aa-card"><div class="aa-header" style="margin:0 0 8px"><div><strong>${escapeHtml(application.number)}</strong> · ${escapeHtml(application.profile.label)}<br><small>Shared by ${escapeHtml(application.createdBy.name)} · created ${escapeHtml(dateTime(application.createdAt))}</small></div>${statusBadge(application.status)}</div>
      ${application.note ? `<div class="aa-notice info">Note from ${escapeHtml(application.createdBy.name)}: ${escapeHtml(application.note)}</div>` : ''}
      ${s ? `<dl class="aa-dl"><dt>Legal name</dt><dd>${escapeHtml(s.legalName)}</dd><dt>Trade name</dt><dd>${escapeHtml(s.tradeName || 'Same as legal name')}</dd>
      <dt>Address</dt><dd>${escapeHtml(s.street)}<br>${escapeHtml(`${s.city}, ${provinceName(s.province)} ${s.postalCode}`)}</dd><dt>Phone</dt><dd>${escapeHtml(s.phone)}</dd><dt>Email</dt><dd>${escapeHtml(s.email)}</dd>
      <dt>Nature of business</dt><dd>${escapeHtml(natureText(s.nature))}</dd><dt>Signed by</dt><dd>${escapeHtml(`${s.signerName}, ${s.signerTitle}`)} · ${escapeHtml(dateTime(application.submittedAt))}</dd>
      <dt>Form language</dt><dd>${s.language === 'zh-CN' ? 'Chinese' : 'English'}</dd></dl>
      <div class="aa-actions" style="margin-top:12px"><button type="button" data-action="pdf">Download signed PDF</button></div>` : `<p class="aa-muted">Not submitted yet. Link expires ${escapeHtml(dateTime(application.expiresAt))}.</p>`}</section>
    ${s ? `<section class="aa-card"><h2>Documents</h2><div class="aa-docs" data-docs>${application.documents.businessCards.length + application.documents.driversLicenses.length ? '' : '<p class="aa-muted">No images were uploaded.</p>'}</div>
      ${application.signatureDataUrl ? `<h3>Signature</h3><img class="aa-sig-img" src="${escapeHtml(application.signatureDataUrl)}" alt="Signature">` : ''}</section>${cardPanel(application)}` : ''}
    <section class="aa-card"><h2>History</h2><ol class="aa-timeline">${application.history.map((item) => `<li><strong>${escapeHtml(eventLabel(item.kind))}</strong>${item.details?.reason ? ` — ${escapeHtml(item.details.reason)}` : ''}${item.details?.message ? ` — ${escapeHtml(item.details.message)}` : ''}<br><small>${escapeHtml(dateTime(item.at))} · ${escapeHtml(item.actorName)}</small></li>`).join('')}</ol></section>
  </div><div>${decisionPanel(application)}</div></div>`, '<button type="button" data-action="back">← All applications</button>');
  const docs = root.querySelector('[data-docs]');
  for (const [kind, list] of [['Business card', application.documents.businessCards], ['Driver’s licence', application.documents.driversLicenses]]) {
    for (const [index, item] of list.entries()) {
      imageUrl(request, `/review/${encodeURIComponent(id)}/documents/${encodeURIComponent(item.id)}`).then((url) => {
        objectUrls.push(url);
        docs?.insertAdjacentHTML('beforeend', `<figure><a href="${escapeHtml(url)}" target="_blank" rel="noopener"><img src="${escapeHtml(url)}" alt="${escapeHtml(kind)}"></a><figcaption>${escapeHtml(kind)} ${index + 1}</figcaption></figure>`);
      }).catch(() => docs?.insertAdjacentHTML('beforeend', `<p class="aa-muted">${escapeHtml(kind)} ${index + 1} could not be loaded.</p>`));
    }
  }
  if (application.status === 'submitted') {
    request(`/review/${encodeURIComponent(id)}/netsuite-matches`).then((result) => {
      const target = root.querySelector('[data-matches]');
      if (!target) return;
      target.className = '';
      target.innerHTML = `${result.warning ? `<div class="aa-notice info">${escapeHtml(result.warning)}</div>` : ''}${result.items.length ? `<table class="aa-table"><tbody>${result.items.map((match) => `<tr><td><strong>${escapeHtml(match.entityId || match.companyName)}</strong><br><small>#${escapeHtml(match.id)} · ${escapeHtml([match.phone, match.email, match.subsidiary].filter(Boolean).join(' · '))}${match.active === false ? ' · inactive' : ''}</small></td><td><button type="button" class="small" data-action="link" data-customer="${escapeHtml(match.id)}">Link</button></td></tr>`).join('')}</tbody></table>` : '<p class="aa-muted">No customers with the same phone, email or name were found.</p>'}`;
    }).catch((error) => { const target = root.querySelector('[data-matches]'); if (target) target.textContent = error.message; });
  }
}

function clearReveal() {
  clearInterval(revealTimer); revealTimer = null;
  const target = root.querySelector('[data-reveal]');
  if (target) target.innerHTML = '';
}

async function reveal(id) {
  const ticket = await request(`/review/${encodeURIComponent(id)}/card/reveal`, { method: 'POST', body: {} });
  const response = await fetch(ticket.url, { cache: 'no-store', referrerPolicy: 'no-referrer', headers: { authorization: `Bearer ${ticket.token}` } });
  const card = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(card.error || 'The vault did not return the card.');
  const target = root.querySelector('[data-reveal]');
  let remaining = 60;
  const paint = () => {
    target.innerHTML = `<div class="aa-reveal"><div>${escapeHtml(card.cardholderName)}</div><div>${escapeHtml(card.number.replace(/(\d{4})(?=\d)/gu, '$1 '))}</div><div>Exp ${escapeHtml(String(card.expMonth).padStart(2, '0'))}/${escapeHtml(String(card.expYear))} · CVV ${escapeHtml(card.cvv || (card.cvvPurgedAt ? 'deleted' : 'not provided'))}</div><small>Hides in ${remaining} s</small></div>`;
  };
  clearReveal(); paint();
  revealTimer = setInterval(() => { remaining -= 1; if (remaining <= 0) clearReveal(); else paint(); }, 1000);
}

function profileEditor(profile, index) {
  const ns = profile.netsuite || {};
  return `<fieldset class="aa-profile-editor" data-profile="${index}"><div class="aa-grid3">
    <label><span>Key</span><input name="key" value="${escapeHtml(profile.key)}" ${profile.key ? 'readonly' : ''} maxlength="40" required></label>
    <label><span>Company</span><select name="company">${COMPANIES.map((company) => `<option ${profile.company === company ? 'selected' : ''}>${company}</option>`).join('')}</select></label>
    <label><span>Yard (MBBS)</span><select name="yardLocationId">${YARDS.map(([value, label]) => `<option value="${value}" ${String(profile.yardLocationId ?? '') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    <label><span>Menu label</span><input name="label" value="${escapeHtml(profile.label)}" maxlength="80" required></label>
    <label><span>Legal name on form</span><input name="legalName" value="${escapeHtml(profile.legalName)}" maxlength="120" required></label>
    <label><span>Phone</span><input name="phone" value="${escapeHtml(profile.phone)}" maxlength="40"></label>
    <label><span>Address (one line each)</span><textarea name="addressLines" rows="2">${escapeHtml((profile.addressLines || []).join('\n'))}</textarea></label>
    <label><span>HST number</span><input name="hstNumber" value="${escapeHtml(profile.hstNumber)}" maxlength="40"></label>
    <label class="aa-check" style="align-self:end"><input type="checkbox" name="active" ${profile.active !== false ? 'checked' : ''}><span>Active</span></label>
    <label><span>NetSuite subsidiary ID</span><input name="subsidiaryId" value="${escapeHtml(ns.subsidiaryId)}" inputmode="numeric" required></label>
    <label><span>Also add subsidiaries (IDs, comma)</span><input name="additionalSubsidiaryIds" value="${escapeHtml((ns.additionalSubsidiaryIds || []).join(', '))}"></label>
    <label><span>NetSuite location ID</span><input name="locationId" value="${escapeHtml(ns.locationId)}" inputmode="numeric"></label>
    <label><span>Default terms ID</span><input name="defaultTermsId" value="${escapeHtml(ns.defaultTermsId)}" inputmode="numeric"></label>
    <label><span>Default credit level ID</span><input name="defaultCreditLevelId" value="${escapeHtml(ns.defaultCreditLevelId)}" inputmode="numeric"></label>
    <label><span>Default price level ID</span><input name="defaultPriceLevelId" value="${escapeHtml(ns.defaultPriceLevelId)}" inputmode="numeric"></label>
    <label><span>Default customer status ID</span><input name="defaultStatusId" value="${escapeHtml(ns.defaultStatusId)}" inputmode="numeric"></label>
  </div></fieldset>`;
}

async function renderSetup() {
  if (!isAccounting() && !isAdmin()) { frame('Application Setup', '<section class="aa-card"><p>Accounting or Admin access is required.</p></section>'); return; }
  const settings = await request('/settings');
  const logos = settings.logos || {};
  const logoSlot = (company) => `<div class="aa-logo-slot"><strong>${company}</strong>
    <div class="aa-logo-preview">${logos[company] ? `<img src="${escapeHtml(logos[company].url)}" alt="${company} logo">` : 'No logo yet'}</div>
    <div class="aa-actions"><label class="aa-file-label"><input type="file" accept="image/png,image/jpeg,image/webp" data-logo-upload="${company}">${logos[company] ? 'Replace logo' : 'Upload logo'}</label>
    ${logos[company] ? `<button type="button" class="small danger" data-action="remove-logo" data-company="${company}">Remove</button>` : ''}</div></div>`;
  frame('Application Setup', `<section class="aa-card"><h2>Company logos</h2><p class="aa-help">Shown on the customer form and the signed PDF. Use a PNG with a transparent or white background, wider than tall. New logos apply to applications signed from now on.</p>
    <div class="aa-logo-slots">${COMPANIES.map(logoSlot).join('')}</div></section>
    <form data-form="settings" data-revision="${settings.revision}">
    <section class="aa-card"><h2>Customer links</h2><div class="aa-grid"><label><span>Default validity (days)</span><input name="defaultValidityDays" type="number" min="1" value="${settings.defaultValidityDays}"></label>
      <label><span>Maximum validity (days)</span><input name="maxValidityDays" type="number" min="1" max="90" value="${settings.maxValidityDays}"></label></div></section>
    <section class="aa-card"><h2>Company letterheads</h2><p class="aa-help">Sales users get the MBBS profile for their yard; MBT front desk gets MBT; MBR sales gets MBR; Field sales get all active profiles. Changes apply to new applications only.</p>
      <div data-profiles>${settings.profiles.map(profileEditor).join('')}</div><button type="button" data-action="add-profile">Add profile</button></section>
    <section class="aa-card"><h2>Declaration text</h2><p class="aa-help">Use {company} for the company's legal name.</p><div class="aa-grid">
      <label><span>English</span><textarea name="attestationEn" maxlength="2000">${escapeHtml(settings.attestation.en)}</textarea></label><label><span>Chinese</span><textarea name="attestationZh" maxlength="2000">${escapeHtml(settings.attestation.zh)}</textarea></label>
      <label><span>Card authorization (English)</span><textarea name="cardEn" maxlength="2000">${escapeHtml(settings.cardAuthorization.en)}</textarea></label><label><span>Card authorization (Chinese)</span><textarea name="cardZh" maxlength="2000">${escapeHtml(settings.cardAuthorization.zh)}</textarea></label></div></section>
    <div class="aa-actions"><button type="submit" class="primary">Save setup</button><small>Last saved ${escapeHtml(dateTime(settings.updatedAt))}</small></div></form>`);
}

function readSettings(form) {
  const value = (scope, name) => scope.querySelector(`[name="${name}"]`)?.value ?? '';
  return {
    revision: Number(form.dataset.revision),
    defaultValidityDays: Number(value(form, 'defaultValidityDays')), maxValidityDays: Number(value(form, 'maxValidityDays')),
    profiles: [...form.querySelectorAll('[data-profile]')].map((scope) => ({
      key: value(scope, 'key'), company: value(scope, 'company'), yardLocationId: value(scope, 'yardLocationId') || null, label: value(scope, 'label'),
      legalName: value(scope, 'legalName'), phone: value(scope, 'phone'), hstNumber: value(scope, 'hstNumber'),
      addressLines: value(scope, 'addressLines').split('\n').map((line) => line.trim()).filter(Boolean), active: scope.querySelector('[name="active"]').checked,
      netsuite: { subsidiaryId: value(scope, 'subsidiaryId'), locationId: value(scope, 'locationId'),
        additionalSubsidiaryIds: value(scope, 'additionalSubsidiaryIds').split(',').map((id) => id.trim()).filter(Boolean),
        defaultTermsId: value(scope, 'defaultTermsId'), defaultCreditLevelId: value(scope, 'defaultCreditLevelId'),
        defaultPriceLevelId: value(scope, 'defaultPriceLevelId'), defaultStatusId: value(scope, 'defaultStatusId') }
    })),
    attestation: { en: value(form, 'attestationEn'), zh: value(form, 'attestationZh') },
    cardAuthorization: { en: value(form, 'cardEn'), zh: value(form, 'cardZh') }
  };
}

async function route() {
  const path = location.pathname.replace(/\/+$/u, '');
  try {
    if (!operator) {
      const response = await fetch('/api/auth/me', { cache: 'no-store', headers: { authorization: `Bearer ${token}` } });
      if (response.status === 401) throw Object.assign(new Error('Login required'), { status: 401 });
      operator = (await response.json().catch(() => ({}))).operator || null;
    }
    if (path === '/accounting') { await renderMenu(); return; }
    if (path === '/accounting/setup') { await renderSetup(); return; }
    if (!isAccounting()) {
      frame('Account Approvals', `<section class="aa-card"><h2>Accounting role required</h2><p>Only Accounting can review applications, view cards and driver’s licences, and create customers.</p>${isAdmin() ? '<a class="aa-button" href="/accounting/setup">Open Application Setup</a>' : ''}</section>`);
      return;
    }
    const id = path.startsWith(`${BASE}/`) ? path.slice(BASE.length + 1) : '';
    if (id) await renderDetail(id); else await renderList();
  } catch (error) {
    if (error.status === 401) { location.assign('/?next=' + encodeURIComponent(location.pathname)); return; }
    frame('Account Approvals', `<section class="aa-card"><h2>Unavailable</h2><p>${escapeHtml(error.message)}</p></section>`);
  }
}

root.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  const id = location.pathname.replace(/\/+$/u, '').slice(BASE.length + 1);
  const button = form.querySelector('[type=submit]');
  try {
    if (form.dataset.form === 'filters') {
      const values = new FormData(form);
      filters = { search: String(values.get('search') || '').trim(), status: String(values.get('status') || ''), company: String(values.get('company') || '') };
      await renderList(); return;
    }
    if (!form.reportValidity()) return;
    button.disabled = true;
    if (form.dataset.form === 'approve') {
      const values = new FormData(form);
      const label = (name) => form.querySelector(`[name="${name}"] option:checked`)?.textContent || '';
      button.textContent = 'Creating in NetSuite…';
      await request(`/review/${encodeURIComponent(id)}/approve`, { method: 'POST', body: { termsId: values.get('termsId'), creditLevelId: values.get('creditLevelId'),
        priceLevelId: values.get('priceLevelId'), salesRepId: values.get('salesRepId'), statusId: values.get('statusId'),
        labels: { terms: label('termsId'), creditLevel: label('creditLevelId'), priceLevel: label('priceLevelId'), salesRep: label('salesRepId'), status: label('statusId') } } });
      await renderDetail(id); notice('Customer created in NetSuite.', 'ok');
    } else if (form.dataset.form === 'link-existing') {
      await linkExisting(id, new FormData(form).get('customerId'));
    } else if (form.dataset.form === 'reject') {
      if (!confirm('Reject this application? The card and driver’s licence will be deleted.')) { button.disabled = false; return; }
      await request(`/review/${encodeURIComponent(id)}/reject`, { method: 'POST', body: { reason: new FormData(form).get('reason') } });
      await renderDetail(id); notice('Application rejected.', 'ok');
    } else if (form.dataset.form === 'settings') {
      await request('/settings', { method: 'PUT', body: readSettings(form) });
      await renderSetup(); notice('Setup saved.', 'ok');
    }
  } catch (error) {
    notice(error.message);
    if (form.dataset.form === 'approve' && id) await renderDetail(id).then(() => notice(error.message)).catch(() => {});
  } finally { if (button?.isConnected) { button.disabled = false; if (form.dataset.form === 'approve') button.textContent = 'Approve & create in NetSuite'; } }
});

async function linkExisting(id, customerId) {
  if (!confirm(`Link this application to NetSuite customer #${customerId}? No new customer will be created.`)) return;
  await request(`/review/${encodeURIComponent(id)}/link-existing`, { method: 'POST', body: { customerId } });
  await renderDetail(id); notice(`Linked to NetSuite customer #${customerId}.`, 'ok');
}

root.addEventListener('click', async (event) => {
  const card = event.target.closest('a.aa-menu-card');
  if (card && !event.metaKey && !event.ctrlKey && !event.shiftKey) { event.preventDefault(); navigate(new URL(card.href).pathname); return; }
  const row = event.target.closest('tr[data-open]');
  const button = event.target.closest('[data-action]');
  if (!button && row) { navigate(`${BASE}/${row.dataset.open}`); return; }
  if (!button) return;
  const id = location.pathname.replace(/\/+$/u, '').slice(BASE.length + 1);
  try {
    switch (button.dataset.action) {
    case 'back': navigate(BASE); break;
    case 'more': await renderList(true); break;
    case 'pdf': await downloadBlob(await request(`/review/${encodeURIComponent(id)}/pdf`, { raw: true }), 'account-application.pdf'); break;
    case 'reveal': button.disabled = true; await reveal(id); button.disabled = false; break;
    case 'charged':
      if (!confirm('Mark the card as charged? The security code (CVV) will be deleted permanently.')) return;
      await request(`/review/${encodeURIComponent(id)}/card/charged`, { method: 'POST', body: {} }); await renderDetail(id); notice('Card marked charged; CVV deleted.', 'ok'); break;
    case 'delete-card':
      if (!confirm('Delete this card from the vault permanently?')) return;
      await request(`/review/${encodeURIComponent(id)}/card`, { method: 'DELETE' }); await renderDetail(id); notice('Card deleted.', 'ok'); break;
    case 'link': await linkExisting(id, button.dataset.customer); break;
    case 'remove-logo':
      if (!confirm(`Remove the ${button.dataset.company} logo? Forms and PDFs will show the company name only.`)) return;
      await request(`/settings/logos/${encodeURIComponent(button.dataset.company)}`, { method: 'DELETE' }); await renderSetup(); notice('Logo removed.', 'ok'); break;
    case 'add-profile':
      root.querySelector('[data-profiles]').insertAdjacentHTML('beforeend', profileEditor({ key: '', company: 'MBBS', label: '', legalName: '', addressLines: [], phone: '', hstNumber: '', active: true, netsuite: {} },
        root.querySelectorAll('[data-profile]').length));
      break;
    default: break;
    }
  } catch (error) { button.disabled = false; notice(error.message); }
});

root.addEventListener('change', async (event) => {
  const input = event.target.closest('[data-logo-upload]');
  if (!input?.files?.length) return;
  const file = input.files[0], company = input.dataset.logoUpload;
  try {
    const response = await fetch(`/api/account-applications/settings/logos/${encodeURIComponent(company)}`, { method: 'PUT', cache: 'no-store',
      headers: { authorization: `Bearer ${token}`, 'content-type': file.type || 'application/octet-stream' }, body: file });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'The logo could not be uploaded.');
    await renderSetup(); notice(`${company} logo saved.`, 'ok');
  } catch (error) { notice(error.message); }
});

window.addEventListener('popstate', () => void route());
if (!token) location.assign('/?next=' + encodeURIComponent(location.pathname));
else void route();

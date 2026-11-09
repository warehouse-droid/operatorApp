import { PROVINCES, MAX_UPLOADS_PER_KIND } from './domain.js';
import { drawSignature } from '/mbr/ui.js';

const LINK_HEADER = 'x-account-application-link';
const token = location.hash.slice(1);
const app = document.getElementById('aaApp');
const LANGUAGE_KEY = 'mbbs.ui.language';
const T = {
  en: {
    eyebrow: 'Customer account application', title: 'Open an account', preparedFor: 'Prepared for {name}', contact: 'Your Mr. Bin contact: {staff}',
    expires: 'Please complete this form by {date}', sectionBusiness: 'Business information', legalName: 'Legal name',
    tradeName: 'Business trade name', tradeNameHelp: 'Only if different from the legal name.', street: 'Street address', city: 'City',
    province: 'Province', postalCode: 'Postal code', phone: 'Phone', email: 'Email', sectionNature: 'Nature of business',
    natureHelp: 'Select all that apply.', renovation: 'Renovation', landscaping: 'Landscaping', sectionDocs: 'Business card and driver’s licence',
    docsHelp: 'Take a photo or choose an image (up to 2 each, e.g. front and back). Images are encrypted and only our Accounting department can view your driver’s licence.',
    businessCard: 'Business card', driversLicense: 'Driver’s licence', addPhoto: 'Take or choose photo', uploading: 'Uploading…',
    remove: 'Remove', uploaded: 'Uploaded', sectionCard: 'Credit card (optional)', addCard: 'Keep a credit card on file for this account',
    cardSecure: 'Your card details are encrypted in your browser session and sent directly to our secure vault. They are never stored on our application server, and only our Accounting department can view them. The security code (CVV) is deleted after the first charge or within 30 days.',
    cardName: 'Name on card', cardNumber: 'Card number', cardExpiry: 'Expiry (MM/YY)', cardCvv: 'Security code (CVV)',
    sectionSign: 'Declaration and signature', agree: 'I have read and agree to the declaration above.', printName: 'Print name', signerTitle: 'Title',
    signature: 'Signature', signatureHelp: 'Sign with your finger or mouse in the box.', clear: 'Clear signature', submit: 'Submit application',
    submitting: 'Submitting…', thanksTitle: 'Thank you!', thanksBody: 'Your application {number} was submitted. Our Accounting department will review it and your Mr. Bin contact will follow up with you.',
    expiredTitle: 'This link has expired', expiredBody: 'Please ask {staff} at Mr. Bin to extend your application link.',
    cancelledTitle: 'This application was cancelled', cancelledBody: 'Please contact {staff} at Mr. Bin if you still want to open an account.',
    submittedTitle: 'Application already submitted', submittedBody: 'Application {number} was submitted on {date}. Your Mr. Bin contact will follow up with you.',
    unavailableTitle: 'Link unavailable', unavailableBody: 'Please ask your Mr. Bin contact for your account application link.',
    errSignature: 'Please sign in the signature box.', errNature: 'Select the nature of your business.', connection: 'Connection interrupted. Your entries are still here. Please try again.',
    docsUnavailable: 'Image upload is not available right now. You can submit the form and send the images to your Mr. Bin contact.',
    cardUnavailable: 'Card details cannot be saved online right now. Your Mr. Bin contact will follow up about payment.',
    maxImages: 'You can upload up to {count} images for each document.', required: 'Required', cardInvalid: 'Check the card details and try again.',
    CARD_NUMBER_INVALID: 'The card number is not valid.', CARD_EXPIRY_INVALID: 'Enter the expiry date as MM/YY.', CARD_EXPIRED: 'This card has expired.',
    CARD_CVV_INVALID: 'Enter the 3-digit security code (4 digits for American Express).', CARD_NAME_INVALID: 'Enter the name shown on the card.',
    downloadPdf: 'Download signed PDF', downloading: 'Preparing PDF…', keepCopy: 'Keep a copy of your signed application for your records.'
  },
  'zh-CN': {
    eyebrow: '客户开户申请', title: '开立账户', preparedFor: '申请人：{name}', contact: 'Mr. Bin 联系人：{staff}',
    expires: '请于 {date} 前完成填写。', sectionBusiness: '企业信息', legalName: '公司法定名称',
    tradeName: '经营名称', tradeNameHelp: '仅在与法定名称不同时填写。', street: '街道地址', city: '城市',
    province: '省份', postalCode: '邮政编码', phone: '电话', email: '电子邮箱', sectionNature: '业务性质',
    natureHelp: '可多选。', renovation: '装修', landscaping: '园林景观', sectionDocs: '名片和驾照',
    docsHelp: '拍照或选择图片（每项最多 2 张，例如正反面）。图片经加密保存，只有我们的会计部门可以查看您的驾照。',
    businessCard: '名片', driversLicense: '驾照', addPhoto: '拍照或选择图片', uploading: '上传中…',
    remove: '删除', uploaded: '已上传', sectionCard: '信用卡（可选）', addCard: '为此账户保存一张信用卡',
    cardSecure: '您的信用卡信息将直接加密发送至我们的安全保管库，不会保存在我们的应用服务器上，只有会计部门可以查看。安全码（CVV）会在首次扣款后或 30 天内删除。',
    cardName: '持卡人姓名', cardNumber: '卡号', cardExpiry: '有效期（月/年 MM/YY）', cardCvv: '安全码（CVV）',
    sectionSign: '声明与签名', agree: '本人已阅读并同意以上声明。', printName: '签名人姓名（正楷）', signerTitle: '职位',
    signature: '签名', signatureHelp: '请用手指或鼠标在框内签名。', clear: '清除签名', submit: '提交申请',
    submitting: '提交中…', thanksTitle: '谢谢！', thanksBody: '您的申请 {number} 已提交。我们的会计部门将进行审核，您的 Mr. Bin 联系人会与您跟进。',
    expiredTitle: '此链接已过期', expiredBody: '请联系 Mr. Bin 的 {staff} 延长您的申请链接。',
    cancelledTitle: '此申请已取消', cancelledBody: '如仍需开户，请联系 Mr. Bin 的 {staff}。',
    submittedTitle: '申请已提交', submittedBody: '申请 {number} 已于 {date} 提交。您的 Mr. Bin 联系人会与您跟进。',
    unavailableTitle: '链接不可用', unavailableBody: '请向您的 Mr. Bin 联系人索取开户申请链接。',
    errSignature: '请在签名框内签名。', errNature: '请选择业务性质。', connection: '网络中断，您填写的内容仍在页面上，请重试。',
    docsUnavailable: '目前无法上传图片。您可以先提交申请，再将图片发送给您的 Mr. Bin 联系人。',
    cardUnavailable: '目前无法在线保存信用卡信息，您的 Mr. Bin 联系人会就付款事宜与您跟进。',
    maxImages: '每项证件最多可上传 {count} 张图片。', required: '必填', cardInvalid: '请检查信用卡信息后重试。',
    CARD_NUMBER_INVALID: '卡号无效。', CARD_EXPIRY_INVALID: '请按 MM/YY 格式填写有效期。', CARD_EXPIRED: '此卡已过期。',
    CARD_CVV_INVALID: '请输入 3 位安全码（美国运通卡为 4 位）。', CARD_NAME_INVALID: '请输入卡面上的姓名。',
    downloadPdf: '下载已签署的 PDF', downloading: '正在准备 PDF…', keepCopy: '请保存一份已签署的申请表供您存档。'
  }
};
let language = localStorage.getItem(LANGUAGE_KEY) === 'zh-CN' ? 'zh-CN' : 'en';
let view = null, pad = null, submissionId = null, attemptFingerprint = '', cardCache = null;
const uploads = [];

const escapeHtml = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
const t = (key, values = {}) => Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), T[language][key] ?? T.en[key] ?? key);
const dateText = (value) => new Intl.DateTimeFormat(language === 'zh-CN' ? 'zh-CN' : 'en-CA', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Toronto' }).format(new Date(value));
const headers = (extra = {}) => ({ [LINK_HEADER]: token, ...extra });

function notice(message, kind = 'error') {
  const target = document.getElementById('aaNotice');
  target.className = message ? `aa-notice ${kind}` : '';
  target.textContent = message || '';
  if (message && kind === 'error') target.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function api(path, { method = 'GET', body, json = true, contentType } = {}) {
  const response = await fetch(`/api/account-applications/public${path}`, { method, cache: 'no-store',
    headers: headers(body === undefined ? {} : { 'content-type': contentType || 'application/json' }),
    body: body === undefined ? undefined : json ? JSON.stringify(body) : body });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || 'Request failed.'), { code: payload.code, status: response.status });
  return payload;
}

function setLanguage(next) {
  language = next === 'zh-CN' ? 'zh-CN' : 'en';
  localStorage.setItem(LANGUAGE_KEY, language);
  document.documentElement.lang = language === 'zh-CN' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-lang]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.lang === language)));
  document.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = t(node.dataset.i18n, JSON.parse(node.dataset.i18nValues || '{}')); });
  document.querySelectorAll('[data-lang-text]').forEach((node) => { node.textContent = language === 'zh-CN' ? node.dataset.zh : node.dataset.en; });
  document.querySelectorAll('option[data-en]').forEach((node) => { node.textContent = language === 'zh-CN' ? node.dataset.zh : node.dataset.en; });
  if (view) renderUploads();
}

const i18n = (key, values) => `<span data-i18n="${key}"${values ? ` data-i18n-values='${escapeHtml(JSON.stringify(values))}'` : ''}>${escapeHtml(t(key, values))}</span>`;
const field = (name, key, attrs = '', help = '') => `<label><span class="${attrs.includes('required') ? 'aa-required' : ''}">${i18n(key)}</span><input name="${name}" ${attrs}>${help ? `<p class="aa-help">${i18n(help)}</p>` : ''}</label>`;

function letterhead() {
  const profile = view.profile;
  return `<section class="aa-card">${profile.logo ? `<img class="aa-logo" src="${escapeHtml(profile.logo.url)}" alt="${escapeHtml(profile.legalName)}">` : ''}<div class="aa-letterhead"><strong>${escapeHtml(profile.legalName)}</strong>${(profile.addressLines || []).map((line) => `<div>${escapeHtml(line)}</div>`).join('')}${profile.phone ? `<div>Tel ${escapeHtml(profile.phone)}</div>` : ''}</div>${view.customerName ? `<p style="margin-top:14px">${i18n('preparedFor', { name: view.customerName })}<br><span class="aa-muted">${i18n('contact', { staff: view.staffName })}</span></p>` : ''}${view.expiresAt ? `<p class="aa-muted">${i18n('expires', { date: dateText(view.expiresAt) })}</p>` : ''}</section>`;
}

const pdfButton = () => `<p class="aa-muted">${i18n('keepCopy')}</p><div class="aa-actions"><button type="button" class="primary" data-action="pdf">${i18n('downloadPdf')}</button></div>`;

function message(titleKey, bodyKey, values = {}, extra = '') {
  app.innerHTML = `${view?.profile ? letterhead() : ''}<section class="aa-card"><h2>${i18n(titleKey)}</h2><p>${i18n(bodyKey, values)}</p>${extra}</section>`;
}

async function downloadPdf(button) {
  button.disabled = true; button.textContent = t('downloading');
  try {
    const response = await fetch('/api/account-applications/public/pdf', { headers: headers(), cache: 'no-store' });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Download failed.');
    const url = URL.createObjectURL(await response.blob()), anchor = document.createElement('a');
    anchor.href = url; anchor.download = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/u)?.[1] || 'account-application.pdf';
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (error) { notice(error instanceof TypeError ? t('connection') : error.message); }
  finally { button.disabled = false; button.textContent = t('downloadPdf'); }
}

function render() {
  document.getElementById('aaFooter').textContent = `${view.profile.legalName}${view.profile.hstNumber ? ` · HST ${view.profile.hstNumber}` : ''}`;
  if (view.status === 'expired') return message('expiredTitle', 'expiredBody', { staff: view.staffName });
  if (view.status === 'cancelled') return message('cancelledTitle', 'cancelledBody', { staff: view.staffName });
  if (view.status === 'submitted') return message('submittedTitle', 'submittedBody', { number: view.number, date: dateText(view.submittedAt) }, view.pdfAvailable ? pdfButton() : '');
  const provinceOptions = PROVINCES.map(([code, en, zh]) => `<option value="${code}" data-en="${escapeHtml(en)}" data-zh="${escapeHtml(zh)}" ${code === 'ON' ? 'selected' : ''}>${escapeHtml(language === 'zh-CN' ? zh : en)}</option>`).join('');
  const vault = view.cardVault?.available;
  app.innerHTML = `${letterhead()}<form id="aaForm" novalidate>
  <section class="aa-card"><h2>${i18n('sectionBusiness')}</h2><div class="aa-grid">
    <div class="wide">${field('legalName', 'legalName', `required maxlength="200" autocomplete="organization" value="${escapeHtml(view.customerName || '')}"`)}</div>
    <div class="wide">${field('tradeName', 'tradeName', 'maxlength="200"', 'tradeNameHelp')}</div>
    <div class="wide">${field('street', 'street', 'required maxlength="200" autocomplete="street-address"')}</div>
    ${field('city', 'city', 'required maxlength="100" autocomplete="address-level2"')}
    <label><span class="aa-required">${i18n('province')}</span><select name="province" required autocomplete="address-level1">${provinceOptions}</select></label>
    ${field('postalCode', 'postalCode', 'required maxlength="7" autocomplete="postal-code" placeholder="M1V 4Y3" style="text-transform:uppercase"')}
    ${field('phone', 'phone', 'required type="tel" maxlength="40" autocomplete="tel" placeholder="647-555-0123"')}
    <div class="wide">${field('email', 'email', 'required type="email" maxlength="254" autocomplete="email"')}</div>
  </div></section>
  <section class="aa-card"><h2 class="aa-required">${i18n('sectionNature')}</h2><p class="aa-help">${i18n('natureHelp')}</p>
    <label class="aa-check"><input type="checkbox" name="nature" value="renovation"><span>${i18n('renovation')}</span></label>
    <label class="aa-check"><input type="checkbox" name="nature" value="landscaping"><span>${i18n('landscaping')}</span></label></section>
  <section class="aa-card"><h2>${i18n('sectionDocs')}</h2>${vault ? `<p class="aa-help">${i18n('docsHelp')}</p>
    ${['business_card', 'drivers_license'].map((kind) => `<h3>${i18n(kind === 'business_card' ? 'businessCard' : 'driversLicense')}</h3><label class="aa-file-label"><input type="file" accept="image/*" capture="environment" data-upload="${kind}">${i18n('addPhoto')}</label><div class="aa-uploads" data-upload-list="${kind}"></div>`).join('')}`
    : `<div class="aa-notice info">${i18n('docsUnavailable')}</div>`}</section>
  <section class="aa-card"><h2>${i18n('sectionCard')}</h2>${vault ? `<label class="aa-check"><input type="checkbox" id="aaCardToggle"><span>${i18n('addCard')}</span></label>
    <div id="aaCardFields" hidden style="margin-top:14px"><p class="aa-help">${i18n('cardSecure')}</p><div class="aa-grid">
      <div class="wide">${field('cardholderName', 'cardName', 'maxlength="100" autocomplete="cc-name"')}</div>
      <div class="wide">${field('cardNumber', 'cardNumber', 'inputmode="numeric" maxlength="23" autocomplete="cc-number"')}</div>
      ${field('cardExpiry', 'cardExpiry', 'inputmode="numeric" maxlength="7" autocomplete="cc-exp" placeholder="MM/YY"')}
      ${field('cardCvv', 'cardCvv', 'inputmode="numeric" maxlength="4" autocomplete="cc-csc"')}
      <label class="aa-check wide"><input type="checkbox" name="cardAuthorized"><span data-lang-text data-en="${escapeHtml(view.cardAuthorization.en)}" data-zh="${escapeHtml(view.cardAuthorization.zh)}">${escapeHtml(language === 'zh-CN' ? view.cardAuthorization.zh : view.cardAuthorization.en)}</span></label>
    </div></div>` : `<div class="aa-notice info">${i18n('cardUnavailable')}</div>`}</section>
  <section class="aa-card"><h2>${i18n('sectionSign')}</h2><p data-lang-text data-en="${escapeHtml(view.attestation.en)}" data-zh="${escapeHtml(view.attestation.zh)}">${escapeHtml(language === 'zh-CN' ? view.attestation.zh : view.attestation.en)}</p>
    <label class="aa-check"><input type="checkbox" name="attestation" required><span>${i18n('agree')}</span></label>
    <div class="aa-grid" style="margin-top:16px">${field('signerName', 'printName', 'required maxlength="100" autocomplete="name"')}${field('signerTitle', 'signerTitle', 'required maxlength="100" autocomplete="organization-title"')}</div>
    <p style="margin:16px 0 6px"><strong class="aa-required">${i18n('signature')}</strong></p><p class="aa-help" id="aaSigHelp">${i18n('signatureHelp')}</p>
    <canvas id="aaSignature" class="aa-signature" tabindex="0" aria-describedby="aaSigHelp"></canvas>
    <div class="aa-actions" style="margin-top:10px"><button type="button" data-action="clear">${i18n('clear')}</button></div></section>
  <div class="aa-actions"><button class="primary" type="submit" id="aaSubmit">${i18n('submit')}</button></div></form>`;
  pad = drawSignature(document.getElementById('aaSignature'));
  uploads.length = 0;
  for (const upload of view.uploads || []) uploads.push({ ...upload, previewUrl: '' });
  renderUploads();
  document.getElementById('aaForm').addEventListener('submit', submit);
  document.getElementById('aaCardToggle')?.addEventListener('change', (event) => { document.getElementById('aaCardFields').hidden = !event.target.checked; });
  document.querySelectorAll('[data-upload]').forEach((input) => input.addEventListener('change', () => uploadFiles(input)));
}

function renderUploads() {
  for (const kind of ['business_card', 'drivers_license']) {
    const list = document.querySelector(`[data-upload-list="${kind}"]`);
    if (!list) continue;
    list.innerHTML = uploads.filter((upload) => upload.kind === kind).map((upload) => `<div class="aa-upload">${upload.previewUrl ? `<img src="${escapeHtml(upload.previewUrl)}" alt="">` : ''}<span>${upload.pending ? escapeHtml(t('uploading')) : `✓ ${escapeHtml(t('uploaded'))}`}</span>${upload.pending ? '' : `<button type="button" data-remove="${escapeHtml(upload.id)}">${escapeHtml(t('remove'))}</button>`}</div>`).join('');
    const input = document.querySelector(`[data-upload="${kind}"]`);
    if (input) input.closest('label').hidden = uploads.filter((upload) => upload.kind === kind).length >= MAX_UPLOADS_PER_KIND;
  }
}

async function prepareImage(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Image could not be prepared.'))), 'image/jpeg', 0.85));
  } finally { bitmap.close?.(); }
}

async function uploadFiles(input) {
  const kind = input.dataset.upload;
  const files = [...input.files];
  input.value = '';
  for (const file of files) {
    if (uploads.filter((upload) => upload.kind === kind).length >= MAX_UPLOADS_PER_KIND) { notice(t('maxImages', { count: MAX_UPLOADS_PER_KIND })); break; }
    const placeholder = { id: `pending-${crypto.randomUUID()}`, kind, pending: true, previewUrl: '' };
    uploads.push(placeholder); renderUploads();
    try {
      const blob = await prepareImage(file);
      placeholder.previewUrl = URL.createObjectURL(blob); renderUploads();
      const result = await api(`/uploads?kind=${encodeURIComponent(kind)}`, { method: 'POST', body: blob, json: false, contentType: 'image/jpeg' });
      Object.assign(placeholder, { id: result.id, size: result.size, pending: false });
      notice('');
    } catch (error) {
      uploads.splice(uploads.indexOf(placeholder), 1);
      notice(error instanceof TypeError ? t('connection') : error.message);
    }
    renderUploads();
  }
}

function readCard(form) {
  if (!document.getElementById('aaCardToggle')?.checked) return null;
  const expiry = String(form.cardExpiry.value || '').replace(/\s/gu, '');
  const match = /^(\d{1,2})\/?(\d{2}|\d{4})$/u.exec(expiry);
  return { cardholderName: form.cardholderName.value.trim(), number: form.cardNumber.value.replace(/[\s-]/gu, ''),
    expMonth: match ? Number(match[1]) : 0, expYear: match ? Number(match[2]) : 0, cvv: form.cardCvv.value.trim(),
    authorized: form.cardAuthorized.checked };
}

async function storeCard(card) {
  const fingerprint = JSON.stringify(card);
  if (cardCache?.fingerprint === fingerprint) return cardCache.summary;
  const ticket = await api('/card-ticket', { method: 'POST', body: {} });
  const response = await fetch(ticket.url, { method: 'POST', cache: 'no-store', referrerPolicy: 'no-referrer',
    headers: { authorization: `Bearer ${ticket.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ cardholderName: card.cardholderName, number: card.number, expMonth: card.expMonth, expYear: card.expYear, cvv: card.cvv || null }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(T[language][payload.code] || payload.error || t('cardInvalid'));
  cardCache = { fingerprint, summary: payload };
  return payload;
}

async function submit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const card = readCard(form);
  for (const name of ['cardholderName', 'cardNumber', 'cardExpiry', 'cardAuthorized']) if (form[name]) form[name].required = Boolean(card);
  if (!form.reportValidity()) return;
  const nature = [...form.querySelectorAll('input[name=nature]:checked')].map((input) => input.value);
  if (!nature.length) { notice(t('errNature')); return; }
  if (!pad.hasInk()) { notice(t('errSignature')); document.getElementById('aaSignature').focus(); return; }
  if (uploads.some((upload) => upload.pending)) { notice(t('uploading'), 'info'); return; }
  const button = document.getElementById('aaSubmit');
  button.disabled = true; button.textContent = t('submitting'); notice('');
  try {
    const cardSummary = card ? await storeCard(card) : null;
    const body = { legalName: form.legalName.value, tradeName: form.tradeName.value, street: form.street.value, city: form.city.value,
      province: form.province.value, postalCode: form.postalCode.value, phone: form.phone.value, email: form.email.value, nature,
      signerName: form.signerName.value, signerTitle: form.signerTitle.value, signatureDataUrl: pad.dataUrl(),
      uploadIds: uploads.map((upload) => upload.id), attestationAccepted: form.attestation.checked,
      card: cardSummary, cardAuthorized: Boolean(card?.authorized), language };
    const fingerprint = JSON.stringify(body);
    if (!submissionId || fingerprint !== attemptFingerprint) { submissionId = crypto.randomUUID(); attemptFingerprint = fingerprint; }
    const result = await api('/submit', { method: 'POST', body: { ...body, submissionId } });
    for (const upload of uploads) if (upload.previewUrl) URL.revokeObjectURL(upload.previewUrl);
    view.expiresAt = null;
    app.innerHTML = `${letterhead()}<section class="aa-card"><h2>${i18n('thanksTitle')}</h2><p>${i18n('thanksBody', { number: result.number })}</p>${pdfButton()}</section>`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    if (error.code === 'ACCOUNT_APPLICATION_CARD_CHANGED' || error.code === 'ACCOUNT_APPLICATION_CARD_INVALID') cardCache = null;
    notice(error instanceof TypeError ? t('connection') : error.message);
    button.disabled = false; button.textContent = t('submit');
  }
}

document.querySelectorAll('[data-lang]').forEach((button) => button.addEventListener('click', () => setLanguage(button.dataset.lang)));
app.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action],[data-remove]');
  if (!target) return;
  if (target.dataset.action === 'clear') { pad?.clear(); return; }
  if (target.dataset.action === 'pdf') { await downloadPdf(target); return; }
  if (target.dataset.remove) {
    target.disabled = true;
    try {
      await api(`/uploads/${encodeURIComponent(target.dataset.remove)}`, { method: 'DELETE' });
      const index = uploads.findIndex((upload) => upload.id === target.dataset.remove);
      if (index >= 0) { if (uploads[index].previewUrl) URL.revokeObjectURL(uploads[index].previewUrl); uploads.splice(index, 1); }
      renderUploads();
    } catch (error) { notice(error instanceof TypeError ? t('connection') : error.message); target.disabled = false; }
  }
});

setLanguage(language);
if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
  message('unavailableTitle', 'unavailableBody');
} else {
  api('/application').then((payload) => { view = payload; render(); setLanguage(language); })
    .catch((error) => { message('unavailableTitle', 'unavailableBody'); notice(error instanceof TypeError ? t('connection') : error.message); });
}

/* global HTMLElement, MutationObserver */
import { specialFulfillmentLabel } from './special-stock-fulfillment.js';

const appWindow = /** @type {Window & Record<string,any>} */ (window);
const tokenKeys = ['mbbs.staff.token', 'mbbs.dispatch.token', 'mbbs.control.token', 'mbbs.operator.token'];
const token = () => tokenKeys.map(key => localStorage.getItem(key)).find(Boolean) || '';
const methods = ['vendor_pickup', 'yard_pickup', 'mbt_delivery'];
let session = '', generation = 0, checking = false, refreshing = false, again = false, timer = 0, retry = 0;
/** @type {string[]} */ let audiences = [];
/** @type {any[]} */ let alerts = [];
/** @type {HTMLDialogElement|null} */ let dialog = null;
/** @type {HTMLButtonElement|null} */ let badge = null;
/** @type {HTMLElement|null} */ let previousFocus = null;
/** @type {{addEventListener:Function,close:Function}|null} */ let events = null;
const headers = () => ({ Accept: 'application/json', Authorization: `Bearer ${session}` });
/** @param {number} version */
const live = version => version === generation && token() === session;

function removeDialog() {
  dialog?.remove(); dialog = null;
  if (previousFocus?.isConnected) { previousFocus.focus(); }
  previousFocus = null;
}
function stop() {
  generation++; checking = false; refreshing = false; again = false; audiences = []; alerts = [];
  window.clearInterval(timer); window.clearTimeout(retry); timer = 0; retry = 0;
  events?.close(); events = null; badge?.remove(); badge = null; removeDialog();
}
/** @param {any} notice */
function validNotice(notice) {
  return notice && Number.isSafeInteger(notice.id) && notice.id > 0
    && Number.isSafeInteger(notice.requestId) && notice.requestId > 0 && audiences.includes(notice.audience)
    && methods.includes(notice.beforeMethod) && methods.includes(notice.fulfillmentMethod)
    && ['requestRef', 'yardName', 'salesOrderRef', 'purchaseOrderRef', 'purchaseOrderReference'].every(key => typeof notice[key] === 'string');
}
function paintBadge() {
  const host = document.querySelector('.dispatch-topbar .topbar-actions,.topbar .topbar-actions,.topbar > .actions')
    || document.querySelector('.dispatch-topbar,.topbar,.mbt-app-topbar') || document.body;
  if (!badge) {
    badge = document.createElement('button'); badge.type = 'button'; badge.className = 'special-delivery-method-alert';
    badge.addEventListener('click', () => { paint(); void refresh(); });
  }
  if (badge.parentElement !== host) { host.append(badge); }
  if (badge.hidden !== !alerts.length) { badge.hidden = !alerts.length; }
  const label = `Special delivery changes ${alerts.length}`;
  if (badge.textContent !== label) { badge.textContent = label; }
}
/** @param {any} notice @param {HTMLButtonElement} button @param {HTMLElement} message @param {number} version */
async function acknowledge(notice, button, message, version) {
  if (button.disabled) { return; }
  button.disabled = true; message.textContent = '';
  try {
    const response = await fetch(`/api/${notice.audience}/special-stock-requests/delivery-method-alerts/${notice.id}/ack`,
      { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) });
    if (!live(version) || !authorized(response)) { return; }
    const data = await response.json();
    if (!live(version)) { return; }
    if (!response.ok || data.acknowledged !== true) {
      message.textContent = data.error || 'Could not acknowledge the change. Please retry.'; return;
    }
    alerts = alerts.filter(row => row.id !== notice.id || row.audience !== notice.audience);
    removeDialog(); paint(); void refresh();
  } catch { if (live(version)) { message.textContent = 'Could not acknowledge the change. Please retry.'; } }
  finally { button.disabled = false; }
}
/** @param {any} notice */
function show(notice) {
  const version = generation;
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const modal = document.createElement('dialog'); dialog = modal; modal.className = 'special-delivery-method-dialog';
  modal.setAttribute('aria-labelledby', 'special-delivery-method-title');modal.dataset.osNotificationId=`special-delivery-method:${notice.audience}:${notice.id}`;
  const title = document.createElement('h2'); title.id = 'special-delivery-method-title'; title.textContent = 'Delivery method changed';
  const reference = document.createElement('p'); reference.textContent = notice.requestRef; reference.className = 'special-delivery-method-reference';
  const method = document.createElement('p'); method.textContent = `${specialFulfillmentLabel(notice.beforeMethod)} → ${specialFulfillmentLabel(notice.fulfillmentMethod)}`;
  const yard = document.createElement('p'); yard.textContent = `MBBS yard: ${notice.yardName || 'See request'}`;
  const orders = document.createElement('p'); orders.textContent = [notice.salesOrderRef && `SO: ${notice.salesOrderRef}`,
    notice.purchaseOrderRef && `PO: ${notice.purchaseOrderRef}`, notice.purchaseOrderReference && `PO reference: ${notice.purchaseOrderReference}`].filter(Boolean).join(' · ');
  const instruction = document.createElement('p'); instruction.textContent = notice.audience === 'scm'
    ? 'SCM: review the supply and transport arrangements for the new delivery method.'
    : 'Dispatch: review the transport arrangements for the new delivery method.';
  const message = document.createElement('p'); message.setAttribute('role', 'status');
  const controls = document.createElement('div'); controls.className = 'special-delivery-method-actions';
  const link = document.createElement('a'); link.textContent = notice.audience === 'scm' ? 'Open request' : 'Open Dispatch';
  link.href = notice.audience === 'scm' ? '/scm/stock-requests?tab=special&search=' + encodeURIComponent(notice.requestRef) : '/dispatch/special-stock';
  link.target = '_blank'; link.rel = 'noopener';
  const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Acknowledge';
  button.addEventListener('click', () => void acknowledge(notice, button, message, version));
  modal.addEventListener('cancel', event => event.preventDefault());
  controls.append(link, button); modal.append(title, reference, method, yard, orders, instruction, message, controls);
  document.body.append(modal); modal.showModal();
}
function paint() {
  if (!audiences.length) { return; }
  paintBadge();
  for(const notice of alerts) {
    void appWindow.MBBSOSNotifications?.notify({id:`special-delivery-method:${notice.audience}:${notice.id}`,title:'Delivery method changed',
      body:`${notice.requestRef} · ${specialFulfillmentLabel(notice.beforeMethod)} → ${specialFulfillmentLabel(notice.fulfillmentMethod)} · ${notice.yardName}`,
      url:notice.audience==='scm'?'/scm/stock-requests?tab=special&search='+encodeURIComponent(notice.requestRef):'/dispatch/special-stock',session});
  }
  if (document.hidden || dialog || !alerts.length || document.querySelector('dialog[open],[role="dialog"][aria-modal="true"]')) { return; }
  show(alerts[0]);
}
/** @param {Response} response */
function authorized(response) {
  if (response.status === 401 || response.status === 403) { stop(); session = ''; return false; }
  return true;
}
/** @returns {Promise<void>} */
async function refresh() {
  if (token() !== session) { return checkSession(); }
  if (!audiences.length) { return; }
  if (refreshing) { again = true; return; }
  refreshing = true; const version = generation;
  try {
    const next = [];
    for (const audience of audiences) {
      const response = await fetch(`/api/${audience}/special-stock-requests/delivery-method-alerts`,
        { cache: 'no-store', headers: headers(), signal: AbortSignal.timeout(10000) });
      if (!live(version) || !authorized(response) || !response.ok) { return; }
      const data = await response.json();
      if (!live(version) || !Array.isArray(data.alerts) || !data.alerts.every(validNotice)) { return; }
      next.push(...data.alerts);
    }
    // Leave a visible notice intact until its owner acknowledges it. New notices
    // queue behind it; a successful refresh can only remove acknowledged ones.
    const current = alerts[0]; alerts = next;
    if (dialog && !next.some(row => row.id === current?.id && row.audience === current?.audience)) { removeDialog(); }
    paint();
  } catch { /* Persistent notices remain available after a temporary connection failure. */ }
  finally { if (live(version)) { refreshing = false; if (again) { again = false; void refresh(); } } }
}
function startEvents() {
  timer = window.setInterval(() => void refresh(), 30000);
  if (!('EventSource' in window)) { return; }
  const stream = appWindow.MBBSAppEventStream?.connect('/api/events?client=special-delivery-method-alert') || new EventSource('/api/events?client=special-delivery-method-alert');
  events = stream;
  stream.addEventListener('open', () => void refresh());
  stream.addEventListener('app-event', /** @param {MessageEvent} event */ event => {
    try { if (['special-stock-request.updated', 'dispatch.orders.updated'].includes(JSON.parse(event.data).type)) { void refresh(); } }
    catch { /* Ignore invalid invalidations. */ }
  });
}
/** @returns {Promise<void>} */
async function checkSession() {
  const current = token();
  if (current !== session) { stop(); session = current; }
  if (!current || checking) { return; }
  if (audiences.length) { return refresh(); }
  checking = true; const version = generation;
  try {
    const response = await fetch('/api/auth/me', { cache: 'no-store', headers: headers(), signal: AbortSignal.timeout(10000) });
    if (!live(version) || !authorized(response) || !response.ok) { return; }
    const { operator } = await response.json();
    if (!live(version) || !operator?.id || operator.publicSales) { return; }
    const roles = [operator.role, ...(operator.roles || [])];
    if (roles.some(role => ['admin', 'scm', 'scm_staff'].includes(role))) { audiences.push('scm'); }
    if (roles.some(role => ['admin', 'dispatcher'].includes(role))) { audiences.push('dispatch'); }
    if (audiences.length) { startEvents(); await refresh(); }
  } catch { /* Retry session verification on focus or after the retry interval. */ }
  finally {
    if (live(version)) {
      checking = false;
      if (!audiences.length) { retry = window.setTimeout(() => void checkSession(), 30000); }
    }
  }
}
function recheckSession() { stop(); void checkSession(); }

const style = document.createElement('style');
style.textContent = `.special-delivery-method-alert{padding:6px 10px;border:1px solid #c2410c;border-radius:8px;background:#fff7ed;color:#9a3412;font:700 12px/1.4 system-ui;cursor:pointer}.special-delivery-method-alert[hidden]{display:none}.special-delivery-method-dialog{box-sizing:border-box;width:min(560px,calc(100% - 32px));max-height:85vh;overflow:auto;border:1px solid #c2410c;border-radius:14px;padding:24px;background:white;color:#172033;font:16px/1.5 system-ui}.special-delivery-method-dialog::backdrop{background:rgb(15 23 42 / 45%)}.special-delivery-method-dialog h2{margin:0 0 14px;font-size:21px}.special-delivery-method-dialog p{overflow-wrap:anywhere}.special-delivery-method-reference{font-weight:700}.special-delivery-method-actions{display:flex;align-items:center;justify-content:flex-end;gap:16px;flex-wrap:wrap}.special-delivery-method-actions button{padding:10px 16px;border:0;border-radius:8px;background:#c2410c;color:white;font:inherit;cursor:pointer}.special-delivery-method-actions button:disabled{opacity:.6}.special-delivery-method-actions a{color:#9a3412}.special-delivery-method-dialog [role=status]{color:#b91c1c}`;
document.head.append(style);
new MutationObserver(paint).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'aria-modal'] });
appWindow.MBBSSpecialDeliveryMethodAlerts = { refresh };
window.addEventListener('mbbs-auth-operator-changed', recheckSession);
window.addEventListener('storage', event => { if (!event.key || tokenKeys.includes(event.key)) { recheckSession(); } });
window.addEventListener('focus', recheckSession);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { recheckSession(); } });
window.addEventListener('pageshow', () => void checkSession());
window.addEventListener('pagehide', stop);
void checkSession();

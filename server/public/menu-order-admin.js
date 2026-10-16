import {orderMenuItems,moveMenuItem} from './menu-order-model.js?v=20261006';

const app = document.getElementById('menuOrderAdmin');
const escape = value => String(value ?? '').replace(/[&<>"']/gu, character =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
let snapshot;
let draft = {};
let group = 'main';
let busy = false;
let message = '';
let failure = false;
let dragged = '';

function dirty() {return JSON.stringify(draft) !== JSON.stringify(snapshot.orders);}
function currentMenu() {return snapshot.catalog.find(menu => menu.key === group);}
function currentItems() {return orderMenuItems(currentMenu().items,draft[group]);}
async function api(options = {}) {
  const token = localStorage.getItem('mbbs.staff.token') || localStorage.getItem('mbbs.control.token') || '';
  const response = await fetch('/api/admin/menu-order',{...options,cache:'no-store',
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`}});
  const data = await response.json();
  if (!response.ok) {throw new Error(data.error || 'Unable to load menu order.');}
  return data;
}

function render(focusHref = '') {
  const menu = currentMenu();
  const items = currentItems();
  app.innerHTML = `<header class="menu-order-header"><div><p>MBBS · ADMIN</p><h1>Menu order</h1></div><a href="/admin">Administration</a></header>
    <section class="menu-order-card"><p class="menu-order-help">Arrange the shared sidebar and menu cards. Drag a row or use the arrow buttons to move it.</p>
    <div class="menu-order-toolbar"><label>Menu<select id="menuOrderGroup" ${busy ? 'disabled' : ''}>${snapshot.catalog.map(entry => `<option value="${escape(entry.key)}" ${entry.key === group ? 'selected' : ''}>${escape(entry.label)}</option>`).join('')}</select></label>
    <div class="menu-order-actions"><button data-action="reset-menu" ${busy ? 'disabled' : ''}>Reset this menu</button><button data-action="reset-all" ${busy ? 'disabled' : ''}>Reset all menus</button></div></div>
    <ol class="menu-order-list" aria-label="${escape(menu.label)} menu order">${items.map((item,index) => `<li class="menu-order-row" draggable="${!busy}" data-href="${escape(item.href)}"><span class="menu-order-grip" aria-hidden="true">⠿</span><span class="menu-order-number">${index + 1}</span><span class="menu-order-label">${escape(item.label)}</span><div class="menu-order-move"><button data-action="up" aria-label="Move ${escape(item.label)} up" ${busy || index === 0 ? 'disabled' : ''}>↑</button><button data-action="down" aria-label="Move ${escape(item.label)} down" ${busy || index === items.length - 1 ? 'disabled' : ''}>↓</button></div></li>`).join('')}</ol>
    <div class="menu-order-footer"><button class="primary" data-action="save" ${busy || !dirty() ? 'disabled' : ''}>${busy ? 'Saving…' : 'Save menu order'}</button><button data-action="reload" ${busy ? 'disabled' : ''}>Reload saved order</button><span class="menu-order-dirty">${dirty() ? 'Unsaved changes' : 'Saved order'}</span></div>
    <p class="menu-order-status ${failure ? 'error' : ''}" role="status">${escape(message)}</p><p class="menu-order-note">Applies to everyone. Users continue to see only the menus they can access.</p></section>`;
  if (focusHref) {
    const row = [...app.querySelectorAll('[data-href]')].find(node => node.dataset.href === focusHref);
    row?.querySelector('button:not(:disabled)')?.focus({preventScroll:true});
  }
}

function move(href,to) {
  if (busy) {return;}
  const items = currentItems().map(item => item.href);
  const from = items.indexOf(href);
  if (from < 0 || to < 0 || to >= items.length) {return;}
  draft[group] = moveMenuItem(items,from,to);
  message = 'Order changed. Save to apply it.';
  failure = false;
  render(href);
}

async function load() {
  try {
    snapshot = await api();
    draft = structuredClone(snapshot.orders);
    message = '';
    failure = false;
    render();
  } catch (error) {
    if (snapshot) {message = error.message;failure = true;render();}
    else {app.innerHTML = `<p class="menu-order-status error" role="alert">${escape(error.message)}</p><button data-action="reload">Try again</button>`;}
  }
}

async function save() {
  busy = true;message = '';failure = false;render();
  try {
    const saved = await api({method:'PUT',body:JSON.stringify({orders:draft,expectedRevision:snapshot.revision})});
    snapshot = {...snapshot,...saved};draft = structuredClone(saved.orders);
    window.MBBSMenuOrder?.setSnapshot(saved);
    localStorage.setItem('mbbs.menu-order.saved',String(saved.revision));
    message = 'Menu order saved for everyone.';
  } catch (error) {message = error.message;failure = true;}
  finally {busy = false;render();}
}

app.addEventListener('change',event => {
  if (event.target.id === 'menuOrderGroup') {group = event.target.value;render();}
});
app.addEventListener('click',event => {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled || busy) {return;}
  const action = button.dataset.action;
  if (action === 'save') {void save();return;}
  if (action === 'reload') {
    if (!snapshot || !dirty() || window.confirm('Discard unsaved menu changes and reload?')) {void load();}
    return;
  }
  if (action === 'reset-menu' || action === 'reset-all') {
    if (action === 'reset-menu') {delete draft[group];} else {draft = {};}
    message = 'Default order restored. Save to apply it.';failure = false;render();return;
  }
  const href = button.closest('[data-href]')?.dataset.href;
  const index = currentItems().findIndex(item => item.href === href);
  move(href,index + (action === 'up' ? -1 : 1));
});
app.addEventListener('dragstart',event => {
  if (busy) {event.preventDefault();return;}
  dragged = event.target.closest('[data-href]')?.dataset.href || '';
  event.dataTransfer?.setData('text/plain',dragged);
});
app.addEventListener('dragover',event => {
  const row = event.target.closest('[data-href]');
  if (dragged && row && !busy) {event.preventDefault();row.classList.add('drag-over');}
});
app.addEventListener('dragleave',event => {event.target.closest('[data-href]')?.classList.remove('drag-over');});
app.addEventListener('drop',event => {
  const row = event.target.closest('[data-href]');
  if (!dragged || !row || busy) {return;}
  event.preventDefault();
  move(dragged,currentItems().findIndex(item => item.href === row.dataset.href));
  dragged = '';
});
app.addEventListener('dragend',() => {dragged = '';app.querySelectorAll('.drag-over').forEach(row => row.classList.remove('drag-over'));});
window.addEventListener('beforeunload',event => {if (snapshot && dirty()) {event.preventDefault();event.returnValue = '';}});
window.requireDispatchLogin({mount:app,roles:['admin'],allowPublicSales:false,onReady:() => load()});

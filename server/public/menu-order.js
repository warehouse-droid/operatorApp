import {normalizeMenuOrders,orderMenuItems} from './menu-order-model.js?v=20261006';

let snapshot = {revision:0,orders:{}};
let pending = null;
let timer = null;
const originalCards = new WeakMap();

function cardHref(card) {
  return card.dataset.menuHref
    || card.getAttribute('onclick')?.match(/location\.href\s*=\s*['"]([^'"]+)['"]/u)?.[1] || '';
}

function orderCards() {
  for (const grid of document.querySelectorAll('[data-menu-group]')) {
    const cards = [...grid.children].filter(node => node.matches('.dispatch-menu-card'));
    const previous = originalCards.get(grid) || [];
    const defaults = [...previous.filter(node => cards.includes(node)), ...cards.filter(node => !previous.includes(node))];
    originalCards.set(grid,defaults);
    const ordered = orderMenuItems(defaults.map(node => ({href:cardHref(node),node})), snapshot.orders[grid.dataset.menuGroup])
      .map(row => row.node);
    if (ordered.every((node,index) => node === cards[index])) {continue;}
    const focused = grid.contains(document.activeElement) ? document.activeElement : null;
    for (const card of ordered) {grid.appendChild(card);}
    focused?.focus({preventScroll:true});
  }
}

function setSnapshot(value) {
  if (!Number.isSafeInteger(value?.revision) || value.revision < snapshot.revision) {return;}
  let orders;
  try {orders = normalizeMenuOrders(value.orders);} catch {return;}
  if (value.revision === snapshot.revision) {return;}
  snapshot = {revision:value.revision,orders};
  orderCards();
  window.dispatchEvent(new CustomEvent('mbbs-menu-order-changed',{detail:{revision:snapshot.revision}}));
}

async function refresh() {
  if (pending) {return pending;}
  pending = (async () => {
    try {
      const response = await fetch('/api/navigation/menu-order',{cache:'no-store',signal:AbortSignal.timeout(5000)});
      if (response.ok) {setSnapshot(await response.json());}
    } catch { /* Existing navigation remains usable during a failed refresh. */ }
    finally {pending = null;}
  })();
  return pending;
}

function start() {
  if (!timer) {timer = window.setInterval(() => {if (!document.hidden) {void refresh();}},60000);}
  void refresh();
}

window.MBBSMenuOrder = {
  sort:(group,items) => orderMenuItems(items,snapshot.orders[group]),
  setSnapshot,
  refresh
};
const observer = new MutationObserver(orderCards);
observer.observe(document.body,{childList:true,subtree:true});
window.addEventListener('focus',() => {void refresh();});
window.addEventListener('pageshow',start);
window.addEventListener('pagehide',() => {window.clearInterval(timer);timer = null;});
window.addEventListener('storage',event => {if (event.key === 'mbbs.menu-order.saved') {void refresh();}});
document.addEventListener('visibilitychange',() => {if (!document.hidden) {void refresh();}});
orderCards();
start();

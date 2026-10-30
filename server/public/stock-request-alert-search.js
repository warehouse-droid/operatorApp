import {requestSearchRefs} from './stock-request-search.js?v=20261023';

const regularFilters = ['queue','bucket','unifiedStatus','outcome','waitingReason','requestTypeFilter','backorderStageFilter','vendorFilter','requestDateFilter','sourceLocationFilter','destinationLocationFilter'];
const specialFilters = ['stages','storeLocationIds','vendorNames','mine'];
const token = () => ['mbbs.staff.token','mbbs.dispatch.token','mbbs.control.token','mbbs.operator.token'].map(key => localStorage.getItem(key)).find(Boolean) || '';

export function createStockAlertSearch({audience, tab, state, read}) {
  const fields = tab === 'special' ? specialFilters : regularFilters;
  let storageKey = '', initialized = false, alertText = null, pending = false, returnedPools = [];
  function save() {
    if (!storageKey) return;
    try {localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(fields.filter(key => key in state).map(key => [key,state[key]]))));} catch { /* Storage can be disabled. */ }
  }
  window.addEventListener('pagehide', save);
  async function initialize(operator) {
    if (initialized) return;
    storageKey = operator?.id ? `mbbs.${audience}.${tab}.requestFilters.${operator.id}` : '';
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
      for (const key of fields) {
        if (key in state && key in saved && typeof saved[key] === typeof state[key] && Array.isArray(saved[key]) === Array.isArray(state[key])) state[key] = saved[key];
      }
    } catch { /* Keep the existing defaults if stored preferences are invalid. */ }
    const url = new URL(location.href);
    if (url.searchParams.get('tab') === tab) {
      if (url.searchParams.has('search')) state.search = url.searchParams.get('search');
      if (url.searchParams.get('alerts') === '1') {
        pending = true;
        const session = token();
        const data = await read(`/api/${audience}/${tab === 'special' ? 'special-stock-requests' : 'stock-requests'}/alerts?includeRequests=1`, {signal:AbortSignal.timeout(15000)});
        if (token() !== session) throw new Error('Your session changed. Sign in again to see updates.');
        const refs = [...new Set((data.requests || []).map(row => row.requestRef).filter(Boolean))];
        returnedPools = data.returnedPools || [];
        state.search = refs.join(', ');
        alertText = state.search;
        pending = false;
        if (!refs.length && !returnedPools.length) {
          alertText = null;
          url.searchParams.delete('alerts');
          history.replaceState(null, '', url);
        }
      }
    }
    initialized = true;
  }
  function params(input) {
    save();
    const result = new URLSearchParams(input);
    if (alertText !== null && state.search !== alertText) {
      alertText = null;
      const url = new URL(location.href);
      url.searchParams.delete('alerts');
      url.searchParams.delete('search');
      url.searchParams.delete('requestId');
      url.searchParams.delete('requestRef');
      history.replaceState(null, '', url);
    }
    if (alertText !== null) {
      // Preserve the controls and account preferences while showing the alert
      // results across workflow states. Clearing search restores those filters.
      for (const key of ['queue','bucket','status','unifiedStatus','outcome','waitingReason','type','stage','stages','vendor','vendors','vendorNames','requestDate','sourceLocationIds','destinationLocationIds','storeLocationIds']) result.delete(key);
      result.set('allStatuses', '1');
    }
    return result;
  }
  function focusRequest(reference) {
    state.search = String(reference || '');
    alertText = state.search;
  }
  async function load(path, options) {
    if (pending) await initialize(state.operator);
    if (alertText === '') return {requests:[]};
    const url = new URL(path, location.origin), refs = requestSearchRefs(url.searchParams.get('search'));
    if (refs.length < 2) return read(path, options);
    // Bound URL length and hydration work without truncating the alert list.
    let result;
    const requests = new Map();
    for (let offset = 0; offset < refs.length; offset += 100) {
      url.searchParams.set('search', refs.slice(offset, offset + 100).join(', '));
      url.searchParams.set('limit', '100');
      const page = await read(url.pathname + url.search, options);
      result ||= page;
      for (const row of page.requests || []) requests.set(row.id, row);
    }
    return {...result, requests:[...requests.values()]};
  }
  function paint(mount) {
    mount.querySelector('[data-stock-alert-search]')?.remove();
    mount.querySelector('[data-returned-stock-alerts]')?.remove();
    if (alertText !== null && alertText !== '') {
      const hint = document.createElement('div');
      hint.className = 'stock-request-notice';
      hint.dataset.stockAlertSearch = '';
      hint.textContent = window.MBBS_I18N?.language?.() === 'zh-CN'
        ? '正在显示有提醒的申请。清空搜索即可使用您选择的筛选条件。'
        : 'Showing alerted requests. Clear search to use your selected filters.';
      mount.querySelector('.stock-request-feedback')?.append(hint);
    }
    if (!returnedPools.length || alertText === null) return;
    const notice = document.createElement('div');
    notice.className = 'stock-request-notice';
    notice.dataset.returnedStockAlerts = '';
    notice.append(document.createTextNode(window.MBBS_I18N?.language?.() === 'zh-CN' ? '候补库存已退回 · 重新分配：' : 'Waitlist stock returned · Re-allocate: '));
    for (const pool of returnedPools) {
      const link = document.createElement('a');
      link.href = `/${audience}/stock-requests?tab=waitlist&poolId=${Number(pool.id)}`;
      link.textContent = [pool.purchaseOrderRef,pool.itemCode].filter(Boolean).join(' · ');
      notice.append(link, document.createTextNode(' '));
    }
    mount.querySelector('.stock-request-feedback')?.append(notice);
  }
  return {initialize, params, load, save, paint, focusRequest};
}

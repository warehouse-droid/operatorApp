const token = () => ['mbbs.staff.token','mbbs.dispatch.token','mbbs.control.token','mbbs.operator.token'].map(key => localStorage.getItem(key)).find(Boolean) || '';
const t = (en, zh) => window.MBBS_I18N?.language?.() === 'zh-CN' ? zh : en;
let current = null;

export function requestAlertLink(audience, tab, id, requestRef = '') {
  const base = `/${audience}/stock-requests`;
  const params = new URLSearchParams({tab, requestId:String(id)});
  if (requestRef) params.set('requestRef', requestRef);
  return base + '?' + params;
}

export function regularAlertRows(data, audience) {
  return [
    ...[...(data.requests || []),...(data.stockChecks || [])].map(row => ({
      requestRef:row.requestRef, category:row.special ? t('Special','特殊商品') : t('Regular','常规'),
      summary:[row.itemName,row.message,row.purchaseOrderRef && `PO: ${row.purchaseOrderRef}`,row.eta && `ETA: ${row.eta}`].filter(Boolean).join(' · '),
      href:row.action === 'waitlist' && row.waitlistRequestId
        ? requestAlertLink(audience,'waitlist',row.waitlistRequestId,row.waitlistRequestRef)
        : requestAlertLink(audience,row.special ? 'special' : 'regular',row.id,row.requestRef)
    })),
    ...(data.returnedPools || []).map(row => ({requestRef:row.purchaseOrderRef, category:t('Waitlist','候补'),
      summary:[row.itemCode,t('Stock returned — re-allocate','库存已退回，请重新分配')].filter(Boolean).join(' · '),
      href:`/${audience}/stock-requests?tab=waitlist&poolId=${row.id}`}))
  ];
}

export function specialAlertRows(data, audience) {
  return (data.requests || []).map(row => ({requestRef:row.requestRef,category:t('Special','特殊商品'),
    summary:[row.customerName,(row.stage || '').replaceAll('_',' ')].filter(Boolean).join(' · '),
    href:requestAlertLink(audience,'special',row.id,row.requestRef)}));
}

export async function getAlertData(path, session, signal) {
  const response = await fetch(path,{cache:'no-store',signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),headers:{Accept:'application/json',Authorization:`Bearer ${session}`}});
  if (!response.ok) throw Object.assign(new Error(response.status === 401 || response.status === 403
    ? t('Your session changed. Sign in again to see updates.','登录状态已改变，请重新登录查看更新。')
    : t('Could not load updates. Please try again.','无法加载更新，请重试。')),{status:response.status});
  return response.json();
}

function node(tag, value = '') {const element = document.createElement(tag); element.textContent = value; return element;}

/** Display every request without acknowledging any of its updates. */
export function openStockRequestAlertList({title, rows = [], load, session = token()}) {
  if (!session || token() !== session) return null;
  current?.close();
  const previous = document.activeElement, dialog = node('dialog');
  dialog.className = 'stock-request-alert-list';dialog.dataset.stockRequestAlertList = '';
  const heading = node('h2', title);heading.id = 'stock-request-alert-list-title';dialog.setAttribute('aria-labelledby',heading.id);
  const header = node('div'), close = node('button',t('Close','关闭'));
  header.className = 'stock-request-alert-list-heading';close.type = 'button';close.dataset.alertListClose = '';
  header.append(heading,close);
  const count = node('p'), status = node('p'), list = node('ul'), refresh = node('button',t('Refresh updates','刷新更新'));
  count.dataset.alertListCount = '';status.setAttribute('role','status');status.dataset.alertListStatus = '';
  list.dataset.alertListRequests = '';refresh.type = 'button';refresh.dataset.alertListRefresh = '';refresh.hidden = !load;
  dialog.append(header,count,status,list,refresh);
  let controller = null, version = 0, closed = false;
  function closeList() {
    if (closed) return;
    closed = true;version++;controller?.abort();dialog.remove();
    if (current === handle) current = null;
    if (previous?.isConnected) previous.focus();
  }
  const handle = {close:closeList};current = handle;
  function paint(items) {
    const grouped = new Map();
    for (const row of items || []) {
      let href;
      try {href = new URL(row.href,location.href);} catch {continue;}
      if (href.origin !== location.origin || !/^\/(sales|scm|dispatch)\//.test(href.pathname)) continue;
      const key = href.pathname + href.search;
      if (!grouped.has(key)) grouped.set(key,{...row,href:key,summaries:new Set()});
      if (row.summary) grouped.get(key).summaries.add(row.summary);
    }
    list.replaceChildren();
    count.textContent = t(`${grouped.size} requests with updates`,`${grouped.size} 份申请有更新`);
    if (!grouped.size) list.append(node('li',t('No pending updates.','暂无待处理更新。')));
    for (const row of grouped.values()) {
      const item = node('li'), details = node('div'), reference = node('strong',row.requestRef || t('Stock request','库存申请'));
      item.dataset.alertListRequest = '';details.append(reference,node('small',row.category || ''),node('p',[...row.summaries].join('\n')));
      const open = node('a',t('Open request','打开申请'));open.href = row.href;open.target = '_blank';open.rel = 'noopener';
      open.setAttribute('aria-label',t(`Open ${row.requestRef || 'request'} in a new tab`,`在新标签页打开 ${row.requestRef || '申请'}`));
      item.append(details,open);list.append(item);
    }
  }
  async function refreshRows() {
    if (!load || closed) return;
    const ownVersion = ++version;controller?.abort();controller = new AbortController();
    refresh.disabled = true;status.textContent = t('Loading updates…','正在加载更新…');
    try {
      const items = await load(controller.signal);
      if (closed || ownVersion !== version) return;
      if (token() !== session) {closeList();return;}
      paint(items);status.textContent = '';
    } catch (error) {
      if (!closed && ownVersion === version && [401,403].includes(error.status)) {list.replaceChildren();count.textContent='';}
      if (!closed && ownVersion === version) status.textContent = error.name === 'AbortError'
        ? t('Loading timed out. Please refresh updates.','加载超时，请刷新更新。')
        : error.message || t('Could not load updates. Please try again.','无法加载更新，请重试。');
    } finally {if (!closed && ownVersion === version) refresh.disabled = false;}
  }
  close.addEventListener('click',closeList);
  dialog.addEventListener('cancel',event => {event.preventDefault();closeList();});
  refresh.addEventListener('click',() => void refreshRows());
  paint(rows);document.body.append(dialog);dialog.showModal();
  if (load) void refreshRows();
  return handle;
}

const style = node('style',`.stock-request-alert-list{box-sizing:border-box;width:min(780px,calc(100vw - 24px));max-height:88vh;overflow:auto;padding:22px;border:1px solid #94a3b8;border-radius:14px;background:#fff;color:#0f172a;font:15px/1.5 system-ui}.stock-request-alert-list::backdrop{background:#0f172a66}.stock-request-alert-list-heading{display:flex;align-items:start;justify-content:space-between;gap:16px}.stock-request-alert-list h2{margin:0;font-size:21px}.stock-request-alert-list ul{list-style:none;margin:16px 0;padding:0}.stock-request-alert-list li{display:flex;align-items:center;justify-content:space-between;gap:16px;border-top:1px solid #e2e8f0;padding:14px 0}.stock-request-alert-list li>div{min-width:0;overflow-wrap:anywhere}.stock-request-alert-list small{display:block;color:#475569}.stock-request-alert-list li p{white-space:pre-wrap;margin:4px 0 0}.stock-request-alert-list button,.stock-request-alert-list a{font:inherit;padding:8px 12px;border:1px solid #0f766e;border-radius:8px;background:#f0fdfa;color:#134e4a;cursor:pointer}.stock-request-alert-list a{flex-shrink:0;text-decoration:none}.stock-request-alert-list [role=status]:empty{display:none}.stock-request-alert-list [role=status]{color:#9a3412}.stock-request-alert-list :focus-visible{outline:3px solid #0f766e;outline-offset:2px}@media(max-width:480px){.stock-request-alert-list{padding:16px}.stock-request-alert-list li{align-items:start;gap:10px}.stock-request-alert-list li a{font-size:13px}}`);
document.head.append(style);
window.addEventListener('mbbs-auth-operator-changed',() => current?.close());
window.addEventListener('storage',event => {if (event.key === null || ['mbbs.staff.token','mbbs.dispatch.token','mbbs.control.token','mbbs.operator.token'].includes(event.key)) current?.close();});
window.addEventListener('pagehide',() => current?.close());

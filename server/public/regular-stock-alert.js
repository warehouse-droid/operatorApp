(() => {
  if (window.MBBSRegularStockAlert) return;
  const keys = ['mbbs.staff.token','mbbs.dispatch.token','mbbs.control.token','mbbs.operator.token'];
  const token = () => keys.map(key=>localStorage.getItem(key)).find(Boolean)||'';
  const t = (en,zh) => window.MBBS_I18N?.language?.()==='zh-CN'?zh:en;
  let session='',generation=0,controller=null,events=null,timer=null,observer=null,checking=null;
  let audiences=[],counts={},links={};
  let actorId='',dialog=/** @type {HTMLDialogElement|null} */ (null),previousFocus=null,pendingRefresh=false;
  const displayed=new Map();
  const stockChecks=new Map();
  let stockChecksInitialized=false;
  function popupSeen(key){try{return JSON.parse(localStorage.getItem(key)||'{}');}catch{return {};}}
  function savePopupSeen(key,seen){
    try{localStorage.setItem(key,JSON.stringify(Object.fromEntries(Object.entries(seen).sort((a,b)=>Number(b[1])-Number(a[1])).slice(0,300))));}catch{ /* Keep in-memory deduplication if storage is unavailable. */ }
  }
  function syncStockChecks(rows){
    if(!Array.isArray(rows)||!actorId)return;
    const key=`mbbs.stockCheck.popup.${actorId}`,seen=popupSeen(key);
    let firstUse=false;try{firstUse=!stockChecksInitialized&&localStorage.getItem(key)===null;}catch{firstUse=!stockChecksInitialized;}
    stockChecksInitialized=true;
    for(const row of rows){
      if(row.action!=='stock_check'||!Number.isSafeInteger(row.id)||row.id<=0||!Number.isSafeInteger(row.eventId)||row.eventId<=0)continue;
      if(firstUse){seen[row.id]=row.eventId;displayed.set('check:'+row.id,row.eventId);}
      else if(row.eventId>Math.max(Number(seen[row.id])||0,displayed.get('check:'+row.id)||0))stockChecks.set(row.id,row);
    }
    if(firstUse)savePopupSeen(key,seen);
  }
  function closePopup(){
    dialog?.remove();dialog=null;
    if(previousFocus?.isConnected)previousFocus.focus();previousFocus=null;
  }
  function popup(){
    if(!actorId)return;
    const key=`mbbs.regular.stock.popup.${actorId}`;
    const seen=popupSeen(key),checkKey=`mbbs.stockCheck.popup.${actorId}`,checkSeen=popupSeen(checkKey);
    const candidates=[...stockChecks.values(),...(counts.sales?.requests||[])].filter(item=>['stock_check','reply','resolve','waitlist','backorder'].includes(item.action)&&Number.isSafeInteger(item.id)&&item.id>0
      && !(item.action==='backorder' && Number(document.querySelector('[data-backorder-id]')?.getAttribute('data-backorder-id'))===item.id)
      &&Number.isSafeInteger(item.eventId)&&item.eventId>Math.max(Number((item.action==='stock_check'?checkSeen:seen)[item.id])||0,displayed.get(item.action==='stock_check'?'check:'+item.id:item.id)||0));
    for(const item of candidates) {
      void window.MBBSOSNotifications?.notify({id:`regular-stock:${item.id}:${item.eventId}`,title:item.action==='stock_check'?'SCM updated the stock check':'Stock request updated',
        body:[item.requestRef,item.itemName,item.message,item.purchaseOrderRef && `PO: ${item.purchaseOrderRef}`,item.eta && `ETA: ${item.eta}`].filter(Boolean).join(' · '),
        url:item.action==='waitlist'&&item.waitlistRequestId?`/sales/stock-requests?tab=waitlist&requestId=${item.waitlistRequestId}`:item.special?`/sales/stock-requests?tab=special&search=${encodeURIComponent(item.requestRef)}`:`/sales/stock-requests?tab=regular&requestId=${item.id}`,session});
    }
    const row=candidates[0];
    if(!row||document.hidden||dialog||document.querySelector('dialog[open],[role="dialog"][aria-modal="true"]'))return;
    if(row.action==='stock_check')stockChecks.delete(row.id);
    if(row.action==='stock_check'){
      displayed.set('check:'+row.id,row.eventId);checkSeen[row.id]=row.eventId;savePopupSeen(checkKey,checkSeen);
      const duplicate=counts.sales?.requests?.find(item=>item.id===row.id&&item.action==='backorder'&&!item.message?.includes('PO linked:'));
      if(duplicate){seen[row.id]=duplicate.eventId;displayed.set(row.id,duplicate.eventId);savePopupSeen(key,seen);}
    }else{displayed.set(row.id,row.eventId);seen[row.id]=row.eventId;savePopupSeen(key,seen);}
    previousFocus=document.activeElement;
    const modal=document.createElement('dialog');dialog=modal;modal.className='regular-stock-popup';modal.dataset.osNotificationId=`regular-stock:${row.id}:${row.eventId}`;modal.setAttribute('aria-labelledby','regular-stock-popup-title');
    if(row.action==='backorder')modal.dataset.backorderId=String(row.id);
    const title=document.createElement('h2');title.id='regular-stock-popup-title';title.textContent=row.action==='stock_check'?t('SCM updated the stock check','SCM 已更新库存检查'):row.action==='backorder'?t('Backorder update','欠货申请更新'):row.action==='waitlist'?t('Stocking item moved to waitlist','备货商品已转入候补清单'):row.action==='resolve'?t('Stocking material resolved','备货商品已解决'):t('SCM replied to your Stocking material','SCM 已回复您的备货商品');
    const reference=document.createElement('p');reference.textContent=[row.requestRef,row.itemName].filter(Boolean).join(' · ');
    const message=document.createElement('p');message.style.whiteSpace='pre-wrap';message.textContent=row.message||t('Open the request to review the resolution.','请打开申请查看处理结果。');
    const details=document.createElement('p');details.textContent=[row.purchaseOrderRef?`PO: ${row.purchaseOrderRef}`:'',row.eta?`ETA: ${row.eta}`:''].filter(Boolean).join(' · ');
    const controls=document.createElement('div'),open=document.createElement('a'),close=document.createElement('button');
    controls.className='stock-request-actions';open.textContent=t('Open request','打开申请');open.href=`/sales/stock-requests?tab=regular&requestId=${row.id}`;
    if(row.special)open.href=`/sales/stock-requests?tab=special&search=${encodeURIComponent(row.requestRef)}`;
    if(row.action==='waitlist'&&Number.isSafeInteger(row.waitlistRequestId)&&row.waitlistRequestId>0)open.href=`/sales/stock-requests?tab=waitlist&requestId=${row.waitlistRequestId}`;
    close.type='button';close.textContent=t('Close','关闭');close.addEventListener('click',()=>{closePopup();popup();});
    modal.addEventListener('cancel',event=>{event.preventDefault();closePopup();popup();});
    controls.append(open,close);modal.append(title,reference,message,details,controls);document.body.append(modal);modal.showModal();
  }
  function paint(){
    if(dialog?.dataset.backorderId && document.querySelector(`[data-backorder-detail][data-backorder-id="${dialog.dataset.backorderId}"]`))closePopup();
    const host=document.querySelector('.dispatch-topbar .topbar-actions, .topbar .topbar-actions, .topbar > .actions')||document.querySelector('.dispatch-topbar,.topbar,.mbt-app-topbar');
    if(!host)return;
    for(const audience of audiences){
      const data=counts[audience];
      if(!data)continue;
      const link=links[audience]||document.createElement('a');links[audience]=link;
      link.className='regular-stock-alert';link.dataset.audience=audience;
      const returned=audience==='scm'&&data.returnedPools?.[0];
      link.href=audience==='scm'?(returned?`/scm/stock-requests?tab=waitlist&poolId=${Number(returned.id)}`:'/scm/stock-requests?tab=regular&review=1'):`/sales/stock-requests?tab=regular&requestId=${Number(data.requests?.[0]?.id)||''}`;
      const label=audience==='scm'?(returned?t('Waitlist stock returned · Re-allocate','候补库存已退回 · 重新分配'):t('Stock requests to review','库存申请待审核')):t('Stock request updates','库存申请更新');
      const text=`${label} · ${data.total}`;
      if(link.textContent!==text)link.textContent=text;
      link.hidden=!data.total;link.setAttribute('aria-label',text);
      if(link.parentElement!==host)host.prepend(link);
    }
    popup();
  }
  function stop(){
    generation++;controller?.abort();controller=null;checking=null;
    events?.close();events=null;clearInterval(timer);timer=null;
    observer?.disconnect();observer=null;
    for(const link of Object.values(links))link.remove();
    audiences=[];counts={};links={};
    actorId='';pendingRefresh=false;displayed.clear();stockChecks.clear();stockChecksInitialized=false;closePopup();
  }
  async function refresh(){
    if(token()!==session)return checkSession();
    if(!audiences.length)return;
    if(controller){pendingRefresh=true;return;}
    const ownGeneration=generation,abort=new AbortController();controller=abort;
    const timeout=setTimeout(()=>abort.abort(),10000);
    try{
      await Promise.all(audiences.map(async audience=>{
        const response=await fetch(`/api/${audience}/stock-requests/alerts`,{cache:'no-store',signal:abort.signal,headers:{Accept:'application/json',Authorization:`Bearer ${session}`}});
        if(ownGeneration!==generation||token()!==session)return;
        if(response.status===401||response.status===403){stop();session='';return;}
        if(!response.ok)return;
        const data=await response.json();
        if(ownGeneration!==generation||token()!==session||!Number.isSafeInteger(data.total)||data.total<0)return;
        counts[audience]=data;if(audience==='sales')syncStockChecks(data.stockChecks);paint();
      }));
    }catch{ /* Keep counts during transient failures. */ }
    finally{clearTimeout(timeout);if(controller===abort){controller=null;if(pendingRefresh){pendingRefresh=false;void refresh();}}}
  }
  async function checkSession(){
    const current=token();
    if(current!==session){stop();session=current;}
    if(!session)return;
    if(audiences.length)return refresh();
    if(checking)return;
    const ownGeneration=generation,abort=new AbortController();checking=abort;
    const timeout=setTimeout(()=>abort.abort(),10000);
    try{
      const response=await fetch('/api/auth/me',{cache:'no-store',signal:abort.signal,headers:{Accept:'application/json',Authorization:`Bearer ${current}`}});
      if(!response.ok)return;
      const data=await response.json();
      if(ownGeneration!==generation||token()!==current)return;
      const operator=data.operator,roles=[...(operator?.roles||[]),operator?.role];
      if(!operator||operator.publicSales)return;
      actorId=operator.id;
      if(roles.some(role=>['admin','sales'].includes(role)))audiences.push('sales');
      if(roles.some(role=>['admin','scm','scm_staff','yard_manager'].includes(role)))audiences.push('scm');
      if(!audiences.length)return;
      observer=new MutationObserver(paint);observer.observe(document.body,{childList:true,subtree:true});
      timer=setInterval(refresh,30000);
      if('EventSource' in window){
        events=window.MBBSAppEventStream?.connect('/api/events?client=regular-stock-alert') || new EventSource('/api/events?client=regular-stock-alert');
        events.addEventListener('open',refresh);
        events.addEventListener('app-event',message=>{
          try{
            const event=JSON.parse(message.data);
            if(!['stock-request.updated','special-stock-request.updated'].includes(event.type))return;
            void refresh();
          }catch{ /* Invalid event. */ }
        });
      }
      await refresh();
    }catch{ /* Retry on focus or session changes. */ }
    finally{clearTimeout(timeout);if(checking===abort)checking=null;}
  }
  const style=document.createElement('style');
  style.textContent='.regular-stock-alert{display:inline-flex;align-items:center;padding:7px 10px;margin:3px;border:1px solid #a16207;border-radius:8px;background:#fffbeb;color:#78350f;font:700 12px/1.3 system-ui;text-decoration:none}.regular-stock-alert[hidden]{display:none}.regular-stock-alert:focus-visible{outline:3px solid #a16207;outline-offset:2px}';
  style.textContent+='.regular-stock-popup{width:min(460px,calc(100vw - 48px));padding:24px;border:1px solid #cbd5e1;border-radius:12px;background:white;color:#0f172a;font:15px/1.5 system-ui;overflow-wrap:anywhere}.regular-stock-popup::backdrop{background:#0f172a66}.regular-stock-popup .stock-request-actions{display:flex;gap:16px;align-items:center}.regular-stock-popup button{padding:8px 16px;border-radius:8px;border:1px solid #94a3b8;background:white;cursor:pointer}.regular-stock-popup a{color:#075e50;font-weight:700}';
  document.head.append(style);
  window.MBBSRegularStockAlert={refresh};
  window.addEventListener('mbbs-auth-operator-changed',()=>{checking?.abort();stop();session='';void checkSession();});
  window.addEventListener('mbbs-language-changed',paint);
  window.addEventListener('storage',event=>{if(keys.includes(event.key)||event.key===null)void checkSession();});
  window.addEventListener('focus',checkSession);
  window.addEventListener('pageshow',checkSession);
  window.addEventListener('pagehide',()=>{checking?.abort();stop();session='';});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void checkSession();});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',checkSession,{once:true});else void checkSession();
})();

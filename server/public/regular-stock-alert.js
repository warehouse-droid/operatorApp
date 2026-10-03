(() => {
  if (window.MBBSRegularStockAlert) return;
  const keys = ['mbbs.staff.token','mbbs.dispatch.token','mbbs.control.token','mbbs.operator.token'];
  const token = () => keys.map(key=>localStorage.getItem(key)).find(Boolean)||'';
  const t = (en,zh) => window.MBBS_I18N?.language?.()==='zh-CN'?zh:en;
  let session='',generation=0,controller=null,events=null,timer=null,observer=null,checking=null;
  let audiences=[],counts={},links={};
  function paint(){
    const host=document.querySelector('.dispatch-topbar .topbar-actions, .topbar .topbar-actions, .topbar > .actions')||document.querySelector('.dispatch-topbar,.topbar,.mbt-app-topbar');
    if(!host)return;
    for(const audience of audiences){
      const data=counts[audience];
      if(!data)continue;
      const link=links[audience]||document.createElement('a');links[audience]=link;
      link.className='regular-stock-alert';link.dataset.audience=audience;
      const returned=audience==='scm'&&data.returnedPools?.[0];
      link.href=audience==='scm'?(returned?`/scm/stock-requests?tab=waitlist&poolId=${Number(returned.id)}`:'/scm/stock-requests?tab=regular&review=1'):`/sales/stock-requests?tab=regular&requestId=${Number(data.requests?.[0]?.id)||''}`;
      const label=audience==='scm'?(returned?t('Waitlist stock returned · Re-allocate','候补库存已退回 · 重新分配'):t('Stock requests to review','库存申请待审核')):t('Stock request decisions','库存申请审批结果');
      const text=`${label} · ${data.total}`;
      if(link.textContent!==text)link.textContent=text;
      link.hidden=!data.total;link.setAttribute('aria-label',text);
      if(link.parentElement!==host)host.prepend(link);
    }
  }
  function stop(){
    generation++;controller?.abort();controller=null;checking=null;
    events?.close();events=null;clearInterval(timer);timer=null;
    observer?.disconnect();observer=null;
    for(const link of Object.values(links))link.remove();
    audiences=[];counts={};links={};
  }
  async function refresh(){
    if(token()!==session)return checkSession();
    if(!audiences.length||document.hidden||controller)return;
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
        counts[audience]=data;paint();
      }));
    }catch{ /* Keep counts during transient failures. */ }
    finally{clearTimeout(timeout);if(controller===abort)controller=null;}
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
      if(roles.some(role=>['admin','sales'].includes(role)))audiences.push('sales');
      if(roles.some(role=>['admin','scm','scm_staff','yard_manager'].includes(role)))audiences.push('scm');
      if(!audiences.length)return;
      observer=new MutationObserver(paint);observer.observe(document.body,{childList:true,subtree:true});
      timer=setInterval(refresh,30000);
      if('EventSource' in window){
        events=new EventSource('/api/events?client=regular-stock-alert');
        events.addEventListener('open',refresh);
        events.addEventListener('app-event',message=>{try{if(JSON.parse(message.data).type==='stock-request.updated')void refresh();}catch{ /* Invalid event. */ }});
      }
      await refresh();
    }catch{ /* Retry on focus or session changes. */ }
    finally{clearTimeout(timeout);if(checking===abort)checking=null;}
  }
  const style=document.createElement('style');
  style.textContent='.regular-stock-alert{display:inline-flex;align-items:center;padding:7px 10px;margin:3px;border:1px solid #a16207;border-radius:8px;background:#fffbeb;color:#78350f;font:700 12px/1.3 system-ui;text-decoration:none}.regular-stock-alert[hidden]{display:none}.regular-stock-alert:focus-visible{outline:3px solid #a16207;outline-offset:2px}';
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

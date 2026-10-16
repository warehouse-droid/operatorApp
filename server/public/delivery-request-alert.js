/* global MutationObserver */
(() => {
  if(window.MBBSDeliveryRequestAlerts) {return;}
  const tokenKeys=['mbbs.staff.token','mbbs.dispatch.token','mbbs.control.token','mbbs.operator.token'];
  const token=()=>tokenKeys.map(key=>localStorage.getItem(key)).find(Boolean) || '';
  let session='',actor=null,audience='',generation=0,controller=null,checking=false,refreshing=false,again=false;
  let rows=[],count=0,link=null,dialog=null,previousFocus=null,events=null,timer=null,retry=null;
  const endpoint=()=>`/api/${audience}/delivery-requests`;
  const popupKey=()=>`mbbs.delivery.popup.${actor.id}`;
  function dismissed() {try {const value=JSON.parse(localStorage.getItem(popupKey()) || '{}');return value && typeof value==='object'?value:{};}catch{return {};}}
  function remember(row) {
    const values=dismissed();values[row.id]=Math.max(values[row.id] || 0,row.revision);
    const bounded=Object.fromEntries(Object.entries(values).slice(-500));
    try {localStorage.setItem(popupKey(),JSON.stringify(bounded));}catch{/* Alerts still work when browser storage is unavailable. */}
  }
  function removeDialog() {
    dialog?.remove();dialog=null;
    if(previousFocus?.isConnected) {previousFocus.focus();}previousFocus=null;
  }
  function stop() {
    generation++;controller?.abort();controller=null;checking=false;refreshing=false;again=false;
    actor=null;audience='';rows=[];count=0;events?.close();events=null;clearInterval(timer);timer=null;clearTimeout(retry);retry=null;
    link?.remove();link=null;removeDialog();
  }
  const headers=()=>({Accept:'application/json',Authorization:`Bearer ${session}`});
  function paintBadge() {
    const host=document.querySelector('.dispatch-topbar .topbar-actions,.topbar .topbar-actions,.topbar > .actions') || document.querySelector('.dispatch-topbar,.topbar,.mbt-app-topbar') || document.body;
    if(host) {
      if(!link) {link=document.createElement('a');link.className='delivery-request-alert';}
      if(link.parentElement!==host) {host.append(link);}
      link.classList.toggle('delivery-request-alert-floating',host===document.body);
      if(link.hidden!==!count) {link.hidden=!count;}
      const label=`Delivery updates ${count}`;
      if(link.textContent!==label) {link.textContent=label;}
      link.setAttribute('aria-label',`${count} unread delivery request update${count===1?'':'s'}`);
      link.href=`/${audience}/delivery-requests${rows[0]?`?request=${rows[0].id}`:''}`;
    }
  }
  function paint() {
    if(!actor) {return;}
    paintBadge();
    const otherDialog=[...document.querySelectorAll('dialog[open],[role="dialog"][aria-modal="true"]')]
      .some(node=>node.getClientRects().length>0 && window.getComputedStyle(node).visibility!=='hidden');
    if(document.hidden || dialog || otherDialog) {return;}
    const seen=dismissed(),displayed=window.MBBSDeliveryRequestPage;
    const row=rows.find(item=>(seen[item.id] || 0)<item.revision && (item.id!==displayed?.currentRequestId || item.revision>(displayed.currentRequestRevision || 0)));
    if(!row) {return;}
    show(row);
  }
  const live=version=>version===generation && token()===session;
  const validAlerts=data=>Number.isSafeInteger(data.count) && data.count>=0 && Array.isArray(data.requests);
  function authorizedResponse(response) {
    if(response.status===401 || response.status===403) {stop();session='';return false;}
    return response.ok;
  }
  const noticeId=row=>`delivery-request:${row.id}:${row.revision}`;
  const noticeTitle=row=>row.action==='remind'?'Delivery approval reminder':row.action==='expire'?'Delivery approval expired':'Delivery request updated';
  function noticeMessage(row) {
    const actions={submit:'A new delivery request is awaiting Dispatch.',confirm:'Dispatch pre-approved delivery. Sales must add Sales or Transfer Orders before expiry.',
      reply:'A new message was added to the Sales and Dispatch conversation.',
      propose:'Dispatch proposed another timeslot. Review and accept or counter.',accept:'Sales accepted the proposed timeslot.',secure:'Sales linked orders. Approval is secured and its expiry clock has stopped.',
      relink:'Sales changed the linked orders. The approved delivery time is unchanged.',
      'request-time-change':'Sales requested a new timeslot. The approved time remains active until Dispatch accepts.',
      'counter-time-change':'Dispatch counter-proposed a timeslot. Review and accept or request another time. The approved time remains active until Sales accepts.',
      'accept-counter-time-change':'Sales accepted the Dispatch timeslot. The approved delivery time has been updated.',
      'withdraw-counter-time-change':'Dispatch withdrew the counter-proposal. The approved delivery time is unchanged.',
      'accept-time-change':'Dispatch accepted the new timeslot. The approved delivery time has been updated.',
      'decline-time-change':'Dispatch declined the time change. The approved delivery time is unchanged.',
      'withdraw-time-change':'Sales withdrew the time change. The approved delivery time is unchanged.',
      reraise:'Sales re-raised this request. A new Dispatch approval is required.',remind:'Add at least one Sales or Transfer Order before this approval expires.',expire:'The approval expired. Sales can re-raise the request for Dispatch approval.',
      instructions:'Delivery instructions were updated.',cancel:'This delivery request was cancelled. Linked orders have been released.',counter:'Sales requested another timeslot.',edit:'Sales updated the request.'};
    let message=actions[row.action] || 'Open the request to review the update.';
    if(row.approvalExpiresAt) {message+=` Deadline: ${new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',dateStyle:'medium',timeStyle:'short'}).format(new Date(row.approvalExpiresAt))} (Toronto).`;}
    return message;
  }
  function notifyRows() {
    const seen=dismissed(),displayed=window.MBBSDeliveryRequestPage;
    for(const row of rows) {
      if((seen[row.id] || 0)>=row.revision || (row.id===displayed?.currentRequestId && row.revision<=(displayed.currentRequestRevision || 0))) {continue;}
      void window.MBBSOSNotifications?.notify({id:noticeId(row),title:noticeTitle(row),body:`${row.requestRef} · ${noticeMessage(row)}`,
        url:`/${audience}/delivery-requests?request=${row.id}`,session});
    }
  }
  function show(row) {
    const ownGeneration=generation;
    previousFocus=document.activeElement;
    const modal=document.createElement('dialog');dialog=modal;modal.className='delivery-request-dialog';modal.dataset.osNotificationId=noticeId(row);modal.setAttribute('aria-labelledby','delivery-request-alert-title');
    const title=document.createElement('h2');title.id='delivery-request-alert-title';title.textContent=noticeTitle(row);
    const reference=document.createElement('p');reference.textContent=row.requestRef;
    const message=document.createElement('p');message.textContent=noticeMessage(row);
    const controls=document.createElement('div');controls.className='delivery-request-dialog-actions';
    const open=document.createElement('a');open.textContent='Open request';open.href=`/${audience}/delivery-requests?request=${row.id}`;
    const error=document.createElement('p');error.setAttribute('role','status');
    open.addEventListener('click',async event=>{
      event.preventDefault();open.setAttribute('aria-disabled','true');
      try {
        const response=await fetch(`${endpoint()}/${row.id}/read`,{method:'POST',headers:{...headers(),'Content-Type':'application/json'},body:JSON.stringify({revision:row.revision}),signal:AbortSignal.timeout(10000)});
        if(ownGeneration!==generation || token()!==session) {return;}
        if(!response.ok) {throw new Error('Could not open the update. Please retry.');}
        location.assign(open.href);
      } catch(failure) {if(ownGeneration===generation) {error.textContent=failure.message;}}
      finally {open.removeAttribute('aria-disabled');}
    });
    const close=document.createElement('button');close.type='button';close.textContent='Close';
    const dismiss=()=>{remember(row);removeDialog();paint();};
    close.addEventListener('click',dismiss);
    modal.addEventListener('cancel',event=>{event.preventDefault();dismiss();});
    controls.append(open,close);modal.append(title,reference,message,error,controls);document.body.append(modal);modal.showModal();
  }
  async function refresh() {
    if(token()!==session) {return checkSession();}
    if(!actor) {return;}
    if(refreshing) {again=true;return;}
    refreshing=true;const ownGeneration=generation;
    try {
      const response=await fetch(`${endpoint()}/alerts`,{cache:'no-store',headers:headers(),signal:AbortSignal.timeout(10000)});
      if(!live(ownGeneration)) {return;}
      if(!authorizedResponse(response)) {return;}
      const data=await response.json();
      if(!live(ownGeneration) || !validAlerts(data)) {return;}
      rows=data.requests.filter(row=>Number.isSafeInteger(row.id) && row.id>0 && Number.isSafeInteger(row.revision) && row.revision>0 && typeof row.requestRef==='string');
      count=data.count;notifyRows();paint();
    } catch {/* Retain the last count through transient network failures. */}
    finally {if(ownGeneration===generation) {refreshing=false;if(again){again=false;void refresh();}}}
  }
  function audienceFor(operator) {
    if(!operator?.id || operator.publicSales) {return '';}
    const roles=[operator.role,...(operator.roles || [])].map(role=>String(role || '').toLowerCase().replaceAll('-','_'));
    const sales=roles.includes('sales') || roles.includes('admin'),dispatch=roles.includes('dispatcher') || roles.includes('admin');
    if(!sales && !dispatch) {return '';}
    return dispatch?'dispatch':'sales';
  }
  const yardScope=operator=>JSON.stringify([...(operator.yardLocationIds || [])].map(String).sort());
  function startSession(operator,nextAudience,current) {
    if(actor && (actor.id!==operator.id || audience!==nextAudience || yardScope(actor)!==yardScope(operator))) {stop();}
    actor=operator;audience=nextAudience;
    if(!timer) {timer=setInterval(()=>void refresh(),30000);}
    if(events) {return;}
    // Every detail/count fetch verifies access; the shared stream only carries invalidations.
    events=window.MBBSAppEventStream?.connect('/api/events?client=delivery-request-alert')
      || new EventSource(`/api/events?client=delivery-request-alert&token=${encodeURIComponent(current)}`);
    events.addEventListener('open',()=>void refresh());
    events.addEventListener('app-event',event=>{try {if(JSON.parse(event.data).type==='delivery.requests.updated') {void refresh();}}catch{/* Ignore invalid invalidations. */}});
  }
  async function verifySession(current,version,request) {
    const response=await fetch('/api/auth/me',{headers:{Accept:'application/json',Authorization:`Bearer ${current}`},cache:'no-store',signal:request.signal});
    if(!live(version)) {return;}
    if(response.status===401 || response.status===403) {stop();return;}
    if(!response.ok) {return;}
    const data=await response.json(),nextAudience=audienceFor(data.operator);
    if(!live(version)) {return;}
    if(!nextAudience) {stop();return;}
    startSession(data.operator,nextAudience,current);
    await refresh();
  }
  async function checkSession(force=false) {
    const current=token();
    if(current!==session) {stop();session=current;}
    if(!current || checking) {return;}
    if(actor && !force) {void refresh();return;}
    checking=true;const ownGeneration=generation,request=new AbortController();controller=request;
    const timeout=setTimeout(()=>request.abort(),10000);
    try {
      await verifySession(current,ownGeneration,request);
    } catch {/* Retry verification on focus or the next polling tick. */}
    finally {clearTimeout(timeout);if(ownGeneration===generation){checking=false;controller=null;if(!actor) {retry=setTimeout(()=>void checkSession(),30000);}}}
  }
  const style=document.createElement('style');style.textContent=`
    .delivery-request-alert{display:inline-flex;align-items:center;min-height:32px;padding:5px 9px;border:1px solid #0f766e;border-radius:8px;background:#f0fdfa;color:#134e4a;font:700 12px/1.3 system-ui;text-decoration:none;box-sizing:border-box}
    .delivery-request-alert-floating{position:fixed;right:16px;bottom:16px;z-index:1000;box-shadow:0 2px 8px #0f172a30}
    .delivery-request-alert[hidden]{display:none}.delivery-request-dialog{max-width:min(440px,calc(100vw - 48px));padding:24px;border:1px solid #cbd5e1;border-radius:12px;color:#0f172a;background:white;font:15px/1.5 system-ui}
    .delivery-request-dialog::backdrop{background:#0f172a70}.delivery-request-dialog h2{font-size:20px;margin:0}.delivery-request-dialog-actions{display:flex;gap:12px;align-items:center;justify-content:flex-end}
    .delivery-request-dialog a,.delivery-request-dialog button{padding:8px 12px;border-radius:7px;border:1px solid #0f766e;font:inherit}.delivery-request-dialog a{background:#0f766e;color:white;text-decoration:none}.delivery-request-dialog button{background:white;cursor:pointer}
    .delivery-request-alert:focus-visible,.delivery-request-dialog :focus-visible{outline:3px solid #0f766e;outline-offset:3px}`;document.head.append(style);
  new MutationObserver(paint).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['open','aria-modal','hidden','style','class']});
  window.addEventListener('storage',()=>void checkSession());
  window.addEventListener('mbbs-auth-operator-changed',()=>void checkSession(true));
  window.addEventListener('focus',()=>void checkSession(true));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden) {void checkSession(true);}});
  window.addEventListener('pagehide',stop);
  window.addEventListener('pageshow',()=>void checkSession(true));
  window.MBBSDeliveryRequestAlerts={refresh,checkSession};
  void checkSession();
})();

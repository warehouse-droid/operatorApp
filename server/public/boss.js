const app=document.getElementById('bossApp');
const dialog=document.getElementById('bossDialog');
const token=()=>localStorage.getItem('mbbs.staff.token')||localStorage.getItem('mbbs.dispatch.token')||localStorage.getItem('mbbs.control.token')||'';
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const labels={pending:'Pending approval',processing:'Checking NetSuite',approved:'Approved',rejected:'Rejected',resolved:'Resolved in NetSuite'};
const events={requested:'Approval requested',approved:'Approved',rejected:'Rejected',rejected_closed:'Rejected · Closed in NetSuite',resolved_in_netsuite:'Updated in NetSuite'};
let state={requests:[],queue:'pending',search:'',status:'',offset:0,hasMore:false,enabled:true,unread:0,operator:null};
let loading=false,message='',timer,refreshAgain=false,draftSearch='';
async function api(path,options={}){
 const response=await fetch('/api/boss'+path,{...options,headers:{Authorization:`Bearer ${token()}`,'Content-Type':'application/json'},cache:'no-store'});
 const result=await response.json();
 if(response.status===401){window.location.replace('/');throw new Error('Please sign in again.');}
 if(!response.ok){throw new Error(result.error||'Unable to load approvals.');}return result;
}
const date=value=>value?new Date(value).toLocaleString():'';
function money(value){return value===null||value===undefined?'Unavailable':Number(value).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});}
function creditColor(value){return value==null?'':Number(value)<0?'credit-negative':'credit-positive';}
function amounts(s){return `<dl class="amounts"><div><dt>Account Credit</dt><dd>${escape(money(s.creditLimit))}</dd><small>${escape(s.currency)} credit limit</small></div>
 <div><dt>Current Owed</dt><dd class="${creditColor(s.currentOwed)}">${escape(money(s.currentOwed))}</dd><small class="owed-breakdown"><span>Outstanding: <span>${escape(money(s.balance))}</span></span><span>Unbilled orders: <span>${escape(money(s.unbilledOrders))}</span></span></small></div>
 <div class="credit-total"><dt>Credit Balance</dt><dd class="${creditColor(s.creditBalance)}">${escape(money(s.creditBalance))}</dd><small>${escape(s.currency)} available credit</small></div></dl>`;}
function approvalSnapshot(r){
 return r.status==='approved'?`<p class="snapshot-note"><strong>Saved approval figures</strong><br>Captured ${escape(date(r.snapshot.refreshedAt)||'at an unavailable time')}. Retained for this approval.</p>`:'';
}
function card(r){
 const disabled=!state.enabled||!navigator.onLine;
 const canAccept=r.snapshot.creditLimit!=null&&r.snapshot.balance!=null&&r.snapshot.unbilledOrders!=null&&r.snapshot.orderVersion&&r.snapshot.currency;
 return `<article class="boss-card${r.status==='approved'?' approved-card':''}" data-request="${r.id}"><div class="card-heading"><span class="order-number">${escape(r.snapshot.tranid)}</span><span class="badge ${r.status}">${labels[r.status]}</span></div>
 <h2>${escape(r.snapshot.customerName)}</h2>${approvalSnapshot(r)}${amounts(r.snapshot)}
 ${r.lastError?`<p class="message error">${escape(r.lastError)}</p>`:''}
 ${r.status==='pending'?`<p class="subtle card-footer">Refreshed ${escape(date(r.snapshot.refreshedAt))}</p>
 ${!canAccept?'<p class="subtle">Credit information is incomplete. Accept will be available after a successful refresh.</p>':''}
 <div class="decision-actions"><button class="accept" data-action="accept" data-id="${r.id}" ${disabled||!canAccept?'disabled':''}>Accept</button><button class="reject" data-action="reject" data-id="${r.id}" ${disabled?'disabled':''}>Reject</button></div>`:
 r.status==='processing'?'<p class="subtle card-footer">Waiting for NetSuite to confirm. This page updates automatically.</p>':
 `<p class="subtle card-footer">${escape(r.actorName||'NetSuite')} · ${escape(date(r.completedAt))}</p>${r.status==='rejected'?`<p class="subtle">${r.closedInNetSuite?'Closed in NetSuite.':'Recorded without closing in NetSuite.'}</p>`:''}<button class="history-link" data-action="detail" data-id="${r.id}">View approval history</button>`}</article>`;
}
function historyFilter(){
 if(state.search||state.queue!=='history'){return '';}
 return `<label class="form-field"><span>Decision</span><select id="historyFilter"><option value="">All decisions</option><option value="approved" ${state.status==='approved'?'selected':''}>Approved</option><option value="rejected" ${state.status==='rejected'?'selected':''}>Rejected</option><option value="resolved" ${state.status==='resolved'?'selected':''}>Resolved in NetSuite</option></select></label><p class="subtle">Approval history is shared with all three BOSS users.</p>`;
}
function render(){
 const oldSearch=app.querySelector('[name=search]'),focused=oldSearch&&document.activeElement===oldSearch;
 const cursor=focused?oldSearch.selectionStart:null;
 app.innerHTML=`<div class="boss-sticky"><header class="boss-header"><div><p class="eyebrow">MBBS · BOSS</p><h1>Sales approvals</h1><p class="subtle">${escape(state.operator?.display_name||'')}</p></div><div class="header-actions"><button class="icon-button" data-action="notifications" aria-label="Notifications${state.unread?`, ${state.unread} unread`:''}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>${state.unread?` <span>${state.unread}</span>`:''}</button></div></header>
 <nav class="boss-tabs" aria-label="Approval views" role="tablist"><button role="tab" data-action="queue" data-queue="pending" aria-selected="${!state.search&&state.queue==='pending'}">Pending</button><button role="tab" data-action="queue" data-queue="history" aria-selected="${!state.search&&state.queue==='history'}">History</button></nav>
 <form class="boss-tools" id="searchForm"><input name="search" type="search" aria-label="Search orders or customers" placeholder="Order number or customer" maxlength="100" value="${escape(draftSearch)}"><button type="submit" aria-label="Search">Search</button></form></div>
 ${historyFilter()}
 ${state.search?'<div class="search-summary"><p class="subtle">Search results across Pending and History</p><button class="link-button" data-action="clear-search">Clear search</button></div>':''}
 ${!navigator.onLine?'<p class="message" role="status">You are offline. Connect to review and submit decisions.</p>':''}
 ${!state.enabled?'<p class="message">BOSS approvals are paused. Contact your administrator.</p>':''}
 ${message?`<p class="message error" role="alert">${escape(message)}</p>`:''}
 <section aria-label="${state.search?'Search results':state.queue==='history'?'Approval history':'Pending orders'}">${state.requests.length?state.requests.map(card).join(''):`<div class="empty"><h2>${state.search?'No matching orders':state.queue==='history'?'No decisions yet':'All caught up'}</h2><p class="subtle">${state.search?'Try another order number or customer name.':state.queue==='history'?'Completed decisions will appear here.':'No pending approvals match this view.'}</p></div>`}</section>
 ${state.hasMore?'<button class="load-more" data-action="more">Load more</button>':''}
 <footer class="boss-footer"><button class="link-button" data-action="refresh">↻ Refresh</button><button class="link-button" data-action="logout">Sign out</button></footer>`;
 if(focused){const field=app.querySelector('[name=search]');field.focus({preventScroll:true});field.setSelectionRange(cursor,cursor);}
}
const viewKey=()=>JSON.stringify([state.queue,state.search,state.status]);
async function refresh({more=false}={}){
 if(!navigator.onLine){return;}
 if(loading){refreshAgain=true;return;}
 loading=true;const key=viewKey();
 try{
  const offset=more?state.offset:0;
  const result=await api('/requests?'+new URLSearchParams({queue:state.queue,search:state.search,status:state.search?'':state.status,offset:String(offset)}));
  if(key!==viewKey()){return;}
  const notices=await api('/notifications');
  if(key!==viewKey()){return;}
  state={...state,...result,offset:result.nextOffset,requests:more?[...state.requests,...result.requests]:result.requests,unread:notices.unread};
  if(!dialog.open){render();}
 }catch(error){if(key===viewKey()){message=error.message;render();}}
 finally{
  loading=false;
  if(refreshAgain){refreshAgain=false;void refresh();}else{schedule();}
 }
}
function schedule(){clearTimeout(timer);timer=setTimeout(()=>{if(!document.hidden){void refresh();}else{schedule();}},state.requests.some(r=>r.status==='processing')?3000:30000);}
function showDialog(html){dialog.innerHTML=html;dialog.showModal();}
function confirmDecision(r,action){
 showDialog(`<h2 id="dialogTitle">${action==='accept'?'Accept':'Reject and close'} ${escape(r.snapshot.tranid)}?</h2><p>${escape(r.snapshot.customerName)}</p>${amounts(r.snapshot)}<p>${action==='accept'?'Approve this sales order in NetSuite.':'Close this sales order in NetSuite. Its remaining items will no longer be available for fulfillment.'} All three BOSS users will be notified after NetSuite confirms the decision.</p><p id="decisionError" class="message error" hidden></p><div class="decision-actions"><button data-dialog="cancel">Cancel</button><button class="${action}" id="confirmDecision" ${!navigator.onLine?'disabled':''}>${action==='accept'?'Accept':'Reject and close'} order</button></div>`);
 const commandId=crypto.randomUUID();
 dialog.querySelector('#confirmDecision').addEventListener('click',async event=>{
  const button=event.currentTarget;button.disabled=true;
  try{
   await api(`/requests/${r.id}/decision`,{method:'POST',body:JSON.stringify({action,expectedRevision:r.revision,commandId})});
   message='';dialog.close();await refresh();
  }catch(error){const target=dialog.querySelector('#decisionError');if(target){target.textContent=error.message;target.hidden=false;}button.disabled=!navigator.onLine;}
 });
}
async function detail(id){const r=await api(`/requests/${id}`);showDialog(`<h2 id="dialogTitle">${escape(r.snapshot.tranid)}</h2><p>${escape(r.snapshot.customerName)}</p>${approvalSnapshot(r)}${amounts(r.snapshot)}<p><strong>${labels[r.status]}</strong> · ${escape(r.actorName||'NetSuite')} · ${escape(date(r.completedAt))}</p><ul class="history-events">${r.events.map(e=>`<li><strong>${events[e.kind]||escape(e.kind)}</strong><br><span class="subtle">${escape(e.actorName||'System')} · ${escape(date(e.createdAt))}</span></li>`).join('')}</ul><button data-dialog="cancel">Close</button>`);}
async function notifications(){
 const result=await api('/notifications');
 showDialog(`<h2 id="dialogTitle">Notifications</h2>${result.notifications.length?result.notifications.map(n=>`<div class="notification ${!n.readAt?'unread':''}"><button data-notice="${n.id}" data-request="${n.requestId}"><strong>${escape(n.snapshot.tranid)} · ${events[n.kind]||'Updated'}</strong><br>${escape(n.snapshot.customerName)}</button><p class="subtle">${escape(n.actorName||'System')} · ${escape(date(n.createdAt))}</p></div>`).join(''):'<p class="subtle">No notifications yet.</p>'}<button data-dialog="cancel">Close</button>`);
}
app.addEventListener('input',event=>{if(event.target.name==='search'){draftSearch=event.target.value;}});
app.addEventListener('submit',event=>{if(event.target.id==='searchForm'){event.preventDefault();state.search=String(new FormData(event.target).get('search')||'').trim();draftSearch=state.search;state.status='';message='';void refresh();}});
app.addEventListener('change',event=>{if(event.target.id==='historyFilter'){state.status=event.target.value;void refresh();}});
app.addEventListener('click',async event=>{
 const button=event.target.closest('[data-action]');if(!button){return;}
 try{
  const {action,id}=button.dataset;
  if(['accept','reject'].includes(action)){const r=state.requests.find(item=>item.id===Number(id));if(r){confirmDecision(r,action);}}
  if(action==='queue'||action==='clear-search'){if(action==='queue'){state.queue=button.dataset.queue;}state.search='';draftSearch='';state.status='';message='';await refresh();}
  if(action==='refresh'){message='';await refresh();}
  if(action==='more'){await refresh({more:true});}
  if(action==='detail'){await detail(id);}
  if(action==='notifications'){await notifications();}
  if(action==='logout'){await fetch('/api/auth/logout',{method:'POST',headers:{Authorization:`Bearer ${token()}`}});for(const key of ['mbbs.staff.token','mbbs.staff.role','mbbs.staff.roles','mbbs.dispatch.token','mbbs.control.token','mbbs.operator.token']){localStorage.removeItem(key);}location.replace('/');}
 }catch(error){message=error.message;render();}
});
dialog.addEventListener('click',async event=>{
 if(event.target.closest('[data-dialog="cancel"]')){dialog.close();return;}
 const notice=event.target.closest('[data-notice]');if(notice){try{await api(`/notifications/${notice.dataset.notice}/read`,{method:'POST',body:'{}'});dialog.close();await detail(notice.dataset.request);}catch(error){message=error.message;dialog.close();render();}}
});
dialog.addEventListener('close',()=>{if(!dialog.open){dialog.replaceChildren();}void refresh();});
window.addEventListener('offline',()=>{render();const button=dialog.querySelector('#confirmDecision');if(button){button.disabled=true;}});
window.addEventListener('online',()=>{message='';dialog.close();void refresh();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden){void refresh();}});
window.requireDispatchLogin({mount:app,roles:['boss'],allowPublicSales:false,onReady:async operator=>{
 state.operator=operator;await refresh();const id=new URLSearchParams(location.search).get('request');if(id&&/^\d+$/.test(id)){try{await detail(id);}catch(error){message=error.message;render();}}
}});

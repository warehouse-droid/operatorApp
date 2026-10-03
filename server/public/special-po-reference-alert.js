/* global HTMLElement */
import { poReferenceAlertAudience } from './special-stock-po-reference.js';

const appWindow=/** @type {Window & Record<string,any>} */ (window);
const tokenKeys=['mbbs.staff.token','mbbs.dispatch.token','mbbs.control.token','mbbs.operator.token'];
const readToken=()=>tokenKeys.map(key=>localStorage.getItem(key)).find(Boolean)||'';
let session='', generation=0, checking=false, refreshing=false, again=false;
/** @type {string[]} */ let audiences=[];
/** @type {any[]} */ let alerts=[];
/** @type {HTMLDialogElement|null} */ let dialog=null;
/** @type {HTMLElement|null} */ let previousFocus=null;
/** @type {{requestId:number,noticeKey:string}|null} */ let shown=null;
/** @type {EventSource|null} */ let events=null;
let timer=0;
const headers=()=>({ Accept:'application/json',Authorization:`Bearer ${session}` });

function removeDialog() {
  dialog?.remove(); dialog=null; shown=null;
  if (previousFocus?.isConnected) previousFocus.focus();
  previousFocus=null;
}
function stop() {
  generation++; checking=false; refreshing=false; again=false; audiences=[]; alerts=[];
  window.clearInterval(timer); timer=0; events?.close(); events=null;
  removeDialog();
}

/** @param {any} value */
function validNotice(value) {
  return value && Number.isSafeInteger(value.requestId) && value.requestId>0
    && typeof value.requestRef==='string' && typeof value.displayRef==='string'
    && typeof value.noticeKey==='string' && /^[a-f0-9]{64}$/.test(value.noticeKey)
    && audiences.includes(value.audience) && poReferenceAlertAudience(value.fulfillmentMethod)===value.audience;
}
function paint() {
  if (document.hidden || dialog || !alerts.length || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
  const notice=alerts[0], ownGeneration=generation; shown=notice;
  previousFocus=document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const modal=document.createElement('dialog'); dialog=modal;
  modal.className='special-po-reference-dialog'; modal.setAttribute('aria-labelledby','special-po-reference-title');
  const title=document.createElement('h2'); title.id='special-po-reference-title'; title.textContent='PO Ref received';
  const reference=document.createElement('p'); reference.className='special-po-reference-value';
  reference.textContent=notice.requestRef+' · '+notice.displayRef;
  const instruction=document.createElement('p');
  instruction.textContent=notice.audience==='sales' ? 'Contact the customer to arrange pickup at vendor yard.'
    : `Dispatch: arrange ${notice.fulfillmentMethod==='yard_pickup' ? 'pickup at our yard' : 'delivery'}.`;
  const message=document.createElement('p'); message.setAttribute('role','status');
  const actions=document.createElement('div'); actions.className='special-po-reference-actions';
  const link=document.createElement('a'); link.textContent=notice.audience==='sales'?'Open request':'Open Dispatch';
  link.href=notice.audience==='sales' ? '/sales/stock-requests?tab=special&search='+encodeURIComponent(notice.requestRef) : '/dispatch/special-stock';
  link.target='_blank'; link.rel='noopener';
  const button=document.createElement('button'); button.type='button'; button.textContent='Acknowledge';
  button.addEventListener('click',async()=>{
    if (button.disabled) return;
    button.disabled=true; message.textContent='';
    try {
      const response=await fetch(`/api/${notice.audience}/special-stock-requests/po-reference-alerts/${notice.requestId}/ack`,
        { method:'POST',headers:{...headers(),'Content-Type':'application/json'},body:JSON.stringify({noticeKey:notice.noticeKey}),signal:AbortSignal.timeout(10000) });
      if (ownGeneration!==generation || readToken()!==session) return;
      if (response.status===401 || response.status===403) { stop(); session=''; return; }
      const data=await response.json();
      if (ownGeneration!==generation || readToken()!==session) return;
      if (!response.ok || data.acknowledged!==true) {
        message.textContent=data.error || 'Could not acknowledge the reference. Please retry.';
        if (response.status===409 || response.status===404) void refresh();
        return;
      }
      alerts=alerts.filter(value=>value.noticeKey!==notice.noticeKey || value.requestId!==notice.requestId);
      removeDialog(); paint(); void refresh();
    } catch { if (ownGeneration===generation) message.textContent='Could not acknowledge the reference. Please retry.'; }
    finally { button.disabled=false; }
  });
  modal.addEventListener('cancel',event=>event.preventDefault());
  actions.append(link,button); modal.append(title,reference,instruction,message,actions); document.body.append(modal); modal.showModal();
}

/** @returns {Promise<void>} */
async function refresh() {
  if (readToken()!==session) return checkSession();
  if (!audiences.length || document.hidden) return;
  if (refreshing) { again=true; return; }
  refreshing=true; const ownGeneration=generation;
  try {
    const next=[];
    for (const audience of audiences) {
      const response=await fetch(`/api/${audience}/special-stock-requests/po-reference-alerts`,
        { cache:'no-store',headers:headers(),signal:AbortSignal.timeout(10000) });
      if (ownGeneration!==generation || readToken()!==session) return;
      if (response.status===401 || response.status===403) { stop(); session=''; return; }
      if (response.status===404) continue;
      if (!response.ok) return;
      const data=await response.json();
      if (ownGeneration!==generation || readToken()!==session) return;
      if (!Array.isArray(data.alerts) || !data.alerts.every(validNotice)) return;
      next.push(...data.alerts);
    }
    const current=shown; alerts=next;
    if (dialog && !next.some(value=>value.noticeKey===current?.noticeKey && value.requestId===current?.requestId)) removeDialog();
    paint();
  } catch { /* Keep unacknowledged notices through temporary connection failures. */ }
  finally {
    if (ownGeneration===generation) { refreshing=false; if (again) { again=false; void refresh(); } }
  }
}

/** @returns {Promise<void>} */
async function checkSession() {
  const token=readToken();
  if (token!==session) { stop(); session=token; }
  if (!token || checking) return;
  if (audiences.length) return refresh();
  checking=true; const ownGeneration=generation;
  try {
    const response=await fetch('/api/auth/me',{cache:'no-store',headers:headers(),signal:AbortSignal.timeout(10000)});
    if (!response.ok) return;
    const {operator}=await response.json();
    if (ownGeneration!==generation || readToken()!==session || !operator || operator.publicSales) return;
    const roles=[...(operator.roles || []),operator.role];
    if (roles.some(role=>['sales','admin'].includes(role))) audiences.push('sales');
    if (roles.some(role=>['dispatcher','admin'].includes(role))) audiences.push('dispatch');
    if (!audiences.length) return;
    timer=window.setInterval(refresh,30000);
    if ('EventSource' in window) {
      events=new EventSource('/api/events?client=special-po-reference-alert');
      events.addEventListener('open',()=>void refresh());
      events.addEventListener('app-event',message=>{
        try { if (['special-stock-request.updated','dispatch.orders.updated','scm.schedule.updated'].includes(JSON.parse(message.data).type)) void refresh(); }
        catch { /* Ignore malformed invalidations. */ }
      });
    }
    await refresh();
  } catch { /* Retry session verification on focus or the next page visit. */ }
  finally { if (ownGeneration===generation) checking=false; }
}

const style=document.createElement('style');
style.textContent=`.special-po-reference-dialog{box-sizing:border-box;width:min(520px,calc(100% - 32px));max-height:85vh;overflow:auto;border:1px solid #7c3aed;border-radius:14px;padding:24px;color:#172033;background:white;font:16px/1.5 system-ui,sans-serif}.special-po-reference-dialog::backdrop{background:rgb(15 23 42 / 45%)}.special-po-reference-dialog h2{margin:0 0 14px;font-size:21px}.special-po-reference-value{font-weight:700;overflow-wrap:anywhere}.special-po-reference-actions{display:flex;align-items:center;justify-content:flex-end;gap:16px;flex-wrap:wrap}.special-po-reference-actions button{border:0;border-radius:8px;background:#7c3aed;color:white;padding:10px 16px;font:inherit;cursor:pointer}.special-po-reference-actions button:disabled{opacity:.6}.special-po-reference-actions a{color:#5b21b6}.special-po-reference-dialog [role=status]{color:#b91c1c}`;
document.head.append(style);
appWindow.MBBSPoReferenceAlert={refresh};
window.addEventListener('mbbs-auth-operator-changed',()=>{stop();void checkSession();});
window.addEventListener('storage',event=>{if (!event.key || tokenKeys.includes(event.key)) void checkSession();});
window.addEventListener('focus',()=>void checkSession());
document.addEventListener('visibilitychange',()=>{if (!document.hidden) void checkSession();});
window.addEventListener('pageshow',()=>void checkSession());
window.addEventListener('pagehide',stop);
void checkSession();

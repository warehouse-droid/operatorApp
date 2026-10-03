import { newId } from './identity.js';
import { openWorkspace } from './offline.js';
import { calculateQuote,torontoDate,torontoWindow,requireFieldSales,isAdmin } from './domain.js';
import {quoteDates} from './quote-drafts.js';
import { $,escape,on,notify,modal,download,values } from './ui.js';

const TOKEN='mbbs.staff.token';
const SESSION='mbbs.field-sales.session';
let token=localStorage.getItem(TOKEN)||localStorage.getItem('mbbs.dispatch.token')||localStorage.getItem('mbbs.control.token')||localStorage.getItem('mbbs.operator.token')||'';
const state={operator:null,workspace:null,settings:null,status:null,routeId:null,page:'prospects'};
let syncing=false,retryTimer;
async function api(path,body,method) {
  const response=await fetch(path.startsWith('/api/')?path:`/api/field-sales${path}`,{method:method||(body?'POST':'GET'),headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok){const data=await response.json().catch(()=>({}));throw Object.assign(new Error(data.error||`Request failed (${response.status}).`),{status:response.status,code:data.code});}
  return response.headers.get('content-type')?.includes('application/pdf')||path.includes('/photos/')||path.includes('/quote-evidence/')?response.blob():response.json();
}
async function read(path) {
  try {const data=await api(path);await state.workspace.put(`cache:${path}`,data);return data;}
  catch(error){if(error.status&&error.status<500){throw error;}const cached=await state.workspace.get(`cache:${path}`);if(cached!==undefined){return cached;}throw new Error('This information is not saved on this device yet. Open it online first.');}
}
const singular={jobsite:'jobsites',route:'routes',quote:'quotes',customer:'customer-records',customerType:'customer-types'};
function pendingFor(entries,kind,id){
  return entries.some(e=>e.payload?.id===id&&e.kind===`${kind}.save`||kind==='quote'&&e.kind==='quote.saveGroup'&&e.payload.quotes.some(q=>q.id===id)||kind==='customer'&&e.kind==='customer.link'&&e.payload.customerId===id||kind==='route'&&e.kind==='visit.record'&&e.payload.routeId===id||kind==='jobsite'&&e.payload?.jobsiteId===id);
}
async function hasPending(kind,id) {
  return pendingFor(await state.workspace.pending(),kind,id);
}
async function load(kind,id) {
  const cached=await state.workspace.get(`${kind}:${id}`);
  if(cached&&await hasPending(kind,id)){return cached;}
  try{const row=await api(`/${singular[kind]}/${id}`);await state.workspace.put(`${kind}:${id}`,row);return row;}
  catch(e){if(e.status&&e.status<500){throw e;}if(cached){return cached;}throw e;}
}
async function list(kind,path=`/${singular[kind]}`) {
  const before=await state.workspace.pending();
  let data;try{data=await read(path);}catch(e){if(e.status){throw e;}const items=await state.workspace.records(`${kind}:`);data={items,total:items.length};}
  const byId=new Map(data.items.map(r=>[r.id,r])),local=new Map((await state.workspace.records(`${kind}:`)).map(r=>[r.id,r]));
  // A GET can start before a save commits and return after its acknowledgement.
  // Keep that newer local revision instead of replacing it with the older GET.
  for(const row of local.values()){if(await hasPending(kind,row.id)||pendingFor(before,kind,row.id)&&(!byId.has(row.id)||Number(row.revision)>Number(byId.get(row.id).revision))){byId.set(row.id,row);}}
  const aliases=new Set(kind==='quote'?data.items.flatMap(row=>row.aliases||[]):[]);
  const rows=[...byId.values()].filter(row=>!aliases.has(row.id));
  for(const row of data.items){if(!await hasPending(kind,row.id)&&!(pendingFor(before,kind,row.id)&&Number(local.get(row.id)?.revision)>Number(row.revision))){await state.workspace.put(`${kind}:${row.id}`,row);}}
  return {...data,items:rows};
}
async function optimistic(kind,p) {
  const updates=[];
  if(kind==='quote.saveGroup'){for(const part of p.quotes){updates.push(...await optimistic('quote.save',part));}return updates;}
  if(kind==='customerType.save'){updates.push([`customerType:${p.id}`,{...p,revision:Number(p.revision||0)+1}]);}
  if(kind==='customer.save'){
    const current=await state.workspace.get(`customer:${p.id}`)||{},types=(await list('customerType','/customer-types')).items;
    updates.push([`customer:${p.id}`,{...current,...p,types:types.filter(t=>(p.typeIds||[]).includes(t.id)),jobsites:current.jobsites||p.jobsites||[],revision:Number(p.revision||0)+1}]);
  }
  if(kind==='customer.link'){
    const c=await load('customer',p.customerId),site=await load('jobsite',p.jobsiteId);
    c.jobsites=(c.jobsites||[]).filter(j=>j.id!==site.id);if(p.linked!==false){c.jobsites.push({id:site.id,name:site.name,address:site.address});}
    site.customers=(site.customers||[]).filter(v=>v.id!==c.id);if(p.linked!==false){site.customers.push(c);}
    updates.push([`customer:${c.id}`,c],[`jobsite:${site.id}`,site]);
  }
  if(kind==='jobsite.save') {
    const current=await state.workspace.get(`jobsite:${p.id}`)||{};
    updates.push([`jobsite:${p.id}`,{...current,...p,revision:Number(p.revision||0)+1,observed_stage:p.observedStage||p.observed_stage||'Unknown',postal_prefix:p.postalPrefix||p.postal_prefix||'',manual:current.manual??true}]);
  }
  if(kind==='route.save') {
    const window=torontoWindow(p.date,p.period,p.startTime,p.endTime);
    updates.push([`route:${p.id}`,{id:p.id,revision:Number(p.revision||0)+1,owner_id:p.ownerId||state.operator.id,name:p.name,date:p.date,status:p.status||'planned',data:{...p,...window,windowEnd:window.end,end:p.end||null}}]);
  }
  if(kind==='quote.save') {
    const current=await state.workspace.get(`quote:${p.id}`),revision=Number(p.revision||0)+1,site=await load('jobsite',p.jobsiteId);
    updates.push([`quote:${p.id}`,{...current,id:p.id,company:p.schemaVersion===3?null:p.company,customer_id:p.fieldSalesCustomerId,confirmation:null,order:null,orders:[],jobsite_id:p.jobsiteId,number:current?.number||'New quote',revision,selected_revision:revision,posting:[],snapshot:{...p,...calculateQuote(p,state.settings.companies),revision,jobsite:{id:site.id,name:site.name,address:site.address},companyProfiles:state.settings.companies},versions:[{revision},...(current?.versions||[]).filter(v=>v.revision!==revision)]}]);
  }
  if(kind==='note.add') {const site=await load('jobsite',p.jobsiteId);updates.push([`jobsite:${site.id}`,{...site,notes:[{id:p.id,body:p.body,actor_id:state.operator.id,created_at:new Date().toISOString()},...(site.notes||[])]}]);}
  if(kind==='visit.record') {
    const contacts=[];for(const c of p.contacts||[]){const customer=await load('customer',c.customerId);contacts.push({customerId:customer.id,name:customer.name,representatives:customer.representatives.filter(r=>(c.representativeIds||[]).includes(r.id))});}
    if(p.routeId){const route=await load('route',p.routeId);route.data.stops=route.data.stops.map(s=>s.id===p.stopId?{...s,status:'completed',visitId:p.id,completedAt:p.occurredAt}:s);route.revision++;updates.push([`route:${route.id}`,route]);}
    const site=await load('jobsite',p.jobsiteId);updates.push([`jobsite:${site.id}`,{...site,observed_stage:p.observedStage==='Unknown'?site.observed_stage:p.observedStage,revision:site.revision+(p.observedStage==='Unknown'?0:1),visits:[{id:p.id,data:{contacts},outcome:p.outcome,note:p.note,observed_stage:p.observedStage,occurred_at:p.occurredAt,photos:[]},...(site.visits||[])]}]);
  }
  return updates;
}
async function save(kind,payload,photos=[]) {
  if(kind==='route.save'&&payload.stops.some(s=>!Number.isFinite(Number(s.stayMinutes??15))||Number(s.stayMinutes??15)<0||Number(s.stayMinutes??15)>1440)){throw new Error('Visit duration must be between 0 and 1440 minutes.');}
  if(kind==='jobsite.save'){const ward=String(payload.ward||'').trim();if(ward&&(!/^\d{1,2}$/.test(ward)||Number(ward)<1||Number(ward)>25)){throw new Error('Choose a Toronto ward between 1 and 25.');}for(const [key,limit] of [['latitude',90],['longitude',180]]){const value=payload[key];if(value!=null&&value!==''&&(!Number.isFinite(Number(value))||Math.abs(Number(value))>limit)){throw new Error('Enter valid map coordinates.');}}}
  if(kind==='quote.save'){payload=quotePayload(payload);}
  if(kind==='quote.saveGroup'){payload={...payload,quotes:payload.quotes.map(quotePayload)};}
  const updates=await optimistic(kind,payload);
  const command={id:newId(),kind,payload};
  await state.workspace.enqueue(command,updates,photos.map(p=>({id:p.id,kind:'photo',payload:p})));
  await updateSync();void sync();
  return kind==='quote.saveGroup'?{quotes:updates.map(([,row])=>row)}:Object.fromEntries(updates.map(([key,row])=>[key.split(':')[0],row]));
}
function quotePayload(p){return {...p,...quoteDates(torontoDate(),state.settings.companies[p.company]),simpleDetails:true,expectedTaxBps:Object.fromEntries(Object.entries(state.settings.companies).map(([key,value])=>[key,value.taxBps]))};}
async function replaceQuoteGroup(payload){
  payload={...payload,quotes:payload.quotes.map(quotePayload)};const updates=await optimistic('quote.saveGroup',payload);
  await state.workspace.replaceFailed({id:newId(),kind:'quote.saveGroup',payload},updates);await updateSync();void sync();return {quotes:updates.map(([,row])=>row)};
}
async function replaceQuote(payload,reviewedEntry) {
  payload=quotePayload(payload);
  const updates=await optimistic('quote.save',payload);
  await state.workspace.replaceFailed({id:newId(),kind:'quote.save',payload},updates,reviewedEntry?{kind:reviewedEntry.kind,id:reviewedEntry.payload.id}:undefined);await updateSync();void sync();
  return {quote:updates[0][1]};
}
async function updateSync(){const count=(await state.workspace.pending()).length,button=$('#sync');if(button){button.textContent=syncing?'Saving…':count?`${count} pending · Review`:navigator.onLine?'All changes saved':'Offline · Saved on device';}}
async function sync() {
  if(syncing||!state.workspace||!navigator.onLine){return;}
  clearTimeout(retryTimer);
  syncing=true;await updateSync();
  try {await state.workspace.sync(entry=>entry.kind==='photo'?api('/photos',entry.payload):api('/commands',{id:entry.id,kind:entry.kind,payload:entry.payload}));}
  catch(error){if(error.status===401){notify('Your session expired. Sign in again to sync saved work.');}else if(error.status&&error.status<500){notify(`${error.message} Open pending changes to review.`);}else{retryTimer=setTimeout(()=>void sync(),5000);}}
  finally {syncing=false;await updateSync();}
}
async function reviewQueue() {
  const pending=await state.workspace.pending();
  const el=modal('Saved on this device',`<div class="banner">Pending work remains here until the server acknowledges it. Conflicting edits need your review.</div><div class="stack" style="margin-top:16px">${pending.map(e=>`<div class="record"><strong>${escape(e.kind==='photo'?'Visit photo':e.kind.replace('.',' '))}</strong><p>${escape(e.error||'Waiting to sync')}</p><small>${escape(e.createdAt)}</small><div class="actions"><button data-retry="${e.seq}" class="small">Retry</button>${['quote.save','quote.saveGroup'].includes(e.kind)&&e.error?`<button data-fix-quote="${e.seq}" class="small">Review pending quote</button>`:''}${e.status===409&&['route.save','jobsite.save','customer.save','customerType.save'].includes(e.kind)?`<button data-review="${e.seq}" class="small">Review conflict</button>`:''}</div></div>`).join('')||'<p>No pending work.</p>'}</div>`,'<button id="export-work">Download recovery copy</button><button data-close>Close</button>');
  on('[data-retry]','click',async(e,b)=>{await state.workspace.retry(Number(b.dataset.retry));await sync();await reviewQueue();},el);
  on('[data-review]','click',async(e,b)=>{
    const entry=pending.find(p=>p.seq===Number(b.dataset.review)),kind=entry.kind.split('.')[0],latest=await api(`/${singular[kind]}/${entry.payload.id}`);
    const dialog=modal('Review concurrent changes',`<p>Another save changed this record. Compare both copies before choosing to keep your version. Completed visits remain preserved.</p><div class="grid two" style="margin-top:16px"><div><h3>Current saved version</h3><pre>${escape(JSON.stringify(latest.snapshot||latest.data||latest,null,2))}</pre></div><div><h3>Your pending version</h3><pre>${escape(JSON.stringify(entry.payload,null,2))}</pre></div></div>`,'<button data-close>Keep pending</button><button id="resolve-conflict" class="primary">Keep my version and sync</button>');
    on('#resolve-conflict','click',async()=>{await state.workspace.rebase(entry.seq,latest.revision);dialog.close();await sync();await renderPage();},dialog);
  },el);
  on('[data-fix-quote]','click',async(_event,button)=>{const entry=pending.find(p=>p.seq===Number(button.dataset.fixQuote));const module=await import('./quotes.js');module.choosePending(entry);el.close();if(location.hash==='#quotes'){await renderPage();}else{location.hash='quotes';}},el);
  on('#export-work','click',()=>download(new Blob([JSON.stringify({operatorId:state.operator.id,pending},null,2)],{type:'application/json'}),'field-sales-pending.json'),el);
}
function shell() {
  const nav=[['prospects','⌖','Prospects'],['routes','↝','Routes'],['today','◉','Visiting'],['followups','↻','Follow-ups'],['quotes','▤','Quotes'],['customers','♙','Customers'],...(isAdmin(state.operator)?[['settings','⚙','Settings']]:[])];
  $('#app').innerHTML=`<div class="shell"><aside class="rail"><div class="brand"><img src="/field-sales/icon.svg" alt=""><div>Field Sales<small>MBBS · MBR · MBT</small></div></div><nav class="nav">${nav.map(([id,icon,label])=>`<a href="#${id}" data-page="${id}" class="${id==='settings'?'settings-nav':''}"><span class="symbol">${icon}</span>${label}</a>`).join('')}</nav><div class="rail-footer"><span class="user-label">${escape(state.operator.display_name)}</span><a href="${escape(state.operator.homeRoute==='/field-sales/'?'/':state.operator.homeRoute||'/')}">Operations ↗</a><button id="logout">Sign out</button></div></aside><main class="workspace"><header class="topbar"><span class="eyebrow">Toronto · Field operations</span><button id="sync" class="quiet sync">Checking saved work…</button></header><div id="view" class="page"></div></main></div>`;
  on('#sync','click',reviewQueue);on('#logout','click',async()=>{await api('/api/auth/logout',{}).catch(()=>{});await state.workspace.close();state.workspace=null;token='';for(const key of [TOKEN,SESSION,'mbbs.dispatch.token','mbbs.control.token','mbbs.operator.token','mbbs.staff.role','mbbs.staff.roles']){localStorage.removeItem(key);}login();});
}
export const ctx={state,api,read,load,list,save,replaceQuote,replaceQuoteGroup,sync,updateSync,isAdmin:()=>isAdmin(state.operator),today:torontoDate,render:()=>renderPage(),routePayload:r=>({...r.data,id:r.id,revision:r.revision,date:r.date,name:r.name,status:r.status,ownerId:r.owner_id})};
async function renderPage() {
  if(!state.operator){return;}
  state.page=location.hash.slice(1).split('?')[0]||'prospects';
  document.querySelectorAll('[data-page]').forEach(a=>a.classList.toggle('active',a.dataset.page===state.page));
  const view=$('#view');if(!view){return;}view.innerHTML='<div class="loading">Loading…</div>';
  try {
    if(!state.settings.enabled&&state.page!=='settings'){view.innerHTML=`<div class="panel panel-pad stack"><h1>Field Sales</h1><p>An administrator can enable the module and set up City imports in Settings.</p>${isAdmin(state.operator)?'<a class="button primary" href="#settings">Open settings</a>':''}</div>`;return;}
    const page=state.page;
    const module=await import(page==='quotes'?'./quotes.js':page==='customers'?'./customers.js':page==='today'||page==='followups'?'./visiting.js':page==='settings'?'./settings.js':'./planner.js');
    if(state.page===page){await module.render(ctx,view,page);}
  }catch(error){view.innerHTML=`<div class="banner warning">${escape(error.message)}</div>`;}
}
async function ready(operator,status,verified=true) {
  requireFieldSales(operator);state.operator=operator;state.status=status;state.settings=status.settings.data;
  state.workspace=await openWorkspace(operator.id);
  if(verified){localStorage.setItem(SESSION,JSON.stringify({operator,status,verifiedAt:Date.now(),token}));}
  shell();await updateSync();await renderPage();void sync();
  if('serviceWorker' in navigator){navigator.serviceWorker.register('/field-sales/service-worker.js',{scope:'/field-sales/'}).catch(()=>notify('Offline app installation failed; keep this page open until it is available.'));}
}
function login() {
  state.operator=null;
  window.location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search + location.hash));
}
async function boot() {
  if(!token){return login();}
  try{const status=await api('/status');await ready(status.operator,status);}
  catch(error){
    let cached;try{cached=JSON.parse(localStorage.getItem(SESSION)||'null');}catch{/* unusable saved session */}
    if(!error.status&&cached?.token===token&&Date.now()-cached.verifiedAt<14*86400000){await ready(cached.operator,cached.status,false);notify('Offline workspace opened. Changes will sync after sign-in is verified online.');}
    else {login(error.message);}
  }
}
window.addEventListener('hashchange',renderPage);window.addEventListener('online',()=>void sync());window.addEventListener('offline',()=>void updateSync());
setInterval(()=>{if(state.workspace){void sync();}},30000);
void boot();

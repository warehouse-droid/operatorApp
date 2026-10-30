import {equipmentResults,selectEquipment} from './equipment-picker.js?v=20261029-quote-policy';
import {directPoLine,jobParts} from './job-parts.js?v=20261029-quote-policy';
import {openAttachment,handoverLink,api,esc,money,label,badge,partsBadge,formData,download,message,uploadFiles,params,driverMode,equipmentLabel,vehicleCaption} from './client.js?v=20261029-quote-policy';
import {renderJob,handleJobForm,quoteLine,quotePanel} from './job.js?v=20261029-quote-policy';
import {renderOffice,handleOfficeForm,renderPurchase,purchaseLine} from './office.js?v=20261029-quote-policy';
import {WORKFLOW_STAGES,stageLabel,has,canViewCosts,canWorkshop} from './domain.js?v=20261029-quote-policy';
import {newRequest,intakeMode,saveIntakeDraft,restoreIntakeDraft,searchIntakeCustomer,intakeInput} from './intake.js?v=20261029-quote-policy';
const root=document.querySelector('#repairApp');
export const state={actor:null,jobs:[],vehicles:[],parts:[],job:null,purchase:null,settings:null,view:'board',updates:[],filter:'',search:'',partsSearch:'',publicKey:'',partsLoaded:false};
if(params.has('embedded'))document.body.classList.add('embedded');
const statuses=WORKFLOW_STAGES;
function heading(){return `<header class="topbar repair-topbar"><div class="repair-title"><p class="brand">MBBS · REPAIR CENTRE</p><h1>Repair department</h1><span class="muted">${esc(state.actor.display_name||state.actor.name||state.actor.username||label(state.actor.role))}</span></div><div class="repair-header-tools">${!params.has('embedded')?`<a class="repair-back-link" href="${driverMode?'/driver':has(state.actor,'operator')?'/operator':has(state.actor,'dispatcher')?'/dispatch':has(state.actor,'yard_manager')?'/control':'/'}">Back to app</a>`:''}<div class="topbar-actions" role="group" aria-label="Notifications"><button class="repair-updates" data-do="notifications">Repair updates <span id="unreadCount"></span></button></div></div></header>`;}
function updatesView(){return `<section class="panel"><h2>Repair updates</h2>${state.publicKey?'<button data-do="enable-push">Enable phone notifications</button>':''}<ul class="timeline">${state.updates.map(n=>`<li><a href="#${esc(n.request_id)}">${esc(n.message)}</a><small> ${esc(new Date(n.created_at).toLocaleString(undefined,{timeZone:'America/Toronto'}))}</small>${!n.read_at?` <button data-read="${n.id}">Mark read</button>`:''}</li>`).join('')||'<li>No updates yet.</li>'}</ul></section>`;}
export function render(){
 const office=canViewCosts(state.actor),tech=canWorkshop(state.actor);
 if(!root.querySelector('.repair-topbar'))root.innerHTML=heading()+'<div class="offline" id="repairOffline" hidden>You are offline. Saved records remain on the server. Keep this form open and retry when connected.</div><div class="wrap"></div>';
 root.querySelector('#repairOffline').hidden=navigator.onLine;
 root.querySelector('.wrap').innerHTML=`<nav class="nav" aria-label="Repair views"><button data-view="board" class="${['mine','board'].includes(state.view)?'active':''}">All requests</button>${office?'<button data-view="new">New request</button>':''}${office?`<button data-view="purchases">Purchases</button><button data-view="files">Search records</button><button data-view="equipment">Equipment</button><button data-view="settings">Settings</button>`:''}${office||tech?'<button data-view="parts">Parts & stock</button>':''}</nav><div id="content">${state.job?renderJob(state):state.purchase?renderPurchase(state):state.view==='new'?newRequest(state):state.view==='updates'?updatesView():['mine','board'].includes(state.view)?board():renderOffice(state)}</div>`;
 if(!state.job&&!state.purchase&&state.view==='new')restoreIntakeDraft(root.querySelector('form[data-form=create]'),state,draftKey());
}
function draftKey(){return `repair-draft:${driverMode?'driver':'staff'}:${state.actor.id}`;}
function board(){const jobs=state.jobs.filter(job=>(!state.filter||state.filter==='urgent'?(!state.filter||job.priority==='urgent'):job.stage===state.filter)&&(!state.search||`${job.number} ${job.data.vehicle.plate} ${job.data.vehicle.alias} ${job.data.defect}`.toLowerCase().includes(state.search.toLowerCase())));
 return `<div class="stats">${statuses.map(status=>`<div class="stat"><span>${esc(status==='urgent'?'Urgent':stageLabel({stage:status}))}</span><strong>${state.jobs.filter(job=>status==='urgent'?job.priority==='urgent':job.stage===status).length}</strong></div>`).join('')}</div><div class="filters"><input aria-label="Search repairs" id="jobSearch" placeholder="Search job, vehicle or defect" value="${esc(state.search)}"><select id="jobStatus" aria-label="Filter status"><option value="">All statuses</option>${[...statuses,'urgent'].map(status=>`<option value="${status}" ${state.filter===status?'selected':''}>${esc(status==='urgent'?'Urgent':stageLabel({stage:status}))}</option>`).join('')}</select><button data-do="refresh">Refresh</button></div><section class="panel">${jobs.map(job=>`<article class="job"><div><a href="#${job.id}">${esc(job.number)}</a><p class="muted">${esc(job.data.vehicle.plate||job.data.vehicle.alias)} · ${esc(equipmentLabel(job.data.equipmentType))}</p></div><div class="defect">${esc(job.data.defect)}</div><div>${badge(job.stage||job.status)} ${partsBadge(job)} ${(job.purchaseOrders||[]).map(po=>`<small class="po-board-status">${esc(po.number)} · ${esc(label(po.stage))}</small>`).join('')} ${job.priority==='urgent'?badge('urgent'):''}<p class="muted">${job.data.phase==='repair'?'Work in progress':''}</p></div><div>${badge(job.condition)}<p class="muted">${job.status==='waiting_for_parts'?`ETA: ${esc(job.data.eta||'Unknown')}`:job.receipt==='pending'?'Awaiting formal receipt':esc(job.company)}</p></div></article>`).join('')||'<div class="empty">No repair requests in this view.</div>'}</section>`;
}
async function loadParts(){if(!state.partsLoaded){state.parts=await api('/parts');state.partsLoaded=true;}}
export async function refresh(){[state.jobs,state.parts]=await Promise.all([api(`/jobs?mine=${state.view==='mine'}`),state.partsLoaded?api('/parts'):Promise.resolve(state.parts)]);if(state.job)state.job=await api(`/jobs/${state.job.id}`);if(state.purchase)state.purchase=await api(`/purchases/${state.purchase.id}`);render();}
export async function openJob(id){id=id.split('/').at(-1);state.purchase=null;state.poDraftOpen=false;[state.job]=await Promise.all([api(`/jobs/${id}`),loadParts()]);state.quoteEditing=false;state.quoteIssue=null;render();}
export async function openPurchase(id){state.job=null;state.purchase=await api(`/purchases/${id}`);render();}
async function changeView(view){state.job=null;state.purchase=null;history.replaceState(null,'',location.pathname+location.search);state.view=view;
 if(view==='purchases')state.purchases=await api('/purchases');if(view==='parts')await loadParts();if(['settings','new','equipment','purchases'].includes(view)&&(!state.settings||view==='settings'))state.settings=await api('/settings');if(['board','mine'].includes(view))state.jobs=await api(`/jobs?mine=${view==='mine'}`);render();}
async function notifications(){state.updates=await api('/notifications');await changeView('updates');document.querySelector('#unreadCount').textContent=state.updates.filter(n=>!n.read_at&&n.kind==='quote_approved').length||'';}
async function enablePush(){if(!('serviceWorker'in navigator)||!('PushManager'in window))throw new Error('This browser does not support push notifications. Updates remain available here.');const registration=await navigator.serviceWorker.register('/repair/sw.js',{scope:'/repair/'});await navigator.serviceWorker.ready;if(await Notification.requestPermission()!=='granted')throw new Error('Notification permission was not granted.');let subscription=await registration.pushManager.getSubscription();if(!subscription){const value=state.publicKey.replaceAll('-','+').replaceAll('_','/');subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:Uint8Array.from(atob(value),c=>c.charCodeAt(0))});}await api('/push-subscription',{body:subscription.toJSON()});message('Phone notifications enabled.');}
root.addEventListener('click',async event=>{
 const button=event.target.closest('button,a[data-do]');if(!button)return;
 try{
  if(button.dataset.equipmentId){const form=button.closest('form');selectEquipment(form,state.vehicles.find(v=>v.id===button.dataset.equipmentId));}
  else if(button.dataset.view)await changeView(button.dataset.view);
  else if(['add-vehicle','add-machine'].includes(button.dataset.office)){state.masterType=button.dataset.office==='add-machine'?'machine':'vehicle';state.masterResult=null;await changeView('equipment');document.querySelector('#newEquipment').scrollIntoView({block:'start'});}
  else if(button.dataset.office==='purchase-line')document.querySelector('#purchaseLines').insertAdjacentHTML('beforeend',purchaseLine(state));
  else if(button.dataset.office==='remove-purchase-line')button.closest('.purchase-line').remove();
  else if(button.dataset.read){await api(`/notifications/${button.dataset.read}/read`,{body:{}});await notifications();}
  else if(button.dataset.download)await openAttachment(button.dataset.download,button.dataset.filename||'repair-evidence');
  else if(button.dataset.purchase)await openPurchase(button.dataset.purchase);
  else if(button.dataset.recordKind==='repair')await openJob(button.dataset.recordId);
  else if(button.dataset.recordKind==='purchase')await openPurchase(button.dataset.recordId);
  else switch(button.dataset.do){
   case 'add-po':case 'cancel-po':state.poDraftOpen=button.dataset.do==='add-po';document.querySelector('[data-job-parts]').outerHTML=jobParts(state);if(state.poDraftOpen)document.querySelector('[data-form=vendor-search] input')?.focus();break;
   case 'refresh':await refresh();break;
   case 'intake-customer-search':await searchIntakeCustomer(button.closest('form'));saveIntakeDraft(button.closest('form'),draftKey());break;
   case 'edit-quote':case 'cancel-quote-edit':state.quoteEditing=button.dataset.do==='edit-quote';state.quoteIssue=null;document.querySelector('[data-quote-panel]').outerHTML=quotePanel(state);break;
   case 'additional-quote':state.quoteEditing='additional';state.quoteIssue=state.job.issues?.find(i=>i.id===button.dataset.issueId)||null;document.querySelector('[data-quote-panel]').outerHTML=quotePanel(state);document.querySelector('[data-quote-panel]').scrollIntoView({block:'start'});break;
   case 'edit-usage':{const card=button.closest('[data-usage]');card.querySelector('form').hidden=!card.querySelector('form').hidden;break;}
   case 'po-pdf':await download(`/purchases/${button.dataset.purchaseId}/po.pdf`,`${button.dataset.poNumber}.pdf`);break;
   case 'equipment-search':{const form=button.closest('form');const results=await api(`/vehicles?search=${encodeURIComponent(form.elements.equipmentSearch.value)}`);const vehicles=['equipment','details'].includes(form.dataset.form)?results.filter(v=>v.company===state.job.company&&v.customerId===state.job.data.vehicle.customerId):results;state.vehicles=[...new Map([...state.vehicles,...results].map(v=>[v.id,v])).values()];const current=form.elements.vehicleId.value;if(form.querySelector('[data-equipment-picker]')){form.querySelector('[data-equipment-results]').innerHTML=equipmentResults(vehicles,current);break;}form.elements.vehicleId.innerHTML=`<option value="">Select registered equipment</option>${vehicles.map(v=>`<option value="${esc(v.id)}">${esc(vehicleCaption(v))}</option>`).join('')}`;if(vehicles.some(v=>v.id===current))form.elements.vehicleId.value=current;message(`${vehicles.length} matching equipment records.`);break;}
   case 'back':await changeView('board');break;
   case 'job-photos':{const form=document.querySelector('form[data-form=attachment]');form.elements.kind.value='work';form.scrollIntoView({block:'center',behavior:'smooth'});form.elements.photos.click();break;}
   case 'job-parts':{const details=document.querySelector('[data-job-action=part-request]');if(details){details.open=true;details.scrollIntoView({block:'start',behavior:'smooth'});details.querySelector('input,select')?.focus();}break;}
   case 'notifications':await notifications();break;
   case 'enable-push':await enablePush();break;
   case 'po-line':document.querySelector('#localPoLines').insertAdjacentHTML('beforeend',directPoLine(state));break;
   case 'remove-po-line':button.closest('.po-line').remove();break;
   case 'quote-line':document.querySelector('.quote-lines').insertAdjacentHTML('beforeend',quoteLine(state));break;
   case 'remove-line':button.closest('.quote-line').remove();break;
   case 'pdf':await download(`/jobs/${state.job.id}/pdf`,`${state.job.number}-quote.pdf`);break;
   case 'quote-history':{const quotes=await api(`/jobs/${state.job.id}/quotes`);document.querySelector('#content').innerHTML=`<button data-do="refresh">← Back to repair</button><section class="panel"><h2>Quote history · ${esc(state.job.number)}</h2>${quotes.map(q=>`<details class="panel"><summary>Version ${q.version} · ${esc(label(q.status))}${q.autoApproved?' · Auto-approved':''} · ${esc(new Date(q.created_at).toLocaleString(undefined,{timeZone:'America/Toronto'}))}</summary>${q.lines.map(l=>`<div class="quote-display"><div><strong>${esc(l.description)}</strong><p>${l.quantityMilli/1000} × ${money(l.unitMinor)} · ${l.taxBps/100}% tax</p>${l.decisionNote?`<p>${esc(l.decisionNote)}</p>`:''}</div><strong>${money(l.amountMinor)}</strong>${badge(l.decision)}</div>`).join('')}<p class="muted">${q.decided_at?`Decided ${esc(new Date(q.decided_at).toLocaleString(undefined,{timeZone:'America/Toronto'}))} · ${esc(q.autoApproved?'Automatic approval':q.decided_by)}`:'No recorded decision'}</p></details>`).join('')}</section>`;break;}
   case 'handover-link':await handoverLink(state.job.requestId||state.job.id,document.querySelector('#customerHandoverLink'));break;
   case 'quote-link':{const link=await api(`/jobs/${state.job.id}/quote-link`,{body:{quoteId:state.job.quote.id}});const url=new URL('/repair/quote',location.origin);url.hash=link.token;document.querySelector('#quoteLink').innerHTML=`<label>Customer quote link (valid 30 days)<input readonly value="${esc(url.href)}"></label><small>Creating another link invalidates the previous one.</small>`;break;}
   case 'directory-sync':button.disabled=true;const sync=await api('/directory/sync',{body:{}});state.vehicles=await api('/vehicles');state.equipmentResults=state.vehicles;render();message(`Loaded ${sync.vehicles} Vehicle Master and ${sync.machines} Machine Master records.`);button.disabled=false;break;
   case 'new-purchase':state.purchase=null;state.partRequests=await api('/part-requests');document.querySelector('#content').innerHTML=renderOffice({...state,view:'new-purchase'});break;
  }
 }catch(error){message(error.message,true);button.disabled=false;}
});
root.addEventListener('input',event=>{if(event.target.id==='repairPartSearch'){state.partsSearch=event.target.value;let count=0;for(const row of document.querySelectorAll('[data-part-search]')){row.hidden=!row.dataset.partSearch.includes(state.partsSearch.trim().toLowerCase());if(!row.hidden)count++;}document.querySelector('#repairPartsEmpty').hidden=count>0;}const form=event.target.closest('form');if(form?.dataset.form==='create'){saveIntakeDraft(form,draftKey());}});
root.addEventListener('change',event=>{
 const form=event.target.closest('form');
 if(event.target.name==='partId'&&event.target.closest('[data-direct-po-line]')){const part=state.parts.find(p=>p.id===event.target.value);if(part)event.target.closest('.po-line').querySelector('[name=description]').value=part.name;}
 if(event.target.name==='selected'&&event.target.closest('[data-part-request]'))for(const control of event.target.closest('.po-line').querySelectorAll('input:not([name=selected])'))control.disabled=!event.target.checked;
 if(form?.dataset.form==='create'&&['intakeMode','newRecordType','newCompany'].includes(event.target.name))intakeMode(form,state,event.target.name);
 if(event.target.name==='company'&&form?.dataset.form==='equipment-master'){const key={MBT:'mbtCustomerId',MBBS:'mbbsCustomerId',MBR:'mbrCustomerId'}[event.target.value];form.elements.customerId.value=key?state.settings.mappings[key]:'';}
 if(event.target.name==='vehicleId'&&form&&['create','equipment'].includes(form.dataset.form)){
  const vehicle=state.vehicles.find(v=>v.id===event.target.value)||state.job?.data.vehicle;
  form.elements.equipmentType.value=vehicle?.equipmentType||'unknown';
  if(form.dataset.form==='create'&&['truck','forklift','loader'].includes(vehicle?.equipmentType))form.elements.meterUnit.value=vehicle.equipmentType==='truck'?'km':'hours';
 }
 if(form?.dataset.form==='create'){saveIntakeDraft(form,draftKey());}
 if(event.target.id==='jobStatus'){state.filter=event.target.value;render();}if(event.target.id==='jobSearch'){state.search=event.target.value;render();}
});
root.addEventListener('submit',async event=>{
 const form=event.target.closest('form');if(!form)return;event.preventDefault();if(form.dataset.busy)return;form.dataset.busy='true';root.inert=true;root.setAttribute('aria-busy','true');const submit=form.querySelector('button[type=submit],button:not([type])');if(submit)submit.disabled=true;
 try{
  const input=formData(form);if(form.dataset.form==='decide'){input.decision=event.submitter?.value;const signature=JSON.stringify({decision:input.decision,reason:input.reason});if(form.dataset.decisionSignature!==signature){delete form.dataset.commandId;form.dataset.decisionSignature=signature;}}form.dataset.commandId||=crypto.randomUUID();input.commandId=form.dataset.commandId;
  if(form.dataset.form==='create'){
   const body=intakeInput(form,draftKey());const job=await api('/jobs',{body});sessionStorage.removeItem(draftKey());
   try{await uploadFiles(form.elements.photos.files,{requestId:job.id,kind:'defect'});}catch(error){message(`Request ${job.number} saved. ${error.message} Add the photos on its repair page.`,true);}
   state.job=await api(`/jobs/${job.id}`);history.replaceState(null,'',`${location.pathname}${location.search}#${job.id}`);render();
  }else if(await handleJobForm(state,form,input)){if(state.localSaveComplete){state.localSaveComplete=false;render();}else await refresh();}
  else if(await handleOfficeForm(state,form,input))await refresh();
  delete form.dataset.commandId;
 }catch(error){message(error.message,true);}finally{delete form.dataset.busy;if(submit)submit.disabled=false;root.inert=false;root.removeAttribute('aria-busy');}
});
window.addEventListener('hashchange',()=>{const id=location.hash.slice(1);if(id)void openJob(id).catch(error=>message(error.message,true));else void changeView(state.view);});
async function boot(){
 if(params.has('embedded')||driverMode){location.replace('/repair/requester.html'+location.search+location.hash);return;}
 try{const available=await api('/availability');if(!available.enabled){root.innerHTML='<div class="wrap"><section class="panel"><h1>Repair</h1><p>The Repair module is awaiting activation.</p></section></div>';return;}
  const me=await api('/me');state.actor=me.actor;state.publicKey=me.pushPublicKey;if(has(state.actor,'driver','operator')&&!has(state.actor,'dispatcher','yard_manager','mbr_sales')&&!canViewCosts(state.actor)&&!canWorkshop(state.actor)){location.replace('/repair/requester.html'+location.search+location.hash);return;}
  state.jobs=await api(`/jobs?mine=${state.view==='mine'}`);
  if(location.hash)await openJob(location.hash.slice(1));else render();
  const update=async()=>{try{const rows=await api('/notifications'),el=document.querySelector('#unreadCount');if(el)el.textContent=rows.filter(n=>!n.read_at&&n.kind==='quote_approved').length||'';}catch{}};await update();setInterval(()=>{if(!document.hidden){void update();if(!state.job&&!state.purchase&&['board','mine'].includes(state.view)&&!document.querySelector('input:focus,select:focus,textarea:focus'))void refresh().catch(()=>{});if(state.purchase?.status==='completed'&&state.purchase.billState==='pending')void refresh().catch(()=>{});}},30000);
 }catch(error){root.innerHTML=`<div class="wrap"><section class="panel"><h1>Repair</h1><p>${esc(error.message)}</p>${error.status===401?`<a class="button" target="_top" href="${driverMode?'/driver':'/login?returnTo='+encodeURIComponent(location.pathname+location.search)}">Sign in</a>`:'<button onclick="location.reload()">Retry</button>'}</section></div>`;}
}
export const ready=boot();

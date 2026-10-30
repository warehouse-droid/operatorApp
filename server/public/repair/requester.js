import {stageLabel,partsLabel} from './domain.js?v=20261029-quote-policy';
import {openAttachment,api,esc,field,area,select,formData,uploadFiles,message,driverMode,equipmentOptions,vehicleCaption,repairYards} from './client.js?v=20261029-quote-policy';

const root=document.querySelector('#requesterApp');
const state={actor:null,jobs:[],vehicles:[],job:null,creating:false,receipts:[],receiving:null};
const active=job=>job.status!=='cancelled'&&job.receipt!=='accepted';
const stage=job=>job.receipt==='pending'?3:job.status==='re_inspect'?1:job.status==='waiting_for_parts'||job.data?.phase==='repair'?2:job.data?.inspectionComplete?2:job.status==='in_progress'?1:0;
const status=stageLabel;
const progress=job=>`<ol class="progress" aria-label="Repair progress">${['Requested','Inspection','Repair / approval','Receive equipment'].map((text,index)=>`<li class="${index<=stage(job)?'done':''}" ${index===stage(job)?'aria-current="step"':''}>${text}</li>`).join('')}</ol>`;
const vehicleName=job=>job.data?.vehicle?.plate&&job.data.vehicle.plate!=='#'?job.data.vehicle.plate:job.data?.vehicle?.alias||'Equipment';
const stamp=value=>new Date(value).toLocaleString(undefined,{timeZone:'America/Toronto'});
function draftKey(){return `repair-requester-draft:${driverMode?'driver':'staff'}:${state.actor.id}`;}

function list(){return `<h2>Ongoing requests</h2><div class="cards">${state.jobs.map(job=>`<button class="request-card" data-request-id="${esc(job.id)}"><span class="card-heading"><strong>${esc(job.number)}</strong><span class="status ${job.receipt==='pending'?'ready':''}">${esc(status(job))}</span></span><strong>${esc(vehicleName(job))}</strong><span>${esc(job.data?.defect||'')}</span>${partsLabel(job)?`<p class="muted">Parts: ${esc(partsLabel(job))}</p>`:''}${progress(job)}${job.data?.nextStep?`<span>Next: ${esc(job.data.nextStep)}</span>`:''}${job.status==='waiting_for_parts'?`<span>Parts ETA: ${esc(job.data.eta||'Not confirmed yet')}</span>`:''}<span class="muted">Updated ${esc(stamp(job.updatedAt))} · View progress</span></button>`).join('')||'<p class="empty">No active repair requests.</p>'}</div>`;}
function newRequest(){
 const yards=repairYards.filter(([id])=>(state.actor.operatorYardLocationIds||state.actor.yardLocationIds||[]).map(Number).includes(id));
 return `<section class="panel"><h2>New repair request</h2><form data-requester-form="create"><div class="grid"><div class="wide"><label>Find equipment<input name="equipmentSearch" type="search" placeholder="Number, name or serial"></label><button type="button" data-action="search-equipment">Find equipment</button></div>${select('vehicleId','Vehicle / equipment',[['','Select equipment'],...state.vehicles.map(v=>[v.id,vehicleCaption(v)])])}${select('equipmentType','Equipment type',equipmentOptions,'unknown')}${!driverMode?select('yardId','Responsible yard',[['','Choose yard'],...yards]):''}${field('meter','Odometer / hour meter','number','','required min="0" step="0.01"')}${select('meterUnit','Meter unit',[['km','Kilometres'],['hours','Hours']])}${select('condition','Operating condition',[['can_operate','Can operate — repair needed'],['out_of_service','Out of service — cannot operate']])}${select('priority','Priority',[['normal','Normal'],['urgent','Urgent']])}<div class="wide">${area('defect','What needs repairing?',true)}</div><label class="wide">Defect photos (optional)<input name="photos" type="file" accept="image/*" capture="environment" multiple></label></div><p class="muted">The repair team will inspect the equipment and update your request.</p><div class="form-actions"><button class="primary" type="submit">Submit repair request</button><button type="button" data-action="back">Cancel</button></div></form></section>`;
}
function detail(){
 const job=state.job;
 return `<button data-action="back">← Active requests</button><section class="panel"><div class="toolbar"><h2>${esc(job.number)}</h2><span class="status">${esc(status(job))}</span></div><h3>${esc(vehicleName(job))}</h3><p>${esc(job.data.defect)}</p>${partsLabel(job)?`<p class="muted">Parts: ${esc(partsLabel(job))}</p>`:''}${progress(job)}${job.data.nextStep?`<p><strong>Next step:</strong> ${esc(job.data.nextStep)}</p>`:''}${job.condition==='out_of_service'?'<p class="notice">This equipment is out of service. Receipt of an unrepaired item does not clear its operating restriction.</p>':''}${job.status==='waiting_for_parts'?`<p>Parts ETA: ${esc(job.data.eta||'Not confirmed yet')}</p>`:''}</section>
 ${job.receipt==='pending'&&job.permissions.receive?`<section class="panel"><h2>Receive equipment</h2><p>Check the equipment and take a handover photo. If it is still faulty, return it for re-inspection.</p><form data-requester-form="receive"><div class="grid">${select('decision','Inspection result',[['accepted','Accept — equipment received'],['rejected','Reject — still faulty']])}${area('reason','Receipt note / rejection reason')}<label class="wide">Handover photo<input name="photos" type="file" accept="image/*" capture="environment" multiple required></label></div><div class="form-actions"><button class="primary" type="submit">Confirm receipt</button></div></form></section>`:''}
 <section class="panel"><h2>Progress updates</h2>${job.work.map(entry=>`<div class="work-update"><strong>${esc(stamp(entry.created_at))}</strong><p>${esc(entry.data.done||entry.data.diagnosis||'')}</p>${entry.data.nextStep?`<p>Next: ${esc(entry.data.nextStep)}</p>`:''}</div>`).join('')||'<p class="muted">The repair team has not posted a work update yet.</p>'}</section>
 <section class="panel"><h2>Photos</h2><div class="actions">${(job.attachments||[]).map(a=>`<button type="button" data-preview-photo="${a.id}" data-filename="${esc(a.filename)}">Preview ${esc(a.filename)}</button>`).join('')||'<p class="muted">No photos yet.</p>'}</div></section><section class="panel"><h2>Add a photo</h2><form data-requester-form="photo"><label>Defect photo<input name="photos" type="file" accept="image/*" capture="environment" multiple required></label><div class="form-actions"><button type="submit">Save photo</button></div></form></section>`;
}
function receiptList(){return state.receipts.length?`<section class="panel"><h2>Equipment to receive</h2><p>Receipt assigned to you by ${driverMode?'Dispatch':'Control'}.</p><div class="cards">${state.receipts.map(r=>`<button class="request-card" data-receipt-id="${esc(r.id)}"><strong>${esc(r.number)}</strong><span>${esc(r.equipment)}</span><span>Inspect and receive equipment</span></button>`).join('')}</div></section>`:'';}
function receiptDetail(){const view=state.receiving;return `<button data-action="back">← Ongoing requests</button><section class="panel"><h2>Receive equipment</h2><h3>${esc(view.job.number)} · ${esc(view.job.equipment)}</h3><p>Check the equipment before confirming receipt.</p>${view.work.map(w=>`<p>${esc(w.done)}</p>`).join('')}<form data-requester-form="receive"><div class="grid">${select('decision','Inspection result',[['accepted','Accept — equipment received'],['rejected','Reject — still faulty']])}${area('reason','Receipt note / rejection reason')}<label class="wide">Handover photo<input name="photos" type="file" accept="image/*" capture="environment" multiple required></label></div><button class="primary" type="submit">Confirm receipt</button></form></section>`;}
function render(){
 root.innerHTML=`<a class="back-link" href="/${driverMode?'driver':'operator'}">← Back to ${driverMode?'Driver':'Operator'}</a><div class="toolbar"><h1>Repair requests</h1><div class="actions"><button class="primary" data-action="new">New repair request</button><button data-action="refresh">Refresh</button></div></div>${navigator.onLine?'':'<p class="notice">You are offline. Keep this form open and reconnect before saving.</p>'}${state.creating?newRequest():state.receiving?receiptDetail():state.job?detail():receiptList()+list()}`;
 if(state.creating){try{const draft=JSON.parse(sessionStorage.getItem(draftKey())||'null');if(draft)for(const [key,value] of Object.entries(draft)){const control=root.querySelector('form').elements[key];if(control&&control.type!=='file')control.value=value;}}catch{/* An invalid local draft must not block new intake. */}}
}
async function refresh(){
 const [jobs,receipts]=await Promise.all([api('/jobs?mine=true&active=true'),api('/receipts')]);state.jobs=jobs.filter(active);state.receipts=receipts;
 if(state.job)state.job=state.jobs.some(job=>job.id===state.job.id)?await api(`/jobs/${state.job.id}?view=request`):null;
 render();
}
root.addEventListener('click',async event=>{
 const button=event.target.closest('button');if(!button)return;
 try{
  if(button.dataset.previewPhoto){await openAttachment(button.dataset.previewPhoto,button.dataset.filename);}
  else if(button.dataset.receiptId){state.receiving=await api(`/receipts/${button.dataset.receiptId}`);state.job=null;state.creating=false;render();}
  else if(button.dataset.requestId){state.job=await api(`/jobs/${button.dataset.requestId}?view=request`);state.creating=false;render();}
  else if(button.dataset.action==='new'){state.vehicles=await api('/vehicles');state.job=null;state.receiving=null;state.creating=true;render();}
  else if(button.dataset.action==='back'){state.job=null;state.receiving=null;state.creating=false;await refresh();}
  else if(button.dataset.action==='refresh'){if(!state.creating)await refresh();}
  else if(button.dataset.action==='search-equipment'){
   const form=button.closest('form');state.vehicles=await api(`/vehicles?search=${encodeURIComponent(form.elements.equipmentSearch.value)}`);
   form.elements.vehicleId.innerHTML=`<option value="">Select equipment</option>${state.vehicles.map(v=>`<option value="${esc(v.id)}">${esc(vehicleCaption(v))}</option>`).join('')}`;
  }
 }catch(error){message(error.message,true);}
});
function saveDraft(form){try{const draft=formData(form);delete draft.photos;sessionStorage.setItem(draftKey(),JSON.stringify(draft));}catch{/* The current form remains usable if browser storage is unavailable. */}}
root.addEventListener('input',event=>{const form=event.target.closest('form');if(form?.dataset.requesterForm==='create')saveDraft(form);});
root.addEventListener('change',event=>{
 const form=event.target.closest('form');if(form?.dataset.requesterForm!=='create')return;
 if(event.target.name==='vehicleId'){const vehicle=state.vehicles.find(v=>v.id===event.target.value);form.elements.equipmentType.value=vehicle?.equipmentType||'unknown';form.elements.meterUnit.value=vehicle?.equipmentType==='truck'?'km':'hours';}
 saveDraft(form);
});
root.addEventListener('submit',async event=>{
 const form=event.target.closest('form');if(!form)return;event.preventDefault();if(form.dataset.busy)return;
 const submit=form.querySelector('button[type=submit]');form.dataset.busy='true';root.inert=true;root.setAttribute('aria-busy','true');if(submit)submit.disabled=true;
 try{
  const data=formData(form);delete data.photos;form.dataset.commandId||=crypto.randomUUID();data.commandId=form.dataset.commandId;
  if(form.dataset.requesterForm==='create'){
   if(!data.vehicleId)throw new Error('Choose registered equipment.');
   const job=await api('/jobs',{body:data});
   let warning='';try{await uploadFiles(form.elements.photos.files,{requestId:job.id,kind:'defect'});}catch(error){warning=`Request saved. ${error.message} Open its progress to add the photos.`;}
   sessionStorage.removeItem(draftKey());state.creating=false;await refresh();message(warning||'Repair request submitted.',Boolean(warning));
  }else if(form.dataset.requesterForm==='receive'){
   if(data.decision==='rejected'&&!data.reason.trim())throw new Error('Give the reason the equipment is still faulty.');
   if(!form.elements.photos.files.length)throw new Error('Take a handover photo before confirming receipt.');
   const target=state.receiving?{id:state.receiving.job.id,revision:state.receiving.revision}:state.job;
   const photos=await uploadFiles(form.elements.photos.files,{requestId:target.id,kind:'handover'});
   await api(`/jobs/${target.id}/actions`,{body:{...data,action:'receive',revision:target.revision,attachmentIds:photos.map(photo=>photo.id)}});
   state.job=null;state.receiving=null;await refresh();message(data.decision==='accepted'?'Equipment received.':'Sent back for re-inspection.');
  }else if(form.dataset.requesterForm==='photo'){
   await uploadFiles(form.elements.photos.files,{requestId:state.job.id,kind:'defect'});form.reset();message('Photo saved.');
  }
 }catch(error){message(error.message,true);}finally{delete form.dataset.busy;if(submit)submit.disabled=false;root.inert=false;root.removeAttribute('aria-busy');}
});
async function boot(){
 try{
  if(!(await api('/availability')).enabled){root.innerHTML='<p>Repair requests are not available yet.</p>';return;}
  state.actor=(await api('/me')).actor;await refresh();
  const id=location.hash.slice(1);if(state.jobs.some(job=>job.id===id)){state.job=await api(`/jobs/${id}?view=request`);render();}
  setInterval(()=>{if(!document.hidden&&!state.creating&&!state.job&&!state.receiving)void refresh().catch(()=>{});},30000);
 }catch(error){root.innerHTML=`<p class="error">${esc(error.message)}</p><button data-action="reload">Try again</button>`;root.querySelector('button').addEventListener('click',()=>location.reload());}
}
void boot();

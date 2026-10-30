import {openAttachment,previewImage,handoverLink,api,esc,formData,uploadFiles,message,vehicleCaption} from './client.js?v=20261029-quote-policy';
import {approved,shell,jobCards} from './workshop-view.js?v=20261029-quote-policy';
import {canWorkshop,canViewCosts,teamJobOpen,requireJobStarted,workflowStage} from './domain.js?v=20261029-quote-policy';
import {applyReceipt} from './local-parts.js?v=20261029-quote-policy';
import {saveJobParts} from './job-parts.js?v=20261029-quote-policy';
const root=document.querySelector('#repairApp');
const state={actor:null,tab:'jobs',jobs:[],parts:[],requests:[],incoming:[],equipment:[],job:null,search:'',partsSearch:'',mobileDetail:Boolean(location.hash),drafts:new Map(),partRequest:null,installPrompt:null,receiving:null,receiptCommands:new Map()};
let busy=false,selection=0;
function draft(id=state.job?.id){if(!state.drafts.has(id))state.drafts.set(id,{done:'',hours:'',files:[],commands:{}});return state.drafts.get(id);}
function applyAction(saved){const patch=job=>{if(job?.id!==saved.id)return job;const next={...job,...saved,data:{...job.data,...saved.data},work:saved.recordedWork?[...(job.work||[]),saved.recordedWork]:job.work};next.stage=workflowStage(next);next.requestStatus=next.stage;return next;};state.job=patch(state.job);state.jobs=state.jobs.map(patch);}
function render(){root.innerHTML=shell(state);filterParts();}
function filterParts(){let count=0;for(const row of root.querySelectorAll('[data-part-search]')){row.hidden=!row.dataset.partSearch.includes(state.partsSearch.trim().toLowerCase());if(!row.hidden)count++;}const empty=root.querySelector('#teamPartsEmpty');if(empty)empty.hidden=count>0;}
async function load(){[state.jobs,state.parts,state.requests,state.incoming]=await Promise.all([api('/jobs?active=true&workJobs=true'),api('/parts'),api('/part-requests'),api('/incoming-parts')]);}
async function selectJob(id,{mobile=true}={}){const token=++selection,job=await api(`/jobs/${id}`);if(token!==selection)return;if(!teamJobOpen(job)){state.job=null;state.mobileDetail=false;history.replaceState(null,'',location.pathname+location.search);render();return;}state.job=job;draft(id);state.tab='jobs';state.mobileDetail=mobile;history.replaceState(null,'',location.pathname+location.search+'#'+id);render();}
async function refresh(){await load();if(state.job){state.job=await api(`/jobs/${state.job.id}`);if(!teamJobOpen(state.job))state.job=null;}render();}
async function exclusive(fn){if(busy)return;busy=true;root.inert=true;root.setAttribute('aria-busy','true');try{await fn();}catch(error){message(error.message,true);}finally{busy=false;root.inert=false;root.removeAttribute('aria-busy');}}
function clearDraft(id){const current=draft(id);for(const file of current.files)URL.revokeObjectURL(file.url);state.drafts.delete(id);draft(id);}
async function savePhotos(jobId){for(const item of draft(jobId).files){if(!item.saved){requireJobStarted(state.job);const [photo]=await uploadFiles([item.file],{requestId:jobId,kind:'work'});item.saved=photo.id;state.job.attachments.push(photo);}}}
async function loadEquipment(form){
 const job=state.job,selected=form.elements.vehicleId.value,prior=state.equipment.find(v=>v.id===selected),rows=await api(`/vehicles?search=${encodeURIComponent(form.elements.equipmentSearch.value)}`);
 if(!form.isConnected||state.job.id!==job.id)return;
 state.equipment=[...new Map([job.data.vehicle,prior,...rows].filter(v=>v&&v.company===job.company&&v.customerId===job.data.vehicle.customerId).map(v=>[v.id,v])).values()];
 form.elements.vehicleId.innerHTML=state.equipment.map(v=>`<option value="${esc(v.id)}">${esc(vehicleCaption(v))}</option>`).join('');form.elements.vehicleId.value=selected;
}
async function openParts(partId=''){
 const part=state.parts.find(p=>p.id===partId),job=state.job&&!['pending','accepted'].includes(state.job.receipt)&&!['completed','cancelled'].includes(state.job.status)?state.job:null;
 state.partRequest={job,partId,description:part?.name||'',quantity:'1',files:[],partSearch:'',commandId:crypto.randomUUID()};render();root.querySelector('[role=dialog] select')?.focus();
}
async function saveWork(form,action){
 const job=state.job,current=draft();requireJobStarted(job);current.done=form.elements.done.value;current.hours=form.elements.hours.value;
 if(!current.done.trim())throw new Error('Enter work notes before saving.');
 if(['complete','inspection_complete'].includes(action)&&!current.files.length)throw new Error('Take a photo before completing this work.');
 await savePhotos(job.id);const phase=job.data.phase==='repair'?'repair':'inspection';
 current.commands[action]||=crypto.randomUUID();const saved=await api(`/jobs/${job.id}/actions`,{body:{commandId:current.commands[action],revision:job.revision,action,phase,done:current.done,hours:current.hours||'0',quoteLineId:phase==='repair'?approved(job).find(l=>l.kind==='labor')?.id||approved(job)[0]?.id:undefined}});
 clearDraft(job.id);applyAction(saved);if(action==='complete'){state.jobs=state.jobs.filter(j=>j.id!==job.id);state.job=null;state.mobileDetail=false;history.replaceState(null,'',location.pathname+location.search);}render();message(action==='complete'?(saved.receipt==='accepted'?'Rental repair completed and closed.':saved.receipt==='pending'?'All jobs completed. Equipment receipt is the next step.':'Job completed. Other jobs on this request remain open.'):'Work saved.');
}
root.addEventListener('input',event=>{
 if(event.target.id==='teamJobSearch'){state.search=event.target.value;root.querySelector('.team-job-list').innerHTML=jobCards(state);}
 if(event.target.id==='teamPartsSearch'){state.partsSearch=event.target.value;filterParts();}
 if(['done','hours'].includes(event.target.name)&&event.target.closest('[data-form=team-work]'))draft()[event.target.name]=event.target.value;
 if(event.target.closest('[data-form=part-request]')&&state.partRequest&&event.target.name!=='photos'){state.partRequest[event.target.name]=event.target.value;if(event.target.name==='partSearch'){const select=event.target.form.elements.partId,current=select.value,rows=state.parts.filter(p=>`${p.name} ${p.sku}`.toLowerCase().includes(event.target.value.toLowerCase()));select.innerHTML='<option value="">Part not listed</option>'+rows.map(p=>`<option value="${p.id}">${esc(p.name+' · '+p.sku)}</option>`).join('');select.value=rows.some(p=>p.id===current)?current:'';state.partRequest.partId=select.value;}}
});
root.addEventListener('change',event=>{
 const requestSelect=event.target.closest('[data-form=part-request]')&&['jobId','partId'].includes(event.target.name),equipmentSelect=event.target.name==='vehicleId'&&event.target.closest('[data-form=equipment]');
 if(event.target.name!=='photos'&&!requestSelect&&!equipmentSelect)return;
 void exclusive(async()=>{
 if(event.target.name==='photos'&&event.target.closest('[data-form=part-request]')){const files=[...event.target.files];if(files.some(f=>f.size>10485760))throw new Error('Each photo must be 10 MB or smaller.');for(const file of files)state.partRequest.files.push({file,saved:null});render();return;}
 if(event.target.name==='photos'){
  requireJobStarted(state.job);const files=[...event.target.files];if(files.some(file=>file.size>10485760))throw new Error('Each photo must be 10 MB or smaller.');
  for(const file of files)draft().files.push({file,url:URL.createObjectURL(file),saved:null});render();
 }
 if(event.target.closest('[data-form=part-request]')&&state.partRequest){
  if(event.target.name==='jobId'){state.partRequest.job=event.target.value?await api(`/jobs/${event.target.value}`):null;render();}
  if(event.target.name==='partId'){state.partRequest.partId=event.target.value;const part=state.parts.find(p=>p.id===event.target.value);if(part)state.partRequest.description=part.name;render();}
 }
 if(event.target.name==='vehicleId'&&event.target.closest('[data-form=equipment]'))event.target.form.elements.equipmentType.value=state.equipment.find(v=>v.id===event.target.value)?.equipmentType||'';
});
});
root.addEventListener('toggle',event=>{if(event.target.matches('[data-team-equipment]')&&event.target.open)void exclusive(()=>loadEquipment(event.target.querySelector('form')));},true);
root.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button||button.type==='submit')return;
 // Opening the native camera/file picker must remain inside the user gesture.
 if(button.dataset.teamAction==='camera'){try{requireJobStarted(state.job);root.querySelector('input[name=photos]')?.click();}catch(error){message(error.message,true);}return;}
 void exclusive(async()=>{
  if(button.dataset.do==='edit-usage'){const form=button.closest('[data-usage]').querySelector('form');form.hidden=!form.hidden;return;}
  if(button.dataset.teamTab){state.receiving=null;state.tab=button.dataset.teamTab;state.partRequest=null;render();return;}
  if(button.dataset.teamJob||button.dataset.openJob){await selectJob(button.dataset.teamJob||button.dataset.openJob);return;}
  if(button.dataset.receiveRequest){const request=state.requests.find(r=>r.id===button.dataset.receiveRequest);if(request){state.receiving={request,ordered:state.incoming.some(line=>line.partRequestId===request.id)};render();root.querySelector('.team-receiving-dialog button')?.focus();}return;}
  if(button.dataset.partPurchase){await openParts(button.dataset.partPurchase);return;}
  if(button.dataset.teamPhoto){await openAttachment(button.dataset.teamPhoto,button.dataset.filename);return;}
  if(button.dataset.previewDraft!==undefined){const photo=draft().files[Number(button.dataset.previewDraft)];previewImage(photo.file,photo.file.name);return;}
  if(button.dataset.previewRequest!==undefined){const photo=state.partRequest.files[Number(button.dataset.previewRequest)];previewImage(photo.file,photo.file.name);return;}
  if(button.dataset.removePhoto!==undefined){const [file]=draft().files.splice(Number(button.dataset.removePhoto),1);URL.revokeObjectURL(file.url);render();return;}
  if(button.dataset.teamStart){const saved=await api(`/jobs/${state.job.id}/actions`,{body:{commandId:crypto.randomUUID(),revision:state.job.revision,action:button.dataset.teamStart}});applyAction(saved);render();return;}
  switch(button.dataset.teamAction){
   case 'handover-link':await handoverLink(state.job.requestId||state.job.id,root.querySelector('#customerHandoverLink'));break;
   case 'back':state.mobileDetail=false;render();break;
   case 'refresh':await refresh();break;
   case 'job-parts':case 'new-purchase-request':await openParts();break;
   case 'equipment-search':await loadEquipment(button.closest('form'));break;
   case 'close-receiving':state.receiving=null;render();break;
   case 'close-request':state.partRequest=null;render();break;
   case 'save-photos':await savePhotos(state.job.id);render();message('Photos saved.');break;
   case 'install':if(state.installPrompt){await state.installPrompt.prompt();state.installPrompt=null;render();}break;
  }
 });
});
root.addEventListener('submit',event=>{
 event.preventDefault();const form=event.target;if(busy)return;
 void exclusive(async()=>{
  if(form.dataset.form==='receive-incoming'){const input=formData(form),signature=JSON.stringify(input);if(!state.receiptCommands.has(signature))state.receiptCommands.set(signature,crypto.randomUUID());const result=await api(`/purchases/${input.purchaseId}/lines/${input.lineId}/receive`,{body:{commandId:state.receiptCommands.get(signature),quantity:input.quantity,expectedReceivedMilli:Number(input.expectedReceivedMilli)}});if(applyReceipt(state,result))render();else await refresh();message('Parts received.');return;}
  if(['use-part','edit-usage'].includes(form.dataset.form)){form.dataset.commandId||=crypto.randomUUID();await saveJobParts(state.job,form,{...formData(form),commandId:form.dataset.commandId});await refresh();message('Parts usage saved.');return;}
  if(form.dataset.form==='team-work')await saveWork(form,event.submitter?.value||'work');
  if(form.dataset.form==='equipment'){
   form.dataset.commandId||=crypto.randomUUID();await api(`/jobs/${state.job.id}/actions`,{body:{...formData(form),commandId:form.dataset.commandId,revision:state.job.revision,action:'equipment'}});await refresh();message('Equipment corrected.');
  }
  if(form.dataset.form==='part-request'){
   const request=state.partRequest,input=formData(form);if(!request?.job)throw new Error('Choose a job.');
   if(!request.savedRequest){delete input.photos;delete input.partSearch;request.savedRequest=await api(`/jobs/${request.job.id}/part-requests`,{body:{...input,commandId:request.commandId,revision:request.job.revision}});}
   try{for(const photo of request.files){if(photo.saved)continue;const [saved]=await uploadFiles([photo.file],{requestId:request.job.id,partRequestId:request.savedRequest.id,kind:'part_request'});photo.saved=saved.id;}}catch(error){render();throw new Error('Parts request saved. Retry the remaining photos. '+error.message);}
   state.partRequest=null;await refresh();message('Parts requested for this job.');
  }
 });
});
root.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.receiving&&!busy){state.receiving=null;render();}});
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();state.installPrompt=event;if(state.actor)render();});
window.addEventListener('hashchange',()=>{if(location.hash&&!busy)void exclusive(()=>selectJob(location.hash.slice(1)));});
window.addEventListener('beforeunload',event=>{if([...state.drafts.values()].some(d=>d.done||d.files.some(file=>!file.saved))){event.preventDefault();event.returnValue='';}});
async function boot(){
 if('serviceWorker' in navigator)void navigator.serviceWorker.register('/repair/sw.js?v=20261029-quote-policy',{scope:'/repair/',updateViaCache:'none'}).catch(()=>{});
 try{
  const available=await api('/availability');if(!available.enabled)throw new Error('Repair is not enabled.');
  state.actor=(await api('/me')).actor;
  if(!canWorkshop(state.actor)&&!canViewCosts(state.actor))throw new Error('Open Repair Team with a Repair Team or office account.');
  await load();const selected=location.hash.slice(1)||state.jobs[0]?.id;
  if(selected)await selectJob(selected,{mobile:Boolean(location.hash)});else render();
 }catch(error){root.innerHTML=`<section class="team-empty"><h1>Repair Team</h1><p>${esc(error.message)}</p><a href="/login?returnTo=%2Frepair%2Fworkshop">Sign in</a></section>`;}
}
void boot();

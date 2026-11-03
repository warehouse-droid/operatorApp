import {setText as rst,setTitle as rtitle,html as rh} from './i18n.js?v=20261030-repair-language';
import {updateIntakeFields} from './intake-fields.js?v=20261030-repair-language';
import {api,command,formData,driverMode,previewImage,openAttachment,message,uploadFiles} from './client.js?v=20261030-repair-language';
import {requesterShell,photoTiles} from './requester-pwa-view.js?v=20261030-repair-language';
import {installEquipmentAutocomplete,selectEquipment} from './equipment-picker.js?v=20261030-repair-language';
import {createRepairCamera,nativeCamera} from './requester-camera.js?v=20261030-repair-language';
const root=document.querySelector('#requesterApp'),camera=createRepairCamera({onError:value=>message(value,true)});
const state={actor:null,jobs:[],receipts:[],vehicles:[],job:null,receiving:null,creating:false,photos:new Map(),commands:new Map(),savedJob:null};let busy=false;
const key=()=>`repair-pwa-draft:${driverMode?'driver':'staff'}:${state.actor.id}`;
const allowed=v=>driverMode?['truck','unknown'].includes(v.equipmentType):['forklift','loader','unknown'].includes(v.equipmentType);
function photoKey(form){return form.querySelector('[data-photo-key]')?.dataset.photoKey;}
function photos(form){const id=photoKey(form);if(!state.photos.has(id))state.photos.set(id,[]);return state.photos.get(id);}
function saveDraft(){const form=root.querySelector('[data-requester-form=create]');if(!form)return;try{const data=formData(form);delete data.photos;if(state.commands.has('create'))data.commandId=state.commands.get('create');if(state.savedJob)data.savedJobId=state.savedJob.id;sessionStorage.setItem(key(),JSON.stringify(data));}catch{/* The live form and photos remain available. */}}
function render(){
 camera.close();let saved=null;
 if(state.creating){try{saved=JSON.parse(sessionStorage.getItem(key())||'null');}catch{/* Ignore an invalid local text draft. */}}
 if(saved?.commandId)state.commands.set('create',saved.commandId);if(saved?.savedJobId)state.savedJob={id:saved.savedJobId};
 root.innerHTML=requesterShell(state);
 if(state.creating){const form=root.querySelector('form');if(saved)for(const [name,value] of Object.entries(saved)){const control=form.elements[name];if(control&&control.type!=='file')control.value=value;}form.elements.meterUnit.value=driverMode?'km':'hours';const vehicle=state.vehicles.find(v=>v.id===form.elements.vehicleId.value);if(vehicle)selectEquipment(form,vehicle);updateIntakeFields(form,state.vehicles);}
}
function paintPhotos(form){form.querySelector('.captured-photos').innerHTML=photoTiles(photos(form));}
function addPhoto(form,file){if(!form.isConnected)return;if(!file.type.startsWith('image/'))throw new Error('Take an image photo.');if(file.size>10485760)throw new Error('Each photo must be 10 MB or smaller.');photos(form).push({file,url:URL.createObjectURL(file),saved:null});paintPhotos(form);}
function clearPhotos(form){for(const photo of photos(form))URL.revokeObjectURL(photo.url);state.photos.delete(photoKey(form));state.commands.delete(photoKey(form));}
async function sendPhotos(form,input){const rows=photos(form);for(const p of rows)if(!p.saved){const [saved]=await uploadFiles([p.file],input);p.saved=saved.id;}return rows.map(p=>({id:p.saved}));}
async function refresh(){const [jobs,receipts]=await Promise.all([api('/jobs?mine=true&active=true'),api('/receipts')]);state.jobs=jobs.filter(j=>j.status!=='cancelled'&&j.receipt!=='accepted');state.receipts=receipts;if(state.job)state.job=state.jobs.some(j=>j.id===state.job.id)?await api(`/jobs/${state.job.id}?view=request`):null;render();}
const searchEquipment=installEquipmentAutocomplete(root,async(_form,search)=>{const rows=await api(`/vehicles?search=${encodeURIComponent(search)}`),visible=rows.filter(allowed);state.vehicles=[...new Map([...state.vehicles,...visible].map(v=>[v.id,v])).values()];updateIntakeFields(_form,state.vehicles);return visible;});
root.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button||busy)return;const form=button.closest('form');try{
 if(button.hasAttribute('data-camera')){saveDraft();if(nativeCamera())form.querySelector('[data-native-camera]').click();else camera.open(file=>{try{addPhoto(form,file);}catch(error){message(error.message,true);}});}
 else if(button.dataset.localPhoto!==undefined){const p=photos(form)[Number(button.dataset.localPhoto)];previewImage(p.file,p.file.name);}
 else if(button.dataset.removePhoto!==undefined){const rows=photos(form),[removed]=rows.splice(Number(button.dataset.removePhoto),1);URL.revokeObjectURL(removed.url);paintPhotos(form);}
 else if(button.dataset.previewPhoto)await openAttachment(button.dataset.previewPhoto,button.dataset.filename);
 else if(button.dataset.equipmentId){selectEquipment(form,state.vehicles.find(v=>v.id===button.dataset.equipmentId));saveDraft();}
 else if(button.dataset.requestId){saveDraft();state.job=await api(`/jobs/${button.dataset.requestId}?view=request`);state.creating=false;state.receiving=null;render();}
 else if(button.dataset.receiptId){saveDraft();state.receiving=await api(`/receipts/${button.dataset.receiptId}`);state.creating=false;state.job=null;render();}
 else if(button.dataset.action==='new'){saveDraft();state.creating=true;state.job=null;state.receiving=null;render();await searchEquipment(root.querySelector('form'));}
 else if(['back','ongoing'].includes(button.dataset.action)){saveDraft();state.creating=false;state.job=null;state.receiving=null;await refresh();}
 else if(button.dataset.action==='refresh'){if(state.creating)message('Your draft is kept. Type an equipment name or number to search.');else await refresh();}
 else if(button.dataset.action==='search-equipment')await searchEquipment(form);
 }catch(error){message(error.message,true);}});
root.addEventListener('input',saveDraft);root.addEventListener('change',event=>{const form=event.target.closest('form');if(!form)return;try{if(event.target.hasAttribute('data-native-camera')){for(const file of event.target.files)addPhoto(form,file);event.target.value='';}if(event.target.name==='vehicleId'){const vehicle=state.vehicles.find(v=>v.id===event.target.value);form.elements.equipmentType.value=driverMode?'truck':['forklift','loader'].includes(vehicle?.equipmentType)?vehicle.equipmentType:'forklift';}updateIntakeFields(form,state.vehicles);saveDraft();}catch(error){message(error.message,true);}});
root.addEventListener('submit',async event=>{const form=event.target.closest('form');if(!form)return;event.preventDefault();if(busy)return;busy=true;root.inert=true;root.setAttribute('aria-busy','true');try{
 const data=formData(form);delete data.photos;const id=photoKey(form);if(!state.commands.has(id))state.commands.set(id,command().commandId);data.commandId=state.commands.get(id);if(form.dataset.requesterForm==='create')saveDraft();
 if(form.dataset.requesterForm==='create'){
  if(!state.savedJob){if(data.repairType!=='other'){if(!data.vehicleId)throw new Error('Choose equipment from the search results.');data.meterUnit=driverMode?'km':'hours';}state.savedJob=await api('/jobs',{body:data});}
  try{await sendPhotos(form,{requestId:state.savedJob.id,kind:'defect'});}catch(error){saveDraft();render();throw new Error('Request saved. Retry the remaining photos. '+error.message);}
  clearPhotos(form);state.savedJob=null;sessionStorage.removeItem(key());state.creating=false;await refresh();message('Repair request submitted.');
 }else if(form.dataset.requesterForm==='receive'){
  if(data.decision==='rejected'&&!data.reason.trim())throw new Error('Give the reason the equipment is still faulty.');if(!photos(form).length)throw new Error('Take a handover photo before confirming receipt.');
  const attachmentIds=(await sendPhotos(form,{requestId:form.dataset.receiptJob,kind:'handover'})).map(p=>p.id);await api(`/jobs/${form.dataset.receiptJob}/actions`,{body:{...data,action:'receive',revision:Number(form.dataset.receiptRevision),attachmentIds}});clearPhotos(form);state.job=null;state.receiving=null;await refresh();message(data.decision==='accepted'?'Equipment received.':'Sent back for re-inspection.');
 }else {if(!photos(form).length)throw new Error('Take a photo before saving.');await sendPhotos(form,{requestId:state.job.id,kind:'defect'});clearPhotos(form);await refresh();message('Photo saved.');}
 }catch(error){message(error.message,true);}finally{busy=false;root.inert=false;root.removeAttribute('aria-busy');}});
async function boot(){try{const [availability,me]=await Promise.all([api('/availability'),api('/me')]);if(!availability.enabled){rst(root,'Repair requests are not available yet.');return;}state.actor=me.actor;root.classList.add('requester-pwa');root.dataset.requesterPwa=driverMode?'driver':'operator';document.documentElement.dataset.appMode='standalone';rtitle(`${driverMode?'Driver':'Operator'} repair requests`);const manifest=document.createElement('link');manifest.rel='manifest';manifest.href=driverMode?'/driver-manifest.webmanifest':'/manifest.webmanifest';document.head.append(manifest);await refresh();const id=location.hash.slice(1);if(state.jobs.some(j=>j.id===id)){state.job=await api(`/jobs/${id}?view=request`);render();}setInterval(()=>{if(!document.hidden&&!busy&&!state.creating&&!state.job&&!state.receiving)void refresh().catch(()=>{});},30000);}catch(error){root.innerHTML=rh('<p>Unable to open repair requests. Please return to your app and sign in again.</p>');message(error.message,true);}}
void boot();

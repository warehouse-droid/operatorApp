import {html as rh,ui as ru,isUi,setText,fieldAttributes,setAttribute as rsa} from './i18n.js?v=20261030-repair-language';
import {WORKFLOW_STAGES,STAGE_LABELS,PART_STAGES,PART_LABELS,partsLabel} from './domain.js?v=20261030-repair-language';
export const params=new URLSearchParams(location.search),driverMode=params.get('mode')==='driver'||location.pathname==='/driver/repair';
export const esc=value=>isUi(value)?value:String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
export const money=value=>new Intl.NumberFormat('en-CA',{style:'currency',currency:'CAD'}).format(Number(value||0)/100);
export const label=value=>ru(STAGE_LABELS[WORKFLOW_STAGES.indexOf(value)]||PART_LABELS[PART_STAGES.indexOf(value)]||String(value||'').replaceAll('_',' '));
export const badge=value=>rh`<span class="badge ${esc(value)}">${esc(label(value))}</span>`;
export const partsBadge=(job,selected=false)=>ru(partsLabel(job))?rh`<span class="badge parts-status ${esc(job.partsStatus)}" ${selected?'data-parts-status':''}>${esc(ru(partsLabel(job)))}</span>`:'';
export const equipmentOptions=[['unknown','Unknown — needs confirmation'],['truck','Truck'],['forklift','Forklift'],['loader','Loader'],['other','Other equipment']];
export const repairYards=[[1,'3445 Kennedy'],[28,'2967 Kennedy'],[15,'12441 Woodbine'],[26,'150 Clark']];
export const equipmentLabel=value=>ru(equipmentOptions.find(([key])=>key===value)?.[1]||'Unknown — needs confirmation');
export const vehicleCaption=vehicle=>[vehicle.plate&&vehicle.plate!=='#'?vehicle.plate:'',vehicle.alias||vehicle.serial,vehicle.masterName||'',vehicle.machineName||'',equipmentLabel(vehicle.equipmentType),vehicle.company].filter(Boolean).join(' · ');
export const equipmentSearch=()=>rh`<div class="wide equipment-search-row"><label>Find equipment<input name="equipmentSearch" placeholder="Name, machine code, master number, plate or serial"></label></div>`;
export function headers(){const token=localStorage.getItem(driverMode?'mbbs.driver.token':'mbbs.staff.token')||(!driverMode&&localStorage.getItem('mbbs.operator.token'))||(!driverMode&&localStorage.getItem('mbbs.control.token'))||(!driverMode&&localStorage.getItem('mbbs.dispatch.token'))||'';return {Authorization:`Bearer ${token}`,'X-Repair-Actor':driverMode?'driver':'staff',...(['/repair/requester.html','/operator/repair','/driver/repair'].includes(location.pathname)?{'X-Repair-View':'requester'}:{})};}
export async function api(path,{body,raw,method=body?'POST':'GET',binary=false}={}){
 const response=await fetch(`/api/repair${path}`,{method,headers:{...headers(),...(raw?{'Content-Type':'application/octet-stream'}:body?{'Content-Type':'application/json'}:{})},body:raw||body&&JSON.stringify(body),cache:'no-store'});
 if(!response.ok){const data=await response.json().catch(()=>({}));const error=new Error(data.error||`Request failed (${response.status}).`);error.status=response.status;throw error;}
 return binary?response.blob():response.json();
}
export function command(input={}){return {commandId:crypto.randomUUID(),...input};}
export function formData(form){return Object.fromEntries(new FormData(form));}
export async function download(path,filename){const blob=await api(path,{binary:true});const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
let imagePreview;
export function previewImage(blob,filename='Image'){
 imagePreview?.close();
 if(!document.querySelector('#repairPreviewStyles')){const link=document.createElement('link');link.id='repairPreviewStyles';link.rel='stylesheet';link.href='/repair/preview.css?v=20261030-repair-language';document.head.append(link);}
 const url=URL.createObjectURL(blob),dialog=document.createElement('dialog');dialog.className='repair-image-preview';rsa(dialog,'aria-label','Image preview');
 dialog.innerHTML=rh`<header><h2>${esc(filename)}</h2><div class="preview-actions"><button type="button" data-preview-download>Download</button><button type="button" data-preview-close>Close</button></div></header><img src="${esc(url)}" alt="${esc(filename)}">`;
 dialog.querySelector('[data-preview-close]').onclick=()=>dialog.close();dialog.querySelector('[data-preview-download]').onclick=()=>{const a=document.createElement('a');a.href=url;a.download=filename;a.click();};
 dialog.addEventListener('close',()=>{URL.revokeObjectURL(url);dialog.remove();if(imagePreview===dialog)imagePreview=null;},{once:true});document.body.append(dialog);imagePreview=dialog;dialog.showModal();
}
export async function openAttachment(id,filename){const blob=await api(`/attachments/${id}`,{binary:true});if(blob.type.startsWith('image/')){previewImage(blob,filename);return;}const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
export function message(value,error=false){const el=document.querySelector('#repairMessage');if(!el)return;setText(el,value);el.style.background=error?'#8b2a36':'#163b39';clearTimeout(message.timer);message.timer=setTimeout(()=>setText(el,''),error?12000:5000);}
export async function uploadFiles(files,input){const results=[];for(const file of files){if(file.size>10485760)throw new Error('Each attachment must be 10 MB or smaller.');const query=new URLSearchParams({...input,filename:file.name,mimeType:file.type});results.push(await api(`/attachments?${query}`,{method:'POST',raw:file}));}return results;}
export const field=(name,title,type='text',value='',extra='')=>rh`<label>${esc(ru(title))}<input name="${esc(name)}" type="${type}" value="${esc(value)}" ${fieldAttributes(extra)}></label>`;
export const area=(name,title,required=false)=>rh`<label>${esc(ru(title))}<textarea name="${esc(name)}" ${required?'required':''} maxlength="4000"></textarea></label>`;
const enumFields=new Set(['repairType','priority','condition','equipmentType','kind','decision','meterUnit','status','intakeMode','company','recipientType','tracked']);
export const select=(name,title,options,value='')=>rh`<label>${esc(ru(title))}<select name="${esc(name)}" aria-label="${esc(ru(title))}">${options.map(([key,text])=>rh`<option value="${esc(key)}" ${String(key)===String(value)?'selected':''}>${esc(enumFields.has(name)||key===''||key==='custom'?ru(text):text)}</option>`).join('')}</select></label>`;

export async function handoverLink(jobId,target){const link=await api(`/jobs/${jobId}/handover-link`,{body:{}}),url=new URL('/repair/handover.html',location.origin);url.hash=link.token;target.innerHTML=rh`<label>Customer confirmation link (valid 30 days)<input readonly value="${esc(url.href)}"></label><button type="button">Copy link</button><p>Creating a new link replaces the previous link.</p>`;target.querySelector('button').onclick=async()=>{try{await navigator.clipboard.writeText(url.href);message('Customer confirmation link copied.');}catch{target.querySelector('input').select();message('Select and copy the customer confirmation link.');}};}

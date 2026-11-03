import {html as rh,ui as ru} from './i18n.js?v=20261030-repair-language';
import {esc,field,area,select,message} from './client.js?v=20261030-repair-language';
const root=document.querySelector('#requesterApp'),token=location.hash.slice(1);let view,commandId=crypto.randomUUID(),photos=[];
async function request(path='',body,raw){const response=await fetch('/api/repair/public/handover'+path,{method:body||raw?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(raw?{'Content-Type':'application/octet-stream'}:body?{'Content-Type':'application/json'}:{})},body:raw||body&&JSON.stringify(body),cache:'no-store'});const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to confirm receipt.');return result;}
function render(){root.innerHTML=rh`<h1>Receive repaired equipment</h1><section class="panel"><h2>${esc(view.job.number)}</h2><h3>${esc(view.job.equipment)}</h3><p>${esc(view.job.defect)}</p>${view.work.map(w=>rh`<p>${esc(w.done)}</p>`).join('')}${view.receipt==='accepted'?rh('<p>Receipt has been confirmed. Thank you.</p>'):rh`<p>Inspect your equipment before confirming receipt. If it is still faulty, reject it and explain what needs attention.</p><form><div class="grid">${field('receiver',ru('Your name'),'text','',ru('required maxlength="200"'))}${select('decision',ru('Inspection result'),[['accepted',ru('Accept — equipment received')],['rejected',ru('Reject — still faulty')]])}${area('reason',ru('Receipt note / rejection reason'))}<label class="wide">Handover photo<input name="photos" type="file" accept="image/*" capture="environment" multiple required></label></div><button class="primary" type="submit">Confirm receipt</button></form>`}</section>`;}
root.addEventListener('change',event=>{commandId=crypto.randomUUID();if(event.target.name==='photos')photos=[];});
root.addEventListener('submit',async event=>{
 event.preventDefault();if(root.inert)return;const form=event.target,input=Object.fromEntries(new FormData(form));delete input.photos;
 root.inert=true;root.setAttribute('aria-busy','true');
 try{
  if(input.decision==='rejected'&&!input.reason.trim())throw new Error('Explain why the equipment needs more work.');
  const files=[...form.elements.photos.files];if(!files.length)throw new Error('Take a handover photo before confirming receipt.');
  for(let i=0;i<files.length;i++){if(files[i].size>10485760)throw new Error('Each photo must be 10 MB or smaller.');if(!photos[i])photos[i]=await request('/photos?'+new URLSearchParams({filename:files[i].name,mimeType:files[i].type}),null,files[i]);}
  await request('',{...input,commandId,revision:view.revision,attachmentIds:photos.map(p=>p.id)});
  root.innerHTML=rh`<h1>${input.decision==='accepted'?ru('Equipment received'):ru('Sent for re-inspection')}</h1><section class="panel"><p>${esc(view.job.number)} · ${esc(view.job.equipment)}</p><p>${input.decision==='accepted'?ru('Your receipt has been confirmed. Thank you.'):ru('The repair team has been notified and will review your concerns.')}</p></section>`;
 }catch(error){message(error.message,true);}finally{root.inert=false;root.removeAttribute('aria-busy');}
});
request().then(result=>{view=result;render();}).catch(error=>{root.innerHTML=rh`<h1>Receive repaired equipment</h1><p class="error">${esc(ru(error.message))}</p><p>Contact the Repair Office for a new confirmation link.</p>`;});

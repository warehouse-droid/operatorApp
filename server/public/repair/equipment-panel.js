import {html as rh,ui as ru,setAttribute as rsa,setText as rst} from './i18n.js?v=20261030-repair-language';
import {api,esc,command} from './client.js?v=20261030-repair-language';
const scope=location.pathname.startsWith('/control')?'control':'dispatch';
const root=document.querySelector(scope==='control'?'#controlApp':'#dispatchApp,#dispatchMenuApp');
let dialog,data,search='';
const title=scope==='control'?'Forklift & loader receipt assignments':'Truck receipt assignments';
function rows(){
 const visible=data.equipment.filter(e=>`${e.plate} ${e.alias} ${e.serial} ${e.company} ${e.requests.map(r=>r.number).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
 dialog.querySelector('[data-equipment-list]').innerHTML=visible.map(e=>rh`<article class="equipment-assignment"><h3>${esc(e.plate||e.alias)} <small>${esc(e.plate?e.alias:'')} · ${esc(e.company)}</small></h3>${e.requests.map(r=>rh`<form data-receipt-request="${r.id}" data-revision="${r.revision}"><div><strong>${esc(r.number)}</strong><p>${r.receipt==='pending'?ru('Ready for receipt'):ru('Repair in progress')}${r.condition==='out_of_service'?ru(' · Out of service'):''}</p></div><label>Receive by<select name="recipientId" required><option value="">Choose ${scope==='control'?ru('Operator'):ru('Driver')}</option>${data.people.map(p=>rh`<option value="${esc(p.id)}" ${r.recipient===`${scope==='control'?'staff':'driver'}:${p.id}`?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><button type="submit">Save assignment</button></form>`).join('')||rh('<p>No open repair request.</p>')}</article>`).join('')||rh('<p>No matching equipment.</p>');
}
async function load(){data=await api(`/equipment-assignments?scope=${scope}`);rows();}
async function open(){
 if(dialog?.open)return;
 dialog=document.createElement('dialog');dialog.className='repair-equipment-dialog';rsa(dialog,'aria-label',title);
 dialog.innerHTML=rh`<header><h2>${ru(title)}</h2><button type="button" data-close>Close</button></header><p>The requester receives the equipment by default. Reassign a request to another active ${scope==='control'?ru('Operator'):ru('Driver')} when needed.</p><div class="equipment-search"><label>Search equipment or request<input type="search" placeholder="Equipment, plate, serial or request number"></label><button type="button" data-refresh>Refresh</button></div><p role="status"></p><div data-equipment-list>Loading equipment…</div>`;
 document.body.append(dialog);dialog.showModal();dialog.addEventListener('close',()=>dialog.remove());
 const status=message=>{rst(dialog.querySelector('[role=status]'),message);};
 dialog.querySelector('[data-close]').onclick=()=>dialog.close();
 dialog.querySelector('[data-refresh]').onclick=()=>load().catch(e=>status(e.message));
 dialog.querySelector('input').value=search;dialog.querySelector('input').oninput=event=>{search=event.target.value;rows();};
 dialog.addEventListener('submit',async event=>{
  event.preventDefault();const form=event.target;if(form.dataset.busy)return;form.dataset.busy='true';const button=form.querySelector('button');button.disabled=true;
  try{form.dataset.commandId||=crypto.randomUUID();await api(`/jobs/${form.dataset.receiptRequest}/recipient`,{body:{...command(),commandId:form.dataset.commandId,revision:Number(form.dataset.revision),scope,recipientId:form.elements.recipientId.value}});await load();status('Receipt assignment saved.');}catch(error){status(error.message+' Use Refresh to load the latest assignments.');}finally{delete form.dataset.busy;button.disabled=false;}
 });
 dialog.addEventListener('change',event=>{if(event.target.form)delete event.target.form.dataset.commandId;});
 try{await load();}catch(error){status(error.message);dialog.querySelector('[data-equipment-list]').textContent='';}
}
function mount(){const toolbar=root?.querySelector(scope==='control'?'.topbar .actions':'.topbar-actions');if(!toolbar||toolbar.querySelector('[data-equipment-assignments]'))return;const button=document.createElement('button');button.type='button';button.dataset.equipmentAssignments='';rst(button,'Equipment receipt assignments');button.onclick=open;toolbar.prepend(button);}
if(root){new window.MutationObserver(mount).observe(root,{childList:true,subtree:true});mount();}

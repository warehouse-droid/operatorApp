import { $, $$,escape,on,notify,modal,empty,pageHead,values } from './ui.js';
import { newId } from './identity.js';
import {customerSearchMarkup,bindCustomerSearch} from './customer-search.js';

export async function render(ctx,view) {
 view.innerHTML=pageHead('Customers','Your customer directory, contacts, and linked jobsites.','<button id="new-customer" class="primary">＋ Add customer</button><button id="customer-types">Customer types</button>')+
  '<form id="customer-search" class="panel panel-pad field-row"><label>Search customers or representatives<input name="search" placeholder="Name, phone or email"></label><label class="check"><input name="archived" type="checkbox">Include archived</label><button>Search</button></form><div id="customer-list" class="stack" style="margin-top:16px"></div>';
 const refresh=async()=>{const searchForm=$('#customer-search',view);if(!searchForm){return;}const v=values(searchForm),data=await ctx.list('customer',`/customer-records?search=${encodeURIComponent(v.search||'')}&archived=${v.archived?'all':''}`),term=(v.search||'').toLowerCase();
  if(!searchForm.isConnected){return;}
  const rows=data.items.filter(c=>(v.archived||!c.archived)&&`${c.name} ${c.phone||''} ${c.email||''} ${(c.representatives||[]).map(r=>`${r.name} ${r.phone} ${r.email}`).join(' ')}`.toLowerCase().includes(term));
  $('#customer-list',view).innerHTML=rows.map(c=>`<article class="panel panel-pad"><div class="row"><h3>${escape(c.name)}${c.archived?' · Archived':''}</h3><button data-edit-customer="${c.id}">Edit</button></div><p>${escape((c.types||[]).map(t=>t.name).join(' · '))}</p><p>${escape(c.email)} ${escape(c.phone)}</p>${(c.representatives||[]).filter(r=>!r.archived).map(r=>`<p>${escape(r.name)} · ${escape(r.phone)} · ${escape(r.email)}</p>`).join('')}<small>${(c.jobsites||[]).length} linked jobsites</small><div class="actions"><button data-sites="${c.id}" class="small">Manage jobsites</button></div></article>`).join('')||empty('No matching customers.');
  on('[data-edit-customer]','click',async(e,b)=>editCustomer(ctx,await ctx.load('customer',b.dataset.editCustomer),{onSaved:refresh}),view);
  on('[data-sites]','click',async(e,b)=>manageSites(ctx,await ctx.load('customer',b.dataset.sites)),view);
 };
 on('#customer-search','submit',async e=>{e.preventDefault();await refresh();},view);
 on('#new-customer','click',()=>editCustomer(ctx,{}, {onSaved:refresh}),view);
 on('#customer-types','click',()=>manageTypes(ctx),view);await refresh();
}

function representativeRow(r={}) {
 return `<fieldset class="representative-fields" data-representative="${r.id||newId()}"><legend>Representative</legend><div class="grid two"><label>Name<input name="repName" value="${escape(r.name)}" required></label><label>Role<input name="repRole" value="${escape(r.role)}"></label><label>Phone<input name="repPhone" type="tel" value="${escape(r.phone)}"></label><label>Email<input name="repEmail" type="email" value="${escape(r.email)}"></label></div><button type="button" data-remove-rep class="small danger">Remove representative</button></fieldset>`;
}
export async function editCustomer(ctx,customer={}, {mount,onSaved=async()=>{},onCancel}={}) {
 const draftId=customer.id||newId(),types=(await ctx.list('customerType','/customer-types')).items;
 const body=`<form id="customer-form" class="stack"><h3>${customer.id?'Edit customer':'Add customer'}</h3><label>Customer name<input name="name" value="${escape(customer.name)}" required maxlength="250"></label><div class="grid two"><label>Business phone<input name="phone" value="${escape(customer.phone)}" type="tel"></label><label>Business email<input name="email" type="email" value="${escape(customer.email)}"></label></div><fieldset><legend>Customer types</legend><div id="customer-type-options" class="check-grid"></div><div class="field-row"><label>New type<input id="new-type-name" placeholder="e.g. Roofing contractor"></label><button type="button" id="add-type" class="small">Add type</button></div></fieldset><details><summary>Billing address</summary><div class="grid two" style="margin-top:12px">${[['line1','Street'],['line2','Unit / address line 2'],['city','City'],['province','Province'],['postalCode','Postal code'],['country','Country code']].map(([k,label])=>`<label>${label}<input name="bill_${k}" value="${escape(customer.billing?.[k]||(k==='country'?'CA':''))}"></label>`).join('')}</div></details><div id="representatives" class="stack">${(customer.representatives||[]).filter(r=>!r.archived).map(representativeRow).join('')}</div><button type="button" id="add-representative">＋ Add representative</button><label>Customer notes<textarea name="note">${escape(customer.note)}</textarea></label><details><summary>Existing NetSuite customer links</summary><small>Create customers in NetSuite, then link their accounts here or when creating Sales Orders. These links are optional for quotes.</small>${[['MBBS','MBBS customer'],['MBT_MBR','Shared MBT / MBR customer']].map(([k,label])=>`<label>${label} ID<input name="ns_${k}" inputmode="numeric" value="${escape(customer.netsuiteCustomers?.[k])}"></label><div class="field-row"><input data-ns-search="${k}" aria-label="Search ${label}" placeholder="Find by customer name"><button type="button" data-find-ns="${k}" class="small">Find</button></div><div data-ns-results="${k}"></div>`).join('')}</details>${customer.id?`<label class="check"><input name="archived" type="checkbox" ${customer.archived?'checked':''}>Archive customer</label>`:''}<div class="actions"><button type="submit" class="primary">Save customer</button><button type="button" id="cancel-customer">Cancel</button></div></form>`;
 const el=mount||modal(customer.id?'Customer':'New customer','');
 const root=mount||$('.dialog-body',el);root.innerHTML=body;
 const drawTypes=(selected=customer.typeIds||[])=>{$('#customer-type-options',root).innerHTML=types.filter(t=>!t.archived||selected.includes(t.id)).map(t=>`<label class="check"><input type="checkbox" data-customer-type="${t.id}" ${selected.includes(t.id)?'checked':''}>${escape(t.name)}${t.archived?' (archived)':''}</label>`).join('');};drawTypes();
 const close=()=>{if(mount){mount.innerHTML='';}else if(root.isConnected){el.close();}onCancel?.();};
 $('#customer-form',root).addEventListener('click',e=>{const b=e.target.closest('[data-remove-rep]');if(b){b.closest('[data-representative]').remove();}});
 on('#cancel-customer','click',close,root);
 on('#add-representative','click',()=>$('#representatives',root).insertAdjacentHTML('beforeend',representativeRow()),root);
 on('#add-type','click',async()=>{
  const name=$('#new-type-name',root).value.trim();if(!name){throw new Error('Enter a customer type.');}
  const {customerType}=await ctx.save('customerType.save',{id:newId(),name});types.push(customerType);
  drawTypes([...$$('[data-customer-type]:checked',root).map(e=>e.dataset.customerType),customerType.id]);$('#new-type-name',root).value='';
 },root);
 on('[data-find-ns]','click',async(e,b)=>{
  const group=b.dataset.findNs,term=$(`[data-ns-search="${group}"]`,root).value,rows=(await ctx.api(`/customers?search=${encodeURIComponent(term)}`)).items,target=$(`[data-ns-results="${group}"]`,root);
  target.innerHTML=rows.map(c=>`<button type="button" class="catalog-item" data-ns-id="${c.id}">${escape(c.display_name)} · ${escape(c.entity_number)} (${c.id})</button>`).join('')||empty('No matching NetSuite customer.');
  on('[data-ns-id]','click',(event,button)=>{$(`[name="ns_${group}"]`,root).value=button.dataset.nsId;target.innerHTML='';},target);
 },root);
 on('#customer-form','submit',async(e,f)=>{
  e.preventDefault();const v=values(f),submit=$('[type=submit]',f);submit.disabled=true;
  try {
   const representatives=$$('[data-representative]',f).map(r=>({id:r.dataset.representative,name:$('[name=repName]',r).value,role:$('[name=repRole]',r).value,phone:$('[name=repPhone]',r).value,email:$('[name=repEmail]',r).value}));
   const billing=Object.fromEntries(['line1','line2','city','province','postalCode','country'].map(k=>[k,v['bill_'+k]]));
   const result=await ctx.save('customer.save',{...customer,id:draftId,name:v.name,phone:v.phone,email:v.email,note:v.note,billing,representatives,typeIds:$$('[data-customer-type]:checked',f).map(x=>x.dataset.customerType),archived:Boolean(v.archived),netsuiteCustomers:{MBBS:v.ns_MBBS,MBT_MBR:v.ns_MBT_MBR}});
   Object.assign(customer,result.customer);await onSaved(result.customer);close();notify('Customer saved on this device.');
  }finally{submit.disabled=false;}
 },root);
 return el;
}

export async function customerLinks(ctx,root,editor,site,{onChange=()=>{}}={}) {
 let contacts=[],updating=false,sequence=0,search;
 const draw=async()=>{
  const token=++sequence,data=await ctx.list('customer',`/customer-records?jobsiteId=${encodeURIComponent(site.id)}`);
  if(token!==sequence||!root.isConnected||root.closest('dialog')?.open===false){return;}
  const linked=data.items.filter(c=>!c.archived&&(c.jobsites||[]).some(j=>j.id===site.id));
  contacts=linked.map(c=>({customerId:c.id,representativeIds:(c.representatives||[]).filter(r=>!r.archived).map(r=>r.id)}));
  search?.close();
  root.innerHTML=`<div class="row"><h3>Customers at this site</h3><button type="button" id="visit-add-customer" class="small">＋ Add customer</button></div>${customerSearchMarkup()}<div id="site-linked-customers" class="stack">${linked.map(c=>`<article class="record linked-site-customer" data-linked-customer="${c.id}"><div class="row"><strong>${escape(c.name)}</strong><button type="button" data-remove-site-customer="${c.id}" class="small danger" aria-label="Remove ${escape(c.name)} from this site">Remove</button></div><div class="customer-link-details">${c.phone||c.email?`<p>${escape([c.phone,c.email].filter(Boolean).join(' · '))}</p>`:''}${(c.representatives||[]).filter(r=>!r.archived).map(r=>`<div data-site-representative="${r.id}"><strong>${escape(r.name)}</strong><p>${escape([r.phone,r.email].filter(Boolean).join(' · '))}</p></div>`).join('')}</div><button type="button" data-edit-contact="${c.id}" class="small">Add / edit representatives</button></article>`).join('')||'<small>No customers linked yet.</small>'}</div>`;
  search=bindCustomerSearch(ctx,root,site.id,linked.map(c=>c.id),c=>changeLink(c.id,true));
  on('[data-remove-site-customer]','click',(e,b)=>changeLink(b.dataset.removeSiteCustomer,false),root);
  on('#visit-add-customer','click',()=>editCustomer(ctx,{}, {mount:editor,onSaved:c=>changeLink(c.id,true)}),root);
  on('[data-edit-contact]','click',async(e,b)=>editCustomer(ctx,await ctx.load('customer',b.dataset.editContact),{mount:editor,onSaved:draw}),root);
  onChange(contacts);
 };
 const changeLink=async(customerId,linked)=>{
  if(updating){return;}updating=true;search?.close();
  const controls=$$('input,button',root).map(el=>[el,el.disabled]);controls.forEach(([el])=>{el.disabled=true;});
  try{await ctx.save('customer.link',{customerId,jobsiteId:site.id,linked});await draw();}
  finally{updating=false;controls.forEach(([el,disabled])=>{if(el.isConnected){el.disabled=disabled;}});}
 };
 await draw();return {refresh:draw,contacts:()=>{if(updating){throw new Error('Wait for the customer changes to finish before saving the visit.');}return contacts;}};
}

async function manageTypes(ctx,owner) {
 const rows=(await ctx.list('customerType','/customer-types')).items;
 if(owner&&(!owner.isConnected||!$('#dialog').open)){return;}
 const el=modal('Customer types',`<div class="stack">${rows.map(t=>`<form data-type-form="${t.id}" class="field-row"><input name="name" value="${escape(t.name)}" required><label class="check"><input type="checkbox" name="archived" ${t.archived?'checked':''}>Archived</label><button>Save</button></form>`).join('')}<form id="new-type-form" class="field-row"><input name="name" placeholder="New customer type" required><button>Add</button></form></div>`);
 on('[data-type-form]','submit',async(e,f)=>{e.preventDefault();const v=values(f),t=rows.find(candidate=>candidate.id===f.dataset.typeForm);await ctx.save('customerType.save',{...t,name:v.name,archived:Boolean(v.archived)});await manageTypes(ctx,f);},el);
 on('#new-type-form','submit',async(e,f)=>{e.preventDefault();await ctx.save('customerType.save',{id:newId(),name:values(f).name});await manageTypes(ctx,f);},el);
}
async function manageSites(ctx,c) {
 const el=modal(`${c.name} · Jobsites`,`<div class="stack">${c.jobsites.map(j=>`<div class="row"><span>${escape(j.address)}</span><button data-unlink-site="${j.id}" class="small">Unlink</button></div>`).join('')}<form id="customer-site-search" class="field-row"><input name="search" placeholder="Search jobsite addresses" required><button>Search</button></form><div id="customer-site-results"></div></div>`);
 const body=$('.dialog-body',el);
 const update=async(id,linked)=>{await ctx.save('customer.link',{customerId:c.id,jobsiteId:id,linked});const latest=await ctx.load('customer',c.id);if(el.open&&body.isConnected){await manageSites(ctx,latest);}};
 on('[data-unlink-site]','click',(e,b)=>update(b.dataset.unlinkSite,false),el);
 on('#customer-site-search','submit',async(e,f)=>{e.preventDefault();const data=await ctx.list('jobsite',`/jobsites?source=all&search=${encodeURIComponent(values(f).search)}`);$('#customer-site-results',el).innerHTML=data.items.filter(j=>!c.jobsites.some(s=>s.id===j.id)).map(j=>`<button type="button" data-link-site="${j.id}" class="catalog-item">${escape(j.address)}</button>`).join('');on('[data-link-site]','click',(event,b)=>update(b.dataset.linkSite,true),el);},el);
}

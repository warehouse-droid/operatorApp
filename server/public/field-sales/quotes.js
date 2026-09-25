import {netSuiteCustomerFields,bindNetSuiteCustomerFields} from './netsuite-customer-picker.js';
import { $,escape,on,notify,modal,money,badge,empty,pageHead,values,download,options,dateTime } from './ui.js';
import { newId } from './identity.js';
import { bindItemSearch,itemSearchMarkup } from './item-autocomplete.js';
import { suggestedRate,sameDecimal } from './pricing.js';
import { calculateQuote,COMPANIES } from './domain.js';
import {quoteDates} from './quote-drafts.js';
import { customerLinks } from './customers.js';
let selectedId=null,newSite=null,quote=null,edit=null,ctx=null,view=null,pendingEntry=null,resolving=false,viewPolicy=null,renderSequence=0,reviewedEntry=null;
export function choosePending(entry){pendingEntry=entry;}
export function chooseJobsite(site){newSite=site;selectedId=null;}
export function chooseQuote(id){selectedId=id;newSite=null;}
const quoteNumber=q=>q.number||`FS-${q.company?`${q.company}-`:''}${String(q.quote_number).padStart(6,'0')}`;
const status=q=>(q.orders||[q.order]).filter(Boolean).length&&(q.orders||[q.order]).every(o=>o?.state==='done')?'Sales Orders created':q.confirmation?'Confirmed':q.company||Number(q.schema_version||q.snapshot?.schemaVersion)===3?'Draft':'Legacy quote';
export async function render(context,target) {
 ctx=context;view=target;const renderPass=++renderSequence,routeAtStart=location.hash;
 if(pendingEntry){const entry=pendingEntry;pendingEntry=null;reviewedEntry=entry;
  if(entry.kind==='quote.saveGroup'){return reviewGroup(entry);}
  if(!entry.payload.company&&entry.payload.schemaVersion!==3){return splitLegacy(entry.payload,entry);}
  const statusNow=await ctx.api('/status');ctx.state.settings=statusNow.settings.data;ctx.state.status=statusNow;
  let latest=null;try{latest=await ctx.api(`/quotes/${entry.payload.id}`);}catch(e){if(e.status!==404){throw e;}}
  if(latest?.confirmation){notify('This quote was confirmed. Your pending edits remain in the recovery queue. Copy the saved quote to create a new one.');quote=latest;edit={...latest.snapshot,id:latest.id,jobsiteId:latest.jobsite_id,revision:latest.revision};resolving=false;return editor();}
  quote=latest;const payload=entry.payload,merge=latest?.snapshot.schemaVersion===3&&payload.schemaVersion!==3&&COMPANIES.includes(payload.company);
  edit={...payload,id:latest?.id||payload.id,revision:latest?.revision||0,...(merge?{schemaVersion:3,company:'',lines:[...latest.snapshot.lines.filter(l=>l.company!==payload.company),...payload.lines].map(l=>({...l,id:newId()}))}:{})};resolving=true;return editor();
 }
 resolving=false;reviewedEntry=null;
 if(newSite){const site=newSite;newSite=null;return createQuote(site);}
 if(selectedId){const id=selectedId;selectedId=null;return openQuote(id);}
 const data=await ctx.list('quote'),drafts=(await ctx.state.workspace.records('editquote:')).filter(q=>q?.id);
 if(renderPass!==renderSequence||routeAtStart!==location.hash){return;}
 view.innerHTML=pageHead('Jobsite quotes','One quote, with company pages in one PDF.','<button id="new-quote" class="primary">＋ New quote</button>')+
  `${drafts.length?`<section class="panel panel-pad stack"><h3>Drafts on this device</h3>${drafts.map(d=>`<button data-draft="${d.id}">${escape(d.company||'Combined quote')} · ${escape(d.customerName||'Choose customer')} · ${escape(d.jobsite?.address)}</button>`).join('')}</section>`:''}<section class="panel overflow"><table><thead><tr><th>Quote</th><th>Customer</th><th>Jobsite</th><th>Total CAD</th><th>Status</th><th></th></tr></thead><tbody>${data.items.map(q=>`<tr><td>${escape(quoteNumber(q))}</td><td>${escape(q.customer_name||q.snapshot?.customerName)}</td><td>${escape(q.jobsite?.address||q.snapshot?.jobsite?.address)}</td><td>${money(q.total_minor||q.snapshot?.totalMinor)}</td><td>${badge(status(q))}</td><td><button data-open-quote="${q.id}">Open</button></td></tr>`).join('')}</tbody></table>${data.items.length?'':empty('Create a quote from a jobsite or choose New quote.')}</section>`;
 on('#new-quote','click',()=>pickJobsite(createQuote),view);on('[data-open-quote]','click',(e,b)=>openQuote(b.dataset.openQuote),view);
 on('[data-draft]','click',async(e,b)=>{edit=await ctx.state.workspace.get(`editquote:${b.dataset.draft}`);if(!edit.automaticCompanies&&edit.schemaVersion!==3&&!edit.company&&edit.lines?.length){return splitLegacy(edit);}quote=edit.revision?await ctx.load('quote',edit.id):null;await editor();},view);
}
async function pickJobsite(select) {
 const el=modal('Choose a jobsite','<form id="quote-site-search" class="field-row"><label>Jobsite address or name<input name="search" required></label><button>Search</button></form><div id="quote-site-results" class="catalog-results"></div>');
 on('#quote-site-search','submit',async(e,f)=>{e.preventDefault();const data=await ctx.list('jobsite',`/jobsites?source=all&search=${encodeURIComponent(values(f).search)}`);$('#quote-site-results',el).innerHTML=data.items.map(s=>`<button type="button" data-quote-site="${s.id}" class="catalog-item">${escape(s.address)}</button>`).join('')||empty('No matching jobsite.');on('[data-quote-site]','click',async(event,b)=>{el.close();await select(data.items.find(s=>s.id===b.dataset.quoteSite));},el);},el);
}
function initial(site,company='') {
 return {id:newId(),revision:0,schemaVersion:3,company,automaticCompanies:true,jobsiteId:site.id,jobsite:{id:site.id,address:site.address},fieldSalesCustomerId:'',customerRepresentativeId:'',customerName:'',salesRep:ctx.state.operator.display_name,shippingMethod:'',note:'',currency:'CAD',lines:[]};
}
async function createQuote(site){quote=null;edit=initial(site);await persistEdit();await editor();}
async function openQuote(id,revision) {
 quote=revision?await ctx.api(`/quotes/${id}?revision=${revision}`):await ctx.load('quote',id);
 const historical=Boolean(revision)&&(Number(revision)!==quote.revision||Boolean(quote.parent_quote_id));
 if(![2,3].includes(quote.snapshot.schemaVersion)){return legacyQuote();}
 const draft=historical||quote.confirmation?null:await ctx.state.workspace.get(`editquote:${quote.id}`);
 edit=draft||{...quote.snapshot,id:quote.id,jobsiteId:quote.jobsite_id,revision:quote.revision,lines:structuredClone(quote.snapshot.lines)};
 await editor(historical);
}
async function persistEdit(){await ctx.state.workspace.put(`editquote:${edit.id}`,edit);}
function readForm(){
 const f=$('#quote-details',view);if(!f){return;}Object.assign(edit,values(f));
 for(const line of edit.lines){const root=$(`[data-line="${line.id}"]`,view);if(!root){continue;}const qty=line.quantity,rate=line.unitRate;
  for(const k of ['quantity','unitRate','description']){line[k]=$(`[name=${k}]`,root)?.value??line[k];}
  if(qty!==line.quantity&&rate===line.unitRate&&line.catalogPrice){try{const item={unit_rate:line.catalogPrice.unitRate,pricing:line.catalogPrice.pricing};if(sameDecimal(rate,suggestedRate(item,qty))){line.unitRate=suggestedRate(item,line.quantity)??'';$('[name=unitRate]',root).value=line.unitRate;}}catch{/* incomplete number while typing */}}
 }
}
function totals(){
 for(const l of edit.lines){const out=$(`[data-line="${l.id}"] [data-line-subtotal]`,view);if(out){try{out.textContent=money(calculateQuote({lines:[l]},viewPolicy).lines[0].amountMinor);}catch{out.textContent='—';}}}
 try{const c=calculateQuote(edit,viewPolicy);
  $('#quote-totals',view).innerHTML=`<h3>Quote totals</h3>${COMPANIES.filter(company=>c.lines.some(l=>l.company===company)).map(company=>{const total=c.companies[company];return `<section data-company-total="${company}"><h3>${company}</h3><div class="customer-quote-items">${c.lines.filter(l=>l.company===company).map(l=>`<div class="quote-summary-item"><strong>${escape(l.sku||l.description)}</strong><small>${escape(l.description)}</small><div class="row"><small>${escape(l.quantity)} ${escape(l.unit)} × ${escape(l.unitRate)}</small><strong>${money(l.amountMinor)}</strong></div></div>`).join('')}</div><div class="total-row"><span>Subtotal</span><strong>${money(total.subtotalMinor)}</strong></div><div class="total-row"><span>Tax (${total.taxBps/100}%)</span><span>${money(total.taxMinor)}</span></div><div class="total-row"><strong>${company} total</strong><strong>${money(total.totalMinor)}</strong></div><small>Expires ${escape(quote?.confirmation||quote?.selected_revision!==quote?.revision?(edit.documents?.[company]?.validUntil||edit.validUntil):quoteDates(ctx.today(),ctx.state.settings.companies[company]).validUntil)}</small></section>`;}).join('')}<div class="total-row grand"><span>Total CAD</span><span>${money(c.totalMinor)}</span></div>`;
 }catch(e){$('#quote-totals',view).innerHTML=`<h3>Quote totals</h3><p class="banner warning">${escape(e.message)}</p>`;}
}
function lineMarkup(l,locked){return `<article class="quote-line" data-line="${l.id}"><div class="row"><strong>${escape(l.sku)} ${badge(l.company)}</strong>${!locked?`<button data-remove-line="${l.id}" class="small danger">Remove</button>`:''}</div><label>Description<textarea name="description" ${locked?'disabled':''}>${escape(l.description)}</textarea></label><div class="line-fields"><label>Quantity<input name="quantity" inputmode="decimal" value="${escape(l.quantity)}" ${locked?'disabled':''}></label><label>Unit<input value="${escape(l.unit)}" disabled></label><label>Unit price CAD<input name="unitRate" inputmode="decimal" value="${escape(l.unitRate)}" ${locked?'disabled':''}></label></div><div class="row"><span>Item subtotal</span><strong data-line-subtotal></strong></div>${!locked?`<button data-reprice="${l.id}" class="small">Refresh Trade price</button>`:''}</article>`;}
async function editor(historical=false){
 const renderingDraft=edit;
 const locked=historical||Boolean(quote?.confirmation),all=(await ctx.list('customer',`/customer-records?jobsiteId=${encodeURIComponent(edit.jobsiteId)}`)).items,customers=all.filter(c=>!c.archived&&(c.jobsites||[]).some(s=>s.id===edit.jobsiteId));
 if(edit!==renderingDraft||ctx.state.page!=='quotes'){return;}
 viewPolicy=locked?edit.companyProfiles:ctx.state.settings.companies;
 const customer=locked?edit.customer:customers.find(c=>c.id===edit.fieldSalesCustomerId)||edit.customer;
 const reps=locked&&edit.representative?[edit.representative]:(customer?.representatives||[]).filter(r=>!r.archived);
 view.innerHTML=pageHead(quote?quoteNumber(quote):'New quote',`${edit.jobsite?.address||''}${locked?' · Saved revision '+quote.selected_revision:''}`,'<button id="back-quotes">← All quotes</button>')+
  `${resolving?'<div class="banner warning">Review this pending draft. Saving retains the previous pending copies in recovery history.</div>':''}${quote?.confirmation&&quote.selected_revision===quote.confirmation.revision?`<section class="panel panel-pad"><strong>Confirmed by ${escape(quote.confirmation.confirmedBy)}</strong> · ${escape(dateTime(quote.confirmation.confirmedAt))}<div class="stack">${(quote.orders||[quote.order]).filter(Boolean).map(o=>`<div class="record" data-sales-order="${o.id}"><strong>${escape(o.company||quote.company)} Sales Order</strong><p>${escape(o.reference||o.netsuite_id||'Awaiting NetSuite')} · ${escape(o.state)}</p>${o.error?`<p class="banner warning">${escape(o.error)}</p>`:''}${o.state==='attention'?`<button data-retry-order="${o.id}">Retry ${escape(o.company||quote.company)} order</button>`:''}</div>`).join('')}</div><p>${escape(quote.confirmation.note)}</p><div class="actions">${(quote.confirmation.evidenceIds||[]).map((id,i)=>`<button data-evidence="${id}">Download confirmation ${i+1}</button>`).join('')}</div><button id="copy-quote">Copy to new quote</button></section>`:''}<div class="quote-layout"><div class="stack"><section class="panel panel-pad"><form id="quote-details" class="stack"><label>Customer<select id="quote-customer" name="fieldSalesCustomerId" ${locked?'disabled':''} required>${options([['','Choose customer'],...customers.map(c=>[c.id,c.name]),...(!customers.some(c=>c.id===edit.fieldSalesCustomerId)&&edit.fieldSalesCustomerId?[[edit.fieldSalesCustomerId,edit.customerName]]:[])],edit.fieldSalesCustomerId)}</select></label>${!locked?'<div class="actions"><button type="button" id="quote-change-site">Change jobsite</button><button type="button" id="quote-manage-customers">＋ Add / link customer</button></div>':''}<label>Representative<select id="quote-representative" name="customerRepresentativeId" ${locked?'disabled':''}>${options([['','No specific representative'],...reps.map(r=>[r.id,`${r.name} · ${r.phone||r.email||''}`])],edit.customerRepresentativeId)}</select></label><div class="grid two"><p id="quote-date">Quote date: ${escape(locked?edit.quoteDate:ctx.today())}</p><label>Sales rep<input name="salesRep" value="${escape(edit.salesRep)}" ${locked?'disabled':''}></label><label>Shipping method<select name="shippingMethod" ${locked?'disabled':''}>${options([['','Not specified'],['Pick-Up','Pick-Up'],['Delivery','Delivery']],edit.shippingMethod)}</select></label></div></form></section><section class="panel" id="quote-items"><div class="panel-title"><h3>Items & services</h3></div><div id="quote-lines">${edit.lines.map(l=>lineMarkup(l,locked)).join('')||empty('Add items below. Each company has its own pages in the quote PDF.')}</div>${locked?'':itemSearchMarkup()}</section></div><aside class="stack"><section class="panel panel-pad quote-totals"><div id="quote-totals"></div><label class="quote-memo" for="quote-memo">Memo<textarea id="quote-memo" name="note" form="quote-details" ${locked?'disabled':''}>${escape(edit.note)}</textarea></label></section><section class="panel panel-pad stack">${!locked?'<button id="save-quote" class="primary">Save revision</button>':''}${quote?`<button id="refresh-quote">Refresh saved quote</button><button id="pdf-quote">Download PDF</button>${!locked?`<button id="confirm-quote" ${!ctx.state.settings.salesOrderPostingEnabled||!ctx.state.status.postingAvailable?'disabled':''}>Confirm & Create Sales Orders</button>${!ctx.state.settings.salesOrderPostingEnabled||!ctx.state.status.postingAvailable?'<small>Sales Order integration requires setup in Settings. Quotes and PDFs are available.</small>':''}`:''}<div class="actions">${(quote.versions||[]).map(v=>`<button data-version="${v.revision}" class="small">r${v.revision}</button>`).join('')}</div>${quote.related_versions?.length?`<details><summary>Original company history</summary><div class="stack">${quote.related_versions.map(v=>`<button data-original-id="${v.id}" data-original-revision="${v.revision}">${escape(v.number)} · r${v.revision}</button>`).join('')}</div></details>`:''}`:'<small>Save a revision to download its PDF.</small>'}</section></aside></div>`;
 on('[data-evidence]','click',async(e,b)=>{const blob=await ctx.api(`/quote-evidence/${b.dataset.evidence}`);download(blob,`confirmation-${b.dataset.evidence}.${blob.type.includes('pdf')?'pdf':'jpg'}`);},view);
 totals();on('#back-quotes','click',()=>render(ctx,view),view);
 on('#refresh-quote','click',()=>openQuote(quote.id),view);on('[data-version]','click',(e,b)=>openQuote(quote.id,Number(b.dataset.version)),view);
 on('[data-original-id]','click',(e,b)=>openQuote(b.dataset.originalId,Number(b.dataset.originalRevision)),view);
 on('#pdf-quote','click',async()=>download(await ctx.api(`/quotes/${quote.id}/pdf?revision=${quote.selected_revision}`),`${quoteNumber(quote)}-r${quote.selected_revision}.pdf`),view);
 on('#copy-quote','click',async()=>{const result=await ctx.api('/commands',{id:newId(),kind:'quote.copy',payload:{id:quote.id,newId:newId()}});await openQuote(result.quote.id);},view);
 on('[data-retry-order]','click',async(e,b)=>{await ctx.api('/commands',{id:newId(),kind:'quote.order.retry',payload:{id:quote.id,revision:quote.revision,orderId:b.dataset.retryOrder}});await openQuote(quote.id);},view);
 if(locked){return;}
 const changed=async()=>{readForm();totals();await persistEdit();};
 on('#quote-details input,#quote-details textarea,.quote-line input,.quote-line textarea,#quote-memo','input',changed,view);
 on('#quote-details select','change',changed,view);
 on('#quote-customer','change',async()=>{readForm();$('#item-autocomplete',view).disabled=true;const c=customers.find(candidate=>candidate.id===edit.fieldSalesCustomerId);edit.customer=c;edit.customerName=c?.name||'';edit.customerRepresentativeId='';await persistEdit();await editor();},view);
 on('#quote-representative','change',async()=>{readForm();edit.representative=reps.find(r=>r.id===edit.customerRepresentativeId)||null;await persistEdit();},view);
 on('#quote-change-site','click',async()=>{readForm();await persistEdit();await pickJobsite(async site=>{edit.jobsiteId=site.id;edit.jobsite={id:site.id,address:site.address};edit.fieldSalesCustomerId='';edit.customerRepresentativeId='';edit.customer=null;edit.customerName='';await persistEdit();await editor();});},view);
 on('#quote-manage-customers','click',async()=>{readForm();await persistEdit();const site=await ctx.load('jobsite',edit.jobsiteId),el=modal('Customers at this jobsite','<section id="quote-site-customers" class="stack"></section><section id="quote-customer-editor" class="inline-customer-editor"></section>','<button data-close>Done</button>');await customerLinks(ctx,$('#quote-site-customers',el),$('#quote-customer-editor',el),site);el.addEventListener('close',()=>void editor(),{once:true});},view);
 on('[data-remove-line]','click',async(e,b)=>{readForm();edit.lines=edit.lines.filter(l=>l.id!==b.dataset.removeLine);await persistEdit();await editor();},view);
 on('[data-reprice]','click',(e,b)=>pricePicker(edit.lines.find(l=>l.id===b.dataset.reprice)),view);
 on('#save-quote','click',saveQuote,view);on('#quote-details','submit',async e=>{e.preventDefault();await saveQuote();},view);on('#confirm-quote','click',confirmDialog,view);
 bindItemSearch(ctx,view,addItem);
}
async function saveQuote(){
 readForm();const form=$('#quote-details',view);if(!form.reportValidity()){return;}calculateQuote(edit,ctx.state.settings.companies);
 if(!edit.lines.length){throw new Error('Add at least one item to create a quote.');}edit.schemaVersion=3;
 const original=edit,draft=structuredClone(edit),controls=[...view.querySelectorAll('input,textarea,select,button')].map(element=>[element,element.disabled]);
 controls.forEach(([element])=>{element.disabled=true;});
 try {
  await persistEdit();
  const result=resolving?await ctx.replaceQuote(draft,reviewedEntry):await ctx.save('quote.save',draft);
  await ctx.state.workspace.put(`editquote:${draft.id}`,null);
  if(!stillEditing(original,form)){return;}
  resolving=false;reviewedEntry=null;quote=result.quote;edit={...quote.snapshot,id:quote.id,jobsiteId:quote.jobsite_id,revision:quote.revision};await editor();
  notify('Quote revision saved on this device.');
 }finally{controls.forEach(([element,disabled])=>{if(element.isConnected){element.disabled=disabled;}});}
}
async function reviewGroup(entry){
 const statusNow=await ctx.api('/status');ctx.state.settings=statusNow.settings.data;ctx.state.status=statusNow;
 const parts=[],saved=[];
 for(const part of entry.payload.quotes){
  let latest=null;try{latest=await ctx.api(`/quotes/${part.id}`);}catch(e){if(e.status!==404){throw e;}}
  if(latest?.confirmation){notify('A quote in this group was confirmed. Pending edits remain in recovery. Open a new quote for further changes.');quote=latest;edit={...latest.snapshot,id:latest.id,jobsiteId:latest.jobsite_id,revision:latest.revision};resolving=false;return editor();}
  if(latest&&!saved.some(q=>q.id===latest.id)){saved.push(latest);}parts.push(part);
 }
 quote=saved.length===1?saved[0]:null;edit={...parts[0],id:quote?.id||newId(),revision:quote?.revision||0,schemaVersion:3,company:'',automaticCompanies:true,lines:[...(quote?.snapshot.lines||[]).filter(l=>!parts.some(p=>p.company===l.company)),...parts.flatMap(p=>p.lines)].map(l=>({...l,id:newId()}))};resolving=true;await editor();
}
function stillEditing(draft,form){return edit===draft&&form?.isConnected;}
async function addItem(cached){
 readForm();const draft=edit,form=$('#quote-details');let item=cached;
 try{item=await ctx.api('/catalog/price',{company:cached.company,itemId:cached.item_id,quantity:'1'});await ctx.state.workspace.put(`catalog:${item.company}:${item.item_id}`,item);}catch(e){if(e.status){throw e;}notify('Using saved Trade pricing.');}
 if(!stillEditing(draft,form)){return;}
 edit.lines.push({id:newId(),company:item.company,itemId:item.item_id,sku:item.sku,description:item.description,quantity:'1',unitRate:suggestedRate(item)??'',unit:item.unit,catalogPrice:{unitRate:item.unit_rate,pricing:item.pricing,asOf:item.updated_at}});
 await persistEdit();if(stillEditing(draft,form)){await editor();$('#item-autocomplete').focus();}
}
async function pricePicker(line){
 readForm();const draft=edit,form=$('#quote-details'),item=await ctx.api('/catalog/price',{company:line.company,itemId:line.itemId,quantity:line.quantity});if(!stillEditing(draft,form)){return;}
 const el=modal('Current Trade price',`<p>${escape(line.sku)} · ${escape(item.unit_rate??'No price available')} CAD / ${escape(item.unit)}</p>`,'<button data-close>Cancel</button>'+(item.unit_rate==null?'':'<button id="apply-price" class="primary">Apply price</button>'));
 on('#apply-price','click',async()=>{if(!stillEditing(draft,form)){el.close();return;}line.unitRate=item.unit_rate;line.unit=item.unit;line.catalogPrice={unitRate:item.unit_rate,pricing:item.pricing,asOf:item.updated_at};await persistEdit();el.close();await editor();},el);
}
async function fileBase64(file){if(file.size>8*1024*1024){throw new Error('Confirmation files must be smaller than 8 MB.');}return new Promise((resolve,reject)=>{const r=new globalThis.FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=()=>reject(new Error('Could not read the attachment.'));r.readAsDataURL(file);});}
async function confirmDialog(){
 readForm();if(await ctx.state.workspace.get(`editquote:${edit.id}`)){throw new Error('Save your draft edits as a revision before confirmation.');}
 if(!navigator.onLine){throw new Error('Connect to the internet to confirm and create Sales Orders.');}
 await ctx.sync();if((await ctx.state.workspace.pending()).length){throw new Error('Sync or review pending work before confirmation.');}
 quote=await ctx.api(`/quotes/${quote.id}`);const customer=await ctx.api(`/customer-records/${quote.customer_id}`);const commandId=newId(),fileIds=new Map(),confirmedAt=new Date().toISOString();
 const el=modal('Confirm & Create Sales Orders',`<p><strong>${escape(quoteNumber(quote))} · r${quote.revision}</strong></p><p>${escape(quote.snapshot.customerName)} · ${money(quote.snapshot.totalMinor)} CAD</p><p>The accepted revision will be locked. A Sales Order for each company will be created or linked in NetSuite: ${escape(Object.keys(quote.snapshot.companies).join(', '))}.</p><form id="quote-confirm-form" class="stack">${netSuiteCustomerFields(Object.keys(quote.snapshot.companies),customer)}<label>Customer who confirmed<input name="confirmedBy" value="${escape(quote.snapshot.contact)}" required></label><label>Confirmation time<input name="confirmedAt" value="${confirmedAt}" required></label><label>Confirmation note<textarea name="note"></textarea></label><label>Confirmation evidence (optional)<input id="confirmation-files" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" multiple></label></form>`,'<button data-close>Cancel</button><button form="quote-confirm-form" id="submit-confirmation" class="primary">Confirm & Create Sales Orders</button>');
 const readNetSuiteCustomers=bindNetSuiteCustomerFields(ctx,el);
 on('#quote-confirm-form','submit',async(e,f)=>{e.preventDefault();const button=$('#submit-confirmation',el);button.disabled=true;try{const netsuiteCustomers=readNetSuiteCustomers();if(!f.reportValidity()){return;}const files=[...$('#confirmation-files',el).files];if(files.length>10){throw new Error('Attach up to 10 files.');}const evidenceIds=[];for(const file of files){let id=fileIds.get(file);if(!id){id=newId();fileIds.set(file,id);}await ctx.api(`/quotes/${quote.id}/evidence`,{id,revision:quote.revision,name:file.name,base64:await fileBase64(file)});evidenceIds.push(id);}await ctx.api('/commands',{id:commandId,kind:'quote.confirm',payload:{id:quote.id,revision:quote.revision,...values(f),evidenceIds,netsuiteCustomers,customerRevision:customer.revision}});el.close();await openQuote(quote.id);}finally{button.disabled=false;}},el);
}
async function legacyQuote(){
 const s=quote.snapshot;view.innerHTML=pageHead(quoteNumber(quote),'Historical mixed-company quote','<button id="back-quotes">← All quotes</button>')+`<section class="panel panel-pad stack"><p>${escape(s.customerName)} · ${escape(s.jobsite?.address)}</p><strong>${money(s.totalMinor)}</strong><p>Keep this history and copy all items into one new quote for review.</p><button id="split-legacy">Create combined draft</button><button id="legacy-pdf">Download historical PDF</button></section>`;
 on('#back-quotes','click',()=>render(ctx,view),view);on('#split-legacy','click',()=>splitLegacy({...s,id:quote.id,jobsiteId:quote.jobsite_id}),view);on('#legacy-pdf','click',async()=>download(await ctx.api(`/quotes/${quote.id}/pdf`),quoteNumber(quote)+'.pdf'),view);
}
async function splitLegacy(source,entry){
 const el=modal('Review legacy quote','<p>Create one draft with all company items. Choose a local customer and review it before saving. The original is retained in recovery history.</p>','<button data-close>Cancel</button><button id="split-drafts" class="primary">Create combined draft</button>');
 on('#split-drafts','click',async()=>{const site=await ctx.load('jobsite',source.jobsiteId||source.jobsite?.id),drafts=[{...initial(site),note:source.note||'',lines:(source.lines||[]).map(l=>({...l,id:newId()}))}];await ctx.state.workspace.splitLegacy(source,entry,drafts);el.close();await render(ctx,view);},el);
}

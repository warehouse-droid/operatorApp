import {formatDeadline,formatRentalPeriod} from './domain.js';
import {escapeHtml,notice,badge,agreementHtml,signedHtml,downloadPdf} from './ui.js';
import {equipmentModels,equipmentForModel} from './equipment.js';
import {renderEquipmentSetup} from './setup.js';
import {ratesForModel} from './rates.js';
const app=document.getElementById('mbrApp'),token=localStorage.getItem('mbbs.staff.token') || '';
const path=location.pathname.replace(/\/+$/u,'');
const selectedId=path.startsWith('/mbr/contracts/')?path.split('/').at(-1):null;
let contract=null,offset=0,search='',status='',loading=false,equipment=[],modelRates=[];
async function request(endpoint,{method='GET',body}={}) {
  const response=await fetch('/api/mbr'+endpoint,{method,headers:{authorization:'Bearer '+token,
    ...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store'});
  const result=await response.json();
  if(!response.ok) {const error=new Error(result.error || 'Could not complete this request. Please try again.');error.code=result.code;throw error;}
  return result;
}
function today() {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const get=type=>parts.find(part=>part.type===type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function listShell() {
  app.innerHTML=`<section class="mbr-card"><form id="mbrSearch" class="mbr-search"><label><span>Search contracts</span><input name="search" type="search" maxlength="200" placeholder="Lessee, contract, equipment or serial"></label><label><span>Status</span><select name="status"><option value="">All statuses</option><option value="pending">Pending</option><option value="completed">Completed</option><option value="expired">Expired</option></select></label><button type="submit">Search</button></form></section><p class="mbr-muted">All MBR contracts · shared with the MBR Sales team</p><div id="mbrContracts" class="mbr-contracts"></div><div class="mbr-actions"><button id="mbrLoadMore" type="button" hidden>Load more</button></div>`;
  document.getElementById('mbrSearch').addEventListener('submit',async event=>{
    event.preventDefault();const form=new FormData(event.currentTarget);search=String(form.get('search')).trim();status=String(form.get('status'));offset=0;
    await loadList(false);
  });
  document.getElementById('mbrLoadMore').addEventListener('click',()=>loadList(true));
}
async function loadList(append=false) {
  if(loading) {return;}loading=true;
  const button=document.getElementById('mbrLoadMore');button.disabled=true;
  try {
    const result=await request(`/contracts?${new URLSearchParams({search,status,offset:String(offset)})}`);
    const markup=result.items.map(contractCard).join('');
    const target=document.getElementById('mbrContracts');
    if(append) {target.insertAdjacentHTML('beforeend',markup);}else {target.innerHTML=markup || '<section class="mbr-card"><h2>No contracts found</h2><p>Create a contract or try another search.</p></section>';}
    offset+=result.items.length;button.hidden=!result.hasMore;notice('');
  } catch(error) {notice(error.message,'error');}finally {loading=false;button.disabled=false;}
}
function contractCard(item) {
  const description=[item.fields.equipmentModel,item.fields.serialNumber].filter(Boolean).map(escapeHtml).join(' · ');
  return `<article class="mbr-contract-card"><a class="mbr-contract-details" href="/mbr/contracts/${escapeHtml(item.id)}"><div class="mbr-card-top"><strong>${escapeHtml(item.number)}</strong>${badge(item.status)}</div><h2>${escapeHtml(item.fields.lessee || 'Untitled contract')}</h2><p>${description}</p><p class="mbr-muted">${escapeHtml(formatRentalPeriod(item.fields.rentalStart,item.fields.rentalEnd))}</p><small>${item.status==='completed'?'Signed '+escapeHtml(formatDeadline(item.completedAt)):'Signing deadline: '+escapeHtml(formatDeadline(item.expiresAt))}</small></a><div class="mbr-actions"><button type="button" data-action="pdf" data-contract-id="${escapeHtml(item.id)}">${item.status==='completed'?'Download signed PDF':'Download PDF'}</button></div></article>`;
}
function serialOptions(model,selected='') {
  return '<option value="">'+(model?'Select serial number':'Select a model first')+'</option>'+equipmentForModel(equipment,model,contract?.fields)
    .map(item=>`<option value="${escapeHtml(item.serialNumber)}" ${item.serialNumber===selected?'selected':''}>${escapeHtml(item.serialNumber)}${item.unitCode?' · '+escapeHtml(item.unitCode):''}${item.legacy?' (saved equipment)':''}</option>`).join('');
}
function equipmentFields(f) {
  const models=equipmentModels(equipment,contract?.fields).map(model=>`<option value="${escapeHtml(model)}" ${model===f.equipmentModel?'selected':''}>${escapeHtml(model)}</option>`).join('');
  return `<label><span id="mbrEquipmentModelLabel">Equipment model</span><select name="equipmentModel" aria-labelledby="mbrEquipmentModelLabel"><option value="">Select model</option>${models}</select></label>
    <label><span id="mbrSerialNumberLabel">Serial number</span><select name="serialNumber" aria-labelledby="mbrSerialNumberLabel" aria-describedby="mbrSerialNumberHelp" ${f.equipmentModel?'':'disabled'}>${serialOptions(f.equipmentModel || '',f.serialNumber)}</select><p class="mbr-field-help" id="mbrSerialNumberHelp">SN / VIN · unit code. Choose a model to see its units.</p></label>`;
}
const moneyValue=value=>value===undefined || value===null?'':(value/100).toFixed(2);
function field(label,name,value,{type='text',maximum=300,wide=false,help=''}={}) {
  return `<label class="${wide?'wide':''}"><span>${escapeHtml(label)}</span><input name="${name}" type="${type}" maxlength="${maximum}" value="${escapeHtml(value)}" ${name.endsWith('Rate') || name==='securityDeposit'?'inputmode="decimal"':''} ${type==='number'?'min="1" step="1"':''}>${help?`<p class="mbr-field-help">${help}</p>`:''}</label>`;
}
function editorFields(f) {
  return `${field('Effective date','effectiveDate',f.effectiveDate,{type:'date'})}${field('Lessee / company','lessee',f.lessee)}
    ${equipmentFields(f)}
    ${field('Rental start date','rentalStart',f.rentalStart,{type:'date'})}${field('Rental end date','rentalEnd',f.rentalEnd,{type:'date'})}
    ${field('Pickup location','pickupLocation',f.pickupLocation,{maximum:500})}${field('Return location','returnLocation',f.returnLocation,{maximum:500})}
    ${field('Daily rate (CAD)','dailyRate',moneyValue(f.dailyRateMinor))}${field('Weekly rate (CAD)','weeklyRate',moneyValue(f.weeklyRateMinor))}
    ${field('Monthly rate (CAD)','monthlyRate',moneyValue(f.monthlyRateMinor))}${field('Refundable deposit (CAD)','securityDeposit',moneyValue(f.securityDepositMinor))}
    ${field('Signing link expiry (days)','expiryDays',f.expiryDays,{type:'number',help:'Leave blank to use 3 days when generating the link. Saving changes to an issued contract restarts this period.'})}`;
}
function editorMetadata() {
  if(!contract) {return '<h2>Contract details</h2>';}
  const deadline=contract.status==='completed'?'Signed: '+formatDeadline(contract.completedAt):'Signing deadline: '+formatDeadline(contract.expiresAt);
  const expired=contract.status==='expired'?'<p class="mbr-notice">This contract expired. Renewing creates a new signing link; the old link stays inactive.</p>':'';
  return `<div class="mbr-card-top"><h2>Contract details</h2>${badge(contract.status)}</div><p class="mbr-muted">${escapeHtml(deadline)}</p>${expired}`;
}
function editorActions() {
  if(contract?.status==='completed') {return '';}
  const pdf=contract?'<button type="button" data-action="pdf">Download PDF</button>':'';
  if(contract?.status==='expired') {return `<div class="mbr-actions"><button class="primary" type="submit">Renew &amp; generate link</button>${pdf}</div>`;}
  const link=contract?`<button type="button" data-action="link">${contract.issuedAt?'Copy signing link':'Generate signing link'}</button>`:'';
  return `<div class="mbr-actions"><button class="primary" type="submit">${contract?'Save changes':'Save contract'}</button>${link}${pdf}</div>`;
}
function editorHistory() {
  if(!contract) {return '';}
  const entries=contract.history.map(item=>`<li><strong>${escapeHtml(item.kind.replaceAll('_',' '))}</strong> · ${escapeHtml(item.actorName)}<small>${escapeHtml(formatDeadline(item.at))} · Revision ${item.revision}</small></li>`).join('');
  return `<details class="mbr-card"><summary>Preview agreement</summary>${agreementHtml(contract.paragraphs)}</details><details class="mbr-card"><summary>Recent contract history</summary><ul class="mbr-history">${entries}</ul></details>`;
}
function renderEditor() {
  const f=contract?.fields || {effectiveDate:today(),rentalStart:today(),expiryDays:3};
  const completed=contract?.status==='completed';
  document.getElementById('mbrHeading').textContent=contract?.number || 'New contract';
  app.innerHTML=`<a class="mbr-button" href="/mbr/contracts">← All contracts</a><section class="mbr-card" style="margin-top:18px">${editorMetadata()}<form id="mbrEditor"><fieldset ${completed?'disabled':''}><div class="mbr-grid">${editorFields(f)}</div></fieldset>${editorActions()}</form><div class="mbr-link-box" id="mbrLink" hidden></div></section>${completed?signedHtml(contract):''}${editorHistory()}`;
  const form=document.getElementById('mbrEditor');form.addEventListener('submit',save);
  form.elements.equipmentModel.addEventListener('change',()=>{
    const model=form.elements.equipmentModel.value,serial=form.elements.serialNumber;
    serial.innerHTML=serialOptions(model);serial.disabled=!model;
    const rates=ratesForModel(modelRates,model);
    for(const name of ['dailyRate','weeklyRate','monthlyRate']) {form.elements[name].value=moneyValue(rates[name+'Minor']);}
  });
  form.addEventListener('input',()=>{for(const button of form.querySelectorAll('[data-action=link],[data-action=pdf]')) {
    button.disabled=true;button.title='Save your changes before copying the link or downloading the PDF.';
  }});
}
function formFields(form) {
  const input=Object.fromEntries(new FormData(form));
  return {...input,expiryDays:input.expiryDays?Number(input.expiryDays):null,...(contract?{revision:contract.revision}:{})};
}
async function save(event) {
  event.preventDefault();const form=event.currentTarget;if(!form.reportValidity()) {return;}
  const button=form.querySelector('[type=submit]');button.disabled=true;notice('');
  try {
    const renewal=contract?.status==='expired',body=formFields(form);
    const result=await request(renewal?`/contracts/${contract.id}/renew`:contract?`/contracts/${contract.id}`:'/contracts',
      {method:renewal || !contract?'POST':'PATCH',body});
    contract=renewal?result.contract:result;history.replaceState(null,'',`/mbr/contracts/${contract.id}`);
    renderEditor();notice(renewal?'Contract renewed. Send the new signing link to the customer.':'Contract saved.','success');
    if(renewal) {await showLink(result.url);}
  } catch(error) {notice(error.message,'error');}finally {button.disabled=false;}
}
async function showLink(url) {
  const parsed=new URL(url),publicUrl=new URL(parsed.pathname+parsed.hash,location.origin).toString();
  const target=document.getElementById('mbrLink');target.hidden=false;
  target.innerHTML=`<label><span>Customer signing link</span><input id="mbrLinkUrl" readonly type="url" value="${escapeHtml(publicUrl)}"></label><p class="mbr-field-help">Send this link to the customer. ${escapeHtml(formatDeadline(contract.expiresAt))}.</p>`;
  try {await navigator.clipboard.writeText(publicUrl);notice('Signing link copied. Send it to the customer.','success');}
  catch {document.getElementById('mbrLinkUrl').select();notice('Signing link ready. Copy the link below and send it to the customer.');}
}
app.addEventListener('click',async event=>{
  const button=event.target.closest('[data-action]');if(!button || button.disabled) {return;}
  button.disabled=true;
  try {
    if(button.dataset.action==='link') {
      const result=await request(`/contracts/${contract.id}/link`,{method:'POST',body:{revision:contract.revision}});
      contract=await request(`/contracts/${contract.id}`);
      renderEditor();await showLink(result.url);
    }
    if(button.dataset.action==='pdf') {
      const id=button.dataset.contractId || contract.id;
      await downloadPdf(await fetch(`/api/mbr/contracts/${id}/pdf`,{headers:{authorization:'Bearer '+token},cache:'no-store'}));
    }
  } catch(error) {notice(error.message,'error');}finally {button.disabled=false;}
});
const menuButton=document.getElementById('mbrModuleMenu'),backdrop=document.getElementById('mbrMenuBackdrop');
function sidebarInert() {
  const sidebar=document.getElementById('appSidebar');
  if(sidebar) {sidebar.inert=matchMedia('(max-width:760px)').matches && !document.body.classList.contains('mbr-menu-open');}
}
function toggleMenu(open) {
  document.body.classList.toggle('mbr-menu-open',open);backdrop.classList.toggle('active',open);menuButton.setAttribute('aria-expanded',String(open));
  const sidebar=document.getElementById('appSidebar');if(sidebar){sidebar.inert=matchMedia('(max-width:760px)').matches && !open;}
  if(!open){menuButton.focus();}
}
menuButton.addEventListener('click',()=>toggleMenu(!document.body.classList.contains('mbr-menu-open')));
backdrop.addEventListener('click',()=>toggleMenu(false));
document.addEventListener('keydown',event=>{if(event.key==='Escape' && document.body.classList.contains('mbr-menu-open')){toggleMenu(false);}});
new MutationObserver(sidebarInert).observe(document.body,{childList:true});
sidebarInert();window.addEventListener('resize',sidebarInert);
async function start() {
  if(!token) {location.assign('/?next='+encodeURIComponent(location.pathname));return;}
  await request('/status');
  if(path==='/mbr/setup') {
    document.title='MBR Setup';document.getElementById('mbrHeading').textContent='MBR Setup';
    document.getElementById('mbrEyebrow').textContent='MBR / Setup';
    document.getElementById('mbrSetupLink').hidden=true;
    await renderEquipmentSetup({app,request});return;
  }
  if(selectedId) {
    const [units,rates]=await Promise.all([request('/setup/equipment'),request('/setup/rates')]);
    equipment=units.items;modelRates=rates.items;
  }
  if(selectedId==='new') {renderEditor();return;}
  if(selectedId) {contract=await request(`/contracts/${selectedId}`);renderEditor();return;}
  listShell();await loadList();
}
start().catch(error=>{app.innerHTML='<section class="mbr-card"><h2>Contracts unavailable</h2><p>Sign in with an MBR Sales or Admin account.</p><a class="mbr-button" href="/">Staff login</a></section>';notice(error.message,'error');});

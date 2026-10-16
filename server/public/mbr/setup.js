import {escapeHtml,notice} from './ui.js';
import {equipmentModels} from './equipment.js';
import {renderModelRatesSetup} from './rates-setup.js';

function setupField(label,name,value,maximum=300,required=true) {
  return `<label><span>${label}</span><input name="${name}" maxlength="${maximum}" ${required?'required':''} value="${escapeHtml(value)}"></label>`;
}
function formMarkup(item) {
  return `<h2>${item?'Edit equipment':'Add equipment'}</h2><form id="mbrEquipmentEditor"><div class="mbr-grid">
    ${setupField('Brand','brand',item?.brand,100)}${setupField('Model','model',item?.model)}
    ${setupField('Unit code','unitCode',item?.unitCode,100)}${setupField('Serial number / VIN','serialNumber',item?.serialNumber,150)}
    ${setupField('Description','description',item?.description,500,false)}
    <label class="mbr-consent"><input name="active" type="checkbox" ${item?.active===false?'':'checked'}>Available for new contracts</label>
    </div><div class="mbr-actions"><button type="submit" class="primary">${item?'Save equipment':'Add equipment'}</button>
    ${item?'<button type="button" data-setup-cancel>Cancel edit</button>':''}</div></form>`;
}
function tableMarkup(items) {
  const rows=items.map(item=>`<tr><td>${escapeHtml(item.brand)}</td><td>${escapeHtml(item.model)}</td>
    <td>${escapeHtml(item.description)}</td><td>${escapeHtml(item.unitCode)}</td><td>${escapeHtml(item.serialNumber)}</td>
    <td>${item.active?'Available':'Inactive'}</td><td><button type="button" data-setup-edit="${item.id}" aria-label="Edit ${escapeHtml(item.unitCode)}">Edit</button></td></tr>`).join('');
  return `<div class="mbr-table-wrap" role="region" aria-label="Equipment register" tabindex="0"><table class="mbr-equipment-table">
    <caption>Equipment register</caption><thead><tr><th scope="col">Brand</th><th scope="col">Model</th><th scope="col">Description</th>
    <th scope="col">Unit code</th><th scope="col">SN / VIN</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7">No matching equipment.</td></tr>'}</tbody></table></div>`;
}
export async function renderEquipmentSetup({app,request}) {
  let items=(await request('/setup/equipment')).items,editing=null;
  app.innerHTML='<section class="mbr-card" id="mbrModelRates"></section><section class="mbr-card"><h2>Rental equipment</h2><p>Maintain the models and serial numbers used in MBR contracts. Deactivate a unit to remove it from new contract choices.</p><p id="mbrEquipmentCount" class="mbr-muted"></p><label><span>Search equipment</span><input id="mbrEquipmentSearch" type="search" placeholder="Brand, model, unit code or VIN" maxlength="200"></label><div id="mbrEquipmentTable"></div></section><section class="mbr-card" id="mbrEquipmentForm"></section>';
  const renderRates=()=>renderModelRatesSetup({section:document.getElementById('mbrModelRates'),request});
  function renderTable() {
    const search=document.getElementById('mbrEquipmentSearch').value.trim().toLowerCase();
    const visible=items.filter(item=>[item.brand,item.model,item.description,item.unitCode,item.serialNumber].some(value=>value.toLowerCase().includes(search)));
    document.getElementById('mbrEquipmentCount').textContent=`${items.length} units · ${equipmentModels(items).length} available models`;
    document.getElementById('mbrEquipmentTable').innerHTML=tableMarkup(visible);
  }
  function renderForm() {
    document.getElementById('mbrEquipmentForm').innerHTML=formMarkup(editing);
    document.getElementById('mbrEquipmentEditor').addEventListener('submit',async event=>{
      event.preventDefault();const form=event.currentTarget;if(!form.reportValidity()) {return;}
      const button=form.querySelector('[type=submit]');button.disabled=true;
      const data=Object.fromEntries(new FormData(form));
      try {
        await request(editing?'/setup/equipment/'+editing.id:'/setup/equipment',{
          method:editing?'PATCH':'POST',body:{...data,active:form.elements.active.checked,...(editing?{revision:editing.revision}:{})}});
        items=(await request('/setup/equipment')).items;editing=null;renderTable();renderForm();await renderRates();notice('Equipment saved.','success');
      } catch(error) {notice(error.message,'error');}finally {button.disabled=false;}
    });
  }
  app.addEventListener('click',event=>{
    const edit=event.target.closest('[data-setup-edit]'),cancel=event.target.closest('[data-setup-cancel]');
    if(!edit && !cancel) {return;}
    editing=edit?items.find(item=>item.id===Number(edit.dataset.setupEdit)):null;
    renderForm();notice('');
    document.getElementById('mbrEquipmentForm').scrollIntoView({block:'start'});
    document.getElementById('mbrEquipmentEditor').elements.brand.focus({preventScroll:true});
  });
  document.getElementById('mbrEquipmentSearch').addEventListener('input',renderTable);
  renderTable();renderForm();await renderRates();
}

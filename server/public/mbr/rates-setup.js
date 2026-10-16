import {formatMoney} from './domain.js';
import {escapeHtml,notice} from './ui.js';

const fields=[['Daily','dailyRate'],['Weekly','weeklyRate'],['Monthly','monthlyRate']];
function rateTable(items) {
  const rows=items.map(item=>`<tr><td>${escapeHtml(item.model)}</td>${fields.map(([,key])=>`<td>${escapeHtml(formatMoney(item[key+'Minor']))}</td>`).join('')}
    <td><button type="button" data-rate-model="${escapeHtml(item.model)}" aria-label="Edit rates for ${escapeHtml(item.model)}">Edit rates</button></td></tr>`).join('');
  return `<div class="mbr-table-wrap" role="region" aria-label="Model rental rates" tabindex="0"><table class="mbr-rates-table">
    <caption>Model rental rates (CAD)</caption><thead><tr><th scope="col">Model</th><th scope="col">Daily</th><th scope="col">Weekly</th><th scope="col">Monthly</th><th scope="col">Actions</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5">Add equipment to configure model rates.</td></tr>'}</tbody></table></div>`;
}
function rateForm(item) {
  return `<h3>Edit rates for ${escapeHtml(item.model)}</h3><form id="mbrRatesEditor"><div class="mbr-grid">${fields.map(([label,key])=>{
    const value=item[key+'Minor'];
    return `<label><span>${label} rate (CAD)</span><input name="${key}" inputmode="decimal" maxlength="13" value="${value===null?'':(value/100).toFixed(2)}"></label>`;
  }).join('')}</div><div class="mbr-actions"><button type="submit" class="primary">Save rates</button><button type="button" data-rate-cancel>Cancel</button></div></form>`;
}
export async function renderModelRatesSetup({section,request}) {
  let items=(await request('/setup/rates')).items;
  section.innerHTML='<h2>Default rental rates</h2><p>Choosing a model fills these rates into the contract. Sales can edit the contract prices. Leave a rate blank when no default is set.</p><div data-rate-table></div><div data-rate-form hidden></div>';
  const table=section.querySelector('[data-rate-table]'),editor=section.querySelector('[data-rate-form]');
  table.innerHTML=rateTable(items);
  section.onclick=event=>{
    const button=event.target.closest('[data-rate-model]');
    if(event.target.closest('[data-rate-cancel]')) {editor.hidden=true;return;}
    if(!button) {return;}
    const item=items.find(row=>row.model===button.dataset.rateModel);
    editor.hidden=false;editor.innerHTML=rateForm(item);notice('');
    const form=editor.querySelector('form');form.elements.dailyRate.focus();
    form.addEventListener('submit',async submission=>{
      submission.preventDefault();const submit=form.querySelector('[type=submit]');submit.disabled=true;
      try {
        await request('/setup/rates',{method:'PATCH',body:{...Object.fromEntries(new FormData(form)),model:item.model,revision:item.revision}});
        items=(await request('/setup/rates')).items;table.innerHTML=rateTable(items);editor.hidden=true;notice('Rates saved.','success');
      } catch(error) {notice(error.message,'error');}finally {submit.disabled=false;}
    });
  };
}

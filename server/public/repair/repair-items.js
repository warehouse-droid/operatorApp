import {html as rh} from './i18n.js?v=20261030-repair-language';
import {esc} from './client.js?v=20261030-repair-language';
const defaults=[{id:'10650',itemid:'SVC-GEN-REPAIR',displayname:'General Mechanical Repair'},{id:'10660',itemid:'SVC-GEN-DIAG',displayname:'Diagnosis / inspection'},{id:'10555',itemid:'Repair Parts charge',displayname:'Repair Parts charge'}];
export const repairItems=state=>[...new Map([...defaults,...(state.services||[])].map(item=>[String(item.id),item])).values()];
export const basePriceFor=(state,line)=>repairItems(state).find(item=>String(item.id)===(line.itemId||(line.kind==='part'?'10555':'10650')))?.basePrice??'';
const caption=item=>[item.itemid,item.displayname&&item.displayname!==item.itemid?item.displayname:''].filter(Boolean).join(' · ');
export function repairItemInput(state,line){
 const id=line.itemId||(line.kind==='part'?'10555':'10650'),item=repairItems(state).find(item=>String(item.id)===id),listId='repair-item-'+line.id;
 return rh`<div class="repair-item-picker"><label>Repair item<input type="search" data-repair-item-search role="combobox" aria-label="Repair item" aria-autocomplete="list" aria-expanded="false" aria-controls="${esc(listId)}" autocomplete="off" value="${esc(item?caption(item):'NetSuite item '+id)}" placeholder="Search repair code or item name" required><input type="hidden" name="itemId" value="${esc(id)}"></label><div id="${esc(listId)}" role="listbox" class="repair-item-results" hidden></div></div>`;
}
export function installRepairItemPicker(root,state){
 function choose(row,item){row.querySelector('[name=itemId]').value=String(item.id);row.querySelector('[name=unitPrice]').value=item.basePrice??'';row.querySelector('[data-repair-item-search]').value=caption(item);row.querySelector('[data-repair-item-search]').setAttribute('aria-expanded','false');row.querySelector('[role=listbox]').hidden=true;const description=row.querySelector('[name=description]');if(description&&!description.value)description.value=item.displayname||item.itemid;}
 root.addEventListener('input',event=>{
  if(!event.target.matches('[data-repair-item-search]'))return;const row=event.target.closest('.quote-line'),list=row.querySelector('[role=listbox]'),search=event.target.value.trim().toLowerCase();row.querySelector('[name=itemId]').value='';
  const items=repairItems(state).filter(item=>`${item.itemid} ${item.displayname||''}`.toLowerCase().includes(search)).slice(0,15);list.innerHTML=items.map(item=>rh`<button type="button" role="option" data-repair-item-id="${esc(item.id)}">${esc(caption(item))}</button>`).join('')||rh('<p>No matching repair items.</p>');list.hidden=false;event.target.setAttribute('aria-expanded','true');
 });
 root.addEventListener('click',event=>{const button=event.target.closest('[data-repair-item-id]');if(button){const item=repairItems(state).find(item=>String(item.id)===button.dataset.repairItemId);if(item)choose(button.closest('.quote-line'),item);}});
 root.addEventListener('change',event=>{if(event.target.name!=='kind'||!event.target.closest('.quote-line'))return;const row=event.target.closest('.quote-line'),id=event.target.value==='part'?'10555':'10650';choose(row,repairItems(state).find(item=>String(item.id)===id));});
 root.addEventListener('keydown',event=>{if(!event.target.matches('[data-repair-item-search]'))return;const list=event.target.closest('.quote-line').querySelector('[role=listbox]');if(event.key==='ArrowDown'){event.preventDefault();list.querySelector('button')?.focus();}if(event.key==='Escape'){list.hidden=true;event.target.setAttribute('aria-expanded','false');}});
}

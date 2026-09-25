import { $,escape,on,notify } from './ui.js';

export function customerSearchMarkup(){
 return `<div class="customer-search"><div class="field-row"><div class="item-search-field"><label for="site-customer-search">Add an existing customer</label><input id="site-customer-search" type="text" role="combobox" autocomplete="off" aria-autocomplete="list" aria-expanded="false" aria-controls="site-customer-suggestions" aria-describedby="site-customer-status" placeholder="Search name, phone or email"><div id="site-customer-suggestions" class="item-suggestions" role="listbox" aria-label="Matching customers" hidden></div></div><button type="button" id="site-customer-add" disabled>Add to site</button></div><small id="site-customer-status" role="status">Choose a customer from the suggestions, then add it to this site.</small></div>`;
}

export function bindCustomerSearch(ctx,root,siteId,linkedIds,submit){
 const input=$('#site-customer-search',root),list=$('#site-customer-suggestions',root),button=$('#site-customer-add',root),status=$('#site-customer-status',root);
 let sequence=0,timer,items=[],active=-1,selected=null,busy=false;
 const close=()=>{clearTimeout(timer);sequence++;list.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');active=-1;};
 const choose=index=>{
  if(!items[index]||busy){return;}selected=items[index];close();input.value=selected.name;button.disabled=false;
  status.textContent=[selected.name,selected.phone,selected.email].filter(Boolean).join(' · ');input.focus();
 };
 const add=async()=>{
  if(busy||!selected){return;}busy=true;close();input.disabled=true;button.disabled=true;status.textContent='Adding customer…';
  try{await submit(selected);}catch(e){notify(e.message);status.textContent=e.message;}
  finally{busy=false;input.disabled=false;button.disabled=!selected;}
 };
 const search=async token=>{
  const term=input.value.trim(),data=await ctx.list('customer',`/customer-records?search=${encodeURIComponent(term)}`);
  if(token!==sequence||!input.isConnected){return;}
  items=data.items.filter(c=>!c.archived&&!linkedIds.includes(c.id)&&!(c.jobsites||[]).some(s=>s.id===siteId)&&
   [c.name,c.phone,c.email,...(c.representatives||[]).filter(r=>!r.archived).flatMap(r=>[r.name,r.phone,r.email])].join(' ').toLowerCase().includes(term.toLowerCase())).slice(0,20);
  list.innerHTML=items.map((c,i)=>`<button type="button" id="site-customer-choice-${i}" data-customer-choice="${i}" role="option" aria-selected="false"><strong>${escape(c.name)}</strong><small>${escape([c.phone,c.email].filter(Boolean).join(' · '))}</small>${(c.representatives||[]).filter(r=>!r.archived).slice(0,3).map(r=>`<small>${escape([r.name,r.phone,r.email].filter(Boolean).join(' · '))}</small>`).join('')}</button>`).join('');
  active=-1;input.removeAttribute('aria-activedescendant');list.hidden=!items.length;input.setAttribute('aria-expanded',String(items.length>0));
  status.textContent=items.length?`${items.length} matching customers`:'No matching customers available to add.';
  on('[data-customer-choice]','pointerdown',e=>e.preventDefault(),list);on('[data-customer-choice]','click',(e,b)=>choose(Number(b.dataset.customerChoice)),list);
 };
 const schedule=()=>{
  if(busy){return;}close();items=[];list.innerHTML='';const term=input.value.trim();
  if(!term){status.textContent='Search by customer name, phone or email.';return;}
  status.textContent='Searching…';const token=sequence;
  timer=setTimeout(()=>search(token).catch(e=>{if(token===sequence&&input.isConnected){status.textContent=e.message;}}),180);
 };
 input.addEventListener('input',()=>{selected=null;button.disabled=true;schedule();});
 input.addEventListener('focus',()=>{if(!selected){schedule();}});
 input.addEventListener('blur',()=>setTimeout(()=>{if(document.activeElement!==input&&!list.contains(document.activeElement)){close();}},0));
 input.addEventListener('keydown',event=>{
  if(event.key==='Escape'){event.preventDefault();close();return;}
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){
   event.preventDefault();if(list.hidden){schedule();return;}
   active=(active+(event.key==='ArrowDown'?1:active<0?0:-1)+items.length)%items.length;
   list.querySelectorAll('[role=option]').forEach((el,i)=>el.setAttribute('aria-selected',String(i===active)));
   input.setAttribute('aria-activedescendant',`site-customer-choice-${active}`);$(`#site-customer-choice-${active}`,list)?.scrollIntoView({block:'nearest'});
  }else if(event.key==='Enter'){
   event.preventDefault();if(!list.hidden&&active>=0){choose(active);}else if(selected){void add();}
  }
 });
 on('#site-customer-add','click',add,root);
 return {close};
}

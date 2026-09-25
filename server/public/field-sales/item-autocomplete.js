import { $,escape,on,notify } from './ui.js';
import { priceLevel,suggestedRate } from './pricing.js';
export function itemSearchMarkup() {
  return `<div class="item-search panel-pad"><div class="field-row"><div class="item-search-field"><label for="item-autocomplete">Add item</label><input id="item-autocomplete" type="text" role="combobox" autocomplete="off" aria-autocomplete="list" aria-expanded="false" aria-controls="item-suggestions" placeholder="Type an item code or description"><div id="item-suggestions" class="item-suggestions" role="listbox" aria-label="Matching items" hidden></div></div></div><small id="item-search-status" role="status">MBBS: Trade-A · MBR & MBT: Trade</small></div>`;
}
export function bindItemSearch(ctx,root,select,company='') {
  const input=$('#item-autocomplete',root),list=$('#item-suggestions',root),status=$('#item-search-status',root);
  let sequence=0,timer,items=[],active=-1,busy=false;
  const close=()=>{clearTimeout(timer);sequence++;list.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');active=-1;};
  const highlight=()=>{
    list.querySelectorAll('[role=option]').forEach((el,index)=>el.setAttribute('aria-selected',String(index===active)));
    if(active>=0){input.setAttribute('aria-activedescendant',`item-choice-${active}`);$(`#item-choice-${active}`,list)?.scrollIntoView({block:'nearest'});}
  };
  const choose=async index=>{
    if(busy||!items[index]){return;}
    busy=true;const item=items[index];close();input.disabled=true;status.textContent='Reading current price…';
    try{await select(item);}
    catch(error){notify(error.message);status.textContent=error.message;}
    finally{busy=false;input.disabled=false;}
  };
  const search=async token=>{
    const term=input.value.trim();let found,cached=false;
    try{
      found=(await ctx.api(`/catalog?${new URLSearchParams({search:term,limit:'30',...(company?{company}:{})})}`)).items;
      for(const item of found){await ctx.state.workspace.put(`catalog:${item.company}:${item.item_id}`,item);}
    }catch(error){
      if(error.status&&error.status<500){if(token===sequence){status.textContent=error.message;}return;}
      cached=true;found=(await ctx.state.workspace.records('catalog:')).filter(i=>(!company||i.company===company)&&`${i.sku} ${i.description}`.toLowerCase().includes(term.toLowerCase())).slice(0,30);
    }
    if(token!==sequence||!input.isConnected){return;}
    items=found;active=-1;input.removeAttribute('aria-activedescendant');
    list.innerHTML=items.map((item,index)=>{
      const suggestion=suggestedRate(item);
      const rate=suggestion==null?'Agreed price required':`${new Intl.NumberFormat('en-CA',{style:'currency',currency:'CAD',maximumFractionDigits:6}).format(Number(suggestion))} / ${escape(item.unit||'unit')}`;
      return `<button type="button" role="option" aria-selected="false" id="item-choice-${index}" data-item="${index}"><span><strong>${escape(item.sku)}</strong> <span class="badge">${escape(item.company)}</span></span><span>${escape(item.description)}</span><small>${rate} · ${priceLevel(item.company)}</small></button>`;
    }).join('');
    list.hidden=!items.length;input.setAttribute('aria-expanded',String(items.length>0));
    status.textContent=items.length?`${items.length} matching items${cached?' · saved on this device':''}`:'No matching items. An admin can refresh the catalog in Settings.';
    on('[data-item]','pointerdown',e=>e.preventDefault(),list);on('[data-item]','click',(e,b)=>choose(Number(b.dataset.item)),list);
  };
  const schedule=()=>{if(busy){return;}close();items=[];status.textContent='Searching…';const token=sequence;timer=setTimeout(()=>search(token).catch(e=>{if(token===sequence){status.textContent=e.message;}}),180);};
  input.addEventListener('input',schedule);input.addEventListener('focus',schedule);
  input.addEventListener('blur',()=>setTimeout(()=>{if(!root.contains(document.activeElement)||document.activeElement!==input&&!list.contains(document.activeElement)){close();}},0));
  input.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();close();return;}
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();if(list.hidden){schedule();return;}active=(active+(event.key==='ArrowDown'?1:active<0?0:-1)+items.length)%items.length;highlight();
    }else if(event.key==='Enter'){
      event.preventDefault();if(!list.hidden&&active>=0){void choose(active);}
    }
  });
}

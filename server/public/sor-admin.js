(function(global){
 'use strict';
 const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 async function mount(root,request){
  if(!root || root.dataset.mounted){return;}root.dataset.mounted='true';
  root.innerHTML='<div class="sor-admin-grid"><section class="panel"><h2>SOR Auto Returns</h2><p data-sor-gate role="status"></p><p><a href="/admin/mbt-gates">Manage SOR feature gate</a></p><p>Choose which equipment items generate collection orders for SOR deliveries. Unassigned returns update automatically; assigned work is flagged for review.</p><div class="sor-tools"><input data-sor-search placeholder="Search item, ID or rental group" aria-label="Search SOR items"><select data-sor-filter aria-label="Filter SOR items"><option value="">All items</option><option value="enabled">Auto return on</option><option value="disabled">Auto return off</option><option value="overridden">Admin overrides</option></select><button data-sor-search-button>Search</button></div><div class="sor-admin-scroll" data-sor-items></div><div class="sor-tools"><button data-sor-prev>Previous</button><span data-sor-count></span><button data-sor-next>Next</button></div><p data-sor-impact role="status"></p><p data-sor-message role="status"></p></section><section class="panel"><h2>Driver customer signature</h2><p>Drivers tap Customer signature to open the T&amp;C and signing area. Signing is optional.</p><label>Terms &amp; conditions<textarea data-sor-terms maxlength="10000"></textarea></label><div class="sor-tools"><button data-sor-preview>Preview signature popup</button><button data-sor-save-terms>Save T&amp;C</button></div><p data-sor-terms-status role="status"></p></section><section class="panel"><h2>Returns needing review</h2><div data-sor-review></div></section></div>';
  let settings,items=[],offset=0,total=0;
  const message=root.querySelector('[data-sor-message]');
  const fail=error=>{message.textContent=error.message;};
  async function loadItems(){
   const result=await request(`/api/admin/sor-auto-returns/items?search=${encodeURIComponent(root.querySelector('[data-sor-search]').value)}&filter=${root.querySelector('[data-sor-filter]').value}&offset=${offset}`);
   items=result.items;total=result.total;
   root.querySelector('[data-sor-items]').innerHTML=`<table><thead><tr><th>Item / group</th><th>Default</th><th>Auto return setting</th><th>Last change</th><th></th></tr></thead><tbody>${items.map(item=>`<tr><td>${escape(item.itemName)}<small>#${item.itemId} · ${escape(item.itemType)}</small><small>${escape(item.fullName)}</small></td><td>${item.defaultAutoReturn?'Create return':'No return'}<small>Effective: ${item.autoReturn?'On':'Off'}</small></td><td><select data-sor-item="${item.itemId}" aria-label="Auto return for ${escape(item.itemName)}"><option value="default" ${item.override===null?'selected':''}>Default</option><option value="true" ${item.override===true?'selected':''}>Create return</option><option value="false" ${item.override===false?'selected':''}>Do not create return</option></select></td><td>${escape(item.updatedBy || 'Automatic rule')}</td><td><button data-sor-save-item="${item.itemId}">Save</button></td></tr>`).join('')}</tbody></table>`;
   root.querySelector('[data-sor-count]').textContent=`${total?offset+1:0}–${offset+items.length} of ${total}`;
   root.querySelector('[data-sor-prev]').disabled=offset===0;root.querySelector('[data-sor-next]').disabled=offset+items.length>=total;
  }
  async function loadSettings({preserveTerms=false}={}){
   const result=await request('/api/admin/sor-auto-returns/settings');root.querySelector('[data-sor-gate]').textContent=result.featureEnabled?'SOR feature is enabled.':'SOR feature is paused. Settings are retained for future use; automatic returns and new signature prompts are off.';if(!preserveTerms){settings=result.signature;}
   if(!preserveTerms){root.querySelector('[data-sor-terms]').value=settings.terms;}
   root.querySelector('[data-sor-review]').innerHTML=result.review.length?result.review.map(row=>`<p><strong>${escape(row.ref_number)}</strong> ${escape(row.sor_review_reason)}</p>`).join(''):'No returns need review.';
   const failed=result.pending.filter(row=>row.last_error);if(failed.length){message.textContent=failed.map(row=>`${row.source_ref}: ${row.last_error}`).join('\n');}
  }
  root.addEventListener('change',async event=>{
   if(!event.target.dataset.sorItem){return;}
   try{const impact=await request(`/api/admin/sor-auto-returns/items/${event.target.dataset.sorItem}/impact`);
    root.querySelector('[data-sor-impact]').textContent=`Affected orders: ${impact.map(row=>row.orderRef+(row.assigned?' (assigned: review required)':'')).join(', ') || 'None yet'}`;
   }catch(error){fail(error);}
  });
  root.addEventListener('click',async event=>{
   const button=event.target.closest('button');if(!button){return;}
   try{
    if(button.hasAttribute('data-sor-search-button')){offset=0;await loadItems();}
    if(button.hasAttribute('data-sor-prev')){offset=Math.max(0,offset-100);await loadItems();}
    if(button.hasAttribute('data-sor-next')){offset+=100;await loadItems();}
    if(button.hasAttribute('data-sor-preview')){global.SorSignature.open({terms:root.querySelector('[data-sor-terms]').value,orderRefs:['SOR00188'],preview:true});}
    if(button.dataset.sorSaveItem){
     button.disabled=true;const item=items.find(value=>String(value.itemId)===button.dataset.sorSaveItem);
     const chosen=root.querySelector(`[data-sor-item="${item.itemId}"]`).value;
     await request(`/api/admin/sor-auto-returns/items/${item.itemId}`,{method:'PUT',body:JSON.stringify({override:chosen==='default'?null:chosen==='true',expectedRevision:item.revision})});
     message.textContent='Setting saved. Return processing follows the SOR feature gate.';await loadItems();await loadSettings({preserveTerms:true});
    }
    if(button.hasAttribute('data-sor-save-terms')){
     button.disabled=true;settings=await request('/api/admin/sor-auto-returns/settings',{method:'PUT',body:JSON.stringify({terms:root.querySelector('[data-sor-terms]').value,expectedRevision:settings.revision})});
     root.querySelector('[data-sor-terms-status]').textContent='T&C saved. Existing signatures retain their original wording.';
    }
   }catch(error){fail(error);}finally{button.disabled=false;}
  });
  try{await Promise.all([loadSettings(),loadItems()]);}catch(error){fail(error);}
 }
 global.SorAdmin={mount};
})(window);

/* global window, document, crypto, location, history, URL */
'use strict';
{
  const esc=window.RegularStockUI.esc,number=window.RegularStockUI.number;
  const state={mount:null,api:null,pools:[],requests:[],pool:null,orders:[],selectedPo:null,error:'',busy:false,choices:new Map(),reason:'',search:'',tab:'pools',filters:{},options:{},sortBy:'createdAt',direction:'asc',reject:null};
  let searchTimer=null,refreshTimer=null,generation=0;
  const active=()=>window.MBBSStockRequestTabs?.isActive('waitlist');
  const totals=pool=>`<div class="waitlist-totals">${[['PO item total',pool.capacityQty],['Allocated',pool.heldQty],['Converted to SO',pool.convertedQty],['Available',pool.availableQty]].map(([label,qty])=>`<span><small>${label}</small><strong>${number(qty)} ${esc(pool.salesUom)}</strong></span>`).join('')}</div>`;
  function allocationForm(pool){
    return `<section class="stock-request-section"><h3>Allocate to waiting requests</h3><p>3445 has priority for UNI / BWS; 2967 has priority for PER / TH. Original submission time determines order within each group.</p>
      ${pool.requests.length?`<form data-waitlist-allocation-form><div class="waitlist-table-wrap"><table class="waitlist-table"><thead><tr><th>Select</th><th>Request / customer</th><th>Sales yard</th><th>Waiting</th><th>Assign (${esc(pool.salesUom)})</th></tr></thead><tbody>${pool.requests.map((r,index)=>`<tr><td><input type="checkbox" aria-label="Select ${esc(r.requestRef)}" data-waitlist-select="${r.id}" ${state.choices.has(r.id)?'checked':''} ${pool.attention?'disabled':''} /></td><td><strong>${index+1}. ${esc(r.requestRef)}</strong><small>${esc(r.customerName)}</small><small>${esc(new Date(r.createdAt).toLocaleString())}</small></td><td>${esc(r.sellingYard)}</td><td>${number(r.waitingQty)}</td><td><input type="number" data-waitlist-quantity="${r.id}" aria-label="Quantity for ${esc(r.requestRef)}" min="0.000001" max="${r.waitingQty}" step="any" value="${state.choices.get(r.id)??''}" ${state.choices.has(r.id)?'':'disabled'} /></td></tr>`).join('')}</tbody></table></div>
        <label class="waitlist-reason"><span>Reason if passing a higher-priority request</span><input data-waitlist-override maxlength="2000" value="${esc(state.reason)}" /></label><p>Selected: <strong data-waitlist-selected-total>${number([...state.choices.values()].reduce((sum,q)=>sum+Number(q),0))}</strong> ${esc(pool.salesUom)}</p><button class="primary" ${state.busy||pool.attention?'disabled':''}>Confirm allocation</button></form>`:'<p>No unallocated demand is waiting for this item.</p>'}</section>`;
  }
  function poolDetail(pool){
    if(!pool)return '<div class="waitlist-empty">Choose a pool, or add an existing PO and item.</div>';
    return `<section class="stock-request-section"><h2>${esc(pool.purchaseOrderRef)} · ${esc(pool.itemCode)}</h2><p>${esc(pool.itemName)}${pool.eta?' · ETA '+esc(String(pool.eta).slice(0,10)):''}</p>${totals(pool)}${pool.attention?`<p class="stock-request-error" role="alert">${esc(pool.attention)}</p>`:''}<p>PO quantity can be allocated before receipt. Each reservation belongs to this PO and item.</p></section>
      ${allocationForm(pool)}<section class="stock-request-section"><h3>Allocation history</h3><div class="waitlist-table-wrap"><table class="waitlist-table"><thead><tr><th>Request / yard</th><th>Qty</th><th>Status / allocated</th><th>Release</th></tr></thead><tbody>${pool.allocations.map(a=>`<tr><td>${esc(a.requestRef)} · ${esc(a.sellingYard)}<small>${esc(a.customerName)}</small></td><td>${number(a.quantity)} ${esc(pool.salesUom)}</td><td>${esc(a.status)}<small>${esc(new Date(a.allocatedAt).toLocaleString())}</small>${a.overrideReason?`<small>Priority override: ${esc(a.overrideReason)}</small>`:''}${a.releaseReason?`<small>${esc(a.releaseReason)}</small>`:''}</td><td>${a.status==='reserved'?`<small>SCM release from ${esc(new Date(a.manualReleaseAt).toLocaleTimeString())}</small>${new Date(a.manualReleaseAt).getTime()<=Date.now()?`<form data-waitlist-release-form="${a.id}" data-request-id="${a.requestId}"><input name="reason" aria-label="Release reason for allocation ${a.id}" placeholder="Release reason" required maxlength="2000" /><button ${state.busy?'disabled':''}>Release ${number(a.quantity)}</button></form>`:''}`:a.status==='converting'?'SO in progress':a.status==='committed'?'SO quantity retained':''}</td></tr>`).join('')}</tbody></table></div></section>`;
  }
  function requestFilters(){
    const fields={sellingYardId:'Selling yard',vendorKey:'Vendor',itemId:'Item',customerId:'Customer'};
    const sortFields={createdAt:'Submitted date',requestRef:'Request',customerName:'Customer',vendorName:'Vendor',itemCode:'Item',sellingYard:'Selling yard',requestedQty:'Requested quantity',waitingQty:'Waiting quantity',heldQty:'Allocated quantity'};
    return `<div class="waitlist-toolbar waitlist-filters">${Object.entries(fields).map(([field,label])=>`<label><span>${label}</span><select aria-label="${label}" data-waitlist-filter="${field}"><option value="">All ${label.toLowerCase()}s</option>${(state.options[field]||[]).map(option=>`<option value="${esc(option.value)}" ${state.filters[field]===option.value?'selected':''}>${esc(option.label)}</option>`).join('')}</select></label>`).join('')}
      <label><span>Sort by</span><select aria-label="Sort by" data-waitlist-sort-by>${Object.entries(sortFields).map(([field,label])=>`<option value="${field}" ${state.sortBy===field?'selected':''}>${label}</option>`).join('')}</select></label>
      <label><span>Sort direction</span><select aria-label="Sort direction" data-waitlist-sort-direction><option value="asc" ${state.direction==='asc'?'selected':''}>Ascending</option><option value="desc" ${state.direction==='desc'?'selected':''}>Descending</option></select></label><button type="button" data-waitlist-clear-filters>Clear filters</button></div>`;
  }
  function rejectAction(request){
    if(state.reject?.id!==request.id)return `<button type="button" class="danger" data-waitlist-reject="${request.id}" ${state.busy||request.converting?'disabled':''}>Reject</button>${request.converting?'<small>SO creation in progress</small>':''}`;
    return `<form data-waitlist-reject-form="${request.id}" data-operation-key="${state.reject.operationKey}" class="waitlist-reject-form"><label><span>Rejection reason *</span><input name="reason" value="${esc(state.reject.reason)}" required maxlength="2000" /></label><small>Closes remaining demand and returns unused allocations.</small><button class="danger" ${state.busy?'disabled':''}>Confirm rejection</button><button type="button" data-waitlist-cancel-reject ${state.busy?'disabled':''}>Cancel</button></form>`;
  }
  function requestRow(request){
    const r=request,orders=(r.recentQueuedPurchaseOrders||[]).map(po=>`<div><strong>${esc(po.ref)}</strong>${po.isSplit?`<small>Source ${esc(po.sourceRef)}</small>`:''}<small>${po.eta?'ETA '+esc(po.eta):'ETA not set'}</small></div>`).join('')||'<small>No queued PO</small>';
    return `<tr data-waitlist-request-row="${r.id}"><td><strong>${esc(r.requestRef)}</strong><small>${esc(new Date(r.createdAt).toLocaleString())}</small></td><td>${esc(r.customerName)}</td><td>${esc(r.vendorName||'No vendor')}</td><td>${esc(r.itemCode)}${r.itemDisplayName!==r.itemCode?`<small>${esc(r.itemDisplayName)}</small>`:''}</td><td>${esc(r.sellingYard)}</td><td>${number(r.requestedQty)} ${esc(r.salesUom)}</td><td>${number(r.waitingQty)} ${esc(r.salesUom)}</td><td>${number(r.heldQty)} ${esc(r.salesUom)}${r.converting?'<small>Creating SO</small>':''}</td><td class="waitlist-recent-pos">${orders}</td><td>${rejectAction(r)}</td></tr>`;
  }
  function waitingRequests(){
    const rows=window.SCMWaitlistList.select(state.requests,{filters:state.filters,sortBy:state.sortBy,direction:state.direction});
    const columns=[['requestRef','Request'],['customerName','Customer'],['vendorName','Vendor'],['itemCode','Item'],['sellingYard','Selling yard'],['requestedQty','Requested'],['waitingQty','Waiting'],['heldQty','Allocated']];
    return `<section class="stock-request-section">${requestFilters()}<p>Showing ${rows.length} of ${state.requests.length} waiting requests.</p><div class="waitlist-table-wrap"><table class="waitlist-table"><thead><tr>${columns.map(([field,label])=>`<th aria-sort="${state.sortBy===field?(state.direction==='asc'?'ascending':'descending'):'none'}"><button type="button" data-waitlist-sort="${field}">${label}${state.sortBy===field?(state.direction==='asc'?' ↑':' ↓'):''}</button></th>`).join('')}<th>Recent queued POs</th><th>Actions</th></tr></thead><tbody>
      ${rows.map(requestRow).join('')||'<tr><td colspan="10">No waiting requests match these filters.</td></tr>'}</tbody></table></div></section>`;
  }
  function render(){
    if(!state.mount||!active())return;
    const returned=state.pools.filter(p=>p.returnedUnread);
    state.mount.innerHTML=`<div class="waitlist-workspace">${window.MBBSStockRequestTabs.html()}<div class="stock-request-heading"><div><h1>Regular waitlist</h1><p>Assign PO supply to customer demand, then Sales creates the SO.</p></div><button type="button" data-waitlist-refresh>Refresh</button></div>
      ${state.error?`<p class="stock-request-error" role="alert">${esc(state.error)}</p>`:''}
      ${returned.map(p=>`<div class="waitlist-returned">Stock returned to <strong>${esc(p.purchaseOrderRef)} · ${esc(p.itemCode)}</strong>. ${number(p.availableQty)} ${esc(p.salesUom)} available. <button type="button" data-waitlist-pool="${p.id}">Re-allocate</button></div>`).join('')}
      <div class="waitlist-toolbar"><button type="button" data-waitlist-view="pools">PO pools</button><button type="button" data-waitlist-view="requests">All waiting requests (${state.requests.length})</button></div>
      ${state.tab==='requests'?waitingRequests():`<section class="stock-request-section"><h3>Add PO / split PO pool</h3><form data-waitlist-pool-form><div class="waitlist-toolbar"><label><span>Find existing PO / split PO</span><input data-waitlist-po-search type="search" value="${esc(state.search)}" placeholder="PO reference" /></label><label><span>PO *</span><select data-waitlist-po required><option value="">Select an existing PO</option>${state.orders.map(o=>`<option value="${o.id}" ${state.selectedPo?.id===o.id?'selected':''}>${esc(o.ref)}</option>`).join('')}</select></label><label><span>Item *</span><select name="itemId" required><option value="">Select one item</option>${(state.selectedPo?.items||[]).map(i=>`<option value="${i.itemId}">${esc(i.itemCode)} · ${i.quantity==null?'Unit review required':number(i.quantity)+' '+esc(i.salesUom)}</option>`).join('')}</select></label><button ${state.busy?'disabled':''}>Open pool</button></div></form></section>
        <div class="waitlist-layout"><aside class="waitlist-pool-list">${state.pools.map(p=>`<button type="button" data-waitlist-pool="${p.id}" aria-pressed="${state.pool?.id===p.id}"><strong>${esc(p.purchaseOrderRef)} · ${esc(p.itemCode)}</strong><small>${number(p.availableQty)} ${esc(p.salesUom)} available${p.attention?' · Review PO':''}</small></button>`).join('')||'<p>No PO pools yet.</p>'}</aside><div>${poolDetail(state.pool)}</div></div>`}</div>`;
  }
  async function load(){
    const version=++generation;const [pools,requests]=await Promise.all([state.api('/api/scm/waitlist/pools'),state.api('/api/scm/waitlist/requests')]);
    if(version!==generation||!active())return;state.pools=pools.pools;state.requests=requests.requests;
    const options=window.SCMWaitlistList.facets(state.requests);
    for(const field of Object.keys(options)){const selected=(state.options[field]||[]).find(option=>option.value===state.filters[field]);if(selected&&!options[field].some(option=>option.value===selected.value))options[field].push(selected);}
    state.options=options;
    if(state.pool)state.pool=state.pools.find(p=>p.id===state.pool.id)||null;render();
  }
  async function selectPool(id){
    state.pool=await state.api('/api/scm/waitlist/pools/'+id);state.choices.clear();state.reason='';state.tab='pools';
    const url=new URL(location.href);url.searchParams.set('poolId',id);history.replaceState(null,'',url);render();
    if(state.pool.returnedUnread){await state.api(`/api/scm/waitlist/pools/${id}/read`,{method:'POST',body:JSON.stringify({eventId:state.pool.lastReturnEventId})});const row=state.pools.find(p=>p.id===Number(id));if(row)row.returnedUnread=false;state.pool.returnedUnread=false;render();}
  }
  document.addEventListener('input',/** @param {Event & {target:HTMLInputElement}} event */ event=>{
    if(!active())return;
    const id=Number(event.target.dataset.waitlistQuantity);if(id){state.choices.set(id,Number(event.target.value));const total=document.querySelector('[data-waitlist-selected-total]');if(total)total.textContent=number([...state.choices.values()].reduce((sum,q)=>sum+Number(q),0));}
    if(event.target.matches('[data-waitlist-override]'))state.reason=event.target.value;
    if(event.target.closest('[data-waitlist-reject-form]')&&event.target.name==='reason'&&state.reject)state.reject.reason=event.target.value;
    if(event.target.matches('[data-waitlist-po-search]')){state.search=event.target.value;clearTimeout(searchTimer);searchTimer=setTimeout(async()=>{try{const result=await state.api('/api/scm/waitlist/purchase-orders?search='+encodeURIComponent(state.search));state.orders=result.purchaseOrders;const select=document.querySelector('[data-waitlist-po]');if(select)select.innerHTML='<option value="">Select an existing PO</option>'+state.orders.map(o=>`<option value="${o.id}">${esc(o.ref)}</option>`).join('');}catch(error){state.error=error.message;render();}},250);}
  });
  document.addEventListener('change',/** @param {Event & {target:HTMLInputElement}} event */ event=>{
    if(!active())return;
    if(event.target.dataset.waitlistFilter){state.filters[event.target.dataset.waitlistFilter]=event.target.value;render();}
    if(event.target.matches('[data-waitlist-sort-by]')){state.sortBy=event.target.value;render();}
    if(event.target.matches('[data-waitlist-sort-direction]')){state.direction=event.target.value;render();}
    if(event.target.matches('[data-waitlist-po]')){state.selectedPo=state.orders.find(o=>o.id===Number(event.target.value));render();}
    const id=Number(event.target.dataset.waitlistSelect);if(id){if(event.target.checked){const r=state.pool.requests.find(r=>r.id===id),assigned=[...state.choices.values()].reduce((sum,q)=>sum+Number(q),0);state.choices.set(id,Math.min(r.waitingQty,Math.max(0,state.pool.availableQty-assigned)));}else state.choices.delete(id);render();}
  });
  document.addEventListener('click',/** @param {Event & {target:HTMLInputElement}} event */ async event=>{
    if(!active())return;
    try{const button=/** @type {HTMLButtonElement|null} */ (event.target.closest('button[data-waitlist-pool]'));if(button)await selectPool(Number(button.dataset.waitlistPool));
      if(event.target.closest('[data-waitlist-refresh]'))await load();const view=/** @type {HTMLButtonElement|null} */ (event.target.closest('button[data-waitlist-view]'));if(view){state.tab=view.dataset.waitlistView;render();}
      const reject=/** @type {HTMLButtonElement|null} */ (event.target.closest('[data-waitlist-reject]'));if(reject){state.reject={id:Number(reject.dataset.waitlistReject),operationKey:crypto.randomUUID(),reason:''};render();}
      if(event.target.closest('[data-waitlist-cancel-reject]')){state.reject=null;render();}
      if(event.target.closest('[data-waitlist-clear-filters]')){state.filters={};render();}
      const sort=/** @type {HTMLButtonElement|null} */ (event.target.closest('[data-waitlist-sort]'));if(sort){state.direction=state.sortBy===sort.dataset.waitlistSort&&state.direction==='asc'?'desc':'asc';state.sortBy=sort.dataset.waitlistSort;render();}}
    catch(error){state.error=error.message;render();}
  });
  document.addEventListener('submit',/** @param {Event & {target:HTMLFormElement}} event */ async event=>{
    if(!active())return;const form=/** @type {HTMLFormElement|null} */ (event.target.closest('form[data-waitlist-pool-form],form[data-waitlist-allocation-form],form[data-waitlist-release-form],form[data-waitlist-reject-form]'));if(!form)return;event.preventDefault();if(state.busy)return;
    state.busy=true;state.error='';let url,body;const operationKey=form.dataset.operationKey||(form.dataset.operationKey=crypto.randomUUID());
    try{
      if(form.matches('[data-waitlist-pool-form]')){url='/api/scm/waitlist/pools';body={operationKey,purchaseOrderRef:state.selectedPo?.ref,itemId:Number((/** @type {HTMLSelectElement} */ (form.querySelector('select[name=itemId]'))).value)};}
      else if(form.matches('[data-waitlist-allocation-form]')){url=`/api/scm/waitlist/pools/${state.pool.id}/allocations`;body={operationKey,expectedRevision:state.pool.revision,overrideReason:state.reason,selections:[...state.choices].map(([requestId,quantity])=>({requestId,quantity,expectedRevision:state.pool.requests.find(r=>r.id===requestId).revision}))};}
      else if(form.matches('[data-waitlist-reject-form]')){const request=state.requests.find(r=>r.id===Number(form.dataset.waitlistRejectForm));url=`/api/scm/waitlist/requests/${request.id}/reject`;body={operationKey,expectedRevision:request.revision,reason:state.reject.reason};}
      else{const request=await state.api('/api/scm/waitlist/requests/'+form.dataset.requestId);url='/api/scm/waitlist/allocations/'+form.dataset.waitlistReleaseForm+'/release';body={operationKey,expectedRevision:request.revision,reason:(/** @type {HTMLInputElement} */ (form.querySelector('input[name=reason]'))).value};}
      const result=await state.api(url,{method:'POST',body:JSON.stringify(body)});if(form.matches('[data-waitlist-reject-form]'))state.reject=null;else state.pool=result;state.choices.clear();state.reason='';await load();
    }catch(error){state.error=error.message;render();}finally{state.busy=false;render();}
  });
  function refresh(){if(!active()||state.busy||document.activeElement?.closest('[data-waitlist-allocation-form],[data-waitlist-pool-form],[data-waitlist-release-form],[data-waitlist-reject-form]'))return;clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>load().catch(error=>{state.error=error.message;render();}),300);}
  setInterval(refresh,15000);
  window.SCMWaitlist={refresh,async open({mount,api}){state.mount=mount;state.api=api;state.error='';render();await load();const id=Number(new URL(location.href).searchParams.get('poolId'));if(id)await selectPool(id);}};
}

/* global window, document, crypto, FormData */
(() => {
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number=value=>new Intl.NumberFormat('en-CA',{maximumFractionDigits:6}).format(Number(value)||0);
  const drafts=new Map();let hooks=null,customerTimer=null,searchVersion=0,busy=false;
  const isWaitlist=value=>(value?.regular?.deliveryMethod??value?.deliveryMethod)==='waitlist';
  function customerFields(composer){
    return `<label class="waitlist-customer"><span>Customer *</span><input data-regular-field="customerName" data-waitlist-customer-query type="search" autocomplete="off" required value="${esc(composer.customerName)}" placeholder="Find an existing customer" /><div data-waitlist-customers class="stock-request-suggestions"></div>${composer.customerId?`<small>Selected customer #${Number(composer.customerId)}</small>`:''}</label>`;
  }
  function draft(request){if(!drafts.has(request.id))drafts.set(request.id,{fulfillmentMethod:'pickup',remainderAction:'keep'});return drafts.get(request.id);}
  function detail(request){
    const w=request.waitlist,line=request.lines[0],value=draft(request),inProgress=w.state==='converting',terminal=['closed','completed'].includes(w.state);
    const labels={waiting:'Waiting',partially_allocated:'Partially allocated',allocated:'Allocated',converting:'Creating SO',closed:w.closureType==='rejected'?'Rejected':'Closed',completed:'Converted'};
    return `<div class="stock-request-heading"><div><h2>${esc(request.requestRef)}</h2><p>Waitlist · ${esc(request.regular.customerName)} · Sales yard ${esc(request.destinationName)}</p></div><strong>${labels[w.state]||esc(w.state)}</strong></div>
      <section class="stock-request-section"><h3>${esc(line.itemName)}</h3><div class="waitlist-totals">${[['Requested',w.requestedQty],['Allocated',w.heldQty],['Converted to SO',w.convertedQty],['Waiting',w.waitingQty]].map(([label,qty])=>`<span><small>${label}</small><strong>${number(qty)} ${esc(line.salesUom)}</strong></span>`).join('')}</div>
      <p>Submitted ${esc(new Date(request.createdAt).toLocaleString())}. Allocation follows selling-yard priority, then the original request time.</p>${request.remarks?`<p>${esc(request.remarks)}</p>`:''}
      ${w.closeReason?`<p>${w.closureType==='rejected'?'Rejected':'Closed'}: ${esc(w.closeReason)}</p>`:''}</section>
      ${w.allocations.length?`<section class="stock-request-section"><h3>PO allocations</h3><div class="waitlist-table-wrap"><table class="waitlist-table"><thead><tr><th>PO / split PO</th><th>Qty</th><th>Status</th><th>Allocated</th></tr></thead><tbody>${w.allocations.map(a=>`<tr><td>${esc(a.purchaseOrderRef)}</td><td>${number(a.quantity)} ${esc(line.salesUom)}</td><td>${esc(a.status)}${a.releaseReason?`<small>${esc(a.releaseReason)}</small>`:''}</td><td>${esc(new Date(a.allocatedAt).toLocaleString())}</td></tr>`).join('')}</tbody></table></div></section>`:''}
      ${inProgress?`<section class="stock-request-notice"><strong>Creating the Sales Order…</strong><p>Your quantity stays allocated until NetSuite confirms the result.</p>${w.conversions.filter(c=>['pending','preparing','submitted','uncertain'].includes(c.status)).map(c=>c.error?`<p>${esc(c.error)}</p>`:'').join('')}</section>`:''}
      ${w.heldQty>0&&!inProgress&&!terminal?`<section class="stock-request-section"><h3>Convert ${number(w.heldQty)} ${esc(line.salesUom)} to Sales Order</h3><p>NetSuite applies the customer’s item price automatically. The SO will be created at ${esc(request.destinationName)}.</p>
        <form data-waitlist-conversion-form><div class="stock-request-line-fields"><label><span>Delivery method *</span><select name="fulfillmentMethod"><option value="pickup" ${value.fulfillmentMethod==='pickup'?'selected':''}>Pickup</option><option value="delivery" ${value.fulfillmentMethod==='delivery'?'selected':''}>Delivery</option></select></label>
        ${value.fulfillmentMethod==='delivery'?`<label><span>Delivery date · To be delivery by *</span><input name="deliveryDate" type="date" value="${esc(value.deliveryDate)}" required /></label>`:''}
        ${w.waitingQty>0?`<label class="stock-request-wide"><span>Remaining ${number(w.waitingQty)} ${esc(line.salesUom)}</span><select name="remainderAction"><option value="keep" ${value.remainderAction!=='close'?'selected':''}>Keep on this waitlist with the original priority</option><option value="close" ${value.remainderAction==='close'?'selected':''}>Close the unconverted remainder</option></select></label>`:''}</div>
        <p data-waitlist-error class="stock-request-error" role="alert"></p><button class="primary" ${busy?'disabled':''}>${busy?'Submitting…':'Convert to Sales Order'}</button></form></section>`:''}
      ${w.conversions.length?`<section class="stock-request-section"><h3>Sales Orders</h3>${w.conversions.map(c=>c.status==='completed'?`<p><strong>${esc(c.salesOrderRef)}</strong> · Created ${number(c.quantity)} ${esc(line.salesUom)} · ${esc(c.fulfillment.fulfillmentMethod)}</p>`:c.status==='failed'?`<p class="stock-request-error">SO creation could not start: ${esc(c.error)}</p>`:'').join('')}<p>After creation, edit the SO in NetSuite. This request retains its created quantity and SO reference.</p></section>`:''}
      ${!terminal&&!inProgress?`<section class="stock-request-section"><form data-waitlist-close-form><label><span>Close reason *</span><input name="reason" required maxlength="2000" /></label><p>Close releases every unused allocation and closes the remaining demand.</p><p data-waitlist-error class="stock-request-error" role="alert"></p><button type="submit" class="danger" ${busy?'disabled':''}>Close waitlist request</button></form></section>`:''}`;
  }
  document.addEventListener('input',/** @param {Event & {target:HTMLInputElement}} event */ event=>{
    if(!hooks)return;
    const form=event.target.closest('[data-waitlist-conversion-form]');
    if(form){draft(hooks.getRequest())[event.target.name]=event.target.value;return;}
    if(!event.target.matches('[data-waitlist-customer-query]'))return;
    const composer=hooks.getComposer();composer.customerId=null;clearTimeout(customerTimer);const version=++searchVersion;
    customerTimer=setTimeout(async()=>{
      try{const result=await hooks.api('/api/sales/stock-requests/waitlist/customers?search='+encodeURIComponent(composer.customerName));
        if(version!==searchVersion||composer!==hooks.getComposer())return;
        const mount=document.querySelector('[data-waitlist-customers]');if(mount)mount.innerHTML=result.customers.map(c=>`<button type="button" data-waitlist-customer="${Number(c.id)}" data-name="${esc(c.displayName)}">${esc(c.displayName)} <small>${esc(c.entityNumber)}</small></button>`).join('');
      }catch(error){hooks.error(error.message);}
    },200);
  });
  document.addEventListener('change',/** @param {Event & {target:HTMLInputElement}} event */ event=>{
    if(!hooks||!event.target.closest('[data-waitlist-conversion-form]'))return;
    draft(hooks.getRequest())[event.target.name]=event.target.value;if(event.target.name==='fulfillmentMethod')hooks.render();
  });
  document.addEventListener('click',/** @param {Event & {target:HTMLInputElement}} event */ event=>{
    const button=/** @type {HTMLButtonElement|null} */ (event.target.closest('button[data-waitlist-customer]'));if(!button||!hooks)return;
    const composer=hooks.getComposer();if(!composer)return;composer.customerId=Number(button.dataset.waitlistCustomer);composer.customerName=button.dataset.name;++searchVersion;hooks.render();
  });
  document.addEventListener('submit',/** @param {Event & {target:HTMLFormElement}} event */ async event=>{
    const form=/** @type {HTMLFormElement|null} */ (event.target.closest('form[data-waitlist-conversion-form],form[data-waitlist-close-form]'));if(!form||!hooks)return;event.preventDefault();if(busy)return;
    const request=hooks.getRequest(),convert=form.matches('[data-waitlist-conversion-form]'),values=Object.fromEntries(new FormData(form));
    const body={...values,expectedRevision:request.revision,operationKey:form.dataset.operationKey||(form.dataset.operationKey=crypto.randomUUID())};
    busy=true;for(const button of form.querySelectorAll('button'))button.disabled=true;
    try{const result=await hooks.api(`/api/sales/stock-requests/${request.id}/waitlist/${convert?'conversions':'close'}`,{method:'POST',body:JSON.stringify(body)});hooks.setRequest(result.request||result);drafts.delete(request.id);await hooks.reload();}
    catch(error){const mount=form.querySelector('[data-waitlist-error]');if(mount)mount.textContent=error.message;}
    finally{busy=false;for(const button of form.querySelectorAll('button'))button.disabled=false;}
  });
  window.RegularWaitlist={isWaitlist,customerFields,detail,configure(value){hooks=value;}};
})();

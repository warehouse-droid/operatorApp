(() => {
  const t=(en,zh)=>window.RegularStockUI.t(en,zh),esc=value=>window.RegularStockUI.esc(value);
  let active=null;
  function eligible(request,line) {
    return request?.requestType==='regular'&&request.workflowVersion===2&&request.regular?.deliveryMethod==='stocking'
      &&['submitted','active'].includes(request.status)&&!request.regular.resolution&&!request.regular.pickupTransfer&&!request.regular.handoffStatus
      &&!(request.transfers||[]).length&&['submitted','changes_requested','approved'].includes(line?.status)&&!line.purchase?.demandId;
  }
  function link(request,line) {
    const event=(request.events||[]).find(row=>row.eventType==='stocking_line_waitlisted'&&Number(row.details?.lineId)===line.id);
    const id=Number(event?.details?.waitlistRequestId);
    return Number.isSafeInteger(id)&&id>0?{id,ref:event.details.waitlistRequestRef}:null;
  }
  function result(request,line,audience) {
    const moved=link(request,line);
    return moved?`<p class="stock-request-notice">${t('Moved to waitlist','已转入候补清单')} · <a href="/${audience}/stock-requests?tab=waitlist&requestId=${moved.id}">${esc(moved.ref)}</a></p>`:'';
  }
  function button(request,line,busy=false) {
    return eligible(request,line)?`<button type="button" data-scm-stock-action="waitlist-line" data-line-id="${line.id}" ${busy?'disabled':''}>${t('Convert to waitlist','转入候补清单')}</button>`:'';
  }
  function open(request,line,{api,onComplete}) {
    if(active||!eligible(request,line))return;
    const dialog=document.createElement('dialog');active=dialog;dialog.dataset.stockingWaitlistDialog='';dialog.className='stocking-waitlist-dialog';
    const previous=document.activeElement,customerName=request.regular.customerName||'';let customerId=request.regular.customerId||null,version=0,timer=null,submitting=false;
    const operationKey=crypto.randomUUID(),revision=request.revision;
    dialog.innerHTML=`<form class="stock-request-form"><h2>${t('Convert to waitlist','转入候补清单')}</h2>
      <p><strong>${esc(line.itemName)}</strong> · ${esc(line.salesQty)} ${esc(line.salesUom)} · ${esc(request.destinationName)}</p>
      <p>${t('Moves this saved line to a linked waitlist request. The other lines stay on this request.','将此已保存商品行转入关联候补申请，其他商品行仍保留在此申请中。')}</p>
      <label><span>${t('Existing customer','现有客户')} *</span><input data-stocking-waitlist-customer-query type="search" autocomplete="off" required value="${esc(customerName)}" placeholder="${t('Find an existing customer','查找现有客户')}" /></label>
      <div class="stock-request-suggestions" data-stocking-waitlist-customers></div>
      <p data-stocking-waitlist-selected>${customerId?`${t('Selected customer','已选择客户')} #${Number(customerId)}`:''}</p>
      <p role="alert" class="stock-request-error" data-stocking-waitlist-error></p>
      <div class="stock-request-actions"><button type="button" data-stocking-waitlist-close>${t('Cancel','取消')}</button><button class="primary" type="submit">${t('Convert to waitlist','转入候补清单')}</button></div></form>`;
    const error=dialog.querySelector('[data-stocking-waitlist-error]'),query=dialog.querySelector('[data-stocking-waitlist-customer-query]'),suggestions=dialog.querySelector('[data-stocking-waitlist-customers]');
    const close=()=>{version++;clearTimeout(timer);dialog.remove();active=null;if(previous?.isConnected)previous.focus();};
    const search=async()=>{
      const own=++version;
      try{
        const data=await api('/api/scm/waitlist/customers?search='+encodeURIComponent(query.value));
        if(own!==version||!dialog.isConnected)return;
        suggestions.innerHTML=(data.customers||[]).map(c=>`<button type="button" data-stocking-waitlist-customer="${Number(c.id)}" data-name="${esc(c.displayName)}">${esc(c.displayName)} <small>${esc(c.entityNumber)}</small></button>`).join('');
      }catch(cause){if(own===version&&dialog.isConnected)error.textContent=cause.message;}
    };
    query.addEventListener('input',()=>{customerId=null;version++;clearTimeout(timer);dialog.querySelector('[data-stocking-waitlist-selected]').textContent='';suggestions.replaceChildren();timer=setTimeout(search,200);});
    dialog.addEventListener('click',event=>{
      if(submitting)return;
      const picked=event.target.closest('[data-stocking-waitlist-customer]');
      if(picked){version++;clearTimeout(timer);customerId=Number(picked.dataset.stockingWaitlistCustomer);query.value=picked.dataset.name;suggestions.replaceChildren();dialog.querySelector('[data-stocking-waitlist-selected]').textContent=`${t('Selected customer','已选择客户')} #${customerId}`;error.textContent='';}
      if(event.target.closest('[data-stocking-waitlist-close]'))close();
    });
    dialog.addEventListener('cancel',event=>{event.preventDefault();if(!submitting)close();});
    dialog.addEventListener('submit',async event=>{
      event.preventDefault();if(submitting)return;
      if(!customerId){error.textContent=t('Select an existing customer from the list.','请从清单中选择现有客户。');query.focus();return;}
      submitting=true;error.textContent='';for(const control of dialog.querySelectorAll('input,button'))control.disabled=true;
      try{
        const response=await api(`/api/scm/waitlist/stocking-requests/${request.id}/lines/${line.id}`,{method:'POST',body:JSON.stringify({expectedRevision:revision,customerId,operationKey})});
        close();await onComplete(response);
      }catch(cause){if(dialog.isConnected)error.textContent=cause.message;}
      finally{submitting=false;for(const control of dialog.querySelectorAll('input,button'))control.disabled=false;}
    });
    document.body.append(dialog);dialog.showModal();query.focus();
    if(customerName&&!customerId)void search();
  }
  const style=document.createElement('style');style.textContent='.stocking-waitlist-dialog{width:min(620px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:24px;border:1px solid #cbd5e1;border-radius:12px;color:#0f172a;background:white}.stocking-waitlist-dialog::backdrop{background:#0f172a66}.stocking-waitlist-dialog .stock-request-suggestions{position:static;max-height:240px;overflow:auto}.stocking-waitlist-dialog [data-stocking-waitlist-error]:empty{display:none}';document.head.append(style);
  window.RegularStockWaitlistTransition={eligible,button,result,lineStatus:(request,line)=>link(request,line)?'waitlisted':line.status,open};
})();

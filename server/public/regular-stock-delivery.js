(() => {
  const ui=()=>window.RegularStockUI;
  const simple=request=>request?.regular?.deliveryVersion===1;
  const composing=composer=>composer?.workflowVersion===2 && composer.deliveryMethod==='delivery' && (!composer.requestId || composer.deliveryVersion===1);
  const yards=[{locationId:1,yardCode:'3445'},{locationId:28,yardCode:'2967'},{locationId:15,yardCode:'12441'},{locationId:26,yardCode:'150'}];
  function options(rows,value) {
    return rows.map(yard=>`<option value="${yard.locationId}" ${Number(value)===yard.locationId?'selected':''}>${ui().esc(yard.yardCode)}</option>`).join('');
  }
  function composer(value,destinations,saving) {
    const {t,esc}=ui();
    const preview=value.deliveryPreview;
    return `<div class="stock-request-heading"><h2>${t('New regular stock request','新建常规库存申请')}</h2><button data-sales-stock-action="close-composer" type="button">${t('Close','关闭')}</button></div>
      <form class="stock-request-form" data-sales-stock-form>
        <label><span>${t('Delivery method','取货方式')}</span><select data-regular-field="deliveryMethod" required>
          <option value="pickup">${t('Pickup','自取')}</option><option value="delivery" selected>${t('Delivery','送货')}</option><option value="stocking">${t('Stocking','备货')}</option></select></label>
        <div class="stock-request-line-fields regular-delivery-fields">
          <label><span>${t('Base Yard','基础货场')} *</span><input data-delivery-base readonly value="${esc(preview?.baseName||'')}" placeholder="${t('From SO line locations','自动读取销售订单行货场')}" /></label>
          <label><span>${t('Target Yard','目标货场')} *</span><select data-regular-field="sourceLocationId" required><option value="">${t('Select yard…','请选择货场…')}</option>${options(yards.filter(yard=>yard.locationId!==preview?.baseLocationId),value.sourceLocationId)}</select></label>
          <label><span>${t('Sales Order number','销售订单号')} *</span><input data-regular-field="salesOrderRef" maxlength="80" required value="${esc(value.salesOrderRef)}" autocomplete="off" /></label>
        </div>
        <p class="stock-request-notice">${t('Transfer: Target Yard → Base Yard. 3445 ↔ 2967 is automatically approved, created and sent to the yard printers. Routes involving 150 or 12441 require SCM approval.','调货方向：目标货场 → 基础货场。3445 ↔ 2967 自动批准、建立调货单并发送至货场打印机。涉及 150 或 12441 的路线须 SCM 人工批准。')}</p>
        <div data-delivery-calculation>${value.deliveryLoading?t('Reading SO and calculating quantities…','正在读取订单并计算数量…'):value.deliveryError?`<p class="stock-request-error">${esc(value.deliveryError)}</p><button type="button" data-sales-stock-action="delivery-preview-retry">${t('Retry SO check','重新检查销售订单')}</button>`:preview?.lines?calculation(preview):t('Enter the SO and select Target Yard to calculate the transfer.','输入销售订单并选择目标货场，以计算调货数量。')}</div>
        <button class="primary" type="submit" ${saving||value.deliveryLoading||!preview?.lines?'disabled':''}>${saving?t('Processing…','处理中…'):t('Submit request','提交申请')}</button>
      </form>`;
  }
  function calculation(preview) {
    const {t,esc,number}=ui();
    return `<section class="stock-request-section"><h3>${t('Calculated transfer','自动计算调货数量')}</h3>
      ${preview.lines.map(line=>`<p><strong>${esc(line.itemName)}</strong> · ${number(line.salesQty)} ${esc(line.salesUom)} · ${line.quantityBasis==='whole_line'?t('Whole SO line','整行数量'):t('Backorder quantity','欠货数量')}</p>`).join('')}
      <p><strong>PALLET: ${number(preview.palletQuantity)}</strong></p>
      <p>${t('For backordered lines, use the whole line when stock allows; otherwise use only the backorder. Insufficient stock for the backorder stops submission. Quantities are checked again before creating the TO.','有欠货的订单行：库存足够时调拨整行数量，否则仅调拨欠货数量。若欠货数量仍不足，则停止提交。建立调货单前会再次核对数量。')}</p></section>`;
  }
  function invalidate(value,root) {
    value.deliveryPreview=null;value.deliveryError='';
    root.querySelector('[data-delivery-base]').value='';
    root.querySelector('[data-delivery-calculation]').textContent='';
    root.querySelector('[data-sales-stock-form] button[type="submit"]').disabled=true;
  }
  async function refresh(value,api,render) {
    if(window.RegularStockDialog.isBusy())return;
    const ref=String(value.salesOrderRef||'').trim(),source=String(value.sourceLocationId||'');
    const generation=value.deliveryGeneration=Number(value.deliveryGeneration||0)+1;
    value.deliveryPreview=null;value.deliveryError='';value.deliveryLoading=!!ref;render();
    if(!ref)return;
    try {
      const preview=await run(api,'preview',{salesOrderRef:ref,sourceLocationId:source});
      if(generation!==value.deliveryGeneration||!composing(value)||ref!==String(value.salesOrderRef||'').trim()||source!==String(value.sourceLocationId||''))return;
      value.deliveryPreview=preview;value.destinationLocationId=String(preview.baseLocationId);
      if(source===String(preview.baseLocationId))value.sourceLocationId='';
    } catch(error) {
      if(generation===value.deliveryGeneration&&ref===String(value.salesOrderRef||'').trim()&&source===String(value.sourceLocationId||''))value.deliveryError=error.message;
    } finally {
      if(generation===value.deliveryGeneration){value.deliveryLoading=false;render();}
    }
  }
  function summary(request) {
    const {t,esc}=ui(),r=request.regular;
    const status=r.deliveryApproval==='rejected'?t('Rejected','已拒绝'):r.deliveryApproval==='approved'
      ?r.approval.automatic?t('Automatically approved','自动批准'):t('Approved by SCM','SCM 已批准'):t('Waiting for SCM approval','等待 SCM 人工批准');
    return `<div class="stock-request-summary regular-delivery-summary">
      <span><small>${t('Base Yard','基础货场')}</small><strong>${esc(request.destinationName)}</strong></span>
      <span><small>${t('Target Yard','目标货场')}</small><strong>${esc(r.sourceName)}</strong></span>
      <span><small>${t('Sales Order number','销售订单号')}</small><strong>${esc(r.salesOrderRef)}</strong></span>
      <span><small>PALLET</small><strong>${ui().number(r.palletQuantity)}</strong></span>
      <span><small>${t('Approval','批准状态')}</small><strong>${status}</strong></span></div>
      ${r.deliveryApproval==='pending'?`<p class="stock-request-notice">${t('This route involves 150 or 12441 and requires manual approval.','此路线涉及 150 或 12441，须人工批准。')}</p>`:''}
      ${r.handoffError?`<p class="stock-request-error">${esc(r.handoffError)}</p>`:''}`;
  }
  function progress(request,scm=false,saving=false) {
    const {t,esc}=ui(),r=request.regular;
    if(r.deliveryApproval!=='approved')return '';
    const complete=r.handoffStatus==='complete';
    return `<section class="stock-request-notice regular-delivery-result"><strong>${complete?t('Transfer Order created','调货单已建立'):t('Transfer Order processing','正在处理调货单')}</strong>
      ${(request.transfers||[]).map(transfer=>`<p>${esc(transfer.netsuiteTransferOrderRef||transfer.transferRef)} · ${esc(transfer.sourceName)} → ${esc(transfer.destinationName)} · ${transfer.printStatus==='printed'?t('Printed','已打印'):['leased','printing'].includes(transfer.printStatus)?t('Printing TO','正在打印调货单'):['failed','uncertain','cancelled'].includes(transfer.printStatus)?t('Print needs attention','打印需要处理'):transfer.printJobId?t('Print queued','打印已排队'):t('Print pending','等待打印')}</p>`).join('')}
      ${complete?`<button type="button" ${scm?'data-scm-stock-action="refresh"':'data-sales-stock-action="refresh"'}>${t('Refresh print status','刷新打印状态')}</button>`:`<button class="primary" ${scm?'data-scm-stock-action="delivery-retry"':'data-sales-stock-action="delivery-retry"'} type="button" ${saving?'disabled':''}>${t('Retry / check progress','重试 / 查看进度')}</button>`}</section>`;
  }
  function scm(request,editor) {
    const {t,esc,number}=ui();
    return `<div class="stock-request-heading"><h2>${esc(request.requestRef)}</h2><span>${t('Delivery','送货')}</span></div>${summary(request)}${progress(request,true)}
      ${request.regular.deliveryApproval==='pending'&&request.status==='submitted'?`<div class="stock-request-actions"><button class="primary" data-scm-stock-action="approve-stock" type="button">${t('Approve and create TO','批准并建立调货单')}</button><button class="danger" data-scm-stock-action="reject" type="button">${t('Reject','拒绝')}</button></div>`:''}
      ${editor}<section class="stock-request-section"><h3>${t('Transfer quantities','调货数量')}</h3>${request.lines.map(line=>`<article class="stock-request-line"><strong>${esc(line.itemName)}</strong><p>${number(line.salesQty)} ${esc(line.salesUom)}</p>${line.decisionReason?`<p>${esc(line.decisionReason)}</p>`:''}</article>`).join('')}</section>`;
  }
  const phaseText=phase=>{
    const {t}=ui();
    return ({queued:t('Waiting to start…','正在等待处理…'),checking_so:t('Checking SO quantities and Base Yard…','正在检查销售订单数量与基础货场…'),
      checking_request:t('Checking the saved request and existing TO…','正在检查已保存的申请与调货单…'),checking_stock:t('Checking available stock at Target Yard…','正在检查目标货场的可用库存…'),
      calculating:t('Calculating transfer units and PALLET…','正在计算调货数量与托盘数…'),saving_approval:t('Saving SCM approval…','正在保存 SCM 审批…'),
      checking_to:t('Checking for an existing Transfer Order…','正在检查是否已有调货单…'),creating_to:t('Creating TO in NetSuite…','正在 NetSuite 中建立调货单…'),
      approving_to:t('Approving TO in NetSuite…','正在 NetSuite 中批准调货单…'),preparing_print:t('Preparing TO picking ticket…','正在准备调货单拣货单…'),
      queueing_print:t('Queueing TO for yard printing…','正在将调货单加入货场打印队列…'),finalizing:t('TO queued; refreshing stock and saving the result…','调货单已排队；正在刷新库存并保存结果…')})[phase]||t('Processing request…','正在处理申请…');
  };
  const pause=()=>new Promise(resolve=>window.setTimeout(resolve,800));
  let actorId='';
  function configure(id){actorId=String(id);}
  const storageKey=audience=>`mbbs.regularDelivery.operation.${audience}.${actorId}`;
  function remember(audience,value) {
    try{if(value)window.sessionStorage.setItem(storageKey(audience),JSON.stringify(value));else window.sessionStorage.removeItem(storageKey(audience));}catch{/* Storage may be disabled. Server progress still survives reload. */}
  }
  function recalled(audience) {
    try{return JSON.parse(window.sessionStorage.getItem(storageKey(audience))||'null');}catch{return null;}
  }
  async function shortCall(api,path,options={}) {
    const controller=new AbortController(),timer=window.setTimeout(()=>controller.abort(),15000);
    try{return await api(path,{...options,signal:controller.signal});}finally{window.clearTimeout(timer);}
  }
  async function run(api,action,input={}, {audience='sales',requestId=null,dialog=null,existing=null}={}) {
    const own=!dialog,operation=dialog||window.RegularStockDialog.begin(phaseText('queued'),{lockFields:true});
    const saved=recalled(audience),signature=JSON.stringify({action,input,requestId});
    const command={operationId:existing?.id || (saved?.signature===signature?saved.command.operationId:crypto.randomUUID()),action,input,requestId};
    const path=`/api/${audience}/stock-requests/delivery/operations`;
    let current=existing;
    remember(audience,{command,signature});
    try {
      for(;;) {
        try {
          current=current?await shortCall(api,`${path}/${current.id}`):await shortCall(api,path,{method:'POST',body:JSON.stringify(command)});
        } catch(error) {
          if(error.status>=400&&error.status<500&&error.status!==429){remember(audience,null);throw error;}
          operation.wait(ui().t('Connection interrupted. Reconnecting to check the same request…','连接中断，正在重新连接并检查同一申请…'));
          await pause();continue;
        }
        if(current.status==='succeeded'){remember(audience,null);return current.result;}
        if(current.status==='failed'){remember(audience,null);throw Object.assign(new Error(current.error),{code:current.code});}
        operation.wait(phaseText(current.phase));await pause();
      }
    } finally {if(own)operation.close();}
  }
  async function resume(api,audience,onPreview) {
    const pending=recalled(audience);
    const {operation}=await api(`/api/${audience}/stock-requests/delivery/operations/active`);
    if(!operation&&!pending)return null;
    const command=operation?{action:operation.action,input:operation.input,requestId:operation.requestId}:pending.command;
    if(command.action==='preview')onPreview?.(command.input,null);
    try{
      const result=await run(api,command.action,command.input,{audience,requestId:command.requestId,existing:operation});
      if(command.action==='preview'){onPreview?.(command.input,result);return null;}
      return result;
    }catch(error){
      if(command.action!=='preview')throw error;
      onPreview?.(command.input,null,error.message);return null;
    }
  }
  function printing(request) {
    return simple(request)&&(request.transfers||[]).some(transfer=>transfer.printJobId&&['queued','leased','printing'].includes(transfer.printStatus));
  }
  window.RegularStockDelivery={simple,composing,composer,summary,progress,scm,refresh,invalidate,run,resume,printing,phaseText,configure};
})();

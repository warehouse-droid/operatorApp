(() => {
  const t = (en,zh) => window.MBBS_I18N?.language?.() === 'zh-CN' ? zh : en;
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = value => value == null ? t('Unavailable','暂无数据') : new Intl.NumberFormat('en-CA',{maximumFractionDigits:4}).format(value);
  const decision = value => ({stock:t('Approved · TO / location change','已批准 · 调货 / 更改地点'),po:t('Approved · source replenishment PO','已批准 · 原货场采购补货'),reject:t('Rejected','已拒绝')})[value] || '';
  function apiError(payload,status) {
    const message=[payload?.error?.message,payload?.message,payload?.error,payload]
      .find(value=>typeof value==='string' && value.trim() && value!=='[object Object]');
    const error=new Error(message || `Request failed (${status}). Please try again.`);
    error.status=status;error.code=payload?.error?.code || payload?.code || '';
    return error;
  }
  function fields(composer) {
    if(composer.workflowVersion !== 2)return '';
    return `<div class="stock-request-line-fields regular-stock-fields">
      ${composer.deliveryMethod==='waitlist'?window.RegularWaitlist.customerFields(composer):`<label><span>${t('Customer (optional)','客户（选填）')}</span><input data-regular-field="customerName" maxlength="200" value="${esc(composer.customerName)}" /></label>`}
      <label><span>${t('Type','类型')} *</span><select data-regular-field="deliveryMethod" required><option value="">${t('Select…','请选择…')}</option><option value="pickup" ${composer.deliveryMethod==='pickup'?'selected':''}>${t('Pickup','自取')}</option><option value="delivery" ${composer.deliveryMethod==='delivery'?'selected':''}>${t('Delivery','送货')}</option><option value="stocking" ${composer.deliveryMethod==='stocking'?'selected':''}>${t('Stocking','备货')}</option><option value="waitlist" ${composer.deliveryMethod==='waitlist'?'selected':''}>${t('Waitlist','候补')}</option></select></label>
      ${composer.deliveryMethod==='stocking'?`<label><span>${t('Stocking type','备货类型')}</span><select data-regular-field="stockingType"><option value="transfer" ${composer.stockingType!=='purchase'?'selected':''}>${t('Transfer','调货')}</option><option value="purchase" ${composer.stockingType==='purchase'?'selected':''}>${t('Purchase','采购')}</option></select></label>`:''}
      ${composer.deliveryMethod==='delivery'?`<label><span>${t('Expected arrival date','预计到达日期')} *</span><input data-regular-field="arrivalDate" autocomplete="off" required placeholder="YYYY-MM-DD" value="${esc(composer.arrivalDate)}" /></label>
      <label><span>${t('Expected arrival time (Toronto)','预计到达时间（多伦多）')} *</span><input data-regular-field="arrivalTime" autocomplete="off" required placeholder="15:00 / 3pm" value="${esc(composer.arrivalTime)}" /></label>`:''}
      <p class="stock-request-wide regular-stock-method-help">${t('Pickup: pre-approval, then Sales enters the SO; no minimum lead time. Delivery: Base Yard, Target Yard and SO number; approval follows the yard route. Stocking: choose Transfer or Purchase; SCM review is required. Transfer creates TOs; Purchase adds quantities to PO proposals.','自取：预先批准后由销售输入 SO，无需最短提前时间。送货：输入基础货场、目标货场及 SO 号，按路线审核。备货：选择调货或采购，须 SCM 人工审核。调货建立 TO，采购加入采购建议。')}</p>
    </div>`;
  }
  const stocking=request=>(request?.regular?.deliveryMethod==='stocking'||!!request?.regular?.pickupTransfer)&&!request.regular.handoffStatus;
  /** @param {{regular?:{customerName?:unknown}}|null|undefined} request */
  function customer(request) {
    const name = String(request?.regular?.customerName || '').trim();
    return name ? `<span class="regular-stock-customer"><small>${t('Customer','客户')}</small> <strong>${esc(name)}</strong></span>` : '';
  }
  const approvalExpired=request=>!stocking(request) && !request?.regular?.handoffStatus && !!request?.regular?.approvalExpiresAt && Date.now()>=new Date(request.regular.approvalExpiresAt).getTime();
  function reviewReasons(request) {
    const approval=request.regular?.approval || {},reasons=[];
    if(stocking(request))reasons.push(t('Stocking always requires SCM review and direct TO creation.','备货申请始终须 SCM 审核并直接建立调货单。'));
    if(approval.autoApprovalEnabled===false)reasons.push(t('Auto-approval is turned off. SCM must review this request.','自动批准已关闭，须由 SCM 审核此申请。'));
    if(approval.leadTimeApplies!==false && !stocking(request) && approval.enoughTime===false)reasons.push(t(`Required at least ${number(approval.leadHours)} hours of lead time.`,`须至少提前 ${number(approval.leadHours)} 小时申请。`));
    for(const evidence of approval.lines || []){
      const line=request.lines?.find(line=>line.id===evidence.lineId) || {};
      const name=line.itemName || line.itemId || evidence.itemId, yard=line.sourceName || line.sourceLocationId || '';
      const unit=evidence.unit || line.salesUom || '';
      if(evidence.reasons?.includes('below_safety'))reasons.push(t(`${name} at ${yard} will be under safety stock after shipment: ${number(evidence.remainingQuantity)} ${unit} remaining; ${number(evidence.safetyQuantity)} ${unit} required.`,`${name}（${yard}）发货后将低于安全库存：剩余 ${number(evidence.remainingQuantity)} ${unit}，安全库存要求 ${number(evidence.safetyQuantity)} ${unit}。`));
      if(evidence.reasons?.includes('policy_unavailable'))reasons.push(t(`${name} at ${yard}: availability or safety stock is unavailable. SCM must review this item.`,`${name}（${yard}）：可用库存或安全库存数据不足，须 SCM 审核。`));
    }
    return [...new Set(reasons)];
  }
  function summary(request) {
    if(request?.workflowVersion!==2)return '';
    if(request.regular?.resolution)return customer(request)+(window.RegularStockResolution?.result(request)||'');
    if(window.RegularStockDelivery?.simple(request))return window.RegularStockDelivery.summary(request);
    const r=request.regular||{}, a=r.approval||{}, reasons=reviewReasons(request);
    return `<div class="stock-request-summary regular-stock-summary">
      <span><small>${t('Customer','客户')}</small><strong>${esc(r.customerName||'—')}</strong></span>
      <span><small>${t('Method','取货方式')}</small><strong>${stocking(request)?t('Stocking','备货'):r.deliveryMethod==='pickup'?t('Pickup','自取'):t('Delivery','送货')}</strong></span>
      ${r.arrivalDate&&r.arrivalTime?`<span><small>${t('Expected arrival · Toronto','预计到达 · 多伦多')}</small><strong>${esc(r.arrivalDate)} ${esc(r.arrivalTime)}</strong></span>`:''}
      <span><small>${t('Review route','审核方式')}</small><strong>${a.automatic&&!stocking(request)?t('Automatically approved','自动批准'):t('SCM review','SCM 人工审核')}</strong></span>
      <span><small>${t('Minimum lead time at submission','提交时最短提前时间')}</small><strong>${stocking(request)?t('SCM review required','须 SCM 审核'):a.leadTimeApplies===false?t('No minimum lead time','无需最短提前时间'):`${number(a.leadHours)} ${t('hours','小时')}`}</strong></span>
      ${r.approvalExpiresAt&&!r.handoffStatus&&!stocking(request)?`<span><small>${t('Approval valid until','批准有效期至')}</small><strong>${esc(window.MBBS_I18N?.displayDateTime?.(r.approvalExpiresAt)||r.approvalExpiresAt)}</strong></span>`:''}
      ${r.salesOrderRef?`<span><small>SO</small><strong>${esc(r.salesOrderRef)}</strong></span>`:''}
    </div>${(!a.automatic||stocking(request))&&reasons.length?`<section class="stock-request-notice regular-stock-review-reasons"><strong>${t('Why SCM review is required','需要 SCM 审核的原因')}</strong><ul>${reasons.map(reason=>`<li>${esc(reason)}</li>`).join('')}</ul></section>`:''}
    ${approvalExpired(request)?`<p class="stock-request-notice stock-request-error">${t('Approval expired. Sales can re-raise this request for a fresh review.','批准已过期，销售可重新提交申请以重新审核。')}</p>`:''}
    ${r.handoffError?`<p class="stock-request-notice stock-request-error">${esc(r.handoffError)}</p>`:''}`;
  }
  function safety(request,line) {
    if(request?.workflowVersion!==2)return '';
    if(window.RegularStockDelivery?.simple(request))return '';
    const complete=!!request.regular?.pickupTransfer || request.regular?.handoffStatus==='complete' || request.status==='completed';
    const e=(!complete && request.currentEvidence?.find(entry=>entry.lineId===line.id))||line.approvalEvidence||{};
    const labels=[[complete?t('Available at approval','批准时可用库存'):t('Available','可用库存'),e.availableQuantity],[t('Requested (all matching lines)','申请数量（相同货品合计）'),e.groupedRequestedQuantity],[t('Safety stock required','所需安全库存'),e.safetyQuantity],[complete?t('Remaining after approved request','批准扣除申请后的库存'):t('After shipment','发货后库存'),e.remainingQuantity],[t('Below safety by','低于安全库存'),e.shortfallQuantity]];
    return `<div class="regular-stock-safety" aria-label="${t('Safety stock review','安全库存审核')}">${labels.map(([label,value])=>`<span><small>${label}</small><strong>${number(value)} ${esc(e.unit||line.salesUom)}</strong></span>`).join('')}</div>${e.reasons?.includes('policy_unavailable')?`<p class="stock-request-notice">${t('Safety or availability evidence is unavailable. SCM must review this line.','安全库存或可用库存数据不足，须 SCM 人工审核此行。')}</p>`:''}${line.decision?`<p><strong>${decision(line.decision)}</strong></p>`:''}`;
  }
  function actionText(action,completed=false) {
    if(action.mode==='pickup')return t(`${action.requestRef}: ${completed?'Transfer Orders issued':'Approve and issue Transfer Orders'} to ${action.destinationName}.`,`${action.requestRef}：${completed?'已开立':'批准并开立'}调货单至 ${action.destinationName}。`)
      +'\n'+(action.routes||[]).map(route=>`${route.sourceName} → ${route.destinationName}\n${(route.items||[]).map(item=>`${item.itemName}: ${number(item.quantity)} ${item.unit}`).join('\n')}\nPALLET: ${number(route.palletQuantity)}`).join('\n\n')+(action.review?'\n\n'+action.review:'');
    if(action.mode==='location')return completed
      ? t(`${action.salesOrderRef}: Item line locations were changed to ${action.sourceName}.`,`${action.salesOrderRef}：商品行地点已更改为 ${action.sourceName}。`)
      : t(`${action.salesOrderRef}: Change all ${action.lineCount} item line locations from ${action.destinationName} to ${action.sourceName}, including PALLET, discount, subtotal and delivery fee lines where present.`,`${action.salesOrderRef}：将全部 ${action.lineCount} 个商品行地点从 ${action.destinationName} 更改为 ${action.sourceName}，包括托盘、折扣、小计及送货费行（如有）。`);
    const routes=(action.routes||[]).map(route=>`${route.sourceName} → ${route.destinationName}`).join('; ');
    return completed
      ? t(`${action.salesOrderRef}: Transfer Orders were issued to your sales yard ${action.destinationName}. ${routes}`,`${action.salesOrderRef}：调货单已开立至您的销售货场 ${action.destinationName}。${routes}`)
      : t(`${action.salesOrderRef}: Issue ${action.routes.length} Transfer Orders for the approved stock: ${routes}.`,`${action.salesOrderRef}：为已批准的库存开立 ${action.routes.length} 张调货单：${routes}。`);
  }
  function confirmationMessage(action,resuming=false) {
    return `${resuming?t('Resume this action; existing orders will be reused.','继续处理此操作；将沿用现有订单。')+'\n\n':''}${actionText(action)}\n\n${t('Confirm to proceed, or Cancel to leave the request unchanged.','确认后执行，或取消以保持申请不变。')}`;
  }
  function completedAction(request) {
    const r=request.regular, transfers=r.routingTransfers || (request.transfers||[]).filter(row=>row.netsuiteTransferOrderRef)
      .map(row=>({reference:row.netsuiteTransferOrderRef,sourceName:row.sourceName,destinationName:row.destinationName}));
    const action=r.routingAction || {mode:r.routingMode,salesOrderRef:r.salesOrderRef,sourceName:request.lines.find(line=>['stock','po'].includes(line.decision))?.sourceName || '—',
      destinationName:request.destinationName || '—',routes:transfers};
    return `<section class="stock-request-notice regular-stock-result"><strong>${t('SO handoff complete.','销售订单处理完成。')}</strong><p>${esc(actionText(action,true))}</p>
      ${transfers.map(row=>`<p>${esc(row.reference)} · ${esc(row.sourceName)} → ${esc(row.destinationName)}</p>`).join('')}
      ${r.routingCompletedAt?`<small>${t('Completed','完成时间')}: ${esc(window.MBBS_I18N?.displayDateTime?.(r.routingCompletedAt)||r.routingCompletedAt)}</small>`:''}</section>`;
  }
  function salesOrder(request,saving) {
    if(request?.workflowVersion!==2)return '';
    if(window.RegularStockDelivery?.simple(request))return window.RegularStockDelivery.progress(request,false,saving);
    const r=request.regular||{};
    if(r.handoffStatus==='complete')return completedAction(request);
    if(stocking(request))return stockingResult(request);
    if(approvalExpired(request))return `<section class="stock-request-section regular-stock-expired"><h3>${t('Approval expired','批准已过期')}</h3><p>${t(`The ${r.approvalValidityMinutes || 15}-minute approval window has ended. Re-raise the approved items to check current stock and approval rules.`,`批准的 ${r.approvalValidityMinutes || 15} 分钟有效期已结束。请重新提交已批准的商品，以检查最新库存和审核规则。`)}</p><button class="primary" data-sales-stock-action="re-raise" type="button" ${saving?'disabled':''}>${t('Re-raise request','重新提交申请')}</button></section>`;
    if(request.lines.some(line=>line.status==='submitted'))return `<p class="stock-request-notice">${t('Waiting for SCM to finish reviewing all lines before entering the SO number.','待 SCM 审核所有商品行后，请输入销售订单号。')}</p>`;
    if(!request.lines.some(line=>['stock','po'].includes(line.decision)))return '';
    return `<section class="stock-request-section regular-stock-so"><h3>${t('Sales Order','销售订单')}</h3><p>${t('Create the SO at your own sales yard, then enter its number. Review and confirm the planned action before it is processed.','请在您的销售货场建立销售订单，再输入订单号，请先查看并确认将执行的操作。')}</p><label><span>${t('SO number','销售订单号')}</span><input data-regular-so maxlength="80" value="${esc(r.salesOrderRef||r.soInput)}" ${r.salesOrderRef?'readonly':''} /></label>${(r.soChoices||[]).map(choice=>`<label><span>${esc(choice.itemName||choice.itemId)} · ${t("Select SO line","选择销售订单行")}</span><select data-regular-so-line="${choice.itemId}">${choice.lines.map(line=>`<option value="${line.id}">${line.id} · ${number(line.quantity)} ${esc(line.uom)}</option>`).join('')}</select></label>`).join('')}<button class="primary" data-sales-stock-action="link-so" type="button" ${saving?'disabled':''}>${saving?t('Processing…','处理中…'):r.salesOrderRef?t('Retry / check progress','重试 / 查看进度'):t('Review SO routing','查看订单安排')}</button></section>`;
  }
  function stockingResult(request) {
    const state=request.regular?.pickupTransfer;
    if(!state)return request.lines.some(line=>['submitted','approved'].includes(line.status))?`<p class="stock-request-notice">${t('Waiting for SCM to review quantities and create the Transfer Orders. No SO number is required for Stocking.','待 SCM 审核数量并建立调货单。备货申请无需输入销售订单号。')}</p>`:'';
    return `<section class="stock-request-notice regular-stock-result"><strong>${state.status==='complete'?t('Stocking TOs created by SCM','SCM 已建立备货调货单'):t('SCM Stocking conversion in progress','SCM 正在处理备货调货单')}</strong>
      <p class="regular-pickup-action" style="white-space:pre-line">${esc(actionText(state.plan.action,state.status==='complete'))}</p>
      ${(state.transfers||(request.transfers||[]).filter(row=>row.netsuiteTransferOrderRef).map(row=>({reference:row.netsuiteTransferOrderRef,sourceName:row.sourceName,destinationName:row.destinationName}))).map(row=>`<p>${esc(row.reference)} · ${esc(row.sourceName)} → ${esc(row.destinationName)}</p>`).join('')}
      ${state.error?`<p class="stock-request-error">${esc(state.error)} · ${t('SCM can retry the saved conversion.','SCM 可重试已保存的转换。')}</p>`:''}
      ${state.completedAt?`<small>${t('Completed','完成时间')}: ${esc(window.MBBS_I18N?.displayDateTime?.(state.completedAt)||state.completedAt)}</small>`:''}</section>`;
  }
  async function normalize(composer,root) {
    if(composer?.deliveryMethod==='waitlist'&&!composer.customerId)throw new Error('Select an existing customer from the list.');
    if(composer?.deliveryMethod!=='delivery'||!composer.arrivalDate||!composer.arrivalTime)return;
    const {arrivalDate,arrivalTime}=composer;
    const {normalizeRegularArrival}=await import('/regular-stock-input.js?v=20260929-controls');
    if(composer.deliveryMethod!=='delivery'||composer.arrivalDate!==arrivalDate||composer.arrivalTime!==arrivalTime)return;
    const arrival=normalizeRegularArrival(arrivalDate,arrivalTime);
    composer.arrivalDate=arrival.date;composer.arrivalTime=arrival.time;
    for(const key of ['arrivalDate','arrivalTime']) {const input=root.querySelector(`[data-regular-field="${key}"]`);if(input){input.value=composer[key];input.setCustomValidity('');}}
    return arrival;
  }
  window.RegularStockUI={t,esc,number,decision,fields,summary,safety,salesOrder,normalize,confirmationMessage,apiError,approvalExpired,stocking,stockingResult,customer};
})();

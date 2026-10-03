(() => {
  const t=(en,zh)=>window.RegularStockUI.t(en,zh),esc=value=>window.RegularStockUI.esc(value),number=value=>window.RegularStockUI.number(value);
  const purchase=value=>{const regular=value?.regular||value;return regular?.deliveryMethod==='stocking'&&regular.stockingType==='purchase';};
  const status=value=>({submitted:t('Pending review','待审核'),pending:t('Pending review','待审核'),approved:t('Accepted','已接受'),accepted:t('Accepted','已接受'),received:t('Received','已收货'),completed:t('Completed','已完成'),closed:t('Released','已释放'),rejected:t('Rejected','已拒绝'),cancelled:t('Cancelled','已取消')})[value]||value;
  function stock(evidence={},unit='') {
    return `<div class="regular-stock-safety">${[[t('On hand','现有库存'),evidence.onHand],[t('Available','可用库存'),evidence.available],[t('Preferred stock level','目标库存水平'),evidence.preferredStock]].map(([label,value])=>`<span><small>${label}</small><strong>${number(value)} ${esc(unit)}</strong></span>`).join('')}</div>`;
  }
  function rounded(value,line) {
    const conversion=Number(line.toPlt),quantity=Number(value);
    if(!(conversion>0&&quantity>0))return null;
    let pallets=Math.ceil(quantity/conversion);
    if(pallets>1&&Number(((pallets-1)*conversion).toFixed(6))>=quantity)pallets--;
    return Number((pallets*conversion).toFixed(6));
  }
  function orders(line) {
    const rows=line.purchase?.orders||[];
    if(!rows.length)return `<p class="stock-request-muted">${t('No related incoming PO yet.','暂无相关在途采购订单。')}</p>`;
    return `<div class="regular-purchase-orders" tabindex="0" role="region" aria-label="${t('Related purchase orders','关联采购订单')}"><table><thead><tr>${[t('Relationship','关联'),t('PO number','采购订单号'),t('PO ref','采购参考号'),t('Quantity / Received / Open','数量 / 已收 / 待收'),t('Status / Expected arrival','状态 / 预计到达')].map(label=>`<th>${label}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr><td>${row.direct?t('Directly linked','直接关联'):t('Other incoming','其他在途')} ${row.direct&&!row.active?t('(history)','（历史）'):''}</td><td title="${esc(row.purchaseOrderId)}">${esc(row.purchaseOrderNumber||'—')}</td><td>${esc(row.purchaseOrderRef||'—')}</td><td>${number(row.quantity)} / ${number(row.receivedQuantity)} / ${number(row.active?Math.max(0,row.quantity-row.receivedQuantity):0)} ${esc(row.unit||line.salesUom)}</td><td>${row.pendingVerification?t('Awaiting PO item sync','等待采购明细同步'):esc(row.status||'—')}<br>${esc(row.expectedArrival?window.MBBS_I18N?.displayDateTime?.(row.expectedArrival)||row.expectedArrival:'—')}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function line(request,item,scm,options) {
    const p=item.purchase||{},pending=item.status==='submitted'||item.status==='changes_requested';
    const evidence=request.currentEvidence?.find(row=>row.lineId===item.id)||item.approvalEvidence||{};
    const reviewed=options.reviewedQuantities?.[item.id]??item.salesQty;
    return `<article class="stock-request-line" data-scm-stock-line-id="${item.id}"><header><div>${scm&&pending?`<input data-scm-stock-select-line type="checkbox" ${options.selectedLineIds?.has(item.id)?'checked':''} aria-label="${esc(item.itemName)}" />`:''}<strong>${esc(item.itemName)}</strong><p class="stock-request-muted">${esc(item.itemDescription)}</p></div><span class="stock-request-pill">${esc(request.regular?.resolution&&item.status==='closed'?t('Resolved','已解决'):status(item.status))}</span></header>
      ${stock(evidence,item.salesUom)}
      <div class="stock-request-summary">${[[t('Requested','申请数量'),p.requestedQuantity??item.salesQty],[t('SCM reviewed','SCM 审核'),p.reviewedQuantity??item.salesQty],[t('Accepted','已接受'),p.approvedQuantity||0],[t('Unordered','未订购'),p.unorderedQuantity||0],[t('Ordered','已订购'),p.orderedQuantity||0],[t('Received','已收货'),p.receivedQuantity||0],[t('Released','已释放'),p.releasedQuantity||0]].map(([label,value])=>`<span><small>${label}</small><strong>${number(value)} ${esc(item.salesUom)}</strong></span>`).join('')}</div>
      ${scm&&item.status==='submitted'?`<label><span>${t('SCM reviewed quantity','SCM 审核数量')} (${esc(item.salesUom)})</span><input data-purchase-review-line="${item.id}" type="number" min="0.000001" step="any" value="${esc(reviewed)}" /></label><p>${t('Rounded up for PO proposal','采购建议向上取整')}: <strong data-purchase-rounded-line="${item.id}">${number(rounded(reviewed,item))} ${esc(item.salesUom)}</strong></p>`:''}
      ${(p.proposals||[]).length?`<p>${t('PO/TO proposals','采购 / 调货建议')}: ${(p.proposals||[]).map(row=>`<span>${scm?`<a href="/scm/smart">#${row.proposalId}</a>`:`#${row.proposalId}`} · ${number(row.quantity)} ${esc(item.salesUom)} · ${esc(row.status)}</span>`).join(' · ')}</p>`:''}
      ${item.decisionReason?`<p>${esc(item.decisionReason)}</p>`:''}${p.releaseReason?`<p>${t('Release reason','释放原因')}: ${esc(p.releaseReason)}</p>`:''}
      ${scm&&p.unorderedQuantity>0?`<div class="stock-request-actions"><input data-purchase-release-reason="${item.id}" value="${esc(options.releaseReasons?.[item.id]||'')}" maxlength="1000" placeholder="${t('Release reason','释放原因')}" /><button data-scm-stock-action="purchase-release" data-line-id="${item.id}" type="button">${t('Release remaining demand','释放剩余需求')}</button></div>`:''}
      ${orders(item)}</article>`;
  }
  /** @param {{selectedLineIds?:Set<number>,reviewedQuantities?:Record<number,string>,releaseReasons?:Record<number,string>,resolveDraft?:import('../tools/regular-stock-resolution-globals.js').RegularResolutionDraft|null,busy?:boolean}} options */
  function detail(request,scm=false,options={}) {
    const pending=request.lines.some(item=>item.status==='submitted');
    const selected=request.lines.some(item=>item.status==='submitted'&&options.selectedLineIds?.has(item.id));
    return `<div class="stock-request-heading"><div><h2>${esc(request.requestRef)}</h2><p>${t('Stocking · Purchase','备货 · 采购')} · ${esc(request.destinationName)}</p></div><span class="stock-request-pill">${esc(status(request.bucket||request.status))}</span></div>
      ${window.RegularStockUI.customer(request)}
      ${window.RegularStockResolution?.result(request)||''}
      ${request.regular?.resolution?'':`<p class="stock-request-notice">${t('SCM manual review is required. Purchase quantities are rounded up to whole pallets.','须由 SCM 人工审核。采购数量将向上取整至整托盘。')}</p>`}${request.remarks?`<p>${esc(request.remarks)}</p>`:''}
      ${scm&&!request.regular?.resolution?`<div class="stock-request-actions"><button data-scm-stock-action="select-all" type="button">${t('Select actionable items','选择待处理商品')}</button><button data-scm-stock-action="refresh-evidence" type="button">${t('Refresh stock evidence','刷新库存数据')}</button><button class="primary" data-scm-stock-action="purchase-add" type="button" ${selected?'':'disabled'}>${t('Add to PO/TO proposal','加入采购 / 调货建议')}</button><button class="danger" data-scm-stock-action="reject" type="button" ${pending?'':'disabled'}>${t('Reject selected / pending','拒绝选中 / 待审核商品')}</button>${window.RegularStockResolution?.button(request,options.busy)||''}</div>`:!scm&&!request.firstScmDecisionAt&&pending?`<div class="stock-request-actions"><button data-sales-stock-action="edit" type="button">${t('Edit request','编辑申请')}</button><button class="danger" data-sales-stock-action="cancel" type="button">${t('Cancel request','取消申请')}</button></div>`:''}
      ${scm?window.RegularStockResolution?.editor(request,options.resolveDraft,options.busy)||'':''}
      <div class="stock-request-lines">${request.lines.map(item=>line(request,item,scm,options)).join('')}</div>
      ${(request.events||[]).length?`<section class="stock-request-section"><h3>${t('Updates','更新记录')}</h3>${request.events.slice(0,12).map(event=>`<p>${esc(({request_submitted:t('Request submitted','申请已提交'),regular_manual_review:t('SCM review required','须 SCM 审核'),regular_manual_decision:t('SCM decision recorded','SCM 审核结果已保存'),regular_purchase_released:t('Remaining demand released','剩余需求已释放')})[event.eventType]||t('Request updated','申请已更新'))} · ${esc(event.actorName)} · ${esc(window.MBBS_I18N?.displayDateTime?.(event.createdAt)||event.createdAt)}</p>`).join('')}</section>`:''}`;
  }
  window.RegularPurchaseUI={purchase,stock,detail,rounded};
})();

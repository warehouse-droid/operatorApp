(() => {
  /** @param {string} en @param {string} zh */
  const t=(en,zh)=>window.RegularStockUI.t(en,zh);
  /** @param {unknown} value */
  const esc=value=>window.RegularStockUI.esc(value);
  /** @param {import('../tools/regular-stock-resolution-globals.js').RegularResolutionRequest|null|undefined} request */
  function eligible(request) {
    const regular=request?.regular||{},lines=request?.lines||[],active=['submitted','changes_requested','approved'];
    return request?.workflowVersion===2&&regular.deliveryMethod==='stocking'&&['submitted','active'].includes(request.status)
      &&!regular.resolution&&!regular.pickupTransfer&&!regular.handoffStatus&&!(request.transfers||[]).length
      &&lines.some(line=>active.includes(line.status))&&lines.every(line=>[...active,'rejected','cancelled','closed','received','fulfilled'].includes(line.status))
      &&!lines.some(line=>line.purchase?.demandId);
  }
  /** @param {import('../tools/regular-stock-resolution-globals.js').RegularResolutionRequest|null|undefined} request */
  function button(request,busy=false) {
    return eligible(request)?`<button data-scm-stock-action="resolve" type="button" ${busy?'disabled':''}>${t('Resolve','解决')}</button>`:'';
  }
  /** @param {import('../tools/regular-stock-resolution-globals.js').RegularResolutionRequest} request @param {import('../tools/regular-stock-resolution-globals.js').RegularResolutionDraft|null|undefined} draft */
  function editor(request,draft,busy=false) {
    if(!eligible(request)||!draft||draft.requestId!==request.id)return '';
    return `<form class="stock-request-section stock-request-form" data-regular-resolution-form>
      <h3>${t('Resolve Stocking request','解决备货申请')}</h3>
      <p>${t('Reply with an existing PO and ETA. This closes the case and notifies Sales once.','请填写现有采购订单和预计到达日期。此操作将关闭申请并通知销售一次。')}</p>
      <div class="stock-request-line-fields">
        <label><span>${t('Existing PO number','现有采购订单号')}</span><input id="regularResolvePo" data-regular-resolution-field="purchaseOrderRef" maxlength="80" required value="${esc(draft.purchaseOrderRef)}" ${busy?'disabled':''} /></label>
        <label><span>ETA</span><input id="regularResolveEta" data-regular-resolution-field="eta" type="date" required value="${esc(draft.eta)}" ${busy?'disabled':''} /></label>
      </div>
      <div class="stock-request-actions"><button data-scm-stock-action="cancel-resolve" type="button" ${busy?'disabled':''}>${t('Cancel','取消')}</button><button class="primary" type="submit" ${busy?'disabled':''}>${busy?t('Saving…','保存中…'):t('Resolve request','解决申请')}</button></div>
    </form>`;
  }
  /** @param {import('../tools/regular-stock-resolution-globals.js').RegularResolutionRequest|null|undefined} request */
  function result(request) {
    const saved=request?.regular?.resolution;
    if(!saved)return '';
    return `<section class="stock-request-notice regular-stock-result" data-regular-resolution-result><strong>${t('Resolved','已解决')}</strong>
      <div class="stock-request-summary"><span><small>PO</small><strong>${esc(saved.purchaseOrderRef)}</strong></span><span><small>ETA</small><strong>${esc(saved.eta)}</strong></span>
        <span><small>${t('Resolved at','解决时间')}</small><strong>${esc(window.MBBS_I18N?.displayDateTime?.(saved.resolvedAt)||saved.resolvedAt)}</strong></span></div></section>`;
  }
  window.RegularStockResolution={eligible,button,editor,result};
})();

(() => {
  /** @param {string} en @param {string} zh */
  const t=(en,zh)=>window.RegularStockUI.t(en,zh);
  /** @param {unknown} value */
  const esc=value=>window.RegularStockUI.esc(value);
  /** @param {import('../tools/regular-stock-resolution-globals.js').RegularResolutionRequest|null|undefined} request @param {import('../tools/regular-stock-resolution-globals.js').RegularResolutionLine|null} [line] */
  function eligible(request,line) {
    const regular=request?.regular||{},lines=request?.lines||[],active=['submitted','changes_requested','approved'];
    line=line||(lines.length===1?lines[0]:null);
    return request?.workflowVersion===2&&regular.deliveryMethod==='stocking'&&['submitted','active'].includes(request.status)
      &&!regular.resolution&&!regular.pickupTransfer&&!regular.handoffStatus&&!!line&&!line.resolution
      &&active.includes(line.status)&&!line.purchase?.demandId&&!line.transferId
      &&!(request.transfers||[]).some(transfer=>!transfer.lines?.length||transfer.lines.some(row=>row.id===line.id));
  }
  /** @param {import('../tools/regular-stock-resolution-globals.js').RegularResolutionRequest|null|undefined} request @param {import('../tools/regular-stock-resolution-globals.js').RegularResolutionLine|null} [line] */
  function button(request,busy=false,line) {
    line=line||(request?.lines?.length===1?request.lines[0]:null);
    return line&&eligible(request,line)?`<button data-scm-stock-action="resolve" data-line-id="${line.id}" type="button" ${busy?'disabled':''}>${t('Resolve','解决')}</button>`:'';
  }
  /** @param {import('../tools/regular-stock-resolution-globals.js').RegularResolutionRequest|null|undefined} request @param {import('../tools/regular-stock-resolution-globals.js').RegularResolutionDraft|null|undefined} draft @param {import('../tools/regular-stock-resolution-globals.js').RegularResolutionLine|null} [line] */
  function editor(request,draft,busy=false,line) {
    line=line||(request?.lines?.length===1?request.lines[0]:null);
    if(!request||!line||!eligible(request,line)||!draft||draft.requestId!==request.id||draft.lineId!==line.id&&!(draft.lineId===undefined&&request.lines?.length===1))return '';
    return `<form class="stock-request-section stock-request-form" data-regular-resolution-form data-line-id="${line.id}">
      <h3>${t('Resolve material','解决商品')} · ${esc(line.itemName)}</h3>
      <p>${t('Enter an existing PO and ETA for this material. Other materials stay open.','请填写此商品的现有采购订单和预计到达日期。其他商品保持开放。')}</p>
      <div class="stock-request-line-fields">
        <label><span>${t('Existing PO number','现有采购订单号')}</span><input id="regularResolvePo" data-regular-resolution-field="purchaseOrderRef" maxlength="80" required value="${esc(draft.purchaseOrderRef)}" ${busy?'disabled':''} /></label>
        <label><span>ETA</span><input id="regularResolveEta" data-regular-resolution-field="eta" type="date" required value="${esc(draft.eta)}" ${busy?'disabled':''} /></label>
      </div>
      <div class="stock-request-actions"><button data-scm-stock-action="cancel-resolve" type="button" ${busy?'disabled':''}>${t('Cancel','取消')}</button><button class="primary" type="submit" ${busy?'disabled':''}>${busy?t('Saving…','保存中…'):t('Resolve material','解决商品')}</button></div>
    </form>`;
  }
  /** @param {import('../tools/regular-stock-resolution-globals.js').RegularResolutionRequest|null|undefined} request @param {import('../tools/regular-stock-resolution-globals.js').RegularResolutionLine|null} [line] */
  function result(request,line) {
    const saved=line?.resolution||(!line||line.status==='closed'?request?.regular?.resolution:null);
    if(!saved)return '';
    return `<section class="stock-request-notice regular-stock-result" data-regular-resolution-result><strong>${t('Resolved','已解决')}</strong>
      <div class="stock-request-summary"><span><small>PO</small><strong>${esc(saved.purchaseOrderRef)}</strong></span><span><small>ETA</small><strong>${esc(saved.eta)}</strong></span>
        <span><small>${t('Resolved at','解决时间')}</small><strong>${esc(window.MBBS_I18N?.displayDateTime?.(saved.resolvedAt)||saved.resolvedAt)}</strong></span></div></section>`;
  }
  window.RegularStockResolution={eligible,button,editor,result};
})();

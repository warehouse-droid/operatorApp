(() => {
  const t=(en,zh)=>window.RegularStockUI.t(en,zh),esc=value=>window.RegularStockUI.esc(value);
  const stocking=request=>request?.requestType==='regular'&&request.workflowVersion===2&&request.regular?.deliveryMethod==='stocking';
  const status=request=>request.displayStatus||request.bucket||request.status;
  const label=value=>({pending_update:t('Pending update','待销售更新'),pending_scm:t('Pending SCM review','待 SCM 审核'),
    proposed:t('Added to PO/TO proposal','已加入采购 / 调货建议'),partially_proposed:t('Partially added to PO/TO proposal','部分已加入采购 / 调货建议'),resolved:t('Resolved','已解决'),waitlisted:t('Moved to waitlist','已转入候补清单')})[value];
  /** @param {{lines?:import('../tools/regular-stock-resolution-globals.js').RegularResolutionLine[]}|null|undefined} request @param {import('../tools/regular-stock-resolution-globals.js').RegularResolutionLine|null} [line] */
  const target=(request,line)=>line||(request?.lines?.length===1?request.lines[0]:null);
  /** @param {unknown} _request @param {import('../tools/regular-stock-resolution-globals.js').RegularResolutionLine & {replyStatus?:string|null}} line */
  function lineStatus(_request,line) {
    if(line.resolution)return 'resolved';
    if(['closed','rejected','cancelled','received','fulfilled'].includes(line.status))return line.status;
    return line.replyStatus||(line.status==='approved'&&line.purchase?.demandId?'proposed':line.status);
  }
  /** @param {import('../tools/regular-stock-resolution-globals.js').RegularResolutionLine|null} [line] */
  function eligible(request,audience,operatorId,line) {
    line=target(request,line);
    return stocking(request)&&['submitted','active'].includes(request.status)&&!request.regular.resolution
      &&!!line&&!['closed','rejected','cancelled','received','fulfilled'].includes(line.status)&&!line.resolution
      &&request.regular.pickupTransfer?.status!=='executing'&&request.regular.handoffStatus!=='executing'
      &&(audience==='scm'||request.requestedBy===operatorId&&(request.events||[]).some(event=>event.eventType==='regular_scm_reply'
        &&(event.requestLineId===line.id||event.requestLineId==null&&(event.details?.lineId===line.id||!Object.hasOwn(event.details||{},'lineId')))));
  }
  /** @param {import('../tools/regular-stock-resolution-globals.js').RegularResolutionLine|null} [line] */
  function history(request,line) {
    const messages=(request.events||[]).filter(event=>['regular_scm_reply','regular_sales_reply'].includes(event.eventType)
      &&(line?event.requestLineId===line.id||event.requestLineId==null&&(event.details?.lineId===line.id||!Object.hasOwn(event.details||{},'lineId')&&request.lines.length===1):event.requestLineId==null&&!Object.hasOwn(event.details||{},'lineId'))).slice(0,30).reverse();
    if(!messages.length)return '';
    return `<section class="stock-request-section" data-regular-reply-history><h3>${t('Instructions and replies','说明及回复')}</h3>${messages.map(event=>{
      const reply=event.details||{},scm=event.eventType==='regular_scm_reply';
      return `<article class="stock-request-notice"><strong>${scm?t('SCM instructions','SCM 说明'):t('Sales reply','销售回复')}</strong> · ${esc(event.actorName)}
        <small>${esc(window.MBBS_I18N?.displayDateTime?.(event.createdAt)||event.createdAt)}</small>
        <p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(reply.message)}</p>
        ${reply.eta?`<p>ETA: ${esc(reply.eta)}</p>`:''}${reply.salesOrderRef?`<p>${t('SO number','销售订单号')}: ${esc(reply.salesOrderRef)}</p>`:''}</article>`;
    }).join('')}</section>`;
  }
  /** @param {import('../tools/regular-stock-resolution-globals.js').RegularResolutionLine} line */
  function editor(request,audience,draft,busy,line) {
    if(!draft||draft.requestId!==request.id||draft.lineId!==line.id&&!(draft.lineId===undefined&&request.lines.length===1))return '';
    const scm=audience==='scm';
    return `<form class="stock-request-section stock-request-form" data-regular-reply-form data-line-id="${line.id}">
      <h3>${scm?t('Reply to Sales','回复销售'):t('Reply to SCM instructions','回复 SCM 说明')}</h3>
      <p>${esc(line.itemName)}</p>
      <label><span>${scm?t('Instructions for Sales','给销售的说明'):t('Your reply','您的回复')} *</span><textarea data-regular-reply-field="message" maxlength="2000" rows="4" required ${busy?'disabled':''}>${esc(draft.message)}</textarea></label>
      <label><span>${scm?t('ETA (optional)','预计到达日期（选填）'):t('Sales order number (optional)','销售订单号（选填）')}</span>
        <input data-regular-reply-field="${scm?'eta':'salesOrderRef'}" ${scm?'type="date"':'maxlength="80"'} value="${esc(scm?draft.eta:draft.salesOrderRef)}" ${busy?'disabled':''} /></label>
      ${scm?'':`<p class="stock-request-muted">${t('The SO number is a reference for SCM. Sending a reply keeps this request open.','销售订单号供 SCM 参考。发送回复后申请仍保持开放。')}</p>`}
      <div class="stock-request-actions"><button data-${audience}-stock-action="cancel-reply" type="button" ${busy?'disabled':''}>${t('Cancel','取消')}</button><button class="primary" type="submit" ${busy?'disabled':''}>${busy?t('Sending…','发送中…'):t('Send reply','发送回复')}</button></div></form>`;
  }
  /** @param {import('../tools/regular-stock-resolution-globals.js').RegularResolutionLine|null} [line] */
  function button(request,audience,busy=false,operatorId,line) {
    if(window.StockRequestConversation)return '';
    line=target(request,line);
    return line&&eligible(request,audience,operatorId,line)?`<button data-${audience}-stock-action="reply" data-line-id="${line.id}" type="button" ${busy?'disabled':''}>${t('Reply','回复')}</button>`:'';
  }
  /** @param {{showButton?:boolean,line?:import('../tools/regular-stock-resolution-globals.js').RegularResolutionLine}} options */
  function panel(request,audience,draft,busy=false,operatorId,options={}) {
    if(window.StockRequestConversation)return '';
    const {showButton=true,line}=options;
    if(!stocking(request))return '';
    if(!line)return request.lines.length===1?'':history(request);
    const allowed=eligible(request,audience,operatorId,line),editing=draft?.requestId===request.id&&draft.lineId===line.id;
    return history(request,line)+(allowed?(editing?editor(request,audience,draft,busy,line):showButton?`<div class="stock-request-actions">${button(request,audience,busy,operatorId,line)}</div>`:''):'');
  }
  window.RegularStockReply={status,label,lineStatus,eligible,panel,button};
})();

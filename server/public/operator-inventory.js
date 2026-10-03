(function(root) {
  'use strict';
  const calc=root.MBBSCountingCalculator;
  const physical=[['pallets','PLT','to_plt'],['layers','LYR','to_lyr'],['sections','SEC','to_sec'],['pieces','PCS','to_pcs']];
  const t=(key,en)=>root.MBBS_I18N?.t(`inventory.${key}`,en) || en;
  const quantity=value=>Number(value || 0).toLocaleString(undefined,{maximumFractionDigits:6});
  const status=value=>t(`status.${value}`,({available:'Available',in_progress:'In progress',submitted:'Submitted',cancelled:'Cancelled',pending:'Waiting to post',posting:'Posting',posted:'Posted',attention:'Needs attention',superseded:'Superseded by another report',removed:'Removed from transfer',missing:'Transfer not found'})[value] || value);
  function create(ctx) {
    const esc=ctx.escape;
    let module='damage',view='entry',config={reasons:[]},busy=false,error='',search='',suggestions=[],searchTimer,generation=0;
    let item=null,values={},photos=[],reason='',requestId=crypto.randomUUID(),stream=/** @type {MediaStream|null} */(null),cameraGeneration=0,facing='environment',saved=null;
    let month='',review={reports:[]},selectedReport=null,sheets=[],sheet=null,selectedItem=null,activeUnit='',expressions={},countValues={},loadedContext='';
    let pendingSheet=null,sheetReady=false;
    const drafts=root.MBBSDamageDraftCache.create();
    let submission=null,postingTimer,postingGeneration=0;
    const contextKey=()=>`${ctx.actor()?.id}:${ctx.location()}`;
    const damageLocked=()=>Boolean(submission || (saved && !['posted','superseded'].includes(saved.status)));
    const sameContext=key=>key===loadedContext && key===contextKey() && module==='damage';
    const draftState=()=>({version:1,item,values,photos,reason,search,requestId,saved,submission});
    async function stashDraft(key,state) {
      try {await drafts.save(key,state);}
      catch {if(sameContext(key)){error=t('draftCacheError','Could not save the draft on this device. Your quantity and photos are still on this page.');ctx.toast(error);}}
    }
    const saveDraft=()=>stashDraft(loadedContext,draftState());
    const storageKey=()=>`mbbs.inventory.sheet.${ctx.actor()?.id}.${ctx.location()}`;
    const api=(path,body)=>ctx.api(path,body===undefined?undefined:{method:'POST',body:JSON.stringify(body)});
    const button=(action,label,extra='')=>`<button class="secondary-button" data-inv-action="${action}" type="button" ${extra}>${label}</button>`;
    const message=()=>error?`<p class="inventory-error" role="alert">${esc(error)}</p>`:'';
    function units(sku,damage=false) {
      const available=physical.filter(unit=>Number(sku?.[unit[2]])>0).map(([key,label,factor])=>({key,label,factor:Number(sku[factor])}));
      return available.length ? available : [{key:damage?'sales':'pieces',label:(damage?sku?.sales_unit:sku?.stock_unit) || 'Qty',factor:1}];
    }
    function stopCamera() {cameraGeneration++;if(stream){ctx.detachCameraPreviews?.();}stream?.getTracks().forEach(track=>track.stop());stream=null;}
    function close() {generation++;postingGeneration++;clearTimeout(searchTimer);clearTimeout(postingTimer);stopCamera();}
    function resetDamage() {item=null;values={};photos=[];reason='';search='';suggestions=[];requestId=crypto.randomUUID();submission=null;saved=null;}
    function restoreDraft(draft) {
      if(draft?.version!==1 || !draft.item || !Array.isArray(draft.photos) || draft.photos.length>5
        || !/^[0-9a-f-]{36}$/i.test(String(draft.requestId))) {return;}
      item=draft.item;values=draft.values || {};photos=draft.photos;reason=String(draft.reason || '');search=draft.search || item.item_name;
      requestId=draft.requestId;saved=draft.saved || null;submission=draft.submission || null;
    }
    function restoreReport(row) {
      item={item_id:row.item_id,item_name:row.item_name,sales_unit:row.unit,sales_unit_id:row.unit_id,...row.conversions};
      values={...row.values};photos=[...row.photos];reason=String(row.reason_id);search=row.item_name;requestId=row.id;saved=row;submission=null;
    }
    async function acceptPosting(row,key) {
      if(!sameContext(key)) {return;}
      if(row.status==='posted' || row.status==='superseded') {
        stopCamera();resetDamage();saved=row;
        try {await drafts.clear(key);} catch {error=t('draftCacheError','Could not save the draft on this device. Your quantity and photos are still on this page.');}
      } else {saved=row;submission=null;await saveDraft();}
    }
    function pollPosting() {
      clearTimeout(postingTimer);
      if(!saved || !['pending','posting'].includes(saved.status) || module!=='damage') {return;}
      const key=loadedContext,id=saved.id,version=postingGeneration;
      postingTimer=setTimeout(async()=>{
        try {
          const row=await api(`/api/inventory/damage/reports/${id}`);
          if(version!==postingGeneration || !sameContext(key)) {return;}
          await acceptPosting(row,key);render();pollPosting();
        } catch(failure) {if(version===postingGeneration && sameContext(key)){error=failure.message;render();}}
      },1500);
    }
    async function open(next) {
      close();
      const context=contextKey();
      if(loadedContext!==context) {resetDamage();review={reports:[]};selectedReport=null;month='';loadedContext=context;}
      module=next;busy=true;error='';view='entry';sheet=null;selectedItem=null;pendingSheet=null;sheetReady=false;render();
      const openedGeneration=generation;
      try {
        if(module==='damage') {
          const [nextConfig,cached]=await Promise.all([api('/api/inventory/damage/config'),drafts.load(context).catch(()=>{error=t('draftCacheError','Could not save the draft on this device. Your quantity and photos are still on this page.');return null;})]);
          if(!sameContext(context)) {return;}
          config=nextConfig;month=month || config.month;restoreDraft(cached);
          if(saved?.id || submission) {
            try {await acceptPosting(await api(`/api/inventory/damage/reports/${saved?.id || requestId}`),context);}
            catch(failure) {if(failure.status!==404){error=failure.message;}}
          } else if(!item) {
            const local=await api(`/api/inventory/damage/reports?locationId=${ctx.location()}&month=${encodeURIComponent(month)}&local=true`);
            if(!sameContext(context)) {return;}
            const unfinished=local.reports.find(row=>row.operator_id===ctx.actor()?.id && ['attention','pending','posting'].includes(row.status));
            if(unfinished) {restoreReport(unfinished);await saveDraft();}
          }
          pollPosting();
        }
        else {
          sheets=await api(`/api/count-sheets?locationId=${ctx.location()}`);
          if(openedGeneration!==generation || context!==contextKey()) {return;}
          const id=localStorage.getItem(storageKey());
          if(id) {await openSheet(id);}
        }
      } catch(failure) {if(openedGeneration===generation && context===loadedContext){error=failure.message;}} finally {if(openedGeneration===generation && context===loadedContext){busy=false;render();}}
    }
    function render() {
      const title=module==='damage'?t('damageTitle','Damage stock'):t('sheetsTitle','Count sheets');
      ctx.shell(title,ctx.locationLabel(),`<section class="inventory-workspace">${message()}${module==='damage'?(view==='review'?renderReview():renderDamage()):renderSheets()}</section>`,
        button('menu',t('inventory','Inventory'))+button('refresh',t('refresh','Refresh'),busy?'disabled':''));
      if(stream) {requestAnimationFrame(()=>{const video=document.getElementById('damageCamera');if(video){video.srcObject=stream;void video.play().catch(()=>{});}});}
    }
    function damageQuantity() {return item ? units(item,true).reduce((sum,u)=>sum+(Number(values[u.key]) || 0)*u.factor,0):0;}
    function canSubmitDamage() {return !busy && !damageLocked() && item && reason && photos.length && damageQuantity()>0 && Object.values(values).every(value=>value!=='' && Number.isFinite(Number(value)) && Number(value)>=0);}
    function renderPosting() {
      if(saved?.status==='posted') {return `<p class="inventory-notice" data-damage-saved>${t('savedToNetSuite','Saved to NetSuite')} · ${esc(saved.transfer_ref || '')}</p>`;}
      if(saved?.status==='superseded') {return `<p class="inventory-notice">${esc(status('superseded'))}</p>`;}
      if(!saved && !submission) {return '';}
      const failed=saved?.status==='attention';
      return `<section class="inventory-notice" data-damage-saved data-damage-posting role="status"><strong>${saved?esc(status(saved.status)):t('saveUnconfirmed','Report save not yet confirmed')}</strong>
        <p>${t('damageRetained','Your quantity and photos are saved. No re-entry is needed.')}</p>
        ${saved?.last_error?`<p class="inventory-error">${esc(saved.last_error)}</p>`:''}
        ${failed?button('retry-saved-damage',saved.safe_to_retry?t('retry','Retry posting'):t('recheck','Recheck posting'),busy?'disabled':''):!saved?button('retry-damage-save',t('retrySave','Retry save'),busy?'disabled':''):button('retry-saved-damage',t('checkPosting','Check posting status'),busy?'disabled':'')}</section>`;
    }
    function renderDamage() {
      return `<div class="inventory-toolbar"><div class="damage-search"><label for="damageSearch">${t('searchSku','Search SKU')}</label><input id="damageSearch" role="combobox" aria-controls="damageSuggestions" aria-expanded="${Boolean(suggestions.length)}" autocomplete="off" value="${esc(search)}" ${busy || damageLocked()?'disabled':''}><div id="damageSuggestions" role="listbox">${suggestionHtml()}</div></div>${button('damage-review',t('monthlyReview','Monthly damage review'))}</div>
        ${renderPosting()}
        <div class="damage-entry-grid">
          <section class="damage-camera-panel"><h2>${t('photos','Damage photos')} <small>${t('photoRequired','At least one required')}</small></h2>
            <div class="damage-camera-view">${stream?'<video id="damageCamera" autoplay muted playsinline></video>':`<div class="inventory-empty">${t('cameraHelp','Select a SKU and take a photo of the damaged stock.')}</div>`}</div>
            <div class="inventory-actions">${button('camera',ctx.nativeCamera?.()?t('takePhoto','Take photo'):stream?t('stopCamera','Stop camera'):t('startCamera','Start camera'),!item || busy || damageLocked() || (ctx.nativeCamera?.() && photos.length>=5)?'disabled':'')}${ctx.nativeCamera?.()?'':button('capture',t('takePhoto','Take photo'),!stream || photos.length>=5 || busy || damageLocked()?'disabled':'')+button('flip',t('switchCamera','Switch camera'),!item || busy || damageLocked()?'disabled':'')}</div>
            <div class="damage-photos">${photos.map((photo,index)=>`<figure><img ${ctx.photo(photo)} alt="${t('damagePhoto','Damage photo')} ${index+1}">${button('remove-photo',t('remove','Remove'),`data-index="${index}" ${busy || damageLocked()?'disabled':''}`)}</figure>`).join('')}</div>
          </section>
          <aside class="damage-quantity-panel"><h2>${item?esc(item.item_name):t('selectSku','Select a SKU')}</h2><p>${esc(item?.item_description || '')}</p>
            ${item?units(item,true).map(u=>`<label class="inventory-quantity-label">${esc(u.label)}<div class="stepper"><button data-inv-action="step-damage" data-unit="${u.key}" data-delta="-1" type="button" ${busy || damageLocked()?'disabled':''}>−</button><input aria-label="${esc(u.label)}" type="number" min="0" step="any" inputmode="decimal" data-damage-quantity="${u.key}" value="${esc(values[u.key] ?? 0)}" ${busy || damageLocked()?'disabled':''}><button data-inv-action="step-damage" data-unit="${u.key}" data-delta="1" type="button" ${busy || damageLocked()?'disabled':''}>+</button></div></label>`).join(''):''}
            <p class="inventory-total" data-damage-total>${quantity(damageQuantity())} ${esc(item?.sales_unit || '')}</p>
            <label for="damageReason">${t('reason','Damage reason')}</label><select id="damageReason" ${busy || damageLocked()?'disabled':''}><option value="">${t('chooseReason','Choose a reason')}</option>${config.reasons.map(r=>`<option value="${r.id}" ${String(reason)===String(r.id)?'selected':''}>${esc(r.label)}</option>`).join('')}</select>
            <button class="primary-button" data-inv-action="submit-damage" type="button" ${canSubmitDamage()?'':'disabled'}>${busy?t('saving','Saving…'):t('submitDamage','Submit damage')}</button>
          </aside>
        </div>`;
    }
    function suggestionHtml() {return suggestions.map(sku=>`<button type="button" role="option" aria-selected="false" data-inv-action="damage-item" data-id="${sku.item_id}"><strong>${esc(sku.item_name)}</strong><span>${esc(sku.item_description || '')}</span></button>`).join('');}
    async function searchDamage() {
      const version=++generation,term=search;
      if(!term.trim()){suggestions=[];return updateSuggestions();}
      try {
        const rows=await api(`/api/inventory/damage/items?locationId=${ctx.location()}&search=${encodeURIComponent(term)}`);
        if(version!==generation || module!=='damage' || view!=='entry') {return;}
        suggestions=rows;updateSuggestions();
      } catch(failure) {if(version===generation){ctx.toast(failure.message);}}
    }
    function updateSuggestions() {
      const list=document.getElementById('damageSuggestions');if(list){list.innerHTML=suggestionHtml();}
      document.getElementById('damageSearch')?.setAttribute('aria-expanded',String(Boolean(suggestions.length)));
    }
    async function selectDamage(id) {
      const key=loadedContext,version=generation;
      busy=true;error='';render();
      try {const selected=await api(`/api/inventory/damage/items/${id}?locationId=${ctx.location()}`);if(!sameContext(key) || version!==generation){return;}resetDamage();item=selected;search=selected.item_name;values=Object.fromEntries(units(item,true).map(u=>[u.key,0]));await saveDraft();}
      finally {if(sameContext(key) && version===generation){busy=false;render();}}
    }
    async function camera() {
      if(stream){stopCamera();return render();}
      if(!item) {return;}
      if(ctx.nativeCamera?.()) {
        const report=requestId,selected=item;
        const photo=await ctx.captureNativePhoto(facing);
        if(photo && ctx.active() && requestId===report && item===selected && view==='entry' && !busy && photos.length<5) {photos.push(photo);await saveDraft();render();}
        return;
      }
      const version=++cameraGeneration;
      const next=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:facing},width:{ideal:1280}}});
      if(version!==cameraGeneration || module!=='damage' || view!=='entry') {next.getTracks().forEach(track=>track.stop());return;}
      stream=next;render();
    }
    async function capture() {
      const video=document.getElementById('damageCamera');
      if(!video?.videoWidth || photos.length>=5) {throw new Error(t('cameraWaiting','Wait for the camera to be ready.'));}
      const canvas=document.createElement('canvas');canvas.width=Math.min(video.videoWidth,1600);canvas.height=Math.round(video.videoHeight*canvas.width/video.videoWidth);
      canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);photos.push(canvas.toDataURL('image/jpeg',0.85));await saveDraft();render();
    }
    async function submitDamage() {
      if(!submission && !canSubmitDamage()) {return;}
      const key=loadedContext,state=structuredClone(draftState()),locationId=ctx.location();
      busy=true;error='';render();
      try {
        for(const [index,photo] of state.photos.entries()) {
          if(String(photo).startsWith('r2://')) {continue;}
          state.photos[index]=await ctx.upload(photo,{recordType:'operator-damage-photo',orderRef:state.requestId,lineId:state.item.item_id,filename:`damage-${index+1}.jpg`});
          await stashDraft(key,state);
          if(!sameContext(key)) {return;}
          photos=[...state.photos];
        }
        state.submission=state.submission || {requestId:state.requestId,locationId,itemId:state.item.item_id,reasonId:Number(state.reason),values:state.values,photos:state.photos};
        await stashDraft(key,state);
        if(!sameContext(key)) {return;}
        submission=state.submission;
        await acceptPosting(await api('/api/inventory/damage/reports',submission),key);
        stopCamera();pollPosting();
      } catch(failure) {
        if(sameContext(key) && failure.status>=400 && failure.status<500 && ![408,409,429].includes(failure.status)) {submission=null;await saveDraft();}
        throw failure;
      } finally {if(sameContext(key)){busy=false;render();}}
    }
    async function retrySavedDamage() {
      const key=loadedContext,id=saved?.id;if(!id) {return;}
      busy=true;error='';render();
      try {await acceptPosting(await api(`/api/inventory/damage/reports/${id}/retry`,{}),key);pollPosting();}
      finally {if(sameContext(key)){busy=false;render();}}
    }
    async function loadReview() {
      stopCamera();view='review';busy=true;error='';render();
      try {review=await api(`/api/inventory/damage/reports?locationId=${ctx.location()}&month=${encodeURIComponent(month)}`);selectedReport=review.reports.find(r=>r.id===selectedReport?.id) || review.reports[0] || null;}
      finally {busy=false;render();}
    }
    function renderReview() {
      return `<div class="inventory-toolbar">${button('damage-entry',t('reportDamage','Report damage'))}<label for="damageMonth">${t('month','Month')}<input id="damageMonth" type="month" value="${esc(month)}" ${busy?'disabled':''}></label></div>
        ${review.syncError?`<p class="inventory-error">${t('historySyncError','NetSuite history could not be refreshed. Saved app reports remain available.')} ${esc(review.syncError)}</p>`:''}
        <div class="damage-review-grid"><section class="damage-review-list">${review.reports.map(row=>`<button class="${selectedReport?.id===row.id?'active':''}" data-inv-action="report" data-id="${esc(row.id)}" type="button"><strong>${esc(row.item_name)}</strong><span>${quantity(row.quantity)} ${esc(row.unit)}</span></button>`).join('') || `<p>${busy?t('loading','Loading…'):t('noDamage','No damage reports in this month.')}</p>`}</section>
          <section class="damage-review-details">${selectedReport?reportDetails(selectedReport):`<p>${t('selectReport','Select a report to see its details and photos.')}</p>`}</section></div>`;
    }
    function reportDetails(row) {
      const entered=physical.filter(([key])=>Number(row.values?.[key])>0).map(([key,label])=>`${quantity(row.values[key])} ${label}`).join(' / ');
      return `<h2>${esc(row.item_name)}</h2><p class="inventory-total">${quantity(row.quantity)} ${esc(row.unit)}</p><p>${esc(entered)}</p>
        ${row.adjusted && row.original?`<p>${t('originalReport','Originally reported')}: ${esc(row.original.item_name)} · ${quantity(row.original.quantity)} ${esc(row.original.unit)}</p>`:''}
        <dl class="inventory-details"><dt>${t('reason','Damage reason')}</dt><dd>${esc(row.reason_label || '—')}</dd><dt>${t('operator','Operator')}</dt><dd>${esc(row.operator_name || '—')}</dd>
          <dt>${t('date','Date')}</dt><dd>${esc(row.created_at?new Date(row.created_at).toLocaleString(undefined,{timeZone:'America/Toronto'}): '—')}</dd><dt>${t('transfer','Inventory Transfer')}</dt><dd>${esc(row.transfer_ref || '—')}</dd><dt>${t('status','Status')}</dt><dd>${esc(status(row.status))}</dd></dl>
        ${row.last_error?`<p class="inventory-error">${esc(row.last_error)}</p>`:''}
        ${row.status==='attention'?button('retry-report',row.safe_to_retry?t('retry','Retry posting'):t('recheck','Recheck posting'),`data-id="${esc(row.id)}" ${busy?'disabled':''}`):''}
        <div class="damage-detail-photos">${row.photos.map(photo=>`<button type="button" data-inv-action="photo" data-ref="${esc(photo)}"><img ${ctx.photo(photo)} alt="${t('damagePhoto','Damage photo')}"></button>`).join('') || `<p>${t('noPhoto','No photo on record')}</p>`}</div>`;
    }
    function selectCount(id) {
      selectedItem=sheet.items.find(row=>String(row.item_id)===String(id));
      const options=units(selectedItem);activeUnit=options[0].key;
      countValues={...(selectedItem.count?.values || {})};expressions=Object.fromEntries(options.map(u=>[u.key,{expression:String(countValues[u.key] || 0),evaluated:false}]));render();
    }
    async function openSheet(id,take=false) {
      const version=++generation,context=contextKey(),key=storageKey();
      const current=()=>version===generation && module==='count-sheets' && context===contextKey();
      busy=true;error='';sheetReady=false;pendingSheet={id,take};selectedItem=null;render();
      try {
        let next=await api(`/api/count-sheets/${id}${take?'/take':''}`,take?{}:undefined);
        if(!current()) {return;}
        sheet=next;localStorage.setItem(key,String(sheet.id));render();
        if(sheet.status==='in_progress') {
          next=await api(`/api/count-sheets/${id}/refresh-inventory`,{});
          if(!current()) {return;}
        }
        sheet=next;sheetReady=true;pendingSheet=null;
      } catch(failure) {
        if(current()) {
          error=failure.message;
          if([403,404].includes(failure.status)) {localStorage.removeItem(key);sheet=null;pendingSheet=null;}
        }
      } finally {if(current()){busy=false;render();}}
    }
    function renderSheets() {
      if(pendingSheet && !sheetReady) {
        return `<section class="inventory-notice" data-sheet-refresh role="status"><strong>${esc(sheet?.title || t('sheetsTitle','Count sheets'))}</strong>
          <p>${busy?t('refreshingSheetStock','Refreshing stock for this count sheet…'):t('sheetStockRetry','Refresh the stock before continuing this count.')}</p>
          ${button('retry-sheet-refresh',t('retryRefresh','Retry'),busy?'disabled':'')}${button('sheet-list',t('allSheets','All sheets'),busy?'disabled':'')}</section>`;
      }
      if(!sheet) {return `<div class="inventory-sheet-list">${sheets.map(row=>`<article class="inventory-sheet-card"><div><h2>${esc(row.title)}</h2><p>${esc(status(row.status))} · ${row.counted}/${row.total} ${t('skus','SKUs')} ${esc(row.owner_name || '')}</p></div>
        ${row.status==='available'?button('take',t('takeSheet','Take sheet'),`data-id="${row.id}"`):row.owner_id===ctx.actor().id?button('open-sheet',row.status==='in_progress'?t('resume','Resume'):t('review','Review'),`data-id="${row.id}"`):''}</article>`).join('') || `<p>${busy?t('loading','Loading…'):t('noSheets','No count sheets assigned to this yard.')}</p>`}</div>`;}
      const editable=sheet.status==='in_progress' && sheet.owner_id===ctx.actor().id;
      return `<div class="inventory-toolbar">${button('sheet-list',t('allSheets','All sheets'))}<strong>${esc(sheet.title)}</strong><span data-sheet-status>${esc(status(sheet.status))}</span><span>${sheet.counted}/${sheet.total} ${t('counted','counted')}</span></div>
        <div class="cycle-grid"><section class="cycle-list-panel inventory-sheet-items">${sheet.items.map(row=>`<button class="line-card ${selectedItem?.item_id===row.item_id?'active':''}" data-inv-action="count-item" data-id="${row.item_id}" type="button"><div><strong>${esc(row.item_name)}</strong><p>${esc(row.item_description || '')}</p><span>${row.count?`${quantity(row.count.quantity)} ${esc(row.count.unit)}`:t('uncounted','Uncounted')}</span></div></button>`).join('')}</section>
          <aside class="selected-panel">${selectedItem?renderCountPanel(editable):`<h2>${t('sheetProgress','Count progress')}</h2><p>${sheet.counted}/${sheet.total} ${t('counted','counted')}</p><p>${t('countHelp','Confirm each assigned SKU, including zero stock, before submitting.')}</p>${editable?`<button class="primary-button" data-inv-action="submit-sheet" type="button" ${busy || sheet.counted!==sheet.total?'disabled':''}>${t('submitSheet','Submit count sheet')}</button>`:''}`}</aside></div>`;
    }
    function renderCountPanel(editable) {
      if(!editable) {return `<h2>${esc(selectedItem.item_name)}</h2><p>${selectedItem.count?`${quantity(selectedItem.count.quantity)} ${esc(selectedItem.count.unit)}`:t('uncounted','Uncounted')}</p>${button('count-summary',t('sheetProgress','Count progress'))}`;}
      return `<div class="selected-header cycle-selected-header"><strong>${esc(selectedItem.item_name)}</strong><p>${esc(selectedItem.item_description || '')}</p></div>
        <div class="selected-measures cycle-conversion-measures">${units(selectedItem).map(u=>`<div class="measure"><span>1 ${esc(u.label)}</span><b>${quantity(u.factor)}</b></div>`).join('')}</div>
        <div class="cycle-count-fields">${units(selectedItem).map(u=>`<button class="cycle-count-field ${activeUnit===u.key?'active':''}" data-inv-action="count-unit" data-unit="${u.key}" type="button"><span>${esc(u.label)}</span><strong data-count-value="${u.key}">${quantity(countValues[u.key])}</strong></button>`).join('')}</div>
        <output class="count-calculator-expression" aria-live="polite">${esc(expressions[activeUnit]?.expression || '0')} ${esc(units(selectedItem).find(u=>u.key===activeUnit)?.label || '')}</output>
        ${calc.pad('data-inv-action','count-key')}<p class="inventory-count-total" data-count-total>${quantity(units(selectedItem).reduce((sum,u)=>sum+(Number(countValues[u.key]) || 0)*u.factor,0))} ${esc(selectedItem.stock_unit || '')}</p><div class="selected-actions"><button class="primary-button" data-inv-action="confirm-count" type="button" ${busy?'disabled':''}>${t('confirmLine','Confirm line')}</button>${button('count-summary',t('sheetProgress','Count progress'))}</div>`;
    }
    function countKey(key) {
      expressions[activeUnit]=calc.press(expressions[activeUnit],key);
      if(expressions[activeUnit].value!==undefined) {countValues[activeUnit]=expressions[activeUnit].value;}
      else {try{countValues[activeUnit]=calc.evaluate(expressions[activeUnit].expression);}catch{/* Incomplete expressions remain visible until corrected. */}}
      render();
    }
    async function confirmCount() {
      for(const u of units(selectedItem)) {countValues[u.key]=calc.evaluate(expressions[u.key]?.expression || '0');}
      sheet=await api(`/api/count-sheets/${sheet.id}/line`,{attempt:sheet.attempt,revision:sheet.revision,itemId:selectedItem.item_id,values:countValues});
      selectedItem=null;expressions={};render();
    }
    const actions={
      menu:()=>{close();ctx.back();},refresh:()=>module==='damage'&&view==='review'?loadReview():module==='count-sheets'&&sheet?openSheet(sheet.id):open(module),
      'damage-item':b=>selectDamage(b.dataset.id),camera,capture,flip:async()=>{stopCamera();facing=facing==='environment'?'user':'environment';await camera();},
      'remove-photo':async b=>{photos.splice(Number(b.dataset.index),1);await saveDraft();render();},'submit-damage':submitDamage,
      'retry-saved-damage':retrySavedDamage,'retry-damage-save':submitDamage,
      'damage-review':loadReview,'damage-entry':()=>{view='entry';render();},report:b=>{selectedReport=review.reports.find(r=>r.id===b.dataset.id);render();},
      photo:b=>ctx.preview(b.dataset.ref,t('damagePhoto','Damage photo')),
      'retry-report':async b=>{await api(`/api/inventory/damage/reports/${b.dataset.id}/retry`,{});await loadReview();},
      'step-damage':async b=>{const key=b.dataset.unit;values[key]=Math.max(0,(Number(values[key]) || 0)+Number(b.dataset.delta));await saveDraft();render();},
      take:b=>openSheet(b.dataset.id,true),'open-sheet':b=>openSheet(b.dataset.id),
      'retry-sheet-refresh':()=>openSheet(pendingSheet.id,pendingSheet.take),
      'sheet-list':async()=>{localStorage.removeItem(storageKey());sheet=null;pendingSheet=null;sheetReady=false;sheets=await api(`/api/count-sheets?locationId=${ctx.location()}`);render();},
      'count-item':b=>selectCount(b.dataset.id),'count-unit':b=>{activeUnit=b.dataset.unit;render();},'count-key':b=>countKey(b.dataset.key),
      'count-summary':()=>{selectedItem=null;render();},'confirm-count':confirmCount,
      'submit-sheet':async()=>{sheet=await api(`/api/count-sheets/${sheet.id}/submit`,{attempt:sheet.attempt,revision:sheet.revision});render();}
    };
    ctx.root.addEventListener('click',async event=>{
      const target=event.target.closest('[data-inv-action]');if(!target){return;}
      event.stopImmediatePropagation();if((busy && target.dataset.invAction!=='menu') || (damageLocked() && ['damage-item','camera','capture','flip','remove-photo','step-damage','submit-damage'].includes(target.dataset.invAction))){return;}error='';
      try{await actions[target.dataset.invAction]?.(target);}catch(failure){error=failure.message;ctx.toast(error);render();}
    },true);
    ctx.root.addEventListener('input',event=>{
      if(event.target.id==='damageSearch'){search=event.target.value;clearTimeout(searchTimer);searchTimer=setTimeout(searchDamage,250);}
      if(event.target.matches('[data-damage-quantity]')){
        if(damageLocked()) {return;}
        values[event.target.dataset.damageQuantity]=event.target.value;
        void saveDraft();
        const total=ctx.root.querySelector('[data-damage-total]');if(total){total.textContent=`${quantity(damageQuantity())} ${item?.sales_unit || ''}`;}
        const submit=ctx.root.querySelector('[data-inv-action="submit-damage"]');if(submit){submit.disabled=!canSubmitDamage();}
      }
    });
    ctx.root.addEventListener('change',event=>{
      if(event.target.id==='damageReason' && !damageLocked()){reason=event.target.value;void saveDraft();const submit=ctx.root.querySelector('[data-inv-action="submit-damage"]');if(submit){submit.disabled=!canSubmitDamage();}}
      if(event.target.id==='damageMonth' && event.target.value){month=event.target.value;void loadReview().catch(failure=>{error=failure.message;render();});}
    });
    return {open,render,close,stopCamera};
  }
  root.MBBSOperatorInventory={create};
})(window);

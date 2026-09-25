(function(root) {
  'use strict';
  const t=(key,fallback)=>root.MBBS_I18N?.t(`damageControl.${key}`,fallback) || fallback;
  const qty=value=>Number(value || 0).toLocaleString(undefined,{maximumFractionDigits:6});
  const date=value=>value?new Date(value).toLocaleString(undefined,{timeZone:'America/Toronto'}):'—';
  const status=value=>t(`status.${value}`,({pending:'Syncing with NetSuite…',posting:'Syncing with NetSuite…',posted:'Saved to NetSuite',attention:'Needs attention',conflict:'Refresh and review changes'})[value] || value);
  function create(ctx) {
    const esc=ctx.escape;
    let config={yards:[],reasons:[]},locationId='',month='',review={transfers:[],reports:[],history:[]},transfer=null;
    let draft=[],selected='',editor=null,note='',busy=false,error='',command=null,submission=null,suggestions=[],searchTimer,pollTimer,searchVersion=0;
    const api=(path,body)=>ctx.request(`/api/control/damage${path}`,body===undefined?undefined:{method:'POST',body:JSON.stringify(body)});
    const action=(name,label,extra='',disabled=false)=>`<button type="button" data-cd-action="${name}" ${extra} ${disabled?'disabled':''}>${label}</button>`;
    const fields=row=>({itemId:Number(row.itemId),quantity:Number(row.quantity),unitId:Number(row.unitId),reasonId:Number(row.reasonId)});
    function changes() {
      return draft.flatMap(row=>row.added?(row.removed?[]:[{action:'add',...fields(row)}]):row.removed?[{action:'remove',line:row.line}]:
        JSON.stringify(fields(row))!==JSON.stringify(fields(row.original))?[{action:'update',line:row.line,...fields(row)}]:[]);
    }
    function blocked() {return command && (['pending','posting'].includes(command.status) || (command.status==='attention' && !command.safe_to_retry));}
    function editable() {return Boolean(transfer && review.transfers.length===1 && !review.syncError && !busy && !submission && !blocked());}
    function validEditor() {return editor && Number(editor.itemId)>0 && Number.isFinite(Number(editor.quantity)) && Number(editor.quantity)>0 && Number(editor.quantity)<=1e12 && editor.units.some(unit=>String(unit.id)===String(editor.unitId)) && config.reasons.some(reason=>Number(reason.id)===Number(editor.reasonId));}
    function resetDraft() {
      draft=(transfer?.lines || []).map(line=>({...structuredClone(line),key:`line-${line.line}`,original:structuredClone(line),added:false,removed:false}));
      if(!draft.some(row=>row.key===selected)) {selected=draft[0]?.key || '';}
      editor=null;note='';suggestions=[];searchVersion++;
    }
    async function refreshReview() {
      review=await api(`/review?locationId=${locationId}&month=${encodeURIComponent(month)}`);
      transfer=review.transfers.find(row=>row.id===transfer?.id) || review.transfers[0] || null;resetDraft();
      if(command?.status!=='posted') {command=review.history.find(row=>['pending','posting'].includes(row.status) || (row.status==='attention' && !row.safe_to_retry)) || null;}
    }
    async function load() {
      clearTimeout(pollTimer);
      if(submission && !command) {ctx.render();return;}
      if(changes().length || editor) {ctx.render();return;}
      busy=true;error='';ctx.render();
      try {
        config=await api('/config');locationId=locationId || String(config.yards[0]?.id || '');month=month || config.month;
        if(locationId) {await refreshReview();}
      } catch(failure) {error=failure.message;}
      finally {busy=false;ctx.render();schedulePoll();}
    }
    function schedulePoll() {
      clearTimeout(pollTimer);
      if(command && ['pending','posting'].includes(command.status) && (!ctx.active || ctx.active())) {pollTimer=setTimeout(checkStatus,1500);}
    }
    async function checkStatus() {
      if(!command || (ctx.active && !ctx.active())) {return;}
      try {
        command=await api(`/adjustments/${command.id}`);
        if(command.status==='posted') {submission=null;busy=true;await refreshReview();busy=false;}
        else if(['attention','conflict'].includes(command.status)) {submission=null;}
        error='';
      } catch(failure) {error=failure.message;busy=false;}
      ctx.render();schedulePoll();
    }
    function render() {
      const dirty=changes().length,lockFilters=busy || Boolean(submission) || Boolean(editor) || dirty>0;
      return `<section class="panel control-damage"><div class="control-damage-toolbar"><div><h2 data-control-damage-title>${t('title','Damage stock')}</h2><p>${t('help','Review monthly damage transfers and save corrections to NetSuite.')}</p></div>
        <label>${t('yard','Yard')}<select data-cd-yard ${lockFilters?'disabled':''}>${config.yards.map(yard=>`<option value="${yard.id}" ${String(yard.id)===locationId?'selected':''}>${esc(yard.name)}</option>`).join('')}</select></label>
        <label>${t('month','Month')}<input type="month" data-cd-month value="${esc(month)}" ${lockFilters?'disabled':''}></label>
        ${action('refresh',t('refresh','Refresh'),'',lockFilters)}</div>
        ${error?`<p class="control-damage-error" data-cd-error role="alert">${esc(error)}</p>`:''}
        ${review.syncError?`<p class="control-damage-error">${esc(review.syncError)}</p>`:''}
        ${command?`<div class="control-damage-status" data-cd-posting-status role="status"><strong>${esc(status(command.status))}</strong>${command.last_error?`<p>${esc(command.last_error)}</p>`:''}
          ${command.status==='attention'?action('retry',command.safe_to_retry?t('retry','Retry sync'):t('recheck','Recheck status'),`data-id="${esc(command.id)}"`,busy):''}</div>`:''}
        ${transfer?renderTransfer():`<p>${busy?t('loading','Loading…'):t('noTransfer','No damage Inventory Transfer for this month. The first operator damage submission starts it.')}</p>`}
        ${renderReports()}${renderHistory()}</section>`;
    }
    function renderTransfer() {
      const dirty=changes().length;
      return `<div class="control-damage-transfer" data-control-damage-transfer><div><h3>${esc(transfer.ref)}</h3><p>${esc(transfer.memo)}</p><p>${esc(transfer.source)} → ${esc(transfer.destination)}</p></div>
        ${action('add',t('add','Add line'),'',!editable())}</div>
        ${review.transfers.length>1?`<p class="control-damage-error">${t('duplicates','More than one transfer exists for this month. Resolve the duplicate records before editing.')}</p>`:''}
        <div class="control-damage-grid"><aside class="control-damage-lines">${draft.map(row=>`<button type="button" data-cd-action="select" data-key="${esc(row.key)}" class="${row.key===selected?'active':''} ${row.removed?'removed':''}"><strong>${esc(row.itemName)}</strong><span>${qty(row.quantity)} ${esc(row.unit)}</span><small>${row.removed?t('removedDraft','Will be removed'):row.added?t('addedDraft','New line'):JSON.stringify(fields(row))!==JSON.stringify(fields(row.original))?t('changedDraft','Changed'):''}</small></button>`).join('')}</aside>
        <section class="control-damage-detail">${editor?renderEditor():renderDetail()}</section></div>
        ${dirty || submission?`<div class="control-damage-save"><label>${t('note','Adjustment note')}<textarea data-cd-note maxlength="500" rows="2" ${busy || submission?'disabled':''}>${esc(note)}</textarea></label>
          <div><span>${dirty} ${t('changes','line changes')}</span>${action('save',submission?t('retrySave','Retry save'):t('save','Save to NetSuite'),'',busy || (!submission && (!dirty || !note.trim() || Boolean(editor) || Boolean(blocked()))))}
          ${action('discard',t('discard','Discard draft'),'',busy || Boolean(submission) || Boolean(blocked()))}</div></div>`:''}`;
    }
    function renderDetail() {
      const row=draft.find(line=>line.key===selected);
      if(!row) {return `<p>${t('select','Select a line to review its details and photos.')}</p>`;}
      return `<h3>${esc(row.itemName)}</h3><p class="control-damage-quantity">${qty(row.quantity)} ${esc(row.unit)}</p>
        <p>${esc(config.reasons.find(reason=>Number(reason.id)===Number(row.reasonId))?.label || row.reason || '—')}</p>
        <p>${esc(row.operatorName || (row.added?t('controlAddition','Control adjustment'):t('manual','NetSuite / Control line')))}${row.reportedAt?` · ${esc(date(row.reportedAt))}`:''}</p>
        ${row.original?.original?`<p>${t('original','Originally reported')}: ${esc(row.original.original.item_name)} · ${qty(row.original.original.quantity)} ${esc(row.original.original.unit)}</p>`:''}
        <div class="control-damage-toolbar">${row.removed?action('undo',t('undo','Undo removal'),'',!editable()):`${action('edit',t('edit','Edit line'),'',!editable())}${action('remove',t('remove','Remove line'),'',!editable())}`}</div>
        <div class="control-damage-photos">${(row.photos || []).map(photo=>`<button type="button" data-cd-action="photo" data-ref="${esc(photo)}"><img ${ctx.photo(photo,{thumbnail:true,lazy:true})} alt="${t('photo','Damage photo')}"></button>`).join('') || `<p>${t('noPhoto','No photo on record')}</p>`}</div>`;
    }
    function renderEditor() {
      return `<h3>${editor.added?t('add','Add line'):t('edit','Edit line')}</h3>
        <label>${t('sku','SKU')}<input data-cd-search autocomplete="off" value="${esc(editor.search)}" ${busy?'disabled':''}></label>
        <div class="control-damage-suggestions" data-cd-suggestions>${suggestionHtml()}</div>
        <div class="control-damage-fields"><label>${t('quantity','Quantity')}<input data-cd-quantity type="number" min="0" step="any" value="${esc(editor.quantity)}" ${busy?'disabled':''}></label>
        <label>${t('unit','Unit')}<select data-cd-unit ${busy?'disabled':''}>${editor.units.map(unit=>`<option value="${esc(unit.id)}" ${String(unit.id)===String(editor.unitId)?'selected':''}>${esc(unit.label)}</option>`).join('')}</select></label></div>
        <label>${t('reason','Damage reason')}<select data-cd-reason ${busy?'disabled':''}><option value="">${t('chooseReason','Choose a reason')}</option>${config.reasons.map(reason=>`<option value="${reason.id}" ${Number(reason.id)===Number(editor.reasonId)?'selected':''}>${esc(reason.label)}</option>`).join('')}</select></label>
        <div class="control-damage-toolbar">${action('apply-line',t('apply','Apply to draft'),'',busy || !validEditor())}${action('cancel-line',t('cancel','Cancel'),'',busy)}</div>`;
    }
    function suggestionHtml() {return suggestions.map(item=>action('choose-sku',`<strong>${esc(item.item_name)}</strong> ${esc(item.item_description || '')}`,`data-id="${item.item_id}"`)).join('');}
    function renderReports() {
      const reports=(review.reports || []).filter(row=>row.status!=='posted');
      if(!reports.length) {return '';}
      return `<details class="control-damage-report-history" ${reports.some(row=>['attention','pending','posting'].includes(row.status))?'open':''}><summary>${t('reportHistory','Saved operator reports requiring attention or removed from the transfer')}</summary>${reports.map(row=>`<article><strong>${esc(row.item_name)}</strong> · ${qty(row.original?.quantity ?? row.quantity)} ${esc(row.original?.unit || row.unit)}<p>${esc(row.status==='removed'?t('removed','Removed from transfer'):row.status==='missing'?t('missing','Transfer not found'):status(row.status))}</p>
        ${row.last_error?`<p class="control-damage-error">${esc(row.last_error)}</p>`:''}${row.status==='attention'?action('retry-report',row.safe_to_retry?t('retryReport','Retry report'):t('recheck','Recheck status'),`data-id="${esc(row.id)}"`,busy):''}
        <div class="control-damage-photos">${(row.photos || []).map(photo=>`<button type="button" data-cd-action="photo" data-ref="${esc(photo)}"><img ${ctx.photo(photo,{thumbnail:true,lazy:true})} alt="${t('photo','Damage photo')}"></button>`).join('')}</div></article>`).join('')}</details>`;
    }
    function renderHistory() {
      return `<details data-control-damage-history class="control-damage-history" open><summary>${t('history','Adjustment history')}</summary>${(review.history || []).map(entry=>`<article><strong>${esc(entry.actor_name || '')}</strong> · ${esc(date(entry.created_at))}<p>${esc(entry.plan.note)}</p><p>${esc(status(entry.status))} · ${entry.plan.updated.length} ${t('edited','edited')}, ${entry.plan.added.length} ${t('added','added')}, ${entry.plan.removed.length} ${t('removedCount','removed')}</p>
        ${historyChanges(entry.plan)}${entry.last_error?`<p class="control-damage-error">${esc(entry.last_error)}</p>`:''}${entry.status==='attention'?action('retry',entry.safe_to_retry?t('retry','Retry sync'):t('recheck','Recheck status'),`data-id="${esc(entry.id)}"`,busy):''}</article>`).join('') || `<p>${t('noHistory','No Control adjustments in this month.')}</p>`}</details>`;
    }
    function historyChanges(plan) {
      const item=line=>plan.labels?.items?.[String(line.item?.id)] || line.item?.refName || transfer?.lines.find(row=>String(row.itemId)===String(line.item?.id))?.itemName || `SKU ${line.item?.id}`;
      const unit=line=>plan.labels?.units?.[String(line.units)] || transfer?.lines.find(row=>String(row.unitId)===String(line.units))?.unit || `UOM ${line.units}`;
      const description=line=>`${esc(item(line))} · ${qty(line.adjustQtyBy)} ${esc(unit(line))}`;
      const updated=plan.updated.map(line=>{const before=plan.before.find(row=>Number(row.line)===Number(line.line));return `<li>${before?description(before):''} → ${description(line)}</li>`;});
      const added=plan.added.map(line=>`<li>${t('added','added')}: ${description(line)}</li>`);
      const removed=plan.removed.map(key=>plan.before.find(line=>Number(line.line)===Number(key))).filter(Boolean).map(line=>`<li>${t('removedCount','removed')}: ${description(line)}</li>`);
      return updated.length+added.length+removed.length?`<details><summary>${t('viewChanges','View line changes')}</summary><ul>${[...updated,...added,...removed].join('')}</ul></details>`:'';
    }
    async function chooseItem(id,{initial=false}={}) {
      const item=await api(`/items/${id}?locationId=${locationId}`);
      editor.itemId=String(item.item_id);editor.itemName=item.item_name;editor.search=item.item_name;editor.units=item.units;
      if(initial && !item.units.some(unit=>String(unit.id)===String(editor.unitId))) {editor.units.push({id:String(editor.unitId),label:editor.unit});}
      if(!initial || !item.units.some(unit=>String(unit.id)===String(editor.unitId))) {editor.unitId=String(item.sales_unit_id || item.units[0]?.id || '');}
      if(!initial) {editor.quantity='';}
      suggestions=[];searchVersion++;
    }
    async function searchItems() {
      const version=++searchVersion;
      try {
        const result=editor?.search.trim()?await api(`/catalog?locationId=${locationId}&search=${encodeURIComponent(editor.search)}`):[];
        if(version!==searchVersion || !editor) {return;}
        suggestions=result;const box=ctx.root.querySelector('[data-cd-suggestions]');if(box) {box.innerHTML=suggestionHtml();}
      } catch(failure) {error=failure.message;ctx.render();}
    }
    async function save() {
      submission ||= {requestId:crypto.randomUUID(),locationId:Number(locationId),month,transferId:Number(transfer.id),revision:transfer.revision,note,changes:changes()};
      command=await api('/adjustments',submission);
      if(command.status==='posted') {submission=null;await refreshReview();}
      else if(['attention','conflict'].includes(command.status)) {submission=null;}
      schedulePoll();
    }
    async function run(name,target) {
      const row=draft.find(line=>line.key===selected);
      if(name==='refresh') {command=null;await refreshReview();schedulePoll();}
      else if(name==='select') {selected=target.dataset.key;editor=null;searchVersion++;}
      else if(name==='photo') {ctx.preview(target.dataset.ref,t('photo','Damage photo'));}
      else if(name==='add') {editor={key:`new-${crypto.randomUUID()}`,added:true,itemId:'',itemName:'',search:'',quantity:'',unitId:'',reasonId:'',units:[]};suggestions=[];}
      else if(name==='edit') {editor={...structuredClone(row),search:row.itemName,units:[]};await chooseItem(row.itemId,{initial:true});}
      else if(name==='choose-sku') {await chooseItem(target.dataset.id);}
      else if(name==='cancel-line') {editor=null;searchVersion++;}
      else if(name==='apply-line') {
        if(!validEditor()) {return;}
        const value={...editor,...fields(editor),itemId:String(editor.itemId),unitId:String(editor.unitId),unit:editor.units.find(unit=>String(unit.id)===String(editor.unitId)).label,photos:editor.photos || []};
        const index=draft.findIndex(line=>line.key===editor.key);if(index<0) {draft.push(value);}else {draft[index]=value;}
        selected=value.key;editor=null;searchVersion++;
      } else if(name==='remove') {row.removed=true;}
      else if(name==='undo') {row.removed=false;}
      else if(name==='discard') {resetDraft();submission=null;}
      else if(name==='save') {await save();}
      else if(name==='retry') {command=await api(`/adjustments/${target.dataset.id}/retry`,{});if(command.status==='posted') {submission=null;await refreshReview();}schedulePoll();}
      else if(name==='retry-report') {await api(`/reports/${target.dataset.id}/retry`,{});await refreshReview();}
    }
    ctx.root.addEventListener('click',async event=>{
      const target=event.target.closest('[data-cd-action]');if(!target) {return;}
      event.stopImmediatePropagation();if(busy || target.disabled) {return;}
      if(['add','edit','remove','undo','apply-line'].includes(target.dataset.cdAction) && !editable()) {return;}
      busy=true;error='';ctx.render();
      try {await run(target.dataset.cdAction,target);} catch(failure) {error=failure.message;}
      finally {busy=false;ctx.render();}
    },true);
    ctx.root.addEventListener('input',event=>{
      if(event.target.matches('[data-cd-note]')) {note=event.target.value;const button=ctx.root.querySelector('[data-cd-action="save"]');if(button) {button.disabled=!note.trim() || busy || Boolean(editor) || Boolean(blocked());}}
      if(editor && event.target.matches('[data-cd-search]')) {editor.search=event.target.value;editor.itemId='';clearTimeout(searchTimer);searchTimer=setTimeout(searchItems,250);}
      if(editor && event.target.matches('[data-cd-quantity]')) {editor.quantity=event.target.value;}
      const button=ctx.root.querySelector('[data-cd-action="apply-line"]');if(button) {button.disabled=busy || !validEditor();}
    });
    ctx.root.addEventListener('change',async event=>{
      if(editor && event.target.matches('[data-cd-unit]')) {editor.unitId=event.target.value;}
      if(editor && event.target.matches('[data-cd-reason]')) {editor.reasonId=event.target.value;}
      const button=ctx.root.querySelector('[data-cd-action="apply-line"]');if(button) {button.disabled=busy || !validEditor();}
      if(event.target.matches('[data-cd-yard],[data-cd-month]')) {
        if(event.target.matches('[data-cd-yard]')) {locationId=event.target.value;}else {month=event.target.value;}
        command=null;transfer=null;await load();
      }
    });
    return {load,render};
  }
  root.MBBSControlDamage={create};
})(window);

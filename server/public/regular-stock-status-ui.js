/* global window */
(() => {
  let model;
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const language=()=>window.MBBS_I18N?.language?.()==='zh-CN'?1:0;
  const t=(en,zh)=>language()?zh:en;
  const label=(dictionary,key)=>dictionary[key]?.[language()]||key;
  const defaults=()=>({unifiedStatus:'active',outcome:'',waitingReason:''});
  function restore(audience) {
    try {
      const saved=JSON.parse(window.localStorage.getItem(`mbbs.${audience}.regularStatusFilters`)||'null');
      if(!saved)return defaults();
      const parsed=model.parseRegularStatusFilters(saved);
      return {unifiedStatus:parsed.unifiedStatus,outcome:parsed.outcome,waitingReason:parsed.waitingReason};
    }catch{return defaults();}
  }
  function save(audience,state) {
    window.localStorage.setItem(`mbbs.${audience}.regularStatusFilters`,JSON.stringify({unifiedStatus:state.unifiedStatus,outcome:state.outcome,waitingReason:state.waitingReason}));
  }
  function params(state,params=new URLSearchParams()) {
    for(const key of ['unifiedStatus','outcome','waitingReason'])if(state[key])params.set(key,state[key]);
    return params;
  }
  function render(request) {
    if(!model||!request)return '';
    const s=model.regularStockStatusSummary(request),parts=[label(model.REGULAR_STATUS_DETAILS,s.detail)];
    const counts=Object.entries(s.counts).filter(([,count])=>Number(count)>0);
    if(counts.length>1)parts.push(counts.map(([key,count])=>`${count} ${label(model.REGULAR_STATUSES,key)}`).join(' · '));
    if(s.detail==='mixed')parts.push(s.outcomes.map(key=>label(model.REGULAR_OUTCOMES,key)).join(' · '));
    return `<span class="regular-status-summary"><span class="regular-status-badges"><span class="stock-request-pill ${esc(s.status)}" data-regular-main-status="${esc(s.status)}">${esc(label(model.REGULAR_STATUSES,s.status))}</span>
      ${s.waitingReasons.map(reason=>`<span class="stock-request-pill stock-request-waiting" data-stock-request-waiting="${esc(reason)}">${esc(label(model.REGULAR_WAITING_REASONS,reason))}</span>`).join('')}
      ${s.needsAttention?`<span class="stock-request-pill attention" title="${esc(s.attentionReasons.map(reason=>label(model.REGULAR_STATUS_DETAILS,reason)).join(' · '))}">${t('Needs attention','需要关注')}</span>`:''}</span>
      <small class="regular-status-detail">${esc(parts.join(' · '))}</small></span>`;
  }
  function filters(state,audience,{disabled=false}={}) {
    if(!model)return '';
    const attribute=audience==='waitlist'?'data-waitlist-status-filter':`data-${audience}-stock-filter`;
    const select=(key,title,options)=>`<label class="regular-status-filter"><span>${title}</span><select ${attribute}="${key}" aria-label="${title}" ${disabled?'disabled':''}>${Object.entries(options).map(([value,text])=>`<option value="${value}" ${state[key]===value?'selected':''}>${esc(text)}</option>`).join('')}</select></label>`;
    const statuses=Object.keys(model.REGULAR_STATUSES);
    const selected=state.unifiedStatus==='active'?statuses.filter(key=>!['completed','closed'].includes(key))
      :state.unifiedStatus==='all'?[]:String(state.unifiedStatus||'').split(',').filter(Boolean);
    const statusMenu=`<details class="stock-request-yard-filter" data-yard-filter="unifiedStatus" ${audience==='sales'?'data-sales-multi-filter="unifiedStatus"':''}>
      <summary aria-label="${t('Status','状态')}">${t('Status','状态')}${selected.length?` (${selected.length})`:t(': All',': 所有')}</summary>
      <div role="group" aria-label="${t('Status','状态')}">${statuses.map(key=>`<label><input type="checkbox" name="unifiedStatus" ${attribute}="unifiedStatus" value="${key}" ${selected.includes(key)?'checked':''} ${disabled?'disabled':''}> ${esc(label(model.REGULAR_STATUSES,key))}</label>`).join('')}
      <div class="stock-request-filter-actions"><button type="button" data-yard-filter-clear="unifiedStatus" ${disabled?'disabled':''}>${t('Clear selection','清除选择')}</button><button class="primary" type="button" data-yard-filter-apply="unifiedStatus" ${disabled?'disabled':''}>${t('Apply','应用')}</button></div></div></details>`;
    return (audience==='waitlist'?select('unifiedStatus',t('Status','状态'),{active:t('All active','所有进行中'),all:t('All statuses','所有状态'),...Object.fromEntries(statuses.map(key=>[key,label(model.REGULAR_STATUSES,key)]))}):statusMenu)
      +select('outcome',t('Outcome','处理结果'),{'':t('All outcomes','所有结果'),...Object.fromEntries(['rejected','cancelled','closed_manually'].map(key=>[key,label(model.REGULAR_OUTCOMES,key)]))})
      +select('waitingReason',t('Supply waiting','供货等待'),{'':t('All supply reasons','所有供货原因'),...Object.fromEntries(Object.keys(model.REGULAR_WAITING_REASONS).map(key=>[key,label(model.REGULAR_WAITING_REASONS,key)]))});
  }
  function typeFilter(selected) {
    return `<label><span>${t('Request type','申请类型')}</span><select data-scm-stock-filter="requestTypeFilter">${Object.entries({'':t('All Regular','所有常规'),pickup:t('Pickup','自取'),delivery:t('Delivery','送货'),stocking:t('Stocking','备货'),backorder:t('Backorder','欠货'),other:t('Other regular','其他常规申请')}).map(([value,text])=>`<option value="${value}" ${selected===value?'selected':''}>${text}</option>`).join('')}</select></label>`;
  }
  function changed(state,key,audience) {
    if(key==='unifiedStatus'&&!state.unifiedStatus)state.unifiedStatus='all';
    if(key==='outcome'&&state.outcome&&state.unifiedStatus==='active')state.unifiedStatus='closed';
    save(audience,state);
  }
  window.RegularStockStatus={ready:import('/regular-stock-status.js?v=20261021-pending-po').then(value=>{model=value;}),render,filters,params,defaults,restore,save,changed,typeFilter};
})();

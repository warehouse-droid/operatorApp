(() => {
  const ui=()=>window.RegularStockUI;
  const units=[['pallets','toPlt','PLT'],['layers','toLyr','LYR'],['sections','toSec','SEC'],['pieces','toPcs','PCS']];
  const yards=[{id:1,name:'3445'},{id:28,name:'2967'},{id:15,name:'12441'},{id:26,name:'150'}];
  let editor=null;
  const quantity=line=>units.some(([,conversion])=>line[conversion]>0)
    ? units.reduce((total,[field,conversion])=>total+Number(line[field]||0)*Number(line[conversion]||0),0) : Number(line.salesQty||0);
  const payload=line=>({...(line.id?{id:line.id}:{}),itemId:line.itemId,sourceLocationId:line.sourceLocationId,
    ...Object.fromEntries(units.some(([,conversion])=>line[conversion]>0)
      ? units.filter(([,conversion])=>line[conversion]>0).map(([field])=>[field,line[field]||0]) : [['salesQty',line.salesQty||0]])});

  function rowHtml(line,index,destination) {
    const {esc,number,t}=ui(),fields=units.filter(([,conversion])=>line[conversion]>0);
    return `<article class="pickup-line" data-pickup-row="${index}"><header><div><strong>${esc(line.itemName)}</strong><p>${esc(line.itemDescription||'')}</p></div>${!line.id?`<button data-pickup-remove="${index}" type="button">${t('Remove','移除')}</button>`:''}</header>
      <div class="pickup-fields"><label>${t('Source yard','发货货场')}<select data-pickup-field="sourceLocationId">${yards.filter(yard=>yard.id!==destination).map(yard=>`<option value="${yard.id}" ${yard.id===Number(line.sourceLocationId)?'selected':''}>${yard.name}</option>`).join('')}</select></label>
      ${(fields.length?fields:[['salesQty',null,line.salesUom]]).map(([field,conversion,label])=>`<label>${esc(label)}${conversion?` × ${number(line[conversion])}`:''}<input data-pickup-field="${field}" type="number" min="0" max="1000000000" step="any" value="${esc(line[field]||0)}" /></label>`).join('')}</div>
      <p data-pickup-total></p></article>`;
  }

  function drawRoutes(state) {
    const {esc,number,t}=ui(),groups=new Map();
    state.lines.forEach(line=>{
      const source=Number(line.sourceLocationId);
      if(!groups.has(source))groups.set(source,new Map());
      const items=groups.get(source),item=items.get(line.itemId)||{qty:0,toPlt:line.toPlt};
      item.qty+=quantity(line);items.set(line.itemId,item);
    });
    state.dialog.querySelector('[data-pickup-routes]').innerHTML=[...groups].map(([source,items])=>{
      const manual=[...items.values()].some(item=>!(item.toPlt>0));
      const automatic=[...items.values()].reduce((sum,item)=>sum+(item.toPlt>0?Math.ceil(item.qty/item.toPlt):0),0);
      const value=state.pallets[source] ?? (manual?'':automatic);
      return `<label>${esc(yards.find(yard=>yard.id===source)?.name)} → ${esc(state.request.destinationName)} · PALLET${manual?' *':''}<input data-pickup-pallet="${source}" type="number" min="0" max="1000000000" step="any" required value="${esc(value)}" /><small>${manual?t('Enter the total pallet quantity for this TO.','请输入此调货单的总托盘数量。'):t(`Calculated: ${number(automatic)}. Adjust if needed.`,`计算数量：${number(automatic)}。可按需要调整。`)}</small></label>`;
    }).join('');
    for(const row of state.dialog.querySelectorAll('[data-pickup-row]')){
      const line=state.lines[Number(row.dataset.pickupRow)];
      row.querySelector('[data-pickup-total]').textContent=`${t('Transfer quantity','调货数量')}: ${number(quantity(line))} ${line.salesUom}`;
    }
  }

  function drawLines(state) {
    state.dialog.querySelector('[data-pickup-lines]').innerHTML=state.lines.map((line,index)=>rowHtml(line,index,state.request.destinationLocationId)).join('');
    drawRoutes(state);
  }

  function error(state,error) {
    const output=state.dialog.querySelector('[data-pickup-error]');output.textContent=error.message;output.hidden=false;
  }

  async function search(state) {
    const term=state.dialog.querySelector('[data-pickup-search]').value.trim(),generation=++state.searchGeneration;
    const list=state.dialog.querySelector('[data-pickup-results]');list.replaceChildren();
    if(term.length<2)return;
    try {
      const result=await state.api(`/api/scm/stock-request-items?search=${encodeURIComponent(term)}&limit=20`);
      if(editor!==state || generation!==state.searchGeneration)return;
      state.results=result.items.filter(item=>item.itemCode?.trim().toUpperCase()!=='PALLET');
      list.innerHTML=state.results.length?state.results.map((item,index)=>`<button type="button" data-pickup-add="${index}"><strong>${ui().esc(item.itemCode)}</strong><span>${ui().esc(item.description)}</span></button>`).join(''):`<p>${ui().t('No matching items','没有匹配的商品')}</p>`;
    } catch(caught){if(editor===state&&generation===state.searchGeneration)error(state,caught);}
  }

  async function add(state,index) {
    const item=state.results[index];
    if(!item)return;
    await window.RegularStockDialog.withBusy(ui().t('Loading item quantities and yard availability…','正在载入商品数量和货场库存…'),async()=>{
      const availability=await state.api(`/api/scm/stock-request-items/${item.itemId}/availability/refresh`,{method:'POST',body:'{}'});
      const source=availability.yards.filter(yard=>yard.locationId!==state.request.destinationLocationId)
        .sort((a,b)=>b.requestableAvailable-a.requestableAvailable)[0];
      const line={...availability.item,itemName:availability.item.itemCode,itemDescription:availability.item.description,sourceLocationId:source.locationId};
      const available=units.filter(([,conversion])=>line[conversion]>0);
      line[available.length?available[available.length-1][0]:'salesQty']=1;
      state.lines.push(line);drawLines(state);
      state.searchGeneration++;state.results=[];
      state.dialog.querySelector('[data-pickup-search]').value='';state.dialog.querySelector('[data-pickup-results]').replaceChildren();
    });
  }

  async function convert(state) {
    const input=state.request.regular.pickupTransfer?{}:{expectedRevision:state.request.revision,lines:state.lines.map(payload),
      palletQuantities:Object.fromEntries([...state.dialog.querySelectorAll('[data-pickup-pallet]')].map(field=>[field.dataset.pickupPallet,field.value]))};
    if(!state.dialog.querySelector('form').reportValidity())return;
    const operation=window.RegularStockDialog.begin(ui().t('Checking quantities, safety stock and TO routes…','正在检查数量、安全库存和调货路线…'));
    let complete=false;
    try {
      const path=`/api/scm/stock-requests/${state.request.id}`;
      const preview=await state.api(`${path}/pickup-preview`,{method:'POST',body:JSON.stringify(input)});
      const review=preview.evidence?.lines?.map((entry,index)=>`${preview.lines[index]?.itemName}: ${ui().t('After shipment','发货后')} ${ui().number(entry.remainingQuantity)} ${entry.unit||''}; ${ui().t('Safety stock required','所需安全库存')} ${ui().number(entry.safetyQuantity)} ${entry.unit||''}; ${ui().t('Below safety by','低于安全库存')} ${ui().number(entry.shortfallQuantity)} ${entry.unit||''}`).join('\n');
      const confirmation={...preview,action:{...preview.action,review}};
      if(!await operation.confirm(confirmation))return;
      operation.wait(ui().t('Creating Transfer Orders in NetSuite. Please wait…','正在 NetSuite 建立调货单，请稍候…'));
      await state.api(`${path}/pickup-convert`,{method:'POST',body:JSON.stringify({...input,confirmationToken:preview.confirmationToken})});
      complete=true;
      await state.onComplete();
    } catch(caught) {
      // Read the durable state after a timeout or partial failure; only the saved conversion may resume.
      try {
        const request=await state.api(`/api/scm/stock-requests/${state.request.id}`);
        if(request.regular.pickupTransfer){state.request=request;showResume(state);}
      } catch { /* Keep the original, precise conversion error visible. */ }
      error(state,caught);
    } finally {
      operation.close();
      if(complete)close(state);
    }
  }

  function showResume(state) {
    state.dialog.querySelector('[data-pickup-edit]').hidden=true;
    state.dialog.querySelector('[data-pickup-history]').innerHTML=ui().stockingResult(state.request);
    state.dialog.querySelector('[data-pickup-submit]').textContent=ui().t('Review saved TO action','查看已保存的调货操作');
  }

  function close(state) {
    clearTimeout(state.timer);state.searchGeneration++;state.dialog.close();state.dialog.remove();editor=null;
  }

  function open(request,{api,onComplete}) {
    if(editor||window.RegularStockDialog.isBusy())return;
    const {esc,t}=ui(),dialog=document.createElement('dialog');dialog.className='scm-pickup-dialog';
    dialog.setAttribute('aria-labelledby','pickupTitle');
    const state={request,api,onComplete,dialog,lines:request.lines.filter(line=>['submitted','approved'].includes(line.status)).map(line=>({...line})),pallets:{},results:[],searchGeneration:0};
    dialog.innerHTML=`<form><header><div><h2 id="pickupTitle">${t('Convert Stocking request to TO','将备货申请转换为调货单')}</h2><p>${esc(request.requestRef)} · ${t('Destination','目的货场')} ${esc(request.destinationName)}</p></div><button type="button" data-pickup-close aria-label="${t('Close','关闭')}">×</button></header>
      <p>${t('Review every item and quantity. SCM approval will create one Transfer Order per source yard.','请审核所有商品和数量。SCM 批准后，每个发货货场将建立一张调货单。')}</p>
      <p data-pickup-error class="stock-request-error" role="alert" hidden></p><div data-pickup-history></div>
      <div data-pickup-edit><div data-pickup-lines></div><label class="pickup-search">${t('Add an item','添加商品')}<input data-pickup-search type="search" autocomplete="off" placeholder="${t('Type an item code or description…','输入商品编号或描述…')}" aria-controls="pickupResults" /></label><div id="pickupResults" data-pickup-results aria-live="polite"></div>
      <h3>${t('PALLET quantities per TO','每张调货单的托盘数量')}</h3><div data-pickup-routes class="pickup-fields"></div></div>
      <footer><button data-pickup-close type="button">${t('Cancel','取消')}</button><button data-pickup-submit type="submit" class="primary">${t('Review and convert to TO','审核并转换为调货单')}</button></footer></form>`;
    editor=state;document.body.append(dialog);drawLines(state);if(request.regular.pickupTransfer)showResume(state);
    dialog.addEventListener('cancel',event=>{event.preventDefault();if(!window.RegularStockDialog.isBusy())close(state);});
    dialog.addEventListener('input',event=>{
      const field=event.target;if(window.RegularStockDialog.isBusy())return;
      if(field.hasAttribute('data-pickup-search')){clearTimeout(state.timer);state.searchGeneration++;state.timer=setTimeout(()=>search(state),220);return;}
      if(field.dataset.pickupPallet){state.pallets[field.dataset.pickupPallet]=field.value;return;}
      if(field.dataset.pickupField){const line=state.lines[Number(field.closest('[data-pickup-row]').dataset.pickupRow)];line[field.dataset.pickupField]=Number(field.value);drawRoutes(state);}
    });
    dialog.addEventListener('keydown',event=>{
      if(event.key==='ArrowDown'&&event.target.hasAttribute('data-pickup-search')){event.preventDefault();dialog.querySelector('[data-pickup-add]')?.focus();}
    });
    dialog.addEventListener('click',async event=>{
      const button=event.target.closest('button');if(!button||button.disabled||window.RegularStockDialog.isBusy())return;
      if(button.hasAttribute('data-pickup-close'))return close(state);
      if(button.hasAttribute('data-pickup-remove')){state.lines.splice(Number(button.dataset.pickupRemove),1);drawLines(state);}
      if(button.hasAttribute('data-pickup-add')){try{await add(state,Number(button.dataset.pickupAdd));}catch(caught){error(state,caught);}}
    });
    dialog.querySelector('form').addEventListener('submit',event=>{event.preventDefault();if(!window.RegularStockDialog.isBusy())void convert(state);});
    dialog.showModal();dialog.querySelector('[data-pickup-field]')?.focus();
  }
  window.RegularPickupUI={open};
})();

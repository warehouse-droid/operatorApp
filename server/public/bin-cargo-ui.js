(() => {
  'use strict';
  const esc=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const option=(value,label,current,disabled=false)=>`<option value="${esc(value)}" ${value===current?'selected':''} ${disabled?'disabled':''}>${esc(label)}</option>`;
  const blank=()=>({description:'',weightLbs:'',pickup:null,dropoff:{kind:'destination'}});
  function locationFields(item,key,data) {
    const place=item[key],value=place?.kind==='yard'?place.id:place?.kind || '';
    return `<label>${key==='pickup'?'Pickup':'Drop-off'}<select data-location="${key}" required>
      ${option('','Choose location',value)}${key==='dropoff'?option('destination','Same as bin destination',value):''}
      ${data.yards.map(y=>option(y.id,`Yard ${y.yardCode}`,value)).join('')}${option('address','Custom address',value)}</select></label>
      ${value==='address'?`<label>${key==='pickup'?'Pickup':'Drop-off'} address<input data-address="${key}" maxlength="500" value="${esc(place.address)}" required /></label>`:''}`;
  }
  function rowFields(item,index,data,existing=false) {
    return `<fieldset data-cargo-row="${index}" class="bin-cargo-row"><legend>${esc(item.ordered?'Ordered material':existing?'Custom Order':'Cargo')}</legend>
      ${item.ordered || existing ? `<p><strong>${esc(item.description)}</strong>${item.quantityMilliYards?` · ${Number(item.quantityMilliYards)/1000} yd³`:''} · ${esc(item.weightLbs)} lb</p>`
      : `<label>Description<input data-description maxlength="500" value="${esc(item.description)}" required /></label>
        <label>Weight (lb)<input data-weight type="number" min="0.001" max="1000000" step="any" value="${esc(item.weightLbs)}" required /></label>`}
      <div class="bin-cargo-locations">${locationFields(item,'pickup',data)}${locationFields(item,'dropoff',data)}</div>
      ${!item.ordered && !existing && data.mode==='materials'?'<button type="button" data-remove-material>Remove material</button>':''}</fieldset>`;
  }
  function resolved(place,data) {
    if (place?.kind==='destination') return data.destination;
    return place?.kind==='yard'?data.yards.find(y=>y.id===place.id):place;
  }
  function preview(state,data) {
    const items=state.mode==='materials'?state.materials:state.mode==='none'?[]:[state.custom];
    const physical=data.steps.filter(s=>!s.actionCode.startsWith('cargo_'));
    const final=physical.at(-1),rows=physical.slice(0,-1).map(s=>({label:s.displayName,address:s.location?.address}));
    if (!physical.length) rows.push({label:'Pick up empty bin',address:'Choose the bin in Plan'});
    for (const item of items) rows.push({label:`Pick up ${item.description || 'cargo'}`,address:resolved(item.pickup,data)?.address || 'Choose pickup'});
    for (const item of items.filter(i=>i.dropoff?.kind!=='destination')) rows.push({label:`Drop off ${item.description || 'cargo'}`,address:resolved(item.dropoff,data)?.address || 'Choose drop-off'});
    rows.push({label:final?.displayName || 'Deliver bin',address:data.destination.address,
      cargo:items.filter(i=>i.dropoff?.kind==='destination').map(i=>i.description || 'cargo').join(', ')});
    return rows.map((row,index)=>`${index && rows[index-1].address!==row.address?'<li class="bin-cargo-travel">Travel</li>':''}
      <li><strong>${esc(row.label)}${row.cargo?` · ${esc(row.cargo)}`:''}</strong><span>${esc(row.address)}</span></li>`).join('');
  }
  async function mount(container,visitId,{headers,editable,workflowEditing=false}) {
    container.textContent='Loading cargo route…';
    const response=await fetch(`/api/mbt/planning/workflows/${encodeURIComponent(visitId)}/cargo`,{headers:headers()});
    const data=await response.json();if (!response.ok) throw new Error(data.error || 'Cargo details could not be loaded.');
    const state={...data.cargo,mode:data.cargo.mode==='custom'?data.cargo.custom.source:data.cargo.mode};
    const canEdit=editable && (data.editable || (workflowEditing && data.role==='collection'));
    const required=Boolean(data.orderedMaterials.length);
    function render() {
      data.mode=state.mode;
      container.innerHTML=`<div class="bin-cargo-form"><h3>Material & cargo route</h3>
        ${required?'<p data-cargo-required>Front Desk materials are required. Select a pickup for every material, then save the route.</p>':'<p>Multiple materials, or one Custom Order per bin.</p>'}
        <p data-cargo-destination>Bin destination: ${esc(data.destination.address)}</p>
        ${!canEdit?`<p>${esc(data.reason || 'Enter Edit mode to change the cargo route.')}</p>`:''}
        <fieldset ${canEdit?'':'disabled'} class="bin-cargo-controls">${required?'':`<label>Cargo<select name="cargoMode">
          ${option('none','No cargo',state.mode,Boolean(data.orderedMaterials.length))}${option('materials','Materials',state.mode)}
          ${option('existing','Existing Custom Order',state.mode,Boolean(data.orderedMaterials.length))}
          ${option('one_off','One-off cargo',state.mode,Boolean(data.orderedMaterials.length))}</select></label>`}
          ${state.mode==='existing'?`<label>Custom Order<select name="customOrderId" required>${option('','Choose an open order',state.custom?.orderId)}
            ${data.customOrders.map(o=>option(o.id,`${o.refNumber} · ${o.orderDetails}`,state.custom?.orderId)).join('')}</select></label>`:''}
          ${state.mode==='materials'?state.materials.map((item,i)=>rowFields(item,i,data)).join(''):
            state.mode!=='none'?rowFields(state.custom,0,data,state.mode==='existing'):''}
          ${state.mode==='materials'?`<button type="button" data-add-material ${state.materials.length>=20?'disabled':''}>Add material</button>`:''}
        </fieldset><h4>Route</h4><ol data-cargo-preview>${preview(state,data)}</ol>
        </div>`;
    }
    function itemFor(target) {
      return state.mode==='materials'?state.materials[Number(target.closest('[data-cargo-row]')?.dataset.cargoRow)]:state.custom;
    }
    container.oninput=event=>{
      const target=event.target,item=itemFor(target);if (!item) return;
      if (target.hasAttribute('data-description')) item.description=target.value;
      if (target.hasAttribute('data-weight')) item.weightLbs=target.value;
      if (target.dataset.address) item[target.dataset.address].address=target.value;
      container.querySelector('[data-cargo-preview]').innerHTML=preview(state,data);
    };
    container.onchange=event=>{
      const target=event.target;
      if (target.name==='cargoMode') {
        state.mode=target.value;state.custom=state.mode==='one_off'||state.mode==='existing'?{...blank(),source:state.mode}:null;
        if (state.mode==='materials' && !state.materials.length) state.materials.push(blank());
      } else if (target.name==='customOrderId') {
        const order=data.customOrders.find(o=>o.id===target.value);
        state.custom=order?{source:'existing',orderId:order.id,expectedUpdatedAt:order.updatedAt,
          description:`${order.refNumber} · ${order.orderDetails}`,weightLbs:order.weightLbs,
          pickup:{kind:'address',address:order.pickupLocation},dropoff:{kind:'address',address:order.dropoffLocation}}:{...blank(),source:'existing'};
      } else if (target.dataset.location) {
        const value=target.value;itemFor(target)[target.dataset.location]=value==='address'?{kind:'address',address:''}:
          value==='destination'?{kind:'destination'}:value?{kind:'yard',id:value}:null;
      } else return;
      render();
    };
    container.onclick=event=>{
      if (event.target.closest('[data-add-material]')) {state.materials.push(blank());render();}
      const remove=event.target.closest('[data-remove-material]');
      if (remove) {state.materials.splice(Number(remove.closest('[data-cargo-row]').dataset.cargoRow),1);render();}
    };
    function value() {
      return state.mode==='materials'?{mode:'materials',materials:state.materials}:
        state.mode==='none'?{mode:'none'}:{mode:'custom',custom:state.custom};
    }
    async function save(key,withPlanLeases,onSaved) {
      if (!canEdit) throw new Error(data.reason || 'This cargo route is locked.');
      await withPlanLeases(data.plans,async plans=>{
        const response=await fetch(`/api/mbt/planning/workflows/${encodeURIComponent(visitId)}/cargo`,{method:'POST',
          headers:{...headers(),'Content-Type':'application/json','Idempotency-Key':key},
          body:JSON.stringify({cargo:value(),expectedRevision:data.revision,expectedVisits:data.expectedVisits,plans})});
        const result=await response.json();if (!response.ok) throw new Error(result.error || 'The cargo route could not be saved.');
        await onSaved(result);
      });
    }
    function updatePreview(steps,destination) {
      data.steps=steps;data.destination=destination;
      container.querySelector('[data-cargo-preview]').innerHTML=preview(state,data);
      container.querySelector('[data-cargo-destination]').textContent=`Bin destination: ${destination.address}`;
    }
    render();
    return {data,initialDestination:data.destination,editable:canEdit,value,save,updatePreview};
  }
  window.BinCargoUI={mount};
})();

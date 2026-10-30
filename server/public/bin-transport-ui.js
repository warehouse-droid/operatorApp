/* global escapeHtml */
(() => {
  const escape=value=>escapeHtml(String(value ?? ''));
  async function request(path,context,body,method='GET') {
    const response=await fetch(`/api/mbt${path}`,{method,headers:{...context.headers(),...(body?{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json();if (!response.ok) {throw new Error(data.error || 'Transport planning could not be saved.');}return data;
  }
  function quantityRows(data,trip) {
    return data.lines.map(line=>{
      const existing=trip?.allocations.find(row=>row.lineKey===line.key),maximum=Number(line.remaining)+Number(existing?.quantity || 0);
      return `<tr><td>${escape(line.description)}<br><small>${escape(line.unit)}</small></td><td>${escape(line.remaining)}</td>
        <td>${escape(line.planned)}</td><td>${escape(line.delivered)}</td><td><input type="number" step="0.000001" min="0" max="${maximum}"
          data-line-key="${escape(line.key)}" aria-label="Trip quantity: ${escape(line.description)}" value="${escape(existing?.quantity || 0)}"></td></tr>`;
    }).join('');
  }
  function assetLabel(asset) {
    const value=asset.availability;
    return `${asset.asset_code} · ${asset.type_code} · ${value?.available
      ? value.projected ? `${value.location.address} after ${value.predecessorReference} (${new Date(value.availableAt).toLocaleString('en-CA',{timeZone:'America/Toronto'})})`
        : value.location.address : value?.reason || 'Unavailable'}`;
  }
  function weightSummary(data,form,asset) {
    const selected=[...form.querySelectorAll('[data-line-key]')].filter(input=>Number(input.value)>0)
      .map(input=>({line:data.lines.find(row=>row.key===input.dataset.lineKey),quantity:Number(input.value)}));
    const weight=selected.reduce((sum,row)=>sum+Math.max(0,Number(row.line?.lineWeight)||0)*row.quantity/Number(row.line?.quantity || 1),0);
    const missing=selected.some(row=>!(Number(row.line?.lineWeight)>0));
    const format=value=>value.toLocaleString('en-CA',{maximumFractionDigits:3});
    const cargo=selected.length?`${missing?'Known':'Calculated'} cargo weight: ${format(weight)} lb.${missing?' Enter the total cargo weight; some selected items have no weight.':''}`:'Select quantities to calculate cargo weight.';
    const maximum=Number(asset?.maximum_payload_kg)*2.2046226218;
    return cargo+(asset?Number.isFinite(maximum) && maximum>0?` Bin payload capacity: ${format(maximum)} lb.`:' Bin maximum payload is not configured.':'');
  }
  function formHtml(data,trip) {
    const yardOptions=data.yards.map(yard=>`<option value="${escape(yard.id)}">${escape(yard.code)}</option>`).join('');
    const materials=['aggregate','frontdesk_aggregate'].includes(data.source.kind);
    return `<p>${escape(data.source.ref)}${trip?` · Trip ${trip.tripNumber}`:''} · ${escape(data.source.customer)}</p>
      <p>Delivery: ${escape(data.source.address)}<br>Order window: ${escape(data.source.windowStart || 'Any time')} – ${escape(data.source.windowEnd || '')}</p>
      <table><thead><tr><th>Item</th><th>Remaining</th><th>Planned</th><th>Delivered</th><th>This trip</th></tr></thead><tbody>${quantityRows(data,trip)}</tbody></table>
      <label>Bin<select name="assetId" required><option value="">Choose bin</option>${data.assets.filter(asset=>asset.availability?.available).map(asset=>`<option value="${escape(asset.asset_id)}">${escape(assetLabel(asset))}</option>`).join('')}</select></label>
      <label>Cargo weight (lb)<input name="weightLbs" type="number" min="0.001" max="1000000" step="0.001" value="${escape(trip?.weightLbs || '')}" placeholder="Enter when item weights are missing"></label>
      <p data-weight-summary aria-live="polite"></p>
      ${materials?`<label>Material pickup<select name="pickupYard" required><option value="">Choose pickup yard</option>${yardOptions}<option value="custom">Custom address</option></select></label>
        <label data-pickup-address hidden>Pickup address<input name="pickupAddress" maxlength="1000"></label>`
      :`<p>Pickup: ${escape(data.source.sourceAddress || data.source.pickupLocations.join(', '))}</p>`}
      <label>After cargo drop<select name="returnKind"><option value="yard">Return empty bin</option><option value="delivery">Continue to BIN delivery</option></select></label>
      <label data-return-yard>Return empty bin to<select name="returnYard" required><option value="">Choose return yard</option>${yardOptions}</select></label>
      <label data-linked-delivery hidden>Existing BIN delivery<select name="deliveryVisitId"><option value="">Choose delivery with this bin</option>
        ${(data.deliveries || []).map(delivery=>`<option value="${escape(delivery.visitId)}" data-asset="${escape(delivery.assetId)}">${escape(delivery.reference)} · ${escape(delivery.assetCode)}</option>`).join('')}</select></label>
      <p data-route-preview>Pick up empty bin → pick up cargo → unload cargo → return empty bin.</p>
      <p data-message role="status"></p><footer><button type="submit">Save route</button>${trip?'<button type="button" data-cancel-trip>Cancel trip</button>':''}</footer>`;
  }
  async function open(sourceRef,context,{tripId=null}={}) {
    const params=new URLSearchParams({sourceRef,planDate:context.planDate,...(tripId?{tripId}:{})});
    const data=await request(`/planning/transport/options?${params}`,context),trip=data.trips.find(row=>row.tripId===tripId);
    const dialog=document.createElement('dialog');dialog.className='bin-workflow-dialog bin-transport-dialog';dialog.setAttribute('aria-label','Plan transport');
    dialog.innerHTML=`<header><h2>Plan transport</h2><button type="button" data-close>Close</button></header><form>${formHtml(data,trip)}</form>
      ${data.trips.length?`<details><summary>Trips for ${escape(sourceRef)}</summary><ul>${data.trips.map(row=>`<li>Trip ${row.tripNumber} · ${escape(row.status)}
        <button type="button" data-edit-trip="${escape(row.tripId)}">${row.status==='ready'?'Edit':'View'}</button></li>`).join('')}</ul></details>`:''}`;
    const form=dialog.querySelector('form'),field=name=>form.elements.namedItem(name),message=dialog.querySelector('[data-message]');
    if (trip) {
      field('assetId').value=trip.assetId;field('returnYard').value=trip.route.returnDestination.location?.id || '';
      field('returnKind').value=trip.route.returnDestination.kind;field('deliveryVisitId').value=trip.route.returnDestination.visitId || '';
      if (field('pickupYard')) {
        field('pickupYard').value=trip.route.pickup.kind==='yard'?trip.route.pickup.id:'custom';
        field('pickupAddress').value=trip.route.pickup.address;
      }
    }
    const editable=context.canEdit!==false && !data.sourceChanged && (!trip || (trip.status==='ready' && !trip.planId && !trip.actualStartedAt));
    if (!editable) {
      form.querySelectorAll('input,select,button').forEach(element=>{element.disabled=true;});
      const cancel=form.querySelector('[data-cancel-trip]');
      if (cancel && context.canEdit!==false && trip.status==='ready' && !trip.planId && !trip.actualStartedAt) {cancel.disabled=false;}
      message.textContent=data.sourceChanged?'The source order changed. Cancel unplanned trips and refresh before planning again.':'Unplan this trip to edit. Started and completed trips keep their route and quantities.';
    }
    window.BinAssetSearch.attach(field('assetId'));
    function preview() {
      const asset=data.assets.find(row=>row.asset_id===field('assetId').value);
      dialog.querySelector('[data-weight-summary]').textContent=weightSummary(data,form,asset);
      const custom=field('pickupYard')?.value==='custom',address=dialog.querySelector('[data-pickup-address]');
      if (address) {address.hidden=!custom;field('pickupAddress').required=custom;}
      const linked=field('returnKind').value==='delivery';dialog.querySelector('[data-return-yard]').hidden=linked;dialog.querySelector('[data-linked-delivery]').hidden=!linked;
      field('returnYard').required=!linked;field('deliveryVisitId').required=linked;
      for (const option of field('deliveryVisitId').options) {if (option.dataset.asset) {option.disabled=option.dataset.asset!==field('assetId').value;}}
      if (asset) {dialog.querySelector('[data-route-preview]').textContent=`Empty bin: ${assetLabel(asset)} → cargo pickup → ${data.source.address} → ${linked?'linked BIN delivery (including its ordered cargo)':'empty bin return'}.`;}
    }
    form.onchange=preview;form.oninput=preview;preview();
    form.onsubmit=async event=>{
      event.preventDefault();const button=form.querySelector('[type="submit"]');button.disabled=true;message.textContent='Saving route…';
      try {
        const allocations=[...form.querySelectorAll('[data-line-key]')].filter(input=>Number(input.value)>0)
          .map(input=>({lineKey:input.dataset.lineKey,quantity:input.value}));
        const pickup=field('pickupYard')?.value==='custom'?{kind:'address',address:field('pickupAddress').value}
          :{kind:'yard',id:field('pickupYard')?.value};
        await request('/planning/transport/trips',context,{sourceRef,planDate:context.planDate,expectedSourceRevision:data.revision,
          sourceFingerprint:data.fingerprint,assetId:field('assetId').value,allocations,weightLbs:field('weightLbs').value || undefined,
          pickup,returnDestination:field('returnKind').value==='delivery'?{kind:'delivery',visitId:field('deliveryVisitId').value}
            :{kind:'yard',id:field('returnYard').value},...(trip?{tripId,expectedRevision:trip.revision}:{})},'POST');
        await context.onSaved();dialog.close();
      } catch(error) {message.textContent=error.message;button.disabled=false;}
    };
    dialog.querySelector('[data-cancel-trip]')?.addEventListener('click',async event=>{
      event.target.disabled=true;
      try {await request(`/planning/transport/trips/${tripId}/cancel`,context,{expectedRevision:trip.revision},'POST');await context.onSaved();dialog.close();}
      catch(error) {message.textContent=error.message;event.target.disabled=false;}
    });
    for (const button of dialog.querySelectorAll('[data-edit-trip]')) {button.onclick=()=>{
      open(sourceRef,context,{tripId:button.dataset.editTrip}).then(()=>dialog.close()).catch(error=>{message.textContent=error.message;});
    };}
    dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.onclose=()=>dialog.remove();document.body.append(dialog);dialog.showModal();
  }
  window.BinTransportUI={open};
})();

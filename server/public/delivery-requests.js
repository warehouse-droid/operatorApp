/* global requireDispatchLogin, dispatchLogout, readDispatchAuthToken */
(() => {
  const root = document.getElementById('deliveryRequestsApp');
  const audience = location.pathname.startsWith('/dispatch/') ? 'dispatch' : 'sales';
  const endpoint = `/api/${audience}/delivery-requests`;
  const labels = {submitted:'Awaiting Dispatch',proposed:'Proposed time',preapproved:'Pre-approved — orders needed',confirmed:'Secured',expired:'Expired',cancelled:'Cancelled'};
  const tripLabels={single:'Single trip',round_trip:'Round trip',multi_stop:'Multi-stop trip'};
  const state = {actor:null,meta:null,rows:[],detail:null,instruction:null,instructionRef:'',draft:null,quote:null,busy:false,generation:0,operation:null};
  let events = null, poll = null, searchTimer = null;
  const esc = value => String(value ?? '').replace(/[&<>"']/g,char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const money = value => new Intl.NumberFormat('en-CA',{style:'currency',currency:'CAD'}).format(Number(value || 0)/100);
  const quantityUnit = row => row.quantityUnit==='yard'?'Yard':row.loadType.toUpperCase();
  const slotText = slot => slot ? `${slot.date} · ${slot.start}–${slot.end} (Toronto)` : '—';
  const dateText = value => value ? new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',dateStyle:'medium',timeStyle:'short'}).format(new Date(value)) : '';
  const notice = (message='',error=false) => {const node=root.querySelector('[data-notice]');if(node){node.textContent=message;node.classList.toggle('error',error);}};
  async function api(path,options={}) {
    const generation=state.generation;
    const response=await fetch(path,{cache:'no-store',...options,signal:AbortSignal.timeout(30000),
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${readDispatchAuthToken()}`,...options.headers}});
    const payload=await response.json();
    if(generation!==state.generation) {throw new Error('The signed-in account changed.');}
    if(!response.ok) {const error=new Error(payload.error || 'The request could not be completed.');error.status=response.status;throw error;}
    return payload;
  }
  function shell() {
    root.innerHTML=`<header class="dispatch-topbar"><div><h1>Delivery Requests</h1><p>${audience==='sales'?'Sales':'Dispatch'} · ${esc(state.actor.displayName || state.actor.username || '')}</p></div>
      <div class="topbar-actions"><a href="/${audience}">Menu</a><button type="button" data-action="logout">Logout</button></div></header>
      <div class="dr-notice" data-notice role="status" aria-live="polite"></div>
      <div class="dr-page-actions dr-actions">${audience==='sales'?'<button type="button" class="primary" data-action="new">New request</button>':''}<button type="button" data-action="refresh">Refresh</button></div>
      <div class="dr-workspace"><section class="dr-panel"><h2>Requests</h2><div class="dr-filters">
        <label>Search requests<input type="search" data-search placeholder="Request, customer, address or SO"></label>
        <details class="dr-status-filter"><summary>Status: <span data-status-summary>All statuses</span></summary><div class="dr-status-options" role="group" aria-label="Request statuses">${Object.entries(labels).map(([key,label])=>`<label><input type="checkbox" data-status value="${key}">${esc(label)}</label>`).join('')}</div></details></div><div class="dr-list" data-list></div></section>
      <section class="dr-panel" data-detail><p class="dr-muted">Select a request${audience==='sales'?' or create a new one':''}.</p></section></div>
      ${audience==='dispatch'?settingsHtml():''}`;
    root.setAttribute('aria-busy','false');
  }
  function settingsHtml() {
    const settings=state.meta.settings;
    return `<details class="dr-panel dr-settings"><summary>Request settings</summary><form data-form="settings"><div class="dr-fields">
      ${[['pos','POS per trip'],['bin','BIN per trip'],['approvalHours','Approval expires after (hours)'],['reminderHours','Remind before expiry (hours)']].map(([key,label])=>`<label>${label}<input name="${key}" type="number" min="${key==='reminderHours'?0:1}" step="${key.includes('Hours')?'0.25':1}" value="${settings[key]}" required></label>`).join('')}
      </div><p class="dr-muted">Changes apply to new quotes and new pre-approvals.</p><button class="primary">Save settings</button></form></details>`;
  }
  async function loadList() {
    const statuses=[...root.querySelectorAll('[data-status]:checked')].map(input=>input.value);
    const query=new URLSearchParams({search:root.querySelector('[data-search]')?.value || ''});
    statuses.forEach(status=>query.append('status',status));
    root.querySelector('[data-status-summary]').textContent=statuses.length?statuses.map(status=>labels[status]).join(', '):'All statuses';
    const result=await api(`${endpoint}?${query}`);state.rows=result.requests;
    root.querySelector('[data-list]').innerHTML=state.rows.map(row=>`<button type="button" data-action="open" data-id="${row.id}" aria-current="${row.id===state.detail?.id}">
      <strong>${esc(row.requestRef)} · ${esc(labels[row.status])}${row.pendingWindow?' · Time change pending':''}</strong><span>${esc(row.customerName || row.deliveryAddress)}</span>
      <small>${row.totalUnits} ${esc(quantityUnit(row))} · ${esc(slotText(row.confirmedWindow || row.proposedWindow || row.requestedWindow))}</small></button>`).join('') || '<p class="dr-muted">No requests found.</p>';
    if(state.detail && state.rows.some(row=>row.id===state.detail.id && row.revision>state.detail.revision)) {notice('This request has an update. Refresh the request to review it.');}
  }
  async function readDisplayed(row) {
    await api(`${endpoint}/${row.id}/read`,{method:'POST',body:JSON.stringify({revision:row.revision})});
    window.MBBSDeliveryRequestAlerts?.refresh();
  }
  async function open(id) {
    const row=await api(`${endpoint}/${id}`);
    state.detail=row;state.draft=null;state.quote=null;state.operation=null;state.instruction=null;
    const url=new URL(location.href);url.searchParams.set('request',row.id);history.replaceState(null,'',url);
    renderDetail();await readDisplayed(row);
    if(row.status==='confirmed') {const refs=instructionOrderRefs(row);await loadInstruction(refs.includes(state.instructionRef)?state.instructionRef:refs[0]);}
  }
  function windowInputs(windowValue={},prefix='') {
    return `<div class="dr-fields dr-fields-three"><label>${prefix?'New date':'Requested date'}<input name="date" type="date" value="${esc(windowValue.date)}" required></label>
      <label>Start time<input name="start" type="text" inputmode="numeric" data-time-input value="${esc(windowValue.start || '09:00')}" placeholder="0800 or 08:00" autocomplete="off" aria-describedby="dr-window-help dr-window-error" required></label>
      <label>End time<input name="end" type="text" inputmode="numeric" data-time-input value="${esc(windowValue.end || '12:00')}" placeholder="1000 or 10:00" autocomplete="off" aria-describedby="dr-window-help dr-window-error" required></label></div>
      <p class="dr-muted" id="dr-window-help">Enter 24-hour times, e.g. 0800 or 08:00. End time must be at least 2 hours after start time on the same day.</p>
      <p class="dr-window-error" id="dr-window-error" data-window-error aria-live="polite" hidden></p>`;
  }
  function parseTime(value) {
    const text=String(value).trim();
    const match=/^(\d{1,2}):(\d{2})$/.exec(text);
    let hours,minutes;
    if(match) {[hours,minutes]=match.slice(1).map(Number);}
    else if(/^\d{1,4}$/.test(text)) {
      hours=Number(text.length>2?text.slice(0,-2):text);minutes=text.length>2?Number(text.slice(-2)):0;
    } else {return null;}
    if(hours>23 || minutes>59) {return null;}
    return {minutes:hours*60+minutes,formatted:`${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}`};
  }
  const formattedTime=value=>parseTime(value)?.formatted || value;
  function validateTimeInput(input) {
    const time=parseTime(input.value);
    input.setCustomValidity(input.value && !time?'Enter a valid 24-hour time, such as 0800 or 08:00.':'');
    return time;
  }
  function validateWindow(form) {
    const start=form?.elements.namedItem('start'),end=form?.elements.namedItem('end');
    if(!start || !end) {return;}
    const startTime=validateTimeInput(start),endTime=validateTimeInput(end);
    if(startTime && endTime && endTime.minutes-startTime.minutes<120) {end.setCustomValidity('End time must be at least 2 hours after start time.');}
    [start,end].forEach(input=>input.setAttribute('aria-invalid',String(Boolean(input.value && !input.validity.valid))));
    const error=form.querySelector('[data-window-error]');
    error.textContent=[start,end].find(input=>input.value && !input.validity.valid)?.validationMessage || '';
    error.hidden=!error.textContent;
    const valid=[start,end].every(input=>input.value && input.validity.valid);
    form.dataset.windowValid=String(valid);updateWindowSubmit(form);
  }
  function updateWindowSubmit(form) {
    const button=form.querySelector('[data-window-submit]');
    const expired=button.hasAttribute('data-approval-dependent') && state.detail?.approvalExpiresAt
      && new Date(state.detail.approvalExpiresAt).getTime()<=Date.now();
    button.disabled=state.busy || form.dataset.windowValid!=='true' || Boolean(expired)
      || (form.dataset.form==='request' && !state.quote);
  }
  function startDraft(row=null,action='create') {
    state.draft={action,row,...(row || {requestingYardLocationId:state.meta.requestingYards[0]?.id,loadType:'pos',outbounds:[{originYardCode:'3445',totalUnits:1,fullPosQty:1,loosePosQty:0}],deliveryAddress:'',customerName:'',remarks:'',estimateRef:'',requestedWindow:{}})};
    const size=state.meta.binTypes.find(bin=>bin.code===row?.binTypeCode)?.nominalYards || 1;
    state.draft.outbounds=state.draft.outbounds.map(yard=>state.draft.loadType==='pos'
      ? {...yard,fullPosQty:yard.fullPosQty ?? yard.totalUnits,loosePosQty:yard.loosePosQty ?? 0}
      : {...yard,totalUnits:row.quantityUnit==='yard'?yard.totalUnits:Math.round(yard.totalUnits*size*100)/100});
    if(state.draft.loadType==='bin') {state.draft.quantityUnit='yard';}
    state.quote=null;state.instruction=null;window.MBBSDeliveryRequestPage.currentRequestId=null;window.MBBSDeliveryRequestPage.currentRequestRevision=null;renderForm(state.draft);notice();
  }
  function outboundHtml(yard,index) {
    return `<div class="dr-outbound" data-outbound><label>Outbound yard<select name="origin" data-pricing>${state.meta.outboundYards.map(code=>`<option value="${code}" ${code===yard.originYardCode?'selected':''}>${code}</option>`).join('')}</select></label>
      ${state.draft.loadType==='pos'?`<label>Full POS qty<input type="number" name="units" min="0" max="1000000000" step="1" value="${yard.fullPosQty ?? yard.totalUnits}" required data-pricing></label>
        <label>Loose POS qty<input type="number" name="loosePosQty" min="0" max="1000000000" step="1" value="${yard.loosePosQty ?? 0}" required data-pricing></label>`
        :`<label>Quantity (Yard)<input type="number" name="units" min="0.01" max="1000000000" step="0.01" value="${yard.totalUnits}" required data-pricing></label>`}
      ${index?`<button type="button" data-action="remove-yard" data-index="${index}" aria-label="Remove outbound yard ${index+1}">Remove</button>`:''}</div>`;
  }
  function renderForm(draft) {
    root.querySelector('[data-detail]').innerHTML=`<h2>${draft.action==='create'?'New delivery request':`${draft.action==='reraise'?'Re-raise':'Edit'} ${esc(draft.row.requestRef)}`}</h2>
      <form data-form="request"><div class="dr-fields dr-fields-three">
      <label>Requesting yard<select name="requestingYard" data-pricing ${draft.row?'disabled':''}>${state.meta.requestingYards.map(yard=>`<option value="${yard.id}" ${yard.id===draft.requestingYardLocationId?'selected':''}>${yard.code}</option>`).join('')}</select></label>
      <label>Load type<select name="loadType" data-pricing><option value="pos" ${draft.loadType==='pos'?'selected':''}>POS</option><option value="bin" ${draft.loadType==='bin'?'selected':''}>BIN</option></select></label>
      <label>Customer (optional)<input name="customer" maxlength="250" value="${esc(draft.customerName)}"></label>
      <label>Trip type<select name="tripType" aria-label="Trip type" required data-pricing>${Object.entries(tripLabels).map(([value,label])=>`<option value="${value}" ${value===(draft.tripType || 'single')?'selected':''}>${label}</option>`).join('')}</select></label>
      ${draft.loadType==='bin'?`<label>BIN size<select name="binType" data-pricing required>${state.meta.binTypes.map(bin=>`<option value="${esc(bin.code)}" ${bin.code===draft.binTypeCode?'selected':''}>${esc(bin.name)}</option>`).join('')}</select></label>`:''}
      ${draft.loadType==='bin'?`<label>Aggregate<select name="aggregate" aria-label="Aggregate" required data-pricing><option value="">Choose aggregate</option>${(state.meta.aggregates || ['Gravel','HPE','Screening','Crusher Run']).map(value=>`<option value="${esc(value)}" ${value===draft.aggregate?'selected':''}>${esc(value)}</option>`).join('')}</select></label>`:''}
      <div class="dr-estimate-field"><label>Quote (EST) number<input name="estimateRef" maxlength="64" value="${esc(draft.estimateRef)}" placeholder="ESTB123" autocomplete="off"></label><button type="button" data-action="preview-estimate">Preview quote</button></div>
      ${deliveryAddressField(draft)}</div>${tripQuantityFields(draft)}
      <button type="button" data-action="quote">Calculate charge</button><div data-quote></div>
      <h3>Requested timeslot · Toronto time</h3>${windowInputs(draft.requestedWindow)}
      <label style="margin-top:12px">Request remarks<textarea name="remarks" maxlength="5000">${esc(draft.remarks)}</textarea></label>
      <p class="dr-muted">After pre-approval, add at least one Sales Order (SO) or Transfer Order (TO) within ${state.meta.settings.approvalHours} hours to secure delivery.</p>
      <div class="dr-actions"><button class="primary" data-submit data-window-submit disabled>${draft.action==='create'?'Submit request':draft.action==='reraise'?'Re-raise request':'Save request'}</button><button type="button" data-action="discard">Close</button></div></form>`;
    validateWindow(root.querySelector('[data-form=request]'));
  }
  function deliveryAddressField(draft) {
    const multi=draft.tripType==='multi_stop';
    return `<label class="wide" ${multi?'hidden':''}>Delivery address<textarea name="address" maxlength="2000" ${multi?'disabled':'required'} data-pricing>${esc(draft.deliveryAddress)}</textarea></label>`;
  }
  function tripQuantityFields(draft) {
    return `<section ${draft.tripType==='multi_stop'?'hidden':''}><h3>Yard outbound quantities</h3><div data-outbounds>${draft.outbounds.map(outboundHtml).join('')}</div>
      <button type="button" data-action="add-yard" ${draft.outbounds.length>=4?'disabled':''}>Add outbound yard</button>
      <p>Total: <strong data-total-units>${Math.round(draft.outbounds.reduce((sum,yard)=>sum+Number(yard.totalUnits),0)*100)/100}</strong> ${quantityUnit(draft)}</p>
      <p class="dr-muted">3445 and 2967 share one charge. Other yard combinations use the lowest transfer + delivery total.</p></section>
      ${draft.tripType==='round_trip'?'<p class="dr-muted">Round trip adds a return leg from the delivery address back to the pickup yard. Both directions are quoted separately.</p>':''}
      ${draft.tripType==='multi_stop'?tripLegForm(draft):''}`;
  }
  function tripLegForm(draft) {
    return `<section data-trip-legs><h3>Trip legs</h3>
      <p class="dr-muted">Start and finish at an MBBS yard. Enter each pickup, drop-off and quantity in route order. Each leg is charged using its driving distance and required truck trips.</p>
      ${(draft.tripLegs || []).map((leg,index)=>`<fieldset class="dr-trip-leg" data-trip-leg><legend>Leg ${index+1}</legend><div class="dr-fields dr-fields-three">
        ${tripEndpointInput(leg,'pickup',index===0)}${tripEndpointInput(leg,'dropoff',index===draft.tripLegs.length-1)}
        <label>Quantity (${quantityUnit(draft)})<input name="legQuantity" type="number" value="${leg.totalUnits}" min="${draft.loadType==='bin'?'0.01':'1'}" max="1000000000" step="${draft.loadType==='bin'?'0.01':'1'}" required data-pricing></label></div>
        <button type="button" data-action="remove-trip-leg" data-index="${index}" ${(draft.tripLegs || []).length<=2?'disabled':''}>Remove leg ${index+1}</button></fieldset>`).join('')}
      <button type="button" data-action="add-trip-leg" ${(draft.tripLegs || []).length>=20?'disabled':''}>Add trip leg</button></section>`;
  }
  function tripEndpointInput(leg,side,yard) {
    const pickup=side==='pickup',label=pickup?'Pickup':'Drop-off',name=pickup?'legPickup':'legDropoff';
    if(yard) {return `<label>${label} MBBS yard<select name="${name}Yard" data-pricing required>${state.meta.outboundYards.map(code=>`<option value="${code}" ${code===leg[`${side}YardCode`]?'selected':''}>${code}</option>`).join('')}</select></label>`;}
    return `<label>${label} address<input name="${name}" value="${esc(leg[`${side}Address`])}" maxlength="2000" required data-pricing></label>`;
  }
  function collectDraft() {
    const form=root.querySelector('[data-form=request]'),field=name=>form.elements.namedItem(name)?.value || '';
    const outbounds=[...form.querySelectorAll('[data-outbound]')].map(node=>{
      const fullPosQty=Number(node.querySelector('[name=units]').value),loose=node.querySelector('[name=loosePosQty]');
      return {originYardCode:node.querySelector('[name=origin]').value,totalUnits:fullPosQty+Number(loose?.value || 0),
        ...(loose?{fullPosQty,loosePosQty:Number(loose.value)}:{})};
    });
    const tripType=field('tripType') || 'single',tripLegs=[...form.querySelectorAll('[data-trip-leg]')].map(collectTripLeg);
    if(tripType==='multi_stop' && tripLegs.length) {outbounds.splice(0,outbounds.length,{originYardCode:tripLegs[0].pickupYardCode,totalUnits:tripLegs.reduce((sum,leg)=>sum+Math.round(leg.totalUnits*100),0)/100});}
    return {...state.draft,tripType,tripLegs,requestingYardLocationId:Number(field('requestingYard')),loadType:field('loadType'),outbounds,
      pricingOriginYardCode:outbounds[0].originYardCode,
      totalUnits:outbounds.reduce((sum,yard)=>sum+Math.round(yard.totalUnits*100),0)/100,deliveryAddress:tripType==='multi_stop' && tripLegs.length?`MBBS yard ${tripLegs.at(-1).dropoffYardCode}`:field('address'),binTypeCode:field('binType') || null,
      quantityUnit:field('loadType')==='bin'?'yard':undefined,aggregate:field('aggregate'),estimateRef:field('estimateRef').trim().toUpperCase(),
      customerName:field('customer'),remarks:field('remarks'),requestedWindow:{date:field('date'),start:formattedTime(field('start')),end:formattedTime(field('end'))}};
  }
  function collectTripLeg(node) {
    const leg={totalUnits:Number(node.querySelector('[name=legQuantity]').value)};
    for(const [side,name] of [['pickup','legPickup'],['dropoff','legDropoff']]) {
      const yard=node.querySelector(`[name=${name}Yard]`),address=node.querySelector(`[name=${name}]`);
      if(yard) {leg[`${side}YardCode`]=yard.value;}else {leg[`${side}Address`]=address.value;}
    }
    return leg;
  }
  function pricingPayload(draft) {return {requestingYardLocationId:draft.requestingYardLocationId,loadType:draft.loadType,
    tripType:draft.tripType || 'single',...(draft.tripType==='multi_stop'?{tripLegs:draft.tripLegs}:{}),
    outbounds:draft.outbounds,pricingOriginYardCode:draft.pricingOriginYardCode,totalUnits:draft.totalUnits,deliveryAddress:draft.deliveryAddress,binTypeCode:draft.binTypeCode,
    ...(draft.loadType==='bin'?{quantityUnit:'yard',aggregate:draft.aggregate}:{})};}
  function quoteHtml(quote,deliveryAddress) {
    const legs=quote.outbounds || [];
    return `<div class="dr-quote"><strong data-quote-total>${money(quote.totalAmountMinor)}</strong><span>CAD before tax · ${quote.deliveryTrips ?? quote.trips} delivery trip(s)${quote.transferTrips?` + ${quote.transferTrips} transfer trip(s)`:''}${quote.returnTrips?` + ${quote.returnTrips} return trip(s)`:''}</span>
      ${quote.consolidationYardCode?`<p>Deliver the whole order from yard <b>${esc(quote.consolidationYardCode)}</b>. Transfer ${money(quote.transferAmountMinor)} + delivery ${money(quote.deliveryAmountMinor)}.</p>`:''}
      <table><thead><tr><th>Trip</th><th>Distance</th><th>Charge</th></tr></thead><tbody>${legs.map(leg=>quoteLegRow(leg,deliveryAddress)).join('')}</tbody></table>
      ${quote.alternatives?.length>1?`<details><summary>Compare consolidation yards</summary>${quote.alternatives.map(option=>`<p>Yard ${esc(option.consolidationYardCode)}: transfer ${money(option.transferAmountMinor)} + delivery ${money(option.deliveryAmountMinor)} = ${money(option.totalAmountMinor)}</p>`).join('')}</details>`:''}
      <small>${esc([...new Set(legs.map(leg=>leg.rateCardName))].join(' / '))} · ${quote.capacityPerTrip} ${esc(quantityUnit(state.draft || state.detail))} per trip</small></div>`;
  }
  function quoteLegRow(leg,deliveryAddress) {
    const pickup=leg.pickupAddress || leg.pickupYardCode || leg.originYardCode;
    const dropoff=leg.dropoffAddress || leg.dropoffYardCode || (leg.legType==='transfer'?leg.destinationYardCode:deliveryAddress);
    const quantity=leg.legType==='return'?'':`${leg.totalUnits} ${esc(quantityUnit(state.draft || state.detail))} · `;
    return `<tr><td>${leg.legType==='return'?'Return: ':''}${esc(pickup)} → ${esc(dropoff)} · ${quantity}${leg.trips} trip(s)</td><td>${(leg.rawDistanceMetres/1000).toFixed(2)} km</td><td>${money(leg.totalAmountMinor)}</td></tr>`;
  }
  async function calculateQuote() {
    const form=root.querySelector('[data-form=request]');
    for(const input of form.querySelectorAll('[data-pricing]')) {if(!input.reportValidity()) {return;}}
    const draft=collectDraft(),payload=pricingPayload(draft),fingerprint=JSON.stringify(payload);
    state.quote=null;root.querySelector('[data-submit]').disabled=true;
    const quote=await api(`${endpoint}/quotes`,{method:'POST',body:JSON.stringify(payload)});
    if(!state.draft || fingerprint!==JSON.stringify(pricingPayload(collectDraft()))) {return;}
    state.quote=quote;root.querySelector('[data-quote]').innerHTML=quoteHtml(quote,draft.deliveryAddress);validateWindow(root.querySelector('[data-form=request]'));
  }
  function requestFacts(row) {
    return `<dl class="dr-facts"><dt>Requesting yard</dt><dd>${esc(state.meta.requestingYards.find(yard=>yard.id===row.requestingYardLocationId)?.code || ({1:'3445',28:'2967',15:'12441',26:'150'})[row.requestingYardLocationId])}</dd>
      <dt>Customer</dt><dd>${esc(row.customerName || '—')}</dd><dt>Address</dt><dd>${esc(row.deliveryAddress)}</dd>
      ${requestTripFacts(row)}
      ${requestQuantityFacts(row)}
      ${row.loadType==='bin'?`<dt>BIN / Aggregate</dt><dd>${esc(state.meta.binTypes.find(bin=>bin.code===row.binTypeCode)?.name || row.binTypeCode)} · ${esc(row.aggregate || '—')}</dd>`:''}
      ${row.estimateRef?`<dt>Quote (EST)</dt><dd><button type="button" data-action="preview-estimate">Preview quote ${esc(row.estimateRef)}</button></dd>`:''}
      <dt>Requested time</dt><dd>${esc(slotText(row.requestedWindow))}</dd>
      ${row.proposedWindow?`<dt>Proposed time</dt><dd>${esc(slotText(row.proposedWindow))}</dd>`:''}
      ${row.confirmedWindow?`<dt>Approved time</dt><dd data-approved-window>${esc(slotText(row.confirmedWindow))}</dd>`:''}
      <dt>Remarks</dt><dd>${esc(row.remarks || '—')}</dd></dl>`;
  }
  function requestQuantityFacts(row) {
    if(row.tripType==='multi_stop') {return `<dt>Total across trip legs</dt><dd>${row.totalUnits} ${esc(quantityUnit(row))}</dd>`;}
    return `<dt>Outbound</dt><dd>${row.outbounds.map(yard=>`${esc(yard.originYardCode)}: ${row.loadType==='pos'?`${yard.fullPosQty ?? yard.totalUnits} full POS + ${yard.loosePosQty ?? 0} loose POS`:`${yard.totalUnits} ${esc(quantityUnit(row))}`}`).join(' · ')}</dd>`;
  }
  function requestTripFacts(row) {
    return `<dt>Trip type</dt><dd>${esc(tripLabels[row.tripType || 'single'])}</dd>
      ${row.tripType==='multi_stop'?`<dt>Trip legs</dt><dd><ol>${(row.tripLegs || []).map(leg=>`<li>${esc(leg.pickupAddress || `MBBS yard ${leg.pickupYardCode}`)} → ${esc(leg.dropoffAddress || `MBBS yard ${leg.dropoffYardCode}`)} · ${leg.totalUnits} ${esc(quantityUnit(row))}</li>`).join('')}</ol></dd>`:''}`;
  }
  function conversationMessages(row) {
    const messages=(row.conversation || []).filter(event=>['sales','dispatch'].includes(event.audience) && event.message?.trim());
    return messages.map(event=>`<li class="dr-message ${event.audience}"><div><strong>${esc(({sales:'Sales',dispatch:'Dispatch'})[event.audience])} · ${esc(event.actorName)}</strong><time>${esc(dateText(event.createdAt))} (Toronto)</time></div><p>${esc(event.message)}</p></li>`).join('') || '<li class="dr-muted">No messages yet. Send a reply to start the conversation.</li>';
  }
  function conversationSection(row) {
    return `<section class="dr-conversation" data-conversation aria-labelledby="dr-conversation-title"><h3 id="dr-conversation-title">Sales &amp; Dispatch conversation</h3>
      <ol class="dr-messages" data-conversation-messages>${conversationMessages(row)}</ol>
      <form data-form="reply"><label>Reply to ${audience==='sales'?'Dispatch':'Sales'}<textarea name="message" maxlength="2000" required placeholder="Write a message…"></textarea></label>
        <div class="dr-actions"><button class="primary" type="submit">Send reply</button></div></form></section>`;
  }
  function linkedDocumentPreviews(row) {
    return row.salesOrderRefs.length?`<section class="dr-documents"><h3>Linked orders</h3><div class="dr-actions">${row.salesOrderRefs.map(ref=>`<button type="button" data-action="preview-order" data-reference="${esc(ref)}">Preview ${esc(ref)}</button>`).join('')}</div></section>`:'';
  }
  function estimatePreviewHtml(document) {
    const packingFields=['pallets','layers','sections','pieces'];
    const party=document.fromYard!==undefined?`${document.fromYard} → ${document.toYard}`:document.customerName;
    return `<h3>${esc(document.reference)}</h3><p>${esc(party)} · ${esc(document.date)}</p><p class="dr-preview-text">${esc(document.address)}</p>
      <div class="dr-preview-table"><table><thead><tr><th>Description</th><th>Quantity</th><th>PLT</th><th>LYR</th><th>SEC</th><th>PCS</th></tr></thead><tbody>${document.lines.map(line=>`<tr><td>${esc(line.description)}</td><td>${esc(line.quantity)}${line.unit?` ${esc(line.unit)}`:''}</td>${packingFields.map(key=>`<td>${esc(line[key] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <p class="dr-preview-text">${esc(document.memo)}</p>`;
  }
  function previewTarget(button) {
    const order=button.dataset.action==='preview-order',draft=state.draft?collectDraft():null;
    const reference=order?button.dataset.reference:draft?.estimateRef || state.detail?.estimateRef;
    if(!reference) {throw new Error('Enter a Quote (EST) number before previewing.');}
    const transfer=order && reference.startsWith('TO');
    const path=order?`${endpoint}/${state.detail.id}/${transfer?'transfer-orders':'sales-orders'}/${encodeURIComponent(reference)}/preview`
      :draft?`${endpoint}/estimates/${encodeURIComponent(reference)}/preview?yard=${draft.requestingYardLocationId}`:`${endpoint}/${state.detail.id}/estimate/preview`;
    return {order,transfer,pdf:order && !transfer,reference,path};
  }
  function previewDialog(button,{order,transfer,reference}) {
    const dialog=document.createElement('dialog'),controller=new AbortController();
    let documentUrl=null;
    dialog.className='dr-document-dialog';dialog.setAttribute('aria-labelledby','dr-preview-title');
    dialog.innerHTML=`<header><h2 id="dr-preview-title">${transfer?'Transfer Order':order?'Sales Order':'Quote'} preview · ${esc(reference)}</h2><button type="button">Close preview</button></header><div data-preview-content role="status">Loading document…</div>`;
    const close=()=>{
      controller.abort();if(documentUrl) {URL.revokeObjectURL(documentUrl);}dialog.remove();if(button.isConnected) {button.focus();}
      window.removeEventListener('mbbs-auth-operator-changed',close);window.removeEventListener('pagehide',close);
    };
    dialog.querySelector('button').addEventListener('click',close);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    document.body.append(dialog);dialog.showModal();
    window.addEventListener('mbbs-auth-operator-changed',close);window.addEventListener('pagehide',close);
    return {dialog,controller,setDocumentUrl:url=>{documentUrl=url;}};
  }
  async function openDocumentPreview(button) {
    const target=previewTarget(button),{pdf,reference,path}=target;
    const {dialog,controller,setDocumentUrl}=previewDialog(button,target),generation=state.generation;
    try {
      const response=await fetch(path,{cache:'no-store',headers:{Authorization:`Bearer ${readDispatchAuthToken()}`},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
      if(!response.ok) {const error=await response.json();throw new Error(error.error || 'The document could not be previewed.');}
      const payload=pdf?await response.blob():await response.json();
      if(generation!==state.generation || !dialog.isConnected) {return;}
      const content=dialog.querySelector('[data-preview-content]');
      if(pdf) {
        if(!response.headers.get('content-type')?.includes('application/pdf')) {throw new Error('The Sales Order PDF is unavailable.');}
        const documentUrl=URL.createObjectURL(payload);setDocumentUrl(documentUrl);
        const frame=document.createElement('iframe');frame.title=`${reference} PDF preview`;frame.src=documentUrl;content.replaceChildren(frame);
      } else {content.innerHTML=estimatePreviewHtml(payload);}
    } catch(error) {if(!controller.signal.aborted && dialog.isConnected) {dialog.querySelector('[data-preview-content]').textContent=error.message;}}
  }
  function approvalControls(row) {
    const editableSales=audience==='sales';
    return `${audience==='dispatch' && ['submitted','proposed'].includes(row.status)?`<div class="dr-actions"><button type="button" class="primary" data-action="confirm">OK — preapprove</button></div>${slotForm('propose',row.requestedWindow,'Propose another time')}`:''}
      ${editableSales && row.status==='proposed'?`<button type="button" class="primary" data-action="accept" data-approval-dependent>Accept proposed time</button>`:''}
      ${editableSales && row.status==='preapproved'?`<form data-form="secure" class="dr-slot"><h3>Sales / Transfer Order linkage</h3><div data-sales-orders>${salesOrderInput()}</div>
        <p class="dr-muted">Enter one Delivery Sales Order (SO) or Transfer Order (TO) per box. TOs must involve the requesting yard. Use + to add another (up to 50). Saving secures the approval and stops expiry.</p><button class="primary" data-approval-dependent>Secure approval</button></form>`:''}
      ${editableSales && row.status==='confirmed'?`<form data-form="relink" class="dr-slot"><h3>Sales / Transfer Order linkage</h3><div data-sales-orders>${row.salesOrderRefs.map((ref,index)=>salesOrderInput(index,ref,true,row.salesOrderRefs.length)).join('')}</div>
        <p class="dr-muted">Exchange an SO or TO number or unlink a row, then save. At least one order must remain. The approved delivery time stays the same.</p><button class="primary">Save order links</button></form>`:''}
      ${editableSales && ['proposed','preapproved'].includes(row.status)?slotForm('counter',row.requestedWindow,'Request another time'):''}`;
  }
  function salesOrderInput(index=0,ref='',linked=false,count=1) {
    return `<div class="dr-sales-order ${linked?'dr-linked-order':''}" data-sales-order><label><span data-order-label>Order ${index+1} (SO / TO)</span><input name="salesOrderRefs" value="${esc(ref)}" placeholder="SO123 or TO123" maxlength="80" autocomplete="off" required></label>
      <button type="button" data-action="add-order" aria-label="Add order" title="Add order">+</button>
      ${linked?`<button type="button" data-action="exchange-order" aria-label="Exchange ${esc(ref || `Order ${index+1}`)}">Exchange</button><button type="button" data-action="remove-order" aria-label="Unlink ${esc(ref || `Order ${index+1}`)}" ${count===1?'disabled':''}>Unlink</button>`
        :`<button type="button" data-action="remove-order" aria-label="Remove order ${index+1}" title="Remove order" ${index?'':'hidden'}>×</button>`}</div>`;
  }
  function timeChangeControls(row) {
    if(row.status!=='confirmed') {return '';}
    const pending=row.pendingWindow,counter=row.pendingWindowProposedBy==='dispatch';
    return `<section class="dr-slot"><h3>Delivery time change${pending?(counter?' — Awaiting Sales':' — awaiting Dispatch'):''}</h3>
      <p class="dr-muted">${counter?'The approved time stays active until Sales accepts the Dispatch counter-proposal.':'The approved time stays active until Dispatch accepts the new timeslot.'}</p>
      ${pendingTimeControls(row)}</section>
      ${pending && audience==='dispatch'?slotForm('counter-time-change',pending,'Counter-propose timeslot'):''}
      ${audience==='sales'?slotForm('request-time-change',pending || row.confirmedWindow,pending?'Update requested timeslot':'Request new timeslot'):''}`;
  }
  function pendingTimeControls(row) {
    if(!row.pendingWindow) {return '';}
    const counter=row.pendingWindowProposedBy==='dispatch';
    const decisions=audience==='sales'?salesTimeDecision(counter):dispatchTimeDecision(counter);
    return `<p data-pending-window><strong>${counter?'Dispatch counter-proposal':'Requested new time'}:</strong> ${esc(slotText(row.pendingWindow))}</p>${decisions}`;
  }
  function salesTimeDecision(counter) {
    return `${counter?'<button class="primary" type="button" data-action="accept-counter-time-change">Accept Dispatch timeslot</button>':''}
      <button type="button" data-action="withdraw-time-change">${counter?'Keep approved timeslot':'Withdraw time change'}</button>`;
  }
  function dispatchTimeDecision(counter) {
    return counter?'<button type="button" data-action="withdraw-counter-time-change">Withdraw counter-proposal</button>'
      :'<div class="dr-actions"><button class="primary" type="button" data-action="accept-time-change">Accept new timeslot</button><button type="button" data-action="decline-time-change">Decline time change</button></div>';
  }
  function editSalesOrders(button) {
    const list=root.querySelector('[data-sales-orders]'),linked=button.form.dataset.form==='relink';
    if(button.dataset.action==='add-order') {
      if(list.children.length>=50) {return;}
      button.closest('[data-sales-order]').insertAdjacentHTML('afterend',salesOrderInput(list.children.length,'',linked,list.children.length+1));
      button.closest('[data-sales-order]').nextElementSibling.querySelector('input').focus();
    } else {
      if(list.children.length<=1) {return;}
      const row=button.closest('[data-sales-order]'),next=row.nextElementSibling || row.previousElementSibling;
      row.remove();next.querySelector('input').focus();
    }
    [...list.children].forEach((row,index)=>{
      row.querySelector('[data-order-label]').textContent=`Order ${index+1} (SO / TO)`;
      row.querySelector('[data-action=add-order]').disabled=list.children.length>=50;
      const remove=row.querySelector('[data-action=remove-order]');
      remove.hidden=!linked && list.children.length===1;remove.disabled=linked && list.children.length===1;
      remove.setAttribute('aria-label',linked?`Unlink ${row.querySelector('input').value || `Order ${index+1}`}`:`Remove order ${index+1}`);
    });
  }
  function requestControls(row) {
    const editableSales=audience==='sales';
    return `<div class="dr-actions">${editableSales && row.status==='submitted'?'<button type="button" data-action="edit">Edit request</button>':''}
        ${editableSales && row.status==='expired'?'<button type="button" class="primary" data-action="reraise">Re-raise request</button>':''}
        ${row.status!=='cancelled'?'<button type="button" data-action="cancel">Cancel request</button>':''}<button type="button" data-action="reload">Refresh request</button></div>`;
  }
  function instructionOrderRefs(row) {return row.salesOrderRefs.filter(ref=>ref.startsWith('SO'));}
  function instructionSection(row) {
    const refs=instructionOrderRefs(row);
    return row.status==='confirmed' && refs.length?`<h3>Delivery instructions</h3><label>Linked Sales Order<select data-linked-order>${refs.map(ref=>`<option value="${esc(ref)}">${esc(ref)}</option>`).join('')}</select></label><div data-instructions><p class="dr-muted">Loading instructions…</p></div>`:'';
  }
  function renderDetail() {
    const row=state.detail;
    window.MBBSDeliveryRequestPage.currentRequestId=row.id;window.MBBSDeliveryRequestPage.currentRequestRevision=row.revision;
    root.querySelector('[data-detail]').innerHTML=`<h2>${esc(row.requestRef)}</h2><p><strong>${esc(labels[row.status])}</strong></p>
      ${requestFacts(row)}${conversationSection(row)}${linkedDocumentPreviews(row)}${quoteHtml(row.quote,row.deliveryAddress)}<div class="dr-clock" data-approval-clock></div>
      ${approvalControls(row)}${timeChangeControls(row)}${requestControls(row)}${instructionSection(row)}
      <details><summary>Request history</summary><ol class="dr-history">${(row.history || []).map(event=>`<li><b>${esc(event.action)}</b> · ${esc(event.actorName)} · ${esc(dateText(event.createdAt))}<br>${esc(event.message || '')}</li>`).join('')}</ol></details>`;
    root.querySelectorAll('form').forEach(validateWindow);updateClock();
    const messages=root.querySelector('[data-conversation-messages]');messages.scrollTop=messages.scrollHeight;
  }
  function slotForm(action,slot,label) {return `<form data-form="${action}" class="dr-slot"><h3>${label}</h3>${windowInputs(slot,'new')}<label>Reply (optional)<textarea name="message" maxlength="2000"></textarea></label><button data-window-submit ${action==='counter'?'data-approval-dependent':''}>${label}</button></form>`;}
  function updateClock() {
    const node=root.querySelector('[data-approval-clock]'),row=state.detail;if(!node || !row || state.draft) {return;}
    node.classList.toggle('secured',row.status==='confirmed');node.classList.toggle('expired',row.status==='expired');
    if(row.status==='confirmed') {node.textContent=`Secured · ${row.salesOrderRefs.join(', ')} · expiry clock stopped.`;}
    else if(row.status==='cancelled') {node.textContent='Cancelled · linked orders released.';}
    else if(row.approvalExpiresAt) {
      const remaining=new Date(row.approvalExpiresAt).getTime()-Date.now();
      node.textContent=remaining>0?`Pre-approval expires ${dateText(row.approvalExpiresAt)} (Toronto) · ${Math.ceil(remaining/60000)} minutes remaining.`:'Approval deadline passed. Refresh to re-raise for Dispatch approval.';
      root.querySelectorAll('[data-approval-dependent]').forEach(button=>{button.disabled=state.busy || remaining<=0 || button.form?.dataset.windowValid==='false';});
    } else {node.textContent=row.status==='expired'?'Approval expired. Re-raise this request for a new Dispatch approval.':'The approval clock starts when Dispatch pre-approves or proposes a time.';}
  }
  async function executeAction(name,fields={}) {
    const row=state.detail,payload={expectedRevision:row.revision,...fields},key=JSON.stringify({name,payload});
    if(state.operation?.key!==key) {state.operation={key,id:crypto.randomUUID()};}
    const result=await api(`${endpoint}/${row.id}/actions/${name}`,{method:'POST',body:JSON.stringify({...payload,operationId:state.operation.id})});
    state.operation=null;state.detail=result;state.draft=null;renderDetail();await loadList();await readDisplayed(result);
    if(result.status==='confirmed') {await loadInstruction(instructionOrderRefs(result)[0]);}
  }
  function instructionPath(ref=state.instructionRef) {return audience==='sales'?`/api/sales/delivery-instructions/orders/${encodeURIComponent(ref)}`:`/api/dispatch/orders/${encodeURIComponent(ref)}/delivery-instructions`;}
  async function loadInstruction(ref) {
    state.instructionRef=ref;state.instruction=null;
    if(!ref) {return;}
    const select=root.querySelector('[data-linked-order]');if(select) {select.value=ref;}
    try {const detail=await api(instructionPath(ref));if(state.instructionRef!==ref || state.detail?.status!=='confirmed') {return;}state.instruction=detail;renderInstruction();}
    catch(error) {const node=root.querySelector('[data-instructions]');if(node) {node.textContent=error.message;}}
  }
  function mediaUrl(item) {
    const url=new URL(item.contentUrl,location.origin);if(url.origin!==location.origin) {return '';}
    url.searchParams.set('token',readDispatchAuthToken());return url.pathname+url.search;
  }
  function renderInstruction() {
    const detail=state.instruction,node=root.querySelector('[data-instructions]');if(!node || !detail) {return;}
    const editable=audience==='sales' && detail.editable;
    node.innerHTML=`<p style="white-space:pre-wrap">${esc(detail.automatic?.text || '')}</p>
      <form data-form="instructions"><label>Extra delivery instructions<textarea name="additionalText" maxlength="5000" ${editable?'':'readonly'}>${esc(detail.additionalText)}</textarea></label>
      ${editable?'<button class="primary" style="margin-top:10px">Save instructions</button>':`<p class="dr-muted">${esc(detail.lockReason || 'Dispatch view')}</p>`}</form>
      ${editable?`<div class="dr-media-drop" data-media-drop><p>Drag and drop images or videos here</p><label>Add instruction media<input type="file" data-media-files multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime,video/webm,.heic,.heif,.mov"></label><small>Up to 5 files, 25 MB each. Images are compressed before upload.</small></div>`:''}
      <div class="dr-media-gallery">${(detail.media || []).map(item=>`<figure data-instruction-media>${item.mediaKind==='video'?`<video controls preload="metadata" src="${esc(mediaUrl(item))}"></video>`:`<a href="${esc(mediaUrl(item))}" target="_blank" rel="noopener"><img src="${esc(mediaUrl(item))}" alt="${esc(item.fileName || 'Delivery instruction image')}"></a>`}<figcaption>${esc(item.fileName)}</figcaption>${editable?`<button type="button" data-action="delete-media" data-id="${esc(item.id)}">Remove file</button>`:''}</figure>`).join('')}</div>`;
  }
  async function upload(files) {
    const detail=state.instruction;if(!detail?.editable || audience!=='sales' || !files.length) {return;}
    if(files.length+(detail.media || []).length>5) {throw new Error('Each Sales Order can contain up to five files.');}
    const prepared=await window.DeliveryInstructionUpload.prepareFiles(files);
    for(const file of prepared) {
      const current=state.instruction,ticket=await api(`${instructionPath()}/media-ticket`,{method:'POST',body:JSON.stringify({expectedRevision:current.revision,mimeType:file.type,byteSize:file.size,fileName:file.name})});
      const form=new FormData();form.append('file',file,file.name);
      const response=await fetch(ticket.upload.uploadUrl,{method:'POST',headers:{Authorization:`Bearer ${ticket.upload.token}`},body:form,signal:AbortSignal.timeout(120000)});
      const payload=await response.json();if(!response.ok || !payload.key) {throw new Error(payload.error || 'Media upload failed.');}
      state.instruction=await api(`${instructionPath()}/media`,{method:'POST',body:JSON.stringify({uploadId:ticket.uploadId,objectReference:`r2://${payload.key}`,mimeType:file.type,byteSize:file.size,fileName:file.name,expectedRevision:current.revision})});
    }
    renderInstruction();notice('Instruction media saved.');
  }
  async function run(work) {
    if(state.busy) {return;}state.busy=true;notice();root.setAttribute('aria-busy','true');
    try {await work();}
    catch(error) {notice(error.status===409?`${error.message} Refresh the request to review the latest version.`:error.message,true);}
    finally {state.busy=false;root.setAttribute('aria-busy','false');root.querySelectorAll('form').forEach(validateWindow);updateClock();}
  }
  async function refreshPage() {await loadList();if(state.detail && !state.draft) {await open(state.detail.id);}}
  async function discardDraft() {
    if(state.detail) {await open(state.detail.id);}
    else {state.draft=null;root.querySelector('[data-detail]').textContent='Select a request or create a new one.';}
  }
  function editYards(button) {
    const draft=collectDraft();
    if(button.dataset.action==='add-yard') {draft.outbounds.push({originYardCode:state.meta.outboundYards.find(code=>!draft.outbounds.some(yard=>yard.originYardCode===code)),totalUnits:1});}
    else {draft.outbounds.splice(Number(button.dataset.index),1);}
    state.draft=draft;state.quote=null;renderForm(draft);
  }
  function editTripLegs(button) {
    const draft=collectDraft();
    if(button.dataset.action==='add-trip-leg') {draft.tripLegs.splice(draft.tripLegs.length-1,0,{pickupAddress:draft.tripLegs.at(-2)?.dropoffAddress || '',dropoffAddress:'',totalUnits:1});}
    else if(draft.tripLegs.length>2) {
      const pickup=draft.tripLegs[0].pickupYardCode,dropoff=draft.tripLegs.at(-1).dropoffYardCode;
      draft.tripLegs.splice(Number(button.dataset.index),1);draft.tripLegs[0].pickupYardCode=pickup;delete draft.tripLegs[0].pickupAddress;
      draft.tripLegs.at(-1).dropoffYardCode=dropoff;delete draft.tripLegs.at(-1).dropoffAddress;
    }
    state.draft=draft;state.quote=null;renderForm(draft);
  }
  async function deleteMedia(button) {
    state.instruction=await api(`${instructionPath()}/media/${encodeURIComponent(button.dataset.id)}`,{method:'DELETE',body:JSON.stringify({expectedRevision:state.instruction.revision})});renderInstruction();
  }
  const clickActions={new:()=>startDraft(),open:button=>open(button.dataset.id),refresh:refreshPage,reload:discardDraft,discard:discardDraft,
    quote:calculateQuote,edit:()=>startDraft(state.detail,'edit'),reraise:()=>startDraft(state.detail,'reraise'),
    'add-yard':editYards,'remove-yard':editYards,'add-trip-leg':editTripLegs,'remove-trip-leg':editTripLegs,'add-order':editSalesOrders,'remove-order':editSalesOrders,
    'preview-estimate':openDocumentPreview,'preview-order':openDocumentPreview,
    'exchange-order':button=>{const input=button.closest('[data-sales-order]').querySelector('input');input.focus();input.select();},'delete-media':deleteMedia,logout:dispatchLogout};
  root.addEventListener('click',event=>{
    const button=event.target.closest('[data-action]');if(!button) {return;}
    const handler=clickActions[button.dataset.action];
    void run(()=>handler?handler(button):executeAction(button.dataset.action));
  });
  root.addEventListener('submit',event=>{
    const form=event.target;if(!form.dataset.form) {return;}event.preventDefault();
    form.querySelectorAll('[data-time-input]').forEach(input=>{input.value=formattedTime(input.value);});
    validateWindow(form);if(!form.reportValidity()) {return;}
    void run(async()=>{
      const fields=new FormData(form),kind=form.dataset.form;
      if(kind==='request') {
        if(!state.quote) {throw new Error('Calculate the delivery charge before submitting.');}
        const draft=collectDraft(),payload={...pricingPayload(draft),requestedWindow:draft.requestedWindow,customerName:draft.customerName,remarks:draft.remarks,estimateRef:draft.estimateRef,quoteId:state.quote.id};
        if(draft.action==='create') {const row=await api(endpoint,{method:'POST',body:JSON.stringify({...payload,operationId:crypto.randomUUID()})});await loadList();await open(row.id);}
        else {await executeAction(draft.action,payload);}
      } else if(kind==='reply') {
        const message=String(fields.get('message') || '').trim();if(!message) {throw new Error('Enter a reply before sending.');}
        await executeAction('reply',{message});
      } else if(kind==='secure' || kind==='relink') {await executeAction(kind,{salesOrderRefs:fields.getAll('salesOrderRefs').map(ref=>String(ref).trim().toUpperCase())});}
      else if(kind==='instructions') {state.instruction=await api(instructionPath(),{method:'PUT',body:JSON.stringify({expectedRevision:state.instruction.revision,additionalText:fields.get('additionalText')})});renderInstruction();notice('Delivery instructions saved.');}
      else if(kind==='settings') {
        const values=Object.fromEntries(['pos','bin','approvalHours','reminderHours'].map(key=>[key,Number(fields.get(key))]));
        state.meta.settings=await api(`${endpoint}/settings`,{method:'PUT',body:JSON.stringify({...values,expectedRevision:state.meta.settings.revision})});notice('Request settings saved.');
      } else {await executeAction(kind,{window:{date:fields.get('date'),start:fields.get('start'),end:fields.get('end')},message:fields.get('message')});}
    });
  });
  root.addEventListener('input',event=>{
    if(event.target.matches('[name=date],[name=start],[name=end]')) {validateWindow(event.target.form);}
    if(event.target.matches('[data-search]')) {clearTimeout(searchTimer);searchTimer=setTimeout(()=>void loadList().catch(error=>notice(error.message,true)),250);}
    if(event.target.matches('[data-pricing]')) {state.quote=null;const quote=root.querySelector('[data-quote]');if(quote) {quote.textContent='Delivery details changed. Calculate the charge again.';}const submit=root.querySelector('[data-submit]');if(submit) {submit.disabled=true;}const total=root.querySelector('[data-total-units]');if(total) {total.textContent=String(collectDraft().totalUnits);}}
  });
  root.addEventListener('change',event=>{
    if(event.target.matches('[data-time-input]')) {event.target.value=formattedTime(event.target.value);}
    if(event.target.matches('[name=date],[name=start],[name=end]')) {validateWindow(event.target.form);}
    if(event.target.matches('[data-status]')) {void loadList().catch(error=>notice(error.message,true));}
    if(event.target.matches('[data-linked-order]')) {void run(()=>loadInstruction(event.target.value));}
    if(event.target.matches('[name=loadType]')) {
      state.draft=collectDraft();state.draft.outbounds=state.draft.outbounds.map(yard=>({originYardCode:yard.originYardCode,totalUnits:1,
        ...(state.draft.loadType==='pos'?{fullPosQty:1,loosePosQty:0}:{})}));
      state.quote=null;renderForm(state.draft);
    }
    if(event.target.matches('[name=tripType]')) {
      state.draft=collectDraft();
      if(state.draft.tripType==='multi_stop' && state.draft.tripLegs.length<2) {state.draft.tripLegs=[
        {pickupYardCode:state.draft.outbounds[0].originYardCode,dropoffAddress:state.draft.deliveryAddress,totalUnits:state.draft.totalUnits},
        {pickupAddress:state.draft.deliveryAddress,dropoffYardCode:state.draft.outbounds[0].originYardCode,totalUnits:1}];}
      state.quote=null;renderForm(state.draft);
    }
    if(event.target.matches('[data-media-files]')) {void run(()=>upload([...event.target.files]));}
  });
  root.addEventListener('dragover',event=>{const drop=event.target.closest('[data-media-drop]');if(drop && window.DeliveryInstructionUpload.isFileDrag(event)){event.preventDefault();drop.classList.add('dragging');}});
  root.addEventListener('dragleave',event=>event.target.closest('[data-media-drop]')?.classList.remove('dragging'));
  root.addEventListener('drop',event=>{const drop=event.target.closest('[data-media-drop]');if(!drop) {return;}event.preventDefault();drop.classList.remove('dragging');void run(()=>upload([...event.dataTransfer.files]));});
  window.MBBSDeliveryRequestPage={currentRequestId:null,currentRequestRevision:null};
  window.addEventListener('mbbs-auth-operator-changed',event=>{
    if(state.actor && event.detail?.operator?.id!==state.actor.id) {state.generation++;state.actor=null;state.detail=null;state.instruction=null;events?.close();clearInterval(poll);root.textContent='The signed-in account changed. Refresh to sign in.';}
  });
  window.addEventListener('pagehide',()=>{events?.close();clearInterval(poll);});
  setInterval(updateClock,1000);
  requireDispatchLogin({mount:root,roles:[audience==='sales'?'sales':'dispatcher','admin'],allowPublicSales:false,onReady:async actor=>{
    state.actor=actor;
    try {
      state.meta=await api(`${endpoint}/meta`);shell();await loadList();
      const id=new URL(location.href).searchParams.get('request');if(id) {await open(id);}
      events=new EventSource(`/api/events?client=delivery-requests&token=${encodeURIComponent(readDispatchAuthToken())}`);
      events.addEventListener('app-event',message=>{try {if(JSON.parse(message.data).type==='delivery.requests.updated') {void loadList().catch(()=>{});}}catch{/* Ignore malformed invalidations. */}});
      poll=setInterval(()=>void loadList().catch(()=>{}),30000);
    } catch(error) {root.textContent=error.message;}
  }});
})();

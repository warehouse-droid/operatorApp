/* Dispatcher configuration for Delivery, Exchange and Collection orders. */
(() => {
  const esc=value=>String(value ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const local=value=>{
    if (!value) return "";
    const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:"America/Toronto",
      year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"})
      .formatToParts(new Date(value)).map(p=>[p.type,p.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  };
  const option=(id,label,selected)=>`<option value="${esc(id)}" ${String(id)===String(selected) ? "selected" : ""}>${esc(label)}</option>`;
  const windowFields=(role,label,window)=>`<fieldset data-window="${role}"><legend>Order window · ${label}</legend>
    <p>${esc(local(window.startAt).replace("T"," "))} – ${esc(local(window.endAt).replace("T"," "))} · Toronto time</p>
    <p>Set by Front Desk.</p></fieldset>`;
  function refreshCargoPreview(editor,data,form) {
    const field=name=>form.elements.namedItem(name)?.value;
    const role=editor.data.role,part=data.workflow.parts.find(p=>p.role===role);
    let destination=editor.data.destination,steps=[];
    if(role==='delivery') {
      const asset=data.assets.find(a=>a.asset_id===field('deliveryAssetId'));
      const same=field('sequence')==='collection_first' && field('reuse')==='same_bin';
      if(asset && asset.location_kind!=='truck' && !same) steps.push({actionCode:'collect_empty_bin',displayName:'Pick up empty bin',location:{address:asset.source_address}});
      steps.push({actionCode:'deliver_bin',displayName:'Deliver bin',location:destination});
    } else {
      steps=(part?.steps || []).filter(s=>!s.actionCode.startsWith('cargo_') && s.actionCode!=='return_bin');
      const dump=data.dumping.find(d=>d.dump_site_id===field('dumpSiteId'));
      if(!steps.length) steps=[{actionCode:'pickup_bin',displayName:'Collect bin',location:editor.initialDestination},{actionCode:'dump_bin',displayName:'Dump bin',location:{address:dump?.dump_name || 'Choose dump site'}}];
      if(field('destinationKind')==='yard') {
        destination=editor.data.yards.find(y=>y.id===field('yardId')) || destination;
        steps.push({actionCode:'return_bin',displayName:'Return bin',location:destination});
      }
    }
    editor.updatePreview(steps,destination);
  }
  async function open(visitId,{headers,onSaved,withPlanLeases=async(plans,save)=>{if(plans.length) throw new Error('Open this route from the planning screen.');return save([]);}}) {
    const response=await fetch(`/api/mbt/planning/workflows/${encodeURIComponent(visitId)}`,{headers:headers()});
    const data=await response.json();
    if (!response.ok) throw new Error(data.error || "BIN workflow could not be loaded.");
    const w=data.workflow,delivery=w.kind!=="collection",collection=w.kind!=="delivery",exchange=w.kind==="exchange";
    const configured=w.configuration,routeOnly=Boolean(data.configurationIssue);
    const editable=data.editability || {sequence:!routeOnly,delivery:!routeOnly,collection:!routeOnly};
    const editingRole=w.parts.find(p=>p.visitId===visitId)?.role || (w.kind==='collection'?'collection':'delivery');
    let cargoEditor=null;
    const configuredDelivery=configured?.parts?.find(p=>p.role==="delivery");
    const selectedDelivery=w.parts.find(p=>p.role==="delivery")?.assetId;
    const destination=configured?.parts?.find(p=>p.role==="collection")?.destination;
    const destinationKind=destination?.kind || "yard";
    const receivingTargets=data.targets.slice();
    if (destination?.orderId && !receivingTargets.some(t=>t.order_id===destination.orderId)) {
      receivingTargets.unshift({order_id:destination.orderId,display_reference:destination.reference,order_kind:'delivery',customer:'Currently linked'});
    }
    const dialog=document.createElement("dialog");
    dialog.className="bin-workflow-dialog";
    dialog.setAttribute("aria-label",`Plan ${w.reference}`);
    const emptyAssets=data.assets.filter(a=>a.bin_type_id===data.binTypeId && (
      (a.asset_id===selectedDelivery && !editable.delivery) || a.availability?.available));
    const collectionAsset=data.assets.find(a=>a.asset_id===data.collectionAssetId);
    const differentType=exchange && collectionAsset && collectionAsset.bin_type_id!==data.binTypeId;
    const materialIssue=collection && data.orderMaterial?.issue;
    dialog.innerHTML=`<form><header><div><p>BIN ${esc(w.kind)}</p><h2>${esc(w.reference)}</h2></div>
      <button type="button" data-close aria-label="Close workflow">Close</button></header>
      <p>References identify this rental. Physical bin numbers identify the equipment to move.</p>
      ${routeOnly?`<p>${esc(data.configurationIssue)} Cargo can be updated before its work starts.</p>`:''}
      <fieldset data-workflow-fields ${routeOnly?'disabled':''}>
      ${exchange ? `<fieldset ${editable.sequence?'':'disabled'}><legend>Exchange sequence</legend>
        ${editable.sequence?'':'<p>The sequence stays locked while either exchange leg is planned or started.</p>'}<label>Perform first<select name="sequence">
        ${option("delivery_first","Delivery first · collect the old bin later",configured?.sequence || "delivery_first")}
        ${option("collection_first","Collection first · replace the same day",configured?.sequence)}</select></label>
        <label>Replacement<select name="reuse">${option("different_bin","Different empty bin",configured?.reuse || "different_bin")}
        ${option("same_bin","Same bin after dumping",configured?.reuse)}</select></label>
        <p data-sequence-help></p></fieldset>` : ""}
      ${delivery ? `<fieldset data-delivery-bin ${editable.delivery?'':'disabled'}><legend>Delivery bin</legend>
        <label>Physical bin<select name="deliveryAssetId" required><option value="">Choose empty bin</option>
          ${emptyAssets.map(a=>option(a.asset_id,`${a.asset_code} · ${a.type_code} · ${a.availability?.location?.name || a.yard_name || a.plate || a.location_reference || a.lifecycle_status}${a.availability?.projected ? ` · after ${a.availability.predecessorReference} · ${local(a.availability.availableAt).replace("T"," ")}` : ""}`,
            selectedDelivery)).join("")}</select></label>
        <p data-source>Pickup follows the bin's available location in the saved plan.</p></fieldset>
        ${windowFields("delivery","Delivery",w.parts.find(p=>p.role==="delivery")?.window || data.defaultWindow)}` : ""}
      ${collection ? `<fieldset ${editable.collection?'':'disabled'}><legend>Collection and mandatory dumping</legend>
        <p>Collect <strong>${esc(collectionAsset?.asset_code || "the rental's current bin")}</strong>
          ${collectionAsset ? ` · ${esc(collectionAsset.type_code)}` : ""}</p>
        <input type="hidden" name="collectionAssetId" value="${esc(data.collectionAssetId || "")}">
        <p data-order-material>Ordered material: <strong>${esc(data.orderMaterial?.displayName || "Not defined")}</strong></p>
        ${materialIssue ? `<p role="alert">${esc(materialIssue)}</p>` : ""}
        <label>Dump site<select name="dumpSiteId" required><option value="">Choose dump site</option>
          ${data.dumping.map(d=>option(d.dump_site_id,d.dump_name,configured?.dumpSiteId)).join("")}</select></label>
        </fieldset>${windowFields("collection","Collection",w.parts.find(p=>p.role==="collection")?.window || data.defaultWindow)}
        <fieldset data-destination ${editable.collection?'':'disabled'}><legend>After dumping</legend>
          <label>Destination<select name="destinationKind">${option("yard","Return to an approved yard",destinationKind)}
          ${option("delivery","Deliver to the next customer",destinationKind)}</select></label>
          <label data-yard>Return yard<select name="yardId">${data.yards.map(y=>option(y.yard_id,`${y.yard_code} · ${y.display_name}`,destination?.location?.id)).join("")}</select></label>
          <label data-next hidden>Receiving delivery order<select name="nextOrderId"><option value="">Choose receiving order</option>
            ${receivingTargets.map(t=>option(t.order_id,`${t.display_reference}${t.order_kind==="exchange" ? "D" : ""} · ${t.customer || "Customer"}`,destination?.orderId)).join("")}</select></label>
          <p data-next-help hidden>Only orders matching this physical bin's size and type are shown. The receiving order keeps its own delivery reference and takes this bin after dumping.</p>
        </fieldset>` : ""}
      ${w.parts.length ? `<p>Parts: ${w.parts.map(p=>esc(p.reference)).join(" · ")}</p>` : ""}
      </fieldset><section data-bin-cargo></section>
      <p role="alert" data-error></p><footer><button type="submit" class="primary" disabled>Save route</button></footer></form>`;
    const form=dialog.querySelector("form"),field=name=>form.elements.namedItem(name);
    window.BinAssetSearch.attach(field('deliveryAssetId'));
    const canSave=()=>Boolean(cargoEditor) && (routeOnly?cargoEditor.editable:!materialIssue);
    function refresh() {
      if (differentType) {
        field("sequence").value="delivery_first";
        field("sequence").querySelector('option[value="collection_first"]').disabled=true;
        field("reuse").value="different_bin";
      }
      const same=exchange && field("sequence").value==="collection_first" && field("reuse").value==="same_bin";
      if (exchange) {
        field("reuse").querySelector('option[value="same_bin"]').disabled=field("sequence").value==="delivery_first";
        if (field("sequence").value==="delivery_first") field("reuse").value="different_bin";
        dialog.querySelector("[data-sequence-help]").textContent=differentType
          ? "The replacement is a different size or type. Deliver a different bin first, then collect the old bin."
          : field("sequence").value==="delivery_first"
          ? "Deliver the replacement first. The old bin remains a separate collection, even on a later day."
          : same ? "Collect, dump, then redeliver this same bin on the same Toronto calendar day."
            : "The replacement may be delivered after confirmed collection, on the same Toronto calendar day. Dumping the old bin remains required.";
      }
      if (delivery) {
        dialog.querySelector("[data-delivery-bin]").hidden=same;
        field("deliveryAssetId").required=!same;
        const a=data.assets.find(a=>a.asset_id===field("deliveryAssetId").value);
        const planned=a?.asset_id===selectedDelivery && configuredDelivery?.source?.planned;
        dialog.querySelector("[data-source]").textContent=planned
          ? `${configuredDelivery.source.availabilityPredecessorId?'Planned return':configuredDelivery.source.transportTripId?'After cargo drop':'After dumping'}: ${configuredDelivery.source.address}`
          : a ? `Pickup: ${a.source_address || a.yard_name || a.location_reference}`
            : "Pickup follows the bin's available location in the saved plan.";
      }
      if (collection) {
        dialog.querySelector("[data-destination]").hidden=same;
        const next=field("destinationKind").value==="delivery";
        dialog.querySelector("[data-yard]").hidden=next;
        dialog.querySelector("[data-next]").hidden=!next;
        dialog.querySelector("[data-next-help]").hidden=!next;
        field("nextOrderId").required=next && !same;
      }
      if (cargoEditor && !routeOnly) refreshCargoPreview(cargoEditor,data,form);
    }
    form.addEventListener("change",refresh); refresh();
    dialog.querySelector("[data-close]").onclick=()=>dialog.close();
    dialog.onclose=()=>dialog.remove();
    let saving=false,idempotencyKey=crypto.randomUUID(),savedPayload="";
    form.onsubmit=async event=>{
      event.preventDefault(); if (saving || !canSave() || !form.reportValidity()) return;
      const body={expectedRevision:w.revision,reason:"Dispatcher configured BIN route"};
      if (editable[cargoEditor.data.role]) Object.assign(body,{cargo:cargoEditor.value(),cargoRole:cargoEditor.data.role});
      if (exchange) Object.assign(body,{sequence:field("sequence").value,reuse:field("reuse").value});
      if (editable.delivery) Object.assign(body,{deliveryAssetId:field("deliveryAssetId").value});
      if (editable.collection) {
        Object.assign(body,{collectionAssetId:field("collectionAssetId").value,dumpSiteId:field("dumpSiteId").value,
          destination:field("destinationKind").value==="yard" ? {kind:"yard",yardId:field("yardId").value}
            : {kind:"delivery",orderId:field("nextOrderId").value}});
      }
      const payload=JSON.stringify(body);
      if (savedPayload && savedPayload!==payload) idempotencyKey=crypto.randomUUID();
      savedPayload=payload;saving=true;form.querySelector('[type="submit"]').disabled=true;
      dialog.querySelector("[data-error]").textContent="";
      try {
        if (routeOnly) {
          await cargoEditor.save(idempotencyKey,withPlanLeases,onSaved);dialog.close();return;
        }
        const response=await fetch(`/api/mbt/planning/workflows/${encodeURIComponent(w.orderId)}`,{
          method:"POST",headers:{...headers(),"Content-Type":"application/json","Idempotency-Key":idempotencyKey},body:payload});
        const result=await response.json();
        if (!response.ok) throw new Error(result.error || "The workflow could not be saved.");
        await onSaved(result);dialog.close();
      } catch (error) {dialog.querySelector("[data-error]").textContent=error.message;}
      finally {saving=false;form.querySelector('[type="submit"]').disabled=!canSave();}
    };
    document.body.append(dialog);dialog.showModal();
    try {
      cargoEditor=await window.BinCargoUI.mount(dialog.querySelector('[data-bin-cargo]'),visitId,
        {headers,editable:routeOnly || editable[editingRole],workflowEditing:!routeOnly && editable[editingRole]});
      refresh();form.querySelector('[type="submit"]').disabled=!canSave();
    } catch(error) {dialog.querySelector('[data-error]').textContent=error.message;}
  }
  async function handoff(visitId,{headers,onSaved}) {
    const response=await fetch(`/api/mbt/planning/workflows/${encodeURIComponent(visitId)}`,{headers:headers()});
    const data=await response.json();
    if (!response.ok) throw new Error(data.error || "BIN custody could not be loaded.");
    const ids=new Set(data.workflow.parts.map(p=>p.assetId));
    const assets=data.assets.filter(a=>ids.has(a.asset_id) && a.location_kind==="truck");
    if (!assets.length) throw new Error("No bin from this workflow is currently recorded aboard a truck.");
    const dialog=document.createElement("dialog");dialog.className="bin-workflow-dialog";dialog.setAttribute("aria-label","Record physical bin handoff");
    dialog.innerHTML=`<form><header><h2>Record physical bin handoff</h2><button type="button" data-close>Close</button></header>
      <p>Record the transfer after the receiving truck has physically taken the bin.</p>
      <label>Bin and current truck<select name="assetId">${assets.map(a=>option(a.asset_id,`${a.asset_code} · ${a.plate || a.truck_id}`,"")).join("")}</select></label>
      <label>Receiving truck<select name="toTruckId" required><option value="">Choose receiving truck</option>
        ${data.trucks.map(t=>option(t.id,t.plate,"")).join("")}</select></label>
      <label>Confirm physical bin number<input name="scannedBinCode" required autocomplete="off"></label>
      <label>Handoff location<input name="place" required maxlength="300"></label>
      <label>Reason<input name="reason" required maxlength="1000"></label>
      <label><input name="confirmed" type="checkbox" required>The physical transfer is complete.</label>
      <p role="alert"></p><button type="submit" class="primary">Record handoff</button></form>`;
    const form=dialog.querySelector("form"),field=n=>form.elements.namedItem(n),key=crypto.randomUUID();
    form.onsubmit=async e=>{
      e.preventDefault();const button=form.querySelector('[type="submit"]');button.disabled=true;
      const asset=assets.find(a=>a.asset_id===field("assetId").value);
      try {
        const response=await fetch(`/api/mbt/planning/workflows/${encodeURIComponent(data.workflow.orderId)}/handoffs`,{
          method:"POST",headers:{...headers(),"Content-Type":"application/json","Idempotency-Key":key},
          body:JSON.stringify({assetId:asset.asset_id,fromTruckId:String(asset.truck_id),toTruckId:field("toTruckId").value,
            expectedStateRevision:Number(asset.state_revision),scannedBinCode:field("scannedBinCode").value,
            place:field("place").value,reason:field("reason").value,confirmed:field("confirmed").checked})});
        const result=await response.json();if (!response.ok) throw new Error(result.error || "Handoff could not be recorded.");
        await onSaved(result);dialog.close();
      } catch(error) {form.querySelector('[role="alert"]').textContent=error.message;}
      finally {button.disabled=false;}
    };
    dialog.querySelector("[data-close]").onclick=()=>dialog.close();dialog.onclose=()=>dialog.remove();
    document.body.append(dialog);dialog.showModal();
  }
  async function selectBin(visitId,{headers,onSaved,withPlanLeases}) {
    const response=await fetch(`/api/mbt/planning/workflows/${encodeURIComponent(visitId)}`,{headers:headers()});
    const data=await response.json();
    if (!response.ok) throw new Error(data.error || "BIN selection could not be loaded.");
    const selection=data.binSelection,current=data.assets.find(a=>a.asset_id===selection.currentAssetId);
    const dialog=document.createElement("dialog");dialog.className="bin-workflow-dialog";dialog.setAttribute("aria-label","Change bin");
    dialog.innerHTML=`<form><header><h2>Change bin</h2><button type="button" data-close>Close</button></header>
      <p>${esc(data.workflow.reference)} · Current bin: <strong>${esc(current?.asset_code || "Unselected")}</strong></p>
      <p>Choose the physical bin for this delivery. Released driver instructions update when you save.</p>
      ${selection.eligible ? `<label>Physical bin<select name="assetId" required><option value="">Choose another empty bin</option>
        ${selection.choices.filter(a=>a.asset_id!==selection.currentAssetId).map(a=>option(a.asset_id,`${a.asset_code} · ${a.type_code} · ${a.source_address}`,"")).join("")}
        </select></label><p data-source></p>` : `<p>${esc(selection.reason)}</p>`}
      ${selection.plans.length ? `<p>Affected plan dates: ${selection.plans.map(p=>esc(p.planDate)).join(", ")}</p>` : ""}
      <p role="alert"></p><footer><button type="submit" class="primary" ${selection.eligible ? "" : "disabled"}>Save bin selection</button></footer></form>`;
    const form=dialog.querySelector("form"),field=form.elements.namedItem("assetId");
    window.BinAssetSearch.attach(field);
    if (field) field.onchange=()=>{const asset=selection.choices.find(a=>a.asset_id===field.value);
      dialog.querySelector("[data-source]").textContent=asset ? `Pickup: ${asset.source_address}` : "";};
    let saving=false,key=crypto.randomUUID(),lastAssetId="";
    form.onsubmit=async event=>{
      event.preventDefault();if (saving || !selection.eligible || !field.value) return;
      const asset=selection.choices.find(a=>a.asset_id===field.value);
      if (lastAssetId && lastAssetId!==asset.asset_id) key=crypto.randomUUID();lastAssetId=asset.asset_id;
      const button=form.querySelector('[type="submit"]');saving=true;button.disabled=true;
      try {
        await withPlanLeases(selection.plans,async plans=>{
          const response=await fetch(`/api/mbt/planning/workflows/${encodeURIComponent(visitId)}/bin-selection`,{
            method:"POST",headers:{...headers(),"Content-Type":"application/json","Idempotency-Key":key},
            body:JSON.stringify({assetId:asset.asset_id,expectedStateRevision:Number(asset.state_revision),
              expectedRevision:data.workflow.revision,expectedVisits:selection.expectedVisits,plans,reason:"Dispatcher changed assigned bin"})});
          const result=await response.json();if (!response.ok) throw new Error(result.error || "The bin could not be changed.");
          await onSaved(result);dialog.close();
        });
      } catch(error) {form.querySelector('[role="alert"]').textContent=error.message;}
      finally {saving=false;button.disabled=false;}
    };
    dialog.querySelector("[data-close]").onclick=()=>dialog.close();dialog.onclose=()=>dialog.remove();
    document.body.append(dialog);dialog.showModal();
  }
  window.BinOrderWorkflowUI={open,handoff,selectBin};
})();

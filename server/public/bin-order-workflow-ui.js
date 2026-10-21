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
  const windowFields=(role,label,window)=>`<fieldset data-window="${role}"><legend>${label} window · Toronto time</legend>
    <label>Start<input type="datetime-local" name="${role}Start" value="${esc(local(window.startAt))}" required></label>
    <label>Finish<input type="datetime-local" name="${role}End" value="${esc(local(window.endAt))}" required></label></fieldset>`;
  async function open(visitId,{headers,onSaved}) {
    const response=await fetch(`/api/mbt/planning/workflows/${encodeURIComponent(visitId)}`,{headers:headers()});
    const data=await response.json();
    if (!response.ok) throw new Error(data.error || "BIN workflow could not be loaded.");
    const w=data.workflow,delivery=w.kind!=="collection",collection=w.kind!=="delivery",exchange=w.kind==="exchange";
    const configured=w.configuration;
    const configuredDelivery=configured?.parts?.find(p=>p.role==="delivery");
    const selectedDelivery=w.parts.find(p=>p.role==="delivery")?.assetId;
    const destination=configured?.parts?.find(p=>p.role==="collection")?.destination;
    const destinationKind=destination?.kind || "yard";
    const dialog=document.createElement("dialog");
    dialog.className="bin-workflow-dialog";
    dialog.setAttribute("aria-label",`Configure ${w.reference}`);
    const emptyAssets=data.assets.filter(a=>a.bin_type_id===data.binTypeId && (
      (a.asset_id===selectedDelivery && configuredDelivery?.source?.planned) ||
      (["available","on_truck","at_dump"].includes(a.lifecycle_status)
        && (a.lifecycle_status!=="on_truck" || /empty|dump/.test(a.movement_type)))));
    const collectionAsset=data.assets.find(a=>a.asset_id===data.collectionAssetId);
    dialog.innerHTML=`<form><header><div><p>BIN ${esc(w.kind)}</p><h2>${esc(w.reference)}</h2></div>
      <button type="button" data-close aria-label="Close workflow">Close</button></header>
      <p>References identify this rental. Physical bin numbers identify the equipment to move.</p>
      ${exchange ? `<fieldset><legend>Exchange sequence</legend><label>Perform first<select name="sequence">
        ${option("delivery_first","Delivery first · collect the old bin later",configured?.sequence || "delivery_first")}
        ${option("collection_first","Collection first · replace the same day",configured?.sequence)}</select></label>
        <label>Replacement<select name="reuse">${option("different_bin","Different empty bin",configured?.reuse || "different_bin")}
        ${option("same_bin","Same bin after dumping",configured?.reuse)}</select></label>
        <p data-sequence-help></p></fieldset>` : ""}
      ${delivery ? `<fieldset data-delivery-bin><legend>Delivery bin</legend>
        <label>Physical bin<select name="deliveryAssetId" required><option value="">Choose empty bin</option>
          ${emptyAssets.map(a=>option(a.asset_id,`${a.asset_code} · ${a.type_code} · ${a.yard_name || a.plate || a.location_reference || a.lifecycle_status}`,
            selectedDelivery)).join("")}</select></label>
        <p data-source>Pickup follows the selected bin's last confirmed location.</p></fieldset>
        ${windowFields("delivery","Delivery",w.parts.find(p=>p.role==="delivery")?.window || data.defaultWindow)}` : ""}
      ${collection ? `<fieldset><legend>Collection and mandatory dumping</legend>
        <p>Collect <strong>${esc(collectionAsset?.asset_code || "the rental's current bin")}</strong>
          ${collectionAsset ? ` · ${esc(collectionAsset.type_code)}` : ""}</p>
        <input type="hidden" name="collectionAssetId" value="${esc(data.collectionAssetId || "")}">
        <label>Dump site and accepted material<select name="dumpChoice" required><option value="">Choose dump and material</option>
          ${data.dumping.map(d=>option(`${d.dump_site_id}|${d.material_id}`,`${d.dump_name} · ${d.material_name}`,
            configured ? `${configured.dumpSiteId}|${configured.materialId}` : "")).join("")}</select></label>
        </fieldset>${windowFields("collection","Collection",w.parts.find(p=>p.role==="collection")?.window || data.defaultWindow)}
        <fieldset data-destination><legend>After dumping</legend>
          <label>Destination<select name="destinationKind">${option("yard","Return to an approved yard",destinationKind)}
          ${option("delivery","Deliver to the next customer",destinationKind)}</select></label>
          <label data-yard>Return yard<select name="yardId">${data.yards.map(y=>option(y.yard_id,`${y.yard_code} · ${y.display_name}`,destination?.location?.id)).join("")}</select></label>
          <label data-next hidden>Receiving delivery<select name="nextOrderId"><option value="">Choose matching bin type</option>
            ${data.targets.map(t=>option(t.order_id,`${t.display_reference}${t.order_kind==="exchange" ? "D" : ""} · ${t.customer || "Customer"}`,destination?.orderId)).join("")}</select></label>
          <p data-next-help hidden>The receiving rental keeps its own delivery reference. Its delivery completes this bin's onward journey after the dump.</p>
        </fieldset>` : ""}
      ${w.parts.length ? `<p>Parts: ${w.parts.map(p=>esc(p.reference)).join(" · ")}</p>` : ""}
      <p role="alert" data-error></p><footer><button type="submit" class="primary">Save workflow</button></footer></form>`;
    const form=dialog.querySelector("form"),field=name=>form.elements.namedItem(name);
    function refresh() {
      const same=exchange && field("sequence").value==="collection_first" && field("reuse").value==="same_bin";
      if (exchange) {
        field("reuse").querySelector('option[value="same_bin"]').disabled=field("sequence").value==="delivery_first";
        if (field("sequence").value==="delivery_first") field("reuse").value="different_bin";
        dialog.querySelector("[data-sequence-help]").textContent=field("sequence").value==="delivery_first"
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
          ? `After dumping: ${configuredDelivery.source.address}`
          : a ? `Pickup: ${a.source_address || a.yard_name || a.location_reference}`
            : "Pickup follows the selected bin's last confirmed location.";
      }
      if (collection) {
        dialog.querySelector("[data-destination]").hidden=same;
        const next=field("destinationKind").value==="delivery";
        dialog.querySelector("[data-yard]").hidden=next;
        dialog.querySelector("[data-next]").hidden=!next;
        dialog.querySelector("[data-next-help]").hidden=!next;
        field("nextOrderId").required=next && !same;
      }
    }
    form.addEventListener("change",refresh); refresh();
    dialog.querySelector("[data-close]").onclick=()=>dialog.close();
    dialog.onclose=()=>dialog.remove();
    let saving=false,idempotencyKey=crypto.randomUUID(),savedPayload="";
    form.onsubmit=async event=>{
      event.preventDefault(); if (saving) return;
      const body={expectedRevision:w.revision,reason:"Dispatcher configured BIN route"};
      if (exchange) Object.assign(body,{sequence:field("sequence").value,reuse:field("reuse").value});
      if (delivery) Object.assign(body,{deliveryAssetId:field("deliveryAssetId").value,
        deliveryWindow:{startLocal:field("deliveryStart").value,endLocal:field("deliveryEnd").value}});
      if (collection) {
        const [dumpSiteId,materialId]=field("dumpChoice").value.split("|");
        Object.assign(body,{collectionAssetId:field("collectionAssetId").value,dumpSiteId,materialId,
          collectionWindow:{startLocal:field("collectionStart").value,endLocal:field("collectionEnd").value},
          destination:field("destinationKind").value==="yard" ? {kind:"yard",yardId:field("yardId").value}
            : {kind:"delivery",orderId:field("nextOrderId").value}});
      }
      const payload=JSON.stringify(body);
      if (savedPayload && savedPayload!==payload) idempotencyKey=crypto.randomUUID();
      savedPayload=payload;saving=true;form.querySelector('[type="submit"]').disabled=true;
      dialog.querySelector("[data-error]").textContent="";
      try {
        const response=await fetch(`/api/mbt/planning/workflows/${encodeURIComponent(w.orderId)}`,{
          method:"POST",headers:{...headers(),"Content-Type":"application/json","Idempotency-Key":idempotencyKey},body:payload});
        const result=await response.json();
        if (!response.ok) throw new Error(result.error || "The workflow could not be saved.");
        await onSaved(result);dialog.close();
      } catch (error) {dialog.querySelector("[data-error]").textContent=error.message;}
      finally {saving=false;form.querySelector('[type="submit"]').disabled=false;}
    };
    document.body.append(dialog);dialog.showModal();
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
  window.BinOrderWorkflowUI={open,handoff};
})();

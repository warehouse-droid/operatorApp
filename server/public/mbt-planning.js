/* BIN domain adapter. Dispatch owns the complete planner/pool layout, timing,
 * maps, edit lease, save queue and journal. Ordinary Dispatch never loads this. */
/* global saveCurrentPlanNow, planEditLeaseToken, dispatchSessionId, currentPlanDate,
  localPlanDirty, dispatchAuthHeaders, escapeHtml, isDispatchPlanEditor,
  mbtBinAssetSelectionByVisit, ensureDispatchPlanEditor, render */
/* global routeNotice: writable, applyPlannedAssignments: writable, jumpToPlannedOrder: writable */
/* global searchText, mbtBinDispatchError: writable, saveQueued, saveInFlight, orderById, selectedOrder, mbtEligibleAssetChoice, mbtSelectedEligibleAsset */
/* global mbtBinFrontLegDraggable */
/* exported routeNotice */
(() => {
  const state = { ready: false, cards: new Map(), pool: [], nextOffset: null,
    total: 0, search: "", filter: "delivery", request: 0, navigation: 0, loadingDate: false, truckIds: new Set(), rawPlan: null,capacityWarnings:[] };
  const filters = [["delivery", "Delivery"], ["exchange", "Exchange"], ["collection", "Collection"], ["mbr_agg", "MBR/Agg"]];
  const localTime = value => value ? new Intl.DateTimeFormat("en-GB", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "";
  const visitId = stop => String(stop?.mbt?.visitId || "");
  const compatibleTruck = truck => state.truckIds.has(String(truck.id));
  const groups = load => [...new Set((load.stops || []).map(visitId).filter(Boolean))];
  const assigned = () => new Set(trucks.flatMap(t => t.loads || []).flatMap(groups));
  const linkedCollection = card => card?.workflow?.linkedCollection && !["completed","cancelled"].includes(card.workflow.linkedCollection.status)
    ? card.workflow.linkedCollection : null;

  function linkedRouteCards(card) {
    const predecessor=linkedCollection(card);
    const collection=predecessor ? state.cards.get(predecessor.visitId) : card;
    const deliveryId=collection?.workflow?.linkedDeliveryVisitId || collection?.transport?.linkedDeliveryVisitId;
    return deliveryId ? [collection,state.cards.get(deliveryId)].filter(Boolean) : [card];
  }

  function orderForCard(card) {
    const collectionHold=card.workflow?.collectionHold;
    return { ...card, pallets: 0, weightLbs: card.transport?.weightLbs || 0, items: [], travelMinutes: 30,
      pickupLocations: pickupLocationsForCard(card),
      windowStart: card.transport?.windowStart ?? localTime(card.scheduledWindow?.startAt), windowEnd: card.transport?.windowEnd ?? localTime(card.scheduledWindow?.endAt),
      localDispatchStatus: card.mbt.status === "completed" ? "completed" : "open",
      dispatchCompletionStatus: card.mbt.status === "completed" ? "completed" : "",
      dispatchPlanningRestricted: ["completed","cancelled"].includes(card.mbt.status) || Boolean(linkedCollection(card)) || Boolean(collectionHold),
      dispatchPlanningRestrictionReason: collectionHold ? collectionHold.reason : linkedCollection(card) ? `Planned with ${linkedCollection(card).reference}` : "",
      planOwned: true, catalogHydrated: true };
  }
  function pickupLocationsForCard(card) {
    if (card.transport) {return [...new Set(card.stops.filter(stop=>stop.type==='pickup').map(stop=>stop.planningAddress))];}
    const locations=(card.workflow ? card.stops.filter(stop=>stop.type==="pickup") : card.stops)
      .map(stop=>(card.workflow && stop.planningAddress) || stop.yardCode || card.address).filter(Boolean);
    if (card.workflow?.source?.planned && card.workflow.source.address) {
      return [`${card.workflow.source.availabilityPredecessorId?'Planned return':'After dumping'}: ${card.workflow.source.address}`,...[...new Set(locations)].map(address=>`Material pickup: ${address}`)];
    }
    if (locations.length) {return [...new Set(locations)];}
    const source=card.workflow?.source;
    if (source?.address) {return [`${source.planned ? "After dumping: " : ""}${source.address}`];}
    return card.workflow?.configurationRequired ? ["Choose bin in workflow"] : [];
  }
  function adoptCards() {
    const binOrders = [...state.cards.values()].map(orderForCard);
    const binIds=new Set(binOrders.map(order=>order.id));
    orders = [...orders.filter(order => order.type !== "BIN" && !binIds.has(order.id)), ...binOrders]; orderCatalog = binOrders;
    mbtBinDispatchFeed = { planDate: currentPlanDate, items: [...state.cards.values()] };
  }
  function visualStop(stop, loadId, card, index) {
    return { ...stop, id: stop.id || `BIN-draft-${card.mbt.visitId}-${stop.sequence || index + 1}`,
      loadId, orderId: card.id, type: ["collect_empty_bin", "pickup_bin"].includes(stop.actionCode) || stop.actionCode?.startsWith('cargo_pickup_') ? "pick" : "drop",
      location: ((card.workflow || card.transport) && (stop.planningAddress || stop.location?.address)) || stop.yardCode || card.address,
      mbt: { ...stop.mbt, visitId: card.mbt.visitId, stopSequence: Number(stop.mbt?.stopSequence || stop.sequence || index + 1), mandatory: true } };
  }
  function decoratePlan() {
    adoptCards();
    for (const truck of trucks) {
      const active = fleet.find(item => normalizedTruckPlate(item.plate) === normalizedTruckPlate(truck.plate));
      if (active?.id && (truck.truckType === "bin" || !state.rawPlan?.trucks.some(item => String(item.id) === String(truck.id)))) {truck.id = String(active.id);}
      for (const load of truck.loads || []) {
        if (!isMbtPlanningLoad(load) && !(truck.truckType === "bin" && !load.stops?.length && !load.returnOnly)) {continue;}
        load.mbtPlanning = true;
        load.start ??= load.startTime || (load.plannedStartMinute !== null && load.plannedStartMinute !== undefined ? timeText(load.plannedStartMinute) : DEFAULT_FIRST_LOAD_START);
        load.stops = (load.stops || []).map((stop, index) => {
          const card = state.cards.get(visitId(stop)); return card ? visualStop(stop, load.id, card, index) : stop;
        });
        assignLoadFields(truck, load);
      }
    }
    renumberDriverLoads();
    if (!findLoad(selectedLoadId).load || (!loadPreviewOpen && !isMbtPlanningLoad(findLoad(selectedLoadId).load))) {selectedLoadId = trucks.flatMap(t => t.loads || []).find(isMbtPlanningLoad)?.id || "";}
  }
  function mergePlanningFleet(availableTrucks) {
    for (const available of availableTrucks) {
      const vehicle = { ...available, id: String(available.id), baseYard: available.base,
        binServiceEnabled: true };
      const plate = normalizedTruckPlate(vehicle.plate);
      const fleetIndex = fleet.findIndex(item => normalizedTruckPlate(item.plate) === plate);
      if (fleetIndex < 0) {fleet.push(vehicle);}
      else {fleet[fleetIndex] = { ...fleet[fleetIndex], ...vehicle };}
      const existing = trucks.find(item => normalizedTruckPlate(item.plate) === plate);
      if (existing) {
        Object.assign(existing, { id: vehicle.id, truckType: "bin", binServiceEnabled: true,
          binSlotCapacity: vehicle.binSlotCapacity, supportedBinTypeCodes: vehicle.supportedBinTypeCodes });
      } else {
        trucks.push(makeTruckFromFleet(vehicle, trucks.length, { id: vehicle.id, loads: [] }));
      }
    }
  }
  async function refreshFeed({ append = false, renderAfter = true, adopt = false } = {}) {
    if (state.loadingDate && !adopt) {return false;}
    const date = currentPlanDate, term = searchText.trim(); const sequence = ++state.request; mbtBinDispatchLoading = true;
    try {
      const params = new URLSearchParams({ planDate: date, search: term, limit: "100", offset: String(append ? state.nextOffset || 0 : 0) });
      const [data,transport]=await Promise.all(['/api/mbt/planning','/api/mbt/planning/transport'].map(async path=>{
        const response=await fetch(`${path}?${params}`,{headers:dispatchAuthHeaders()}),body=await response.json();
        if (!response.ok) {throw new Error(body.error || 'Planning orders could not be loaded.');}return body;
      }));
      data.pool.items.push(...transport.pool.items);data.assigned.push(...transport.assigned);
      data.linked=[...(data.linked || []),...(transport.linked || [])];
      data.pool.total+=transport.pool.total;
      const offsets=[data.pool.nextOffset,transport.pool.nextOffset].filter(value=>value!==null);
      data.pool.nextOffset=offsets.length?Math.min(...offsets):null;
      if (sequence !== state.request || date !== currentPlanDate || term !== searchText.trim()) {return false;}
      state.capacityWarnings=data.capacityWarnings || [];
      state.truckIds = new Set(data.trucks.map(truck => String(truck.id)));
      mergePlanningFleet(data.trucks);
      for (const card of [...data.pool.items, ...data.assigned, ...(data.linked || [])]) {
        if (card.workflow?.role) {state.cards.delete(card.workflow.orderId);}
        const prior = state.cards.get(card.mbt.visitId);
        if (!prior || card.mbt.visitRevision >= prior.mbt.visitRevision) {state.cards.set(card.mbt.visitId, card);}
      }
      state.pool = append ? [...new Set([...state.pool, ...data.pool.items.map(card => card.mbt.visitId)])] : data.pool.items.map(card => card.mbt.visitId);
      state.search = term; state.total = data.pool.total; state.nextOffset = data.pool.nextOffset;
      if (adopt && data.plan && !localPlanDirty) { applySavedPlan(data.plan); currentPlan = compactCurrentPlan(data.plan); }
      else {decoratePlan();}
      state.ready = true; mbtBinDispatchError = ""; return true;
    } catch (error) {
      if (sequence === state.request) {mbtBinDispatchError = error.message;}
      if (adopt) {throw error;} return false;
    } finally {
      if (sequence === state.request) { mbtBinDispatchLoading = false; if (renderAfter) {render({ save: false });} }
    }
  }
  function poolCards() {
    const term=searchText.trim();
    if (state.search!==term) return [];
    const placed = assigned();
    const ids = new Set([...state.pool, ...[...state.cards.values()].filter(card => card.loadId && !term).map(card => card.mbt.visitId)]);
    return [...ids].map(id => state.cards.get(id)).filter(card => card
      && (term || (!placed.has(card.mbt.visitId) && (!card.dispatchPlanned || card.dispatchPlanDate===currentPlanDate)
        && !["completed", "cancelled"].includes(card.mbt.status)))
      && (term || (card.serviceAction==="return_bin" ? "collection" : card.serviceAction) === state.filter));
  }
  function capacityWarningsForLoad(load) {
    const visits=new Set((load.stops || []).map(visitId));
    return state.capacityWarnings.filter(warning=>String(warning.loadId)===String(load.id)
      && (!load.truckId || String(warning.truckId)===String(load.truckId)) && visits.has(warning.visitId));
  }
  function orderList() {
    const cards = poolCards().map(card => renderOrderCard(orderForCard(card))).join("");
    const setup = !mbtBinDispatchLoading && !mbtBinDispatchError && !state.truckIds.size
      ? '<p class="empty-drop">No BIN trucks are configured. Register a truck as Bin with its base yard and supported sizes in <a href="/dispatch/setup">Dispatch Setup</a>.</p>' : "";
    return `${setup}${cards || `<div class="empty-drop">${mbtBinDispatchLoading ? "Loading BIN orders…" : mbtBinDispatchError ? escapeHtml(mbtBinDispatchError) : "No available BIN orders match the filter."}</div>`}
      ${state.nextOffset !== null ? '<button class="order-pool-load-more" data-action="bin-load-more" type="button">Load more</button>' : ""}`;
  }
  function cardActions(order) {
    if (order.type !== "BIN") {return "";}
    const card = state.cards.get(order.mbt.visitId);
    const codes=(card.mbt.assetRequirements || []).map(asset=>asset.exactAssetCode).filter(Boolean);
    return `${codes.length ? `<span>Bin ${escapeHtml(codes.join(", "))}</span>` : ""}
      ${card.workflow?.configurationRequired ? '<span>Route setup required</span>' : ""}
      ${card.transport ? `<p class="bin-workflow-note">${escapeHtml(card.displayReference)}${card.transport.allocations.map(line=>` · ${escapeHtml(line.quantity)} ${escapeHtml(line.unit)} ${escapeHtml(line.description)}`).join('')}</p>
        ${card.transport.sourceOnly?`<p class="bin-workflow-note">${card.transport.lines.map(line=>`${escapeHtml(line.description)}: ${escapeHtml(line.remaining)} remaining · ${escapeHtml(line.planned)} planned · ${escapeHtml(line.delivered)} delivered`).join('<br>')}</p>`:''}`:''}
      ${linkedCollection(card) ? `<p class="bin-workflow-note">Planned automatically with ${escapeHtml(linkedCollection(card).reference)}</p>` : ""}
      ${card.workflow?.role ? `<p class="bin-workflow-note">${escapeHtml(card.workflow.reference)} · ${escapeHtml(card.workflow.role)}
        ${card.workflow.dependencies.map(d=>` · after ${escapeHtml(d.display_reference)} (${escapeHtml(d.status)})`).join("")}</p>` : ""}
      ${card.workflow?.pendingCollections.length ? `<p class="bin-workflow-note">Pending: ${card.workflow.pendingCollections.map(p=>`${escapeHtml(p.asset_code)} · ${escapeHtml(p.display_reference)}`).join("; ")}</p>` : ""}
      ${card.blockedReason ? `<span class="chip warn" ${card.workflow?.collectionHold?'data-bin-collection-waiting':''}>${escapeHtml(card.blockedReason)}</span>` : ""}`;
  }
  function selectedActions() {
    const order = selectedOrder(); if (order?.type !== "BIN") {return "";}
    if (order.transport) {return `<div class="selected-order-actions"><span>${escapeHtml(order.displayReference)}</span>
      <button data-action="bin-transport" data-visit="${escapeHtml(order.mbt.visitId)}" type="button">Plan transport</button></div>`;}
    const editable=!["completed","cancelled","in_progress","evidence_pending"].includes(order.mbt.status);
    const setup=editable && order.workflow;
    const change=editable && !order.workflow?.configurationRequired && order.workflow?.role!=="collection"
      && (order.mbt.assetRequirements || []).length;
    const choices=editable && !order.workflow ? mbtEligibleAssetChoice(order) : [];
    const selected=mbtSelectedEligibleAsset(order);
    return `<div class="selected-order-actions"><span>${escapeHtml(order.displayReference || order.id)}</span>
      ${setup ? `<button data-action="bin-workflow" data-visit="${escapeHtml(order.mbt.visitId)}" type="button" ${isDispatchPlanEditor() ? "" : "disabled"}>Plan ${escapeHtml(order.workflow.kind)}</button>` : ""}
      ${choices.length ? `<label>Bin<select data-bin-asset="${escapeHtml(order.mbt.visitId)}" aria-label="Bin for ${escapeHtml(order.id)}"><option value="">Choose bin</option>${choices.map(asset=>`<option value="${escapeHtml(asset.assetId)}" ${selected?.assetId===asset.assetId ? "selected" : ""}>${escapeHtml(asset.assetCode)}</option>`).join("")}</select></label>` : ""}
      ${change ? changeBinButton(order.mbt.visitId) : ""}
      <button data-action="bin-details" data-visit="${escapeHtml(order.mbt.visitId)}" type="button">Details</button></div>`;
  }
  function changeBinButton(id) {
    return `<button data-action="bin-selection" data-visit="${escapeHtml(id)}" type="button" ${isDispatchPlanEditor() ? "" : "disabled"}>Change bin</button>`;
  }
  async function withPlanLeases(plans,save) {
    const acquired=[],fences=[];
    try {
      for (const plan of plans) {
        if (plan.planDate===currentPlanDate) {
          fences.push({...plan,sessionId:dispatchSessionId,editLeaseToken:planEditLeaseToken});continue;
        }
        const sessionId=crypto.randomUUID();
        const response=await fetch("/api/dispatch/plan-edit-lease/acquire",{method:"POST",
          headers:{...dispatchAuthHeaders(),"Content-Type":"application/json"},body:JSON.stringify({planDate:plan.planDate,sessionId})});
        const result=await response.json();if (!response.ok) throw new Error(result.error || `Cannot edit the affected plan on ${plan.planDate}.`);
        const fence={...plan,sessionId,editLeaseToken:result.editLeaseToken};acquired.push(fence);fences.push(fence);
      }
      await save(fences);
    } finally {
      await Promise.allSettled(acquired.map(fence=>fetch("/api/dispatch/plan-edit-lease/release",{method:"POST",
        headers:{...dispatchAuthHeaders(),"Content-Type":"application/json"},body:JSON.stringify(fence)})));
    }
  }
  async function changeBin(id) {
    if (!ensureDispatchPlanEditor()) return;
    await saveCurrentPlanNow();
    if (localPlanDirty) throw new Error("Wait for the current plan changes to save before selecting another bin.");
    await window.BinOrderWorkflowUI.selectBin(id,{headers:dispatchAuthHeaders,withPlanLeases,onSaved:async()=>{
      mbtBinAssetSelectionByVisit.delete(id);await refreshFeed({adopt:true});
      routeNotice="Assigned bin updated. Released driver instructions have been refreshed.";render({save:false});
    }});
  }
  function physicalVisits(load, rows) {
    const visits=[];
    for (const [index,stop] of (load.stops || []).entries()) {
      const order=stopOrder(stop);if (!order) continue;
      const address=stopAddress(stop,order),addressKey=address.trim().replace(/\s+/g,' ').toLowerCase();
      const previous=visits.at(-1),entry={stop,order,index,row:rows[index] || null};
      const transport=Boolean(stop.mbt?.transportTripId);
      if (addressKey && previous?.addressKey===addressKey && (transport || previous.transport)) {
        previous.entries.push(entry);previous.transport=true;
      } else {visits.push({type:stop.type,address,addressKey,transport,entries:[entry]});}
    }
    return visits;
  }
  function stopPlace(stop, order) {
    const place = stop.yardCode ? placeForLocation(stop.yardCode) : null;
    const address = stop.reference ? stop.planningAddress || place?.address || String(stop.location || "") || order?.address
      : place?.address || order?.address || String(stop.location || "");
    const position = placePosition(place) || fallbackPositionForAddress(address, order);
    return { kind: place?.kind || "delivery", key: stop.yardCode || address, label: stop.displayName || address,
      address, routeLocation: address || position, lat: position.lat, lng: position.lng };
  }
  function payload(savedAt, draftOnly) {
    if (!state.ready && !draftOnly) {throw new Error("Wait for the BIN orders and shared schedule to finish loading.");}
    return { planId: currentPlan?.id || null, planDate: currentPlanDate, baseRevision: currentPlan?.revision ?? 0,
      baseDigest: currentPlan?.digest || "", editLeaseToken: planEditLeaseToken, savedAt: savedAt.toISOString(),
      mutationAction: pendingPlanMutationAction, orders: structuredClone(orders),
      trucks: draftOnly ? structuredClone(trucks) : trucksWithTimingMetadata(), summary: { driverLaneOrder },
      binVisitRevisions: Object.fromEntries([...state.cards].map(([id, card]) => [id, card.mbt.visitRevision])) };
  }
  function historyFingerprint(snapshot) {
    // A save changes generation/stop IDs and visit revisions, not user intent.
    // Those acknowledgements must not become undo points or erase redo.
    const loads = snapshot.trucks.flatMap(truck => (truck.loads || []).filter(isMbtPlanningLoad).map(load => ({
      id: load.id, truck: load.truckId || truck.id, driver: load.driverLogin, sequence: load.driverSequence,
      startMode: load.startMode, start: load.start, switchYard: load.switchYard, parkingSpot: load.parkingSpot,
      allowTolls: Boolean(load.allowTolls), returnOnly: Boolean(load.returnOnly), returnYard: load.returnYard,
      endingTrip: Boolean(load.endingTrip), stops: load.stops.map(stop => ({ visitId: visitId(stop),
        sequence: stop.mbt?.stopSequence, override: normalizedStopTimeOverride(stop) })) })));
    return compactStringFingerprint(JSON.stringify({ loads, driverLaneOrder: snapshot.driverLaneOrder }));
  }
  async function saveRequest(candidate, attempt) {
    const loads = candidate.trucks.flatMap(truck => (truck.loads || []).filter(isMbtPlanningLoad).map(load => ({
      ...load, truckId: String(load.truckId || truck.id), driverId: String(driverByKey(load.driverLogin)?.id || load.driverId || ""),
      truckStartYard: String(truck.base || ""),
      plannedFinishMinute: !load.stops.length && !load.returnOnly ? null : load.plannedFinishMinute,
      visits: groups(load).map(id => ({ visitId: id, expectedVisitRevision: Number(candidate.binVisitRevisions[id]),
        assetAssignments: mbtAssetAssignmentsForCard(state.cards.get(id)),
        stopTimings: load.stops.filter(stop => visitId(stop) === id && stop.timing)
          .map(stop => ({ sequence: Number(stop.mbt.stopSequence), arrival: stop.timing.arrival, depart: stop.timing.depart })),
        stopOverrides: load.stops.filter(stop => visitId(stop) === id && normalizedStopTimeOverride(stop) !== null)
          .map(stop => ({ sequence: Number(stop.mbt.stopSequence), minutes: normalizedStopTimeOverride(stop) })) }))
    })));
    // Intent only: display-only stop identities never enter a Dispatch snapshot write.
    const intents = loads.map(({ id, name, truckId, driverId, startMode, start, driverSequence, switchYard, parkingSpot,
      allowTolls, returnOnly, manual, endingTrip, returnYard, plannedStartMinute, plannedFinishMinute, visits,
      routeEstimate, handoffTravelMinutes, handoffTravelFrom, handoffTravelTo, truckStartYard }) =>
      ({ id, name, truckId, driverId, startMode, start, driverSequence, switchYard, parkingSpot, allowTolls,
        returnOnly, manual, endingTrip, returnYard, plannedStartMinute, plannedFinishMinute, visits,
        routeEstimate, handoffTravelMinutes, handoffTravelFrom, handoffTravelTo, truckStartYard }));
    const response = await dispatchFrozenSaveFetch("/api/mbt/planning/commands", {
      method: "POST", headers: { ...dispatchAuthHeaders(), "Content-Type": "application/json",
        "Idempotency-Key": `bin-board:${dispatchSessionId}:${candidate.baseRevision}:${attempt.payloadHash}` }, body: JSON.stringify({
        action: "save_board", planId: candidate.planId, planDate: candidate.planDate,
        baseRevision: candidate.baseRevision, baseDigest: candidate.baseDigest, sessionId: dispatchSessionId,
        editLeaseToken: candidate.editLeaseToken, idempotencyKey: `bin-board:${dispatchSessionId}:${candidate.baseRevision}:${attempt.payloadHash}`,
        reason: "BIN planner updated the shared daily schedule", loads: intents, driverLaneOrder: candidate.summary.driverLaneOrder })
    }, attempt);
    if (!response.ok) {return response;}
    const result = await response.json();
    for (const [id, revision] of Object.entries(result.visitRevisions || {})) {
      const card = state.cards.get(id); if (card) {card.mbt.visitRevision = revision;}
    }
    if (currentPlanDate === candidate.planDate && attempt.saveGeneration === localPlanGeneration) {applySavedPlan(result.plan);}
    return new Response(JSON.stringify(result.plan), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  async function acknowledgeSave(latest, generation, date) {
    if (!latest || localPlanDirty || generation !== localPlanGeneration || date !== currentPlanDate) {return;}
    try {
      const { journal, key } = await dispatchDraftStorage(date);
      if (localPlanDirty || pendingPlanSaveAttempt || pendingDispatchPlanAction || generation !== localPlanGeneration) {return;}
      clearTimeout(dispatchDraftJournalTimer);
      await journal.remove(key);
      dispatchRecoveredDraft = null;
    } catch (error) {dispatchDraftBackupError = `Local draft cleanup is unavailable: ${error.message}`;}
  }
  function addVisit(orderId, loadId, _type, _location, insertIndex = null) {
    const order = orderById(orderId); const card = state.cards.get(order?.mbt?.visitId); const found = findLoad(loadId);
    if (!card || !found.load || !isMbtPlanningLoad(found.load) || !compatibleTruck(found.truck) || !loadHasAssignedDriver(found.truck, found.load)) {
      routeNotice = "Choose a BIN truck and driver for this load."; return false;
    }
    if (!mbtBinFrontLegDraggable(card) || assigned().has(card.mbt.visitId)) {
      routeNotice = card.blockedReason || "Choose an available bin before assigning this visit."; return false;
    }
    if (linkedCollection(card)) {
      routeNotice = `Plan ${linkedCollection(card).reference}; its linked delivery is included automatically.`; return false;
    }
    const route=linkedRouteCards(card);
    if ((card.workflow?.linkedDeliveryVisitId && route.length!==2) || route.some(member=>!mbtBinFrontLegDraggable(member)
      || ["completed","cancelled"].includes(member.mbt.status)
      || assigned().has(member.mbt.visitId) || (member.dispatchPlanned && member.dispatchPlanDate!==currentPlanDate))) {
      routeNotice = "The linked delivery is unavailable or already planned. Refresh the linked route."; return false;
    }
    const steps = route.flatMap(member=>member.stops.map((stop,index)=>visualStop(stop,loadId,member,index)));
    const targetId = visitId(found.load.stops[insertIndex]);
    const at = targetId ? found.load.stops.findIndex(stop => visitId(stop) === targetId) : found.load.stops.length;
    found.load.stops.splice(at, 0, ...steps); selectedOrderId = order.id; selectedOrderIds = new Set([order.id]); selectedLoadId = loadId;
    clearActiveRouteEstimates(); return true;
  }
  function drop(event) {
    if (dragged?.type !== "stop") {return false;}
    const source = findStop(dragged.stopId); if (!source?.stop?.mbt) {return false;}
    event.preventDefault(); if (!ensureDispatchPlanEditor()) {return true;}
    if (event.target.closest('[data-dispatch-order-pool]')) { removeVisit(source); dragged = null; return true; }
    const list = event.target.closest('.stop-list, .preview-stop-list'); const target = list ? findLoad(list.dataset.load).load : null;
    if (!target || !isMbtPlanningLoad(target) || loadHasDriverActivity(source.load) || loadHasDriverActivity(target)) { dragged = null; return true; }
    const targetCard = event.target.closest('[data-stop]'); const targetStop = targetCard ? findStop(targetCard.dataset.stop)?.stop : null;
    const id = visitId(source.stop); const beforeId = visitId(targetStop);
    const routeIds=new Set(linkedRouteCards(state.cards.get(id)).map(card=>card.mbt.visitId));
    if (routeIds.has(beforeId)) { dragged = null; return true; }
    const moved = source.load.stops.filter(stop => routeIds.has(visitId(stop))).map(stop => ({ ...stop, loadId: target.id }));
    source.load.stops = source.load.stops.filter(stop => !routeIds.has(visitId(stop)));
    let at = beforeId ? target.stops.findIndex(stop => visitId(stop) === beforeId) : target.stops.length;
    if (targetCard && event.clientY > targetCard.getBoundingClientRect().top + targetCard.getBoundingClientRect().height * .66) {
      while (at < target.stops.length && visitId(target.stops[at]) === beforeId) {at++;}
    }
    target.stops.splice(at, 0, ...moved); dragged = null; clearActiveRouteEstimates(); commitPlanMutation("bin_visit_moved"); return true;
  }
  function removeVisit(found) {
    if (!ensureDispatchPlanEditor() || loadHasDriverActivity(found.load)) {return;}
    const routeIds=new Set(linkedRouteCards(state.cards.get(visitId(found.stop))).map(card=>card.mbt.visitId));
    found.load.stops = found.load.stops.filter(stop => !routeIds.has(visitId(stop)));
    clearActiveRouteEstimates(); commitPlanMutation("bin_visit_unplanned");
  }
  async function details(id) {
    if (state.cards.get(id)?.transport) {return planTransport(id);}
    const response = await fetch(`/api/mbt/planning/visits/${encodeURIComponent(id)}`, { headers: dispatchAuthHeaders() }); const data = await response.json();
    if (!response.ok) {throw new Error(data.error || "Visit details unavailable.");}
    const dialog = document.createElement("dialog"); dialog.className = "bin-visit-details"; dialog.setAttribute("aria-label", `BIN visit ${data.visit.id}`);
    dialog.innerHTML = `<header><h2>${escapeHtml(data.visit.id)}</h2><button type="button">Close</button></header><p>${escapeHtml(data.visit.customer)} · ${escapeHtml(data.visit.address)}</p>
      <h3>Required steps</h3><ol>${data.steps.map(step => `<li>${escapeHtml(step.display_name)} · ${escapeHtml(step.status)}</li>`).join("")}</ol>
      <h3>Assignment history</h3><ul>${data.history.map(item => `<li>${escapeHtml(item.action.replaceAll("_", " "))} · ${escapeHtml(displayDateTime(item.created_at))} · ${escapeHtml(item.reason)}</li>`).join("") || "<li>No assignments yet.</li>"}</ul>
      ${data.events.some(e=>e.action==="late_same_day_completion") ? '<p class="chip warn">Same-day replacement was completed late. The actual completion and evidence have been retained.</p>' : ""}
      <p>${data.evidence.length} evidence item(s) recorded.</p>
      ${data.visit.workflow ? '<button type="button" data-handoff>Record physical bin handoff</button>' : ""}`;
    const handoff=dialog.querySelector("[data-handoff]");
    if (handoff) {handoff.onclick=()=>window.BinOrderWorkflowUI.handoff(id,{headers:dispatchAuthHeaders,onSaved:async()=>{
      dialog.close();await refreshFeed();
    }}).catch(error=>{routeNotice=error.message;render({save:false});});}
    dialog.querySelector("button").onclick = () => dialog.close(); dialog.onclose = () => dialog.remove(); document.body.append(dialog); dialog.showModal();

  }
  async function planTransport(id) {
    const card=state.cards.get(id);
    await saveCurrentPlanNow();
    if (localPlanDirty) {throw new Error('Wait for the current plan to save before editing transport.');}
    return window.BinTransportUI.open(card.transport.sourceRef,{headers:dispatchAuthHeaders,planDate:currentPlanDate,
      canEdit:isDispatchPlanEditor(),onSaved:async()=>{await refreshFeed({adopt:true});routeNotice='Transport route saved. Drag the trip onto a load.';render({save:false});}},
    {tripId:card.transport.sourceOnly?null:card.mbt.visitId});
  }
  function install() {
    activeOrderType = "BIN"; mbtBinDispatchEnabled = true;
    const rawAssignments=applyPlannedAssignments;
    applyPlannedAssignments=rows=>{rawAssignments(rows);adoptCards();};
    const rawJump=jumpToPlannedOrder;
    jumpToPlannedOrder=async id=>{
      if (orderById(id)?.type!=="BIN") return rawJump(id);
      if (localPlanDirty || saveQueued || saveInFlight) await saveCurrentPlanNow();
      if (localPlanDirty) throw new Error("Save the current plan before opening another date.");
      const path=orderById(id).transport?'transport/trips':'visits';
      const response=await fetch(`/api/mbt/planning/${path}/${encodeURIComponent(orderById(id).mbt.visitId)}`,{headers:dispatchAuthHeaders()});
      const data=await response.json();if(!response.ok) throw new Error(data.error || "The BIN order could not be refreshed.");
      state.cards.set(data.visit.mbt.visitId,data.visit);adoptCards();
      return rawJump(id);
    };
    const rawLoadDate = loadPlanForDate; const rawApply = applySavedPlan; const rawConfig = loadDispatchConfig;
    loadDispatchConfig = async () => { await rawConfig(); dispatchConfig.driverOrientedPlanning = true; };
    loadPlanForDate = async (date, options) => {
      const navigation = ++state.navigation; ++state.request;
      state.loadingDate = true;
      state.ready = false; state.rawPlan = null; state.cards.clear(); state.pool = []; state.nextOffset = null;state.capacityWarnings=[];
      let adoptingSearch;
      try {
        const result = await rawLoadDate(date, options);
        if (navigation !== state.navigation || result.stale) {return { ...result, stale: true };}
        adoptingSearch = searchText;
        await refreshFeed({ adopt: true, renderAfter: false });
        if (navigation !== state.navigation) {return { ...result, stale: true };}
        resetUndoHistory(); resetLocalPlanDirty(); return result;
      } finally {
        if (navigation === state.navigation) {
          state.loadingDate = false;
          if (adoptingSearch !== undefined && adoptingSearch !== searchText && state.ready) {void refreshFeed();}
        }
      }
    };
    applySavedPlan = saved => { state.rawPlan = structuredClone(saved); if (saved.binCapacityWarnings) {state.capacityWarnings=saved.binCapacityWarnings;}
      const result = rawApply(saved); decoratePlan(); return result; };
    // Service templates already define complete routes. SO/PO pickup inference
    // and automatic return synthesis must not rewrite their required steps.
    syncPickupStops = () => {}; reconcilePickupStopRepresentatives = () => {}; syncReturnLoads = () => {};
    const rawStopOrder = stopOrder; stopOrder = stop => stop?.mbt ? orderById(state.cards.get(visitId(stop))?.id || stop.orderId) : rawStopOrder(stop);
    const rawRequired = requiredPickupLocations; requiredPickupLocations = order => order?.type === "BIN" ? [] : rawRequired(order);
    const rawPickupOrders = pickupOrdersForStop; pickupOrdersForStop = (load, stop) => stop?.mbt ? [stopOrder(stop)].filter(Boolean) : rawPickupOrders(load, stop);
    const rawCanSplit = canSplitPickupVisit; canSplitPickupVisit = (load, stop) => stop?.mbt ? false : rawCanSplit(load, stop);
    const rawDefault = defaultTruckForDriver; defaultTruckForDriver = login => { const truck = rawDefault(login); return truck && compatibleTruck(truck) ? truck : null; };
    const newBinLoad = create => (truck, index, assignedDriver) => {
      const driver = assignedDriver || truckDriver(truck); const sequence = nextDriverSequence(driverKey(driver));
      const load = create(truck, index, driver); load.mbtPlanning = true;
      assignLoadFields(truck, load, { driver, sequence }); return load;
    };
    addLoadToTruck = newBinLoad(addLoadToTruck); addReturnLoadToTruck = newBinLoad(addReturnLoadToTruck);
    addOrderToLoad = addVisit; loadDispatchOrders = refreshFeed; loadMbtBinFrontLegs = refreshFeed;
    historySnapshotFingerprint = historyFingerprint;
    const rawBadge = planBadgeText;
    planBadgeText = () => {
      const badge = rawBadge();
      const pending = trucks.some(truck => truck.loads.some(load => (load.mbtPlanning && load.returnOnly && load.mbtReturnReleased !== true)
        || load.stops.some(stop => stop.mbt?.driverReleased === false)));
      return state.ready && ["DRAFT", "CONFIRMED"].includes(badge) && pending ? "BIN CHANGES TO CONFIRM" : badge;
    };
    const rawEstimate = applyServerRouteEstimate;
    applyServerRouteEstimate = (truck, load, stops, response) => {
      const estimate = rawEstimate(truck, load, stops, response);
      if (estimate && isDispatchPlanEditor() && isMbtPlanningLoad(load) && !loadHasDriverActivity(load)) {
        markLocalPlanDirty(); autoSavePlan();
      }
      return estimate;
    };
    openOrders = () => poolCards().map(orderForCard);
    optimizeSelectedRoute = () => {
      const { load } = selectedLoad(); if (!load || isPlanningLoadReadOnly(load) || loadHasDriverActivity(load)) {return;}
      const visits = groups(load).sort((a, b) => String(state.cards.get(a)?.scheduledWindow?.startAt || "9999")
        .localeCompare(String(state.cards.get(b)?.scheduledWindow?.startAt || "9999")));
      const route=[...new Set(visits.flatMap(id=>linkedRouteCards(state.cards.get(id)).map(card=>card?.mbt.visitId || id)))];
      load.stops = route.flatMap(id => load.stops.filter(stop => visitId(stop) === id));
    };
    const rawEditor = isDispatchPlanEditor; isDispatchPlanEditor = () => state.ready && rawEditor();
    app.addEventListener("dragover", event => { if (dragged?.type === "stop" && event.target.closest('[data-dispatch-order-pool]')) {event.preventDefault();} });
    app.addEventListener("change", event => { const id = event.target.dataset.binAsset; if (id) { mbtBinAssetSelectionByVisit.set(id, event.target.value); renderDispatchOrderPoolPatch(); } });
    app.addEventListener("dblclick", event => {
      const order = orderById(event.target.closest('[data-order]')?.dataset.order);
      if (order?.type !== "BIN") {return;}
      event.preventDefault(); event.stopImmediatePropagation(); clearTimeout(orderClickTimer);
      details(order.mbt.visitId).catch(error => { routeNotice = error.message; render({ save: false }); });
    }, true);
    app.addEventListener("click", event => {
      const button = event.target.closest('[data-action]'); const action = button?.dataset.action;
      if (action === "remove-stop" && findStop(button.dataset.stop)?.stop?.mbt) {
        event.preventDefault(); event.stopImmediatePropagation(); removeVisit(findStop(button.dataset.stop)); return;
      }
      if (!action?.startsWith("bin-")) {return;}
      event.preventDefault(); event.stopImmediatePropagation();
      if (action === "bin-filter") { state.filter = button.dataset.filter; renderDispatchOrderPoolPatch(); }
      if (action === "bin-load-more") {void refreshFeed({ append: true });}
      if (action === "bin-details") {details(button.dataset.visit).catch(error => { routeNotice = error.message; render({ save: false }); });}
      if (action === 'bin-transport') {planTransport(button.dataset.visit).catch(error=>{routeNotice=error.message;render({save:false});});}
      if (action === "bin-selection") {changeBin(button.dataset.visit).catch(error=>{routeNotice=error.message;render({save:false});});}
      if (action === "bin-workflow") {
        if (!ensureDispatchPlanEditor()) return;
        (async()=>{
          await saveCurrentPlanNow();
          if (localPlanDirty) throw new Error('Wait for the current plan to save before editing this route.');
          await window.BinOrderWorkflowUI.open(button.dataset.visit,{headers:dispatchAuthHeaders,withPlanLeases,onSaved:async()=>{
            await refreshFeed({adopt:true});routeNotice="BIN route saved.";render({save:false});
          }});
        })().catch(error=>{routeNotice=error.message;render({save:false});});
      }
    }, true);
  }
  globalThis.MbbsBinPlanning = { install, compatibleTruck, payload, saveRequest, acknowledgeSave, orderList, cardActions, selectedActions, physicalVisits, stopPlace, drop,
    capacityWarningsForLoad,
    navigation: () => state.navigation,
    stopWindow: (stop, order) => stop.yardCode ? { start: "", end: "" } : { start: order.windowStart, end: order.windowEnd },
    poolSubtitle: () => mbtBinDispatchLoading ? "Loading BIN orders…" : mbtBinDispatchError || `${state.total} ${searchText.trim() ? "matching visits · all plan dates" : "available visits · shared daily driver schedule"}`,
    tabs: () => filters.map(([key, label]) => `<button class="${state.filter === key ? "active" : ""}" data-action="bin-filter" data-filter="${key}" type="button">${label}</button>`).join("") };
})();

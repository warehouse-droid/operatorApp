function smartProposalStops(proposal) {
  const stops = Array.isArray(proposal.routeStops) && proposal.routeStops.length
    ? proposal.routeStops
    : proposal.lines.reduce((list, line) => {
      const locationId = Number(line.destinationLocationId || proposal.destinationLocationId);
      if (!list.some((stop) => Number(stop.locationId) === locationId)) {
        list.push({ locationId, name: line.destinationName || proposal.destinationName });
      }
      return list;
    }, []);
  return stops;
}

function smartProposalRoute(proposal) {
  const source = proposal.sourceName || proposal.vendor || "Vendor";
  const destinations = smartProposalStops(proposal).map((stop) => stop.name).filter(Boolean);
  return [source, ...(destinations.length ? destinations : [proposal.destinationName])].filter(Boolean).join(" → ");
}

function smartProposalEditable(proposal) {
  const hasReference = proposal.netsuitePurchaseOrderId || proposal.netsuitePurchaseOrderRef
    || proposal.netsuiteTransferOrderId || proposal.netsuiteTransferOrderRef;
  return smartCanWrite() && !hasReference && ["draft", "held", "reviewed", "attention"].includes(proposal.status);
}

const smartProposalYards = [
  { locationId: 1, name: "3445" },
  { locationId: 28, name: "2967" },
  { locationId: 15, name: "12441" },
  { locationId: 26, name: "150" }
];

function smartProposalYardOptions(selectedLocationId) {
  return smartProposalYards.map((yard) => `<option value="${yard.locationId}" ${Number(selectedLocationId) === yard.locationId ? "selected" : ""}>${yard.name}</option>`).join("");
}

function smartProposalInventory(proposal, line) {
  const reason = line.reason || {};
  const toPlt = Number(line.toPlt || 0);
  const current = Number(reason.destinationAvailablePallets ?? reason.availablePallets ?? 0);
  if (proposal.proposalType === "TO") {
    const source = Number(reason.sourceAvailablePallets ?? 0);
    return `<div class="smart-inventory-context"><span>Source available: <strong>${smartNumber(source, 2)} PLT</strong></span><span>${smartEscape(line.destinationName || proposal.destinationName)} available: <strong>${smartNumber(current, 2)} PLT</strong></span></div>`;
  }
  const pallets = (value) => toPlt > 0 ? Number(value || 0) / toPlt : 0;
  const available = pallets(reason.quantityAvailable);
  const onOrder = pallets(reason.quantityOnOrder);
  const backordered = pallets(reason.quantityBackordered);
  const reservedOutbound = pallets(reason.quantityReservedOutbound);
  const calculatedPosition = available + onOrder - backordered - reservedOutbound;
  const storedPosition = Number(reason.positionPallets ?? reason.destinationExpectedAvailablePallets);
  const position = Number.isFinite(storedPosition) ? storedPosition : calculatedPosition;
  const reorderPoint = Number(reason.reorderPointPallets);
  const preferred = Number(reason.preferredPallets);
  const recommended = Number(line.requiredPallets ?? line.proposedPallets ?? 0);
  const proposed = Number(line.proposedPallets || 0);
  const afterProposal = position + proposed;
  const planningYard = reason.actualDestinationYard || line.destinationName || proposal.destinationName;
  const hasPolicyDecision = Number.isFinite(reorderPoint) && Number.isFinite(preferred);
  const targetGap = hasPolicyDecision ? Math.max(0, preferred - position) : 0;
  const minimumOrder = Number(reason.minimumOrderPallets || 0);
  const capacity = Number(reason.capacityPallets);
  const matchesTargetGap = Math.abs(targetGap - recommended) < 0.000001;
  const exactOrderRule = hasPolicyDecision && position < reorderPoint && matchesTargetGap;
  const decision = hasPolicyDecision
    ? position < reorderPoint
      ? matchesTargetGap
        ? `${smartNumber(position, 2)} &lt; ROP ${smartNumber(reorderPoint, 2)} → ${smartNumber(preferred, 2)} − ${smartNumber(position, 2)} = <strong>${smartNumber(recommended, 2)} PLT recommended</strong>`
        : `${smartNumber(position, 2)} &lt; ROP ${smartNumber(reorderPoint, 2)} → policy gap ${smartNumber(targetGap, 2)} PLT → <strong>this load carries ${smartNumber(recommended, 2)} PLT</strong>`
      : `${smartNumber(position, 2)} ≥ ROP ${smartNumber(reorderPoint, 2)} → <strong>no automatic replenishment trigger</strong>`
    : "Policy trigger and target are unavailable for this manually added line.";
  const orderRule = exactOrderRule
    ? `Order rule: ceil(max(${smartNumber(targetGap, 2)} target gap, ${smartNumber(minimumOrder, 2)} minimum order))${Number.isFinite(capacity) ? ` within ${smartNumber(capacity, 2)}-PLT capacity` : ""} = ${smartNumber(recommended, 2)} PLT`
    : `Policy target gap: ${smartNumber(targetGap, 2)} PLT · minimum order: ${smartNumber(minimumOrder, 2)} PLT${Number.isFinite(capacity) ? ` · capacity: ${smartNumber(capacity, 2)} PLT` : ""} · this load allocation: ${smartNumber(recommended, 2)} PLT`;
  return `<div class="smart-inventory-context smart-replenishment-calculation">
    <span><strong>${smartEscape(planningYard)}</strong></span>
    <span>Available now: <strong>${smartNumber(current, 2)} PLT</strong></span>
    <span>Projected position before recommendation: <strong>${smartNumber(position, 2)} PLT</strong></span>
    <small>${smartNumber(available, 2)} available + ${smartNumber(onOrder, 2)} on order − ${smartNumber(backordered, 2)} backorder − ${smartNumber(reservedOutbound, 2)} reserved = ${smartNumber(position, 2)} PLT</small>
    ${hasPolicyDecision ? `<span>Reorder trigger: <strong>${smartNumber(reorderPoint, 2)} PLT</strong></span><span>Preferred target: <strong>${smartNumber(preferred, 2)} PLT</strong></span>` : ""}
    <span class="smart-replenishment-equation">${decision}</span>
    ${hasPolicyDecision ? `<small>${orderRule}</small>` : ""}
    <span>After current ${smartNumber(proposed, 2)}-PLT proposal: <strong>${smartNumber(afterProposal, 2)} PLT</strong></span>
  </div>`;
}

function smartProposalDecisionEvidence(line) {
  const reason = line.reason || {};
  const evidence = [
    ["Weekly demand", reason.weeklyDemandPallets, " PLT/week", 2],
    ["Demand SD", reason.weeklyDemandSdPallets, " PLT/week", 3],
    ["Safety stock", reason.safetyStockPallets, " PLT", 3],
    ["Minimum order", reason.minimumOrderPallets, " PLT", 2],
    ["Weeks of cover", reason.weeksOfCover, "", 2]
  ].filter(([, value]) => Number.isFinite(Number(value)));
  const labels = evidence.map(([label, value, suffix, places]) => `<span>${smartEscape(label)}: ${smartNumber(value, places)}${suffix}</span>`);
  if (reason.forecastModel) labels.push(`<span>Forecast: ${smartEscape(reason.forecastModel)}</span>`);
  if (reason.vendorSupplyStatus) labels.push(`<span>Vendor supply: ${smartEscape(reason.vendorSupplyStatus)}</span>`);
  if (reason.vendorConfirmationRequired) labels.push("<span>Vendor confirmation required</span>");
  if (reason.importedVendorAvailablePallets !== null && reason.importedVendorAvailablePallets !== undefined
    && Number.isFinite(Number(reason.importedVendorAvailablePallets))) {
    labels.push(`<span>Imported vendor available: ${smartNumber(reason.importedVendorAvailablePallets, 2)} PLT</span>`);
  }
  if (reason.zeroDemandCoverageApplied) labels.push(`<span>Coverage floor: ${smartNumber(reason.coverageFloorPallets, 2)} PLT · ${smartEscape(reason.coverageSource || "unknown")}</span>`);
  if (reason.urgent) labels.push("<span>Urgent</span>");
  if (reason.provisional) labels.push("<span>Provisional</span>");
  return `<div class="smart-reason">${labels.join("")}</div>`;
}

smartFilteredProposals = function smartFilteredProposalsV2() {
  const search = smartState.planSearch.trim().toLowerCase();
  const proposals = (smartState.plan?.proposals || []).filter((proposal) => {
    if (smartState.planType && proposal.proposalType !== smartState.planType) return false;
    if (smartState.planStatus && proposal.status !== smartState.planStatus) return false;
    if (smartState.planSource && (proposal.sourceName || proposal.vendor || "") !== smartState.planSource) return false;
    if (smartState.planDestination && !smartProposalStops(proposal).some((stop) => stop.name === smartState.planDestination)) return false;
    if (!search) return true;
    return [smartProposalRoute(proposal), proposal.vendor, proposal.plant, proposal.memo,
      ...proposal.lines.flatMap((line) => [line.itemId, line.itemName, line.itemDescription, line.destinationName])]
      .some((value) => String(value || "").toLowerCase().includes(search));
  });
  const primary = smartState.planSort === "source"
    ? (proposal) => proposal.sourceName || proposal.vendor || ""
    : (proposal) => smartProposalStops(proposal).map((stop) => stop.name).join("|");
  const secondary = smartState.planSort === "source"
    ? (proposal) => smartProposalStops(proposal).map((stop) => stop.name).join("|")
    : (proposal) => proposal.sourceName || proposal.vendor || "";
  return proposals.sort((left, right) => primary(left).localeCompare(primary(right), undefined, { numeric: true })
    || secondary(left).localeCompare(secondary(right), undefined, { numeric: true }) || left.id - right.id);
};

function smartProposalLineRow(proposal, line, editable) {
  return `<tr data-smart-proposal-line="${line.id}">
    <td><strong>${smartEscape(line.itemName)}</strong><div class="smart-help">ID ${line.itemId} · ${smartEscape(line.itemDescription || line.unit || "")}</div><div class="smart-line-flags">${line.urgent ? smartPill("attention", "Urgent") : ""}${line.provisional ? smartPill("held", "Provisional") : ""}${line.reason?.gormleyHubRedirected ? smartPill("held", `Gormley hub for ${smartEscape((line.reason.gormleyOriginalDestinations || [line.reason.actualDestinationYard]).filter(Boolean).join(", "))}`) : ""}${Number(line.reason?.groupingDeferredPallets) > 0 ? smartPill("held", `${smartNumber(line.reason.groupingDeferredPallets, 0)} PLT deferred`) : ""}${line.manualPlanningRequired ? smartPill("attention", "Missing conversion / weight") : ""}</div></td>
    <td>${editable && proposal.proposalType === "PO" ? `<select class="smart-line-destination-select" data-smart-proposal-destination aria-label="Line destination yard">${smartProposalYardOptions(line.destinationLocationId || proposal.destinationLocationId)}</select>` : `<strong>${smartEscape(line.destinationName || proposal.destinationName)}</strong>`}</td>
    <td class="numeric">${smartNumber(line.requiredPallets, 2)} PLT</td>
    <td>${editable ? `<div class="smart-line-quantity"><input data-smart-proposal-pallets type="number" min="1" step="1" value="${smartEscape(Math.max(1, Math.round(line.proposedPallets)))}" /><span>PLT</span><button class="smart-button" data-smart-action="save-proposal-line" data-proposal-id="${proposal.id}" data-line-id="${line.id}" type="button">Save</button><button class="smart-button danger" data-smart-action="remove-proposal-line" data-proposal-id="${proposal.id}" data-line-id="${line.id}" type="button">Remove</button></div>` : `<strong>${smartNumber(line.proposedPallets, 0)} PLT</strong>`}</td>
    <td class="numeric">${smartNumber(line.salesQuantity, 3)} ${smartEscape(line.unit || "UOM")}</td>
    <td class="numeric">${smartNumber(line.lineWeightLbs, 0)} lb</td>
    <td>${smartProposalInventory(proposal, line)}</td>
    <td>${smartCoverageEvidence(line)}${smartProposalDecisionEvidence(line)}</td>
  </tr>`;
}

function smartProposalLineEditor(proposal) {
  if (!smartProposalEditable(proposal)) return "";
  return `<div class="smart-proposal-line-editor" data-smart-line-editor="${proposal.id}">
    <strong>Add order line</strong>
    ${proposal.proposalType === "PO" ? `<select data-smart-line-destination aria-label="Destination yard">${smartProposalYardOptions(proposal.destinationLocationId)}</select>` : `<span class="smart-help">Destination ${smartEscape(proposal.destinationName)}</span>`}
    <input data-smart-line-search="${proposal.id}" type="search" placeholder="Search item ID, name, or description" autocomplete="off" />
    <div class="smart-proposal-item-results" data-smart-line-results="${proposal.id}"><span class="smart-help">Enter an item to add.</span></div>
  </div>`;
}

smartProposalCard = function smartProposalCardV2(proposal) {
  const isPo = proposal.proposalType === "PO";
  const executionRef = isPo ? proposal.netsuitePurchaseOrderRef : proposal.netsuiteTransferOrderRef;
  const hasExecutionReference = Boolean(isPo
    ? (proposal.netsuitePurchaseOrderId || proposal.netsuitePurchaseOrderRef)
    : (proposal.netsuiteTransferOrderId || proposal.netsuiteTransferOrderRef));
  const locked = hasExecutionReference || ["confirmed", "executing", "completed", "superseded", "cancelled"].includes(proposal.status);
  const editable = smartProposalEditable(proposal);
  const canConfirm = !hasExecutionReference && !isPo && ["draft", "reviewed"].includes(proposal.status);
  let actions = "";
  if (smartCanWrite() && isPo && proposal.status === "held") {
    actions = `<button class="smart-button primary" data-smart-action="proposal-status" data-proposal-id="${proposal.id}" data-status="order_requested" type="button">Order Requested</button><button class="smart-button danger" data-smart-action="proposal-status" data-proposal-id="${proposal.id}" data-status="cancelled" type="button">Cancel</button>`;
  } else if (smartCanWrite() && isPo && proposal.status === "order_requested") {
    actions = `<button class="smart-button" data-smart-action="open-vendor-load" data-proposal-id="${proposal.id}" type="button">Vendor reply</button><button class="smart-button warn" data-smart-action="proposal-status" data-proposal-id="${proposal.id}" data-status="held" type="button">Return to Hold</button><button class="smart-button danger" data-smart-action="proposal-status" data-proposal-id="${proposal.id}" data-status="cancelled" type="button">Cancel</button>`;
  } else if (isPo && ["vendor_replied", "attention", "failed", "completed"].includes(proposal.status)) {
    actions = `<button class="smart-button" data-smart-action="open-vendor-load" data-proposal-id="${proposal.id}" type="button">View vendor load</button>`;
  } else if (smartCanWrite() && !isPo && !locked) {
    actions = `<button class="smart-button ${proposal.status === "held" ? "" : "warn"}" data-smart-action="proposal-status" data-proposal-id="${proposal.id}" data-status="${proposal.status === "held" ? "reviewed" : "held"}" type="button">${proposal.status === "held" ? "Release" : "Hold"}</button><button class="smart-button danger" data-smart-action="proposal-status" data-proposal-id="${proposal.id}" data-status="cancelled" type="button">Cancel</button>`;
  }
  const selected = smartState.selectedProposalIds.has(Number(proposal.id));
  const needsPoRecalculation = isPo && Number(proposal.utilization) > 1.000001;
  const recalculatePo = editable && isPo ? `<button class="smart-button blue" data-smart-action="recalculate-po" data-proposal-id="${proposal.id}" type="button">Re-Calculate PO</button>` : "";
  return `<article class="smart-proposal ${selected ? "selected" : ""}" data-smart-proposal="${proposal.id}">
    <div class="smart-proposal-head">
      <div>${editable ? `<label class="smart-proposal-select"><input data-smart-proposal-select="${proposal.id}" type="checkbox" ${selected ? "checked" : ""} /><span>Group</span></label>` : ""}<strong>${smartEscape(proposal.proposalType)}</strong><div>${smartPill(proposal.status)}${needsPoRecalculation ? smartPill("attention", "Needs Re-Calculate") : ""}</div></div>
      <div class="smart-proposal-route"><strong>${smartEscape(smartProposalRoute(proposal))}</strong><span>#${proposal.id} · ${smartEscape(proposal.phase.replaceAll("_", " "))}${proposal.manuallyGrouped ? " · manually grouped" : ""}</span></div>
      <div class="smart-proposal-metric"><strong>${smartNumber(proposal.totalPallets, 0)} PLT</strong><span>Pallets</span></div>
      <div class="smart-proposal-metric"><strong>${smartNumber(proposal.totalWeightLbs, 0)} lb</strong><span>${smartPercent(proposal.utilization, 0)} truck</span></div>
      <div class="smart-proposal-metric"><strong>${executionRef ? smartEscape(executionRef) : "—"}</strong><span>${isPo ? "PO load ref" : "TO / mock ref"}</span></div>
      <div class="smart-actions">${recalculatePo}${actions}${smartCanWrite() && canConfirm ? `<button class="smart-button primary" data-smart-action="confirm-transfer" data-proposal-id="${proposal.id}" type="button">Confirm TO + print</button>` : ""}${smartCanWrite() && !isPo && hasExecutionReference && proposal.status === "attention" ? `<button class="smart-button warn" data-smart-action="retry-picking-ticket" data-proposal-id="${proposal.id}" type="button">Retry picking ticket</button>` : ""}</div>
    </div>
    <div class="smart-proposal-lines smart-table-wrap"><table class="smart-table"><thead><tr><th>Item</th><th>Destination</th><th class="numeric">Required</th><th>Proposed</th><th class="numeric">Sales quantity</th><th class="numeric">Line weight</th><th>Inventory</th><th>Decision evidence</th></tr></thead><tbody>${proposal.lines.map((line) => smartProposalLineRow(proposal, line, editable)).join("")}</tbody></table></div>
    ${smartProposalLineEditor(proposal)}
  </article>`;
};

smartPlans = function smartPlansV2() {
  const plan = smartState.plan;
  const runs = smartState.data.planningRuns || [];
  const all = plan?.proposals || [];
  const proposals = smartFilteredProposals();
  const sources = [...new Set(all.map((proposal) => proposal.sourceName || proposal.vendor).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const destinations = [...new Set(all.flatMap((proposal) => smartProposalStops(proposal).map((stop) => stop.name)).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const selectedCount = smartState.selectedProposalIds.size;
  return `<section class="smart-section smart-plan-section">
    <div class="smart-plan-sticky">
    <div class="smart-section-head"><div><h2>PO / TO proposal review</h2><p>Group creates one capacity-limited truck. For PO quantity increases, edit whole pallets first, then Re-Calculate PO to preserve the quantity and split it into capacity-safe loads with no more than two drops.</p></div><div class="smart-actions">${smartCanWrite() ? `<button class="smart-button" data-smart-action="group-proposals" type="button" ${selectedCount < 2 ? "disabled" : ""}>Group selected (${selectedCount})</button><button class="smart-button primary" data-smart-action="run-plan" type="button">Build new plan</button>` : ""}</div></div>
    <div class="smart-toolbar smart-plan-toolbar">
      <select id="smartPlanRun"><option value="">Select a run</option>${runs.map((run) => `<option value="${run.id}" ${Number(plan?.id) === Number(run.id) ? "selected" : ""}>#${run.id} · ${smartDate(run.completedAt, true)} · r${run.revision}</option>`).join("")}</select>
      <input id="smartPlanSearch" type="search" value="${smartEscape(smartState.planSearch)}" placeholder="Item, vendor, yard, or memo" />
      <select id="smartPlanType"><option value="">PO + TO</option><option value="PO" ${smartState.planType === "PO" ? "selected" : ""}>PO only</option><option value="TO" ${smartState.planType === "TO" ? "selected" : ""}>TO only</option></select>
      <select id="smartPlanStatus"><option value="">All statuses</option>${["draft", "held", "order_requested", "vendor_replied", "reviewed", "attention", "executing", "completed", "failed", "superseded", "cancelled"].map((status) => `<option value="${status}" ${smartState.planStatus === status ? "selected" : ""}>${status.replaceAll("_", " ")}</option>`).join("")}</select>
      <select id="smartPlanSource"><option value="">All source yards / vendors</option>${sources.map((source) => `<option value="${smartEscape(source)}" ${smartState.planSource === source ? "selected" : ""}>${smartEscape(source)}</option>`).join("")}</select>
      <select id="smartPlanDestination"><option value="">All destination yards</option>${destinations.map((yard) => `<option value="${smartEscape(yard)}" ${smartState.planDestination === yard ? "selected" : ""}>${smartEscape(yard)}</option>`).join("")}</select>
      <select id="smartPlanSort"><option value="destination" ${smartState.planSort === "destination" ? "selected" : ""}>Sort: destination yard</option><option value="source" ${smartState.planSort === "source" ? "selected" : ""}>Sort: source yard / vendor</option></select>
      <button class="smart-button" data-smart-action="filter-plan" type="button">Apply</button><span class="smart-help">${proposals.length} proposal(s)</span>
    </div>
    </div>
    ${plan ? `<div class="smart-proposals">${proposals.map(smartProposalCard).join("") || `<div class="smart-empty">No proposal matches this filter.</div>`}</div>` : `<div class="smart-empty">No planning run exists. Configure Item Master, upload sales history, then build a plan; live NetSuite inventory is refreshed automatically.</div>`}
  </section>`;
};

function smartProposalItemResults(proposalId, items = []) {
  if (!items.length) return `<div class="smart-empty smart-empty-compact">No compatible planning item matches.</div>`;
  return items.map((item) => `<div class="smart-proposal-item-result" data-smart-proposal-item="${item.itemId}"><div><strong>${smartEscape(item.itemName)}</strong><div class="smart-help">ID ${item.itemId} · ${smartEscape(item.vendor || item.itemDescription || item.unit || "")} · ${smartNumber(item.palletWeightLbs, 0)} lb / PLT</div></div><label><span>PLT</span><input data-smart-add-pallets type="number" min="1" step="1" value="1" /></label><button class="smart-button primary" data-smart-action="add-proposal-line" data-proposal-id="${proposalId}" data-item-id="${item.itemId}" type="button">Add</button></div>`).join("");
}

async function smartSearchProposalItems(proposalId, search) {
  const editor = document.querySelector(`[data-smart-line-editor="${proposalId}"]`);
  const destination = editor?.querySelector("[data-smart-line-destination]")?.value || "";
  const params = new URLSearchParams({ search, destinationLocationId: destination, limit: "12" });
  const target = editor?.querySelector(`[data-smart-line-results="${proposalId}"]`);
  if (target) target.innerHTML = `<span class="smart-help">Finding compatible items…</span>`;
  try {
    const items = await smartApi(`/api/scm/smart/proposals/${proposalId}/items?${params}`);
    const current = document.querySelector(`[data-smart-line-results="${proposalId}"]`);
    if (current) current.innerHTML = smartProposalItemResults(proposalId, items);
  } catch (error) {
    const current = document.querySelector(`[data-smart-line-results="${proposalId}"]`);
    if (current) current.innerHTML = `<div class="smart-notice error">${smartEscape(error.message)}</div>`;
  }
}

smartScmApp.addEventListener("change", (event) => {
  if (event.target.dataset.smartProposalSelect) {
    const proposalId = Number(event.target.dataset.smartProposalSelect);
    if (event.target.checked) smartState.selectedProposalIds.add(proposalId);
    else smartState.selectedProposalIds.delete(proposalId);
    event.target.closest("[data-smart-proposal]")?.classList.toggle("selected", event.target.checked);
    const groupButton = document.querySelector('[data-smart-action="group-proposals"]');
    if (groupButton) {
      const count = smartState.selectedProposalIds.size;
      groupButton.disabled = count < 2;
      groupButton.textContent = `Group selected (${count})`;
    }
    return;
  }
  if (event.target.matches("[data-smart-line-destination]")) {
    const editor = event.target.closest("[data-smart-line-editor]");
    const search = editor?.querySelector("[data-smart-line-search]")?.value || "";
    if (search) smartSearchProposalItems(editor.dataset.smartLineEditor, search);
  }
});

smartScmApp.addEventListener("input", (event) => {
  const proposalId = event.target.dataset.smartLineSearch;
  if (!proposalId) return;
  clearTimeout(smartProposalSearchTimers.get(proposalId));
  smartProposalSearchTimers.set(proposalId, setTimeout(() => smartSearchProposalItems(proposalId, event.target.value), 300));
});

smartScmApp.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-smart-action]");
  if (!button || smartState.busy) return;
  const action = button.dataset.smartAction;
  if (action === "filter-plan") {
    smartState.planSource = document.getElementById("smartPlanSource")?.value || "";
    smartState.planDestination = document.getElementById("smartPlanDestination")?.value || "";
    smartState.planSort = document.getElementById("smartPlanSort")?.value || "destination";
    smartRender();
    return;
  }
  if (!["group-proposals", "recalculate-po", "save-proposal-line", "remove-proposal-line", "add-proposal-line"].includes(action)) return;
  try {
    if (action === "group-proposals") {
      const proposalIds = [...smartState.selectedProposalIds];
      if (proposalIds.length < 2) throw new Error("Select at least two compatible loads.");
      if (!confirm(`Group ${proposalIds.length} selected loads into one truck? Quantities above capacity will be reduced proportionally to whole pallets and shown as deferred.`)) return;
      smartState.plan = await smartWork("Grouping selected loads", () => smartApi("/api/scm/smart/proposals/group", { method: "POST", body: { proposalIds } }), "Loads grouped and capacity reallocated");
      smartState.selectedProposalIds.clear();
      smartRender();
    } else if (action === "recalculate-po") {
      if (!confirm("Re-Calculate this PO into whole-pallet loads? The edited purchase quantity will be preserved, and the original proposal will be replaced by one or more loads with at most two drops.")) return;
      smartState.plan = await smartWork("Recalculating PO loads", () => smartApi(`/api/scm/smart/proposals/${button.dataset.proposalId}/recalculate-po`, { method: "POST", body: {} }), "PO quantities split into capacity-safe loads");
      smartState.selectedProposalIds.delete(Number(button.dataset.proposalId));
      smartRender();
    } else if (action === "save-proposal-line") {
      const row = button.closest("[data-smart-proposal-line]");
      const proposedPallets = Number(row?.querySelector("[data-smart-proposal-pallets]")?.value || 0);
      const destinationLocationId = Number(row?.querySelector("[data-smart-proposal-destination]")?.value || 0) || undefined;
      await smartWork("Updating proposal line", () => smartApi(`/api/scm/smart/proposals/${button.dataset.proposalId}/lines/${button.dataset.lineId}`, { method: "PATCH", body: { proposedPallets, destinationLocationId } }), "Proposal line updated");
      smartState.plan = await smartApi(`/api/scm/smart/planning-runs/${smartState.plan.id}`);
      smartRender();
    } else if (action === "remove-proposal-line") {
      if (!confirm("Remove this item line from the proposed load?")) return;
      await smartWork("Removing proposal line", () => smartApi(`/api/scm/smart/proposals/${button.dataset.proposalId}/lines/${button.dataset.lineId}`, { method: "DELETE" }), "Proposal line removed");
      smartState.plan = await smartApi(`/api/scm/smart/planning-runs/${smartState.plan.id}`);
      smartState.selectedProposalIds.delete(Number(button.dataset.proposalId));
      smartRender();
    } else if (action === "add-proposal-line") {
      const result = button.closest("[data-smart-proposal-item]");
      const editor = button.closest("[data-smart-line-editor]");
      const proposedPallets = Number(result?.querySelector("[data-smart-add-pallets]")?.value || 0);
      const destinationLocationId = Number(editor?.querySelector("[data-smart-line-destination]")?.value || 0);
      await smartWork("Adding proposal line", () => smartApi(`/api/scm/smart/proposals/${button.dataset.proposalId}/lines`, { method: "POST", body: { itemId: Number(button.dataset.itemId), proposedPallets, destinationLocationId } }), "Proposal line added");
      smartState.plan = await smartApi(`/api/scm/smart/planning-runs/${smartState.plan.id}`);
      smartRender();
    }
  } catch (error) {
    smartState.busy = "";
    smartState.error = error.message;
    smartRender();
  }
});

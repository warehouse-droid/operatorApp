const SMART_PROPOSAL_COLUMN_PREFERENCES_KEY = "mbbs.smartScm.proposalColumns.v1";

function smartLoadProposalColumnPreferences() {
  const defaults = { inventory: true, decisionEvidence: true };
  try {
    const saved = globalThis.localStorage?.getItem(SMART_PROPOSAL_COLUMN_PREFERENCES_KEY);
    if (!saved) return defaults;
    const parsed = JSON.parse(saved);
    return {
      inventory: typeof parsed?.inventory === "boolean" ? parsed.inventory : defaults.inventory,
      decisionEvidence: typeof parsed?.decisionEvidence === "boolean" ? parsed.decisionEvidence : defaults.decisionEvidence
    };
  } catch {
    return defaults;
  }
}

function smartSaveProposalColumnPreferences() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    storage.setItem(SMART_PROPOSAL_COLUMN_PREFERENCES_KEY, JSON.stringify({
      inventory: smartState.planShowInventory,
      decisionEvidence: smartState.planShowDecisionEvidence
    }));
    return true;
  } catch {
    // A full or unavailable browser store must never block an in-session view change.
    return false;
  }
}

const smartInitialProposalColumns = smartLoadProposalColumnPreferences();
if (typeof smartState.planShowInventory !== "boolean") smartState.planShowInventory = smartInitialProposalColumns.inventory;
if (typeof smartState.planShowDecisionEvidence !== "boolean") smartState.planShowDecisionEvidence = smartInitialProposalColumns.decisionEvidence;

function smartReasonNumber(reason, key) {
  const value = reason?.[key];
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function smartOptionalNumber(value, places = 1) {
  return value === null || value === undefined ? "—" : smartNumber(value, places);
}

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

function smartProposalDestinationCalculation(proposal, line, movementLabel = "proposal") {
  const reason = line.reason || {};
  const toPlt = Number(line.toPlt || 0);
  const pallets = (value) => {
    if (toPlt <= 0 || value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed / toPlt : null;
  };
  const available = pallets(reason.quantityAvailable);
  const onOrder = pallets(reason.quantityOnOrder);
  const backordered = pallets(reason.quantityBackordered);
  const reservedOutbound = pallets(reason.quantityReservedOutbound);
  const hasPositionBreakdown = [available, onOrder, backordered, reservedOutbound].every((value) => value !== null);
  const calculatedPosition = hasPositionBreakdown ? available + onOrder - backordered - reservedOutbound : null;
  const storedPosition = smartReasonNumber(reason, "positionPallets");
  const legacyPosition = smartReasonNumber(reason, "destinationExpectedAvailablePallets");
  const position = reason.manuallyAdjusted && calculatedPosition !== null
    ? calculatedPosition
    : storedPosition ?? calculatedPosition ?? legacyPosition;
  const current = smartReasonNumber(reason, "destinationAvailablePallets")
    ?? smartReasonNumber(reason, "availablePallets")
    ?? (available !== null && reservedOutbound !== null ? Math.max(0, available - reservedOutbound) : available);
  const destinationPolicyInvalid = Boolean(reason.destinationManuallyAdjusted);
  const reorderPoint = destinationPolicyInvalid ? null : smartReasonNumber(reason, "reorderPointPallets");
  const preferred = destinationPolicyInvalid ? null : smartReasonNumber(reason, "preferredPallets");
  const storedRequired = smartReasonNumber(line, "requiredPallets") ?? smartReasonNumber(line, "proposedPallets") ?? 0;
  const proposed = smartReasonNumber(line, "proposedPallets") ?? 0;
  const afterProposal = position === null ? null : position + proposed;
  const planningYard = reason.actualDestinationYard || line.destinationName || proposal.destinationName;
  const hasPolicyDecision = position !== null && reorderPoint !== null && preferred !== null;
  const targetGap = hasPolicyDecision ? Math.max(0, preferred - position) : 0;
  const minimumOrder = smartReasonNumber(reason, "minimumOrderPallets") ?? 0;
  const capacity = smartReasonNumber(reason, "capacityPallets");
  const uncappedRequest = Math.ceil(Math.max(targetGap, minimumOrder));
  const capacityAllowance = capacity === null || position === null ? null : Math.floor(Math.max(0, capacity - position) + 0.000001);
  const capacityBelowMinimum = capacityAllowance !== null && capacityAllowance + 0.000001 < minimumOrder;
  const calculatedRequired = hasPolicyDecision && position < reorderPoint && !capacityBelowMinimum
    ? Math.max(0, capacityAllowance === null ? uncappedRequest : Math.min(uncappedRequest, capacityAllowance))
    : 0;
  const matchesOrderRule = Math.abs(calculatedRequired - storedRequired) < 0.000001;
  const exactOrderRule = hasPolicyDecision && position < reorderPoint && matchesOrderRule
    && !reason.manuallyAdded && !reason.manuallyAdjusted && !proposal.manuallyGrouped;
  const allocationDiffersFromPolicy = hasPolicyDecision && Math.abs(proposed - calculatedRequired) > 0.000001;
  const storedRequirementDiffers = hasPolicyDecision && Math.abs(storedRequired - calculatedRequired) > 0.000001;
  const decision = hasPolicyDecision
    ? position < reorderPoint
      ? exactOrderRule
        ? `${smartNumber(position, 2)} &lt; ROP ${smartNumber(reorderPoint, 2)} → target gap ${smartNumber(targetGap, 2)} PLT → <strong>${smartNumber(calculatedRequired, 2)} PLT destination policy need</strong>`
        : `${smartNumber(position, 2)} &lt; ROP ${smartNumber(reorderPoint, 2)} → saved snapshot rule calculates <strong>${smartNumber(calculatedRequired, 2)} PLT destination policy need</strong>`
      : `${smartNumber(position, 2)} ≥ ROP ${smartNumber(reorderPoint, 2)} → <strong>no automatic replenishment trigger</strong>`
    : destinationPolicyInvalid
      ? "Destination changed after planning; build a new plan to calculate this yard's policy need."
      : "Policy trigger and target were not captured for this manual or legacy line.";
  const orderRule = hasPolicyDecision && position < reorderPoint
    ? capacityAllowance === null
      ? `Saved rule: ceil(max(${smartNumber(targetGap, 2)} target gap, ${smartNumber(minimumOrder, 2)} minimum order)) = ${smartNumber(calculatedRequired, 2)} PLT`
      : `Saved rule: min(ceil(max(${smartNumber(targetGap, 2)} target gap, ${smartNumber(minimumOrder, 2)} minimum order)), floor(${smartNumber(capacity, 2)} capacity − ${smartNumber(position, 2)} position)) = ${smartNumber(calculatedRequired, 2)} PLT`
    : "";
  return `<div class="smart-calculation-block smart-destination-calculation">
    <span class="smart-calculation-title"><strong>${smartEscape(planningYard)} destination need</strong></span>
    <small>Saved inventory and policy snapshot.</small>
    <span>Available in snapshot: <strong>${smartOptionalNumber(current, 2)} PLT</strong></span>
    <span>Projected position before recommendation: <strong>${smartOptionalNumber(position, 2)} PLT</strong></span>
    ${hasPositionBreakdown ? `<small>${smartNumber(available, 2)} available + ${smartNumber(onOrder, 2)} on order − ${smartNumber(backordered, 2)} backorder − ${smartNumber(reservedOutbound, 2)} reserved = ${smartNumber(position, 2)} PLT</small>` : ""}
    ${hasPolicyDecision ? `<span>Reorder trigger: <strong>${smartNumber(reorderPoint, 2)} PLT</strong></span><span>Preferred target: <strong>${smartNumber(preferred, 2)} PLT</strong></span>` : ""}
    <span class="smart-replenishment-equation">${decision}</span>
    ${orderRule ? `<small>${orderRule}</small>` : ""}
    ${storedRequirementDiffers ? `<small>Stored line requirement ${smartNumber(storedRequired, 2)} PLT differs after editing/grouping; calculated snapshot need is ${smartNumber(calculatedRequired, 2)} PLT.</small>` : ""}
    ${allocationDiffersFromPolicy ? proposed < calculatedRequired
      ? `<span>This ${smartEscape(movementLabel)} carries: <strong>${smartNumber(proposed, 2)} of ${smartNumber(calculatedRequired, 2)} PLT calculated policy need</strong></span>`
      : `<span>This ${smartEscape(movementLabel)} allocates: <strong>${smartNumber(proposed, 2)} PLT versus ${smartNumber(calculatedRequired, 2)} PLT calculated policy need</strong></span>` : ""}
    <span>After current ${smartNumber(proposed, 2)}-PLT ${smartEscape(movementLabel)}: <strong>${smartOptionalNumber(afterProposal, 2)} PLT</strong></span>
  </div>`;
}

function smartProposalSourceCalculation(proposal, line) {
  const reason = line.reason || {};
  const proposed = smartReasonNumber(line, "proposedPallets") ?? 0;
  const sourceAvailable = smartReasonNumber(reason, "sourceAvailablePallets");
  const sourceSafety = smartReasonNumber(reason, "sourceSafetyStockPallets");
  const sourceRop = smartReasonNumber(reason, "sourceReorderPointPallets");
  const storedProtectedFloor = smartReasonNumber(reason, "sourceProtectedFloorPallets");
  const calculatedProtectedFloor = sourceSafety !== null && sourceRop !== null ? Math.max(sourceSafety, sourceRop) : null;
  const storedMaximum = smartReasonNumber(reason, "sourceMaximumTransferablePallets");
  const calculatedMaximum = sourceAvailable !== null && calculatedProtectedFloor !== null
    ? Math.floor(Math.max(0, sourceAvailable - calculatedProtectedFloor) + 0.000001)
    : null;
  const maximumTransferable = calculatedMaximum ?? storedMaximum;
  const sourceAfterLine = sourceAvailable === null ? null : sourceAvailable - proposed;
  const hasSourceFormula = sourceAvailable !== null && sourceSafety !== null && sourceRop !== null
    && calculatedProtectedFloor !== null && calculatedMaximum !== null;
  const sourceSnapshotMismatch = (storedProtectedFloor !== null && calculatedProtectedFloor !== null
    && Math.abs(storedProtectedFloor - calculatedProtectedFloor) > 0.000001)
    || (storedMaximum !== null && calculatedMaximum !== null && Math.abs(storedMaximum - calculatedMaximum) > 0.000001);
  const withinLimit = maximumTransferable === null ? null : proposed <= maximumTransferable + 0.000001;
  return `<div class="smart-calculation-block smart-source-calculation">
    <span class="smart-calculation-title"><strong>${smartEscape(proposal.sourceName || "Source yard")} source protection</strong></span>
    <small>Plan-time snapshot; confirmation rechecks live source inventory.</small>
    <span>Available after active reservations: <strong>${smartOptionalNumber(sourceAvailable, 2)} PLT</strong></span>
    ${hasSourceFormula ? `<span>Safety stock: <strong>${smartNumber(sourceSafety, 2)} PLT</strong> · ROP: <strong>${smartNumber(sourceRop, 2)} PLT</strong></span>
    <small>Protected floor = max(${smartNumber(sourceSafety, 2)} safety stock, ${smartNumber(sourceRop, 2)} ROP) = ${smartNumber(calculatedProtectedFloor, 2)} PLT</small>
    <small>Maximum transferable = floor(max(0, ${smartNumber(sourceAvailable, 2)} available − ${smartNumber(calculatedProtectedFloor, 2)} protected)) = ${smartNumber(calculatedMaximum, 2)} PLT</small>`
      : maximumTransferable !== null ? `<small>Captured source transfer limit: ${smartNumber(maximumTransferable, 2)} PLT; formula inputs are unavailable.</small>` : ""}
    ${sourceSnapshotMismatch ? `<span class="smart-replenishment-equation"><strong>Saved source-limit fields are inconsistent; refresh and replan before confirmation.</strong></span>` : ""}
    ${withinLimit === null
      ? `<span class="smart-replenishment-equation">Source safety/ROP calculation was not captured for this manual or legacy line.</span>`
      : `<span class="smart-replenishment-equation">${smartNumber(proposed, 2)} PLT transfer ≤ ${smartNumber(maximumTransferable, 2)} PLT ${hasSourceFormula ? "calculated" : "captured"} limit → <strong>${withinLimit ? "within source limit" : "exceeds source limit; refresh and replan"}</strong></span>`}
    <span>Source after this TO line: <strong>${smartOptionalNumber(sourceAfterLine, 2)} PLT</strong></span>
  </div>`;
}

function smartProposalInventory(proposal, line) {
  const destination = smartProposalDestinationCalculation(proposal, line, proposal.proposalType === "TO" ? "TO line" : "proposal");
  return `<div class="smart-inventory-context smart-replenishment-calculation">${proposal.proposalType === "TO" ? smartProposalSourceCalculation(proposal, line) : ""}${destination}</div>`;
}

function smartProposalDecisionEvidence(line) {
  const reason = line.reason || {};
  const destinationPolicyInvalid = Boolean(reason.destinationManuallyAdjusted);
  const evidence = [
    ["Weekly demand", destinationPolicyInvalid ? null : reason.weeklyDemandPallets, " PLT/week", 2],
    ["Demand SD", destinationPolicyInvalid ? null : reason.weeklyDemandSdPallets, " PLT/week", 3],
    ["Safety stock", destinationPolicyInvalid ? null : reason.safetyStockPallets, " PLT", 3],
    ["Minimum order", destinationPolicyInvalid ? null : reason.minimumOrderPallets, " PLT", 2],
    ["Weeks of cover", destinationPolicyInvalid ? null : reason.weeksOfCover, "", 2],
    ["Source safety stock", reason.sourceSafetyStockPallets, " PLT", 3],
    ["Source ROP", reason.sourceReorderPointPallets, " PLT", 2],
    ["Source protected floor", reason.sourceProtectedFloorPallets, " PLT", 2],
    ["Source transfer limit", reason.sourceMaximumTransferablePallets, " PLT", 2]
  ].filter(([, value]) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)));
  const labels = evidence.map(([label, value, suffix, places]) => `<span>${smartEscape(label)}: ${smartNumber(value, places)}${suffix}</span>`);
  if (destinationPolicyInvalid) labels.unshift("<span>Destination changed · rebuild plan for yard policy evidence</span>");
  if (reason.forecastModel && !destinationPolicyInvalid) labels.push(`<span>Forecast: ${smartEscape(reason.forecastModel)}</span>`);
  if (reason.vendorSupplyStatus) labels.push(`<span>Vendor supply: ${smartEscape(reason.vendorSupplyStatus)}</span>`);
  if (reason.vendorConfirmationRequired) labels.push("<span>Vendor confirmation required</span>");
  if (reason.importedVendorAvailablePallets !== null && reason.importedVendorAvailablePallets !== undefined
    && Number.isFinite(Number(reason.importedVendorAvailablePallets))) {
    labels.push(`<span>Imported vendor available: ${smartNumber(reason.importedVendorAvailablePallets, 2)} PLT</span>`);
  }
  if (reason.zeroDemandCoverageApplied && !destinationPolicyInvalid) labels.push(`<span>Coverage floor: ${smartNumber(reason.coverageFloorPallets, 2)} PLT · ${smartEscape(reason.coverageSource || "unknown")}</span>`);
  if (reason.urgent) labels.push("<span>Urgent</span>");
  if (reason.provisional) labels.push("<span>Provisional</span>");
  return `<div class="smart-reason">${labels.join("")}</div>`;
}

function smartProposalColumnControls() {
  return `<fieldset class="smart-proposal-column-controls">
    <legend>Show columns</legend>
    <label><input data-smart-plan-detail="inventory" type="checkbox" ${smartState.planShowInventory ? "checked" : ""} /><span>Inventory</span></label>
    <label><input data-smart-plan-detail="decision-evidence" type="checkbox" ${smartState.planShowDecisionEvidence ? "checked" : ""} /><span>Decision evidence</span></label>
  </fieldset>`;
}

function smartProposalDetailClassName() {
  const hiddenCount = Number(!smartState.planShowInventory) + Number(!smartState.planShowDecisionEvidence);
  if (hiddenCount === 2) return " smart-proposal-lines-compact";
  if (hiddenCount === 1) return " smart-proposal-lines-one-detail-hidden";
  return "";
}

function smartApplyProposalColumnVisibility(root = document) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  const visibility = {
    inventory: smartState.planShowInventory,
    "decision-evidence": smartState.planShowDecisionEvidence
  };
  Object.entries(visibility).forEach(([column, visible]) => {
    root.querySelectorAll(`[data-smart-plan-column="${column}"]`).forEach((cell) => { cell.hidden = !visible; });
  });
  root.querySelectorAll(".smart-proposal-lines").forEach((wrapper) => {
    wrapper.classList.toggle("smart-proposal-lines-one-detail-hidden", Number(!smartState.planShowInventory) + Number(!smartState.planShowDecisionEvidence) === 1);
    wrapper.classList.toggle("smart-proposal-lines-compact", !smartState.planShowInventory && !smartState.planShowDecisionEvidence);
  });
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
  const inventoryHidden = smartState.planShowInventory ? "" : " hidden";
  const evidenceHidden = smartState.planShowDecisionEvidence ? "" : " hidden";
  return `<tr data-smart-proposal-line="${line.id}">
    <td><strong>${smartEscape(line.itemName)}</strong><div class="smart-help">ID ${line.itemId} · ${smartEscape(line.itemDescription || line.unit || "")}</div><div class="smart-line-flags">${line.urgent ? smartPill("attention", "Urgent") : ""}${line.provisional ? smartPill("held", "Provisional") : ""}${line.reason?.gormleyHubRedirected ? smartPill("held", `Gormley hub for ${smartEscape((line.reason.gormleyOriginalDestinations || [line.reason.actualDestinationYard]).filter(Boolean).join(", "))}`) : ""}${Number(line.reason?.groupingDeferredPallets) > 0 ? smartPill("held", `${smartNumber(line.reason.groupingDeferredPallets, 0)} PLT deferred`) : ""}${line.manualPlanningRequired ? smartPill("attention", "Missing conversion / weight") : ""}</div></td>
    <td>${editable && proposal.proposalType === "PO" ? `<select class="smart-line-destination-select" data-smart-proposal-destination aria-label="Line destination yard">${smartProposalYardOptions(line.destinationLocationId || proposal.destinationLocationId)}</select>` : `<strong>${smartEscape(line.destinationName || proposal.destinationName)}</strong>`}</td>
    <td class="numeric">${smartNumber(line.requiredPallets, 2)} PLT</td>
    <td>${editable ? `<div class="smart-line-quantity"><input data-smart-proposal-pallets type="number" min="1" step="1" value="${smartEscape(Math.max(1, Math.round(line.proposedPallets)))}" /><span>PLT</span><button class="smart-button" data-smart-action="save-proposal-line" data-proposal-id="${proposal.id}" data-line-id="${line.id}" type="button">Save</button><button class="smart-button danger" data-smart-action="remove-proposal-line" data-proposal-id="${proposal.id}" data-line-id="${line.id}" type="button">Remove</button></div>` : `<strong>${smartNumber(line.proposedPallets, 0)} PLT</strong>`}</td>
    <td class="numeric">${smartNumber(line.salesQuantity, 3)} ${smartEscape(line.unit || "UOM")}</td>
    <td class="numeric">${smartNumber(line.lineWeightLbs, 0)} lb</td>
    <td data-smart-plan-column="inventory"${inventoryHidden}>${smartProposalInventory(proposal, line)}</td>
    <td data-smart-plan-column="decision-evidence"${evidenceHidden}>${smartCoverageEvidence(line)}${smartProposalDecisionEvidence(line)}</td>
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
    <div class="smart-proposal-lines smart-table-wrap${smartProposalDetailClassName()}"><table class="smart-table"><thead><tr><th>Item</th><th>Destination</th><th class="numeric">Required</th><th>Proposed</th><th class="numeric">Sales quantity</th><th class="numeric">Line weight</th><th data-smart-plan-column="inventory"${smartState.planShowInventory ? "" : " hidden"}>Inventory</th><th data-smart-plan-column="decision-evidence"${smartState.planShowDecisionEvidence ? "" : " hidden"}>Decision evidence</th></tr></thead><tbody>${proposal.lines.map((line) => smartProposalLineRow(proposal, line, editable)).join("")}</tbody></table></div>
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
    <div class="smart-section-head"><div><h2>PO / TO proposal review</h2><p>Group creates one capacity-limited truck. For PO quantity increases, edit whole pallets first, then Re-Calculate PO to preserve the quantity and split it into capacity-safe loads with no more than two drops.</p></div><div class="smart-actions smart-plan-header-actions">${smartProposalColumnControls()}${smartCanWrite() ? `<button class="smart-button" data-smart-action="group-proposals" type="button" ${selectedCount < 2 ? "disabled" : ""}>Group selected (${selectedCount})</button><button class="smart-button primary" data-smart-action="run-plan" type="button">Build new plan</button>` : ""}</div></div>
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
  const detailColumn = event.target.dataset.smartPlanDetail;
  if (detailColumn === "inventory" || detailColumn === "decision-evidence") {
    if (detailColumn === "inventory") smartState.planShowInventory = event.target.checked;
    else smartState.planShowDecisionEvidence = event.target.checked;
    smartSaveProposalColumnPreferences();
    smartApplyProposalColumnVisibility();
    return;
  }
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
